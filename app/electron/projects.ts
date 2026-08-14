/**
 * projects — one folder per book, in four layers.
 *
 * A conversion used to write `<libraryDir>/workspace/<slug>-<key>.epub`, the
 * readings bank lived a continent away in `<userData>/readings/<key>.jsonl`, and
 * nothing on disk tied a translation to the book it came from. You could not ask
 * "what has been made from this PDF?" because the answer was spread across two
 * directories and encoded only in a filename prefix.
 *
 * A PROJECT is the answer, and it is one directory:
 *
 *   <libraryDir>/projects/<slug>-<contentkey>/
 *     project.json            the catalogue — see ProjectManifest
 *     archive/                the imported originals. NEVER written.
 *     generated/              the model's cast EPUB, or the imported EPUB, or
 *                             the book reprinted as a real-text PDF. NEVER
 *                             written.
 *     working/                what the user edits: the unpacked EPUB tree, and
 *                             the live PDF.
 *     final/                  what Save and Export produce, named for the book.
 *     readings/<key>.jsonl    the bank of the model's per-page answers
 *     history/<tree>.json     the undo ledger of the working copy of that name,
 *                             bound to the generation that made it
 *
 * ── The rule the layout exists for ───────────────────────────────────────────
 *
 * EVERY DOCUMENT HAS TWO LAYERS: an origin that is never written, and a live
 * copy that is what the user means by "the PDF" or "the EPUB". Saving writes the
 * live copy. The origin is what makes stepping back, or starting over, possible
 * at all — and for a scanned book the imported file may be the only copy of that
 * scan that will ever exist.
 *
 * `generated/` is the second origin and it is sacrosanct on its own argument: it
 * is the single record of what the model ACTUALLY READ, every curation decision
 * downstream is measured against it, and "start over" means throwing the working
 * tree away and unpacking it again from there.
 *
 * ── And the user never sees any of this ──────────────────────────────────────
 *
 * ONE DOCUMENT PER KIND. `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf`
 * and the matching `.epub`, as one unit. No `.generated`, no `.archive`, no
 * suffixes, no layer names anywhere a person can read them: every file in a
 * project is named from `manifest.stem`, which is the imported document's own
 * name with its extension taken off. The SLUG is for the directory and nothing
 * else, and `final/` is named for the book like everything else.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * `<slug>-<8 hex of the import's sha256>`, unchanged from the flat workspace it
 * replaces, and the reason it is unchanged is worth the paragraph:
 *
 *   - the hash is of the document's CONTENT, not of its path, so the same book
 *     lands in the same project no matter where the user dragged it from — a
 *     second run REPLACES the first rather than accumulating `book (1).epub`;
 *   - the READINGS bank keeps that key, so an interrupted run of a book that has
 *     since been moved or renamed still resumes. That bank is GPU-hours; a key
 *     a rename could break would silently cost them;
 *   - and the flat files this migrates FROM already carry it, which is what
 *     makes adoption a regrouping rather than a re-hash of everything on disk.
 *
 * ── Nothing is deleted ───────────────────────────────────────────────────────
 *
 * Re-running a conversion does not clobber the origin it replaces — it rotates
 * it into `generated/archived-<timestamp>/`, the way the engine's
 * `archiveReadingsBank` (src/vlm/readings.ts) rotates a bank, and the working
 * tree unpacked from it goes into the same folder so the next open unpacks the
 * NEW book rather than reopening the old one's edits.
 *
 * ── Except when the user says so ─────────────────────────────────────────────
 *
 * `deleteProject` is the single exception and the rule survives it intact, because
 * the rule was never "these bytes are sacred" — it is that THIS APP does not get
 * to decide a person's work is finished with. Every rotation above is Foundry
 * choosing, on its own, what to do with something it was not asked about; a
 * delete from Home is the user choosing, about their own folder, having been told
 * in words what is in it. Archiving instead would leave a directory they would
 * then have to go and delete by hand, which is not a kindness, it is a lie about
 * what the button did.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsconst, createReadStream, promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { readAppSettings } from './app-settings';
// An imported EPUB is stamped on the way in, by the engine — see `stampImported`.
import { stampEpub } from './engine';
import { openedAtFor } from './recents';
import type {
  ConversionKind,
  ProjectDocument,
  ProjectDocumentKind,
  ProjectGenerated,
  ProjectGeneratedRole,
  ProjectManifest,
  ProjectSummary,
  ProjectStep,
  ProjectTypeRecord,
  ProjectWorkingFile,
  ProjectWorkingTree,
} from '../shared/types';
import { WHY_HANDMADE, WHY_IMPORTED, WHY_MODEL_PASS } from '../shared/types';
import { STEP_LABELS, migrateToSteps, readTypeRecords } from '../shared/steps';
import { GENERATED_ROLE_FOR } from '../shared/documents';

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
const MANIFEST_VERSION = 2;

const MANIFEST = 'project.json';

/** The four layers, spelled once. */
const ARCHIVE = 'archive';
const GENERATED = 'generated';
const WORKING = 'working';
const FINAL = 'final';
/** The fifth folder: the undo ledgers, one per document. See `historyDir`. */
const HISTORY = 'history';

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
function sanitiseStem(text: string): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read `project.json`, or say by name why it could not be read.
 *
 * NEVER falls back to an empty manifest. A project whose catalogue does not
 * parse has a member order this app cannot know, and packing a book from a
 * guessed order is how `mimetype` ends up in the middle of an archive that some
 * readers open and others silently reject (ARCHITECTURE §8).
 */
export async function readManifest(dir: string): Promise<ProjectManifest> {
  const file = path.join(dir, MANIFEST);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new ProjectError(`${file} could not be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProjectError(`${file} is not JSON (${(err as Error).message}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectError(`${file} is not an object, so it is not a project catalogue.`);
  }
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== MANIFEST_VERSION) {
    throw new ProjectError(
      `${file} is version ${String(row['version'])} and this app writes version ${MANIFEST_VERSION}. `
      + 'Refusing to read a catalogue whose shape it does not know.',
    );
  }
  const key = row['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new ProjectError(`${file} names no key, so nothing says which book this folder is.`);
  }
  const working = typeof row['working'] === 'object' && row['working'] !== null
    ? row['working'] as Record<string, unknown>
    : {};
  return {
    version: MANIFEST_VERSION,
    key,
    title: typeof row['title'] === 'string' && row['title'].length > 0 ? row['title'] : key,
    stem: typeof row['stem'] === 'string' && row['stem'].length > 0 ? row['stem'] : key,
    createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : 0,
    archive: readArchive(row['archive']),
    documents: readDocuments(row, readArchive(row['archive'])),
    working: {
      trees: readTrees(working['trees']),
      files: readWorkingFiles(working['files']),
    },
    final: readFinal(row['final']),
  };
}

/**
 * The type records — read from a v2 catalogue, or built from a v1 one.
 *
 * MIGRATION HAPPENS ON EVERY READ AND IS NOT WRITTEN BACK BY ITSELF. A v1 file
 * is turned into type records in memory here; the new shape reaches disk the
 * next time anything edits the project through `withManifest`, which writes the
 * whole file. That ordering is deliberate: reading somebody's library must not
 * rewrite it, and a migration that only runs on write cannot half-finish across
 * a crash — either the old file is still there and is migrated again on the next
 * read, or the new one is complete.
 */
function readDocuments(
  row: Record<string, unknown>,
  archive: ProjectManifest['archive'],
): ProjectTypeRecord[] {
  if (Array.isArray(row['documents'])) return readTypeRecords(row['documents']);
  return migrateToSteps(readGenerated(row['generated']), archive, {
    archive: ARCHIVE,
    generated: GENERATED,
  });
}

function readArchive(value: unknown): ProjectManifest['archive'] {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const file = row['file'];
  const kind = row['kind'];
  if (typeof file !== 'string' || (kind !== 'pdf' && kind !== 'epub')) return null;
  return {
    file,
    kind,
    contentKey: typeof row['contentKey'] === 'string' ? row['contentKey'] : '',
    originPath: typeof row['originPath'] === 'string' ? row['originPath'] : null,
  };
}

function readGenerated(value: unknown): ProjectGenerated[] {
  if (!Array.isArray(value)) return [];
  const rows: ProjectGenerated[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const kind = row['kind'];
    const role = row['role'];
    if (typeof file !== 'string') continue;
    if (kind !== 'epub' && kind !== 'pdf' && kind !== 'txt') continue;
    if (!isGeneratedRole(role)) continue;
    rows.push({ file, kind, role, madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0 });
  }
  return rows;
}

function isGeneratedRole(value: unknown): value is ProjectGeneratedRole {
  return value === 'cast' || value === 'imported' || value === 'translation'
    || value === 'searchable' || value === 'text';
}

function readTrees(value: unknown): ProjectWorkingTree[] {
  if (!Array.isArray(value)) return [];
  const trees: ProjectWorkingTree[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const from = row['from'];
    const dir = row['dir'];
    const members = row['members'];
    if (typeof from !== 'string' || typeof dir !== 'string' || !Array.isArray(members)) continue;
    if (!members.every((name): name is string => typeof name === 'string')) continue;
    trees.push({
      from,
      dir,
      members,
      unpackedAt: typeof row['unpackedAt'] === 'number' ? row['unpackedAt'] : 0,
      // Empty for a tree recorded before generations existed. NOT minted here:
      // a read that writes is a read that can fail, and `treeGeneration` does it
      // once, deliberately, at the moment something needs the value.
      generation: typeof row['generation'] === 'string' ? row['generation'] : '',
    });
  }
  return trees;
}

function readWorkingFiles(value: unknown): ProjectManifest['working']['files'] {
  if (!Array.isArray(value)) return [];
  const files: ProjectManifest['working']['files'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const from = row['from'];
    if (typeof file !== 'string' || typeof from !== 'string' || row['kind'] !== 'pdf') continue;
    files.push({ file, kind: 'pdf', from, madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0 });
  }
  return files;
}

function readFinal(value: unknown): ProjectManifest['final'] {
  if (!Array.isArray(value)) return [];
  const files: ProjectManifest['final'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const kind = row['kind'];
    if (typeof file !== 'string') continue;
    if (kind !== 'epub' && kind !== 'pdf' && kind !== 'txt') continue;
    files.push({ file, kind, madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0 });
  }
  return files;
}

/** Write the catalogue. Whole-file, small, and the only writer of this shape. */
async function writeManifest(dir: string, manifest: ProjectManifest): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Every read-modify-write of one project's catalogue, one at a time.
 *
 * `project.json` is rewritten whole, so two edits in flight for the same project
 * — a conversion recording its output while a book records the tree it just
 * unpacked — would have the second overwrite the first's field with the value it
 * read before the first landed. A promise chain per directory is the smallest
 * thing that makes that impossible, and projects are edited perhaps twice a
 * minute, so serialising them costs nothing measurable.
 */
const edits = new Map<string, Promise<unknown>>();

function withManifest<T>(dir: string, work: (manifest: ProjectManifest) => Promise<T>): Promise<T> {
  const key = path.resolve(dir).toLowerCase();
  const previous = edits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed edit must not poison the ones queued behind it */ })
    .then(async () => work(await readManifest(dir)));
  edits.set(key, next);
  return next;
}

/**
 * Make the project if it is not there, then run one edit against its catalogue.
 *
 * The create and the edit are in ONE serialised step because two documents
 * adopted at the same instant — main's background adoption of a dropped file and
 * the `epub:open` that follows it — would otherwise both find no `project.json`
 * and both write a fresh one, and the second would erase whatever the first had
 * just recorded.
 */
function withCreatedProject<T>(
  dir: string,
  key: string,
  stem: string,
  work: (manifest: ProjectManifest) => Promise<T>,
): Promise<T> {
  const mapKey = path.resolve(dir).toLowerCase();
  const previous = edits.get(mapKey) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* see withManifest */ })
    .then(async () => {
      let manifest: ProjectManifest;
      try {
        manifest = await readManifest(dir);
      } catch (err) {
        // Absent is the ordinary case — this is where a project is born. A
        // catalogue that EXISTS and will not parse is not: overwriting it would
        // throw away a member order that a book on disk still depends on.
        if (await exists(path.join(dir, MANIFEST))) throw err;
        manifest = {
          version: MANIFEST_VERSION,
          key,
          // The display title starts as the document's own name. It becomes the
          // book's `dc:title` the first time anything reads one — see
          // `noteProjectTitle` — and the stem never changes after this, because
          // renaming files under somebody is not a thing a catalogue does.
          title: stem,
          stem,
          createdAt: Date.now(),
          archive: null,
          documents: [],
          working: { trees: [], files: [] },
          final: [],
        };
        await writeManifest(dir, manifest);
      }
      return work(manifest);
    });
  edits.set(mapKey, next);
  return next;
}

/**
 * Copy, and refuse rather than overwrite.
 *
 * `COPYFILE_EXCL` makes "is it already there?" and "put it there" one operation
 * the filesystem decides, which is what keeps adoption idempotent under two app
 * instances started together. An existing destination is not an error here: it
 * means this document was adopted already, which is the answer we wanted.
 */
async function copyNewOnly(from: string, to: string): Promise<boolean> {
  try {
    await fsp.copyFile(from, to, fsconst.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Importing a document
// ─────────────────────────────────────────────────────────────────────────────

/** The extension a conversion's origin carries. See `ProjectGeneratedRole`. */
const GENERATED_EXTENSIONS: Readonly<Record<ConversionKind, string>> = {
  epub: '.epub',
  pdf: '.pdf',
  txt: '.txt',
};

/**
 * Moved to `shared/documents.ts` and re-exported under its old name here.
 *
 * The OCR dialog needs this table to know whether the source somebody picked is
 * the file their own run would write over, and a second copy in the renderer
 * would be a second opinion about what a conversion produces.
 */
const GENERATED_ROLES = GENERATED_ROLE_FOR;

/** `Working Towards The Fuhrer. Kershaw, Ian. (1993).epub` — the book's own name. */
export function generatedFileFor(stem: string, kind: ConversionKind): string {
  return `${stem}${GENERATED_EXTENSIONS[kind]}`;
}

export function generatedRoleFor(kind: ConversionKind): ProjectGeneratedRole {
  return GENERATED_ROLES[kind];
}

/**
 * A translation's name: the book's, with the language in parentheses.
 *
 * `Working Towards The Fuhrer. Kershaw, Ian. (1993) (en).epub`. Parentheses and
 * not a `.en.` infix, because an infix reads as a technical suffix on a filename
 * and the whole point of naming these from the book is that a person opening the
 * folder recognises what they are looking at.
 */
export function translationFileFor(stem: string, languageTag: string): string {
  // The tag reaches a filename, so it is reduced to the same character set
  // everything else here is. `pt-BR` survives that unchanged; the engine has
  // already refused anything that is not a language tag.
  const tag = languageTag.trim().replace(/[^A-Za-z0-9-]+/g, '') || 'translated';
  return `${stem} (${tag}).epub`;
}

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
async function stampImported(file: string): Promise<string | null> {
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

  return withCreatedProject(dir, key, stemOf(name), async (manifest) => {
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
    await writeManifest(dir, manifest);
    return { dir, entry: `${live}/${liveFile}`, key, stem: manifest.stem, notice };
  });
}

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
function recordStep(
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
function stepsOf(manifest: ProjectManifest, kind: ProjectDocumentKind): ProjectStep[] {
  return manifest.documents.find((row) => row.kind === kind)?.steps ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// The generated layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Working trees an open book is reading and writing right now.
 *
 * A rotation MOVES a working tree (see `rotateGenerated`), and moving the
 * directory an open tab is serving its chapters from would leave that tab
 * reading paths that no longer exist — every image a 404, every save a failure,
 * and nothing on screen saying why. So a re-run of a conversion whose previous
 * book is open is refused by name instead. Held by the epub reader from open to
 * close.
 *
 * COUNTED, not a set. One tree can be open twice — the same book reached both as
 * the file the user dropped and as the copy Home lists in its project — and a
 * set would let the first tab to close unlock a tree the second is still
 * reading. The count only ever goes to zero when the last reader has gone.
 */
const heldTrees = new Map<string, number>();

export function holdWorkingTree(root: string): void {
  const key = path.resolve(root).toLowerCase();
  heldTrees.set(key, (heldTrees.get(key) ?? 0) + 1);
}

export function releaseWorkingTree(root: string): void {
  const key = path.resolve(root).toLowerCase();
  const held = (heldTrees.get(key) ?? 0) - 1;
  if (held > 0) heldTrees.set(key, held);
  else heldTrees.delete(key);
}

function workingTreeHeld(root: string): boolean {
  return heldTrees.has(path.resolve(root).toLowerCase());
}

/** `archived-2026-08-14T00-31-02-114Z` — the engine's shape, colons removed. */
function stampedArchive(parent: string): string {
  return path.join(parent, `archived-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

/**
 * Move an origin — and the working tree unpacked from it — aside, if it is there.
 *
 * Called before a conversion writes, so a second run of the same book replaces
 * the first WITHOUT destroying it. `generated/` is never overwritten, ever: it
 * is the record of what the model read, and the previous read is still a record
 * of something.
 *
 * THE WORKING TREE GOES WITH IT, and that is not tidiness. The tree is keyed by
 * the origin it came from, so a new cast EPUB beside a tree unpacked from the
 * old one would open the OLD book's edits and never show the new conversion at
 * all — the failure would look like the run having done nothing.
 */
export async function rotateGenerated(dir: string, file: string): Promise<string | null> {
  const target = path.join(dir, GENERATED, file);
  if (!await exists(target)) return null;

  let movedTo: string | null = null;
  await withManifest(dir, async (manifest) => {
    const from = `${GENERATED}/${file}`;
    const tree = manifest.working.trees.find((entry) => entry.from === from) ?? null;
    const treeRoot = tree === null ? null : path.join(dir, WORKING, tree.dir);
    if (treeRoot !== null && workingTreeHeld(treeRoot)) {
      throw new ProjectError(
        `${file} is open in Foundry right now. Running this again would move the working copy `
        + 'you are reading out from under that tab — close the book first.',
      );
    }

    const archive = stampedArchive(path.join(dir, GENERATED));
    if (await exists(archive)) {
      // The engine's rule, for the engine's reason: two runs' outputs under one
      // folder name is two books' worth of work filed as one.
      throw new ProjectError(
        `${archive} already exists, so the previous ${file} cannot be moved aside without mixing `
        + "two runs' work into one folder. Move it away and run again.",
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    movedTo = path.join(archive, file);
    await fsp.rename(target, movedTo);
    if (tree !== null && treeRoot !== null && await exists(treeRoot)) {
      await fsp.rename(treeRoot, path.join(archive, `working-${tree.dir}`));
    }

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
    manifest.working.trees = manifest.working.trees.filter((entry) => entry.from !== from);
    await writeManifest(dir, manifest);
  });
  // Where it went, so a run whose own input is the copy being replaced can read
  // it there — see `planTranslation`.
  return movedTo;
}

/**
 * Put a finished origin in the catalogue, and refresh the live copy it feeds.
 *
 * Called when the JOB SUCCEEDS rather than when it is planned, because a plan is
 * an intention: a run that fails at page 200 would otherwise leave a row in the
 * catalogue for a file that does not exist, and Home would offer it.
 *
 * A PDF-PRODUCING CONVERSION REPLACES THE LIVE PDF. There is ONE PDF per
 * project — "the PDF", the working document — and applying a change to it
 * produces a new version of it rather than a second document beside it.
 *
 * ── This was got wrong once, and the reasoning is worth keeping ─────────────
 *
 * When the reprint stopped being the scan-with-a-layer and became type on blank
 * paper, this promotion was removed and the reprint was given a row of its own.
 * The fear was real: promoting it would file the user's SCAN into
 * `working/archived-<stamp>/` and hand them a text-only document under the name
 * of the photograph they imported. Nobody asked for their scan to be replaced.
 *
 * That was the right worry solved in the wrong place. The scan is protected by
 * `archive/` BEING IMMUTABLE — it is copied in once at import and no path in
 * this app is ever composed into it — not by making the user keep track of two
 * PDFs with the same filename. Solving it here cost exactly what a wrong
 * abstraction costs: two identical rows in the document list, two identical
 * options in the OCR picker, and a refusal that told somebody to go and convert
 * "the original instead" — an instruction about this app's filing, given to the
 * person the filing is supposed to be invisible to.
 *
 * So the promotion is back and the user sees one PDF. The one they see is the
 * working copy, it carries whatever has been applied to it, the previous version
 * is rotated aside rather than lost, and the original they imported is still on
 * disk untouched — reachable by exporting it or reverting to it, which are
 * deliberate gestures rather than a row in a list.
 *
 * A failure here is LOGGED and not thrown. This runs at the end of a run that
 * may have taken three hours, and losing a row in a catalogue is not a reason to
 * report the conversion itself as failed — but it is named, in full, so the line
 * says which file went unrecorded and why.
 */
export async function recordGenerated(
  outputPath: string,
  role: ProjectGeneratedRole,
): Promise<string | null> {
  const resolved = path.resolve(outputPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} finished outside any project, so nothing catalogued it.`);
    return null;
  }
  const inside = path.relative(dir, resolved).split(path.sep);
  const file = inside.length === 2 && inside[0] === GENERATED ? inside[1] : undefined;
  if (file === undefined) {
    console.error(`[projects] ${resolved} is not directly in a project's ${GENERATED}/, so nothing catalogued it.`);
    return null;
  }
  const kind = kindOf(file);
  if (kind === null) {
    console.error(`[projects] ${resolved} has an extension no project catalogue describes.`);
    return null;
  }
  try {
    return await withManifest(dir, async (manifest) => {
      /*
       * A STEP ON THAT TYPE'S CHAIN, and the cost is recorded with it.
       *
       * Every role that reaches here is the product of a model pass — a cast, a
       * reprint, a translation, a text emission all run the engine over the
       * book — so the file is frozen the moment it exists and later work happens
       * on a copy of it. The reason travels with the step so that the sweep, the
       * rotation and the delete warning can all ask one question of one place.
       */
      recordStep(manifest, kind, {
        file: `${GENERATED}/${file}`,
        label: STEP_LABELS[role],
        appliedAt: Date.now(),
        kind: role === 'translation' ? 'translate' : role === 'cast' ? 'origin' : 'convert',
        retention: 'expensive',
          why: WHY_MODEL_PASS,
      });
      // WRITTEN BEFORE the live copy is refreshed, and that ordering is the
      // whole reason these are two writes. Refreshing can refuse — an archive
      // folder from this same second already exists — and a refusal that took
      // the origin's own catalogue row down with it would leave the engine's
      // output on disk, uncatalogued, invisible to Home.
      await writeManifest(dir, manifest);
      if (role !== 'searchable') return null;
      const live = await refreshLivePdf(dir, manifest, file);
      await writeManifest(dir, manifest);
      return live;
    });
  } catch (err) {
    console.error(`[projects] ${path.join(dir, MANIFEST)} could not record ${file}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Install a `generated/` PDF as the project's live one.
 *
 * ONLY ONE CALLER IS LEFT AND IT IS THE LEGACY ONE. A conversion run today
 * produces a document of its own and never replaces the scan (`recordGenerated`
 * says why). What still needs this is `adoptLegacyLayout`: the PDFs it finds
 * were written when `--format pdf` laid an invisible layer over the pages it was
 * given, so each of them IS that project's scan, and a project adopted without
 * this would list a book and no scan at all.
 *
 * The old live copy is rotated into `working/archived-<stamp>/` rather than
 * overwritten, because it is the only thing that can answer "what did this look
 * like before?" — and because a metadata edit made against it (once those exist)
 * would otherwise vanish without a trace.
 */
async function refreshLivePdf(
  dir: string,
  manifest: ProjectManifest,
  generatedFile: string,
): Promise<string> {
  const liveFile = `${manifest.stem}.pdf`;
  const live = path.join(dir, WORKING, liveFile);
  await fsp.mkdir(path.join(dir, WORKING), { recursive: true });
  if (await exists(live)) {
    const archive = stampedArchive(path.join(dir, WORKING));
    if (await exists(archive)) {
      throw new ProjectError(
        `${archive} already exists, so the previous ${liveFile} cannot be moved aside. Move it away.`,
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    await fsp.rename(live, path.join(archive, liveFile));
  }
  await fsp.copyFile(path.join(dir, GENERATED, generatedFile), live);
  manifest.working.files = [
    ...manifest.working.files.filter((row) => row.file !== liveFile),
    { file: liveFile, kind: 'pdf', from: `${GENERATED}/${generatedFile}`, madeAt: Date.now() },
  ];
  return live;
}

/**
 * Note that the user filed a copy into the project's own `final/`.
 *
 * Only when it landed THERE. Save As to a USB stick or to somebody's Desktop is
 * the user's business and is already in recents; the catalogue records the
 * project's own filing tray so Home can say a book has been filed at all.
 * Silent about anything else, and never fatal — a save that happened must not
 * report a failure because a catalogue line did not.
 */
export async function recordFinal(destination: string): Promise<void> {
  const resolved = path.resolve(destination);
  const dir = projectDirOf(resolved);
  if (dir === null) return;
  const inside = path.relative(dir, resolved).split(path.sep);
  const file = inside.length === 2 && inside[0] === FINAL ? inside[1] : undefined;
  if (file === undefined) return;
  const kind = kindOf(file);
  if (kind === null) return;
  try {
    await withManifest(dir, async (manifest) => {
      manifest.final = [
        ...manifest.final.filter((entry) => entry.file !== file),
        { file, kind, madeAt: Date.now() },
      ];
      await writeManifest(dir, manifest);
    });
  } catch (err) {
    console.error(`[projects] ${path.join(dir, MANIFEST)} could not record ${file}: ${(err as Error).message}`);
  }
}

/** Where Save opens for a book in this project. Created so the dialog lands in it. */
export async function finalDir(dir: string): Promise<string> {
  const target = path.join(dir, FINAL);
  await fsp.mkdir(target, { recursive: true });
  return target;
}

function kindOf(file: string): ProjectDocumentKind | null {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.epub') return 'epub';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.txt') return 'txt';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Working trees
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The directory under `working/` that holds the tree unpacked from `entry`.
 *
 * A readable prefix plus six hex of the entry's own hash. The prefix alone would
 * not do: it is capped for Windows' path limit, and two translations of a book
 * with a long name would cap to the same string — one book served out of
 * another book's working copy, which is the worst outcome available because it
 * looks like it worked. The hash makes the name unique from the thing it names.
 *
 * Nobody ever reads this: it is an internal directory, and the documents the
 * user sees are named from `manifest.stem`.
 */
export function workingTreeName(entry: string): string {
  const readable = slugify(entry.replace(/\//g, '-')).slice(0, 32);
  return `${readable}-${createHash('sha256').update(entry).digest('hex').slice(0, 6)}`;
}

export interface WorkingTreeRecord {
  root: string;
  members: string[];
}

/** The recorded tree for this archive, or null when there is none yet. */
export async function workingTreeFor(dir: string, entry: string): Promise<WorkingTreeRecord | null> {
  const manifest = await readManifest(dir);
  const tree = manifest.working.trees.find((candidate) => candidate.from === entry);
  if (tree === undefined) return null;
  return { root: path.join(dir, WORKING, tree.dir), members: tree.members };
}

/**
 * Record a tree that is about to be written. See `openEpub` for the ordering.
 *
 * A FRESH GENERATION EVERY TIME, and this is the only place one is minted for a
 * tree that is being made. The call happens exactly when a working copy comes
 * into existence: the first unpack, and again after `rotateGenerated` has moved
 * the previous origin AND its tree aside, which is what a re-cast and what
 * "start over" both come down to. So the uuid changes precisely when the block
 * ids in the tree may have been reassigned, and a ledger recorded against the
 * old one stops being replayable at the same instant — which is the entire
 * point (see `ProjectWorkingTree.generation`).
 */
export async function recordWorkingTree(
  dir: string,
  entry: string,
  members: readonly string[],
): Promise<string> {
  const name = workingTreeName(entry);
  await withManifest(dir, async (manifest) => {
    manifest.working.trees = [
      ...manifest.working.trees.filter((tree) => tree.from !== entry),
      {
        from: entry,
        dir: name,
        members: [...members],
        unpackedAt: Date.now(),
        generation: randomUUID(),
      },
    ];
    await writeManifest(dir, manifest);
  });
  return path.join(dir, WORKING, name);
}

/**
 * The generation of the tree unpacked from `entry`, minting one if it has none.
 *
 * BACKFILLING IS SAFE, and it is the only reason this can write. A tree recorded
 * before this field existed has no history file that could name a generation —
 * there was nothing writing one — so the first id it is given cannot possibly
 * disagree with a ledger already on disk. From then on the ordinary rule holds:
 * the id changes only when `recordWorkingTree` makes a new working copy.
 *
 * Refuses by name for an entry no tree was recorded for. That is not a state a
 * caller reaches by accident — the book it is asking about is open, which means
 * `ensureWorkingTree` recorded one — so it means the catalogue lost the tree
 * somebody is editing, and guessing an id would file this session's undo history
 * against a working copy nothing describes.
 */
export async function treeGeneration(dir: string, entry: string): Promise<string> {
  return withManifest(dir, async (manifest) => {
    const tree = manifest.working.trees.find((candidate) => candidate.from === entry);
    if (tree === undefined) {
      throw new ProjectError(
        `${path.join(dir, MANIFEST)} lists no working copy unpacked from ${entry}, so there is `
        + 'nothing for an undo history to be bound to.',
      );
    }
    if (tree.generation.length > 0) return tree.generation;
    const minted = randomUUID();
    manifest.working.trees = manifest.working.trees.map(
      (candidate) => (candidate.from === entry ? { ...candidate, generation: minted } : candidate),
    );
    await writeManifest(dir, manifest);
    return minted;
  });
}

/**
 * `<project>/history/` — where the undo ledgers live, one file per document.
 *
 * A SIBLING OF THE FOUR LAYERS, on `readings/`'s precedent and for its reason: it
 * is neither an origin nor something the user asked for, but it belongs to THIS
 * BOOK and travels with it. Deliberately NOT inside `working/<tree>/`, which is
 * an unpacked EPUB — a stray file in there is a file that has to be explained to
 * every pass that walks the book — and not in userData, which nobody backs up
 * and which would sever a history from the book it describes the moment the
 * library folder moved.
 */
export function historyDir(dir: string): string {
  return path.join(dir, HISTORY);
}

/**
 * Promote any reprint that was left sitting in `generated/` as a row of its own.
 *
 * A MIGRATION FOR ONE EVENING'S PROJECTS, and it is written down because it will
 * look mysterious in a month. For a short while a PDF-producing conversion did
 * not replace the live PDF — it was catalogued as a second document — so a
 * project converted in that window has a `searchable` origin that was never
 * promoted, and the listing now skips those rows. Without this, that reprint
 * would simply vanish from the app: on disk, catalogued, and drawn nowhere.
 *
 * IDEMPOTENT, and that is the whole of its safety. It promotes only when the
 * live PDF is not already the one made FROM that origin — `refreshLivePdf`
 * records `from` on the working row, so a project that has been through this
 * (or that was converted after the fix) is left completely alone. Running it at
 * every launch therefore costs a manifest read per project and nothing else.
 *
 * A FAILURE IS A CONSOLE LINE, never a throw. This runs at startup across every
 * project in the library; one project with a rotation folder from this same
 * second, or a catalogue that will not parse, must not stop the app from opening
 * — and the consequence of skipping one is a reprint the user can still reach by
 * running the conversion again.
 */
export async function promoteStrandedReprints(): Promise<void> {
  let dirs: string[];
  try {
    dirs = (await fsp.readdir(projectsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsDir(), entry.name));
  } catch {
    return; // No library yet is the ordinary state of a fresh install.
  }

  for (const dir of dirs) {
    try {
      const manifest = await readManifest(dir);
      // The PDF chain's latest step, when it is something a conversion wrote.
      const steps = stepsOf(manifest, 'pdf');
      const latest = steps[steps.length - 1];
      if (latest === undefined || !latest.file.startsWith(`${GENERATED}/`)) continue;
      const reprint = { file: latest.file.slice(GENERATED.length + 1) };
      const live = manifest.working.files.find((row) => row.kind === 'pdf');
      if (live !== undefined && live.from === latest.file) continue;
      if (!await exists(path.join(dir, GENERATED, reprint.file))) continue;
      await withManifest(dir, async (current) => {
        await refreshLivePdf(dir, current, reprint.file);
        await writeManifest(dir, current);
      });
      console.log(`[projects] ${path.basename(dir)}: ${reprint.file} is now the project's PDF.`);
    } catch (err) {
      console.error(
        `[projects] ${path.basename(dir)} could not adopt its reprint as the live PDF `
        + `(${(err as Error).message}). Converting the book again will do it.`,
      );
    }
  }
}

/**
 * The name of the file in `archive/`, or null when this project has none.
 *
 * The one accessor for the source of record. `workspace.ts` turns it into a path
 * to hand the engine; nothing else needs it, and nothing at all writes there.
 */
export async function archiveFileOf(dir: string): Promise<string | null> {
  try {
    return (await readManifest(dir)).archive?.file ?? null;
  } catch {
    // A catalogue that will not parse cannot name its archive. The caller falls
    // back to the document it was given, which is what that project has.
    return null;
  }
}

/** Where a history that is not this working copy's goes. Nothing is deleted. */
export function historyArchiveDir(dir: string): string {
  return stampedArchive(historyDir(dir));
}

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
async function reconcileLivePdf(
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

async function summarise(dir: string, name: string): Promise<ProjectSummary> {
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
      filed: false,
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
  if (documents.length === 0 && manifest.archive !== null) {
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
    filed: manifest.final.length > 0,
    problem: null,
  };
}

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
 * asks main's own allow-list first (`admitted`, in main.ts) precisely because a
 * renderer's word is not an authorization. This function is the whole of that
 * gate for the one call that erases directories, so if it is wrong, an argument
 * of `C:\Users\tellt` is a recursive delete of a home folder.
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
 * NO EXCEPTIONS and no second caller. If something ever needs to erase a
 * directory that is not a project, it does not get to reach it through here.
 */
function deletableProjectDir(dir: string): string {
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
   * How many documents the catalogue lists — the scan, the book, translations.
   *
   * Counted the way `summarise` counts them, ONE PER DOCUMENT and not one per
   * file, because this number reaches a dialog and has to agree with the rows
   * the user just expanded on Home — so every generated origin counts, the
   * real-text PDF included, for the reason `listProjects` gives.
   */
  documents: number;
  /** True once anything has been filed into `final/`. That copy is in here too. */
  filed: boolean;
  /** Everything under the directory, in bytes. A scan is most of it. */
  bytes: number;
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
    documents: manifest === null
      ? 0
      // Counted the way `summarise` counts rows, which is per ARTEFACT: the
      // promoted reprint is the live PDF above and not a document beside it.
      // One per file type, the way `summarise` counts rows — never one per file.
      : manifest.documents.length,
    filed: (manifest?.final.length ?? 0) > 0,
    bytes: await measure(resolved),
  };
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
 */
export async function deleteProject(dir: string): Promise<void> {
  const resolved = deletableProjectDir(dir);
  const key = resolved.toLowerCase();
  const previous = edits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* see withManifest — a failed edit must not block this */ })
    .then(() => fsp.rm(resolved, { recursive: true, force: true }));
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
function deletableDocumentPath(filePath: string): { dir: string; resolved: string } {
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
 * copy of that name is a former life of it. A rotation also parks the working
 * tree beside the file as `working-<tree dir>`, so that goes with the same pass.
 *
 * THE WORKING TREE. `manifest.working.trees` keys a tree by the origin it was
 * unpacked FROM (`recordWorkingTree`), so a tree serves exactly one document and
 * `rotateGenerated` already treats the pair as inseparable — moving one without
 * the other is a bug it exists to prevent. Its row goes with the directory.
 *
 * THE UNDO LEDGER. `history/<working tree name>.json` (electron/history.ts),
 * keyed by the same `workingTreeName(entry)` the directory carries — derived
 * from the origin, not from a runtime id, which is what makes it stable across
 * sessions and per-document here. Its `archived-<stamp>/` copies go too: they
 * are ledgers of the same book, kept only so a Ctrl+Z that lost its footing
 * could be explained, and there is nothing left to explain once the book is
 * gone. History's own rule is that a ledger is never deleted, only rotated —
 * that rule is about a book that STILL EXISTS whose generation moved underneath
 * it, and it has nothing to say about a book the user has just erased.
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
 */
export interface DocumentAssets {
  /** Previous versions of this same file, rotated aside by earlier runs. */
  archivedVersions: number;
  /** True when an unpacked working copy serves this document. */
  workingTree: boolean;
  /** Undo ledgers for it — the live one and any that were rotated aside. */
  histories: number;
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
     * REFUSED WHILE THE TREE IS OPEN, the same refusal and for the same reason
     * `rotateGenerated` makes it: the renderer closes the tab before asking main
     * to delete, but a tab it failed to close is a directory this window still
     * has files open in, and on Windows the remove fails part way and leaves
     * half a working copy behind.
     */
    if (sweep.treeRoot !== null && workingTreeHeld(sweep.treeRoot)) {
      throw new ProjectError(
        `${label} is open in Foundry right now, so it cannot be deleted — its working copy is `
        + 'being read from this window. Close the book first, then delete it.',
      );
    }

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
    // The tree's row goes with the tree itself: a catalogue entry for a
    // directory that is not there is exactly the state `rotateGenerated` is
    // careful never to leave behind.
    if (sweep.treeEntry !== null) {
      manifest.working.trees = manifest.working.trees.filter(
        (row) => row.from !== sweep.treeEntry);
    }
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
  for (const target of sweep.dirs) await fsp.rm(target, { recursive: true, force: true });

  /*
   * An `archived-<stamp>/` folder that held nothing but this document's past
   * goes with it. Emptiness is the test rather than "we made it empty", because
   * one rotation folder can hold several documents archived in the same second
   * (`rotateGenerated` shares a stamp) — and one that still has a sibling's work
   * in it is somebody else's record, which this has no business removing.
   */
  for (const archive of sweep.archives) {
    try {
      const left = await fsp.readdir(archive);
      if (left.length === 0) await fsp.rmdir(archive);
    } catch { /* already gone, or not readable — either way not ours to force */ }
  }

  return { title, label, wasMissing, assets: countSweep(sweep) };
}

/** The paths one document's delete takes with it, resolved and ready to remove. */
interface Sweep {
  /** Archived copies of this same output, and its ledgers. */
  files: string[];
  /** The working tree, and archived working trees of this same output. */
  dirs: string[];
  /** `archived-<stamp>/` folders to remove IF this emptied them. */
  archives: string[];
  /** The live working tree's root, for the open-book refusal. Null when none. */
  treeRoot: string | null;
  /** The manifest key of that tree (`generated/x.epub`), so its row can go. */
  treeEntry: string | null;
  /**
   * The counts the card quotes, tallied AS THE PATHS ARE FOUND rather than
   * re-derived from them afterwards. Reading "is this a version or a ledger?"
   * back out of a string is a guess about a filename; counting at the moment the
   * thing is identified is a fact, and the card is quoting these numbers to
   * somebody about to destroy them.
   */
  archivedVersions: number;
  histories: number;
}

function emptySweep(): Sweep {
  return {
    files: [], dirs: [], archives: [], treeRoot: null, treeEntry: null,
    archivedVersions: 0, histories: 0,
  };
}

function countSweep(sweep: Sweep): DocumentAssets {
  return {
    archivedVersions: sweep.archivedVersions,
    workingTree: sweep.treeRoot !== null,
    histories: sweep.histories,
  };
}

/**
 * Everything that belongs to this document alone, found rather than assumed.
 *
 * Nothing here deletes; it only looks. `documentAssets` uses it to tell the user
 * what a delete would take, and `deleteDocument` uses the same answer to take
 * it — so the card and the act cannot describe different things.
 */
async function planSweep(
  dir: string,
  resolved: string,
  manifest: ProjectManifest,
): Promise<Sweep> {
  const sweep = emptySweep();

  // The manifest spells an origin with forward slashes, relative to the project.
  const entry = path.relative(dir, resolved).split(path.sep).join('/');
  const tree = manifest.working.trees.find((row) => row.from === entry) ?? null;
  const treeDir = tree?.dir ?? workingTreeName(entry);
  if (tree !== null) {
    sweep.treeEntry = entry;
    sweep.treeRoot = path.join(dir, WORKING, tree.dir);
    sweep.dirs.push(sweep.treeRoot);
  }

  /*
   * THE LEDGERS, live and archived. Named for the working tree even when no tree
   * is recorded any more: a history outlives the copy it was written against —
   * that is what `history/archived-<stamp>/` is for — and one left behind here
   * would be a file named after a book that no longer exists.
   */
  const history = historyDir(dir);
  const ledger = `${treeDir}.json`;
  if (await exists(path.join(history, ledger))) {
    sweep.files.push(path.join(history, ledger));
    sweep.histories += 1;
  }
  for (const archive of await archivesIn(history)) {
    const inside = path.join(archive, ledger);
    if (await exists(inside)) {
      sweep.files.push(inside);
      sweep.histories += 1;
      sweep.archives.push(archive);
    }
  }

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
      // The FILE is what a "version" is. Its tree below is the same version's
      // working copy, not a second one, so it is swept and never counted twice.
      sweep.archivedVersions += 1;
      touched = true;
    }
    const pastTree = path.join(archive, `working-${treeDir}`);
    if (await exists(pastTree)) { sweep.dirs.push(pastTree); touched = true; }
    if (touched) sweep.archives.push(archive);
  }
  return sweep;
}

/** The `archived-<stamp>/` directories directly inside `parent`. */
async function archivesIn(parent: string): Promise<string[]> {
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
    return { archivedVersions: 0, workingTree: false, histories: 0 };
  }
}

/** Every byte under `dir`, counted by walking it. Missing is zero, never a throw. */
async function measure(dir: string): Promise<number> {
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
async function countBankPages(dir: string): Promise<number> {
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

function countLines(file: string): Promise<number> {
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

// ─────────────────────────────────────────────────────────────────────────────
// Adopting what was already on disk
// ─────────────────────────────────────────────────────────────────────────────

/** Where conversions landed before projects existed. */
function legacyWorkspaceDir(): string {
  return path.join(readAppSettings().libraryDir, 'workspace');
}

/** Where the readings banks lived before they moved in with their books. */
function legacyReadingsDir(): string {
  return path.join(app.getPath('userData'), 'readings');
}

/**
 * `<userData>/readings/adopted/` — where a bank goes once its copy is in place.
 *
 * A SUBFOLDER, so the scan (which skips directories) stops seeing it, and the
 * bytes are still exactly where somebody who goes looking would look. See
 * `adoptLegacyBanks` for why a bank that stayed in the scanned directory was a
 * bug and not a nicety.
 */
const ADOPTED = 'adopted';

/**
 * `Buch-a1b2c3d4.epub`, `Buch-a1b2c3d4.en.epub`, `Buch-a1b2c3d4.pdf`.
 *
 * The stem is greedy, so the LAST `-<8 hex>` group in the name is the key — which
 * is the right one, because the key is appended last by construction and a book
 * whose own title ends in something that looks like a hash would otherwise be
 * filed under half its name.
 */
const LEGACY_OUTPUT = /^(?<stem>.+)-(?<hex>[0-9a-f]{8})(?:\.(?<tag>[A-Za-z0-9-]+))?\.(?<ext>epub|pdf|txt)$/i;

/** `Buch-a1b2c3d4.jsonl`. */
const LEGACY_BANK = /^(?<stem>.+)-(?<hex>[0-9a-f]{8})\.jsonl$/i;

/**
 * Regroup a flat workspace and a flat readings directory into projects.
 *
 * Runs on every launch and is IDEMPOTENT by construction rather than by a marker
 * file: once a file has moved it is no longer in the directory being scanned,
 * and every write refuses an existing destination outright, so a second pass
 * finds nothing to do and says nothing.
 *
 * WHAT IT MOVES IS AN ORIGIN. Everything the old flat workspace held was written
 * by the engine, so it all belongs in `generated/` — a cast EPUB, a translation,
 * a converted PDF, a text export — and the layers above it are built from there
 * the first time each is opened. There is no `archive/` for these: the PDF they
 * were read from was never copied anywhere, and inventing one would be a guess.
 *
 * THE OUTPUTS ARE MOVED and the READINGS ARE COPIED, and the asymmetry is
 * deliberate. An output is a file this app wrote and can write again; a bank is
 * GPU-hours, and Owen has real ones on this machine — copying means a mistake
 * here cannot destroy one. The copy is then SET ASIDE rather than left in place:
 * see `adoptLegacyBanks`, where leaving it was a bug with teeth.
 *
 * A FILE WHOSE KEY CANNOT BE READ IS LEFT WHERE IT IS and named in a log line.
 * Never moved on a guess: a book filed under the wrong project is a book the
 * user will look for in the wrong folder forever, and the flat directory is a
 * perfectly good place for a file nobody can identify to keep sitting.
 */
export async function adoptLegacyLayout(): Promise<void> {
  const said: string[] = [];
  await adoptLegacyGenerated(said);
  await adoptLegacyBanks(said);
  for (const line of said) console.log(`[projects] ${line}`);
}

async function adoptLegacyGenerated(said: string[]): Promise<void> {
  const from = legacyWorkspaceDir();
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(from, { withFileTypes: true });
  } catch {
    return; // No flat workspace: nothing was ever written the old way.
  }

  for (const entry of entries) {
    const source = path.join(from, entry.name);
    if (!entry.isFile()) {
      said.push(`${source} is not a file, so it was left alone.`);
      continue;
    }
    const match = LEGACY_OUTPUT.exec(entry.name);
    const slug = match?.groups?.['stem'];
    const hex = match?.groups?.['hex'];
    const ext = match?.groups?.['ext']?.toLowerCase();
    if (slug === undefined || hex === undefined || ext === undefined) {
      said.push(
        `${source} carries no <name>-<8 hex> key, so there is no project it certainly belongs to. `
        + 'Left where it is.',
      );
      continue;
    }

    const tag = match?.groups?.['tag'];
    const key = `${slug}-${hex.toLowerCase()}`;
    // The flat name IS the only name this book ever had, so it becomes the stem.
    // It is a slug, and it will read as one — but renaming somebody's book on a
    // guess about what the slug used to spell is worse than a plain name.
    const stem = sanitiseStem(slug);
    const file = ext === 'pdf'
      ? `${stem}.pdf`
      : ext === 'txt'
        ? `${stem}.txt`
        : (tag === undefined ? `${stem}.epub` : translationFileFor(stem, tag));
    const role: ProjectGeneratedRole = ext === 'pdf'
      ? 'searchable'
      : ext === 'txt' ? 'text' : (tag === undefined ? 'cast' : 'translation');
    const kind = kindOf(file);
    if (kind === null) continue; // unreachable: the regex admits three extensions

    const dir = path.join(projectsDir(), key);
    const destination = path.join(dir, GENERATED, file);
    try {
      await withCreatedProject(dir, key, stem, async (manifest) => {
        await fsp.mkdir(path.join(dir, GENERATED), { recursive: true });
        if (!await claim(destination)) {
          said.push(`${destination} already exists, so ${source} was left where it is.`);
          return;
        }
        try {
          await fsp.rename(source, destination);
        } catch (err) {
          // The claim is an empty file. It must not survive a failed move, or
          // the next launch would find a zero-byte book with the right name.
          await fsp.rm(destination, { force: true });
          throw err;
        }
        recordStep(manifest, kind, {
          file: `${GENERATED}/${file}`,
          label: STEP_LABELS[role],
          appliedAt: Date.now(),
          kind: role === 'translation' ? 'translate' : role === 'cast' ? 'origin' : 'convert',
          // Everything the old flat workspace held was written by the engine, so
          // every one of these was a model pass.
          retention: 'expensive',
          why: WHY_MODEL_PASS,
        });
        // Written before the refresh below, for the reason `recordGenerated`
        // gives: the move has already happened, and a refusal from the refresh
        // must not take the record of it down too.
        await writeManifest(dir, manifest);
        said.push(`${entry.name} -> ${destination}`);
        /*
         * A searchable PDF adopted from the flat layout still has to become the
         * live PDF, or the project would list a book and no scan at all — and
         * unlike a conversion run today, this one really IS the scan. Every file
         * this path can find was written by the engine back when `--format pdf`
         * laid an invisible layer over the pages it was given, so promoting it
         * installs a scan rather than replacing one. Nothing new lands here.
         */
        if (role === 'searchable') {
          await refreshLivePdf(dir, manifest, file);
          await writeManifest(dir, manifest);
        }
      });
    } catch (err) {
      said.push(`${source} could not be adopted (${(err as Error).message}). Left where it is.`);
    }
  }
}

/**
 * Copy each flat bank into its project, then SET THE ORIGINAL ASIDE.
 *
 * ── The bug the set-aside fixes, because it had teeth ────────────────────────
 *
 * This used to copy and leave the original exactly where it was, and call itself
 * idempotent on the strength of `copyNewOnly` refusing an existing destination.
 * It was idempotent about the COPY and about nothing else: the file stayed in
 * the directory this scans, so every launch found it again, and finding it again
 * means `withCreatedProject` — which MAKES the project directory if it is not
 * there. Nothing further was copied and nothing was said, so the loop was
 * invisible.
 *
 * Then Home got a delete button, and the loop stopped being invisible: a project
 * the user deleted came back on the next launch as an empty shell — a
 * `project.json` naming a book, a `readings/` folder, and no documents at all.
 * Measured on Owen's machine, an hour after a delete. A delete that undoes
 * itself at the next launch is not a delete, and the user has no way to tell
 * which of the two things they are looking at.
 *
 * So the original MOVES into `adopted/` once its copy is in place. The bytes are
 * still there — this function still refuses to be the thing that destroys a
 * bank — but the scan no longer sees them, and adoption becomes idempotent IN
 * FACT rather than in intention. `adoptLegacyGenerated` never had this problem
 * because it moves what it adopts.
 *
 * IF THE SET-ASIDE CANNOT HAPPEN, SAY SO BY NAME. A bank that could not be moved
 * is one this will find again next launch, so the sentence in the log is the
 * only warning that the shell is going to come back — and it names the file, the
 * place it was going, and why. A destination in `adopted/` that already exists
 * stops this BEFORE the project is created, which is the one case that can be
 * headed off entirely: two flat files of one name cannot both be set aside, and
 * creating a directory for the second would recreate the very shell this is
 * meant to stop.
 */
async function adoptLegacyBanks(said: string[]): Promise<void> {
  const from = legacyReadingsDir();
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(from, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const source = path.join(from, entry.name);
    if (!entry.isFile()) continue; // `archived-<stamp>/` directories stay put.
    const match = LEGACY_BANK.exec(entry.name);
    const slug = match?.groups?.['stem'];
    const hex = match?.groups?.['hex'];
    if (slug === undefined || hex === undefined) {
      /*
       * `completed.json` is the one that has to be named rather than skipped.
       * The engine writes it BESIDE the bank (src/vlm/readings.ts's
       * `completionMarkerPath` joins it onto the bank's own directory), so in a
       * flat readings folder shared by every book on this machine there is
       * exactly one, and it belongs to whichever run finished last. Copying it
       * into a project would tell the engine that THAT book's bank is a finished
       * read — and a half-read book would then be replayed out of a cache
       * instead of being read. Left where it is, deliberately.
       *
       * From here on the problem cannot recur: a project's bank has a readings
       * directory to itself, so its marker names it and nothing else.
       */
      said.push(`${source} names no book's bank, so it was left where it is.`);
      continue;
    }

    const key = `${slug}-${hex.toLowerCase()}`;
    const dir = path.join(projectsDir(), key);
    // Named `<key>.jsonl` rather than carried across verbatim, because that is
    // the exact path `planConversion` will hand the engine as `--readings`. A
    // bank that landed under a name differing by so much as the case of a hex
    // digit would be a bank the resume never finds — and the whole point of
    // copying these in is that the next run does not read those pages again.
    const destination = path.join(dir, 'readings', `${key}.jsonl`);
    const aside = path.join(from, ADOPTED, entry.name);
    // Asked BEFORE anything is created, because this is the failure that would
    // otherwise recreate a deleted project on every launch forever.
    if (await exists(aside)) {
      said.push(
        `${aside} already holds a bank of that name, so ${source} cannot be set aside and was `
        + 'left where it is. Nothing was adopted from it — move one of the two away by hand.',
      );
      continue;
    }
    try {
      await withCreatedProject(dir, key, sanitiseStem(slug), async () => {
        await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
        // A COPY, never a move: see `adoptLegacyLayout`. False means the copy is
        // already there from an earlier launch — which still has to be set aside
        // below, and on Owen's machine those are the ones that matter.
        if (await copyNewOnly(source, destination)) said.push(`${entry.name} -> ${destination} (copied)`);
      });
      // Only ever after the copy exists. A set-aside that ran first would, on a
      // failure between the two, leave the bank in a folder nothing reads and no
      // project holding it — the one outcome worse than adopting it twice.
      await fsp.mkdir(path.join(from, ADOPTED), { recursive: true });
      await fsp.rename(source, aside);
      said.push(`${entry.name} -> ${aside} (set aside; the copy in the project is the live one)`);
    } catch (err) {
      said.push(`${source} could not be adopted (${(err as Error).message}). Left where it is.`);
    }
  }
}

/**
 * Claim a destination, atomically, without writing anything into it.
 *
 * `wx` fails when the file exists, so two app instances started together cannot
 * both decide they are the one adopting a book — and unlike a `stat` followed by
 * a `rename`, there is no window between the question and the answer. False
 * means somebody else has it; the caller leaves the original alone and says so.
 */
async function claim(destination: string): Promise<boolean> {
  try {
    const handle = await fsp.open(destination, 'wx');
    await handle.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}
