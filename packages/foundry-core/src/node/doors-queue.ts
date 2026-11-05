/**
 * doors-queue — what a queued run is recorded as made from, and the enqueue doors.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */

import { admitted } from './openable';
import { foundryHost, hosted } from './host';
import * as queue from './job-queue';
import {
  positionStepId,
  projectDirOf
} from './projects';
import type {
  JobRequest, TextPassRequest,
  AnalyzeRequest,
  CleanRequest
} from '../shared/types';

/**
 * The position of the project a job is about to write into, at the press.
 *
 * ── Why the press and not the spawn ─────────────────────────────────────────
 *
 * A job's product is recorded as having been made FROM a step, and that step is
 * what decides whether a re-run replaces an earlier one (staling everything
 * downstream) or branches beside it. Moving the pointer, meanwhile, is free and
 * unconfirmed — people click through their own history while they wait, which is
 * exactly what the history is for. So a job that read its parent when it landed
 * would be retargeted by a glance: queue a translation from the reading, click
 * back to compare two saves, and three hours later the app files a translation
 * of a save nobody asked it to translate.
 *
 * Resolved HERE, in the handler, so the read of the catalogue and the enqueue
 * happen in one turn and `queue.enqueue` stays synchronous — the shelf row has
 * to appear the instant Add is pressed (see that function).
 *
 * FROM THE JOB'S OWN OUTPUT PATH, which is main's composition rather than the
 * renderer's word: `workspace:plan*` built it, into a project directory this app
 * chose. A request naming somewhere else answers null and lands on the same
 * fallback a project with no history does.
 */
export const parentStepFor = async (target: string): Promise<string | null> => {
  const dir = projectDirOf(target);
  return dir === null ? null : positionStepId(dir);
};

/**
 * WHAT THIS RUN IS RECORDED AS BEING MADE FROM — the position, unless the request
 * already says otherwise.
 *
 * ── The one case where the pointer is the wrong answer ─────────────────────
 *
 * `Job.parentStep` is the position at the press, and the argument for that is
 * unchanged and long: a pointer that moves while a row waits must not change what
 * the run is filed under. A DEFERRED request breaks the premise rather than the
 * rule — the person pressed on a card that is not the position and cannot be, because
 * main refuses `ledger:go` to a step that does not exist (`LedgerService.
 * standOnPromise`). Reading the pointer there would file an export of a promised
 * cleanup against the row the cleanup was made FROM: the tree would draw it one
 * card too high, and `ProjectFinal.stepId` would claim the finished book came from
 * a position it does not carry the words of.
 *
 * SO THE DEFERRAL WINS WHERE THERE IS ONE, and it is still the position at the
 * press: `deferred.from` was minted by the plan the moment the button went down,
 * and it names exactly the card the person was standing on.
 */
export const madeFrom = async (
  request: JobRequest | TextPassRequest,
  target: string,
): Promise<string | null> => {
  const deferred = request.kind === 'read' ? undefined : request.deferred;
  return deferred?.from ?? await parentStepFor(target);
};

/** `queue:enqueue`. */
export async function enqueueJob(request: JobRequest) {
  return queue.enqueue(
    request,
    // The BANK for a reading, the rendering's output otherwise — the same
    // `outputPath` the queue dedupes on, and the only path in a request that is
    // certainly inside the project the job is about. `madeFrom` rather than
    // `parentStepFor`: a deferred export names its own row, which is not the
    // pointer and cannot be.
    await madeFrom(request, request.kind === 'read' ? request.readingsPath : request.outputPath),
  );
}

/** `queue:enqueue-translate`: one door for three text passes. */
export async function enqueueTextPassFor(request: TextPassRequest) {
  // The input again, because a request can arrive with any `inputPath` at all
  // — `workspace:plan-translation` checked the one it was given, not the one
  // that ends up here.
  if (admitted(request.inputPath) === null) {
    throw new Error(`${request.inputPath} was never opened in this app.`);
  }
  // The RECORDS file, which is what every text pass writes: the position is
  // resolved from the project that file belongs to, exactly as it used to be
  // resolved from the project the output EPUB belonged to.
  return queue.enqueueTextPass(request, await madeFrom(request, request.recordsPath));
}

/** `queue:enqueue-clean-triaged`. */
export async function enqueueTriagedCleanupFor(request: CleanRequest) {
  if (admitted(request.inputPath) === null) {
    throw new Error(`${request.inputPath} was never opened in this app.`);
  }
  return queue.enqueueTriagedCleanup(request, await madeFrom(request, request.recordsPath));
}

/** `queue:enqueue-analysis`. */
export async function enqueueAnalysisFor(request: AnalyzeRequest) {
  if (hosted() && foundryHost()?.hostQueue === undefined) {
    throw new Error(
      'Analysis is not available in this window — the app Foundry is running inside keeps no queue '
      + 'for it to wait in. Open the book in Foundry itself to analyse it.',
    );
  }
  // The input again, because a request can arrive with any `inputPath` at all
  // — `workspace:plan-analysis` checked the one it was given, not the one that
  // ends up here.
  if (admitted(request.inputPath) === null) {
    throw new Error(`${request.inputPath} was never opened in this app.`);
  }
  // The REPORT, which is what an analysis writes: the position is resolved from
  // the project that file belongs to, exactly as a translation's is from its
  // records.
  return queue.enqueueAnalysis(request, await parentStepFor(request.outputPath));
}

/** `queue:run`: an export runs at the press and the answer is the settled row. */
export async function runJobNow(request: JobRequest) {
  return queue.runNow(
    request,
    await madeFrom(request, request.kind === 'read' ? request.readingsPath : request.outputPath),
  );
}
