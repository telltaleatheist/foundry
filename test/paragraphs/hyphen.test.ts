/**
 * The wrap-hyphen contract. Every case here is one of two mistakes:
 *
 *   - welding a real compound shut (`far-right` → `farright`), which is what
 *     the "next character is lowercase" shortcut does and why it is banned;
 *   - letting a split fragment attest itself, which silently disables the proof.
 *
 * Both are one-way: the output cannot be un-welded, and a broken attestation
 * looks exactly like a book with no provable pairs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addTextToHyphenAttestation, attestationFromLines, createHyphenAttestation,
  healSoftHyphens, isWrapHyphenBreak, proveHyphenVerdict, SOFT_HYPHEN, stripSoftHyphens,
  wrapHyphenHalves,
} from '../../src/paragraphs/hyphen.js';

test('a wrap hyphen is a letter, a hyphen, end of line, then a letter', () => {
  assert.equal(isWrapHyphenBreak('the inter-', 'national scene'), true);
  assert.equal(isWrapHyphenBreak('the inter- ', 'national scene'), true, 'trailing space is allowed');
  assert.equal(isWrapHyphenBreak('the inter-', '  national'), true, 'leading space is allowed');
  assert.equal(isWrapHyphenBreak('the inter', 'national'), false, 'no hyphen, no pair');
  assert.equal(isWrapHyphenBreak('page 3 -', 'national'), false, 'a dash after a space is not a wrap hyphen');
  assert.equal(isWrapHyphenBreak('the inter-', '3 scenes'), false, 'a digit does not continue a word');
  assert.equal(isWrapHyphenBreak('the inter-', ''), false);
});

test('the halves come back as the model would need them', () => {
  assert.deepEqual(wrapHyphenHalves('a long inter-', 'national scene'), { head: 'inter', tail: 'national' });
  assert.equal(wrapHyphenHalves('no hyphen here', 'next'), null);
});

test('a pair joins only when the joined word is attested elsewhere', () => {
  const att = attestationFromLines([
    'It was never a question of money.',
    'The question was who would pay.',
  ]);
  assert.equal(proveHyphenVerdict('ques', 'tion', att), 'join');
});

test('a genuine compound keeps its hyphen when the compound is attested', () => {
  const att = attestationFromLines([
    'the far-right press said so',
    'a far-right movement',
  ]);
  assert.equal(proveHyphenVerdict('far', 'right', att), 'hyphen');
});

test('an unproven pair is null, and null means keep the hyphen', () => {
  const att = attestationFromLines(['nothing relevant appears here at all']);
  assert.equal(proveHyphenVerdict('self', 'defense', att), null);
});

test('evidence on BOTH sides is unproven, not a coin flip', () => {
  const att = attestationFromLines([
    'the well-known case',
    'a wellknown typo in the scan',
  ]);
  assert.equal(proveHyphenVerdict('well', 'known', att), null);
});

test('a compound never attests its own halves as standalone words', () => {
  // The boundary rule. Without it, `non-Aryan` would put `non` and `Aryan` into
  // the word set, and every compound would prove its own join.
  const att = attestationFromLines(['a non-Aryan citizen', 'another non-Aryan case']);
  assert.equal(att.words.has('non'), false);
  assert.equal(att.words.has('aryan'), false);
  assert.equal(att.hyphenated.has('non-aryan'), true);
  assert.equal(proveHyphenVerdict('non', 'Aryan', att), 'hyphen');
});

test('a three-part chain contributes no two-part slice', () => {
  const att = attestationFromLines(['the Judeo-Christian-Jewish tradition']);
  assert.equal(att.hyphenated.has('judeo-christian'), false);
  assert.equal(att.hyphenated.has('christian-jewish'), false);
});

test('a split fragment does not attest itself', () => {
  // THE trap. `ques-\ntion` would otherwise put `tion` into the word set; that
  // does not prove the join by itself, but the same masking is what stops
  // `inter-\nests` from attesting `ests` and, worse, stops the SECOND half of a
  // genuine compound break from looking like a free-standing word.
  const att = createHyphenAttestation();
  addTextToHyphenAttestation(att, 'a ques-\ntion of time');
  assert.equal(att.words.has('tion'), false);
  assert.equal(att.words.has('ques'), false);
  assert.equal(proveHyphenVerdict('ques', 'tion', att), null, 'one occurrence proves nothing');
});

test('the attestation is built from lines joined by newlines, not spaces', () => {
  // Joining with spaces would turn every wrap hyphen into a single-line
  // compound, so `ques-tion` would enter `hyphenated` and PROVE THE WRONG
  // VERDICT on the very pair being decided.
  const att = attestationFromLines(['a ques-', 'tion of time', 'the question was asked']);
  assert.equal(att.hyphenated.has('ques-tion'), false);
  assert.equal(att.words.has('question'), true);
  assert.equal(proveHyphenVerdict('ques', 'tion', att), 'join');
});

test('the verdict is case-insensitive', () => {
  const att = attestationFromLines(['Question everything.', 'the Question was asked']);
  assert.equal(proveHyphenVerdict('Ques', 'tion', att), 'join');
});

test('accented letters are words too', () => {
  const att = attestationFromLines(['über die Verhältnisse', 'Verhältnisse waren schlecht']);
  assert.equal(proveHyphenVerdict('Verhält', 'nisse', att), 'join');
});

// ── soft hyphens (U+00AD) ────────────────────────────────────────────────────
//
// A different character with a different rule, and the difference is the whole
// point: the ASCII hyphen above is ambiguous and is decided by the book, while
// a soft hyphen is a typesetter's discretionary break and is decided outright.
// Measured on Kershaw (2026-08-04): the archive PDF's text layer breaks
// `totali<U+00AD>` / `tarianism`, which the ASCII-only rule read as a line
// ending in no hyphen at all and joined with a space.

test('a line ending in a soft hyphen is a wrap break, whatever follows', () => {
  assert.equal(isWrapHyphenBreak('views on totali' + SOFT_HYPHEN, 'tarianism and Stalin'), true);
  assert.equal(isWrapHyphenBreak('views on totali' + SOFT_HYPHEN + ' ', 'tarianism'), true,
    'trailing space is a crop artefact here too');
  // The ASCII rule needs the next line to continue a word; the soft-hyphen rule
  // does not, because the mark itself says the word was cut.
  assert.equal(isWrapHyphenBreak('modernis' + SOFT_HYPHEN, '3 scenes'), true);
  assert.equal(isWrapHyphenBreak('no mark here', 'tarianism'), false);
});

test('a soft-hyphen break has no halves to weigh — attestation is not consulted', () => {
  assert.equal(wrapHyphenHalves('totali' + SOFT_HYPHEN, 'tarianism'), null);
  // …and the ASCII pair still comes back, unchanged.
  assert.deepEqual(wrapHyphenHalves('a long inter-', 'national scene'),
    { head: 'inter', tail: 'national' });
});

test('healing a soft hyphen closes the break and removes the strays', () => {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  assert.equal(healSoftHyphens(`totali${SOFT_HYPHEN}${LF}tarianism`), 'totalitarianism');
  assert.equal(healSoftHyphens(`totali${SOFT_HYPHEN}  ${LF}   tarianism`), 'totalitarianism',
    'the indent the next line was laid out with goes too');
  assert.equal(healSoftHyphens(`totali${SOFT_HYPHEN}${CR}${LF}tarianism`), 'totalitarianism');
  assert.equal(healSoftHyphens(`moderni${SOFT_HYPHEN}sing`), 'modernising',
    'a mark that did not break is invisible formatting');
  assert.equal(stripSoftHyphens(`a${SOFT_HYPHEN}b${SOFT_HYPHEN}`), 'ab');
});

test('the attestation learns the WHOLE word from a soft-hyphen split', () => {
  // The opposite of the ASCII treatment, and deliberately so. An ASCII split is
  // undecided, so neither half may be believed; a soft-hyphen split is already
  // decided, so the book genuinely contains 'totalitarianism'.
  const att = attestationFromLines(['views on totali' + SOFT_HYPHEN, 'tarianism and Stalin']);
  assert.equal(att.words.has('totalitarianism'), true);
  assert.equal(att.words.has('totali'), false);
  assert.equal(att.words.has('tarianism'), false);
});

test('a soft hyphen inside a line does not split the word it hides in', () => {
  const att = attestationFromLines(['the moderni' + SOFT_HYPHEN + 'sing state']);
  assert.equal(att.words.has('modernising'), true);
  assert.equal(att.words.has('moderni'), false);
  assert.equal(att.words.has('sing'), false);
});

