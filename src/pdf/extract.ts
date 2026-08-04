/**
 * extract — read a PDF's text back out, with the geometry.
 *
 * One extraction path, two callers, and that is the point:
 *
 *  - `scan --pdf` reads a book that ARRIVED with a text layer and emits the
 *    same `scan/pages.json` + `scan/lines.json` a Tesseract scan emits, so
 *    everything downstream sees one input shape.
 *  - `reflow` reads the working document's text layer back — which for a
 *    scanned book is the layer `get-text` wrote, and for a text book is the
 *    publisher's — and turns it into the book.
 *
 * pdf-lib cannot do this: it parses the object graph, not the content streams'
 * text. pdf.js can, it is pure JavaScript, and `src/pdf/runtime.ts` makes it
 * start inside a compiled binary. What comes back from pdf.js is one item per
 * show-text operator, which is a FRAGMENT of a line — a change of font, a
 * kerned pair or a word gap all end one — so the lines are reassembled here.
 *
 * ## Normalization is turned OFF
 *
 * pdf.js normalizes extracted text by default: ligatures decompose, `ﬁ` comes
 * back as `fi`. That is right for search and wrong for a book. `reflow` reads
 * this layer as the text that will ship, so the round trip has to be exact, and
 * `disableNormalization` is not an option here — it is the contract.
 *
 * ## Reading order
 *
 * Lines come out sorted top-to-bottom, then left-to-right, which is a page's
 * reading order for the single-column and simple two-column books this pipeline
 * is for. It is deliberately NOT a layout analysis: the band segmenter's
 * column-major order is what the models were trained against on the scanned
 * path, and inventing a second, different reading order here would put two
 * orders in one pipeline.
 */
import type { Box } from '../scan/bands.js';
import { frameFromPage, ptToPxX, ptToPxY, type PageFrame } from './frame.js';
import { loadPdfjs } from './runtime.js';

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

/** One assembled line, in the scan's pixel frame. */
export interface ExtractedLine {
  text: string;
  /** [x0,y0,x1,y1], half-open, top-left origin, px. */
  box: Box;
}

export interface ExtractedPage {
  frame: PageFrame;
  lines: ExtractedLine[];
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
  /** The document's declared language, or null. Never guessed from the words. */
  language: string | null;
}

/**
 * Two fragments are on the same line when their baselines are within this
 * fraction of the taller one's type size.
 *
 * Superscripts and subscripts sit further off their baseline than this, which
 * is correct: a footnote marker raised half a line IS on the line, and a
 * threshold that tight would break the line in two around it. Measured against
 * that: 0.4 keeps a superscript with its line and still separates lines set
 * solid.
 */
const BASELINE_TOLERANCE = 0.4;

/**
 * A horizontal gap wider than this fraction of the type size is a word space,
 * even when the PDF emitted no space character for it.
 *
 * Publishers position words with the text matrix as often as with a space
 * glyph, so without this rule an entire justified line comes back as one welded
 * word. It is not a guess about what the author wrote — it is a measurement of
 * the page, which is the only evidence there is.
 */
const WORD_GAP = 0.2;

interface Fragment {
  text: string;
  /** Baseline start, px, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extract every page's text.
 *
 * `dpi` states the pixel frame the geometry is projected into — the pinned
 * scan resolution, so that a book that never met Tesseract still hands the
 * blocks model the numbers it was trained on.
 */
export async function extractDocument(
  bytes: Uint8Array, options: { dpi: number },
): Promise<ExtractedDocument> {
  const pdfjs = await loadPdfjs();
  // pdf.js transfers the buffer it is given, which would empty a Uint8Array the
  // caller still holds (the same bytes are often also handed to pdf-lib). A
  // copy is cheaper than the class of bug where the second reader sees zeros.
  const owned = bytes.slice();
  const task = pdfjs.getDocument({
    data: owned,
    // Nothing here draws a glyph, and each of these is a way for a document to
    // reach outside the process for something only a renderer needs.
    useSystemFonts: false,
    disableFontFace: true,
    // Errors only. pdf.js otherwise reports the absent native canvas and the
    // absent standard-font data on every document, and neither is a fact about
    // the book — both belong to rendering, which foundry does not do.
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  const doc = await task.promise;

  try {
    const pages: ExtractedPage[] = [];
    for (let index = 0; index < doc.numPages; index++) {
      const page = await doc.getPage(index + 1);
      if (page.rotate % 360 !== 0) {
        throw new ExtractError(
          `page ${index + 1} declares /Rotate ${page.rotate}. Foundry works in the page's own `
          + 'unrotated coordinates, and a rotated page means the geometry it reads and the geometry '
          + 'a reader shows are two different frames — which would put the text layer, the block '
          + 'boxes, or both, somewhere other than on the words. Rotation is not handled yet: '
          + 'un-rotate the PDF first.',
        );
      }
      // Viewport at scale 1 with no rotation: the page's own user space.
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const frame = frameFromPage(index, viewport.width, viewport.height, options.dpi);
      const content = await page.getTextContent({ disableNormalization: true });

      const fragments: Fragment[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str.length === 0) continue;
        const [a, b, , d, e, f] = item.transform as number[];
        if (b !== 0 || a === 0) {
          throw new ExtractError(
            `page ${index + 1} sets text on a rotated or sheared baseline (matrix ${a},${b}). Foundry `
            + 'reads horizontal text; a line at an angle would be measured as a box far taller than '
            + 'its type, and every paragraph rule is calibrated on that measurement.',
          );
        }
        const height = Math.abs(d);
        fragments.push({
          text: item.str,
          x: ptToPxX(frame, e),
          y: ptToPxY(frame, f),
          width: Math.abs(item.width) * (frame.widthPx / frame.widthPt),
          height: height * (frame.heightPx / frame.heightPt),
        });
      }
      pages.push({ frame, lines: assembleLines(fragments) });
      page.cleanup();
    }

    const meta = await doc.getMetadata();
    const info = meta.info as { Language?: unknown } | undefined;
    const language = typeof info?.Language === 'string' && info.Language.length > 0
      ? info.Language : null;
    return { pages, language };
  } finally {
    await task.destroy();
  }
}

/**
 * Fragments into lines: cluster by baseline, order by x, join with the gaps the
 * page actually has.
 *
 * `y` here is the BASELINE in the pixel frame (y down), so a line's box runs
 * from `y - height` to `y`: the type sits above its baseline. Descenders fall
 * below and are not measured, exactly as the scanned path's band boxes measure
 * ink rather than font metrics.
 */
export function assembleLines(fragments: readonly Fragment[]): ExtractedLine[] {
  if (fragments.length === 0) return [];

  const sorted = [...fragments].sort((p, q) => (p.y - q.y) || (p.x - q.x));
  const rows: Fragment[][] = [];
  for (const fragment of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const tallest = Math.max(...row.map(f => f.height), fragment.height);
      if (Math.abs(fragment.y - row[0].y) <= BASELINE_TOLERANCE * tallest) {
        row.push(fragment);
        continue;
      }
    }
    rows.push([fragment]);
  }

  const lines: ExtractedLine[] = [];
  for (const row of rows) {
    row.sort((p, q) => p.x - q.x);
    let text = '';
    let cursor: number | null = null;
    for (const fragment of row) {
      if (cursor !== null) {
        const gap = fragment.x - cursor;
        const needsSpace = gap > WORD_GAP * fragment.height
          && !text.endsWith(' ') && !fragment.text.startsWith(' ');
        if (needsSpace) text += ' ';
      }
      text += fragment.text;
      cursor = fragment.x + fragment.width;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    const x0 = Math.min(...row.map(f => f.x));
    const x1 = Math.max(...row.map(f => f.x + f.width));
    const baseline = Math.max(...row.map(f => f.y));
    const top = Math.min(...row.map(f => f.y - f.height));
    lines.push({ text: trimmed, box: boxOf(x0, top, x1, baseline) });
  }
  return lines;
}

function boxOf(x0: number, y0: number, x1: number, y1: number): Box {
  return [round2(x0), round2(y0), round2(x1), round2(y1)];
}

/**
 * Two decimal places, because these numbers are written into JSON that humans
 * diff between runs and a pixel frame has no meaning past a hundredth of a
 * pixel.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
