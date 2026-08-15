/**
 * The text-PDF emitter: the scan set again as type on new paper.
 *
 * This format used to lay invisible text over the scan, and every test it had
 * was about something a person looking at the file could not check. Half of that
 * inverted when the type became visible — a layer drawn in the wrong rendering
 * mode is now a blank book, which anybody notices — and what replaced it is a
 * defect nobody notices: the pixels are gone, so anything the model failed to
 * read is not merely unsearchable, it is NOT IN THE FILE.
 *
 * So the tests are about what survives, and about the decisions that cannot be
 * seen from one page:
 *
 *  - THE ARITHMETIC, pinned to exact numbers. Render pixels → points, and the
 *    y-flip between an image's rows and PDF user space.
 *  - THE SCAN IS GONE AND THE TEXT IS THERE. "The scan came through anyway" and
 *    "the text never went down" are the two ways this could look right and be
 *    wrong.
 *  - PAGE-FOR-PAGE. A page silently dropped renumbers the book, and a citation
 *    to page 142 is the thing this format exists to keep.
 *  - THE LINES ARE THE PRINTER'S WHERE THEY CAN BE. The gate that decides it is
 *    the single most consequential judgement in the file: believing a reflowed
 *    paragraph's one segment sets 970 characters as one line, and disbelieving a
 *    real one throws away the page's own hyphenation. Both directions are here.
 *  - THE SIZE IS A MEASUREMENT, NOT A FIT. The book states its size through its
 *    leading and its column, and neither statement is about our font. A test
 *    that only asked "does it fit" would pass on the version that set a
 *    nine-point book at seven and three-quarters.
 *  - EMPHASIS IS EVIDENCE. `*italic*` is the model's own word about the page,
 *    and this book's notes are made of it.
 *  - A MARK IS RAISED ONLY WHEN THE PAGE PROVES IT IS ONE — so the negative case
 *    (a year, a page citation) matters more than the positive one.
 *  - THE FURNITURE SURVIVES. A facsimile that loses a folio has renumbered the
 *    book. The guard at the bottom carries the story of the bank it took to work
 *    out that the folio was never in the reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
  rgb,
} from 'pdf-lib';

import { vlmConvert } from '../../src/vlm/convert.js';
import { parseDotsPage, type DotsBlock } from '../../src/vlm/dots.js';
import { applyOverlay, parseOverlay } from '../../src/vlm/overlay.js';
import {
  boxToDisplay,
  buildTextPdf,
  displaySize,
  pointsPerPixel,
  VlmPdfError,
  type PageFrame,
  type PdfCropRequest,
  type PdfCropped,
  type PdfTextPage,
} from '../../src/vlm/pdf-text.js';

/**
 * The frame of a real page of a real book: 468×760 pt, rendered at foundry's
 * pinned 200 dpi, which is the 1300×2112 the models were measured on.
 *
 * 1300 is exactly 468 × 200/72; 2112 is NOT exactly 760 × 200/72, which is
 * 2111.11, and the rasteriser rounds up. The two axes therefore have slightly
 * different points-per-pixel, and every number below is computed with that
 * asymmetry rather than with a single 0.36.
 */
const RENDER = { width: 1300, height: 2112 };
const FRAME: PageFrame = {
  crop: { x: 0, y: 0, width: 468, height: 760 },
  rotation: 0,
  render: RENDER,
};

// ── the arithmetic ──────────────────────────────────────────────────────────

test('a render at the pinned dpi measures 72/200 points per pixel on each axis', () => {
  const scale = pointsPerPixel(FRAME);
  assert.equal(scale.x, 468 / 1300);
  assert.equal(scale.x, 0.36);
  // Not 0.36: 2112 rows for a page 2111.11 rows tall at 200 dpi.
  assert.equal(scale.y, 760 / 2112);
  assert.ok(Math.abs(scale.y - 0.36) < 0.0002);
});

test('a quarter turn swaps the sides of the page the render is of', () => {
  assert.deepEqual(displaySize(FRAME), { width: 468, height: 760 });
  assert.deepEqual(displaySize({ ...FRAME, rotation: 180 }), { width: 468, height: 760 });
  assert.deepEqual(displaySize({ ...FRAME, rotation: 90 }), { width: 760, height: 468 });
  assert.deepEqual(displaySize({ ...FRAME, rotation: 270 }), { width: 760, height: 468 });
});

test('a box in the render maps to points with y counted the other way', () => {
  // A block 200 px in from the left and 300 px down from the top, 900 px wide
  // and 60 px tall. x is pixels × 0.36. The TOP of the box in image rows is the
  // HIGH y in user space, and a rectangle's `y` is its bottom edge.
  const rect = boxToDisplay({ x1: 200, y1: 300, x2: 1100, y2: 360 }, FRAME);
  assert.equal(rect.x, 72);
  assert.equal(rect.width, 324);
  assert.equal(rect.y, 760 - 360 * (760 / 2112));
  assert.ok(Math.abs(rect.y - 630.4545454545455) < 1e-9);
  // Within a float's noise of 60 × (760/2112): the height is a DIFFERENCE of
  // two mapped edges, so it carries the rounding of both.
  assert.ok(Math.abs(rect.height - 21.590909090909093) < 1e-9);
});

test('the whole render maps to the whole page, corner for corner', () => {
  assert.deepEqual(
    boxToDisplay({ x1: 0, y1: 0, x2: 1300, y2: 2112 }, FRAME),
    { x: 0, y: 0, width: 468, height: 760 },
  );
});

// ── the fixtures ────────────────────────────────────────────────────────────

/**
 * The grey the scan's own ink is drawn in, and the string it becomes in a
 * content stream. Asserted ABSENT: this format throws the pixels away, and a
 * scan that came through anyway would look like success while weighing what it
 * always weighed.
 */
const SCAN_INK = '0.94 0.94 0.94 rg';

/** A scan: pages with ink on them and not one glyph. */
async function scanOf(pages: number, rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([468, 760]);
    page.drawRectangle({ x: 36, y: 36, width: 396, height: 688, color: rgb(0.94, 0.94, 0.94) });
    if (rotation !== 0) page.setRotation(degrees(rotation));
  }
  return doc.save();
}

/**
 * A 1×1 PNG, standing in for whatever the cropper would really have cut.
 *
 * The test is not about the pixels — `vlm_page.py` cuts those and is not in this
 * process — it is about whether an image reached the page it was asked for, at
 * the rectangle it was printed in.
 */
const ONE_PIXEL_PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));

/** Every crop that was asked for, answered — and the asking recorded. */
function cropper(): {
  crop: (requests: readonly PdfCropRequest[]) => Promise<readonly PdfCropped[]>;
  asked: PdfCropRequest[];
} {
  const asked: PdfCropRequest[] = [];
  return {
    asked,
    crop: async (requests) => {
      asked.push(...requests);
      return requests.map((request) => ({
        name: request.name,
        mediaType: 'image/png',
        data: ONE_PIXEL_PNG,
      }));
    },
  };
}

/**
 * A page of printed LINES — the shape the model returns when it keeps the
 * page's own breaks, which is what `trustsItsLines` has to recognise.
 *
 * Eleven lines of about eighty-five characters in a box eleven printed lines
 * deep. Every number here is taken off the Kershaw bank: 36 render pixels a
 * line, a 165..1128 column, and lines that end mid-word because the printer
 * hyphenated them.
 */
function linedBlock(top: number, lines: number): PdfTextPage['blocks'][number] {
  const printed = [
    'extracting decisions from him. Lammers himself, for example, wrote plain-',
    'tively to Hitler\'s adjutant on 21 October 1938 begging for an audience to',
    'report to the Führer on a number of urgent matters which needed resolu-',
    'tion and which had been building up since the last occasion when he had',
    'been able to provide a detailed report, on 4 September of that same year.',
  ];
  return {
    box: { x1: 165, y1: top, x2: 1128, y2: top + lines * 36 },
    category: 'Text',
    text: Array.from({ length: lines }, (_, index) => printed[index % printed.length]).join('\n'),
  };
}

/** The same words with the breaks thrown away — what a reflowed block looks like. */
function reflowedBlock(top: number, lines: number): PdfTextPage['blocks'][number] {
  const block = linedBlock(top, lines);
  return { ...block, text: block.text.replace(/-\n/g, '').replace(/\n/g, ' ') };
}

/** A page of printed lines, deep enough that a class has blocks to measure. */
function linedPage(page: number): PdfTextPage {
  return {
    page,
    render: RENDER,
    blocks: [linedBlock(240, 11), linedBlock(700, 9), linedBlock(1080, 7)],
  };
}

/** Every content stream of a page, decompressed, in order, as one string. */
async function contentOf(bytes: Uint8Array, page: number): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const raw = doc.getPage(page - 1).node.get(PDFName.of('Contents'))!;
  const resolved = raw instanceof PDFArray ? raw : doc.context.lookup(raw);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [raw];
  return refs
    .map((ref) => doc.context.lookup(ref))
    .filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    .join('\n');
}

/**
 * Every run of glyphs a page shows, in the order it shows them.
 *
 * ONE RUN PER PIECE, NOT PER LINE. Every word is positioned by its own `Tm` —
 * that is how justification, the squeeze and the hanging indent are all applied
 * — and a word splits further wherever its face changes, because `*Ibid.*,` is
 * an italic word and a roman comma.
 */
function shownText(content: string): string[] {
  return [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((match) => match[1]);
}

/**
 * How many characters one shown run is.
 *
 * The faces are embedded as subsets with two-byte glyph ids and a byte is two
 * hex digits, so a run's hex is exactly four times its characters.
 */
function shownLength(hex: string): number {
  return hex.length / 4;
}

/** Everything a page set, as one character count. */
function shownChars(content: string): number {
  return shownText(content).reduce((sum, run) => sum + shownLength(run), 0);
}

/**
 * A page's text, decoded back to characters through each face's own ToUnicode
 * map, one string per baseline, top row first.
 *
 * `shownText` counts glyphs; these tests need to know WHICH glyphs, because the
 * difference between an asterisk and a bullet, or between "superficial
 * similarities" and "superficialsimilarities", is invisible to a count. The
 * subset fonts carry ToUnicode precisely so a reader can get the characters
 * back, so the test reads them the way a reader would.
 */
async function decodedRows(bytes: Uint8Array, page: number): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const node = doc.getPage(page - 1).node;

  const maps = new Map<string, Map<number, string>>();
  const fonts = node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  for (const key of fonts?.keys() ?? []) {
    const font = fonts!.lookupMaybe(key, PDFDict);
    const to = font?.get(PDFName.of('ToUnicode'));
    const stream = to === undefined ? undefined : doc.context.lookup(to);
    if (!(stream instanceof PDFRawStream)) continue;
    const cmap = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    const glyphs = new Map<number, string>();
    const decode = (hex: string): string => String.fromCharCode(
      ...(hex.match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)),
    );
    // Parsed SECTION BY SECTION: a bare scan for <..> pairs would swallow the
    // codespacerange and then pair every bfchar entry off by one for the rest
    // of the file.
    for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const entry of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        glyphs.set(parseInt(entry[1], 16), decode(entry[2]));
      }
    }
    for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const entry of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const first = parseInt(entry[1], 16);
        const last = parseInt(entry[2], 16);
        const start = parseInt(entry[3], 16);
        for (let id = first; id <= last; id += 1) {
          glyphs.set(id, String.fromCharCode(start + (id - first)));
        }
      }
    }
    maps.set(key.decodeText(), glyphs);
  }

  const content = await contentOf(bytes, page);
  const rows = new Map<string, { y: number; text: string }>();
  let current: Map<number, string> | undefined;
  let y = 0;
  const ops = /\/(\w+) [\d.]+ Tf|1 0 0 1 [\d.-]+ ([\d.-]+) Tm|<([0-9A-Fa-f]+)> Tj/g;
  for (const op of content.matchAll(ops)) {
    if (op[1] !== undefined) current = maps.get(op[1]);
    else if (op[2] !== undefined) y = Number(op[2]);
    else {
      const text = (op[3].match(/.{4}/g) ?? [])
        .map((id) => current?.get(parseInt(id, 16)) ?? '�')
        .join('');
      const key = y.toFixed(1);
      const row = rows.get(key);
      if (row === undefined) rows.set(key, { y, text });
      else row.text += text;
    }
  }
  return [...rows.values()].sort((a, b) => b.y - a.y).map((row) => row.text);
}

/**
 * How many characters a block's text SHOULD put on the page.
 *
 * Every word carries the space that followed it, so a copy of the page reads as
 * a sentence — which means the drawn character count is the text with its runs
 * of whitespace collapsed, and with no trailing space at the end of a line
 * because nothing followed the last word. That is the number `shownChars` will
 * report, and computing it here rather than writing it out by hand is what lets
 * these tests state the fixture's own text as the expectation.
 */
function inkOf(text: string): number {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0)
    .reduce((sum, line) => sum + line.length, 0);
}

/**
 * How many spaces re-wrapping this text ADDS to `inkOf`'s count: one per joined
 * line break, except where the printer's own hyphen makes the join bare.
 */
function joinedSpacesOf(text: string): number {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(0, -1).filter((line) => !/\p{L}-$/u.test(line)).length;
}

/** One drawn piece: where it was put, in what face, at what size. */
interface Piece {
  face: string;
  size: number;
  x: number;
  y: number;
  chars: number;
}

/** Every piece a page drew, in order. */
function pieces(content: string): Piece[] {
  const out: Piece[] = [];
  let face = '';
  let size = 0;
  let at: { x: number; y: number } | null = null;
  for (const line of content.split('\n')) {
    const tf = /^\/(Foundry\w+) ([\d.]+) Tf$/.exec(line);
    if (tf) { face = tf[1]; size = Number(tf[2]); }
    const tm = /^1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm$/.exec(line);
    if (tm) at = { x: Number(tm[1]), y: Number(tm[2]) };
    const tj = /^<([0-9A-Fa-f]+)> Tj$/.exec(line);
    if (tj && at !== null) {
      out.push({ face, size, x: at.x, y: at.y, chars: shownLength(tj[1]) });
    }
  }
  return out;
}

/**
 * The page's LINES, rebuilt from its pieces by grouping on the baseline.
 *
 * Every test below that asks "how many lines" or "where does this line start"
 * asks it through here. The drawing model positions words, not lines, so the
 * line is a fact about the output rather than a thing the output states — and a
 * helper that recovers it is what keeps those tests readable.
 */
function linesOf(content: string): { y: number; x: number; size: number; chars: number }[] {
  const rows = new Map<string, { y: number; x: number; size: number; chars: number }>();
  for (const piece of pieces(content)) {
    // A raised mark sits on its own baseline; it belongs to the line it follows.
    const key = piece.y.toFixed(1);
    const row = rows.get(key);
    if (row === undefined) {
      rows.set(key, { y: piece.y, x: piece.x, size: piece.size, chars: piece.chars });
    } else {
      row.x = Math.min(row.x, piece.x);
      row.size = Math.max(row.size, piece.size);
      row.chars += piece.chars;
    }
  }
  return [...rows.values()].sort((a, b) => b.y - a.y);
}

// ── the document ────────────────────────────────────────────────────────────

test('the text is set visibly and the scan it was read from is not in the file', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(2),
    dpi: 200,
    crop,
    pages: [
      { page: 1, render: RENDER, blocks: [linedBlock(300, 5)] },
      {
        page: 2,
        render: RENDER,
        // A folio: page furniture, which no book route writes and this one reprints.
        blocks: [{ box: { x1: 100, y1: 1900, x2: 400, y2: 1950 }, category: 'Page-footer', text: '142' }],
      },
    ],
  });

  const back = await PDFDocument.load(built.bytes, { updateMetadata: false });
  assert.equal(back.getPageCount(), 2);
  assert.deepEqual(back.getPage(0).getSize(), { width: 468, height: 760 });
  assert.equal(built.textPages, 2);
  assert.deepEqual(built.facsimilePages, []);
  assert.equal(built.pictures, 0);

  const content = await contentOf(built.bytes, 1);
  // `0 Tr` and not `3 Tr`: the whole difference between this format and the one
  // it replaced is that number, so it is written down rather than defaulted.
  assert.match(content, /^0 Tr$/m, 'the type is not being filled');
  assert.doesNotMatch(content, /^3 Tr$/m, 'the type is still invisible');
  assert.match(content, /^0 0 0 rg$/m, 'the type has no stated colour');
  assert.match(content, /\bBT\b/);
  // THE PIXELS ARE GONE. The page's own ink was a grey rectangle and there is no
  // grey rectangle in the output — what is there is white paper and words.
  assert.ok(!content.includes(SCAN_INK), 'the scan came through into the output');
  assert.match(content, /^1 1 1 rg$/m, 'the paper is not painted');
  // A book with no emphasis in it carries ONE face and pays nothing for the
  // other three: `embedFaces` reads off disk only what the text asks for.
  const fonts = back.getPage(0).node.Resources()!.lookup(PDFName.Font, PDFDict)!;
  assert.deepEqual(fonts.keys().map(String), ['/FoundryRoman']);
  // Five printed lines went down as five lines, and every character of them.
  assert.equal(linesOf(content).length, 5);
  assert.equal(shownChars(content), linedBlock(300, 5).text.replace(/\n/g, '').length);
});

test('every page of the input is a page of the output, at the size it displayed at', async () => {
  const { crop, asked } = cropper();
  // Three pages, one reading. The other two have never been read and cannot be
  // invented — and they must still be pages 2 and 3.
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    pages: [{ page: 1, render: RENDER, blocks: [linedBlock(300, 5)] }],
    crop,
  });

  const back = await PDFDocument.load(built.bytes, { updateMetadata: false });
  assert.equal(back.getPageCount(), 3);
  for (const index of [0, 1, 2]) {
    assert.deepEqual(back.getPage(index).getSize(), { width: 468, height: 760 });
  }
  // Named, not counted: "pages 2 and 3 are still photographs" is an instruction.
  assert.deepEqual(built.facsimilePages, [2, 3]);
  assert.equal(built.textPages, 1);

  // Each of them asked for its whole page, in render pixels at the pinned dpi.
  assert.deepEqual(asked.map((request) => request.page), [2, 3]);
  assert.equal(asked[0].box.x2, (468 * 200) / 72);
  assert.equal(asked[0].box.y2, (760 * 200) / 72);

  // Page 1 is type and no image; pages 2 and 3 are an image and no type.
  assert.ok(shownChars(await contentOf(built.bytes, 1)) > 0);
  for (const number of [2, 3]) {
    const content = await contentOf(built.bytes, number);
    assert.equal(shownText(content).length, 0, `page ${number} invented text`);
    assert.match(content, /\/Image-\d+ Do/, `page ${number} came out blank`);
    assert.match(content, /468(\.\d+)? 0 0 760(\.\d+)? 0 0 cm/);
  }
});

test('a page that displays turned comes out turned, and the type with it', async () => {
  const { crop } = cropper();
  /*
   * /Rotate 90 makes a 468×760 page display as 760×468, and PyMuPDF rasterises
   * what displays — so the model's boxes are in the landscape frame and the new
   * page has to BE that frame. Getting this wrong is the failure that looks most
   * like success: a book of pages that open the wrong way round.
   */
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1, 90),
    dpi: 200,
    pages: [{
      page: 1,
      render: { width: 2112, height: 1300 },
      blocks: [{ box: { x1: 200, y1: 300, x2: 1100, y2: 360 }, category: 'Text', text: 'sideways' }],
    }],
    crop,
  });
  const back = await PDFDocument.load(built.bytes, { updateMetadata: false });
  assert.deepEqual(back.getPage(0).getSize(), { width: 760, height: 468 });
  // No /Rotate of its own: the page IS the display frame, so there is nothing
  // left for a viewer to turn.
  assert.equal(back.getPage(0).getRotation().angle, 0);
  assert.equal(shownChars(await contentOf(built.bytes, 1)), inkOf('sideways'));
});

test('the blocks are shown in the order they were given, furniture included', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    pages: [{
      page: 1,
      render: RENDER,
      // A running head at the top, then the body, then the folio — the model's
      // own reading order, which is not the order either list arrives in.
      blocks: [
        { box: { x1: 200, y1: 100, x2: 1100, y2: 140 }, category: 'Page-header', text: 'RUNNING HEAD' },
        { box: { x1: 200, y1: 300, x2: 1100, y2: 360 }, category: 'Text', text: 'body of the page' },
        { box: { x1: 600, y1: 1990, x2: 700, y2: 2030 }, category: 'Page-footer', text: '142' },
      ],
    }],
    crop,
  });
  const drawn = pieces(await contentOf(built.bytes, 1));
  // Read back in the order they were placed: a PDF's extraction order is its
  // placement order, and a folio arriving before the page's first sentence is a
  // copy-and-paste nobody can use.
  assert.equal(drawn[0].chars, 'RUNNING '.length);
  assert.equal(drawn[1].chars, 'HEAD'.length);
  assert.equal(drawn[drawn.length - 1].chars, '142'.length);
  assert.equal(shownChars(await contentOf(built.bytes, 1)),
    inkOf('RUNNING HEAD') + inkOf('body of the page') + inkOf('142'));
});

// ── the lines are the printer's, where they can be ──────────────────────────

test('a block whose printed lines survived is set line for line, hyphens and all', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    crop,
    pages: [1, 2, 3].map((page) => ({
      page,
      render: RENDER,
      blocks: linedPage(page).blocks,
    })),
  });

  // Every block took the printer's own breaks; none was rewrapped.
  assert.equal(built.lineForLine.wrapped, 0, 'a line-for-line block was rewrapped');
  assert.equal(built.lineForLine.blocks, 9);
  assert.equal(built.lineForLine.lines, 3 * (11 + 9 + 7));

  const content = await contentOf(built.bytes, 1);
  assert.equal(linesOf(content).length, 27);
  /*
   * THE PRINTER'S HYPHEN SURVIVED, which is the whole dividend of setting line
   * for line. `plain-` ends a line in the source and ends a line here; nothing
   * re-broke the paragraph, so nothing had to decide where to hyphenate it.
   */
  const first = linesOf(content)[0];
  assert.equal(first.chars,
    inkOf('extracting decisions from him. Lammers himself, for example, wrote plain-'));
});

test('a reflowed block is NOT believed, and is rewrapped onto the lines its box implies', async () => {
  const { crop } = cropper();
  /*
   * The same words with the breaks thrown away — which is what the model returns
   * for about half the blocks in a real bank, and says nothing about. Believed,
   * its ONE segment would be set as one line of 350 characters in an eleven-line
   * box. The gate catches it: one segment in that box is 396 pt a "line", which
   * is not a printed line on any page.
   */
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    crop,
    pages: [1, 2, 3].map((page) => ({
      page,
      render: RENDER,
      blocks: [reflowedBlock(240, 11), reflowedBlock(700, 9)],
    })),
  });

  assert.equal(built.lineForLine.blocks, 0, 'a reflowed block was taken at its word');
  assert.equal(built.lineForLine.wrapped, 6);

  // It came out on many lines, not one — and near the count its box implies.
  const lines = linesOf(await contentOf(built.bytes, 1));
  assert.ok(lines.length >= 14, `the block came out on ${lines.length} line(s)`);
  // Every line inside the two boxes, which together span 240..1330 px.
  const top = 760 - 240 * (760 / 2112);
  const bottom = 760 - 1330 * (760 / 2112);
  for (const line of lines) {
    assert.ok(line.y <= top + 1 && line.y >= bottom - 2, `a line escaped its box at ${line.y}`);
  }
});

test('a block of notes is not mistaken for a block of lines', async () => {
  const { crop } = cropper();
  /*
   * THE CASE THAT BROKE THE FIRST VERSION OF THIS DESIGN. A Footnote block holds
   * several NOTES separated by newlines, and dividing its box by them lands
   * inside the band a printed line occupies — so the height test alone said
   * "these are lines" about segments that were each a whole note. Set line for
   * line, every note became one line and the class came out at 2.75 pt.
   *
   * The second, independent estimate is what catches it: the book's own
   * character width says that much text takes about twenty lines in that box,
   * not five, and the two counts have to agree.
   */
  const note = 'Institut für Zeitgeschichte, Munich, Nuremberg Document no. NG-5428; trans. '
    + 'Noakes and Pridham, Nazism, ii. 245, and the related correspondence in the files of '
    + 'the Reich Chancellery for the same month, which has clearly shown as much.';
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    crop,
    pages: [1, 2, 3].map((page) => ({
      page,
      render: RENDER,
      blocks: [
        linedBlock(240, 11),
        {
          box: { x1: 164, y1: 1214, x2: 1127, y2: 1826 },
          category: 'Footnote' as const,
          text: [14, 15, 16, 17, 18].map((n) => `${n} ${note}`).join('\n'),
        },
      ],
    })),
  });

  // The notes block was rewrapped; the body block above it was not.
  assert.equal(built.lineForLine.blocks, 3, 'the notes were taken for printed lines');
  assert.equal(built.lineForLine.wrapped, 3);
  // And the footnote class came out a readable size rather than 2.75 pt.
  const footnote = built.classSizes['footnote'];
  assert.ok(footnote === undefined || footnote > 5, `footnotes were set at ${footnote} pt`);
});

// ── the size is a measurement ───────────────────────────────────────────────

test('the type is set at the size the page was printed at, not at what the font can fit', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    crop,
    pages: [1, 2, 3].map((page) => ({
      page,
      render: RENDER,
      blocks: linedPage(page).blocks,
    })),
  });

  /*
   * The fixture's leading is 36 render px = 12.96 pt, so the page was printed at
   * about 12.96/1.2 = 10.8 pt. Our face is wider than the book's, so a size
   * chosen by what FITS would land near 7.5 — which is exactly what this file
   * used to do, and exactly the "smaller than the scan" complaint. The measured
   * answer has to be far closer to the leading's than to the fit's.
   */
  const body = built.classSizes['body'];
  assert.ok(body !== undefined, 'the body class was never measured');
  assert.ok(body > 8.6, `body was set at ${body} pt, which is the fit talking, not the leading`);
  assert.ok(body <= 10.8 + 1e-6, `body was set at ${body} pt, above what the leading allows`);

  // Uniform: one size for every body line in the book.
  const seen = new Set<string>();
  for (const page of [1, 2, 3]) {
    for (const match of (await contentOf(built.bytes, page)).matchAll(/^\/Foundry\w+ ([\d.]+) Tf$/gm)) {
      seen.add(match[1]);
    }
  }
  assert.equal(seen.size, 1, `the book was set at ${seen.size} different sizes`);
});

test('a block fills the box it was printed in, top to bottom', async () => {
  const { crop } = cropper();
  /*
   * THE WHITE-GAP TEST. The leading is the box over the line count, so the lines
   * span the rectangle by construction. When the size was solved from what the
   * font could fit, a paragraph stopped short of the bottom of its own box and
   * left a gap the printed page does not have.
   */
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    crop,
    pages: [1, 2, 3].map((page) => ({
      page, render: RENDER, blocks: [linedBlock(240, 11)],
    })),
  });

  const lines = linesOf(await contentOf(built.bytes, 1));
  assert.equal(lines.length, 11);
  const boxTop = 760 - 240 * (760 / 2112);
  const boxBottom = 760 - (240 + 11 * 36) * (760 / 2112);
  const leading = lines[0].y - lines[1].y;
  // The first baseline sits one leading below the top, the last one leading
  // above the bottom — so eleven lines span the box with nothing left over.
  assert.ok(Math.abs((boxTop - lines[0].y) - (leading - 0.21 * lines[0].size)) < 0.05);
  assert.ok(lines[lines.length - 1].y - boxBottom < leading, 'the block stopped short of its box');
});

test('a block the squeeze cannot fit gives up its line count and says so', async () => {
  const { crop } = cropper();
  const pages = [1, 2, 3].map((page) => ({
    page,
    render: RENDER,
    blocks: [
      linedBlock(240, 11),
      // One box drawn round a third of the width its text needs.
      page !== 2 ? linedBlock(700, 9) : {
        box: { x1: 165, y1: 700, x2: 500, y2: 1024 },
        category: 'Text' as const,
        text: linedBlock(700, 9).text,
      },
    ],
  }));
  const built = await buildTextPdf({ pdfBytes: await scanOf(3), dpi: 200, pages, crop });

  assert.ok(built.cramped !== null, 'an unfittable block was not reported');
  assert.deepEqual(built.cramped.pages, [2]);
  // The words are all still there — the last resort is smaller type, never
  // fewer words. The narrow block is re-wrapped, and a re-wrapped block DRAWS a
  // space at every joined line break that did not end in a hyphen: the break
  // itself was a space, and losing it is how "superficial" once fused against
  // "similarities". The line-for-line block beside it joins nothing and adds
  // nothing.
  const content = await contentOf(built.bytes, 2);
  const expected = inkOf(pages[1].blocks[0].text)
    + inkOf(pages[1].blocks[1].text) + joinedSpacesOf(pages[1].blocks[1].text);
  assert.equal(shownChars(content), expected);
});

test('a printed line wider than the class size costs the block size, never its lines', async () => {
  const { crop } = cropper();
  /*
   * THE SPARSE-BLOCK TEST. Page 2's middle block is the same eleven printed
   * lines in a box drawn an eighth narrower — the one-in-five case
   * `FIT_QUANTILE` prices in, where a line is wider than the class size can
   * set. The first cut of this file handed such a block to the wrapping path,
   * which re-broke the printer's lines at our widths and stretched the leading
   * over the shortfall: one sparse paragraph in the middle of a faithful page.
   * The lines are the facsimile; the block must keep them and pay in size.
   */
  const narrow = { ...linedBlock(700, 9), box: { x1: 165, y1: 700, x2: 1008, y2: 1024 } };
  const pages = [1, 2, 3].map((page) => ({
    page,
    render: RENDER,
    blocks: page === 2
      ? [linedBlock(240, 11), narrow, linedBlock(1080, 7)]
      : linedPage(page).blocks,
  }));
  const built = await buildTextPdf({ pdfBytes: await scanOf(3), dpi: 200, pages, crop });

  // Its printed lines, kept: the page still breaks where the book did.
  const rows = await decodedRows(built.bytes, 2);
  assert.equal(rows.length, 11 + 9 + 7);
  const kept = rows.slice(11, 20);
  for (const [index, line] of narrow.text.split('\n').entries()) {
    assert.equal(kept[index].trimEnd(), line);
  }
  // And the cost was size, said out loud.
  assert.ok(built.cramped !== null, 'the shrunken block went unreported');
  assert.deepEqual(built.cramped.pages, [2]);
});

test('a re-wrapped block keeps the space where the printed break was', async () => {
  const { crop } = cropper();
  /*
   * "superficialsimilarities". A block that loses its printed lines — here, a
   * box far too tall for its two segments, so the band throws them out — is
   * re-broken at our widths, and the word that ended one printed line meets the
   * word that opened the next. The break WAS a space; fusing them made words no
   * search finds, at exactly the points the page once broke. The hyphenated
   * break is the one exception: its halves join bare, hyphen kept.
   */
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [{
        box: { x1: 165, y1: 240, x2: 1128, y2: 940 },
        category: 'Text',
        text: 'despite superficial\nsimilarities in forms of domination, the two regimes were more un-\nlike each other than alike',
      }],
    }],
  });

  const text = (await decodedRows(built.bytes, 1)).join(' ');
  assert.ok(text.includes('superficial similarities'), `the break lost its space: ${text}`);
  assert.ok(text.includes('un-like'), 'the hyphenated join gained a space it must not have');
  assert.ok(!text.includes('superficialsimilarities'));
});

test('a markdown list marker is set as the bullet it stood for', async () => {
  const { crop } = cropper();
  // The model that writes *emphasis* writes "* " for the bullet it saw. The
  // page printed ● Stalin, not * Stalin — and an asterisk mid-sentence is not a
  // marker and stays exactly as written.
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [{
        box: { x1: 165, y1: 240, x2: 1128, y2: 348 },
        category: 'Text',
        text: '* Stalin arose from within a system of rule, rated 5 * by nobody.',
      }],
    }],
  });

  const text = (await decodedRows(built.bytes, 1)).join(' ');
  assert.ok(text.startsWith('• Stalin'), `the marker survived as ink: ${text}`);
  assert.ok(text.includes('5 * by'), 'an asterisk that was ink got swept up with the notation');
});

// ── emphasis, in real faces ─────────────────────────────────────────────────

test('the model\'s emphasis is set in a real italic and bold face', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [{
        box: { x1: 165, y1: 300, x2: 1128, y2: 480 },
        category: 'Footnote',
        // What this book's notes are actually made of: a book title in italic,
        // with the punctuation after it back in roman.
        text: 'See Jochmann, *Monologe*, 158-60; and **Rebentisch**, *Führerstaat*, 30.',
      }],
    }],
  });

  assert.equal(built.emphasis, 3);
  const content = await contentOf(built.bytes, 1);
  const used = new Set(pieces(content).map((piece) => piece.face));
  assert.ok(used.has('FoundryItalic'), 'the italic face was never used');
  assert.ok(used.has('FoundryBold'), 'the bold face was never used');
  assert.ok(used.has('FoundryRoman'), 'the roman face was never used');

  // The markers are GONE from the page and the words are not: an asterisk the
  // printer never set must not be drawn, and `Monologe` must still be there.
  const italic = pieces(content).filter((piece) => piece.face === 'FoundryItalic');
  // The italic runs are the titles alone: the comma after each is roman, because
  // the model put it outside the emphasis and the page printed it upright.
  assert.equal(italic.reduce((sum, piece) => sum + piece.chars, 0),
    'Monologe'.length + 'Führerstaat'.length);
  assert.equal(shownChars(content),
    inkOf('See Jochmann, Monologe, 158-60; and Rebentisch, Führerstaat, 30.'));

  // All four faces are declared on the page that uses three of them, and the
  // bold-italic is there because both bold and italic occur in this book.
  const back = await PDFDocument.load(built.bytes, { updateMetadata: false });
  const fonts = back.getPage(0).node.Resources()!.lookup(PDFName.Font, PDFDict)!;
  assert.deepEqual(fonts.keys().map(String).sort(),
    ['/FoundryBold', '/FoundryBoldItalic', '/FoundryItalic', '/FoundryRoman']);
});

test('a table keeps its cells and loses its rules, because the rules are not measured', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [{
        box: { x1: 165, y1: 300, x2: 1128, y2: 480 },
        category: 'Table',
        text: '<table><tr><td>1938</td><td>Munich</td></tr></table>',
      }],
    }],
  });
  // Not one angle bracket reached the page: what is left is the cells.
  assert.equal(shownChars(await contentOf(built.bytes, 1)), inkOf('1938 Munich'));
});

// ── a mark is raised only when the page proves it is one ────────────────────

test('a footnote marker the page cites is raised; a year is left alone', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [
        // The body cites note twenty, as this dialect writes it: already raised.
        {
          box: { x1: 165, y1: 240, x2: 1128, y2: 600 },
          category: 'Text',
          text: 'Hitler set the barbaric tone in speeches that gave a green light to action.²⁰',
        },
        // The note itself opens with PLAIN digits — which is the other way this
        // dialect writes the same mark, and the case that needs the gate.
        {
          box: { x1: 164, y1: 1600, x2: 1127, y2: 1720 },
          category: 'Footnote',
          text: '20 Ibid., 30; Robert Koehl, Feudal Aspects of National Socialism.',
        },
        // A note opening with a YEAR. Nothing on this page cites note 1938, so
        // nothing raises it — which is the whole point of the gate.
        {
          box: { x1: 164, y1: 1740, x2: 1127, y2: 1860 },
          category: 'Footnote',
          text: '1938 was the year the Chancellery stopped taking his appointments at all.',
        },
      ],
    }],
  });

  assert.equal(built.superscripts, 1, 'the gate raised the wrong number of marks');

  /*
   * The raised mark is the smallest thing on the page, and it sits ABOVE the
   * line it belongs to — which is the whole of what "superscript" means here.
   * Both are read off the drawing rather than trusted from the report, because
   * a mark counted and then set at full size on the baseline would satisfy the
   * count and be exactly the defect this is about.
   */
  const drawn = pieces(await contentOf(built.bytes, 1));
  const mark = drawn.reduce((small, piece) => (piece.size < small.size ? piece : small));
  // `'20 '` and not `'20'`: the mark carries the space that followed it, the way
  // every other word on the page does, so a copy of the note reads as one.
  assert.equal(mark.chars, '20 '.length, 'the smallest thing set was not the marker');
  const after = drawn[drawn.indexOf(mark) + 1];
  assert.ok(after.size > mark.size, 'the mark is not smaller than the note it opens');
  assert.ok(after.y < mark.y, 'the mark was not lifted off the baseline');
});

// ── what cannot be set as type ──────────────────────────────────────────────

test('a Picture is cut out of the scan and placed where it was printed', async () => {
  const { crop, asked } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [
        { box: { x1: 200, y1: 300, x2: 1100, y2: 700 }, category: 'Picture', text: '' },
        { box: { x1: 200, y1: 750, x2: 1100, y2: 800 }, category: 'Caption', text: 'Figure 1' },
      ],
    }],
  });

  assert.equal(built.pictures, 1);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].box, { x1: 200, y1: 300, x2: 1100, y2: 700 });

  const content = await contentOf(built.bytes, 1);
  assert.match(content, /\/Image-\d+ Do/, 'no image was drawn on the page');
  // Placed at the rectangle it was printed in: x 200 px × 0.36 = 72, and the
  // box's last row mapped up. Scaled to 900 × 400 render px = 324 × 143.94 pt.
  assert.match(content, /^1 0 0 1 72 508\.10\d+ cm$/m, 'the plate is not where it was printed');
  assert.match(content, /^324 0 0 143\.93\d+ 0 0 cm$/m, 'the plate is not the size of its box');
  // The caption is type; the picture is not.
  assert.equal(shownChars(content), inkOf('Figure 1'));
});

test('a Picture that could not be cut out stops the run rather than losing the plate', async () => {
  await assert.rejects(
    buildTextPdf({
      pdfBytes: await scanOf(1),
      dpi: 200,
      pages: [{
        page: 1,
        render: RENDER,
        blocks: [{ box: { x1: 200, y1: 300, x2: 1100, y2: 700 }, category: 'Picture', text: '' }],
      }],
      // The cropper that answers nothing: a book quietly missing its plates is
      // not the book that was asked for.
      crop: async () => [],
    }),
    (err: Error) => {
      assert.ok(err instanceof VlmPdfError);
      assert.match(err.message, /Picture block that could not be cut out/);
      assert.match(err.message, /quietly missing its plates/);
      return true;
    },
  );
});

test('a page with no reading and no picture of itself stops the run', async () => {
  /*
   * The alternative is a blank leaf, which is a claim that the page was empty —
   * indistinguishable in the file from a leaf that really is, and unnoticeable
   * until somebody goes looking for what was on it (ARCHITECTURE §8).
   */
  await assert.rejects(
    buildTextPdf({
      pdfBytes: await scanOf(2),
      dpi: 200,
      pages: [{ page: 1, render: RENDER, blocks: [linedBlock(300, 5)] }],
      crop: async () => [],
    }),
    (err: Error) => {
      assert.ok(err instanceof VlmPdfError);
      assert.match(err.message, /page 2 has no reading/);
      assert.match(err.message, /blank page, which is a claim that the leaf was empty/);
      return true;
    },
  );
});

// ── how the lines sit ───────────────────────────────────────────────────────

test('a body paragraph is justified, and its last line is left short', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(3),
    dpi: 200,
    crop,
    pages: [1, 2, 3].map((page) => ({
      page, render: RENDER, blocks: [reflowedBlock(240, 11), reflowedBlock(700, 9)],
    })),
  });

  const content = await contentOf(built.bytes, 1);
  const drawn = pieces(content);
  const rows = new Map<string, Piece[]>();
  for (const piece of drawn) {
    const key = piece.y.toFixed(1);
    rows.set(key, [...(rows.get(key) ?? []), piece]);
  }
  const measured = [...rows.values()].filter((row) => row.length > 3);
  assert.ok(measured.length >= 8, `only ${measured.length} full line(s)`);

  /*
   * A justified line ENDS AT THE MEASURE. The last word's start plus its width
   * lands on the box's right edge, within a rounding — which is a fact about
   * where the words were put, and the only observable justification has.
   */
  const right = 1128 * 0.36;
  const ends = measured.map((row) => {
    const last = row[row.length - 1];
    return last.x + last.chars * last.size * 0.6;
  });
  const flush = ends.filter((end) => Math.abs(end - right) < right * 0.12).length;
  assert.ok(flush >= measured.length - 4, `only ${flush} of ${measured.length} lines reached the measure`);
});

test('display type and a symmetric running head are centred; a corner folio is not', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(2),
    dpi: 200,
    crop,
    pages: [1, 2].map((page) => ({
      page,
      render: RENDER,
      blocks: [
        // The body column runs 165..1128 px, so its centre is 646.5.
        { box: { x1: 470, y1: 160, x2: 823, y2: 196 }, category: 'Page-header' as const, text: 'IAN KERSHAW' },
        { box: { x1: 150, y1: 160, x2: 196, y2: 196 }, category: 'Page-footer' as const, text: '108' },
        { box: { x1: 400, y1: 205, x2: 890, y2: 235 }, category: 'Title' as const, text: 'A Chapter Opens' },
        linedBlock(300, 11),
      ],
    })),
  });
  const placed = pieces(await contentOf(built.bytes, 1));

  // The head's box spans 470..823 px = 169.2..296.28 pt. Centred, its first
  // piece starts strictly inside that; flush left it would start at 169.2.
  assert.ok(placed.some((piece) => piece.x > 169.3 && piece.x < 296.28),
    'the running head was not centred in its box');
  // The folio's box starts at 150 px = 54 pt, and it stays there: a block in the
  // corner of a page was not centred by anybody.
  assert.ok(placed.some((piece) => Math.abs(piece.x - 54) < 1e-6), 'the folio moved off its corner');
  // The Title is display type and is centred whatever its box says.
  assert.ok(placed.some((piece) => piece.x > 144.1 && piece.x < 320), 'the title was not centred');
});

test('a paragraph opening after a finished sentence is indented; a page-top one never is', async () => {
  const { crop } = cropper();
  const opener = 'Hitler was increasingly aloof from the State bureaucracy, and that was matched '
    + 'by the growing autonomy of the party agencies working in his name across the Reich, which '
    + 'nobody in the Chancellery had the standing left to question by the end of that same year.';
  const built = await buildTextPdf({
    pdfBytes: await scanOf(2),
    dpi: 200,
    crop,
    pages: [1, 2].map((page) => ({
      page,
      render: RENDER,
      blocks: [
        // First on the page and a mid-sentence continuation from the page before.
        { box: { x1: 165, y1: 240, x2: 1128, y2: 600 }, category: 'Text' as const,
          text: 'extracting decisions from him. Lammers himself, for all his access, found it '
            + 'increasingly difficult to reach the Chancellery and put a case to the Führer at all.' },
        // Opens a sentence, and the block before it ended one: indented.
        { box: { x1: 165, y1: 620, x2: 1128, y2: 980 }, category: 'Text' as const, text: opener },
        // Opens lowercase — a continuation, however the block above ended.
        { box: { x1: 165, y1: 1000, x2: 1128, y2: 1360 }, category: 'Text' as const,
          text: 'and the same pattern repeated itself in the occupied territories, where nobody '
            + 'waited for an order that was never going to be written down by anyone at all.' },
      ],
    })),
  });
  const lines = linesOf(await contentOf(built.bytes, 1));

  const flush = 165 * 0.36;
  const indented = lines.filter((line) => line.x > flush + 0.5);
  // Exactly one indented first line, and it is one em of its own type.
  assert.equal(indented.length, 1, `${indented.length} line(s) were indented, expected 1`);
  assert.ok(Math.abs(indented[0].x - (flush + indented[0].size)) < 0.01, 'the indent is not one em');
  // The page's first block is never indented, whatever it starts with.
  assert.ok(Math.abs(lines[0].x - flush) < 0.01, 'the page-top block was indented');
});

test('a footnote hangs under its reference mark', async () => {
  const { crop } = cropper();
  const note = 'Institut für Zeitgeschichte, Munich, Nuremberg Document no. NG-5428; trans. '
    + 'Noakes and Pridham, Nazism, ii. 245, and the related correspondence in the files of '
    + 'the Reich Chancellery for the same month, which has clearly shown as much since.';
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    // The note ALONE on its page, so every line read back is one of its own.
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [{
        box: { x1: 164, y1: 1214, x2: 1127, y2: 1500 },
        category: 'Footnote',
        text: `14 ${note}`,
      }],
    }],
  });

  const lines = linesOf(await contentOf(built.bytes, 1));
  const flush = 164 * 0.36;
  assert.ok(lines.length >= 3, `the note came out on ${lines.length} line(s)`);
  // The mark is outdented: the first line starts at the box's own left edge.
  assert.ok(Math.abs(lines[0].x - flush) < 0.01, 'the mark was not outdented');
  // And every line after it hangs past the mark, all at one indent.
  const hung = lines.slice(1);
  assert.ok(hung.every((line) => line.x > flush + 0.5), 'a continuation line did not hang');
  assert.ok(hung.every((line) => Math.abs(line.x - hung[0].x) < 0.01), 'the hang is uneven');
});

// ── the refusals ────────────────────────────────────────────────────────────

test('a character the font cannot write becomes U+FFFD, named, counted, paged', async () => {
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(2),
    dpi: 200,
    crop,
    pages: [1, 2].map((page) => ({
      page,
      render: RENDER,
      // The one found in the wild: dots.ocr wrote 帮 — Chinese for "help" — over
      // the "hel" of "helpers". A semantic hallucination, one character in a
      // book, and not a reason to lose the other sixteen pages.
      blocks: [{
        box: { x1: 200, y1: 300, x2: 1100, y2: 360 },
        category: 'Text' as const,
        text: page === 1 ? 'their 帮pers arrived' : '帮 again here',
      }],
    })),
  });
  assert.equal(built.textPages, 2);
  assert.ok(built.substituted !== null);
  assert.equal(built.substituted.count, 2);
  assert.deepEqual(built.substituted.characters, [
    { char: '帮', code: 0x5e2e, count: 2, pages: [1, 2] },
  ]);
});

test('substitutions at the scale of a script refuse rather than write holes', async () => {
  const { crop } = cropper();
  await assert.rejects(
    buildTextPdf({
      pdfBytes: await scanOf(1),
      dpi: 200,
      crop,
      pages: [{
        page: 1,
        render: RENDER,
        // Hangul: outside DejaVu, and every character of it. Not a glitch to
        // patch over — a book in a script the faces do not cover.
        blocks: [{
          box: { x1: 200, y1: 300, x2: 1100, y2: 360 },
          category: 'Text',
          text: '조선민주주의인민공화국의 조선말은',
        }],
      }],
    }),
    (err: Error) => {
      assert.ok(err instanceof VlmPdfError);
      assert.match(err.message, /have no glyph in the book's faces/);
      assert.match(err.message, /"조" \(U\+C870/);
      assert.match(err.message, /do not cover the book's script/);
      return true;
    },
  );
});

test('the title and author are carried over where they exist and invented where they do not', async () => {
  const { crop } = cropper();
  const named = await PDFDocument.create();
  named.addPage([468, 760]);
  named.setTitle('Working Towards the Führer');
  named.setAuthor('Ian Kershaw');
  const built = await buildTextPdf({
    pdfBytes: await named.save(),
    dpi: 200,
    pages: [{ page: 1, render: RENDER, blocks: [linedBlock(300, 5)] }],
    crop,
  });
  const back = await PDFDocument.load(built.bytes, { updateMetadata: false });
  assert.equal(back.getTitle(), 'Working Towards the Führer');
  assert.equal(back.getAuthor(), 'Ian Kershaw');
  // foundry made THIS document, uniquely among the emitters, and says so.
  assert.match(back.getProducer() ?? '', /^foundry /);

  // A scan naming nobody stays a document naming nobody: an empty title written
  // into the new file would be a claim that the book has none.
  const anonymous = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    pages: [{ page: 1, render: RENDER, blocks: [linedBlock(300, 5)] }],
    crop,
  });
  const plain = await PDFDocument.load(anonymous.bytes, { updateMetadata: false });
  assert.equal(plain.getTitle(), undefined);
  assert.equal(plain.getAuthor(), undefined);
});

test('a page number the document does not have stops the run', async () => {
  const { crop } = cropper();
  await assert.rejects(
    buildTextPdf({
      pdfBytes: await scanOf(2),
      dpi: 200,
      crop,
      pages: [{
        page: 3,
        render: RENDER,
        blocks: [{ box: { x1: 0, y1: 0, x2: 100, y2: 40 }, category: 'Text', text: 'x' }],
      }],
    }),
    (err: Error) => {
      assert.match(err.message, /reading for page 3 and the PDF has 2 page\(s\)/);
      return true;
    },
  );
});

test('a render that is not of this page stops the run rather than skewing it', async () => {
  const { crop, asked } = cropper();
  await assert.rejects(
    buildTextPdf({
      pdfBytes: await scanOf(1),
      dpi: 200,
      crop,
      // A 150 dpi render of the same page: every box would be 33% out.
      pages: [{
        page: 1,
        render: { width: 975, height: 1583 },
        blocks: [{ box: { x1: 100, y1: 100, x2: 500, y2: 140 }, category: 'Text', text: 'x' }],
      }],
    }),
    (err: Error) => {
      assert.match(err.message, /not the 200 every render is made at/);
      return true;
    },
  );
  // And it refused BEFORE cutting anything out of the scan: a subprocess spawned
  // for a run that was never going to finish is work nobody asked for.
  assert.deepEqual(asked, []);
});

/**
 * The two refusals `vlmConvert` owns, both of which happen before a page is
 * rendered — so they can be provoked with paths that need not exist and a model
 * that is never loaded.
 */
test('a prose dialect under --format pdf is refused, and it says why', async () => {
  await assert.rejects(
    vlmConvert({
      pdfPath: path.join(os.tmpdir(), 'foundry-nonexistent-in.pdf'),
      outPath: path.join(os.tmpdir(), 'foundry-nonexistent-out.pdf'),
      format: 'pdf',
      modelId: 'olmocr-7b',
      language: 'en',
      log: () => {},
    }),
    (err: Error) => {
      assert.match(err.message, /--format pdf sets the recognised text back onto the page/);
      assert.match(err.message, /which is prose/);
      assert.match(err.message, /There is nothing to place/);
      return true;
    },
  );
});

test('an --out that is the --pdf is refused before anything is read', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pdf-text-')), 'book.pdf');
  fs.writeFileSync(file, await scanOf(1));
  try {
    await assert.rejects(
      vlmConvert({
        pdfPath: file,
        // The same file, spelled differently. Resolved and realpath'd, so a
        // relative path, a link and a different case are all one file.
        outPath: path.join(path.dirname(file), '.', 'book.pdf'),
        format: 'pdf',
        modelId: 'dots-ocr',
        language: 'en',
        log: () => {},
      }),
      (err: Error) => {
        assert.match(err.message, /--out and --pdf name the same file/);
        assert.match(err.message, /cannot be recovered/);
        return true;
      },
    );
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

// ── the furniture a facsimile must keep ─────────────────────────────────────

test('a tagged running head AND a bare-number folio both reach the page', async () => {
  /*
   * THE REGRESSION THIS GUARDS IS NOT ONE THIS FILE EVER HAD — and it is here
   * because that took a bank to establish. A page of the Kershaw scan came out
   * carrying its running head and no folio, which looks exactly like this route
   * dropping the furniture `parseDotsPage` sets aside for the book routes. It is
   * not: `convert.ts` spreads `page.furniture` back in, and both blocks below
   * come through. The folio was missing from the MODEL'S OWN ANSWER — not one of
   * the 137 elements in that bank is a bare page number — and foundry does not
   * invent a page number it was never given.
   */
  const { crop } = cropper();
  const built = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [
        { box: { x1: 150, y1: 160, x2: 196, y2: 196 }, category: 'Page-header', text: '108' },
        { box: { x1: 470, y1: 160, x2: 823, y2: 196 }, category: 'Page-header', text: 'IAN KERSHAW' },
        { box: { x1: 165, y1: 300, x2: 1128, y2: 700 }, category: 'Text', text: 'The body of it.' },
        { box: { x1: 600, y1: 1990, x2: 700, y2: 2030 }, category: 'Page-footer', text: '109' },
      ],
    }],
  });

  const content = await contentOf(built.bytes, 1);
  assert.equal(shownChars(content), inkOf('108') + inkOf('IAN KERSHAW') + inkOf('The body of it.') + inkOf('109'));

  // And each is still where the printer put it: the head folio at the top left,
  // the foot folio down the page. A facsimile that moved them would be a
  // different claim about the book.
  const drawn = pieces(content);
  assert.ok(Math.abs(drawn[0].x - 150 * 0.36) < 1e-6, 'the head folio left its corner');
  assert.equal(drawn[0].chars, '108'.length);
  assert.ok(drawn[0].y > drawn[drawn.length - 1].y, 'the head folio is not above the foot folio');
});

// ── the curation, on the facsimile route ────────────────────────────────────

test('a struck Picture is never cut out of the scan', async () => {
  /*
   * The one promise `--overlay` makes that is specific to this route. Every
   * other format writes text, so a struck block simply is not written; here a
   * Picture is a REGION OF THE SCAN that gets cut out with a subprocess and
   * embedded, and a strike that only reached the text would leave the figure in
   * the file. It does not have to be handled here, and that is the point: the
   * overlay is applied once, at the parse, so the blocks this route is handed
   * are already the blocks the person kept.
   */
  const { crop, asked } = cropper();
  const parsed = parseDotsPage(JSON.stringify([
    { bbox: [165, 240, 1128, 700], category: 'Text', text: 'A paragraph of the page.' },
    { bbox: [200, 800, 1100, 1500], category: 'Picture', text: '' },
  ]), { page: 1, render: RENDER, maxPixels: 11289600 });

  const overlay = parseOverlay(JSON.stringify({
    overlay: 1,
    amendments: [{ at: { page: 1, order: 1 }, strike: true }],
  }), 'overlay.json');

  // Exactly what `convert.ts` hands this file, on both sides of the strike.
  const asPage = (blocks: readonly DotsBlock[]): PdfTextPage => ({
    page: 1,
    render: RENDER,
    blocks: blocks.map((b) => ({ box: b.box, category: b.category, text: b.text })),
  });

  const kept = await buildTextPdf({
    pdfBytes: await scanOf(1), dpi: 200, crop, pages: [asPage(parsed.blocks)],
  });
  assert.equal(kept.pictures, 1);
  assert.equal(asked.length, 1);

  asked.length = 0;
  const struck = await buildTextPdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    crop,
    pages: [asPage(applyOverlay(parsed.blocks, overlay))],
  });
  assert.equal(struck.pictures, 0);
  assert.deepEqual(asked, []);
});
