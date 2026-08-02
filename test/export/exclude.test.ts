/**
 * One filter, two granularities (PIPELINE.md). The CLI's `--exclude <category>`
 * and BookForge's per-box deletion list COMPOSE, and the record they produce
 * has to be complete enough that the export is reproducible from it alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyExclusions, ExclusionError, NEVER_EMITTED, resolveCategory } from '../../src/export/exclude.js';
import type { Block } from '../../src/pipeline/artifacts.js';
import type { BlocksCategory } from '../../src/blocks/encoder.js';

function block(id: string, category: BlocksCategory): Block {
  return {
    id, page: 0, bbox: [0, 0, 10, 10], lineIds: [`${id}-l`], category,
    geometry: { firstLineIndent: 0, gapAbove: 1, prevLineShort: false, prevEndsWrapHyphen: false },
  };
}

const BOOK: Block[] = [
  block('h1', 'header'),
  block('b1', 'body'),
  block('b2', 'body'),
  block('c1', 'caption'),
  block('f1', 'footnote'),
  block('f2', 'footnote'),
  block('d1', 'discard'),
  block('ft1', 'footer'),
];

test('page furniture and discard are never emitted, without being asked', () => {
  const { kept, record } = applyExclusions(BOOK);
  assert.deepEqual(kept.map(b => b.id), ['b1', 'b2', 'c1', 'f1', 'f2']);
  assert.deepEqual(record.droppedByNeverEmitted, { header: 1, discard: 1, footer: 1 });
  assert.deepEqual(record.neverEmittedCategories.sort(), ['discard', 'footer', 'header']);
  assert.deepEqual([...NEVER_EMITTED].sort(), ['discard', 'footer', 'header']);
});

test('a category exclusion drops every block of that category', () => {
  const { kept, record } = applyExclusions(BOOK, { categories: ['footnote'] });
  assert.deepEqual(kept.map(b => b.id), ['b1', 'b2', 'c1']);
  assert.deepEqual(record.droppedByCategory, { footnote: 2 });
  assert.equal(record.droppedById, 0);
});

test('an id exclusion drops exactly that block', () => {
  const { kept, record } = applyExclusions(BOOK, { blockIds: ['f1'] });
  assert.deepEqual(kept.map(b => b.id), ['b1', 'b2', 'c1', 'f2']);
  assert.equal(record.droppedById, 1);
  assert.deepEqual(record.droppedByCategory, {});
});

test('the two granularities compose', () => {
  const { kept, record } = applyExclusions(BOOK, { categories: ['caption'], blockIds: ['b2'] });
  assert.deepEqual(kept.map(b => b.id), ['b1', 'f1', 'f2']);
  assert.deepEqual(record.droppedByCategory, { caption: 1 });
  assert.equal(record.droppedById, 1);
});

test('a block excluded both ways counts once, against its category', () => {
  // droppedById is meant to answer "are my per-box deletions doing anything",
  // so a block the category filter already removed must not inflate it.
  const { record } = applyExclusions(BOOK, { categories: ['footnote'], blockIds: ['f1'] });
  assert.deepEqual(record.droppedByCategory, { footnote: 2 });
  assert.equal(record.droppedById, 0);
});

test('the record accounts for every block', () => {
  const { record, kept } = applyExclusions(BOOK, { categories: ['footnote'], blockIds: ['c1'] });
  const dropped = Object.values(record.droppedByCategory).reduce((a, b) => a + b, 0)
    + Object.values(record.droppedByNeverEmitted).reduce((a, b) => a + b, 0)
    + record.droppedById;
  assert.equal(record.totalBlocks, BOOK.length);
  assert.equal(record.keptBlocks, kept.length);
  assert.equal(record.keptBlocks + dropped, record.totalBlocks);
});

test('the record replays: excluding by the recorded ids reproduces the same book', () => {
  const first = applyExclusions(BOOK, { categories: ['footnote'], blockIds: ['c1'] });
  const replay = applyExclusions(BOOK, {
    categories: first.record.excludedCategories,
    blockIds: first.record.excludedBlockIds,
  });
  assert.deepEqual(replay.kept.map(b => b.id), first.kept.map(b => b.id));
});

test('order is preserved', () => {
  const { kept } = applyExclusions(BOOK, { categories: ['caption'] });
  assert.deepEqual(kept.map(b => b.id), ['b1', 'b2', 'f1', 'f2']);
});

// ── the documented plural, and nothing looser ───────────────────────────────

test('PIPELINE.md\'s plural spellings resolve', () => {
  // The worked example in the contract doc is `--exclude footnotes --exclude
  // captions`, while the taxonomy is singular. Both resolve; neither is a
  // fuzzy match.
  assert.equal(resolveCategory('footnotes'), 'footnote');
  assert.equal(resolveCategory('captions'), 'caption');
  assert.equal(resolveCategory('footnote'), 'footnote');
  assert.equal(resolveCategory('  Footnote  '), 'footnote');
});

test('a typo throws and prints the legal list — it never silently does nothing', () => {
  assert.throws(() => resolveCategory('captoins'), (e: unknown) => {
    assert.ok(e instanceof ExclusionError);
    assert.match(e.message, /"captoins" is not a category/);
    assert.match(e.message, /body, title, chapter/);
    return true;
  });
  assert.throws(() => applyExclusions(BOOK, { categories: ['bodies'] }), /not a category/);
});

test('an unknown block id throws, naming the ids and the likely cause', () => {
  assert.throws(() => applyExclusions(BOOK, { blockIds: ['b1', 'gone', 'also-gone'] }), (e: unknown) => {
    assert.ok(e instanceof ExclusionError);
    assert.match(e.message, /2 excluded block id\(s\) are not in blocks\/blocks\.json: gone, also-gone/);
    assert.match(e.message, /written against a different run/);
    return true;
  });
});

test('excluding everything is allowed here — the exporter is what refuses', () => {
  // This function's job is the filter, not the policy. An empty book is caught
  // in epub.ts, with a message about the whole export.
  const { kept } = applyExclusions(BOOK, { categories: ['body', 'caption', 'footnote'] });
  assert.deepEqual(kept, []);
});
