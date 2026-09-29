import {
  type Component,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { type Band, dim, italic, PROMPT_MARK } from './style.ts';

/**
 * What someone typed, as the chat shows it: a `❯` and the text beside it,
 * wrapped under itself, on a band of background across the width, so a
 * prompt stands out in the scrollback without a padded box around it. Input
 * from another channel says where it came from ahead of the text. Keeps the
 * OSC 133 marks Pi's own prompt has, so a terminal can still jump from prompt
 * to prompt.
 */

const PROMPT_START = '\x1b]133;A\x07';
const PROMPT_END = '\x1b]133;B\x07\x1b]133;C\x07';

export class UserPrompt implements Component {
  private readonly text: string;
  private readonly from: string | null;
  private band: Band;
  private cache: { width: number; lines: string[] } | null = null;

  /** `from` names the channel it was typed in, when that was not this terminal. */
  constructor(text: string, from: string | null, band: Band) {
    this.text = stripTerminalSequences(text).replace(/\r/g, '').replace(/\t/g, '   ').trim();
    this.from = from;
    this.band = band;
  }

  setBand(band: Band): void {
    this.band = band;
    this.invalidate();
  }

  invalidate(): void {
    this.cache = null;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const label = this.from ? `${dim(italic(`${this.from}:`))} ` : '';
    // A column either side, and the marker's two.
    const rows = wrapTextWithAnsi(`${label}${this.text}`, Math.max(1, width - 4));
    const lines = (rows.length ? rows : ['']).map((row, index) => {
      const line = ` ${index === 0 ? PROMPT_MARK : ' '} ${this.band.text(row)}`;
      return this.band.bg(`${line}${' '.repeat(Math.max(0, width - visibleWidth(line)))}`);
    });
    lines[0] = `${PROMPT_START}${lines[0]}`;
    lines[lines.length - 1] = `${lines[lines.length - 1]}${PROMPT_END}`;
    this.cache = { width, lines };
    return lines;
  }
}
