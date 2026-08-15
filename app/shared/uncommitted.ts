/**
 * Corrections this book has no save of — the one fact the closing question is
 * about, worked out in one place so that the sentence it produces cannot lie.
 *
 * ── The obvious wording is false, and that is why this module exists ────────
 *
 * "You have unsaved changes that will be lost." Every editor says it and here it
 * would be a lie twice over. The block editor HAS NO UNSAVED STATE: every strike,
 * every reclassification, every chapter edit is written whole and atomically into
 * the live overlay the instant the gesture happens (`saveOverlayFile`), so there
 * is nothing sitting in memory waiting to be rescued and nothing that closing can
 * discard. Open the book tomorrow and all of it is exactly where it was left. A
 * dialog claiming otherwise would be teaching people to distrust the next warning
 * this app gives them, which is the one that matters.
 *
 * What a person can genuinely lack is a RESTORE POINT: a curation step they could
 * step back to. That is the thing at stake, and it is at stake for a reason that
 * has nothing to do with files. Foundry's step-by-step undo is session-scoped —
 * it starts fresh every time a document is opened (docs/NEXT-WORK.md §6) — so
 * closing the book is the moment "undoable" quietly becomes "permanent". The
 * corrections survive; the ability to walk back through them does not, and a save
 * is the only thing that replaces it.
 *
 * So the question this module answers is not "is there unwritten work" — there
 * never is. It is: DOES THE LIVE CURATION SAY ANYTHING THAT NO SAVE OF THIS BOOK
 * HOLDS? If it does not, there is nothing to ask about and nothing is asked.
 *
 * ── Why "nothing to ask" is the case worth getting right ────────────────────
 *
 * A dialog that appears when there is nothing at stake is worse than no dialog at
 * all, because it is answered without being read — and the day it appears about
 * something real it is dismissed with the same reflex. Two shapes have to come
 * back null and both of them are ordinary:
 *
 *   A BOOK NOBODY HAS CORRECTED. No amendments, no chapter list; there is no
 *   state here worth a restore point and never was.
 *
 *   A BOOK WHOSE CORRECTIONS ARE ALREADY A SAVE. Somebody pressed Save and then
 *   closed, which is exactly the behaviour this whole feature is trying to
 *   encourage, and interrupting it would be the app punishing the gesture it
 *   asked for. The comparison is by CONTENT rather than by "has anything happened
 *   since" for that reason: a strike made and then taken back leaves the book in
 *   the state the save already holds, and a change counter would call that
 *   uncommitted work.
 *
 * It is also why STANDING ON A FROZEN SAVE needs no rule of its own. The editor
 * is read-only there (`curation-lock.ts`), so nothing new can have been decided
 * while the user was standing there, and the ordinary way to arrive is to press
 * Save and click the row it made — at which point the live overlay is byte for
 * byte the snapshot beside it and the comparison below answers null on its own.
 *
 * ── Everything here is pure, for shared/ledger.ts's reason ──────────────────
 *
 * No `fs`, no clock, no `electron`. This is the code that decides whether a
 * person is interrupted on their way out of a book, which makes it the code most
 * worth covering with tests — and there is no component-test harness in this app,
 * so a decision that lived in a service or a dialog handler would be a decision
 * nothing could assert. Main reads the two files; this says what they mean.
 */

import { ancestry, positionOf } from './ledger';
import { decisionsOf, type CurationContent, type OverlayChapter, type OverlayDecision } from './overlay';
import type { LedgerStep, ProjectLedger, UncommittedCuration } from './types';

/** A frozen save, as this module needs it: what it holds, and what it is called. */
export interface SavedCuration {
  /** The step's own label — "Applied changes (23)". Never a filename. */
  label: string;
  content: CurationContent;
}

/**
 * The save the live corrections are measured against, or null when this book has
 * none that could serve.
 *
 * ── Why this is not `curationInEffect` ──────────────────────────────────────
 *
 * The tempting answer is "the newest curation on the position's ancestry", and it
 * is wrong in the state every curator spends their entire session in. A COMMIT
 * DOES NOT MOVE THE POINTER (`RETAINED_BESIDE_YOU`, shared/ledger.ts) — a save
 * retains what you have and leaves you holding it — so a person standing on the
 * reading with three saves behind them has three saves that are SIBLINGS of where
 * they stand and no curation on their ancestry at all. Asked that way, the app
 * would tell somebody who has just pressed Save that they have never saved.
 *
 * So the walk goes the other way. The position's ancestry is used only to find
 * the step where live editing happens — the reading these block numbers are about
 * — and the answer is the newest save made under it. That is the row a person
 * would click to come back, which is exactly what a restore point is.
 *
 * STALE SAVES ARE NOT RESTORE POINTS. A save whose reading was replaced under it
 * names blocks by `(page, order)` pairs that mean different blocks now (see
 * `ProjectReading`); it is kept, it is listed, and it is not a state this book can
 * be returned to. Offering it as one would be the app promising a way back to a
 * book that no longer exists.
 *
 * NEWEST BY THE ARRAY'S ORDER, which IS the chronology — `parseLedger` refuses a
 * ledger whose rows run backwards and `appendStep` cannot produce one — so the
 * last match is the newest without a comparator and without depending on two
 * saves stamped in one millisecond sorting the same way twice.
 */
export function restorePointOf(ledger: ProjectLedger): LedgerStep | null {
  const standing = positionOf(ledger);
  if (standing === null) return null;
  const root = liveRoot(ledger, standing);
  if (root === null) return null;
  let newest: LedgerStep | null = null;
  for (const step of ledger.steps) {
    if (step.action !== 'curate' || step.stale === true) continue;
    if (!ancestry(ledger, step.id).some((forebear) => forebear.id === root.id)) continue;
    newest = step;
  }
  return newest;
}

/**
 * The step the live overlay belongs to — the reading whose blocks these
 * corrections name, or the import for a project that has never been read.
 *
 * The same walk `curation-lock.ts` does from a snapshot, done here from the
 * position, and for the same reason in both places: a curation is only ever about
 * one reading, and a save made under a different one is about somebody else's
 * block numbers.
 */
function liveRoot(ledger: ProjectLedger, standing: LedgerStep): LedgerStep | null {
  const chain = ancestry(ledger, standing.id);
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const step = chain[at]!;
    if (step.action === 'read' || step.action === 'import') return step;
  }
  return null;
}

/**
 * What this book holds that no save does — or null, which is the ordinary answer
 * and the one that asks nothing.
 *
 * ── The count is a DIFFERENCE, not a total ──────────────────────────────────
 *
 * "You have 23 corrections" is true of a book that was saved with all 23 of them
 * and is the wrong thing to say about it. What a person needs to know before they
 * close is how far the book has drifted from the last state they can get back to,
 * so the number is the blocks that stand differently now — corrected since the
 * save, corrected differently, or corrected then put back. A block put back is a
 * decision as much as a strike is, and a comparison that only counted additions
 * would call an afternoon spent undoing somebody else's mistakes no work at all.
 *
 * ── A SAVE ABOUT A DIFFERENT READING IS NOT A SAVE HERE ─────────────────────
 *
 * The generations are compared before the contents are, because amendments name
 * blocks as `(page, order)` and those numbers mean different blocks after the
 * pages are read again. Two files that disagree about which reading they describe
 * cannot be compared block for block at all — the diff would be arithmetic over
 * two different books — so the honest answer is that this book has no restore
 * point, and every correction in it is at stake. `restorePointOf` already refuses
 * a save its reading has replaced; this catches the case where a live overlay
 * survives a change the ledger has not recorded, and it errs towards asking.
 */
export function uncommittedCuration(
  live: CurationContent,
  saved: SavedCuration | null,
): UncommittedCuration | null {
  const against = saved !== null && saved.content.generation === live.generation ? saved : null;
  const mine = decisionsOf(live);
  const theirs = against === null ? new Map<string, OverlayDecision>() : decisionsOf(against.content);

  const targets = new Set<string>();
  for (const target of mine.keys()) targets.add(target);
  for (const target of theirs.keys()) targets.add(target);
  let blocks = 0;
  for (const target of targets) {
    if (!sameDecision(mine.get(target), theirs.get(target))) blocks += 1;
  }

  const chapters = !sameSpine(live.chapters, against?.content.chapters);
  if (blocks === 0 && !chapters) return null;
  return { blocks, chapters, since: against?.label ?? null };
}

/**
 * Whether two decisions about one block say the same thing.
 *
 * AN EMPTY DECISION IS NO DECISION. `amendmentsOf` never writes one — a block
 * whose last field was cleared drops out of the file entirely, which is what makes
 * unstriking cost nothing — so a `{}` reaching here came from a file written by
 * hand or by an older build, and reading it as "this block is decided" would count
 * a difference between a book and itself.
 */
function sameDecision(mine?: OverlayDecision, theirs?: OverlayDecision): boolean {
  const a = said(mine);
  const b = said(theirs);
  if (a === null || b === null) return a === b;
  return a.strike === b.strike && a.category === b.category && a.text === b.text;
}

function said(decision?: OverlayDecision): OverlayDecision | null {
  if (decision === undefined) return null;
  if (decision.strike === undefined && decision.category === undefined && decision.text === undefined) {
    return null;
  }
  return decision;
}

/**
 * Whether two books divide the same way.
 *
 * ABSENT AND EMPTY ARE DIFFERENT and the difference is the feature, not a
 * technicality: no `chapters` field means nobody has touched the spine and the
 * engine's own detection decides, while an empty list is a person saying out loud
 * that this book does not divide (see `CurationContent.chapters`). Somebody who
 * has just made that statement and never saved it has made a real decision about
 * their book, and a comparison that folded the two states together would close on
 * it without a word.
 *
 * COMPARED FIELD BY FIELD rather than by serialising both sides. The two lists
 * are built by different readers on different days and a JSON string is a
 * statement about key order as much as about content — a spine that differed only
 * in how a `part` happened to be spelled out would put a dialog in somebody's way
 * about a book that has not changed.
 */
function sameSpine(mine?: readonly OverlayChapter[], theirs?: readonly OverlayChapter[]): boolean {
  if (mine === undefined || theirs === undefined) return mine === theirs;
  if (mine.length !== theirs.length) return false;
  for (let at = 0; at < mine.length; at += 1) {
    const a = mine[at]!;
    const b = theirs[at]!;
    if (a.title !== b.title) return false;
    if (a.at.page !== b.at.page || a.at.order !== b.at.order || a.at.part !== b.at.part) return false;
  }
  return true;
}
