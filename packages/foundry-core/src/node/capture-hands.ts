/**
 * capture-hands — the geometry checks a recipe is held to, and which pages were set by hand.
 */
import type { CapturePhoto, CapturePoint, CaptureQuad } from '../shared/types';
import { sameShape, WHOLE_FRAME } from '../shared/capture';
import { CaptureError } from './capture-paths';

export function fail(file: string, what: string): never {
  throw new CaptureError(`${file} is not a recipe this app can read: ${what}.`);
}

export function validPoint(value: unknown, file: string, where: string): CapturePoint {
  if (!Array.isArray(value) || value.length !== 2) fail(file, `${where} is not a pair`);
  const [x, y] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    fail(file, `${where} is not two finite numbers`);
  }
  // The same bounds `validQuad` gives its corners, for the same reason: the
  // unit is a fraction of the working copy, and outside [0,1] is off the
  // photograph.
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    fail(file, `${where} is outside the photograph (${x}, ${y}) — coordinates are fractions`);
  }
  return [x, y];
}

export function validQuad(value: unknown, file: string, where: string): CaptureQuad {
  if (!Array.isArray(value) || value.length !== 4) fail(file, `${where} is not four corners`);
  const corners = value.map((corner, index) => {
    if (!Array.isArray(corner) || corner.length !== 2) fail(file, `${where} corner ${index} is not a pair`);
    const [x, y] = corner as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      fail(file, `${where} corner ${index} is not two finite numbers`);
    }
    /*
     * FRACTIONS, AND THE BOUNDS ARE PART OF THE UNIT. Every coordinate in this
     * file is a fraction of the working copy's grid; a value outside [0,1] is
     * either pixels that took a wrong turn at the bridge or a corner dragged off
     * the photograph, and both produce black edges in a minted page rather than
     * an error anybody sees.
     */
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      fail(file, `${where} corner ${index} is outside the photograph (${x}, ${y}) — coordinates are fractions`);
    }
    return [x, y] as const;
  });
  return corners as unknown as CaptureQuad;
}

/**
 * Work out which pages were set by hand, for a recipe that never said.
 *
 * ── IT IS NOT A GUESS. NOTHING BUT A HAND COULD HAVE MOVED A CORNER ───────
 *
 * A page arrives at the WHOLE FRAME and nothing but a person changes that. A
 * crop stamped over the shoot copies `source.pages[index].quad` across
 * verbatim, so every page a stamp touched holds the IDENTICAL floats. That
 * leaves exactly three states a quad can be in, and only one of them is hands:
 *
 *   the whole frame                    nobody has touched this page
 *   the crop most of its shape share   a stamp put it there
 *   anything else                      A HAND DRAGGED IT
 *
 * ── THE FIRST VERSION ASKED THE SECOND QUESTION ONLY, AND MISSED A SHOOT ──
 *
 * It marked a page whose quad DIFFERED FROM THE MAJORITY, which quietly
 * assumes there is a stamp to differ from. Measured on the project Owen
 * actually has: 25 photographs, 25 DISTINCT QUADS, no two alike — he cropped
 * every page by hand, one at a time, and the largest disagreement between two
 * of them is a tenth of the frame. With no majority anywhere, nothing was
 * marked, and the first APPLY TO ALL of the editor that finally understands
 * hand-work would have erased all twenty-five without naming one of them.
 *
 * The whole frame is what the majority question was reaching for and could not
 * see: an untouched page has a KNOWN quad, so a page can be told from a stamp
 * even when there is no stamp in the project at all. The majority test stays
 * beside it, because a stamped crop is not the whole frame either.
 *
 * ── ONLY WHEN THE FILE HAS NOT SPOKEN, WHICH KEEPS IT A MIGRATION ────────
 *
 * The moment ANY page in the recipe carries the field, the file is one the
 * staged editor has written and every mark in it is a statement rather than
 * an absence. Deriving past that would let an inference overwrite a fact:
 * somebody who hand-sets a page back to exactly the global crop has still set
 * it by hand, and a rule reading only the geometry would quietly unmark it on
 * the next read. So this runs on the way in, like the `{x}` migration beside
 * it, and stops running the first time the file answers for itself.
 *
 * ── EXACT EQUALITY, PER PAGE SLOT, WITHIN ONE SHAPE ──────────────────────
 *
 * Exact, because these floats were copied rather than computed and a
 * tolerance would be inventing a question nobody asked. Per page SLOT,
 * because a stamp copies slot to slot — comparing the halves of split
 * spreads against each other would find the left halves in the majority and
 * mark every right half as hand-set. Within one shape, for the reason
 * apply-to-all skips: a landscape frame’s crop differing from a portrait
 * one’s says nothing about anybody’s hands.
 *
 * ── AND WHERE IT IS UNSURE IT OVER-MARKS ─────────────────────────────────
 *
 * A group with no single most-common quad is left alone entirely; a group
 * with several roughly equal crops marks everything outside the largest of
 * them, including pages a stamp did put there. THE TWO ERRORS ARE NOT
 * COMPARABLE: over-marking costs a named skip in a notice and one press of
 * the include-them override, and under-marking costs the evening of cropping
 * that the mark exists to protect.
 */
export function handsRead(photos: CapturePhoto[]): CapturePhoto[] {
  const spoken = photos.some((photo) => photo.pages.some((page) => page.byHand !== undefined));
  if (spoken) return photos;

  // Photographs of one shape, since a crop only travels between those.
  const groups: CapturePhoto[][] = [];
  for (const photo of photos) {
    const group = groups.find((held) => {
      const first = held[0];
      return first !== undefined && sameShape(first, photo);
    });
    if (group === undefined) groups.push([photo]);
    else group.push(photo);
  }

  const stamped = new Map<CapturePhoto, Map<number, string>>();
  for (const group of groups) {
    const slots = new Map<number, Map<string, number>>();
    for (const photo of group) {
      photo.pages.forEach((page, slot) => {
        const counts = slots.get(slot) ?? new Map<string, number>();
        const key = JSON.stringify(page.quad);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        slots.set(slot, counts);
      });
    }
    const majority = new Map<number, string>();
    for (const [slot, counts] of slots) {
      let best: string | null = null;
      let bestCount = 1;
      let tied = false;
      for (const [key, count] of counts) {
        if (count > bestCount) {
          best = key;
          bestCount = count;
          tied = false;
        } else if (count === bestCount && best !== null) {
          tied = true;
        }
      }
      // No crop shared by more than one page, or two sharing the lead: there
      // is no stamp to have differed from, so nothing here was set by hand
      // in any sense this can see.
      if (best !== null && !tied) majority.set(slot, best);
    }
    for (const photo of group) stamped.set(photo, majority);
  }

  const untouched = JSON.stringify(WHOLE_FRAME);
  return photos.map((photo) => {
    const majority = stamped.get(photo) ?? new Map<number, string>();
    return {
      ...photo,
      pages: photo.pages.map((page, slot) => {
        const quad = JSON.stringify(page.quad);
        // Nobody has touched this page, whether or not anything else here has
        // been stamped — which is the whole reason this question comes first.
        if (quad === untouched) return page;
        // A stamp put it here, and a stamp is not a hand.
        if (quad === majority.get(slot)) return page;
        return { ...page, byHand: true };
      }),
    };
  });
}
