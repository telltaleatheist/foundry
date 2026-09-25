/**
 * analyze/rank — the sentences, and the paragraphs a verdict is asked about.
 *
 * ── WHAT IS LEFT HERE, AND WHY IT IS HERE ───────────────────────────────────
 *
 * The ranker itself — which sentences are hot, for which categories — is
 * snap.ts (the scorer) and spans.ts (what its answers add up to), ported from
 * briefcase on 2026-09-25 in place of the entailment ranker this file used to
 * hold. What stays is the half that never belonged to either ranker: the
 * book's sentences as one list, and `buildWindows`, which turns ranked spans
 * into the paragraph-sized passages a verdict is asked about. briefcase's snap
 * ranker kept its own copy of the same function unchanged for the same reason
 * (flag-windows.ts): judging moves up to a passage whatever did the ranking.
 *
 * ── SCORING AND JUDGING PART COMPANY ────────────────────────────────────────
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
 * its declaration below. spans.ts converts its own seconds through the same
 * rate. They are retunable the day the first reference books are audited
 * (docs/ANALYSIS.md §3), and nothing here has been measured against a book.
 */
import { wordCount } from './sentences.js';

/**
 * One sentence of the book, flattened across rows in reading order.
 *
 * The list the ranker works on is GLOBAL — every prose row's sentences, one
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
 * One (section, category) pair the ranker kept — one of spans.ts's sections,
 * with `sentenceIndex` the sentence holding the unit that scored it (used for
 * logging, never for the span).
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
export const WORDS_PER_SECOND = 3.25;

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
    });
  }
  return [...out.values()];
}

/**
 * Turn ranked (span, category) candidates into merged verification windows.
 *
 * Pure and exported so the shape can be exercised without a scorer.
 * Candidates must be in reading order (ascending spanFrom, then spanTo), which
 * is what `spansToWindows` (spans.ts) hands it.
 *
 * MULTI-CATEGORY BOOST. A window's ranking score is the noisy-OR of its
 * categories' best scores, `1 - PROD(1 - s)`. Two independent categories at 0.95
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
