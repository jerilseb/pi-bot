import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import {
  stripTerminalSequences,
  type Terminal,
  TuiMainScreen,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { formatSessionEvent } from '../src/session-notes.ts';
import type {
  BashJobSnapshot,
  ChannelRef,
  CoreState,
  SubagentJobSnapshot,
} from '../src/contract.ts';
import { ChatView, internalPromptSummary } from '../src/tui/chat-view.ts';
import { footerLine } from '../src/tui/footer.ts';
import { jobLines, jobSummary } from '../src/tui/jobs.ts';
import { PromptEditor } from '../src/tui/prompt-editor.ts';
import { promptBand } from '../src/tui/style.ts';
import { WorkingIndicator } from '../src/tui/working-indicator.ts';

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
  const chat = new ChatView(screen());
  const rows = (width = 80): string[] =>
    chat.container.render(width).map((line) => plain(line).trimEnd());
  const shown = (): string => rows().filter(Boolean).join('\n');
  return { chat, rows, shown };
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
const reply = (content: unknown[], stopReason = 'stop') =>
  ({
    role: 'assistant',
    content,
    api: 'x',
    provider: 'x',
    model: 'x',
    usage,
    stopReason,
    timestamp: 1,
  }) as never;
const assistant = (text: string) => reply([{ type: 'text', text }]);
const call = (id: string, name: string, args: unknown) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const result = (id: string, name: string, text: string, isError = false) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
  isError,
  timestamp: 2,
});

test("a transcript is drawn as the chat, the model's Markdown as formatting and the bot's own prompts as one line", () => {
  const { chat, shown } = view();
  chat.load([
    { role: 'user', content: 'What is up?', timestamp: 1 },
    assistant('All **good** & quiet.'),
    {
      role: 'user',
      content: '[background-bash-report] Background bash bg_1 exited with code 0.\n\nOutput: ok',
      timestamp: 2,
    },
  ] as never);
  const text = shown();
  assert.match(text, /What is up\?/);
  assert.match(text, /All good & quiet\./);
  assert.match(text, /── Background bash bg_1 exited with code 0\. ──/);
  assert.doesNotMatch(text, /Output: ok|\*\*/);
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
  assert.equal(shown().match(/Telegram:/g)?.length, 1);
  assert.match(shown(), /❯ Telegram: from my phone/);
  assert.match(shown(), /❯ from here/);
});

test('images in a message are its [Image N] markers, or named in front of a photo caption', () => {
  const { chat, shown } = view();
  chat.setSelf(self);
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  chat.input(self, 'compare [Image 1] and [Image 2]');
  chat.input(telegram, 'from my phone');
  chat.turnStart({ kind: 'user', channel: self });
  chat.agentEvent({
    type: 'message_start',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'compare [Image 1] and [Image 2]' }, image, image],
      timestamp: 1,
    },
  } as never);
  chat.agentEvent({
    type: 'message_start',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'from my phone' }, image],
      timestamp: 2,
    },
  } as never);
  assert.equal(chat.unseen.length, 0);
  assert.match(shown(), /❯ compare \[Image 1\] and \[Image 2\]\n/);
  assert.equal(shown().match(/\[Image 2\]/g)?.length, 1);
  assert.match(shown(), /❯ Telegram: \[Image 1\] from my phone/);
});

test('input /abort dropped stops waiting once nothing runs, waits or steers', () => {
  const { chat } = view();
  chat.setSelf(self);
  chat.input(self, 'queued behind the turn');
  chat.input(telegram, 'steering the turn');
  const state = { busy: true, queued: 1, steering: 1, model: 'openai-codex/gpt-6-luna' };
  chat.state(state);
  assert.equal(chat.unseen.length, 2);
  // /abort cleared the queue and the steering; the aborted run is still ending.
  chat.state({ ...state, queued: 0, steering: 0 });
  assert.equal(chat.unseen.length, 2);
  chat.state({ ...state, busy: false, queued: 0, steering: 0 });
  assert.equal(chat.unseen.length, 0);
});

test('a reply that is already streaming when the terminal connects is still drawn', () => {
  const { chat, shown } = view();
  chat.turnStart({ kind: 'user', channel: self });
  chat.agentEvent({
    type: 'message_update',
    message: assistant('Half a'),
    assistantMessageEvent: { type: 'text_delta' },
  } as never);
  chat.agentEvent({ type: 'message_end', message: assistant('Half a *reply*.') } as never);
  assert.match(shown(), /Half a reply\./);
});

test('a tool call is one row saying what it came to, a failure two, until /expand', () => {
  const { chat, rows, shown } = view();
  const paragraph = (n: number): string => `Paragraph ${n} ${'word '.repeat(60)}`;
  chat.load([
    { role: 'user', content: 'Read the page', timestamp: 1 },
    reply(
      [
        call('c1', 'web_fetch', { url: 'https://x.test' }),
        call('c2', 'bash', { command: 'npm test' }),
      ],
      'toolUse',
    ),
    result('c1', 'web_fetch', [1, 2, 3, 4].map(paragraph).join('\n')),
    result('c2', 'bash', '# fail 1\n✖ cron.test.ts\n\nCommand exited with code 1', true),
    assistant('One test fails.'),
  ] as never);
  assert.deepEqual(
    rows(),
    [
      '❯ Read the page',
      '',
      '● web_fetch https://x.test · 4 lines',
      '✗ bash npm test · exit 1',
      '  ⎿ ✖ cron.test.ts',
      '',
      'One test fails.',
    ].map((row) => (row ? ` ${row}` : row)),
  );

  chat.toggleExpanded();
  const expanded = shown();
  assert.match(expanded, /⎿ Paragraph 1/);
  assert.match(expanded, /Paragraph 4/);
  assert.match(expanded, /Command exited with code 1/);
});

test('a tool call shows where it stands while it runs, and what it last printed', () => {
  const { chat, shown } = view();
  chat.turnStart({ kind: 'user', channel: self });
  chat.agentEvent({
    type: 'message_update',
    message: reply([call('c1', 'bash', { command: 'make' })], 'toolUse'),
    assistantMessageEvent: { type: 'toolcall_delta' },
  } as never);
  assert.match(shown(), /○ bash make$/);
  chat.agentEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash' } as never);
  chat.agentEvent({
    type: 'tool_execution_update',
    toolCallId: 'c1',
    partialResult: { content: [{ type: 'text', text: 'step 1\nstep 2\n' }] },
  } as never);
  assert.match(shown(), /○ bash make · step 2$/);
  chat.agentEvent({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    result: { content: [{ type: 'text', text: 'step 1\nstep 2\ndone' }] },
    isError: false,
  } as never);
  assert.match(shown(), /● bash make · 3 lines$/);
});

test('thinking shows as one line only while it is under way, and in full on /expand', () => {
  const { chat, shown } = view();
  chat.turnStart({ kind: 'user', channel: self });
  const thinking = { type: 'thinking', thinking: 'Weighing it up.' };
  chat.agentEvent({
    type: 'message_update',
    message: reply([thinking]),
    assistantMessageEvent: { type: 'thinking_delta' },
  } as never);
  assert.match(shown(), /Thinking… \(\/expand\)/);
  chat.agentEvent({
    type: 'message_end',
    message: reply([thinking, { type: 'text', text: 'Done.' }]),
  } as never);
  assert.equal(shown(), ' Done.');
  chat.toggleExpanded();
  assert.match(shown(), /Weighing it up\.\n\s*Done\./);
});

test('tool calls stack; every other block has one blank row before it', () => {
  const { chat, rows } = view();
  chat.load([
    { role: 'user', content: 'Look around', timestamp: 1 },
    reply([{ type: 'thinking', thinking: 'hidden' }, call('c1', 'ls', { path: '.' })], 'toolUse'),
    result('c1', 'ls', 'a\nb'),
    reply([call('c2', 'find', { pattern: '*.ts' })], 'toolUse'),
    result('c2', 'find', 'No files found matching pattern'),
    assistant('Nothing much.'),
  ] as never);
  chat.note('A note.');
  assert.deepEqual(rows(), [
    ' ❯ Look around',
    '',
    ' ● ls . · 2 entries',
    ' ● find *.ts · no files',
    '',
    ' Nothing much.',
    '',
    ' A note.',
  ]);
});

test("the bot's notes in the transcript are a divider named for the user, whole on /expand", () => {
  const { chat, shown } = view();
  const note = (kind: string, text: string) => ({
    role: 'custom',
    customType: 'pi-bot-event',
    content: formatSessionEvent(text),
    display: true,
    details: { kind },
    timestamp: 1,
  });
  chat.load([
    note(
      'restart',
      'The bot process was restarted deliberately. This session resumed, but any in-flight work was dropped.',
    ),
    note('model', 'The chat model was changed from openai/a to openrouter/b.'),
    note(
      'scheduled-task',
      'A scheduled task "Morning brief" ran on openai/a in a separate background session and sent this report to the user:\n<background_report>\nAll quiet.\n</background_report>',
    ),
    note(
      'heartbeat',
      'A heartbeat run sent this message to the user:\n<background_report>\nHi\n</background_report>',
    ),
  ] as never);
  assert.equal(
    shown(),
    [
      ' ── Bot restarted ──',
      ' ── Model changed to openrouter/b ──',
      ' ── Scheduled task "Morning brief" sent a report ──',
      ' ── Heartbeat sent a message ──',
    ].join('\n'),
  );
  chat.toggleExpanded();
  assert.match(shown(), /── Bot restarted ──\n\s+The bot process was restarted deliberately\./);
  assert.match(shown(), /All quiet\./);
  assert.doesNotMatch(shown(), /bot-event|Automatic note/);
});

test('every row fits the width, however long the prompt, the argument or the output', () => {
  const { chat, rows } = view();
  const long = `${'長い'.repeat(30)} ${'x'.repeat(200)}`;
  chat.load([
    { role: 'user', content: long, timestamp: 1 },
    reply(
      [call('c1', 'bash', { command: long }), call('c2', 'web_search', { query: long })],
      'toolUse',
    ),
    result('c1', 'bash', `${long}\n\nCommand exited with code 2`, true),
    result('c2', 'web_search', long),
    assistant(long),
  ] as never);
  for (const state of ['folded', 'expanded']) {
    for (const width of [12, 20, 40, 80]) {
      for (const row of chat.container.render(width)) {
        assert.ok(visibleWidth(row) <= width, `${state}, ${width}: ${JSON.stringify(plain(row))}`);
      }
    }
    chat.toggleExpanded();
  }
  assert.match(rows(40).join('\n'), /✗ bash .+ · exit 2/);
});

test("the bot's own prompts are named from the turn's origin, or from their envelope", () => {
  assert.equal(
    internalPromptSummary('[subagent-report] Sub-agent job sub_1 succeeded.\n…', null),
    'Sub-agent job sub_1 succeeded.',
  );
  assert.equal(
    internalPromptSummary('This is a post-restart task for the assistant.', null),
    'Post-restart task',
  );
  assert.equal(
    internalPromptSummary('anything', { kind: 'post-restart', taskId: 't' }),
    'Post-restart task',
  );
  assert.equal(internalPromptSummary('Just a question', { kind: 'user', channel: self }), null);
  assert.equal(internalPromptSummary('Just a question', null), null);
});

test("a message steered into a turn the bot started is the user's, not the bot's prompt", () => {
  const { chat, shown } = view();
  chat.setSelf(self);
  // Files alone, sent from here: no text to tell its message by.
  chat.input(self, '');
  chat.turnStart({ kind: 'post-restart', taskId: 't' });
  chat.agentEvent({
    type: 'message_start',
    message: {
      role: 'user',
      content: 'This is a post-restart task for the assistant.',
      timestamp: 1,
    },
  } as never);
  assert.equal(chat.unseen.length, 1);
  chat.input(telegram, 'how is it going?');
  chat.agentEvent({
    type: 'message_start',
    message: { role: 'user', content: 'how is it going?', timestamp: 2 },
  } as never);
  assert.equal(chat.unseen.length, 0);
  assert.equal(shown().match(/── Post-restart task ──/g)?.length, 1);
  assert.match(shown(), /❯ Telegram: how is it going\?/);
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
    'openai-codex/gpt-6-luna · high · 🟡 working · 📥 2 queued · ↪️ 1 steering · 📬 3 held · ⚙️ 1 job · also on Telegram',
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
  assert.deepEqual(jobLines(bash, 65_000).map(plain), ['⏹️ npm test · stopping… · 1m', '   ok 12']);
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

test('the editor puts a ❯ before its text, between a line above and below', () => {
  const editor = new PromptEditor(screen(), {
    borderColor: (text) => text,
    selectList: getSelectListTheme(),
  });
  const rows = (width: number): string[] => editor.render(width).map((row) => plain(row));
  assert.deepEqual(
    rows(20).map((row) => row.trimEnd()),
    ['─'.repeat(20), ' ❯', '─'.repeat(20)],
  );
  editor.setText(`first ${'word '.repeat(12)}`);
  const wrapped = rows(30);
  assert.ok(wrapped.length > 4, 'the text wraps');
  assert.equal(wrapped[0], '─'.repeat(30));
  assert.equal(wrapped.at(-1), '─'.repeat(30));
  assert.match(wrapped[1] ?? '', /^ ❯ first word/);
  for (const row of wrapped.slice(2, -1)) assert.match(row, /^ {3}\S/);
  for (const width of [3, 4, 10, 30, 80]) {
    for (const row of editor.render(width))
      assert.ok(visibleWidth(row) <= width, `${width}: ${row}`);
  }
});

test('while the chat works, a line above the editor says so, as Pi draws it', (t) => {
  const working = new WorkingIndicator(screen());
  t.after(() => working.setWorking(false));
  const rows = (width = 40): string[] => working.render(width).map((row) => plain(row).trimEnd());
  assert.deepEqual(rows(), [], 'nothing while idle');
  working.setWorking(true);
  const [line, ...below] = rows();
  assert.match(line ?? '', /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working$/, "in the column of the editor's ❯");
  assert.deepEqual(below, [''], 'a margin from the editor');
  assert.ok(working.render(4).every((row) => visibleWidth(row) <= 4), 'cut to a narrow width');
  working.setWorking(false);
  assert.deepEqual(rows(), []);
});

/** The background a row opens with, as its SGR parameters after `48;`; null for none. */
function background(row: string): string | null {
  const open = '\x1b[48;';
  return row.startsWith(open) ? row.slice(open.length, row.indexOf('m')) : null;
}

test("a prompt sits on a band across the width, a shade of the terminal's own background", () => {
  const { chat } = view();
  chat.load([{ role: 'user', content: `A prompt ${'long '.repeat(30)}`, timestamp: 1 }] as never);
  const band = (width: number): string[] =>
    chat.container
      .render(width)
      .map((row) =>
        ['A', 'B', 'C'].reduce((line, mark) => line.replaceAll(`\x1b]133;${mark}\x07`, ''), row),
      );
  for (const width of [20, 80]) {
    const rows = band(width);
    assert.ok(rows.length > 1);
    for (const row of rows) {
      assert.equal(visibleWidth(row), width);
      assert.ok(background(row) && row.endsWith('\x1b[49m'), JSON.stringify(row));
    }
  }
  // Pi's colours, until the terminal says what its background is.
  assert.ok(['2;52;53;65', '5;237'].includes(background(band(80)[0] ?? '') ?? ''));
  chat.setTerminalBackground({ r: 0, g: 0, b: 0 });
  assert.ok(['2;33;33;33', '5;235'].includes(background(band(80)[0] ?? '') ?? ''));
});

test('a band is lighter than a dark background, darker than a light one, in either palette', () => {
  const code = (band: ReturnType<typeof promptBand>): string | null => background(band.bg(''));
  assert.equal(code(promptBand({ r: 30, g: 30, b: 30 }, true)), '2;59;59;59');
  assert.equal(code(promptBand({ r: 255, g: 255, b: 255 }, true)), '2;237;237;237');
  assert.equal(code(promptBand({ r: 255, g: 255, b: 255 }, false)), '5;255');
  assert.equal(code(promptBand(null, false)), '5;237');
  // The terminal's own text colour on its own background's band; Pi's text on Pi's.
  assert.equal(promptBand({ r: 30, g: 30, b: 30 }, true).text('x'), 'x');
  assert.equal(promptBand(null, true).text('x'), '\x1b[38;2;212;212;212mx\x1b[39m');
});
