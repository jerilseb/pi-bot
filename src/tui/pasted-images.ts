import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Attachment } from '../types.ts';

/**
 * Images pasted into the editor as `[Image N]`, as Claude Code shows them. A
 * terminal pastes a copied or dropped file as its path; when everything pasted
 * is the path of an image on this machine, the editor takes the images and the
 * text gets a marker for each. The marker is the image's place in the message:
 * it goes to the model as written, beside the image, and deleting it drops the
 * image.
 */

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MARKER = /\[Image (\d+)\]/g;

export function imageMarker(n: number): string {
  return `[Image ${n}]`;
}

/**
 * The absolute paths a paste names, if it is nothing but image files that
 * exist: one per line, or separated by spaces with quotes or backslashes
 * around the spaces in a name, as terminals drop files; `file://` URIs and `~`
 * included. Null for anything else, which is pasted as text.
 */
export function pastedImagePaths(
  pasted: string,
  isFile: (file: string) => boolean = isRegularFile,
): string[] | null {
  const words = shellWords(pasted.trim());
  if (!words || words.length === 0) return null;
  const paths: string[] = [];
  for (const word of words) {
    const file = localPath(word);
    if (!file || !IMAGE_TYPES[path.extname(file).toLowerCase()] || !isFile(file)) return null;
    paths.push(file);
  }
  return paths;
}

/** The attachment for an image file, its type from its extension. */
export function imageAttachment(file: string): Attachment {
  return {
    type: 'image',
    path: file,
    filename: path.basename(file),
    mimeType: IMAGE_TYPES[path.extname(file).toLowerCase()] ?? 'image/png',
  };
}

/**
 * The message as it is sent: the images whose markers are still in the text,
 * in the order the text names them, and the markers numbered 1, 2, … in that
 * order, so the text and the images the model sees agree. A marker for no
 * pasted image is left as text.
 */
export function resolveImageMarkers(
  text: string,
  images: ReadonlyMap<number, Attachment>,
): { text: string; attachments: Attachment[] } {
  const renumbered = new Map<number, number>();
  const attachments: Attachment[] = [];
  const resolved = text.replace(MARKER, (marker, digits: string) => {
    const n = Number(digits);
    const image = images.get(n);
    if (!image) return marker;
    let next = renumbered.get(n);
    if (next === undefined) {
      attachments.push(image);
      next = attachments.length;
      renumbered.set(n, next);
    }
    return imageMarker(next);
  });
  return { text: resolved, attachments };
}

/** Where in a text the `[Image N]` markers are whose N is one of the images. */
export function imageMarkerSpans(
  text: string,
  isImage: (n: number) => boolean,
): Array<{ start: number; end: number }> {
  return Array.from(text.matchAll(MARKER))
    .filter((match) => isImage(Number(match[1])))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** The numbers of the `[Image N]` markers in a text. */
export function markedImages(text: string): Set<number> {
  return new Set(Array.from(text.matchAll(MARKER), (match) => Number(match[1])));
}

function localPath(word: string): string | null {
  let file = word;
  if (file.startsWith('file://')) {
    try {
      file = decodeURIComponent(new URL(file).pathname);
    } catch {
      return null;
    }
  }
  if (file === '~' || file.startsWith('~/')) file = path.join(os.homedir(), file.slice(1));
  return path.isAbsolute(file) ? path.normalize(file) : null;
}

/** Words split on whitespace, with quotes and backslash escapes as a shell reads them; null if a quote is left open. */
function shellWords(text: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\' && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
