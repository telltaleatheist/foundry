/**
 * crucible-dispatch-crucible — placing on a Crucible: a resident model, or an upstream route.
 */
import { clientFor, resolveEngine } from './crucible-registry';
import { type CrucibleServerEntry } from './app-settings';
import { LLM_CLASSES } from '../shared/engine-settings';
import { upstreamLaneName } from '../shared/queue-board';
import { type ComputeSlot } from '../shared/slots';
import { CAPABILITY_WORDS, readCapability } from './crucible-dispatch-capability';
import type { CapabilityClass } from './crucible-dispatch-capability';
import { chatDepthFor } from './crucible-dispatch-depth';
import type { LaneClaim, PlacementProgress } from './crucible-dispatch-place';
import { standingWait, transientWait } from './crucible-dispatch-placement';
import type { PlacementOutcome } from './crucible-dispatch-placement';
import { personReasonOf } from './crucible-dispatch-reasons';
import { headerMapFor, openSession } from './crucible-dispatch-session';

/**
 * OUR OWN RUN IS AS GOOD A REASON TO STEP PAST AS SOMEBODY ELSE'S, and it is the
 * one this app is authoritative about: a Crucible serving a passthrough chat does
 * not report itself busy, so the lane is the only thing standing between two of
 * our books and one card. The sentence names the app rather than the job, because
 * a person reading a parked row is looking at the bench, where the job that is in
 * the way already names itself.
 */
export function busyWithOurs(lane: string): string {
  return `"${lane}" is already running a job of yours`;
}

export async function placeOnCrucible(
  entry: CrucibleServerEntry,
  slot: ComputeSlot,
  capability: CapabilityClass,
  say: PlacementProgress,
  claim: LaneClaim,
  signal?: AbortSignal,
  chosenModel?: string,
  /** The run's measured floor, for the session (`openSession`); absent states none. */
  contextTokens?: number,
): Promise<PlacementOutcome> {
  /*
   * ── THE ADDRESS IN THE REGISTRY MAY NOT BE THE ENGINE'S ───────────────────
   *
   * crucible docs/PHASE17-ORCHESTRATOR.md §6. A registered address can be an
   * ORCHESTRATOR — the Windows tray on `:7101`, which manages the WSL engine on
   * `:7100` and serves no job types of its own — and everything below this line
   * is engine work: the residency listing, the load, the lease, and the
   * `<url>/openai` door the spawn is pointed at. So the hop is followed ONCE,
   * here, and `engine` is what the rest of this function uses. It carries the
   * SAME TOKEN, which is the contract's own rule and the reason nothing else
   * about the entry changes.
   *
   * IT IS RESOLVED ONCE AND THE ADDRESS IS TAKEN FROM THE RESOLUTION, rather
   * than a client being fetched here and a url composed from `entry` further
   * down — that pairing is how a request goes to one process and a spawn is
   * pointed at another. `resolveEngine` caches, so `readCapability` below costs
   * no second round trip.
   */
  const engine = (await resolveEngine(entry)).entry;
  const client = clientFor(engine);

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
  /*
   * ── A CLEANUP AND ITS TRIAGE ARE SIZED BY THIS APP (Owen, 2026-10-25) ─────
   *
   * *"i think bookforge should make the decision about which model is used for
   * cleanup. we should just call the model in chat. maximum of 27b. but whatever
   * is the biggest model we can get up to that point."* And of the triage:
   * *"should stay on 9b for now."*
   *
   * So neither reads the server's `clean` row any more. Each asks its own verb
   * for the biggest model at or under its ceiling — Crucible's own lever, which
   * only ever lowers the server's pick — and goes on with that id exactly as it
   * went on with `row.selected`. The ceiling is the ACT's, not the job kind's,
   * which is why a decide (the cleanup's triage, and the analysis's ranking,
   * which took the cleaner's row for the same reason) is 9 and a clean is 27. A
   * resolved model is on the server's own card, so these acts never forward to
   * an upstream.
   */
  /*
   * ── A MODEL THE JOB WAS TOLD (Owen, 2026-10-25) ───────────────────────────
   *
   * A person picked it in the job's dialog, so it is neither sized nor checked
   * against a ceiling: an upstream id is forwarded, and a local one goes the
   * resident way, where a model that server does not list is refused by name.
   * Only a chat act takes a choice; a decide or a page keeps this app's sizing,
   * since a dialog never offers one for it.
   */
  if (chosenModel !== undefined && chosenModel !== '' && (LLM_CLASSES as readonly string[]).includes(capability)) {
    return chosenModel.includes('/')
      ? placeUpstream(engine, slot, capability, chosenModel, say, claim)
      : placeResidentModel(engine, slot, capability, chosenModel, say, claim, signal, contextTokens);
  }

  const sized = APP_SIZED_MODELS[capability];
  if (sized !== undefined) {
    const pick = await client.resolve({ verb: sized.verb, maxParamsB: sized.ceilingB });
    signal?.throwIfAborted();
    const asked = `the biggest ${sized.verb === 'decide' ? 'decision' : 'chat'} model up to ${sized.ceilingB}B`;
    if (pick.refused !== null || pick.model === null || pick.model === '') {
      /*
       * A STANDING WAIT, for the reason a disabled row is one: it is this
       * server's answer about its own card, and the next machine in the ranking
       * is a different question.
       */
      const why = pick.refused === null ? 'it named none' : pick.refused.message;
      return standingWait(`"${slot.name}" has no ${asked} for ${CAPABILITY_WORDS[capability].noun} work — ${why}`);
    }
    if (pick.fit !== null && !pick.fit.fits) {
      const short = (pick.fit.needBytes - pick.fit.availableBytes) / 1024 ** 3;
      return standingWait(
        `"${slot.name}" named ${pick.model} as ${asked} and it does not fit its card (${short.toFixed(1)} GiB short)`,
      );
    }
    return placeResidentModel(engine, slot, capability, pick.model, say, claim, signal, contextTokens);
  }

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
     *
     * ── AND IT IS A **STANDING** WAIT, WHICH IS THE HALF THAT WAS WRONG ──────
     *
     * The walk above is right and is unchanged. What was wrong is what happened
     * afterwards: `placeRun` parked this for ever, so a row pinned to a machine
     * whose record says it cannot do this act never finished and never failed.
     * BookForge found it and named it — *"a row that neither fails nor finishes
     * is worse than either."* Nothing the queue does on a timer moves a card's
     * measurement; a person does, from that engine's own settings. See
     * {@link PlacementWait}.
     */
    const shortfall = row.shortfallBytes !== null && row.shortfallBytes > 0
      ? ` (${(row.shortfallBytes / 1024 ** 3).toFixed(1)} GiB short)`
      : '';
    return standingWait(
      `"${slot.name}" can't ${CAPABILITY_WORDS[capability].verb} — ${personReasonOf(row)}${shortfall}`,
    );
  }

  return placeResidentModel(engine, slot, capability, row.selected, say, claim, signal, contextTokens);
}

/**
 * THE MODELS THIS APP SIZES ITSELF: the verb asked, and a ceiling in billions of
 * parameters on it (Owen, 2026-10-25 — see `placeOnCrucible`). A cleanup, a
 * translation, a simplify and an analysis are chats (`generate`): *"it should
 * probably call crucible's chat verb"*, *"keep it at 27b as the max right now"*.
 * A triage and a ranking are decisions, asked of the decide verb's own lineup
 * (Crucible 2.0.30 gave it the ceiling). Only `pages` still takes its server's
 * capability row.
 *
 * `decide` IS 9 BECAUSE THE TRIAGE MEASURED THERE (2026-09-25): qwen3.5-2b's
 * yes/no never separated sentences that need cleaning from ones that do not
 * (AUC 0.55–0.82, nearly everything flagged); qwen3.5-9b did (AUC 0.89 and
 * 0.976, 331 of 335 caught). It used to be reached by asking the decide door
 * for the `clean` row's model; that row is no longer read, so the 9B is said
 * here. The analysis's ranking is a decide too (Owen: *"9b for triage"*), so
 * it takes the same ceiling — the act, not the job kind, is what is sized.
 *
 * The id the server names is what the decide is then sent with, as before.
 */
export const APP_SIZED_MODELS: Readonly<Partial<Record<CapabilityClass, { verb: 'generate' | 'decide'; ceilingB: number }>>> = {
  clean: { verb: 'generate', ceilingB: 27 },
  translate: { verb: 'generate', ceilingB: 27 },
  simplify: { verb: 'generate', ceilingB: 27 },
  analysis: { verb: 'generate', ceilingB: 27 },
  decide: { verb: 'decide', ceilingB: 9 },
};

/**
 * EVERYTHING AFTER THE MODEL IS CHOSEN, for a model on the server's own card:
 * the card lane, the listing check, the session and the depth. Whoever chose it
 * — the capability row or this app's ceiling — the placement is the same.
 */
export async function placeResidentModel(
  engine: CrucibleServerEntry,
  slot: ComputeSlot,
  capability: CapabilityClass,
  selected: string,
  say: PlacementProgress,
  claim: LaneClaim,
  signal?: AbortSignal,
  contextTokens?: number,
): Promise<PlacementOutcome> {
  const client = clientFor(engine);

  /*
   * THE CARD LANE, TAKEN BEFORE A MODEL IS LOADED ONTO IT. Below this line
   * everything is about a machine's GPU — the residency, the eviction, the lease
   * — and none of it may be done on a card another run of ours is holding.
   */
  if (!claim(slot.name)) {
    return transientWait(busyWithOurs(slot.name));
  }

  /*
   * ── THE MODEL MUST BE ONE THE SERVER LISTS ────────────────────────────────
   *
   * The server chose it — its capability record, or its answer to this app's
   * ceiling — so a listing without it is the server disagreeing with itself.
   * Whether it is RESIDENT no longer matters here: the session below opens with
   * it loaded (Crucible 1.0.76 — `model` on `POST /v1/queue/sessions`, loaded
   * by the server for the session).
   */
  const models = await client.models();
  signal?.throwIfAborted();
  const listed = models.find((model) => model.id === selected);
  if (listed === undefined) {
    return {
      verdict: 'refuse',
      reason: `"${slot.name}" selected ${selected} for ${capability} work and then did not list it. `
        + 'That is its own record disagreeing with itself; nothing here can fix it.',
    };
  }

  /*
   * ── THE SESSION, WHICH IS THE LAST THING BEFORE THE SPAWN ─────────────────
   *
   * Crucible 1.0.76 replaced the load-then-lease pair with ONE act: a queue
   * session (crucible docs/QUEUE.md, sdk/ts/MIGRATION.md). It waits in the
   * server's line — first come, first served — and opens with `selected`
   * resident; while it is open nothing from any other client runs there. So the
   * two windows the old pair had to close by hand are gone: there is no moment
   * between a load and its lease, and a load cancelled by a Stop is the server's
   * to settle (aborting `signal` takes a waiting session out of the line, and a
   * session that already opened is closed by the settle like any other).
   *
   * The engine's own chats are ITEMS of it because they carry this install's
   * client name (`headerMapFor`), and the session is touched while the run lives
   * ({@link openSession}).
   */
  say(listed.resident
    ? `Asking ${slot.name} for its turn…`
    : `Asking ${slot.name} for its turn and loading ${selected}…`);
  const session = await openSession(
    engine, { model: selected }, capability, slot.name, say, signal, contextTokens);

  /*
   * ── THE DEPTH IS ASKED FOR AFTER THE MODEL IS RESIDENT ─────────────────
   *
   * A Crucible's chat admission belongs to the RESIDENT engine — its
   * concurrency plus one — so with nothing loaded `chat.maxInFlight` is null by
   * design, and may differ per model (sized by memory). Read here, once the
   * session has opened with the model resident, it is the number the server
   * admits for the model this run will use. `statedChatDepth` cannot throw.
   */
  const concurrency = await chatDepthFor(engine, capability, say);

  return {
    verdict: 'go',
    placement: {
      slot,
      session,
      /*
       * HOW DEEP TO GO ON THIS CARD — the server's number when it states one, and
       * four when it does not. See `Placement.concurrency` and `chatDepthFor`.
       */
      concurrency,
      /*
       * `openai` IS THE ENGINE'S DEFAULT AND IS LEFT UNSPELLED on the command
       * line — see `doorArgs` in job-queue.ts. Named here so a reader of the
       * placement need not know the default.
       */
      door: 'openai',
      /*
       * THE OPENAI DOOR IS MOUNTED AT `<url>/openai`, and the engine appends
       * `/v1` itself. `engine.url` is the resolved one — see the hop at the top
       * of this function.
       */
      endpoint: `${engine.url}/openai`,
      /*
       * AND THE ENGINE ITSELF, WITH NO DOOR ON IT — what the cleanup's triage is
       * pointed at (`/v1/decide`). See `Placement.origin`.
       */
      origin: engine.url,
      model: selected,
      env: { FOUNDRY_ENDPOINT_HEADERS: headerMapFor(engine, capability) },
      /** A resident model on that machine's card. Nothing was forwarded. */
      via: null,
    },
  };
}

/**
 * A JOB FORWARDED TO AN UPSTREAM ACCOUNT: the same door, and nothing on the card.
 *
 * The model is the one a person chose for this job in its dialog — it used to be
 * the server's route for the whole class, and that route is retired with the
 * class (Owen, 2026-10-25).
 *
 * PHASE15 §3.4 — a `model` with a slash is FORWARDED by the server on the
 * operator's account, *"no lease, no lane, the settlement untouched (nothing was
 * on the card)"*, and a lease or a `load-model` naming one is refused
 * `lease_not_needed`. Owen, the same day: *"one contract, one SDK, one API, one
 * communication method."* So the three things the local path does are all
 * skipped, each because it would be a request about a model on nobody's card:
 * no `models()` (the RESIDENCY listing never holds an upstream model), no load
 * (nothing to warm) and no session (a load there cannot evict what it never
 * loaded).
 *
 * WHAT IS IDENTICAL IS THE SEAM. The same `/openai` endpoint, the same header
 * map with `X-Crucible-Act` still naming the act (so `/v1/activity` says
 * "translating on anthropic"), the same door. The app does not know or care
 * where the answer came from.
 *
 * AND THE LANE IS THE SERVER'S `[cloud]` ONE, claimed here — the first moment
 * anything in this process knows which of the slot's two lanes this run wants.
 */
export async function placeUpstream(
  engine: CrucibleServerEntry,
  slot: ComputeSlot,
  capability: CapabilityClass,
  model: string,
  say: PlacementProgress,
  claim: LaneClaim,
): Promise<PlacementOutcome> {
  const cut = model.indexOf('/');
  if (cut <= 0) {
    // A dialog only ever offers `<upstream>/<model>`, so a bare id here is a
    // caller's mistake, refused by name rather than read as a local model.
    return {
      verdict: 'refuse',
      reason: `"${model}" was asked to be forwarded and names no upstream (it should read <upstream>/<model>).`,
    };
  }
  const via = model.slice(0, cut);
  /*
   * ── ONLY A CHAT CAN BE FORWARDED ──────────────────────────────────────────
   *
   * A decide is read off a resident model's logits and a page off a vision
   * model on the card; no upstream serves either (`POST /v1/decide` refuses an
   * upstream id by name). `LLM_CLASSES` is the four chat acts. A refusal rather
   * than a wait: the job says the same thing on every pass.
   */
  if (!(LLM_CLASSES as readonly string[]).includes(capability)) {
    return {
      verdict: 'refuse',
      reason: `${CAPABILITY_WORDS[capability].noun} work cannot be forwarded to ${via} — it has to `
        + "run on a model on the server's own card.",
    };
  }
  const lane = upstreamLaneName(slot.name);
  if (!claim(lane)) {
    return transientWait(
      `"${slot.name}" is already forwarding as many jobs of yours to ${via} as it will at once`,
    );
  }
  say(`Sending ${capability} to ${slot.name} via ${via} (${model})`);
  return {
    verdict: 'go',
    placement: {
      slot,
      session: null,
      via,
      door: 'openai',
      /*
       * The depth this app keeps against a door it does not own. The SERVER's
       * own admission limit when it states one, four when it does not — an
       * upstream rations by an account's rate limit rather than by a card, so
       * a forwarding Crucible usually states nothing and four stands (ruling
       * 4). `chatDepthFor` carries the argument and says which happened.
       */
      concurrency: await chatDepthFor(engine, capability, say),
      // THE ENGINE'S ADDRESS, not the registered one — see the hop at the top
      // of `placeOnCrucible`. A `<orchestrator>/openai` would be a spawn pointed
      // at a process with no route to serve it.
      endpoint: `${engine.url}/openai`,
      // The same engine, stated bare. See `Placement.origin`.
      origin: engine.url,
      model,
      env: { FOUNDRY_ENDPOINT_HEADERS: headerMapFor(engine, capability) },
    },
  };
}
