/**
 * crucible-dispatch-placement — what a placement is, the one that placed nothing, and the outcomes and waits every placer answers with.
 */
import { type ComputeSlot } from '../shared/slots';
import type { LlmServerKind } from '../shared/pipeline';
import type { HeldSession } from './crucible-dispatch-session';

/**
 * WHERE THIS JOB'S ENGINE WILL POINT — everything the spawn needs, and nothing
 * about the queue.
 *
 * `endpoint` and `model` are NULLABLE and null means "the request's own", which
 * is {@link UNPLACED}'s whole answer: the URL and the model tag the person chose
 * in the dialog are on the request already, and a placement that copied them here
 * would be a second owner of a per-run choice. Every PLACED run fills both in,
 * because a slot's endpoint and a server's selected model are nobody's preference
 * (docs/SLOTS.md §5).
 */
export interface Placement {
  /**
   * WHOSE MACHINE THIS RUN WENT TO — or NULL for a run that was never placed on
   * one at all.
   *
   * Null is not "undecided" and it is not a failure: it is the whole answer for a
   * job that puts nothing in front of a model (an export, a compile, a mint, an
   * environment install). Those run on this machine's disk and this machine's
   * cores, which Owen's ruling keeps here — *"cpu slots are always local. we dont
   * outsource simple cpu work to crucible"* — and there is no slot for that work
   * to name, because the CPU side of the board is a count rather than a list.
   *
   * IT USED TO BE THE LOCAL SLOT, and the field was never nullable: a job like
   * that was placed on a slot called "This computer" and recorded as having run
   * there. That slot is gone (Wave 66), and inventing a name for a machine the
   * list no longer carries would put a string in front of a person that nothing
   * else in the app says. {@link UNPLACED} is the one value that carries it.
   */
  slot: ComputeSlot | null;
  /**
   * Which engine dialect. `openai` is the engine's default and goes unspelled on
   * the command line; `ollama` and `anthropic` are both written out (`doorArgs`,
   * electron/job-queue.ts), because the engine refuses an unknown value by name
   * and a door left unsaid would be the default answering for it.
   */
  door: LlmServerKind;
  /** `--endpoint`, or null to use the request's own. */
  endpoint: string | null;
  /**
   * THE CRUCIBLE ENGINE'S OWN BASE ADDRESS — `http://host:port`, no door on it —
   * or NULL for a run that never met a Crucible.
   *
   * ── Why a second address beside `endpoint` ─────────────────────────────────
   *
   * `endpoint` is a CHAT door, `<engine>/openai`, because every act that meets a
   * model through it speaks the OpenAI dialect and the engine appends `/v1`. The
   * cleanup's triage speaks no dialect: it POSTs Crucible's own `/v1/decide`,
   * which reads the resident model's belief in two letters, so the engine it
   * spawns has to be handed the server itself (`clean-triage --endpoint`, which
   * strips a trailing `/v1` and never an `/openai`). Deriving it by cutting
   * `/openai` off `endpoint` would be this app parsing its own routing decision
   * back out of a string — the thing `endpoint`'s composition exists to never
   * need — so the placement states it, from the same `engine.url` the door is
   * composed from.
   *
   * THE ENGINE'S, NOT THE REGISTERED ADDRESS: after PHASE17 a registered URL may
   * be the orchestrator's, which serves no job types, and `placeOnCrucible` has
   * already followed the hop. Null on {@link UNPLACED} and on a cloud provider,
   * neither of which is a Crucible; `argsFor` refuses a triage that arrives with
   * it null, by name.
   */
  origin: string | null;
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
   * THIS RUN'S TURN HOLDING THE MACHINE — a Crucible queue session, held for the
   * length of the run (Crucible 1.0.76, which replaced leases).
   *
   * Null on every placement that never touched a Crucible, AND on a Crucible
   * placement whose route is upstream — PHASE15 §3.4: *"no lease, no lane, the
   * settlement untouched (nothing was on the card)"*. Non-null placements MUST be
   * released — see {@link HeldSession}. `settled` (electron/job-queue.ts) reads
   * an absent session as nothing to release.
   */
  session: HeldSession | null;
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
  /**
   * `--concurrency`: HOW MANY BLOCKS THE ENGINE MAY HAVE IN FLIGHT AT ONCE, stated
   * by the PLACEMENT because it is a property of the server that answered.
   *
   * ── The night this closes (BookForge's hunt, F3a) ──────────────────────────
   *
   * Nothing set it. The request's field was optional and no door on either side
   * filled it, so every text act took the ENGINE's own default —
   * `DEFAULT_TEXT_CONCURRENCY = 12` (src/translate/model-server.ts), whose own
   * docblock states the assumption that makes twelve safe: *"the server admits
   * what fits in its KV cache and QUEUES the rest"*. That is false against a
   * Crucible chat proxy fronting a serial `mlx_lm`: the twelfth request's
   * 300-second clock is armed at SEND and covers the eleven ahead of it, so any
   * per-block time over ~27 s times the tail out. The failure was the queueing,
   * never the model.
   *
   * ── Why the placement and not the request ─────────────────────────────────
   *
   * `crucible-dispatch.ts` is the only module that knows WHICH server answered,
   * and depth is a fact about that machine — the page reader has always taken its
   * number from the server that serves the pages. A number on the request would be
   * a person's preference about somebody else's backend.
   *
   * ── THE SERVER'S NUMBER, AND FOUR ONLY WHEN IT STATES NONE ────────────────
   *
   * Owen's ruling 4 of 2026-09-20, off the Mac's 2026-09-08 measurement, was 4 on
   * a Crucible chat door *until the server states a number of its own*. Crucible
   * 1.0.10 states one the same day: `chat.max_in_flight` on `/v1/activity` — 2 on
   * the Mac's serial `mlx-lm`, nothing at all from a vLLM, which batches. It is
   * an ADMISSION limit and not a throughput opinion: past it a request is refused
   * `503 chat_queue_full` rather than queued, which is how four went out against
   * an admission of two and killed a clean pass. So the placement asks
   * (`chatDepthFor`) and {@link CRUCIBLE_CHAT_CONCURRENCY} is now the UNSTATED
   * fallback.
   *
   * THE ENGINE CLAMPS TO IT AS WELL, and that is not a second copy of this rule —
   * it is the same rule applied to a number that may be STALE. This app's dist
   * outlives the server it places against: a build already running keeps sending
   * the depth it was compiled to send, and cannot be corrected without a restart.
   * So `resolveConcurrency` (src/translate/model-server.ts) reads the same field
   * and refuses to keep a pool above it whatever `--concurrency` said, honouring
   * anything BELOW it untouched. Two readers, one authority: the server's.
   *
   * NULL IS "THE REQUEST'S OWN", exactly as `endpoint` and `model` are null on
   * {@link UNPLACED}: a job that never meets a model states no depth, and a dry run
   * prints the request's own number or no flag at all.
   */
  concurrency: number | null;
}

/**
 * THE PLACEMENT NOTHING PICKED — what a job takes when it never meets a model.
 *
 * ── What it means NOW, which is narrower than what it used to mean ──────────
 *
 * It was "there is no slot list, so run the way this app ran before slots
 * existed": a person with no Crucible, and a hosted window whose host registers
 * no slot provider, both landed here and both ran against this machine's Ollama.
 * Owen's ruling ended that — *"there should be no local gpu listed in the queue"*
 * — so an empty slot list is now a REFUSAL for anything that needs a card
 * ({@link placeJob}), and this value is left to the jobs it was always honest
 * for: the ones with no capability class at all. An export, a compile, a
 * rasterise, an environment install. They take `slot: null` because the CPU side
 * of the board is not a list of machines, and `door: 'ollama'` with a null
 * endpoint and a null model because that is what "the request's own" means on the
 * one command line they still spell (`argsFor`, electron/job-queue.ts, whose
 * `--dry-run` caller has no server to ask).
 */
export const UNPLACED: Placement = {
  slot: null,
  door: 'ollama',
  endpoint: null,
  // NOT A CRUCIBLE, so there is no engine address to state. See `Placement.origin`.
  origin: null,
  model: null,
  env: {},
  session: null,
  via: null,
  // NOTHING TO SAY: this job meets no model, so there is no server whose depth
  // this could be. `doorArgs` then falls back to the request's own number, which
  // is what a dry run prints.
  concurrency: null,
};

export type PlacementOutcome =
  | { verdict: 'go'; placement: Placement }
  /** Try again later — the server's state, not the request. See the module note. */
  | PlacementWait
  /** This will be refused the same way everywhere. Fail the row and say so once. */
  | { verdict: 'refuse'; reason: string };

/**
 * A WAIT, AND WHETHER TIME ALONE WILL EVER FIX IT.
 *
 * ── The defect this field closes, in BookForge's words ─────────────────────
 *
 * *"A row that neither fails nor finishes is worse than either."* `placeRun`
 * (electron/job-queue.ts) parks a `wait` and retries with a backoff capped at
 * thirty seconds, FOR EVER — which is exactly right for a busy card and exactly
 * wrong for a capability record that says this machine cannot do this act. A row
 * pinned to such a server, or an `any` row where no slot can, used to sit in the
 * queue until somebody noticed.
 *
 * ── The distinction, and it is about WHO can change the answer ─────────────
 *
 *   `standing: false` — TRANSIENT. `server_busy`, `engine_in_use`, a load in
 *     flight, a machine that is unreachable right now, a slot that is switched
 *     off, a card nobody has measured yet. **Time alone fixes these**, so the row
 *     parks exactly as it always has and `parkDelay`/`forgetPark` are untouched.
 *   `standing: true` — STANDING. The server's own record says this class cannot
 *     run there. Nothing the queue does on a timer will change it; only a PERSON
 *     can — route the class upstream in that engine's settings, put a bigger card
 *     in the machine, or send the job somewhere else.
 *
 * ── IT IS STILL A WAIT FOR THE WALK, AND THAT HALF DOES NOT CHANGE ─────────
 *
 * A standing refusal is a fact about ONE machine: the same job on the next one
 * in the ranking is a different question, so `any` steps past it exactly as
 * before. What changes is the ENDING — {@link placeJob} answers `refuse` when
 * the PINNED slot gave a standing wait, or when every slot in the walk did,
 * because at that point there is nothing left for time to do.
 */
export interface PlacementWait {
  verdict: 'wait';
  reason: string;
  standing: boolean;
}

/**
 * A wait that time may fix. The default shape, and the one the queue parks.
 *
 * Spelled as a constructor rather than an object literal at each of the fifteen
 * sites so that `standing` is REQUIRED and every one of them says which kind it
 * is out loud. An optional field would have made "nobody thought about it" and
 * "this is transient" the same value, which is the distinction this type exists
 * to draw.
 */
export function transientWait(reason: string): PlacementWait {
  return { verdict: 'wait', reason, standing: false };
}

/** A wait only a person can end. See {@link PlacementWait}. */
export function standingWait(reason: string): PlacementWait {
  return { verdict: 'wait', reason, standing: true };
}
