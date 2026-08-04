/**
 * annotations — the block layer, written into the document as real PDF
 * annotations.
 *
 * This is what makes the pipeline document-in / document-out at the point where
 * it used to be most file-bound: after `blocks` has decided what every block
 * IS, the answer goes into the PDF as one square annotation per block. Open the
 * working document in any annotation-aware reader and the boxes are there,
 * coloured by category and named by id. Nothing has to be "applied" later, and
 * a user editing those boxes is editing the pipeline's state directly.
 *
 * ## What one annotation carries
 *
 * | key                | what it is                                            |
 * |--------------------|-------------------------------------------------------|
 * | `/Subtype /Square` | a box, which every reader can draw and edit           |
 * | `/Rect`            | the block's box, in PDF user space                    |
 * | `/C`               | the category's colour                                 |
 * | `/NM`              | the block id — the PDF's own "name this annotation"    |
 * | `/T`               | `id category`, so a reader's list says what it is     |
 * | `/Contents`        | the block's TEXT. For a chapter, that text is the title |
 * | `/FoundryCategory` | the category, as a name — the machine-readable one    |
 * | `/FoundrySeq`      | position in the book's reading order                  |
 * | `/FoundryMerged`   | the ids this annotation was merged from, when it was  |
 * | `/FoundryDeleted`  | present and true iff this block is dropped            |
 *
 * Two of those are worth their reasoning:
 *
 *  - **`/FoundrySeq` rather than array order.** Reading order has to survive a
 *    round trip through a reader that rewrote the page's `/Annots` array, and
 *    any of them may. The sequence is therefore stated, not implied, and a
 *    duplicate is an error rather than an arbitrary tiebreak.
 *  - **`/Contents` is the text, and for a chapter it IS the title.** The spec
 *    is explicit: the annotation's text content is the definitive chapter
 *    title. So a user who retypes a mangled heading in a reader has retyped the
 *    chapter title, with no override file anywhere.
 *
 * ## Replacement, never accumulation
 *
 * `writeBlockAnnotations` REMOVES every annotation carrying `/FoundryCategory`
 * and writes the new set, as ONE incremental update. Re-running the blocks
 * stage against a working document must leave the document describing one
 * segmentation — a second run that added a second overlapping layer would give
 * every consumer two answers for the same region and no way to tell which is
 * current. Annotations that are NOT ours (a publisher's links, a reader's
 * highlights) are left exactly as they were.
 */
import {
  PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRef,
} from '@cantoo/pdf-lib';

import { BLOCKS_CATEGORIES_V6, type BlocksCategory } from '../blocks/encoder.js';
import type { Box } from '../scan/bands.js';
import { pxBoxToPtRect, ptRectToPxBox, type PageFrame, type PtRect } from './frame.js';
import { pageAnnots } from './document.js';
import { decodeTextString, textString } from './strings.js';

export class AnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnotationError';
  }
}

const K_CATEGORY = PDFName.of('FoundryCategory');
const K_SEQ = PDFName.of('FoundrySeq');
const K_MERGED = PDFName.of('FoundryMerged');
const K_DELETED = PDFName.of('FoundryDeleted');

/** One block, as the document carries it. Geometry is in the scan's px frame. */
export interface BlockAnnotation {
  id: string;
  /** 0-based page index. */
  page: number;
  /** Position in the book's reading order. Unique across the document. */
  seq: number;
  category: BlocksCategory;
  /** [x0,y0,x1,y1], half-open, top-left origin, px. */
  box: Box;
  /** The block's text. For a `chapter` block this is the chapter's title. */
  text: string;
  /** The block ids this one was merged from, in order. Empty when it is one block. */
  merged: string[];
  /** Dropped from the book. Set by whoever edits the working document. */
  deleted: boolean;
}

// ── the palette ─────────────────────────────────────────────────────────────

/**
 * Colours are DATA, not a decision this program makes.
 *
 * The canonical palette lives in the caller's repository — it is the one a user
 * already sees in the picker, and two palettes would mean the same block is one
 * colour in the app and another in the document it exports. So `--palette`
 * takes it as JSON, and what is below is only what foundry uses when nobody
 * said: distinguishable, and warm for content while furniture is grey.
 */
export const DEFAULT_PALETTE: Readonly<Record<BlocksCategory, string>> = {
  body: '#3b82f6',
  title: '#a855f7',
  chapter: '#8b5cf6',
  heading: '#6366f1',
  subheading: '#818cf8',
  quote: '#14b8a6',
  caption: '#f59e0b',
  footnote: '#ef4444',
  header: '#9ca3af',
  footer: '#9ca3af',
  image: '#ec4899',
  list: '#22c55e',
  discard: '#6b7280',
  table: '#22c55e',
  front_matter: '#94a3b8',
  back_matter: '#94a3b8',
  footnote_ref: '#f87171',
};

export type Palette = Readonly<Record<string, string>>;

/**
 * Read a caller's palette: `{ "body": "#3b82f6", … }`.
 *
 * Strict about both halves. An unknown category means the caller's taxonomy and
 * foundry's have drifted, and a colour nobody can parse means a box drawn in
 * whatever the reader defaults to — which is the same box in a different colour
 * from every other one, i.e. a lie about its category.
 */
export function parsePalette(value: unknown, where: string): Palette {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AnnotationError(`${where}: expected an object of category → "#RRGGBB"`);
  }
  const legal = new Set<string>(BLOCKS_CATEGORIES_V6);
  const out: Record<string, string> = { ...DEFAULT_PALETTE };
  for (const [key, colour] of Object.entries(value as Record<string, unknown>)) {
    if (!legal.has(key)) {
      throw new AnnotationError(
        `${where}: "${key}" is not a block category. Legal categories are: `
        + `${BLOCKS_CATEGORIES_V6.join(', ')}`,
      );
    }
    if (typeof colour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(colour)) {
      throw new AnnotationError(
        `${where}: the colour for "${key}" is ${JSON.stringify(colour)}, and colours are "#RRGGBB"`,
      );
    }
    out[key] = colour;
  }
  return out;
}

/** `#3b82f6` → the three 0..1 components a `/C` array wants. */
export function colourComponents(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// ── writing ─────────────────────────────────────────────────────────────────

/** Is this dictionary one of ours? */
function isOurs(annot: PDFDict): boolean {
  return annot.get(K_CATEGORY) !== undefined;
}

/**
 * Replace foundry's block layer with this one.
 *
 * `mark` is how an incremental update learns which EXISTING objects changed —
 * pdf-lib writes new objects on its own and writes a mutated one only when it
 * is marked (see `src/pdf/document.ts`). Every page whose `/Annots` this
 * touches is marked, and no page it does not touch is.
 */
export function writeBlockAnnotations(
  doc: PDFDocument,
  frames: ReadonlyMap<number, PageFrame>,
  annotations: readonly BlockAnnotation[],
  palette: Palette,
  mark: (target: PDFObject | PDFRef) => void,
): number {
  const pages = doc.getPages();
  const seen = new Set<number>();
  const ids = new Set<string>();
  for (const a of annotations) {
    if (seen.has(a.seq)) {
      throw new AnnotationError(
        `two blocks claim reading position ${a.seq} (the second is ${a.id}). The sequence is what `
        + 'reading order survives on, so it cannot be shared.',
      );
    }
    seen.add(a.seq);
    if (ids.has(a.id)) {
      throw new AnnotationError(`two blocks claim the id ${a.id}. Block ids are keys.`);
    }
    ids.add(a.id);
    if (a.page < 0 || a.page >= pages.length) {
      throw new AnnotationError(
        `block ${a.id} is on page ${a.page + 1}, and the document has ${pages.length} pages.`,
      );
    }
  }

  const byPage = new Map<number, BlockAnnotation[]>();
  for (const a of annotations) {
    const list = byPage.get(a.page);
    if (list) list.push(a); else byPage.set(a.page, [a]);
  }

  let written = 0;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index].node;
    const mine = byPage.get(index) ?? [];
    const { annots, mark: markTarget } = pageAnnots(doc, page);

    // Drop ours, keep everybody else's. Walked backwards because removal
    // shifts the array under the walk.
    let removed = 0;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.lookup(i);
      if (entry instanceof PDFDict && isOurs(entry)) {
        annots.remove(i);
        removed++;
      }
    }
    if (removed === 0 && mine.length === 0) continue;

    const frame = frames.get(index);
    if (mine.length > 0 && frame === undefined) {
      throw new AnnotationError(
        `page ${index + 1} carries ${mine.length} block(s) and no page frame was supplied for it, so `
        + 'their geometry cannot be put into the page\'s own coordinates.',
      );
    }

    for (const a of mine) {
      annots.push(doc.context.register(buildAnnotation(doc, frame!, a, palette)));
      written++;
    }
    mark(markTarget);
  }
  return written;
}

function buildAnnotation(
  doc: PDFDocument, frame: PageFrame, a: BlockAnnotation, palette: Palette,
): PDFDict {
  const hex = palette[a.category];
  if (hex === undefined) {
    throw new AnnotationError(
      `the palette has no colour for category "${a.category}" (block ${a.id}). Every category a `
      + 'block can carry needs one, or the box is drawn in whatever the reader defaults to.',
    );
  }
  const rect = pxBoxToPtRect(frame, a.box);
  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: rect as unknown as number[],
    // Print, so the layer is part of the document rather than a screen overlay.
    F: 4,
    C: colourComponents(hex),
    BS: { W: 1, S: 'S' },
    NM: textString(a.id),
    T: textString(`${a.id} ${a.category}`),
    Contents: textString(a.text),
  });
  dict.set(K_CATEGORY, PDFName.of(a.category));
  dict.set(K_SEQ, PDFNumber.of(a.seq));
  if (a.merged.length > 0) {
    dict.set(K_MERGED, doc.context.obj(a.merged.map(id => textString(id))));
  }
  if (a.deleted) dict.set(K_DELETED, PDFBool.True);
  return dict;
}

// ── reading ─────────────────────────────────────────────────────────────────

const LEGAL_CATEGORIES = new Set<string>(BLOCKS_CATEGORIES_V6);

/**
 * Read foundry's block layer back out, in reading order.
 *
 * Every failure here is a stop that names the annotation, because this is a
 * document somebody else may have edited: a reader that dropped a key, a script
 * that wrote an unknown category, two blocks with the same sequence. Guessing
 * past any of them produces a book with a paragraph in the wrong place and no
 * evidence of why.
 */
export function readBlockAnnotations(
  doc: PDFDocument, frames: ReadonlyMap<number, PageFrame>,
): BlockAnnotation[] {
  const pages = doc.getPages();
  const out: BlockAnnotation[] = [];
  for (let index = 0; index < pages.length; index++) {
    const raw = pages[index].node.Annots();
    if (!(raw instanceof PDFArray)) continue;
    const frame = frames.get(index);
    for (let i = 0; i < raw.size(); i++) {
      const annot = raw.lookup(i);
      if (!(annot instanceof PDFDict) || !isOurs(annot)) continue;
      if (frame === undefined) {
        throw new AnnotationError(`page ${index + 1} carries block annotations and no page frame`);
      }
      out.push(readOne(annot, index, frame));
    }
  }

  const bySeq = new Map<number, string>();
  for (const a of out) {
    const prior = bySeq.get(a.seq);
    if (prior !== undefined) {
      throw new AnnotationError(
        `blocks ${prior} and ${a.id} both claim reading position ${a.seq}. Reading order is what the `
        + 'book is assembled in, and there is no honest way to pick between two blocks that claim '
        + 'the same place — re-run `foundry blocks` against this document.',
      );
    }
    bySeq.set(a.seq, a.id);
  }
  out.sort((p, q) => p.seq - q.seq);
  return out;
}

function readOne(annot: PDFDict, page: number, frame: PageFrame): BlockAnnotation {
  const where = `page ${page + 1}`;
  const category = annot.lookup(K_CATEGORY);
  const name = category instanceof PDFName ? category.decodeText() : '';
  if (!LEGAL_CATEGORIES.has(name)) {
    throw new AnnotationError(
      `${where}: a block annotation declares category "${name}", which is not one of `
      + `${BLOCKS_CATEGORIES_V6.join(', ')}`,
    );
  }
  const seq = annot.lookup(K_SEQ);
  if (!(seq instanceof PDFNumber)) {
    throw new AnnotationError(
      `${where}: a block annotation has no /FoundrySeq, so its place in the book's reading order is `
      + 'unknown. It was written by something other than this build of foundry.',
    );
  }
  const id = decodeTextString(annot.lookup(PDFName.of('NM')));
  if (id === null) {
    throw new AnnotationError(`${where}: a block annotation has no /NM, which carries the block id`);
  }
  const rect = annot.lookup(PDFName.of('Rect'));
  if (!(rect instanceof PDFArray) || rect.size() !== 4) {
    throw new AnnotationError(`${where}: block ${id} has no four-number /Rect`);
  }
  const numbers = [0, 1, 2, 3].map(i => {
    const n = rect.lookup(i);
    if (!(n instanceof PDFNumber)) {
      throw new AnnotationError(`${where}: block ${id} has a /Rect entry that is not a number`);
    }
    return n.asNumber();
  }) as PtRect;
  const merged = annot.lookup(K_MERGED);
  const mergedIds: string[] = [];
  if (merged instanceof PDFArray) {
    for (let i = 0; i < merged.size(); i++) {
      const member = decodeTextString(merged.lookup(i));
      if (member === null) {
        throw new AnnotationError(`${where}: block ${id} has a /FoundryMerged entry that is not a string`);
      }
      mergedIds.push(member);
    }
  }
  return {
    id,
    page,
    seq: seq.asNumber(),
    category: name as BlocksCategory,
    box: ptRectToPxBox(frame, normalizeRect(numbers)),
    text: decodeTextString(annot.lookup(PDFName.of('Contents'))) ?? '',
    merged: mergedIds,
    deleted: annot.lookup(K_DELETED) === PDFBool.True,
  };
}

/**
 * A `/Rect` is a pair of opposite corners in either order — the spec says so,
 * and readers that let a user drag a box out produce the other order routinely.
 */
function normalizeRect(rect: PtRect): PtRect {
  const [x0, y0, x1, y1] = rect;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}
