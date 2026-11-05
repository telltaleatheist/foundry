/**
 * document-intake — what opening a document DOES, with the windows left out.
 *
 * Split out of documents.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2). The
 * admission, the recents row, the import into a project, the move onto the working
 * copy and the noted title are all here, unchanged; the two moments the windows are
 * told something are handed in as `DocumentAnnouncer`, and documents.ts — which
 * still owns BrowserWindow — passes the same two sends it always made, at the same
 * two points. Library code — nothing here reaches Electron.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { readPdfMetadata } from './engine';
import { admit } from './openable';
import { importDocument, isManaged, noteProjectTitle } from './projects';
import { forgetRecent, rememberRecent } from './recents';
import type { RecentKind } from '../shared/types';

/** The two extensions this app opens, and the only two the allow-list admits. */
const OPENABLE_EXTENSIONS: Readonly<Record<string, RecentKind>> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
};

/** The two moments an open tells the windows something. */
export interface DocumentAnnouncer {
  /** The file is admitted and remembered; every window opens a tab on it. */
  opened(resolved: string): void;
  /** The import landed and the tab moves from the outside file onto the working copy. */
  relocated(move: { from: string; to: string }): void;
}

/**
 * Admit a path and tell every window about it. The single door: the menu, the
 * dialog, a drop, argv and a finished conversion all come through here, so the
 * allow-list and the tabs can never disagree about which files are open.
 *
 * EPUBs join PDFs here because the app now produces them and opens what it
 * produces. The renderer decides which of the two viewers a tab gets; main only
 * decides whether the file is one this app will read at all.
 */
export async function openDocumentWith(candidate: string, announce: DocumentAnnouncer): Promise<string | null> {
  const resolved = path.resolve(candidate);
  const kind = OPENABLE_EXTENSIONS[path.extname(resolved).toLowerCase()];
  if (kind === undefined) return null;
  try {
    await fsp.access(resolved);
  } catch {
    return null;
  }
  admit(resolved);
  // Recorded here and only here, for the same reason the allow-list is: this is
  // the one function every open passes through. A document already inside a
  // project is remembered too, and flagged, because a tab closed by accident has
  // to be findable again from Home.
  rememberRecent(resolved, kind, path.basename(resolved), isManaged(resolved));
  announce.opened(resolved);
  /*
   * A file from outside the library becomes a PROJECT — hashed, given a folder,
   * copied into `archive/` as the untouched original and again into the layer
   * the user actually works with. Never moved and never written: their file
   * stays exactly where they put it.
   *
   * AFTER the tab has been told to open, and not awaited, deliberately. Keying a
   * project is a full sha256 of the document and importing it is two copies; on
   * a 400 MB scan that is seconds, and a window that sat still for seconds after
   * a drop would read as an app that had missed the file. Nothing downstream
   * waits on it: the work is serialised per folder (projects.ts), so whatever
   * asks about this project next queues behind the import rather than racing it.
   *
   * A failure is a console line naming the file rather than a dialog: the
   * document IS open and readable, and what has been lost is a folder to put its
   * conversions in — which the next conversion would make anyway.
   */
  void importDocument(resolved, kind).then(async (imported) => {
    // A stamping refusal is a NOTICE, not a failure, and this call is the
    // background one — the tab's own `epub:open` import carries the same
    // sentence to the notice strip, where somebody will read it.
    if (imported.notice !== null) console.warn(`[projects] ${imported.notice}`);
    /*
     * ── AND THE TAB MOVES ONTO THE WORKING COPY ────────────────────────────
     *
     * THE BUG THIS EXISTS FOR COST A USER THEIR WHOLE PIPELINE, and it was
     * invisible because everything about it looked right. They opened their own
     * scan off `E:\Shared\…\archive\Working Towards The Fuhrer…pdf`; the import
     * made the project, the OCR read landed, the bank and its completion marker
     * were on the disk and the catalogue recorded them. Then Generate said "this
     * book has not been read yet" — because the TAB was still pointed at the
     * `E:\` file, `projectFor()` on that path answers null, and every question
     * this app asks about "the document in front of you" is asked of the tab's
     * path. Restarting did not help: it was never staleness, it was identity.
     *
     * THE WORKING-COPY MODEL IS THE ANSWER AND IT WAS ALREADY THE MODEL. A file
     * from outside the library is imported, and what the user then holds is the
     * PROJECT's copy — "the PDF" — with their own file untouched where they put
     * it. The one place that was not true was the tab, which kept the path the
     * open came in on because that is what the fast path had in its hand.
     *
     * So the fast open stays exactly as it is — a 400 MB sha256 must not sit
     * between somebody and their document — and the tab is MOVED when the import
     * lands. `imported.entry` is the live layer's own file (`working/<stem>.pdf`,
     * `generated/<stem>.epub`), which is the same answer `epub:open` reaches by
     * its own route, so both kinds end up naming what this app actually works on.
     *
     * MAIN OPENS IT, SO MAIN ADMITS IT: the renderer is about to name this path
     * to the viewer, the metadata dialog and the block editor, and every one of
     * those doors asks the allow-list.
     */
    const working = path.join(imported.dir, ...imported.entry.split('/'));
    if (working.toLowerCase() !== resolved.toLowerCase() && await stillThere(working)) {
      admit(working);
      /*
       * AND RECENTS FOLLOWS IT. The row is what Home and the reopen path use, so
       * a row naming the outside original would send somebody straight back into
       * the state this fixes. The outside row is forgotten rather than left
       * beside the new one: they are one book, and two rows for it is a list
       * that asks a question with no right answer.
       */
      forgetRecent(resolved);
      rememberRecent(working, kind, path.basename(working), true);
      announce.relocated({ from: resolved, to: working });
    }
    /*
     * The PDF's own idea of its title, noted here because for a project that
     * is only ever a PDF, this import is the ONLY moment anything asks. Behind
     * the same not-awaited import, for the same reason: it is a spawn, and a
     * display name is not worth making a drop feel missed over. Scans mostly
     * answer with nothing, and nothing is noted — the row keeps its spoken
     * stem until a conversion produces a book that knows its own name.
     */
    if (kind === 'pdf') {
      const meta = await readPdfMetadata(resolved);
      if (meta.ok && meta.metadata.kind === 'pdf' && meta.metadata.fields.title !== null) {
        await noteProjectTitle(imported.dir, meta.metadata.fields.title);
      }
    }
  }).catch((err: Error) => {
    console.error(`[projects] ${resolved} could not be imported into a project: ${err.message}`);
  });
  return resolved;
}

/** Is it on the disk? A missing working copy is a swap that must not happen. */
async function stillThere(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A document named on the command line — `foundry-app book.pdf`, and what
 * Windows hands the app when a .pdf is opened with it. Options are skipped, so
 * `electron . --dev book.pdf` finds the book and not the flag.
 */
export function documentFromArgv(argv: readonly string[]): string | null {
  return argv.slice(1).find((arg) => {
    if (arg.startsWith('-')) return false;
    return OPENABLE_EXTENSIONS[path.extname(arg).toLowerCase()] !== undefined;
  }) ?? null;
}
