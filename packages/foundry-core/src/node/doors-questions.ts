/**
 * doors-questions — the questions main asks through the app's own card — the words and the shapes.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */

import { RE_READ_CANCEL, RE_READ_PROCEED } from '../shared/reread';
import type { ReReadPrompt } from '../shared/reread';
import type {
  AppQuestion,
  Asked, CloseAnswer,
  CloseWarning, ReReadAnswer, UnappliedAnswer,
  UnappliedWarning
} from '../shared/types';

/**
 * The closing question's buttons — the words, beside the answers they mean.
 *
 * ── The lookup table that used to be here, and why it is gone ───────────────
 *
 * A NATIVE BOX ANSWERED WITH AN INDEX, and an index was the wrong thing for this
 * dialog to hold in its head: the box had two buttons for a file copy and three
 * for a set of corrections, so `response === 0` meant "close it" in one shape and
 * "save first" in the other. Two shapes, two meanings, one number — and the way
 * that went wrong was silent, because both were valid answers and neither threw.
 * The defence was to look the answer up by its own LABEL, through a `Record` that
 * lived right here.
 *
 * The card answers with the KEY of the button that was pressed, and the key is a
 * `CloseAnswer` — so the label is now nothing but the words on a button, the
 * table has nobody left to serve, and the compiler checks what a `Record` keyed
 * by prose used to check at runtime. The labels stay written once because two
 * spellings of one button is still two spellings.
 */
const KEEP = 'Keep it open';
const CLOSE = 'Close it';
/*
 * The book pane's two, which say what its own gestures are called rather than
 * borrowing the pair above. "Save these corrections" is the block editor's verb
 * over the block editor's noun, and neither is what a person did on the proof
 * sheet. DISCARD keeps its weight and has earned more of it: closing itself no
 * longer scraps a stack (Owen's reversal, 2026-08-22 — see `aboutTheEdits`), so
 * this button is now the only gesture in the app that throws unapplied work
 * away, and "Close it" was never the word for that.
 */
const APPLY = 'Apply these changes, then close';
const DISCARD = 'Discard them and close';
/*
 * And the unapplied card's two.
 *
 * ── THE RULING THAT MADE THEM TWO (Owen, 2026-08-22, verbatim) ──────────────
 *
 * *"if the user has 'this book' selected with un-applied changes, the export
 * option shouldnt be grayed out. but any action they take, whether it's
 * switching to a different step or narrating or anything at all, should ask if
 * they want to apply changes in a modal. discard/apply changes. if they hit
 * discard, it does whatever action they selected to the step theyre on after
 * dropping changes they made. if they hit apply changes, the action they select
 * is executed after applying all changes. and maybe there should be another
 * apply changes button somewhere obvious. the button on the side of the
 * workbench works but it isnt obvious"*
 *
 * `APPLY_AND_CONTINUE`, `WITHOUT_THEM` AND `CANCEL` STOOD HERE. The first was
 * "Apply them and continue" and is now simply "Apply changes" — the ruling's own
 * words, and the same words the second obvious button in the book pane wears, so
 * there is ONE name in this app for the one press. The second, "Continue without
 * them", is retired with the answer behind it (`UnappliedAnswer` carries the
 * argument). The third was a button; a cancel is now the app's own dismissal —
 * Escape or a click outside — because a card with three buttons where one of
 * them is "do nothing" makes the two that mean something harder to read, and the
 * ruling asked for two.
 *
 * DISCARD WEARS THE ERROR COLOUR HERE TOO, on the closing card's precedent and
 * for its reason: this is now the SECOND gesture in the app that can throw
 * unapplied work away, and a button that destroys has to be aimed at rather than
 * fallen onto. It is the only difference in weight between the two answers —
 * both are legitimate, one is irreversible.
 */
const APPLY_CHANGES = 'Apply changes';
const DISCARD_CHANGES = 'Discard changes';

/** `document:confirm-close`: the warning before a tab with something to lose closes. */
export function confirmClose(warning: CloseWarning): Asked<CloseAnswer> {
  return {
    kind: 'ask',
    /*
     * THE STACK LEADS WHEN THERE IS ONE, ahead of the other, and the reason
     * survived the reversal that changed everything else on this card. It used
     * to lead because it was the only loss: unapplied changes were in memory
     * and closing destroyed them, while the filed copy was merely old. They are
     * on disk now (`savePendingStack`) and closing destroys nothing — but the
     * stack is still the sentence somebody needs first, because it is the one
     * that decides whether the next book this app makes is the book they are
     * looking at. "Your copy is out of date" over the top of that would bury the
     * question under the footnote.
     */
    question: warning.edits !== null && warning.edits > 0
      ? aboutTheEdits(warning, warning.edits)
      : aboutTheCopy(warning),
  };
}

/**
 * THE CARD ABOUT A STACK NOBODY APPLIED — and it no longer says the work will
 * be lost, because that stopped being true.
 *
 * ── The ruling this card used to report, and the ruling that replaced it ────
 *
 * It used to say, truthfully, that closing threw the stack away: the stack was
 * a LIFO in memory and nothing else, "Apply writes and clears; closing without
 * applying scraps it" (docs/RENDERER.md §3). Then a real project lost real work
 * to it — the pane's changes were never applied, the export silently lacked
 * them, and the stack went with a window that closed without this card ever
 * being drawn (user report, 2026-08-21). Owen reversed the ruling the next day:
 * unapplied work is never silently scrapped. It is written to a sidecar as it
 * is made (`savePendingStack`, electron/book.ts) and put back the next time the
 * book is opened at the same step.
 *
 * SO THE FRIGHTENING SENTENCE WOULD NOW BE THE LIE, and it is gone. What is
 * left is a card about a CHOICE rather than about a loss — record these as a
 * step now, or leave them held and come back to them — plus the one button that
 * still destroys, which is the one place in this app allowed to.
 *
 * WHICH IS WHY THE OFFER IS STILL A BUTTON. A dialog whose only route to
 * recording the work is *cancel, find Apply, close again* has made the person
 * do the app's job. Apply is offered first and is what Enter takes; Discard is
 * last and wears the error colour, so the button that destroys has to be aimed
 * at — and now it is the ONLY thing that destroys, which is what makes it
 * meaningful.
 *
 * NO COUNT OF WHAT KIND. "5 changes" is what the card says, not "3 strikes, a
 * relabel and an edit" — the changes themselves are on the paper behind the
 * dialog, in the cancel marks and the changed paragraphs, and that is a better
 * description of them than a tally of verbs would be.
 */
function aboutTheEdits(warning: CloseWarning, edits: number): AppQuestion {
  const changes = edits === 1 ? '1 change' : `${edits} changes`;
  /*
   * The filed copy, when this tab owes that as well. Kept to a clause and put
   * last: it is the smaller loss, and the buttons are about the stack.
   */
  const alsoTheCopy = warning.modified
    ? [
      'The copy you filed for yourself is also older than this one, and closing does not bring '
      + 'it up to date. Export the book again to replace it.',
    ]
    : [];
  return {
    title: 'Apply these changes before closing?',
    message: `“${warning.title}” has ${changes} that have not been applied.`,
    detail: [
      'Changes made on the book are held while you work so that taking one back is instant, and '
      + 'they are not written down as a step until you apply them. Closing keeps them held: they '
      + 'come back the next time you open this book at the same step.',
      'What they are NOT part of until you apply them is anything made from this book — an '
      + 'export, a translation or a rewrite is built from the recorded steps, so it would be made '
      + 'without them.',
      'Applying now records all of them as one row in Steps, which you can stand on, branch from '
      + 'and delete afterwards. Discarding is the one thing that throws them away for good.',
      ...alsoTheCopy,
    ],
    choices: [
      { key: 'save', label: APPLY },
      { key: 'keep', label: KEEP },
      { key: 'close', label: DISCARD, danger: true },
    ],
    preferred: 'save',
    dismissed: 'keep',
    checkbox: null,
  };
}

/**
 * The filed copy is older than the book in front of you — the one thing left
 * for this half of the question to say.
 *
 * ── The sentence that died here, and why it could not stay ──────────────────
 *
 * This function used to fork on `warning.unsaved` and say, for a book with no
 * copy anywhere the user chose, that nothing else on the machine knew about it.
 * `questionBefore` (core/documents.service.ts) no longer asks anything for a bare
 * `unsaved`, so that branch became unreachable the moment the ruling landed —
 * and it was also, by then, untrue: the book is in its project, Home lists it,
 * and the way a copy leaves this app is the export modal (docs/WORKBENCH.md
 * §6). A branch that can never run, phrased as advice about a gesture that no
 * longer exists, is worse than no branch at all, so both went.
 *
 * What is left is a real state with a real remedy: a copy the person themselves
 * put somewhere, which this book has moved on from.
 */
function aboutTheCopy(warning: CloseWarning): AppQuestion {
  return {
    title: 'Close with edits unsaved?',
    message: `“${warning.title}” has been edited since you saved it.`,
    detail: [
      'Every edit went straight into Foundry\'s working copy of the book as you made it, so '
      + 'nothing here is lost — the project keeps it and Home will still list it.',
      'The copy you filed for yourself is the older version, and closing does not bring it up '
      + 'to date. Export the book again to replace it.',
    ],
    // The safe answer is FOCUSED and the ending one is LAST, which is this
    // app's rule for every card that can destroy something: Enter cannot
    // reach the button that ends the session's way back.
    choices: [
      { key: 'keep', label: KEEP },
      { key: 'close', label: CLOSE, danger: true },
    ],
    preferred: 'keep',
    dismissed: 'keep',
    checkbox: null,
  };
}

/** `reading:confirm-re-read`: "Read this book again?" */
export function confirmReRead(prompt: ReReadPrompt): Asked<ReReadAnswer> {
  return {
    kind: 'ask',
    question: {
      /*
       * THE HEADLINE IS THE PROMPT'S OWN, AND IT IS SAID ONCE. The native box
       * had a title bar and a message and this question filled both with the
       * same sentence, which cost nothing when one of them was window chrome
       * and would be a card saying "Read this book again?" twice.
       */
      title: prompt.message,
      message: prompt.detail,
      detail: [],
      choices: [
        { key: 'leave', label: RE_READ_CANCEL },
        { key: 'again', label: RE_READ_PROCEED, danger: true },
      ],
      preferred: 'leave',
      dismissed: 'leave',
      checkbox: null,
    },
  };
}

/** `book:confirm-unapplied`: the card in front of every act that would run past unapplied work. */
export function confirmUnapplied(warning: UnappliedWarning): Asked<UnappliedAnswer> {
  const changes = warning.edits === 1 ? '1 change' : `${warning.edits} changes`;
  const them = warning.edits === 1 ? 'it' : 'them';
  /*
   * WHAT THE ACT WOULD BE MADE FROM — and standing is the odd one out, which
   * is exactly why it needs its own sentence rather than a fifth spelling of
   * the make-act line. A move makes nothing; what it costs is that the stack
   * cannot come with it, because ops are a delta against the step they were
   * made on and carrying them would apply somebody's decisions to a book they
   * never made them about.
   */
  const runs = warning.act === 'stand'
    ? 'Changes on the book belong to the step they were made on, so moving to another step '
      + 'cannot take them along. They would be left behind here.'
    : (warning.act === 'translate'
      ? 'The translation would be made from'
      : warning.act === 'simplify'
        ? 'The rewrite would be made from'
        : warning.act === 'clean'
          ? 'The cleaned text would be made from'
          : warning.act === 'export'
            ? 'The exported book would be'
            : 'The work would be made from')
      + ' the book as it was recorded, which is the book WITHOUT those changes — changes reach '
      + 'anything made from this book only once they are applied as a step.';
  // What happens the moment the card closes, in the words of the thing the
  // person pressed. The card's own title says nothing about the act, so this
  // is the only place it is named.
  const then = warning.act === 'translate'
    ? 'the translation is set up'
    : warning.act === 'simplify'
      ? 'the rewrite is set up'
      : warning.act === 'clean'
        ? 'the cleanup is set up'
        : warning.act === 'export'
          ? 'the export is set up'
          : warning.act === 'stand'
            ? 'the step you clicked is opened'
            : 'the work goes ahead';
  return {
    kind: 'ask',
    question: {
      title: warning.edits === 1
        ? '1 change is not applied yet'
        : `${warning.edits} changes are not applied yet`,
      message: `“${warning.title}” has ${changes} on the page that have not been applied.`,
      detail: [
        runs,
        `Apply changes records all of ${them} as one row in Steps, and then ${then} from the `
        + 'book you are looking at.',
        `Discard changes throws ${them} away for good — nothing puts ${them} back — and then `
        + `${then} from the book as it was recorded.`,
        'Leave it as it is walks away from the whole question: nothing is applied, nothing is '
        + 'discarded, and nothing runs.',
      ],
      /*
       * THE WAY OUT IS A BUTTON AGAIN — Owen's ruling, 2026-08-23: *"lets add
       * a cancel button to that, so the user doesnt have to do anything if
       * they dont want."* The two-answer version kept cancel alive as Escape
       * and the scrim, and the detail said so in words — which is a way out
       * only for somebody who reads the small print of a card they were
       * interrupted by. Between the two others, so the destructive button
       * stays LAST and keeps having to be aimed at; Apply stays first and is
       * still what Enter takes.
       */
      choices: [
        { key: 'apply', label: APPLY_CHANGES },
        { key: 'cancel', label: 'Leave it as it is' },
        { key: 'discard', label: DISCARD_CHANGES, danger: true },
      ],
      preferred: 'apply',
      /*
       * A DISMISSAL IS STILL A CANCEL — Escape and the scrim mean the same
       * thing the middle button says, because somebody stepping away from a
       * question and somebody pressing "leave it" have decided the same
       * nothing.
       */
      dismissed: 'cancel',
      checkbox: null,
    },
  };
}

/** `crucible:confirm-remove-model`: are you sure, with the size. */
export function confirmRemoveModel(
  ask: { server: string; id: string; name: string | null; bytes: number | null },
): Asked<'remove' | 'keep'> {
  return {
    kind: 'ask',
    question: {
      title: 'Remove these weights?',
      message: `"${ask.name ?? ask.id}" will be deleted from ${ask.server}`
        + `${ask.bytes === null ? '' : `, freeing ${(ask.bytes / 1024 ** 3).toFixed(1)} GB`}.`,
      detail: [
        'The files are removed from that machine. Nothing on this computer changes, and no '
        + 'book that was already made with this model is affected — a finished step keeps its '
        + 'text and its record of what produced it.',
        'Fetching it again later is one press and the same download. What you are spending to '
        + 'get it back is time and bandwidth, not work.',
      ],
      choices: [
        { key: 'keep', label: 'Keep it' },
        { key: 'remove', label: 'Remove' },
      ],
      preferred: 'keep',
      dismissed: 'keep',
      checkbox: null,
    },
  };
}
