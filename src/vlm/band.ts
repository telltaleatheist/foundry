/**
 * src/vlm/band — how long the next page is allowed to be, given this book.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * dots.ocr sometimes runs away on a bad scan. A page photographed blank, with
 * bleed-through from the other side, is not blank to the model: there is real
 * ink on it, faint and mirrored, and it tries to read it. What comes back is
 * twenty-five thousand characters of nonsense produced over three minutes.
 *
 * THE BOOK IS NOT AT RISK AND THAT IS THE FIRST THING TO SAY, because it
 * decides what this file is for. A page that hits the token cap comes back
 * `finishReason: 'length'` and `read.ts` REFUSES it — at both call sites, the
 * live one and the banked replay. Measured across the whole of one library:
 * 18,202 pages, 22 runaways, and all 22 refused. Not one character of nonsense
 * has ever been accepted as a page.
 *
 * SO THE COST IS TIME. Those 22 pages spent 64 minutes producing nothing. A
 * runaway takes 180 seconds against a median real page of 21.7 — 8.3 times the
 * work for an answer that is thrown away. This file exists to stop paying it.
 *
 * ── Why the cap cannot simply be lowered ───────────────────────────────────
 *
 * The obvious fix is a smaller number in `models.ts`, and it is the one fix
 * that must not happen. The same library holds ACCEPTED pages of 7,677 tokens —
 * 93.7% of the 8,192 cap — and four more over 4,900. The densest is a full-page
 * facsimile of a newspaper reproduced inside a book; every column of it is text
 * the model is right to read. A lower cap trades a real page for a fake one,
 * and the person this was built for said it in one sentence: *"its doing a fine
 * job with everything else so i dont want to cripple its other work."*
 *
 * ── What is actually wrong: the cap belongs to the RUN, not the model ──────
 *
 * 8,192 cannot be right about both of those books at once. Inside Michelle
 * Remembers the longest real page is 1,273 tokens; in the book with the
 * facsimile it is 7,677. One constant serving both means the first book waits
 * six times longer than it ever needs to before admitting a page is lost.
 *
 * So the ceiling is derived from the book in front of it: the longest page this
 * run has ACCEPTED, times a margin. A book that gets denser raises its own
 * ceiling as it goes.
 *
 * ── The three numbers, each of which is a measurement ──────────────────────
 *
 * THE MARGIN IS 4 AND 3.35 IS WHY. Across 46 books, each book's densest
 * accepted page against the running maximum as it actually stood when that page
 * arrived: the worst step that a margin has to clear is 3.35x — the facsimile,
 * landing 43% through its book between neighbours of 352 and 456 tokens. A 3x
 * margin refuses it. 4 is the first whole number that does not, and it leaves
 * 0.65 of headroom over the worst case in 18,202 pages. Simulated over the
 * whole library: 4x costs ZERO accepted pages and saves 24 minutes; 3x saves
 * nine minutes more and costs exactly the two densest pages in the library.
 *
 * THE MARGIN IS ALSO A FUNCTION OF CONCURRENCY, and this is the coupling that
 * would otherwise be invisible. The band can only be fed by pages that have
 * LANDED, so with N requests in flight a page is sent under a band up to N
 * pages stale. At the shipped `DEFAULT_VLM_CONCURRENCY` of 12 that costs
 * nothing — measured, zero pages. At 24 it costs two. IF THAT KNOB IS EVER
 * RAISED, THIS MARGIN MUST BE REVISITED IN THE SAME COMMIT.
 *
 * THE FLOOR IS 2,000 BECAUSE WITHOUT ONE THE BAND IS SET BY WHATEVER THE FIRST
 * PAGE HAPPENED TO BE. A title page of 54 tokens would cap the next page at
 * 216. Simulated: a running maximum with no floor loses 401 real pages at 4x
 * and 2,215 at 2x. The floor is not a precaution, it is the whole design — and
 * it also absorbs the library's worst ratio outright, a 5.04x jump on page 4 of
 * one book which is nothing but a dense copyright notice at 1,038 tokens, well
 * underneath it.
 *
 * THE CLAMP IS THE MODEL'S OWN CAP, and it does something better than bound the
 * arithmetic: the densest books are untouched BY CONSTRUCTION. The facsimile
 * book's ceiling of 7,677 times four is 30,708, which clamps straight back to
 * 8,192, so its band never moves off the model's number and nobody has to keep
 * a threshold right for it.
 *
 * ── It cannot corrupt a book, which is the property worth having ───────────
 *
 * A tighter cap changes only WHEN a refusal happens, never WHETHER text is
 * accepted. Both refusal sites key on `finishReason: 'length'`, and a page cut
 * at 3,819 refuses exactly as a page cut at 8,192 does. There is no path by
 * which this puts a character into anybody's book — which is a stronger safety
 * property than any filter over the text, because a filter has to decide what
 * is true and this only decides how long to keep waiting.
 */

/**
 * How many times the longest accepted page a later page may be.
 *
 * See the file docblock: 3.35x is the worst real step measured, and this is
 * COUPLED TO `DEFAULT_VLM_CONCURRENCY` — raising that knob invalidates this
 * number, because the band a page is sent under is staler the more requests are
 * in flight.
 */
export const BAND_MARGIN = 4;

/**
 * The shortest ceiling this will ever impose, whatever the book has shown.
 *
 * A book opens with its sparsest pages — half title, title, copyright — so the
 * margin alone would set an absurd ceiling from them. Everything below this is
 * the model's business rather than the band's.
 */
export const BAND_FLOOR = 2000;

/**
 * The cap for the next page: the longest ACCEPTED page so far, times the
 * margin, floored, and clamped to what the model itself allows.
 *
 * ── A pure function, and not the object it was nearly built as ─────────────
 *
 * The caller holds one number and asks. There is no state here and no instance,
 * which is deliberate: a stateful band has to be created somewhere, and the day
 * a second one is created the two disagree about a book with nothing to say
 * which is right. A function of a number the reader already holds cannot be
 * built twice.
 *
 * ── `longestAccepted` MEANS ACCEPTED, AND THIS CANNOT CHECK THAT ───────────
 *
 * The one invariant that matters is not enforceable here: only a page the model
 * finished may raise the band. A refused page must never feed it, or a runaway
 * would inflate the very ceiling meant to catch it, and each one would raise it
 * further. This function takes a number and cannot know where it came from, so
 * that invariant lives at the call site in `read.ts` and is asserted there —
 * named rather than assumed, because its failure is silent and self-inflating.
 *
 * ── No evidence means no tightening ────────────────────────────────────────
 *
 * Before any page has landed, the answer is the model's own cap rather than the
 * floor. On the measured library the two are indistinguishable — the largest
 * opening page across 46 books is 1,386, comfortably under the floor — but a
 * book that OPENS dense would lose its first page to a floor and loses nothing
 * to this. Costing nothing and refusing to guess downward, it takes the safer
 * of two identical answers.
 */
export function capFor(longestAccepted: number, modelCap: number): number {
  if (!Number.isFinite(longestAccepted) || longestAccepted <= 0) return modelCap;
  const asked = Math.max(BAND_FLOOR, Math.floor(longestAccepted * BAND_MARGIN));
  return Math.min(modelCap, asked);
}
