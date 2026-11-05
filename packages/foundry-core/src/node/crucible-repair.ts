/**
 * crucible-repair — the repair door, and asking whether this machine has a Crucible.
 *
 * ── TWO ROADS, ONE ANSWER ─────────────────────────────────────────────────────
 *
 * This machine's Crucible goes through `repair()` in the bootstrapper, because a
 * server that will not answer cannot repair itself. A server elsewhere has only
 * its own `repair` task. Both answer a `RepairResult`. A local Check only takes
 * the bootstrapper's road too: it is read-only there, and it can say that the
 * server is down, which a question to that server could not.
 *
 * ── STOP ──────────────────────────────────────────────────────────────────────
 *
 * Both roads end in one server task, and `cancelTask` is how it stops. The
 * bootstrapper does not hand its task id out, so the client it is given is
 * wrapped to catch it. A press before the task exists is held and applied the
 * moment it does.
 */
import {
  BootstrapRefusal,
  detectHost,
  hostInstalled,
  processRunner,
  readLocalConfig,
  repair as bootstrapRepair,
  type RepairOptions,
  type RepairClient,
} from '@crucible/bootstrap';
import { CrucibleClient, CrucibleRefused, type RepairScope, type RepairResult, type TaskRepairData } from '@crucible/client';

import { readAppSettings } from './app-settings';
import { pairingFileRead } from './crucible-pairing';
import { crucibleServers, engineClientFor } from './crucible-registry';
import { hosted } from './host';
import { repairKey, type RepairOutcome, type RepairState } from '../shared/crucible-repair-wire';
import { isLoopbackUrl, type LocalCruciblePresence } from '../shared/slots';

/** A hash reports per read; a screen needs a handful of these a second. */
const PROGRESS_EVERY_MS = 250;

/** The calls this door makes of a server: the bootstrapper's three, and stopping. */
export type StoppableClient = RepairClient & { cancelTask(taskId: string): Promise<unknown> };

export interface RepairDeps {
  repair: typeof bootstrapRepair;
  /** The client for a registered server, by name; undefined when there is no such row. */
  clientForServer(name: string): Promise<StoppableClient | undefined>;
  /** The client the bootstrapper's own road speaks through. */
  localClient(given: { url: string; token: string; clientName: string }): StoppableClient;
  now(): number;
}

const realDeps: RepairDeps = {
  repair: bootstrapRepair,
  async clientForServer(name) {
    const entry = crucibleServers().find((one) => one.name === name);
    if (entry === undefined) return undefined;
    return await engineClientFor(entry) as unknown as StoppableClient;
  },
  localClient: (given) => new CrucibleClient(given) as unknown as StoppableClient,
  now: () => Date.now(),
};

/** win32: the distro this machine's Crucible lives in, when the settings name one. A `crucible` distro still wins. */
function localTarget(): { distro?: string } {
  const distro = readAppSettings().wslDistro;
  return distro.length > 0 ? { distro } : {};
}

function isThisMachine(name: string | null): boolean {
  if (name === null) return true;
  const entry = crucibleServers().find((one) => one.name === name);
  return entry !== undefined && isLoopbackUrl(entry.url);
}

/**
 * THE THREE WAYS A SERVER WITHOUT THE TASK SAYS SO. An unknown type, by code or
 * in words, and the one read off a real 2.0.34: `400 invalid_request`, *"body.scope:
 * Extra inputs are not permitted"*, because its task request has no `scope` field.
 */
function isOldServer(error: CrucibleRefused): boolean {
  const said = `${error.code} ${error.serverMessage}`;
  return error.code === 'invalid_task'
    || /unknown task type/i.test(said)
    || (error.code === 'invalid_request' && /body\.(scope|type)\b/.test(error.serverMessage));
}

/** Why it refused, in a sentence, with an old server called what it is. */
export function repairRefusal(error: unknown): RepairOutcome {
  if (error instanceof CrucibleRefused) {
    if (isOldServer(error)) {
      return {
        outcome: 'refused', code: error.code, needsUpdate: true, reinstall: false,
        message: 'This server needs updating before it can check or repair itself. Its version has no repair task.',
      };
    }
    if (error.code === 'task_busy') {
      return {
        outcome: 'refused', code: error.code, needsUpdate: false, reinstall: false,
        message: `This server is busy with another task, so nothing was checked. It said: ${error.serverMessage}`,
      };
    }
    return { outcome: 'refused', code: error.code, needsUpdate: false, reinstall: false, message: error.serverMessage };
  }
  if (error instanceof BootstrapRefusal) {
    return {
      outcome: 'refused', code: error.code, needsUpdate: false,
      reinstall: error.code === 'server_unrepairable', message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { outcome: 'refused', code: 'failed', needsUpdate: false, reinstall: false, message };
}

const subjectWords = (subject: { kind: string; id: string } | null): string =>
  subject === null ? '' : `${subject.kind} ${subject.id}`;

/** One `repair` frame folded in. */
function foldFrame(state: RepairState, frame: TaskRepairData): RepairState {
  const subject = subjectWords(frame.subject);
  const next: RepairState = {
    ...state,
    step: frame.step,
    waitingFor: frame.step === 'wait' && frame.state === 'running' ? (subject || frame.detail || 'something in use') : null,
    doing: [frame.step, subject, frame.detail].filter((part) => part !== null && part !== '').join(': '),
  };
  if (frame.step === 'plan' && frame.bytesToCheck !== null) next.bytesToCheck = frame.bytesToCheck;
  return next;
}

/** Follow a task on a server elsewhere: the only road it has. */
async function runTask(
  client: RepairClient,
  scope: RepairScope,
  onFrame: (frame: TaskRepairData) => void,
  onProgress: (progress: { bytesDone: number; bytesTotal: number | null; file: string }) => void,
): Promise<RepairOutcome> {
  const taskId = await client.submitTask({ type: 'repair', scope });
  for await (const event of client.taskEvents(taskId)) {
    if (event.event === 'repair') onFrame(event.data);
    if (event.event === 'progress' && 'bytesDone' in event.data) onProgress(event.data);
  }
  const finished = await client.task(taskId);
  if (finished.state !== 'done' || finished.result === null) {
    const said = finished.error === null ? finished.state : `${finished.error.code}: ${finished.error.message}`;
    return {
      outcome: 'refused', code: 'repair_failed', needsUpdate: false, reinstall: false,
      message: `The repair ended ${finished.state} without an answer: ${said}`,
    };
  }
  return { outcome: 'finished', result: finished.result as RepairResult, server: null, service: null };
}

/** What a stop can reach: a press is held until there is a task to apply it to. */
interface Running {
  client: StoppableClient | null;
  taskId: string | null;
  stopping: boolean;
}

/** A client that remembers which task it started, and stops it if a press already came. */
function tracked(client: StoppableClient, running: Running): StoppableClient {
  return {
    async submitTask(request) {
      const taskId = await client.submitTask(request);
      running.client = client;
      running.taskId = taskId;
      if (running.stopping) void client.cancelTask(taskId).catch(() => undefined);
      return taskId;
    },
    taskEvents: (taskId) => client.taskEvents(taskId),
    task: (taskId) => client.task(taskId),
    cancelTask: (taskId) => client.cancelTask(taskId),
  };
}

/** The door: one repair per target, its state held here so a page that comes back can ask. */
export function crucibleRepairDoor(deps: RepairDeps = realDeps) {
  const states = new Map<string, RepairState>();
  const runs = new Map<string, Running>();
  const listeners = new Set<(state: RepairState) => void>();
  const publish = (state: RepairState): void => {
    states.set(repairKey(state.server), state);
    for (const listener of listeners) listener(state);
  };

  return {
    watch(listener: (state: RepairState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    states: (): RepairState[] => [...states.values()],
    /** Ask a running repair to stop. It says so in its state; the task ends when the server sees the flag. */
    async stop(server: string | null): Promise<void> {
      const key = repairKey(server);
      const running = runs.get(key);
      const state = states.get(key);
      if (running === undefined || state === undefined || !state.running || running.stopping) return;
      running.stopping = true;
      publish({ ...state, stopping: true });
      if (running.client !== null && running.taskId !== null) {
        await running.client.cancelTask(running.taskId).catch(() => undefined);
      }
    },
    async run(server: string | null, verifyOnly: boolean): Promise<RepairState> {
      const blank: RepairState = {
        server, verifyOnly, running: true, stopping: false, step: null, doing: null, waitingFor: null,
        bytesToCheck: null, bytesDone: null, bytesTotal: null, file: null, outcome: null,
      };
      if (hosted()) {
        return {
          ...blank,
          running: false,
          outcome: {
            outcome: 'refused', code: 'hosted', needsUpdate: false, reinstall: false,
            message: 'Repairing Crucible belongs to the host application.',
          },
        };
      }
      const key = repairKey(server);
      const already = states.get(key);
      if (already?.running) return already;

      const running: Running = { client: null, taskId: null, stopping: false };
      runs.set(key, running);
      let state = blank;
      publish(state);
      let lastProgress = 0;
      const merge = (patch: Partial<RepairState>): void => {
        state = { ...(states.get(key) ?? state), ...patch };
      };
      const onFrame = (frame: TaskRepairData): void => {
        state = foldFrame(states.get(key) ?? state, frame);
        publish(state);
      };
      const onProgress = (progress: { bytesDone: number; bytesTotal: number | null; file: string }): void => {
        merge({ bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal, file: progress.file });
        const now = deps.now();
        if (now - lastProgress < PROGRESS_EVERY_MS) return;
        lastProgress = now;
        publish(state);
      };
      const scope: RepairScope = verifyOnly ? { verifyOnly: true } : {};

      let outcome: RepairOutcome;
      try {
        if (isThisMachine(server)) {
          const options: RepairOptions = {
            ...localTarget(),
            scope,
            onStep: (step) => {
              merge({ step: step.name, doing: [step.name, step.detail].filter(Boolean).join(': ') });
              publish(state);
            },
            onRepair: onFrame,
            onProgress,
            clientFactory: (given) => tracked(deps.localClient(given), running),
          };
          const local = await deps.repair(options);
          outcome = local.task === null
            ? { outcome: 'not-asked', server: local.server, service: local.service, detail: local.detail ?? '' }
            : { outcome: 'finished', result: local.task as RepairResult, server: local.server, service: local.service };
        } else {
          const client = await deps.clientForServer(server as string);
          if (client === undefined) {
            outcome = {
              outcome: 'refused', code: 'no_such_server', needsUpdate: false, reinstall: false,
              message: `There is no server called ${server}. If it was just added, save first.`,
            };
          } else {
            outcome = await runTask(tracked(client, running), scope, onFrame, onProgress);
          }
        }
      } catch (error) {
        outcome = repairRefusal(error);
      }
      /* A stop that was honoured ends the task without an answer, which is what was asked for and not a failure. */
      if (running.stopping && outcome.outcome === 'refused') outcome = { outcome: 'stopped' };
      merge({ running: false, stopping: false, doing: null, waitingFor: null, outcome });
      publish(state);
      runs.delete(key);
      return state;
    },
  };
}

/**
 * IS THERE A CRUCIBLE ON THIS MACHINE? Asked before Install is offered.
 *
 * Owen: *"there should and will never be two copies installed."* The pairing
 * file alone cannot answer this: a server that has not published one, a config
 * this app cannot read and two distros each holding one are all a machine with a
 * Crucible. Install appears only on `absent`, so anything that cannot be told
 * apart from present is `unknown`, by name, and offers no Install.
 */
export async function localCruciblePresence(): Promise<LocalCruciblePresence> {
  if (hosted()) return { state: 'absent' };
  const published = await pairingFileRead().catch(() => null);
  if (published?.found === 'pairing') return { state: 'present', url: published.pairing.url, connectable: true };

  const runner = processRunner();
  const nothingHere = ['no_local_config', 'no_wsl_distro', 'wsl_missing', 'unsupported_platform'];
  /* A refusal that is not "nothing here": held, because detectHost may still see the server. */
  let couldNotTell: unknown = null;
  try {
    const config = await readLocalConfig(localTarget(), runner);
    return { state: 'present', url: config.url, connectable: false };
  } catch (error) {
    if (!(error instanceof BootstrapRefusal) || !nothingHere.includes(error.code)) couldNotTell = error;
  }
  try {
    if (hostInstalled(runner)) return { state: 'present', url: null, connectable: false };
    const facts = await detectHost(localTarget(), runner);
    if (facts.server !== null) return { state: 'present', url: null, connectable: false };
  } catch (error) {
    if (!(error instanceof BootstrapRefusal) || !nothingHere.includes(error.code)) couldNotTell ??= error;
  }
  return couldNotTell === null ? { state: 'absent' } : unknownPresence(couldNotTell);
}

function unknownPresence(error: unknown): LocalCruciblePresence {
  return {
    state: 'unknown',
    code: error instanceof BootstrapRefusal ? error.code : 'failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
