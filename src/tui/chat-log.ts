import type { Component } from '@earendil-works/pi-tui';

/** What a block of the chat is, which decides the space before it. */
export type BlockKind = 'prompt' | 'reply' | 'tool' | 'note';

/**
 * The chat's blocks in order, a blank row between each two that show
 * something, except in a run of tool calls, which stack. A block that draws
 * nothing, such as a reply that is only hidden thinking, takes no room.
 */
export class ChatLog implements Component {
  private blocks: Array<{ kind: BlockKind; component: Component }> = [];

  add(kind: BlockKind, component: Component): void {
    this.blocks.push({ kind, component });
  }

  clear(): void {
    this.blocks = [];
  }

  invalidate(): void {
    for (const { component } of this.blocks) component.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    let previous: BlockKind | null = null;
    for (const { kind, component } of this.blocks) {
      const rows = component.render(width);
      if (rows.length === 0) continue;
      if (previous !== null && !(previous === 'tool' && kind === 'tool')) lines.push('');
      lines.push(...rows);
      previous = kind;
    }
    return lines;
  }
}
