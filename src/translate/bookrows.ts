/**
 * translate/bookrows — the book file, read as things to translate.
 *
 * ── WHY THE SOURCE MOVED OFF THE EPUB ───────────────────────────────────────
 *
 * `blocks.ts` finds what to translate by walking a rendered document: every
 * element `dots-book.ts` stamped, innermost stamp wins, containers taken apart
 * into the items that go in one request. That was the only index available while
 * the app's working form was an EPUB, and it works — but it reads the words back
 * out of markup that was written FROM the words, and it names each block by the
 * `data-bf-src` the emitter stamped on it, which is a coordinate in the reading
 * bank rather than a name for the paragraph.
 *
 * A BOOK FILE IS THE SAME BOOK WITH NEITHER OF THOSE HOPS IN IT
 * (docs/BOOK-FILE.md). One row per block, each with its own text in the dialect
 * the vision model answers in, each with an ID that is the block's name for as
 * long as the book exists (docs/RENDERER.md §2). So a record about a row is keyed
 * by that id, and everything downstream of the translation — striking a
 * translated paragraph, correcting one sentence of it, translating it again —
 * addresses the same name the source book does. That is the whole of §4: *"same
 * format, parent ids kept verbatim"*.
 *
 * AND THE FILE THIS IS HANDED IS THE MATERIALISED STATE OF A POSITION. Main
 * replays the ops into a book file and hands it over, exactly as it does for
 * `vlm-compile` (electron/book.ts, `materializeBook`) — so a struck row is not in
 * the file at all, and nothing here consults an overlay, a curation or any other
 * record of what somebody decided. What is in the file is what the book says.
 *
 * ── WHAT IS NOT TRANSLATED, AND IT IS `blocks.ts`'s LIST ────────────────────
 *
 * `formula` is notation and `picture` is a crop; both are skipped and counted,
 * for the reasons that file states in full.
 *
 * ── A TABLE IS TRANSLATED NOW, AND THE OLD REFUSAL IS WHY IT CAN BE ─────────
 *
 * This file used to leave every `table` in the source language and name it, on
 * an argument that is still correct and is still obeyed: *a table's text is the
 * vision model's own HTML, so translating it means handing a model `<tr>`,
 * `<td>` and every attribute in them and asking it not to touch any of it, and a
 * table whose columns quietly swapped is worse than a table nobody translated,
 * because it looks fine.*
 *
 * What that argument refuses is sending the GRID. It says nothing against
 * sending the CELLS, and a printed table of contents — which is what the dots
 * model hands back for a contents page — is a table whose every left-hand cell
 * is a chapter title somebody expects to read in their own language. So the
 * grid is taken apart by `tablecells.ts` and each cell of words becomes its own
 * part of one `table` group, travelling in the wire format `run.ts` already
 * sends a cast EPUB's cells in; the tags never leave this process, and the
 * answers are spliced back into the source string's own ranges. A table whose
 * shape this stage cannot read, or whose cells hold markup rather than words, is
 * still left whole and still named — that path did not go away, it stopped being
 * the only one.
 *
 * A FOLIO IS NOT ASKED ABOUT. `VII`, `48`, an empty cell: carried, counted, and
 * never sent — `cellIsCarried` carries the argument.
 *
 * ── AND THE SPINE, WHICH IS NOT MADE OF ROWS ────────────────────────────────
 *
 * Owen's ruling, 2026-08-22, verbatim: *"when i translate, does it translate the
 * chapters in the spine as well? the chapter names on the green dotted lines? if
 * not, id like it to. everything should be translated."*
 *
 * A book file's header carries where the book divides and what each division is
 * called (`chapters`), and those names are what `vlm-compile` puts in the spine,
 * in the nav and at the head of every document — *"THE HEADER IS THE ANSWER AND
 * THERE IS NO SECOND OPINION"* (`spansOf`, src/vlm/compile.ts). They are not
 * rows, so `bookRowPlan` above has never seen one, and until this a translated
 * book came out with English paragraphs under a German contents page.
 *
 * `bookTitlePlan` is the other half of the plan and it is deliberately SMALL:
 * see its own comment for why most titles must not be asked at all.
 *
 * A SHELVED ROW IS NOT SKIPPED — it is not in the book. Furniture and suppressed
 * running heads are rows of a book file so that nothing the model answered is
 * silently gone (docs/BOOK-FILE.md §5), and `vlm-compile` filters them out for
 * the same reason this does: the flow is the book. A row somebody RESTORED is in
 * the flow and translates like any other, wearing `Page-header` as its category —
 * which is why the two furniture categories are translatable here and are not in
 * `blocks.ts`, where they could never appear.
 */
import { parseBookFile, type BookChapter, type BookFile, type BookRow } from '../vlm/book-file.js';
import { headingLabel } from '../vlm/dots-book.js';
import type { GroupKind } from './blocks.js';
import { askableCells, readTableGrid, type TableGrid } from './tablecells.js';

/** A book file this command will not translate. Always says what is wrong. */
export class BookRowsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookRowsError';
  }
}

/**
 * The categories whose words are asked of a model, in the ENGINE's spelling.
 *
 * `blocks.ts`'s `TRANSLATED_CATEGORIES` said the same thing in the emitter's
 * lower-cased attribute spelling; this is the same list against `DotsCategory`,
 * plus the two furniture kinds a restore can put back in the flow.
 */
const TRANSLATED: ReadonlySet<string> = new Set([
  'Caption', 'Footnote', 'List-item', 'Page-footer', 'Page-header',
  'Quote', 'Section-header', 'Text', 'Title',
]);

/** Left exactly as they are, and counted. `blocks.ts` has each one's reason. */
const SKIPPED: ReadonlySet<string> = new Set(['Formula', 'Picture']);

/** One row to translate: its words, and the name a record about it is keyed by. */
export interface BookBlock {
  /**
   * The row's own id — `b12-3`, `b12-3#1`, `b2-3/1`. The record's position.
   *
   * EVERY CELL OF A TABLE WEARS THE ROW'S OWN ID, unsuffixed, and that is not an
   * oversight. A cell is not a block of the book and has no name of its own in
   * any format this project has; what a record about a Table row holds is the
   * whole grid, reassembled here out of the cells' answers, because a Table
   * ROW's text is the whole grid and a record's text stands in place of a row's
   * (`records.ts`). Inventing a `#c3` position instead would put a row in the
   * file that the reader on the other side has no block for — it would be
   * reported as stale, correctly, and the table would come out in German.
   */
  id: string;
  /** The dots category, engine spelling, for the log and for the group rule. */
  category: string;
  /** The flowing block's own text, in the dialect `textmask.ts` masks. */
  text: string;
  /** The page it started on, for naming it in a refusal. */
  page: number;
  /**
   * `table` parts only: which cell of `BookRowGroup.grid` these words came out
   * of. It is how the answer finds its way back into the source string's own
   * range, and it is an index rather than a name for the reason `id` states.
   */
  cell?: number;
}

/** Rows that travel in one request, on `blocks.ts`'s own definition of a group. */
export interface BookRowGroup {
  kind: GroupKind;
  /** Never empty. In reading order, which is the order they are rendered in. */
  parts: BookBlock[];
  /**
   * `table` only: cells per row of the PAYLOAD, summing to `parts.length` —
   * `planChunks`' second argument, and the shape the answer is read back
   * against. Empty for every other kind, which is what those kinds send.
   */
  rowSizes: number[];
  /**
   * `table` only: the grid these parts are the words of, for the splice that
   * puts the answers back. Absent for every other kind.
   */
  grid?: TableGrid;
}

export interface BookRowPlan {
  groups: BookRowGroup[];
  /** Skipped category → how many rows. */
  skipped: Map<string, number>;
  /**
   * Rows left in the source language before anything was asked, each as a
   * sentence — a table whose grid this stage cannot read. They reach the
   * completion line with everything else the run could not do, because a count
   * with no name behind it is a number nobody can act on (ARCHITECTURE §8).
   */
  kept: string[];
  /**
   * Decisions that changed what the run is about to do without leaving anything
   * untranslated — a table of nothing but folios, which is a real page of a real
   * book and is not a failure. `findBlocks`' `notes`, said in the same place and
   * for the same reason: the log is where a decision goes when it is neither a
   * refusal nor silence.
   */
  notes: string[];
  /**
   * Cells this plan decided not to ask about — blanks, numbers and folios,
   * across every table it could read (`cellIsCarried`, tablecells.ts).
   *
   * HOW MANY TABLES AND HOW MANY CELLS ARE COUNTED BY THE CALLER, one step
   * later, and deliberately not here: a table can still drop out after this
   * function has approved it — its words may carry the characters this stage
   * sends markers in — and a figure saying "3 tables translated" has to be
   * counted where the third one's fate is actually known. This one is a fact
   * about the BOOK rather than about the run, which is why it can be stated
   * here: a folio is a folio whatever happens to the grid around it.
   */
  tableCarried: number;
}

/** Read a book file, or say exactly what about it is not one. */
export function readBookFile(text: string, where: string): BookFile {
  try {
    return parseBookFile(text);
  } catch (err) {
    throw new BookRowsError(
      `${where} is not a book file this command can translate: ${(err as Error).message}`,
    );
  }
}

/**
 * Which list a run of items belongs to, on the EMITTER's own test.
 *
 * `buildChapterBody` opens an `<ol>` for an item that begins with a numeral and
 * a `<ul>` for one that does not, and closes the open list when that answer
 * changes (`dots-book.ts`, the `List-item` arm). So a run of items that would be
 * ONE list in the book is a run of items with the same answer here — which is
 * exactly the group `blocks.ts` finds when it walks a `<ul>` in a cast, arrived
 * at from the rows the cast was written from rather than from the cast.
 */
function listKind(row: BookRow): string {
  return /^\d+[.)]/.test(row.text) ? 'ol' : 'ul';
}

/**
 * Every row of the book that has words in it, grouped, in reading order.
 *
 * ── ONE GROUP RULE, AND IT IS THE ONE THE EMITTER ALREADY OBEYS ─────────────
 *
 * A run of consecutive `List-item` rows is one list in the book and goes in one
 * request, which is the whole argument `run.ts`'s header makes for chunking: an
 * item translated without its list has lost the list, and six items each rendered
 * in whatever construction the model picked for that item do not read as a list
 * any more. Nothing else is grouped. A `Quote` block writes its own
 * `<blockquote>` (`blockElement`, dots-book.ts), so consecutive quotes are
 * separate quotations and joining them would be this stage inventing a structure
 * the book does not have — the refusal `blocks.ts` makes about every container it
 * cannot take apart cleanly, made here about one it would be making up.
 */
export function bookRowPlan(book: BookFile, where: string): BookRowPlan {
  const skipped = new Map<string, number>();
  const kept: string[] = [];
  const notes: string[] = [];
  const groups: BookRowGroup[] = [];
  let tableCarried = 0;
  /** The open list's tag, or null when the last row was not a list item. */
  let openList: string | null = null;

  for (const row of book.rows) {
    // Not skipped — NOT IN THE BOOK. See the header: the flow is the book, and
    // `vlm-compile` filters the shelf out on the same line of the same argument.
    if (row.shelf !== undefined) { openList = null; continue; }

    if (SKIPPED.has(row.category)) {
      skipped.set(row.category, (skipped.get(row.category) ?? 0) + 1);
      openList = null;
      continue;
    }
    if (row.category === 'Table') {
      /*
       * A TABLE IS TAKEN APART INTO CELLS, AND THE MODEL NEVER SEES THE GRID.
       *
       * The old refusal here was right about one thing and wrong about what
       * followed from it. A book file row IS the grid, as one string, so sending
       * the row's text would hand a model `<tr>`, `<td>` and every attribute in
       * them and ask it not to touch any of it — and a table whose columns
       * quietly swapped is worse than a table nobody translated, because it
       * looks fine. All of that stands. What did not follow is "so leave it in
       * German": the cells are separable, `tablecells.ts` separates them with
       * the parser this project already has, and each cell travels as a plain
       * string with no markup in it at all. The grid is put back together by
       * splicing the answers into the source string's own ranges, so the tags,
       * the attributes and the cell order are untouched BY CONSTRUCTION rather
       * than by asking a model nicely.
       *
       * The old outcome is still here and is still exactly the old outcome — a
       * grid this stage cannot read is left whole, counted and named. It is now
       * the exception rather than the rule, which is what a printed table of
       * contents coming back as a Table row made necessary: every chapter title
       * in the book, sitting in the one category that was never translated.
       */
      openList = null;
      const read = readTableGrid(row.text);
      if ('complaint' in read) {
        skipped.set('Table', (skipped.get('Table') ?? 0) + 1);
        kept.push(`${where} block ${row.id} (Table, page ${row.page}) — ${read.complaint}`);
        continue;
      }
      const ask = askableCells(read.grid);
      tableCarried += ask.carried;
      if (ask.ask.length === 0) {
        /*
         * A TABLE OF NOTHING BUT NUMBERS IS NOT A FAILURE and must not reach
         * `kept`, which is the list a run prints under "LEFT IN THE SOURCE
         * LANGUAGE — the model could not translate them". Nothing was asked
         * because there was nothing to ask; the cells are in the book exactly as
         * they were printed, which is the correct rendering of a page of folios.
         * It is a NOTE — said out loud, and not counted as a defeat.
         */
        notes.push(
          `${where} block ${row.id} (Table, page ${row.page}) holds ${ask.carried} cell(s) and not `
          + 'one of them has words in it — numbers, folios and blanks — so nothing was asked and the '
          + 'grid is in the book exactly as it was printed',
        );
        continue;
      }
      groups.push({
        kind: 'table',
        parts: ask.ask.map((index) => ({
          id: row.id,
          category: row.category,
          text: read.grid.cells[index]!.text,
          page: row.page,
          cell: index,
        })),
        rowSizes: ask.rowSizes,
        grid: read.grid,
      });
      continue;
    }
    if (!TRANSLATED.has(row.category)) {
      /*
       * A CATEGORY THIS FILE HAS NO RULE FOR STOPS THE RUN — `blocks.ts`'s rule,
       * for its reason: the two silent outcomes are translating something that
       * should not be and skipping prose, and both are invisible in the output.
       */
      throw new BookRowsError(
        `${where} block ${row.id} is categorised "${row.category}", which this stage has no rule `
        + 'for. Every category is either translated or deliberately skipped and counted; a new one '
        + 'means src/translate/bookrows.ts has fallen behind the engine.',
      );
    }

    // A row with nothing in it has nothing to ask a model, and a refusal here
    // would fail a book over whitespace — `blocks.ts`'s `blank` test, verbatim
    // in intent.
    if (row.text.trim().length === 0) { openList = null; continue; }

    const block: BookBlock = {
      id: row.id,
      category: row.category,
      text: row.text,
      page: row.page,
    };
    if (row.category !== 'List-item') {
      openList = null;
      groups.push({ kind: 'single', parts: [block], rowSizes: [] });
      continue;
    }
    const tag = listKind(row);
    const last = groups[groups.length - 1];
    if (openList === tag && last !== undefined && last.kind === 'list') {
      last.parts.push(block);
      continue;
    }
    openList = tag;
    groups.push({ kind: 'list', parts: [block], rowSizes: [] });
  }

  return { groups, skipped, kept, notes, tableCarried };
}

/** One division whose name has to be asked of the model. See `bookTitlePlan`. */
export interface BookTitle {
  /** The division's id — the block it sits above, and the record's position. */
  id: string;
  /** The one line the contents gets, exactly as the book file holds it. */
  title: string;
}

/**
 * Which row a division's title was taken from, when it can be PROVED.
 *
 * The mirror of `titledFrom` (app/shared/materialize.ts), which is itself the
 * mirror of `relabelNav`'s rule (`run.ts`) one format over, and the three of them
 * have to agree about one string or this asks for titles the app is going to
 * throw away and the app carries titles this never asked for.
 *
 * The seed's own rule is what makes the proof available: a division's title is
 * `sectionName`'s answer over its span (src/vlm/dots-book.ts) — the page
 * classifier's composed label if there is one, otherwise the FIRST Title or
 * Section-header in the span, folded by `headingLabel`. So this looks in the same
 * place, folds with the same function — the original, imported, rather than a
 * fourth copy of it — and compares the same string. The first heading decides:
 * finding a LATER heading that happens to match would be proving the title is a
 * copy of a row the seed never read it off.
 */
function titledFrom(
  chapter: BookChapter,
  rows: readonly BookRow[],
  from: number | undefined,
  to: number,
): BookRow | null {
  if (from === undefined) return null;
  for (const row of rows.slice(from, to)) {
    if (row.category !== 'Title' && row.category !== 'Section-header') continue;
    return headingLabel(row.text) === chapter.title ? row : null;
  }
  return null;
}

/**
 * The divisions whose names this run has to ask about — and it is the SHORT list.
 *
 * ── WHY MOST TITLES ARE NOT IN IT, WHICH IS THE WHOLE OF THE DESIGN ─────────
 *
 * An ordinary chapter's title is a COPY of the heading printed at the top of it.
 * That heading is a row, this run translates it like any other paragraph, and
 * materialization reads the title straight off the translated heading for
 * nothing (`translated`, app/shared/materialize.ts). Asking the model for the
 * title as well would be asking one question twice and shipping both answers —
 * a contents page reading "The Coming Struggle" over a chapter headed "The
 * Struggle to Come", which is `relabelNav`'s own measured failure and the reason
 * that function proves a copy rather than translating a label.
 *
 * WHAT IS LEFT IS EXACTLY WHAT NOTHING ELSE CAN ANSWER FOR:
 *
 *  - A DIVISION SOMEBODY RENAMED. `{op:'chapter', set|rename, title}` puts a
 *    person's own words in the header (app/shared/ops.ts) and no row of the book
 *    says them, so no proof is available and none is possible.
 *  - A PART DIVIDER. Its label is composed by the page classifier out of two
 *    blocks — "PART III" on one line and "RESISTANCE" on the next, which only
 *    `partVerdict` knows belong together — so it is not any single heading's
 *    text and cannot be a copy of one.
 *
 * ── AND THE ONE THING IT DOES NOT COVER, NAMED RATHER THAN HIDDEN ───────────
 *
 * A title that IS a provable copy of a heading THE MODEL THEN REFUSED. The proof
 * holds, so nothing is asked here; the heading comes back in the source language,
 * so there is no translated heading to derive from; and the title carries. That
 * is exactly what happened before this existed, it is reported by name at
 * materialization (`Translated.untitled`), and closing it would mean planning the
 * titles after the work — which would leave the run's own progress denominator
 * growing halfway through, a bar reporting a quantity nobody asked about. The
 * partial is honest and the alternative bends something that is load-bearing.
 */
export function bookTitlePlan(book: BookFile): BookTitle[] {
  const at = new Map<string, number>();
  for (const [index, row] of book.rows.entries()) at.set(row.id, index);

  const asked: BookTitle[] = [];
  for (const [which, chapter] of book.chapters.entries()) {
    // A division with no name has nothing to translate. The book file's own
    // parser accepts one (a person may want a rule across the page and no
    // words on it), so this is a real state and not a defensive test.
    if (chapter.title.trim().length === 0) continue;
    const next = book.chapters[which + 1];
    const to = next === undefined ? book.rows.length : at.get(next.id) ?? book.rows.length;
    if (titledFrom(chapter, book.rows, at.get(chapter.id), to) !== null) continue;
    asked.push({ id: chapter.id, title: chapter.title });
  }
  return asked;
}
