/**
 * projects-list — Home's list: what a project is called, its state, and summarising it.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { openedAtFor } from './recents';
import type { ProjectDocument, ProjectFinal, ProjectManifest, ProjectSummary, ProjectStep, ProjectWorkingFile } from '../shared/types';
import { WHY_IMPORTED } from '../shared/types';
import { readingBank } from './projects-files';
import { completionMarkerFor } from './projects-landing';
import { announceProjects, exists, readManifest, withManifest, writeManifest } from './projects-manifest';
import { healMintedArchive } from './projects-mint';
import { ARCHIVE, FINAL, GENERATED, WORKING, projectsDir } from './projects-paths';
import { facsimilesOf, onDisk } from './projects-planning';
import { ledgerOf } from './projects-steps';

/**
 * Give the project the book's own title, once something can read one.
 *
 * A project is born named after a filename, because that is all a scan offers
 * before it has been read. The cast EPUB carries a `dc:title`, and a library
 * whose rows read "Working Towards The Fuhrer. Kershaw, Ian. (1993)" is worse
 * than one whose rows read "Working Towards the Führer". Written only when it
 * CHANGES, so opening a book is not a manifest write.
 *
 * THE STEM DOES NOT MOVE WITH IT. Files keep the names they were written under —
 * a catalogue that renamed a book's files behind the user is a catalogue that
 * breaks every path anything else is holding.
 */
export async function noteProjectTitle(dir: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return;
  try {
    await withManifest(dir, async (manifest) => {
      if (manifest.title === trimmed) return;
      manifest.title = trimmed;
      await writeManifest(dir, manifest);
      // Only when it MOVED. This is called on every open of every book, and a
      // listing re-read per open would be a directory walk for a title that was
      // already right.
      announceProjects();
    });
  } catch (err) {
    // A display name is not worth failing an open over; it is still named.
    console.error(`[projects] ${dir} could not record its title: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// What Home lists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every project, newest-opened first, each with the documents inside it.
 *
 * ONE ROW PER DOCUMENT, not one per file. The scan the user imported is one row
 * — the live copy in `working/` — and the archive behind it is this app's
 * bookkeeping, reachable through Reveal. What has been MADE from that scan is a
 * row each: the cast EPUB, a translation, the plain text, and the book reprinted
 * as real text in a PDF. That last one used to be folded into the scan's row,
 * back when it WAS the scan with a layer over it; it is a different document
 * now, and a document a person cannot see is a document they cannot open.
 *
 * THE BOOK ITSELF IS ONE OF THE DOCUMENTS. What a project has been used to make
 * is the interesting question, but it is not the only one, and a project that
 * has only ever been imported still has something to open. See the fallback at
 * the end of `summarise`.
 *
 * A project whose catalogue will not parse is STILL LISTED, carrying the reason
 * — Home is the only door back to a book, and a row that silently disappears
 * leaves a person hunting for something that "was there yesterday". It offers no
 * documents, because enumerating them would mean guessing at roles the catalogue
 * was the only record of.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsDir();
  let entries: string[];
  try {
    entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No projects directory yet is the ordinary state of a fresh install.
    return [];
  }

  /*
   * ── THE CONTAINER HEAL IS FIRED HERE AND NOT AWAITED ──────────────────────
   *
   * A project minted before Wave 41 has to get its PDF before anything can ask
   * the catalogue what it was made from — Home's row, `originalOf`, a host's
   * adoption — and a library listing is the earliest moment anything looks. So
   * this is where it starts.
   *
   * NOT AWAITED, deliberately, and this is the one place the heal is not. Binding
   * several hundred megabytes of JPEG into a container is seconds of disk, and a
   * listing is what draws Home: awaiting it would hold the whole library screen
   * behind a migration of one book in it. `healMintedArchive` announces when it
   * lands, which is the same signal every other write in this file uses to say
   * "the library changed" — so the row redraws itself as a book the moment the
   * container exists, and the listing that started it stays instant.
   *
   * WHICH MEANS ONE LISTING CAN BE STALE, said out loud: a captured project read
   * in the seconds before its heal completes draws as photographs with no book.
   * That is what it drew yesterday, it is recoverable by doing nothing, and it is
   * the only honest thing a catalogue can say about a file that is being made.
   * The AWAITED heal at `bookAtPosition` is what guarantees the order everything
   * downstream depends on.
   */
  for (const name of entries) {
    void healMintedArchive(path.join(root, name));
  }
  const summaries = await Promise.all(entries.map((name) => summarise(path.join(root, name), name)));
  return summaries.sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * The live PDF the catalogue names — or the one on disk that it forgot.
 *
 * ── Why a listing reconciles instead of trusting itself ─────────────────────
 *
 * A project on this machine came up with `working.files: []` and a perfectly
 * good `working/<book>.pdf` sitting beside it, because a bug in the document
 * delete struck the row out without removing the file (see `deleteDocument`).
 * Under the step model the PDF row is built FROM that entry, so the catalogue's
 * answer to "what does this project have" was: nothing. A user whose book had
 * vanished from an app that was still storing every byte of it.
 *
 * The bug is fixed. This exists because fixing a bug does not repair the data it
 * already wrote, and because it is not the only way to reach that state — a
 * crash between the manifest write and the file copy, a file restored by hand
 * from a backup, and a folder synced from another machine all land there too.
 *
 * SO THE DISK IS THE AUTHORITY ABOUT WHAT EXISTS and the catalogue is the
 * authority about what it MEANS. A working copy present with no row is adopted
 * with the only provenance that can be inferred — the archive, which is where an
 * unrecorded working PDF must have come from — and the repair is logged, because
 * an app that silently papers over a hole in its own bookkeeping is an app whose
 * bookkeeping nobody can ever trust again.
 *
 * ── Why here, and why it does not write ─────────────────────────────────────
 *
 * IN `summarise`, not in the migration: the migration only ever runs on a v1
 * catalogue, and this hole is reachable at any version. Not in a repair pass
 * either, because a repair pass is a thing somebody has to remember to run, and
 * the failure it prevents is a book that is invisible RIGHT NOW.
 *
 * It returns the row rather than writing it, so a listing stays a read. The
 * repair is re-derived on every list — which costs one `exists` — and reaches
 * disk the next time anything edits the project for a reason of its own. A read
 * path that rewrote every catalogue it inspected would make opening Home a
 * write across the whole library.
 */
export async function reconcileLivePdf(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectWorkingFile | null> {
  const recorded = manifest.working.files.find((row) => row.kind === 'pdf') ?? null;
  if (recorded !== null) return recorded;
  if (manifest.archive === null || manifest.archive.kind !== 'pdf') return null;

  const file = `${manifest.stem}.pdf`;
  if (!await exists(path.join(dir, WORKING, file))) return null;

  console.warn(
    `[projects] ${path.basename(dir)}: ${WORKING}/${file} is on disk with no catalogue row. `
    + 'Listing it anyway — a document this app is storing must not be one it will not show.',
  );
  return {
    file,
    kind: 'pdf',
    // The only provenance that can be inferred. An unrecorded working PDF came
    // from the import: a promoted one would have been recorded by the promotion.
    from: `${ARCHIVE}/${manifest.archive.file}`,
    madeAt: manifest.createdAt,
  };
}

export async function summarise(dir: string, name: string): Promise<ProjectSummary> {
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(dir);
  } catch (err) {
    return {
      key: name,
      dir,
      title: name,
      createdAt: 0,
      openedAt: 0,
      documents: [],
      // Nothing can be said about the reading of a project whose catalogue will
      // not parse, and "OCR this" is a suggestion — lighting it here would be
      // offering a next step for a folder this app cannot describe.
      reading: { done: false, needed: false, pages: 0 },
      filed: false,
      // A catalogue that will not parse cannot say what kind of project this is,
      // and claiming `capture` here would send Home to open a light table over a
      // folder it has already failed to describe. `problem` is what this row says.
      capture: false,
      // Nothing can be listed out of a catalogue that will not parse, and guessing
      // at a tray by reading the directory would offer files this app cannot say
      // it made. The row offers Reveal, which is the honest door into a folder.
      exports: [],
      // No ledger was read, so no reading can be named, and nothing can say which
      // reprint belongs to which pass.
      facsimiles: [],
      problem: (err as Error).message,
    };
  }

  /*
   * ── ONE ROW PER FILE TYPE ─────────────────────────────────────────────────
   *
   * This is where a project stops being a folder of files and becomes what the
   * user described: "each file type has its own row in the system… all they see
   * is the different available file types."
   *
   * A row is a KIND — the PDF, the EPUB, the text — and everything underneath it
   * is the chain that produced it. The chain is on disk already; what was
   * missing was a record of which file was which. A converted project holds the
   * archived original, the live PDF, the generated origin it was promoted from
   * and several rotated predecessors, and the person who asked for a searchable
   * book is owed "the PDF", once.
   *
   * WHAT THE ROW OPENS is the WORKING COPY where a type has one, and the latest
   * step's file otherwise. That distinction is the model's other half: the
   * chain records what was applied, the working copy is what the user touches,
   * and edits go to the copy rather than to any step. Only the PDF has a
   * separate working file today; an EPUB's working copy is the tree unpacked
   * from its latest step, which the reader makes on open.
   */
  const documents: ProjectDocument[] = [];
  const livePdf = await reconcileLivePdf(dir, manifest);

  for (const record of manifest.documents) {
    const steps = [...record.steps].sort((a, b) => a.appliedAt - b.appliedAt);
    const latest = steps[steps.length - 1];
    if (latest === undefined) continue;

    const working = record.kind === 'pdf' && livePdf !== null
      ? path.join(dir, WORKING, livePdf.file)
      : path.join(dir, ...latest.file.split('/'));
    documents.push({
      kind: record.kind,
      path: working,
      label: path.basename(working),
      at: latest.appliedAt,
      missing: !await exists(working),
      /*
       * `managed` asks whether losing this costs the user something they cannot
       * get back from their own folders, which is now a question the chain
       * answers directly: a row whose origin came from outside this program is
       * theirs and sits somewhere they chose. Everything else this app made.
       */
      managed: steps[0]?.retention !== 'irreplaceable',
      steps,
      // The book itself — deleting this row is deleting the project. See
      // `shared/original.ts`, where the rule it generalises lives.
      origin: steps[0]?.retention === 'irreplaceable',
    });
  }

  /*
   * ── THE SOURCE IS A DOCUMENT TOO ──────────────────────────────────────────
   *
   * The two loops above list what has been MADE from a book. That is the right
   * emphasis and it was the whole answer for exactly as long as every project
   * had a catalogued live copy — and then Owen clicked a book on Home and was
   * told "nothing has been made from this book yet" about a project whose PDF
   * was sitting in it. A row that offers nothing to open is a row that has
   * nothing to say: the one thing a person wants from a book they imported is
   * to open it.
   *
   * ONLY WHEN NOTHING ELSE REPRESENTS IT. A properly catalogued project already
   * lists its live PDF (from `working.files`) and its imported EPUB (from
   * `generated`, role `imported`), and a second row for the same book is the
   * confusion this file's "ONE ROW PER DOCUMENT" note exists to prevent.
   *
   * THE LIVE COPY IF THERE IS ONE, the archived original otherwise. The live
   * copy is what the user means by "the PDF" and is the layer this app edits;
   * the archive is never written, and offering it is a last resort — but a book
   * you can only open read-only is still infinitely more use than a row that
   * says the project is empty. Either way the label is a filename and the layer
   * it came out of is never named on screen.
   *
   * `managed` is false: this document is the user's own file, and it is in
   * `archive/` precisely because they still have it.
   */
  /*
   * A PAGES ARCHIVE IS STILL REFUSED HERE BY NAME, and after Wave 41 that is a
   * guard against one moment rather than against a whole kind of project.
   *
   * The fallback composes a `ProjectDocument` out of `archive.kind`. Hand it a
   * pages archive and it fabricates one whose PATH IS A DIRECTORY: `originalOf`
   * would pick it, Home would open a folder as a book, and the failure would
   * surface with no visible connection to the mint that caused it.
   *
   * NO MINT WRITES ONE ANY MORE and `healMintedArchive` retires the ones that
   * exist — but a listing can be composed in the seconds before a heal lands, or
   * after one has failed, and a project in that state must draw as the capture
   * project it still is rather than as a folder pretending to be a book. So the
   * clause stays, as the transitional guard it now is, and it costs one string
   * comparison.
   */
  if (documents.length === 0 && manifest.archive !== null && manifest.archive.kind !== 'pages') {
    const liveFile = `${manifest.stem}${manifest.archive.kind === 'pdf' ? '.pdf' : '.epub'}`;
    const liveLayer = manifest.archive.kind === 'pdf' ? WORKING : GENERATED;
    const live = path.join(dir, liveLayer, liveFile);
    const origin = path.join(dir, ARCHIVE, manifest.archive.file);
    const onDisk = await exists(live);
    const step: ProjectStep = {
      file: `${ARCHIVE}/${manifest.archive.file}`,
      label: manifest.archive.kind === 'pdf' ? 'The scan you imported' : 'The book you imported',
      appliedAt: manifest.createdAt,
      kind: 'origin',
      retention: 'irreplaceable',
        why: WHY_IMPORTED,
    };
    documents.push({
      kind: manifest.archive.kind,
      path: onDisk ? live : origin,
      label: onDisk ? liveFile : manifest.archive.file,
      // The project's own age. Nothing recorded when this file arrived, because
      // until now nothing listed it.
      at: manifest.createdAt,
      missing: !onDisk && !await exists(origin),
      managed: false,
      steps: [step],
      origin: true,
    });
  }

  const openedAt = documents.reduce(
    (newest, row) => Math.max(newest, openedAtFor(row.path) ?? 0),
    0,
  );

  return {
    key: manifest.key,
    dir,
    title: manifest.title,
    createdAt: manifest.createdAt,
    openedAt: openedAt > 0 ? openedAt : manifest.createdAt,
    documents,
    reading: await readingState(dir, manifest),
    filed: manifest.final.length > 0,
    // The ledger already knows: a capture step is written at creation and is the
    // root of such a project. No recipe is read and no directory is listed.
    capture: ledgerOf(manifest).steps.some((step) => step.action === 'capture'),
    /*
     * ── GRAVESTONE: `pages` (Wave 41) ────────────────────────────────────────
     *
     * A boolean stood here saying `archive.kind === 'pages'`, and it existed to
     * tell two states of one capture project apart: photographs waiting to be
     * minted, and the pages a mint had made. It had to exist because BOTH states
     * held an empty `documents` list — the mint filed no catalogue row — so Home
     * printed "photographs" over a finished book and the OCR dialog needed a
     * second face to find one.
     *
     * A mint files its PDF now, so the question has a better answer that every
     * surface was already asking: `originalOf(project) === null`. Before a mint
     * there is no original and the row opens the light table; after one there is,
     * and the project is ordinary in every way a row, a dialog or a host cares
     * about. One question, one answer, no third field to keep in agreement.
     */
    exports: await filedDocuments(dir, manifest),
    facsimiles: await facsimilesOf(dir, manifest),
    problem: null,
  };
}

/**
 * What this project has FINISHED — the rows the left nav lists under it.
 *
 * ── Why the paths come out project-relative ─────────────────────────────────
 *
 * `manifest.final` stores a bare NAME, because the folder is implied by the field
 * it is in. That is right for a catalogue and wrong for something crossing a wire:
 * a project holds `archive/Book.pdf`, `working/Book.pdf`, `generated/Book.pdf` and
 * now `final/Book.pdf`, and a renderer handed four bare names would have to compose
 * the layer back on — which is the same thing as matching by basename, one process
 * further out. So the layer travels WITH the name and the renderer joins it to the
 * project directory it already has.
 *
 * ── Why a row whose file has gone is not listed ─────────────────────────────
 *
 * `final/` is the user's own tray. They may move a book onto a reader, hand it to
 * somebody, or delete it, and none of those is this app's business to prevent or to
 * notice — but a nav row that opens nothing is the app asking somebody to click a
 * thing it knows is not there. `documents` above already pays one `exists` per row
 * for the same reason; exports are few, and the stat is what makes the list true.
 *
 * NEWEST FIRST, because the export somebody is looking for is nearly always the one
 * they just made.
 */
export async function filedDocuments(dir: string, manifest: ProjectManifest): Promise<ProjectFinal[]> {
  const rows = [...manifest.final].sort((a, b) => b.madeAt - a.madeAt);
  const listed: ProjectFinal[] = [];
  for (const row of rows) {
    if (!await exists(path.join(dir, FINAL, row.file))) continue;
    listed.push({ ...row, file: `${FINAL}/${row.file}` });
  }
  return listed;
}

/**
 * Has this book been read, and does it still need to be?
 *
 * ── Two sources, and neither is enough on its own ───────────────────────────
 *
 * THE CATALOGUE says when a reading landed, because `recordReading` wrote it
 * there when the job finished. It is the cheap answer and the one with a page
 * count in it. It is also blind to every bank this app did not fill: a `foundry
 * vlm-read` run from a terminal, a project folder copied from another machine, a
 * library adopted from the old flat layout.
 *
 * THE ENGINE'S MARKER — `readings/<key>.completed.json` — is the other half. It
 * is the engine's own statement that it read every page it was asked for, it
 * sits beside the bank, and it is written by whatever ran the reading and
 * wherever it ran. One `exists` per project, which is what makes this affordable
 * on a screen that redraws whenever it comes back.
 *
 * NOT `countBankPages`. That streams every `.jsonl` under `readings/` counting
 * newlines, which is right for a delete confirmation somebody opened on purpose
 * and wrong for a library listing — it would make Home slower the more books a
 * person owned, which is the opposite of what a library is for.
 *
 * ── And `needed` is narrower than "not done" ────────────────────────────────
 *
 * A project started from an EPUB has no pages to photograph and never wanted
 * this step. Lighting OCR on it would be the app naming a next step that does
 * not exist for that book.
 */
export async function readingState(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectSummary['reading']> {
  const recorded = manifest.reading !== null && manifest.reading.readAt > 0;
  /*
   * THE POSITION'S BANK, ASKED FOR RATHER THAN COMPOSED. This line spelled
   * `readings/<key>.jsonl` out of the project key — the exact composition
   * `readingBank`'s header forbids and for its exact reason: a re-read of a
   * different page range branches into a bank of its own, so a project can hold
   * two readings, and while this composed the first one's path a position
   * standing on a BRANCH that never finished answered "done" out of the original
   * reading's marker. The dialog it opens is the one with the Generate button in
   * it, so the composition was an offer to render a book from a bank the plan was
   * never going to name.
   */
  const banked = readingBank(dir, manifest);
  const done = recorded
    // `completionMarkerFor` rather than the name composed a second time here: two
    // spellings of one file is two answers the day either of them changes.
    || await exists(completionMarkerFor(banked))
    /*
     * AND A BANK WITH ANSWERS IN IT, which is the third source: a bank can
     * arrive without a completion marker — a copy somebody moved in by hand,
     * an interrupted run — and a marker's absence must not make paid-for
     * pages read as "not read yet", with an OCR light asking the user to buy
     * them again.
     *
     * So the bank itself is asked. A file with bytes in it is a file the model
     * put page answers into, and NEVER RE-PAYING for those is the rule that
     * outranks knowing whether the last page was reached. A bank with a hole in
     * it renders a book with that hole named in the run's own log, which is the
     * behaviour the engine already has and the right one.
     *
     * BY SIZE AND NOT BY LINE COUNT: this runs for every project every time the
     * library is listed, and streaming every bank to count newlines would make
     * Home slower the more books somebody owns. The page count in a row comes
     * from the catalogue, which is where a number belongs.
     *
     * A bank being filled RIGHT NOW reads as done. That is deliberate: the queue
     * is what says a reading is in progress, and it is on screen while it is.
     */
    || await hasBytes(banked);
  return {
    done,
    /*
     * A PHOTOGRAPHED BOOK IS A PDF NOW and this reads as one clause again. It
     * said `'pdf' || 'pages'` for two days, because a mint wrote a folder and a
     * captured book is the clearest unread book in the app — it is the one kind
     * that cannot have arrived with text in it. The mint writes a container
     * (`recordMint`) and older projects are healed into one, so `pdf` covers it.
     *
     * The `pages` arm is kept for the transitional moment `summarise`'s fallback
     * is kept for: a project read between launch and its heal. An EPUB is still
     * excluded for the reason it always was — it is never OCR'd, `book = f(epub)`.
     */
    needed: !done && (manifest.archive?.kind === 'pdf' || manifest.archive?.kind === 'pages'),
    pages: recorded ? manifest.reading?.pages ?? 0 : 0,
  };
}

/** Is there a file there with anything in it? Missing and empty are one answer. */
export async function hasBytes(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).size > 0;
  } catch {
    return false;
  }
}
