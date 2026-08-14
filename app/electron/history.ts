/**
 * history — the undo ledger, on disk, beside the book it describes.
 *
 * The ledger itself is the renderer's (src/app/core/tabs.service.ts): an action
 * numbers a batch, a row names one element and one field, and an undo is the
 * setter that made the edit called again with the old value. None of that
 * changes here. What changes is that the stacks USED TO END WITH THE PROCESS —
 * "a document's history is kept while it is open and ends when it closes" — and
 * Owen asked for the other thing: open a project, edit a file, have Foundry die
 * randomly, and still be able to press Ctrl+Z.
 *
 * ── Where it lives ───────────────────────────────────────────────────────────
 *
 *   <project>/history/<working tree name>.json
 *
 * IN THE PROJECT, beside the book, on the same argument `readings/` moved in on:
 * this is bookkeeping in the abstract and somebody's work in practice, and a
 * history in userData is a history severed from its book the moment the library
 * folder moves. KEYED BY THE WORKING TREE — `workingTreeName(entry)`, the same
 * name the directory under `working/` carries — because that name is derived
 * from the origin the tree was unpacked from and is therefore the same string in
 * every session. It is emphatically NOT the runtime book id, which is a uuid
 * minted per open: a file named after one of those is a file the next launch
 * cannot find, which is the same thing as having no file at all.
 *
 * ONE FILE PER WORKING COPY, therefore, and not one per tab — which is right,
 * because the working copy is what the rows are about. Two tabs onto one tree
 * (the same book reached both as the file the user dropped and as the copy Home
 * lists, which is the case `heldTrees` is counted for) share the file and the
 * last flush wins. They are one document being edited through two windows; a
 * history each would be two accounts of one book's edits, and the loser would
 * still be the one nobody could see.
 *
 * ── When it is written ───────────────────────────────────────────────────────
 *
 * After every mutation of either stack — a recorded action, an undo, a redo, and
 * the footnote dialog's unrecord. The whole file, every time, ATOMICALLY through
 * `writeAtomically`: temp file beside the target, then rename. That is not
 * belt-and-braces. "Flush on every change" plus a crash mid-write is precisely
 * the case this feature exists for, and a half-written history that survives a
 * crash would be worse than none — it would be a stack whose last row is a
 * truncated JSON object, discovered by the next open.
 *
 * Whole-file and not an append log because the writes are infrequent BY NATURE:
 * one per gesture, not one per keystroke. A person curating hard makes a few a
 * minute, and a few kilobytes of JSON rewritten a few times a minute is nothing.
 * An append format would buy nothing and would need its own compaction, its own
 * torn-record rule, and its own reader.
 *
 * ── THE HAZARD, which is why there is a generation at all ────────────────────
 *
 * A row names `data-bf-id="p47-3"` in a member. THAT NAME IS ONLY MEANINGFUL FOR
 * THE WORKING COPY IT WAS RECORDED AGAINST. "Start over" rebuilds `working/`
 * from `generated/`; a re-cast reassigns ids; either way `p47-3` afterwards is
 * whatever the new pass called the third stamped element on page 47. A row from
 * a previous life would then put a paragraph into a block that is not the one it
 * came from — the one failure mode that is worse than having no undo at all,
 * because nothing on screen would say anything went wrong.
 *
 * So the ledger is BOUND TO A GENERATION of the working copy: a uuid minted by
 * `recordWorkingTree` whenever a tree is unpacked, recorded in `project.json`,
 * and stamped into the history file. On load the two are compared, and a history
 * that does not name this generation is not replayed.
 *
 * The per-row defences already in `epub-reader.ts` help and are not duplicated
 * here: `restoreBlockHtml` makes its mirror check and refuses when the file
 * moved underneath, and `setBlockCuts`/`setBlockCategories` refuse an absent or
 * duplicated id BY NAME. A stale row mostly refuses itself. The generation check
 * is what stops the class of stale row that would NOT refuse — the one whose id
 * still exists, on a different paragraph.
 *
 * ── And nothing is ever deleted ──────────────────────────────────────────────
 *
 * A history file is somebody's work. One that cannot be used is MOVED ASIDE into
 * `history/archived-<stamp>/`, exactly as `archiveReadingsBank` rotates a bank
 * (src/vlm/readings.ts) and as `rotateGenerated` rotates an origin — never
 * removed, never overwritten, and always named out loud in the notice strip so
 * that a Ctrl+Z which suddenly has nothing to reach says why (ARCHITECTURE §8).
 * If the move itself fails, this module REFUSES TO WRITE that file for the rest
 * of the session rather than letting the next save clobber what it could not
 * preserve.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { documentOf } from './epub-reader';
import { writeAtomically } from './epub-writer';
import { historyArchiveDir, historyDir, treeGeneration, workingTreeName } from './projects';
import type { DocumentHistory, LedgerAction, LedgerLoad, LedgerRow, LedgerStacks } from '../shared/types';

/** Refusals from this module, named so a caller can tell them from an fs error. */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

/** The schema this app writes and the only one it reads. */
const HISTORY_VERSION = 1;

/** The six routes a row can name. A file naming a seventh is a file from a future. */
const FIELDS: ReadonlySet<string> = new Set([
  'cut', 'category', 'html', 'note-cut', 'nav-label', 'page-heading',
]);

/**
 * Where one open book's ledger sits, and which life of that book it belongs to.
 *
 * Both facts come from main's own records — the registry says which project and
 * which origin, the catalogue says which generation — so the renderer names a
 * book and nothing else. It cannot ask for a path and it cannot assert a
 * generation, which is what keeps the check meaningful.
 */
interface LedgerLocation {
  file: string;
  generation: string;
  projectDir: string;
  entry: string;
}

async function locate(bookId: string): Promise<LedgerLocation> {
  const { projectDir, entry } = documentOf(bookId);
  return {
    file: path.join(historyDir(projectDir), `${workingTreeName(entry)}.json`),
    generation: await treeGeneration(projectDir, entry),
    projectDir,
    entry,
  };
}

/**
 * Files this session must not write, and why.
 *
 * Populated only when a history that had to be moved aside COULD NOT BE. The
 * next save would otherwise write straight over it — the archive having failed
 * is exactly the case where the original is still the only copy — so saving is
 * refused by name instead, for as long as the app is running. It clears itself
 * on the next launch, which is the right moment to try again.
 */
const unwritable = new Map<string, string>();

function key(file: string): string {
  return path.resolve(file).toLowerCase();
}

/**
 * Move a history aside and say where it went.
 *
 * Shares one `archived-<stamp>/` folder with any sibling archived in the same
 * instant, which is safe here in a way it is not for a readings bank: these
 * files are named per DOCUMENT, so two of them in one folder are two documents'
 * histories under two names rather than two books' answers under one. A
 * destination that already exists is still refused rather than overwritten.
 */
async function archiveAside(file: string, projectDir: string): Promise<string> {
  const folder = historyArchiveDir(projectDir);
  const destination = path.join(folder, path.basename(file));
  await fsp.mkdir(folder, { recursive: true });
  if (await exists(destination)) {
    throw new HistoryError(
      `${destination} already exists, so ${file} cannot be moved aside without writing over a `
      + 'history that is already there.',
    );
  }
  await fsp.rename(file, destination);
  return destination;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** A fresh pair of empty stacks. A shared constant would be one array two books held. */
function empty(): LedgerStacks {
  return { done: [], undone: [] };
}

/**
 * The ledger this document was left with, or nothing and the reason why.
 *
 * THE THREE OUTCOMES, and every one of them is normal:
 *
 *   the generation matches — both stacks come back, so Ctrl+Z works the moment
 *     the book opens and reaches the actions of the session before this one;
 *
 *   the generation differs — the rows name blocks in a working copy that no
 *     longer exists (a re-cast, a start-over), so the file is ARCHIVED ASIDE and
 *     this document starts fresh, with the notice naming the file and where it
 *     went;
 *
 *   it will not read, or it is not the shape this app writes — same treatment,
 *     same sentence, plus what was wrong with it. NEVER GUESSED AT: a
 *     half-written record is not a record, and a stack assembled out of the rows
 *     that happened to parse is a Ctrl+Z that replays some of an action.
 *
 * A file that is simply not there is the fourth case and is not an outcome at
 * all — it is what every document looks like before its first edit.
 */
export async function loadLedger(bookId: string): Promise<LedgerLoad> {
  const { file, generation, projectDir, entry } = await locate(bookId);

  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { actions: empty(), notice: null };
    // Present and unreadable is not "no history": something is there and this
    // app cannot see it, and it must not be written over on that basis.
    unwritable.set(key(file), (err as Error).message);
    return {
      actions: empty(),
      notice: `${file} holds this book's undo history and could not be read (${(err as Error).message}). `
        + 'Foundry is starting a fresh history for this session and will not write over that file.',
    };
  }

  let history: DocumentHistory;
  try {
    history = parseHistory(text);
  } catch (err) {
    return { actions: empty(), notice: await setAside(file, projectDir, (err as Error).message) };
  }

  if (history.generation !== generation) {
    return {
      actions: empty(),
      notice: await setAside(
        file,
        projectDir,
        `it was recorded against an earlier working copy of ${entry} (generation `
        + `${history.generation || 'unrecorded'}, and this one is ${generation}), so the blocks its `
        + 'rows name are not the blocks in the book on screen',
      ),
    };
  }

  const actions = history.done.length + history.undone.length;
  return {
    actions: { done: history.done, undone: history.undone },
    notice: actions === 0 ? null : `Undo history restored: ${describe(history.done.length, 'action')} `
      + `to undo and ${describe(history.undone.length, 'action')} to redo, from ${file}.`,
  };
}

/** "1 action" / "3 actions" — the count is the whole point of the sentence. */
function describe(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Archive the file and turn the whole business into one sentence.
 *
 * A FAILED ARCHIVE IS ALSO A SENTENCE, and it additionally locks the file: the
 * one thing that must not happen is the history quietly ceasing to exist because
 * neither the move nor the refusal was reported.
 */
async function setAside(file: string, projectDir: string, why: string): Promise<string> {
  try {
    const went = await archiveAside(file, projectDir);
    return `${file} holds an undo history Foundry cannot use — ${why}. It has been moved to ${went} `
      + '(nothing was deleted) and this book starts with a fresh history.';
  } catch (err) {
    unwritable.set(key(file), (err as Error).message);
    return `${file} holds an undo history Foundry cannot use — ${why} — and it could not be moved `
      + `aside either (${(err as Error).message}). Nothing has been deleted and nothing will be `
      + 'written over it: this book has no undo history this session.';
  }
}

/**
 * Read the file, or say exactly what about it is not a history.
 *
 * EVERY FIELD IS CHECKED, and a row that is short of one takes the whole file
 * down with it rather than being skipped. The rows of an action are one gesture:
 * sixteen blocks struck together go back together, and an action silently
 * missing its fourteenth row is an undo that leaves a chapter in a state nobody
 * ever typed. Refusing the file is recoverable — it is archived, it is still
 * there, and the book opens. Half-replaying it is not.
 */
function parseHistory(text: string): DocumentHistory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HistoryError(`it is not JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HistoryError('it is not an object, so it is not an undo history');
  }
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== HISTORY_VERSION) {
    throw new HistoryError(
      `it is version ${String(row['version'])} and this app writes version ${HISTORY_VERSION}`,
    );
  }
  if (typeof row['generation'] !== 'string' || row['generation'].length === 0) {
    throw new HistoryError('it names no working copy generation, so nothing says which book its rows are about');
  }
  return {
    version: HISTORY_VERSION,
    generation: row['generation'],
    document: typeof row['document'] === 'string' ? row['document'] : '',
    savedAt: typeof row['savedAt'] === 'number' ? row['savedAt'] : 0,
    done: readActions(row['done'], 'done'),
    undone: readActions(row['undone'], 'undone'),
  };
}

function readActions(value: unknown, stack: string): LedgerAction[] {
  if (!Array.isArray(value)) throw new HistoryError(`its "${stack}" stack is not a list`);
  return value.map((entry, at) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new HistoryError(`${stack}[${at}] is not an action`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['seq'] !== 'number' || !Number.isFinite(row['seq'])) {
      throw new HistoryError(`${stack}[${at}] carries no action number`);
    }
    if (typeof row['label'] !== 'string' || row['label'].length === 0) {
      // The label is what the notice strip says an undo undid. An action
      // without one could be replayed and could not be reported, and this app
      // does not do things it cannot name.
      throw new HistoryError(`${stack}[${at}] says nothing about what it did`);
    }
    if (!Array.isArray(row['rows']) || row['rows'].length === 0) {
      throw new HistoryError(`${stack}[${at}] moved nothing, so it is not an action`);
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
    throw new HistoryError(`${where} is not a row`);
  }
  const row = value as Record<string, unknown>;
  const field = row['field'];
  if (typeof field !== 'string' || !FIELDS.has(field)) {
    throw new HistoryError(`${where} names the field "${String(field)}", which no setter in this app answers to`);
  }
  for (const name of ['member', 'target', 'before', 'after'] as const) {
    if (typeof row[name] !== 'string') throw new HistoryError(`${where} carries no ${name}`);
  }
  return {
    member: row['member'] as string,
    target: row['target'] as string,
    field: field as LedgerRow['field'],
    before: row['before'] as string,
    after: row['after'] as string,
  };
}

/**
 * One document's writes, in order, one at a time.
 *
 * Each save carries the WHOLE ledger, so the only thing that matters is which
 * one lands last — and without a chain that is not settled by the order they
 * were asked for. Two flushes a few milliseconds apart (a cut, then the undo of
 * it) could interleave their temp file and their rename and leave the older
 * stack on disk under the newer one's name. A promise chain per file is the
 * smallest thing that makes that impossible.
 *
 * It also settles the temp file: `writeAtomically` writes `<target>.writing`,
 * which is one name, and two concurrent writers of one document would be two
 * writers of one temp file.
 */
const writes = new Map<string, Promise<unknown>>();

/**
 * Flush both stacks. Called after every mutation of either.
 *
 * The generation goes in as it is written rather than being trusted from the
 * renderer, which has never seen one — the file's binding to a working copy is
 * main's assertion about main's own catalogue, and a renderer that could name a
 * generation could name the wrong one.
 *
 * Rejects by name for a file this session refused to write over (see
 * `unwritable`), because "I could not preserve your old history" and "I have
 * therefore overwritten it" must not be the same event.
 */
export async function saveLedger(bookId: string, stacks: LedgerStacks): Promise<void> {
  const { file, generation, entry } = await locate(bookId);
  const blocked = unwritable.get(key(file));
  if (blocked !== undefined) {
    throw new HistoryError(
      `${file} already holds an undo history this app could not read or move aside (${blocked}), so `
      + 'it will not be written over. This session\'s undo history is in memory only.',
    );
  }

  const document: DocumentHistory = {
    version: HISTORY_VERSION,
    generation,
    document: entry,
    savedAt: Date.now(),
    done: stacks.done,
    undone: stacks.undone,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const mapKey = key(file);
  const previous = writes.get(mapKey) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed flush must not poison the ones queued behind it */ })
    .then(() => writeAtomically(file, bytes));
  writes.set(mapKey, next);
  return next;
}
