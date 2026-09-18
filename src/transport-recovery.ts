const TRANSIENT_TRANSPORT_ERROR = new RegExp(
  [
    'websocket(?:\\s+connection)?\\s+(?:error|closed|failed)',
    'network\\s+error',
    'connection\\s+(?:error|lost|refused|reset|closed)',
    'socket\\s+(?:hang\\s+up|connection\\s+was\\s+closed)',
    'fetch\\s+failed',
    'other\\s+side\\s+closed',
    'reset\\s+before\\s+headers',
    'stream\\s+ended\\s+(?:without|before)',
    'http2\\s+request\\s+did\\s+not\\s+get\\s+a\\s+response',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
  ].join('|'),
  'i',
);

const DO_NOT_RECOVER =
  /abort|cancel|auth|unauthori[sz]ed|forbidden|invalid.api.key|quota|billing|usage.limit|rate.?limit|too.many.requests|context.(?:length|window)|overflow/i;

/** Strict fallback classifier used only after the SDK's own retry budget is exhausted. */
export function isTransientTransportError(message: string): boolean {
  return !DO_NOT_RECOVER.test(message) && TRANSIENT_TRANSPORT_ERROR.test(message);
}

/** A new user turn resumes from persisted context without replaying the original prompt. */
export const TRANSPORT_RECOVERY_PROMPT = `[Automatic transport recovery]
The previous model stream ended because of a transient connection failure. Continue the current task from the conversation and tool results already present. Do not repeat completed side-effecting actions. Verify existing state before any additional edit, command, upload, message, restart, or other side effect. Finish the task and provide the response that was interrupted.`;

export function waitForTransportRecovery(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
