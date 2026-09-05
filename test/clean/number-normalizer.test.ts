/**
 * number-normalizer — the numbers in a narration copy, read as the words a
 * narrator says, and every refusal that stands between a model and the book.
 *
 * A PORT of the PURE half of BookForge's `tools/test-tts-number-normalizer.js`:
 * one test per disposition, the citation guards, the scripture relaxation and
 * the refusals that bound it, `selectNumberTargets`, `isHeadingTarget`,
 * `buildNormalizerInput`, `normalizedCopyPaths`, and the sweep that runs every
 * `accept[]` reading in `fixtures/scripture-readings.json` through the
 * validator. The assertions are that file's, unchanged.
 *
 * ── WHAT WAS LEFT BEHIND, and why ───────────────────────────────────────────
 *
 * THE TWENTY-TWO TESTS BUILT ON `buildBook()`. They zip a synthetic EPUB —
 * container, OPF, nav, NCX, chapter — and drive `normalizeNarrationNumbers`
 * over it: the text-node rewrite, the write-back verification, the
 * SCRIPTURE_PROTECTED receipt lines, the `<em>` span refusal on a real
 * document, the heading and its two contents entries ending up saying one
 * string, the OPF title, the digitless book, the copy cache and its record, the
 * parse-failure gate and its one re-roll, the transport retry, the progress
 * ticks, the edit record, the rules-only unit, the offset map-back, and the
 * rule refusal. All of them need an EPUB document tree, `ZipWriter`,
 * `openEpubSource` and `readNarrationNumberTargets` — this engine has no EPUB
 * narration pass and no such door, so there is nothing here to point them at.
 * What the validator itself claims is all tested above, block by block.
 *
 * THE `--live` AND `--scripture` PROBES. Both dial a real Ollama model and
 * replace the suite wholesale rather than adding to it. A keeper that takes the
 * GPU is not a keeper.
 *
 * THE FIVE FIXTURE TESTS ARE HERE, and they SKIP by name when the file is not
 * on this machine. `fixture_texts.json` lives on E: with the training
 * campaigns; a checkout on another machine has no E:, and a keeper that fails
 * for being on the wrong computer teaches people to ignore it.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { NarrationNumberTarget } from '../../src/clean/targets.js';
import * as norm from '../../src/clean/tts-number-normalizer.js';
import { applyNumberRules } from '../../src/clean/tts-number-rules.js';

// ── The measured fixture: the real texts that derailed the 08-30 date probe ──
//
// Read when it is present; skipped by name when it is not, because it lives on
// E: with the training campaigns and a checkout on another machine has no E:.
const FIXTURE_PATH = path.join(
  'E:\\training', '_campaigns', '2026-09-01-cod-full-rebuild',
  'fixtures', 'number-normalization', 'fixture_texts.json');
const FIXTURES: Array<{ id: string; text: string }> | null = fs.existsSync(FIXTURE_PATH)
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Array<{ id: string; text: string }>
  : null;
const fixtureText = (id: string): string => {
  const hit = FIXTURES!.find((f) => f.id === id);
  assert.ok(hit, `fixture ${id} is not in fixture_texts.json`);
  return hit.text;
};
/** Named, so a skipped fixture test says which machine it wanted to be on. */
const NO_FIXTURES = FIXTURES === null;

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

test('a heading is recognized by its tag AND by the conversion stamp', () => {
  assert.ok(norm.isHeadingTarget({ tag: 'h3', statedCategory: null } as NarrationNumberTarget));
  assert.ok(norm.isHeadingTarget({ tag: 'p', statedCategory: 'chapter' } as NarrationNumberTarget));
  assert.ok(norm.isHeadingTarget(
    { tag: 'p', statedCategory: 'section-header' } as NarrationNumberTarget));
  assert.ok(!norm.isHeadingTarget({ tag: 'p', statedCategory: 'text' } as NarrationNumberTarget));
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation — one test per disposition
// ─────────────────────────────────────────────────────────────────────────────

/** Validate against a target held in ONE text node (the ordinary case). */
const check = (
  target: string, edits: Array<{ find: string; replace: string }>,
): ReturnType<typeof norm.validateNumberEdits> =>
  norm.validateNumberEdits(target, [target.length], edits);
const only = (target: string, find: string, replace: string): norm.NumberEditStatus =>
  check(target, [{ find, replace }]).records[0].status;

test('NOOP — an empty find, or a find identical to its replacement', () => {
  assert.strictEqual(only('He was 7 years old.', '', 'seven'), 'NOOP');
  assert.strictEqual(only('He was 7 years old.', '7', '7'), 'NOOP');
});

test('NOT_FOUND — the find is not verbatim in the target, and there is no ladder', () => {
  assert.strictEqual(only('On 23 March 1933 he spoke.', '23 March 1934', 'x'), 'NOT_FOUND');
  // Whitespace-tolerant matching is DELIBERATELY absent: a number has to be
  // located exactly or not at all.
  assert.strictEqual(only('On 23  March 1933 he spoke.', '23 March 1933', 'x'), 'NOT_FOUND');
});

test('AMBIGUOUS_FIND — the same span twice, so which one was meant is unknown', () => {
  assert.strictEqual(
    only('In 1933 and again in 1933.', '1933', 'nineteen thirty-three'), 'AMBIGUOUS_FIND');
});

test('NO_DIGIT_IN_FIND — prose tidying cannot ride in on a number edit', () => {
  assert.strictEqual(
    only('The Reichstag passed the Act in 1933.', 'Reichstag', 'parliament'), 'NO_DIGIT_IN_FIND');
});

test('DIGIT_IN_REPLACE — a conversion that did not happen', () => {
  assert.strictEqual(only('He was born in 1944.', '1944', '19 forty-four'), 'DIGIT_IN_REPLACE');
});

test('REPLACE_NOT_WORDS — a replacement that is not plain spoken words', () => {
  assert.strictEqual(only('It cost $5.', '$5', 'five dollars ($)'), 'REPLACE_NOT_WORDS');
  assert.strictEqual(only('It cost $5.', '$5', 'five/five dollars'), 'REPLACE_NOT_WORDS');
  // What IS allowed: letters, spaces, hyphens, commas, apostrophes, periods.
  assert.strictEqual(
    only("June 12, 1933 came.", 'June 12, 1933', "June twelfth, nineteen thirty-three"),
    'APPLIED');
});

test('WORDS_DROPPED — the model may convert numbers, never rename the prose', () => {
  assert.strictEqual(
    only('It fell 37.4 per cent that year.', '37.4 per cent',
      'thirty-seven point four percent'),
    'WORDS_DROPPED', 'the book prints "per cent" and the copy has to keep saying it');
  assert.strictEqual(
    only('On 12 February 1933 he wrote.', '12 February 1933',
      'March twelfth, nineteen thirty-three'),
    'WORDS_DROPPED', 'a month may not be renamed');
  assert.strictEqual(
    only('It was $1.5 million.', '$1.5 million', 'one point five million dollars'), 'APPLIED');
});

test('CITATION_CODE — a slash between digits, in the find or against its edge', () => {
  assert.strictEqual(
    only('Document II 9/34, p. 23.', '9/34', 'nine thirty-four'), 'CITATION_CODE');
  assert.strictEqual(
    only('Cited as 298/38 in the file.', '298', 'two hundred ninety-eight'), 'CITATION_CODE');
  assert.strictEqual(
    only('Cited as 298/38 in the file.', '38', 'thirty-eight'), 'CITATION_CODE');
});

test('CITATION_CODE — a volume abbreviation immediately before the number', () => {
  // "p." and "pp." were on this list until Owen's ruling of 2026-09-04: a page
  // reference is READ now ("p. 23" is "page twenty three"), by a rule of its
  // own, so the guard must NOT refuse the model an edit there either — the two
  // halves of the pass owe the same answer about a shape. What is left is the
  // apparatus with no spoken reading at all.
  for (const lead of ['vol.', 'no.', 'nos.', 'ibid.', 'cf.', 'fol.']) {
    assert.strictEqual(
      only(`See ${lead} 23 for the rest.`, '23', 'twenty-three'), 'CITATION_CODE', lead);
  }
  for (const lead of ['p.', 'pp.']) {
    assert.notStrictEqual(
      only(`See ${lead} 23 for the rest.`, '23', 'twenty-three'), 'CITATION_CODE', lead);
  }
});

test('CITATION_CODE — an area code beside a phone number', () => {
  // The record's own case: 9b proposed "(405)" → "(four zero five)", and until
  // 2026-09-02 only the punctuation guard stopped it. Now that a replacement may
  // carry the parentheses its find had, the phone shape is what refuses it.
  assert.strictEqual(
    only('Reach them at (405) 235-5396 today.', '(405)', '(four zero five)'), 'CITATION_CODE');
  assert.strictEqual(
    only('Reach them at (405) 235-5396 today.', '235-5396', 'two three five five three nine six'),
    'CITATION_CODE');
});

test('CITATION_CODE — a roman-numeral token beside it, but never a bare "I"', () => {
  assert.strictEqual(only('Document II 9 was filed.', '9', 'nine'), 'CITATION_CODE');
  assert.strictEqual(only('Volume XIV 9 was filed.', '9', 'nine'), 'CITATION_CODE');
  // "I" is a pronoun and single letters are initials — refusing on those would
  // refuse ordinary prose, which is the false negative that costs more.
  assert.strictEqual(only('I 9 times asked.', '9', 'nine'), 'APPLIED');
});

/**
 * THE ORACLE CROSS-CHECK IS GONE, and this is what replaced it.
 *
 * Until 2026-09-02 a `ORACLE_DISAGREE` disposition let number-expansion.ts
 * overrule the model on five shapes it read unambiguously: currency, percent,
 * ordinals, decades and comma-grouped thousands. All five are now RULES — the
 * model is never shown them at all, so there is nothing left for the cross-check
 * to disagree with, and a dead branch would only be a rule set nobody runs. What
 * the check was defending is defended better here: the reading is not compared
 * to the model's, it IS the reading.
 */
test('the five shapes the oracle used to guard are read by RULES now', () => {
  const reads = (text: string): string => applyNumberRules(text, [text.length]).text;
  assert.strictEqual(reads('It cost $5.50.'), 'It cost five dollars and fifty cents.');
  assert.strictEqual(reads('It was 50% done.'), 'It was fifty percent done.');
  assert.strictEqual(reads('The 7th of them.'), 'The seventh of them.');
  assert.strictEqual(reads('In the 1930s it grew.'), 'In the nineteen thirties it grew.');
  assert.strictEqual(reads('Some 3,450 came.'), 'Some three thousand four hundred fifty came.');
  // And the shape the oracle got WRONG — its rule let the scale word win over
  // the decimal and dropped the .5 — is read correctly by the money rule.
  assert.strictEqual(reads('It was $1.5 million.'), 'It was one point five million dollars.');
});

test('the shapes the rules DECLINE are exactly what still reaches the model', () => {
  // A bare four-digit quantity is the ambiguity the model exists for.
  assert.strictEqual(only('By spring 1200 workers were on the line.',
    '1200 workers', 'twelve hundred workers'), 'APPLIED');
  assert.strictEqual(only('It ran 1914-1918 without a break.',
    '1914-1918', 'nineteen fourteen to nineteen eighteen'), 'APPLIED');
});

test('AMBIGUOUS_FIND is DIGIT-BOUNDED — "1." is not found inside "11."', () => {
  // The measured failure: fifty list markers thrown away on 2026-09-02 because
  // `indexOf` matched the "1." inside "11." and called the edit ambiguous.
  assert.strictEqual(only('11. Amulet', '1.', 'one.'), 'NOT_FOUND',
    'the only occurrence sits inside another number, so there is none');
  assert.strictEqual(only('1. Amulet and 11. Charm', '1.', 'one.'), 'APPLIED',
    'the real marker is found, and the one inside "11." is not a second one');
  assert.strictEqual(only('1. Amulet and 1. Charm', '1.', 'one.'), 'AMBIGUOUS_FIND',
    'two real occurrences are still ambiguous');
  // And the same boundary the other way: the "19" inside "1944" is not a second
  // occurrence, so the real one is found instead of being called ambiguous.
  const { accepted } = check('In 1944 he was 19.', [{ find: '19', replace: 'nineteen' }]);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].at, 'In 1944 he was '.length, 'the standalone 19, not 1944\'s');
});

test('REPLACE_NOT_WORDS allows the punctuation the FIND itself carried', () => {
  // Five applied edits were refused on 2026-09-02 for carrying the em dash and
  // the parentheses the book printed.
  assert.strictEqual(
    only('1. Halloween\u2014October 31 is the first.', '1. Halloween\u2014October 31',
      'one. Halloween\u2014October thirty-first'), 'APPLIED');
  assert.strictEqual(
    only('The number was (405) that year.', '(405)', '(four zero five)'), 'APPLIED');
  assert.strictEqual(
    only('Chapter 3: The Long Year', 'Chapter 3', 'Chapter Three'), 'APPLIED');
  // What is still refused is a digit, a currency sign, a slash, markup.
  assert.strictEqual(only('It cost $5.', '$5', 'five dollars ($)'), 'REPLACE_NOT_WORDS');
  assert.strictEqual(only('It cost $5.', '$5', 'five/five dollars'), 'REPLACE_NOT_WORDS');
  assert.strictEqual(only('It cost 5 marks.', '5 marks', '<em>five</em> marks'),
    'REPLACE_NOT_WORDS');
});

test('PUNCTUATION_SPOKEN — the model may not narrate the name of a mark', () => {
  // Forty applied edits on 2026-09-02 said "hyphen" or "colon" out loud.
  assert.strictEqual(
    only('Deuteronomy 7:25\u201326 says so.', '7:25\u201326', 'seven twenty-five hyphen twenty-six'),
    'PUNCTUATION_SPOKEN');
  assert.strictEqual(
    only('Exodus 22:18 says so.', '22:18', 'twenty-two colon eighteen'), 'PUNCTUATION_SPOKEN');
  assert.strictEqual(
    only('Cited as 9-34 there.', '9-34', 'nine dash thirty-four'), 'PUNCTUATION_SPOKEN');
  // Counted, not merely detected: a book that discusses a hyphen keeps saying so.
  assert.strictEqual(
    only('The 3 hyphen rule applied.', '3 hyphen', 'three hyphen'), 'APPLIED');
});

test('NUMBER_DROPPED — every run of digits must come out as a number word', () => {
  // The n2 acceptance run (2026-09-02): "20:6" came back as "twenty", the verse
  // silently gone, and no other check could see it.
  assert.strictEqual(only('See 20:6 there.', '20:6', 'twenty'), 'NUMBER_DROPPED');
  assert.strictEqual(only('See 20:6 there.', '20:6', 'twenty six'), 'APPLIED');
  assert.strictEqual(only('In 1985 it began.', '1985', 'nineteen eighty-five'), 'APPLIED');
  assert.strictEqual(only('Verses 28:7-8 say so.', '28:7-8', 'twenty-eight seven through eight'), 'APPLIED');
  assert.strictEqual(only('Box 001 here.', '001', 'zero zero one'), 'APPLIED');
  // A year range read by half has the right NUMBER of words for the wrong reason:
  // a run of three or more digits is never one English word.
  assert.strictEqual(only('From 1914-1918 it ran.', '1914-1918', 'nineteen fourteen'), 'NUMBER_DROPPED');
  assert.strictEqual(only('From 1914-1918 it ran.', '1914-1918', 'nineteen fourteen to nineteen eighteen'), 'APPLIED');
  assert.strictEqual(only('It left at 10:05.', '10:05', 'ten oh five'), 'APPLIED');
  assert.strictEqual(only('Pi is 3.14 here.', '3.14', 'three point one four'), 'APPLIED');
  assert.strictEqual(only('In 1900 it began.', '1900', 'nineteen hundred'), 'APPLIED');
});

// ───────────────────────────────────────────────────────────────────────────
// Scripture — the one relaxed invariant, and the refusal that bounds it
// ───────────────────────────────────────────────────────────────────────────

/**
 * THE ARRANGEMENT UNDER TEST, from Owen's ruling of 2026-09-05.
 *
 * A scripture reference is DETECTED by the deterministic pass and protected
 * from every rule, and the MODEL reads it. That is only possible if the
 * validator will accept the one thing every other number edit is refused for:
 * a word of the find being REPLACED — "Pet." coming back as "Peter". The
 * relaxation is scoped to a detected span and is bounded on both sides:
 *
 *   BELOW — `scriptureWordsSurvive`: at most one prose word may go, and a name
 *   must arrive where it went.
 *
 *   ABOVE — `scriptureReadingRefusal`: the reading must BE a reading. No
 *   abbreviation left standing, a pause between chapter and verse, and never
 *   the word "chapter".
 *
 * The measured residue that made the second one a test: the deathstalker corpus
 * served "(Ps. sixty three six)" — digits spelled, abbreviation intact, the
 * boundary between chapter and verse simply gone.
 */
test('scripture: an abbreviation may become a NAME, which no other edit may do', () => {
  // Owen's own defect, read correctly. Fifty-seven of these were thrown away as
  // WORDS_DROPPED on the 2026-09-02 run, which is why the reading was done by
  // rule until n6.
  assert.strictEqual(
    only('We are to dwell with knowledge (1 Pet. 3:7).', '1 Pet. 3:7',
      'First Peter three, verse seven'), 'APPLIED');
  assert.strictEqual(
    only('See 2 Cor. 5:17 for that.', '2 Cor. 5:17',
      'Second Corinthians five, verse seventeen'), 'APPLIED');
  // A book already printed in full needs no relaxation and never did.
  assert.strictEqual(
    only('As John 3:16 says.', 'John 3:16', 'John three, verse sixteen'), 'APPLIED');
});

test('scripture: the relaxation is bounded — the book may not simply VANISH', () => {
  // One word may change. Nothing says a word may be deleted, so a reading that
  // drops the book and keeps the numbers is still WORDS_DROPPED.
  assert.strictEqual(
    only('We are to dwell with knowledge (1 Pet. 3:7).', '1 Pet. 3:7', 'First three, verse seven'),
    'WORDS_DROPPED');
  // And two prose words may not go at once.
  assert.strictEqual(
    only('See Song of Songs 2:1 there.', 'Song of Songs 2:1', 'Solomon two, verse one'),
    'WORDS_DROPPED');
});

test('scripture: the relaxation is SCOPED — an ordinary number edit is unchanged', () => {
  // The same shape of edit outside a detected span is refused exactly as before:
  // "workers" is prose and a reading may not swap it for "men".
  assert.strictEqual(
    only('By spring 1200 workers arrived.', '1200 workers', 'twelve hundred men'),
    'WORDS_DROPPED');
});

test('SCRIPTURE_UNREAD — the abbreviation survived the reading', () => {
  // The measured residue, verbatim: "(Ps. sixty three six)".
  const target = 'He quoted (Ps. 63:6) at length.';
  assert.strictEqual(only(target, 'Ps. 63:6', 'Ps. sixty three six'), 'SCRIPTURE_UNREAD');
  assert.strictEqual(only(target, 'Ps. 63:6', 'Ps. sixty three, verse six'), 'SCRIPTURE_UNREAD');
  // A period on the LAST token is the sentence's, not the abbreviation's.
  assert.strictEqual(only('He quoted Ps. 63:6.', 'Ps. 63:6', 'Psalm sixty three, verse six'),
    'APPLIED');
});

test('SCRIPTURE_UNREAD — the chapter and the verse ran together', () => {
  // The other half of the same residue: no pause at all between the numbers, so
  // the narrator says "sixty three six" as one number.
  const target = 'He quoted (Ps. 63:6) at length.';
  assert.strictEqual(only(target, 'Ps. 63:6', 'Psalm sixty three six'), 'SCRIPTURE_UNREAD');
  // Every reference in a LIST needs its own pause, not one between them all.
  assert.strictEqual(
    only('Both Lev. 19:31; 20:6 forbid it.', 'Lev. 19:31; 20:6',
      'Leviticus nineteen, thirty one; twenty six'), 'SCRIPTURE_UNREAD');
});

test('SCRIPTURE_UNREAD — the word "chapter" is never spoken', () => {
  // Measured: 0 of the 23 scripture references in the deathstalker corpus say
  // it (E:\training\deathstalker\build\ds_ad4s\scripture_spoken_forms_report.txt,
  // 2026-09-05). Owen ruled it out by name.
  assert.strictEqual(
    only('He quoted Ps. 63:6 at length.', 'Ps. 63:6', 'Psalm chapter sixty three, verse six'),
    'SCRIPTURE_UNREAD');
});

test('scripture: BOTH measured shapes are accepted, and neither is forced', () => {
  // 22 of the 23 measured references say "verse"; one is bare. The prompt ASKS
  // for the comma and the word — that preference is pinned in
  // test/clean/prompt-examples.test.ts, where it belongs, because a validator
  // that accepted only one form would refuse a narrator the corpus records.
  const target = 'He turned to 1 John 1:9 there.';
  assert.strictEqual(only(target, '1 John 1:9', 'First John one, verse nine'), 'APPLIED');
  assert.strictEqual(only(target, '1 John 1:9', 'First John one verse nine'), 'APPLIED');
  assert.strictEqual(only(target, '1 John 1:9', 'First John one, nine'), 'APPLIED');
  // What is refused is NEITHER — the fusion that has no pause in it at all.
  assert.strictEqual(only(target, '1 John 1:9', 'First John one nine'), 'SCRIPTURE_UNREAD');
});

test('scripture: a detected span that is NOT scripture is read as what it is', () => {
  // THE FINDING THIS ANSWERS (adversarial review, 2026-09-05): the design said a
  // false-positive detection was harmless because the span "is merely sent to the
  // model". It was not — the chapter-and-verse pause was demanded of EVERY
  // reading of a detected span, so the model's correct reading of a thing that is
  // not scripture was refused and the digits reached the narrator.
  //
  // Detection is much narrower now, but an abbreviation carrying its own period
  // is evidence enough on its own, and plenty of those are not books. Their
  // readings must pass: the pause is asked only of a reading that is CLAIMING to
  // be a reference — one that names a canonical book or an ordinal volume.
  assert.strictEqual(
    only('Sec. 3:7 of the statute.', 'Sec. 3:7', 'Section three seven'), 'APPLIED');
  assert.strictEqual(
    only('Ch. 3:7 of the manual.', 'Ch. 3:7', 'Chapter three seven'), 'APPLIED');
  assert.strictEqual(
    only('Mr. 3:7 is nonsense.', 'Mr. 3:7', 'Mister three seven'), 'APPLIED');
  // And the claim test is not a hole: a reading that DOES name a book still owes
  // the pause, and still may not say "chapter".
  assert.strictEqual(
    only('He quoted Ps. 63:6 there.', 'Ps. 63:6', 'Psalm sixty three six'), 'SCRIPTURE_UNREAD');
  assert.strictEqual(
    only('He quoted Ps. 63:6 there.', 'Ps. 63:6', 'Psalm chapter sixty three, verse six'),
    'SCRIPTURE_UNREAD');
});

test('scripture: a DOTLESS abbreviation is read, and its lookalike is left prose', () => {
  // Evidence (d): two or three letters and no period at all. It is weak on
  // purpose — "Ps 23:1" and "Map 2:1" are one shape — and the claim test is what
  // makes the same detection serve both. The model decides which it is looking
  // at, which is the arrangement Owen ruled for.
  assert.strictEqual(
    only('Ps 23:1 without a period.', 'Ps 23:1', 'Psalm twenty three, verse one'), 'APPLIED');
  assert.strictEqual(
    only('Jn 3:16 is the famous one.', 'Jn 3:16', 'John three, verse sixteen'), 'APPLIED');
  assert.strictEqual(
    only('Rev 21:4 says so.', 'Rev 21:4', 'Revelation twenty one, verse four'), 'APPLIED');
  assert.strictEqual(
    only('Mt 5:3 is the sermon.', 'Mt 5:3', 'Matthew five, verse three'), 'APPLIED');
  // The lookalikes, read as the prose they are — and these are MAIN's own words
  // for them, which the rules used to produce and the model now has to.
  assert.strictEqual(only('Map 2:1 scale.', 'Map 2:1', 'Map two one'), 'APPLIED');
  assert.strictEqual(
    only('Bus 47:15 leaves hourly.', 'Bus 47:15', 'Bus forty seven fifteen'), 'APPLIED');
  assert.strictEqual(only('Bach BWV 3:7 hmm.', 'BWV 3:7', 'BWV three seven'), 'APPLIED');
  // And a reading that DOES name a book still owes the pause, dotless or not.
  assert.strictEqual(
    only('Ps 23:1 without a period.', 'Ps 23:1', 'Psalm twenty three one'), 'SCRIPTURE_UNREAD');
});

test('scripture: the word that arrives must be one the abbreviation was short FOR', () => {
  // The one-token allowance is for the book NAME. An earlier cut accepted any new
  // word that was not a number or a structural word, so "First three, verse
  // seven" passed with the book gone and "verse" standing in for it.
  assert.strictEqual(
    only('We are to dwell (1 Pet. 3:7).', '1 Pet. 3:7', 'First chapter, verse seven'),
    'WORDS_DROPPED');
  assert.strictEqual(
    only('We are to dwell (1 Pet. 3:7).', '1 Pet. 3:7', 'First three, verse seven'),
    'WORDS_DROPPED');
  // Every contraction a publisher actually prints still reads: the token's
  // letters have only to appear in order in a longer word.
  assert.strictEqual(
    only('Read Jas. 1:17 there.', 'Jas. 1:17', 'James one, verse seventeen'), 'APPLIED');
  assert.strictEqual(
    only('Read Phlm. 1:6 there.', 'Phlm. 1:6', 'Philemon one, verse six'), 'APPLIED');
  assert.strictEqual(
    only('Read Mk. 16:15 there.', 'Mk. 16:15', 'Mark sixteen, verse fifteen'), 'APPLIED');
  assert.strictEqual(
    only('Read Pss. 42:11 there.', 'Pss. 42:11', 'Psalms forty two, verse eleven'), 'APPLIED');
  // …or be a canonical book name outright, for the abbreviation whose reading is
  // the book's OTHER name rather than its spelling-out.
  assert.strictEqual(
    only('Read Cant. 8:6 there.', 'Cant. 8:6', 'Song of Songs eight, verse six'), 'APPLIED');
});

test('scripture: a ROMAN volume numeral is readable, which it was not', () => {
  // MEASURED (adversarial review, 2026-09-05): "II Cor. 5:17" detected as
  // "Cor. 5:17" with the numeral stranded outside the span, and BOTH readings the
  // model could offer were refused — the whole reference WORDS_DROPPED (two prose
  // words gone, "ii" and "cor"), and the bare "Cor. 5:17" CITATION_CODE (the
  // roman-lead citation guard). The reference was narrated as digits.
  assert.strictEqual(
    only('See II Cor. 5:17 there.', 'II Cor. 5:17', 'Second Corinthians five, verse seventeen'),
    'APPLIED');
  assert.strictEqual(
    only('See III John 1:4 there.', 'III John 1:4', 'Third John one, verse four'), 'APPLIED');
  assert.strictEqual(
    only('See 1st John 1:9 there.', '1st John 1:9', 'First John one, verse nine'), 'APPLIED');
  // The citation guard is exempted INSIDE a detected span and nowhere else: a
  // roman numeral in front of an ordinary number is still apparatus.
  assert.strictEqual(
    only('Wurm, Document II 9 34 there.', '9 34', 'nine thirty four'), 'CITATION_CODE');
});

interface ScriptureCase { id: string; in: string; find: string; accept: string[] }

test('scripture: every reading in the evidence set passes the validator', () => {
  // The file the model is judged against must itself be judgeable: a reading the
  // validator would refuse is not a target anyone can hit.
  const evidence = JSON.parse(fs.readFileSync(
    path.join(import.meta.dir, 'fixtures', 'scripture-readings.json'),
    'utf8')) as { cases: ScriptureCase[] };
  for (const c of evidence.cases) {
    for (const reading of c.accept) {
      assert.strictEqual(norm.scriptureReadingRefusal(c.find, reading), null,
        `${c.id}: ${JSON.stringify(reading)}`);
      assert.strictEqual(only(c.in, c.find, reading), 'APPLIED', `${c.id}: ${reading}`);
    }
  }
});

test('NUMBER_DROPPED — a comma is a separator INSIDE one number (Ask 2c)', () => {
  // orpheus-finetune's NORMALIZATION_SPEC.md §F4, measured on tr_dn3. Counting
  // bare runs of digits made "5,000" TWO numbers, so the floor demanded three
  // number words and refused a correct reading that has two. `digitRuns` reads
  // `\d{1,3}(?:,\d{3})+` as one run, comma stripped, so the LENGTH test that
  // sets the floor counts digits and not characters.
  //
  // These live here as well as in the text-normalization suite on purpose: this
  // is the validator's own suite, and a regression in `digitRuns` must fail the
  // suite that owns the disposition, not only the shared-fixture one.
  assert.strictEqual(only('5,000 copies went out.', '5,000 copies', 'five thousand copies'),
    'APPLIED');
  assert.strictEqual(
    only('It cost 1,250,000 marks.', '1,250,000 marks',
      'one million two hundred fifty thousand marks'), 'APPLIED');
  // The two shapes the training side measured still printing their digits. Both
  // are numbers the GROUPED rule declined (each is glued to more text), which is
  // why the validator is the only thing standing between them and a reading.
  assert.strictEqual(only('An 18,000-strong crowd came.', '18,000-strong',
    'eighteen thousand-strong'), 'APPLIED');
  // The compound's own hyphen may be kept or spoken away: the prompt lets a
  // replacement carry a hyphen, and the validator has no opinion on which of the
  // two readings the model picks. Both must pass, or the model gets punished for
  // a choice nothing asked it to make.
  assert.strictEqual(only('An 18,000-strong crowd came.', '18,000-strong',
    'eighteen thousand strong'), 'APPLIED');
  assert.strictEqual(only('Some 20-30,000 of them died.', '20-30,000',
    'twenty to thirty thousand'), 'APPLIED');

  // ── And the floor it was protecting still fires, on both sides of the comma ──
  // A comma-grouped number is ONE number, not NO number: three or more digits is
  // still never one English word.
  assert.strictEqual(only('Just 5,000 there.', '5,000', 'five'), 'NUMBER_DROPPED');
  assert.strictEqual(only('Just 5,000 there.', '5,000', 'five thousand'), 'APPLIED');
  // Two numbers, one read: the grouped one converted and the bare one silently
  // gone, with every prose word of the find still in place and in order.
  assert.strictEqual(
    only('5,000 copies in 12 crates went out.', '5,000 copies in 12 crates',
      'five thousand copies in crates'), 'NUMBER_DROPPED');
  assert.strictEqual(
    only('5,000 copies in 12 crates went out.', '5,000 copies in 12 crates',
      'five thousand copies in twelve crates'), 'APPLIED');
  // Half of a range whose second number is comma-grouped.
  assert.strictEqual(only('Some 20-30,000 of them died.', '20-30,000', 'twenty thousand'),
    'NUMBER_DROPPED');
  // Dropping the second number by dropping its WORDS too is refused one check
  // earlier, by name: `keepsEveryWord` runs ahead of the number floor, so "and"
  // and "men" going missing is WORDS_DROPPED. Refused either way — the invariant
  // is that it does not APPLY — but the record has to name the right reason.
  assert.strictEqual(
    only('5,000 copies and 12 men arrived.', '5,000 copies and 12 men',
      'five thousand copies'), 'WORDS_DROPPED');
});

test('LIST_MARKER_PERIOD — a list marker keeps its period', () => {
  assert.strictEqual(only('1. Amulet', '1.', 'one'), 'LIST_MARKER_PERIOD');
  assert.strictEqual(only('1. Amulet', '1.', 'one.'), 'APPLIED');
});

test('SPANS_MARKUP — an edit that would have to cross an <em>', () => {
  // "He was born in 19" + "44" + " and never said so." — three text nodes.
  const target = 'He was born in 1944 and never said so.';
  const segments = ['He was born in '.length, '19'.length, '44 and never said so.'.length];
  const { records, accepted } = norm.validateNumberEdits(target, segments,
    [{ find: '1944', replace: 'nineteen forty-four' }]);
  assert.strictEqual(records[0].status, 'SPANS_MARKUP');
  assert.strictEqual(accepted.length, 0, 'nothing is applied, and the digits stand');
});

test('OVERLAPS_APPLIED — the model returning a span and a span inside it', () => {
  const target = 'On June 12, 1933 he spoke.';
  const { records } = check(target, [
    { find: 'June 12, 1933', replace: 'June twelfth, nineteen thirty-three' },
    { find: '1933', replace: 'nineteen thirty-three' },
  ]);
  assert.deepStrictEqual(records.map((r) => r.status), ['APPLIED', 'OVERLAPS_APPLIED']);
});

test('a rejected edit leaves the ORIGINAL digits, and every one is recorded', () => {
  const target = 'It fell 37.4 per cent in 1933.';
  const { accepted, records } = check(target, [
    { find: '37.4 per cent', replace: 'thirty-seven point four percent' },
    { find: '1933', replace: 'nineteen thirty-three' },
  ]);
  assert.deepStrictEqual(records.map((r) => r.status), ['WORDS_DROPPED', 'APPLIED']);
  assert.strictEqual(accepted.length, 1, 'only the good one');
  assert.strictEqual(accepted[0].at, target.indexOf('1933'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The measured derailment fixture
// ─────────────────────────────────────────────────────────────────────────────

test.skipIf(NO_FIXTURES)(
  'fixture date10 (endnote apparatus) yields NO applied edits '
  + '(fixture_texts.json is not on this machine)', () => {
  const target = fixtureText('date10');
  // Every digit in it is archive apparatus. The prompt teaches the model to
  // leave them; this proves the VALIDATOR stops them if it does not.
  const { accepted, records } = check(target, [
    { find: '298/38', replace: 'two ninety-eight thirty-eight' },
    { find: '3659/42', replace: 'thirty-six fifty-nine forty-two' },
  ]);
  assert.strictEqual(accepted.length, 0);
  assert.deepStrictEqual(records.map((r) => r.status), ['CITATION_CODE', 'CITATION_CODE']);
});

test.skipIf(NO_FIXTURES)(
  'fixture run209 (a citation string) yields NO applied edits '
  + '(fixture_texts.json is not on this machine)', () => {
  const target = fixtureText('run209');
  const { accepted, records } = check(target, [{ find: '9/34', replace: 'nine thirty-four' }]);
  assert.strictEqual(accepted.length, 0);
  assert.strictEqual(records[0].status, 'CITATION_CODE');
});

test.skipIf(NO_FIXTURES)(
  'fixture date04 — the two real numbers in it read correctly '
  + '(fixture_texts.json is not on this machine)', () => {
  const target = fixtureText('date04');
  const { records } = check(target, [
    { find: '3,450', replace: 'three thousand four hundred fifty' },
    { find: '3,450', replace: 'thirty-four fifty' },
  ]);
  // The first is the narrator's own measured reading (README, 2026-09-01); the
  // second is a plausible-sounding drift, refused for reaching into the span the
  // first one already took. (In the live pass neither reaches the model at all —
  // the grouped-integer rule reads "3,450" before it is ever asked.)
  assert.deepStrictEqual(records.map((r) => r.status), ['APPLIED', 'OVERLAPS_APPLIED']);
});

test.skipIf(NO_FIXTURES)(
  'fixture date11 — an archive file number is not converted '
  + '(fixture_texts.json is not on this machine)', () => {
  const target = fixtureText('date11');
  // "AfW HH, 260488, Bl. twenty nine" — six digits that are a file reference.
  //
  // Until n5 this was the PROMPT's job alone: no citation rule caught a bare
  // integer after an archive sigil, the validator let the edit through, and the
  // test recorded that boundary honestly. `isArchiveSigil` closed it (the
  // orpheus-finetune side's "Ask 2") — "HH" is a two-character all-caps token
  // standing immediately in front of the number, so the guard now answers
  // CITATION_CODE and the file reference is left exactly as the archive prints
  // it, whatever the model proposes.
  assert.strictEqual(only(target, '260488', 'two hundred sixty thousand four hundred eighty-eight'),
    'CITATION_CODE');
});

test.skipIf(NO_FIXTURES)(
  'fixtures with no digits are never selected at all '
  + '(fixture_texts.json is not on this machine)', () => {
  for (const id of ['date00', 'date03', 'date07', 'date09', 'run893']) {
    const text = fixtureText(id);
    assert.ok(!/[0-9]/.test(text), `${id} carries no digit`);
    assert.strictEqual(
      norm.selectNumberTargets([{ text, statedCategory: null } as NarrationNumberTarget]).length,
      0, id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The copy's name, and the words the model is shown
// ─────────────────────────────────────────────────────────────────────────────

test('the cache path is the same for the same input, version and model', () => {
  const a = norm.normalizedCopyPaths('/out', 'abc1234567890def', 'qwen3.5:9b');
  const b = norm.normalizedCopyPaths('/out', 'abc1234567890def', 'qwen3.5:9b');
  assert.strictEqual(a.epubPath, b.epubPath);
  assert.ok(a.epubPath.endsWith(`.${norm.NORMALIZER_VERSION}.qwen3.5-9b.norm.tts.epub`));
  assert.strictEqual(a.recordPath, a.epubPath.replace(/\.epub$/, '.edits.json'));
  // A different model, or a different input, is a different file.
  assert.notStrictEqual(
    a.epubPath, norm.normalizedCopyPaths('/out', 'abc1234567890def', 'qwen3.5:27b').epubPath);
  assert.notStrictEqual(
    a.epubPath, norm.normalizedCopyPaths('/out', 'ffff1234567890de', 'qwen3.5:9b').epubPath);
});

test('the model input labels the context and forbids editing it', () => {
  const input = norm.buildNormalizerInput('TARGET TEXT 1933', 'BEFORE', null);
  assert.ok(input.includes('PREVIOUS (context only, never edit this):\nBEFORE'));
  assert.ok(input.includes('TARGET (edit ONLY this):\nTARGET TEXT 1933'));
  assert.ok(input.includes('NEXT (context only, never edit this):\n(none)'),
    'an absent neighbour says so, rather than being left blank');
});
