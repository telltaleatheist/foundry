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
 */

export const OCR_GUARD_MAX_WORD_DISTANCE = 2;

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

export interface GuardVerdict {
  ok: boolean;
  /** Human-readable reason when rejected; states the offending words. */
  why?: string;
}

/**
 * Accept or reject a model's corrected line against its source, whole.
 */
export function ocrWordGuard(
  src: string,
  out: string,
  maxDist: number = OCR_GUARD_MAX_WORD_DISTANCE,
): GuardVerdict {
  if (src === out) return { ok: true };
  const a = src.split(/\s+/).filter((w) => w.length > 0);
  const b = out.split(/\s+/).filter((w) => w.length > 0);

  const pairs = equalPairs(a, b);
  // Walk the gaps between (and around) equal pairs: each gap holds the words
  // of `a` and `b` that found no equal partner.
  let ai = 0, bi = 0;
  const gaps: Array<{ del: string[]; ins: string[] }> = [];
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    const del = a.slice(ai, pi), ins = b.slice(bi, pj);
    if (del.length > 0 || ins.length > 0) gaps.push({ del, ins });
    ai = pi + 1; bi = pj + 1;
  }

  for (const { del, ins } of gaps) {
    if (del.length !== ins.length) {
      return {
        ok: false,
        why: `unbalanced change: [${del.join(' ')}] → [${ins.join(' ')}] `
          + `(${del.length} word${del.length === 1 ? '' : 's'} → ${ins.length})`,
      };
    }
    for (let k = 0; k < del.length; k++) {
      const d = lev(del[k], ins[k]);
      if (d > maxDist) {
        return {
          ok: false,
          why: `word changed beyond distance ${maxDist}: "${del[k]}" → "${ins[k]}" (distance ${d})`,
        };
      }
    }
  }
  return { ok: true };
}
