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
 * A READING THAT LANDS MAKES ITS DOCUMENTS (`landReadProducts`, `castFlowingBook`).
 * Everything else in this queue arrives from a person pressing something; these
 * arrive from the previous job finishing, because the product of a reading is a
 * bank and a bank is not a thing anybody can look at. The user: "from that bank, we
 * create an html page of the document - a proto epub. that's the step that appears
 * automatically the moment i OCR something."
 *
 * THE FACSIMILE ARRIVES THE SAME WAY AND FOR THE SAME REASON — *"from the bank,
 * pdf facsimile can be generated. that's a terminal item"* (docs/RENDERER.md §0
 * A3): the pages as they were printed, set back as real text, made once when the
 * reading lands. It carries `forStep`, so the settle files it nowhere, and it is
 * drawn as a leaf under the book rather than as a step.
 *
 * THE READ ARM IS THE ONLY PLACE THAT DOES THIS, and that has to stay true: a
 * conversion landing that enqueued anything would be a cast casting a cast,
 * forever. The guard is structural rather than a flag — the `read` arm of the
 * settle is the only caller and it returns before any conversion landing runs —
 * and `enqueue`'s dedup on the output path is the second line, so two readings
 * landing near each other join one cast rather than racing two.
 *
 * THE BOOK FILE IS THE ONE PRODUCT THAT DOES NOT COME THROUGH HERE. `vlm-book` is
 * arithmetic over a bank on the disk — no model, no GPU, no server — so it is
 * spawned and awaited inside the settle rather than queued, which is the same
 * posture `loadBook` (electron/book.ts) already takes when a pane opens a book
 * nothing has reflowed. It goes FIRST, before anything is enqueued, because
 * `enqueue` pumps and a job started beside it would be a second child.
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
import { parseProgressLine, runEngine, writeBookFile } from './engine';
import { ENV_SPECS } from './env-catalog';
import { destFor, installEnv } from './env-install';
import {
  bookAtPosition,
  generatedRoleFor,
  imagesDirFor,
  metadataForProduct,
  positionStepId,
  projectDirOf,
  readStepLedger,
  recordFinal,
  recordGenerated,
  recordReading,
  recordTranslation,
  restoreFinalRotation,
  restoreRotation,
  rotateFinal,
  rotateGenerated,
  type FinalRotation,
  type Rotation,
} from './projects';
import { readSettings } from './settings';
import { ensureServer, isLocalVllmEndpoint, noteQueueBusy, noteQueueIdle } from './vllm-server';
import { planConversion, planConversionForStep, planFacsimile } from './workspace';
import type {
  ConversionKind, EnvInstallRequest, Job, JobRequest, LedgerStep, TranslateRequest,
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
     * A TRANSLATED RENDERING IS STILL A RENDERING, and it did not used to be.
     * This line held a Generate standing under a translation, honestly: that job
     * ran the TRANSLATOR as its second stage, and a seeded bank made it cheap
     * rather than free — text edited since the translation was re-asked of a
     * model, and a cold Ollama made it a translation run in everything but the
     * button that started it. There is no second stage now. A translated book is
     * one `vlm-convert` with the records substituted into the blocks: no model,
     * no socket, seconds, and repeatable as often as somebody likes. So it is
     * queued like every other rendering, and the hold goes back to meaning what
     * it has always meant — nothing expensive starts until the user says so.
     */
    state: request.kind === 'read' ? 'held' : 'queued',
    progress: null,
    parentStep,
    /*
     * CARRIED ONTO THE PUBLIC SHAPE, which almost nothing on a request is. The
     * shelf's row is everything the renderer knows about a job, and this is the
     * one fact that distinguishes a save's own book from the two `epub` jobs a
     * person asks for — which matters there because a finished one opens itself.
     * See `Job.forStep`.
     */
    ...(request.kind !== 'read' && request.forStep !== undefined
      ? { forStep: request.forStep }
      : {}),
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
 * Is a live job producing this file right now?
 *
 * Asked by main before "edit transformed text" rewrites a records file whole: a
 * translation appends to that file for hours, and a whole-file swap made in the
 * middle of its run would drop every answer the run lands between the read and
 * the rename. The check and the write are not one atom — a job could start in
 * the millisecond between — but the whole window a run is actually open is
 * caught here, and the sentence names the honest way out: wait, or cancel the
 * run.
 */
export function producing(outputPath: string): boolean {
  return pendingFor(outputPath) !== undefined;
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
  /*
   * WHAT THIS JOB PRODUCES, which for a translation is now the RECORDS — the same
   * sentence `enqueue` makes about a reading and its bank, and for the same
   * reason. A translation writes no document any more: it writes per-block answers
   * that a cast turns into a book afterwards. So the identity a row is deduped on
   * and the file Reveal shows is the file the run actually makes.
   */
  const already = pendingFor(request.recordsPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: request.recordsPath,
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
    // The derived book this export was going to be compiled from, if it never
    // got as far as the settle that normally sweeps it. Nothing else will ever
    // mention that file again — see `sweepDerivedBook`.
    void sweepDerivedBook(requests.get(job.id));
    changed();
    // A cancel can be the thing that empties the queue, and the drain signal
    // lives in pump()'s nothing-to-do branch — which nothing else would visit.
    void pump();
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
async function sweepDerivedBook(request: EngineRequest | undefined): Promise<void> {
  if (request === undefined || request.kind === 'read' || request.kind === 'translate') return;
  if (request.bookPath === undefined) return;
  try {
    await fsp.rm(request.bookPath, { force: true });
  } catch (err) {
    console.error(
      `[job] the derived book ${request.bookPath} could not be removed: ${(err as Error).message}`,
    );
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
function argsFor(
  request: EngineRequest,
  /**
   * The merged metadata patch this product carries, for the ONE route that puts
   * it on the command line rather than stamping it on afterwards — see the
   * compile branch below. Empty for every other job, and for a project whose
   * ancestry recorded nothing.
   */
  metadata: Record<string, string> = {},
): string[] {
  if (request.kind === 'translate') {
    /*
     * A translation shares nothing with a conversion's command line but the
     * program name. No `--format` and no `--out`: this run writes RECORDS, one
     * row per flowing block keyed by the block's own position in the reading
     * bank, and the engine refuses an `--out` beside `--records` by name because
     * the EPUB it would write is a book nobody would ever open.
     *
     * `--ollama` IS passed — unlike the reading backend, which the settings
     * screen owns and which the engine reads for itself. Ollama has no settings
     * screen here because it is not a server this app manages.
     *
     * `--records` IS THE CACHE AS WELL AS THE PRODUCT, which is why there is no
     * `--bank` on this line any more and why the engine refuses the pair. It was
     * the exact counterpart of `--readings` on a conversion — both hours of a
     * model held as answers — and it stopped being optional the day a 456-block
     * book was killed at block 152 having written nothing at all. Nothing about
     * that is weakened: an unchanged block's question is already answered in the
     * records file and is never asked twice, and every answer is appended the
     * moment it is accepted.
     */
    const args = [
      'translate',
      // The CAST, and never an edition: records mode reads `data-bf-src` off
      // every translatable block and `data-bf-note` off every aside, and refuses
      // a book carrying neither by name — which is exactly what `--final`
      // withholds. What the dialog hands over is the position's own document,
      // and the position's own document is the cast.
      '--epub', request.inputPath,
      '--records', request.recordsPath,
      '--to', request.to,
      '--model', request.model,
      '--ollama', request.ollama,
    ];
    if (request.from && request.from.trim().length > 0) args.push('--from', request.from.trim());
    /*
     * ── THE CHAIN, WHICH IS TWO FLAGS AND NO NEW MACHINERY ────────────────────
     *
     * `--source-records` makes each block's question about the PARENT'S answer
     * rather than about the book's own words, and `--from` above says which
     * language those answers are in. Both are composed by the plan off the
     * ledger (`planTranslation`, electron/workspace.ts): nothing reads a language
     * out of a records file, because a file of sentences is not a declaration and
     * a guess would put "German → Hungarian" on a prompt holding English.
     */
    if (request.sourceRecords !== undefined && request.sourceRecords.length > 0) {
      args.push('--source-records', request.sourceRecords);
    }
    /*
     * The reading these answers are about, written into every row and read by
     * nobody in the engine — `Overlay.generation`'s contract, one folder over. It
     * is what lets the app tell records made against THIS pass over the pages from
     * records left beside a book that has since been read again.
     */
    if (request.generation !== undefined && request.generation.length > 0) {
      args.push('--generation', request.generation);
    }
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
   * ── COMPILING THE BOOK SOMEBODY EDITED ───────────────────────────────────
   *
   * `foundry vlm-compile --book <derived> --out <product>`, and it is a different
   * command rather than a flag on the one below because it takes a different
   * INPUT: not the bank and a curation, but the book itself, with this position's
   * whole chain of changes already replayed into it by main (`materializeBook`,
   * electron/book.ts). The engine has never heard of the op grammar and never
   * will — the replay lives once, in this process, because the renderer draws
   * from it too (docs/RENDERER.md §9) — so what crosses the boundary is a
   * document and the engine's job is to compile what it is handed.
   *
   * NO `--reuse-readings`, NO `--overlay`, NO `--final`. The first two are about
   * a bank this run never opens. The third is about a choice this command does
   * not have: there is no cast to write from a book file, so the edition's rules
   * are the compile's constants (see `vlm-compile`'s own help).
   *
   * THE FACSIMILE NEVER REACHES HERE, and that is by construction rather than by
   * a test: `--format pdf` reprints the scan's own photographed lines from the
   * raw bank, so `planExport` never materialises a book for one and the field
   * that would send it down this branch is absent (docs/RENDERER.md §6).
   */
  if (request.bookPath !== undefined) {
    const args = ['vlm-compile', '--book', request.bookPath, '--out', request.outputPath];
    /*
     * THE FIGURES, WHICH ARE THE READING'S AND NOT THE BOOK FILE'S. A row names
     * its crop by NAME and the directory is composed from the bank the figures
     * were cut beside (`imagesDirFor`, electron/projects.ts) — the same
     * composition the pane serves them through. Passed only when it is there, on
     * `--overlay`'s rule: the engine refuses a directory it cannot open, and a
     * book with no pictures in it has none to be given.
     */
    const figures = imagesDirFor(request.readingsPath);
    if (existsSync(figures)) args.push('--images', figures);
    /*
     * AND THE RECORD THE PERSON TYPED, ON THE PACKAGE ITSELF. The bank route
     * takes its title from the PDF and has the metadata stamped on afterwards;
     * this route has no PDF to ask, so the merged patch reaches the book while it
     * is being made. The stamp still happens after it for an EPUB — the same two
     * commands, unchanged — and this is what makes a compiled `.txt` carry the
     * corrected title too, which nothing before could.
     */
    if (metadata['title'] !== undefined) args.push('--title', metadata['title']);
    if (metadata['creator'] !== undefined) args.push('--author', metadata['creator']);
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
  /*
   * ── AND THE TRANSLATION'S OWN WORDS, WHICH IS THE WHOLE OF THE SECOND STAGE ─
   *
   * A rendering standing under a translation used to be TWO spawns: this one into
   * a nameless EPUB in the temp directory, then `translate` reading that file and
   * writing the real one. It is one spawn and two flags now. `--records` puts the
   * translation's per-block answers into the blocks as the book is assembled, and
   * `--language` declares what comes out — a records file is a file of sentences
   * and does not say what language it is in, so without it `dc:language` and every
   * `xml:lang` would keep the source book's answer and the product would lie about
   * itself to every reader that asked.
   *
   * NOT TESTED FOR EXISTENCE, unlike the overlay above, and the difference is
   * deliberate. An absent overlay means "nobody has curated this book", which is a
   * state; an absent records file means the answers this product is MADE OF are
   * gone, and a run that quietly wrote the book in its original language while the
   * row said Hungarian is the worst outcome available here. The engine refuses a
   * `--records` it cannot open, by name, and that refusal is the right one.
   *
   * THEY TRAVEL TOGETHER OR NOT AT ALL — `planRendering` composes both or neither
   * — so a book cast in a language it does not hold is not a state this app can
   * construct.
   */
  if (request.records !== undefined && request.records.length > 0) {
    args.push('--records', request.records);
    if (request.language !== undefined && request.language.length > 0) {
      args.push('--language', request.language);
    }
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
   * and the landing. It is asked here of the REQUEST THIS FUNCTION WAS HANDED,
   * which is the stored one for every job except an export carrying a metadata
   * record: that one is handed a copy aimed at a temp file, and the copy carries
   * the flag exactly as the stored request does.
   *
   * A CAST'S COMMAND LINE IS UNTOUCHED: no `export`, no flag, and the engine's
   * default is the book it has always written.
   *
   * A TRANSLATED EXPORT GETS IT LIKE ANY OTHER, WHICH IT COULD NOT BEFORE. That
   * job used to be three runs — render, translate, then `epub-final` to tidy what
   * came back — because `translate` reads the very stamps this flag withholds
   * (FINAL_NEEDS_STAMPS, src/translate/book.ts), so the edition could only be made
   * AFTER the translation, from a finished book. Records are substituted at the
   * assembly, upstream of everything `--final` decides, so the edition and the
   * translation are made by one run and the tidy stage is gone.
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
 * THE RECORD A PRODUCT SHOULD CARRY, or nothing at all.
 *
 * Two lines over `projectDirOf` and `metadataForProduct`, spelled here for
 * `parentOf`'s reason: the module that knows where a project's files live answers
 * the question, and this is the two-line bridge from a path a job holds to that
 * answer. A product outside every project — there is no such export today, and
 * the type system cannot say so — carries nothing, which is the honest answer for
 * a file with no ledger behind it.
 *
 * ASKED OF THE STEP THE JOB CAPTURED, never of the position now. A pointer move
 * made while an export waited in the queue must not change which corrections the
 * book that comes out of it carries — the same rule `overlayPath` obeys one layer
 * up, and `metadataInEffect` falls back to the position for a captured step that
 * has since been deleted.
 */
async function recordFor(
  outputPath: string,
  kind: ConversionKind,
  parentStep: string | null,
): Promise<Record<string, string>> {
  const dir = projectDirOf(outputPath);
  if (dir === null) return {};
  return metadataForProduct(dir, kind === 'pdf' ? 'pdf' : 'epub', parentStep);
}

/**
 * A merged patch as flags — `--title "…" --creator "…"`, in the order the engine
 * declares its fields.
 *
 * ONE LINE PER FIELD AND NO INTERPRETATION. Both metadata commands take exactly
 * this shape, and both refuse a blank value by name (an empty `dc:title` is a book
 * claiming to be called nothing) — so an empty one is dropped here rather than
 * turned into a failed export. `mergedMetadata` has already dropped them; this is
 * the second half of one rule stated where the command line is composed, because
 * this is the last place anything can still be wrong.
 */
function metaFlagsFor(record: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    flags.push(`--${field}`, value);
  }
  return flags;
}

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
   * ── THE JOB THAT LANDS IN THE TRAY INSTEAD OF THE WORKSHOP ────────────────
   *
   * Everything below this line — the server wait, the spawn, the cancel, the
   * progress — is the same for an export as for any other rendering, because an
   * export IS a rendering (`planExport`). What it changes is the two ends: which
   * file the rotation moves aside, and what the settle records.
   *
   * DECIDED ONCE, HERE, because the narrowing that reaches `request.export` is
   * only available on a `GenerateRequest`, and three separate places re-deriving
   * it is three places for one of them to go on treating an export as a generate —
   * which would rotate the project's cast book aside to make room for a file that
   * is not going anywhere near it.
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
   * A RENDERING READS NOTHING. `argsFor` passes `--reuse-readings` on every
   * conversion, without a switch anywhere that could turn it off, so the engine
   * replays the completed bank: it loads no model, opens no socket, and leaves
   * the bank byte for byte as it found it (`readings.ts`, `openReadingsBank`).
   * That is as true of a TRANSLATED rendering as of any other — the translation's
   * words come out of a file on disk, not out of a model. A translation's own
   * model is Ollama's, which this app does not start.
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
   * ── THE TWO INTERMEDIATES THAT USED TO BE HERE, AND WHY THEY ARE GONE ──────
   *
   * A Generate standing under a translation wrote a whole EPUB nobody asked for
   * into the OS temp directory, so that the second stage had something to read;
   * a translate-descended EXPORT wrote a second one, because the tidy that makes
   * an edition refuses an `--out` equal to its `--epub`. Both existed because a
   * translation was a FILE and the only way to get a translated book carrying
   * this position's decisions was to make the book and give it away.
   *
   * A translated book is CAST now — one `vlm-convert`, the records substituted
   * into the blocks as it writes, the edition rules applied by the same run — so
   * there is no half-book to name, no directory this app does not own to put it
   * in, and no stage between the engine and the product. What is left is the
   * ONE intermediate that has nothing to do with translation: the file a run
   * writes when a metadata record is going on afterwards, because both metadata
   * commands refuse to write over their own input.
   */
  /*
   * ── AN EXPORT CARRIES THE RECORD THE PERSON TYPED ─────────────────────────
   *
   * A metadata edit is a step, and the reason it had to become one is exactly
   * this: an export is cast fresh from the bank, the corrections went into the
   * OPF of a working tree, and the working tree is not one of a cast's inputs —
   * so a title corrected in the dialog was silently ABSENT from the book that
   * landed in `final/`. The chain of patches on this position's ancestry is
   * merged (`metadataForProduct`, electron/projects.ts) and applied to the
   * product as the last thing that happens to it.
   *
   * ── Why a stage after, and not a flag on the run that makes the book ──────
   *
   * `vlm-convert` builds the package from the bank and has no notion of a record
   * somebody typed a fortnight later; teaching it one would put the ledger inside
   * the engine. `epub-meta` and `pdf-meta` already do exactly this to a finished
   * file, are already how the dialog writes, and are the same two commands whose
   * refusals the user has already seen.
   *
   * ── Which makes AN intermediate, and it is not avoidable ──────────────────
   *
   * Both commands refuse to write over their input, and both are right to:
   * `pdf-meta` re-emits the whole document through pdf-lib, so an `--out` equal to
   * `--pdf` would destroy the file being read while it was being read. So the
   * engine aims here and the metadata stage lands the destination — which also
   * means a run that gets this far and then cannot stamp the record leaves NO file
   * in the tray, rather than one the user would reasonably believe carries their
   * corrections.
   *
   * NULL FOR EVERY GENERATE, and for an export whose ancestry recorded nothing.
   * `generated/` is the workbench and its casts are re-made constantly; stamping
   * one would be bookkeeping applied to a file nobody keeps.
   *
   * PLAIN TEXT CARRIES NO RECORD AT ALL and is skipped by name: a `.txt` has
   * nowhere to put a title, and there is no third command that would pretend
   * otherwise.
   */
  /*
   * THE PATCH ITSELF, READ ONCE. It used to be read straight into flags for the
   * stamping stage, which is still where it goes for an EPUB or a PDF — but the
   * COMPILE route puts the title and the author into the package as it writes it
   * (`argsFor`), because a book file has no PDF behind it to take a title from,
   * and a plain-text export has no stamping stage at all and therefore had no way
   * to carry a corrected title before this. One read of the ledger, two consumers,
   * and neither of them re-derives the other's answer.
   */
  const merged = exporting
    ? await recordFor(next.outputPath, request.kind, next.parentStep ?? null)
    : {};
  const record = exporting && request.kind !== 'txt'
    ? {
      // The command follows the PRODUCT and not the position: a facsimile export
      // takes the Info dictionary's four fields whatever kind of document the
      // project started from. Carried as the kind rather than read back off the
      // extension later, so the composition below names one fact once.
      kind: request.kind === 'pdf' ? 'pdf' as const : 'epub' as const,
      flags: metaFlagsFor(merged),
    }
    : null;
  /*
   * The file the engine writes when a record is going on afterwards — named for
   * the job under a `foundry` subdirectory of the OS temp directory, because a
   * temp folder is shared and files loose in it belong to nobody, and with the
   * product's own extension because both metadata commands read the format they
   * are given.
   */
  const unstamped = record === null || record.flags.length === 0
    ? null
    : path.join(os.tmpdir(), 'foundry', `${next.id}.unstamped${path.extname(next.outputPath)}`);
  if (unstamped !== null) {
    try {
      await fsp.mkdir(path.dirname(unstamped), { recursive: true });
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
   * NEITHER OF THE TWO JOBS THAT WRITE INTO `readings/` ROTATES, and that is now
   * one rule rather than a reading's exception. A reading fills its BANK and a
   * translation fills its RECORDS; both live beside each other in a directory this
   * block has no business in, both are named per step so nothing is ever
   * overwritten, and both have the engine's own replace-on-success rule underneath
   * them (docs/BANK-LIFECYCLE.md §2). Rotating on their basename would move a file
   * out of `readings/` on the strength of a name that means something else there.
   *
   * THE TRANSLATION USED TO ROTATE, and losing that is losing nothing: what it
   * rotated was the EPUB it was about to overwrite, and it does not write an EPUB
   * any more. The self-overwrite case went with it — a re-translation into the
   * language a document already was named one path twice, so the run read the copy
   * the rotation had moved aside — because a records file is never also the book
   * being read.
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
  if (request.kind !== 'read' && request.kind !== 'translate') {
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
   * ── A BRANCH'S RECORDS START AS A COPY OF ITS PARENT'S ────────────────────
   *
   * Here, and not at plan time, because this is the first moment the job is a
   * commitment rather than a row somebody can still remove: a held translation
   * that is deleted from the shelf must leave `readings/` exactly as it found it,
   * and a file seeded at the plan would sit there named by no step, invisible to
   * the sweep, forever.
   *
   * WHY A BRANCH WANTS ITS PARENT'S ANSWERS AT ALL: translating from a save made
   * under a translation branches, and a branch owns its own file — but an EMPTY
   * one would make that first run a full re-translation of a book that is already
   * translated. The rows are keyed by the blocks' own text, so the parent's
   * answers are exactly as true in the branch as they were at home: the stricken
   * blocks are never looked up, and only text somebody edited since is re-asked.
   *
   * AN EXISTING FILE IS NEVER OVERWRITTEN. A retried job has its own answers in
   * there by now and they are newer than the seed; a replace of a row that already
   * has records carries no seed at all.
   *
   * IT COVERS EVERY TRANSLATION, WHICH IS THE FIX. This copy used to sit inside
   * the stage loop of a two-stage Generate, so it ran for a branch ordered by
   * standing on a save and pressing Generate and NEVER for one ordered from the
   * Translate dialog — which set no seed in the first place. A dialog-ordered
   * branch therefore started empty and paid full model price for a book whose
   * translation was one row up. One rule, one spawn, both doors.
   */
  if (request.kind === 'translate'
    && request.seedRecords !== undefined
    && !existsSync(request.recordsPath)
    && existsSync(request.seedRecords)) {
    try {
      await fsp.mkdir(path.dirname(request.recordsPath), { recursive: true });
      copyFileSync(request.seedRecords, request.recordsPath);
    } catch (err) {
      console.error(`[job] could not seed ${request.recordsPath} from ${request.seedRecords}:`, err);
    }
  }

  /*
   * ── THE ONE RUN THIS JOB IS ───────────────────────────────────────────────
   *
   * It was one for everything this app queued except a Generate standing under a
   * translation, which was two: `vlm-convert` into a temp EPUB, then `translate`
   * out of it. A translated book is cast by the first of those alone now, so the
   * stage list, the loop that walked it and the `handle` reassigned between its
   * spawns are gone with it.
   *
   * AIMED AT THE INTERMEDIATE WHEN A RECORD IS GOING ON AFTER IT. `unstamped` is
   * non-null only for an export whose ancestry recorded metadata (see it, above,
   * for the whole argument), and both metadata commands refuse to write over their
   * own input. Everything else about this spawn is the request as it was stored —
   * the stored one is what the row, the rotation and the landing are about, and
   * only the child process sees this substitution.
   *
   * The `read` and `translate` arms are unreachable — neither is ever an export
   * and neither has a record to carry — and they are written out because the
   * alternative is a cast asserting that to the compiler, which is a promise
   * rather than a fact.
   */
  const spawned: EngineRequest = unstamped === null
    || request.kind === 'read'
    || request.kind === 'translate'
    ? request
    : { ...request, outputPath: unstamped };

  /*
   * ── THE LAST RUN: THE RECORD THE PERSON TYPED, PUT ON WHAT WAS MADE ───────
   *
   * `foundry epub-meta` or `foundry pdf-meta` over the finished product, into the
   * file the row is about. It is the same command the metadata dialog writes
   * with — the same refusals, in the same words, about the same fields — applied
   * to a book that has just been assembled out of a bank that never knew the
   * title had been corrected.
   *
   * SPELLED HERE RATHER THAN MADE A REQUEST SHAPE: the three shapes are what this
   * app QUEUES, each with a row, a landing and a settle, and this is a step inside
   * one job rather than a job. A fourth would have to be threaded through the
   * plans, the shelf and every settle path to be used in one place. The flags are
   * `metaFlagsFor`'s, which is one line and refuses to put an empty value on a
   * command line.
   *
   * NULL FOR EVERY JOB THAT IS NOT AN EXPORT WITH SOMETHING TO SAY, which is
   * nearly all of them.
   */
  const stamping: string[] | null = unstamped === null || record === null
    ? null
    : record.kind === 'pdf'
      ? ['pdf-meta', '--pdf', unstamped, '--out', next.outputPath, ...record.flags]
      : ['epub-meta', '--epub', unstamped, '--out', next.outputPath, ...record.flags];

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
   * already open — and one PER RUN, because a job that is a spawn followed by a
   * metadata stamp is exactly the case where a single line would leave somebody
   * reading the wrong command.
   */
  const args = argsFor(spawned, merged);
  console.log(`[job] ${next.kind} ${args.join(' ')}`);
  let handle = runEngine(args, watch);
  /*
   * THE CANCEL FOLLOWS THE LIVE CHILD. `handle` is reassigned before the metadata
   * stamp and the closure reads it, so the ✕ kills whichever engine is actually
   * running rather than a child that has already exited — and `running` stays set
   * across the gap between them, so no second `pump()` can slip a job in beside
   * this one and put two engines on one GPU.
   */
  running = { id: next.id, cancel: () => handle.cancel() };
  starting = false;

  let result = await handle.done;
  /*
   * ── AND THE RECORD, WHICH IS NOW THE LAST THING THAT HAPPENS ──────────────
   *
   * Only for an export whose ancestry recorded metadata, only when the run before
   * it succeeded, and it is what actually writes the file the row is about — the
   * engine wrote into the temp directory. `handle` is reassigned, so the ✕ still
   * kills the child that is running.
   *
   * A FAILURE HERE FAILS THE JOB, in the engine's own words, and that is the
   * conservative answer rather than the harsh one. The alternative is filing a
   * book in the tray and reporting success while the corrections the person made
   * are missing from it — which is the exact silence this whole unit exists to
   * end, reintroduced one stage later.
   */
  if (stamping !== null && result.code === 0) {
    next.message = 'Writing the record onto it…';
    next.note = null;
    changed();
    console.log(`[job] ${next.kind} ${stamping.join(' ')}`);
    handle = runEngine(stamping, watch);
    result = await handle.done;
  }
  running = null;
  next.finishedAt = Date.now();

  /*
   * THE INTERMEDIATE GOES NOW, whichever way this ended. A run that failed while
   * writing leaves a whole book in the temp directory, and the next one writes a
   * fresh one under its own job id — so keeping it would be hoarding half-books
   * nobody can name against a directory this app does not own.
   *
   * THERE USED TO BE THREE OF THEM: the untranslated cast a two-stage Generate
   * made for its translator, the untidied translation an export made for its
   * edition, and this one. Both of the others were the cost of a translation being
   * a FILE; a translated book is cast by the run that assembles it now, so the
   * only scratch file left is the one the metadata stamp reads, and it exists
   * because both metadata commands refuse to write over their own input.
   *
   * BEST EFFORT, AND NEVER A THROW. A leftover temp file is a console line; the
   * job it belonged to succeeded or failed on its own merits, and reporting three
   * hours of GPU as a failure because a scratch file would not unlink would be
   * the bookkeeping deciding what happened to the book. `force` so an
   * already-absent file — the ordinary case when the run never got that far — is
   * silence rather than an error.
   */
  if (unstamped !== null) {
    try {
      await fsp.rm(unstamped, { force: true });
    } catch (err) {
      console.error(`[job] the intermediate ${unstamped} could not be removed: ${(err as Error).message}`);
    }
  }

  // And the book main materialised for this export, whichever way it ended —
  // `sweepDerivedBook` carries the whole argument.
  await sweepDerivedBook(request);

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
      /*
       * ── AND THE TWO DOCUMENTS THE BANK IS FOR, NEITHER OF THEM A STEP ────────
       *
       * The book file and the facsimile, in that order, both recorded as this
       * reading's products (docs/RENDERER.md §6). Ordered rather than fired
       * together for one reason that matters: `landReadProducts` SPAWNS the
       * reflow and awaits it, while the facsimile is ENQUEUED — and `enqueue`
       * pumps, so a facsimile added first would have an engine of its own running
       * beside `vlm-book`. It goes first, on its own, and comes back before
       * anything else in this app is allowed to start a child.
       *
       * IT IS AWAITED AND IT CANNOT FAIL THE READING. Every way it can go wrong
       * is a console line inside it, for `ensureCast`'s reason immediately below:
       * the bank is on disk, it is complete, and both documents are made from it
       * for nothing whenever they are asked for.
       */
      await landReadProducts(next.outputPath, next.inputPath);
      await ensureCast(next.inputPath);
      void pump();
      return;
    }
    /*
     * ── A TRANSLATION LANDED, AND WHAT IT LEFT IS ANSWERS ────────────────────
     *
     * The same shape as the reading above it, which is the shape it should always
     * have had: this run produced no document at all. It wrote
     * `readings/<key>.<tag>[.<id8>].records.jsonl` — one row per flowing block —
     * and the step that keeps what those hours cost names THAT file as its payload
     * (`recordTranslation`, electron/projects.ts), exactly as a read step names its
     * bank.
     *
     * IT USED TO GO THROUGH `recordGenerated`, because the product was an EPUB in
     * `generated/` and that function is where a finished document is catalogued.
     * Nothing about a records translation fits there: there is no document to put
     * on a type's chain, nothing to promote to the project's live PDF, and the file
     * is not in `generated/` at all — the landing would have refused it by name.
     *
     * THE ONE FACT THE JOB HANDS OVER is the one nothing on disk can answer
     * afterwards: which language was asked for. Reading it back out of a filename
     * is what this codebase's oldest house rule forbids, so the job that asked says
     * which. WHETHER THIS WAS A CHAIN IS NOT HANDED OVER, deliberately: it is a
     * fact about the row this step hangs from, the landing is holding the ledger,
     * and this request's `--from` is also where a person's typed guess about an
     * untranslated book's language goes (`recordTranslation` argues it in full).
     *
     * AND THEN THE BOOK, WITHOUT BEING ASKED. A records file is not a thing a
     * person reads, so the row would have nothing to show until somebody ordered a
     * rendering by file format — which is the exact gap the automatic cast after a
     * reading was built to close, one action later. It is the same cast: free,
     * offline, seconds, and fired and forgotten so that a translation that landed
     * is never reported as a failure because the book after it could not be planned.
     */
    if (request.kind === 'translate') {
      await recordTranslation(next.outputPath, {
        parentStep: next.parentStep ?? null,
        language: request.to,
        ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
      });
      next.message = `Translated ${path.basename(next.inputPath)} — the book follows.`;
      changed();
      await ensureTranslateCast(next.outputPath);
      void pump();
      return;
    }
    /*
     * ── AN EXPORT IS FILED AND NOTHING ELSE HAPPENS TO IT ─────────────────────
     *
     * `recordGenerated` below does three things to a finished rendering: it puts a
     * step on that type's chain, it can promote the result to the project's live
     * PDF, and it announces the library. Every one of those is about a document
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
     * ── A STEP'S OWN DOCUMENT IS FILED NOWHERE, AND THAT IS THE POINT ────────
     *
     * It is a RENDERING of a payload that is already a step — the snapshot in
     * `curations/` for a save, the records in `readings/` for a translation, the
     * BANK for a reading's facsimile — so it is free to make again and there is
     * nothing here for a catalogue to own. Cataloguing it would do active harm
     * rather than merely being redundant: `castBook` (electron/projects.ts) picks
     * the newest `origin` sitting directly in `generated/` as the project's flowing
     * book, so the first Apply would quietly make a save's private book into what
     * the READ row shows — the exact confusion the per-step cast was built to end.
     * Home's document rows would grow one entry per Apply beside it, and the
     * facsimile would land on the PDF's chain beside the scan and be offered as the
     * document this app edits.
     *
     * Which leaves the file's disposal, and it is not left to chance: the step
     * delete composes the same name and sweeps it, along with any working tree
     * unpacked from it (`planStepSweep`).
     *
     * NO LEDGER STEP EITHER, for the reason above it: the step this is the document
     * of already exists, and minting a second one for the rendering would put a
     * filename where an action belongs.
     *
     * THE SENTENCE FOLLOWS THE PRODUCT, because these two are not the same thing to
     * the person reading the shelf: one is the book at a row in the history, the
     * other is the pages of a reading reprinted. Decided off the format, which is
     * the whole of the difference — a per-step cast is an EPUB and a facsimile is
     * the only PDF this app ever makes with a step on it.
     */
    if (request.forStep !== undefined) {
      next.message = request.kind === 'pdf'
        ? 'The facsimile of those pages is ready.'
        : 'The book at that step is ready.';
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
     * ONE ARGUMENT LIGHTER THAN IT WAS, and the whole of the difference is that a
     * translation does not come through here any more. This call used to carry the
     * language, the bank and the step id, because the run that produced a
     * translation ended in `generated/` and its landing was a ledger step; a
     * records translation lands where its answers land (`recordTranslation`), and
     * what reaches this function from a translated position is the BOOK cast from
     * those records — which carries `forStep` and returns above, uncatalogued.
     *
     * The REQUEST's kind, not the job row's: `JobKind` also admits `env-install`,
     * which never reaches this branch but which the compiler cannot know that
     * about, and a cast here would be a promise made to the type system rather
     * than a fact. The request is the narrower shape — narrowed by the two arms
     * above, which return — and it is the same decision.
     *
     * ── A BOOK MADE OF A TRANSLATION'S WORDS IS FILED AS A TRANSLATION ────────
     *
     * `records` is the whole test, and it has to be here rather than implied. The
     * roles are not four names for one thing: `castBook` (electron/projects.ts)
     * picks the newest `cast` sitting directly in `generated/` as THE PROJECT'S
     * FLOWING BOOK, which is what the read row and every save row resolve to. So a
     * Hungarian book filed as a cast would quietly become what the German rows
     * show — the exact confusion the per-step cast was built to end, arrived at
     * from the other side.
     *
     * The old two-stage pipeline said this same sentence about its own second
     * stage (`piped !== null ? 'translation'`). There is no second stage now; what
     * makes a rendering a translation is that the words in its blocks came out of
     * a records file, and that is one field on the request.
     */
    const live = await recordGenerated(
      next.outputPath,
      request.records !== undefined ? 'translation' : generatedRoleFor(request.kind),
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
 * MAKE SURE THIS STEP HAS ITS OWN BOOK — the one door for both landings that cast
 * one, called by the commit in main the instant a `curate` step lands and by this
 * file's own settle the instant a `translate` step does.
 *
 * A SAVE'S BOOK exists so that standing on that row shows the book AS IT WAS THEN
 * rather than the project's one cast wearing today's marks (docs/WORKBENCH.md §9).
 * A TRANSLATION'S BOOK exists because the run wrote no book at all: what it left is
 * per-block answers, and until they are cast the row has nothing a pane can show.
 *
 * KEYED BY PROJECT **AND** STEP, which is the one line that differs from
 * `ensureCast` above and the reason this is not a parameter on it. That set answers
 * "this project is already having its flowing book planned", and it is exactly
 * right there: there is one such book and a second planner would be a second row
 * for it. There are as many per-step books as there are steps, and two commits in
 * one project are two different files — a project-keyed guard would silently drop
 * the second one, which is a step with no book of its own and no way to notice.
 *
 * FIRE AND FORGET, and here it matters more than it does above: the callers are a
 * commit and a landing. A save must land whatever the caster does and a translation
 * must be recorded whatever the caster does, so no way this can fail is allowed to
 * reach either of them, and every one of them is a console line.
 */
export async function ensureStepCast(readFrom: string, step: LedgerStep): Promise<void> {
  const project = (projectDirOf(readFrom) ?? path.resolve(readFrom)).toLowerCase();
  // NUL-joined for the reason every composite key in this app is: it is the one
  // byte that cannot appear in a path or a uuid, so no pair of them can run
  // together into a third spelling that collides with an honest one.
  const key = `${project}\u0000${step.id}`;
  if (casting.has(key)) return;
  casting.add(key);
  try {
    await castStepBook(readFrom, step);
  } finally {
    casting.delete(key);
  }
}

/**
 * A TRANSLATION LANDED, SO ITS BOOK CAN EXIST — the same door, named by the file
 * the run wrote rather than by a step the caller is holding.
 *
 * The settle has the records path and nothing else: the step was minted by
 * `recordTranslation` a moment earlier, inside a manifest write this file
 * deliberately does not reach into. So the row is looked up by the payload it
 * names, which is the same whole-project-relative-path rule every other lookup in
 * this app obeys — and emphatically not by reading the `<id8>` back out of the
 * filename, which is what the house rule forbids.
 *
 * NOTHING HAPPENS FOR A LANDING WHOSE ROW COULD NOT BE WRITTEN (a console line of
 * its own, in `recordTranslation`), and that is the honest answer rather than a
 * fallback: a book cast for a step that does not exist is a file no screen in this
 * app would ever mention and no delete would ever sweep.
 */
export async function ensureTranslateCast(recordsPath: string): Promise<void> {
  const dir = projectDirOf(recordsPath);
  if (dir === null) {
    console.error(
      `[job] ${path.basename(recordsPath)} finished outside any project, so no book was cast from it.`,
    );
    return;
  }
  try {
    const view = await readStepLedger(dir);
    const relative = path.relative(dir, path.resolve(recordsPath)).split(path.sep).join('/');
    const step = view?.ledger.steps.find(
      (row) => row.action === 'translate' && row.payload === relative,
    );
    if (step === undefined) {
      console.warn(
        `[job] the translation of ${path.basename(dir)} landed, but no step in that project's history `
        + 'names those answers, so no book was cast from them.',
      );
      return;
    }
    // The records file rather than the directory: every plan resolves the pixels
    // out of `archive/` for itself and only needs to be told WHICH project, and a
    // real file inside one is what the resolution is written to take.
    await ensureStepCast(recordsPath, step);
  } catch (err) {
    console.error(
      `[job] the translation of ${path.basename(dir)} landed, but its history could not be read `
      + `(${err instanceof Error ? err.message : String(err)}), so no book was cast from it.`,
    );
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
    if (plan.records !== undefined) {
      console.warn(
        `[job] the flowing book for ${path.basename(readFrom)} was not cast automatically: the `
        + 'project\'s position stands under a translation, so this plan is about the translated '
        + 'book rather than about the one the reading just made. Stand on the reading for that.',
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
 * Everything `bookAtPosition` answers, named once so the two halves of a read
 * landing hand each other one shape rather than five arguments. Inferred rather
 * than declared, because the shape is electron/projects.ts's and a copy of it
 * here would be a second declaration of somebody else's answer.
 */
type BookAtPosition = Awaited<ReturnType<typeof bookAtPosition>>;

/**
 * A READING LANDED, SO ITS TWO DOCUMENTS CAN EXIST — the book file, then the
 * facsimile. Neither is a step, and both are recorded as this reading's products
 * (docs/RENDERER.md §6).
 *
 * ── WHICH READING, PROVEN RATHER THAN ASSUMED ───────────────────────────────
 *
 * `recordReading` has just stamped the catalogue and left the pointer standing on
 * the row it landed — a read is not retained beside you (`RETAINED_BESIDE_YOU`),
 * and a replace swaps into the step it re-ran and stands there too — so
 * `bookAtPosition` reads back exactly the reading this job just made: its bank,
 * the language it was asked in, and the archived original the figures are cut
 * out of. That is one source for four facts that would otherwise be composed
 * here from a request and a filename.
 *
 * AND IT IS CHECKED, because `recordReading` NEVER THROWS. A catalogue it could
 * not write is a console line of its own and a bank that is still on disk — and
 * the position then still names the reading BEFORE this one, whose book file and
 * facsimile are about a different pass over the pages. Remaking those would
 * quietly re-cut another reading's figures and rotate another reading's reprint
 * aside on the strength of this run finishing. So the two answers are put side by
 * side: the position must name a reading at all, and that reading's bank must be
 * the file this run filled. Anything else is a sentence in the terminal and
 * nothing touched — which is a refusal, not a fallback: there is no second guess
 * at which reading this is, and the products stay as they were until somebody
 * opens the book (`loadBook` ensures the book file) or asks for a facsimile.
 */
async function landReadProducts(bankPath: string, readFrom: string): Promise<void> {
  const dir = projectDirOf(bankPath);
  if (dir === null) {
    console.error(
      `[job] ${bankPath} was filled outside any project, so no book file and no facsimile were `
      + 'made from it.',
    );
    return;
  }
  let at: BookAtPosition;
  try {
    at = await bookAtPosition(dir);
  } catch (err) {
    console.error(
      `[job] the reading of ${path.basename(readFrom)} landed, but ${dir} could not say which `
      + `reading is in effect (${err instanceof Error ? err.message : String(err)}), so neither `
      + 'the book nor the facsimile was made from it.',
    );
    return;
  }
  if (at.reading === null || !samePath(at.bank, bankPath)) {
    console.error(
      `[job] the reading that filled ${bankPath} is not the one ${dir} now stands on `
      + `(${at.reading === null ? 'no reading is recorded there' : at.bank}), so nothing was `
      + 'remade from it — the bank is complete and both documents are free to make from it '
      + 'whenever they are asked for.',
    );
    return;
  }
  await remakeBookFile(at);
  await castFacsimile(readFrom, at.reading);
}

/**
 * THE BOOK FILE, REMADE BECAUSE THE READING LANDED — the one door the contract
 * allows to rebuild one, taken as an announced action.
 *
 * ── Why it overwrites, and why that is the safe direction ───────────────────
 *
 * A book file is a pure function of the receipt (docs/BOOK-FILE.md §1) and is
 * regenerated ONLY deliberately, never silently on open, because ops are keyed to
 * the ids in it. This is the deliberate moment: a NEW BANK has just landed at this
 * path, so a book file sitting beside it is the reflow of answers that no longer
 * exist — stale by definition, and the loader would refuse it by name on the next
 * open (`bankSha`, electron/book.ts). Rebuilding it here is what turns that
 * refusal into a book somebody can read, and the log line is the announcement §2
 * asks for.
 *
 * THE FIGURES COME WITH IT AND ARE NOT THIS SIDE'S BUSINESS. `--pdf` is passed
 * whenever the archive is one, and the engine sweeps `readings/<key>.images/` and
 * re-cuts only the pages that carry Picture blocks (src/vlm/book-run.ts). A
 * project whose original is an EPUB has no pages to cut and the engine says so —
 * an ordinary answer, not a hole.
 *
 * A REFUSAL IS THE ENGINE'S OWN WORDS TO THE TERMINAL AND NOTHING ELSE. The bank
 * is real, it is complete, and it is what those hours bought; reporting the
 * reading as a failure because the reflow after it would not run would be this
 * app calling somebody's GPU time lost over a file it can make again in seconds.
 * The next open of the book makes it (`loadBook`), which is the same command with
 * the same arguments.
 */
async function remakeBookFile(at: BookAtPosition): Promise<void> {
  console.log(
    `[job] the reading landed, so ${at.book} is being remade from ${at.bank}`
    + `${at.pdf === null ? ' (no archived PDF, so no figures are cut)' : ''}.`,
  );
  const made = await writeBookFile(at.bank, at.book, { pdfPath: at.pdf, language: at.language });
  if (!made.ok) {
    console.error(
      `[job] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}\n`
      + 'The bank is complete and the reading stands; opening the book makes it again.',
    );
  }
}

/**
 * THE FACSIMILE, ENQUEUED — the page-for-page record of the pages that were just
 * read, and a TERMINAL product.
 *
 * ── What it costs, which is what makes it automatic ─────────────────────────
 *
 * `castFlowingBook`'s three arguments, unchanged and unrepeated: a
 * `--reuse-readings` pass over a bank marked complete a moment ago loads no
 * model, opens no socket and takes seconds, so it is not held and does not wait
 * for the reading server; and it cannot loop, because a conversion landing
 * enqueues nothing and this is called from the `read` arm alone.
 *
 * ── NO GUARD SET, and that is the difference from `ensureCast` ──────────────
 *
 * That one is keyed by project because it has TWO callers — this settle and main,
 * when somebody stands on a read row — and five clicks inside the window before
 * an enqueue are five rows. This has one caller, inside a serial queue, so the
 * window `casting` exists to cover cannot open. `enqueue`'s dedup on the output
 * path is still underneath it, which is what joins a re-read's facsimile to one
 * already waiting.
 *
 * ── `forStep`, WHICH IS WHAT MAKES THE LANDING TERMINAL ─────────────────────
 *
 * It says "this document is one step's own", and three things the plan orders
 * fall out of it rather than being arranged separately. The settle files it
 * NOWHERE — no `recordGenerated`, so no row on the PDF chain beside the scan, no
 * promotion to the project's live PDF, no place to stand. The renderer's
 * auto-open effect skips it (`OPENS_ITSELF`), so three hours of OCR do not end by
 * throwing a reprint into a column over whatever the person was reading. And the
 * shelf's row says which step the job was started from, which this one genuinely
 * was. What draws it is `ProjectSummary.facsimiles`, composed from this same
 * step's id — the name is never read back out of the file.
 *
 * NO OVERLAY, DELIBERATELY, and it is the one field of the plan left on the
 * floor. A facsimile reprints what was READ; it compiles from the raw bank and
 * from nothing else (docs/RENDERER.md §6). Handing it the live curation would
 * make the record of a reading depend on corrections made after it — and on a
 * re-read those corrections name blocks by numbers that mean different blocks
 * now, so the reprint would be struck in the wrong places by a file about another
 * pass over the pages.
 */
async function castFacsimile(readFrom: string, reading: LedgerStep): Promise<void> {
  try {
    const plan = await planFacsimile(readFrom, reading);
    enqueue(
      {
        kind: 'pdf',
        inputPath: plan.sourcePath,
        outputPath: plan.outputPath,
        readingsPath: plan.readingsPath,
        forStep: reading.id,
      },
      // The reading this reprint is of, which is also where the pointer is
      // standing. Nothing downstream spends it; the shelf's row says which step a
      // job was started from, and this one is that step's own product.
      reading.id,
    );
  } catch (err) {
    console.error(
      `[job] the reading of ${path.basename(readFrom)} landed, but its facsimile could not be `
      + `planned: ${err instanceof Error ? err.message : String(err)}. The bank is complete, so `
      + 'the pages can be reprinted from it whenever that is asked for.',
    );
  }
}

/**
 * A STEP LANDED, SO THAT STEP'S BOOK CAN EXIST — cast it, without being asked.
 *
 * ── The two gaps this closes, in the user's terms ───────────────────────────
 *
 * A curate row showed the project's ONE cast, so every save in a book's history
 * showed the same document: the live tree wearing today's marks. Clicking a save
 * from last week showed the present, which makes a restore point a row you can
 * stand on and learn nothing from. The ruling (docs/WORKBENCH.md §9): a curate
 * landing casts its own book, and standing on an older save shows the book as of
 * that save.
 *
 * A translate row is the same gap arrived at from the other side. The run writes
 * per-block ANSWERS and no book at all, so without this the row a person just
 * created would have nothing on screen behind it until they went and ordered a
 * rendering by file format — which is exactly the state the automatic cast after a
 * reading was built to end, one action later.
 *
 * ── The same three arguments `castFlowingBook` makes, unchanged ─────────────
 *
 * It costs nothing (a `--reuse-readings` pass over a completed bank, with the
 * translation's words read out of a file: no model, no socket, seconds); it is
 * therefore not held and does not wait for the reading server; and it cannot loop,
 * because a conversion landing enqueues nothing and this is called from a commit
 * or from the settle of a job that is not a conversion.
 *
 * ── Every refusal is a console line, never a failed save or a lost translation ─
 *
 * That is the whole of the error handling and it is deliberate. The thing the user
 * pressed the button for has already happened: the snapshot is on disk, or the
 * records are, and the row is in the ledger. Reporting failure because a rendering
 * could not be planned would be this app calling somebody's work lost over a file
 * it can make again for nothing.
 */
async function castStepBook(readFrom: string, step: LedgerStep): Promise<void> {
  try {
    const plan = await planConversionForStep(readFrom, step);
    enqueue(
      {
        kind: 'epub',
        inputPath: plan.sourcePath,
        outputPath: plan.outputPath,
        readingsPath: plan.readingsPath,
        /*
         * THE SNAPSHOT, AND NOT THE LIVE OVERLAY. `planConversionForStep` is the
         * whole of that decision and its header is the argument; carried here the
         * way every other plan's answers are, so that a correction made while this
         * job waits cannot change the book a step is about.
         */
        overlayPath: plan.overlayPath,
        /*
         * AND THE TRANSLATION'S OWN WORDS, when this step is one or stands under
         * one. The plan composed both or neither, so a book cast in a language it
         * does not hold is not a state this call can construct.
         */
        ...(plan.records !== undefined ? { records: plan.records } : {}),
        ...(plan.language !== undefined ? { language: plan.language } : {}),
        /*
         * WHICH STEP THIS IS THE BOOK OF. It stops the landing cataloguing the
         * file as one of the project's documents — see `GenerateRequest.forStep`,
         * where the reason is that `castBook` must go on meaning the project's one
         * flowing book however many saves have been pressed.
         */
        forStep: step.id,
      },
      // The step this book is of. Nothing downstream spends it; the shelf's row
      // says which step a job was started from, and this one genuinely was.
      step.id,
    );
  } catch (err) {
    console.error(
      `[job] “${step.label}” landed, but the book at that step could not be planned: `
      + `${err instanceof Error ? err.message : String(err)}. The step itself is recorded, and `
      + 'that row goes on showing whatever it showed before.',
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
