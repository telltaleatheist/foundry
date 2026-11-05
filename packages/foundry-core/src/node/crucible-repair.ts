/**
 * crucible-repair — the repair door, and asking whether this machine has a Crucible.
 *
 * ── TWO ROADS, ONE ANSWER ─────────────────────────────────────────────────────
 *
 * This machine's Crucible goes through `repair()` in the bootstrapper, because a
 * server that will not answer cannot repair itself. A server elsewhere has only
 * its own `repair` task. Both answer a `RepairResult`.
 *
 * ── "CHECK ONLY" TAKES THE TASK ROAD EVEN HERE ────────────────────────────────
 *
 * `repair({scope: {verifyOnly: true}})` only makes the TASK verify-only. Before
 * the task, it still puts the server's runtime back if that looks wrong and
 * starts the service if it is stopped. A button that says "Check only" cannot do
 * that, so a check always asks the running server and says so if none answers.
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
import { CrucibleRefused, type RepairScope, type RepairResult, type TaskRepairData } from '@crucible/client';

import { pairingFileRead } from './crucible-pairing';
import { clientFor, crucibleServers, engineClientFor } from './crucible-registry';
import { hosted } from './host';
import { repairKey, type RepairOutcome, type RepairState } from '../shared/crucible-repair-wire';
import { isLoopbackUrl, type LocalCruciblePresence } from '../shared/slots';

/** A hash reports per read; a screen needs a handful of these a second. */
const PROGRESS_EVERY_MS = 250;

export interface RepairDeps {
  repair: typeof bootstrapRepair;
  /** The client for a registered server, by name; undefined when there is no such row. */
  clientForServer(name: string): Promise<RepairClient | undefined>;
  /** The client for this machine's own server, from its config. */
  clientForHere(): Promise<RepairClient>;
  now(): number;
}

const realDeps: RepairDeps = {
  repair: bootstrapRepair,
  async clientForServer(name) {
    const entry = crucibleServers().find((one) => one.name === name);
    if (entry === undefined) return undefined;
    return await engineClientFor(entry) as unknown as RepairClient;
  },
  async clientForHere() {
    const config = await readLocalConfig();
    return clientFor({ name: config.name, url: config.url, token: config.token, enabled: true }) as unknown as RepairClient;
  },
  now: () => Date.now(),
};

function isThisMachine(name: string | null): boolean {
  if (name === null) return true;
  const entry = crucibleServers().find((one) => one.name === name);
  return entry !== undefined && isLoopbackUrl(entry.url);
}

/** Why it refused, in a sentence, with an old server called what it is. */
export function repairRefusal(error: unknown): RepairOutcome {
  if (error instanceof CrucibleRefused) {
    const said = `${error.code} ${error.serverMessage}`;
    if (error.code === 'invalid_task' || /unknown task type/i.test(said)) {
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
    waitingFor: frame.step === 'wait' && frame.state === 'running' ? (subject || frame.detail || 'something in use') : null,
    doing: [frame.step, subject, frame.detail].filter((part) => part !== null && part !== '').join(': '),
  };
  if (frame.step === 'plan' && frame.bytesToCheck !== null) next.bytesToCheck = frame.bytesToCheck;
  return next;
}

/** Follow a task on a server: the road a remote server has, and what Check only always takes. */
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

/** The door: one repair per target, its state held here so a page that comes back can ask. */
export function crucibleRepairDoor(deps: RepairDeps = realDeps) {
  const states = new Map<string, RepairState>();
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
    async run(server: string | null, verifyOnly: boolean): Promise<RepairState> {
      const blank: RepairState = {
        server, verifyOnly, running: true, doing: null, waitingFor: null,
        bytesToCheck: null, bytesDone: null, bytesTotal: null, file: null, outcome: null,
      };
      const ending = (outcome: RepairOutcome): RepairState => ({
        ...blank, running: false, outcome,
      });
      if (hosted()) {
        return ending({
          outcome: 'refused', code: 'hosted', needsUpdate: false, reinstall: false,
          message: 'Repairing Crucible belongs to the host application.',
        });
      }
      const already = states.get(repairKey(server));
      if (already?.running) return already;

      let state = blank;
      publish(state);
      let lastProgress = 0;
      const onFrame = (frame: TaskRepairData): void => { state = foldFrame(state, frame); publish(state); };
      const onProgress = (progress: { bytesDone: number; bytesTotal: number | null; file: string }): void => {
        state = { ...state, bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal, file: progress.file };
        const now = deps.now();
        if (now - lastProgress < PROGRESS_EVERY_MS) return;
        lastProgress = now;
        publish(state);
      };

      let outcome: RepairOutcome;
      try {
        if (!verifyOnly && isThisMachine(server)) {
          const options: RepairOptions = {
            onStep: (step) => { state = { ...state, doing: [step.name, step.detail].filter(Boolean).join(': ') }; publish(state); },
            onRepair: onFrame,
            onProgress,
          };
          const local = await deps.repair(options);
          outcome = { outcome: 'finished', result: local.task as RepairResult, server: local.server, service: local.service };
        } else {
          const client = server === null ? await deps.clientForHere() : await deps.clientForServer(server);
          if (client === undefined) {
            outcome = {
              outcome: 'refused', code: 'no_such_server', needsUpdate: false, reinstall: false,
              message: `There is no server called ${server}. If it was just added, save first.`,
            };
          } else {
            outcome = await runTask(client, verifyOnly ? { verifyOnly: true } : {}, onFrame, onProgress);
          }
        }
      } catch (error) {
        outcome = repairRefusal(error);
      }
      state = { ...state, running: false, doing: null, waitingFor: null, outcome };
      publish(state);
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
    const config = await readLocalConfig({}, runner);
    return { state: 'present', url: config.url, connectable: false };
  } catch (error) {
    if (!(error instanceof BootstrapRefusal) || !nothingHere.includes(error.code)) couldNotTell = error;
  }
  try {
    if (hostInstalled(runner)) return { state: 'present', url: null, connectable: false };
    const facts = await detectHost({}, runner);
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
