/**
 * crucible-coordinate-run — coordinating one server or all of them, and preparing Foundry for use.
 */
import { CrucibleRefused, type CatalogRow } from '@crucible/client';
import { crucibleServerNamed, crucibleServers, engineClientFor } from './crucible-registry';
import { readCapability } from './crucible-dispatch';
import type { CapabilityRecord } from '../shared/engine-settings';
import type { CrucibleCoordinationState, CrucibleMissingEntry, CrucibleModuleProgress, CrucibleUnmetClass } from '../shared/coordinate-wire';
import { modelPreparationReady } from './setup';
import { missingForFoundry } from './crucible-coordinate-missing';
import { inFlight, report, requestRefusals, states } from './crucible-coordinate-state';
import { describeRead, followTask, postFoundryModule, runningTaskId } from './crucible-coordinate-task';

// ─────────────────────────────────────────────────────────────────────────────
// The act
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make sure one server has what Foundry needs, and say where that got to.
 *
 * Idempotent, concurrent-safe, and cheap when there is nothing to do. It never
 * throws: every way this can end is a STATE, because every caller of it is a
 * moment that was doing something else (starting the app, adding a server) and
 * a Crucible that is off must not fail any of them.
 */
export function coordinateServer(server: string): Promise<CrucibleCoordinationState> {
  const running = inFlight.get(server);
  if (running !== undefined) return running;

  const run = runCoordination(server).finally(() => { inFlight.delete(server); });
  inFlight.set(server, run);
  return run;
}

/**
 * Coordinate with every ENABLED server, IN THE REGISTRY'S OWN ORDER.
 *
 * App start's moment.
 *
 * ── THE ORDER IS THE OPERATOR'S, AND THIS APP HAS NO OTHER ─────────────────
 *
 * It used to start the loopback entries first, on the reasoning that a Crucible
 * on this machine is the one that took the local GPU slot and so the one this
 * app is about to want. Owen's ruling retires that reasoning: *"a local crucible
 * server shouldnt be treated any differently than a remote crucible server. it
 * should all be entered the exact same way… it might not be local."* An address
 * is not a ranking, and `127.0.0.1` is exactly as likely to be a tunnel to
 * somebody else's card as it is to be the machine this window is drawn on.
 *
 * The registry IS a ranking, and the only one this app is entitled to: the rows
 * are in the order the person dragged them into, which is the same order
 * `computeSlots` hands to the picker and the same order the `any` walk takes
 * them in. So a sweep that asked in any other order would be this app inventing
 * a second opinion about which server matters most.
 *
 * STARTED IN ORDER, NOT AWAITED IN ORDER. A run can follow a long download, and
 * a sweep that awaited each server in turn would leave the Mac unasked until
 * the PC's download finished. The synchronous prefix of
 * {@link coordinateServer} runs before its first `await`, so iterating really
 * does put the top row's `GET /v1/info` on the wire first; after that they
 * proceed together.
 *
 * A DISABLED SERVER IS NOT ASKED AT ALL and not reported either: filtering here
 * rather than letting each run refuse itself means a registry of six switched-off
 * servers produces no rows instead of six sentences saying nothing happened.
 */
export function coordinateEveryServer(): Promise<CrucibleCoordinationState[]> {
  const enabled = crucibleServers().filter((entry) => entry.enabled);
  return Promise.all(enabled.map((entry) => coordinateServer(entry.name)));
}

/** Preparation completion includes a fresh read; a task's done event alone is insufficient. */
export async function prepareFoundryForUse(): Promise<CrucibleCoordinationState[]> {
  const states = await coordinateEveryServer();
  for (const state of states) {
    if (state.phase !== 'stocked' && !(state.phase === 'preparing' && state.progress.state === 'done')) {
      const detail = 'message' in state ? state.message : state.phase === 'preparing' ? state.progress.error?.message ?? state.progress.state : state.phase;
      throw new Error(`${state.server}: model preparation is not ready (${detail}). Check the engine and retry.`);
    }
    const entry = crucibleServerNamed(state.server);
    if (entry === null || !entry.enabled) throw new Error(`${state.server}: the engine connection changed. Retry setup.`);
    const client = await engineClientFor(entry);
    const [info, catalog, capability] = await Promise.all([client.info(), client.catalog(), readCapability(entry)]);
    const { missing } = missingForFoundry(info.capabilities.map(row => row.jobType), catalog, capability);
    if (missing.length !== 0) {
      throw new Error(`${state.server}: ${missing.length} required model or runtime item(s) are still missing. Retry preparation.`);
    }
  }
  return states;
}

export async function runCoordination(server: string): Promise<CrucibleCoordinationState> {
  if (!modelPreparationReady()) return report({ server, phase: 'awaiting-setup' });
  const entry = crucibleServerNamed(server);
  if (entry === null) {
    /*
     * A NAME THE REGISTRY HAS NEVER HEARD OF. Filed under `unreachable` for the
     * reason the disabled case below is: that phase means "Foundry did not
     * reach it, and here is why", and the message is the fact. It is the same
     * sentence `probeCrucible` answers with, because it is the same news.
     */
    return report({
      server,
      phase: 'unreachable',
      message: `There is no server called "${server}".`,
    });
  }
  if (!entry.enabled) {
    /*
     * A DISABLED SERVER IS NOT COORDINATED WITH, and it is not an error either.
     * Owen's ruling makes the enable switch the one way to say "not that one"
     * (crucible `1a10cc8`), so this says exactly that and asks the machine
     * nothing.
     */
    return report({
      server,
      phase: 'unreachable',
      message: `"${server}" is switched off in Settings, so Foundry asks it for nothing.`,
    });
  }

  const remembered = requestRefusals.get(server);
  report({ server, phase: 'checking' });

  let installedJobTypes: readonly string[];
  let catalog: readonly CatalogRow[];
  let capability: CapabilityRecord;
  try {
    /*
     * THROUGH THE ENGINE, NOT WHATEVER ADDRESS IS REGISTERED. crucible
     * docs/PHASE17-ORCHESTRATOR.md §6: a registered address may be an
     * orchestrator, and every one of the three reads below is an engine
     * question — an orchestrator's `job_types` is `[]` by definition (§3.2), it
     * has no catalog and no `/v1/capability`, and the module this file posts
     * installs weights onto a CARD. Coordinating with the orchestrator would
     * report every class as missing on a machine that serves all of them.
     */
    const client = await engineClientFor(entry);
    /*
     * THREE READS, AND THE THIRD IS §5.3a's.
     *
     * `GET /v1/capability` is read here because the module names CLASSES and the
     * engine's capability record is the one place a class becomes an id
     * (PHASE9; PHASE15-HOST.md §5.3a). Without it there is no question to ask
     * the catalog: "is the translate model installed" has a different answer on
     * every machine, and the id is that machine's to name.
     *
     * IT IS `readCapability`, THE DISPATCHER'S OWN READER, and not a fourth
     * `client.capability()` call written here. One reader of that route, one
     * mapping of its record, one place a route rule could ever have lived —
     * the dispatcher's header says why, and the placement path and this one
     * must not be able to disagree about what a server selected.
     *
     * A capability read that fails is the same `unreachable` as the other two:
     * a server that cannot answer one of these three is not answering.
     */
    const [info, rows, record] = await Promise.all([
      client.info(),
      client.catalog(),
      readCapability(entry),
    ]);
    installedJobTypes = info.capabilities.map((item) => item.jobType);
    catalog = rows;
    capability = record;
  } catch (err) {
    return report({ server, phase: 'unreachable', message: describeRead(err, server) });
  }

  const { missing, unmet } = missingForFoundry(installedJobTypes, catalog, capability);
  if (missing.length === 0) {
    /*
     * STOCKED STILL MEANS "NOTHING IS MISSING", and an engine with unmet classes
     * and nothing to download is exactly that. There is no task that could make
     * it serve `pages`, so posting one would be asking a machine to download its
     * way out of being a different machine; the classes it does not serve travel
     * on the state instead, and the row names them (§5.3a: *"the app shows 'not
     * on this engine'"*).
     */
    return report({ server, phase: 'stocked', checkedAt: new Date().toISOString(), unmet });
  }

  if (remembered !== undefined) {
    // FAILS ONCE, BY NAME. The read still happened — the row is telling the
    // truth about what is missing — but the post that would be refused the
    // same way is not made again.
    return report({ server, phase: 'refused', code: remembered.code, message: remembered.message });
  }

  return prepare(server, missing, unmet);
}

/** Post the module (or join the task already running) and follow it to the end. */
export async function prepare(
  server: string,
  missing: readonly CrucibleMissingEntry[],
  unmet: readonly CrucibleUnmetClass[],
): Promise<CrucibleCoordinationState> {
  let taskId: string;
  let followed = false;
  try {
    taskId = await postFoundryModule(server);
  } catch (err) {
    if (err instanceof CrucibleRefused && err.code === 'task_busy') {
      // FOLLOWED, NOT RE-POSTED. A Crucible has no queue for tasks, so the
      // one in flight is the only one there will be until it lands.
      const other = await runningTaskId(server);
      if (other === null) {
        /*
         * `task_busy` and then no running task in the listing: it landed in
         * the moment between the two calls. Ask again from the top — the
         * catalog read is what decides whether there is still anything to do,
         * and it may well have been that very task that did it.
         */
        return runCoordination(server);
      }
      taskId = other;
      followed = true;
    } else if (err instanceof CrucibleRefused) {
      // A refusal about the REQUEST: `invalid_module`, `unknown_subject`, or
      // any other name this build has not met. Once, and remembered.
      requestRefusals.set(server, { code: err.code, message: err.message });
      return report({ server, phase: 'refused', code: err.code, message: err.message });
    } else {
      return report({ server, phase: 'unreachable', message: describeRead(err, server) });
    }
  }

  const progress0: CrucibleModuleProgress = {
    server, taskId, state: 'running',
    step: null, line: null, bytes: null, skipped: null, jobTypes: null, error: null, unmet: null,
  };
  report({ server, phase: 'preparing', missing, unmet, progress: progress0, followed });

  const last = await followTask(server, taskId, (progress) => {
    report({ server, phase: 'preparing', missing, unmet, progress, followed });
  });
  // A shared engine may have been preparing the OTHER app's module. Its
  // success only releases the task slot; it says nothing about our demand,
  // so re-read the catalog before deciding whether a task of our own is
  // still needed. Never blindly repeat an accepted task.
  if (followed && last.state === 'done') return runCoordination(server);
  return report({ server, phase: 'preparing', missing, unmet, progress: last, followed });
}
