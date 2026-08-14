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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { epubFinal } from '../../src/epub/final.js';

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
import { bodyTypeSize, typeSize } from '../../src/vlm/typography.js';
import {
  adjoins,
  bareNumbersAreSectionMarks,
  buildChapterBody,
  buildDotsBook,
  carriesOver,
  foldDuplicateSections,
  furnitureKey,
  inkExtentIn,
  navTree,
  openingHeadings,
  proposeChapters,
  proposeSections,
  reflowWrappedProse,
  splitNotes,
  suppressRunningHeads,
  type DotsCrop,
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

test('page furniture is out of the book, and kept as evidence', () => {
  const parsed = parseDotsPage(JSON.stringify([
    { bbox: [500, 40, 800, 70], category: 'Page-header', text: 'IAN KERSHAW' },
    { bbox: [100, 200, 1200, 900], category: 'Text', text: 'The body of the page.' },
    { bbox: [500, 2000, 800, 2050], category: 'Page-footer', text: '106' },
  ]), PARSE);
  assert.equal(parsed.furniture.length, 2);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].text, 'The body of the page.');
  // What the furniture SAYS is the only thing that can identify the same
  // running head on a page where the model called it a Title.
  assert.deepEqual(parsed.furniture.map((b) => b.text), ['IAN KERSHAW', '106']);
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
    order: 0,
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

// ── the paragraph the model forgot to reflow ────────────────────────────────

/** Five lines of a justified column, 66 characters each but the last. */
const PRINT_LINES = 'Through the years I dipped casually into the story. What I encoun\n'
  + 'tered was a considerable literature dealing with the legal dust ki\n'
  + 'cked up by the trial of the Nazis before the International Militar\n'
  + 'y Tribunal of Nuremberg. Most of these books made a contribution t\n'
  + 'o understanding.';

test('a paragraph the model did not reflow is put back together', () => {
  const paragraph = block({ text: PRINT_LINES });
  assert.deepEqual(reflowWrappedProse([paragraph]), [paragraph]);
  assert.equal(paragraph.text.includes('\n'), false);
  assert.match(paragraph.text, /^Through the years I dipped casually into the story\. What I encoun tered /);
});

test('verse is short lines, and short lines are never reflowed', () => {
  // The same block shape, and the measurement that separates them is the only
  // thing there is: a justified column fills every line but its last.
  const verse = block({ text: 'Half a league, half a league,\nHalf a league onward,\nAll in the valley of Death' });
  assert.deepEqual(reflowWrappedProse([verse]), []);
  assert.match(verse.text, /league,\nHalf/);
});

test('a blank line is structure the model went out of its way to keep', () => {
  const abbreviations = block({
    text: 'AFN Armed Forces Network, the broadcaster that carried the verdict\n\n'
      + 'BAP Papers of Colonel Burton Andrus, the commandant of the prison',
  });
  assert.deepEqual(reflowWrappedProse([abbreviations]), []);
});

test('a bibliography breaks at the end of every entry, and stays a list', () => {
  // Each entry is long enough to pass the line-length rule on its own. What
  // says these are entries rather than a wrapped column is that EVERY break
  // lands on a full stop, which is not where a margin arrives.
  const bibliography = block({
    text: 'POSNER, Gerald L. *Hitler\'s Children*. New York: Random House, 1991.\n'
      + 'ROSENBAUM, Ron. *Travels with Dr. Death and Other Investigations*. New York: Penguin, 1991.\n'
      + 'SHIRER, William L. *End of a Berlin Diary*. New York: Alfred A. Knopf, 1947.\n'
      + 'SPEER, Albert. *Inside the Third Reich*. New York: Macmillan, 1970.',
  });
  assert.deepEqual(reflowWrappedProse([bibliography]), []);

  // Two lines that both end in a full stop are one sentence that happened to
  // end at the margin, which is a coincidence a book produces constantly.
  const prose = block({
    text: 'To the very end of it, he had been quite unable to turn his back on Hitler.\n'
      + 'And he had never found the right moment to deliver his brave speech.',
  });
  assert.deepEqual(reflowWrappedProse([prose]), [prose]);
});

test('only a Text block is reflowed — a Quote is where the verse is', () => {
  const quote = block({ category: 'Quote', text: PRINT_LINES });
  const heading = block({ category: 'Title', text: PRINT_LINES });
  assert.deepEqual(reflowWrappedProse([quote, heading]), []);
  assert.equal(quote.text, PRINT_LINES);
  assert.equal(heading.text, PRINT_LINES);
});

test('the hyphen the page ends on is still there for the page-turn join', () => {
  // Reflow runs after dehyphenation and before the join, so a block that ends
  // mid-word still ends mid-word.
  const paragraph = block({ text: `${PRINT_LINES.replace(/\n[^\n]*$/, '')}\no understanding of the inti-` });
  assert.deepEqual(reflowWrappedProse([paragraph]), [paragraph]);
  assert.match(paragraph.text, /inti-$/);
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

test('a marker links to its note and the note links back', () => {
  const body = buildChapterBody([
    block({ page: 4, category: 'Text', text: 'As Kershaw argues.¹' }),
    block({ page: 4, category: 'Footnote', text: '¹ Kershaw, p. 4.' }),
  ], chapterOptions());
  // Forward: the printed number, wrapped in a noteref that aims at the note.
  assert.match(
    body.xhtml,
    /<a id="ref-fn1" class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1<\/sup><\/a>/,
  );
  // Back: the note is an aside whose own number aims at the first reference.
  assert.match(
    body.xhtml,
    /<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1"[^>]*>/,
  );
  assert.match(
    body.xhtml,
    /<a class="fn-back" epub:type="backlink" role="doc-backlink" href="#ref-fn1"><sup>1<\/sup><\/a> Kershaw, p\. 4\./,
  );
});

test('printed numbers restart per page, and the page is what disambiguates them', () => {
  // Pages 4 and 6, not 4 and 5: adjacent Text blocks would ask the cross-page
  // ink join, which needs page rasters this test has no reason to build.
  const body = buildChapterBody([
    block({ page: 4, category: 'Text', text: 'First claim.¹' }),
    block({ page: 4, category: 'Footnote', text: '¹ Note on page four.' }),
    block({ page: 6, category: 'Text', text: 'Second claim.¹' }),
    block({ page: 6, category: 'Footnote', text: '¹ Note on page six.' }),
  ], chapterOptions());
  // Both markers are printed "1"; each links to its own page's note.
  assert.match(body.xhtml, /Second claim\.<a id="ref-fn2"[^>]*href="#fn2">/);
  assert.match(body.xhtml, /id="fn2"[^>]*>.*Note on page six/);
});

test('a marker with no matching note stays a plain sup — no link beats a wrong one', () => {
  const body = buildChapterBody([
    block({ page: 4, category: 'Text', text: 'A claim.⁷' }),
    block({ page: 4, category: 'Footnote', text: '¹ The only note.' }),
  ], chapterOptions());
  assert.match(body.xhtml, /A claim\.<sup>7<\/sup>/);
  assert.doesNotMatch(body.xhtml, /A claim\.<a /);
});

test('a note the model read one page late is still found', () => {
  const body = buildChapterBody([
    block({ page: 4, category: 'Text', text: 'A claim.¹' }),
    block({ page: 5, category: 'Footnote', text: '¹ The note, read on the next page.' }),
  ], chapterOptions());
  assert.match(body.xhtml, /A claim\.<a id="ref-fn1"[^>]*href="#fn1">/);
});

test('stripping the markers strips the links with them', () => {
  const body = buildChapterBody([
    block({ page: 4, category: 'Text', text: 'As Kershaw argues.¹' }),
    block({ page: 4, category: 'Footnote', text: '¹ Kershaw, p. 4.' }),
  ], { ...chapterOptions(), stripNoteMarkers: true });
  assert.match(body.xhtml, /As Kershaw argues\.<\/p>/);
  assert.doesNotMatch(body.xhtml, /noteref|fn-back/);
});

// ── the running head the model mistagged ────────────────────────────────────

/**
 * Nuremberg's defect, in the fewest pages that reproduce it.
 *
 * The running head `NUREMBERG` is tagged Page-header on three pages and a Title
 * on a fourth; `THE DEFENSE` is a running head on three pages AND the name of
 * the book's third part. Every number here is off the real book: the heads sit
 * at 0.07 of the page and the openers at 0.24, and there is nothing in between.
 */
function parsed(number: number, blocks: DotsBlock[], furniture: DotsBlock[] = []) {
  return {
    page: number,
    furniture: furniture.map((b) => ({ ...b, page: number })),
    rawExtent: { x: 1100, y: 700 },
    blocks: blocks.map((b) => ({ ...b, page: number })),
  };
}

/** A block in the top 7% of the page — where every running head in that book is. */
function head(text: string, category: DotsBlock['category'] = 'Title'): DotsBlock {
  return block({ category, text, box: { x1: 500, y1: 150, x2: 800, y2: 210 } });
}

/** A block a quarter of the way down — where every real opener in that book is. */
function opener(text: string, category: DotsBlock['category'] = 'Section-header'): DotsBlock {
  return block({ category, text, box: { x1: 500, y1: 500, x2: 800, y2: 590 } });
}

test('the same words are a running head at the top of the page and a heading below it', () => {
  const pages = [
    parsed(1, [block({ text: 'Body.' })], [head('NUREMBERG', 'Page-header')]),
    parsed(2, [block({ text: 'Body.' })], [head('NUREMBERG', 'Page-header')]),
    parsed(3, [block({ text: 'Body.' })], [head('NUREMBERG', 'Page-header')]),
    // The miss: the same head, called a Title, in the same place on the page.
    parsed(4, [head('NUREMBERG'), block({ text: 'Body.' })]),
    // The half-title, which is the one page where those words are the reader's.
    parsed(5, [opener('NUREMBERG', 'Title')]),
  ];
  const removed = suppressRunningHeads(pages);
  assert.deepEqual(removed.map((b) => [b.page, b.text]), [[4, 'NUREMBERG']]);
  assert.deepEqual(pages[3].blocks.map((b) => b.text), ['Body.']);
  assert.deepEqual(pages[4].blocks.map((b) => b.text), ['NUREMBERG']);
});

test('the REAL part divider survives its own running head', () => {
  // Page 306 of Nuremberg. `THE DEFENSE` heads 55 pages and names Part III, and
  // nothing about the words says which is which — only where they sit.
  const pages = [
    parsed(1, [block({ text: 'Body.' })], [head('THE DEFENSE', 'Page-header')]),
    parsed(2, [block({ text: 'Body.' })], [head('THE DEFENSE', 'Page-header')]),
    parsed(3, [head('THE DEFENSE')], [head('■ THE DEFENSE ■', 'Page-header')]),
    parsed(4, [opener('CHAPTER III'), opener('THE DEFENSE')]),
  ];
  const removed = suppressRunningHeads(pages);
  assert.deepEqual(removed.map((b) => b.page), [3]);
  assert.deepEqual(pages[3].blocks.map((b) => b.text), ['CHAPTER III', 'THE DEFENSE']);
});

test('letter-spacing and decoration are not what makes two heads different', () => {
  assert.equal(furnitureKey('N U R E M B E R G'), 'NUREMBERG');
  assert.equal(furnitureKey('■ INDEX ■'), 'INDEX');
  assert.equal(furnitureKey('• Index •'), 'INDEX');
  // The folio moves and the head does not, so every run of digits is one mark.
  assert.equal(furnitureKey('NUREMBERG 42'), furnitureKey('NUREMBERG 317'));
});

test('two pages are not a book\'s furniture', () => {
  // A heading that appears twice is a heading that appears twice. Three is
  // where repetition stops being something a book does by accident.
  const pages = [
    parsed(1, [block({ text: 'Body.' })], [head('AFTERMATH', 'Page-header')]),
    parsed(2, [head('AFTERMATH')]),
  ];
  assert.deepEqual(suppressRunningHeads(pages), []);
  assert.deepEqual(pages[1].blocks.map((b) => b.text), ['AFTERMATH']);
});

test('the model has to have called it furniture at least once', () => {
  // Four pages opening on the same short heading, and nothing anywhere in the
  // book saying any of them is a running head. Shape alone does not delete a
  // block: the model's own answer is the anchor — and where the model never
  // gave one, the BOOK has to, which these pages also cannot do. There is no
  // prose on any of them, so there is no body size to measure a head against
  // and the size path below has nothing to say either.
  const pages = [1, 2, 3, 4].map((n) => parsed(n, [head('PART ONE')]));
  assert.deepEqual(suppressRunningHeads(pages), []);
});

test('a running FOOT is judged at the bottom of the page', () => {
  const foot = (text: string, category: DotsBlock['category']): DotsBlock =>
    block({ category, text, box: { x1: 500, y1: 1950, x2: 800, y2: 2010 } });
  const pages = [
    parsed(1, [block({ text: 'Body.' })], [foot('THE NUREMBERG TRIAL', 'Page-footer')]),
    parsed(2, [block({ text: 'Body.' })], [foot('THE NUREMBERG TRIAL', 'Page-footer')]),
    parsed(3, [block({ text: 'Body.' })], [foot('THE NUREMBERG TRIAL', 'Page-footer')]),
    parsed(4, [block({ text: 'Body.' }), foot('THE NUREMBERG TRIAL', 'Text')]),
    // The same words in the body of the page are the book's, not the printer's.
    parsed(5, [opener('THE NUREMBERG TRIAL', 'Title')]),
  ];
  assert.deepEqual(suppressRunningHeads(pages).map((b) => b.page), [4]);
  assert.deepEqual(pages[4].blocks.map((b) => b.text), ['THE NUREMBERG TRIAL']);
});

test('a bare folio never attests anything, so a section mark is not deleted', () => {
  // This book sets its folio in the running head, at the top of the page, so
  // `#` is attested in the same band and on more pages than anything else. A
  // `16` the model called a Section-header is a section mark and belongs in the
  // book — `proposeChapters` is what stops it opening a chapter.
  const pages = [
    parsed(1, [block({ text: 'Body.' })], [head('204', 'Page-header')]),
    parsed(2, [block({ text: 'Body.' })], [head('205', 'Page-header')]),
    parsed(3, [block({ text: 'Body.' })], [head('206', 'Page-header')]),
    parsed(4, [head('16', 'Section-header'), block({ text: 'Body.' })]),
  ];
  assert.deepEqual(suppressRunningHeads(pages), []);
  assert.deepEqual(pages[3].blocks.map((b) => b.text), ['16', 'Body.']);
});

test('a long block is never a running head, whatever it says', () => {
  const sentence = 'NUREMBERG was the city where the trial was held, and this is a sentence '
    + 'from the body of the page that happens to open with the same word.';
  const pages = [
    parsed(1, [block({ text: 'Body.' })], [head('NUREMBERG', 'Page-header')]),
    parsed(2, [block({ text: 'Body.' })], [head('NUREMBERG', 'Page-header')]),
    parsed(3, [block({ text: 'Body.' })], [head('NUREMBERG', 'Page-header')]),
    parsed(4, [block({ text: sentence, box: { x1: 200, y1: 150, x2: 1100, y2: 300 } })]),
  ];
  assert.deepEqual(suppressRunningHeads(pages), []);
});

// ── the head the model NEVER tagged ─────────────────────────────────────────

/**
 * The hole the attested rule leaves, and the size evidence that closes it.
 *
 * Attestation works whenever the model got the head right ANYWHERE — five
 * tagged pages of Nuremberg's INDEX kill sixteen mistags. A head the model
 * mistags on EVERY page of the book is attested by nothing, and every copy of
 * it survives as a chapter that cuts a sentence in half. That is what the front
 * matter of the books in this library keeps arriving as.
 *
 * What identifies it without the model is that NO BOOK SETS A CHAPTER OPENER AT
 * BODY SIZE. Every block below is measured off that one fact, and the numbers
 * are a 40 px body line at 200 dpi — a line of 10 pt type — against an 80 px
 * display line.
 */
const BODY_LINES = 'The court rose at ten and the prisoner was brought in through the door '
  + 'behind the dock, and the room fell silent as the clerk began to read the indictment.';

/** A paragraph of the book's column: 200 px of box, five reflowed lines in it. */
function bodyProse(): DotsBlock {
  return block({ box: { x1: 200, y1: 600, x2: 1100, y2: 800 }, text: BODY_LINES });
}

/** A head at the top of the page, set at the size of the prose under it. */
function bodyHead(text: string, category: DotsBlock['category'] = 'Section-header'): DotsBlock {
  return block({ category, text, box: { x1: 500, y1: 120, x2: 800, y2: 160 } });
}

/** The same words in the same place, set at twice the body — an announcement. */
function displayHead(text: string, category: DotsBlock['category'] = 'Section-header'): DotsBlock {
  return block({ category, text, box: { x1: 500, y1: 120, x2: 800, y2: 200 } });
}

test('the body of the page measures 40 px a line, and a display head 80', () => {
  // The whole of the rule below rests on these two numbers being different, so
  // they are asserted before anything is deleted on the strength of them.
  assert.equal(bodyTypeSize([bodyProse()]), 40);
  assert.equal(typeSize(bodyHead('THE WITNESSES')), 40);
  assert.equal(typeSize(displayHead('THE WITNESSES')), 80);
});

test('a head the model never tagged once is furniture when the book itself says so', () => {
  // Four pages, the same short heading at the top of every one of them, at the
  // size of the prose underneath, and nothing anywhere in the book calling it a
  // running head. Under attestation alone all four survive as chapters.
  const pages = [1, 2, 3, 4].map((n) => parsed(n, [bodyHead('THE WITNESSES'), bodyProse()]));
  const removed = suppressRunningHeads(pages);
  assert.deepEqual(removed.map((b) => [b.page, b.why]), [
    [1, 'body-sized'], [2, 'body-sized'], [3, 'body-sized'], [4, 'body-sized'],
  ]);
  for (const page of pages) assert.deepEqual(page.blocks.map((b) => b.text), [BODY_LINES]);
});

test('the same words in display type are the reader\'s, and are never touched', () => {
  // This is the whole safety of the path. `THE DEFENSE` heads 55 pages of
  // Nuremberg AND names its third part; the band keeps that particular divider
  // out because it sits at 26% of the page, and the size gate is the second,
  // independent reason a real opener survives — even one printed high.
  const pages = [1, 2, 3, 4].map((n) => parsed(n, [displayHead('THE WITNESSES'), bodyProse()]));
  assert.deepEqual(suppressRunningHeads(pages), []);
});

test('one copy set big disqualifies the words everywhere in the book', () => {
  // Three body-sized copies and one display copy: the fourth page says these
  // words are an announcement somewhere, and a key that announces anything is
  // not deleted anywhere on the strength of its size.
  const pages = [
    parsed(1, [bodyHead('THE DEFENSE'), bodyProse()]),
    parsed(2, [bodyHead('THE DEFENSE'), bodyProse()]),
    parsed(3, [bodyHead('THE DEFENSE'), bodyProse()]),
    parsed(4, [displayHead('THE DEFENSE')]),
  ];
  assert.deepEqual(suppressRunningHeads(pages), []);
});

test('without the model\'s word, only a HEADING is deleted — never a paragraph', () => {
  // The size path is an inference off the book's shape rather than the model's
  // own answer, so it acts only where leaving the block does structural damage.
  // A head mistagged as a Title becomes a chapter and a nav entry; the same
  // words mistagged as Text are a stray line a reader can see, and a weaker
  // argument does not get to delete those.
  const pages = [1, 2, 3, 4].map((n) => parsed(n, [bodyHead('THE WITNESSES', 'Text'), bodyProse()]));
  assert.deepEqual(suppressRunningHeads(pages), []);
});

test('a bare folio is not furniture by size either', () => {
  // 201, 202, 203, 204 all reduce to `#`, on four pages, at body size, in the
  // band. The letter guard is the same one the attested path has and it is what
  // keeps a section mark in the book where the printer put it.
  const pages = [1, 2, 3, 4].map((n) => parsed(n, [bodyHead(String(200 + n)), bodyProse()]));
  assert.deepEqual(suppressRunningHeads(pages), []);
});

test('the model\'s own word outranks the book\'s shape, and the record says which fired', () => {
  const pages = [
    parsed(1, [bodyProse()], [bodyHead('NUREMBERG', 'Page-header')]),
    parsed(2, [bodyProse()], [bodyHead('NUREMBERG', 'Page-header')]),
    parsed(3, [bodyProse()], [bodyHead('NUREMBERG', 'Page-header')]),
    parsed(4, [bodyHead('NUREMBERG', 'Title'), bodyProse()]),
  ];
  // Body-sized and unattested-shaped, but the model called it a Page-header on
  // three pages, so the better evidence is the one that is reported.
  assert.deepEqual(suppressRunningHeads(pages).map((b) => [b.page, b.why]), [[4, 'tagged']]);
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

// ── the bare number: a chapter, or a section mark ───────────────────────────

/**
 * Nuremberg's numbering, in the fewest headings that carry it: four parts, each
 * numbered from 1. A novel's, in the same shape: 1, 2, 3, straight through.
 */
function numbered(values: readonly number[]): DotsBlock[] {
  return values.map((value, i) => block({
    page: i + 1,
    category: 'Section-header',
    text: String(value),
    box: { x1: 620, y1: 200, x2: 680, y2: 260 },
  }));
}

test('bare numbers that restart are section marks, and propose nothing', () => {
  // 1, 2, 3 … then 1 again at the second part. The restart is the evidence, and
  // it is not on any page — only the whole book has it.
  const blocks = numbered([1, 2, 3, 1, 2]);
  assert.equal(bareNumbersAreSectionMarks(blocks), true);
  assert.deepEqual(proposeChapters(blocks), []);
});

test('a repeat is a restart too, wherever it falls', () => {
  assert.equal(bareNumbersAreSectionMarks(numbered([1, 2, 2, 3])), true);
});

test('a numeral-chaptered novel keeps every split it always had', () => {
  const blocks = numbered([1, 2, 3, 4]);
  assert.equal(bareNumbersAreSectionMarks(blocks), false);
  assert.deepEqual(proposeChapters(blocks).map((p) => p.text), ['1', '2', '3', '4']);
});

test('one bare number in a book is evidence of neither', () => {
  const blocks = numbered([7]);
  assert.equal(bareNumbersAreSectionMarks(blocks), false);
  assert.deepEqual(proposeChapters(blocks).map((p) => p.text), ['7']);
});

test('a section-marked book still proposes its worded chapters', () => {
  // The rule takes away the bare numbers and nothing else: `CHAPTER III` on the
  // page after a restart is still a chapter.
  const blocks = [
    ...numbered([1, 2, 1]),
    block({ page: 4, category: 'Section-header', text: 'CHAPTER III', box: { x1: 560, y1: 200, x2: 740, y2: 260 } }),
  ];
  assert.deepEqual(proposeChapters(blocks).map((p) => p.text), ['CHAPTER III']);
});

test('a roman numeral is the part rule\'s business and is left alone', () => {
  // `II` after `III` is not increasing by any arithmetic this rule does — it
  // never looks at a numeral, so a book of roman-numbered divisions is
  // unchanged by the whole pass.
  const blocks = [
    block({ page: 1, category: 'Section-header', text: 'III', box: { x1: 620, y1: 200, x2: 680, y2: 260 } }),
    block({ page: 2, category: 'Section-header', text: 'II', box: { x1: 620, y1: 200, x2: 680, y2: 260 } }),
  ];
  assert.equal(bareNumbersAreSectionMarks(blocks), false);
  assert.deepEqual(proposeChapters(blocks).map((p) => p.text), ['III', 'II']);
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
    // Fresh per call, so each test's ids start at 1 and read as the ids of a
    // book that begins where the test's blocks begin.
    elementNumbers: new Map<number, number>(),
    openers: new Set<number>(),
  };
}

test('every element carries the page it came from and the model\'s own category', () => {
  const body = buildChapterBody([
    block({ page: 7, category: 'Title', text: 'ONE' }),
    block({ page: 7, category: 'Text', text: 'A paragraph.' }),
    block({ page: 7, category: 'Footnote', text: '¹ A note.' }),
  ], chapterOptions());
  assert.match(body.xhtml, /<h1 data-bf-page="7" data-bf-cat="title" data-bf-id="p7-1">/);
  assert.match(body.xhtml, /<p data-bf-page="7" data-bf-cat="text" data-bf-id="p7-2">/);
  assert.match(
    body.xhtml,
    /class="footnote" epub:type="footnote" role="doc-footnote" id="fn1" data-bf-page="7" data-bf-cat="footnote"/,
  );
  // The print-source page marker, once per page, at the first element from it.
  assert.equal(body.xhtml.match(/epub:type="pagebreak"/g)?.length, 1);
});

test('every stamped element gets an id of its own, and no two are the same', () => {
  /*
   * THE ONE PROPERTY THAT MATTERS: unique. Every other id a cast book carries
   * renumbers when the book is edited — `sh1` is a chapter-local ordinal,
   * `fn7` is book-wide, `c0003` is a chapter ordinal — so `data-bf-id` is the
   * only handle a person's "cut this block" can be recorded against.
   *
   * The list is the case that breaks a per-BLOCK scheme: one block writes both
   * a `<ul>` and an `<li>`, and both are stamped. The quote does the same with
   * `<blockquote>` and its `<p>`. Numbering elements rather than blocks is
   * what keeps those four apart.
   */
  const body = buildChapterBody([
    block({ page: 3, category: 'Title', text: 'A Heading' }),
    block({ page: 3, category: 'List-item', text: 'An item.' }),
    block({ page: 3, category: 'Quote', text: 'A quotation.' }),
    block({ page: 4, category: 'Text', text: 'A paragraph on the next page.' }),
  ], chapterOptions());

  const ids = [...body.xhtml.matchAll(/data-bf-id="([^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(ids, ['p3-1', 'p3-2', 'p3-3', 'p3-4', 'p3-5', 'p4-1']);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');

  // The container and the thing inside it are two elements and two ids.
  assert.match(body.xhtml, /<ul data-bf-page="3" data-bf-cat="list-item" data-bf-id="p3-2">/);
  assert.match(body.xhtml, /<li data-bf-page="3" data-bf-cat="list-item" data-bf-id="p3-3">/);
  assert.match(body.xhtml, /<blockquote data-bf-page="3" data-bf-cat="quote" data-bf-id="p3-4">/);
  assert.match(body.xhtml, /<p data-bf-page="3" data-bf-cat="quote" data-bf-id="p3-5">/);

  // The ordinal is within the page, so a new page starts again at 1.
  assert.match(body.xhtml, /data-bf-page="4"[^>]*data-bf-id="p4-1"/);
});

test('a page split across two chapters does not issue the same id twice', () => {
  /*
   * The reason `elementNumbers` is passed in rather than started fresh. A
   * chapter opens at a heading and a heading can sit halfway down a page, so
   * one page's blocks routinely land in two documents. A count that restarted
   * per chapter would write `p9-1` in both of them — two elements wearing one
   * name, in the attribute whose entire job is to be unique.
   */
  const shared = chapterOptions();
  const first = buildChapterBody([
    block({ page: 9, category: 'Text', text: 'The end of the chapter before.' }),
  ], shared);
  const second = buildChapterBody([
    block({ page: 9, category: 'Title', text: 'The next chapter' }),
    block({ page: 9, category: 'Text', text: 'Its opening paragraph.' }),
  ], shared);

  assert.match(first.xhtml, /data-bf-id="p9-1"/);
  assert.match(second.xhtml, /data-bf-id="p9-2"/);
  assert.match(second.xhtml, /data-bf-id="p9-3"/);
  assert.doesNotMatch(second.xhtml, /data-bf-id="p9-1"/);
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
      furniture: [],
      rawExtent: { x: 1100, y: 700 },
      blocks: [block({ page: 1, category: 'Text', text: 'The Ko-' })],
    },
    {
      page: 2,
      furniture: [],
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
    furniture: [],
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

test('a chapter\'s section headers nest under it in the nav, as anchors into it', () => {
  const chapters = [
    {
      id: 'c1', href: 'text/c0001.xhtml', label: 'One', blocks: 4, firstPage: 1, lastPage: 9,
      headings: [{ id: 'sh1', label: 'The purge' }, { id: 'sh2', label: 'The oath' }],
    },
  ];
  assert.deepEqual(navTree(chapters), [
    {
      href: 'text/c0001.xhtml',
      label: 'One',
      children: [
        { href: 'text/c0001.xhtml#sh1', label: 'The purge' },
        { href: 'text/c0001.xhtml#sh2', label: 'The oath' },
      ],
    },
  ]);
});

test('inside a chapter, a later h2 is anchored and reported; the title heading is not', () => {
  const body = buildChapterBody([
    block({ page: 25, category: 'Section-header', text: 'PRELUDE' }),
    block({ page: 25, category: 'Text', text: 'THE PRISONER awoke.' }),
    block({ page: 25, category: 'Section-header', text: 'The purge' }),
  ], chapterOptions());
  assert.deepEqual(body.headings, [{ id: 'sh1', label: 'The purge' }]);
  assert.match(body.xhtml, /<h2 id="sh1" data-bf-page="25" data-bf-cat="section-header"[^>]*>The purge<\/h2>/);
  // The first heading is the chapter's own title — no anchor, no entry.
  assert.match(body.xhtml, /<h2 data-bf-page="25" data-bf-cat="section-header"[^>]*>.*PRELUDE<\/h2>/);
});

test('an opening heading never becomes a section entry, even when it is not the label', () => {
  const span = [
    block({ page: 25, category: 'Section-header', text: 'CHAPTER I' }),
    block({ page: 25, category: 'Section-header', text: 'PRELUDE TO JUDGMENT' }),
    block({ page: 25, category: 'Text', text: 'THE PRISONER awoke.' }),
  ];
  const body = buildChapterBody(span, { ...chapterOptions(), openers: openingHeadings(span, 'chapter') });
  assert.deepEqual(body.headings, []);
});

test('a chapter opener is stamped for the picker, both halves of it', () => {
  // Page 25 of Nuremberg: `CHAPTER I` and then `PRELUDE TO JUDGMENT`, two
  // blocks. A person moving the split needs both — one deleted and one left
  // behind is a chapter called `CHAPTER I` with an orphan line under it.
  const span = [
    block({ page: 25, category: 'Section-header', text: 'CHAPTER I' }),
    block({ page: 25, category: 'Section-header', text: 'PRELUDE TO JUDGMENT' }),
    block({ page: 25, category: 'Text', text: 'THE PRISONER awoke.' }),
    // The next page's heading is inside the chapter, not the start of one.
    block({ page: 26, category: 'Section-header', text: '2' }),
  ];
  const openers = openingHeadings(span, 'chapter');
  assert.deepEqual([...openers], [0, 1]);
  const body = buildChapterBody(span, { ...chapterOptions(), openers });
  assert.equal(body.xhtml.match(/data-bf-cat="chapter"/g)?.length, 2);
  assert.match(body.xhtml, /<h2[^>]*data-bf-cat="chapter"[^>]*>.*CHAPTER I<\/h2>/);
  // The tag still comes from the true category, and the heading inside the
  // chapter still carries the model's own word for what it is.
  assert.match(body.xhtml, /<h2[^>]*data-bf-cat="section-header"[^>]*>.*2<\/h2>/);
});

test('a part divider\'s announcement is a split point too', () => {
  // Its numeral and its name, with the page's stray blocks between them: a
  // divider carries nothing but its announcement, so nothing ends the run.
  const span = [
    block({ page: 8, category: 'Section-header', text: 'III' }),
    block({ page: 8, category: 'Picture', text: '' }),
    block({ page: 8, category: 'Section-header', text: 'RESISTANCE AND GUILT' }),
  ];
  assert.deepEqual([...openingHeadings(span, 'part')], [0, 2]);
  // A chapter's first paragraph is right under its title, and ends the run.
  assert.deepEqual([...openingHeadings(span, 'chapter')], [0]);
});

test('a section nothing proposed has no opener, and no chapter stamp', () => {
  const span = [block({ page: 10, category: 'Section-header', text: 'Postwar Germans' })];
  for (const kind of [null, 'title-page', 'copyright', 'contents'] as const) {
    assert.equal(openingHeadings(span, kind).size, 0);
  }
});

test('a named section is stamped for the picker, and a chapter opener with it', async () => {
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
  // The chapter rule is a proposal a person curates, and a proposal nobody can
  // see is nothing to curate: no `data-bf-kind` wrapper — that is a statement
  // about a whole section — and a `chapter` stamp on the heading it points at,
  // which is what puts it in the picker's Chapter Openings palette.
  const chapter = entries.get('EPUB/text/c0004.xhtml')!.text();
  assert.equal(chapter.includes('data-bf-kind'), false);
  assert.match(chapter, /<h1[^>]*data-bf-cat="chapter"[^>]*>.*The Lost Empire<\/h1>/);

  // A part divider is stamped on both blocks of its announcement, and keeps its
  // `data-bf-kind` wrapper: the two say different things and both are true.
  const part = entries.get('EPUB/text/c0005.xhtml')!.text();
  assert.equal(part.match(/data-bf-cat="chapter"/g)?.length, 2);

  // The section nothing named and nothing proposed is untouched — its heading
  // is still a section header, which is all anything here knows about it.
  assert.match(
    entries.get('EPUB/text/c0006.xhtml')!.text(),
    /<h2[^>]*data-bf-cat="section-header"[^>]*>/,
  );

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

// ── the section the book opened twice ───────────────────────────────────────

/**
 * Michelle Remembers (Congdon & Lattès, 1980), in the fewest pages that carry
 * its defect — and every one of them is off the conversion this pipeline
 * actually produced.
 *
 * Its nav opens with three documents called "Michelle Remembers": the cover on
 * page 1, the half-title on page 7 and the title page on page 9, each of which
 * sets the book's title in display type and each of which therefore proposes a
 * section. Then a "contents" and a "Contents", because the contents run over
 * the leaf and the printer reset the heading. Then "PART I" twice, because the
 * divider is printed on both sides of its leaf and `classifyPage` is right
 * about both of them. Nine documents into the book, six of them are the same
 * three things said twice or three times.
 */
function doubledBook() {
  const display = (text: string, category: DotsBlock['category'] = 'Title'): DotsBlock =>
    soul({ category, text, box: { x1: 600, y1: 300, x2: 1100, y2: 460 } });
  const prose = (text: string): DotsBlock => soul({ text: `${text} ${'word '.repeat(30)}` });
  const entries = (from: number): DotsBlock[] => [1, 2, 3].map((i) =>
    soul({ category: 'List-item', text: `${from + i}. A chapter of the book, ${(from + i) * 9}` }));
  return [
    page(1, [display('MICHELLE REMEMBERS'), soul({ text: 'The true story of a year-long contest' })]),
    page(2, [display('Michelle Remembers')]),
    page(3, [display('Michelle Remembers'), soul({ text: 'by Michelle Smith and Lawrence Pazder' })]),
    page(4, [display('Contents'), ...entries(0)]),
    page(5, [display('Contents'), ...entries(3)]),
    page(6, [prose('A NOTE FROM THE PUBLISHER: the reader is invited upon a journey.')]),
    // Past the front-matter window, which is where a divider page is a part.
    page(7, [display('PART I')]),
    page(8, [display('PART I', 'Section-header')]),
    page(9, [prose('MICHELLE WAS TWENTY-SEVEN when she came to Dr. Pazder.')]),
  ];
}

test('a title the book printed three times is one section, and the folds are named', async () => {
  const built = await buildDotsBook({
    metadata: { title: 'Michelle Remembers', language: 'en', identifier: 'urn:x:1' },
    pages: doubledBook(),
    images: blindImages,
    stripNoteMarkers: false,
  });
  // Five documents where there were nine. The survivor of each run is the FIRST
  // of it, so it keeps that section's label and its kind — a doubled part ends
  // as one part rather than as a part with a stray divider inside it.
  assert.deepEqual(built.chapters.map((c) => [c.firstPage, c.label, c.kind]), [
    [1, 'MICHELLE REMEMBERS', 'title-page'],
    [4, 'Contents', 'contents'],
    [6, 'Chapter 3', undefined],
    [7, 'PART I', 'part'],
    [9, 'Chapter 5', undefined],
  ]);
  // A document that quietly stopped existing is a document nobody can ask
  // about, so every fold names the page it was on and the words that opened it.
  assert.deepEqual(built.foldedSections, [
    { page: 2, text: 'Michelle Remembers' },
    { page: 3, text: 'Michelle Remembers' },
    { page: 5, text: 'Contents' },
    { page: 8, text: 'PART I' },
  ]);
  // And nothing was thrown away: the folded pages' blocks are inside the
  // section above them, where the reader can still get to them.
  const entries = unzipMap(built.bytes);
  const first = entries.get('EPUB/text/c0001.xhtml')!.text();
  assert.match(first, /by Michelle Smith and Lawrence Pazder/);
  assert.equal(first.match(/id="pb-[123]"/g)?.length, 3);
});

test('a decoration or a folio does not make two openings out of one', () => {
  // `furnitureKey` is what reduces them, exactly as it does for a running head:
  // letter-spacing, a printer's ornament and a page number are the three things
  // that vary between two printings of the same words.
  assert.equal(furnitureKey('MICHELLE\nREMEMBERS'), furnitureKey('Michelle Remembers'));
  assert.equal(furnitureKey('■ PART I ■'), furnitureKey('PART I'));
});

test('two sections with the same name that BOTH carry prose are both kept', () => {
  // The counter-case, and the reason the prose test is the one that cannot be
  // weakened: a diary that heads two chapters with the same year has two
  // chapters, and a reference work with two sections called "Notes" has two. A
  // split that was wrongly removed is uncorrectable from the finished book, and
  // a section that stayed merged costs a reader one scroll — so the rule
  // refuses whenever the later section is somebody's reading.
  const prose = (text: string): DotsBlock => soul({ text: `${text} ${'word '.repeat(30)}` });
  const heading = (): DotsBlock =>
    soul({ category: 'Title', text: 'DIARY', box: { x1: 700, y1: 500, x2: 1000, y2: 600 } });
  const pages = [
    page(1, [heading(), prose('THE FIRST ENTRY was written in the spring.')]),
    page(2, [heading(), prose('THE SECOND ENTRY was written a year later.')]),
  ];
  const sections = proposeSections(pages);
  assert.deepEqual(sections.map((s) => [s.page, s.text]), [[1, 'DIARY'], [2, 'DIARY']]);

  const starts = sections.map((s) => s.index);
  const opens: (typeof sections[number] | null)[] = [...sections];
  assert.deepEqual(foldDuplicateSections(pages.flatMap((p) => p.blocks), starts, opens), []);
  assert.deepEqual(starts, sections.map((s) => s.index));
});

test('a nameless section folds nothing and is folded into nothing', () => {
  // A copyright page carries no heading — that is half of what identifies it —
  // so there is no opening text to reduce, and an empty key never matches
  // another empty key. Absence of a name is not evidence that two sections are
  // the same section.
  const blocks = [
    block({ page: 1, text: 'Copyright © 1980. All rights reserved. ISBN 0-86553-001-7.' }),
    block({ page: 2, text: 'Printed in the United States of America by Haddon Craftsmen.' }),
  ];
  const starts = [0, 1];
  const opens = [null, null];
  assert.deepEqual(foldDuplicateSections(blocks, starts, opens), []);
  assert.deepEqual(starts, [0, 1]);
});

test('the container is an EPUB and every document parses', async () => {
  const built = await buildDotsBook({
    metadata: { title: 'A & B', language: 'en', identifier: 'urn:x:1' },
    pages: [{
      page: 1,
      furniture: [],
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

// ── the cover ───────────────────────────────────────────────────────────────

/**
 * A crop that answers, and remembers what it was asked for.
 *
 * The requests are the half of the cover worth asserting on: the BYTES are
 * whatever the subprocess handed back and nothing in the emitter looks inside
 * them, while "which page, and what box of it" is the entire rule this feature
 * is — and it is invisible in the finished file, because a wrong page produces
 * a cover that looks exactly as convincing as a right one.
 */
function cropping(): DotsPageImages & { asked: DotsCrop[] } {
  const asked: DotsCrop[] = [];
  return {
    inkExtent: () => null,
    asked,
    crop: async (requests) => {
      asked.push(...requests);
      return requests.map((request) => ({
        name: request.name,
        mediaType: 'image/png',
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }));
    },
  };
}

const COVER_META = { title: 'Working Towards the Fuhrer', language: 'en', identifier: 'urn:x:1' };

/** A paragraph long enough that `carriesBodyProse` calls it the book's own. */
const proseBlock = (text: string): DotsBlock => block({ text: `${text} ${'word '.repeat(30)}` });

test('the cover is the first page the book CONTAINS, not page 1', async () => {
  /*
   * `--skip-pages 1-6` on a real scan: the library wrapper, the blank leaf and
   * the scanner's colour card were struck out in a picker, so pages 1 to 6 were
   * never rasterised and there is no render of them to crop. A cover that
   * demanded page 1 would fail on exactly the books somebody curated — and the
   * first page they KEPT is the title page, which is what a cover should be.
   */
  const images = cropping();
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [
      page(7, [
        block({ category: 'Title', text: 'WORKING TOWARDS THE FUHRER' }),
        proseBlock('IN JANUARY 1933 the Republic ended.'),
      ]),
      page(8, [proseBlock('The years that followed were his own.')]),
    ],
    images,
    stripNoteMarkers: false,
  });

  assert.deepEqual(built.cover, { page: 7, why: null });
  const cover = images.asked.find((request) => request.name === 'cover.png');
  assert.ok(cover !== undefined, 'the whole page was never asked for');
  assert.equal(cover.page, 7);
  // THE WHOLE PAGE, which is what `pageWidth` × `pageHeight` is — the render's
  // own frame, the same one every block's box was scaled into.
  assert.deepEqual(cover.box, { x1: 0, y1: 0, x2: 1300, y2: 2112 });
  assert.ok(unzipMap(built.bytes).has('EPUB/images/cover.png'));
});

test('a page that survived the skip and carried nothing is not the cover', async () => {
  // The second half of the same argument. A blank leaf parses to a page with no
  // blocks on it, and cropping it would put a sheet of white paper on the shelf.
  const images = cropping();
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [
      page(7, []),
      page(8, [block({ category: 'Title', text: 'WORKING TOWARDS THE FUHRER' })]),
      page(9, [proseBlock('IN JANUARY 1933 the Republic ended.')]),
    ],
    images,
    stripNoteMarkers: false,
  });
  assert.deepEqual(built.cover, { page: 8, why: null });
  assert.equal(images.asked.find((request) => request.name === 'cover.png')?.page, 8);
});

test('one cover, declared three ways, and the three name each other', async () => {
  /*
   * Reading systems disagree about which declaration is the cover, so the book
   * makes all three — and the failure this test exists for is the one where
   * they disagree with each OTHER: a manifest id nothing references, a `<meta>`
   * pointing at an id that is not the image, or a spine entry for a document
   * that is not in the manifest. Each of those is a book that opens and is
   * wrong in a way only a reading system notices.
   */
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [page(1, [
      block({ category: 'Title', text: 'WORKING TOWARDS THE FUHRER' }),
      proseBlock('IN JANUARY 1933 the Republic ended.'),
    ])],
    images: cropping(),
    stripNoteMarkers: false,
  });
  const entries = unzipMap(built.bytes);
  for (const [path, entry] of entries) {
    if (!path.endsWith('.xhtml') && !path.endsWith('.opf') && !path.endsWith('.xml')) continue;
    checkXml(entry.text(), path, { xhtml: path.endsWith('.xhtml') });
  }

  const opf = entries.get('EPUB/package.opf')!.text();
  // 1. the EPUB 3 spelling.
  assert.match(
    opf,
    /<item id="cover-image" href="images\/cover\.png" media-type="image\/png" properties="cover-image"\/>/,
  );
  // 2. the EPUB 2 spelling, pointing at that same id.
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/);
  // 3. the document, in the manifest and FIRST in the spine — which is the
  // difference between a cover a reader sees and one only a library grid does.
  assert.match(opf, /<item id="cover" href="cover\.xhtml" media-type="application\/xhtml\+xml"\/>/);
  assert.match(opf, /<spine>\n\s+<itemref idref="cover"\/>\n\s+<itemref idref="c0001"\/>/);

  // And the document points at the image the manifest declared. The cover
  // document sits at the top of EPUB/, so the manifest href is also its `src`.
  const cover = entries.get('EPUB/cover.xhtml')!.text();
  assert.match(cover, /<img src="images\/cover\.png" alt="Working Towards the Fuhrer"/);
  assert.ok(entries.has('EPUB/images/cover.png'));
});

test('the cover is not a chapter, so nothing lists it in the contents', async () => {
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [
      page(1, [block({ category: 'Title', text: 'ONE' }), proseBlock('It began in 1918.')]),
      page(2, [block({ category: 'Title', text: 'TWO' }), proseBlock('It ended in 1945.')]),
    ],
    images: cropping(),
    stripNoteMarkers: false,
  });
  const nav = unzipMap(built.bytes).get('EPUB/nav.xhtml')!.text();
  assert.equal(nav.includes('cover.xhtml'), false);
  // One entry per chapter and not one more: a contents list whose first line is
  // "Cover" is a contents list describing the file rather than the book.
  assert.equal(nav.match(/<li><a href="text\//g)?.length, built.chapters.length);
  // The landmark for the start of the body is still the first CHAPTER, whatever
  // the spine opens with.
  assert.match(nav, /epub:type="bodymatter" href="text\/c0001\.xhtml"/);
});

test('a plain-text book gets no cover, and nothing is cropped for one', async () => {
  // Same reasoning as the pictures: a text file has no container to hold an
  // image, so the crop is not attempted — a run that cropped anyway would pay a
  // subprocess for bytes it then threw away, and could FAIL on an image the
  // book was never going to carry.
  const images = cropping();
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [page(1, [
      block({ category: 'Title', text: 'ONE' }),
      block({ category: 'Picture', text: '' }),
      proseBlock('It began in 1918.'),
    ])],
    images,
    format: 'txt',
    stripNoteMarkers: false,
  });
  // NULL, not a refusal: "this format has no cover" and "this cover could not
  // be cut" are different facts and only one of them is owed a sentence.
  assert.equal(built.cover, null);
  assert.deepEqual(images.asked, []);
  assert.equal(new TextDecoder().decode(built.bytes).includes('cover.png'), false);
});

test('a run that cannot crop the cover writes the book anyway and says why', async () => {
  /*
   * The one place in this file that catches an exception, and the argument for
   * it is the same one `epub-final`'s integrity report is built on: a book
   * nobody can produce is worse than a book with a stated gap. A conversion is
   * minutes of GPU; a missing cover is a grey rectangle the run has already
   * named, with every word of the book still in it.
   */
  const refuses: DotsPageImages = {
    inkExtent: () => null,
    crop: async () => { throw new Error('page-0007.png is not on disk'); },
  };
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [page(7, [
      block({ category: 'Title', text: 'ONE' }),
      proseBlock('It began in 1918.'),
    ])],
    images: refuses,
    stripNoteMarkers: false,
  });

  assert.equal(built.cover?.page, null);
  // Named, and named with the page — the one fact somebody would go and look at.
  assert.match(built.cover!.why!, /page 7 could not be cut out of its render/);
  assert.match(built.cover!.why!, /page-0007\.png is not on disk/);

  // And the book is here, whole, with no half-written cover in it.
  const entries = unzipMap(built.bytes);
  assert.ok(entries.has('EPUB/text/c0001.xhtml'));
  assert.equal(entries.has('EPUB/cover.xhtml'), false);
  assert.equal(entries.has('EPUB/images/cover.png'), false);
  const opf = entries.get('EPUB/package.opf')!.text();
  assert.equal(opf.includes('cover'), false);
});

test('epub-final FINDS the cover foundry wrote', async () => {
  /*
   * The end-to-end proof, and the reason it is worth a temp directory: the
   * three declarations above are only correct if they are the ones somebody
   * else looks for. `epub-final` already had the check — it reported "this book
   * declares NO COVER" on every book foundry has ever cast — and it shares no
   * code with the emitter, so it is the independent reader of what was written.
   */
  const built = await buildDotsBook({
    metadata: COVER_META,
    pages: [page(1, [
      block({ category: 'Title', text: 'ONE' }),
      proseBlock('It began in 1918.'),
    ])],
    images: cropping(),
    stripNoteMarkers: false,
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-cover-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    fs.writeFileSync(epub, built.bytes);
    const report = await epubFinal({
      epubPath: epub,
      outPath: path.join(dir, 'Buch.final.epub'),
      log: () => {},
    });
    assert.equal(report.cover, true);
    // And the edition still carries it: a cover is referenced by the package
    // rather than by prose, and the image sweep must not read that as dead
    // weight.
    assert.deepEqual(report.imagesDropped, []);
    const written = unzipMap(new Uint8Array(fs.readFileSync(path.join(dir, 'Buch.final.epub'))));
    assert.ok(written.has('EPUB/images/cover.png'));
    assert.ok(written.has('EPUB/cover.xhtml'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
