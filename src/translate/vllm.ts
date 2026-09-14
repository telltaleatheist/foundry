/**
 * translate/vllm — the same three questions, asked of a vLLM server.
 *
 * ── WHY A SECOND TRANSPORT AND NOT A SECOND PROGRAM ─────────────────────────
 *
 * Owen, 2026-09-08: *"lets build in vllm batching. ollama batching doesnt work.
 * its an unfinished feature ollama tried to implement but isnt accessible on the
 * mac or pc. cuda graphs/vllm would probably be the best for all three
 * features."* The three are translate, simplify and the narration cleanup, and
 * every one of them is now a POOL of requests — four in flight by default — over
 * a book of thousands of blocks. A pool is only worth having if the server on
 * the other end runs the requests TOGETHER, and that is the whole of what vLLM
 * is for: continuous batching, one CUDA graph replayed across the batch, and an
 * aggregate throughput that climbs with the number of requests in flight instead
 * of queueing them one behind another.
 *
 * SO WHAT CHANGED WAS THE TRANSPORT AND NOTHING ELSE. The prompts are the same
 * bytes, the temperature is the same number, and the validators, the retries,
 * the bank, the records and the stamp are untouched. This file asks the two
 * questions a pass has for a server — is it there and which model does it hold,
 * and what does it say to this block — in the shape an OpenAI-compatible server
 * understands. Since Owen's ruling of 2026-09-13 it is the ONLY dialect: the
 * Ollama transport that stood beside it is gone (translate/transport.ts says
 * why), and `model-server.ts` proves the server through this file alone.
 *
 * ── THE THINGS THIS DOOR DOES DIFFERENTLY, EACH PAID FOR ────────────────────
 *
 *  - THE CONTEXT WINDOW IS THE SERVER'S, NOT THE REQUEST'S. It is fixed when
 *    the model is made resident and the KV cache is allocated against it, and
 *    there is no per-request field for it. `/v1/models` is read for
 *    `max_model_len` so a request can be sized INTO what the server can hold —
 *    see `capFor` — and a request that cannot fit is refused by name before it
 *    is sent (clean/runner.ts), never sent to be truncated silently.
 *  - THE THINKING SWITCH IS A CHAT-TEMPLATE ARGUMENT. The qwen3 family's
 *    switch on an OpenAI-compatible server is
 *    `chat_template_kwargs: {enable_thinking: false}`, which the server hands
 *    to the Jinja template. A template that does not take the argument ignores
 *    it, so this costs nothing where it does not apply — and it is still sent
 *    only for the family that has it, on `takesThinkField`'s own prefix rule.
 *    The server is growing per-model defaults for this; until they land the
 *    switch is sent, and nothing new is built on it.
 *  - AND BECAUSE THAT SWITCH IS ADVISORY, THE ANSWER IS CHECKED. A template
 *    argument is a request to a Jinja file, and a model or a build that thinks
 *    anyway would put a `<think>…</think>` block in front of every answer in the
 *    book — a translation with reasoning glued to its head, or an edit list the
 *    JSON reader cannot find. `withoutThinking` takes exactly that block off the
 *    front and nothing else.
 *  - NOTHING IS LOADED OR UNLOADED. The operator puts a model on the card
 *    before a pass is spawned and a load evicts what was there, so a pass that
 *    asked for one would be one job taking a narrator's voice off the card.
 *    A server that holds the wrong model is a refusal by name, and a pass
 *    ending is not a reason to take a model off.
 */
import { explainHttpRefusal } from '../backend/http-refusal.js';
import { answerBudget, takesThinkField, type ChatTuning, type Transport } from './transport.js';

/** The server did not do its job. Always names the endpoint. */
export class VllmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VllmError';
  }
}

/** vLLM's own default port and mount, which is where it is unless it was moved. */
export const DEFAULT_VLLM_ENDPOINT = 'http://localhost:8000/v1';

/**
 * The base URL, with `/v1` on it whether or not somebody typed it.
 *
 * `--endpoint http://box:8000` and `--endpoint http://box:8000/v1` are the same
 * intention, and the first is what a person types from memory. Appending it when
 * it is absent is not a guess about somebody's routing: an OpenAI-compatible
 * server mounts `models` and `chat/completions` under a version prefix, and a
 * base that already ends in one is left exactly as it is — including a proxy
 * that mounts it somewhere unusual, since only the LAST segment is examined.
 */
export function normaliseVllmEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/** What a server said it is serving, as much of it as this program reads. */
export interface ServedModel {
  /** The id to send back on every request — an HF path, usually. */
  id: string;
  /** `--max-model-len`, when the server reports it. Null when it does not. */
  maxModelLen: number | null;
}

/**
 * Everything `/v1/models` said, in this program's terms.
 *
 * A vLLM process serves the models it was launched with, and in every deployment
 * this project has that is exactly one. The answer is still read as a LIST,
 * because a server behind a router may hold several, and being told which ones
 * is the difference between "no" and "no, but here is what it has".
 */
export async function servedModels(
  transport: Transport,
  endpoint: string,
): Promise<ServedModel[]> {
  const base = normaliseVllmEndpoint(endpoint);
  let response: { status: number; body: string };
  try {
    response = await transport.get(`${base}/models`);
  } catch (error) {
    throw new VllmError(
      `no server answered at ${base} (${(error as Error).message}). foundry uses an `
      + 'OpenAI-compatible inference server and never starts one — start the service on the '
      + 'machine that has it, or point --endpoint at the machine that does.',
    );
  }
  if (response.status !== 200) {
    throw new VllmError(
      `${base}/models answered ${response.status}. Something is listening there, but it is not an `
      + 'OpenAI-compatible server.',
    );
  }
  let rows: { id?: unknown; max_model_len?: unknown }[];
  try {
    const parsed = JSON.parse(response.body) as {
      data?: { id?: unknown; max_model_len?: unknown }[];
    };
    rows = parsed.data ?? [];
  } catch {
    throw new VllmError(`${base}/models answered 200 with something that is not JSON`);
  }
  return rows
    .filter((row): row is { id: string; max_model_len?: unknown } =>
      typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      maxModelLen: typeof row.max_model_len === 'number' && row.max_model_len > 0
        ? row.max_model_len
        : null,
    }));
}

/**
 * Which model this run uses, proved against the server BEFORE any work starts —
 * `requireModel`'s rule and `requireModel`'s reason: a book's worth of planning
 * takes a second, and what is bought by asking early is the MESSAGE.
 *
 * ── AND WHY A NAME IS OPTIONAL ──────────────────────────────────────────────
 *
 * The server holds ONE resident model, the one the operator made resident, so
 * naming it on the command line is asking somebody to retype a choice already
 * made — an id spelled exactly right or the run fails. Where nothing is named,
 * the served model IS the answer, and it is logged and recorded (the bank key,
 * the stamp) so nothing about the run is anonymous.
 *
 * A NAME THAT WAS GIVEN IS STILL PROVED, and a mismatch is refused with both
 * names in it. Two models are two different books, and "close enough" here would
 * mean silently translating with weights nobody chose.
 */
export async function requireServedModel(
  transport: Transport,
  endpoint: string,
  model: string | undefined,
): Promise<ServedModel> {
  const base = normaliseVllmEndpoint(endpoint);
  const served = await servedModels(transport, endpoint);
  if (served.length === 0) {
    throw new VllmError(
      `the server at ${base} is answering but holds no model at all. Make the model this run `
      + 'needs resident before it starts.',
    );
  }
  const wanted = model === undefined ? '' : model.trim();
  if (wanted.length === 0) {
    if (served.length > 1) {
      throw new VllmError(
        `${base} is serving ${served.length} models and no --model was given, so there is no way `
        + `to know which one this run means. It has: ${served.map((one) => one.id).join(', ')}.`,
      );
    }
    return served[0]!;
  }
  const found = served.find((one) => one.id === wanted);
  if (found === undefined) {
    throw new VllmError(
      `the server at ${base} is not serving "${wanted}". It is serving: `
      + `${served.map((one) => one.id).join(', ')}. Name one of those with --model, or leave `
      + '--model off and the served model is used. A pass never loads a model: make the one '
      + 'this run needs resident first.',
    );
  }
  return found;
}

/**
 * How many tokens this request may generate, given what the server can hold.
 *
 * `answerBudget` is the measured ceiling and the one that matters — it is what
 * stops a thirteen-character shelf mark costing sixteen thousand characters of
 * generation. What is added here is the SERVER's limit: it refuses a request
 * whose prompt plus `max_tokens` exceeds its window with a 400. A book is
 * thousands of requests, and one long paragraph failing on a server with a
 * short window would be a block refused for a reason that has nothing to do
 * with the block.
 *
 * WHEN THE PROMPT ALONE NEARLY FILLS THE WINDOW this answers the floor, and the
 * floor cannot hold an edit list or a paragraph's translation. That is not a
 * silent outcome: `fitsWindow` below says whether a request fits, and the acts
 * that know their longest request up front (clean/runner.ts) refuse before the
 * first one is sent rather than counting a truncated answer as the model's.
 *
 * The prompt estimate is deliberately PESSIMISTIC (2.5 characters to a token,
 * plus a fixed slack): guessing high here only lowers a ceiling that was already
 * generous, and guessing low is a 400.
 */
const CHARS_PER_TOKEN = 2.5;
const PROMPT_SLACK_TOKENS = 256;
const PREDICT_FLOOR = 128;

export function capFor(
  system: string,
  user: string,
  wanted: number,
  maxModelLen: number | null,
): number {
  if (maxModelLen === null) return wanted;
  const room = maxModelLen - promptTokens(system, user);
  if (room <= PREDICT_FLOOR) return PREDICT_FLOOR;
  return Math.min(wanted, room);
}

/** The pessimistic token estimate `capFor` sizes against, for a message to quote. */
export function promptTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / CHARS_PER_TOKEN) + PROMPT_SLACK_TOKENS;
}

/**
 * Does a request wanting `wanted` tokens of answer fit the server's window?
 *
 * The question `capFor` answers by clamping, asked as a yes or no so a pass can
 * refuse BEFORE sending. A server that reported no window fits everything, and
 * finds out on the first request — which is the honest reading of "it did not
 * say", not a guess about what it would have said.
 */
export function fitsWindow(
  system: string,
  user: string,
  wanted: number,
  maxModelLen: number | null,
): boolean {
  if (maxModelLen === null) return true;
  return maxModelLen - promptTokens(system, user) >= wanted;
}

/**
 * The model's FAMILY, for a name that is a path.
 *
 * `takesThinkField` matches a family prefix — `qwen3:32b`, `qwen3.8:27b`. A
 * served id may be an HF path, `Qwen/Qwen3-32B-AWQ`, whose family is in the
 * last segment. Taking the segment asks the same question of the same string
 * and keeps ONE rule about which models think, which is the point.
 */
function familyOf(model: string): string {
  const trimmed = model.trim();
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** The exact JSON body sent for one block. Separate so a test can read it. */
export function completionsBody(
  model: string,
  system: string,
  user: string,
  tuning: ChatTuning,
  maxModelLen: number | null = null,
): string {
  /*
   * THERE IS NO WINDOW FIELD AND NONE IS INVENTED. The window is fixed when the
   * model is made resident; a per-request field for it does not exist, and the
   * nearest thing — sending a smaller `max_tokens` — is a different fact about
   * a different thing. `capFor` is where the server's window is honoured.
   */
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: tuning.temperature,
    max_tokens: capFor(system, user, tuning.numPredict ?? answerBudget(user), maxModelLen),
  };
  if (takesThinkField(familyOf(model))) {
    body['chat_template_kwargs'] = { enable_thinking: false };
  }
  return JSON.stringify(body);
}

/**
 * ── THE CLOSED QUESTION, IN vLLM'S DIALECT ──────────────────────────────────
 *
 * `analyze` does not ask for prose: it asks a question whose answers are
 * enumerated, and it constrains the DECODE to the legal ones rather than asking
 * politely and parsing hopefully (analyze/verify.ts's header carries the
 * measurement — constrained was both more accurate and about five times
 * cheaper). The spelling is `response_format: {type: "json_schema"}`, which the
 * server implements with grammar-constrained decoding underneath.
 *
 * ── A USER TURN AND NO SYSTEM MESSAGE, WHICH IS NOT A SHORTCUT ──────────────
 *
 * The verdict prompts were measured as ONE templated user turn with no system
 * message, and the model must see the same shape here. `/v1/completions` would
 * take the string raw, past the template, and hand the model something it was
 * never trained to read. The prompts themselves are unchanged, byte for byte.
 *
 * ── `strict: true`, AND THE SCHEMA IS THE CALLER'S ──────────────────────────
 *
 * The name is a label the protocol requires and nothing reads it back. The
 * schema is passed through exactly as the caller wrote it, because the caller
 * is the one place that knows what a legal answer is.
 */
export function constrainedChatBody(
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
  maxModelLen: number | null = null,
): string {
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: capFor('', prompt, maxTokens, maxModelLen),
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema, strict: true },
    },
  };
  if (takesThinkField(familyOf(model))) {
    body['chat_template_kwargs'] = { enable_thinking: false };
  }
  return JSON.stringify(body);
}

/**
 * What one chat answer carries, for a caller that treats a bad call as a
 * DEGRADATION rather than an error.
 *
 * `complete` throws, because a translation that cannot reach its server has
 * nothing to say. A stage making hundreds of tiny closed-question calls is the
 * other case: one bad call must not end it (analyze/verify.ts), so this reads
 * the same answer and hands back what happened.
 */
export interface VllmAnswer {
  text: string | null;
  degraded?: string;
  /** True where the answer was cut off at `max_tokens` rather than finished. */
  truncated?: boolean;
}

/** Read one `/v1/chat/completions` answer without throwing. See `VllmAnswer`. */
export async function readChatAnswer(
  transport: Transport,
  endpoint: string,
  body: string,
): Promise<VllmAnswer> {
  const base = normaliseVllmEndpoint(endpoint);
  let response: { status: number; body: string };
  try {
    response = await transport.post(`${base}/chat/completions`, body);
  } catch (error) {
    return { text: null, degraded: (error as Error).message };
  }
  if (response.status !== 200) {
    return {
      text: null,
      degraded: `${base} ${explainHttpRefusal(response.status, '', response.body)}`,
    };
  }
  let parsed: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    return { text: null, degraded: `vllm at ${base} answered 200 with something that is not JSON` };
  }
  const choice = parsed.choices?.[0];
  if (choice === undefined || typeof choice.message?.content !== 'string') {
    return {
      text: null,
      degraded: `vllm at ${base} answered without choices[0].message.content`,
    };
  }
  return {
    text: withoutThinking(choice.message.content),
    ...(choice.finish_reason === 'length' ? { truncated: true } : {}),
  };
}

/**
 * A leading `<think>…</think>` block, taken off the front.
 *
 * ── Narrow on purpose ───────────────────────────────────────────────────────
 *
 * This is not a general cleaner. It fires only where the answer BEGINS with the
 * opening tag (after whitespace) and the closing tag is present, which is the
 * exact shape a reasoning model emits when the template's thinking switch did
 * not take. Anything else is left alone: a `<think>` in the middle of an answer
 * belongs to the text — a book about writing could contain the word in tags —
 * and an unterminated one means the answer was cut off, which is a truncation
 * the validators must be allowed to see rather than a header to strip.
 */
export function withoutThinking(text: string): string {
  const lead = text.trimStart();
  if (!lead.startsWith('<think>')) return text;
  const end = lead.indexOf('</think>');
  if (end === -1) return text;
  return lead.slice(end + '</think>'.length).trimStart();
}

/**
 * Ask the server for one block.
 *
 * Every failure here is a failure of the SERVER — unreachable, an error status,
 * an answer that is not the documented shape — and every one of them throws
 * rather than returning something the caller might retry. `chat`'s rule,
 * verbatim, because it is the same rule: a server that is not there is not going
 * to be there on the second attempt either.
 */
export async function complete(
  transport: Transport,
  endpoint: string,
  served: ServedModel,
  system: string,
  user: string,
  tuning: ChatTuning,
): Promise<string> {
  const base = normaliseVllmEndpoint(endpoint);
  const response = await transport.post(
    `${base}/chat/completions`,
    completionsBody(served.id, system, user, tuning, served.maxModelLen),
  );
  if (response.status !== 200) {
    throw new VllmError(
      `${base}, for model "${served.id}", `
      + explainHttpRefusal(response.status, '', response.body),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new VllmError(
      `vllm at ${base} answered 200 with something that is not JSON: `
      + `${response.body.trim().slice(0, 200)}`,
    );
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new VllmError(
      `vllm at ${base} answered without choices[0].message.content — this endpoint is answering, `
      + 'but not as an OpenAI-compatible chat server does',
    );
  }
  return withoutThinking(content);
}
