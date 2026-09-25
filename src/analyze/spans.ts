/**
 * analyze/spans — from the scorer's rating map to ranked verification windows.
 * Pure: no scorer, no I/O, so a saved rank file can be re-run with different
 * parameters without a card.
 *
 *   rating map  (group vectors, averaged per unit)        -> each category's
 *               rise above ITS OWN level in this book     -> evidence, hotness per unit
 *   hotness     -> 2-state Viterbi                        -> on/off runs
 *   runs        -> category-blind merge                   -> paragraph spans
 *   spans       -> per-category span scores s_c           -> co-fire strength
 *   spans       -> sections cut at their quietest points  -> FlagCandidate
 *   candidates  -> buildWindows (rank.ts, unchanged)      -> windows, strongest first
 *
 * ── PORTED, NOT INVENTED ────────────────────────────────────────────────────
 *
 * This is briefcase's `backend/src/scorer/flags/flag-spans.ts` and
 * `scorer-viterbi.ts` (main d80cc71), line for line, with two changes and no
 * others:
 *
 *   1. SECONDS BECAME WORDS, through rank.ts's one declared rate
 *      (`WORDS_PER_SECOND`, 3.25 — the rate every window constant in this port
 *      already runs through). briefcase's units carry whisper segment times; a
 *      book has none, so a unit carries its position in WORDS from the start of
 *      the prose instead, and every seconds parameter is that number of seconds
 *      at the declared rate. The arithmetic is left visible at each constant.
 *   2. THE VERIFY BUDGET IS GONE. briefcase walked windows in strength order
 *      against max(20, 60 × hours) calls and stored the rest unverified; Foundry
 *      verifies every window (Owen, 2026-09-25: confirmed findings only, every
 *      candidate asked), so there is no overflow to keep.
 *
 * The parameters are briefcase's plan arithmetic, not measurements — its own
 * comment says they are to be tuned offline from saved rating maps — and
 * nothing here has been measured against a book either.
 */
import {
  buildWindows,
  windowStrength,
  WORDS_PER_SECOND,
  type BookSentence,
  type FlagCandidate,
  type FlagWindow,
} from './rank.js';
import type { RankPlan } from './plan.js';

// --------------------------------------------------------------------------- viterbi

/**
 * Best state per unit — briefcase's `viterbi()`, itself ContentStudio's
 * segment.py port. Any state may follow any other at a flat cost per switch.
 *
 * @param logProbs  logProbs[i][j] = log P(state j | unit i); every row the same length
 * @param switchCost flat penalty (nats) paid each time the state changes
 */
export function viterbi(logProbs: readonly (readonly number[])[], switchCost: number): number[] {
  const n = logProbs.length;
  if (n === 0) return [];
  const m = logProbs[0]!.length;
  if (m === 0) throw new Error('viterbi: rows must have at least one state');

  let dp = logProbs[0]!.slice();
  const back: Int32Array[] = [];
  for (let i = 1; i < n; i += 1) {
    const row = logProbs[i]!;
    if (row.length !== m) throw new Error(`viterbi: row ${i} has ${row.length} states, expected ${m}`);
    const bestJ = argmax(dp);
    const bestV = dp[bestJ]! - switchCost;
    const next = new Array<number>(m);
    const from = new Int32Array(m);
    for (let j = 0; j < m; j += 1) {
      if (dp[j]! >= bestV) {
        next[j] = dp[j]! + row[j]!;
        from[j] = j;
      } else {
        next[j] = bestV + row[j]!;
        from[j] = bestJ;
      }
    }
    dp = next;
    back.push(from);
  }

  const path = new Array<number>(n);
  let j = argmax(dp);
  path[n - 1] = j;
  for (let i = n - 2; i >= 0; i -= 1) {
    j = back[i]![j]!;
    path[i] = j;
  }
  return path;
}

/** Maximal runs of `state` in `path`, as [start, endExclusive] unit indices. */
export function runsOf(path: readonly number[], state: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === state) {
      let k = i;
      while (k < path.length && path[k] === state) k += 1;
      out.push([i, k]);
      i = k;
    } else {
      i += 1;
    }
  }
  return out;
}

function argmax(xs: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < xs.length; i += 1) if (xs[i]! > xs[best]!) best = i;
  return best;
}

// --------------------------------------------------------------------------- units

/**
 * What the scorer asks about — briefcase's `SnapUnit`, with WORD positions
 * where it had segment times.
 *
 * `start`/`end` count words from the start of the prose: a unit covering
 * sentences a..b starts where sentence a starts and ends where sentence b ends,
 * so both are sentence positions and nothing is interpolated — briefcase's own
 * rule for its times. A run-on cut into pieces gives every piece the positions
 * of the sentence(s) it lies in, exactly as briefcase's `splitByWords` does.
 */
export interface BookUnit {
  index: number;
  text: string;
  /** Inclusive range of the analysis sentences this unit overlaps. */
  sentenceFrom: number;
  sentenceTo: number;
  /** Words before the unit's first sentence, and through its last. */
  start: number;
  end: number;
}

// --------------------------------------------------------------------------- params

export interface SpanParams {
  /**
   * λ: cost (nats) of each none <-> flag switch. cat <-> cat is free because
   * every category state shares one pooled emission, so the chain decides
   * on/off only and is run as the equivalent 2-state Viterbi.
   */
  switchCost: number;
  /** τ: subtracted from the pooled flag emission, log(hot) - τ. Negative makes spans easier to open. */
  tau: number;
  /**
   * Where a category's baseline sits in this book's own distribution of it
   * (0.5 = the median). Evidence is the rise above the baseline, so a category
   * the model leans toward all book long reads as zero, and only its peaks read
   * as hot.
   */
  baselineQuantile: number;
  /** ...never above this: a category given better than even odds all book long IS there. */
  baselineMax: number;
  /** Category-blind post-merge: spans separated by <= this many units... */
  mergeGapUnits: number;
  /** ...or <= this many words join. */
  mergeGapWords: number;
  /**
   * A span keeps the categories whose evidence reaches this share of its top
   * category's, and always its top one. A third: a group holding two things
   * splits its mass between them (one softmax), so the second is often well
   * under the first.
   */
  categoryFloor: number;
  /** A span longer than this is cut into sections at its quietest points... */
  maxSectionWords: number;
  /** ...never into a piece shorter than this. */
  minSectionWords: number;
}

/**
 * briefcase's `DEFAULT_SPAN_PARAMS`. An isolated hot unit between cold ones pays
 * the switch cost TWICE (on, then off), so it opens a span only when
 * logit(hot) - τ > 2λ. On hotness = the rise above the book's own baseline:
 *   - an isolated unit opens a span at hot > 0.5:     logit(h) > 2λ + τ = 0
 *   - a span edge extends to a neighbour at h > 0.27: logit(h) > τ = -1
 *   - one cold unit breaks a run only at h < 0.12:    logit(h) < τ - 2λ = -2
 *
 * The three that were seconds: briefcase's 5 s merge gap, 90 s section cap and
 * 20 s section floor, each converted at the declared rate. briefcase's user,
 * on the cap: *"id rather have 10 1-minute sections than one 30-minute
 * section"* — sections of about a minute of speech are sections of a long
 * paragraph or two of print.
 */
export const DEFAULT_SPAN_PARAMS: SpanParams = {
  switchCost: 0.5,
  tau: -1,
  baselineQuantile: 0.5,
  baselineMax: 0.5,
  mergeGapUnits: 1,
  mergeGapWords: Math.round(5 * WORDS_PER_SECOND),
  categoryFloor: 0.34,
  maxSectionWords: Math.round(90 * WORDS_PER_SECOND),
  minSectionWords: Math.round(20 * WORDS_PER_SECOND),
};

/**
 * The parameters as one short string, for the report header: a report is the
 * answer to "these rating maps, read with THESE numbers", and a retune has to
 * be legible in the file it produced.
 */
export function spanParamsVersion(params: SpanParams = DEFAULT_SPAN_PARAMS): string {
  return [
    `λ${params.switchCost}`, `τ${params.tau}`, `q${params.baselineQuantile}`, `b${params.baselineMax}`,
    `gap${params.mergeGapUnits}u/${params.mergeGapWords}w`, `floor${params.categoryFloor}`,
    `sec${params.minSectionWords}-${params.maxSectionWords}w`,
  ].join(' ');
}

// --------------------------------------------------------------------------- rating map

/**
 * Everything the scorer said, kept whole (never argmaxed), so spans can be
 * re-derived with different params. JSON-serialisable; it is the body of the
 * rank file (snap.ts).
 */
export interface RatingMap {
  /** Category keys in plan order. `p1` columns are these, then 'none' LAST. */
  categories: string[];
  units: BookUnit[];
  /** Per unit: the mean of the vectors of the groups that contain it, [...categories, none]. */
  p1: number[][];
}

/** The value at quantile q of `values` (linear between order statistics). */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(Math.max(q, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const evidenceCache = new WeakMap<number[][], { key: string; e: number[][] }>();

/**
 * e_i(c): how far unit i's P(c) rises above category c's baseline in this book
 * (its `baselineQuantile`, capped at `baselineMax`), as a share of the headroom
 * left above it: max(0, P_i(c) - b_c) / (1 - b_c). 0 = at or below the book's
 * usual level for c; 1 = certain. Cached per map.
 */
export function evidence(
  map: Pick<RatingMap, 'categories' | 'p1'>,
  params: Pick<SpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): number[][] {
  const key = `${params.baselineQuantile}/${params.baselineMax}`;
  const cached = evidenceCache.get(map.p1);
  if (cached && cached.key === key) return cached.e;
  const k = map.categories.length;
  const baseline = Array.from({ length: k }, (_unused, j) =>
    Math.min(params.baselineMax, quantile(map.p1.map((row) => row[j]!), params.baselineQuantile)));
  const e = map.p1.map((row) =>
    baseline.map((b, j) => clamp01(Math.max(0, row[j]! - b) / Math.max(1 - b, 1e-6))));
  evidenceCache.set(map.p1, { key, e });
  return e;
}

/** hot_i: the unit's strongest category evidence. "none" is not read here. */
export function hotness(
  map: Pick<RatingMap, 'categories' | 'p1'>,
  params: Pick<SpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): number[] {
  return evidence(map, params).map((row) => row.reduce((m, x) => Math.max(m, x), 0));
}

// --------------------------------------------------------------------------- spans

export interface SpanCategory {
  category: string;
  /** s_c: the best unit evidence inside the span. */
  score: number;
  /** The unit that scored it. */
  unit: number;
}

export interface FlagSpan {
  id: number;
  /** Inclusive unit range. */
  unitFrom: number;
  unitTo: number;
  /** Inclusive sentence range (what windows and findings index). */
  sentenceFrom: number;
  sentenceTo: number;
  /** Word positions — see `BookUnit`. */
  start: number;
  end: number;
  /** Kept categories, strongest first. */
  categories: SpanCategory[];
  /** Σ_c log(1 - s_c) over kept categories. More negative = stronger. */
  strength: number;
  /** Σ hot_i over the span: first tie-break. */
  heat: number;
}

const LOG_FLOOR = 1e-12;

/**
 * The on/off path: 2-state Viterbi over [log P(none), log(hot) - τ], switch
 * cost λ. Equivalent to a (k+1)-state chain with free cat<->cat moves, because
 * every category state carries the same pooled emission.
 */
export function onOffPath(hot: readonly number[], params: Pick<SpanParams, 'switchCost' | 'tau'>): number[] {
  const rows = hot.map((h) => [Math.log(Math.max(1 - h, LOG_FLOOR)), Math.log(Math.max(h, LOG_FLOOR)) - params.tau]);
  return viterbi(rows, params.switchCost);
}

/** Runs of the on-state, then the category-blind merge. Inclusive unit ranges. */
export function mergedRuns(
  path: readonly number[],
  units: readonly BookUnit[],
  params: Pick<SpanParams, 'mergeGapUnits' | 'mergeGapWords'>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, bEx] of runsOf(path, 1)) {
    const b = bEx - 1;
    const prev = out[out.length - 1];
    if (prev) {
      const gapUnits = a - prev[1] - 1;
      const gapWords = units[a]!.start - units[prev[1]]!.end;
      if (gapUnits <= params.mergeGapUnits || gapWords <= params.mergeGapWords) {
        prev[1] = b;
        continue;
      }
    }
    out.push([a, b]);
  }
  return out;
}

/** s_c for every category over units [from, to], strongest first. */
export function scoreRange(
  map: Pick<RatingMap, 'categories' | 'p1'>,
  from: number,
  to: number,
  params: Pick<SpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): SpanCategory[] {
  const e = evidence(map, params);
  const out: SpanCategory[] = [];
  for (let j = 0; j < map.categories.length; j += 1) {
    let best = -1;
    let bestUnit = from;
    for (let i = from; i <= to; i += 1) {
      const s = e[i]![j]!;
      if (s > best) {
        best = s;
        bestUnit = i;
      }
    }
    out.push({ category: map.categories[j]!, score: Math.max(best, 0), unit: bestUnit });
  }
  return out.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
}

/** Σ_c log(1 - s_c). Two categories at 0.9 (-4.6) beat one at 0.97 (-3.5). */
export function coFireStrength(scores: readonly number[]): number {
  return scores.reduce((sum, s) => sum + Math.log(Math.max(1 - s, Number.MIN_VALUE)), 0);
}

/** Strength order: strength ascending, then heat descending, then position. */
export function compareSpans(a: FlagSpan, b: FlagSpan): number {
  return a.strength - b.strength || b.heat - a.heat || a.start - b.start;
}

/** The categories reaching `floor` x the top one's evidence; always the top one. */
function keepCategories(all: readonly SpanCategory[], floor: number): SpanCategory[] {
  const top = all[0]?.score ?? 0;
  const kept = all.filter((c) => c.score > 0 && c.score >= floor * top);
  return kept.length ? kept : all.slice(0, 1);
}

function makeSpan(
  id: number,
  from: number,
  to: number,
  categories: SpanCategory[],
  units: readonly BookUnit[],
  hot: readonly number[],
): FlagSpan {
  let heat = 0;
  for (let i = from; i <= to; i += 1) heat += hot[i]!;
  return {
    id,
    unitFrom: from,
    unitTo: to,
    sentenceFrom: units[from]!.sentenceFrom,
    sentenceTo: units[to]!.sentenceTo,
    start: units[from]!.start,
    end: units[to]!.end,
    categories,
    strength: coFireStrength(categories.map((c) => c.score)),
    heat,
  };
}

/** Viterbi -> merge -> per-span categories -> strength order. */
export function buildSpans(map: RatingMap, params: SpanParams = DEFAULT_SPAN_PARAMS): FlagSpan[] {
  if (map.units.length === 0 || map.categories.length === 0) return [];
  const hot = hotness(map, params);
  const path = onOffPath(hot, params);
  const ranges = mergedRuns(path, map.units, params);
  const spans = ranges.map(([a, b], id) =>
    makeSpan(id, a, b, keepCategories(scoreRange(map, a, b, params), params.categoryFloor), map.units, hot));
  return spans.sort(compareSpans);
}

/**
 * Where to cut [from, to] into pieces of at most `maxSectionWords`, each at
 * least `minSectionWords`: at the quietest boundary (the lowest hotness on
 * either side of it), nearest the middle on a tie, then each half again. A
 * boundary is only between units that do not share a sentence. A stretch no
 * boundary can split (one very long unit) is left whole.
 */
export function valleyCuts(
  from: number,
  to: number,
  units: readonly BookUnit[],
  hot: readonly number[],
  params: Pick<SpanParams, 'maxSectionWords' | 'minSectionWords'>,
): Array<[number, number]> {
  if (units[to]!.end - units[from]!.start <= params.maxSectionWords) return [[from, to]];
  const mid = (units[from]!.start + units[to]!.end) / 2;
  let best = -1;
  let bestQuiet = Infinity;
  let bestOff = Infinity;
  for (let k = from + 1; k <= to; k += 1) {
    if (units[k]!.sentenceFrom <= units[k - 1]!.sentenceTo) continue;
    if (units[k - 1]!.end - units[from]!.start < params.minSectionWords) continue;
    if (units[to]!.end - units[k]!.start < params.minSectionWords) continue;
    const quiet = hot[k - 1]! + hot[k]!;
    const off = Math.abs(units[k]!.start - mid);
    if (quiet < bestQuiet - 1e-9 || (Math.abs(quiet - bestQuiet) <= 1e-9 && off < bestOff)) {
      best = k;
      bestQuiet = quiet;
      bestOff = off;
    }
  }
  if (best < 0) return [[from, to]];
  return [...valleyCuts(from, best - 1, units, hot, params), ...valleyCuts(best, to, units, hot, params)];
}

/**
 * A span longer than `maxSectionWords` becomes sections, cut at its quietest
 * points. A piece keeps each of the span's categories it carries evidence for
 * (at least `categoryFloor` of what the span had for it); a piece with none (a
 * lull inside a long span) is dropped. Pieces keep the parent's `id`.
 */
export function splitSpan(
  span: FlagSpan,
  map: RatingMap,
  hot: readonly number[],
  params: SpanParams = DEFAULT_SPAN_PARAMS,
): FlagSpan[] {
  const pieces = valleyCuts(span.unitFrom, span.unitTo, map.units, hot, params);
  if (pieces.length === 1) return [span];
  const wanted = new Map(span.categories.map((c) => [c.category, params.categoryFloor * c.score]));
  const out: FlagSpan[] = [];
  for (const [a, b] of pieces) {
    const cats = scoreRange(map, a, b, params).filter(
      (c) => wanted.has(c.category) && c.score > 0 && c.score >= wanted.get(c.category)!,
    );
    if (cats.length) out.push(makeSpan(span.id, a, b, cats, map.units, hot));
  }
  return out.length ? out : [span];
}

// --------------------------------------------------------------------------- windows

/**
 * The adapter to the verifier: every (section, kept category) becomes a
 * FlagCandidate and goes through rank.ts's `buildWindows`, so the ±2-sentence
 * context, the word caps, the merge rules and the noisy-OR are the ones this
 * port has always used. Returned strongest first — the verification order.
 */
export function spansToWindows(
  spans: readonly FlagSpan[],
  sentences: readonly BookSentence[],
  units: readonly BookUnit[],
  plan: readonly RankPlan[],
): FlagWindow[] {
  const proposition = new Map(plan.map((p) => [p.category, p.proposition]));
  const passages = [...spans].sort((a, b) => a.sentenceFrom - b.sentenceFrom || a.sentenceTo - b.sentenceTo);
  const candidates: FlagCandidate[] = [];
  for (const p of passages) {
    for (const c of p.categories) {
      // The representative sentence is the one holding the unit that scored it.
      const s = Math.min(Math.max(units[c.unit]!.sentenceFrom, p.sentenceFrom), p.sentenceTo);
      candidates.push({
        sentenceIndex: s,
        spanFrom: p.sentenceFrom,
        spanTo: p.sentenceTo,
        text: sentences[s]?.text ?? '',
        category: c.category,
        score: c.score,
        proposition: proposition.get(c.category) ?? c.category,
      });
    }
  }
  const heatOf = (w: FlagWindow): number => passages
    .filter((p) => p.sentenceFrom >= w.firedFrom && p.sentenceTo <= w.firedTo)
    .reduce((sum, p) => sum + p.heat, 0);
  return buildWindows(sentences, candidates)
    .map((window) => ({ window, strength: windowStrength(window), heat: heatOf(window) }))
    .sort((a, b) => a.strength - b.strength || b.heat - a.heat || a.window.contextFrom - b.window.contextFrom)
    .map((entry) => entry.window);
}

/** What the stage between the scorer and the verifier produced. */
export interface RankedWindows {
  /** Merged spans, strength order (before long-span splitting). */
  spans: FlagSpan[];
  /** What the verifier reads: spans split into sections, strength order. */
  passages: FlagSpan[];
  /** Every verification window, strongest first. */
  windows: FlagWindow[];
}

/** Everything after the scorer, from a rating map. */
export function rankFromRatingMap(
  map: RatingMap,
  sentences: readonly BookSentence[],
  plan: readonly RankPlan[],
  params: SpanParams = DEFAULT_SPAN_PARAMS,
): RankedWindows {
  const spans = buildSpans(map, params);
  const hot = hotness(map, params);
  const passages = spans.flatMap((sp) => splitSpan(sp, map, hot, params)).sort(compareSpans);
  const windows = spansToWindows(passages, sentences, map.units, plan);
  return { spans, passages, windows };
}
