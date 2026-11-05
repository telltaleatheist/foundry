/**
 * projects-edits — recording curations, metadata and book edits as steps.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { LedgerParams, LedgerStep, MetadataPatch, ProjectManifest } from '../shared/types';
import { readJson } from '../shared/json';
import { mergedMetadata, metadataInEffect, positionOf, translationRecordsOf } from '../shared/ledger';
import { fold } from '../shared/original';
import { writeAtomically } from './atomic';
import { restampCorrection } from './narration-stamp';
import { deletableProjectDir } from './projects-delete';
import { narrationStampFileFor } from './projects-files';
import { announceProjects, readManifest, withManifest, writeManifest } from './projects-manifest';
import { ProjectError } from './projects-paths';
import { landStep, ledgerOf, viewOf } from './projects-steps';
import type { LedgerView } from './projects-steps';

export async function recordCuration(
  dir: string,
  payload: string,
  params: LedgerParams,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const view = await withManifest(resolved, async (manifest) => {
    const landing = await landStep(manifest, {
      action: 'curate',
      parent: null,
      payload,
      params,
      createdAt: Date.now(),
    });
    if (landing === null) {
      throw new ProjectError(
        `${path.basename(resolved)} has no recorded history for a save to be made from — this app `
        + 'has no record of the document it was built on, so there is no step to hang a curation off. '
        + 'Opening the book from Home imports it and gives this project an origin.',
      );
    }
    await writeManifest(resolved, manifest);
    return viewOf(manifest, landing.ledger);
  });
  announceProjects();
  return view;
}

/**
 * A metadata edit: the patch is already written, this is the step for it.
 *
 * ── What was missing, in one sentence ───────────────────────────────────────
 *
 * The dialog wrote a title into the open document and nothing else learned it had
 * happened — no row, no announce, and an export that silently lost the edit,
 * because an export is cast fresh from the bank and a working tree's package is
 * not one of its inputs. This is the durable half. The write to the live document
 * STAYS exactly where it was: the user has to see the correction at once, and the
 * step is what makes it survive into everything made afterwards.
 *
 * THE SAME SHAPE AS `recordCuration` ABOVE, down to the reasons. The file work is
 * the caller's (main writes the patch, then calls this — file before step, the
 * rule `commitOverlay` states in full); the manifest surgery is this module's,
 * because all of it happens behind `withManifest`.
 *
 * NO CAPTURED PARENT, and none is possible: an Apply is not a queue job. It
 * happens the instant the user presses the button, so there is no gap between the
 * gesture and the recording for a pointer move to slip through.
 *
 * AND THE POSITION IS STILL THAT ONE AFTERWARDS (`RETAINED_BESIDE_YOU`), for the
 * reason a save is: the document in front of the user already carries the new
 * values, so there is no new state to go and stand in, and a pointer that moved
 * would take the block editor read-only as the reward for correcting a name.
 */
export async function recordMetadata(
  dir: string,
  payload: string,
  params: LedgerParams,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const view = await withManifest(resolved, async (manifest) => {
    const landing = await landStep(manifest, {
      action: 'metadata',
      parent: null,
      payload,
      params,
      createdAt: Date.now(),
    });
    if (landing === null) {
      throw new ProjectError(
        `${path.basename(resolved)} has no recorded history for a metadata edit to be filed against `
        + '— this app has no record of the document it was built on, so there is no step to hang one '
        + 'off. Opening the book from Home imports it and gives this project an origin.',
      );
    }
    await writeManifest(resolved, manifest);
    return viewOf(manifest, landing.ledger);
  });
  announceProjects();
  return view;
}

/**
 * An Apply on the book: the ops file is already written, this is the step for it.
 *
 * THE SAME SHAPE AS `recordCuration` AND `recordMetadata` ABOVE, down to the
 * reasons. The file work is the caller's (electron/book.ts writes the ops
 * atomically and then calls this — file before step, always, because a row naming
 * a payload that failed to write is a row describing nothing); the manifest
 * surgery is this module's, because all of it happens behind `withManifest`.
 *
 * NO CAPTURED PARENT, and none is possible: an Apply is not a queue job. It
 * happens the instant the button is pressed, so there is no gap between the
 * gesture and the recording for a pointer move to slip through — and the position
 * now IS the position they pressed it from. Which is also the whole of
 * "branch-on-edit-at-old-step": `landStep` parents the row at the position and
 * `appendStep` appends, so editing while standing three rows back mints a child of
 * THAT row and leaves everything below it exactly where it was. Nothing here does
 * anything about branching, because branching is what appending already is.
 *
 * AND THE POSITION MOVES ONTO IT AFTERWARDS, which is where this parts company
 * with the two functions above it. `RETAINED_BESIDE_YOU` says so once, in the
 * ledger, and `appendStep` obeys it — see that table's `edit` entry for why the
 * pointer must follow here where it must not follow a save.
 *
 * THE STEP ID IS AN ARGUMENT because the caller has already spent it: the ops file
 * is named after this step (`opsPayloadFor`), so minting a second one here would
 * leave the file named after a row nobody created. `ReadRequest.stepId`'s
 * arrangement exactly, and `landStep` spends it only on an append — which is every
 * time, since `reRunTarget` cannot reach an irreplaceable step.
 */
export async function recordBookEdit(
  dir: string,
  payload: string,
  params: LedgerParams,
  stepId: string,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const view = await withManifest(resolved, async (manifest) => {
    const landing = await landStep(manifest, {
      action: 'edit',
      parent: null,
      payload,
      params,
      createdAt: Date.now(),
      id: stepId,
    });
    if (landing === null) {
      throw new ProjectError(
        `${path.basename(resolved)} has no recorded history for these changes to be filed against — `
        + 'this app has no record of the document it was built on, so there is no step to hang them '
        + 'off. Opening the book from Home imports it and gives this project an origin.',
      );
    }
    await writeManifest(resolved, manifest);
    return viewOf(manifest, landing.ledger);
  });
  announceProjects();
  return view;
}

/**
 * AMEND the tip edit step's own file to a new list — the manifest half of
 * `amendBookOps` (electron/book.ts, which owns the ruling and the refusals'
 * argument).
 *
 * THE TIP IS PROVED INSIDE THE MANIFEST LOCK, which is the whole reason this is
 * here rather than in book.ts: whether the position is still an amendable tip is
 * a fact that can change between a pane's load and its Apply (a translate
 * landing makes a child), and the only place the answer cannot move again before
 * the write is under `withManifest`. The ops file is rewritten atomically FIRST,
 * then the count on the step — a crash between the two leaves a file that says
 * more or less than the label counts, which the next open reads correctly
 * anyway, because the file is the truth and the count is a label.
 */
export async function recordBookEditAmend(
  dir: string,
  bytes: string,
  count: number,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const view = await withManifest(resolved, async (manifest) => {
    const held = ledgerOf(manifest);
    const standing = positionOf(held);
    if (standing === null || standing.action !== 'edit') {
      throw new ProjectError(
        'The changes could not be added to the step you are standing on — it is not a row of '
        + 'applied changes. Press Apply again and they land as a step of their own.',
      );
    }
    if (held.steps.some((step) => step.parent === standing.id)) {
      throw new ProjectError(
        'Something has been made from the step you are standing on since the book was opened, so '
        + 'its changes are history now and cannot be rewritten. Press Apply again and the new '
        + 'changes land as a step of their own.',
      );
    }
    await writeAtomically(
      path.join(resolved, ...standing.payload.split('/')),
      Buffer.from(bytes, 'utf8'),
    );
    const row = manifest.ledger?.steps.find((step) => step.id === standing.id);
    if (row !== undefined) row.params = { ...row.params, ops: count };
    await writeManifest(resolved, manifest);
    return viewOf(manifest);
  });
  announceProjects();
  return view;
}

/**
 * THE PATCH EVERY PRODUCT MADE FROM THIS POSITION CARRIES — the chain, read off
 * the disk and merged.
 *
 * ── Where the split falls, and why it falls there ───────────────────────────
 *
 * The WALK and the MERGE are pure and live in shared/ledger.ts, where a test can
 * reach the rule that decides whose title a book ends up with. What is here is
 * the part that cannot be: opening the payload files. Each one is a few hundred
 * bytes and a project holds a handful, so this is cheap enough to ask on the way
 * into every export.
 *
 * A PATCH THAT WILL NOT READ IS A NAMED CONSOLE LINE AND NOT A THROW. The step
 * says an edit happened and the file behind it is unreadable — that is worth
 * seeing in a terminal, and it is not worth failing an export somebody is waiting
 * on: the book comes out carrying every other correction, which is strictly more
 * of what they asked for than no book at all.
 */
export async function metadataForProduct(
  dir: string,
  kind: MetadataPatch['kind'],
  /** The step the job captured at enqueue, or null for the position now. */
  from: string | null = null,
): Promise<Record<string, string>> {
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    // A catalogue that will not parse says nothing about metadata either. The
    // run that is about to happen has its own reasons to fail or not; this is not
    // one of them.
    return {};
  }
  const patches: MetadataPatch[] = [];
  for (const step of metadataInEffect(ledgerOf(manifest), from)) {
    // Project-relative with forward slashes, split on its own separator and
    // joined for this platform — never matched by basename, which is the rule a
    // project holding several `<uuid>.json` files under different folders makes
    // load-bearing.
    const file = path.join(dir, ...step.payload.split('/'));
    try {
      // `readJson` for the byte-order mark, which is what it is for: a patch
      // file a person opened in an editor and saved again comes back with one,
      // and `JSON.parse` on those bytes fails on the first character.
      const read = readJson(await fsp.readFile(file, 'utf8')) as MetadataPatch | null;
      if (read === null || (read.kind !== 'epub' && read.kind !== 'pdf')
        || typeof read.fields !== 'object' || read.fields === null) {
        console.error(
          `[projects] ${path.basename(dir)}: the record behind “${step.label}” is not a metadata `
          + 'patch, so that edit is not being applied to what is being made.',
        );
        continue;
      }
      patches.push({ kind: read.kind, fields: read.fields });
    } catch (err) {
      console.error(
        `[projects] ${path.basename(dir)}: the record behind “${step.label}” could not be read `
        + `(${(err as Error).message}), so that edit is not being applied to what is being made.`,
      );
    }
  }
  return mergedMetadata(patches, kind);
}

/**
 * The position of this project, or null when it has no history — the fact a job
 * captures at ENQUEUE.
 *
 * NEVER THROWS. A catalogue that will not parse is a project whose next action
 * cannot be filed against anything, and refusing to queue a three-hour reading
 * because a JSON file is malformed would be this bookkeeping deciding whether the
 * user gets to read their book. Null lands on `landStep`'s fallback, which is the
 * position at the moment the run comes home.
 */
export async function positionStepId(dir: string): Promise<string | null> {
  try {
    return positionOf(ledgerOf(await readManifest(dir)))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * In-flight appends per records file, so two corrections a second apart cannot
 * both read the file and write back over each other.
 *
 * Serialised per file, because two edits half a second apart are the ordinary
 * gesture stream and a read-modify-write that overlapped would drop the first.
 */
export const recordEditWrites = new Map<string, Promise<void>>();

/**
 * THE CORRECTION ITSELF — one keyless human row, appended to a translate step's
 * records file.
 *
 * ── Why this is a function of a STEP and not of a document ──────────────────
 *
 * Because the door that had one is deleted. The EPUB pane resolved a step from a
 * cast's path (`recordTranslationEdit`, gone with the iframe reader); the
 * renderer's aligned view starts from THE POSITION — there is no file on disk it
 * is editing, only the book file main materialised and the ops chain over it — and
 * resolves the step through `translationInEffect` (electron/book.ts,
 * `correctBookBlock`). One step, one append, one serialisation lock, and now one
 * door: a translation's words live in exactly one file and are written from
 * exactly one place.
 *
 * ── `parts` IS A BLOCK ID, AND THE OLD SPELLING IS STILL READ BACK ─────────
 *
 * The pane writes a BLOCK ID, which is what the book file names its rows. Records
 * written by the deleted EPUB door spell `page:order[:part]`, and the lookup still
 * tries the book's ids first and that spelling second (`translationWords`,
 * shared/records.ts) — nothing writes the old vocabulary any more, and every file
 * that already holds it goes on being read.
 *
 * The word checks below are common to both because they are about the WORDS:
 * empty is not a correction, and control characters are not text a book can hold.
 */
export async function recordCorrection(
  dir: string,
  step: LedgerStep,
  parts: string,
  text: string,
  busy: (recordsFile: string) => string | null = () => null,
): Promise<string> {
  const records = translationRecordsOf(step);
  if (records === null) {
    // D2's export refusal, continued at the third door: the legacy row's words
    // exist only inside the book its run wrote.
    throw new ProjectError(
      `“${step.label}” was made before Foundry kept a translation as records, so a corrected `
      + 'sentence has nowhere durable to be recorded — the edit is in this copy of the book and '
      + 'will not survive it being cast again. To make corrections that keep, translate again from '
      + 'the step it was made from; everything after that is free.',
    );
  }
  if (text.trim().length === 0) {
    throw new ProjectError(
      'A correction with no words in it is not a correction. Removing a block is a strike, made on '
      + 'the source book.',
    );
  }
  // Newlines are legal — the dialect keeps a poem's line breaks — and every
  // other control character is refused: JSON.stringify would carry one
  // faithfully into the file, and from there into somebody's book.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    throw new ProjectError('That correction contains control characters, which no book\'s text can hold.');
  }

  const file = path.join(deletableProjectDir(dir), ...records.split('/'));
  const held = busy(file);
  if (held !== null) throw new ProjectError(held);
  const key = fold(file);
  const previous = recordEditWrites.get(key) ?? Promise.resolve();
  const write = previous.then(
    () => appendCorrection(file, parts, text),
    () => appendCorrection(file, parts, text),
  );
  const settled = write.then(() => { /* kept */ }, () => { /* kept */ }).then(() => {
    if (recordEditWrites.get(key) === settled) recordEditWrites.delete(key);
  });
  recordEditWrites.set(key, settled);
  return write.then(() => file);
}

/**
 * THE APPEND AND THE RESTAMP, AS ONE ACT — because they are one act.
 *
 * ── What separating them cost, measured ─────────────────────────────────────
 *
 * A cleanup's stamp is a receipt for a RECORDS FILE (`narrationStampFileFor`), and
 * this is the only door that changes a records file after the run that stamped it
 * has finished. While the append stood alone, correcting a heading in the aligned
 * view moved the book and left the receipt behind, and the export refused weeks
 * later naming blocks nobody had edited — Owen's Pokemon book, where two hand
 * corrections made on 11 September were held against a stamp written on the 8th.
 * See electron/narration-stamp.ts for the measurement and for why re-deriving the
 * digest is the existing ruling rather than a new one.
 *
 * INSIDE THE SAME LOCK AND AFTER THE APPEND. The lock, because the stamp is a
 * read-modify-write of a second file that the same two rapid gestures both touch,
 * and a receipt serialised separately from the answers it is about is a receipt
 * that can be written from the older of two corrections. After, because the
 * records file is the thing of record: an append that lands with no restamp behind
 * it is a stamp one block out of date, which the compile catches by name, and a
 * restamp that landed with no append behind it would be a stamp asserting words
 * that are in no file at all.
 *
 * A RESTAMP THAT FAILS DOES NOT LOSE THE CORRECTION. The person's words are on
 * disk by then and the pane is about to show them; what a throw here would undo is
 * nothing, and what it would cost is the correction appearing to have failed. So
 * it is reported to the terminal and the gesture stands — and the state it leaves
 * behind is the state this whole function exists to fix, said out loud, with the
 * export's own refusal waiting at the other end to say it again.
 */
export async function appendCorrection(file: string, parts: string, text: string): Promise<void> {
  await appendHumanRow(file, parts, text);
  let stamp: string;
  try {
    stamp = narrationStampFileFor(file);
  } catch {
    // Not a records file by name. `appendHumanRow` has already accepted it, and
    // deciding here that it was never a records file would be a second opinion.
    return;
  }
  try {
    const outcome = await restampCorrection(stamp, parts, text);
    if (outcome === 'unreadable') {
      console.error(
        `[projects] ${stamp} could not be read as a narration stamp, so the correction to ${parts} `
        + 'is in the words and not in the receipt. An export from this cleanup will refuse naming '
        + 'that block until the cleanup is run again.',
      );
    }
  } catch (err) {
    console.error(
      `[projects] ${stamp} could not be brought up to date with the correction to ${parts} `
      + `(${err instanceof Error ? err.message : String(err)}). The words are recorded; an export `
      + 'from this cleanup will refuse naming that block until the cleanup is run again.',
    );
  }
}

export async function appendHumanRow(file: string, parts: string, text: string): Promise<void> {
  let existing: string;
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    // A missing records file is not an empty one — the step's payload has been
    // swept or moved, and inventing a file here would put one paragraph of
    // Hungarian where a whole translation is supposed to be.
    throw new ProjectError(
      'The translation\'s records file is not where this project says it is, so the correction '
      + 'cannot be recorded. Translate again from the step this book was made from.',
    );
  }
  const row = `${JSON.stringify({ parts, text, author: 'user' })}\n`;
  const joined = existing.length === 0 || existing.endsWith('\n')
    ? existing + row
    : `${existing}\n${row}`;
  await writeAtomically(file, Buffer.from(joined, 'utf8'));
}
