/**
 * The per-word guard, tested from its measured failure inventory: every reject
 * case below is a REAL model behavior seen during checkpoint scoring, not a
 * hypothetical. The guard's job is to let recognition fixes through and
 * discard structural rewrites whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ocrWordGuard } from '../../src/ocr/guard.js';

// ── accepts: recognition fixes ──────────────────────────────────────────────

const ACCEPTS: Array<[string, string, string]> = [
  ['identity', 'the quick brown fox', 'the quick brown fox'],
  ['single confusion d=1', 'the quick brovn fox', 'the quick brown fox'],
  ['classic b→h d=1', 'a bistory of the war', 'a history of the war'],
  ['Al → AI d=1', 'the rise of Al systems', 'the rise of AI systems'],
  ['two words fixed', 'Tbe quick brovn fox', 'The quick brown fox'],
  ['d=2 word', 'the rnain street', 'the main street'],
  ['diacritic repair', 'Uber den Berg', 'Über den Berg'],
  ['punctuation glued to word d=1', 'the end,', 'the end.'],
  ['every word touched, each small', 'Tbe rnain gaie', 'The main gate'],
];

for (const [name, src, out] of ACCEPTS) {
  test(`accepts: ${name}`, () => {
    assert.equal(ocrWordGuard(src, out).ok, true);
  });
}

// ── rejects: structural rewrites ────────────────────────────────────────────

const REJECTS: Array<[string, string, string]> = [
  // The measured unguardable-by-ratio failure: a short real word deleted.
  ['deleted word "I"', 'and I said it rudely', 'and said it rudely'],
  ['inserted word', 'the cat sat', 'the cat also sat'],
  ['word replaced wholesale', 'she spoke tudely to him', 'she spoke sharply to him'],
  // The 0.6B's country-swap class — lexical substitution far beyond d=2.
  ['lexical swap', 'troops entered Dänemark today', 'troops entered Deutschland today'],
  ['morphological swap d>2', 'die Mobilmachung begann', 'die Mobilisierung begann'],
  ['two words merged into one', 'in ter national law', 'international law law'],
  ['unbalanced tail', 'the end', 'the end and more'],
  ['everything different', 'alpha beta gamma', 'delta epsilon zeta eta'],
];

for (const [name, src, out] of REJECTS) {
  test(`rejects: ${name}`, () => {
    const v = ocrWordGuard(src, out);
    assert.equal(v.ok, false);
    assert.ok(v.why && v.why.length > 0, 'a rejection always says why');
  });
}

// ── edges ───────────────────────────────────────────────────────────────────

test('whitespace-only change is invisible to the guard', () => {
  // Word sequences are equal; the guard sees no change. The stage compares the
  // full strings separately — this is only about what the guard judges.
  assert.equal(ocrWordGuard('a  b', 'a b').ok, true);
});

test('empty output against non-empty source is an unbalanced change', () => {
  assert.equal(ocrWordGuard('some words here', '').ok, false);
});

test('threshold is inclusive: d=2 passes, d=3 fails', () => {
  assert.equal(ocrWordGuard('abcdef', 'abcdxy').ok, true);   // d=2
  assert.equal(ocrWordGuard('abcdef', 'abcxyz').ok, false);  // d=3
});

test('a balanced gap pairs words in order', () => {
  // "tbe rnain" → "the main": one gap of two deletes and two inserts, paired
  // (tbe,the) and (rnain,main) — both d<=2.
  assert.equal(ocrWordGuard('tbe rnain gate', 'the main gate').ok, true);
});
