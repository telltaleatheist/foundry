/**
 * job-queue — the conversions, owned by MAIN.
 *
 * It lives here and not in the renderer for the same reason BookForge's stages
 * do: an ng-serve reload, or a user navigating to Settings, must not be able to
 * kill ninety minutes of GPU. The renderer holds a MIRROR, pushed on every
 * change; it never holds the truth.
 *
 * SERIAL, always. The engine loads a document vision model and holds a GPU for
 * the length of a book; two of them on one machine is two runs that each take
 * twice as long, or an out-of-memory failure at page 200. `pump()` starts the
 * next queued job only when nothing is running.
 *
 * A job that reads through the LOCAL vLLM endpoint waits for that server first
 * (electron/vllm-server.ts). The wait is part of the job, not a thing that
 * happens beside it: the shelf says "Starting the reading server…", and a
 * server that will not start fails THAT job with the guest's own log tail.
 *
 * ── Nothing EXPENSIVE starts until the user says so ──────────────────────────
 *
 * A READING is enqueued HELD. It sits in the list, in order, visible, and does
 * nothing until `start()` releases it. `pump()` only ever claims a `queued` job,
 * so the gate is the state itself rather than a flag anything has to remember to
 * check.
 *
 * THE POINT IS THE BATCH. Enqueueing used to pump immediately, which made the
 * moment of configuring the moment of commitment: the first conversion was
 * already reading pages before the second book could be chosen, so "queue these
 * four and let them run overnight" was not a thing this app could do. `start()`
 * releases everything held AT THAT MOMENT and nothing else — a job added after
 * the press is held again, because Start means "run what is here" and a button
 * that silently also armed the future would make the next enqueue a surprise.
 *
 * A RENDERING IS NOT HELD, and the exception is the rule stated properly. The
 * hold exists so that hours of GPU are never spent by the act of configuring
 * them. A `vlm-convert --reuse-readings` over a finished bank spends no GPU at
 * all: it is arithmetic over answers already on the disk, it is offline, it
 * takes seconds, and it can be asked for again as often as somebody likes. There
 * is nothing to commit to, so there is nothing for Start to mean — and a person
 * who pressed Generate and then had to find this shelf and press another button
 * would be confirming a decision they had already made. It is still QUEUED
 * rather than run beside whatever is going: one engine at a time is a fact about
 * the machine, and it holds however cheap the job is.
 *
 * ── Environment installs share this queue, and are NOT held ──────────────────
 *
 * An `env-install` row is not a conversion, but it belongs here rather than
 * beside here. It is long, it is cancellable, and — the reason that decides it —
 * a conversion that needs the environment must wait BEHIND it. One serial queue
 * gives that ordering for free, where a downloader running alongside would let a
 * run start against the Python it is halfway through replacing.
 *
 * IT STARTS ON ITS OWN, WHICH IS THE ONE EXCEPTION TO THE RULE ABOVE, and the
 * reason is that it ALREADY HAD ITS START GESTURE. An install arrives from a
 * user pressing Install in Settings, or from the startup provisioner deciding
 * the app cannot work without it — both are explicit, and neither leaves a
 * person wondering what they are waiting for. Holding one would put a second
 * button between somebody and a download they just asked for, and would let the
 * startup provisioner queue five gigabytes that then sat there until a shelf the
 * user has never opened was expanded and pressed. The batch this file exists to
 * make possible is a batch of BOOKS; an install is plumbing.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { readAppSettings } from './app-settings';
import { parseProgressLine, runEngine } from './engine';
import { ENV_SPECS } from './env-catalog';
import { destFor, installEnv } from './env-install';
import {
  generatedRoleFor,
  projectDirOf,
  recordGenerated,
  recordReading,
  restoreRotation,
  rotateGenerated,
  type Rotation,
} from './projects';
import { readSettings } from './settings';
import { ensureServer, isLocalVllmEndpoint, noteQueueBusy, noteQueueIdle } from './vllm-server';
import type { EnvInstallRequest, Job, JobRequest, TranslateRequest } from '../shared/types';

/**
 * The two things that become an engine child.
 *
 * They share `requests`, `pump()` and the whole run-and-report path because
 * from here they are the same job: spawn foundry, read its stderr, report what
 * it wrote. Only `argsFor` and the reading-server wait can tell them apart.
 */
type EngineRequest = JobRequest | TranslateRequest;

const jobs: Job[] = [];
/**
 * The job holding the slot, and the one gesture that stops it. Deliberately not
 * a `RunHandle`: an engine child and an in-process download have nothing in
 * common except that both must stop when the row's ✕ is pressed.
 */
let running: { id: string; cancel(): void } | null = null;
let notify: (jobs: Job[]) => void = () => { /* set by main */ };

/** Where the queue publishes. Called on every mutation, with the whole list. */
export function onQueueChanged(listener: (jobs: Job[]) => void): void {
  notify = listener;
}

export function listJobs(): Job[] {
  // A copy: the renderer's mirror must not be able to reach back into the truth.
  return jobs.map((job) => ({
    ...job,
    progress: job.progress ? { ...job.progress } : null,
    envProgress: job.envProgress ? { ...job.envProgress } : null,
  }));
}

function changed(): void {
  notify(listJobs());
}

/**
 * Put a conversion in the queue, HELD.
 *
 * Returns the EXISTING row when one is already waiting or running to write the
 * same file, which is `enqueueEnvInstall`'s rule applied to the thing it
 * actually protects: two rows writing one output is the worst outcome
 * available — the second run overwrites the first while the first is still
 * reading, and the file on disk ends up neither. The OUTPUT is the identity
 * because that is what collides; the same book converted to an EPUB and to a
 * PDF is two different files and therefore two honest rows.
 */
export function enqueue(
  request: JobRequest,
  /**
   * The project's position, RESOLVED BY THE CALLER BEFORE IT CALLED.
   *
   * ── Why it is an argument rather than read in here ──────────────────────────
   *
   * Reading a position means reading a catalogue off the disk, and this function
   * is synchronous on purpose: it returns the row the shelf draws, immediately,
   * so pressing Add cannot leave a moment where nothing has appeared. Making it
   * async to fetch one field would put a file read between a person's click and
   * its own feedback, for a fact the IPC handler is already awaiting things to
   * compose.
   *
   * WHAT MATTERS IS THE MOMENT, AND THE MOMENT IS THE SAME ONE. The handler
   * resolves the position and enqueues in one turn, so this is the position at
   * the press — which is the whole point (`Job.parentStep`). Null for a project
   * with no history yet, and for every caller that has nothing to say.
   */
  parentStep: string | null = null,
): Job {
  /*
   * WHAT THIS JOB PRODUCES, which for a reading is the BANK.
   *
   * `outputPath` is the identity a row is deduped on and the thing Reveal shows,
   * and a reading has no document to point at — so it points at what it actually
   * makes. That is not a placeholder: `readings/<key>.jsonl` is the expensive,
   * irreplaceable product of the run, it is the file a second Add would collide
   * over, and it is the one a person asking "where did that go?" should be shown.
   */
  const outputPath = request.kind === 'read' ? request.readingsPath : request.outputPath;
  const already = pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    kind: request.kind,
    /*
     * ── THE HOLD IS FOR THE EXPENSIVE ONE ONLY ──────────────────────────────
     *
     * A reading is held, for every reason the hold was built for: it is hours of
     * GPU against a file the user picked in a dialog they may have picked wrong,
     * and holding is what makes a BATCH possible — queue four books, look them
     * over, press Start once.
     *
     * A RENDERING RUNS THE MOMENT IT IS ASKED FOR, and making it wait would be
     * the hold applied to the thing it was never about. It is arithmetic over
     * answers already on the disk: seconds, offline, no model, no server, and
     * repeatable as often as somebody likes. There is nothing to commit to and
     * nothing to review — and a person who pressed Generate and then had to find
     * a shelf and press Start would be pressing a second button to confirm a
     * decision they made by pressing the first.
     *
     * It still goes THROUGH the queue and still waits behind whatever is
     * running. That is the machine being busy rather than the person being
     * asked, which is the distinction `held` and `queued` have always drawn.
     */
    state: request.kind === 'read' ? 'held' : 'queued',
    progress: null,
    parentStep,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  if (job.state === 'queued') void pump();
  return job;
}

/**
 * A job already waiting or running to write this file, if there is one.
 *
 * `done`, `failed` and `cancelled` rows are deliberately NOT matched: those are
 * a record of something that already happened, and refusing to re-run a
 * conversion because it failed an hour ago would make the shelf's own history
 * the reason the retry is impossible.
 */
function pendingFor(outputPath: string): Job | undefined {
  const key = path.resolve(outputPath).toLowerCase();
  return jobs.find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && path.resolve(job.outputPath).toLowerCase() === key,
  );
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
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** The full request, kept beside the job — the job itself is the PUBLIC shape. */
const requests = new Map<string, EngineRequest>();
const envRequests = new Map<string, EnvInstallRequest>();

/**
 * Put a translation in the queue.
 *
 * Behind whatever is already running, always. The engine holds an Ollama model
 * for the length of a book and a conversion holds a vision model for the length
 * of another; running both means two models resident on one GPU, which on the
 * hardware this is built for is an out-of-memory failure four hours in.
 */
export function enqueueTranslate(
  request: TranslateRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): Job {
  const already = pendingFor(request.outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    kind: 'translate',
    state: 'held',
    progress: null,
    /*
     * A TRANSLATION IS THE STEP THIS FIELD WAS BUILT FOR. It is the one action a
     * person routinely runs from an earlier row — translate from the reading,
     * click back, translate again into another language — and it is the one that
     * runs for hours, which is exactly the window in which a pointer moves. The
     * user's own scenario in the design document is this job twice.
     */
    parentStep,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  // Held, like every other engine job. See this file's header.
  return job;
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
 */
export function start(): number {
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
 */
export function remove(id: string): void {
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return;
  const job = jobs[index]!;
  if (job.state !== 'held' && job.state !== 'queued') return;
  jobs.splice(index, 1);
  requests.delete(id);
  envRequests.delete(id);
  changed();
  /*
   * Removing can be the thing that empties the queue, and the drain signal lives
   * in pump()'s nothing-to-do branch — which nothing else would visit. Same
   * reasoning as `cancel`'s trailing pump, and the same consequence if it is
   * left out: the reading server stays up with nothing to read for it.
   */
  void pump();
}

/**
 * Put an environment install in the queue.
 *
 * Returns the EXISTING row when one for the same target is already waiting or
 * running: the startup provisioner and a user's Install button can easily arrive
 * at the same conclusion seconds apart, and two rows downloading five gigabytes
 * into one directory is the worst outcome available.
 */
export function enqueueEnvInstall(request: EnvInstallRequest, reason?: string): Job {
  const pending = jobs.find(
    (job) => job.kind === 'env-install'
      && envRequests.get(job.id)?.target === request.target
      && (job.state === 'held' || job.state === 'queued' || job.state === 'running'),
  );
  if (pending) return pending;

  const spec = ENV_SPECS[request.target];
  const job: Job = {
    id: randomUUID(),
    // An install has no document; these two carry what it is and where it goes,
    // so the shelf's title attribute and the reveal button still mean something.
    inputPath: request.target,
    outputPath: destFor(request),
    kind: 'env-install',
    title: spec.label,
    // `queued`, not `held`: an install already had its start gesture. The
    // header says why this is the one exception.
    state: 'queued',
    progress: null,
    envProgress: null,
    message: reason,
    createdAt: Date.now(),
  };
  jobs.push(job);
  envRequests.set(job.id, request);
  changed();
  void pump();
  return job;
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
 */
export function cancel(id: string): void {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.state === 'running' && running?.id === id) {
    running.cancel();
    return; // the close handler settles the state
  }
  // Queued, or running-but-not-yet-spawned: a job waiting for the reading
  // server to come up is `running` with no child of its own, and a cancel that
  // did nothing there would leave the button dead for the minutes that takes.
  if (job.state === 'queued' || job.state === 'running') {
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    changed();
    // A cancel can be the thing that empties the queue, and the drain signal
    // lives in pump()'s nothing-to-do branch — which nothing else would visit.
    void pump();
  }
}

/**
 * Stop whichever environment install is going, from anywhere.
 *
 * Routed through `cancel` rather than reaching into the installer, because the
 * queue is what decides a row's final STATE: an abort that bypassed it settled
 * the install as `failed` with "Cancelled." as its error — technically true, and
 * a red exclamation mark in the shelf for something the user themselves asked to
 * stop.
 */
export function cancelEnvInstalls(): void {
  for (const job of [...jobs]) {
    if (job.kind === 'env-install' && (job.state === 'running' || job.state === 'queued')) {
      cancel(job.id);
    }
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
 */
export function clearFinished(): void {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job && job.state !== 'held' && job.state !== 'queued' && job.state !== 'running') {
      requests.delete(job.id);
      envRequests.delete(job.id);
      jobs.splice(i, 1);
    }
  }
  changed();
}

/** Quit, or a window closing on us: nothing is left holding a GPU. */
export function shutdown(): void {
  running?.cancel();
  running = null;
}

/**
 * The command line, assembled in ONE place.
 *
 * `--readings` is passed on EVERY job — electron/workspace.ts names the bank,
 * and there is no switch that turns it off. It is what makes an interrupted
 * 300-page run resumable, and foundry decides for itself whether a bank beside a
 * completion marker is a resume or a re-read (README §Reading the pages
 * somewhere else, and only once). This app does not second-guess it.
 *
 * No `--vlm-endpoint`. The settings screen owns which backend reads the pages,
 * the engine reads that same settings.json for itself, and a per-job override
 * here was a second opinion about a decision that has one owner.
 */
function argsFor(request: EngineRequest): string[] {
  if (request.kind === 'translate') {
    /*
     * A translation shares nothing with a conversion's command line but the
     * program name. No `--format` (the output is an EPUB by definition), and
     * `--ollama` IS passed — unlike the reading backend, which the settings
     * screen owns and which the engine reads for itself. Ollama has no settings
     * screen here because it is not a server this app manages.
     *
     * `--bank` IS PASSED ON EVERY RUN, and is the exact counterpart of
     * `--readings` on a conversion: both are hours of GPU held as answers. It
     * stopped being optional the day a 456-block book was killed at block 152
     * and had written nothing at all — the engine used to hold every answer in
     * memory and write the EPUB at the end. There is no version of "translate
     * the four hundred blocks that already succeeded again" that anybody wants,
     * so there is no checkbox for it either.
     */
    const args = [
      'translate',
      /*
       * MAY NOT BE THE PATH THE REQUEST WAS STORED WITH. A re-translation into a
       * language the document already is reads the copy the rotation moved aside
       * a moment ago, and `pump()` hands this function a spawn-time copy of the
       * request with that archived path in it. Read the note above the rotation
       * there; this line is deliberately unaware of which of the two it has.
       */
      '--epub', request.inputPath,
      '--out', request.outputPath,
      '--to', request.to,
      '--model', request.model,
      '--ollama', request.ollama,
      '--bank', request.bankPath,
    ];
    if (request.from && request.from.trim().length > 0) args.push('--from', request.from.trim());
    if (request.instructions && request.instructions.trim().length > 0) {
      args.push('--instructions', request.instructions.trim());
    }
    return args;
  }
  /*
   * ── READING THE PAGES ────────────────────────────────────────────────────
   *
   * `foundry vlm-read --pdf X --readings Y`. It fills the bank, drops the
   * completion marker beside it, and writes no document at all.
   *
   * NO `--out` AND NO `--format`, which is the whole of the split on the command
   * line: this run has no opinion about what the book will eventually be, and it
   * cannot be given one. The person who ordered it may generate an EPUB tonight
   * and plain text next week, and neither of those decisions is a fact about the
   * reading — so neither can be asked for while it is being configured.
   */
  if (request.kind === 'read') {
    const args = ['vlm-read', '--pdf', request.inputPath, '--readings', request.readingsPath];
    if (request.skipPages && request.skipPages.trim().length > 0) {
      args.push('--skip-pages', request.skipPages.trim());
    }
    if (request.language && request.language.trim().length > 0) {
      args.push('--language', request.language.trim());
    }
    return args;
  }

  /*
   * ── RENDERING THE BOOK ───────────────────────────────────────────────────
   *
   * `--reuse-readings` IS THE FLAG THAT MAKES THIS FREE, and it is passed on
   * every generate without a switch anywhere that could turn it off. The bank is
   * complete — nothing reaches this branch until a reading has landed — and
   * without the flag the engine would treat a completed bank beside a marker as
   * a book to read AGAIN, which is three hours of GPU in answer to somebody
   * pressing a button labelled with a file format.
   */
  const args = [
    'vlm-convert',
    '--pdf', request.inputPath,
    '--out', request.outputPath,
    '--readings', request.readingsPath,
    '--reuse-readings',
  ];
  /*
   * THE CURATION, when there is one — and the existence test is the whole of the
   * condition rather than a checkbox anywhere.
   *
   * A person's corrections about the blocks are not an option of a run: a book
   * whose running heads have been struck has had them struck, and a conversion
   * that quietly rendered the uncorrected version would be the app throwing away
   * work it is still storing. So the flag is passed whenever the file is there.
   *
   * TESTED HERE, AS THE ENGINE STARTS, and not when the job was planned. A queued
   * batch waits hours, and the hours are exactly when somebody sits with the
   * block editor open — a plan-time test would render the book as it was before
   * the afternoon's work. `existsSync` because this function is the command line
   * and one stat on the way to spawning a process that will run for an hour is
   * not a cost worth making asynchronous.
   *
   * ABSENT IS SILENCE, never the flag with a path behind it: the engine refuses
   * an `--overlay` it cannot open, by name, which would turn "nobody has curated
   * this book" into a failed conversion.
   */
  if (request.overlayPath !== undefined && existsSync(request.overlayPath)) {
    args.push('--overlay', request.overlayPath);
  }
  // Passed only when it is not the default, so an EPUB job's command line is the
  // one it has always been and a diff of two runs shows what actually differed.
  // The extension `planConversion` chose already agrees with it; the engine
  // refuses the pair outright if it ever stops agreeing.
  if (request.kind !== 'epub') args.push('--format', request.kind);
  /*
   * NOTHING ELSE. `--skip-pages` and `--language` used to be here and are gone
   * from this branch: both are statements about READING the book, they were
   * answered when the pages were read, and a rendering that could be handed a
   * different page-skip from the reading it renders would be a rendering of a
   * book nobody read. `--strip-note-markers` went with them — it is BookForge's
   * narration flag and this app has never exposed it (see the OCR dialog).
   */
  return args;
}

/**
 * The endpoint this job will actually read through, or null when the run does
 * not go through one at all.
 *
 * The settings file's, and ONLY in `endpoint` mode. Under `auto` the engine
 * picks its own tier and may well choose `wsl-vllm`, which it serves for
 * itself — starting a server here because the file happens to hold a URL would
 * spend twenty gigabytes on a backend the run was never going to use.
 */
function endpointFor(): string | null {
  const settings = readSettings();
  if (settings.backend.mode !== 'endpoint') return null;
  return settings.backend.endpointUrl?.trim() || null;
}

/**
 * True from the moment pump() claims a job until its engine child is recorded
 * in `running`. The server wait between those two points is an await — the one
 * window in this file where a second pump() could see `running === null`, find
 * the NEXT queued job, and break the serial invariant with two engines on one
 * GPU. `running` guards the child's lifetime; this guards the gap before it.
 */
let starting = false;

async function pump(): Promise<void> {
  if (running !== null || starting) return;
  // `queued` only, which is the whole of the hold: a `held` job is invisible
  // here until `start()` changes its state, so the gate is the data rather than
  // a flag every path through this function would have to remember to consult.
  const next = jobs.find((job) => job.state === 'queued');
  if (!next) {
    // The queue just drained: nothing running, nothing starting, nothing
    // waiting. The reading server's lifetime follows the queue's
    // (electron/vllm-server.ts) — stopped now by default, or after the
    // keep-warm window the user set. Every job's end funnels through here, so
    // this is the one place drain can be declared.
    noteQueueIdle(readAppSettings().keepServerWarmMinutes);
    return;
  }

  if (next.kind === 'env-install') {
    await runEnvInstall(next);
    return;
  }

  const request = requests.get(next.id);
  if (!request) {
    next.state = 'failed';
    next.error = 'The job lost its configuration before it started.';
    changed();
    void pump();
    return;
  }

  starting = true;
  next.state = 'running';
  next.startedAt = Date.now();
  next.message = `Starting ${path.basename(next.inputPath)}…`;
  changed();

  // Whatever idle countdown was armed, a conversion is starting — and not only
  // an endpoint-mode one: under `auto` the ENGINE probes port 8000 for itself
  // and will happily read through a still-warm server this app owns, so a
  // timer allowed to keep ticking here could pull the backend out from under a
  // running book.
  noteQueueBusy();

  // The reading server, before the engine that will post pages to it. A remote
  // endpoint is used exactly as given — only the local one is ours to start.
  //
  // A TRANSLATION NEVER WAITS FOR IT. Its model is Ollama, which this app does
  // not start, and standing up twenty gigabytes of vLLM so that a job which
  // will never send it a page can begin is a five-minute wait that buys
  // nothing — and puts two models on one GPU if a conversion follows.
  const endpoint = next.kind === 'translate' ? null : endpointFor();
  if (endpoint !== null && isLocalVllmEndpoint(endpoint)) {
    next.message = 'Starting the reading server…';
    changed();
    try {
      await ensureServer();
    } catch (err) {
      // The server's own log tail, whole. A conversion that failed because vLLM
      // ran out of VRAM must say so here, not "the engine exited 1".
      next.state = 'failed';
      next.error = err instanceof Error ? err.message : String(err);
      next.finishedAt = Date.now();
      changed();
      starting = false;
      void pump();
      return;
    }
    // Cancelled while the server was coming up — see `cancel`. Re-read rather
    // than test `next.state`, which the compiler still believes is 'running'.
    if (jobs.find((job) => job.id === next.id)?.state === 'cancelled') {
      starting = false;
      void pump();
      return;
    }
  }

  /*
   * ── THE PREVIOUS OUTPUT MOVES ASIDE **NOW**, and not a moment earlier ──────
   *
   * `generated/` is never overwritten: a second rendering of a book moves the
   * first into `generated/archived-<stamp>/` rather than replacing it. That
   * rotation used to happen when the job was PLANNED — before it was enqueued,
   * let alone run — and the new file was recorded only if the run succeeded. So
   * a rendering that failed, or was cancelled, or was removed from the queue
   * without ever starting, left the previous output in an archive folder with
   * the catalogue's chain pointing at it and nothing live at all. The row went
   * on listing and opening, and what it opened was silently the run before last,
   * forever.
   *
   * Here, the engine is the next thing that happens. The window between this
   * rename and the first byte written is one spawn — and even that window is
   * covered, because a settle that is not a success puts the rotation back
   * (`restoreRotation`), so the invariant is flat: A RUN THAT PRODUCES NOTHING
   * LEAVES THE CATALOGUE EXACTLY AS IT WAS.
   *
   * A TRANSLATION ROTATES HERE TOO, and it is the same sentence rather than a
   * second mechanism. It used to rotate in `planTranslation`, which is where
   * conversions rotated before this block existed — so the invariant above was
   * true of every job in this app except the one that runs for four hours from a
   * row a person routinely queues, looks at, and removes. A held translation
   * removed from the shelf had already moved the previous edition into an archive
   * folder and rewritten the chain to point there, for a run that never spawned.
   * There is no restore path from a plan, because a plan has nowhere to put one:
   * `remove` deletes the request and the row, and nothing anywhere remembered
   * that a file had been moved for it. Rotating HERE gives it the settle paths
   * below for free, and gives `remove` nothing to undo because nothing has
   * happened yet.
   *
   * A READING NEVER ROTATES: its `outputPath` is the BANK it fills, which lives
   * in `readings/` and is not a generated document at all. Rotating on its
   * basename would move a file out of a directory this block has no business in.
   * The bank's own replace-on-success rule is the engine's (BANK-LIFECYCLE §2).
   *
   * A refusal here fails the job with its own sentence. Both plans ask the same
   * question while the dialog is still on screen, so this is reached only when a
   * tab was opened on the previous output in between — which is the case only the
   * second answer can authorize.
   */
  let rotation: Rotation | null = null;
  let rotatedIn: string | null = null;
  if (request.kind !== 'read') {
    const projectDir = projectDirOf(request.outputPath);
    if (projectDir !== null) {
      rotatedIn = projectDir;
      try {
        rotation = await rotateGenerated(projectDir, path.basename(request.outputPath));
      } catch (err) {
        next.state = 'failed';
        next.error = err instanceof Error ? err.message : String(err);
        next.finishedAt = Date.now();
        changed();
        starting = false;
        void pump();
        return;
      }
    }
  }

  /*
   * ── AND A RE-TRANSLATION READS THE COPY THAT WAS JUST MOVED ───────────────
   *
   * Translating the English edition into English again names one path twice: the
   * output is composed from the project's stem and the language, so asking for a
   * language a document already is lands on that document. Nothing refuses that —
   * the user asked for "do that again", which is sensible, and a refusal would
   * have been a sentence about this app's own filing (`planTranslation`).
   *
   * The rotation is what makes it work: the previous edition is moved aside a few
   * lines above, so by the time the engine starts the path the request names is
   * empty and the bytes the run needs are in `generated/archived-<stamp>/`. The
   * substitution therefore CANNOT be made at plan time any more — the archived
   * path does not exist until the rotation does — so it is made here, after the
   * rotation and before `argsFor`, which is the last moment anything can still
   * change what the command line says.
   *
   * THE STORED REQUEST IS LEFT ALONE, and a copy is spawned instead. The request
   * is what the shelf's row and every admission gate are about — `inputPath` is
   * the path main admitted and `queue:enqueue-translate` re-checked, and a path
   * inside an archive folder was never "opened" by anybody. A retry, a restore, or
   * anything else that reads the request back must see the file a person could
   * name; only the child process sees the archived one, and only for the length of
   * this spawn.
   */
  const spawned: EngineRequest = rotation !== null
    && request.kind === 'translate'
    && samePath(request.inputPath, request.outputPath)
    ? { ...request, inputPath: rotation.movedTo }
    : request;

  const args = argsFor(spawned);
  /*
   * The command, once, before it runs.
   *
   * A failure that names a flag is only useful beside the flags it was given —
   * "--out and --format contradict each other" means nothing without the pair,
   * and the paths this app composes are exactly the ones nobody typed and
   * therefore nobody can check. One line, at the start, in the terminal that is
   * already open.
   */
  console.log(`[job] ${next.kind} ${args.join(' ')}`);
  const handle = runEngine(args, (line) => {
    next.message = line;
    const progress = parseProgressLine(line);
    /*
     * A count clears the note; anything else becomes it. So `note` reads as
     * "what the engine has said SINCE the last count", which is empty on a run
     * that is simply progressing and full of exactly the right sentence on one
     * that is retrying, falling back, or naming a block it could not do.
     */
    next.note = progress ? null : line;
    if (progress) {
      // The rasterising pass finishes the instant reading starts: foundry draws
      // the whole book before it posts the first page, but a book with pages
      // skipped never reaches its own page count, so the render bar would stop
      // short of work it had actually finished.
      if (progress.phase === 'read' && next.progress?.phase === 'render') {
        next.progress = { ...next.progress, page: next.progress.total };
      }
      next.progress = progress;
    }
    changed();
  });
  running = { id: next.id, cancel: () => handle.cancel() };
  starting = false;

  const result = await handle.done;
  running = null;
  next.finishedAt = Date.now();

  if (result.code === 0) {
    next.state = 'done';
    /*
     * A READING LANDED, which is the moment the whole front door turns on.
     *
     * `recordReading` stamps the catalogue: when it finished, how many pages the
     * bank holds, and — through `generationForLanding`, the landing half of the
     * rule in shared/ledger.ts — the reading GENERATION every overlay and its
     * undo ledger are bound to.
     * That is why the mint belongs here rather than at the first correction: this
     * is the only moment anything in this app can honestly say a bank is a
     * different bank from the one that was there before.
     *
     * It also puts the light out on Home. A project with a scan and no reading
     * shows OCR as its waiting next step; from this line on, that project has
     * been read.
     */
    if (request.kind === 'read') {
      /*
       * NO CAPTURED PARENT GOES WITH IT, AND THAT IS NOT AN OVERSIGHT.
       *
       * `next.parentStep` is where the user was standing when they pressed Add,
       * and it is what a translation is filed against. A READING IS THE ONE
       * ACTION THAT IS NOT MADE FROM A STEP: it reads the pixels in `archive/`,
       * which `planReading` resolves for itself precisely because the document
       * the person was looking at may be a real-text reprint with none of the ink
       * in it. So its parent is the project's import, settled by what it read
       * rather than by where anybody was standing — see `originOf` in
       * shared/ledger.ts for what parenting it at the position would cost.
       */
      /*
       * WHAT IT ASKED FOR GOES WITH IT, THOUGH — which is the other half of the
       * same rule and the opposite conclusion.
       *
       * The parent is settled by what a reading READS; the identity is settled by
       * what it was ASKED. `--skip-pages` and `--language` are the whole of what
       * the OCR dialog lets somebody choose (`ReadRequest`), and they decide
       * whether the next reading of this book replaces this step or branches
       * beside it. Nothing on disk can answer that afterwards: a bank does not
       * record which pages it was told to leave out. So the job hands them over,
       * exactly as a translation hands over its `--to` rather than leaving the
       * language legible only in a filename.
       */
      /*
       * AND THE STEP THE BANK IS NAMED AFTER, which is the third thing that has
       * to survive the wait.
       *
       * A branching re-read writes `readings/<key>.<id8>.jsonl`, and that `id8` is
       * the front of the step's uuid — minted at the plan, before the row even
       * appeared in the shelf, because the engine is handed one path and fills it
       * for three hours. Minting a fresh id here would leave the bank named after a
       * step nobody created. It is spent only if this lands as an append; a replace
       * swaps into the step that is already there and throws it away.
       */
      await recordReading(
        next.outputPath,
        {
          ...(request.skipPages !== undefined ? { skipPages: request.skipPages } : {}),
          ...(request.language !== undefined ? { language: request.language } : {}),
        },
        request.stepId,
      );
      next.message = `Read ${path.basename(next.inputPath)} — the answers are banked.`;
      changed();
      void pump();
      return;
    }
    /*
     * The catalogue learns about the origin HERE, when it exists.
     *
     * Not at plan time, which is only an intention: a run that dies at page 200
     * would leave `project.json` listing a book Home would then offer and
     * nothing could open. `recordGenerated` never throws — a row it could not
     * write is a named console line, because losing a catalogue entry is not a
     * reason to report three hours of GPU as a failure.
     *
     * The REQUEST's kind, not the job row's: `JobKind` also admits `env-install`,
     * which never reaches this branch but which the compiler cannot know that
     * about, and a cast here would be a promise made to the type system rather
     * than a fact. The request is the narrower shape and it is the same decision.
     */
    const live = await recordGenerated(
      next.outputPath,
      request.kind === 'translate' ? 'translation' : generatedRoleFor(request.kind),
      {
        parentStep: next.parentStep ?? null,
        /*
         * THE LANGUAGE, HANDED OVER RATHER THAN LEFT IN THE FILENAME.
         *
         * The output is called `<book> (en).epub` and the tag is legible in those
         * parentheses, which is exactly why it is passed here instead: reading a
         * fact about a book out of the characters in its name is what this
         * codebase's oldest house rule forbids, and `migrateLedger` would rather
         * leave an old translation unlabelled than do it. This job asked for a
         * language; it says which.
         *
         * AND THE BANK IT FILLED, AND THE STEP BOTH FILES ARE NAMED AFTER, for the
         * same reason twice over. The bank is where the per-block answers went
         * (`--bank`, a few lines up in `argsFor`) and nothing on disk relates it to
         * the EPUB afterwards — a rendering from this row, and every re-translation
         * of it, has to be told. The step id was minted at the plan and written
         * into both filenames since (`bankForTranslation`), so a landing that
         * minted its own would leave them named after a row nobody created; it is
         * spent only if this lands as an append.
         */
        ...(request.kind === 'translate'
          ? {
            language: request.to,
            bank: request.bankPath,
            ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
          }
          : {}),
      },
    );
    /*
     * WHERE THE FINISHED ROW POINTS, when the catalogue made a live copy of what
     * the engine wrote. Everything downstream reads `outputPath`: the tab that
     * opens itself when the run lands, and the shelf's Reveal — and both of them
     * want the file the user is meant to have, not the bookkeeping original.
     *
     * Nothing promotes a conversion to the live PDF today (`recordGenerated`),
     * so this is inert and kept rather than deleted: the branch costs a
     * comparison, and the alternative is a queue that silently points at the
     * wrong file the first time something is promoted again.
     */
    if (live !== null) next.outputPath = live;
    // Said after the row settles on its final path, so the line names the file
    // the Reveal button will actually show.
    next.message = `Wrote ${path.basename(next.outputPath)}`;
  } else if (result.code === -1) {
    next.state = 'cancelled';
    next.message = 'Cancelled.';
    // Nothing was written, so nothing moved: the previous output comes home and
    // the chain points back at it. See `restoreRotation` for what "nothing" has
    // to include — the file, the working tree, and both of their catalogue rows.
    if (rotation !== null && rotatedIn !== null) await restoreRotation(rotatedIn, rotation);
  } else {
    next.state = 'failed';
    if (rotation !== null && rotatedIn !== null) await restoreRotation(rotatedIn, rotation);
    // foundry's own stderr is the message a user needs — it names the missing
    // Python, the model it could not load, the page it choked on. Never
    // paraphrased, and never replaced with an exit code.
    next.error = result.stderr.trim() || `The engine exited ${result.code} with nothing to say.`;
    /*
     * AND IT GOES TO THE CONSOLE, WHOLE.
     *
     * Until now a failure existed in exactly one place a person could reach: a
     * tooltip on one row of the shelf. So a job that failed while the window
     * was reloading, or whose row was cleared, took its only account of itself
     * with it — which is precisely what happened twice tonight, and the second
     * time there was nothing left to read at all.
     *
     * The terminal running the app is where somebody is already looking when
     * something goes wrong, it survives every reload of the window, and it can
     * be scrolled back and copied. The full stderr rather than a summary: the
     * lines above the failure are usually the context that explains it, and
     * this is a diagnostic rather than a notification.
     */
    console.error(
      `\n[job] ${next.kind} FAILED — exit ${result.code} — ${path.basename(next.inputPath)}\n`
      + `${next.error}\n`,
    );
  }
  changed();
  void pump();
}

/**
 * The env-install branch, claiming the same slot a conversion would.
 *
 * Every way this ends — not published, no distro chosen, a bad sha256, a
 * cancel — comes back as an `EnvInstallResult` with a sentence, because
 * `installEnv` never throws. The row's failure text is that sentence verbatim:
 * "download this later" and "your download was corrupt" are different problems
 * with different fixes and a shared exit code would hide both.
 */
async function runEnvInstall(job: Job): Promise<void> {
  const request = envRequests.get(job.id);
  if (!request) {
    job.state = 'failed';
    job.error = 'The install lost its configuration before it started.';
    changed();
    void pump();
    return;
  }

  starting = true;
  job.state = 'running';
  job.startedAt = Date.now();
  job.message = `Installing ${job.title ?? request.target}…`;
  changed();

  let cancelled = false;
  const handle = installEnv(request, (progress) => {
    job.envProgress = progress;
    job.message = progress.detail;
    changed();
  });
  running = {
    id: job.id,
    cancel: () => { cancelled = true; handle.cancel(); },
  };
  starting = false;

  const result = await handle.done;
  running = null;
  job.finishedAt = Date.now();

  if (result.ok) {
    job.state = 'done';
    job.message = result.detail;
  } else if (cancelled) {
    job.state = 'cancelled';
    job.message = 'Cancelled.';
  } else {
    job.state = 'failed';
    job.error = result.detail;
  }
  changed();
  void pump();
}
