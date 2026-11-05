/**
 * workspace-cleanup — which file a cleanup is, and making it and its triage.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { materializeBook } from './book';
import { ProjectError, importDocument, ledgerOf, readManifest, narrationStampFileFor, recordsForTextPass } from './projects';
import { positionOf } from '../shared/ledger';
// A TYPE ONLY, deliberately: shared/pending.ts derives promises from QUEUE ROWS,
// and this module must not learn about a queue. What it is handed is the answer
// (`Deferral`), composed at the door by the side that holds both lists.
import type { Deferral } from '../shared/pending';
import type { LedgerStep, TranslationPlan } from '../shared/types';
import { readingGenerationOf } from './workspace-records';

/**
 * Where this book's NARRATION CLEANUP goes — the third text pass, and the one
 * with no language in it at all.
 *
 * ── What it borrows, which is nearly everything ─────────────────────────────
 *
 * "Say this book again, in the same words, with the punctuation and typography a
 * narrator can read aloud." So: the same materialised book at the same position,
 * the same records file that is its own resume cache, the same seeding rule, the
 * same step minted at the plan. `planSimplification`'s whole argument for
 * borrowing `planTranslation`'s body applies again, one act further along — and
 * everything downstream of this (the queue, the landing, the derived book, the
 * sweep) is the family's rather than any one member's.
 *
 * ── AND THE THREE THINGS IT DOES NOT DO ─────────────────────────────────────
 *
 * IT ASKS NO LANGUAGE AND REFUSES OVER NONE. `planSimplification` has to resolve
 * one — a rewrite happens IN a language and the engine is told which — and refuses
 * in words for a book that never declared one. A cleanup is told nothing about
 * language: the book is whatever it was, the model is shown the paragraphs in
 * front of it, and a book with no declared language cleans exactly as well as one
 * with. So the refusal is not relaxed here, it is inapplicable — and a book Owen
 * could not narrate because nobody had declared its language would have been a
 * refusal about a fact the act never consults.
 *
 * IT COMPOSES A STAMP, which no other plan does. `<key>.clean[.<id8>].stamp.json`,
 * named from the records file so the compile that later reads it
 * (`--narration-stamp`, `planRendering`) and the plan that writes it cannot come
 * to two answers (`narrationStampFileFor`, electron/projects.ts).
 *
 * IT IS NEVER REACHED STANDALONE, and that is a fact about the DOOR rather than
 * about this function. Owen: *"cleanup will only ever be done on behalf of
 * bookforge and wont be available in foundry."* The tile and the dialog are drawn
 * only in a hosted window; the plan, the step, the queue and the render path exist
 * here regardless, because a feature half-built in two repositories is worse than
 * one built in the repository that owns the ledger.
 *
 * ── NO SEED (Owen, 2026-10-03) ──────────────────────────────────────────────
 *
 * A cleanup used to start with the newest finished cleanup's answers, so a re-clean
 * asked only what had changed. *"if i sent it through cleanup again then its
 * because i want to clean it up again"*: a finished cleanup is never a reason to
 * skip one. Only this run's own records file, left by an interrupted run, resumes.
 */
export async function identifyCleanup(
  inputPath: string,
  /** The row this pass is made from. `planTranslation`'s own argument, verbatim. */
  at: LedgerStep | null = null,
  /**
   * THE ROW THIS CLEANUP IS MADE FROM HAS NOT LANDED.
   *
   * THE SIMPLEST OF THE THREE DEFERRED BRANCHES, and for the reason `PARAMS_OF.
   * clean` gives: a cleanup is described by nothing at all. There is no language to
   * resolve and no mode to name, so the records file's name depends on exactly one
   * fact — the parent — and the parent is the id in hand. Nothing about this plan
   * needs the chain except the book itself, and that is what the re-plan is for.
   */
  deferral?: Deferral,
  /** The id a press already promised. `planTranslation`'s argument, verbatim. */
  minted?: string,
  /** A readings-only pass's name (`CleanRequest.readingsOnly`): part of which step this is. */
  readings?: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);

  if (deferral !== undefined) {
    const promised = await recordsForTextPass(dir, 'clean', '', undefined, deferral.from, undefined, readings);
    await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
    return {
      key,
      sourcePath: inputPath,
      recordsPath: promised.recordsPath,
      // NAMED FROM THE RECORDS FILE, so it is as deterministic as the records are
      // and survives the deferral with them (`narrationStampFileFor`).
      stampPath: narrationStampFileFor(promised.recordsPath),
      stepId: promised.stepId,
      deferred: { from: deferral.from },
    };
  }

  const planned = await recordsForTextPass(
    dir, 'clean', '', undefined, at === null ? undefined : at.id, minted, readings,
  );
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    key,
    sourcePath: inputPath,
    recordsPath: planned.recordsPath,
    // NAMED FROM THE RECORDS FILE, so it is as deterministic as the records are
    // (`narrationStampFileFor`) — identity, not scratch, and it crosses at the press.
    stampPath: narrationStampFileFor(planned.recordsPath),
    stepId: planned.stepId,
    at: at?.id ?? positionOf(ledger)?.id ?? null,
  };
}

/**
 * THE SAME CLEANUP, AT THE SPAWN — `materializeTranslation`'s half, one act over
 * and with nothing about a language in it.
 *
 * NO SEED — see `identifyCleanup`: a cleanup pressed again cleans again.
 */
export async function materializeCleanup(
  inputPath: string,
  at: LedgerStep | null,
  minted?: string,
  /** A readings-only pass's name (`CleanRequest.readingsOnly`), as `identifyCleanup` takes it. */
  readings?: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const planned = await recordsForTextPass(
    dir, 'clean', '', undefined, at === null ? undefined : at.id, minted, readings,
  );
  /*
   * NO SEED. A cleanup was seeded with the newest finished cleanup's answers, so a
   * re-clean asked only what had changed. Owen, 2026-10-03: *"if i sent it through
   * cleanup again then its because i want to clean it up again"* — a finished
   * cleanup is never a reason to skip one. What still resumes is THIS run's own
   * records file, which an interrupted run left and the row still names.
   */
  const seed: string | null = null;
  const generation = readingGenerationOf(ledger, manifest);
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  const derived = await materializeBook(dir, at);
  if (!derived.ok) throw new ProjectError(derived.reason);
  return {
    key,
    sourcePath: inputPath,
    bookPath: derived.path,
    recordsPath: planned.recordsPath,
    stampPath: narrationStampFileFor(planned.recordsPath),
    stepId: planned.stepId,
    at: at?.id ?? null,
    ...(seed !== null ? { seedRecords: seed } : {}),
    ...(generation !== null ? { generation } : {}),
  };
}

/**
 * THE BOOK A CLEANUP'S TRIAGE READS, MADE AT THE SPAWN — and it is the book the
 * cleanup behind it will read, which is the whole of what this function promises.
 *
 * `materializeBook` of the row the press pinned, the same call
 * `materializeCleanup` makes one function up: both requests carry the same `at`
 * (or the same `deferred.from`), so the two books are the same content, and the
 * triage judges exactly the words the cleaner is shown. Nothing else a cleanup
 * composes is composed here — no records path, no stamp, no seed — because a
 * triage writes none of them; its one file was named at the press.
 *
 * NOT THE EXPORT PATH, which is the mistake this function exists to make
 * impossible: `materializeExport` narrows a narration stamp and composes a
 * rendering's inputs, and a triage is neither.
 *
 * A REFUSAL HERE IS THE PERSON'S OWN SENTENCE, `materializeAnalysis`'s rule: a
 * book that cannot be assembled is not worth a model's time.
 */
export async function materializeCleanTriage(
  projectDir: string,
  at: LedgerStep | null,
): Promise<{ bookPath: string }> {
  const derived = await materializeBook(projectDir, at);
  if (!derived.ok) throw new ProjectError(derived.reason);
  return { bookPath: derived.path };
}
