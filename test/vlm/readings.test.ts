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
  completionMarkerPath,
  discardPending,
  openReadingsBank,
  pendingPath,
  pendingRequestPath,
  readCompletionMarker,
  readPendingRequest,
  sameAsk,
  swapPendingIntoPlace,
  VlmReadings,
  VlmReadingsError,
  writeCompletionMarker,
  writePendingRequest,
  type ReadingsAsk,
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

/**
 * A half-finished replacement beside the bank, exactly as a killed run leaves
 * one: the pending file with `pages` in it and the sidecar saying what it was
 * asked for.
 */
function pendingOf(readingsPath: string, pages: readonly number[], ask: ReadingsAsk): string {
  const pending = pendingPath(readingsPath);
  fs.writeFileSync(pending, '', 'utf8');
  const bank = VlmReadings.open(pending);
  for (const page of pages) {
    bank.append({ page, text: `page ${page}, again`, tokens: 10, finishReason: 'stop', seconds: 1 });
  }
  writePendingRequest(readingsPath, ask);
  return pending;
}

/** What a run finishing here would record. */
function completionOf(readingsPath: string, pages: number) {
  return {
    completedAt: '2026-08-09T10:00:00.000Z',
    outPath: path.join(path.dirname(readingsPath), 'book.epub'),
    pages,
  };
}

/** Every entry in the bank's directory, sorted — for "nothing else appeared". */
function listing(readingsPath: string): string[] {
  return fs.readdirSync(path.dirname(readingsPath)).sort();
}

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
// The decision — the matrix of BANK-LIFECYCLE §2.2, one test a row
//
// The rule the rows are all instances of: THE BANK IS NEVER DESTROYED UNTIL ITS
// REPLACEMENT EXISTS. Where there is nothing finished to protect, a run writes
// the bank directly and always did; where there is, it writes a pending file
// beside it and takes its place with one rename, at the end, or not at all.
// ─────────────────────────────────────────────────────────────────────────────

test('NO BANK: the whole book is read straight into it, and no pending appears', () => {
  const readingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-test-')), 'readings.jsonl');
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.readings.size, 0);
  // Nothing to protect, so nothing is built to protect it.
  assert.equal(outcome.pendingPath, null);
  assert.equal(fs.existsSync(pendingPath(readingsPath)), false);
  assert.match(outcome.sentence, /nothing is banked in/);
});

test('INCOMPLETE, NO MARKER: the bank itself is resumed — the partial bank IS the debt', () => {
  const readingsPath = runDir([1, 2, 3]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.readings.size, 3);
  // No good copy is at risk, so a pending here would be ceremony over nothing —
  // and would leave the three paid-for pages out of reach of the run resuming.
  assert.equal(outcome.pendingPath, null);
  assert.equal(fs.existsSync(pendingPath(readingsPath)), false);
  assert.equal(fs.existsSync(readingsPath), true);
  assert.match(outcome.sentence, /resuming an interrupted run — 3 page\(s\) already read and banked/);
});

test('COMPLETED, read again: the finished bank is left alone and the re-read goes pending', () => {
  /*
   * The bug this whole document is about, from the other side. This used to
   * archive four paid-for answers BEFORE READING A SINGLE PAGE, so a run that
   * died at page 2 left the project worse off for having tried.
   */
  const readingsPath = runDir([1, 2, 3, 4]);
  markComplete(readingsPath, 4);
  const before = fs.readFileSync(readingsPath);
  const outcome = openReadingsBank({
    readingsPath,
    freshRequested: false,
    reuseRequested: false,
    ask: { skipPages: [3], language: 'de', model: 'dots-ocr' },
  });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.readings.size, 0);
  assert.equal(outcome.pendingPath, pendingPath(readingsPath));

  // NOT ONE BYTE of the finished reading was touched, and its marker still stands.
  assert.deepEqual(fs.readFileSync(readingsPath), before);
  assert.equal(readCompletionMarker(readingsPath)?.pages, 4);
  // No hoard: the answers are where they always were, not under a timestamp.
  assert.deepEqual(listing(readingsPath).filter((e) => e.startsWith('archived-')), []);

  // The sidecar says what the gamble was asked, so the run after a kill can tell.
  const request = readPendingRequest(readingsPath)!;
  assert.deepEqual(request.skipPages, [3]);
  assert.equal(request.language, 'de');
  assert.equal(request.model, 'dots-ocr');
  assert.equal(request.foundryVersion, VERSION);

  assert.match(outcome.sentence, /already completed 2026-08-01T12:00:00\.000Z/);
  assert.match(outcome.sentence, /left exactly as they are/);
  assert.match(outcome.sentence, /replaces them only when this run finishes/);
  assert.match(outcome.sentence, /--reuse-readings/);
});

test('COMPLETED + --fresh-readings: the same pending path, and it says so', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const outcome = openReadingsBank({ readingsPath, freshRequested: true, reuseRequested: false });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.pendingPath, pendingPath(readingsPath));
  assert.equal(VlmReadings.open(readingsPath).size, 3);
  // The MARKER is the more informative fact and the sentence leads with it: the
  // flag and the marker are asking for the same thing here, and the completion
  // date is the thing a person reading the log did not already know.
  assert.match(outcome.sentence, /already completed 2026-08-01T12:00:00\.000Z/);
  assert.match(outcome.sentence, /left exactly as they are/);
});

test('FRESH REQUESTED with no marker: the legacy bank goes pending rather than aside', () => {
  // The case BookForge's own records answer: a bank written before markers
  // existed, from a conversion the app knows finished. The flag still means READ
  // THE BOOK AGAIN — it just no longer means "and lose the old reading first".
  const readingsPath = runDir([1, 2]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: true, reuseRequested: false });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.readings.size, 0);
  assert.equal(outcome.pendingPath, pendingPath(readingsPath));
  assert.equal(VlmReadings.open(readingsPath).size, 2);
  assert.match(outcome.sentence, /every page is read from the model again/);
  assert.deepEqual(listing(readingsPath).filter((e) => e.startsWith('archived-')), []);
});

test('COMPLETED + --reuse-readings: the answers are replayed, and it says BY REQUEST', () => {
  const readingsPath = runDir([1, 2, 3, 4, 5]);
  markComplete(readingsPath, 5);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: true });

  assert.equal(outcome.action, 'reuse');
  assert.equal(outcome.readings.size, 5);
  assert.equal(outcome.pendingPath, null);
  assert.equal(fs.existsSync(completionMarkerPath(readingsPath)), true);
  assert.match(outcome.sentence, /reusing 5 banked page answer\(s\) BY REQUEST \(--reuse-readings\)/);
});

test('REUSE REQUESTED with no marker resumes — there is no completed run to replay', () => {
  const readingsPath = runDir([7, 8]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: true });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.readings.size, 2);
  assert.equal(outcome.pendingPath, null);
  assert.match(outcome.sentence, /no run has completed here — resuming the interrupted run, 2 page/);
});

test('PENDING EXISTS, same ask: it is resumed, and the pages in it are not paid for twice', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const ask: ReadingsAsk = { skipPages: [4, 4, 2], language: 'de', model: 'dots-ocr' };
  const pending = pendingOf(readingsPath, [1, 2], ask);

  // The same ask written the other way round: identity is the NORMALISED list.
  const outcome = openReadingsBank({
    readingsPath,
    freshRequested: false,
    reuseRequested: false,
    ask: { skipPages: [2, 4], language: 'de', model: 'dots-ocr' },
  });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.pendingPath, pending);
  assert.equal(outcome.readings.size, 2);
  // Out of the PENDING, not out of the bank — a re-read means re-read, and the
  // old answers are not quietly reused to pretend the work was done.
  assert.equal(outcome.readings.get(1)?.text, 'page 1, again');
  assert.match(outcome.sentence, /resuming the replacement reading that was interrupted — 2 page/);
  assert.match(outcome.sentence, /only when this run finishes/);
});

test('PENDING EXISTS, different ask: it is thrown away and the replacement starts over', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const pending = pendingOf(readingsPath, [1, 2], { skipPages: [3], language: 'de' });

  const outcome = openReadingsBank({
    readingsPath,
    freshRequested: false,
    reuseRequested: false,
    ask: { skipPages: [3, 4], language: 'de' },
  });

  // The user changed the question, which is them saying the half-answer to the
  // old one is not worth finishing. Deleted, not archived: it is incomplete
  // machine output whose completion nobody wants any more.
  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.pendingPath, pending);
  assert.equal(outcome.readings.size, 0);
  assert.equal(VlmReadings.open(pending).size, 0);
  assert.deepEqual(readPendingRequest(readingsPath)?.skipPages, [3, 4]);
  // And the FINISHED bank, which was never the thing in question, is untouched.
  assert.equal(VlmReadings.open(readingsPath).size, 3);
  assert.match(outcome.sentence, /was asked for pages 3 skipped, language de/);
  assert.match(outcome.sentence, /this run asks for pages 3, 4 skipped/);
  assert.match(outcome.sentence, /thrown away and the replacement starts over/);
});

test('PENDING EXISTS + --fresh-readings: that is what the flag now means', () => {
  // `--fresh` stopped meaning "archive" and means "do not resume the pending,
  // start it over" — the one instruction nothing else in the vocabulary can give.
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const ask: ReadingsAsk = { skipPages: [], language: 'de' };
  const pending = pendingOf(readingsPath, [1, 2], ask);

  const outcome = openReadingsBank({ readingsPath, freshRequested: true, reuseRequested: false, ask });

  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.readings.size, 0);
  assert.equal(VlmReadings.open(pending).size, 0);
  assert.equal(VlmReadings.open(readingsPath).size, 3);
  assert.match(outcome.sentence, /2 page\(s\) of a half-finished replacement/);
  assert.match(outcome.sentence, /thrown away and it starts over/);
});

test('a pending is invisible to --reuse-readings: not read, not resumed, not swept', () => {
  /*
   * A replay reads nothing, so it has nothing to protect the bank from, and the
   * pending beside it belongs to an attempt that is none of its business. If it
   * ever opened one, the swap at the end of that run would rename SOMEBODY
   * ELSE'S half-read book over a finished one.
   */
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const pending = pendingOf(readingsPath, [1], { skipPages: [], language: 'de' });
  const debris = fs.readFileSync(pending);

  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: true });

  assert.equal(outcome.action, 'reuse');
  assert.equal(outcome.pendingPath, null);
  assert.equal(outcome.readings.size, 3);
  assert.deepEqual(fs.readFileSync(pending), debris);
  assert.equal(fs.existsSync(pendingRequestPath(readingsPath)), true);
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
// The sidecar — how a resume knows it is one
//
// Identity is `skipPages` and `language` and nothing else: the same split the
// ledger makes (`PARAMS_OF.read` minus `MINTED_BY_THE_RUN.read`). What the run
// STAMPED on its own answer is recorded and never compared.
// ─────────────────────────────────────────────────────────────────────────────

test('the model id is a recorded fact, not an identity field', () => {
  // Nobody chooses it per run in the app — the same reason `pages` is minted
  // rather than asked. A pending re-read is not thrown away because the default
  // model moved under it; those answers cost the same GPU either way.
  const readingsPath = runDir([1, 2]);
  markComplete(readingsPath, 2);
  pendingOf(readingsPath, [1], { skipPages: [5], language: 'de', model: 'dots-ocr' });

  const outcome = openReadingsBank({
    readingsPath,
    freshRequested: false,
    reuseRequested: false,
    ask: { skipPages: [5], language: 'de', model: 'some-other-model' },
  });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.readings.size, 1);
  // And the sidecar now records the model that is actually reading.
  assert.equal(readPendingRequest(readingsPath)?.model, 'some-other-model');
});

test('a language named and a language absent are different asks', () => {
  const readingsPath = runDir([1, 2]);
  markComplete(readingsPath, 2);
  pendingOf(readingsPath, [1], { skipPages: [], language: 'de' });

  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });
  assert.equal(outcome.readings.size, 0);
  assert.equal(readPendingRequest(readingsPath)?.language, null);
});

test('sameAsk compares the two fields the ledger compares, and normalises both', () => {
  const request = { skipPages: [2, 4], language: 'de', model: 'dots-ocr', foundryVersion: '1.0.0' };
  assert.equal(sameAsk(request, { skipPages: [4, 2, 4], language: 'de' }), true);
  assert.equal(sameAsk(request, { skipPages: [2, 4], language: 'de', model: 'anything' }), true);
  assert.equal(sameAsk(request, { skipPages: [2], language: 'de' }), false);
  assert.equal(sameAsk(request, { skipPages: [2, 4], language: 'en' }), false);
  assert.equal(sameAsk(request, { skipPages: [2, 4] }), false);
});

test('a pending with NO sidecar is resumed, not thrown away', () => {
  /*
   * Absent is not evidence of a different question — it is a pending written by
   * a foundry from before sidecars, or one whose sidecar was swept. Resuming is
   * correctness-safe (the bank is keyed by page, and a banked answer is a true
   * answer for its page whatever the run around it was asked), and discarding
   * would throw away GPU-minutes on no evidence at all.
   */
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const pending = pendingOf(readingsPath, [1, 2], { skipPages: [], language: 'de' });
  fs.rmSync(pendingRequestPath(readingsPath));

  const outcome = openReadingsBank({
    readingsPath, freshRequested: false, reuseRequested: false, ask: { skipPages: [9] },
  });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.pendingPath, pending);
  assert.equal(outcome.readings.size, 2);
  // And the debris can account for itself again: this run wrote the sidecar it
  // found missing, so the next kill is one the run after can reason about.
  assert.deepEqual(readPendingRequest(readingsPath)?.skipPages, [9]);
});

test('a sidecar that will not parse is refused, and the refusal names both ways out', () => {
  // "There is a file here I cannot read" and "no claim was made" are different
  // facts, and one of the two guesses about them deletes somebody's reading.
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  pendingOf(readingsPath, [1], { skipPages: [], language: 'de' });
  fs.writeFileSync(pendingRequestPath(readingsPath), '{ this is not json', 'utf8');

  assert.throws(
    () => openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false }),
    (err: unknown) => {
      assert.ok(err instanceof VlmReadingsError);
      assert.match(err.message, /is not JSON/);
      assert.match(err.message, /Delete that one file to resume the pending anyway/);
      assert.match(err.message, /--fresh-readings/);
      return true;
    },
  );
  // Refused means refused: the pending is still there to be resumed by hand.
  assert.equal(VlmReadings.open(pendingPath(readingsPath)).size, 1);
});

test('a sidecar missing its fields is refused rather than half-believed', () => {
  const readingsPath = runDir([1]);
  markComplete(readingsPath, 1);
  pendingOf(readingsPath, [1], { skipPages: [], language: 'de' });
  fs.writeFileSync(pendingRequestPath(readingsPath), JSON.stringify({ model: 'dots-ocr' }), 'utf8');

  assert.throws(() => readPendingRequest(readingsPath), (err: unknown) => {
    assert.ok(err instanceof VlmReadingsError);
    assert.match(err.message, /not a pending readings request/);
    return true;
  });
});

test('a sidecar with no pending beside it is swept — it is a claim about nothing', () => {
  const readingsPath = runDir([1, 2]);
  writePendingRequest(readingsPath, { skipPages: [7], language: 'de' });

  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.pendingPath, null);
  assert.equal(fs.existsSync(pendingRequestPath(readingsPath)), false);
});

test('discarding a pending takes the sidecar with it and leaves the bank alone', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  pendingOf(readingsPath, [1], { skipPages: [], language: 'de' });

  discardPending(readingsPath);

  assert.equal(fs.existsSync(pendingPath(readingsPath)), false);
  assert.equal(fs.existsSync(pendingRequestPath(readingsPath)), false);
  assert.equal(VlmReadings.open(readingsPath).size, 3);
  assert.equal(readCompletionMarker(readingsPath)?.pages, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// The swap, and every gap a crash can land in
//
// The order is: delete the old marker, rename the pending over the bank, remove
// the sidecar, write the fresh marker. Each test below stages on disk exactly
// what a crash between two of those steps leaves, and proves the next run heals
// it without reading a page.
// ─────────────────────────────────────────────────────────────────────────────

test('the swap: the pending becomes the bank and the marker is the new run\'s', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const pending = pendingOf(readingsPath, [1, 2, 3, 4], { skipPages: [], language: 'de' });

  const marker = swapPendingIntoPlace(readingsPath, pending, completionOf(readingsPath, 4));

  const bank = VlmReadings.open(readingsPath);
  assert.equal(bank.size, 4);
  assert.equal(bank.get(1)?.text, 'page 1, again');
  assert.equal(marker.completedAt, '2026-08-09T10:00:00.000Z');
  assert.equal(readCompletionMarker(readingsPath)?.pages, 4);
  // The gamble's files are gone: the pending is the bank now, and the sidecar
  // was a claim about a file that no longer exists.
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.existsSync(pendingRequestPath(readingsPath)), false);
  // One bank and one marker, and nothing else — the replaced reading is gone
  // because its replacement exists, which is the whole of the amended rule.
  assert.deepEqual(listing(readingsPath), ['readings.completed.json', 'readings.jsonl']);
});

test('with no pending the swap is exactly what it always was: the marker is written', () => {
  const readingsPath = runDir([1, 2]);
  const marker = swapPendingIntoPlace(readingsPath, null, completionOf(readingsPath, 2));

  assert.equal(marker.pages, 2);
  assert.equal(readCompletionMarker(readingsPath)?.completedAt, '2026-08-09T10:00:00.000Z');
  assert.equal(VlmReadings.open(readingsPath).size, 2);
});

test('a swap whose pending is not there refuses rather than emptying the bank', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);

  assert.throws(
    () => swapPendingIntoPlace(readingsPath, pendingPath(readingsPath), completionOf(readingsPath, 3)),
    (err: unknown) => {
      assert.ok(err instanceof VlmReadingsError);
      assert.match(err.message, /there is nothing to put in place of/);
      return true;
    },
  );
  // The finished reading is exactly as it was found, marker and all.
  assert.equal(VlmReadings.open(readingsPath).size, 3);
  assert.equal(readCompletionMarker(readingsPath)?.pages, 3);
});

test('CRASH AFTER STEP 1 — old bank, no marker, complete pending: the swap is retried', () => {
  /*
   * The debris of a run killed between deleting the old marker and renaming its
   * pending into place. Without the pending beating the marker, this reads as
   * "an interrupted bank" and the finished replacement sitting beside it is
   * abandoned — seventeen pages of GPU thrown away by a rule about a file that
   * is not the one in question.
   */
  const readingsPath = runDir([1, 2, 3]);
  const ask: ReadingsAsk = { skipPages: [], language: 'de', model: 'dots-ocr' };
  const pending = pendingOf(readingsPath, [1, 2, 3], ask);
  fs.rmSync(completionMarkerPath(readingsPath), { force: true });

  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false, ask });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.pendingPath, pending);
  // NOT ONE PAGE IS MISSING, so the run reads nothing and goes straight to its end.
  assert.deepEqual(outcome.readings.pages(), [1, 2, 3]);

  const marker = swapPendingIntoPlace(readingsPath, outcome.pendingPath, completionOf(readingsPath, 3));
  assert.equal(marker.pages, 3);
  assert.equal(VlmReadings.open(readingsPath).get(2)?.text, 'page 2, again');
  assert.equal(fs.existsSync(pending), false);
});

test('CRASH AFTER STEP 2 — new bank, no marker: it completes instantly and marks itself', () => {
  /*
   * The rename landed and the process died before the fresh marker. What is on
   * disk is the new reading with no marker, which reads as an interrupted run
   * with nothing missing: no page is read, and the next completion writes the
   * marker that was owed.
   */
  const readingsPath = runDir([1, 2, 3]);
  const outcome = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false });

  assert.equal(outcome.action, 'resume');
  assert.equal(outcome.pendingPath, null);
  assert.deepEqual(outcome.readings.pages(), [1, 2, 3]);

  swapPendingIntoPlace(readingsPath, outcome.pendingPath, completionOf(readingsPath, 3));
  assert.equal(readCompletionMarker(readingsPath)?.pages, 3);
  assert.equal(VlmReadings.open(readingsPath).size, 3);
});

test('CRASH BETWEEN THE RENAME AND THE SIDECAR: the orphan is swept and nothing else moves', () => {
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  writePendingRequest(readingsPath, { skipPages: [4], language: 'de' });

  const outcome = openReadingsBank({
    readingsPath, freshRequested: false, reuseRequested: false, ask: { skipPages: [4], language: 'de' },
  });

  // A brand-new gamble, not a resume of a pending that is not there — and the
  // stale sidecar was replaced rather than mistaken for this one's.
  assert.equal(outcome.action, 'read-fresh');
  assert.equal(outcome.pendingPath, pendingPath(readingsPath));
  assert.equal(outcome.readings.size, 0);
  assert.equal(VlmReadings.open(readingsPath).size, 3);
});

test('A RUN THAT DIES LEAVES THE PROJECT AS IT FOUND IT, and the retry pays for one page', () => {
  /*
   * The failure in BANK-LIFECYCLE §1, fact 1, end to end on the filesystem: a
   * re-read of a finished 3-page reading dies after page 2. Before the pending
   * bank the finished reading was already in `archived-<stamp>/` and the project
   * was worse off for having tried; now nothing happened, and page 2's answer is
   * waiting for the retry.
   */
  const readingsPath = runDir([1, 2, 3]);
  markComplete(readingsPath, 3);
  const ask: ReadingsAsk = { skipPages: [], language: 'de', model: 'dots-ocr' };

  const first = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false, ask });
  first.readings.append({ page: 1, text: 'page 1, again', tokens: 1, finishReason: 'stop', seconds: 1 });
  first.readings.append({ page: 2, text: 'page 2, again', tokens: 1, finishReason: 'stop', seconds: 1 });
  // ...and the process dies here.

  const bank = VlmReadings.open(readingsPath);
  assert.equal(bank.size, 3);
  assert.equal(bank.get(1)?.text, 'page 1');
  assert.equal(readCompletionMarker(readingsPath)?.pages, 3);
  assert.deepEqual(listing(readingsPath).filter((e) => e.startsWith('archived-')), []);

  // The retry: two pages already paid for, one to go.
  const second = openReadingsBank({ readingsPath, freshRequested: false, reuseRequested: false, ask });
  assert.equal(second.action, 'resume');
  assert.deepEqual(second.readings.pages(), [1, 2]);
  second.readings.append({ page: 3, text: 'page 3, again', tokens: 1, finishReason: 'stop', seconds: 1 });

  swapPendingIntoPlace(readingsPath, second.pendingPath, completionOf(readingsPath, 3));

  const replaced = VlmReadings.open(readingsPath);
  assert.equal(replaced.size, 3);
  assert.equal(replaced.get(1)?.text, 'page 1, again');
  assert.equal(readCompletionMarker(readingsPath)?.completedAt, '2026-08-09T10:00:00.000Z');
  // One bank, one marker, and no hoard of the readings it replaced.
  assert.deepEqual(
    listing(readingsPath).filter((e) => e.startsWith('archived-') || e.includes('.pending')),
    [],
  );
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

test('a bank and a marker a shell rewrote — BOM and all — still read', () => {
  /*
   * A bank is GPU-hours on disk. PowerShell's `>` and `Set-Content -Encoding
   * utf8` both put U+FEFF on the front of a file, and JSON.parse refuses one —
   * so a bank somebody copied through the one shell that ships with Windows
   * would have condemned its own first line as "not a readings file", and a
   * marker beside it would have read as a file this program did not write. See
   * src/bom.ts.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-readings-bom-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  fs.writeFileSync(
    readingsPath,
    '\uFEFF{"page":1,"text":"first","tokens":9,"finishReason":"stop","seconds":1}\n'
    + '{"page":2,"text":"second","tokens":9,"finishReason":"stop","seconds":1}\n',
    'utf8',
  );
  const readings = VlmReadings.open(readingsPath);
  assert.equal(readings.size, 2);
  // The FIRST line is the one at risk, and it is a page that cost real GPU.
  assert.equal(readings.get(1)!.text, 'first');

  fs.writeFileSync(
    completionMarkerPath(readingsPath),
    `\uFEFF${JSON.stringify({
      completedAt: '2026-01-01T00:00:00.000Z',
      outPath: null,
      pages: 2,
      foundryVersion: VERSION,
    })}`,
    'utf8',
  );
  assert.equal(readCompletionMarker(readingsPath)?.pages, 2);
});
