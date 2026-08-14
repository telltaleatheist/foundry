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
 * ── Nothing an engine runs starts until the user says so ─────────────────────
 *
 * An engine job is enqueued HELD. It sits in the list, in order, visible, and
 * does nothing until `start()` releases it. `pump()` only ever claims a `queued`
 * job, so the gate is the state itself rather than a flag anything has to
 * remember to check.
 *
 * THE POINT IS THE BATCH. Enqueueing used to pump immediately, which made the
 * moment of configuring the moment of commitment: the first conversion was
 * already reading pages before the second book could be chosen, so "queue these
 * four and let them run overnight" was not a thing this app could do. `start()`
 * releases everything held AT THAT MOMENT and nothing else — a job added after
 * the press is held again, because Start means "run what is here" and a button
 * that silently also armed the future would make the next enqueue a surprise.
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
import * as path from 'node:path';

import { readAppSettings } from './app-settings';
import { parseProgressLine, runEngine } from './engine';
import { ENV_SPECS } from './env-catalog';
import { destFor, installEnv } from './env-install';
import { generatedRoleFor, recordGenerated } from './projects';
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
export function enqueue(request: JobRequest): Job {
  const already = pendingFor(request.outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    kind: request.kind,
    state: 'held',
    progress: null,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  // No pump: a held job is not for the machine to find. `start()` releases it.
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
export function enqueueTranslate(request: TranslateRequest): Job {
  const already = pendingFor(request.outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    kind: 'translate',
    state: 'held',
    progress: null,
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
  const args = [
    'vlm-convert',
    '--pdf', request.inputPath,
    '--out', request.outputPath,
    '--readings', request.readingsPath,
  ];
  // Passed only when it is not the default, so an EPUB job's command line is the
  // one it has always been and a diff of two runs shows what actually differed.
  // The extension `planConversion` chose already agrees with it; the engine
  // refuses the pair outright if it ever stops agreeing.
  if (request.kind !== 'epub') args.push('--format', request.kind);
  if (request.skipPages && request.skipPages.trim().length > 0) {
    args.push('--skip-pages', request.skipPages.trim());
  }
  if (request.stripNoteMarkers === true) args.push('--strip-note-markers');
  if (request.language && request.language.trim().length > 0) {
    args.push('--language', request.language.trim());
  }
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

  const args = argsFor(request);
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
  } else {
    next.state = 'failed';
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
