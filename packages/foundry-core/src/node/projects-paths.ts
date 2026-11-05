/**
 * projects-paths — where a project lives and what its folders and names are.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { readAppSettings } from './app-settings';
import { ANALYSIS_LAYER } from '../shared/ledger';

/** Refusals from this module, named so a caller can tell them from an fs error. */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** The manifest schema this app writes and the only one it reads. */
/**
 * 2 — `generated` became `documents`, a list of file types with step chains.
 *
 * A v1 reader handed a v2 file would find no `generated` array and conclude
 * nothing had ever been made from the book, which is why this moved. `readDocuments`
 * migrates v1 in memory on every read, so an old project opens without ceremony
 * and reaches disk in the new shape the next time anything edits it.
 */
export const MANIFEST_VERSION = 2;

export const MANIFEST = 'project.json';

/** The four layers, spelled once. */
export const ARCHIVE = 'archive';

export const GENERATED = 'generated';

export const WORKING = 'working';

export const FINAL = 'final';

/**
 * The fifth: frozen curations — the snapshots old `curate` steps retain.
 *
 * NOTHING WRITES ONE AND THE FOLDER IS NEVER SWEPT. A curation is a person's
 * judgement about four hundred blocks, it is `irreplaceable` by the retention
 * rule, and `shared/curate-bridge.ts` is the reader that turns one into ops when
 * the book is opened. See `curationsDir`.
 *
 * TWO SIBLINGS WENT WITH THE OVERLAY SYSTEM (docs/RENDERER.md §7): `overlays/`,
 * the live curation and its undo ledger, and `history/`, the block editor's
 * per-working-copy undo. Neither is read or written any more; a project that has
 * them keeps them, because deleting somebody's records to tidy a folder is not a
 * thing this app does.
 */
export const CURATIONS = 'curations';

/**
 * The sixth: the metadata patches, one per Apply. See `metadataDir`.
 */
export const METADATA = 'metadata';

/**
 * The seventh: the book's ops, one file per Apply. See `opsDir`.
 */
export const OPS = 'ops';

/**
 * The eighth: the analysis reports, one file per analysis step. See `analysisDir`.
 *
 * A RETAINED PAYLOAD on `ops/`' terms and not `generated/`'s, which is the one
 * thing about this folder that matters: a report is named by a step, deleted only
 * when that step is, and never swept — the sweep of `working/` assumes its
 * contents are disposable, and an hour of verify calls is not. It is `expensive`
 * rather than `irreplaceable` (`RETENTION_OF`, shared/ledger.ts), which is a fact
 * about the PRICE of remaking one and not a licence to remove it unasked.
 *
 * `<stepId>.jsonl` — the whole uuid, where `ops/` uses its front. The scheme and
 * the argument for the difference are at `analysisPayloadFor` (shared/ledger.ts),
 * which is the one place either is spelled.
 */
export const ANALYSIS = ANALYSIS_LAYER;

/**
 * And the bank of the model's answers — hours of GPU, the thing every rendering
 * is made from, and the product of the one job in this app that costs anything.
 */
export const READINGS = 'readings';

/**
 * WHERE A MATERIALISED BOOK LIVES — the book at a step with every op replayed
 * into it, written for an engine to compile.
 *
 * It used to be `os.tmpdir()/foundry`, on the contract that it is scratch and
 * the job that asked for it sweeps it at settle. That is true standalone and
 * FALSE HOSTED: the row goes to the host's queue, this app's `jobs` array never
 * holds it, so `sweepDerivedBook` cannot fire — and the file sat in a directory
 * macOS empties on reboot. Owen met the result on the Mac as `no such book
 * file`, pointing at a uuid under /var/folders.
 *
 * Under the project instead, beside `readings/`, because that is what it is: a
 * derivative of this project's own records, meaningful only here, and worth
 * being able to find when a compile disagrees with what somebody expected.
 */
export const DERIVED = 'derived';

/**
 * `<libraryDir>/projects` — under the user's library, not under userData.
 *
 * A finished book is the user's property. userData is where an app keeps its own
 * bookkeeping and is not a folder anybody backs up on purpose; the library is
 * `~/Documents/Foundry` by default and is exactly the kind of folder a person
 * syncs. The readings bank moved in here WITH the book for the same reason it
 * once stayed out: it is only bookkeeping in the abstract — in practice it is
 * hours of GPU that belong to the book it was read from.
 *
 * Read on EVERY call rather than cached: the setting is editable while the app
 * is running, and a cached answer would keep writing into the folder the user
 * just moved away from.
 */
export function projectsDir(): string {
  return path.join(readAppSettings().libraryDir, 'projects');
}

/**
 * The project directory a path lives in, or null when it lives outside them all.
 *
 * ONE segment deep, deliberately: `…/projects/<key>/generated/book.epub` and
 * `…/projects/<key>/working/<tree>/EPUB/c0003.xhtml` both answer `<key>`,
 * because everything under a project belongs to it however deep it sits.
 */
export function projectDirOf(filePath: string): string | null {
  const root = projectsDir();
  const inside = path.relative(root, path.resolve(filePath));
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const first = inside.split(path.sep)[0];
  if (first === undefined || first.length === 0) return null;
  return path.join(root, first);
}

/**
 * True while `filePath` lives inside a project — inside anything this app owns.
 *
 * The one test both main (the recents flag, the unsaved dot, whether Save may
 * write straight through) and the epub reader apply, so it lives beside the
 * directory it measures against. It answers TRUE for `archive/` and `generated/`
 * too, and that is the point: those layers are never written, so Save must go
 * through the dialog rather than silently rewriting one of them.
 */
export function isManaged(filePath: string): boolean {
  return projectDirOf(filePath) !== null;
}

/**
 * True while `filePath` is the UNTOUCHED ORIGINAL — the copy in a project's
 * `archive/`, which nothing in this app may write.
 *
 * ── Why this became a question worth asking out loud ────────────────────────
 *
 * `archive/` has always been write-only-once by convention: it is copied at import
 * and then never named by anything that writes. The convention held because
 * nothing ever put that path in front of a writer — every surface was handed the
 * live copy. `documentAtPosition` changed that: standing on the origin row now
 * shows the archived scan, so the metadata dialog's `tab.path` can BE the untouched
 * original, and `isManaged` says true of it (deliberately — see above), so the one
 * guard that stood between a write and a project layer would have let it through.
 *
 * The invariant is worth more than the convenience: `archive/` is the only copy of
 * that scan this program knows of, and the revert row's whole meaning is that it
 * is the file as it came in.
 */
export function isArchived(filePath: string): boolean {
  const dir = projectDirOf(filePath);
  if (dir === null) return false;
  // The whole first segment, compared as a segment — never a `startsWith` on the
  // string, which would claim `archived-2026/` and any other folder that happens
  // to begin with the word.
  return path.relative(dir, path.resolve(filePath)).split(path.sep)[0] === ARCHIVE;
}

/**
 * THE PROJECT WHOSE FINAL TRAY HOLDS THIS FILE — `<project>/final/<name>` — or
 * null for everything else.
 *
 * ── One rule, because three doors were spelling it out for themselves ───────
 *
 * An export is the one document in this app that was never OPENED: it is a file
 * this program wrote into a project's tray, and the renderer names it off a row
 * in the history rather than off the allow-list, so `admitted` — which answers
 * for things that came in through `openDocument` — says no to every one of them.
 * Membership in a tray is the claim those doors are actually exercising, and it
 * was written out longhand at each of them (`export:save-copy`, `viewExportedBook`,
 * and now the EPUB metadata pair). Three copies of an authorization test is three
 * chances for one of them to learn a rule the others do not.
 *
 * TWO SEGMENTS EXACTLY, and the depth is the gate rather than a tidiness. A
 * `startsWith('final')` would claim `final-drafts/`, and an unbounded depth would
 * claim anything a future tray subfolder came to hold — including, if one is ever
 * nested there, a path composed from a name this app did not choose.
 *
 * IT ANSWERS THE PROJECT AND NOT A BOOLEAN, because every caller needs the
 * directory next: to read the manifest, to file a step, to say which book this is.
 * A predicate would make each of them ask `projectDirOf` a second time and get a
 * second answer to a question already settled here.
 */
export function exportInTray(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const dir = projectDirOf(resolved);
  if (dir === null) return null;
  const inside = path.relative(dir, resolved).split(path.sep);
  return inside.length === 2 && inside[0] === FINAL ? dir : null;
}

/**
 * A DIRECTORY name a filesystem, a URL and a person can all live with.
 *
 * The real test document is `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf`
 * — spaces, a comma, parentheses and two dots. Everything outside
 * `[A-Za-z0-9._-]` becomes a hyphen, runs collapse, and the result is capped at
 * 64 characters because Windows' 260-character path limit is measured against a
 * project path that already carries `working/<tree>/EPUB/<chapter>.xhtml`.
 *
 * FOR THE DIRECTORY ONLY. The files inside a project keep the document's real
 * name (`manifest.stem`) — a person opening the folder should find their book,
 * not a slug.
 */
export function slugify(name: string): string {
  const slug = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const capped = slug.slice(0, 64);
  // A name made entirely of punctuation would slug to nothing, and a folder
  // called `-a1b2c3d4` is a folder nobody can identify. The hash still follows.
  return capped.length > 0 ? capped : 'document';
}

/**
 * The document's own name, without its extension, fit to be a filename again.
 *
 * This is what every file in the project is called, so it is the one string that
 * reaches a person. Only the characters Windows refuses outright are removed —
 * a colon is common in a book's name and would fail on write — and everything
 * else, including the spaces, commas and parentheses that make a real title
 * readable, is kept exactly as the user's own file spelled it.
 */
export function stemOf(fileName: string): string {
  return sanitiseStem(fileName.replace(/\.[^.]*$/, ''));
}

/**
 * The same cleaning, for a string that is ALREADY extensionless.
 *
 * Split out because `stemOf` would maul one. A slug carries dots — `slugify`
 * keeps them — so `Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993` run through
 * an extension stripper comes out as `…-Kershaw-Ian`, which is a book named
 * after two thirds of itself. Adoption takes this route; an imported file takes
 * the other.
 *
 * Capped at 80 because the name reaches a path: `<library>/projects/<key up to
 * 73>/generated/<stem> (pt-BR).epub` has to stay inside Windows' 260.
 */
export function sanitiseStem(text: string): string {
  const stem = text
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    // A trailing dot or space is legal in the string and illegal in a Windows
    // filename, and the failure arrives from the OS rather than from us.
    .replace(/[. ]+$/, '');
  return stem.length > 0 ? stem : 'document';
}

/**
 * The first 8 hex characters of the file's sha256.
 *
 * STREAMED, so a 400 MB scan costs one sequential pass and no resident memory.
 * Eight characters is 4 bytes of collision space — plenty against the tens of
 * books one person converts, and short enough that the folder still reads as the
 * book's name with a suffix rather than as a hash.
 */
export function contentKey(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err: Error) => reject(
      new Error(`${filePath} could not be read to key its project: ${err.message}`),
    ));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 8)));
  });
}
