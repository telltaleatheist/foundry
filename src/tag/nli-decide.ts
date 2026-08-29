/**
 * tag/nli-decide — the NLI-only engine's whole judgment, in one pure function.
 *
 * The full engine ranks with the entailment model and DECIDES with an LLM.
 * This engine decides from the ranker's own scores, because the machine it is
 * for (a 1.9 GB droplet holding a production site) cannot hold an LLM at all —
 * Owen's 2026-08-29 direction: test whether scores alone are precise enough
 * for a predefined vocabulary, and reassess if they are not.
 *
 * ── WHAT THE RULE HAS TO SURVIVE ────────────────────────────────────────────
 *
 * The capture floor (0.2) is a RECALL setting: it exists to hand a verifier
 * everything worth judging, and the false positives it admits were the
 * verifier's job to kill. With no verifier, "anything crossed the floor" would
 * tag a fifty-page filing "ban" for one passing mention. So the decision here
 * is document-level and asks for CORROBORATION:
 *
 *   - only SENTENCE-level candidates are counted. A window candidate is the
 *     same evidence wearing a coat: one strong sentence appears again in up to
 *     three windows, and counting it four times would let a single sentence
 *     impersonate a theme.
 *   - a sentence counts as STRONG at ≥ 0.90 — on this model's score
 *     distribution (bimodal; briefcase's measurement, rank.ts) that is the
 *     "genuinely entailed" mode, not the ambiguous middle.
 *   - a tag applies when two distinct sentences are strong, or when one is and
 *     the best score anywhere (windows included) is near-certain (≥ 0.95).
 *
 * THE THRESHOLDS ARE PROVISIONAL AND SAY SO. Nothing has been calibrated
 * against a real vocabulary over real documents; that measurement is exactly
 * the test this engine was built to run, and these constants are where its
 * findings land.
 */
import type { FlagCandidate } from '../analyze/rank.js';

/** A sentence at or above this entails the tag rather than brushing past it. */
export const NLI_STRONG = 0.9;
/** Near-certainty: one sentence here plus one strong one is enough. */
export const NLI_CERTAIN = 0.95;
/** Diagnostic band only — printed so a calibration pass can see the middle. */
export const NLI_MID = 0.5;

/** One tag's evidence, summarized for the decision and for the stderr line. */
export interface NliTagStats {
  /** Her spelling, verbatim. */
  tag: string;
  /** Everything the ranker kept for this tag, windows included. */
  candidates: number;
  /** The best score anywhere, or 0 where nothing was kept. */
  max: number;
  /** Distinct sentences at ≥ NLI_STRONG. Windows never count here. */
  strongSentences: number;
  /** Distinct sentences at ≥ NLI_MID — diagnostic, not part of the rule. */
  midSentences: number;
  applies: boolean;
}

export interface NliDecision {
  /** Tags that hold, in the vocabulary's order, its spelling. */
  applies: string[];
  /** Per-tag evidence, in the vocabulary's order — every tag, matched or not. */
  stats: NliTagStats[];
}

/**
 * Judge every tag from the ranker's candidates alone.
 *
 * Rescued candidates are counted like any other: their scores sit far below
 * NLI_STRONG by construction (RESCUE_FLOOR is 0.15), so they can inform the
 * diagnostics without ever deciding anything.
 */
export function decideNliOnly(
  tags: readonly string[],
  candidates: readonly FlagCandidate[],
): NliDecision {
  const byTag = new Map<string, FlagCandidate[]>();
  for (const tag of tags) byTag.set(tag, []);
  for (const candidate of candidates) byTag.get(candidate.category)?.push(candidate);

  const stats = tags.map((tag) => {
    const mine = byTag.get(tag) ?? [];
    const strong = new Set<number>();
    const mid = new Set<number>();
    let max = 0;
    for (const candidate of mine) {
      if (candidate.score > max) max = candidate.score;
      if (candidate.source !== 'sentence') continue;
      if (candidate.score >= NLI_STRONG) strong.add(candidate.sentenceIndex);
      if (candidate.score >= NLI_MID) mid.add(candidate.sentenceIndex);
    }
    const applies = strong.size >= 2 || (strong.size >= 1 && max >= NLI_CERTAIN);
    return {
      tag,
      candidates: mine.length,
      max,
      strongSentences: strong.size,
      midSentences: mid.size,
      applies,
    };
  });

  return {
    applies: stats.filter((one) => one.applies).map((one) => one.tag),
    stats,
  };
}
