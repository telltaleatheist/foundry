/**
 * vlm/typography — the book's own type sizes, measured off the boxes.
 *
 * THIS FILE REVERSES A RULE THIS PROGRAM USED TO PRINT IN ITS OWN STYLESHEET.
 * The header of `dots-book.ts`'s stylesheet said "No per-book font decisions,
 * ever", and it said it for a good reason: a size guessed from one page is a
 * size that is wrong on every other page, and a reflowable book that carries a
 * publisher's point sizes into a reader that has its own is a book that fights
 * the reader. What changed is not the reasoning, it is the EVIDENCE. This
 * dialect answers with a box around every block, so a book's footnotes are not
 * guessed to be smaller than its prose — they are MEASURED smaller, over every
 * footnote in the book, against every paragraph in it. That is the same kind of
 * fact as `bodyColumn`'s column and `BookLexicon`'s vocabulary: a measurement
 * the book itself supplies, which no static default can know.
 *
 * Everything below is therefore expressed as a RATIO, never as a point size.
 * The reader still chooses how big the book is; what is derived here is how big
 * a footnote is RELATIVE TO the prose it belongs to, which is a decision the
 * book's designer made and which a fixed 0.85em silently overrides.
 *
 * THE PROXY IS A BLOCK'S BOX OVER ITS LINES, AND COUNTING THE LINES IS THE
 * WHOLE PROBLEM — see `typeSize`. For a paragraph the model reflowed there is
 * no line count left in the text at all and the only estimate available is
 * `round(height / 40)`, `lineHeight`'s own; it quantises, so such a block reads
 * somewhere in `40 ± 20/n` pixels HOWEVER uniform the printed type is — a
 * three-line paragraph anywhere between 33 and 47. That wobble is arithmetic,
 * not typography, and every threshold in this file is set outside it.
 *
 * A CATEGORY WITH TOO FEW BLOCKS GETS NO RULE AT ALL. That is `classifyPage`'s
 * pattern, deliberately: absence of evidence is not evidence, so a book with
 * three captions in it keeps the static default for captions and nothing here
 * says a word about them. The alternative — a whole book's caption size set by
 * one loosely-drawn box — is a decision that looks measured and is not.
 *
 * WHAT COMES OUT IS ONE SIZE PER CATEGORY AND NOTHING PER BLOCK. Every footnote
 * in the book is the size this book's footnotes are; every chapter title is the
 * size its titles are. There is no path from here to an element carrying a size
 * of its own — `TypographyReport` records the pass that used to, and the ruling
 * that ended it.
 */
import { lineHeight, widthFraction, type DotsBlock, type DotsCategory } from './dots.js';

/**
 * The categories whose size is worth deriving, and why these five.
 *
 * Each of them has a font-size in the static stylesheet that this can replace,
 * and each is a thing a designer sizes DELIBERATELY against the body: notes and
 * captions smaller, headings larger, a block quote a shade down. `Text` is not
 * in the list because Text IS the baseline — it is what the ratios are ratios
 * of. `List-item`, `Table`, `Formula` and `Picture` are not, because a box
 * around one of those is not a box around a line of type: a List-item block
 * covers a whole run of items, a Table's box is its rows, a Formula's is its
 * own layout, and a Picture has no type in it at all.
 */
const CALIBRATED: readonly DotsCategory[] = ['Footnote', 'Caption', 'Quote', 'Section-header', 'Title'];

/**
 * How wide a Text block has to be to count towards the body baseline.
 *
 * The same filter, and the same number, as `bodyColumn` in `dots.ts`.
 * `bodyColumn` measures the column's EDGES off this population; `bodyTypeSize`
 * below measures its line height off it, and the comment there says why.
 */
const BODY_WIDTH_FRACTION = 0.5;

/**
 * How many blocks a category needs before its median is a measurement.
 *
 * A median is only a measurement when there is a distribution under it. One
 * sample is that block's box; two is a coin toss between two boxes; three is
 * decided entirely by whichever of the three the model drew loosest, because
 * the middle value IS one of them and the two either side of it cannot outvote
 * it. Four is the first count where the value picked (`sorted[n/2]`, the same
 * median this codebase takes everywhere) has two samples under it and one over,
 * so a single generous box cannot be the answer on its own.
 *
 * Below four there is no derived rule and the static stylesheet stands. See
 * this file's header: that is `classifyPage`'s silence, not a fallback.
 */
const CALIBRATION_SAMPLES = 4;

/**
 * The widest and narrowest ratio that is still a statement about type.
 *
 * A book does not set its footnotes at a fifth of its body size and does not
 * set its chapter titles at four times it. A ratio outside this range is not a
 * design decision that was read correctly, it is a BOX that went wrong — a
 * Title the model boxed around the whole top third of a divider page, a
 * Footnote block drawn around the entire foot of the page including its white
 * space. Clamping rather than discarding, because the direction is still right:
 * the title IS bigger, and 3em is as big as this file is willing to say so.
 */
const RATIO_FLOOR = 0.5;
const RATIO_CEILING = 3.0;

/**
 * The longest a line the PRINTER set actually gets, in characters.
 *
 * Off the same measurement `JUSTIFIED_LINE_CHARS` in `dots-book.ts` is off —
 * Nuremberg, 3,175 non-final lines of justified prose. The distribution's upper
 * hump ends at 79 characters and the entire book contributes 22 lines in the
 * 80-119 bucket. So a block carrying no line break at all and more than 90
 * characters is a paragraph the MODEL reflowed, not a line the printer set, and
 * that is the one case where the box has to be divided by an estimate instead
 * of by a count. Below 90 it is one line and its box is its line height.
 */
const PRINTED_LINE_CHARS = 90;

/** One category's measured size, as a fact and as a ratio. */
export interface TypographyCategory {
  /** The median line height of this category's blocks, in render pixels. */
  medianPx: number;
  /** `medianPx` over the body's, clamped — what the stylesheet writes as `em`. */
  ratio: number;
  /** How many blocks it was taken from. Below `CALIBRATION_SAMPLES` there is no entry at all. */
  samples: number;
}

/**
 * What the book's type says about itself. Nothing here is a point size, and
 * NOTHING HERE IS ABOUT A SINGLE BLOCK.
 *
 * ── The per-block sizes that used to ride along, and why they are gone ───────
 *
 * This carried a `sizes` map as well: an inline `font-size` for every block that
 * measured more than 25% away from its category's median, so that a paragraph
 * the printer set at 12 pt in an 8 pt book stayed bigger in the finished EPUB.
 * The argument was that flattening it is invisible — nothing on the page says
 * the paragraph used to stand out.
 *
 * The argument was answered by looking at one: *"everything should be a
 * uniform, set size. chapter headers, titles, section headers, etc. should all
 * be set to the median size of the blocks in the original document so it doesnt
 * all look ridiculous."* A reflowed book is not a photograph of a page. Every
 * measurement here is a rectangle divided by a line count, and one that lands
 * outside a tolerance is at least as likely to be a box the model drew
 * generously as a decision the printer made — but the FIRST kind is invisible in
 * the report and unmistakable on the page, where it is a paragraph half again
 * the size of the ones either side of it for no reason a reader can see.
 *
 * So the medians stand alone, and they are what the whole file was for: a
 * footnote is the size this book's footnotes are, a title is the size this
 * book's titles are, and every block of a category is the same size as every
 * other block of it. `dotsStylesheet` writes each of them ONCE.
 *
 * THE FACSIMILE IS NOT THIS AND IS UNAFFECTED. There, type must fit the box it
 * was measured out of, so `pdf-text.ts` keeps its own per-block sizing and its
 * own reasons for it. That route is a picture of the page; this one is a book.
 */
export interface TypographyReport {
  /** The median line height of the book's body column, in render pixels. */
  bodyPx: number;
  /** Keyed by dots category, and only the ones with enough blocks to calibrate. */
  categories: Record<string, TypographyCategory>;
}

/**
 * How big this block is printed: its box, over the number of lines that are
 * actually in it.
 *
 * NOT `lineHeight`, AND THE DIFFERENCE IS THE POINT OF THIS FUNCTION. That one
 * takes the LARGEST of three line-count estimates, one of which is
 * `round(height / 40)` — and taking the largest means the answer can never
 * exceed 60 px whatever is in the box, because a box big enough to be a big
 * line is always big enough to be two small ones. A 100 px chapter title on one
 * line comes back as 50, a 120 px one comes back as 40, and 40 is the size of
 * the body text it is three times bigger than. That was harmless for the caller
 * `lineHeight` was written for — the ink test wanted a strip off the bottom of
 * a paragraph, and any plausible line height finds one — and that caller is
 * gone (`dots-book.ts`), which leaves this file its only remaining reader. For
 * a question about TYPE the flattening is fatal: it destroys exactly the
 * distinction being measured.
 *
 * So the line count is taken from the block instead of maximised over guesses:
 *
 *  - the model KEPT line breaks in it → that is the count, verbatim. A break
 *    that survives is a break the page had (`dots.ts`), so a two-line heading
 *    in a 160 px box is two 80 px lines and not four 40 px ones.
 *  - no breaks and under `PRINTED_LINE_CHARS` → it is one line, and its box is
 *    its line height. This is the case `lineHeight` gets wrong.
 *  - no breaks and longer than that → the model reflowed a paragraph and the
 *    count is genuinely gone; fall back to `lineHeight`, whose 40 px estimate
 *    is the only thing that works here and is the number this file quotes its
 *    tolerances against.
 *
 * ONLY VALID BEFORE THE TEXT IS REWRITTEN. Two of the three branches read the
 * newlines, and `dehyphenate` and `reflowWrappedProse` both destroy them — see
 * `measureTypeSizes`.
 */
export function typeSize(block: DotsBlock): number {
  const breaks = block.text.match(/\n/g)?.length ?? 0;
  if (breaks > 0) return (block.box.y2 - block.box.y1) / (breaks + 1);
  if (block.text.length > PRINTED_LINE_CHARS) return lineHeight(block);
  return block.box.y2 - block.box.y1;
}

/**
 * Whether `typeSize` MEASURED this block or estimated it.
 *
 * The first two branches above are measurements — a box divided by lines the
 * model kept, or a box that IS its one line. The third is `lineHeight`'s 40 px
 * guess, which assumes body type: a small-type block the model reflowed comes
 * back body-sized from it, every time, because the guess divides by too few
 * lines. A caller using size as EVIDENCE — `adoptListItemNotes` asking whether
 * a list item is set in note type — must not read the estimate as an answer,
 * in either direction. In a median the error is one voice; as a verdict about
 * one block it is the whole verdict.
 */
export function typeSizeIsMeasured(block: DotsBlock): boolean {
  return block.text.includes('\n') || block.text.length <= PRINTED_LINE_CHARS;
}

/**
 * Every block's type size, measured NOW.
 *
 * WHEN THIS RUNS IS THE WHOLE OF ITS CORRECTNESS. `typeSize` counts a block's
 * lines from the newlines the model kept, and two passes in `buildDotsBook`
 * destroy those newlines: `BookLexicon.dehyphenate` fuses the `word-\nword`
 * seams, and `reflowWrappedProse` replaces every remaining break in a wrapped
 * paragraph with a space. After either of them a five-line paragraph is one
 * short line of text in a five-line box, and its measured size is five times
 * the truth. So this is called immediately after the pages are flattened and
 * before a single character is rewritten, and the answer is carried forward in
 * a map keyed by the block OBJECT — identity survives the rewriting that the
 * text does not.
 *
 * A Picture is skipped: it has a box and no type in it.
 *
 * PIXELS AND NOTHING ELSE. Each entry used to carry a `counted` flag beside the
 * number — whether the line count came off newlines the model kept or off the
 * 40-pixel estimate — which existed to decide whether a measurement was solid
 * enough to ACCUSE one block of being a different size from its peers. Nothing
 * accuses any more (`TypographyReport`): every measurement's only job is to sit
 * in a median, where an estimate's error is one voice in a population and the
 * distinction the flag drew does not change any answer.
 */
export function measureTypeSizes(blocks: readonly DotsBlock[]): Map<DotsBlock, number> {
  const measured = new Map<DotsBlock, number>();
  for (const block of blocks) {
    if (block.category === 'Picture') continue;
    measured.set(block, typeSize(block));
  }
  return measured;
}

/**
 * The book's body type size, in render pixels, or null when the book has no
 * body.
 *
 * Exported because `suppressRunningHeads` needs the same number for a different
 * question — whether a block that recurs at the top of the page is set at body
 * size, which is what tells a running head the model never labelled from a
 * chapter opener that happens to sit high. One definition of "body sized",
 * used by both.
 *
 * `sizeOf` is how the caller already measured, when it has: `buildDotsBook`
 * measured before it rewrote anything and must not measure again, and
 * `suppressRunningHeads` runs before any rewriting at all and can measure
 * directly.
 */
export function bodyTypeSize(
  blocks: readonly DotsBlock[],
  sizeOf: (block: DotsBlock) => number | undefined = typeSize,
): number | null {
  const text = blocks.filter((b) => b.category === 'Text');
  /*
   * The book's body column: full-width Text blocks that are PARAGRAPHS.
   *
   * Two filters and they exclude two different things. Width is `bodyColumn`'s
   * own filter in `dots.ts`, for its own reason: a Text block narrower than
   * half the page is a contents entry, a marginal note, a line of an address —
   * not the column the book's prose is set in.
   *
   * More than one line is the second, and it is about the BOX rather than the
   * words. A one-line Text block — a byline, a dateline, a stray fragment — has
   * a box whose height is a line of type plus whatever slack the model felt
   * like drawing, and the slack is the whole measurement: nothing divides it
   * down. A paragraph's box is several lines and its slack is amortised over
   * all of them, which is what makes its per-line height a measurement of the
   * type instead of a measurement of the model's generosity.
   */
  const column = text.filter((b) => widthFraction(b) > BODY_WIDTH_FRACTION && isParagraph(b));
  // Every Text block when nothing passes. A book of narrow columns — an article
  // in two-up, an extract, a book of one-line entries — has a body type all the
  // same, and refusing to measure it would leave that book with no typography
  // at all rather than with typography off a noisier population. Nothing
  // downstream breaks on a noisy baseline: the ratios are clamped and the
  // outlier tolerance is wide.
  const samples = (column.length > 0 ? column : text)
    .map(sizeOf)
    .filter((px): px is number => px !== undefined && px > 0);
  return samples.length === 0 ? null : median(samples);
}

/**
 * Is this block more than one printed line?
 *
 * Exactly the test `typeSize` uses to decide whether a box may be taken as one
 * line, asked the other way round — a block whose box `typeSize` treats as a
 * single line is not a paragraph, and one it has to divide is.
 */
function isParagraph(block: DotsBlock): boolean {
  return block.text.includes('\n') || block.text.length > PRINTED_LINE_CHARS;
}

/**
 * The book's type, from every box in it.
 *
 * Returns null for a book with no Text block at all — a plate section, a page
 * of tables — because there is no baseline to express anything as a ratio OF,
 * and a ratio against a heading would be a number that looks measured and is
 * not.
 *
 * Safe to call after the text has been rewritten, and that is deliberate: the
 * measurements come from `measured`, which was taken before any of it, and the
 * only thing read off the blocks here is the snippet that names an outlier in
 * the report — which should read the way the finished book reads.
 */
export function deriveTypography(
  blocks: readonly DotsBlock[],
  measured: ReadonlyMap<DotsBlock, number>,
): TypographyReport | null {
  const bodyPx = bodyTypeSize(blocks, (block) => measured.get(block));
  if (bodyPx === null) return null;

  const categories: Record<string, TypographyCategory> = {};
  for (const category of CALIBRATED) {
    const samples = blocks
      .filter((b) => b.category === category)
      .map((b) => measured.get(b))
      .filter((px): px is number => px !== undefined && px > 0);
    if (samples.length < CALIBRATION_SAMPLES) continue;
    const medianPx = median(samples);
    categories[category] = { medianPx, ratio: clamp(medianPx / bodyPx), samples: samples.length };
  }

  // And that is the whole answer. One size per category, taken over the whole
  // book — see `TypographyReport` for the per-block pass that used to follow
  // this loop and the ruling that removed it.
  return { bodyPx, categories };
}

/** The same median every other measurement in this dialect takes. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp(ratio: number): number {
  return Math.min(RATIO_CEILING, Math.max(RATIO_FLOOR, ratio));
}
