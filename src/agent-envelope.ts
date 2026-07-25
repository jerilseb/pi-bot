/**
 * Shared builder for the internal prompts the bot sends itself.
 *
 * Five flows hand work to the chat agent without a user typing anything:
 * heartbeat runs (src/heartbeat.ts), scheduled tasks (src/cron.ts), post-restart
 * tasks (main.ts), and completion reports from sub-agents (src/subagents.ts) and
 * background bash sessions (src/background-bash.ts). They all need the same
 * thing: say what kind of run this is, carry some metadata, quote a body the
 * agent must not confuse with user input, then state what to send back.
 *
 * Keeping that layout here means the convention — how instructions are fenced,
 * how metadata reads, how a "nothing to report" reply is requested — is defined
 * once instead of drifting across five files.
 */

/** A labelled block of the envelope body, optionally fenced in a tag. */
export interface EnvelopeSection {
  /** Line introducing the block, e.g. 'Result:' or 'Run these instructions now:'. */
  intro: string;
  body: string;
  /** When set, fences body in <tag>…</tag> so the agent cannot mistake it for instructions of its own. */
  tag?: string;
  /** Used when body is blank, e.g. '(no output)'. */
  fallback?: string;
}

export interface AgentEnvelope {
  /** Opening line naming the kind of run, e.g. 'This is a scheduled heartbeat run…'. */
  preamble: string;
  /** `Label: value` lines rendered directly under the preamble. Blank values are dropped. */
  meta?: Array<[label: string, value: string | null | undefined]>;
  sections: EnvelopeSection[];
  /** Closing lines telling the agent what to do and what to send the user. */
  guidance?: string[];
  /** When set, appends the standard "respond exactly <sentinel>" line after the guidance. */
  noopSentinel?: string;
}

/**
 * Requests a no-op reply. One wording for every caller, so src/outbound.ts has a
 * single phrasing to suppress. Matching is on the sentinel itself, so this text
 * is free to change.
 */
function noopInstruction(sentinel: string): string {
  return `If there is nothing user-visible to report, respond exactly: ${sentinel}`;
}

export function buildAgentEnvelope(envelope: AgentEnvelope): string {
  const lines: string[] = [envelope.preamble];

  for (const [label, value] of envelope.meta ?? []) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${label}: ${value}`);
  }

  for (const section of envelope.sections) {
    const body = section.body.trim() || (section.fallback ?? '');
    lines.push('', section.intro);
    if (section.tag) {
      lines.push(`<${section.tag}>`, body, `</${section.tag}>`);
    } else {
      lines.push(body);
    }
  }

  const guidance = [...(envelope.guidance ?? [])];
  if (envelope.noopSentinel) {
    guidance.push(noopInstruction(envelope.noopSentinel));
  }
  if (guidance.length > 0) {
    lines.push('', ...guidance);
  }

  return lines.join('\n');
}
