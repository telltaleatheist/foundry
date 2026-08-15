/**
 * vlm/overlay — what a PERSON decided about the blocks, in a file of its own.
 *
 * The bank (`readings.ts`) is what the model said, and it is never edited: a
 * page costs GPU-minutes, the answers are replayed to re-render a book for free,
 * and an answer somebody hand-corrected is no longer evidence of anything. So a
 * curation is not a rewrite of the bank. It is a SECOND file, of decisions, and
 * every renderer becomes `render(bank + overlay)`:
 *
 *   { "overlay": 1,
 *     "chapters": [ { "at": { "page": 30, "order": 1 }, "title": "IV — Nuremberg" } ],
 *     "amendments": [
 *       { "at": { "page": 7, "order": 14 }, "strike": true },
 *       { "at": { "page": 12, "order": 3, "part": 1 }, "category": "Footnote" },
 *       { "at": { "page": 12, "order": 4 }, "text": "corrected words" } ] }
 *
 * TWO LISTS, BECAUSE THERE ARE TWO KINDS OF DECISION. An amendment is about a
 * block — what it is, what it says, whether it is in the book at all — and any
 * number of them can be true at once. The chapters are about the BOOK: where it
 * divides and what the contents calls each division, in order, as a single
 * statement of the finished spine. A per-block "chapter: true" would make the
 * spine an emergent property of the detection rules plus a pile of corrections,
 * and nobody could then answer "why does my book have this chapter" without
 * knowing which rules fired. See `Overlay.chapters`.
 *
 * A top-level `generation` string may ride along beside them; it is the writer's
 * own binding of the file to the reading it annotates, and this program carries
 * it without ever reading its value (see `Overlay.generation`).
 *
 * A BLOCK IS NAMED BY `(page, order, part)` AND NOT BY WHAT IT SAYS. Those three
 * numbers are facts about the model's answer — the page it was read from, the
 * element's place in the array it came back in, and which piece of that element
 * a markdown split cut out (`consumeMarkdown`). All three survive a re-render,
 * because the answer is replayed verbatim and the split is deterministic over
 * it. A box or a hash of the text would not: `dehyphenate` and
 * `reflowWrappedProse` both rewrite a block's text before any renderer sees it,
 * so an amendment keyed to the words would come loose from the block it was
 * about — silently, and only in the books where somebody had done the most work.
 *
 * `at` WITHOUT `part` MEANS THE WHOLE ANSWER ELEMENT, every piece of it. That is
 * the useful default: a person striking a block in the app is pointing at a
 * region of a page, and the fact that the model happened to answer for it in one
 * element that this program then cut into three is not something they should
 * have to know. With `part`, the amendment is about that one sub-block.
 *
 * VALIDATION IS STRICT, AND THAT IS THE OPPOSITE OF `readings.ts`. The bank
 * tolerates a torn last line because a torn last line is the NORMAL consequence
 * of killing a run mid-append — the file is written a record at a time by a
 * process that can die. This file is written whole by the app, so anything wrong
 * with it is a bug in the writer, and every one of them is refused by name:
 * `strike` misspelled as `struck` would otherwise be a curation somebody made
 * that quietly did nothing, which is the exact failure ARCHITECTURE §8 is about.
 * Nothing here guesses, defaults or repairs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DOTS_CATEGORIES, type DotsBlock, type DotsCategory } from './dots.js';

export class VlmOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmOverlayError';
  }
}

/** The block, or the family of blocks, an amendment is about. */
export interface OverlayTarget {
  /** 1-based, the PDF's own numbering — `DotsBlock.page`. */
  page: number;
  /** The element's index in the model's answer for that page — `DotsBlock.order`. */
  order: number;
  /** One sub-block of that element. Absent means every part of it. */
  part?: number;
}

/**
 * One decision about one target. Every field is optional and at least one is
 * required — an amendment that says nothing is a line the app wrote by mistake.
 */
export interface OverlayAmendment {
  at: OverlayTarget;
  /** Out of every rendering. The block is not written, not counted, not cropped. */
  strike?: boolean;
  /** Rendered as this instead of what the model called it. */
  category?: DotsCategory;
  /**
   * What the block SAYS, replacing what the model read off the page.
   *
   * It goes in where the model's own text would have gone, which is the only
   * position that makes it ordinary: `*italic*` and `**bold**` become real
   * emphasis, a Unicode superscript digit becomes a footnote reference that
   * links to its note, a `word-\nword` seam is rejoined against the book's own
   * lexicon, and a paragraph the model chopped into print lines is reflowed.
   * Nothing about the corrected text is treated differently from the text it
   * corrects, because the correction is not a second channel — it is the same
   * channel with a person on the other end of it.
   *
   * IT DOES NOT RE-SPLIT THE BLOCK. A `#` in an override does not spawn a
   * heading and a new sub-block the way one in the model's answer does
   * (`consumeMarkdown`), because the split is what MAKES the `part` numbers, and
   * a correction that renumbered the blocks would move every other amendment in
   * the file onto a different block. Predictability is worth more here than
   * cleverness: an override changes what a block says and never how many blocks
   * there are.
   *
   * An empty string is refused. "This block says nothing" is not a correction,
   * it is a deletion, and `strike` is the field that deletes.
   */
  text?: string;
}

/**
 * One chapter of the book: where it starts, and what the contents calls it.
 *
 * The two are INDEPENDENT, and that is the point of the shape. `at` names a
 * block and the book divides in front of it; `title` is the entry in the nav and
 * the label on the document, and it is not derived from that block or from
 * anything else on the page. A chapter's opener renders as an ordinary block at
 * the top of its section — the paper still says `CHAPTER II`, or whatever a
 * `text` amendment corrects that to — and the contents can say `Chapter 4 — The
 * Windmill` at the same time, because what a book prints and what its contents
 * calls it are two different facts and a book is allowed to state both.
 */
export interface OverlayChapter {
  at: OverlayTarget;
  title: string;
}

export interface Overlay {
  /** The schema. 1 is the only version there has ever been. */
  overlay: 1;
  /**
   * The app's own binding of this file to the reading it annotates, carried and
   * NOT interpreted.
   *
   * It is a string to this program and nothing else: the app writes a generation
   * token here the way its undo ledgers carry one, so that it can tell an
   * overlay about THIS bank from one left over beside a book that has since been
   * read again. The engine has no opinion about the value, never compares two of
   * them and never refuses a run over one — it is validated as a string and
   * carried so that a round trip through this file does not lose it. Checked at
   * all because a `generation` that arrived as a number is the app's bug, and
   * finding it here costs a sentence while finding it later costs a curation.
   */
  generation?: string;
  /**
   * THE SPINE, WHEN THERE IS ONE. Absent is the ordinary case and means the
   * engine works the chapters out for itself, exactly as it did before overlays
   * existed.
   *
   * PRESENT, IT IS DEFINITIVE. The book divides at these locations and at no
   * others, and the contents says these names and no others. Nothing about the
   * detection survives it: no heading is promoted, no running head is demoted,
   * no page is classified into a title page or a part divider. That is not a
   * simplification, it is the whole reason the field is a LIST rather than a
   * pile of per-block overrides. Detection plus corrections means every question
   * about the finished book is a question about two things interacting —
   * "did this split because the rule fired or because I said so, and what
   * happens if the rule changes?" — and the answer moves under somebody's feet
   * when the engine improves. A list is a statement of the finished spine: what
   * you see is what the book is, and removing an entry IS the demotion.
   *
   * AN EMPTY LIST IS A STATEMENT TOO, and it is not the same as an absent one:
   * it says the book has no divisions at all, and it comes out as a single
   * section. A field that meant "nothing decided" when empty would leave nobody
   * a way to say that.
   *
   * The blocks BEFORE the first entry are front matter and become the leading
   * section, which is exactly what happens to a detected book that does not open
   * on a chapter.
   */
  chapters?: OverlayChapter[];
  amendments: OverlayAmendment[];
}

/** No amendments: the run behaves exactly as it did before overlays existed. */
export function emptyOverlay(): Overlay {
  return { overlay: 1, amendments: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading one off disk
// ─────────────────────────────────────────────────────────────────────────────

/** The fields an amendment may carry, so an unknown one can be named. */
const AMENDMENT_FIELDS = ['at', 'strike', 'category', 'text'] as const;
const TARGET_FIELDS = ['page', 'order', 'part'] as const;
const OVERLAY_FIELDS = ['overlay', 'generation', 'chapters', 'amendments'] as const;
const CHAPTER_FIELDS = ['at', 'title'] as const;

const CATEGORY_LIST = DOTS_CATEGORIES.join(', ');

export function loadOverlay(filePath: string): Overlay {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new VlmOverlayError(
      `no such overlay: ${resolved}. An overlay names the blocks a person struck, reclassified or `
      + 'corrected, and the chapters they laid out; a run told to apply one and handed nothing '
      + 'would render the book as if none of those decisions had been made.',
    );
  }
  return parseOverlay(fs.readFileSync(resolved, 'utf8'), resolved);
}

/**
 * The text of an overlay → an overlay, or a refusal naming the amendment or the
 * chapter that is wrong.
 *
 * Split out from `loadOverlay` because this is the whole of the contract with
 * the app and it is worth being able to test a hundred malformed files without
 * writing one to disk.
 */
export function parseOverlay(text: string, name: string): Overlay {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new VlmOverlayError(
      `${name} is not JSON (${err instanceof Error ? err.message : String(err)}). `
      + 'This file is written whole by whatever curates the blocks, so a file that does not parse '
      + 'is a bug in the writer rather than an interrupted append.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VlmOverlayError(
      `${name} holds ${Array.isArray(parsed) ? 'an array' : JSON.stringify(parsed)}, and an overlay `
      + 'is an object: {"overlay": 1, "amendments": [...]}.',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record['overlay'] !== 1) {
    throw new VlmOverlayError(
      `${name} declares "overlay": ${JSON.stringify(record['overlay'])}, and 1 is the only overlay `
      + 'schema there is. A file that does not say which schema it is written in is a file this '
      + 'program would be guessing about.',
    );
  }
  for (const key of Object.keys(record)) {
    if (!(OVERLAY_FIELDS as readonly string[]).includes(key)) {
      throw new VlmOverlayError(
        `${name} carries a top-level field called "${key}", and an overlay has `
        + `${OVERLAY_FIELDS.join(', ')} and nothing else. A field this program does not read is `
        + 'either a decision that would never have been applied or a file written by something '
        + 'else entirely.',
      );
    }
  }
  const generation = record['generation'];
  if (generation !== undefined && typeof generation !== 'string') {
    throw new VlmOverlayError(
      `${name} says "generation": ${JSON.stringify(generation)}, and it is a string. This program `
      + 'does not read the value — it is how whatever wrote the file binds it to the reading it '
      + 'annotates — but a token of the wrong type is a bug in the writer, and it is cheaper to '
      + 'name here than to lose a curation over later.',
    );
  }
  const amendments = record['amendments'];
  if (!Array.isArray(amendments)) {
    throw new VlmOverlayError(
      `${name} carries ${amendments === undefined ? 'no' : 'a non-array'} "amendments", and every `
      + 'overlay has the list even when it is empty — an empty one says nothing was decided about '
      + 'any block, which is a different file from one that forgot to say.',
    );
  }
  const chapters = record['chapters'];
  if (chapters !== undefined && !Array.isArray(chapters)) {
    throw new VlmOverlayError(
      `${name} carries a "chapters" that is not an array (${JSON.stringify(chapters)}). It is the `
      + 'book\'s spine, in order: leave it out to have the chapters worked out, or give the list. '
      + 'An empty list says the book has no divisions at all.',
    );
  }
  return {
    overlay: 1,
    ...(generation !== undefined ? { generation } : {}),
    ...(chapters !== undefined ? { chapters: readChapters(chapters, name) } : {}),
    amendments: amendments.map((entry, index) => readAmendment(entry, name, index)),
  };
}

/**
 * The chapter list, in the order it will divide the book — and it must BE in
 * that order.
 *
 * Strictly ascending by `(page, order, part)`, which is reading order, because
 * the list is not a set of marks that get sorted into a spine, it IS the spine.
 * A list out of order is a writer that has lost track of the book, and sorting
 * it quietly would hand somebody a contents in an order they did not write and
 * could not see was wrong; two entries at one location is two chapters starting
 * at the same block, which is a section with nothing in it and a name pointing
 * at the wrong page.
 */
function readChapters(entries: readonly unknown[], name: string): OverlayChapter[] {
  const chapters: OverlayChapter[] = [];
  let previous: OverlayTarget | null = null;
  for (const [index, entry] of entries.entries()) {
    const where = `${name}, chapter ${index}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new VlmOverlayError(`${where} is ${JSON.stringify(entry)}, not a chapter object.`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(CHAPTER_FIELDS as readonly string[]).includes(key)) {
        throw new VlmOverlayError(
          `${where} carries a field called "${key}", and a chapter is ${CHAPTER_FIELDS.join(' and ')}`
          + ' — where the book divides, and what the contents calls what follows.',
        );
      }
    }
    const at = readTarget(record['at'], where);
    const title = record['title'];
    if (typeof title !== 'string' || title.length === 0) {
      throw new VlmOverlayError(
        `${where} says "title": ${JSON.stringify(title)}, and the name a chapter goes into the `
        + 'contents under is a non-empty string. Nothing here derives one from the page: the '
        + 'heading on the paper and the entry in the contents are two different facts.',
      );
    }
    if (previous !== null && compareTargets(at, previous) <= 0) {
      throw new VlmOverlayError(
        `${where} starts at page ${at.page}, order ${at.order}, part ${at.part ?? 0}, which is `
        + `${compareTargets(at, previous) === 0 ? 'the same block as' : 'before'} the chapter above `
        + `it (page ${previous.page}, order ${previous.order}, part ${previous.part ?? 0}). The list `
        + 'is the book\'s spine in reading order, and nothing here reorders it for you.',
      );
    }
    previous = at;
    chapters.push({ at, title });
  }
  return chapters;
}

/** Reading order over two locations. A location with no part is its first piece. */
function compareTargets(a: OverlayTarget, b: OverlayTarget): number {
  return a.page - b.page || a.order - b.order || (a.part ?? 0) - (b.part ?? 0);
}

function readAmendment(entry: unknown, name: string, index: number): OverlayAmendment {
  const where = `${name}, amendment ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new VlmOverlayError(`${where} is ${JSON.stringify(entry)}, not an amendment object.`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(AMENDMENT_FIELDS as readonly string[]).includes(key)) {
      throw new VlmOverlayError(
        `${where} carries a field called "${key}", and an amendment has ${AMENDMENT_FIELDS.join(', ')}`
        + ' and nothing else. A field this program does not read is a decision somebody made that '
        + 'would never have been applied.',
      );
    }
  }

  const at = readTarget(record['at'], where);
  const amendment: OverlayAmendment = { at };

  if ('strike' in record) {
    if (typeof record['strike'] !== 'boolean') {
      throw new VlmOverlayError(
        `${where} says "strike": ${JSON.stringify(record['strike'])}, and strike is true or false.`,
      );
    }
    amendment.strike = record['strike'];
  }
  if ('category' in record) {
    const category = record['category'];
    if (typeof category !== 'string' || !(DOTS_CATEGORIES as readonly string[]).includes(category)) {
      throw new VlmOverlayError(
        `${where} says "category": ${JSON.stringify(category)}, which is not a category anything `
        + `renders. The categories are: ${CATEGORY_LIST}. Nothing here guesses what was meant.`,
      );
    }
    amendment.category = category as DotsCategory;
  }
  if ('text' in record) {
    const text = record['text'];
    if (typeof text !== 'string') {
      throw new VlmOverlayError(
        `${where} says "text": ${JSON.stringify(text)}, and a correction to what a block says is a `
        + 'string.',
      );
    }
    if (text.length === 0) {
      throw new VlmOverlayError(
        `${where} says "text": "", and a block that says nothing is not a corrected block, it is a `
        + 'deleted one. Use "strike": true, which takes it out of every rendering and says so in '
        + 'the run.',
      );
    }
    amendment.text = text;
  }

  if (amendment.strike === undefined
    && amendment.category === undefined
    && amendment.text === undefined) {
    throw new VlmOverlayError(
      `${where} names a block and says nothing about it — no strike, no category, no text. An `
      + 'amendment that decides nothing is a decision that got lost between the app and this file.',
    );
  }
  return amendment;
}

function readTarget(value: unknown, where: string): OverlayTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VlmOverlayError(
      `${where} has no "at": ${JSON.stringify(value)}. Every amendment names the block it is about, `
      + 'as {"page": n, "order": n} and optionally "part".',
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(TARGET_FIELDS as readonly string[]).includes(key)) {
      throw new VlmOverlayError(
        `${where}'s "at" carries a field called "${key}", and a block is named by `
        + `${TARGET_FIELDS.join(', ')} and nothing else.`,
      );
    }
  }
  const page = readCount(record['page'], `${where}'s "at".page`, 1);
  const order = readCount(record['order'], `${where}'s "at".order`, 0);
  const target: OverlayTarget = { page, order };
  if ('part' in record) {
    target.part = readCount(record['part'], `${where}'s "at".part`, 0);
  }
  return target;
}

/**
 * One of the three numbers that name a block.
 *
 * A whole number at or above `least`, and every other spelling is refused: 3.5
 * is not an index, -1 is not a page, "7" is a string the app forgot to convert
 * and would have targeted nothing at all. Refused rather than rounded, because
 * the amendment next to the bad one is about a real block and applying half a
 * file is worse than applying none of it.
 */
function readCount(value: unknown, where: string, least: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < least) {
    throw new VlmOverlayError(
      `${where} is ${JSON.stringify(value)}, and it is a whole number `
      + `${least === 0 ? 'of 0 or more' : 'of 1 or more'}.`,
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying one
//
// The amendments about one block are folded in FILE ORDER, field by field, so
// that a later amendment beats an earlier one for the field it carries and
// leaves the other fields exactly as they were. Two amendments about one block
// is the ordinary shape of an app that appends a record every time somebody
// clicks; the alternative — the first one winning, or a whole amendment
// replacing another — would make the newest decision the one that did nothing.
//
// A `part`-less amendment and a `part`-ed one are folded in the SAME order, with
// no precedence between them. Specificity would be a second rule to hold in your
// head, and it would make the answer to "what did I just do" depend on how the
// app happened to have written the earlier click.
// ─────────────────────────────────────────────────────────────────────────────

interface Decision {
  strike?: boolean;
  category?: DotsCategory;
  text?: string;
}

/**
 * The amendments indexed by `page:order`, memoised per overlay OBJECT.
 *
 * Every block on every page asks this file about itself, twice on the routes
 * that tally what the curation did, so a linear scan of the amendments would be
 * the book's block count times the curation's size. An overlay is loaded and
 * then read; nothing edits one in place, which is what makes a memoised index
 * safe here.
 */
const INDEXES = new WeakMap<Overlay, Map<string, OverlayAmendment[]>>();

function indexOf(overlay: Overlay): Map<string, OverlayAmendment[]> {
  const cached = INDEXES.get(overlay);
  if (cached !== undefined) return cached;
  const index = new Map<string, OverlayAmendment[]>();
  for (const amendment of overlay.amendments) {
    const key = `${amendment.at.page}:${amendment.at.order}`;
    const list = index.get(key);
    if (list === undefined) index.set(key, [amendment]);
    else list.push(amendment);
  }
  INDEXES.set(overlay, index);
  return index;
}

/** What this overlay says about this block, every field folded in file order. */
function decide(overlay: Overlay, block: DotsBlock): Decision {
  const decision: Decision = {};
  const hits = indexOf(overlay).get(`${block.page}:${block.order}`);
  if (hits === undefined) return decision;
  for (const amendment of hits) {
    if (amendment.at.part !== undefined && amendment.at.part !== block.part) continue;
    if (amendment.strike !== undefined) decision.strike = amendment.strike;
    if (amendment.category !== undefined) decision.category = amendment.category;
    if (amendment.text !== undefined) decision.text = amendment.text;
  }
  return decision;
}

/**
 * WHAT A BLOCK ACTUALLY IS, decided in layers, and this is the only place that
 * decides it.
 *
 * The layers, bottom to top:
 *
 *   1. THE MODEL'S OWN ANSWER. It read the page and it said `Text`. That is
 *      evidence, and for the overwhelming majority of blocks it is the only
 *      evidence there is and it is right.
 *   2. CONSENSUS — a seam, and deliberately empty. The plan is that a block's
 *      category can be voted on: the model's guess, positional heuristics (a
 *      block in the footnote band, at footnote size, under a rule), and one day
 *      a classifier trained on this project's own blocks. NOTHING VOTES YET.
 *      The layer is named here rather than built so that when it arrives it
 *      arrives in one function that every renderer already reads through,
 *      instead of as a second opinion bolted beside eleven call sites.
 *   3. THE PERSON. Always on top, and not by tie-break — by construction. A
 *      reclassification is somebody looking at the page and stating what is on
 *      it, which is better evidence than any of the arguments below it, and an
 *      override a future heuristic could out-vote would make the app's edits
 *      unpredictable in exactly the books somebody had worked hardest on.
 */
export function resolveCategory(block: DotsBlock, overlay: Overlay): DotsCategory {
  // 1. the model
  const model = block.category;

  // 2. consensus — the seam. When something votes, it votes here, over `model`
  //    and under the overlay, and it gets the block rather than a category so
  //    that it can measure the box and read the text.
  const consensus: DotsCategory | null = null;

  // 3. the person
  const stated = decide(overlay, block).category;
  return stated ?? consensus ?? model;
}

/**
 * The blocks a rendering actually gets: the struck ones gone, the reclassified
 * ones rewritten, the corrected ones saying what a person says they say.
 *
 * A block nothing was said about comes back AS ITSELF — the same object, not a
 * copy — because the passes downstream key working state by block identity and
 * rewrite `text` in place (`buildDotsBook`). An overlay that quietly replaced
 * every block in the book with a twin would be invisible here and would show up
 * as a measurement gone missing three files away.
 *
 * THE CORRECTED TEXT IS PUT WHERE THE MODEL'S TEXT WAS and then nothing else
 * happens to it here. Every pass downstream — the lexicon, the dehyphenation,
 * the reflow, the inline emphasis, the superscript markers — reads
 * `block.text`, so a correction gets all of them for free and gets exactly the
 * same ones. This position is also what stops it re-splitting the block:
 * `consumeMarkdown` ran inside `parseDotsPage`, before this function, and the
 * `part` numbers every amendment in the file is keyed to were made there.
 */
export function applyOverlay(blocks: readonly DotsBlock[], overlay: Overlay): DotsBlock[] {
  if (overlay.amendments.length === 0) return [...blocks];
  const kept: DotsBlock[] = [];
  for (const block of blocks) {
    const decision = decide(overlay, block);
    if (decision.strike === true) continue;
    const category = resolveCategory(block, overlay);
    const text = decision.text ?? block.text;
    kept.push(
      category === block.category && text === block.text ? block : { ...block, category, text },
    );
  }
  return kept;
}

/**
 * Is this block a chapter location the overlay names, and what is that chapter
 * called?
 *
 * A location with no `part` is the FIRST piece of its answer element, which is
 * the block a section would open on; a location that names a part opens the book
 * in front of that sub-block. Null everywhere else, which is every block in the
 * book but a handful.
 */
export function chapterStarts(
  chapters: readonly OverlayChapter[],
  blocks: readonly DotsBlock[],
): { index: number; title: string }[] {
  const at = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    const key = `${block.page}:${block.order}:${block.part}`;
    if (!at.has(key)) at.set(key, index);
  }
  const starts: { index: number; title: string }[] = [];
  for (const chapter of chapters) {
    const index = at.get(`${chapter.at.page}:${chapter.at.order}:${chapter.at.part ?? 0}`);
    /*
     * A LOCATION NAMING A BLOCK THIS BOOK DOES NOT CONTAIN IS SKIPPED, not
     * refused. `--skip-pages` took the page out, the model could not read it, or
     * this same overlay struck the block: in each case the block is missing from
     * this rendering for a reason somebody already knows about, and refusing the
     * whole book over a chapter that cannot exist would make a curated list
     * fragile in exactly the runs a person curates most.
     */
    if (index !== undefined) starts.push({ index, title: chapter.title });
  }
  return starts;
}

/**
 * What an overlay DID to a list of blocks, counted so a run can say it out loud.
 *
 * Taken over the blocks as they arrived, before anything was removed, because
 * that is the only moment both facts are still visible: after `applyOverlay` a
 * struck block is gone and a reclassified one no longer remembers what the model
 * called it. A curation that removed forty blocks from somebody's book has to be
 * a number on the run's own log, beside the pages and the chapters.
 */
export function overlayTally(
  blocks: readonly DotsBlock[],
  overlay: Overlay,
): { struck: number; reclassified: number; corrected: number } {
  let struck = 0;
  let reclassified = 0;
  let corrected = 0;
  for (const block of blocks) {
    const decision = decide(overlay, block);
    if (decision.strike === true) {
      struck += 1;
      continue;
    }
    if (decision.category !== undefined && decision.category !== block.category) reclassified += 1;
    if (decision.text !== undefined && decision.text !== block.text) corrected += 1;
  }
  return { struck, reclassified, corrected };
}
