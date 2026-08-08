/**
 * vlm/dots — the dots.ocr dialect: what the model answered, in the render's
 * pixel frame.
 *
 * The other three dialects hand back a stream of text and this file's whole
 * reason for existing is that dots does not. Its answer is a JSON array of
 * `{bbox, category, text}` in reading order over eleven categories, so a page
 * arrives with WHERE as well as WHAT — and every rule below is something that
 * becomes possible only once you have both, and was earned against a real book
 * with a real defect in it:
 *
 *  - **The boxes are in the MODEL's frame, not the render's.** A Qwen-family
 *    vision tower resizes its input to a multiple of 28 with the area inside
 *    `[min_pixels, max_pixels]`, and answers in that space. `smartResize` is
 *    that arithmetic, and the scale it yields is applied to every box here, at
 *    the edge, so that nothing downstream ever holds a coordinate in two
 *    frames. Get the budget wrong and every box is a few per cent off: pictures
 *    crop slightly wrong and every indent test quietly flips.
 *  - **Markdown inside a text field is consumed, never shown.** dots writes
 *    `# The Lost Empire` and `> ` blockquote runs INSIDE the `text` of a Text
 *    block. Left alone they reach the reader as literal hashes; read here, a
 *    leading-`#` line becomes a real heading and a run of `>` lines becomes a
 *    Quote block.
 *  - **A newline dots emitted is a real line ending.** It reflows wrapped
 *    prose — a paragraph comes back as one long line — so the newlines that
 *    survive are the ones it decided to keep: a contents entry, a verse, a
 *    multi-line heading. They become `<br/>`, not spaces.
 *  - **A footnote marker is a dedicated codepoint.** These arrive as Unicode
 *    superscript digits, which is a fact worth more than it sounds: `¹⁴` is
 *    perfectly distinguishable from the number 14 in the prose, so it can be
 *    made real `<sup>` markup, or removed entirely for a narration build,
 *    without a single heuristic.
 *  - **A page can say what it IS, and most pages cannot.** A title page, a
 *    copyright page, a contents page and a part divider each have one loud
 *    signature, and `classifyPage` names a page only when it fires. Everything
 *    else gets no kind. See the header of that section for why the asymmetry is
 *    the design rather than a limitation.
 *
 * WHAT FAILS HERE FAILS ONE PAGE. A `DotsPageError` names the page and what
 * about it could not be read; `convert.ts` records it and the book carries the
 * hole in its report. That is a deliberate difference from the markdown
 * dialects, where a bad page stops the run: those answers are prose, and a
 * short page is invisible in a finished book. This answer is structured data
 * about one page, the pages are read independently, and the answers are cached
 * — so a page that could not be read is a fact that can be stated, and stating
 * it is better than throwing away 299 good pages.
 */
import { parseXml } from '../epub/xml.js';

/** One page's answer could not be read. Always names the page. */
export class DotsPageError extends Error {
  readonly page: number;

  constructor(page: number, message: string) {
    super(`page ${page}: ${message}`);
    this.name = 'DotsPageError';
    this.page = page;
  }
}

// ── geometry ────────────────────────────────────────────────────────────────

/**
 * 14-pixel patches merged 2×2. The processor rounds every side to a multiple of
 * this, so it is the quantum the model's coordinate space is built out of.
 */
export const PATCH = 28;

/** The floor of the processor's area window, and the same number dots ships. */
export const MIN_PIXELS = PATCH * PATCH * 4;

export interface Size {
  width: number;
  height: number;
}

/**
 * The size the processor resized a page to: multiples of `PATCH`, area inside
 * `[minPixels, maxPixels]`.
 *
 * Ported from the reference implementation, `Math.round` for Python's `round`
 * included — the two differ only on an exact half, which is a quantity of
 * hundredths of a pixel of scale.
 */
export function smartResize(
  height: number,
  width: number,
  maxPixels: number,
  minPixels: number = MIN_PIXELS,
): Size {
  let h = Math.round(height / PATCH) * PATCH;
  let w = Math.round(width / PATCH) * PATCH;
  if (h * w > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    h = Math.floor(height / beta / PATCH) * PATCH;
    w = Math.floor(width / beta / PATCH) * PATCH;
  } else if (h * w < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    h = Math.ceil((height * beta) / PATCH) * PATCH;
    w = Math.ceil((width * beta) / PATCH) * PATCH;
  }
  return { width: w, height: h };
}

/**
 * How much a box has to grow to be back in the render's frame.
 *
 * One number for both axes: `smartResize` quantises each side independently, so
 * the two ratios differ in the third decimal place, and carrying two scales
 * would make a box very slightly non-similar for no gain.
 */
export function renderScale(render: Size, maxPixels: number): number {
  const resized = smartResize(render.height, render.width, maxPixels);
  return render.width / resized.width;
}

export interface DotsBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ── blocks ──────────────────────────────────────────────────────────────────

/**
 * The eleven categories the prompt names, plus `Quote`, which the model does
 * not emit and this file synthesises from a `>` run inside a Text block.
 */
export type DotsCategory =
  | 'Caption'
  | 'Footnote'
  | 'Formula'
  | 'List-item'
  | 'Page-footer'
  | 'Page-header'
  | 'Picture'
  | 'Quote'
  | 'Section-header'
  | 'Table'
  | 'Text'
  | 'Title';

const MODEL_CATEGORIES: ReadonlySet<string> = new Set([
  'Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header',
  'Picture', 'Section-header', 'Table', 'Text', 'Title',
]);

/**
 * Page furniture, dropped before anything else looks at the page.
 *
 * The folio and the running head are not sentences anybody wrote to be read,
 * they land in the middle of a paragraph when the page turns, and a narrator
 * reads them aloud. The markdown dialects can only drop what the model TAGGED;
 * this one is told which blocks they are.
 */
const DROP: ReadonlySet<DotsCategory> = new Set<DotsCategory>(['Page-header', 'Page-footer']);

export interface DotsBlock {
  /** 1-based, the PDF's own numbering. */
  page: number;
  category: DotsCategory;
  /** Scaled into the render's pixel frame. */
  box: DotsBox;
  /** The model's own text, markdown consumed, still unescaped. */
  text: string;
  pageWidth: number;
  pageHeight: number;
}

export interface DotsParsedPage {
  page: number;
  blocks: DotsBlock[];
  /** Page-header and Page-footer blocks removed. */
  dropped: number;
  /**
   * The furthest right and furthest down any box reached, BEFORE scaling.
   *
   * The one observable that says whether the pixel budget this parser was told
   * about is the one the processor used: the model's boxes live inside the
   * resized page, so their extent should sit just under it. `convert.ts` takes
   * the median across the book and refuses a run whose boxes overflow the frame
   * they are supposed to be in — a scale that is silently 30% wrong crops every
   * picture wrong and flips every indent test, and nothing else in the book
   * would say so.
   */
  rawExtent: { x: number; y: number };
}

export interface DotsParseOptions {
  page: number;
  /** The page render, in pixels, at foundry's pinned dpi. */
  render: Size;
  /** The budget the processor actually used — see `VlmModelDef.maxPixels`. */
  maxPixels: number;
}

/**
 * One page's answer → blocks in render space.
 *
 * The fence comes off first: a model asked for JSON in a chat turn sometimes
 * wraps it in ``` — the fence is the chat habit, not the format, the same way
 * `parseQwenHtml` handles it.
 */
export function parseDotsPage(answer: string, opts: DotsParseOptions): DotsParsedPage {
  const { page, render, maxPixels } = opts;
  const body = answer.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (body.length === 0) {
    throw new DotsPageError(page, 'the model answered with nothing at all');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new DotsPageError(
      page,
      `the answer is not JSON (${err instanceof Error ? err.message : String(err)}). `
      + `It starts: ${body.slice(0, 120)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new DotsPageError(page, `the answer parsed as ${typeof raw}, and this dialect's answer is an array of layout elements`);
  }

  const scale = renderScale(render, maxPixels);
  const blocks: DotsBlock[] = [];
  const rawExtent = { x: 0, y: 0 };
  let dropped = 0;

  for (const [index, element] of raw.entries()) {
    if (typeof element !== 'object' || element === null) {
      throw new DotsPageError(page, `element ${index} is ${JSON.stringify(element)}, not a layout element`);
    }
    const el = element as Record<string, unknown>;
    const category = el['category'];
    if (typeof category !== 'string' || !MODEL_CATEGORIES.has(category)) {
      throw new DotsPageError(
        page,
        `element ${index} is categorised "${String(category)}", which is not one of the eleven the`
        + ' prompt names. Nothing here guesses what it meant.',
      );
    }
    const raw = readBox(el['bbox'], page, index, 1);
    rawExtent.x = Math.max(rawExtent.x, raw.x2);
    rawExtent.y = Math.max(rawExtent.y, raw.y2);
    const box = { x1: raw.x1 * scale, y1: raw.y1 * scale, x2: raw.x2 * scale, y2: raw.y2 * scale };
    const text = typeof el['text'] === 'string' ? el['text'].trim() : '';
    if (text.length === 0 && category !== 'Picture') {
      // A Picture has no text by contract. Anything else with none is an empty
      // box, which carries nothing into a book and is not worth a stop.
      continue;
    }

    const block: DotsBlock = {
      page,
      category: category as DotsCategory,
      box,
      text,
      pageWidth: render.width,
      pageHeight: render.height,
    };
    if (DROP.has(block.category)) {
      dropped += 1;
      continue;
    }
    if (
      (block.category === 'Text' || block.category === 'Title' || block.category === 'Section-header')
      && (text.includes('#') || /^>/m.test(text))
    ) {
      blocks.push(...consumeMarkdown(block));
      continue;
    }
    blocks.push(block);
  }

  return { page, blocks, dropped, rawExtent };
}

function readBox(value: unknown, page: number, index: number, scale: number): DotsBox {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new DotsPageError(page, `element ${index} has no four-number bbox (got ${JSON.stringify(value)})`);
  }
  const numbers = value.map((v) => (typeof v === 'number' ? v : Number.NaN));
  if (numbers.some((n) => !Number.isFinite(n))) {
    throw new DotsPageError(page, `element ${index}'s bbox is not four numbers: ${JSON.stringify(value)}`);
  }
  return {
    x1: numbers[0] * scale,
    y1: numbers[1] * scale,
    x2: numbers[2] * scale,
    y2: numbers[3] * scale,
  };
}

// ── markdown inside a text field ────────────────────────────────────────────

const MD_HEADING = /^(#{1,4})\s+(.*)$/;
const MD_QUOTE = /^>\s?(.*)$/;

/**
 * Split a block on the markdown dots wrote inside it.
 *
 * `# The Lost Empire` at the top of a Text block is a heading the model
 * recognised and reported in the only channel the prompt gave it; a run of `> `
 * lines is a block quote. Both reach the reader as literal punctuation if
 * nothing consumes them. The sub-blocks keep the parent's box, because the
 * parent's box is the only measurement there is — and the alignment rules below
 * are about a block's place on the page, which every part of it shares.
 */
export function consumeMarkdown(block: DotsBlock): DotsBlock[] {
  const out: DotsBlock[] = [];
  const plain: string[] = [];
  const quote: string[] = [];

  const sub = (category: DotsCategory, text: string): DotsBlock => ({ ...block, category, text });
  const flushPlain = (): void => {
    if (plain.length === 0) return;
    out.push(sub(block.category, plain.join('\n')));
    plain.length = 0;
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    out.push(sub('Quote', quote.join('\n')));
    quote.length = 0;
  };

  for (const line of block.text.split('\n')) {
    const trimmed = line.trim();
    const heading = MD_HEADING.exec(trimmed);
    const quoted = MD_QUOTE.exec(trimmed);
    if (heading) {
      flushPlain();
      flushQuote();
      out.push(sub(heading[1].length === 1 ? 'Title' : 'Section-header', heading[2].trim()));
      continue;
    }
    if (quoted) {
      flushPlain();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();
    plain.push(line);
  }
  flushPlain();
  flushQuote();

  return out.length > 0 ? out : [block];
}

// ── inline markup ───────────────────────────────────────────────────────────

/** The five predefined entities. Same rule as `src/export/epub.ts`. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Characters XML 1.0 cannot represent at all, escaped or otherwise. */
function stripIllegalXml(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

/**
 * Superscript DIGITS, and only digits.
 *
 * The wider superscript block — `ⁿ`, `⁺`, `⁽` — belongs to formulae, and this
 * dialect has a Formula category for those. What is being recognised here is
 * one specific thing: a footnote reference number, which these books set as
 * dedicated codepoints and which is therefore identifiable without a single
 * heuristic about the surrounding prose.
 */
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
export const SUPERSCRIPT_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g;

export interface DotsInlineOptions {
  /**
   * Remove footnote reference numbers instead of marking them up.
   *
   * `--strip-note-markers`, and it is for a narration build: a `<sup>14</sup>`
   * is invisible typography to a reader and the word "fourteen" to a narrator.
   * Off by default — the numbers are the book's, and a book that silently lost
   * its references is a book somebody has to check.
   */
  stripNoteMarkers?: boolean;
}

/**
 * A block's text → XHTML content.
 *
 * Escaping first, so a `<` in the book's prose is `&lt;` before a single
 * element is written and cannot open one. The markdown characters survive
 * escaping, which is what makes the order safe.
 */
export function dotsInline(raw: string, opts: DotsInlineOptions = {}): string {
  let out = escapeXml(stripIllegalXml(raw));
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![*\w])\*(?=\S)([\s\S]*?\S)\*(?!\w)/g, '<em>$1</em>');
  out = out.replace(SUPERSCRIPT_RUN, (run) => {
    if (opts.stripNoteMarkers) return '';
    const digits = [...run].map((c) => String(SUPERSCRIPT_DIGITS.indexOf(c))).join('');
    return `<sup>${digits}</sup>`;
  });
  // The one place a newline is content. dots reflows wrapped prose, so a break
  // it kept is a break the page had: a contents entry, a line of verse, the
  // second line of a heading.
  return out.replace(/\n/g, '<br/>\n');
}

/** Markup back out, for a heading used as a TOC label. */
export function plainText(xhtml: string): string {
  return xhtml
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// ── the book as its own dictionary ──────────────────────────────────────────

const WORD_SOURCE = '[A-Za-zÀ-ÿ]+';
const WORD_HEAD = new RegExp(`^${WORD_SOURCE}`);
const WORD_TAIL = new RegExp(`(${WORD_SOURCE})-$`);
const LINE_BREAK_HYPHEN = new RegExp(`(${WORD_SOURCE})-\\n(${WORD_SOURCE})`, 'g');
const LEXICON_WORD = new RegExp(`${WORD_SOURCE}(?:-${WORD_SOURCE})+|${WORD_SOURCE}`, 'g');

/**
 * Every word in the book, and every hyphenated compound in it.
 *
 * A line-final hyphen is ambiguous in exactly one way that matters: `self-` at
 * the end of a line is either a word broken by the column or half of
 * `self-determination`. No general dictionary settles it, because the answer
 * depends on this author's usage — but THIS BOOK does, and it is right here.
 * Nothing is fetched, nothing is trained, and a book of German compounds gets a
 * German lexicon for free.
 */
export class BookLexicon {
  private readonly words = new Set<string>();

  constructor(texts: Iterable<string>) {
    for (const text of texts) {
      for (const match of text.matchAll(LEXICON_WORD)) this.words.add(match[0].toLowerCase());
    }
  }

  has(word: string): boolean {
    return this.words.has(word.toLowerCase());
  }

  get size(): number {
    return this.words.size;
  }

  /**
   * `Ko` + `reans` → `Koreans` (the fused form is in the book);
   * `self` + `determination` → `self-determination` (the compound is);
   * neither → fuse when the continuation is lowercase, which is a column break,
   * and keep the hyphen when it opens a capital, which is a compound.
   */
  join(head: string, tail: string): string {
    const fused = head + tail;
    if (this.has(fused)) return fused;
    const hyphenated = `${head}-${tail}`;
    if (this.has(hyphenated)) return hyphenated;
    return tail.charAt(0) === tail.charAt(0).toLowerCase() ? fused : hyphenated;
  }

  /** Repair every hyphen the page broke a word on, inside one block. */
  dehyphenate(text: string): string {
    return text.replace(LINE_BREAK_HYPHEN, (_m, head: string, tail: string) => this.join(head, tail));
  }
}

/** The `word-` a joined paragraph ended on, if it ended on one. */
export function trailingHyphenWord(text: string): string | null {
  const match = WORD_TAIL.exec(text.trimEnd());
  return match ? match[1] : null;
}

/** The word a block opens with, if it opens with one. */
export function leadingWord(text: string): string | null {
  const match = WORD_HEAD.exec(text);
  return match ? match[0] : null;
}

// ── alignment, judged against the book's own column ─────────────────────────

export interface BodyColumn {
  x1: number;
  x2: number;
}

/**
 * The book's body column: the median left and right edge of its full-width Text
 * blocks.
 *
 * This exists because the obvious test is wrong. A justified body column is
 * itself centered on the paper — this book's is about 70% of the page width —
 * so "is this block centered on the PAGE" is true of every ordinary paragraph
 * in it, and a page-relative rule marks the whole book as centered text. What
 * "centered" means to a reader is centered WITHIN THE COLUMN, and the column is
 * a fact about the book that only the book can supply.
 */
export function bodyColumn(blocks: readonly DotsBlock[], fallbackWidth: number): BodyColumn {
  const wide = blocks.filter((b) => b.category === 'Text' && widthFraction(b) > 0.5);
  if (wide.length === 0) return { x1: 0, x2: fallbackWidth };
  const lefts = wide.map((b) => b.box.x1).sort((a, b) => a - b);
  const rights = wide.map((b) => b.box.x2).sort((a, b) => a - b);
  return { x1: lefts[Math.floor(lefts.length / 2)], x2: rights[Math.floor(rights.length / 2)] };
}

/** `''`, `centered` or `right` — the class the block gets, or none. */
export type DotsAlign = '' | 'centered' | 'right';

/**
 * Where a block sits in the column.
 *
 * Centered is BALANCED MARGINS, both of them real. A left-anchored contents
 * entry — `II THE CONFESSING CHURCH …` — passes a midpoint test whenever it
 * happens to reach past the middle of the column, and there is no way to tell
 * it from a centered line by its midpoint alone. It cannot fake a left gap.
 */
export function alignmentClass(box: DotsBox, column: BodyColumn): DotsAlign {
  const width = Math.max(1, column.x2 - column.x1);
  const left = (box.x1 - column.x1) / width;
  const right = (column.x2 - box.x2) / width;
  if (left > 0.06 && right > 0.06 && Math.abs(left - right) < 0.4 * Math.max(left, right)) {
    return 'centered';
  }
  if (left > 0.45 && right < 0.03) return 'right';
  return '';
}

export function widthFraction(block: DotsBlock): number {
  return (block.box.x2 - block.box.x1) / block.pageWidth;
}

export function topFraction(block: DotsBlock): number {
  return block.box.y1 / block.pageHeight;
}

/** Distance from the PAGE's centre line, as a fraction of the page width. */
export function centerOffset(block: DotsBlock): number {
  return Math.abs((block.box.x1 + block.box.x2) / 2 - block.pageWidth / 2) / block.pageWidth;
}

/**
 * One line's height, from the box and what is in it.
 *
 * Three estimates, and the largest line count wins: at least one line, one per
 * newline the model kept, and one per 40 pixels of box height. The last is the
 * only one that works on a reflowed paragraph, where the model kept no newlines
 * at all; 40 px is a line of 10 pt type at 200 dpi with leading.
 */
export function lineHeight(block: DotsBlock): number {
  const height = block.box.y2 - block.box.y1;
  const lines = Math.max(1, (block.text.match(/\n/g)?.length ?? 0) + 1, Math.round(height / 40));
  return height / lines;
}

/**
 * Does this text look like it continues the previous paragraph?
 *
 * The cheap half of the cross-page join: the previous block did not end on
 * terminal punctuation and this one opens lowercase. It is the test that costs
 * nothing; `dots-book.ts` reaches for the ink of the page only when this one
 * says no.
 */
export function continuesTextually(previous: string, next: string): boolean {
  if (previous.length === 0 || next.length === 0) return false;
  if (/[.!?:"”]$/.test(previous.trimEnd())) return false;
  const first = next.charAt(0);
  return first !== first.toUpperCase();
}

// ── what a page IS ──────────────────────────────────────────────────────────

/**
 * The kinds of page this dialect will name, and there are only five.
 *
 * A book's front matter and its part dividers are pages a reader skips and a
 * NARRATOR must not read: a title page read aloud is the book's title said
 * twice, a copyright page is a minute of ISBNs, and a contents page is a list
 * of numbers. The picker can delete them in one click — but only if something
 * tells it which pages they are, and this is that.
 *
 * NOT EVERY BOOK HAS THIS STRUCTURE. An article has none of it, an extract has
 * none of it, and a bare typescript has none of it. So every rule below is a
 * LOUD signature or nothing: a page the classifier cannot read simply gets no
 * kind, which is the ordinary outcome and never an error. The asymmetry is the
 * whole design — an unlabelled page costs a person one click in the picker, and
 * a MISLABELLED one puts a lie in the nav that nobody looking at the finished
 * book can see. Every threshold here is therefore set where it refuses.
 */
export type DotsPageKind = 'title-page' | 'copyright' | 'contents' | 'part' | 'chapter';

export interface DotsPageVerdict {
  kind: DotsPageKind;
  /** Every signature that fired, so the verdict can be read rather than trusted. */
  why: string[];
  /**
   * A label the page's own words justify, when the section's first heading is
   * not the whole of it.
   *
   * Only a `part` sets one: its number and its name are two separate blocks on
   * the page, and a nav entry reading `III` alone tells a reader nothing. Null
   * everywhere else, where the first heading of the section IS the label.
   */
  label: string | null;
}

/** Where a page sits in the book. Both facts come from the book, not the page. */
export interface DotsPagePlace {
  /** 0-based position among the book's pages, in reading order. */
  index: number;
  /** Does any LATER page carry body prose? A part opens something. */
  bodyFollows: boolean;
}

/**
 * How many pages at the front of a book may be front matter.
 *
 * A window rather than a search, because the thing being excluded is the
 * mid-book page that LOOKS like a title page: a part divider is also a page of
 * nothing but centered display type, and outside the front of a book that is
 * what it usually is. Six is the conventional depth of half-title, title,
 * copyright, dedication — and a book whose second half-title falls past it goes
 * unlabelled, which is the cheap failure.
 */
export const FRONT_MATTER_PAGES = 6;

/** A block that is set as display type — the only kind a divider page carries. */
const DISPLAY: ReadonlySet<DotsCategory> = new Set<DotsCategory>(['Title', 'Section-header']);

/** Emphasis markers out, so a contents entry italicised whole still ends in its page number. */
function unemphasise(text: string): string {
  return text.replace(/[*_]/g, ' ').trim();
}

/** The block's text on one line, for a label. */
function oneLine(text: string): string {
  return unemphasise(text).replace(/\s+/g, ' ').trim();
}

export function wordCount(text: string): number {
  return unemphasise(text).split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * A real paragraph of the book's prose, in words.
 *
 * The number that separates `BLANK PAGE` and a two-line dedication from a page
 * that is actually being read. Deliberately low: what is being detected is the
 * ABSENCE of prose, so the test has to fail on the shortest genuine paragraph
 * rather than on the longest divider.
 */
const BODY_PARAGRAPH_WORDS = 25;

/** Does this page carry a paragraph somebody wrote to be read? */
export function carriesBodyProse(blocks: readonly DotsBlock[]): boolean {
  return blocks.some((b) => isProse(b) && wordCount(b.text) >= BODY_PARAGRAPH_WORDS);
}

function isProse(block: DotsBlock): boolean {
  return !DISPLAY.has(block.category) && block.category !== 'Picture';
}

function proseWords(blocks: readonly DotsBlock[]): number {
  return blocks.filter(isProse).reduce((sum, b) => sum + wordCount(b.text), 0);
}

/** A divider page carries nothing but its own announcement. */
const SPARSE_BLOCKS = 8;
const SPARSE_WORDS = 12;

/**
 * What this page is, or nothing.
 *
 * The order is the order of certainty. A contents page announces itself in
 * words and is placed nowhere in particular, so it is asked first and asked
 * everywhere; the front-matter kinds are asked only at the front; a part
 * divider is asked only past it. `chapter` is not decided here — it is
 * `proposeChapters` in `dots-book.ts`, which was already the rule and stays it.
 */
export function classifyPage(
  blocks: readonly DotsBlock[],
  place: DotsPagePlace,
): DotsPageVerdict | null {
  if (blocks.length === 0) return null;
  const contents = contentsVerdict(blocks);
  if (contents !== null) return contents;
  if (place.index < FRONT_MATTER_PAGES) {
    return copyrightVerdict(blocks) ?? titlePageVerdict(blocks);
  }
  return partVerdict(blocks, place);
}

/**
 * A title page: display type, centered, and nothing else on the paper.
 *
 * The subtitle and the author's name are ordinary Text blocks — a title page is
 * not all headings — so what is measured is that there are FEW of them and they
 * are SHORT. `SPARSE_WORDS` is twelve because `Protestant Protest Against
 * Hitler` + `Victoria Barnett` is six, and one full sentence of prose is more.
 *
 * At least one real heading is required, and that is what keeps a dedication
 * page ("For Ruth, sine qua non", three short Text blocks, centered) out: it is
 * sparse and centered and it is not a title page.
 */
function titlePageVerdict(blocks: readonly DotsBlock[]): DotsPageVerdict | null {
  const display = blocks.filter((b) => DISPLAY.has(b.category));
  if (display.length === 0) return null;
  if (blocks.length > SPARSE_BLOCKS) return null;
  const other = proseWords(blocks);
  if (other > SPARSE_WORDS) return null;
  if (!display.every((b) => centerOffset(b) < 0.06)) return null;
  return {
    kind: 'title-page',
    why: ['display-heading', `${other}-other-words`, 'centered'],
    label: null,
  };
}

/**
 * The copyright page, recognised by the boilerplate that is on every one of
 * them and nowhere else in a book.
 *
 * TWO marks, never one. `Copyright` alone appears in a bibliography entry and
 * in a permissions note; `ISBN` alone appears in a list of further reading. The
 * conjunction is what no other page in a book produces, and requiring it is why
 * this rule can be run over prose pages without labelling one.
 *
 * A heading disqualifies the page outright: a copyright page has no title, and
 * a page that has one is announcing itself as something else.
 */
function copyrightVerdict(blocks: readonly DotsBlock[]): DotsPageVerdict | null {
  if (blocks.some((b) => DISPLAY.has(b.category))) return null;
  const text = blocks.map((b) => b.text).join('\n');
  const why = COPYRIGHT_MARKS.filter(([, test]) => test(text)).map(([name]) => name);
  if (why.length < 2) return null;
  return { kind: 'copyright', why, label: null };
}

const COPYRIGHT_MARKS: ReadonlyArray<readonly [string, (text: string) => boolean]> = [
  ['copyright-mark', (t) => /©|\bcopyright\b/i.test(t)],
  ['isbn', (t) => /\bISBN\b/i.test(t)],
  ['all-rights-reserved', (t) => /all rights reserved/i.test(t)],
  ['library-of-congress', (t) => /library of congress/i.test(t)],
  // The printing history: `10 9 8 7 6 5 4 3 2 1`, or the same line set solid as
  // `135798642`. A whole line of nothing but digits, and enough of them that a
  // stray year or page number cannot be it.
  ['printing-history', (t) => t.split('\n').some((line) => {
    const trimmed = line.trim();
    return /^[\d ]+$/.test(trimmed) && (trimmed.match(/\d/g)?.length ?? 0) >= 5;
  })],
];

/**
 * The book's own contents page: the word, and then the numbers.
 *
 * The heading alone is not enough — `Contents` is also a section heading inside
 * a reference work — so what confirms it is the SHAPE of what follows: short
 * lines that end in a page number, which is a thing no page of prose does three
 * times running.
 */
const CONTENTS_HEADING = /^(table of )?contents$/i;
const CONTENTS_ENTRIES = 3;
const CONTENTS_ENTRY_CHARS = 100;
/** `The Weimar Years, 18` — anything, then a page number, then the line ends. */
const CONTENTS_ENTRY = /[^\d\s]\s*[,.]?\s*\d{1,4}[.,]?$/;

function contentsVerdict(blocks: readonly DotsBlock[]): DotsPageVerdict | null {
  const heading = blocks.find(
    (b) => DISPLAY.has(b.category) && CONTENTS_HEADING.test(unemphasise(b.text)),
  );
  if (heading === undefined) return null;
  let entries = 0;
  for (const block of blocks) {
    if (block === heading) continue;
    for (const line of unemphasise(block.text).split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.length > CONTENTS_ENTRY_CHARS) continue;
      if (CONTENTS_ENTRY.test(trimmed)) entries += 1;
    }
  }
  if (entries < CONTENTS_ENTRIES) return null;
  return { kind: 'contents', why: ['contents-heading', `${entries}-numbered-entries`], label: null };
}

/**
 * A part divider: a page that announces a division and carries nothing else.
 *
 * Two spellings, and the difference between them is everything this rule knows
 * about its own danger:
 *
 *  - `Part Two`, `Book III` — the word is on the page, and there is nothing
 *    else it could be.
 *  - a BARE numeral with a short title beside it — which is what a real book
 *    does (`III` / `RESISTANCE AND GUILT`) and is also what a chapter opener
 *    does. So the bare form is accepted for a ROMAN numeral only. Parts are
 *    numbered in roman by convention and chapters in arabic; a bare `5` on a
 *    divider page is a chapter as often as it is a part, and a part invented
 *    there would swallow every chapter after it in the nav. The roman rule is
 *    canonical (`IIII` is not a numeral) so that a short word made of I, V, X,
 *    L, C, D and M — `CIVIL`, `MILD` — cannot pass for one.
 *
 * Both forms additionally require the page to be NEARLY EMPTY. A chapter that
 * opens with its title also opens with its first paragraph; a divider is alone
 * on the paper. That is the measurement that separates them, and it is the
 * reason this rule can be asked of every page in the body of a book.
 */
const PART_HEADING = new RegExp(
  '^(part|book|section|volume)\\s+'
  + '([ivxlcdm]+|\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b',
  'i',
);
const ROMAN_NUMERAL = /^(?=[ivxlcdm])m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})\.?$/i;
const PART_BLOCKS = 6;
const PART_TITLE_WORDS = 8;

function partVerdict(
  blocks: readonly DotsBlock[],
  place: DotsPagePlace,
): DotsPageVerdict | null {
  // A part opens something. The last divider-shaped page in a book is a colophon.
  if (!place.bodyFollows) return null;
  if (blocks.length > PART_BLOCKS) return null;
  if (proseWords(blocks) > SPARSE_WORDS) return null;
  const display = blocks.filter((b) => DISPLAY.has(b.category));
  if (display.length === 0) return null;

  const named = display.find((b) => PART_HEADING.test(unemphasise(b.text)));
  if (named !== undefined) {
    return { kind: 'part', why: ['part-heading', 'near-empty-page'], label: oneLine(named.text) };
  }

  const numeral = display.find((b) => ROMAN_NUMERAL.test(unemphasise(b.text)));
  if (numeral === undefined) return null;
  const titled = blocks.find(
    (b) => b !== numeral && b.category !== 'Picture'
      && wordCount(b.text) > 0 && wordCount(b.text) <= PART_TITLE_WORDS,
  );
  if (titled === undefined) return null;
  return {
    kind: 'part',
    why: ['roman-numeral', 'short-title', 'near-empty-page'],
    label: `${oneLine(numeral.text)} ${oneLine(titled.text)}`,
  };
}

/**
 * A Table block's text is HTML by contract, and it goes into the book as the
 * model wrote it — so it is checked here, at the page, where a failure can name
 * the page it came from.
 *
 * Never repaired: a tag guessed shut moves somebody's rows into somebody else's
 * table. This is `dialect.ts`'s rule and this dialect obeys it, with the one
 * difference that the stop is scoped to a page.
 */
export function checkTableHtml(fragment: string, page: number): string {
  try {
    parseXml(`<foundry-dots-fragment>${fragment}</foundry-dots-fragment>`, 'xhtml');
  } catch (err) {
    throw new DotsPageError(
      page,
      `a Table block's HTML is not well-formed (${err instanceof Error ? err.message : String(err)})`
      + `. The fragment starts: ${fragment.slice(0, 120)}`,
    );
  }
  return fragment.trim();
}
