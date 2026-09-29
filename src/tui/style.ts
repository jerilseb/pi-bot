import type { RgbColor } from '@earendil-works/pi-tui';

/**
 * The terminal's own text styles, for everything but the model's Markdown:
 * the chat's rows, notes, the footer, job lines, menus. Plain SGR codes, each
 * closed by its own reset, so a style never leaks into the next and nests
 * inside another.
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

/** The mark before a prompt, in the editor and in the chat alike. */
export const PROMPT_MARK = cyan(bold('❯'));

/** A band of background colour, and the colour of the text on it. */
export interface Band {
  bg: (text: string) => string;
  text: (text: string) => string;
}

/** Pi's own prompt colours (its dark theme's), for a terminal that does not say its background. */
const PI_PROMPT_BG: RgbColor = { r: 0x34, g: 0x35, b: 0x41 };
const PI_PROMPT_TEXT: RgbColor = { r: 0xd4, g: 0xd4, b: 0xd4 };
/** How far a band moves from the terminal's background: toward white on a dark one, black on a light one. */
const LIGHTEN = 0.13;
const DARKEN = 0.07;

/**
 * The band behind a prompt: the terminal's own background a shade lighter, or
 * darker on a light one, so the text keeps the terminal's colour and the band
 * suits whatever theme it has. Without the background, Pi's own prompt
 * colours, text and band both, which read on a dark terminal or a light one.
 */
export function promptBand(background: RgbColor | null, trueColor: boolean): Band {
  if (!background) {
    return {
      bg: color(48, PI_PROMPT_BG, trueColor, 49),
      text: color(38, PI_PROMPT_TEXT, trueColor, 39),
    };
  }
  return { bg: color(48, shade(background), trueColor, 49), text: (text) => text };
}

function shade({ r, g, b }: RgbColor): RgbColor {
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 >= 0.5;
  const move = (c: number): number =>
    Math.round(light ? c * (1 - DARKEN) : c + (255 - c) * LIGHTEN);
  return { r: move(r), g: move(g), b: move(b) };
}

function color(
  open: 38 | 48,
  rgb: RgbColor,
  trueColor: boolean,
  close: 39 | 49,
): (text: string) => string {
  const code = trueColor ? `2;${rgb.r};${rgb.g};${rgb.b}` : `5;${to256(rgb)}`;
  return (text) => `\x1b[${open};${code}m${text}\x1b[${close}m`;
}

/** The nearest colour of the 256-colour palette: its 6×6×6 cube or its grey ramp. */
function to256({ r, g, b }: RgbColor): number {
  const step = (c: number): number => (c < 48 ? 0 : c < 115 ? 1 : Math.floor((c - 35) / 40));
  const level = (i: number): number => (i === 0 ? 0 : 55 + i * 40);
  const [ri, gi, bi] = [step(r), step(g), step(b)];
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const distance = (c: RgbColor): number => (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
  const greyLevel = 8 + grey * 10;
  return distance({ r: greyLevel, g: greyLevel, b: greyLevel }) <
    distance({ r: level(ri), g: level(gi), b: level(bi) })
    ? 232 + grey
    : 16 + 36 * ri + 6 * gi + bi;
}

/** The color of a notice, by how serious it is. */
export function levelColor(level: 'info' | 'warn' | 'error'): (text: string) => string {
  if (level === 'error') return red;
  if (level === 'warn') return yellow;
  return (text) => text;
}
