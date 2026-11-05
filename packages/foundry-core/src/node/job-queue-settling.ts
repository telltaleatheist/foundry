/**
 * job-queue-settling — a row finishing: what its mint inherits, telling its listeners, and cascading to what waited on it.
 */
import * as path from 'node:path';
import { hostMintMeta } from './host';
import { ledgerOf, projectDirOf, readManifest } from './projects';
import { type HostMintMeta } from '../shared/host-ops';
import { ancestry } from '../shared/ledger';
import { inheritMintMeta, type MintMeta } from '../shared/mint-meta';
import type { Job } from '../shared/types';
import { cancel, release, sweepDerivedBook } from './job-queue-gestures';
import { changed, copyOf, detachedRuns, forgetPark, jobs, releasing, requests, resumableStops, sessions, settleListeners, slots } from './job-queue-state';

/**
 * THE CHAIN'S OWN LANGUAGE — the newest `read` on the path that produced the
 * export, or nothing. Asked only where the request itself carried no language
 * (an untranslated position: the plan sets one for every translated export),
 * and lenient end to end, because a language the settle cannot work out is a
 * stamp that falls back to the form's answer rather than a mint that fails.
 */
/**
 * THE PROJECT'S DECLARATION WITH THE HOST'S RECORD UNDERNEATH — what an EPUB
 * export nobody confirmed at a form is stamped with. `inheritMintMeta` holds
 * the precedence; this is only the two reads it needs, both lenient: a
 * catalogue that will not parse and a host that throws are each "no record",
 * because the book is made and a stamp is the last thing that happens to it.
 */
export async function inheritedMintMetaFor(dir: string): Promise<MintMeta | null> {
  let stored: MintMeta | undefined;
  try {
    stored = (await readManifest(dir)).meta;
  } catch {
    stored = undefined;
  }
  let seed: HostMintMeta | null;
  try {
    seed = await hostMintMeta(dir);
  } catch (err) {
    // The export is made and filed whatever the host says; what is lost is
    // the author on the package, which is worth a named line and not a
    // failed job (the modal's door lets the same throw reach the form).
    console.error(`[queue] ${path.basename(dir)}: ${err instanceof Error ? err.message : String(err)}`);
    seed = null;
  }
  return inheritMintMeta(stored ?? null, seed);
}

export async function chainLanguageOf(
  outputPath: string,
  parentStep: string | null,
  /** The request's own project, for a file written outside it (`homeOf`). */
  home: string | null = null,
): Promise<string | undefined> {
  if (parentStep === null) return undefined;
  const dir = home ?? projectDirOf(outputPath);
  if (dir === null) return undefined;
  try {
    const ledger = ledgerOf(await readManifest(dir));
    const chain = ancestry(ledger, parentStep);
    for (let at = chain.length - 1; at >= 0; at -= 1) {
      const step = chain[at]!;
      if (step.action !== 'read') continue;
      const language = step.params?.['language'];
      return typeof language === 'string' && language.length > 0 ? language : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Say that this job is over — see `onJobSettled` for what that promises.
 *
 * A COPY, on `listJobs`' rule: a listener outside this module must not be handed
 * the row itself. AND EVERY LISTENER RUNS whatever the last one did, because one
 * waiter's bug is not another waiter's ending — the same posture the export
 * announcement takes one call up.
 */
export function settled(
  job: Job,
  /**
   * DID THIS ENDING LEAVE NOTHING BEHIND — the question the cascade turns on.
   *
   * ── Why the cascade hangs off this function and not off three arms ─────────
   *
   * Because this is the ONE place every ending in this file passes through: the
   * three failure arms of `executeJob`, the cancel, the removal, the mint's settle
   * and the ordinary landing all call it, and a cascade spelled at each of them is
   * a cascade missing from whichever arm is added next. Owen's ruling says *"or it
   * otherwise gets lost along the way"*, which is precisely a rule that must not be
   * enumerated.
   *
   * DEFAULTED FROM THE STATE, because for five of the six callers the state IS the
   * answer: `failed` and `cancelled` leave nothing, `done` leaves the thing the
   * chain was waiting for. The sixth is `remove`, where the row is still `held` or
   * `queued` when it leaves the list — it never ran, so its state never moved — and
   * that caller says so by hand. It is the one ending whose loss is invisible in
   * the row itself, and it is Owen's own headline case (*"if i then remove the
   * cleanup step from the queue"*).
   */
  lost: boolean = job.state === 'failed' || job.state === 'cancelled',
): void {
  /*
   * THE WAIT LEDGER IS CLEARED HERE FOR THE SAME REASON THE CASCADE LIVES HERE:
   * this is the one place every ending in this file passes through, and a
   * backoff count left behind on a removed row would be handed to the next job
   * that happened to be minted with the same id — which cannot happen today,
   * because ids are uuids, and would be a silent one-in-nothing bug the day
   * anything about that changed. See `parkedUntil`.
   */
  forgetPark(job.id);
  /*
   * ── AND THE SESSION ON SOMEBODY ELSE'S MACHINE IS CLOSED, HERE, FOR THE SAME
   * REASON ──────────────────────────────────────────────────────────────────
   *
   * A Crucible placement holds a queue session for the length of the run
   * (`HeldSession`, electron/crucible-dispatch.ts), and while it is open nothing
   * from any other client runs on that machine. The requirement is that it be
   * closed on SUCCESS, FAILURE AND CANCEL alike — which is exactly the set of
   * endings that reach this function, and is why the close lives here rather
   * than in a `finally` around the spawn: there are three arms in `executeJob`
   * that settle without ever reaching one.
   *
   * FIRE AND FORGET, AFTER THE STOP. `release()` stops its own touching
   * synchronously and only then awaits the DELETE; a settle must not wait on
   * somebody else's server, and a close that fails logs itself and idles out.
   */
  const lease = sessions.get(job.id);
  if (lease !== undefined) {
    sessions.delete(job.id);
    /*
     * HELD, THOUGH STILL NOT AWAITED. The settle goes on without it — a run must
     * not wait on somebody else's server to be over — but the promise is kept in
     * `releasing` so a QUIT can wait for it, which is the one moment the DELETE
     * landing matters more than this row finishing (BookForge P9).
     */
    const given = lease.release();
    releasing.add(given);
    void given.finally(() => { releasing.delete(given); });
  }
  /*
   * AND THE GESTURE THAT ENDED IT IS FORGOTTEN HERE, for the lease's own reason
   * one line up: this is the one ending every path in this file reaches, and a
   * row id left in that set would hand its promise to whatever is minted next.
   */
  resumableStops.delete(job.id);
  const row = copyOf(job);
  for (const listener of [...settleListeners]) {
    try {
      listener(row);
    } catch (err) {
      console.error(
        `[queue] a settle listener threw for ${job.outputPath}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (lost) cascadeFrom(job);
}

/**
 * EVERYTHING CHAINED BEHIND A ROW THAT IS NOT COMING — cancelled and removed, by
 * name, transitively.
 *
 * ── The half of the ruling the derivation cannot do ─────────────────────────
 *
 * *"if that item is removed from the queue, anything under it also disappears."*
 *
 * The TREE half is free: a promise is drawn only where its parent is a real step or
 * another live promise, so the chain leaves the screen in the same repaint
 * (`admitPending`, shared/pending.ts). This is the QUEUE half, and it is real work
 * with a real request behind it: an export chained behind a cleanup that was just
 * removed is still a row the pump will happily start, and starting it would compile
 * the book WITHOUT the cleanup and file it under the name the cleaned one was going
 * to have. Repainting a tree does not stop an engine.
 *
 * ── REMOVED RATHER THAN LEFT AS A CANCELLED ROW ─────────────────────────────
 *
 * `remove`'s own argument, applied to a row nobody pressed anything on: *"a job
 * that never started spent nothing and produced nothing, and a `cancelled` row for
 * it is residue."* Owen's word is *disappears*, and a shelf that answered a removal
 * by growing three grey rows about it would be the app arguing with the gesture.
 *
 * THE REASON IS SAID ANYWAY, in the row's own `error`, before it goes. Nothing
 * draws it — the row is gone — but `settled` publishes the copy, which is how
 * `exportEpubFromStep` learns why the export it is awaiting will never arrive
 * (`unfiled` reads it). A host that asked for a book and gets "the cleanup it was
 * to be made from was removed from the queue" can say something true to its own
 * user; "was taken out of the queue before it ran" could not.
 *
 * A ROW ALREADY OVER IS LEFT ALONE. A done child is a thing that happened, and a
 * failed one has its own account of why — overwriting either with the parent's
 * story would be this app editing a record of something it did not cause.
 */
export function cascadeFrom(job: Job): void {
  const doomed: Job[] = [];
  const frontier = [job.id];
  while (frontier.length > 0) {
    const parent = frontier.pop()!;
    for (const row of jobs) {
      if (row.after !== parent) continue;
      if (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled') continue;
      if (doomed.includes(row)) continue;
      doomed.push(row);
      frontier.push(row.id);
    }
  }
  if (doomed.length === 0) return;
  const why = job.title ?? path.basename(job.outputPath);
  for (const row of doomed) {
    /*
     * A CASUALTY THAT HAS ALREADY GONE IS SKIPPED, and the case is real rather than
     * defensive. `settled` below re-enters this function for each row it settles, so
     * a grandchild is reached twice: once by the inner call, which cancels it, and
     * once by this loop, which collected it up front. Without this guard the second
     * pass would settle it a second time — two endings published for one row, which
     * is precisely what `onJobSettled` promises never happens, and which
     * `exportEpubFromStep` would resolve and then reject on.
     */
    if (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled') continue;
    /*
     * A RUNNING CASUALTY IS STOPPED THE WAY THE ✕ STOPS ONE. It cannot happen
     * through the pump — a row whose `after` is unfinished never starts — but it
     * can through `runJob`, where somebody else's scheduler chose the order. The
     * child is killed and the close handler settles the row, so this arm files
     * nothing itself and deliberately does not remove the row either: a run that
     * spent GPU is a `cancelled` record rather than residue, which is `remove`'s own
     * distinction.
     */
    if (row.state === 'running') {
      row.error = `“${why}” did not finish, so this could not be made from it.`;
      const stop = slots.get(row.id)?.cancel ?? detachedRuns.get(row.id);
      if (stop !== undefined) {
        stop();
        continue;
      }
    }
    row.state = 'cancelled';
    row.error = `“${why}” left the queue, so this had nothing left to be made from.`;
    row.finishedAt = Date.now();
    void sweepDerivedBook(requests.get(row.id));
    const index = jobs.indexOf(row);
    if (index >= 0) jobs.splice(index, 1);
    requests.delete(row.id);
    // The copy goes out with the reason on it, and the recursion finds nothing:
    // this row's own children were collected above and are already settled by the
    // time their turn comes.
    settled(row);
  }
  changed();
}
