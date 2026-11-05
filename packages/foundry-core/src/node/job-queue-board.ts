/**
 * job-queue-board — the scheduler: which lane a row takes, which row starts next, and the pump.
 */
import * as path from 'node:path';
import { ledgerOf, projectDirOf, readManifest } from './projects';
import { CPU_LANE_SLOTS, JOB_RESOURCE, computeLanes, localLane, type ComputeLane } from '../shared/queue-board';
import type { Job, RunPlacement } from '../shared/types';
import { computeSlots } from './crucible-registry';
import { placesOnASlot } from './crucible-dispatch';
import { cancel, release, sweepDerivedBook } from './job-queue-gestures';
import { executeJob } from './job-queue-placing';
import { deferralOf, homeOf } from './job-queue-products';
import { settled } from './job-queue-settling';
import { shelfJobs } from './job-queue-shelf';
import { changed, jobs, parkedUntil, requests, slots } from './job-queue-state';
import type { Slot } from './job-queue-state';

/*
 * `withoutExport` USED TO LIVE HERE and went with the first stage of a
 * translate-descended export.
 *
 * That job was three runs: render the book into a nameless EPUB, translate it,
 * then tidy the translation into an edition. The middle run reads the very stamps
 * an edition withholds (FINAL_NEEDS_STAMPS, src/translate/book.ts), so the FIRST
 * run had to be handed a copy of the request with `export` taken off it — visible
 * to the settle that files the product, invisible to the `argsFor` that would have
 * asked the engine for an edition it was about to hand the translator.
 *
 * One run makes both now: the records go into the blocks at the assembly, upstream
 * of everything `--final` decides, so the stored request reaches `argsFor` exactly
 * as it was stored and there is nothing left to hide from anybody.
 */

/*
 * `endpointFor()` WENT WITH THE FALLBACK IT FED (2026-09-17).
 *
 * It answered the settings file's `backend.endpointUrl`, in `endpoint` mode
 * only, and its one caller used that to decide whether to start Foundry's own
 * page reader for a reading with no placement. Owen: *"there sohuldnt be a
 * local system. foundry does all ai work through crucible."* With no local
 * reader to start, a URL in that file names nothing this app would dial, and a
 * reader with no caller is a question nobody asks.
 */

/*
 * `starting` USED TO LIVE HERE, and the board is why it does not any more.
 *
 * It was a boolean, true from the moment `pump()` chose a row until its engine
 * child was recorded in `running` — because the reading server's wait sits
 * between those two points as an await, and it was the one window in which a
 * second `pump()` could see an empty slot, find the next queued job, and put two
 * engines on one card. A slot is taken at the moment of CHOOSING now, before any
 * await, so that window is closed by the occupancy that the next pump reads
 * anyway. One fact instead of two that had to agree, and one less variable for
 * an early-return path to leave set.
 */

/**
 * WHICH LANE THIS ROW WILL HOLD, when that is knowable before the walk — or null
 * for a row the walk decides for, and for every row that holds no compute lane.
 *
 * ── Two of the three answers are knowable, and reserving them is the point ──
 *
 * `pump` picks rows in a SYNCHRONOUS loop, so two rows can be chosen before
 * either of them has reached its first await. If the lane were only ever claimed
 * inside the walk, two readings would both be picked against one free local lane
 * and the second would discover the collision minutes later, park, and wear a
 * sentence about a machine it was never going to get. So the answers that do not
 * need a server are settled here, before the pick:
 *
 *   * A ROW THAT IS NEVER PLACED holds the LOCAL lane — `placesOnASlot` is that
 *     test and lives beside the switch that decides half of it. An export never
 *     gets here (it is not a GPU row at all); what does is a job whose dispatch
 *     this app does not route, and if it held no lane the board would start a
 *     translation on the same card.
 *   * A BOARD WITH ONE LANE holds it, whatever the row says. One machine and one
 *     answer: the walk would claim the same lane, and reserving it before the
 *     pick is what keeps two rows in ONE synchronous pump pass apart. This is
 *     every hosted window (`computeLanes` answers an empty slot list with the
 *     local lane) and every desk with no Crucible.
 *   * EVERYTHING ELSE answers null: the walk picks, and the walk claims.
 *
 * ── A PINNED ROW USED TO RESERVE HERE, AND NO LONGER CAN (Wave 62) ─────────
 *
 * It returned `job.waitFor`, which was right while a slot was one lane. A
 * Crucible slot is TWO now — its card, and the `[cloud]` lane an upstream-routed
 * act takes (`upstreamLaneName`, shared/queue-board.ts) — and WHICH of them a row
 * belongs in is a fact only that server's capability row knows. Reserving the
 * card here would hold a GPU for the length of a network read that was going to
 * end somewhere else entirely, and then keep holding it for the whole run. So the
 * pinned path claims where the `any` path claims: inside the walk, after the
 * route is read (`placeOn`, electron/crucible-dispatch.ts, whose note argues the
 * move in full).
 *
 * WHAT THAT COSTS is that two rows pinned to one machine can both be picked in
 * one pass. The second reaches the claim, is refused, and parks with the walk's
 * own sentence and the ordinary backoff — which is exactly what two `any` rows
 * have always done. What still cannot happen is two runs on one card.
 */
export function laneAtPick(job: Job, lanes: readonly ComputeLane[]): string | null {
  if (JOB_RESOURCE[job.kind] !== 'gpu') return null;
  /*
   * A GPU ROW THAT IS NEVER PLACED TAKES THIS MACHINE'S CARD, when one of the
   * lanes IS this machine's card — which since Wave 66 means a Crucible
   * registered at a loopback address, there being no local slot any more. NULL
   * when there is none: there is no lane to reserve, and inventing a name for one
   * would be a reservation against a machine the board does not have.
   *
   * THE ARM IS UNREACHABLE WHILE `CRUCIBLE_READS` IS TRUE and is kept for the
   * reason it was written: it is the constant that decides it, not a fact about
   * the kind. Every GPU kind has a capability class today, so `placesOnASlot` is
   * true for all of them; the day a reading goes back on the local path, this is
   * the line that keeps two of them off one card.
   */
  if (!placesOnASlot(job.kind)) return localLane(lanes)?.name ?? null;
  if (lanes.length === 1) return lanes[0]!.name;
  return null;
}

/** Is any run holding that lane right now? The occupancy, asked by name. */
export function laneTaken(lane: string): boolean {
  for (const slot of slots.values()) if (slot.on === lane) return true;
  return false;
}

/**
 * IS THERE ROOM FOR THIS ROW RIGHT NOW — the whole of the rationing.
 *
 * ── The four answers, and why an install is not simply another lane ─────────
 *
 * The CPU LANE has room when fewer than `CPU_LANE_SLOTS` are held. The GPU side
 * is not a lane but a LANE PER COMPUTE SLOT (`computeLanes`,
 * shared/queue-board.ts): a row may start when there is a lane it could take,
 * which is why this takes the row and not just its resource — a row pinned to the
 * Mac and a row pinned to this desk are asking two different questions, and the
 * answer to one of them is not the answer to the other. That is the whole of
 * Package G in the scheduler: before it, a busy local card stopped a queued row
 * that was only ever going to run in another room.
 *
 * AN INSTALL needs the whole board, because a conversion that starts against a
 * Python being replaced is the one failure the shared queue was built to prevent
 * — see the header. And `unscheduled` cannot get here from a queued row at all (a
 * mint is born `running`); it answers true so that a row which somehow arrived in
 * that state fails loudly through the missing-request branch, exactly as it did
 * when the pump took any queued row it found, rather than sitting in the list
 * forever and holding the drain open with it.
 *
 * ── THE COUNT AND THE NAME ARE BOTH ASKED, and neither alone is enough ──────
 *
 * A row whose lane is knowable is refused when that lane is taken. A row the walk
 * decides for is refused when every lane is spoken for — counted rather than
 * named, because a walking row's lane is not settled yet. The count is sound
 * without being exact: at worst one more row is admitted than there is room for,
 * it finds every candidate claimed, and it parks with the backoff every other
 * wait uses. What cannot happen is two runs on one machine, and that is the
 * claim's job rather than this one's (`LaneClaim`).
 */
export function canStart(job: Job, lanes: readonly ComputeLane[]): boolean {
  const resource = JOB_RESOURCE[job.kind];
  if (resource === 'unscheduled') return true;
  for (const slot of slots.values()) {
    // An install holds every lane while it runs, so nothing joins it.
    if (slot.resource === 'exclusive') return false;
  }
  if (resource === 'exclusive') return slots.size === 0;
  let held = 0;
  for (const slot of slots.values()) if (slot.resource === resource) held += 1;
  if (resource === 'cpu') return held < CPU_LANE_SLOTS;
  /*
   * ── A BOARD WITH NO GPU LANE ADMITS THE ROW SO IT CAN BE REFUSED ──────────
   *
   * Since Wave 66 the GPU side is one lane per registered Crucible and nothing
   * else (Owen: *"there should be no local gpu listed in the queue"*), so a
   * machine with no server registered has NO GPU lane. The ceiling below would
   * then be zero and every GPU row would sit queued for ever, unstarted and
   * unexplained — *"a row that neither fails nor finishes is worse than either"*.
   *
   * So the row is let through, and the PLACEMENT refuses it by name one step
   * later (`placeJob`, electron/crucible-dispatch.ts: *"no GPU engine is
   * connected — add one in Settings › Servers"*). It reserves nothing on the way:
   * `laneAtPick` has no lane to give it, and the walk it is about to enter has no
   * candidate to claim.
   */
  if (lanes.length === 0) return true;
  /*
   * THE CEILING IS THE SUM OF THE LANES' CAPACITIES, not the number of lanes.
   * It was the count while every lane took one run; a server's `[cloud]` lane
   * takes two (Wave 62, `UPSTREAM_LANE_CAPACITY`), and counting lanes would hold
   * the second forwarded job behind a board that has room for it.
   */
  let ceiling = 0;
  for (const lane of lanes) ceiling += lane.capacity;
  if (held >= ceiling) return false;
  const wants = laneAtPick(job, lanes);
  return wants === null || !laneTaken(wants);
}

/**
 * THE NEXT ROW THAT MAY START, or null when the board can take nothing.
 *
 * ── FIFO within a lane, and lanes do not queue behind each other ────────────
 *
 * The list is walked in QUEUE ORDER and the first startable row wins, so within
 * one lane the order is exactly the order somebody added the jobs in — no
 * priorities, nothing preempts, and releasing a batch is still a state change
 * rather than a reshuffle (`start`). A CPU job DOES pass a GPU job that is
 * waiting for the card, and that is the entire point of a board: they are not
 * waiting for the same thing, and making the cheap one wait for the expensive
 * one is what Wave 35 exists to end.
 *
 * ── AN INSTALL IS A BARRIER, AND THAT IS NOT AN OPTIMISATION ────────────────
 *
 * A queued install stops the walk whether or not it can start. Without that,
 * a stream of cheap CPU rows would step over it indefinitely — and every one of
 * them would be running against the environment the install is waiting to
 * replace. One serial queue gave "a conversion that needs the environment waits
 * BEHIND it" for free (header, 16e); on a board it has to be said, and this
 * line is where it is said.
 *
 * ── THE LANES ARE THE CALLER'S, READ ONCE PER PASS ──────────────────────────
 *
 * `computeSlots()` reads the settings file (and, hosted, calls into the host), so
 * asking it per row would be a file read per queued row per pump. `pump` reads it
 * once and hands it down, which is also the more correct shape: every row in one
 * pass is rationed against one picture of the board, where a list that changed
 * halfway down would mean two rows of the same queue answered by two boards.
 */
export function nextStartable(lanes: readonly ComputeLane[]): Job | null {
  for (const job of jobs) {
    if (job.state !== 'queued') continue;
    /*
     * A ROW THAT ALREADY HOLDS A SLOT HAS BEEN PICKED, whatever its state says.
     * The slot is set the moment `pump` chooses a row, and `runInSlot` marks the
     * row running before its first await — but the slot is the claim, and the
     * picker reads the claim rather than trusting that every start path will
     * always flip the state in time. Without this line the queue spun the host
     * to death twice on 2026-09-11: a CPU-lane row (two lanes) was picked, its
     * slot held, and its start awaited `materializeDeferred` before anything set
     * `running`, so the synchronous `for (;;)` in `pump` — inside which no
     * microtask ever runs — saw the same queued row, the same one free lane, and
     * picked it again, forever, one `runInSlot` promise per turn until the heap
     * hit 8 GB. The GPU side escaped only because it had ONE lane at the time,
     * which made `canStart` false after the first pick — it has one per machine
     * now (Package G), so it would spin exactly the same way and this line is the
     * only thing that stops either of them.
     */
    if (slots.has(job.id)) continue;
    /*
     * ── AND A ROW PARKED WAITING FOR A SERVER IS SKIPPED UNTIL ITS TIME ──────
     *
     * A row whose slot was busy is back in this list wearing the reason, and it
     * is skipped rather than held because the two are opposites on a board: a
     * hold would stop every row behind it on somebody else's narration, and this
     * one concerns nobody but itself. The timestamp is what keeps it from being
     * a poll — see `parkedUntil`, which argues the whole shape.
     *
     * BEFORE THE CHAIN CHECK, because it is cheaper and answers more often: a
     * parked row is parked whatever its parent is doing.
     */
    const until = parkedUntil.get(job.id);
    if (until !== undefined && Date.now() < until) continue;
    /*
     * ── AND A ROW WAITING ON A PROMISE IS SKIPPED, NOT BLOCKED ────────────────
     *
     * `Job.after` names the row this one is downstream of, and the board is
     * precisely the thing that would otherwise get it wrong: an export is a CPU
     * row and the cleanup it is an export OF is a GPU row, so without this the
     * export steps straight past its own parent into the free lane, compiles the
     * book WITHOUT the cleanup, and files it in `final/` under the name the cleaned
     * one was going to have. Silent, plausible, and discovered in a narration.
     *
     * SKIPPED RATHER THAN A BARRIER, which is the opposite of the install rule two
     * paragraphs up and is right for the opposite reason. An install stops the walk
     * because everything behind it would run against the environment it is
     * replacing; a promised chain concerns nobody but itself, and holding the whole
     * queue behind one cleanup would make a person's unrelated reading wait on it.
     *
     * `chainVerdict` ANSWERS `wait` FOR AN UNRESOLVED LINK AS WELL, which is the
     * safe direction: `reconcileChains` runs at the top of every pump and turns
     * every unresolved link into `go` or into a cascade, so a row that is still
     * unresolved here is one this pass could not decide and the next pass will.
     */
    if (chainVerdict(job) !== 'go') continue;
    if (JOB_RESOURCE[job.kind] === 'exclusive') return canStart(job, lanes) ? job : null;
    if (canStart(job, lanes)) return job;
  }
  return null;
}

/**
 * WHAT THE ROW THIS ONE WAITS BEHIND IS DOING — the queue's half of the answer.
 *
 * `go` — nothing to wait for, or the parent has landed.
 * `wait` — the parent is still in the list and has not finished.
 * `lost` — the parent is in the list and ended without producing anything.
 * `unknown` — there is no such row, and only the LEDGER can say why.
 *
 * ── `unknown` IS THE CASE THAT HAD TO BE ADDED, AND IT IS NOT AN EDGE ───────
 *
 * An absent parent row is NOT a lost parent. The obvious reading — no row, no
 * parent, cancel the chain — is wrong in the ordinary case: the cleanup finished an
 * hour ago and somebody pressed Clear finished, or a host swept its own list, and
 * the step is sitting in the ledger exactly where it was promised. Treating that as
 * a loss would cancel an export whose parent had SUCCEEDED. So the queue answers
 * "I cannot tell" and `reconcileChains` asks the ledger, which is the only place
 * the difference is recorded.
 */
export function chainVerdict(job: Job): 'go' | 'wait' | 'lost' | 'unknown' {
  if (job.after === undefined) return 'go';
  /*
   * THE SAME SHELF `chainedBehind` COMPOSED `after` FROM — `shelfJobs()`, which
   * hosted is the HOST's rows and standalone is our own. This read `jobs`, our
   * own list only, and hosted that list never holds the row a chain waits on:
   * the clean was queued on BookForge's engine, its row crossed as a host row,
   * `after` named that row's id, and this lookup answered undefined → 'unknown'
   * → the ledger was asked → "never landed" → the export was cancelled with
   * "nothing in the queue is going to make it" while the queue was making it
   * (Owen, the Mac, 2026-09-08). A host row carries `state`, which is all the
   * verdict reads.
   */
  const parent = shelfJobs().find((row) => row.id === job.after);
  if (parent === undefined) return 'unknown';
  if (parent.state === 'done') return 'go';
  if (parent.state === 'failed' || parent.state === 'cancelled') return 'lost';
  return 'wait';
}

/**
 * EVERY UNRESOLVED CHAIN LINK, SETTLED AGAINST THE LEDGER — run at the top of every
 * pump, before anything is chosen.
 *
 * ── The question, and why the ledger is the only place it is answered ───────
 *
 * A row waiting on an id that is in nobody's list is in one of exactly two states,
 * and they demand opposite answers:
 *
 *   THE PARENT LANDED AND WAS CLEARED. The step is in the ledger; this row's whole
 *   reason to wait is discharged; it should run. `after` is dropped rather than
 *   satisfied-and-kept, because the link's other job is the cascade and there is
 *   nothing left to cascade from — the parent is a fact now, not a promise.
 *
 *   THE PARENT WAS LOST. No row, no step: whatever was going to make it left the
 *   queue between the press and now. This is Owen's *"or it otherwise gets lost
 *   along the way"*, and the answer is the same as a removal's.
 *
 * WHAT IS ASKED FOR IS THE STEP AND NOT THE ROW. `deferred.from` where the request
 * carries one, and `Job.parentStep` otherwise — the second is the host seam's case,
 * where Foundry chained an export behind a row it did not plan (`exportEpubFromStep`
 * with a promised step). A row that names neither has nothing to check and is let
 * through, which is the honest answer: it was chained behind something, that
 * something is gone, and nothing here can say whether it succeeded.
 *
 * ── ASYNC, WHICH IS WHY IT IS NOT INSIDE `nextStartable` ────────────────────
 *
 * Reading a ledger is reading a file, and the chooser is synchronous by
 * construction: `pump()`'s loop reserves a slot BETWEEN two calls to it, and an
 * await in there would let two passes choose the same row. So the file reads happen
 * once, before the loop, and the chooser sees only the queue.
 *
 * IT NEVER THROWS. An unreadable manifest, a project that has moved, a ledger this
 * build refuses — none of those is a reason to wedge the whole scheduler, and the
 * row keeps waiting (its `after` is left alone) rather than being cancelled on the
 * strength of a file that would not open. The console keeps the record.
 */
export async function reconcileChains(): Promise<void> {
  const waiting = jobs.filter(
    (job) => job.after !== undefined && (job.state === 'queued' || job.state === 'held'),
  );
  for (const job of waiting) {
    if (chainVerdict(job) !== 'unknown') continue;
    const request = requests.get(job.id);
    const wanted = (request === undefined ? undefined : deferralOf(request)?.from)
      ?? job.parentStep ?? null;
    if (wanted === null) {
      delete job.after;
      continue;
    }
    // The request's own project first: a host's implied export lies outside
    // every project and would otherwise be un-chained here as an orphan.
    const dir = (request === undefined ? null : homeOf(request)) ?? projectDirOf(job.outputPath);
    if (dir === null) {
      delete job.after;
      continue;
    }
    let landed: boolean;
    try {
      landed = ledgerOf(await readManifest(dir)).steps.some((step) => step.id === wanted);
    } catch (err) {
      console.error(
        `[queue] ${dir} could not be asked whether "${wanted}" landed `
        + `(${err instanceof Error ? err.message : String(err)}); the row goes on waiting.`,
      );
      continue;
    }
    if (landed) {
      delete job.after;
      continue;
    }
    /*
     * NEITHER IN THE QUEUE NOR IN THE LEDGER — the loss. Cancelled and removed with
     * its own chain behind it, by the same hand a removal uses, so a person sees the
     * whole promised subtree go at once rather than one row per pump.
     */
    job.state = 'cancelled';
    job.error = 'The step this was to be made from never landed, and nothing in the queue is going '
      + 'to make it.';
    job.finishedAt = Date.now();
    void sweepDerivedBook(requests.get(job.id));
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    requests.delete(job.id);
    settled(job);
  }
}

/**
 * ONE RUN'S TWO WIRES OUT — who holds its cancel, and who hears it talk.
 *
 * ── Why the executor takes these rather than deciding for itself ────────────
 *
 * `executeJob` is the whole of what a job DOES, and there are two callers with
 * two different answers to exactly two questions. `pump()` puts the live child in
 * the slot it took for this row on the board; `runJob` puts it in `detachedRuns`,
 * because it was scheduled elsewhere and must neither wait for a slot nor hold
 * one. `pump()` has nobody to report progress to beyond the row; `runJob` has a
 * caller that asked for the lines.
 *
 * EVERYTHING ELSE IS THE SAME CODE — the rotations, the server wait, the seeding,
 * the metadata stamp, the landings, the sweeps, the announcements. That is the
 * point of the split: a job the host scheduled and a job somebody pressed Start
 * on are the same job, and if this interface ever grows a third member that
 * changes what a run DOES, the split has gone wrong.
 */
export interface RunWires {
  /**
   * The live engine child, the moment it exists — and the cancel that stops it.
   * Called ONCE per run: `handle` is reassigned for the metadata stamp and this
   * closure reads it, so the ✕ follows whichever engine is actually running.
   */
  claim(cancel: () => void): void;
  /** The last child has exited, whichever way. */
  release(): void;
  /** Every line the engine wrote, for a caller watching from outside the row. */
  watch?(line: string): void;
  /**
   * THE SAME LINES, FOR THE LOG — and it is not a duplicate of `watch`.
   *
   * `watch` is the row's reporter: a host parses counts out of it and draws a
   * bar, and a reporter with a bug in it throws. `line` is the copy that goes to
   * a FILE, called in the reporter's `finally`, so a listener's throw cannot cost
   * the log the line that explains the failure — which is exactly what happened
   * on 2026-09-19, when a night of hosted failures left `grep -c '[job]'` over
   * every log answering 0 (BookForge P5/F7).
   */
  line?(line: string): void;
  /**
   * WHERE THIS RUN WAS PLACED, once, BEFORE the engine is spawned.
   *
   * The host writes it into its own in-flight ledger so a hard kill has something
   * to release the Crucible LEASE with — the one thing the startup sweep could not
   * cover, because the lease is taken in here and recorded nowhere (BookForge P8).
   * Announced before the spawn for that reason: a record written after the child
   * exists is a record that can be missed by the kill it is for.
   */
  placed?(placement: RunPlacement): void;
}

/**
 * THE SCHEDULER: fill every slot that can be filled, then say whether the board
 * has gone quiet.
 *
 * ── It starts as many as it can, where it used to start one ─────────────────
 *
 * This was `if (something is running) return;` followed by one row and one
 * `await`, and the await meant the scheduler's own call stack held the job for
 * its entire life. A board cannot work that way — two CPU rows have to be
 * started from ONE pass, or the second waits for the first — so the loop
 * dispatches and does not await, and `runInSlot` calls back here when its row is
 * over. The recursion is one level deep per ending, and every path through it is
 * `void`ed, because nobody has ever awaited this function.
 *
 * THE SLOT IS TAKEN INSIDE THE LOOP, SYNCHRONOUSLY, BEFORE THE NEXT LOOK. That
 * is the line the whole thing turns on: `runInSlot` reaches an await within
 * microseconds and would otherwise still be invisible when `nextStartable` ran
 * again, so the same row would be chosen twice and the same lane counted empty
 * twice. Reserving here rather than inside the run is also what let `starting`
 * be deleted.
 *
 * `queued` ONLY, which is the whole of the hold: a `held` job is invisible to
 * `nextStartable` until `start()` changes its state, so the gate is the data
 * rather than a flag every path through this function would have to consult.
 */
export async function pump(): Promise<void> {
  /*
   * ── THE CHAINS FIRST, BECAUSE THE CHOOSER CANNOT ASK A DISK ────────────────
   *
   * A row waiting on a parent that is in nobody's list is either free to run (the
   * parent landed and was cleared) or lost (the parent never landed), and only the
   * ledger knows which — see `reconcileChains`. It runs here, once, awaited, before
   * a single slot is reserved: `nextStartable` must stay synchronous or two passes
   * of the loop below would choose the same row.
   *
   * IT IS ALSO WHY THE LOOP SEES A SETTLED PICTURE. Anything this resolves is
   * resolved before the first `nextStartable`, so a chain freed by a landing that
   * happened while the queue was quiet starts on this pass rather than on the next
   * thing that happens to call `pump`.
   */
  await reconcileChains();
  /*
   * THE BOARD, AS THE WHOLE OF THIS PASS SEES IT. Read after the await and
   * before the first pick, once — see `nextStartable`, which argues why the
   * list is a parameter rather than something each row asks for itself.
   */
  const lanes = computeLanes(computeSlots());
  for (;;) {
    const next = nextStartable(lanes);
    if (next === null) break;
    /*
     * THE LANE IS RESERVED IN THE SAME BREATH AS THE SLOT, and for the same
     * reason: both are claims, and both have to be visible to the next turn of
     * this synchronous loop. `laneAtPick` answers null for a row whose lane the
     * walk decides — see `Slot.on`, which argues the three states.
     */
    const slot: Slot = {
      id: next.id,
      resource: JOB_RESOURCE[next.kind],
      on: laneAtPick(next, lanes),
      cancel: null,
    };
    slots.set(next.id, slot);
    void runInSlot(next, slot);
  }

  /*
   * ── THE DRAIN, WHICH IS THREE FACTS AND HAS ALWAYS BEEN THREE FACTS ────────
   *
   * Nothing on the board, nothing waiting, and no live detached run. It used to
   * read as "no row could be chosen, and nothing is running" because a single
   * slot made those one question; on a board they are counted, and the count is
   * the same three facts it always was (docs/QUEUE-BOARD.md §3).
   *
   * TREAT ANY CHANGE HERE AS A CORRECTNESS CHANGE. The reading server's lifetime
   * follows the queue's (electron/page-reader.ts) and `keepServerWarmMinutes`
   * DEFAULTS TO 0 — which is not a short timer, it is `stopPageReader` now, with
   * no window for a busy signal to beat it. An early drain therefore does not
   * waste a little warmth; it pulls the model out from under whatever is still
   * reading. On a board that hazard is LARGER than it was, because a CPU export
   * finishing while a GPU reading posts pages is now an ordinary Tuesday: the
   * export's ending calls this function, and if the test were "did I find
   * anything to start" the answer would be no and the server would go. It is not
   * that test. The reading holds its slot, `slots.size` is 1, and nothing is
   * declared.
   *
   * ── AND THIS QUEUE IS NOT THE ONLY QUEUE ────────────────────────────────────
   *
   * Under a host queue the internal list holds only what Foundry orders for
   * itself — the unattended exports a host asks for by name, and environment
   * installs — while every job a person pressed for is in the host's list and
   * arrives one at a time through `runJob`. So an empty board here is NOT the
   * machine going quiet, and the host says when its own queue has drained of
   * Foundry work (`hostQueueDrained`).
   *
   * WHICH IS WHY `runJob` ENDS WITHOUT PUMPING — see the essay at its return. If
   * it pumped, this would be reached between every pair of the host's rows and
   * would stop the reading server after each one. What still reaches here under a
   * host queue is the internal path going quiet: an environment install
   * finishing, or an export the host ordered by name.
   *
   * BOTH SIGNALS ARE SAFE TOGETHER, because busy always beats idle: every job
   * start says `noteQueueBusy` from inside `executeJob`, however it was
   * scheduled, and that cancels whatever countdown was armed. The `detachedRuns`
   * clause is what closes the one crossing a busy signal cannot cover, for the
   * `noteQueueIdle(0)` reason above: a live run holds the drain, whoever
   * scheduled it.
   *
   * A MINT HOLDS NOTHING AND HOLDS NO DRAIN, unchanged from before the board. It
   * takes no slot (`unscheduled`), it spawns no engine and it never addresses the
   * reading server, so a capture being assembled while the queue empties declares
   * drain exactly as it always did.
   */
  /*
   * A ROW BEHIND AN UNFINISHED PROMISE DOES NOT HOLD THE DRAIN OPEN, and the line
   * is `held`'s own distinction reaching a row that is spelled `queued`.
   *
   * An export ordered from a promised cleanup is enqueued `queued`, because a
   * rendering never waits for a person (`enqueueHere`) — but this one does: its
   * cleanup is `held` until somebody finds the shelf and presses Start, which can be
   * tomorrow. Counting it as work the board is about to do would keep the page
   * reader resident for exactly as long, with `keepServerWarmMinutes`
   * defaulting to 0 and nothing left running to justify it. What it is waiting for
   * is a PERSON, which is the one thing the drain has never counted.
   */
  /*
   * THE DRAIN USED TO ARM A COUNTDOWN AND NOW TELLS NOBODY.
   *
   * noteQueueIdle(minutes) kept the local reading server warm for a while after
   * the last job so the next book did not pay the load. There is no local
   * server to keep warm (2026-09-17), and the engines that do the work hold
   * their own models on their own terms -- so the whole computation went with
   * it, the `waiting` test included, which existed only to decide whether the
   * countdown should be armed over a row that was waiting on a PERSON.
   */
}

/**
 * ONE ROW, IN THE SLOT THE SCHEDULER ALREADY TOOK FOR IT.
 *
 * ── Why the slot is given rather than taken ─────────────────────────────────
 *
 * Because the taking is the scheduling. `pump()` reserved it before this
 * function existed for this row (see its loop), and handing it down means there
 * is exactly one place a slot can be claimed and exactly one place it can be
 * given up — the `finally` below, whichever way the row ended, including the
 * two early returns that used to each have to remember to pump.
 *
 * THE PUMP AT THE END IS THE ONE THAT USED TO SIT IN EVERY LANDING ARM (16f).
 * It is here rather than inside `executeJob` because `executeJob` is shared with
 * `runJob`, which must NOT pump — the essay at its return says why in full.
 *
 * THE SLOT OUTLIVES THE CHILD, DELIBERATELY. `release()` nulls the cancel when
 * the last engine child exits, but the slot itself is held through the landings
 * — the catalogue writes, the book file, the announcements — and is given up
 * only when the whole run returns. That is what the single slot did (the pump
 * did not look again until `executeJob` had returned), and it matters more now:
 * a lane freed at the child's exit would let the next row's rotation start
 * while the previous row's landing was still moving files in the same folder.
 */
export async function runInSlot(job: Job, slot: Slot): Promise<void> {
  try {
    const held = requests.get(job.id);
    if (held === undefined) {
      job.state = 'failed';
      job.error = 'The job lost its configuration before it started.';
      changed();
      settled(job);
      return;
    }
    /*
     * ── THE PROMISE BECOMES A REQUEST, HERE AND IN `runJob` AND NOWHERE ELSE ──
     *
     * The two doors onto `executeJob` are the two moments a job actually starts, so
     * they are the two places a deferred plan can be made real — and `executeJob`
     * itself is deliberately not one of them: it is the shared body, and putting a
     * plan call in there would make a hosted run and a standalone run two behaviours
     * again (its own header forbids exactly that).
     *
     * THE STORED REQUEST IS REPLACED, not merely the local one, because two other
     * readers of it outlive this line: `sweepDerivedBook` has to know about the book
     * the re-plan just materialised or it will leave it in the temp directory
     * forever, and `cancelHere` reads the same map when the ✕ arrives mid-run.
     *
     * A REFUSAL IS A FAILED ROW WITH MAIN'S OWN SENTENCE, which is the shape every
     * unmakeable plan in this app already takes — the same arm the missing-request
     * branch above uses, for the same reason: there is nothing to spawn and the
     * person is owed the reason.
     */
    /*
     * MARKED RUNNING BEFORE THE FIRST AWAIT, and that ordering is the point. Until
     * Wave 56 (688c888) `executeJob` did this as the first synchronous thing after
     * the pick, and everything that reads state — the picker, `remove`, which
     * splices a QUEUED row out from under whatever holds it — could take "queued"
     * to mean "nobody has this". `materializeDeferred` put an await in front of
     * that mark, and for as long as it was pending the row was both claimed and
     * queued: `remove` would take it away while its start went on to run it, and
     * the picker would choose it again (see `nextStartable`, which now also reads
     * the slot). Materialising a deferred request is a ledger read and a plan,
     * which is work on this row's behalf; "Starting…" is the honest word for it,
     * and the message `executeJob` writes a moment later is the same one.
     */
    job.state = 'running';
    job.startedAt = Date.now();
    job.message = `Starting ${path.basename(job.inputPath)}…`;
    changed();
    /*
     * ── AND THE MATERIALISE IS NOT HERE ANY MORE (PK6) ──────────────────────
     *
     * It was: `materializeDeferred(held, job)` ran between the mark and
     * `executeJob`, and its throw was caught and filed here — in BOTH doors, which
     * is two copies of one ending. It has moved inside the run (`carry`, beside the
     * seed copy and the checklist) for the rule those two state about themselves: a
     * row that turns out to be waiting for a busy card must leave the project
     * exactly as it found it, and a book materialised before the placement is a
     * file written on the way to a wait. `executeJob`'s own boundary files the
     * throw now, which is the ending every other unmakeable plan already had.
     */
    await executeJob(job, held, {
      claim: (cancel) => { slot.cancel = cancel; },
      release: () => { slot.cancel = null; },
    });
  } finally {
    slots.delete(job.id);
    void pump();
  }
}
