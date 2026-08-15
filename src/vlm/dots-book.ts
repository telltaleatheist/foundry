/**
 * vlm/dots-book — the book, assembled from what dots.ocr measured.
 *
 * `epub.ts` builds a book out of a stream of blocks with a page number on each.
 * That is all the markdown dialects can supply, and everything below is a thing
 * you can only do once the blocks carry a BOX. Each of these is here because a
 * real book, read today, was wrong without it:
 *
 *  - **Alignment is judged against the book's body column** (`bodyColumn` in
 *    `dots.ts`), never the page. A justified column is itself centered on the
 *    paper, so a page-relative rule calls every paragraph in the book centered.
 *  - **A paragraph that runs over a page turn is ONE paragraph**, and the only
 *    evidence for it is the BANK. The previous block did not end on terminal
 *    punctuation and this one opens lowercase; or the column broke a word and
 *    the two halves are here. Both are pure functions of what the model
 *    answered, so the same bank makes the same book on any machine.
 *    **A TURN IS ONE PAGE, NOT A GAP.** Page 8 followed by page 12 is not a
 *    page turn: four pages of the book are missing between them, either struck
 *    out by `--skip-pages` or left out because the model could not read them.
 *    The words would happily join across that hole — a sentence interrupted
 *    mid-clause still reads as interrupted — and the join would fuse two
 *    unrelated sentences into one, which is a lie no reader can see. So a
 *    non-consecutive page break is a boundary, exactly like a chapter start.
 *  - **THE FLOWING BASE IS THE PRODUCT, AND THE XHTML IS DOWNSTREAM OF IT.**
 *    Every rule above used to happen while a string was being concatenated, so
 *    nothing could be shown to a person until a file existed and the rules had
 *    to be written a second time (`detectChapters`) for anything that wanted
 *    them without one. `reflowBook` is the pass they live in now: bank in,
 *    flowing blocks out, each carrying the `(page, order, part)` list of every
 *    block it swallowed. `buildDotsBook` and `detectChapters` are two readers
 *    of one answer, and the emitter below writes down what it is handed.
 *  - **Footnotes collect at the END OF THEIR CHAPTER.** Not per page: a page is
 *    not a unit of a reflowable book, and seventeen little note sections in a
 *    chapter is seventeen interruptions. One Footnote block routinely carries
 *    several notes, so it is split at its superscript starts and each note gets
 *    its own `<aside epub:type="footnote">` — a note nobody can see the start
 *    of is a note nobody reads.
 *  - **Markers LINK to their notes, and notes link back.** `¹⁴` in the prose
 *    becomes `<a epub:type="noteref" href="#fnN">`, matched by (page, printed
 *    number) because in print a footnote sits at the bottom of the page its
 *    reference is on — printed numbering restarts too often for the number
 *    alone to name a note. A marker with no matching note stays a plain
 *    `<sup>`: no link beats a wrong one.
 *  - **A Picture is the actual picture**, cropped out of the page render by its
 *    box and carried into the container with its Caption.
 *  - **The cover is the first page the book CONTAINS**, cropped whole by the
 *    same machinery — not page 1, because `--skip-pages 1-6` is an ordinary way
 *    to convert a book and those pages were never rendered. A run that cannot
 *    cut one writes the book anyway and names the reason: a grey thumbnail is
 *    worse than nothing on a shelf, and a book that was not produced is worse
 *    than either.
 *  - **A HEADING THE PAGE PRINTED ON TWO LINES IS ONE HEADING.** `II` on one
 *    line and `The Price of Judgment` on the next are two boxes because they
 *    ARE two boxes, and the book means one thing; anything handed both of them
 *    says it twice — two `<h1>`s, two anchors, two nav entries, and a contents
 *    that reads `II` for a chapter that has a name. `mergeAdjacentHeadings`
 *    joins them before any of that happens, on three guards that are pure
 *    arithmetic on the boxes, and reports every join: it is the only pass here
 *    that WRITES copy rather than moving or dropping it.
 *  - **Chapters are PROPOSED, not decided.** The rule is deterministic and
 *    written out beside the book as data: a Title or Section-header, first on
 *    its page, in the top 45%, short, and either chapter-ish or centered. It
 *    over-includes — a decorative half-title lands in the list — and that is the
 *    design. A human curates the list in the picker; a rule that silently
 *    dropped a real chapter would be uncorrectable, and one that offers an
 *    extra costs a click.
 *  - **A page that says what it IS opens its own section, and a part NESTS the
 *    chapters after it.** `classifyPage` (in `dots.ts`) names a title page, a
 *    copyright page, a contents page or a part divider when the page's
 *    signature is loud, and says nothing otherwise — which is the ordinary
 *    outcome and what an article gets from end to end. What it names becomes a
 *    section of its own, carries `data-bf-kind` for the picker to select on,
 *    and, for a part, becomes a parent in the nav. A book the classifier is
 *    silent about is assembled exactly as it was before any of this existed.
 *
 * EVERY ELEMENT CARRIES WHERE IT CAME FROM AND WHAT IT WAS. `data-bf-page` is
 * the PDF page, and `data-bf-cat` is the dots category, lower-cased, verbatim —
 * `text`, `title`, `section-header`, `footnote`, `caption`, `table`, `picture`,
 * `quote`, `formula`, `list-item`. An EPUB has no page concept and no memory of
 * a layout model's opinion, and both are unrecoverable the moment the pages are
 * joined; the picker in BookForge selects on exactly these two attributes
 * ("every footnote", "everything on page 3"), so they are a contract rather
 * than a debugging aid. The category is the MODEL's vocabulary and is never
 * re-derived from the tag that was chosen for it.
 *
 * AND `data-bf-id` NAMES THE ELEMENT, which the other two do not: a page holds
 * many blocks and a category holds many more. It is what an editing pass
 * addresses when a person says "cut this one" — see `stampId` for why every
 * other id in a cast book is unfit for that, and why the number counts elements
 * rather than blocks.
 *
 * ALL OF WHICH DESCRIBES THE CAST BOOK, WHICH IS A WORKBENCH. There is a second
 * thing this file writes, from the same blocks and the same overlay, and it is
 * the book somebody would hand to a library: no editing attributes, no struck
 * notes, reference numbers to notes that are gone demoted back to the digit the
 * page printed. `DotsBookOptions.final` is the flag and carries the argument in
 * full; it is off unless an export asked for it.
 */
import {
  alignmentClass,
  BookLexicon,
  bodyColumn,
  bottomFraction,
  carriesBodyProse,
  centerOffset,
  checkTableHtml,
  classifyPage,
  continuesTextually,
  dotsInline,
  leadingWord,
  plainText,
  topFraction,
  trailingHyphenWord,
  type BodyColumn,
  type DotsBlock,
  type DotsBox,
  type DotsCategory,
  type DotsPageKind,
  type DotsParsedPage,
} from './dots.js';
import {
  packageVlmEpub,
  XHTML_HEAD,
  XHTML_TAIL,
  type VlmChapter,
  type VlmCover,
  type VlmDocument,
  type VlmEpubMetadata,
  type VlmNavItem,
  type VlmResource,
} from './epub.js';
import { chapterStarts, emptyOverlay, noteStruck, type Overlay } from './overlay.js';
import { packageVlmText, type VlmOutputFormat } from './text-out.js';
import {
  bodyTypeSize,
  deriveTypography,
  measureTypeSizes,
  typeSize,
  type BookTypography,
  type TypographyReport,
} from './typography.js';

// ── the page images ─────────────────────────────────────────────────────────

/**
 * What the assembler needs from the page renders, and it is now ONE thing.
 *
 * IT USED TO ANSWER TWO QUESTIONS AND THE SECOND ONE IS DEAD. `inkExtent`
 * reported the leftmost and rightmost dark pixel in a box, and `carriesOver`
 * asked it whether a paragraph filled its last line to the margin and whether
 * the next page opened with a first-line indent — the half of the page-turn
 * join that is in the print and not in the words. It read well and it was not
 * trustworthy: a footnote sits at the bottom of the page too, and a book whose
 * notes are set full measure answers "this paragraph continues" on every page
 * of it. One signal deciding a structural question with no second opinion is
 * too many eggs in one basket, and the ruling (`docs/DERIVED-BOOK.md` §2) is
 * that nothing in this program samples ink again. The join is the bank's
 * answer or it does not happen, and the seams that leaves are joined by hand,
 * on the page, where a person can see what they are joining.
 *
 * What is left is CROPS, which are a different job entirely: a Picture and the
 * cover are pixels by definition, and cutting them out of a render is not an
 * inference about anything.
 */
export interface DotsPageImages {
  /** Crop these boxes out of their page renders, in one go. */
  crop(requests: readonly DotsCrop[]): Promise<readonly DotsCropped[]>;
}

export interface DotsCrop {
  page: number;
  box: DotsBox;
  /** File name inside the container, without a directory. */
  name: string;
}

export interface DotsCropped {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

// ── the cover ───────────────────────────────────────────────────────────────

/**
 * The file the whole first page is cut into. A bare name, like every other
 * crop: `DotsCrop.name` carries no directory, and the container decides where
 * the image lands (`images/`, beside the pictures).
 */
const COVER_CROP_NAME = 'cover.png';

/**
 * What became of the book's cover — the page it was cut from, or the reason
 * there is none.
 *
 * A REPORT AND NOT A RESOURCE. The bytes go into the package and never come
 * back out through here; what a run has to be able to say afterwards is which
 * page of the scan the reader will see first, because "the cover is page 7" is
 * only checkable if page 7 is written down. Exactly one of the two fields is
 * ever set: a cover with no page and a refusal with no reason are both a run
 * that cannot be argued with.
 */
export interface DotsCover {
  /** The PDF page it was cut from, whole. Null when the book has no cover. */
  page: number | null;
  /** Why the book has none, named. Null when it has one. */
  why: string | null;
}

/**
 * The page renders `vlm_page.py` left on disk, as far as the assembler is
 * concerned.
 *
 * A NAMED SEAM RATHER THAN A BARE OBJECT, and it is worth keeping as one even
 * now that it forwards a single function. It used to open PGM rasters and cache
 * one at a time — a 300-page book at 200 dpi is 800 MB of them — and that half
 * of it went with the ink test. What it still marks is the boundary the
 * assembler does not cross: everything above this line is arithmetic over
 * banked answers, and everything past it is a subprocess reaching for pixels.
 * A test hands over a crop function that returns nothing and gets a whole book
 * out of it, which is the property that boundary exists to preserve.
 */
export function openPageImages(
  crop: (requests: readonly DotsCrop[]) => Promise<readonly DotsCropped[]>,
): DotsPageImages {
  return { crop };
}

// ── the running head the model mistagged ────────────────────────────────────

/**
 * A running head, reduced to what is the same about it on every page it is on.
 *
 * Three things vary and none of them is the head: LETTER-SPACING, which a
 * designer sets as `N U R E M B E R G` and the model reads with the spaces in;
 * DECORATION, which is `■ INDEX ■` on one page and `• INDEX •` on the next; and
 * the FOLIO, which is a different number every time. So everything but letters
 * and digits comes out, and then every run of digits collapses to a single `#`
 * — `NUREMBERG 42` and `NUREMBERG 43` are one head, and the number they differ
 * by is the only thing that made them look like two.
 *
 * Accents go with the punctuation, which loses information and does not matter:
 * the key only ever has to match ITSELF, on the other pages of the same book,
 * and `PRÉFACE` reduces to `PRFACE` on every one of them.
 */
export function furnitureKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+/g, '#');
}

/**
 * The band a running head lives in, as a fraction of the page.
 *
 * Measured on Nuremberg, 568 pages: all 22 running heads the model mistagged
 * sit between 6.0% and 7.2% down their page, and the lowest of the book's real
 * openers — `CHAPTER III` on page 306 and `SOURCE NOTES` on page 501 — is at
 * 17.6%. There is nothing at all in between, which is why one number can carry
 * the whole distinction and why it is put at 15%, in the middle of the gap
 * rather than against either side of it.
 */
const FURNITURE_BAND = 0.15;

/**
 * How many pages must carry a text before it is furniture rather than prose.
 *
 * A chapter opens once. A running head is on every page of its section, so the
 * evidence for one is REPETITION, and three pages is enough of it that no
 * heading in a book can produce it by accident.
 *
 * The count includes the mistagged copies, and it has to. Nuremberg's
 * introduction head is tagged Page-header on two pages and mistagged on two
 * more; counting only what the model got right leaves it one page short of the
 * threshold, and both mistakes survive as chapter splits — which is the exact
 * failure this pass exists for. So a page counts when the text is in the
 * furniture band, and at least one of those pages must have been tagged
 * furniture outright, which is what keeps the rule anchored to the model's own
 * answer rather than to a shape.
 */
const FURNITURE_PAGES = 3;

/**
 * A mistagged running head is short. 80 characters is `proposeChapters`'s own
 * ceiling for a heading, and the same number here for the same reason.
 */
const FURNITURE_CHARS = 80;

/**
 * How much bigger than the body's line height a block may be and still be
 * furniture.
 *
 * A running head is set at body size or under it — it is the printer's mark on
 * a page of the book, not an announcement — and NO BOOK SETS A CHAPTER OPENER
 * AT BODY SIZE. That asymmetry is the whole of the size gate below: it cannot
 * tell a head from an opener by the words (they are frequently the same words,
 * which is the defect this pass exists for) and it cannot tell them apart by
 * the model's answer either when the model got every copy wrong. It can tell
 * them apart by how big they are printed.
 *
 * 1.25 rather than 1.0 because the measurement is `lineHeight`, which quantises
 * — see `typography.ts`, where a one-line block's estimate can land anywhere
 * from 20 to 60 px around a 40 px line. A head is one line, so it is exactly
 * the case that wobbles most; the allowance is set above the wobble and far
 * below display type, which in these books runs 2× the body and up.
 */
const FURNITURE_BODY_SIZE = 1.25;

/** Which evidence took a block out of the book — see `suppressRunningHeads`. */
export type FurnitureEvidence = 'tagged' | 'body-sized';

/**
 * A block this pass deleted, and the evidence that deleted it.
 *
 * The block itself, so that everything that identified it — the page, the box,
 * the category the model gave it — is still readable; `why` on top, because two
 * different arguments can now condemn a block and a report that does not say
 * which one fired cannot be checked.
 */
export interface SuppressedHead extends DotsBlock {
  why: FurnitureEvidence;
}

/** The categories a mistagged running head arrives as. */
const MISTAGGED: ReadonlySet<DotsCategory> =
  new Set<DotsCategory>(['Title', 'Section-header', 'Text']);

/**
 * The categories the SIZE path may delete, and it is narrower than `MISTAGGED`
 * on purpose.
 *
 * The size path acts without the model's own word for it (see
 * `suppressRunningHeads`), so it is allowed to act only where NOT acting does
 * structural damage. A head mistagged as a Title or a Section-header becomes a
 * heading: a chapter split, a document of its own, a line in the nav, and a
 * sentence cut in half at the place it split. A head the model called Text
 * becomes a stray line in the middle of the prose — visible to any reader,
 * ugly, and a claim about nothing. The attested path deletes both because the
 * model itself identified the words as furniture somewhere; the size path is an
 * inference off the book's shape, and an inference gets the case where being
 * wrong is cheap and being right matters.
 */
const UNATTESTED_MISTAGGED: ReadonlySet<DotsCategory> =
  new Set<DotsCategory>(['Title', 'Section-header']);

/**
 * Take the book's running heads out of the book, including the ones the model
 * did not label.
 *
 * `parseDotsPage` removes what was TAGGED Page-header or Page-footer, and on
 * Nuremberg that is 168 pages of `NUREMBERG` and 5 of `INDEX`. The same heads
 * arrive as a Title on 3 more pages and as a Section-header on 16, and every
 * one of those became a chapter that cut a sentence in half — 17 documents in
 * the converted EPUB were titled "INDEX".
 *
 * TWO facts must hold, never one, and page 306 of that book is why. `THE
 * DEFENSE` is the running head of 55 pages AND the name of the book's third
 * part; the divider is the one page where those words are the reader's. What
 * separates them is nothing about the words at all — it is that the head sits
 * at 7% down the page and the divider's title at 26%. Attestation alone would
 * delete the part divider; the band alone would delete a chapter that happens
 * to open high on its page. On the real book this pass removes 22 blocks and
 * leaves every one of the nine real openers, including the `INDEX` title on
 * page 539 that the seventeen `INDEX` heads after it were being confused with.
 *
 * A key of nothing but digits is never attested: that is a bare folio, and a
 * bare number the model called a Section-header is a section mark rather than a
 * page number — `proposeChapters` stops it proposing a chapter, and it stays in
 * the book where the printer put it.
 *
 * THERE IS A SECOND EVIDENCE PATH, AND THE HOLE IT CLOSES IS THE WORST CASE OF
 * THE FIRST. Attestation anchors the rule to the model's own answer, which is
 * the right anchor whenever the model got the head right ANYWHERE — Nuremberg's
 * INDEX head is tagged on 5 pages, and those 5 kill the 16 mistags. But a head
 * the model mistags on EVERY page of the book is never attested by anything,
 * and under the attested rule alone every single copy of it survives as a
 * chapter that cuts a sentence in half. That is not a hypothetical: it is what
 * the front matter of the books in this library keeps arriving as.
 *
 * So a key that was NEVER tagged, anywhere, in either position, is still
 * furniture when four independent things hold at once:
 *
 *  - the block is a Title or a Section-header (`UNATTESTED_MISTAGGED`), which
 *    is where the damage of leaving it is a bogus chapter rather than a stray
 *    line;
 *  - it RECURS in the band on `FURNITURE_PAGES` pages, which is the same
 *    repetition the attested path already requires and which no chapter opener
 *    in a book produces;
 *  - it contains a LETTER, the same guard as the attested path — a bare folio
 *    stays exactly as the doc comment above says it stays;
 *  - EVERY banded copy of it is set at BODY SIZE (`FURNITURE_BODY_SIZE`). This
 *    is the condition doing the real work, and it is what makes the whole path
 *    safe. Nothing that a reader is supposed to read as an opening is printed
 *    the size of the prose under it; a page-306-style divider whose words also
 *    head 55 pages is set in display type, and one copy of it measuring big is
 *    enough to disqualify the key everywhere. The band already keeps that
 *    particular divider out — it sits at 26% and the band ends at 15% — and the
 *    size gate is the second, independent reason it survives.
 *
 * One tagged copy anywhere still beats all of it: a key the model called
 * furniture on some page takes the attested path and is never asked about its
 * size, because the model's own word is the better evidence and always was.
 *
 * Mutates the pages, which is how `buildDotsBook`'s dehyphenation pass already
 * works, and returns what it took — with the path that took it — so the run can
 * say so. A book that silently lost seventeen blocks is a book nobody can check.
 */
export function suppressRunningHeads(pages: readonly DotsParsedPage[]): SuppressedHead[] {
  const taggedHead = new Set<string>();
  const taggedFoot = new Set<string>();
  const headerPages = new Map<string, Set<number>>();
  const footerPages = new Map<string, Set<number>>();
  /** Keys with at least one banded copy bigger than the body. Never body-sized. */
  const oversized = new Set<string>();

  /*
   * The body's line height, taken off the pages this pass was already handed.
   *
   * Measured HERE and not passed in, because this pass runs first in
   * `buildDotsBook` — before the lexicon, before dehyphenation, before the
   * reflow — which is the only moment in the run when every block still carries
   * the newlines `typeSize` counts its lines from. A number computed later
   * would be several times too large on every reflowed paragraph in the book.
   * Null for a book with no Text block in it, and a null body size simply
   * closes this path: no baseline, no size argument, no deletion.
   */
  const bodyPx = bodyTypeSize(pages.flatMap((p) => p.blocks));

  const note = (where: Map<string, Set<number>>, key: string, page: number): void => {
    const seen = where.get(key);
    if (seen === undefined) where.set(key, new Set([page]));
    else seen.add(page);
  };

  for (const page of pages) {
    for (const block of page.furniture) {
      const key = furnitureKey(block.text);
      if (key.length === 0) continue;
      const foot = block.category === 'Page-footer';
      (foot ? taggedFoot : taggedHead).add(key);
      note(foot ? footerPages : headerPages, key, block.page);
    }
    // The mistagged copies count towards the same evidence, so they are read in
    // the same sweep — a block in the band whose text a header elsewhere in the
    // book also carries is a page of that head, whatever the model called it.
    for (const block of page.blocks) {
      if (!MISTAGGED.has(block.category) || block.text.length >= FURNITURE_CHARS) continue;
      const key = furnitureKey(block.text);
      if (key.length === 0) continue;
      const head = topFraction(block) <= FURNITURE_BAND;
      const foot = bottomFraction(block) >= 1 - FURNITURE_BAND;
      if (head) note(headerPages, key, block.page);
      if (foot) note(footerPages, key, block.page);
      /*
       * One copy printed bigger than the body is enough to say the words are an
       * announcement somewhere in this book, and a key that announces anything
       * is not deleted anywhere on the strength of its size.
       *
       * `typeSize`, NOT `lineHeight`, and `typography.ts` has the arithmetic:
       * `lineHeight` maximises over a one-line-per-40-pixels estimate and so
       * reports a 120 px chapter title as three 40 px body lines — it flattens
       * the exact distinction this gate is made of. Every block that reaches
       * here is under `FURNITURE_CHARS` characters and was therefore never
       * reflowed out of anything, so its box over its own line breaks IS how
       * big the page printed it.
       */
      if (
        (head || foot) && bodyPx !== null
        && typeSize(block) > bodyPx * FURNITURE_BODY_SIZE
      ) {
        oversized.add(key);
      }
    }
  }

  /**
   * What condemns this key in this position, or nothing.
   *
   * The two paths in the order of how good the evidence is: the model's own
   * word first, and the book's own printing only where the model never said a
   * word at all. `null` is the ordinary answer and the only one a real chapter
   * opener ever gets.
   */
  const evidence = (
    tagged: ReadonlySet<string>,
    where: Map<string, Set<number>>,
    key: string,
    category: DotsCategory,
  ): FurnitureEvidence | null => {
    if (!/[A-Z]/.test(key)) return null;
    if ((where.get(key)?.size ?? 0) < FURNITURE_PAGES) return null;
    if (tagged.has(key)) return 'tagged';
    // Tagged in the OTHER position and not this one: the model has spoken about
    // these words, and it did not say this. The size argument is for keys the
    // model never labelled at all.
    if (taggedHead.has(key) || taggedFoot.has(key)) return null;
    if (!UNATTESTED_MISTAGGED.has(category)) return null;
    if (bodyPx === null || oversized.has(key)) return null;
    return 'body-sized';
  };

  const removed: SuppressedHead[] = [];
  for (const page of pages) {
    const kept = page.blocks.filter((block) => {
      if (!MISTAGGED.has(block.category) || block.text.length >= FURNITURE_CHARS) return true;
      const key = furnitureKey(block.text);
      if (key.length === 0) return true;
      const why = (topFraction(block) <= FURNITURE_BAND
        ? evidence(taggedHead, headerPages, key, block.category)
        : null)
        ?? (bottomFraction(block) >= 1 - FURNITURE_BAND
          ? evidence(taggedFoot, footerPages, key, block.category)
          : null);
      if (why === null) return true;
      removed.push({ ...block, why });
      return false;
    });
    page.blocks.length = 0;
    page.blocks.push(...kept);
  }
  return removed;
}

// ── chapter proposals ───────────────────────────────────────────────────────

const CHAPTERISH = new RegExp(
  '^(chapter|part|book|prologue|epilogue|introduction|preface|foreword|'
  + 'acknowledg|conclusion|afterword|appendix|notes|bibliography|index)\\b'
  + '|^[IVXLC]+\\.?$|^\\d{1,2}\\.?$',
  'i',
);

/** `16`, `16.` — a heading that is nothing but an arabic number. */
const BARE_NUMBER = /^(\d{1,3})\.?$/;

/**
 * Does this book number its CHAPTERS in arabic, or its sections?
 *
 * `CHAPTERISH` accepts a bare number, and it has to: a novel whose chapters are
 * called `1`, `2`, `3` gets its splits from nothing else. But a bare number is
 * also how a work of history marks the mini-sections inside a chapter, and
 * Nuremberg has about 150 of them — an arbitrary subset of which became
 * chapters called "22", "23", "26".
 *
 * The two are told apart by the SEQUENCE, which is a fact about the whole book
 * and invisible from any one page. Chapter numbers run 1, 2, 3 … to the end and
 * never go back; section numbers RESTART, once per chapter or once per part —
 * Nuremberg has four parts and numbers each one from 1, so `2` is a heading on
 * three separate pages and `3` on four. So: two or more bare numbers that do
 * not strictly increase across the book are section marks, and none of them
 * proposes a chapter. They still render exactly where the printer put them.
 *
 * One bare number in a book is not evidence of either, and is left alone.
 */
export function bareNumbersAreSectionMarks(blocks: readonly DotsBlock[]): boolean {
  const numbers: number[] = [];
  for (const block of blocks) {
    if (block.category !== 'Title' && block.category !== 'Section-header') continue;
    const match = BARE_NUMBER.exec(block.text.trim());
    if (match !== null) numbers.push(Number(match[1]));
  }
  if (numbers.length < 2) return false;
  return numbers.some((value, i) => i > 0 && value <= numbers[i - 1]);
}

export interface DotsChapterProposal {
  /** Index into the book's flat block list — where the section would open. */
  index: number;
  page: number;
  text: string;
  /** Every rule that fired, so the list can be read rather than trusted. */
  why: string[];
  /**
   * What the opening page IS, when it said so loudly (`classifyPage`).
   *
   * `chapter` is this file's own proposal rule; the other four come from the
   * page classifier. Null is the ordinary answer for a page that opens a
   * section without announcing what sort of section it is.
   */
  kind: DotsPageKind | null;
  /**
   * The TOC label the classifier justified, when the section's first heading is
   * not the whole of it. Only a part sets one — see `DotsPageVerdict.label`.
   */
  label: string | null;
}

/**
 * Where a chapter might open, and why.
 *
 * Deliberately generous. See this file's header: the list is curated by a
 * person, so a false positive costs a click and a false negative costs a
 * chapter nobody can get back.
 *
 * `spokenFor` is the pages the classifier has already named. A title page is a
 * page of centered display type and would be proposed as a chapter by every
 * rule below; it is not one, and the page has already said so.
 */
export function proposeChapters(
  blocks: readonly DotsBlock[],
  spokenFor: ReadonlySet<number> = new Set(),
): DotsChapterProposal[] {
  const firstIndexOnPage = new Map<number, number>();
  for (const [index, block] of blocks.entries()) {
    if (!firstIndexOnPage.has(block.page)) firstIndexOnPage.set(block.page, index);
  }

  // Asked once, of the whole book, before a single page is looked at — the
  // answer is a fact about the book's numbering and cannot be read off a page.
  const sectionMarks = bareNumbersAreSectionMarks(blocks);

  const proposals: DotsChapterProposal[] = [];
  const claimed = new Set<number>(spokenFor);
  for (const [index, block] of blocks.entries()) {
    if (block.category !== 'Title' && block.category !== 'Section-header') continue;
    if (claimed.has(block.page)) continue;
    if (firstIndexOnPage.get(block.page) !== index) continue;
    if (topFraction(block) > 0.45) continue;
    if (block.text.length >= 80) continue;
    if (sectionMarks && BARE_NUMBER.test(block.text.trim())) continue;

    const why: string[] = [];
    if (CHAPTERISH.test(block.text)) why.push('chapterish-text');
    if (block.category === 'Title') why.push('title-class');
    if (centerOffset(block) < 0.06) why.push('centered');
    if (why.length === 0) continue;

    claimed.add(block.page);
    proposals.push({ index, page: block.page, text: block.text, why, kind: 'chapter', label: null });
  }
  return proposals;
}

/**
 * Every place the book starts a new document, in order: the pages that said
 * what they are, and the chapters proposed among the rest.
 *
 * The classifier is asked FIRST and its answers are binding, because the four
 * kinds it knows are all things the chapter rule would otherwise propose as
 * chapters — a half-title, a contents page and a part divider are each a short
 * centered heading first on its page. A page that is a title page is not also a
 * chapter.
 */
export function proposeSections(
  pages: readonly DotsParsedPage[],
  overlay: Overlay = emptyOverlay(),
): DotsChapterProposal[] {
  /*
   * A LAID-OUT SPINE SUPERSEDES EVERY RULE BELOW, and it does so by returning
   * before any of them runs.
   *
   * Not by overruling them one at a time: the classifier does not name a page, no
   * heading is promoted, no running head is demoted and no section is closed
   * because another one had to end. That is what "definitive" has to mean for the
   * finished book to be predictable — a spine assembled out of detection PLUS
   * corrections is a spine whose contents shifts when the detection improves, and
   * the person who laid it out would have no way to know why. Removing an entry
   * from the list is the demotion; adding one is the promotion; there is nothing
   * else to reconcile.
   *
   * `kind` is null on every one of them, and `why` says `listed`. A kind is what
   * the CLASSIFIER concluded a page was, and nothing classified anything here —
   * the block a chapter starts at renders as an ordinary block at the top of its
   * section, which is the other half of the same decision: what a book prints and
   * what its contents calls a chapter are two facts, and the list supplies the
   * second without touching the first.
   */
  if (overlay.chapters !== undefined) {
    const flat = pages.flatMap((p) => p.blocks);
    return chapterStarts(overlay.chapters, flat).map(({ index, title }) => ({
      index,
      page: flat[index].page,
      text: flat[index].text,
      why: ['listed'],
      kind: null,
      label: title,
    }));
  }
  // Does anything follow? Computed backwards once, because a part opens
  // something and the last divider-shaped page in a book is a colophon.
  const bodyAfter = new Array<boolean>(pages.length).fill(false);
  for (let i = pages.length - 2; i >= 0; i -= 1) {
    bodyAfter[i] = bodyAfter[i + 1] || carriesBodyProse(pages[i + 1].blocks);
  }

  // Where each page's blocks begin in the flat list, and where the book ends.
  const pageStart = new Array<number>(pages.length + 1).fill(0);
  for (const [position, page] of pages.entries()) {
    pageStart[position + 1] = pageStart[position] + page.blocks.length;
  }

  const named: DotsChapterProposal[] = [];
  const closes: { index: number; page: number }[] = [];
  const spokenFor = new Set<number>();
  for (const [position, page] of pages.entries()) {
    const verdict = classifyPage(page.blocks, { index: position, bodyFollows: bodyAfter[position] });
    if (verdict === null) continue;
    spokenFor.add(page.page);
    named.push({
      index: pageStart[position],
      page: page.page,
      text: page.blocks[0].text,
      why: verdict.why,
      kind: verdict.kind,
      label: verdict.label,
    });
    /*
     * WHERE A NAMED SECTION ENDS, and this is the difference between a label
     * and a lie.
     *
     * The kind belongs to ONE page. Everything after it, up to the next section
     * start, would otherwise be inside the section the picker was told is a
     * part divider — and For the Soul of the People proves the cost: the
     * chapter after part IV opens with a Quote block rather than a heading, so
     * no chapter is proposed there, and the whole of it sat inside the part.
     * "Delete the part divider" would have deleted a chapter.
     *
     * So a named section closes at the first page after it that carries
     * ANYTHING: body prose, or a heading. What it keeps is the blank leaf and
     * the dedication — pages with neither — because those are the same piece of
     * front matter as the page that named itself, and splitting them off would
     * put "Chapter 4: BLANK PAGE" in the nav of every book with a title page.
     */
    for (let after = position + 1; after < pages.length; after += 1) {
      const next = pages[after];
      const substantial = carriesBodyProse(next.blocks)
        || next.blocks.some((b) => b.category === 'Title' || b.category === 'Section-header');
      if (!substantial) continue;
      closes.push({ index: pageStart[after], page: next.page });
      break;
    }
  }

  const flat = pages.flatMap((p) => p.blocks);
  const chapters = proposeChapters(flat, spokenFor);
  const starts = new Map<number, DotsChapterProposal>();
  for (const close of closes) {
    // An unnamed section, opened only because the named one had to end. It
    // takes its label from its own first heading, like any other section does.
    starts.set(close.index, { ...close, text: '', why: [], kind: null, label: null });
  }
  // A real proposal at the same index wins: it knows what it is.
  for (const proposal of [...chapters, ...named]) starts.set(proposal.index, proposal);

  return [...starts.values()].sort((a, b) => a.index - b.index);
}

// ── the section the book opened twice ───────────────────────────────────────

/** A section proposal that was folded into the one above it, and what it said. */
export interface DotsFold {
  page: number;
  text: string;
}

/**
 * What a section will be CALLED, worked out before it is rendered.
 *
 * The same order `buildDotsBook` uses for the finished label, and it has to be:
 * the fold below is about two entries in the nav that read the same, so it must
 * compare the strings the nav is actually going to carry. The classifier's
 * composed label first — a part's number and its name are two blocks and only
 * the classifier knows they belong together — and otherwise the section's own
 * first display heading, which is where `buildChapterBody`'s `label` comes from.
 *
 * A section with neither gets an empty string, and an empty string never folds
 * anything. A copyright page has no heading on it, and two consecutive sections
 * that are both nameless are two sections this rule knows nothing about.
 *
 * Takes a category and a text and nothing else, because both of its callers
 * hold a different kind of block: the fold works over the banked blocks, where
 * a section's index is settled, and `detectChapters` over the flowing ones. A
 * heading is never joined onto anything, so the two spans answer this question
 * identically — which is the point rather than a coincidence.
 */
function sectionName(
  span: readonly { category: DotsCategory; text: string }[],
  opens: DotsChapterProposal | null,
): string {
  const label = opens?.label;
  if (label !== null && label !== undefined && label.length > 0) return label;
  const heading = span.find((b) => b.category === 'Title' || b.category === 'Section-header');
  // Through `headingLabel` for the reason in this comment's first paragraph: a
  // heading printed on two lines reaches the nav as one line, so that is the
  // string this comparison has to be about. It changes no verdict — the keys
  // are `furnitureKey`'d, and the separator is punctuation, which that strips —
  // and it makes the text a fold REPORTS read the way the nav entry read.
  return heading === undefined ? '' : headingLabel(heading.text);
}

/**
 * Fold a section back into the one above it when the book printed its opening
 * twice.
 *
 * MEASURED ON A REAL CONVERSION. Michelle Remembers (Congdon & Lattès, 1980),
 * converted by this pipeline, opens its nav with THREE documents called
 * "Michelle Remembers" — the cover on page 1, the half-title on page 7 and the
 * title page on page 9, each of which sets the book's title in display type and
 * each of which therefore proposes a section. It then has a "contents" on page
 * 13 and a "Contents" on page 14, because the contents run over the leaf and
 * the printer reset the heading. Then a "PART I" on page 27 and another "PART
 * I" on page 28, because the divider is printed on both sides of its leaf and
 * `classifyPage` correctly calls both of them parts. Nine documents into the
 * book, six of them are the same three things said twice or three times.
 *
 * Every one of those pairs has the same shape and it is a shape a book cannot
 * make by accident: the second section OPENS WITH THE SAME WORDS as the first
 * (`furnitureKey`, so letter-spacing, decoration and a folio do not make two
 * out of one) AND CARRIES NO PROSE OF ITS OWN. The second condition is the one
 * that makes this safe, and it is refused rather than weakened:
 *
 *   A LATER SECTION THAT CARRIES BODY PROSE IS NEVER FOLDED, whatever it is
 *   called. A diary that heads two chapters "1943" has two chapters, and a
 *   reference work with two sections called "Notes" has two. Both of them carry
 *   prose, so neither is touched. The asymmetry is the same one `proposeChapters`
 *   is built on: a split that was wrongly removed is uncorrectable from the
 *   finished book, and a section that stayed merged costs a reader one scroll.
 *
 * Iterates rather than sweeping once, so a title printed three times folds to
 * one: after each fold the survivor is compared against the NEXT section, and
 * because the survivor's name is still its own first heading, the run collapses
 * from the top. The survivor keeps the first section's proposal — its label, its
 * kind and its `data-bf-kind` wrapper — which is why a doubled part divider ends
 * as one part rather than as a part with a stray divider inside it.
 *
 * Mutates `starts` and `opens`, the way the rest of this file's passes mutate,
 * and returns what it folded so the run can name it.
 */
export function foldDuplicateSections(
  blocks: readonly DotsBlock[],
  starts: number[],
  opens: (DotsChapterProposal | null)[],
): DotsFold[] {
  const folded: DotsFold[] = [];
  for (let i = 1; i < starts.length;) {
    const earlier = blocks.slice(starts[i - 1], starts[i]);
    const later = blocks.slice(starts[i], starts[i + 1] ?? blocks.length);
    const key = furnitureKey(sectionName(earlier, opens[i - 1]));
    const name = sectionName(later, opens[i]);
    if (
      later.length === 0
      || key.length === 0
      || furnitureKey(name) !== key
      || carriesBodyProse(later)
    ) {
      i += 1;
      continue;
    }
    folded.push({ page: later[0].page, text: name });
    starts.splice(i, 1);
    opens.splice(i, 1);
    // `i` does not move: the section that was after the folded one is now at
    // `i`, and it is compared against the span it just grew into. That is what
    // turns three copies of a title into one document rather than two.
  }
  return folded;
}

// ── the heading the page printed on two lines ───────────────────────────────

/**
 * Two heading blocks that were one heading, joined back into one.
 *
 * Reported for the same reason a fold is: this pass WRITES A HEADING, and the
 * words it writes are a sentence the printer never set on one line. If it is
 * wrong it is wrong in `generated/`, which every later pass treats as truth, so
 * every merge is named with its page and both of its halves and select mode can
 * take it apart by hand.
 */
export interface DotsHeadingMerge {
  page: number;
  /** The printed lines, in order — what the page shows and what `<br/>` keeps. */
  lines: string[];
  /** The one line the contents gets, separator and all — see `headingLabel`. */
  label: string;
}

/**
 * How much of the narrower box has to sit inside the wider one.
 *
 * Two lines of one heading share a COLUMN — a centered numeral over a centered
 * title, a flush-left number over a flush-left name — so the narrow one is
 * mostly or entirely inside the wide one's span. What this number is really
 * refusing is the side-by-side pair: a heading in the left column of a two-up
 * page and a heading in the right one are adjacent in reading order, sit at the
 * same height, and are two headings of two different things. Half of the
 * narrower box is well past any overlap two columns can produce (they do not
 * overlap at all) and well under what one heading's two lines produce.
 */
const MERGE_OVERLAP = 0.5;

/**
 * How far apart, in line heights, two lines of one heading can be.
 *
 * The gap measured is white space — the bottom edge of one box to the top edge
 * of the next — so consecutive lines of one heading measure near zero, and
 * often below it, because the model draws boxes that touch or overlap slightly.
 * A line and a half of clear air is more space than any leading puts between
 * two lines of the same heading and less than a printer puts between a heading
 * and the next thing that is not part of it.
 *
 * `typeSize` and not `lineHeight`, for `typography.ts`'s reason: `lineHeight`
 * maximises over a one-line-per-40-pixels estimate and reports a 120 px display
 * line as three body lines, which would shrink this window to a third of the
 * type it is supposed to be measured in. Against the LARGER of the two lines,
 * because the leading between a small numeral and a big title is set by the
 * title — measuring against the numeral would refuse precisely the case this
 * whole pass exists for.
 */
const MERGE_GAP_LINES = 1.5;

/**
 * How short one side has to be, in words.
 *
 * THE ONE GUARD THAT IS ABOUT MEANING RATHER THAN ABOUT INK, and the reason it
 * is needed is that the two before it cannot tell a heading from a heading. A
 * heading printed across two lines is a LABEL and a NAME — `II`, `CHAPTER IV`,
 * `PART ONE` over what the chapter is called — and the label is never a
 * statement on its own. Four words is the widest that stays true of: `The Price
 * of Judgment` is a name at four, and nothing that needs five words to say
 * itself is a label for the line under it.
 *
 * WHAT IT DOES NOT DO, said plainly because the plan's own counter-example
 * invites the misreading: this does not refuse `Section One` over `A
 * Reconsideration of the Evidence`. `Section One` is two words, so the pair has
 * a short side like any other. What refuses that pair is the two guards ABOVE —
 * two headings that are two headings have the page's own space between them, or
 * prose, and prose ends the run outright. Where a book really does print those
 * two lines in one column a line apart, they are one heading and joining them
 * is right. What this guard refuses on its own is the pair where BOTH sides are
 * a whole statement, and that pair is two headings whatever its boxes say.
 */
const MERGE_SHORT_WORDS = 4;

/** A heading is a Title or a Section-header. Nothing else may ever merge. */
function isHeadingBlock(block: DotsBlock): boolean {
  return block.category === 'Title' || block.category === 'Section-header';
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * May `next` be the next printed line of `head`? All three guards, in order.
 *
 * Exported because it is the whole of the risk and it is pure arithmetic: every
 * false merge this feature can commit is a `true` from here.
 */
export function joinsHeading(head: DotsBlock, next: DotsBlock): boolean {
  // One page. A heading cannot be printed across a page turn, and two headings
  // on two pages are two headings however alike their boxes look — the boxes
  // are in each page's own pixels and comparing them across pages is comparing
  // nothing.
  if (next.page !== head.page) return false;

  const overlap = Math.min(head.box.x2, next.box.x2) - Math.max(head.box.x1, next.box.x1);
  const narrower = Math.min(head.box.x2 - head.box.x1, next.box.x2 - next.box.x1);
  if (narrower <= 0 || overlap < MERGE_OVERLAP * narrower) return false;

  // Below, and close. Below first: reading order puts the second block after
  // the first, and on a page of columns "after" can mean to the RIGHT and
  // higher up, where the gap arithmetic below would be a subtraction of two
  // unrelated edges and would happily come out negative.
  if (next.box.y1 < head.box.y1) return false;
  const line = Math.max(typeSize(head), typeSize(next));
  if (next.box.y1 - head.box.y2 > MERGE_GAP_LINES * line) return false;

  return wordCount(head.text) <= MERGE_SHORT_WORDS || wordCount(next.text) <= MERGE_SHORT_WORDS;
}

/**
 * The one line a heading gives the CONTENTS, from the lines the page printed.
 *
 * THE SEPARATOR IS AN INVENTION AND IT LIVES ONLY HERE. `II` and `The Price of
 * Judgment` were two lines of display type with white space between them, and
 * the book never printed a colon; the page keeps the break (`<br/>`) and this
 * is the only place a character the printer did not set is added. It is added
 * because a nav entry is one line by construction — there is nowhere in a TOC
 * for a line break to go — and `IIThe Price of Judgment` is worse than a colon,
 * and `II` alone is worse still, because it names the chapter by its number and
 * throws away what it is called. NOTHING MAY CARRY THIS INTO THE PAGE.
 *
 * A space rather than a colon when the line already ends in punctuation: the
 * printer set `II.` or `II —` precisely so the next line could follow it, and
 * `II.: The Price of Judgment` is two separators for one join.
 */
const ALREADY_PUNCTUATED = /[.,:;!?…—–-]$/;

export function headingLabel(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return text.trim();
  return lines.reduce((joined, line) =>
    `${joined}${ALREADY_PUNCTUATED.test(joined) ? ' ' : ': '}${line}`);
}

/**
 * Join a heading the page printed on two lines back into one block.
 *
 * A chapter opening is routinely two boxes — the number on one line, the title
 * on the next — because that is what the page IS, and dots reports boxes. The
 * book means one heading, and everything downstream that is handed two of them
 * says so twice: two `<h1>`s, two anchors, two nav entries, and a contents that
 * reads `II` for a chapter that has a name.
 *
 * WHERE THIS RUNS IN `buildDotsBook` IS HALF OF WHAT IT DOES, and the position
 * is load-bearing rather than tidy. It runs after `suppressRunningHeads`, whose
 * deletions must not be merged into anything, and BEFORE the pages are
 * flattened — which puts it before `proposeChapters`, before the type is
 * measured and before a single character is rewritten. That ordering is what
 * makes every consequence follow by itself: the chapter proposal reads the
 * whole heading rather than a bare numeral (and so survives the `BARE_NUMBER`
 * refusal that a book of numbered sections applies), one `<h1>` is emitted, one
 * anchor exists, one nav entry is composed, and `typeSize` measures the merged
 * box over the newline that is now in it — two lines, at their real size,
 * instead of one line at twice it. Merging AFTER any of those would mean fixing
 * each of them separately and getting the arithmetic of the last one wrong.
 *
 * THREE LINES MAY CHAIN — a number, a title and a subtitle is an ordinary
 * opening, and refusing the third would leave the split this pass exists to
 * remove. It is safe because chaining is not a weaker test: every incoming
 * block is judged against the MERGED BLOCK, whose box is the union so far and
 * whose text is every line so far. So the vertical gap is measured from the
 * bottom of the last line actually taken, and the word count of the accumulated
 * side is the count of everything in it — which after two lines is normally
 * past `MERGE_SHORT_WORDS`, so a third line has to be short in its OWN right.
 *
 * Mutates the pages, the way `suppressRunningHeads` and the dehyphenation pass
 * above already do, and keeps the FIRST block's object — its page and its order
 * are the heading's, and its identity is what `measureTypeSizes` keys on.
 * Returns what it joined so the run can name it.
 */
export function mergeAdjacentHeadings(pages: readonly DotsParsedPage[]): DotsHeadingMerge[] {
  const merges: DotsHeadingMerge[] = [];
  /** The heading `kept` ended on, when it is one and can still take a line. */
  type OpenHeading = { block: DotsBlock; lines: string[] };
  // Taken as an argument rather than closed over, so that one block that
  // happened to be a heading and took no second line reports nothing.
  const record = (open: OpenHeading | null): void => {
    if (open === null || open.lines.length < 2) return;
    merges.push({ page: open.block.page, lines: open.lines, label: headingLabel(open.block.text) });
  };

  for (const page of pages) {
    const kept: DotsBlock[] = [];
    let open: OpenHeading | null = null;
    for (const block of page.blocks) {
      if (open !== null && isHeadingBlock(block) && joinsHeading(open.block, block)) {
        const head = open.block;
        // The newline is the whole point. It is what `dotsInline` turns into
        // the `<br/>` the page shows, and what `typeSize` counts the merged
        // box's lines from — take it out and a two-line heading measures as one
        // line of twice the type, which is a claim about the printer.
        head.text = `${head.text.trimEnd()}\n${block.text.trimStart()}`;
        head.box = {
          x1: Math.min(head.box.x1, block.box.x1),
          y1: Math.min(head.box.y1, block.box.y1),
          x2: Math.max(head.box.x2, block.box.x2),
          y2: Math.max(head.box.y2, block.box.y2),
        };
        // The more significant of the two. A Title that absorbs a Section-header
        // is still the book's loudest heading — the printer set the announcement
        // big and the name of it smaller, and the announcement is the heading.
        if (block.category === 'Title') head.category = 'Title';
        open.lines.push(block.text.trim());
        continue;
      }
      record(open);
      open = null;
      kept.push(block);
      if (isHeadingBlock(block)) open = { block, lines: [block.text.trim()] };
    }
    record(open);
    page.blocks = kept;
  }
  return merges;
}

// ── the nav ─────────────────────────────────────────────────────────────────

/**
 * A section whose name says it is not part of the book's argument.
 *
 * NOT A KIND, and deliberately not one: nothing is stamped with it and nothing
 * downstream can select on it. It decides one thing only — whether an open part
 * stays open — and it exists because the alternative is worse. Everything after
 * a part divider nests under it until the next one, so with no rule at all the
 * Index of a book with four parts is a child of Part IV, which is a claim about
 * the book that is simply false. The failure this rule can produce instead is a
 * chapter genuinely called "Notes" sitting at the top level of the nav, beside
 * the parts rather than inside one — visible, and true about nothing.
 */
const BACK_MATTER = /^(notes|bibliograph|sources|index|appendi|glossar|about the author|further reading)\b/i;

/**
 * Chapters nest under the part they follow; everything else is top level.
 *
 * A chapter's own section headers nest under IT — `href#anchor` entries into
 * the same document, which is the shape a publisher's contents page has for
 * "Chapter 3 … The Röhm purge … The oath". A part contributes no headings of
 * its own: whatever headings its divider span carries are display, not
 * sections.
 */
export function navTree(chapters: readonly VlmChapter[]): VlmNavItem[] {
  const root: VlmNavItem[] = [];
  let open: { href: string; label: string; children: VlmNavItem[] } | null = null;
  for (const chapter of chapters) {
    const sections = (chapter.kind === 'part' ? [] : chapter.headings ?? []).map((h) => ({
      href: `${chapter.href}#${h.id}`,
      label: h.label,
    }));
    const item: VlmNavItem = {
      href: chapter.href,
      label: chapter.label,
      ...(sections.length > 0 ? { children: sections } : {}),
    };
    if (chapter.kind === 'part') {
      open = { href: chapter.href, label: chapter.label, children: [] };
      root.push(open);
      continue;
    }
    if (open !== null && !BACK_MATTER.test(chapter.label)) {
      open.children.push(item);
      continue;
    }
    open = null;
    root.push(item);
  }
  return root;
}

// ── the page turn ───────────────────────────────────────────────────────────

/**
 * Are these two blocks close enough to be halves of one paragraph?
 *
 * Same page, or the very next one. Anything else is a GAP — pages struck out
 * with `--skip-pages`, or pages the model could not read and that were left out
 * by number — and nothing may be joined across one. See this file's header: the
 * words answer "yes, continue" for a paragraph whose continuation is on a page
 * that is not in the book, and the sentence they would build never existed.
 *
 * Exported because the rule is worth asserting on its own; it is arithmetic,
 * and it decides whether a book contains a sentence nobody wrote.
 */
export function adjoins(previous: DotsBlock | null, next: DotsBlock): boolean {
  if (previous === null) return true;
  return next.page === previous.page || next.page === previous.page + 1;
}

/**
 * A page turn resolved: what comes off the end of the paragraph so far, and
 * what the next block puts back on.
 *
 * THE ONE RESOLUTION OF THE ONE HYPHEN, and the reason it hands back pieces
 * rather than a finished string is the whole shape of this phase. It used to be
 * done TWICE per join and in two different representations: `joinTexts` fused
 * the word in plain text so that the running paragraph stayed correct for the
 * next `continuesTextually` call, and `appendToParagraph` did the same
 * arithmetic over RENDERED MARKUP — re-opening a closed `</p>` with a regex,
 * counting characters back from the end of a string full of `<sup>` and
 * `<em>`, and splicing the pagebreak span into the seam of a word. Two
 * implementations of one decision, in two languages, that had to agree and had
 * nothing making them.
 *
 * Now the decision is taken here, once, over the model's own text, and both
 * readers take their answer from the same four fields: the flow block joins
 * them into its text and the emitter writes each piece out with the page marker
 * between them. The markup is a rendering of the answer instead of a second
 * place the answer is worked out.
 */
export interface ParagraphJoin {
  /** The paragraph so far, with the word the column broke taken off its end. */
  opening: string;
  /** A space between two whole words; nothing where a word was broken in half. */
  separator: string;
  /** The broken word, made whole by the book's own lexicon. Null when none was. */
  fused: string | null;
  /** What is left of the next block once its half of the word is off the front. */
  rest: string;
}

export function resolveJoin(
  previous: string,
  next: string,
  lexicon: BookLexicon,
): ParagraphJoin {
  const tail = trailingHyphenWord(previous);
  const head = leadingWord(next);
  if (tail === null || head === null) {
    return { opening: previous, separator: ' ', fused: null, rest: next };
  }
  const trimmed = previous.trimEnd();
  return {
    opening: trimmed.slice(0, trimmed.length - (tail.length + 1)),
    separator: '',
    fused: lexicon.join(tail, head),
    rest: next.slice(head.length),
  };
}

/** The joined paragraph, as one string. */
function joinedText(join: ParagraphJoin): string {
  return join.opening + join.separator + (join.fused ?? '') + join.rest;
}

// ── one chapter's XHTML ─────────────────────────────────────────────────────

const CATEGORY_ATTRIBUTE: Record<string, string> = {
  Caption: 'caption',
  Footnote: 'footnote',
  Formula: 'formula',
  'List-item': 'list-item',
  Picture: 'picture',
  Quote: 'quote',
  'Section-header': 'section-header',
  Table: 'table',
  Text: 'text',
  Title: 'title',
};

/**
 * The one `data-bf-cat` value that is not a dots category.
 *
 * It is BookForge's, not the model's: the picker's palette has a `chapter`
 * category called "Chapter Openings — the EPUB split points", and it is how a
 * person sees and moves where the book divides. dots has no such category —
 * the heading that opens a chapter is a Title or a Section-header like any
 * other, and which one it is says nothing about whether a chapter starts there.
 * That is `proposeChapters`'s answer, and this is where it is written down.
 */
const CHAPTER_ATTRIBUTE = 'chapter';

/**
 * `data-bf-id` — a name for one element that nothing later can shift.
 *
 * EVERY OTHER ID IN A CAST BOOK RENUMBERS. `sh1` is a chapter-local running
 * ordinal, `fn7` is book-wide, `c0003` is a chapter ordinal: remove one heading
 * and every later heading, note and chapter file in the book is renamed. That is
 * fine while nothing addresses them, and it is exactly wrong the moment a person
 * can say "cut this block" and expect the instruction to still mean the same
 * block after they cut another one.
 *
 * PER ELEMENT, NOT PER BLOCK, and that is the whole reason this is a counter
 * rather than something derived. A list block writes `<ul>` AND `<li>`, a quote
 * writes `<blockquote>` AND its `<p>`, and both elements are stamped — one id
 * per block would put the same id on two elements, which is invalid XHTML and
 * unaddressable besides. So the number counts elements written, and the
 * container and its child get their own.
 *
 * `p<page>-<n>`. The page is in it because it is intrinsic to the block and
 * makes an id readable in a log; the ordinal is within that page, so re-casting
 * the same PDF produces the same ids and a person's cuts survive a re-read.
 */
function stampId(page: number, n: number): string {
  return ` data-bf-id="p${page}-${n}"`;
}

/**
 * `data-bf-src` — WHICH BANKED BLOCKS THIS ELEMENT'S WORDS CAME FROM.
 *
 * ── What its absence cost, which was the whole of "apply changes" ────────────
 *
 * `data-bf-id` names an ELEMENT OF THE FILE and nothing else. `p47-3` is the
 * third element written for page 47, counted by the emitter as it wrote them, so
 * a list contributes two of them and a joined paragraph contributes one for two
 * banked blocks. Nothing outside this function has ever been able to work the
 * number out: it is a counter, and the counter lives here.
 *
 * Meanwhile every decision this program keeps is keyed `(page, order, part)` —
 * the model's own answer, which is what an overlay amends, what a chapter list
 * points at and what a transform record will be written against. So the app
 * could let a person strike a paragraph in the cast book, write the strike into
 * their chapter markup, and have NO WAY AT ALL to record it as a decision about
 * the block: the two names could not be brought together outside this file, and
 * the ledger never heard about a single thing done on the flowing page. The
 * curation and the book drifted apart, silently, and the only surface that could
 * write a decision was the scan.
 *
 * So the emitter writes the correspondence down. It is the one thing here that
 * knows both halves, it costs one attribute, and it is deterministic: same bank,
 * same book, same string.
 *
 * ── The grammar ─────────────────────────────────────────────────────────────
 *
 * `page:order`, or `page:order:part` where the answer element was cut into
 * several blocks, SPACE-SEPARATED when a flow block was joined out of more than
 * one of them (a paragraph broken over a page turn is one element of the file
 * and two answers of the model — both of them, in reading order). It is
 * `overlay.ts`'s target spelling exactly, because it IS a target: an app reading
 * it hands the pieces to `parseTargetKey` and writes amendments, and a spelling
 * of our own would be a translation table between two files that must agree.
 *
 * EVERY ELEMENT OF ONE BLOCK CARRIES THE SAME VALUE. A list writes `<ul>` and
 * `<li>`, a quote writes `<blockquote>` and its `<p>`, and each gets its own
 * `data-bf-id` because ids are unique — but they are one block of the book and
 * one decision is about all of them. A cut of either is a cut of the same
 * banked answer.
 *
 * THE PART IS OMITTED WHERE THE ELEMENT WAS NEVER SPLIT, and that is not
 * shorthand — it is the overlay's own default said out loud. `at` without a
 * `part` means the whole answer element, every piece of it, which is what the
 * block editor over the scan writes for the same block (`BlockElement.key` is
 * `page:order`, one outline per answer element). Writing `12:3:0` for an
 * unsplit block would be a second spelling of one decision in one file, and the
 * two would fold together correctly but read as two. Where `consumeMarkdown`
 * DID cut an answer up, the pieces are separate blocks with separate categories
 * in the book, so each names its own part — relabelling a heading that a split
 * made must not relabel the two paragraphs that came out of the same answer.
 */
function stampSrc(keys: string): string {
  return ` data-bf-src="${keys}"`;
}

/**
 * One banked block's name, as a decision would spell it.
 *
 * `split` is the set of answer elements the markdown pass cut up, book-wide —
 * see `DotsChapterOptions.split` for why it cannot be worked out from one
 * chapter's blocks.
 */
function sourceKey(
  page: number,
  order: number,
  part: number,
  split: ReadonlySet<string>,
): string {
  const element = `${page}:${order}`;
  return split.has(element) ? `${element}:${part}` : element;
}

/**
 * Which answer elements arrived as more than one block — the book's own record
 * of where `consumeMarkdown` cut.
 *
 * BOOK-WIDE AND NOT PER CHAPTER, because a split's pieces can land in two
 * sections: a `# Heading` cut out of a Text answer is exactly the kind of thing
 * `proposeChapters` opens a chapter at, and then part 0 is the last block of one
 * file and part 1 the first block of the next. A chapter that counted its own
 * blocks would see one piece, call the element unsplit, and write a name that
 * means "every part of it" over a decision about one of them.
 */
export function splitElements(blocks: readonly DotsBlock[]): Set<string> {
  const seen = new Set<string>();
  const split = new Set<string>();
  for (const block of blocks) {
    const key = `${block.page}:${block.order}`;
    if (seen.has(key)) split.add(key);
    else seen.add(key);
  }
  return split;
}

/**
 * What a section is called when its own words do not say.
 *
 * A copyright page has no heading on it — that is half of what identifies it —
 * so the nav needs a word, and the honest word is the one the classifier used.
 * A part and a contents page usually carry their own and never reach this.
 */
const KIND_LABEL: Partial<Record<DotsPageKind, string>> = {
  'title-page': 'Title Page',
  copyright: 'Copyright',
  contents: 'Contents',
  part: 'Part',
};

/**
 * `data-bf-kind` on a wrapper around the section, and ONLY when there is one.
 *
 * The same contract as `data-bf-page` and `data-bf-cat`: an attribute the
 * picker selects on, so that "delete the title page" is one click rather than a
 * person reading four documents to find out which is which. It is on a wrapper
 * rather than on each block because the kind is a fact about the SECTION — the
 * page announced it, and the blocks that follow belong to what it announced.
 *
 * `chapter` IS NOT A KIND HERE, and the reason is narrower than it used to be.
 * The four kinds above are what a PAGE said it was; `chapter` is
 * `proposeChapters`, a rule whose output a person curates. A `data-bf-kind`
 * wrapper is a statement about a whole SECTION — everything inside this file is
 * a part divider — and wrapping a proposal in one would make a claim about
 * every block a possibly-wrong split happened to enclose. So no wrapper.
 *
 * THE BLOCK-LEVEL STAMP IS A DIFFERENT QUESTION, AND THE ANSWER CHANGED. This
 * comment used to argue that a proposal must not be written into the book at
 * all, because an attribute stops being an offer and becomes a claim. That was
 * wrong about who reads it. The picker's palette HAS a `chapter` category —
 * "Chapter Openings — the EPUB split points" — and it is the control a person
 * uses to move a split, add one, or take one away. A proposal that is not
 * stamped is not visible there, so a book converted this way arrived with no
 * chapter openings in the picker at all and nothing to curate: the offer was
 * unreadable, which is worse than an offer that is sometimes wrong. So the
 * heading a chapter proposal points at, and the display headings of a part
 * divider, carry `data-bf-cat="chapter"` — see `openingHeadings` — and the
 * curation the old comment was protecting is the thing that now works.
 *
 * A section with no kind is still emitted exactly as it was before any of this
 * existed. That is the classifier's silence reaching the file.
 */
function stampKind(xhtml: string, kind: DotsPageKind | null, page: number): string {
  if (kind === null || kind === 'chapter') return xhtml;
  return `<section data-bf-kind="${kind}" data-bf-page="${page}">\n${xhtml}\n</section>`;
}

/**
 * The print-source page marker, the standard EPUB spelling of it.
 *
 * Emitted at the first element that came from each page, and INSIDE a paragraph
 * when the page turn happened mid-paragraph — which is exactly where the
 * convention says it goes, and is the reason the marker is a span rather than
 * an attribute on the block.
 */
function pageBreak(page: number): string {
  // Closed explicitly rather than self-closed: an EPUB document is XML and both
  // spellings parse, but `<span/>` is an OPEN tag to anything that falls back to
  // an HTML parser, and the rest of the paragraph then lives inside it.
  return `<span epub:type="pagebreak" role="doc-pagebreak" id="pb-${page}"`
    + ` data-bf-page="${page}" aria-label="${page}"></span>`;
}

export interface DotsChapterOptions {
  column: BodyColumn;
  stripNoteMarkers: boolean;
  /** Running note number, so ids are unique across the whole book. */
  firstNote: number;
  /** Running picture number, for the same reason. */
  firstPicture: number;
  /**
   * How many stamped elements each page has already had written, MUTATED here
   * as they are written. The one thing in these options that is not read-only.
   *
   * It cannot be a per-chapter count, and that is the whole reason it is passed
   * in rather than started fresh: a chapter opens at a heading, a heading can
   * sit halfway down a page, and so one page's blocks routinely land in two
   * chapters. A count that restarted with each chapter would issue `p47-1`
   * twice on such a page — two elements wearing one name, in the one attribute
   * whose entire job is to be unique.
   */
  elementNumbers: Map<number, number>;
  /**
   * The headings that OPEN this section, indexed into `blocks` as it is passed
   * — this span's own numbering, not the book's.
   *
   * They get `data-bf-cat="chapter"` in place of their category, which is what
   * puts them in the picker's Chapter Openings palette. Empty for a span
   * nothing proposed, and the caller that knows which those are is
   * `buildDotsBook`: a span does not know whether a heading at its top is a
   * split point or the first heading inside one.
   */
  openers: ReadonlySet<number>;
  /**
   * The `page:order` of every answer element the markdown pass cut into more
   * than one block, for the WHOLE book — what `data-bf-src` needs to know before
   * it can decide whether to name a part.
   *
   * Passed in for `elementNumbers`' reason rather than counted here: a split's
   * pieces can land in two chapters, so a span that counted its own blocks would
   * call a split element unsplit and write a name meaning every piece of it.
   * `splitElements` is the one implementation and `buildDotsBook` runs it over
   * the flattened bank.
   */
  split: ReadonlySet<string>;
  /**
   * The inline `font-size` an OUTLIER block keeps, pre-formatted (`1.48em`),
   * keyed by block identity — `BookTypography.sizes`, and nothing else ever.
   *
   * Only the blocks that measured a different size from the rest of their
   * category are in it, so the ordinary case is a lookup that misses and an
   * element written exactly as it always was. The map is passed rather than the
   * measurements because the decision — whether this block is an outlier, and
   * what its size is as a ratio of the body — belongs to `typography.ts`, which
   * has the whole book to compare against; a chapter has one chapter.
   */
  sizes?: ReadonlyMap<DotsBlock, string>;
  /**
   * The curation, for the ONE decision that could not be applied at the parse:
   * a struck NOTE.
   *
   * Everything else a person decided is already in these blocks — `applyOverlay`
   * ran in `convert.ts`, so a struck block never reached this function and a
   * reclassified one arrives wearing its new category. A note is the exception
   * and structurally so: one banked Footnote answer becomes several notes only
   * when `splitNotes` cuts it up, three lines below, so at the parse there was
   * no such thing as note 3 to decide anything about. `noteStruck` reads the
   * `note` targets here, where the aside is being written and the ordinal is in
   * hand.
   *
   * Absent for every caller that has no curation, which renders exactly as it
   * always did.
   */
  overlay?: Overlay;
  /**
   * Write an EDITION rather than the working book — `vlm-convert --final`, and
   * `DotsBookOptions.final` carries the whole argument.
   *
   * Absent and false are the same thing and are the default everywhere, because
   * the cast book is what this emitter has always written and every test in the
   * suite pins it.
   */
  final?: boolean;
  /**
   * A transform's answers, keyed by position — `DotsBookOptions.records` has
   * the whole argument. Absent is a book made of its own words.
   */
  records?: ReadonlyMap<string, string>;
}

export interface DotsChapterBody {
  xhtml: string;
  label: string | null;
  crops: DotsCrop[];
  notes: number;
  /** The pages whose first paragraph was joined onto the previous page's. */
  joinedPages: number[];
  /**
   * The section headers inside this chapter, in order, each anchored in the
   * xhtml as `<h2 id="...">`. What the nav lists under the chapter.
   */
  headings: { id: string; label: string }[];
}

/**
 * One note of the chapter, known before any prose is rendered.
 *
 * `printed` is the number the BOOK gave it — the leading superscript run of
 * its text — and it is the only name a reference marker in the prose can use.
 * It is not `seq`: printed numbering restarts wherever the book restarted it
 * (per chapter, per page, sometimes mid-chapter), while `seq` runs through the
 * whole book because it mints element ids. What disambiguates two notes that
 * are both printed "1" is the PAGE: in print, a footnote sits at the bottom of
 * the page its reference is on, so (page, printed) names a note as precisely
 * as the book itself does.
 */
interface ChapterNote {
  block: DotsBlock;
  text: string;
  printed: number | null;
  seq: number;
  /** Which note of `block` this is, counted from 0 — see `FlowNote.ordinal`. */
  ordinal: number;
  /**
   * A transform's words for THIS NOTE, or null where there are none.
   *
   * Held beside `text` rather than replacing it, and the separation is the
   * whole of what makes a translated note work. `text` stays the SOURCE, which
   * is what `printed` was read off and what the reference markers in the prose
   * match on — a note's printed number is a fact about the page and must not
   * move because somebody translated the sentence under it. `translated` is the
   * words, and only the words.
   */
  translated: string | null;
  /** The id of the FIRST prose marker that linked here — where the backlink aims. */
  refId: string | null;
  /**
   * Did a person strike this note? — `overlay.ts`'s `noteStruck`, asked once,
   * where the notes are gathered.
   *
   * Read by three places that must not disagree: the reference marker in the
   * prose, the aside's own mark, and whether the chapter has a footnotes section
   * at all. See the note above the gathering for why it cannot be asked at the
   * aside any more.
   */
  struck: boolean;
}

const LEADING_SUPERSCRIPT = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+/;
const SUPERSCRIPT_VALUE = '⁰¹²³⁴⁵⁶⁷⁸⁹';

function printedNumber(run: string): number {
  return Number([...run].map((c) => String(SUPERSCRIPT_VALUE.indexOf(c))).join(''));
}

/**
 * One section of the flowing book, written down as XHTML.
 *
 * IT DECIDES NOTHING ABOUT THE BOOK ANY MORE, and that is the whole of this
 * phase. It used to work out the page-turn joins while it concatenated strings
 * — reopening a `</p>` it had already closed, counting characters back through
 * rendered markup to find the half of a word the column broke, and splicing the
 * pagebreak span into the seam. The joins are `reflowBook`'s answer now and
 * arrive already made; what is left here is the questions that are genuinely
 * about the FILE: which tag a category takes, where an anchor is needed, what a
 * note's id is, and which page marker is still owed.
 */
export function buildChapterBody(
  blocks: readonly FlowBlock[],
  opts: DotsChapterOptions,
): DotsChapterBody {
  const out: string[] = [];
  const crops: DotsCrop[] = [];
  const joinedPages: number[] = [];
  const headings: { id: string; label: string }[] = [];

  /*
   * The chapter's notes, gathered BEFORE the prose renders. The prose is where
   * the reference markers live, and a marker can only become a link to a note
   * that is already known — rendering in one pass would mean the first half of
   * a page's prose could never reach the notes at that page's bottom.
   *
   * `seq` is the only thing added to what the base already collected: it runs
   * through the WHOLE book because it mints element ids, so it is the caller's
   * running number and not a fact about this chapter.
   */
  /*
   * `struck` IS DECIDED HERE AND NOT AT THE ASIDE, and the move is the whole of
   * what makes `--final` possible.
   *
   * `noteStruck` used to be asked once per `<aside>`, at the bottom of this
   * function, because a mark on the aside was all anybody wanted from it. An
   * EDITION needs the same answer three hundred lines earlier: the reference
   * marker in the prose is written before the notes are, and a marker that must
   * not link to a note it will never find has to know that while the paragraph
   * is being built. So the question is asked once, where the notes are gathered,
   * and every later reader — the marker, the aside, the section — reads the same
   * boolean.
   *
   * The cast path is unchanged by the move: the same overlay is asked the same
   * question about the same (block, ordinal) and gets the same answer, one pass
   * earlier.
   */
  const notes: ChapterNote[] = collectNotes(blocks).map((note, index) => ({
    block: note.source,
    text: note.text,
    printed: note.printed,
    seq: opts.firstNote + index,
    ordinal: note.ordinal,
    refId: null,
    struck: opts.overlay !== undefined && noteStruck(opts.overlay, note.source, note.ordinal),
    /*
     * ── A RECORD PER NOTE, AND THE SPLIT IS STILL THE SOURCE'S ────────────────
     *
     * One banked Footnote answer is several notes, cut by `splitNotes` on the
     * source's own rule — a superscript number at the start of a line — which is
     * language-neutral because it runs on the words the SCAN had. That is why a
     * transform can be per-note at all: the structure is decided here, from the
     * bank, and the record supplies one note's words into a shape it did not
     * choose. A record could never carry the shape itself; a whole-block
     * translation of five notes would have no handle to drop the third when
     * somebody strikes it.
     *
     * `#ordinal` is that handle, and it is the same dimension `data-bf-note`
     * writes and an overlay's `note` target points at. So a struck note drops
     * its record at materialization exactly as a struck block drops a block:
     * under `--final` the aside is never written, and the record it would have
     * held words for is simply never read.
     */
    translated: opts.records?.get(`${sourceKey(
      note.source.page, note.source.order, note.source.part, opts.split,
    )}#${note.ordinal}`) ?? null,
  }));

  /*
   * (page, printed) -> the note, or null — and null means the marker stays a
   * plain `<sup>`. The one-page grace covers a note whose block the model read
   * on the following page; a wrong link would be worse than no link, so the
   * search never goes wider than that.
   */
  const noteFor = (page: number, printed: number): ChapterNote | null =>
    notes.find((n) => n.printed === printed && n.block.page === page)
    ?? notes.find((n) => n.printed === printed && n.block.page === page + 1)
    ?? null;

  const inline = (text: string, page?: number): string =>
    dotsInline(text, {
      stripNoteMarkers: opts.stripNoteMarkers,
      noteref: page === undefined ? undefined : (printed) => {
        const note = noteFor(page, printed);
        if (note === null) return null;
        /*
         * A STRUCK NOTE'S REFERENCE KEEPS ITS NUMBER AND LOSES ITS LINK, in the
         * edition only — `null` here is the same answer the emitter already
         * gives a marker it could not match, and `dotsInline` writes the plain
         * `<sup>n</sup>` for it. The number is printed on the page and this
         * program does not delete what the scan shows; the link is the part that
         * would be a promise about a note this file is about to not write.
         *
         * It is exactly `epub-final`'s demotion (`src/epub/final.ts`, "the
         * mirror case"), done at the source instead of over the finished
         * markup — which is what the plain-text route needs, since a pass over
         * the EPUB cannot reach the txt export at all.
         */
        if (opts.final === true && note.struck) return null;
        // Only the FIRST reference carries an id: ids are unique, and the
        // backlink can only aim one place. A second marker for the same note
        // still links forward.
        const first = note.refId === null;
        if (first) note.refId = `ref-fn${note.seq}`;
        return `<a${first ? ` id="${note.refId}"` : ''} class="noteref" epub:type="noteref"`
          + ` role="doc-noteref" href="#fn${note.seq}"><sup>${printed}</sup></a>`;
      },
    });

  let label: string | null = null;
  let openList: 'ol' | 'ul' | null = null;
  const pagesSeen = new Set<number>();

  const closeList = (): void => {
    if (openList === null) return;
    out.push(`</${openList}>`);
    openList = null;
  };

  /**
   * The size this block keeps, when it is not the size the rest of its category
   * is. Empty for every block that is, which is nearly all of them.
   *
   * NOT WRITTEN ON EVERY ELEMENT KIND, and the omissions are deliberate. A
   * `List-item` block is a whole run of items in one box, so its measured line
   * height is the list's leading rather than any item's type; a `Table`'s text
   * is the model's own HTML and nothing in this file reaches inside it to style
   * a cell; a `Formula`'s box is its own layout and not a line of type; a
   * `Picture` has no type in it. None of those four is a size that could be
   * measured, so none of them is a size that gets written.
   */
  const sized = (block: DotsBlock): string => {
    const em = opts.sizes?.get(block);
    return em === undefined ? '' : ` style="font-size:${em}"`;
  };

  /**
   * `data-bf-page`, `data-bf-cat`, `data-bf-id` and `data-bf-src` — see this
   * file's header, and `stampSrc` for the last of them.
   *
   * `src` IS A PARAMETER RATHER THAN SOMETHING WORKED OUT FROM `block`, and it
   * has to be: the block handed here is the one the ELEMENT is about — the first
   * part of a joined paragraph — and the provenance is the whole list. Only the
   * caller holds the flow block, so only the caller can name every answer the
   * element's words came from. A block that is its own single part passes
   * `sourceOf` of itself, which is the ordinary case and every case but a
   * page-turn join.
   *
   * TWO OF THE FOUR ARE NOT WRITTEN INTO AN EDITION. `data-bf-id` and
   * `data-bf-src` are the picker's plumbing — a name for an element this app can
   * address and the banked answers its words came from — and neither means
   * anything to a reader or to any program but this one. `data-bf-page` and
   * `data-bf-cat` stay under `--final`, which is `epub-final`'s ruling
   * unchanged (`src/epub/final.ts`): page provenance is what makes a scan
   * citable, it is invisible in a reader, and every later pass reads it.
   *
   * THE COUNTER STILL RUNS in final mode, on purpose. It costs a map write, and
   * the alternative is a second numbering rule that only ever applies to the
   * edition — so an id that is never written is still an id nothing else took.
   */
  const stamp = (
    block: DotsBlock,
    src: string,
    attribute: string = CATEGORY_ATTRIBUTE[block.category],
  ): string => {
    const n = opts.elementNumbers.get(block.page) ?? 1;
    opts.elementNumbers.set(block.page, n + 1);
    const editing = opts.final === true ? '' : `${stampId(block.page, n)}${stampSrc(src)}`;
    return ` data-bf-page="${block.page}" data-bf-cat="${attribute}"${editing}`;
  };

  /** Every part of a flow block, named as a decision would name it. */
  const sourceOf = (parts: readonly FlowPart[]): string =>
    parts.map((part) => sourceKey(part.page, part.order, part.part, opts.split)).join(' ');

  /**
   * ── THE ONE PLACE A TRANSFORM'S WORDS ENTER THE BOOK ────────────────────────
   *
   * A record is a translation of `FlowBlock.text` keyed by the block's position
   * (`src/translate/records.ts`), and this is where a position's words become a
   * file. The lookup is the SAME STRING `data-bf-src` is written from — worked
   * out once per block above and passed here — which is what makes the
   * correspondence checkable by opening the book: an element's `src` attribute
   * is the key of the record that supplied its words.
   *
   * AFTER THE REFLOW AND NOT INSTEAD OF IT, and that ordering is the design.
   * Everything the reflow decides — which blocks join across a page turn, where
   * the chapters open, which word the column broke in half, which running heads
   * were furniture — is decided by reading the SOURCE text, in the source
   * language, with the book's own lexicon. A pass that substituted before it
   * would be asking German questions of English sentences, and the joins are
   * exactly the decisions that would go wrong first. So the base is built from
   * the bank, always, and the words are exchanged at the last moment.
   *
   * PROVENANCE IS UNTOUCHED BY THIS. `data-bf-src`, `data-bf-page`,
   * `data-bf-cat` and `data-bf-id` are all computed from `flow.parts` and the
   * block's own identity, never from its text, so a substituted paragraph still
   * names the banked blocks a reader would check it against. That is not a
   * nicety: a translation whose page provenance pointed at the wrong scan page
   * would be uncheckable, and uncheckable is what this program refuses.
   *
   * A POSITION WITH NO RECORD KEEPS ITS SOURCE TEXT. A partial translation is
   * rendered honestly — the blocks that came back are in the target language
   * and the blocks that did not are in the book exactly as it was read, which is
   * what `translate` already does with a block the model refused.
   */
  const worded = (flow: FlowBlock, src: string): string =>
    opts.records?.get(src) ?? flow.text;

  /** The same, for a block that reaches the stamp on its own — a note. */
  const sourceOfBlock = (block: DotsBlock): string =>
    sourceKey(block.page, block.order, block.part, opts.split);

  /** The page marker owed to this block, if it opens a page. Consumed once. */
  const marker = (block: DotsBlock): string => {
    if (pagesSeen.has(block.page)) return '';
    pagesSeen.add(block.page);
    return pageBreak(block.page);
  };

  for (const [index, flow] of blocks.entries()) {
    /*
     * The block the ELEMENT is about: the first of the parts, and for every
     * block in a book but a joined paragraph it is the only one. Its box gives
     * the alignment, its identity gives the measured type size, and its page
     * and category give the stamp — all four are facts about where the
     * paragraph STARTED, which is what a paragraph broken over a page turn has
     * one of.
     */
    const block = flow.source;
    /*
     * WHERE THIS BLOCK'S WORDS CAME FROM, worked out once and written on every
     * element the block produces. See `stampSrc`: the container and its child are
     * two names of the file and one block of the book, and a decision about
     * either is a decision about the same banked answer.
     */
    const src = sourceOf(flow.parts);
    /** What this block SAYS: a record's words where there is one, its own otherwise. */
    const words = worded(flow, src);
    if (flow.category === 'List-item') {
      /*
       * THE LIST'S TAG IS DECIDED ON THE SOURCE AND NEVER ON A RECORD. Whether
       * this is an `<ol>` or a `<ul>` is a fact about what the printer set —
       * the item opened with "1." on the page — and a translation is free to
       * drop the numeral, spell it as a word, or use its own language's
       * punctuation. Reading the tag off translated words would turn a numbered
       * list into a bulleted one halfway down, or worse, close one list and
       * open another mid-item.
       */
      const tag = /^\d+[.)]/.test(flow.text) ? 'ol' : 'ul';
      if (openList !== tag) {
        closeList();
        out.push(`<${tag}${stamp(block, src)}>`);
        openList = tag;
      }
      out.push(`  <li${stamp(block, src)}>${marker(block)}${inline(words, block.page)}</li>`);
      continue;
    }
    closeList();

    switch (flow.category) {
      case 'Title':
      case 'Section-header': {
        const xhtml = inline(words, block.page);
        // The TAG still comes from the true category: `h1` for a Title and `h2`
        // for a Section-header is the book's own hierarchy, and a chapter that
        // opens on a Section-header did not become a Title by opening one.
        const tag = flow.category === 'Title' ? 'h1' : 'h2';
        const align = alignmentClass(block.box, opts.column);
        const cat = opts.openers.has(index) ? CHAPTER_ATTRIBUTE : CATEGORY_ATTRIBUTE[flow.category];
        /*
         * A Section-header that is neither the chapter's own title (the first
         * heading, where `label` comes from) nor one of its opening headings
         * is a section INSIDE the chapter. It gets an anchor so the nav can
         * list it under the chapter — a contents page that stops at chapter
         * names is describing a shallower book than the one that was written.
         */
        let anchor = '';
        if (tag === 'h2' && label !== null && !opts.openers.has(index)) {
          const text = plainText(xhtml);
          if (text.length > 0) {
            const id = `sh${headings.length + 1}`;
            anchor = ` id="${id}"`;
            // `headingLabel`, because a nav entry is one line and this heading
            // may be two — either because the printer set it that way in one
            // box or because `mergeAdjacentHeadings` joined two. The separator
            // it adds is confined to this label and never reaches the `<h2>`
            // above, which keeps the break the page had.
            headings.push({ id, label: headingLabel(text) });
          }
        }
        out.push(
          `<${tag}${anchor}${classOf(align)}${sized(block)}${stamp(block, src, cat)}>`
          + `${marker(block)}${xhtml}</${tag}>`,
        );
        // The section's own name, flattened for the contents the same way an
        // inner heading's is: the document's `<h1>` keeps the printed break and
        // the nav gets one line of it.
        label ??= headingLabel(plainText(xhtml));
        break;
      }
      case 'Quote':
        out.push(
          `<blockquote${stamp(block, src)}><p${sized(block)}${stamp(block, src)}>`
          + `${marker(block)}${inline(words, block.page)}</p></blockquote>`,
        );
        break;
      case 'Footnote':
        // Already in `notes`, held back to the end of the chapter. The page
        // marker is not consumed here: a note is not where its page's body
        // begins.
        break;
      case 'Table':
        /*
         * `flow.text` AND NOT `words`, and this is the one category where that
         * is deliberate. A Table block's text is the vision model's own HTML —
         * the whole grid as one string — and there is no such thing as a record
         * about it: `translate --records` refuses tables whole and says so,
         * because the cells are not banked blocks and have no position a record
         * could be keyed to. Reading a record here could therefore only find one
         * this program did not write, and writing a stranger's HTML into a
         * `<div class="tablewrap">` is not something to do on a maybe.
         */
        out.push(
          `<div class="tablewrap"${stamp(block, src)}>${marker(block)}`
          + `${checkTableHtml(flow.text, block.page)}</div>`,
        );
        break;
      case 'Formula':
        out.push(`<p class="formula"${stamp(block, src)}>${marker(block)}${inline(words, block.page)}</p>`);
        break;
      case 'Picture': {
        const name = `p${String(block.page).padStart(4, '0')}-${opts.firstPicture + crops.length}.png`;
        crops.push({ page: block.page, box: block.box, name });
        out.push(
          `<figure${stamp(block, src)}>${marker(block)}`
          + `<img src="../images/${name}" alt="figure from page ${block.page}"/></figure>`,
        );
        break;
      }
      case 'Caption':
        out.push(
          `<p class="caption"${sized(block)}${stamp(block, src)}>`
          + `${marker(block)}${inline(words, block.page)}</p>`,
        );
        break;
      default: {
        /*
         * Text — the one kind that can be several banked blocks, and the whole
         * of what is left of the page-turn join here: writing down, in order,
         * the pieces `reflowBook` resolved.
         *
         * THE PAGE MARKER GOES INSIDE THE PARAGRAPH, at the seam, which is
         * exactly where the EPUB convention puts it and is the reason it is a
         * span rather than an attribute on the block. Its position is
         * `parts`: the page turned where one part ended and the next began, so
         * the provenance list is not a lookup for this, it IS this. And when a
         * word was broken across the turn, the marker goes BEFORE the whole
         * word — a reader cannot be given half a word on either side of a
         * marker that stands for the paper it was printed on.
         *
         * The size and the alignment are written once, from the block that
         * OPENED the paragraph: a paragraph broken over a page turn is one
         * paragraph, and one paragraph is one size.
         */
        const align = alignmentClass(block.box, opts.column);
        const written: string[] = [];
        /*
         * ── A SUBSTITUTED PARAGRAPH HAS NO SEAM, so its markers go to the front ─
         *
         * The loop below writes the paragraph part by part precisely so the page
         * marker can sit at the seam — the exact character where one page ended
         * and the next began. A RECORD HAS NO SUCH CHARACTER. It is one
         * translation of the whole paragraph; the words that were on page 48 and
         * the words that were on page 49 are not separable in it, and any
         * position this file picked inside it would be a claim about the paper
         * that the sentence cannot support. Splitting the record by the source's
         * part lengths would be exactly that claim with arithmetic in front of
         * it.
         *
         * So the markers every part still owes are written together, in page
         * order, at the head of the paragraph — the same place part 0's marker
         * has always gone — and the paragraph that swallowed a page turn says
         * "pages 48 and 49 begin here". That is one element early for the second
         * of them and it is the honest reading: the `pb-N` anchors all exist,
         * they are unique, they stay in ascending document order, and nothing
         * downstream (`epub-final`'s cut machinery, a citation, a reader's
         * page-list) is given a position the translation cannot back up.
         *
         * `joinedPages` is counted from the SOURCE either way, because it is a
         * report about what the reflow did and the reflow ran on the bank.
         */
        const substituted = words !== flow.text;
        for (const [n, part] of flow.parts.entries()) {
          if (!substituted) {
            if (part.join === 'space') written.push(' ');
          }
          written.push(marker(part.block));
          if (!substituted) {
            if (part.fused !== null) written.push(inline(part.fused, part.page));
            written.push(inline(part.text, part.page));
          }
          // A TURN, not merely a part: two blocks the printer set one under the
          // other on one page are joined here too, and no page was turned.
          if (n > 0 && part.page !== flow.parts[n - 1].page) joinedPages.push(part.page);
        }
        if (substituted) written.push(inline(words, block.page));
        out.push(
          `<p${classOf(align)}${sized(block)}${stamp(block, src)}>${written.join('')}</p>`,
        );
      }
    }
  }
  closeList();

  /*
   * WHICH NOTES THE FILE ACTUALLY GETS — everything in the cast, and everything
   * that survived the curation in an edition.
   *
   * A CHAPTER WHOSE EVERY NOTE WAS STRUCK WRITES NO SECTION AT ALL, which is
   * the reason this is a list rather than a test inside the loop: a
   * `<section class="footnotes">` holding nothing but its `<hr/>` is a rule with
   * white space under it, and a reader sees it. `epub-final` removes exactly
   * that section for exactly that reason; this is the same removal one stage
   * earlier, where the plain-text route can also see it.
   *
   * `notes.length` REMAINS WHAT THIS CHAPTER REPORTS (see the return), because
   * that number is the book's running note counter and not a count of asides: a
   * chapter that minted five ids and wrote three must still hand the next
   * chapter a `firstNote` past all five, or two chapters share an `fn` id.
   */
  const emitted = opts.final === true ? notes.filter((note) => !note.struck) : notes;
  if (emitted.length > 0) {
    out.push('<section class="footnotes" epub:type="footnotes">');
    out.push('<hr/>');
    for (const note of emitted) {
      /*
       * An <aside epub:type="footnote"> rather than a <p>: that is the element
       * reading systems recognise for pop-up notes, and it costs nothing to a
       * reader that just renders it in place. The note's own number becomes
       * the BACKLINK when some marker in the prose claimed it — click the
       * number, land back where you were reading — and stays a plain <sup>
       * when nothing did, because a link to nowhere teaches a reader not to
       * click the next one. The rest of the note is rendered WITHOUT the
       * linker (no page passed): a superscript inside a note's text is a
       * reference in the note's own prose, and (page, printed) would resolve
       * it to a sibling note at the same page bottom — a wrong link, made
       * confidently.
       */
      /*
       * THE NUMBER COMES OFF THE SOURCE AND THE WORDS COME OFF THE RECORD.
       *
       * The printed number is the book's — it is what the page set, what the
       * reference marker in the prose matched on, and what the backlink is
       * keyed to — so it is read from `note.text` whether or not a translation
       * exists. A model that shed the note's leading superscript run (a short
       * note is mostly number, and that is exactly the failure `markers.ts`'s
       * edge peel was invented for) therefore costs the book nothing here.
       *
       * The record's OWN leading run is stripped when it kept one, because the
       * number is written from `printed` above and a note reading "¹ ¹ See the
       * work of yesterday" is what happens if both are trusted.
       */
      const lead = opts.stripNoteMarkers ? null : LEADING_SUPERSCRIPT.exec(note.text);
      const printed = lead ? printedNumber(lead[0]) : null;
      const words = note.translated ?? note.text;
      const cut = note.translated === null
        ? lead
        : opts.stripNoteMarkers ? null : LEADING_SUPERSCRIPT.exec(words);
      const rest = cut ? words.slice(cut[0].length).replace(/^\s+/, '') : words;
      const number = printed === null
        ? ''
        : note.refId !== null
          ? `<a class="fn-back" epub:type="backlink" role="doc-backlink" href="#${note.refId}"><sup>${printed}</sup></a> `
          : `<sup>${printed}</sup> `;
      /*
       * `data-bf-note` — WHICH NOTE OF ITS BLOCK THIS IS, and the reason it has
       * to be written down is `data-bf-src`'s reason one paragraph over.
       *
       * The `src` beside it names the banked answer these words came from, and
       * five asides can carry the SAME ONE: a page printing five notes under a
       * rule is one box in the model's answer, and `splitNotes` is what makes
       * five elements out of it. So `src` alone cannot say which note the reader
       * pointed at, and the app striking a footnote on the flowing page had a
       * choice between recording a decision that removed all five and recording
       * nothing. It recorded nothing, and said so.
       *
       * This is the missing half. The ordinal is `splitNotes`' own index —
       * deterministic from the same bank, unchanged by a re-cast — and it is
       * what an overlay's `note` target points at, so a cut made here comes back
       * as a decision keyed exactly the way the emitter named it.
       *
       * ON EVERY ASIDE AND NOT ONLY THE SPLIT ONES. A block that yielded one
       * note writes `data-bf-note="0"`, which costs eleven bytes and means the
       * app never has to decide whether a missing attribute is "one note" or "a
       * book cast before this existed" — a question with two answers and no way
       * to tell them apart.
       *
       * AND THE CUT MARK, when a person struck this note. It is the same
       * `data-bf-cut="1"` a struck block wears in the working tree, painted
       * struck through by select mode, brought back by Delete, and removed from
       * the edition by `foundry epub-final` — marks, not removal, because a note
       * that vanished here would renumber every note after it behind the person
       * who struck one.
       *
       * NONE OF THE THREE REACHES AN EDITION, and the cut mark cannot: a struck
       * note has no aside under `--final`, so the only notes this loop sees
       * there are the ones nobody struck. It is still written as a condition
       * rather than as a constant, because "the mark says what the overlay says"
       * is the rule, and a `false` spelled into the markup would be a second
       * statement of it that could stop being true.
       */
      const editing = opts.final === true
        ? ''
        : ` data-bf-note="${note.ordinal}"${note.struck ? ' data-bf-cut="1"' : ''}`;
      out.push(
        `<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn${note.seq}"`
        + `${sized(note.block)}${stamp(note.block, sourceOfBlock(note.block))}`
        + `${editing}>`
        + `${number}${inline(rest)}</aside>`,
      );
    }
    out.push('</section>');
  }

  return { xhtml: out.join('\n'), label, crops, notes: notes.length, joinedPages, headings };
}

function classOf(align: string): string {
  return align === '' ? '' : ` class="${align}"`;
}

/**
 * One Footnote block often carries several notes, one after another.
 *
 * Each begins with its own superscript number, so that is where they are split
 * — and only at a LINE START, because a superscript in the middle of a note is
 * a reference inside the note's own text.
 */
export function splitNotes(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(line) && current.length > 0) {
      parts.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(current.join('\n').trim());
  return parts.filter((p) => p.length > 0);
}


// ── the paragraph the model forgot to reflow ────────────────────────────────

/**
 * The shortest line a JUSTIFIED column produces, in characters.
 *
 * Measured on Nuremberg, over every Text block that kept a newline and has no
 * blank line in it — 3,175 non-final lines, and the distribution is two humps
 * with a hole between them:
 *
 * ```
 *    0- 9 |  19       50- 59 |   52
 *   10-19 |  66       60- 69 | 1796
 *   20-29 | 443       70- 79 |  375
 *   30-39 | 355       80-119 |   22
 *   40-49 |  21
 * ```
 *
 * The right hump is wrapped prose: a 65-character line, every line the same
 * length because the column is justified. The left hump is everything a break
 * is deliberate in — verse, an address, a list of abbreviations, a contents
 * entry. Between them, 40 to 59, sits 2.3% of all the lines in the book. 45 is
 * in that hole rather than against either side of it, so the number is not
 * carrying any weight it was not measured for.
 */
const JUSTIFIED_LINE_CHARS = 45;

/**
 * A run of breaks that all land on a full stop is a LIST, not a paragraph.
 *
 * The line-length rule alone is wrong about one thing in Nuremberg, and only
 * one: the bibliography. Its entries are set one to a line and each is long
 * enough to pass — `POSNER, Gerald L. Hitler's Children. New York: Random
 * House, 1991.` is 66 characters — so a 13-entry block reflows into a single
 * run-on paragraph and the reader loses the list.
 *
 * What is different about it is WHERE the breaks fall. A wrapped column breaks
 * wherever the margin arrives, which is mid-sentence almost every time; a list
 * breaks at the end of every entry. Over the whole book, 8 of the 366 blocks
 * the length rule accepts have every break on terminal punctuation, and six of
 * those are two-line blocks where one sentence simply happened to end at the
 * margin. Requiring THREE such breaks leaves exactly the two bibliography
 * blocks — the coincidence stops being available at three, and the measurement
 * says so rather than the arithmetic.
 */
const STRUCTURED_BREAKS = 3;
const ENDS_A_SENTENCE = /[.!?][*"'”’)]?$/;

/**
 * Put back the paragraphs the model did not reflow.
 *
 * `dotsInline` turns a surviving newline into `<br/>`, on the model's own
 * behaviour: it reflows wrapped prose, so a newline it kept is a line ending
 * somebody meant. It reflowed 1,870 of Nuremberg's long Text blocks and MISSED
 * 386, and those 386 reach the reader as prose chopped at the width of the
 * printed page — a defect nothing else in the pipeline can see, because every
 * one of those newlines is indistinguishable from a line of verse when you are
 * looking at one newline.
 *
 * Looking at the whole block tells them apart. Three conditions, all of them
 * about the block and none about its words:
 *
 *  - it is a Text block. A Quote is where the verse is, and verse set as
 *    long lines is exactly what this rule would destroy; a heading's second
 *    line is a line the designer chose. Neither is touched.
 *  - it has no BLANK line in it. A blank line is structure the model went out
 *    of its way to keep — Nuremberg's list of abbreviations is one block with
 *    paragraph breaks in it — and a block that says that much about its own
 *    shape is believed.
 *  - every line but the last is at least `JUSTIFIED_LINE_CHARS`. This is the
 *    measurement that does the work: a justified column ends every line but its
 *    last at the right margin, and nothing else in a book does.
 *  - its breaks do not all land on a full stop — see `STRUCTURED_BREAKS`, which
 *    is what keeps the bibliography a bibliography.
 *
 * The last line is exempt from both because a paragraph's last line is short by
 * definition and ends a sentence by definition.
 *
 * Runs AFTER the dehyphenation pass, and the order matters: dehyphenation fuses
 * the `word-\nword` seams, so by the time this runs the newlines that are left
 * are plain wrapped lines and the line lengths are the ones the reader would
 * have seen. Mutates, and returns the blocks it changed so the run can say how
 * many there were.
 */
export function reflowWrappedProse(blocks: readonly DotsBlock[]): DotsBlock[] {
  const reflowed: DotsBlock[] = [];
  for (const block of blocks) {
    if (block.category !== 'Text' || !block.text.includes('\n')) continue;
    if (/\n[ \t]*\n/.test(block.text)) continue;
    const lines = block.text.split('\n');
    const wrapped = lines.slice(0, -1).map((line) => line.trim());
    if (wrapped.some((line) => line.length < JUSTIFIED_LINE_CHARS)) continue;
    if (wrapped.length >= STRUCTURED_BREAKS && wrapped.every((l) => ENDS_A_SENTENCE.test(l))) continue;
    // The spaces either side of the break go with it: the line ended at the
    // margin and the next began at it, and a book with `word  word` in it is a
    // book somebody has to explain.
    block.text = block.text.replace(/[ \t]*\n[ \t]*/g, ' ');
    reflowed.push(block);
  }
  return reflowed;
}

// ── the book ────────────────────────────────────────────────────────────────

/**
 * The book's stylesheet, and the line at the top of it used to read "No
 * per-book font decisions, ever."
 *
 * THAT RULE IS REVERSED HERE, DELIBERATELY, AND ONLY BECAUSE THE EVIDENCE
 * CHANGED. It was written when a font decision could only ever have been a
 * GUESS — the prose dialects report what a page says and never how big it says
 * it, so any size this program chose for a footnote would have been a number
 * somebody made up and then defended. The sizes below are not chosen. They are
 * the ratios `typography.ts` measured off every box in this particular book:
 * how much smaller its footnotes are than its prose, how much bigger its
 * chapter titles, taken as medians over the whole book. The same class of fact
 * as `bodyColumn`'s column and `BookLexicon`'s vocabulary, and the reason the
 * old rule does not apply to it is that it is not a decision about fonts at
 * all — it is a report of one the book's designer already made.
 *
 * The numbers in the base sheet stay, and stay meaningful. They are the
 * defaults for a book that could not be measured, and — because a derived rule
 * is appended AFTER them at identical specificity — the value that stands for
 * every category the measurement stayed silent about. A book with three
 * captions in it gets `0.9em` captions, exactly as it always did.
 *
 * Still no point sizes and still no font families: everything derived is an
 * `em` against the reader's own body size, so the reader decides how big the
 * book is and the book decides what is bigger than what.
 */
const STYLESHEET_BASE = `/* Foundry — vlm-convert, dots.ocr. Sizes are the book's own, as em ratios. */
html { font-size: 100%; }
body { margin: 0 5%; line-height: 1.5; }
h1, h2 { line-height: 1.2; margin: 1.4em 0 0.8em; }
h1.centered, h2.centered { text-align: center; }
p { margin: 0 0 0.4em; text-indent: 1.4em; }
p.centered, p.caption, p.formula { text-indent: 0; text-align: center; }
p.right { text-indent: 0; text-align: right; }
p.caption { font-size: 0.9em; font-style: italic; margin: 0.4em 0 1em; }
blockquote { margin: 0.8em 2.2em; }
blockquote p { text-indent: 0; font-size: 0.95em; }
figure { text-align: center; margin: 1em 0; }
figure img { max-width: 100%; }
sup { font-size: 0.75em; line-height: 0; vertical-align: super; }
.footnotes { font-size: 0.85em; margin-top: 2em; }
.footnotes .footnote { text-indent: 0; margin-bottom: 0.5em; }
a.noteref, a.fn-back { text-decoration: none; }
.tablewrap { margin: 1em 0; overflow-x: auto; }
table { border-collapse: collapse; margin: 0 auto; }
td, th { border: none; padding: 0.35em 1.1em; }
th { border-bottom: 1px solid currentColor; }
`;

/**
 * Where each measured category writes itself, and there are only five.
 *
 * Each selector already carries a font-size in the base sheet, or — for the two
 * headings — carries none and inherits one from the reading system. Both are
 * things the book itself can now answer better, and neither is a place where a
 * wrong number could do anything but make a heading the wrong size.
 */
const DERIVED_RULES: ReadonlyArray<readonly [DotsCategory, string]> = [
  ['Footnote', '.footnotes'],
  ['Caption', 'p.caption'],
  ['Quote', 'blockquote p'],
  ['Title', 'h1'],
  ['Section-header', 'h2'],
];

/**
 * The stylesheet this book gets: the base sheet, and whatever its own type
 * could be measured saying.
 *
 * A category with no entry in `typography.categories` produces NO RULE — see
 * `typography.ts`, where a category needs four blocks before its median is a
 * measurement. That silence is the point rather than an omission: the base
 * sheet's value stands, and nothing in the finished book claims to have been
 * measured when it was not. A book that could not be measured at all gets the
 * base sheet byte for byte, which is the stylesheet every book got before any
 * of this existed.
 */
export function dotsStylesheet(typography: TypographyReport | null): string {
  const derived = DERIVED_RULES.flatMap(([category, selector]) => {
    const measured = typography?.categories[category];
    return measured === undefined
      // Two decimals: the third one is smaller than the quantisation of the
      // measurement it came from, and printing it would be a precision the
      // number has not got.
      ? []
      : [`${selector} { font-size: ${measured.ratio.toFixed(2)}em; }`];
  });
  if (derived.length === 0) return STYLESHEET_BASE;
  return `${STYLESHEET_BASE}\n/* Measured from this book: `
    + `${typography!.bodyPx.toFixed(1)}px body line, `
    + `${typography!.outliers.length} block(s) kept at their own size. */\n`
    + `${derived.join('\n')}\n`;
}

/**
 * The headings at the top of a section that ARE the split point, as indices
 * into the section's own blocks.
 *
 * A chapter often opens on two of them — `CHAPTER I` and then `PRELUDE TO
 * JUDGMENT`, two blocks on page 25 of Nuremberg — and a person curating the
 * split needs both, because deleting one and leaving the other leaves a chapter
 * called `CHAPTER I` and an orphan line at the top of it. So the run is taken
 * whole: display headings from the top of the section's first page, stopping at
 * the first thing that is not one.
 *
 * A part divider does not stop there. It carries nothing but its announcement
 * (`partVerdict` measured that before naming it), so a Picture or a stray line
 * between its numeral and its title is part of the same announcement rather
 * than the start of the prose. A chapter's first paragraph, on the other hand,
 * is right underneath its title, and is where its headings end.
 *
 * Nothing else is stamped. A title page, a copyright page and a contents page
 * are already named by a `data-bf-kind` wrapper, which is the stronger
 * statement, and they are not places a reader wants the book to divide.
 */
export function openingHeadings(
  span: readonly FlowBlock[],
  kind: DotsPageKind | null,
): Set<number> {
  const openers = new Set<number>();
  if (span.length === 0 || (kind !== 'chapter' && kind !== 'part')) return openers;
  const page = span[0].source.page;
  for (const [index, block] of span.entries()) {
    if (block.source.page !== page) break;
    if (block.category === 'Title' || block.category === 'Section-header') {
      openers.add(index);
      continue;
    }
    if (kind === 'chapter') break;
  }
  return openers;
}

// ── the flowing book ────────────────────────────────────────────────────────

/**
 * How a part's text was attached to the part before it in the same paragraph.
 *
 * `opens` is the block a flow block began at and is what every unjoined block
 * in a book gets. The other two are the two halves of the page turn: `space`
 * where two whole words met, `fused` where the column broke a word and the
 * lexicon put it back together.
 */
export type FlowJoin = 'opens' | 'space' | 'fused';

/**
 * One banked block's contribution to a flowing block — the provenance, and the
 * piece of text it brought.
 *
 * `(page, order, part)` IS THE KEY, and it is the same key `overlay.ts` writes
 * amendments against and the same key a transform record will be written
 * against (`docs/DERIVED-BOOK.md` §5). It is carried here because pagination
 * stops being structure the moment the pages are flattened, and "which page did
 * this come from" has to stay answerable afterwards — for the reader who wants
 * to check a quotation against the scan, for the ops a person makes on the
 * flowing page, and for the pagebreak marker the emitter still owes the book.
 *
 * The CONTINUATION half of a joined paragraph is in this list, and that closes a
 * hole rather than opening one: today's emitter never stamps it at all, so the
 * second half of a paragraph that runs over a page turn reaches the finished
 * EPUB with no id, no category and no page of its own — invisible to the picker
 * and to `epub-final`'s cut machinery. The information exists from here on. The
 * emitter starts using it when the id scheme moves, which is a later phase and
 * deliberately not this one.
 */
export interface FlowPart {
  /**
   * The banked block, BY OBJECT IDENTITY and never a copy.
   *
   * `measureTypeSizes` and the typography report key `Map<DotsBlock, …>`, which
   * is why `applyOverlay` deliberately hands back the same object when nothing
   * about a block changed. A pass that copied blocks freely would lose every
   * measured type size in the book and say nothing about it.
   */
  block: DotsBlock;
  page: number;
  order: number;
  part: number;
  join: FlowJoin;
  /** The word the column broke, made whole. Null unless `join` is `fused`. */
  fused: string | null;
  /** What this part contributes to the flow block's text, after `fused`. */
  text: string;
}

/**
 * One block of the flowing book: what a reader sees as a single paragraph,
 * heading, note or figure, wherever the printer happened to break the page.
 */
export interface FlowBlock {
  /** Every block this one is made of, in reading order. Never empty. */
  parts: FlowPart[];
  category: DotsCategory;
  /** Dehyphenated, reflowed, page turns resolved. The text, once. */
  text: string;
  /** The FIRST part's block — where the alignment, the box and the size come from. */
  source: DotsBlock;
}

/** One note of the book, as `splitNotes` cuts it out of its Footnote block. */
export interface FlowNote {
  source: DotsBlock;
  text: string;
  /** The number the BOOK printed on it, or null when it printed none. */
  printed: number | null;
  /**
   * WHICH NOTE OF ITS OWN BLOCK THIS IS, counted from 0 — the note's identity,
   * as a decision spells it.
   *
   * `splitNotes` cuts one banked Footnote answer into as many notes as the page
   * printed under its rule, so `source` alone names all of them and nothing
   * outside this function could tell the third from the fourth. This index is
   * that name: it is deterministic from the same bank (the split is a pure
   * function of the block's text), it is stable across a re-cast, and it is what
   * `data-bf-note` writes into the book and what an overlay's `note` target
   * points at.
   *
   * NOT `printed`, deliberately. The number on the paper can be missing
   * altogether, restarts wherever the printer restarted it, and is stripped
   * outright under `--strip-note-markers`. It is what a READER uses to find a
   * note and it is useless as a name.
   */
  ordinal: number;
}

/**
 * The flowing base: what the bank says the book is, before anybody writes a
 * file.
 *
 * Everything in here is a deterministic function of the banked answers and the
 * chapter list a person laid out. No rasters, no model, no clock, no I/O — the
 * same bank produces the same base on any machine, which is what makes it
 * something an editing surface can show and a transform can be keyed to.
 */
export interface FlowBook {
  /** The book, flowing. Empty for a bank with nothing readable in it. */
  blocks: FlowBlock[];
  /** The banked blocks the passes left, flat and in reading order. */
  sourceBlocks: DotsBlock[];
  /** Every note in the book, in order — the apparatus, collected once. */
  notes: FlowNote[];
  /** Where the rules WOULD open a section. Indices into `sourceBlocks`. */
  proposals: DotsChapterProposal[];
  /** Where the book actually divides, after the fold. Indices into `blocks`. */
  starts: number[];
  /** The proposal that opened each start, or null for a leading span nothing named. */
  opens: (DotsChapterProposal | null)[];
  folded: DotsFold[];
  suppressedHeads: SuppressedHead[];
  mergedHeadings: DotsHeadingMerge[];
  /** The blocks whose print line breaks were reflowed back into prose. */
  reflowed: DotsBlock[];
  column: BodyColumn;
  lexicon: BookLexicon;
  typography: BookTypography | null;
  /**
   * The pages whose opening paragraph WOULD have been joined onto the previous
   * page's if this program still read ink, and now is not.
   *
   * The one behaviour this phase changes, counted so that it can be said out
   * loud. See `reflowBook` for what it costs and who pays it.
   */
  unjoinedTurns: number[];
}

export interface FlowBookOptions {
  /** In page order. MUTATED, like every pass this is made of. */
  pages: readonly DotsParsedPage[];
  /**
   * A person's decisions. Only the CHAPTERS are read here — the strikes, the
   * categories and the text corrections were applied at the parse
   * (`convert.ts`), so by now they are simply what the blocks say.
   */
  overlay?: Overlay;
}

/**
 * THE BANK, MADE INTO A BOOK — every rule that turns pages into one, in one
 * pass, with nothing rendered.
 *
 * This is the prologue `buildDotsBook` used to run inline while it concatenated
 * XHTML, and the move is the point rather than a tidy-up. Interleaved with
 * string building, these rules were: impossible to show a person before a file
 * existed; written a second time by hand in `detectChapters` so that the app
 * could seed a chapter list without emitting a book, and kept in step by an
 * assertion; and lossy, because the join was performed on rendered markup and
 * the continuation block never reached the stamper. All three were one defect —
 * the book's structure had no existence apart from the file that carried it.
 * It has one now, and the emitter, the chapter seed and everything phase B and
 * after will ask are readers of the same answer.
 *
 * THE ORDER OF THE PASSES IS A CONSTRAINT AND NOT A STYLE, and two of them are
 * load-bearing:
 *
 *  - `suppressRunningHeads` and `mergeAdjacentHeadings` run FIRST, before the
 *    blocks are flattened. Both measure type, `lineHeight` counts a block's
 *    lines off the newlines the model kept, and dehyphenation and the reflow
 *    take those newlines away. Measured afterwards, a five-line paragraph reads
 *    as one line in a five-line box and the book's body type comes out five
 *    times its real size.
 *  - the type is measured immediately after the flatten and BEFORE a character
 *    is rewritten, and carried forward in a map keyed by block identity — which
 *    is why nothing here may copy a block.
 *
 * THE PAGE TURN IS RESOLVED HERE, LAST, and it is resolved on the bank alone.
 * The textual test is `continuesTextually` — the previous paragraph did not end
 * on terminal punctuation and this one opens lowercase — plus the hyphen carry.
 * When neither fires the two paragraphs stay two paragraphs. There used to be a
 * third test that measured the page's ink, and `DotsPageImages` above says why
 * it is gone.
 *
 * KNOW WHAT THAT COSTS IN A CASELESS SCRIPT. `continuesTextually` ends in
 * `first !== first.toUpperCase()`, which is true of a lowercase letter and
 * false of a digit, a quotation mark, and EVERY CHARACTER IN A SCRIPT THAT HAS
 * NO CASE — Chinese, Japanese, Arabic, Hebrew. Such a book joined nothing on
 * the words and reached the ink for every page turn in it, so with the ink gone
 * it joins nothing automatically at all and every turn is a manual join. That
 * is the honest price of the ruling, it is accepted, and `unjoinedTurns` counts
 * it so the run can say the number out loud rather than let somebody discover
 * three hundred seams and read them as a defect. The fix is a person joining
 * them on the flowing page, where they can see what they are joining; the
 * eventual fix is a bank-only signal for caseless scripts, which is a question
 * to ask the model AT READING TIME and never a reason to sample a pixel here.
 *
 * A JOIN NEVER CROSSES A SECTION BOUNDARY, which is why the sections are
 * proposed and folded before the paragraphs are joined rather than after. A
 * chapter opens where the rules say it opens, and a paragraph that reached
 * across that line would put the end of one chapter inside the beginning of the
 * next — and would do it in the one place a reader is least able to tell that
 * something went wrong.
 */
export function reflowBook(opts: FlowBookOptions): FlowBook {
  const suppressedHeads = suppressRunningHeads(opts.pages);
  const mergedHeadings = mergeAdjacentHeadings(opts.pages);

  // PAGINATION STOPS BEING STRUCTURE HERE. From this line on a page number is
  // a fact about where a block came from, and nothing about where it goes.
  const sourceBlocks = opts.pages.flatMap((p) => p.blocks);
  /*
   * A BOOK WITH NOTHING IN IT IS ANSWERED HERE AND NOT REFUSED HERE.
   *
   * Every measurement below needs a block to measure — the body column needs a
   * page width and a page width lives on a block — and there is no honest value
   * for any of them. So the empty answer is returned as an empty answer, and
   * what to DO about it belongs to the caller: `detectChapters` proposes no
   * chapters, which is correct and quiet, and `buildDotsBook` stops the run,
   * because a book that was asked for and has no words in it is a failure and
   * an empty EPUB is the worst possible way to report one.
   */
  if (sourceBlocks.length === 0) {
    return {
      blocks: [],
      sourceBlocks,
      notes: [],
      proposals: [],
      starts: [],
      opens: [],
      folded: [],
      suppressedHeads,
      mergedHeadings,
      reflowed: [],
      column: { x1: 0, x2: 0 },
      lexicon: new BookLexicon([]),
      typography: null,
      unjoinedTurns: [],
    };
  }
  const measured = measureTypeSizes(sourceBlocks);

  // The lexicon is built from the text as the model wrote it, hyphens and all:
  // a compound that appears mid-line anywhere in the book is the evidence that
  // decides every line-broken instance of it (`BookLexicon`).
  const lexicon = new BookLexicon(sourceBlocks.map((b) => b.text));
  for (const block of sourceBlocks) {
    if (block.text.includes('-\n')) block.text = lexicon.dehyphenate(block.text);
  }
  const reflowed = reflowWrappedProse(sourceBlocks);

  // Read off the measurements above, and after the rewriting, so that the
  // snippet naming an outlier in the report reads the way the book reads.
  const typography = deriveTypography(sourceBlocks, measured);
  const column = bodyColumn(sourceBlocks, sourceBlocks[0].pageWidth);

  const proposals = proposeSections(opts.pages, opts.overlay ?? emptyOverlay());

  // The leading span, when the book does not open on a section start. It has no
  // proposal behind it and therefore no kind: nothing said what it is.
  const opens: (DotsChapterProposal | null)[] = [...proposals];
  const starts = proposals.map((p) => p.index);
  if (starts.length === 0 || starts[0] !== 0) {
    starts.unshift(0);
    opens.unshift(null);
  }
  /*
   * The book printed its own opening twice, and the second copy is not a
   * section. Folded HERE, between the starts and the spans, because the rule
   * needs both: a proposal's index says where a section would begin, and only
   * the span it would cover says whether anything in it is the reader's. The
   * fold edits `starts` and `opens` in place, so the spans below are the ones
   * the book actually gets.
   *
   * `proposals` is deliberately left alone. It is the list of places the rules
   * WOULD open a section, which is what the picker curates and what
   * `writeProposals` documents it as; the fold is a decision taken after it,
   * and it is recorded as one in `folded`.
   *
   * NOT WHEN THE SPINE WAS LAID OUT. The fold is a rule about a book whose
   * sections were inferred — it catches the opening the printer set twice and
   * the proposal that came with it — and a listed spine has no inferred
   * sections in it at all. Folding one away would be this file deleting a
   * chapter somebody wrote down, which is the one thing a definitive list must
   * be safe from.
   */
  const folded = opts.overlay?.chapters !== undefined
    ? []
    : foldDuplicateSections(sourceBlocks, starts, opens);

  const flow = flowBlocks(sourceBlocks, new Set(starts), column, lexicon);
  return {
    blocks: flow.blocks,
    sourceBlocks,
    notes: collectNotes(flow.blocks),
    proposals,
    // Into the flowing list, which is shorter than the banked one by exactly the
    // number of paragraphs that swallowed a page turn. A section start is a
    // heading or the first block of a page that carries something, and neither
    // is ever a continuation, so every one of them still names a block.
    starts: starts.map((start) => flow.flowIndexOf[start]),
    opens,
    folded,
    suppressedHeads,
    mergedHeadings,
    reflowed,
    column,
    lexicon,
    typography,
    unjoinedTurns: flow.unjoinedTurns,
  };
}

/**
 * The blocks, joined into paragraphs — the last pass, and the only one that
 * changes how many blocks a book has.
 *
 * WHICH BLOCKS MAY JOIN is exactly what the emitter used to decide while it
 * wrote `<p>`s, kept here verbatim because the contract of this phase is that
 * the finished book does not change: the previous element must have been a
 * paragraph and nothing may have closed it; this block must sit at column width
 * (`alignmentClass` empty — a centered epigraph that happens to open lowercase
 * is not a continuation of anything); and the two must `adjoin`.
 *
 * A FOOTNOTE DOES NOT CLOSE A PARAGRAPH, which looks like an oversight and is
 * not. Its block is held back to the end of the chapter and writes nothing
 * where it stands, so a page whose prose is interrupted by the note at its own
 * foot still has one paragraph running through it — which is what the printed
 * page has.
 */
export function flowBlocks(
  blocks: readonly DotsBlock[],
  starts: ReadonlySet<number>,
  column: BodyColumn,
  lexicon: BookLexicon,
): { blocks: FlowBlock[]; flowIndexOf: number[]; unjoinedTurns: number[] } {
  const out: FlowBlock[] = [];
  const flowIndexOf: number[] = [];
  const unjoinedTurns: number[] = [];

  /** The paragraph a continuation could still join, or null. */
  let open: FlowBlock | null = null;
  /** The last Text block seen, which is what `adjoins` is asked about. */
  let previous: DotsBlock | null = null;

  const opened = (block: DotsBlock): FlowBlock => {
    const flow: FlowBlock = {
      parts: [{
        block,
        page: block.page,
        order: block.order,
        part: block.part,
        join: 'opens',
        fused: null,
        text: block.text,
      }],
      category: block.category,
      text: block.text,
      source: block,
    };
    out.push(flow);
    return flow;
  };

  for (const [index, block] of blocks.entries()) {
    // A section boundary closes whatever was open. See `reflowBook`.
    if (starts.has(index)) {
      open = null;
      previous = null;
    }

    // Held back to the end of the chapter, and it writes nothing here, so it
    // does not interrupt the paragraph it sits in the middle of.
    if (block.category === 'Footnote') {
      flowIndexOf[index] = out.length;
      opened(block);
      continue;
    }
    if (!JOINABLE.has(block.category)) {
      flowIndexOf[index] = out.length;
      open = null;
      opened(block);
      continue;
    }

    let joined = false;
    if (open !== null && alignmentClass(block.box, column) === '' && adjoins(previous, block)) {
      joined = continuesTextually(open.text, block.text);
      /*
       * WHERE THE INK USED TO BE ASKED, and now nothing is. The words said no
       * about a paragraph that runs over a page turn, which is the one case
       * `carriesOver` existed for; the two halves stay two paragraphs and the
       * run says how often that happened. Counted only across a TURN, because
       * that is the only place the old test was ever consulted — two blocks on
       * one page that the words do not join are two paragraphs the printer set
       * as two, and there was never a question about them.
       */
      if (!joined && previous !== null && block.page !== previous.page) {
        unjoinedTurns.push(block.page);
      }
    }

    if (joined && open !== null) {
      const join = resolveJoin(open.text, block.text, lexicon);
      const last = open.parts[open.parts.length - 1];
      // What `opening` took off the end of the paragraph came off the end of
      // its LAST part — the broken word was there, and so was any space after
      // it. Taking it off the part rather than off the whole is what lets the
      // emitter render each part on its own and still write the fused word once.
      last.text = last.text.slice(0, last.text.length - (open.text.length - join.opening.length));
      open.parts.push({
        block,
        page: block.page,
        order: block.order,
        part: block.part,
        join: join.fused === null ? 'space' : 'fused',
        fused: join.fused,
        text: join.rest,
      });
      open.text = joinedText(join);
      flowIndexOf[index] = out.length - 1;
    } else {
      flowIndexOf[index] = out.length;
      open = opened(block);
    }
    previous = block;
  }

  return { blocks: out, flowIndexOf, unjoinedTurns };
}

/**
 * The categories a paragraph join may ever be about.
 *
 * `default:` in the emitter's switch, written out: Text, and the two furniture
 * categories, which reach a book only when a person reclassified a block into
 * one (`overlay.ts` accepts every category the model has a name for). Nothing
 * else can continue a paragraph, and everything else closes the one before it.
 */
const JOINABLE: ReadonlySet<DotsCategory> =
  new Set<DotsCategory>(['Text', 'Page-header', 'Page-footer']);

/**
 * Every note in the book, in the order the pages carried them.
 *
 * ONE IMPLEMENTATION, TWO READERS. The base holds the whole book's apparatus
 * because a transform and an editing surface both need it as data; the emitter
 * asks the same question of one chapter's span, because a note's element id and
 * its backlink are per-book running numbers it mints as it writes. Splitting a
 * Footnote block into its notes is the part that must not be done twice — the
 * split is where "one note nobody can see the start of" is decided.
 */
export function collectNotes(blocks: readonly FlowBlock[]): FlowNote[] {
  const notes: FlowNote[] = [];
  for (const block of blocks) {
    if (block.category !== 'Footnote') continue;
    /*
     * THE ORDINAL IS THE SPLIT'S OWN INDEX, which is why it is taken here and
     * nowhere else. This is the one implementation of the split (the header
     * above says why it must stay that way), so it is the one place that can
     * answer "which note of its block is this" — and every reader of a note,
     * the emitter included, gets the same answer without recomputing it.
     */
    for (const [ordinal, text] of splitNotes(block.text).entries()) {
      const lead = LEADING_SUPERSCRIPT.exec(text);
      notes.push({
        source: block.source,
        text,
        printed: lead ? printedNumber(lead[0]) : null,
        ordinal,
      });
    }
  }
  return notes;
}

/** Where the rules would divide a book, and what they would call each division. */
export interface DetectedChapter {
  page: number;
  order: number;
  part: number;
  /** The name this section would carry in the contents. */
  title: string;
}

/**
 * THE SPINE THIS ENGINE WOULD BUILD, worked out without building the book.
 *
 * It exists so that an app can seed a chapter list with EXACTLY what a run
 * without one would do — the seed and the render must never disagree, or the
 * first thing a person does after opening the editor is silently change their
 * book.
 *
 * IT USED TO BE A HAND-COPIED REPLAY OF `buildDotsBook`'s first passes, in the
 * same order, kept in step with the original by an assertion and by whoever
 * remembered to edit both. It could not be anything else: the rules only
 * existed inside a function that wrote an EPUB, so running them without writing
 * one meant writing them again. `reflowBook` is where they live now, and this
 * is what it always wanted to be — one line asking the pass for its answer, and
 * the label of each division read off it. The two agreeing is no longer a
 * coincidence somebody maintains.
 *
 * IT MUTATES THE PAGES, like the passes it is made of. Hand it pages nothing
 * else is going to render from — `blocks-dump.ts` parses the bank a second time
 * for it, which is arithmetic over answers that are already in memory.
 *
 * The leading span is not in the list. A book whose first block is not a chapter
 * start has front matter in front of it, and front matter is what is left over
 * rather than a chapter somebody named.
 */
export function detectChapters(pages: readonly DotsParsedPage[]): DetectedChapter[] {
  const flow = reflowBook({ pages });
  if (flow.blocks.length === 0) return [];

  const detected: DetectedChapter[] = [];
  for (const [i, start] of flow.starts.entries()) {
    const proposal = flow.opens[i];
    if (proposal === null) continue;
    const block = flow.blocks[start];
    if (block === undefined) continue;
    const span = flow.blocks.slice(start, flow.starts[i + 1] ?? flow.blocks.length);
    // The label in the order `buildDotsBook` settles it: the classifier's
    // composed name, then the section's own first heading, then the honest name
    // for the kind, then the position. `sectionName` is the first two, and it is
    // the same function the fold compares nav entries with.
    const title = sectionName(span, proposal)
      || KIND_LABEL[proposal.kind ?? 'chapter']
      || `Chapter ${i + 1}`;
    detected.push({
      page: block.source.page,
      order: block.source.order,
      part: block.source.part,
      title,
    });
  }
  return detected;
}

export interface DotsBookOptions {
  metadata: VlmEpubMetadata;
  /** In page order. */
  pages: readonly DotsParsedPage[];
  images: DotsPageImages;
  stripNoteMarkers: boolean;
  /**
   * How the finished documents get written down — see `text-out.ts`.
   *
   * It is read on the LAST line of `buildDotsBook` and nowhere before it. Every
   * measurement in this file — the body column, the page-turn join, the note
   * matching, the picture crops — happens identically whichever way the answer
   * is written out, which is what makes `--format` a choice about the file
   * rather than a second pipeline.
   */
  format?: VlmOutputFormat;
  /**
   * A person's decisions — `overlay.ts`. By the time the pages reach here the
   * strikes, the categories and the text corrections have ALREADY been applied
   * to them (`convert.ts` applies them once, at the parse).
   *
   * What is left for this file is the other list: the CHAPTERS, which are about
   * the book rather than about any block, and which can only be read where the
   * book decides where it divides (`proposeSections`). Absent, or present with
   * no chapter list in it, means the book is assembled exactly as it was before
   * overlays existed.
   */
  overlay?: Overlay;
  /**
   * ── THE CAST AND THE EDITION ARE TWO DIFFERENT BOOKS ────────────────────────
   *
   * Off, which is what every caller but an export passes, and the whole of what
   * off means is that this file writes what it has always written, byte for
   * byte. The flag is `vlm-convert --final`, and `src/commands.ts` carries the
   * distinction in full at its declaration.
   *
   * In one sentence: `generated/` is a WORKBENCH and keeps its marks, and
   * anything that lands in `final/` is an EDITION. A struck note in the cast is
   * an aside wearing `data-bf-cut="1"` — visible, struck through on the flowing
   * page, brought back by pressing Delete on it again — because the person
   * curating has to see what they decided. In the edition it is not there at
   * all, its reference number keeps the digit the page printed and loses its
   * link, a chapter that lost every note loses its footnotes section too, and
   * the attributes that exist so this app can address an element
   * (`data-bf-id`, `data-bf-src`, `data-bf-note`, `data-bf-cut`) are not
   * written. `data-bf-page` and `data-bf-cat` stay — `epub-final`'s ruling
   * unchanged, because page provenance is what makes a scan citable.
   *
   * WHY IT IS HERE AND NOT A PASS OVER THE FINISHED FILE. `epub-final` already
   * does all of this to an EPUB and keeps doing it — that is the route for a
   * book that has already been built (the app's Save-As and the
   * translate-descended export both run it). But `--format txt` never becomes an
   * EPUB: it is the same documents tag-stripped (`packageVlmText`), so a struck
   * note removed from the zip afterwards is still a paragraph of text in the
   * plain-text export. Removal at assembly is the only place that fixes both
   * formats at once, and it is upstream of the format fork by construction.
   */
  final?: boolean;
  /**
   * ── A TRANSFORM'S ANSWERS, KEYED BY POSITION — `vlm-convert --records` ──────
   *
   * `position → words`, where a position is `data-bf-src`'s own spelling
   * (`page:order[:part]`, space-joined for a paragraph the reflow made out of
   * two pages' blocks, plus `#note` for one note of a Footnote block) and the
   * words are one flowing block's text in a language somebody asked for. The
   * file it is read out of is `src/translate/records.ts`, which carries the
   * format; the map arrives here already resolved to the newest row per
   * position, because the emitter has no business knowing that the file appends.
   *
   * WHY MATERIALIZATION AND NOT A SECOND BOOK. `translate` used to produce an
   * EPUB, which made the translated edition a FILE rather than a rendering — so
   * striking a paragraph out of it, correcting a sentence of it, or casting it
   * as plain text each needed the whole pipeline re-implemented over markup.
   * Records make the translation a set of ANSWERS, and this flag is where they
   * become a book: the same reflow, the same chapters, the same curation, the
   * same edition rules, the same format fork, with different words in the blocks.
   *
   * THE THREE THINGS IT COMPOSES WITH, each load-bearing:
   *
   *  - `final`. An exported translation is cast with BOTH. Substitution never
   *    resurrects anything the edition removes: a struck block was dropped at
   *    the parse and is not in the flow at all, and a struck note has no
   *    `<aside>` under `--final`, so the record that would have supplied its
   *    words is never looked up. The editing stamps stay withheld.
   *  - `format: 'txt'`. The substitution happens while the documents are
   *    assembled, upstream of the format fork, so `packageVlmText` strips the
   *    tags off translated documents exactly as it strips them off source ones.
   *  - `metadata.language`. Records carry words and not a language declaration —
   *    guessing one from a file of sentences is exactly the inference this
   *    program refuses — so `dc:language` and every `xml:lang` come from
   *    `vlm-convert --language`, which is the app's `params.language` for the
   *    step (docs/WORKBENCH.md §10, ruling 4). The flag has always existed and
   *    always done that job; what changed is that it is now the ONLY place the
   *    language is said, because `translate` no longer retags a document it no
   *    longer writes.
   *
   * AND THE NAV COMES OUT TRANSLATED FOR NOTHING, which is the part that deletes
   * code rather than adding it. `relabelNav` (`src/translate/run.ts`) had to
   * PROVE a contents label was a copy of a heading — comparing the label against
   * that heading's text from before the translation — because it was editing a
   * finished nav document whose labels might have been hand-edited, and
   * inventing one there would put a different title in the contents than on the
   * chapter. Here the nav does not exist yet: it is minted from `body.label`,
   * read off the heading AFTER its words were substituted, so the contents and
   * the chapter say the same thing by construction and there is no before/after
   * comparison to make at all.
   *
   * ONE LIMIT, RECORDED RATHER THAN HIDDEN: a section whose contents label came
   * from the page CLASSIFIER rather than from its own heading — a part divider,
   * whose number and its name are two blocks and only `partVerdict` knows they
   * belong together — keeps that label in the source language, because it is
   * composed from block text before any substitution exists. Every ordinary
   * chapter takes its label from its first heading and comes out translated.
   *
   * Absent is a book made of its own words, byte for byte, which is what every
   * caller but an export passes.
   */
  records?: ReadonlyMap<string, string>;
}

export interface DotsBookResult {
  bytes: Uint8Array;
  chapters: VlmChapter[];
  /**
   * The cover, or the reason there is none — see `DotsCover`.
   *
   * NULL MEANS THE FORMAT HAS NO COVER, which is a different fact from a cover
   * that could not be cut and is why it is not folded into `why`. A plain-text
   * book has nowhere to put an image and nothing was attempted; a run whose
   * crop refused tried, failed, and owes somebody a sentence.
   */
  cover: DotsCover | null;
  proposals: DotsChapterProposal[];
  blocks: number;
  categories: Record<string, number>;
  footnotes: number;
  pictures: number;
  /** Pages whose opening paragraph was joined onto the previous page's. */
  joinedPages: number[];
  /**
   * The other half of that number: page turns where the paragraph MIGHT have
   * carried on and the bank does not say so, left as two paragraphs.
   *
   * Reported because it is the one thing about a converted book that changed
   * when the ink test died, and a change nobody can see is a change nobody can
   * correct. `reflowBook` has the argument; `commands.ts` says the number.
   */
  unjoinedTurns: number[];
  /**
   * The running heads the model mistagged, taken out of the book by
   * `suppressRunningHeads` — page, text and the evidence path that condemned
   * them, because a removal nobody can read is a removal nobody can check, and
   * a removal that does not say WHICH argument removed it cannot be argued
   * with.
   */
  suppressedHeads: { page: number; text: string; why: FurnitureEvidence }[];
  /**
   * The duplicated section openings folded back into the section above them by
   * `foldDuplicateSections`. Same promise as `suppressedHeads`: a document that
   * quietly stopped existing is a document nobody can ask about.
   */
  foldedSections: DotsFold[];
  /**
   * The headings the page printed on two lines and this run joined into one,
   * by `mergeAdjacentHeadings`. The same promise again, and the sharpest case
   * of it: this pass does not remove a heading, it WRITES one.
   */
  mergedHeadings: DotsHeadingMerge[];
  /**
   * What this book's own type measures — `typography.ts`, and null for a book
   * with no body prose in it to measure against.
   *
   * The stylesheet's `em` ratios and every inline size in the documents come
   * from here, so this is the record of a decision the finished EPUB otherwise
   * states without justifying.
   */
  typography: TypographyReport | null;
  /** Text blocks whose print line breaks were reflowed back into prose. */
  reflowedBlocks: number;
  lexiconWords: number;
  xhtmlSeconds: number;
  zipSeconds: number;
}

export async function buildDotsBook(opts: DotsBookOptions): Promise<DotsBookResult> {
  const started = Date.now();

  /*
   * THE WHOLE BOOK, WORKED OUT BEFORE A CHARACTER OF IT IS WRITTEN.
   *
   * Everything above this line used to be forty lines of prologue right here —
   * the suppression, the merge, the flatten, the measurement, the lexicon, the
   * dehyphenation, the reflow, the proposals and the fold, in that exact order,
   * with the order load-bearing and argued in comments that had to be read
   * inside a function whose job was to zip a file. `reflowBook` is that
   * prologue with a name and a return value, and the value is what makes the
   * difference: a person can be shown it, `detectChapters` can ask for it
   * instead of replaying it by hand, and a transform can be keyed to it. This
   * function's job is now what its name always said — building the book out of
   * an answer somebody else worked out.
   */
  const flow = reflowBook({
    pages: opts.pages,
    ...(opts.overlay !== undefined ? { overlay: opts.overlay } : {}),
  });
  const blocks = flow.sourceBlocks;
  if (blocks.length === 0) {
    throw new Error('no blocks survived the pages — there is no book to write');
  }
  const { column, typography, opens } = flow;
  const spans = flow.starts.map(
    (start, i) => [start, flow.starts[i + 1] ?? flow.blocks.length] as const,
  );

  const documents: VlmDocument[] = [];
  const chapters: VlmChapter[] = [];
  const crops: DotsCrop[] = [];
  const joinedPages: number[] = [];
  let notes = 1;
  /**
   * One counter for the whole book, because a page's blocks can land in two
   * chapters — see `DotsChapterOptions.elementNumbers`.
   */
  const elementNumbers = new Map<number, number>();
  /**
   * The answer elements the markdown pass cut up, over the WHOLE bank — see
   * `DotsChapterOptions.split`. Computed here for `elementNumbers`' reason: one
   * chapter cannot see the other half of a split that opened it.
   */
  const split = splitElements(blocks);

  for (const [index, [from, to]] of spans.entries()) {
    const span = flow.blocks.slice(from, to);
    const kind = opens[index]?.kind ?? null;
    const body = buildChapterBody(span, {
      column,
      stripNoteMarkers: opts.stripNoteMarkers,
      firstNote: notes,
      firstPicture: crops.length,
      elementNumbers,
      split,
      openers: openingHeadings(span, kind),
      ...(typography !== null ? { sizes: typography.sizes } : {}),
      // The strikes and the categories were applied at the parse; what is left
      // for the emitter is the one decision that could not be — a struck NOTE,
      // which had no existence until `splitNotes` ran. See
      // `DotsChapterOptions.overlay`.
      ...(opts.overlay !== undefined ? { overlay: opts.overlay } : {}),
      // Spread the same way, so a run that did not ask for an edition hands the
      // chapter builder the exact options object it always did.
      ...(opts.final === true ? { final: true } : {}),
      // And again for a transform's words. A cast with no records is handed the
      // options object it has always been handed — see `DotsBookOptions.records`.
      ...(opts.records !== undefined ? { records: opts.records } : {}),
    });
    notes += body.notes;
    crops.push(...body.crops);
    joinedPages.push(...body.joinedPages);

    const n = String(index + 1).padStart(4, '0');
    // EVERY PART'S PAGE, not just the block each paragraph opened at. A section
    // whose last paragraph swallowed the first block of the next page reaches
    // onto that page, and a `lastPage` that stopped at the opening block would
    // be a claim the reader can disprove by turning to it.
    const pages = span.flatMap((b) => b.parts.map((p) => p.page));
    const firstPage = Math.min(...pages);
    /*
     * The label, in the order of who actually knows it.
     *
     * The classifier's, when it composed one — a part's number and its name are
     * two blocks and only the classifier knows they belong together. Then the
     * section's own first heading, which is what every chapter has. Then the
     * kind, which is the honest name for a copyright page: it carries no
     * heading at all, and `Chapter 2` in the nav for it is worse than a
     * guess, it is the wrong word.
     */
    const label = opens[index]?.label ?? body.label ?? KIND_LABEL[kind ?? 'chapter']
      ?? `Chapter ${index + 1}`;
    const href = `text/c${n}.xhtml`;
    documents.push({
      id: `c${n}`,
      href,
      label,
      xhtml: XHTML_HEAD(label, opts.metadata.language)
        + stampKind(body.xhtml, kind, firstPage) + '\n' + XHTML_TAIL,
    });
    chapters.push({
      id: `c${n}`,
      href,
      label,
      // The BANKED blocks, for the same reason `pages` counts every part: this
      // is what the section is made of, and a paragraph made of two of them is
      // still two answers the model gave.
      blocks: span.reduce((sum, b) => sum + b.parts.length, 0),
      firstPage,
      lastPage: Math.max(...pages),
      ...(kind !== null ? { kind } : {}),
      ...(body.headings.length > 0 ? { headings: body.headings } : {}),
    });
  }

  /*
   * The pictures are cropped for the format that can hold one.
   *
   * A crop reaches back into the page renders through a subprocess, and its
   * entire product is a PNG inside the EPUB's container. A text book has no
   * container to put one in, so doing the work anyway would cost a run the
   * renders it had already finished with — and, worse, would let a text
   * conversion FAIL on a picture it was never going to carry.
   *
   * The report does not move. `crops` is how many pictures the book has, which
   * is the number the EPUB path reports too: the check below is precisely what
   * makes `resources.length` equal to it.
   */
  const wantsPictures = opts.format !== 'txt';
  const cropped = wantsPictures && crops.length > 0 ? await opts.images.crop(crops) : [];
  if (wantsPictures && cropped.length !== crops.length) {
    throw new Error(
      `${crops.length} pictures were asked for and ${cropped.length} came back. A figure missing`
      + ' from the container is a broken image in the reader, on a book that opened without an error.',
    );
  }
  const resources: VlmResource[] = cropped.map((image, index) => ({
    id: `img${index}`,
    href: `images/${image.name}`,
    mediaType: image.mediaType,
    data: image.data,
  }));

  /*
   * THE COVER IS THE FIRST PAGE THE BOOK ACTUALLY CONTAINS, RENDERED WHOLE.
   *
   * NOT LITERALLY PAGE 1, and the difference is the whole rule. `--skip-pages
   * 1-6` is an ordinary invocation — somebody opened the scan in a picker and
   * struck out the library wrapper, the blank leaf and the scanner's colour
   * card — and those pages are never rendered at all (`pages.ts`), so a cover
   * that demanded page 1 would fail on exactly the books a person curated. The
   * first page they KEPT is also the better picture: it is the title page, and
   * a title page is what a cover should be.
   *
   * `blocks[0]` and not `opts.pages[0]`, which is a second, smaller version of
   * the same argument. A page can survive the skip list and still carry
   * nothing — a genuinely blank leaf parses to a page with no blocks — and
   * cropping it would put a sheet of white paper on the shelf. The first page
   * with a block on it is the first page the book contains, which is what this
   * is. It also carries the only measurement available for the box: a block
   * knows its page's render size and a page does not.
   *
   * MECHANICALLY IT IS ONE MORE CROP through machinery that already exists —
   * the whole page as the box, cut out of the render that is already on disk.
   * Nothing new is rendered, decoded or resized.
   */
  const wantsCover = opts.format !== 'txt';
  let cover: DotsCover | null = null;
  let coverImage: VlmCover | undefined;
  if (wantsCover) {
    const first = blocks[0];
    /*
     * A SEPARATE CROP CALL FROM THE PICTURES, and the second subprocess is
     * bought deliberately. The two failures are not the same failure: a
     * picture that did not come back is a broken image in a book that opened
     * without an error, and the run above refuses over it; a cover that did
     * not come back is a grey thumbnail. Sharing the call would mean either
     * failing the book over the thumbnail or letting a missing figure through,
     * and both are worse than one more spawn per run.
     */
    try {
      const [image] = await opts.images.crop([{
        page: first.page,
        box: { x1: 0, y1: 0, x2: first.pageWidth, y2: first.pageHeight },
        name: COVER_CROP_NAME,
      }]);
      if (image === undefined) {
        cover = {
          page: null,
          why: `nothing came back from cropping the whole of page ${first.page}`,
        };
      } else {
        coverImage = { href: `images/${image.name}`, mediaType: image.mediaType, data: image.data };
        cover = { page: first.page, why: null };
      }
    } catch (err) {
      /*
       * CAUGHT, WHICH ALMOST NOTHING IN THIS PROGRAM DOES, and the exception
       * is argued rather than assumed. ARCHITECTURE §8 refuses a fallback
       * because a quietly degraded BOOK ships unnoticed; a missing cover is
       * the one defect here that is neither quiet nor in the text — the reader
       * sees a grey rectangle, the run says which page it failed on, and every
       * word of the book is still there. A conversion is minutes of GPU, and
       * losing all of it to a failed thumbnail is the worse trade.
       */
      cover = {
        page: null,
        why: `page ${first.page} could not be cut out of its render `
          + `(${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  const categories: Record<string, number> = {};
  for (const block of blocks) categories[block.category] = (categories[block.category] ?? 0) + 1;

  const xhtmlSeconds = (Date.now() - started) / 1000;
  const packaged = opts.format === 'txt'
    ? packageVlmText(opts.metadata, documents)
    : packageVlmEpub(
      opts.metadata, documents, resources, dotsStylesheet(typography), navTree(chapters), coverImage,
    );
  return {
    bytes: packaged.bytes,
    chapters,
    cover,
    proposals: flow.proposals,
    blocks: blocks.length,
    categories,
    footnotes: notes - 1,
    // What the BOOK has, not what the container carried — the two are the same
    // number wherever there is a container, and a picture count that fell to
    // zero on a text run would be a report about the file rather than the book.
    pictures: crops.length,
    joinedPages,
    unjoinedTurns: flow.unjoinedTurns,
    suppressedHeads: flow.suppressedHeads.map((b) => ({ page: b.page, text: b.text, why: b.why })),
    foldedSections: flow.folded,
    mergedHeadings: flow.mergedHeadings,
    // The working map of per-block sizes stays out of the report: it is keyed
    // by block identity, which means nothing once the blocks are gone, and
    // everything a reader of the report wants about it is in `outliers`.
    typography: typography === null
      ? null
      : { bodyPx: typography.bodyPx, categories: typography.categories, outliers: typography.outliers },
    reflowedBlocks: flow.reflowed.length,
    lexiconWords: flow.lexicon.size,
    xhtmlSeconds,
    zipSeconds: packaged.zipSeconds,
  };
}
