/**
 * The dots.ocr dialect, and the book it builds.
 *
 * Everything asserted here is a rule that was earned against a real book with a
 * real defect in it, and every one of them is cheap to check because it is pure
 * arithmetic or pure string work. The three that are worth the most:
 *
 *  - the PROMPT is the model's interface, so its bytes are pinned;
 *  - the bbox SCALE is the difference between a picture cropped right and a
 *    picture cropped wrong, and it is invisible in the text either way;
 *  - a paragraph joined across a page turn is judged in INK, so the ink test
 *    gets a raster with an indent in it and a raster without one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  alignmentClass,
  BookLexicon,
  bodyColumn,
  carriesBodyProse,
  classifyPage,
  consumeMarkdown,
  continuesTextually,
  DotsPageError,
  dotsInline,
  lineHeight,
  parseDotsPage,
  renderScale,
  smartResize,
  type DotsBlock,
  type DotsPagePlace,
} from '../../src/vlm/dots.js';
import {
  adjoins,
  buildChapterBody,
  buildDotsBook,
  carriesOver,
  inkExtentIn,
  navTree,
  proposeChapters,
  proposeSections,
  splitNotes,
  type DotsPageImages,
} from '../../src/vlm/dots-book.js';
import { requireVlmModel } from '../../src/vlm/models.js';
import { unzipMap } from '../export/unzip.js';
import { checkXml } from '../export/xmlcheck.js';

// ── the prompt ──────────────────────────────────────────────────────────────

test('the dots prompt is the model card\'s, byte for byte', () => {
  // Pinned by hash rather than by re-typing it: a prompt that is nearly right
  // does not error, it quietly answers worse (ARCHITECTURE §4). The hash is of
  // the model card's `layout-all` prompt as published.
  const prompt = requireVlmModel('dots-ocr').prompt;
  assert.equal(
    createHash('sha256').update(prompt).digest('hex'),
    'fae8e6aafb9682d0501ad64372db852d179b23f99de60198ef4a58b1468235d5',
  );
});

test('dots-ocr is the default and declares the frame its boxes are in', () => {
  const model = requireVlmModel('dots-ocr');
  assert.equal(model.dialect, 'dots-json');
  assert.equal(model.maxPixels, 11289600);
  // A dense index page went past 4096 and came back truncated.
  assert.ok(model.maxTokens >= 8192);
});

// ── smart_resize ────────────────────────────────────────────────────────────

test('smartResize rounds to the patch and honours the area window', () => {
  // A 200 dpi page of a 468x760 pt book, under the model's own budget: no
  // resize, only the rounding to a whole patch — which is why the scale is
  // 1.009 rather than exactly 1, and why it is computed rather than assumed.
  assert.deepEqual(smartResize(2112, 1300, 11289600), { width: 1288, height: 2100 });
  assert.equal(renderScale({ width: 1300, height: 2112 }, 11289600).toFixed(4), '1.0093');

  // The same page under the MLX budget: shrunk to fit 2,000,000 pixels, both
  // sides a multiple of 28.
  const capped = smartResize(2112, 1300, 2_000_000);
  assert.equal(capped.width % 28, 0);
  assert.equal(capped.height % 28, 0);
  assert.ok(capped.width * capped.height <= 2_000_000);
  assert.deepEqual(capped, { width: 1092, height: 1792 });
  assert.equal(renderScale({ width: 1300, height: 2112 }, 2_000_000).toFixed(4), '1.1905');
});

test('smartResize grows a page that is under the floor', () => {
  const grown = smartResize(28, 28, 11289600);
  assert.ok(grown.width * grown.height >= 28 * 28 * 4);
});

test('a box is scaled with the budget the reader used', () => {
  const answer = JSON.stringify([
    { bbox: [100, 200, 1000, 300], category: 'Text', text: 'A paragraph.' },
  ]);
  const native = parseDotsPage(answer, {
    page: 1, render: { width: 1300, height: 2112 }, maxPixels: 11289600,
  });
  assert.equal(Math.round(native.blocks[0].box.x1), 101);

  const capped = parseDotsPage(answer, {
    page: 1, render: { width: 1300, height: 2112 }, maxPixels: 2_000_000,
  });
  // 1300/1092 — the same box, in the render's frame rather than the model's.
  assert.equal(Math.round(capped.blocks[0].box.x1), 119);
  assert.equal(capped.rawExtent.x, 1000);
});

// ── parsing ─────────────────────────────────────────────────────────────────

const RENDER = { width: 1300, height: 2112 };
const PARSE = { page: 3, render: RENDER, maxPixels: 11289600 };

test('page furniture is dropped, and counted', () => {
  const parsed = parseDotsPage(JSON.stringify([
    { bbox: [500, 40, 800, 70], category: 'Page-header', text: 'IAN KERSHAW' },
    { bbox: [100, 200, 1200, 900], category: 'Text', text: 'The body of the page.' },
    { bbox: [500, 2000, 800, 2050], category: 'Page-footer', text: '106' },
  ]), PARSE);
  assert.equal(parsed.dropped, 2);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].text, 'The body of the page.');
});

test('a category the prompt does not name stops the page by name', () => {
  assert.throws(
    () => parseDotsPage(JSON.stringify([{ bbox: [0, 0, 1, 1], category: 'Marginalia', text: 'x' }]), PARSE),
    (err: unknown) => err instanceof DotsPageError && err.page === 3 && /Marginalia/.test(err.message),
  );
});

test('an answer that is not JSON stops the page by name', () => {
  assert.throws(
    () => parseDotsPage('I am sorry, I cannot read this page.', PARSE),
    (err: unknown) => err instanceof DotsPageError && err.page === 3,
  );
});

test('a fenced answer is still an answer', () => {
  const parsed = parseDotsPage(
    '```json\n[{"bbox":[1,2,3,4],"category":"Text","text":"Fenced."}]\n```',
    PARSE,
  );
  assert.equal(parsed.blocks[0].text, 'Fenced.');
});

test('a Picture has no text and survives; an empty Text block does not', () => {
  const parsed = parseDotsPage(JSON.stringify([
    { bbox: [200, 300, 900, 800], category: 'Picture' },
    { bbox: [200, 900, 900, 920], category: 'Text', text: '   ' },
  ]), PARSE);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].category, 'Picture');
});

test('a Table whose HTML is broken stops the page by name', () => {
  // The check happens where the table is written into the book, which is the
  // last moment a page number is still attached to it.
  const parsed = parseDotsPage(JSON.stringify([
    { bbox: [0, 0, 10, 10], category: 'Table', text: '<table><tr><td>x</tr></table>' },
  ]), PARSE);
  assert.throws(
    () => buildChapterBody(parsed.blocks, chapterOptions()),
    (err: unknown) => err instanceof DotsPageError && err.page === 3,
  );
});

// ── markdown consumption ────────────────────────────────────────────────────

function block(overrides: Partial<DotsBlock> = {}): DotsBlock {
  return {
    page: 1,
    category: 'Text',
    box: { x1: 200, y1: 300, x2: 1100, y2: 700 },
    text: 'body',
    pageWidth: 1300,
    pageHeight: 2112,
    ...overrides,
  };
}

test('a leading-# line inside a Text block becomes a real heading', () => {
  const parts = consumeMarkdown(block({ text: '# The Lost Empire\n\nIt began in 1918.' }));
  assert.deepEqual(parts.map((p) => [p.category, p.text]), [
    ['Title', 'The Lost Empire'],
    ['Text', '\nIt began in 1918.'],
  ]);
});

test('## is a section header, not a title', () => {
  const parts = consumeMarkdown(block({ text: '## Part Two' }));
  assert.deepEqual(parts.map((p) => p.category), ['Section-header']);
});

test('a run of > lines becomes one Quote with the markers gone', () => {
  const parts = consumeMarkdown(block({ text: 'He wrote:\n> I shall not\n> yield.\nAnd he did not.' }));
  assert.deepEqual(parts.map((p) => [p.category, p.text]), [
    ['Text', 'He wrote:'],
    ['Quote', 'I shall not\nyield.'],
    ['Text', 'And he did not.'],
  ]);
});

test('markdown reaches the parser, so a heading in a Text block is a heading', () => {
  const parsed = parseDotsPage(JSON.stringify([
    { bbox: [200, 100, 1100, 700], category: 'Text', text: '# ONE\n\nIt began.' },
  ]), PARSE);
  assert.deepEqual(parsed.blocks.map((b) => b.category), ['Title', 'Text']);
});

// ── inline markup ───────────────────────────────────────────────────────────

test('bold, italic and a footnote marker survive as markup', () => {
  assert.equal(
    dotsInline("Hitler's **modus operandi**, on 4 *September*!¹⁴"),
    'Hitler&apos;s <strong>modus operandi</strong>, on 4 <em>September</em>!<sup>14</sup>',
  );
});

test('the markers come out for a narration build, and nothing else changes', () => {
  assert.equal(dotsInline('September¹⁴ came.', { stripNoteMarkers: true }), 'September came.');
});

test('a newline dots kept is a line ending, not a space', () => {
  assert.equal(dotsInline('II THE CHURCH\n2. THE STATE'), 'II THE CHURCH<br/>\n2. THE STATE');
});

test('the book\'s own prose cannot open an element', () => {
  assert.equal(dotsInline('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

// ── de-hyphenation ──────────────────────────────────────────────────────────

test('the book is its own dictionary for a line-broken word', () => {
  const lexicon = new BookLexicon([
    'The Koreans arrived. A self-determination clause followed.',
  ]);
  // The fused form is in the book.
  assert.equal(lexicon.join('Ko', 'reans'), 'Koreans');
  // The hyphenated compound is in the book.
  assert.equal(lexicon.join('self', 'determination'), 'self-determination');
  // Neither is: a lowercase continuation is a column break…
  assert.equal(lexicon.join('gov', 'ernment'), 'government');
  // …and a capital opens a compound.
  assert.equal(lexicon.join('Anglo', 'German'), 'Anglo-German');
});

test('a hyphen at end of line is repaired inside a block', () => {
  const lexicon = new BookLexicon(['The Koreans arrived.']);
  assert.equal(lexicon.dehyphenate('the Ko-\nreans of'), 'the Koreans of');
});

// ── alignment ───────────────────────────────────────────────────────────────

test('alignment is judged against the body column, not the page', () => {
  // A body column of 200..1100 on a 1300-wide page: itself centered on the
  // paper, which is exactly what makes the page-relative test useless.
  const blocks = [
    block({ box: { x1: 200, y1: 100, x2: 1100, y2: 400 } }),
    block({ box: { x1: 202, y1: 500, x2: 1098, y2: 800 } }),
  ];
  const column = bodyColumn(blocks, 1300);
  assert.equal(column.x1, 202);

  // An ordinary paragraph filling the column.
  assert.equal(alignmentClass({ x1: 200, y1: 0, x2: 1100, y2: 1 }, column), '');
  // A centered epigraph: balanced gaps, both real.
  assert.equal(alignmentClass({ x1: 450, y1: 0, x2: 860, y2: 1 }, column), 'centered');
  // A contents entry anchored left that happens to reach past the middle: it
  // cannot fake a left gap, and a midpoint test would have called it centered.
  assert.equal(alignmentClass({ x1: 202, y1: 0, x2: 800, y2: 1 }, column), '');
  // A right-aligned attribution.
  assert.equal(alignmentClass({ x1: 900, y1: 0, x2: 1098, y2: 1 }, column), 'right');
});

test('a line height comes from the box when the model kept no newlines', () => {
  assert.equal(lineHeight(block({ box: { x1: 0, y1: 0, x2: 100, y2: 400 }, text: 'reflowed' })), 40);
});

// ── the page turn ───────────────────────────────────────────────────────────

/** A raster with one horizontal ink run per row band, for the ink tests. */
function raster(width: number, height: number, runs: readonly [number, number, number, number][]) {
  const data = new Uint8Array(width * height).fill(255);
  for (const [x1, y1, x2, y2] of runs) {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) data[y * width + x] = 0;
  }
  return { width, height, data };
}

test('ink extents are measured from the box\'s own left edge', () => {
  const page = raster(200, 100, [[60, 10, 150, 20]]);
  assert.deepEqual(inkExtentIn(page, { x1: 50, y1: 0, x2: 200, y2: 100 }), { left: 10, right: 99 });
  assert.equal(inkExtentIn(page, { x1: 0, y1: 50, x2: 200, y2: 100 }), null);
});

function images(pages: Record<number, ReturnType<typeof raster>>): DotsPageImages {
  return {
    inkExtent: (page, box) => inkExtentIn(pages[page], box),
    crop: async () => [],
  };
}

test('a full last line and an unindented next page is a join', () => {
  // Page 1's block runs 100..1100; its last line reaches 1099, so the paragraph
  // did not end. Page 2's first line starts flush at 100.
  const previous = block({ page: 1, box: { x1: 100, y1: 100, x2: 1100, y2: 500 } });
  const next = block({ page: 2, box: { x1: 100, y1: 200, x2: 1100, y2: 600 } });
  assert.equal(carriesOver(previous, next, images({
    1: raster(1300, 700, [[100, 460, 1100, 490]]),
    2: raster(1300, 700, [[100, 205, 900, 235]]),
  })), true);
});

test('a short last line is a paragraph that ended', () => {
  const previous = block({ page: 1, box: { x1: 100, y1: 100, x2: 1100, y2: 500 } });
  const next = block({ page: 2, box: { x1: 100, y1: 200, x2: 1100, y2: 600 } });
  assert.equal(carriesOver(previous, next, images({
    1: raster(1300, 700, [[100, 460, 500, 490]]),
    2: raster(1300, 700, [[100, 205, 900, 235]]),
  })), false);
});

test('a first-line indent on the next page is a new paragraph', () => {
  const previous = block({ page: 1, box: { x1: 100, y1: 100, x2: 1100, y2: 500 } });
  const next = block({ page: 2, box: { x1: 100, y1: 200, x2: 1100, y2: 600 } });
  assert.equal(carriesOver(previous, next, images({
    1: raster(1300, 700, [[100, 460, 1100, 490]]),
    2: raster(1300, 700, [[160, 205, 900, 235]]),
  })), false);
});

test('a page turn is one page; a gap is a boundary', () => {
  // Pages 8 and 9 are a turn. Pages 8 and 12 are four missing pages, whether
  // they were struck out with --skip-pages or left out because the model could
  // not read them, and nothing may be joined across them.
  assert.equal(adjoins(block({ page: 8 }), block({ page: 8 })), true);
  assert.equal(adjoins(block({ page: 8 }), block({ page: 9 })), true);
  assert.equal(adjoins(block({ page: 8 }), block({ page: 10 })), false);
  assert.equal(adjoins(block({ page: 8 }), block({ page: 12 })), false);
});

test('neither join test is even asked across a gap', () => {
  // Both would say yes here: the first paragraph ends mid-clause and the second
  // opens lowercase, which is exactly what `continuesTextually` is looking for.
  // The pages are 1 and 3, so the sentence the join would build ran through a
  // page that is not in this book — and nobody wrote it.
  const gapped = buildChapterBody([
    block({ page: 1, text: 'The Reich was' }),
    block({ page: 3, text: 'divided in two.' }),
  ], chapterOptions());
  assert.equal(gapped.xhtml.match(/<p /g)?.length, 2);
  assert.deepEqual(gapped.joinedPages, []);

  // The same two blocks one page apart ARE one paragraph — the rule above is a
  // gap rule, not a new refusal to join.
  const turned = buildChapterBody([
    block({ page: 1, text: 'The Reich was' }),
    block({ page: 2, text: 'divided in two.' }),
  ], chapterOptions());
  assert.equal(turned.xhtml.match(/<p /g)?.length, 1);
  assert.deepEqual(turned.joinedPages, [2]);
});

test('the words decide first, and the ink is only asked when they do not', () => {
  assert.equal(continuesTextually('the Reich was', 'divided in two.'), true);
  assert.equal(continuesTextually('the Reich was divided.', 'Two years later'), false);
  assert.equal(continuesTextually('the Reich was', 'Two years later'), false);
});

// ── footnotes ───────────────────────────────────────────────────────────────

test('one Footnote block carrying three notes becomes three paragraphs', () => {
  assert.deepEqual(
    splitNotes('¹ Kershaw, p. 4.\n² Broszat, p. 12,\ncontinued here.\n³ Mommsen, p. 9.'),
    ['¹ Kershaw, p. 4.', '² Broszat, p. 12,\ncontinued here.', '³ Mommsen, p. 9.'],
  );
});

// ── chapters ────────────────────────────────────────────────────────────────

test('a chapter is proposed with its reasons, and only the first block on a page', () => {
  const blocks = [
    block({ page: 1, category: 'Title', text: 'CHAPTER ONE', box: { x1: 450, y1: 200, x2: 860, y2: 260 } }),
    block({ page: 1, category: 'Title', text: 'A SECOND TITLE', box: { x1: 450, y1: 400, x2: 860, y2: 460 } }),
    block({ page: 2, category: 'Section-header', text: 'A heading halfway down', box: { x1: 200, y1: 1400, x2: 900, y2: 1450 } }),
  ];
  const proposals = proposeChapters(blocks);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].text, 'CHAPTER ONE');
  assert.deepEqual(proposals[0].why, ['chapterish-text', 'title-class', 'centered']);
});

// ── what a page IS ──────────────────────────────────────────────────────────

/**
 * Every case here is either a page out of a real book — For the Soul of the
 * People, read by dots.ocr, blocks and boxes as they arrived — or the thing
 * that page is one measurement away from being. The second sort is the point:
 * a classifier that only ever sees what it is supposed to catch has not been
 * tested, it has been demonstrated.
 */
/** A block off a page of For the Soul of the People: 1700x2200 at 200 dpi. */
function soul(overrides: Partial<DotsBlock> = {}): DotsBlock {
  return block({ pageWidth: 1700, pageHeight: 2200, ...overrides });
}

const MID_BOOK: DotsPagePlace = { index: 40, bodyFollows: true };
const FRONT: DotsPagePlace = { index: 2, bodyFollows: true };

test('a half-title page is display type, centered, and nothing else', () => {
  const verdict = classifyPage([
    soul({ category: 'Title', text: 'FOR\nTHE SOUL\nOF THE\nPEOPLE', box: { x1: 666, y1: 251, x2: 1046, y2: 540 } }),
  ], FRONT);
  assert.equal(verdict?.kind, 'title-page');
  assert.deepEqual(verdict?.why, ['display-heading', '0-other-words', 'centered']);
});

test('a title page keeps its subtitle and its author, because they are short', () => {
  const verdict = classifyPage([
    soul({ category: 'Title', text: 'FOR\nTHE SOUL\nOF THE\nPEOPLE', box: { x1: 457, y1: 255, x2: 1234, y2: 849 } }),
    soul({ category: 'Picture', text: '', box: { x1: 811, y1: 910, x2: 881, y2: 978 } }),
    soul({ text: '*Protestant Protest*\n*Against Hitler*', box: { x1: 540, y1: 1028, x2: 1155, y2: 1210 } }),
    soul({ text: 'Victoria Barnett', box: { x1: 558, y1: 1372, x2: 1134, y2: 1441 } }),
  ], FRONT);
  assert.equal(verdict?.kind, 'title-page');
});

test('a dedication page is sparse and centered and is NOT a title page', () => {
  // Three short lines, no heading. Nothing here knows what it is, so it says
  // nothing — and the picker still shows the page.
  assert.equal(classifyPage([
    soul({ text: 'For Ruth McGinnis,\nand for Ulrich\nsine qua non', box: { x1: 665, y1: 404, x2: 1028, y2: 547 } }),
  ], FRONT), null);
});

test('a blank page is not a title page, and neither is a chapter opener', () => {
  assert.equal(classifyPage([soul({ text: 'BLANK PAGE' })], FRONT), null);
  assert.equal(classifyPage([
    soul({ category: 'Title', text: 'The Lost Empire', box: { x1: 528, y1: 274, x2: 1171, y2: 365 } }),
    soul({ text: 'THEY WERE BORN during the German Empire, in the final years of the reigns of the '
      + 'provincial German princes and of Kaiser Wilhelm II, from the royal Prussian house that had '
      + 'ruled since the seventeenth century and would not survive the war.' }),
  ], FRONT), null);
});

test('a heading that is not centered is not a title page', () => {
  assert.equal(classifyPage([
    soul({ category: 'Title', text: 'PREFACE', box: { x1: 200, y1: 200, x2: 500, y2: 260 } }),
  ], FRONT), null);
});

test('a copyright page is recognised by its boilerplate, and needs two of them', () => {
  const page = [
    soul({ text: 'Copyright © 1992 by Victoria Barnett' }),
    soul({ text: 'All rights reserved. No part of this publication may be reproduced.' }),
    soul({ text: 'Library of Congress Cataloging-in-Publication Data\nBarnett, Victoria.' }),
    soul({ text: 'ISBN 0-19-505306-0; ISBN 0-19-512118-X (paper)' }),
    soul({ text: '135798642' }),
  ];
  const verdict = classifyPage(page, FRONT);
  assert.equal(verdict?.kind, 'copyright');
  assert.deepEqual(verdict?.why, [
    'copyright-mark', 'isbn', 'all-rights-reserved', 'library-of-congress', 'printing-history',
  ]);

  // ONE mark is a permissions note, a bibliography entry, a line of front
  // matter that happens to say the word. It is not a copyright page.
  assert.equal(classifyPage([
    soul({ text: 'Reprinted by permission. Copyright 1988 by the Christian Century Foundation.' }),
  ], FRONT), null);
});

test('a page with a heading on it is not a copyright page', () => {
  assert.equal(classifyPage([
    soul({ category: 'Section-header', text: 'Permissions', box: { x1: 200, y1: 200, x2: 500, y2: 260 } }),
    soul({ text: 'Copyright © 1992. All rights reserved. ISBN 0-19-505306-0.' }),
  ], FRONT), null);
});

test('a contents page is the word and then the numbers', () => {
  const verdict = classifyPage([
    soul({ category: 'Title', text: 'Contents', box: { x1: 759, y1: 368, x2: 1106, y2: 448 } }),
    soul({ text: '*Introduction, 3*' }),
    soul({ category: 'Section-header', text: 'I OMENS' }),
    soul({ category: 'List-item', text: '1. The Lost Empire, 9' }),
    soul({ category: 'List-item', text: '2. The Weimar Years, 18' }),
    soul({ category: 'List-item', text: '11. Postwar Germans and Their Church: Rebirth or Restoration? 239' }),
  ], { index: 8, bodyFollows: true });
  assert.equal(verdict?.kind, 'contents');
  assert.deepEqual(verdict?.why, ['contents-heading', '4-numbered-entries']);
});

test('the word alone is not a contents page', () => {
  // A reference work with a `Contents` heading over a paragraph of prose.
  assert.equal(classifyPage([
    soul({ category: 'Section-header', text: 'Contents' }),
    soul({ text: 'The volume gathers essays written between 1979 and 1991.' }),
  ], MID_BOOK), null);
});

test('an index page is not a contents page', () => {
  assert.equal(classifyPage([
    soul({ category: 'Title', text: 'Index' }),
    soul({ text: 'Action for Reconciliation, 293\nAdenauer, Konrad, 206, 212, 225\nAryan laws, 127' }),
  ], MID_BOOK), null);
});

test('a part divider is a roman numeral and a short title, alone on the page', () => {
  const verdict = classifyPage([
    soul({ category: 'Section-header', text: 'III', box: { x1: 799, y1: 235, x2: 894, y2: 326 } }),
    soul({ category: 'Section-header', text: 'RESISTANCE\nAND GUILT', box: { x1: 484, y1: 478, x2: 1205, y2: 693 } }),
  ], MID_BOOK);
  assert.equal(verdict?.kind, 'part');
  assert.deepEqual(verdict?.why, ['roman-numeral', 'short-title', 'near-empty-page']);
  // The nav entry is the number AND the name: `III` alone tells a reader nothing.
  assert.equal(verdict?.label, 'III RESISTANCE AND GUILT');
});

test('the part\'s name may be an ordinary Text block, and the numeral lowercase', () => {
  const verdict = classifyPage([
    soul({ category: 'Section-header', text: 'iv', box: { x1: 808, y1: 229, x2: 879, y2: 320 } }),
    soul({ text: '"THE INABILITY\nTO MOURN"', box: { x1: 395, y1: 480, x2: 1298, y2: 692 } }),
  ], MID_BOOK);
  assert.equal(verdict?.kind, 'part');
  // Verbatim. Upper-casing it would be inventing a word the page does not carry.
  assert.equal(verdict?.label, 'iv "THE INABILITY TO MOURN"');
});

test('Part Two says so, and needs no numeral rule at all', () => {
  const verdict = classifyPage([
    soul({ category: 'Title', text: 'Part Two' }),
    soul({ text: 'The War Years' }),
  ], MID_BOOK);
  assert.equal(verdict?.kind, 'part');
  assert.deepEqual(verdict?.why, ['part-heading', 'near-empty-page']);
  assert.equal(verdict?.label, 'Part Two');
});

test('a bare ARABIC numeral is a chapter as often as a part, so it is neither', () => {
  assert.equal(classifyPage([
    soul({ category: 'Section-header', text: '5' }),
    soul({ category: 'Section-header', text: 'Daily Life and Work' }),
  ], MID_BOOK), null);
});

test('a short word made of roman letters is not a roman numeral', () => {
  // C, I, V, I, L are all numeral letters and CIVIL is not a numeral.
  assert.equal(classifyPage([
    soul({ category: 'Title', text: 'CIVIL' }),
    soul({ text: 'War and Memory' }),
  ], MID_BOOK), null);
});

test('a chapter that opens with its first paragraph is not a divider', () => {
  assert.equal(classifyPage([
    soul({ category: 'Section-header', text: 'IV' }),
    soul({ category: 'Section-header', text: 'Convictions and Conflicts' }),
    soul({ text: 'THE WAYS in which individuals confronted Nazism depended upon their backgrounds '
      + 'and personalities as well as upon their political persuasions. Both theological and '
      + 'political differences divided the church opposition from its first days.' }),
  ], MID_BOOK), null);
});

test('a divider with nothing after it is not a part', () => {
  // The last such page in a book is a colophon, and a part opens something.
  assert.equal(classifyPage([
    soul({ category: 'Section-header', text: 'III' }),
    soul({ category: 'Section-header', text: 'RESISTANCE AND GUILT' }),
  ], { index: 40, bodyFollows: false }), null);
});

test('a part divider in the front matter window is not looked for', () => {
  // Front matter is asked the front-matter questions and nothing else: a page
  // of centered display type there is a half-title, not a part.
  const verdict = classifyPage([
    soul({ category: 'Section-header', text: 'III', box: { x1: 799, y1: 235, x2: 894, y2: 326 } }),
    soul({ category: 'Section-header', text: 'RESISTANCE\nAND GUILT', box: { x1: 484, y1: 478, x2: 1205, y2: 693 } }),
  ], FRONT);
  assert.equal(verdict?.kind, 'title-page');
});

test('body prose is what a divider does not have', () => {
  assert.equal(carriesBodyProse([soul({ text: 'BLANK PAGE' })]), false);
  assert.equal(carriesBodyProse([soul({ category: 'Title', text: 'OMENS' })]), false);
  assert.equal(carriesBodyProse([soul({ text: 'one two three four five six seven eight nine ten '
    + 'eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty '
    + 'twenty-one twenty-two twenty-three twenty-four twenty-five' })]), true);
});

// ── the book ────────────────────────────────────────────────────────────────

function chapterOptions() {
  return {
    column: { x1: 200, x2: 1100 },
    lexicon: new BookLexicon([]),
    images: images({}),
    stripNoteMarkers: false,
    firstNote: 1,
    firstPicture: 0,
  };
}

test('every element carries the page it came from and the model\'s own category', () => {
  const body = buildChapterBody([
    block({ page: 7, category: 'Title', text: 'ONE' }),
    block({ page: 7, category: 'Text', text: 'A paragraph.' }),
    block({ page: 7, category: 'Footnote', text: '¹ A note.' }),
  ], chapterOptions());
  assert.match(body.xhtml, /<h1 data-bf-page="7" data-bf-cat="title">/);
  assert.match(body.xhtml, /<p data-bf-page="7" data-bf-cat="text">/);
  assert.match(body.xhtml, /class="footnote" epub:type="footnote" id="fn1" data-bf-page="7" data-bf-cat="footnote"/);
  // The print-source page marker, once per page, at the first element from it.
  assert.equal(body.xhtml.match(/epub:type="pagebreak"/g)?.length, 1);
});

test('footnotes leave the prose and land at the end of the chapter', () => {
  const body = buildChapterBody([
    block({ page: 1, category: 'Footnote', text: '¹ First note.' }),
    block({ page: 1, category: 'Text', text: 'The prose.' }),
  ], chapterOptions());
  assert.ok(body.xhtml.indexOf('The prose.') < body.xhtml.indexOf('First note.'));
  assert.equal(body.notes, 1);
});

test('a paragraph joined across a page turn is one paragraph, hyphen resolved', async () => {
  const pages = [
    {
      page: 1,
      dropped: 0,
      rawExtent: { x: 1100, y: 700 },
      blocks: [block({ page: 1, category: 'Text', text: 'The Ko-' })],
    },
    {
      page: 2,
      dropped: 0,
      rawExtent: { x: 1100, y: 700 },
      blocks: [block({ page: 2, category: 'Text', text: 'reans arrived. The Koreans left.' })],
    },
  ];
  const built = await buildDotsBook({
    metadata: { title: 'A Book', language: 'en', identifier: 'urn:x:1' },
    pages,
    images: images({}),
    stripNoteMarkers: false,
  });
  const entries = unzipMap(built.bytes);
  const chapter = entries.get('EPUB/text/c0001.xhtml')!.text();
  // One paragraph, and the two halves of the broken word are one word in it.
  assert.equal(chapter.match(/<p /g)?.length, 1);
  assert.match(chapter.replace(/<[^>]*>/g, ''), /^The Koreans arrived\. The Koreans left\.$/m);
  assert.equal(built.joinedPages.length, 1);
  // And the second page's marker went INSIDE the paragraph, where the page
  // turn actually happened.
  assert.match(chapter, /<span epub:type="pagebreak"[^>]*id="pb-2"/);
});

// ── the sections a named page opens ─────────────────────────────────────────

/** No ink anywhere: the page-turn join is not what these tests are about. */
const blindImages: DotsPageImages = { inkExtent: () => null, crop: async () => [] };

function page(number: number, blocks: DotsBlock[]) {
  return {
    page: number,
    dropped: 0,
    rawExtent: { x: 1100, y: 700 },
    blocks: blocks.map((b) => ({ ...b, page: number })),
  };
}

/** The shape of For the Soul of the People, in the fewest blocks that carry it. */
function partedBook() {
  const prose = (text: string): DotsBlock => soul({ text: `${text} ${'word '.repeat(30)}` });
  return [
    page(1, [soul({ category: 'Title', text: 'FOR THE SOUL OF THE PEOPLE', box: { x1: 666, y1: 251, x2: 1046, y2: 540 } })]),
    page(2, [soul({ text: 'BLANK PAGE', box: { x1: 733, y1: 542, x2: 960, y2: 571 } })]),
    page(3, [
      soul({ text: 'Copyright © 1992 by Victoria Barnett. All rights reserved.' }),
      soul({ text: 'ISBN 0-19-505306-0' }),
    ]),
    page(4, [
      soul({ category: 'Title', text: 'Contents', box: { x1: 759, y1: 368, x2: 1106, y2: 448 } }),
      soul({ category: 'List-item', text: '1. The Lost Empire, 9' }),
      soul({ category: 'List-item', text: '2. The Weimar Years, 18' }),
      soul({ category: 'List-item', text: '3. The Early Period, 30' }),
    ]),
    page(5, [
      soul({ category: 'Title', text: 'The Lost Empire', box: { x1: 528, y1: 274, x2: 1171, y2: 365 } }),
      prose('THEY WERE BORN during the German Empire.'),
    ]),
    page(6, [prose('Human memory and loyalty are affected by what follows.')]),
    page(7, [prose('So this is what they would remember: the German Empire.')]),
    // Past the front-matter window, which is where a divider page is a part
    // rather than a half-title.
    page(8, [
      soul({ category: 'Section-header', text: 'III', box: { x1: 799, y1: 235, x2: 894, y2: 326 } }),
      soul({ category: 'Section-header', text: 'RESISTANCE AND GUILT', box: { x1: 484, y1: 478, x2: 1205, y2: 693 } }),
    ]),
    page(9, [soul({ text: 'Blank Page', box: { x1: 763, y1: 399, x2: 929, y2: 436 } })]),
    // The chapter after the part opens with a Quote — the model read its big
    // display numeral as one — so NOTHING proposes a chapter here. This is the
    // page that proved a named section has to end at its own page.
    page(10, [
      soul({ category: 'Quote', text: '11 >' }),
      soul({ category: 'Section-header', text: 'Postwar Germans and Their Church', box: { x1: 359, y1: 306, x2: 1318, y2: 603 } }),
      prose('IN 1967, THE NEUROLOGIST Alexander Mitscherlich observed.'),
    ]),
    page(11, [
      soul({ category: 'Title', text: 'Index', box: { x1: 734, y1: 390, x2: 955, y2: 464 } }),
      prose('Adenauer, Konrad, 206, 212, 225.'),
    ]),
  ];
}

test('the named pages open their own sections, and a part ends at its own page', () => {
  const sections = proposeSections(partedBook());
  assert.deepEqual(sections.map((s) => [s.page, s.kind]), [
    [1, 'title-page'],
    [3, 'copyright'],
    [4, 'contents'],
    [5, 'chapter'],
    [8, 'part'],
    // Opened only because the part had to end: page 9 is a blank leaf and page
    // 10 is the chapter the part opens. Nothing named it, so it has no kind.
    [10, null],
    [11, 'chapter'],
  ]);
  assert.equal(sections.find((s) => s.page === 8)?.label, 'III RESISTANCE AND GUILT');
});

test('a blank leaf stays with the page that named itself', () => {
  // Page 2 carries neither prose nor a heading, so it does not close page 1's
  // section — a nav entry reading `Chapter 2: BLANK PAGE` helps nobody.
  const sections = proposeSections(partedBook());
  assert.equal(sections.some((s) => s.page === 2 || s.page === 9), false);
});

test('a named page is never also a chapter proposal', () => {
  // Every one of these would be proposed as a chapter by the chapter rule: a
  // short centered heading, first on its page, near the top.
  const kinds = proposeSections(partedBook()).filter((s) => s.kind !== null && s.kind !== 'chapter');
  assert.deepEqual(kinds.map((s) => s.kind), ['title-page', 'copyright', 'contents', 'part']);
  for (const section of kinds) assert.equal(section.why.length > 0, true);
});

test('the nav nests the chapters under their part, and back matter beside it', () => {
  const chapters = [
    { id: 'c1', href: 'text/c0001.xhtml', label: 'Introduction', blocks: 1, firstPage: 1, lastPage: 1 },
    { id: 'c2', href: 'text/c0002.xhtml', label: 'III RESISTANCE', blocks: 1, firstPage: 2, lastPage: 2, kind: 'part' as const },
    { id: 'c3', href: 'text/c0003.xhtml', label: 'Reflections', blocks: 1, firstPage: 3, lastPage: 3 },
    { id: 'c4', href: 'text/c0004.xhtml', label: 'The Guilt of Others', blocks: 1, firstPage: 4, lastPage: 4 },
    // Named for what it is, so it is not part of the argument of Part III.
    { id: 'c5', href: 'text/c0005.xhtml', label: 'Index', blocks: 1, firstPage: 5, lastPage: 5 },
  ];
  assert.deepEqual(navTree(chapters), [
    { href: 'text/c0001.xhtml', label: 'Introduction' },
    {
      href: 'text/c0002.xhtml',
      label: 'III RESISTANCE',
      children: [
        { href: 'text/c0003.xhtml', label: 'Reflections' },
        { href: 'text/c0004.xhtml', label: 'The Guilt of Others' },
      ],
    },
    { href: 'text/c0005.xhtml', label: 'Index' },
  ]);
});

test('a book with no parts gets the nav it always got', () => {
  const chapters = [
    { id: 'c1', href: 'text/c0001.xhtml', label: 'One', blocks: 1, firstPage: 1, lastPage: 1 },
    { id: 'c2', href: 'text/c0002.xhtml', label: 'Two', blocks: 1, firstPage: 2, lastPage: 2 },
  ];
  assert.deepEqual(navTree(chapters), [
    { href: 'text/c0001.xhtml', label: 'One' },
    { href: 'text/c0002.xhtml', label: 'Two' },
  ]);
});

test('a named section is stamped for the picker, and a proposed chapter is not', async () => {
  const built = await buildDotsBook({
    metadata: { title: 'A Book', language: 'en', identifier: 'urn:x:1' },
    pages: partedBook(),
    images: blindImages,
    stripNoteMarkers: false,
  });
  const entries = unzipMap(built.bytes);
  for (const [path, entry] of entries) {
    if (!path.endsWith('.xhtml') && !path.endsWith('.opf') && !path.endsWith('.xml')) continue;
    checkXml(entry.text(), path, { xhtml: path.endsWith('.xhtml') });
  }

  assert.deepEqual(
    built.chapters.map((c) => c.kind),
    ['title-page', 'copyright', 'contents', 'chapter', 'part', undefined, 'chapter'],
  );
  assert.match(
    entries.get('EPUB/text/c0001.xhtml')!.text(),
    /<section data-bf-kind="title-page" data-bf-page="1">/,
  );
  assert.match(
    entries.get('EPUB/text/c0005.xhtml')!.text(),
    /<section data-bf-kind="part" data-bf-page="8">/,
  );
  // The chapter rule is a proposal a person curates. It stays out of the book.
  assert.equal(entries.get('EPUB/text/c0004.xhtml')!.text().includes('data-bf-kind'), false);

  // A copyright page carries no heading, so the nav needs a word for it, and
  // the honest word is the one the classifier used.
  assert.deepEqual(built.chapters.map((c) => c.label), [
    'FOR THE SOUL OF THE PEOPLE', 'Copyright', 'Contents', 'The Lost Empire',
    'III RESISTANCE AND GUILT', 'Postwar Germans and Their Church', 'Index',
  ]);

  // And the nav nests, with the chapter the part opened inside it.
  assert.match(
    entries.get('EPUB/nav.xhtml')!.text(),
    /<li><a href="text\/c0005.xhtml">III RESISTANCE AND GUILT<\/a>\n\s+<ol>\n\s+<li><a href="text\/c0006.xhtml">/,
  );
});

test('the container is an EPUB and every document parses', async () => {
  const built = await buildDotsBook({
    metadata: { title: 'A & B', language: 'en', identifier: 'urn:x:1' },
    pages: [{
      page: 1,
      dropped: 0,
      rawExtent: { x: 1100, y: 700 },
      blocks: [
        block({ page: 1, category: 'Title', text: 'CHAPTER ONE', box: { x1: 450, y1: 200, x2: 860, y2: 260 } }),
        block({ page: 1, category: 'Text', text: 'A & B <notatag>.' }),
        block({ page: 1, category: 'Table', text: '<table><tr><td>x</td></tr></table>' }),
      ],
    }],
    images: images({}),
    stripNoteMarkers: false,
  });
  const entries = unzipMap(built.bytes);

  const mimetype = entries.get('mimetype')!;
  assert.equal(mimetype.text(), 'application/epub+zip');
  assert.equal(mimetype.method, 0);
  assert.equal(mimetype.localOffset, 0);

  for (const [path, entry] of entries) {
    if (!path.endsWith('.xhtml') && !path.endsWith('.opf') && !path.endsWith('.xml')) continue;
    checkXml(entry.text(), path, { xhtml: path.endsWith('.xhtml') });
  }
  assert.deepEqual(built.chapters.map((c) => c.label), ['CHAPTER ONE']);
  assert.match(entries.get('EPUB/text/c0001.xhtml')!.text(), /A &amp; B &lt;notatag&gt;\./);
});
