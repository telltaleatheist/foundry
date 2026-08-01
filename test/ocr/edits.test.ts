/**
 * The self-test that lived at the bottom of BookForgeApp `tools/galley/edits.mjs`,
 * moved here as tests (MIGRATION §2).
 *
 * Every case is a way this could ship damage to a listener, not a way it could
 * fail a unit test. The adversarial half matters more than the happy path: each
 * of those is the model emitting something wrong, and each one asserts THE TEXT
 * SURVIVES UNCHANGED rather than asserting an error was raised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARROW, LIMITS, applyEdits, deriveEdits, diffOpcodes, formatEdits, parseEdits,
} from '../../src/ocr/edits.js';

/** derive → format → parse → apply == truth. */
const CASES: Array<[string, string, string]> = [
  ['identity', 'The quick brown fox.', 'The quick brown fox.'],
  ['one word', 'The quick brovn fox.', 'The quick brown fox.'],
  ['two errors', 'Tbe quick brovn fox.', 'The quick brown fox.'],
  ['adjacent damage', 'tbe rnain street', 'the main street'],
  ['repeated word, unique anchor', 'the cat sat on the rnat', 'the cat sat on the mat'],
  ['insertion', 'the cat sat on mat', 'the cat sat on the mat'],
  ['deletion', 'the the cat sat', 'the cat sat'],
  ['diacritic', 'Uber den Berg', 'Über den Berg'],
  ['ligature', 'ﬁrst ﬂight', 'first flight'],
  ['hyphen wrap kept', 'inter-\nnational', 'inter-\nnational'],
  ['long block', 'a'.repeat(400) + ' bistory ' + 'b'.repeat(400), 'a'.repeat(400) + ' history ' + 'b'.repeat(400)],
];

for (const [name, ocr, truth] of CASES) {
  test(`round trip: ${name}`, () => {
    const d = deriveEdits(ocr, truth);
    assert.ok(d, 'derivation returned null');
    const round = parseEdits(formatEdits(d.edits));
    const applied = applyEdits(ocr, round.edits);
    assert.equal(applied.text, truth);
    assert.equal(applied.ok, true);
  });
}

const T = 'the cat sat on the mat';

test('the applier refuses an anchor that is absent, and leaves the text alone', () => {
  const r = applyEdits(T, [{ before: 'dog', after: 'cat' }]);
  assert.equal(r.ok, false);
  assert.equal(r.text, T);
  assert.equal(r.applied, 0);
  assert.equal(r.rejected[0].why, 'not present in the block');
});

test('the applier refuses an ambiguous anchor, and leaves the text alone', () => {
  const r = applyEdits(T, [{ before: 'the', after: 'a' }]);
  assert.equal(r.ok, false);
  assert.equal(r.text, T);
  assert.equal(r.applied, 0);
  assert.equal(r.rejected[0].why, 'occurs more than once');
});

test('overlapping edits: one applied, one rejected', () => {
  const r = applyEdits(T, [
    { before: 'cat sat', after: 'dog sat' },
    { before: 'sat on', after: 'sat in' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.applied, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].why, 'overlaps an earlier edit');
});

test('an edit set over the change budget is refused whole, text untouched', () => {
  const r = applyEdits(T, [{ before: 'cat', after: 'cat, which had been sleeping all afternoon,' }]);
  assert.equal(r.ok, false);
  assert.equal(r.text, T);
  assert.equal(r.applied, 0);
});

test('one good edit survives a bad sibling', () => {
  const r = applyEdits(T, [{ before: 'mat', after: 'hat' }, { before: 'nope', after: 'x' }]);
  assert.equal(r.text, 'the cat sat on the hat');
  assert.equal(r.ok, false);
});

test('an anchor over MAX_BEFORE is refused', () => {
  const long = 'x'.repeat(LIMITS.MAX_BEFORE + 1);
  const r = applyEdits(long + ' tail', [{ before: long, after: 'y' }]);
  assert.equal(r.ok, false);
  assert.equal(r.applied, 0);
  assert.equal(r.rejected[0].why, `anchor over ${LIMITS.MAX_BEFORE} chars`);
});

test('an empty anchor is refused', () => {
  const r = applyEdits(T, [{ before: '', after: 'x' }]);
  assert.equal(r.ok, false);
  assert.equal(r.text, T);
  assert.equal(r.rejected[0].why, 'empty anchor');
});

test('an unparseable line is counted, never guessed at', () => {
  const p = parseEdits('tbe → the\ngarbage line without an arrow\nrnain → main');
  assert.equal(p.edits.length, 2);
  assert.equal(p.bad, 1);
});

test('`none` is a no-op', () => {
  const r = applyEdits(T, parseEdits('none').edits);
  assert.equal(r.ok, true);
  assert.equal(r.text, T);
  assert.equal(r.applied, 0);
});

test('the ASCII arrow parses the same as the real one', () => {
  assert.deepEqual(parseEdits('tbe -> the'), parseEdits('tbe → the'));
  assert.ok(ARROW.test(' → '));
  assert.ok(ARROW.test('->'));
});

test('derivation refuses a wholesale rewrite', () => {
  assert.equal(deriveEdits('the cat sat on the mat', 'a dog stood beneath a tree'), null);
});

test('derivation refuses a pair the format cannot carry', () => {
  assert.equal(deriveEdits('x', 'the quick brown fox jumps over'), null);
});

/**
 * HYPHENATION IS A JOIN, NEVER A COMPLETION (ARCHITECTURE §7). Nothing in this
 * file may ever propose finishing a word whose second half is on the next line.
 * The wrap survives derivation, the wire format, and application untouched, and
 * an edit that tries to complete it is refused by the anchor rule.
 */
test('a line-wrapped hyphen is never completed', () => {
  const wrapped = 'inter-\nnational';
  const d = deriveEdits(wrapped, wrapped);
  assert.deepEqual(d, { edits: [], changed: 0 });
  assert.equal(formatEdits(d!.edits), 'none');

  // An anchor spanning the wrap cannot survive the one-edit-per-line format,
  // so derivation refuses to produce one.
  assert.equal(deriveEdits(wrapped, 'international'), null);

  // And if a model emitted one anyway, the applier drops it: the anchor as
  // parsed off a single line does not occur in the text.
  const invented = parseEdits('inter- → international');
  const r = applyEdits(wrapped, invented.edits);
  assert.equal(r.ok, false);
  assert.equal(r.text, wrapped);
});

test('diffOpcodes gives up past MAX_DIFF rather than guessing', () => {
  const a = 'a'.repeat(500);
  const b = 'b'.repeat(500);
  assert.equal(diffOpcodes(a, b, 10), null);
});

test('diffOpcodes runs cover the whole of both strings', () => {
  const ops = diffOpcodes('tbe rnain street', 'the main street');
  assert.ok(ops);
  assert.equal(ops[0].i1, 0);
  assert.equal(ops[0].j1, 0);
  assert.equal(ops[ops.length - 1].i2, 'tbe rnain street'.length);
  assert.equal(ops[ops.length - 1].j2, 'the main street'.length);
});
