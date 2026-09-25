import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { Container, type SelectItem, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import { bold, dim } from './style.ts';

/**
 * A menu in the terminal: its text, then its options, chosen with the arrow
 * keys and Enter, or dismissed with Escape. It takes the editor's place while
 * it is open. Both the core's menus (a model switch, a question from the
 * agent) and the terminal's own (/jobs) are pickers.
 */

export interface PickerOptions {
  title: string;
  options: string[];
  /** Adds a Cancel option; Escape then chooses it. */
  cancellable: boolean;
  onSelect(index: number): void;
  /** Escape, or Cancel. */
  onCancel(): void;
}

const CANCEL = 'cancel';
const MAX_VISIBLE = 10;

export class Picker extends Container {
  private readonly list: SelectList;

  constructor(options: PickerOptions) {
    super();
    const items: SelectItem[] = options.options.map((label, index) => ({
      value: String(index),
      label,
    }));
    if (options.cancellable) items.push({ value: CANCEL, label: 'Cancel' });
    this.list = new SelectList(items, Math.min(items.length, MAX_VISIBLE), getSelectListTheme());
    this.list.onSelect = (item) => {
      if (item.value === CANCEL) options.onCancel();
      else options.onSelect(Number(item.value));
    };
    this.list.onCancel = () => options.onCancel();
    this.addChild(new Text(bold(options.title), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Text(dim('↑↓ choose · Enter select · Esc dismiss'), 1, 0));
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}
