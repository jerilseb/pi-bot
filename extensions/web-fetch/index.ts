/**
 * Web Fetch Tool - Fetches pages using native fetch with Chrome impersonation.
 * HTML is converted to Markdown via Turndown; other text is returned as is.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import TurndownService from 'turndown';
import { errorMessage } from '../../src/util.ts';

const FetchParams = Type.Object({
  url: Type.String({ description: 'URL to fetch' }),
});

interface FetchDetails {
  url: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  truncated?: boolean;
  fullOutputPath?: string;
}

/**
 * Largest body read, after decompression; the rest is never downloaded. Turndown
 * runs on the main thread, so this also bounds how long a conversion can block
 * the bot: about 0.3 s for a 2 MB Wikipedia article.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Deadline for the whole request, body included. */
const FETCH_TIMEOUT_MS = 30_000;

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
/** Text worth returning as is: text/*, plus JSON, XML, JavaScript and YAML under application/. */
const TEXT_TYPE_RE =
  /^(?:text\/|application\/(?:[\w.-]+\+)?(?:json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|x-ndjson|x-sh|sql|graphql)$)/;

const CHROME_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

/**
 * Reads at most `maxBytes` of the body, cancelling the rest of the download.
 * Exported for tests.
 */
export async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      await reader.cancel().catch(() => {});
      return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated: true };
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated: false };
}

export default function (pi: ExtensionAPI) {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  pi.registerTool({
    name: 'web_fetch',
    label: 'Web Fetch',
    description: `Fetch content from a URL impersonating Chrome. HTML pages are converted to Markdown; other text (plain text, JSON, XML, source code) is returned as is, and binary content is not shown. Reads at most ${formatSize(MAX_BODY_BYTES)} of the response and gives up after ${FETCH_TIMEOUT_MS / 1000}s. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. If truncated, full output is saved to a temp file.`,
    parameters: FetchParams,

    async execute(_toolCallId, params, signal) {
      const { url } = params;
      const details: FetchDetails = { url };
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          headers: CHROME_HEADERS,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: 'follow',
        });

        details.status = response.status;
        details.statusText = response.statusText;
        details.contentType = response.headers.get('content-type') ?? 'text/html';
        const statusLines = `HTTP ${details.status} ${details.statusText}\nContent-Type: ${details.contentType}`;

        const mediaType = details.contentType.split(';')[0].trim().toLowerCase();
        const isHtml = HTML_TYPES.has(mediaType);
        if (!isHtml && !TEXT_TYPE_RE.test(mediaType)) {
          await response.body?.cancel().catch(() => {});
          const length = Number(response.headers.get('content-length'));
          const size = length > 0 ? ` (${formatSize(length)})` : '';
          return {
            content: [
              {
                type: 'text',
                text: `${statusLines}\n\n[Binary content${size} not shown. Download it with bash, for example curl -L -o <file> <url>, to inspect it.]`,
              },
            ],
            details,
            isError: response.status >= 400,
          };
        }

        const body = await readBody(response, MAX_BODY_BYTES);
        const output = isHtml ? turndown.turndown(body.text) : body.text;

        const truncation = truncateHead(output, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let resultText = `${statusLines}\n\n${truncation.content}`;

        if (body.truncated) {
          details.truncated = true;
          resultText += `\n\n[Response cut off: only the first ${formatSize(MAX_BODY_BYTES)} was read.]`;
        }

        if (truncation.truncated) {
          const tempDir = mkdtempSync(join(tmpdir(), 'pi-fetch-'));
          const tempFile = join(tempDir, isHtml ? 'response.md' : 'response.txt');
          writeFileSync(tempFile, output);
          details.truncated = true;
          details.fullOutputPath = tempFile;
          resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
        }

        return {
          content: [{ type: 'text', text: resultText }],
          details,
          isError: response.status >= 400,
        };
      } catch (error) {
        if (signal?.aborted) {
          return {
            content: [{ type: 'text', text: 'Request cancelled' }],
            details,
            isError: true,
          };
        }
        if (timeout.aborted) {
          return {
            content: [{ type: 'text', text: `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s` }],
            details,
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: `Fetch failed: ${errorMessage(error)}` }],
          details,
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('web_fetch ')) + theme.fg('muted', args.url),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as FetchDetails | undefined;

      if (!details?.status) {
        const content = result.content[0];
        const msg = content?.type === 'text' ? content.text : 'Request failed';
        return new Text(theme.fg('error', msg), 0, 0);
      }

      const statusColor = details.status < 400 ? 'success' : 'error';
      let text = theme.fg(statusColor, `${details.status} ${details.statusText}`);
      if (details.contentType) {
        text += theme.fg('dim', ` (${details.contentType})`);
      }
      if (details.truncated) {
        text += theme.fg('warning', ' [truncated]');
      }

      if (expanded) {
        const content = result.content[0];
        if (content?.type === 'text') {
          const lines = content.text.split('\n').slice(0, 30);
          for (const line of lines) {
            text += `\n${theme.fg('dim', line)}`;
          }
          if (content.text.split('\n').length > 30) {
            text += `\n${theme.fg('muted', '...')}`;
          }
        }
        if (details.fullOutputPath) {
          text += `\n${theme.fg('dim', `Full output: ${details.fullOutputPath}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
