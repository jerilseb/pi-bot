import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  backgroundReportNote,
  formatSessionEvent,
  lastSessionEventKind,
  SESSION_EVENT_TYPE,
  type SessionEventKind,
} from '../src/session-notes.ts';

/**
 * Two things decide whether a note is useful: the wording Pi reads, and whether
 * the last entry in a session file is recognised as one of ours — that second
 * one is the whole unclean-exit check, and a false positive there invents a
 * crash that never happened.
 */

function entry(overrides: Record<string, unknown> = {}) {
  return {
    type: 'custom_message',
    id: 'e1',
    parentId: null,
    timestamp: '2026-09-16T14:20:00.000Z',
    customType: SESSION_EVENT_TYPE,
    content: 'note',
    display: true,
    details: { kind: 'restart' as SessionEventKind },
    ...overrides,
  };
}

/** Stands in for a SessionManager; only getEntries() is consulted. */
function manager(entries: unknown[]) {
  return { getEntries: () => entries } as unknown as Parameters<typeof lastSessionEventKind>[0];
}

describe('formatSessionEvent', () => {
  it('fences the note so it cannot read as user input', () => {
    const text = formatSessionEvent('The bot restarted.');
    assert.match(text, /^<bot-event>\n/);
    assert.match(text, /\n<\/bot-event>$/);
    assert.match(text, /not user input/i);
    assert.match(text, /The bot restarted\./);
  });
});

describe('backgroundReportNote', () => {
  it('names a scheduled task, its model, and quotes the report', () => {
    const note = backgroundReportNote({
      source: 'cron',
      label: 'Morning check',
      model: 'test/m',
      report: ' all good ',
    });
    assert.equal(note?.kind, 'scheduled-task');
    assert.match(note?.text ?? '', /scheduled task "Morning check" ran on test\/m/);
    assert.match(note?.text ?? '', /<background_report>\nall good\n<\/background_report>/);
  });

  it('describes a heartbeat message', () => {
    const note = backgroundReportNote({ source: 'heartbeat', model: 'test/m', report: 'hi' });
    assert.equal(note?.kind, 'heartbeat');
    assert.match(note?.text ?? '', /heartbeat run on test\/m/);
  });

  it('names the command a background-bash report came from', () => {
    const note = backgroundReportNote({
      source: 'background-bash-report',
      label: 'npm test',
      report: 'tests failed',
    });
    assert.equal(note?.kind, 'background-bash');
    assert.match(note?.text ?? '', /background command "npm test"/);
    assert.match(note?.text ?? '', /tests failed/);
  });

  it('has nothing to say about chat-session replies', () => {
    assert.equal(backgroundReportNote({ source: 'telegram', report: 'x' }), null);
    assert.equal(backgroundReportNote({ source: undefined, report: 'x' }), null);
  });
});

describe('lastSessionEventKind', () => {
  it('reads the kind off a trailing note', () => {
    assert.equal(lastSessionEventKind(manager([entry()])), 'restart');
  });

  it('only looks at the final entry', () => {
    const entries = [entry(), { type: 'message', id: 'e2', parentId: 'e1', timestamp: '' }];
    assert.equal(lastSessionEventKind(manager(entries)), null);
  });

  it('ignores custom messages from other extensions', () => {
    assert.equal(lastSessionEventKind(manager([entry({ customType: 'other-ext' })])), null);
  });

  it('ignores a note with no recorded kind', () => {
    assert.equal(lastSessionEventKind(manager([entry({ details: undefined })])), null);
  });

  it('treats an empty session as unmarked', () => {
    assert.equal(lastSessionEventKind(manager([])), null);
  });
});
