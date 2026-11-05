/**
 * job-queue-run — runs a host or this process orders directly, off the shelf: runJob, runDetached and runNow.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runEngine } from './engine';
import { ledgerOf, projectDirOf, readManifest, restoreFinalRotation, restoreRotation, type FinalRotation, type Rotation } from './projects';
import { materializeCleanTriage } from './workspace';
import type { Job, JobRequest, RunOutcome, RunPlacement, RunVenue } from '../shared/types';
import { isResumableStop } from '../shared/types';
import { type PlacementWait } from './crucible-dispatch';
import { pump } from './job-queue-board';
import { ANALYSIS_RANK_TITLE, CLEAN_TRIAGE_TITLE, pendingFor, titleForTextPass } from './job-queue-enqueue';
import { cancel, cancelHere, release } from './job-queue-gestures';
import { executeJob } from './job-queue-placing';
import { deferralOf, homeOf, isTextPassRequest, placedBy, productOf, promisedBy } from './job-queue-products';
import { changed, copyOf, detachedRuns, forgetPark, hostQueue, hostScheduled, jobs, lastEngineStderr, parkedRuns, requests, resumableStops } from './job-queue-state';
import type { EngineRequest } from './job-queue-state';

/**
 * RUN THIS JOB NOW, BECAUSE SOMEBODY ELSE'S SCHEDULER SAYS SO — the second door
 * onto `executeJob`, and the mount seam's own (electron/mount.ts).
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * A host that keeps its own queue (`FoundryHostQueue`) takes over the DECIDING
 * and nothing else. Its pump reaches this: here is a request, here is the
 * position it was ordered from, run it. There is no waiting, no hold, no place
 * in this app's list — the waiting already happened, in a list this app cannot
 * see, and asking a person to press Start twice would be the hold applied to a
 * commitment somebody already made.
 *
 * ── IT STILL MINTS A ROW, AND THAT IS THE LOAD-BEARING PART ─────────────────
 *
 * The obvious shortcut — spawn the engine, resolve — would break the host's own
 * narrate. A ROW is what carries `parentStep` into the landing, what
 * `onExportLanded` is composed from, what `onJobSettled` publishes, what
 * `exportEpubFromStep` awaits, and what the delete guards and `foundryBusy` count
 * when somebody asks whether a folder is safe to erase. So a job the host
 * scheduled gets exactly the same row a job somebody pressed for gets — born
 * `running`, because that is the one thing that is genuinely different about it.
 *
 * ── The answer is the ROW, and it is the row for a reason ───────────────────
 *
 * Two written contracts disagreed here before either side built against them: a
 * `Settled` type that does not exist in this codebase, and a `{ok} | {ok,error}`
 * result reasonably derived from it. BOTH ARE WRONG THE SAME WAY — neither can
 * say CANCELLED. `JobState` (shared/types.ts) distinguishes `done`, `failed` and
 * `cancelled` deliberately: a cancel is somebody spending GPU and then taking it
 * back, not a failure, and filing one as a failure is how a host's retry restarts
 * work a person just stopped. The row already spells all three, plus the engine's
 * own words in `error` — and it is the very shape the host mints going in and
 * pushes back through `setHostQueueRows`, so there is ONE account of what happened
 * rather than two that can drift.
 *
 * IT RESOLVES RATHER THAN REJECTS, whatever the state. A failed run is not an
 * exception here: it is a fact about a row, reported the way this queue has always
 * reported it.
 */
export async function runJob(request: EngineRequest, opts: RunOptions = {}): Promise<RunOutcome> {
  /*
   * EVERY CALLER OF THIS DOOR IS THE HOST, BY CONSTRUCTION, and that is what
   * lets the row below be marked as the host's twin without anybody being asked.
   * It is exported for electron/mount.ts and reached from nowhere inside this
   * app: `runNow`, the other detached door, calls `runDetached` itself and says
   * there that its run is nobody's twin. So "a host scheduled this" is a fact
   * about WHICH DOOR WAS OPENED rather than a claim passed in and trusted.
   */
  const { job, wait, parked, stderrTail } = await runDetached(request, opts, true);
  /*
   * ── THE FIVE ANSWERS, AND WHY THEY ARE FIVE ───────────────────────────────
   *
   * A WAIT IS NOT A ROW. Nothing ran, nothing was spent, and the row minted for
   * the attempt has already been discarded (`runDetached`) — so handing one back
   * would be handing over residue and inviting the host to draw it. What the host
   * needs is the holder's own sentence and whether time alone will fix it.
   *
   * A PARK IS NOT A ROW EITHER, and it is not a failure (2026-09-21). The engine
   * ran, the model server's weather outlasted its retry budget, and it exited
   * `ENGINE_PARKED_EXIT` with the pages it read banked. The row is discarded the
   * way a wait's is; what the host needs is the engine's sentence to re-queue by,
   * and the stderr for its log, which holds every weather line before the park.
   *
   * THE OTHER THREE ARE THE ROW, exactly as this door has always answered, and
   * `cancelled` stays distinct from `failed` for the reason it always was:
   * somebody spent GPU and took it back, and filing that as a failure is how a
   * retry restarts work a person just stopped.
   *
   * THE STDERR TRAVELS SEPARATELY on a failure. `row.error` is the engine's own
   * sentence and the host puts it on the row; the tail is for the host's LOG,
   * which is the copy that survives a Stop erasing the row's error (BookForge P6).
   */
  if (wait !== null) {
    return { outcome: 'wait', busyLine: wait.reason, standing: wait.standing };
  }
  if (parked !== null) return { outcome: 'parked', reason: parked, stderrTail };
  if (job.state === 'cancelled') return { outcome: 'cancelled', row: job };
  if (job.state === 'failed') {
    return {
      outcome: 'failed',
      row: job,
      error: job.error ?? 'Foundry did not say why this run failed.',
      stderrTail,
    };
  }
  return { outcome: 'done', row: job };
}

/**
 * THE PRINTED FORMS OF THE BOOK A CLEANUP (OR ITS TRIAGE) WILL READ — `foundry
 * clean-forms` over that book, for a host that decides readings before the run
 * (BookForge's narration glossary; the engine's src/clean/forms.ts).
 *
 * THE SAME BOOK THE RUN WILL READ, made the way the spawn makes it: the row the
 * request names (`deferred.from`, else `at`), replayed by `materializeBook`. A
 * named row that never landed is refused with `materializeAtSpawn`'s sentence, so
 * a glossary is never decided over a book the run will not be shown.
 *
 * NOTHING IS LEFT BEHIND. The book and the forms file are both this call's, made
 * in the OS temp directory and the project's `derived/`, and both are removed
 * however it ends; what the caller keeps is the parsed file.
 */
export async function printedFormsForRun(
  request: EngineRequest,
  onLine?: (line: string) => void,
): Promise<unknown> {
  if (request.kind !== 'clean' && request.kind !== 'clean-triage') {
    throw new Error(`Printed forms are listed for a cleanup or its triage, not a ${request.kind} run.`);
  }
  const dir = homeOf(request) ?? projectDirOf(productOf(request));
  if (dir === null) {
    throw new Error('This cleanup is not inside a project this library holds, so there is no book to list.');
  }
  const deferred = deferralOf(request);
  const named = deferred !== undefined ? deferred.from : request.at ?? null;
  return printedFormsAt(dir, named, onLine);
}

/**
 * THE PRINTED FORMS OF A BOOK AT ONE STEP of its ledger (null: the standing
 * position) — the same listing, asked by a host OUTSIDE any cleanup: BookForge's
 * pronunciation guide is its own step (Owen, 2026-10-03: *"the glossary building
 * step should be its own process"*), made from the row a person pressed on, and
 * the cleanup later reads what it decided. `printedFormsForRun` is this, with the
 * step a run's request names.
 */
export async function printedFormsAt(
  dir: string,
  named: string | null,
  onLine?: (line: string) => void,
): Promise<unknown> {
  const ledger = ledgerOf(await readManifest(dir));
  const step = named === null ? null : ledger.steps.find((row) => row.id === named) ?? null;
  if (named !== null && step === null) {
    throw new Error(
      'The step this was to be made from never landed, so there is nothing to make it out of. '
      + 'Whatever was going to produce it left the queue — order this again from a step that exists.',
    );
  }
  const { bookPath } = await materializeCleanTriage(dir, step);
  const out = path.join(os.tmpdir(), 'foundry', `printed-forms-${randomUUID()}.json`);
  try {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const run = runEngine(['clean-forms', '--book', bookPath, '--out', out], onLine);
    const ended = await run.done;
    if (ended.code !== 0) {
      const tail = ended.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      throw new Error(`foundry clean-forms ended with code ${ended.code}: ${tail}`);
    }
    return JSON.parse(await fsp.readFile(out, 'utf8')) as unknown;
  } finally {
    await fsp.rm(out, { force: true });
    await fsp.rm(bookPath, { force: true });
  }
}

/**
 * WHAT WHOEVER SCHEDULED A DETACHED RUN HANDS IT — named once, because two doors
 * spell it: the seam's (`runJob`) and the dialog's (`runNow`).
 */
export interface RunOptions {
  /**
   * The project's position at the moment the person pressed — carried by the
   * host from its own `enqueue` and handed straight back, never re-read here.
   * `Job.parentStep` holds the whole argument: a pointer that moves while a row
   * waits must not change what the run is recorded as being made from, and
   * hosted the waiting is longer, not shorter.
   */
  parentStep?: string | null;
  /** Every line the engine writes, as it writes it. The row gets them too. */
  onProgress?: (line: string) => void;
  /**
   * THE SAME LINES, FOR THE CALLER'S LOG — see `RunWires.line`.
   *
   * It is called in `onProgress`'s own `finally`, so a reporter that throws
   * cannot cost the log the line that explains the failure. A host that tees this
   * to a file is the reason a hosted run's words survive the window being
   * reloaded and the row being stopped (BookForge P5/F7).
   */
  onLine?: (line: string) => void;
  /**
   * WHERE THIS RUN WAS PLACED, once, before the spawn — see `RunWires.placed` and
   * `RunPlacement`. The host records it so a hard kill can release the lease.
   */
  onPlaced?: (placement: RunPlacement) => void;
  /**
   * STOP THIS RUN — mapped onto exactly what the ✕ does to a running job.
   *
   * It is `cancelHere` and not `cancel`, deliberately: this row is Foundry's
   * own, and a cancel that routed would hand our id to the host's list, which
   * has never heard of it, while the engine went on reading. An abort that
   * arrives before the child exists is the same gesture the shelf makes on a
   * job waiting for the reading server — the row settles `cancelled` and the
   * run notices at the next checkpoint.
   */
  signal?: AbortSignal;
  /**
   * THE CARD THE SCHEDULER ALREADY ADMITTED THIS RUN TO — see {@link RunVenue}.
   *
   * It was `waitFor?: string`, and the change is what the word means rather than
   * what it carries. `waitFor` was a PREFERENCE that the placement was free to
   * re-decide; a venue is a DECISION already taken, with a poll, a lease
   * reservation and a slot charged behind it (BookForge's rulings 7 and 9 of
   * 2026-09-20). So the placement places there and nowhere else.
   *
   * Absent or null means the caller has no machine to name — a rendering, a
   * compile, an install — and this app's own default decides, which is what
   * `runNow` wants. The name is not validated here: a slot that has gone is a
   * wait with the placement's own sentence on it, which is where a name can be
   * checked against a list that is current.
   */
  venue?: RunVenue | null;
  /**
   * A FILE OF READINGS THE HOST DECIDED FOR THE WHOLE BOOK, for a cleanup or its
   * triage — see `CleanRequest.fixedReadings`. Put on the run's own copy of the
   * request at the mint; any other kind of run is refused with it, by name,
   * because a flag a run cannot carry must not be dropped on the floor.
   */
  fixedReadings?: string;
}

/**
 * ONE RUN, OFF THE BOARD — everything `runJob` above says, and the body the
 * dialog's door (`runNow`) shares with it.
 *
 * The two doors differ in exactly one thing, and it is not what the run DOES:
 * whether the work was scheduled by a host, which decides whether the row minted
 * here is a twin of a row the host is drawing already. Everything else — the
 * mint, the abort, the deferral, `executeJob`, the landing — is one path,
 * deliberately, on the rule this file states everywhere else: a hosted run and a
 * standalone run are the same run.
 */
export async function runDetached(
  request: EngineRequest,
  opts: RunOptions,
  /**
   * DID SOMEBODY ELSE'S SCHEDULER ORDER THIS — true at the seam, false at the
   * dialog, and it decides one thing only: whether the row below is marked as the
   * host's own row seen from the inside (`hostScheduled`) and therefore left out
   * of the hosted shelf, which is already drawing the host's half of it. A run the
   * dialog asked for is nobody's twin — no list anywhere else holds a row for it —
   * so it is marked nothing and stays drawn for as long as it lasts.
   */
  viaHost: boolean,
): Promise<{ job: Job; wait: PlacementWait | null; parked: string | null; stderrTail: string }> {
  const parentStep = opts.parentStep ?? null;
  if (opts.fixedReadings !== undefined) {
    if (request.kind !== 'clean' && request.kind !== 'clean-triage') {
      throw new Error(
        `A ${request.kind} run was handed fixed readings (${opts.fixedReadings}). Only a cleanup and its `
        + 'triage read them; nothing was started.',
      );
    }
    request = { ...request, fixedReadings: opts.fixedReadings };
  }
  /*
   * THE ROW, BORN RUNNING. Every field is composed exactly as `enqueueHere` and
   * `enqueueTextPass` compose theirs — the same output identity (asked of
   * `productOf`, which all three now share rather than each spelling as much of
   * the rule as its own argument type could reach), the same rewrite title, the
   * same `forStep` — because a row is what the shelf, the landings and the guards
   * all read, and a second way of building one would be a second answer to what a
   * job is.
   *
   * NO DEDUPE, and that is the one deliberate difference. `enqueueHere` hands
   * back an existing row rather than let two runs write one file, and that rule
   * belongs to whoever is SCHEDULING: a host with its own queue has already
   * decided that this should run now, and answering "no, have this other row
   * instead" would be Foundry overruling a decision it was told about rather than
   * asked for. What protects the file is the same thing that protects it there —
   * one scheduler.
   */
  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: productOf(request),
    kind: request.kind,
    state: 'running',
    progress: null,
    // THE ROW'S NAME, out of the one function both doors ask — see
    // `titleForTextPass`, where the rule and its exception live.
    ...(isTextPassRequest(request) ? titleForTextPass(request) : {}),
    ...(request.kind === 'clean-triage' ? { title: CLEAN_TRIAGE_TITLE } : {}),
    ...(request.kind === 'analysis-rank' ? { title: ANALYSIS_RANK_TITLE } : {}),
    ...(request.kind !== 'read' && !isTextPassRequest(request) && request.kind !== 'analysis'
      && request.kind !== 'clean-triage' && request.kind !== 'analysis-rank'
      && request.forStep !== undefined
      ? { forStep: request.forStep }
      : {}),
    parentStep,
    /*
     * WHAT THIS ROW WILL LAND, AND WHAT IT WAS CHAINED BEHIND — the third door
     * spreading `promisedBy`, on this function's own rule that a row is a row
     * however it was scheduled.
     *
     * `after` IS RECORDED AND NOT OBEYED HERE, which is the honest shape: by
     * calling this the host has already decided that now is the moment, exactly as
     * `runJob`'s no-dedupe paragraph argues. Foundry does not second-guess a
     * scheduler; what it does is refuse to RUN work whose parent never landed, and
     * that refusal is `materializeAtSpawn`'s, inside the run, where it can name
     * the step rather than the row.
     */
    ...placedBy(request.kind, opts.venue?.server),
    ...promisedBy(request),
    createdAt: Date.now(),
  };
  jobs.push(job);
  /*
   * AND IT IS THE HOST'S ROW SEEN FROM THE INSIDE, when the host is the one that
   * scheduled it. Marked HERE, at the mint, because this is the only moment
   * anything can tell — a row carries no record of which door minted it, and by
   * the time the shelf is composed the twin is indistinguishable from a row this
   * app ordered for itself. `hostScheduled` holds the whole of why the shelf must
   * draw one of the two and not both.
   */
  if (viaHost) hostScheduled.add(job);
  requests.set(job.id, request);
  changed();

  /*
   * THE ABORT IS ARMED BEFORE THE RUN, not inside it, so a signal that is already
   * aborted — or that fires while the reading server is coming up, minutes before
   * there is a child to kill — reaches the same `cancelHere` the ✕ reaches. The
   * listener is dropped in `finally`: a host that keeps one controller per row
   * would otherwise leave this queue holding a reference to every row it ever ran.
   */
  const abort = (): void => {
    /*
     * WHICH GESTURE THIS WAS, read here and nowhere else. The host's Stop and its
     * Cancel are one abort by the time `cancelHere` runs and one exit code by the
     * time the discard decides, so the reason is captured at the only instant it
     * is still distinguishable. See `RESUMABLE_STOP`, shared/types.ts.
     */
    if (isResumableStop(opts.signal?.reason)) resumableStops.add(job.id);
    cancelHere(job.id);
  };
  opts.signal?.addEventListener('abort', abort, { once: true });
  /*
   * A SIGNAL THAT WAS ALREADY ABORTED SPAWNS NOTHING, and it is worth the four
   * lines: a host whose user cancelled between its own pump choosing this row and
   * this call arriving would otherwise get a full engine run out of a request it
   * had already withdrawn. The row is settled `cancelled` by the same gesture the
   * ✕ makes and handed straight back, so the answer is the honest one rather than
   * a run nobody wanted.
   */
  if (opts.signal?.aborted === true) {
    abort();
    opts.signal.removeEventListener('abort', abort);
    return { job: copyOf(job), wait: null, parked: null, stderrTail: '' };
  }

  /*
   * ── AND THE MATERIALISE IS NOT HERE ANY MORE (PK6) ─────────────────────────
   *
   * `materializeDeferred` used to run between the mint and `executeJob`, in BOTH
   * doors, each with its own copy of the failed-row ending. It has moved inside
   * the run (`carry`), which is where the seed copy and the analysis checklist
   * already were and for their rule: a row that turns out to be waiting for a busy
   * card must leave the project exactly as it found it. Its refusal — a chained
   * row whose parent never landed — is unchanged and still lands as a failed row
   * with main's sentence on it, through `executeJob`'s own boundary.
   */
  let waited: PlacementWait | null = null;
  try {
    waited = await executeJob(job, request, {
      /*
       * OFF THE BOARD, which is `detachedRuns`' whole argument: this run was
       * scheduled by somebody who cannot see the board, so it must neither wait
       * for a slot nor hold one. The internal queue goes on doing its own work
       * beside this — an environment install, an export the host asked for by
       * name — and one machine's GPU has one owner because the HOST is scheduling,
       * not because this file is rationing two lists it cannot compare.
       */
      claim: (cancel) => { detachedRuns.set(job.id, cancel); },
      release: () => { detachedRuns.delete(job.id); },
      ...(opts.onProgress !== undefined ? { watch: opts.onProgress } : {}),
      ...(opts.onLine !== undefined ? { line: opts.onLine } : {}),
      ...(opts.onPlaced !== undefined ? { placed: opts.onPlaced } : {}),
    });
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    detachedRuns.delete(job.id);
  }
  /*
   * ── A WAIT LEAVES NO ROW BEHIND ───────────────────────────────────────────
   *
   * `remove`'s own rule, applied to a row that never started: *"a job that never
   * started spent nothing and produced nothing, and a `cancelled` row for it is
   * residue."* The scheduler that called will ask again when the card is free, and
   * that asking mints its own row; leaving this one would accumulate one grey row
   * per re-ask for the life of the process, in a list the hosted window cannot
   * even reach.
   *
   * NOT `settled`, deliberately: nothing ended. A settle would publish an ending
   * to every listener and cascade this row's chain away over a card being busy.
   */
  if (waited !== null) discardUnrun(job);
  /*
   * AND A PARK LEAVES THE SAME WAY A WAIT DOES: nothing landed, the row is
   * discarded, and the caller gets the engine's sentence to re-queue by. The
   * readings bank, not the row, is what the resume is made from.
   */
  const parked = parkedRuns.get(job.id) ?? null;
  if (parked !== null) {
    parkedRuns.delete(job.id);
    discardUnrun(job);
  }
  /*
   * ── AND IT DOES NOT PUMP, WHICH IS THE LINE THE READING SERVER LIVES ON ────
   *
   * Every other ending in this file calls `pump()`, because every other ending is
   * a slot coming free. This one is not: a detached run never took a slot, so
   * nothing on the board was ever waiting on it — an install or a host-ordered
   * export enqueued while this ran started immediately, on its own enqueue's
   * pump, subject only to the board's own occupancy.
   *
   * WHAT A PUMP HERE WOULD DO IS STOP THE READING SERVER. `pump()` declares drain
   * in its nothing-to-do branch, the internal list is empty between every pair of
   * the host's rows, and `keepServerWarmMinutes` defaults to 0 — which is an
   * immediate `stopPageReader`, not a countdown. A batch of ten readings would pay
   * ten model loads for a queue that never actually went quiet. Drain hosted is
   * the host's to declare, once, when its own pump has nothing left
   * (`hostQueueDrained`).
   */
  /*
   * THE STDERR IS CONSUMED HERE, so the map holds at most the rows that are
   * between their engine's exit and this line. Left to accumulate it would be a
   * copy of every failed run's output for the life of the process.
   */
  const stderrTail = lastEngineStderr.get(job.id) ?? '';
  lastEngineStderr.delete(job.id);
  return { job: copyOf(job), wait: waited, parked, stderrTail };
}

/**
 * TAKE A ROW OUT OF THE LIST WITHOUT ENDING IT — for the one case that is neither.
 *
 * A detached run that met a busy card never started: no engine, no lease, no
 * product, nothing to sweep. `settled` is the wrong door (it publishes an ending
 * and cascades the chain away) and so is leaving the row (it accumulates). This
 * is the third thing, and it exists exactly once.
 */
export function discardUnrun(job: Job): void {
  const index = jobs.indexOf(job);
  if (index >= 0) jobs.splice(index, 1);
  requests.delete(job.id);
  hostScheduled.delete(job);
  forgetPark(job.id);
  changed();
}

/**
 * RUN THIS EXPORT NOW, UNDER THE DIALOG THAT ASKED — the person-facing door onto
 * `runJob`, and the reason an export is not a queue row any more.
 *
 * ── Why an export does not wait ─────────────────────────────────────────────
 *
 * The queue exists for work that costs something: a reading is hours of GPU
 * against pages nobody has seen, a translation holds a model for the length of
 * a book. An export is neither — it is seconds of offline arithmetic over
 * answers already on the disk, and the person who pressed Export is standing in
 * front of the dialog waiting for exactly this file. Filing it in a list beside
 * the readings meant the dialog closed on a promise and the queue page was
 * where you went to find out whether the button worked. So the run happens
 * HERE, while the dialog holds the question open, and the settled row is the
 * answer it draws from.
 *
 * ── What is the same, which is everything that matters ──────────────────────
 *
 * It goes through `runJob`, so a row is minted for the length of the run — the
 * delete guards and `foundryBusy` count it, the ✕ can reach it through
 * `cancelHere`, and the landing is `executeJob`'s own: the `final/` rotation,
 * `recordFinal`, the host's `onExport` announcement, the settle. Nothing about
 * WHAT an export does moved; only the waiting is gone.
 *
 * ── The row leaves the list when it settles ─────────────────────────────────
 *
 * Whatever state it settled in. The dialog this answers is the surface that
 * reports the outcome — the engine's own words for a failure, the filed name
 * for a success — and a copy of that report parked in the shelf would be the
 * old behaviour back under a different door: a queue accumulating rows for work
 * that never waited. `settled` has already fired by then, so nothing that
 * listens for endings misses one.
 *
 * ── It never routes, and hosted the row is ours rather than the host's ──────
 *
 * A host queue takes over the DECIDING, and there is nothing here to decide:
 * the export runs at the press, exactly as `exportEpubFromStep` (the host's own
 * unattended door) has always stayed internal. So no row for this exists in the
 * host's list, which is why it is `runDetached(…, false)` and not `runJob`: it is
 * nobody's twin, and the hosted shelf draws it for the seconds it lasts with its
 * ✕ reaching it through `ourRow` (2026-09-08). What it must never be is marked
 * `hostScheduled`, which would hide a row that nothing else is drawing.
 *
 * ── The dedupe stays at this door ───────────────────────────────────────────
 *
 * `runJob` deliberately never dedupes — a host that scheduled a run is not to
 * be overruled — but this door IS the scheduler for what comes through it, so
 * it keeps `enqueueHere`'s rule: a row already waiting or running to write this
 * file is handed back as it stands, pending, and the caller reads the state to
 * tell "already being made" from a settle. Two runs writing one file is still
 * the worst outcome available.
 *
 * A READING IS REFUSED BY NAME. Nothing in the app sends one here, and nothing
 * ever should: hours of GPU under a dialog's spinner is the exact thing the
 * hold was built to prevent.
 */
export async function runNow(
  request: JobRequest,
  /** The position at the press — `enqueueHere`'s argument, for its reasons. */
  parentStep: string | null = null,
): Promise<Job> {
  if (request.kind === 'read') {
    throw new Error(
      'A reading is hours of GPU — it is queued and held for Start, never run under a dialog.',
    );
  }
  /*
   * AND A PROMISE IS REFUSED BY NAME, for the reading's reason said the other way
   * round. This door runs the work NOW, under a dialog somebody is watching; a
   * request carrying `deferred` cannot be run now by definition — the step it is
   * made from has not landed, so there is no book to compile and no chain to
   * replay. It belongs in the queue, behind the row that will land it, which is
   * what the export card does with it (`plan.deferred`, export-dialog).
   */
  if (deferralOf(request) !== undefined) {
    throw new Error(
      'This export is of a step that has not finished yet, so there is nothing to make it from '
      + 'right now. It belongs in the queue, behind the work it comes from.',
    );
  }
  const already = pendingFor(productOf(request));
  if (already) return copyOf(already);

  // NOT `runJob`: that door is the seam's and marks its row as a host's twin.
  // This run was decided here, at the button, and nothing anywhere else holds a
  // row for it — see the paragraph above and `hostScheduled`.
  const { job, wait, parked } = await runDetached(request, { parentStep }, false);
  /*
   * ── A WAIT HERE IS A FAILED EXPORT, BY NAME ───────────────────────────────
   *
   * This door has no queue behind it: the person is standing in front of the
   * dialog waiting for a file, and there is nobody to park the row for. It is also
   * close to unreachable — an export, a compile and a mint all take {@link
   * UNPLACED} (`capabilityClassOf` says they meet no model), so no placement of
   * theirs can wait — and "close to" is where the expensive failures live. So the
   * holder's own sentence becomes the dialog's answer rather than a promise that
   * never resolves.
   *
   * A PARK ANSWERS THE SAME WAY, for the same reason: nobody is here to re-queue
   * it, and the engine's sentence already says the pages are banked and the
   * same press resumes.
   */
  if (wait !== null || parked !== null) {
    return {
      ...job,
      state: 'failed',
      error: wait?.reason ?? parked ?? 'The run was parked.',
      finishedAt: Date.now(),
    };
  }

  /*
   * OUT OF THE LIST, NOW THAT EVERYTHING READ FROM IT. The landings, the
   * announcements and the settle all happened inside `runJob`; what remains is
   * a settled row whose whole account is about to be handed to the dialog that
   * is waiting on this return. `changed()` because the row WAS published while
   * it ran — the shelf that drew it running must hear that it is gone.
   */
  const index = jobs.findIndex((row) => row.id === job.id);
  if (index >= 0) {
    jobs.splice(index, 1);
    requests.delete(job.id);
    changed();
  }

  /*
   * RE-ASK THE DRAIN, STANDALONE ONLY. `runJob` ends without pumping so that a
   * host's back-to-back rows cannot tear the reading server down between every
   * pair (its own essay). Standalone there is no host to declare drain and this
   * run's `noteQueueBusy` cancelled whatever idle countdown was armed — so
   * without this, an export run over a warm server would leave it warm forever.
   * `pump()`'s nothing-to-do branch is the one place drain is declared, and its
   * three facts are all true again by here: the run is out of `detachedRuns`
   * before `runJob` returns.
   */
  if (hostQueue() === null) void pump();
  return job;
}

/**
 * Whichever rotation this job made, undone — because the run wrote nothing.
 *
 * ONE CALL AT BOTH SETTLES, and the two receipts are deliberately separate types
 * rather than one with a layer field on it. What a `generated/` rotation has to
 * put back is a file, a working tree, a step's location in a chain and that tree's
 * catalogue row; what a `final/` one has to put back is a file and a row. A shape
 * that carried both would be half-empty at every call site and would invite a
 * restore that reached for a working tree an export never had.
 *
 * At most one of them is ever non-null: `pump()` chooses the rotation by the same
 * flag that chooses the landing, so this reads as "put back whatever happened".
 */
export async function putBack(
  dir: string | null,
  rotation: Rotation | null,
  filed: FinalRotation | null,
): Promise<void> {
  if (dir === null) return;
  if (rotation !== null) await restoreRotation(dir, rotation);
  if (filed !== null) await restoreFinalRotation(dir, filed);
}
