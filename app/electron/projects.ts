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
 * it into `generated/archived-<timestamp>/` (`rotateGenerated`), and the working
 * tree unpacked from it goes into the same folder so the next open unpacks the
 * NEW book rather than reopening the old one's edits.
 *
 * A GENERATED BOOK IS ARCHIVED AND A READINGS BANK IS NOT, and the difference is
 * deliberate rather than an inconsistency (docs/BANK-LIFECYCLE.md §5). A
 * generated EPUB can carry a working tree with a person's text edits in it, and
 * labour is kept forever. A bank is a machine's answers: the engine writes the
 * replacement beside the old one and renames it into place only when the run has
 * succeeded, so nothing is destroyed until its successor exists and `readings/`
 * grows no `archived-<stamp>/` hoards.
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
  LedgerParams,
  ProjectDocument,
  ProjectDocumentKind,
  ProjectGenerated,
  ProjectGeneratedRole,
  ProjectLedger,
  ProjectManifest,
  ProjectReading,
  ProjectSummary,
  ProjectStep,
  ProjectTypeRecord,
  ProjectWorkingFile,
  ProjectWorkingTree,
  StepCasualty,
  StepDeletion,
  StepRow,
} from '../shared/types';
import { WHY_HANDMADE, WHY_IMPORTED, WHY_MODEL_PASS } from '../shared/types';
import { spokenStem } from '../shared/documents';
import { readJson } from '../shared/json';
import { STEP_LABELS, migrateToSteps, readTypeRecords } from '../shared/steps';
import {
  askedOf,
  chainsWithout,
  chronological,
  curationInEffect,
  deleteCost,
  deleteSubtree,
  destroyedBy,
  emptyLedger,
  generationForLanding,
  generationInEffect,
  id8,
  migrateLedger,
  orphanedBanks,
  originOf,
  originStep,
  parseLedger,
  pendingBeside,
  positionOf,
  reRunTarget,
  readingInEffect,
  recordLanding,
  stepOf,
  subtree,
  translatedInto,
  translationBankOf,
  translationFileFor,
  translationTarget,
  type LandedRun,
  type Landing,
  type ReadAsk,
} from '../shared/ledger';
import { GENERATED_ROLE_FOR } from '../shared/documents';

/**
 * Somebody has to be told when the library changes, and this is how.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * The renderer's project list had exactly three reasons to re-read: it was
 * constructed, Home came on screen, or a queue job landed. A BACKGROUND IMPORT
 * IS NONE OF THOSE. So a user who dropped a scan on the window got a tab
 * immediately, a project on the disk a few seconds later, and a library screen
 * that went on insisting the book was not there until something unrelated
 * happened to refresh it. Everything downstream that asks "which project is this
 * document in?" — the Generate dialog, the dock's waiting light, the nav's
 * grouping — was reading that same empty list.
 *
 * ONE LISTENER, SET BY MAIN, exactly as `onQueueChanged` is. This module knows
 * when a project changed and knows nothing about windows; main knows about
 * windows and would otherwise have to guess at the moments. A no-op default
 * means the tests and any other importer of this file are unaffected.
 */
let notifyProjects: () => void = () => { /* set by main */ };

export function onProjectsChanged(listener: () => void): void {
  notifyProjects = listener;
}

/**
 * The library changed — said after the change has LANDED, never before.
 *
 * Every caller announces once its own write is on the disk, so a listener that
 * re-reads the directory the moment it hears this cannot see the state the
 * change was made from. It is deliberately not called from `writeManifest`,
 * which would be the one place impossible to forget and also the one that fires
 * three times for a single conversion recording its output.
 */
function announceProjects(): void {
  notifyProjects();
}

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
/** The sixth: the block editor's corrections, one pair per reading. See `overlaysDir`. */
const OVERLAYS = 'overlays';
/**
 * The seventh: frozen curations. See `curationsDir`.
 */
const CURATIONS = 'curations';
/**
 * And the bank of the model's answers — hours of GPU, the thing every rendering
 * is made from, and the product of the one job in this app that costs anything.
 */
const READINGS = 'readings';

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
    parsed = readJson(text);
  } catch (err) {
    throw new ProjectError(`${file} is not JSON (${(err as Error).message}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectError(`${file} is not an object, so it is not a project catalogue.`);
  }
  const row = parsed as Record<string, unknown>;
  /*
   * VERSION 1 IS ADMITTED, NOT JUST VERSION 2. The migration lives two screens
   * down (`readDocuments` builds type records from a v1 file's flat lists), and
   * this gate once refused v1 before that code could run — which locked the
   * user's own library behind "catalogue unreadable" while the function built
   * to open it sat unreachable below. The gate's job is to refuse shapes this
   * app does NOT know, and it knows exactly two.
   */
  if (row['version'] !== MANIFEST_VERSION && row['version'] !== 1) {
    throw new ProjectError(
      `${file} is version ${String(row['version'])} and this app reads versions 1 and ${MANIFEST_VERSION}. `
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
  const stem = typeof row['stem'] === 'string' && row['stem'].length > 0 ? row['stem'] : key;
  const title = typeof row['title'] === 'string' && row['title'].length > 0 ? row['title'] : stem;
  const manifest: ProjectManifest = {
    version: MANIFEST_VERSION,
    key,
    /*
     * A title that still IS the stem is a title nothing ever chose — imports
     * write the stem as a placeholder and `noteProjectTitle` replaces it the
     * first time a real one is seen. Only the placeholder is said aloud
     * (`spokenStem`); a chosen title, even a strange one, is repeated exactly.
     */
    title: title === stem ? spokenStem(stem) : title,
    stem,
    createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : 0,
    archive: readArchive(row['archive']),
    documents: readDocuments(row, readArchive(row['archive'])),
    working: {
      trees: readTrees(working['trees']),
      files: readWorkingFiles(working['files']),
    },
    final: readFinal(row['final']),
    reading: readReading(row['reading']),
  };
  // LAST, because it is the only field built from the manifest rather than from
  // one of its rows: an un-migrated project's ledger is reconstructed out of the
  // archive, the reading and the chains that were read above it.
  manifest.ledger = readLedger(row['ledger'], manifest, file);
  return manifest;
}

/**
 * The step ledger — parsed from the catalogue, or reconstructed for one that
 * predates the whole idea.
 *
 * HEAL ON READ, PERSIST ON NEXT WRITE, which is `healImport`'s pattern a few
 * lines up and `readDocuments`'s before it, for their reason: every project on
 * every disk predates this field, and a migration that only ran on write could
 * half-finish across a crash, while one that rewrote the file on read would make
 * opening Home a write across the user's whole library. `migrateLedger` is
 * deterministic — its ids are ordinal and its times come from the catalogue — so
 * reading a project twice produces the same history byte for byte, and the ids
 * the pointer and the parent chain point at do not move between Tuesday and
 * Wednesday. It reaches disk the next time anything edits the project.
 *
 * A STORED LEDGER THAT WILL NOT PARSE TAKES THE CATALOGUE DOWN, by name, and is
 * not quietly replaced with a migrated one. Both halves of that matter. Refusing
 * is what `readManifest` already does for a catalogue that is not JSON, and it
 * surfaces the same way — `summarise` lists the project with the reason on it, so
 * Home is still the door back to the book. Rebuilding instead would be worse than
 * useless: the reconstruction cannot know about a curation step or a second
 * translation, so a project with a typo in one row would silently lose the
 * history of everything the migration cannot see, and the payloads those steps
 * named would sit in the folder with nothing in the app aware that they exist.
 */
function readLedger(stored: unknown, manifest: ProjectManifest, file: string): ProjectLedger {
  if (stored === undefined) return migrateLedger(manifest);
  try {
    return parseLedger(stored);
  } catch (err) {
    throw new ProjectError(
      `${file} holds a step ledger this app cannot read: ${(err as Error).message}. The ledger is `
      + 'this project\'s account of everything that has been done to the book and of which file each '
      + 'of those left behind, so it is not something to guess at or to rebuild around.',
    );
  }
}

/**
 * The reading generation, or null for a catalogue written before there were any.
 *
 * NULL RATHER THAN A MINTED ONE, and the difference is the whole safety of the
 * backfill: a project with no record here has no overlay that could be bound to a
 * generation — there was nothing writing one — so whatever id it is given first
 * cannot disagree with a file already on disk. Read leniently for the same
 * reason `readTrees` is: a half-written field is treated as absent, which lands
 * on the same safe path.
 */
function readReading(value: unknown): ProjectReading | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const generation = row['generation'];
  if (typeof generation !== 'string' || generation.length === 0) return null;
  const completedAt = row['completedAt'];
  return {
    generation,
    readAt: typeof row['readAt'] === 'number' ? row['readAt'] : 0,
    pages: typeof row['pages'] === 'number' ? row['pages'] : 0,
    /*
     * ABSENT AND ZERO ARE NOT THE SAME STATEMENT here, which is why this is
     * spread rather than defaulted. Absent means nobody recorded which completion
     * this generation was minted against, and `readingGeneration` ADOPTS the
     * marker it finds rather than treating it as a change — the safe direction. A
     * recorded 0 would be a claim about an epoch nothing ever completed at, and
     * every marker on disk would disagree with it forever.
     *
     * `passes` IS NOT READ AND IS NOT CARRIED. It counted archived banks, nothing
     * archives one any more, and a number whose meaning has been deleted is worse
     * kept than dropped — see `ProjectReading.passes`. A catalogue holding one is
     * not refused; the field simply goes the next time this project is written.
     */
    ...(typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0
      ? { completedAt }
      : {}),
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
  const layers = { archive: ARCHIVE, generated: GENERATED };
  if (Array.isArray(row['documents'])) {
    return healImport(readTypeRecords(row['documents']), archive, layers);
  }
  return migrateToSteps(readGenerated(row['generated']), archive, layers);
}

/**
 * The origin step a v2 catalogue is missing, put back on read.
 *
 * ── The bug, and why the migration hid it ───────────────────────────────────
 *
 * `importDocument` wrote `working.files` for a PDF and never recorded a STEP —
 * only the EPUB branch did. So every project imported as a scan carried
 * `documents: []`, and nobody noticed for one reason: `summarise` has a fallback
 * that lists the archived original when a project has no documents at all, so
 * the row appeared and the book opened. V1 PROJECTS WERE CORRECT THE WHOLE TIME
 * BECAUSE THE MIGRATION DID WHAT THE WRITER FORGOT.
 *
 * It came apart the moment anything else was made. The fallback is gated on
 * `documents.length === 0`; generate an EPUB and the EPUB's record appears, so
 * the fallback stops firing and THE PDF ROW SIMPLY VANISHES — the scan becomes
 * unopenable, un-Blockable, `originalOf` falls to the EPUB, and a delete aimed
 * at the project's only remaining row is treated as an ordinary file.
 *
 * ── The heal ────────────────────────────────────────────────────────────────
 *
 * A catalogue that records an archive and has no chain for that archive's KIND
 * is missing its origin, full stop: the archive is the origin, and that is the
 * generalisation this whole model turns on. So the step is synthesised — BY
 * CALLING THE MIGRATION with an empty `generated` list, so the shape is not
 * merely "the same as" what the migration produces, it IS what the migration
 * produces. Two functions building one step is how they come to differ.
 *
 * ON READ, and not written back by itself, exactly as the v1 migration is: it
 * reaches disk the next time anything edits the project. So the live projects
 * this was written for heal without a re-import and without a repair pass
 * anybody has to remember to run.
 */
function healImport(
  records: ProjectTypeRecord[],
  archive: ProjectManifest['archive'],
  layers: { archive: string; generated: string },
): ProjectTypeRecord[] {
  if (archive === null) return records;
  if (records.some((record) => record.kind === archive.kind)) return records;
  return [...migrateToSteps([], archive, layers), ...records];
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
          // Nothing has been read and nothing has been corrected. The reading's
          // generation is minted by the first amendment, not by the import —
          // see `readingGeneration`.
          reading: null,
          // No history yet, and not even an origin: the import that is about to
          // happen is what mints one, and it does so knowing which file it
          // copied. A project directory can also be created by an adoption that
          // never imports anything, and an empty ledger is the honest record of
          // that.
          ledger: emptyLedger(),
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
}

// ─────────────────────────────────────────────────────────────────────────────
// The step ledger, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A manifest's ledger, never undefined.
 *
 * `readManifest` sets the field on every project it returns — migrated when the
 * file has none — so the optional in `ProjectManifest` describes the FILE FORMAT
 * rather than anything a caller in this process can be handed. This is the one
 * place that says so, instead of `?? emptyLedger()` at every call site, where the
 * fallback would eventually be read as "a ledger is sometimes absent" and
 * somebody would write a branch for it.
 */
export function ledgerOf(manifest: ProjectManifest): ProjectLedger {
  return manifest.ledger ?? emptyLedger();
}

/**
 * The origin, with a uuid: this module has the clock and the randomness
 * `shared/ledger.ts` deliberately does without.
 *
 * NO POINTER, which means the newest step — and with one step in the ledger that
 * is this one. Writing it out would be recording a fact the array already
 * implies, in a folder people sync.
 */
function originLedger(payload: string, label: string, createdAt: number): ProjectLedger {
  return { steps: [originStep(randomUUID(), payload, Math.max(0, Math.trunc(createdAt)), label)] };
}

/**
 * `<project>/curations/` — the frozen snapshots of the block editor's overlay.
 *
 * A SEVENTH SIBLING, on `overlays/`'s precedent and NOT inside it, which is the
 * decision worth writing down. `overlays/` is the live pair and its archive
 * folders, and everything that walks it — `countAmendments` for the delete card,
 * the archive-on-generation-mismatch machinery — treats what it finds there as
 * one book's current curation and its discarded predecessors. A snapshot is
 * neither: it is a RETAINED PAYLOAD, named by a step, deleted only when that step
 * is, and never archived aside because it was never bound to the live file's
 * fate. Filing it under `overlays/` would put it in the path of a sweep whose
 * entire premise is that what it finds there is disposable.
 *
 * `<uuid>.json` rather than a name anybody reads: the step's LABEL is what a
 * person sees ("Saved corrections (23)"), and a filename that tried to say the
 * same thing would be a second place for it to be said differently.
 */
export function curationsDir(dir: string): string {
  return path.join(dir, CURATIONS);
}

/**
 * A finished action, recorded against an OPEN manifest. The caller writes.
 *
 * ── The parent, and the two ways it can be wrong ────────────────────────────
 *
 * `parent` is the position captured when the job was ENQUEUED (`Job.parentStep`),
 * which is the whole reason it is an argument rather than something read here: a
 * pointer move while a job sits held must not silently retarget it. Null means
 * nobody captured one — a curation commit, which happens now and therefore has no
 * gap to be wrong across, or a job from a build that predates the field — and
 * then the position at this instant is the honest answer.
 *
 * A CAPTURED PARENT THAT IS NO LONGER THERE FALLS BACK TO THE POSITION rather
 * than refusing. The step it named was deleted while the run was going, and the
 * alternative to falling back is throwing away the payload of a job that has
 * already finished in order to protect the shape of a list. The list is
 * recoverable; three hours of GPU are not — the same call `appendStep` makes when
 * a clock steps backwards, for the same reason.
 *
 * RETURNS NULL FOR A LEDGER WITH NO STEPS, which is not an error either. A
 * project adopted out of the old flat workspace can have outputs and no import,
 * so there is no origin for anything to hang from, and inventing a parentless
 * `read` would give that project a history whose first act was reading a book
 * nobody can see was imported.
 */
async function landStep(
  manifest: ProjectManifest,
  run: Omit<LandedRun, 'id' | 'parent'> & {
    parent: string | null;
    /**
     * THE ID, WHEN THE CALLER ALREADY SPENT IT ON SOMETHING. A reading's bank is
     * named after the step it belongs to (`bankForReading`), so that id was minted
     * hours ago at the plan and has been written into a filename since — minting a
     * second one here would leave the file named after a step nobody created. Every
     * other landing has nothing riding on the id and lets this mint one.
     *
     * It is spent only on an append either way, which is `LandedRun.id`'s own rule.
     */
    id?: string;
  },
): Promise<Landing | null> {
  const ledger = ledgerOf(manifest);
  const standing = positionOf(ledger);
  if (standing === null) return null;
  const captured = run.parent !== null && ledger.steps.some((step) => step.id === run.parent)
    ? run.parent
    : standing.id;
  const landing = recordLanding(ledger, { ...run, parent: captured, id: run.id ?? randomUUID() });
  manifest.ledger = landing.ledger;
  return landing;
}

/**
 * Destroy a payload the ledger no longer names. After the write, never before.
 *
 * `force` so a payload that is already gone — a bank the user deleted by hand, a
 * rendering that never landed — finishes the delete rather than refusing it: what
 * is being removed is the app's claim to own the file, and being generous about a
 * file that has already left is not being generous about which file this is. The
 * path is composed from the project directory and the step's own PROJECT-RELATIVE
 * payload, split on the forward slashes the format stores, so nothing here ever
 * matches a file by its basename.
 */
async function destroyPayload(dir: string, payload: string): Promise<void> {
  const target = path.join(dir, ...payload.split('/'));
  await fsp.rm(target, { force: true, recursive: false });
}

/**
 * The steps and the flat list the accordion draws, in one answer.
 *
 * EVERY CALL THAT CHANGES A LEDGER ANSWERS WITH THIS, and that is a correction
 * rather than a convenience. Three of them used to hand back a bare
 * `ProjectLedger` — the pointer move, the delete and the commit — and the rows
 * are MAIN'S TO COMPOSE (`chronological`, and the "from …" annotation is the one
 * concession this design makes to the tree), so the renderer had to ask again
 * after every one of them. A second round trip is a second answer, composed a
 * moment later, about a catalogue that may have moved: the window either drew a
 * list from before its own gesture or painted twice. What a caller gets back now
 * is the whole answer to what it just did.
 */
export interface LedgerView {
  ledger: ProjectLedger;
  /**
   * `chronological`'s rows, composed HERE rather than in the renderer.
   *
   * The ordering and the quiet "from Read" annotation are the two things the flat
   * list gets wrong if anybody re-derives them, and the renderer re-deriving them
   * would be a second implementation of the one concession this design makes to
   * the tree. Main holds the ledger; main says what the list looks like.
   */
  rows: StepRow[];
}

/**
 * One project's history, as the accordion needs it.
 *
 * The path is PROVEN to be a project before a byte is read — `deletableProjectDir`
 * — because every call in this family takes a directory named by the renderer and
 * one of them unlinks files. The gate is the same one for all four so that no
 * member of the family is the lenient way in.
 */
export async function readStepLedger(dir: string): Promise<LedgerView> {
  const manifest = await readManifest(deletableProjectDir(dir));
  const ledger = ledgerOf(manifest);
  return { ledger, rows: chronological(ledger) };
}

/**
 * Stand on a different step.
 *
 * FREE, AND THE FREENESS IS THE FEATURE. Clicking a row in a history panel is a
 * gesture every user of every history panel believes costs nothing, and here it
 * genuinely does: one manifest write, no job, no rendering, no file touched. What
 * it changes is what the viewers show and what the next action is made from.
 *
 * `stepOf` refuses an id this ledger does not hold, by name. A pointer that has
 * come loose is not something to fall back from quietly — the caller named a row
 * the app drew, so an id that is not there means the two are looking at different
 * ledgers, and the honest answer is to say so.
 */
export async function goToStep(dir: string, stepId: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
    const standing = stepOf(ledgerOf(manifest), stepId);
    const next: ProjectLedger = { ...ledgerOf(manifest), position: standing.id };
    manifest.ledger = next;
    await writeManifest(resolved, manifest);
    return next;
  });
  // The tabs of this project repaint from the position, and Home's rows are
  // derived from what the ledger calls current. Both hear about it the one way
  // anything in this app hears that a project moved.
  announceProjects();
  // The rows are the same rows — a pointer move changes no step and no order —
  // and they are composed again anyway, because a caller that had to know which
  // of these answers is worth redrawing would be a caller deriving the list.
  return { ledger, rows: chronological(ledger) };
}

/**
 * What deleting this step would take, and whether it is allowed at all.
 *
 * DESCRIBE AND DELETE ARE TWO CALLS, exactly as they are for a document, and this
 * one owes the refusals as well as the facts: a card must never be put on screen
 * for something the delete would refuse a click later. `deleteSubtree` refuses the
 * origin by name — deleting the import is deleting the project, and the project ✕
 * does that with its own ceremony and its own accounting of what it costs.
 *
 * EVERY CASUALTY IS NAMED WITH ITS OWN COST, in the retention rule's own terms,
 * because the three retentions are three genuinely different losses. A confirm
 * that said "Are you sure?" over a list of four would train somebody to click
 * through the one that was about their curation.
 */
export async function describeStepDelete(dir: string, stepId: string): Promise<StepDeletion> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  const named = stepOf(ledger, stepId);
  // Run for its REFUSAL as much as for its list: this is the one place that can
  // say no before the user has agreed to anything.
  const deletion = deleteSubtree(ledger, stepId);
  const banks = new Set(orphanedBanks(deletion, manifest.key));
  const destroyed = destroyedBy(deletion, manifest.key);
  const sweeps = await planStepSweep(resolved, destroyed, banks, manifest);
  // The other refusal that must land before the card is drawn, for its own
  // reason: a book this window is reading cannot be unlinked on Windows, so a
  // card that ignored it would be a question whose yes main declines to act on.
  refuseOpenPayload(sweeps, named.label);
  return {
    belongings: sweptBelongings(sweeps),
    stepId: named.id,
    label: named.label,
    casualties: subtree(ledger, stepId).map((step): StepCasualty => ({
      id: step.id,
      label: step.label,
      cost: deleteCost(step),
      stale: step.stale === true,
    })),
    files: destroyed.map((payload) => path.join(resolved, ...payload.split('/'))),
  };
}

/**
 * Refuse while this window is still reading one of the doomed payloads.
 *
 * ── WHICH MODEL WON, and it is the document delete's ────────────────────────
 *
 * There were two in the app and they did not agree. The PROJECT delete refuses in
 * main by asking `openBookIn` — it looks at what is open and says no. The DOCUMENT
 * delete refuses in main too, by a narrower test (`workingTreeHeld`, the count the
 * epub reader holds from open to close), AND the renderer closes the file's own
 * tab between the confirm and the call. The step delete had neither, so deleting a
 * translate step whose EPUB was open left a tab serving a working copy that had
 * just been erased: every image a 404, every save a failure, and nothing on screen
 * saying why.
 *
 * THE DOCUMENT DELETE'S MODEL IS THE ONE ADOPTED HERE, whole: main refuses, and
 * the renderer closes first so the refusal is almost never reached. The narrower
 * test is the right one for the same reason it is right there — a step delete
 * takes ONE payload out of a project, and refusing it because some other book in
 * the same folder happens to be open would make the ✕ useless exactly when it is
 * wanted (throw away the English translation while reading the scan). The project
 * delete keeps `openBookIn` because it erases the folder, which is a different
 * act and says so in its own sentence.
 */
function refuseOpenPayload(sweeps: readonly Sweep[], label: string): void {
  for (const sweep of sweeps) {
    if (sweep.treeRoot === null || !workingTreeHeld(sweep.treeRoot)) continue;
    throw new ProjectError(
      `“${label}” cannot be deleted while the book it made is open in Foundry — erasing the `
      + 'working copy out from under a tab that is reading it would leave that tab showing files '
      + 'that no longer exist, and would leave half an unpacked book on disk. Close the book '
      + 'first, then delete the step.',
    );
  }
}

/**
 * Everything on disk that goes with the payloads a step delete destroys.
 *
 * ── The state this was leaving behind ───────────────────────────────────────
 *
 * A step delete used to unlink the payload and nothing else, and a payload is not
 * the only file that belongs to it. Deleting a translation whose EPUB had been
 * unpacked left `working/<tree>/` — a whole book's markup — in the folder, a
 * `working.trees` row whose `from` named a file that no longer existed, and
 * `history/<tree>.json`, an undo ledger for a book that is gone. None of it is
 * reachable from anything in the app afterwards: the row it hung off is off the
 * ledger, so it is bytes nothing will ever mention again, which is precisely the
 * outcome `deleteDocument` was written to avoid.
 *
 * `planSweep` IS THAT ANSWER AND IT IS REUSED RATHER THAN RESTATED. It is the one
 * place that knows what belongs to a file alone — the tree, the ledgers live and
 * archived, the rotated predecessors — and its docstring is the argument for each.
 * Two functions deciding that would be two answers to "what is this file's", and
 * the delete card and the delete would eventually describe different things.
 *
 * ONE SWEEP PER PAYLOAD, over `orphanedPayloads` rather than the removed steps:
 * a file another step still names is still on disk and still has a working tree
 * serving it. See that function for the re-read that leaves two steps naming one
 * bank.
 */
async function planStepSweep(
  dir: string,
  payloads: readonly string[],
  /**
   * Which of those files are BANKS, so the engine's in-flight debris beside them
   * goes too. See `pendingBeside` for what that debris is and why no step will
   * ever name it.
   *
   * Both kinds are in here (`orphanedBanks`): a reading's bank, which is also its
   * step's payload, and a translation's, which is a file beside its step's payload
   * and reaches this list only because `destroyedBy` put it there. The translate
   * engine writes `<bank>.pending` and no request sidecar, and an absent sidecar
   * simply fails the existence test below — one rule, two callers, no `if`.
   */
  banks: ReadonlySet<string>,
  manifest: ProjectManifest,
): Promise<Sweep[]> {
  const sweeps: Sweep[] = [];
  for (const payload of payloads) {
    const resolved = path.join(dir, ...payload.split('/'));
    const sweep = await planSweep(dir, resolved, manifest);
    /*
     * ADDED HERE RATHER THAN INSIDE `planSweep`, deliberately: that function is
     * shared with the DOCUMENT delete, which is about EPUBs and PDFs and has no
     * business knowing what a readings bank is. This is the step delete's own
     * rule, so it is applied where the step delete composes its sweeps.
     *
     * The existence test is `planSweep`'s own idiom, and it earns its stat: the
     * card counts and lists what a sweep holds, and a path in there for a file
     * that was never on disk would be this app naming debris it invented.
     */
    if (banks.has(payload)) {
      for (const debris of pendingBeside(resolved)) {
        if (await exists(debris)) sweep.files.push(debris);
      }
    }
    sweeps.push(sweep);
  }
  return sweeps;
}

/*
 * `banksAmong` MOVED TO shared/ledger.ts AS `orphanedBanks`, beside
 * `orphanedPayloads`, whose question it is a second half of: what does this delete
 * actually take off the disk? It is a pure map from a decided deletion to a list
 * of paths — no directory, no filesystem — and it decides whether hours of GPU are
 * destroyed, which is exactly the code this app keeps where a test can reach it
 * (see that module's header). `destroyedBy` went with it for the same reason.
 */

/**
 * What the sweep will take besides the payloads, as one sentence — or null.
 *
 * A CONFIRM MAY NOT DESTROY SOMETHING IT DID NOT NAME. Everything in here is
 * genuinely going: the unpacked working copy of a book, the undo history written
 * against it, the versions earlier runs rotated aside. Every one of them belongs
 * to a payload above and to nothing else (`planSweep` is the argument for each),
 * so leaving them would leave bytes nothing in the app can reach — and taking
 * them silently would be the app erasing an afternoon's markup while asking about
 * a row in a list.
 *
 * NULL FOR THE ORDINARY CASE, which is most of them: a curation snapshot is one
 * file, and a reading nobody re-read has nothing beside it. A sentence that
 * appeared every time and usually said "and nothing else" is a line people learn
 * to skip.
 */
function sweptBelongings(sweeps: readonly Sweep[]): string | null {
  let trees = 0;
  let histories = 0;
  let versions = 0;
  for (const sweep of sweeps) {
    if (sweep.treeRoot !== null) trees += 1;
    histories += sweep.histories;
    versions += sweep.archivedVersions;
  }
  const parts: string[] = [];
  if (trees > 0) {
    parts.push(trees === 1
      ? 'the unpacked working copy of that book'
      : `${trees} unpacked working copies`);
  }
  if (histories > 0) {
    parts.push(histories === 1 ? 'its undo history' : `${histories} undo histories`);
  }
  if (versions > 0) {
    parts.push(versions === 1
      ? 'one earlier version an earlier run rotated aside'
      : `${versions} earlier versions earlier runs rotated aside`);
  }
  if (parts.length === 0) return null;
  const said = parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `It also takes ${said}. Those belong to the files above and nothing else in this project `
    + 'names them.';
}

/** The two names a refusal about one step has to be able to say out loud. */
export interface StepSubject {
  /** The directory, resolved and PROVEN to be one this app may delete inside. */
  dir: string;
  /** The project as its owner knows it — the book's title, never the key. */
  title: string;
  /** The step as the row on screen says it: "Read (317 pages)". Never a file. */
  label: string;
}

/**
 * Who a step delete is about — for a caller with a refusal of its own to compose.
 *
 * ── Why this is not `inspectProject` ────────────────────────────────────────
 *
 * The delete card's inventory measures every byte under the project and streams
 * every bank in it to count pages, which is right for a dialog somebody opened on
 * purpose and absurd for composing one sentence about a job in the shelf. This is
 * the cheap half: one catalogue read, which is a few kilobytes.
 *
 * ── And why the two names travel together ───────────────────────────────────
 *
 * A refusal has to be actionable, and "a job is running, so this cannot be
 * deleted" is not — the person is looking at a list of steps and a shelf of jobs
 * and has to be told which of each. Both facts come out of the one manifest read
 * that proves the directory, so there is no arrangement where a caller has one
 * and has to go back for the other.
 *
 * ── THE PERMANENT REFUSAL IS RUN FIRST, AND THAT IS THE POINT OF THE NAME ───
 *
 * `deleteSubtree` is called for its refusal and its answer thrown away, exactly as
 * `describeStepDelete` calls it. The order matters to the person reading the
 * sentence: the origin can NEVER be deleted, and telling somebody to cancel a job
 * and come back — about a step that will refuse them just as firmly in an hour —
 * is a sentence that wastes their afternoon. A transient refusal must never be
 * said in front of a permanent one.
 *
 * `stepOf` refuses an id this project does not hold, by name, which is the right
 * answer for a renderer naming a row nobody drew.
 */
export async function deletableStep(dir: string, stepId: string): Promise<StepSubject> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  deleteSubtree(ledger, stepId);
  return { dir: resolved, title: manifest.title, label: stepOf(ledger, stepId).label };
}

/**
 * Take a step and everything made from it, off the ledger and off the disk.
 *
 * ── The order, which is the only interesting decision here ──────────────────
 *
 * THE MANIFEST GOES FIRST. Between the two writes there is a window, and it can
 * only fall one of two ways: files on disk that nothing names, or rows naming
 * files that are gone. The second is the survivable one — `summarise` already
 * draws a document whose file is missing, marked missing, so a person can see
 * what happened and act — while the first is a folder quietly holding hours of
 * GPU that no screen in this app will ever mention again. So the record of the
 * decision lands first, and the unlinking follows it.
 *
 * A FILE THAT WILL NOT DELETE IS A NAMED CONSOLE LINE AND NOT A THROW, for the
 * same reason: by the time it is reached the delete has happened as far as this
 * app's own bookkeeping is concerned, and rejecting the call would tell the user
 * their delete failed while leaving it done. What is left behind is one stray
 * file, named, in a folder they can open.
 *
 * WHAT IS DESTROYED IS `orphanedPayloads` AND NOT "the removed steps' payloads".
 * Two steps are allowed to name one file and in this app routinely do — see that
 * function for the re-read that leaves two `read` steps pointing at one bank.
 *
 * ── AND THE PER-TYPE ROW GOES IN THE SAME BREATH ────────────────────────────
 *
 * `manifest.documents` is the other record of the same files — the chains Home's
 * document rows are drawn from — and a delete that struck the ledger and left
 * those alone gave the user a row for a file it had just erased, drawn as
 * `missing`: the app's way of saying "something happened to a file you still
 * have" about the one thing they had deliberately thrown away. So `chainsWithout`
 * strikes them, from `orphanedPayloads` for the same reason the unlinking is —
 * what a surviving step still names is still on disk and is still a true row.
 *
 * IN THIS TRANSACTION, not a second one. Both edits are made against the open
 * manifest and land in ONE `writeManifest`, so there is no window where a crash
 * could leave the two records disagreeing about what this project has. The window
 * that does remain is the one below — rows written, files not yet unlinked — and
 * it falls the survivable way on purpose.
 *
 * ── AND THE PAYLOAD'S OWN BELONGINGS GO WITH IT ─────────────────────────────
 *
 * `planStepSweep` is the rest of the delete, and its comment is the argument: a
 * translation's EPUB has a working tree unpacked from it and an undo ledger named
 * after that tree, and a delete that took the row and the file and left those
 * behind left a directory of somebody's markup that nothing in the app can reach.
 * The tree's manifest row goes in the same transaction as the ledger surgery, for
 * the reason the chains do — a row naming a directory that is not there is the
 * exact state `rotateGenerated` is careful never to leave.
 *
 * ── AND A BANK'S HALF-FINISHED REPLACEMENT GOES WITH THE BANK ───────────────
 *
 * A re-read writes into `<bank>.pending` and swaps it over the real file only on
 * success, so a run that died leaves that pending file and its request sidecar
 * beside the bank as resumable debris (docs/BANK-LIFECYCLE.md §2). NO STEP NAMES
 * THEM — steps are minted on success and success is when the pending file stops
 * existing — so `orphanedPayloads` cannot find them and they would sit in
 * `readings/` forever after the bank they were replacing was deleted. Debris whose
 * bank is gone is debris about nothing. `orphanedBanks` decides which files are
 * banks, from the step's own action, and `planStepSweep` adds the pair.
 *
 * ── AND A TRANSLATION'S BANK IS THE SAME ARGUMENT ABOUT A DIFFERENT FILE ────
 *
 * A translate step's payload is the EPUB; the answers it was assembled from are in
 * the bank beside it, named by `params.bank` and by no step's payload anywhere. So
 * `orphanedPayloads` cannot find that either, and deleting the English translation
 * used to leave its whole per-block record in `readings/` — the same hours of GPU,
 * kept for a row that no longer exists. It is destroyed with the step, guarded by
 * the same whole-path check against what every surviving step MEANS by its bank
 * (recorded, or composed from its language for a translation that predates the
 * record), and its own pending file goes with it.
 *
 * A QUEUED JOB ABOUT TO RESUME ONE CANNOT LOSE IT TO THIS, and there is no new
 * mechanism for that: `refuseBusyStepDelete` (electron/main.ts) already refuses a
 * step delete while ANY held, queued or running job writes into this project —
 * deliberately coarse, on `refuseBusyJob`'s own argument that a narrower test
 * would have to predict where a run that has not started will write. Both IPC
 * doors ask it, the describe and the delete, so the card is never drawn for
 * something the click would refuse.
 */
export async function deleteStep(dir: string, stepId: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const { ledger, orphans, sweeps } = await withManifest(resolved, async (manifest) => {
    const deletion = deleteSubtree(ledgerOf(manifest), stepId);
    const banks = new Set(orphanedBanks(deletion, manifest.key));
    const destroyed = destroyedBy(deletion, manifest.key);
    const planned = await planStepSweep(resolved, destroyed, banks, manifest);
    // PROVED AGAIN INSIDE THE TRANSACTION, never trusted from `describeStepDelete`:
    // a book can be opened between the question and the answer, and this is the
    // call that unlinks a working tree.
    refuseOpenPayload(planned, stepOf(ledgerOf(manifest), stepId).label);

    manifest.ledger = deletion.ledger;
    manifest.documents = chainsWithout(manifest.documents, destroyed);
    // The trees are keyed by the origin they were unpacked FROM, which is a
    // project-relative path spelled exactly as a payload is — so this compares
    // whole paths and never a basename.
    const unpacked = new Set(destroyed);
    manifest.working.trees = manifest.working.trees.filter((row) => !unpacked.has(row.from));
    await writeManifest(resolved, manifest);
    return { ledger: deletion.ledger, orphans: destroyed, sweeps: planned };
  });
  for (const payload of orphans) {
    try {
      await destroyPayload(resolved, payload);
    } catch (err) {
      console.error(
        `[projects] ${path.basename(resolved)}: ${payload} was deleted from this project's history `
        + `and could not be removed from the disk (${(err as Error).message}). Nothing in Foundry `
        + 'names that file any more; it is still in the project folder.',
      );
    }
  }
  // `force: true` throughout and no throw, for `deleteDocument`'s reason and this
  // function's own: by the time this runs the delete has happened as far as the
  // catalogue is concerned, and failing the call would tell the user their delete
  // did not work while leaving it done.
  for (const sweep of sweeps) {
    for (const target of sweep.files) await fsp.rm(target, { force: true });
    for (const target of sweep.dirs) await fsp.rm(target, { recursive: true, force: true });
    // An `archived-<stamp>/` folder that held nothing but this payload's past goes
    // with it. Emptiness is the test rather than "we emptied it", because one
    // rotation folder can hold several documents stamped in the same second.
    for (const archive of sweep.archives) {
      try {
        const left = await fsp.readdir(archive);
        if (left.length === 0) await fsp.rmdir(archive);
      } catch { /* already gone, or not ours to force */ }
    }
  }
  announceProjects();
  return { ledger, rows: chronological(ledger) };
}

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
export async function recordCuration(
  dir: string,
  payload: string,
  params: LedgerParams,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
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
    return landing.ledger;
  });
  announceProjects();
  return { ledger, rows: chronological(ledger) };
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
 * The overlay a rendering AT THE POSITION is made with: a frozen snapshot when
 * the user is standing on one, the live curation otherwise.
 *
 * ── This is where the pointer stops being decoration ────────────────────────
 *
 * Every rendering in this app is `render(bank + overlay)` and there has only ever
 * been one overlay to pass. A curation step freezes a copy of it, and a frozen
 * copy nobody can render is a file with no purpose — so standing on a save has to
 * change which file `--overlay` names, or the whole commit is bookkeeping about
 * nothing. `curationInEffect` is the decision and it is pure; this composes the
 * path from it.
 *
 * THE LIVE FILE IS THE ANSWER FOR ALMOST EVERY PROJECT, and that is what makes
 * this safe to put in the path of every Generate: a project where nobody has ever
 * pressed Save has no `curate` step for any position to resolve to, so it gets
 * exactly the path it has always got.
 */
export function renderingOverlay(dir: string, manifest: ProjectManifest): string {
  const snapshot = curationInEffect(ledgerOf(manifest));
  return snapshot === null
    ? path.join(overlaysDir(dir), `${manifest.key}.json`)
    : path.join(dir, ...snapshot.payload.split('/'));
}

/** The same answer for a caller that has not read the catalogue yet. */
export async function overlayForPosition(dir: string): Promise<string> {
  return renderingOverlay(dir, await readManifest(dir));
}

/**
 * The bank a rendering AT THE POSITION is made from — the step's own file.
 *
 * ── The row that rendered somebody else's reading ───────────────────────────
 *
 * `readings/<key>.jsonl` was composed from the project key at every call site, on
 * the belief that a project has one bank. It does not: a re-read asking for a
 * different page range BRANCHES by design (`MINTED_BY_THE_RUN`), so a project can
 * hold two `read` steps — and while both composed the same path, standing on the
 * older one and pressing Generate rendered the newer reading. The row named a
 * bank that had been written over from under it and nothing on screen said so.
 *
 * So the plan asks the row: `readingInEffect` walks up from the position to the
 * reading this branch of the story is about, and its payload is the answer. The
 * exact shape `renderingOverlay` above already has, for the same reason — the
 * pointer decides which of several files a run is handed, and composing one from
 * the key is a second opinion about a question the ledger has already answered.
 *
 * THE COMPOSED PATH IS THE FALLBACK AND IT IS NOT A LEGACY BRANCH. Every project
 * that existed before per-step paths has one read step whose payload IS
 * `readings/<key>.jsonl`, so those go through the ledger like everything else and
 * no file on any disk moves. What falls back here is a project with no reading at
 * all — and a position standing on the import, the revert row, which is about the
 * untouched original rather than about any bank.
 */
export function readingBank(dir: string, manifest: ProjectManifest): string {
  const reading = readingInEffect(ledgerOf(manifest));
  return reading === null
    ? path.join(dir, READINGS, `${manifest.key}.jsonl`)
    : path.join(dir, ...reading.payload.split('/'));
}

/** The same answer for a caller that has not read the catalogue yet. */
export async function bankForPosition(dir: string): Promise<string> {
  return readingBank(dir, await readManifest(dir));
}

/**
 * Whether the bank AT THE POSITION carries the engine's completion marker — the
 * one fact that makes a rendering free.
 *
 * ── What a caller is actually asking ────────────────────────────────────────
 *
 * `replaysCompletedBank` (src/vlm/read.ts) is true for `--reuse-readings` over a
 * marked bank and false for everything else, and it is what the engine's own argv
 * layer asks before it refuses a run for having no reading backend. So a marker
 * beside the bank is exactly "this run will read no pages and needs no server",
 * and its absence is "this run intends to read whatever is missing" — a resume,
 * which needs a vLLM the pipeline has no business standing up in the middle of a
 * two-stage Generate.
 *
 * EXISTENCE AND NOT THE STAMP, which `markerStamp` below answers for a different
 * question. That one parses `completedAt` because the generation ruling compares
 * instants; this one must agree with the ENGINE's test, and the engine's test is
 * whether the marker is there. A marker this app could not parse would otherwise
 * refuse a Generate the engine would have run perfectly well.
 *
 * `completionMarkerFor` rather than the name composed a second time here: two
 * spellings of one file is two answers the day either of them changes.
 */
export async function readingIsComplete(dir: string, manifest: ProjectManifest): Promise<boolean> {
  return exists(completionMarkerFor(readingBank(dir, manifest)));
}

/** A bank an OCR run will fill, and the step it belongs to. See `planReading`. */
export interface PlannedBank {
  /** Absolute. What the engine is handed as `--readings`. */
  readingsPath: string;
  /** `LandedRun.id` for this run: an existing step on a replace, minted on a branch. */
  stepId: string;
}

/**
 * WHERE THIS READING'S ANSWERS GO, decided before the job is enqueued.
 *
 * ── Why the path cannot wait for the landing ────────────────────────────────
 *
 * The engine is handed one path and writes into it for three hours. By the time
 * anything lands there is nothing left to decide — so the question "is this
 * reading the one that already exists, or a new one beside it?" has to be
 * answered here, at the plan, and answered the SAME WAY the landing will answer
 * it or the file and the row will describe different readings.
 *
 * It is the same question, asked of the same function, with the same three
 * arguments the landing uses:
 *
 *   THE ACTION is `read`, obviously.
 *
 *   THE PARENT IS THE ORIGIN, never the position. A reading reads the PIXELS,
 *   which live in `archive/` however far through their own history the person
 *   pressing OCR happens to be standing — the reading-parents-at-origin rule, and
 *   `recordReading` obeys it too (see `originOf` in shared/ledger.ts for what
 *   parenting it at the position would cost).
 *
 *   THE PARAMS ARE WHAT THE DIALOG ASKED, normalised by `askedOf` rather than
 *   trimmed here, precisely so the two askings cannot come to disagree about
 *   whether a blank box is a page range.
 *
 * ── The three answers ───────────────────────────────────────────────────────
 *
 * A REPLACE aims at the target step's existing payload. Same step, same path, new
 * contents — which is what `recordLanding` already says about the row, now true
 * of the file as well. The engine writes a pending bank beside it and swaps on
 * success (docs/BANK-LIFECYCLE.md §2), so the old answers survive a failed run.
 *
 * A FIRST READING keeps `readings/<key>.jsonl`. That is what every project on
 * every disk already has, and the whole reason this scheme needs no migration.
 *
 * A BRANCH mints `readings/<key>.<id8>.jsonl`, `id8` being the front of the
 * step's own uuid. Deterministic, collision-free, and never shown to a person —
 * filenames are out of the UI, the row's name comes from `labelFor`. An ordinal
 * would read better in Explorer and would be a second counter to keep consistent
 * with the ledger; the uuid is already minted and already unique.
 *
 * THE ID IS MINTED HERE AND ONLY HERE, and travels on the request to the landing
 * (`ReadRequest.stepId`). Minting it at the landing instead would mean composing
 * a filename from an id the filename could not know; minting it twice would mean
 * a bank named after a step nobody created.
 */
export async function bankForReading(dir: string, asked: ReadAsk): Promise<PlannedBank> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const target = reRunTarget(ledger, {
    action: 'read',
    parent: originOf(ledger)?.id ?? null,
    params: askedOf(asked),
  });
  if (target !== null) {
    return { readingsPath: path.join(dir, ...target.payload.split('/')), stepId: target.id };
  }
  const minted = randomUUID();
  // A project with no reading yet takes the plain name — including one whose only
  // read step was deleted, which destroyed that bank and left the name free.
  const first = !ledger.steps.some((step) => step.action === 'read');
  const file = first ? `${manifest.key}.jsonl` : `${manifest.key}.${id8(minted)}.jsonl`;
  return { readingsPath: path.join(dir, READINGS, file), stepId: minted };
}

/** A translation's files, and the step they belong to. See `bankForTranslation`. */
export interface PlannedTranslation {
  /** Absolute. What the engine is handed as `--out`. */
  outputPath: string;
  /** Absolute. What the engine is handed as `--bank`. */
  bankPath: string;
  /** `LandedRun.id` for this run: an existing step on a replace, minted on a branch. */
  stepId: string;
}

/**
 * WHERE THIS TRANSLATION'S FILES GO, decided before the job is enqueued.
 *
 * `bankForReading` above, one folder over and for the identical reason: the engine
 * is handed paths and writes into them for hours, so "is this the translation that
 * already exists, or a new one beside it?" has to be answered at the plan and
 * answered the SAME WAY the landing will answer it. `translationTarget` is that one
 * answer, and it is pure so that both askings are the same code rather than the
 * same intention.
 *
 * ── The parent is the POSITION, which is where a translation differs from a read ─
 *
 * A reading reads the pixels and is parented at the origin however far through
 * their history the person pressing OCR is standing (`originOf`). A translation
 * reads a BOOK — the rendering of wherever the user is standing — so its parent is
 * the position, and that is the whole of why translating the reading and
 * translating a curation of it are two rows rather than one overwritten twice.
 *
 * ── The window between this and the enqueue, stated rather than discovered ──
 *
 * `Job.parentStep` is captured at the press, a moment after this runs, and a
 * pointer move in between would let the plan and the landing disagree about the
 * parent — a branch planned and a replace landed, or the reverse. Both fall safely
 * and neither invents a rule: a replace that lands on minted paths keeps its row
 * and takes them, and `Landing.displaced` destroys what it left behind only after
 * proving no surviving row names it; a branch that lands on an existing row's paths
 * is the two-steps-one-payload state `orphanedPayloads` has always guarded. The
 * alternative — trusting the renderer to hand back the parent this plan used — is a
 * fact about a person's history taken from outside main.
 */
export async function bankForTranslation(
  dir: string,
  language: string,
  /**
   * THE STEP THIS TRANSLATION IS FILED AGAINST, when the caller knows it and the
   * position is not it.
   *
   * ── Why a second answer to "which parent" exists at all ─────────────────────
   *
   * The Translate dialog asks for a translation OF what is on screen, so the
   * position is the parent and this stays undefined — the ordinary case, and the
   * paragraph above is about it. A GENERATE STANDING ON A TRANSLATION is the case
   * that needs the argument: the user is asking for that row again, so the run is
   * filed against the row's own parent, and asking the position instead would
   * append a translation whose parent is a translation — a second row beside the
   * one they meant to refresh. `renderPipeline` decides which of the two it is
   * (`landsUnder`, shared/pipeline.ts) and hands the answer down.
   *
   * `undefined` means ask the position; `null` is a real parent (the origin, for
   * a ledger with nothing else in it) and is passed through as one.
   */
  parent?: string | null,
): Promise<PlannedTranslation> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const target = translationTarget(
    ledger,
    {
      parent: parent === undefined ? positionOf(ledger)?.id ?? null : parent,
      language,
      stem: manifest.stem,
      key: manifest.key,
    },
    randomUUID(),
  );
  return {
    outputPath: path.join(dir, ...target.output.split('/')),
    bankPath: path.join(dir, ...target.bank.split('/')),
    stepId: target.stepId,
  };
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
/**
 * A rotation that happened, and everything needed to put it back.
 *
 * IT IS A RECEIPT, and it exists because a rotation is now made at the moment
 * the engine is about to write rather than when a job is planned — so there is a
 * window, however short, in which the run can fail and the previous output has to
 * come home. See `restoreRotation`.
 */
export interface Rotation {
  /** `<stem>.epub` — the name in `generated/` that was moved out of the way. */
  file: string;
  /** Where it went: `generated/archived-<stamp>/<file>`. */
  movedTo: string;
  /** The working tree's catalogue row, which the rotation struck out. */
  tree: ProjectWorkingTree | null;
}

/**
 * Whether a rotation of this file is currently refusable, and why.
 *
 * ONE RULE, ASKED TWICE. The rotation itself happens as the engine starts, which
 * is the right moment for the filesystem and the wrong moment to tell somebody
 * their book is open — by then they have pressed Generate and walked away. So the
 * dialog asks this first and refuses in front of them, and the rotation asks it
 * again because a tab can be opened in between and only the second answer is an
 * authorization.
 */
export async function rotationRefusal(dir: string, file: string): Promise<string | null> {
  const target = path.join(dir, GENERATED, file);
  if (!await exists(target)) return null;
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    // A catalogue that will not parse cannot say which tree serves this file.
    // The rotation itself will fail on its own read; there is nothing to refuse
    // in advance.
    return null;
  }
  const tree = manifest.working.trees.find((entry) => entry.from === `${GENERATED}/${file}`) ?? null;
  if (tree === null) return null;
  if (!workingTreeHeld(path.join(dir, WORKING, tree.dir))) return null;
  return `${file} is open in Foundry right now. Running this again would move the working copy `
    + 'you are reading out from under that tab — close the book first.';
}

export async function rotateGenerated(dir: string, file: string): Promise<Rotation | null> {
  const target = path.join(dir, GENERATED, file);
  if (!await exists(target)) return null;

  let movedTo: string | null = null;
  let movedTree: ProjectWorkingTree | null = null;
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
      // Kept whole, so a run that never writes can put the row back exactly as
      // it was. Its `generation` and its member order are not derivable from
      // anything on the disk — they are the catalogue's own record — and a
      // restored tree missing them is a book whose undo history is orphaned.
      movedTree = tree;
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
  // A document moved out of the live layer and into an archive folder, which is
  // a listing that has changed even though nothing was made.
  announceProjects();
  // The receipt: where it went (so a run whose own input is the copy being
  // replaced can read it there — see `planTranslation`) and what it took with
  // it (so a run that never writes can put it back — see `restoreRotation`).
  return movedTo === null ? null : { file, movedTo, tree: movedTree };
}

/**
 * Put a rotation back, because the run it was made for never wrote anything.
 *
 * ── The invariant this exists to keep ───────────────────────────────────────
 *
 * A GENERATE THAT FAILS OR IS CANCELLED LEAVES THE CATALOGUE EXACTLY AS IT WAS.
 *
 * It used not to. The rotation happened when the job was PLANNED — before it was
 * even enqueued, let alone run — and the new file was recorded only on success.
 * So a run that failed at the first page, or one the user cancelled, or one that
 * sat held and was removed, left the previous output sitting in
 * `generated/archived-<stamp>/` with the chain pointing at it and nothing in
 * `generated/` at all. Home went on listing the document, opening it went on
 * working, and the file it opened was silently the PREVIOUS run's output,
 * forever, with nothing anywhere saying a rotation had happened for a run that
 * never produced anything.
 *
 * ── What it puts back ───────────────────────────────────────────────────────
 *
 * The file, the working tree beside it, the step's location in the chain, and
 * the tree's catalogue row — which is why `Rotation` carries the row whole
 * rather than a flag: `generation` and the member order are the catalogue's own
 * record and cannot be re-derived from a directory.
 *
 * NOTHING IS DELETED BY A RESTORE, and the empty archive folder is removed only
 * if it IS empty — a stamp is per second and a sibling rotated in the same
 * instant is somebody else's record.
 *
 * A failure here is a console line rather than a throw. It runs on the way out
 * of a job that has already failed, and the second failure worth reporting is
 * the one the user asked about; this one is named in full in the terminal.
 */
export async function restoreRotation(dir: string, rotation: Rotation): Promise<void> {
  try {
    const back = path.join(dir, GENERATED, rotation.file);
    if (await exists(back)) {
      // Something is in the live slot. That can only be the very output this
      // rotation was making room for, which means the run DID write — so there
      // is nothing to undo and putting the old copy over it would destroy the
      // new one.
      return;
    }
    if (await exists(rotation.movedTo)) await fsp.rename(rotation.movedTo, back);

    const archive = path.dirname(rotation.movedTo);
    const tree = rotation.tree;
    if (tree !== null) {
      const parked = path.join(archive, `working-${tree.dir}`);
      const home = path.join(dir, WORKING, tree.dir);
      if (await exists(parked) && !await exists(home)) await fsp.rename(parked, home);
    }

    await withManifest(dir, async (manifest) => {
      const from = `${GENERATED}/${rotation.file}`;
      const moved = path.relative(dir, rotation.movedTo).split(path.sep).join('/');
      const record = manifest.documents.find((row) => row.steps.some((s) => s.file === moved));
      if (record !== undefined) {
        record.steps = record.steps.map(
          (step) => (step.file === moved ? { ...step, file: from } : step));
      }
      if (tree !== null && !manifest.working.trees.some((row) => row.from === from)) {
        manifest.working.trees = [...manifest.working.trees, tree];
      }
      await writeManifest(dir, manifest);
    });

    try {
      if ((await fsp.readdir(archive)).length === 0) await fsp.rmdir(archive);
    } catch { /* somebody else's rotation shares the folder, or it is already gone */ }
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${rotation.file} was moved aside for a run that did not write, and could not be `
      + `put back (${(err as Error).message}). It is in ${rotation.movedTo}; nothing was deleted.`,
    );
  }
}

/**
 * The bank a translation wrote, as a step param — or nothing, said as nothing.
 *
 * PROJECT-RELATIVE WITH FORWARD SLASHES, which is what `LedgerStep.payload` is and
 * what everything that reaches a file from a step splits again. The job holds the
 * absolute path it handed a child process, so the conversion happens here, once,
 * where the project directory has just been proved.
 *
 * A PATH OUTSIDE THE PROJECT IS RECORDED AS NOTHING rather than stored as it is.
 * Nothing composes one today — `bankForTranslation` builds every bank under
 * `readings/` — but a step carrying an absolute path, or one climbing out with
 * `..`, would be a row naming a file this project does not own and a sweep aiming
 * at somebody else's disk. The honest answer for a bank this app cannot place is
 * the one a translation made before banks were recorded gives: no claim at all.
 */
function bankParam(dir: string, bank: string | undefined): LedgerParams {
  if (bank === undefined || bank.trim().length === 0) return {};
  const inside = path.relative(dir, path.resolve(bank));
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside)) return {};
  return { bank: inside.split(path.sep).join('/') };
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
  /**
   * What the LEDGER needs, which the per-type chain has never had to know.
   *
   * Both fields exist because the alternative is reading a fact out of a
   * filename. A translation's output is called `<book> (en).epub`, and the
   * language is legible in those parentheses — which is exactly the basename
   * matching this codebase's oldest house rule forbids, and which `migrateLedger`
   * refuses to do even at the cost of leaving old translations unlabelled. The
   * job knows what it asked for; it hands it over rather than writing it into a
   * name for something else to read back out.
   */
  landed: {
    /** The position when the job was ENQUEUED. See `Job.parentStep`. */
    parentStep?: string | null;
    /** `TranslateRequest.to`, as the dialog named it. */
    language?: string;
    /**
     * `TranslateRequest.bankPath`, ABSOLUTE, as the engine was given it.
     *
     * Recorded as `params.bank` so this row can be rendered from and re-translated
     * into for the rest of its life. Absolute here and project-relative in the
     * step, because the job holds a path it handed a child process and the ledger
     * holds project-relative payloads — the one conversion happens here, where the
     * project directory has just been proved, rather than in a queue that would
     * have to work out which project a path is in.
     */
    bank?: string;
    /**
     * `TranslateRequest.stepId` — the step the output and the bank were named
     * after, minted at the plan (`bankForTranslation`).
     *
     * A branching translation writes `generated/<book> (en).<id8>.epub`, and the
     * `id8` is the front of this uuid. Landing under a freshly minted id would
     * leave both files named after a row nobody created. Spent only on an append,
     * which is `LandedRun.id`'s own rule.
     */
    stepId?: string;
  } = {},
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
      /*
       * ── AND A LEDGER STEP, FOR A TRANSLATION AND NOTHING ELSE ────────────────
       *
       * The four roles that reach here are not four of a kind. A cast EPUB, a
       * reprinted PDF and a text emission are RENDERINGS: three ways of writing
       * out one bank of answers, free to make again, reproducible from a payload
       * that is already a step. Minting a step for each would put three filenames
       * where one action belongs, and would offer the user a delete button for
       * something that costs nothing to have back. A translation is not that — it
       * is hours of a model over every block of the book, and what it leaves
       * behind is the only copy of that work.
       *
       * That is the settled rule stated as code, and it is the same rule
       * `migrateLedger` applies to an old catalogue: translations become steps,
       * renderings do not.
       */
      let landing: Landing | null = null;
      /** The bank the step named BEFORE this landing, for the displacement below. */
      let bankWas: string | null = null;
      if (role === 'translation') {
        const before = ledgerOf(manifest);
        landing = await landStep(manifest, {
          action: 'translate',
          parent: landed.parentStep ?? null,
          payload: `${GENERATED}/${file}`,
          /*
           * WHAT WAS ASKED AND WHAT THE RUN WROTE, in one bag and sorted by
           * `MINTED_BY_THE_RUN` rather than by this call site.
           *
           * `language` is the question — it is the whole of what makes this
           * translation this one, and it decides whether the next translation from
           * this step replaces this row or branches beside it. `bank` is the
           * answer: the file the run filled, recorded so that rendering from this
           * row reads the blocks this row was made of. Composing that path later
           * from the key and the tag is the lie `readings/<key>.jsonl` was for
           * readings — one name per book, and two rows both claiming it.
           *
           * Absent rather than empty when the caller did not say. An empty language
           * would be this app claiming to know a fact it does not, and `labelFor`
           * already prints the plain word for a step that says nothing about
           * itself — which is what a migrated translation gets too.
           */
          params: { ...translatedInto(landed.language), ...bankParam(dir, landed.bank) },
          createdAt: Date.now(),
          // Minted at the plan and written into two filenames since
          // (`bankForTranslation`); spent here, and only if this appends.
          ...(landed.stepId !== undefined ? { id: landed.stepId } : {}),
        });
        if (landing?.replaced === true) {
          bankWas = translationBankOf(
            before.steps.find((step) => step.id === landing?.step.id) ?? landing.step,
            manifest.key,
          );
        }
      }
      // WRITTEN BEFORE the live copy is refreshed, and that ordering is the
      // whole reason these are two writes. Refreshing can refuse — an archive
      // folder from this same second already exists — and a refusal that took
      // the origin's own catalogue row down with it would leave the engine's
      // output on disk, uncatalogued, invisible to Home.
      await writeManifest(dir, manifest);
      // After the write, never before: the replacement is on disk and recorded,
      // so whatever the swap displaced is now a file nothing in this project
      // names. Null on every ordinary re-translation, because the rotation
      // already moved the previous edition and the new one took its path.
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
      /*
       * AND THE BANK THE SWAP DISPLACED, on the same rule and for the same reason
       * `Landing.displaced` exists — it is simply not a payload, so the ledger
       * cannot be the one to notice.
       *
       * NULL ON EVERY ORDINARY RE-TRANSLATION: a replace was AIMED at the target
       * step's own bank before the job was enqueued (`bankForTranslation`), so the
       * path did not move and there is nothing left over. What makes this do real
       * work is the one case where it can — a run planned as a BRANCH, its files
       * minted with an `<id8>`, landing as a REPLACE because the pointer moved
       * between the plan and the press, or because the step it would have branched
       * beside was deleted while it ran. The row keeps its place and takes the new
       * bank; the old one is now a file no row in this project means, proved by the
       * whole path against every surviving step.
       */
      const bankNow = landing === null ? null : translationBankOf(landing.step, manifest.key);
      if (
        bankWas !== null
        && bankWas !== bankNow
        && !ledgerOf(manifest).steps.some((step) => translationBankOf(step, manifest.key) === bankWas)
      ) {
        await destroyPayload(dir, bankWas);
        for (const debris of pendingBeside(bankWas)) await destroyPayload(dir, debris);
      }
      if (role !== 'searchable') return null;
      const live = await refreshLivePdf(dir, manifest, file);
      await writeManifest(dir, manifest);
      return live;
    }).finally(announceProjects);
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
    announceProjects();
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
 * `<project>/overlays/` — what a PERSON decided about the blocks on the pages.
 *
 * A SIXTH SIBLING, on `history/`'s precedent and for its reasons: it is neither
 * an origin nor something the user asked to have written, and it belongs to THIS
 * BOOK and travels with it. Not in `readings/`, which is the model's own record
 * and is never edited by anything in this app — the entire design of the overlay
 * is that a correction is a second file rather than a rewrite of the evidence,
 * and filing the corrections inside the evidence would undo that on the disk if
 * not in the code.
 *
 * TWO FILES PER READING, both keyed by the bank's own key: `<key>.json` is the
 * curation and `<key>.ledger.json` is its undo history. They are together rather
 * than the ledger being in `history/` because they are ARCHIVED TOGETHER — a
 * re-read of the pages invalidates both in one instant, for one reason — and a
 * pair that has to be moved aside as a unit should not be a pair spread across
 * two directories with two archive folders and two ways for half the move to
 * fail. (`history/` keys by working TREE, which a scan does not have at all.)
 */
export function overlaysDir(dir: string): string {
  return path.join(dir, OVERLAYS);
}

/** Where a curation that is not this reading's goes. Nothing is deleted. */
export function overlayArchiveDir(dir: string): string {
  return stampedArchive(overlaysDir(dir));
}

/**
 * The generation the overlay and its ledger are bound to AT THIS PROJECT'S
 * POSITION, minting one if nothing has ever answered for this book.
 *
 * See `ProjectReading` for the hazard and `generationInEffect` for the whole of
 * the rule; this is the half that touches disk. The short version: re-RENDERING a
 * bank leaves every block exactly where it was, re-READING it renumbers all of
 * them, and only the second may throw a curation aside.
 *
 * IT ASKS THE STEP, and it used to count `readings/archived-<stamp>/` folders.
 * The engine no longer archives a bank at all — it swaps a finished pending one
 * into place — so the count stopped moving on the exact event it existed to
 * notice, and a re-read asking a different page range branches to a bank of its
 * own without ever having archived anything either. The read step's
 * `params.generation` is the authority now, taken from the nearest reading on the
 * position's ancestry so that standing on either branch of a book compares an
 * overlay against the pass it was made from.
 *
 * THE MARKER IS READ INSIDE THE LOCK, with the manifest that decides which bank
 * to read it for. Outside it, the position could move between the two and this
 * would compare one reading's completion against another reading's record — which
 * is precisely the disagreement it is here to detect, arriving from nowhere.
 *
 * A WRITE IS THE UNUSUAL PATH and stays that way: a project whose step already
 * carries a generation and a marker stamp that still matches the disk is answered
 * without touching the file, which is what makes this affordable in front of every
 * block-editor open.
 */
export async function readingGeneration(dir: string): Promise<string> {
  return withManifest(dir, async (manifest) => {
    const ruling = generationInEffect(
      ledgerOf(manifest),
      manifest.reading,
      await markerStamp(readingBank(dir, manifest)),
      // Minted before it is known to be wanted, because `shared/ledger.ts` has no
      // randomness by design (see its header) and a uuid costs nothing. The ruling
      // says whether it was spent — the same arrangement `LandedRun.id` uses.
      randomUUID(),
    );
    if (ruling.ledger === null && ruling.reading === null) return ruling.generation;
    if (ruling.ledger !== null) manifest.ledger = ruling.ledger;
    if (ruling.reading !== null) manifest.reading = ruling.reading;
    await writeManifest(dir, manifest);
    return ruling.generation;
  });
}

/**
 * A reading FINISHED — the one moment anything can honestly say a bank is done.
 *
 * WHERE THE GENERATION IS MINTED, and it is the natural place: a landing is a
 * bank that is on disk and was not before, so it is the event a generation is
 * about. `generationForLanding` states the rule and its one exception — a first
 * read adopts a generation somebody's first touch minted while it was still
 * running, so corrections made against the pages already read survive the run
 * finishing. Everything else mints: a re-read swapped in over the old bank, a
 * branch beside it, and a first read nobody watched.
 *
 * IT USED TO ASK `readingGeneration`, which answered from a count of archived
 * banks and so kept the id whenever nothing had archived. Nothing archives now
 * (docs/BANK-LIFECYCLE.md §2), and that function has become a question about
 * where the user is STANDING rather than about what just landed — the two are
 * different questions and a landing is not a viewer.
 *
 * FIRST-TOUCH MINTING STILL EXISTS, in `readingGeneration`, because it has to: a
 * bank filled by `foundry vlm-read` from a terminal, or one adopted from the old
 * flat layout, is complete and this app never saw it happen. Opening the block
 * editor on one of those mints an id there, under the same rule.
 *
 * A failure is a console line and never a throw. This runs after a job that may
 * have taken three hours, and a catalogue row that could not be written is not a
 * reason to report those hours as a failure — the bank is on disk either way, and
 * the completion marker beside it is what a listing falls back to.
 */
export async function recordReading(
  readingsPath: string,
  /**
   * WHAT THE RUN WAS ASKED FOR — the two fields of `ReadRequest` the person
   * filled in — handed over rather than inferred from what came back.
   *
   * It is what decides whether the next reading of this book REPLACES this step
   * or branches beside it (`MINTED_BY_THE_RUN`), and nothing on disk can answer
   * it afterwards: a bank does not record which pages it was told to leave out,
   * and working that out from the gaps in a file would be the same species of
   * guess as reading a language out of a filename. The job knows what it asked;
   * it says so, exactly as the translation hands over its `--to`.
   *
   * Defaulted so that a caller with nothing to say — a reading recorded by a
   * build that predates this, or one adopted from outside the queue — records a
   * reading of the whole book with no language declared, which is the plain
   * question and the one a migrated project asks too.
   */
  asked: ReadAsk = {},
  /**
   * THE STEP THIS BANK WAS NAMED AFTER, when the plan minted one.
   *
   * A branching re-read writes `readings/<key>.<id8>.jsonl`, and the `id8` in that
   * filename is the front of the step's uuid — decided at the plan, hours before
   * this runs (`bankForReading`). Landing under a freshly minted id would leave the
   * file named after a row that does not exist, so the id travels with the job
   * (`ReadRequest.stepId`) and is spent here.
   *
   * Absent for a job from a build that predates the field, and unused whenever
   * this landing turns out to be a replace: `LandedRun.id` is spent only on an
   * append, and a replace swaps a payload into the step that is already there.
   */
  stepId?: string,
): Promise<void> {
  const resolved = path.resolve(readingsPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} is outside any project, so no reading was recorded.`);
    return;
  }
  try {
    const pages = await countLines(resolved);
    /*
     * THE MARKER FOR THE BANK THIS RUN WROTE, and not for the position's. They
     * are usually one file and are not always: a branch lands beside the reading
     * somebody is standing on. The step records the completion of its OWN bank,
     * which is the only thing a later "has this been read again behind our back?"
     * can honestly compare against.
     */
    const completedAt = await markerStamp(resolved);
    await withManifest(dir, async (manifest) => {
      const generation = generationForLanding(
        ledgerOf(manifest),
        manifest.reading,
        completedAt,
        randomUUID(),
      );
      manifest.reading = {
        generation,
        readAt: Date.now(),
        pages,
        ...(completedAt !== null ? { completedAt } : {}),
      };
      /*
       * ── AND THE READ STEP, WHICH IS THE SAME FACT IN THE OTHER RECORD ────────
       *
       * `manifest.reading` above says which reading the block editor's live
       * corrections are bound to — one per project, replaced in place, a fact
       * about NOW. The ledger says what has been done to this book and what each
       * of those left behind, and it keeps every one of them. Both are written
       * from the same values in the same instant precisely so they cannot come to
       * disagree about a book. (`readingGeneration` reads the STEP first, and the
       * project record only for a project that has no read step at all — but a
       * step can be deleted, and the record left behind should still be about the
       * reading that happened rather than about one before it.)
       *
       * ITS PARENT IS THE IMPORT AND NOT THE POSITION, which is the one action
       * where those differ — see `originOf`. A reading reads the PIXELS, and the
       * pixels are in `archive/` however far through their own history the person
       * pressing OCR happens to be standing. Parented at the position it would
       * append a reading made FROM a reading the moment anybody re-read a book
       * while looking at it, and every one of those steps would name the single
       * bank file the engine writes.
       *
       * WHAT WAS ASKED FOR IS RECORDED SEPARATELY FROM WHAT CAME BACK, and the
       * two piles decide different things. `generation`, `pages` and `completedAt`
       * are the run's own answer — one minted by the pass, one counted off the
       * finished bank, one read off the marker the engine left beside it — and all
       * three are excluded from the re-run comparison (`MINTED_BY_THE_RUN`): a
       * re-read mints a new generation by design, so comparing it would make every
       * re-read look like a new question and leave the project holding two banks
       * where the user asked for one. The page skips and the language are the
       * QUESTION, so they are what decides append-or-replace, and a re-read of the
       * same request replaces while one asking for a different range branches.
       *
       * A REPLACE STALES EVERYTHING DOWNSTREAM, which `recordLanding` does: the
       * saves made against the previous bank name blocks by numbers that mean
       * different blocks now, and the translations of those saves were of blocks
       * that have moved. They stay in the list, dimmed and clickable, because each
       * still has its own payload and that payload is still a true record of
       * something.
       */
      const landing = await landStep(manifest, {
        action: 'read',
        parent: originOf(ledgerOf(manifest))?.id ?? null,
        /*
         * WHERE THE ENGINE ACTUALLY WROTE, and not a path composed from the key.
         *
         * It used to be `readings/<key>.jsonl` spelled out here, which was true
         * while a project had one bank and became a lie the moment a re-read could
         * branch into a bank of its own. The run was handed a path
         * (`bankForReading`) and filled that file; the step is the record of what
         * that run produced, so it names the file the run produced. A composed path
         * would be this function's second opinion about a decision made hours ago.
         *
         * Spelled with forward slashes and relative to the project, which is what
         * `LedgerStep.payload` is and what `destroyPayload` splits again to reach
         * the file — so nothing here ever matches by basename.
         */
        payload: path.relative(dir, resolved).split(path.sep).join('/'),
        // `askedOf` trims and drops, so that "asked for nothing" has ONE spelling
        // here and at the plan that named the bank. Two spellings would be two
        // questions to `reRunTarget` — the same book read twice, branching because
        // one of them recorded the empty string somebody's cursor left behind.
        params: {
          generation,
          pages,
          // Absent rather than 0 for a run whose marker could not be read: see
          // `readReading` for why those two are different statements, and
          // `generationInEffect` for what an absent one means to the next reader.
          ...(completedAt !== null ? { completedAt } : {}),
          ...askedOf(asked),
        },
        createdAt: Date.now(),
        ...(stepId !== undefined ? { id: stepId } : {}),
      });
      await writeManifest(dir, manifest);
      /*
       * The swap has landed, so the file the old step named may go — and only now.
       *
       * NULL IS STILL THE ORDINARY ANSWER and now for the right reason. It used to
       * be null because every reading composed one path, so a re-read wrote where
       * the previous one had and there was nothing left to unlink; it is null today
       * because a replace was AIMED at the target step's own payload before the job
       * was enqueued (`bankForReading`), so the path genuinely did not move.
       *
       * WHAT MAKES IT DO REAL WORK is the one case where a path can drift between
       * the plan and the landing: a run planned as a branch — its bank minted as
       * `readings/<key>.<id8>.jsonl` — landing as a replace, because the step it
       * would have branched beside was deleted while it ran, or because another
       * reading of the same question landed first. The step keeps its place and
       * takes the new path, and the bank it used to name is now a file no row in
       * this project points at. `namesPayload` is what proves that, by the whole
       * project-relative path, before a byte is destroyed.
       */
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
    });
    // The one that puts the waiting light out. Home and the dock are drawn from
    // the listing, and until this is heard they both go on asking for a step
    // that has just been taken.
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${path.basename(dir)} could not record its reading (${(err as Error).message}). `
      + 'The bank is on disk and the engine\'s completion marker is beside it, which is what the '
      + 'library screen falls back to.',
    );
  }
}

/**
 * The engine's completion marker for one bank: `<bank>.completed.json`, beside it
 * and named for it.
 *
 * SPELLED HERE RATHER THAN IMPORTED, and that is the rule rather than an
 * oversight — this app never imports the engine, it spawns it. The engine's own
 * `completionMarkerPath` (src/vlm/readings.ts) composes exactly this, and the
 * paragraph above it says why the name has to come off the BANK rather than off
 * its directory: one `readings/` folder held two books' banks once, one marker
 * sat in it, and the run asked about the other book archived a finished bank and
 * paid for a hundred pages again.
 */
function completionMarkerFor(bankPath: string): string {
  return `${path.resolve(bankPath).replace(/\.jsonl$/i, '')}.completed.json`;
}

/**
 * When the run that filled this bank said it finished — epoch milliseconds — or
 * null when nothing beside the bank says.
 *
 * ── What this is for, and why a number ──────────────────────────────────────
 *
 * It is the only fact on disk that moves when a bank is READ AGAIN and stays put
 * when one is merely re-rendered, now that no bank is ever archived. A run swaps
 * its finished pending bank into place and writes a fresh marker; a Generate
 * touches neither. So the stamp recorded beside a generation and the stamp on
 * disk disagreeing is exactly "these are different answers about the same pages",
 * which is what the generation exists to notice (`generationInEffect`).
 *
 * `completedAt` IS AN ISO STRING IN THE FILE and a number here. The engine writes
 * an instant, and an instant compared as text is a comparison that a change of
 * timezone spelling or of trailing zeros could break — `Date.parse` gives the
 * milliseconds back exactly, and epoch milliseconds is what every other time in
 * this catalogue already is.
 *
 * NULL FOR EVERY KIND OF SILENCE: no marker, unreadable, not JSON, no
 * `completedAt`, or one that is not a date. All of them mean the same thing to
 * the caller — there is no evidence here — and the caller's answer to no evidence
 * is to leave the generation exactly as it stands. A marker this app cannot read
 * must never be allowed to invent a re-read that did not happen.
 */
async function markerStamp(bankPath: string): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = readJson(await fsp.readFile(completionMarkerFor(bankPath), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const said = (parsed as Record<string, unknown>)['completedAt'];
  if (typeof said !== 'string') return null;
  const at = Date.parse(said);
  return Number.isNaN(at) ? null : at;
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
      // Nothing can be said about the reading of a project whose catalogue will
      // not parse, and "OCR this" is a suggestion — lighting it here would be
      // offering a next step for a folder this app cannot describe.
      reading: { done: false, needed: false, pages: 0 },
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
    reading: await readingState(dir, manifest),
    filed: manifest.final.length > 0,
    problem: null,
  };
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
async function readingState(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectSummary['reading']> {
  const recorded = manifest.reading !== null && manifest.reading.readAt > 0;
  const banked = path.join(dir, READINGS, `${manifest.key}.jsonl`);
  const done = recorded
    // `completionMarkerFor` rather than the name composed a second time here: two
    // spellings of one file is two answers the day either of them changes.
    || await exists(completionMarkerFor(banked))
    /*
     * AND A BANK WITH ANSWERS IN IT, which is the third source and the one the
     * legacy libraries need.
     *
     * `adoptLegacyBanks` deliberately does NOT carry the old flat
     * `completed.json` across, and it is right not to: that marker sat in a
     * folder shared by every book on the machine and belonged to whichever run
     * happened to finish last, so copying it into a project would tell the
     * engine a half-read book was finished. The consequence was that an adopted
     * bank of three hundred paid-for pages read as "not read yet": no Generate,
     * and an OCR light asking the user to buy them again.
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
    needed: !done && manifest.archive?.kind === 'pdf',
    pages: recorded ? manifest.reading?.pages ?? 0 : 0,
  };
}

/** Is there a file there with anything in it? Missing and empty are one answer. */
async function hasBytes(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).size > 0;
  } catch {
    return false;
  }
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
     * under the project, not a count of distinct decisions. The archived overlays
     * it already walks overlap each other the same way — each is a whole copy of
     * the state at the time it was set aside. What the figure conveys is how much
     * recorded judgement is in this folder, and every one of those files is a
     * separate thing that will not exist afterwards.
     */
    amendments: await countAmendments(overlaysDir(resolved))
      + await countAmendments(curationsDir(resolved)),
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
async function countAmendments(dir: string): Promise<number> {
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
 *
 * THE OVERLAY AND ITS LEDGER (`overlays/<key>.json`), and this is the bank's rule
 * carried one step further. A curation is not about the EPUB — it is about the
 * READING, which is why it is keyed by the bank rather than by any output: the
 * two hundred running heads somebody struck are struck for the text emission and
 * for every future cast of the book as much as for the one being deleted. And
 * deleting an output in order to make a better one is the ordinary reason to
 * delete an output, which is exactly the case where destroying the corrections
 * would be worst. By the retention rule they are `irreplaceable` where the bank
 * is merely `expensive`; a project delete takes them, says so in those words, and
 * nothing else does.
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
          /*
           * AND IT BECOMES THE ARCHIVE, which this path used to leave null —
           * and that omission made the adoption lie twice.
           *
           * `archive/` is where every other part of this app looks for A BOOK'S
           * PAGES. `planReading` reads it, and with none recorded it fell back
           * to whatever document the user was pointing at — which after this
           * promotion is the reprint itself, so ordering OCR read a reading of a
           * reading and spent the GPU-hours to produce nothing new. And
           * `readingState` asks the archive's kind to decide whether a book has
           * pages worth reading at all, so the project sat there with no waiting
           * light and no way to get one.
           *
           * THE PROVENANCE IS DETERMINABLE HERE, which is the whole reason this
           * is allowed to write an archive at all: every file this path can find
           * was written when `--format pdf` laid an invisible text layer over
           * the pages it was given, so the promoted file IS the scan, pixels and
           * all. Nothing else in the app ever composes a path into `archive/`;
           * this does, once, for the one document whose only copy it is.
           *
           * A COPY AND NOT A MOVE: the live PDF must stay live. And if the copy
           * fails the promotion is refused rather than half-made, which is the
           * ruling — a project with a live PDF and no archive is exactly the
           * state this exists to stop creating.
           */
          if (manifest.archive === null) {
            await fsp.mkdir(path.join(dir, ARCHIVE), { recursive: true });
            await fsp.copyFile(destination, path.join(dir, ARCHIVE, file));
            manifest.archive = {
              file,
              kind: 'pdf',
              contentKey: hex.toLowerCase(),
              // Where it came from is genuinely unknown: the flat workspace held
              // outputs and never recorded an input. Null is the honest answer
              // and is what a project adopted from that layout has always said.
              originPath: null,
            };
            recordStep(manifest, 'pdf', {
              file: `${ARCHIVE}/${file}`,
              label: 'The scan you imported',
              appliedAt: Date.now(),
              kind: 'origin',
              retention: 'irreplaceable',
              why: WHY_IMPORTED,
            }, { onlyIfEmpty: true });
          }
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
