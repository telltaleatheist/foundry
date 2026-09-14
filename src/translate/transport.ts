/**
 * translate/transport — HTTP as a value, and the numbers every act shares.
 *
 * ── THE SERVER IS SOMEBODY ELSE'S, AND THERE IS ONE KIND OF IT ──────────────
 *
 * This file sends HTTP and reads what comes back. It does not start a server,
 * does not stop one, does not load a model and does not unload one. Owen's
 * ruling of 2026-09-13: every model call this engine makes goes to ONE kind of
 * server — an OpenAI-compatible chat door, fronted by the inference service the
 * app registers — and the operator puts a model on the card before a pass is
 * spawned. A server that is not answering is not a condition to recover from;
 * it is the end of the run, said in a sentence naming the URL that was tried.
 *
 * Until that ruling this file was `ollama.ts`, and it held a second dialect —
 * `/api/chat` with `num_ctx` per request and `keep_alive: 0` to give the card
 * back. All of that is gone, and deliberately not kept behind a flag: a window
 * pinned per request, a release the pass performs, and a default server on a
 * port nobody registered are three things the ruling forbids, and code that
 * could still do them is code that will be asked to.
 *
 * ── WHAT IS STILL HERE, AND WHY IT IS HERE AND NOT IN `vllm.ts` ─────────────
 *
 * `Transport` is the seam the tests drive the whole verification loop through
 * without a GPU; `fetchTransport` is the one real implementation and the one
 * place an endpoint's headers are attached. `answerBudget` and `ChatTuning` are
 * measurements shared by every act, and `takesThinkField` is the rule for which
 * model families take a thinking switch. They are the act-independent half;
 * `vllm.ts` is the dialect.
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
 * THIS IS ON ITS WAY OUT OF THE WIRE. The server is growing per-model sampling
 * and thinking defaults applied on its side, at which point a request that
 * omits the switch gets the manifest's answer and this rule stops being sent.
 * Until that lands the switch is still sent, because it is harmless and correct
 * today; nothing new is built on it.
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
 * THERE IS NO CONTEXT-WINDOW FIELD. The window is the server's, fixed when the
 * model was made resident and reported back through the model listing, and a
 * request is sized INTO it (`capFor`, vllm.ts) rather than asking for one.
 */
export interface ChatTuning {
  temperature: number;
  /** Omitted means `answerBudget` sizes it from the input, as translate wants. */
  numPredict?: number;
}

/** Translate's own, unchanged — see `ChatTuning` and this file's header. */
export const TRANSLATE_TUNING: ChatTuning = { temperature: 0.2 };
