/**
 * The two questions the sheet's structure gestures ask of the FLOW, answered
 * without a DOM, a signal or a component around them.
 *
 * ── Why they are here and not in the pane ───────────────────────────────────
 *
 * Both of them are decisions about which rows sit beside which, and both of them
 * are the difference between a gesture that mints an honest op and one that mints
 * an op the replay will put in `missing`. A guard that cannot be exercised on its
 * own is a guard nobody checks, so these are plain functions over plain rows —
 * the pane calls them, and a script can too.
 *
 * ── THE SHELF IS NOT IN THE FLOW, which is the replay's own rule ────────────
 *
 * A shelved row sits in the file at its reading-order position wearing a sentence
 * about why it is out of the book (docs/BOOK-FILE.md §5), and the sheet does not
 * draw one at all. So both functions below step over them: two paragraphs with a
 * suppressed running head between them are two paragraphs the reader sees
 * touching, and a gesture that refused them would be refusing on the strength of
 * something invisible.
 */

import type { BookSeam } from '@shared/book';
import type { ReplayedRow } from '@shared/ops';

/** Two blocks in reading order, which is the order a join has to happen in. */
export interface FlowPair {
  /** The one nearer the front of the book. A merge keeps this one's name. */
  earlier: string;
  /** The one after it. A merge consumes this one. */
  later: string;
}

/**
 * The two ids in reading order when nothing in the flow stands between them, and
 * null otherwise.
 *
 * ── A NOTE BETWEEN THEM MEANS THEY ARE NOT NEIGHBOURS ───────────────────────
 *
 * The shelf is skipped and everything else counts, footnote rows included, and
 * that is deliberate rather than an oversight about how books are printed. A note
 * row IS in the document — the sheet draws it, the edition sets it at the foot of
 * the page — so two paragraphs with the page's apparatus between them are two
 * paragraphs with something between them. The replay would perform that merge
 * happily and the person would get a paragraph whose words come from either side
 * of a note they never looked at, which is why the honest place to refuse is
 * before the op is minted rather than after.
 *
 * The seam gesture is not held to this and does not go through here: a seam's two
 * halves are the two sides of a page turn, and the notes at the foot of the
 * earlier page sit between them by construction (`BookSeam`). The engine put that
 * pair in the header having read both pages; this function is for a pair a person
 * assembled by clicking, which is a claim nobody has checked.
 */
export function flowNeighbours(
  rows: readonly ReplayedRow[],
  one: string,
  other: string,
): FlowPair | null {
  if (one === other) return null;
  let seen: string | null = null;
  for (const row of rows) {
    if (row.shelf !== undefined) continue;
    if (seen !== null) {
      // The very next row in the flow, or somebody's paragraph is in the way.
      return row.id === one || row.id === other
        ? { earlier: seen, later: row.id }
        : null;
    }
    if (row.id === one || row.id === other) seen = row.id;
  }
  return null;
}

/**
 * The seams that can still be drawn: the block a turn opens with → the block it
 * ends the page before.
 *
 * KEYED BY `before` BECAUSE THAT IS WHERE THE GHOST HANGS. `BookSeam.before` is
 * the row the page AFTER the turn opens with, so the `··· join ···` control sits
 * above it and the value here is the block it would be joined onto — which is the
 * op's `into`, the earlier of the two, the one that keeps its name.
 *
 * ── A seam draws only while both of its blocks are in the flow ──────────────
 *
 * The header's list is a fact about the READING and the ops restructure the book
 * over the top of it, so a seam whose halves a chain has already joined, split or
 * consumed is an offer nobody can accept: clicking it would mint a merge naming a
 * block this book no longer holds, and the replay would file it in `missing` where
 * no gesture can clear it. This is the simplest rule that is honest — both blocks
 * present, and the ghost goes when either is not — and it does not try to be
 * clever about the halves of a split, which are two new names the reading never
 * knew and which the person can always join by hand.
 */
export function seamJoins(
  rows: readonly ReplayedRow[],
  seams: readonly BookSeam[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (seams.length === 0) return out;
  const inFlow = new Set<string>();
  for (const row of rows) {
    if (row.shelf === undefined) inFlow.add(row.id);
  }
  for (const seam of seams) {
    if (!inFlow.has(seam.before) || !inFlow.has(seam.after)) continue;
    out.set(seam.before, seam.after);
  }
  return out;
}
