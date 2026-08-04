/**
 * textlayer — the invisible text layer: what makes a scan a document.
 *
 * A scanned page is a picture of words. `get-text` gives it the words back:
 * one invisible text run per recognized line, positioned at that line's box, in
 * the order the page reads. This is the OCRmyPDF technique and it is the reason
 * the whole document pipeline can be document-in / document-out — after this
 * stage the PDF itself carries the text, so every later stage reads the
 * DOCUMENT rather than a run directory full of JSON that has to be kept in step
 * with it.
 *
 * Two consumers, and they want different things from the same layer:
 *
 *  - **A reader.** Select, copy and search have to work, which means the text
 *    has to be extractable (a `/ToUnicode` mapping) and has to sit on top of
 *    the ink it belongs to (a text matrix per line).
 *  - **`foundry reflow`.** It reads this layer back as the book's text, so the
 *    round trip has to be EXACT — every character out is the character that
 *    went in — and the geometry has to come back in the frame the scan measured
 *    it in, because that is the frame the paragraph rules are calibrated in.
 *
 * ## The font is glyphless on purpose
 *
 * The run is drawn in text rendering mode 3 (invisible), so no glyph is ever
 * rasterized and the FONT PROGRAM is irrelevant — what matters is the mapping
 * from the codes in the content stream to Unicode. So this writes a Type0 font
 * with `Identity-H` encoding and no embedded font file: the two-byte code IS
 * the UTF-16 code unit, and a `/ToUnicode` CMap says so for the whole Basic
 * Multilingual Plane. Nothing has to be measured, nothing has to be subset, and
 * a character outside any standard encoding — a ligature, a dagger, an accented
 * capital, a Greek word in a footnote — survives the trip unchanged.
 *
 * The alternative was a WinAnsi standard font, and it fails on exactly the
 * books foundry exists for: `ﬁ`, `†`, `—` and `Ü` all appear in a German
 * history scan, and WinAnsi can carry three of the four. A layer that silently
 * dropped the fourth would put a wrong word in a finished book.
 *
 * ## Widths: one number, so the arithmetic is exact
 *
 * The descendant font declares `/DW 500` and no `/W` array, so every glyph
 * advances exactly half an em. A line of `n` characters set at size `s` is then
 * `0.5·n·s` wide before the text matrix, and the horizontal scale that makes it
 * exactly as wide as its box is a division rather than a font-metrics
 * measurement. Characters are therefore evenly spread across the line, which is
 * the honest approximation: what is known about this line is where it STARTS
 * and where it ENDS, and pretending to know each glyph's position would be
 * inventing a measurement nobody made.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString,
  beginText, endText, popGraphicsState, pushGraphicsState, setFontAndSize,
  setTextMatrix, setTextRenderingMode, showText, TextRenderingMode,
} from '@cantoo/pdf-lib';

import type { Box } from '../scan/bands.js';
import { pxToPtX, pxToPtY, type PageFrame } from './frame.js';

/** The resource name the layer's font is registered under, on every page. */
const FONT_RESOURCE = PDFName.of('FoundryText');

/** Where the page records which content stream is foundry's text layer. */
export const TEXT_LAYER_KEY = PDFName.of('FoundryText');

/** Where the page records the straightening the scan applied before measuring. */
export const DESKEW_KEY = PDFName.of('FoundryDeskew');

/** Half an em per glyph — see the header. */
const GLYPH_WIDTH_EM = 0.5;

/** One recognized line, in the scan's pixel frame. */
export interface TextLayerLine {
  text: string;
  /** [x0,y0,x1,y1], half-open, top-left origin, px in the scan's frame. */
  box: Box;
}

export class TextLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextLayerError';
  }
}

/**
 * The `/ToUnicode` CMap: the identity over the BMP, in spec-legal blocks.
 *
 * A `bfrange` destination increments its LAST byte, so a range may not span
 * more than 256 codes — hence one range per high byte rather than one range for
 * the plane. It is the same 256 ranges for every document, which is what makes
 * the font static: a stage that REWRITES the layer (footnotes) never has to
 * discover that a character it kept is missing from a CMap built for the text
 * that was there before.
 */
export function toUnicodeCMap(): string {
  const ranges: string[] = [];
  for (let high = 0; high < 256; high++) {
    const lo = (high << 8).toString(16).padStart(4, '0');
    const hi = ((high << 8) | 0xff).toString(16).padStart(4, '0');
    ranges.push(`<${lo}> <${hi}> <${lo}>`);
  }
  const blocks: string[] = [];
  for (let i = 0; i < ranges.length; i += 100) {
    const part = ranges.slice(i, i + 100);
    blocks.push(`${part.length} beginbfrange\n${part.join('\n')}\nendbfrange`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Foundry-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

/**
 * Build the glyphless font, once per document, and return its reference.
 *
 * Registered on the document so repeated calls share one font object: a font
 * per page would be 256 CMap ranges per page for no gain.
 */
const FONT_CACHE = new WeakMap<PDFDocument, PDFRef>();

export function glyphlessFont(doc: PDFDocument): PDFRef {
  const cached = FONT_CACHE.get(doc);
  if (cached) return cached;

  const ctx = doc.context;
  const toUnicode = ctx.register(ctx.flateStream(toUnicodeCMap()));
  const descriptor = ctx.obj({
    Type: 'FontDescriptor',
    FontName: 'FoundryInvisible',
    // Symbolic: the font's built-in encoding governs, which is what a CID font
    // with no embedded program wants said about it.
    Flags: 4,
    FontBBox: [0, 0, 1000, 1000],
    ItalicAngle: 0,
    Ascent: 1000,
    Descent: 0,
    CapHeight: 1000,
    StemV: 80,
  });
  const descendant = ctx.obj({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: 'FoundryInvisible',
    CIDSystemInfo: {
      Registry: PDFString.of('Adobe'),
      Ordering: PDFString.of('Identity'),
      Supplement: 0,
    },
    FontDescriptor: ctx.register(descriptor),
    DW: GLYPH_WIDTH_EM * 1000,
    CIDToGIDMap: 'Identity',
  });
  const font = ctx.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'FoundryInvisible',
    Encoding: 'Identity-H',
    DescendantFonts: [ctx.register(descendant)],
    ToUnicode: toUnicode,
  });
  const ref = ctx.register(font);
  FONT_CACHE.set(doc, ref);
  return ref;
}

/** The content-stream bytes for one page's worth of lines. */
export function textLayerOperators(frame: PageFrame, lines: readonly TextLayerLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.text;
    if (text.length === 0) continue;
    const [x0, y0, x1, y1] = line.box;
    const left = pxToPtX(frame, x0);
    const right = pxToPtX(frame, x1);
    const baseline = pxToPtY(frame, y1);
    const size = pxToPtY(frame, y0) - baseline;
    const width = right - left;
    if (size <= 0 || width <= 0) {
      throw new TextLayerError(
        `page ${frame.page + 1}: the line "${text.slice(0, 40)}" has box [${line.box.join(',')}], which is `
        + 'empty in one dimension. A line with no extent has nowhere to put its text.',
      );
    }
    // Every glyph advances half an em, so the natural width of the run is
    // exact arithmetic rather than a metrics lookup — see the header.
    const natural = GLYPH_WIDTH_EM * size * text.length;
    const stretch = width / natural;
    const hex = hexUtf16(text);
    out.push(
      [
        pushGraphicsState(),
        beginText(),
        setTextRenderingMode(TextRenderingMode.Invisible),
        setFontAndSize(FONT_RESOURCE, size),
        setTextMatrix(stretch, 0, 0, 1, left, baseline),
        showText(PDFHexString.of(hex)),
        endText(),
        popGraphicsState(),
      ].map(op => op.toString()).join('\n'),
    );
  }
  return `${out.join('\n')}\n`;
}

/** UTF-16BE code units as hex — the Identity-H codes, one per code unit. */
function hexUtf16(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, '0');
  return out;
}

/**
 * Write the text layer onto one page.
 *
 * The stream is registered as its own content stream and the page records its
 * reference under `/FoundryText`, so a later stage can find foundry's layer
 * exactly — not "the last content stream", not "the one that looks like text".
 * Rewriting it (`rewriteTextLayer`) then replaces one object, which is one
 * clean incremental update.
 */
export function writeTextLayer(
  doc: PDFDocument, page: PDFDict, frame: PageFrame, lines: readonly TextLayerLine[],
): PDFRef {
  const ctx = doc.context;
  const existing = page.get(TEXT_LAYER_KEY);
  if (existing !== undefined) {
    throw new TextLayerError(
      `page ${frame.page + 1} already carries a foundry text layer. get-text casts a working document `
      + 'from the ORIGINAL PDF; run it against the original, not against a working document it '
      + 'already produced.',
    );
  }

  const fontRef = glyphlessFont(doc);
  const resources = resourcesOf(doc, page);
  const fonts = subDict(doc, resources, PDFName.of('Font'));
  fonts.set(FONT_RESOURCE, fontRef);

  const streamRef = ctx.register(ctx.flateStream(textLayerOperators(frame, lines)));
  addContentStream(doc, page, streamRef);
  page.set(TEXT_LAYER_KEY, streamRef);
  if (frame.deskewDeg !== 0) {
    page.set(DESKEW_KEY, ctx.obj(frame.deskewDeg));
  }
  return streamRef;
}

/**
 * Replace the text layer foundry wrote, in place.
 *
 * The stream object is reassigned rather than a new one appended, so the page's
 * `/Contents` and every other object are untouched and the update carries one
 * object: the text. Used by `footnotes --pdf`, which changes what the layer
 * SAYS and nothing about where it is.
 */
export function rewriteTextLayer(
  doc: PDFDocument, page: PDFDict, frame: PageFrame, lines: readonly TextLayerLine[],
): PDFRef {
  const ref = page.get(TEXT_LAYER_KEY);
  if (!(ref instanceof PDFRef)) {
    throw new TextLayerError(
      `page ${frame.page + 1} has no foundry text layer to rewrite. Only a working document cast by `
      + '`foundry get-text` carries one; a document that arrived with its own text layer has the '
      + "publisher's text in it, which foundry does not rewrite.",
    );
  }
  doc.context.assign(ref, doc.context.flateStream(textLayerOperators(frame, lines)));
  return ref;
}

/** Does this page carry a foundry-written text layer? */
export function hasTextLayer(page: PDFDict): boolean {
  return page.get(TEXT_LAYER_KEY) instanceof PDFRef;
}

function resourcesOf(doc: PDFDocument, page: PDFDict): PDFDict {
  const existing = page.get(PDFName.of('Resources'));
  if (existing instanceof PDFRef) return doc.context.lookup(existing, PDFDict);
  if (existing instanceof PDFDict) return existing;
  const created = doc.context.obj({});
  page.set(PDFName.of('Resources'), created);
  return created;
}

function subDict(doc: PDFDocument, parent: PDFDict, key: PDFName): PDFDict {
  const existing = parent.get(key);
  if (existing instanceof PDFRef) return doc.context.lookup(existing, PDFDict);
  if (existing instanceof PDFDict) return existing;
  const created = doc.context.obj({});
  parent.set(key, created);
  return created;
}

/**
 * Append a content stream to a page, whatever shape its `/Contents` is in.
 *
 * A page's contents are legally one stream OR an array of streams that
 * concatenate, and both shapes turn up in real books. Appending means the text
 * is drawn last, which is what a text layer wants — nothing after it can change
 * the graphics state it ran in.
 */
function addContentStream(doc: PDFDocument, page: PDFDict, streamRef: PDFRef): void {
  const key = PDFName.of('Contents');
  const contents = page.get(key);
  if (contents instanceof PDFArray) {
    contents.push(streamRef);
    return;
  }
  if (contents === undefined) {
    page.set(key, doc.context.obj([streamRef]));
    return;
  }
  // A single stream (or a reference to one): wrap it in an array so the layer
  // can follow it.
  page.set(key, doc.context.obj([contents, streamRef]));
}
