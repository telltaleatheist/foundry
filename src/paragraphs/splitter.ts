/**
 * splitter — cut a formed block at its PARAGRAPH-START CANDIDATES.
 *
 * BLOCKS_TRAINING §13b (P0), and it exists because of one measurement. On the
 * Kershaw journal run the gap rule that forms blocks produced 24 body blocks
 * holding 578 lines — one of them 42 lines, a whole page of prose — while the
 * ink on those pages shows ~53 paragraph openings. Seven body→body junctions
 * for fifty-three paragraphs. Every break inside a block is unreachable: the
 * grouping ladder only ever decides AT a junction, so a paragraph boundary that
 * is not a junction cannot be found by geometry, by a hard rule, or by any
 * future `continues` bit. `formBlocks` cuts on vertical gap alone; it never cuts
 * at an indent, never at a short previous line, and on a flush book it never
 * cuts at all.
 *
 * So this module manufactures the junctions. It NEVER merges — merging is the
 * grouping stage's job, one stage later, and the two biases are opposite on
 * purpose (§9d decision 3): **block formation splits when unsure, paragraph
 * assembly merges when unsure.** They compose because splitting runs before
 * labelling and merging runs after. Over-splitting is recoverable — the ladder's
 * merge bias rejoins a junction nothing votes to break, and a `continues` head
 * will do it better. Under-splitting is NOT recoverable by anything downstream,
 * which is why every rule below is an OR and none of them is ANDed with a
 * corroborating signal.
 *
 * ## What it is allowed to read
 *
 * Line geometry and line text, and nothing else. No categories (there are none
 * yet — this runs before the model classifies anything), and no model output of
 * any kind. Three signals, exactly the three §13b names:
 *
 *   1. **INDENT** — the line starts further right than its block's own margin,
 *      past the book's own measured indent threshold.
 *   2. **GAP** — the advance from the previous line clears the book's own gap
 *      threshold, the one `calibrate()` derived. Only when calibration actually
 *      found a gap convention: a book with no gap signal has no gap threshold,
 *      and inventing one is the fabricated fallback the no-fallbacks rule
 *      forbids.
 *   3. **FILL** — the previous line stopped short of the block's own measure.
 *      This is the flush convention's only signal and the one the current
 *      calibration cannot see at all (§13b finding 2).
 *
 * ## Why this re-derives what Tesseract can already do
 *
 * On an indent-convention book Tesseract's OWN paragraph segmentation is
 * excellent — BookForge's picker treats its paragraph boundaries as
 * authoritative and they come out as exactly the paragraphs, first-line indents
 * and all. **That segmentation does not exist in this pipeline, and it is not
 * cheaply retainable.** `scan` writes one PGM crop per BAND and reads it with
 * `--psm 7` (`scan/tesseract.ts`), parsing TSV at the word level: every crop is
 * its own image, so `block_num`/`par_num` are the constant 1 and carry no
 * information to keep. Getting Tesseract's paragraphs would mean a SECOND,
 * page-level pass at psm 3 — a second segmenter, whose paragraph boundaries
 * would then have to be reconciled with the bands' lines, on a path that took
 * layout away from Tesseract deliberately because its page analysis silently
 * DROPS whole lines. That is a design decision, not a P0 detail.
 *
 * So the geometry below is the whole of what this path has. It is also what
 * Tesseract could not answer anyway on the case that forced P0: a flush-set
 * book with no indent to see (§13b, Kershaw).
 *
 * ## Everything is measured against the BLOCK, not the page
 *
 * A block is one column of one page, so its own modal left edge, modal right
 * edge, median line height and median advance are the frame every sample below
 * is expressed in. That is not a refinement, it is what makes the rules work at
 * all on a real run: the Kershaw run's 17 pages are not all the same size (two
 * are 1653px wide against fifteen at 1300), so the book-wide `flushLeft` of 168
 * px reads every flush line on the wide pages as indented by 3.4 body heights.
 * A block-local margin is immune to that, and it is immune in the same way to
 * a block quote (whose lines are all inset) and to a footnote apparatus (whose
 * margin is its own).
 *
 * The book-level THRESHOLDS are still book-level, per §13b — one threshold,
 * measured over every candidate in the book, in the book's own dimensionless
 * units. A per-block threshold would be measured over a dozen samples and would
 * find a convention in every accident.
 *
 * ## The liars, and what stops them
 *
 * - **A centred line is indented on the left by construction** and short on the
 *   right by construction. It is excluded from the indent evidence as a
 *   candidate and from the fill evidence as a predecessor, so a two-line centred
 *   title is never cut between its lines. (Where a cut lands next to display
 *   material anyway, `display-run-merge` rejoins it — this stage runs before it,
 *   deliberately, so it is the merge rule's input.)
 * - **Display type has display leading.** The gap rule reads the advance in the
 *   BLOCK's pitch, and where a block is too short to measure one the book's
 *   pitch stands in scaled by the block's type size. Unscaled, every two-line
 *   title on a title page is "gapped" — measured, and it cut the Kershaw title
 *   page's publisher imprint in half.
 * - **A page-final short line** is short for reasons of pagination. It cannot
 *   produce a cut here because it is the last line of its block and this module
 *   only ever cuts BETWEEN a block's own lines; that junction already exists.
 * - **A ragged-right book** has no full-line cluster at all, so every line looks
 *   like the end of a paragraph. The fill signal refuses to fire unless the
 *   book's full cluster actually reaches the measure, and says so.
 * - **A wrap hyphen** is 132/133 proof the sentence continues (§9d decision 2).
 *   No rule may cut through one. The ladder would rejoin it, but the export
 *   heals hyphens per paragraph GROUP, so a cut that survived to the EPUB would
 *   break a word in half — and that is not recoverable either.
 * - **A drop cap** distorts the first lines of a chapter opening: the initial
 *   sits in its own band and the lines beside it are inset by its width. Those
 *   inset lines are candidates and will be cut, which is over-splitting in the
 *   direction the ladder can undo.
 *
 * ## Output
 *
 * A PLAN, not new blocks — the same shape `planDisplayRuns` returns, and for the
 * same reason: the geometry is decided here and testable in isolation, while the
 * block rebuild stays with `makeBlock`, which is the one place a block's fields
 * are ever computed.
 */
import type { Box } from '../scan/bands.js';
import type { CalibrationSignal, CalibrationVerdict } from '../pipeline/artifacts.js';
import {
  INDENT_MIN_SEPARATION, evaluateClusterSignal, median, modalCentre, twoMeans,
} from './calibration.js';
import { SHORT_LINE_UNITS } from './geometry.js';
import { isWrapHyphenBreak } from './hyphen.js';

/** What the splitter needs from a line. `ScanLine` satisfies it. */
export interface SplitLine {
  id: string;
  /** [x0,y0,x1,y1], half-open, full-page px, DESKEWED. */
  bbox: Box;
  text: string;
}

/** What it needs from a block: identity and its lines, in reading order. */
export interface SplitBlock {
  id: string;
  page: number;
  lineIds: readonly string[];
}

/**
 * The tuned constants. `INDENT_MIN_SEPARATION` and `SHORT_LINE_UNITS` are
 * IMPORTED rather than restated: the first is calibration's own "these are two
 * clusters" minimum and the second is the ladder's own definition of a short
 * line, and the splitter must mean the same things by them.
 */
export const PARAGRAPH_SPLIT_RULE = {
  /**
   * The segmentation marker. It goes into `blocks/blocks.json` as part of
   * `formation`, because a prediction made under one segmentation and a
   * prediction made under another saw different blocks (ARCHITECTURE §5).
   */
  version: 'para-split-v1',
  /** Two clusters of line inset must sit this far apart to be two. */
  INDENT_MIN_SEPARATION,
  /**
   * The deepest inset that can still be a first-line indent, in body heights.
   *
   * Past four body heights an inset is structural — a hanging indent's
   * continuation lines, a nested list, a verse line — and it is not evidence
   * about how this book opens paragraphs. Left in the sample it is the same
   * liar `GAP_MAX_SAMPLE` removes from the gap signal: a regular, paragraph-
   * shaped share of samples sitting at a depth no paragraph uses, which is
   * exactly the shape a two-cluster split latches onto. (It is a MEASUREMENT
   * exclusion only; a line inset past it is still a candidate, and still gets
   * cut when the book's threshold is below it.)
   */
  INDENT_MAX_SAMPLE: 4.0,
  /** A line this much shorter than the block's measure has stopped early. */
  SHORT_LINE_UNITS,
  /**
   * The full-line cluster must actually reach the measure, within this many
   * body heights. It is what distinguishes a justified book — where a short
   * line means something — from a ragged-right one, where every line is short
   * and the signal carries no information at all.
   */
  FILL_MAX_FULL_CENTRE: 1.0,
  /**
   * Lines narrower than this share of their block's measure carry no margin
   * information (calibration's `DEFAULT_MIN_LINE_WIDTH_SHARE`, same reasoning).
   */
  MIN_LINE_WIDTH_SHARE: 0.15,
} as const;

/** Which rule proposed a cut. A cut may be proposed by more than one. */
export interface SplitRules {
  indent: boolean;
  gap: boolean;
  fill: boolean;
}

/** One proposed cut: a new block starts at `lineIndex` of `blockId`. */
export interface ParagraphSplit {
  blockId: string;
  /** Index into the block's `lineIds`. Always >= 1. */
  lineIndex: number;
  rules: SplitRules;
}

/**
 * The gap signal is not measured here — it is calibration's, unchanged, and
 * this records whether it was usable and what it said.
 */
export interface GapSignalUse {
  available: boolean;
  threshold: number;
  why: string;
}

export interface ParagraphSplitReport {
  version: string;
  /** Insets of intra-block lines against their block's own margin, in body heights. */
  indent: CalibrationSignal;
  /** Shortfall of intra-block lines against their block's own measure, in body heights. */
  fill: CalibrationSignal;
  gap: GapSignalUse;
  /** The book's own decision thresholds, in the units above. */
  thresholds: { indent: number | null; gap: number | null; fill: number | null };
  blocksIn: number;
  /** How many blocks the plan produces once applied. */
  blocksOut: number;
  cuts: number;
  /** Cuts each rule proposed. They overlap; the sum exceeds `cuts`. */
  byRule: { indent: number; gap: number; fill: number };
  /** Candidates refused because the previous line ended in a wrap hyphen. */
  hyphenBlocked: number;
  message: string;
}

export interface ParagraphSplitPlan {
  splits: ParagraphSplit[];
  report: ParagraphSplitReport;
}

/** A block naming a line that is not in the line table, or holding none. */
export class ParagraphSplitInputError extends Error {
  constructor(reason: string) {
    super(`paragraph split: ${reason}`);
    this.name = 'ParagraphSplitInputError';
  }
}

/** A block's own frame: everything a sample inside it is measured against. */
interface BlockFrame {
  left: number;
  right: number;
  height: number;
  pitch: number;
}

/** One line-to-line junction inside a block, with its evidence. */
interface Candidate {
  blockId: string;
  lineIndex: number;
  /** Inset against the block's margin, in block body heights. Null: the line cannot say. */
  indentUnits: number | null;
  /** The PREVIOUS line's shortfall against the block's measure. Null: it cannot say. */
  shortfallUnits: number | null;
  /** Advance from the previous line, in block pitches. */
  advanceRatio: number;
  wrapHyphen: boolean;
}

/**
 * Is this line centred in its block? Same test calibration uses, against the
 * block's frame instead of the book's: comfortably inset on BOTH sides and
 * roughly equally so.
 */
function isCentred(line: SplitLine, frame: BlockFrame): boolean {
  const leftInset = line.bbox[0] - frame.left;
  const rightInset = frame.right - line.bbox[2];
  return rightInset > frame.height
    && Math.abs(leftInset - rightInset) < Math.max(frame.height, (leftInset + rightInset) * 0.25);
}

/**
 * The block's own frame.
 *
 * Modal edges rather than min/max: one overhanging line (a marginal note, a
 * stray speck the segmenter kept) would otherwise define the margin for every
 * line under it. Median height and median advance are the block's type size and
 * leading — local, so a footnote apparatus set two points down is measured in
 * its own units and a wider page in its own.
 */
function frameOf(lines: readonly SplitLine[], calibration: CalibrationVerdict): BlockFrame {
  const height = median(lines.map(l => l.bbox[3] - l.bbox[1])) || 1;
  const bucket = Math.max(1, height / 4);
  const advances: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].bbox[1] - lines[i - 1].bbox[1];
    if (d > height * 0.25 && d < height * 8) advances.push(d);
  }
  return {
    left: modalCentre(lines.map(l => l.bbox[0]), bucket),
    // NEGATED, so the mode's tie-break runs the other way. `modalCentre`
    // resolves an equal count to the LOWEST value, which is what a left margin
    // wants and the exact opposite of what a right one does: on a two-line
    // centred title neither edge has a majority, and taking the lower of the two
    // right edges put the block's "measure" inside its own text — the longer
    // line then read as overhanging, the shorter one as flush, and the centred
    // test that should have protected the title could not fire. Measured on the
    // Kershaw title page ("CAMBRIDGE / UNIVERSITY PRESS", cut in two).
    right: -modalCentre(lines.map(l => -l.bbox[2]), bucket),
    height,
    // Three advances is the fewest that can carry a median at all. Below that
    // the book's pitch stands in — SCALED BY THIS BLOCK'S TYPE SIZE, because
    // leading is proportional to type and the book's pitch is the body's.
    // Unscaled it reads every two-line display block as gapped: the Kershaw
    // title page sets CAMBRIDGE / UNIVERSITY PRESS at 2.5x body size, so its
    // ordinary leading is 2.17x the BODY pitch and the gap rule cut the
    // publisher's name in half.
    pitch: advances.length >= 3
      ? median(advances)
      : calibration.pitch * (height / (calibration.bodyHeight || height)),
  };
}

/** Every intra-block junction in the book, with its evidence, in reading order. */
function candidatesOf(
  blocks: readonly SplitBlock[],
  lines: readonly SplitLine[],
  calibration: CalibrationVerdict,
): Candidate[] {
  const byId = new Map(lines.map(l => [l.id, l] as const));
  const out: Candidate[] = [];

  for (const b of blocks) {
    if (b.lineIds.length === 0) throw new ParagraphSplitInputError(`block ${b.id} has no lines`);
    const own = b.lineIds.map(id => {
      const l = byId.get(id);
      if (!l) {
        throw new ParagraphSplitInputError(
          `block ${b.id} references line ${id}, which is not in scan/lines.json`,
        );
      }
      return l;
    });
    if (own.length < 2) continue;

    const frame = frameOf(own, calibration);
    const measure = frame.right - frame.left;
    const minWidth = measure * PARAGRAPH_SPLIT_RULE.MIN_LINE_WIDTH_SHARE;

    for (let i = 1; i < own.length; i++) {
      const line = own[i];
      const prev = own[i - 1];
      const wide = line.bbox[2] - line.bbox[0] >= minWidth;
      const indentUnits = wide && !isCentred(line, frame)
        ? (line.bbox[0] - frame.left) / frame.height
        : null;
      // CLAMPED AT ZERO. A line that runs PAST the block's modal right edge has
      // reached the measure; it is not "extra full", and there is no such thing.
      // Left signed, those lines form a phantom lower cluster all of their own —
      // measured on the Kershaw run, where blocks whose modal right edge is set
      // by a majority of short lines produced shortfalls down to -11 body
      // heights, dragged the two-cluster midpoint to -4, and made the signal
      // report 97% of the book's lines as paragraph openings.
      const shortfallUnits = isCentred(prev, frame)
        ? null
        : Math.max(0, (frame.right - prev.bbox[2]) / frame.height);
      out.push({
        blockId: b.id,
        lineIndex: i,
        indentUnits,
        shortfallUnits,
        advanceRatio: (line.bbox[1] - prev.bbox[1]) / frame.pitch,
        wrapHyphen: isWrapHyphenBreak(prev.text, line.text),
      });
    }
  }
  return out;
}

/**
 * Plan the paragraph-start cuts for a book's blocks.
 *
 * `blocks` are the blocks as formed (reading order, page order); `lines` must
 * contain every line they reference. A block whose lines are missing is an
 * upstream bug and throws, rather than being silently left uncut.
 *
 * The verdict is a pure function of the geometry and the calibration frame, so
 * a run directory explains its own segmentation.
 */
export function planParagraphSplits(
  blocks: readonly SplitBlock[],
  lines: readonly SplitLine[],
  calibration: CalibrationVerdict,
): ParagraphSplitPlan {
  const candidates = candidatesOf(blocks, lines, calibration);

  // ── the book's own thresholds ──────────────────────────────────────────────
  //
  // INDENT: the same two-cluster rhythm test calibration applies, over insets
  // measured against each block's own margin instead of the book's. That is the
  // §13b finding made operational — the book-wide clustering was swallowed by
  // centred display lines and deep footnote indents and reported the live signal
  // as absent, at 1.8% of lines, while the ink carried a clean +1.2-body-height
  // cluster over 53 of them.
  const indentSamples = candidates
    .map(c => c.indentUnits)
    .filter((v): v is number => v !== null && v <= PARAGRAPH_SPLIT_RULE.INDENT_MAX_SAMPLE)
    .map(v => Math.max(0, v));
  const indent = evaluateClusterSignal(indentSamples, PARAGRAPH_SPLIT_RULE.INDENT_MIN_SEPARATION, () => null);

  // FILL: the same test over the previous line's shortfall. The threshold is
  // NOT the midpoint the other signals use, and the difference is deliberate:
  // the two clusters here are "reached the measure" and "stopped somewhere
  // earlier", and the second has no characteristic depth — a paragraph's last
  // line ends wherever the sentence ended, anywhere from one word to a full
  // line short. A midpoint between "0" and "wherever" is a threshold that rises
  // with how short the book's last lines happen to run, and every sample below
  // it is a paragraph opening MISSED — the one direction nothing downstream can
  // repair. So the rule is the ladder's own: short means past the full cluster
  // by SHORT_LINE_UNITS, the same number `prevLineShort` uses at the junction
  // this cut creates.
  const fillSamples = candidates
    .map(c => c.shortfallUnits)
    .filter((v): v is number => v !== null);
  const fill = evaluateClusterSignal(fillSamples, PARAGRAPH_SPLIT_RULE.SHORT_LINE_UNITS, m =>
    m.lower > PARAGRAPH_SPLIT_RULE.FILL_MAX_FULL_CENTRE
      ? `the full-line cluster sits ${m.lower.toFixed(2)} body heights short of the measure`
        + ' — this setting is ragged right, so a short line says nothing about paragraphs'
      : null);
  const fillThreshold = fill.fired
    ? twoMeans(fillSamples).lower + PARAGRAPH_SPLIT_RULE.SHORT_LINE_UNITS
    : null;

  // GAP: calibration's, unchanged, and only when the book actually has one.
  const gap: GapSignalUse = calibration.gap.fired
    ? { available: true, threshold: calibration.gap.threshold, why: calibration.gap.why }
    : { available: false, threshold: 0, why: calibration.gap.why };

  // ── the decision ──────────────────────────────────────────────────────────
  const splits: ParagraphSplit[] = [];
  const byRule = { indent: 0, gap: 0, fill: 0 };
  let hyphenBlocked = 0;

  for (const c of candidates) {
    const rules: SplitRules = {
      indent: indent.fired && c.indentUnits !== null && c.indentUnits >= indent.threshold,
      gap: gap.available && c.advanceRatio >= gap.threshold,
      fill: fillThreshold !== null && c.shortfallUnits !== null && c.shortfallUnits >= fillThreshold,
    };
    if (!rules.indent && !rules.gap && !rules.fill) continue;
    if (c.wrapHyphen) { hyphenBlocked++; continue; }
    if (rules.indent) byRule.indent++;
    if (rules.gap) byRule.gap++;
    if (rules.fill) byRule.fill++;
    splits.push({ blockId: c.blockId, lineIndex: c.lineIndex, rules });
  }

  const report: ParagraphSplitReport = {
    version: PARAGRAPH_SPLIT_RULE.version,
    indent,
    fill,
    gap,
    thresholds: {
      indent: indent.fired ? indent.threshold : null,
      gap: gap.available ? gap.threshold : null,
      fill: fillThreshold,
    },
    blocksIn: blocks.length,
    blocksOut: blocks.length + splits.length,
    cuts: splits.length,
    byRule,
    hyphenBlocked,
    message: '',
  };
  report.message = describe(report);
  return { splits, report };
}

function describe(r: ParagraphSplitReport): string {
  const fired = [
    r.indent.fired ? `indent (>= ${r.indent.threshold.toFixed(2)} body heights, ${r.indent.samples} samples)` : null,
    r.gap.available ? `gap (>= ${r.gap.threshold.toFixed(2)}x pitch)` : null,
    r.thresholds.fill !== null ? `short previous line (>= ${r.thresholds.fill.toFixed(2)} body heights, ${r.fill.samples} samples)` : null,
  ].filter((s): s is string => s !== null);

  if (fired.length === 0) {
    // The same sanctioned degradation calibration reports: no signal, no
    // guessing, and the book still exports — with the long paragraphs §9d
    // decision 5 says are the acceptable failure.
    return `NO PARAGRAPH-START SIGNAL. Blocks were left as the gap rule formed them`
      + ` (${r.blocksIn}), so a paragraph boundary inside a block cannot be found later.`
      + ` indent: ${r.indent.why}; gap: ${r.gap.why}; fill: ${r.fill.why}.`;
  }
  return `Paragraph starts from ${fired.join(', ')}:`
    + ` ${r.cuts} cuts split ${r.blocksIn} blocks into ${r.blocksOut}`
    + ` (indent ${r.byRule.indent}, gap ${r.byRule.gap}, short line ${r.byRule.fill};`
    + ` ${r.hyphenBlocked} refused across a wrap hyphen).`;
}
