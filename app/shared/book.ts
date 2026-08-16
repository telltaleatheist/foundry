/**
 * shared/book — the BOOK FILE, read back into the shapes the app draws.
 *
 * ── This is a MIRROR of src/vlm/book-file.ts, and the two must grow together ──
 *
 * The engine owns the format. `vlm-book` reflows a readings bank into one row
 * per block — hyphens fused, page turns joined, ids minted, notes cut apart —
 * and writes `readings/<key>.book.jsonl`; `src/vlm/book-file.ts` is where that
 * grammar is decided and where its every field is explained. This file states
 * the same grammar a second time, in the app, and nothing here is allowed to be
 * an opinion about it.
 *
 * IT IS RESTATED FOR `shared/unrender.ts`'s REASON, which is the precedent this
 * follows entry for entry. The app never imports a line of the engine — it
 * spawns it (electron/engine.ts) — and spawning a process to parse a file this
 * process is already holding open would be absurd. So the table is written twice
 * with the engine's file named as the contract, and the refusals below are what
 * make forgetting the second copy LOUD rather than silent: a row missing a field
 * takes the whole file down by name, and a header declaring a version this
 * program does not write is refused before a single row is read.
 *
 * If the engine's format grows a field, BOTH files grow. The version number is
 * the thing that makes that non-optional: a v3 book meets a sentence here rather
 * than a renderer quietly drawing a book with its new half missing.
 *
 * ── WHY A BAD ROW TAKES THE FILE DOWN ───────────────────────────────────────
 *
 * The engine's parser says it and it is worth saying again on this side, because
 * this side is the one with a person looking at it: this document is what every
 * op in the project is keyed to. A book assembled out of the rows that happened
 * to parse is a book with paragraphs silently missing — and the person editing it
 * would be striking, splitting and re-ordering blocks in a document that is not
 * the one on disk. A sentence naming the block that is wrong costs a reload; a
 * lenient parse costs somebody's afternoon and says nothing at all.
 *
 * ── What v2 added over v1, in one paragraph ─────────────────────────────────
 *
 * A HEADER THAT CARRIES THE BOOK'S FURNITURE — the chapter starts the engine
 * detected, the measured typography, and the LOOSE apparatus (a printed
 * reference number with no note under it, a note nothing points at) — and, on
 * every note row, the `refs` that say where in the body its number was printed.
 * All four exist so that the renderer draws structure rather than deriving it:
 * a marker is an element bound to a note id, and a marker with nobody to bind to
 * is a flag in the margin instead of a silence.
 */

/** The format this program reads. A file declaring anything else is refused. */
export const BOOK_FILE_VERSION = 2;

/** Refusals from this module, named so a caller can tell them from anything else. */
export class BookFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookFileError';
  }
}

/**
 * Where a block sat on its page, in the render frame of `page`.
 *
 * A merged block's box is composed rather than dropped — origin from the first
 * part, height summed, width the union — and src/vlm/book-file.ts's header
 * explains at length what survives that addition and why it is worth keeping.
 */
export interface BookBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Where a note's number was printed in the body: a block, and a character range
 * inside its text.
 *
 * AN OFFSET AND A LENGTH, NOT A STRING TO SEARCH FOR. The same digits appear
 * five times on a page of a book with fifty notes on it, so a marker found by
 * matching text is a marker that lands on whichever occurrence came first. The
 * engine resolved it once, at reflow, with the page in front of it; this side
 * draws exactly where it was told.
 */
export interface BookRef {
  /** The body block the number was printed in. */
  block: string;
  /** Where in that block's text the marker starts, in characters. */
  at: number;
  /** How many characters of it the marker is. */
  len: number;
}

/**
 * One block of the finished book — one row of the file.
 *
 * A PARAGRAPH, A HEADING, A NOTE OR A FIGURE, whole. Never half of one, never
 * two of them, and never a page.
 */
export interface BookRow {
  /**
   * The block's name, minted once and never reused — `b<page>-<order>` of its
   * first banked answer, `b<page>-<order>#<ordinal>` for a note cut out of a
   * footnote block, `b<page>-<order>/<n>` for a half of a user split.
   *
   * IDENTITY IS THIS AND ONLY THIS. `page` below is an estimate and addresses
   * nothing; see the engine's own header for the whole of that argument.
   */
  id: string;
  /**
   * The dots category, in the ENGINE's spelling — `Text`, `Section-header`,
   * `Footnote`. Typed as a string rather than as a union because the union lives
   * in the engine (`DotsCategory`, src/vlm/dots.ts) and the app never imports the
   * engine; a category this build has no colour for is drawn in the fallback grey
   * and named as unknown, which is `shared/categories.ts`'s standing rule.
   */
  category: string;
  /** Dehyphenated, reflowed, page turns resolved. The text, once and finished. */
  text: string;
  /** The page this block STARTED on — a rough estimate, and never an address. */
  page: number;
  /** Every page it touches, in order. One entry for a block that stayed put. */
  pages: number[];
  box: BookBox;
  /** The page's render size, so a width can be read as a fraction of a column. */
  pageWidth: number;
  pageHeight: number;
  /** The banked answers this block was made of, `page:order[:part]`, in order. */
  src: string[];
  /** Which note of its banked block this is, from 0. Set on a Footnote row only. */
  note?: number;
  /**
   * Where this note's number was printed. Set on a Footnote row that something
   * points at, absent on every other kind — and absent on a note NOTHING points
   * at, which is what the header's `loose.notes` is a list of.
   */
  refs?: BookRef[];
}

/**
 * A place the book divides, as the engine detected it.
 *
 * A SEED AND NOT A DECISION. Ownership passes to the ops the first time somebody
 * moves, renames or removes one (docs/RENDERER.md §2); until then this is what
 * the rules on the sheet are drawn from.
 */
export interface BookChapter {
  /** The block the rule sits above. */
  id: string;
  title: string;
  /** How the engine decided it, where it said. Nothing is keyed to this. */
  kind?: string;
}

/** One category's measured size, as a fact and as a ratio of the body's. */
export interface BookTypographyCategory {
  /** The median line height of this category's blocks, in render pixels. */
  medianPx: number;
  /** `medianPx` over the body's, clamped — what a stylesheet writes as `em`. */
  ratio: number;
  /** How many blocks it was taken from. */
  samples: number;
}

/**
 * What this book's type says about itself, measured off the boxes.
 *
 * NULL IS AN ORDINARY ANSWER AND IS NOT A HOLE. A book whose boxes gave fewer
 * than four samples of a category has nothing measured to say about it, and the
 * engine writes nothing rather than a number derived from one rectangle. What
 * stands in its place is the base sheet's own ratio, which is a documented rule
 * and not a fallback: see `src/vlm/dots-book.ts`'s STYLESHEET_BASE.
 */
export interface BookTypography {
  /** The median line height of the book's body column, in render pixels. */
  bodyPx: number;
  /** Keyed by dots category, and only the ones with enough blocks to calibrate. */
  categories: Record<string, BookTypographyCategory>;
}

/**
 * A printed reference number with no note under it.
 *
 * The other half of `loose` from the notes below, and the one that carries what
 * the page actually printed — because the number is all that is left of it. A
 * marker with no note is one of the two LINKING flags this app still keeps
 * (docs/RENDERER.md §0, ruling 7): it is structural, not an OCR suspicion, and it
 * is a thing a person fixes by hand with the `link` op.
 */
export interface BookLooseMarker {
  block: string;
  at: number;
  len: number;
  /** The digits the page printed, as text. */
  printed: string;
}

/** The apparatus that did not join up, both directions. */
export interface BookLoose {
  /** Numbers in the body with no note carrying them. */
  markers: BookLooseMarker[];
  /** Note rows nothing in the body points at, by id. */
  notes: string[];
}

/** The file's first line — everything about the book that is not a block. */
export interface BookHeader {
  /** How many rows follow. Checked, because a book cut short is a corrupt book. */
  blocks: number;
  chapters: BookChapter[];
  typography: BookTypography | null;
  loose: BookLoose;
}

/** A book file, parsed. */
export interface BookFile {
  header: BookHeader;
  rows: BookRow[];
}

/**
 * THE ANSWER TO `book:load` — the file, plus the one thing the file does not
 * carry.
 *
 * The title is the PROJECT's, read off its catalogue by main, because a book file
 * is a list of blocks and has no idea what the book it came out of is called. It
 * rides along here rather than being asked for separately so that a pane has one
 * question to ask and one answer to draw.
 */
export interface BookLoad {
  title: string;
  rows: BookRow[];
  chapters: BookChapter[];
  typography: BookTypography | null;
  loose: BookLoose;
}

/**
 * The book, or the sentence saying why there is not one.
 *
 * NOT A REJECTION, on `PdfBlocksOutcome`'s rule and for its exact reason: "this
 * book has never been read" and "the engine would not reflow this bank" are
 * ordinary answers a person should meet as a sentence on the paper rather than
 * as a broken tab. A rejection across the bridge also arrives wearing Electron's
 * own wrapper — the channel's name, twice-prefixed with `Error:` — and a page of
 * warm ivory paper is not the place to put that.
 */
export type BookOutcome =
  | ({ ok: true } & BookLoad)
  | { ok: false; reason: string };

/** A finite number, or null — the one test every numeric field below goes through. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A whole number at or above zero, or null. Offsets, lengths, ordinals, pages. */
function countOf(value: unknown): number | null {
  const found = numberOf(value);
  return found === null || !Number.isInteger(found) || found < 0 ? null : found;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{x1,y1,x2,y2}`, all four finite, or null. */
function boxOf(value: unknown): BookBox | null {
  const row = objectOf(value);
  if (row === null) return null;
  const x1 = numberOf(row['x1']);
  const y1 = numberOf(row['y1']);
  const x2 = numberOf(row['x2']);
  const y2 = numberOf(row['y2']);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  return { x1, y1, x2, y2 };
}

/**
 * One `{block, at, len}`, or null.
 *
 * `len` MUST BE AT LEAST ONE, which is the only one of these tests that is a
 * judgement rather than a type check: a marker of zero characters is a marker
 * that cannot be drawn, clicked or struck, and drawing it as an empty span would
 * put an invisible thing in the margin flags' place.
 */
function refOf(value: unknown): BookRef | null {
  const row = objectOf(value);
  if (row === null) return null;
  const block = row['block'];
  const at = countOf(row['at']);
  const len = countOf(row['len']);
  if (typeof block !== 'string' || block.length === 0 || at === null || len === null || len < 1) {
    return null;
  }
  return { block, at, len };
}

/**
 * The header, field by field.
 *
 * EVERY FIELD IS REQUIRED, including the two that are usually empty. A file with
 * no `loose` is not a file with nothing loose in it — it is a file written by
 * something that does not know what loose apparatus is, which is exactly the
 * drift the version number and this function exist to catch.
 */
function headerOf(line: string): BookHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new BookFileError(`the book's first line is not JSON (${(err as Error).message}).`);
  }
  const row = objectOf(parsed);
  if (row === null) throw new BookFileError('the book\'s first line is not an object, so it is not a header.');

  const version = row['book'];
  if (version !== BOOK_FILE_VERSION) {
    throw new BookFileError(
      `this book is written in format ${String(version)} and this app reads format `
      + `${BOOK_FILE_VERSION}. It was made by a different build of the engine.`,
    );
  }
  const blocks = countOf(row['blocks']);
  if (blocks === null) throw new BookFileError('the book\'s header does not say how many blocks it has.');

  const rawChapters = row['chapters'];
  if (!Array.isArray(rawChapters)) throw new BookFileError('the book\'s header carries no chapter list.');
  const chapters: BookChapter[] = [];
  for (const [at, candidate] of rawChapters.entries()) {
    const entry = objectOf(candidate);
    const id = entry === null ? undefined : entry['id'];
    const title = entry === null ? undefined : entry['title'];
    if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') {
      throw new BookFileError(`chapter ${at + 1} in this book names no block, or has no title.`);
    }
    const kind = entry === null ? undefined : entry['kind'];
    if (kind !== undefined && typeof kind !== 'string') {
      throw new BookFileError(`chapter ${at + 1} in this book says what kind it is in something that is not a word.`);
    }
    chapters.push(kind === undefined ? { id, title } : { id, title, kind });
  }

  const typography = typographyOf(row['typography']);

  const rawLoose = objectOf(row['loose']);
  if (rawLoose === null) {
    throw new BookFileError('the book\'s header does not say what apparatus was left unlinked.');
  }
  const rawMarkers = rawLoose['markers'];
  const rawNotes = rawLoose['notes'];
  if (!Array.isArray(rawMarkers) || !Array.isArray(rawNotes)) {
    throw new BookFileError('the book\'s record of unlinked apparatus is not two lists.');
  }
  const markers: BookLooseMarker[] = [];
  for (const [at, candidate] of rawMarkers.entries()) {
    const ref = refOf(candidate);
    const printed = objectOf(candidate)?.['printed'];
    if (ref === null || typeof printed !== 'string' || printed.length === 0) {
      throw new BookFileError(`unlinked reference ${at + 1} does not say where in the book it was printed.`);
    }
    markers.push({ ...ref, printed });
  }
  const notes: string[] = [];
  for (const [at, candidate] of rawNotes.entries()) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new BookFileError(`unlinked note ${at + 1} has no name, and a name is the only thing that names one.`);
    }
    notes.push(candidate);
  }

  return { blocks, chapters, typography, loose: { markers, notes } };
}

/** The measured type, or null where the book gave the engine too little to measure. */
function typographyOf(value: unknown): BookTypography | null {
  if (value === null) return null;
  const row = objectOf(value);
  if (row === null) throw new BookFileError('the book\'s measured typography is not an object.');
  const bodyPx = numberOf(row['bodyPx']);
  if (bodyPx === null) throw new BookFileError('the book\'s measured typography has no body size in it.');
  const rawCategories = objectOf(row['categories']);
  if (rawCategories === null) {
    throw new BookFileError('the book\'s measured typography lists no categories.');
  }
  const categories: Record<string, BookTypographyCategory> = {};
  for (const [name, candidate] of Object.entries(rawCategories)) {
    const entry = objectOf(candidate);
    const medianPx = entry === null ? null : numberOf(entry['medianPx']);
    const ratio = entry === null ? null : numberOf(entry['ratio']);
    const samples = entry === null ? null : countOf(entry['samples']);
    if (medianPx === null || ratio === null || samples === null) {
      throw new BookFileError(`the measured size of this book's ${name} blocks is not a measurement.`);
    }
    categories[name] = { medianPx, ratio, samples };
  }
  return { bodyPx, categories };
}

/** One row, field by field. `at` is its line number, for a sentence about a row with no id. */
function rowOf(line: string, at: number, seen: Set<string>): BookRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new BookFileError(`block ${at} of this book is not JSON (${(err as Error).message}).`);
  }
  const row = objectOf(parsed);
  if (row === null) throw new BookFileError(`block ${at} of this book is not an object.`);

  const id = row['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new BookFileError(`block ${at} of this book has no id, and an id is the only thing that names one.`);
  }
  // Two blocks of one name is the failure every op in the project would inherit:
  // a strike would strike whichever the reader found first.
  if (seen.has(id)) throw new BookFileError(`two blocks in this book are called "${id}".`);
  seen.add(id);

  const category = row['category'];
  const text = row['text'];
  if (typeof category !== 'string' || category.length === 0 || typeof text !== 'string') {
    throw new BookFileError(`block "${id}" is missing its text or its category.`);
  }
  const page = countOf(row['page']);
  const box = boxOf(row['box']);
  const pageWidth = numberOf(row['pageWidth']);
  const pageHeight = numberOf(row['pageHeight']);
  const rawPages = row['pages'];
  if (page === null || box === null || pageWidth === null || pageHeight === null
    || !Array.isArray(rawPages) || rawPages.length === 0) {
    throw new BookFileError(`block "${id}" is missing its place in the book.`);
  }
  const pages: number[] = [];
  for (const candidate of rawPages) {
    const found = countOf(candidate);
    if (found === null) throw new BookFileError(`block "${id}" claims a page that is not a page number.`);
    pages.push(found);
  }
  const rawSrc = row['src'];
  if (!Array.isArray(rawSrc)) throw new BookFileError(`block "${id}" does not say which answers it was made from.`);
  const src: string[] = [];
  for (const candidate of rawSrc) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new BookFileError(`block "${id}" was made from something that is not a banked answer.`);
    }
    src.push(candidate);
  }

  const made: BookRow = { id, category, text, page, pages, box, pageWidth, pageHeight, src };

  const note = row['note'];
  if (note !== undefined) {
    const ordinal = countOf(note);
    if (ordinal === null) throw new BookFileError(`block "${id}" is a note whose ordinal is not a number.`);
    made.note = ordinal;
  }
  const refs = row['refs'];
  if (refs !== undefined) {
    if (!Array.isArray(refs)) throw new BookFileError(`block "${id}" carries references that are not a list.`);
    const found: BookRef[] = [];
    for (const [which, candidate] of refs.entries()) {
      const ref = refOf(candidate);
      if (ref === null) {
        throw new BookFileError(`reference ${which + 1} of block "${id}" does not say where in the body it was printed.`);
      }
      found.push(ref);
    }
    made.refs = found;
  }
  return made;
}

/**
 * Read a book file back, or say exactly what about it is not a book.
 *
 * ── The cross-checks, which are the ones worth having ───────────────────────
 *
 * Every field above is checked for BEING what it claims to be; these last three
 * check that the file AGREES WITH ITSELF, and they are the ones that catch a real
 * corruption rather than a typo. A reference into a block the file does not hold
 * is a marker that can never be drawn; a loose note naming a row that is not there
 * is a flag in the margin about nothing. Both would be invisible on the page and
 * both mean the file was written by two things that disagree — which is precisely
 * the state this whole format exists to make impossible.
 *
 * THE BLOCK COUNT IS CHECKED FOR THE SAME REASON, and it is the one that catches
 * the ordinary disaster: a run that died mid-write leaves a file whose every line
 * parses and whose last chapter is missing. JSONL makes that recoverable in
 * principle; the header's count is what turns it from a silent truncation into a
 * sentence and a re-run.
 */
export function parseBookFile(text: string): BookFile {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const head = lines.shift();
  if (head === undefined) throw new BookFileError('the book file is empty, so it is not a book.');
  const header = headerOf(head);

  const rows: BookRow[] = [];
  const seen = new Set<string>();
  for (const [at, line] of lines.entries()) rows.push(rowOf(line, at + 1, seen));

  if (rows.length !== header.blocks) {
    throw new BookFileError(
      `this book says it has ${header.blocks} blocks and carries ${rows.length}. It was cut short `
      + 'while it was being written.',
    );
  }
  /*
   * EVERY MARKER IN ONE PLACE, then checked as a set. A reference is a range of
   * characters inside somebody else's text, so the two ways it can be wrong are
   * "that text is not that long" and "two of them claim the same characters" —
   * and both are invisible in the file and fatal on the page, where the renderer
   * cuts each block's text at these offsets and would either cut past the end or
   * cut the same run twice. Checked here, once, so that nothing downstream has to
   * hold an opinion about a marker it cannot draw.
   */
  const texts = new Map(rows.map((row) => [row.id, row.text] as const));
  const spans = new Map<string, { at: number; len: number; by: string }[]>();
  const claim = (block: string, at: number, len: number, by: string): void => {
    const text = texts.get(block);
    if (text === undefined) {
      throw new BookFileError(`${by} is recorded in "${block}", which this book has no block called.`);
    }
    if (at + len > text.length) {
      throw new BookFileError(`${by} is recorded past the end of the words in "${block}".`);
    }
    const already = spans.get(block);
    if (already === undefined) spans.set(block, [{ at, len, by }]);
    else already.push({ at, len, by });
  };
  for (const row of rows) {
    for (const ref of row.refs ?? []) claim(ref.block, ref.at, ref.len, `the number for note "${row.id}"`);
  }
  for (const marker of header.loose.markers) {
    claim(marker.block, marker.at, marker.len, `an unlinked reference "${marker.printed}"`);
  }
  for (const [block, claims] of spans) {
    const sorted = [...claims].sort((one, other) => one.at - other.at);
    let end = 0;
    for (const span of sorted) {
      if (span.at < end) {
        throw new BookFileError(`two reference numbers claim the same words in "${block}" — ${span.by} is one of them.`);
      }
      end = span.at + span.len;
    }
  }
  for (const id of header.loose.notes) {
    if (!seen.has(id)) {
      throw new BookFileError(`"${id}" is listed as an unlinked note and is not a block this book holds.`);
    }
  }
  for (const chapter of header.chapters) {
    if (!seen.has(chapter.id)) {
      throw new BookFileError(`a chapter starts at "${chapter.id}", which this book has no block called.`);
    }
  }
  return { header, rows };
}
