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
 *
 * ── VERSION 2: THE MARKERS, THE CHAPTERS AND THE TYPE ───────────────────────
 *
 * v1 was the rows. v2 is the rows plus the three facts the renderer would
 * otherwise have to work out for itself, and every one of them is here because
 * working it out twice is how two answers to one question get into a program.
 *
 * REFERENCE MARKERS ARE DATA NOW. A superscript `¹²` in the prose was, until
 * this version, a shape in a string that only the EPUB emitter ever resolved —
 * it matched marker to note while it concatenated markup, wrote an `<a>`, and
 * threw the correspondence away with the string. An editing surface needs the
 * correspondence itself: *"if i delete footnotes, it removes their
 * corresponding reference numbers."* That is one op and a DERIVED fact, not two
 * ops, and it is only derivable if the file says which marker belongs to which
 * note. So every note row carries `refs` — where in the body its number is
 * printed — resolved by the same printed-number match the emitter uses, and the
 * ones that did not resolve are listed in the header rather than dropped. A
 * marker with no note and a note with nothing pointing at it are the two
 * LINKING flags the renderer draws in the margin, and they are structural facts
 * about the book rather than suspicion about the scan.
 *
 * THE CHAPTER SEED. `detectChapters` exists so an app can seed a chapter list
 * with exactly what a render would do, and it did it by parsing the bank a
 * second time. The book file is already that pass's answer written down, so the
 * seed rides along in the header — the same starts, through the same
 * `sectionName`, so the seed and the render cannot disagree. Ownership passes
 * to the ledger the moment a person touches it (RENDERER §2), which is why this
 * is a seed and not a spine.
 *
 * THE TYPOGRAPHY REPORT, verbatim. It is a measurement of the whole book —
 * medians over every block of a category — so it can only be taken where the
 * whole book is, and the renderer needs it to set type the way the export does.
 * Carrying it costs a few hundred bytes and saves the surface from measuring a
 * book it is showing one screen of.
 */
import type { DotsBlock, DotsBox, DotsCategory, DotsPageKind } from './dots.js';
import { SUPERSCRIPT_RUN } from './dots.js';
import {
  KIND_LABEL,
  printedNoteNumber,
  sectionName,
  splitNotes,
  type FlowBlock,
  type FlowBook,
} from './dots-book.js';
import type { TypographyReport } from './typography.js';

/**
 * The format written into the file, so a reader can refuse a shape it cannot use.
 *
 * 2 — the rows of version 1 unchanged, plus `refs` on the note rows and a
 * header that carries the chapter seed, the typography report and the two
 * linking flags. See this file's header for what each is for.
 */
export const BOOK_FILE_VERSION = 2;

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
  /**
   * Every place in the body this note's number is printed — set on a `Footnote`
   * row and on no other kind, and set on EVERY footnote row including the ones
   * nothing points at, where it is `[]`.
   *
   * ── WHY THE LINK IS RECORDED ON THE NOTE AND NOT ON THE MARKER ─────────────
   *
   * The marker is not a thing. It is two characters inside a paragraph's text,
   * and the paragraph is a string a person is about to edit — insert a clause
   * before it and every offset after the caret moves. A ref stored on the body
   * row would be a coordinate into a document that changes, maintained by
   * whoever remembered to shift it. Stored on the NOTE it is a coordinate into
   * a document at the moment this file was written, read by a renderer that
   * already has the text in hand: it finds the run, binds an element to the
   * note's id, and from then on the DOM holds the correspondence, not an
   * integer that has to be nursed.
   *
   * It is also the direction the question is asked in. "Delete this note and
   * its number goes with it" needs the note to know its markers; nothing needs
   * a marker to know its note before it has been found.
   *
   * `at` is a character offset into the named row's FINAL text — after the
   * dehyphenation, after the reflow, after the page turns were joined — because
   * that string is what the file carries and the only one a reader has. `len`
   * is the run's length in characters, which is the digit count and is not
   * always 1: a book with more than nine notes to a page prints two.
   */
  refs?: BookRef[];
}

/** One printed reference to a note: where in the body its number stands. */
export interface BookRef {
  /** The body row whose text carries the marker. Never a `Footnote` row. */
  block: string;
  /** Character offset into that row's final text. */
  at: number;
  /** How many characters the superscript run is. */
  len: number;
}

/**
 * A marker the match could not place: its number is printed in the body and no
 * note answers to it.
 *
 * IT IS IN THE HEADER RATHER THAN NOWHERE, which is the whole difference
 * between this file and the emitter it takes its rule from. The emitter's answer
 * to an unmatched marker is a plain `<sup>` — the number stays on the page and
 * the fact that nothing was found is not written anywhere, so nobody can act on
 * it. Here it is a row in a list a person can be shown and can fix by hand with
 * a `link` op. `printed` is what the page set, so the list reads as the book
 * reads.
 */
export interface BookLooseMarker extends BookRef {
  printed: number;
}

/** One entry of the chapter seed — see this file's header on what a seed is. */
export interface BookChapter {
  /** The FIRST row of the block the section opens at. */
  id: string;
  title: string;
  /** What the page classifier called it, where it called it anything. */
  kind?: DotsPageKind;
}

/** The two linking flags, both directions, named where a person can read them. */
export interface BookLoose {
  markers: BookLooseMarker[];
  /** The ids of the note rows nothing points at. Each still carries `refs: []`. */
  notes: string[];
}

/**
 * The whole file: the header's facts and the rows, as one value.
 *
 * The header stopped being decoration at version 2 — it carries the chapter
 * seed, the type report and the linking flags — so a reader that got only the
 * rows would be missing three things it needs and would have to open the file a
 * second time to find them. One shape, everything in it.
 */
export interface BookFile {
  rows: BookRow[];
  chapters: BookChapter[];
  typography: TypographyReport | null;
  loose: BookLoose;
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
 * Where each part of a joined paragraph ends inside the block's one text, and
 * which page it was printed on.
 *
 * ── WHY A MARKER'S PAGE IS NOT THE BLOCK'S PAGE ─────────────────────────────
 *
 * A note is matched to its marker by the PAGE they share — that is the whole of
 * the rule, because printed numbering restarts too often for a number to name a
 * note on its own. A paragraph that swallowed a page turn is one row with one
 * `page` field, and a marker in its second half was printed on the page AFTER
 * that one. Asking the row would put the marker on the wrong page and match it
 * against the wrong page's notes — which is exactly the failure this rule
 * exists to avoid, arrived at from the other side.
 *
 * The emitter has never had this problem because it writes a joined paragraph
 * part by part and hands each part its own page (`buildChapterBody`, the
 * default branch). This reconstructs the same division over the finished string,
 * and it can, because the string is composed of the parts in order: the
 * separator a `space` join inserted, then the word the column broke made whole,
 * then what is left of the part. That is `joinedText`, read forwards.
 *
 * THE FUSED WORD BELONGS TO THE LATER PAGE, again because that is what the
 * emitter does with it. It is half on each leaf and no answer is more true than
 * the other; what matters is that both readers say the same one.
 */
function partSpans(block: FlowBlock): { end: number; page: number }[] {
  const spans: { end: number; page: number }[] = [];
  let at = 0;
  for (const part of block.parts) {
    if (part.join === 'space') at += 1;
    if (part.fused !== null) at += part.fused.length;
    at += part.text.length;
    spans.push({ end: at, page: part.page });
  }
  return spans;
}

/** A superscript run found in the body, with the page it was printed on. */
interface PrintedMarker {
  block: string;
  at: number;
  len: number;
  printed: number;
  page: number;
}

/**
 * Every reference marker in one body block, in reading order.
 *
 * THE SAME ALPHABET `splitNotes` KEYS ON, and it has to be: a note is cut out of
 * the foot of a page by a superscript at the start of a line, and the number
 * that cuts it is the number a marker in the prose has to match. `SUPERSCRIPT_RUN`
 * is `dotsInline`'s own regular expression, imported rather than rewritten, so
 * that a run this file calls a marker is a run the emitter would call one too.
 *
 * A Footnote row is never scanned — a superscript inside a note is the note's
 * own number or a reference in its own prose, and the emitter renders a note's
 * text with no page and therefore never links anything inside one either.
 */
function markersIn(block: FlowBlock, id: string): PrintedMarker[] {
  const spans = partSpans(block);
  const composed = spans[spans.length - 1]?.end ?? 0;
  if (composed !== block.text.length) {
    /*
     * THE PARTS NO LONGER COMPOSE THE TEXT, which means the reflow and this file
     * disagree about what the block says. There is no honest page for a marker
     * in a string nothing can be divided into, so nothing is guessed: the run
     * stops and names the block. See PLAN.md's rule — a fallback here would be a
     * marker filed under a page it was not printed on, which reads as a correct
     * link and is not one.
     */
    throw new BookFileError(
      `block "${id}" is ${block.text.length} character(s) long and its ${block.parts.length} `
      + `part(s) compose ${composed}, so there is no telling which page any of it was printed on`,
    );
  }
  const markers: PrintedMarker[] = [];
  for (const match of block.text.matchAll(SUPERSCRIPT_RUN)) {
    const at = match.index;
    const run = match[0];
    markers.push({
      block: id,
      at,
      len: run.length,
      // Both assertions are the check above, spent: the run is superscript
      // digits and nothing else, so it has a printed value; and the parts
      // compose the text exactly, so every offset in it falls inside a part.
      printed: printedNoteNumber(run)!,
      page: spans.find((span) => at < span.end)!.page,
    });
  }
  return markers;
}

/**
 * Marker to note, by the emitter's own rule — and this is the one place the
 * book file makes a decision, so it is the one place that has to be argued.
 *
 * THE RULE IS `buildChapterBody`'s `noteFor`, restated over rows: a note whose
 * PRINTED number is the marker's, on the marker's page, or — the one-page grace
 * — on the page after it, which covers a note whose block the model read onto
 * the following leaf. The search never goes wider than that, for the emitter's
 * reason: a wrong link is worse than no link, because a wrong one is invisible
 * and a missing one is a flag in the margin somebody can act on.
 *
 * ONE ADDITION, AND IT IS DELIBERATE: A NOTE IS CLAIMED ONCE. The emitter can
 * hand the same note to two markers and does not care, because it is writing an
 * `<a href>` and two links to one note are harmless in a book. This file is
 * writing the list a person is shown, and a note quietly taken twice would put a
 * second, genuinely unmatched note into the "nothing points at this" flag with
 * no way to see why. So the first marker in reading order takes it and the
 * second falls through to the next eligible note, or to the loose list, where it
 * is visible. `refs` stays a list because the shape is the contract and because
 * a `link` op is free to add one by hand.
 */
function linkMarkers(
  markers: readonly PrintedMarker[],
  notes: readonly { row: BookRow; printed: number | null; page: number }[],
): BookLooseMarker[] {
  const loose: BookLooseMarker[] = [];
  const claimed = new Set<string>();
  const eligible = (marker: PrintedMarker, page: number) => notes.find(
    (note) => note.printed === marker.printed && note.page === page && !claimed.has(note.row.id),
  );
  for (const marker of markers) {
    const note = eligible(marker, marker.page) ?? eligible(marker, marker.page + 1);
    if (note === undefined) {
      loose.push({ block: marker.block, at: marker.at, len: marker.len, printed: marker.printed });
      continue;
    }
    claimed.add(note.row.id);
    note.row.refs!.push({ block: marker.block, at: marker.at, len: marker.len });
  }
  return loose;
}

/**
 * The chapter seed: where the book divides, and what each division is called.
 *
 * NOT A SPINE AND NOT A DECISION. It is what a render with nobody's opinion in
 * it would do, written down where the renderer can open with it — and the first
 * chapter op in the ledger takes the list over (RENDERER §2). The names come
 * through `sectionName` and `KIND_LABEL`, which is `detectChapters`' order and
 * `buildDotsBook`'s order, because a seed that named a section differently from
 * the book that gets built would make the editor's first act a change nobody
 * asked for.
 *
 * The LEADING SPAN IS IN THIS LIST, unlike `detectChapters`', and the difference
 * is what each is for. That list seeds a spine — front matter is what is left
 * over rather than a chapter somebody named — while this one seeds a set of
 * lines drawn across a document, and the line at the top of a book is where the
 * front matter ends. A person can delete it; they cannot draw one that was never
 * offered.
 */
function chapterSeed(flow: FlowBook, idOf: ReadonlyMap<FlowBlock, string>): BookChapter[] {
  const chapters: BookChapter[] = [];
  for (const [i, start] of flow.starts.entries()) {
    const block = flow.blocks[start];
    if (block === undefined) continue;
    const proposal = flow.opens[i] ?? null;
    const span = flow.blocks.slice(start, flow.starts[i + 1] ?? flow.blocks.length);
    const title = sectionName(span, proposal)
      || KIND_LABEL[proposal?.kind ?? 'chapter']
      || `Chapter ${i + 1}`;
    chapters.push({
      id: idOf.get(block)!,
      title,
      ...(proposal?.kind != null ? { kind: proposal.kind } : {}),
    });
  }
  return chapters;
}

/**
 * The whole file, header and all — the book in reading order, the links between
 * its prose and its apparatus, and the three facts the header carries.
 *
 * `flow.blocks` IS THE ANSWER and this function adds nothing to it but names,
 * boxes and the note split: the reflow already dropped the running heads, fused
 * the hyphens, reflowed the print lines, merged the two-line headings and joined
 * the page turns. That is deliberate — this file must never become a second
 * place where the book is decided, or the two will disagree and the one that
 * loses will be the one somebody edited. The marker match is the single
 * exception, and it is not a decision about the book: it is the emitter's own
 * rule, run over the same blocks, and written down instead of thrown away.
 *
 * ONE PASS, AND IT IS THE ONE WAY IN. A `bookRows` that handed back rows without
 * their links used to sit beside this and was exactly the trap the paragraph
 * above describes — a caller that used it wrote a book file whose notes pointed
 * at nothing, and nothing about the file said so. There is one way to make this
 * document now.
 *
 * The pass is single because the marker scan needs what a row throws away: a row
 * knows the page it started on, and only the FLOW block knows where each of its
 * parts ended. A marker in the second half of a joined paragraph was printed on
 * the second half's page. See `partSpans`.
 */
export function bookFile(flow: FlowBook): BookFile {
  const rows: BookRow[] = [];
  const idOf = new Map<FlowBlock, string>();
  const markers: PrintedMarker[] = [];
  const notes: { row: BookRow; printed: number | null; page: number }[] = [];

  for (const block of flow.blocks) {
    const made = bookRow(block);
    idOf.set(block, made[0]!.id);
    if (block.category === 'Footnote') {
      // EVERY note row carries `refs`, including the empty ones. An absent field
      // and an empty list would be two spellings of the same fact — "nothing
      // points at this note" — and a reader would have to know which spelling
      // this file uses. It uses one.
      for (const row of made) {
        row.refs = [];
        notes.push({ row, printed: printedNoteNumber(row.text), page: row.page });
      }
    } else {
      markers.push(...markersIn(block, made[0]!.id));
    }
    rows.push(...made);
  }

  const loose = linkMarkers(markers, notes);
  return {
    rows,
    chapters: chapterSeed(flow, idOf),
    typography: flow.typography,
    loose: {
      markers: loose,
      notes: notes.filter((note) => note.row.refs!.length === 0).map((note) => note.row.id),
    },
  };
}

/**
 * The file: a header line, then one row per block.
 *
 * JSONL AND NOT JSON, for the bank's own reason — a line is a record, a reader
 * can stream it, and a file that was cut short costs the rows after the cut
 * rather than the whole book. The header is a row like any other so that the
 * format is one grammar rather than two.
 */
export function formatBookFile(book: BookFile): string {
  const header = JSON.stringify({
    book: BOOK_FILE_VERSION,
    blocks: book.rows.length,
    chapters: book.chapters,
    typography: book.typography,
    loose: book.loose,
  });
  return [header, ...book.rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
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
export function parseBookFile(text: string): BookFile {
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
  /*
   * ── AN OLD BOOK FILE IS THROWN AWAY, NOT MIGRATED ───────────────────────────
   *
   * Version 1 has no reference markers, no chapter seed and no typography in it,
   * and there is no reading of the rows that recovers them: the markers are
   * matched against pages the file does not record per part, and the chapter
   * starts were never written down at all. A migration could only invent them.
   *
   * It does not need one. This file is REGENERABLE — it is a pure function of
   * the bank, it costs no model, no rasteriser and no PDF, and a three-hundred
   * page book comes back in about as long as it takes to read the bank off the
   * disk. So the honest answer is the cheap one, and it is said as an
   * instruction rather than as a complaint.
   */
  if (version === 1) {
    throw new BookFileError(
      'it is a version 1 book file, written before reference markers, the chapter seed and the '
      + 'typography report were in it, and none of the three can be recovered from its rows. '
      + 'Regeneration is free: run vlm-book over the same bank again and it comes back in seconds, '
      + 'with every block wearing the id it already had.',
    );
  }
  if (version !== BOOK_FILE_VERSION) {
    throw new BookFileError(
      `it declares book format ${String(version)} and this program writes ${BOOK_FILE_VERSION}`,
    );
  }
  const { chapters, typography, loose } = header as Partial<BookFile>;
  /*
   * The header is checked as hard as a row is, and for the row check's reason:
   * it stopped being decoration at version 2. A file whose seed or whose linking
   * flags did not survive is a file the renderer would open with no chapter
   * lines and no unlinked marks, silently — which is indistinguishable, on
   * screen, from a book that has neither.
   */
  if (!Array.isArray(chapters)) {
    throw new BookFileError('its header carries no chapter seed, and version 2 always writes one');
  }
  if (typography === undefined) {
    throw new BookFileError(
      'its header carries no typography report, and version 2 always writes one — null where the '
      + 'book had nothing to measure, never absent',
    );
  }
  if (loose === undefined || !Array.isArray(loose.markers) || !Array.isArray(loose.notes)) {
    throw new BookFileError(
      'its header carries no linking flags, and version 2 always writes both lists — empty where '
      + 'every marker found its note, never absent',
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
  return { rows, chapters, typography, loose };
}
