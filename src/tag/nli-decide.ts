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
 *   - a tag applies when the best score ANYWHERE — sentence or window —
 *     reaches near-certainty (≥ NLI_CERTAIN).
 *
 * ── WHY MAX-ONLY, WHEN THE FIRST CUT DEMANDED CORROBORATION ─────────────────
 *
 * The first cut required two strong sentences, on the intuition that one
 * sentence should not impersonate a theme. The 2026-08-30 calibration against
 * 249 real labelled documents measured the opposite: ranking tags by peak
 * score put 49% of the owner's own labels in the top 5 of 117 candidates,
 * and every corroboration-count ranking did WORSE (strong-count first dropped
 * that to 35%). Breadth of firing rewards promiscuous broad tags; one peak
 * sentence is the better aboutness signal on this model. The corroboration
 * requirement was deleted for that reason — a rule the data contradicts is
 * not a safeguard, it is a miss generator. NLI_STRONG survives for the
 * diagnostics only.
 */
import type { FlagCandidate } from '../analyze/rank.js';

/** Diagnostic band: a sentence here entails rather than brushes past. */
export const NLI_STRONG = 0.9;
/** The decision: a tag applies when any passage reaches near-certainty. */
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
    const applies = max >= NLI_CERTAIN;
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
