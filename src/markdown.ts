/**
 * Helpers for writing Markdown, the format the core's own text is in. Every
 * channel renders Markdown its own way, so text from outside (an error, a
 * model name, a menu label) is escaped before it goes into a message.
 */

/**
 * `text` with every Markdown-significant character backslash-escaped, so it
 * shows exactly as written. CommonMark allows escaping any ASCII punctuation,
 * so escaping generously never changes what is shown.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, '\\$&');
}

/** `text` as an inline code span, fenced with enough backticks to hold any it contains. */
export function markdownCode(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  // CommonMark strips one space from each end, and a backtick there would merge with the fence.
  const padded = /^[` ]|[` ]$/.test(text) ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/** `text` as a fenced code block, fenced so no line of it can close the block early. */
export function markdownCodeBlock(text: string, language = ''): string {
  const longestRun = Math.max(2, ...[...text.matchAll(/^`{3,}/gm)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** `lines` as a Markdown quote, one quoted line each. */
export function markdownQuote(lines: string[]): string {
  return lines.map((line) => `> ${line}`).join('\n');
}
