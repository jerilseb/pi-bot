import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import webFetchExtension, { readBody } from '../extensions/web-fetch/index.ts';

/**
 * Tests for the web_fetch extension against a faked global fetch, so nothing
 * leaves the process. Bodies stay under the output limit, so no full-output
 * temp file is written.
 */

function setup(t: TestContext, response: () => Response) {
  let tool: ToolDefinition | undefined;
  webFetchExtension({
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    init.signal?.throwIfAborted();
    return response();
  });
  const fetchText = async (signal?: AbortSignal) => {
    assert.ok(tool);
    const result = await tool.execute(
      'call-1',
      { url: 'https://x.test/page' },
      signal,
      undefined,
      {} as ExtensionContext,
    );
    const [content] = result.content;
    assert.equal(content?.type, 'text');
    return content.text;
  };
  return { fetchText, requests };
}

function respond(body: BodyInit, contentType: string): () => Response {
  return () => new Response(body, { headers: { 'content-type': contentType } });
}

test('converts HTML to Markdown', async (t) => {
  const { fetchText } = setup(t, respond('<h1>Title</h1><p>Hi <b>there</b></p>', 'text/html'));
  const text = await fetchText();
  assert.match(text, /# Title/);
  assert.match(text, /Hi \*\*there\*\*/);
});

test('returns plain text as is, keeping its line breaks and indentation', async (t) => {
  const code = 'def f(x):\n    if x < 2:\n        return x\n';
  const { fetchText } = setup(t, respond(code, 'text/plain; charset=utf-8'));
  assert.ok((await fetchText()).endsWith(`\n\n${code}`));
});

test('returns JSON as is, without Markdown escapes', async (t) => {
  for (const type of ['application/json', 'application/vnd.github+json']) {
    const { fetchText } = setup(t, respond('{"snake_case": [1, 2]}', type));
    assert.match(await fetchText(), /\n\n\{"snake_case": \[1, 2\]\}$/);
  }
});

test('does not read binary content', async (t) => {
  let pulled = false;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull() {
        pulled = true;
      },
      cancel() {
        cancelled = true;
      },
    },
    // No read-ahead, so any pull means the tool asked for the body.
    { highWaterMark: 0 },
  );
  const { fetchText } = setup(t, respond(body, 'image/png'));
  assert.match(await fetchText(), /Binary content not shown/);
  assert.equal(pulled, false);
  assert.equal(cancelled, true);
});

test('always passes a deadline to fetch, and reports a cancelled request', async (t) => {
  const { fetchText, requests } = setup(t, respond('ok', 'text/plain'));
  await fetchText();
  assert.ok(requests[0]?.signal, 'a request without a caller signal still gets the timeout');

  const aborted = AbortSignal.abort();
  assert.equal(await fetchText(aborted), 'Request cancelled');
});

test('readBody stops at the byte cap and cancels the rest of the download', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 128) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await readBody(new Response(body), 200_000);

  assert.equal(result.text.length, 200_000);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
  assert.ok(pulls < 10, `read ${pulls} chunks for a 200 KB cap`);
});

test('readBody reads a body under the cap in full', async () => {
  const result = await readBody(new Response('héllo'), 1024);
  assert.deepEqual(result, { text: 'héllo', truncated: false });
});
