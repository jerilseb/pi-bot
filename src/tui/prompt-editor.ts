import { Editor } from '@earendil-works/pi-tui';
import { PROMPT_MARK } from './style.ts';

/** The editor: a line above and below, and a `❯` before the text. */

/** In the column the chat's prompts have theirs, so what is typed lines up with the prompt it becomes. */
const PROMPT = ` ${PROMPT_MARK} `;
/** Columns the `❯` and the space either side take, which every row of text and menu is indented by. */
const GUTTER = 3;

export class PromptEditor extends Editor {
  /** The gutter this render draws: none when the width leaves no room for text beside it. */
  private gutter = 0;
  /** The bottom border this render drew, which ends the rows of text. */
  private bottomBorder = '';

  /**
   * The editor's own rendering, narrower by the gutter, with the `❯` put in
   * front of the first row of text and the rest indented to match. Its
   * borders are drawn the whole width.
   */
  override render(width: number): string[] {
    this.gutter = width > GUTTER + 1 ? GUTTER : 0;
    const lines = super.render(width - this.gutter);
    if (!this.gutter) return lines;
    const bottom = lines.indexOf(this.bottomBorder, 1);
    return lines.map((line, index) => {
      if (index === 0 || index === bottom) return line;
      return `${index === 1 ? PROMPT : ' '.repeat(GUTTER)}${line}`;
    });
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return super.renderTopBorder(width + this.gutter, hiddenLineCount);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width + this.gutter, hiddenLineCount);
    return this.bottomBorder;
  }
}
