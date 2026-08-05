/**
 * The per-word guard, tested from its measured failure inventory: every reject
 * case below is a REAL model behavior seen during checkpoint scoring, not a
 * hypothetical. The guard's job is to let recognition fixes through and
 * discard structural rewrites whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OCR_GUARD_SHIPPED_POLICY,
  ocrGuardResolve,
  ocrWordGuard,
} from '../../src/ocr/guard.js';

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

// ── the two policies ────────────────────────────────────────────────────────
//
// Same RULE, different blast radius for one illegal run. Every case below is
// stated against BOTH policies, because the only thing that may differ between
// them is how much of an answer one violation costs — never which runs are
// legal.

test('the shipped policy is whole-unit, and that is what ocrWordGuard reports', () => {
  assert.equal(OCR_GUARD_SHIPPED_POLICY, 'whole-unit');
  assert.equal(ocrGuardResolve('a bistory of war', 'a history of war').policy, 'whole-unit');
});

for (const policy of ['whole-unit', 'per-run'] as const) {
  test(`${policy}: an all-legal answer is returned as the identical string`, () => {
    const r = ocrGuardResolve('Tbe rnain gaie', 'The main gate', { policy });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'The main gate');
    assert.equal(r.rejectedRuns, 0);
  });

  test(`${policy}: an identity answer is not a run at all`, () => {
    const r = ocrGuardResolve('the quick brown fox', 'the quick brown fox', { policy });
    assert.deepEqual(r.runs, []);
    assert.equal(r.text, 'the quick brown fox');
  });

  test(`${policy}: the deleted word "I" is REFUSED — the header's failure case`, () => {
    // The measured unguardable-by-ratio failure. Under either policy the word
    // has to come back: this is the case the guard exists for.
    const r = ocrGuardResolve('and I said it rudely', 'and said it rudely', { policy });
    assert.equal(r.ok, false);
    assert.equal(r.rejectedRuns, 1);
    assert.equal(r.text, 'and I said it rudely');
    assert.match(r.why ?? '', /unbalanced/);
  });

  test(`${policy}: an inserted word is refused`, () => {
    const r = ocrGuardResolve('the cat sat', 'the cat also sat', { policy });
    assert.equal(r.ok, false);
    assert.equal(r.text, 'the cat sat');
  });

  test(`${policy}: an answer whose ONLY change is illegal falls back to the source verbatim`, () => {
    // Not a re-spaced copy: the source string itself, so a full rejection is
    // byte-identical under the two policies.
    const src = 'she  spoke tudely  to him';
    const r = ocrGuardResolve(src, 'she spoke sharply to him', { policy });
    assert.equal(r.text, src);
  });
}

// ── where the policies part company ─────────────────────────────────────────

test('whole-unit: one illegal run discards the legal repairs beside it', () => {
  const src = 'Tbe rnain gaie and I said it rudely';
  const out = 'The main gate and said it rudely';   // two good fixes + a deleted "I"
  const r = ocrGuardResolve(src, out, { policy: 'whole-unit' });
  assert.equal(r.acceptedRuns, 1);
  assert.equal(r.rejectedRuns, 1);
  assert.equal(r.text, src, 'the whole answer is discarded, repairs and all');
});

test('per-run: the legal repairs survive and only the illegal run is reverted', () => {
  const src = 'Tbe rnain gaie and I said it rudely';
  const out = 'The main gate and said it rudely';
  const r = ocrGuardResolve(src, out, { policy: 'per-run' });
  assert.equal(r.ok, false, 'a reverted run is still a refusal, and still says why');
  assert.equal(r.acceptedRuns, 1);
  assert.equal(r.rejectedRuns, 1);
  assert.equal(r.text, 'The main gate and I said it rudely');
});

test('per-run: an inserted word is removed without touching the rest', () => {
  const r = ocrGuardResolve('tbe cat sat', 'the cat also sat', { policy: 'per-run' });
  assert.equal(r.text, 'the cat sat');
});

test('per-run reverts EVERY illegal run, not just the first', () => {
  const src = 'I walked and I ran and I stopped';
  const out = 'walked and I ran and stopped';       // two separate deletions
  const r = ocrGuardResolve(src, out, { policy: 'per-run' });
  assert.equal(r.rejectedRuns, 2);
  assert.equal(r.text, src);
});

test('per-run keeps the source spacing on a reverted run and the model spacing elsewhere', () => {
  // Reverting must not re-space the text it did not judge: the words it puts
  // back carry the whitespace they had in the source.
  const src = 'tbe cat   and I sat';
  const out = 'the cat   and sat';
  const r = ocrGuardResolve(src, out, { policy: 'per-run' });
  assert.equal(r.text, 'the cat   and I sat');
});

test('per-run never invents a word: every output word comes from the source or the answer', () => {
  const src = 'alpha beta gamma delta';
  const out = 'alpba beta zeta epsilon';
  const r = ocrGuardResolve(src, out, { policy: 'per-run' });
  const vocabulary = new Set([...src.split(' '), ...out.split(' ')]);
  for (const w of r.text.split(/\s+/)) {
    assert.ok(vocabulary.has(w), `"${w}" came from neither side`);
  }
});
