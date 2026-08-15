/**
 * overlays — the block editor's two files, on disk, beside the book they describe.
 *
 *   <project>/overlays/<key>.json          what a person decided about the blocks
 *   <project>/overlays/<key>.ledger.json   the undo history of those decisions
 *
 * This module is `history.ts` for a SCAN, and it is written to that file's
 * discipline deliberately: whole-file atomic writes after every change, a
 * generation the file is bound to, a mismatch archived aside rather than
 * replayed, a refusal to write over anything it could not preserve, and every one
 * of those outcomes reported as a sentence naming the file. Where it differs from
 * `history.ts` it differs for a reason, and the reasons are here.
 *
 * ── What it is keyed by, and why that is not a working tree ─────────────────
 *
 * A book's undo history is keyed by its WORKING TREE, because a row names
 * `data-bf-id="p47-3"` in an unpacked EPUB and that name means one thing in one
 * tree. A scan has no tree. What it has is a READINGS BANK — the model's answers,
 * `readings/<key>.jsonl` — and a row here names `7:14`, the fourteenth element of
 * the model's answer for page 7. So both files are keyed by the bank's key, which
 * is the project's key, which is derived from the content of the imported file
 * and is therefore the same string in every session on every machine.
 *
 * ── And bound to a READING rather than to a tree ────────────────────────────
 *
 * The hazard is the same one and it is worth restating because it is the whole
 * reason this module has more code than a JSON reader. `(page, order, part)`
 * survives a re-RENDER of a bank — the answers are replayed verbatim, the split
 * is deterministic — and does not survive a re-READ, which archives the bank and
 * asks the model again. After a re-read, `{"page": 7, "order": 14}` is whatever
 * the new pass answered fourteenth. An overlay from the previous life would
 * strike a paragraph nobody struck and divide the book in a place nobody chose,
 * WITH NOTHING ON SCREEN SAYING SO. That is the only failure mode worse than
 * losing the curation, so `projects.readingGeneration` mints an id that changes
 * exactly when a bank is archived, both files carry it, and a file that names a
 * different one is not read.
 *
 * ── The pair moves together ─────────────────────────────────────────────────
 *
 * The curation and its undo history are invalidated by one event, in one instant,
 * for one reason. So they live in one directory and are archived into ONE
 * `overlays/archived-<stamp>/` together. A ledger left behind beside a fresh
 * overlay would be a Ctrl+Z offering to take back amendments that are no longer
 * in the file.
 *
 * ── And nothing is ever deleted ─────────────────────────────────────────────
 *
 * A curation is a person looking at four hundred pages and saying what is on
 * them. By the retention rule (`ProjectStep.retention`) it is `irreplaceable` —
 * not merely expensive like the bank, which a machine can read again — and it is
 * the training data this project will one day want most. A file that cannot be
 * used is MOVED ASIDE and named out loud; if the move itself fails, this module
 * refuses to write that file for the rest of the session rather than letting the
 * next save clobber what it could not preserve.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { writeAtomically } from './epub-writer';
import { overlayArchiveDir, overlaysDir, projectDirOf, readManifest, readingGeneration } from './projects';
import {
  OverlayError,
  emptyOverlay,
  overlayFate,
  overlayText,
  parseOverlay,
  type OverlayFile,
} from '../shared/overlay';
import { readJson } from '../shared/json';
import type { LedgerAction, LedgerLoad, LedgerRow, LedgerStacks, OverlayLoad } from '../shared/types';

/** The ledger schema this module writes and the only one it reads. */
const LEDGER_VERSION = 1;

/**
 * The four routes a block-editor row can name.
 *
 * `history.ts` keeps its own set of six for the same reason and it is worth
 * saying once more: a file naming a field no setter answers to is a file from a
 * future, and handing it to a replay that would fall through every branch is an
 * undo that reports success and does nothing.
 */
const FIELDS: ReadonlySet<string> = new Set([
  'strike', 'block-category', 'block-text', 'chapters',
]);

/** Where one scan's two files sit, and which reading they belong to. */
export interface OverlayLocation {
  file: string;
  ledger: string;
  /**
   * The readings bank these amendments are about.
   *
   * Composed here rather than by `workspace.planConversion`, which is the other
   * place that names it: that function IMPORTS the document as a side effect —
   * it is how a project comes to exist — and asking "which blocks are on these
   * pages" must not create a folder. Same two components, same answer, and the
   * key comes from the same catalogue.
   */
  readings: string;
  /** The archived original the bank was read from, or null for a legacy project. */
  source: string | null;
  generation: string;
  projectDir: string;
  key: string;
}

/**
 * The paths for a PDF the app has open.
 *
 * THE RENDERER NAMES A DOCUMENT AND NOTHING ELSE, exactly as it does for a
 * book's history: where the files are and which reading they belong to are main's
 * own records. A renderer that could assert a generation could assert the wrong
 * one, and the check would mean nothing.
 *
 * Refuses by name for a path outside every project. That is not a hostile caller
 * — it is somebody who opened a scan from their own Downloads folder, which this
 * app is happy to show and has no bank for, so there is nothing to curate and the
 * sentence says which.
 */
export async function locateOverlay(pdfPath: string): Promise<OverlayLocation> {
  /*
   * TWO REFUSALS, BECAUSE THEY ARE TWO SITUATIONS AND ONE SENTENCE WAS WRONG FOR
   * BOTH OF THEM.
   *
   * This said "Convert it first" for every path outside `projects/`, which is
   * the answer to a question nobody had asked. A document outside the library is
   * one the app has not imported — usually because the import is still running
   * behind the tab that opened, occasionally because it failed — and telling
   * that person to convert their book sends them to a dialog that will convert
   * something they already have. What they need to know is that this file is not
   * in the library yet.
   *
   * The other case is the real "not read yet", and it has its own door: the
   * project exists, the bank does not, and the fix is one press of OCR.
   */
  const projectDir = projectDirOf(pdfPath);
  if (projectDir === null) {
    throw new OverlayError(
      `${pdfPath} is not in Foundry's library, so there is nothing behind it to correct yet. `
      + 'Foundry imports a document it opens from elsewhere and then works on its own copy — if '
      + 'that has not happened, opening the file again from Home will land on the copy.',
    );
  }
  const manifest = await readManifest(projectDir);
  const key = manifest.key;
  const archived = manifest.archive?.kind === 'pdf' ? manifest.archive.file : null;
  const readings = path.join(projectDir, 'readings', `${key}.jsonl`);
  // The pages have not been read. Said as itself rather than as "convert it
  // first": there is a project, there is a scan in it, and the one step between
  // this person and a page full of outlined blocks is the one the dock is
  // already lighting.
  if (!await exists(readings)) {
    throw new OverlayError(
      `${path.basename(pdfPath)} has not been read yet, so there are no blocks to correct. `
      + 'Press OCR to read its pages — everything else in Foundry is built on what that produces.',
    );
  }
  const folder = overlaysDir(projectDir);
  return {
    file: path.join(folder, `${key}.json`),
    ledger: path.join(folder, `${key}.ledger.json`),
    readings,
    /**
     * THE PDF THE BANK WAS READ FROM, which is not the one the tab is showing.
     *
     * `vlm-blocks` only needs a PDF for a bank written before runs recorded the
     * size they rendered each page at — and then it measures every page again to
     * put the boxes in a frame. Handed the WORKING PDF it would measure whatever
     * that is now, and after a real-text rendering that document is type on
     * blank paper: same page count, same sizes, none of the ink. The boxes would
     * come back plausible and silently wrong, and the first thing anybody would
     * do with them is strike a paragraph.
     *
     * `archive/` is written once at import and never again, so it is the one
     * copy that is certainly the pages the model was shown. Null for a legacy
     * project that has no archive, and then the caller passes what it has.
     */
    source: archived === null ? null : path.join(projectDir, 'archive', archived),
    generation: await readingGeneration(projectDir),
    projectDir,
    key,
  };
}

/**
 * Files this session must not write, and why. See `history.ts` — same map, same
 * rule, and it clears itself on the next launch, which is the right moment to try
 * again.
 */
const unwritable = new Map<string, string>();

function key(file: string): string {
  return path.resolve(file).toLowerCase();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move both files aside into one `archived-<stamp>/` and say where they went.
 *
 * BOTH, in one folder, in one call: they are one curation and one account of how
 * it was made. A destination that already exists is refused rather than written
 * over — the stamp is per second, and two archives in one second would otherwise
 * merge two readings' work under one name.
 */
async function archiveAside(where: OverlayLocation): Promise<string> {
  const folder = overlayArchiveDir(where.projectDir);
  await fsp.mkdir(folder, { recursive: true });
  for (const source of [where.file, where.ledger]) {
    if (!await exists(source)) continue;
    const destination = path.join(folder, path.basename(source));
    if (await exists(destination)) {
      throw new OverlayError(
        `${destination} already exists, so ${source} cannot be moved aside without writing over a `
        + 'curation that is already there.',
      );
    }
    await fsp.rename(source, destination);
  }
  return folder;
}

/**
 * Archive the pair and turn the whole business into one sentence.
 *
 * A FAILED ARCHIVE IS ALSO A SENTENCE, and it locks both files: the one thing
 * that must not happen is a person's corrections quietly ceasing to exist because
 * neither the move nor the refusal was reported.
 */
async function setAside(where: OverlayLocation, why: string): Promise<string> {
  try {
    const went = await archiveAside(where);
    return `${where.file} holds corrections Foundry cannot use — ${why}. They have been moved to `
      + `${went} (nothing was deleted) and this book starts with a clean overlay.`;
  } catch (err) {
    unwritable.set(key(where.file), (err as Error).message);
    unwritable.set(key(where.ledger), (err as Error).message);
    return `${where.file} holds corrections Foundry cannot use — ${why} — and they could not be `
      + `moved aside either (${(err as Error).message}). Nothing has been deleted and nothing will `
      + 'be written over them: this book has no curation this session.';
  }
}

/**
 * The curation this scan was left with, or a clean one and the reason why.
 *
 * The three outcomes are `loadLedger`'s, and every one of them is normal: the
 * generation matches and the work comes back; it does not, and the file is
 * archived aside; it will not parse, and the same. A file that is simply not
 * there is the fourth case and is not an outcome at all — it is what every scan
 * looks like before its first correction.
 */
export async function loadOverlayFile(pdfPath: string): Promise<OverlayLoad> {
  const where = await locateOverlay(pdfPath);

  let text: string;
  try {
    text = await fsp.readFile(where.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: emptyOverlay(where.generation), notice: null };
    }
    // Present and unreadable is not "no curation": something is there, this app
    // cannot see it, and it must not be written over on that basis.
    unwritable.set(key(where.file), (err as Error).message);
    return {
      file: emptyOverlay(where.generation),
      notice: `${where.file} holds this book's block corrections and could not be read `
        + `(${(err as Error).message}). Foundry is starting a clean overlay for this session and `
        + 'will not write over that file.',
    };
  }

  let file: OverlayFile;
  try {
    file = parseOverlay(text, where.file);
  } catch (err) {
    return {
      file: emptyOverlay(where.generation),
      notice: await setAside(where, (err as Error).message),
    };
  }

  const fate = overlayFate(file.generation, where.generation);
  if (!fate.use) {
    return {
      file: emptyOverlay(where.generation),
      notice: await setAside(where, fate.why),
    };
  }
  return { file, notice: null };
}

/**
 * One document's writes, in order, one at a time — `history.ts`'s promise chain,
 * and for its reasons.
 *
 * Each save carries the WHOLE file, so the only thing that matters is which lands
 * last, and without a chain that is not settled by the order they were asked for.
 * Two strikes a few milliseconds apart could interleave their temp file and their
 * rename and leave the older curation on disk under the newer one's name.
 */
const writes = new Map<string, Promise<unknown>>();

function serialise<T>(file: string, work: () => Promise<T>): Promise<T> {
  const mapKey = key(file);
  const previous = writes.get(mapKey) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed write must not poison the ones queued behind it */ })
    .then(work);
  writes.set(mapKey, next);
  return next;
}

function refuseIfLocked(file: string, what: string): void {
  const blocked = unwritable.get(key(file));
  if (blocked === undefined) return;
  throw new OverlayError(
    `${file} already holds ${what} this app could not read or move aside (${blocked}), so it will `
    + 'not be written over. This session\'s work is in memory only.',
  );
}

/**
 * Write the curation. Called after every gesture that changes one.
 *
 * THE GENERATION IS MAIN'S, always, and is stamped over whatever the renderer
 * sent. The renderer has never computed one and could not check one; the file's
 * binding to a reading is main's assertion about main's own catalogue, and a
 * renderer that could name a generation could name a stale one and resurrect the
 * exact failure this whole module exists to prevent.
 */
export async function saveOverlayFile(pdfPath: string, file: OverlayFile): Promise<void> {
  const where = await locateOverlay(pdfPath);
  refuseIfLocked(where.file, 'block corrections');
  // Round-tripped through the reader before a byte is written. The renderer is
  // the only writer and it writes through `shared/overlay.ts`, so this can only
  // fail if this app has a bug — which is exactly when writing the file would be
  // worst, because the engine refuses a malformed overlay and the run that
  // discovers it is three hours long.
  const bytes = Buffer.from(overlayText({ ...file, generation: where.generation }), 'utf8');
  parseOverlay(bytes.toString('utf8'), where.file);
  await fsp.mkdir(overlaysDir(where.projectDir), { recursive: true });
  await serialise(where.file, () => writeAtomically(where.file, bytes));
}

// ─────────────────────────────────────────────────────────────────────────────
// The undo ledger for those corrections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stacks this scan's block editor was left with.
 *
 * The overlay's own load has already decided whether this reading's files are
 * usable and archived them if not, so by the time anything asks for the ledger
 * the pair is either both current or both gone. This still checks the generation
 * for itself rather than trusting that ordering: a ledger is read once per open
 * and a check that depends on a call site's sequence is a check that stops being
 * true the first time somebody reorders two lines.
 */
export async function loadOverlayLedger(pdfPath: string): Promise<LedgerLoad> {
  const where = await locateOverlay(pdfPath);

  let text: string;
  try {
    text = await fsp.readFile(where.ledger, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { actions: empty(), notice: null };
    unwritable.set(key(where.ledger), (err as Error).message);
    return {
      actions: empty(),
      notice: `${where.ledger} holds the undo history of this book's block corrections and could `
        + `not be read (${(err as Error).message}). Foundry is starting a fresh one and will not `
        + 'write over that file.',
    };
  }

  let history: { generation: string; done: LedgerAction[]; undone: LedgerAction[] };
  try {
    history = parseLedger(text);
  } catch (err) {
    return { actions: empty(), notice: await setAside(where, (err as Error).message) };
  }

  const fate = overlayFate(history.generation, where.generation);
  if (!fate.use) {
    return { actions: empty(), notice: await setAside(where, fate.why) };
  }

  const actions = history.done.length + history.undone.length;
  return {
    actions: { done: history.done, undone: history.undone },
    notice: actions === 0 ? null
      : `Block corrections history restored: ${describe(history.done.length, 'action')} to undo and `
        + `${describe(history.undone.length, 'action')} to redo, from ${where.ledger}.`,
  };
}

export async function saveOverlayLedger(pdfPath: string, stacks: LedgerStacks): Promise<void> {
  const where = await locateOverlay(pdfPath);
  refuseIfLocked(where.ledger, 'an undo history');
  const document = {
    version: LEDGER_VERSION,
    generation: where.generation,
    overlay: path.basename(where.file),
    savedAt: Date.now(),
    done: stacks.done,
    undone: stacks.undone,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await fsp.mkdir(overlaysDir(where.projectDir), { recursive: true });
  await serialise(where.ledger, () => writeAtomically(where.ledger, bytes));
}

function empty(): LedgerStacks {
  return { done: [], undone: [] };
}

/** "1 action" / "3 actions" — the count is the whole point of the sentence. */
function describe(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Read the ledger, or say exactly what about it is not one.
 *
 * EVERY FIELD IS CHECKED and a row that is short of one takes the whole file down
 * rather than being skipped, for `history.ts`'s reason: the rows of an action are
 * one gesture — sixteen blocks struck together go back together — and an action
 * silently missing its fourteenth row is an undo that leaves a curation in a
 * state nobody ever made.
 */
function parseLedger(text: string): { generation: string; done: LedgerAction[]; undone: LedgerAction[] } {
  let parsed: unknown;
  try {
    parsed = readJson(text);
  } catch (err) {
    throw new OverlayError(`it is not JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OverlayError('it is not an object, so it is not an undo history');
  }
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== LEDGER_VERSION) {
    throw new OverlayError(
      `it is version ${String(row['version'])} and this app writes version ${LEDGER_VERSION}`,
    );
  }
  if (typeof row['generation'] !== 'string' || row['generation'].length === 0) {
    throw new OverlayError('it names no reading generation, so nothing says which blocks its rows are about');
  }
  return {
    generation: row['generation'],
    done: readActions(row['done'], 'done'),
    undone: readActions(row['undone'], 'undone'),
  };
}

function readActions(value: unknown, stack: string): LedgerAction[] {
  if (!Array.isArray(value)) throw new OverlayError(`its "${stack}" stack is not a list`);
  return value.map((entry, at) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new OverlayError(`${stack}[${at}] is not an action`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['seq'] !== 'number' || !Number.isFinite(row['seq'])) {
      throw new OverlayError(`${stack}[${at}] carries no action number`);
    }
    if (typeof row['label'] !== 'string' || row['label'].length === 0) {
      throw new OverlayError(`${stack}[${at}] says nothing about what it did`);
    }
    if (!Array.isArray(row['rows']) || row['rows'].length === 0) {
      throw new OverlayError(`${stack}[${at}] moved nothing, so it is not an action`);
    }
    return {
      seq: row['seq'],
      label: row['label'],
      rows: row['rows'].map((candidate, index) => readRow(candidate, `${stack}[${at}].rows[${index}]`)),
    };
  });
}

function readRow(value: unknown, where: string): LedgerRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OverlayError(`${where} is not a row`);
  }
  const row = value as Record<string, unknown>;
  const field = row['field'];
  if (typeof field !== 'string' || !FIELDS.has(field)) {
    throw new OverlayError(`${where} names the field "${String(field)}", which no setter in this app answers to`);
  }
  for (const name of ['member', 'target', 'before', 'after'] as const) {
    if (typeof row[name] !== 'string') throw new OverlayError(`${where} carries no ${name}`);
  }
  return {
    member: row['member'] as string,
    target: row['target'] as string,
    field: field as LedgerRow['field'],
    before: row['before'] as string,
    after: row['after'] as string,
  };
}
