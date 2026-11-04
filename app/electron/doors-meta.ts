/**
 * doors-meta — a document's own record: the metadata gates and the step a metadata edit lands as.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { admitted } from './openable';
import {
  writeEpubMetadata,
  writePdfMetadata
} from './engine';
import {
  exportInTray, isArchived,
  isManaged, metadataDir, projectDirOf, recordMetadata
} from './projects';
import type {
  MetadataPatch,
  MetadataWriteOutcome, StepLedgerView
} from '../shared/types';

/**
 * THE STEP FOR A METADATA EDIT — written after the document, and never instead
 * of it.
 *
 * ── What this is the second half of ─────────────────────────────────────────
 *
 * The write above is what the user SEES: the package or the Info dictionary
 * changes and the pane in front of them says the new title at once. This is what
 * SURVIVES it. An export is cast fresh from the bank and a working tree's package
 * is not one of its inputs, so before this existed the correction was silently
 * absent from every book the app filed afterwards (docs/WORKBENCH.md §9). The
 * payload here is what materialisation replays.
 *
 * ── The file before the step, which is the rule and not a preference ───────
 *
 * A step is a pointer at a retained payload, so a step recorded before its
 * payload exists is a row somebody can click, render from, and be shown a
 * refusal by. The uuid makes the write collision-free by construction — two Applies a
 * millisecond apart cannot land on one name — so there is no file here to
 * overwrite and nothing to serialise against.
 *
 * ── A LANDING THAT FAILS IS A CONSOLE LINE, NOT A FAILED WRITE ─────────────
 *
 * By the time this runs the document has been edited: the values are in the
 * book, visibly, and reporting failure would tell somebody their correction did
 * not happen while leaving it done. What is actually lost is the RECORD of it,
 * which is worth a named line in the terminal and is not worth turning a
 * successful edit into a refusal.
 *
 * ── Absent for two ordinary states, and neither is an error ────────────────
 *
 * A patch with no changed fields in it is a read wearing a Save button, and a
 * document outside every project — a file the user opened off their own disk —
 * has no ledger for a row to go in. Both answer undefined, and the dialog knows
 * that means there is nothing to adopt.
 */
const landMetadata = async (
  inside: string,
  kind: MetadataPatch['kind'],
  patch: Record<string, string | undefined>,
): Promise<StepLedgerView | undefined> => {
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    fields[field] = value;
  }
  const named = Object.keys(fields);
  if (named.length === 0) return undefined;
  const dir = projectDirOf(inside);
  if (dir === null) return undefined;
  try {
    const name = `${randomUUID()}.json`;
    await fsp.mkdir(metadataDir(dir), { recursive: true });
    const body: MetadataPatch = { kind, fields };
    await fsp.writeFile(path.join(metadataDir(dir), name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    // PROJECT-RELATIVE WITH FORWARD SLASHES, as every payload is: the ledger's
    // spelling of a path is not this platform's, and a payload that carried a
    // backslash would be a row no other machine could resolve.
    return await recordMetadata(dir, `metadata/${name}`, { fields: named });
  } catch (err) {
    console.error(
      `[meta] the ${kind} record was written, but the step for it could not be: `
      + `${err instanceof Error ? err.message : String(err)}. The document carries the values; `
      + 'the history does not, so anything made from here will not carry them.',
    );
    return undefined;
  }
};

/*
 * The PDF's path goes through `admitted` — the SAME allow-list the pdf.js
 * viewer's bytes go through, and the same function, so this door can never
 * drift from that one. A renderer that was talked into naming some other file
 * is refused here rather than by a path check that has to stay right forever.
 */
export const admittedPdf = (candidate: string): string => {
  const resolved = admitted(candidate);
  if (resolved === null) {
    throw new Error(`"${candidate}" is not a document this app has open, so its metadata is not ours to read.`);
  }
  return resolved;
};

/**
 * The PDF a metadata WRITE may touch, which is not simply "one that is open".
 *
 * ── THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY ──────────────────────
 *
 * `admitted` answers for anything the user has opened, INCLUDING their own
 * file on their own disk — that is what it is for; it is a read gate. Handing
 * that answer to `pdf-meta --out` meant that editing the title of a document
 * in the window between opening it and the background import finishing (or in
 * any case where the import failed and the tab never moved) re-emitted the
 * user's own `E:\…` PDF through pdf-lib and renamed the result over it. A
 * whole-document rewrite of a file this app was only ever asked to LOOK at.
 *
 * So a write resolves to the project's working copy or it does not happen. An
 * unmanaged path is refused with the reason and with what to do about it,
 * rather than being quietly redirected — a metadata dialog that reported
 * success against a file the user was not looking at would be its own bug.
 *
 * ── AND `archive/` IS INSIDE THE LIBRARY AND STILL NOT WRITABLE ────────────
 *
 * `isManaged` answers true for every layer of a project on purpose (its own
 * header says so), and that was a complete gate for exactly as long as no
 * surface ever put an archived path in front of a writer. Standing on the origin
 * row now shows the untouched original (`documentAtPosition`, projects.ts), so
 * the dialog's `tab.path` can be that file — and a title edit made there would
 * re-emit the only copy of somebody's scan this program knows of through
 * pdf-lib, silently, in the one place the app promises it does not. The refusal
 * names the row rather than the folder: a step is named by the action it was.
 */
const writablePdf = (candidate: string): string => {
  const resolved = admittedPdf(candidate);
  if (isArchived(resolved)) {
    throw new Error(
      'This is the document exactly as you imported it, which Foundry keeps and never writes to. '
      + 'Step forward off the import in the history panel and edit the copy this app works on.',
    );
  }
  if (isManaged(resolved)) return resolved;
  throw new Error(
    `"${resolved}" is your own file, outside Foundry's library, and this app does not write to `
    + 'documents it did not make. Foundry keeps a copy of every document you open — open this '
    + 'one from Home and edit that, and your original stays exactly as it is.',
  );
};

/** `meta:write-pdf`. */
export async function writePdfMetadataFor(
  filePath: string,
  patch: Record<string, string | undefined>,
): Promise<MetadataWriteOutcome> {
  // Resolved once and used for both halves: the write goes to the working
  // copy, and the step is filed against the project that copy is in. Asking
  // `writablePdf` twice would be two answers about one document, and the
  // refusals it makes are the ones that decide whether there is anything to
  // record at all.
  const working = writablePdf(filePath);
  const outcome = await writePdfMetadata(working, patch);
  if (!outcome.ok) return outcome;
  const landed = await landMetadata(working, 'pdf', patch);
  return landed === undefined ? outcome : { ...outcome, landed };
}

/**
 * THE EPUB A METADATA READ OR WRITE MAY TOUCH — a finished export, and nothing
 * else in the library.
 *
 * ── Why this is not `admittedPdf` with a different extension ────────────────
 *
 * `admitted` answers for documents that came in through `openDocument` — the
 * menu, a drop, argv, the dialog. An export never came in through any of them:
 * `openExportView` (core/documents.service.ts) makes its tab out of a path read
 * off a history row, and the pane behind it asks `book:view` rather than opening
 * a file. So the allow-list says no to every export there is, and a door that
 * admitted the path for being asked about it would not be a gate at all.
 *
 * The tray is the honest test and it is already this app's answer to exactly
 * this question twice over — `export:save-copy` copies out of it, `book:view`
 * explodes out of it — so this asks the same function and inherits whatever
 * that rule becomes.
 *
 * ── NO `archive/` TEST HERE, WHICH IS NOT AN OVERSIGHT ─────────────────────
 *
 * The PDF write needs one because `documentAtPosition` can put the untouched
 * original in front of the dialog, and `isManaged` is true of it. `final/` and
 * `archive/` are different folders by construction: a path this answers for is
 * two segments deep under `final`, so the archived scan cannot reach here and a
 * refusal about it would be a sentence nobody can make the app say.
 *
 * ── AND THE EXTENSION, BECAUSE A TRAY HOLDS MORE THAN BOOKS ────────────────
 *
 * `final/` also holds plain-text exports, and `epub-meta` handed one would fail
 * somewhere inside a zip reader with a sentence about a container. Refused here,
 * in words about what the file is.
 */
export const exportedBook = (candidate: string): string => {
  const resolved = path.resolve(candidate);
  if (exportInTray(resolved) === null || !resolved.toLowerCase().endsWith('.epub')) {
    throw new Error(
      `"${candidate}" is not one of this library’s exported books, and this app edits the record `
      + 'of a book it made rather than of a file it was shown.',
    );
  }
  return resolved;
};

/** `meta:write-epub`. */
export async function writeEpubMetadataFor(
  filePath: string,
  patch: Record<string, string | undefined>,
): Promise<MetadataWriteOutcome> {
  // Resolved once and used for both halves, on the PDF door's rule above: the
  // container and the step are two facts about ONE document, and asking the
  // gate twice would be two answers about it.
  const book = exportedBook(filePath);
  const outcome = await writeEpubMetadata(book, patch);
  if (!outcome.ok) return outcome;
  /*
   * THE STEP IS THE HALF THAT MATTERS MORE HERE THAN IT DOES FOR A SCAN. A
   * PDF's working copy is what every later rendering is read from, so an edit
   * to it is at least durable in the file. An export is a CAST — the next one
   * comes out of the bank, which never knew the title was corrected — so
   * without this the correction would live only in the one container the
   * person happened to have open, and every book filed after it would quietly
   * go back to being wrong.
   */
  const landed = await landMetadata(book, 'epub', patch);
  return landed === undefined ? outcome : { ...outcome, landed };
}
