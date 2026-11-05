/**
 * projects-manifest — reading and writing a project's manifest and what it catalogues.
 */
import { constants as fsconst, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ConversionKind, MintContributor, MintMeta, ProjectGenerated, ProjectGeneratedRole, ProjectLedger, ProjectManifest, ProjectReading, ProjectTypeRecord } from '../shared/types';
import { spokenStem } from '../shared/documents';
import { readJson } from '../shared/json';
import type { ArchiveRecord } from '../shared/steps';
import { migrateToSteps, readTypeRecords } from '../shared/steps';
import { emptyLedger, migrateLedger, healReadParents, parseLedger } from '../shared/ledger';
import { GENERATED_ROLE_FOR } from '../shared/documents';
import { ARCHIVE, GENERATED, MANIFEST, MANIFEST_VERSION, ProjectError, contentKey } from './projects-paths';

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
export let notifyProjects: () => void = () => { /* set by main */ };

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
export function announceProjects(): void {
  notifyProjects();
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
    working: { files: readWorkingFiles(working['files']) },
    final: readFinal(row['final']),
    reading: readReading(row['reading']),
  };
  /*
   * CARRIED EXPLICITLY, because this function REBUILDS the manifest field by
   * field and a field it does not name is erased on the next write — the
   * validator-that-rebuilds trap `validRecipe` already fell into once
   * (capture.ts). A mint metadata that silently vanished after one save would
   * be the modal forgetting what the person confirmed, which is the exact
   * opposite of the inheritance it exists for.
   */
  const meta = readMintMeta(row['meta']);
  if (meta !== undefined) manifest.meta = meta;
  // LAST, because it is the only field built from the manifest rather than from
  // one of its rows: an un-migrated project's ledger is reconstructed out of the
  // archive, the reading and the chains that were read above it.
  manifest.ledger = readLedger(row['ledger'], manifest, file);
  return manifest;
}

/**
 * The mint metadata block, read leniently — a half-written or hand-mangled
 * block is treated as absent, which lands on the seed path rather than on a
 * refusal: the field informs a form, and a project that cannot open because
 * its metadata went strange would be the tail wagging the book.
 */
export function readMintMeta(value: unknown): MintMeta | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row['title'] !== 'string') return undefined;
  const contributors = Array.isArray(row['contributors'])
    ? row['contributors'].flatMap((one): MintContributor[] => {
      if (typeof one !== 'object' || one === null) return [];
      const author = one as Record<string, unknown>;
      const first = typeof author['first'] === 'string' ? author['first'] : '';
      const last = typeof author['last'] === 'string' ? author['last'] : '';
      return first || last ? [{ first, last }] : [];
    })
    : [];
  const text = (field: unknown): string | undefined =>
    typeof field === 'string' && field.length > 0 ? field : undefined;
  return {
    title: row['title'],
    contributors,
    ...(text(row['subtitle']) !== undefined ? { subtitle: text(row['subtitle'])! } : {}),
    ...(text(row['year']) !== undefined ? { year: text(row['year'])! } : {}),
    ...(text(row['language']) !== undefined ? { language: text(row['language'])! } : {}),
    ...(text(row['coverPath']) !== undefined ? { coverPath: text(row['coverPath'])! } : {}),
  };
}

/**
 * Record what the modal confirmed — the whole block, replaced. One writer, so
 * "what does this project say about itself" has one spelling on disk; read
 * back through `readManifest`'s own lenient reader on the next open.
 */
export async function recordMintMeta(dir: string, meta: MintMeta): Promise<void> {
  await withManifest(dir, async (manifest) => {
    manifest.meta = meta;
  });
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
export function readLedger(stored: unknown, manifest: ProjectManifest, file: string): ProjectLedger {
  if (stored === undefined) return migrateLedger(manifest);
  try {
    // The reparenting heal rides the same read: a captured project whose
    // reads were recorded against the photographs (the pre-2026-08-23
    // recorder) comes back telling the truth — see `healReadParents` — and
    // the correction reaches disk the next time anything edits the project,
    // exactly as this function's own header promises for every other heal.
    return healReadParents(parseLedger(stored));
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
export function readReading(value: unknown): ProjectReading | null {
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
export function readDocuments(
  row: Record<string, unknown>,
  archive: ProjectManifest['archive'],
): ProjectTypeRecord[] {
  const layers = { archive: ARCHIVE, generated: GENERATED };
  if (Array.isArray(row['documents'])) {
    return healImport(readTypeRecords(row['documents']), archive, layers);
  }
  return migrateToSteps(readGenerated(row['generated']), documentArchive(archive), layers);
}

/**
 * The archive AS A DOCUMENT, or nothing — the one narrowing, said once.
 *
 * ── Why a folder of pages is not a row in the catalogue ─────────────────────
 *
 * `documents` lists FILE TYPES, and every one of them is a thing this app can
 * open: a click on a row opens it, `originalOf` picks one to be the book, a
 * delete of one is a delete of a file. A minted pages directory is none of
 * those. Filing it as a document would put a row on Home whose path is a FOLDER,
 * and the first click on it would hand a directory to a PDF reader.
 *
 * NOTHING WRITES SUCH AN ARCHIVE ANY MORE (Wave 41): the mint files a PDF and
 * catalogues it exactly as an import does, and `healMintedArchive` gives one to
 * every project made before it. This narrowing survives as the transitional
 * guard for a project read between launch and its heal, and as the answer for
 * one that could not be healed — a folder is still not a document, however it
 * got there.
 */
export function documentArchive(archive: ProjectManifest['archive']): ArchiveRecord | null {
  if (archive === null || archive.kind === 'pages') return null;
  return { file: archive.file, kind: archive.kind };
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
export function healImport(
  records: ProjectTypeRecord[],
  archive: ProjectManifest['archive'],
  layers: { archive: string; generated: string },
): ProjectTypeRecord[] {
  const document = documentArchive(archive);
  if (document === null) return records;
  if (records.some((record) => record.kind === document.kind)) return records;
  return [...migrateToSteps([], document, layers), ...records];
}

export function readArchive(value: unknown): ProjectManifest['archive'] {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const file = row['file'];
  const kind = row['kind'];
  if (typeof file !== 'string') return null;
  if (kind !== 'pdf' && kind !== 'epub' && kind !== 'pages') return null;
  return {
    file,
    kind,
    contentKey: typeof row['contentKey'] === 'string' ? row['contentKey'] : '',
    originPath: typeof row['originPath'] === 'string' ? row['originPath'] : null,
  };
}

export function readGenerated(value: unknown): ProjectGenerated[] {
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

export function isGeneratedRole(value: unknown): value is ProjectGeneratedRole {
  return value === 'cast' || value === 'imported' || value === 'translation'
    || value === 'searchable' || value === 'text';
}

/*
 * `readTrees` IS GONE, AND AN OLD CATALOGUE'S `working.trees` IS SIMPLY NOT READ.
 *
 * The unpacked-EPUB working tree is deleted (docs/RENDERER.md §7): nothing
 * unpacks, nothing holds a tree, nothing sweeps one. The parser is a whitelist
 * rebuild rather than a mutation, so a field it stops naming never reaches the
 * in-memory catalogue and is dropped from disk the next time anything writes for
 * a reason of its own — exactly the precedent `ProjectReading.passes` set. NO
 * VERSION BUMP: a v2 catalogue carrying `working.trees` still parses, because the
 * version gate names versions and never keys.
 *
 * What stays under `working/` is the PDF's live copy — a different tenant of the
 * same folder, and the one the metadata dialog writes into.
 */
export function readWorkingFiles(value: unknown): ProjectManifest['working']['files'] {
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

export function readFinal(value: unknown): ProjectManifest['final'] {
  if (!Array.isArray(value)) return [];
  const files: ProjectManifest['final'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const kind = row['kind'];
    if (typeof file !== 'string') continue;
    if (kind !== 'epub' && kind !== 'pdf' && kind !== 'txt') continue;
    /*
     * THE STEP THIS EXPORT WAS MADE FROM, where a row has one. Rows written
     * before the field existed simply do not, and nothing is invented for them:
     * an unknown provenance is a true statement (`ProjectFinal.stepId`), and a
     * guess here would be this parser asserting a history the catalogue never
     * recorded. Spread conditionally so an old row round-trips byte for byte
     * rather than gaining an `undefined` the writer would then serialise away.
     */
    const stepId = row['stepId'];
    files.push({
      file,
      kind,
      madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0,
      ...(typeof stepId === 'string' && stepId.length > 0 ? { stepId } : {}),
    });
  }
  return files;
}

/** Write the catalogue. Whole-file, small, and the only writer of this shape. */
export async function writeManifest(dir: string, manifest: ProjectManifest): Promise<void> {
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
export const edits = new Map<string, Promise<unknown>>();

export function withManifest<T>(dir: string, work: (manifest: ProjectManifest) => Promise<T>): Promise<T> {
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
export function withCreatedProject<T>(
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
          working: { files: [] },
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
export async function copyNewOnly(from: string, to: string): Promise<boolean> {
  try {
    await fsp.copyFile(from, to, fsconst.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function exists(target: string): Promise<boolean> {
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
export const GENERATED_EXTENSIONS: Readonly<Record<ConversionKind, string>> = {
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
export const GENERATED_ROLES = GENERATED_ROLE_FOR;

/** `Working Towards The Fuhrer. Kershaw, Ian. (1993).epub` — the book's own name. */
export function generatedFileFor(stem: string, kind: ConversionKind): string {
  return `${stem}${GENERATED_EXTENSIONS[kind]}`;
}

export function generatedRoleFor(kind: ConversionKind): ProjectGeneratedRole {
  return GENERATED_ROLES[kind];
}
