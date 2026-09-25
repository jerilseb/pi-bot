import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tool calls described as plain text: the tool and its first argument, the
 * way every interface shows them. Each channel adds its own icons and markup.
 */

/**
 * A tool call as one line of plain text, e.g. `read (~/Code/pi-bot/src/cron.ts)`:
 * the tool and its first argument, as the 🛠 note shows them but without the
 * icon or markup. Used for what a sub-agent worker is doing now.
 */
export function describeToolCall(toolName: string, args: unknown): string {
  const firstArgument = formatFirstToolArgument(args);
  return firstArgument ? `${toolName} (${firstArgument})` : toolName;
}

/** The first argument of a tool call on one line, with the home directory as `~`. */
export function formatFirstToolArgument(args: unknown): string | null {
  const firstArgument = extractFirstToolArgument(args);
  if (!firstArgument) return null;

  return formatToolArgumentValue(firstArgument.value);
}

function extractFirstToolArgument(args: unknown): { name?: string; value: unknown } | null {
  if (args === null || args === undefined) return null;
  if (Array.isArray(args)) {
    return args.length > 0 ? { value: args[0] } : null;
  }
  if (typeof args !== 'object') return { value: args };

  const [firstEntry] = Object.entries(args as Record<string, unknown>);
  if (!firstEntry) return null;

  const [name, value] = firstEntry;
  return { name, value };
}

function formatToolArgumentValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value.trim() ? value : JSON.stringify(value);
  } else if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'undefined'
  ) {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const compacted = text.replace(/\s+/g, ' ').trim();
  return abbreviateHomePath(compacted || text);
}

function abbreviateHomePath(value: string): string {
  const homeDir = os.homedir();
  if (!homeDir) return value;

  const normalizedHomeDir = path.normalize(homeDir);
  const escapedHomeDir = normalizedHomeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`${escapedHomeDir}(?=$|/)`, 'g'), '~');
}
