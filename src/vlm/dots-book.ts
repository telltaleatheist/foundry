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

// ── chapter proposals ───────────────────────────────────────────────────────

const CHAPTERISH = new RegExp(
  '^(chapter|part|book|prologue|epilogue|introduction|preface|foreword|'
  + 'acknowledg|conclusion|afterword|appendix|notes|bibliography|index)\\b'
  + '|^[IVXLC]+\\.?$|^\\d{1,2}\\.?$',
  'i',
);

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

  const proposals: DotsChapterProposal[] = [];
  const claimed = new Set<number>(spokenFor);
  for (const [index, block] of blocks.entries()) {
    if (block.category !== 'Title' && block.category !== 'Section-header') continue;
    if (claimed.has(block.page)) continue;
    if (firstIndexOnPage.get(block.page) !== index) continue;
    if (topFraction(block) > 0.45) continue;
    if (block.text.length >= 80) continue;

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

/** `data-bf-page` and `data-bf-cat` — see this file's header. */
function stamp(block: DotsBlock): string {
  return ` data-bf-page="${block.page}" data-bf-cat="${CATEGORY_ATTRIBUTE[block.category]}"`;
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
 * `chapter` IS NOT STAMPED, and that is the whole distinction this file draws.
 * The four kinds above are what a PAGE said it was, loudly enough to be named;
 * `chapter` is `proposeChapters`, a deliberately generous rule whose output a
 * person curates — it offers the second half-title of For the Soul of the
 * People as a chapter, and it is supposed to. A proposal belongs in the
 * proposal file, where it is labelled a proposal. Written into the book as an
 * attribute it stops being an offer and becomes a claim, and the claim is
 * sometimes false.
 *
 * So a section with no kind, and a section that is only a chapter proposal, are
 * emitted exactly as they were before any of this existed. That is the
 * classifier's silence reaching the file: a book whose pages said nothing comes
 * out byte for byte the book it was.
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

  for (const block of blocks) {
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
        const tag = block.category === 'Title' ? 'h1' : 'h2';
        const align = alignmentClass(block.box, opts.column);
        out.push(`<${tag}${classOf(align)}${stamp(block)}>${marker(block)}${xhtml}</${tag}>`);
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
  lexiconWords: number;
  xhtmlSeconds: number;
  zipSeconds: number;
}

export async function buildDotsBook(opts: DotsBookOptions): Promise<DotsBookResult> {
  const started = Date.now();
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
    const body = buildChapterBody(span, {
      column,
      lexicon,
      images: opts.images,
      stripNoteMarkers: opts.stripNoteMarkers,
      firstNote: notes,
      firstPicture: crops.length,
    });
    notes += body.notes;
    crops.push(...body.crops);
    joinedPages.push(...body.joinedPages);

    const n = String(index + 1).padStart(4, '0');
    const kind = opens[index]?.kind ?? null;
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
    lexiconWords: lexicon.size,
    xhtmlSeconds,
    zipSeconds: packaged.zipSeconds,
  };
}
