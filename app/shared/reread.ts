/**
 * What reading this book again would COST, named before the job exists.
 *
 * ── The fact this file is the answer to ─────────────────────────────────────
 *
 * The OCR dialog enqueues, and nothing tells anybody what they have just spent.
 * A second reading of a book that has already been read REPLACES the first one:
 * the new bank swaps in when the run completes, the old one is destroyed by the
 * rename, and every save and every translation made from the old reading goes
 * stale — because a curation names blocks by `(page, order)` and those numbers
 * mean different blocks after the pages are read again. The ledger can name every
 * one of those casualties (`subtree`, `markStale`). The dialog just never asked.
 *
 * So this asks, and it asks the SAME QUESTION THE LANDING WILL ASK — `reRunTarget`
 * against the ask, normalised by `askedOf` — because a confirm that decided
 * replace-or-branch by any other rule would be a sentence about a job the engine
 * then files the other way.
 *
 * ── Three answers, and two of them are not a dialog ─────────────────────────
 *
 * REPLACE is the only one that gets a box, because it is the only one where
 * something the user has is at stake. A BRANCH — a re-read with different pages
 * or a different language — destroys nothing and stales nothing; it costs GPU,
 * and the queue is where expense happens, so enqueueing it IS the deliberate act
 * (the row is held, and Start is a second one). What it gets is one line of fact
 * beside the button, because a person asking for different pages may genuinely
 * believe they are replacing. A statement, not a question. And a project with NO
 * READING YET gets neither: there is nothing to say.
 *
 * ── Why the wording lives in `shared/` ──────────────────────────────────────
 *
 * Because it is the part that has to be tested. The counts and the names in these
 * sentences are read off the ledger and nowhere else — a dialog that said "your 2
 * saved corrections" over a project with three of them would be the app inventing
 * a fact about somebody's work — so the composition is a pure function with the
 * ledger as its only input, and `test/app/reread.test.ts` holds it down. Main
 * still owns the BOX: it draws it, it owns the buttons below, and it reads the
 * answer back by label (`main.ts`), exactly as every other dialog in this app.
 *
 * ── The last sentence, and why it may be said at all ────────────────────────
 *
 * "Nothing is destroyed if the run fails" is only true because the engine writes
 * a re-read into a pending bank beside the real one and swaps on success
 * (`docs/BANK-LIFECYCLE.md` §2). It is a promise about the disk, made here, kept
 * there. If that ever stops being true this sentence has to go with it.
 */

import { askedOf, reRunTarget, subtree, type ReadAsk } from './ledger';
import type { LedgerStep, ProjectLedger } from './types';

/**
 * The buttons, written once and read back by their own words.
 *
 * NEVER "OK". The question is "Read this book again?" and the answer to it is
 * either reading it again or leaving the reading alone — a box whose affirmative
 * says "OK" makes the user re-read the question to find out what they are
 * agreeing to, at the one moment in this dialog where that matters.
 *
 * A native box answers with an INDEX, and an index is the wrong thing for main to
 * hold in its head (see `ANSWERS` in electron/main.ts, which is this rule already
 * written down for the closing question). So the label is the key, and both sides
 * import these rather than spelling them twice.
 */
export const RE_READ_PROCEED = 'Read it again';
export const RE_READ_CANCEL = 'Leave the reading as it is';

/** The sentence the dialog prints beside its own button when a re-read branches. */
export const BRANCH_SENTENCE = 'This will be a second reading beside the current one.';

/**
 * The two halves of the native box, composed from the ledger.
 *
 * `message` and `detail` are Electron's own field names for the bold line and the
 * body, and they are used here so the thing that crosses IPC is already shaped
 * like the box it becomes — main adds the buttons and nothing else.
 */
export interface ReReadPrompt {
  /** The headline: the question itself. */
  message: string;
  /** §3.2's sentences, with every count and every name read off the ledger. */
  detail: string;
}

/** A re-read that would branch: nothing at stake, one line of fact. */
export interface BranchAhead {
  kind: 'branch';
  /** `BRANCH_SENTENCE`, carried so a caller never re-spells it. */
  sentence: string;
}

/** A re-read that would replace a reading, and everything that costs. */
export interface ReplaceAhead {
  kind: 'replace';
  /** The reading this run would swap its bank into. */
  target: LedgerStep;
  /**
   * Everything made from that reading — `subtree` minus the target itself — in
   * creation order, which is the order the user watched them appear.
   *
   * NOT DELETED AND NOT AT RISK: these are the steps `markStale` will mark. They
   * are named because a person who has saved corrections against a reading is
   * owed the list before they replace it, not after.
   */
  casualties: readonly LedgerStep[];
  message: ReReadPrompt;
}

/** What re-reading this book would do, or null when there is nothing to say. */
export type ReReadAhead = BranchAhead | ReplaceAhead | null;

/**
 * The question, asked of the ledger the renderer is already holding.
 *
 * ── Why the parent is the ORIGIN and not the position ───────────────────────
 *
 * A reading is parented at the import, wherever the pointer happens to be
 * standing — it reads the PIXELS, which live in `archive/`, and `planReading`
 * resolves that source itself for exactly this reason. `recordReading` states the
 * rule (job-queue.ts) and `originOf`'s header spells out what asking the position
 * instead would cost: standing on the reading and pressing OCR again is the
 * ordinary way somebody re-reads a book, and parented at the position it would
 * never match the reading it was meant to replace. This function has to ask the
 * same question the landing will, or it names a cost the run does not pay.
 *
 * ── And why "no reading yet" is asked of the ledger, not of the target ──────
 *
 * `reRunTarget` returning null means "this ask matches no existing reading", and
 * that is true both of a project nobody has read AND of a project read with
 * different pages. Those are the two answers that are not the same: one is a
 * branch and one is silence. So the reading steps are counted first, and only a
 * project that already holds one can be told about a second.
 */
export function reReadAhead(ledger: ProjectLedger | null, asked: ReadAsk): ReReadAhead {
  if (ledger === null) return null;
  const origin = ledger.steps.find((step) => step.parent === null) ?? null;
  // No import means no project history at all; nothing has been read and nothing
  // can have been. The ledger mirror is simply not there yet for a book on its
  // first pass through this dialog, which is the ordinary case.
  if (origin === null) return null;
  if (!ledger.steps.some((step) => step.action === 'read')) return null;

  const target = reRunTarget(ledger, {
    action: 'read',
    parent: origin.id,
    params: askedOf(asked),
  });
  // A DIFFERENT ASK BRANCHES, and a stale reading of the SAME ask does not: a
  // re-read of a branch that went stale is somebody saying "make this one current
  // again", which is a replace and is what `reRunTarget` deliberately answers.
  if (target === null) return { kind: 'branch', sentence: BRANCH_SENTENCE };

  const casualties = subtree(ledger, target.id).filter((step) => step.id !== target.id);
  return { kind: 'replace', target, casualties, message: promptFor(target, casualties) };
}

/**
 * §3.2's wording, adapted to what this particular ledger actually says.
 *
 * ── The rule every clause here obeys ────────────────────────────────────────
 *
 * NEVER INVENT A NUMBER THE LEDGER DID NOT GIVE YOU. The spec's example reads
 * "the 17-page reading" and "your 2 saved corrections and the English
 * translation", and those are not templates to fill in from nothing: a reading
 * whose page count nobody recorded is called "Read", and `labelFor` already made
 * that decision once. So every step in these sentences is named by ITS OWN LABEL,
 * quoted, exactly as the delete confirm names its casualties — which also means a
 * person who reads one of this app's two destructive confirms recognises the
 * other.
 *
 * The count of casualties is a fact the ledger gave us (`subtree`), so it is
 * stated as a numeral, in the delete confirm's own idiom.
 */
function promptFor(target: LedgerStep, casualties: readonly LedgerStep[]): ReReadPrompt {
  const named = casualties.map((step) => `“${step.label}”`).join(', ');
  const madeFromIt = casualties.length === 0
    ? ''
    // KEPT, LISTED AND DIMMED — said in that order and said plainly, because the
    // word "stale" on its own reads like a deletion to anybody who has not read
    // the design document, and the one thing this sentence must not do is
    // frighten somebody about work that is not going anywhere.
    : ` ${casualties.length === 1 ? 'One step was' : `${casualties.length} steps were`} made from it `
      + `and will be marked stale — kept, listed, and dimmed: ${named}.`;
  return {
    message: 'Read this book again?',
    detail: `This replaces “${target.label}”.${madeFromIt}`
      // THE PROMISE THE PENDING BANK MAKES. See the header: this sentence is only
      // honest because a re-read fills a pending file and swaps on success.
      + ' Nothing is destroyed if the run fails: the current reading stays until the'
      + ' new one finishes.',
  };
}
