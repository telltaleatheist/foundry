/**
 * analyze/rank — every sentence, every sliding window, then paragraphs.
 *
 * ── THE TWO PASSES AND WHY THERE ARE TWO ────────────────────────────────────
 *
 * The SENTENCE pass finds a sentence that entails a hypothesis on its own. It
 * cannot find DISTRIBUTED rhetoric — a passage where the premise is in one
 * sentence, the actor in the next and the conclusion in the third, and no
 * single sentence carries the whole proposition. briefcase measured the
 * symptom: a 60-minute recording about prayer ministries operating inside the
 * White House and God-ordained regime change produced ZERO
 * christian-nationalism candidates, because the argument is never in one
 * sentence.
 *
 * So the same hypotheses are scored again against every sliding
 * three-sentence window, stride 1, and the two sets are unioned. The NLI pass
 * is local and cheap (measured in briefcase: both passes over a 60-minute
 * transcript, ~90 s on MPS), so roughly doubling its work is affordable in a
 * way that doubling Ollama calls would not be — which is exactly why the union
 * is DEDUPED by span overlap before anything reaches the verifier.
 *
 * ── THEN SCORING AND JUDGING PART COMPANY ───────────────────────────────────
 *
 * Scoring stays at the sentence. JUDGING moves up to a paragraph-sized passage,
 * because a reader experiences one moment rather than four consecutive
 * sentences. briefcase's symptom, from a real run: an author spends four
 * sentences on one point, each clears the threshold separately, and the report
 * comes back with four back-to-back single-sentence flags for what a person
 * reads as ONE passage. Per-category merging after verification could not fix
 * it, because the four sentences were not all the same category — so merging
 * happens BEFORE verification and is CATEGORY-BLIND.
 *
 * ── THE AXIS CONVERSION: SECONDS BECAME WORDS ───────────────────────────────
 *
 * Every window constant briefcase tuned was measured in SECONDS, against
 * spoken sentences of three to six seconds. A book has no seconds. The
 * quantity those numbers were ever really about is HOW MUCH TEXT a passage
 * carries — the seconds were a proxy for words at speaking rate — so they port
 * as word counts through one declared rate, and each conversion is argued at
 * its declaration below. They are retunable the day the first reference books
 * are audited (docs/ANALYSIS.md §3), and nothing here has been measured
 * against a book.
 */
import { wordCount } from './sentences.js';
import type { RankPlan } from './plan.js';

/**
 * One sentence of the book, flattened across rows in reading order.
 *
 * The list the passes work on is GLOBAL — every prose row's sentences, one
 * after another — which is what lets a window straddle a paragraph break. That
 * is not a bug being tolerated; it is the distributed-rhetoric case again, and
 * a rhetorical move that finishes in the next paragraph is the same move.
 * `row` is what turns an index back into a place in the book, and it is the
 * only address the report ever writes.
 */
export interface BookSentence {
  /** `BookRow.id` — the block this sentence is in. Identity is `id`, only `id`. */
  row: string;
  /** `[start, end)` character offsets into THAT row's text. */
  start: number;
  end: number;
  text: string;
  /** Precomputed, because the window caps consult it O(n) times. */
  words: number;
}

/** Turn one row's sentences into the global list's entries. */
export function bookSentence(row: string, start: number, end: number, text: string): BookSentence {
  return { row, start, end, text, words: wordCount(text) };
}

/**
 * One (span, category) pair the ranker kept.
 *
 * A SENTENCE-level candidate spans one sentence (`spanFrom === spanTo`). A
 * WINDOW-level candidate spans the sliding window that scored, and
 * `sentenceIndex` is its middle — used for logging and never for the span.
 */
export interface FlagCandidate {
  sentenceIndex: number;
  /** Inclusive sentence-index range this candidate covers. */
  spanFrom: number;
  spanTo: number;
  text: string;
  category: string;
  score: number;
  /** The stance proposition the verifier will test this candidate against. */
  proposition: string;
  source: 'sentence' | 'window';
  /**
   * True when this pair never cleared the capture floor on its own and exists
   * only because the sentence fired several categories just under it — see
   * `RESCUE_MARGIN`.
   */
  rescued: boolean;
}

/** One category's evidence inside a verification window. */
export interface WindowCategory {
  category: string;
  proposition: string;
  /** The window's BEST score for this category... */
  score: number;
  /** ...and the sentence that scored it. */
  sentenceIndex: number;
  /** Every sentence in the window that fired this category, in reading order. */
  sentenceIndices: number[];
  /** True only when EVERY firing of this category in the window was a rescue. */
  rescued: boolean;
}

/**
 * A paragraph-sized passage the verifier judges as a whole. One question per
 * (window, category), so a passage where three categories fired costs three
 * questions rather than one per (sentence, category) pair.
 */
export interface FlagWindow {
  /** Inclusive sentence-index range of the passage the verifier is shown. */
  contextFrom: number;
  contextTo: number;
  /** Inclusive sentence-index range of the sentences that actually fired. */
  firedFrom: number;
  firedTo: number;
  /** Union of the fired categories, strongest first. */
  categories: WindowCategory[];
  /** Noisy-OR over the per-category best scores — the ranking score. */
  score: number;
}

/**
 * THE CAPTURE FLOOR, AND WHY IT IS A CONSTANT RATHER THAN A DIAL.
 *
 * briefcase ran a sensitivity ladder — 0.9 / 0.7 / 0.5 / 0.35 / 0.2 — because
 * every setting was a fresh run against a fresh video and the operator chose
 * how deep to read before paying for it. Foundry's report REMEMBERS, so Owen's
 * ruling (2026-08-25) is that the run captures once at the widest calibrated
 * net and the ladder becomes a DISPLAY filter over the stored scores:
 * *"it flags absolutely anything that could possibly match and then we have a
 * button that displays things that match strictly … a moderate filter, or a
 * very loose filter."* A knob whose good value is known is not a knob
 * (ARCHITECTURE.md §5), and the good value here is "everything, once".
 *
 * 0.2 IS THE BOTTOM OF THE USEFUL RANGE, not an arbitrary low number.
 * Measured in briefcase: deberta's scores on this material are strongly
 * bimodal, and below about 0.15 essentially nothing is a near-miss — it is the
 * model saying no. A floor under that stops ranking and starts forwarding the
 * book.
 *
 * WHAT IT COSTS, said plainly because it is the accepted price of never
 * re-running: every candidate is verified, and verifying down to 0.2 is more
 * Ollama calls than briefcase's default (0.7) ever paid. briefcase's measured
 * cost table on its two reference videos — candidates / verify calls / stored
 * sections — is the shape of the ramp:
 *
 *              12-min, 159 sentences        60-min, 801 sentences
 *   0.7          72 /  56 / 11                79 /  67 / 13   (4m34s)
 *   0.5          89 /  67 / 12               107 /  90 / 19   (6m12s)
 *   0.35         95 /  69 /  -               134 / 111 / 22   (7m33s)
 *   0.2         119 /  83 / 16               164 / 134 / 27   (9m13s)
 *
 * The ramp is SUBLINEAR in the threshold for the bimodality reason above, and
 * windowing then merges many of the new candidates into passages that were
 * going to be verified anyway: the widest net cost roughly twice the default on
 * the long video rather than ten times. The mitigations that make it payable
 * once are the question-keyed cache (a re-run pays only for what changed) and
 * descending-score verification (an interrupted run has already finished the
 * findings most worth trusting).
 */
export const CAPTURE_THRESHOLD = 0.2;

/**
 * RESCUE — corroboration standing in for certainty.
 *
 * A single category at 0.18 is below the floor and stays below it. But a
 * sentence scoring 0.18 on dehumanization AND 0.17 on hate is not the same
 * evidence as a sentence scoring 0.18 on one thing and nothing on anything
 * else: two independent hypotheses both nearly entailing the same sentence is
 * itself a signal.
 *
 * The rule applies ONLY to sentences where nothing cleared the floor. Adding
 * near-floor categories to already-hot sentences would add verification calls —
 * the opposite of what the rule is for — and would let a weak category attach
 * itself to strong evidence.
 *
 * ── THE CLAMP IS THE LOAD-BEARING PART ──────────────────────────────────────
 *
 * The floor is `threshold - margin`, and at the widest setting that arithmetic
 * is 0.2 - 0.25 = -0.05: a NEGATIVE floor, which every score in the matrix
 * clears. MEASURED IN BRIEFCASE on the first run of the widened dial, before
 * the clamp existed: every one of the 159 sentences of the short reference
 * video was "rescued" on all 10 categories at scores of 0.000-0.008, which is
 * not corroboration, it is forwarding the transcript — about 1,600 verifier
 * calls on the short video and roughly 8,000 (some seven hours on the 27b) on
 * the long one.
 *
 * So the floor never goes below `RESCUE_MIN_SCORE`. Two categories at 0.001 are
 * not two hypotheses nearly entailing a sentence; they are two hypotheses that
 * both said no. The arithmetic is left visible below rather than collapsed to
 * the constant it currently produces, because the clamp is the thing a future
 * reader must not delete.
 */
const RESCUE_MARGIN = 0.25;
const RESCUE_MIN_SCORE = 0.15;
const RESCUE_MIN_CATEGORIES = 2;

/** The score a near-miss must reach to corroborate. See `RESCUE_MARGIN`. */
export const RESCUE_FLOOR = Math.max(CAPTURE_THRESHOLD - RESCUE_MARGIN, RESCUE_MIN_SCORE);

/**
 * SPOKEN WORDS PER SECOND — the one number the whole axis conversion runs
 * through, and the only invented constant in this file.
 *
 * It is derived, not measured here: briefcase's 40-second merged-window cap was
 * justified in its own comment as "roughly 100-130 spoken words: a paragraph,
 * which is what a passage judgment can carry without diluting the weaker
 * claim". Taking the TOP of that measured range against the 40 seconds it
 * describes gives 3.25 words a second, and the top is the right end because
 * every constant below it is a CEILING — a cap set at the bottom of a measured
 * range would split passages the measurement said cohere.
 *
 * CROSS-CHECK, AND IT IS LOOSE: briefcase describes its sentences as three to
 * six seconds, which at this rate is ten to twenty words. Spoken sentences are
 * usually reckoned shorter than that. The disagreement does not matter for what
 * these constants do — they bound a PASSAGE, and the passage figure is the one
 * that was measured — but it is why nothing here claims better than
 * round-number precision, and why the caps below are rounded rather than
 * carried to two decimals.
 */
const WORDS_PER_SECOND = 3.25;

/**
 * How far a hot sentence expands, in sentences. briefcase's +/-2, UNCHANGED —
 * a sentence is a sentence in both media, and this is the same +/-2 the
 * measured verification runs already showed the model as context, now the thing
 * being judged.
 */
const WINDOW_CONTEXT_SENTENCES = 2;

/**
 * The hard stop on that expansion.
 *
 * briefcase: 25 seconds, whose job was to keep a window that lands next to one
 * 40-second monologue sentence from becoming a page. Converted at the declared
 * rate it is 81 words — comfortably more than five ordinary sentences and
 * comfortably less than a page, which is exactly the band the original was cut
 * for. The arithmetic is left in the code rather than replaced by its answer,
 * so the conversion cannot drift away from the sentence that argues it.
 */
const WINDOW_MAX_CONTEXT_WORDS = Math.round(25 * WORDS_PER_SECOND);

/**
 * Two windows join when at most this many sentences separate them. briefcase's
 * 1, UNCHANGED, and the merge is deliberately CATEGORY-BLIND: the
 * four-back-to-back run briefcase's operator reported was three different
 * categories, and merging per category would have left it split.
 */
const WINDOW_MERGE_GAP_SENTENCES = 1;

/**
 * ...or when at most this much text separates them.
 *
 * briefcase: 5 seconds, the "these are the same moment even though two
 * sentences sit between them" clause. At the declared rate that is 16 words —
 * about one short sentence, which is what the original bought. On the book side
 * the quantity is the words of the sentences strictly BETWEEN the two windows,
 * which is the same thing the seconds measured: how much material a reader
 * crosses to get from one to the other.
 */
const WINDOW_MERGE_GAP_WORDS = Math.round(5 * WORDS_PER_SECOND);

/**
 * Where chaining stops. THE ANCHOR OF THE WHOLE CONVERSION — see
 * `WORDS_PER_SECOND`.
 *
 * briefcase: 40 seconds, and the number was measured rather than chosen. At
 * 60 s the verifier answered "skip" for the SECOND category of two long merged
 * passages on the reference video and cost two hand-audited category labels
 * (the moments were still flagged, under the other category); at 40 s both came
 * back and the four-back-to-back run still coalesced. Its own comment glosses
 * 40 s as "roughly 100-130 spoken words: a paragraph", so the book constant is
 * that paragraph: 130 words, which is what the declared rate was chosen to make
 * this line produce.
 *
 * Without a cap, a dense chapter merges into one section that is useless to
 * travel to and a prompt that no longer fits the pinned num_ctx.
 */
const WINDOW_MAX_MERGED_WORDS = Math.round(40 * WORDS_PER_SECOND);

/** The sliding window's size. briefcase's 3, stride 1. */
export const SLIDING_WINDOW_SENTENCES = 3;

/**
 * Flatten a plan into the hypothesis list the worker scores, remembering which
 * plan entry owns each column. A category with three hypotheses occupies three
 * columns and collapses back to one score by MAX — the strongest way the
 * category was argued wins, which is the right reduction for propositions that
 * are alternatives rather than parts of one claim.
 */
export function flattenHypotheses(plan: readonly RankPlan[]): { texts: string[]; owner: number[] } {
  const texts: string[] = [];
  const owner: number[] = [];
  for (let p = 0; p < plan.length; p += 1) {
    for (const hypothesis of plan[p]!.hypotheses) {
      texts.push(hypothesis);
      owner.push(p);
    }
  }
  return { texts, owner };
}

/** Collapse one row of raw hypothesis scores to one score per plan entry. */
export function collapseRow(row: readonly number[], owner: readonly number[], planCount: number): number[] {
  const out = new Array<number>(planCount).fill(0);
  for (let column = 0; column < owner.length; column += 1) {
    const score = row[column] ?? 0;
    const at = owner[column]!;
    if (score > out[at]!) out[at] = score;
  }
  return out;
}

/**
 * What a pass asks for: the collapsed per-category score of each text.
 *
 * INJECTED rather than called, so the cache lives above this file. `run.ts`
 * supplies a function that answers out of the report's stored rank rows where
 * it can and pays the worker only for what it cannot — which is what makes a
 * re-run against an edited book re-pay only the edited blocks.
 */
export type ScoreTexts = (texts: readonly string[]) => Promise<number[][]>;

/** Prefix sums of word counts, so a span's length is O(1) rather than O(n). */
function wordPrefix(sentences: readonly BookSentence[]): number[] {
  const prefix = new Array<number>(sentences.length + 1).fill(0);
  for (let i = 0; i < sentences.length; i += 1) prefix[i + 1] = prefix[i]! + sentences[i]!.words;
  return prefix;
}

/** Words in sentences `from..to` inclusive. `to < from` is zero, not negative. */
function words(prefix: readonly number[], from: number, to: number): number {
  if (to < from) return 0;
  return prefix[to + 1]! - prefix[from]!;
}

/**
 * The sentence pass: every (sentence, category) pair at or above the capture
 * floor, plus the rescues.
 *
 * ALL categories above the floor become candidates, deliberately, and not the
 * argmax. MEASURED IN BRIEFCASE: the argmax version LOST real flags to category
 * mislabelling — a dehumanization line whose top score was 'misinformation' was
 * verified, flagged, and then scored as a miss because it carried the wrong
 * category. Keeping every category above the floor is what makes 10/10 and
 * 11/11 reachable at all.
 */
async function scoreSentenceLevel(
  sentences: readonly BookSentence[],
  plan: readonly RankPlan[],
  score: ScoreTexts,
  log: (line: string) => void,
): Promise<FlagCandidate[]> {
  const scores = await score(sentences.map((s) => s.text));

  const candidates: FlagCandidate[] = [];
  let rescuedSentences = 0;
  const make = (i: number, c: number, value: number, rescued: boolean): FlagCandidate => ({
    sentenceIndex: i,
    spanFrom: i,
    spanTo: i,
    text: sentences[i]!.text,
    category: plan[c]!.category,
    score: value,
    proposition: plan[c]!.proposition,
    source: 'sentence',
    rescued,
  });

  for (let i = 0; i < sentences.length && i < scores.length; i += 1) {
    const row = scores[i]!;
    const hits: FlagCandidate[] = [];
    for (let c = 0; c < plan.length; c += 1) {
      const value = row[c] ?? 0;
      if (value >= CAPTURE_THRESHOLD) hits.push(make(i, c, value, false));
    }

    if (hits.length === 0) {
      const near: FlagCandidate[] = [];
      for (let c = 0; c < plan.length; c += 1) {
        const value = row[c] ?? 0;
        if (value >= RESCUE_FLOOR) near.push(make(i, c, value, true));
      }
      if (near.length >= RESCUE_MIN_CATEGORIES) {
        near.sort((a, b) => b.score - a.score);
        hits.push(...near);
        rescuedSentences += 1;
      }
    }

    hits.sort((a, b) => b.score - a.score);
    candidates.push(...hits);
  }

  log(
    `analyze: sentence pass — ${sentences.length} sentence(s) x ${plan.length} categor(ies) at `
    + `${CAPTURE_THRESHOLD} gave ${candidates.length} candidate(s); ${rescuedSentences} sentence(s) `
    + `were rescued on ${RESCUE_MIN_CATEGORIES}+ corroborating categories at or above ${RESCUE_FLOOR}`,
  );
  return candidates;
}

/**
 * The sliding-window pass: what no single sentence carried.
 *
 * DEDUPE, in this order, both by span overlap:
 *   1. against the sentence pass — if that category already fired on a sentence
 *      inside this window, the window is the same finding restated and only
 *      costs a verifier call;
 *   2. against stronger windows of the same category — stride-1 windows overlap
 *      by construction, so a run of them is one finding and the highest-scoring
 *      window represents it.
 *
 * NO RESCUE HERE. Corroboration is a claim about one sentence firing several
 * hypotheses at once; a three-sentence window that half-entails two categories
 * is a much weaker version of the same argument, and briefcase never measured
 * it. The rule is left where it was measured.
 */
async function scoreWindowLevel(
  sentences: readonly BookSentence[],
  plan: readonly RankPlan[],
  sentenceLevel: readonly FlagCandidate[],
  score: ScoreTexts,
  log: (line: string) => void,
): Promise<FlagCandidate[]> {
  const size = SLIDING_WINDOW_SENTENCES;
  if (sentences.length < size) return [];

  const texts: string[] = [];
  for (let i = 0; i + size <= sentences.length; i += 1) {
    texts.push(sentences.slice(i, i + size).map((s) => s.text).join(' '));
  }
  const scores = await score(texts);

  const raw: FlagCandidate[] = [];
  for (let w = 0; w < texts.length && w < scores.length; w += 1) {
    const row = scores[w]!;
    for (let c = 0; c < plan.length; c += 1) {
      const value = row[c] ?? 0;
      if (value < CAPTURE_THRESHOLD) continue;
      raw.push({
        // Representative sentence = the middle of the window; used for logs,
        // never for the span, which is the whole window.
        sentenceIndex: w + Math.floor(size / 2),
        spanFrom: w,
        spanTo: w + size - 1,
        text: texts[w]!,
        category: plan[c]!.category,
        score: value,
        proposition: plan[c]!.proposition,
        source: 'window',
        rescued: false,
      });
    }
  }

  const alreadyHot = new Map<string, number[]>();
  for (const candidate of sentenceLevel) {
    const list = alreadyHot.get(candidate.category);
    if (list) list.push(candidate.sentenceIndex);
    else alreadyHot.set(candidate.category, [candidate.sentenceIndex]);
  }

  const keptSpans = new Map<string, Array<[number, number]>>();
  const kept: FlagCandidate[] = [];
  for (const candidate of [...raw].sort((a, b) => b.score - a.score)) {
    const hotHere = alreadyHot.get(candidate.category) ?? [];
    if (hotHere.some((i) => i >= candidate.spanFrom && i <= candidate.spanTo)) continue;

    const spans = keptSpans.get(candidate.category) ?? [];
    if (spans.some(([from, to]) => from <= candidate.spanTo && to >= candidate.spanFrom)) continue;
    spans.push([candidate.spanFrom, candidate.spanTo]);
    keptSpans.set(candidate.category, spans);
    kept.push(candidate);
  }

  kept.sort((a, b) => a.spanFrom - b.spanFrom);
  log(
    `analyze: window pass — ${texts.length} sliding ${size}-sentence window(s) gave ${raw.length} `
    + `raw hit(s) and ${kept.length} new candidate(s); ${raw.length - kept.length} were the sentence `
    + 'pass or a stronger overlapping window saying the same thing',
  );
  return kept;
}

/** The per-category evidence one hot span contributes to a window. */
function categoriesFromSpan(candidates: readonly FlagCandidate[]): WindowCategory[] {
  return candidates.map((candidate) => ({
    category: candidate.category,
    proposition: candidate.proposition,
    score: candidate.score,
    sentenceIndex: candidate.sentenceIndex,
    sentenceIndices: Array.from(
      { length: candidate.spanTo - candidate.spanFrom + 1 },
      (_unused, offset) => candidate.spanFrom + offset,
    ),
    rescued: candidate.rescued,
  }));
}

/**
 * Union two windows' category evidence. A category present in both keeps its
 * BEST-scoring sentence (that is the quotation the verdict is really about) and
 * the union of every sentence that fired it (that is what the finding's span is
 * measured from).
 */
function mergeWindowCategories(a: readonly WindowCategory[], b: readonly WindowCategory[]): WindowCategory[] {
  const out = new Map<string, WindowCategory>();
  for (const entry of [...a, ...b]) {
    const existing = out.get(entry.category);
    if (!existing) {
      out.set(entry.category, { ...entry, sentenceIndices: [...entry.sentenceIndices] });
      continue;
    }
    const best = entry.score > existing.score ? entry : existing;
    const indices = new Set([...existing.sentenceIndices, ...entry.sentenceIndices]);
    out.set(entry.category, {
      ...best,
      sentenceIndices: [...indices].sort((x, y) => x - y),
      // One floor-clearing firing anywhere in the window means the category is
      // not resting on the rescue rule.
      rescued: existing.rescued && entry.rescued,
    });
  }
  return [...out.values()];
}

/**
 * Turn ranked (span, category) candidates into merged verification windows.
 *
 * Pure and exported so the shape can be exercised without a Python worker.
 * Candidates must be in reading order (ascending spanFrom, then spanTo), which
 * is what `rankWindows` hands it.
 *
 * MULTI-CATEGORY BOOST. A window's ranking score is the noisy-OR of its
 * categories' best scores, `1 - PROD(1 - s)`. Two independent hypotheses at 0.95
 * and 0.93 give 0.9965, which outranks any single 0.99 — which is the point: a
 * passage that is demonizing AND hateful is worse than a passage that is very
 * confidently one thing, and it should be verified and read first. The score
 * ORDERS verification; it gates nothing, and every window and every category in
 * it is still verified.
 */
export function buildWindows(
  sentences: readonly BookSentence[],
  candidates: readonly FlagCandidate[],
): FlagWindow[] {
  if (candidates.length === 0 || sentences.length === 0) return [];
  const prefix = wordPrefix(sentences);

  const bySpan = new Map<string, FlagCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.spanFrom}:${candidate.spanTo}`;
    const list = bySpan.get(key);
    if (list) list.push(candidate);
    else bySpan.set(key, [candidate]);
  }
  const hot = [...bySpan.values()].sort(
    (a, b) => a[0]!.spanFrom - b[0]!.spanFrom || a[0]!.spanTo - b[0]!.spanTo,
  );

  // 1. Expand every hot span into a passage, alternating sides so a window at
  //    the word cap is still balanced around the span that fired.
  const expanded: FlagWindow[] = hot.map((group) => {
    let from = group[0]!.spanFrom;
    let to = group[0]!.spanTo;
    for (let step = 0; step < WINDOW_CONTEXT_SENTENCES; step += 1) {
      if (from > 0 && words(prefix, from - 1, to) <= WINDOW_MAX_CONTEXT_WORDS) from -= 1;
      if (to + 1 < sentences.length && words(prefix, from, to + 1) <= WINDOW_MAX_CONTEXT_WORDS) to += 1;
    }
    return {
      contextFrom: from,
      contextTo: to,
      firedFrom: group[0]!.spanFrom,
      firedTo: group[0]!.spanTo,
      categories: categoriesFromSpan(group),
      score: 0,
    };
  });

  // 2. Merge overlapping / near-adjacent passages, category-blind.
  const merged: FlagWindow[] = [];
  for (const window of expanded) {
    const previous = merged[merged.length - 1];
    if (previous) {
      // Overlapping and nested windows give a negative sentence gap and a zero
      // word gap, which both tests accept — that is the intent, they are the
      // same passage.
      const sentenceGap = window.contextFrom - previous.contextTo - 1;
      const wordGap = words(prefix, previous.contextTo + 1, window.contextFrom - 1);
      const joinedFrom = Math.min(previous.contextFrom, window.contextFrom);
      const joinedTo = Math.max(previous.contextTo, window.contextTo);
      const joinedWords = words(prefix, joinedFrom, joinedTo);
      const close = sentenceGap <= WINDOW_MERGE_GAP_SENTENCES || wordGap <= WINDOW_MERGE_GAP_WORDS;
      if (close && joinedWords <= WINDOW_MAX_MERGED_WORDS) {
        previous.contextFrom = joinedFrom;
        previous.contextTo = joinedTo;
        previous.firedFrom = Math.min(previous.firedFrom, window.firedFrom);
        previous.firedTo = Math.max(previous.firedTo, window.firedTo);
        previous.categories = mergeWindowCategories(previous.categories, window.categories);
        continue;
      }
    }
    merged.push({ ...window, categories: [...window.categories] });
  }

  // 3. Score and order the evidence inside each window.
  for (const window of merged) {
    window.categories.sort((x, y) => y.score - x.score);
    window.score = 1 - window.categories.reduce((product, c) => product * (1 - c.score), 1);
  }
  return merged;
}

/**
 * How strong a window is, for ordering — and it is NOT `window.score`.
 *
 * MEASURED IN BRIEFCASE on the reference videos: most windows carry several
 * 0.9+ categories, and the noisy-OR saturates at 1.0000 in float64, which would
 * make the order of the strongest findings arbitrary — exactly the ones that
 * must be verified first. The sum of `log(1 - s)` is the same ranking with the
 * resolution intact. More negative is stronger.
 */
export function windowStrength(window: FlagWindow): number {
  return window.categories.reduce(
    (sum, c) => sum + Math.log(Math.max(1 - c.score, Number.MIN_VALUE)),
    0,
  );
}

/**
 * The stage-1 entry point: rank sentences AND sliding windows, union the two,
 * then group the survivors into merged verification windows, STRONGEST FIRST.
 *
 * The order is the verification order (docs/ANALYSIS.md §5): a run interrupted
 * an hour in has already finished the findings most worth trusting, and the
 * append-as-landed report makes them readable before the loose tail is done.
 */
export async function rankWindows(
  sentences: readonly BookSentence[],
  plan: readonly RankPlan[],
  score: ScoreTexts,
  log: (line: string) => void,
): Promise<FlagWindow[]> {
  if (plan.length === 0 || sentences.length === 0) return [];

  const sentenceLevel = await scoreSentenceLevel(sentences, plan, score, log);
  const windowLevel = await scoreWindowLevel(sentences, plan, sentenceLevel, score, log);
  const candidates = [...sentenceLevel, ...windowLevel].sort(
    (a, b) => a.spanFrom - b.spanFrom || a.spanTo - b.spanTo,
  );

  const windows = buildWindows(sentences, candidates);
  windows.sort((a, b) => windowStrength(a) - windowStrength(b) || a.contextFrom - b.contextFrom);

  const calls = windows.reduce((total, window) => total + window.categories.length, 0);
  log(
    `analyze: ${candidates.length} candidate(s) (${sentenceLevel.length} sentence + `
    + `${windowLevel.length} window) became ${windows.length} passage(s) and ${calls} verify call(s) `
    + `— one call per candidate would have been ${candidates.length}`,
  );
  return windows;
}
