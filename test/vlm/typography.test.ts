/**
 * The book's own type sizes, measured off its boxes.
 *
 * Every number in this file is arithmetic on a rectangle, which is what makes
 * the whole feature cheap to check — and the three things worth the most are:
 *
 *  - the SIZE PROXY, because `lineHeight` cannot report a chapter title at all
 *    (it maximises over a 40-pixel line estimate and therefore never exceeds
 *    60), and a typography pass built on it would flatten the one distinction
 *    it exists to measure;
 *  - the SILENCE, because a category with three blocks in it must produce no
 *    rule at all rather than a rule taken from one loosely-drawn box;
 *  - the OUTLIER, because the defect this was built for is a paragraph the
 *    printer set at 12 pt in an 8 pt book, which every book-wide font-size
 *    silently flattens back to the size of the prose around it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { type DotsBlock } from '../../src/vlm/dots.js';
import {
  bodyTypeSize,
  deriveTypography,
  measureTypeSizes,
  typeSize,
} from '../../src/vlm/typography.js';
import { dotsStylesheet } from '../../src/vlm/dots-book.js';

/**
 * A block of a synthetic 1300x2112 book whose body is set at 40 px a line.
 *
 * `lines` is how many lines the block is printed as, and the text is built to
 * carry that many breaks — which is what the model's answer carries for
 * anything it did not reflow, and what `typeSize` counts.
 */
function typed(overrides: {
  category?: DotsBlock['category'];
  px: number;
  lines?: number;
  page?: number;
  text?: string;
  width?: number;
}): DotsBlock {
  const lines = overrides.lines ?? 1;
  const width = overrides.width ?? 900;
  return {
    page: overrides.page ?? 1,
    order: 0,
    category: overrides.category ?? 'Text',
    box: { x1: 200, y1: 300, x2: 200 + width, y2: 300 + overrides.px * lines },
    text: overrides.text ?? Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'),
    pageWidth: 1300,
    pageHeight: 2112,
  };
}

/** The synthetic book of the header: 40 px body, 30 px notes, 80 px headings. */
function measuredBook(): DotsBlock[] {
  return [
    ...Array.from({ length: 8 }, (_, i) => typed({ px: 40, lines: 5, page: i + 1 })),
    ...Array.from({ length: 6 }, (_, i) => typed({ category: 'Footnote', px: 30, lines: 3, page: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => typed({ category: 'Title', px: 80, page: i + 1, text: `CHAPTER ${i + 1}` })),
  ];
}

// ── the proxy ───────────────────────────────────────────────────────────────

test('a display line is measured at its own height, not at 40 px', () => {
  // `lineHeight` reads a 120 px title as `round(120/40) = 3` lines of 40 — the
  // size of the body it is three times bigger than — because it takes the
  // LARGEST line count of its three estimates and a big box is always big
  // enough to be several small lines. Nothing built on that can tell display
  // type from prose, which is the only thing typography is for.
  assert.equal(typeSize(typed({ px: 120, text: 'CHAPTER ONE' })), 120);
  assert.equal(typeSize(typed({ px: 100, text: 'CHAPTER ONE' })), 100);
});

test('a break the model kept is a line, and the box is divided by it', () => {
  // `FOR\nTHE SOUL` in a 160 px box is two 80 px lines. A newline that survived
  // is a line ending the page had (`dots.ts`), so it is counted, not estimated.
  assert.equal(typeSize(typed({ px: 80, lines: 2, text: 'FOR\nTHE SOUL' })), 80);
});

test('a paragraph the model reflowed falls back to the 40-pixel estimate', () => {
  // 200 px of box, one string, and no line count left anywhere in the text —
  // this is the one case where an estimate is all there is, and 40 px is a line
  // of 10 pt type at 200 dpi. A rule that took the box as one line here would
  // report the book's body at five times its size.
  const reflowed = typed({ px: 200, text: 'word '.repeat(40) });
  assert.equal(typeSize(reflowed), 40);
});

// ── the medians ─────────────────────────────────────────────────────────────

test('the body is the median of the book\'s full-width Text blocks', () => {
  const blocks = measuredBook();
  assert.equal(bodyTypeSize(blocks), 40);

  // A narrow Text block is not the body column — the same filter `bodyColumn`
  // uses, for the same reason. A contents entry set 30% of the page wide says
  // nothing about the type the book's prose is set in.
  const narrow = [...blocks, ...Array.from({ length: 20 }, () => typed({ px: 90, width: 300 }))];
  assert.equal(bodyTypeSize(narrow), 40);
});

test('every category gets a median and a ratio against the body', () => {
  const blocks = measuredBook();
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.equal(type.bodyPx, 40);
  assert.deepEqual(type.categories['Footnote'], { medianPx: 30, ratio: 0.75, samples: 6 });
  assert.deepEqual(type.categories['Title'], { medianPx: 80, ratio: 2, samples: 5 });
});

test('a category with too few blocks gets no rule at all', () => {
  // Three captions is not a distribution, it is three boxes, and the middle one
  // of three IS whichever the model drew loosest — nothing can outvote it. So
  // there is no entry, the static stylesheet's own 0.9em stands, and nothing in
  // the book claims to have been measured. `classifyPage`'s silence, applied to
  // type.
  const blocks = [...measuredBook(), ...Array.from({ length: 3 }, () => typed({ category: 'Caption', px: 20 }))];
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.equal('Caption' in type.categories, false);

  // A fourth caption is the count where the value picked has two samples under
  // it and one over, and the rule appears.
  const four = [...blocks, typed({ category: 'Caption', px: 20 })];
  assert.equal(deriveTypography(four, measureTypeSizes(four))!.categories['Caption'].samples, 4);
});

test('a book with no prose in it is measured as nothing, not as something', () => {
  const plates = [typed({ category: 'Picture', px: 800, text: '' })];
  assert.equal(deriveTypography(plates, measureTypeSizes(plates)), null);
});

test('a ratio no book could have printed is clamped to one it could', () => {
  // A Footnote block the model boxed around the whole foot of six pages,
  // white space included. The direction is still right and the magnitude is a
  // box that went wrong, so it is clamped rather than believed.
  const blocks = [
    ...Array.from({ length: 8 }, () => typed({ px: 40, lines: 5 })),
    ...Array.from({ length: 6 }, () => typed({ category: 'Footnote', px: 600 })),
  ];
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.equal(type.categories['Footnote'].medianPx, 600);
  assert.equal(type.categories['Footnote'].ratio, 3);
});

// ── the block that is not the size the rest of it is ────────────────────────

test('a paragraph the printer set bigger stays bigger, and is named', () => {
  // The case this exists for: a body paragraph set at 12 pt in an 8 pt book.
  // The printer made it bigger on purpose; a book-wide `1em` flattens it back
  // and nothing in the finished EPUB says it ever stood out.
  const blocks = [
    ...Array.from({ length: 8 }, (_, i) => typed({ px: 40, lines: 5, page: i + 1 })),
    typed({ px: 60, lines: 4, page: 9, text: 'The letter was read aloud\nto the whole court\nthat morning\nin silence.' }),
  ];
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.deepEqual(type.outliers, [{
    page: 9,
    category: 'Text',
    text: 'The letter was read aloud to the whole court that morning in…',
    em: 1.5,
  }]);
  assert.equal(type.sizes.get(blocks[8]), '1.50em');
  // And every ordinary paragraph carries nothing at all: the stylesheet already
  // says what size a paragraph is, and an attribute repeating that on every one
  // of them is a hundred kilobytes that says nothing.
  assert.equal(type.sizes.size, 1);
});

test('the tolerance is wider than the estimate\'s own wobble', () => {
  // A reflowed paragraph is measured as `height / round(height / 40)`, which
  // lands anywhere in 40 ± 20/n for a block read as n lines however uniform the
  // printed type is. 190 px over 5 lines is 38 and 210 over 5 is 42; both are
  // that wobble and neither is a size the printer chose.
  const blocks = [
    ...Array.from({ length: 8 }, () => typed({ px: 40, lines: 5 })),
    typed({ px: 38, lines: 5, page: 9 }),
    typed({ px: 47, lines: 5, page: 10 }),
  ];
  assert.deepEqual(deriveTypography(blocks, measureTypeSizes(blocks))!.outliers, []);
});

test('an estimated size can sit in a median, but never accuse a block', () => {
  /*
   * Both halves of this are the Dannenmann bank, where the first run of this
   * pass produced four outliers and every one of them was false.
   *
   * The model reflowed every paragraph on one page of nine, so their sizes are
   * the `height / round(height / 40)` estimate — and the estimate is BIASED,
   * not merely noisy, when the book's true line is not 40: it put two ordinary
   * body paragraphs just past the tolerance at 0.71 and 0.75. Here, the same
   * shape: a reflowed block (no breaks, over 90 characters) whose 59 px box
   * reads as one 59 px line. It measures 1.48× the body and it is NOT an
   * outlier, because nothing counted its lines.
   */
  const reflowed = typed({ px: 59, page: 9, text: 'word '.repeat(22) });
  const blocks = [
    ...Array.from({ length: 8 }, (_, i) => typed({ px: 40, lines: 5, page: i + 1 })),
    reflowed,
  ];
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.deepEqual(type.outliers, []);
  assert.equal(type.sizes.has(reflowed), false);
});

test('a one-line block\'s slack is not a size the printer chose', () => {
  // "Wir sehen darin heilige Gottesgesetze!" — one letterspaced line of
  // EMPHASIS, same type as the prose around it, in a box the model drew 60 px
  // tall against a 47 px body. The height is type plus slack and nothing
  // divides the slack down, so a one-line block can never be an outlier: its
  // measurement is uncounted and the rule above refuses it.
  const emphatic = typed({ px: 60, page: 3, text: 'Wir sehen darin heilige Gottesgesetze!' });
  const blocks = [
    ...Array.from({ length: 8 }, (_, i) => typed({ px: 40, lines: 5, page: i + 1 })),
    emphatic,
  ];
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.deepEqual(type.outliers, []);
});

test('a footnote is judged against the other footnotes, never against the prose', () => {
  // A footnote is not an outlier for being smaller than the body — that is what
  // a footnote is. It is an outlier for being a different size from the book's
  // other footnotes.
  const blocks = [
    ...Array.from({ length: 8 }, () => typed({ px: 40, lines: 5 })),
    ...Array.from({ length: 5 }, () => typed({ category: 'Footnote', px: 30, lines: 3 })),
    typed({ category: 'Footnote', px: 60, lines: 2, page: 12, text: 'A note in the\neditor’s own type.' }),
  ];
  const type = deriveTypography(blocks, measureTypeSizes(blocks))!;
  assert.deepEqual(type.outliers.map((o) => [o.page, o.em]), [[12, 1.5]]);
});

// ── the stylesheet ──────────────────────────────────────────────────────────

test('the stylesheet writes a rule only where the book was measured', () => {
  const blocks = measuredBook();
  const css = dotsStylesheet(deriveTypography(blocks, measureTypeSizes(blocks)));
  // Footnotes and titles had enough blocks; captions, quotes and section
  // headers had none at all, so nothing is said about them and the base sheet's
  // own values stand.
  assert.match(css, /\.footnotes \{ font-size: 0\.75em; \}/);
  assert.match(css, /h1 \{ font-size: 2\.00em; \}/);
  assert.equal(/h2 \{ font-size/.test(css), false);
  assert.equal(/blockquote p \{ font-size: \d/.test(css), false);
  // The base sheet is still in front of the derived rules, so a category that
  // was not measured keeps the static default at the same specificity.
  assert.ok(css.indexOf('p.caption { font-size: 0.9em;') < css.indexOf('.footnotes { font-size: 0.75em; }'));
});

test('a book that could not be measured gets the stylesheet every book got', () => {
  const base = dotsStylesheet(null);
  assert.equal(base.includes('font-size: 0.85em'), true);
  assert.equal(base.includes('Measured from this book'), false);
  // And so does a book whose every category came up short.
  const thin = [typed({ px: 40, lines: 5 }), typed({ category: 'Title', px: 80 })];
  assert.equal(dotsStylesheet(deriveTypography(thin, measureTypeSizes(thin))), base);
});
