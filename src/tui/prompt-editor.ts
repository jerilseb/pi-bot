import { Editor } from '@earendil-works/pi-tui';
import { imageMarkerSpans } from './pasted-images.ts';
import { PROMPT_MARK } from './style.ts';

/** The editor: a line above and below, and a `❯` before the text. */

/** In the column the chat's prompts have theirs, so what is typed lines up with the prompt it becomes. */
const PROMPT = ` ${PROMPT_MARK} `;
/** Columns the `❯` and the space either side take, which every row of text and menu is indented by. */
const GUTTER = 3;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Pi's editor's own segmenting, private there: what it moves over and deletes as one character. */
interface Segmenting {
  segment(text: string, mode: 'grapheme' | 'word'): Iterable<Intl.SegmentData>;
}

export class PromptEditor extends Editor {
  /**
   * Offered each paste before it becomes text: true if it took the paste, as
   * the app does with the paths of images, which it marks `[Image N]`.
   */
  onPaste?: (text: string) => boolean;
  /** Whether an `[Image N]` stands for an image, and so is moved over and deleted whole. */
  isImageMarker?: (n: number) => boolean;
  /** A bracketed paste still arriving, or null between pastes. */
  private pasting: string | null = null;
  /** The gutter this render draws: none when the width leaves no room for text beside it. */
  private gutter = 0;
  /** The bottom border this render drew, which ends the rows of text. */
  private bottomBorder = '';

  constructor(...args: ConstructorParameters<typeof Editor>) {
    super(...args);
    // Pi's editor keeps its `[paste #N]` markers whole by segmenting each into
    // one character; an image's marker is merged the same way, so Backspace,
    // Delete and the arrows take it whole, and one undo brings it back.
    const editor = this as unknown as Segmenting;
    const segment = editor.segment.bind(this);
    editor.segment = (text, mode) => {
      const segments = segment(text, mode);
      const spans = this.isImageMarker ? imageMarkerSpans(text, this.isImageMarker) : [];
      return spans.length > 0 ? mergeSpans(segments, spans, text) : segments;
    };
  }

  /**
   * Holds a bracketed paste until it has all arrived and offers it to
   * onPaste; one that is not taken goes to the editor whole, as it came.
   */
  override handleInput(data: string): void {
    if (this.pasting === null) {
      const start = data.indexOf(PASTE_START);
      if (start === -1 || !this.onPaste) {
        super.handleInput(data);
        return;
      }
      if (start > 0) super.handleInput(data.slice(0, start));
      this.pasting = '';
      data = data.slice(start + PASTE_START.length);
    }
    this.pasting += data;
    const end = this.pasting.indexOf(PASTE_END);
    if (end === -1) return;
    const pasted = this.pasting.slice(0, end);
    const rest = this.pasting.slice(end + PASTE_END.length);
    this.pasting = null;
    if (!this.onPaste?.(pasted)) super.handleInput(`${PASTE_START}${pasted}${PASTE_END}`);
    if (rest) this.handleInput(rest);
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
    return super.renderTopBorder(width + this.gutter, hiddenLineCount);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width + this.gutter, hiddenLineCount);
    return this.bottomBorder;
  }
}

/** The segments with each span's merged into one, as Pi merges its paste markers. */
function mergeSpans(
  segments: Iterable<Intl.SegmentData>,
  spans: Array<{ start: number; end: number }>,
  text: string,
): Intl.SegmentData[] {
  const merged: Intl.SegmentData[] = [];
  for (const segment of segments) {
    const span = spans.find(({ start, end }) => segment.index >= start && segment.index < end);
    if (!span) merged.push(segment);
    else if (segment.index === span.start) {
      merged.push({ segment: text.slice(span.start, span.end), index: span.start, input: text });
    }
  }
  return merged;
}
