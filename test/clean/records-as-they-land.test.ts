/**
 * WHAT A PASS THAT DIED KEEPS — the answers it already paid for.
 *
 * ── THE DEFECT THIS SUITE PINS ──────────────────────────────────────────────
 *
 * `runCleanText` logs, before it asks anything, that *"every block is asked of
 * the model and recorded there as it lands"*. Until 2026-09-20 that sentence was
 * translate's, copied without translate's mechanism: `askAboutEach` was awaited
 * to completion and the `appendRecord` loop ran AFTER it, so a pass that threw
 * on the last block wrote none of the answers it had reached — measured at 351
 * of 940 answers and around forty-five minutes of GPU, on a run whose queue
 * offered to "pick it up from where it got to" (BUG-HUNT-2026-09-20 §A F2, §A
 * F5). `records.append` has been fsync-per-row the whole time; the clean pass
 * was the one caller that never reached it.
 *
 * So what is asserted here is the resume story end to end, over the real pass:
 * a runner that answers three blocks and then throws leaves three rows on disk,
 * and the next run asks only the fourth. Nothing else about the pass is pinned
 * — the three stages have keepers of their own.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCleanText } from '../../src/clean/run.js';
import type { NumberNormalizerRunner } from '../../src/clean/tts-number-normalizer.js';

/**
 * Four paragraphs — one block each, no table, no cell arithmetic. Each prints an
 * acronym so that it is ASKED: a block printing nothing any answer could change
 * is settled by the rules without a request (blockMayTakeAnEdit, 2026-09-24),
 * and this file is about what happens to requests.
 */
const TEXTS = [
  'The NATO committee met on the first floor and adjourned before noon.',
  'Nobody present had read the UN report, and nobody said so out loud.',
  'A second EU meeting was called for the following week, in the same room.',
  'The BBC minutes were never circulated, which surprised exactly no one.',
];

function bookFile(dir: string): string {
  const header = {
    book: 3,
    engine: 'foundry-test',
    language: 'en',
    source: { pages: 1, unreadable: [], bankSha: 'sha256:test' },
    chapters: [],
    typography: null,
    seams: [],
    loose: { markers: [], notes: [] },
  };
  const rows = TEXTS.map((text, at) => ({
    id: `b1-${at + 1}`,
    category: 'Text',
    text,
    page: 1,
    pages: [1],
    box: [0, 0, 100, 10],
    // One banked answer covering the whole row: the format says of every row
    // which answers assembled it, and a row whose parts do not account for its
    // characters is refused by name (`checkParts`, vlm/book-file.ts).
    parts: [{ src: `p1-${at + 1}`, page: 1, chars: [0, text.length] }],
  }));
  const at = path.join(dir, 'book.jsonl');
  fs.writeFileSync(
    at,
    [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n',
  );
  return at;
}

/**
 * A model that answers `answers` blocks and then throws, and remembers every
 * block it was shown.
 *
 * It proposes no edit, because what is under test is WHEN a verdict is written
 * down and not what the verdict was. The throw is a plain `Error` whose words
 * match no transport rule, so `askForEdits` does not re-roll it and the pass
 * ends on it — which is the interrupted run this suite is about.
 */
function runnerThatDiesAfter(answers: number): NumberNormalizerRunner & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    model: 'a stub that stops answering',
    async generate(input: string): Promise<string> {
      seen.push(input);
      if (seen.length > answers) throw new Error('the stub has stopped answering');
      return '{"edits": []}';
    },
    async release(): Promise<void> { /* nothing was loaded. */ },
  };
}

/** Which positions the records file holds a row for, in file order. */
function positionsIn(recordsPath: string): string[] {
  return fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { parts: string }).parts);
}

/** Which of the four paragraphs a runner was actually shown. */
function blocksAsked(seen: readonly string[]): string[] {
  return TEXTS.filter((text) => seen.some((input) => input.includes(text)));
}

describe('clean-text records each answer where it lands', () => {
  test('a pass that dies on block 4 keeps 3 rows, and the re-run asks only the 4th', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-records-'));
    const bookPath = bookFile(dir);
    const recordsPath = path.join(dir, 'records.jsonl');
    const stampPath = path.join(dir, 'stamp.json');

    // ── The interrupted run. Serial, so "the fourth" is a fact and not a race.
    const died = runnerThatDiesAfter(3);
    await expect(runCleanText({
      bookPath,
      recordsPath,
      stampPath,
      endpoint: 'http://fake:8000/v1',
      runner: died,
      concurrency: 1,
      log: () => {},
    })).rejects.toThrow(/stopped answering/);

    // Three answers were reached, and all three are ON DISK — this is the whole
    // packet. Before the fix this file did not exist at all.
    expect(positionsIn(recordsPath)).toEqual(['b1-1', 'b1-2', 'b1-3']);
    expect(blocksAsked(died.seen)).toEqual(TEXTS);

    // ── The re-run, which is what the three rows bought.
    const resumed = runnerThatDiesAfter(99);
    const outcome = await runCleanText({
      bookPath,
      recordsPath,
      stampPath,
      endpoint: 'http://fake:8000/v1',
      runner: resumed,
      concurrency: 1,
      log: () => {},
    });

    // ONLY the fourth paragraph reached the model, and only one row was added.
    expect(blocksAsked(resumed.seen)).toEqual([TEXTS[3]!]);
    expect(outcome.reused).toBe(3);
    expect(outcome.written).toBe(1);
    expect(positionsIn(recordsPath)).toEqual(['b1-1', 'b1-2', 'b1-3', 'b1-4']);
  });

  test('a pass that finishes writes every row exactly once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-records-whole-'));
    const bookPath = bookFile(dir);
    const recordsPath = path.join(dir, 'records.jsonl');

    const runner = runnerThatDiesAfter(99);
    const outcome = await runCleanText({
      bookPath,
      recordsPath,
      stampPath: path.join(dir, 'stamp.json'),
      endpoint: 'http://fake:8000/v1',
      runner,
      // Several in flight: the rows land in whatever order the answers do, and
      // every reader of this file takes the newest row per position, so what is
      // asserted is the SET and the count — never the order.
      concurrency: 4,
      log: () => {},
    });

    expect(outcome.written).toBe(4);
    expect(positionsIn(recordsPath).sort()).toEqual(['b1-1', 'b1-2', 'b1-3', 'b1-4']);
  });
});
