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
 * because that is where a correction goes, and `displayed` is the snapshot when
 * the position stands on one, because that is what the pages draw. Its comment
 * says the rest out loud: resolving `file` to the snapshot would mean the next
 * strike anybody made while standing on a save silently rewrote that save.
 *
 * That leaves exactly one hole, and it is on this side of the boundary. The
 * block editor writes through `overlay.save`, which writes the LIVE file. So a
 * person standing on a save is being shown one set of corrections while every
 * gesture they make lands in another — they would be editing one thing and
 * looking at another, and the first they would know of it is a Generate that does
 * not contain the strike they just made. The fix is not a cleverer write path; it
 * is that THE EDITOR IS READ-ONLY WHERE THE TWO DIVERGE, and this function is the
 * one place that decides where that is.
 *
 * ── And what it is showing while it refuses ─────────────────────────────────
 *
 * The snapshot, not the live overlay. `OverlayLoad.frozen` carries the displayed
 * curation across to the renderer FOR DISPLAY — the whole point of clicking an
 * old save is to see the book as it was then, and an editor that drew the live
 * outlines over a frozen rendering was honest about being read-only and wrong
 * about what it was read-only ABOUT. That does not soften this gate; it sharpens
 * what it has to say, which is that what is on the page is the save and what a
 * correction would touch is somewhere else.
 *
 * ── Why it is `displayedCuration` and NOT `curationInEffect` ────────────────
 *
 * This gate is about DIVERGENCE — the pages saying one thing while a correction
 * would land in another — so the honest question is what the pages are showing,
 * and that is one function: `displayedCuration` (shared/ledger.ts). The lock is
 * derived from the display rather than spelled beside it, which is the coupling
 * this module was built on. Only the function it asks has changed.
 *
 * It used to ask `curationInEffect`, which is what a GENERATE is made with, on
 * the reasoning that the two must not drift. That was right about the coupling
 * and wrong about which pair is coupled. A translation made FROM a save resolves
 * through that walk to the save, so the editor went read-only one row below the
 * save and stayed read-only for every row below that — which made the gesture
 * the whole feature is for impossible: translate a curated book, and there is no
 * longer any way to strike a paragraph in it. What a translate row retained is a
 * bank of translated blocks. It froze nobody's corrections, so there is nothing
 * there for this gate to protect, and the pane on a translate row now draws the
 * LIVE corrections — which are the ones a strike would land in, so nothing
 * diverges and nothing is refused (docs/TRANSLATION-STEPS.md §4).
 *
 * THE DATA-LOSS STORY ABOVE IS UNTOUCHED BY THAT. It is not "the position is a
 * curate step" restated at a call site — it is the display rule asked, and the
 * display rule is what decides both what the pane draws and what this refuses.
 * The two literally cannot come apart: the same answer feeds `OverlayLoad.frozen`
 * and feeds this, so a snapshot is on the pages exactly when correcting is off.
 *
 * And a GENERATE from here is still made with `curationInEffect`, untouched. The
 * one place the pane and the Generate now differ — standing on a translation
 * with strikes nobody has committed — is not a divergence this gate can close,
 * because both files are honest about what they are: it is resolved by pressing
 * Save, and the save is a row.
 *
 * ── And why the sentence lives here rather than in the component ────────────
 *
 * Two surfaces say it — the strip across the pages and the hint in the Steps
 * accordion — and a person who reads one and then the other must not be told two
 * different things about why their app has stopped responding to a Delete key.
 * It also has to NAME THE WAY BACK, which is a fact about the ledger rather than
 * about a panel: the step to click is the nearest row above this save that edits
 * — usually the reading it was made under, and the translation when the save was
 * committed under one. See `liveStep`.
 */

import { ancestry, displayedCuration, positionOf } from './ledger';
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
 * A project where nobody has ever pressed Save has no `curate` step to stand on,
 * so every position gives null and nothing about this app's behaviour changes.
 * Standing on the reading with a save sitting beside it also gives null, which is
 * the point of the design rather than an edge case: pressing Save leaves you
 * holding your live corrections (`RETAINED_BESIDE_YOU`, shared/ledger.ts), and
 * the row it made is one you have to click to stand on. So is standing on a
 * translation, for `DISPLAYS_ITSELF`'s reason: a translation retained a bank of
 * translated blocks and froze nobody's corrections, so the pane there draws the
 * live ones and there is nothing to refuse.
 */
export function curationLock(ledger: ProjectLedger): CurationLock | null {
  const snapshot = displayedCuration(ledger);
  if (snapshot === null) return null;
  const back = liveStep(ledger, snapshot);
  const wayBack = back === null
    ? 'Step back to the reading in Steps to edit again.'
    : `Click “${back.label}” in Steps to stand on the live corrections again and edit.`;
  return {
    snapshot,
    back,
    why: `You are standing on “${snapshot.label}” — a copy of these corrections frozen at the moment `
      + 'it was saved, which nothing made afterwards is allowed to change. What is marked up on '
      + 'these pages is that save, and everything Foundry renders from here is made with it, so '
      + 'correcting is off: a strike made now would be written into your live corrections instead, '
      + `which are a different set of decisions from the ones you are looking at. ${wayBack}`,
  };
}

/** True when the editor must not write. The gate, with none of the words. */
export function editingIsHeld(ledger: ProjectLedger): boolean {
  return displayedCuration(ledger) !== null;
}

/**
 * The nearest row above this save that a person can edit on — the way out,
 * ASKED OF THE DISPLAY RULE rather than described a second time.
 *
 * ── Why it is not simply "the reading" ──────────────────────────────────────
 *
 * It used to walk to the nearest `read` or `import`, and while every row between
 * a save and the reading was frozen too, that was the same answer as this one.
 * It is not any more: a `translate` row shows the live corrections and edits
 * (`DISPLAYS_ITSELF`, shared/ledger.ts), so a save committed under a translation
 * has a live row one click above it, and naming the reading instead would send
 * somebody all the way out of the branch they are working in — off the
 * translation, back to the scan — to do a thing they can do where they are.
 *
 * So the sentence names the nearest row that is actually live, and it finds it by
 * asking the display question about each row on the way up rather than by
 * restating which actions are frozen. That restatement is exactly how a way out
 * comes to name a row that is itself read-only: two spellings of one rule, and
 * this is the copy nobody would think to update.
 *
 * NULL IS A SHAPE THIS APP DOES NOT PRODUCE — every chain begins at an import and
 * an import is live — and it is kept because the alternative to a way out named
 * badly is a person with an editor that has stopped working and no account of it.
 */
function liveStep(ledger: ProjectLedger, snapshot: LedgerStep): LedgerStep | null {
  const chain = ancestry(ledger, snapshot.id);
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const step = chain[at]!;
    if (displayedCuration({ ...ledger, position: step.id }) === null) return step;
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
