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
import type {
  CapturePoint,
  CaptureQuad,
  CaptureRecipe,
  CaptureSplit,
  PixelQuad,
} from './types';

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
 * The pages a mint would produce, in the order it would produce them.
 *
 * ── THE THIRD TIME THIS RULE HAS HAD MORE THAN ONE BODY ─────────────────────
 *
 * "Walk `order`, skip the struck ones" was written three times independently:
 * `mintBegin` in electron/capture.ts, the light table footer's `mintable`, and
 * the editor readout that tells somebody they are on pages 9-10 of 54. All
 * three agreed, because all three were written from the same sentence — which
 * is exactly what `outputSizeFor` and `sameShape` did before each of them was
 * moved here, and two of these were thirty lines apart in one file.
 *
 * THE NUMBERS ARE THE POINT. The footer promises a page count, the readout
 * promises a position in a book of that many, and the mint decides what the
 * book actually is. A person crops for an hour, reads "of 54", and counts the
 * PDF: any drift between those three is a number that lied to somebody about
 * work they had already done.
 *
 * ── WHY THEY CANNOT DISAGREE TODAY, WHICH IS NOT AN ACCIDENT ────────────────
 *
 * An id in `order` naming no page would be counted differently by each of them
 * — the renderer skips it, the mint throws. That state cannot reach disk
 * because `writeRecipe`'s validator refuses a recipe whose order and pages are
 * not the same set. This function is where that guarantee is spent; if the
 * validator is ever relaxed, these numbers become able to differ again.
 */
export function mintedPageIds(recipe: CaptureRecipe): string[] {
  const struck = new Set<string>();
  const known = new Set<string>();
  for (const photo of recipe.photos) {
    for (const page of photo.pages) {
      known.add(page.id);
      if (page.struck) struck.add(page.id);
    }
  }
  return recipe.order.filter((id) => known.has(id) && !struck.has(id));
}

/**
 * A recipe with no photographs in it yet.
 *
 * IN `shared/` FOR THE SAME REASON THE PATH IS. Two electron modules write
 * this file — `projects.ts` when a capture project is created, `capture.ts`
 * every time one is edited — and they cannot import each other (capture.ts
 * already depends on projects.ts for the manifest). A second spelling of the
 * empty recipe would be a second answer to "what does a new project hold",
 * free to drift the day a field is added.
 */
export function emptyRecipe(): CaptureRecipe {
  return { version: 1, photos: [], order: [] };
}

/**
 * The bytes a recipe is written as — indented, and ending in a newline.
 *
 * ONE SPELLING FOR FOUR WRITERS (create, save, intake, and the empty file a
 * creation lays down). They all spelled the identical `JSON.stringify` call,
 * which is how one of them eventually acquires a different indent and every
 * save after it rewrites the whole file as a diff nobody asked for.
 */
export function recipeBytes(recipe: CaptureRecipe): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(recipe, null, 2)}\n`);
}

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

// ─────────────────────────────────────────────────────────────────────────────
// The chord — every rule about where a split cuts, in one place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole photograph as a page, before anybody has dragged a corner.
 *
 * THE THIRD BODY OF THIS ONE WOULD HAVE BEEN WRITTEN HERE. Intake spells it
 * (`WHOLE_FRAME` in electron/capture.ts), the editor spells it (`wholeFrame()`),
 * and `joinedQuad` below needs an answer for "no quads at all" — so it goes
 * where the other shared rules went rather than becoming a third opinion about
 * what an uncropped page is. The corner order is the tuple order everywhere:
 * top-left, top-right, bottom-right, bottom-left OF THE OUTPUT PAGE.
 */
export const WHOLE_FRAME: CaptureQuad = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Which edge of a quad, in tuple order: 0 top, 1 right, 2 bottom, 3 left. */
export type QuadEdge = 0 | 1 | 2 | 3;

/** One endpoint of a split, put back onto the page it cuts. */
export interface SplitSeat {
  readonly edge: QuadEdge;
  /** How far along that edge, 0..1, from its first corner to its second. */
  readonly at: number;
  /** The endpoint moved onto the edge — where the handle should be drawn. */
  readonly point: CapturePoint;
}

/**
 * A split resolved against the page it cuts.
 *
 * `halves` says what the cut MAKES, not which way the line looks on a screen:
 * a spread photographed on its side is turned before it is split, and
 * 'stacked' means the two pages end up one above the other in the picture while
 * still reading in order. The words describe the page, which is the thing that
 * has an up.
 */
export interface SplitCut {
  readonly a: SplitSeat;
  readonly b: SplitSeat;
  readonly halves: 'side-by-side' | 'stacked';
}

/** How far along a segment a point falls, and how far off it — both clamped. */
function seatOn(from: CapturePoint, to: CapturePoint, point: CapturePoint): { at: number; away: number } {
  const run = [to[0] - from[0], to[1] - from[1]] as const;
  const span = run[0] * run[0] + run[1] * run[1];
  const at = span === 0
    ? 0
    : Math.min(1, Math.max(0, ((point[0] - from[0]) * run[0] + (point[1] - from[1]) * run[1]) / span));
  return { at, away: Math.hypot(point[0] - (from[0] + run[0] * at), point[1] - (from[1] + run[1] * at)) };
}

/** The two corners an edge runs between. A switch, so it is total. */
const EDGES = [0, 1, 2, 3] as const;

function cornersOf(edge: QuadEdge): readonly [0 | 1 | 2 | 3, 0 | 1 | 2 | 3] {
  switch (edge) {
    case 0: return [0, 1];
    case 1: return [1, 2];
    case 2: return [2, 3];
    default: return [3, 0];
  }
}

/** The point a given way along an edge, 0..1 from its first corner. */
function pointAt(quad: CaptureQuad, edge: QuadEdge, at: number): CapturePoint {
  const [from, to] = cornersOf(edge);
  const [ax, ay] = quad[from];
  const [bx, by] = quad[to];
  return [ax + (bx - ax) * at, ay + (by - ay) * at];
}

function alongEdge(quad: CaptureQuad, edge: QuadEdge, point: CapturePoint): SplitSeat {
  const [from, to] = cornersOf(edge);
  const { at } = seatOn(quad[from], quad[to], point);
  return { edge, at, point: pointAt(quad, edge, at) };
}

function nearestEdge(quad: CaptureQuad, point: CapturePoint): SplitSeat {
  let best: SplitSeat = alongEdge(quad, 0, point);
  let bestAway = Number.POSITIVE_INFINITY;
  for (const edge of EDGES) {
    const seat = alongEdge(quad, edge, point);
    const away = Math.hypot(point[0] - seat.point[0], point[1] - seat.point[1]);
    // Strictly nearer, so a point sitting exactly on a corner takes the earlier
    // edge rather than depending on which way the loop happened to run.
    if (away < bestAway) {
      bestAway = away;
      best = seat;
    }
  }
  return best;
}

/**
 * Put a split back on the page it cuts — RE-SEATED, NOT TRUSTED.
 *
 * ── Why the stored endpoints are not simply used ──────────────────────────
 *
 * A split is stored in working-copy fractions (see `CaptureSplit`), so it is a
 * memory of where two handles were let go, not a promise about the page as it
 * stands now. Drag a crop corner afterwards and the endpoints stay where they
 * were, floating off the edges they were riding. Cutting from those points
 * would produce halves that are not halves of anything: corners outside the
 * crop, black wedges in a minted page.
 *
 * So each endpoint is moved onto the edge nearest it and the cut is taken from
 * there. A split nobody has disturbed seats exactly where it already was, at a
 * cost of eight projections; a stale one is corrected in the only direction
 * that has a defensible answer.
 *
 * ── null means ADJACENT, and adjacent means there is nothing to return ─────
 *
 * Endpoints on opposite edges cut a quad into two quads. Endpoints on adjacent
 * edges cut a CORNER off — a triangle and a pentagon — and the mint can print
 * neither, since rectifying maps four corners onto a rectangle and has no other
 * shape to offer. There is no nearest sensible cut to fall back to, so this
 * refuses and the caller decides what that means: the validator refuses the
 * recipe, the editor leaves the handle where a person can see it is wrong.
 *
 * NOTHING A DRAG PRODUCES CAN LAND HERE. `seatSplit` builds every segment the
 * pointer makes and builds it opposite by construction, so null means a
 * hand-edited file — the same thing a refusal from `validQuad` means, and not
 * "the handle got there by dragging". That distinction is the difference between
 * a refusal a person can act on and a gutter that draws fine and will not save.
 */
export function cutOf(quad: CaptureQuad, split: CaptureSplit): SplitCut | null {
  const a = nearestEdge(quad, split.a);
  const b = nearestEdge(quad, split.b);
  if ((a.edge + 2) % 4 !== b.edge) return null;
  return { a, b, halves: a.edge % 2 === 0 ? 'side-by-side' : 'stacked' };
}

/**
 * The two pages a split cuts a page into, or null if it cuts no two pages.
 *
 * ── THE HALF HOLDING THE TOP-LEFT CORNER COMES FIRST ──────────────────────
 *
 * Which is "left then right" for every cut running from the top edge to the
 * bottom one, and the right answer for a cut across a spread photographed on
 * its side, where the halves are above and below rather than beside. It
 * consults no orientation field because there is none to consult: the corner
 * order IS the orientation, so turning the photograph carries the top-left
 * corner with it and the halves re-order themselves into reading order.
 *
 * Both halves come back in the same corner order as every other quad, so
 * either can be turned, cropped or minted without knowing it was ever half of
 * anything.
 */
export function halvesOf(quad: CaptureQuad, split: CaptureSplit): readonly [CaptureQuad, CaptureQuad] | null {
  const cut = cutOf(quad, split);
  if (cut === null) return null;
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const { a, b } = cut;
  if (cut.halves === 'side-by-side') {
    const top = a.edge === 0 ? a.point : b.point;
    const bottom = a.edge === 0 ? b.point : a.point;
    return [
      [topLeft, top, bottom, bottomLeft],
      [top, topRight, bottomRight, bottom],
    ];
  }
  const right = a.edge === 1 ? a.point : b.point;
  const left = a.edge === 1 ? b.point : a.point;
  return [
    [topLeft, topRight, right, left],
    [left, right, bottomRight, bottomLeft],
  ];
}

/**
 * Move one end of a split to where the pointer is — THE ONLY WAY A DRAG MAY
 * BUILD A SEGMENT.
 *
 * ── It cannot produce a split `halvesOf` refuses, and that is the point ────
 *
 * The end being dragged is projected onto the edge OPPOSITE the one its partner
 * rides, and the partner is re-seated on its own edge on the way past. Opposite
 * by construction, so the invariant is enforced where the gesture happens
 * rather than restated in the component that draws it. Two statements of one
 * rule would agree until an endpoint reached a corner.
 *
 * THE FAILURE THIS FORECLOSES HAS ALREADY HAPPENED ONCE IN THIS FEATURE, in the
 * shape a corner drag took before the editor clamped it: the surface let
 * somebody express a state the validator refused, so the crop looked fine and
 * the recipe stopped saving, and the light table went on looking alive for the
 * rest of the session. A gutter that draws and will not save is the same bug
 * with a different handle.
 *
 * ── AND IT LEAVES A PAGE ON EITHER SIDE ───────────────────────────────────
 *
 * The end is also held back from any position that would cut a page smaller
 * than `SLIVER_FLOOR` of the sheet. THE CORNER IS NOT THE SLIVER, which is the
 * part that makes this arithmetic rather than a clamp: on a leaning cut an end
 * driven all the way onto a corner still leaves a tenth of the sheet beside it
 * — a whole page — while both ends crowding the same side makes a strip with
 * neither of them near a corner. So it is a question about the AREA that comes
 * out, and the old rule about how near an end may get to a corner was only ever
 * right for cuts parallel to the sides.
 *
 * Only the DRAG is held. A `{ x }` being migrated and a fraction from the Split
 * button pass through `splitFromFraction` untouched: reading a file must return
 * what the file says, and a stored sliver is a fact about somebody’s project
 * rather than a gesture to intercept.
 */
/**
 * The least of the sheet a page may be left with, as a share of its area.
 *
 * NOT A NEW LINE. The clamp that shipped before the segment held the gutter 2%
 * off either end of the edge it ran along, and for a cut parallel to the sides
 * — the only cut that existed — 2% ALONG THE EDGE IS 2% OF THE AREA. This is
 * the same rule restated in the measure that survives a lean.
 *
 * IT IS A FLOOR AGAINST DEGENERACY, NOT AN OPINION ABOUT HOW A BOOK DIVIDES,
 * which is the argument for keeping it low. There is no override on it, so a
 * tasteful 5% would silently refuse a legitimate unequal cut — a narrow column,
 * an inset, a foldout leaf — and a person would experience it as the handle
 * sticking for no reason they can see. The judgement about whether a cut looks
 * right already has a surface: the preview draws each half at the size it will
 * mint, through the same shader, which is a better place for taste than a clamp.
 */
const SLIVER_FLOOR = 0.02;

/** A quad’s area, by the shoelace, written out so nothing is indexed. */
function areaOf(quad: CaptureQuad): number {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const cross = (from: CapturePoint, to: CapturePoint): number => from[0] * to[1] - to[0] * from[1];
  return Math.abs(
    cross(topLeft, topRight) + cross(topRight, bottomRight)
    + cross(bottomRight, bottomLeft) + cross(bottomLeft, topLeft),
  ) / 2;
}

/**
 * The nearest place along this edge that still leaves a page on either side.
 *
 * ── The solve is exact, because the area really is a straight line in `at` ──
 *
 * Moving one end of the cut moves EXACTLY ONE VERTEX of each half; the shoelace
 * is linear in every vertex coordinate; and the seat is linear in `at`. So each
 * half’s share of the sheet is AFFINE in `at` for every quad — not just for a
 * photographed trapezoid — and the two ends of the line are enough to invert it.
 * No search, no tolerance, and the lean is already inside the arithmetic because
 * the other end is part of it.
 *
 * ── THE GRADIENT IS PER-QUAD AND MUST NEVER BE CARRIED ────────────────────
 *
 * The line is straight for every quad; how steeply it climbs depends on the
 * quad’s shape and on where the fixed end sits — measured across five quads it
 * runs from 0.41 to 0.51 per unit. So this evaluates BOTH ENDS FOR THE QUAD IN
 * HAND every time. A constant lifted from one shoot would be right on that
 * shoot and wrong on the next book by a fifth, which is exactly what `{x}` was:
 * correct for the case it was measured on.
 *
 * ── Where no position works at all ────────────────────────────────────────
 *
 * If the other end is itself crowding a corner, no place for this one leaves
 * two pages. Refusing to move would read as a dead handle, so it gives the
 * evenest cut available instead — the position where the halves come nearest to
 * equal — which is both the most helpful answer and the one a person can see is
 * not what they asked for.
 */
function offTheEdgeOfNothing(quad: CaptureQuad, partner: CapturePoint, edge: QuadEdge, wanted: number): number {
  const sheet = areaOf(quad);
  if (sheet <= 0) return wanted;
  const shareAt = (at: number): number => {
    const halves = halvesOf(quad, { a: pointAt(quad, edge, at), b: partner });
    return halves === null ? 0.5 : areaOf(halves[0]) / sheet;
  };
  const low = shareAt(0);
  const slope = shareAt(1) - low;
  // Moving this end does not change how the sheet divides, so there is nothing
  // to solve and nothing this clamp could improve.
  if (Math.abs(slope) < 1e-12) return wanted;
  const seatFor = (share: number): number => (share - low) / slope;
  const first = seatFor(SLIVER_FLOOR);
  const second = seatFor(1 - SLIVER_FLOOR);
  const from = Math.max(0, Math.min(first, second));
  const to = Math.min(1, Math.max(first, second));
  if (from > to) return Math.min(1, Math.max(0, seatFor(0.5)));
  return Math.min(to, Math.max(from, wanted));
}

export function seatSplit(quad: CaptureQuad, split: CaptureSplit, which: 'a' | 'b', to: CapturePoint): CaptureSplit {
  const partner = nearestEdge(quad, which === 'a' ? split.b : split.a);
  const edge = ((partner.edge + 2) % 4) as QuadEdge;
  const asked = alongEdge(quad, edge, to);
  const moved = pointAt(quad, edge, offTheEdgeOfNothing(quad, partner.point, edge, asked.at));
  return which === 'a'
    ? { a: moved, b: partner.point }
    : { a: partner.point, b: moved };
}

/**
 * The segment an old `{ x }` split always meant: across the page at that
 * fraction, from the top edge to the bottom one.
 *
 * ONE BODY FOR TWO CALLERS, WHICH IS WHY IT IS HERE rather than in either. The
 * {x} migration needs it to read every recipe written before Wave 21, and the
 * editor needs it for the Split button pressed with no gutter placed — which
 * still has to produce the middle. Written twice, "the vertical segment {x}
 * always meant" would have two bodies on the day it was defined.
 *
 * The fraction was measured ALONG THE QUAD, never across the photograph, so
 * this reads it against the page it was cutting. That is also why a migration
 * cannot be done by rewriting numbers in a file: it needs the quad in hand.
 */
export function splitFromFraction(quad: CaptureQuad, at: number): CaptureSplit {
  const cut = Math.min(1, Math.max(0, at));
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const along = (from: CapturePoint, to: CapturePoint): CapturePoint => [
    from[0] + (to[0] - from[0]) * cut,
    from[1] + (to[1] - from[1]) * cut,
  ];
  return { a: along(topLeft, topRight), b: along(bottomLeft, bottomRight) };
}

/**
 * The uncut sheet two halves were cut from — the one page a split is a split of.
 *
 * ── Why it takes the split, when it only ever reads the outer corners ──────
 *
 * Reassembling a SIDE-BY-SIDE pair means taking the first half’s left corners
 * and the second’s right ones. Do that to a STACKED pair and the corners it
 * reaches for are on the CUT edge instead of the outside, and what comes back
 * is the sheet with two opposite corners replaced by the two cut points.
 *
 * That result is not a shape anything can detect. Measured on a realistic
 * trapezoid: it is SIMPLE AND CONVEX — no self-intersection to test for — and
 * its area is EXACTLY HALF the sheet’s at every cut position, 0.3536 against
 * 0.7073 at a cut of 0.5 and the same number at 0.3, so an "the area changed"
 * guard passes too. A plausible, printable page of the wrong half of the sheet:
 * in bounds, wrong, and invisible all the way into the PDF, which is the exact
 * class of defect the schema’s own docblock warns about for copied quads.
 *
 * So it cannot be a total function with a sanity check bolted on. It has to
 * KNOW, and the split is the only thing that does.
 *
 * ── It reads the segment’s DIRECTION and never its position ───────────────
 *
 * Which is a narrower read than it looks, and the reason re-seating is not
 * quietly abandoned here: A STALE SEGMENT’S POSITION GOES STALE, ITS DIRECTION
 * DOES NOT. Dragging a crop corner slides the endpoints along the edges they
 * ride; it does not move an endpoint from the top edge to the left one, and it
 * does not turn the cut a quarter. So the segment is asked which of the first
 * half’s two candidate cut edges it lies along — a binary, from a direction —
 * and never asked where anything is.
 *
 * ── With no split at all, the halves are asked instead ────────────────────
 *
 * Two quads and no split line is legal: somebody cropped both halves by hand
 * (the validator says so explicitly). There is no fact to read then, so the
 * two readings are measured — halves of one cut share their cut edge — and the
 * closer one wins. It is an inference, which is why it is the fallback and not
 * the rule.
 *
 * THIS IS ON THE WRITE PATH. `setSplit` derives both half-quads from this and
 * saves them, so a wrong answer here is not a handle in the wrong place: it is
 * two wrong pages in recipe.json and in the PDF minted from it.
 */
export function joinedQuad(quads: readonly CaptureQuad[], split: CaptureSplit | null): CaptureQuad {
  const first = quads[0];
  if (first === undefined) return WHOLE_FRAME;
  const second = quads[1];
  if (second === undefined) return first;
  const sideBySide: CaptureQuad = [first[0], second[1], second[2], first[3]];
  const stacked: CaptureQuad = [first[0], first[1], second[2], second[3]];
  if (split !== null) {
    // The cut edge of the first half is its edge 1 when the halves are beside
    // each other and its edge 2 when they are stacked; the segment lies along
    // whichever one it is, however far the crop has been dragged since.
    const along = alignment(split, first[1], first[2]);
    const across = alignment(split, first[2], first[3]);
    return along >= across ? sideBySide : stacked;
  }
  const apart = (from: CapturePoint, to: CapturePoint): number => Math.hypot(to[0] - from[0], to[1] - from[1]);
  const asSideBySide = apart(first[1], second[0]) + apart(first[2], second[3]);
  const asStacked = apart(first[3], second[0]) + apart(first[2], second[1]);
  return asStacked < asSideBySide ? stacked : sideBySide;
}

/** How parallel a split is to an edge, 0..1 — 1 is along it, 0 is across it. */
function alignment(split: CaptureSplit, from: CapturePoint, to: CapturePoint): number {
  const cut = [split.b[0] - split.a[0], split.b[1] - split.a[1]] as const;
  const edge = [to[0] - from[0], to[1] - from[1]] as const;
  const spans = Math.hypot(cut[0], cut[1]) * Math.hypot(edge[0], edge[1]);
  if (spans === 0) return 0;
  return Math.abs(cut[0] * edge[0] + cut[1] * edge[1]) / spans;
}
