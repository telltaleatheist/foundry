/**
 * translate/model-server — the server the language passes speak to, proved once.
 *
 * ── WHAT THIS IS AND WHY IT IS ONE FILE ─────────────────────────────────────
 *
 * Four passes ask a model for text: `translate`, its `--rewrite` siblings
 * (simplify), `clean-text` and `analyze`. Every one of them asks the same small
 * set of things of a server — prove you are there and say which model you hold,
 * answer this block, and (on one of the two doors) give the card back — and this
 * file is the ONLY place a pass learns which server, which dialect and which
 * model, so that "which model answered" can never be answered differently by two
 * commands on the same run. Everything that records a model (the bank key, the
 * stamp, the verdict key, the log line) reads it from the `ModelServer` this
 * hands back.
 *
 * ── TWO DOORS, DECLARED, NEVER SNIFFED ──────────────────────────────────────
 *
 * `--server openai|ollama`, and no probing of the URL to work it out. A sniff
 * gets it right until it doesn't: a proxy in front of both, an Ollama on 8000
 * because somebody moved it, an OpenAI-compatible server behind a path that also
 * answers `/api/tags`. What a wrong guess costs is not an error — it is a book
 * translated by a model nobody chose, or a run that fails at block one with a
 * message about the wrong protocol. A person who launched a server knows which
 * one they launched, and saying so costs them one flag.
 *
 * THE KIND WAS SPELLED `vllm` UNTIL 2026-09-14 and is `openai` now. Not a
 * rename for tidiness: that door serves a shared inference service, a local
 * llama-server, a vLLM and a cloud provider alike, and naming it after one of
 * the four was a fact that would outlive the product. `vllm.ts` keeps its
 * filename because the measurements in docs/VLLM.md were taken through it and a
 * file rename would cost every one of them its address.
 *
 * ── WHAT THE TWO DOORS DISAGREE ABOUT, AND IT IS A SHORT LIST ───────────────
 *
 *  - THE MODEL. An Ollama holds a LIBRARY, so a run must say which model it
 *    means and an absent `--model` is refused by name before any work. The
 *    OpenAI door serves what the operator made resident, so an absent `--model`
 *    IS the answer and the server is asked.
 *  - THE WINDOW. Ollama takes `num_ctx` per request and reloads the runner on a
 *    change, so a caller that computes one computes it once a book. The OpenAI
 *    door's window was fixed when the model was made resident; a request is
 *    sized INTO it and one that cannot fit is refused before it is sent.
 *  - THE END OF THE RUN. Ollama is unloaded, always (`releaseModel`). The other
 *    door is never loaded and never unloaded by a pass.
 *  - HOW MANY REQUESTS ARE WORTH HAVING IN FLIGHT (`concurrencyFor`).
 *
 * Everything else is the same on both: the prompts, the temperature, the
 * validators, the retries, the bank, the records, the stamp. A book translated
 * through one door and the same book translated through the other are the same
 * pass asked of different plumbing — and the bank does not carry across, because
 * the model name in the key is a different string and correctly so.
 *
 * ── WHY A POOL IS THE PREREQUISITE, WRITTEN HERE BECAUSE THIS IS WHERE ──────
 * ── SOMEBODY ARRIVES ASKING WHY TWELVE REQUESTS ARE IN FLIGHT ───────────────
 *
 * The OpenAI door's advantage is AGGREGATE throughput across requests in flight
 * together: continuous batching keeps the GPU's tensor cores fed by running many
 * sequences through one forward pass, and CUDA graphs replay that pass without
 * re-issuing the kernels each step. Its single-stream latency is no better than
 * a serial runner's — on one request at a time there is nothing to batch. So the
 * worker pools in `run.ts`, `tts-number-normalizer.ts` and `analyze/run.ts` are
 * not an optimisation on top of that door: they are the thing that makes it pay
 * at all. Ollama batches far less well, which is the whole of why
 * `concurrencyFor` answers a smaller number there.
 */
import { isPageReadingModel } from '../vlm/models.js';
import type { ChatTuning, Transport } from './transport.js';
import { normaliseEndpoint, TRANSLATE_TUNING } from './transport.js';
import { chat, OllamaError, requireModel, unloadModel } from './ollama.js';
import {
  complete, normaliseVllmEndpoint, requireServedModel, VllmError, type ServedModel,
} from './vllm.js';

/** Ollama's own default, which is where it is unless somebody moved it. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * The two things that can be on the other end. Declared, never sniffed.
 *
 * `openai` is first because it is the default, and the order is what the refusal
 * message lists (`--server takes openai or ollama, not "x"`).
 */
export const SERVER_KINDS = ['openai', 'ollama'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export function isServerKind(value: string): value is ServerKind {
  return (SERVER_KINDS as readonly string[]).includes(value);
}

/**
 * The sentence an Ollama run with no `--model` is refused with.
 *
 * DECLARED ONCE AND THROWN FROM TWO LAYERS, which is the opposite of a repair
 * layer and is the reason it is a constant rather than a string literal typed
 * twice. The CLI refuses it as a usage error before a book is opened, because
 * `--model` is a flag and a person who mistyped their command wants to hear
 * about the command; `openModelServer` refuses it again for a caller that is not
 * the CLI — the vendored app, a test — because "an Ollama needs a model" is a
 * fact about the DIALECT and not about argv. One sentence, two doors into it.
 */
export const MODEL_REQUIRED_ON_OLLAMA =
  'an Ollama holds a library, so this run must say which model it means with --model';

/**
 * A proved server: what to speak to, in what dialect, about which model.
 *
 * `model` is RESOLVED — under Ollama it is the tag that was asked for and
 * proved, under the OpenAI door it is the id the server said it is serving,
 * which may be a name nobody typed (`requireServedModel`). Everything that
 * records a model reads it from here, so a run can never record a model
 * different from the one that answered.
 */
export interface ModelServer {
  kind: ServerKind;
  /** The base URL as it is actually spoken to, after normalisation. */
  endpoint: string;
  model: string;
  /** The server's context window when it reported one. Null under Ollama. */
  maxModelLen: number | null;
}

/**
 * How many requests to keep in flight when the caller named no number.
 *
 * NOT A MEASUREMENT FOR THE TEXT ACTS, but not arbitrary either: it is the
 * number `DEFAULT_VLM_CONCURRENCY` was measured at for the reading path against
 * a vLLM on this project's own hardware, where twelve in flight kept the batch
 * full without per-request latency climbing. The scheduler being fed is the
 * same scheduler, and it is safe to be wrong high: the server admits what fits
 * in its KV cache and QUEUES the rest, so extra requests wait in the server
 * instead of thrashing a card. `--concurrency` overrides it, and on a small
 * card it is the flag to reach for first.
 */
export const DEFAULT_TEXT_CONCURRENCY = 12;

/**
 * And Ollama's, which is four and is a STARTING POINT rather than a measurement.
 *
 * It is smaller for a reason rather than out of timidity. Ollama's parallelism
 * is a server setting (`OLLAMA_NUM_PARALLEL`), it is off or small by default,
 * and requests past it QUEUE — so being wrong high there buys nothing and can
 * push a machine into swapping if the server was configured to honour them. Four
 * is obviously better than one, because a serial run leaves the GPU idle between
 * blocks, and small enough that it cannot be the reason somebody's server
 * started thrashing. The right value is a property of their GPU and their
 * model's size, which is why `--concurrency` exists at all.
 */
export const DEFAULT_OLLAMA_CONCURRENCY = 4;

/**
 * The default for this door, given what THIS ACT wants on the OpenAI one.
 *
 * The act passes its own OpenAI-door number rather than reading a shared one
 * here, on `CT_CONCURRENCY`'s ruling (commands.ts): each act declares its own
 * default so its help line stays true the day one of them moves. Today all three
 * pass `DEFAULT_TEXT_CONCURRENCY`; the day one of them does not, nothing here
 * has to change.
 */
export function concurrencyFor(kind: ServerKind, openaiDefault: number): number {
  return kind === 'ollama' ? DEFAULT_OLLAMA_CONCURRENCY : openaiDefault;
}

/**
 * Prove the server, and hand back what the rest of the run needs to talk to it.
 *
 * The proof is FIRST, before a block is read: the run would discover a dead
 * server on request one anyway, and what asking early buys is the MESSAGE — a
 * sentence naming the URL that was silent, which is the only thing the person
 * about to check their server needs from this program.
 *
 * `model` is optional in the TYPE and the two doors read its absence
 * differently, which is the header's short list: an Ollama holds a library and
 * an absent name is refused by name here; the OpenAI door serves one resident
 * model, so the absence IS the answer and `requireServedModel` asks it.
 */
export async function openModelServer(options: {
  kind: ServerKind;
  transport: Transport;
  endpoint: string;
  model?: string;
}): Promise<ModelServer> {
  const { kind, transport } = options;
  if (kind === 'ollama') {
    const endpoint = normaliseEndpoint(options.endpoint);
    const model = options.model?.trim() ?? '';
    if (model.length === 0) throw new OllamaError(MODEL_REQUIRED_ON_OLLAMA);
    await requireModel(transport, endpoint, model);
    return { kind, endpoint, model, maxModelLen: null };
  }
  const endpoint = normaliseVllmEndpoint(options.endpoint);
  const served: ServedModel = await requireServedModel(transport, endpoint, options.model);
  // The one thing a text act must not accept from discovery. See
  // `isPageReadingModel` (vlm/models.ts) for the whole reason; the short of
  // it is that the reading model and the text model are served through the
  // same door, and a cleanup answered by a page reader is banked and stamped
  // as if it were prose.
  if (isPageReadingModel(served.id)) {
    throw new VllmError(
      `${endpoint} is serving "${served.id}", which is a model that READS PAGE IMAGES — a text `
      + 'act cannot use it, and a book cleaned or translated through it would be nonsense '
      + 'banked under its name. The server holds one model at a time; make the text model '
      + 'resident before this act runs, or name a text model with --model if this server '
      + 'really does serve both.',
    );
  }
  return { kind, endpoint, model: served.id, maxModelLen: served.maxModelLen };
}

/** Ask the proved server for one block, in its own dialect. */
export async function askModel(
  transport: Transport,
  server: ModelServer,
  system: string,
  user: string,
  tuning: ChatTuning = TRANSLATE_TUNING,
): Promise<string> {
  if (server.kind === 'ollama') {
    return chat(transport, server.endpoint, server.model, system, user, tuning);
  }
  return complete(
    transport,
    server.endpoint,
    { id: server.model, maxModelLen: server.maxModelLen },
    system,
    user,
    tuning,
  );
}

/** What happened when the run tried to give the card back. */
export type ReleaseOutcome = 'released' | 'refused' | 'not-ours';

/**
 * Give the weights back when the run is over — or say why nothing was asked.
 *
 * ── OLLAMA: ALWAYS, AND THERE IS NO FLAG ────────────────────────────────────
 *
 * Owen, 2026-09-13: *"ollama should always, always bring down the model as soon
 * as the job is done. they arent chatting with it, theyre using it for a job and
 * then closing the connection."* A book is thousands of requests over hours, and
 * when the last one lands twenty gigabytes stay pinned on a five-minute idle
 * timer with nothing to answer. On a one-GPU machine — the machine this door
 * exists for — that is the next job's memory.
 *
 * There WAS a `--keep-model`, for an Ollama shared with other work. It is gone
 * and is not coming back: the other work reloads its model in seconds, and a
 * card held by a finished job costs the next job everything. Every caller runs
 * this in a `finally`, so a run that DIED gives the card back too — which is the
 * worst case, a job that produced nothing holding twenty gigabytes on behalf of
 * it. `unloadModel` cannot throw, so this can never turn a finished book into a
 * failed run.
 *
 * ── THE OpenAI DOOR: A DECLARED NO-OP, AND THAT IS THE DESIGN ───────────────
 *
 * A vLLM process IS its model: the weights are loaded at launch, the KV cache is
 * pre-allocated against them, and there is no request that says "let go". Behind
 * a service that can load and evict, a pass asking for an unload would be one
 * job taking a narrator's voice off the card on behalf of work that is over. The
 * operator owns that card; foundry uses what it is pointed at.
 *
 * So this answers `not-ours` and the caller says so out loud, once, in a
 * sentence. Silence would look like a release that happened.
 */
export async function releaseModel(
  transport: Transport,
  kind: ServerKind,
  endpoint: string,
  model: string,
): Promise<ReleaseOutcome> {
  if (kind !== 'ollama') return 'not-ours';
  return (await unloadModel(transport, endpoint, model)) ? 'released' : 'refused';
}
