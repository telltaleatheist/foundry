/**
 * projects-mint — cataloguing a mint, and healing an archive minted before the rules changed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { LedgerStep, ProjectManifest } from '../shared/types';
import { WHY_MINTED } from '../shared/types';
import { appendStep, mintedStep } from '../shared/ledger';
import { CAPTURE_RECIPE_PAYLOAD } from '../shared/capture';
import { writeAtomically } from './atomic';
import { deletableProjectDir } from './projects-delete';
import { announceProjects, exists, readManifest, withManifest, writeManifest } from './projects-manifest';
import { ARCHIVE, ProjectError, WORKING, contentKey } from './projects-paths';
import { recordStep } from './projects-rotation';
import { ledgerOf } from './projects-steps';

/**
 * A curation commit: the snapshot is already written, this is the step for it.
 *
 * The file work is `electron/overlays.ts`'s, which owns every other write to a
 * curation and its per-file serialisation; the manifest surgery is this module's,
 * because all of it happens behind `withManifest`. The split is the same one
 * `recordGenerated` draws — the engine writes the file, the catalogue learns
 * about it here.
 *
 * NO CAPTURED PARENT, and none is possible: a commit is not a queue job. It
 * happens the instant the user presses Save, so there is no gap between the
 * gesture and the recording for a pointer move to slip through, and the position
 * now IS the position they pressed it from.
 *
 * AND THE POSITION IS STILL THAT ONE AFTERWARDS. A save is retained beside where
 * you are standing rather than under it (`RETAINED_BESIDE_YOU`, shared/ledger.ts),
 * so nothing here has to remember not to move the pointer: `appendStep` already
 * knows what a curate step does to it, which is the point of putting the rule in
 * the ledger rather than at this call site.
 */

/**
 * The PAGES a mint made, filed as this project’s origin.
 *
 * ── IT USED TO BE A PDF, AND OWEN RULED THAT IT DOES NOT NEED TO BE ─────────
 *
 * *"i agree that this doesnt need to be a pdf. if the user explicitly wants to
 * export it as one, they can. but the ultimate goal here is to generate a bank
 * with the vlm"*. The mint had been assembling one JPEG per page into an
 * image-only PDF, and the next thing that happened to that PDF was a rasteriser
 * turning it back into one image per page. The pages ARE the book; a container
 * that existed only to be undone is a step this stage can simply not take.
 *
 * WHAT THE ENGINE TAKES INSTEAD is `vlm-read --pages <dir>`, which reads page
 * images as they are with no rasteriser involved — already merged, already
 * verified against three of Owen’s real photographs (src/vlm/read.ts,
 * `sourceFor`). This is the app half of that seam.
 *
 * ── TWO WRITES, ONE COMMIT POINT, AND THAT IS THE WHOLE POINT ───────────────
 *
 * A minted step alone leaves `manifest.archive` null, and `reading.needed` keys
 * off the archive’s kind — so the ledger would show a book nothing downstream
 * would ever offer to read. The archive and the step are set inside ONE
 * `withManifest`, so a project can never hold one without the other.
 *
 * ── AND IT FILES NO DOCUMENT, WHICH IS THE OTHER HALF OF THE CHANGE ────────
 *
 * There is no `recordStep(manifest, 'pdf', …)` here any more and no live copy in
 * `working/`. `documents` lists FILE TYPES THIS APP CAN OPEN, and a folder is
 * not one — `documentArchive` is where that rule is written down and why. So a
 * captured project keeps the empty document list it had all evening, Home goes
 * on opening its light table, and what the row SAYS about it changes with the
 * mint rather than staying "photographs" forever (home.component.ts).
 *
 * TWO CAPABILITIES ARE LOST UNTIL SOMEBODY BUILDS THEM, and they are named here
 * rather than discovered: there are NO FIGURE CROPS for a captured book, because
 * `vlm-book` cuts a Picture row’s image out of a PDF page and there is no PDF to
 * cut from (`bookAtPosition.pdf` is null for this kind, by the test that was
 * already there); and THE IMAGE PDF IS GONE UNTIL THE EXPORT EXISTS, which is
 * the on-demand PDF Owen said a person could ask for.
 *
 * ── A RE-MINT IS A NEW DOCUMENT AND MUST NOT LAND ON THE OLD ONE ────────────
 *
 * Every mint writes its own file in `archive/`, named apart from the last one:
 * readings hang off the STEP, whose payload is that path, and overwriting it
 * would silently re-point every reading of the first mint at pages that are not
 * the ones it read.
 *
 * The append is safe for a second reason worth writing down, because it looks
 * like luck and is not: `recordLanding` would normally look for a step to
 * REPLACE when the same action lands under the same parent with the same params
 * — which is exactly the shape of a re-mint — but `reRunTarget` refuses any
 * candidate whose retention is `irreplaceable`. The retention that makes the
 * discard warning honest is the same field that stops a re-mint eating the
 * document before it. This builds the step directly regardless, so the
 * guarantee does not rest on a helper’s exclusion list staying as it is.
 *
 * WORKING/ STILL HOLDS ONE PDF, which is the app’s rule and not this one’s, so a
 * re-mint replaces the live copy. THE EARLIER MINT’S ROW STILL OPENS ANYWAY, and
 * this paragraph used to say it did not — measured with both mints present:
 * standing on the newer one resolves to `working/index.pdf` and standing on the
 * older one resolves to `archive/index.pdf`, which is on disk and is that mint’s
 * own book. `documentOfStep` answers with the step’s payload when no working row
 * was made from it, so losing the live copy costs the row nothing but the layer
 * it opens from. Wave 21b rules on that behaviour — older mints stay reachable by
 * standing on their step — so the comment was the half that was wrong.
 */
/**
 * EIGHT HEX CHARACTERS FOR A FOLDER OF PAGES — `archive.contentKey`, which
 * stands for "which import is this".
 *
 * TRANSITIONAL SINCE WAVE 41. A mint's archive is a FILE again and its key is
 * that file's own sha256 (`fileKey`); this survives for `archiveAfterLoss`'s
 * pages arm, which is reachable only for a project discarded from between its
 * launch and its heal.
 *
 * ── Why it is not the bytes ─────────────────────────────────────────────────
 *
 * For a file it was that file's own sha256. There is no one file in a pages
 * archive, and streaming several hundred megabytes of JPEG through a hash to
 * fill in a field that nothing in this app compares against would be minutes of
 * disk spent on a label. What a mint IS, is a page count, a size and the
 * arrangement it was printed from: two mints agreeing on all three are the same
 * shoot printed twice, and that is the whole of what this key ever had to say.
 *
 * MEASURED OFF THE DISK RATHER THAN TAKEN FROM THE WRITER, because the writer's
 * count is a claim about what it meant to do and this is a fact about what is
 * there — and the one failure this key could hide is a mint that wrote fewer
 * pages than it thought.
 */
export async function pagesKey(dir: string, arrangement: string): Promise<string> {
  const names = (await fsp.readdir(dir)).sort();
  let bytes = 0;
  for (const name of names) bytes += (await fsp.stat(path.join(dir, name))).size;
  return createHash('sha256')
    .update(`${names.length}:${bytes}:${arrangement}`).digest('hex').slice(0, 8);
}

/**
 * What a minted PDF is called, in the app's voice.
 *
 * ONE SPELLING FOR THREE WRITERS: the ledger step, the per-type chain, and
 * `mintedStep`'s own default all say these words. A label is STORED rather than
 * derived, so two spellings would sit side by side in one project's history and
 * read as two different events that happened to the same file.
 */
export const MINTED_LABEL = 'The pages you minted';

/**
 * `arrangement` IS PASSED IN RATHER THAN READ HERE, and the reason is not module
 * layout. It is `arrangementOf` applied to the recipe THE MINT WAS BEGUN FROM —
 * the same read that produced the page list the renderer rasterized — so the
 * string describes the book that was actually printed even if somebody edited
 * the recipe in the minutes it took to print. Reading the file again at this end
 * would record what the recipe says NOW, which is the one thing it must not be.
 */
export async function recordMint(
  dir: string,
  /** The assembled image-only PDF, bytes and all (`assemblePdf`, capture.ts). */
  pdf: Buffer,
  arrangement: string,
): Promise<LedgerStep> {
  const resolved = deletableProjectDir(dir);
  const step = await withManifest(resolved, async (manifest) => {
    const ledger = ledgerOf(manifest);
    const capture = ledger.steps.find((row) => row.action === 'capture');
    if (capture === undefined) {
      throw new ProjectError(
        `${path.basename(resolved)} has no capture step, so there are no photographs for a mint to be `
        + 'made from. Only a project that arrived as photographs can be minted.',
      );
    }

    await fsp.mkdir(path.join(resolved, ARCHIVE), { recursive: true });
    const named = await mintName(resolved, manifest.stem);
    await writeAtomically(path.join(resolved, ARCHIVE, named.name), pdf);
    await catalogueMint(resolved, manifest, named.name, async (into) => {
      await writeAtomically(into, pdf);
    });

    const minted = mintedStep(
      randomUUID(), capture.id, named.archived, Date.now(), arrangement, MINTED_LABEL,
    );
    manifest.ledger = appendStep(ledger, minted);
    await writeManifest(resolved, manifest);
    return minted;
  });
  announceProjects();
  return step;
}

/**
 * A name in `archive/` this project has not spent, for the book a mint made.
 *
 * Named apart from every mint before it, for the reason it always was: readings
 * hang off the STEP, whose payload is this name, and re-using it would silently
 * re-point every reading of the first mint at pages that are not the ones it
 * read. The stem stays the document's name; the suffix only appears once there
 * is something to tell apart.
 *
 * ONE FUNCTION FOR TWO WRITERS. The mint spends a name and so does the heal
 * (`healMintedArchive`), and the heal runs in a project that may already hold
 * two mints' worth of folders — so the two must agree about which names are
 * taken or a heal could land its PDF over a mint's.
 */
export async function mintName(resolved: string, stem: string): Promise<{ name: string; archived: string }> {
  let name = `${stem}.pdf`;
  for (let n = 2; await exists(path.join(resolved, ARCHIVE, name)); n++) {
    name = `${stem} (${n}).pdf`;
  }
  return { name, archived: `${ARCHIVE}/${name}` };
}

/**
 * FILE A MINTED PDF THE WAY AN IMPORT FILES A SCAN — the manifest half of
 * Owen's ruling, and the whole reason this wave exists.
 *
 * ── What a captured project stopped being able to answer ────────────────────
 *
 * Between `ecbf238` and this wave a mint wrote a folder and set
 * `manifest.archive = {kind: 'pages', file: '<stem> pages'}`, and `documents`
 * stayed EMPTY on purpose — a folder is not a file type anything opens, so
 * filing it as a document row would have put a path to a directory in front of a
 * PDF reader. That was the right call about a folder and the wrong shape for a
 * project: every consumer that asks *"what file was this book made from"* got
 * nothing. BookForge's adoption says it plainest — it refuses a project that
 * *"records no imported original — its catalogue's archive names no file"*.
 *
 * Owen: *"the pdf can exist so it doesnt confuse bookforge or anything else"*,
 * and *"the system isnt trying to sift through images, it's using the original
 * pdf just like it normally would"*. So the mint now catalogues its book exactly
 * as `importDocument` catalogues a scan somebody dragged in, and from that moment
 * the project is ORDINARY: `originalOf` answers, Home draws a book, the three
 * make-dialogs find a source, the figure cutter has a PDF to cut from, and a host
 * reading the catalogue finds a file.
 *
 * ── THE FOUR WRITES, AND THEY ARE `importDocument`'s FOUR ───────────────────
 *
 *   1. `archive/<name>` — the origin of record, written by the caller before
 *      this runs, because only the caller has the bytes and the heal's bytes
 *      arrive a different way from the mint's.
 *   2. `manifest.archive` — kind `pdf` now, which is what turns `reading.needed`,
 *      `bookAtPosition.pdf` and `documentArchive` on for a captured book.
 *   3. `working/<stem>.pdf` — the live copy, and `liveCopyOf` matches a working
 *      row's `from` against the step's payload, so `archived` here and the
 *      step's payload have to be the same string. Made through the caller's
 *      `live` callback for the reason (1) is: the mint has the buffer in hand
 *      and the heal would rather copy the file it just wrote than hold a second
 *      copy of a shoot in memory.
 *   4. The `documents` origin row — `recordStep(manifest, 'pdf', …)`, which is
 *      what `readDocuments` builds `ProjectSummary.documents` out of and
 *      therefore what `originalOf` picks from.
 *
 * NO `onlyIfEmpty` ON THE STEP, and that is the one place this deliberately
 * differs from the import. An import may run twice over one book and must not
 * write a second account of it; a RE-MINT is a genuinely new document, and the
 * chain is the record of every book this project has minted. `recordStep`
 * appends, `archiveAfterLoss` walks the same chain backwards when a mint is
 * discarded, and the newest entry is the book on the shelf.
 *
 * THE LEDGER IS NOT TOUCHED HERE. A capture project's ledger already has a root
 * — the photographs — so `originLedger` would be wrong twice over: it hard-codes
 * `parent: null`, and `parseLedger` refuses a ledger with two roots. The mint
 * step is the ledger's account of this book and the caller appends it.
 */
export async function catalogueMint(
  resolved: string,
  manifest: ProjectManifest,
  name: string,
  live: (into: string) => Promise<void>,
): Promise<void> {
  const archived = `${ARCHIVE}/${name}`;
  const liveFile = `${manifest.stem}.pdf`;
  await fsp.mkdir(path.join(resolved, WORKING), { recursive: true });
  await live(path.join(resolved, WORKING, liveFile));

  manifest.archive = {
    file: name,
    kind: 'pdf',
    contentKey: await fileKey(path.join(resolved, ARCHIVE, name)),
    // There is no path this came from: it was made here, out of photographs
    // this project already holds. The recipe is the honest answer.
    originPath: path.join(resolved, ...CAPTURE_RECIPE_PAYLOAD.split('/')),
  };
  manifest.working.files = [
    ...manifest.working.files.filter((row) => row.file !== liveFile),
    { file: liveFile, kind: 'pdf', from: archived, madeAt: Date.now() },
  ];
  recordStep(manifest, 'pdf', {
    file: archived,
    label: MINTED_LABEL,
    appliedAt: Date.now(),
    kind: 'origin',
    /*
     * IRREPLACEABLE, AND IT IS NOT A COURTESY. The photographs behind this book
     * may be the only copies of a document that exists nowhere else, and the
     * arrangement that turned them into pages is somebody's evening. Discarding a
     * mint has to warn like a deletion because it is one — and `reRunTarget`
     * refuses to REPLACE any step whose retention is this, which is the same
     * field that stops a re-mint eating the document before it.
     */
    retention: 'irreplaceable',
    why: WHY_MINTED,
  });
}

/** Eight hex characters of a file's own bytes — `archive.contentKey`. */
export async function fileKey(target: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(target)).digest('hex').slice(0, 8);
}

/**
 * THE PROJECTS THIS PROCESS HAS ALREADY TRIED TO GIVE A CONTAINER TO, each held
 * as the attempt itself so a caller can wait on one somebody else started.
 *
 * The figure heal's set, for the figure heal's reason (`figuresHealed`,
 * electron/book.ts): a SUCCESSFUL heal answers "no" forever after, because the
 * manifest it wrote says `kind: 'pdf'` and can never say `pages` again. What
 * this also covers is the other ending — a heal that FAILS, on a folder somebody
 * moved or a disk that filled — which would otherwise spawn one assembly per
 * catalogue read, and a catalogue is read every time anything announces.
 *
 * Once per project per process is enough to learn that; the person's next launch
 * tries again, which is right, because what was wrong may have been fixed in
 * between.
 *
 * FOLDED WHOLE PATHS, never basenames — the rule this repo keeps everywhere.
 */
export const containersHealed = new Map<string, Promise<void>>();

/**
 * A CAPTURED PROJECT MADE BEFORE THIS WAVE GETS ITS PDF — the migration half of
 * Owen's ruling.
 *
 * ── What is on the disk, and what is missing ────────────────────────────────
 *
 * Two of Owen's books were minted while the mint wrote pictures and no
 * container: `archive/<stem> pages/` full of `page-0001.jpg` upward, an archive
 * record whose `file` is that FOLDER, and an empty `documents` list. Everything
 * downstream that asks a project what it was made from gets nothing — which is
 * the defect that opened this wave, reported from BookForge's adoption as *"its
 * catalogue's archive names no file"*.
 *
 * Nothing about those projects is broken. The pages are all there, the bank is
 * read, the book file is beside it. What is missing is one file, and this makes
 * it, out of the pages the project already holds, and files it exactly as a mint
 * now does (`catalogueMint`) — same archive record, same live copy, same
 * `documents` origin row. After this runs the project is indistinguishable from
 * one minted today, which is the whole point: there is no third kind of project.
 *
 * ── THE ORDER IS THE FOLDER'S OWN NAMES ─────────────────────────────────────
 *
 * `mintCommit` wrote `page-0001.jpg` upward, zero-padded to four digits,
 * precisely so a plain lexicographic sort is reading order — verified against
 * the writer that made these files rather than assumed. So `readdir().sort()` is
 * the book, and nothing here re-derives the arrangement from the recipe: the
 * recipe is editable and these pages are not, so the folder is the only record
 * of what this book actually says and the only one that cannot have moved on.
 *
 * ── THE PAGES FOLDER IS KEPT, AND THAT IS NOT AN OVERSIGHT ──────────────────
 *
 * A HEAL NEVER DELETES USER DATA. The folder becomes unreferenced — the archive
 * record names the PDF, the mint step's payload is re-pointed at the PDF, and
 * nothing in the app lists a `pages` directory any more — and it stays on the
 * disk anyway. These are the rectified pages of somebody's book, this app is
 * mid-migration around them, and a migration that frees disk by erasing the
 * thing it was migrating has no way to be sorry. (A NEW mint leaves no folder at
 * all; the two are different because one is a fresh write and the other is
 * somebody's existing project. `mintCommit` states that call.)
 *
 * ── HOW IT COMPOSES WITH THE FIGURE HEAL, WHICH IT MUST RUN BEFORE ──────────
 *
 * `ensureReadingBook` (electron/book.ts) remakes a book whose figures were never
 * cut once a source exists. For these two projects the source was a folder and
 * the reflow's `--pages` face only arrived at Wave 37; now it is a PDF and the
 * ordinary `--pdf` face cuts them. THE ORDER MATTERS AND IS GUARANTEED BY THE
 * CALL SITE: this is awaited at the top of `bookAtPosition`, which is what
 * composes the `pdf` field the figure heal then reads, so the container exists
 * before anything asks whether the figures do. PDF first, then figures.
 *
 * ── THE STEP'S PAYLOAD MOVES WITH IT ────────────────────────────────────────
 *
 * The mint step's payload named the folder, and readings hang off the step. It
 * is re-pointed at the PDF in the same `withManifest` as everything else, so a
 * project can never hold a step naming a folder beside an archive naming a file.
 * That is safe for the reason the mint's own naming rule is safe: the payload
 * identifies WHICH MINT, and this mint still has exactly one book — the same
 * pages, in the same order, in a container.
 *
 * A REFUSAL IS A LOG LINE AND NOTHING ELSE. The project opened fine yesterday
 * and opens fine today; what it loses is the doors this wave was opening. The
 * caller is never failed over a migration.
 */
export function healMintedArchive(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const key = resolved.toLowerCase();
  /*
   * ── THE ATTEMPT IS REMEMBERED AS A PROMISE, WHICH IS TWO RULES IN ONE ──────
   *
   * ONCE PER PROJECT PER PROCESS. `listProjects` fires this for every project in
   * the library every time anything announces, and Home announces often; a guard
   * that only remembered the projects it had HEALED would re-read every healthy
   * catalogue in the library on each of those, and would spawn a fresh assembly
   * every time for one whose folder had gone. Remembering the ATTEMPT rather
   * than the outcome is the figure heal's own rule (`figuresHealed`,
   * electron/book.ts) and it is safe here for a stronger reason: nothing in this
   * app writes a `pages` archive any more, so a project found in order once is
   * in order for the session.
   *
   * AND AN AWAITED CALLER JOINS AN ATTEMPT ALREADY RUNNING, which a `Set` could
   * not do and which is the whole reason this is a `Map`. `listProjects` starts
   * the heal WITHOUT waiting (a library screen must not stand behind a
   * migration) and `bookAtPosition` AWAITS it (the container has to exist before
   * `pdf` is composed from it). With a set of names, the second call would find
   * the name already marked, return instantly, and read a manifest that the
   * assembly still in flight had not finished rewriting — the ordering guarantee
   * lost to the guard that was supposed to make it cheap.
   *
   * IT NEVER REJECTS: every failure is caught and logged inside, so a caller
   * that awaits a heal is never failed by one.
   */
  const already = containersHealed.get(key);
  if (already !== undefined) return already;
  const attempt = healOnce(resolved);
  containersHealed.set(key, attempt);
  return attempt;
}

/** One attempt, start to finish. Never throws — see `healMintedArchive`. */
export async function healOnce(resolved: string): Promise<void> {
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(resolved);
  } catch {
    // A catalogue that will not parse is `summarise`'s problem to report, in its
    // own sentence. Nothing here can heal one and nothing here should say so.
    return;
  }
  if (manifest.archive === null || manifest.archive.kind !== 'pages') return;

  const folder = manifest.archive.file;
  const from = path.join(resolved, ARCHIVE, folder);
  try {
    const names = (await fsp.readdir(from))
      .filter((name) => MINTED_PAGE_TYPES.has(path.extname(name).toLowerCase()))
      .sort();
    if (names.length === 0) {
      throw new ProjectError(`${from} holds no page images, so there is nothing to assemble.`);
    }
    console.warn(
      `[projects] ${manifest.title} was minted before this app wrote a container, so its `
      + `${names.length} pages are being assembled into one now. The pages stay where they are.`,
    );
    const pdf = await pagesAsPdf(from, names);
    await withManifest(resolved, async (held) => {
      // Re-read behind the lock: `readManifest` above was outside it, and a mint
      // or a discard landing in between would make this heal an argument with a
      // newer truth rather than a migration of an older one.
      if (held.archive === null || held.archive.kind !== 'pages') return;
      await fsp.mkdir(path.join(resolved, ARCHIVE), { recursive: true });
      const named = await mintName(resolved, held.stem);
      await writeAtomically(path.join(resolved, ARCHIVE, named.name), pdf);
      await catalogueMint(resolved, held, named.name, async (into) => {
        await fsp.copyFile(path.join(resolved, ARCHIVE, named.name), into);
      });
      const was = `${ARCHIVE}/${folder}`;
      held.ledger = {
        ...ledgerOf(held),
        steps: ledgerOf(held).steps.map((step) => (
          step.payload === was ? { ...step, payload: named.archived } : step
        )),
      };
      await writeManifest(resolved, held);
    });
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${manifest.title} could not be given the container its pages belong in: `
      + `${err instanceof Error ? err.message : String(err)}\n`
      + 'The project is unchanged and its pages are untouched; it opens exactly as it did.',
    );
  }
}

/**
 * What a minted page can be, so a stray file in the folder is not bound in.
 *
 * The mint wrote JPEG and nothing else; the others are here because a person
 * looking at their own project folder is entitled to have put a PNG in it. This
 * list is READ-ONLY history now — nothing writes such a folder any more — and it
 * exists for exactly as long as somebody somewhere has an unhealed project.
 */
export const MINTED_PAGE_TYPES = new Set(['.jpg', '.jpeg', '.png']);

/**
 * A folder of page images as one image-only PDF, in the order given.
 *
 * THE SAME CONTAINER THE MINT WRITES, and deliberately not the same code: the
 * mint knows the page sizes it asked the renderer for, and a heal knows nothing
 * except what is in the files. So the box is taken from the EMBEDDED IMAGE's own
 * dimensions at the same nominal 300 dpi — pdf-lib reads them out of the JPEG's
 * frame header — which for a page the mint itself rectified is the same number by
 * a different route.
 *
 * A PNG IS EMBEDDED AS A PNG. `embedJpg` refuses one by name, and a folder a
 * person has added to is exactly where one turns up.
 */
export async function pagesAsPdf(dir: string, names: readonly string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const name of names) {
    const bytes = await fsp.readFile(path.join(dir, name));
    const png = path.extname(name).toLowerCase() === '.png';
    const image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const width = (image.width * 72) / MINT_DPI;
    const height = (image.height * 72) / MINT_DPI;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await pdf.save());
}

/** Nominal dots per inch for a healed page box. 72 points to the inch. */
export const MINT_DPI = 300;
