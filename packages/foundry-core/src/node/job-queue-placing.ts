/**
 * job-queue-placing — where a run goes and starting it: choosing the server, and executing a row.
 */
import * as path from 'node:path';
import { computeLanes } from '../shared/queue-board';
import type { Job } from '../shared/types';
import { computeSlots } from './crucible-registry';
import { placeJob, type LaneClaim, type Placement, type PlacementWait } from './crucible-dispatch';
import { pump } from './job-queue-board';
import type { RunWires } from './job-queue-board';
import { carry } from './job-queue-carry';
import { cancelHere, release } from './job-queue-gestures';
import { settled } from './job-queue-settling';
import { changed, forgetPark, landings, liveRuns, parkDelay, parkedUntil, sessions, slots } from './job-queue-state';
import type { EngineRequest } from './job-queue-state';

/**
 * RESOLVE WHERE THIS RUN GOES, or take the row out of this call's hands.
 *
 * Returns the placement when the job may start now. Returns NULL when it may
 * not, having already published what happened — which is one of two endings:
 *
 *   * PARKED. The row is `queued` again, wearing the sentence about what it is
 *     waiting for, and `parkedUntil` holds the picker off until the backoff is
 *     up. `runInSlot`'s `finally` gives the lane back and pumps, so the board
 *     carries on with everything else while this one waits.
 *   * FAILED. The refusal would be the same on every machine — an unknown model,
 *     a class this build's servers do not have — so it is said once, on the row,
 *     and the row is settled like any other refusal.
 *
 * ── A run nobody scheduled waits IN PLACE, and that is not a special case ──
 *
 * `runJob` (a host's scheduler) and `runNow` (the Export dialog) both reach
 * `executeJob` without taking a lane, and both have a caller awaiting a SETTLED
 * row — `executeJob`'s own contract. Parking one would resolve that caller with
 * a queued row it has no pump to rescue, so those wait here instead, with the
 * same backoff and the same sentence on the row. `slots.has` is what tells them
 * apart, and it is the truth rather than a proxy for it: the lane IS the pump's
 * claim on this row.
 *
 * ── AND IT IS WHAT DECIDES WHETHER THE WALK MAY CLAIM A LANE ───────────────
 *
 * The same one fact, read a second time. A run this scheduler picked has a slot
 * record, and the walk's claim writes the machine it settled on into it
 * ({@link LaneClaim}); a run nobody here scheduled has none, and its claim says
 * yes to everything — a host's queue rations its own machine and a queue that
 * second-guessed it would be holding the host's row against a board the host
 * cannot see (see `detachedRuns`, which argues the whole posture).
 */
/**
 * ONE LINE, OUT TO WHOEVER IS LISTENING — the row's reporter, then the log.
 *
 * ── Why the log is in the reporter's `finally` ─────────────────────────────
 *
 * They are the same lines and they are not the same listener. `watch` is a
 * caller's PARSER — a host reads counts out of it and draws a bar — and a parser
 * has bugs; `line` is a copy going to a FILE. Called in sequence, a throw from
 * the first would take the second with it, and the line that explains the failure
 * is exactly the line a broken parser is most likely to throw on.
 *
 * So the log is written whatever the reporter does, and the reporter's throw is
 * logged rather than raised: `settled`'s rule, one listener's bug is not another's
 * engine.
 */
export function sayOutward(line: string, about: string, wires: RunWires): void {
  try {
    wires.watch?.(line);
  } catch (err) {
    console.error(
      `[queue] a progress listener threw for ${about}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      wires.line?.(line);
    } catch { /* a log that throws is never worth a run */ }
  }
}

export type Placed =
  | { go: true; placement: Placement }
  /**
   * NOT THIS CALL'S ANY MORE. `wait` is non-null only for a run NOBODY HERE
   * SCHEDULED — a host's row, which has a scheduler of its own to hand it back
   * to. For a row on this board the park has already happened and this is null.
   */
  | { go: false; wait: PlacementWait | null };

export async function placeRun(
  next: Job,
  request: EngineRequest,
  wires: RunWires,
  /**
   * THE RUN'S ONE ENDING, borrowed from the boundary — `executeJob`, which owns
   * the counting. A refusal here is an ending like any other, and it is counted
   * with the rest for the same reason: there is one `settled` per run, and the
   * catch one function out has to know whether it has already happened.
   */
  settle: () => void,
  /** The least context its model may start at, measured from its book (job-queue-measure.ts). */
  contextTokens?: number,
): Promise<Placed> {
  const held = slots.get(next.id) ?? null;
  /*
   * ONE LANE PER RUN, so taking the next candidate gives the last one back: the
   * field is a single name and the claim overwrites it. A lane this run already
   * holds — the pump reserved it, or the walk claimed it on an earlier pass of
   * the backoff — is granted again rather than refused by its own reservation.
   *
   * ── AND A LANE'S WIDTH IS NOT ALWAYS ONE ANY MORE (Wave 62) ──────────────
   *
   * A card lane takes one run; a server's `[cloud]` lane takes two, because
   * nothing of ours is on that machine's GPU and what is being rationed is an
   * account's rate limit rather than a card (`UPSTREAM_LANE_CAPACITY`,
   * shared/queue-board.ts, which argues the number). So the holders are COUNTED
   * against the lane's own capacity instead of the first one refusing everybody.
   *
   * THE BOARD IS RE-READ HERE rather than threaded down from `pump`, and that is
   * a deliberate second read: `placeRun` is reached again on every pass of the
   * backoff, minutes apart, and a capacity taken from the list as it was when the
   * row was first picked would be this run rationing itself against a board
   * somebody has since edited. A lane the list no longer carries is width one,
   * which is the honest reading of a machine that has left.
   */
  const lanesNow = computeLanes(computeSlots());
  const claim: LaneClaim = (lane) => {
    if (held === null) return true;
    if (held.on === lane) return true;
    const capacity = lanesNow.find((entry) => entry.name === lane)?.capacity ?? 1;
    let taken = 0;
    for (const other of slots.values()) {
      if (other.id !== held.id && other.on === lane) taken += 1;
    }
    if (taken >= capacity) return false;
    held.on = lane;
    return true;
  };
  const say = (line: string): void => {
    if (next.state === 'cancelled') return;
    next.message = line;
    changed();
    // The placement's own lines go out with the engine's: "Loading dots-ocr on
    // <server>" is a thing this run said, and a log that only has the engine's
    // half cannot explain the twenty minutes before it spawned.
    sayOutward(line, next.outputPath, wires);
  };
  /*
   * ── ONE ASKING, AND NO LOOP (PK6) ─────────────────────────────────────────
   *
   * This was `for (;;)` with a backoff inside it, and for a row on this board it
   * still parks and is re-picked — that part is the pump's and is unchanged. What
   * it also did was SPIN for a run nobody here scheduled: a detached `runJob`
   * holds no lane to give back, so the loop re-asked with a growing delay, capped
   * at 30 s, for as long as the card stayed busy, and the host's row sat in
   * `running` with no way to say why.
   *
   * That is a second scheduler with a 30-second opinion, inside a function whose
   * whole contract is that somebody else decides when. So a detached run's wait
   * is RETURNED, typed, the moment the placement says it — and the host parks its
   * own row, on its own clock, with the holder's own sentence on it.
   */
  {
    const placementAbort = new AbortController();
    wires.claim(() => {
      placementAbort.abort();
      // No child exists yet. Drop this callback before the normal cancel path
      // marks and settles the row, otherwise cancelHere calls it again.
      wires.release();
      cancelHere(next.id);
    });
    let outcome: Awaited<ReturnType<typeof placeJob>>;
    try {
      // The model a person chose in the job's dialog, on the kinds that carry one
      // (translate, simplify, clean, analysis); absent everywhere else.
      const chosenModel = 'chosenModel' in request ? request.chosenModel : undefined;
      outcome = await placeJob(
        request.kind, next.waitFor, say, claim, placementAbort.signal, chosenModel, contextTokens);
    } finally {
      wires.release();
    }
    // Placement can wait for a remote model load for minutes. A cancellation
    // in that interval has already settled this row; never revive it, and give
    // back a lease that arrived after the settle could see it.
    if (next.state === 'cancelled') {
      if (outcome.verdict === 'go' && outcome.placement.session !== null) {
        await outcome.placement.session.release();
      }
      return { go: false, wait: null };
    }
    if (outcome.verdict === 'go') {
      forgetPark(next.id);
      /*
       * WHERE IT ACTUALLY WENT, beside where it was told to wait. `waitFor` is
       * the person's choice and must not be overwritten by a walk's answer — a
       * row pinned to `any` that happened to land on the Mac is still a row that
       * will take whatever is free next time. This is the other half of the
       * sentence, and it is what the shelf shows while the run is alive.
       */
      /*
       * A PLACEMENT WITH NO SLOT RECORDS NO MACHINE. Since Wave 66 that is a job
       * which never meets a model — an export, a compile, a mint — and it runs on
       * this machine's cores by the ruling that keeps the CPU lane local. An
       * absent `ranOn` is what every reader already understands as "here"
       * (`laneOfRun`, shared/queue-board.ts); writing the name of a slot the list
       * no longer carries would be a sentence about a machine nothing else names.
       */
      if (outcome.placement.slot !== null) next.ranOn = outcome.placement.slot.name;
      else delete next.ranOn;
      /*
       * AND WHETHER IT WAS FORWARDED, which is the other half of "where it went"
       * and the thing that puts the row in the server's `[cloud]` lane rather
       * than on its card (`laneOfRun`, shared/queue-board.ts). `ranOn` stays the
       * MACHINE — it is what the shelf says out loud — and this is the upstream's
       * name beside it. Absent is a run on a card, which is every run this app
       * has ever recorded.
       */
      if (outcome.placement.via !== null) next.ranVia = outcome.placement.via;
      else delete next.ranVia;
      /*
       * THE LEASE GOES WHERE THE SETTLE CAN FIND IT, immediately, before anything
       * can throw. `settled` is the one ending every path in this file reaches,
       * and a lease the map never learned about would be a claim on somebody's
       * card that nothing releases until it expires.
       */
      if (outcome.placement.session !== null) sessions.set(next.id, outcome.placement.session);
      changed();
      return { go: true, placement: outcome.placement };
    }
    if (outcome.verdict === 'refuse') {
      forgetPark(next.id);
      next.state = 'failed';
      next.error = outcome.reason;
      next.finishedAt = Date.now();
      changed();
      settle();
      return { go: false, wait: null };
    }
    const delay = parkDelay(next.id);
    if (held !== null) {
      next.state = 'queued';
      next.message = outcome.reason;
      next.note = null;
      /*
       * `startedAt` GOES BACK, because this row did not start. Leaving it set
       * would make the shelf's elapsed clock count the waiting as run time, and
       * a person reading "3h 12m" off a job that has not spoken to a model yet
       * would reasonably conclude it was wedged.
       */
      delete next.startedAt;
      parkedUntil.set(next.id, Date.now() + delay);
      changed();
      /*
       * NOTHING WAKES THE PUMP ON ITS OWN. It runs when a row ends and when one
       * is enqueued, and a board that has gone quiet with one parked row on it
       * would sit there until somebody pressed something. One timer per park,
       * armed for the backoff, is what closes that.
       */
      const timer = setTimeout(() => { void pump(); }, delay);
      timer.unref?.();
      return { go: false, wait: null };
    }
    /*
     * A RUN NOBODY HERE SCHEDULED HANDS THE WAIT BACK. The sentence is the
     * holder's own and `standing` says whether time alone will ever fix it, which
     * is the difference between a card somebody is using and a class this machine
     * cannot serve. Both are waits; only one of them is worth re-asking on a clock.
     *
     * `forgetPark` because this row is not parked HERE: the backoff ledger belongs
     * to the board, and a count left behind would be handed to the next attempt as
     * though this one had been waiting on our own clock.
     */
    forgetPark(next.id);
    say(outcome.reason);
    return { go: false, wait: outcome };
  }
}

/**
 * RUN THIS JOB — the executor, and the whole of what a job DOES.
 *
 * ── What it is, and what it deliberately is not ─────────────────────────────
 *
 * It was the second half of `pump()` and it is a function because there are two
 * ways to decide that a job should run now: this app's own serial queue, and a
 * host's scheduler calling `runJob` (docs/PLAN.md, Wave 16). It does not choose,
 * it does not wait, it does not pump: it takes a row that is about to be running
 * and carries it all the way to its landing.
 *
 * NOTHING IN HERE ASKS WHO SCHEDULED IT. There is no host test in this function
 * or in anything it calls, which is what makes a hosted run and a standalone run
 * the same run — the two differences are the two members of `RunWires`.
 *
 * IT RETURNS WHEN THE ROW IS SETTLED, and the row itself is the answer: mutated
 * in place, exactly as it always was, so a caller can read `state` and `error`
 * off it afterwards. Nothing is thrown from here — an engine that refuses is a
 * `failed` row with the engine's own words on it, which is what every reader of
 * this queue already understands.
 *
 * ── AND THAT LAST SENTENCE IS ENFORCED NOW, RATHER THAN ASSERTED ───────────
 *
 * It was a promise this function made about itself and nothing kept. Every
 * landing in `carry` below is an unguarded await AFTER `placeRun` has recorded a
 * lease — `recordReading`, `landReadProducts`, `recordAnalysis`, `recordFinal`
 * and the rest — and so is `runEngine` itself, whose `engineCommand()` throws by
 * design when the app folder has no engine bundle (engine.ts). Neither caller catches: `runInSlot`'s `finally`
 * frees the slot and pumps, `runDetached`'s drops the abort listener, and both
 * let the rejection past. So a throw left the row `running` for ever, and
 * because the only `clearInterval` on the lease heartbeat lives inside
 * `release()` — which only `settled` calls — the beat went on renewing a
 * two-minute claim on somebody's card for the life of this process. A card
 * nothing can load onto, on behalf of a run that ended. `exportEpubFromStep`
 * (electron/mount.ts), which awaits the ending, never resolved either.
 *
 * THE BOUNDARY IS HERE AND NOT IN THE CALLERS, for the reason this function is
 * one function at all: there are two schedulers and there must not be two
 * answers to "what happens when a run blows up". A catch in `runInSlot` would
 * have to be written again in `runDetached`, and the next door onto this
 * function would be the third place to forget it.
 *
 * IT IS NOT A SWALLOW. The console gets the whole error — object and all, so a
 * stack survives — and the row gets the error's own message, which is the shape
 * every deliberate failure arm in `carry` already uses.
 */
export async function executeJob(
  next: Job,
  request: EngineRequest,
  wires: RunWires,
): Promise<PlacementWait | null> {
  /*
   * ── THE ONE ENDING, SAID ONCE, WHOEVER SAYS IT ────────────────────────────
   *
   * `carry` reaches `settled` down ten different arms and the catch below is an
   * eleventh, so the idempotence cannot live at any one of them. It lives here,
   * in the closure both sides call: the first caller wins and every caller after
   * it is a no-op. That matters for exactly one reachable case — `settled` itself
   * runs `cascadeFrom`, which is somebody else's code and can throw after the
   * listeners have already been told — and the wrong answer there is a second
   * ending for a job that has already had one.
   *
   * `over` IS READ BY THE CATCH TOO, and not only through this function: a row
   * that has already settled `done` must not be rewritten to `failed` behind the
   * back of the listeners that were handed it.
   */
  /*
   * THIS RUN, WRITTEN DOWN WHILE IT IS ALIVE — see `drained`, which is what a
   * quit waits on. Registered before the first await and dropped in the `finally`
   * below, so the set is exactly the runs that have not finished.
   */
  let over = false;
  let ended = (): void => undefined;
  const live = new Promise<void>((resolve) => { ended = resolve; });
  liveRuns.add(live);
  const settle = (): void => {
    if (over) return;
    over = true;
    settled(next);
  };
  try {
    return await carry(next, request, wires, settle);
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    /*
     * WHOLE, AND WITH THE ERROR OBJECT BESIDE IT. A throw out of here is a
     * defect rather than an engine's refusal, so the stack is the useful half
     * and a message-only line would throw it away. The terminal is where
     * somebody is already looking — the same argument the engine-failed line
     * below in `carry` makes for printing stderr in full.
     */
    console.error(
      `\n[job] ${next.kind} THREW — ${path.basename(next.inputPath)} — ${said}\n`,
      err,
    );
    /*
     * THE ROW IS ONLY REWRITTEN IF NOTHING HAS ENDED IT, and there are two ways
     * something already has.
     *
     * `over` is this run's own ending, said down one of `carry`'s arms; reaching
     * here with it set means the throw came out of `settled` itself, after every
     * listener had been handed a row, and turning that row into a `failed` one
     * now would make the shelf and the waiters disagree about what happened.
     *
     * A `cancelled` ROW IS THE OTHER, AND IT IS SOMEBODY ELSE'S. `cancelHere`
     * settles a row that has no live child of its own, which is every moment
     * BEFORE the spawn — the minutes a job spends waiting for the reading
     * server, and the file preparation after it — so the ending is already out
     * and it is not this one. (While the child is alive the ✕ kills it and the
     * close handler says what happened; from the moment it exits the row is
     * landing and the ✕ is refused — `landings`, which is what makes this
     * sentence true rather than hopeful.) A cancel is a person taking their GPU
     * back, and filing it as a failure is how a host's retry restarts work they
     * just stopped (`runJob`, which argues the three states).
     */
    if (!over && next.state !== 'cancelled') {
      next.state = 'failed';
      next.error = said;
      next.finishedAt = Date.now();
      changed();
      settle();
    }
    // A THROW IS NOT A WAIT. The row has its ending; there is nothing for a
    // scheduler to re-ask.
    return null;
  } finally {
    /*
     * AND THE LANDING MARK GOES, ON EVERY WAY OUT — the rotation's `finally` one
     * function down, for its reason: a mark left behind is a row whose ✕ is dead
     * for ever, and the alternative is clearing it at each of the arms that end
     * a run plus whichever is added next. `carry` enters it beside
     * `wires.release()`; this is the one place it can be left from.
     */
    landings.delete(next.id);
    liveRuns.delete(live);
    ended();
  }
}
