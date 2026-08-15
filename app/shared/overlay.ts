/**
 * The overlay — what a PERSON decided about a scan's blocks, as a file.
 *
 * The readings bank (`src/vlm/readings.ts`) is what the model said, and this app
 * never edits it: a page costs GPU-minutes, the answers are replayed to render a
 * book for free, and an answer somebody hand-corrected is no longer evidence of
 * anything. So a curation is a SECOND file of amendments, each one naming a block
 * and saying what to do about it, and every rendering becomes bank + overlay.
 *
 *   { "overlay": 1, "generation": "<uuid>",
 *     "amendments": [
 *       { "at": { "page": 7, "order": 14 }, "strike": true },
 *       { "at": { "page": 12, "order": 3, "part": 1 }, "category": "Footnote" },
 *       { "at": { "page": 40, "order": 2 }, "text": "IV" } ],
 *     "chapters": [
 *       { "at": { "page": 30, "order": 1 }, "title": "Chapter 4 — The Windmill" } ] }
 *
 * THE SCHEMA IS THE ENGINE'S (src/vlm/overlay.ts) AND IT IS FIXED. This module
 * is the app's half of that contract: it writes the file the engine reads, and it
 * reads back the file it wrote. Everything here is a pure function of strings and
 * plain objects — no `fs`, no `electron` — because `app/shared` is the one
 * directory both TypeScript programs compile, and because the whole of the
 * contract is worth being able to test without writing a file to disk.
 *
 * ── A block is named by (page, order, part) ─────────────────────────────────
 *
 * Not by what it says. Those three numbers are facts about the model's answer —
 * the page it was read from, the element's place in the array it came back in,
 * and which piece of that element a markdown split cut out — and all three
 * survive a re-render, because the answer is replayed verbatim and the split is
 * deterministic over it. A box or a hash of the text would not: the engine
 * rewrites a block's text before any renderer sees it, so an amendment keyed to
 * the words would come loose from the block it was about, silently, in exactly
 * the books somebody had done the most work on.
 *
 * `at` WITHOUT `part` MEANS THE WHOLE ANSWER ELEMENT. That is the useful default
 * and it is what this app writes when it is handed a block with no part: a person
 * striking a block is pointing at a region of a page, and the fact that the model
 * happened to answer for it in one element that the engine then cut into three is
 * not something they should have to know.
 *
 * ── The writer is CANONICAL-COMPACT ─────────────────────────────────────────
 *
 * ONE AMENDMENT PER TARGET, fields merged, rewritten in place. The engine folds
 * amendments about one block in file order, so an append-forever writer would
 * also be correct — and it would grow a file of forty thousand lines describing a
 * book with four hundred decisions in it, whose last line is the only one that
 * matters and whose history is a worse copy of the undo ledger that already
 * exists. The ledger is where history lives (`LedgerRow`); this file is where the
 * CURRENT state lives, and there is exactly one line per block it is about.
 *
 * A field set back to what the model already said is REMOVED rather than written
 * as an override that happens to agree. An amendment that decides nothing is
 * dropped entirely. Both matter for the same reason: the count of amendments is
 * quoted to the user by the engine's own run log, and a curation reported as 400
 * decisions when 12 were made is a number nobody can use.
 *
 * ── And validation is strict ────────────────────────────────────────────────
 *
 * The opposite of the readings bank, and for the opposite reason. A bank tolerates
 * a torn last line because a torn last line is the NORMAL consequence of killing a
 * run mid-append. This file is written whole and atomically by one program, so
 * anything wrong with it is a bug in that program — and every one of them is
 * refused BY NAME, taking the whole file down rather than half-applying it.
 * `strike` misspelled as `struck` would otherwise be a curation somebody made that
 * quietly did nothing.
 */

import { readJson } from './json';

/** Refusals from this module, named so a caller can tell them from anything else. */
export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayError';
  }
}

/** The schema. 1 is the only one there has ever been. */
export const OVERLAY_VERSION = 1;

/**
 * Every category a block can be RECLASSIFIED as — the engine's own spelling.
 *
 * `DOTS_CATEGORIES` in src/vlm/dots.ts, verbatim and in its order. Capitalised
 * and hyphenated because that is what the model emits and what the bank holds;
 * the EPUB's `data-bf-cat` values are the same words lower-cased, and the two
 * lists are deliberately NOT derived from one another — they are the vocabularies
 * of two different files, and a rename in one must not silently rewrite the other.
 *
 * `Quote` is in the list even though the model never emits one: the engine
 * synthesises it from a `>` run inside a Text block, so a block can arrive as one
 * and a person must be able to say a block IS one.
 */
export const OVERLAY_CATEGORIES = [
  'Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header',
  'Picture', 'Quote', 'Section-header', 'Table', 'Text', 'Title',
] as const;

export type OverlayCategory = (typeof OVERLAY_CATEGORIES)[number];

const CATEGORIES: ReadonlySet<string> = new Set<string>(OVERLAY_CATEGORIES);

export function isOverlayCategory(value: string): value is OverlayCategory {
  return CATEGORIES.has(value);
}

/** The block, or the family of blocks, an amendment is about. */
export interface OverlayTarget {
  /** 1-based, the PDF's own numbering. */
  page: number;
  /** The element's index in the model's answer for that page. */
  order: number;
  /** One sub-block of that element. Absent means every part of it. */
  part?: number;
}

/**
 * What was decided about one target. Every field is optional; an amendment with
 * none of them is not an amendment.
 */
export interface OverlayDecision {
  /** Out of every rendering. The block is not written, not counted, not cropped. */
  strike?: boolean;
  /** Rendered as this instead of what the model called it. */
  category?: OverlayCategory;
  /**
   * What the block SAYS, overriding the model's reading of it.
   *
   * For the line the model read as `1V` when the page prints `IV`. It replaces
   * the text everywhere the block renders, and it is never empty — removing a
   * block is what `strike` is for, and an empty override would be a silent strike
   * that no tally counts.
   *
   * IT HAS NOTHING TO DO WITH THE TABLE OF CONTENTS. A block that happens to open
   * a chapter is an ordinary block: correcting its words corrects the words on the
   * page, and the chapter's NAME is a separate statement in `chapters` below.
   */
  text?: string;
}

export interface OverlayAmendment extends OverlayDecision {
  at: OverlayTarget;
}

/**
 * One chapter of the book: where it starts, and what the contents calls it.
 *
 * THE TITLE IS THE CHAPTER'S NAME AND NOTHING ELSE IS. It is not read off the
 * block, not derived from it and not written back into it — a chapter opening
 * printed as "IV" is listed in the contents as "Chapter 4 — The Windmill", which
 * is correct, ordinary, and unsayable in any design that made one of the two a
 * copy of the other.
 */
export interface OverlayChapter {
  at: OverlayTarget;
  title: string;
}

export interface OverlayFile {
  overlay: typeof OVERLAY_VERSION;
  /**
   * The app's binding of this file to the reading it annotates, carried by the
   * engine and never interpreted by it.
   *
   * It is this app's only defence against the one failure that would be worse
   * than having no overlay at all: a book read AGAIN, whose blocks are numbered
   * afresh, with a file of amendments beside it naming (page, order) pairs that
   * now mean different blocks. See `overlayFate`.
   */
  generation: string;
  amendments: OverlayAmendment[];
  /**
   * THE SPINE, when a person has stated one — and then it is the whole of it.
   *
   * ── Three states, and the difference between two of them is the feature ────
   *
   * ABSENT: nobody has touched the chapters, and the engine divides the book the
   * way it always has — running heads, numbering, the header rules. This is what
   * every conversion in this app's history has done and it is the state a scan
   * arrives in.
   *
   * PRESENT: the book divides at exactly these blocks, in exactly this order, and
   * the contents reads exactly these names. Detection is SUPERSEDED, not
   * consulted, not merged with, not used as a tie-break. That is the point:
   * anybody curating chapters is doing it because the detection got something
   * wrong, and a design where their list argues with a heuristic is a design where
   * the book they described is not the book they get.
   *
   * PRESENT AND EMPTY: the book does not divide at all, said out loud. It is a
   * real answer — a pamphlet, a single essay, a scan the user wants as one flow —
   * and it is exactly why "absent" and "empty" cannot be the same value.
   *
   * STRICTLY ASCENDING IN READING ORDER, and two chapters may not start at one
   * block. Both are refused rather than sorted-out-of, because a list that arrived
   * out of order is a list something wrote wrong, and a book whose contents runs
   * backwards is not a thing to guess about.
   */
  chapters?: OverlayChapter[];
}

/** An overlay with nothing decided. The state every scan starts in. */
export function emptyOverlay(generation: string): OverlayFile {
  return { overlay: OVERLAY_VERSION, generation, amendments: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming a block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `7:14`, or `7:14:1` for one part of an element — the string form of a target.
 *
 * It is the ledger's `target` and the selection's id as well as this module's map
 * key, and that is deliberate: a row in the undo file has to name a block in a
 * string, the inspector has to hold a set of them, and three different spellings
 * of one name is three places for them to stop agreeing.
 */
export function targetKey(at: OverlayTarget): string {
  return at.part === undefined ? `${at.page}:${at.order}` : `${at.page}:${at.order}:${at.part}`;
}

/**
 * The target a key names, or a refusal.
 *
 * Refuses rather than returning null, because every caller has one: a ledger row
 * whose target does not parse is a row this app wrote wrong, and replaying it
 * against a guessed block is the one outcome worth failing loudly for.
 */
export function parseTargetKey(key: string): OverlayTarget {
  const parts = key.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new OverlayError(
      `"${key}" does not name a block. A block is "page:order", or "page:order:part" for one piece `
      + 'of an answer element.',
    );
  }
  const numbers = parts.map((piece) => Number(piece));
  for (let at = 0; at < numbers.length; at += 1) {
    const value = numbers[at]!;
    if (!Number.isInteger(value) || value < (at === 0 ? 1 : 0)) {
      throw new OverlayError(`"${key}" is not a block: its ${['page', 'order', 'part'][at]} is "${parts[at]}".`);
    }
  }
  const target: OverlayTarget = { page: numbers[0]!, order: numbers[1]! };
  if (numbers.length === 3) target.part = numbers[2]!;
  return target;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading one
// ─────────────────────────────────────────────────────────────────────────────

const OVERLAY_FIELDS = ['overlay', 'generation', 'amendments', 'chapters'] as const;
const AMENDMENT_FIELDS = ['at', 'strike', 'category', 'text'] as const;
const CHAPTER_FIELDS = ['at', 'title'] as const;
const TARGET_FIELDS = ['page', 'order', 'part'] as const;

/**
 * The text of an overlay → an overlay, or a refusal that names the amendment.
 *
 * EVERY FIELD IS CHECKED AND ONE BAD ONE TAKES THE FILE DOWN. Refusing is
 * recoverable — the caller archives the file aside, says so, and the scan opens
 * with a clean overlay — and half-applying is not: an amendment silently dropped
 * because its `strike` arrived as the string "true" is a block somebody struck
 * that comes back in every export, with nothing on screen to say so.
 */
export function parseOverlay(text: string, name: string): OverlayFile {
  let parsed: unknown;
  try {
    parsed = readJson(text);
  } catch (err) {
    throw new OverlayError(`${name} is not JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OverlayError(`${name} is not an object, so it is not an overlay`);
  }
  const record = parsed as Record<string, unknown>;
  if (record['overlay'] !== OVERLAY_VERSION) {
    throw new OverlayError(
      `${name} declares "overlay": ${JSON.stringify(record['overlay'])}, and ${OVERLAY_VERSION} is `
      + 'the only overlay schema there is',
    );
  }
  for (const key of Object.keys(record)) {
    if (!(OVERLAY_FIELDS as readonly string[]).includes(key)) {
      throw new OverlayError(
        `${name} carries a top-level field called "${key}", and an overlay has `
        + `${OVERLAY_FIELDS.join(', ')} and nothing else`,
      );
    }
  }
  const generation = record['generation'];
  if (typeof generation !== 'string' || generation.length === 0) {
    // Refused rather than defaulted, and this is the check the whole feature
    // leans on: a file with no generation is a file nothing can say is about the
    // reading on screen, and applying it would be a guess about somebody's book.
    throw new OverlayError(
      `${name} names no generation, so nothing says which reading of the book its amendments are about`,
    );
  }
  const amendments = record['amendments'];
  if (!Array.isArray(amendments)) {
    throw new OverlayError(
      `${name} carries ${amendments === undefined ? 'no' : 'a non-array'} "amendments", and that is `
      + 'the whole of an overlay',
    );
  }
  const file: OverlayFile = {
    overlay: OVERLAY_VERSION,
    generation,
    amendments: amendments.map((entry, index) => readAmendment(entry, name, index)),
  };
  // ABSENT AND EMPTY ARE DIFFERENT and the check has to be `in` rather than a
  // truthiness test: `"chapters": []` is a person saying this book does not
  // divide, and reading it as "nobody has said" would put the detection back in
  // charge of a decision somebody made explicitly.
  if ('chapters' in record) file.chapters = readChapters(record['chapters'], name);
  return file;
}

function readChapters(value: unknown, name: string): OverlayChapter[] {
  if (!Array.isArray(value)) {
    throw new OverlayError(
      `${name} carries a "chapters" that is not a list. An empty list is legal and means the book `
      + 'does not divide; leaving the field out entirely is what lets the engine decide',
    );
  }
  const chapters: OverlayChapter[] = [];
  let previous: OverlayTarget | null = null;
  value.forEach((entry, index) => {
    const where = `${name}, chapter ${index}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new OverlayError(`${where} is ${JSON.stringify(entry)}, not a chapter`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(CHAPTER_FIELDS as readonly string[]).includes(key)) {
        throw new OverlayError(
          `${where} carries a field called "${key}", and a chapter is ${CHAPTER_FIELDS.join(' and ')} `
          + 'and nothing else',
        );
      }
    }
    const at = readTarget(record['at'], where);
    const title = record['title'];
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new OverlayError(
        `${where} says "title": ${JSON.stringify(title)}. A chapter's title is what the contents `
        + 'calls it, and a contents entry with nothing in it is a row nobody can click',
      );
    }
    if (previous !== null && compareTargets(previous, at) >= 0) {
      throw new OverlayError(
        `${where} starts at ${targetKey(at)}, which is not after ${targetKey(previous)}. The `
        + 'chapters are the book in reading order, and two of them cannot begin at one block',
      );
    }
    previous = at;
    chapters.push({ at, title });
  });
  return chapters;
}

function readAmendment(entry: unknown, name: string, index: number): OverlayAmendment {
  const where = `${name}, amendment ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new OverlayError(`${where} is ${JSON.stringify(entry)}, not an amendment object`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(AMENDMENT_FIELDS as readonly string[]).includes(key)) {
      throw new OverlayError(
        `${where} carries a field called "${key}", and an amendment has ${AMENDMENT_FIELDS.join(', ')} `
        + 'and nothing else',
      );
    }
  }

  const amendment: OverlayAmendment = { at: readTarget(record['at'], where) };
  if ('strike' in record) {
    if (typeof record['strike'] !== 'boolean') {
      throw new OverlayError(`${where} says "strike": ${JSON.stringify(record['strike'])}, and it is true or false`);
    }
    amendment.strike = record['strike'];
  }
  if ('category' in record) {
    const category = record['category'];
    if (typeof category !== 'string' || !isOverlayCategory(category)) {
      throw new OverlayError(
        `${where} says "category": ${JSON.stringify(category)}, which is not a category anything `
        + `renders. The categories are: ${OVERLAY_CATEGORIES.join(', ')}`,
      );
    }
    amendment.category = category;
  }
  if ('text' in record) {
    const value = record['text'];
    if (typeof value !== 'string' || value.length === 0) {
      throw new OverlayError(
        `${where} says "text": ${JSON.stringify(value)}, and it is a string with something in it. `
        + 'Removing a block is what "strike" is for; an empty override would be a strike no tally counts',
      );
    }
    amendment.text = value;
  }

  if (Object.keys(amendment).length === 1) {
    throw new OverlayError(
      `${where} names a block and says nothing about it. An amendment that decides nothing is a `
      + 'decision that got lost between the app and this file',
    );
  }
  return amendment;
}

function readTarget(value: unknown, where: string): OverlayTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OverlayError(
      `${where} has no "at": ${JSON.stringify(value)}. Every amendment names the block it is about`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(TARGET_FIELDS as readonly string[]).includes(key)) {
      throw new OverlayError(
        `${where}'s "at" carries a field called "${key}", and a block is named by `
        + `${TARGET_FIELDS.join(', ')} and nothing else`,
      );
    }
  }
  const target: OverlayTarget = {
    page: readCount(record['page'], `${where}'s "at".page`, 1),
    order: readCount(record['order'], `${where}'s "at".order`, 0),
  };
  if ('part' in record) target.part = readCount(record['part'], `${where}'s "at".part`, 0);
  return target;
}

/**
 * One of the three numbers that name a block.
 *
 * A whole number at or above `least`, and every other spelling is refused: 3.5 is
 * not an index, -1 is not a page, and "7" is a string the app forgot to convert
 * which would have targeted nothing at all.
 */
function readCount(value: unknown, where: string, least: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < least) {
    throw new OverlayError(
      `${where} is ${JSON.stringify(value)}, and it is a whole number `
      + `${least === 0 ? 'of 0 or more' : 'of 1 or more'}`,
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Holding one, and editing it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The amendments as a map from target to decision — the shape everything on
 * screen actually wants.
 *
 * Folded in FILE ORDER, field by field, exactly as the engine folds them
 * (`decide` in src/vlm/overlay.ts): a later amendment beats an earlier one for
 * the field it carries and leaves the others alone. This app writes one amendment
 * per target so the fold is usually a copy — but a file written by an older build,
 * or edited by hand, has to mean here precisely what it will mean at render time,
 * or the app would be showing a curation the export does not make.
 *
 * A part-less amendment is NOT spread over the element's parts here. It stays
 * under its own key, and `decisionFor` is what asks both.
 */
export function decisionsOf(file: OverlayFile): Map<string, OverlayDecision> {
  const map = new Map<string, OverlayDecision>();
  for (const amendment of file.amendments) {
    const key = targetKey(amendment.at);
    const { at: _at, ...decision } = amendment;
    map.set(key, { ...map.get(key), ...decision });
  }
  return map;
}

/**
 * What this overlay says about one block: the element-wide amendment, with the
 * part-specific one on top of it.
 *
 * The order is the file's — a part-less amendment and a part-ed one are folded
 * with no precedence between them at render time — but the app writes each
 * gesture to the key the gesture named, and a person who amended one part after
 * amending the whole element meant the part. Reading it that way here matches
 * what a file this app wrote will do downstream, because the part-ed amendment is
 * the later line in it.
 */
export function decisionFor(
  decisions: ReadonlyMap<string, OverlayDecision>,
  page: number,
  order: number,
  part: number,
): OverlayDecision {
  const whole = decisions.get(`${page}:${order}`);
  const piece = decisions.get(`${page}:${order}:${part}`);
  if (whole === undefined) return piece ?? {};
  return piece === undefined ? whole : { ...whole, ...piece };
}

/**
 * The fields of a decision that can be edited, as the ledger spells them.
 *
 * The ledger's `field` and this app's setters are the same five names, so a row
 * read back off disk routes to the setter that wrote it without a translation
 * table in between.
 */
export type OverlayField = 'strike' | 'category' | 'text';

/**
 * One edit, applied to a copy — the ONE mutator, and every gesture goes through
 * it.
 *
 * `value` is a STRING, always, including for the two booleans, because that is
 * what a ledger row carries and because an undo is this same call with the other
 * value. `''` is "nothing said" and is how a field is REMOVED: unstriking a
 * block, taking back a chapter mark, putting a reclassified block back to what
 * the model called it, clearing a text override. That is the canonical rule made
 * operational — the app never writes `strike: false`, it writes nothing at all,
 * because for every one of these fields the absence IS the default.
 *
 * The result is canonical: one amendment per target, fields merged, empty
 * amendments dropped, and the whole list in page order.
 */
export function amendOverlay(
  file: OverlayFile,
  target: OverlayTarget,
  field: OverlayField,
  value: string,
): OverlayFile {
  const key = targetKey(target);
  const decisions = decisionsOf(file);
  const decision: OverlayDecision = { ...decisions.get(key) };

  if (value.length === 0) delete decision[field];
  else if (field === 'strike') decision.strike = value === 'true' || value === '1';
  else if (field === 'category') {
    if (!isOverlayCategory(value)) {
      throw new OverlayError(
        `"${value}" is not a category anything renders. The categories are: `
        + `${OVERLAY_CATEGORIES.join(', ')}.`,
      );
    }
    decision.category = value;
  } else decision.text = value;

  decisions.set(key, decision);
  return { ...file, amendments: amendmentsOf(decisions) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The spine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Put a chapter list on an overlay, or take it off — the ONE mutator for the
 * spine, exactly as `amendOverlay` is the one mutator for a block.
 *
 * Null removes the field, which hands the book back to the engine's own
 * detection. That is a real gesture (undoing the very first chapter edit lands
 * here) and it is why the ledger carries the whole list rather than one row per
 * chapter: "there is no list" is a state of the WHOLE field, and no per-row
 * scheme can return to it without also knowing every row it would have to erase.
 *
 * Sorted and checked on the way in. The caller inserts wherever it likes and this
 * is what makes the file's own promise — ascending, one chapter per block — true
 * by construction rather than by every call site remembering.
 */
export function setChapters(file: OverlayFile, chapters: readonly OverlayChapter[] | null): OverlayFile {
  if (chapters === null) {
    const { chapters: _gone, ...rest } = file;
    return rest;
  }
  const sorted = [...chapters].sort((a, b) => compareTargets(a.at, b.at));
  for (let at = 1; at < sorted.length; at += 1) {
    if (compareTargets(sorted[at - 1]!.at, sorted[at]!.at) === 0) {
      throw new OverlayError(
        `Two chapters cannot begin at ${targetKey(sorted[at]!.at)} — that block already starts `
        + `“${sorted[at - 1]!.title}”.`,
      );
    }
  }
  return { ...file, chapters: sorted };
}

/**
 * The chapter list as one string, for a ledger row.
 *
 * `''` is "there is no list", which is the state before anybody touched the
 * chapters and the state an undo of the first edit has to reach. Every other
 * value is the whole list, because that is what one chapter edit changes: adding
 * one, removing one and renaming one are all "the spine used to be this and is now
 * that", and a scheme of per-chapter rows would have to invent an answer for the
 * seeding gesture — which turns an absent field into forty rows at once.
 *
 * A LIST IS SMALL. Sixty chapters is a few kilobytes, which is the same order as
 * the one word-edit row this ledger has always carried, and the cap on actions
 * bounds the rest.
 */
export function chaptersText(chapters: readonly OverlayChapter[] | null): string {
  return chapters === null ? '' : JSON.stringify(chapters);
}

/** A ledger row's value back to a chapter list. `''` is "no list". */
export function chaptersOfText(text: string, where: string): OverlayChapter[] | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = readJson(text);
  } catch (err) {
    throw new OverlayError(`${where} does not hold a chapter list (${(err as Error).message})`);
  }
  return readChapters(parsed, where);
}

/** Reading order: the page, then the model's own order, then the part. */
export function compareTargets(a: OverlayTarget, b: OverlayTarget): number {
  return a.page - b.page || a.order - b.order || (a.part ?? -1) - (b.part ?? -1);
}

/** The decision map back to a canonical amendment list. */
export function amendmentsOf(decisions: ReadonlyMap<string, OverlayDecision>): OverlayAmendment[] {
  const amendments: OverlayAmendment[] = [];
  for (const [key, decision] of decisions) {
    const at = parseTargetKey(key);
    const kept: OverlayDecision = {};
    if (decision.strike !== undefined) kept.strike = decision.strike;
    if (decision.category !== undefined) kept.category = decision.category;
    if (decision.text !== undefined) kept.text = decision.text;
    // An amendment that decides nothing is not written. This is where an
    // unstruck block stops costing a line in somebody's curation.
    if (Object.keys(kept).length === 0) continue;
    amendments.push({ at, ...kept });
  }
  return amendments.sort(byBlock);
}

/**
 * Page order, then the order the model answered in, then the part.
 *
 * A stable order is not cosmetic here: the file is rewritten whole on every
 * gesture, and an amendment list whose order depended on which block somebody
 * happened to click first would make every save a diff of the entire file — in a
 * folder people sync.
 */
function byBlock(a: OverlayAmendment, b: OverlayAmendment): number {
  return compareTargets(a.at, b.at);
}

/**
 * The bytes to write. Two-space JSON with a trailing newline, like every other
 * file this app writes by hand.
 *
 * The fields are named one by one rather than spread, so that `chapters` is
 * omitted when there is no list rather than written as `null` — which the reader
 * would refuse, and which would mean the opposite of what it looks like.
 */
export function overlayText(file: OverlayFile): string {
  return `${JSON.stringify({
    overlay: file.overlay,
    generation: file.generation,
    amendments: file.amendments,
    ...(file.chapters === undefined ? {} : { chapters: file.chapters }),
  }, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HAZARD: an overlay about a reading that no longer exists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What to do with an overlay that has been read off disk, and why.
 *
 * `use` — it names this reading, so every amendment in it is about the block it
 *   was made about, and the editor opens with the curation on screen.
 *
 * `archive` — it does not. The pages have been read AGAIN since it was written
 *   (the engine archives the bank and re-reads, which renumbers every block on
 *   every page), so `{"page": 7, "order": 14}` no longer means the paragraph
 *   somebody struck: it means whatever the new pass happened to answer
 *   fourteenth. Applying it would strike a different block, reclassify a
 *   different block and split the book in a different place — with nothing on
 *   screen to say anything had gone wrong, which is the one failure worse than
 *   losing the curation outright.
 *
 * THE FILE IS NEVER DELETED. It is moved aside, named out loud, and kept: those
 * amendments are a person's judgement about hundreds of blocks, and they are the
 * training labels this project will one day want most.
 */
export type OverlayFate =
  | { use: true }
  | { use: false; why: string };

export function overlayFate(fileGeneration: string, reading: string): OverlayFate {
  if (fileGeneration === reading) return { use: true };
  return {
    use: false,
    why: `it was made against an earlier reading of this book (generation `
      + `${fileGeneration || 'unrecorded'}, and this one is ${reading}), so the blocks its `
      + 'amendments name are not the blocks on the pages',
  };
}
