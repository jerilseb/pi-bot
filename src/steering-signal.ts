import type { SessionKind } from './types.ts';

/**
 * Tells a tool that is blocking the agent's turn that the user just sent a
 * message into it.
 *
 * A steered message reaches the agent only after its current tool call
 * returns, so a tool that waits minutes (background_bash_wait) would hold the
 * user's message for all of that time. SdkPiSession fires this once the SDK has
 * accepted a steered message; a waiting tool listens for its own session and
 * returns at once, and the message follows its result.
 *
 * Module-level on purpose, like the job registries: the waits and the session
 * that steers them are wired in different places, and there is one bot process.
 */

type Listener = () => void;

const listeners = new Map<SessionKind, Set<Listener>>();

/** Calls listener each time a message is steered into `session`. Returns an unsubscribe. */
export function onSteeringMessage(session: SessionKind, listener: Listener): () => void {
  let set = listeners.get(session);
  if (!set) {
    set = new Set();
    listeners.set(session, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export function notifySteeringMessage(session: SessionKind): void {
  for (const listener of [...(listeners.get(session) ?? [])]) {
    try {
      listener();
    } catch (error) {
      console.error('steering listener failed:', error);
    }
  }
}
