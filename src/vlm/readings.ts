/**
 * vlm/readings — the answers, on disk, one JSON object per line.
 *
 * A book read by a vision model costs minutes of GPU per dozen pages, and the
 * one thing that must never happen is paying for a page twice. So `--readings`
 * names a file, every answer is appended and FSYNCED the moment it exists, and
 * a run that starts against an existing file reads only the pages that are not
 * in it. A kill costs the page that was in flight.
 *
 * It is a CACHE OF ANSWERS, not a cache of books. Nothing downstream is skipped
 * because of it: the pages are still rendered, still parsed, still assembled,
 * so a fix to the dialect or the assembler is re-run for free over answers that
 * cost an hour. That is the same distinction the pipeline draws between a
 * cached stage and an input read off disk.
 *
 * The file is keyed by page number and nothing else — it belongs to one PDF,
 * and pointing it at a second one is the caller naming the wrong file.
 *
 * RESUMING AN INTERRUPTED RUN AND REPLAYING A FINISHED ONE ARE NOT THE SAME
 * THING, and until the completion marker below existed this file could not tell
 * them apart. A bank left behind by a kill is a debt to be paid off, so the next
 * run pays only for the pages that are missing. A bank left behind by a run that
 * WROTE ITS EPUB is a finished piece of work, and somebody who asks for that
 * conversion again is asking for the pages to be read again — answering them out
 * of the bank obeys nobody's instruction and does no work. So a completed run
 * drops `completed.json` beside its readings, and the next run reads that marker
 * before it reads a page.
 *
 * THE BANK IS NEVER DESTROYED UNTIL ITS REPLACEMENT EXISTS.
 *
 * The rule used to be stated more absolutely and kept worse: "start over" rotated
 * the whole bank into `archived-<timestamp>/` and left it there, which sounds
 * like the safest thing possible and meant that A RE-READ ARCHIVED A FINISHED
 * BOOK BEFORE IT HAD READ A SINGLE PAGE. A run that then died at page 9 of 17
 * left the project worse off for having tried: the finished reading was gone from
 * where everything looks for it, sitting under a timestamped name nobody goes
 * looking for, and every re-read left another hoard beside the last one.
 *
 * So a run that would replace a finished bank writes its answers into a PENDING
 * BANK beside the real one and swaps it into place — one rename — only when the
 * run has actually finished. A dead run leaves the finished bank exactly where it
 * was and its own half-read replacement beside it as resumable debris. Nothing is
 * lost by trying, nothing accumulates, and the failure mode above becomes:
 * nothing happened, and page 9's answer is waiting for the retry.
 *
 * SWAP-AND-DESTROY IS FOR MACHINE OUTPUT AND ONLY FOR IT. The old bank is
 * destroyed by the rename, deliberately: it is an answer a machine can produce
 * again at a price, and its replacement is on disk and complete before it goes.
 * ARCHIVES FOREVER ARE FOR LABOUR — what a person struck, retyped and laid out is
 * kept whatever it costs to keep, which is the retention rule as the app states
 * it (`RETENTION_OF`, `app/shared/ledger.ts`). A directory full of
 * `archived-<stamp>/` banks is not that rule being honoured; it is GPU output
 * being hoarded under it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { ensureDir } from '../fsdirs.js';
import { VERSION } from '../version.js';

/**
 * One page's answer, and everything that was true about the asking.
 *
 * The first five fields are what the pipeline reads and have not moved. The rest
 * exist because of a rule this file learned late: EVERYTHING THE MODEL RETURNED
 * IS KEPT, and so is everything needed to interpret it. The bank is the record
 * of the expensive half of a conversion, and a record that only holds the fields
 * today's code happens to read is a record that has to be paid for again the
 * first time somebody asks a question nobody thought of.
 *
 * Every added field is OPTIONAL, and that is not politeness — banks written
 * before them exist on disk right now, they cost hours of GPU, and they must
 * keep opening and keep rendering books. Absence means "this run did not record
 * it", never "there was none".
 */
export interface VlmReading {
  page: number;
  text: string;
  tokens: number;
  finishReason: string | null;
  seconds: number;
  /**
   * The server's whole decoded answer, verbatim and untrimmed.
   *
   * `text` above is `choices[0].message.content` with the whitespace taken off
   * — the one field the dialects read — and everything else the server said
   * about the answer used to be dropped on the floor at the seam in
   * `endpoint.ts`: the full usage split, the model id the server actually
   * served, the response id, the logprobs a server was asked for, whatever a
   * particular vLLM build adds. None of it can be recovered later, because the
   * page would have to be read again to get it, and reading the page again is
   * the one thing this file exists to avoid. So the body is banked as it
   * arrived, beside the fields parsed out of it, and nothing normalises what is
   * inside it.
   *
   * ABSENT ON THE MLX ROUTE, and that is an absence with nothing behind it: the
   * helper's page event carries `number, width, height, renderSeconds, seconds,
   * chars, tokens, finishReason, skipped, text` (see `vlm_page.py`), and every
   * one of those is already a field here. There is no residue to keep.
   */
  response?: unknown;
  /**
   * The page render the model was shown, in pixels, at the run's pinned dpi.
   *
   * The boxes in a geometric answer are in a frame derived from this and
   * `maxPixels`, so without the pair the answer cannot be turned back into
   * blocks from the bank ALONE — which is exactly what a curation surface wants
   * to do, and what re-deriving the geometry costs a PDF and a rasteriser to do
   * instead (`blocks-dump.ts`).
   */
  render?: { width: number; height: number };
  /** The processor's pixel budget this page's boxes were measured in. */
  maxPixels?: number;
  /**
   * The model that answered, as `models.ts` names it.
   *
   * The registry id rather than the repo or the name a server was started with,
   * because the id is what determines the DIALECT the answer has to be parsed in
   * and the budget it was measured under. A bank whose pages do not say which
   * dialect they are written in is a bank that can only be read by the command
   * line that made it.
   */
  model?: string;
}

/** A banked render size, or something that is not one. Both numbers or nothing. */
function isRenderSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== 'object' || value === null) return false;
  const size = value as { width?: unknown; height?: unknown };
  return typeof size.width === 'number' && typeof size.height === 'number';
}

export class VlmReadingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmReadingsError';
  }
}

export class VlmReadings {
  private readonly byPage = new Map<number, VlmReading>();

  private constructor(private readonly filePath: string) {}

  /**
   * Open a readings file, reading whatever is already in it.
   *
   * A malformed LAST line is an interrupted append and is dropped; a malformed
   * line anywhere else is a file this program did not write, and it fails
   * naming the line. The difference matters: the first is the normal
   * consequence of a kill, and the second is a wrong `--readings` path about to
   * silently supply somebody else's pages.
   */
  static open(filePath: string): VlmReadings {
    const readings = new VlmReadings(path.resolve(filePath));
    if (!fs.existsSync(readings.filePath)) return readings;
    // The mark comes off the front of the FILE, not the front of a record: a
    // bank a script copied through PowerShell arrives with one, and it would
    // make the first line — a perfectly good answer that cost GPU-minutes —
    // read as "this file is not a readings file" (`bom.ts`).
    const lines = stripBom(fs.readFileSync(readings.filePath, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const last = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (last) break;
        throw new VlmReadingsError(
          `${readings.filePath}, line ${index + 1} is not JSON `
          + `(${err instanceof Error ? err.message : String(err)}). This file is not a readings file.`,
        );
      }
      const record = parsed as Partial<VlmReading>;
      if (typeof record.page !== 'number' || typeof record.text !== 'string') {
        throw new VlmReadingsError(
          `${readings.filePath}, line ${index + 1} carries no page and text. This file is not a readings file.`,
        );
      }
      /*
       * The two required fields are checked above and everything else is taken
       * as it lies. A line written before `response`, `render`, `maxPixels` and
       * `model` existed is a complete record of the answer it banked — those
       * fields are things a run KNEW and did not write down, not things a page
       * failed to have — so a bank that predates them opens, resumes and
       * re-renders exactly as it always did. Nothing is invented to fill a gap:
       * an absent render is absent, and whatever wants one goes and derives it.
       */
      readings.byPage.set(record.page, {
        page: record.page,
        text: record.text,
        tokens: record.tokens ?? 0,
        finishReason: record.finishReason ?? null,
        seconds: record.seconds ?? 0,
        ...(record.response !== undefined ? { response: record.response } : {}),
        ...(isRenderSize(record.render) ? { render: record.render } : {}),
        ...(typeof record.maxPixels === 'number' ? { maxPixels: record.maxPixels } : {}),
        ...(typeof record.model === 'string' ? { model: record.model } : {}),
      });
    }
    return readings;
  }

  get size(): number {
    return this.byPage.size;
  }

  /**
   * The banked geometry for a page, or null where the run that wrote it did not
   * record any.
   *
   * A pair, because half of it is useless: the boxes were measured in a frame
   * `smartResize` computes from BOTH the render and the budget, and a render
   * paired with a guessed budget is a scale that is quietly a few per cent wrong
   * — the one failure `dots.ts` says is invisible in the text and wrong in every
   * picture crop. So a record carrying one and not the other reads as carrying
   * neither, and whatever wanted it goes and derives both from the PDF.
   */
  geometry(page: number): { render: { width: number; height: number }; maxPixels: number } | null {
    const reading = this.byPage.get(page);
    if (reading?.render === undefined || reading.maxPixels === undefined) return null;
    return { render: reading.render, maxPixels: reading.maxPixels };
  }

  has(page: number): boolean {
    return this.byPage.has(page);
  }

  get(page: number): VlmReading | undefined {
    return this.byPage.get(page);
  }

  pages(): number[] {
    return [...this.byPage.keys()].sort((a, b) => a - b);
  }

  /** Append and fsync. The whole point is that a kill costs one page. */
  append(reading: VlmReading): void {
    this.byPage.set(reading.page, reading);
    ensureDir(path.dirname(this.filePath));
    const handle = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(reading)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The completion marker
//
// One file, beside the readings, written only when an EPUB reached the disk.
// Its presence is the whole difference between "this run was killed" and "this
// run finished", and that difference decides whether the next invocation pays
// for the book again.
// ─────────────────────────────────────────────────────────────────────────────

/** What a finished run records about itself. Every field is a fact, none is a default. */
export interface VlmCompletion {
  /** When the run finished. ISO 8601, UTC. */
  completedAt: string;
  /**
   * The document that run produced, absolute — and NULL where it produced none.
   *
   * Null is `foundry vlm-read`: a run whose whole product is the bank this
   * marker sits beside. It could have been left out, or filled in with the
   * bank's own path, and both would have been a marker that says something
   * untrue about what happened. The field means "what was written HERE", and a
   * reading writes no document, so it says so.
   *
   * MARKERS WRITTEN BEFORE THAT WAS POSSIBLE ALL CARRY A PATH, and they still
   * read: the reader below accepts a string or a null and refuses only a field
   * that is missing entirely, which is a marker this program did not write.
   */
  outPath: string | null;
  /** Pages the run was about — not the size of the bank. */
  pages: number;
  /** The foundry that wrote it, so a marker can be traced to a build. */
  foundryVersion: string;
  /**
   * The book's language, as the run was told it. Absent where nobody said.
   *
   * Recorded rather than used. It is `dc:language` on a document and a reading
   * writes no document — but the person who ordered the reading knew it, and the
   * step that renders the book out of this bank is a separate invocation that
   * would otherwise have to be told a second time. It is written down here where
   * that step can find it, and nothing in this program reads it back yet.
   */
  language?: string;
}

/**
 * The marker for THIS bank: `<bank>.completed.json`, beside it and named for it.
 *
 * IT USED TO BE `completed.json` IN THE BANK'S DIRECTORY, on the reading that a
 * readings file's directory is the run's directory. That holds when a run owns
 * its folder and is false the moment two books share one — which is exactly what
 * the app did, banking every book into a single `readings/` directory. Measured
 * on a real install: one marker, stamped by whichever conversion finished last,
 * sitting beside two banks. Asked about the OTHER book, `readCompletionMarker`
 * answered with the first book's marker and the run archived a complete bank and
 * read a hundred pages again — the exact GPU-hours loss the bank exists to stop.
 * Nothing compared the marker's `outPath` to the run's; nothing had to, because
 * the path was assumed to name it.
 *
 * Naming the marker after the bank makes the pairing structural. A pre-existing
 * `completed.json` is now simply not found, which degrades safely in the one way
 * that matters: no marker plus a full bank is a RESUME, and a resume with
 * nothing missing reads no pages and costs no GPU.
 */
export function completionMarkerPath(readingsPath: string): string {
  const resolved = path.resolve(readingsPath);
  return `${resolved.replace(/\.jsonl$/i, '')}.completed.json`;
}

/**
 * The marker, or null where there is none.
 *
 * A marker that does not parse, or that carries none of its fields, THROWS. It
 * is not treated as absent: "there is a file here I cannot read" and "this run
 * was killed" are different facts, and quietly reading the second out of the
 * first is how a finished conversion gets replayed out of a cache again.
 */
export function readCompletionMarker(readingsPath: string): VlmCompletion | null {
  const markerPath = completionMarkerPath(readingsPath);
  if (!fs.existsSync(markerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(markerPath, 'utf8')));
  } catch (err) {
    throw new VlmReadingsError(
      `${markerPath} is not JSON (${err instanceof Error ? err.message : String(err)}). `
      + 'It is where a finished conversion records itself, so this run cannot tell whether the '
      + 'readings beside it are a finished book or an interrupted one.',
    );
  }
  const record = parsed as Partial<VlmCompletion>;
  // `outPath: null` is a reading — a run that produced no document (`vlm-read`).
  // ABSENT is a different thing and is still refused: a marker that does not say
  // what it produced, one way or the other, is not one this program wrote.
  const outPath = record.outPath ?? null;
  if (
    typeof record.completedAt !== 'string'
    || !('outPath' in (record as object))
    || (outPath !== null && typeof outPath !== 'string')
    || typeof record.pages !== 'number'
    || typeof record.foundryVersion !== 'string'
  ) {
    throw new VlmReadingsError(
      `${markerPath} carries no completedAt, outPath, pages and foundryVersion. `
      + 'This file is not a vlm-convert completion marker.',
    );
  }
  return {
    completedAt: record.completedAt,
    outPath,
    pages: record.pages,
    foundryVersion: record.foundryVersion,
    ...(typeof record.language === 'string' ? { language: record.language } : {}),
  };
}

/** Write the marker atomically — temp file beside the target, then rename. */
export function writeCompletionMarker(
  readingsPath: string,
  completion: Omit<VlmCompletion, 'foundryVersion'>,
): VlmCompletion {
  const record: VlmCompletion = { ...completion, foundryVersion: VERSION };
  const markerPath = completionMarkerPath(readingsPath);
  ensureDir(path.dirname(markerPath));
  const tmp = `${markerPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, markerPath);
  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pending bank
//
// A reading in progress that is not allowed to destroy the reading already
// there. Two files, both named for the bank they are about:
//
//   readings/<key>.jsonl                  the bank every step names
//   readings/<key>.jsonl.pending          the gamble in progress
//   readings/<key>.jsonl.pending.request  what the gamble was asked for
//   readings/<key>.completed.json         the marker, unchanged
//
// SUFFIXED RATHER THAN RENAMED — `<key>.jsonl.pending`, not `<key>.pending.jsonl`
// — so that a pending file can never be mistaken for a bank by anything that
// globs for `*.jsonl`, and so that the pair sorts next to the bank it belongs to
// in any listing a person opens.
// ─────────────────────────────────────────────────────────────────────────────

/** `<bank>.jsonl.pending`. */
export function pendingPath(readingsPath: string): string {
  return `${path.resolve(readingsPath)}.pending`;
}

/** `<bank>.jsonl.pending.request` — the sidecar, named for the pending it describes. */
export function pendingRequestPath(readingsPath: string): string {
  return `${pendingPath(readingsPath)}.request`;
}

/**
 * What a pending bank was asked for, as the run that opened it was told.
 *
 * Two piles, and which pile a field is in is the whole design of this file. See
 * `sameAsk`.
 */
export interface PendingRequest {
  /** Pages the run was told are not part of the book. Sorted, deduplicated. IDENTITY. */
  skipPages: number[];
  /** The book's language as the run was told it, or null where nobody said. IDENTITY. */
  language: string | null;
  /** The model that was reading, as `models.ts` names it. RECORDED FACT, never compared. */
  model: string | null;
  /** The foundry that opened the pending, so debris can be traced to a build. */
  foundryVersion: string;
}

/** What a run was asked for, in the shape the caller already has it. */
export interface ReadingsAsk {
  skipPages?: readonly number[];
  language?: string;
  model?: string;
}

/** The ask as it goes on disk: sorted, deduplicated, absences written as null. */
function normaliseAsk(ask: ReadingsAsk): Omit<PendingRequest, 'foundryVersion'> {
  return {
    skipPages: [...new Set(ask.skipPages ?? [])].sort((a, b) => a - b),
    language: ask.language ?? null,
    model: ask.model ?? null,
  };
}

/**
 * Is the pending on disk an answer to the question THIS run is asking?
 *
 * IDENTITY IS `skipPages` AND `language`, AND NOTHING ELSE — the same split the
 * ledger makes, stated in one place and obeyed in two. `PARAMS_OF.read` minus
 * `MINTED_BY_THE_RUN.read` (`app/shared/ledger.ts`) is exactly those two fields:
 * they are WHAT THE PERSON ASKED FOR, while `generation` and `pages` are what the
 * run stamped on its own answer. A step is re-run rather than branched on the
 * same comparison, so the app deciding "this replaces the reading" and the engine
 * deciding "this continues the pending" cannot come apart.
 *
 * THE MODEL ID IS RECORDED AND NOT COMPARED, for the same reason `pages` is
 * minted rather than asked: nobody chooses it per run in the app. It is in the
 * sidecar so that a pending nobody can account for can be traced to a build and a
 * model, which is the only useful thing to know about debris.
 */
export function sameAsk(request: PendingRequest, ask: ReadingsAsk): boolean {
  const asked = normaliseAsk(ask);
  return request.language === asked.language
    && request.skipPages.length === asked.skipPages.length
    && request.skipPages.every((page, index) => page === asked.skipPages[index]);
}

/**
 * The sidecar, or null where there is none.
 *
 * A SIDECAR THAT IS NOT THERE IS NOT AN ERROR AND A SIDECAR THAT WILL NOT PARSE
 * IS, and the difference decides what happens to somebody's half-read book.
 *
 * Absent means no claim was made about what the pending answers — a pending
 * written by a foundry from before sidecars existed, or one whose sidecar was
 * swept. The caller resumes it, because resuming is correctness-safe (the bank is
 * keyed by page, and a banked answer is a true answer for its page whatever the
 * run around it was asked) and discarding it would throw away GPU-minutes on no
 * evidence at all.
 *
 * Unparseable means there IS a claim here and it cannot be read, which is the
 * same distinction `readCompletionMarker` draws and refuses on. Believing either
 * answer would be guessing about a file this program wrote, and one of the two
 * guesses deletes a reading, so it refuses and names the way out.
 */
export function readPendingRequest(readingsPath: string): PendingRequest | null {
  const requestPath = pendingRequestPath(readingsPath);
  if (!fs.existsSync(requestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(requestPath, 'utf8')));
  } catch (err) {
    throw new VlmReadingsError(
      `${requestPath} is not JSON (${err instanceof Error ? err.message : String(err)}). It is `
      + 'where a half-finished reading records what it was asked for, so this run cannot tell '
      + 'whether the pending bank beside it answers the same question. Delete that one file to '
      + 'resume the pending anyway, or pass --fresh-readings to throw the pending away and start '
      + 'the replacement over.',
    );
  }
  const record = parsed as Partial<PendingRequest>;
  if (
    !Array.isArray(record.skipPages)
    || record.skipPages.some((page) => typeof page !== 'number')
    || !('language' in (record as object))
    || (record.language !== null && typeof record.language !== 'string')
  ) {
    throw new VlmReadingsError(
      `${requestPath} carries no skipPages and language. This file is not a pending readings `
      + 'request. Delete it to resume the pending bank beside it anyway, or pass --fresh-readings '
      + 'to throw that pending away and start the replacement over.',
    );
  }
  return {
    skipPages: [...record.skipPages].sort((a, b) => a - b),
    language: record.language ?? null,
    model: typeof record.model === 'string' ? record.model : null,
    foundryVersion: typeof record.foundryVersion === 'string' ? record.foundryVersion : '',
  };
}

/** Write the sidecar atomically — temp file beside the target, then rename. */
export function writePendingRequest(readingsPath: string, ask: ReadingsAsk): PendingRequest {
  const record: PendingRequest = { ...normaliseAsk(ask), foundryVersion: VERSION };
  const requestPath = pendingRequestPath(readingsPath);
  ensureDir(path.dirname(requestPath));
  const tmp = `${requestPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, requestPath);
  return record;
}

/**
 * Throw the pending away — the file and its sidecar, deleted rather than archived.
 *
 * THE ONE PLACE THIS FILE DESTROYS ANSWERS, and the case is narrow: a pending is
 * INCOMPLETE MACHINE OUTPUT WHOSE COMPLETION NOBODY WANTS ANY MORE. It is reached
 * when the user changed the question — which is them saying the half-answer to
 * the old question is not worth finishing — or asked outright for the replacement
 * to start over. Keeping it would mean an `archived-<stamp>/` full of fragments
 * of readings that were never finished and can never be resumed, which is the
 * hoard this file's header is about, made of the least valuable thing on disk.
 */
export function discardPending(readingsPath: string): void {
  fs.rmSync(pendingPath(readingsPath), { force: true });
  fs.rmSync(pendingRequestPath(readingsPath), { force: true });
}

/**
 * The swap: the pending becomes the bank, and the run is recorded as finished.
 *
 * THE ORDER IS THE DESIGN, and it is chosen for what a crash between any two
 * steps leaves behind:
 *
 *   1. delete the old completion marker
 *   2. rename the pending over the real bank — the old bank dies by the rename
 *   3. remove the sidecar, which is now about a file that no longer exists
 *   4. write the fresh marker
 *
 * Died after 1: old bank, no marker, a complete pending. The next run finds the
 * pending, matches the request, resumes it, discovers nothing missing and retries
 * this swap. Died after 2 or 3: the new bank in place with no marker, which reads
 * as an interrupted run with no pages missing — it completes instantly and writes
 * the marker. Both gaps heal themselves and neither reads a page.
 *
 * STEP 1 IS FIRST AND IS NOT OPTIONAL. The one sequence that is not safe is
 * renaming the bank while the old marker still stands: for the length of that
 * window a NEW bank sits under an OLD marker, and a run arriving in it replays a
 * completion that was never about these answers.
 *
 * `pending === null` is a run that was writing into the real bank all along —
 * a first read, or a resume of an interrupted one — and for it this is exactly
 * what it always was: write the marker. THE CALLER PASSES WHAT IT ACTUALLY WROTE
 * TO, never a path recomputed here, because a pending on disk that THIS run did
 * not open belongs to somebody else's interrupted attempt and renaming it over a
 * good bank would be this whole file's failure with an extra step.
 */
export function swapPendingIntoPlace(
  readingsPath: string,
  pending: string | null,
  completion: Omit<VlmCompletion, 'foundryVersion'>,
): VlmCompletion {
  const resolved = path.resolve(readingsPath);
  if (pending === null) return writeCompletionMarker(resolved, completion);

  const pendingResolved = path.resolve(pending);
  if (!fs.existsSync(pendingResolved)) {
    throw new VlmReadingsError(
      `${pendingResolved} was this run's reading and it is not there, so there is nothing to put in `
      + `place of ${resolved}. The bank that is there has been left exactly as it was found: `
      + 'replacing a book somebody paid for with a file that does not exist is the one thing the '
      + 'pending bank exists to make impossible.',
    );
  }

  fs.rmSync(completionMarkerPath(resolved), { force: true });
  ensureDir(path.dirname(resolved));
  fs.renameSync(pendingResolved, resolved);
  fs.rmSync(`${pendingResolved}.request`, { force: true });
  return writeCompletionMarker(resolved, completion);
}

// ─────────────────────────────────────────────────────────────────────────────
// What this run does about the bank it found
// ─────────────────────────────────────────────────────────────────────────────

export type ReadingsBankAction =
  /** Every page is read from the model. Nothing that was here has been touched. */
  | 'read-fresh'
  /** An interrupted run's missing pages are read; the banked ones are not. */
  | 'resume'
  /** A finished run's answers are replayed, by request. No page is read. */
  | 'reuse';

export interface ReadingsBankOutcome {
  action: ReadingsBankAction;
  /** The bank this run will answer out of AND APPEND TO. Empty for `read-fresh`. */
  readings: VlmReadings;
  /**
   * The pending file this run is writing into, or null where it writes the bank
   * directly.
   *
   * The run carries this to its own end and hands it back to
   * `swapPendingIntoPlace`, which is what makes the swap impossible to fire over
   * a pending this run did not open.
   */
  pendingPath: string | null;
  /** ONE sentence, printed by the run. Never empty — every decision is stated. */
  sentence: string;
}

export interface ReadingsBankRequest {
  readingsPath: string;
  /**
   * `--fresh-readings`: read every page again, and do not continue a pending.
   *
   * IT NO LONGER MEANS "ARCHIVE". The flag has always meant "read the book
   * again", and archiving was only ever how that was implemented; the pending
   * bank does it without destroying anything. What it means ON TOP of the
   * ordinary re-read is the one thing nothing else can say: throw away the
   * half-finished replacement and start it over.
   */
  freshRequested: boolean;
  /** `--reuse-readings`: answer out of the bank even though a run completed. */
  reuseRequested: boolean;
  /**
   * What this run was asked for — written to the sidecar, and compared with the
   * sidecar of a pending that is already there. See `sameAsk`.
   */
  ask?: ReadingsAsk;
}

/** An ask in words, for the sentence that says a pending was thrown away. */
function describeAsk(skipPages: readonly number[], language: string | null): string {
  return `${skipPages.length === 0 ? 'no skipped pages' : `pages ${skipPages.join(', ')} skipped`}`
    + `, ${language === null ? 'no language named' : `language ${language}`}`;
}

/**
 * Decide what to do with the readings beside this run, do it, and say so.
 *
 * The whole rule, in one place because it is one decision:
 *
 *   nothing banked            → read every page into the bank. Nothing to protect.
 *   banked, no marker         → RESUME the bank itself. The partial bank IS the
 *                               debt; there is no finished copy at risk, and the
 *                               debt is paid off, never re-paid.
 *   completed + nothing asked → PENDING. A person who orders a conversion that
 *                               already finished is ordering the work, not a
 *                               replay of it — but the finished reading stays
 *                               exactly where it is until the new one lands.
 *   completed + --reuse       → replay the bank. The deliberate free reconvert:
 *                               iterate on the assembler over known-good answers.
 *   banked + --fresh          → PENDING, marker or no marker. The explicit form,
 *                               for a caller whose own records know the
 *                               conversion finished — a bank written before
 *                               markers existed carries no marker.
 *   a pending is already here → continue it if it answers the same question,
 *                               throw it away and start over if it does not, and
 *                               throw it away and start over under --fresh.
 *
 * A PENDING FOUND ON DISK BEATS THE MARKER, and that is not an ordering
 * preference — it is what makes the crash gaps in `swapPendingIntoPlace` heal. A
 * run that died between deleting the old marker and renaming its pending into
 * place leaves a complete pending beside an unmarked bank, and the only reading
 * of that debris that costs nobody a page is "finish what was started".
 *
 * `--reuse-readings` NEVER OPENS A PENDING and never touches one that is there.
 * It reads nothing, so it has nothing to protect the bank from, and a pending
 * beside it belongs to an attempt that is none of its business.
 *
 * `--reuse-readings` against an EMPTY bank throws. There is nothing to reuse, and
 * silently reading the whole book instead would spend hours of GPU on an
 * instruction that said not to.
 */
export function openReadingsBank(request: ReadingsBankRequest): ReadingsBankOutcome {
  if (request.freshRequested && request.reuseRequested) {
    throw new VlmReadingsError(
      '--fresh-readings and --reuse-readings say opposite things about the same bank. Pass one.',
    );
  }
  const readingsPath = path.resolve(request.readingsPath);
  const ask = request.ask ?? {};
  const asked = normaliseAsk(ask);
  const pending = pendingPath(readingsPath);
  const existing = VlmReadings.open(readingsPath);
  const completed = readCompletionMarker(readingsPath);
  const banked = existing.size;

  if (request.reuseRequested && banked === 0) {
    throw new VlmReadingsError(
      `--reuse-readings was passed but ${readingsPath} banks no page answers, so there is nothing `
      + 'to reuse. Run without it to read the book.',
    );
  }

  if (request.reuseRequested) {
    return {
      action: completed !== null ? 'reuse' : 'resume',
      readings: existing,
      pendingPath: null,
      sentence: completed !== null
        ? `vlm-convert: reusing ${banked} banked page answer(s) BY REQUEST (--reuse-readings) from the `
          + `conversion that completed ${completed.completedAt}; no page is read from the model.`
        : `vlm-convert: --reuse-readings, and no run has completed here — resuming the interrupted run, `
          + `${banked} page(s) already read and banked in ${readingsPath}, the rest are read now.`,
    };
  }

  /*
   * ── what is already pending here, if anything ────────────────────────────
   *
   * Every path out of this block either RETURNS (the pending is continued) or
   * leaves no pending on disk, so everything below it is the ordinary decision
   * about the bank — with one clause of preface saying what was thrown away.
   */
  let discarded: string | null = null;

  if (!fs.existsSync(pending)) {
    /*
     * A sidecar with no pending beside it is what the swap leaves if it dies
     * between the rename and its own tidying, and it is a claim about a file that
     * no longer exists. Swept here rather than left, because the next thing to
     * open a pending would find somebody else's request already sitting where its
     * own goes.
     */
    fs.rmSync(pendingRequestPath(readingsPath), { force: true });
  } else if (request.freshRequested) {
    const abandoned = VlmReadings.open(pending).size;
    discardPending(readingsPath);
    discarded = `the ${abandoned} page(s) of a half-finished replacement in ${pending} were thrown `
      + 'away and it starts over';
  } else {
    const previous = readPendingRequest(readingsPath);
    if (previous === null || sameAsk(previous, ask)) {
      /*
       * The sidecar is rewritten on every resume rather than only on the first
       * open. It costs a file write against hours of GPU, and it is what repairs
       * a pending whose sidecar was swept, lost, or never written by an older
       * foundry — after this run the debris can account for itself again.
       */
      writePendingRequest(readingsPath, ask);
      const carried = VlmReadings.open(pending);
      return {
        action: carried.size === 0 ? 'read-fresh' : 'resume',
        readings: carried,
        pendingPath: pending,
        sentence: carried.size === 0
          ? `vlm-convert: a replacement reading was already opened at ${pending} and banks nothing `
            + `yet, so every page is read from the model into it; ${readingsPath} is replaced only `
            + 'when this run finishes.'
          : `vlm-convert: resuming the replacement reading that was interrupted — ${carried.size} `
            + `page(s) already read and banked in ${pending}, only the pages missing from it are `
            + `read now, and it replaces ${readingsPath} only when this run finishes.`,
      };
    }
    discardPending(readingsPath);
    discarded = `the replacement reading already at ${pending} was asked for `
      + `${describeAsk(previous.skipPages, previous.language)} and this run asks for `
      + `${describeAsk(asked.skipPages, asked.language)}, so it was thrown away and the replacement `
      + 'starts over';
  }

  // ── nothing pending: is there anything here worth protecting? ─────────────
  const preface = discarded === null ? '' : `${discarded}; `;

  if (banked > 0 && (completed !== null || request.freshRequested)) {
    /*
     * The gamble is opened HERE, before a page is rendered, and the empty file is
     * created rather than waited for: from this moment the directory says out
     * loud that a replacement is in progress, so a person looking at it — and the
     * app's own sweep — can see the attempt rather than infer it from a run that
     * is no longer running.
     */
    ensureDir(path.dirname(pending));
    fs.closeSync(fs.openSync(pending, 'a'));
    writePendingRequest(readingsPath, ask);
    return {
      action: 'read-fresh',
      readings: VlmReadings.open(pending),
      pendingPath: pending,
      sentence: `vlm-convert: ${preface}`
        + (completed === null
          ? 'fresh readings were asked for, so every page is read from the model again'
          : `this conversion already completed ${completed.completedAt} (${completed.pages} pages, `
            + `foundry ${completed.foundryVersion}), so running it again means reading the book again`)
        + ` — the ${banked} banked page answer(s) in ${readingsPath} are left exactly as they are `
        + `and the new reading is written to ${pending}, which replaces them only when this run `
        + `finishes${completed === null ? '' : '. Pass --reuse-readings to rebuild from them instead'}.`,
    };
  }

  if (banked === 0) {
    return {
      action: 'read-fresh',
      readings: existing,
      pendingPath: null,
      sentence: `vlm-convert: ${preface}nothing is banked in ${readingsPath}, so every page is read `
        + 'from the model and banked there as it lands.',
    };
  }

  return {
    action: 'resume',
    readings: existing,
    pendingPath: null,
    sentence: `vlm-convert: ${preface}resuming an interrupted run — ${banked} page(s) already read `
      + `and banked in ${readingsPath}, and only the pages missing from it are read now.`,
  };
}
