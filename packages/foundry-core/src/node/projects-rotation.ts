/**
 * projects-rotation — moving generated and final files aside for a run, and putting them back.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ProjectDocumentKind, ProjectFinal, ProjectManifest, ProjectStep } from '../shared/types';
import { id8 } from '../shared/ledger';
import { announceProjects, exists, withManifest, writeManifest } from './projects-manifest';
import { FINAL, GENERATED, ProjectError } from './projects-paths';

/**
 * Append a step to one file type's chain, making the chain if it is the first.
 *
 * THE ONLY WRITER OF A CHAIN, so that "the live file is the last step" is true
 * by construction rather than by everybody remembering to append. A step is
 * never inserted, never reordered and never replaced: the array is a history,
 * and the one thing a history may not do is change.
 *
 * `onlyIfEmpty` is for an ORIGIN that may be recorded twice — importing a book
 * that is already this project's, most of all. The first origin is the true one;
 * a later import of the same file is the app noticing something it already knew.
 */
export function recordStep(
  manifest: ProjectManifest,
  kind: ProjectDocumentKind,
  step: ProjectStep,
  options: { onlyIfEmpty?: boolean } = {},
): void {
  const record = manifest.documents.find((row) => row.kind === kind);
  if (record === undefined) {
    manifest.documents = [...manifest.documents, { kind, steps: [step] }];
    return;
  }
  if (options.onlyIfEmpty === true) return;
  // The same file applied twice is one step. A rerun that lands on a path
  // already at the top of the chain has replaced its contents, not added a
  // version — and two identical rows would make "step back" a no-op.
  if (record.steps[record.steps.length - 1]?.file === step.file) {
    record.steps = [...record.steps.slice(0, -1), step];
    return;
  }
  record.steps = [...record.steps, step];
}

/** The chain for one type, or an empty one. Never null, so callers stay flat. */
export function stepsOf(manifest: ProjectManifest, kind: ProjectDocumentKind): ProjectStep[] {
  return manifest.documents.find((row) => row.kind === kind)?.steps ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// The generated layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `archived-2026-08-14T00-31-02-114Z-9f2c1a04` — the engine's shape with colons
 * removed, and the front of the id of the RUN that made the rotation after it.
 *
 * ── THE CLOCK ALONE IS NOT A NAME ───────────────────────────────────────────
 *
 * It was, and the cost was a refusal: two rotations inside one project in the
 * same millisecond compose one folder name, so the second was refused by the
 * first's folder — with a sentence about mixing two runs' work that was true of
 * the name and false about the books. A person's job simply did not happen
 * because another one was fast, and on faster hardware it happens more often.
 *
 * The run's id is already unique, already minted and already means something a
 * stamp cannot say: WHICH job moved this aside. `id8` rather than the whole uuid
 * for the reason it exists (shared/ledger.ts) — eight hex characters are
 * collision-free across the handful of rotations one project holds, and the
 * refusal below is still there for the day that stops being true.
 */
export function stampedArchive(parent: string, by: string): string {
  return path.join(
    parent,
    `archived-${new Date().toISOString().replace(/[:.]/g, '-')}-${id8(by)}`,
  );
}

/**
 * Move an origin aside, if it is there.
 *
 * Called before a conversion writes, so a second run of the same book replaces
 * the first WITHOUT destroying it. `generated/` is never overwritten, ever: it
 * is the record of what the model read, and the previous read is still a record
 * of something.
 */
/**
 * A rotation that happened, and everything needed to put it back.
 *
 * IT IS A RECEIPT, and it exists because a rotation is now made at the moment
 * the engine is about to write rather than when a job is planned — so there is a
 * window, however short, in which the run can fail and the previous output has to
 * come home. See `restoreRotation`.
 */
export interface Rotation {
  /** `<stem>.epub` — the name in `generated/` that was moved out of the way. */
  file: string;
  /** Where it went: `generated/archived-<stamp>/<file>`. */
  movedTo: string;
}

export async function rotateGenerated(
  dir: string,
  file: string,
  /**
   * THE RUN THIS ROTATION IS FOR — a job id, and what makes the archive folder
   * this run's own rather than this millisecond's. See `stampedArchive`.
   */
  by: string,
): Promise<Rotation | null> {
  const target = path.join(dir, GENERATED, file);
  if (!await exists(target)) return null;

  let movedTo: string | null = null;
  await withManifest(dir, async (manifest) => {
    const from = `${GENERATED}/${file}`;
    const archive = stampedArchive(path.join(dir, GENERATED), by);
    if (await exists(archive)) {
      // The engine's rule, for the engine's reason: two runs' outputs under one
      // folder name is two books' worth of work filed as one. The name carries
      // the run's own id now, so what this catches is no longer two jobs
      // arriving in one millisecond — it is one job rotating twice, which
      // nothing does. Loud anyway, because the day it happens the alternative is
      // a book written into somebody else's record.
      throw new ProjectError(
        `${archive} already exists, and it is named after this run — so the previous ${file} `
        + 'cannot be moved aside without writing into a folder that is already a record of '
        + 'something. Move it away and run again.',
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    movedTo = path.join(archive, file);
    await fsp.rename(target, movedTo);

    /*
     * THE ROTATED COPY STAYS IN THE CHAIN, at the path it was moved to.
     *
     * It used to be struck out of the catalogue entirely, which was right when a
     * catalogue listed live files and wrong now that it records a history: the
     * file this just moved aside is a previous version of this type, it is on
     * disk, and it is exactly what "step back to an earlier one" reaches for.
     * Only its location changed, so only its location is rewritten — the label,
     * the cost and the time it was applied are what they always were.
     */
    const record = manifest.documents.find((row) => row.steps.some((s) => s.file === from));
    if (record !== undefined && movedTo !== null) {
      const moved = path.relative(dir, movedTo).split(path.sep).join('/');
      record.steps = record.steps.map(
        (step) => (step.file === from ? { ...step, file: moved } : step));
    }
    await writeManifest(dir, manifest);
  });
  // A document moved out of the live layer and into an archive folder, which is
  // a listing that has changed even though nothing was made.
  announceProjects();
  // The receipt: where it went, so a run whose own input is the copy being
  // replaced can read it there (see `planTranslation`) and a run that never
  // writes can put it back (see `restoreRotation`).
  return movedTo === null ? null : { file, movedTo };
}

/**
 * Put a rotation back, because the run it was made for never wrote anything.
 *
 * ── The invariant this exists to keep ───────────────────────────────────────
 *
 * A GENERATE THAT FAILS OR IS CANCELLED LEAVES THE CATALOGUE EXACTLY AS IT WAS.
 *
 * It used not to. The rotation happened when the job was PLANNED — before it was
 * even enqueued, let alone run — and the new file was recorded only on success.
 * So a run that failed at the first page, or one the user cancelled, or one that
 * sat held and was removed, left the previous output sitting in
 * `generated/archived-<stamp>/` with the chain pointing at it and nothing in
 * `generated/` at all. Home went on listing the document, opening it went on
 * working, and the file it opened was silently the PREVIOUS run's output,
 * forever, with nothing anywhere saying a rotation had happened for a run that
 * never produced anything.
 *
 * ── What it puts back ───────────────────────────────────────────────────────
 *
 * The file, and the step's location in the chain.
 *
 * NOTHING IS DELETED BY A RESTORE, and the empty archive folder is removed only
 * if it IS empty. That guard used to be about SIBLINGS — the folder was named
 * after the clock, so a rotation in the same instant landed in it — and since
 * `stampedArchive` names it after the run there is only ever this rotation's own
 * file in there. What it answers now is whether the rename above actually
 * happened: a restore that found the live slot taken has already returned, and
 * one whose file somebody had moved leaves whatever is left standing.
 *
 * A failure here is a console line rather than a throw. It runs on the way out
 * of a job that has already failed, and the second failure worth reporting is
 * the one the user asked about; this one is named in full in the terminal.
 */
export async function restoreRotation(dir: string, rotation: Rotation): Promise<void> {
  try {
    const back = path.join(dir, GENERATED, rotation.file);
    if (await exists(back)) {
      // Something is in the live slot. That can only be the very output this
      // rotation was making room for, which means the run DID write — so there
      // is nothing to undo and putting the old copy over it would destroy the
      // new one.
      return;
    }
    if (await exists(rotation.movedTo)) await fsp.rename(rotation.movedTo, back);

    const archive = path.dirname(rotation.movedTo);

    await withManifest(dir, async (manifest) => {
      const from = `${GENERATED}/${rotation.file}`;
      const moved = path.relative(dir, rotation.movedTo).split(path.sep).join('/');
      const record = manifest.documents.find((row) => row.steps.some((s) => s.file === moved));
      if (record !== undefined) {
        record.steps = record.steps.map(
          (step) => (step.file === moved ? { ...step, file: from } : step));
      }
      await writeManifest(dir, manifest);
    });

    try {
      if ((await fsp.readdir(archive)).length === 0) await fsp.rmdir(archive);
    } catch { /* the folder is already gone, or something has it open */ }
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${rotation.file} was moved aside for a run that did not write, and could not be `
      + `put back (${(err as Error).message}). It is in ${rotation.movedTo}; nothing was deleted.`,
    );
  }
}

/**
 * A rotation of a FILED document, and everything needed to put it back.
 *
 * The `generated/` receipt one folder over (`Rotation`) and deliberately not the
 * same shape: an origin has a step in a type's chain, and that has to travel in
 * the receipt. A filed document has none — nothing is ever made from an export —
 * so what a restore owes is the file and the catalogue row that named it.
 */
export interface FinalRotation {
  /** `<stem>.epub` — the name in `final/` that was moved out of the way. */
  file: string;
  /** Where it went: `final/archived-<stamp>/<file>`. */
  movedTo: string;
  /** The row the rotation struck out of `manifest.final`, if there was one. */
  row: ProjectFinal | null;
}

/**
 * Move a filed document aside, if there is one, so an export can take its name.
 *
 * ── Why `final/` rotates at all, when it is the user's own tray ─────────────
 *
 * Because the name is composed rather than chosen. An export is called after the
 * BOOK — `<stem>.epub` — like everything else in a project, so exporting the same
 * format twice names one path twice, and the second run would write over the first
 * with nothing anywhere saying it had. That is the exact failure `rotateGenerated`
 * exists to prevent one folder over, and the fact that a person could have gone and
 * renamed the file themselves is not a reason for this app to destroy it while they
 * did not.
 *
 * AT THE MOMENT THE ENGINE IS ABOUT TO WRITE, never at the plan — the whole of
 * `restoreRotation`'s argument, applied to the same window: a run that fails, is
 * cancelled, or is removed from the shelf must leave the tray exactly as it found
 * it, and the only way that is true is if the rotation is undoable and undone.
 *
 * ── And there is no open-file refusal here, which is the difference ─────────
 *
 * `rotateGenerated` refuses when the book it would move has a working tree open in
 * a tab, because moving that tree is what breaks a reader mid-chapter. An export
 * has no tree: a filed EPUB opened in a tab was unpacked into `working/` under its
 * own name and the tab reads the tree, not this file; a filed PDF's bytes were read
 * once. So there is nothing being read out from under anybody, and a refusal here
 * would stop somebody re-exporting the book they are looking at — which is the most
 * ordinary reason to export twice.
 */
export async function rotateFinal(
  dir: string,
  file: string,
  /** The run this rotation is for — `rotateGenerated`'s `by`, for its reason. */
  by: string,
): Promise<FinalRotation | null> {
  const target = path.join(dir, FINAL, file);
  if (!await exists(target)) return null;

  let movedTo: string | null = null;
  let row: ProjectFinal | null = null;
  await withManifest(dir, async (manifest) => {
    const archive = stampedArchive(path.join(dir, FINAL), by);
    if (await exists(archive)) {
      // `rotateGenerated`'s rule, for its reason, down to the run's id being
      // what makes the folder this export's own.
      throw new ProjectError(
        `${archive} already exists, and it is named after this run — so the ${file} you filed `
        + 'earlier cannot be moved aside without writing into a folder that is already a record '
        + 'of something. Move it away and run again.',
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    movedTo = path.join(archive, file);
    await fsp.rename(target, movedTo);
    /*
     * THE ROW GOES, rather than being rewritten to point into the archive.
     *
     * This is where a filed document parts company with a generated one. A rotated
     * ORIGIN stays in its chain at its new path, because the chain is a history and
     * an earlier version of the book is exactly what "step back" reaches for. The
     * `final` list is not a history — it is what the project currently offers, one
     * row per file the user can open — so a row pointing into an archive folder
     * would put a stamped directory name in the left nav for a document nobody
     * asked to keep. The bytes are still there; the claim that they are on offer
     * is what the rotation withdraws.
     */
    row = manifest.final.find((entry) => entry.file === file) ?? null;
    manifest.final = manifest.final.filter((entry) => entry.file !== file);
    await writeManifest(dir, manifest);
  });
  // A document left the tray, which is a listing that has changed even though
  // nothing has been made yet.
  announceProjects();
  return movedTo === null ? null : { file, movedTo, row };
}

/**
 * Put a filed document back, because the export it was moved for never wrote.
 *
 * `restoreRotation`'s invariant, said about the other folder: AN EXPORT THAT FAILS
 * OR IS CANCELLED LEAVES THE TRAY EXACTLY AS IT WAS. Nothing is deleted, the empty
 * archive folder goes only if it IS empty (see `restoreRotation`, where the same
 * guard and what it answers now that a folder is named after its run are spelled
 * out), and a failure here is a console line rather than a throw — it runs on the
 * way out of a job that has already failed, and the failure worth reporting is
 * the one the user asked about.
 */
export async function restoreFinalRotation(dir: string, rotation: FinalRotation): Promise<void> {
  try {
    const back = path.join(dir, FINAL, rotation.file);
    if (await exists(back)) {
      // Something is in the live slot, which can only be the export this rotation
      // made room for — so the run DID write, and putting the old copy over it
      // would destroy the new one.
      return;
    }
    if (await exists(rotation.movedTo)) await fsp.rename(rotation.movedTo, back);

    const row = rotation.row;
    if (row !== null) {
      await withManifest(dir, async (manifest) => {
        if (manifest.final.some((entry) => entry.file === row.file)) return;
        manifest.final = [...manifest.final, row];
        await writeManifest(dir, manifest);
      });
    }

    try {
      const archive = path.dirname(rotation.movedTo);
      if ((await fsp.readdir(archive)).length === 0) await fsp.rmdir(archive);
    } catch { /* somebody else's rotation shares the folder, or it is already gone */ }
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${rotation.file} was moved aside for an export that did not write, and could not be `
      + `put back (${(err as Error).message}). It is in ${rotation.movedTo}; nothing was deleted.`,
    );
  }
}
