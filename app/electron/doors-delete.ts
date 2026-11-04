/**
 * doors-delete — deleting a project, a document, an export or a step: the proofs, the cards and the work.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import * as queue from './job-queue';
import {
  deletableStep,
  deleteDocument,
  deleteProject,
  deleteStep,
  describeStepDelete,
  documentAssets, inspectProject,
  type DocumentRemoval,
  type ProjectInventory, listProjects, readStepLedger
} from './projects';
import {
  forgetRecentsUnder
} from './recents';
import { fold, isBook } from '../shared/original';
import { rowMinting } from '../shared/pending';
import type {
  DeletionPrompt,
  DocumentDeletion, ProjectDocument,
  ProjectFacsimile,
  ProjectFinal, ProjectSummary
} from '../shared/types';
import { rowsIn, refuseRunningGhost, promisedDeletion } from './doors-ledger';

/**
 * Whether a path sits inside a directory, on Windows' terms.
 *
 * Case-insensitively and separator-blind, because one folder is spelled three
 * ways here, and with the separator APPENDED to the folder first — so a project
 * called `Kershaw-a1b2c3d4` cannot claim a job writing into
 * `Kershaw-a1b2c3d4-notes` beside it and block a delete that has nothing to do
 * with it.
 *
 * Note what this is NOT: it is not the check that decides what may be erased.
 * That is `deletableProjectDir`, which proves a path is a direct child of the
 * projects directory. This one only answers "is that run writing in here".
 */
function within(dir: string, filePath: string): boolean {
  const fold = (target: string): string => path.resolve(target).replace(/\\/g, '/').toLowerCase();
  return fold(filePath).startsWith(`${fold(dir).replace(/\/+$/, '')}/`);
}

/**
 * A byte count as a person reads it — for the delete dialog, which has to say
 * how much of the disk is about to be handed back.
 *
 * Binary units, one decimal, and no `Intl` unit formatting: this goes into a
 * sentence that already reads plainly, and "1.4 GB" is the whole of what is
 * being communicated.
 */
function sizeOnDisk(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * DROP ONE STEP — the door a HOST reaches, and the one the handler runs.
 *
 * BookForge lists a Foundry export as a version nested under its parent book,
 * and Owen's ruling of 2026-09-17 makes those two rows one fact: deleting the
 * version there must drop the step here. That host lives in another process's
 * renderer and can never send this app's `ipcMain` message, so what it needs is
 * a FUNCTION — re-exported through `mount.ts` beside `exportEpubFromStep`.
 *
 * IT IS A HOLDER RATHER THAN THE BODY ITSELF because the body belongs to
 * `registerIpc`'s scope: the two proofs it must run (`refuseBusyStepDelete`,
 * and `refuseBusyJob` under it) close over locals there. Lifting those to module
 * scope to satisfy this caller would be rearranging the file around its newest
 * reader. So the body is assigned once, where it is written, and this is the
 * only way in from outside — which keeps ONE body rather than a copy shaped like
 * it. A copy would have to carry the ghost branch, both busy proofs and the
 * subtree cascade, and the first edit to either would leave a press in Foundry
 * and a press in BookForge deleting different things.
 *
 * THE BODY MOVED HERE WITH ITS PROOFS on 2026-11-04 (FOUNDRY-CORE-PLAN step 2),
 * and the holder stayed for the paragraph below: `registerIpc` arms it
 * (`openStepDeleteDoor`, and `openExportDeleteDoor` for the export's) at the
 * point the body used to be assigned, so nothing about when it answers changed.
 *
 * BEFORE `registerIpc` RUNS IT REFUSES BY NAME. Answering "deleted" from an app
 * that has not mounted would be the silent success this codebase refuses
 * everywhere else.
 */
let stepDeleteDoor: ((projectDir: string, stepId: string) => Promise<unknown>) | null = null;

export function deleteLedgerStep(projectDir: string, stepId: string): Promise<unknown> {
  if (stepDeleteDoor === null) {
    return Promise.reject(new Error(
      'Foundry has not been mounted, so there is no ledger to delete a step from. '
      + '`mountFoundry` must run before a host can drop a step.'));
  }
  return stepDeleteDoor(projectDir, stepId);
}

/**
 * DELETE ONE EXPORT FOR A HOST — the file in `final/` and its `manifest.final`
 * row, nothing else. A holder for the same reason `deleteLedgerStep` is one:
 * the body's busy proof lives in `registerIpc`'s scope, and this keeps one body.
 */
let exportDeleteDoor: ((filePath: string) => Promise<DocumentRemoval>) | null = null;

export function deleteExport(filePath: string): Promise<DocumentRemoval> {
  if (exportDeleteDoor === null) {
    return Promise.reject(new Error(
      'Foundry has not been mounted, so there is no library to delete an export from. '
      + '`mountFoundry` must run before a host can delete one.'));
  }
  return exportDeleteDoor(filePath);
}

/**
 * The two refusals, in one place because both callers owe both of them.
 *
 * NEITHER IS ADVISORY. `describe` runs them so the app does not put a warning
 * on screen for something it is going to refuse a click later; `delete` runs
 * them because that is where the authorization has to be. A renderer's word
 * about what is open or what is queued is not a fact main may act on when the
 * action is a recursive delete.
 */
function refuseProjectDelete(project: { dir: string; title: string }): void {
  refuseBusyJob(project);
}

/**
 * The narrower refusal: a job writing into this folder, and nothing else.
 *
 * IT IS SPLIT OUT BECAUSE A DOCUMENT DELETE OWES ONLY THIS HALF. Deleting the
 * whole project while any book from it is open is a working tree pulled out
 * from under a reader; deleting ONE generated file while a DIFFERENT document
 * of the same project is open is the ordinary case — read the scan, throw away
 * the EPUB you did not like — and refusing it because something else in the
 * folder happened to be open would make the button useless exactly when it is
 * wanted. The renderer closes the file's own tab before asking (open-documents).
 *
 * THREE CALLERS NOW, AND THEY SHARE THE FACT RATHER THAN THE SENTENCE. What is
 * the same for all of them is finding the job: which run is about to write into
 * this folder, and whether it is going or waiting. What differs is the
 * CONSEQUENCE — a project delete erases the folder the engine is writing into, a
 * step delete destroys a payload it may be in the middle of producing — so the
 * clause after "so" is the caller's, and everything before it is written once
 * here. A second copy of the job search is how the day comes that one of them
 * learns about a new job state and the other does not.
 */
export function refuseBusyJob(
  project: { dir: string; title: string },
  /** The clause after "so", ending in what to do about it. */
  consequence = `“${project.title}” cannot be deleted — the engine is writing into that `
    + 'folder from another process, and erasing it underneath would leave half a project on '
    + 'disk and a run writing into nothing. Cancel it in the shelf first, then delete.',
): void {
  /*
   * A JOB WRITING INTO IT IS THE SAME HAZARD AS AN OPEN BOOK, and worse in
   * one way: the engine is a separate process holding a file open in
   * `generated/`, so the recursive remove fails PART WAY on Windows and
   * leaves a project half erased — while the run carries on writing into a
   * directory the catalogue no longer describes.
   *
   * Every state but `held`, `queued` and `running` is finished with the
   * folder: a done, failed or cancelled row names a path nothing is holding.
   *
   * `held` counts even though nothing is writing yet. It is a job CONFIGURED
   * to write here — the output path is already chosen and the readings bank
   * already named — so deleting the folder under it would leave a row in the
   * shelf that fails the moment somebody presses Start, for a reason nothing
   * in the error would connect to a project they erased ten minutes earlier.
   */
  const busy = queue.listJobs().find((job) =>
    (job.state === 'running' || job.state === 'queued' || job.state === 'held')
    && within(project.dir, job.outputPath));
  if (busy !== undefined) {
    throw new Error(
      `A ${busy.kind} job is ${busy.state === 'running' ? 'running' : 'waiting to run'} into `
      + `“${project.title}” right now, so ${consequence}`,
    );
  }
}

/**
 * The warning, composed where the facts are.
 *
 * Every sentence the native box used to carry, kept verbatim — the size on
 * disk, the readings bank, the filed copy, and the flat statement that this is
 * a real delete. The only thing that changed is that it comes back as data
 * instead of being drawn by the OS.
 */
function describeProject(project: ProjectInventory): DeletionPrompt {
  /*
   * THE BANK IS THE COST RULE IN ITS PUREST FORM (`ProjectStep.costly`). It is
   * the stored result of the expensive pass — which is exactly why a rerun is
   * free, and exactly why nothing in this app ever sweeps it. Erasing it is
   * the one loss in a project delete that no amount of time gets back.
   */
  const bank = project.readings > 0
    ? `It holds a readings bank of ${project.readings.toLocaleString()} pages the model has `
      + 'already read. That is hours of GPU, it is the one thing in here that cannot be made '
      + 'again from anything else on this disk, and once it is gone a future conversion of this '
      + 'book pays for every page from scratch.'
    : 'There is no readings bank in it, so nothing in here costs GPU-hours to make again.';
  /*
   * AND THE CURATION, which is the one thing in here that is IRREPLACEABLE
   * rather than merely expensive (`ProjectStep.retention`). A bank can be read
   * again for money and hours. A person going through four hundred pages
   * saying which blocks are running heads and where the chapters start cannot
   * be reproduced by anything, at any price, and it is quoted before the bank
   * for exactly that reason.
   */
  const curation = project.amendments > 0
    ? `It also holds ${project.amendments.toLocaleString()} corrections you made by hand about `
      + 'the blocks on those pages — strikes, categories, wording and chapter starts. Nothing '
      + 'can make those again: they are judgements about the book, not output.'
    : '';
  const filed = project.filed
    ? ' The copy you filed into this project\'s own folder is inside it and goes with it.'
    : '';
  const made = project.documents === 0
    ? 'nothing has been made from it yet'
    : project.documents === 1
      ? 'the one document Foundry has made from it'
      : `the ${project.documents} documents Foundry has made from it`;
  return {
    message: `“${project.title}” will be deleted from this computer.`,
    detail: [
      /*
       * THE IMPORT LEADS, because it is the most expensive thing in the folder
       * and the only one that is IRREPLACEABLE rather than merely costly
       * (`ProjectStep.costly`). A model pass can be run again for money and
       * hours; the file the user handed over came from somewhere only they
       * know, and Foundry treats it as the only copy in the world.
       */
      'The file you imported goes with it. Foundry keeps no other copy of it and cannot '
      + 'fetch it again — wherever you got it from is the only place it still exists.',
      `${project.dir} and everything under it goes: ${made}, every working copy and every `
      + `edit in them, and the undo history. ${sizeOnDisk(project.bytes)} in all.${filed}`,
      ...(curation.length > 0 ? [curation] : []),
      bank,
      'This is a real delete. The folder is removed from the disk — it is not moved aside, '
      + 'Foundry keeps no copy of it anywhere else, and there is nothing that will bring it back.',
    ],
    confirm: 'Delete this project',
  };
}

/** `projects:describe`. */
export async function describeProjectDelete(dir: string) {
  const project = await inspectProject(dir);
  refuseProjectDelete(project);
  return describeProject(project);
}

/** `projects:delete`. */
export async function deleteProjectFolder(dir: string) {
  const project = await inspectProject(dir);
  refuseProjectDelete(project);

  await deleteProject(project.dir);
  // The recents list is keyed by file and a project is a folder of them, so
  // every row pointing inside goes with it. Otherwise the app would keep a
  // last-opened time for — and `listProjects` would keep dating a row by — a
  // book whose bytes it destroyed a moment ago.
  forgetRecentsUnder(project.dir);
  return `Deleted “${project.title}”. ${project.dir} and everything in it is gone from this computer.`;
}

/**
 * One document out of a project: what would happen, and then doing it.
 *
 * THE ORIGINAL IS NOT DELETABLE ON ITS OWN, and that is the whole reason this
 * pair describes before it acts. Every other document in a project was made
 * FROM the original; erasing it leaves a folder of outputs with no source,
 * which is not a project any more. So `describe` reports `original: true` and
 * hands back the PROJECT's warning, and `delete` refuses that path outright —
 * the renderer is expected to run the project delete instead, and a renderer
 * that ignored the flag gets a sentence rather than a half-emptied folder.
 *
 * `shared/original.ts` decides which document that is, and both sides import
 * it: the flag main sets and the row the nav draws come from one rule.
 *
 * The listing comes from `listProjects`, which is the one function that says
 * what a project contains — the same answer Home and the side nav are drawn
 * from, so a row the user can see is a row this can find.
 */
async function findDocument(filePath: string): Promise<{
  project: ProjectSummary;
  document: ProjectDocument;
}> {
  const target = fold(filePath);
  for (const project of await listProjects()) {
    const document = project.documents.find((row) => fold(row.path) === target);
    if (document !== undefined) return { project, document };
  }
  throw new Error(
    `${filePath} is not a document in any of Foundry's projects, so there is nothing here to `
    + 'delete. Files outside the library are the file manager\'s business, not this app\'s.',
  );
}

/**
 * The same question asked of the TRAY, which is a different catalogue.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * The library tree draws a ✕ on export rows, and every one of them threw:
 * `findDocument` searches `project.documents` — the CHAIN, what each step
 * produced — while an export row comes from `manifest.final` by way of
 * `filedDocuments`. Two catalogues, and the delete only knew one, so pressing
 * the ✕ on a file this app had just made produced "is not a document in any
 * of Foundry's projects" — a sentence written for a path somebody typed from
 * outside the library, shown for a row the app drew from its own manifest.
 *
 * ── Why a separate door instead of teaching `findDocument` about final/ ─────
 *
 * Because an export is not a document in the sense the delete pair means. It
 * has no steps, no retention, no origin; it can never be the book the project
 * is built on; nothing was made FROM it. Folding it into the document lookup
 * would put a row in front of `isBook`, `documentAssets` and the original's
 * refusal — three questions that have no answer for a file in the tray — and
 * the first one to guess would be a bug nobody could see coming.
 *
 * `final/` is the user's own tray (`projects.ts`, `filedDocuments`): they may
 * have already moved it onto a reader or deleted it themselves, which is why
 * a row whose file has gone is a REMOVAL and not an error.
 */
async function findExport(filePath: string): Promise<{
  project: ProjectSummary;
  made: ProjectFinal;
  label: string;
} | null> {
  const target = fold(filePath);
  for (const project of await listProjects()) {
    for (const made of project.exports) {
      // Whole paths, never basenames — this project holds `generated/Book.pdf`
      // and `final/Book.pdf` at once, and the layer is the only thing telling
      // them apart. The oldest house rule in this codebase.
      if (fold(path.join(project.dir, ...made.file.split('/'))) !== target) continue;
      return { project, made, label: path.basename(made.file) };
    }
  }
  return null;
}

/**
 * And the same question asked of the FACSIMILES, which is a third catalogue —
 * or rather a third listing, since nothing catalogues these at all.
 *
 * ── The same bug, one row further down the tree ─────────────────────────────
 *
 * The nav draws a ✕ on facsimile rows exactly as it draws one on exports, and
 * every one of them threw the sentence written for a path somebody typed from
 * outside the library. A facsimile is in NEITHER of the two lookups above it:
 * `project.documents` is the chain and `project.exports` is `manifest.final`,
 * while `ProjectSummary.facsimiles` is composed by scanning `generated/` for
 * the name each read step's id makes (`facsimilesOf`, electron/projects.ts).
 * Three listings, and the delete knew two.
 *
 * ── Why a third door and not a branch in either of the others ───────────────
 *
 * `findExport`'s argument, and it applies harder here. An export at least has a
 * row in the manifest; a facsimile has nothing — no steps, no retention, no
 * origin, nothing made FROM it, and no catalogue entry to strike out. Every
 * question the document path asks (`isBook`, `documentAssets`, the original's
 * refusal) is a question with no answer for a page-for-page reprint, and the
 * first one to guess would be the bug nobody sees coming.
 *
 * AND IT IS THE CHEAPEST THING IN THE PROJECT TO LOSE, which is why its card is
 * one line shorter than an export's: the bank it reprints is kept whatever
 * happens, so the reprint is seconds of offline arithmetic away for as long as
 * the reading exists.
 */
async function findFacsimile(filePath: string): Promise<{
  project: ProjectSummary;
  made: ProjectFacsimile;
  label: string;
} | null> {
  const target = fold(filePath);
  for (const project of await listProjects()) {
    for (const made of project.facsimiles) {
      // Whole paths with their layer, never basenames — the same rule spelled
      // out above `findExport`, and a facsimile lives in `generated/` beside a
      // cast and a rotated predecessor of itself.
      if (fold(path.join(project.dir, ...made.file.split('/'))) !== target) continue;
      return { project, made, label: path.basename(made.file) };
    }
  }
  return null;
}

/** `documents:describe`. */
export async function describeDocumentDelete(filePath: string): Promise<DocumentDeletion> {
  /*
   * THE TRAY IS ASKED FIRST, and the question it gets is its own. Removing an
   * export takes the file and its row and nothing else: no chain to unpick, no
   * working tree, no history, and nothing was ever made from it. Saying so in
   * one sentence is the honest card — the document card's paragraph about the
   * readings bank surviving would be reassurance about a danger that was never
   * on the table.
   */
  const filed = await findExport(filePath);
  if (filed !== null) {
    // `final/` is the user's own tray, so the file may legitimately not be
    // there — moved onto a reader, handed to somebody, deleted by hand. That
    // is a row to clear, not an error to raise, and it changes the sentence.
    const gone = await fsp.access(filePath).then(() => false, () => true);
    return {
      prompt: {
        message: `“${filed.label}” will be removed from “${filed.project.title}”.`,
        detail: [
          gone
            ? 'That file is no longer on the disk — moved or deleted somewhere else — so this '
              + 'clears the row that still lists it.'
            : 'The file is deleted from the disk. Foundry keeps no copy of it anywhere else.',
          'Nothing else changes: this is one of the finished documents you exported, and the '
          + 'book, its readings and every step it was made from stay exactly as they are. You '
          + 'can export it again at any time.',
        ],
        confirm: gone ? 'Remove this row' : 'Delete this export',
      },
      original: false,
      projectDir: filed.project.dir,
      missing: gone,
    };
  }

  /*
   * THEN THE REPRINTS, and their card is the shortest one in this app because
   * there is genuinely almost nothing to warn anybody about. A facsimile is a
   * rendering of a bank that is kept whatever else happens: no step points at
   * it, nothing was made from it, and the reading it reprints is untouched by
   * its going. Saying so plainly is the honest card — the document card's
   * paragraph about the bank surviving reads as reassurance about a danger that
   * was never on the table, which is how people learn to skip these.
   */
  const reprint = await findFacsimile(filePath);
  if (reprint !== null) {
    // The listing stats before it draws a row, so this is the window between
    // that stat and this click — somebody tidying `generated/` by hand, a
    // window holding a tree from a minute ago. A row to clear, not an error.
    const gone = await fsp.access(filePath).then(() => false, () => true);
    return {
      prompt: {
        message: `“${reprint.label}” will be deleted from “${reprint.project.title}”.`,
        detail: [
          gone
            ? 'That file is no longer on the disk — moved or deleted somewhere else — so this '
              + 'clears the row that still lists it.'
            : 'The file is deleted from the disk. Foundry keeps no copy of it anywhere else.',
          'The readings bank and every step in this project stay exactly as they are. This is '
          + 'the pages of one reading reprinted, nothing is made from it, and you can make it '
          + 'again from that reading at any time — it costs seconds and no GPU.',
        ],
        confirm: gone ? 'Remove this row' : 'Delete this facsimile',
      },
      original: false,
      projectDir: reprint.project.dir,
      missing: gone,
    };
  }

  const { project, document } = await findDocument(filePath);
  const inventory = await inspectProject(project.dir);

  if (isBook(project.documents, document.path, project.dir)) {
    // The original's delete IS the project's, so it owes the project's
    // refusals — including the open-book one this file's own delete does not.
    refuseProjectDelete(inventory);
    const prompt = describeProject(inventory);
    return {
      prompt: {
        ...prompt,
        message: `“${document.label}” is the original this project is built on.`,
        detail: [
          'Deleting it deletes the whole project — every document in this folder was made from '
          + 'it, and what would be left is a set of outputs with nothing they came from.',
          ...prompt.detail,
        ],
      },
      original: true,
      projectDir: project.dir,
      missing: document.missing,
    };
  }

  refuseBusyJob(inventory);
  const gone = document.missing
    ? 'That file is already gone from the disk; what is left is its row in this project\'s '
      + 'catalogue, and this clears it.'
    : `${document.path} is removed from the disk. It is not moved aside and Foundry keeps no `
      + 'copy of it anywhere else.';

  /*
   * WHAT ELSE GOES, NAMED. A delete that quietly takes more than the thing it
   * was pointed at is the exact surprise these cards exist to prevent — and
   * "5 earlier versions" is not a detail, it is most of what is about to be
   * removed by weight. Where nothing extra goes, nothing extra is said: a
   * sentence listing zero of three things reads as boilerplate and teaches
   * people to skip the paragraph that matters.
   */
  const extras = await documentAssets(document.path);
  const also: string[] = [];
  if (extras.archivedVersions > 0) {
    also.push(extras.archivedVersions === 1
      ? 'the one earlier version of it a rerun set aside'
      : `the ${extras.archivedVersions} earlier versions of it that reruns set aside`);
  }

  return {
    prompt: {
      message: `“${document.label}” will be deleted from “${project.title}”.`,
      detail: [
        gone,
        ...(also.length > 0
          ? [`${sentenceList(also)} ${also.length === 1 ? 'goes' : 'go'} with it — everything in `
            + 'this project that belongs to this document and to nothing else.']
          : []),
        'The project and everything else in it stays, including the original and the readings '
        + 'bank — the hours of GPU that let this document be made again by converting the book a '
        + 'second time.',
      ],
      confirm: document.missing ? 'Remove this row' : 'Delete this document',
    },
    original: false,
    projectDir: project.dir,
    missing: document.missing,
  };
}

/** `a`, `a and b`, `a, b and c` — the app writes sentences, not bullet lists. */
function sentenceList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/*
 * THE HOST'S DOOR ONTO THE SAME DELETE, for one export in `final/`. Owen,
 * 2026-09-28: deleting an EPUB on BookForge's screen deletes THAT EPUB —
 * its file here and its row in `manifest.final` — and nothing upstream of
 * it. BookForge used to drop the STEP the export was cast from instead,
 * which took an AI-cleanup pass and its history with it and left the nav
 * drawing an export whose file was gone.
 *
 * The busy proof when the tray still lists it; `deleteDocument` either way,
 * because a row whose file already left is exactly the one worth striking.
 */
async function deleteExportBody(filePath: string): Promise<DocumentRemoval> {
  const filed = await findExport(filePath);
  if (filed !== null) refuseBusyJob(filed.project);
  const removed = await deleteDocument(filePath);
  forgetRecentsUnder(filePath);
  return removed;
}

/** Arms `deleteExport`'s holder — registerIpc calls it where the body used to be assigned. */
export function openExportDeleteDoor(): void {
  exportDeleteDoor = deleteExportBody;
}

/** `documents:delete`. */
export async function deleteDocumentFile(filePath: string) {
  /*
   * The tray again, and asked again rather than trusted from the describe —
   * same rule as the busy-job proof below: this is the call that unlinks
   * something, and the catalogue may have moved under it.
   *
   * `deleteDocument` already does exactly the right thing with a `final/`
   * path: it strikes the row out of `manifest.final` by LAYER (`inLayer`),
   * removes the file, and sweeps nothing else, because an export has no
   * working tree, no archived predecessors and no history to sweep. Only the
   * lookup above it was blind.
   */
  const filed = await findExport(filePath);
  if (filed !== null) {
    /*
     * THE BUSY PROOF COSTS A QUEUE LOOKUP, NOT AN INVENTORY. This line paid
     * `inspectProject` for years of habit — a recursive byte-measure of the
     * whole project plus a line-count of every bank — to hand a function
     * that reads `{dir, title}` against the QUEUE. On a captured project
     * that walk is hundreds of files including a shoot's worth of
     * photographs, and through a cold antivirus it is tens of milliseconds
     * a stat: Owen pressed Delete on one EPUB and watched nothing happen
     * for thirty seconds (2026-08-23). The summary in hand already carries
     * both fields.
     */
    refuseBusyJob(filed.project);
    const removed = await deleteDocument(filePath);
    forgetRecentsUnder(filePath);
    return removed.wasMissing
      ? `Removed “${filed.label}” from “${filed.project.title}” — the file was already gone.`
      : `Deleted “${filed.label}” from “${filed.project.title}”.`;
  }

  /*
   * The reprints, asked again for the same reason the tray is: this is the call
   * that unlinks something and the listing may have moved under it.
   *
   * `deleteDocument` is already right for a `generated/` facsimile, and it is
   * right by construction rather than by luck. THE MANIFEST NEEDS NOTHING DONE
   * TO IT: a facsimile is in no list in `project.json`, so the documents filter
   * matches no chain (nothing names this file as a step's payload), and
   * `working.files` and `final` are asked only about their own layers. THE ROW
   * GOES BECAUSE THE FILE DOES: `facsimilesOf` composes the name from the read
   * step's id and stats it, so the listing is the directory's answer and a
   * deleted file is a listing with one fewer row in it the next time anything
   * asks. And the SWEEP is exactly what it should be: the archived copies of
   * this same name beside it, which for a name carrying a step's own id can
   * only be earlier reprints of that same reading.
   */
  const reprint = await findFacsimile(filePath);
  if (reprint !== null) {
    // The cheap busy proof, for the export branch's measured reason.
    refuseBusyJob(reprint.project);
    const removed = await deleteDocument(filePath);
    forgetRecentsUnder(filePath);
    return removed.wasMissing
      ? `Removed “${reprint.label}” from “${reprint.project.title}” — the file was already gone.`
      : `Deleted “${reprint.label}” from “${reprint.project.title}”.`;
  }

  const { project, document } = await findDocument(filePath);
  // Proven again, not trusted from the describe: a job can be queued between
  // the question and the answer, and this is the call that unlinks something.
  // The proof reads the queue, so it is handed the summary and not an
  // inventory — the export branch above carries the thirty seconds that
  // distinction was measured to cost.
  refuseBusyJob(project);

  if (isBook(project.documents, document.path, project.dir)) {
    throw new Error(
      `“${document.label}” is the original “${project.title}” is built on, so it cannot be `
      + 'deleted by itself — every other document in the folder was made from it. Delete the '
      + 'project instead.',
    );
  }

  const removed = await deleteDocument(document.path);
  forgetRecentsUnder(document.path);
  return removed.wasMissing
    ? `Removed “${removed.label}” from “${removed.title}” — the file was already gone.`
    : `Deleted “${removed.label}” from “${removed.title}”.`;
}

/**
 * A job writing into this project, and a delete that would take its payload.
 *
 * ── Why the delete owes this and the other two calls do not ─────────────────
 *
 * A held, queued or running job is a run that HAS ALREADY CHOSEN where its
 * output goes: the bank is named, the EPUB's path is composed, and the parent
 * step was captured when somebody pressed the button. Deleting a step while one
 * waits is aimed at exactly the file that run is about to write — the reading
 * whose bank it is filling, or the translation whose EPUB it is composing — and
 * the two possible orders are both wrong. Destroy the payload first and the run
 * finishes into a folder whose catalogue no longer describes it, leaving hours
 * of GPU nothing in this app names. Let the run land first and it appends
 * against a parent this delete has just taken off the ledger, which `landStep`
 * survives by falling back to the position, but only by filing the work
 * somewhere nobody chose.
 *
 * SO THE STEP DELETE REFUSES, on the project delete's own terms and with the
 * same vocabulary — the shelf is where a person cancels a job, and the sentence
 * says so. Coarse on purpose: ANY job writing into this project, not just one
 * whose output happens to be a payload in the doomed subtree. The narrower test
 * would have to predict where a run that has not started will write, and being
 * clever about that is how a delete comes to race a job it decided was unrelated.
 *
 * ── THE OTHER TWO ARE NOT UNSAFE, AND REFUSING THEM WOULD BE ITS OWN BUG ────
 *
 * `ledger:go` writes one field of the manifest and touches nothing else. The
 * design already defends the case it looks dangerous in: a job captures its
 * parent at enqueue (`Job.parentStep`) and every path it will read or write at
 * PLAN time (`planRendering`), precisely so that clicking through the history
 * while a run waits cannot retarget it. Moving the pointer is a repaint, it is free, and
 * people do it while they wait — refusing it during a three-hour reading would
 * take the history panel away for the whole time it is most wanted, to prevent
 * nothing.
 *
 * `book:apply` writes `ops/<uuid>.jsonl`, a path no job can be about to
 * write, and appends a step of its own. It is the one action in this app that
 * retains IRREPLACEABLE work — somebody's judgements about four hundred blocks —
 * and refusing to let a person land those because a machine is busy would be
 * this app declining to keep the only thing in a project it cannot make again.
 * The interesting case is an Apply made while a re-read is running, and the
 * ledger already has the right answer for it: the payload is retained, and when
 * the reading lands and replaces its parent, `markStale` dims the step rather
 * than destroying it (the retention rule: user labour is never destroyed by a
 * re-run). That is the designed outcome, not a race.
 */
/*
 * THE OTHER REFUSAL IS NOT HERE, AND THAT IS DELIBERATE. A book this window has
 * open cannot have its working tree unlinked, and `describeStepDelete` and
 * `deleteStep` both refuse that case themselves (electron/projects.ts,
 * `refuseOpenPayload`) — because deciding it needs the sweep, which needs the
 * manifest, which is that module's. It is the document delete's model rather
 * than the project delete's: the narrow test on the tree this step's own payload
 * serves, plus the renderer closing the tab between the confirm and the call.
 */
async function refuseBusyStepDelete(projectDir: string, stepId: string): Promise<void> {
  // `deletableStep` proves the directory, names the step, AND runs the refusal
  // that never lifts — the origin is not a deletable step at any hour — so this
  // never tells somebody to cancel a job for a delete that would refuse them
  // afterwards anyway.
  const subject = await deletableStep(projectDir, stepId);
  refuseBusyJob(subject, `“${subject.label}” cannot be deleted yet — that run is about to write `
    + 'into this project, and destroying a step\'s files while it does would leave the job '
    + 'finishing into a history this app no longer has. Cancel it in the shelf, or let it land, '
    + 'then delete the step.');
}

/** `ledger:describe-delete`. */
export async function describeLedgerStepDelete(projectDir: string, stepId: string) {
  /*
   * A ghost first — but only where the ledger does NOT hold the id. A row can
   * still say `running` after the step it minted has landed (`admitPending`
   * carries that window's whole argument), and in it a real step's delete must
   * stay a real step's delete rather than becoming a refusal about a promise.
   */
  const held = await readStepLedger(projectDir);
  const real = held !== null && held.ledger.steps.some((step) => step.id === stepId);
  const promised = real ? null : promisedDeletion(projectDir, stepId);
  if (promised !== null) return promised;
  // Proven BEFORE the card is composed, so a warning is never put on screen for
  // something the delete would refuse a click later.
  await refuseBusyStepDelete(projectDir, stepId);
  return describeStepDelete(projectDir, stepId);
}

async function deleteStepBody(projectDir: string, stepId: string) {

  /*
   * A GHOST IS REMOVED FROM THE QUEUE, not deleted from a ledger it is not in.
   * A row still waiting leaves by `remove`; one already running leaves by
   * `cancel`, which is the only door a running row has. Hosted, both forward
   * to the host's queue, whose cascade takes the promised subtree with it; the
   * view that comes back is the ledger as it was, because nothing in it moved
   * — the tree's ghosts are derived from the rows and go with the next push.
   */
  const standing = await readStepLedger(projectDir);
  const promised = standing !== null && standing.ledger.steps.some((step) => step.id === stepId)
    ? null
    : rowMinting(rowsIn(projectDir), stepId);
  if (promised !== null) {
    /*
     * `remove`, WHICH TAKES THE SUBTREE — a host's own removal stops nothing
     * because nothing has begun, and drops every row chained behind it
     * (BookForge's `queue-engine.removeStep`); this app's does the same to its
     * own list. A RUNNING one never reaches this line: `refuseRunningGhost`
     * above turned the press into a sentence, because ending a run and
     * settling what happens to the work waiting on it is the queue's own door
     * and must not be two doors (Owen, 2026-09-08).
     */
    refuseRunningGhost(promised);
    queue.remove(promised.id);
    const view = await readStepLedger(projectDir);
    if (view === null) throw new Error(`${projectDir} has no history to show after the removal.`);
    return view;
  }
  // Proven again, never trusted from the describe: a job can be queued between
  // the question and the answer, and this is the call that unlinks something.
  await refuseBusyStepDelete(projectDir, stepId);
  return deleteStep(projectDir, stepId);
}

/** Arms `deleteLedgerStep`'s holder — registerIpc calls it where the body used to be assigned. */
export function openStepDeleteDoor(): void {
  stepDeleteDoor = deleteStepBody;
}
