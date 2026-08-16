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
 * for the reasons that file states in full. A `table`'s text is the vision
 * model's own HTML — a grid whose meaning is which cell sits under which header —
 * and it is LEFT IN THE SOURCE LANGUAGE and named, which is the decision the
 * records mode already made about tables (`run.ts`, "A TABLE HAS NO RECORD"):
 * there is no cell-by-cell path here, and handing a model `<tr>` and `<td>` and
 * asking it not to touch them is the failure that whole design exists to refuse.
 *
 * A SHELVED ROW IS NOT SKIPPED — it is not in the book. Furniture and suppressed
 * running heads are rows of a book file so that nothing the model answered is
 * silently gone (docs/BOOK-FILE.md §5), and `vlm-compile` filters them out for
 * the same reason this does: the flow is the book. A row somebody RESTORED is in
 * the flow and translates like any other, wearing `Page-header` as its category —
 * which is why the two furniture categories are translatable here and are not in
 * `blocks.ts`, where they could never appear.
 */
import { parseBookFile, type BookFile, type BookRow } from '../vlm/book-file.js';
import type { GroupKind } from './blocks.js';

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
  /** The row's own id — `b12-3`, `b12-3#1`, `b2-3/1`. The record's position. */
  id: string;
  /** The dots category, engine spelling, for the log and for the group rule. */
  category: string;
  /** The flowing block's own text, in the dialect `textmask.ts` masks. */
  text: string;
  /** The page it started on, for naming it in a refusal. */
  page: number;
}

/** Rows that travel in one request, on `blocks.ts`'s own definition of a group. */
export interface BookRowGroup {
  kind: GroupKind;
  /** Never empty. In reading order, which is the order they are rendered in. */
  parts: BookBlock[];
}

export interface BookRowPlan {
  groups: BookRowGroup[];
  /** Skipped category → how many rows. */
  skipped: Map<string, number>;
  /**
   * Rows left in the source language before anything was asked, each as a
   * sentence — the tables. They reach the completion line with everything else
   * the run could not do, because a count with no name behind it is a number
   * nobody can act on (ARCHITECTURE §8).
   */
  kept: string[];
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
  const groups: BookRowGroup[] = [];
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
       * A TABLE'S TEXT IS THE VISION MODEL'S OWN HTML, and there is no cell to
       * key a record to — `run.ts`'s records mode reaches the same conclusion by
       * a different road (its cells are not banked blocks) and leaves the table
       * in the source language, counted and named. The same answer here, for the
       * sharper version of the reason: a book file row IS the grid, as one
       * string, so translating it means handing a model `<tr>`, `<td>` and every
       * attribute in them and asking it not to touch any of it. A table whose
       * columns quietly swapped is worse than a table nobody translated, because
       * it looks fine.
       */
      skipped.set('Table', (skipped.get('Table') ?? 0) + 1);
      kept.push(
        `${where} block ${row.id} (Table, page ${row.page}) — a table's text is the vision model's `
        + 'own HTML, and there is no way to translate the words in it without handing the model the '
        + 'grid to rearrange',
      );
      openList = null;
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
      groups.push({ kind: 'single', parts: [block] });
      continue;
    }
    const tag = listKind(row);
    const last = groups[groups.length - 1];
    if (openList === tag && last !== undefined && last.kind === 'list') {
      last.parts.push(block);
      continue;
    }
    openList = tag;
    groups.push({ kind: 'list', parts: [block] });
  }

  return { groups, skipped, kept };
}
