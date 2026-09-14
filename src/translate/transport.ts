/**
 * translate/transport — HTTP as a value, and the numbers every act shares.
 *
 * ── THE SERVER IS SOMEBODY ELSE'S, AND THERE ARE TWO KINDS OF IT ────────────
 *
 * This file sends HTTP and reads what comes back. It does not start a server,
 * does not stop one and does not pull a model. Owen's ruling of 2026-09-13/14
 * (docs/SLOTS.md): foundry must work with no inference service of its own, on
 * the Ollama the person already runs, AND it must speak to an OpenAI-compatible
 * door when there is one — a shared inference service, a local llama-server, a
 * vLLM, a cloud provider. A server that is not answering is not a condition to
 * recover from;
 * it is the end of the run, said in a sentence naming the URL that was tried.
 *
 * For one night in between there was only the OpenAI door, and this file was
 * renamed out of `ollama.ts` to say so. The rename stands and the dialect came
 * back beside it: `ollama.ts` now holds ONLY the Ollama dialect — `/api/chat`
 * with `num_ctx` per request, `/api/tags`, `keep_alive: 0`, the `/api/generate`
 * schema-constrained verdict — and `vllm.ts` holds only the OpenAI one. Which
 * of the two is spoken is DECLARED on `--server`, never sniffed from the URL.
 *
 * ── WHAT IS STILL HERE, AND WHY IT IS HERE AND NOT IN EITHER DIALECT ────────
 *
 * `Transport` is the seam the tests drive the whole verification loop through
 * without a GPU; `fetchTransport` is the one real implementation and the one
 * place an endpoint's headers are attached. `answerBudget` and `ChatTuning` are
 * measurements shared by every act, and `takesThinkField` is the rule for which
 * model families take a thinking switch — one rule, spelled two ways on the
 * wire (`think: false` there, `chat_template_kwargs` here). They are the
 * act-independent and dialect-independent half; the two other files are the
 * dialects.
 *
 * ONE BLOCK PER REQUEST, AND THE ONE EXCEPTION. Measured: at paragraph
 * granularity a 14b model translates German prose reliably, and batching
 * several UNRELATED paragraphs into one request multiplied the blast radius of
 * every verification failure — a single dropped marker anywhere in the batch
 * refuses the whole batch, and a retry re-translates paragraphs that were
 * already correct. Ten seconds a paragraph is the price of being able to name
 * the paragraph, and it is worth paying.
 *
 * What `run.ts` does send together is a list, a quotation or a table — parts of
 * ONE thing, where sending them apart is itself a defect: an item translated
 * without its list loses the grammar it was parallel to, and a table cell
 * without its column header often cannot be translated at all. The blast radius
 * is bounded the same way the measurement demanded: what a group retries is the
 * STRUCTURE of the answer, and a part whose words fail verification is re-asked
 * on its own rather than costing the chunk. So a bad answer still costs one
 * block, which was the point.
 *
 * TEMPERATURE IS 0.2 FOR A TRANSLATION AND IS NOT A SETTING. Zero made the 14b
 * model repeat whole clauses on long paragraphs; above ~0.4 the 32b model
 * started inventing connective sentences that were not in the source. 0.2 is
 * where both stopped, and a knob here would be a knob whose good values are
 * already known (ARCHITECTURE §5).
 */

import { resolveEndpointHeaders } from '../backend/endpoint-headers.js';

/** The server did not do its job. Always names the endpoint. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * The HTTP boundary, as a value.
 *
 * Injected rather than called directly so the tests can drive every branch of
 * the verification loop — a dropped marker, an echo, an empty answer, a retry
 * that succeeds — without a live server and without a GPU. Nothing else in this
 * command is hard to test; this is the one seam that matters.
 */
export interface Transport {
  get(url: string): Promise<HttpResponse>;
  post(url: string, body: string): Promise<HttpResponse>;
}

/**
 * How long one block may take before the run gives up on it.
 *
 * Generous on purpose: a 32b model on a long paragraph with a cold KV cache has
 * been measured at over a minute, and a timeout that fires on slow-but-working
 * is a timeout that makes the feature look broken on exactly the hardware it
 * was built for. What it protects against is a request that will never answer
 * at all, which without a deadline hangs a job that has already run for hours.
 */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * The real transport, and the one place the endpoint's headers are attached.
 *
 * They are resolved HERE rather than threaded from each command because they
 * are a property of the endpoint, not of the act: every door in this program
 * that speaks HTTP goes through this function, so attaching them here is what
 * makes "these headers, on every request to this endpoint" true without seven
 * call sites remembering. `resolveEndpointHeaders` is the one place that
 * decides where they came from; see `backend/endpoint-headers.ts`.
 *
 * A caller may pass a map explicitly — tests do — and passing `{}` means the
 * run deliberately sends none.
 */
export function fetchTransport(
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  headers: Readonly<Record<string, string>> | undefined = resolveEndpointHeaders(),
): Transport {
  const extra = headers ?? {};
  const call = async (url: string, init: RequestInit): Promise<HttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      const reason = (error as Error).name === 'AbortError'
        ? `no answer in ${(timeoutMs / 1000).toFixed(0)}s`
        : (error as Error).message;
      throw new TransportError(`${url} — ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    get: (url) => call(url, { method: 'GET', headers: { ...extra } }),
    post: (url, body) => call(url, {
      method: 'POST',
      // The endpoint's headers first, so `content-type` is ours whatever a map
      // says. `parseEndpointHeaders` already refuses that name; this ordering
      // means the refusal is belt and the body's honesty is braces.
      headers: { ...extra, 'content-type': 'application/json' },
      body,
    }),
  };
}

/** No trailing slash, so every call site can concatenate a path. */
export function normaliseEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Whether this model family takes a thinking switch.
 *
 * The qwen3 family are thinking models: left alone they emit a reasoning pass
 * before the answer, which on a translation — a task with no search in it — is
 * pure latency, and at ten seconds a block across two thousand blocks it is
 * hours. Matched on the family prefix rather than a list of tags, because
 * `qwen3:32b`, `qwen3.1:8b-instruct-q4_K_M` and somebody's `qwen3:32b-custom`
 * are all the same question and a list would be wrong about the next one.
 *
 * ONE RULE, TWO SPELLINGS, AND THAT IS WHY IT LIVES HERE. Ollama takes `think`
 * as a top-level field on `/api/chat` and is NOT tolerant of it on a model with
 * no thinking support — qwen2.5 answers such a request with a 400 naming the
 * field, and a run would fail on block one. An OpenAI-compatible server takes
 * `chat_template_kwargs: {enable_thinking: false}`, which a template that does
 * not want it simply ignores. The two doors ask the same question of the same
 * string and write two different bodies, which is exactly the shape a shared
 * rule with a dialect file either side of it is for.
 *
 * THIS IS ON ITS WAY OUT OF THE WIRE ON THE OpenAI DOOR. That server is growing
 * per-model sampling and thinking defaults applied on its side, at which point a
 * request that omits the switch gets the manifest's answer and this rule stops
 * being sent there. Until that lands the switch is still sent, because it is
 * harmless and correct today; nothing new is built on it. On Ollama the field
 * stays: there is no manifest on that side to carry the default.
 */
export function takesThinkField(model: string): boolean {
  return /^qwen3(\.|:|-|$)/i.test(model.trim());
}

/**
 * How much answer one block may generate, in tokens.
 *
 * MEASURED, and the measurement is the whole reason this exists. Block 8 of the
 * Dannenmann scan is `HV111$007458S` — a library accession number stamped on
 * the flyleaf, thirteen characters with no language in them. Asked to translate
 * it, qwen3:32b answered with 16,876 characters and took minutes to do it; the
 * verification refused all three attempts, correctly, and the run had spent ten
 * minutes of GPU proving that a shelf mark is not German.
 *
 * The cap is derived from the ceiling the answer must pass anyway. `run.ts`
 * refuses anything over LONG_RATIO (3×) the source's length as commentary, so
 * generation past ~4× the source is provably wasted: every token of it belongs
 * to an answer that is already going to be thrown away. Four rather than three
 * so the cap can only ever truncate an answer that was doomed — a translation
 * that would have been ACCEPTED can never be cut short by this.
 *
 * The floor is what keeps a one-word source honest: "Vorwort" is seven
 * characters and its answer needs room to be a sentence if the block turns out
 * to be a caption. 128 tokens is a paragraph, which no short block will reach.
 *
 * Chars per token is deliberately LOW (2.5). Guessing high would make the cap
 * bite legitimate answers; guessing low only wastes a little generation on the
 * blocks that were going to be refused anyway.
 */
const ANSWER_CHAR_CEILING = 4;
const CHARS_PER_TOKEN = 2.5;
const PREDICT_FLOOR = 128;

export function answerBudget(source: string): number {
  return Math.max(PREDICT_FLOOR, Math.ceil((source.length * ANSWER_CHAR_CEILING) / CHARS_PER_TOKEN));
}

/**
 * The sampling numbers, for the caller that is not translating.
 *
 * ── WHY THIS IS A PARAMETER AND NOT A SETTING ───────────────────────────────
 *
 * The header's ruling stands and is not being reopened: temperature 0.2 is
 * MEASURED for a translation and there is no knob for it, because the good
 * values are already known (ARCHITECTURE §5). What changed is that the same
 * door serves a second ACT with a different measurement behind it.
 *
 * `clean-text` (src/clean/) asks a model to return an anchored edit list, not
 * prose, and its whole safety story is a wall of validators over a JSON answer.
 * Its temperature is 0 — pinned by the vendored pass, part of the cross-repo
 * contract the training corpora are normalized under, and not this file's to
 * revise. Its `numPredict` is a fixed 2048 for the same reason: an edit list
 * is bounded by the edits a paragraph can carry, and `answerBudget`'s ratio is
 * derived from a TRANSLATION's length, which an edit list is not.
 *
 * ── AND `numCtx` IS A FIELD ONE OF THE TWO DOORS HAS ───────────────────────
 *
 * The context window is a per-request option on Ollama and a property of the
 * SERVER on an OpenAI-compatible one. So this carries it and `ollama.ts` is the
 * only file that reads it: `completionsBody` drops it, because a vLLM's window
 * was fixed when the model was made resident and the KV cache was allocated
 * against it, and there is no request that can move it — there a request is
 * sized INTO the window instead (`capFor`, vllm.ts).
 *
 * It is OPTIONAL rather than required-and-ignored because most callers have no
 * opinion: translate wants the one number its measurements were taken at, and a
 * caller that leaves it off gets it. `clean-text` is the one act that computes a
 * window, once per book, because Ollama fully reloads the runner on any change
 * to it and a per-block estimate would churn a 17 GB model between paragraphs.
 */
export interface ChatTuning {
  temperature: number;
  /** Omitted means `answerBudget` sizes it from the input, as translate wants. */
  numPredict?: number;
  /** Ollama only. Omitted means `DEFAULT_NUM_CTX` (ollama.ts), translate's own. */
  numCtx?: number;
}

/** Translate's own, unchanged — see `ChatTuning` and this file's header. */
export const TRANSLATE_TUNING: ChatTuning = { temperature: 0.2 };
