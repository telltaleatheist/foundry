/**
 * bands.ts — projection-profile line segmentation for scanned pages.
 *
 * Tesseract's layout analysis silently DROPS whole lines: the region is never
 * handed to the recognizer, so the loss is invisible to confidence scores. This
 * takes layout away from it. We find the text lines ourselves with a horizontal
 * projection profile (rows that carry ink vs rows that do not) and emit one band
 * per line, so a downstream pass can run --psm 7 on crops that contain exactly
 * one line and cannot skip anything.
 *
 * All boxes are [x0, y0, x1, y1] in page pixels, half-open on x1/y1 (PIL crop
 * order), always relative to the FULL page, never to the border-cropped content.
 *
 * A tilted page is STRAIGHTENED before it is profiled, and its boxes are then in
 * the straightened page's pixels. Each page records the angle used as "deskewDeg"
 * (0.0 = untouched, and then the raw render can be cropped directly); anything
 * cropping the render must put it through applyDeskew() with that angle first.
 *
 * No fallbacks: a page that cannot be segmented raises, is reported by number,
 * and makes the run exit nonzero.
 *
 * ---------------------------------------------------------------------------
 * PORTED FROM `tools/ocr-lab/bands.py` in BookForgeApp, geometry unchanged.
 *
 * Every threshold, every comparison and every rounding rule below is the Python
 * original's, and the port is verified the only way a geometry port can be:
 * both implementations are run over the same page renders and the emitted boxes
 * are diffed box-for-box (`test/scan/bands.fixture.test.ts`, fixtures in
 * `fixtures/scan/`). That is why this file reproduces numpy's and Pillow's
 * arithmetic rather than writing the "same" formula in idiomatic TypeScript:
 *
 *   - `pyRound` is round-half-to-EVEN, because Python's `round()` is, and
 *     `int(round(0.5 * pitch))` hits a tie whenever the line pitch is odd.
 *     `Math.round(12.5)` is 13 and Python's is 12; one such pixel moves a band.
 *   - `percentileLinear` reproduces numpy's `linear` interpolation INCLUDING
 *     its two-sided lerp (`gamma >= 0.5` evaluates from the upper sample), and
 *     `medianOf` reproduces `np.median`'s mean-of-the-middle-two, which is a
 *     different rounding from `np.percentile(x, 50)`.
 *   - `localPaper` reproduces Pillow's BILINEAR `resize` coefficient
 *     precomputation and its float32 intermediate image, because the paper-tone
 *     estimate feeds a strict `<` against integer pixel values and a one-ulp
 *     difference there flips a pixel to ink.
 *   - `applyDeskew` reproduces Pillow's BICUBIC affine transform: the a=-1
 *     cubic, edge-clamped 4-taps, the `[-0.5, size-0.5)` source-bounds test,
 *     and clip8's TRUNCATION (not rounding) to uint8. All four were measured
 *     against Pillow 10.4 rather than assumed.
 */

import type { GrayRaster } from './pgm.js';

// Ink is 25% darker than its LOCAL paper tone (and at least 15 levels darker, so
// scanner noise on bright paper does not qualify). Relative rather than absolute
// because these scans are unevenly lit: paper reads 158 mid-page and 85 in the
// corner shadow, and one absolute cut cannot serve both. The only pixel-level
// constants in the file; everything about line geometry is derived per page.
const INK_RATIO = 0.75;
const INK_FLOOR = 15;
const BG_BLOCK = 64;          // local-paper estimation block, px (>= 2 line pitches)
const CROP_PAD = 4;           // recognition crop padding, px (10 collapsed adjacent lines)
const GAP_ROWS = 1;           // need this many + 1 consecutive sub-threshold rows to end a band
const TALL_FACTOR = 2.5;      // band taller than this * median = suspected merged lines
const RUN_FACTOR = 2.5;       // column ink run this * median = scan strip, not type
const ONROW_BIAS = 0.25;      // how far from "blind mark" to "type" an edge flag may sit
export const COVERAGE_EPS = 0.005;  // missed ink above this fraction gets the page flagged
// Edge-trim share that counts as unusual. The routine strip along this scan's
// outer edge is 1.4% of a page's ink at the median and 7.3% at p95 - all of it
// verified by eye to be shadow, not type - so only the tail is worth a flag.
export const TRIM_EPS = 0.15;
// DESKEW. A projection profile cannot see a line it is not parallel to: tilt the
// page and the blank leading between two lines stops being a blank ROW, so the
// rows never fall below threshold and the two lines come back as one band. On
// deathstalker rebellion that merged 1.69% of the book's bands (against 0.19% on
// its straight sibling) and cost 1.53% of the text. So the page is straightened
// before it is profiled.
const DESKEW_MAX_DEG = 3.0;   // search bound; a book scan past this is a different problem
const DESKEW_COARSE = 0.25;   // coarse step, deg
const DESKEW_FINE = 0.025;    // fine step over +-1 coarse step, deg
// Below this the rotation is not worth its own resampling: a tenth of a degree
// moves the end of a 600 px line by half a pixel, which no profile can see. A
// page under the threshold is left ALONE - not rotated by zero, not resampled -
// so a straight book comes out of this change byte for byte as it went in.
// (estimateSkew has a dead zone of its own, wider than this - see there.)
export const DESKEW_MIN_DEG = 0.1;
const DESKEW_MIN_INK = 500;   // ink points below which a page has no angle to find
const DESKEW_MAX_POINTS = 300000;  // ink points the angle search runs on (strided, not random)

const DEG2RAD = Math.PI / 180;

// -------------------------------------------------------------------- types

/** Content rectangle, half-open, in page pixels. */
export interface Rect {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

export type Box = [number, number, number, number];

export interface Band {
  /** Ink extent of the line, [x0,y0,x1,y1], half-open, full-page pixels. */
  tight: Box;
  /** `tight` grown by CROP_PAD and clipped to the page — what the recognizer sees. */
  crop: Box;
  /** Taller than TALL_FACTOR x the page median: suspected merged lines. */
  tall: boolean;
}

export interface PageStats {
  medianPitch: number;
  inkThreshold: number;
  minBandH: number;
  medianBandH: number;
  xHeightPx: number;
  // inkPx is the denominator of coverageMissed. A blank page carries a few dozen
  // ink pixels of dirt, so its coverage fraction swings wildly on nothing; read
  // the two together.
  inkPx: number;
  trimmedInkPx: number;
  coverageMissed: number;
}

export interface PageBands {
  page: number;
  widthPx: number;
  heightPx: number;
  columns: number;
  /** [x0, x1, y0, y1] — note the ORDER, which is the Python original's. */
  contentRect: [number, number, number, number];
  stats: PageStats;
  // Every box in this file is in DESKEWED page pixels. A reader that crops the
  // render must straighten it the same way first, which is what this field is
  // for; it is handed straight back to applyDeskew(). 0.0 means the page was
  // left alone and the render can be cropped raw.
  deskewDeg: number;
  bands: Band[];
}

/** A page that could not be segmented, carrying the page number with it. */
export class PageSegmentationError extends Error {
  constructor(readonly page: number, readonly reason: string) {
    super(`page ${page}: ${reason}`);
    this.name = 'PageSegmentationError';
  }
}

// ------------------------------------------------- python/numpy arithmetic

/**
 * Python's `round()` — round half to EVEN, unlike JavaScript's round half up.
 * `int(round(0.5 * pitch))` in the band grower ties on every odd pitch, and the
 * two conventions disagree there by a pixel.
 */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;                     // exact for |x| < 2^52
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Python's `round(x, ndigits)` — correctly rounded to `nd` decimal places, ties
 * to even, computed on the double's EXACT value rather than on its shortest
 * printed form. `toFixed` breaks ties away from zero, which is a different
 * function; the exact ties are rare but they are reachable (3.25 is a double).
 */
export function pyRoundTo(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  const { mantissa, exponent } = decompose(ax);       // ax = mantissa * 2^exponent
  const pow10 = 10n ** BigInt(nd);
  let q: bigint;
  if (exponent >= 0) {
    q = mantissa * pow10 * (1n << BigInt(exponent));  // already an integer, no tie
  } else {
    const den = 1n << BigInt(-exponent);
    const num = mantissa * pow10;
    q = num / den;
    const rem = num % den;
    const twice = rem * 2n;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  }
  const digits = q.toString().padStart(nd + 1, '0');
  const text = nd === 0 ? digits : `${digits.slice(0, digits.length - nd)}.${digits.slice(digits.length - nd)}`;
  const value = Number(text);
  return neg ? -value : value;
}

/** A finite non-negative double as `mantissa * 2^exponent`, both exact. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  if (x === 0) return { mantissa: 0n, exponent: 0 };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const rawExp = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (rawExp === 0) return { mantissa: frac, exponent: -1074 };
  return { mantissa: frac | (1n << 52n), exponent: rawExp - 1075 };
}

/**
 * numpy's `linear` percentile over an already-sorted sample.
 *
 * The two-sided lerp is numpy's, not a flourish: at `gamma >= 0.5` it evaluates
 * down from the upper sample instead of up from the lower one, and the two
 * spellings do not always round to the same double.
 */
export function percentileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error('percentile of an empty sample');
  const virtual = (n - 1) * (q / 100);
  const previous = Math.floor(virtual);
  const gamma = virtual - previous;
  const a = sorted[Math.min(Math.max(previous, 0), n - 1)]!;
  const b = sorted[Math.min(Math.max(previous + 1, 0), n - 1)]!;
  const diff = b - a;
  return gamma >= 0.5 ? b - diff * (1 - gamma) : a + diff * gamma;
}

/** `np.percentile(values, q)` — sorts a copy, so the caller's array is safe. */
export function percentileOf(values: ArrayLike<number>, q: number): number {
  const copy = Float64Array.from(values as ArrayLike<number>);
  copy.sort();
  return percentileSorted(copy, q);
}

/**
 * `np.median` — the MEAN of the middle two on an even sample, which is not the
 * same rounding as `np.percentile(x, 50)`'s lerp. bands.py uses both.
 */
export function medianOf(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) throw new Error('median of an empty sample');
  const copy = Float64Array.from(values as ArrayLike<number>);
  copy.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? copy[mid]! : (copy[mid - 1]! + copy[mid]!) / 2;
}

// ------------------------------------------------------------- page loading

function grayAt(gray: GrayRaster, y: number, x: number): number {
  return gray.data[y * gray.width + x]!;
}

/**
 * Find the scan border: near-black rows/columns hugging the page edge.
 *
 * Counted as ink, a border makes every row look inky and the whole page comes
 * back as one band. Rather than cropping a fixed margin (a per-book constant in
 * disguise) we walk inward from each edge while the edge line is mostly
 * NEAR-BLACK, tolerating a few light lines inside the border, and stop at the
 * first real paper. Soft vignettes and corner shadows are deliberately NOT
 * handled here - they are paper, just dim, and localPaper() reads them as
 * paper. This is only for the hard black margin of a platen scan.
 *
 * Returns the content rectangle, half-open.
 */
export function detectBorder(gray: GrayRaster): Rect {
  const h = gray.height;
  const w = gray.width;
  const paper = percentileOfBytes(gray.data, 80);
  // Only a genuinely black page is an error; a dark cover scan is not, and the
  // ink test is relative so it works at any brightness.
  if (paper < 30) {
    throw new Error(`page is black (paper tone ${paper.toFixed(0)}) - not a scan?`);
  }
  const cut = 0.35 * paper;
  const rowFrac = new Float64Array(h);
  const colCount = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    let n = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (gray.data[base + x]! < cut) {
        n++;
        colCount[x] = colCount[x]! + 1;
      }
    }
    rowFrac[y] = n / w;
  }
  const colFrac = new Float64Array(w);
  for (let x = 0; x < w; x++) colFrac[x] = colCount[x]! / h;

  const y0 = walk(rowFrac, Math.floor(h / 8), 0.6);
  const y1 = h - walk(reversed(rowFrac), Math.floor(h / 8), 0.6);
  const x0 = walk(colFrac, Math.floor(w / 8), 0.6);
  const x1 = w - walk(reversed(colFrac), Math.floor(w / 8), 0.6);
  if (y1 - y0 < Math.floor(h / 4) || x1 - x0 < Math.floor(w / 4)) {
    throw new Error(`border detection ate the page: (${y0}, ${y1}, ${x0}, ${x1})`);
  }
  return { y0, y1, x0, x1 };
}

/** `np.percentile(bytes, q)` done off a 256-bin histogram — exact, and O(n). */
function percentileOfBytes(data: Uint8Array, q: number): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]!] = hist[data[i]!]! + 1;
  const n = data.length;
  const virtual = (n - 1) * (q / 100);
  const previous = Math.floor(virtual);
  const gamma = virtual - previous;
  const a = nthByte(hist, previous);
  const b = nthByte(hist, Math.min(previous + 1, n - 1));
  const diff = b - a;
  return gamma >= 0.5 ? b - diff * (1 - gamma) : a + diff * gamma;
}

function nthByte(hist: Int32Array, k: number): number {
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v]!;
    if (k < seen) return v;
  }
  return 255;
}

function reversed(a: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[a.length - 1 - i]!;
  return out;
}

/**
 * Walk in from an edge while the edge line qualifies, tolerating `gap`
 * non-qualifying lines, for at most `limit` lines. Returns lines to drop.
 *
 * A walk that spends its whole allowance without ever reaching paper has not
 * found the inner edge of a border - it has found a page that is dark all the
 * way in, which is a cover, not a margin. A saturated detector is not a
 * detection, so it trims nothing. (Page 531, the back cover, is printed light
 * on near-black: every row of it cleared the near-black test, the walk ran the
 * full h/8 allowance, and the content rect opened 166 px down the page with
 * the first two lines of blurb outside it.)
 */
function walk(frac: Float64Array, limitIn: number, thresh: number, gap = 3): number {
  let last = -1;
  let i = 0;
  const limit = Math.max(0, Math.min(limitIn, frac.length));
  let saturated = limit > 0;
  while (i < limit) {
    if (frac[i]! >= thresh) {
      last = i;
    } else if (i - last > gap) {
      saturated = false;
      break;
    }
    i += 1;
  }
  if (saturated) return 0;
  // +2 shaves the antialiased inner edge of a border we actually found.
  return last >= 0 ? last + 3 : 0;
}

/**
 * Lines to drop from one edge, given a per-line "scan artifact, not type"
 * flag. Everything out to the INNERMOST flagged line inside the allowance goes.
 *
 * walk() cannot start inland: it gives up after `gap` clean lines, so an
 * artifact that leaves a few pixels of paper between itself and the paper edge
 * survives it. Page 176 carries a dark blob down its left edge starting nine
 * columns in; the walk stopped at column 8, the blob stayed, and it glued the
 * top bands together and cost four lines (running head, folio and two lines of
 * body). Since no column of type can raise this flag - that is exactly what
 * the ink-run test buys, see trimInkyEdges - the paper between the edge and
 * a flagged column is margin whether or not the flagging is continuous, and
 * an unflagged edge still loses nothing.
 */
function edgeStrip(strip: Uint8Array, limitIn: number, fromEnd: boolean): number {
  const limit = Math.max(0, Math.min(limitIn, strip.length));
  // The two extra lines shave the artifact's antialiased inner edge, as walk()
  // does with a border's.
  for (let i = limit - 1; i >= 0; i--) {
    const idx = fromEnd ? strip.length - 1 - i : i;
    if (strip[idx]) return i + 3;
  }
  return 0;
}

/** Longest run of ink per column, down a sub-rectangle of the mask. */
function longestRuns(ink: Uint8Array, width: number, rect: Rect): Int32Array {
  const w = rect.x1 - rect.x0;
  const out = new Int32Array(w);
  const run = new Int32Array(w);
  for (let y = rect.y0; y < rect.y1; y++) {
    const base = y * width + rect.x0;
    for (let i = 0; i < w; i++) {
      if (ink[base + i]) {
        const r = run[i]! + 1;
        run[i] = r;
        if (r > out[i]!) out[i] = r;
      } else {
        run[i] = 0;
      }
    }
  }
  return out;
}

/**
 * Per column: does its ink fall where the type falls, or does it not care?
 *
 * The text rows are read off the MIDDLE 60% of the block, which no edge
 * artifact reaches, so the reference is never contaminated by the thing being
 * judged. A column that is inked without regard to the lines - a shadow, a
 * smear - covers text rows and leading alike, so the share of its ink that
 * lands on a text row is the duty cycle of the text rows themselves. A column
 * of type has nowhere else to put its ink and scores near 1.
 *
 * Returns a flag per column: 1 = this ink is blind to the type, so a long run
 * in it is an artifact and not a welded column of text.
 */
function blindToType(ink: Uint8Array, width: number, rect: Rect): Uint8Array {
  const h = rect.y1 - rect.y0;
  const w = rect.x1 - rect.x0;
  const out = new Uint8Array(w).fill(1);
  const a = Math.trunc(0.2 * w);
  const b = Math.trunc(0.8 * w);
  if (b <= a) return out;

  const rp = new Float64Array(h);
  let rpMax = 0;
  for (let y = 0; y < h; y++) {
    let n = 0;
    const base = (rect.y0 + y) * width + rect.x0;
    for (let x = a; x < b; x++) if (ink[base + x]) n++;
    const v = n / (b - a);
    rp[y] = v;
    if (v > rpMax) rpMax = v;
  }
  if (rpMax <= 0) return out;                 // nothing to be blind to

  const rowCut = 0.25 * rpMax;
  const textrow = new Uint8Array(h);
  let textrows = 0;
  for (let y = 0; y < h; y++) {
    if (rp[y]! >= rowCut) {
      textrow[y] = 1;
      textrows++;
    }
  }
  const duty = textrows / h;
  const bar = duty + (1.0 - duty) * ONROW_BIAS;

  const colink = new Int32Array(w);
  const onrow = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const base = (rect.y0 + y) * width + rect.x0;
    const isText = textrow[y] === 1;
    for (let x = 0; x < w; x++) {
      if (ink[base + x]) {
        colink[x] = colink[x]! + 1;
        if (isText) onrow[x] = onrow[x]! + 1;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    const share = onrow[x]! / Math.max(1, colink[x]!);
    out[x] = share < bar || colink[x] === 0 ? 1 : 0;
  }
  return out;
}

/**
 * Second border pass, run on the ink mask, to catch the grey strips these
 * scans carry along the paper edge: too pale to be near-black (the raw pass
 * misses them) and too steep for the local-paper estimate to absorb, so they
 * read as ink and glue the first or last line of the page to the edge.
 *
 * A strip is told from type by the LENGTH OF ITS INK RUN, not by how much ink
 * it holds. Type cannot produce a long vertical run: a column through the left
 * stems of every line on the page is 36% ink, but no single run in it is taller
 * than one line. A shadow's run is 50 to 1289 pixels. The median column run is
 * the x-height of the type (19-20px throughout this book); no column of type
 * can carry an unbroken run longer than one glyph, and the tallest glyph is
 * under twice that, so RUN_FACTOR sits at 2.5. Unlike an ink-fraction test it
 * keeps working after the walk reaches the text block, so a page whose
 * type runs right up to the shadow with no blank margin between them is safe.
 * Measured: an ink-fraction rule at 0.06 ate ~100 columns of text on pages 44,
 * 58, 237 and 461, and the coverage audit could not see it, because trimmed ink
 * leaves the denominator. That is what trimmedInkPx now reports.
 *
 * The run test has one blind spot and it costs body text. A soft shadow along
 * the paper edge is too gradual for localPaper to absorb - the 64px tile that
 * covers it is dominated by brighter paper further in - so it reads as faint
 * ink, and where it lies OVER type it WELDS the blank leading between the
 * lines. The column then carries an unbroken run through several lines of type
 * and raises the flag that "no column of type can raise". On deathstalker
 * rebellion page 13 that pushed the content rect in to x=695 while the type
 * ran to x=721; 840 lines in that book were cut short, and the coverage audit
 * could not see it because trimmed ink leaves the denominator.
 *
 * So a flagged column must also show that its ink is BLIND TO THE TYPE. A
 * shadow, a smear, a blob does not know where the lines are, so its ink lands
 * on text rows at exactly the page's text-row duty cycle - 45 to 51% on these
 * scans, and it cannot do better without being type. Type lands ~100% of its
 * ink on text rows; welded columns measure 0.67-0.83 against artifacts'
 * 0.31-0.58, a gap with nothing in it. The bar sits a quarter of the way from
 * blind to type, biased low on purpose: leaving a strip of shadow costs a
 * flagged page, and cutting into the text costs text.
 *
 * This is what separates the welded columns from the page-176 blob, which the
 * obvious test - "an artifact's ink IS its run" - does not: that blob measures
 * 0.21-0.57 solid, right on top of the welded columns, because it too is
 * broken up down the page. It scores 0.31-0.48 on rows, and stays trimmed.
 */
function trimInkyEdges(ink: Uint8Array, width: number, height: number, rect: Rect): { rect: Rect; trimmed: number } {
  // Rows keep the ink-fraction rule, and with it the walk: a horizontal smear
  // is a fraction of the width, the row equivalent of the run test would fire
  // on a bold line, and type CAN raise an ink-fraction flag - so a row flag is
  // only trusted while it runs continuously from the paper edge. Columns,
  // whose flag type cannot raise, take the stronger edgeStrip rule instead.
  // Columns and rows are trimmed alternately until stable, since removing a
  // full-height strip changes every row's ink fraction (and vice versa). Each
  // side may lose at most a sixteenth of the ORIGINAL dimension however many
  // rounds run, so an all-ink page (a dark cover) cannot be eaten away round by
  // round - it comes out with its flags raised instead.
  const { y0: oy0, y1: oy1, x0: ox0, x1: ox1 } = rect;
  let { y0, y1, x0, x1 } = rect;
  const ch = Math.floor((oy1 - oy0) / 16);
  const cw = Math.floor((ox1 - ox0) / 16);
  for (let round = 0; round < 3; round++) {
    const sub: Rect = { y0, y1, x0, x1 };
    const runs = longestRuns(ink, width, sub);
    const live: number[] = [];
    for (let i = 0; i < runs.length; i++) if (runs[i]! > 0) live.push(runs[i]!);
    const ref = live.length ? medianOf(live) : 0.0;
    const bar = Math.max(RUN_FACTOR * ref, 20.0);
    const blind = blindToType(ink, width, sub);
    const strip = new Uint8Array(runs.length);
    for (let i = 0; i < runs.length; i++) strip[i] = runs[i]! >= bar && blind[i] === 1 ? 1 : 0;
    const nx0 = x0 + edgeStrip(strip, cw - (x0 - ox0), false);
    const nx1 = x1 - edgeStrip(strip, cw - (ox1 - x1), true);

    const rf = new Float64Array(y1 - y0);
    const span = nx1 - nx0;
    for (let y = y0; y < y1; y++) {
      let n = 0;
      const base = y * width;
      for (let x = nx0; x < nx1; x++) if (ink[base + x]) n++;
      rf[y - y0] = n / span;
    }
    const ny0 = y0 + walk(rf, ch - (y0 - oy0), 0.15, 8);
    const ny1 = y1 - walk(reversed(rf), ch - (oy1 - y1), 0.15, 8);
    if (ny0 === y0 && ny1 === y1 && nx0 === x0 && nx1 === x1) break;
    y0 = ny0;
    y1 = ny1;
    x0 = nx0;
    x1 = nx1;
  }
  if (y1 - y0 < Math.floor((oy1 - oy0) / 2) || x1 - x0 < Math.floor((ox1 - ox0) / 2)) {
    throw new Error(`inky-edge trim ate the page: (${y0}, ${y1}, ${x0}, ${x1})`);
  }
  let before = 0;
  for (let i = 0; i < ink.length; i++) before += ink[i]!;
  for (let y = 0; y < y0; y++) ink.fill(0, y * width, y * width + width);
  for (let y = y1; y < height; y++) ink.fill(0, y * width, y * width + width);
  for (let y = 0; y < height; y++) {
    ink.fill(0, y * width, y * width + x0);
    ink.fill(0, y * width + x1, y * width + width);
  }
  let after = 0;
  for (let i = 0; i < ink.length; i++) after += ink[i]!;
  // Report what the trim destroyed. Trimmed ink leaves the coverage audit's
  // denominator, so without this number an over-eager trim could delete a
  // column of type and still score perfect coverage.
  return { rect: { y0, y1, x0, x1 }, trimmed: before - after };
}

/**
 * Paper tone estimated per BG_BLOCK tile and bilinearly interpolated.
 *
 * A global paper tone cannot survive these scans: the page corner sits in a
 * shadow whose paper is darker than the ink threshold derived mid-page, so a
 * global cut turns the whole corner into ink, glues the last lines together
 * and swallows the page number. The 75th percentile inside a tile two line
 * pitches across is paper even when the tile is full of type, because type
 * never covers most of a tile.
 */
function localPaper(sub: Float32Array, h: number, w: number): Float32Array {
  const b = BG_BLOCK;
  const gh = Math.ceil(h / b);
  const gw = Math.ceil(w / b);
  const ph = gh * b;
  const pw = gw * b;
  // np.pad(..., mode="edge") — the padded tile reads the nearest real pixel.
  const grid = new Float32Array(gh * gw);
  const tile = new Float64Array(b * b);
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      let k = 0;
      for (let j = 0; j < b; j++) {
        const sy = Math.min(ty * b + j, h - 1);
        const base = sy * w;
        for (let i = 0; i < b; i++) {
          tile[k++] = sub[base + Math.min(tx * b + i, w - 1)]!;
        }
      }
      tile.sort();
      grid[ty * gw + tx] = Math.fround(percentileSorted(tile, 75));
    }
  }
  const full = resizeBilinearF32(grid, gw, gh, pw, ph);
  const out = new Float32Array(h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = full[y * pw + x]!;
  }
  return out;
}

/**
 * Pillow's BILINEAR `resize`, reproduced: the same coefficient precomputation
 * (`precompute_coeffs` in Resample.c), the same horizontal-then-vertical pass
 * order, and the same float32 intermediate image. The paper tone this produces
 * is compared with `<` against integer pixel values, so a last-ulp difference
 * flips a pixel between paper and ink.
 */
function resizeBilinearF32(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const horiz = precomputeCoeffs(sw, dw);
  const temp = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const min = horiz.bounds[x * 2]!;
      const count = horiz.bounds[x * 2 + 1]!;
      const k = x * horiz.ksize;
      let ss = 0.0;
      for (let i = 0; i < count; i++) ss += src[y * sw + min + i]! * horiz.kk[k + i]!;
      temp[y * dw + x] = Math.fround(ss);
    }
  }
  const vert = precomputeCoeffs(sh, dh);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const min = vert.bounds[y * 2]!;
    const count = vert.bounds[y * 2 + 1]!;
    const k = y * vert.ksize;
    for (let x = 0; x < dw; x++) {
      let ss = 0.0;
      for (let i = 0; i < count; i++) ss += temp[(min + i) * dw + x]! * vert.kk[k + i]!;
      out[y * dw + x] = Math.fround(ss);
    }
  }
  return out;
}

function precomputeCoeffs(inSize: number, outSize: number): { bounds: Int32Array; kk: Float64Array; ksize: number } {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1.0);
  const support = 1.0 * filterscale;                  // BILINEAR support is 1.0
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Float64Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1.0 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const k = xx * ksize;
    let ww = 0.0;
    for (let x = 0; x < xmax; x++) {
      const w = bilinearFilter((x + xmin - center + 0.5) * ss);
      kk[k + x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) if (ww !== 0.0) kk[k + x] = kk[k + x]! / ww;
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, kk, ksize };
}

function bilinearFilter(x: number): number {
  const a = x < 0.0 ? -x : x;
  return a < 1.0 ? 1.0 - a : 0.0;
}

/** Boolean ink mask over the whole page, 0 outside the content rect. */
function inkMask(gray: GrayRaster, rect: Rect): Uint8Array {
  const h = rect.y1 - rect.y0;
  const w = rect.x1 - rect.x0;
  const sub = new Float32Array(h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) sub[y * w + x] = grayAt(gray, rect.y0 + y, rect.x0 + x);
  }
  const paper = localPaper(sub, h, w);
  const ink = new Uint8Array(gray.width * gray.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = sub[y * w + x]!;
      const p = paper[y * w + x]!;
      // float32 arithmetic, as numpy does it on a float32 array.
      if (v < Math.fround(p * INK_RATIO) && v < Math.fround(p - INK_FLOOR)) {
        ink[(rect.y0 + y) * gray.width + rect.x0 + x] = 1;
      }
    }
  }
  return ink;
}

// ---------------------------------------------------------------- deskew

/**
 * How concentrated the horizontal projection is when the page is sheared by
 * slope t (rows per column). Ink is conserved by the shear, so the sum of the
 * squared row counts rises exactly as the ink packs into fewer rows, and it is
 * maximal when the shear runs parallel to the lines of type.
 *
 * Each point is SPLIT between the two rows it falls between rather than
 * rounded into one. Rounding makes the objective a staircase: every shear that
 * moves the widest column by less than half a row lands in the same integer
 * rows and scores identically, so the peak is a plateau 0.3 deg wide - three
 * times the angle being resolved - and its position says nothing. Splitting
 * linearly makes the score a continuous function of t, and the peak lands
 * within 0.025 deg of the truth (measured against synthetic rotations of a
 * known-straight page, +-0.3 deg and out).
 */
function profileConcentration(ys: Float64Array, xs: Float64Array, t: number): number {
  const n = ys.length;
  const v = new Float64Array(n);
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const val = ys[i]! - xs[i]! * t;
    v[i] = val;
    if (val < min) min = val;
  }
  const lo = new Int32Array(n);
  const f = new Float64Array(n);
  let loMax = 0;
  for (let i = 0; i < n; i++) {
    const shifted = v[i]! - min;
    const l = Math.floor(shifted);
    lo[i] = l;
    f[i] = shifted - l;
    if (l > loMax) loMax = l;
  }
  const size = loMax + 2;
  const prof = new Float64Array(size);
  // np.bincount accumulates in array order; so does this.
  for (let i = 0; i < n; i++) prof[lo[i]!] = prof[lo[i]!]! + (1.0 - f[i]!);
  const prof2 = new Float64Array(size);
  for (let i = 0; i < n; i++) prof2[lo[i]! + 1] = prof2[lo[i]! + 1]! + f[i]!;
  let acc = 0.0;
  for (let i = 0; i < size; i++) {
    const p = prof[i]! + prof2[i]!;
    acc += p * p;
  }
  return acc;
}

/**
 * Ink coordinates for the angle search, at half resolution.
 *
 * Taken from INSIDE the content rect, inset a further 5%, for two reasons: the
 * black platen border and the grey strips along the paper edge are not type and
 * do not share its angle, and a border's ink is a solid block that would swamp
 * the profile. Half resolution is free precision-wise - the slope is a ratio,
 * so it survives the downsample - and it quarters the cost. Coordinates are
 * returned centred on the block so the shear pivots at its middle, which keeps
 * the row range (and so the bincount) small.
 */
function skewPoints(gray: GrayRaster, rect: Rect): { ys: Float64Array; xs: Float64Array } | null {
  const dy = Math.trunc(0.05 * (rect.y1 - rect.y0));
  const dx = Math.trunc(0.05 * (rect.x1 - rect.x0));
  const y0 = rect.y0 + dy;
  const y1 = rect.y1 - dy;
  const x0 = rect.x0 + dx;
  const x1 = rect.x1 - dx;
  if (y1 - y0 < 32 || x1 - x0 < 32) return null;

  const h = Math.ceil((y1 - y0) / 2);
  const w = Math.ceil((x1 - x0) / 2);
  const sub = new Float32Array(h * w);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) sub[j * w + i] = grayAt(gray, y0 + 2 * j, x0 + 2 * i);
  }
  const paper = localPaper(sub, h, w);
  const rows: number[] = [];
  const cols: number[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = sub[j * w + i]!;
      const p = paper[j * w + i]!;
      if (v < Math.fround(p * INK_RATIO) && v < Math.fround(p - INK_FLOOR)) {
        rows.push(j);
        cols.push(i);
      }
    }
  }
  if (rows.length < DESKEW_MIN_INK) return null;   // a near-blank page has no angle to find
  let step = 1;
  if (rows.length > DESKEW_MAX_POINTS) {           // deterministic stride, never a sample
    step = Math.trunc(rows.length / DESKEW_MAX_POINTS) + 1;
  }
  const n = Math.ceil(rows.length / step);
  const ys = new Float64Array(n);
  const xs = new Float64Array(n);
  const centre = 0.5 * w;
  for (let k = 0, i = 0; i < rows.length; i += step, k++) {
    ys[k] = rows[i]!;
    xs[k] = cols[i]! - centre;
  }
  return { ys, xs };
}

/**
 * Skew of the type on this page, in degrees, positive = correct by rotating
 * the image counter-clockwise (PIL's rotate() sign). Deterministic: the same
 * page always yields the same number.
 *
 * Coarse-to-fine over a bounded range, scoring the horizontal projection
 * profile of the page's own ink. Rotate-and-score without ever rotating: for
 * the angles that matter here a rotation and a shear differ by less than a
 * pixel across a page, and a shear is one multiply and two bincounts over the
 * ink coordinates instead of a full resample of the raster.
 *
 * Bounded at DESKEW_MAX_DEG on purpose. Past a few degrees the maximum of this
 * objective stops being the type's angle - a table of contents' leader dots, a
 * tall drop cap, a column of numerals all make ridges of their own - and an
 * unbounded search finds them. Book scans are tilted, not rotated.
 *
 * THE DEAD ZONE. t=0 is the one shear that maps every pixel onto a whole row,
 * so nothing is split there and the score carries a cusp - measured at 1.5-1.9%
 * above its neighbours on this scan - that no real tilt under about a quarter
 * of a degree can beat. So a page tilted less than ~0.25 deg reads as exactly
 * 0.000 and is left alone. That is the harmless direction to fail in and the
 * reason the cusp is not worth engineering away: a quarter degree drops the end
 * of a 600 px line by 2.6 px against a 25 px line pitch, so it cannot merge two
 * bands, and the alternatives that flatten the cusp (a sub-row dither, a fixed
 * blur) buy the sub-quarter-degree range at the price of inventing a 0.15-0.20
 * deg tilt on pages that measurably have none - which would rotate, and
 * resample, every page of a straight book.
 */
export function estimateSkew(gray: GrayRaster, rect: Rect): number {
  const pts = skewPoints(gray, rect);
  if (!pts) return 0.0;

  const bestOver = (cands: number[]): number => {
    const scores = cands.map((a) => profileConcentration(pts.ys, pts.xs, Math.tan(a * DEG2RAD)));
    let top = -Infinity;
    for (const s of scores) if (s > top) top = s;
    // Ties are all but impossible on a continuous score, but a tie must not
    // resolve by scan order - that would bias the answer one way. Midpoint.
    let sum = 0.0;
    let count = 0;
    for (let i = 0; i < cands.length; i++) {
      if (scores[i] === top) {
        sum += cands[i]!;
        count++;
      }
    }
    return sum / count;
  };

  const n = pyRound(DESKEW_MAX_DEG / DESKEW_COARSE);
  const coarseCands: number[] = [];
  for (let i = -n; i <= n; i++) coarseCands.push(i * DESKEW_COARSE);
  const coarse = bestOver(coarseCands);
  const k = pyRound(DESKEW_COARSE / DESKEW_FINE);
  const fineCands: number[] = [];
  for (let i = -k; i <= k; i++) fineCands.push(coarse + i * DESKEW_FINE);
  return pyRoundTo(bestOver(fineCands), 3);
}

/**
 * Straighten a page — Pillow's `Image.rotate(deg, BICUBIC, fillcolor=255)`,
 * reproduced exactly so the crops the recognizer sees are the same raster the
 * bands were measured on and a band box means the same thing on both sides.
 * The angle is the only state either side needs.
 *
 * What the rotation exposes at the image corners is painted white and is
 * always OUTSIDE the deskewed content rect (see deskewRect), so it is never
 * inked, never banded and never cropped.
 *
 * The four things this had to get right, each measured against Pillow 10.4
 * rather than assumed: the cubic is a = -1 (not the Catmull-Rom a = -0.5 that
 * Pillow's *resample* path uses), the 4x4 tap window is CLAMPED to the edge
 * pixels rather than dropped, a source point is in range iff it lies in
 * [-0.5, size-0.5) — which is what paints the corner fill — and the final
 * conversion to a byte TRUNCATES rather than rounds.
 */
export function applyDeskew(gray: GrayRaster, deg: number): GrayRaster {
  if (!deg) return gray;
  const w = gray.width;
  const h = gray.height;

  // Image.rotate: angle % 360 first, and Python's % takes the divisor's sign,
  // so -0.25 becomes 359.75 and its radians are a different double.
  const mod = pyMod(deg, 360.0);
  const angle = -(mod * DEG2RAD);
  const cx = w / 2;
  const cy = h / 2;
  const a0 = pyRoundTo(Math.cos(angle), 15);
  const a1 = pyRoundTo(Math.sin(angle), 15);
  const a3 = pyRoundTo(-Math.sin(angle), 15);
  const a4 = pyRoundTo(Math.cos(angle), 15);
  const a2 = a0 * -cx + a1 * -cy + cx;
  const a5 = a3 * -cx + a4 * -cy + cy;

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < w; x++) {
      const xc = x + 0.5;
      const xin = a0 * xc + a1 * yc + a2 - 0.5;
      const yin = a3 * xc + a4 * yc + a5 - 0.5;
      out[y * w + x] = bicubicSample(gray, xin, yin);
    }
  }
  return { width: w, height: h, data: out };
}

/** Python's `%` on floats: the result takes the sign of the divisor. */
function pyMod(x: number, y: number): number {
  const r = x % y;
  return r !== 0 && r < 0 !== y < 0 ? r + y : r;
}

const ROTATE_FILL = 255;

function bicubicSample(gray: GrayRaster, xin: number, yin: number): number {
  const w = gray.width;
  const h = gray.height;
  if (xin < -0.5 || xin >= w - 0.5 || yin < -0.5 || yin >= h - 0.5) return ROTATE_FILL;
  const xx = Math.floor(xin);
  const yy = Math.floor(yin);
  const xd = xin - xx;
  const yd = yin - yy;
  const rows = new Float64Array(4);
  for (let j = 0; j < 4; j++) {
    const sy = clampInt(yy - 1 + j, 0, h - 1) * w;
    rows[j] = cubicA1(
      gray.data[sy + clampInt(xx - 1, 0, w - 1)]!,
      gray.data[sy + clampInt(xx, 0, w - 1)]!,
      gray.data[sy + clampInt(xx + 1, 0, w - 1)]!,
      gray.data[sy + clampInt(xx + 2, 0, w - 1)]!,
      xd,
    );
  }
  const v = cubicA1(rows[0]!, rows[1]!, rows[2]!, rows[3]!, yd);
  if (v <= 0.0) return 0;
  if (v >= 255.0) return 255;
  return Math.trunc(v);
}

/**
 * The a = -1 cubic through four samples, in the COEFFICIENT form Pillow's
 * Geometry.c uses — not as a sum of four kernel weights.
 *
 * The two are the same function on paper and are not the same function in
 * floating point, and the difference is worth a paragraph because it cost a
 * day. Written as `v1*k(1+d) + v2*k(d) + v3*k(1-d) + v4*k(2-d)`, a run of four
 * IDENTICAL samples — flat paper, which is most of a scanned page — returns
 * `V * (sum of the weights)`, and that sum is 0.9999999999999998 rather than 1.
 * The result lands a hair BELOW the integer, and clip8 truncates, so the pixel
 * comes back one level darker. Measured against Pillow 10.4: 8.6% of a page's
 * pixels, every one of them off by exactly +1 in Pillow's favour, which moved
 * the ink mask and with it two band boxes.
 *
 * In this form the three difference coefficients are exactly zero on flat
 * input, so a flat run returns v2 exactly. Agreement with Pillow is then
 * pixel-for-pixel over the whole page.
 */
function cubicA1(v1: number, v2: number, v3: number, v4: number, d: number): number {
  const p1 = v2;
  const p2 = v3 - v1;
  const p3 = 2 * v1 - 2 * v2 + v3 - v4;
  const p4 = v2 - v1 - v3 + v4;
  return p1 + d * (p2 + d * (p3 + d * p4));
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Where the content rect went, as the largest axis-aligned box still inside
 * it after the rotation.
 *
 * Re-running detectBorder on the rotated page is the obvious alternative and
 * it is wrong twice over. The scan's black margin is now diagonal, so a walk
 * straight in from an edge cannot follow it and gives back the whole page -
 * which then hands localPaper() the rotation's own white corners as if they
 * were paper, drags the tile estimate up and turns the dim real paper beside
 * them into ink. Measured on rebellion's tilted pages: the edge trim went from
 * 4.8k to 20.6k ink pixels on page 433 and from 5.2k to 22.5k on page 435,
 * and trimmed ink leaves the coverage audit's denominator, so the damage is
 * invisible where it counts. Shrinking to the rotated rect costs 11 px a side
 * at 1 deg and keeps every pixel the estimate sees real.
 */
export function deskewRect(rect: Rect, deg: number, width: number, height: number): Rect {
  const cy = (height - 1) / 2.0;
  const cx = (width - 1) / 2.0;
  const th = deg * DEG2RAD;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const corners: Array<[number, number]> = [
    [rect.x0, rect.y0],
    [rect.x1 - 1, rect.y0],
    [rect.x0, rect.y1 - 1],
    [rect.x1 - 1, rect.y1 - 1],
  ];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of corners) {
    xs.push(cx + c * (px - cx) + s * (py - cy));
    ys.push(cy - s * (px - cx) + c * (py - cy));
  }
  xs.sort((p, q) => p - q);
  ys.sort((p, q) => p - q);
  return {
    y0: Math.max(0, Math.ceil(ys[1]!)),
    y1: Math.min(height, Math.floor(ys[2]!) + 1),
    x0: Math.max(0, Math.ceil(xs[1]!)),
    x1: Math.min(width, Math.floor(xs[2]!) + 1),
  };
}

// ---------------------------------------------------------------- line banding

interface RegionStats {
  inkThreshold: number;
  minBandH: number;
  medianPitch: number;
  medianBandH: number;
}

/**
 * Band one column of one page. Returns [top, bot) row ranges plus the derived
 * thresholds.
 */
function bandRegion(
  ink: Uint8Array,
  width: number,
  height: number,
  rect: Rect,
  xa: number,
  xb: number,
): { bands: Array<[number, number]>; stats: RegionStats } {
  const y0 = rect.y0;
  const y1 = rect.y1;
  const rowink = new Int32Array(height);
  for (let y = y0; y < y1; y++) {
    let n = 0;
    const base = y * width;
    for (let x = xa; x < xb; x++) if (ink[base + x]) n++;
    rowink[y] = n;
  }
  const active: number[] = [];
  for (let y = 0; y < height; y++) if (rowink[y]! > 0) active.push(rowink[y]!);
  if (active.length === 0) {
    return { bands: [], stats: { inkThreshold: 0, minBandH: 0, medianPitch: 0, medianBandH: 0 } };
  }

  // INK THRESHOLD, derived from the page. The row-ink distribution is bimodal:
  // rows through the body of a line darken a large fraction of the text width,
  // while the descenders reaching into the gap below darken only a handful of
  // columns. p75 of the inked rows lands squarely in the text-row mode and so
  // measures "what a line of this book's type looks like"; 12% of that sits in
  // the valley below it. (The prototype's 5%-of-page-width is the same number
  // for this book's type size only - at 2% descenders bridged the lines and 44
  // lines came back as 16 bands.)
  let typical = percentileOf(active, 75);
  // One refinement: rows carrying only scanner smear drag p75 down on a sparse
  // page, so re-take it over rows that clear 2% of the first estimate.
  const cut = Math.max(2.0, 0.02 * typical);
  const active2: number[] = [];
  for (let y = 0; y < height; y++) if (rowink[y]! >= cut) active2.push(rowink[y]!);
  if (active2.length) typical = percentileOf(active2, 75);
  const thresh = Math.max(3.0, 0.12 * typical);
  // INKED-ROW FLOOR. A descender row carries a few percent of a full text row;
  // the grey smear along a scan edge carries one to three pixels. 2% of a text
  // row separates them, and without it a band grows down the smear to the foot
  // of the page (page 521's last band ran 1223-1289 instead of 1223-1248).
  const floorInk = Math.max(2.0, 0.02 * typical);
  const on = new Uint8Array(height);
  for (let y = 0; y < height; y++) on[y] = rowink[y]! > thresh ? 1 : 0;

  const runs = (minh: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let start: number | null = null;
    let blanks = 0;
    for (let i = y0; i < y1; i++) {
      if (on[i]) {
        if (start === null) start = i;
        blanks = 0;
      } else if (start !== null) {
        blanks += 1;
        if (blanks > GAP_ROWS) {
          if (i - blanks - start >= minh) out.push([start, i - blanks]);
          start = null;
        }
      }
    }
    if (start !== null && y1 - start >= minh) out.push([start, y1]);
    return out;
  };

  // MINIMUM BAND HEIGHT, derived from the line pitch. A first pass at minh=3
  // gives band tops; the median spacing between them is the leading of this
  // book at this dpi. A real line's inked core is a large share of the pitch,
  // dust and speckle are not, so a quarter of the pitch separates them. (For
  // this book that lands near the prototype's hand-tuned 8px at 200 dpi.)
  const prelim = runs(3);
  const tops = prelim.map((b) => b[0]);
  let pitch = 0.0;
  if (tops.length >= 3) {
    const diffs: number[] = [];
    for (let i = 1; i < tops.length; i++) diffs.push(tops[i]! - tops[i - 1]!);
    pitch = medianOf(diffs);
  }
  const minh = pitch > 0 ? Math.max(4, pyRound(0.25 * pitch)) : 4;
  const bands = runs(minh);

  // Grow each band over inked-but-below-threshold rows so descenders, accents
  // and the tails of a display capital land inside the band instead of being
  // counted as missed coverage. Growth is bounded by the neighbouring band,
  // taken in order, so two bands can never claim the same row.
  // Growth also stops after half a line pitch: an ascender or descender lives
  // inside its own line's pitch by definition, so anything further is not part
  // of this line. Without the cap the top and bottom lines of a page grow down
  // the horizontal edge smear all the way to the paper edge - that, not merged
  // type, was 17 of the 25 tall bands in the first full run of this book.
  const reach = pitch > 0 ? Math.max(4, pyRound(0.5 * pitch)) : 4;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i]!;
    const upStop = Math.max(i ? bands[i - 1]![1] : y0, b[0] - reach);
    while (b[0] > upStop && rowink[b[0] - 1]! >= floorInk) b[0] -= 1;
    const downStop = Math.min(i + 1 < bands.length ? bands[i + 1]![0] : y1, b[1] + reach);
    while (b[1] < downStop && rowink[b[1]]! >= floorInk) b[1] += 1;
  }

  // ORPHAN RESCUE. A line only a few characters wide ('tha."' ending a
  // paragraph) never clears the ink threshold, which is calibrated on full
  // lines - page 521 lost exactly that line, and the coverage audit is what
  // caught it. So any island of inked rows left outside every band is a band
  // if it is line-height AND carries at least as much ink as one full text
  // row. Speckle and dust clear neither test.
  const covered = new Uint8Array(height);
  for (const b of bands) covered.fill(1, b[0], b[1]);
  let start: number | null = null;
  for (let i = y0; i <= y1; i++) {
    const liveHere = i < y1 && rowink[i]! >= floorInk && !covered[i];
    if (liveHere) {
      if (start === null) start = i;
    } else if (start !== null) {
      let sum = 0;
      for (let j = start; j < i; j++) sum += rowink[j]!;
      if (i - start >= minh && sum >= thresh) bands.push([start, i]);
      start = null;
    }
  }
  bands.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const heights = bands.map((b) => b[1] - b[0]);
  return {
    bands,
    stats: {
      inkThreshold: pyRoundTo(thresh, 1),
      minBandH: minh,
      medianPitch: pyRoundTo(pitch, 1),
      medianBandH: heights.length ? medianOf(heights) : 0.0,
    },
  };
}

/**
 * The x-height of this page's type, in pixels: the median column ink run
 * inside the content rect. A column of type is broken by the paper between
 * the lines, so its longest unbroken run is one glyph tall, and the median
 * over every inked column is the height of the commonest glyph body (19-20 px
 * throughout this book at 200 dpi). trimInkyEdges already derives its
 * shadow-vs-type threshold from it; tightBox derives its word-gap scale from
 * it. Zero on a page with no ink, and every user falls back accordingly.
 */
function xHeight(ink: Uint8Array, width: number, rect: Rect): number {
  const runs = longestRuns(ink, width, rect);
  const live: number[] = [];
  for (let i = 0; i < runs.length; i++) if (runs[i]! > 0) live.push(runs[i]!);
  return live.length ? medianOf(live) : 0.0;
}

/**
 * Ink extent of a band, resistant to margin noise.
 *
 * A band is one line of type, so its inked columns arrive in word-sized
 * clusters separated by word spaces - and a word space is a FRACTION of the
 * x-height (5 to 9 px against 19-20 in this book), never a multiple of it. So
 * the clusters are cut at blank gaps wider than one x-height, and a cluster at
 * either END of the line is dropped when nothing in it could be type: when its
 * tallest vertical ink run is under a quarter of the x-height, i.e. shorter
 * than the shortest mark the type sets. Only the ends are ever dropped -
 * something between two clusters of type is part of the line whatever it looks
 * like - and the last surviving cluster is never dropped, so a band made
 * entirely of dirt still yields a box and still gets read and reported.
 *
 * Page 64's fifth band is what this is for: a nine-word line ending at x=101
 * came out 28..784 wide because ONE ink pixel sat in the right margin, and the
 * full-width --psm 7 crop that produced read back empty - a line lost to a
 * single pixel of scanner noise, with nothing in the geometry to show for it.
 */
function tightBox(
  ink: Uint8Array,
  width: number,
  top: number,
  bot: number,
  xa: number,
  xb: number,
  xh: number,
): Box | null {
  const sub: Rect = { y0: top, y1: bot, x0: xa, x1: xb };
  const w = xb - xa;
  const cols: number[] = [];
  for (let x = 0; x < w; x++) {
    for (let y = top; y < bot; y++) {
      if (ink[y * width + xa + x]) {
        cols.push(x);
        break;
      }
    }
  }
  if (cols.length === 0) return null;
  const gap = Math.max(2, pyRound(xh));
  const solid = Math.max(2, pyRound(0.25 * xh));
  const runs = longestRuns(ink, width, sub);

  const groups: Array<[number, number]> = [];
  let start = cols[0]!;
  let prev = cols[0]!;
  for (let i = 1; i < cols.length; i++) {
    const c = cols[i]!;
    if (c - prev > gap) {
      groups.push([start, prev]);
      start = c;
    }
    prev = c;
  }
  groups.push([start, prev]);

  const dust = (g: [number, number]): boolean => {
    let max = 0;
    for (let x = g[0]; x <= g[1]; x++) if (runs[x]! > max) max = runs[x]!;
    return max < solid;
  };
  while (groups.length > 1 && dust(groups[0]!)) groups.shift();
  while (groups.length > 1 && dust(groups[groups.length - 1]!)) groups.pop();

  const lo = groups[0]![0];
  const hi = groups[groups.length - 1]![1];
  let firstRow = -1;
  let lastRow = -1;
  for (let y = top; y < bot; y++) {
    let any = false;
    const base = y * width + xa;
    for (let x = lo; x <= hi; x++) {
      if (ink[base + x]) {
        any = true;
        break;
      }
    }
    if (any) {
      if (firstRow < 0) firstRow = y - top;
      lastRow = y - top;
    }
  }
  if (firstRow < 0) return null;
  return [xa + lo, top + firstRow, xa + hi + 1, top + lastRow + 1];
}

// ------------------------------------------------------------ column splitting

/**
 * One level of XY-cut: a sustained full-height blank gutter inside the text
 * block. Returns the split x, or null. Margins are excluded by looking only
 * inside the inked block, and only at its middle 60%.
 */
function findGutter(ink: Uint8Array, width: number, rect: Rect): number | null {
  const w = rect.x1 - rect.x0;
  const colink = new Int32Array(w);
  for (let y = rect.y0; y < rect.y1; y++) {
    const base = y * width + rect.x0;
    for (let x = 0; x < w; x++) if (ink[base + x]) colink[x] = colink[x]! + 1;
  }
  let bx0 = -1;
  let bx1 = -1;
  for (let x = 0; x < w; x++) {
    if (colink[x]! > 0) {
      if (bx0 < 0) bx0 = x;
      bx1 = x + 1;
    }
  }
  if (bx0 < 0) return null;
  const bw = bx1 - bx0;
  const blankCut = Math.max(1, Math.trunc(0.002 * (rect.y1 - rect.y0)));
  let best: { width: number; centre: number } | null = null;
  let run: number | null = null;
  for (let i = bx0; i <= bx1; i++) {
    if (i < bx1 && colink[i]! <= blankCut) {
      if (run === null) run = i;
      continue;
    }
    if (run !== null) {
      const wRun = i - run;
      const centre = Math.floor((run + i) / 2);
      if (
        wRun >= Math.max(15, Math.trunc(0.03 * bw)) &&
        bx0 + 0.2 * bw <= centre &&
        centre <= bx0 + 0.8 * bw &&
        (best === null || wRun > best.width)
      ) {
        best = { width: wRun, centre };
      }
      run = null;
    }
  }
  return best ? rect.x0 + best.centre : null;
}

// --------------------------------------------------------------- page pipeline

/**
 * Segment one page. Throws PageSegmentationError, naming the page, when the
 * page cannot be segmented — there is no degraded result, and the caller is
 * expected to let that failure reach the exit code.
 */
export function processPage(raster: GrayRaster, page: number): PageBands {
  try {
    return segment(raster, page);
  } catch (err) {
    if (err instanceof PageSegmentationError) throw err;
    throw new PageSegmentationError(page, err instanceof Error ? err.message : String(err));
  }
}

function segment(raster: GrayRaster, page: number): PageBands {
  let gray = raster;
  const h = gray.height;
  const w = gray.width;
  let rect = detectBorder(gray);

  // Straighten before profiling. A page under DESKEW_MIN_DEG is not touched at
  // all - not rotated by zero, not resampled - so a straight book's geometry is
  // bit-identical to the pre-deskew pipeline's; only the pages that need it pay
  // a resample.
  let deskewDeg = estimateSkew(gray, rect);
  if (Math.abs(deskewDeg) < DESKEW_MIN_DEG) {
    deskewDeg = 0.0;
  } else {
    gray = applyDeskew(gray, deskewDeg);
    rect = deskewRect(rect, deskewDeg, gray.width, gray.height);
  }

  const ink = inkMask(gray, rect);
  const trim = trimInkyEdges(ink, w, h, rect);
  rect = trim.rect;
  let totalInk = 0;
  for (let i = 0; i < ink.length; i++) totalInk += ink[i]!;
  if (totalInk === 0) throw new PageSegmentationError(page, 'no ink found after border masking');

  const bandColumns = (spans: Array<[number, number]>) =>
    spans.map(([xa, xb]) => ({ xa, xb, ...bandRegion(ink, w, h, rect, xa, xb) }));

  let cols = bandColumns([[rect.x0, rect.x1]]);
  let gutter = findGutter(ink, w, rect);
  if (gutter !== null) {
    const two = bandColumns([
      [rect.x0, gutter],
      [gutter, rect.x1],
    ]);
    const counts = two.map((c) => c.bands.length).sort((p, q) => p - q);
    // A blank stripe through a sparse page (a section break, a title) looks
    // like a gutter. A real gutter yields two well-populated, comparably
    // sized columns; validate that before accepting the split.
    if (counts[0]! >= 10 && counts[1]! <= 3 * counts[0]!) {
      cols = two;
    } else {
      gutter = null;
    }
  }

  const xh = xHeight(ink, w, rect);
  const bands: Band[] = [];
  const heights: number[] = [];
  for (const col of cols) {
    for (const [top, bot] of col.bands) {
      const tb = tightBox(ink, w, top, bot, col.xa, col.xb, xh);
      if (tb === null) throw new PageSegmentationError(page, `band ${top}-${bot} has no ink`);
      bands.push({
        tight: tb,
        crop: [
          Math.max(0, tb[0] - CROP_PAD),
          Math.max(0, tb[1] - CROP_PAD),
          Math.min(w, tb[2] + CROP_PAD),
          Math.min(h, tb[3] + CROP_PAD),
        ],
        tall: false,
      });
      heights.push(tb[3] - tb[1]);
    }
  }

  const medH = heights.length ? medianOf(heights) : 0.0;
  for (let i = 0; i < bands.length; i++) {
    bands[i]!.tall = medH > 0 && heights[i]! > TALL_FACTOR * medH;
  }

  const covered = new Uint8Array(w * h);
  for (const b of bands) {
    for (let y = b.tight[1]; y < b.tight[3]; y++) covered.fill(1, y * w + b.tight[0], y * w + b.tight[2]);
  }
  let missedPx = 0;
  for (let i = 0; i < ink.length; i++) if (ink[i] && !covered[i]) missedPx++;
  const missed = missedPx / totalInk;

  const pitches = cols.map((c) => c.stats.medianPitch).filter((p) => p !== 0);
  return {
    page,
    widthPx: w,
    heightPx: h,
    columns: cols.length,
    contentRect: [rect.x0, rect.x1, rect.y0, rect.y1],   // [x0,x1,y0,y1]
    stats: {
      medianPitch: pitches.length ? pyRoundTo(medianOf(pitches), 1) : 0.0,
      inkThreshold: pyRoundTo(medianOf(cols.map((c) => c.stats.inkThreshold)), 1),
      minBandH: Math.trunc(medianOf(cols.map((c) => c.stats.minBandH))),
      medianBandH: pyRoundTo(medH, 1),
      xHeightPx: pyRoundTo(xh, 1),
      inkPx: totalInk,
      trimmedInkPx: trim.trimmed,
      coverageMissed: pyRoundTo(missed, 6),
    },
    deskewDeg,
    bands,
  };
}

// ------------------------------------------------------------------- summary

export interface BandsSummary {
  boxFormat: string;
  pagesProcessed: number;
  pagesFailed: Array<{ page: number; error: string }>;
  totalBands: number;
  totalTallBands: number;
  multiColumnPages: number[];
  zeroBandPages: number[];
  coverage: {
    min: number | null;
    median: number | null;
    p95: number | null;
    max: number | null;
    epsilon: number;
    over: number[];
  };
  deskew: {
    pagesRotated: number;
    pagesRotatedPct: number;
    minDeg: number;
    absDeg: { p50: number; p90: number; max: number } | null;
  };
  deskewDeg: Record<string, number>;
  bandCounts: Record<string, number>;
  flagged: Array<{ page: number; reasons: string[] }>;
}

/** The book-level report bands.py's main() writes as summary.json. */
export function summarize(perPage: PageBands[], failures: Array<{ page: number; error: string }>): BandsSummary {
  const cov = perPage.map((r) => r.stats.coverageMissed).sort((a, b) => a - b);
  const flagged: Array<{ page: number; reasons: string[] }> = [];
  for (const r of perPage) {
    const why: string[] = [];
    if (r.stats.coverageMissed > COVERAGE_EPS) {
      why.push(`coverage ${r.stats.coverageMissed.toFixed(4)} of ${r.stats.inkPx} ink px`);
    }
    const ntall = r.bands.filter((b) => b.tall).length;
    if (ntall) why.push(`${ntall} tall bands`);
    if (!r.bands.length) why.push('zero bands');
    if (r.stats.trimmedInkPx > TRIM_EPS * (r.stats.inkPx + r.stats.trimmedInkPx)) {
      why.push(`edge trim removed ${r.stats.trimmedInkPx} ink px`);
    }
    if (r.columns > 1) why.push(`${r.columns} columns`);
    if (why.length) flagged.push({ page: r.page, reasons: why });
  }
  const pct = (p: number) => (cov.length ? pyRoundTo(percentileSorted(cov, p), 6) : null);
  const ang = perPage.map((r) => Math.abs(r.deskewDeg));
  const rotated = ang.filter((a) => a > 0).length;

  return {
    boxFormat: '[x0,y0,x1,y1] half-open, full-page pixel coords',
    pagesProcessed: perPage.length,
    pagesFailed: failures,
    totalBands: perPage.reduce((a, r) => a + r.bands.length, 0),
    totalTallBands: perPage.reduce((a, r) => a + r.bands.filter((b) => b.tall).length, 0),
    multiColumnPages: perPage.filter((r) => r.columns > 1).map((r) => r.page),
    zeroBandPages: perPage.filter((r) => !r.bands.length).map((r) => r.page),
    coverage: {
      min: pct(0),
      median: pct(50),
      p95: pct(95),
      max: pct(100),
      epsilon: COVERAGE_EPS,
      over: perPage.filter((r) => r.stats.coverageMissed > COVERAGE_EPS).map((r) => r.page),
    },
    deskew: {
      pagesRotated: rotated,
      pagesRotatedPct: ang.length ? pyRoundTo((100.0 * rotated) / ang.length, 2) : 0.0,
      minDeg: DESKEW_MIN_DEG,
      absDeg: ang.length
        ? {
            p50: pyRoundTo(percentileOf(ang, 50), 3),
            p90: pyRoundTo(percentileOf(ang, 90), 3),
            max: pyRoundTo(Math.max(...ang), 3),
          }
        : null,
    },
    deskewDeg: Object.fromEntries(perPage.map((r) => [String(r.page), r.deskewDeg])),
    bandCounts: Object.fromEntries(perPage.map((r) => [String(r.page), r.bands.length])),
    flagged,
  };
}
