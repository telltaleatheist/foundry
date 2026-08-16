/**
 * vlm/book-file — THE BOOK, ONCE, IN ONE FILE.
 *
 * ── What this is, and the ruling that produced it ───────────────────────────
 *
 * The bank is the model's raw answer, one row per PAGE, holding a JSON string of
 * boxes exactly as the model wrote them. It knows nothing about a paragraph: a
 * sentence broken by a column is two halves with a hyphen between them, and a
 * paragraph the printer broke across a leaf is two blocks on two pages. Every
 * rule that fixes those has always run at ASSEMBLY — freshly, on every render,
 * for the whole life of the project — which meant the same arithmetic was
 * repeated forever and never settled, and the seams the rule could not decide
 * ("4 page turn(s) left as two paragraphs — join them by hand") could not be
 * fixed once and stay fixed, because there was no file to fix them in.
 *
 * The user's ruling: *"lets render a facsimile pdf the moment the vlm finishes,
 * and then reflow the bank immediately. fix hyphenated words, join paragraphs
 * split across pages, etc… i think we should merge the bank into a single file,
 * merge blocks that were split by pages, and keep page numbers as a rough
 * estimate IF WE CAN. give each block a unique ID after merging the split ones
 * back together, and make sure we have their position on the page."*
 *
 * So this is the file the rest of the program works from. Everything above it —
 * the pages, the boxes, the hyphens, the page turns — is finished business by
 * the time it exists.
 *
 * ── PAGE NUMBERS ARE KEPT AND ARE NOT LOAD-BEARING ──────────────────────────
 *
 * *"Page provenance is fucking this whole thing up and making everything
 * confusing… i guess they can stay. they just shouldnt be trusted."* That is
 * exactly the status they have here. `page` is where a block STARTED, it is a
 * rough estimate for anything that was joined across a leaf, and NOTHING in this
 * format is addressed by it. Identity is `id` and only `id`. A reader that wants
 * to know which page a sentence was printed on gets an honest approximation; a
 * reader that wants to know WHICH BLOCK gets a name that cannot drift.
 *
 * The exact page-for-page record still exists and is not this file's job: the
 * facsimile PDF is produced from the raw bank the moment the reading finishes,
 * before any of this runs, and it is the thing to go back to.
 *
 * ── AND THE BOX SURVIVES THE MERGE, WHICH IS THE INTERESTING PART ───────────
 *
 * A merged paragraph has no box, because it was never on one page. Dropping the
 * geometry would be the easy answer and it would cost the two measurements that
 * are made from it downstream: the type size of every category (a box's height
 * over its line count, `typography.ts`) and the width of the body column. Both
 * would have to become guesses the moment a paragraph crossed a leaf.
 *
 * So the box is composed the way the user described: *"the new one gets the
 * original's position plus the length/width of the one that just joined."* The
 * merged block keeps the FIRST part's origin and grows by the height of every
 * part after it; the width is the union, because a paragraph continues in the
 * same column and the wider of two measurements of one column is the column.
 * The result is a rectangle that is on no page and is right about the only two
 * things anything asks it — how tall a line of this type is, and how wide the
 * text sits — because both are ratios that survive the addition.
 */
import type { DotsBlock, DotsBox, DotsCategory } from './dots.js';
import { splitNotes, type FlowBlock, type FlowBook } from './dots-book.js';

/** The format written into the file, so a reader can refuse a shape it cannot use. */
export const BOOK_FILE_VERSION = 1;

/**
 * One block of the finished book — one row of the file.
 *
 * A PARAGRAPH, A HEADING, A NOTE OR A FIGURE, whole. Never half of one, never
 * two of them, and never a page.
 */
export interface BookRow {
  /**
   * The block's name, minted once and never reused.
   *
   * ── Why it is derived and not a counter ────────────────────────────────────
   *
   * `b<page>-<order>[-<part>]` of the block's FIRST banked answer. A sequential
   * id would be simpler to read and would renumber the entire book the day a
   * better join rule merged one more pair — every op, every chapter marker and
   * every translation record after that point would silently point one block
   * further back, which is the failure this whole format exists to end.
   *
   * The first part's coordinate has the property a name needs: a merge consumes
   * the SECOND block and leaves the first exactly where it was, so re-running the
   * reflow with a better rule changes which ids exist and never what an
   * existing id means. It is also traceable by hand straight back into the bank,
   * which is worth a great deal the first time something looks wrong.
   */
  id: string;
  category: DotsCategory;
  /** Dehyphenated, reflowed, page turns resolved. The text, once and finished. */
  text: string;
  /**
   * The page this block STARTED on — a rough estimate, and never an address.
   * See this file's header: nothing is keyed by it and nothing should be.
   */
  page: number;
  /** Every page it touches, in order. One entry for a block that stayed put. */
  pages: number[];
  /**
   * Where it sits, in the render frame of `page` — see the header for how a
   * merged block's box is composed and what it is still good for.
   */
  box: DotsBox;
  /** The page's render size, so a width can be read as a fraction of a column. */
  pageWidth: number;
  pageHeight: number;
  /**
   * The banked answers this block was made of, `page:order[:part]`, in order.
   *
   * Kept so the file can be REGENERATED from the bank and the ids carried
   * forward, and so anything still keyed to a banked coordinate — a translation
   * record written before this format existed — can be re-keyed without a guess.
   * It is bookkeeping and not an address: nothing addresses a block but `id`.
   */
  src: string[];
  /**
   * Which note of its banked block this is, counted from 0 — set on a `Footnote`
   * row and absent on every other kind.
   *
   * The model answers the whole foot of a page as ONE block, so five notes
   * arrive as one answer with newlines between them. `splitNotes` cuts them
   * apart, and it happens HERE rather than at assembly for the reason everything
   * else in this file happens here: a note is a thing a person strikes, so it
   * has to be a thing with a name.
   *
   * Kept beside the id rather than only encoded in it because the ordinal is a
   * fact worth reading — it is what the old overlay grammar's `note` field
   * pointed at, so a decision recorded before this format existed can be
   * re-keyed by looking rather than by parsing a string.
   */
  note?: number;
}

/** `page:order` for a whole answer element, `page:order:part` for a piece of one. */
function coordinate(block: DotsBlock): string {
  return block.part === 0
    ? `${block.page}:${block.order}`
    : `${block.page}:${block.order}:${block.part}`;
}

/**
 * The box a merged block gets — the user's rule, applied part by part.
 *
 * ORIGIN FROM THE FIRST PART, HEIGHT FROM ALL OF THEM, WIDTH THE UNION. A block
 * that never crossed a leaf is its own box, byte for byte, which is what makes
 * this safe to run over every block rather than only over the merged ones.
 */
function mergedBox(parts: readonly DotsBlock[]): DotsBox {
  const first = parts[0]!;
  let height = 0;
  let x1 = first.box.x1;
  let x2 = first.box.x2;
  for (const part of parts) {
    height += part.box.y2 - part.box.y1;
    x1 = Math.min(x1, part.box.x1);
    x2 = Math.max(x2, part.box.x2);
  }
  return { x1, y1: first.box.y1, x2, y2: first.box.y1 + height };
}

/**
 * How much of a footnote area a note takes up — its characters, not its lines.
 *
 * COUNTING LINES WAS THE OBVIOUS THING AND IT IS WRONG HERE. The model reflows:
 * a note that the printer set over three lines arrives as one long line of text
 * with no break in it at all, so a line count says "1" about a note occupying a
 * third of the area and "1" about the one-line note beside it, and the two get
 * equal shares of a rectangle they very much do not equally fill. Measured on
 * the book in hand: three notes on page 2, one counted line each, one of them
 * plainly twice the length of the others.
 *
 * Characters have neither problem. Notes are set in ONE size and ONE column, so
 * the height a note occupies is proportional to how much of it there is — which
 * makes this a description of the page rather than a guess about it, and it is
 * indifferent to whether the model kept the breaks.
 */
function textWeight(text: string): number {
  return Math.max(1, text.replace(/\s+/g, ' ').trim().length);
}

/**
 * One flow block as one or more rows.
 *
 * ── A FOOTNOTE BLOCK IS SEVERAL NOTES AND BECOMES SEVERAL ROWS ──────────────
 *
 * The model answers the whole foot of a page as ONE block, so five notes arrive
 * as one answer with newlines between them, and until now they were cut apart at
 * assembly — which meant a note had no name until a book was being written, and
 * a person striking one was striking something that did not exist in any file.
 *
 * IT IS SAFE TO CUT THEM HERE because a note does not run over: *"footnotes will
 * always be on the page of the note that contains them, and they will always be
 * complete. standard publishing practice."* Checked against the book in hand
 * before this was built — 16 footnote blocks, 51 notes, not one of them spanning
 * a leaf. A book that breaks the convention costs a long note read as two, which
 * is visible on the page and correctable like anything else here; nothing is
 * lost and nothing is silently wrong.
 *
 * ── THE HEIGHT IS SHARED OUT AND NOT COPIED, WHICH MATTERS ──────────────────
 *
 * The obvious thing is to give every note its block's box. It would be wrong in
 * the one way a box is used: type size is a box's HEIGHT OVER ITS LINE COUNT
 * (`typography.ts`), so three notes each claiming the whole footnote area while
 * carrying a third of its lines would each measure three times the type they are
 * actually set in — and footnote size is exactly what that measurement exists to
 * find. So the area is divided down the notes in proportion to the lines each
 * one holds, stacked in order. They are set in one size and one column, which is
 * what makes the division a description of the page rather than an invention.
 */
export function bookRow(block: FlowBlock): BookRow[] {
  const parts = block.parts.map((part) => part.block);
  const first = parts[0]!;
  const pages: number[] = [];
  for (const part of parts) if (pages[pages.length - 1] !== part.page) pages.push(part.page);
  const box = mergedBox(parts);
  const base = {
    category: block.category,
    page: first.page,
    pages,
    pageWidth: first.pageWidth,
    pageHeight: first.pageHeight,
    src: parts.map(coordinate),
  };
  const id = `b${coordinate(first).replace(/:/g, '-')}`;

  if (block.category !== 'Footnote') {
    return [{ ...base, id, text: block.text, box }];
  }
  const notes = splitNotes(block.text);
  // A Footnote block the splitter finds one note in is one row, named exactly as
  // it would be if the block held five: the id says which note, always, so
  // nothing downstream needs a rule about the single case.
  const weights = notes.map(textWeight);
  const total = weights.reduce((sum, n) => sum + n, 0);
  const height = box.y2 - box.y1;
  let top = box.y1;
  return notes.map((text, ordinal) => {
    const share = (weights[ordinal]! / total) * height;
    const row: BookRow = {
      ...base,
      id: `${id}#${ordinal}`,
      text,
      box: { x1: box.x1, y1: top, x2: box.x2, y2: top + share },
      note: ordinal,
    };
    top += share;
    return row;
  });
}

/**
 * The whole book, in reading order.
 *
 * `flow.blocks` IS THE ANSWER and this function adds nothing to it but names,
 * boxes and the note split: the reflow already dropped the running heads, fused
 * the hyphens, reflowed the print lines, merged the two-line headings and joined
 * the page turns. That is deliberate — this file must never become a second
 * place where the book is decided, or the two will disagree and the one that
 * loses will be the one somebody edited.
 */
export function bookRows(flow: FlowBook): BookRow[] {
  return flow.blocks.flatMap(bookRow);
}

/**
 * The file: a version line, then one row per block.
 *
 * JSONL AND NOT JSON, for the bank's own reason — a line is a record, a reader
 * can stream it, and a file that was cut short costs the rows after the cut
 * rather than the whole book. The header is a row like any other so that the
 * format is one grammar rather than two.
 */
export function formatBookFile(rows: readonly BookRow[]): string {
  const header = JSON.stringify({ book: BOOK_FILE_VERSION, blocks: rows.length });
  return [header, ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
}

export class BookFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookFileError';
  }
}

/**
 * Read one back, or say exactly what about it is not a book.
 *
 * EVERY ROW IS CHECKED AND A BAD ONE TAKES THE FILE DOWN. This is the document
 * every op in the project is keyed to; a file assembled out of the rows that
 * happened to parse is a book with paragraphs silently missing and a curation
 * pointing at blocks that are no longer in it.
 */
export function parseBookFile(text: string): BookRow[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const head = lines.shift();
  if (head === undefined) throw new BookFileError('the file is empty, so it is not a book');
  let header: unknown;
  try {
    header = JSON.parse(head);
  } catch (err) {
    throw new BookFileError(`its first line is not JSON (${(err as Error).message})`);
  }
  const version = (header as { book?: unknown }).book;
  if (version !== BOOK_FILE_VERSION) {
    throw new BookFileError(
      `it declares book format ${String(version)} and this program writes ${BOOK_FILE_VERSION}`,
    );
  }

  const rows: BookRow[] = [];
  const seen = new Set<string>();
  for (const [at, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new BookFileError(`block ${at + 1} is not JSON (${(err as Error).message})`);
    }
    const row = parsed as Partial<BookRow>;
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new BookFileError(`block ${at + 1} has no id, and an id is the only thing that names one`);
    }
    // Two blocks of one name is the failure every op in the project would
    // inherit: a strike would strike whichever the reader found first.
    if (seen.has(row.id)) throw new BookFileError(`two blocks are called "${row.id}"`);
    seen.add(row.id);
    if (typeof row.text !== 'string' || typeof row.category !== 'string') {
      throw new BookFileError(`block "${row.id}" is missing its text or its category`);
    }
    if (typeof row.page !== 'number' || !Array.isArray(row.pages) || row.box === undefined) {
      throw new BookFileError(`block "${row.id}" is missing its place in the book`);
    }
    rows.push(row as BookRow);
  }
  return rows;
}
