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
 *  - **No cover.** One used to be cut here — the first page the book contained,
 *    rendered whole — and the user ended it after meeting an English scan image
 *    at the front of a German translation: *"dont infer what the book cover
 *    might be."* Which page a printer meant as the front is not a thing this
 *    file can know, and a guess is wrong silently. `packageVlmEpub` carries the
 *    ruling in full.
 *  - **A HEADING THE PAGE PRINTED ON TWO LINES IS ONE HEADING.** `II` on one
 *    line and `The Price of Judgment` on the next are two boxes because they
 *    ARE two boxes, and the book means one thing; anything handed both of them
 *    says it twice — two `<h1>`s, two anchors, two nav entries, and a contents
 *    that reads `II` for a chapter that has a name. `mergeAdjacentHeadings`
 *    joins them before any of that happens, on three guards that are pure
 *    arithmetic on the boxes, and reports every join: it is the only pass here
 *    that WRITES copy rather than moving or dropping it.
 *  - **THE BOOK'S OWN CONTENTS PAGE IS EVIDENCE ABOUT THE BOOK.** dots calls a
 *    chapter opening a Title on one page and a Section-header on the next, of
 *    the same book, and Section-header is also what it correctly calls the
 *    hundreds of sub-headings inside a chapter — so the proposal list is right
 *    and unusable, and a person has to open every one of them to decide a
 *    question the book answered on page v. `promoteListedHeadings` flips a
 *    Section-header to a Title when it opens its page AND the detected contents
 *    lists it; sub-headings the contents also lists are not flipped, because
 *    what tells them apart is not the words — they are in the same list — but
 *    that a chapter opens a page and a sub-section sits in the middle of one.
 *    It never demotes anything, which keeps the asymmetry below intact.
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
  contentsEntryLines,
  contentsEntryTitle,
  continuesTextually,
  CONTENTS_ENTRIES,
  dotsInline,
  entryShapedLines,
  leadingWord,
  plainText,
  ROMAN_NUMERAL,
  SUPERSCRIPT_RUN,
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
  packageVlmHtml,
  XHTML_HEAD,
  XHTML_TAIL,
  type VlmChapter,
  type VlmDocument,
  type VlmSidecar,
  type VlmEpubMetadata,
  type VlmNavItem,
  type VlmResource,
} from './epub.js';
import {
  categoryDecisionFor,
  chapterStarts,
  emptyOverlay,
  joinDecisionFor,
  noteStruck,
  type Overlay,
} from './overlay.js';
import { packageVlmText, type VlmOutputFormat } from './text-out.js';
import {
  bodyTypeSize,
  deriveTypography,
  measureTypeSizes,
  typeSize,
  typeSizeIsMeasured,
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
 * What is left is CROPS, which are a different job entirely: a Picture is pixels
 * by definition, and cutting one out of a render is not an inference about
 * anything.
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
 * WHERE ON ITS PAGE A CHAPTER OPENS, and how long its name may be.
 *
 * Two numbers `proposeChapters` used to spell inline, named because a second
 * pass now enforces the identical pair: `promoteListedHeadings` flips a heading
 * to a chapter opening, and a promotion the proposal rule would then refuse for
 * sitting too low or running too long is a category change with no consequence
 * and no explanation. One constant each, so the two rules cannot drift apart.
 *
 * 45% down the page is the body-side test for TOP-LEVEL, and it is the whole of
 * Owen's ruling (2026-08-25) about which listed headings are chapters: a
 * publisher's contents lists sub-sections too, and what separates them from the
 * chapters is not the words — the words are in the same list — but the fact that
 * a chapter OPENS ITS PAGE and a listed sub-section sits in the middle of one,
 * under the prose that precedes it.
 */
const CHAPTER_TOP_FRACTION = 0.45;
/** A chapter's name is short. 80 characters is long for one and short for prose. */
const CHAPTER_CHARS = 80;

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
 *
 * `listed` is the book's OWN list of its chapters, keyed (`readContentsList`).
 * It adds no gate and takes none away — it adds a line to `why`. Two things
 * follow from that and only two. A candidate the contents page names says so in
 * the report, which is what makes `promoteListedHeadings`' work readable
 * downstream instead of arriving as an unexplained `title-class`; and a heading
 * with NO other evidence — not chapter-ish, not centered, not a Title — clears
 * the `why.length > 0` bar on the strength of being in the book's own list,
 * which is better evidence than any of the three shapes above it.
 */
export function proposeChapters(
  blocks: readonly DotsBlock[],
  spokenFor: ReadonlySet<number> = new Set(),
  listed: ReadonlySet<string> = new Set(),
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
    if (topFraction(block) > CHAPTER_TOP_FRACTION) continue;
    if (block.text.length >= CHAPTER_CHARS) continue;
    if (sectionMarks && BARE_NUMBER.test(block.text.trim())) continue;

    const why: string[] = [];
    if (CHAPTERISH.test(block.text)) why.push('chapterish-text');
    if (block.category === 'Title') why.push('title-class');
    if (centerOffset(block) < 0.06) why.push('centered');
    if (listingKeys(block.text).some((key) => listed.has(key))) why.push('toc-listed');
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
 *
 * `listed` rides straight through to `proposeChapters` — see there for what it
 * does and, more importantly, for the two things it does not. It is passed in
 * rather than read here because `reflowBook` already asked the contents page
 * once, for `promoteListedHeadings`, and one run of one book must not ask "what
 * does the contents say" twice and risk two answers.
 */
export function proposeSections(
  pages: readonly DotsParsedPage[],
  overlay: Overlay = emptyOverlay(),
  listed: ReadonlySet<string> = new Set(),
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
  const chapters = proposeChapters(flat, spokenFor, listed);
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
 * Takes a category and a text and nothing else, because its callers hold
 * different kinds of block: the fold works over the banked blocks, where a
 * section's index is settled, and `detectChapters` and the book file's chapter
 * seed (`book-file.ts`) over the flowing ones. A heading is never joined onto
 * anything, so the spans answer this question identically — which is the point
 * rather than a coincidence.
 *
 * EXPORTED FOR THAT THIRD READER AND FOR NO OTHER REASON. The book file carries
 * a chapter seed the renderer opens with, and a seed that named its sections by
 * a rule of its own would be a second answer to a question this file already
 * answers — the failure `detectChapters`' own header describes, where the seed
 * and the render disagree and the first thing a person does after opening the
 * editor is silently change their book.
 */
export function sectionName(
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

// ── the heading the book's own contents lists ───────────────────────────────

/**
 * What the book's contents page says its chapters are called.
 *
 * `entries` maps every `listingKeys` spelling of each listed title to the line
 * it was read off, so a promotion can be reported with the evidence beside it
 * rather than as an assertion. `through` is the position in `pages` of the LAST
 * leaf of the contents, or -1 for a book that has none.
 */
export interface ContentsList {
  entries: Map<string, string>;
  through: number;
}

/**
 * Read the book's own list of its chapters.
 *
 * TWO KINDS OF PAGE GO INTO IT, and the second one is not a relaxation of the
 * first. A contents page proper is `contentsEntryLines` — the heading, and three
 * or more numbered lines — asked of every page, exactly as `classifyPage` asks
 * it. A CONTINUATION is the page immediately after one, carrying the same three
 * numbered lines and NO BODY PROSE, and it is accepted without a heading because
 * a printer setting a contents over two leaves does not repeat the word
 * `Contents` on the second one. Refusing it would drop the second half of the
 * list in precisely the books this pass is for: a book with a contents long
 * enough to run over a leaf is a book with a detailed contents, which is the
 * case that has the most chapters to find.
 *
 * The chain continues — a continuation is itself a leaf, so a third and fourth
 * page of the same list are read — and it stops at the first page after it that
 * either carries prose or has too few numbered lines, which is the page the
 * front matter goes back to being ordinary on.
 *
 * `carriesBodyProse` is the guard that makes the continuation safe. What it
 * excludes is the page of prose whose lines happen to end in numbers, and the
 * only real family of those is an index or a bibliography — neither of which
 * follows a contents page. A page with no paragraph on it and three lines
 * ending in folios is a list of something, and after a contents page it is the
 * rest of the contents.
 *
 * A KEY WITH NO LETTER IN IT IS DISCARDED, the same guard `suppressRunningHeads`
 * applies for the same reason: a contents line that is nothing but numbers is a
 * folio or a stray, `furnitureKey` collapses every digit run to `#`, and a key
 * of `#` would match every bare-numbered heading in the book at once.
 */
export function readContentsList(pages: readonly DotsParsedPage[]): ContentsList {
  const entries = new Map<string, string>();
  let through = -1;
  for (const [position, page] of pages.entries()) {
    const lines = contentsEntryLines(page.blocks)
      ?? (through === position - 1 && through >= 0 ? continuationEntries(page.blocks) : null);
    if (lines === null) continue;
    through = position;
    for (const line of lines) {
      for (const key of listingKeys(contentsEntryTitle(line))) {
        if (!/[A-Z]/.test(key)) continue;
        // The earlier line wins. A contents that lists two chapters whose names
        // reduce to one key is a book where the report cannot say which of them
        // matched, and the one nearer the top of the list is the better guess.
        if (!entries.has(key)) entries.set(key, line);
      }
    }
  }
  return { entries, through };
}

/**
 * The words a chapter is ANNOUNCED by, which are not the words it is called.
 *
 * `Chapter`, `Part`, `Book`, `Section` — the announcement, when the printer set
 * one — and then the number. Both are optional and both are stripped, because
 * the two sides of this match do not agree about either of them: a contents page
 * prints `II. The Price of Judgment 140` and the chapter's own page prints `II`
 * over `The Price of Judgment`, or the contents prints the title alone and the
 * page prints the numeral, or the reverse. The NAME is the part both of them
 * have, and it is the part being matched.
 *
 * The numeral test is `ROMAN_NUMERAL` and not a character class, for the reason
 * that regex is exported at all: `CIVIL` and `MILD` are made of I, V, X, L, C,
 * D and M, and a class would strip the first word off two real chapter titles.
 * Arabic is capped at three digits so that a chapter called `1918` keeps its
 * name.
 */
const LISTING_WORD = /^(chapter|part|book|section)$/i;
const LISTING_DIGITS = /^\d{1,3}[.:)]?$/;

function withoutListingNumber(text: string): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  let at = 0;
  if (at < words.length && LISTING_WORD.test(words[at].replace(/[.:)]$/, ''))) at += 1;
  if (at < words.length && (LISTING_DIGITS.test(words[at]) || ROMAN_NUMERAL.test(words[at]))) {
    at += 1;
  } else {
    // `Part Two`, `Book of Judges` — the word was the title's own first word.
    at = 0;
  }
  return words.slice(at).join(' ');
}

/**
 * Every key one heading may be listed under, best spelling first.
 *
 * The whole of it, and then the same thing with its announcement taken off.
 * TWO rather than one because the pass runs after `mergeAdjacentHeadings`, which
 * is the position that makes a two-line opening one string — and that string is
 * `II The Price of Judgment` while the contents entry is very often the title on
 * its own. Matching the whole string only would find nothing on exactly the
 * books whose chapters are numbered, which is most of them.
 *
 * Asked of BOTH sides, so the stripping cannot decide the match on its own: an
 * entry that carries a number and a heading that carries one match on their
 * full spellings, and one of each matches on the bare name. Keys with no letter
 * in them are the caller's to discard — see `readContentsList`.
 */
function listingKeys(text: string): string[] {
  const whole = furnitureKey(text);
  const bare = furnitureKey(withoutListingNumber(text));
  return bare.length > 0 && bare !== whole ? [whole, bare] : [whole];
}

/** The second leaf of a contents: the shape and the silence, and no heading. */
function continuationEntries(blocks: readonly DotsBlock[]): string[] | null {
  if (blocks.length === 0) return null;
  if (carriesBodyProse(blocks)) return null;
  const lines = entryShapedLines(blocks);
  return lines.length < CONTENTS_ENTRIES ? null : lines;
}

/**
 * A heading this pass promoted, and the line of the contents that promoted it.
 *
 * Reported for the reason every pass in this file reports: it CHANGES WHAT A
 * BLOCK IS, and a category that quietly became something else is a category
 * nobody can argue with. The entry is carried beside the heading because the
 * whole claim is that these two are the same chapter, and a report that stated
 * only the conclusion would be the one thing a person could not check.
 */
export interface PromotedHeading {
  page: number;
  /** The heading as the book prints it — newlines and all, if it was merged. */
  text: string;
  /** The contents line that matched it, folio included. */
  entry: string;
}

/**
 * THE BOOK'S OWN CONTENTS PAGE IS EVIDENCE ABOUT THE BOOK — Owen's ruling,
 * 2026-08-25 — and this is the pass that spends it.
 *
 * The problem it exists for: dots tags a chapter opening `Title` on some pages
 * and `Section-header` on others, of the same book, for no reason a person can
 * see from the page. `Section-header` is also what it correctly calls the
 * sub-headings INSIDE a chapter, of which a work of history has hundreds. So
 * the picker's list is right and unusable — every Section-header has to be
 * opened and judged by hand, one at a time, and the person doing it is deciding
 * a question the book already answered on page v.
 *
 * WHAT THIS PASS DOES NOT DO IS THE ARGUMENT FOR IT. It never demotes: a
 * heading the contents does not list loses NOTHING, keeps its category, and
 * still reaches `proposeChapters` on whatever evidence it always had. That is
 * this file's standing asymmetry (see the header, and `proposeChapters`) — a
 * false negative costs a chapter nobody can get back, a false positive costs a
 * click — and a rule that read a contents page as a closed list would invert it
 * on the first book whose contents omits its own preface.
 *
 * WHICH LISTED HEADINGS ARE CHAPTERS, given that a publisher's contents lists
 * sub-sections too: the test is POSITION ON THE BODY-SIDE PAGE, not the words.
 * A chapter opens its page — it is the first block on it, in the top 45%
 * (`CHAPTER_TOP_FRACTION`) — and a listed sub-section sits in the middle of a
 * page under the prose that precedes it. The contents page cannot tell the two
 * apart, because it prints them in the same list; the body page tells them
 * apart every time, and it is the body page this asks.
 *
 * So a Section-header becomes a Title when ALL of these hold, and the promotion
 * is the whole of the change:
 *
 *  - it is the FIRST BLOCK ON ITS PAGE, and its page is strictly after the last
 *    leaf of the contents. Before that line the block is inside the contents
 *    itself, where every line matches a contents entry by construction;
 *  - `topFraction` is at or under `CHAPTER_TOP_FRACTION` and its text is under
 *    `CHAPTER_CHARS` — `proposeChapters`' own gates, enforced here so that a
 *    promotion always survives into a proposal rather than changing a category
 *    for nothing;
 *  - one of its `listingKeys` is in the contents' key set and has a letter in
 *    it — the heading whole, or the heading with its chapter number taken off;
 *  - NO PERSON HAS STATED A CATEGORY FOR IT (`categoryDecisionFor`). Layer 3 of
 *    `resolveCategory` is on top by construction and a machine pass does not get
 *    to out-vote it — somebody who looked at the page and called this a
 *    Section-header has better evidence than a match against a list.
 *
 * `Title` rather than a flag, because `Title` is what the rest of the program
 * already means by "a chapter opens here": `proposeChapters` reads it as
 * `title-class`, and `DERIVED_RULES` renders it `h1` instead of `h2`. Both
 * consequences are intended — a chapter opening set as a sub-heading is exactly
 * as wrong in the finished book as it is in the picker.
 *
 * IT RUNS WHETHER OR NOT THE SPINE WAS LAID OUT, and that is deliberate. This is
 * a deterministic function of the bank and the recorded category decisions, so
 * the book a person laid a spine over is byte-for-byte the book they laid it
 * over yesterday. It does not touch the spine's supremacy over where sections
 * START — `proposeSections` returns a listed spine before any rule of its own
 * runs, and that is untouched here.
 *
 * Mutates the blocks in place, like `suppressRunningHeads` and
 * `mergeAdjacentHeadings` above: the type measurements are keyed by block
 * identity, so nothing here may copy one.
 */
export function promoteListedHeadings(
  pages: readonly DotsParsedPage[],
  overlay: Overlay = emptyOverlay(),
  contents: ContentsList = readContentsList(pages),
): PromotedHeading[] {
  const promoted: PromotedHeading[] = [];
  if (contents.entries.size === 0) return promoted;
  for (const [position, page] of pages.entries()) {
    if (position <= contents.through) continue;
    const first = page.blocks[0];
    if (first === undefined || first.category !== 'Section-header') continue;
    if (topFraction(first) > CHAPTER_TOP_FRACTION) continue;
    if (first.text.length >= CHAPTER_CHARS) continue;
    const entry = listingKeys(first.text)
      .filter((key) => /[A-Z]/.test(key))
      .map((key) => contents.entries.get(key))
      .find((hit) => hit !== undefined);
    if (entry === undefined) continue;
    if (categoryDecisionFor(overlay, first) !== undefined) continue;
    first.category = 'Title';
    promoted.push({ page: first.page, text: first.text, entry });
  }
  return promoted;
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

/**
 * `…the more pow-*` → `…the more* pow-`: an emphasis run the model closed AFTER
 * the hyphen the column broke a word on, closed before it instead.
 *
 * See the call in `flowBlocks` for the measured case and for why the marker
 * moves rather than goes. Anchored at the end and nowhere else — this is about
 * the one character where a page ended, and a hyphen anywhere else in the block
 * was fused by the lexicon long before this runs.
 */
const BREAK_BEHIND_EMPHASIS = /(\s)([A-Za-zÀ-ÿ]+-)([*_]+)$/;
export function closeEmphasisBeforeBreak(text: string): string {
  return text.replace(BREAK_BEHIND_EMPHASIS, '$3$1$2');
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
 * What `data-bf-cat` says about a block of this category — the model's own
 * vocabulary, lower-cased.
 *
 * EXPORTED FOR THE SECOND WRITER. `vlm-compile` builds an edition out of a BOOK
 * FILE rather than out of a bank (`compile.ts`), and the attribute a reader of
 * that book selects on has to be the same string this emitter writes or the two
 * products of one program disagree about what a footnote is called. One table,
 * two writers.
 */
export function categoryAttribute(category: DotsCategory): string {
  return CATEGORY_ATTRIBUTE[category] ?? category.toLowerCase();
}

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
export const KIND_LABEL: Partial<Record<DotsPageKind, string>> = {
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

/**
 * The attributes an element wears, as the caller composed them.
 *
 * A STRING AND NOT A MAP, because what goes in here is already spelled: the
 * alignment class, the heading's anchor, and the stamps, each written by the one
 * function that knows the fact it states. Re-parsing them into a map so that this
 * could re-serialise them would be a second spelling of markup that is already
 * correct.
 */
export interface BlockAttributes {
  /** Everything after the tag name of the OUTER element. */
  outer: string;
  /** The same, for the child element the nesting categories write. */
  inner?: string;
}

/**
 * ONE BLOCK, AS ONE ELEMENT — the category→element switch, in one place.
 *
 * ── Why this is a function and not the emitter's inline switch ──────────────
 *
 * There are two writers of this book now. `buildChapterBody` below writes it out
 * of the BANK, which is what a conversion does; `vlm-compile` (src/vlm/compile.ts)
 * writes it out of a BOOK FILE, which is what an export does once a person has
 * edited one. Both are answering the same question — which element does a Quote
 * take, does a Picture carry its caption, is a table wrapped — and a second copy
 * of the answer is a book whose exported edition differs from its cast in ways
 * nobody decided. So the answer is here, once, and both callers ask it.
 *
 * WHAT IT DOES NOT DECIDE, deliberately: the attributes (the caller stamps what
 * it knows), the CONTENT (the caller renders it, through `dotsInline`, with its
 * own page marker in front where one is owed), and the `<ul>`/`<ol>` a run of
 * list items sits inside — that is state across blocks rather than a fact about
 * one, and it belongs in the loop that has the run in hand.
 */
export function blockElement(
  category: DotsCategory,
  attrs: BlockAttributes,
  /** Already rendered: the page marker, then the inline markup of the words. */
  content: string,
  /** Picture rows only: the file the figure was cut to, and the page it was on. */
  figure?: { name: string; page: number },
): string {
  switch (category) {
    // Indented because a list item sits inside the `<ul>` its caller opened, and
    // the two writers must not disagree about the shape of a book's list.
    case 'List-item':
      return `  <li${attrs.outer}>${content}</li>`;
    case 'Title':
      return `<h1${attrs.outer}>${content}</h1>`;
    case 'Section-header':
      return `<h2${attrs.outer}>${content}</h2>`;
    case 'Quote':
      return `<blockquote${attrs.outer}><p${attrs.inner ?? ''}>${content}</p></blockquote>`;
    case 'Table':
      return `<div class="tablewrap"${attrs.outer}>${content}</div>`;
    case 'Formula':
      return `<p class="formula"${attrs.outer}>${content}</p>`;
    case 'Picture': {
      if (figure === undefined) {
        // Unreachable from either writer — both resolve the figure before they
        // ask for the element, because a `<figure>` with no picture in it is a
        // gap on the page and neither of them has a rule for making one.
        throw new Error('a Picture block reached the emitter with no figure to put in it');
      }
      return `<figure${attrs.outer}>${content}`
        + `<img src="../images/${figure.name}" alt="figure from page ${figure.page}"/></figure>`;
    }
    case 'Caption':
      return `<p class="caption"${attrs.outer}>${content}</p>`;
    default:
      return `<p${attrs.outer}>${content}</p>`;
  }
}

/** The id of the FIRST marker that claimed a note — where its backlink aims. */
export function noteRefId(seq: number): string {
  return `ref-fn${seq}`;
}

/**
 * A reference number in the prose, as a link to its note.
 *
 * Only the FIRST reference carries an id: ids are unique and a backlink can only
 * aim one place. A second marker for the same note still links forward.
 */
export function noteRefAnchor(seq: number, printed: number, id: string | null): string {
  return `<a${id === null ? '' : ` id="${id}"`} class="noteref" epub:type="noteref"`
    + ` role="doc-noteref" href="#fn${seq}"><sup>${printed}</sup></a>`;
}

/**
 * The number a note opens with — a backlink where some marker claimed it, and a
 * plain superscript where nothing did, because a link to nowhere teaches a reader
 * not to click the next one. Empty for a note the page printed no number on.
 */
export function noteNumber(printed: number | null, refId: string | null): string {
  if (printed === null) return '';
  return refId !== null
    ? `<a class="fn-back" epub:type="backlink" role="doc-backlink" href="#${refId}">`
      + `<sup>${printed}</sup></a> `
    : `<sup>${printed}</sup> `;
}

/**
 * One note at the foot of its chapter.
 *
 * An `<aside epub:type="footnote">` rather than a `<p>`: that is the element
 * reading systems recognise for pop-up notes, and it costs nothing to a reader
 * that renders it in place.
 */
export function noteAside(seq: number, attrs: string, body: string): string {
  return `<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn${seq}"`
    + `${attrs}>${body}</aside>`;
}

/** The chapter's apparatus, opened. A rule, then the notes. */
export const FOOTNOTES_OPEN = '<section class="footnotes" epub:type="footnotes">';
export const FOOTNOTES_RULE = '<hr/>';
export const FOOTNOTES_CLOSE = '</section>';

/**
 * The print-source page marker, the standard EPUB spelling of it — exported for
 * `vlm-compile`, which owes a book file's pages the same anchors.
 */
export function pageMarker(page: number): string {
  return pageBreak(page);
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
 * An ASCII note number at the head of a line: one to three digits, an optional
 * period, then a space. See `noteLeadOf` for why plain digits are admitted here
 * at all, and `splitNotes` for the sequence guard that keeps them from cutting
 * prose. Three digits because no real apparatus runs to a thousand and a
 * four-digit lead is a year — "1942 was the last…" must never read as note 1942.
 *
 * THE PERIOD IS A SPELLING OF THE SAME INK, and refusing it cost a book its
 * apparatus: evangelische-kirche prints "1. Die Bezeichnung…" — digit, period,
 * space — and a lead that demanded a bare space matched none of those notes, so
 * every one of them stood orphaned while its marker sat in the loose list. The
 * period rides in the capture so a caller slicing `run` off the head takes it
 * too; `parseInt` stops at it, so the printed value never sees it.
 */
const ASCII_NOTE_LEAD = /^(\d{1,3}\.?)[ \t]/;

/** A note's printed number as the page set it: the characters, and the value. */
export interface NoteLead {
  /** Exactly the characters the number was set in, so a caller can cut them off. */
  run: string;
  printed: number;
}

/**
 * The number at the head of a note's text — superscript, or plain digits — or
 * null where it printed none.
 *
 * PLAIN DIGITS ARE A TRANSCRIPTION OF THE SAME INK. The model is supposed to
 * answer a note's number as a superscript run, and usually does; measured on
 * the book in hand, three footnote areas of six came back with the numbers as
 * ordinary digits instead ("20 *Ibid.*…" for a printed ²⁰) — same page, same
 * ink, different spelling, varying run to run. Refusing the ASCII spelling
 * cost those pages their entire apparatus: the block never split, the notes
 * never matched their markers, and nineteen linking flags stood where zero
 * belonged. The number is the book's fact, not the model's formatting, so
 * both spellings of it are read here — in ONE place, because the splitter,
 * the marker match and the emitter all ask what a note's number is, and two
 * answers to that question is how an apparatus falls apart.
 */
export function noteLeadOf(text: string): NoteLead | null {
  const sup = LEADING_SUPERSCRIPT.exec(text);
  if (sup !== null) return { run: sup[0], printed: printedNumber(sup[0]) };
  const ascii = ASCII_NOTE_LEAD.exec(text);
  if (ascii !== null) return { run: ascii[1]!, printed: Number.parseInt(ascii[1]!, 10) };
  return null;
}

/**
 * The number the BOOK printed on a note, read off the note's own first
 * characters — or null where it printed none.
 *
 * ONE IMPLEMENTATION, TWO READERS, and the second one is why it is a function
 * at all. `collectNotes` has always taken this here; the book file takes it
 * again, over a note ROW, because a reference marker in the prose can only be
 * matched to a note by the number the page set on both of them. Two readings of
 * "which number is this note" that could drift apart would be two answers to
 * the question the whole match is, so there is one and both ask it.
 *
 * The run has to LEAD. A superscript in the middle of a note is a reference
 * inside the note's own prose — the same distinction `splitNotes` cuts on.
 */
export function printedNoteNumber(text: string): number | null {
  return noteLeadOf(text)?.printed ?? null;
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
        const first = note.refId === null;
        if (first) note.refId = noteRefId(note.seq);
        return noteRefAnchor(note.seq, printed, first ? note.refId : null);
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
    attribute: string = categoryAttribute(block.category),
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

  /**
   * A block that may be SEVERAL banked answers, written out part by part — the
   * whole of what is left of the page-turn join here.
   *
   * THE PAGE MARKER GOES INSIDE THE ELEMENT, at the seam, which is exactly where
   * the EPUB convention puts it and is the reason it is a span rather than an
   * attribute on the block. Its position is `parts`: the page turned where one
   * part ended and the next began, so the provenance list is not a lookup for
   * this, it IS this. And when a word was broken across the turn, the marker goes
   * BEFORE the whole word — a reader cannot be given half a word on either side
   * of a marker that stands for the paper it was printed on.
   *
   * ── A SUBSTITUTED PARAGRAPH HAS NO SEAM, so its markers go to the front ─────
   *
   * The loop writes the words part by part precisely so the page marker can sit
   * at the seam — the exact character where one page ended and the next began. A
   * RECORD HAS NO SUCH CHARACTER. It is one translation of the whole paragraph;
   * the words that were on page 48 and the words that were on page 49 are not
   * separable in it, and any position this file picked inside it would be a claim
   * about the paper that the sentence cannot support. Splitting the record by the
   * source's part lengths would be exactly that claim with arithmetic in front of
   * it.
   *
   * So the markers every part still owes are written together, in page order, at
   * the head — the same place part 0's marker has always gone — and the paragraph
   * that swallowed a page turn says "pages 48 and 49 begin here". That is one
   * element early for the second of them and it is the honest reading: the `pb-N`
   * anchors all exist, they are unique, they stay in ascending document order,
   * and nothing downstream (`epub-final`'s cut machinery, a citation, a reader's
   * page-list) is given a position the translation cannot back up.
   *
   * `joinedPages` is counted from the SOURCE either way, because it is a report
   * about what the reflow did and the reflow ran on the bank.
   *
   * TWO CATEGORIES ASK FOR THIS NOW, which is why it is a function. Text always
   * could be several answers; Quote became able to the day a block quote running
   * over a leaf was allowed to join (`JOINABLE`), and a Quote written from
   * `flow.text` with one marker in front of it would silently owe the turned page
   * its only `pb-N` anchor in the book.
   */
  const partwise = (flow: FlowBlock, words: string, block: DotsBlock): string => {
    const written: string[] = [];
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
      if (n > 0 && part.page !== flow.parts[n - 1]!.page) joinedPages.push(part.page);
    }
    if (substituted) written.push(inline(words, block.page));
    return written.join('');
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
      out.push(blockElement(
        'List-item',
        { outer: stamp(block, src) },
        `${marker(block)}${inline(words, block.page)}`,
      ));
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
        const cat = opts.openers.has(index) ? CHAPTER_ATTRIBUTE : categoryAttribute(flow.category);
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
        out.push(blockElement(
          flow.category,
          { outer: `${anchor}${classOf(align)}${stamp(block, src, cat)}` },
          `${marker(block)}${xhtml}`,
        ));
        // The section's own name, flattened for the contents the same way an
        // inner heading's is: the document's `<h1>` keeps the printed break and
        // the nav gets one line of it.
        label ??= headingLabel(plainText(xhtml));
        break;
      }
      case 'Quote':
        out.push(blockElement(
          'Quote',
          // Two elements, one block, and the SAME stamp on both — see `stampSrc`:
          // a decision about either is a decision about the same banked answer.
          // The two calls are two element numbers, which is the counter's rule.
          { outer: stamp(block, src), inner: stamp(block, src) },
          // Part by part, because a block quote can run over a leaf and come
          // back as a second banked answer (`JOINABLE`). Written whole, the page
          // it turned onto would owe this document a `pb-N` anchor nothing else
          // is going to write.
          partwise(flow, words, block),
        ));
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
         * the whole grid as one string — and no record this route can look up is
         * ever about one.
         *
         * TABLES ARE TRANSLATED NOW, and that does not change this line. The
         * cell route is the BOOK-FILE one (`tablecells.ts`): it takes the grid
         * apart, asks about the cells, puts the grid back together and writes it
         * as one record at the ROW's own id — `b9-2`, a name this route has
         * never heard of, since the positions here are `page:order[:part]`. The
         * cast route's own tables are still refused whole, by the branch in
         * `translate --epub --records` that says exactly why and exactly what
         * wiring it would take. So a record found at one of THESE positions
         * could still only be one this program did not write, and writing a
         * stranger's HTML into a `<div class="tablewrap">` is not something to
         * do on a maybe.
         */
        out.push(blockElement(
          'Table',
          { outer: stamp(block, src) },
          `${marker(block)}${checkTableHtml(flow.text, block.page)}`,
        ));
        break;
      case 'Formula':
        out.push(blockElement(
          'Formula',
          { outer: stamp(block, src) },
          `${marker(block)}${inline(words, block.page)}`,
        ));
        break;
      case 'Picture': {
        const name = `p${String(block.page).padStart(4, '0')}-${opts.firstPicture + crops.length}.png`;
        crops.push({ page: block.page, box: block.box, name });
        out.push(blockElement(
          'Picture',
          { outer: stamp(block, src) },
          marker(block),
          { name, page: block.page },
        ));
        break;
      }
      case 'Caption':
        out.push(blockElement(
          'Caption',
          { outer: stamp(block, src) },
          `${marker(block)}${inline(words, block.page)}`,
        ));
        break;
      default: {
        /*
         * Text — the kind that has always been able to be several banked blocks,
         * written by `partwise` above, which is the whole of what is left of the
         * page-turn join here: writing down, in order, the pieces `reflowBook`
         * resolved.
         *
         * The size and the alignment are written once, from the block that
         * OPENED the paragraph: a paragraph broken over a page turn is one
         * paragraph, and one paragraph is one size.
         */
        const align = alignmentClass(block.box, opts.column);
        out.push(blockElement(
          flow.category,
          { outer: `${classOf(align)}${stamp(block, src)}` },
          partwise(flow, words, block),
        ));
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
    out.push(FOOTNOTES_OPEN);
    out.push(FOOTNOTES_RULE);
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
      // Through `noteLeadOf`, so a number the model spelled in plain digits is
      // the same fact as one it spelled superscript — the note's number is cut
      // off its text and written back as the linked <sup> either way, instead
      // of an ASCII "20" sitting doubled in front of the emitted number.
      const lead = opts.stripNoteMarkers ? null : noteLeadOf(note.text);
      const printed = lead === null ? null : lead.printed;
      const words = note.translated ?? note.text;
      const cut = note.translated === null
        ? lead
        : opts.stripNoteMarkers ? null : noteLeadOf(words);
      const rest = cut ? words.slice(cut.run.length).replace(/^\s+/, '') : words;
      const number = noteNumber(printed, note.refId);
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
      out.push(noteAside(
        note.seq,
        `${stamp(note.block, sourceOfBlock(note.block))}${editing}`,
        `${number}${inline(rest)}`,
      ));
    }
    out.push(FOOTNOTES_CLOSE);
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
 *
 * ── AND AT AN ASCII NUMBER, BUT ONLY WHERE THE SEQUENCE VOUCHES FOR IT ──────
 *
 * The model sometimes answers a footnote area's numbers as plain digits (see
 * `noteLeadOf`), and a splitter that only knew the superscript spelling left
 * those areas as one long note that matched nothing. But plain digits at a
 * line start are not evidence on their own the way a superscript is: a note's
 * own prose wraps, and the wrapped line can open with a page number, a year,
 * or a date — "21 Nov. 1942" at the head of a line is the middle of note 57,
 * not note 21. What tells the two apart is the thing the printer guaranteed:
 * notes on a page are CONSECUTIVE. So an ASCII lead cuts only when it is
 * exactly the previous note's number plus one — which reads the page the way
 * a person does, and makes the date-at-line-start failure need a coincidence
 * (the wrapped number equal to the very next note's) instead of an accident.
 * The superscript cut stays unconditional; it has never false-fired, because
 * prose is not set in superscript.
 */
export function splitNotes(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  /** The current note's own printed number, read off its opening line. */
  let printed: number | null = null;
  for (const line of text.split('\n')) {
    if (current.length > 0) {
      const ascii = ASCII_NOTE_LEAD.exec(line);
      const cut = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(line)
        || (ascii !== null && printed !== null
          && Number.parseInt(ascii[1]!, 10) === printed + 1);
      if (cut) {
        parts.push(current.join('\n').trim());
        current = [];
      }
    }
    if (current.length === 0) printed = noteLeadOf(line)?.printed ?? null;
    current.push(line);
  }
  if (current.length > 0) parts.push(current.join('\n').trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * A block is footnote-sized when its measured type sits under this fraction of
 * the body's. The two populations it separates are not close: measured on
 * evangelische-kirche, the footnote median is 0.73 of body and a genuine body
 * list is set in the body's own type at 1.0, so 0.9 stands in the gap with
 * margin on both sides rather than against either population.
 */
const NOTE_SIZE_CUT = 0.9;

/** The printed number of the LAST note in a footnote block's text, or null. */
function lastPrintedNote(text: string): number | null {
  const notes = splitNotes(text);
  const last = notes[notes.length - 1];
  return last === undefined ? null : noteLeadOf(last)?.printed ?? null;
}

/**
 * The footnotes the model filed as list items, taken back into the apparatus.
 *
 * ── THE FAULT THIS ANSWERS, MEASURED ────────────────────────────────────────
 *
 * The model sometimes tags a whole footnote area `List-item` — same foot of the
 * page, same small type, each note leading with its own number — and everything
 * downstream believes it: the rows flow as body lists, the translator renders
 * them as lists, and the marker match never sees them, so their reference
 * numbers all land in the loose list. On evangelische-kirche that was 216 notes
 * beside the 310 the model tagged honestly — two fifths of the apparatus filed
 * as prose.
 *
 * ── THE EVIDENCE, AND WHY EACH PIECE IS REQUIRED ────────────────────────────
 *
 * A list item is adopted as a footnote only when THREE things agree, because
 * the failure this pass could introduce — a genuine numbered list quietly
 * removed from the prose and appended to a chapter's notes — is exactly the
 * kind of invisible wrong answer this codebase refuses everywhere else:
 *
 *  - IT LEADS WITH A NOTE NUMBER (`noteLeadOf` — the one reading of that
 *    question, superscript or ASCII, period or bare).
 *  - IT IS NOT SET IN BODY TYPE — a veto, not a requirement. Where the type
 *    was actually MEASURED (`typeSizeIsMeasured`), a body-sized block is a
 *    real list and is refused whatever its head says. Where the model
 *    reflowed the block's lines away the size is `lineHeight`'s 40 px guess,
 *    which reads small type as body type every time — so an estimate neither
 *    convicts nor acquits, and the apparatus evidence below stands alone.
 *    Measured on evangelische-kirche: the model kept newlines in only a
 *    fraction of the mis-filed areas, and a gate that trusted the estimate
 *    left 57 of the 88 adoptable blocks standing as lists.
 *  - THE APPARATUS VOUCHES FOR IT: either its lead number is PRINTED as a
 *    superscript somewhere in the page's prose (or the page before — the
 *    mirror of `linkMarkers`' one-page grace), or it CONTINUES the page's note
 *    sequence, one past the last note of the block above it — the same
 *    consecutive-numbering fact `splitNotes` keys its own ASCII guard on.
 *    The second arm exists because the first has a known hole: the model
 *    drops the odd superscript from the prose, and the note whose marker was
 *    never transcribed is still sitting between note 9 and note 11 in small
 *    type with a 10 at its head.
 *
 * MUTATES CATEGORY IN PLACE, like every pass here, and runs BEFORE
 * `flowBlocks`: a Footnote block gets the early exit out of paragraph joining,
 * and `bookRow` asserts a footnote block is one banked answer — an adoption
 * after the join could not keep that promise. It also runs before
 * `deriveTypography`, so the adopted blocks' measurements count toward the
 * Footnote median they in fact are.
 */
function adoptListItemNotes(
  pages: readonly DotsParsedPage[],
  measured: ReadonlyMap<DotsBlock, number>,
): DotsBlock[] {
  const blocks = pages.flatMap((p) => p.blocks);
  const bodyPx = bodyTypeSize(blocks, (block) => measured.get(block));
  if (bodyPx === null) return [];

  /** Every reference number printed in the book's prose, by page. */
  const cited = new Map<number, Set<number>>();
  for (const block of blocks) {
    if (block.category === 'Footnote' || block.category === 'List-item') continue;
    for (const match of block.text.matchAll(SUPERSCRIPT_RUN)) {
      const set = cited.get(block.page) ?? new Set<number>();
      set.add(printedNumber(match[0]));
      cited.set(block.page, set);
    }
  }

  const adopted: DotsBlock[] = [];
  for (const page of pages) {
    /** The last printed number of this page's apparatus so far, or null. */
    let previous: number | null = null;
    for (const block of page.blocks) {
      if (block.category === 'Footnote') {
        previous = lastPrintedNote(block.text) ?? previous;
        continue;
      }
      if (block.category !== 'List-item') continue;
      const lead = noteLeadOf(block.text);
      const px = measured.get(block);
      const bodySized = typeSizeIsMeasured(block)
        && px !== undefined && px >= bodyPx * NOTE_SIZE_CUT;
      if (lead === null || bodySized) {
        // Not a note by its own head, or measurably set in the body's own
        // type — and it BREAKS the sequence, because a genuine list standing
        // between two notes is not something a page prints and the chain must
        // not reach across it.
        previous = null;
        continue;
      }
      const referenced = cited.get(block.page)?.has(lead.printed) === true
        || cited.get(block.page - 1)?.has(lead.printed) === true;
      const continues = previous !== null && lead.printed === previous + 1;
      if (!referenced && !continues) {
        previous = null;
        continue;
      }
      block.category = 'Footnote';
      adopted.push(block);
      previous = lastPrintedNote(block.text) ?? lead.printed;
    }
  }
  return adopted;
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
 * ── AND THAT IS WHY `h1` AND `h2` NOW STATE A SIZE ──────────────────────────
 *
 * They were the only two selectors in this sheet that named none, so a book
 * whose Titles or Section-headers came up short of four samples fell through to
 * whatever the reading system does with a heading — 2em and 1.5em in every
 * browser engine, and a further step up in some of them for a heading inside a
 * `<section>`. That is a size chosen by nobody, and it is the loudest thing on
 * the page: *"chapter headers, titles, section headers, etc. should all be set
 * to the median size of the blocks in the original document so it doesnt all
 * look ridiculous."* Where the book can be measured it now is, exactly as asked;
 * where it cannot, a STATED default is the honest floor — modest, uniform, and
 * the same in every reader, which is more than the inherited value ever was.
 *
 * 1.5 and 1.15 rather than 2 and 1.5 because these are books rather than web
 * pages: a scanned chapter opener runs about half again the body and a section
 * head only just above it, which is where the measured ratios land whenever
 * there are enough of them to land anywhere.
 *
 * Still no point sizes and still no font families: everything derived is an
 * `em` against the reader's own body size, so the reader decides how big the
 * book is and the book decides what is bigger than what.
 *
 * AND NOTHING IS SET PER BLOCK. Every rule here is one line for a whole
 * category; `TypographyReport` carries the ruling that ended the inline
 * `font-size` an unusually-boxed block used to keep.
 */
const STYLESHEET_BASE = `/* Foundry — vlm-convert, dots.ocr. Sizes are the book's own, as em ratios. */
html { font-size: 100%; }
body { margin: 0 5%; line-height: 1.5; }
h1 { font-size: 1.5em; line-height: 1.2; margin: 1.4em 0 0.8em; }
h2 { font-size: 1.15em; line-height: 1.2; margin: 1.4em 0 0.8em; }
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
/* Border 0 everywhere, header row included -- Owen's ruling, 2026-08-22:
   "a table generated by dots looks ridiculous with borders." The underline
   the header carried was the last rule standing, and it went with the rest. */
td, th { border: none; padding: 0.35em 1.1em; }
th { font-weight: 600; }
`;

/**
 * Where each measured category writes itself, and there are only five.
 *
 * Each selector carries a font-size in the base sheet already — including the
 * two headings, which used to carry none and inherit one from the reading
 * system (see `STYLESHEET_BASE`). All five are things the book itself can answer
 * better, and none is a place where a wrong number could do anything but make a
 * heading the wrong size.
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
  return `${STYLESHEET_BASE}\n`
    + `/* Measured from this book: ${typography!.bodyPx.toFixed(1)}px body line. */\n`
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
  /**
   * The Section-headers the book's own contents page named, promoted to chapter
   * openings by `promoteListedHeadings` — with the entry that named each one,
   * because a category this run changed is a claim and not a reading.
   */
  promotedHeadings: PromotedHeading[];
  /** The blocks whose print line breaks were reflowed back into prose. */
  reflowed: DotsBlock[];
  /**
   * The List-item blocks the reflow adopted as footnotes — the model's own
   * mis-filing, corrected on measured evidence (`adoptListItemNotes`) and
   * counted here so the run can say the number out loud.
   */
  adoptedNotes: DotsBlock[];
  column: BodyColumn;
  lexicon: BookLexicon;
  typography: TypographyReport | null;
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
   * A person's decisions. Two of them are read HERE — the CHAPTERS, because the
   * spine is a fact about the whole book, and the JOINS, because a seam only
   * exists once the blocks have neighbours — while the strikes, the categories
   * and the text corrections were applied at the parse (`convert.ts`), so by
   * now they are simply what the blocks say.
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
 * When neither fires the two paragraphs stay two paragraphs, UNLESS A PERSON
 * SAID OTHERWISE: a `join` decision in the overlay names the continuation and
 * outranks the textual test, which is the compensation promised the day the
 * third test — the one that measured the page's ink — was killed
 * (`DotsPageImages` above says why it is gone). Machine passes stay
 * conservative; judgment is recorded, never guessed.
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
  const overlay = opts.overlay ?? emptyOverlay();
  const suppressedHeads = suppressRunningHeads(opts.pages);
  const mergedHeadings = mergeAdjacentHeadings(opts.pages);
  /*
   * The book's own contents, read once and spent twice — and it must run HERE,
   * after the merge and before the flatten.
   *
   * After the merge because a heading the page printed as `II` over `The Price
   * of Judgment` is two blocks until `mergeAdjacentHeadings` makes it one, and
   * the contents lists it as one thing: asked before the merge, this pass would
   * match a bare numeral against nothing and miss every two-line opening in the
   * book. Before the flatten because "first block on its page" is a fact about a
   * page, and a page is what stops existing on the next line.
   */
  const contents = readContentsList(opts.pages);
  const promotedHeadings = promoteListedHeadings(opts.pages, overlay, contents);
  const listed: ReadonlySet<string> = new Set(contents.entries.keys());

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
      promotedHeadings,
      reflowed: [],
      adoptedNotes: [],
      column: { x1: 0, x2: 0 },
      lexicon: new BookLexicon([]),
      typography: null,
      unjoinedTurns: [],
    };
  }
  const measured = measureTypeSizes(sourceBlocks);

  // The footnotes the model filed as list items, adopted while the evidence
  // is all still standing: the type measurements above, and the note leads and
  // superscript markers the rewriting passes below leave alone. Before
  // `flowBlocks`, necessarily — see `adoptListItemNotes`.
  const adoptedNotes = adoptListItemNotes(opts.pages, measured);

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

  const proposals = proposeSections(opts.pages, overlay, listed);

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

  /*
   * The recorded joins, read off the overlay ONCE and handed to the seam pass
   * as a map keyed by block IDENTITY — the same identity every measurement in
   * this file keys on, and the reason nothing here may copy a block. Built
   * only when an overlay is present at all, so `detectChapters` — which calls
   * this pass overlay-less to seed the picker — pays nothing and stays what it
   * is: the answer a run without decisions would give. (A join cannot move a
   * chapter proposal: proposals are made from the pages above, before any
   * seam is resolved, and a section start closes every open paragraph.)
   */
  let joins: Map<DotsBlock, boolean> | undefined;
  if (opts.overlay !== undefined && opts.overlay.amendments.length > 0) {
    for (const block of sourceBlocks) {
      const decided = joinDecisionFor(opts.overlay, block);
      if (decided === undefined) continue;
      (joins ??= new Map()).set(block, decided);
    }
  }

  const flow = flowBlocks(sourceBlocks, new Set(starts), column, lexicon, joins);
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
    promotedHeadings,
    reflowed,
    adoptedNotes,
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
  /**
   * A person's recorded seam decisions, by block identity: `true` joins the
   * block onto the open paragraph before it, `false` keeps it its own. Absent
   * — the map, or the block from it — means the rules decide, which is every
   * block of every book until somebody touches a seam.
   */
  joins?: ReadonlyMap<DotsBlock, boolean>,
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

    /*
     * THE SEAM, RESOLVED IN LAYERS — the same layering `resolveCategory` gives
     * a block's category, for the same reason.
     *
     * The rules first: a paragraph must be open, the block must sit at column
     * width (a centered epigraph that happens to open lowercase is not a
     * continuation of anything), the pages must adjoin, and the words must
     * carry over (`continuesTextually`). And THE PERSON ON TOP: a recorded
     * `join` decision is somebody looking at the seam on the flowing page and
     * stating what the printer set, which outranks every heuristic below it —
     * alignment, adjacency and the words alike — because each of those is a
     * guess about exactly the question the person just answered. What it does
     * not outrank is the STRUCTURE this loop has already enforced by the time
     * it runs: a section start cleared `open` above (a join must never reach
     * across where a chapter begins), a non-joinable category never opened a
     * paragraph to continue, and a Footnote took the early exit. A decision
     * those absolutes make unmeetable simply does not join — the same quiet
     * `chapterStarts` keeps for a chapter at a block a strike removed.
     *
     * `false` forces the split with the same authority, so the field cannot
     * hold a meaning this pass ignores; nothing writes it today.
     */
    const decided = open === null ? undefined : joins?.get(block);
    let joined = false;
    if (decided !== undefined) {
      joined = decided;
    } else if (open !== null && alignmentClass(block.box, column) === '' && adjoins(previous, block)) {
      joined = continuesTextually(open.text, block.text);
      /*
       * WHERE THE INK USED TO BE ASKED, and now nothing is. The words said no
       * about a paragraph that runs over a page turn, which is the one case
       * `carriesOver` existed for; the two halves stay two paragraphs and the
       * run says how often that happened. Counted only across a TURN, because
       * that is the only place the old test was ever consulted — two blocks on
       * one page that the words do not join are two paragraphs the printer set
       * as two, and there was never a question about them. A seam somebody has
       * already DECIDED took the branch above and is not in this count: the
       * count exists to surface the seams still waiting for a person.
       */
      if (!joined && previous !== null && block.page !== previous.page) {
        unjoinedTurns.push(block.page);
      }
    }

    if (joined && open !== null) {
      /*
       * THE EMPHASIS THE MODEL CLOSED ON THE WRONG SIDE OF THE BROKEN WORD.
       *
       * dots ends page 37 of the Pokemon book (Arms, 2000) with `…evolve into
       * the more pow-*` — the whole Pokédex blurb is italic, so the run closes
       * after the hyphen the column broke `powerful` on. That asterisk is the
       * last character of the paragraph, `trailingHyphenWord` finds no hyphen
       * behind it, and the join it does not recognise as a broken word is made
       * with a space instead: `pow- erful`, which is what reached the audiobook.
       *
       * The marker moves to the other side of the broken word and nothing else
       * changes: `…the more* pow-`. It has to move rather than be deleted,
       * because each PART is rendered by its own `dotsInline` call — an emphasis
       * run can never span the seam, so a marker dropped here would leave its
       * partner unbalanced and print a literal asterisk. Applied to both strings
       * with one anchored pattern, so the paragraph's text and its last part get
       * the identical edit at the identical character.
       */
      const last = open.parts[open.parts.length - 1];
      open.text = closeEmphasisBeforeBreak(open.text);
      last.text = closeEmphasisBeforeBreak(last.text);
      const join = resolveJoin(open.text, block.text, lexicon);
      // What `opening` took off the end of the paragraph came off the end of
      // its LAST part — the broken word was there, and so was any space after
      // it. Taking it off the part rather than off the whole is what lets the
      // emitter render each part on its own and still write the fused word once.
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
 *
 * AND QUOTE, WHICH IS NOT FURNITURE AND IS HERE ON EVIDENCE. A displayed
 * quotation is marked `> ` by the model on the page where it can see the
 * quotation start, and NOT on the page it runs onto — the continuation comes
 * back as an ordinary Text block, because from the top of that leaf there is
 * nothing to see. Four of the seven seams the Pokemon book (Arms, 2000) got
 * wrong are exactly this: page 103 ends `…that they may serve other gods: so`
 * inside a block quote and page 104 opens `will the anger of the Lord…` as Text.
 * The words said join on every one of them; the category said the paragraph had
 * already been closed, and the audiobook read a Deuteronomy passage as two.
 *
 * A join takes the OPEN block's category, so the continuation lands inside the
 * blockquote where the printer set it — and both writers of a book walk the
 * parts of a Quote now, because a Quote can be several banked answers (see
 * `buildChapterBody` and `vlm-compile`). Nothing else changes: a Quote still has
 * to sit at column width, still has to adjoin, and the words still have to carry
 * over, which is what keeps the ordinary `…as follows:` lead-in — a colon, and
 * therefore terminal — from swallowing the quotation it introduces.
 */
const JOINABLE: ReadonlySet<DotsCategory> =
  new Set<DotsCategory>(['Text', 'Quote', 'Page-header', 'Page-footer']);

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
      notes.push({
        source: block.source,
        text,
        printed: printedNoteNumber(text),
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
  /**
   * The files that go BESIDE `--out` — the stylesheet and the pictures of an
   * unzipped HTML book, and nothing at all for the formats that write one file.
   *
   * They ride the result rather than being written here because this function
   * does not touch the disk: it is handed a bank and hands back a book, and the
   * one place that knows where `--out` points is its caller.
   */
  sidecars: readonly VlmSidecar[];
  chapters: VlmChapter[];
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
   * The Section-headers the book's own contents page lists, promoted to chapter
   * openings by `promoteListedHeadings`. The same promise a third time, on the
   * one pass that neither removes a block nor writes copy: it changes what a
   * block IS, which is invisible in the finished book and decides its whole
   * shape.
   */
  promotedHeadings: PromotedHeading[];
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
  /** List-item blocks adopted as footnotes on measured evidence. */
  adoptedNotes: number;
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

  const categories: Record<string, number> = {};
  for (const block of blocks) categories[block.category] = (categories[block.category] ?? 0) + 1;

  const xhtmlSeconds = (Date.now() - started) / 1000;
  const stylesheet = dotsStylesheet(typography);
  /*
   * THREE PACKAGERS, ONE BOOK. Every rule above this line has already run —
   * the reflow, the joins, the notes, the chapters, the records substitution —
   * so the format decides only how the finished documents are carried, which is
   * why `--format txt` and `--format html` are the SAME BOOK and not a lesser
   * one. `html` is the workbench (`packageVlmHtml`), `epub` and `txt` are what
   * an export compiles to.
   */
  const written = opts.format === 'html'
    ? packageVlmHtml(opts.metadata, documents, resources, stylesheet)
    : null;
  const packaged = written ?? (opts.format === 'txt'
    ? packageVlmText(opts.metadata, documents)
    : packageVlmEpub(opts.metadata, documents, resources, stylesheet, navTree(chapters)));
  return {
    bytes: packaged.bytes,
    // Empty for every packager that writes one file. See `VlmSidecar`.
    sidecars: written?.sidecars ?? [],
    chapters,
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
    promotedHeadings: flow.promotedHeadings,
    typography,
    reflowedBlocks: flow.reflowed.length,
    adoptedNotes: flow.adoptedNotes.length,
    lexiconWords: flow.lexicon.size,
    xhtmlSeconds,
    zipSeconds: packaged.zipSeconds,
  };
}
