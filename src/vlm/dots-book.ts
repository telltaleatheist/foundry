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
 *  - **A paragraph that runs over a page turn is ONE paragraph.** The cheap test
 *    is textual — the previous block did not end on terminal punctuation and
 *    this one opens lowercase. When that says no, the page render is measured:
 *    a paragraph that continues fills its last line to the right margin, and a
 *    paragraph that genuinely starts on the new page starts with a first-line
 *    indent. Neither of those is in the text, and both are in the ink.
 *    **A TURN IS ONE PAGE, NOT A GAP.** Page 8 followed by page 12 is not a
 *    page turn: four pages of the book are missing between them, either struck
 *    out by `--skip-pages` or left out because the model could not read them.
 *    Both tests would happily join across that hole — the words because a
 *    sentence that was interrupted mid-clause still reads as interrupted, the
 *    ink because a paragraph that continued onto page 9 still fills its last
 *    line — and the join would fuse two unrelated sentences into one, which is
 *    a lie no reader can see. So a non-consecutive page break is a boundary,
 *    exactly like a chapter start.
 *  - **Footnotes collect at the END OF THEIR CHAPTER.** Not per page: a page is
 *    not a unit of a reflowable book, and seventeen little note sections in a
 *    chapter is seventeen interruptions. One Footnote block routinely carries
 *    several notes, so it is split at its superscript starts and each note gets
 *    its own paragraph — a note nobody can see the start of is a note nobody
 *    reads.
 *  - **A Picture is the actual picture**, cropped out of the page render by its
 *    box and carried into the container with its Caption.
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
 */
import { readFileSync } from 'node:fs';

import { readPgm, type GrayRaster } from '../scan/pgm.js';
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
  lineHeight,
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
  type VlmDocument,
  type VlmEpubMetadata,
  type VlmNavItem,
  type VlmResource,
} from './epub.js';

// ── the page images ─────────────────────────────────────────────────────────

/**
 * What the assembler needs from the page renders, and nothing else.
 *
 * An interface rather than a file reader because these are the only two
 * questions asked of a pixel in this whole mode, and because the answers are
 * what make the join test measurable in a unit test. `renders.ts` is the
 * implementation that reads what `vlm_page.py` wrote.
 */
export interface DotsPageImages {
  /**
   * The leftmost and rightmost dark pixel inside a box, measured from the box's
   * OWN left edge, or null when there is no ink in it at all.
   */
  inkExtent(page: number, box: DotsBox): { left: number; right: number } | null;
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

/** A grayscale raster reader, shared by `renders.ts` and the tests. */
export function inkExtentIn(raster: GrayRaster, box: DotsBox): { left: number; right: number } | null {
  const x1 = Math.max(0, Math.floor(box.x1));
  const y1 = Math.max(0, Math.floor(box.y1));
  const x2 = Math.min(raster.width, Math.ceil(box.x2));
  const y2 = Math.min(raster.height, Math.ceil(box.y2));
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (let y = y1; y < y2; y++) {
    const row = y * raster.width;
    for (let x = x1; x < x2; x++) {
      // 128 of 255: the midpoint. A page render is ink on paper, and everything
      // between the two is an antialiased edge of one of them.
      if (raster.data[row + x] < 128) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right < left) return null;
  return { left: left - x1, right: right - x1 };
}

/** The page renders `vlm_page.py` left on disk, read as PGM. */
export function openPageImages(
  pgmPath: (page: number) => string,
  crop: (requests: readonly DotsCrop[]) => Promise<readonly DotsCropped[]>,
): DotsPageImages {
  const cache = new Map<number, GrayRaster>();
  return {
    inkExtent(page, box) {
      let raster = cache.get(page);
      if (!raster) {
        const path = pgmPath(page);
        raster = readPgm(new Uint8Array(readFileSync(path)), path);
        // One page at a time: a 300-page book at 200 dpi is 800 MB of raster,
        // and the join test only ever looks at two adjacent pages.
        cache.clear();
        cache.set(page, raster);
      }
      return inkExtentIn(raster, box);
    },
    crop,
  };
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

/** The categories a mistagged running head arrives as. */
const MISTAGGED: ReadonlySet<DotsCategory> =
  new Set<DotsCategory>(['Title', 'Section-header', 'Text']);

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
 * Mutates the pages, which is how `buildDotsBook`'s dehyphenation pass already
 * works, and returns what it took so the run can say so. A book that silently
 * lost seventeen blocks is a book nobody can check.
 */
export function suppressRunningHeads(pages: readonly DotsParsedPage[]): DotsBlock[] {
  const taggedHead = new Set<string>();
  const taggedFoot = new Set<string>();
  const headerPages = new Map<string, Set<number>>();
  const footerPages = new Map<string, Set<number>>();

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
      if (topFraction(block) <= FURNITURE_BAND) note(headerPages, key, block.page);
      if (bottomFraction(block) >= 1 - FURNITURE_BAND) note(footerPages, key, block.page);
    }
  }

  const attested = (
    tagged: ReadonlySet<string>,
    where: Map<string, Set<number>>,
    key: string,
  ): boolean =>
    tagged.has(key) && /[A-Z]/.test(key) && (where.get(key)?.size ?? 0) >= FURNITURE_PAGES;

  const removed: DotsBlock[] = [];
  for (const page of pages) {
    const kept = page.blocks.filter((block) => {
      if (!MISTAGGED.has(block.category) || block.text.length >= FURNITURE_CHARS) return true;
      const key = furnitureKey(block.text);
      if (key.length === 0) return true;
      const isHead = topFraction(block) <= FURNITURE_BAND
        && attested(taggedHead, headerPages, key);
      const isFoot = bottomFraction(block) >= 1 - FURNITURE_BAND
        && attested(taggedFoot, footerPages, key);
      if (!isHead && !isFoot) return true;
      removed.push(block);
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
export function proposeSections(pages: readonly DotsParsedPage[]): DotsChapterProposal[] {
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

  const chapters = proposeChapters(pages.flatMap((p) => p.blocks), spokenFor);
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

/** Chapters nest under the part they follow; everything else is top level. */
export function navTree(chapters: readonly VlmChapter[]): VlmNavItem[] {
  const root: VlmNavItem[] = [];
  let open: { href: string; label: string; children: VlmNavItem[] } | null = null;
  for (const chapter of chapters) {
    const item = { href: chapter.href, label: chapter.label };
    if (chapter.kind === 'part') {
      open = { ...item, children: [] };
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
 * Did `previous`'s paragraph run on into `next`? Measured in ink, not in words.
 *
 * A paragraph that continues fills its LAST line to the right margin; one that
 * ended stops short of it. A paragraph that genuinely begins on the new page
 * begins with a first-line indent; a continuation begins flush left. Both facts
 * are in the render and neither is in the text, which is why this test exists
 * beside the textual one rather than instead of it.
 */
export function carriesOver(
  previous: DotsBlock,
  next: DotsBlock,
  images: DotsPageImages,
): boolean {
  // 20 px floors both: a one-line block's height IS its line height, and a box
  // measured a few pixels tight would otherwise sample the line above.
  const previousLine = Math.max(20, lineHeight(previous));
  const previousWidth = previous.box.x2 - previous.box.x1;
  const tail = images.inkExtent(previous.page, {
    x1: previous.box.x1,
    y1: previous.box.y2 - previousLine,
    x2: previous.box.x2,
    y2: previous.box.y2,
  });
  if (!tail || tail.right < 0.9 * previousWidth) return false;

  const nextLine = Math.max(20, lineHeight(next));
  const nextWidth = next.box.x2 - next.box.x1;
  const head = images.inkExtent(next.page, {
    x1: next.box.x1,
    y1: next.box.y1,
    x2: next.box.x2,
    y2: next.box.y1 + nextLine,
  });
  if (!head) return false;
  // 3% of the block plus 8 px of slack for the box's own edge. A first-line
  // indent is an em or more, which at 200 dpi is over 25 px.
  return head.left < 0.03 * nextWidth + 8;
}

/**
 * Are these two blocks close enough to be halves of one paragraph?
 *
 * Same page, or the very next one. Anything else is a GAP — pages struck out
 * with `--skip-pages`, or pages the model could not read and that were left out
 * by number — and nothing may be joined across one. See this file's header:
 * both join tests answer "yes, continue" for a paragraph whose continuation is
 * on a page that is not in the book, and the sentence they would build never
 * existed.
 *
 * Exported because the rule is worth asserting on its own; it is arithmetic,
 * and it decides whether a book contains a sentence nobody wrote.
 */
export function adjoins(previous: DotsBlock | null, next: DotsBlock): boolean {
  if (previous === null) return true;
  return next.page === previous.page || next.page === previous.page + 1;
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

/** `data-bf-page` and `data-bf-cat` — see this file's header. */
function stamp(
  block: DotsBlock,
  attribute: string = CATEGORY_ATTRIBUTE[block.category],
): string {
  return ` data-bf-page="${block.page}" data-bf-cat="${attribute}"`;
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
  lexicon: BookLexicon;
  images: DotsPageImages;
  stripNoteMarkers: boolean;
  /** Running note number, so ids are unique across the whole book. */
  firstNote: number;
  /** Running picture number, for the same reason. */
  firstPicture: number;
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
}

export interface DotsChapterBody {
  xhtml: string;
  label: string | null;
  crops: DotsCrop[];
  notes: number;
  /** The pages whose first paragraph was joined onto the previous page's. */
  joinedPages: number[];
}

export function buildChapterBody(
  blocks: readonly DotsBlock[],
  opts: DotsChapterOptions,
): DotsChapterBody {
  const out: string[] = [];
  const footnotes: DotsBlock[] = [];
  const crops: DotsCrop[] = [];
  const joinedPages: number[] = [];
  const inline = (text: string): string =>
    dotsInline(text, { stripNoteMarkers: opts.stripNoteMarkers });

  let label: string | null = null;
  let openList: 'ol' | 'ul' | null = null;
  let lastParagraph: number | null = null;
  let lastParagraphBlock: DotsBlock | null = null;
  let lastParagraphText = '';
  const pagesSeen = new Set<number>();

  const closeList = (): void => {
    if (openList === null) return;
    out.push(`</${openList}>`);
    openList = null;
  };

  /** The page marker owed to this block, if it opens a page. Consumed once. */
  const marker = (block: DotsBlock): string => {
    if (pagesSeen.has(block.page)) return '';
    pagesSeen.add(block.page);
    return pageBreak(block.page);
  };

  for (const [index, block] of blocks.entries()) {
    if (block.category === 'List-item') {
      const tag = /^\d+[.)]/.test(block.text) ? 'ol' : 'ul';
      if (openList !== tag) {
        closeList();
        out.push(`<${tag}${stamp(block)}>`);
        openList = tag;
      }
      out.push(`  <li${stamp(block)}>${marker(block)}${inline(block.text)}</li>`);
      lastParagraph = null;
      continue;
    }
    closeList();

    switch (block.category) {
      case 'Title':
      case 'Section-header': {
        const xhtml = inline(block.text);
        // The TAG still comes from the true category: `h1` for a Title and `h2`
        // for a Section-header is the book's own hierarchy, and a chapter that
        // opens on a Section-header did not become a Title by opening one.
        const tag = block.category === 'Title' ? 'h1' : 'h2';
        const align = alignmentClass(block.box, opts.column);
        const cat = opts.openers.has(index) ? CHAPTER_ATTRIBUTE : CATEGORY_ATTRIBUTE[block.category];
        out.push(`<${tag}${classOf(align)}${stamp(block, cat)}>${marker(block)}${xhtml}</${tag}>`);
        label ??= plainText(xhtml);
        lastParagraph = null;
        break;
      }
      case 'Quote':
        out.push(
          `<blockquote${stamp(block)}><p${stamp(block)}>${marker(block)}${inline(block.text)}</p></blockquote>`,
        );
        lastParagraph = null;
        break;
      case 'Footnote':
        // Held back to the end of the chapter. The page marker is not consumed
        // here: a note is not where its page's body begins.
        footnotes.push(block);
        break;
      case 'Table':
        out.push(
          `<div class="tablewrap"${stamp(block)}>${marker(block)}`
          + `${checkTableHtml(block.text, block.page)}</div>`,
        );
        lastParagraph = null;
        break;
      case 'Formula':
        out.push(`<p class="formula"${stamp(block)}>${marker(block)}${inline(block.text)}</p>`);
        lastParagraph = null;
        break;
      case 'Picture': {
        const name = `p${String(block.page).padStart(4, '0')}-${opts.firstPicture + crops.length}.png`;
        crops.push({ page: block.page, box: block.box, name });
        out.push(
          `<figure${stamp(block)}>${marker(block)}`
          + `<img src="../images/${name}" alt="figure from page ${block.page}"/></figure>`,
        );
        lastParagraph = null;
        break;
      }
      case 'Caption':
        out.push(`<p class="caption"${stamp(block)}>${marker(block)}${inline(block.text)}</p>`);
        lastParagraph = null;
        break;
      default: {
        // Text. The only kind that can be joined onto the one before it, and
        // only when it is an ordinary column-width paragraph — a centered
        // epigraph that happens to open lowercase is not a continuation.
        const align = alignmentClass(block.box, opts.column);
        let joined = false;
        if (lastParagraph !== null && align === '' && adjoins(lastParagraphBlock, block)) {
          joined = continuesTextually(lastParagraphText, block.text);
          if (!joined && lastParagraphBlock !== null && block.page !== lastParagraphBlock.page) {
            joined = carriesOver(lastParagraphBlock, block, opts.images);
          }
        }
        if (joined) {
          if (lastParagraphBlock !== null && block.page !== lastParagraphBlock.page) {
            joinedPages.push(block.page);
          }
          out[lastParagraph!] = appendToParagraph(
            out[lastParagraph!],
            marker(block),
            block.text,
            lastParagraphText,
            opts.lexicon,
            inline,
          );
          lastParagraphText = joinTexts(lastParagraphText, block.text, opts.lexicon);
        } else {
          out.push(`<p${classOf(align)}${stamp(block)}>${marker(block)}${inline(block.text)}</p>`);
          lastParagraph = out.length - 1;
          lastParagraphText = block.text;
        }
        lastParagraphBlock = block;
      }
    }
  }
  closeList();

  let note = opts.firstNote;
  if (footnotes.length > 0) {
    out.push('<section class="footnotes" epub:type="footnotes">');
    out.push('<hr/>');
    for (const block of footnotes) {
      for (const part of splitNotes(block.text)) {
        out.push(
          `<p class="footnote" epub:type="footnote" id="fn${note}"${stamp(block)}>${inline(part)}</p>`,
        );
        note += 1;
      }
    }
    out.push('</section>');
  }

  return { xhtml: out.join('\n'), label, crops, notes: note - opts.firstNote, joinedPages };
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

/** The two halves of a joined paragraph, as plain text, hyphen resolved. */
function joinTexts(previous: string, next: string, lexicon: BookLexicon): string {
  const tail = trailingHyphenWord(previous);
  const head = leadingWord(next);
  if (tail !== null && head !== null) {
    const fused = lexicon.join(tail, head);
    return previous.trimEnd().slice(0, -(tail.length + 1)) + fused + next.slice(head.length);
  }
  return `${previous} ${next}`;
}

/** The same join, performed on the rendered `<p>` that is already in `out`. */
function appendToParagraph(
  paragraph: string,
  marker: string,
  next: string,
  previousText: string,
  lexicon: BookLexicon,
  inline: (text: string) => string,
): string {
  const open = paragraph.replace(/<\/p>$/, '');
  const tail = trailingHyphenWord(previousText);
  const head = leadingWord(next);
  if (tail !== null && head !== null) {
    const fused = lexicon.join(tail, head);
    // The rendered paragraph ends in `word-`; the hyphen and the word come off
    // and the resolved form goes back on, so the join is performed once and the
    // markup around it is untouched.
    const trimmed = open.trimEnd();
    const cut = trimmed.slice(0, trimmed.length - (tail.length + 1));
    // The marker goes BEFORE the resolved word: the page turned in the middle
    // of it, and a word cannot be split around a marker without splitting the
    // word again in the finished book.
    return `${cut}${marker}${inline(fused)}${inline(next.slice(head.length))}</p>`;
  }
  return `${open} ${marker}${inline(next)}</p>`;
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

const STYLESHEET = `/* Foundry — vlm-convert, dots.ocr. No per-book font decisions, ever. */
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
.footnotes p { text-indent: 0; margin-bottom: 0.5em; }
.tablewrap { margin: 1em 0; overflow-x: auto; }
table { border-collapse: collapse; margin: 0 auto; }
td, th { border: none; padding: 0.35em 1.1em; }
th { border-bottom: 1px solid currentColor; }
`;

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
  span: readonly DotsBlock[],
  kind: DotsPageKind | null,
): Set<number> {
  const openers = new Set<number>();
  if (span.length === 0 || (kind !== 'chapter' && kind !== 'part')) return openers;
  const page = span[0].page;
  for (const [index, block] of span.entries()) {
    if (block.page !== page) break;
    if (block.category === 'Title' || block.category === 'Section-header') {
      openers.add(index);
      continue;
    }
    if (kind === 'chapter') break;
  }
  return openers;
}

export interface DotsBookOptions {
  metadata: VlmEpubMetadata;
  /** In page order. */
  pages: readonly DotsParsedPage[];
  images: DotsPageImages;
  stripNoteMarkers: boolean;
}

export interface DotsBookResult {
  bytes: Uint8Array;
  chapters: VlmChapter[];
  proposals: DotsChapterProposal[];
  blocks: number;
  categories: Record<string, number>;
  footnotes: number;
  pictures: number;
  /** Pages whose opening paragraph was joined onto the previous page's. */
  joinedPages: number[];
  /**
   * The running heads the model mistagged, taken out of the book by
   * `suppressRunningHeads` — page and text, because a removal nobody can read
   * is a removal nobody can check.
   */
  suppressedHeads: { page: number; text: string }[];
  /** Text blocks whose print line breaks were reflowed back into prose. */
  reflowedBlocks: number;
  lexiconWords: number;
  xhtmlSeconds: number;
  zipSeconds: number;
}

export async function buildDotsBook(opts: DotsBookOptions): Promise<DotsBookResult> {
  const started = Date.now();

  // FIRST, before the blocks are flattened and before anything counts them: the
  // running heads the model did not label are not part of the book, and every
  // pass after this — the lexicon, the chapter proposals, the body column —
  // would otherwise be reading them as if they were.
  const suppressed = suppressRunningHeads(opts.pages);

  const blocks = opts.pages.flatMap((p) => p.blocks);
  if (blocks.length === 0) {
    throw new Error('no blocks survived the pages — there is no book to write');
  }

  // The lexicon is built from the text as the model wrote it, hyphens and all:
  // a compound that appears mid-line anywhere in the book is the evidence that
  // decides every line-broken instance of it (`BookLexicon`).
  const lexicon = new BookLexicon(blocks.map((b) => b.text));
  for (const block of blocks) {
    if (block.text.includes('-\n')) block.text = lexicon.dehyphenate(block.text);
  }
  const reflowed = reflowWrappedProse(blocks);

  const column = bodyColumn(blocks, blocks[0].pageWidth);
  const proposals = proposeSections(opts.pages);

  // The leading span, when the book does not open on a section start. It has no
  // proposal behind it and therefore no kind: nothing said what it is.
  const opens: (DotsChapterProposal | null)[] = [...proposals];
  const starts = proposals.map((p) => p.index);
  if (starts.length === 0 || starts[0] !== 0) {
    starts.unshift(0);
    opens.unshift(null);
  }
  const spans = starts.map((start, i) => [start, starts[i + 1] ?? blocks.length] as const);

  const documents: VlmDocument[] = [];
  const chapters: VlmChapter[] = [];
  const crops: DotsCrop[] = [];
  const joinedPages: number[] = [];
  let notes = 1;

  for (const [index, [from, to]] of spans.entries()) {
    const span = blocks.slice(from, to);
    const kind = opens[index]?.kind ?? null;
    const body = buildChapterBody(span, {
      column,
      lexicon,
      images: opts.images,
      stripNoteMarkers: opts.stripNoteMarkers,
      firstNote: notes,
      firstPicture: crops.length,
      openers: openingHeadings(span, kind),
    });
    notes += body.notes;
    crops.push(...body.crops);
    joinedPages.push(...body.joinedPages);

    const n = String(index + 1).padStart(4, '0');
    const pages = span.map((b) => b.page);
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
      blocks: span.length,
      firstPage,
      lastPage: Math.max(...pages),
      ...(kind !== null ? { kind } : {}),
    });
  }

  const cropped = crops.length > 0 ? await opts.images.crop(crops) : [];
  if (cropped.length !== crops.length) {
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
  const packaged = packageVlmEpub(
    opts.metadata, documents, resources, STYLESHEET, navTree(chapters),
  );
  return {
    bytes: packaged.bytes,
    chapters,
    proposals,
    blocks: blocks.length,
    categories,
    footnotes: notes - 1,
    pictures: resources.length,
    joinedPages,
    suppressedHeads: suppressed.map((b) => ({ page: b.page, text: b.text })),
    reflowedBlocks: reflowed.length,
    lexiconWords: lexicon.size,
    xhtmlSeconds,
    zipSeconds: packaged.zipSeconds,
  };
}
