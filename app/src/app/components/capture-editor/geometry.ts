/**
 * The light table's geometry — every rule about corners, in one place.
 *
 * ── Why these are functions and not methods on a component ──────────────────
 *
 * The grid, the page editor and the mint driver all ask the same questions
 * about the same four points: where is this quad on the working copy, what does
 * a quarter turn do to it, where does the split line cut it, and may this quad
 * be copied onto that photograph. Answered in three components those become
 * three spellings, and the one that drifts is discovered by a person looking at
 * a crooked page in a minted PDF.
 *
 * Pure, over plain numbers, importing nothing: the same reasoning `shared/
 * stages.ts` gives for its predicates, applied one stage upstream.
 *
 * ── The two coordinate systems, and why they have different names ───────────
 *
 * The recipe stores FRACTIONS of the working copy (docs/CAPTURE.md, settled on
 * the feature channel 2026-08-19 after the shoot turned out to hold two shapes).
 * The rectify shader and every mouse event work in PIXELS. Both are four pairs
 * of numbers and TypeScript cannot tell them apart, which is precisely this
 * project's recurring defect — two things sharing a name — so they are named
 * apart here and every crossing between them goes through `toPixels` or
 * `toFractions`. If a quad in this codebase was not produced by one of those two
 * functions, it is in whatever unit its author was thinking in.
 *
 * ── The rotation lives in the corner order, and nowhere else ────────────────
 *
 * The recipe has no rotation field, on purpose: "the corner assignment IS the
 * orientation" (docs/CAPTURE.md, Conventions). A quarter turn is a permutation
 * of the tuple, which is why `rotate` below returns a quad rather than an angle,
 * and why nothing downstream of it has to remember that a turn happened.
 */

import type { Point, Quad } from './rectify';

/**
 * Four corners in PIXELS on the working copy — what the shader and the pointer
 * both speak. Re-exported from the rectify so there is one definition of the
 * tuple's order (top-left, top-right, bottom-right, bottom-left of the output).
 */
export type PixelQuad = Quad;
export type PixelPoint = Point;

/** A point as FRACTIONS of the working copy's width and height. */
export type FractionPoint = readonly [number, number];

/**
 * Four corners as FRACTIONS — the recipe's own unit.
 *
 * Fractions rather than pixels because the shoot holds more than one image size
 * and the recipe has to survive being read against a working copy that was
 * re-decoded at another scale. What fractions do NOT buy is safety in
 * "apply to all": see `sameShape`.
 */
export type FractionQuad = readonly [FractionPoint, FractionPoint, FractionPoint, FractionPoint];

/** The pixel dimensions of a working copy, as the DECODER reported them. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * The whole photograph as a quad — what a page starts as before anybody drags a
 * corner, and what an unedited photo mints as.
 */
export function wholeFrame(): FractionQuad {
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
}

/** Fractions onto a working copy of these dimensions. */
export function toPixels(quad: FractionQuad, of: Dimensions): PixelQuad {
  return [
    [quad[0][0] * of.width, quad[0][1] * of.height],
    [quad[1][0] * of.width, quad[1][1] * of.height],
    [quad[2][0] * of.width, quad[2][1] * of.height],
    [quad[3][0] * of.width, quad[3][1] * of.height],
  ];
}

/** Pixels on a working copy of these dimensions, back to fractions. */
export function toFractions(quad: PixelQuad, of: Dimensions): FractionQuad {
  if (of.width === 0 || of.height === 0) {
    throw new Error('A working copy with no dimensions has no fractions to take.');
  }
  return [
    [quad[0][0] / of.width, quad[0][1] / of.height],
    [quad[1][0] / of.width, quad[1][1] / of.height],
    [quad[2][0] / of.width, quad[2][1] / of.height],
    [quad[3][0] / of.width, quad[3][1] / of.height],
  ];
}

/**
 * The same page, turned a quarter of the way round, `turns` times clockwise.
 *
 * ── It is a permutation, and that is the whole implementation ───────────────
 *
 * Turn the page clockwise and the corner that WAS at the bottom-left is the one
 * now at the top-left; each corner moves one place along the tuple. So a turn is
 * a rotation of the array by one, and four turns are the identity — exactly, with
 * no accumulated floating-point drift, which an angle-based rotation about a
 * centre could not promise.
 *
 * Negative turns are anticlockwise. The modulo is written to survive them.
 */
export function rotate(quad: FractionQuad, turns: number): FractionQuad {
  const steps = ((Math.trunc(turns) % 4) + 4) % 4;
  let turned = quad;
  for (let step = 0; step < steps; step += 1) {
    turned = [turned[3], turned[0], turned[1], turned[2]];
  }
  return turned;
}

/**
 * The two page-quads either side of a split line at `at` across this quad.
 *
 * ── The line is cut across THE QUAD, not across the photograph ──────────────
 *
 * `at` is a fraction of the way along the quad's own top and bottom edges, so a
 * split still lands on the gutter after the corners have been dragged in to
 * crop the desk away. Splitting in image coordinates instead would move the
 * gutter every time somebody adjusted the crop, which is the same class of
 * mistake as reversing raw page cards instead of spreads.
 *
 * ── Interpolating the edges, and what that is an approximation of ───────────
 *
 * The cut runs from a point on the top edge to the point at the same fraction
 * along the bottom edge. Under a projective transform that is not exactly the
 * line the gutter's own perspective would put there — the true midline is
 * pulled towards the far side of the page — but the split is a line THE USER
 * DRAGS onto the picture, and what they see is where it goes. The quads are
 * authoritative for the mint (docs/CAPTURE.md pins that), so the recipe's
 * `split` only ever has to reproduce the handle they dragged.
 */
export function splitAt(quad: FractionQuad, at: number): readonly [FractionQuad, FractionQuad] {
  const cut = Math.min(1, Math.max(0, at));
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const topCut = lerp(topLeft, topRight, cut);
  const bottomCut = lerp(bottomLeft, bottomRight, cut);
  return [
    [topLeft, topCut, bottomCut, bottomLeft],
    [topCut, topRight, bottomRight, bottomCut],
  ];
}

function lerp(from: FractionPoint, to: FractionPoint, at: number): FractionPoint {
  return [from[0] + (to[0] - from[0]) * at, from[1] + (to[1] - from[1]) * at];
}

/**
 * How different two working copies' shapes may be and still count as the same
 * shape — two percent of the aspect ratio, pinned in docs/CAPTURE.md at c07f837.
 *
 * The number is the doc's, not this file's: loose enough that a camera
 * reporting 4032x3024 and 4030x3022 is one shape;
 * far tighter than the gap the real shoot contains (0.75 against 1.3333).
 */
const ASPECT_TOLERANCE = 0.02;

/**
 * MAY A QUAD BE COPIED FROM A PHOTO OF THESE DIMENSIONS ONTO ONE OF THOSE —
 * the gate on "apply to all" and on a late drop inheriting its predecessor.
 *
 * ── The rule that this exists to stop being invisible ───────────────────────
 *
 * Settled on the feature channel, 2026-08-19, measured rather than reasoned. The
 * first acceptance shoot decodes to two shapes: twenty-six pages at 3024x4032
 * (portrait) and IMG_0238 at 5712x4284 (landscape), because the container
 * rotation libheif applies turns most of the shoot on its side and leaves one
 * photograph where it was.
 *
 * Fractions make a copy between two photos of the SAME shape exact at any size.
 * Between two shapes they do something worse than fail: the quad is stretched
 * into a different figure that still lies neatly inside the frame, so the page
 * mints full-bleed, plausible, and geometrically wrong — where the same mistake
 * in absolute pixels would have hung the corners off the edge where the rectify
 * reports them (`Rectified.withinSource`). The unit was never the safety
 * property. Same shape is.
 *
 * So a copy across shapes is REFUSED rather than approximated, and the surface
 * says which photographs it skipped. On the real shoot that is one card of
 * twenty-seven keeping its own corners — the correct outcome, because a
 * landscape frame in a portrait shoot is a different photograph, not a
 * photograph the same crop happens to fit.
 */
export function sameShape(source: Dimensions, target: Dimensions): boolean {
  if (source.height === 0 || target.height === 0) return false;
  const sourceAspect = source.width / source.height;
  const targetAspect = target.width / target.height;
  return Math.abs(sourceAspect - targetAspect) <= ASPECT_TOLERANCE * sourceAspect;
}

/*
 * THE OUTPUT-SIZE RULE USED TO BE COPIED HERE and is not any more.
 *
 * "Output page size = the quad's opposite-edge maxima" had two implementations
 * for as long as the editor needed a preview size and main needed `outWidth`.
 * Raised on the feature channel at seq 25 with the formula written out to diff
 * against, ruled at seq 26, and `outputSizeFor` now lives in
 * `shared/capture.ts` where both sides import it. The two copies agreed to the
 * pixel when this one was deleted — which is the point: they agreed until they
 * did not, and nothing would have said when.
 */
function distance(from: PixelPoint, to: PixelPoint): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

/**
 * The corner of `quad` nearest `point`, if one is within `within` pixels — the
 * hit test behind picking up a corner handle.
 *
 * Returns the INDEX rather than the point, because what the drag then edits is
 * the tuple's slot: moving "the top-right corner" has to keep meaning the
 * second entry even after the page has been turned and that corner is somewhere
 * else on screen.
 */
export function cornerNear(quad: PixelQuad, point: PixelPoint, within: number): 0 | 1 | 2 | 3 | null {
  let best: 0 | 1 | 2 | 3 | null = null;
  let bestDistance = within;
  for (const index of [0, 1, 2, 3] as const) {
    const away = distance(quad[index], point);
    if (away <= bestDistance) {
      best = index;
      bestDistance = away;
    }
  }
  return best;
}

/** The same quad with one corner moved — the drag's whole effect on the recipe. */
export function withCorner(quad: FractionQuad, index: 0 | 1 | 2 | 3, to: FractionPoint): FractionQuad {
  const moved: [FractionPoint, FractionPoint, FractionPoint, FractionPoint] = [
    quad[0],
    quad[1],
    quad[2],
    quad[3],
  ];
  moved[index] = to;
  return moved;
}
