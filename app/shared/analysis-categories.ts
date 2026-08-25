/**
 * THE CATEGORIES A BOOK CAN BE READ AGAINST — the checklist, in one place.
 *
 * ── Where these come from, and why the app keeps a copy at all ──────────────
 *
 * The ORIGIN is `src/analyze/plan.ts` — `HYPOTHESES` and `UNTUNED_BOOK_CATEGORIES`,
 * in the order `builtInCategories()` returns them, which is the order a default
 * run plans them and therefore the order the report's header lists them in. That
 * file is the engine's, compiled into the `foundry` binary; `app/shared` is
 * compiled by the electron program and by the renderer, and neither can reach
 * into it. So this is a MIRROR, on exactly the terms `shared/languages.ts` is a
 * mirror of the engine's language table: the two grow together, and the day one
 * of them gains an entry the other is a line behind.
 *
 * WHAT THE MIRROR IS ALLOWED TO CARRY IS THE NAME AND NOTHING ELSE. The
 * hypotheses, the propositions, the capture floors and the whole measured axis
 * stay on the engine's side, where they were calibrated and where they are
 * argued. A checklist needs an id to send and a phrase to draw beside a checkbox;
 * copying a stance hypothesis into a renderer would put a prompt in a window and
 * invite the next person to edit it there.
 *
 * A NAME THIS BUILD DOES NOT KNOW IS STILL LEGIBLE. The panel groups findings by
 * the category the report names, and a report made by a newer engine can carry
 * one this list has never heard of — so `analysisCategoryName` falls back to the
 * id said aloud rather than refusing to draw the row. That is not a fallback in
 * the forbidden sense: nothing is guessed and nothing is substituted, the id is
 * simply printed as itself.
 *
 * ── `misinformation` IS NOT HERE, AND ITS ABSENCE IS MEASURED ───────────────
 *
 * The engine refuses to rank it and says why (`MISINFORMATION_EXCLUSION`,
 * src/analyze/plan.ts): every stance hypothesis for it degenerates to "the author
 * makes a factual assertion", and whether an assertion is FALSE is world
 * knowledge an entailment model does not have. briefcase measured the cost —
 * 169 of 205 candidates and 19 of 20 verified false positives were that one
 * category. So it is not on the checklist, because a checkbox whose only possible
 * outcome is a line in the log saying the category was skipped is a checkbox that
 * teaches somebody the feature is broken.
 */

/** One category, as the checklist draws it and as the report names it. */
export interface AnalysisCategory {
  /** The engine's own id — what travels on the wire and what a report row says. */
  id: string;
  /** What the checkbox says. The reader's words, not the hypothesis's. */
  name: string;
  /**
   * True where the hypotheses behind it were calibrated against reference
   * material, false for the ones that are first drafts.
   *
   * IT IS DRAWN, and quietly. docs/ANALYSIS.md §5 rules that an untuned category
   * may produce too many candidates or too few and that the report says which
   * ones they are; the dialog says it before the run rather than only afterwards,
   * because the person deciding whether to spend an hour is the person who wants
   * to know which half of the checklist has been measured.
   */
  tuned: boolean;
}

/**
 * Every category the engine plans by default, in plan order.
 *
 * ── The two at the end are Owen's book categories ───────────────────────────
 *
 * *"jehovahs witness anti evolution material, christian nationalist books,
 * project 2025, etc."* Christian nationalism was already tuned in briefcase and
 * sits with the other nine. The other two have no calibrated hypothesis anywhere
 * and enter description-backed and saying so, which is why they carry
 * `tuned: false` and why the report names them in its `untuned` list. Tuning them
 * against reference books is follow-up work indexed in docs/PLAN.md.
 */
export const ANALYSIS_CATEGORIES: readonly AnalysisCategory[] = [
  { id: 'political-demonization', name: 'Political demonization', tuned: true },
  { id: 'hate', name: 'Hate', tuned: true },
  { id: 'conspiracy', name: 'Conspiracy', tuned: true },
  { id: 'dehumanization', name: 'Dehumanization', tuned: true },
  { id: 'violence', name: 'Violence', tuned: true },
  { id: 'false-prophecy', name: 'False prophecy', tuned: true },
  { id: 'christian-nationalism', name: 'Christian nationalism', tuned: true },
  { id: 'prosperity-gospel', name: 'Prosperity gospel', tuned: true },
  { id: 'extremism', name: 'Extremism', tuned: true },
  { id: 'political-violence', name: 'Political violence', tuned: true },
  { id: 'anti-evolution', name: 'Anti-evolution and science denial', tuned: false },
  { id: 'authoritarian-blueprint', name: 'Authoritarian blueprint', tuned: false },
];

/** Every id, for the checks that only need the set. */
export const ANALYSIS_CATEGORY_IDS: readonly string[] = ANALYSIS_CATEGORIES.map((one) => one.id);

/**
 * What to call a category on screen — the mirror's phrase, or the id said aloud.
 *
 * Hyphens become spaces and the first letter is capitalised, which is what makes
 * an unknown id from a newer engine read as words rather than as a token. Nothing
 * is guessed: `authoritarian-blueprint` would come back as "Authoritarian
 * blueprint" whether or not it were in the table, and the table exists for the
 * ones whose good phrase is not their id ("Anti-evolution and science denial").
 */
export function analysisCategoryName(id: string): string {
  const known = ANALYSIS_CATEGORIES.find((one) => one.id === id);
  if (known !== undefined) return known.name;
  const said = id.replace(/-/g, ' ').trim();
  return said.length === 0 ? id : said.charAt(0).toUpperCase() + said.slice(1);
}
