/**
 * shared/ops — the OP GRAMMAR, and the one replay every surface reads the book
 * through.
 *
 * ── What an op is, and why there is exactly one of them per decision ────────
 *
 * *"we should still operate off of a ledger-based system, and when the changes
 * are saved/committed, we could produce a new, second bank with the
 * updates/changes."* (docs/RENDERER.md §0, ruling 5.) An op is one decision about
 * one BLOCK ID: strike this paragraph, put these words in it, call it a Quote.
 * A step's payload is a JSONL file of them and it is a DELTA — never cumulative —
 * so standing anywhere in the history means replaying the ops of every edit step
 * on the path from the reading to where you stand, in order, over the book file
 * that reading produced (docs/RENDERER.md §3).
 *
 * ONE STRIKE LIVES IN EXACTLY ONE PLACE. Today the same decision lives in four —
 * the frame's DOM, spliced XHTML in `working/`, `overlays/<key>.json` and a
 * curation snapshot — and every guard in this app exists to reconcile them
 * (docs/RENDERER.md §1). Here it is a line in a file, keyed by an id the engine
 * minted and never reuses, and the thing on screen is a pure function of the
 * book file and that list.
 *
 * ── Why the replay is PURE, and why it lives in shared/ ─────────────────────
 *
 * `shared/ledger.ts`'s reason, one document down. Two readers must agree to the
 * character: the renderer draws `replayOps(...)` as a computed signal, and
 * materialisation (R5) writes the derived book file out of the same call. Two
 * implementations of "what does this book say now" is the failure the whole
 * design is arranged to make impossible — so there is one, it takes rows and
 * ops and returns rows, and it touches no disk, no clock and no Electron.
 *
 * ── THE FOUR OPS THIS WAVE PERFORMS, AND THE REST NAMED BY THE WAVE THAT WILL ─
 *
 * `strike`, `restore`, `text` and `category` are implemented here. Every other
 * shape in §3's table is DECLARED — so that R4 grows into this file rather than
 * beside it — and is REFUSED BY NAME, both by the parser and by the replay. That
 * is not defensive coding: nothing in this app can have minted one, so meeting a
 * `merge` in a file means the file was written by a build from the future, and
 * the honest thing to do with a book somebody edited with a later Foundry is to
 * say so rather than to draw two thirds of their work.
 *
 * ── LAST OP WINS, and it is the rule rather than a tolerance ────────────────
 *
 * A chain is a list of deltas in the order the person made them, and a person
 * genuinely does strike a paragraph, apply, restore it, apply, and strike it
 * again. That is three steps, three files and three ops naming one id, and
 * replaying them in order gives the state they left it in. So `strike` of an
 * already-struck row and `restore` of an unstruck one are ordinary rather than
 * refusals: the last op to name an id is what that id says, which is what
 * "replay a delta chain" means, and any other rule would make a legal history
 * unloadable.
 */

import type { BookLoose, BookRef, BookRow } from './book';
import { printedNoteNumber, superscriptRuns } from './inline';

/** Refusals from this module, named so a caller can tell them from anything else. */
export class BookOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookOpsError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The grammar — docs/RENDERER.md §3, in full
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strike a block: it stays in the document and is drawn cancelled.
 *
 * A STATE AND NOT A REMOVAL, which is the landed rule (RENDERER-DESIGN.md §3):
 * the workbench draws the proofreader's cancel over it always — struck is a state
 * of the document, not of a mode — and the EDITION leaves it out. Nothing is lost
 * by striking and nothing has to be found again to restore it.
 */
export interface StrikeOp {
  op: 'strike';
  id: string;
}

/** Un-strike a block. The other half of `strike`, and its exact inverse. */
export interface RestoreOp {
  op: 'restore';
  id: string;
}

/**
 * Replace a block's text with this string.
 *
 * THE SOURCE STRING, inline markers and all. A block's text keeps the model's own
 * markup — `*italics*`, superscript reference numbers — and the renderer draws it
 * through the same inline rules the emitter uses, so a text edit edits what the
 * model answered rather than a rendering of it (docs/RENDERER.md §2). Rich
 * WYSIWYG editing of the markup is deferred out loud (§10).
 */
export interface TextOp {
  op: 'text';
  id: string;
  text: string;
}

/** Say what kind of block this is — the engine's spelling, `Text`, `Quote`. */
export interface CategoryOp {
  op: 'category';
  id: string;
  category: string;
}

/** R4: absorb `id` into `into`, which keeps its own id and its own place. */
export interface MergeOp {
  op: 'merge';
  id: string;
  into: string;
}

/** R4: cut `id` in two at a character offset, minting `<id>/1` and `<id>/2`. */
export interface SplitOp {
  op: 'split';
  id: string;
  at: number;
}

/** R4: reading-order repair — put `id` immediately before `before`. */
export interface MoveOp {
  op: 'move';
  id: string;
  before: string;
}

/**
 * R4: where the book divides, and what that division is called.
 *
 * `set` IS THE ONLY VERB SPELLED, deliberately. §3's table names four more —
 * move, remove, rename, reset — and none of them has a wire shape yet. Inventing
 * one here would be this file deciding a format R4 has to live with, and the
 * whole reason the grammar is declared ahead of its implementation is so that
 * the decisions are made where the gestures are.
 */
export interface ChapterOp {
  op: 'chapter';
  set: string;
  title: string;
}

/** R4: bind a reference number in the prose to a note, by hand. */
export interface LinkOp {
  op: 'link';
  block: string;
  at: number;
  len: number;
  note: string;
}

/** R4: put a running head the reflow shelved back into the flow. */
export interface RestoreFurnitureOp {
  op: 'restore-furniture';
  src: string;
}

export type BookOp =
  | StrikeOp
  | RestoreOp
  | TextOp
  | CategoryOp
  | MergeOp
  | SplitOp
  | MoveOp
  | ChapterOp
  | LinkOp
  | RestoreFurnitureOp;

/** The ops this build performs. Everything else is refused by name. */
const PERFORMED = ['strike', 'restore', 'text', 'category'] as const;

/**
 * WHICH WAVE OWES EACH OF THE OTHERS, so a refusal can say more than "no".
 *
 * A table rather than one sentence for all of them, because a person meeting this
 * is holding a file a later Foundry wrote and the useful fact is which part of
 * that Foundry they need — and because the day one of these lands, the entry that
 * has to be deleted is in the same place as the parser that stops refusing it.
 */
const OWED_BY: Readonly<Record<string, string>> = {
  merge: 'the structure ops',
  split: 'the structure ops',
  move: 'the structure ops',
  chapter: 'the structure ops',
  link: 'the structure ops',
  'restore-furniture': 'the structure ops',
};

/** Every op word this grammar declares — performed and declared-only alike. */
const DECLARED: ReadonlySet<string> = new Set([...PERFORMED, ...Object.keys(OWED_BY)]);

/**
 * The sentence for an op this build knows the name of and cannot perform.
 *
 * NO FILENAME AND NO WAVE NUMBER — the house rules on both. "R4" is this
 * project's bookkeeping and means nothing to somebody looking at a book that will
 * not open; what they need is which capability is missing.
 */
function refuseUnperformed(kind: string, where: string): never {
  const owed = OWED_BY[kind];
  throw new BookOpsError(
    owed === undefined
      ? `${where} is "${kind}", which is not a change this program knows how to make.`
      : `${where} is "${kind}". This book carries a change of a kind this build cannot replay — `
        + `${owed} are not in it yet — and drawing the book without that change would show you `
        + 'a document nobody edited.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The file: one op per line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ops → the bytes of a step's payload.
 *
 * ONE LINE PER OP AND A TRAILING NEWLINE, which is what makes the format append-
 * friendly and diffable and is the same shape the engine writes its banks and its
 * book files in. The key order is the declaration's order because a file that
 * spelled one op two ways would be two files as far as anything comparing them is
 * concerned.
 */
export function formatOpsFile(ops: readonly BookOp[]): string {
  return ops.map((op) => JSON.stringify(op)).join('\n') + (ops.length === 0 ? '' : '\n');
}

/**
 * The bytes back → ops, or a refusal naming the line and the field.
 *
 * ONE BAD LINE TAKES THE WHOLE FILE DOWN, on `parseBookFile`'s argument and for a
 * sharper version of its reason. This file is the record of decisions somebody
 * made about their book; a list assembled out of the lines that happened to parse
 * is a book with somebody's strikes silently missing from it, and they would go on
 * editing a document that is not the one their history says they made. A sentence
 * naming the line costs a reload.
 *
 * Blank lines are skipped rather than refused: they are whitespace in a
 * line-oriented format, and the engine's own parsers skip them too.
 */
export function parseOpsFile(text: string): BookOp[] {
  const ops: BookOp[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    ops.push(opOf(line, index + 1));
  }
  return ops;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or null. Ids, categories, op words. */
function nameOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One line, field by field. `at` is its line number, for a line with no op word. */
function opOf(line: string, at: number): BookOp {
  const where = `change ${at} in this book's history`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new BookOpsError(`${where} is not JSON (${(err as Error).message}).`);
  }
  const row = objectOf(parsed);
  if (row === null) throw new BookOpsError(`${where} is not an object, so it is not a change.`);

  const kind = nameOf(row['op']);
  if (kind === null) {
    throw new BookOpsError(`${where} does not say what kind of change it is.`);
  }
  if (!DECLARED.has(kind)) refuseUnperformed(kind, where);
  if (!(PERFORMED as readonly string[]).includes(kind)) refuseUnperformed(kind, where);

  const id = nameOf(row['id']);
  if (id === null) {
    throw new BookOpsError(`${where} names no block, and a block's name is the whole of what a change is about.`);
  }
  switch (kind) {
    case 'strike':
      return { op: 'strike', id };
    case 'restore':
      return { op: 'restore', id };
    case 'category': {
      const category = nameOf(row['category']);
      if (category === null) {
        throw new BookOpsError(`${where} relabels "${id}" as nothing, and every block is some kind of block.`);
      }
      return { op: 'category', id, category };
    }
    default: {
      /*
       * AN EMPTY STRING IS A LEGAL TEXT and `nameOf` is deliberately not used
       * here. Somebody who selected a paragraph and deleted its words has said
       * something — an empty block is a block with nothing in it, which the
       * workbench draws and the edition keeps — and refusing it would make the
       * one edit nobody can undo by typing into the only edit this format cannot
       * record.
       */
      const words = row['text'];
      if (typeof words !== 'string') {
        throw new BookOpsError(`${where} puts something that is not words into "${id}".`);
      }
      return { op: 'text', id, text: words };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One block after the chain — the file's row, plus what the ops made of it.
 *
 * A ROW AND NOT A WRAPPER, so that everything already written against `BookRow`
 * (the pane's `Line`, the export's projection) goes on working and reads the
 * derived state as one extra field. The rows a chain never named are the very
 * objects the parser produced, untouched, which is what keeps a replay over a
 * four-hundred-page book with six ops in it from allocating a second book.
 */
export interface ReplayedRow extends BookRow {
  /**
   * Struck: in the document, drawn cancelled, absent from the edition.
   *
   * Only ever `true` — an unstruck row simply does not carry the field, which is
   * `LedgerStep.stale`'s rule and for its reason: a boolean that is only ever one
   * value says what it means where it is read, and leaves the ordinary case
   * looking ordinary.
   */
  struck?: true;
}

/** An op naming a block the book does not hold — reported, never guessed at. */
export interface MissingOp {
  /** The op itself, so a surface can say what was being asked. */
  op: BookOp;
  /** The block it named. */
  id: string;
}

/** The book after a chain: the rows, what could not be found, and what came loose. */
export interface Replayed {
  rows: ReplayedRow[];
  /**
   * Ops that named blocks this book does not hold.
   *
   * REPORTED, NEVER GUESSED AT, and never fatal to the rest of the replay
   * (docs/RENDERER.md §3). The state it describes is real and recoverable: a bank
   * read again mints ids for blocks the model answered differently, so a chain
   * from before can name paragraphs that are genuinely not there any more. The
   * honest answer is to replay everything that still lands and to say plainly that
   * some of it did not — a replay that refused would make the whole book
   * unopenable over one stale strike, and one that silently dropped them would let
   * somebody go on editing while their history quietly stopped applying.
   */
  missing: MissingOp[];
  /**
   * The apparatus that does not join up, after the edits — the file's own record
   * with every edited block's share of it re-derived.
   *
   * The two LINKING flags are the only flags this app keeps (docs/RENDERER.md §0,
   * ruling 7), and a text edit is the one gesture that can create either of them:
   * delete a reference number and its note is pointed at by nothing; type one that
   * matches no note and it is a number carrying nothing.
   */
  loose: BookLoose;
}

/** Nothing unlinked — the answer for a book whose header said so and whose ops changed no text. */
const NOTHING_LOOSE: BookLoose = { markers: [], notes: [] };

/**
 * The book, with a chain of ops replayed over it.
 *
 * ── The order of operations, and why it is one pass and not four ────────────
 *
 * The ops are folded into a per-id STATE first — struck or not, the newest text,
 * the newest category — and the rows are rebuilt from that state once. That is
 * what makes "last op wins" true by construction rather than by a rule somebody
 * has to remember: a fold has no history, so a chain of six strikes and five
 * restores of one id is exactly as expensive and exactly as correct as one op.
 *
 * ── And then, only for the blocks somebody actually retyped, the markers ────
 *
 * A text edit invalidates every `BookRef` offset into that block, and shifting
 * them would be a guess about which side of the edit a marker fell on. So the
 * edited blocks — and ONLY the edited blocks — are re-scanned for superscript
 * runs and rebound to the notes whose original refs named them, by printed
 * number, claim-once, in reading order (`rebind` below). Every untouched block
 * keeps the file's refs verbatim, which matters more than it looks: those offsets
 * were resolved by the engine with the page in front of it, and re-deriving them
 * everywhere would quietly replace the engine's answer with this one.
 */
export function replayOps(
  rows: readonly BookRow[],
  ops: readonly BookOp[],
  /**
   * The file's own record of unlinked apparatus (`BookHeader.loose`).
   *
   * IT IS AN INPUT BECAUSE IT IS STATE THE EDITS CHANGE. A marker the engine
   * could not match sits at an offset inside a block, exactly as a bound one
   * does, so an edit to that block invalidates it the same way — and a replay
   * that could not see it would either lose the flag or leave it pointing at
   * characters that have moved. Defaulted for a caller with nothing to say
   * (a test, a projection over rows alone), which is the honest answer for
   * "this book records no unlinked apparatus".
   */
  loose: BookLoose = NOTHING_LOOSE,
): Replayed {
  const held = new Map(rows.map((row) => [row.id, row] as const));
  const struck = new Set<string>();
  const texts = new Map<string, string>();
  const categories = new Map<string, string>();
  const missing: MissingOp[] = [];

  for (const op of ops) {
    if (!(PERFORMED as readonly string[]).includes(op.op)) {
      refuseUnperformed(op.op, 'a change in this book\'s history');
    }
    // Every performed op is keyed by `id` alone, which is what §3 means by "keyed
    // by block id only" — the ops that name two blocks are all in R4's half.
    const id = (op as StrikeOp | RestoreOp | TextOp | CategoryOp).id;
    if (!held.has(id)) {
      missing.push({ op, id });
      continue;
    }
    /*
     * NO `default`, and the refusal above is why there is nothing for one to do:
     * every op word that reaches this line is one of the four, so a fall-through
     * is unreachable and a branch written for it would be a branch nothing can
     * ever prove. The day a fifth op is performed, its case goes here and its name
     * comes out of `OWED_BY` — two edits, in one file, that a compiler will not
     * let anybody make only half of.
     */
    switch (op.op) {
      case 'strike': struck.add(id); break;
      case 'restore': struck.delete(id); break;
      case 'text': texts.set(id, op.text); break;
      case 'category': categories.set(id, op.category); break;
    }
  }

  /*
   * WHICH BLOCKS WERE GENUINELY RETYPED, which is not the same as which blocks a
   * `text` op named. A chain that set a block's words and then set them back is a
   * chain that changed nothing about that block, and re-deriving its markers would
   * throw away the engine's own offsets in exchange for this file's guess at them
   * — for an edit that never happened.
   */
  const edited = new Set<string>();
  for (const [id, text] of texts) {
    if (held.get(id)!.text !== text) edited.add(id);
  }

  const replayed = new Map<string, ReplayedRow>();
  const out: ReplayedRow[] = [];
  for (const row of rows) {
    const text = texts.get(row.id);
    const category = categories.get(row.id);
    const cancelled = struck.has(row.id);
    const made: ReplayedRow = text === undefined && category === undefined && !cancelled
      ? row
      : {
        ...row,
        ...(text === undefined ? {} : { text }),
        ...(category === undefined ? {} : { category }),
        ...(cancelled ? { struck: true as const } : {}),
      };
    replayed.set(row.id, made);
    out.push(made);
  }

  if (edited.size === 0) return { rows: out, missing, loose };
  return { ...rebind(out, replayed, edited, loose), missing };
}

/**
 * The reference numbers of the edited blocks, resolved again from the words.
 *
 * ── The rule, which is the engine's own with one thing taken away ───────────
 *
 * `linkMarkers` (src/vlm/book-file.ts) matches a marker to a note by the PRINTED
 * NUMBER, on the marker's page or the page after it, first marker in reading order
 * claiming the note. This has no page to ask — the block's `parts` stopped being a
 * true division of its text the moment somebody retyped it — so the page test is
 * replaced by something stricter and better: the ONLY notes a run in this block may
 * bind to are the notes that already named this block. An edit cannot invent a link
 * that was not there; it can only keep one, or lose it.
 *
 * That is what makes the two flags honest. A run that matches none of those notes
 * is a number somebody typed or a number whose note the same edit renumbered, and
 * it goes in the margin as "no note carries this number". A note whose run is gone
 * from the block it named loses that ref, and a note left with no refs anywhere is
 * "nothing in the book carries this note". Both are the LINKING flags the app
 * keeps, arrived at from the one gesture that can create them.
 *
 * A FOOTNOTE ROW IS NEVER SCANNED, which is the engine's rule (`markersIn`): a
 * superscript inside a note is the note's own number or a reference in its own
 * prose. An edited note row therefore finds no runs at all, and any reference that
 * had somehow been recorded inside one comes loose rather than being kept at an
 * offset the edit has moved.
 */
function rebind(
  out: ReplayedRow[],
  replayed: Map<string, ReplayedRow>,
  edited: ReadonlySet<string>,
  loose: BookLoose,
): { rows: ReplayedRow[]; loose: BookLoose } {
  /*
   * WHICH NOTES NAMED EACH EDITED BLOCK — taken off the rows as the FILE recorded
   * them, before anything below rewrites a `refs` list. The note's own printed
   * number is read off its REPLAYED text, because renumbering a note is an
   * ordinary edit and the number on the page is what a marker matches.
   */
  const claimants = new Map<string, { id: string; printed: number | null }[]>();
  for (const row of out) {
    for (const ref of row.refs ?? []) {
      if (!edited.has(ref.block)) continue;
      const already = claimants.get(ref.block);
      const claimant = { id: row.id, printed: printedNoteNumber(row.text) };
      if (already === undefined) claimants.set(ref.block, [claimant]);
      else already.push(claimant);
    }
  }

  /** The ref each note now has into each edited block, or nothing. */
  const bound = new Map<string, Map<string, BookRef>>();
  const markers = loose.markers.filter((marker) => !edited.has(marker.block));

  for (const id of edited) {
    const row = replayed.get(id)!;
    const notes = claimants.get(id) ?? [];
    const taken = new Set<string>();
    // The engine's own exclusion, restated: what a superscript inside a note row
    // means is the note's own number, and neither side links anything in one.
    const runs = row.category === 'Footnote' ? [] : superscriptRuns(row.text);
    for (const run of runs) {
      const note = notes.find((candidate) => candidate.printed === run.printed && !taken.has(candidate.id));
      if (note === undefined) {
        markers.push({ block: id, at: run.at, len: run.len, printed: run.printed });
        continue;
      }
      taken.add(note.id);
      const into = bound.get(note.id);
      const ref: BookRef = { block: id, at: run.at, len: run.len };
      if (into === undefined) bound.set(note.id, new Map([[id, ref]]));
      else into.set(id, ref);
    }
  }

  const orphans = new Set(loose.notes);
  for (const [at, row] of out.entries()) {
    const was = row.refs;
    if (was === undefined) continue;
    /*
     * SUBSTITUTED IN PLACE RATHER THAN REBUILT AND SORTED. Every ref into a block
     * nobody touched survives exactly where it was in the list, and a ref into an
     * edited block is replaced by whatever this note claimed there — or by nothing.
     * A note that named one edited block twice (which the format permits and the
     * engine's claim-once rule never produces) resolves to the one run it can hold
     * there; `done` is what keeps the second mention from duplicating the first.
     */
    const kept: BookRef[] = [];
    const done = new Set<string>();
    for (const ref of was) {
      if (!edited.has(ref.block)) {
        kept.push(ref);
        continue;
      }
      if (done.has(ref.block)) continue;
      done.add(ref.block);
      const now = bound.get(row.id)?.get(ref.block);
      if (now !== undefined) kept.push(now);
    }
    if (kept.length === 0) orphans.add(row.id);
    if (kept.length === was.length && kept.every((ref, which) => ref === was[which])) continue;
    const rewritten: ReplayedRow = { ...row, refs: kept };
    out[at] = rewritten;
    replayed.set(row.id, rewritten);
  }

  return { rows: out, loose: { markers, notes: [...orphans] } };
}

/**
 * The ids of the notes that are struck, so a surface can grey their numbers.
 *
 * ── Derived, and emphatically not a second op ───────────────────────────────
 *
 * *"if i delete footnotes, it removes their corresponding reference numbers."*
 * (docs/RENDERER.md §0, ruling 9.) The number in the prose belongs to the note,
 * so striking the note strikes its numbers — and restoring it brings them back —
 * as a FACT COMPUTED FROM THE REPLAYED ROWS rather than as a second op recorded
 * beside the first (§2). An op per marker would be two records of one decision,
 * and the day they disagreed the book would have a number for a note that is not
 * there.
 *
 * It is a set of NOTE ids and not of markers, because the pane already inverts
 * `refs` into a map of the markers printed in each block (`printed`, the book
 * pane): every marker element it draws already knows which note it belongs to, so
 * the cheapest possible answer here is the one it can test with a single lookup.
 */
export function struckNotes(rows: readonly ReplayedRow[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.struck === true && row.note !== undefined) out.add(row.id);
  }
  return out;
}
