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
 * ── One job in here starts another, and only this one ────────────────────────
 *
 * A READING THAT LANDS CASTS THE BOOK (`castFlowingBook`). Everything else in this
 * queue arrives from a person pressing something; this arrives from the previous
 * job finishing, because the product of a reading is a bank and a bank is not a
 * thing anybody can look at. The user: "from that bank, we create an html page of
 * the document - a proto epub. that's the step that appears automatically the
 * moment i OCR something."
 *
 * IT IS THE ONLY ONE, and that has to stay true: a conversion landing that
 * enqueued anything would be a cast casting a cast, forever. The guard is
 * structural rather than a flag — the `read` arm of the settle is the only caller
 * and it returns before any conversion landing runs — and `enqueue`'s dedup on the
 * output path is the second line, so two readings landing near each other join one
 * cast rather than racing two.
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
import { copyFileSync, existsSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readAppSettings } from './app-settings';
import { parseProgressLine, runEngine } from './engine';
import { ENV_SPECS } from './env-catalog';
import { destFor, installEnv } from './env-install';
import {
  generatedRoleFor,
  positionStepId,
  projectDirOf,
  recordFinal,
  recordGenerated,
  recordReading,
  restoreFinalRotation,
  restoreRotation,
  rotateFinal,
  rotateGenerated,
  type FinalRotation,
  type Rotation,
} from './projects';
import { readSettings } from './settings';
import { ensureServer, isLocalVllmEndpoint, noteQueueBusy, noteQueueIdle } from './vllm-server';
import { planConversion } from './workspace';
import { translationStage } from '../shared/pipeline';
import type {
  EnvInstallRequest, GenerateRequest, Job, JobRequest, TranslateRequest,
} from '../shared/types';

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
     *
     * A TWO-STAGE GENERATE IS NOT A RENDERING — it is the exception's own test
     * applied honestly. The paragraph above holds because a replay costs
     * nothing, and a job whose second stage runs the translator is not that
     * job: a seeded bank makes it cheap, but text edited since the translation
     * is re-asked of a model, and a cold Ollama makes it a translation run in
     * everything but the button that started it. So it is held, exactly as
     * `enqueueTranslate` holds every translate — one press to ask, one press
     * to spend.
     */
    state: request.kind === 'read' || request.thenTranslate !== undefined ? 'held' : 'queued',
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
   * ── AN EXPORT ASKS FOR THE EDITION, AND A GENERATE NEVER DOES ─────────────
   *
   * `generated/` is the workbench and `final/` is where a finished book is filed
   * (docs/WORKBENCH.md §8), and the two want different documents out of the same
   * bank. The cast keeps its marks because the person curating has to see what
   * they struck: a struck footnote is still in the book wearing `data-bf-cut`,
   * and every element still carries the attributes select mode addresses it by.
   * The edition has none of that — the struck note is not written, its reference
   * numbers keep the digit the page printed and lose their link, and the editing
   * attributes are not emitted at all.
   *
   * ONE FLAG, DECIDED OFF THE ONE FIELD THAT SAYS WHERE THE FILE IS GOING —
   * `export`, the same field `pump()` resolves into `exporting` for the rotation
   * and the landing, asked here of the REQUEST THIS FUNCTION WAS HANDED rather
   * than of the one the shelf is about. The two are the same object for a
   * one-stage job and deliberately different for a piped one.
   *
   * A CAST'S COMMAND LINE IS UNTOUCHED: no `export`, no flag, and the engine's
   * default is the book it has always written.
   *
   * A TRANSLATE-DESCENDED EXPORT MUST NOT GET IT ON EITHER OF ITS STAGES, and
   * gets it on neither. The translate stage is a `TranslateRequest` and returned
   * above; the vlm stage feeding it is handed here with `export` deliberately
   * taken off (`withoutExport`, in `pump()`'s stage list), because `translate`
   * reads the very stamps this flag withholds (FINAL_NEEDS_STAMPS,
   * src/translate/book.ts) and would refuse an edition by name. That job's tidy
   * runs as a third stage, after the translation, over the finished book.
   */
  if (request.export === true) args.push('--final');
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
 * The same Generate, with the fact that it is an export taken off it.
 *
 * ONE CALLER AND ONE REASON: the first stage of a translate-descended export,
 * whose product is not the export. `export` is read in exactly two places — the
 * settle, which files the finished book in the tray, and `argsFor`, which asks
 * the engine for the EDITION — and this stage must be invisible to the second
 * without being invisible to the first. The stage's own copy loses the flag; the
 * stored request, which is what the settle reads, never sees this function.
 *
 * A DELETE RATHER THAN `export: undefined`, so the object handed to `argsFor` is
 * shaped exactly like the Generate of a book nobody is exporting. The two behave
 * identically today, and one of them stops being a guess the moment anything
 * starts asking whether a key is present.
 */
function withoutExport(request: GenerateRequest): GenerateRequest {
  const { export: _terminal, ...rest } = request;
  return rest;
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

  /*
   * ── THE JOB THAT IS TWO RUNS, DECIDED ONCE AND HELD HERE ──────────────────
   *
   * A Generate from a position standing under a translation is `vlm-convert`
   * into a temporary EPUB and then `translate` out of it into the row's own
   * file (docs/TRANSLATION-STEPS.md §3). ONE QUEUE ROW, ONE PROGRESS BAR, ONE
   * SETTLE — because it is one thing the user asked for, and a shelf that grew
   * a second row halfway through would be this app's bookkeeping surfacing as
   * an event. The two stages share the rotation below, the cancel, and the
   * landing.
   *
   * `planConversion` decided all of it — which language, which bank, which row
   * it lands in — for `overlayPath`'s reason, which is the rule for everything
   * about a Generate: it is the state of the book the user chose when they
   * pressed the button, and re-resolving any of it at spawn would let a pointer
   * move made while the job waited silently produce something else.
   */
  const piped = request.kind !== 'read'
    && request.kind !== 'translate'
    && request.thenTranslate !== undefined
    ? { request, then: request.thenTranslate }
    : null;

  /*
   * ── THE JOB THAT LANDS IN THE TRAY INSTEAD OF THE WORKSHOP ────────────────
   *
   * Everything below this line — the server wait, the intermediate, the two
   * stages, the cancel, the progress — is the same for an export as for any other
   * rendering, because an export IS a rendering (`planExport`). What it changes is
   * the two ends: which file the rotation moves aside, and what the settle records.
   *
   * DECIDED ONCE, HERE, for `piped`'s reason: the narrowing that reaches
   * `request.export` is only available on a `GenerateRequest`, and three separate
   * places re-deriving it is three places for one of them to go on treating an
   * export as a generate — which would rotate the project's cast book aside to
   * make room for a file that is not going anywhere near it.
   */
  const exporting = request.kind !== 'read'
    && request.kind !== 'translate'
    && request.export === true;

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

  /*
   * The reading server, before the engine that will post pages to it. A remote
   * endpoint is used exactly as given — only the local one is ours to start.
   *
   * ONLY A READING WAITS FOR IT, and that is the whole rule. `vlm-read` is the
   * one job in this app that puts a page in front of a model; every other job
   * either uses a model this app does not own or uses none at all.
   *
   * A GENERATE READS NOTHING. `argsFor` passes `--reuse-readings` on every
   * conversion, without a switch anywhere that could turn it off, so the engine
   * replays the completed bank: it loads no model, opens no socket, and leaves
   * the bank byte for byte as it found it (`readings.ts`, `openReadingsBank`).
   * A translation's model is Ollama's, which this app does not start. A
   * two-stage Generate is those two facts in sequence.
   *
   * This used to be worded as a list of exceptions — translate, and the piped
   * two-stage job — which meant a plain Generate still stood up twenty
   * gigabytes of vLLM and waited five minutes for a server it would never
   * address. Pressing a button labelled with a file format lit up the GPU, and
   * the shelf said "Starting the reading server…" over a job that is
   * arithmetic; the user reasonably read that as the model being run again.
   * The exceptions were the majority, so the rule is stated the other way
   * round: the job that reads waits, and nothing else does.
   */
  const endpoint = next.kind === 'read' ? endpointFor() : null;
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
   * ── THE INTERMEDIATE GOES IN THE OS TEMP DIRECTORY, NEVER IN `generated/` ──
   *
   * The first stage of a two-stage Generate writes a whole EPUB that nobody
   * asked for: it exists so the second stage has something to read, and it is
   * deleted at the settle whichever way the job goes. DEBRIS DOES NOT GO WHERE
   * PRODUCTS LIVE. `generated/` is the layer this app treats as an origin —
   * rotated aside rather than overwritten, catalogued, offered on Home, unpacked
   * into working trees — and dropping a nameless half-book into it would put a
   * file the user never ordered into the one directory they are shown.
   *
   * NAMED FOR THE JOB rather than for the book, because the book already has a
   * name and this is not it: two jobs about one book must not collide in a
   * directory that belongs to every program on the machine, and a person who
   * finds one of these while a run is going should see something that is
   * obviously a run in progress. Under a `foundry` subdirectory for the same
   * reason `env-downloader.ts` puts its downloads in one — a temp folder is
   * shared, and files loose in it belong to nobody.
   *
   * MADE BEFORE THE ROTATION, deliberately: a temp directory this app cannot
   * create is a job that fails having touched nothing at all, and there is no
   * rotation to put back.
   */
  const intermediate = piped === null
    ? null
    : path.join(os.tmpdir(), 'foundry', `${next.id}.epub`);
  /*
   * ── AND A TRANSLATED **EXPORT** NEEDS A SECOND ONE ────────────────────────
   *
   * A translate-descended export is three runs, not two, and the third is the
   * tidy: `epub-final` turning the translated book into the edition that lands
   * in `final/`. It has to be a separate stage AFTER the translation rather than
   * `--final` on the first, and the reason is a hard dependency rather than a
   * preference — `translate` reads the stamps an edition withholds
   * (FINAL_NEEDS_STAMPS, src/translate/book.ts), so a first stage that wrote the
   * edition would hand the translator a book it refuses by name.
   *
   * So the translation aims here instead of at the row's own file, and the tidy
   * lands the destination. Named for the job beside the first intermediate, for
   * the same reasons — and given a name of its OWN rather than being written
   * over the first, because `epub-final` refuses an `--out` equal to its
   * `--epub` and a tidy in place is exactly that refusal.
   *
   * NULL FOR EVERY OTHER JOB, including a translated Generate: `generated/` is
   * the workbench, so what lands there is the cast with its marks intact and
   * there is nothing to tidy.
   */
  const untidied = piped === null || !exporting
    ? null
    : path.join(os.tmpdir(), 'foundry', `${next.id}.untidied.epub`);
  if (intermediate !== null) {
    try {
      await fsp.mkdir(path.dirname(intermediate), { recursive: true });
    } catch (err) {
      next.state = 'failed';
      next.error = `The temporary folder for this job could not be made: ${(err as Error).message}`;
      next.finishedAt = Date.now();
      changed();
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
   *
   * AN EXPORT ROTATES ITS OWN FOLDER, and getting this wrong would be the worst
   * outcome in the file. `rotateGenerated` takes a BASENAME and looks for it in
   * `generated/` — and an export of the book is called `<stem>.epub`, which is
   * exactly the name the project's cast book already has one folder over. Handed
   * to the wrong rotation, asking for a copy of your book would file the book
   * itself into an archive folder and unpack nothing in its place. So the layer
   * decides the rotation, off the one flag that was resolved above, and `final/`
   * gets its own pair (`rotateFinal` / `restoreFinalRotation`) rather than a
   * parameter on this one — the two put back different things.
   */
  let rotation: Rotation | null = null;
  let filedRotation: FinalRotation | null = null;
  let rotatedIn: string | null = null;
  if (request.kind !== 'read') {
    const projectDir = projectDirOf(request.outputPath);
    if (projectDir !== null) {
      rotatedIn = projectDir;
      try {
        if (exporting) {
          filedRotation = await rotateFinal(projectDir, path.basename(request.outputPath));
        } else {
          rotation = await rotateGenerated(projectDir, path.basename(request.outputPath));
        }
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

  /*
   * ── THE RUNS THIS JOB IS, IN ORDER ────────────────────────────────────────
   *
   * One for everything this app has ever queued, and two for a Generate standing
   * under a translation: `vlm-convert` into the temp EPUB, then `translate` out
   * of it into the file the row is about.
   *
   * THE SECOND STAGE IS A `TranslateRequest` AND GOES THROUGH `argsFor`, which is
   * the whole reason it is composed rather than spelled. The translate command
   * line has seven flags that were each learned once and expensively — `--bank`
   * most of all — and a second place assembling one is a second place to forget
   * one. `translationStage` is pure and lives in shared/, so the composition is
   * covered by a test rather than by this file being read carefully.
   */
  const stages: EngineRequest[] = piped === null || intermediate === null
    ? [spawned]
    : [
      // Stage one writes to the temp file and is otherwise the Generate that was
      // planned: same pixels, same bank, same overlay, same format. The stored
      // request keeps its own `outputPath`, which is the file the row, the
      // rotation and the landing are all about — see the note above `spawned`,
      // which is the same rule about the same map.
      //
      // AND IT IS NOT AN EXPORT, whatever the job is. `export` is what makes
      // `argsFor` ask the engine for the EDITION, and this stage's product is not
      // a product at all: it is the book the translator reads, and the translator
      // needs the stamps an edition does not write. The flag is dropped for this
      // one spawn and nowhere else — `exporting` above is resolved from the
      // stored request, so the rotation, the landing and the tidy below all still
      // know exactly what this job is.
      { ...withoutExport(piped.request), outputPath: intermediate },
      /*
       * Stage two writes the row's own file — UNLESS a tidy is coming, in which
       * case it writes the second intermediate and `epub-final` writes the file.
       * The translation is the same run either way; all that moves is where it
       * puts the book.
       */
      translationStage(piped.then, intermediate, untidied ?? piped.request.outputPath),
    ];

  /*
   * ── THE THIRD RUN: THE EDITION, MADE FROM WHAT THE TRANSLATOR WROTE ───────
   *
   * `foundry epub-final` over the translated book, into the file the row is
   * about. It is the same tidy `--final` does at assembly, done to a book that
   * already exists, which is the only order that works here (see `untidied`).
   *
   * NOT AN `EngineRequest`, deliberately: the three request shapes are what this
   * app QUEUES, each with a row, a landing and a settle, and this is a step
   * inside one job rather than a job. A fourth shape would have to be threaded
   * through the plans, the shelf and every settle path to be used in one place.
   * The command line is four flags and it is spelled here, beside the intermediate
   * it reads.
   */
  const tidy: string[] | null = untidied === null || piped === null
    ? null
    : ['epub-final', '--epub', untidied, '--out', piped.request.outputPath];

  const watch = (line: string): void => {
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
  };

  /*
   * The command, once, before it runs.
   *
   * A failure that names a flag is only useful beside the flags it was given —
   * "--out and --format contradict each other" means nothing without the pair,
   * and the paths this app composes are exactly the ones nobody typed and
   * therefore nobody can check. One line, at the start, in the terminal that is
   * already open — and one PER STAGE, because two runs under one row is exactly
   * the case where a single line would leave somebody reading the wrong command.
   */
  const args = argsFor(stages[0]!);
  console.log(`[job] ${next.kind} ${args.join(' ')}`);
  let handle = runEngine(args, watch);
  /*
   * THE CANCEL FOLLOWS THE LIVE CHILD, which is the whole of what a two-stage
   * job costs this file. `handle` is reassigned between stages and the closure
   * reads it, so the ✕ kills whichever engine is actually running rather than a
   * child that has already exited — and `running` stays set across the gap
   * between the two, so no second `pump()` can slip a job in beside this one and
   * put two engines on one GPU.
   */
  running = { id: next.id, cancel: () => handle.cancel() };
  starting = false;

  let result = await handle.done;
  for (let at = 1; at < stages.length && result.code === 0; at += 1) {
    /*
     * THE ROW SAYS WHICH STAGE IT IS ON, once, and then the engine's own lines
     * take the message back over — the same arrangement the `Starting …` line
     * has always had. The BAR needs nothing: the engine's progress lines carry a
     * phase, and `translate` counts blocks rather than pages, so the shelf
     * already draws the second stage as the different quantity it is.
     */
    next.message = 'Translating what was just rendered…';
    next.note = null;
    changed();
    /*
     * A BRANCH'S BANK STARTS AS A COPY OF ITS PARENT'S — here, not at plan time,
     * because this is the first moment the job is a commitment rather than a row
     * somebody can still remove (`ThenTranslate.seedBank` says why the debris
     * matters). The bank is question-keyed by the blocks' own text, so the
     * parent's answers are exactly as true here: the stricken blocks are never
     * looked up, and only text edited since the translation is re-asked. An
     * existing bank is never overwritten — a retried job has its own answers in
     * there by now, and they are newer than the seed.
     */
    const stage = stages[at]!;
    if (stage.kind === 'translate' && stage.seedBank !== undefined
      && !existsSync(stage.bankPath) && existsSync(stage.seedBank)) {
      try {
        copyFileSync(stage.seedBank, stage.bankPath);
      } catch (err) {
        console.error(`[job] could not seed ${stage.bankPath} from ${stage.seedBank}:`, err);
      }
    }
    const stageArgs = argsFor(stages[at]!);
    console.log(`[job] ${next.kind} ${stageArgs.join(' ')}`);
    handle = runEngine(stageArgs, watch);
    result = await handle.done;
  }
  /*
   * ── AND THE TIDY, WHICH IS THE LAST THING THAT HAPPENS ────────────────────
   *
   * Only for a translate-descended export, only when everything before it
   * succeeded, and it is what actually writes the file the row is about: every
   * stage before this one wrote into the temp directory. `handle` is reassigned
   * exactly as it is between the other stages, so the ✕ still kills the child
   * that is running and `running` stays set until the last one has exited.
   *
   * A FAILURE HERE FAILS THE JOB, with the engine's own words, because it is the
   * stage that produces the product: a run that translated four hundred blocks
   * and then could not write the edition has not made the thing that was asked
   * for, and reporting it as a success would file a row in the tray pointing at a
   * file that is not there.
   */
  if (tidy !== null && result.code === 0) {
    next.message = 'Finishing the edition…';
    next.note = null;
    changed();
    console.log(`[job] ${next.kind} ${tidy.join(' ')}`);
    handle = runEngine(tidy, watch);
    result = await handle.done;
  }
  running = null;
  next.finishedAt = Date.now();

  /*
   * THE INTERMEDIATES GO NOW, whichever way this ended. A run that failed at
   * block 400 leaves a whole EPUB in the temp directory, and the next one writes
   * a fresh one under its own job id — so keeping it would be hoarding half-books
   * nobody can name against a directory this app does not own.
   *
   * BOTH OF THEM, on one rule rather than two: the untidied translation is the
   * same kind of debris as the untranslated cast, made by the stage in between,
   * and a second copy of this paragraph is a second place to forget one.
   *
   * BEST EFFORT, AND NEVER A THROW. A leftover temp file is a console line; the
   * job it belonged to succeeded or failed on its own merits, and reporting three
   * hours of GPU as a failure because a scratch file would not unlink would be
   * the bookkeeping deciding what happened to the book. `force` so an
   * already-absent file — the ordinary case when the run never got that far — is
   * silence rather than an error.
   */
  for (const scratch of [intermediate, untidied]) {
    if (scratch === null) continue;
    try {
      await fsp.rm(scratch, { force: true });
    } catch (err) {
      console.error(`[job] the intermediate ${scratch} could not be removed: ${(err as Error).message}`);
    }
  }

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
      await ensureCast(next.inputPath);
      void pump();
      return;
    }
    /*
     * ── AN EXPORT IS FILED AND NOTHING ELSE HAPPENS TO IT ─────────────────────
     *
     * `recordGenerated` below does four things to a finished rendering: it puts a
     * step on that type's chain, it lands a ledger step when the run was a
     * translation, it destroys whatever the swap displaced, and it can promote the
     * result to the project's live PDF. Every one of those is about a document
     * OTHER WORK WILL BE MADE FROM, and an export is the one rendering in this app
     * that nothing is ever made from — the user's ruling, verbatim: "it wont go
     * into the working files as a step because it isnt the base for new steps. its
     * a terminal step. so its an export."
     *
     * So the landing is one row in the tray. `recordFinal` never throws and
     * announces the library itself, which is what puts the export under its project
     * in the left nav; the tab opens itself from the shelf exactly as a Generate's
     * does (`OPENS_ITSELF`), because somebody who asked for a book wants to look at
     * it. No documents row, no ledger step, no live-PDF refresh, and no rotation to
     * undo beyond the one `rotateFinal` already made.
     */
    if (exporting) {
      await recordFinal(next.outputPath);
      next.message = `Wrote ${path.basename(next.outputPath)}`;
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
      /*
       * A TWO-STAGE GENERATE PRODUCED A TRANSLATION, and the role says so.
       *
       * What is on disk is an EPUB of this book in another language, made by the
       * same `translate` command a translation job runs — so it is catalogued as
       * one, and it lands a ledger step as one. Filing it as a `cast` because the
       * job's `kind` happens to say `epub` would leave the row that the whole
       * pipeline exists to refresh untouched, and would put a second EPUB in the
       * chain claiming to be the model's reading of the pages.
       */
      request.kind === 'translate' || piped !== null
        ? 'translation'
        : generatedRoleFor(request.kind),
      {
        /*
         * WHICH STEP THIS IS FILED AGAINST, and a two-stage Generate is the one
         * job in this app where that is NOT the position at the press.
         *
         * `Job.parentStep` is where the user was standing, and for a re-render of
         * a translation that is the translation itself — so filing it there would
         * append a translation whose parent is a translation: a second row beside
         * the one they asked to refresh, and a payload nobody wanted. The pipeline
         * settled it at plan time with the same ancestry walk that chose the
         * overlay and the bank (`RenderPipeline.landsUnder`), and the answer is
         * the translation's own parent when you are standing on it and the save
         * itself when you are standing on a save made under it. `reRunTarget` then
         * does the rest: a replace of that row, or a branch beside it.
         */
        parentStep: piped?.then.parent ?? next.parentStep ?? null,
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
        /*
         * AND THE SAME THREE FACTS OFF THE PIPELINE, because the second stage was
         * a translation and left exactly what one leaves. They are the paths the
         * engine was actually handed a moment ago — `--to`, `--bank` and the id
         * both files were named after — so the row records what the run did rather
         * than what something composed for it afterwards.
         */
        ...(piped !== null
          ? {
            language: piped.then.to,
            bank: piped.then.bank,
            ...(piped.then.stepId !== undefined ? { stepId: piped.then.stepId } : {}),
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
    // The tray obeys the same invariant through its own receipt: a cancelled
    // export leaves the document somebody filed earlier exactly where it was.
    await putBack(rotatedIn, rotation, filedRotation);
  } else {
    next.state = 'failed';
    await putBack(rotatedIn, rotation, filedRotation);
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
async function putBack(
  dir: string | null,
  rotation: Rotation | null,
  filed: FinalRotation | null,
): Promise<void> {
  if (dir === null) return;
  if (rotation !== null) await restoreRotation(dir, rotation);
  if (filed !== null) await restoreFinalRotation(dir, filed);
}

/**
 * The projects a cast is being planned for RIGHT NOW — one per project, at most.
 *
 * ── The window `enqueue` cannot cover ──────────────────────────────────────
 *
 * `pendingFor` already refuses a second job writing the same file, and it is the
 * dedup that matters: it survives reloads, it covers the whole life of the run,
 * and it joins a re-read's cast to one already waiting. What it cannot see is the
 * gap BEFORE the enqueue. `castFlowingBook` awaits `planConversion` first — which
 * reads a catalogue, resolves the archive, and asks the disk whether the bank is
 * marked — so five clicks on a read row inside that window are five calls that
 * have not reached `enqueue` yet, and every one of them would find nothing
 * pending and add a row.
 *
 * Keyed by PROJECT rather than by the path that was named, because the two
 * callers name different files — the read landing names the scan it was handed,
 * a click names the working copy the position resolved to — and both mean the one
 * flowing book of one project. Released the moment the plan has been enqueued or
 * refused, because from there `pendingFor` is a better answer than this is.
 */
const casting = new Set<string>();

/**
 * MAKE SURE THIS PROJECT HAS ITS FLOWING BOOK — the one door, for both reasons.
 *
 * Called by the reading's own landing (the book exists the moment the bank does)
 * and by main, when somebody stands on a read or curate row and the position
 * still resolves to a PDF. That second caller is the ruling: *"if i click the
 * ocr/read step, it should show the reflowed html. it should always move toward
 * the html, since thats a format we can work with."* A resolution that falls back
 * to the scan is the app settling for the format it can do least with, and the
 * answer is to MAKE the book rather than to show the photograph again.
 *
 * FIRE AND FORGET, and it must stay that way: the caller is answering "which
 * document is at the position", the honest answer is the one that exists right
 * now, and holding that answer for a rendering would leave a pane blank while a
 * job it was never told about ran.
 */
export async function ensureCast(readFrom: string): Promise<void> {
  const key = (projectDirOf(readFrom) ?? path.resolve(readFrom)).toLowerCase();
  if (casting.has(key)) return;
  casting.add(key);
  try {
    await castFlowingBook(readFrom);
  } finally {
    casting.delete(key);
  }
}

/**
 * A READING LANDED, SO THE BOOK EXISTS — cast it, now, without being asked.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * A reading's product is a BANK: hours of GPU, and nothing anybody can look at. So
 * the moment OCR finished, a person had a project whose only readable document was
 * the photograph they started with, and the flowing book they had actually paid for
 * did not exist until they found a dialog and asked for it by file format. The
 * user's account of what should happen is the whole specification: "from that bank,
 * we create an html page of the document - a proto epub. that's the step that
 * appears automatically the moment i OCR something."
 *
 * ── Why this costs almost nothing, which is what makes it automatic ─────────
 *
 * The cast is `vlm-convert --format epub --reuse-readings` over a bank that was
 * marked complete one line ago. It loads no model, opens no socket, reads no page
 * and takes seconds — so it is not held (the hold exists so that hours of GPU are
 * never spent by the act of configuring them, and there are no hours here), and it
 * does not wait for the reading server (`endpointFor` answers only for a `read`).
 * Both of those fall out of rules that already existed; nothing here argues for an
 * exception.
 *
 * ── THE LOOP GUARD, AND WHERE IT ACTUALLY LIVES ────────────────────────────
 *
 * A conversion landing must never enqueue anything, or a cast would cast a cast
 * forever. That is guaranteed structurally rather than by a flag: this is called
 * from the `read` arm of the settle and from nowhere else, and the `read` arm
 * returns before any conversion landing is reached. The second guard is
 * `enqueue`'s own dedup — a job already waiting or running to write this exact
 * file returns that row instead of a second one — so a re-read that lands while
 * the first cast is still queued joins it rather than racing it.
 *
 * ── Every refusal is a console line, never a failed reading ────────────────
 *
 * The plan can decline: a book whose previous cast is open in a tab (the rotation
 * would move a working tree out from under a reader), a bank whose marker did not
 * survive, a project directory that has gone. NONE of those is a reason to report
 * a three-hour reading as anything but the success it was — the bank is on disk,
 * it is complete, and the book can be asked for at any time for nothing. So the
 * reading lands, the reason is named in full in the terminal, and the person is
 * left with exactly what they paid for.
 *
 * A PIPED PLAN IS DECLINED TOO, and that one is a guard rather than an error. The
 * position is the reading this landing just recorded — `recordReading` moves the
 * pointer onto it — whose ancestry is the import, so `renderPipeline` finds no
 * translation and there is no second stage to compose. If one ever appeared here
 * it would mean the pointer is somewhere this function did not expect, and a
 * two-stage job would be HELD and would sit in the shelf waiting for a Start that
 * nobody knows to press — a translation of the book, run automatically, behind a
 * button labelled OCR. Skipping says so out loud instead.
 */
async function castFlowingBook(readFrom: string): Promise<void> {
  try {
    const plan = await planConversion(readFrom, 'epub');
    if (plan.thenTranslate !== undefined) {
      console.warn(
        `[job] the flowing book for ${path.basename(readFrom)} was not cast automatically: the `
        + 'project\'s position stands under a translation, and a cast that had to run the '
        + 'translator is not a free rendering. Generate it from the step you want.',
      );
      return;
    }
    enqueue(
      {
        kind: 'epub',
        inputPath: plan.sourcePath,
        outputPath: plan.outputPath,
        readingsPath: plan.readingsPath,
        overlayPath: plan.overlayPath,
      },
      // The reading this cast is made from, which `recordReading` has just left
      // the pointer standing on. Nothing downstream spends it — `recordGenerated`
      // reads `parentStep` only for a translation — but the shelf's row says which
      // step a job was started from, and "from nowhere" would be untrue of the one
      // job in this app that is started by another job landing.
      await parentOf(plan.outputPath),
    );
  } catch (err) {
    console.error(
      `[job] the reading of ${path.basename(readFrom)} landed, but the flowing book could not be `
      + `planned: ${err instanceof Error ? err.message : String(err)}. The bank is complete, so `
      + 'generating an EPUB from it is free whenever it is asked for.',
    );
  }
}

/**
 * The position of the project a job is about to write into.
 *
 * Main's `parentStepFor` said one folder over, for the same reason and about the
 * same field (`Job.parentStep`). It is spelled again here rather than exported
 * because the two callers reach it from opposite directions — main resolves it
 * between a renderer's press and a synchronous enqueue, this resolves it between
 * one job's settle and the next job's enqueue — and both are two lines over
 * `projectDirOf` and `positionStepId`. A shared helper would be a module boundary
 * drawn around a `??`.
 */
async function parentOf(target: string): Promise<string | null> {
  const dir = projectDirOf(target);
  return dir === null ? null : positionStepId(dir);
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
