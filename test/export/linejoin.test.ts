/**
 * Line joining, and the wrap-hyphen rule that makes it safe.
 *
 * The banned behaviour has a name in BookForge's comments — the naive
 * strip-and-weld — and these tests are mostly about proving it does not happen
 * even when every local cue points that way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { joinLines } from '../../src/export/linejoin.js';
import { attestationFromLines, createHyphenAttestation } from '../../src/paragraphs/hyphen.js';

const EMPTY = createHyphenAttestation();

test('lines join with a single space — the page break is not the author\'s', () => {
  const r = joinLines(['The quick brown', 'fox jumps over', 'the lazy dog.'], EMPTY);
  assert.equal(r.text, 'The quick brown fox jumps over the lazy dog.');
  assert.equal(r.healed, 0);
  assert.equal(r.keptHyphens, 0);
});

test('a wrap hyphen is healed when the book attests the joined word', () => {
  const att = attestationFromLines(['it was a question of time', 'another question entirely']);
  const r = joinLines(['it was a ques-', 'tion of money'], att);
  assert.equal(r.text, 'it was a question of money');
  assert.equal(r.healed, 1);
  assert.equal(r.keptHyphens, 0);
});

test('a wrap hyphen is KEPT when the book attests the compound', () => {
  const att = attestationFromLines(['the far-right press', 'a far-right movement']);
  const r = joinLines(['the far-', 'right press'], att);
  assert.equal(r.text, 'the far-right press');
  assert.equal(r.healed, 0);
  assert.equal(r.keptHyphens, 1);
});

test('an UNPROVEN pair keeps its hyphen — the recoverable direction', () => {
  const r = joinLines(['a zeb-', 'ruck appeared'], EMPTY);
  assert.equal(r.text, 'a zeb-ruck appeared');
  assert.equal(r.keptHyphens, 1);
});

test('the naive strip-and-weld does not happen: a lowercase continuation is not evidence', () => {
  // THE regression. "next char is lowercase ⇒ dehyphenate" was measured wrong
  // on all 37 provable pairs of a real book. Every case below continues with a
  // lowercase letter and every one must keep its hyphen.
  for (const [head, tail, joined] of [
    ['far', 'right', 'far-right'],
    ['self', 'defense', 'self-defense'],
    ['anti', 'communist', 'anti-communist'],
  ] as const) {
    const r = joinLines([`the ${head}-`, `${tail} case`], EMPTY);
    assert.equal(r.text, `the ${joined} case`, `${head}-${tail} was welded`);
  }
});

test('a healed word closes the gap, and a kept one does too — never a stray space', () => {
  const att = attestationFromLines(['the question stands']);
  assert.equal(joinLines(['ques-', 'tion'], att).text, 'question');
  assert.equal(joinLines(['far-', 'right'], EMPTY).text, 'far-right');
});

test('a hyphen that is not a wrap hyphen joins with a space', () => {
  // A dash after a space is punctuation, not a broken word.
  assert.equal(joinLines(['a sentence —', 'and its continuation'], EMPTY).text,
    'a sentence — and its continuation');
  // A digit does not continue a word.
  assert.equal(joinLines(['page 12-', '14 covers it'], EMPTY).text, 'page 12- 14 covers it');
});

test('leading and trailing whitespace on a line is a crop artefact, not text', () => {
  const r = joinLines(['  the quick  ', '\tbrown fox '], EMPTY);
  assert.equal(r.text, 'the quick brown fox');
});

test('a blank line inside a block does not produce a double space', () => {
  assert.equal(joinLines(['one', '   ', 'two'], EMPTY).text, 'one two');
});

test('no lines is an empty string, not a crash', () => {
  const r = joinLines([], EMPTY);
  assert.equal(r.text, '');
  assert.equal(r.healed, 0);
});

test('a single line is itself', () => {
  assert.equal(joinLines(['just the one'], EMPTY).text, 'just the one');
});

test('several hyphens in one paragraph are counted separately', () => {
  const att = attestationFromLines(['the question was', 'a far-right group']);
  const r = joinLines(['a ques-', 'tion about the far-', 'right and a zeb-', 'ruck'], att);
  assert.equal(r.text, 'a question about the far-right and a zeb-ruck');
  assert.equal(r.healed, 1);
  assert.equal(r.keptHyphens, 2);
});
