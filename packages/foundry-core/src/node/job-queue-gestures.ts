/**
 * job-queue-gestures — what a person does to a row: start, release, wait, remove, cancel, clear; the mint's own row; and shutting down.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { completionMarkerFor, imagesDirFor } from './projects';
import type { Job } from '../shared/types';
import { computeSlots } from './crucible-registry';
import { ANY_SLOT } from '../shared/slots';
import { categoriesFileFor } from './job-queue-args';
import { pump } from './job-queue-board';
import { settled } from './job-queue-settling';
import { ourRow } from './job-queue-shelf';
import { changed, copyOf, detachedRuns, forgetPark, hostQueue, jobs, landings, liveRuns, releasing, requests, slots } from './job-queue-state';
import type { EngineRequest } from './job-queue-state';

/**
 * ONE GESTURE OFF THE SHELF, HANDED TO WHOEVER OWNS THE ROW.
 *
 * The four gestures below (`start`, `remove`, `cancel`, `clearFinished`) name a
 * row by id, and hosted those ids are the HOST's — off the host's own rows, which
 * are what the shelf drew. So there is nothing here to do locally and nothing to
 * fall back to: this app cannot cancel a row it never minted.
 *
 * AN ABSENT GESTURE IS SAID OUT LOUD. Each member of `FoundryHostQueue` past
 * `enqueue` is optional, so a host may offer a queue whose rows this window
 * cannot cancel — which is a complete thing for a host to say, and is not the
 * same as Foundry quietly cancelling something of its own instead. The console
 * line is the honest record of a press that had nowhere to go.
 */
export function forwardToHost(gesture: string, act: (() => void) | undefined): void {
  if (act === undefined) {
    console.error(
      `[queue] the app Foundry is running inside keeps its own queue and offers no ${gesture} `
      + 'for its rows, so that press did nothing here.',
    );
    return;
  }
  act();
}

/**
 * Release everything held, in the order it was added, and let the queue drain.
 *
 * EVERYTHING HELD AT THIS MOMENT, and nothing after it. A job enqueued while
 * these are running is held again and waits for the next press — Start is a
 * commitment to a batch somebody has just looked over, and a button that also
 * armed whatever arrived later would make the NEXT enqueue start a run nobody
 * pressed anything for.
 *
 * Returns how many it let go, so the caller can say so. Ordering is the array's,
 * which is insertion order, which is what the shelf shows: releasing is a state
 * change and never a reshuffle.
 *
 * HOSTED, IT IS THE HOST'S BATCH BEING RELEASED and the answer is 0 — which is
 * the literal truth rather than a shrug: zero of FOUNDRY's rows were released,
 * because hosted there are none to release. The count is used by the door to say
 * so in the shelf's own words, and the shelf hosted is drawing the host's list,
 * which the host's own push will correct a moment later.
 */
export function start(): number {
  const host = hostQueue();
  if (host !== null) {
    forwardToHost('Start', host.start?.bind(host));
    return 0;
  }
  let released = 0;
  for (const job of jobs) {
    if (job.state !== 'held') continue;
    job.state = 'queued';
    released += 1;
  }
  if (released === 0) return 0;
  changed();
  void pump();
  return released;
}

/**
 * RELEASE ONE HELD ROW BY NAME, and nothing else.
 *
 * ── Why this exists beside {@link start} rather than inside it ─────────────
 *
 * Start is a commitment to a BATCH somebody has just looked over — it releases
 * everything held at that moment, which is right for the shelf's own button and
 * wrong for a dialog. Owen, 2026-09-17, on the modals: *"the user can hit
 * 'start', 'add to queue', or 'cancel'. if they hit start, progress shows in the
 * modal live."* A dialog's Start means THIS run. Routing it through `start()`
 * would let go of every other row a person had deliberately parked, which is a
 * batch nobody pressed anything for — the exact failure `start`'s own comment
 * guards against one step further out.
 *
 * ANSWERS WHETHER IT LET GO, and false is not an error: the row may have been
 * released already, may have started, or may have been removed while the dialog
 * was open. All three mean "there is nothing here to release", and a caller that
 * is watching the run finds out what happened from the row itself.
 *
 * HOSTED IT FORWARDS, exactly as Start does, and answers false — zero of
 * FOUNDRY's rows were released because hosted there are none.
 */
export function release(id: string): boolean {
  /*
   * ── HOSTED, THERE IS NOTHING HERE TO RELEASE, AND NOTHING TO FORWARD ─────
   *
   * This first forwarded to `host.start()`, copying what `start()` does one
   * function up. That was wrong in the one way this door exists to avoid: the
   * host's Start releases the host's WHOLE held batch, so a dialog committing
   * to its own book would have let go of every row somebody had parked in
   * BookForge. Worse than the bug it was written to prevent, because the rows
   * belong to another app.
   *
   * It does not need forwarding at all. A hosted enqueue hands the request to
   * the host and answers with the HOST's row (see `enqueue`), and the host's own
   * pump decides when that runs — nobody presses Start for it. So the honest
   * answer is "no row of mine was released", which is the literal truth, and the
   * dialog watches the host's row regardless.
   */
  if (hostQueue() !== null) return false;
  const job = jobs.find((row) => row.id === id);
  if (job === undefined || job.state !== 'held') return false;
  job.state = 'queued';
  changed();
  void pump();
  return true;
}

/**
 * A ROUTING GESTURE THIS QUEUE WILL NOT PERFORM, with the reason as a NAME.
 *
 * The name is the contract and the sentence is the surface: BookForge throws the
 * same `venue_fixed_at_admission` from its own `setWaitFor`, agreed 2026-09-15,
 * so two queues refusing one state refuse it with one word. A caller that wants
 * to branch reads `code`; a caller that wants to tell somebody prints `message`,
 * which is already a whole sentence and needs nothing added to it.
 *
 * IT IS A THROW rather than a returned union because every OTHER outcome of
 * `setWaitFor` is "it happened", and an `{outcome}` union would make all three
 * callers unwrap a success they cannot act on. The two doors that a person
 * drives catch it; the push door does not, because there is nobody there to
 * tell (electron/ipc.ts says so at the handler).
 */
export class QueueRoutingRefusal extends Error {
  constructor(readonly code: 'venue_fixed_at_admission' | 'already_finished', message: string) {
    super(message);
    this.name = 'QueueRoutingRefusal';
  }
}

/** What the shelf calls a row — `labelFor`'s fallback, in one place. */
export function rowName(job: Job): string {
  return job.title ?? path.basename(job.outputPath);
}

/**
 * SEND THIS ROW SOMEWHERE ELSE — the picker's one gesture.
 *
 * ── Only a row that has not started ────────────────────────────────────────
 *
 * docs/SLOTS.md §3: *"jobs never start on one slot and finish on another. its
 * atomic."* A `running` row has an engine talking to a server, a records file
 * filling up with that server's answers, and a stamp about to record the model
 * that produced them; moving it would mean one book translated by two machines
 * and one file claiming both.
 *
 * ── IT USED TO REFUSE SILENTLY, AND THE RACE IS WHY THAT WAS WRONG ─────────
 *
 * The argument for silence was *"the picker is not drawn on a running row, and
 * this is the door behind that"* — a guard behind a control nobody is offered.
 * That holds for a row somebody can see is running. It does NOT hold for the one
 * case that actually reaches here: the picker IS drawn on a `queued` row, and
 * since `3b13392` a start *"marks running before its first await"*, so the pump
 * can admit that row between the frame a person read and the message their click
 * sent. The edit then vanished — no change, no sentence, and a picker still
 * showing the machine they had just chosen.
 *
 * So a row that has started refuses BY NAME, and the name is BookForge's:
 * `venue_fixed_at_admission`, agreed 2026-09-15 so that two queues describe one
 * state with one word. Their sentence says the three things a person needs —
 * what took it, that nothing was altered, and the way out — and this says the
 * same three in Foundry's vocabulary.
 *
 * A FINISHED ROW GETS ITS OWN SENTENCE rather than that one. "A GPU took it
 * before your change arrived" is false about a row that ran an hour ago, and a
 * refusal that misdescribes why is worse than none.
 *
 * ── A PARKED ROW IS FREED THE MOMENT IT IS REASSIGNED ──────────────────────
 *
 * The backoff is about the server that turned this row away, and the person has
 * just named a different one. Making them wait out a thirty-second timer for a
 * decision they made with a click would be the app arguing with the gesture, so
 * `forgetPark` runs and the pump looks again immediately.
 *
 * ── Hosted, the row is the host's ──────────────────────────────────────────
 *
 * `remove`'s rule exactly: the id came off a row the host pushed, and there is
 * no row of ours by that name. Nothing is forwarded, because the host's queue
 * has its own placement and its own picker — Foundry does not have an opinion
 * about where somebody else's scheduler sends its work.
 */
export function setWaitFor(id: string, waitFor: string): void {
  const job = jobs.find((row) => row.id === id);
  if (job === undefined) return;
  if (job.state === 'running') {
    throw new QueueRoutingRefusal(
      'venue_fixed_at_admission',
      `"${rowName(job)}" was taken by a GPU on ${job.ranOn ?? 'a server'} before this change `
      + 'arrived, and a book finishes on the machine it started on. Nothing has been '
      + 'altered. Cancel it and add it again to send it somewhere else.',
    );
  }
  if (job.state !== 'held' && job.state !== 'queued') {
    throw new QueueRoutingRefusal(
      'already_finished',
      `"${rowName(job)}" has already ${job.state === 'cancelled' ? 'been cancelled' : 'finished'}, `
      + 'so there is nowhere left to send it. Add it again to run it somewhere else.',
    );
  }
  const wanted = waitFor.trim();
  if (wanted.length === 0 || wanted === job.waitFor) return;
  /*
   * A NAME THAT IS NOT A SLOT IS REFUSED, and `any` is the one reserved word
   * that is not a slot and is always allowed.
   *
   * The picker can offer a STALE name — a row waiting for a server that was
   * switched off keeps it in the list so the select does not silently show
   * something else — but choosing it again is the no-op above, so nothing
   * legitimate reaches here with an unknown name. What this refuses is a message
   * that did not come from a picker, and refusing it is the conservative
   * direction: a typo'd name would be a row that waits forever for nothing.
   */
  if (wanted !== ANY_SLOT && !computeSlots().some((slot) => slot.name === wanted)) return;
  job.waitFor = wanted;
  /*
   * THE SENTENCE ABOUT THE OLD SLOT GOES WITH IT. `message` was "waiting for the
   * Mac, which is switched off"; leaving that on a row that is now waiting for
   * something else would be the shelf reporting a wait that has been resolved.
   */
  if (job.state === 'queued' && job.message !== undefined) delete job.message;
  forgetPark(id);
  changed();
  void pump();
}

/**
 * EVERY ROW OF OURS THAT NAMES THIS SLOT — what the Servers card shows somebody
 * before it changes anything.
 *
 * Owen's rule for a server being switched off is that the rows naming it are
 * SURFACED, never moved: *"told, never moved silently"*. So this answers the
 * question and does nothing about it, and the one-click fix in the card is
 * `setWaitFor` called once per row with {@link ANY_SLOT} — which is a gesture
 * with a person behind it, like every other thing that changes a row.
 *
 * RUNNING ROWS ARE NOT INCLUDED, on `setWaitFor`'s rule: they cannot be moved
 * and offering them in a list of things about to be moved would be a lie about
 * what the button does. A run against a server somebody just switched off
 * finishes against it; switching a server off in a settings card is not a
 * cancel, and the row's ✕ is where a cancel lives.
 */
export function rowsWaitingFor(slotName: string): Job[] {
  return jobs.filter(
    (job) => job.waitFor === slotName && (job.state === 'held' || job.state === 'queued'),
  ).map(copyOf);
}

/**
 * Take a row out of the list entirely. Held and queued only.
 *
 * NOT A CANCEL, AND THE DIFFERENCE IS THE WHOLE REASON THIS EXISTS. `cancel`
 * settles a job as `cancelled`, which is the right record of a run that was
 * stopped — somebody spent GPU on it and then took it back. A job that never
 * started spent nothing and produced nothing, and a `cancelled` row for it is
 * residue: it sits in the shelf, it counts towards "finished", and it has to be
 * cleared by hand to make the list readable again. Removing an unwanted batch
 * item should leave the shelf looking like it was never added, because it was
 * never anything.
 *
 * A RUNNING job is refused here. There is a child holding a GPU, and the gesture
 * for that is `cancel` — which stops it and then, correctly, files it.
 *
 * "IT WAS NEVER ANYTHING" IS NOW TRUE OF THE DISK AS WELL, and it was not always.
 * A held translation had already moved the project's previous edition into
 * `generated/archived-<stamp>/` — at plan time, before this row existed — so
 * removing it left the catalogue pointing into an archive folder for a run that
 * never spawned, and this function had nothing to put back because nothing
 * remembered the move. Both rotations happen in `pump()` now, one line before the
 * engine starts, so a row removed from here has touched no file at all and there
 * is nothing for a removal to undo.
 *
 * HOSTED, THE ROW IS THE HOST'S AND SO IS THE REMOVAL. The id came off a row the
 * host pushed; there is no row of ours by that name, and searching for one would
 * be this app answering a question about somebody else's list. WITH ONE
 * EXCEPTION AS OF 17c, and it is an exception to the premise rather than to the
 * rule: a hosted shelf also draws the rows that never routed -- our env
 * installs, and now our mints -- so an id off that shelf can be one of ours
 * after all. `neverRouted` is the whole of the test and carries the argument.
 */
export function remove(id: string): void {
  const host = hostQueue();
  if (host !== null && !ourRow(id)) {
    forwardToHost('remove', host.remove === undefined ? undefined : () => { host.remove?.(id); });
    return;
  }
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return;
  const job = jobs[index]!;
  if (job.state !== 'held' && job.state !== 'queued') return;
  jobs.splice(index, 1);
  requests.delete(id);
  changed();
  /*
   * The row is gone rather than finished, and anybody waiting on it has to hear
   * that too — see `onJobSettled`, which counts this as an ending because for a
   * waiter it is the only one it will ever get.
   *
   * `true` IS OWEN'S HEADLINE CASE. The row is still `held` or `queued` here — it
   * never ran, so its state never moved — which makes this the one ending whose
   * loss cannot be read off the row. *"if i then remove the cleanup step from the
   * queue … everything under that grayed out chain also gets removed."* See
   * `settled`'s second parameter and `cascadeFrom`.
   */
  settled(job, true);
  /*
   * Removing can be the thing that empties the queue, and the drain signal lives
   * in pump()'s nothing-to-do branch — which nothing else would visit. Same
   * reasoning as `cancel`'s trailing pump, and the same consequence if it is
   * left out: the reading server stays up with nothing to read for it.
   */
  void pump();
}

/**
 * Cancel: kill the child if it is this job's, drop it from the queue if it is
 * not. Both end as `cancelled`, because from the shelf they are one gesture.
 *
 * A HELD JOB IS NOT CANCELLABLE AND FALLS THROUGH HERE DOING NOTHING, which is
 * deliberate rather than an oversight. Nothing was started, so there is nothing
 * to stop and no record worth keeping; the gesture for a batch item somebody has
 * changed their mind about is `remove`, which leaves no row behind. The shelf
 * routes accordingly and this stays the operation for a run that is under way.
 *
 * THE ROUTED DOOR, with `cancelHere` below it. Hosted, the ✕ names one of the
 * host's rows and the host is the only side that can stop it — even for work
 * that is running through `runJob` at this moment, because the host asked for
 * that run and holds the row people are looking at. Foundry's own gestures on
 * its own rows (the abort signal a `runJob` carries)
 * go to `cancelHere` and cannot be routed away.
 */
export function cancel(id: string): void {
  const host = hostQueue();
  // A row of ours is ours however this window is hosted, and its ✕ is reachable
  // in the hosted shelf because that shelf now draws it — see `ourRow`.
  if (host !== null && !ourRow(id)) {
    forwardToHost('cancel', host.cancel === undefined ? undefined : () => { host.cancel?.(id); });
    return;
  }
  cancelHere(id);
}

/**
 * Cancel one of FOUNDRY's OWN rows, whoever is hosting — the internal door.
 *
 * ── The two live children, and why the lookup has two halves ────────────────
 *
 * `slots` is the pump's board: the jobs THIS scheduler decided to run, each
 * holding a lane. A run started by `runJob` is NOT on it — it was scheduled by
 * somebody else and must not wait behind, or be waited behind by, the internal
 * queue — so its cancel lives in `detachedRuns` beside it. Both are "the child
 * this row is", and a cancel asks for whichever one this row has. Standalone
 * `detachedRuns` is always empty and this reads exactly as it always did.
 *
 * A SLOT WITH NO CHILD IN IT ANSWERS NULL AND FALLS THROUGH, which is the same
 * answer the single slot gave by being null at the same two moments: while a
 * reading waits for its server, and after the last child has exited with the
 * landings still running. `??` treats that null exactly as it treated an absent
 * slot, so the branch below settles the row itself — which is what keeps the ✕
 * alive through the minutes a server takes to come up.
 */
/*
 * ── THE MINT ROW, WHICH IS A ROW AND NOT A JOB THE PUMP RUNS ────────────────
 *
 * A mint is minutes of work and it belongs on the shelf with progress and a
 * cancel, exactly like a read. It must NEVER occupy a slot.
 *
 * WHY NOT, PRECISELY. `pump` rations the lanes because the engine is a process
 * against a card and a disk: two reads at once are slower than two reads in a
 * row. A mint is neither — the rasterizing happens in the RENDERER, driven by a
 * person who is watching it, and main only assembles what arrives. Putting it in
 * a lane would mean a read queued behind somebody cropping photographs waits for
 * them to finish, and a mint queued behind a full lane cannot start until that
 * lane frees, which for an interactive stage reads as the button being broken.
 * The table says so in its own words: a mint is `unscheduled`
 * (shared/queue-board.ts).
 *
 * THE MECHANISM IS THE STATE AND NOT A FLAG. `pump` selects `state === queued`
 * and nothing else, so a row born `running` is invisible to it — no exclusion
 * list to keep up to date, no second gate to remember. The same trick the hold
 * uses in reverse, and it means a mint and a read genuinely run at once.
 *
 * The retired `env-install` was the precedent for a row the OCR panel never
 * enqueued, and this departs from it in exactly one way: an install DID take slots — every
 * one of them (`pump` dispatches it as `exclusive`), because an install and a
 * read compete for the same disk, the same network and the same Python. A mint
 * competes with nothing.
 */
export function beginMint(projectDir: string, title: string, pages: number): string {
  const job: Job = {
    id: randomUUID(),
    // No document exists yet — that is what this row is making. The project
    // directory is what the shelf can usefully reveal.
    inputPath: projectDir,
    outputPath: projectDir,
    kind: 'mint',
    title,
    // BORN RUNNING. See above: `queued` would put it in the pump's path, and
    // `held` would wait for a start gesture that already happened.
    state: 'running',
    // `render` because that is literally the pass: the renderer is rasterizing
    // page quads, and the shelf already knows how to say "page 3/27: rendered".
    progress: { page: 0, total: pages, phase: 'render' },
    createdAt: Date.now(),
  };
  jobs.push(job);
  changed();
  return job.id;
}

/** One more page is in the book. */
export function noteMintPage(id: string, page: number): void {
  const job = jobs.find((row) => row.id === id);
  if (job === undefined || job.state !== 'running') return;
  job.progress = { page, total: job.progress?.total ?? page, phase: 'render' };
  changed();
}

/**
 * Has somebody pressed the ✕ on this mint?
 *
 * THE MINT ASKS RATHER THAN BEING TOLD, because the work is happening on the
 * other side of the bridge: `cancelHere` can set this row to `cancelled` in a
 * microsecond, but the renderer is midway through rasterizing a page and will
 * keep sending. So the session checks this as each page arrives and refuses the
 * next one — the cancel takes effect within one page rather than instantly, and
 * nothing has to reach into the renderer to stop it.
 */
export function mintCancelled(id: string): boolean {
  const job = jobs.find((row) => row.id === id);
  return job === undefined || job.state === 'cancelled';
}

/** The mint finished, or it did not. */
export function settleMint(id: string, outcome: { file: string } | { error: string }): void {
  const job = jobs.find((row) => row.id === id);
  if (job === undefined || job.state !== 'running') return;
  if ('file' in outcome) {
    job.state = 'done';
    job.outputPath = outcome.file;
    job.progress = { page: job.progress?.total ?? 0, total: job.progress?.total ?? 0, phase: 'render' };
  } else {
    job.state = 'failed';
    job.error = outcome.error;
  }
  job.finishedAt = Date.now();
  changed();
  settled(job);
}

export function cancelHere(id: string): void {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  if (landings.has(id)) {
    /*
     * THE RUN IS LANDING, SO THE ENDING IS ALREADY ITS OWN — `landings` carries
     * the whole argument. There is nothing to stop: the engine has exited, the
     * product is where the row says it will be, and the row is a moment away
     * from settling with what actually happened. Said out loud rather than
     * silently, because a person who pressed ✕ and got a finished job is owed an
     * account of why somewhere.
     */
    console.log(
      `[queue] the ✕ on ${path.basename(job.outputPath)} arrived after the engine had finished; `
      + 'the run is filing what it made and will settle with that.',
    );
    return;
  }
  if (job.state === 'running') {
    const stop = slots.get(id)?.cancel ?? detachedRuns.get(id);
    if (stop !== undefined) {
      stop();
      return; // the close handler settles the state
    }
  }
  // Queued, or running-but-not-yet-spawned: a job waiting for the reading
  // server to come up is `running` with no child of its own, and a cancel that
  // did nothing there would leave the button dead for the minutes that takes.
  if (job.state === 'queued' || job.state === 'running') {
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    // The derived book this export was going to be compiled from, if it never
    // got as far as the settle that normally sweeps it. Nothing else will ever
    // mention that file again — see `sweepDerivedBook`.
    void sweepDerivedBook(requests.get(job.id));
    changed();
    settled(job);
    // A cancel can be the thing that empties the queue, and the drain signal
    // lives in pump()'s nothing-to-do branch — which nothing else would visit.
    void pump();
  }
}

/**
 * A CANCELLED READING KEEPS NOTHING — the pages go with the press.
 *
 * ── Owen's ruling, 2026-09-18 ───────────────────────────────────────────────
 *
 * *"when i fully cancel a read, i want nothing kept — back to Pending, same
 * settings, start over from page one."* Put to him with the cost stated plainly
 * (a stop on page 140 of 156 re-buys the whole book, and there is no undo) and
 * reaffirmed. So this is the ending that destroys, and it is the only one in this
 * file that does.
 *
 * A FAILURE IS NOT A CANCEL AND IS NOT TOUCHED. `--fresh` aside, the whole bank
 * lifecycle exists so that a run that DIED leaves its pages resumable
 * (docs/BANK-LIFECYCLE.md §2: *"a dead run leaves the old bank untouched and the
 * pending file as resumable debris. That is the entire point."*). A crashed read
 * that threw away three hours because the engine segfaulted would be the same
 * defect this feature is meant to fix, pointed the other way. Only `cancelled`
 * reaches here, which is a person's press and nothing else.
 *
 * ── THE TWO GUARDS, AND WHY THEY ARE NOT PARANOIA ───────────────────────────
 *
 * A re-read with the same params does NOT write a new bank — `bankForReading`
 * aims it at the existing step's payload and the engine protects the finished
 * answers by writing a PENDING bank beside them and swapping on success
 * (docs/BANK-LIFECYCLE.md §2.2). So at the moment a re-read is cancelled there
 * are two banks on disk and exactly one of them is this run's. Deleting by the
 * name on the request would destroy a COMPLETED reading somebody already paid
 * hours for, to satisfy a gesture about the run that had not finished.
 *
 * So: A PENDING FILE MEANS THE REAL BANK IS SOMEBODY ELSE'S FINISHED WORK. Only
 * the pending pair goes, and the completed reading is left exactly as it was —
 * which is also precisely what "start over from page one" means in that case,
 * because the next re-read opens a fresh pending.
 *
 * AND A COMPLETION MARKER WITH NO PENDING IS A FINISHED BANK THIS RUN WAS NOT
 * WRITING. That pair should be unreachable — §2.2 sends every re-read of a
 * completed bank down the pending path — so it is a state this file does not
 * understand, and the answer to not understanding the disk is to touch none of
 * it and say so. The cost of being wrong in the other direction is somebody's
 * book.
 *
 * ── THE PATH IS THE REQUEST'S AND IS NEVER COMPOSED ─────────────────────────
 *
 * `request.readingsPath`, resolved at the plan by `bankForReading`. Composing
 * `readings/<key>.jsonl` here is the exact defect `readingBank` exists to fix —
 * a project holds two banks the moment a re-read branches — and composing it in
 * order to DELETE it is that bug with the consequence turned up.
 *
 * Best effort and never a throw: the row has already settled as cancelled, and a
 * file that will not unlink must not turn a person's stop into a failure.
 */
export async function discardCancelledReading(request: EngineRequest | undefined): Promise<void> {
  if (request === undefined || request.kind !== 'read') return;
  const bank = request.readingsPath;
  /*
   * `<bank>.jsonl.pending` and its sidecar — the ENGINE's spelling
   * (`pendingPath`/`pendingRequestPath`, src/vlm/readings.ts), mirrored here on
   * `shared/records.ts`' grow-together rule because the app never imports the
   * engine. Suffixed rather than renamed so a pending file can never be mistaken
   * for a bank; if that spelling moves, it moves in the same commit as this.
   */
  const pending = `${bank}.pending`;
  const pendingRequest = `${pending}.request`;

  try {
    if (existsSync(pending) || existsSync(pendingRequest)) {
      await fsp.rm(pending, { force: true });
      await fsp.rm(pendingRequest, { force: true });
      console.log(
        `[queue] the cancelled re-reading's pending pages were discarded; the finished reading at `
        + `${path.basename(bank)} is untouched, because that one is not what was cancelled.`,
      );
      return;
    }
    if (existsSync(completionMarkerFor(bank))) {
      console.error(
        `[queue] ${path.basename(bank)} carries a completion marker and has no pending beside it, `
        + 'so a finished reading is sitting where this cancelled run was supposed to be writing. '
        + 'Nothing was discarded — that state is one this build does not understand, and the '
        + 'cautious answer is the only safe one.',
      );
      return;
    }
    await fsp.rm(bank, { force: true });
    await fsp.rm(completionMarkerFor(bank), { force: true });
    await fsp.rm(imagesDirFor(bank), { force: true, recursive: true });
    console.log(
      `[queue] the cancelled reading kept nothing: ${path.basename(bank)}, its marker and its page `
      + 'crops are gone, and the next read starts at page one (Owen, 2026-09-18).',
    );
  } catch (err) {
    console.error(
      `[queue] the cancelled reading's pages could not all be discarded `
      + `(${err instanceof Error ? err.message : String(err)}). A re-read will resume from `
      + 'whatever survived rather than starting over.',
    );
  }
}

/**
 * The book main materialised for an export, removed.
 *
 * ── Why it goes, and why it goes on failure too ─────────────────────────────
 *
 * It is scratch: a pure function of the reading's own book file and a chain in
 * the ledger, made when the button was pressed and remade for nothing whenever it
 * is wanted again (docs/RENDERER.md §4 — derived book files are `regenerable`
 * retention). Nothing catalogues it, nothing can open it twice, and its name is a
 * uuid in a temp directory.
 *
 * KEEPING THE FAILED ONE IS DELIBERATELY NOT DONE. The engine's refusal names
 * the block it choked on, in words, in the terminal that is already open — that is
 * what somebody debugs from, and a copy of a book under a uuid is not.
 *
 * BEST EFFORT AND NEVER A THROW: an export that produced a book is not a failure
 * because a scratch file would not unlink, and a cancel is not a failure at all.
 */
export async function sweepDerivedBook(request: EngineRequest | undefined): Promise<void> {
  if (request === undefined || request.kind === 'read') return;
  /*
   * AN ANALYSIS LEAVES A SECOND SCRATCH FILE and it goes at the same moment, for
   * the same reason: the checklist beside the report was written at the spawn so
   * a path could be put on the command line, and once the run has settled nothing
   * will ever mention it again. It is a pure function of the step's own params,
   * remade for nothing whenever it is wanted, and leaving it would put an
   * unnamed file in a retained-payload folder — the one thing the `analysis/`
   * layer's own docblock says must not happen there.
   */
  if (request.kind === 'analysis') {
    try {
      await fsp.rm(categoriesFileFor(request), { force: true });
    } catch (err) {
      console.error(`[job] the analysis checklist could not be removed: ${(err as Error).message}`);
    }
  }
  // A TRANSLATION HAS ONE TOO, and it always has one: the book it read is the
  // position materialised (`TranslateRequest.bookPath`), scratch on exactly the
  // terms an export's is. It was excluded here while a translation read a cast.
  if (request.bookPath === undefined) return;
  try {
    await fsp.rm(request.bookPath, { force: true });
  } catch (err) {
    console.error(
      `[job] the derived book ${request.bookPath} could not be removed: ${(err as Error).message}`,
    );
  }
  /*
   * AND THE NARROWED STAMP THAT WAS WRITTEN BESIDE IT, when one was
   * (`narrowedStamp`, electron/workspace.ts): it is named after the derived book
   * and is scratch on exactly the same terms — one export's withdrawal of a claim
   * over the blocks a merge composed, meaningless the moment that book is gone.
   * The CLEANUP'S OWN stamp is never this path: it lives in `readings/` beside the
   * answers it is a receipt for, and this only ever names a file under the derived
   * directory, because that is the only place this app composes the name.
   */
  const narrowed = `${request.bookPath.slice(0, -'.book.jsonl'.length)}.stamp.json`;
  if (!request.bookPath.endsWith('.book.jsonl')) return;
  try {
    await fsp.rm(narrowed, { force: true });
  } catch (err) {
    console.error(
      `[job] the narrowed narration stamp ${narrowed} could not be removed: `
      + `${(err as Error).message}`,
    );
  }
}

/**
 * Clear everything that has stopped. The running job, the queue and the HELD
 * batch all survive.
 *
 * `held` joins `queued` and `running` on the survivor list for the obvious
 * reason and one less obvious one: a held job has not stopped, so it is not
 * "finished" by any reading — and it is also the only state a user can be
 * accumulating deliberately. A Clear that swept away the batch somebody was
 * halfway through assembling would be the most expensive button in the app.
 *
 * ── HOSTED IT DOES BOTH, WHICH IS NOT A FALLBACK ────────────────────────────
 *
 * The press is forwarded, because the rows on screen are the host's and clearing
 * them is the host's to do. And then Foundry's own finished rows are cleared as
 * well — not as a second guess at the same list, but because there IS a second
 * list hosted and it is invisible: every job the host runs through `runJob` mints
 * a row here, and those rows would otherwise accumulate for the life of the
 * process with nothing in the window able to reach them. One press, two lists,
 * neither of them the other's answer.
 */
export function clearFinished(): void {
  const host = hostQueue();
  if (host !== null) {
    forwardToHost('Clear finished', host.clearFinished?.bind(host));
  }
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job && job.state !== 'held' && job.state !== 'queued' && job.state !== 'running') {
      if (chainStillLive(job.id)) continue;
      requests.delete(job.id);
      jobs.splice(i, 1);
    }
  }
  changed();
}

/**
 * IS ANYTHING STILL CHAINED BEHIND THIS ROW — the one row Clear finished leaves.
 *
 * ── Why a done row can still be load-bearing ────────────────────────────────
 *
 * A finished cleanup with a promised export behind it is over as work and NOT over
 * as a chain: the export's `after` names it, and `chainVerdict` reads that name off
 * the list. Sweep the parent and the link goes `unknown`, which sends the export
 * through `reconcileChains` and a ledger read to learn what the row it just lost
 * could have told it for nothing. That path is correct — it is exactly the case it
 * was written for — but paying a file read to answer a question the shelf was
 * holding is the wrong way round, and the window between the sweep and the
 * reconcile is one in which the chain's state is unresolved.
 *
 * AND THE PERSON SHOULD SEE THE CHAIN WHOLE. This is the reason that survives the
 * mechanics. Somebody who cleaned a book and queued its export and its narration is
 * looking at a chain of three; a Clear that took the finished cleanup out would
 * leave two rows describing work whose reason had just been swept off the screen.
 * The tree draws the promises either way — it derives their place from the step id
 * on the row, not from the parent's presence — but the SHELF is where the person
 * watches the batch run, and a batch is a thing you watch whole.
 *
 * IT MIRRORS BOOKFORGE'S OWN RULE, which is worth saying because the two lists are
 * drawn in one window: a settled row is swept only when everything chained under it
 * has settled too. Two queues with two Clear rules would make the same press behave
 * differently depending on which of them happened to own the parent.
 */
export function chainStillLive(id: string): boolean {
  const reached = new Set([id]);
  for (;;) {
    let grew = false;
    for (const row of jobs) {
      if (row.after === undefined || !reached.has(row.after) || reached.has(row.id)) continue;
      if (row.state === 'held' || row.state === 'queued' || row.state === 'running') return true;
      reached.add(row.id);
      grew = true;
    }
    if (!grew) return false;
  }
}

/**
 * Quit, or a window closing on us: nothing is left holding a GPU.
 *
 * BOTH KINDS OF LIVE CHILD, because there are two: whatever this scheduler has
 * on the board and whatever a host's scheduler has running through `runJob`. A
 * quit that stopped only the first would leave the host's reading holding twenty
 * gigabytes with nothing left to report to — which is the exact hazard this
 * function exists for, arriving through the newer door.
 *
 * EVERY SLOT, NOT THE SLOT. This used to be one `running?.cancel()` because
 * there was one slot; a board that stopped only the first row it found would
 * leave a second engine writing into a project while the app disappeared from
 * around it. A slot whose child has not spawned yet holds null and is skipped —
 * there is nothing to kill, and the process is going away regardless.
 */
export function shutdown(): void {
  for (const slot of [...slots.values()]) slot.cancel?.();
  slots.clear();
  for (const stop of [...detachedRuns.values()]) stop();
  detachedRuns.clear();
}

/**
 * EVERY LIVE RUN, AND EVERY LEASE IT IS GIVING BACK — the promise a quit can wait on.
 *
 * ── The deadline that was never used (BookForge P9) ────────────────────────
 *
 * `shutdown()` above is synchronous: it kill-trees the children and returns. The
 * host's quit chain wraps `stopFoundry()` in a 45-second budget, and
 * `stopFoundry` answered `Promise.resolve()` — so the budget bounded nothing, and
 * the app went on to exit while the settle that RELEASES THE CRUCIBLE LEASE was
 * still a continuation nobody was holding. A lease left behind is a card no other
 * client can load onto until its TTL expires.
 *
 * ── What it waits for, and why it is two sets ──────────────────────────────
 *
 * THE RUNS. One entry per `executeJob`, added at the top and removed in its
 * `finally`, so it covers the pump's rows and a host's detached ones with one
 * rule — the same reason `executeJob` is one function.
 *
 * THE RELEASES. `settled` fires the DELETE and does not await it, deliberately:
 * a settle must not wait on somebody else's server. That is right while the app
 * is alive and wrong at the moment it exits, which is the only moment this
 * function is called — so the release promises are held here and awaited too.
 *
 * NEVER THROWS, and it is a loop rather than one `Promise.all` because a run that
 * settles may start nothing but may still ADD a release. Settling is what both
 * sets do, so the loop terminates; the caller's own deadline is what bounds a
 * machine that has stopped answering.
 */
export async function drained(): Promise<void> {
  while (liveRuns.size > 0 || releasing.size > 0) {
    await Promise.allSettled([...liveRuns, ...releasing]);
  }
}
