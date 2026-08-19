/**
 * shared/capture — the capture stage's arithmetic, asked once and answered once.
 *
 * The recipe's SHAPES live in shared/types.ts with every other shape; what lives
 * here is the one calculation both sides of the bridge have to agree about. It
 * is pure, it reads nothing, and it is in `shared/` for the same reason
 * `shared/stages.ts` is: two implementations of one rule are two answers waiting
 * to disagree.
 *
 * ── Why this file exists at all, which is a story about one sentence ────────
 *
 * docs/CAPTURE.md pinned the rule as prose — *"Output page size = the quad's
 * opposite-edge maxima"* — and that sentence acquired two implementations within
 * hours: MAIN needs it because `capture:mint-begin` returns `outWidth`/
 * `outHeight` per page, and THE EDITOR needs it because it has to shape a
 * preview while somebody is still dragging corners, long before any mint has
 * been asked for. P2 raised it on the feature channel (seq 25) before the second
 * copy could drift, and the ruling (seq 26) was to move the function here.
 *
 * THE ROUNDING IS THE PART THAT WOULD HAVE DRIFTED. `Math.round` against
 * `Math.floor` is a one-pixel disagreement per page that no typecheck can see
 * and no test would have been written for; the preview and the minted page would
 * have differed slightly on every page of every book, and nobody would have
 * noticed until they compared the two closely. The prose did not say which, and
 * a rule that does not say which is a rule with two readings.
 */
import type { PixelQuad } from './types';

/** A rectified page's size in pixels. Whole pixels: it is a raster's extent. */
export interface OutputSize {
  width: number;
  height: number;
}

/**
 * How big the rectified page is, from the quad it is being rectified out of.
 *
 * ── The maxima, and why it is not the average ───────────────────────────────
 *
 * A quad drawn over a photographed page is a trapezoid: perspective makes the
 * far edge shorter than the near one. Rectifying it stretches the short edge out
 * to match the long one, so the honest output extent is the LONGER of each
 * opposing pair — anything less would be choosing to resample part of the page
 * downwards, which is the one thing this stage promises it never does.
 *
 * ── In WORKING-COPY PIXELS, which is the only unit that means anything here ─
 *
 * The recipe stores fractions; this takes pixels. Main multiplies the recipe's
 * quad by the working copy's decoded dimensions exactly once and passes the
 * result to both this function and the renderer (`CaptureMintPage.quadPx`), so
 * the multiply never happens twice against two ideas of how big the photo is.
 *
 * ── Clamped to 1, because a degenerate quad must still be a page ────────────
 *
 * Four corners dragged onto one point is a zero-by-zero raster, and a zero-sized
 * canvas throws in some browsers and returns a blank in others. One pixel is a
 * page a person can see is wrong, which is the failure worth having.
 */
export function outputSizeFor(quad: PixelQuad): OutputSize {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const span = (a: readonly [number, number], b: readonly [number, number]): number =>
    Math.hypot(b[0] - a[0], b[1] - a[1]);
  return {
    width: Math.max(1, Math.round(Math.max(span(topLeft, topRight), span(bottomLeft, bottomRight)))),
    height: Math.max(1, Math.round(Math.max(span(topLeft, bottomLeft), span(topRight, bottomRight)))),
  };
}
