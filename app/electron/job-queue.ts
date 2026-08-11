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
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { parseProgressLine, runEngine, type RunHandle } from './engine';
import type { Job, JobRequest } from '../shared/types';

const jobs: Job[] = [];
let running: { id: string; handle: RunHandle } | null = null;
let notify: (jobs: Job[]) => void = () => { /* set by main */ };

/** Where the queue publishes. Called on every mutation, with the whole list. */
export function onQueueChanged(listener: (jobs: Job[]) => void): void {
  notify = listener;
}

export function listJobs(): Job[] {
  // A copy: the renderer's mirror must not be able to reach back into the truth.
  return jobs.map((job) => ({ ...job, progress: job.progress ? { ...job.progress } : null }));
}

function changed(): void {
  notify(listJobs());
}

export function enqueue(request: JobRequest): Job {
  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    kind: request.kind,
    state: 'queued',
    progress: null,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  void pump();
  return job;
}

/** The full request, kept beside the job — the job itself is the PUBLIC shape. */
const requests = new Map<string, JobRequest>();

/**
 * Cancel: kill the child if it is this job's, drop it from the queue if it is
 * not. Both end as `cancelled`, because from the shelf they are one gesture.
 */
export function cancel(id: string): void {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.state === 'running' && running?.id === id) {
    running.handle.cancel();
    return; // the close handler settles the state
  }
  if (job.state === 'queued') {
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    changed();
  }
}

/** Clear everything that has stopped. The running job and the queue survive. */
export function clearFinished(): void {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job && job.state !== 'queued' && job.state !== 'running') {
      requests.delete(job.id);
      jobs.splice(i, 1);
    }
  }
  changed();
}

/** Quit, or a window closing on us: nothing is left holding a GPU. */
export function shutdown(): void {
  running?.handle.cancel();
  running = null;
}

/**
 * The command line, assembled in ONE place.
 *
 * `--readings` is passed whenever the panel named a bank: it is what makes an
 * interrupted 300-page run resumable, and foundry decides for itself whether a
 * bank beside a completion marker is a resume or a re-read (README §Reading the
 * pages somewhere else, and only once). This app does not second-guess it.
 */
function argsFor(request: JobRequest): string[] {
  const args = ['vlm-convert', '--pdf', request.inputPath, '--out', request.outputPath];
  if (request.endpointUrl && request.endpointUrl.trim().length > 0) {
    args.push('--vlm-endpoint', request.endpointUrl.trim());
  }
  if (request.readingsPath) args.push('--readings', request.readingsPath);
  if (request.skipPages && request.skipPages.trim().length > 0) {
    args.push('--skip-pages', request.skipPages.trim());
  }
  if (request.chaptersPath) args.push('--chapters', request.chaptersPath);
  return args;
}

async function pump(): Promise<void> {
  if (running !== null) return;
  const next = jobs.find((job) => job.state === 'queued');
  if (!next) return;
  const request = requests.get(next.id);
  if (!request) {
    next.state = 'failed';
    next.error = 'The job lost its configuration before it started.';
    changed();
    void pump();
    return;
  }

  next.state = 'running';
  next.startedAt = Date.now();
  next.message = `Starting ${path.basename(next.inputPath)}…`;
  changed();

  const handle = runEngine(argsFor(request), (line) => {
    next.message = line;
    const progress = parseProgressLine(line);
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
  running = { id: next.id, handle };

  const result = await handle.done;
  running = null;
  next.finishedAt = Date.now();

  if (result.code === 0) {
    next.state = 'done';
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
  }
  changed();
  void pump();
}
