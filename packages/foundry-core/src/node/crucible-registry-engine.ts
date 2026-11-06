/**
 * crucible-registry-engine — following an orchestrator to its engine, once, and remembering the answer.
 */
import { CrucibleClient, engineOf, type EngineOwner, type EngineRef } from '@crucible/client';
import { clampCrucibleUrl, type CrucibleServerEntry } from './app-settings';
import { clientFor } from './crucible-registry-client';
import type { ClientOptions } from './crucible-registry-client';
import { crucibleServers } from './crucible-registry-read';

// ─────────────────────────────────────────────────────────────────────────────
// An orchestrator is not an engine — crucible docs/PHASE17-ORCHESTRATOR.md §6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT A REGISTERED ADDRESS TURNED OUT TO BE, once the relation was read.
 *
 * `entry` is the entry as the ENGINE is addressed: the same name and the SAME
 * TOKEN (§6: *"follow `engine.url` ONCE, with the SAME token"*), with the
 * engine's url in place of the registered one. `hop` is null when the
 * registered address IS the engine, which is every machine that predates Phase
 * 17 and every machine that never grew a tray.
 */
export interface EngineTarget {
  readonly entry: CrucibleServerEntry;
  readonly hop: EngineHop | null;
}

/** The orchestrator that was in front of the engine, for a sentence. */
export interface EngineHop {
  /** What the person actually registered. `crucible:open` still opens THIS. */
  readonly orchestratorUrl: string;
  /** `info().server.name` of the orchestrator — `crucible-orchestrator@example-pc`. */
  readonly orchestratorName: string;
  /** PHASE17 §3.2's `engine` ref, as it arrived. `name` is null when it could not be read. */
  readonly engineName: string | null;
  readonly engineUrl: string;
  readonly engineBackend: string | null;
  /** Who runs that engine, or null where the orchestrator did not say. */
  readonly engineOwner: EngineOwner | null;
}

/**
 * THE TWO WAYS A HOP CANNOT BE FOLLOWED, each with the relation's own name on it.
 *
 * Neither is a fault of this app's and neither is a server that is merely busy,
 * so neither may wear the SDK's sentence for something else. They are refusals
 * a PERSON fixes — install an engine on that machine, or point the entry at one
 * — which is why `crucible-dispatch.ts` reads them as STANDING waits: nothing
 * the queue does on a timer will change either answer.
 *
 *   `orchestrator_has_no_engine` — §6, verbatim: *"A machine whose orchestrator
 *     has no engine has nothing to ask; that is a fact to show a person, next to
 *     the button that installs one."* The SDK's `engineOf` throws a
 *     `CrucibleProtocolError` for this; it is caught and re-thrown here, because
 *     a protocol error means "the document is malformed" everywhere else in this
 *     app and this document is not — it is a correct document about an empty
 *     machine.
 *   `orchestrator_engine_is_not_an_engine` — §6's *"Once, and never a chain."*
 *     The second document's `role` is CHECKED and anything but `engine` is
 *     refused rather than followed. A client that followed it would loop.
 */
export class CrucibleOrchestratorError extends Error {
  readonly code: 'orchestrator_has_no_engine' | 'orchestrator_engine_is_not_an_engine';

  constructor(
    code: 'orchestrator_has_no_engine' | 'orchestrator_engine_is_not_an_engine',
    message: string,
  ) {
    super(message);
    this.name = 'CrucibleOrchestratorError';
    this.code = code;
  }
}

/**
 * How long a resolved hop is believed. `crucible-provider.ts`'s clock and its
 * argument, one question along: the fact moves — a tray is installed, an engine
 * is moved into WSL, `crucible install` finishes — but a window this short
 * cannot be the thing that makes a placement wrong for long, and a resolution
 * per capability read would put an extra round trip in front of every one.
 */
export const HOP_CACHE_MS = 60_000;

export interface HopEntry {
  at: number;
  target: EngineTarget;
}

/**
 * ONE RESOLUTION PER REGISTRY ENTRY, keyed by the two fields that decide it.
 *
 * The NAME is not enough — a person who re-points an entry at a different
 * machine has changed the answer and kept the name — and the TOKEN is not in
 * the key, because a token that changed cannot change which of two processes
 * answers an address, and a secret is not a map key in this process on the rule
 * this module's header states.
 */
export const hops = new Map<string, HopEntry>();

/** In flight, so two placements racing on one server make one round of requests. */
export const hopsInFlight = new Map<string, Promise<EngineTarget>>();

/**
 * THE ENTRIES THAT TURNED OUT TO BE AN ORCHESTRATOR WITH NOTHING BEHIND THEM —
 * the negative half of the resolution, kept so the SLOT LIST can read it without
 * asking anybody anything.
 *
 * Keyed and clocked exactly as {@link hops} is (`hopKey`, {@link HOP_CACHE_MS}),
 * because it is the same fact with the opposite sign and a person fixes it the
 * same way — `crucible install` on that machine, or re-pointing the entry — after
 * which the next resolution overwrites it.
 *
 * ONLY `orchestrator_has_no_engine` IS REMEMBERED HERE. A machine that is
 * unreachable is asleep, not engineless, and hiding its slot would take a lane
 * away from somebody whose Mac is shut; a chained orchestrator
 * (`orchestrator_engine_is_not_an_engine`) is a misconfiguration the placement
 * already refuses with a sentence naming both addresses, and a person needs to
 * see that slot in the picker to understand which entry they must re-point.
 */
export const engineless = new Map<string, { at: number; sentence: string }>();

/**
 * IS THIS ENTRY KNOWN TO HAVE NO ENGINE BEHIND IT — the refusal's own sentence,
 * or null for "no" and for "nobody has asked yet".
 *
 * SYNCHRONOUS, AND A CACHE READ AND NOTHING ELSE — `crucible-provider.ts`'s
 * posture, for its reason: the readers are the slot list and the dispatcher's
 * pinned branch, both of which run on every pump pass and behind every picker,
 * and neither may put a network hop behind a lane. An unfilled cache answers null
 * so an unprobed machine keeps its lane; the two states are told apart nowhere in
 * this app because the answer to both is the same one.
 */
export function engineAbsence(entry: CrucibleServerEntry): string | null {
  const known = engineless.get(hopKey(entry));
  if (known === undefined || Date.now() - known.at >= HOP_CACHE_MS) return null;
  return known.sentence;
}

/**
 * WHERE THIS ENTRY'S WORK ACTUALLY LANDS — the engine's address, or null for
 * "nobody has resolved this one yet".
 *
 * Owen, 2026-09-15, on the Windows tray: *"the windows crucible instance should
 * act as a passthrough for the WSL crucible. all settings and calls should
 * arrive at the WSL crucible. it's just a passthrough to the real engine."* So
 * an entry pointing at an orchestrator is not a machine of its own — it is a
 * second doorway onto one — and the address below is the machine, whichever
 * doorway was registered.
 *
 * SYNCHRONOUS AND A CACHE READ AND NOTHING ELSE, exactly as {@link
 * engineAbsence} is and for the same reason: the reader is the slot list, which
 * runs behind every picker and on every pump pass. An unresolved entry answers
 * null and {@link slotsFrom} keeps its lane — this app never hides a machine on
 * the strength of not having asked.
 */
export function resolvedEngineAddress(entry: CrucibleServerEntry): string | null {
  const cached = hops.get(hopKey(entry));
  if (cached === undefined || Date.now() - cached.at >= HOP_CACHE_MS) return null;
  return cached.target.hop?.engineUrl ?? cached.target.entry.url;
}

/**
 * Every ENABLED entry currently known to have no engine behind it — for the two
 * sentences that have to name them: a pinned row whose one server is in this
 * state, and the refusal a board with no slots at all gives.
 */
export function enginelessServers(): { name: string; sentence: string }[] {
  const out: { name: string; sentence: string }[] = [];
  for (const entry of crucibleServers()) {
    if (!entry.enabled) continue;
    const sentence = engineAbsence(entry);
    if (sentence !== null) out.push({ name: entry.name, sentence });
  }
  return out;
}

export function hopKey(entry: CrucibleServerEntry): string {
  return `${entry.name.toLowerCase()}\u0000${entry.url}`;
}

/**
 * FORGET EVERY RESOLVED HOP — called from `afterRegistryChanged()` (ipc.ts),
 * beside `forgetCrucibleFacts()` and for the same reason it is called there.
 *
 * A deliberate registry change is the one moment a stale answer reads as the app
 * ignoring somebody: re-pointing an entry from the orchestrator to the engine,
 * or the other way, must take effect on the next press and not a minute later.
 * There is no synchronous reader of this cache to mislead — every caller is
 * already inside an `await` — which is the one way it is simpler than the
 * capability cache it is modelled on.
 */
export function forgetEngineTargets(): void {
  hops.clear();
  /*
   * AND THE NEGATIVE HALF WITH IT. An entry that answered "no engine" is one
   * whose slot this app is hiding; somebody who has just pressed Save on the
   * Servers card — after installing the engine, or after re-pointing the row —
   * must get that slot back on the next read rather than a minute later.
   */
  engineless.clear();
}

/**
 * FOLLOW THE RELATION, ONCE — crucible docs/PHASE17-ORCHESTRATOR.md §6.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * Because on Owen's own PC there are two Crucible processes and only one of them
 * can do any work: the tray ORCHESTRATOR answers `127.0.0.1:7101` and the WSL
 * ENGINE answers `127.0.0.1:7100`. A person who pastes the orchestrator's
 * connect code, or whose pairing file names it, would otherwise have this app
 * talking to a process with `job_types: []` — every capability class reading as
 * unavailable and every placement failing or parking, on a machine with a
 * working 4090 in it.
 *
 * ── The rule, which is `engineOf`'s and is not re-derived here ─────────────
 *
 *   * `role: 'engine'` — and a pre-Phase-17 document, which the SDK reads as
 *     one by its VINTAGE (§3.3's all-or-nothing rule, the same one `route`
 *     gets) — resolves to the entry unchanged. You are already there.
 *   * `role: 'orchestrator'` with an engine → the engine's url, the SAME token,
 *     and the second document's `role` checked before anything is sent to it.
 *   * `role: 'orchestrator'` with no engine → refused by name.
 *
 * ── ONCE, AND NEVER A CHAIN ────────────────────────────────────────────────
 *
 * The second `info()` is the whole of the chain check and is not an extra cost
 * anybody pays twice: it is made only on the orchestrator branch, and the
 * answer is cached for {@link HOP_CACHE_MS}. An orchestrator whose `engine.url`
 * names another orchestrator is a misconfigured machine, and a client that
 * followed it would loop.
 *
 * NOTHING HERE IS LOGGED. The address of a hop is not a secret but the token
 * carried across it is, and a line that names one server "through" another is a
 * line that gets pasted into a bug report beside the rest of the console.
 */
export async function resolveEngine(
  entry: CrucibleServerEntry,
  options: ClientOptions = {},
): Promise<EngineTarget> {
  const key = hopKey(entry);
  const cached = hops.get(key);
  if (cached !== undefined && Date.now() - cached.at < HOP_CACHE_MS) {
    /*
     * THE TOKEN IS TAKEN FROM THE ENTRY IN HAND, never from the cached copy. A
     * registry save that only rotated a token does not move the hop (see
     * `hopKey`), so the cached url is still right and the cached secret is the
     * old one — and a stale token is exactly the 401 nobody can explain.
     */
    return withToken(cached.target, entry.token);
  }
  const running = hopsInFlight.get(key);
  if (running !== undefined) return withToken(await running, entry.token);
  const attempt = resolveOnce(entry, options).finally(() => { hopsInFlight.delete(key); });
  hopsInFlight.set(key, attempt);
  let target: EngineTarget;
  try {
    target = await attempt;
  } catch (err) {
    /*
     * THE ONE FAILURE THAT IS REMEMBERED — see {@link engineless}. It is written
     * here rather than in `resolveOnce` because this is the function that owns
     * the cache and its clock, and a second writer of one cache is how a fact
     * gets a different lifetime depending on which caller found it.
     */
    if (err instanceof CrucibleOrchestratorError && err.code === 'orchestrator_has_no_engine') {
      engineless.set(key, { at: Date.now(), sentence: err.message });
    }
    throw err;
  }
  /*
   * A RESOLUTION IS THE ANSWER TO THE OPPOSITE QUESTION TOO: an entry that has
   * just named its engine is not an entry with none, whatever it said a minute
   * ago, and leaving the old fact to expire would hide a working slot for the
   * rest of the window.
   */
  engineless.delete(key);
  hops.set(key, { at: Date.now(), target });
  return target;
}

export function withToken(target: EngineTarget, token: string): EngineTarget {
  return target.entry.token === token
    ? target
    : { ...target, entry: { ...target.entry, token } };
}

export async function resolveOnce(
  entry: CrucibleServerEntry,
  options: ClientOptions,
): Promise<EngineTarget> {
  const here = await clientFor(entry, options).info();
  /*
   * `engineOf` IS THE RULE AND IS THE SDK'S. Foundry does not re-implement it,
   * for the reason the contract states in §6: *"the SDK's rule, written once so
   * both apps read it the same way."* A second reading here is how Foundry and
   * BookForge start disagreeing about which of two processes on one machine is
   * the one that does the work.
   */
  let ref: EngineRef | null;
  try {
    ref = engineOf(here);
  } catch (err) {
    /*
     * THE SDK'S OWN SENTENCE IS DELIBERATELY NOT APPENDED. `engineOf` raises a
     * `CrucibleProtocolError`, whose wrapper reads *"crucible sent something API
     * v1 does not describe"* — and this document describes itself perfectly. It
     * is a correct answer about an empty machine, and printing that wrapper
     * beside it would send somebody looking for a malformed document.
     */
    void err;
    throw new CrucibleOrchestratorError(
      'orchestrator_has_no_engine',
      `${entry.url} is an orchestrator (${here.server.name}) and manages no engine, so there is `
      + 'nothing there to send work to — install one from its console, or point this entry at a '
      + 'machine that has one.',
    );
  }
  if (ref === null) return { entry, hop: null };

  const url = clampCrucibleUrl(ref.url);
  if (url === null) {
    throw new CrucibleOrchestratorError(
      'orchestrator_engine_is_not_an_engine',
      `${entry.url} is an orchestrator and named its engine as "${ref.url}", which is not an `
      + 'address this app can reach.',
    );
  }
  const engine: CrucibleServerEntry = { ...entry, url };
  /*
   * §6: *"the second document's `role` is checked and anything but `engine` is
   * refused rather than followed."* Read BEFORE anything else is asked of it,
   * so that a machine chained to a second orchestrator is refused rather than
   * having a capability read made against a process that serves none.
   */
  const there = await clientFor(engine, options).info();
  if (there.role !== 'engine') {
    throw new CrucibleOrchestratorError(
      'orchestrator_engine_is_not_an_engine',
      `${entry.url} is an orchestrator whose engine address (${url}) is itself an orchestrator `
      + `(${there.server.name}). An app follows one hop and no more — point this entry at the `
      + 'engine directly.',
    );
  }
  return {
    entry: engine,
    hop: {
      orchestratorUrl: entry.url,
      orchestratorName: here.server.name,
      engineName: ref.name ?? there.server.name,
      engineUrl: url,
      engineBackend: ref.backend ?? there.host.backend,
      engineOwner: ref.owner,
    },
  };
}

/**
 * A CLIENT FOR THE ENGINE BEHIND ONE REGISTRY ENTRY — what everything that does
 * work asks for.
 *
 * {@link clientFor} plus {@link resolveEngine}, in the one function, so that no
 * caller has to remember the pair. Callers that also need the engine's ADDRESS
 * (the placement composes `<url>/openai`, and the header map carries the token
 * for it) take {@link resolveEngine} directly and build the client from
 * `target.entry` — one resolution, one address, no chance of a request going to
 * the engine and a URL being composed from the orchestrator.
 */
export async function engineClientFor(
  entry: CrucibleServerEntry,
  options: ClientOptions = {},
): Promise<CrucibleClient> {
  return clientFor((await resolveEngine(entry, options)).entry, options);
}
