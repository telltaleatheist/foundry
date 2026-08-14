/**
 * The bank, and the one question that decides whether a book gets read.
 *
 * `readings.jsonl` is minutes of GPU a page and hours a book, so it is kept,
 * resumed and never deleted. What this file pins is the distinction that was
 * missing until now: a bank left by a KILL is a debt, and the next run pays only
 * the missing pages; a bank left by a run that WROTE ITS EPUB is finished work,
 * and somebody who orders that conversion again is ordering the pages read
 * again. Answering them out of the bank obeys nobody and does nothing.
 *
 * Every case here is asserted on TWO things — what the run will do, and the
 * sentence it prints — because a decision nobody can read in the log is a
 * decision nobody can check, and the bug this closes was invisible precisely
 * because the run said nothing about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  archiveReadingsBank,
  completionMarkerPath,
  openReadingsBank,
  readCompletionMarker,
  VlmReadings,
  VlmReadingsError,
  writeCompletionMarker,
} from '../../src/vlm/readings.js';
import { VERSION } from '../../src/version.js';

/** A run directory with `pages` banked answers in it, and nothing else. */
function runDir(pages: readonly number[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-test-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  const readings = VlmReadings.open(readingsPath);
  for (const page of pages) {
    readings.append({ page, text: `page ${page}`, tokens: 10, finishReason: 'stop', seconds: 1 });
  }
  return readingsPath;
}

function markComplete(readingsPath: string, pages: number): void {
  writeCompletionMarker(readingsPath, {
    completedAt: '2026-08-01T12:00:00.000Z',
    outPath: path.join(path.dirname(readingsPath), 'book.epub'),
    pages,
  });
}

const AT = new Date('2026-08-08T09:30:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// The marker
// ─────────────────────────────────────────────────────────────────────────────

test('the marker is named for the bank it belongs to, not for its directory', () => {
  /*
   * MEASURED, on a real install: the app banked every book into one
   * `readings/` directory, so the old `<dir>/completed.json` was a single
   * marker for two books, stamped by whichever conversion finished last. Asked
   * about the other book it answered anyway — nothing compares the marker's
   * `outPath` to the run's — and that run archived a complete bank and read a
   * hundred pages again.
   */
  const readingsPath = runDir([1]);
  assert.equal(completionMarkerPath(readingsPath), `${readingsPath.replace(/\.jsonl$/, '')}.completed.json`);
  // Two banks in one directory are two markers, and neither answers for the other.
  const neighbour = path.join(path.dirname(readingsPath), 'another-book.jsonl');
  assert.notEqual(completionMarkerPath(neighbour), completionMarkerPath(readingsPath));
  assert.equal(readCompletionMarker(readingsPath), null);
  markComplete(readingsPath, 12);
  const marker = readCompletionMarker(readingsPath);
  assert.equal(marker?.pages, 12);
  assert.equal(marker?.completedAt, '2026-08-01T12:00:00.000Z');
  // The build that wrote it, so a marker can be traced back to a binary.
  assert.equal(marker?.foundryVersion, VERSION);
});

test('a marker that does not parse is refused, not read as "no run completed"', () => {
  const readingsPath = runDir([1]);
  fs.writeFileSync(completionMarkerPath(readingsPath), '{ this is not json', 'utf8');
  assert.throws(() => readCompletionMarker(readingsPath), (err: unknown) => {
    assert.ok(err instanceof VlmReadingsError);
    assert.match(err.message, /is not JSON/);
    return true;
  });
});

test('a marker missing a field is refused rather than half-believed', () => {
  const readingsPath = runDir([1]);
  fs.writeFileSync(
    completionMarkerPath(readingsPath),
    JSON.stringify({ completedAt: '2026-08-01T12:00:00.000Z' }),
    'utf8',
  );
  assert.throws(() => readCompletionMarker(readingsPath), (err: unknown) => {
    assert.ok(err instanceof VlmReadingsError);
    assert.match(err.message, /not a vlm-convert completion marker/);
    return true;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Archiving — the answers are moved, never destroyed
// ─────────────────────────────────────────────────────────────────────────────

test('archiving moves the bank and its marker aside and leaves the live path empty', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const archiveDir = archiveReadingsBank(readingsPath, AT);

  // The live bank is gone — that is what makes the next run read the book.
  assert.equal(fs.existsSync(readingsPath), false);
  assert.equal(fs.existsSync(completionMarkerPath(readingsPath)), false);
  // And the hours it cost are still on disk, under a name a person can find.
  assert.equal(path.basename(archiveDir), 'archived-2026-08-08T09-30-00-000Z');
  assert.equal(VlmReadings.open(path.join(archiveDir, 'readings.jsonl')).size, 3);
  // The marker keeps the name it had, which is its bank's — so an archive
  // directory holding two runs' leavings still says which marker is whose.
  assert.equal(fs.existsSync(path.join(archiveDir, 'readings.completed.json')), true);
  // A colon is not a legal Windows filename character, and this program runs there.
  assert.equal(archiveDir.slice(3).includes(':'), false);
});

test('an archive directory that already exists is refused, never merged into', () => {
  const readingsPath = runDir([1]);
  fs.mkdirSync(path.join(path.dirname(readingsPath), 'archived-2026-08-08T09-30-00-000Z'));
  assert.throws(() => archiveReadingsBank(readingsPath, AT), (err: unknown) => {
    assert.ok(err instanceof VlmReadingsError);
    assert.match(err.message, /already exists/);
    return true;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────────

test('COMPLETED, nothing asked: the bank is archived and every page is read again', () => {
  const readingsPath = runDir([1, 2, 3, 4]);
  markComplete(readingsPath, 4);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'read-fresh');
  // Nothing is banked for this run, so no page is answered out of the cache.
  assert.equal(outcome.readings.size, 0);
  assert.notEqual(outcome.archivedTo, null);
  assert.equal(VlmReadings.open(path.join(outcome.archivedTo!, 'readings.jsonl')).size, 4);
  // The sentence names the completion, the archive and the way back.
  assert.match(outcome.sentence, /already completed 2026-08-01T12:00:00\.000Z/);
  assert.match(outcome.sentence, /4 banked page answer\(s\) were archived to/);
  assert.match(outcome.sentence, /every page is read from the model/);
  assert.match(outcome.sentence, /--reuse-readings/);
});

test('INTERRUPTED: a bank with no marker is resumed, and the counts are printed', () => {
  const readingsPath = runDir([1, 2, 3]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.readings.size, 3);
  assert.equal(outcome.archivedTo, null);
  // The bank is untouched: resuming never costs a page that was already paid for.
  assert.equal(fs.existsSync(readingsPath), true);
  assert.match(outcome.sentence, /resuming an interrupted run — 3 page\(s\) already read and banked/);
});

test('REUSE REQUESTED over a completed run: the answers are replayed, and it says BY REQUEST', () => {
  const readingsPath = runDir([1, 2, 3, 4, 5]);
  markComplete(readingsPath, 5);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: true });

  assert.equal(outcome.action, 'reuse');
  assert.equal(outcome.readings.size, 5);
  assert.equal(outcome.archivedTo, null);
  assert.equal(fs.existsSync(completionMarkerPath(readingsPath)), true);
  assert.match(outcome.sentence, /reusing 5 banked page answer\(s\) BY REQUEST \(--reuse-readings\)/);
});

test('FRESH REQUESTED with no marker: the legacy bank is archived anyway', () => {
  // This is the case BookForge's own records answer: a bank written before
  // markers existed, from a conversion the app knows finished.
  const readingsPath = runDir([1, 2]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: true, reuseRequested: false });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.readings.size, 0);
  assert.equal(VlmReadings.open(path.join(outcome.archivedTo!, 'readings.jsonl')).size, 2);
  assert.match(outcome.sentence, /fresh readings were asked for, so the 2 banked page answer\(s\)/);
  assert.match(outcome.sentence, /every page is read from the model again/);
});

test('REUSE REQUESTED with no marker resumes — there is no completed run to replay', () => {
  const readingsPath = runDir([7, 8]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: true });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.readings.size, 2);
  assert.match(outcome.sentence, /no run has completed here — resuming the interrupted run, 2 page/);
});

test('an empty run directory reads the whole book and says so', () => {
  const readingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-test-')), 'readings.jsonl');
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.readings.size, 0);
  assert.equal(outcome.archivedTo, null);
  assert.match(outcome.sentence, /nothing is banked in/);
});

test('--reuse-readings against an empty bank is refused, never turned into a full read', () => {
  // Hours of GPU is not what "reuse the answers" asks for, so it is not what
  // "reuse the answers" is allowed to silently mean.
  const readingsPath = runDir([]);
  assert.throws(
    () => openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: true }),
    (err: unknown) => {
      assert.ok(err instanceof VlmReadingsError);
      assert.match(err.message, /banks no page answers, so there is nothing to reuse/);
      return true;
    },
  );
});

test('the two flags contradict each other and passing both is refused', () => {
  const readingsPath = runDir([1]);
  assert.throws(
    () => openReadingsBank({ readingsPath, freshRequested: true, reuseRequested: true }),
    (err: unknown) => {
      assert.ok(err instanceof VlmReadingsError);
      assert.match(err.message, /opposite things about the same bank/);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The bug, end to end on the filesystem
// ─────────────────────────────────────────────────────────────────────────────

test('a completed conversion re-ordered twice archives twice and never replays', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);

  // The re-order the user made: it must read the book.
  const first = openReadingsBank({
    readingsPath, freshRequested: false, reuseRequested: false, now: AT,
  });
  assert.equal(first.action, 'read-fresh');

  // That run reads and banks its pages, then finishes.
  const rebanked = VlmReadings.open(readingsPath);
  for (const page of [1, 2, 3]) {
    rebanked.append({ page, text: `page ${page} again`, tokens: 10, finishReason: 'stop', seconds: 1 });
  }
  markComplete(readingsPath, 3);

  // And the one after it must read the book too — one marker does not exempt
  // the next order, and the first archive is not overwritten by the second.
  const second = openReadingsBank({
    readingsPath, freshRequested: false, reuseRequested: false, now: new Date('2026-08-09T09:30:00.000Z'),
  });
  assert.equal(second.action, 'read-fresh');
  assert.notEqual(second.archivedTo, first.archivedTo);
  assert.equal(VlmReadings.open(path.join(first.archivedTo!, 'readings.jsonl')).size, 3);
  assert.equal(VlmReadings.open(path.join(second.archivedTo!, 'readings.jsonl')).size, 3);
});
