/**
 * crucible-coordinate-task — reading a running task, posting the module, and following a task to its end.
 */
import { CrucibleAuthError, CrucibleCapabilityUndecided, CrucibleNotACrucible, CrucibleProtocolError, CrucibleRefused, CrucibleUnreachable, CrucibleVersionError } from '@crucible/client';
import { CrucibleOrchestratorError, crucibleServerNamed, engineClientFor } from './crucible-registry';
import type { CrucibleModuleProgress } from '../shared/coordinate-wire';
import { foundryModuleForBackend } from './crucible-coordinate-module';

/** The id of whatever task is running on this server, or null. */
export async function runningTaskId(server: string): Promise<string | null> {
  const entry = crucibleServerNamed(server);
  if (entry === null) return null;
  const tasks = await (await engineClientFor(entry)).tasks();
  const running = tasks.find((task) => task.state === 'running');
  return running === undefined ? null : running.taskId;
}

/**
 * Why a read did not happen, in the SDK's own words with the server named.
 *
 * Each of these is a different fix — nothing there, something else there, the
 * wrong token, the wrong API — and flattening them would be the thing
 * `probeEntry`'s named catch exists to prevent, one module along.
 */
export function describeRead(err: unknown, server: string): string {
  if (err instanceof CrucibleUnreachable) return `"${server}" did not answer: ${err.message}`;
  if (err instanceof CrucibleNotACrucible) return `"${server}" answered, but it is not a Crucible: ${err.message}`;
  if (err instanceof CrucibleAuthError) return `"${server}" refused this machine's token: ${err.message}`;
  if (err instanceof CrucibleVersionError) return `"${server}" speaks a different API version: ${err.message}`;
  if (err instanceof CrucibleRefused) return `"${server}" refused ${err.code}: ${err.message}`;
  /*
   * THE TWO THE CAPABILITY READ ADDED, each named rather than flattened into the
   * sentence below. `capability_undecided` is a thing somebody can go and fix
   * with one command, and a protocol error is a document defect on that machine
   * — neither is "it did not answer", and neither is a fault of Foundry's.
   */
  if (err instanceof CrucibleCapabilityUndecided) {
    return `"${server}" has not measured its card yet — run \`crucible capability --write\` there.`;
  }
  if (err instanceof CrucibleProtocolError) {
    return `"${server}" answered with a document this build cannot read: ${err.detail}`;
  }
  /*
   * PHASE17 §6's two, named rather than flattened for this function's own
   * reason: an orchestrator with no engine is not "it did not answer" — it
   * answered perfectly, about a machine with nothing on it — and the fix is a
   * button on that machine's console rather than anything to do with a token or
   * a network.
   */
  if (err instanceof CrucibleOrchestratorError) return `"${server}": ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// The two mechanical halves: posting the module, and following a module task
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post the module. Answers the task id; THROWS every refusal untranslated.
 *
 * The refusal is not described here on purpose: {@link prepare} discriminates
 * `task_busy` (follow the other one) and a refusal about the request (fail
 * once by name), and each of those is a different act. A function that
 * flattened them into an `Error` would force the caller to
 * read the sentence back out of it.
 */
export async function postFoundryModule(server: string): Promise<string> {
  const entry = crucibleServerNamed(server);
  if (entry === null) throw new Error(`There is no server called "${server}".`);
  const client = await engineClientFor(entry);
  const capability = await client.capability();
  return client.submitTask({ type: 'module', module: foundryModuleForBackend(capability.backendKind) });
}

/**
 * Follow a module task to its end, one frame per event.
 *
 * Resolves when the task reaches a terminal state, with the state it reached —
 * it does NOT throw on `failed`. A failed module is a thing a screen draws (the
 * step that failed, the code, the message), not an exception it has to
 * reconstruct one from.
 *
 * The task id may be ours or somebody else's: a Crucible runs one task at a
 * time, so the module we would have posted and the task already running are
 * competing for the same slot, and joining the stream of the one in progress is
 * strictly better than queueing a second (PHASE13 §3.3 has no queue for tasks).
 *
 * ── AND ONE READ AFTER THE STREAM, FOR `unmet` ─────────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a puts the classes this engine does not
 * serve on the TASK DOCUMENT (`TaskStatus.unmet`) and on no frame of its stream,
 * so it cannot be taken off the terminal event — `done`'s data is an open record
 * and the SDK types it as one. `GET /v1/tasks/{id}` once, after the last frame,
 * is the whole cost, and it is the server's own answer rather than the
 * prediction this app made from the same capability record a moment earlier.
 *
 * IT DOES NOT FAIL THE FOLLOW. A task that ran to `done` and then could not be
 * re-read is a task that ran to `done`; turning that into a failure would report
 * a successful install as broken because a laptop lid closed a second later.
 * `unmet` stays null in that case, which is exactly what it means — nobody said.
 */
/**
 * FOLLOW A TASK TO ITS END, reporting as it goes — and it is EVERY task's loop,
 * not the module's.
 *
 * Exported and renamed on 2026-09-16, when the model panel needed to watch a
 * `pull`. The loop never knew which task it was following: it switches on the
 * SDK's event kinds (`started`, `step`, `progress`, `skipped`, `done`,
 * `failed`, `cancelled`), which are the same frames for a pull, an install and
 * a module. Writing a second copy for pulls would have been two readers of one
 * event vocabulary, drifting the first time the server adds a frame.
 *
 * TWO FIELDS ARE MODULE-SHAPED AND STAY NULL FOR A PULL, which costs nothing
 * and is already handled: `jobTypes` arrives only on a module's `reload` step,
 * and `unmet` is read from the finished task, where a pull's is empty by the
 * contract's own rule (*"EMPTY and never absent, on every task type"*).
 */
export async function followTask(
  server: string,
  taskId: string,
  onProgress: (progress: CrucibleModuleProgress) => void,
): Promise<CrucibleModuleProgress> {
  let last: CrucibleModuleProgress = {
    server,
    taskId,
    state: 'running',
    step: null,
    line: null,
    bytes: null,
    skipped: null,
    jobTypes: null,
    error: null,
    unmet: null,
  };
  onProgress(last);

  const entry = crucibleServerNamed(server);
  if (entry === null) return last;

  for await (const event of (await engineClientFor(entry)).taskEvents(taskId)) {
    switch (event.event) {
      case 'started':
        last = { ...last, state: 'running' };
        break;
      case 'step':
        last = {
          ...last,
          state: 'running',
          step: { name: event.data.name, index: event.data.index, total: event.data.total },
          // The `reload` step carries what became reachable, so a client is TOLD
          // rather than having to diff two /v1/info reads (§3.4).
          jobTypes: event.data.jobTypes === undefined ? last.jobTypes : [...event.data.jobTypes],
          line: null,
          bytes: null,
          skipped: null,
        };
        break;
      case 'progress':
        // An install's line is pip's own text and is NOT load-bearing (R4); a
        // pull's counts are. They are separate fields for that reason, rather
        // than one "message" a row would have to guess the meaning of.
        last = 'line' in event.data
          ? { ...last, line: event.data.line, bytes: null }
          : {
              ...last,
              line: null,
              bytes: {
                done: event.data.bytesDone,
                total: event.data.bytesTotal,
                file: event.data.file,
              },
            };
        break;
      case 'skipped':
        last = { ...last, skipped: event.data.reason };
        break;
      case 'done':
        last = { ...last, state: 'done', line: null, bytes: null, error: null };
        break;
      case 'failed':
        // R6: the steps that completed STAY — the envs and the weights are on
        // disk. The row says which step, and the next connect skips everything
        // that is already true.
        last = {
          ...last,
          state: 'failed',
          error: { code: event.data.code, message: event.data.message },
        };
        break;
      case 'cancelled':
        last = { ...last, state: 'cancelled' };
        break;
      default:
        // An event kind this build has never heard of. The SDK yields it rather
        // than throwing, for the reason it says: losing the whole stream over
        // one frame is worse than ignoring the frame.
        break;
    }
    onProgress(last);
  }

  try {
    const status = await (await engineClientFor(entry)).task(taskId);
    last = {
      ...last,
      unmet: status.unmet.map((need) => ({ class: need.class, reason: need.reason })),
    };
    onProgress(last);
  } catch (err) {
    /*
     * SWALLOWED, AND `unmet` STAYS NULL. See the note above: the stream already
     * said what happened to the work, and a re-read that did not land is a
     * question nobody answered rather than a task that went wrong. Nothing is
     * logged with the error's message in it, for this file's own rule about what
     * an authenticated route may echo.
     */
    void err;
  }
  return last;
}
