/**
 * vlm/compile — THE BOOK FILE, COMPILED INTO SOMETHING SOMEBODY READS.
 *
 * ── What this command is, and what it is instead of ─────────────────────────
 *
 * `vlm-convert` compiles a BANK: it takes the model's page answers, runs every
 * rule that turns pages into a book — the running heads out, the hyphens fused,
 * the page turns joined, the notes cut apart, the chapters proposed — and writes
 * an EPUB out the other end. That is the right shape for a book nobody has
 * touched, and it is the wrong shape for a book somebody has EDITED, because the
 * edits are not in the bank. They are ops in the project's ledger, keyed by block
 * id, and the document they describe is the book file with those ops replayed
 * over it (docs/RENDERER.md §3).
 *
 * So the replay happens ONCE, in the app, which is where the renderer already
 * draws it from (`app/shared/ops.ts`); main materialises the result as a DERIVED
 * BOOK FILE — same format, same ids, struck rows absent, text as the person left
 * it (§4) — and hands it here. This command compiles a book FILE. It replays
 * nothing, decides nothing about the book's structure, and adds no rule of its
 * own: what the rows say is what it writes, and what the header's `chapters` says
 * is where it divides. There is one implementation of "what does this book say
 * now", and it is not in this file.
 *
 * ── IT ALWAYS WRITES THE EDITION ────────────────────────────────────────────
 *
 * `vlm-convert` has a `--final` switch because it writes two different books out
 * of one bank: the CAST, which is a workbench and keeps a curator's marks, and
 * the EDITION, which is what a person hands to a library. This command has no
 * such switch, because the workbench is not a file any more — it is the renderer,
 * drawing the replay on screen — and the only thing anybody compiles a book file
 * INTO is the finished document. So the edition's rules are this writer's
 * constants: no `data-bf-id`, no `data-bf-src`, no `data-bf-note`, no
 * `data-bf-cut`. `data-bf-page` and `data-bf-cat` stay, which is `epub-final`'s
 * ruling unchanged — page provenance is what makes a scan citable, it is
 * invisible in a reader, and every later pass reads it.
 *
 * The two rules an edition applies to STRUCK material do not appear here at all,
 * and their absence is the design rather than an omission: a struck row is not in
 * a derived book file, and neither is the reference number that pointed at a
 * struck note (docs/RENDERER.md §0, ruling 9 — "if i delete footnotes, it removes
 * their corresponding reference numbers", a DERIVED fact and never a second op).
 * Both are settled at materialisation, where the ops are; by the time a book file
 * gets here there is nothing left to remove.
 *
 * ── ONE EMITTER, AND THIS IS THE SECOND READER OF IT ────────────────────────
 *
 * Every element this writes is `blockElement`'s (`dots-book.ts`), every inline
 * rule is `dotsInline`'s (`dots.ts`), the stylesheet is `dotsStylesheet`'s, the
 * container is `packageVlmEpub`'s and the plain text is `packageVlmText`'s. A
 * Quote is a `<blockquote>` here because it is a `<blockquote>` there, and the
 * day one of them changes both change. What is genuinely this file's own is the
 * arithmetic that the bank route gets from the reflow and a book file states
 * outright: which rows a chapter holds, which note a reference number belongs to,
 * and which page marker is still owed.
 *
 * ── THE MARKERS ARE OFFSETS AND ARE NEVER SEARCHED FOR ──────────────────────
 *
 * A note row carries `refs` — the exact characters of the body its number is
 * printed at (docs/BOOK-FILE.md §3) — resolved by the engine at reflow with the
 * page in front of it, and re-derived by the replay for any block a person
 * edited. The same digits appear five times on a page of a book with fifty notes,
 * so matching by TEXT would land on whichever occurrence came first. This writer
 * therefore links the Nth superscript run of a block to the note whose ref names
 * that exact run, and any run no note claims stays the plain `<sup>` the emitter
 * gives an unmatched marker: no link beats a wrong one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import {
  figureMediaType,
  parseBookFile,
  BookFileError,
  type BookFile,
  type BookRow,
} from './book-file.js';
import {
  alignmentClass,
  bodyColumn,
  checkTableHtml,
  dotsInline,
  plainText,
  SUPERSCRIPT_RUN,
  type BodyColumn,
  type DotsBlock,
  type DotsPageKind,
} from './dots.js';
import {
  blockElement,
  categoryAttribute,
  dotsStylesheet,
  FOOTNOTES_CLOSE,
  FOOTNOTES_OPEN,
  FOOTNOTES_RULE,
  headingLabel,
  KIND_LABEL,
  navTree,
  noteAside,
  noteLeadOf,
  noteNumber,
  noteRefAnchor,
  noteRefId,
  pageMarker,
  sectionName,
} from './dots-book.js';
import {
  packageVlmEpub,
  XHTML_HEAD,
  XHTML_TAIL,
  type VlmChapter,
  type VlmDocument,
  type VlmEpubMetadata,
  type VlmResource,
} from './epub.js';
import { packageVlmText } from './text-out.js';

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

/** The two things a book file compiles INTO. See `formatOf`. */
export type CompileFormat = 'epub' | 'txt';

export interface CompileOptions {
  bookPath: string;
  outPath: string;
  /**
   * Where this book's figures were cut — `readings/<key>.images/`, the directory
   * `vlm-book --pdf` wrote and every reader of this book file shares
   * (docs/BOOK-FILE.md §6).
   *
   * Absent is legal and is the ordinary state of a plain-text compile, which
   * carries no pictures at all. A book with a Picture row in it compiled to EPUB
   * without one is REFUSED BY NAME: there is no fallback that would not be a
   * `<figure>` with a hole in it.
   */
  imagesDir?: string;
  /** `dc:title`. Absent takes the name of the file being written — see `titleFor`. */
  title?: string;
  /** `dc:creator`. Absent writes none, and none is never invented. */
  author?: string;
  log: (line: string) => void;
}

export interface CompileReport {
  format: CompileFormat;
  /** Rows of the flowing book — the shelf and the apparatus are counted apart. */
  blocks: number;
  chapters: number;
  notes: number;
  pictures: number;
  /** Reference numbers that found their note in the prose. */
  linked: number;
  /** Refs the prose does not carry as a superscript run — see `chapterBody`. */
  unresolved: number;
  bytes: number;
}

/**
 * Which document this run writes, read off the name of the file it writes it to.
 *
 * NO `--format` FLAG, which `vlm-convert` has and this deliberately does not.
 * That command takes a bank and can be asked for any of four products, so the
 * ask has to be said out loud and the extension is checked against it. Here there
 * are two, the extension names one of them unambiguously, and a flag that could
 * contradict the filename would be a second way to say one thing.
 */
function formatOf(outPath: string): CompileFormat {
  const lower = outPath.toLowerCase();
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.txt')) return 'txt';
  throw new CompileError(
    'a book file compiles into an EPUB or into plain text, and the file this run was pointed at is '
    + 'neither — name it .epub or .txt and the format is decided by that and nothing else.',
  );
}

/**
 * The title, in the order of who actually knows it.
 *
 * WHAT WAS ASKED FOR FIRST, and it is the project's own record of what the book
 * is called — the app merges the metadata patches on this position's ancestry and
 * puts the answer on the command line. Then the name of the file being written,
 * which is `vlm-convert`'s own second answer for the same question (there it is
 * the PDF's filename stem): a FACT about the file rather than a guess about the
 * book. Nothing reads a title out of the book's own text, because a page of
 * display type does not say which of its lines is the title, and a heading
 * promoted to `dc:title` is a guess wearing a metadata field's clothes.
 */
function titleFor(opts: CompileOptions): string {
  const said = opts.title?.trim() ?? '';
  if (said.length > 0) return said;
  return path.basename(opts.outPath).replace(/\.[^.]+$/, '').trim();
}

/**
 * A row, as the measurements in `dots.ts` want to be handed a block.
 *
 * THE BOX IS THE ONLY THING THEY READ, and it is the row's own — composed at
 * reflow out of every part the block was assembled from (docs/BOOK-FILE.md §3),
 * carried in the file, and stale by construction on a row somebody restructured,
 * which is the format's documented state and costs an alignment class at worst.
 * `order` and `part` are the coordinates the bank named the block by and nothing
 * here asks for them, so they are the zero this shape needs to exist rather than
 * a claim.
 */
function asBlock(row: BookRow): DotsBlock {
  return {
    page: row.page,
    order: 0,
    part: 0,
    category: row.category,
    box: row.box,
    text: row.text,
    pageWidth: row.pageWidth,
    pageHeight: row.pageHeight,
  };
}

/** One note of the book, as this writer needs it while a chapter is written. */
interface CompiledNote {
  row: BookRow;
  /** Book-wide, because it mints the element ids the backlinks point at. */
  seq: number;
  /** The number the BOOK printed on it — the only name a marker can use. */
  printed: number | null;
  /** The id of the FIRST prose marker that linked here, or null. */
  refId: string | null;
}

/** One reference number to draw inside one body row, at exact characters. */
interface CompiledRef {
  at: number;
  len: number;
  note: CompiledNote;
}

/**
 * Where this book divides, as spans of the flowing rows.
 *
 * THE HEADER IS THE ANSWER AND THERE IS NO SECOND OPINION. In a book file the
 * engine wrote, `chapters` is the SEED — what a render with nobody's opinion in
 * it would do — and in a derived one it is the replay's output, which is the seed
 * or the person's list depending on whether they touched it (docs/RENDERER.md
 * §2). Either way it is settled before this command is spawned, so nothing here
 * proposes, folds or classifies anything: it looks each id up and cuts.
 *
 * A LEADING SPAN IS A DOCUMENT LIKE ANY OTHER. A book whose first division is not
 * its first row has front matter in front of it, and front matter has to go
 * somewhere; it takes the label its own first heading gives it, exactly as the
 * bank route's leading section does.
 */
function spansOf(
  flow: readonly BookRow[],
  book: BookFile,
): { from: number; to: number; title: string; kind: DotsPageKind | null; heading: string | null }[] {
  const at = new Map<string, number>();
  for (const [index, row] of flow.entries()) at.set(row.id, index);

  const starts: { index: number; title: string; kind: DotsPageKind | null }[] = [];
  for (const chapter of book.chapters) {
    const index = at.get(chapter.id);
    if (index === undefined) {
      /*
       * A DIVISION ABOVE A BLOCK THIS BOOK DOES NOT HOLD stops the run, and the
       * two ways it can happen are both somebody else's bug rather than a state
       * to render around: the app filters the divisions to drawable rows when it
       * materialises (`drawableChapters`, app/shared/ops.ts), and the engine's own
       * seed names rows it wrote a line earlier. Cutting the book at a block that
       * is not there is not possible, and dropping the division silently would
       * hand somebody a contents page with a chapter missing from it.
       */
      throw new CompileError(
        `this book divides above "${chapter.id}", which is not a block it holds in its flowing text. `
        + 'A division names the block it sits above, and there is nothing here to sit above.',
      );
    }
    starts.push({ index, title: chapter.title, kind: chapter.kind ?? null });
  }
  // In reading order, whatever order the header listed them in: the file's own
  // order is reading order and both writers of one produce it that way, so this
  // settles a disagreement that cannot arise rather than repairing a book.
  starts.sort((one, other) => one.index - other.index);
  if (starts.length === 0 || starts[0]!.index !== 0) {
    starts.unshift({ index: 0, title: '', kind: null });
  }

  return starts.map((start, which) => {
    const to = starts[which + 1]?.index ?? flow.length;
    const span = flow.slice(start.index, to);
    /*
     * The label, in the order of who actually knows it — `buildDotsBook`'s own
     * order, restated over rows. What the header says a division is called, then
     * the section's own first heading (`sectionName`, the one implementation),
     * then the honest name for the kind, then the position. A division whose
     * title is an empty string is a rule drawn across the page with no words over
     * it, which is a decision a person can make with a chapter op — so it falls
     * through to the heading rather than putting an empty entry in the contents.
     */
    const title = start.title.trim().length > 0
      ? start.title
      : sectionName(span, null)
        || KIND_LABEL[start.kind ?? 'chapter']
        || `Chapter ${which + 1}`;
    /*
     * `heading` IS NOT `title`, and the difference is who said it. The title
     * above is the NAV's label and falls back through guesses — the span's own
     * first heading, the kind, the position — because a contents entry has to
     * say something. The heading is what may be PRINTED at the top of the
     * chapter when nothing else is (`chapterBody`), and only a division's own
     * declared name qualifies: printing "Chapter 3" into the text of a book
     * whose page never said it would be this file writing the book instead of
     * compiling it. Empty for the synthesized front-matter span and for a rule
     * drawn with no words over it, both of which print nothing.
     */
    return {
      from: start.index,
      to,
      title,
      kind: start.kind,
      heading: start.title.trim().length > 0 ? start.title : null,
    };
  });
}

/**
 * The headings that OPEN a division, as indices into its own rows.
 *
 * `openingHeadings`' answer (dots-book.ts) over a book file, and it needs less
 * evidence to give it: that function asks the page classifier what kind of
 * section this is and which page its blocks were printed on, because it is
 * deciding whether a heading two blocks down is still part of an announcement. A
 * division in a book file sits exactly where somebody put it, so the run of
 * headings at the top of it IS the announcement and the first thing that is not a
 * heading ends it.
 *
 * What it buys is the same thing it buys there: a chapter that opens on `CHAPTER
 * I` and then `PRELUDE TO JUDGMENT` gets no anchor and no nav entry for the
 * second of them, because both of them are what the chapter is CALLED.
 */
function openingRun(span: readonly BookRow[]): number {
  let n = 0;
  while (n < span.length) {
    const category = span[n]!.category;
    if (category !== 'Title' && category !== 'Section-header') break;
    n += 1;
  }
  return n;
}

/** `data-bf-page` and `data-bf-cat`, and nothing else — see this file's header. */
function stampOf(row: BookRow, attribute: string = categoryAttribute(row.category)): string {
  return ` data-bf-page="${row.page}" data-bf-cat="${attribute}"`;
}

/** One chapter's XHTML, and what writing it settled about the book's apparatus. */
interface CompiledBody {
  xhtml: string;
  /** The section headers inside the chapter, anchored, for the nav. */
  headings: { id: string; label: string }[];
  /** Reference numbers that found their run in the prose. */
  linked: number;
  /** Refs naming characters the prose does not print as a superscript run. */
  unresolved: number;
  pictures: number;
}

function classOf(align: string): string {
  return align === '' ? '' : ` class="${align}"`;
}

/**
 * One division of the book, written down.
 *
 * ── THE NOTES ARE GATHERED FIRST, and it is the emitter's own reason ────────
 *
 * The prose is where the reference markers live, and a marker can only become a
 * link to a note that is already known — writing in one pass would mean the first
 * half of a chapter could never reach the notes at its end. So the chapter's
 * Footnote rows are collected before a paragraph is written, their ids are minted,
 * and the prose links forward into them.
 *
 * ── AND THE APPARATUS SITS AT THE END OF THE CHAPTER ────────────────────────
 *
 * Not per page: a page is not a unit of a reflowable book, and seventeen little
 * note sections in a chapter is seventeen interruptions. That is where the bank
 * route puts them and it is where a book file's Footnote rows go too — they sit
 * in the file at the reading-order position the printer gave them, and this is the
 * one place that position is deliberately not honoured.
 */
function chapterBody(
  span: readonly BookRow[],
  notes: readonly CompiledNote[],
  column: BodyColumn,
  images: ReadonlyMap<string, string>,
  format: CompileFormat,
  heading: string | null,
): CompiledBody {
  const out: string[] = [];
  const headings: { id: string; label: string }[] = [];
  const pagesSeen = new Set<number>();
  const openers = openingRun(span);
  /*
   * A DIVISION WITH NOTHING ON THE PAGE SAYING ITS NAME PRINTS ITS NAME — the
   * mirror of `EditionPlace.heading` (app, edition.ts), which is the surface
   * the person watched while deciding. Where the chapter opens on the book's
   * own heading, THAT is the heading and the division's title is metadata
   * beside it; where somebody struck the printed title and named the rule
   * instead, the chapter would otherwise open on bare prose while the sheet
   * they approved showed a heading. Set through `dotsInline` like every other
   * string that becomes markup, and stamped with the category alone — a page
   * stamp would cite a leaf this element was never printed on.
   */
  if (openers === 0 && heading !== null) {
    out.push(blockElement(
      'Title',
      { outer: ` data-bf-cat="${categoryAttribute('Title')}"` },
      dotsInline(heading, { noteref: () => null }),
    ));
  }
  let linked = 0;
  let pictures = 0;
  let openList: 'ol' | 'ul' | null = null;

  /*
   * WHICH CHARACTERS OF WHICH BLOCK CARRY A NUMBER, inverted out of the notes.
   *
   * `refs` is recorded on the NOTE and points at the body (docs/BOOK-FILE.md §3,
   * which argues at length for that direction), and the prose is written block by
   * block — so the one thing this loop needs is the inverse, and it is built once
   * rather than searched for per paragraph. Only THIS chapter's notes are in it:
   * a number printed in one chapter and answered by a note in another is a link
   * across two documents, and the bank route does not make one either.
   */
  const refsIn = new Map<string, CompiledRef[]>();
  for (const note of notes) {
    for (const ref of note.row.refs ?? []) {
      const already = refsIn.get(ref.block);
      const made: CompiledRef = { at: ref.at, len: ref.len, note };
      if (already === undefined) refsIn.set(ref.block, [made]);
      else already.push(made);
    }
  }
  for (const claims of refsIn.values()) claims.sort((one, other) => one.at - other.at);

  /**
   * The words of one row, with its reference numbers linked to their notes.
   *
   * ── WHY THE RUNS ARE COUNTED RATHER THAN THE TEXT CUT ──────────────────────
   *
   * The obvious way to honour a character offset is to slice the text at it and
   * render the pieces — and it would break the markup the model wrote, because a
   * marker inside an emphasised phrase would leave a `*` at the end of one piece
   * and a `*` at the start of the next, and `dotsInline` pairs those within one
   * string. So the string is rendered WHOLE, once, and the offsets are honoured by
   * ORDER instead: `dotsInline` replaces superscript runs left to right with the
   * same expression this scan finds them with (`SUPERSCRIPT_RUN`), and neither
   * escaping nor the emphasis rules can add, remove or reorder one. The nth
   * replacement is therefore the nth run of the row's own text, and its offset is
   * known exactly.
   */
  const worded = (row: BookRow): string => {
    const claims = refsIn.get(row.id) ?? [];
    const runs = [...row.text.matchAll(SUPERSCRIPT_RUN)];
    let which = -1;
    return dotsInline(row.text, {
      noteref: (printed) => {
        which += 1;
        const run = runs[which];
        if (run === undefined) return null;
        const claim = claims.find((ref) => ref.at === run.index && ref.len === run[0].length);
        if (claim === undefined) return null;
        const first = claim.note.refId === null;
        if (first) claim.note.refId = noteRefId(claim.note.seq);
        linked += 1;
        return noteRefAnchor(claim.note.seq, printed, first ? claim.note.refId : null);
      },
    });
  };

  /**
   * The page marker this row's part owes, if it opens a page. Consumed once.
   *
   * PAGE 0 OWES NOTHING, and that is the no-page frame reaching the writer.
   * A book exploded out of an imported EPUB has no pages at all (docs/BOOK-FILE.md
   * §3): every row is `page: 0`, which is the number that is not a page. A
   * `<span epub:type="pagebreak" id="pb-0">` at the head of such a book would be
   * a print-source citation to a leaf that was never printed — the one kind of
   * claim page provenance exists to make truthfully — and a reading system's
   * page-list would offer somebody a page to turn to that does not exist.
   */
  const marker = (page: number): string => {
    if (page === 0 || pagesSeen.has(page)) return '';
    pagesSeen.add(page);
    return pageMarker(page);
  };

  const closeList = (): void => {
    if (openList === null) return;
    out.push(`</${openList}>`);
    openList = null;
  };

  for (const [index, row] of span.entries()) {
    // Held back to the end of the chapter, and it writes nothing where it stands
    // — so it does not interrupt the paragraph it sits in the middle of.
    if (row.category === 'Footnote') continue;

    const align = alignmentClass(row.box, column);
    if (row.category === 'List-item') {
      const tag = /^\d+[.)]/.test(row.text) ? 'ol' : 'ul';
      if (openList !== tag) {
        closeList();
        out.push(`<${tag}${stampOf(row)}>`);
        openList = tag;
      }
      out.push(blockElement('List-item', { outer: stampOf(row) }, `${marker(row.page)}${worded(row)}`));
      continue;
    }
    closeList();

    switch (row.category) {
      case 'Title':
      case 'Section-header': {
        const xhtml = worded(row);
        let anchor = '';
        /*
         * A Section-header that is not one of the division's opening headings is
         * a section INSIDE it, and it gets an anchor so the contents can list it
         * under the chapter — a contents page that stops at chapter names is
         * describing a shallower book than the one that was written.
         */
        if (row.category === 'Section-header' && index >= openers) {
          const text = plainText(xhtml);
          if (text.length > 0) {
            const id = `sh${headings.length + 1}`;
            anchor = ` id="${id}"`;
            // One line for the contents, because a nav entry has nowhere to put a
            // line break — and the `<h2>` above keeps the break the page had.
            headings.push({ id, label: headingLabel(text) });
          }
        }
        out.push(blockElement(
          row.category,
          { outer: `${anchor}${classOf(align)}${stampOf(row)}` },
          `${marker(row.page)}${xhtml}`,
        ));
        break;
      }
      case 'Quote':
        out.push(blockElement(
          'Quote',
          { outer: stampOf(row), inner: stampOf(row) },
          `${marker(row.page)}${worded(row)}`,
        ));
        break;
      case 'Table':
        /*
         * The model's own HTML for the grid, checked before it is written — a
         * table's text is markup rather than prose and never goes through the
         * inline rules, exactly as the bank route has it.
         */
        out.push(blockElement(
          'Table',
          { outer: stampOf(row) },
          `${marker(row.page)}${checkTableHtml(row.text, row.page)}`,
        ));
        break;
      case 'Formula':
        out.push(blockElement(
          'Formula',
          { outer: stampOf(row) },
          `${marker(row.page)}${worded(row)}`,
        ));
        break;
      case 'Picture': {
        /*
         * ── A FIGURE IS THE FILE OR IT IS A REFUSAL ────────────────────────────
         *
         * The pixels were cut once, at reflow, into `readings/<key>.images/`
         * (docs/BOOK-FILE.md §6), and the row names its crop. There is no second
         * place to get them: no bank holds a picture, this command opens no PDF
         * and rasterises nothing. So a row that names an image nobody handed over,
         * or names one that is not in the directory, stops the run — a `<figure>`
         * with a missing `src` is a broken image in a reader, on a book that
         * opened without an error, which is the failure this whole program is
         * arranged against.
         *
         * A PLAIN-TEXT BOOK ASKS FOR NONE OF IT, and that is the bank route's own
         * ruling about the same format said one stage later: *"a text book has no
         * container to put one in"*, so it never cuts a crop and never fails on a
         * picture it was not going to carry. A figure contributes nothing to a
         * file of words; nothing is what it writes, and nothing is what it needs.
         */
        if (format === 'txt') break;
        if (row.image === undefined) {
          throw new CompileError(
            /*
             * THE ADVICE HAS TO BE TRUE IN BOTH FACES, and until Wave 37 it was
             * true in one. It used to say "with the archived original beside
             * them", which a person reads as A PDF — and the book that most
             * often reaches this refusal is a CAPTURED one, whose archive is a
             * folder of photographs and never was a document. Somebody following
             * that sentence would go looking for a file that does not exist and
             * conclude the pixels were lost. The pages are the pages, whichever
             * shape they arrived in, so that is what it says now.
             */
            `"${row.id}" is a picture and this book never had its figures cut, so there is nothing to `
            + 'put on the page. Make the book again from the pages it was read out of — the scanned '
            + 'document, or the photographs of the pages themselves — and the figures are cut in '
            + 'seconds.',
          );
        }
        const file = images.get(row.image);
        if (file === undefined) {
          throw new CompileError(
            `"${row.id}" is a picture and the figure it names is not among the ones this run was `
            + 'given, so the book would carry a hole where it is printed.',
          );
        }
        pictures += 1;
        out.push(blockElement(
          'Picture',
          { outer: stampOf(row) },
          marker(row.page),
          { name: row.image, page: row.page },
        ));
        break;
      }
      case 'Caption':
        out.push(blockElement(
          'Caption',
          { outer: stampOf(row) },
          `${marker(row.page)}${worded(row)}`,
        ));
        break;
      default: {
        /*
         * Text — the one kind that can be several banked answers, and the page
         * markers go INSIDE the paragraph at the seams, which is exactly where the
         * EPUB convention puts them and the reason a marker is a span rather than
         * an attribute on the block.
         *
         * WHERE THE SEAM IS is the row's own `parts`: each one covers a half-open
         * range of this text and they tile it, so the character a page turned at is
         * a fact in the file rather than arithmetic. The bank route writes its
         * marker one character later — after the space the join inserted, before
         * the word the column broke — because it has the join in hand and this has
         * the division. Both are inside the paragraph at the turn, and this one is
         * the answer the file actually carries.
         */
        /*
         * A ROW WHOSE NUMBERS ARE LINKED IS WRITTEN WHOLE, because the linking
         * counts superscript runs across the row's own TEXT and a part is not the
         * row. So the two branches differ in one thing only — where the page
         * markers can stand — and a paragraph carrying a reference number gets
         * them together at its front, in page order, which is the same answer the
         * bank route gives a substituted paragraph and for the same reason: a
         * position inside would be a claim the writing cannot support.
         *
         * THE MARKERS ARE CONSUMED ONCE, WHICH IS WHY THE BRANCH IS TAKEN BEFORE
         * THEY ARE ASKED FOR. `marker` is a page's ONE anchor in this document and
         * asking for it spends it; building both bodies and picking one would
         * spend every page marker on a string that was then thrown away, and the
         * book would come out missing the pages of every paragraph that has a
         * footnote in it.
         */
        const claims = refsIn.get(row.id) ?? [];
        let body: string;
        if (claims.length === 0) {
          // Rendered whole and then divided would put a marker inside an escaped
          // entity, so each part is rendered as its own string — the inline rules
          // are per-part here, which is what `buildChapterBody` does too.
          const written: string[] = [];
          for (const part of row.parts) {
            written.push(marker(part.page));
            written.push(dotsInline(row.text.slice(part.chars[0], part.chars[1])));
          }
          body = written.join('');
        } else {
          body = row.parts.map((part) => marker(part.page)).join('') + worded(row);
        }
        out.push(blockElement(row.category, { outer: `${classOf(align)}${stampOf(row)}` }, body));
      }
    }
  }
  closeList();

  /*
   * THE APPARATUS. Every note in the chapter, in the order the pages carried
   * them, each with the number the book printed on it — a backlink where some
   * marker claimed it, a plain superscript where nothing did.
   *
   * A CHAPTER WITH NO NOTES WRITES NO SECTION AT ALL, which is `epub-final`'s own
   * removal and the emitter's: a `<section class="footnotes">` holding nothing but
   * its rule is white space under a line, and a reader sees it.
   */
  if (notes.length > 0) {
    out.push(FOOTNOTES_OPEN);
    out.push(FOOTNOTES_RULE);
    for (const note of notes) {
      /*
       * The number comes off the note's own first characters and is written back
       * as the linked `<sup>`, so a number the model spelled in plain digits is
       * the same fact as one it spelled superscript — and neither is left sitting
       * doubled in front of the one this writes.
       */
      const lead = noteLeadOf(note.row.text);
      const rest = lead === null
        ? note.row.text
        : note.row.text.slice(lead.run.length).replace(/^\s+/, '');
      out.push(noteAside(
        note.seq,
        stampOf(note.row),
        // Rendered WITHOUT the linker: a superscript inside a note's text is a
        // reference in the note's own prose, and linking it would resolve it to a
        // sibling note at the same page bottom — a wrong link, made confidently.
        `${noteNumber(note.printed, note.refId)}${dotsInline(rest)}`,
      ));
    }
    out.push(FOOTNOTES_CLOSE);
  }

  const wanted = [...refsIn.values()].reduce((sum, claims) => sum + claims.length, 0);
  return { xhtml: out.join('\n'), headings, linked, unresolved: wanted - linked, pictures };
}

/**
 * The figures this run was given, by the name a row would call them.
 *
 * READ, NEVER LISTED FOR MATCHES. A row names its crop and the directory either
 * holds that file or it does not; anything else in there belongs to another
 * reading of the same book and is none of this run's business.
 */
function figuresIn(imagesDir: string, rows: readonly BookRow[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const row of rows) {
    if (row.image === undefined || found.has(row.image)) continue;
    // A NAME AND NEVER A PATH is the format's rule (docs/BOOK-FILE.md §3), so a
    // separator in one is not a figure this program cut — it is a way out of the
    // directory, and it meets a refusal rather than a resolve that might climb.
    if (row.image.includes('/') || row.image.includes('\\') || row.image.includes('..')) {
      throw new CompileError(
        `"${row.id}" names its figure as a path rather than as a name, and a book file names figures `
        + 'by the file they were cut to inside this book\'s own directory.',
      );
    }
    const file = path.join(imagesDir, row.image);
    if (!fs.existsSync(file)) continue;
    found.set(row.image, file);
  }
  return found;
}

/** The whole run: a book file in, a document out. */
export function compileBook(opts: CompileOptions): CompileReport {
  const bookPath = path.resolve(opts.bookPath);
  const outPath = path.resolve(opts.outPath);
  const format = formatOf(outPath);
  if (bookPath === outPath) {
    throw new CompileError('this run would write the book over the file it is compiling from.');
  }
  if (!fs.existsSync(bookPath)) {
    throw new CompileError(
      `no such book file: ${bookPath}. This command compiles a book that has already been made — it `
      + 'reads no bank and no page, so an absent book is nothing it can make up for.',
    );
  }

  let book: BookFile;
  try {
    book = parseBookFile(fs.readFileSync(bookPath, 'utf8'));
  } catch (err) {
    if (!(err instanceof BookFileError)) throw err;
    throw new CompileError(`this is not a book this program can compile: ${err.message}`);
  }

  /*
   * THE FLOW IS THE BOOK AND THE SHELF IS NOT IN IT. Every block the model
   * answered is a row of a book file, and a row is either in the document or on
   * the shelf wearing a sentence about why (docs/BOOK-FILE.md §5). A derived book
   * file has no shelf at all — materialisation leaves the shelved rows out, and
   * the restored ones are in the flow — so this is what a RAW book file, compiled
   * straight, gets right.
   */
  const flow = book.rows.filter((row) => row.shelf === undefined);
  if (flow.length === 0) {
    throw new CompileError(
      'nothing in this book is text a book is made of — every row is out of the flow. There is no '
      + 'book to write.',
    );
  }

  const images = opts.imagesDir === undefined || format === 'txt'
    ? new Map<string, string>()
    : figuresIn(path.resolve(opts.imagesDir), flow);
  const column = bodyColumn(flow.map(asBlock), flow[0]!.pageWidth);
  const spans = spansOf(flow, book);

  const documents: VlmDocument[] = [];
  const chapters: VlmChapter[] = [];
  const language = book.language;
  let seq = 1;
  let notes = 0;
  let pictures = 0;
  let linked = 0;
  let unresolved = 0;

  for (const [index, span] of spans.entries()) {
    const rows = flow.slice(span.from, span.to);
    const apparatus: CompiledNote[] = rows
      .filter((row) => row.category === 'Footnote')
      .map((row) => ({
        row,
        seq: seq++,
        // The number the PAGE set, which is the only name a marker can use — and
        // it is read off the note's own text, so renumbering a note by hand is an
        // ordinary edit that the prose's markers follow.
        printed: noteLeadOf(row.text)?.printed ?? null,
        refId: null,
      }));
    notes += apparatus.length;
    const body = chapterBody(rows, apparatus, column, images, format, span.heading);
    linked += body.linked;
    unresolved += body.unresolved;
    pictures += body.pictures;

    const n = String(index + 1).padStart(4, '0');
    const href = `text/c${n}.xhtml`;
    // Every page the span touches, not just the one each row started on: a
    // paragraph that swallowed a page turn reaches onto the next leaf, and a
    // `lastPage` that stopped at the opening block is a claim a reader can
    // disprove by turning to it.
    const pages = rows.flatMap((row) => row.pages);
    documents.push({
      id: `c${n}`,
      href,
      label: span.title,
      xhtml: XHTML_HEAD(span.title, language) + body.xhtml + '\n' + XHTML_TAIL,
    });
    chapters.push({
      id: `c${n}`,
      href,
      label: span.title,
      blocks: rows.length,
      firstPage: Math.min(...pages),
      lastPage: Math.max(...pages),
      ...(span.kind !== null ? { kind: span.kind } : {}),
      ...(body.headings.length > 0 ? { headings: body.headings } : {}),
    });
  }

  const author = opts.author?.trim() ?? '';
  const metadata: VlmEpubMetadata = {
    title: titleFor(opts),
    ...(author.length > 0 ? { author } : {}),
    // DECLARED AND NEVER DETECTED, and the declaration is the reading's own: the
    // book file's header carries the language the pages were read in, which is
    // the one place in this program that fact is stated.
    language,
    /*
     * WHAT THIS BOOK IS, AS A NAME NOTHING ELSE HAS. `vlm-convert` hashes the PDF
     * it read; there is no PDF here, and the honest equivalent is the receipt this
     * book is a pure function of — `source.bankSha`, which the reflow wrote and
     * which is stable for as long as the pages underneath are (docs/BOOK-FILE.md
     * §2). Two exports of one reading therefore identify one book, which is what a
     * package identifier is for, and no clock or random number is involved.
     */
    identifier: `urn:foundry:bank:${book.source.bankSha}`,
  };

  /*
   * THE MEDIA TYPE IS READ OFF THE NAME AND IS NO LONGER A CONSTANT. Every figure
   * the bank route produces is a PNG, because this program cut it with one
   * rasteriser — so `image/png` was a description rather than a guess. The
   * imported-EPUB route COPIES the publisher's own file (docs/RENDERER.md §6),
   * and that is a JPEG about as often as a PNG; declaring it `image/png` would
   * put a lie in the one document a reading system consults before it draws
   * anything. `figureMediaType` is the one table, beside the format it belongs to.
   */
  const resources: VlmResource[] = [...images.entries()].map(([name, file], index) => ({
    id: `img${index}`,
    href: `images/${name}`,
    mediaType: figureMediaType(name),
    data: new Uint8Array(fs.readFileSync(file)),
  }));

  const packaged = format === 'txt'
    ? packageVlmText(metadata, documents)
    : packageVlmEpub(metadata, documents, resources, dotsStylesheet(book.typography), navTree(chapters));

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, packaged.bytes);

  opts.log(
    `vlm-compile: ${flow.length - notes} block(s) and ${notes} note(s) in ${documents.length} `
    + `document(s), ${pictures} figure(s), ${linked} reference number(s) linked`
    + (unresolved === 0
      ? ''
      : `, ${unresolved} recorded reference(s) the prose does not print as a superscript`),
  );
  opts.log(`vlm-compile: wrote ${outPath}`);

  return {
    format,
    blocks: flow.length - notes,
    chapters: documents.length,
    notes,
    pictures,
    linked,
    unresolved,
    bytes: packaged.bytes.length,
  };
}
