/**
 * THE SERVER REGISTRY, AND THE SLOT LIST DERIVED FROM IT.
 *
 * docs/SLOTS.md §3 and §6 (Package C). This module owns three things and
 * deliberately no more:
 *
 *   1. the registered Crucible servers, read out of and written into the app's
 *      own settings file, in priority order;
 *   2. `computeSlots()` — the list a picker draws and the `any` walk walks;
 *   3. the two acts that TALK to a server for a settings row: Test connection,
 *      and reading the local server's own config so an entry can be made from
 *      it without anybody copying a token by hand.
 *
 * WHAT IS NOT HERE IS THE DISPATCH. Deciding which slot a job goes to, reading
 * a capability record, making a model resident and composing the spawn is
 * `crucible-dispatch.ts` — a different question with a different shape of
 * answer. This module reads and writes; that one acts, and every act of its is
 * on a row somebody is watching.
 *
 * ── The token, and the one rule it has ──────────────────────────────────────
 *
 * It never leaves this process. It is read here, held in the settings file, and
 * handed to the SDK or to a spawn's `env`. It is not on a command line (a
 * command line is spelled into the terminal by `job-queue.ts`, pasted into bug
 * reports, and listed by the process table), it is not in an IPC payload (the
 * renderer's shape is `CrucibleServerView`, which has a boolean where this has a
 * secret), and it is in no log line, including the ones that report a failure
 * involving it.
 *
 * ── Why the word "crucible" is in this filename ─────────────────────────────
 *
 * Because it is allowed to be: the engine (`src/`) must never name a product —
 * it speaks an OpenAI dialect to whatever is on the other end and cannot tell
 * one server from another — but the APP is the operator, and an operator that
 * loads a model, reads a capability record and renders a 409 by its code is
 * talking to a Crucible specifically. Pretending otherwise here would mean a
 * module full of sentences about "the server" that only one server can answer.
 */
export { CRUCIBLE_CLIENT_NAME, crucibleClientNameFor, crucibleServers, crucibleServerNamed } from './crucible-registry-read';
export { crucibleServerViews, crucibleSettingsView, cloudSettingsView } from './crucible-registry-views';
export { writeCrucibleServers, addCrucibleServer, removeCrucibleServer } from './crucible-registry-write';
export { slotAvailability, computeSlots, engineSharedWith, waitForOfNewJob } from './crucible-registry-slots';
export { clientFor } from './crucible-registry-client';
export type { ClientOptions } from './crucible-registry-client';
export { CrucibleOrchestratorError, engineAbsence, resolvedEngineAddress, enginelessServers, forgetEngineTargets, resolveEngine, engineClientFor } from './crucible-registry-engine';
export type { EngineTarget, EngineHop } from './crucible-registry-engine';
export { probeCrucible, probeCrucibleAt, addLocalCrucible, runCommand } from './crucible-registry-probe';
export type { CommandResult } from './crucible-registry-probe';
