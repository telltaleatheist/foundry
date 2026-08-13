/**
 * The searchable-PDF emitter: the scan, with a text layer nobody can see.
 *
 * Everything this format can get wrong is invisible in the file it produces. A
 * layer half a page off still opens, still prints, and still looks exactly like
 * the scan; a layer laid twice looks like one; a character the font could not
 * write leaves a page that reads correctly and cannot be searched. So the tests
 * are about the things a person looking at the output cannot check:
 *
 *  - THE ARITHMETIC, pinned to exact numbers. Render pixels → points, the
 *    y-flip between an image's rows and PDF user space, the crop box's offset
 *    and the four quarter turns. Each is one function, and each is checked
 *    against hand-computed values rather than against itself.
 *  - THE OPERATOR. `3 Tr` is the whole of the invisibility, and a run that
 *    quietly lost it would print the recognised text over the page in black.
 *  - REPLACE, NEVER STACK. A second run over foundry's own output must leave
 *    the same text on the page as the first — one set of hits, not two — and
 *    the check is made through the extracted content stream rather than by
 *    counting objects, because doubling is a fact about what a reader finds.
 *  - THE REFUSALS: a prose dialect, an `--out` that is the input, a page number
 *    the document does not have, a whole script outside the font, and somebody
 *    else's text layer. A STRAY character outside the font is not one of them:
 *    it becomes U+FFFD and is reported by name, because one model glitch is not
 *    worth a book — only a script's worth of them is.
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
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';

import { vlmConvert } from '../../src/vlm/convert.js';
import {
  boxToDisplay,
  buildSearchablePdf,
  displayMatrix,
  displaySize,
  pointsPerPixel,
  VlmPdfError,
  type PageFrame,
  type PdfLayerPage,
} from '../../src/vlm/pdf-layer.js';

/**
 * The frame of a real page of a real book: 468×760 pt, rendered at foundry's
 * pinned 200 dpi, which is the 1300×2112 the models were measured on.
 *
 * 1300 is exactly 468 × 200/72; 2112 is NOT exactly 760 × 200/72, which is
 * 2111.11, and the rasteriser rounds up. The two axes therefore have slightly
 * different points-per-pixel, and every number below is computed with that
 * asymmetry rather than with a single 0.36 — pretending the scales are equal is
 * the tidy assumption that puts a layer a pixel off the bottom of every page.
 */
const RENDER = { width: 1300, height: 2112 };
const FRAME: PageFrame = {
  crop: { x: 0, y: 0, width: 468, height: 760 },
  rotation: 0,
  render: RENDER,
};

/** The same page bound with its crop box offset from the media box's origin. */
const OFFSET: PageFrame = { ...FRAME, crop: { x: 36, y: 18, width: 468, height: 760 } };

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
  // HIGH y in user space — 760 − 300 × (760/2112) — and a rectangle's `y` is
  // its bottom edge, which is the box's LAST row: 760 − 360 × (760/2112).
  const rect = boxToDisplay({ x1: 200, y1: 300, x2: 1100, y2: 360 }, FRAME);
  assert.equal(rect.x, 72);
  assert.equal(rect.width, 324);
  assert.equal(rect.y, 760 - 360 * (760 / 2112));
  assert.ok(Math.abs(rect.y - 630.4545454545455) < 1e-9);
  // Within a float's noise of 60 × (760/2112): the height is a DIFFERENCE of
  // two mapped edges, so it carries the rounding of both and is not bit-equal
  // to the product. Pinned to the number, not to the expression.
  assert.ok(Math.abs(rect.height - 21.590909090909093) < 1e-9);
});

test('the whole render maps to the whole page, corner for corner', () => {
  assert.deepEqual(
    boxToDisplay({ x1: 0, y1: 0, x2: 1300, y2: 2112 }, FRAME),
    { x: 0, y: 0, width: 468, height: 760 },
  );
});

test('the display matrix carries the crop box offset and never mirrors', () => {
  // Rotation 0 is a translation by the crop's own origin and nothing else.
  assert.deepEqual([...displayMatrix(OFFSET)], [1, 0, 0, 1, 36, 18]);
  assert.deepEqual([...displayMatrix({ ...OFFSET, rotation: 90 })], [0, 1, -1, 0, 504, 18]);
  assert.deepEqual([...displayMatrix({ ...OFFSET, rotation: 180 })], [-1, 0, 0, -1, 504, 778]);
  assert.deepEqual([...displayMatrix({ ...OFFSET, rotation: 270 })], [0, -1, 1, 0, 36, 778]);
  // Determinant +1 on every turn. A −1 would place each line backwards on a
  // page that still looked entirely plausible.
  for (const rotation of [0, 90, 180, 270]) {
    const [a, b, c, d] = displayMatrix({ ...OFFSET, rotation });
    assert.equal(a * d - b * c, 1, `rotation ${rotation} is a reflection, not a rotation`);
  }
});

test('a quarter turn sends the display frame onto the page it came from', () => {
  // The four corners of a 90°-rotated page's display frame, pushed through the
  // matrix by hand, land on the four corners of the crop box. The display frame
  // is 760 × 468 — the sides swapped — and the crop box is 468 × 760 at (36,18).
  const turned: PageFrame = { ...OFFSET, rotation: 90, render: { width: 2112, height: 1300 } };
  const [a, b, c, d, e, f] = displayMatrix(turned);
  const apply = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];
  // /Rotate 90 means the page is turned CLOCKWISE to be displayed, so the
  // display's bottom-left is the page's bottom-RIGHT and its top-left is the
  // page's bottom-left. Getting this backwards is the error that looks most
  // like success: the layer lands on the page, upside down.
  assert.deepEqual(apply(0, 0), [504, 18]);
  assert.deepEqual(apply(760, 0), [504, 778]);
  assert.deepEqual(apply(0, 468), [36, 18]);
  assert.deepEqual(apply(760, 468), [36, 778]);
});

// ── the document ────────────────────────────────────────────────────────────

/** A scan: pages with ink on them and not one glyph. */
async function scanOf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) {
    doc.addPage([468, 760])
      .drawRectangle({ x: 36, y: 36, width: 396, height: 688, color: rgb(0.94, 0.94, 0.94) });
  }
  return doc.save();
}

/**
 * Two blocks with the characters that kill a WinAnsi font — an em dash, curly
 * quotes, an umlaut — and one block of two lines, so the vertical split is
 * exercised by something other than arithmetic.
 */
const READING: PdfLayerPage[] = [
  {
    page: 1,
    render: RENDER,
    blocks: [
      { box: { x1: 200, y1: 300, x2: 1100, y2: 360 }, text: 'The Führer—“working towards” him' },
      { box: { x1: 200, y1: 400, x2: 1100, y2: 520 }, text: 'first line here\nsecond line here' },
    ],
  },
  {
    page: 2,
    render: RENDER,
    // A folio: page furniture, which no book route writes and this one keeps.
    blocks: [{ box: { x1: 100, y1: 1900, x2: 400, y2: 1950 }, text: '142' }],
  },
];

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

/** The hex strings a page's layer shows, which is what a reader will find. */
function shownText(content: string): string[] {
  return [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((match) => match[1]);
}

test('the layer is drawn in rendering mode 3 and the pages survive it', async () => {
  const built = await buildSearchablePdf({ pdfBytes: await scanOf(2), dpi: 200, pages: READING });

  const back = await PDFDocument.load(built.bytes, { updateMetadata: false });
  assert.equal(back.getPageCount(), 2);
  assert.deepEqual(back.getPage(0).getSize(), { width: 468, height: 760 });
  assert.equal(built.overlaidPages, 2);
  assert.equal(built.lines, 4);
  assert.equal(built.replaced, null);

  const content = await contentOf(built.bytes, 1);
  assert.match(content, /^3 Tr$/m, 'the text layer is not invisible');
  assert.match(content, /\bBT\b/);
  // The first line sits where the arithmetic tests said it would: x is 200 px
  // × 0.36, and the baseline is that box's bottom edge (630.45) plus a
  // descender's worth of the size it was set at.
  assert.match(content, /^1 0 0 1 72 634\.\d+ Tm$/m);
  // The page's own ink is untouched and still there, AFTER the layer: the
  // overlay goes in front of the page's content stream rather than behind it,
  // so it inherits the initial graphics state whatever the page does with its.
  assert.ok(content.indexOf('3 Tr') < content.indexOf('0.94 0.94 0.94 rg'));
  assert.match(content, /^f$/m);
  // A real Unicode font, under this file's reserved name, is what let an em
  // dash and a curly quote get this far at all: the standard fourteen are
  // WinAnsi and throw on the first character outside Latin-1.
  const fonts = back.getPage(0).node.Resources()!.lookup(PDFName.Font, PDFDict)!;
  assert.deepEqual(fonts.keys().map(String), ['/FoundryOCRLayer']);
  assert.equal(shownText(content).length, 3);
});

test('the blocks are shown in the order they were given, furniture included', async () => {
  const built = await buildSearchablePdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    pages: [{
      page: 1,
      render: RENDER,
      // A running head at the top, then the body, then the folio — the model's
      // own reading order, which is not the order either list arrives in.
      blocks: [
        { box: { x1: 200, y1: 100, x2: 1100, y2: 140 }, text: 'RUNNING HEAD' },
        { box: { x1: 200, y1: 300, x2: 1100, y2: 360 }, text: 'body of the page' },
        { box: { x1: 600, y1: 1990, x2: 700, y2: 2030 }, text: '142' },
      ],
    }],
  });
  const shown = shownText(await contentOf(built.bytes, 1));
  assert.equal(shown.length, 3);
  // Read back through the layer's own font, the three lines are in the order
  // they were placed in: a text layer's extraction order is its placement
  // order, and a folio that arrives before the page's first sentence is a
  // copy-and-paste nobody can use.
  const first = Buffer.from(shown[0], 'hex');
  const last = Buffer.from(shown[2], 'hex');
  assert.notDeepEqual(first, last);
  assert.equal(first.length, 'RUNNING HEAD'.length * 2);
  assert.equal(last.length, '142'.length * 2);
});

/** Every `Tm` baseline and `Tf` size a page's layer sets, in order. */
function placements(content: string): { size: number; x: number; y: number }[] {
  const out: { size: number; x: number; y: number }[] = [];
  let size = 0;
  for (const line of content.split('\n')) {
    const font = /^\/FoundryOCRLayer ([\d.]+) Tf$/.exec(line);
    if (font) size = Number(font[1]);
    const at = /^1 0 0 1 ([\d.]+) ([\d.]+) Tm$/.exec(line);
    if (at) out.push({ size, x: Number(at[1]), y: Number(at[2]) });
  }
  return out;
}

test('a reflowed paragraph is laid back across its box, not onto one baseline', async () => {
  /*
   * The case that is most of a book. dots.ocr reflows wrapped prose, so a
   * fifteen-line paragraph arrives as ONE string with a fifteen-line box round
   * it — and placed as written it would be one text run in half-point type,
   * with every search hit highlighting a hairline across the block.
   */
  const paragraph = 'Time after time, Hitler set the barbaric tone, whether in hate-filled public '
    + 'speeches giving a green light to discriminatory action against Jews and other enemies of '
    + 'the state, or in closed addresses to Nazi functionaries or military leaders where he laid '
    + 'down the brutal guidelines for the occupation of Poland and the war against the Soviet '
    + 'Union, and there was never any shortage of willing helpers, far from being confined to '
    + 'party activists, ready to work towards the Fuhrer along the lines he had indicated.';
  const built = await buildSearchablePdf({
    pdfBytes: await scanOf(1),
    dpi: 200,
    pages: [{
      page: 1,
      render: RENDER,
      blocks: [
        // A body block: the column's width, eleven print lines deep.
        { box: { x1: 166, y1: 700, x2: 1123, y2: 1140 }, text: paragraph },
        // A running head: one line, in a box drawn tight around it.
        { box: { x1: 400, y1: 100, x2: 900, y2: 140 }, text: 'Contemporary European History' },
      ],
    }],
  });

  const laid = placements(await contentOf(built.bytes, 1));
  const head = laid[laid.length - 1];
  const paragraphLines = laid.slice(0, -1);

  // Many lines, not one — and a body size a person would recognise as one.
  assert.ok(paragraphLines.length >= 8, `the paragraph came out on ${paragraphLines.length} line(s)`);
  assert.ok(paragraphLines.every((line) => Math.abs(line.size - paragraphLines[0].size) < 1e-9));
  assert.ok(paragraphLines[0].size > 6 && paragraphLines[0].size < 14, `size ${paragraphLines[0].size}`);

  // They descend the box, evenly, and stay inside it. The box in points:
  // y from 760 − 1140×(760/2112) to 760 − 700×(760/2112).
  const top = 760 - 700 * (760 / 2112);
  const bottom = 760 - 1140 * (760 / 2112);
  for (const [index, line] of paragraphLines.entries()) {
    assert.equal(line.x, 166 * 0.36);
    assert.ok(line.y >= bottom && line.y <= top, `line ${index} at ${line.y} is outside its box`);
    if (index > 0) assert.ok(line.y < paragraphLines[index - 1].y, 'the lines do not descend');
  }

  /*
   * The running head did not wrap, so it stays ONE line, sized to fill its
   * box's width — which is what puts a highlight over the words printed there.
   * Its box is 500 px × 40 px, or 180 × 14.4 pt: the height allows at most
   * 14.4/1.2 = 12 pt, and 29 characters across 180 pt lands just under that. A
   * block laid out the way the paragraph above has to be would be a third of
   * it.
   */
  assert.equal(laid.filter((line) => line.x === 400 * 0.36).length, 1, 'the running head wrapped');
  assert.equal(head.x, 400 * 0.36);
  assert.ok(head.size > 10 && head.size <= 12, `a one-line block was set at ${head.size} pt`);
});

test('a second run replaces the layer instead of stacking a second one', async () => {
  const clean = await scanOf(2);
  const first = await buildSearchablePdf({ pdfBytes: clean, dpi: 200, pages: READING });
  const second = await buildSearchablePdf({ pdfBytes: first.bytes, dpi: 200, pages: READING });
  const third = await buildSearchablePdf({ pdfBytes: second.bytes, dpi: 200, pages: READING });

  assert.equal(first.replaced, null);
  assert.equal(second.replaced?.pages, 2);
  assert.ok(second.replaced?.by !== null, 'the old layer did not say which foundry wrote it');
  assert.ok(second.replaced?.at !== null, 'the old layer did not say when it was written');

  // The whole point: what a reader finds on the page does not change. Three
  // runs, one set of hits — never three overlapping copies of every word.
  const shown = await Promise.all([first, second, third].map(
    async (built) => shownText(await contentOf(built.bytes, 1)),
  ));
  assert.equal(shown[0].length, 3);
  assert.deepEqual(shown[1], shown[0]);
  assert.deepEqual(shown[2], shown[0]);

  // And the fonts do not pile up either: the old subset is deleted with the
  // stream it was written for, so a rerun does not cost a whole embedded font.
  const back = await PDFDocument.load(third.bytes, { updateMetadata: false });
  const fontFiles = back.context.enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFDict && object.get(PDFName.of('FontFile2')) !== undefined);
  assert.equal(fontFiles.length, 1);
});

// ── the refusals ────────────────────────────────────────────────────────────

test('somebody else\'s text layer is refused rather than stacked or deleted', async () => {
  const digital = await PDFDocument.create();
  digital.addPage([468, 760]).drawText('Already searchable', {
    x: 72,
    y: 600,
    size: 12,
    font: await digital.embedFont(StandardFonts.Helvetica),
  });
  await assert.rejects(
    buildSearchablePdf({ pdfBytes: await digital.save(), dpi: 200, pages: [READING[0]] }),
    (err: Error) => {
      assert.ok(err instanceof VlmPdfError);
      assert.match(err.message, /already has text on it — page\(s\) 1/);
      assert.match(err.message, /match twice/);
      assert.match(err.message, /does not delete a text layer it did not write/);
      return true;
    },
  );
});

test('a page number the document does not have stops the run', async () => {
  await assert.rejects(
    buildSearchablePdf({
      pdfBytes: await scanOf(2),
      dpi: 200,
      pages: [{ page: 3, render: RENDER, blocks: [{ box: { x1: 0, y1: 0, x2: 100, y2: 40 }, text: 'x' }] }],
    }),
    (err: Error) => {
      assert.match(err.message, /reading for page 3 and the PDF has 2 page\(s\)/);
      return true;
    },
  );
});

test('a render that is not of this page stops the run rather than skewing it', async () => {
  await assert.rejects(
    buildSearchablePdf({
      pdfBytes: await scanOf(1),
      dpi: 200,
      // A 150 dpi render of the same page: every box would be 33% out.
      pages: [{
        page: 1,
        render: { width: 975, height: 1583 },
        blocks: [{ box: { x1: 100, y1: 100, x2: 500, y2: 140 }, text: 'x' }],
      }],
    }),
    (err: Error) => {
      assert.match(err.message, /not the 200 every render is made at/);
      return true;
    },
  );
});

test('a character the font cannot write becomes U+FFFD, named, counted, paged', async () => {
  const built = await buildSearchablePdf({
    pdfBytes: await scanOf(2),
    dpi: 200,
    pages: [
      {
        page: 1,
        render: RENDER,
        // The one found in the wild: dots.ocr wrote 帮 — Chinese for "help" —
        // over the "hel" of "helpers". A semantic hallucination, one character
        // in a book, and not a reason to lose the other sixteen pages.
        blocks: [{ box: { x1: 200, y1: 300, x2: 1100, y2: 360 }, text: 'their 帮pers arrived' }],
      },
      {
        page: 2,
        render: RENDER,
        blocks: [{ box: { x1: 200, y1: 300, x2: 1100, y2: 360 }, text: '帮 again here' }],
      },
    ],
  });
  // The book still came out, both pages overlaid — and the report says exactly
  // what was traded for that: which character, how many times, on which pages.
  assert.equal(built.overlaidPages, 2);
  assert.ok(built.substituted !== null);
  assert.equal(built.substituted.count, 2);
  assert.deepEqual(built.substituted.characters, [
    { char: '帮', code: 0x5e2e, count: 2, pages: [1, 2] },
  ]);
});

test('substitutions at the scale of a script refuse rather than write holes', async () => {
  await assert.rejects(
    buildSearchablePdf({
      pdfBytes: await scanOf(1),
      dpi: 200,
      pages: [{
        page: 1,
        render: RENDER,
        // Hangul: outside DejaVu, and every character of it. This is not a
        // glitch to patch over — it is a book in a script the font does not
        // cover, and a layer that is all replacement characters would report
        // itself searchable while not one of its words is findable.
        blocks: [{
          box: { x1: 200, y1: 300, x2: 1100, y2: 360 },
          text: '조선민주주의인민공화국의 조선말은',
        }],
      }],
    }),
    (err: Error) => {
      assert.ok(err instanceof VlmPdfError);
      assert.match(err.message, /have no glyph in the text layer's font/);
      assert.match(err.message, /"조" \(U\+C870/);
      assert.match(err.message, /does not cover the book's script/);
      return true;
    },
  );
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
      assert.match(err.message, /--format pdf places the recognised text/);
      assert.match(err.message, /which is prose/);
      assert.match(err.message, /There is nothing to place/);
      return true;
    },
  );
});

test('an --out that is the --pdf is refused before anything is read', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pdf-layer-')), 'book.pdf');
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
