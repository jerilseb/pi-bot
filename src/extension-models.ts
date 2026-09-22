import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatModelRef, parseModelRef } from './util.ts';

/**
 * Model lookups for agent-facing tools that pin work to a model: scheduled
 * tasks, background bash origins, and sub-agent workers. They all read the model
 * off the tool's ExtensionContext, and they all validate a requested ref against
 * the live catalogue the same way, so the wording and the rules live here once.
 */

/** The model the current turn is on, as provider/model, or undefined when the SDK has none. */
export function currentModel(ctx: ExtensionContext): string | undefined {
  return ctx.model
    ? formatModelRef({ provider: ctx.model.provider, model: ctx.model.id })
    : undefined;
}

/** Like currentModel, but a missing model is an error the agent can act on. */
export function requireCurrentModel(ctx: ExtensionContext): string {
  const model = currentModel(ctx);
  if (!model) {
    throw new Error('No chat model is active; pass model explicitly.');
  }
  return model;
}

/**
 * Checks a requested model against the live catalogue so a typo or a provider
 * without auth fails now, not silently when the work runs. Returns the
 * normalised provider/model ref.
 */
export function resolveRequestedModel(ctx: ExtensionContext, requested: string): string {
  const ref = parseModelRef(requested);
  const model = ctx.modelRegistry.find(ref.provider, ref.model);
  if (!model) {
    throw new Error(`Unknown model ${formatModelRef(ref)}. Available: ${availableModelList(ctx)}`);
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No auth configured for ${formatModelRef(ref)}.`);
  }
  return formatModelRef(ref);
}

function availableModelList(ctx: ExtensionContext): string {
  const names = ctx.modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
  return names.length ? names.join(', ') : 'none';
}
