/**
 * translate/model-server — the server the language passes speak to, proved once.
 *
 * ── WHAT THIS IS AND WHY IT IS ONE FILE ─────────────────────────────────────
 *
 * Four passes ask a model for text: `translate`, its `--rewrite` siblings
 * (simplify), `clean-text` and `analyze`. Every one of them asks the same small
 * set of things of a server — prove you are there and say which model you hold,
 * answer this block, and (on one of the three doors) give the card back — and this
 * file is the ONLY place a pass learns which server, which dialect and which
 * model, so that "which model answered" can never be answered differently by two
 * commands on the same run. Everything that records a model (the bank key, the
 * stamp, the verdict key, the log line) reads it from the `ModelServer` this
 * hands back.
 *
 * ── THREE DOORS, DECLARED, NEVER SNIFFED ────────────────────────────────────
 *
 * `--server openai|ollama|anthropic`, and no probing of the URL to work it out.
 * A sniff gets it right until it doesn't: a proxy in front of both, an Ollama on
 * 8000 because somebody moved it, an OpenAI-compatible server behind a path that
 * also answers `/api/tags`. What a wrong guess costs is not an error — it is a
 * book translated by a model nobody chose, or a run that fails at block one with
 * a message about the wrong protocol. A person who launched a server knows which
 * one they launched, and saying so costs them one flag.
 *
 * THE KIND WAS SPELLED `vllm` UNTIL 2026-09-14 and is `openai` now. Not a
 * rename for tidiness: that door serves a shared inference service, a local
 * llama-server, a vLLM and a cloud provider alike, and naming it after one of
 * the four was a fact that would outlive the product. `vllm.ts` keeps its
 * filename because the measurements in docs/VLLM.md were taken through it and a
 * file rename would cost every one of them its address.
 *
 * THE THIRD DOOR IS PACKAGE F (docs/SLOTS.md §6), and the asymmetry in it is
 * worth stating: Owen asked for "an api key for openai or claude", and only ONE
 * of the two needed a dialect. OpenAI's own API is an OpenAI-compatible server
 * with a credential in the header map, so it is the door that already existed;
 * Anthropic's is a different wire end to end — `/v1/messages`, a top-level
 * `system`, content blocks, `stop_reason`, a forced tool for a constrained
 * answer — so it is `anthropic.ts`, named for the dialect rather than for the
 * company's product, because that is what the file knows.
 *
 * ── WHAT THE THREE DOORS DISAGREE ABOUT, AND IT IS A SHORT LIST ─────────────
 *
 *  - THE MODEL. An Ollama holds a LIBRARY and a provider holds a CATALOG, so on
 *    both of those a run must say which model it means and an absent `--model`
 *    is refused by name before any work. The OpenAI door serves what the
 *    operator made resident, so an absent `--model` IS the answer there and the
 *    server is asked — including when that server is a cloud provider serving
 *    exactly one model to this key, which is why the absence is still allowed
 *    on that door and still refused when the listing holds more than one.
 *  - THE WINDOW. Ollama takes `num_ctx` per request and reloads the runner on a
 *    change, so a caller that computes one computes it once a book. The OpenAI
 *    door's window was fixed when the model was made resident; a request is
 *    sized INTO it and one that cannot fit is refused before it is sent. A
 *    provider's window is the provider's: nothing is read back, nothing is
 *    pinned, and `maxModelLen` is null.
 *  - THE END OF THE RUN. Ollama is unloaded, always (`releaseModel`). The other
 *    two are never loaded and never unloaded by a pass.
 *  - HOW MANY REQUESTS ARE WORTH HAVING IN FLIGHT (`concurrencyFor`).
 *
 * Everything else is the same on all three: the prompts, the temperature, the
 * validators, the retries, the bank, the records, the stamp. A book translated
 * through one door and the same book translated through another are the same
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
import { chatActivityUrl, isCrucibleOpenAiDoor } from '../vlm/contract.js';
import { isPageReadingModel } from '../vlm/models.js';
import type { ChatTuning, Transport } from './transport.js';
import { fetchTransport, forgetUsage, normaliseEndpoint, TRANSLATE_TUNING } from './transport.js';
import { chat, OllamaError, requireModel, unloadModel } from './ollama.js';
import {
  complete, normaliseVllmEndpoint, requireServedModel, VllmError,
  type ServedDefaults, type ServedModel,
} from './vllm.js';
import {
  AnthropicError, complete as anthropicComplete, MODEL_REQUIRED_ON_ANTHROPIC,
  normaliseAnthropicEndpoint, requireListedModel,
} from './anthropic.js';

/** Ollama's own default, which is where it is unless somebody moved it. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * The three things that can be on the other end. Declared, never sniffed.
 *
 * `openai` is first because it is the default, and the order is what the refusal
 * message lists (`--server takes openai, ollama or anthropic, not "x"`).
 */
export const SERVER_KINDS = ['openai', 'ollama', 'anthropic'] as const;
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
 * And the same fact about the third door, said in that door's own terms.
 *
 * It is DECLARED in `anthropic.ts` rather than here, because the whole of that
 * dialect's vocabulary is there and a sentence about what a provider holds is
 * part of it; it is RE-EXPORTED here so the CLI has one module to import a
 * "which model does this run mean" refusal from, exactly as it has for Ollama.
 */
export { MODEL_REQUIRED_ON_ANTHROPIC };

/**
 * A proved server: what to speak to, in what dialect, about which model.
 *
 * `model` is RESOLVED — under Ollama and under a provider it is the name that
 * was asked for and proved, under the OpenAI door it is the id the server said
 * it is serving, which may be a name nobody typed (`requireServedModel`).
 * Everything that records a model reads it from here, so a run can never record
 * a model different from the one that answered.
 */
export interface ModelServer {
  kind: ServerKind;
  /** The base URL as it is actually spoken to, after normalisation. */
  endpoint: string;
  model: string;
  /**
   * The server's context window when it reported one.
   *
   * Null under Ollama, where it is a per-request option instead, and null on a
   * cloud provider, which does not publish one — "it did not say" rather than
   * "it has none", which is what every reader of this field already treats null
   * as (`capFor`, `fitsWindow`).
   */
  maxModelLen: number | null;
  /**
   * What this server publishes as its per-model sampling defaults, or null.
   *
   * Null on Ollama and on a provider, which publish no such block, and null on
   * an OpenAI-shaped server that did not state one — all three are the same
   * statement, "nothing was said", and `completionsBody` is where it is read
   * (vllm.ts's header carries the precedence rule and which knobs Foundry has
   * a reason of its own for). It rides here rather than being re-fetched at
   * every request because it is a fact about the RESIDENT model, established
   * once when the server was proved.
   */
  defaults: ServedDefaults | null;
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
 *
 * THAT SAFETY IS A FACT ABOUT A vLLM AND NOT ABOUT THIS DOOR. Behind a Crucible
 * chat proxy the queued requests are not batched — they wait on a serial engine
 * with their deadlines already running — so this number is not reached there.
 * `CRUCIBLE_CHAT_CONCURRENCY` below, and `concurrencyFor` is where the two meet.
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
 * And a cloud provider's, which is four for a reason neither of the others has.
 *
 * The number twelve is about a GPU: it is how many sequences keep a batch full
 * on a card this project measured. A provider has no card to fill — it has a
 * RATE LIMIT, per key, counted in requests and tokens per minute, and a pool of
 * twelve trips it. What that costs is not an error somebody sees once: every
 * tripped request is a 429, every 429 is a wait (`withBusyWait`), and a book
 * sending twelve at a time into a limit built for fewer spends most of its run
 * asleep while still paying for every retry that landed. Four is small enough
 * to sit under the entry-tier limits of both providers and large enough that
 * the round trip to a datacentre — which is most of a cloud request's latency —
 * is overlapped instead of paid four hundred times in a row.
 *
 * IT IS A STARTING POINT AND `--concurrency` OVERRIDES IT, which is the honest
 * shape for a number that is really a property of somebody's key and tier.
 */
export const DEFAULT_CLOUD_CONCURRENCY = 4;

/**
 * And a Crucible chat proxy's, which is four because of what is BEHIND it.
 *
 * `DEFAULT_TEXT_CONCURRENCY`'s docblock states the assumption that makes twelve
 * safe — *"the server admits what fits in its KV cache and QUEUES the rest"* —
 * and that assumption is a fact about a vLLM, not about the OpenAI door. A
 * Crucible chat door is a PROXY in front of a serial engine (`mlx_lm` answers
 * one request at a time), so requests past the first are not batched, they wait
 * in a queue with their deadlines already running. Twelve in flight there buys
 * no throughput at all and costs the tail of every pool a timeout — the defect
 * BUG-HUNT-2026-09-20 §A F3a measured, where the observed failure was the
 * queueing and not the model.
 *
 * FOUR IS THE MEASURED KNEE (2026-09-08, clean-text against a Crucible chat
 * proxy: flat throughput past four, and the Mac's own MLX runner batches
 * decode-only) and it is Owen's interim ruling (§F.4): four in flight on the
 * Crucible chat door until the server states a number of its own.
 *
 * ── AND ON 2026-09-20 IT DOES, SO THIS IS NOW THE **UNSTATED** FALLBACK ─────
 *
 * Crucible 1.0.10 admits `chat.max_in_flight` chats per engine and publishes
 * that number on `/v1/activity`; on the Mac's serial `mlx-lm` it is 2 (engine
 * concurrency 1, plus one), and a thirteenth — or a fifth — request is not
 * queued, it is REFUSED `503 chat_queue_full`. So four stopped being a
 * conservative guess and became an over-send: the night this is written, four
 * requests went out, two were admitted, and the two that were refused spent the
 * whole pass being re-asked while the admitted pair generated.
 *
 * A measurement of a knee is a statement about throughput; an admission limit is
 * a statement about what the server will ACCEPT. The second beats the first
 * whenever the server makes it, which is why `askChatDepth` is asked first and
 * this is what answers when nothing was said (a vLLM behind the same door states
 * nothing and is not bounded — there, four is still the Sep 8 knee).
 * `--concurrency` still wins over both.
 */
export const CRUCIBLE_CHAT_CONCURRENCY = 4;

/**
 * The default for this door, given what THIS ACT wants on the OpenAI one.
 *
 * The act passes its own OpenAI-door number rather than reading a shared one
 * here, on `CT_CONCURRENCY`'s ruling (commands.ts): each act declares its own
 * default so its help line stays true the day one of them moves. Today all three
 * pass `DEFAULT_TEXT_CONCURRENCY`; the day one of them does not, nothing here
 * has to change.
 *
 * THE OpenAI DOOR STILL GETS THE ACT'S NUMBER even when a cloud provider is on
 * the other end of it, and that is the cost of a declared dialect rather than a
 * sniffed one: this program cannot tell OpenAI's API from a vLLM, does not try,
 * and a person pointing that door at a provider names `--concurrency` the way
 * they name `--endpoint` and `--model`. `anthropic` is a kind of its own, so on
 * that one the smaller number IS the default.
 */
/**
 * ── AND THE ONE PLACE THE ENDPOINT IS READ, WHICH IS AN EXCEPTION ON PURPOSE ─
 *
 * The header above says this program does not sniff a URL to learn which door
 * it is, and that still holds: `endpoint` here changes no DIALECT and no
 * protocol — the request is OpenAI-shaped either way, and a wrong answer costs
 * speed rather than a book read by a model nobody chose. What it recognises is
 * one specific server this project ships and runs (`isCrucibleOpenAiDoor`,
 * vlm/contract.ts), whose door shape is composed by this project's own app, and
 * what it buys is that a Crucible does not have to be told its own knee on
 * every command line. `--concurrency` still wins over all of it.
 *
 * It is OPTIONAL so that a caller with no endpoint in hand — a test, a door
 * proved elsewhere — gets exactly the behaviour this function always had.
 */
export function concurrencyFor(
  kind: ServerKind,
  openaiDefault: number,
  endpoint?: string,
): number {
  if (kind === 'ollama') return DEFAULT_OLLAMA_CONCURRENCY;
  if (kind === 'anthropic') return DEFAULT_CLOUD_CONCURRENCY;
  if (endpoint !== undefined && isCrucibleOpenAiDoor(endpoint)) return CRUCIBLE_CHAT_CONCURRENCY;
  return openaiDefault;
}

/**
 * ── THE SERVER'S OWN NUMBER, READ OUT OF A `/v1/activity` DOCUMENT ──────────
 *
 * `chat.max_in_flight` is how many chat completions a Crucible will ADMIT at
 * once, which is not the same kind of fact as a throughput knee and beats one:
 * a request past it is not queued, it is refused `503 chat_queue_full`. On a
 * serial `mlx-lm` it is 2; a vLLM behind the same door states nothing, because
 * it batches and is not bounded.
 *
 * NULL IS "IT DID NOT SAY" AND IS NEVER A ZERO, on the same rule the header
 * gives `Retry-After` and `maxModelLen`: a server that published nothing, a
 * server with no engine resident, and a server too old to know the field all
 * mean one thing to a caller, and that thing is "choose for yourself". A number
 * below one would be a document saying it admits nothing, which no client can
 * act on and which this reads as silence rather than as a refusal to work.
 *
 * PURE, AND SEPARATE FROM THE FETCH, so a test proves the parse on the bytes a
 * real server sent rather than on a mock of the reading.
 */
export function chatDepthStated(document: unknown): number | null {
  if (typeof document !== 'object' || document === null) return null;
  const chat = (document as Record<string, unknown>)['chat'];
  if (typeof chat !== 'object' || chat === null) return null;
  const stated = (chat as Record<string, unknown>)['max_in_flight'];
  if (typeof stated !== 'number' || !Number.isFinite(stated) || stated < 1) return null;
  return Math.floor(stated);
}

/** What the server said the number is DERIVED from, for the line. '' = it did not say. */
function chatDepthBasis(document: unknown): string {
  const chat = (document as { chat?: Record<string, unknown> } | null)?.chat;
  const basis = chat?.['max_in_flight_basis'];
  return typeof basis === 'string' && basis.trim() !== '' ? basis.trim() : '';
}

/**
 * ASK THE DOOR'S SERVER HOW DEEP ITS CHAT POOL MAY BE. Null = it did not say.
 *
 * ── Why this is one GET and not a subscription ─────────────────────────────
 *
 * The pool is sized ONCE, before the transport is built, because the deadline is
 * a function of it (`deadlineForConcurrency`). So this is asked once a run, at
 * the same moment `openModelServer` proves the server, and what it costs is one
 * round trip against a machine the run is about to spend an hour talking to.
 *
 * ── Why every failure is null and not a throw ──────────────────────────────
 *
 * This read is an OPTIMISATION of a number that already has a defensible
 * default. A server that is not there will be named by `openModelServer` one
 * line later, with a better sentence than anything this function could compose;
 * ending the run here would mean a book refused because a courtesy read failed.
 * Every arm therefore says what happened out loud and answers null — silence
 * would be the one unacceptable outcome, because then a run at four against a
 * server admitting two would look exactly like a run that had asked.
 *
 * ── The credential is the endpoint's, and is attached where it always is ────
 *
 * `/v1/activity` is authenticated. `fetchTransport` puts the endpoint's header
 * map on every request it makes (`resolveEndpointHeaders`, backend/endpoint-
 * headers.ts) — the same map the chat door itself is spoken to with, since it is
 * a property of the ENDPOINT and not of the route — so this function neither
 * sees nor handles a token. That is the whole reason it goes through the
 * transport rather than calling `fetch` itself.
 */
export async function askChatDepth(
  endpoint: string,
  options: {
    /** Injected so a test proves this without a server. Default: the real one. */
    transport?: Transport;
    log?: (line: string) => void;
  } = {},
): Promise<number | null> {
  const url = chatActivityUrl(endpoint);
  if (url === null) return null;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  /*
   * A SHORT CLOCK OF ITS OWN, and deliberately not the run's. `REQUEST_TIMEOUT_MS`
   * is sized for a 32b model on a long paragraph; a status read that takes five
   * minutes is a server that will not serve this book either, and waiting the
   * run's full budget for it would put five silent minutes in front of every
   * pass against a wedged machine.
   */
  const transport = options.transport ?? fetchTransport(CHAT_DEPTH_TIMEOUT_MS);
  let body: string;
  try {
    const response = await transport.get(url);
    if (response.status !== 200) {
      log(
        `${url} answered ${response.status} rather than publishing what it admits, so this run `
        + `keeps ${CRUCIBLE_CHAT_CONCURRENCY} requests in flight. A Crucible older than 1.0.10 `
        + 'states no chat depth, which is this answer.',
      );
      return null;
    }
    body = response.body;
  } catch (error) {
    log(
      `${url} could not be read (${error instanceof Error ? error.message : String(error)}), so `
      + `this run keeps ${CRUCIBLE_CHAT_CONCURRENCY} requests in flight. Whether the server is `
      + 'there at all is answered next, by the model proof.',
    );
    return null;
  }
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    log(
      `${url} did not answer with JSON, so this run keeps ${CRUCIBLE_CHAT_CONCURRENCY} requests `
      + 'in flight.',
    );
    return null;
  }
  const stated = chatDepthStated(document);
  if (stated === null) {
    log(
      `${url} states no chat depth — no engine resident, or a server that does not bound chats `
      + `(a vLLM batches and is not bounded) — so this run keeps ${CRUCIBLE_CHAT_CONCURRENCY} `
      + 'requests in flight.',
    );
    return null;
  }
  const basis = chatDepthBasis(document);
  log(
    `${url} admits ${stated} chat${stated === 1 ? '' : 's'} at once`
    + `${basis === '' ? '' : ` (${basis})`}, so this run keeps ${stated} request`
    + `${stated === 1 ? '' : 's'} in flight. A request past that is refused, not queued.`,
  );
  return stated;
}

/**
 * How long the depth read may take before the run stops waiting for it. See
 * `askChatDepth` — this is a status read in front of a book, not a generation.
 */
const CHAT_DEPTH_TIMEOUT_MS = 10_000;

/**
 * ── HOW MANY REQUESTS THIS RUN KEEPS IN FLIGHT — THE WHOLE RULE, ONE PLACE ──
 *
 * What a run WANTS is asked for in two rungs:
 *
 *  1. `--concurrency`, when the run named one — a person, or the app's placement
 *     (`Placement.concurrency`, app/electron/crucible-dispatch.ts), stating a
 *     preference about hardware they know something about.
 *  2. `concurrencyFor` otherwise, which is where a vLLM, an Ollama, a provider
 *     and a Crucible that states nothing all land. It STAYS PURE and stays the
 *     owner of that rung, because it is a rule about DOORS with no network in
 *     it; this function is the one that knows there is a server to ask.
 *
 * ── AND THEN THE SERVER'S ADMISSION LIMIT CLAMPS IT, FLAG OR NO FLAG ───────
 *
 * `chat.max_in_flight` is not a preference and is not a throughput opinion: it
 * is what the other end will ACCEPT. Past it a request is not queued, it is
 * refused `503 chat_queue_full` — so a pool above it is never right, whoever
 * asked for it. It cost a whole clean pass on 2026-09-20 (BUG-HUNT §A): four
 * went out against an admission of two, and the two refused requests spent the
 * run being re-asked while the admitted two generated.
 *
 * SO THE FLAG DOES NOT WIN UPWARDS, AND THAT IS DELIBERATE. The usual rule in
 * this program is that an explicit number is the last word, and the exception is
 * paid for: the number arriving on `--concurrency` is most often not a person at
 * all but a PLACEMENT composed by a build of the app that may be older than the
 * server it is placing against — which is exactly the shape of the night this
 * closes, where a running app kept sending 4 at a server admitting 2 and could
 * not be corrected without restarting it. A stale number about somebody else's
 * backend must not outrank that backend's own answer.
 *
 * IT DOES WIN DOWNWARDS. A flag below the stated maximum is honoured untouched:
 * "fewer than the server would allow" is a preference the server has no opinion
 * about, and a person throttling a run they are watching means it.
 *
 * WHEN THE SERVER STATES NOTHING, the flag or the door's default stands whole —
 * null is "it did not say" and never a limit of zero (`chatDepthStated`).
 */
export async function resolveConcurrency(options: {
  /**
   * `--concurrency`, if the run named one. Honoured below the server's stated
   * admission limit and CLAMPED to it above — see the header.
   */
  asked?: number;
  kind: ServerKind;
  /** This act's own OpenAI-door number — see `concurrencyFor`'s header. */
  openaiDefault: number;
  endpoint?: string;
  transport?: Transport;
  log?: (line: string) => void;
}): Promise<number> {
  const wanted =
    options.asked ?? concurrencyFor(options.kind, options.openaiDefault, options.endpoint);
  /*
   * NOTHING IS ASKED OF A DOOR THAT PUBLISHES NO SUCH THING. Ollama, a cloud
   * provider and an anonymous vLLM have no `/v1/activity` to read, and a round
   * trip in front of every run of theirs would buy a null.
   */
  if (options.kind !== 'openai' || options.endpoint === undefined) return wanted;
  if (!isCrucibleOpenAiDoor(options.endpoint)) return wanted;
  const stated = await askChatDepth(options.endpoint, {
    transport: options.transport,
    log: options.log,
  });
  if (stated === null || wanted <= stated) return wanted;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  log(
    `This run asked for ${wanted} requests in flight and the server admits ${stated}, so it will `
    + `keep ${stated}. A request past a server's admission limit is refused (503 chat_queue_full) `
    + 'rather than queued, so a deeper pool buys nothing and spends the run retrying; the number '
    + 'asked for may also have been composed by a build older than the server. Ask for fewer than '
    + `${stated} and that is honoured.`,
  );
  return stated;
}

/**
 * Prove the server, and hand back what the rest of the run needs to talk to it.
 *
 * The proof is FIRST, before a block is read: the run would discover a dead
 * server on request one anyway, and what asking early buys is the MESSAGE — a
 * sentence naming the URL that was silent, which is the only thing the person
 * about to check their server needs from this program.
 *
 * `model` is optional in the TYPE and the doors read its absence differently,
 * which is the header's short list: an Ollama holds a library and a provider
 * holds a catalog, so an absent name is refused by name on both of those here;
 * the OpenAI door serves one resident model, so the absence IS the answer and
 * `requireServedModel` asks it.
 *
 * ── AND THIS IS WHERE THE RUN'S TOKEN COUNT STARTS AT ZERO ──────────────────
 *
 * `forgetUsage` is called here because this function is the one thing every run
 * does exactly once, before any request: a count anchored anywhere else would
 * either be a process-lifetime total (wrong the second time a harness drives a
 * run) or would need every act to remember to reset it (a rule somebody has to
 * remember, which this repo's own header on `withoutEndpointHeaders` argues
 * against). See `recordUsage`, transport.ts.
 */
export async function openModelServer(options: {
  kind: ServerKind;
  transport: Transport;
  endpoint: string;
  model?: string;
  /**
   * Where a line goes that the run has to SAY rather than throw — today just
   * the one case on the Anthropic door where a model listing could not be read
   * and the name therefore went unchecked (`requireListedModel`). Optional
   * because most callers are already logging elsewhere and because the default
   * is stderr, which is where every act's lines go anyway; what it is NOT
   * allowed to default to is silence, since an unperformed check that says
   * nothing is indistinguishable from one that passed.
   */
  log?: (line: string) => void;
}): Promise<ModelServer> {
  const { kind, transport } = options;
  forgetUsage();
  if (kind === 'ollama') {
    const endpoint = normaliseEndpoint(options.endpoint);
    const model = options.model?.trim() ?? '';
    if (model.length === 0) throw new OllamaError(MODEL_REQUIRED_ON_OLLAMA);
    await requireModel(transport, endpoint, model);
    return { kind, endpoint, model, maxModelLen: null, defaults: null };
  }
  if (kind === 'anthropic') {
    const endpoint = normaliseAnthropicEndpoint(options.endpoint);
    const model = options.model?.trim() ?? '';
    if (model.length === 0) throw new AnthropicError(MODEL_REQUIRED_ON_ANTHROPIC);
    await requireListedModel(
      transport,
      endpoint,
      model,
      options.log ?? ((line) => process.stderr.write(`${line}\n`)),
    );
    /*
     * `maxModelLen` IS NULL AND THAT IS A STATEMENT. A provider publishes no
     * window in its listing and takes no field for one, so nothing is read back
     * and nothing is pinned; `capFor` and `fitsWindow` both read null as "it
     * did not say" and let the request through, which is right — the provider
     * enforces its own limit and names the number when it refuses.
     */
    return { kind, endpoint, model, maxModelLen: null, defaults: null };
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
  return {
    kind, endpoint, model: served.id, maxModelLen: served.maxModelLen,
    defaults: served.defaults,
  };
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
  if (server.kind === 'anthropic') {
    return anthropicComplete(
      transport, server.endpoint, server.model, system, user, tuning,
    );
  }
  return complete(
    transport,
    server.endpoint,
    { id: server.model, maxModelLen: server.maxModelLen, defaults: server.defaults },
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
 * ── THE OTHER TWO DOORS: A DECLARED NO-OP, AND THAT IS THE DESIGN ───────────
 *
 * A vLLM process IS its model: the weights are loaded at launch, the KV cache is
 * pre-allocated against them, and there is no request that says "let go". Behind
 * a service that can load and evict, a pass asking for an unload would be one
 * job taking a narrator's voice off the card on behalf of work that is over. The
 * operator owns that card; foundry uses what it is pointed at.
 *
 * On a cloud provider there is no card at all — nothing was made resident,
 * nothing is held, and the only thing a run could give back is a connection it
 * has already closed. `not-ours` covers both: this pass took nothing and
 * therefore returns nothing. The callers' sentences are written to be true of
 * either, which is why none of them promises somebody a freed GPU.
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
