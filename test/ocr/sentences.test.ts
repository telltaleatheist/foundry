/**
 * The correction unit.
 *
 * Three rules, and the tests exist to prove the ORDER they beat each other in:
 * a newline always ends a unit, packing stops at a sentence boundary, and
 * "never mid-word" overrules the cap rather than the other way round. The
 * failure each one prevents is the same failure — a fragment handed to a model
 * that will then try to complete it, which is how a scan becomes fiction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correctionUnits, CORRECTION_UNIT_MAX_CHARS } from '../../src/ocr/sentences.js';

/** Every unit must be an exact, whitespace-trimmed slice of what it came from. */
function assertFaithful(text: string, units: ReturnType<typeof correctionUnits>): void {
  let last = -1;
  for (const u of units) {
    assert.equal(u.text, text.slice(u.start, u.end), 'a unit is a slice of its source');
    assert.equal(u.text, u.text.trim(), 'a unit carries no leading or trailing whitespace');
    assert.ok(u.start > last, 'units are in order and do not overlap');
    last = u.start;
  }
}

test('short text is one unit', () => {
  const text = 'The quick brown fox.';
  const units = correctionUnits(text);
  assert.deepEqual(units.map(u => u.text), ['The quick brown fox.']);
  assertFaithful(text, units);
});

test('sentences pack together up to the cap, and the cut is always a boundary', () => {
  // Three sentences of 19, 21 and 16 characters. At 45 the first two fit in one
  // unit and the third does not; at 30 none of them can share. Either way every
  // cut falls between sentences — that is the whole rule.
  const text = 'One two three four. Five six seven eight. Nine ten eleven.';

  const packed = correctionUnits(text, 45);
  assert.deepEqual(packed.map(u => u.text), [
    'One two three four. Five six seven eight.',
    'Nine ten eleven.',
  ]);
  assertFaithful(text, packed);

  const tight = correctionUnits(text, 30);
  assert.deepEqual(tight.map(u => u.text), [
    'One two three four.',
    'Five six seven eight.',
    'Nine ten eleven.',
  ]);
  assertFaithful(text, tight);
});

test('two short sentences DO share a unit when they fit', () => {
  const text = 'He ran. She walked.';
  const units = correctionUnits(text, 40);
  assert.deepEqual(units.map(u => u.text), ['He ran. She walked.']);
});

test('a closing quote goes with the stop it closes', () => {
  // Cutting between `.` and `"` would open the next unit with a bare quotation
  // mark and close the previous one mid-punctuation.
  const text = '"It was over," he said. "Nothing else."  Then silence fell.';
  const units = correctionUnits(text, 30);
  for (const u of units) assert.ok(!u.text.startsWith('"') || u.text.length > 1);
  assert.equal(units.some(u => u.text.endsWith('."')), true);
  assertFaithful(text, units);
});

test('a newline always ends a unit — the model answers with ONE line', () => {
  // A newline in an EPUB's text is a <br/>, and extractOcrAnswer takes the
  // first line of the reply, so a prompt spanning one could never round-trip.
  const text = 'Chapter Three\nStruggle and Renunciation';
  const units = correctionUnits(text, CORRECTION_UNIT_MAX_CHARS);
  assert.deepEqual(units.map(u => u.text), ['Chapter Three', 'Struggle and Renunciation']);
  for (const u of units) assert.equal(u.text.includes('\n'), false);
});

test('blank lines and runs of whitespace produce no empty units', () => {
  const text = '  \n\nFirst.\n   \n  Second.  \n\n';
  const units = correctionUnits(text, 100);
  assert.deepEqual(units.map(u => u.text), ['First.', 'Second.']);
  assertFaithful(text, units);
});

test('an over-long sentence is cut at word boundaries, never mid-word', () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
  const text = `${words.join(' ')}.`;
  const units = correctionUnits(text, 100);
  assert.ok(units.length > 1, 'a 400+ character sentence does not survive a 100-character cap');
  for (const u of units) {
    assert.ok(u.text.length <= 100, `unit over the cap: ${u.text.length}`);
    // The join of every unit, whitespace-normalised, is the sentence back.
  }
  assert.equal(units.map(u => u.text).join(' '), text, 'no word was split and none was lost');
  assertFaithful(text, units);
});

test('a single word longer than the cap is its own unit — the cap loses', () => {
  // "Never mid-word" is the rule that wins. The unit exceeds the cap and says
  // so; the generation budget is derived from the input length, so it scales.
  const monster = 'x'.repeat(250);
  const text = `Short one. ${monster} and then more.`;
  const units = correctionUnits(text, 100);
  assert.equal(units.some(u => u.text === monster), true);
  for (const u of units) {
    if (u.text.length > 100) assert.equal(u.text, monster, 'only the long word exceeds the cap');
  }
  assertFaithful(text, units);
});

test('every character of every word survives the cut', () => {
  const text = 'Alpha beta gamma delta. Epsilon zeta eta theta iota kappa lambda mu nu xi.';
  for (const cap of [10, 20, 35, 400]) {
    const units = correctionUnits(text, cap);
    assert.equal(
      units.map(u => u.text).join(' ').replace(/\s+/g, ' '),
      text.replace(/\s+/g, ' '),
      `cap ${cap} lost or split something`,
    );
    assertFaithful(text, units);
  }
});

// ── the boundary guesses against cutting (2026-08-05) ───────────────────────
//
// A missed boundary is a longer unit and costs nothing; a wrong one is a
// fragment, which is the failure this file exists to prevent. So both guards
// below can only ever REFUSE a cut.

test('an abbreviation does not end a sentence — the unit grows instead', () => {
  const text = 'Then Mr. Smith left. He did not return.';
  const units = correctionUnits(text, 22);
  assert.deepEqual(units.map(u => u.text), ['Then Mr. Smith left.', 'He did not return.']);
  assertFaithful(text, units);
});

test('the list is English and German, and a lone letter is an initial in either case', () => {
  // Each of these is ONE unit: every stop in it is an abbreviation mark. `z. B.`
  // is why a lowercase single letter counts — German's commonest abbreviations
  // are lowercase, and a false initial only ever lengthens a unit.
  for (const text of [
    'See ibid. for the rest.',
    'Hrsg. von Ian Kershaw.',
    'Vgl. dazu Bd. 2 der Reihe.',
    'Written by J. P. Taylor.',
    'Das gilt z. B. für ihn.',
  ]) {
    assert.deepEqual(correctionUnits(text, 400).map(u => u.text), [text],
      `cut at an abbreviation: ${text}`);
  }
});

test('a footnote reference belongs to the sentence it marks, and the cut falls after it', () => {
  // Until this rule the stop was followed by a digit rather than whitespace, so
  // there was no boundary at all — and past the cap the word-boundary fallback
  // then cut wherever it landed.
  const text = 'They lost the war.12 The next morning was quiet.';
  const units = correctionUnits(text, 30);
  assert.deepEqual(units.map(u => u.text), ['They lost the war.12', 'The next morning was quiet.']);
  assertFaithful(text, units);
});

test('a reference rides behind the closing quote, and superscripts count', () => {
  const quoted = 'He said "stop."12 She left.';
  assert.deepEqual(correctionUnits(quoted, 22).map(u => u.text), ['He said "stop."12', 'She left.']);

  const superscript = 'They lost the war.¹² The next morning.';
  assert.deepEqual(correctionUnits(superscript, 25).map(u => u.text),
    ['They lost the war.¹²', 'The next morning.']);
  assertFaithful(superscript, correctionUnits(superscript, 25));
});

test('a decimal point is not a sentence end, and a year still is', () => {
  // The digit guard is on the SUFFIX form only: `3.14` is one number, while
  // `1945. The` consumed no reference and is an ordinary stop.
  const decimal = 'It cost 3.14 dollars and not one cent more.';
  assert.deepEqual(correctionUnits(decimal, 400).map(u => u.text), [decimal]);

  const year = 'It ended in 1945. The next year was worse.';
  assert.deepEqual(correctionUnits(year, 25).map(u => u.text),
    ['It ended in 1945.', 'The next year was worse.']);
});

test('the cap must be a positive number of characters', () => {
  assert.throws(() => correctionUnits('anything', 0), /positive number of characters/);
});

test('text with nothing in it produces no units at all', () => {
  assert.deepEqual(correctionUnits('   \n  \t '), []);
  assert.deepEqual(correctionUnits(''), []);
});
