import { Editor, Loader, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { cyan, PROMPT_MARK } from './style.ts';

/**
 * The editor: a line above and below, a `❯` before the text, and the chat's
 * working indicator drawn into its top border while a turn runs, as Pi's own
 * editor draws it: `── ⠋ Working ───`. The spinner turns only while it is
 * shown. While the text overflows, the editor's own `↑ n more` has the border
 * instead.
 */

/** In the column the chat's prompts have theirs, so what is typed lines up with the prompt it becomes. */
const PROMPT = ` ${PROMPT_MARK} `;
/** Columns the `❯` and the space either side take, which every row of text and menu is indented by. */
const GUTTER = 3;

export class WorkingEditor extends Editor {
  private spinner: BorderSpinner | null = null;
  /** The gutter this render draws: none when the width leaves no room for text beside it. */
  private gutter = 0;
  /** The bottom border this render drew, which ends the rows of text. */
  private bottomBorder = '';

  get working(): boolean {
    return this.spinner !== null;
  }

  setWorking(working: boolean): void {
    if (working === this.working) return;
    this.spinner?.stop();
    // A Loader starts turning as it is made.
    this.spinner = working ? new BorderSpinner(this.tui) : null;
    this.tui.requestRender();
  }

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
    const full = width + this.gutter;
    if (!this.spinner || hiddenLineCount > 0 || full < 3) {
      return super.renderTopBorder(full, hiddenLineCount);
    }
    const label = this.spinner.label();
    const labelWidth = visibleWidth(label);
    if (full >= labelWidth + 5) {
      return `${this.borderColor('── ')}${label}${this.borderColor(` ${'─'.repeat(full - labelWidth - 4)}`)}`;
    }
    // Too narrow for the word: the spinner alone.
    const frame = truncateToWidth(this.spinner.frame(), full - 1, '');
    return `${this.borderColor('─')}${frame}${this.borderColor('─'.repeat(Math.max(0, full - 1 - visibleWidth(frame))))}`;
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width + this.gutter, hiddenLineCount);
    return this.bottomBorder;
  }
}

/** Pi's spinner, drawn into a border rather than as a line of its own. */
class BorderSpinner extends Loader {
  constructor(ui: TUI) {
    super(ui, cyan, cyan, 'Working');
  }

  frame(): string {
    return this.getRenderedIndicator();
  }

  label(): string {
    return `${this.getRenderedIndicator()} ${cyan('Working')}`;
  }
}
