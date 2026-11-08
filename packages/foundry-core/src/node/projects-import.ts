/**
 * projects-import — a document becoming a project: importing, and creating a capture project.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { stampEpub } from './engine';
import type { ImportLanding } from '../shared/types';
import { WHY_IMPORTED } from '../shared/types';
import { captureStep } from '../shared/ledger';
import { CAPTURE_RECIPE_PAYLOAD, emptyRecipe, recipeBytes } from '../shared/capture';
import { writeAtomically } from './atomic';
import { announceProjects, copyNewOnly, readManifest, withCreatedProject, writeManifest } from './projects-manifest';
import { ARCHIVE, GENERATED, WORKING, contentKey, projectDirOf, projectsDir, slugify, stemOf } from './projects-paths';
import { healWorkingPdf } from './pdf-repair';
import { recordStep } from './projects-rotation';
import { ledgerOf, originLedger } from './projects-steps';

/*
 * `translationFileFor` MOVED TO shared/ledger.ts, and the move is the point rather
 * than tidying. That name is now composed in two places for one run — here, and by
 * the pure decision that says whether this translation is a branch and therefore
 * carries an `<id8>` before its extension — and a second copy of the rule is a
 * second answer about where a person's book went. It is imported above and used
 * unchanged by the legacy adoption below, which is the one caller that has a bare
 * tag rather than a step to ask.
 */

/** Where an imported document ended up, and the project it now belongs to. */
export interface ImportedDocument {
  /** The project directory. */
  dir: string;
  /** The document's path RELATIVE to it — `generated/x.epub`, `working/x.pdf`. */
  entry: string;
  key: string;
  stem: string;
  /**
   * What could not be done while importing, in words a person can read, or null.
   *
   * Today there is exactly one: an EPUB the engine would not stamp. It is a
   * NOTICE and not a failure — the document is imported, it opens, it reads —
   * and it reaches the notice strip through `EpubBook.notice` so that a book
   * whose select mode will not work says why on the way in rather than by
   * doing nothing when somebody presses the button.
   */
  notice: string | null;
}

/**
 * Give a freshly imported EPUB foundry's stamps, once, at the moment of import.
 *
 * WHY HERE. This is the one door a book comes through, and everything past it
 * assumes the stamps: `readFoundryBook` refuses a book without them BY NAME, so
 * `translate` and `epub-final` refuse an imported publisher's EPUB outright;
 * select mode outlines `data-bf-cat` and finds nothing; the inspector shows no
 * categories. Stamping later — when a person presses Select, say — means every
 * other door stays shut until they happen to press it.
 *
 * WHY WRITING `generated/` IS NOT A VIOLATION OF "generated/ IS NEVER WRITTEN".
 * That rule is about EDITING an origin after the fact, because the origin is the
 * record every curation decision downstream is measured against. This runs
 * INSIDE the copy that makes the origin, before anything has read it, exactly
 * once, and it adds attributes rather than changing a word — and `archive/`
 * holds the user's file byte for byte whatever happens here. The book that
 * lands in `generated/` is the book this app works from, and a book nothing can
 * address is not one.
 *
 * The engine refuses to write over an input, so the stamped book is written
 * beside the copy and renamed onto it: the file at the catalogued path is
 * either the plain copy or the stamped one, never half of either.
 */
export async function stampImported(file: string): Promise<string | null> {
  const staged = `${file}.stamping`;
  const failed = async (reason: string): Promise<string> => {
    await fsp.rm(staged, { force: true }).catch(() => { /* best effort */ });
    return `${path.basename(file)} could not be given Foundry's block stamps, so select mode and `
      + `translation will not open it. ${reason}`;
  };
  try {
    const outcome = await stampEpub(file, staged);
    if (!outcome.ok) return await failed(outcome.reason ?? 'The engine said nothing.');
    await fsp.rename(staged, file);
    return null;
  } catch (err) {
    return await failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Find or make the project this document belongs to, and return where it sits.
 *
 * ALREADY INSIDE ONE — a conversion's origin, a document opened again from Home
 * — and the project is simply named: nothing is copied, nothing is re-hashed,
 * and a translation planned from the cast EPUB lands in the same folder as the
 * book it was made from. That last one is the whole reason this function exists
 * rather than a bare `contentKey` call at each site: keying the translation off
 * the CAST EPUB's bytes would file it under a project of its own, and the book
 * and its translation would be two unrelated folders.
 *
 * OUTSIDE — a file the user dropped, opened or named on the command line — and
 * it is IMPORTED, into both layers that matter for its kind:
 *
 *   a PDF is copied to `archive/` (the untouched original, possibly the only
 *   copy of that scan there will ever be) and again to `working/`, which is the
 *   live PDF: the one the user sees, and the one metadata edits will land in
 *   when they are implemented;
 *
 *   an EPUB is copied to `archive/` and again to `generated/` with the role
 *   `imported`, because an imported book plays exactly the part a cast one does
 *   — an origin that is never written, with a working tree unpacked from it —
 *   and that second copy is STAMPED as it is made, so the origin every later
 *   pass reads is one those passes will admit (`stampImported`);
 *
 * Copied and never moved, because it is the user's file and it stays where they
 * put it. Copied and never written, because from here on the working copy is
 * what this app edits.
 */
/**
 * What an import from outside the library announces, the moment it lands —
 * `onQueueChanged`'s shape for `onQueueChanged`'s reason: this module's business
 * is the projects on disk, not who is hosting the app, and the one place that
 * knows whether anybody is listening (electron/mount.ts) wires it. One listener,
 * replaced rather than appended, exactly like the queue's pair.
 *
 * Fired for the OUTSIDE branch of `importDocument` only: a path already inside a
 * project is the app noticing its own file, and there is no first contact to
 * witness.
 */
export let importLanded: (landing: ImportLanding) => void = () => { /* set by mount */ };

export function onImportLanded(listener: (landing: ImportLanding) => void): void {
  importLanded = listener;
}

/**
 * Make an empty project for photographs, and give it its first step.
 *
 * ── WHY THIS IS NOT `importDocument` WITH A THIRD KIND ──────────────────────
 *
 * Every project above is born FROM A FILE and keyed by the hash of that file’s
 * bytes, which is what makes importing the same book twice land in the same
 * folder. A capture project has no file yet: it must exist EMPTY, so that a
 * light table has somewhere to put the first photograph. So it is keyed from a
 * random id instead, and this comment says so rather than leaving a reader to
 * wonder why one project in the library is not content-addressed.
 *
 * THE KEY NEVER CHANGES ON A RE-MINT. A project is its identity, not its
 * current PDF: minting again produces a new step and a new document inside the
 * same folder, and a key that followed the newest PDF would draw one project
 * as two rows on Home.
 *
 * THE TITLE IS WHAT THE PERSON TYPED, and the stem with it — there is no
 * filename to take either from. An empty title becomes “Photographs” rather
 * than an empty row on Home. One shot: the stem never changes after creation,
 * because renaming files under somebody is not a thing a catalogue does.
 *
 * THE STEP IS APPENDED HERE, WITH AN EMPTY RECIPE, and `captureStep` carries
 * the argument for why that is forced rather than tidy.
 */
export async function createCaptureProject(title: string): Promise<ImportedDocument> {
  const named = title.trim().length > 0 ? title.trim() : 'Photographs';
  const key = `${slugify(named)}-${randomBytes(4).toString('hex')}`;
  const dir = path.join(projectsDir(), key);
  return withCreatedProject(dir, key, named, async (manifest) => {
    /*
     * ONLY INTO AN EMPTY LEDGER, on `importDocument`’s reason: a create that
     * somehow met an existing project must not write a second account of where
     * its photographs came from. The random key makes that collision very
     * nearly impossible, which is not the same as impossible.
     */
    /*
     * THE RECIPE IS WRITTEN BEFORE THE STEP THAT POINTS AT IT, and in the same
     * function, which it was not for one build. Creation appended a capture step
     * whose payload is `capture/recipe.json` and left the FILE to whoever called
     * next — so calling this alone produced a project that refused to open, and
     * a crash between the two calls left one on disk permanently. A step is the
     * retained payload of an action; minting one whose payload does not exist is
     * writing a promise the project cannot keep.
     */
    await writeAtomically(
      path.join(dir, ...CAPTURE_RECIPE_PAYLOAD.split('/')),
      Buffer.from(recipeBytes(emptyRecipe())),
    );
    if (ledgerOf(manifest).steps.length === 0) {
      manifest.ledger = {
        steps: [captureStep(
          randomUUID(),
          CAPTURE_RECIPE_PAYLOAD,
          manifest.createdAt > 0 ? manifest.createdAt : Date.now(),
        )],
      };
      await writeManifest(dir, manifest);
    }
    // A project was made. Home has no other way to hear about it.
    announceProjects();
    return {
      dir,
      // No document exists yet, which is the whole point of this arrival: the
      // recipe stands in the entry slot until a mint makes one.
      entry: CAPTURE_RECIPE_PAYLOAD,
      key: manifest.key,
      stem: manifest.stem,
      notice: null,
    };
  });
}

export async function importDocument(
  filePath: string,
  kind: 'pdf' | 'epub',
): Promise<ImportedDocument> {
  const resolved = path.resolve(filePath);
  const inside = projectDirOf(resolved);
  if (inside !== null) {
    const manifest = await readManifest(inside);
    const entry = path.relative(inside, resolved).split(path.sep).join('/');
    // Nothing is imported and nothing is stamped: this document is already the
    // app's own, and it was stamped when it became one.
    return { dir: inside, entry, key: manifest.key, stem: manifest.stem, notice: null };
  }

  const name = path.basename(resolved);
  const key = `${slugify(name)}-${await contentKey(resolved)}`;
  const dir = path.join(projectsDir(), key);
  const live = kind === 'pdf' ? WORKING : GENERATED;

  const imported = await withCreatedProject(dir, key, stemOf(name), async (manifest) => {
    // `manifest.stem` and NOT the name this call computed. A project adopted
    // from the flat workspace was named after a slug, and every file already in
    // it carries that name; a second name arriving with a later import would put
    // two spellings of one book in one folder and two rows for it on Home.
    const liveFile = kind === 'pdf' ? `${manifest.stem}.pdf` : `${manifest.stem}.epub`;
    if (manifest.archive === null) {
      await fsp.mkdir(path.join(dir, ARCHIVE), { recursive: true });
      await copyNewOnly(resolved, path.join(dir, ARCHIVE, name));
      manifest.archive = { file: name, kind, contentKey: key.slice(-8), originPath: resolved };
    }
    // The live layer, made from the archive copy rather than from the user's
    // file: the archive is now the origin of record, and reading the original
    // twice would make two copies that could differ if it changed underneath.
    const archived = path.join(dir, ARCHIVE, manifest.archive.file);
    await fsp.mkdir(path.join(dir, live), { recursive: true });
    const made = await copyNewOnly(archived, path.join(dir, live, liveFile));
    let notice: string | null = null;
    /*
     * CATALOGUED WHETHER OR NOT THIS CALL MADE THE COPY, and the two used to be
     * one condition. `copyNewOnly` answers false when the file is already there,
     * which is the ordinary outcome of importing the same book twice and the
     * inevitable outcome of a crash between the copy and the manifest write —
     * and skipping the catalogue on false left the live document ON DISK and
     * UNLISTED. Home reads the catalogue, so the project drew as a book nothing
     * had been made from, with the user's own scan sitting in `working/` a
     * folder away and no row anywhere that would open it. The copy existing is
     * exactly the condition under which the row has to be there.
     *
     * The STAMP is still gated on `made`, and that gate is the real one: it runs
     * inside the copy that makes an origin, once, before anything has read it
     * (see `stampImported`), and re-stamping a book somebody has been editing
     * would be this app rewriting an origin after the fact.
     */
    if (kind === 'pdf') {
      const already = manifest.working.files.find((row) => row.file === liveFile);
      manifest.working.files = [
        ...manifest.working.files.filter((row) => row.file !== liveFile),
        {
          file: liveFile,
          kind: 'pdf',
          from: `${ARCHIVE}/${manifest.archive.file}`,
          // The copy's own age, not this import's. A row written now for a file
          // copied last week would date the document by when it was noticed.
          madeAt: already?.madeAt ?? Date.now(),
        },
      ];
      /*
       * THE SCAN'S ORIGIN, which this branch never recorded and should have from
       * the day the step model existed.
       *
       * The working row above says which file is live; it says nothing about
       * what the PDF IS or where it came from, and `documents` is what every
       * reader of a project asks. Without this a scanned project carried
       * `documents: []` — invisible for as long as nothing else had been made
       * from it (`summarise`'s fallback covered it) and then, the moment an EPUB
       * was generated, the PDF row disappeared entirely. See `healImport`, which
       * puts this back for the catalogues written before this line existed.
       *
       * `archive/<file>` AND NOT the working copy, which is the same choice
       * `migrateToSteps` makes and for the model's own reason: a chain records
       * what was APPLIED, and the copy in `working/` is not a step, it is the
       * thing the steps are about (`summarise` resolves it from `working.files`).
       *
       * `onlyIfEmpty` for the EPUB branch's reason exactly: importing the same
       * book twice must not write a second account of where it came from.
       */
      recordStep(manifest, 'pdf', {
        file: `${ARCHIVE}/${manifest.archive.file}`,
        label: 'The scan you imported',
        appliedAt: manifest.createdAt > 0 ? manifest.createdAt : Date.now(),
        kind: 'origin',
        // The most expensive thing in the project: it came from outside this
        // program and there may be no other copy of that scan anywhere.
        retention: 'irreplaceable',
        why: WHY_IMPORTED,
      }, { onlyIfEmpty: true });
      /*
       * A DAMAGED SCAN IS REBUILT HERE, in the copy that was just made, before
       * anything reads it: a page tree pdf.js cannot walk opened as "This PDF
       * would not open" on a book MuPDF reads whole (pdf-repair.ts). Gated on
       * `made` like the stamp, and for its reason; a copy made before this line,
       * or one a crash left unrebuilt, is healed when it is opened.
       */
      if (made) notice = await healWorkingPdf(path.join(dir, live, liveFile));
    } else {
      // A refusal from the stamp is a sentence and not a throw: the copy stands,
      // the book opens, and the person is told which of its doors is shut.
      if (made) notice = await stampImported(path.join(dir, live, liveFile));
      /*
       * THE EPUB'S ORIGIN, which is what an imported book is.
       *
       * Recorded only when the type has no chain yet: `<stem>.epub` is also the
       * name a CAST writes, and a second import-shaped origin arriving over a
       * cast one would rewrite this project's account of where its book came
       * from. The first step wins, which is the same rule the old `role` field
       * was protecting with the same comment.
       */
      recordStep(manifest, 'epub', {
        file: `${live}/${liveFile}`,
        label: 'The book you imported',
        appliedAt: Date.now(),
        kind: 'origin',
        // The most expensive thing in the project: it came from outside this
        // program and there may be no other copy of it anywhere.
        retention: 'irreplaceable',
        why: WHY_IMPORTED,
      }, { onlyIfEmpty: true });
    }
    /*
     * ── THE ORIGIN OF THE STEP LEDGER ─────────────────────────────────────────
     *
     * The one step in a project whose parent is null, and the only one that is
     * not produced by a queue job: importing is a file copy, and what it retains
     * is the untouched original — irreplaceable for the reason nothing else in a
     * project is, which is that some of these are scans of documents that exist
     * nowhere else and only the user knows where the file came from.
     *
     * ONLY INTO AN EMPTY LEDGER, which is `recordStep`'s `onlyIfEmpty` for the
     * same reason: importing the same book twice is the app noticing something it
     * already knew, and a second origin would be a second account of where this
     * project's document came from. A project that reached here with a MIGRATED
     * ledger already has an origin reconstructed from this very archive row, so
     * this is correctly skipped for it too — the ids stay the ones `migrateLedger`
     * mints deterministically, and the pointer keeps pointing at something.
     *
     * THE LABEL IS THE CHAIN'S, verbatim, and that is not a coincidence to be
     * cleaned up later: `migrateLedger` reads the origin step's label out of the
     * per-type chain, so a project that arrived by migration and one that arrived
     * by import must say the same words about the same file or the two look like
     * different books.
     */
    if (ledgerOf(manifest).steps.length === 0) {
      manifest.ledger = originLedger(
        `${ARCHIVE}/${manifest.archive.file}`,
        kind === 'pdf' ? 'The scan you imported' : 'The book you imported',
        manifest.createdAt > 0 ? manifest.createdAt : Date.now(),
      );
    }
    await writeManifest(dir, manifest);
    // A project was made or grown. The library screen has no other way to hear
    // about a drop that landed while somebody was looking at something else.
    announceProjects();
    return { dir, entry: `${live}/${liveFile}`, key, stem: manifest.stem, notice };
  });
  /*
   * AFTER the manifest is durably written — a host that goes looking at the
   * folder this names must find a catalogue in it. Caught here for the queue's
   * reason at its own settle: the import has landed whatever a listener does
   * with the news.
   */
  try {
    importLanded({ projectDir: dir, originalPath: resolved, kind });
  } catch (err) {
    console.error(
      `[projects] the import-landed listener threw for ${resolved}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return imported;
}
