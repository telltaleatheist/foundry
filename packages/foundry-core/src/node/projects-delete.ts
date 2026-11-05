/**
 * projects-delete — deleting a project or a document: what is there, and what deleting would take.
 */
import { createReadStream, promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';
import type { ProjectManifest } from '../shared/types';
import { readJson } from '../shared/json';
import { summarise } from './projects-list';
import { announceProjects, edits, exists, readManifest, withManifest, writeManifest } from './projects-manifest';
import { FINAL, ProjectError, WORKING, projectsDir } from './projects-paths';
import { curationsDir } from './projects-steps';

// ─────────────────────────────────────────────────────────────────────────────
// Deleting one — the only place in this app where something really goes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prove `dir` is a project directory, and hand it back resolved. Or refuse.
 *
 * THIS IS A SECURITY BOUNDARY, not a tidiness check, and it is worth being blunt
 * about why. `deleteProject` calls `fsp.rm(dir, { recursive: true })`. The `dir`
 * it is given came across IPC from the renderer — a page that runs a book's own
 * markup in an iframe and an OpenAI-compatible endpoint's answers through a
 * parser. Every other door in this app that touches a path the renderer named
 * asks main's own allow-list first (`admitted`, electron/documents.ts) precisely
 * because a
 * renderer's word is not an authorization. This function is the whole of that
 * gate for the one call that erases directories, so if it is wrong, an argument
 * of `C:\Users\you` is a recursive delete of a home folder.
 *
 * A DIRECT CHILD, not a descendant. `projectDirOf` above answers "which project
 * is this path in", which is the right question for reading and the wrong one
 * here: it maps `…/projects/<key>/working/<tree>/EPUB` to the project, and a
 * containment test built on it would happily accept a path that is not a project
 * at all. What may be deleted is exactly the thing Home lists — one segment
 * under `projectsDir()` — so the test is that `path.relative` from the root
 * yields exactly ONE segment. That rejects the root itself (empty), anything
 * above it (`..`), anything on another drive (`path.relative` returns an absolute
 * path across Windows volumes), and every path deeper than a project.
 *
 * `path.resolve` first, so `.` and `..` inside the argument are spent before the
 * comparison rather than after it — a string test against an unresolved path is
 * the classic way this check gets defeated.
 *
 * NO EXCEPTIONS. If something ever needs to erase a directory that is not a
 * project, it does not get to reach it through here.
 *
 * THE STEP-LEDGER CALLS ASK IT TOO, and that is the check being used for exactly
 * what it is rather than being widened. `deleteStep` unlinks payload files inside
 * a directory the renderer named, which is the same authorization problem one
 * level down, and its describe/read/go siblings ask the same question so that no
 * member of that family is the lenient way in — a gate that only guards the
 * destructive call is a gate somebody routes around by reading first.
 */
export function deletableProjectDir(dir: string): string {
  const root = projectsDir();
  const resolved = path.resolve(dir);
  const inside = path.relative(root, resolved);
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside)
    || inside.split(path.sep).length !== 1) {
    throw new ProjectError(
      `${resolved} is not one of Foundry's projects — those are the directories directly inside `
      + `${root}, and nothing else may be deleted. Refusing to erase it.`,
    );
  }
  return resolved;
}

/** What is in a project, for the sentence that asks whether to erase it. */
export interface ProjectInventory {
  /** The directory, resolved and PROVEN to be one this app may delete. */
  dir: string;
  /** The book's own title where anything has read one, the key otherwise. */
  title: string;
  /**
   * Pages the model has already read and answered for, across every bank in
   * `readings/` — including the ones a re-cast rotated into `archived-<stamp>/`.
   *
   * THE ONE NUMBER THE DIALOG EXISTS TO SAY. Everything else in a project can be
   * made again from something: the archive is a copy of a file the user still
   * has, the working tree unpacks from the origin, the final edition rebuilds
   * from the working tree. A bank is GPU-hours and there is no second source for
   * it anywhere on disk, so a person deleting one should be told how many.
   */
  readings: number;
  /**
   * How many documents this project has — the scan, the book, translations.
   *
   * COUNTED BY ASKING `summarise`, which is the function Home's rows come from,
   * because the two numbers have to be the same number. It used to count
   * `manifest.documents` directly and was wrong for every PDF-only project in the
   * library: those carried an empty `documents` list (see `healImport`) and were
   * drawn from `summarise`'s archive fallback, so Home showed a book and the
   * delete card, one click later, said "nothing has been made from it yet" about
   * the same folder.
   *
   * A second count is how two screens come to disagree about one directory. This
   * costs a manifest read and a handful of `exists` calls on a path somebody
   * opened a confirmation dialog on, which is nothing.
   */
  documents: number;
  /** True once anything has been filed into `final/`. That copy is in here too. */
  filed: boolean;
  /** Everything under the directory, in bytes. A scan is most of it. */
  bytes: number;
  /**
   * Corrections a PERSON made about the blocks on the pages — every amendment in
   * every overlay under `overlays/`, archived ones included.
   *
   * THE SECOND NUMBER THIS DIALOG EXISTS TO SAY, and by the retention rule
   * (`ProjectStep.retention`) it is the more expensive of the two. A readings
   * bank is `expensive`: hours of GPU, and a machine can make it again. A
   * curation is `irreplaceable` — somebody looked at four hundred pages and said
   * what was on them, and nothing on this disk or any other can reproduce that.
   */
  amendments: number;
}

/**
 * Read a project for the delete confirmation, without touching a thing.
 *
 * Checks the path FIRST, before it reads a byte, so a caller that named
 * something that is not a project is refused by the same sentence whether it got
 * as far as the dialog or not.
 *
 * A CATALOGUE THAT WILL NOT PARSE IS NOT FATAL HERE, and that is the one place
 * in this file where that is true. Everywhere else a bad `project.json` stops
 * the operation because the operation depends on knowing what is in the folder;
 * delete depends on nothing but the folder existing, and a project whose
 * catalogue is broken is exactly the project a person most wants to be rid of.
 * The row on Home already carries the reason, and the title falls back to the
 * directory's own key.
 */
export async function inspectProject(dir: string): Promise<ProjectInventory> {
  const resolved = deletableProjectDir(dir);
  let manifest: ProjectManifest | null = null;
  try {
    manifest = await readManifest(resolved);
  } catch {
    manifest = null;
  }
  return {
    dir: resolved,
    title: manifest?.title ?? path.basename(resolved),
    readings: await countBankPages(path.join(resolved, 'readings')),
    // THE ROWS HOME DREW, from the function that drew them. See the field's own
    // note: counting the catalogue instead said "nothing has been made from it"
    // about every project the user had ever imported a scan into.
    documents: manifest === null
      ? 0
      : (await summarise(resolved, path.basename(resolved))).documents.length,
    filed: (manifest?.final.length ?? 0) > 0,
    bytes: await measure(resolved),
    /*
     * BOTH FOLDERS, because a project delete destroys both.
     *
     * `curations/` did not exist when this number was written and it holds the
     * same thing `overlays/` does — a person's decisions about the blocks on the
     * pages — frozen, retained, and named by a step. A card that counted only the
     * live pair would quietly under-report the irreplaceable half of what is about
     * to be erased, which is the one direction this sentence must never be wrong
     * in.
     *
     * A SNAPSHOT'S DECISIONS OVERLAP THE LIVE FILE'S and are counted anyway, which
     * is what this number has always been: every amendment in every curation file
     * under the project, not a count of distinct decisions. What the figure
     * conveys is how much recorded judgement is in this folder, and every one of
     * those snapshots is a separate thing that will not exist afterwards.
     */
    amendments: await countAmendments(curationsDir(resolved)),
  };
}

/**
 * Amendments in every overlay under `dir`, by counting them.
 *
 * PARSED RATHER THAN LINE-COUNTED, which is the opposite of `countBankPages` and
 * for the opposite reason: a bank is one JSON object per line so its newlines ARE
 * its pages, while an overlay is one JSON document whose lines are formatting. It
 * is also small — a heavily curated book is a few hundred amendments — so reading
 * it whole costs nothing worth avoiding.
 *
 * A file that will not parse counts as nothing. The number informs a question,
 * and a delete button that does not work because a count failed is worse than a
 * count that is low.
 */
export async function countAmendments(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // No overlays: nobody has corrected this book.
  }
  let amendments = 0;
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    // Recursive, because `archived-<stamp>/` overlays are somebody's work too —
    // they are kept precisely because a re-read must never destroy a curation,
    // and a project delete is about to destroy every one of them.
    if (entry.isDirectory()) {
      amendments += await countAmendments(here);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      try {
        const parsed: unknown = readJson(await fsp.readFile(here, 'utf8'));
        const list = (parsed as { amendments?: unknown })?.amendments;
        if (Array.isArray(list)) amendments += list.length;
      } catch { /* not an overlay this app can read; not a reason to fail a dialog */ }
    }
  }
  return amendments;
}

/**
 * Erase the whole project directory. There is no undo and nothing is kept.
 *
 * THROUGH THE EDIT CHAIN (`edits`), not around it. A background
 * `noteProjectTitle` or a job recording its output can be mid-write when this
 * runs, and a manifest write that lands after the `rm` would recreate the
 * directory with a lone `project.json` in it — a ghost project on Home naming a
 * book with no files. Queuing behind whatever is in flight costs nothing;
 * projects are edited perhaps twice a minute.
 *
 * It reads no manifest to get there, deliberately: `withManifest` would refuse a
 * project whose catalogue does not parse, and those are deletable too.
 *
 * `force: true` so a directory that is already half gone — an earlier delete
 * that hit a locked file — finishes rather than refusing. The path check has
 * already run and runs again here; being generous about a missing file is not
 * being generous about which directory this is.
 *
 * RETRIED, AND THEN LOUD, because Windows makes deletion a race against
 * whoever is READING. `rm` walks the tree and dies at the first file some
 * process holds open without delete-sharing — this app's own window showing a
 * figure was enough — and a delete that dies mid-walk leaves a partial
 * directory that LOOKS deleted from Home. The same book imported again then
 * lands on this exact name-keyed path, on top of the debris, and the leftovers
 * resurface inside a project that believes itself fresh. The retries ride out
 * the transient holds; a hold that outlasts them is a real answer, and it is
 * thrown as a sentence naming the directory rather than as a bare errno,
 * because the fix is on the other end of a window somebody has open.
 */
export async function deleteProject(dir: string): Promise<void> {
  const resolved = deletableProjectDir(dir);
  const key = resolved.toLowerCase();
  const previous = edits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* see withManifest — a failed edit must not block this */ })
    .then(async () => {
      try {
        await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (err) {
        throw new ProjectError(
          `${resolved} could not be fully deleted (${(err as Error).message}). Something on this `
          + 'machine is holding one of its files open — a window showing it, a sync client, an '
          + 'antivirus scan. Close it and delete the project again; what was already removed '
          + 'stays removed.',
        );
      }
      // The rm resolving is not the directory being gone — `force` swallows
      // whole classes of per-file refusals — and a delete that reports success
      // over a surviving directory is how debris ends up inside the next
      // import of the same book.
      if (await exists(resolved)) {
        throw new ProjectError(
          `${resolved} is still there after the delete — something on this machine is holding one `
          + 'of its files open (a window showing it, a sync client, an antivirus scan). Close it '
          + 'and delete the project again; what was already removed stays removed.',
        );
      }
    });
  edits.set(key, next);
  await next;
  // Nothing may queue behind a directory that is gone: the same book imported
  // again lands on this exact path (the key is of its content), and a fresh
  // project chained after this promise would be waiting on a delete for no
  // reason anybody could find later.
  if (edits.get(key) === next) edits.delete(key);
}

/**
 * The project a FILE belongs to, proven rather than assumed.
 *
 * `deletableProjectDir`'s gate, one level out: what may be deleted here is a file
 * strictly INSIDE one of Home's projects, so the test is that `path.relative`
 * from `projectsDir()` yields two segments or more and the first of them is a
 * project. That rejects the root, anything above it, anything on another volume,
 * a project directory itself (which is `deleteProject`'s business and not this
 * one's), and every arbitrary path a renderer might name.
 *
 * THE SAME REASONING AS `deletableProjectDir`, AND FOR THE SAME REASON. This is
 * the whole of the gate on a call that unlinks a file whose path came across IPC
 * from a page that runs a book's own markup in an iframe. A renderer's word is
 * not an authorization here either.
 */
export function deletableDocumentPath(filePath: string): { dir: string; resolved: string } {
  const root = projectsDir();
  const resolved = path.resolve(filePath);
  const inside = path.relative(root, resolved);
  const parts = inside.split(path.sep);
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside) || parts.length < 2) {
    throw new ProjectError(
      `${resolved} is not a document inside one of Foundry's projects — those live under `
      + `${root}, and nothing else may be deleted. Refusing to erase it.`,
    );
  }
  return { dir: path.join(root, parts[0]!), resolved };
}

/**
 * What ELSE goes when one document is deleted — counted, so the card can say so.
 *
 * ── What is in here, and the evidence for each ──────────────────────────────
 *
 * ARCHIVED PREDECESSORS. `rotateGenerated` moves `generated/<file>` aside into
 * `generated/archived-<stamp>/<file>` before a rerun writes, so those are
 * previous versions of THE VERY FILE being deleted — five of them in the
 * Kershaw project from one evening's reruns. Matched by basename inside the
 * file's own parent directory, which is exact rather than approximate: an output
 * name is derived from the project's stem and its format (`generatedFileFor`),
 * so at most one live document can carry a given basename, and every archived
 * copy of that name is a former life of it.
 *
 * AND THAT IS THE WHOLE LIST NOW. Two other things used to be in it and both went
 * with the surfaces that made them (docs/RENDERER.md §7): the unpacked working
 * TREE a rotation parked beside the file, and `history/<tree>.json`, the block
 * editor's undo ledger keyed to that tree. Nothing writes either any more; a
 * project that still holds one keeps it, because sweeping somebody's records to
 * tidy a folder is not a thing this app does.
 *
 * ── What is NOT in here, and these are decisions ────────────────────────────
 *
 * THE READINGS BANK, above all — and it is the COST RULE in its purest form
 * (`ProjectStep.retention`). `readings/` is the stored result of the expensive
 * pass: it belongs to the source book rather than to any output made from it,
 * it is hours of GPU, it cannot be remade from anything else on the disk, and it
 * is the entire reason a conversion can be run again for nothing. Deleting the
 * EPUB must never cost the bank — the whole point of throwing an output away is
 * usually to make a better one from the same readings. (Deleting the book's own
 * row is a different act: that is a project delete, it takes the bank with
 * everything else, and it says so in those words.)
 *
 * THE FILED COPY. `final/` is where the user themself put a copy on purpose
 * (`recordFinal`), which makes it theirs rather than the workspace's. A delete
 * of the working document that also went and destroyed the copy somebody
 * deliberately filed would be reaching outside what was asked for — the same
 * reason a Save As to a USB stick is left alone.
 *
 * THE OPS AND THE FROZEN CURATIONS (`ops/`, `curations/`), and this is the bank's
 * rule carried one step further. A decision about the book is not about the EPUB —
 * it is about the READING, keyed by block id rather than by any output: the two
 * hundred running heads somebody struck are struck for every future rendering as
 * much as for the one being deleted. And deleting an output in order to make a
 * better one is the ordinary reason to delete an output, which is exactly the case
 * where destroying the decisions would be worst. By the retention rule they are
 * `irreplaceable` where the bank is merely `expensive`; a project delete takes
 * them, says so in those words, and nothing else does.
 */
export interface DocumentAssets {
  /** Previous versions of this same file, rotated aside by earlier runs. */
  archivedVersions: number;
}

/** What became of a document that was asked to be deleted. */
export interface DocumentRemoval {
  /** The project's own title, for the sentence the notice strip shows. */
  title: string;
  /** The file's name, as the catalogue spelled it. */
  label: string;
  /** True when the bytes were already gone and only the row was cleared. */
  wasMissing: boolean;
  /** What went with it, so the notice can account for more than the one file. */
  assets: DocumentAssets;
}

/**
 * Erase one document out of a project: the file, and its row in the catalogue.
 *
 * BOTH, OR THE PROJECT LIES ABOUT ITSELF. A file removed without its row leaves
 * Home and the side nav listing a document that is not there — which is exactly
 * the "not there any more" state, and it is the right state for a file somebody
 * moved behind the app's back, but it is a silly thing to CREATE on purpose. A
 * row removed without the file leaves bytes in the folder nothing can reach.
 *
 * A FILE THAT IS ALREADY MISSING IS STILL REMOVABLE, and that is the decision
 * worth recording. Its row is the only thing left of it, the row is what the
 * user is looking at and asking to be rid of, and refusing on the grounds that
 * the file is already gone would leave them with a listing they cannot clean and
 * no way to understand why. `force: true` on the unlink makes the two cases one
 * code path; `wasMissing` is carried back so the sentence can say which happened.
 *
 * THROUGH THE EDIT CHAIN, like every other manifest write: a job recording its
 * output can be mid-write, and a manifest read here that lands between another
 * writer's read and its write would be lost with it.
 */
export async function deleteDocument(filePath: string): Promise<DocumentRemoval> {
  const { dir, resolved } = deletableDocumentPath(filePath);
  const wasMissing = !await exists(resolved);

  const label = path.basename(resolved);
  let title = path.basename(dir);
  let sweep: Sweep = emptySweep();

  await withManifest(dir, async (manifest) => {
    title = manifest.title ?? title;
    sweep = await planSweep(dir, resolved, manifest);

    /*
     * A ROW IS MATCHED IN ITS OWN LAYER, AND THIS IS A BUG FIX WITH A CASUALTY.
     *
     * It used to resolve a row's basename against `generated/`, `working/` AND
     * `final/` and delete the row if ANY of them equalled the path being
     * removed. Every list was tested against every layer, so a name that appears
     * in two layers — which is the ordinary case, since the live PDF is a COPY
     * of the generated one and carries the same filename — matched twice.
     *
     * Deleting `generated/<book>.pdf` therefore struck the `working/<book>.pdf`
     * row out of the catalogue as well, while `fsp.rm` removed only the file it
     * was actually given. That is exactly what happened to the Kershaw project
     * on this machine: `working.files` came back `[]` with the working PDF still
     * sitting on disk, and the app then had a book it was storing every byte of
     * and would not list. Item 2's reconciliation exists because of this, and
     * this is why it must never happen again.
     *
     * Each list now asks only about its own directory.
     */
    const inLayer = (layer: string) => (file: string): boolean =>
      path.resolve(dir, layer, file).toLowerCase() === resolved.toLowerCase();
    /*
     * THE WHOLE TYPE GOES, not one file out of it. A row is a file type and its
     * chain, so deleting the row deletes the type — every step in it, which is
     * exactly the set `planSweep` is about to remove from the disk. A chain with
     * a hole in it would be a history that lies.
     */
    const relative = path.relative(dir, resolved).split(path.sep).join('/');
    manifest.documents = manifest.documents.filter(
      (record) => !record.steps.some((step) => step.file === relative));
    manifest.working.files = manifest.working.files.filter((row) => !inLayer(WORKING)(row.file));
    manifest.final = manifest.final.filter((row) => !inLayer(FINAL)(row.file));
    await writeManifest(dir, manifest);
  });

  /*
   * The catalogue first, the bytes second. A manifest that still lists a file
   * this is about to remove is a recoverable inconsistency — the row shows as
   * "not there any more" and can be cleared; bytes with no row are a folder
   * nothing can account for.
   *
   * `force: true` throughout, so a file somebody moved behind the app's back and
   * a directory that is already half gone both finish quietly rather than
   * failing a delete the user has already confirmed.
   */
  await fsp.rm(resolved, { force: true });
  for (const target of sweep.files) await fsp.rm(target, { force: true });

  /*
   * An `archived-<stamp>/` folder that held nothing but this document's past
   * goes with it. Emptiness is the test rather than "we made it empty", because a
   * folder made before `stampedArchive` began naming them after the run was
   * shared by everything rotated in the same second — and one that still has a
   * sibling's work in it is somebody else's record, which this has no business
   * removing.
   */
  for (const archive of sweep.archives) {
    try {
      const left = await fsp.readdir(archive);
      if (left.length === 0) await fsp.rmdir(archive);
    } catch { /* already gone, or not readable — either way not ours to force */ }
  }

  /*
   * Said once the bytes are gone, like every other change to the library. The
   * window that pressed Delete re-reads on its own; a delete a HOST makes
   * (BookForge removing an export it lists as a version) reaches no renderer
   * any other way, and without this the nav went on drawing a row whose file
   * had just been removed — a click on it errored (2026-09-28).
   */
  announceProjects();
  return { title, label, wasMissing, assets: countSweep(sweep) };
}

/** The paths one document's delete takes with it, resolved and ready to remove. */
export interface Sweep {
  /** Archived copies of this same output. */
  files: string[];
  /** `archived-<stamp>/` folders to remove IF this emptied them. */
  archives: string[];
  /**
   * The count the card quotes, tallied AS THE PATHS ARE FOUND rather than
   * re-derived from them afterwards. Reading "is this a version?" back out of a
   * string is a guess about a filename; counting at the moment the thing is
   * identified is a fact, and the card is quoting this number to somebody about
   * to destroy it.
   */
  archivedVersions: number;
}

export function emptySweep(): Sweep {
  return { files: [], archives: [], archivedVersions: 0 };
}

export function countSweep(sweep: Sweep): DocumentAssets {
  return { archivedVersions: sweep.archivedVersions };
}

/**
 * Everything that belongs to this document alone, found rather than assumed.
 *
 * Nothing here deletes; it only looks. `documentAssets` uses it to tell the user
 * what a delete would take, and `deleteDocument` uses the same answer to take
 * it — so the card and the act cannot describe different things.
 */
export async function planSweep(
  dir: string,
  resolved: string,
  manifest: ProjectManifest,
): Promise<Sweep> {
  const sweep = emptySweep();

  /*
   * THE PREDECESSORS, in the file's own directory. `generated/archived-<stamp>/`
   * for an output and `working/archived-<stamp>/` for a live copy are the same
   * convention in two places, so this looks beside the file rather than in a
   * named folder — whichever layer the document lives in, its past is rotated
   * into a sibling of it.
   */
  const label = path.basename(resolved);
  for (const archive of await archivesIn(path.dirname(resolved))) {
    let touched = false;
    const past = path.join(archive, label);
    if (await exists(past)) {
      sweep.files.push(past);
      sweep.archivedVersions += 1;
      touched = true;
    }
    if (touched) sweep.archives.push(archive);
  }
  return sweep;
}

/** The `archived-<stamp>/` directories directly inside `parent`. */
export async function archivesIn(parent: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('archived-'))
    .map((entry) => path.join(parent, entry.name));
}

/**
 * What a delete of this document would take with it, for the card that asks.
 *
 * Reads the manifest directly rather than through the edit chain: this is a
 * question, it writes nothing, and a describe that queued behind a conversion
 * recording its output would leave the confirmation waiting on a job.
 */
export async function documentAssets(filePath: string): Promise<DocumentAssets> {
  const { dir, resolved } = deletableDocumentPath(filePath);
  try {
    return countSweep(await planSweep(dir, resolved, await readManifest(dir)));
  } catch {
    // A catalogue that will not parse still deletes; it just cannot promise
    // what else is in there. Saying "nothing extra" is the honest answer to a
    // question this project cannot be asked.
    return { archivedVersions: 0 };
  }
}

/** Every byte under `dir`, counted by walking it. Missing is zero, never a throw. */
export async function measure(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let bytes = 0;
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      bytes += await measure(here);
    } else if (entry.isFile()) {
      // A file that vanished between the readdir and the stat is a file whose
      // size is no longer part of the answer, not a reason to fail a dialog.
      try {
        bytes += (await fsp.stat(here)).size;
      } catch { /* it went away */ }
    }
  }
  return bytes;
}

/**
 * Pages in every readings bank under `dir`, by counting the lines in them.
 *
 * A bank is one JSON object per line, one line per page (src/vlm/readings.ts), so
 * the newline count IS the page count. Counted by STREAMING and looking for
 * `\n` bytes rather than by parsing: a bank for a long book is megabytes, this
 * runs to put a number in a dialog, and nothing here cares what the answers say.
 *
 * Recursive, because `archived-<stamp>/` banks are hours of GPU too — a person
 * who re-cast a book twice has paid for those pages twice and is about to lose
 * both.
 */
export async function countBankPages(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // No bank: this book has never been read by the model.
  }
  let pages = 0;
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pages += await countBankPages(here);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      pages += await countLines(here);
    }
  }
  return pages;
}

export function countLines(file: string): Promise<number> {
  return new Promise<number>((resolve) => {
    let lines = 0;
    const stream = createReadStream(file);
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const byte of bytes) if (byte === 0x0a) lines += 1;
    });
    // An unreadable bank is reported as no pages rather than as a failure. The
    // number is there to inform a question, and a dialog that will not open
    // because a count failed is a delete button that does nothing.
    stream.on('error', () => resolve(lines));
    stream.on('end', () => resolve(lines));
  });
}
