/**
 * crucible-dispatch-place — placing a job, and routing it to the placer for its venue.
 */
import { crucibleServerNamed, engineSharedWith, enginelessServers, slotAvailability } from './crucible-registry';
import { readAppSettings } from './app-settings';
import { ANY_SLOT, GPU_DIAL_ANY, slotNamed, type ComputeSlot, type VenueSource } from '../shared/slots';
import type { JobKind } from '../shared/types';
import { CAPABILITY_WORDS, capabilityClassOf, placesOnASlot } from './crucible-dispatch-capability';
import type { CapabilityClass } from './crucible-dispatch-capability';
import { placeOnCloud } from './crucible-dispatch-cloud';
import { busyWithOurs, placeOnCrucible } from './crucible-dispatch-crucible';
import { interpretFailure } from './crucible-dispatch-failure';
import { UNPLACED, transientWait } from './crucible-dispatch-placement';
import type { PlacementOutcome } from './crucible-dispatch-placement';
import { noEngineReason, orAnyWords, whatToDoAbout } from './crucible-dispatch-reasons';

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
 * the one slot kind that needs no read (a cloud provider, which Package L
 * deletes; the local slot was the other, and Wave 66 deleted it).
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
  signal?: AbortSignal,
  /**
   * The model a person chose for THIS job in its dialog (Owen, 2026-10-25) — one
   * on the server's card, or an `<upstream>/<model>` the server forwards. Absent
   * is the server's own pick at this app's ceiling ({@link APP_SIZED_MODELS}).
   */
  chosenModel?: string,
  /**
   * The least context this run's largest request needs, measured from its own
   * book before it was placed (job-queue-carry.ts `measureRun`). Absent for a
   * kind that measures nothing (a page reading, an analysis's ranking) and for
   * a run whose rules settle everything.
   */
  contextTokens?: number,
): Promise<PlacementOutcome> {
  const available = slotAvailability();
  const slots = available.slots;
  const capability = capabilityClassOf(kind);
  /*
   * NOTHING TO DECIDE, and it is now ONE way rather than three: this job never
   * meets a model (an export, a mint, an install). It claims no lane, and the
   * pump is why — such a row is a run on THIS machine and `laneAtPick` settles it
   * before the pick (`placesOnASlot` is the shared half of this test), so
   * claiming here as well would be a second owner of one reservation.
   *
   * `capability === null` IS `placesOnASlot`'s FIRST CLAUSE, repeated for the
   * compiler rather than for the reader: the walk below needs the class narrowed
   * to a non-null one, and a predicate in another function cannot narrow a local.
   */
  if (capability === null || !placesOnASlot(kind)) {
    return { verdict: 'go', placement: UNPLACED };
  }
  /*
   * ── AND AN EMPTY SLOT LIST IS A REFUSAL NOW, NOT A LOCAL RUN (Wave 66) ────
   *
   * It used to fall through to {@link UNPLACED} and run against this machine's
   * Ollama, because there was always a local slot behind it. Owen deleted it:
   * *"everything goes through a crucible server now, including local… there
   * should be no local gpu listed in the queue."* With nothing registered there
   * is nowhere for this act to go, and the honest answer is to say so ONCE, by
   * name, with the thing a person can do about it — not to park the row for ever
   * on the hope that a server appears, and not to run somewhere nobody chose.
   */
  if (slots.length === 0) {
    return { verdict: 'refuse', reason: noEngineReason(available.refusal) };
  }

  /*
   * ── THE LIVE QUEUE'S DIAL, AND THE ONE PLACE THE TWO CONTROLS MEET ───────
   *
   * Owen, 2026-09-15: *"a queue item is in pending, then the crucible server is
   * chosen (even if thats 'any'), and it's sent to the live queue. the live
   * queue distributes it to the correct crucible server depending on what the
   * live queue is set to — any, or a specific crucible server."* And the gate:
   * *"if the queue has 'm1 ultra' set as the crucible server, but the job item
   * is set to 3090 ti … the queue doesnt process it until the global queue
   * unlocks the 3090 ti."*
   *
   * THE DIAL RESTRICTS; IT DOES NOT REDIRECT. A row that named a machine and
   * disagrees with the dial WAITS. Sending it to the dial's machine instead
   * would be this app overruling a choice somebody made on purpose, silently,
   * and the row would finish on a card they did not pick.
   *
   * HERE AND NOT IN THE PUMP, because this is the function that already owns
   * "which machine does this row want" and every sentence about not getting
   * one. A second gate in `canStart` would be a second answer to that question,
   * and `canStart` has no sentence to say — it returns a boolean, so a row it
   * refused would sit queued with nothing on it (`docs/SLOTS.md`: *"a row that
   * neither fails nor finishes is worse than either"*).
   *
   * THE SOURCE TRAVELS WITH THE CHOICE from this line onwards. `row` when the
   * book named the machine, `dial` when the book said Any and the dial chose —
   * see {@link VenueSource}, and `orAnyWords`, which is the only reason the
   * distinction is carried at all.
   *
   * ── AND IT IS ONE VALUE, NOT TWO, SO A SOURCE CANNOT OUTLIVE ITS VENUE ────
   *
   * This was `let pinned` beside `let source: VenueSource = 'row'`, which was
   * correct only by an argument: `source` is read where `pinned` is non-null,
   * and in the both-open case (the book says Any and so does the dial) `pinned`
   * is null, so the `'row'` initialiser — the WRONG tail for that case, since
   * the book already says Any — was never reached. Safe, and safe by reasoning
   * about a path rather than by construction.
   *
   * BookForge's module has no such initialiser and said plainly why: their
   * `source` is a REQUIRED parameter, so *"if I had written a default it would
   * have been 'row' and it would have had exactly your bug. The thing that saved
   * it was making the parameter required."* The same shape here is one nullable
   * object: there is no source without the machine it describes, so the default
   * that could be wrong has nowhere to live.
   */
  // The registry can collapse an orchestrator and its engine onto one lane.
  // Existing queue selections remain valid aliases for that same engine.
  const canonical = (name: string): string => engineSharedWith(name) ?? name;
  const dial = canonical(readAppSettings().queueGpuDial);
  const asked = waitFor !== undefined && waitFor !== ANY_SLOT ? canonical(waitFor) : null;
  if (dial !== GPU_DIAL_ANY && asked !== null && asked.toLowerCase() !== dial.toLowerCase()) {
    /*
     * THE DISAGREEMENT, and it is a TRANSIENT wait rather than a refusal: the
     * dial is one control away from agreeing, and failing the row would throw
     * its queue position away for a gesture somebody is about to make. It is
     * `dial`-sourced, so the tail says to turn the dial — telling somebody to
     * set this book to Any would be telling them to abandon the machine they
     * deliberately chose.
     */
    return transientWait(
      `waiting for "${asked}", and the queue's GPU dial is set to "${dial}"`
      + `${orAnyWords('dial')}`,
    );
  }
  /*
   * Past the disagreement there are exactly three shapes, and each carries its
   * own source: the dial chose (the book asked for nothing), the book chose
   * (with the dial open, or agreeing), or nobody chose and the walk decides.
   */
  const venue: { name: string; source: VenueSource } | null = dial !== GPU_DIAL_ANY
    ? { name: dial, source: asked === null ? 'dial' : 'row' }
    : asked === null ? null : { name: asked, source: 'row' };

  if (venue !== null) {
    const pinned = venue.name;
    const slot = slotNamed(slots, pinned);
    if (slot === null) {
      /*
       * THE ONE REASON A NAMED SERVER IS NOT A SLOT WHILE STILL BEING REGISTERED
       * AND SWITCHED ON: it resolved to an orchestrator with no engine behind it
       * (`engineAbsence`, crucible-registry.ts, and PHASE17 §6). That is not
       * something a backoff fixes — somebody installs an engine on that machine
       * or re-points the row — so the row FAILS with the resolver's own sentence,
       * which names both. Parking it under "switched off or no longer registered"
       * would be a wrong sentence about a row that would then never finish.
       */
      const absent = enginelessServers().find(
        (server) => server.name.toLowerCase() === pinned.toLowerCase(),
      );
      if (absent !== undefined) return { verdict: 'refuse', reason: absent.sentence };
      /*
       * A row waiting for a slot that is not in the list — switched off, renamed
       * or removed while the row sat in the queue. It WAITS rather than fails,
       * because switching a server back on is a gesture somebody is about to
       * make and a failed row would have thrown the queue position away for a
       * toggle. The Servers card offers the other fix (reassign these rows to
       * "any") at the moment the switch is flipped, so nobody has to find this
       * sentence to learn what happened.
       */
      /*
       * THE SOURCE IS WHY THIS SENTENCE IS NOT A CONSTANT. The machine that is
       * switched off may be the one the BOOK named or the one the DIAL named,
       * the cause reads identically either way, and the two want opposite
       * gestures. Before the dial existed there was only one source and the
       * tail could be assumed; it cannot be now.
       */
      return transientWait(
        `waiting for "${pinned}", which is switched off or no longer registered`
        + `${orAnyWords(venue.source)}`,
      );
    }
    /*
     * A PINNED ROW HAS NO WALK LEFT, so a standing refusal from its one slot is
     * the end of the line: there is no next machine to be a different question,
     * and parking would be this queue asking the same server the same thing
     * twice a minute until somebody noticed the row. It FAILS, with the server's
     * own reason and the two things a person can do about it.
     */
    const outcome = await placeOn(slot, capability, say, claim, signal, chosenModel, contextTokens);
    return outcome.verdict === 'wait' && outcome.standing
      ? { verdict: 'refuse', reason: `${outcome.reason}. ${whatToDoAbout(capability)}` }
      : outcome;
  }

  const reasons: string[] = [];
  /*
   * DID EVERY CANDIDATE ANSWER WITH SOMETHING ONLY A PERSON CAN CHANGE? Starts
   * true and is falsified by the first transient wait, so a walk that found
   * nothing at all (no candidates) stays true and is still reported as the
   * `no slot is available` wait below — `reasons.length === 0` is tested first.
   */
  let allStanding = true;
  for (const slot of slots) {
    if (slot.kind === 'cloud') {
      /*
       * STEPPED PAST, AND IT IS A STANDING ANSWER. docs/SLOTS.md §3's ruling —
       * a cloud slot is *"a deliberate per-job choice, never something `any`
       * falls through to"* — is permanent, so this walk will answer identically
       * on every pass until a PERSON puts the provider's name on the row. That
       * is the definition one type up, and it is why a board whose only slot is
       * a provider now fails its `any` rows with a sentence naming the picker
       * instead of parking them for ever.
       */
      reasons.push(`"${slot.name}" is a cloud provider, and cloud slots are chosen on purpose`);
      continue;
    }
    const outcome = await placeOn(slot, capability, say, claim, signal, chosenModel, contextTokens);
    if (outcome.verdict === 'go') return outcome;
    if (outcome.verdict === 'refuse') return outcome;
    if (!outcome.standing) allStanding = false;
    reasons.push(outcome.reason);
  }
  if (reasons.length === 0) return transientWait('no slot is available');
  return allStanding
    ? {
      verdict: 'refuse',
      reason: `no server can ${CAPABILITY_WORDS[capability].verb} — ${reasons.join('; ')}. ${whatToDoAbout(capability)}`,
    }
    : transientWait(`no slot is free — ${reasons.join('; ')}`);
}

/**
 * One slot, asked whether it will start this act now.
 *
 * THE ONE KIND THAT NEEDS NO SERVER CLAIMS HERE. A cloud provider is one key: no
 * second lane and no route to read, so its lane is knowable without a request and
 * is taken before the placement is built. The Crucible path claims inside
 * `placeOnCrucible`, after the route is known — see `placeJob`'s note on where
 * the claim moved. (The local slot used to be the other such kind, and there is
 * no local slot.)
 */
export async function placeOn(
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
  claim: LaneClaim,
  signal?: AbortSignal,
  chosenModel?: string,
  contextTokens?: number,
): Promise<PlacementOutcome> {
  if (signal?.aborted) return transientWait('The request was cancelled.');
  if (slot.kind === 'cloud') {
    if (!claim(slot.name)) return transientWait(busyWithOurs(slot.name));
    return placeOnCloud(slot, capability);
  }
  const entry = crucibleServerNamed(slot.name);
  if (entry === null) {
    // TRANSIENT, on the same argument as a pinned slot that is switched off: the
    // registry moved under this walk, and re-registering is a gesture somebody
    // is about to make.
    return transientWait(`"${slot.name}" is no longer registered`);
  }
  try {
    return await placeOnCrucible(entry, slot, capability, say, claim, signal, chosenModel, contextTokens);
  } catch (err) {
    // A STOP WHILE THE SESSION WAITED IN THE LINE: the SDK has already taken it
    // out of the line and throws the abort itself, which is our own gesture and
    // not a refusal of the server's to interpret.
    if (signal?.aborted) return transientWait('The request was cancelled.');
    return interpretFailure(err, slot.name, capability);
  }
}
