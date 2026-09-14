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

import { cloudEndpointOf, cloudHeaderMapFor, cloudProviderNamed } from './cloud-providers';
import { clientFor, computeSlots, crucibleServerNamed } from './crucible-registry';
import type { CrucibleServerEntry } from './app-settings';
import { upstreamLaneName } from '../shared/queue-board';
import { ANY_SLOT, LOCAL_SLOT_NAME, slotNamed, type ComputeSlot } from '../shared/slots';
import type { LlmServerKind } from '../shared/pipeline';
import type { JobKind, ModelClass } from '../shared/types';

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
 *
 * ── AND IT IS `ModelClass` UNDER ANOTHER NAME, DELIBERATELY ─────────────────
 *
 * The five words were written out twice — here, and as `ModelClass` in
 * shared/types.ts, which is what the vendored lineup files a model's row under.
 * They were identical, and two spellings of one vocabulary is the defect this
 * repo keeps meeting: the acronym list that was fifteen here and seventeen
 * there, and the translate floor that one catalog declared and another quietly
 * lowered. So this is an ALIAS, and the catalog owns the words.
 *
 * The name stays because it says which question is being asked — `ModelClass`
 * is "what may serve this act", `CapabilityClass` is "what a server says it can
 * do" — and because the day Foundry needs a class Crucible has and no model of
 * ours does (`tts`, `asr`), this is the one that widens, on purpose, with a
 * reason written here rather than by drifting.
 */
export type CapabilityClass = ModelClass;

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
 * ── READS GO TO A CRUCIBLE NOW — RULED 2026-09-14 ──────────────────────────
 *
 * This was `false` while the local page reader was Package B's and the open
 * question was whether a REMOTE reader may be chosen at all when the local dots
 * server is the thing that works while the Mac is asleep. Owen answered it with
 * the whole phase (crucible docs/PHASE15-HOST.md §0): *"if it uses the GPU (as
 * dots does), it should probably be crucible-side … crucible can decide if the
 * user's system is even capable of running it … it should be a pass-through thin
 * client UI for the crucible engine."* A page reading is model INFERENCE, and
 * inference is Crucible's — on any card, on a CPU, in host mode or in WSL.
 *
 * So a `read` places like every other act: any registered server whose `pages`
 * row is enabled, in rank order, the loopback one first (`computeSlots`).
 *
 * ── THE THREE THINGS THAT HAD TO MOVE WITH IT, ALL IN THIS COMMIT ──────────
 *
 *   1. The reading server is started AFTER the placement and only when the
 *      placement is this machine's (`runInSlot`, electron/job-queue.ts). It used
 *      to be started first, unconditionally, which would have loaded four
 *      gigabytes onto this card for a reading that was about to be sent to
 *      another machine.
 *   2. A Crucible-placed reading gets `--vlm-endpoint` and `--vlm-endpoint-model`
 *      off the placement (`argsFor`). Without it the engine would read
 *      `backend.endpointUrl` out of settings.json and post the pages to whatever
 *      that names, which is the local reader — a placement nothing honoured.
 *   3. §5b's AUTOMATIC removal of Foundry's own dots files arms with this
 *      constant (`applyPageReaderRemoval` and `pageReaderRemovalOffer`,
 *      electron/machine-models.ts; `pageReaderSuperseded`, electron/page-reader.ts).
 *      All three already read it and all three say so. Flipping it without (1)
 *      and (2) would have deleted the thing still doing the work.
 */
export const CRUCIBLE_READS = true;

/**
 * DOES THIS KIND OF JOB GET PLACED AT ALL — the two early returns of
 * {@link placeJob}, asked before the walk instead of discovered inside it.
 *
 * ── Why it is exported, and what was wrong with it being implied ────────────
 *
 * Three callers need the same answer and each of them used to spell it out:
 * `placeJob` (which returns {@link UNPLACED} and never looks at a slot),
 * `placedBy` (which puts no `waitFor` on the row, so no picker is drawn), and —
 * since Package G — the PUMP, which has to know which lane a row will hold
 * before it picks it. A run that is never placed still runs on this machine's
 * card: a page reading loads dots on the local GPU whatever the registry says.
 * Three copies of one predicate is how a reading ends up holding no lane at all
 * and two of them start on one card, so there is one copy and it is here, beside
 * the switch (`CRUCIBLE_READS`) that decides half of it.
 *
 * FALSE IS NOT "CHEAP" AND IS NOT "NO GPU". An export is false because it never
 * meets a model; a reading is false because its model is on a path this module
 * does not route yet. What they share is only that the answer to *whose machine*
 * is already decided — it is this one.
 */
export function placesOnASlot(kind: JobKind): boolean {
  if (capabilityClassOf(kind) === null) return false;
  if (kind === 'read' && !CRUCIBLE_READS) return false;
  return true;
}

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
  /**
   * Which engine dialect. `openai` is the engine's default and goes unspelled on
   * the command line; `ollama` and `anthropic` are both written out (`doorArgs`,
   * electron/job-queue.ts), because the engine refuses an unknown value by name
   * and a door left unsaid would be the default answering for it.
   */
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
   * Null on the local slot, which shares nothing with anybody, on every
   * placement that never touched a Crucible, AND on a Crucible placement whose
   * route is upstream — PHASE15 §3.4: *"no lease, no lane, the settlement
   * untouched (nothing was on the card)"*, and §3.4 again on the lease route
   * itself, which refuses one by name (`lease_not_needed`). Non-null placements
   * MUST be released — see {@link Lease}, which says what happens if they are
   * not. `settled` (electron/job-queue.ts) already reads an absent lease as
   * nothing to release, which is why this needed no change there.
   */
  lease: Lease | null;
  /**
   * THE UPSTREAM THIS RUN IS FORWARDED TO, or null for work on a card.
   *
   * The name alone — `anthropic`, `openai`, `ollama` — and not the model id,
   * because this field answers a question about the LANE and about the sentence
   * a person reads. The model id is `model`, one line up, and is on the command
   * line where it belongs.
   *
   * It is what makes the run take the server's `[cloud]` lane rather than its
   * card (`upstreamLaneName`, shared/queue-board.ts) and what the shelf says
   * after "on <server>".
   */
  via: string | null;
}

/** The local slot's placement — today's lines, spelled as a placement. */
function localPlacement(slot: ComputeSlot): Placement {
  return { slot, door: 'ollama', endpoint: null, model: null, env: {}, lease: null, via: null };
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
  via: null,
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
 * MAY THIS RUN HAVE THAT SLOT — the scheduler's lane, asked from INSIDE the walk.
 *
 * ── Why the walk claims rather than the pump reserving ─────────────────────
 *
 * Package G gives every compute slot its own lane, so two `any` rows may now be
 * walking at the same moment — and a walk takes minutes when it has to load a
 * model. If the pump handed each of them a lane up front it would be making the
 * placement decision (which this module owns, and which depends on facts only a
 * server can answer); if it handed them nothing, both would find the same slot
 * idle and start two runs on one card. So the walk asks, at the one instant it
 * commits to a slot, and the answer is authoritative because the scheduler's
 * occupancy map is main-process state that changes under no await.
 *
 * TRUE MEANS THE LANE IS NOW THIS RUN'S. There is no matching release: a run
 * holds exactly one lane, so claiming the next candidate gives the last one back,
 * and the whole claim goes when the row settles. A caller with no lanes to ration
 * — a host's scheduler through `runJob`, the Export dialog through `runNow` —
 * passes a claim that always says yes, because the deciding already happened
 * somewhere this queue cannot see (electron/job-queue.ts, `detachedRuns`).
 *
 * ── IT IS A LANE'S NAME, NOT A SLOT'S, AND THE TWO STOPPED BEING ONE ───────
 *
 * Wave 62: a Crucible slot has TWO lanes — its card, and the `[cloud]` one an
 * upstream-routed act takes (`upstreamLaneName`, shared/queue-board.ts). The
 * argument was `slot` when every slot was one lane; it is the LANE now, and the
 * card lane still bears the slot's own name so nothing about the local path
 * changed. The capacity is the caller's to know: an upstream lane takes two.
 */
export type LaneClaim = (lane: string) => boolean;

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
 * A CLOUD SLOT IS NEVER WHAT `any` FALLS THROUGH TO (docs/SLOTS.md §3). It is
 * STEPPED PAST WITH A SENTENCE rather than skipped in silence, which is the one
 * change Package F made to this walk: a machine whose only slot is a provider
 * would otherwise park every `any` row reading "no slot is available", and the
 * true statement is that there IS one and this walk will not spend somebody's
 * money to reach it. The sentence says so, and the picker on the row is where
 * the choice is made.
 *
 * ── AND THE WALK NOW TAKES THE LANE AS IT GOES (Package G) ─────────────────
 *
 * `claim` is the scheduler's occupancy, asked per candidate — see
 * {@link LaneClaim}. A slot this app is ALREADY running something on is stepped
 * past exactly like a busy one, with a sentence saying so, because that is what
 * it is: the difference between somebody else's job holding the card and our own
 * matters to the wording and to nothing else.
 *
 * ── WHERE THE CLAIM HAPPENS MOVED, AND WHY (Wave 62, Package K) ────────────
 *
 * It used to be RIGHT HERE, one line above `placeOn`: the walk claimed
 * `slot.name` and only then asked the server anything. That was correct while a
 * slot was one lane. It stopped being correct the moment a class could route
 * UPSTREAM (PHASE15 §3.3), because which of the slot's two lanes a run belongs in
 * is a fact only `GET /v1/capability` knows — so claiming first meant holding a
 * machine's CARD for the length of a network read that was going to end in a
 * placement that never touches it, and, worse, KEEPING it: a run forwarded to
 * Anthropic would have sat in the GPU lane for an hour while the card idled and
 * the next translation waited for it.
 *
 * So the claim is taken INSIDE `placeOnCrucible`, after the capability row is
 * read and the route is known, on the lane the route names. `placeOn` claims for
 * the two slot kinds that need no read (the local slot, and a cloud provider,
 * which Package L deletes).
 *
 * TWO CONSEQUENCES, BOTH DELIBERATE. The walk now costs one capability read per
 * candidate even when our own job holds that machine's card — the read is what
 * tells it whether the card is the lane it wanted. And the PINNED path claims
 * too, which it did not before: the pump used to reserve a pinned row's lane at
 * the pick, and it cannot any more, for the same reason (`laneAtPick`,
 * electron/job-queue.ts, which now reserves only where there is nothing to
 * choose between).
 */
export async function placeJob(
  kind: JobKind,
  waitFor: string | undefined,
  say: PlacementProgress,
  claim: LaneClaim,
): Promise<PlacementOutcome> {
  const slots = computeSlots();
  const capability = capabilityClassOf(kind);
  /*
   * NOTHING TO DECIDE, and the three ways that happens are one answer. No
   * capability class (an export, a mint, an install — no model anywhere near
   * it); no slot list (hosted with no provider); or one slot, which is the
   * friend with a GPU and no Crucible, who never meets a picker.
   *
   * NEITHER ARM CLAIMS A LANE, and the pump is why: a run that is never placed
   * is a run on THIS machine, and `laneAtPick` gives it the local lane before it
   * is ever picked (`placesOnASlot` is the shared half of this test). Claiming
   * here as well would be a second owner of one reservation.
   *
   * `capability === null` IS `placesOnASlot`'s FIRST CLAUSE, repeated for the
   * compiler rather than for the reader: the walk below needs the class narrowed
   * to a non-null one, and a predicate in another function cannot narrow a local.
   */
  if (capability === null || !placesOnASlot(kind) || slots.length === 0) {
    return { verdict: 'go', placement: UNPLACED };
  }

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
    return placeOn(slot, capability, say, claim);
  }

  const reasons: string[] = [];
  for (const slot of slots) {
    if (slot.kind === 'cloud') {
      reasons.push(`"${slot.name}" is a cloud provider, and cloud slots are chosen on purpose`);
      continue;
    }
    const outcome = await placeOn(slot, capability, say, claim);
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

/**
 * One slot, asked whether it will start this act now.
 *
 * THE TWO KINDS THAT NEED NO SERVER CLAIM HERE. A local slot is this machine's
 * card and a cloud provider is one key; neither has a second lane and neither has
 * a route to read, so the lane is knowable without a request and is taken before
 * the placement is built. The Crucible path claims inside `placeOnCrucible`,
 * after the route is known — see `placeJob`'s note on where the claim moved.
 */
async function placeOn(
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
  claim: LaneClaim,
): Promise<PlacementOutcome> {
  if (slot.kind === 'local' || slot.kind === 'cloud') {
    if (!claim(slot.name)) return { verdict: 'wait', reason: busyWithOurs(slot.name) };
    return slot.kind === 'local'
      ? { verdict: 'go', placement: localPlacement(slot) }
      : placeOnCloud(slot, capability);
  }
  const entry = crucibleServerNamed(slot.name);
  if (entry === null) {
    return { verdict: 'wait', reason: `"${slot.name}" is no longer registered` };
  }
  try {
    return await placeOnCrucible(entry, slot, capability, say, claim);
  } catch (err) {
    return interpretFailure(err, slot.name, capability);
  }
}

/**
 * OUR OWN RUN IS AS GOOD A REASON TO STEP PAST AS SOMEBODY ELSE'S, and it is the
 * one this app is authoritative about: a Crucible serving a passthrough chat does
 * not report itself busy, so the lane is the only thing standing between two of
 * our books and one card. The sentence names the app rather than the job, because
 * a person reading a parked row is looking at the bench, where the job that is in
 * the way already names itself.
 */
function busyWithOurs(lane: string): string {
  return `"${lane}" is already running a job of yours`;
}

/**
 * A CLOUD PROVIDER — and it is the shortest placement in this module, because
 * almost everything the Crucible path does has no counterpart here.
 *
 * ── What is deliberately absent, each for its own reason ───────────────────
 *
 *   * NO CAPABILITY READ. A provider has no card to measure and no class rows;
 *     which models a key may use is `Test`'s question, asked once on a settings
 *     card rather than before every run.
 *   * NO RESIDENCY AND NO LEASE. Nothing is loaded and nothing can be evicted,
 *     so there is nothing to claim — `lease: null`, and the settle has nothing
 *     to release.
 *   * NO BUSY, AND THEREFORE NO `wait` ARM AT ALL. A provider's queue is
 *     somebody else's and its way of saying "later" is a 429, which the ENGINE
 *     waits out (docs/VLLM.md §2a: `retry-after` honoured, else 2 s doubling to
 *     30 s, six attempts, each wait logged). Parking the row here for a fact
 *     this app cannot observe would be a second waiter over one queue.
 *   * NO NETWORK CALL OF ANY KIND. This function does not check that the
 *     provider is reachable, on `interpretFailure`'s posture one door along: a
 *     reachability probe before every spawn would put a round trip in front of
 *     every row and still tell the run nothing it will not learn in its first
 *     request, with a better sentence.
 *
 * ── And the one refusal it does make ───────────────────────────────────────
 *
 * TEXT ACTS ONLY (docs/SLOTS.md §3). A `pages` job pinned to a provider is
 * refused BY NAME and not waited on, because it will be refused identically
 * every time: page reading is a VLM pass over rendered images through this app's
 * own reader or a Crucible, and no cloud text door in this build serves it.
 */
function placeOnCloud(slot: ComputeSlot, capability: CapabilityClass): PlacementOutcome {
  const entry = cloudProviderNamed(slot.name);
  if (entry === null) {
    return { verdict: 'wait', reason: `"${slot.name}" is no longer configured` };
  }
  if (capability === 'pages') {
    return {
      verdict: 'refuse',
      reason: `${entry.name} cannot read pages; page reading stays on this machine or a Crucible.`,
    };
  }
  return {
    verdict: 'go',
    placement: {
      slot,
      /*
       * OpenAI'S OWN API IS AN OpenAI-COMPATIBLE SERVER, so a provider of that
       * kind takes the door that already existed and Anthropic takes the dialect
       * of its own. The engine refuses an unknown `--server` value by name, so
       * this mapping is total by construction rather than by a default.
       */
      door: entry.kind === 'anthropic' ? 'anthropic' : 'openai',
      endpoint: cloudEndpointOf(entry),
      /*
       * `--model` IS REQUIRED ON BOTH CLOUD DOORS and there is no default to
       * fall back on — a provider holds a catalog. The id is the one the person
       * typed on the card and `Test` proved against the provider's own listing;
       * nothing here second-guesses it, on `clampCloudModel`'s argument that a
       * table of hosted model names compiled into a build is wrong by the next
       * release.
       */
      model: entry.model,
      env: { FOUNDRY_ENDPOINT_HEADERS: cloudHeaderMapFor(entry) },
      lease: null,
      /*
       * NULL, AND THAT IS NOT THE SAME SHAPE AS AN UPSTREAM ROUTE. `via` says
       * "a Crucible forwarded this on the operator's account" and puts the run
       * in that server's `[cloud]` lane. This slot IS the provider — it has a
       * lane of its own and an app-held key, which is exactly what PHASE15 §5.3
       * deletes (Package L).
       */
      via: null,
    },
  };
}

async function placeOnCrucible(
  entry: CrucibleServerEntry,
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
  claim: LaneClaim,
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
   * ── AN UPSTREAM ROUTE: THE SAME DOOR, AND NOTHING ON THE CARD ─────────────
   *
   * PHASE15 §3.3 — the row says `route`, and `selected` is the model id an app
   * sends whether it is resident or not. §3.4 — a `model` with a slash is
   * FORWARDED by the server on the operator's account, *"no lease, no lane, the
   * settlement untouched (nothing was on the card)"*, and a lease or a
   * `load-model` naming one is refused `lease_not_needed`. Owen, the same day:
   * *"one contract, one SDK, one API, one communication method."*
   *
   * So the three things the local path does BELOW are all skipped, each because
   * it would be a request about a model that is not on anybody's card:
   *
   *   * NO `models()` — `GET /v1/openai/models` lists a routed upstream model,
   *     but `client.models()` is the RESIDENCY listing and an upstream model is
   *     never in it. Checking would refuse a working server by name.
   *   * NO `loadModel` — refused `lease_not_needed`'s sibling, and there is
   *     nothing to warm.
   *   * NO `takeLease` — refused by name, and there is nothing to protect: a
   *     load on that server cannot evict a model it never loaded.
   *
   * WHAT IS IDENTICAL IS THE SEAM. The same `/openai` endpoint, the same header
   * map with `X-Crucible-Act` still naming the act (so `/v1/activity` says
   * "translating on anthropic", §3.4), the same door. That is the whole point of
   * the phase: the app does not know or care where the answer came from.
   *
   * AND THE LANE IS THE SERVER'S `[cloud]` ONE, claimed here — the first moment
   * anything in this process knows which of the slot's two lanes this run wants.
   */
  const via = upstreamOf(row);
  if (via !== null) {
    const lane = upstreamLaneName(slot.name);
    if (!claim(lane)) {
      return {
        verdict: 'wait',
        reason: `"${slot.name}" is already forwarding as many jobs of yours to ${via} as it will at once`,
      };
    }
    say(`Sending ${capability} to ${slot.name} via ${via} (${row.selected})`);
    return {
      verdict: 'go',
      placement: {
        slot,
        lease: null,
        via,
        door: 'openai',
        endpoint: `${entry.url}/openai`,
        model: row.selected,
        env: { FOUNDRY_ENDPOINT_HEADERS: headerMapFor(entry, capability) },
      },
    };
  }

  /*
   * THE CARD LANE, TAKEN BEFORE A MODEL IS LOADED ONTO IT. Below this line
   * everything is about a machine's GPU — the residency, the eviction, the lease
   * — and none of it may be done on a card another run of ours is holding.
   */
  if (!claim(slot.name)) {
    return { verdict: 'wait', reason: busyWithOurs(slot.name) };
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
      /** A resident model on that machine's card. Nothing was forwarded. */
      via: null,
    },
  };
}

/**
 * THE UPSTREAM A ROW IS ROUTED TO, or null for a model on the server's own card.
 *
 * TWO FACTS AGREE AND EITHER WOULD DO, which is why this is one function rather
 * than a test written at each of the three places that asks. PHASE15 §1: an
 * upstream model id is `<upstream>/<model>` and *"a local model id never contains
 * `/`"* (checked at manifest load, `manifest_model_id_slash`). §3.3: the row also
 * says `route` outright.
 *
 * THE SLASH IS WHAT IS READ, and `route` is the guard. A pre-PHASE15 server — the
 * one on Owen's desk today — sends no `route` at all and `readCapability` reads
 * that absence as `local`, so a row from it can never take this path however its
 * `selected` is spelled. A PHASE15 server that said `upstream` and then selected
 * something with no slash has contradicted itself, and the honest answer to that
 * is the LOCAL path, which will refuse by name against the residency listing
 * rather than composing an upstream name out of half a string.
 */
function upstreamOf(row: CapabilityRow): string | null {
  if (row.route !== 'upstream') return null;
  const cut = row.selected.indexOf('/');
  return cut > 0 ? row.selected.slice(0, cut) : null;
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
  const acquire = async (): Promise<string> => {
    const body = await crucibleRequest(entry, `/v1/models/${encodeURIComponent(model)}/lease`, {
      method: 'POST',
      body: { act: capability, ttl_seconds: LEASE_TTL_SECONDS },
    });
    const granted = typeof (body as Record<string, unknown> | null)?.['lease_id'] === 'string'
      ? (body as Record<string, string>)['lease_id'] as string
      : '';
    if (granted.length === 0) {
      /*
       * A 201 with no `lease_id` in it. Refused rather than shrugged off: carrying
       * on without a lease would mean running a whole book under a protection this
       * code believes it has, which is worse than not having it — nobody would
       * look for the eviction, because the lease was "taken".
       */
      throw new CrucibleRefused(201, 'lease_unreadable', 'the lease was granted without an id', body);
    }
    return granted;
  };
  let id = await acquire();
  let stopped = false;
  const timer = setInterval(() => {
    void crucibleRequest(entry, `/v1/leases/${encodeURIComponent(id)}/heartbeat`, { method: 'POST' })
      .catch(async (err: unknown) => {
        /*
         * THE SERVER FORGOT THE LEASE, which is what a restart does: leases are
         * in memory there, so `unknown_lease` on a heartbeat means the card is
         * unprotected NOW while the engine is mid-book. The right answer is not
         * a log line but a new lease on the same model — the model is still
         * resident (a restart that lost it would be answering the engine
         * `model_not_resident` already, which the engine refuses by name) and
         * this run still intends every request it has left. A re-lease that is
         * itself refused falls through to the log below, and the run goes on
         * unprotected and said so.
         */
        if (err instanceof CrucibleRefused && err.code === 'unknown_lease' && !stopped) {
          try {
            id = await acquire();
            console.error(
              `[slots] ${entry.name} had forgotten the lease on ${model} (restarted?); took a new one`,
            );
            return;
          } catch (again) {
            err = again;
          }
        }
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
    get id(): string { return id; },
    async release(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await crucibleRequest(entry, `/v1/leases/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        // Already gone — released by a restart or expired — is exactly the state
        // a release wants, and not a failure to report.
        if (err instanceof CrucibleRefused && err.code === 'unknown_lease') return;
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
/**
 * WHERE AN UPSTREAM IS CONFIGURED, spelled once so this file and act-gates.ts
 * send a person to the same place. The keys live in the ENGINE now (PHASE15 §0:
 * *"settings live in the engine and nowhere else"*), and Foundry's card is a
 * window onto that server's settings document (§5.2).
 */
const UPSTREAM_SETTINGS = 'Open Settings › Servers and its "Where the text work runs" card';

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
    /*
     * ── THE THREE PHASE15 REFUSALS, BY NAME (crucible §3.4) ─────────────────
     *
     * They arrive on the PLACEMENT path only through a capability read or a
     * lease; the CHAT itself is the engine's socket, and an upstream refusal
     * mid-book is the engine's own sentence on the row. Named here anyway,
     * because the day a settings write or a probe raises one, "refused translate
     * work: …" would be this app shrugging at a fact it has a word for.
     */
    if (err.code === 'upstream_unconfigured') {
      /*
       * 409. The route names an upstream the server has no key or url for —
       * §3.2 promises that cannot be STORED, so reaching it means the operator
       * removed the key after the route was set, or the config was hand-edited.
       * A REFUSAL and not a wait: every attempt on that server will say the same
       * thing until somebody opens its settings, and the sentence says where.
       */
      return {
        verdict: 'refuse',
        reason: `"${slotName}" routes ${capability} to an upstream it has no credential for: `
          + `${err.serverMessage} ${UPSTREAM_SETTINGS}.`,
      };
    }
    if (err.code === 'upstream_rejected' || err.code === 'upstream_unreachable') {
      /*
       * 502 either way. The upstream refused the operator's key, or could not be
       * reached from that machine — both are facts about THAT SERVER'S network
       * and account, so the same job on the next machine in the ranking is a
       * different question and `any` steps past it. The upstream's own words are
       * kept verbatim: they name what to fix, and a word of ours in their place
       * is how a fixable problem becomes an unfixable one.
       */
      return { verdict: 'wait', reason: `"${slotName}" could not reach its upstream: ${err.serverMessage}` };
    }
    if (err.code === 'lease_not_needed') {
      /*
       * §3.4: *"an upstream model is never resident; send the chat."* Nothing
       * should ever reach this — `placeOnCrucible` reads the route first and the
       * upstream path takes no lease at all. So it is OUR BUG, said out loud on
       * the row rather than dressed as a server problem, and refused rather than
       * retried because retrying a dispatcher defect would hide it behind a
       * backoff.
       */
      return {
        verdict: 'refuse',
        reason: `Foundry tried to lease an upstream model on "${slotName}", which is never resident `
          + `— that is a defect in this app's dispatcher, not a fault on that server. ${err.serverMessage}`,
      };
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
  /**
   * WHERE THIS CLASS'S WORK RUNS ON THAT SERVER (crucible PHASE15 §3.3).
   *
   *   `local`    — the selected LOCAL model, resident on that machine's card.
   *                Everything this module has ever done.
   *   `upstream` — the server forwards the chat to `anthropic`, `openai` or
   *                `ollama` on the operator's account, and `selected` is the
   *                `<upstream>/<model>` id to send.
   *
   * ── ABSENT IS `local`, AND THE RULE IS ABOUT THE DOCUMENT, NOT THE ROW ────
   *
   * PHASE15 §3.3, pinned with both apps 2026-09-14 (crucible eb59f7b): a
   * capability document in which NO row carries `route` comes from a server that
   * predates this phase, and every class on such a server IS local — *"a fact the
   * document states, not a default the client fills"*. Owen's own WSL Crucible is
   * one today, and reading its silence as a refusal, or as `upstream`, would dark
   * every tile on the machine this app is built on.
   *
   * A PARTIAL DOCUMENT IS A DEFECT AND IS REFUSED, not patched. `readCapability`
   * raises `capability_route_missing` naming the row, and
   * `capability_route_unknown` for a value that is neither word. Filling either
   * in with `local` would be this app inventing the one fact that decides whether
   * a run costs GPU-minutes or money — see `readCapability`, which is the one
   * reader and therefore the one place the rule can live.
   *
   * `enabled` ONE FIELD UP STILL READS A MISSING FLAG AS FALSE, and that is not
   * inconsistent: a missing `enabled` is a server declining to answer a question
   * it knows about, where a missing `route` on a document that has none anywhere
   * is a server from before the question existed.
   */
  route: 'local' | 'upstream';
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
  options: { method: string; body?: unknown; timeoutMs?: number } = { method: 'GET' },
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
      /*
       * NO TIMEOUT BY DEFAULT, and the placement path passes none. A dispatch is
       * a person's press being answered and there is a row on screen wearing the
       * word "placing"; cutting that off at three seconds would fail a job
       * because a load was slow. The one caller that DOES pass one is the
       * settings-side probe (`crucible-provider.ts`), which runs on every gate
       * read: a Mac that is asleep must not put a network timeout behind a
       * tooltip, so that path asks with a clock on it and reads a cut-off answer
       * as `unknown`.
       */
      ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
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

/**
 * `GET /v1/capability` — see {@link crucibleRequest} for why it is a fetch.
 *
 * EXPORTED FOR THE SETTINGS SIDE (`crucible-provider.ts`, Wave 61 package E),
 * which asks the same question for a different reason: not "may this job start"
 * but "does a Crucible on this machine own this class of weights", which is what
 * decides whether Foundry deletes its own copy of the page reader (SLOTS.md
 * §5b). ONE READER OF THIS ROUTE, because the shape of a capability record and
 * the mapping of its refusals onto the SDK's error types is exactly the kind of
 * thing that is written twice and then only fixed once.
 */
export async function readCapability(
  entry: CrucibleServerEntry,
  timeoutMs?: number,
): Promise<CapabilityRecord> {
  const body = await crucibleRequest(entry, '/v1/capability', { method: 'GET', timeoutMs });
  if (typeof body !== 'object' || body === null) {
    throw new CrucibleRefused(200, 'capability_unreadable', 'the capability record was not an object', null);
  }
  const record = body as Record<string, unknown>;
  const rows = Array.isArray(record['classes']) ? record['classes'] : [];

  /*
   * ── THE ROUTE RULE IS ABOUT THE WHOLE DOCUMENT, AND IS READ FIRST ─────────
   *
   * PHASE15 §3.3, pinned with both apps (crucible eb59f7b): a document in which
   * NO row carries `route` is a PRE-PHASE-15 server and every class on it is
   * local — a fact it states by its own version, not a hole this app fills. A
   * document in which SOME rows carry it and one does not is a DEFECT, refused by
   * name, because the absence there is not a version statement: it is one class
   * whose route nobody can know, on a server that plainly knows about routes. A
   * `local` guessed into that gap is this app deciding, silently, whether an hour
   * of somebody's book runs on a card they own or on an account they are billed
   * for.
   *
   * SO THE PASS IS TAKEN BEFORE ANY ROW IS BUILT. One question about the
   * document, then the rows; the alternative — deciding per row and discovering
   * the inconsistency halfway — would refuse some documents and not others
   * depending on which class came first in a list nothing orders.
   *
   * REFUSED AS `CrucibleRefused`, WHICH IS WHAT MAKES IT BEHAVE. That is the type
   * every other refusal on this path throws, so `interpretFailure` gives it the
   * server-specific test (neither code is one, so a placement REFUSES by name
   * rather than walking to the next machine and reporting the third one's), and
   * `crucible-provider`'s probe records it as a server that did not answer —
   * `unknown`, which darks the tile and authorises no deletion. A 200 is used for
   * the status because the server's HTTP answer WAS fine; what is wrong is the
   * document, and inventing a 4xx would be attributing a refusal to a server that
   * did not make one.
   */
  const declared = rows.filter(
    (raw) => typeof raw === 'object' && raw !== null && 'route' in (raw as Record<string, unknown>),
  );
  if (declared.length > 0) {
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue;
      const row = raw as Record<string, unknown>;
      const named = typeof row['capability'] === 'string' ? row['capability'] : 'an unnamed class';
      if (!('route' in row)) {
        throw new CrucibleRefused(
          200,
          'capability_route_missing',
          `its capability record says where some classes run and not "${named}". Nothing here can `
          + 'tell whether that class is on its card or on an upstream account, and guessing is not '
          + 'this app\'s to do.',
          null,
        );
      }
      if (row['route'] !== 'local' && row['route'] !== 'upstream') {
        throw new CrucibleRefused(
          200,
          'capability_route_unknown',
          `it says "${named}" runs by a route this build has never heard of `
          + `(${JSON.stringify(row['route'])}) — a newer Crucible than this Foundry, most likely.`,
          null,
        );
      }
    }
  }

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
        /*
         * BY HERE THE DOCUMENT HAS ALREADY BEEN JUDGED — the pass above refused
         * anything partial or unknown — so absence can only be the pre-PHASE15
         * document, whose every class IS local. One word, one meaning.
         */
        route: row['route'] === 'upstream' ? 'upstream' : 'local',
      }];
    }),
  };
}
