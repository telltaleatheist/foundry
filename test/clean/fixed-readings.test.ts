/**
 * fixed readings and printed forms — a book glossary's two halves on this side
 * (2026-10-03; src/clean/fixed-readings.ts, src/clean/forms.ts).
 *
 * What these hold the code to:
 *
 *  - a reading is applied wherever its find stands as a whole token run, the
 *    longest find first, and never inside a word ("esp" is not in "especially");
 *  - a reading touches the cache key ONLY of a block it applies to, so a book's
 *    glossary growing re-asks those blocks and keeps every other answer;
 *  - over the real pass, the model is never shown a form the readings decided,
 *    and the receipt says how often each was read;
 *  - a malformed readings file is refused by name, never half-applied;
 *  - the inventory lists the forms the experiment measured — "Wolf IV" with its
 *    word in front, "esp" and "esp." as one, no numbers, no "did".
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyFixedReadings, fixedKeyField, readFixedReadingsFile, validateFixedReadings, type FixedReading,
} from '../../src/clean/fixed-readings.js';
import { collectPrintedForms } from '../../src/clean/forms.js';
import { isPrintedForm } from '../../src/clean/light-gate.js';
import { cleanKey, runCleanText, triageKey, type CleanTextReceipt } from '../../src/clean/run.js';
import type { NumberNormalizerRunner } from '../../src/clean/tts-number-normalizer.js';

/** What BookForge hands in for Hellworld: the bare form, because the book prints "esp" without a period too. */
const GLOSSARY: FixedReading[] = [
  { find: 'Wolf IV', replace: 'Wolf Four' },
  { find: 'esp', replace: 'ESP' },
];

describe('applying a reading', () => {
  test('a whole token run, wherever it stands, and never inside a word', () => {
    const one = applyFixedReadings(
      'Her esp kept failing on Wolf IV. She touched it with her esp. Especially esp, especially.',
      GLOSSARY,
    );
    expect(one.text).toBe('Her ESP kept failing on Wolf Four. She touched it with her ESP. Especially ESP, especially.');
    expect(Object.fromEntries(one.applied)).toEqual({ esp: 3, 'Wolf IV': 1 });
  });

  test('a find ending in a period consumes it, except where it also ends the block', () => {
    const ed = [{ find: 'ed.', replace: 'edited by' }, { find: 'vols.', replace: 'volumes' }];
    expect(applyFixedReadings('reprinted, ed. Smith, in 1990', ed).text).toBe('reprinted, edited by Smith, in 1990');
    expect(applyFixedReadings('It ran to three vols.', ed).text).toBe('It ran to three volumes.');
    expect(applyFixedReadings('"It ran to three vols."', ed).text).toBe('"It ran to three volumes."');
    // A bare find leaves the sentence's own period where it stands.
    expect(applyFixedReadings('with her esp. Then she ran.', GLOSSARY).text).toBe('with her ESP. Then she ran.');
  });

  test('a possessive and a quotation mark are not word characters', () => {
    expect(applyFixedReadings("Wolf IV's moons, 'Wolf IV'", GLOSSARY).text).toBe("Wolf Four's moons, 'Wolf Four'");
  });

  test('a shorter find still stands where a longer one at the same place does not', () => {
    const readings = [{ find: 'Dr.', replace: 'Doctor' }, { find: 'Dr', replace: 'Doctor' }];
    expect(applyFixedReadings('Dr.Smith and Dr. Jones', readings).text).toBe('Doctor.Smith and Doctor Jones');
  });

  test('nothing handed in is nothing changed', () => {
    expect(applyFixedReadings('Wolf IV', []).text).toBe('Wolf IV');
  });
});

describe('the cache key', () => {
  const base = { model: 'qwen3.5-9b', unit: 'sentence' as const };

  test('a block no reading touches keeps the key it had', () => {
    const text = 'Nobody present had read the report.';
    expect(cleanKey({ ...base, text, fixed: GLOSSARY })).toBe(cleanKey({ ...base, text }));
    expect(triageKey({ text, triageModel: 'm', fixed: GLOSSARY })).toBe(triageKey({ text, triageModel: 'm' }));
    expect(fixedKeyField(text, GLOSSARY)).toBe('');
  });

  test('a block a reading touches is a different question, and a different reading another', () => {
    const text = 'Never a dull moment on Wolf IV.';
    const plain = cleanKey({ ...base, text });
    const four = cleanKey({ ...base, text, fixed: GLOSSARY });
    const fourth = cleanKey({ ...base, text, fixed: [{ find: 'Wolf IV', replace: 'Wolf the Fourth' }] });
    expect(new Set([plain, four, fourth]).size).toBe(3);
    // A reading for a form this block does not print changes nothing about it.
    expect(cleanKey({ ...base, text, fixed: [...GLOSSARY, { find: 'SPD', replace: 'S P D' }] })).toBe(four);
  });
});

describe('the readings file', () => {
  const write = (body: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-readings-'));
    const at = path.join(dir, 'readings.json');
    fs.writeFileSync(at, typeof body === 'string' ? body : JSON.stringify(body));
    return at;
  };

  test('a well-formed file is read, and a reading that changes nothing is dropped', () => {
    const readings = readFixedReadingsFile(write({
      format: 'fixed-readings/v1',
      readings: [{ find: 'esp', replace: 'ESP' }, { find: 'SPD', replace: 'SPD' }],
    }));
    expect(readings).toEqual([{ find: 'esp', replace: 'ESP' }]);
  });

  test('every way a file is not one is refused by name', () => {
    expect(() => readFixedReadingsFile(write('not json'))).toThrow(/cannot be read as JSON/);
    expect(() => readFixedReadingsFile(write({ readings: [] }))).toThrow(/is not a fixed-readings\/v1 file/);
    expect(() => validateFixedReadings([{ find: 'esp' }])).toThrow(/needs a string "find" and a string "replace"/);
    expect(() => validateFixedReadings([{ find: ' esp', replace: 'ESP' }])).toThrow(/space-edged find/);
    expect(() => validateFixedReadings([{ find: 'esp', replace: '' }])).toThrow(/empty or space-edged replace/);
    expect(() => validateFixedReadings([{ find: 'Tagebücher*', replace: 'x' }])).toThrow(/inline markup/);
    expect(() => validateFixedReadings([{ find: 'esp', replace: 'ESP' }, { find: 'esp', replace: 'espionage' }]))
      .toThrow(/two readings/);
  });
});

// ── Over the real pass ──────────────────────────────────────────────────────────

const TEXTS = [
  'The pinnace circled Wolf IV once before it landed.',
  'DeChance reached out and touched the sphere with her esp.',
  'Nobody present had read the report, and nobody said so out loud.',
];

/** A book of rows; a row is its text, or its text and the category the book gives it. */
function bookFile(dir: string, texts: readonly (string | { text: string; category: string })[] = TEXTS): string {
  const header = {
    book: 3, engine: 'foundry-test', language: 'en',
    source: { pages: 1, unreadable: [], bankSha: 'sha256:test' },
    chapters: [], typography: null, seams: [], loose: { markers: [], notes: [] },
  };
  const rows = texts.map((row, at) => {
    const { text, category } = typeof row === 'string' ? { text: row, category: 'Text' } : row;
    return {
      id: `b1-${at + 1}`, category, text, page: 1, pages: [1], box: [0, 0, 100, 10],
      parts: [{ src: `p1-${at + 1}`, page: 1, chars: [0, text.length] }],
    };
  });
  const at = path.join(dir, 'book.jsonl');
  fs.writeFileSync(at, [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n');
  return at;
}

function listeningRunner(): NumberNormalizerRunner & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    model: 'a stub that proposes nothing',
    async generate(input: string): Promise<string> { seen.push(input); return '{"edits": []}'; },
    async release(): Promise<void> { /* nothing was loaded. */ },
  };
}

describe('clean-text handed fixed readings', () => {
  test('the model is never shown a decided form, the book reads it, and the receipt counts it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-fixed-'));
    const recordsPath = path.join(dir, 'records.jsonl');
    const runner = listeningRunner();
    const outcome = await runCleanText({
      bookPath: bookFile(dir), recordsPath, stampPath: path.join(dir, 'stamp.json'),
      endpoint: 'http://fake:8000/v1', runner, concurrency: 1, fixedReadings: GLOSSARY, log: () => {},
    });
    const shown = runner.seen.join('\n');
    expect(shown).not.toContain('Wolf IV');
    expect(shown).not.toMatch(/\besp\b/);
    expect(shown).toContain('Wolf Four');
    expect(shown).toContain('her ESP.');

    const rows = fs.readFileSync(recordsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { parts: string; text: string });
    expect(rows.find((r) => r.parts === 'b1-1')!.text).toBe('The pinnace circled Wolf Four once before it landed.');
    expect(rows.find((r) => r.parts === 'b1-2')!.text).toBe('DeChance reached out and touched the sphere with her ESP.');

    const receipt = JSON.parse(fs.readFileSync(`${recordsPath}.receipt.json`, 'utf8')) as CleanTextReceipt;
    expect(receipt.fixedReadings).toEqual({ given: 2, applied: { 'Wolf IV': 1, esp: 1 } });
    expect(outcome.changed).toBe(2);
  });

  test('a glossary that grows re-asks only the blocks it touches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-fixed-grow-'));
    const bookPath = bookFile(dir);
    const recordsPath = path.join(dir, 'records.jsonl');
    const stampPath = path.join(dir, 'stamp.json');
    const first = listeningRunner();
    await runCleanText({
      bookPath, recordsPath, stampPath, endpoint: 'http://fake:8000/v1', runner: first, concurrency: 1,
      fixedReadings: [{ find: 'Wolf IV', replace: 'Wolf Four' }], log: () => {},
    });
    expect(first.seen.length).toBe(3);

    const second = listeningRunner();
    await runCleanText({
      bookPath, recordsPath, stampPath, endpoint: 'http://fake:8000/v1', runner: second, concurrency: 1,
      fixedReadings: GLOSSARY, log: () => {},
    });
    expect(second.seen.length).toBe(1);
    expect(second.seen[0]).toContain('her ESP.');
  });
});

// ── The inventory ───────────────────────────────────────────────────────────────

describe('clean-forms', () => {
  const book = (texts: readonly (string | { text: string; category: string })[]): { text: string; where: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-forms-'));
    const where = bookFile(dir, texts);
    return { text: fs.readFileSync(where, 'utf8'), where };
  };

  test('the forms a reading is asked about, and none of what the sentence pass reads', () => {
    const { text, where } = book([
      'The pinnace circled Wolf IV once. Never a dull moment on Wolf IV.',
      'Her esp kept trying to make sense of it, and she touched the sphere with her esp.',
      'The SPD refused, and Henry IV did nothing in 1843 [sic] about it.',
      'CHAPTER FOUR: THE ALIEN',
      // A title the person merged in mixed case: a heading by its category, not by its capitals.
      { text: 'CHAPTER SIX: In the Forest of the Night', category: 'Title' },
      { text: 'PART IV: The Return', category: 'Title' },
      'He did not mind; the civil service was vivid and J. Smith said slowly.over and over.',
    ]);
    const forms = collectPrintedForms(text, where);
    const byKey = new Map(forms.map((f) => [f.key, f]));
    expect(byKey.get('Wolf IV')).toMatchObject({ kind: 'roman', count: 2, printed: { 'Wolf IV': 2 } });
    expect(byKey.get('Henry IV')).toMatchObject({ kind: 'roman', count: 1 });
    expect(byKey.get('esp')).toMatchObject({ kind: 'abbreviation', count: 2, printed: { esp: 1, 'esp.': 1 } });
    expect(byKey.get('SPD')).toMatchObject({ kind: 'caps', count: 1 });
    // Not forms: a number, a bracket, a heading's capitals, numeral-letter words, an initial, a typo.
    for (const key of ['1843', 'sic', 'CHAPTER', 'FOUR', 'SIX', 'ALIEN', 'did', 'civil', 'vivid', 'j', 'slowly.over']) {
      expect(byKey.has(key)).toBe(false);
    }
    expect(byKey.get('Wolf IV')!.samples.map((s) => s.parts)).toEqual(['b1-1', 'b1-1']);
    // A numeral in a heading still needs reading, whatever the heading's case.
    expect(byKey.get('PART IV')).toMatchObject({ kind: 'roman', count: 1 });
  });
});

// ── The light gate's numeral letters (n19) ──────────────────────────────────────

test('a word spelled with numeral letters is not a printed form; a numeral is', () => {
  for (const word of ['did', 'civil', 'mill', 'vivid', 'mild', 'livid', 'dim', 'lid']) {
    expect(isPrintedForm([word], 0)).toBe(false);
  }
  for (const numeral of ['xix', 'xvi.', 'ii.', 'vii-xi']) {
    expect(isPrintedForm([numeral], 0)).toBe(true);
  }
  // A sentence's period does not hide a numeral or a run of capitals.
  expect(isPrintedForm(['on', 'Wolf', 'IV.'], 2)).toBe(true);
  expect(isPrintedForm(['joined', 'the', 'SPD.'], 2)).toBe(true);
  expect(isPrintedForm(['the', 'Führer.'], 1)).toBe(false);
});
