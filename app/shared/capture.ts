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

/**
 * The recipe's path inside a project, and the capture step's payload.
 *
 * IN `shared/` BECAUSE TWO MODULES NAME IT AND NEITHER SHOULD IMPORT THE OTHER:
 * `electron/capture.ts` reads and writes the file, and `electron/projects.ts`
 * writes it into the step it appends at creation. Spelling it twice would put
 * a step's payload and the file it points at in two places, free to disagree
 * the day the layout moves.
 */
export const CAPTURE_RECIPE_PAYLOAD = 'capture/recipe.json';

/**
 * How far two photographs’ aspect ratios may differ and still share a crop.
 *
 * Two per cent is a tolerance for sensor rounding and nothing else. It is not
 * a judgement about how similar two pictures look: a frame that differs by more
 * than this is a differently shaped photograph, and a crop drawn for one is not
 * a crop of the other.
 */
export const ASPECT_TOLERANCE = 0.02;

/**
 * May a crop drawn for `source` be copied onto `candidate`?
 *
 * ── WHY NORMALIZED COORDINATES DID NOT MAKE COPYING SAFE ────────────────────
 *
 * Every coordinate in the recipe is a fraction, which guarantees a copied quad
 * lands INSIDE the target photograph. It guarantees nothing about landing on
 * the same part of it. Copy a portrait crop onto a landscape frame and the
 * fractions resolve to a region of the wrong proportions — in bounds,
 * plausible, and silently STRETCHED all the way into the finished PDF, where it
 * reads as a slightly squashed page rather than as an error. On the acceptance
 * shoot exactly one photograph fails this test (IMG_0238, landscape at
 * 5712x4284, among 26 portrait frames), and skipping it is the correct answer:
 * a landscape frame in a portrait shoot is a different photograph, not one the
 * same crop happens to fit.
 *
 * ── IN `shared/` FOR `outputSizeFor`’S REASON, ONE RULING LATER ─────────────
 *
 * This had two bodies within hours of the first being written: intake needs it
 * to decide what a late arrival inherits, and the light table needs it to decide
 * which cards an apply-to-all skips. They were algebraically identical and
 * therefore agreed — which is exactly what the two `outputSizeFor`s did before
 * one of them would have drifted. Found on P2’s read-back of Merge 2 and moved
 * here under the same ruling, before the drift rather than after it.
 *
 * THE TOLERANCE IS RELATIVE TO THE SOURCE, so this is not symmetric: it asks
 * whether the candidate is close enough to the shape the crop was DRAWN FOR.
 * A photograph with no height is not the same shape as anything, including
 * itself.
 */
export function sameShape(
  source: { width: number; height: number },
  candidate: { width: number; height: number },
): boolean {
  if (source.height <= 0 || candidate.height <= 0) return false;
  const drawnFor = source.width / source.height;
  // Multiplied out rather than divided: the division form has a denominator
  // that can be zero, and a rule about shapes should not have a hole in it.
  return Math.abs(candidate.width / candidate.height - drawnFor) <= ASPECT_TOLERANCE * drawnFor;
}

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
