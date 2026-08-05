/**
 * The per-word guard — the other half of the ocr ship configuration.
 *
 * Measured (galley_line_v1_1_4b checkpoint 2, Aug 1 2026): the 4B unguarded
 * cuts English CER below the do-nothing baseline, but the guard is ADDITIVE on
 * both axes — EN 0.357% → 0.317% with degraded rows 37 → 15, DE degraded
 * 52 → 29. So the stage ships with the guard always on, and the model's output
 * for a line is either accepted whole or discarded whole.
 *
 * The rule, exactly as the measured harness applied it: align the source and
 * output as WORD sequences; the only acceptable difference is a run that
 * replaces N words with N words, each pair within Levenshtein distance
 * `maxDist` (2). A word inserted, a word deleted, or an unbalanced replacement
 * is a structural rewrite, not a recognition fix, and rejects the whole line.
 * This is what stops the one unguardable failure class — the model deleting a
 * real word (measured: it once deleted the word "I") — because a per-line
 * distance ratio cannot see a short word vanish.
 *
 * The measured harness used difflib.SequenceMatcher for the alignment; this
 * port uses the same Myers word-level diff style as src/ocr/edits.ts. The two
 * can pick different alignments for pathological inputs, but the acceptance
 * rule they enforce is the same: every changed region must be a balanced,
 * per-word-close substitution.
 *
 * ## TWO POLICIES, ONE RULE
 *
 * The RULE above is not in question and is not parameterised: a changed run is
 * legal only if it is balanced and per-word close. What a policy chooses is the
 * BLAST RADIUS of one illegal run.
 *
 *   `whole-unit` — the SHIPPED default. One illegal run discards the model's
 *       whole answer for the unit and the source is kept verbatim. This is the
 *       configuration every number above was measured under, and it is what
 *       `ocrWordGuard` reports.
 *
 *   `per-run` — keep the legal runs, revert only the illegal ones to their
 *       source words. Same rule, applied run by run.
 *
 * Why `whole-unit` is the default rather than the obvious-looking `per-run`:
 * an illegal run is evidence about the WHOLE answer, not only about itself. A
 * model that deleted a word in one clause was not reading carefully in the
 * others either, and the neighbouring "legal" substitutions in that same answer
 * are drawn from a different, worse distribution than the ones in an answer
 * that broke no rule. `per-run` bets that they are independent. That bet is an
 * empirical question about `degraded`, not a design preference, so it was
 * MEASURED rather than assumed — and the answer depends on the UNIT.
 *
 * The blast radius is a function of unit length, which is why the policy is a
 * knob at all. On a LINE, discarding the unit costs the handful of repairs that
 * line had, and the two policies are statistically indistinguishable. On a
 * 400-character SENTENCE one bad clause throws away five lines' worth of good
 * corrections, and `whole-unit` stops being a guard on the stage and becomes an
 * off switch for it. So the policy is chosen per unit shape: lines ship
 * `OCR_GUARD_SHIPPED_POLICY`, sentences ship `OCR_GUARD_SENTENCE_POLICY`.
 *
 * ## WHITESPACE
 *
 * The rule reads words and is blind to the spacing between them; both policies
 * inherit that. `per-run` has to REBUILD text rather than pick one of two
 * strings, so it carries each word's preceding whitespace along with it: a
 * kept word keeps the spacing the model gave it, a reverted word gets the
 * spacing the source gave it. When nothing is reverted the model's answer is
 * returned as the identical string it arrived as, and when the surviving words
 * are exactly the source's the SOURCE string is returned identically — so
 * neither policy can invent a whitespace-only edit at its own boundaries.
 */

export const OCR_GUARD_MAX_WORD_DISTANCE = 2;

/**
 * How far one illegal run reaches. See the file header — `whole-unit` is the
 * measured ship configuration and the default everywhere.
 */
export type OcrGuardPolicy = 'whole-unit' | 'per-run';

/** The policy every measured number was taken under. Changing this is a ship decision. */
export const OCR_GUARD_SHIPPED_POLICY: OcrGuardPolicy = 'whole-unit';

/**
 * The policy for the SENTENCE unit (`ocr-correct --epub`, src/ocr/sentences.ts).
 *
 * MEASURED 2026-08-05 (BookForge `tools/foundry-ocr/results-guard-experiment/`):
 * on 400-character units at 7% CER, `whole-unit` kept 6 corrections across 102
 * units where `per-run` kept 96. At that length nearly every answer carries one
 * illegal run somewhere, so discarding the unit does not guard the stage — it
 * turns it off, while still costing a full generation per sentence. Net CER
 * favours `per-run` in 5 of the 6 measured cells; the sixth turns on 2 units in
 * 390, which is noise.
 *
 * The same measurement is why the LINE path is untouched: on lines the two
 * policies are statistically indistinguishable, so nothing is gained by moving
 * the configuration every checkpoint number was taken under.
 */
export const OCR_GUARD_SENTENCE_POLICY: OcrGuardPolicy = 'per-run';

/** Levenshtein, two-row. Words are short; this is not a bottleneck. */
function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** LCS-based word alignment: which indices of `a` and `b` pair as equal. */
function equalPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  // DP table over word lists — lines are a couple dozen words, this is tiny.
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** One word and the whitespace that came immediately before it. */
interface Token {
  word: string;
  /** The run of whitespace between the previous word and this one; '' for the first. */
  sep: string;
}

/**
 * Split into words while remembering the spacing, so a rebuilt string can be
 * byte-identical to its source wherever nothing was changed.
 */
function tokenize(s: string): { lead: string; tokens: Token[]; trail: string } {
  const tokens: Token[] = [];
  let lead = '';
  let at = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(s)) !== null) {
    const gap = s.slice(at, m.index);
    if (first) { lead = gap; first = false; tokens.push({ word: m[0], sep: '' }); }
    else tokens.push({ word: m[0], sep: gap });
    at = m.index + m[0].length;
  }
  return { lead, tokens, trail: s.slice(at) };
}

/** A contiguous region where the source and the output disagree. */
export interface GuardRun {
  /** The source words the model replaced. Empty means the model INSERTED. */
  del: string[];
  /** The words the model put there. Empty means the model DELETED. */
  ins: string[];
  /** True when this run is a balanced, per-word-close substitution. */
  ok: boolean;
  /** Why an illegal run is illegal, naming the offending words. */
  why?: string;
}

export interface GuardVerdict {
  ok: boolean;
  /** Human-readable reason when rejected; states the offending words. */
  why?: string;
}

export interface GuardResolution extends GuardVerdict {
  policy: OcrGuardPolicy;
  /** The text to ship: the model's answer, the source, or a per-run mixture. */
  text: string;
  /** Every changed run, in order, with its verdict. */
  runs: GuardRun[];
  /** Changed runs the rule accepted. */
  acceptedRuns: number;
  /** Changed runs the rule refused — reverted under `per-run`, fatal under `whole-unit`. */
  rejectedRuns: number;
}

/**
 * Judge every changed run, then resolve them under a policy.
 *
 * `ok` means the model's answer survived intact. Under `per-run` a resolution
 * can have `ok: false` and still carry text that is not the source: the legal
 * runs were kept. Callers that need "was anything refused" read `rejectedRuns`;
 * callers that need "what do I ship" read `text`.
 */
export function ocrGuardResolve(
  src: string,
  out: string,
  options: { policy?: OcrGuardPolicy; maxDist?: number } = {},
): GuardResolution {
  const policy = options.policy ?? OCR_GUARD_SHIPPED_POLICY;
  const maxDist = options.maxDist ?? OCR_GUARD_MAX_WORD_DISTANCE;

  if (src === out) {
    return { policy, ok: true, text: out, runs: [], acceptedRuns: 0, rejectedRuns: 0 };
  }

  const A = tokenize(src), B = tokenize(out);
  const a = A.tokens.map((t) => t.word);
  const b = B.tokens.map((t) => t.word);

  const pairs = equalPairs(a, b);
  // Walk the gaps between (and around) equal pairs: each gap holds the words
  // of `a` and `b` that found no equal partner. Segments are kept in order and
  // with their indices, because `per-run` has to rebuild a string from them.
  type Segment =
    | { kind: 'equal'; ai: number; bi: number }
    | { kind: 'run'; a1: number; a2: number; b1: number; b2: number };
  const segments: Segment[] = [];
  let ai = 0, bi = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pi > ai || pj > bi) segments.push({ kind: 'run', a1: ai, a2: pi, b1: bi, b2: pj });
    if (pi < a.length && pj < b.length) segments.push({ kind: 'equal', ai: pi, bi: pj });
    ai = pi + 1; bi = pj + 1;
  }

  const runs: GuardRun[] = [];
  const verdictOf = new Map<Segment, GuardRun>();
  for (const seg of segments) {
    if (seg.kind !== 'run') continue;
    const del = a.slice(seg.a1, seg.a2);
    const ins = b.slice(seg.b1, seg.b2);
    const run = judgeRun(del, ins, maxDist);
    runs.push(run);
    verdictOf.set(seg, run);
  }

  const bad = runs.filter((r) => !r.ok);
  const acceptedRuns = runs.length - bad.length;
  const base: Omit<GuardResolution, 'text'> = {
    policy,
    ok: bad.length === 0,
    ...(bad.length ? { why: bad[0].why } : {}),
    runs,
    acceptedRuns,
    rejectedRuns: bad.length,
  };

  if (bad.length === 0) return { ...base, text: out };
  if (policy === 'whole-unit') return { ...base, text: src };

  // ── per-run: keep the legal runs, revert the illegal ones ─────────────────
  const kept: Token[] = [];
  for (const seg of segments) {
    if (seg.kind === 'equal') { kept.push(B.tokens[seg.bi]); continue; }
    const run = verdictOf.get(seg);
    if (run === undefined) throw new Error('unjudged run — the segment walk and the verdict map disagree');
    if (run.ok) kept.push(...B.tokens.slice(seg.b1, seg.b2));
    else kept.push(...A.tokens.slice(seg.a1, seg.a2));
  }

  // Reverting every changed run leaves the source's words; return the source
  // string itself rather than a re-spaced copy of it, so a full rejection under
  // `per-run` is indistinguishable from one under `whole-unit`.
  if (kept.length === a.length && kept.every((t, i) => t.word === a[i])) {
    return { ...base, text: src };
  }
  const text = B.lead
    + kept.map((t, i) => (i === 0 ? '' : t.sep) + t.word).join('')
    + B.trail;
  return { ...base, text };
}

/** The rule, applied to one changed run. */
function judgeRun(del: string[], ins: string[], maxDist: number): GuardRun {
  if (del.length !== ins.length) {
    return {
      del, ins, ok: false,
      why: `unbalanced change: [${del.join(' ')}] → [${ins.join(' ')}] `
        + `(${del.length} word${del.length === 1 ? '' : 's'} → ${ins.length})`,
    };
  }
  for (let k = 0; k < del.length; k++) {
    const d = lev(del[k], ins[k]);
    if (d > maxDist) {
      return {
        del, ins, ok: false,
        why: `word changed beyond distance ${maxDist}: "${del[k]}" → "${ins[k]}" (distance ${d})`,
      };
    }
  }
  return { del, ins, ok: true };
}

/**
 * Accept or reject a model's corrected line against its source, whole.
 *
 * The shipped question, and the one the measured numbers answer: is the WHOLE
 * answer usable? For the per-run mixture, call `ocrGuardResolve`.
 */
export function ocrWordGuard(
  src: string,
  out: string,
  maxDist: number = OCR_GUARD_MAX_WORD_DISTANCE,
): GuardVerdict {
  const r = ocrGuardResolve(src, out, { policy: 'whole-unit', maxDist });
  return r.ok ? { ok: true } : { ok: false, why: r.why };
}
