/**
 * calibration — decide WHICH signal carries paragraph information in THIS book.
 *
 * RUBRIC_TRAINING §9d decision 5, owner-approved Aug 1 2026: books commit to a
 * convention. Either they indent the first line of every paragraph and leave no
 * extra space between them, or they set every line flush left and separate
 * paragraphs with a blank line. The two are very nearly mutually exclusive, and
 * that is exactly why a fixed formula is wrong: a scorer that adds "indent
 * evidence" to "gap evidence" dilutes the book's live signal with the dead one,
 * and the dead one is pure noise — jitter in a scan's baselines, or the ragged
 * left edge of a bad deskew.
 *
 * So: one pass over the book's line geometry, one verdict, fed forward as an
 * explicit fact. Everything downstream (the boxes prompt, the grouping rules)
 * reads the verdict rather than re-deciding.
 *
 * **Label-free, like every other book-level normalizer.** This runs BEFORE
 * anything is classified — it sees lines, not categories — because the boxes
 * model needs the calibrated geometry in its prompt. That is also why the
 * measurements below are all robust ones (medians, modal buckets, percentile
 * windows): the input contains running heads, folios, headings and the odd
 * shred of a table, and none of them may be allowed to move the body's numbers.
 *
 * ## Book-relative thresholds
 *
 * The DECISION threshold this module hands downstream is always derived from
 * the book's own distribution: it is the midpoint between the two clusters the
 * book actually exhibits, in the book's own units. A book indenting by 1.2 body
 * heights and one indenting by 2.4 get different thresholds.
 *
 * The constants below are NOT decision thresholds. They are the dimensionless
 * minima a signal must clear to be called present at all — "these two clusters
 * are far enough apart to be two clusters", "this many lines is a paragraph
 * rhythm rather than a handful of outliers". They are in typographic units
 * (body heights, line pitches), so they carry across books, page sizes and dpi.
 *
 * ## The degradation
 *
 * When neither signal is present the verdict is `none` and `degraded` is true.
 * That is the ONE sanctioned graceful degradation in Foundry (PIPELINE.md,
 * owner's rule): a badly formatted source must not break the run. It produces
 * few or no paragraph breaks — too few paragraphs is fine for TTS, too many is
 * the problem — and it says so loudly, in the artifact, in `message`. It never
 * guesses a convention it cannot see.
 */
import type { Box } from '../scan/bands.js';
import type { CalibrationSignal, CalibrationVerdict } from '../pipeline/artifacts.js';

/** The only thing calibration needs from a line: where its ink sat. */
export interface CalibrationLine {
  page: number;
  /** [x0,y0,x1,y1], half-open, full-page px, DESKEWED. */
  bbox: Box;
}

// ── the dimensionless minima (see the header: NOT decision thresholds) ───────

/**
 * How far apart the two indent clusters must sit, in body-size units, before
 * "some lines are indented" is a claim about the book rather than about scan
 * jitter. A real first-line indent is one to two ems; half a body height is
 * comfortably below the smallest real one and comfortably above baseline noise.
 */
const INDENT_MIN_SEPARATION = 0.45;

/**
 * The flush cluster must actually be flush. If the lower cluster sits a third
 * of a body height off the margin, what was found is two indent depths (a
 * block quote against body text), not indent-vs-flush.
 */
const INDENT_MAX_FLUSH_CENTRE = 0.35;

/**
 * How much extra advance makes a gap, in pitch units. §9d names ~1.5x pitch as
 * the blank-line gap; a quarter of a pitch of separation between the clusters
 * is well inside that and well outside the leading jitter of a deskewed scan.
 */
const GAP_MIN_SEPARATION = 0.25;

/** The gap cluster must be a real opening, not merely the wider half of normal leading. */
const GAP_MIN_UPPER_CENTRE = 1.2;

/**
 * A paragraph rhythm: between 5% and 60% of samples in the upper cluster.
 *
 * The floor is set by the longest paragraph a book can average and still be
 * prose: one opening every twenty lines is 5%, and real books run 8% to 30% (a
 * paragraph of three to twelve lines). Below that the "cluster" is a handful of
 * outliers — six indented lines in a 240-line book is a block quote or a poem,
 * and calling it a convention would put a false break at each one.
 *
 * The ceiling rejects the inverted case where the "upper" cluster is the body
 * and the lower one is some minority, which means the split found something
 * other than paragraph openings. It is deliberately loose: dialogue-heavy
 * fiction really does open a paragraph every second or third line.
 */
const MIN_UPPER_SHARE = 0.05;
const MAX_UPPER_SHARE = 0.60;

/** Below this many samples, no signal is claimed either way. */
const MIN_SAMPLES = 12;

// ── robust statistics ───────────────────────────────────────────────────────

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The dominant value, as the centre of the busiest bucket AND ITS NEIGHBOURS.
 *
 * A mode rather than a median because a margin is a physical edge that most
 * lines sit exactly on, and the ones that do not (indents, centred headings,
 * folios) are all on one side of it. A median gets dragged that way; a mode
 * does not.
 *
 * The three-bucket window is not a refinement, it is the thing that makes the
 * mode usable at all. A cluster whose values straddle a bucket boundary is
 * split in half, and a smaller cluster that happens to sit inside one bucket
 * then wins — measured here on a fixture where 200 right edges at x=999..1001
 * fell across two buckets and lost to 130 short lines that did not, putting the
 * body measure at an eighth of its true width. Summing over the window removes
 * the dependence on where the bucket grid happens to fall; the median is then
 * taken over the whole window, so the answer does not snap to a grid either.
 */
function modalCentre(values: readonly number[], bucketWidth: number): number {
  if (values.length === 0) return 0;
  const w = Math.max(1e-6, bucketWidth);
  const buckets = new Map<number, number[]>();
  for (const v of values) {
    const k = Math.floor(v / w);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(v); else buckets.set(k, [v]);
  }
  let bestKey = 0;
  let bestCount = -1;
  const windowOf = (k: number): number[] =>
    [...(buckets.get(k - 1) ?? []), ...(buckets.get(k) ?? []), ...(buckets.get(k + 1) ?? [])];
  // Sorted keys so ties resolve to the lowest value, deterministically.
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const count = windowOf(k).length;
    if (count > bestCount) { bestCount = count; bestKey = k; }
  }
  return median(windowOf(bestKey));
}

interface TwoMeans {
  lower: number;
  upper: number;
  upperShare: number;
  /** Midpoint of the two centroids — the book-relative decision threshold. */
  threshold: number;
}

/**
 * One-dimensional 2-means, seeded at the extremes and run to convergence.
 *
 * Deterministic by construction: sorted input, fixed seeding, fixed iteration
 * cap. A calibration that moved between runs on the same book would make every
 * paragraph decision downstream unreproducible, and reproducibility is the
 * whole point of writing the verdict into the artifact.
 *
 * A degenerate input (every value identical) converges to two equal centroids
 * and a separation of zero, which is exactly the "no signal" answer wanted.
 */
function twoMeans(values: readonly number[]): TwoMeans {
  const s = [...values].sort((a, b) => a - b);
  let lower = s[0];
  let upper = s[s.length - 1];
  for (let iter = 0; iter < 32; iter++) {
    const mid = (lower + upper) / 2;
    let loSum = 0, loN = 0, hiSum = 0, hiN = 0;
    for (const v of s) {
      if (v <= mid) { loSum += v; loN++; } else { hiSum += v; hiN++; }
    }
    // An empty side means every value fell to one centroid: already converged
    // on a single cluster, and the centroids stop moving.
    const nextLower = loN ? loSum / loN : lower;
    const nextUpper = hiN ? hiSum / hiN : upper;
    if (nextLower === lower && nextUpper === upper) break;
    lower = nextLower;
    upper = nextUpper;
  }
  const mid = (lower + upper) / 2;
  const above = s.filter(v => v > mid).length;
  return { lower, upper, upperShare: s.length ? above / s.length : 0, threshold: mid };
}

function evaluate(
  samples: readonly number[],
  minSeparation: number,
  extra: (m: TwoMeans) => string | null,
): CalibrationSignal {
  if (samples.length < MIN_SAMPLES) {
    return {
      separation: 0, upperShare: 0, threshold: 0, samples: samples.length, fired: false,
      why: `only ${samples.length} usable samples, ${MIN_SAMPLES} needed`,
    };
  }
  const m = twoMeans(samples);
  const separation = m.upper - m.lower;
  const base = { separation, upperShare: m.upperShare, threshold: m.threshold, samples: samples.length };

  if (separation < minSeparation) {
    return { ...base, fired: false, why: `clusters ${separation.toFixed(2)} apart, ${minSeparation} needed` };
  }
  if (m.upperShare < MIN_UPPER_SHARE) {
    return { ...base, fired: false, why: `only ${(m.upperShare * 100).toFixed(1)}% of lines in the upper cluster — outliers, not a rhythm` };
  }
  if (m.upperShare > MAX_UPPER_SHARE) {
    return { ...base, fired: false, why: `${(m.upperShare * 100).toFixed(1)}% of lines in the upper cluster — too many to be paragraph openings` };
  }
  const objection = extra(m);
  if (objection) return { ...base, fired: false, why: objection };
  return { ...base, fired: true, why: 'clear two-cluster split at a paragraph rhythm' };
}

// ── the pass ────────────────────────────────────────────────────────────────

/** Not enough geometry to calibrate anything. Bad input, not a degradation. */
export class CalibrationInputError extends Error {
  constructor(reason: string) {
    super(`paragraph calibration: ${reason}`);
    this.name = 'CalibrationInputError';
  }
}

export interface CalibrateOptions {
  /**
   * Lines this short (as a fraction of the measure) are dropped before the
   * indent signal is measured. A three-word line tells you nothing about the
   * left margin's two clusters and plenty of them are furniture.
   */
  readonly minLineWidthShare?: number;
}

const DEFAULT_MIN_LINE_WIDTH_SHARE = 0.15;

/**
 * Classify a book's paragraph convention from its line geometry.
 *
 * Throws when there is no geometry to work with at all — a book with two lines,
 * or one whose lines have no horizontal extent, is a broken scan and saying so
 * is more useful than a verdict. It does NOT throw for a book that is merely
 * badly formatted; that is the `none` verdict.
 */
export function calibrate(
  lines: readonly CalibrationLine[],
  options: CalibrateOptions = {},
): CalibrationVerdict {
  if (lines.length < MIN_SAMPLES) {
    throw new CalibrationInputError(
      `${lines.length} lines is not enough geometry to calibrate against (need ${MIN_SAMPLES})`,
    );
  }

  const heights = lines.map(l => l.bbox[3] - l.bbox[1]);
  const bodyHeight = median(heights);
  if (!(bodyHeight > 0)) {
    throw new CalibrationInputError('median line height is zero — the line boxes carry no vertical extent');
  }

  // Pitch: the median advance between vertically consecutive lines, then
  // re-measured over a window around it. The window is what keeps paragraph
  // gaps — the very thing being detected — out of the unit they are measured
  // in. Cross-column and cross-page jumps are excluded by construction.
  const advances: number[] = [];
  const byPage = new Map<number, CalibrationLine[]>();
  for (const l of lines) {
    const page = byPage.get(l.page);
    if (page) page.push(l); else byPage.set(l.page, [l]);
  }
  for (const page of byPage.values()) {
    page.sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));
    for (let i = 1; i < page.length; i++) {
      const d = page[i].bbox[1] - page[i - 1].bbox[1];
      // Positive and no more than four lines' worth: a bigger jump is a column
      // break or a figure, not leading.
      if (d > bodyHeight * 0.25 && d < bodyHeight * 8) advances.push(d);
    }
  }
  if (advances.length < MIN_SAMPLES) {
    throw new CalibrationInputError(
      `only ${advances.length} line-to-line advances could be measured — the book has no readable vertical rhythm`,
    );
  }
  const roughPitch = median(advances);
  const inWindow = advances.filter(d => d >= roughPitch * 0.6 && d <= roughPitch * 1.35);
  const pitch = inWindow.length >= MIN_SAMPLES ? median(inWindow) : roughPitch;

  // The margins. Bucket width is a quarter of a body height: fine enough to
  // separate a one-em indent from the margin, coarse enough that scan jitter
  // does not shatter the modal bucket.
  const bucket = Math.max(1, bodyHeight / 4);
  const flushLeft = modalCentre(lines.map(l => l.bbox[0]), bucket);
  const bodyRight = modalCentre(lines.map(l => l.bbox[2]), bucket);
  const measure = bodyRight - flushLeft;
  if (!(measure > 0)) {
    throw new CalibrationInputError(
      `body measure is ${measure.toFixed(1)}px (left ${flushLeft.toFixed(1)}, right ${bodyRight.toFixed(1)})`
      + ' — the line boxes carry no horizontal extent',
    );
  }

  const minWidth = measure * (options.minLineWidthShare ?? DEFAULT_MIN_LINE_WIDTH_SHARE);

  // Indent samples. Three exclusions, each removing a known liar:
  //  - short lines carry no margin information and are mostly furniture;
  //  - CENTRED lines are indented on the left by construction and would forge
  //    an indent cluster in a book that has none (every chapter opener, every
  //    title page line);
  //  - lines starting LEFT of the margin are drop caps, marginalia, or a
  //    misdeskewed edge, and a negative inset is not a paragraph opening.
  const insets: number[] = [];
  for (const l of lines) {
    const [x0, , x1] = l.bbox;
    if (x1 - x0 < minWidth) continue;
    const leftInset = x0 - flushLeft;
    const rightInset = bodyRight - x1;
    if (leftInset < -bodyHeight * 0.5) continue;
    const centred = rightInset > bodyHeight
      && Math.abs(leftInset - rightInset) < Math.max(bodyHeight, (leftInset + rightInset) * 0.25);
    if (centred) continue;
    insets.push(Math.max(0, leftInset) / bodyHeight);
  }

  const indent = evaluate(insets, INDENT_MIN_SEPARATION, m =>
    m.lower > INDENT_MAX_FLUSH_CENTRE
      ? `the lower cluster sits ${m.lower.toFixed(2)} body heights off the margin — two indent depths, not indent-vs-flush`
      : null);

  const gaps = advances.map(d => d / pitch);
  const gap = evaluate(gaps, GAP_MIN_SEPARATION, m =>
    m.upper < GAP_MIN_UPPER_CENTRE
      ? `the upper cluster is only ${m.upper.toFixed(2)}x pitch — wider leading, not a blank line`
      : null);

  // Both signals firing means the book uses indents AND blank lines, or that
  // one of them is an artefact. Take the stronger, measured as how far each
  // cleared its own minimum — the two separations are in different units and
  // cannot be compared directly. Ties go to indent: it survives page breaks
  // (an indent is horizontal), and a gap signal cannot be measured across one.
  const indentStrength = indent.separation / INDENT_MIN_SEPARATION;
  const gapStrength = gap.separation / GAP_MIN_SEPARATION;
  const convention = indent.fired && gap.fired
    ? (gapStrength > indentStrength ? 'block' : 'indent')
    : indent.fired ? 'indent'
    : gap.fired ? 'block'
    : 'none';

  const message = convention === 'none'
    ? 'NO PARAGRAPH CONVENTION DETECTED. Neither signal is present in this book'
      + ` — indent: ${indent.why}; gap: ${gap.why}.`
      + ' Paragraph breaks will come from the hard rules alone, so the export will contain'
      + ' few or no breaks and long paragraphs. This is the documented degradation for a'
      + ' source with no usable formatting (PIPELINE.md): the run continues and the EPUB is'
      + ' produced. Nothing is guessed.'
    : convention === 'indent'
      ? `Indent convention: paragraphs open with a first-line indent, and the book's own`
        + ` split puts the threshold at ${indent.threshold.toFixed(2)} body heights`
        + ` over ${indent.samples} lines.`
      : `Block convention: paragraphs are separated by extra vertical space, and the book's own`
        + ` split puts the threshold at ${gap.threshold.toFixed(2)}x line pitch.`;

  return {
    convention,
    degraded: convention === 'none',
    bodyHeight,
    pitch,
    flushLeft,
    measure,
    bodyRight,
    indent,
    gap,
    message,
  };
}
