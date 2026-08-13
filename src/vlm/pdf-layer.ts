/**
 * vlm/pdf-layer — the book's own pages, with a text layer nobody can see.
 *
 * A FOURTH EMITTER, AND THE ONLY ONE THAT DOES NOT BUILD A BOOK. `epub.ts`,
 * `dots-book.ts` and `text-out.ts` all answer "what does this book say", and
 * every rule they own — where the chapters divide, which paragraph runs over a
 * page turn, which superscript names which note — is a rule about the book that
 * the pages are evidence FOR. This file answers a different question: where on
 * the paper was each of those words printed. So it forks in `convert.ts` the
 * moment the pages are parsed and takes none of that with it. No chapters, no
 * page-turn joins, no dehyphenation, no note markers, no reflow, no crops. The
 * text goes down verbatim, block by block, exactly where the model said it was.
 *
 * WHAT COMES OUT IS THE INPUT PDF. Every page keeps its own content stream, its
 * own images and its own metadata; one extra content stream goes in FRONT of
 * each page holding the recognised text in text rendering mode 3, which draws
 * nothing at all. The scan still looks like the scan — it is the scan — and
 * search, select and copy start working over it. That is the whole promise of
 * this format and it is why nothing here is allowed to be approximately right:
 * a reader who searches this file and lands on the wrong paragraph has been
 * told a lie by a document that looks like the original.
 *
 * IN FRONT rather than behind, and it is not about z-order — invisible text has
 * none. It is that a stream appended after the page's own runs in whatever
 * graphics state the page left behind, and a page that leaks one unbalanced `q`
 * would put every line of this layer under somebody else's matrix. pdf-lib
 * wraps existing content in `q`/`Q` when it normalises a page, which closes
 * that hole from the other side, but prepending closes it by construction: the
 * spec guarantees the initial graphics state at the start of the first stream,
 * and the layer asks for nothing else.
 *
 * PAGE FURNITURE IS IN THE LAYER. The running head and the folio are the first
 * things `dots.ts` sets aside and the book routes never write, because nobody
 * wrote them to be read and a narrator saying "142" mid-chapter is the failure
 * they exist to prevent. Here they are EVIDENCE: this file's claim is that the
 * layer says what the page printed, and the page printed the page number. A
 * search for a running head that found nothing would be this format failing at
 * the one thing it does.
 *
 * THE TEXT IS VERBATIM, INCLUDING WHERE THAT IS UGLY. A Table block's text is
 * the model's own HTML (`checkTableHtml`) and a bolded run still carries its
 * `**`, so both land in the layer as written. Consuming them would be the first
 * book-building rule on a route whose definition is that it has none, and it
 * would have to be kept in step with two emitters that already disagree about
 * what to do with a table. The words inside the markup are still the words, so
 * they still match a search; what is not there is a second opinion about them.
 *
 * A CHARACTER THIS FONT CANNOT WRITE BECOMES U+FFFD, AND SAYS SO BY NAME. That
 * is the one failure this format is most exposed to, because it is invisible by
 * construction: a glyph quietly dropped from a layer nobody can see is a word
 * that simply does not exist in a file that claims to be searchable, and
 * nothing downstream would ever say so (ARCHITECTURE §8). The answer is not a
 * stop — a vision model glitches one character in a forty-page book, and a book
 * held hostage to one glyph is a cure worse than the disease — but it is not
 * silence either. The character is replaced with U+FFFD �, the replacement
 * character, whose entire meaning is "something stood here that could not be
 * written", and every one of them is reported with its code point, its count
 * and its pages. What stays a refusal is SCALE: substitutions past one in a
 * thousand characters are not a glitch, they are a script this font does not
 * cover, and a layer that is mostly holes is not a search layer at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A LAYER IS REPLACED, NEVER STACKED — and the difference is what makes this
 * command safe to run twice.
 *
 * Two layers over one page means every word matches twice: two highlights on
 * the same ink, two hits in a count, and a selection that yields the page
 * doubled. Nothing about that is visible in a viewer until somebody searches,
 * which is exactly the shape of failure §8 is about. So every stream this file
 * writes CARRIES A MARK — `/FoundryTextLayer` in its own stream dictionary,
 * with the version that wrote it and when — and a run over a document that
 * already has one strips it before laying down the new one. The mark is a key
 * in a dictionary rather than a pattern in the bytes: it is read without
 * decoding anything, it says exactly which streams to remove, and no heuristic
 * is involved in either direction.
 *
 * SOMEBODY ELSE'S TEXT IS A REFUSAL. A born-digital PDF, or a scan another OCR
 * tool has already been over, already has a text layer — and this file will
 * neither stack a second one on top of it nor delete it. Stacking corrupts the
 * search it was asked to provide; deleting destroys something foundry did not
 * make and cannot put back, which is the one thing §8 will not trade for
 * convenience. The run stops and says which page it found text on. A scanned
 * page has no fonts and no text-showing operator, so the ordinary book passes
 * without the question ever being interesting.
 */
import * as fs from 'node:fs';

import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  TextRenderingMode,
  beginText,
  concatTransformationMatrix,
  decodePDFRawStream,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFContext,
  type PDFFont,
  type PDFObject,
  type PDFOperator,
  type PDFPage,
} from 'pdf-lib';

import { versionString } from '../version.js';
import type { DotsBox, Size } from './dots.js';

/**
 * DejaVu Sans, embedded in the binary as bytes.
 *
 * A UNICODE FONT IS NOT OPTIONAL HERE. pdf-lib's built-in fourteen are WinAnsi
 * and throw on anything outside Latin-1, and the very first page of a real book
 * carries an em dash, a curly quote or a name with an accent in it. Everything
 * this layer is for stops at that character.
 *
 * DejaVu specifically because its licence permits redistribution in a binary
 * without conditions anybody has to read (Bitstream Vera; the text ships beside
 * it), and because its coverage is Latin, Greek and Cyrillic — which is the
 * alphabet set of the books this program is pointed at. It is 757 KB of a
 * hundred-megabyte executable, and the SUBSET that reaches any one output PDF
 * is only the glyphs that book actually used.
 *
 * NOT A GLYPHLESS CID FONT, which is the other classic answer. Tesseract's
 * `pdf.ttf` is 572 bytes and carries no cmap at all, because Tesseract writes
 * the font dictionary, the widths and the ToUnicode map by hand from its own
 * boxes. Reached through pdf-lib's embedder every character would map to glyph
 * 0 and the ToUnicode map — the thing that makes the layer searchable — would
 * say every word in the book was the same character.
 *
 * `with { type: 'file' }` is the same seam `bridge.ts` uses for `vlm_page.py`:
 * Bun embeds the bytes at compile time and hands back a path that reads back
 * out of the binary's own filesystem, so the compiled exe carries the font and
 * a `bun run` off the tree reads the file beside this one.
 */
import FONT_PATH from './assets/DejaVuSans.ttf' with { type: 'file' };

/** Nothing about a searchable PDF could be done. Always says which page. */
export class VlmPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmPdfError';
  }
}

/**
 * The resource name the layer's font is registered under, on every page.
 *
 * Fixed rather than randomised so that converting the same book twice produces
 * the same bytes. A page that already has a font under this name is refused
 * rather than overwritten: overwriting it would change how the ORIGINAL page
 * draws, which is the one thing this format promises never to do.
 */
const FONT_KEY = 'FoundryOCRLayer';

/**
 * The key that says a content stream is one of ours.
 *
 * IN THE STREAM'S OWN DICTIONARY, which is the whole reason this works. A
 * reader that does not know the key ignores it (PDF 32000-1 §7.3.7: an unknown
 * entry is not an error), pdf-lib reads it back without decompressing a byte,
 * and it identifies the exact objects to remove — no pattern matching over
 * content, no guessing from what a stream contains. Its value is the LAYER
 * format's version, so that a future change to how the layer is written can be
 * told from this one by something that finds it.
 */
const LAYER_MARK = 'FoundryTextLayer';
const LAYER_FORMAT = 1;

/** Which foundry wrote the layer, and when. Both for a person reading a rerun. */
const LAYER_BY = 'FoundryVersion';
const LAYER_AT = 'FoundryWritten';

/**
 * How far below a line's baseline its descenders reach, in ems.
 *
 * Used to sit a baseline off the bottom of its share of the block, so that a
 * viewer's selection rectangle — which it derives from the baseline and the
 * font's own metrics — covers the ink rather than floating above it. DejaVu's
 * declared descent is 0.236 em; the exact number does not matter, because what
 * this decides is which pixel row a highlight starts on and not what the file
 * says.
 */
const DESCENDER = 0.21;

/** Below this, a box is degenerate rather than small, and text cannot sit in it. */
const MIN_FONT_SIZE = 0.5;

/**
 * A line's height as a multiple of its type size — leading included.
 *
 * 1.2 is the printer's default and near enough every book's. It is here because
 * this file has to decide how many lines of a given size a box holds, which is
 * the whole of the difference between a paragraph laid across its box and a
 * paragraph squeezed onto one baseline.
 */
const LINE_FACTOR = 1.2;

/** How many times the size is allowed to shrink to make the wrap fit its box. */
const FIT_ATTEMPTS = 4;

/**
 * What an unwritable character becomes: U+FFFD, the replacement character.
 *
 * Chosen because saying "something was here" is its entire job in Unicode, a
 * reader who selects the line sees at a glance that one character is a stand-in,
 * and DejaVu carries its glyph — which is checked once at embed time, because a
 * substitute the font also cannot write would be this mechanism eating itself.
 */
const REPLACEMENT = '�';
const REPLACEMENT_CODE = 0xfffd;

/**
 * Where substitution stops being a repair and becomes a refusal.
 *
 * One character in a thousand is a model glitch — a hallucinated CJK glyph in
 * an English book, once — and the book should not be held hostage to it. Past
 * that ratio the font does not cover the book's SCRIPT, and substituting on
 * would produce a layer that is mostly holes while reporting success, which is
 * the exact failure §8 exists to stop. The floor keeps a tiny run honest: a
 * ratio of a handful of characters is noise, not evidence of anything.
 */
const SUBSTITUTION_RATIO = 1 / 1000;
const SUBSTITUTION_FLOOR = 10;

/**
 * How far the render may disagree with the page it is supposed to be of.
 *
 * The renders are made at a pinned 200 dpi off the page's own display box, so
 * the points-per-pixel this file recomputes should land on 72/200 to within
 * whatever the rasteriser rounded. Two per cent is orders of magnitude more
 * than that rounding and far less than any real mismatch — a render of the
 * wrong page, a dpi that moved, a page whose box changed under us — and every
 * one of those puts every line of the layer somewhere it does not belong.
 */
const SCALE_TOLERANCE = 0.02;

// ── geometry ────────────────────────────────────────────────────────────────

/**
 * A rectangle in PDF user space: the page's own coordinates, points, y up.
 */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Everything about one page that decides where a box lands.
 *
 * `crop` is the page's CropBox — what a viewer shows and what the rasteriser
 * rendered — in the page's UNROTATED user space, origin wherever the PDF put
 * it. `rotation` is the page's own /Rotate. `render` is the pixel size of the
 * image the model was actually looking at.
 */
export interface PageFrame {
  crop: PdfRect;
  /** 0, 90, 180 or 270. Anything else is refused before a frame is built. */
  rotation: number;
  render: Size;
}

/**
 * The page AS DISPLAYED, in points: a quarter turn swaps the sides.
 *
 * This is the frame the render is of. PyMuPDF applies /Rotate when it
 * rasterises, so a 90°-rotated portrait page arrives as a landscape image, and
 * every box the model returned is in that landscape frame.
 */
export function displaySize(frame: PageFrame): Size {
  const quarterTurn = frame.rotation === 90 || frame.rotation === 270;
  return quarterTurn
    ? { width: frame.crop.height, height: frame.crop.width }
    : { width: frame.crop.width, height: frame.crop.height };
}

/** Points per render pixel, one per axis. Both should be 72/dpi. */
export function pointsPerPixel(frame: PageFrame): { x: number; y: number } {
  const display = displaySize(frame);
  return { x: display.width / frame.render.width, y: display.height / frame.render.height };
}

/**
 * The matrix that turns DISPLAY space into the page's own user space.
 *
 * Display space is the frame the boxes are already in once they are in points:
 * origin at the bottom-left of the displayed page, x right, y UP, sized as
 * `displaySize` says. Pushing this as a `cm` before the text means every
 * placement below is written in the one frame the model and the render agree
 * about, and the CropBox offset, the y-flip and the page's rotation are all
 * paid once, here, by six numbers.
 *
 * Derived rather than guessed, one quarter turn at a time. Write `u` for a
 * point's distance from the crop's left edge and `v` for its distance DOWN from
 * the crop's top edge, so that user space is `x = crop.x + u`, `y = crop.y +
 * crop.height - v`. Rotating the page 90° clockwise for display sends `(u, v)`
 * to display `(h - v, u)` in an `h × w` image, and so on round the circle;
 * substituting `v = displayHeight - py` for the y-up display point `(px, py)`
 * and collecting terms gives each row below.
 *
 * EVERY ONE OF THESE HAS DETERMINANT +1. That is the check that says the layer
 * is rotated and never mirrored: a reflection here would place each line
 * backwards, which no test of a single point's position would catch.
 */
export function displayMatrix(
  frame: PageFrame,
): readonly [number, number, number, number, number, number] {
  const { x, y, width, height } = frame.crop;
  switch (frame.rotation) {
    case 0:
      return [1, 0, 0, 1, x, y];
    case 90:
      return [0, 1, -1, 0, x + width, y];
    case 180:
      return [-1, 0, 0, -1, x + width, y + height];
    case 270:
      return [0, -1, 1, 0, x, y + height];
    default:
      // Unreachable: `frameOf` refuses the page before it builds a frame. Here
      // so that a fifth case added to /Rotate cannot arrive as a silent
      // identity matrix.
      throw new VlmPdfError(`a page frame was built with /Rotate ${frame.rotation}`);
  }
}

/**
 * A block's box, from the render's pixels into display points.
 *
 * The two frames disagree about y: an image counts rows DOWN from the top and
 * PDF user space counts up from the bottom, so the box's top edge in pixels is
 * its `y + height` here and its bottom edge is `y`. Getting this backwards
 * puts every line of a book on the mirror image of the page it belongs to,
 * which is why it is one function with numbers pinned in a test rather than an
 * expression inlined at the one place it is used.
 */
export function boxToDisplay(box: DotsBox, frame: PageFrame): PdfRect {
  const scale = pointsPerPixel(frame);
  const display = displaySize(frame);
  const left = box.x1 * scale.x;
  const right = box.x2 * scale.x;
  const top = display.height - box.y1 * scale.y;
  const bottom = display.height - box.y2 * scale.y;
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

// ── the pages, as this format sees them ─────────────────────────────────────

/** One recognised block: where it was, and what it said. Nothing else. */
export interface PdfLayerBlock {
  /** In the RENDER's pixel frame, top-down — what `parseDotsPage` hands out. */
  box: DotsBox;
  /** The model's own text, verbatim. May contain newlines the page broke on. */
  text: string;
}

export interface PdfLayerPage {
  /** 1-based, the PDF's own numbering. */
  page: number;
  /** The render the boxes are measured in, in pixels. */
  render: Size;
  blocks: readonly PdfLayerBlock[];
}

export interface SearchablePdfOptions {
  /** The original PDF, unmodified. Its pages are what comes back out. */
  pdfBytes: Uint8Array;
  /** The dpi the renders were made at — `VLM_DPI`, and the frame check's expectation. */
  dpi: number;
  /** The pages that were read, in any order. A page not here gets no overlay. */
  pages: readonly PdfLayerPage[];
}

export interface SearchablePdfResult {
  bytes: Uint8Array;
  /**
   * How long the layer took, under the name `packageVlmEpub` gives the same
   * phase — "the assembled answers become the bytes that get written". This one
   * is an overlay rather than a zip or a render, and the run's phase line says
   * which of the three it was (`convert.ts`), so the number is never printed
   * under a word that is wrong about it.
   */
  zipSeconds: number;
  /** Pages that came out with text over them. */
  overlaidPages: number;
  /** Lines of text drawn, over the whole book. */
  lines: number;
  /**
   * A foundry layer that was already there and has been taken back out, or
   * null. Reported rather than done quietly: this is the one operation in this
   * file that DELETES something, and a deletion nobody can read is a deletion
   * nobody can check.
   */
  replaced: {
    /** How many pages carried one. */
    pages: number;
    /** The foundry that wrote it, as it recorded itself. Null if it did not. */
    by: string | null;
    /** When, ISO-8601. Null if the old layer recorded no date. */
    at: string | null;
  } | null;
  /**
   * Characters the font could not write, each replaced with U+FFFD — or null
   * when every character went down as itself. Reported rather than absorbed:
   * a substitution in an invisible layer is undetectable by looking, so the
   * log line built from this is the only place it exists.
   */
  substituted: {
    /** Occurrences over the whole book. */
    count: number;
    /** Each distinct character, with everywhere it happened. */
    characters: { char: string; code: number; count: number; pages: number[] }[];
  } | null;
}

/** The running tally the pages write substitutions into as they are drawn. */
interface SubstitutionTally {
  /** Every character drawn, substituted or not — the ratio's denominator. */
  chars: number;
  perChar: Map<string, { code: number; count: number; pages: Set<number> }>;
}

// ── the overlay ─────────────────────────────────────────────────────────────

/**
 * The original PDF, plus an invisible text layer at the recognised positions.
 *
 * Every page that was read gets one content stream in front of it; a page that
 * was not read — unreadable, or struck out with `--skip-pages` — gets nothing
 * and is left exactly as it arrived, which is the honest thing for a page
 * nobody has a reading of. A reading for a page the document does not have is a
 * different matter and stops the run: it means the readings and the PDF are not
 * about the same document, and every page in the layer is then suspect.
 */
export async function buildSearchablePdf(
  opts: SearchablePdfOptions,
): Promise<SearchablePdfResult> {
  const started = Date.now();

  let doc: PDFDocument;
  try {
    /*
     * `updateMetadata: false`, deliberately.
     *
     * pdf-lib otherwise stamps its own Producer and a fresh ModDate over the
     * document's, and this file's whole claim is that what comes out is the
     * document that went in. A scan whose Producer now names a JavaScript
     * library is a document that has been quietly signed by something that did
     * not make it, and in the one mode foundry calls evidentiary that is not a
     * cosmetic difference.
     */
    doc = await PDFDocument.load(opts.pdfBytes, { updateMetadata: false });
  } catch (err) {
    throw new VlmPdfError(
      'the PDF could not be opened to write a text layer into it '
      + `(${err instanceof Error ? err.message : String(err)}). The pages were read from it, so `
      + 'what stopped this is the file\'s structure rather than its content — an encrypted '
      + 'document is the usual answer.',
    );
  }
  const pageCount = doc.getPageCount();
  for (const reading of opts.pages) {
    if (reading.page < 1 || reading.page > pageCount) {
      throw new VlmPdfError(
        `there is a reading for page ${reading.page} and the PDF has ${pageCount} page(s), so the `
        + 'readings and this document are not about the same file. Nothing is skipped over that: '
        + 'if one page number is wrong, every box in the layer is in doubt.',
      );
    }
  }

  /*
   * WHAT IS ALREADY ON THESE PAGES, decided before a single line is drawn.
   *
   * Both halves of it have to happen first and both have to happen over the
   * whole document. A layer of ours must come off every page that has one —
   * including a page this run cannot read, which would otherwise keep
   * yesterday's text under today's file. And somebody else's text has to stop
   * the run before it has written anything, because a refusal that arrives
   * after the bytes are laid down is a refusal that has already done the harm.
   */
  const replaced = stripFoundryLayers(doc);
  refuseForeignText(doc, new Set(opts.pages.map((reading) => reading.page)));

  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
  const covered = new Set(font.getCharacterSet());
  if (!covered.has(REPLACEMENT_CODE)) {
    // Unreachable with DejaVu, which carries U+FFFD. Here so a future font swap
    // cannot leave the substitute itself unwritable.
    throw new VlmPdfError('the text layer\'s font has no glyph for U+FFFD, its own substitute.');
  }

  let lines = 0;
  let overlaidPages = 0;
  const tally: SubstitutionTally = { chars: 0, perChar: new Map() };

  for (const reading of opts.pages) {
    const page = doc.getPage(reading.page - 1);
    const frame = frameOf(page, reading.render, reading.page);
    checkScale(frame, reading.page, opts.dpi);

    const drawn = drawPage(reading, frame, font, covered, tally);
    if (drawn.lines === 0) continue;
    registerFont(page, font, reading.page);
    prependOperators(page, drawn.operators);
    overlaidPages += 1;
    lines += drawn.lines;
  }

  const substituted = closeTally(tally);

  const bytes = await doc.save();
  return {
    bytes,
    zipSeconds: (Date.now() - started) / 1000,
    overlaidPages,
    lines,
    replaced,
    substituted,
  };
}

/**
 * The tally, judged and folded into the report — or the run stopped.
 *
 * The judgement happens HERE, over the whole book, rather than at the first bad
 * character, because one character cannot tell a glitch from a script: only the
 * ratio can. Nothing has been written yet — the bytes are made after this — so
 * a refusal here has cost time and nothing else.
 */
function closeTally(tally: SubstitutionTally): SearchablePdfResult['substituted'] {
  if (tally.perChar.size === 0) return null;
  const characters = [...tally.perChar.entries()]
    .map(([char, entry]) => ({
      char,
      code: entry.code,
      count: entry.count,
      pages: [...entry.pages].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count);
  const count = characters.reduce((sum, entry) => sum + entry.count, 0);

  const allowed = Math.max(SUBSTITUTION_FLOOR, tally.chars * SUBSTITUTION_RATIO);
  if (count > allowed) {
    const named = characters.slice(0, 8)
      .map((entry) => `${JSON.stringify(entry.char)} (U+${hex(entry.code)}, ×${entry.count})`)
      .join(', ');
    throw new VlmPdfError(
      `${count} of the ${tally.chars} characters in this book have no glyph in the text layer's `
      + `font — ${named}${characters.length > 8 ? ', and more' : ''}. One stray character is a `
      + 'model glitch and is replaced with U+FFFD by name, but at this scale the font does not '
      + 'cover the book\'s script, and a layer that is mostly holes would report itself as '
      + 'searchable while most of its words are not findable. The font is DejaVu Sans '
      + '(src/vlm/assets); a book in a script it does not cover needs one that does.',
    );
  }
  return { count, characters };
}

function hex(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * The page's own geometry, and a refusal where it cannot be honoured.
 *
 * /Rotate is READ rather than assumed. A quarter turn is arithmetic this file
 * does (`displayMatrix`), and anything else — the arbitrary angles a malformed
 * file can carry — is refused by name, because the alternative is a layer laid
 * over a page at an angle nobody can see and every search hit landing on the
 * wrong line.
 */
function frameOf(page: PDFPage, render: Size, number: number): PageFrame {
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (rotation % 90 !== 0) {
    throw new VlmPdfError(
      `page ${number} is rotated by ${page.getRotation().angle}°, which is not a quarter turn. `
      + 'The text layer is placed by transforming the render\'s frame into the page\'s, and that '
      + 'transform is only exact for 0, 90, 180 and 270 — an approximation here would put every '
      + 'line on the page slightly askew, where nothing can see it.',
    );
  }
  if (crop.width <= 0 || crop.height <= 0) {
    throw new VlmPdfError(
      `page ${number} has a ${crop.width}×${crop.height} pt crop box, so there is no page for the `
      + 'text layer to sit on.',
    );
  }
  if (render.width <= 0 || render.height <= 0) {
    throw new VlmPdfError(
      `page ${number} was rendered ${render.width}×${render.height}, and the model's boxes are `
      + 'measured in that render.',
    );
  }
  return { crop, rotation, render };
}

/**
 * Is this render a render of THIS page?
 *
 * The one observable that says so. Renders are pinned at 200 dpi off the page's
 * display box (ARCHITECTURE §5), so the points per pixel this recomputes has
 * exactly one right answer and a wrong one is not a small error — it is the
 * whole layer scaled off the page. Checked per axis, because a mismatch that
 * only one of them sees is a rotation this file got wrong, which is the failure
 * that would otherwise look most like success.
 */
function checkScale(frame: PageFrame, number: number, dpi: number): void {
  const expected = 72 / dpi;
  const scale = pointsPerPixel(frame);
  for (const [axis, measured] of [['width', scale.x], ['height', scale.y]] as const) {
    if (Math.abs(measured / expected - 1) <= SCALE_TOLERANCE) continue;
    const display = displaySize(frame);
    throw new VlmPdfError(
      `page ${number}'s render is ${frame.render.width}×${frame.render.height} px for a `
      + `${display.width.toFixed(1)}×${display.height.toFixed(1)} pt page, which is `
      + `${(72 / measured).toFixed(1)} dpi across its ${axis} and not the ${dpi} every render is `
      + 'made at. The boxes are measured in that render, so a text layer placed from it would be '
      + 'wrong by that ratio on every line of the page.',
    );
  }
}

/**
 * One page's blocks as drawing operators, or nothing at all.
 *
 * `3 Tr` — INVISIBLE — is set once, inside the text object, and it is the whole
 * mechanism. It is a text state parameter, so it covers every line that
 * follows; it is the classic OCR-layer operator rather than a transparency
 * trick, so a viewer that ignores alpha still draws nothing, and a printer
 * prints the scan.
 */
function drawPage(
  reading: PdfLayerPage,
  frame: PageFrame,
  font: PDFFont,
  covered: ReadonlySet<number>,
  tally: SubstitutionTally,
): { operators: PDFOperator[]; lines: number } {
  const body: PDFOperator[] = [];
  let lines = 0;
  for (const block of reading.blocks) {
    const rect = boxToDisplay(block.box, frame);
    if (rect.width <= 0 || rect.height <= 0) continue;
    /*
     * The lines the page broke on, and nothing invented. `dots.ts` keeps a
     * newline only where the page had one, and a block with none is one line
     * however long it is — the box is the box.
     *
     * The one thing changed on the way down is HORIZONTAL WHITESPACE THAT HAS
     * NO GLYPH. A tab, a vertical tab and a form feed are formatting bytes
     * rather than marks on paper, no text font on earth has an outline for one,
     * and this layer's unit of formatting is the line — so they become the
     * space they were standing in for. Refusing them instead would stop a book
     * over a character that was never printed on it. Every OTHER control
     * character is left to fail: a NUL in a page's text is not formatting, it
     * is a sign the answer is damaged.
     */
    const printed = block.text
      .split(/\r\n|\r|\n/)
      .map((line) => line.replace(/[\t\v\f]/g, ' ').trim())
      .filter((line) => line.length > 0)
      .map((line) => substituteUnwritable(line, reading.page, covered, tally));
    if (printed.length === 0) continue;

    const laid = layoutBlock(printed, rect, font);
    if (laid === null) continue;
    const slot = rect.height / laid.lines.length;
    for (const [index, line] of laid.lines.entries()) {
      const baseline = rect.y + (laid.lines.length - 1 - index) * slot + DESCENDER * laid.size;
      body.push(
        setFontAndSize(FONT_KEY, laid.size),
        setTextMatrix(1, 0, 0, 1, rect.x, baseline),
        showText(font.encodeText(line)),
      );
      lines += 1;
    }
  }
  if (lines === 0) return { operators: [], lines: 0 };
  return {
    operators: [
      pushGraphicsState(),
      concatTransformationMatrix(...displayMatrix(frame)),
      beginText(),
      setTextRenderingMode(TextRenderingMode.Invisible),
      ...body,
      endText(),
      popGraphicsState(),
    ],
    lines,
  };
}

/**
 * One block's text, laid across the rectangle the model measured it in.
 *
 * THE MODEL DOES NOT ANSWER IN LINES, and this is where that stops being
 * somebody else's problem. dots.ocr REFLOWS wrapped prose: a fifteen-line
 * paragraph comes back as one unbroken string with a fifteen-line box around it
 * (`dots.ts`). Placed as written, that paragraph would be one text run on one
 * baseline at whatever size fits its whole length into the column width — about
 * half a point — and a search hit anywhere in it would highlight a hairline
 * across the middle of the block instead of the words it matched. So the words
 * are laid back across the box. Nothing about the text changes: same
 * characters, same order, same rectangle. Only where inside that rectangle each
 * of them is drawn.
 *
 * The size is solved from the AREA, which is the only thing that knows both
 * constraints at once. n lines of size s, wrapped to width w, need about
 * `U·s/w` lines and `U·s²·λ/w` of height, so the size that exactly fills a box
 * of height h is `√(w·h/(λ·U))`. The wrap is then measured rather than trusted,
 * and shrinks until it fits — a long word that cannot be broken makes the
 * estimate optimistic, and the estimate is not what gets drawn.
 *
 * A BLOCK THAT DID NOT NEED WRAPPING IS SIZED TO ITS WIDTH INSTEAD. When the
 * lines the page broke on are the lines that come out, the box is a tight
 * rectangle around exactly those lines and filling its width is what puts a
 * highlight over the printed words. That is every heading, every folio, every
 * running head and every line of a contents page.
 */
function layoutBlock(
  printed: readonly string[],
  rect: PdfRect,
  font: PDFFont,
): { size: number; lines: string[] } | null {
  const units = printed.map((line) => font.widthOfTextAtSize(line, 1));
  const total = units.reduce((sum, unit) => sum + unit, 0);
  const widest = Math.max(...units);
  if (total <= 0 || widest <= 0) return null;

  // Every hard line on a line of its own, filling the width — bounded by the
  // height, so a short block in a tall box cannot claim type taller than it.
  const unwrapped = Math.min(rect.width / widest, rect.height / (LINE_FACTOR * printed.length));

  let size = Math.min(
    Math.sqrt((rect.width * rect.height) / (LINE_FACTOR * total)),
    rect.height / LINE_FACTOR,
  );
  let lines = wrapLines(printed, rect.width, size, font);
  for (let attempt = 1; attempt < FIT_ATTEMPTS; attempt += 1) {
    const needed = lines.length * size * LINE_FACTOR;
    if (needed <= rect.height || size <= MIN_FONT_SIZE) break;
    size = Math.max(MIN_FONT_SIZE, (size * rect.height) / needed);
    lines = wrapLines(printed, rect.width, size, font);
  }

  if (lines.length === printed.length) return { size: Math.max(MIN_FONT_SIZE, unwrapped), lines: [...printed] };
  return { size: Math.max(MIN_FONT_SIZE, size), lines };
}

/**
 * Greedy wrapping at word boundaries, and a word too long for the column goes
 * on a line of its own rather than nowhere.
 *
 * Never breaks inside a word: the layer's job is to make words findable, and a
 * word split across two text runs is a word a search does not match.
 */
function wrapLines(
  printed: readonly string[],
  width: number,
  size: number,
  font: PDFFont,
): string[] {
  const out: string[] = [];
  for (const line of printed) {
    let current = '';
    for (const word of line.split(' ').filter((part) => part.length > 0)) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (current.length > 0 && font.widthOfTextAtSize(candidate, size) > width) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current.length > 0 ? current : line);
  }
  return out;
}

/**
 * Every character, checked against what the font can actually write — and the
 * ones it cannot, replaced with U+FFFD and put on the tally.
 *
 * pdf-lib does not do this and cannot be made to: a character the font has no
 * glyph for is encoded as .notdef and silently becomes a blank in the layer, so
 * the word it was in stops being findable and the file still opens, still looks
 * right and still reports success. Substituted here — with the page, the
 * character and its code point recorded — because this is the only place all
 * three are known, and whether the book's WORTH of them is a glitch or a script
 * is `closeTally`'s question, asked once, at the end.
 */
function substituteUnwritable(
  line: string,
  page: number,
  covered: ReadonlySet<number>,
  tally: SubstitutionTally,
): string {
  let out = '';
  for (const character of line) {
    tally.chars += 1;
    const code = character.codePointAt(0)!;
    if (covered.has(code)) {
      out += character;
      continue;
    }
    const entry = tally.perChar.get(character) ?? { code, count: 0, pages: new Set<number>() };
    entry.count += 1;
    entry.pages.add(page);
    tally.perChar.set(character, entry);
    out += REPLACEMENT;
  }
  return out;
}

/**
 * The layer's font, on this page's resources, under a name nothing else uses.
 *
 * Refused rather than overwritten on a collision. Every other thing this file
 * does is additive — a new stream, a new resource — and replacing a font the
 * original page draws with would change how the ORIGINAL page renders, which is
 * the one promise this format makes.
 */
function registerFont(page: PDFPage, font: PDFFont, number: number): void {
  const key = PDFName.of(FONT_KEY);
  const fonts: PDFDict = page.node.normalizedEntries().Font;
  const existing = fonts.get(key);
  // Already this run's own, which happens the moment two pages share one
  // inherited Resources dictionary — every page after the first finds the font
  // the first one put there. Not a collision; the same font.
  if (existing instanceof PDFRef && String(existing) === String(font.ref)) return;
  if (existing !== undefined) {
    throw new VlmPdfError(
      `page ${number} already has a font resource called /${FONT_KEY}, which is the name the text `
      + 'layer registers its own under. Taking the name would change how the page itself draws, '
      + 'and this format exists to leave the page exactly as it was.',
    );
  }
  page.node.setFontDictionary(key, font.ref);
}

/**
 * The layer's stream, in FRONT of the page's own.
 *
 * `pushOperators` would append, and an appended stream inherits whatever
 * graphics state the page's own content left behind. The spec guarantees the
 * initial state only at the start of the first stream, so that is where the
 * layer goes — nothing has to be assumed about the document, and z-order does
 * not enter into it because none of this draws anything.
 */
function prependOperators(page: PDFPage, operators: PDFOperator[]): void {
  const context = page.doc.context;
  // Through the same door pdf-lib uses: `normalizedEntries` guarantees Contents
  // is an array (and wraps whatever was there in q/Q on the way), so there is
  // always somewhere to put a stream at index 0.
  /*
   * `normalizedEntries` is what guarantees Contents is an array to insert into.
   * It also wraps whatever was already there in a `q`/`Q` pair of its own,
   * which this file does not need — prepending means it inherits the initial
   * state whatever the page does — and which therefore costs a rerun two tiny
   * streams and about 180 bytes. That is the price of going through pdf-lib's
   * own door rather than hand-editing a page's Contents and its inherited
   * Resources, and it is the right price: the pair is balanced, it changes
   * nothing about how the page draws, and it does not accumulate into anything
   * that can be mistaken for a second layer.
   */
  const contents = page.node.normalizedEntries().Contents;
  if (contents === undefined) {
    throw new VlmPdfError(
      `a page of this PDF has no content at all, so it is not the page that was rendered and read.`,
    );
  }
  /*
   * The mark, and the two facts a person rerunning this will want.
   *
   * The date makes two runs over one book produce different bytes, and that is
   * the trade taken on purpose: a layer is an assertion about a document made
   * at a moment by a version of a program, and in the mode foundry calls
   * evidentiary, WHEN is worth more than a reproducible checksum of a file
   * whose page content was never in question anyway.
   */
  const stream = context.contentStream(operators, {
    [LAYER_MARK]: PDFNumber.of(LAYER_FORMAT),
    [LAYER_BY]: PDFString.of(versionString()),
    [LAYER_AT]: PDFString.fromDate(new Date()),
  });
  contents.insert(0, context.register(stream));
}

// ── what was already here ───────────────────────────────────────────────────

/**
 * Every foundry layer in the document, taken back out.
 *
 * REPLACE, NOT STACK. Running this conversion twice is an ordinary thing to do
 * — the readings are banked, so the second run is free — and two layers over
 * one page would double every search hit in the book while looking, in a
 * viewer, exactly like one. The old streams go, the font they were written in
 * goes with them, and what is left is the document as it was before foundry
 * ever saw it.
 *
 * The font is deleted THROUGH ITS OWN OBJECT GRAPH — dictionary, descendant
 * font, descriptor, the embedded font file, the ToUnicode map — because an
 * orphaned subset left behind by every rerun is tens of kilobytes a run, and
 * pdf-lib writes every object it holds whether anything points at it or not.
 * Safe to walk blindly precisely because that graph is ours: it is reached from
 * a resource name no other producer uses, and it was embedded fresh by the run
 * that wrote the layer being removed.
 */
function stripFoundryLayers(doc: PDFDocument): SearchablePdfResult['replaced'] {
  const context = doc.context;
  let pages = 0;
  let by: string | null = null;
  let at: string | null = null;

  for (const page of doc.getPages()) {
    const ours: PDFRef[] = [];
    for (const ref of contentRefs(page)) {
      const stream = context.lookup(ref);
      if (!(stream instanceof PDFStream)) continue;
      if (stream.dict.get(PDFName.of(LAYER_MARK)) === undefined) continue;
      ours.push(ref);
      const wroteIt = stream.dict.get(PDFName.of(LAYER_BY));
      if (by === null && wroteIt instanceof PDFString) by = wroteIt.decodeText();
      const when = stream.dict.get(PDFName.of(LAYER_AT));
      if (at === null && when instanceof PDFString) {
        // A date this file wrote itself, so a date that will not parse is a
        // file somebody has been editing by hand — said, never invented.
        try {
          at = when.decodeDate().toISOString();
        } catch {
          at = null;
        }
      }
    }
    if (ours.length === 0) continue;
    pages += 1;
    removeContents(page, new Set(ours.map(String)));
    for (const ref of ours) deleteReachable(context, ref, new Set());
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.Font, PDFDict);
    const fontRef = fonts?.get(PDFName.of(FONT_KEY));
    if (fonts !== undefined && fontRef instanceof PDFRef) {
      fonts.delete(PDFName.of(FONT_KEY));
      deleteReachable(context, fontRef, new Set());
    }
  }

  return pages === 0 ? null : { pages, by, at };
}

/** The refs in a page's Contents, however the page spells it. Never normalises. */
function contentRefs(page: PDFPage): PDFRef[] {
  const raw = page.node.get(PDFName.of('Contents'));
  const resolved = raw instanceof PDFRef ? page.doc.context.lookup(raw) : raw;
  if (resolved instanceof PDFArray) {
    return resolved.asArray().filter((entry): entry is PDFRef => entry instanceof PDFRef);
  }
  return raw instanceof PDFRef ? [raw] : [];
}

/** Those refs, out of the page's Contents. */
function removeContents(page: PDFPage, refs: ReadonlySet<string>): void {
  const key = PDFName.of('Contents');
  const raw = page.node.get(key);
  const array = raw instanceof PDFArray
    ? raw
    : raw instanceof PDFRef ? page.doc.context.lookupMaybe(raw, PDFArray) : undefined;
  if (array === undefined) {
    // A page whose entire content IS one of our streams. It cannot happen to a
    // book — a page foundry overlaid had content to overlay — but a synthetic
    // page is a page, and leaving a dangling reference behind is not an option.
    if (raw instanceof PDFRef && refs.has(String(raw))) page.node.set(key, page.doc.context.obj([]));
    return;
  }
  for (let index = array.size() - 1; index >= 0; index -= 1) {
    const entry = array.get(index);
    if (entry instanceof PDFRef && refs.has(String(entry))) array.remove(index);
  }
}

/** An object and everything only it can reach, gone from the document. */
function deleteReachable(context: PDFContext, ref: PDFRef, seen: Set<string>): void {
  if (seen.has(String(ref))) return;
  seen.add(String(ref));
  const object = context.lookup(ref);
  if (object === undefined) return;
  context.delete(ref);
  for (const child of childRefs(object)) deleteReachable(context, child, seen);
}

/**
 * The indirect references inside one object, THROUGH the direct containers on
 * the way to them.
 *
 * A composite font hides behind exactly that: the Type0 dictionary's
 * `/DescendantFonts` is a direct array holding one reference, and a walk that
 * only looked at the dictionary's own values would stop there — leaving the
 * CID font, its descriptor and the 5 KB of embedded outlines behind on every
 * rerun, growing the file by a whole font each time while reporting that the
 * old layer had been removed.
 */
function childRefs(object: PDFObject): PDFRef[] {
  const refs: PDFRef[] = [];
  const walk = (value: PDFObject): void => {
    if (value instanceof PDFRef) refs.push(value);
    else if (value instanceof PDFArray) for (const entry of value.asArray()) walk(entry);
    else if (value instanceof PDFStream) walk(value.dict);
    else if (value instanceof PDFDict) for (const entry of value.values()) walk(entry);
  };
  walk(object);
  return refs;
}

// ── somebody else's text ────────────────────────────────────────────────────

/**
 * Text that is not ours, on a page that is about to get a layer — and the run
 * stops.
 *
 * NEITHER STACKED NOR DELETED, and both halves of that are decisions. Drawing
 * over an existing layer doubles every hit in the book: a search reports two
 * matches on one word, a count is twice what it should be, and a select-all
 * copies the page twice — none of which a viewer shows until somebody looks for
 * something. Deleting the other layer instead would destroy work this program
 * did not do and cannot reproduce, which is the thing §8 will not trade away
 * for a smoother run. So the answer is a sentence naming the page.
 *
 * ONLY THE PAGES THAT WOULD BE OVERLAID are asked about. The doubling is a
 * per-page fact, and a scan with one born-digital page bound into it that this
 * run never read has nothing wrong with it. Every page this run does read gets
 * the question.
 *
 * The cheap half is structural and certain: a page with no font resources
 * cannot show a glyph, and that is every page of every scan. Only a page that
 * HAS fonts costs a look at what it draws.
 */
function refuseForeignText(doc: PDFDocument, overlaid: ReadonlySet<number>): void {
  const found: number[] = [];
  for (const [index, page] of doc.getPages().entries()) {
    const number = index + 1;
    if (!overlaid.has(number)) continue;
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.Font, PDFDict);
    if (fonts === undefined || fonts.keys().length === 0) continue;
    if (pageShowsText(page, number)) found.push(number);
  }
  if (found.length === 0) return;

  const named = found.slice(0, 8).join(', ');
  throw new VlmPdfError(
    `this PDF already has text on it — page(s) ${named}${found.length > 8 ? ', and more' : ''}, `
    + `${found.length} of the ${overlaid.size} this run would have overlaid — and none of it was `
    + 'written by foundry. Adding a layer over it would make every word match twice: two '
    + 'highlights on one line, a search count that is double, and a select-all that copies the '
    + 'page twice, none of which is visible until somebody searches. Removing the other layer '
    + 'instead is not on offer either — foundry does not delete a text layer it did not write and '
    + 'cannot put back. If this is a born-digital PDF it is already searchable and needs nothing '
    + 'from this command; if it has been through another OCR tool, convert the ORIGINAL scan.',
  );
}

/** Does anything this page draws show text? Refuses rather than guesses. */
function pageShowsText(page: PDFPage, number: number): boolean {
  for (const ref of contentRefs(page)) {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    let decoded: Uint8Array;
    try {
      decoded = decodePDFRawStream(stream).decode();
    } catch (err) {
      throw new VlmPdfError(
        `page ${number}'s content stream could not be decoded `
        + `(${err instanceof Error ? err.message : String(err)}), so this run cannot tell whether `
        + 'the page already has text on it. That question decides between a searchable page and a '
        + 'page whose every word matches twice, and it is not one to guess at.',
      );
    }
    if (showsText(decoded, number)) return true;
  }
  return false;
}

/**
 * A content stream's TOKENS, scanned for the four operators that show text.
 *
 * A tokeniser rather than a substring search, because `Tj` inside a string, a
 * name or an inline image's binary payload is not an operator, and a page
 * refused over one of those is a book that cannot be converted for no reason.
 * It skips exactly what the syntax says to skip (PDF 32000-1 §7.2) and reads
 * nothing else — this is not a content-stream interpreter and does not need to
 * be, because the only question is whether one of `Tj`, `TJ`, `'` and `"` is
 * ever reached as an operator.
 */
function showsText(source: Uint8Array, page: number): boolean {
  const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
  const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
  const SHOWS = new Set(['Tj', 'TJ', "'", '"']);
  let index = 0;

  while (index < source.length) {
    const byte = source[index];
    if (WHITESPACE.has(byte)) { index += 1; continue; }
    if (byte === 0x25) { // % comment, to the end of the line
      while (index < source.length && source[index] !== 0x0a && source[index] !== 0x0d) index += 1;
      continue;
    }
    if (byte === 0x28) { // ( literal string: nested, backslash-escaped
      let depth = 1;
      index += 1;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === 0x5c) index += 2;
        else {
          if (inner === 0x28) depth += 1;
          else if (inner === 0x29) depth -= 1;
          index += 1;
        }
      }
      continue;
    }
    if (byte === 0x3c) { // << dictionary, or < hex string
      if (source[index + 1] === 0x3c) { index += 2; continue; }
      while (index < source.length && source[index] !== 0x3e) index += 1;
      index += 1;
      continue;
    }
    if (byte === 0x3e) { index += source[index + 1] === 0x3e ? 2 : 1; continue; }
    if (byte === 0x2f) { // /Name — never an operator
      index += 1;
      while (index < source.length && !WHITESPACE.has(source[index]) && !DELIMITER.has(source[index])) {
        index += 1;
      }
      continue;
    }
    if (DELIMITER.has(byte)) { index += 1; continue; }

    const start = index;
    while (index < source.length && !WHITESPACE.has(source[index]) && !DELIMITER.has(source[index])) {
      index += 1;
    }
    const token = String.fromCharCode(...source.subarray(start, index));
    if (SHOWS.has(token)) return true;
    if (token === 'BI') index = skipInlineImage(source, index, page);
  }
  return false;
}

/**
 * Past an inline image, whose payload is arbitrary bytes that can spell
 * anything at all — including `Tj`.
 *
 * `ID` opens the data and `EI`, delimited on both sides, closes it. A stream
 * where that cannot be found is a stream this scanner has lost its place in,
 * and it says so rather than carrying on reading image bytes as operators.
 */
function skipInlineImage(source: Uint8Array, from: number, page: number): number {
  const delimits = (byte: number | undefined): boolean =>
    byte === undefined || byte <= 0x20 || byte === 0x2f || byte === 0x5b || byte === 0x3c;
  let index = from;
  while (index < source.length - 1) {
    if (source[index] === 0x49 && source[index + 1] === 0x44 && delimits(source[index - 1])) break;
    index += 1;
  }
  index += 3; // past `ID` and the single whitespace byte that follows it
  while (index < source.length - 1) {
    if (
      source[index] === 0x45 && source[index + 1] === 0x49
      && (source[index - 1] ?? 0x20) <= 0x20 && delimits(source[index + 2])
    ) {
      return index + 2;
    }
    index += 1;
  }
  throw new VlmPdfError(
    `page ${page} draws an inline image that never ends (no EI after its ID), so its content `
    + 'stream cannot be read to the end and this run cannot tell whether the page already has text '
    + 'on it. Nothing here guesses at that.',
  );
}
