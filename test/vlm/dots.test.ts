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
  consumeMarkdown,
  continuesTextually,
  DotsPageError,
  dotsInline,
  lineHeight,
  parseDotsPage,
  renderScale,
  smartResize,
  type DotsBlock,
} from '../../src/vlm/dots.js';
import {
  buildChapterBody,
  buildDotsBook,
  carriesOver,
  inkExtentIn,
  proposeChapters,
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
