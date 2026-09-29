import { type Component, Loader, type TUI, truncateToWidth } from '@earendil-works/pi-tui';
import { cyan } from './style.ts';

/**
 * The chat's working indicator, above the editor or a menu in its place,
 * while a turn runs in the chat whichever channel it came from: `⠋ Working`
 * in the column of the editor's `❯`, with a blank row under it, as Pi draws
 * its own. Nothing while idle.
 */
export class WorkingIndicator implements Component {
  private readonly tui: TUI;
  private spinner: Spinner | null = null;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  setWorking(working: boolean): void {
    if (working === (this.spinner !== null)) return;
    this.spinner?.stop();
    // A Loader turns from the moment it is made, so it exists only while shown.
    this.spinner = working ? new Spinner(this.tui) : null;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (!this.spinner) return [];
    return [truncateToWidth(` ${this.spinner.line()}`, width, ''), ''];
  }

  invalidate(): void {}
}

/** Pi's spinner, drawn as a line of this indicator's own rather than as the Loader lays it out. */
class Spinner extends Loader {
  constructor(ui: TUI) {
    super(ui, cyan, cyan, 'Working');
  }

  line(): string {
    return `${this.getRenderedIndicator()} ${cyan('Working')}`;
  }
}
