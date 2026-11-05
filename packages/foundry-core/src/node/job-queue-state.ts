/**
 * job-queue-state — the queue's own state: the rows, the slots, the live runs and parked runs, and who is told when they change.
 */
import * as path from 'node:path';
import { foundryHost, type FoundryHostQueue } from './host';
import { type JobResource } from '../shared/queue-board';
import type { AnalysisRankRequest, AnalyzeRequest, CleanTriageRequest, ExportLanding, FoundryJobRow, Job, JobRequest, TextPassRequest } from '../shared/types';
import { type HeldSession } from './crucible-dispatch';
import { cancel } from './job-queue-gestures';
import { shelfJobs } from './job-queue-shelf';

/**
 * The three things that become an engine child.
 *
 * They share `requests`, `pump()` and the whole run-and-report path because
 * from here they are the same job: spawn foundry, read its stderr, report what
 * it wrote. Only `argsFor` and the reading-server wait can tell them apart.
 *
 * FOUR NOW, and the fourth is the cleanup's triage (`CleanTriageRequest`): a
 * model pass over the materialised book, like the analysis, that lands no step
 * at all. It is not a text pass — it writes no records and names no step — so it
 * is its own member rather than a fourth arm of `TextPassRequest`, whose every
 * reader wants a records file and a step id this shape does not have.
 *
 * AND A FIFTH, the analysis's ranking (`AnalysisRankRequest`), which is to the
 * analysis what the triage is to the cleanup: a decide-model pass that writes one
 * file the row behind it reads.
 */
export type EngineRequest = JobRequest | TextPassRequest | AnalyzeRequest | CleanTriageRequest | AnalysisRankRequest;

export const jobs: Job[] = [];

/**
 * ONE JOB THIS SCHEDULER HAS RUNNING, AND THE GESTURE THAT STOPS IT.
 *
 * Deliberately not a `RunHandle`: an engine child and an in-process download
 * have nothing in common except that both must stop when the row's ✕ is
 * pressed.
 *
 * ── Why `cancel` is nullable, and what null MEANS here ──────────────────────
 *
 * A slot is taken the moment `pump()` chooses the row, which is BEFORE there is
 * a child to kill: a reading waits minutes for its server first. So null is
 * "this job holds its slot but has spawned nothing yet", which is exactly the
 * state the old code expressed by leaving `running` null through the wait — and
 * `cancelHere` reads it the same way it always did, falling through to settle
 * the row itself rather than calling a cancel that does not exist.
 *
 * It goes back to null at `release()`, when the last child of the run has
 * exited and the landings are still ahead. That, too, is what the single slot
 * did: `running = null` fired at the same point.
 */
export interface Slot {
  readonly id: string;
  /**
   * WHAT THIS JOB IS HOLDING, resolved from its kind at the moment it started.
   *
   * Kept on the slot rather than re-derived from the row, so a lane's
   * occupancy is counted from what is actually held. `unscheduled` cannot
   * legitimately appear (a mint is born `running` and this scheduler only ever
   * claims a `queued` row) and is admitted anyway, because the alternative is a
   * cast asserting to the compiler something only a comment can promise.
   */
  readonly resource: JobResource;
  /**
   * WHICH COMPUTE LANE THIS RUN HOLDS — a slot's name, or null for a run that
   * holds none.
   *
   * ── The field Package G added, and the three states it has ────────────────
   *
   * The GPU side of the board is one lane per compute slot now
   * (`computeLanes`, shared/queue-board.ts), so "how many GPU runs are going" is
   * no longer the question the scheduler asks — it asks WHICH MACHINE each one is
   * on, and this is the answer.
   *
   *   * A NAME, set the moment the row is picked (`laneAtPick`) when the answer
   *     is already knowable: a run that is never placed holds the local lane, and
   *     a row pinned to a slot holds the one it named. Reserving before the first
   *     await is what stops two rows in ONE synchronous pump pass from both
   *     seeing the same lane free — the same argument the slot map itself makes.
   *   * A NAME, set later by the walk, when the row said `any` and the walk chose
   *     (`LaneClaim`, electron/crucible-dispatch.ts). It moves as the walk steps
   *     past a busy machine, because a run holds exactly one lane and claiming
   *     the next candidate gives the last one back.
   *   * NULL, for a run that holds no compute lane at all: every CPU row, and an
   *     install, which holds the whole board by a different rule.
   *
   * A NAME THAT IS IN NO LANE LIST IS LEGITIMATE and is the point of keeping a
   * string rather than a reference: a row pinned to a server that was switched
   * off holds a lane nothing else can want, gets picked, and gets dispatch's
   * sentence about what it is waiting for — which is how a person finds out.
   */
  on: string | null;
  cancel: (() => void) | null;
}

/**
 * THE BOARD, AS OF NOW — every job this scheduler is running, keyed by row id.
 *
 * ── It replaces one variable, and the shape of the replacement is the point ──
 *
 * This was `running: {id, cancel} | null`, and beside it lived a `starting`
 * flag covering the gap between choosing a row and its child existing. Both
 * are gone into this map, and the flag is gone rather than generalised: a slot
 * is TAKEN at the moment of choosing, so the window `starting` existed to
 * cover — a second `pump()` seeing an empty slot during the reading server's
 * minutes-long wait and putting two engines on one card — is closed by the
 * occupancy itself instead of by a second variable that every path had to
 * remember to clear. There is one fact now, and it is the one the drain, the
 * cancel, the shutdown and the lane counts all read.
 *
 * EMPTY IS THE WHOLE OF "NOTHING IS RUNNING HERE", which is what makes the
 * drain test below one line. `detachedRuns` is the other half and is
 * deliberately not in this map — see its own note.
 */
export const slots = new Map<string, Slot>();

/**
 * THE RUNS NOBODY HERE SCHEDULED — one entry per live `runJob`, keyed by row id.
 *
 * ── Why they are beside the slot rather than in it ──────────────────────────
 *
 * `slots` is the pump's BOARD and its meaning is "what the internal queue is
 * running". A job the host's scheduler chose must not take a slot on it, in
 * either direction: it must not WAIT for one (the host said now, and `runJob`
 * that waited would hang the host's pump on a queue it cannot see), and it must
 * not HOLD one (a host that calls `exportEpubFromStep` and awaits the answer while
 * a three-hour reading runs would be waiting for that reading — a deadlock built
 * out of two correct-looking rules).
 *
 * THE LANES DID NOT CHANGE THIS, and it is worth saying because a two-lane
 * board looks like somewhere a host's run could be filed. It is not: the lanes
 * are this scheduler's account of what IT decided to run, and a host's
 * scheduler cannot see them, so a host run counted into a lane would be this
 * app rationing slots against a decision it was told about rather than asked
 * for. What a detached run DOES hold is the drain, for the reason at `pump`.
 *
 * A LANE PER MACHINE DID NOT CHANGE IT EITHER (Package G), and the temptation
 * there is larger: a host that offers a slot list is naming machines this app can
 * now count, so filing the host's runs against them looks like bookkeeping. It
 * would be the same mistake wearing better clothes — the host's queue decides
 * what runs on its own machines, and a claim of ours against one of them would
 * refuse a row somebody's host had already committed to. So a detached run claims
 * no lane at all: `placeRun` hands the walk a claim that says yes to everything.
 *
 * What they are for is the same two things the slot is for: a ✕, and a quit. So
 * `cancelHere` looks here when the slot is not this row, and `shutdown` stops
 * every one of them.
 *
 * NO LONGER EMPTY STANDALONE. It was — nothing ran detached without a host
 * queue to have scheduled it — until exports started running under the dialog
 * that asked for them (`runNow`), which goes through `runDetached` in both worlds
 * for the same reason a host's run does: the deciding already happened, at the
 * button. Every reader of this map wants exactly that run counted — the drain
 * holds while it lives, its ✕ reaches it, and `shutdown` stops it.
 */
export const detachedRuns = new Map<string, () => void>();

/**
 * Rows whose ending was a host's RESUMABLE STOP rather than a cancel.
 *
 * Recorded at the abort, because that is the only moment the gesture exists
 * (`RESUMABLE_STOP`, shared/types.ts): `RunOptions` is handed over before the
 * engine spawns and cannot know which button a person will press. Read once, at
 * the one branch that destroys anything, and cleared by `settled` — the one
 * ending every path in this file reaches — so a row id cannot carry a stale
 * promise into whatever runs next.
 *
 * ABSENT MEANS CANCEL, which is the default the whole feature turns on: the ✕,
 * an internal cancel and a host that says nothing all keep today's behaviour.
 */
export const resumableStops = new Set<string>();

/**
 * THE RUNS THAT ARE LANDING — the window in which a row's ending is the RUN's to
 * say and nobody else's, by row id.
 *
 * ── The one thing it decides ────────────────────────────────────────────────
 *
 * `cancelHere` settles a `running` row that has no live child of its own, and it
 * has to: a job waiting for the reading server is `running` for minutes before
 * there is anything to kill, and a ✕ that did nothing there would leave the
 * button dead for all of them. But there is a SECOND way a running row has no
 * child, and it is the opposite case — the child has already exited, the product
 * is on disk, and `carry` is between `wires.release()` and the line that writes
 * the row's outcome, removing the intermediate and the derived book. Two real
 * disk operations, both awaits.
 *
 * A cancel landing in there settled the row `cancelled`, swept the derived book
 * out from under the landing and told every listener — and then the landing
 * wrote `done` over it and settled it again. TWO ENDINGS FOR ONE RUN, which is
 * exactly what `onJobSettled` promises never happens (`exportEpubFromStep`
 * resolves on the first and rejects on the second), plus a cascade that cancels
 * the chain behind a job whose product had just landed.
 *
 * So this is the ordering, said out loud: the run owns the ending from the
 * moment its engine is gone, and a ✕ that arrives after that is a gesture about
 * work that is already done. Entered beside `wires.release()` and left in
 * `executeJob`'s `finally`, so it cannot outlive the run that made it.
 */
export const landings = new Set<string>();

export let notify: (jobs: Job[]) => void = () => { /* set by main */ };

/** Where the queue publishes. Called on every mutation, with the whole list. */
export function onQueueChanged(listener: (jobs: Job[]) => void): void {
  notify = listener;
}

/**
 * The other thing this queue publishes: an export, the moment it is filed.
 *
 * ── Why it is a registration and not an import ──────────────────────────────
 *
 * Because the queue must not know what a HOST is. Hosted, an export landing is
 * the moment BookForge's versions page gains a row (docs/BOOKFORGE-HANDOFF.md
 * §8) — but this module's business is spawning the engine and reporting what it
 * wrote, and a queue that imported the mount seam to tell it so would be the
 * bottom of the graph reaching for the top. So it is `onQueueChanged`'s shape,
 * for the same reason: main wires it, and main is the only side that knows
 * whether anybody is listening.
 *
 * ONE LISTENER, replaced rather than appended, exactly like the one above. There
 * is one host per process and the alternative — a list — would invite a second
 * subscriber whose failure the first one would have to survive.
 */
export let exportLanded: (landing: ExportLanding) => void = () => { /* set by main */ };

export function onExportLanded(listener: (landing: ExportLanding) => void): void {
  exportLanded = listener;
}

/**
 * The third thing this queue publishes: ONE JOB IS OVER — settled in whatever
 * state, or taken out of the list before it ever ran.
 *
 * ── What could not be learned without it ────────────────────────────────────
 *
 * A job that FAILS announces nothing. `onExportLanded` above fires only where
 * there is something to file, which is exactly right for a landing and useless
 * to anybody waiting for an answer: an unattended export ordered from outside
 * this window (`exportEpubFromStep`, electron/mount.ts) has to hear "the engine
 * refused" as surely as it hears "here is the file", or the caller waits for a
 * landing that is never coming. The alternative was a poll over `listJobs`,
 * which is a loop asking a question this module already knows the answer to.
 *
 * ── It fires LAST, and that ordering is the contract ────────────────────────
 *
 * After the tray row, after the announcement, after everything a settle
 * produces. A waiter matching a landing must see the landing FIRST or it would
 * reject a job that succeeded — so "settled" here means "and nothing else is
 * coming from this job", which is the only reading that makes it usable as an
 * ending. `changed()` cannot carry this for the same reason: it fires the
 * instant a state is written, with the landing still ahead of it.
 *
 * ── A ROW REMOVED COUNTS, and that is not a stretched definition ────────────
 *
 * `remove` takes a held or queued job out of the list entirely — it never
 * settles, it is simply gone — and a caller waiting on it would wait forever.
 * What it hears is this, with the row's own state on it, which is honest: this
 * job left the queue without producing anything.
 *
 * MANY LISTENERS, unlike the two above, and they unsubscribe. Each waiter is
 * about ONE job and lives for as long as that job does, so a single slot would
 * mean two unattended exports fighting over it; the returned function is how a
 * waiter stops listening the moment its own job is over.
 */
export const settleListeners = new Set<(job: Job) => void>();

export function onJobSettled(listener: (job: Job) => void): () => void {
  settleListeners.add(listener);
  return () => { settleListeners.delete(listener); };
}

/** One row as anything outside this module may hold it: deep enough to be safe. */
export function copyOf(job: Job): Job {
  return {
    ...job,
    progress: job.progress ? { ...job.progress } : null,
  };
}

export function listJobs(): Job[] {
  // A copy: the renderer's mirror must not be able to reach back into the truth.
  return jobs.map(copyOf);
}

// ─────────────────────────────────────────────────────────────────────────────
// The host's queue, when there is one — the routing, and the mirrored shelf
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ONE QUESTION THE DOORS ASK, and the only place anything in this file asks
 * it.
 *
 * ── Why it is a function and not a flag ─────────────────────────────────────
 *
 * Because a flag would have to be SET, which means a mount-order bug is a
 * silently unrouted queue. The host record is written once by `mountFoundry`
 * (electron/host.ts) and read here on every call, so the answer cannot go stale
 * and there is nothing to keep in step.
 *
 * ── And why nothing beneath the doors calls it ──────────────────────────────
 *
 * The routing decision belongs to the DOOR somebody came through, and by the
 * time a job is executing the decision has been made — twice over, because a
 * routed job comes back through `runJob` having been chosen by the host. If
 * `executeJob` or a landing asked this question, a hosted run and a standalone
 * run would be two behaviours in one body, which is exactly the drift the split
 * exists to prevent. Grep this name: it appears in the six routed doors, in the
 * drain, and in the two functions that mirror the host's rows. Nowhere else.
 */
export function hostQueue(): FoundryHostQueue | null {
  return foundryHost()?.hostQueue ?? null;
}

/**
 * EVERY ROW THE HOST HOLDS, KEYED BY THE FOLDED PROJECT DIRECTORY.
 *
 * ── Why per project going in and one list coming out ────────────────────────
 *
 * The host pushes per project, because that is how it knows its own work — a
 * queue row is about a book. The SHELF is one global list across every project
 * (app/src/app/core/queue.service.ts holds a single signal, set from
 * `queue:changed`), and hosted it must draw the host's work for the whole
 * machine rather than only the book that happens to be open. So the pushes
 * accumulate here and flatten on the way out.
 *
 * FOLDED, on the house rule every path key in this app obeys: on Windows one
 * directory arrives spelled three ways, and a host pushing under
 * `E:\Bookforge\projects\Twain-a1b2` while another push says `e:/bookforge/...`
 * would be two spellings of one project holding two sets of rows. Whole paths,
 * never basenames.
 *
 * AN EMPTY PUSH IS THE ONE PIECE OF NEWS THE MIRROR CANNOT INFER, and it is kept
 * as a real statement rather than deleted: a project whose last row finished
 * says so once, on the falling edge, and the entry stays holding an empty list.
 * `setHostNodes`' rule exactly, one socket along.
 */
export const hostRowsByProject = new Map<string, readonly FoundryJobRow[]>();

/**
 * THE ROWS OF OURS THAT ARE A HOST'S ROW SEEN FROM THE INSIDE — the twins, and
 * the one thing a hosted shelf must not draw beside the host's own list.
 *
 * ── What a twin is ─────────────────────────────────────────────────────────
 *
 * `runJob` is the seam door (electron/mount.ts): the host's pump has chosen one
 * of ITS rows and asks this app to run it now, and this app mints a row of its
 * own for it because the landings, the settle, the guards and the ✕ are all
 * things a ROW carries (`runJob` argues it at length). That row is not a second
 * piece of work. It is the host's row seen from the side that spawns the engine,
 * and the host is already publishing the other half of it through
 * `setHostQueueRows` — so the two are one job filed in two lists, which is
 * exactly the shape `shelfJobs`' never-a-merge rule exists to keep off a screen.
 *
 * ── The night it was drawn twice ───────────────────────────────────────────
 *
 * Between 2026-09-08 (`shelfJobs` began drawing every LIVE row of ours, for the
 * deferred export that was visible in neither window) and this line, the twin
 * passed that filter. ONE Clean text ordered in BookForge drew TWO grayed
 * "Cleaned for narration" cards under one step, both running, both 4% (Owen,
 * 2026-09-11). They were identical by construction: the tree keys a promised
 * card on `Job.mints` and `promisedBy` copies that onto the twin verbatim, and
 * `admitPending` (shared/pending.ts) skips a promise whose step has LANDED —
 * never one that is already promised by another row.
 *
 * ── KEYED ON THE ROW ITSELF, so the mark cannot outlive what it is about ────
 *
 * A set of ids would have to be swept at all five places a row leaves `jobs`,
 * and the sixth one added later would leak a mark that no row answers for. This
 * queue mutates rows in place and never replaces one — `copyOf` exists precisely
 * so that what leaves this module is a copy — so a row's identity is as durable
 * as its id, and a WeakSet forgets the mark in the same breath the row is
 * forgotten.
 */
export const hostScheduled = new WeakSet<Job>();

export function changed(): void {
  notify(shelfJobs());
}

/**
 * One spelling for a path, so Windows' three become one.
 *
 * It came from electron/workspace.ts with the translate rotation, and it is the
 * fold `pendingFor` above spells inline for the same reason it spells it inline:
 * that one hoists the key out of a loop over every job, this one compares exactly
 * two paths. The house pattern is a fold beside whoever needs it rather than a
 * shared path module — electron/recents.ts and electron/overlays.ts each keep
 * their own — because the answer is a fact about the filesystem underneath, and
 * app/shared is compiled into the renderer where there is no `node:path` at all.
 */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** The full request, kept beside the job — the job itself is the PUBLIC shape. */
export const requests = new Map<string, EngineRequest>();

/**
 * ONE PROMISE PER LIVE RUN, and one per lease still being given back.
 *
 * Sets of promises rather than counters because `drained()` has to WAIT, and a
 * counter can only be polled. Both are self-emptying: the entry is deleted in the
 * `finally` that put it there.
 */
export const liveRuns = new Set<Promise<void>>();

export const releasing = new Set<Promise<void>>();

/**
 * THE ENGINE'S LAST WORDS, kept for the one caller that is not the row.
 *
 * `next.error` carries the whole stderr for a failed run and always has; what it
 * cannot carry is the case where the row is then STOPPED, which erases it
 * (BookForge P6). A host's outcome is handed the tail separately so its own log
 * has a copy that nothing on this side can overwrite. Keyed by job id, written at
 * the one arm that knows the stderr, and consumed by `runDetached` — a map rather
 * than a field on the row because it is not a fact about the row, it is a fact
 * about the child that has just exited.
 */
export const lastEngineStderr = new Map<string, string>();

/**
 * WHAT THE ENGINE SAID WHEN IT STOPPED, out of everything it said on the way.
 *
 * The CLI prints its one closing sentence as `foundry: <message>` (src/cli.ts),
 * possibly over several lines, possibly with a stack behind FOUNDRY_STACK, and
 * nothing after it. So the sentence is the LAST line that opens `foundry: `
 * and everything below it, with the prefix dropped. A stderr with no such line
 * is a child that died some other way (a crash, a signal), and its last
 * non-empty line is the nearest thing it has to a sentence. Empty for an empty
 * stderr — the caller says the engine had nothing to say.
 *
 * The whole stderr still goes to the console and to `lastEngineStderr`: this is
 * the row's sentence, not the diagnostic.
 */
export function engineSentence(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/);
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (lines[at]!.startsWith('foundry: ')) {
      return lines.slice(at).join('\n').replace(/^foundry: /, '').trim();
    }
  }
  return lines.reverse().find((line) => line.trim().length > 0)?.trim() ?? '';
}

/**
 * ── THE WAIT LEDGER: WHEN A PARKED ROW MAY BE LOOKED AT AGAIN ──────────────
 *
 * A row whose slot is busy goes BACK TO `queued` wearing the reason, and that is
 * the whole shape of waiting for a server in this app. The alternative — holding
 * the lane while the Mac finishes a narration — would mean one unreachable
 * server stopping every other job on the board: a lane is one machine
 * (`computeLanes`, shared/queue-board.ts), a row sitting in it is a row nothing
 * can run beside, and a row waiting for a machine it has not got is a row holding
 * a lane it is not using. Package G made that worse rather than better, which is
 * worth saying: a row parked on the Mac's lane would now be blocking the Mac
 * specifically, so a person watching the bench would see an idle card with a job
 * apparently in it.
 *
 * WHICH MAKES A TIMESTAMP NECESSARY. `pump` re-picks any `queued` row it can,
 * synchronously, in a loop — so a row parked and immediately re-picked would be
 * a poll as tight as the CPU allows, hammering somebody else's server with
 * capability reads. This map is the only thing standing between that and a
 * denial of service against a machine that is merely busy.
 *
 * NOT ON THE ROW, deliberately. It is scheduling state, it is meaningless to a
 * host mirroring rows, and a wire field that ticked would make every renderer
 * repaint on a clock. What the person sees is `Job.message`, which already says
 * the sentence.
 */
export const parkedUntil = new Map<string, number>();

/**
 * RUNS THE ENGINE PARKED — the park sentence by job id, from the arm that read
 * exit `ENGINE_PARKED_EXIT` to the door that has to say it.
 *
 * A pump-driven row never lands here: the arm re-queues it itself, after the
 * settle, with `parkedUntil`. A detached run (`runJob` at the host's seam, or the
 * dialog's own) has no pump to come back to, so the sentence is left for
 * `runDetached` to pick up and answer with as `parked` — the fifth outcome, and
 * the one that keeps a stale socket from being filed as a failed row.
 */
export const parkedRuns = new Map<string, string>();

/**
 * HOW LONG A PUMP-DRIVEN ROW SITS OUT AFTER THE ENGINE PARKED — one minute.
 *
 * Not `parkDelay`'s three-seconds-doubling: that backoff is for a placement that
 * was refused before anything ran, and the engine has just spent about eight
 * minutes of its own budget waiting on the same server. A minute is long enough
 * that the next attempt is not the ninth try at a socket that has been dead for
 * nine, and short enough that a proxy that came back is used while somebody is
 * still watching.
 */
export const PARK_AFTER_WEATHER_MS = 60_000;

/**
 * THE LEASE EACH RUNNING ROW HOLDS ON A CRUCIBLE'S RESIDENT MODEL.
 *
 * Off the row for `parkedUntil`'s reason and one stronger: a lease is a live
 * object with a timer in it, and `Job` is a wire shape that crosses the preload
 * and is copied to a host. Keyed by job id here, taken out and released in
 * `settled`, which is the one place every ending in this file passes through.
 */
export const sessions = new Map<string, HeldSession>();

/** How many times each parked row has been turned away. Drives the backoff. */
export const parkCount = new Map<string, number>();

/**
 * THE BACKOFF — a few seconds, doubling, capped at half a minute.
 *
 * The cap is what makes the whole thing honest rather than clever: a server that
 * has been narrating for an hour is checked twice a minute forever, which costs
 * nothing and means the row starts within thirty seconds of the card coming
 * free. An unbounded backoff would eventually be a row that waits hours after
 * the thing it was waiting for ended.
 */
export function parkDelay(id: string): number {
  const seen = (parkCount.get(id) ?? 0) + 1;
  parkCount.set(id, seen);
  return Math.min(30_000, 3_000 * 2 ** (seen - 1));
}

/** This row is no longer waiting for anything. Called on every settle. */
export function forgetPark(id: string): void {
  parkedUntil.delete(id);
  parkCount.delete(id);
}
