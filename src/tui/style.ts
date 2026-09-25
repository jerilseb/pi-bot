/**
 * The terminal's own text styles, for what Pi's components do not draw: notes,
 * the footer, job lines, menus. Plain SGR codes, each closed by its own reset,
 * so a style never leaks into the next and nests inside another.
 */

const sgr =
  (open: number, close: number) =>
  (text: string): string =>
    `\x1b[${open}m${text}\x1b[${close}m`;

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const cyan = sgr(36, 39);
export const gray = sgr(90, 39);

/** The color of a notice, by how serious it is. */
export function levelColor(level: 'info' | 'warn' | 'error'): (text: string) => string {
  if (level === 'error') return red;
  if (level === 'warn') return yellow;
  return (text) => text;
}
