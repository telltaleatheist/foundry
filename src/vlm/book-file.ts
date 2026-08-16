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
 *
 * ── VERSION 3: THE PROVENANCE, THE SEAMS, THE SHELF AND THE FIGURES ─────────
 *
 * v2 wrote down what the book SAYS. v3 writes down what it is made of, and
 * every one of the four additions closes a hole where something that happened
 * during the reflow left no record anybody downstream could read.
 * `docs/BOOK-FILE.md` is the contract and this is the implementation of it.
 *
 * THE HEADER SAYS WHERE IT CAME FROM. `engine` is the foundry that wrote it,
 * `language` is the read's declared language, and `source` carries the page
 * count, the pages that would not parse, and `bankSha` — the first sixteen hex
 * of a sha-256 over the receipt's own bytes. That last one is the whole point
 * of the group: this file is a pure function of the bank, so a loader that
 * finds the bank has changed underneath it knows the ids in front of it may
 * name nothing, and REFUSES BY NAME rather than replaying somebody's ops
 * against a book that has moved. A `generation` rides along where the bank
 * records one, and this bank records none, so the field is simply absent — the
 * contract marks it optional by absence and nothing here invents one.
 *
 * THE SEAMS ARE BLOCK IDS NOW, NOT PAGE NUMBERS. `reflowBook` reports the page
 * turns it declined to join as a list of page numbers, which is the right shape
 * for a log line and the wrong shape for anything that has to act: "p13" is not
 * a thing on the screen, and a person joining a seam has to be handed the two
 * paragraphs that would become one. So each declined turn is resolved here into
 * the pair of adjacent flowing blocks it falls between — `{after, before}` —
 * and a turn that cannot be resolved to a pair stops the run instead of being
 * dropped or guessed at.
 *
 * NOTHING IS SILENTLY GONE — THE SHELF. Two passes DELETE blocks the model
 * answered: the parse separates what was tagged Page-header or Page-footer, and
 * `suppressRunningHeads` takes out the body-tagged blocks it judges to be
 * running heads. Both were reported as counts and neither was written into any
 * file, so a book that lost thirty-six blocks was a book nobody could check and
 * nothing could restore. Now every one of them is a ROW, wearing the id it
 * would have worn in the flow, sitting at its reading-order position, carrying
 * `shelf` and a sentence saying why. Restoring one is an ordinary op against
 * its id; a renderer draws the flow and leaves the shelf where it is.
 *
 * AND THE FIGURES ARE CUT ONCE. A Picture block is pixels by definition, and
 * until now those pixels were cropped out of the page renders while an EPUB was
 * being zipped — once per export, into a container, thrown away with it. They
 * are cut here instead, into `readings/<key>.images/`, named by the source
 * coordinate the row was minted from, and every later reader points at the same
 * file. Cutting needs the page renders, so it needs the archived PDF; without
 * one the rows carry no `image` and the run says so out loud.
 */
import { VERSION } from '../version.js';
import type { DotsBlock, DotsBox, DotsCategory, DotsPageKind } from './dots.js';
import { SUPERSCRIPT_RUN } from './dots.js';
import {
  KIND_LABEL,
  printedNoteNumber,
  sectionName,
  splitNotes,
  type FlowBlock,
  type FlowBook,
  type FurnitureEvidence,
} from './dots-book.js';
import type { TypographyReport } from './typography.js';

/**
 * The format written into the file, so a reader can refuse a shape it cannot use.
 *
 * 3 — v2's rows with `parts` in place of the bare `src` list, the shelved
 * blocks as rows of their own, `image` on the Picture rows, and a header that
 * carries the engine, the language, the bank's identity and the seams. See this
 * file's header for what each is for, and `docs/BOOK-FILE.md` for the contract.
 */
export const BOOK_FILE_VERSION = 3;

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
   * How the text was assembled, char-exact — one entry per banked answer this
   * block is made of, in order.
   *
   * ── WHY THIS SUPERSEDED THE BARE `src` LIST ────────────────────────────────
   *
   * v2 carried the coordinates and nothing else: `["2:3", "3:1"]` says which two
   * answers a paragraph came from and says nothing about WHERE the seam between
   * them falls in the string it produced. Every reader that needed to know —
   * the emitter writing a pagebreak marker at the turn, the marker scan working
   * out which page a superscript was printed on, a future surface showing a
   * person the two halves they are about to unjoin — had to re-derive the
   * division by walking the flow block's parts again, which is the arithmetic
   * this file exists to do once. `chars` is that division, written down: a
   * half-open `[start, end)` into this row's FINAL text, and the ranges TILE it
   * exactly, with no gap and no overlap, from 0 to its length.
   *
   * `fused` is the word the column broke, made whole, and it is recorded on the
   * part that BEGINS with it — which is the later page, the same answer the
   * emitter gives when it writes the marker before the whole word rather than
   * inside it. It is therefore never on the first part of anything.
   *
   * The coordinates stay, inside the parts, because they are still the
   * re-keying bridge: anything recorded against a banked `page:order` before ids
   * existed can be pointed at a row without a guess.
   */
  parts: BookPart[];
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
  /**
   * The figure cut out of the page for this row, by name inside
   * `readings/<key>.images/` — set on a `Picture` row and on no other kind, and
   * absent on every row of a run that was given no PDF to cut from.
   *
   * A NAME AND NOT A PATH, because the file is a portable document about a book
   * and an absolute path is a fact about one machine (§7 of the contract). The
   * directory is derived from the bank the row was reflowed out of, which every
   * reader of this file already knows the way to.
   */
  image?: string;
  /**
   * Why this row is NOT in the flow — absent, always, on a row that is.
   *
   * See §5 of the contract: every block the model answered is a row, and a row
   * is either in the book or on the shelf. `furniture` is what the parse
   * separated because the model tagged it Page-header or Page-footer;
   * `suppressed-head` is what `suppressRunningHeads` judged to be a running head
   * the model had mistagged as body text.
   */
  shelf?: BookShelf;
  /** One sentence of evidence — set on a shelved row and on no other kind. */
  why?: string;
}

/** One banked answer's contribution to a row's text. See `BookRow.parts`. */
export interface BookPart {
  /** `page:order`, or `page:order:part` for a piece of one answer element. */
  src: string;
  /** The page THIS part was printed on, which a joined row's `page` is not. */
  page: number;
  /** Half-open `[start, end)` into the row's final text. The ranges tile it. */
  chars: [number, number];
  /** The word the column broke, made whole. Never on the first part. */
  fused?: string;
}

/** The two ways a block can be out of the flow and still be in the book. */
export type BookShelf = 'furniture' | 'suppressed-head';

/**
 * A page turn `f` declined to join, as the two blocks it falls between.
 *
 * NOT A PAGE NUMBER, which is what the reflow reports and what every log line
 * about this has always said. A person joining a seam is joining two
 * paragraphs, and a renderer offering them the choice has to draw the offer
 * between two things on the screen; "page 13" names neither of them. Both ids
 * are flowing rows and they are adjacent in reading order.
 */
export interface BookSeam {
  /** The row the paragraph before the turn ends at. */
  after: string;
  /** The row the page after the turn opens with. */
  before: string;
}

/**
 * What this book was made out of — the bank, identified.
 *
 * `bankSha` IS THE LOAD-BEARING ONE. This file is a pure function of the
 * receipt, so the receipt's identity is this file's warrant: a loader that finds
 * a different bank under the same name is holding a book whose ids may name
 * blocks that no longer exist, and the only safe thing it can do is refuse by
 * name and let the one door that may rebuild do it as an announced action
 * (§2 of the contract). Sixteen hex is eight bytes of a sha-256 — far past
 * accidental collision for a directory of books, and short enough to read.
 */
export interface BookSource {
  /** Page answers in the bank, whether or not they parsed. */
  pages: number;
  /** The pages whose answer would not parse, named and skipped. */
  unreadable: { page: number; reason: string }[];
  /**
   * The app's binding of this reading to the step that produced it, carried and
   * never interpreted — ABSENT where the bank records none, which is every bank
   * this program has written so far. Nothing here invents one.
   */
  generation?: string;
  /** sha-256 of the receipt's bytes, first 16 hex. */
  bankSha: string;
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
  /** The foundry that wrote it — provenance, and the only field a release moves. */
  engine: string;
  /** The read's declared language. Declared, never detected. */
  language: string;
  source: BookSource;
  rows: BookRow[];
  chapters: BookChapter[];
  typography: TypographyReport | null;
  seams: BookSeam[];
  loose: BookLoose;
}

/**
 * Everything that goes into a book file and is not derivable from the flow.
 *
 * THE FURNITURE IS IN HERE BECAUSE `reflowBook` DOES NOT CARRY IT. The parse
 * separates the tagged Page-header and Page-footer blocks into
 * `DotsParsedPage.furniture` and the reflow never looks at them again — quite
 * correctly, because they are not the book. They ARE rows of this file (§5),
 * so the caller, which is holding the parsed pages, hands them over rather than
 * the reflow's signature growing a field it has no use for.
 */
export interface BookFileInput {
  flow: FlowBook;
  /** The Page-header/Page-footer blocks the parse set aside, in reading order. */
  furniture: readonly DotsBlock[];
  language: string;
  source: BookSource;
}

/** `page:order` for a whole answer element, `page:order:part` for a piece of one. */
function coordinate(block: DotsBlock): string {
  return block.part === 0
    ? `${block.page}:${block.order}`
    : `${block.page}:${block.order}:${block.part}`;
}

/** The name a block wears in this file, minted off its first banked answer. */
function blockId(block: DotsBlock): string {
  return `b${coordinate(block).replace(/:/g, '-')}`;
}

/**
 * The file name a figure is cut to, from the coordinate its row was minted at.
 *
 * DETERMINISTIC FROM THE BANK AND FROM NOTHING ELSE, which is what makes the
 * directory regenerable and what lets a second run overwrite the same file
 * rather than leave a second copy of the same picture beside it. The old
 * emitter numbered its crops by their position in the EPUB it was zipping
 * (`p0005-0.png` for the first picture in the book), so the same figure changed
 * its name the day a chapter was split — a name that moves is not a name.
 *
 * The page is padded so a directory listing sorts the way the book reads.
 */
export function figureName(src: string): string {
  const [page, order] = src.split(':');
  return `p${(page ?? '').padStart(4, '0')}-${order ?? ''}.png`;
}

/**
 * The core image types an EPUB may carry, by the extension a figure's NAME ends
 * with — and the one place this program turns the one into the other.
 *
 * ── Why a constant became a table ──────────────────────────────────────────
 *
 * The bank route cuts every figure itself, with one rasteriser, into one format,
 * so `image/png` was not a guess: it was a description of a file this program had
 * just written. The imported-EPUB route does not cut anything. It COPIES the
 * publisher's own file (docs/RENDERER.md §6, the refinement paragraph: the
 * publisher's data is retained, not rediscovered), and that file is a JPEG about
 * as often as it is a PNG. Declaring it `image/png` in the package manifest would
 * be a lie in the one document a reading system consults before it draws
 * anything, told about a file this program did not make.
 *
 * The list is EPUB 3's core image set — GIF, JPEG, PNG, SVG — plus WebP, which
 * 3.3 added. An extension outside it is not a picture an EPUB may legally carry,
 * so it is refused BY NAME at the explode rather than carried and mislabelled:
 * a reader given a media type its parser rejects shows a hole where the figure is
 * and says nothing about why.
 */
const FIGURE_TYPES: ReadonlyMap<string, string> = new Map(Object.entries({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}));

/** The media type a figure of this name is, or a refusal naming what is known. */
export function figureMediaType(name: string): string {
  const dot = name.lastIndexOf('.');
  const found = dot < 0 ? undefined : FIGURE_TYPES.get(name.slice(dot + 1).toLowerCase());
  if (found === undefined) {
    throw new BookFileError(
      `"${name}" is named as a figure and this program has no media type for it. An EPUB carries `
      + `pictures as ${[...FIGURE_TYPES.keys()].join(', ')}, and a package that declared the wrong `
      + 'type for one would draw a hole where the picture is.',
    );
  }
  return found;
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
  const id = blockId(first);
  const composed = bookParts(block, id);

  if (block.category !== 'Footnote') {
    return [{
      id,
      category: block.category,
      text: block.text,
      page: first.page,
      pages,
      box,
      pageWidth: first.pageWidth,
      pageHeight: first.pageHeight,
      parts: composed,
    }];
  }
  /*
   * ── A NOTE'S PARTS ARE ITS BLOCK'S, RE-BASED ONTO THE NOTE ──────────────────
   *
   * The split shares one banked answer between several rows, so every note in a
   * footnote block came from the same coordinate and there is exactly one part
   * to record. Its `chars` are `[0, len)` of the NOTE's text and not of the
   * block's, because `chars` is defined against the row it is on and the row's
   * text is the note.
   *
   * NOTHING FINER IS INVENTED. It would be possible to compute where each note
   * begins inside the banked block and record that instead, and it would be a
   * coordinate into a string this file does not carry — useful to nobody and
   * wrong the moment `splitNotes` improves. A footnote block is never joined
   * across a leaf (`flowBlocks` gives it the early exit), so one part is the
   * only shape this can have, and a block that somehow arrives with two stops
   * the run rather than being divided by a rule nobody wrote.
   */
  if (composed.length !== 1) {
    throw new BookFileError(
      `footnote block "${id}" is made of ${composed.length} banked answers, and a note is cut out of `
      + 'ONE. There is no rule here for dividing a note between two answers and none is invented.',
    );
  }
  const source = composed[0]!;
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
      id: `${id}#${ordinal}`,
      category: block.category,
      text,
      page: first.page,
      pages,
      box: { x1: box.x1, y1: top, x2: box.x2, y2: top + share },
      pageWidth: first.pageWidth,
      pageHeight: first.pageHeight,
      parts: [{ src: source.src, page: source.page, chars: [0, text.length] }],
      note: ordinal,
    };
    top += share;
    return row;
  });
}

/**
 * One block on the shelf as one row — §5 of the contract, in code.
 *
 * IT IS A ROW LIKE ANY OTHER AND THAT IS THE ENTIRE POINT. Same id rule, same
 * box, same page, same single part naming the banked answer it came from, so
 * that restoring it to the flow is an op against an id rather than a second
 * grammar for a second kind of thing. What it carries on top is `shelf`, which
 * a renderer reads to leave it out of the book, and `why`, which is the
 * sentence a person reads before deciding the pass was wrong.
 */
export function shelfRow(block: DotsBlock, shelf: BookShelf, why: string): BookRow {
  return {
    id: blockId(block),
    category: block.category,
    text: block.text,
    page: block.page,
    pages: [block.page],
    box: block.box,
    pageWidth: block.pageWidth,
    pageHeight: block.pageHeight,
    parts: [{ src: coordinate(block), page: block.page, chars: [0, block.text.length] }],
    shelf,
    why,
  };
}

/**
 * The sentence a tagged piece of furniture carries.
 *
 * The shortest `why` in the file and the strongest: nothing inferred anything
 * here, the model looked at the page and said this block was a page header or a
 * page footer, and `parseDotsPage` set it aside on that word alone. Somebody
 * reading a Furniture Review panel is deciding whether to overrule the model,
 * which is a different and easier question than deciding whether to overrule a
 * pass that measured the book — so the sentence says which of the two they are
 * looking at.
 */
export function furnitureWhy(category: DotsCategory): string {
  return `the model itself tagged this block ${category}, so the parse set it aside before the book `
    + 'was assembled';
}

/**
 * The sentence a suppressed head carries, composed from the evidence that
 * condemned it.
 *
 * `FurnitureEvidence` is one word — `tagged` or `body-sized` — and one word is
 * what a log line can afford (`vlm-convert` prints exactly that, beside the
 * text). A row in a Furniture Review panel is read by somebody deciding whether
 * to put the block back, and "body-sized" tells them nothing about what was
 * actually measured. So each path says what it found, in a sentence, and the
 * two sentences say plainly which is the stronger argument: one is the model's
 * own answer somewhere else in the book, the other is an inference off the
 * book's own printing for words the model never labelled once.
 */
export function suppressedHeadWhy(evidence: FurnitureEvidence): string {
  return evidence === 'tagged'
    ? 'the model tagged these same words page furniture elsewhere in the book, and they recur in the '
      + 'furniture band on three pages or more'
    : 'nothing in the book ever tagged these words as furniture, and they recur in the furniture band '
      + 'at body size on three pages or more, which no chapter opening is printed at';
}

/**
 * Where each part of a joined paragraph sits inside the block's one text, and
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
 * THE SEPARATOR AND THE FUSED WORD BELONG TO THE LATER PART, which is what
 * makes the ranges TILE rather than merely cover: every character of the text
 * is in exactly one part, and the first one starts at 0. The fused word going
 * with the later page is the emitter's own answer for it — it is half on each
 * leaf and neither answer is more true, and what matters is that both readers
 * say the same one.
 *
 * The composed length is checked against the text HERE, once, for every block
 * in the book rather than only for the ones a marker scan was about. See the
 * refusal for what a mismatch means.
 */
function bookParts(block: FlowBlock, id: string): BookPart[] {
  const parts: BookPart[] = [];
  let at = 0;
  for (const part of block.parts) {
    const start = at;
    if (part.join === 'space') at += 1;
    if (part.fused !== null) at += part.fused.length;
    at += part.text.length;
    parts.push({
      src: coordinate(part.block),
      page: part.page,
      chars: [start, at],
      ...(part.fused !== null ? { fused: part.fused } : {}),
    });
  }
  if (at !== block.text.length) {
    /*
     * THE PARTS NO LONGER COMPOSE THE TEXT, which means the reflow and this file
     * disagree about what the block says. Nothing after this point is safe: a
     * marker would be filed under a page it was not printed on, and a `chars`
     * range would name characters that are not there — both of which read as
     * correct data and are not. See PLAN.md's rule; there is no fallback here.
     */
    throw new BookFileError(
      `block "${id}" is ${block.text.length} character(s) long and its ${block.parts.length} `
      + `part(s) compose ${at}, so there is no telling which page any of it was printed on`,
    );
  }
  return parts;
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
 *
 * TAKES THE ROW'S OWN `parts` rather than working the division out again. They
 * are the same division — that is what `chars` IS — and computing it twice is
 * how two answers to one question get into a program, which is the sentence
 * this whole file is written under.
 */
function markersIn(text: string, id: string, parts: readonly BookPart[]): PrintedMarker[] {
  const markers: PrintedMarker[] = [];
  for (const match of text.matchAll(SUPERSCRIPT_RUN)) {
    const at = match.index;
    const run = match[0];
    markers.push({
      block: id,
      at,
      len: run.length,
      // Both assertions are `bookParts`' check, spent: the run is superscript
      // digits and nothing else, so it has a printed value; and the parts
      // compose the text exactly, so every offset in it falls inside a part.
      printed: printedNoteNumber(run)!,
      page: parts.find((part) => at < part.chars[1])!.page,
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
 * The page turns the reflow declined, as pairs of block ids.
 *
 * ── WHY THE PAGE NUMBER HAS TO BE RESOLVED AND CANNOT BE CARRIED ────────────
 *
 * `flowBlocks` counts a declined turn where it happens and records the PAGE,
 * which is all a log line ever wanted: "4 page turn(s) left as two paragraphs
 * (p8, p13, p14, p16)". A file that carried those four numbers forward would be
 * carrying the one kind of address this format has spent its whole existence
 * refusing — nothing here is keyed by a page, and a person joining a seam needs
 * the two paragraphs, not the leaf they fell across.
 *
 * So each number is resolved back to the pair it fell between: the block that
 * OPENS page N, and the paragraph that was open when the reflow refused to
 * continue it. It is deterministic because the flow is in reading order and the
 * search moves forward — a book that declined two turns onto the same page
 * (which the counting rule cannot produce, and which costs nothing to be right
 * about anyway) resolves them to two different pairs rather than twice to the
 * first.
 *
 * ── THE NOTES AT THE FOOT OF PAGE N-1 ARE SKIPPED, AND THAT IS THE WHOLE OF
 *    THE ARGUMENT HERE ────────────────────────────────────────────────────────
 *
 * The block immediately before the turn in reading order is very often the
 * FOOTNOTE block of the page that just ended, because that is where the printer
 * put the notes. It is not the other half of the seam. `flowBlocks` says so
 * outright — "A FOOTNOTE DOES NOT CLOSE A PARAGRAPH", it is held back to the end
 * of its chapter and writes nothing where it stands — so the paragraph the
 * refused block would have joined is the last NON-note block before it, and in
 * the book a reader sees those two paragraphs are touching. Recording the note
 * instead would hand a renderer two things to offer to join that cannot be
 * joined: splicing a footnote into the middle of the prose is not a repair
 * anybody wants, and it would be offered on four seams out of four in the first
 * real book this was run over.
 *
 * A TURN THAT RESOLVES TO NOTHING STOPS THE RUN. It would mean the count and
 * the blocks it was counted from disagree, and the two available fallbacks are
 * dropping the seam — which hides a decision somebody has to make, the exact
 * failure this file exists to end — or naming a pair by proximity, which offers
 * a person two paragraphs to join that the printer never broke.
 */
function bookSeams(
  flow: FlowBook,
  rowIds: ReadonlyMap<FlowBlock, { first: string; last: string }>,
): BookSeam[] {
  const seams: BookSeam[] = [];
  let from = 1;
  for (const page of flow.unjoinedTurns) {
    let opens = -1;
    let carried = -1;
    for (let i = from; i < flow.blocks.length; i += 1) {
      const before = flow.blocks[i]!;
      if (before.category === 'Footnote' || before.parts[0]!.page !== page) continue;
      let back = i - 1;
      while (back >= 0 && flow.blocks[back]!.category === 'Footnote') back -= 1;
      if (back < 0) continue;
      const after = flow.blocks[back]!;
      if (after.parts[after.parts.length - 1]!.page !== page - 1) continue;
      opens = i;
      carried = back;
      break;
    }
    if (opens === -1) {
      throw new BookFileError(
        `the reflow left the page turn onto page ${page} as two paragraphs, and no block of the `
        + 'flowing book opens that page after a paragraph that ends on the one before it, so there '
        + 'is no pair of names to record the seam as. A seam nobody can be shown is a decision '
        + 'nobody can make.',
      );
    }
    seams.push({
      after: rowIds.get(flow.blocks[carried]!)!.last,
      before: rowIds.get(flow.blocks[opens]!)!.first,
    });
    from = opens + 1;
  }
  return seams;
}

/** Sort key for reading order: the banked coordinate a row was minted at. */
function beforeInReadingOrder(
  a: { page: number; order: number; part: number },
  b: { page: number; order: number; part: number },
): number {
  return a.page - b.page || a.order - b.order || a.part - b.part;
}

/**
 * The whole file, header and all — the book in reading order, the links between
 * its prose and its apparatus, and everything the header carries.
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
 * the second half's page. See `bookParts`.
 *
 * ── THE SHELF IS INTERLEAVED AND NOT APPENDED ───────────────────────────────
 *
 * A shelved block sits in the file at the coordinate it was printed at, between
 * the flowing rows it was printed between, and the whole reason is what happens
 * when somebody restores one: the op says "put this back in the flow" and the
 * only place it can honestly go is where the page had it. A shelf appended in a
 * lump at the end of the file would make every restore a question about
 * position, answered by whatever the restoring code guessed — and page 4's
 * running head would come back somewhere in chapter nine.
 *
 * The sort is total and exact: `(page, order, part)` is the bank's own reading
 * order, every block in the book has a distinct one, and the flowing rows are
 * already in it (a merge keeps the FIRST part, and the reflow walks the pages
 * forwards), so this places the shelf without moving anything else. The shelved
 * rows take no part in the chapters, the seams or the marker match — they are
 * not in the flow, and a running head that matched a marker would be a link
 * into a block the book does not contain.
 */
export function bookFile(input: BookFileInput): BookFile {
  const { flow } = input;
  const idOf = new Map<FlowBlock, string>();
  const rowIds = new Map<FlowBlock, { first: string; last: string }>();
  const markers: PrintedMarker[] = [];
  const notes: { row: BookRow; printed: number | null; page: number }[] = [];
  /** Every row with the banked coordinate it belongs at, flow and shelf alike. */
  const placed: { page: number; order: number; part: number; rows: BookRow[] }[] = [];

  for (const block of flow.blocks) {
    const made = bookRow(block);
    idOf.set(block, made[0]!.id);
    rowIds.set(block, { first: made[0]!.id, last: made[made.length - 1]!.id });
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
      markers.push(...markersIn(block.text, made[0]!.id, made[0]!.parts));
    }
    const first = block.parts[0]!;
    placed.push({ page: first.page, order: first.order, part: first.part, rows: made });
  }

  for (const block of input.furniture) {
    placed.push({
      page: block.page,
      order: block.order,
      part: block.part,
      rows: [shelfRow(block, 'furniture', furnitureWhy(block.category))],
    });
  }
  for (const head of flow.suppressedHeads) {
    placed.push({
      page: head.page,
      order: head.order,
      part: head.part,
      rows: [shelfRow(head, 'suppressed-head', suppressedHeadWhy(head.why))],
    });
  }
  placed.sort(beforeInReadingOrder);

  const rows = placed.flatMap((entry) => entry.rows);
  /*
   * TWO ROWS OF ONE NAME IS THE FAILURE EVERY OP IN THE PROJECT WOULD INHERIT,
   * and the shelf is the first thing that could ever have produced one — until
   * this version every row came out of one list. It cannot happen (a banked
   * coordinate belongs to exactly one block, and furniture, suppressed heads and
   * flowing blocks are three disjoint sets of them), which is precisely why it
   * is asserted here rather than trusted: the day it does happen, a strike would
   * strike whichever the reader found first and nothing would say so.
   */
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new BookFileError(`two blocks of this book are both called "${row.id}"`);
    }
    seen.add(row.id);
  }

  const loose = linkMarkers(markers, notes);
  return {
    engine: VERSION,
    language: input.language,
    source: input.source,
    rows,
    chapters: chapterSeed(flow, idOf),
    typography: flow.typography,
    seams: bookSeams(flow, rowIds),
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
 *
 * THE HEADER IS EXACTLY THE FIELDS THE CONTRACT NAMES, in the contract's order.
 * v2 wrote a `blocks` count as well, which was a number a reader could get by
 * counting the rows it already had to read — and a field in the file that is not
 * in `docs/BOOK-FILE.md` is a field two documents can disagree about. It went
 * with the version bump.
 *
 * NO TIMESTAMP ANYWHERE, which is what makes the same bank produce the same
 * bytes on any machine and any day. `engine` is the one thing in here that
 * changes without the bank changing, and it changes with a release rather than
 * with a run.
 */
export function formatBookFile(book: BookFile): string {
  const header = JSON.stringify({
    book: BOOK_FILE_VERSION,
    engine: book.engine,
    language: book.language,
    source: book.source,
    chapters: book.chapters,
    typography: book.typography,
    seams: book.seams,
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
 * The names a row may wear — §4 of the contract, as one expression.
 *
 * `b<page>-<order>`, with `-<part>` where the markdown pass cut one banked
 * answer into several, `#<ordinal>` where the note splitter cut one footnote
 * block into several, and `/<n>` — repeatable — where a PERSON split a block
 * with an op. The last of those is minted by replay and never by this file, and
 * it is accepted here because a parser that refused it would refuse every book
 * anybody had edited. Which is the whole reason the grammar is written down
 * once, in a place both minters can be checked against.
 *
 * ── AND `e-<n>`, WHICH IS AN IMPORTED EPUB'S OWN NAME FOR A BLOCK ───────────
 *
 * A book minted from a publisher's EPUB has no bank and never will
 * (docs/RENDERER.md §6, the refinement: an EPUB is never OCR'd into a bank —
 * a bank models pages and an EPUB has none). So `b<page>-<order>` has nothing to
 * be made of: there is no page and no banked answer, and inventing a page number
 * to name a block after would be the one thing this format has never done. What
 * an EPUB has instead is an ORDER — the spine, then document order inside each
 * spine document — and that order is total, is the publisher's own, and does not
 * move when this program's explode improves. `e-<n>` is that ordinal, counted
 * from 1 across the whole book, and `#`/`/` ride on it exactly as they ride on a
 * banked name.
 *
 * THE FORMAT VERSION DOES NOT MOVE FOR IT, and that is the version discipline of
 * §2 applied rather than dodged. A version bump says "a reader of the old shape
 * would read this file WRONG"; this change invalidates nothing that has ever been
 * written — no file anywhere carries an `e-` id yet — and admits names an older
 * build has never had to mean anything by. An older build that meets one refuses
 * it with the id-grammar sentence below, which is the correct answer from a build
 * that cannot draw a book it has no explode for.
 */
const ROW_ID = /^(?:b\d+-\d+(?:-\d+)?|e-\d+)(?:#\d+)?(?:\/\d+)*$/;

/**
 * Read one back, or say exactly what about it is not a book.
 *
 * EVERY ROW IS CHECKED AND A BAD ONE TAKES THE FILE DOWN. This is the document
 * every op in the project is keyed to; a file assembled out of the rows that
 * happened to parse is a book with paragraphs silently missing and a curation
 * pointing at blocks that are no longer in it.
 *
 * STRICT ABOUT WHAT IS MISSING OR MALFORMED, LENIENT ABOUT WHAT IS EXTRA. That
 * asymmetry is the version discipline of §2 stated as code: a field this build
 * has never heard of is a field a later foundry added, and refusing it would
 * mean a book file could only ever be opened by the exact build that wrote it.
 * A field that is named in the contract and is not here, or is here as the
 * wrong shape, is a file that lost something — and a reader that shrugged at
 * that would show somebody a book with pieces silently missing.
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
  if (version === 1 || version === 2) {
    throw new BookFileError(
      `it is a version ${version} book file. Version 1 was written before reference markers, the `
      + 'chapter seed and the typography report; version 2 before the parts that say char by char '
      + 'how each block was assembled, before the shelf that keeps the running heads and the page '
      + 'furniture as rows, before the seams were pairs of block names, and before the figures were '
      + 'cut. None of that can be recovered from the rows of an older file — a migration could only '
      + 'invent it. Regeneration is free: run vlm-book over the same bank again and the book comes '
      + 'back in seconds, with every block wearing the id it already had.',
    );
  }
  if (version !== BOOK_FILE_VERSION) {
    throw new BookFileError(
      `it declares book format ${String(version)} and this program writes ${BOOK_FILE_VERSION}`,
    );
  }
  const { engine, language, source, chapters, typography, seams, loose } = header as Partial<BookFile>;
  /*
   * The header is checked as hard as a row is, and for the row check's reason:
   * it stopped being decoration at version 2. A file whose seed or whose linking
   * flags did not survive is a file the renderer would open with no chapter
   * lines and no unlinked marks, silently — which is indistinguishable, on
   * screen, from a book that has neither. Version 3 put the bank's own identity
   * up there too, and that one is worse to lose: without `bankSha` a loader
   * cannot tell whether the ids in front of it still name anything.
   */
  if (typeof engine !== 'string' || typeof language !== 'string') {
    throw new BookFileError(
      'its header does not say which foundry wrote it and in what language the book was read, and '
      + 'version 3 always writes both',
    );
  }
  if (
    source === undefined
    || typeof source.pages !== 'number'
    || !Array.isArray(source.unreadable)
    || typeof source.bankSha !== 'string'
    || (source.generation !== undefined && typeof source.generation !== 'string')
  ) {
    throw new BookFileError(
      'its header does not say what bank it was made from — version 3 always writes source.pages, '
      + 'source.unreadable and source.bankSha, and without the last of those nothing can tell '
      + 'whether the receipt underneath has moved',
    );
  }
  if (!Array.isArray(chapters)) {
    throw new BookFileError('its header carries no chapter seed, and version 3 always writes one');
  }
  if (typography === undefined) {
    throw new BookFileError(
      'its header carries no typography report, and version 3 always writes one — null where the '
      + 'book had nothing to measure, never absent',
    );
  }
  if (
    !Array.isArray(seams)
    || seams.some((seam) => typeof seam?.after !== 'string' || typeof seam?.before !== 'string')
  ) {
    throw new BookFileError(
      'its header carries no seams, and version 3 always writes the list — empty where the reflow '
      + 'joined every page turn, never absent, and every entry names the two blocks a declined turn '
      + 'falls between',
    );
  }
  if (loose === undefined || !Array.isArray(loose.markers) || !Array.isArray(loose.notes)) {
    throw new BookFileError(
      'its header carries no linking flags, and version 3 always writes both lists — empty where '
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
    if (!ROW_ID.test(row.id)) {
      throw new BookFileError(
        `block ${at + 1} is called "${row.id}", which is not a name this format mints: they are `
        + 'b<page>-<order> for a block read off a page, optionally -<part> for a cut answer, or '
        + 'e-<n> for a block exploded out of an imported EPUB, with #<ordinal> for a note and /<n> '
        + 'for a block somebody split',
      );
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
    checkParts(row.id, row.text, row.parts);
    if (row.shelf !== undefined) {
      if (row.shelf !== 'furniture' && row.shelf !== 'suppressed-head') {
        throw new BookFileError(
          `block "${row.id}" says it is shelved as "${String(row.shelf)}", and the shelf has two `
          + 'places on it: furniture, and suppressed-head',
        );
      }
      // A shelved row without its sentence is the Furniture Review panel with a
      // blank cell where the argument goes, which is the one thing the shelf
      // exists to prevent — a block out of the book and nothing saying why.
      if (typeof row.why !== 'string' || row.why.length === 0) {
        throw new BookFileError(
          `block "${row.id}" is on the shelf and says nothing about why, and a row nobody can be `
          + 'given a reason for is a row nobody can decide about',
        );
      }
    }
    if (row.image !== undefined && typeof row.image !== 'string') {
      throw new BookFileError(`block "${row.id}" names its figure as something that is not a name`);
    }
    rows.push(row as BookRow);
  }
  return { engine, language, source, rows, chapters, typography, seams, loose };
}

/**
 * A row's parts, checked against the row's own text.
 *
 * CHAR-EXACT IS THE CONTRACT AND SO IT IS CHECKED, not assumed. `chars` is the
 * one field in this format that makes a claim about ANOTHER field of the same
 * row, and a claim like that is either verified where the file is read or it is
 * a rumour every later reader acts on: an offset past the end of the text
 * slices nothing, a gap between two parts loses characters that belong to a
 * page, and an overlap files the same words under two of them. All three read
 * as ordinary data and none of them is.
 */
function checkParts(id: string, text: string, parts: BookPart[] | undefined): void {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new BookFileError(
      `block "${id}" carries no parts, and version 3 says of every row which banked answers it was `
      + 'assembled from and which characters each one contributed',
    );
  }
  let at = 0;
  for (const [index, part] of parts.entries()) {
    if (
      typeof part?.src !== 'string'
      || typeof part.page !== 'number'
      || !Array.isArray(part.chars)
      || part.chars.length !== 2
      || typeof part.chars[0] !== 'number'
      || typeof part.chars[1] !== 'number'
    ) {
      throw new BookFileError(
        `part ${index + 1} of block "${id}" is not a banked answer with a page and a character range`,
      );
    }
    if (part.fused !== undefined && typeof part.fused !== 'string') {
      throw new BookFileError(`part ${index + 1} of block "${id}" fused something that is not a word`);
    }
    if (part.chars[0] !== at || part.chars[1] < at) {
      throw new BookFileError(
        `part ${index + 1} of block "${id}" covers characters ${part.chars[0]} to ${part.chars[1]} `
        + `and the parts before it end at ${at}, so the row's text is not divided between them`,
      );
    }
    at = part.chars[1];
  }
  if (at !== text.length) {
    throw new BookFileError(
      `block "${id}" is ${text.length} character(s) long and its parts account for ${at} of them`,
    );
  }
}
