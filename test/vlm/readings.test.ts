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

// ─────────────────────────────────────────────────────────────────────────────
// The record shape
//
// EVERYTHING THE MODEL RETURNED IS KEPT, and so is everything needed to
// interpret it. A page costs GPU-minutes, so a field the run knew and did not
// write down is a field that can only be got back by paying for the page again;
// and a bank that already exists on disk, written before those fields did, must
// keep opening and keep rendering books.
// ─────────────────────────────────────────────────────────────────────────────

test('a reading round-trips with the whole server payload and the geometry beside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-shape-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  const payload = {
    id: 'chatcmpl-7f3',
    object: 'chat.completion',
    created: 1_770_000_000,
    model: 'rednote-hilab/dots.ocr',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '[{"bbox":[1,2,3,4],"category":"Text","text":"x"}]' },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: { prompt_tokens: 1289, completion_tokens: 412, total_tokens: 1701 },
  };

  VlmReadings.open(readingsPath).append({
    page: 7,
    text: '[{"bbox":[1,2,3,4],"category":"Text","text":"x"}]',
    tokens: 412,
    finishReason: 'stop',
    seconds: 3.5,
    response: payload,
    render: { width: 1300, height: 2112 },
    maxPixels: 11_289_600,
    model: 'dots-ocr',
  });

  const reopened = VlmReadings.open(readingsPath).get(7)!;
  // The parsed-out fields are what the pipeline reads and they have not moved.
  assert.equal(reopened.text, '[{"bbox":[1,2,3,4],"category":"Text","text":"x"}]');
  assert.equal(reopened.tokens, 412);
  assert.equal(reopened.finishReason, 'stop');
  // And the whole payload is there, untrimmed and un-normalised — the prompt
  // token count, the model the server actually served, the response id. None of
  // it is recoverable later without reading the page again.
  assert.deepEqual(reopened.response, payload);
  assert.deepEqual(reopened.render, { width: 1300, height: 2112 });
  assert.equal(reopened.maxPixels, 11_289_600);
  assert.equal(reopened.model, 'dots-ocr');
});

test('the geometry is a PAIR: half of it reads as none of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-geometry-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  const readings = VlmReadings.open(readingsPath);
  readings.append({
    page: 1, text: 'a', tokens: 1, finishReason: 'stop', seconds: 1,
    render: { width: 1300, height: 2112 }, maxPixels: 2_000_000,
  });
  // A render with no budget is a scale that would be quietly wrong, which is the
  // one failure that is invisible in the text and wrong in every picture crop.
  readings.append({
    page: 2, text: 'b', tokens: 1, finishReason: 'stop', seconds: 1,
    render: { width: 1300, height: 2112 },
  });
  readings.append({ page: 3, text: 'c', tokens: 1, finishReason: 'stop', seconds: 1 });

  const reopened = VlmReadings.open(readingsPath);
  assert.deepEqual(reopened.geometry(1), {
    render: { width: 1300, height: 2112 }, maxPixels: 2_000_000,
  });
  assert.equal(reopened.geometry(2), null);
  assert.equal(reopened.geometry(3), null);
});

test('a bank written before any of those fields existed still opens, whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-legacy-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  // The old shape, byte for byte: five fields and nothing else.
  fs.writeFileSync(
    readingsPath,
    '{"page":1,"text":"old","tokens":9,"finishReason":"stop","seconds":2.5}\n'
    + '{"page":2,"text":"older","tokens":8,"finishReason":null,"seconds":1.5}\n',
  );
  const readings = VlmReadings.open(readingsPath);
  assert.equal(readings.size, 2);
  assert.equal(readings.get(1)!.text, 'old');
  assert.equal(readings.get(2)!.finishReason, null);
  // Absence means "this run did not record it", never "there was none", and
  // nothing is invented to fill the gap.
  assert.equal(readings.get(1)!.response, undefined);
  assert.equal(readings.get(1)!.render, undefined);
  assert.equal(readings.geometry(1), null);
});

test('a record whose new fields are the wrong type is not believed, and the old ones still are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-junk-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  fs.writeFileSync(
    readingsPath,
    '{"page":1,"text":"t","tokens":1,"finishReason":"stop","seconds":1,'
    + '"render":{"width":1300},"maxPixels":"lots","model":7}\n',
  );
  const reading = VlmReadings.open(readingsPath).get(1)!;
  assert.equal(reading.text, 't');
  assert.equal(reading.render, undefined);
  assert.equal(reading.maxPixels, undefined);
  assert.equal(reading.model, undefined);
});
