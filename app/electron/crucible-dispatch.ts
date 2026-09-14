/**
 * DISPATCH — which slot this job goes to, and what has to be true before the
 * engine is spawned against it.
 *
 * docs/SLOTS.md §5 states the rule this whole module exists to honour: **THE
 * OPERATOR LOADS, THE ENGINE NEVER DOES.** The engine speaks an OpenAI dialect
 * to whatever is at `--endpoint` and refuses by name when the model it was told
 * to use is not the one that server is holding; it has no verb for "make it
 * resident" and must not grow one, because a machine's residency is a fact about
 * a shared card and the thing spending an hour on it is not the thing that gets
 * to decide. So this app — the operator, the thing with a person in front of it
 * — reads what the server can serve, makes the model resident if it is not, and
 * only then spawns.
 *
 * ── The shape of every answer here is three-way, and that is the design ────
 *
 * A placement can be `go`, `wait` or `refuse`, and the difference between the
 * last two is the whole reason this module is not a boolean:
 *
 *   `wait`   — this is about the SERVER's state and will be different later, or
 *              on another machine. Somebody is narrating on it; the lane is
 *              taken; it is switched off; it is unreachable. The row goes back
 *              to the queue wearing the sentence, and is tried again with a
 *              backoff. Crucible does not queue — a second submission is refused
 *              rather than admitted — so the waiting is ours to own, and the SDK
 *              says so explicitly rather than hiding a retry loop nobody chose.
 *   `refuse`  — this is about the REQUEST and will be refused identically
 *              everywhere. The model is not one this server has ever heard of;
 *              the class is off. The row fails with the reason, once, rather
 *              than four times over four machines.
 *
 * `isServerSpecificRefusal` (the SDK) is what decides which, because the fact
 * has exactly one honest owner: the server that emitted the code.
 *
 * ── Never a tight poll ────────────────────────────────────────────────────
 *
 * Nothing in here loops. One pass is one answer, and the BACKOFF lives on the
 * queue side (`job-queue.ts`) where the row is, because that is where the row
 * can be drawn while it waits and where a person can take it away.
 */
import {
  CrucibleAuthError,
  CrucibleBusy,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
  isServerSpecificRefusal,
} from '@crucible/client';

import { clientFor, computeSlots, crucibleServerNamed } from './crucible-registry';
import type { CrucibleServerEntry } from './app-settings';
import { ANY_SLOT, LOCAL_SLOT_NAME, slotNamed, type ComputeSlot } from '../shared/slots';
import type { LlmServerKind } from '../shared/pipeline';
import type { JobKind } from '../shared/types';

/**
 * THE CAPABILITY CLASSES, FROZEN, spelled exactly as Crucible's `capability.py`
 * spells them. The five this app can ask for; the other four (`echo`, `asr`,
 * `rvc`, `align`) belong to somebody else's pipeline.
 *
 * `simplify` and `analysis` are separate classes from `translate` even though
 * they select the same 27B on every card anyone has, and Crucible made them
 * separate on Owen's ruling of 2026-09-13: *"they can't lie to the user and say
 * a translate job is running when it's actually a simplify job."* Folding them
 * would make a client ask about `translate` in order to learn whether it may
 * simplify — which is the old lie, one layer down.
 */
export type CapabilityClass = 'clean' | 'translate' | 'simplify' | 'analysis' | 'pages';

/**
 * THE ACT A JOB IS, as the server names it — and the value of `X-Crucible-Act`.
 *
 * The header is required on our side by Owen's naming ruling and is exactly one
 * of these five words. It is what makes a server's log say which act held the
 * card, rather than "an llm job", which is the same lie the act-prefixed log
 * lines in the engine were built to end.
 *
 * NULL FOR EVERY OTHER KIND. An export, a mint and an environment install put
 * nothing in front of a model; there is no class for them, no slot to place them
 * on, and they take the path they always took.
 */
export function capabilityClassOf(kind: JobKind): CapabilityClass | null {
  switch (kind) {
    case 'clean': return 'clean';
    case 'translate': return 'translate';
    case 'simplify': return 'simplify';
    case 'analysis': return 'analysis';
    case 'read': return 'pages';
    default: return null;
  }
}

/**
 * ── READS STAY LOCAL, AND THIS IS THE SWITCH THAT SAYS SO ──────────────────
 *
 * A page reading is a `pages`-class job and everything in this module would
 * serve one: the capability read, the residency, the header map, the walk. It is
 * WIRED AND OFF, behind this one constant, because the local page reader is
 * Package B's (docs/SLOTS.md §6) and it is being replaced in the same cycle as
 * this work. Two packages moving the same job's dispatch in one week is how a
 * reading ends up with two owners and neither of them complete.
 *
 * Turning it on is this constant plus nothing: `placeJob` already answers for
 * `read`, `capabilityClassOf` already names its class, and the spawn already
 * takes the placement. What it needs FIRST is the ruling Package B is settling —
 * whether a remote reader may be chosen at all when the local dots server is the
 * thing that works while the Mac is asleep (SLOTS.md §5b says a remote Crucible
 * removes nothing from this disk for exactly that reason).
 */
export const CRUCIBLE_READS = false;

/**
 * WHERE THIS JOB'S ENGINE WILL POINT — everything the spawn needs, and nothing
 * about the queue.
 *
 * `endpoint` and `model` are NULLABLE and null means "the request's own", which
 * is the local slot's whole answer: the Ollama URL and the model tag the person
 * chose in the dialog are on the request already, and a placement that copied
 * them here would be a second owner of a per-run choice.
 */
export interface Placement {
  slot: ComputeSlot;
  /** Which engine dialect. `openai` is the engine's default and goes unspelled. */
  door: LlmServerKind;
  /** `--endpoint`, or null to use the request's own. */
  endpoint: string | null;
  /** `--model`, or null to use the request's own. */
  model: string | null;
  /**
   * WHAT THIS SPAWN'S ENVIRONMENT GETS ON TOP OF THE PROCESS'S — the header map,
   * and the only place a token is ever attached to a job.
   *
   * `FOUNDRY_ENDPOINT_HEADERS` is a JSON object of header name to value, and it
   * is an ENVIRONMENT VARIABLE rather than a flag deliberately and permanently
   * (docs/BOOKFORGE-HANDOFF.md): a command line is spelled into the terminal by
   * the queue, pasted into bug reports, and listed by the process table. There
   * is no flag for this and there should never be one.
   *
   * EMPTY FOR THE LOCAL SLOT, which authenticates nothing.
   */
  env: Record<string, string>;
  /**
   * THE CLAIM ON THE RESIDENT MODEL, held for the length of this run.
   *
   * Null on the local slot, which shares nothing with anybody, and on every
   * placement that never touched a Crucible. Non-null placements MUST be
   * released — see {@link Lease}, which says what happens if they are not.
   */
  lease: Lease | null;
}

/** The local slot's placement — today's lines, spelled as a placement. */
function localPlacement(slot: ComputeSlot): Placement {
  return { slot, door: 'ollama', endpoint: null, model: null, env: {}, lease: null };
}

/**
 * THE PLACEMENT NOTHING PICKED — what a job takes when there is no slot list at
 * all.
 *
 * That is not an error case, it is the common one: a person with no Crucible,
 * and a hosted window whose host registers no slot provider. `computeSlots()`
 * answers with one slot or none, no picker is drawn anywhere, and this is the
 * path every job in this app took before Package C existed.
 */
export const UNPLACED: Placement = {
  slot: { name: LOCAL_SLOT_NAME, kind: 'local' },
  door: 'ollama',
  endpoint: null,
  model: null,
  env: {},
  lease: null,
};

export type PlacementOutcome =
  | { verdict: 'go'; placement: Placement }
  /** Try again later — the server's state, not the request. See the module note. */
  | { verdict: 'wait'; reason: string }
  /** This will be refused the same way everywhere. Fail the row and say so once. */
  | { verdict: 'refuse'; reason: string };

/** What a placement pass may say while it is working — one line, onto the row. */
export type PlacementProgress = (line: string) => void;

/**
 * PLACE THIS JOB.
 *
 * `waitFor` is the row's own — a slot name, {@link ANY_SLOT}, or undefined for a
 * row minted before the picker existed (or by a host that has not re-vendored),
 * which means "wherever this app would have sent it anyway".
 *
 * ── The `any` walk, and the one thing it is careful about ──────────────────
 *
 * It takes the first slot that will START the job, in rank order. A server that
 * is busy, unreachable, switched off or cannot do this act is stepped past; a
 * refusal that is about the REQUEST stops the walk immediately, because trying
 * three more machines would produce three more identical refusals and report the
 * third machine's. Nothing reachable at all is a `wait` naming every one of
 * them, because a person looking at a held row needs to know it is not one
 * server that is in the way.
 *
 * A CLOUD SLOT IS NEVER WHAT `any` FALLS THROUGH TO (docs/SLOTS.md §3). None is
 * ever constructed today; the filter is here so that the day one is, it is a
 * deliberate per-job choice and not something a walk wandered into and billed
 * somebody for.
 */
export async function placeJob(
  kind: JobKind,
  waitFor: string | undefined,
  say: PlacementProgress,
): Promise<PlacementOutcome> {
  const slots = computeSlots();
  const capability = capabilityClassOf(kind);
  /*
   * NOTHING TO DECIDE, and the three ways that happens are one answer. No
   * capability class (an export, a mint, an install — no model anywhere near
   * it); no slot list (hosted with no provider); or one slot, which is the
   * friend with a GPU and no Crucible, who never meets a picker.
   */
  if (capability === null || slots.length === 0) return { verdict: 'go', placement: UNPLACED };
  if (capability === 'pages' && !CRUCIBLE_READS) return { verdict: 'go', placement: UNPLACED };

  const pinned = waitFor !== undefined && waitFor !== ANY_SLOT ? waitFor : null;
  if (pinned !== null) {
    const slot = slotNamed(slots, pinned);
    if (slot === null) {
      /*
       * A row waiting for a slot that is not in the list — switched off, renamed
       * or removed while the row sat in the queue. It WAITS rather than fails,
       * because switching a server back on is a gesture somebody is about to
       * make and a failed row would have thrown the queue position away for a
       * toggle. The Servers card offers the other fix (reassign these rows to
       * "any") at the moment the switch is flipped, so nobody has to find this
       * sentence to learn what happened.
       */
      return {
        verdict: 'wait',
        reason: `waiting for "${pinned}", which is switched off or no longer registered`,
      };
    }
    return placeOn(slot, capability, say);
  }

  const reasons: string[] = [];
  for (const slot of slots) {
    if (slot.kind === 'cloud') continue;
    const outcome = await placeOn(slot, capability, say);
    if (outcome.verdict === 'go') return outcome;
    if (outcome.verdict === 'refuse') return outcome;
    reasons.push(outcome.reason);
  }
  return {
    verdict: 'wait',
    reason: reasons.length === 0
      ? 'no slot is available'
      : `no slot is free — ${reasons.join('; ')}`,
  };
}

/** One slot, asked whether it will start this act now. */
async function placeOn(
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
): Promise<PlacementOutcome> {
  if (slot.kind === 'local') return { verdict: 'go', placement: localPlacement(slot) };
  if (slot.kind === 'cloud') {
    /*
     * THE SEAM, AND IT REFUSES. Package F (docs/SLOTS.md §6) is cloud slots: the
     * `openai` door plus a credential in the header map, per-job opt-in, 429 as
     * the wait, cost shown. None of that is built, and a slot of this kind
     * cannot be constructed by anything in this app today — so this arm exists
     * to make the compiler name it the day somebody adds one, rather than to
     * handle a case that occurs.
     */
    return { verdict: 'refuse', reason: `"${slot.name}" is a cloud slot, and cloud slots are not built yet` };
  }
  const entry = crucibleServerNamed(slot.name);
  if (entry === null) {
    return { verdict: 'wait', reason: `"${slot.name}" is no longer registered` };
  }
  try {
    return await placeOnCrucible(entry, slot, capability, say);
  } catch (err) {
    return interpretFailure(err, slot.name, capability);
  }
}

async function placeOnCrucible(
  entry: CrucibleServerEntry,
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
): Promise<PlacementOutcome> {
  const client = clientFor(entry);

  /*
   * ── WHICH MODEL, WHICH IS THE SERVER'S ANSWER AND NOT A SETTING ───────────
   *
   * `GET /v1/capability` is a per-HOST fact: `crucible install` probes the card
   * and picks the largest candidate that fits, so a 24 GB box serves `translate`
   * with a 4-bit 27B, a bigger one serves it with something else, and a 12 GB
   * box does not serve it at all. A model id this app was configured with would
   * be a model that server may have refused — which is why there is no model
   * field on a registry entry and no picker showing one.
   */
  const record = await readCapability(entry);
  const row = record.classes.find((entry_) => entry_.capability === capability);
  if (row === undefined) {
    return {
      verdict: 'refuse',
      reason: `"${slot.name}" has no record for ${capability} work — its Crucible is older than this class.`,
    };
  }
  if (!row.enabled || row.selected.length === 0) {
    /*
     * `enabled: false` IS AN ANSWER AND NOT A FAULT — a server saying "this
     * machine cannot do that", with the number that decided it. So it is a WAIT
     * rather than a refusal: the same job on the next machine in the ranking is
     * a different question, and `any` steps past it. A pinned row holds with the
     * server's own reason on it, which is what SLOTS.md §6 asks for — *"disabled
     * → the row holds/skips with the reason"*.
     */
    const shortfall = row.shortfallBytes > 0
      ? ` (${(row.shortfallBytes / 1024 ** 3).toFixed(1)} GiB short)`
      : '';
    return {
      verdict: 'wait',
      reason: `"${slot.name}" cannot ${capability}: ${row.reason || 'no model fits its card'}${shortfall}`,
    };
  }

  /*
   * ── RESIDENCY: WE LOAD, AND WE NEVER UNLOAD ──────────────────────────────
   *
   * One model is resident at a time and a load EVICTS whatever was there. That
   * is the server's design and it is the reason nothing here ever calls
   * `unloadModel`: the card belongs to whoever is next, and a client that tidied
   * up after itself would be taking a model away from the run that evicted ours
   * a minute after it started.
   */
  const models = await client.models();
  const resident = models.find((model) => model.id === row.selected);
  if (resident === undefined) {
    return {
      verdict: 'refuse',
      reason: `"${slot.name}" selected ${row.selected} for ${capability} work and then did not list it. `
        + 'That is its own record disagreeing with itself; nothing here can fix it.',
    };
  }
  if (!resident.resident) {
    say(`Loading ${row.selected} on ${slot.name}…`);
    const jobId = await client.loadModel(row.selected);
    for await (const event of client.events(jobId)) {
      if (event.event === 'warming') say(`Loading ${row.selected} on ${slot.name}: ${event.data.message}`);
      else if (event.event === 'progress') say(`Loading ${row.selected} on ${slot.name}: ${event.data.message}`);
      else if (event.event === 'failed') {
        const code = event.data.error.code;
        /*
         * A LOAD THAT FAILED AFTER IT WAS ADMITTED. The codes that mean "this
         * machine, right now" travel to the next server; anything else is about
         * the model and would fail the same way everywhere.
         */
        return isServerSpecificRefusal(code)
          ? { verdict: 'wait', reason: `"${slot.name}" could not load ${row.selected}: ${event.data.error.message}` }
          : { verdict: 'refuse', reason: `"${slot.name}" could not load ${row.selected}: ${event.data.error.message}` };
      } else if (event.event === 'cancelled') {
        return { verdict: 'wait', reason: `the load of ${row.selected} on "${slot.name}" was cancelled` };
      }
    }
  }

  /*
   * ── AND THE LEASE, WHICH IS THE LAST THING BEFORE THE SPAWN ───────────────
   *
   * It is taken HERE — after the model is resident, before the engine exists —
   * because those are the two things that make a lease meaningful: there is
   * something on the card to claim, and nothing has started depending on it yet.
   * A lease taken before the load would be a claim on a model that is not there
   * (the server says so by name: `model_not_resident`), and one taken after the
   * spawn would leave a window in which another client's load evicts the model
   * this run is three blocks into using.
   */
  const lease = await takeLease(entry, row.selected, capability);

  return {
    verdict: 'go',
    placement: {
      slot,
      lease,
      /*
       * `openai` IS THE ENGINE'S DEFAULT AND IS LEFT UNSPELLED on the command
       * line — see `doorArgs` in job-queue.ts. It is named here anyway, because a
       * placement that said nothing about the dialect would be a placement whose
       * reader had to know the default.
       */
      door: 'openai',
      /*
       * THE OPENAI DOOR IS MOUNTED AT `<url>/openai`, and the engine appends
       * `/v1` itself. Composed here rather than stored on the entry: the entry's
       * URL is the SERVER's address, which is what the SDK wants and what a
       * person pastes, and a stored `/openai` would be this app's routing
       * decision written into somebody's settings file.
       */
      endpoint: `${entry.url}/openai`,
      model: row.selected,
      env: { FOUNDRY_ENDPOINT_HEADERS: headerMapFor(entry, capability) },
    },
  };
}

/**
 * The header map for one spawn, as the JSON the engine reads.
 *
 * `X-Crucible-Act` is required on OUR side by Owen's naming ruling and is one of
 * the five class words. The engine neither writes it nor knows about it: to the
 * engine this is an opaque map of headers to send, and the word for anybody's
 * product does not appear anywhere in `src/`.
 *
 * NEVER LOGGED, and the return value is the reason this function is small and
 * has one caller: the string it produces is a credential, and the only thing
 * that is ever done with it is putting it in a child's environment.
 */
function headerMapFor(entry: CrucibleServerEntry, capability: CapabilityClass): string {
  return JSON.stringify({
    Authorization: `Bearer ${entry.token}`,
    'X-Crucible-Api': '1',
    'X-Crucible-Act': capability,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The lease — RULED 2026-09-14, and the thing that keeps a book's model on the
// card for the length of the book
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CLAIM ON THE RESIDENT MODEL, held while this run is alive.
 *
 * ── The hazard it closes, stated once ─────────────────────────────────────
 *
 * docs/SLOTS.md §5: one model is resident at a time and a load EVICTS. A chat
 * holds no lane — a second client can load its own model while our engine is
 * mid-book, and the next block comes back `model_not_resident` from a server
 * that is doing exactly what it was asked. Nothing about that is anybody's bug,
 * and nothing short of an explicit claim prevents it. BookForge proposed the
 * lease and Owen ruled it in: while one is open, `load-model`, `unload-model`
 * and `load-voice` refuse `409 model_leased` naming the client, the act and
 * since when.
 *
 * ── Liveness only, which is why the TTL is short and the heartbeat exists ──
 *
 * The TTL is not how long the job will take; it is how long the server should
 * keep believing in a client it cannot see. This app crashes, a laptop sleeps, a
 * network goes — and a lease with no expiry would leave a card claimed by a
 * process that no longer exists, unbreakable except by restarting somebody
 * else's server. So the TTL is two minutes, the heartbeat is every forty
 * seconds, and a run this app loses track of frees the card within two minutes
 * without anybody doing anything.
 *
 * ── Releasing is not optional and is not best-effort ──────────────────────
 *
 * `release()` is called from the queue's SETTLE — the one place in
 * electron/job-queue.ts that every ending passes through, success, failure and
 * cancel alike. It is idempotent, it stops the heartbeat first, and it swallows
 * its own failure after logging: a lease that cannot be released expires, and
 * failing a finished job because the tidying failed would be reporting a loss
 * that did not happen.
 */
export interface Lease {
  /** The server's id for it, for the log line and for the two routes. */
  readonly id: string;
  /** Stop the heartbeat and give the card back. Idempotent; never throws. */
  release(): Promise<void>;
}

/**
 * How long the server keeps believing in us without hearing from us. Liveness,
 * not duration — see {@link Lease}.
 */
const LEASE_TTL_SECONDS = 120;

/**
 * The heartbeat interval: a third of the TTL, so two may be lost in a row before
 * the lease expires. A half would mean one dropped packet and a lost card.
 */
const LEASE_HEARTBEAT_MS = (LEASE_TTL_SECONDS / 3) * 1000;

/**
 * Take the lease, and arm the heartbeat that keeps it.
 *
 * A REFUSAL HERE PROPAGATES AS A THROW and is read by `interpretFailure` like
 * every other one on this path — which is what makes `model_leased` a WAIT (the
 * card is somebody else's for now, and another server's may be free) rather than
 * a failure. The load above has already made the model resident, so
 * `model_not_resident` from this route is the narrow race where somebody evicted
 * it between the two calls; it is server-specific, so it waits, and the next
 * pass loads again.
 */
async function takeLease(
  entry: CrucibleServerEntry,
  model: string,
  capability: CapabilityClass,
): Promise<Lease> {
  const body = await crucibleRequest(entry, `/v1/models/${encodeURIComponent(model)}/lease`, {
    method: 'POST',
    body: { act: capability, ttl_seconds: LEASE_TTL_SECONDS },
  });
  const id = typeof (body as Record<string, unknown> | null)?.['lease_id'] === 'string'
    ? (body as Record<string, string>)['lease_id'] as string
    : '';
  if (id.length === 0) {
    /*
     * A 201 with no `lease_id` in it. Refused rather than shrugged off: carrying
     * on without a lease would mean running a whole book under a protection this
     * code believes it has, which is worse than not having it — nobody would
     * look for the eviction, because the lease was "taken".
     */
    throw new CrucibleRefused(201, 'lease_unreadable', 'the lease was granted without an id', body);
  }
  let stopped = false;
  const timer = setInterval(() => {
    void crucibleRequest(entry, `/v1/leases/${encodeURIComponent(id)}/heartbeat`, { method: 'POST' })
      .catch((err: unknown) => {
        /*
         * A LOST HEARTBEAT IS NOT A LOST RUN AND MUST NOT STOP ONE. The engine is
         * talking to the same server over its own socket and is the thing that
         * would actually notice a problem; a heartbeat that fails while the run
         * is fine is a blip, and two more will be sent before the TTL is up. What
         * it is not is silent: the console names it so that an eviction later in
         * the book has a visible cause rather than looking like the server
         * misbehaving.
         */
        console.error(
          `[slots] the lease heartbeat for ${model} on ${entry.name} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return {
    id,
    async release(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await crucibleRequest(entry, `/v1/leases/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        console.error(
          `[slots] the lease on ${model} at ${entry.name} could not be released `
          + `(it expires in ${LEASE_TTL_SECONDS}s): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/**
 * ONE THROW, READ AS ONE OF THE THREE VERDICTS.
 *
 * Every branch keeps the server's or the SDK's own words. They name what to fix
 * — "busy: bookforge, tts qwen3.5-9b 62% done", "crucible at http://… is
 * unreachable" — and a word of ours in place of one of those is how a fixable
 * problem becomes an unfixable one.
 */
function interpretFailure(err: unknown, slotName: string, capability: CapabilityClass): PlacementOutcome {
  if (err instanceof CrucibleUnreachable) {
    return { verdict: 'wait', reason: `"${slotName}" is unreachable` };
  }
  if (err instanceof CrucibleBusy) {
    /*
     * 409 `server_busy`. The SDK renders the one sentence a person reads, and it
     * says WHO — `holder` is the busy job's recorded User-Agent, and null means
     * the client did not say, which the SDK renders as "an unnamed client"
     * rather than a guess. That is the rule the server itself keeps: a bench
     * must never be confidently wrong about whose render is on the card.
     */
    return { verdict: 'wait', reason: `"${slotName}" is ${err.busyLine}` };
  }
  if (err instanceof CrucibleRefused) {
    if (err.code === 'engine_in_use') {
      /*
       * 409 `engine_in_use`: a STREAMING session holds the resident engine
       * without occupying the lane at all, which is the state a bench used to
       * read as an idle machine while the browser extension was reading from it.
       * On a load it means, in plain words, that somebody is narrating there.
       */
      return { verdict: 'wait', reason: `someone is narrating on "${slotName}"` };
    }
    if (err.code === 'model_leased') {
      /*
       * 409 `model_leased`: another client has claimed the resident model for the
       * length of its own run, which is the protection this app takes for itself
       * three functions up. It names who and for what, and the details are read
       * here rather than in the sentence so that a body without them still gets a
       * sentence — one that says less, never one that invents.
       */
      const held = (err.details ?? {}) as Record<string, unknown>;
      const who = typeof held['client'] === 'string' ? held['client'] : 'another client';
      const act = typeof held['act'] === 'string' ? ` for ${held['act']}` : '';
      const since = typeof held['since'] === 'string' ? ` since ${held['since']}` : '';
      return { verdict: 'wait', reason: `"${slotName}" is leased by ${who}${act}${since}` };
    }
    if (err.code === 'model_not_resident') {
      /*
       * On the CHAT door this is the end of a run — the engine refuses by name
       * and never spins. Reaching it HERE, from a load, is the other half of
       * SLOTS.md §5's pair: the model is not resident and the engine will not be
       * given up, because a stream is holding it. Waited on, not failed.
       */
      return { verdict: 'wait', reason: `"${slotName}" is holding a different model for someone else` };
    }
    return isServerSpecificRefusal(err.code)
      ? { verdict: 'wait', reason: `"${slotName}" refused ${capability} work: ${err.serverMessage}` }
      : { verdict: 'refuse', reason: `"${slotName}" refused ${capability} work: ${err.serverMessage}` };
  }
  if (err instanceof CapabilityUndecided) {
    /*
     * 503 `capability_undecided` — nothing has probed that card yet. ABSENT AND
     * "NOTHING FIT" ARE OPPOSITE NEWS and are rendered as opposites: this one
     * names the command that decides it, where a disabled class names the
     * shortfall. It waits, because running `crucible capability --write` there is
     * a thing somebody can go and do.
     */
    return { verdict: 'wait', reason: `"${slotName}" has not measured its card yet — run \`crucible capability --write\` there` };
  }
  return {
    verdict: 'wait',
    reason: `"${slotName}" could not be asked about ${capability} work: `
      + `${err instanceof Error ? err.message : String(err)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/capability — one fetch, because the SDK has no method for it yet
// ─────────────────────────────────────────────────────────────────────────────

/** One class's row of a capability record, as this app reads it. */
export interface CapabilityRow {
  capability: string;
  enabled: boolean;
  /**
   * THE MODEL ID — the same id the model listing carries, and what `--model`
   * gets. `""` (not absent) when nothing fit, which is why the check at the call
   * site is on the length and not on the presence.
   */
  selected: string;
  /** The server's own words for why, present whether enabled or not. */
  reason: string;
  /** How much bigger the card would have to be. 0 on an enabled class. */
  shortfallBytes: number;
}

export interface CapabilityRecord {
  backendKind: string;
  totalBytes: number;
  classes: CapabilityRow[];
}

/** 503 `capability_undecided` — its own type, because it is its own news. */
export class CapabilityUndecided extends Error {}

/**
 * ── THE FOUR ROUTES THE SDK HAS NO METHOD FOR, AND ONE WAY TO CALL THEM ────
 *
 * `GET /v1/capability` and the three lease routes are not on `@crucible/client`
 * v0.5.0 — capability has never been, and the lease routes are landing in the
 * same Crucible commit as this work. One `fetch` each is the honest way to say
 * so, rather than a wrapper pretending to be part of the client that somebody
 * would later have to un-pick.
 *
 * **Switch these four to the SDK's own `capability()` / `lease()` /
 * `heartbeat()` / `release()` the moment the tarball carries them.**
 *
 * WHAT THIS FUNCTION IS FOR IS THE ERROR MAPPING, not the fetch. Everything else
 * on this path throws the SDK's error types, and `interpretFailure` switches on
 * them — so a route called by hand that threw a bare `Error` would be a 409
 * `model_leased` arriving as "could not be asked", losing the one distinction
 * that decides whether the row waits or fails. The two headers are exactly the
 * ones the SDK sends on every authenticated route.
 */
async function crucibleRequest(
  entry: CrucibleServerEntry,
  route: string,
  options: { method: string; body?: unknown } = { method: 'GET' },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${entry.url}${route}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${entry.token}`,
        'X-Crucible-Api': '1',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (err) {
    throw new CrucibleUnreachable(entry.url, err instanceof Error ? err.message : String(err), err);
  }
  if (response.status === 204) return null;
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (response.ok) return parsed;
  /*
   * `{"error": {"code", "message", "details"?}}` is the documented envelope for
   * every refusal on this wire (crucible docs/DESIGN.md §4). A body that is not
   * one is not dressed up as a code: the excerpt is what there is to show, and a
   * made-up code would be switched on by `interpretFailure` as though a server
   * had said it.
   */
  const envelope = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const code = typeof envelope?.code === 'string' ? envelope.code : 'unreadable_refusal';
  const message = typeof envelope?.message === 'string' ? envelope.message : text.slice(0, 300);
  const details = envelope?.details ?? null;
  if (response.status === 401) throw new CrucibleAuthError(code, message);
  if (response.status === 426) {
    const served = typeof (parsed as { api_version?: unknown } | null)?.api_version === 'number'
      ? (parsed as { api_version: number }).api_version
      : null;
    throw new CrucibleVersionError(code, message, served, 1);
  }
  if (response.status === 503 && code === 'capability_undecided') {
    throw new CapabilityUndecided(message);
  }
  if (response.status >= 500) throw new CrucibleServerError(response.status, code, message);
  if (response.status === 409 && code === 'server_busy') {
    /*
     * THE BUSY FIELDS ARE READ HERE BECAUSE `CrucibleBusy.busyLine` IS WHAT THE
     * ROW SHOWS. Leaving this as a plain `CrucibleRefused` would mean a queue row
     * saying "refused the request (409 server_busy)" where it could say "busy:
     * bookforge, tts qwen3.5-9b 62% done". `holder` NULL MEANS THE CLIENT DID NOT
     * SAY and is never filled in — the server refuses to invent a name there, for
     * the reason a bench must never be confidently wrong about whose render is on
     * the card, and the SDK renders it as "an unnamed client".
     */
    const busy = (details ?? {}) as Record<string, unknown>;
    throw new CrucibleBusy(409, code, message, details, {
      holder: typeof busy['holder'] === 'string' ? busy['holder'] : null,
      jobId: typeof busy['job_id'] === 'string' ? busy['job_id'] : '',
      jobType: typeof busy['type'] === 'string' ? busy['type'] : 'a job',
      model: typeof busy['model'] === 'string' ? busy['model'] : null,
      jobStatus: typeof busy['status'] === 'string' ? busy['status'] : 'running',
      since: typeof busy['since'] === 'string' ? busy['since'] : '',
      progress: typeof busy['progress'] === 'number' ? busy['progress'] : 0,
      jobMessage: typeof busy['message'] === 'string' ? busy['message'] : null,
    });
  }
  throw new CrucibleRefused(response.status, code, message, details);
}

/** `GET /v1/capability` — see {@link crucibleRequest} for why it is a fetch. */
async function readCapability(entry: CrucibleServerEntry): Promise<CapabilityRecord> {
  const body = await crucibleRequest(entry, '/v1/capability');
  if (typeof body !== 'object' || body === null) {
    throw new CrucibleRefused(200, 'capability_unreadable', 'the capability record was not an object', null);
  }
  const record = body as Record<string, unknown>;
  const rows = Array.isArray(record['classes']) ? record['classes'] : [];
  return {
    backendKind: typeof record['backend_kind'] === 'string' ? record['backend_kind'] : '',
    totalBytes: typeof record['total_bytes'] === 'number' ? record['total_bytes'] : 0,
    classes: rows.flatMap((raw): CapabilityRow[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const row = raw as Record<string, unknown>;
      if (typeof row['capability'] !== 'string') return [];
      return [{
        capability: row['capability'],
        /*
         * `enabled` IS ONLY TRUE WHEN IT IS TRUE. A row whose flag is missing or
         * is not a boolean reads as disabled, which is the conservative
         * direction: the cost of getting it wrong that way is one wasted hop to
         * the next server, and the cost of getting it wrong the other way is an
         * hour of somebody's book spent against a class a machine cannot serve.
         */
        enabled: row['enabled'] === true,
        selected: typeof row['selected'] === 'string' ? row['selected'] : '',
        reason: typeof row['reason'] === 'string' ? row['reason'] : '',
        shortfallBytes: typeof row['shortfall_bytes'] === 'number' ? row['shortfall_bytes'] : 0,
      }];
    }),
  };
}
