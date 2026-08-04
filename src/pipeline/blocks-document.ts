/**
 * blocks-document — the classified blocks, written into the working PDF.
 *
 * `blocks` decides what every block IS. In document mode that answer goes into
 * the document, as one square annotation per block: coloured by category, named
 * by id, carrying the block's text. Open the working PDF in any annotation-aware
 * reader and the layer is there; edit a box or retype a heading and you have
 * edited the pipeline's state, with no side file to keep in step.
 *
 * ## The display merge
 *
 * Block formation is a geometric rule and it cannot see that
 * "Nationalism, Nazism, and" / "the Churches:" / "The Early Period" is ONE
 * chapter heading — `mergeDisplayRuns` catches most of it from geometry alone,
 * before anything is classified, but a run it declined and the model then
 * labelled `chapter` end to end is still three chapters as far as the exporter
 * is concerned. So adjacent blocks of the same DISPLAY category, on the same
 * page, with nothing between them and no more than a paragraph's advance
 * separating them, are merged before they are written.
 *
 * Only `chapter` and `title`. They are the two categories that open a spine
 * item, so a false split there costs a phantom chapter in the table of contents,
 * while merging two `body` blocks would silently weld two paragraphs — and the
 * paragraph grouper, which runs later and knows the calibration, is the thing
 * that decides that junction properly.
 *
 * The merge is recorded rather than performed silently: the surviving
 * annotation carries `/FoundryMerged` listing every id it was made from, so the
 * two blocks the model actually answered for can still be identified.
 */
import { PDFDocument } from '@cantoo/pdf-lib';

import type { BlocksCategory } from '../blocks/encoder.js';
import { joinLines } from '../export/linejoin.js';
import { attestationFromLines } from '../paragraphs/hyphen.js';
import type { Box } from '../scan/bands.js';
import {
  readBlockAnnotations, writeBlockAnnotations, type BlockAnnotation, type Palette,
} from '../pdf/annotations.js';
import { WorkingPdf } from '../pdf/document.js';
import type { PageFrame } from '../pdf/frame.js';
import type { ScanLine, ScanPage } from './artifacts.js';

export class BlocksDocumentError extends Error {
  constructor(message: string) {
    super(`blocks: ${message}`);
    this.name = 'BlocksDocumentError';
  }
}

/** The categories a false split costs a chapter, so the ones worth rejoining. */
export const DISPLAY_CATEGORIES: ReadonlySet<BlocksCategory> =
  new Set<BlocksCategory>(['chapter', 'title']);

/**
 * How far apart two pieces of one heading may sit, in the book's own line
 * pitch.
 *
 * A display heading set over two or three lines is separated by its own
 * leading, which is at most a little more than the body's. Two points at 1.6
 * pitches: the gap between the lines of one heading, and the gap between a
 * heading and the next thing on the page, are not the same measurement in any
 * book this pipeline has seen — a chapter opening puts white space under its
 * title on purpose.
 */
export const MERGE_MAX_ADVANCE = 1.6;

/** What this module needs to know about a classified block. */
export interface ClassifiedBlock {
  id: string;
  page: number;
  bbox: Box;
  lineIds: string[];
  category: BlocksCategory;
}

/**
 * Merge the adjacent pieces of one display heading.
 *
 * Adjacency is in READING ORDER, which is the order the blocks arrive in:
 * "nothing between them" is exactly "they are neighbours in this list". A
 * heading interrupted by a folio or a running head is therefore not merged, and
 * that is correct — the pieces are not adjacent on the page either.
 */
export function mergeDisplayCategories(
  blocks: readonly ClassifiedBlock[], pitchPx: number,
): { blocks: ClassifiedBlock[]; merged: Map<string, string[]> } {
  const out: ClassifiedBlock[] = [];
  const merged = new Map<string, string[]>();

  let i = 0;
  while (i < blocks.length) {
    const lead = blocks[i];
    if (!DISPLAY_CATEGORIES.has(lead.category)) {
      out.push(lead);
      i++;
      continue;
    }

    const run: ClassifiedBlock[] = [lead];
    let j = i + 1;
    while (j < blocks.length) {
      const next = blocks[j];
      const prev = run[run.length - 1];
      if (next.category !== lead.category || next.page !== prev.page) break;
      const advance = next.bbox[1] - prev.bbox[3];
      if (advance > MERGE_MAX_ADVANCE * pitchPx) break;
      // Two headings side by side in two columns are not one heading.
      const overlaps = next.bbox[0] < prev.bbox[2] && next.bbox[2] > prev.bbox[0];
      if (!overlaps) break;
      run.push(next);
      j++;
    }

    if (run.length === 1) {
      out.push(lead);
    } else {
      out.push({
        id: lead.id,
        page: lead.page,
        bbox: [
          Math.min(...run.map(b => b.bbox[0])),
          Math.min(...run.map(b => b.bbox[1])),
          Math.max(...run.map(b => b.bbox[2])),
          Math.max(...run.map(b => b.bbox[3])),
        ],
        lineIds: run.flatMap(b => b.lineIds),
        category: lead.category,
      });
      merged.set(lead.id, run.map(b => b.id));
    }
    i = j;
  }

  return { blocks: out, merged };
}

/**
 * Build the annotations for a classified book.
 *
 * The text is JOINED the way the book will read it — the line-join rules,
 * including the corpus-attested wrap-hyphen healing — rather than pasted
 * together with newlines. That matters for exactly one category and it matters
 * a lot: a `chapter` annotation's text IS the chapter title, so it has to be a
 * title and not three lines of a title with the hyphens still in.
 */
export function buildBlockAnnotations(
  blocks: readonly ClassifiedBlock[],
  lines: readonly ScanLine[],
  pitchPx: number,
): BlockAnnotation[] {
  const byId = new Map(lines.map(l => [l.id, l] as const));
  const attestation = attestationFromLines(lines.map(l => l.text));
  const { blocks: display, merged } = mergeDisplayCategories(blocks, pitchPx);

  return display.map((block, seq) => {
    const units = block.lineIds.map(id => {
      const line = byId.get(id);
      if (line === undefined) {
        throw new BlocksDocumentError(
          `block ${block.id} names line ${id}, which the scan does not have — the two artifacts `
          + 'are out of step. Re-run scan and blocks together.',
        );
      }
      return line.text;
    });
    return {
      id: block.id,
      page: block.page,
      seq,
      category: block.category,
      box: block.bbox,
      text: joinLines(units, attestation).text,
      merged: merged.get(block.id) ?? [],
      deleted: false,
    };
  });
}

export interface WriteBlockLayerOptions {
  /** The working document. Written as one incremental update. */
  pdfPath: string;
  blocks: readonly ClassifiedBlock[];
  lines: readonly ScanLine[];
  /** The scan's page sizes, which the block boxes are measured in. */
  pages: readonly ScanPage[];
  /** The book's median line-to-line advance, in the same pixels. */
  pitchPx: number;
  palette: Palette;
  log: (message: string) => void;
}

export interface WriteBlockLayerResult {
  written: number;
  mergedRuns: number;
  /** The file's length after the update — this stage's boundary. */
  boundary: number;
}

/**
 * Write the block layer into the working document, replacing any earlier one.
 *
 * One incremental update for the whole book: the annotations are built
 * completely, the pages that carry them are marked, and the append happens
 * once. A stage that wrote a page at a time would leave a document describing
 * half of one segmentation and half of another if it failed in the middle.
 */
export async function writeBlockLayer(
  options: WriteBlockLayerOptions,
): Promise<WriteBlockLayerResult> {
  const working = await WorkingPdf.open(options.pdfPath);
  const marker = working.marker();

  const pageCount = working.doc.getPageCount();
  if (pageCount !== options.pages.length) {
    throw new BlocksDocumentError(
      `${options.pdfPath} has ${pageCount} pages and the scan has ${options.pages.length}. The block `
      + 'boxes are keyed by page index, so these have to be the same document — re-cast the working '
      + 'document from the original this run was scanned from.',
    );
  }
  if (marker.dpi !== options.pages[0].dpi) {
    throw new BlocksDocumentError(
      `${options.pdfPath} records geometry at ${marker.dpi} dpi and this scan is at `
      + `${options.pages[0].dpi} dpi. Block boxes written in one frame and read in the other land `
      + 'in the wrong place on every page.',
    );
  }

  const frames = new Map<number, PageFrame>();
  for (const page of options.pages) {
    const crop = working.doc.getPage(page.page).getCropBox();
    frames.set(page.page, {
      page: page.page,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      widthPt: crop.width,
      heightPt: crop.height,
      offsetXPt: crop.x,
      offsetYPt: crop.y,
      deskewDeg: page.deskewDeg,
    });
  }

  const annotations = buildBlockAnnotations(options.blocks, options.lines, options.pitchPx);
  const mergedRuns = annotations.filter(a => a.merged.length > 0).length;

  const written = writeBlockAnnotations(
    working.doc, frames, annotations, options.palette, t => working.markChanged(t),
  );
  const boundary = await working.appendUpdate();

  options.log(
    `blocks: wrote ${written} annotations into ${options.pdfPath}`
    + `${mergedRuns > 0 ? `, ${mergedRuns} display run(s) merged` : ''} — boundary ${boundary}`,
  );
  return { written, mergedRuns, boundary };
}

/** Read the block layer back — for tests, and for anything that inspects one. */
export async function readBlockLayer(
  pdfPath: string, pages: readonly ScanPage[],
): Promise<BlockAnnotation[]> {
  const doc = await PDFDocument.load(new Uint8Array(await Bun.file(pdfPath).arrayBuffer()));
  const frames = new Map<number, PageFrame>();
  for (const page of pages) {
    const crop = doc.getPage(page.page).getCropBox();
    frames.set(page.page, {
      page: page.page,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      widthPt: crop.width,
      heightPt: crop.height,
      offsetXPt: crop.x,
      offsetYPt: crop.y,
      deskewDeg: page.deskewDeg,
    });
  }
  return readBlockAnnotations(doc, frames);
}
