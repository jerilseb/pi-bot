import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Terminal, TuiMainScreen } from '@earendil-works/pi-tui';
import type {
  BashJobSnapshot,
  ChannelRef,
  CoreState,
  SubagentJobSnapshot,
} from '../src/contract.ts';
import { ChatView, internalPromptSummary } from '../src/tui/chat-view.ts';
import { footerLine } from '../src/tui/footer.ts';
import { jobLines, jobSummary } from '../src/tui/jobs.ts';
import { WorkingEditor } from '../src/tui/working-editor.ts';

/**
 * What the terminal draws, rendered off-screen: the chat from a transcript and
 * from events, the footer, and job lines. No terminal is started.
 */

initTheme();

const plain = (text: string): string => stripTerminalSequences(text);

function screen(): TuiMainScreen {
  const terminal = {
    start() {},
    stop() {},
    write() {},
    columns: 80,
    rows: 24,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
  } as unknown as Terminal;
  return new TuiMainScreen(terminal);
}

function view() {
  const chat = new ChatView(screen(), '/work');
  const shown = (): string =>
    chat.container
      .render(80)
      .map((line) => plain(line).trimEnd())
      .filter(Boolean)
      .join('\n');
  return { chat, shown };
}

const telegram: ChannelRef = { id: 'telegram', kind: 'telegram' };
const self: ChannelRef = { id: 'tui:1', kind: 'tui' };
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'x',
    provider: 'x',
    model: 'x',
    usage,
    stopReason: 'stop',
    timestamp: 1,
  }) as never;

test("a transcript is drawn as the chat, the model's HTML as formatting and the bot's own prompts as one line", () => {
  const { chat, shown } = view();
  chat.load([
    { role: 'user', content: 'What is up?', timestamp: 1 },
    assistant('All <b>good</b> &amp; quiet.'),
    {
      role: 'user',
      content: '[background-bash-report] Background bash bg_1 exited with code 0.\n\nOutput: ok',
      timestamp: 2,
    },
  ] as never);
  const text = shown();
  assert.match(text, /What is up\?/);
  assert.match(text, /All good & quiet\./);
  assert.match(text, /⚙ Background bash bg_1 exited with code 0\./);
  assert.doesNotMatch(text, /Output: ok|<b>|&amp;/);
});

test('a message typed in Telegram is labelled; one typed here is not', () => {
  const { chat, shown } = view();
  chat.setSelf(self);
  chat.input(telegram, 'from my phone');
  chat.input(self, 'from here');
  assert.equal(chat.unseen.length, 2);
  chat.turnStart({ kind: 'user', channel: telegram });
  chat.agentEvent({
    type: 'message_start',
    message: { role: 'user', content: 'from my phone', timestamp: 1 },
  } as never);
  chat.agentEvent({
    type: 'message_start',
    message: { role: 'user', content: 'from here', timestamp: 2 },
  } as never);
  assert.equal(chat.unseen.length, 0);
  assert.equal(shown().match(/From Telegram:/g)?.length, 1);
  assert.match(shown(), /From Telegram:\n\s*from my phone/);
});

test('a reply that is already streaming when the terminal connects is still drawn', () => {
  const { chat, shown } = view();
  chat.turnStart({ kind: 'user', channel: self });
  chat.agentEvent({
    type: 'message_update',
    message: assistant('Half a'),
    assistantMessageEvent: { type: 'text_delta' },
  } as never);
  chat.agentEvent({ type: 'message_end', message: assistant('Half a <i>reply</i>.') } as never);
  assert.match(shown(), /Half a reply\./);
});

test("the bot's own prompts are named from the turn's origin, or from their envelope", () => {
  assert.equal(
    internalPromptSummary('[subagent-report] Sub-agent job sub_1 succeeded.\n…', null),
    'Sub-agent job sub_1 succeeded.',
  );
  assert.equal(
    internalPromptSummary('This is a post-restart task for the Telegram assistant.', null),
    'Post-restart task',
  );
  assert.equal(
    internalPromptSummary('anything', { kind: 'post-restart', taskId: 't' }),
    'Post-restart task',
  );
  assert.equal(internalPromptSummary('Just a question', { kind: 'user', channel: self }), null);
  assert.equal(internalPromptSummary('Just a question', null), null);
});

const STATE: CoreState = {
  chat: { busy: true, queued: 2, steering: 1, model: 'openai-codex/gpt-6-luna', reasoning: 'high' },
  background: { busy: false, queued: 0, steering: 0, model: 'per-prompt' },
  held: 3,
};

test('the footer says what the chat is doing, what waits, and who else is here', () => {
  const line = plain(
    footerLine({
      connection: { status: 'connected' },
      state: STATE,
      channels: [telegram, self],
      self,
      jobs: 1,
    }),
  );
  assert.equal(
    line,
    'openai-codex/gpt-6-luna · high · 🟡 working · 📥 2 queued · ↪️ 1 steering · 📬 3 held · ⚙ 1 job · also on Telegram',
  );
  assert.match(
    plain(
      footerLine({
        connection: { status: 'lost', retryInMs: 2_400 },
        state: STATE,
        channels: [],
        self,
        jobs: 0,
      }),
    ),
    /Not connected to the bot · retrying in 2s/,
  );
});

test("a job's lines show its progress, and its summary how it ended", () => {
  const bash: BashJobSnapshot = {
    kind: 'bash',
    id: 'bg_1',
    command: 'npm test',
    status: 'running',
    statusText: 'running',
    exitCode: null,
    startedAt: 0,
    endedAt: null,
    stopRequested: true,
    lastLine: 'ok 12',
  };
  assert.deepEqual(jobLines(bash, 65_000).map(plain), ['⏹ npm test · stopping… · 1m', '   ok 12']);
  assert.equal(
    jobSummary(
      { ...bash, status: 'exited', exitCode: 1, statusText: 'exited with code 1', endedAt: 5_000 },
      0,
    ),
    '❌ Command exited with code 1 after 5s: npm test',
  );

  const task = {
    index: 0,
    task: 'Map the scheduler',
    description: 'Map it',
    model: 'x/y',
    status: 'running' as const,
    stopRequested: false,
    toolCalls: ['read (src/cron.ts)'],
    toolUses: 1,
    result: null,
    error: null,
    startedAt: 0,
    endedAt: null,
  };
  const subagents: SubagentJobSnapshot = {
    kind: 'subagent',
    id: 'sub_1',
    status: 'running',
    startedAt: 0,
    endedAt: null,
    tasks: [
      task,
      { ...task, index: 1, description: null, task: 'Survey', status: 'succeeded', endedAt: 2_000 },
    ],
  };
  assert.deepEqual(jobLines(subagents, 3_000).map(plain), [
    '⏳ Sub-agents · 1 of 2 done · 3s',
    '   1. ⏳ Map it · running · 3s',
    '      ↳ read (src/cron.ts)',
    '   2. ✅ Survey · succeeded · 2s',
  ]);
});

test("while the chat works, the editor's top border says so, as Pi's does", (t) => {
  const editor = new WorkingEditor(screen(), {
    borderColor: (text) => text,
    selectList: getSelectListTheme(),
  });
  t.after(() => editor.setWorking(false));
  const top = (width = 40): string => plain(editor.render(width)[0] ?? '');
  assert.equal(top(), '─'.repeat(40));
  editor.setWorking(true);
  assert.match(top(), /^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working ─{27}$/);
  assert.match(top(8), /^─[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]─{6}$/, 'too narrow for the word: the spinner alone');
  editor.setWorking(false);
  assert.equal(top(), '─'.repeat(40));
});
