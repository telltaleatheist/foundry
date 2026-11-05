/**
 * WHEN AN ANSWER IS NOT A PAGE — catching a runaway by its SHAPE.
 *
 * ── Owen's report, which is what this is for ────────────────────────────────
 *
 * *"dots runs away when a page is a bad scan with bleed through from the other
 * side of the page... it tries to decipher it but just throws out nonsense and
 * goes on for 25,000 characters."*
 *
 * Wave 22 bounded the COST of that with an adaptive token cap, and it works: a
 * runaway now stops at four times the longest real page in the book instead of
 * at the model's own ceiling. But a cap is a statement about length, and length
 * is not the thing that is wrong with the answer. A page that produces three
 * thousand tokens of nonsense UNDER its cap is accepted today, in full, into
 * the book — and the cap cannot see it, because by its own measure nothing
 * happened.
 *
 * ── The signal, and why it is only one ──────────────────────────────────────
 *
 * Measured against every banked page in Owen's library — 197 answers across
 * four banks, including the two known runaways:
 *
 *   REAL PAGES over 800 chars   worst top-5-gram share   0.0118
 *   Flashpoint p6, the runaway  23,857 chars             0.3299
 *
 * Twenty-eight times the worst real page. So the share of the text taken by
 * its single most repeated five-word phrase separates them with room to spare,
 * and `RUNAWAY_SHARE` sits at 0.15 — TWELVE TIMES the worst real page and
 * still less than half the observed runaway. Deliberately far from the real
 * pages rather than close to the runaway, because of the asymmetry below.
 *
 * A SECOND SIGNAL WAS BUILT AND THROWN AWAY, and it is worth saying so: the
 * longest run of identical consecutive lines is 1 on every page in the library,
 * runaways included. It sounds like the obvious test for repetition and it
 * fires on nothing, because this model reflows rather than repeating whole
 * lines. Shipping it would have been a check that never runs, occupying the
 * space where a working one should be.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CATCH ──────────────────────────────────
 *
 * Flashpoint p11 is a real runaway — 16,401 characters — with a share of
 * 0.0526, BELOW the worst real page. It is long nonsense that does not repeat
 * itself, and no amount of tuning this signal reaches it without taking real
 * pages with it. The cap catches that one, which is the division of labour:
 * THE CAP BOUNDS LENGTH, THIS BOUNDS SHAPE, and neither is asked to do the
 * other's job.
 *
 * ── The asymmetry that sets the threshold ──────────────────────────────────
 *
 * A false negative costs a page its cap, once, and the run says so on screen.
 * A FALSE POSITIVE SILENTLY EMPTIES A PAGE SOMEBODY'S BOOK NEEDED. Those are
 * not comparable, so the threshold is set where it is safe rather than where it
 * is sensitive, and every page it fires on is named in the log with its number
 * so a wrong one is visible the moment it happens rather than at proofreading.
 *
 * ── It does not stop generation, and cannot ────────────────────────────────
 *
 * Neither path streams: `vlm_page.py` calls mlx-vlm's `generate` and waits, and
 * `endpoint.ts` posts and waits. So this judges a FINISHED answer and cannot
 * abort one mid-flight. It saves no inference time — it prevents nonsense from
 * entering a book. If a streaming path ever arrives, this function is already
 * the predicate it would need.
 */

/** The share of a text one repeated phrase may take before it is not a page. */
export const RUNAWAY_SHARE = 0.15;

/**
 * Below this, shape says nothing.
 *
 * A short answer has few phrases in it, so one of them repeating twice is an
 * ordinary sentence rather than evidence. Real pages in the library run to
 * 4,657 characters and the median is 1,420; a runaway is long by nature, so
 * nothing worth catching lives under this line. Measured: no real page over it
 * scores above 0.0118.
 */
export const RUNAWAY_MIN_CHARS = 800;

/** Words per phrase. Five is long enough to be a claim and short enough to recur. */
const GRAM = 5;

export interface RunawayVerdict {
  /** True when this answer repeats itself so hard it is not a page. */
  readonly runaway: boolean;
  /** The share the most repeated phrase took, for the log line. */
  readonly share: number;
}

/**
 * Does this answer repeat itself the way a runaway does?
 *
 * A PURE FUNCTION AND NOT AN OBJECT, for `band.ts`'s reason: a stateful judge
 * can be built twice and disagree with itself, and this one is asked the same
 * question from three different passes of the same run.
 */
export function looksLikeRunaway(text: string): RunawayVerdict {
  if (text.length < RUNAWAY_MIN_CHARS) return { runaway: false, share: 0 };
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length < GRAM * 4) return { runaway: false, share: 0 };

  const seen = new Map<string, number>();
  let places = 0;
  let most = 0;
  for (let at = 0; at + GRAM <= words.length; at += 1) {
    const phrase = words.slice(at, at + GRAM).join(' ');
    const count = (seen.get(phrase) ?? 0) + 1;
    seen.set(phrase, count);
    if (count > most) most = count;
    places += 1;
  }
  const share = places === 0 ? 0 : most / places;
  return { runaway: share >= RUNAWAY_SHARE, share };
}
