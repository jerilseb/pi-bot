import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * The user's standing preferences, kept in a single GitHub gist that every one of
 * their agents reads, so a change made in one place reaches all of them without a
 * commit. The same feature lives in their dotfiles for Claude Code and the Pi CLI;
 * this is the bot's copy, and the three are meant to stay in step.
 *
 * CONTEXT_GIST_URL must be a raw URL naming one file:
 *
 *   https://gist.githubusercontent.com/<owner>/<gist-id>/raw/<file>
 *
 * The file is named rather than left implicit because the fileless /raw serves whichever
 * file GitHub orders first, which moves as files are added -- so a gist holding several
 * of them still has one unambiguous source of truth. Unset, this is a no-op.
 *
 * Fetched once at startup, deliberately: the bot is a long-lived daemon, so editing
 * the gist takes effect on its next restart rather than mid-conversation. That keeps
 * the preferences fixed for a process lifetime, which is also what lets them sit in
 * the cacheable part of the prompt.
 */
const GIST_RAW_HOST = 'gist.githubusercontent.com';
const GIST_OWNER = 'jerilseb';
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CHARS = 32_768;
const PREAMBLE =
  "The user's standing preferences, shared across their coding agents. Apply them as user-level instructions.";

/**
 * The whole allowlist. Anchored and literal up to the gist id, so the host cannot be a
 * prefix (evil.tld/gist.githubusercontent.com/...), a suffix (...com.evil.tld), or
 * userinfo (...com@evil.tld), and cannot carry a port: each puts a character where a
 * literal '/' is required. \S rather than . keeps a newline in the env var from
 * smuggling a second line past the anchor. An env var is a channel anything in the
 * process environment can write, and this is what stops one from redirecting the
 * bot's system prompt somewhere else. The file name is one required segment: no '/', so
 * it cannot walk back up the path, and no '?' or '#', so the URL that is fetched is the
 * whole of what was vetted.
 */
const RAW_HOST_PATTERN = GIST_RAW_HOST.replace(/\./g, '\\.');
const URL_RE = new RegExp(
  `^https://${RAW_HOST_PATTERN}/${GIST_OWNER}/[0-9a-f]{32}/raw/[^\\s/?#]+$`,
);
/**
 * GitHub's "Raw" button pins a 40-hex git blob SHA of the file's current content,
 * which makes the URL immutable: it would serve the same text after every edit. Strip
 * it rather than reject it -- what is left is exactly the form required above -- so
 * pasting that URL still does the right thing.
 */
const PINNED_RE = new RegExp(
  `^(https://${RAW_HOST_PATTERN}/${GIST_OWNER}/[0-9a-f]{32}/raw)/[0-9a-f]{40}(/\\S*)?$`,
);

type ContextGistState =
  | { kind: 'unset' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; text: string; notice?: string };

let state: ContextGistState = { kind: 'unset' };

function normalize(raw: string): { url: string; pinned: boolean } | null {
  const url = raw.trim();
  const pinned = PINNED_RE.exec(url);
  if (pinned) {
    // Re-checked, because a pinned URL naming no file strips down to a fileless /raw.
    const stripped = `${pinned[1]}${pinned[2] ?? ''}`;
    return URL_RE.test(stripped) ? { url: stripped, pinned: true } : null;
  }
  if (URL_RE.test(url)) return { url, pinned: false };
  return null;
}

async function fetchPreferences(): Promise<ContextGistState> {
  const configured = process.env.CONTEXT_GIST_URL;
  if (!configured?.trim()) return { kind: 'unset' };

  const target = normalize(configured);
  if (!target) {
    return {
      kind: 'error',
      message: `CONTEXT_GIST_URL must be https://${GIST_RAW_HOST}/${GIST_OWNER}/<gist-id>/raw/<file>`,
    };
  }

  let notice = target.pinned
    ? `pinned revision stripped (it would never pick up an edit); using ${target.url}`
    : undefined;

  try {
    const response = await fetch(target.url, {
      // A redirect is the one way a vetted URL still lands off the allowed host.
      redirect: 'error',
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` };

    let text = (await response.text()).trim();
    if (!text) return { kind: 'error', message: 'the gist is empty' };
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      notice = `${notice ? `${notice}; ` : ''}truncated to ${MAX_CHARS} characters`;
    }

    return { kind: 'loaded', text, notice };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Called once during startup. Never throws: missing preferences must not stop the bot. */
export async function loadContextGist(): Promise<void> {
  state = await fetchPreferences();
}

/** One line for the startup banner, so a misconfigured URL is visible in the logs. */
export function contextGistStatusText(): string {
  if (state.kind === 'unset') return 'off (CONTEXT_GIST_URL unset)';
  if (state.kind === 'error') return `failed: ${state.message} — preferences not loaded`;
  const size = `${state.text.length} chars`;
  return state.notice ? `on (${size}; ${state.notice})` : `on (${size})`;
}

function appendContextGistToSystemPrompt(systemPrompt: string): string {
  if (state.kind !== 'loaded') return systemPrompt;
  return [
    systemPrompt,
    '',
    PREAMBLE,
    '',
    '<user-preferences>',
    state.text,
    '</user-preferences>',
  ].join('\n');
}

export function contextGistSystemPromptExtension(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: appendContextGistToSystemPrompt(event.systemPrompt),
  }));
}
