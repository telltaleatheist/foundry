/**
 * What standing on a frozen save means for the block editor — one answer, in
 * words, for the two surfaces that have to obey it.
 *
 * ── The data-loss bug this exists to prevent ────────────────────────────────
 *
 * A curation step is a COPY OF THE CORRECTIONS THAT NEVER CHANGES AGAIN. That is
 * the whole of what makes it worth keeping and the whole of what makes a step
 * able to point at it: click the row, and the book comes back as it was when you
 * saved it. `locateOverlay` protects that property on the disk side by keeping
 * two paths apart rather than resolving one — `file` is always the LIVE overlay,
 * because that is where a correction goes, and `rendering` is the snapshot when
 * the position stands on one, because that is what a Generate reads. Its comment
 * says the rest out loud: resolving `file` to the snapshot would mean the next
 * strike anybody made while standing on a save silently rewrote that save.
 *
 * That leaves exactly one hole, and it is on this side of the boundary. The
 * block editor writes through `overlay.save`, which writes the LIVE file. So a
 * person standing on a save is being shown a book rendered from a frozen
 * snapshot while every gesture they make lands somewhere else — they would be
 * editing one thing and looking at another, and the first they would know of it
 * is a Generate that does not contain the strike they just made. The fix is not
 * a cleverer write path; it is that THE EDITOR IS READ-ONLY WHERE THE TWO
 * DIVERGE, and this function is the one place that decides where that is.
 *
 * ── Why it is `curationInEffect` and not `position.action === 'curate'` ─────
 *
 * The tempting test is "am I standing on a save". It is very nearly right and it
 * is wrong in one real case: a translation made FROM a save is a position whose
 * renderings are still made with that save (`renderingOverlay` walks up through
 * `curationInEffect` to find one), so the editor there would show live outlines
 * over a book being rendered frozen — the same divergence, one row further down.
 * Asking the question main asks means the two sides cannot drift: whatever
 * decides which overlay reaches the engine's command line is what decides
 * whether editing is on.
 *
 * ── And why the sentence lives here rather than in the component ────────────
 *
 * Two surfaces say it — the strip across the pages and the hint in the Steps
 * accordion — and a person who reads one and then the other must not be told two
 * different things about why their app has stopped responding to a Delete key.
 * It also has to NAME THE WAY BACK, which is a fact about the ledger rather than
 * about a panel: the step to click is the reading this save was made under,
 * because the reading is where live editing happens.
 */

import { ancestry, curationInEffect, positionOf } from './ledger';
import type { LedgerStep, ProjectLedger } from './types';

/** Why the block editor is read-only here, and how to get out of it. */
export interface CurationLock {
  /** The frozen save every rendering at this position is made with. */
  snapshot: LedgerStep;
  /**
   * The step to stand on to edit again, or null for a ledger with no reading in
   * the save's ancestry at all.
   *
   * NULL IS DRAWN AS A SENTENCE WITHOUT A NAME rather than as no sentence. A
   * project whose save hangs straight off the import is a shape this app does not
   * produce today, and an explanation that silently lost its way-out because of
   * one would leave somebody with an editor that has stopped working and no
   * account of it.
   */
  back: LedgerStep | null;
  /** The whole explanation, in the app's voice. Never a filename. */
  why: string;
}

/**
 * The lock, or null — and NULL IS THE ORDINARY ANSWER.
 *
 * A project where nobody has ever pressed Save has no `curate` step for any
 * position to resolve to, so every position gives null and nothing about this
 * app's behaviour changes. Standing on the reading with a save sitting beside it
 * also gives null, which is the point of the design rather than an edge case: the
 * reading step is where live editing happens, and a save made from it is a
 * SIBLING of where the user is standing rather than an ancestor.
 */
export function curationLock(ledger: ProjectLedger): CurationLock | null {
  const snapshot = curationInEffect(ledger);
  if (snapshot === null) return null;
  const back = liveStep(ledger, snapshot);
  const wayBack = back === null
    ? 'Step back to the reading in Steps to edit again.'
    : `Click “${back.label}” in Steps to stand on the live corrections again and edit.`;
  return {
    snapshot,
    back,
    why: `You are standing on “${snapshot.label}” — a copy of these corrections frozen at the moment `
      + 'it was saved, which nothing made afterwards is allowed to change. Everything Foundry renders '
      + 'from here is made with that save, so correcting is off: a strike made now would be written '
      + 'into the live corrections instead, and you would be editing one book while looking at '
      + `another. ${wayBack}`,
  };
}

/** True when the editor must not write. The gate, with none of the words. */
export function editingIsHeld(ledger: ProjectLedger): boolean {
  return curationInEffect(ledger) !== null;
}

/**
 * The step where live editing happens — the reading this save was made under.
 *
 * WALKED FROM THE SNAPSHOT AND NOT FROM THE POSITION, and the difference shows up
 * in exactly the case this whole module exists for: standing on a translation
 * made from a save, the position's own ancestry and the save's are the same chain
 * as far as the reading, but the snapshot is the thing that is being obeyed and
 * the reading it belongs to is the honest place to send somebody back to.
 *
 * The import is the answer for a save with no reading above it — a shape this app
 * does not produce, kept because a project adopted out of the old flat workspace
 * has an origin and may have nothing else, and an explanation that named no row
 * at all would be worse than one that named the first.
 */
function liveStep(ledger: ProjectLedger, snapshot: LedgerStep): LedgerStep | null {
  const chain = ancestry(ledger, snapshot.id);
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const step = chain[at]!;
    if (step.action === 'read' || step.action === 'import') return step;
  }
  return null;
}

/**
 * The step a person is standing on, said in one line — for a surface that wants
 * to name it without reaching for the ledger's internals.
 *
 * `positionOf` re-exported through this module rather than imported twice is the
 * kind of thing that reads as tidying and is not: the renderer must never derive
 * the ORDER or the "from …" annotation for itself (main composes those), and
 * keeping the one ledger question it is allowed to ask in the same file as the
 * lock makes the boundary visible at the import line.
 */
export function standingOn(ledger: ProjectLedger): LedgerStep | null {
  return positionOf(ledger);
}
