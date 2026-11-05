/**
 * doors-ledger — the live queue's promises read against a ledger, and the ledger doors that admit what they answer.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */
import * as path from 'node:path';

import { admit } from './openable';
import {
  invokeHostOperation
} from './host-ops';
import * as queue from './job-queue';
import {
  documentAtPosition,
  documentAtStep, readStepLedger
} from './projects';
import { cleanupInEffect } from '../shared/ledger';
import { admitPending, pendingStepOf, rowMinting, withPending } from '../shared/pending';
import type {
  Job, LedgerStep, ProjectLedger, StepDeletion
} from '../shared/types';

/**
 * WAS THE NARRATION CLEANUP IN EFFECT where this host act was ordered from — the
 * one field of `HostInvokeContext`, answered against the project's own ledger.
 *
 * ── Why the node id has to be resolved rather than trusted ──────────────────
 *
 * `nodeId` is three different things (`HostOperation.invoke`, electron/host-ops.ts):
 * a ledger step id when the act was ordered from a row Foundry made, one of the
 * HOST's own ids when it was chained onto work that has not happened yet, and
 * `export:<file>` when it came off an export row. Only the first names a position
 * this app can ask a question about, so the lookup is `stepOf`-shaped and every
 * other shape falls to the same answer as a step that is not there.
 *
 * ── FALSE IS THE ANSWER FOR EVERY OTHER SHAPE, AND IT IS NOT A SHRUG ────────
 *
 * `HostInvokeContext.cleaned` documents it: nothing HERE says these words were
 * cleaned. A host that needs the distinction between "not cleaned" and "Foundry
 * could not tell" has the durable record on the file itself — the OPF's
 * `bookforge:narration-text`, written by the compile — which is the answer a
 * narration should act on in any case. Inventing a third state on this seam would
 * be a tri-state boolean crossing a process boundary to say "ask the file",
 * which the host can do unconditionally.
 *
 * IT NEVER THROWS. An unreadable manifest, a project that has moved, a ledger this
 * build refuses — none of those is a reason to fail a button somebody pressed, and
 * the console keeps the record.
 */
export async function cleanupAtNode(projectDir: string, nodeId: string): Promise<boolean> {
  try {
    const view = await readStepLedger(projectDir);
    if (view === null) return false;
    /*
     * ── THE PROMISES ARE IN THE WALK, AS OF 2026-09-07 ────────────────────────
     *
     * Owen's pending-node ruling makes a narration orderable from a cleanup that
     * has not landed, which is exactly the shape this field exists to describe. So
     * the ledger is composed with the live queue's promises in it and the ordinary
     * `cleanupInEffect` answers through the chain unchanged (`withPending`,
     * shared/pending.ts, argues why a composed ledger beats an extra parameter on
     * five walks).
     *
     * TRUE HERE IS NOT A GUESS. The file the host will narrate is made by
     * `exportEpubFromStep`, which is itself chained behind the same promise and
     * cannot produce a book until it lands — so by the time there is anything to
     * act on, either the words are cleaned or the whole chain was cancelled by
     * name. Answering false instead would send the host to clean a book Foundry is
     * already cleaning, which is the duplicated-hour failure `HostInvokeContext`
     * was written to prevent.
     */
    const composed = withPending(view.ledger, promisedStepsIn(projectDir, view.ledger));
    const step = composed.steps.find((row) => row.id === nodeId) ?? null;
    return step === null ? false : cleanupInEffect(composed, step);
  } catch (err) {
    console.error(
      `[ipc] could not tell whether ${nodeId} in ${projectDir} stands under a cleanup `
      + `(${err instanceof Error ? err.message : String(err)}); the host is told it does not.`,
    );
    return false;
  }
}

/**
 * EVERY QUEUE ROW ABOUT THIS BOOK, from whichever list is scheduling.
 *
 * `shelfJobs()` AND NOT `listJobs()`, which is the whole of what makes this work
 * hosted: with a host queue registered the rows in this window are the HOST's, and
 * the promises a person clicked in the tree were drawn from those. Asking Foundry's
 * own list would answer empty for every chain there is.
 *
 * FILTERED BY THE PRODUCT'S PROJECT, whole path against whole path through
 * `projectDirOf` — this codebase's oldest house rule, and it matters here because
 * the shelf is one global list across every book on the machine.
 */
export function rowsIn(projectDir: string): Job[] {
  return queue.shelfJobsFor(projectDir);
}

/**
 * A RUNNING GHOST IS LOCKED, and the tree is not the door — Owen's ruling
 * (2026-09-08): *"maybe we turn it red while its running and lock it. the user
 * has to remove it from the queue itself. again, if it's removed as a ghost,
 * everything under it is removed as well. that simplifies the logic so it doesnt
 * hit a bug where narration is trying to run on the wrong thing, or nothing at
 * all."*
 *
 * THE LAST CLAUSE IS THE REASON AND IT IS NOT TIDINESS. Stopping a run from here
 * means deciding, at the moment the work is half done, what becomes of everything
 * chained under it — and the two queues answer that differently (a host's remove
 * drops the subtree, this app's cancel marks it). One door, the queue's own, is
 * one answer; two doors is where a narration ends up pointed at a step nobody is
 * going to make. A QUEUED ghost is untouched by this: nothing has begun, and its
 * delete is still the removal `promisedDeletion` describes.
 */
export function refuseRunningGhost(row: Job): void {
  if (row.state !== 'running') return;
  const label = row.title ?? path.basename(row.outputPath);
  throw new Error(
    `“${label}” is running, so it cannot be removed from here. Stop it in the queue, which takes `
    + 'everything queued behind it away in the same gesture — the one place that can end a run and '
    + 'settle what happens to the work waiting on it.',
  );
}

/**
 * A DELETE PRESSED ON A GHOST — the id is minted by a live row, not held by the
 * ledger, and `stepOf` would refuse it by name ("This ledger has no step called
 * …", which is what Owen saw, 2026-09-08). A promise is a queue row, so the
 * question is answered from the queue: what goes is the row and every row chained
 * behind it, and the removal is the queue's own — which hosted forwards to the
 * host's `remove`, whose cascade is the same one the tree draws.
 *
 * NULL FOR A REAL STEP, and the ordinary delete goes on exactly as it did.
 */
export function promisedDeletion(projectDir: string, stepId: string): StepDeletion | null {
  const rows = rowsIn(projectDir);
  const row = rowMinting(rows, stepId);
  if (row === null) return null;
  refuseRunningGhost(row);
  // The chain behind it, transitively, by `after` — the cascade's own edge.
  const going: Job[] = [row];
  const seen = new Set<string>([row.id]);
  for (let i = 0; i < going.length; i += 1) {
    for (const other of rows) {
      if (other.after === going[i]!.id && !seen.has(other.id)) {
        seen.add(other.id);
        going.push(other);
      }
    }
  }
  const nameOf = (one: Job): string => one.title ?? path.basename(one.outputPath);
  const label = nameOf(row);
  return {
    stepId,
    label,
    queued: true,
    casualties: going.map((one, at) => ({
      id: one.mints ?? one.id,
      label: nameOf(one),
      cost: at === 0
        ? `“${nameOf(one)}” is ${one.state === 'running' ? 'running' : 'queued'} and has made nothing yet — `
          + 'removing it makes nothing and destroys nothing.'
        : `“${nameOf(one)}” was to be made from it, and leaves the queue with it.`,
      stale: false,
    })),
    belongings: null,
    files: [],
  };
}

/**
 * THE PROMISES THIS BOOK'S QUEUE ROWS MAKE, as synthetic steps — the list every
 * walk in main composes a ledger with.
 *
 * The orphan rule is `admitPending`'s and is applied here rather than at each
 * caller: a row whose parent is neither a step nor another live promise is not
 * drawn and is not walked, which is the derivation half of Owen's cascade and must
 * be one rule rather than two implementations that can disagree about what the
 * window is showing.
 */
export function promisedStepsIn(projectDir: string, ledger: ProjectLedger): LedgerStep[] {
  return admitPending(ledger, rowsIn(projectDir))
    .map(pendingStepOf)
    .filter((step): step is LedgerStep => step !== null);
}

/**
 * THE ROW A HOST'S OWN WORK MUST WAIT BEHIND, when the act was ordered from
 * something that has not happened yet — `HostInvokeContext.pendingRow`.
 *
 * ONE LOOKUP FOR BOTH SHAPES OF ID. A promised STEP and a promised EXPORT are told
 * apart everywhere else in this feature (`exportOfNodeId`), and here they are not:
 * `Job.mints` carries whichever id the row is going to land, so asking "which live
 * row mints this" answers for a narration ordered from a grayed cleanup and for one
 * ordered from a grayed EPUB with the same line.
 *
 * UNDEFINED FOR EVERY ORDINARY PRESS — a landed step, a file in the tray — which is
 * every host act before this wave, and means "nothing to wait for".
 */
export function pendingRowAt(projectDir: string, nodeId: string): string | undefined {
  return rowMinting(rowsIn(projectDir), nodeId)?.id;
}

/** `host-ops:invoke`'s body: the press, with the context Foundry composes for it. */
export async function invokeHostOperationAt(
  operationId: string,
  projectDir: string,
  nodeId: string,
  settings: Record<string, unknown>,
) {
  /*
   * AND WHICH ROW THIS WORK IS DOWNSTREAM OF, when the act was ordered from
   * something that has not happened yet (`HostInvokeContext.pendingRow`).
   * Composed in main for `cleaned`'s reason exactly: it is a fact about the
   * queue that is scheduling, and a renderer's mirror of that queue can be a
   * repaint behind — which here would mean telling somebody else's scheduler to
   * wait for a row that finished a moment ago, or not to wait at all.
   */
  const pendingRow = pendingRowAt(projectDir, nodeId);
  return invokeHostOperation(operationId, projectDir, nodeId, settings, {
    cleaned: await cleanupAtNode(projectDir, nodeId),
    ...(pendingRow !== undefined ? { pendingRow } : {}),
  });
}

/** `ledger:document-at`: main resolves it, so main admits it. */
export async function documentAtPositionAdmitted(projectDir: string) {
  const resolved = await documentAtPosition(projectDir);
  if (resolved !== null) admit(resolved);
  /*
   * A NULL IS AN ORDINARY ANSWER AND NOTHING IS FIRED AT IT ANY MORE. There
   * used to be a `towardTheFlowingBook` here: when a position resolved to the
   * scan, or to nothing, this handler asked the queue to cast the project's
   * flowing book so the pane would have an EPUB to unpack. The pane reads the
   * book file now — a read, a save and a translation all open the proof sheet
   * — so a position that names no separate document names none, and the panes
   * correctly keep what they have (docs/RENDERER.md §7).
   */
  return resolved;
}

/** `ledger:document-at-step`: the same answer for a row nobody is standing on. */
export async function documentAtStepAdmitted(projectDir: string, stepId: string) {
  const resolved = await documentAtStep(projectDir, stepId);
  if (resolved !== null) admit(resolved);
  return resolved;
}
