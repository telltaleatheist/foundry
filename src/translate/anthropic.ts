/**
 * translate/anthropic — the same questions, asked of Anthropic's own API.
 *
 * ── WHY A THIRD DIALECT AND NOT A THIRD URL ─────────────────────────────────
 *
 * Owen, 2026-09-14: *"give them the option of connecting an api key for openai
 * or claude instead of using the 27b or the 9b. if the user wants to they can
 * use usage credits from a cloud model… for weaker systems."* OpenAI needed no
 * new code at all — it is an OpenAI-compatible door with a credential in the
 * header map, which is what `vllm.ts` has always spoken. Anthropic is not: the
 * route is `/v1/messages`, the system prompt is a TOP-LEVEL field rather than a
 * message with a role, the credential header is `x-api-key` rather than
 * `Authorization`, a protocol-version header is mandatory, the answer is a LIST
 * OF CONTENT BLOCKS rather than a choice with a message in it, the truncation
 * signal is `stop_reason` rather than `finish_reason`, and the constrained
 * answer is a forced tool call rather than a `response_format`. That is a
 * dialect, and this program's rule about dialects is docs/SLOTS.md §2: they are
 * DECLARED on `--server` and never sniffed from a URL, and each one lives in a
 * file that knows only its own wire.
 *
 * So what is here is ONLY what is true of Anthropic and false of the other two.
 * The prompts are the same bytes, the temperature is the same number, and the
 * validators, the retries, the bank, the records and the stamp are untouched —
 * `vllm.ts`'s own ruling, verbatim, because it is the same ruling.
 *
 * ── WHAT THIS DOOR DOES DIFFERENTLY, EACH PAID FOR ──────────────────────────
 *
 *  - `--model` IS REQUIRED, exactly on Ollama's argument and not on the OpenAI
 *    door's. A provider holds a CATALOG — a dozen models across three
 *    generations, several of them still in service — so an absent name has no
 *    answer, and picking one would be foundry translating a book with a model
 *    nobody chose. `MODEL_REQUIRED_ON_ANTHROPIC` carries the sentence.
 *  - THE NAME IS CHECKED AGAINST THE LISTING, AND THE ABSENCE OF A CHECK IS
 *    SAID OUT LOUD. `GET /v1/models` exists here, so a typo'd model can be
 *    refused before a book's worth of requests is sent. But a listing is not
 *    the WORK: a key scoped to `/v1/messages` alone, or a proxy that mounts
 *    only what it serves, would fail the listing while answering every request
 *    this run actually makes. Refusing there would be this program inventing a
 *    requirement the provider does not have. So a listing that does not answer
 *    means the check is SKIPPED and the run says so — `confirmServedModel`'s
 *    rule (src/vlm/read.ts), which is that an unperformed check is reported,
 *    never quietly treated as a passed one.
 *  - NOTHING IS LOADED, NOTHING IS UNLOADED, AND NO WINDOW IS PINNED. The
 *    window is the provider's, it is not in the listing and there is no request
 *    that moves it, so `maxModelLen` is null on this door and `ChatTuning`'s
 *    `numPredict ?? answerBudget` goes out as `max_tokens` unclamped. There is
 *    no card to give back at the end of a run: `releaseModel` answers
 *    `not-ours` and the act says so once.
 *  - NOTHING IS SENT ABOUT THINKING. Claude models do not reason unless a
 *    request asks them to, so the correct switch is the ABSENCE of a field —
 *    where the qwen3 family needs `think: false` on one door and
 *    `chat_template_kwargs` on another to stop them. `takesThinkField` is
 *    therefore never consulted here, and that is not an oversight: a body
 *    carrying an unknown field to this API is a 400 naming the field, and
 *    `withoutThinking`'s stripping has nothing to strip.
 *  - `anthropic-version` IS THE ENGINE'S TO SEND. The credential arrives
 *    through the header map like every other credential in this program — the
 *    app composes `{"x-api-key": "…"}` and this file never sees it — but the
 *    version constant is a property of the DIALECT, true at every endpoint and
 *    for every key, and asking the app to put a protocol constant into a
 *    credential map would be teaching the credential map what protocol it is
 *    for. `Transport`'s optional dialect-header argument is how it goes out.
 *  - A 429 IS A WAIT AND SO IS A 529. `withBusyWait` (transport.ts) holds the
 *    whole of that argument and both cloud doors share it; this file's only
 *    contribution is the list of statuses that mean "not yet" HERE, which is
 *    the standard 429 plus Anthropic's own 529 "overloaded".
 */
import { explainHttpRefusal } from '../backend/http-refusal.js';
import {
  answerBudget, readUsage, recordUsage, withBusyWait, type ChatTuning, type HttpResponse,
  type Transport,
} from './transport.js';

/** The provider did not do its job. Always names the endpoint. */
export class AnthropicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicError';
  }
}

/**
 * Where Anthropic is, declared rather than discovered.
 *
 * A constant, not a setting fallback: `backend.endpointUrl` names an
 * OpenAI-compatible URL (the reading server and the text server are the same
 * machine on that door), and handing it to a run about to speak `/v1/messages`
 * would point a person's Claude job at their vLLM — `textEndpoint`'s Ollama
 * argument, word for word, for the same reason.
 */
export const DEFAULT_ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';

/**
 * The protocol version this file speaks, and the header it goes out in.
 *
 * Anthropic requires `anthropic-version` on every request and dates its
 * breaking changes with it. `2023-06-01` is the version the request bodies
 * below are written against; changing the constant without reading the
 * migration notes would be this program claiming to speak a protocol it has not
 * been checked against.
 */
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DIALECT_HEADERS: Readonly<Record<string, string>> = {
  'anthropic-version': ANTHROPIC_VERSION,
};

/** The statuses that mean "wait" here. See `withBusyWait` for the argument. */
const BUSY_STATUSES = [429, 529] as const;

/**
 * The base URL with no version prefix on it, because every route below spells
 * its own.
 *
 * The inverse of `normaliseVllmEndpoint`, and deliberately so. There a base
 * WITHOUT `/v1` gets one, because an OpenAI-compatible server mounts its routes
 * under a version prefix that is part of the address somebody was given. Here
 * the two routes this file uses are `/v1/messages` and `/v1/models` and they
 * are written out, so what has to be true of the base is that it does NOT
 * already end in a version — otherwise `https://api.anthropic.com/v1`, which is
 * what a person types from memory, becomes `…/v1/v1/messages` and 404s.
 */
export function normaliseAnthropicEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  return base.replace(/\/v\d+$/, '');
}

/**
 * Every model id `GET /v1/models` named, or a throw if it could not be read.
 *
 * The throw is caught by the one caller, which turns it into a SAID skip rather
 * than a refusal — see `requireListedModel` and this file's header. Reading the
 * answer as a list rather than as one model is the same reading `servedModels`
 * does and for a stronger reason: a provider genuinely holds many.
 */
export async function listedModels(
  transport: Transport,
  endpoint: string,
): Promise<string[]> {
  const base = normaliseAnthropicEndpoint(endpoint);
  let response: HttpResponse;
  try {
    response = await withBusyWait(
      () => transport.get(`${base}/v1/models`, ANTHROPIC_DIALECT_HEADERS),
      { retryOn: BUSY_STATUSES, where: `${base}/v1/models` },
    );
  } catch (error) {
    throw new AnthropicError(`${base} did not answer (${(error as Error).message})`);
  }
  if (response.status !== 200) {
    throw new AnthropicError(
      `${base}/v1/models ${explainHttpRefusal(response.status, '', response.body)}`,
    );
  }
  let rows: { id?: unknown }[];
  try {
    const parsed = JSON.parse(response.body) as { data?: { id?: unknown }[] };
    rows = parsed.data ?? [];
  } catch {
    throw new AnthropicError(`${base}/v1/models answered 200 with something that is not JSON`);
  }
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * The sentence a run with no `--model` on this door is refused with.
 *
 * `MODEL_REQUIRED_ON_OLLAMA`'s shape and `MODEL_REQUIRED_ON_OLLAMA`'s reason
 * (model-server.ts): one constant, thrown from two layers, because "a provider
 * needs a model named" is a fact about the DIALECT and "you left a flag off" is
 * a fact about argv, and a person who mistyped a command line wants to hear
 * about the command line.
 */
export const MODEL_REQUIRED_ON_ANTHROPIC =
  'a cloud provider holds a catalog, so this run must say which model it means with --model';

/**
 * Prove the model BEFORE any work starts — or say that it could not be proved.
 *
 * `requireModel`'s timing argument (ollama.ts): a book's worth of planning takes
 * a second and the run would discover a bad name on request one anyway, so what
 * asking early buys is the MESSAGE. What is different here is the third outcome:
 * a listing that does not answer is not a refusal, it is a check that did not
 * happen, and this run says which of the three it got rather than letting
 * silence stand for "checked and fine".
 */
export async function requireListedModel(
  transport: Transport,
  endpoint: string,
  model: string,
  log: (line: string) => void,
): Promise<void> {
  const base = normaliseAnthropicEndpoint(endpoint);
  const wanted = model.trim();
  if (wanted.length === 0) throw new AnthropicError(MODEL_REQUIRED_ON_ANTHROPIC);
  let listed: string[];
  try {
    listed = await listedModels(transport, endpoint);
  } catch (error) {
    log(
      `could not read the model listing at ${base} `
      + `(${(error as Error).message.split(/\r?\n/)[0]}), so "${wanted}" goes UNCHECKED — this run `
      + 'will find out on its first request whether the provider has it.',
    );
    return;
  }
  if (listed.includes(wanted)) return;
  throw new AnthropicError(
    `${base} does not offer a model named "${wanted}" to this key. It offers: `
    + `${listed.join(', ') || '(nothing)'}. Name one of those with --model.`,
  );
}

/**
 * The exact JSON body sent for one block. Separate so a test can read it.
 *
 * ── THE SYSTEM PROMPT IS A FIELD, NOT A MESSAGE ─────────────────────────────
 *
 * The other two doors carry it as `{role: 'system'}` in the message list. This
 * API has no system role at all: the prompt is a top-level `system` string and
 * `messages` holds the turns. The BYTES are identical either way — the same
 * prompt string every act composes — which is what makes this a dialect
 * difference rather than a second way of asking.
 *
 * ── AND THERE IS NO WINDOW TO SIZE INTO ─────────────────────────────────────
 *
 * `capFor` exists on the OpenAI door because a vLLM reports `max_model_len` and
 * refuses a request that exceeds it. A provider reports no such number and
 * enforces its own limits with a 400 that names them, so `max_tokens` here is
 * the measured answer budget and nothing else — clamping it against a window
 * this program does not know would be arithmetic over a guess.
 */
export function messagesBody(
  model: string,
  system: string,
  user: string,
  tuning: ChatTuning,
): string {
  /*
   * NOTHING IS SENT ABOUT THINKING, and the absence is the setting. See the
   * header: Claude models do not reason unless asked, so there is no switch to
   * turn off, and an unknown field on this API is a 400 naming it.
   */
  return JSON.stringify({
    model,
    max_tokens: tuning.numPredict ?? answerBudget(user),
    temperature: tuning.temperature,
    system,
    messages: [{ role: 'user', content: user }],
  });
}

/**
 * ── THE CLOSED QUESTION, IN ANTHROPIC'S DIALECT ─────────────────────────────
 *
 * `analyze` does not ask for prose: it asks a question whose answers are
 * enumerated, and it constrains the DECODE to the legal ones rather than asking
 * politely and parsing hopefully (analyze/verify.ts's header carries the
 * measurement — constrained was both more accurate and about five times
 * cheaper). The three doors spell that constraint three ways and mean one
 * thing: `format: <schema>` on Ollama's `/api/generate`, `response_format:
 * {type: "json_schema"}` on an OpenAI chat turn, and HERE a single TOOL whose
 * `input_schema` is the caller's schema, with `tool_choice` naming it so the
 * model has no option but to call it. The tool is not a tool — nothing runs,
 * and nothing is handed back to the model — it is this API's way of saying
 * "your next output is an object of this shape".
 *
 * A USER TURN AND NO SYSTEM PROMPT, which is not a shortcut: the verdict
 * prompts were measured as one templated user turn with no system message and
 * the model must see the same shape here.
 *
 * THE SCHEMA IS THE CALLER'S, passed through exactly as written, because the
 * caller is the one place that knows what a legal answer is. The tool's NAME is
 * a label the protocol requires and nothing reads it back — `tool_choice` names
 * the same string, which is the only place it matters.
 */
export const CONSTRAINED_TOOL_NAME = 'answer';

export function constrainedToolBody(
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
): string {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    // Zero, because this is a classification with a right answer and any
    // sampling above it is variance in an accusation.
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    tools: [{
      name: CONSTRAINED_TOOL_NAME,
      description: 'Give the answer to the question, in the shape this schema describes.',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: CONSTRAINED_TOOL_NAME },
  });
}

/**
 * What one `/v1/messages` answer carries, for a caller that treats a bad call
 * as a DEGRADATION rather than an error.
 *
 * The same three fields `VllmAnswer` and `OllamaAnswer` carry, because the
 * caller reads them the same way on all three doors: one bad call must not end
 * a stage that is making hundreds of tiny ones, and a truncated answer is a
 * specific complaint rather than a missing one.
 */
export interface AnthropicAnswer {
  text: string | null;
  degraded?: string;
  /** True where the answer was cut off at `max_tokens` rather than finished. */
  truncated?: boolean;
}

/**
 * What this program reads out of an answer's content blocks.
 *
 * A `tool_use` block's `input` IS the answer where a tool was forced, and it is
 * re-serialised so that every door hands its caller the same thing: a STRING
 * with the object in it, which `parseVerdict` reads the same way whichever door
 * produced it. A `text` block is the answer everywhere else.
 *
 * THE FIRST BLOCK OF ITS KIND, not `content[0]` blindly. With no thinking asked
 * for there is exactly one block and it is first; scanning costs nothing and
 * survives a provider that one day prefixes a block this run did not request,
 * where indexing would report "an answer with no text in it" about an answer
 * that plainly has some.
 */
function answerText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as { type?: unknown; text?: unknown; input?: unknown }[]) {
    if (block.type === 'tool_use' && block.input !== undefined && block.input !== null) {
      return JSON.stringify(block.input);
    }
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

/**
 * Read one `/v1/messages` answer without throwing, and count what it cost.
 *
 * `stop_reason === 'max_tokens'` IS THE TRUNCATION SIGNAL, the counterpart of
 * `finish_reason === 'length'` on the OpenAI door and `done_reason === 'length'`
 * on Ollama. It is read for the same reason all three are: an answer cut off at
 * the ceiling is a specific complaint the caller reports, never an answer with a
 * piece missing that the validators are left to discover.
 */
export async function readMessageAnswer(
  transport: Transport,
  endpoint: string,
  body: string,
): Promise<AnthropicAnswer> {
  const base = normaliseAnthropicEndpoint(endpoint);
  let response: HttpResponse;
  try {
    response = await withBusyWait(
      () => transport.post(`${base}/v1/messages`, body, ANTHROPIC_DIALECT_HEADERS),
      { retryOn: BUSY_STATUSES, where: `${base}/v1/messages` },
    );
  } catch (error) {
    return { text: null, degraded: (error as Error).message };
  }
  if (response.status !== 200) {
    return {
      text: null,
      degraded: `${base} ${explainHttpRefusal(response.status, '', response.body)}`,
    };
  }
  let parsed: { content?: unknown; stop_reason?: unknown; usage?: unknown };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    return {
      text: null,
      degraded: `the provider at ${base} answered 200 with something that is not JSON`,
    };
  }
  const spent = readUsage(parsed.usage);
  recordUsage(spent.input, spent.output);
  if (parsed.stop_reason === 'max_tokens') return { text: null, truncated: true };
  const text = answerText(parsed.content);
  if (text === null) {
    return {
      text: null,
      degraded: `the provider at ${base} answered without a text or tool_use block in content`,
    };
  }
  return { text };
}

/**
 * Ask the provider for one block.
 *
 * Every failure here is a failure of the PROVIDER — unreachable, an error
 * status, an answer that is not the documented shape — and every one of them
 * throws rather than returning something the caller might retry. `chat`'s rule
 * and `complete`'s rule, verbatim, with the one exception this door's header
 * argues: a 429 or a 529 was already waited out inside `withBusyWait` before the
 * status reached this line, because those two mean "not yet" rather than "not
 * there".
 */
export async function complete(
  transport: Transport,
  endpoint: string,
  model: string,
  system: string,
  user: string,
  tuning: ChatTuning,
): Promise<string> {
  const base = normaliseAnthropicEndpoint(endpoint);
  const response = await withBusyWait(
    () => transport.post(
      `${base}/v1/messages`,
      messagesBody(model, system, user, tuning),
      ANTHROPIC_DIALECT_HEADERS,
    ),
    { retryOn: BUSY_STATUSES, where: `${base}/v1/messages` },
  );
  if (response.status !== 200) {
    throw new AnthropicError(
      `${base}, for model "${model}", ${explainHttpRefusal(response.status, '', response.body)}`,
    );
  }
  let parsed: { content?: unknown; usage?: unknown };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    throw new AnthropicError(
      `the provider at ${base} answered 200 with something that is not JSON: `
      + `${response.body.trim().slice(0, 200)}`,
    );
  }
  const spent = readUsage(parsed.usage);
  recordUsage(spent.input, spent.output);
  const text = answerText(parsed.content);
  if (text === null) {
    throw new AnthropicError(
      `the provider at ${base} answered without a text block in content — this endpoint is `
      + 'answering, but not as Anthropic\'s /v1/messages does',
    );
  }
  return text;
}
