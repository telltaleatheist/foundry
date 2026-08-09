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
 * The bank is NEVER DELETED. A page costs GPU-minutes and a book costs hours, so
 * "start over" rotates the whole bank into `archived-<timestamp>/` and leaves it
 * there for a person to find. Deleting somebody's hours to save a directory
 * entry is not a trade this program makes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VERSION } from '../version.js';

export interface VlmReading {
  page: number;
  text: string;
  tokens: number;
  finishReason: string | null;
  seconds: number;
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
    const lines = fs.readFileSync(readings.filePath, 'utf8').split('\n');
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
      readings.byPage.set(record.page, {
        page: record.page,
        text: record.text,
        tokens: record.tokens ?? 0,
        finishReason: record.finishReason ?? null,
        seconds: record.seconds ?? 0,
      });
    }
    return readings;
  }

  get size(): number {
    return this.byPage.size;
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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
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
  /** When the EPUB was written. ISO 8601, UTC. */
  completedAt: string;
  /** The EPUB that run produced, absolute. */
  outPath: string;
  /** Pages the book was built from — not the size of the bank. */
  pages: number;
  /** The foundry that wrote it, so a marker can be traced to a build. */
  foundryVersion: string;
}

/** `completed.json`, beside the readings file. The readings file's directory IS the run directory. */
export function completionMarkerPath(readingsPath: string): string {
  return path.join(path.dirname(path.resolve(readingsPath)), 'completed.json');
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
    parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (err) {
    throw new VlmReadingsError(
      `${markerPath} is not JSON (${err instanceof Error ? err.message : String(err)}). `
      + 'It is where a finished conversion records itself, so this run cannot tell whether the '
      + 'readings beside it are a finished book or an interrupted one.',
    );
  }
  const record = parsed as Partial<VlmCompletion>;
  if (
    typeof record.completedAt !== 'string'
    || typeof record.outPath !== 'string'
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
    outPath: record.outPath,
    pages: record.pages,
    foundryVersion: record.foundryVersion,
  };
}

/** Write the marker atomically — temp file beside the target, then rename. */
export function writeCompletionMarker(
  readingsPath: string,
  completion: Omit<VlmCompletion, 'foundryVersion'>,
): VlmCompletion {
  const record: VlmCompletion = { ...completion, foundryVersion: VERSION };
  const markerPath = completionMarkerPath(readingsPath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, markerPath);
  return record;
}

/**
 * Move the bank and its marker into `archived-<timestamp>/`, and return that directory.
 *
 * A rename, not a copy: the point is that the LIVE bank is gone, so the run that
 * follows reads every page, and the answers that cost GPU-hours are still on
 * disk for anybody who wants them back. The timestamp is the ISO instant with
 * its colons replaced, because a colon is not a legal character in a Windows
 * filename and this program runs there.
 *
 * An archive directory that already exists is refused rather than merged into:
 * two banks in one directory is two books' worth of answers under one name.
 */
export function archiveReadingsBank(readingsPath: string, at: Date): string {
  const resolved = path.resolve(readingsPath);
  const runDir = path.dirname(resolved);
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(runDir, `archived-${stamp}`);
  if (fs.existsSync(archiveDir)) {
    throw new VlmReadingsError(
      `${archiveDir} already exists, so this run cannot archive the readings beside it without `
      + 'mixing two runs\' answers into one directory. Move it aside and run again.',
    );
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  if (fs.existsSync(resolved)) {
    fs.renameSync(resolved, path.join(archiveDir, path.basename(resolved)));
  }
  const markerPath = completionMarkerPath(resolved);
  if (fs.existsSync(markerPath)) {
    fs.renameSync(markerPath, path.join(archiveDir, path.basename(markerPath)));
  }
  return archiveDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// What this run does about the bank it found
// ─────────────────────────────────────────────────────────────────────────────

export type ReadingsBankAction =
  /** Every page is read from the model. Any bank that was here has been archived. */
  | 'read-fresh'
  /** An interrupted run's missing pages are read; the banked ones are not. */
  | 'resume'
  /** A finished run's answers are replayed, by request. No page is read. */
  | 'reuse';

export interface ReadingsBankOutcome {
  action: ReadingsBankAction;
  /** The bank this run will answer out of. Empty for `read-fresh`. */
  readings: VlmReadings;
  /** Where the previous bank went, or null where nothing was archived. */
  archivedTo: string | null;
  /** ONE sentence, printed by the run. Never empty — every decision is stated. */
  sentence: string;
}

export interface ReadingsBankRequest {
  readingsPath: string;
  /** `--fresh-readings`: archive whatever is banked and read every page. */
  freshRequested: boolean;
  /** `--reuse-readings`: answer out of the bank even though a run completed. */
  reuseRequested: boolean;
  /** Injectable so a test can pin the archive directory's name. */
  now?: Date;
}

/**
 * Decide what to do with the readings beside this run, do it, and say so.
 *
 * The three-way rule, in one place because it is one decision:
 *
 *   completed + nothing asked  → ARCHIVE, read every page. A person who orders a
 *                                conversion that already finished is ordering the
 *                                work, not a replay of it. This is the bug this
 *                                function exists to close.
 *   completed + --reuse        → replay the bank. The deliberate free reconvert:
 *                                iterate on the assembler over known-good answers.
 *   interrupted (no marker)    → resume. The debt gets paid off, never re-paid.
 *   --fresh                    → ARCHIVE, read every page, whatever the marker says.
 *                                The explicit form, for a caller whose own records
 *                                know the conversion finished — a bank written
 *                                before markers existed carries no marker.
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
  const existing = VlmReadings.open(readingsPath);
  const completed = readCompletionMarker(readingsPath);
  const banked = existing.size;

  if (request.reuseRequested && banked === 0) {
    throw new VlmReadingsError(
      `--reuse-readings was passed but ${readingsPath} banks no page answers, so there is nothing `
      + 'to reuse. Run without it to read the book.',
    );
  }

  if (request.freshRequested) {
    if (banked === 0) {
      return {
        action: 'read-fresh',
        readings: existing,
        archivedTo: null,
        sentence: `vlm-convert: fresh readings were asked for and ${readingsPath} banks none, `
          + 'so every page is read from the model and banked there.',
      };
    }
    const archivedTo = archiveReadingsBank(readingsPath, request.now ?? new Date());
    return {
      action: 'read-fresh',
      readings: VlmReadings.open(readingsPath),
      archivedTo,
      sentence: `vlm-convert: fresh readings were asked for, so the ${banked} banked page `
        + `answer(s)${completed === null ? '' : ` from the conversion that completed ${completed.completedAt}`}`
        + ` were archived to ${archivedTo} and every page is read from the model again.`,
    };
  }

  if (completed !== null && !request.reuseRequested) {
    const archivedTo = archiveReadingsBank(readingsPath, request.now ?? new Date());
    return {
      action: 'read-fresh',
      readings: VlmReadings.open(readingsPath),
      archivedTo,
      sentence: `vlm-convert: this conversion already completed ${completed.completedAt} `
        + `(${completed.pages} pages, foundry ${completed.foundryVersion}), so running it again means `
        + `reading the book again — its ${banked} banked page answer(s) were archived to ${archivedTo} `
        + 'and every page is read from the model. Pass --reuse-readings to rebuild from them instead.',
    };
  }

  if (request.reuseRequested) {
    return {
      action: completed !== null ? 'reuse' : 'resume',
      readings: existing,
      archivedTo: null,
      sentence: completed !== null
        ? `vlm-convert: reusing ${banked} banked page answer(s) BY REQUEST (--reuse-readings) from the `
          + `conversion that completed ${completed.completedAt}; no page is read from the model.`
        : `vlm-convert: --reuse-readings, and no run has completed here — resuming the interrupted run, `
          + `${banked} page(s) already read and banked in ${readingsPath}, the rest are read now.`,
    };
  }

  if (banked === 0) {
    return {
      action: 'read-fresh',
      readings: existing,
      archivedTo: null,
      sentence: `vlm-convert: nothing is banked in ${readingsPath}, so every page is read from the `
        + 'model and banked there as it lands.',
    };
  }

  return {
    action: 'resume',
    readings: existing,
    archivedTo: null,
    sentence: `vlm-convert: resuming an interrupted run — ${banked} page(s) already read and banked in `
      + `${readingsPath}, and only the pages missing from it are read now.`,
  };
}
