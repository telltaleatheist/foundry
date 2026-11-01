/**
 * a readings-only pass (2026-11-01; src/clean/apply-readings.ts).
 *
 * What these hold the code to:
 *
 *  - the readings are written in and NOTHING ELSE changes: no punctuation, no
 *    numbers as words, no spacing;
 *  - every reading that landed is in the applied record, with `nthAfter` naming
 *    its whole-token run in the WRITTEN block, so a later cleanup can protect it —
 *    with a form repeated in one block, and with a reading whose words are
 *    already printed earlier in the block;
 *  - a reading that changes how many tokens there are, and a find ending in a
 *    period, land where they should;
 *  - a re-run with a reading taken out writes that block back as printed and
 *    leaves the others' rows alone.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appliedReadingsPathFor, runApplyReadings, type AppliedReadingsFile,
} from '../../src/clean/apply-readings.js';
import { applyFixedReadings, wholeTokenOffsets, type FixedReading } from '../../src/clean/fixed-readings.js';
import { TranslationRecords } from '../../src/translate/records.js';

function bookFile(dir: string, texts: readonly string[]): string {
  const header = {
    book: 3, engine: 'foundry-test', language: 'en',
    source: { pages: 1, unreadable: [], bankSha: 'sha256:test' },
    chapters: [], typography: null, seams: [], loose: { markers: [], notes: [] },
  };
  const rows = texts.map((text, at) => ({
    id: `b1-${at + 1}`, category: 'Text', text, page: 1, pages: [1], box: [0, 0, 100, 10],
    parts: [{ src: `p1-${at + 1}`, page: 1, chars: [0, text.length] }],
  }));
  const at = path.join(dir, 'book.jsonl');
  fs.writeFileSync(at, [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n');
  return at;
}

const TEXTS = [
  'The U.S. Army and the U.S. Navy met "near" the coast in 1940 -- twice.',
  'Here U S was printed spaced, and then U.S. was printed dotted.',
  'Gen. Speidel read 3 vols. of it, then 2 vols.',
  'Nothing here is touched, not even  this double space or 1,200 men.',
];

const READINGS: FixedReading[] = [
  { find: 'U.S.', replace: 'U S', at: 'b1-1', nth: 0 },
  { find: 'U.S.', replace: 'U S', at: 'b1-1', nth: 1 },
  { find: 'U.S.', replace: 'U S', at: 'b1-2', nth: 0 },
  { find: 'Gen.', replace: 'General', at: 'b1-3', nth: 0 },
  { find: 'vols.', replace: 'volumes' },
];

async function run(dir: string, readings: readonly FixedReading[], logs: string[] = []): Promise<{ records: string; applied: AppliedReadingsFile }> {
  const records = path.join(dir, 'readings', 'k.clean.records.jsonl');
  await runApplyReadings({
    bookPath: path.join(dir, 'book.jsonl'),
    recordsPath: records,
    stampPath: path.join(dir, 'readings', 'k.clean.stamp.json'),
    fixedReadings: readings,
    log: (line) => logs.push(line),
  });
  return { records, applied: JSON.parse(fs.readFileSync(appliedReadingsPathFor(records), 'utf8')) as AppliedReadingsFile };
}

function newestText(records: string, parts: string): string | undefined {
  return TranslationRecords.open(records).rowFor(parts)?.text;
}

describe('a readings-only pass', () => {
  test('writes the readings in and nothing else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-readings-'));
    bookFile(dir, TEXTS);
    const { records } = await run(dir, READINGS);
    expect(newestText(records, 'b1-1')).toBe('The U S Army and the U S Navy met "near" the coast in 1940 -- twice.');
    expect(newestText(records, 'b1-2')).toBe('Here U S was printed spaced, and then U S was printed dotted.');
    // A find ending in a period consumes it mid-block, and keeps the block's stop at its end.
    expect(newestText(records, 'b1-3')).toBe('General Speidel read 3 volumes of it, then 2 volumes.');
    // The block no reading touches is written exactly as printed: no punctuation pass, no numbers.
    expect(newestText(records, 'b1-4')).toBe(TEXTS[3]);
    expect(fs.existsSync(path.join(dir, 'readings', 'k.clean.stamp.json'))).toBe(true);
  });

  test('every landed reading names its run in the WRITTEN block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-readings-'));
    bookFile(dir, TEXTS);
    const { applied } = await run(dir, READINGS);
    expect(applied.format).toBe('applied-readings/v1');
    const inFirst = applied.applied.filter((a) => a.at === 'b1-1');
    expect(inFirst.map((a) => [a.nthBefore, a.replace, a.nthAfter])).toEqual([[0, 'U S', 0], [1, 'U S', 1]]);
    // "U S" was already printed earlier in this block, so the written one is the SECOND run.
    const second = applied.applied.find((a) => a.at === 'b1-2')!;
    expect([second.nthBefore, second.nthAfter]).toEqual([0, 1]);
    // A book-wide reading has no occurrence number before; it has one after.
    const vols = applied.applied.filter((a) => a.find === 'vols.');
    expect(vols.map((a) => [a.nthBefore, a.replace, a.nthAfter])).toEqual([[null, 'volumes', 0], [null, 'volumes.', 0]]);
    // Handed back as kept spots, they protect exactly the written runs.
    const written = newestText(path.join(dir, 'readings', 'k.clean.records.jsonl'), 'b1-1')!;
    const kept = inFirst.map((a) => ({ find: a.replace, replace: a.replace, at: a.at, nth: a.nthAfter! }));
    const again = applyFixedReadings(written, kept, 'b1-1');
    expect(again.text).toBe(written);
    expect(again.missed).toEqual([]);
    expect(again.protected.map((s) => written.slice(s.at, s.end))).toEqual(['U S', 'U S']);
  });

  test('a reading that changes the token count lands in place, and so does one ending in a period', () => {
    const one = applyFixedReadings('In 9 A.D. Varus fell; in A.D. 14 Augustus died.', [
      { find: 'A.D.', replace: 'A D.', at: 'k', nth: 0 },
      { find: 'A.D.', replace: 'A D', at: 'k', nth: 1 },
    ], 'k');
    expect(one.text).toBe('In 9 A D. Varus fell; in A D 14 Augustus died.');
    expect(one.placed.map((p) => one.text.slice(p.at, p.end))).toEqual(['A D.', 'A D']);
    expect(wholeTokenOffsets(one.text, 'A D').length).toBe(2);
  });

  test('a re-run with a reading taken out writes that block back as printed, and only that block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-readings-'));
    bookFile(dir, TEXTS);
    const { records } = await run(dir, READINGS);
    const before = TranslationRecords.open(records).size;
    await run(dir, READINGS.filter((r) => r.find !== 'Gen.'));
    expect(newestText(records, 'b1-3')).toBe('Gen. Speidel read 3 volumes of it, then 2 volumes.');
    expect(newestText(records, 'b1-1')).toBe('The U S Army and the U S Navy met "near" the coast in 1940 -- twice.');
    // One new row, for the one block whose question changed.
    expect(TranslationRecords.open(records).size).toBe(before + 1);
  });

  test('no readings is refused by name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-readings-'));
    bookFile(dir, TEXTS);
    await expect(run(dir, [])).rejects.toThrow(/handed no readings/);
  });
});
