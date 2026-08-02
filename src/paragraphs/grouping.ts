/**
 * grouping — continue-or-break for every adjacent block pair, and the report
 * that says why.
 *
 * This is the applier of RUBRIC_TRAINING §9d decision 2: the near-certain rules
 * live HERE, where the model cannot overrule them, and the model only
 * adjudicates the residue. A precedence ladder, highest first:
 *
 *   1. HARD RULES. A category transition breaks; a wrap hyphen on the previous
 *      block continues (measured 132/133). Never overruled, by anything.
 *   2. THE MODEL'S `continues` BIT, when it is present and confident.
 *   3. GEOMETRY, read through the book's calibrated convention.
 *   4. MERGE. Unsure is a decision, and it is always "keep going".
 *
 * ## Why the ladder tilts toward merging
 *
 * §9d decision 3, and it is the reason this stage exists as a separate thing
 * from block formation: **the two stages' default biases point in OPPOSITE
 * directions**. Block formation splits when unsure, because a fused
 * footnote-plus-body block has no correct label and leaks a footnote into the
 * narration. Paragraph assembly merges when unsure, because the two errors are
 * not symmetric in the ear:
 *
 *   - a MISSED break is a long prosody run. The owner's verdict: fine.
 *   - a FALSE break is a full stop in the middle of a sentence. The owner's
 *     verdict: that is the actual problem.
 *
 * Both biases compose because splitting runs before labelling and merging runs
 * after. Every "I don't know" in this file therefore resolves to `continue`,
 * and the report counts them so the resolution is visible rather than implied.
 *
 * ## What happens when the two hard rules disagree
 *
 * PIPELINE.md and §9d both state the hard rules as a set without ordering them,
 * and they can collide: a body block ending in a wrap hyphen followed by a
 * block of a different category. **The category transition wins**, and the
 * junction is counted separately as a conflict.
 *
 * The reasoning: a hyphen spanning a category change is a SEGMENTATION error,
 * not a continuation. `continues` only has meaning inside running text — §9d
 * confines the model to body-to-body and quote-to-quote junctions for exactly
 * this reason — and honouring the hyphen would weld a body sentence onto a
 * footnote or a running head, damaging both. Conflicts are surfaced in the
 * report because a book with many of them has a block-formation problem worth
 * looking at, which is information a silent tiebreak would throw away.
 */
import type { Block, CalibrationVerdict, ParagraphConvention } from '../pipeline/artifacts.js';
import type { BoxesCategory } from '../boxes/encoder.js';

/**
 * The categories a paragraph may flow through. §9d: breaks only ever exist
 * inside running text, and the category head has already isolated it. Every
 * other category is structural — a heading, a caption, a list — and stands
 * alone by definition, so it never merges with a neighbour even when the
 * neighbour has the same label.
 */
export const FLOWING_CATEGORIES: ReadonlySet<BoxesCategory> = new Set<BoxesCategory>(['body', 'quote']);

/**
 * How sure the model must be before its bit outranks geometry.
 *
 * §9d decision 3: low-confidence `continues` output means merge. That is not
 * implemented as "low confidence means continue" but as "low confidence means
 * the bit is not used" — the junction falls to geometry, and geometry's own
 * unsure case is what merges. A confident `false` from the model is honoured;
 * an unsure one never fabricates a break.
 */
const DEFAULT_CONTINUES_MIN_CONFIDENCE = 0.6;

export type JunctionReason =
  /** Neighbouring blocks carry different categories. Breaks. */
  | 'hard:category-transition'
  /** Both blocks share a category that paragraphs do not flow through. Breaks. */
  | 'hard:non-flowing-category'
  /** A category transition overruled a wrap hyphen. Breaks. See the header. */
  | 'hard:conflict-category-over-hyphen'
  /** The previous block ends mid-word. Continues. */
  | 'hard:wrap-hyphen'
  /** The model's confident bit decided it. */
  | 'model:continues'
  /** The first line is indented past the book's own threshold, or is not. */
  | 'geometry:indent'
  /** The advance above clears the book's own threshold, or does not. */
  | 'geometry:gap'
  /** No gap is measurable across a page break, but the last line ran full. Continues. */
  | 'geometry:prev-line-full'
  /** Nothing decided it. Continues, by the merge bias. */
  | 'merge:unsure';

export type PrecedenceLevel = 'hard' | 'model' | 'geometry' | 'merge';

/** One adjacent pair, and the reason it went the way it did. */
export interface Junction {
  prevBlockId: string;
  blockId: string;
  decision: 'continue' | 'break';
  reason: JunctionReason;
  level: PrecedenceLevel;
}

/** A run of blocks that becomes one paragraph (or one structural element). */
export interface ParagraphGroup {
  id: string;
  category: BoxesCategory;
  /** The page the group opens on. */
  page: number;
  blockIds: string[];
}

export interface GroupingReport {
  convention: ParagraphConvention;
  /** True iff the book had no detectable convention. Read `message`. */
  degraded: boolean;
  blocks: number;
  groups: number;
  junctions: number;
  breaks: number;
  continues: number;
  /** How many decisions came from each rung of the ladder. */
  byLevel: Record<PrecedenceLevel, number>;
  byReason: Record<JunctionReason, number>;
  /**
   * Junctions where a wrap hyphen met a category transition. Not an error, but
   * a count worth watching: many of them means block formation is fusing things.
   */
  conflicts: number;
  /** Junctions between two flowing blocks — the only ones that could have merged. */
  flowingJunctions: number;
  message: string;
}

export interface GroupingOptions {
  readonly continuesMinConfidence?: number;
}

/** Blocks that arrived out of reading order. Bad input, named. */
export class GroupingInputError extends Error {
  constructor(reason: string) {
    super(`paragraph grouping: ${reason}`);
    this.name = 'GroupingInputError';
  }
}

const REASONS: readonly JunctionReason[] = [
  'hard:category-transition', 'hard:non-flowing-category', 'hard:conflict-category-over-hyphen',
  'hard:wrap-hyphen', 'model:continues', 'geometry:indent', 'geometry:gap',
  'geometry:prev-line-full', 'merge:unsure',
];

type GeometricVerdict =
  | { decision: 'continue' | 'break'; reason: JunctionReason }
  | { decision: 'unsure' };

/**
 * Rung 3. Read the block's geometry through the convention the book was
 * calibrated to, and be willing to say "unsure" — which is the point of having
 * a rung 4.
 *
 * The dead-zone rule: a break needs the evidence to clear the book's own
 * threshold, a continue needs it to sit clearly BELOW the threshold, and the
 * band between them is unsure. Without the dead zone every junction gets an
 * answer, including the ones a hair either side of the line, and those are
 * exactly the coin flips the merge bias exists to catch.
 */
function geometric(block: Block, cal: CalibrationVerdict): GeometricVerdict {
  const g = block.geometry;

  if (cal.convention === 'indent') {
    const t = cal.indent.threshold;
    if (g.firstLineIndent >= t) return { decision: 'break', reason: 'geometry:indent' };
    if (g.firstLineIndent <= t * 0.5) return { decision: 'continue', reason: 'geometry:indent' };
    return { decision: 'unsure' };
  }

  if (cal.convention === 'block') {
    if (g.gapAbove !== null) {
      const t = cal.gap.threshold;
      if (g.gapAbove >= t) return { decision: 'break', reason: 'geometry:gap' };
      // Halfway between normal leading (1.0) and the book's break threshold.
      if (g.gapAbove < 1 + (t - 1) * 0.5) return { decision: 'continue', reason: 'geometry:gap' };
      return { decision: 'unsure' };
    }
    // Across a page break there is no advance to measure, and a gap-style book
    // has no horizontal signal to fall back on. What is left is the previous
    // page's last line: if it ran the full measure the sentence was still going,
    // which is solid evidence to continue. If it stopped short, the paragraph
    // MAY have ended there — or the page simply ended on a short line — and
    // that ambiguity is what the merge bias is for.
    if (!g.prevLineShort) return { decision: 'continue', reason: 'geometry:prev-line-full' };
    return { decision: 'unsure' };
  }

  // 'none': there is no signal to read. Everything is unsure, every flowing
  // junction merges, and the book gets long paragraphs — loudly reported.
  return { decision: 'unsure' };
}

/**
 * Assemble paragraphs from labelled blocks.
 *
 * `blocks` must be in reading order — the order `boxes/blocks.json` carries,
 * which is the order the encoder read them in. Out-of-order pages throw rather
 * than being sorted, because a re-sort would silently paper over an upstream
 * bug whose real symptom is scrambled prose.
 */
export function groupParagraphs(
  blocks: readonly Block[],
  calibration: CalibrationVerdict,
  options: GroupingOptions = {},
): { groups: ParagraphGroup[]; junctions: Junction[]; report: GroupingReport } {
  const minConfidence = options.continuesMinConfidence ?? DEFAULT_CONTINUES_MIN_CONFIDENCE;

  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].page < blocks[i - 1].page) {
      throw new GroupingInputError(
        `blocks are not in reading order — block ${blocks[i].id} is on page ${blocks[i].page},`
        + ` after block ${blocks[i - 1].id} on page ${blocks[i - 1].page}`,
      );
    }
  }

  const junctions: Junction[] = [];
  const groups: ParagraphGroup[] = [];
  const byReason = Object.fromEntries(REASONS.map(r => [r, 0])) as Record<JunctionReason, number>;
  const byLevel: Record<PrecedenceLevel, number> = { hard: 0, model: 0, geometry: 0, merge: 0 };
  let conflicts = 0;
  let flowingJunctions = 0;

  const startGroup = (b: Block): void => {
    groups.push({ id: `p${String(groups.length + 1).padStart(4, '0')}`, category: b.category, page: b.page, blockIds: [b.id] });
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i === 0) { startGroup(b); continue; }
    const prev = blocks[i - 1];

    let decision: 'continue' | 'break';
    let reason: JunctionReason;
    let level: PrecedenceLevel;

    const bothFlowing = FLOWING_CATEGORIES.has(prev.category) && FLOWING_CATEGORIES.has(b.category);
    const sameCategory = prev.category === b.category;

    if (!bothFlowing || !sameCategory) {
      // Rung 1, the breaking half.
      level = 'hard';
      decision = 'break';
      if (!sameCategory) {
        // The conflict case: a wrap hyphen the transition overrules. Counted,
        // never honoured — see the header.
        if (b.geometry.prevEndsWrapHyphen) {
          conflicts++;
          reason = 'hard:conflict-category-over-hyphen';
        } else {
          reason = 'hard:category-transition';
        }
      } else {
        reason = 'hard:non-flowing-category';
      }
    } else {
      flowingJunctions++;
      if (b.geometry.prevEndsWrapHyphen) {
        // Rung 1, the continuing half. A word split across the junction is the
        // strongest evidence there is that the two blocks are one paragraph.
        level = 'hard';
        decision = 'continue';
        reason = 'hard:wrap-hyphen';
      } else if (b.continues !== undefined && (b.continues.confidence ?? 1) >= minConfidence) {
        // Rung 2. An absent confidence means the bit is taken at face value:
        // its presence IS the model's assertion, and a v6 answer that carries
        // no probability is not thereby a doubtful one.
        level = 'model';
        decision = b.continues.value ? 'continue' : 'break';
        reason = 'model:continues';
      } else {
        const verdict = geometric(b, calibration);
        if (verdict.decision === 'unsure') {
          // Rung 4.
          level = 'merge';
          decision = 'continue';
          reason = 'merge:unsure';
        } else {
          level = 'geometry';
          decision = verdict.decision;
          reason = verdict.reason;
        }
      }
    }

    junctions.push({ prevBlockId: prev.id, blockId: b.id, decision, reason, level });
    byReason[reason]++;
    byLevel[level]++;

    if (decision === 'break') startGroup(b);
    else groups[groups.length - 1].blockIds.push(b.id);
  }

  const breaks = junctions.filter(j => j.decision === 'break').length;
  const report: GroupingReport = {
    convention: calibration.convention,
    degraded: calibration.degraded,
    blocks: blocks.length,
    groups: groups.length,
    junctions: junctions.length,
    breaks,
    continues: junctions.length - breaks,
    byLevel,
    byReason,
    conflicts,
    flowingJunctions,
    message: '',
  };
  report.message = describe(report, calibration);
  return { groups, junctions, report };
}

/**
 * The report's headline sentence — and, when the book degraded, the loud
 * verdict PIPELINE.md requires. It states what was lost, in counts, and says
 * plainly that the run did not fail. A degradation nobody can see is the thing
 * the no-fallbacks rule exists to prevent; this is the sanctioned exception, so
 * it pays for itself by being impossible to miss.
 */
function describe(r: GroupingReport, cal: CalibrationVerdict): string {
  if (!r.degraded) {
    return `Paragraphs assembled under the ${r.convention} convention:`
      + ` ${r.blocks} blocks into ${r.groups} groups`
      + ` (${r.breaks} breaks, ${r.continues} continues;`
      + ` ${r.byLevel.hard} hard, ${r.byLevel.model} model, ${r.byLevel.geometry} geometric,`
      + ` ${r.byLevel.merge} merged when unsure).`;
  }
  const merged = r.byReason['merge:unsure'];
  return 'DEGRADED PARAGRAPH ASSEMBLY — THIS BOOK HAS NO DETECTABLE PARAGRAPH CONVENTION.\n'
    + `${cal.message}\n`
    + `Result: ${r.blocks} blocks became ${r.groups} groups. Of ${r.flowingJunctions} junctions inside`
    + ` running text, ${merged} were merged for want of any signal and ${r.byReason['hard:wrap-hyphen']}`
    + ' were joined by a wrap hyphen; the breaks that remain come from category transitions alone.\n'
    + 'The EPUB will read as a small number of long paragraphs. Too few paragraphs is'
    + ' acceptable for narration and too many is not, so the pipeline merged rather than guessed.'
    + ' THE RUN DID NOT FAIL and the export is complete.';
}
