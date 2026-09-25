import { Editor, Loader, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { cyan } from './style.ts';

/**
 * The editor, with the chat's working indicator drawn into its top border
 * while a turn runs, as Pi's own editor draws it: `── ⠋ Working ───`. The
 * spinner turns only while it is shown. While the text overflows, the
 * editor's own `↑ n more` has the border instead.
 */
export class WorkingEditor extends Editor {
  private spinner: BorderSpinner | null = null;

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

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (!this.spinner || hiddenLineCount > 0 || width < 3) {
      return super.renderTopBorder(width, hiddenLineCount);
    }
    const label = this.spinner.label();
    const labelWidth = visibleWidth(label);
    if (width >= labelWidth + 5) {
      return `${this.borderColor('── ')}${label}${this.borderColor(` ${'─'.repeat(width - labelWidth - 4)}`)}`;
    }
    // Too narrow for the word: the spinner alone.
    const frame = truncateToWidth(this.spinner.frame(), width - 1, '');
    return `${this.borderColor('─')}${frame}${this.borderColor('─'.repeat(Math.max(0, width - 1 - visibleWidth(frame))))}`;
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
