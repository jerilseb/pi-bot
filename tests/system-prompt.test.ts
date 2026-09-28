import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { contextGistSystemPromptExtension } from '../src/context-gist.ts';
import { activeModelSystemPromptExtension } from '../src/system-prompt.ts';

/**
 * The bot's prompt blocks are named sections of Pi's prompt. Returning
 * `systemPrompt` instead would force a whole prompt for the run: the transcript
 * would no longer record the blocks, and a changed block would cost the
 * conversation's cached prefix rather than a patch of one section.
 */

type Handler = (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartEventResult | undefined>;

async function runExtension(extension: (pi: ExtensionAPI) => void) {
  const handlers: Handler[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      assert.equal(name, 'before_agent_start');
      handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  const sections: Record<string, string> = {};
  const event = {
    type: 'before_agent_start',
    prompt: 'hi',
    systemPrompt: 'the rendered prompt',
    systemPromptOptions: { sections },
  } as unknown as BeforeAgentStartEvent;
  const results = [];
  for (const handler of handlers) results.push(await handler(event));
  return { sections, results };
}

test('the chat settings are a section of the prompt, which is not replaced', async () => {
  const { sections, results } = await runExtension(activeModelSystemPromptExtension);
  assert.deepEqual(Object.keys(sections), ['chat-settings']);
  assert.match(sections['chat-settings'], /^## Active chat settings\n/);
  assert.deepEqual(results, [undefined]);
});

test('without a loaded gist there is no preferences section', async () => {
  const { sections, results } = await runExtension(contextGistSystemPromptExtension);
  assert.deepEqual(sections, {});
  assert.deepEqual(results, [undefined]);
});
