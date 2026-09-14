/**
 * translate/ollama — the LOCAL door, and the fact that it is somebody else's
 * server.
 *
 * ── WHY THIS FILE EXISTS AGAIN ──────────────────────────────────────────────
 *
 * For one night (2026-09-13) this engine had a single inference door and this
 * dialect was deleted: `ollama.ts` became `transport.ts`, and everything
 * Ollama-shaped went with it rather than behind a flag. Owen reversed the
 * premise the same night (docs/SLOTS.md §1): foundry must operate with no
 * inference service present at all — translation, simplify, analyze, the page
 * reading, all of it — through the doors a person already has on Windows or a
 * Mac, and the fast shared server is a thing they can CONNECT to for the speed
 * tricks rather than a thing they must install to run anything.
 *
 * So there are two doors, and this is the one a person has on their own machine
 * with nothing installed but Ollama. It is NOT the file it was before the
 * deletion: everything dialect-agnostic that came out of it stayed out — the
 * `Transport` seam, `fetchTransport` and the header map, `answerBudget`,
 * `ChatTuning`, `takesThinkField` all live in `transport.ts` and are shared with
 * the OpenAI door (`vllm.ts`). What is here is only what is true of Ollama and
 * false of the other one.
 *
 * ── OLLAMA IS EXTERNAL ──────────────────────────────────────────────────────
 *
 * This file sends it HTTP and reads what comes back. It does not start one, does
 * not stop one, does not pull a model and does not warm anything up. A server
 * that is not answering is not a condition to recover from — it is the end of
 * the run, said in a sentence that names the URL that was tried, because the
 * person reading it is about to type `ollama serve` into a terminal and the only
 * thing they need from foundry is WHICH endpoint was silent.
 *
 * ── THE ONE THING THIS DOOR DOES THAT THE OTHER NEVER DOES ──────────────────
 *
 * IT UNLOADS. Owen, 2026-09-13: *"ollama should always, always bring down the
 * model as soon as the job is done. they arent chatting with it, theyre using it
 * for a job and then closing the connection."* Ollama holds a model in VRAM
 * after it answers, on a five-minute idle timer that EVERY request resets —
 * right for a chat window, wrong for this: a book is thousands of requests over
 * hours, and when the last one lands twenty gigabytes stay pinned with nothing
 * to answer, on the card the reading server wants next. So `unloadModel` runs at
 * the end of every run, success or failure, and there is no flag to keep the
 * model: a run that wanted the weights kept would be a job holding a card on
 * behalf of work that is over.
 *
 * ── A MODEL MUST BE NAMED ON THIS DOOR ──────────────────────────────────────
 *
 * An Ollama holds a LIBRARY. The OpenAI door serves one resident model, so an
 * absent `--model` means "whatever is served" there and the server is asked; the
 * same absence here would be a run with no way to choose between qwen3.8:27b and
 * llama3.1:8b, and picking one would be foundry translating a book with a model
 * nobody chose. `requireModel` proves the name against `/api/tags` before any
 * work starts, and `model-server.ts` refuses an absent one by name before that.
 *
 * ── `think: false` FOR qwen3, AND NOT FOR qwen2.5 ──────────────────────────
 *
 * The rule for WHICH models think is `takesThinkField` and it is shared
 * (transport.ts). The SPELLING is this file's: Ollama takes `think` as a
 * top-level field on `/api/chat` and answers a 400 naming the field when the
 * model has no thinking support, so the field is sent only where the model's
 * name says it belongs and the run would otherwise fail on block one.
 *
 * ── TEMPERATURE IS 0.2 AND IS NOT A SETTING ────────────────────────────────
 *
 * Measured, and measured on this door: zero made the 14b model repeat whole
 * clauses on long paragraphs; above ~0.4 the 32b model started inventing
 * connective sentences that were not in the source. 0.2 is where both stopped,
 * and a knob here would be a knob whose good values are already known
 * (ARCHITECTURE §5). It reaches this file as `ChatTuning`, shared with the other
 * door so the two ask the same question at the same temperature.
 */

import {
  answerBudget, normaliseEndpoint, takesThinkField, type ChatTuning, type HttpResponse,
  type Transport,
} from './transport.js';

/** The server did not do its job. Always names the endpoint. */
export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

/**
 * The context window a request asks for when the caller has no opinion.
 *
 * 8192 is translate's own, and translate is the caller with no opinion: a block
 * is a paragraph, the answer is bounded at four times its length
 * (`answerBudget`), and every measurement in this repo's translate header was
 * taken at this number. `clean-text` is the act that computes one instead
 * (`contextWindowFor`, clean/runner.ts), because its request is a whole prompt
 * plus a block plus a fixed 2048-token edit list and that does not fit a
 * constant.
 *
 * IT IS A REQUEST OPTION AND THAT IS THE DIFFERENCE BETWEEN THE DOORS. Ollama
 * allocates the KV cache when it loads the runner for a given `num_ctx` and
 * FULLY RELOADS on any change to it — which is why a caller that computes one
 * computes it once for a whole book, and why the other door, whose window was
 * fixed when the model was made resident, is sent no such field at all.
 */
const DEFAULT_NUM_CTX = 8192;

/** The exact JSON body sent for one block. Separate so a test can read it. */
export function chatBody(
  model: string,
  system: string,
  user: string,
  tuning: ChatTuning,
): string {
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // `num_predict` is sized from the block — see `answerBudget`. It is the
    // difference between a model that rambles for two minutes and a model that
    // rambles for two seconds, on a block whose answer is refused either way.
    options: {
      temperature: tuning.temperature,
      num_ctx: tuning.numCtx ?? DEFAULT_NUM_CTX,
      num_predict: tuning.numPredict ?? answerBudget(user),
    },
  };
  if (takesThinkField(model)) body['think'] = false;
  return JSON.stringify(body);
}

/**
 * Give the weights back when the run is over.
 *
 * ── Why this exists, and why it is not a choice ─────────────────────────────
 *
 * The header carries Owen's ruling: a job is not a chat, and a job that is over
 * holds nothing. `keep_alive: 0` is Ollama's own door for this — a request that
 * carries it unloads the model when it completes instead of arming the
 * five-minute idle timer. Sent with no messages, it does no generation at all;
 * it exists purely to say "we are done with you".
 *
 * There is no `--keep-model` any more and there is not going to be one. It
 * existed for an Ollama shared with other work, and the answer to that case is
 * that the other work will load its own model back — which costs seconds —
 * whereas a card held by a finished job costs the next job everything.
 *
 * ── Best effort, and never a failure ────────────────────────────────────────
 *
 * This CANNOT throw. It runs after the book has been written, and a run that
 * produced everything it was asked for must not be reported as failed because
 * the server did not acknowledge a courtesy. A server that has already gone
 * away has, by definition, released the memory this was asking it to release.
 * The return value says what happened so the caller can log it; nothing more
 * depends on it.
 */
export async function unloadModel(
  transport: Transport,
  endpoint: string,
  model: string,
): Promise<boolean> {
  const url = `${normaliseEndpoint(endpoint)}/api/chat`;
  const body = JSON.stringify({ model, messages: [], keep_alive: 0, stream: false });
  try {
    const response = await transport.post(url, body);
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Ask the server for one block's translation.
 *
 * Every failure here is a failure of the SERVER — unreachable, an error status,
 * an answer that is not the documented shape — and every one of them throws
 * rather than returning something the caller might retry. A model that answers
 * badly is the caller's problem and is retried; a server that is not there is
 * not going to be there on the second attempt either, and burning two more
 * requests to prove it delays the message by a minute.
 */
export async function chat(
  transport: Transport,
  endpoint: string,
  model: string,
  system: string,
  user: string,
  tuning: ChatTuning,
): Promise<string> {
  const url = `${normaliseEndpoint(endpoint)}/api/chat`;
  const response = await transport.post(url, chatBody(model, system, user, tuning));
  if (response.status !== 200) {
    throw new OllamaError(
      `ollama at ${normaliseEndpoint(endpoint)} answered ${response.status} for model "${model}": `
      + `${response.body.trim().slice(0, 400) || '(no body)'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new OllamaError(
      `ollama at ${normaliseEndpoint(endpoint)} answered 200 with something that is not JSON: `
      + `${response.body.trim().slice(0, 200)}`,
    );
  }
  const content = (parsed as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== 'string') {
    throw new OllamaError(
      `ollama at ${normaliseEndpoint(endpoint)} answered without message.content — `
      + 'this endpoint is answering, but not as an Ollama /api/chat server does',
    );
  }
  return content;
}

/**
 * Prove the server is there and holds the model, BEFORE any work starts.
 *
 * Reading the EPUB and masking two thousand blocks takes a second or two, and
 * the run would discover a missing model on the first request anyway. This runs
 * first for the message, not the timing: "no model named qwen3:32b — installed:
 * qwen2.5:14b, llama3.1:8b" is a sentence somebody can act on, and it is worth
 * far more than the same discovery phrased as a 404 in the middle of a log.
 */
export async function requireModel(
  transport: Transport,
  endpoint: string,
  model: string,
): Promise<void> {
  const base = normaliseEndpoint(endpoint);
  let response: HttpResponse;
  try {
    response = await transport.get(`${base}/api/tags`);
  } catch (error) {
    throw new OllamaError(
      `no Ollama server answered at ${base} (${(error as Error).message}). foundry uses an Ollama `
      + 'server and never starts one — run `ollama serve`, or pass --endpoint with the URL of the '
      + 'machine that has it.',
    );
  }
  if (response.status !== 200) {
    throw new OllamaError(
      `${base}/api/tags answered ${response.status}. Something is listening there, but it is not `
      + 'an Ollama server.',
    );
  }
  let names: string[];
  try {
    const parsed = JSON.parse(response.body) as { models?: { name?: unknown }[] };
    names = (parsed.models ?? []).map((m) => String(m.name ?? '')).filter((n) => n.length > 0);
  } catch {
    throw new OllamaError(`${base}/api/tags answered 200 with something that is not JSON`);
  }

  /*
   * `qwen3:32b` and `qwen3:32b` under Ollama's implicit `:latest` are the same
   * model, and a person who typed the short name meant the tag they have. An
   * exact match, or the bare name against a `:latest` tag, both count; nothing
   * else does, because "close enough" here means silently translating a book
   * with a model nobody chose.
   */
  const wanted = model.trim();
  const has = names.some((n) => n === wanted || n === `${wanted}:latest`);
  if (!has) {
    throw new OllamaError(
      `ollama at ${base} has no model named "${wanted}". `
      + (names.length === 0
        ? 'It has no models installed at all. '
        : `It has: ${names.join(', ')}. `)
      + `Pull it with \`ollama pull ${wanted}\`, or name one of the above with --model.`,
    );
  }
}

/**
 * ── THE CLOSED QUESTION, IN OLLAMA'S DIALECT ────────────────────────────────
 *
 * `analyze` does not ask for prose: it asks a question whose answers are
 * enumerated, and it constrains the DECODE to the legal ones rather than asking
 * politely and parsing hopefully (analyze/verify.ts's header carries the
 * measurement — constrained was both more accurate and about five times
 * cheaper). Ollama's spelling is `format` on `/api/generate`, carrying the
 * schema OBJECT rather than the string `'json'`: the string would buy
 * well-formed JSON and this needs the legal ANSWERS.
 *
 * `/api/generate` RATHER THAN `/api/chat`, AND THAT IS WHERE IT WAS MEASURED.
 * The verdict prompts are one templated turn with no system message, and
 * briefcase's numbers were taken through this endpoint with this body. The other
 * door reaches the same constrained decode through `response_format` on a chat
 * turn (vllm.ts), which is the only spelling it has.
 *
 * Generic in the schema, so the second command that asks a model a closed
 * question does not have to write this object again.
 */
export function constrainedGenerateBody(
  model: string,
  prompt: string,
  numCtx: number,
  schema: Record<string, unknown>,
  predictTokens: number,
): string {
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    // The schema, not the string 'json': it constrains the decode to the legal
    // answers rather than merely to well-formed JSON.
    format: schema,
    options: {
      num_ctx: numCtx,
      num_predict: predictTokens,
      // Zero, because this is a classification with a right answer and any
      // sampling above it is variance in an accusation.
      temperature: 0,
    },
  };
  // transport.ts's ruling, in this door's spelling: the qwen3 family takes
  // `think`, and a model that does not answers a request carrying it with a 400
  // naming the field.
  if (takesThinkField(model)) body['think'] = false;
  return JSON.stringify(body);
}

/**
 * What one `/api/generate` answer carries, for a caller that treats a bad call
 * as a DEGRADATION rather than an error.
 *
 * The same three fields `VllmAnswer` carries (vllm.ts), because the caller reads
 * them the same way on both doors: one bad call must not end a stage that is
 * making hundreds of tiny ones, and a truncated answer is a specific complaint
 * rather than a missing one.
 */
export interface OllamaAnswer {
  text: string | null;
  degraded?: string;
  /** True where the answer was cut off at `num_predict` rather than finished. */
  truncated?: boolean;
}

/**
 * Read one schema-constrained `/api/generate` answer without throwing.
 *
 * ── THE THINKING-MODEL TRAP, AND IT IS NOT OPTIONAL ─────────────────────────
 *
 * MEASURED IN BRIEFCASE with qwen3.8:27b: when a JSON grammar is sent to a
 * THINKING model, it constrains the whole output stream from the first token, so
 * the model never opens an answer channel — the object it emits is classified as
 * reasoning and arrives in `thinking` with `response` EMPTY. Without reading
 * `thinking` as a fallback, every verdict in the stage degrades and the report
 * comes back with nothing in it against a perfectly healthy server.
 *
 * IT IS READ ONLY WHEN A SCHEMA WAS SENT AND `response` IS EMPTY, which is the
 * narrowest form of the rule that still works. An unconstrained call's
 * `thinking` is genuinely reasoning and reading it would hand the caller a
 * model's deliberation in place of its answer; a constrained call's is the
 * answer, misfiled by the server. `constrainedGenerateBody` is the only body
 * this function sends, so the first half of that condition is structural.
 */
export async function readGenerateAnswer(
  transport: Transport,
  endpoint: string,
  model: string,
  prompt: string,
  numCtx: number,
  schema: Record<string, unknown>,
  predictTokens: number,
): Promise<OllamaAnswer> {
  const base = normaliseEndpoint(endpoint);
  let response: HttpResponse;
  try {
    response = await transport.post(
      `${base}/api/generate`,
      constrainedGenerateBody(model, prompt, numCtx, schema, predictTokens),
    );
  } catch (error) {
    return {
      text: null,
      degraded: error instanceof OllamaError ? error.message : (error as Error).message,
    };
  }
  if (response.status !== 200) {
    return {
      text: null,
      degraded: `ollama at ${base} answered ${response.status}: `
        + `${response.body.trim().slice(0, 200) || '(no body)'}`,
    };
  }
  let parsed: { response?: unknown; thinking?: unknown; done_reason?: unknown };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    return { text: null, degraded: `ollama at ${base} answered 200 with something that is not JSON` };
  }

  let text = typeof parsed.response === 'string' ? parsed.response : '';
  if (text.trim().length === 0
    && typeof parsed.thinking === 'string'
    && parsed.thinking.trim().length > 0) {
    text = parsed.thinking;
  }
  if (parsed.done_reason === 'length') return { text: null, truncated: true };
  return { text };
}
