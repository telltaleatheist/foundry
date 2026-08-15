/**
 * The overlay: what a person decided about the blocks, and what a run does
 * with it.
 *
 * Two halves, and the first one is the contract with whatever writes the file.
 * An overlay is app-written, so every malformed shape is REFUSED BY NAME — the
 * cases below are the mistakes a writer actually makes (a misspelled field, a
 * page as a string, a category that is nearly right) and each is asserted on the
 * sentence, because a refusal that does not say which amendment is wrong is a
 * refusal nobody can act on.
 *
 * The second half is what applying one means: struck blocks gone from every
 * rendering, categories and text rewritten, a `part` naming one sub-block of a
 * split and its absence naming all of them, the last amendment winning per
 * field, and the chapter marks landing at the place the book decides where to
 * divide rather than in a pass over documents that have already been cut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyOverlay,
  emptyOverlay,
  loadOverlay,
  overlayTally,
  parseOverlay,
  resolveCategory,
  VlmOverlayError,
  type Overlay,
} from '../../src/vlm/overlay.js';
import { consumeMarkdown, parseDotsPage, type DotsBlock } from '../../src/vlm/dots.js';
import { proposeSections } from '../../src/vlm/dots-book.js';

function block(overrides: Partial<DotsBlock> = {}): DotsBlock {
  return {
    page: 1,
    order: 0,
    part: 0,
    category: 'Text',
    box: { x1: 200, y1: 300, x2: 1100, y2: 700 },
    text: 'body',
    pageWidth: 1300,
    pageHeight: 2112,
    ...overrides,
  };
}

/** An overlay straight from the object, without going through a file. */
function overlay(...amendments: unknown[]): Overlay {
  return parseOverlay(JSON.stringify({ overlay: 1, amendments }), 'overlay.json');
}

/** The refusal's sentence, for a shape that must not be accepted. */
function refusal(json: unknown): string {
  try {
    parseOverlay(JSON.stringify(json), 'overlay.json');
  } catch (err) {
    assert.ok(err instanceof VlmOverlayError, `not an overlay error: ${String(err)}`);
    return err.message;
  }
  assert.fail(`this overlay was accepted and should not have been: ${JSON.stringify(json)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The contract with whatever writes the file
// ─────────────────────────────────────────────────────────────────────────────

test('a file that is not JSON is refused, and says it was written whole', () => {
  const message = (() => {
    try {
      parseOverlay('{"overlay": 1, "amendments": [', 'curation.json');
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  })();
  assert.match(message, /curation\.json is not JSON/);
  // The contrast with readings.ts is the whole point of being strict here, so
  // the sentence has to carry it.
  assert.match(message, /written whole/);
});

test('the schema version is required and 1 is the only one', () => {
  assert.match(refusal({ amendments: [] }), /"overlay": undefined/);
  assert.match(refusal({ overlay: 2, amendments: [] }), /"overlay": 2.*only overlay schema/s);
});

test('an overlay with no amendments list is refused; an empty one is legal', () => {
  assert.match(refusal({ overlay: 1 }), /carries no "amendments"/);
  assert.equal(parseOverlay('{"overlay":1,"amendments":[]}', 'o.json').amendments.length, 0);
});

test('an unknown category is refused, naming the value and every category there is', () => {
  const message = refusal({
    overlay: 1,
    amendments: [{ at: { page: 3, order: 1 }, category: 'Footnotes' }],
  });
  assert.match(message, /amendment 0/);
  assert.match(message, /"Footnotes"/);
  for (const named of ['Caption', 'Footnote', 'Picture', 'Section-header', 'Table', 'Text', 'Title']) {
    assert.ok(message.includes(named), `the refusal does not name ${named}`);
  }
});

test('a page, order or part that is not a whole number is refused by name', () => {
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: '3', order: 1 }, strike: true }] }),
    /"at"\.page is "3"/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 0, order: 1 }, strike: true }] }),
    /"at"\.page is 0/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 3, order: -1 }, strike: true }] }),
    /"at"\.order is -1/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 3, order: 1.5 }, strike: true }] }),
    /"at"\.order is 1\.5/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 3, order: 1, part: -2 }, strike: true }] }),
    /"at"\.part is -2/,
  );
});

test('a field this program does not read is refused, not ignored', () => {
  // The failure this closes: `struck` instead of `strike` is a curation
  // somebody made that quietly did nothing.
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 3, order: 1 }, struck: true }] }),
    /a field called "struck"/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 3, order: 1, piece: 0 }, strike: true }] }),
    /a field called "piece"/,
  );
  assert.match(refusal({ overlay: 1, amendments: [], notes: 'hello' }), /top-level field called "notes"/);
});

test('an amendment that decides nothing is refused', () => {
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 3, order: 1 } }] }),
    /says nothing about it/,
  );
});

test('strike is a boolean, and a string that looks like one is not', () => {
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 1, order: 0 }, strike: 'true' }] }),
    /"strike": "true"/,
  );
});

test('an empty text override is refused and points at strike', () => {
  const message = refusal({ overlay: 1, amendments: [{ at: { page: 1, order: 0 }, text: '' }] });
  assert.match(message, /"text": ""/);
  assert.match(message, /"strike": true/);
});

test('generation rides along as the app wrote it, and must be a string', () => {
  const parsed = parseOverlay(
    JSON.stringify({ overlay: 1, generation: 'g-42', amendments: [] }),
    'o.json',
  );
  assert.equal(parsed.generation, 'g-42');
  // Carried, never interpreted: nothing in this program compares two of them.
  assert.match(refusal({ overlay: 1, generation: 42, amendments: [] }), /"generation": 42/);
  assert.equal(parseOverlay('{"overlay":1,"amendments":[]}', 'o.json').generation, undefined);
});

test('loadOverlay names a file that is not there rather than rendering as if none of it happened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-overlay-test-'));
  const missing = path.join(dir, 'nope.json');
  assert.throws(() => loadOverlay(missing), (err: unknown) =>
    err instanceof VlmOverlayError && err.message.includes(missing));

  const written = path.join(dir, 'curation.json');
  fs.writeFileSync(written, JSON.stringify({
    overlay: 1,
    amendments: [{ at: { page: 7, order: 14 }, strike: true }],
  }));
  assert.equal(loadOverlay(written).amendments.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// What applying one means
// ─────────────────────────────────────────────────────────────────────────────

test('an empty overlay changes nothing at all', () => {
  const blocks = [block({ order: 0 }), block({ order: 1, category: 'Picture', text: '' })];
  const out = applyOverlay(blocks, emptyOverlay());
  assert.deepEqual(out, blocks);
  // The same objects, not copies: passes downstream key working state by block
  // identity and rewrite `text` in place.
  assert.equal(out[0], blocks[0]);
});

test('a struck block is out of the list and a struck Picture never reaches a crop', () => {
  const blocks = [
    block({ order: 0, text: 'kept' }),
    block({ order: 1, category: 'Picture', text: '' }),
    block({ order: 2, text: 'also kept' }),
  ];
  const out = applyOverlay(blocks, overlay({ at: { page: 1, order: 1 }, strike: true }));
  assert.deepEqual(out.map((b) => b.order), [0, 2]);
  assert.equal(out.some((b) => b.category === 'Picture'), false);
});

test('a reclassified block is rendered as the category a person gave it', () => {
  const blocks = [block({ order: 4, text: '1. See Kershaw, p. 22.' })];
  const out = applyOverlay(blocks, overlay({ at: { page: 1, order: 4 }, category: 'Footnote' }));
  assert.equal(out[0].category, 'Footnote');
  // The model's own answer is untouched in the block it came from.
  assert.equal(blocks[0].category, 'Text');
});

test('the person is the top layer of the category resolution, over the model', () => {
  const b = block({ category: 'Title' });
  assert.equal(resolveCategory(b, emptyOverlay()), 'Title');
  assert.equal(resolveCategory(b, overlay({ at: { page: 1, order: 0 }, category: 'Text' })), 'Text');
});

test('a text override replaces the words and nothing else about the block', () => {
  const blocks = [block({ text: 'Tbe Lost Empke' })];
  const out = applyOverlay(blocks, overlay({ at: { page: 1, order: 0 }, text: 'The Lost Empire' }));
  assert.equal(out[0].text, 'The Lost Empire');
  assert.equal(out[0].category, 'Text');
  assert.deepEqual(out[0].box, blocks[0].box);
  assert.equal(out[0].part, 0);
});

test('a text override does NOT re-split the block, whatever markdown is in it', () => {
  /*
   * The split is what MAKES the part numbers, so a correction that renumbered
   * the blocks would move every other amendment in the file onto a different
   * block. One block in, one block out, hash marks and all.
   */
  const blocks = [block({ text: 'plain' })];
  const out = applyOverlay(
    blocks,
    overlay({ at: { page: 1, order: 0 }, text: '# A Heading\nand a paragraph' }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'Text');
  assert.equal(out[0].text, '# A Heading\nand a paragraph');
});

// ── part targeting ──────────────────────────────────────────────────────────

/** The three sub-blocks a markdown split makes out of one answer element. */
function split(): DotsBlock[] {
  const parts = consumeMarkdown(block({
    order: 3,
    text: '# The Lost Empire\nIt began in 1918.\n> a quoted line',
  }));
  assert.deepEqual(parts.map((p) => [p.part, p.category]), [
    [0, 'Title'], [1, 'Text'], [2, 'Quote'],
  ]);
  return parts;
}

test('a split numbers its sub-blocks, and they all keep the parent order', () => {
  const parts = split();
  assert.deepEqual(parts.map((p) => p.order), [3, 3, 3]);
  // Deterministic: the same answer splits into the same numbers every time,
  // which is what makes an amendment written today still true tomorrow.
  assert.deepEqual(split().map((p) => p.part), parts.map((p) => p.part));
});

test('an amendment with part touches that sub-block and no other', () => {
  const out = applyOverlay(split(), overlay({ at: { page: 1, order: 3, part: 1 }, strike: true }));
  assert.deepEqual(out.map((b) => b.part), [0, 2]);
});

test('an amendment without part is about every part of the answer element', () => {
  const out = applyOverlay(split(), overlay({ at: { page: 1, order: 3 }, category: 'Footnote' }));
  assert.deepEqual(out.map((b) => b.category), ['Footnote', 'Footnote', 'Footnote']);
});

test('a part-targeted text override leaves its siblings saying what the model said', () => {
  const out = applyOverlay(
    split(),
    overlay({ at: { page: 1, order: 3, part: 1 }, text: 'It began in 1919.' }),
  );
  assert.deepEqual(out.map((b) => b.text), ['The Lost Empire', 'It began in 1919.', 'a quoted line']);
});

// ── later wins, per field ───────────────────────────────────────────────────

test('two amendments about one block: the later one wins, field by field', () => {
  const out = applyOverlay([block()], overlay(
    { at: { page: 1, order: 0 }, category: 'Footnote', text: 'first' },
    { at: { page: 1, order: 0 }, category: 'Caption' },
  ));
  // The later amendment carried a category and no text, so it takes the
  // category and leaves the text exactly as the earlier one set it.
  assert.equal(out[0].category, 'Caption');
  assert.equal(out[0].text, 'first');
});

test('a strike can be taken back by a later amendment', () => {
  const out = applyOverlay([block()], overlay(
    { at: { page: 1, order: 0 }, strike: true },
    { at: { page: 1, order: 0 }, strike: false },
  ));
  assert.equal(out.length, 1);
});

test('part-less and part-ed amendments fold in file order, with no precedence', () => {
  const wildcardLast = applyOverlay(split(), overlay(
    { at: { page: 1, order: 3, part: 0 }, category: 'Caption' },
    { at: { page: 1, order: 3 }, category: 'Text' },
  ));
  assert.deepEqual(wildcardLast.map((b) => b.category), ['Text', 'Text', 'Text']);

  const specificLast = applyOverlay(split(), overlay(
    { at: { page: 1, order: 3 }, category: 'Text' },
    { at: { page: 1, order: 3, part: 0 }, category: 'Caption' },
  ));
  assert.deepEqual(specificLast.map((b) => b.category), ['Caption', 'Text', 'Text']);
});

test('the tally counts what the overlay did, before anything was removed', () => {
  const blocks = [block({ order: 0 }), block({ order: 1 }), block({ order: 2 })];
  const tally = overlayTally(blocks, overlay(
    { at: { page: 1, order: 0 }, strike: true },
    { at: { page: 1, order: 1 }, category: 'Footnote' },
    { at: { page: 1, order: 2 }, join: true },
    { at: { page: 1, order: 2 }, text: 'corrected' },
  ));
  assert.deepEqual(tally, { struck: 1, reclassified: 1, corrected: 1, joined: 1 });
});

// ── the spine ───────────────────────────────────────────────────────────────

/** Two pages: a heading nothing would propose, and a heading everything would. */
function pages(): ReturnType<typeof parseDotsPage>[] {
  const page = (number: number, elements: unknown[]) => parseDotsPage(
    JSON.stringify(elements),
    { page: number, render: { width: 1300, height: 2112 }, maxPixels: 11289600 },
  );
  return [
    page(1, [
      // Body prose, low on the page, in no way a chapter opener.
      { bbox: [200, 900, 1100, 1400], category: 'Text', text: 'A paragraph of prose that goes on and on for a while, as prose does.' },
      { bbox: [200, 1500, 1100, 1900], category: 'Text', text: 'And a second paragraph under it, also prose, also long enough to count.' },
    ]),
    page(2, [
      { bbox: [400, 200, 900, 300], category: 'Title', text: 'CHAPTER II' },
      { bbox: [200, 500, 1100, 1400], category: 'Text', text: 'The prose of the second chapter, which runs on for a good while.' },
    ]),
  ];
}

/** An overlay whose chapter list is exactly these locations. */
function spine(...chapters: unknown[]): Overlay {
  return parseOverlay(JSON.stringify({ overlay: 1, chapters, amendments: [] }), 'overlay.json');
}

test('with no chapter list the rules decide, exactly as they always did', () => {
  const detected = proposeSections(pages());
  assert.deepEqual(detected.map((p) => [p.page, p.why.join(',')]), [
    [2, 'chapterish-text,title-class,centered'],
  ]);
  // An overlay carrying only amendments says nothing about the spine.
  const amended = proposeSections(pages(), overlay({ at: { page: 1, order: 0 }, strike: true }));
  assert.deepEqual(amended.map((p) => p.page), [2]);
});

test('a chapter list is definitive: it splits where it says and nowhere else', () => {
  const listed = proposeSections(
    pages(),
    spine({ at: { page: 1, order: 1 }, title: 'Chapter 4 — The Windmill' }),
  );
  // The heading on page 2 that every rule would have split on does NOT open a
  // section: removing an entry from the list IS the demotion.
  assert.deepEqual(listed.map((p) => [p.page, p.label, p.why.join(',')]), [
    [1, 'Chapter 4 — The Windmill', 'listed'],
  ]);
  // No kind either — nothing classified anything, and the opener is an
  // ordinary block at the top of its section.
  assert.equal(listed[0].kind, null);
});

test('an EMPTY chapter list says the book has no divisions, and is not the same as none', () => {
  assert.deepEqual(proposeSections(pages(), spine()), []);
  assert.equal(proposeSections(pages(), emptyOverlay()).length, 1);
});

test('the title is the contents entry and the block still says what the page said', () => {
  const listed = proposeSections(
    pages(),
    spine({ at: { page: 2, order: 0 }, title: 'The Road to Nuremberg' }),
  );
  assert.equal(listed[0].label, 'The Road to Nuremberg');
  assert.equal(listed[0].text, 'CHAPTER II');
});

test('a chapter location naming a block this book does not contain is skipped, not refused', () => {
  // The page was struck out with --skip-pages, or could not be read, or the
  // block was struck by this same overlay. None of those is a broken book.
  const listed = proposeSections(pages(), spine(
    { at: { page: 2, order: 0 }, title: 'Judgment' },
    { at: { page: 99, order: 0 }, title: 'A page that is not here' },
  ));
  assert.deepEqual(listed.map((p) => p.label), ['Judgment']);
});

test('a chapter can start at one part of a split answer element', () => {
  const listed = proposeSections(
    [parseDotsPage(
      JSON.stringify([
        { bbox: [200, 200, 1100, 900], category: 'Text', text: 'front matter\n# THE SECOND HALF\nand its prose' },
      ]),
      { page: 1, render: { width: 1300, height: 2112 }, maxPixels: 11289600 },
    )],
    spine({ at: { page: 1, order: 0, part: 1 }, title: 'The Second Half' }),
  );
  assert.deepEqual(listed.map((p) => [p.index, p.label]), [[1, 'The Second Half']]);
});

// ── the list is the spine, so its shape is checked hard ─────────────────────

test('chapter locations must be strictly ascending in reading order', () => {
  const backwards = refusal({
    overlay: 1,
    amendments: [],
    chapters: [
      { at: { page: 30, order: 1 }, title: 'Second' },
      { at: { page: 12, order: 0 }, title: 'First' },
    ],
  });
  assert.match(backwards, /chapter 1 starts at page 12, order 0, part 0/);
  assert.match(backwards, /before the chapter above it \(page 30, order 1, part 0\)/);

  const duplicate = refusal({
    overlay: 1,
    amendments: [],
    chapters: [
      { at: { page: 30, order: 1 }, title: 'One' },
      { at: { page: 30, order: 1 }, title: 'Two' },
    ],
  });
  assert.match(duplicate, /the same block as the chapter above it/);

  // Part is part of reading order: two chapters in one answer element are fine
  // as long as they are in order.
  const parts = parseOverlay(JSON.stringify({
    overlay: 1,
    amendments: [],
    chapters: [
      { at: { page: 3, order: 2, part: 0 }, title: 'One' },
      { at: { page: 3, order: 2, part: 1 }, title: 'Two' },
    ],
  }), 'o.json');
  assert.equal(parts.chapters?.length, 2);
});

test('a chapter needs a location and a non-empty title, and takes nothing else', () => {
  assert.match(
    refusal({ overlay: 1, amendments: [], chapters: [{ at: { page: 1, order: 0 }, title: '' }] }),
    /chapter 0 says "title": ""/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [], chapters: [{ at: { page: 1, order: 0 } }] }),
    /chapter 0 says "title": undefined/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [], chapters: [{ at: { page: 0, order: 0 }, title: 'x' }] }),
    /chapter 0's "at"\.page is 0/,
  );
  assert.match(
    refusal({
      overlay: 1,
      amendments: [],
      chapters: [{ at: { page: 1, order: 0 }, title: 'x', kind: 'part' }],
    }),
    /chapter 0 carries a field called "kind"/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [], chapters: {} }),
    /"chapters" that is not an array/,
  );
});

test('chapter and title are no longer amendment fields at all', () => {
  // The spine is a list about the BOOK, not a pile of marks about blocks, and a
  // file written against the older shape must not half-apply.
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 1, order: 0 }, chapter: true }] }),
    /a field called "chapter"/,
  );
  assert.match(
    refusal({ overlay: 1, amendments: [{ at: { page: 1, order: 0 }, title: 'x' }] }),
    /a field called "title"/,
  );
});

test('an overlay a PowerShell redirect wrote — BOM and all — still parses', () => {
  /*
   * `Set-Content -Encoding utf8` and `>` put U+FEFF on the front of the file,
   * and JSON.parse refuses one. This file is written by the app, so it will
   * usually be clean; it is also the one file in this program a person is most
   * likely to hand-edit or a script most likely to copy, and "is not JSON" is a
   * true sentence pointing at an invisible cause. See src/bom.ts.
   */
  const shape = { overlay: 1, amendments: [{ at: { page: 7, order: 14 }, strike: true }] };
  const parsed = parseOverlay(`\uFEFF${JSON.stringify(shape)}`, 'curation.json');
  assert.equal(parsed.amendments.length, 1);
  assert.equal(parsed.amendments[0].strike, true);

  // And off disk, which is how it actually arrives.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-overlay-bom-'));
  const file = path.join(dir, 'curation.json');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(shape)}`, 'utf8');
  assert.equal(loadOverlay(file).amendments.length, 1);

  // The mark is stripped at the door and nowhere else: a U+FEFF inside a
  // block's text is a zero-width no-break space, which is somebody's content.
  const inside = parseOverlay(
    JSON.stringify({ overlay: 1, amendments: [{ at: { page: 1, order: 0 }, text: 'a\uFEFFb' }] }),
    'curation.json',
  );
  assert.equal(inside.amendments[0].text, 'a\uFEFFb');
});
