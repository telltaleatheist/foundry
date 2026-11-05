/**
 * projects-files — which file holds what at a position: banks, book files, stamps and images.
 */
import * as path from 'node:path';
import type { LedgerStep, ProjectManifest } from '../shared/types';
import { readingInEffect } from '../shared/ledger';
import { readManifest } from './projects-manifest';
import { DERIVED, ProjectError, READINGS } from './projects-paths';
import { ledgerOf } from './projects-steps';

/**
 * The bank a rendering AT THE POSITION is made from — the step's own file.
 *
 * ── The row that rendered somebody else's reading ───────────────────────────
 *
 * `readings/<key>.jsonl` was composed from the project key at every call site, on
 * the belief that a project has one bank. It does not: a re-read asking for a
 * different page range BRANCHES by design (`MINTED_BY_THE_RUN`), so a project can
 * hold two `read` steps — and while both composed the same path, standing on the
 * older one and pressing Generate rendered the newer reading. The row named a
 * bank that had been written over from under it and nothing on screen said so.
 *
 * So the plan asks the row: `readingInEffect` walks up from the position to the
 * reading this branch of the story is about, and its payload is the answer. The
 * exact shape `renderingOverlay` above already has, for the same reason — the
 * pointer decides which of several files a run is handed, and composing one from
 * the key is a second opinion about a question the ledger has already answered.
 *
 * THE COMPOSED PATH IS THE FALLBACK AND IT IS NOT A LEGACY BRANCH. Every project
 * that existed before per-step paths has one read step whose payload IS
 * `readings/<key>.jsonl`, so those go through the ledger like everything else and
 * no file on any disk moves. What falls back here is a project with no reading at
 * all — and a position standing on the import, the revert row, which is about the
 * untouched original rather than about any bank.
 */
export function readingBank(
  dir: string,
  manifest: ProjectManifest,
  /**
   * THE STEP TO WALK UP FROM, when a plan is about one step rather than about the
   * position — a save's own book, a translation's own book.
   *
   * Both of those are cast by a LANDING, and a landing runs while the pointer is
   * wherever the person happens to be standing. In practice the answer is nearly
   * always the same bank, because a project holds one reading; it stops being the
   * same one the moment a re-read branches, and then a cast keyed to a step under
   * one reading would replay the other one's pages. The argument is
   * `planFacsimile`'s, in full.
   */
  at: LedgerStep | null = null,
): string {
  const reading = readingInEffect(ledgerOf(manifest), at);
  return reading === null
    ? path.join(dir, READINGS, `${manifest.key}.jsonl`)
    : path.join(dir, ...reading.payload.split('/'));
}

/** The same answer for a caller that has not read the catalogue yet. */
export async function bankForPosition(dir: string): Promise<string> {
  return readingBank(dir, await readManifest(dir));
}

/**
 * WHERE THE BOOK FILE IS — the bank's own path with `.book` in front of its
 * extension, and the whole of the app's knowledge of that spelling.
 *
 * ── Why it is derived from the bank and not composed from the key ───────────
 *
 * For `readingBank`'s reason exactly, one layer up: a project can hold two banks
 * (a re-read asking for a different page range branches by design), and a book
 * file composed from the project key would be the reflow of whichever reading
 * happened to be newest, filed under the row somebody is standing on. The bank at
 * the position is the answer to "which reading is this branch of the story
 * about"; the book file is that bank, reflowed, so it is named after it and can
 * never drift from it.
 *
 * IT REFUSES A BANK THAT IS NOT A `.jsonl` rather than appending to whatever it
 * was given. There is no second spelling to fall back to and guessing one would
 * put the reflow of somebody's reading in a file nothing will ever look for
 * again — the engine writes banks as JSONL and nothing else does.
 */
export function bookFileFor(bank: string): string {
  if (!bank.toLowerCase().endsWith('.jsonl')) {
    throw new ProjectError(
      `${bank} is not a readings bank — those are the .jsonl files the engine writes, and the `
      + 'book file is named after one. Refusing to guess at where the book would live.',
    );
  }
  return `${bank.slice(0, -'.jsonl'.length)}.book.jsonl`;
}

/**
 * WHERE A TRANSLATION'S OWN BOOK FILE IS — its records file with `.book` where
 * `.records` was, and the whole of the app's knowledge of THAT spelling.
 *
 * ── Why it is named after the records and not after the bank ────────────────
 *
 * `bookFileFor` above names the reading's reflow after the bank it is a pure
 * function of. This one is the same idea one transform along: when a translate
 * lands, main materialises `parent book file + chain ops + records` into a
 * DERIVED book file (docs/RENDERER.md §4), and the one input of those three that
 * is unique to this step is the records file — which is also the step's payload,
 * so the file is named after the row that owns it and can never drift from it.
 * `readings/<key>.hu.records.jsonl` becomes `readings/<key>.hu.book.jsonl`, and a
 * branch's `<key>.hu.<id8>.records.jsonl` becomes `<key>.hu.<id8>.book.jsonl`:
 * one translation, one book, no collision with the reading's own `<key>.book.jsonl`
 * because the language tag is always between them.
 *
 * IT REFUSES ANY OTHER SPELLING, on `bookFileFor`'s rule and for its reason. A
 * translate step made before records kept its words inside an EPUB in
 * `generated/` (`translationRecordsOf` answers null for one), and appending
 * `.book.jsonl` to whatever it was handed would put a derived book beside a book,
 * named after nothing, that no sweep would ever find again.
 */
export function translationBookFileFor(records: string): string {
  const suffix = '.records.jsonl';
  if (!records.toLowerCase().endsWith(suffix)) {
    throw new ProjectError(
      `${records} is not a translation's records file — those are the .records.jsonl files the `
      + 'engine writes, and the derived book is named after one. Refusing to guess at where the '
      + 'translated book would live.',
    );
  }
  return `${records.slice(0, -suffix.length)}.book.jsonl`;
}

/**
 * WHERE A CLEANUP'S STAMP LIVES — `<key>.clean[.<id8>].stamp.json`, beside the
 * answers it is a receipt for.
 *
 * ── Named FROM the records rather than composed beside them ─────────────────
 *
 * `translationBookFileFor`'s arrangement one file over, and its whole argument
 * transfers: three parties need this path and must not compose it three ways. The
 * PLAN puts it on the command line as `--stamp` (`planCleanup`,
 * electron/workspace.ts), the RENDER puts it on as `--narration-stamp`
 * (`planRendering`), and the sweep will one day remove it — and the only thing all
 * three certainly hold is the step, whose payload IS the records file. Composing
 * from the project key and a branch id instead would mean re-deriving the branch
 * from the step's uuid at two of the three sites, which is a guess about which
 * name a run happened to take.
 *
 * IT REFUSES ANY OTHER SPELLING, on `translationBookFileFor`'s rule and for its
 * reason: appending a suffix to whatever it was handed would put a stamp beside a
 * file that is not a records file, named after nothing, that no sweep would ever
 * find again.
 *
 * IT SAYS NOTHING ABOUT WHETHER THE FILE IS THERE. A cleanup that landed before
 * the engine wrote stamps has none, and the caller's job is to look
 * (`planRendering` omits the flag rather than pointing the compile at a file that
 * is not there) — a book compiled with no narration meta is a book saying nothing
 * about narration, which is honest, where a flag on a missing path fails the
 * export outright.
 */
/**
 * The derived-book directory for one project. Created on write, never assumed.
 */
export function derivedDirFor(projectDir: string): string {
  return path.join(projectDir, DERIVED);
}

export function narrationStampFileFor(records: string): string {
  const suffix = '.records.jsonl';
  if (!records.toLowerCase().endsWith(suffix)) {
    throw new ProjectError(
      `${records} is not a text pass's records file — those are the .records.jsonl files the engine `
      + 'writes, and a narration stamp is named after one. Refusing to guess at where the stamp '
      + 'would live.',
    );
  }
  return `${records.slice(0, -suffix.length)}.stamp.json`;
}

/**
 * WHERE THE RANKING IN FRONT OF AN ANALYSIS WRITES — `<report>.rank.json`.
 *
 * `cleanTriageFileFor`'s arrangement, for its reason: two rows have to agree
 * about this path — the `analysis-rank` row that writes it (`--out`) and the
 * `analysis` row behind it that reads it (`--ranks`) — and the one thing both
 * certainly hold is the report's path. So it is named FROM the report, here,
 * and composed nowhere else (`enqueueAnalysis`, electron/job-queue.ts). The
 * engine names it the same way (`rankFileFor`, src/analyze/snap.ts).
 *
 * IT IS NOT A PAYLOAD. It sits beside the report for the length of the pair and
 * is removed when the analysis lands (`executeJob`), so a finished analysis
 * leaves only its report in `analysis/`. A pair that fails keeps it, so Retry on
 * the analysis row does not have to pay the card for the ranking again.
 */
export function analysisRankFileFor(report: string): string {
  return `${path.resolve(report)}.rank.json`;
}

/**
 * WHERE A CLEANUP'S TRIAGE VERDICTS LIVE — `<key>.clean[.<id8>].triage.json`,
 * beside the answers they decide the asking of.
 *
 * ── The same owner as the stamp, for the stamp's reason ─────────────────────
 *
 * Two rows have to agree about this path — the `clean-triage` row that writes it
 * (`--out`) and the `clean` row chained behind it that reads it (`--triage`) —
 * and the one thing both certainly hold is the cleanup's records file. So it is
 * named FROM that file, here, beside `narrationStampFileFor`, and composed nowhere
 * else (`enqueueTriagedCleanup`, electron/job-queue.ts). A name composed from the
 * project key and a branch id instead would be a guess about which branch a
 * records file happened to take.
 *
 * DETERMINISTIC AT THE PRESS, which is what lets the verdicts be a row's identity:
 * two presses of one triaged cleanup name one records file and therefore one
 * verdicts file, and the queue answers the second press with the rows the first
 * one made (`productOf`). A deferred cleanup's records path is already named at
 * the press (`identifyCleanup`), so this holds for a cleanup ordered from a
 * greyed card too.
 *
 * IT REFUSES ANY OTHER SPELLING, on the stamp's rule: a suffix appended to
 * whatever it was handed would be a verdicts file beside something that is not a
 * records file, named after nothing.
 *
 * IT IS A RECEIPT OF WHAT WAS ASKED, NOT A CACHE THAT DECIDES ANYTHING ON ITS OWN.
 * Every verdict carries the digest of the words it judged, and the cleanup cleans
 * any block whose words have changed since (src/clean/run.ts) — so a file left
 * over from an older run can make a later one cheaper and can never make it skip
 * a block it did not judge.
 */
export function cleanTriageFileFor(records: string): string {
  const suffix = '.records.jsonl';
  if (!records.toLowerCase().endsWith(suffix)) {
    throw new ProjectError(
      `${records} is not a text pass's records file — those are the .records.jsonl files the engine `
      + 'writes, and a cleanup\'s triage verdicts are named after one. Refusing to guess at where '
      + 'the verdicts would live.',
    );
  }
  return `${records.slice(0, -suffix.length)}.triage.json`;
}

/**
 * WHERE THE BOOK'S CUT FIGURES ARE — the bank's own path with `.images` in place
 * of its extension, and the whole of the app's knowledge of that spelling.
 *
 * A MIRROR OF THE ENGINE'S `imagesDir` (src/vlm/book-run.ts), on shared/book.ts's
 * grow-together rule: the engine cuts the figures beside the bank they were cut
 * out of the answers of, a book row names its crop by NAME and never by path
 * (docs/BOOK-FILE.md §6), and this is where the app turns the name back into a
 * file. Derived from the bank for `bookFileFor`'s reason exactly — a project can
 * hold two banks, and each reading's figures belong to it.
 */
export function imagesDirFor(bank: string): string {
  if (!bank.toLowerCase().endsWith('.jsonl')) {
    throw new ProjectError(
      `${bank} is not a readings bank — those are the .jsonl files the engine writes, and the `
      + 'figure directory is named after one. Refusing to guess at where the images would live.',
    );
  }
  return `${bank.slice(0, -'.jsonl'.length)}.images`;
}
