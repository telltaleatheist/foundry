/**
 * translate/vllm — the same questions, asked of an OpenAI-compatible server.
 *
 * ── THE FILENAME SAYS vLLM AND THE DOOR IS WIDER THAN THAT ──────────────────
 *
 * This is the `--server openai` dialect: `/v1/models`, `/v1/chat/completions`,
 * `response_format`. What answers it may be a vLLM, a shared inference service,
 * a local llama-server holding a GGUF, or a cloud provider reached through the
 * header map — the wire is the same and this file cannot tell them apart, which
 * is the point of an interoperable protocol. The KIND is therefore spelled
 * `openai` rather than `vllm` (model-server.ts argues it), and the FILE keeps
 * its name because every measurement in docs/VLLM.md was taken through it and a
 * rename would cost each of them its address.
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
 * understands. It is one of THREE dialects: `ollama.ts` is the local door beside
 * it and `anthropic.ts` is the cloud one (docs/SLOTS.md §2), the choice is
 * declared on `--server` and never sniffed, and `model-server.ts` is the one file
 * that makes it.
 *
 * ── THE THINGS THIS DOOR DOES DIFFERENTLY, EACH PAID FOR ────────────────────
 *
 *  - THE CONTEXT WINDOW IS THE SERVER'S, NOT THE REQUEST'S. It is fixed when
 *    the model is made resident and the KV cache is allocated against it, and
 *    there is no per-request field for it. `/v1/models` is read for
 *    `max_model_len` so a request can be sized INTO what the server can hold —
 *    see `capFor` — and a request that cannot fit is refused by name before it
 *    is sent (clean/runner.ts), never sent to be truncated silently.
 *  - THE THINKING SWITCH IS A CHAT-TEMPLATE ARGUMENT, where Ollama takes a
 *    top-level `think` field. The qwen3 family's switch on this door is
 *    `chat_template_kwargs: {enable_thinking: false}`, which the server hands
 *    to the Jinja template. A template that does not take the argument ignores
 *    it, so this costs nothing where it does not apply — and it is still sent
 *    only for the family that has it, on `takesThinkField`'s own prefix rule.
 *  - AND THE PER-MODEL DEFAULTS LANDED, so this door reads them. Crucible
 *    publishes a `defaults` block per row on `/openai/v1/models` — temperature,
 *    top_p, top_k, max_tokens, repetition_penalty, thinking — and it added it
 *    BY NAME for this program (PHASE2-LLM.md section 9). The sentence that used
 *    to stand here said the switch was sent "until they land"; they have.
 *
 *    THE PRECEDENCE IS THE SERVER'S AND IT IS ONE LINE: *a field the request
 *    STATES wins; a field the request omits takes the manifest's; a field
 *    neither states is the engine's.* So the question this file has to answer
 *    is which fields it has a REASON to state, and the answer is written beside
 *    each one rather than inferred from a pinned number:
 *      · `temperature` — measured per act (0.2 for a translation, 0 for a
 *        closed question). A reason, stated, and it wins.
 *      · `max_tokens` — sized from THIS request and the server's window by
 *        `capFor`. A reason, stated, and it wins.
 *      · `thinking` — `takesThinkField`'s family rule. A reason, stated, and
 *        the switch still goes for the family that takes the argument.
 *      · `top_p`, `top_k`, `repetition_penalty` — this program has no opinion
 *        about any of them and never has. So the server's number goes on the
 *        wire where the server published one, and nothing goes where it did
 *        not. `null` in the block means "the engine's own" and is NOT sent:
 *        a stated field with no value is a worse request than no field.
 *    What this buys is that the request says what it was asked with, rather
 *    than three of six knobs being visible and the rest happening off-wire.
 *  - AND BECAUSE THAT SWITCH IS ADVISORY, THE ANSWER IS CHECKED. A template
 *    argument is a request to a Jinja file, and a model or a build that thinks
 *    anyway would put a `<think>…</think>` block in front of every answer in the
 *    book — a translation with reasoning glued to its head, or an edit list the
 *    JSON reader cannot find. `withoutThinking` takes exactly that block off the
 *    front and nothing else.
 *  - NOTHING IS LOADED OR UNLOADED, which is the sharpest difference from the
 *    other door. The operator puts a model on the card before a pass is spawned
 *    and a load evicts what was there, so a pass that asked for one would be one
 *    job taking a narrator's voice off the card. A server that holds the wrong
 *    model is a refusal by name, and a pass ending is not a reason to take a
 *    model off — where on Ollama a pass ending is exactly that reason, always
 *    (`releaseModel`, model-server.ts).
 *
 * ── AND SINCE 2026-09-14 ONE OF THE FOUR IS OPENAI ITSELF ───────────────────
 *
 * Owen's cloud ruling (docs/SLOTS.md §6 Package F) needed NO new code on this
 * door, which is the whole point of an interoperable protocol: `--server openai
 * --endpoint https://api.openai.com/v1` with `{"Authorization": "Bearer sk-…"}`
 * in the header map is an OpenAI-compatible server reached over TLS, and every
 * sentence above is still true of it. Four things were CHECKED rather than
 * changed, and each is argued where it lives:
 *
 *   a. an absent `--model` hits `requireServedModel`'s "serving N models"
 *      refusal, because a provider's listing is a catalog — the refusal's
 *      wording was widened there so it does not tell a cloud user to make a
 *      model resident, and the list it quotes is bounded so eighty ids do not
 *      bury the sentence;
 *   b. `chat_template_kwargs` never reaches a provider that would reject it —
 *      see `completionsBody`, where the rule is `takesThinkField`'s qwen3
 *      prefix and no `gpt-*` or `o*` name can match it;
 *   c. `max_tokens` stays `max_tokens` — see `completionsBody` for the whole
 *      argument about the models that want `max_completion_tokens` instead;
 *   d. `response_format: json_schema` with `strict: true` is exactly what
 *      OpenAI wants for `analyze`, so `constrainedChatBody` is unchanged;
 *   e. `max_model_len` is absent from a provider's listing, so `capFor` gets
 *      null and sends the wanted budget — the honest reading of "it did not
 *      say", and the provider enforces its own window with a 400 that names it.
 *
 * What WAS added is two things that are true of a provider and harmless on a
 * vLLM: a 429 is waited out rather than ending the run (`withBusyWait`,
 * transport.ts — a rate limit is a busy signal, docs/SLOTS.md §3), and the
 * `usage` object every OpenAI-compatible server returns is counted so the run
 * can say what it spent (`recordUsage`). Neither knows whether the endpoint is
 * local or billed, and neither needs to.
 */
import { explainHttpRefusal } from '../backend/http-refusal.js';
import {
  answerBudget, readUsage, recordUsage, takesThinkField, withBusyWait, type ChatTuning,
  type HttpResponse, type Transport,
} from './transport.js';

/**
 * The statuses that mean "not yet" on this door.
 *
 * 429 is the standard one and has always been here: a rate limit is a busy
 * signal, and the run waits it out (`withBusyWait`, transport.ts).
 *
 * ── 503 AND 409 JOINED IT ON 2026-09-20, AND THEY ARE NOT A 5xx RELAXATION ──
 *
 * The old rule — *"a 5xx from an OpenAI-compatible server is a server that is
 * broken, and that is the end of the run"* — was written when the only thing on
 * this door was a vLLM, which is its model and is either up or not. It is now
 * also a Crucible, an ORCHESTRATOR in front of a card it lends out one lane at a
 * time, and those two statuses are the two sentences it says when the card is
 * busy rather than broken:
 *
 *  - **503** — no lane free right now. A vLLM that is genuinely unwell says 500
 *    or stops answering; 503 is *service unavailable*, which is the status for
 *    "ask again", and that is what a Crucible means by it.
 *  - **409** — the lane is LEASED, to another client or to another act of this
 *    same book. `crucible-dispatch.ts` already treats a 409 as a holder line and
 *    parks the row; a book that reached the chat door instead had the identical
 *    condition end it.
 *
 * What the old rule cost is not an error somebody reads once: a Crucible that
 * was mid-render when a clean pass started failed the whole book on request
 * one, hours of answers thrown away (F2's twin), where waiting four seconds
 * would have finished it. The wait is BOUNDED — `BUSY_ATTEMPTS` refusals and
 * the provider's own answer is returned — so a server that really is down still
 * ends the run, just with its own status in the sentence.
 *
 * Anthropic's 529 is still not read here: it is not a standard status, an
 * endpoint that meant something else by it would be waited on for nothing, and
 * `anthropic.ts` declares its own list.
 */
const BUSY_STATUSES = [429, 503, 409] as const;

/** The server did not do its job. Always names the endpoint. */
export class VllmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VllmError';
  }
}

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

/**
 * The sampling knobs a listing row published a default for.
 *
 * Crucible's `[defaults]` table, verbatim in shape: all six keys are present
 * and `null` means THE ENGINE'S OWN, never a number Crucible picked. The
 * distinction is load-bearing — an absent key and a key set to the engine's
 * value are different manifests, and only the second is a decision somebody
 * made — so nothing here turns a null into a value.
 */
export interface ServedDefaults {
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  maxTokens: number | null;
  repetitionPenalty: number | null;
  /** Not a wire field: it becomes `chat_template_kwargs.enable_thinking`. */
  thinking: boolean | null;
}

/** What a server said it is serving, as much of it as this program reads. */
export interface ServedModel {
  /** The id to send back on every request — an HF path, usually. */
  id: string;
  /** `--max-model-len`, when the server reports it. Null when it does not. */
  maxModelLen: number | null;
  /**
   * What this server will answer a silent request with, or null where the row
   * carried no `defaults` block at all.
   *
   * NULL IS "THIS SERVER STATED NOTHING", which is a plain vLLM, a llama-server
   * or a cloud provider — not "every knob is the engine's", which is what a
   * block of six nulls says. Collapsing the two would make a server that
   * predates the field and a manifest that deliberately defers read the same.
   */
  defaults: ServedDefaults | null;
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
  let response: HttpResponse;
  try {
    response = await withBusyWait(
      () => transport.get(`${base}/models`),
      { retryOn: BUSY_STATUSES, where: `${base}/models` },
    );
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
  let rows: ListingRow[];
  try {
    const parsed = JSON.parse(response.body) as { data?: ListingRow[] };
    rows = parsed.data ?? [];
  } catch {
    throw new VllmError(`${base}/models answered 200 with something that is not JSON`);
  }
  return rows
    .filter((row): row is ListingRow & { id: string } =>
      typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      maxModelLen: typeof row.max_model_len === 'number' && row.max_model_len > 0
        ? row.max_model_len
        : null,
      defaults: readDefaults(row.defaults),
    }));
}

interface ListingRow {
  id?: unknown;
  max_model_len?: unknown;
  defaults?: unknown;
}

/**
 * The `defaults` block of one listing row, or null where the row has none.
 *
 * NOTHING IS COERCED AND NOTHING IS GUESSED. A key whose value is not the type
 * the block promises reads as null — "this server said nothing usable about
 * that knob" — because the alternative is putting a string where a server
 * expects a float and collecting a 400 three layers down. A block that is not
 * an object at all is not a block.
 */
function readDefaults(block: unknown): ServedDefaults | null {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
  const row = block as Record<string, unknown>;
  const numberOf = (key: string): number | null =>
    typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : null;
  return {
    temperature: numberOf('temperature'),
    topP: numberOf('top_p'),
    topK: numberOf('top_k'),
    maxTokens: numberOf('max_tokens'),
    repetitionPenalty: numberOf('repetition_penalty'),
    thinking: typeof row['thinking'] === 'boolean' ? row['thinking'] : null,
  };
}

/**
 * The knobs this program states no opinion about, put on the wire with the
 * server's own number where it published one.
 *
 * `temperature`, `max_tokens` and the thinking switch are deliberately NOT
 * here: each of those is a decision Foundry made for a stated reason, and this
 * file's header carries the three reasons. What is left is the set nothing in
 * this program has ever had a view on, and for those the server's manifest is
 * the only opinion in the room.
 */
function unstatedKnobs(
  body: Record<string, unknown>,
  defaults: ServedDefaults | null,
): void {
  if (defaults === null) return;
  if (defaults.topP !== null) body['top_p'] = defaults.topP;
  if (defaults.topK !== null) body['top_k'] = defaults.topK;
  if (defaults.repetitionPenalty !== null) {
    body['repetition_penalty'] = defaults.repetitionPenalty;
  }
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
 *
 * ── AND THE SENTENCES HAD TO WORK FOR A CATALOG, NOT JUST A CARD ────────────
 *
 * Package F put a cloud provider behind this door, and both refusals read badly
 * against one. `GET /v1/models` at OpenAI lists dozens of ids — every quoted
 * one of them, in a message about the one thing that is wrong, is a wall
 * somebody has to read past to find the sentence. And "make the one this run
 * needs resident first" is advice about a GPU nobody in that story owns. So the
 * quoted list is bounded and the advice names both cases. Nothing about the
 * RULE changed: a name that was given is still proved exactly, an absent name
 * over more than one model is still a refusal, and this file still cannot tell
 * which kind of server answered — which is the point.
 */
const LISTED_IDS_SHOWN = 12;

function quoteIds(served: readonly ServedModel[]): string {
  const ids = served.map((one) => one.id);
  if (ids.length <= LISTED_IDS_SHOWN) return ids.join(', ') || '(nothing)';
  return `${ids.slice(0, LISTED_IDS_SHOWN).join(', ')}, and ${ids.length - LISTED_IDS_SHOWN} more`;
}

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
        + `to know which one this run means. It has: ${quoteIds(served)}. Name one with --model.`,
      );
    }
    return served[0]!;
  }
  const found = served.find((one) => one.id === wanted);
  if (found === undefined) {
    throw new VllmError(
      `the server at ${base} is not serving "${wanted}". It is serving: ${quoteIds(served)}. `
      + 'Name one of those with --model, or — where the endpoint holds exactly one model — leave '
      + '--model off and the served one is used. A pass never loads a model: on a server you own, '
      + 'make the one this run needs resident first.',
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
  defaults: ServedDefaults | null = null,
): string {
  /*
   * THERE IS NO WINDOW FIELD AND NONE IS INVENTED. The window is fixed when the
   * model is made resident; a per-request field for it does not exist, and the
   * nearest thing — sending a smaller `max_tokens` — is a different fact about
   * a different thing. `capFor` is where the server's window is honoured.
   *
   * A CLOUD PROVIDER REPORTS NO `max_model_len`, so `capFor` is handed null and
   * answers the wanted budget unchanged. That is the honest reading of "it did
   * not say" rather than a special case: the provider enforces its own window
   * and says so in a 400 that names the number, which is a better sentence than
   * any arithmetic this file could do over a figure it does not have.
   */
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: tuning.temperature,
    /*
     * ── `max_tokens`, AND THE MODELS THAT WANT `max_completion_tokens` ───────
     *
     * Newer OpenAI models refuse `max_tokens` and want `max_completion_tokens`
     * instead. This door sends `max_tokens` to all of them and that is a
     * DECISION, not an oversight, because every way of deciding per request is
     * a sniff and this program's rule (docs/SLOTS.md §2) is that a dialect is
     * DECLARED. Sniffing the URL for `api.openai.com` breaks the moment a proxy
     * or an Azure mount is in front of it; sniffing the MODEL NAME for `gpt-*`
     * or `o*` is `takesThinkField`'s own warning in a worse form — a list of
     * prefixes that is right about today's names and wrong about the next one,
     * on a field whose absence is a 400 rather than something ignored.
     *
     * The honest shape for a provider whose wire genuinely differs is a KIND of
     * its own, which is exactly what `--server anthropic` is. If somebody needs
     * OpenAI's reasoning models through this engine, the answer is a fourth
     * declared kind with that field in its body, not a guess in this one — and
     * it is not built until somebody does, because an unused dialect is a
     * dialect nobody has checked.
     *
     * Until then the failure is loud and self-explaining: the provider answers
     * 400 with "Unsupported parameter: 'max_tokens' … use 'max_completion_
     * tokens' instead", `explainHttpRefusal` quotes it back verbatim, and the
     * person reading it picks a model this door can speak to.
     */
    max_tokens: capFor(system, user, tuning.numPredict ?? answerBudget(user), maxModelLen),
  };
  /*
   * AND NO PROVIDER SEES THIS FIELD. `takesThinkField` matches the qwen3 family
   * prefix and nothing else, so `gpt-4o`, `o3`, `claude-*` and every other
   * hosted name fail it — which matters here rather than on a vLLM, because a
   * vLLM hands an unknown `chat_template_kwargs` to a Jinja template that
   * ignores it, where a provider rejects an unknown top-level field with a 400.
   * The rule stays one rule (transport.ts); what this comment records is that
   * the rule was CHECKED against the names Package F put behind this door.
   */
  if (takesThinkField(familyOf(model))) {
    body['chat_template_kwargs'] = { enable_thinking: false };
  }
  // And the three this program has no opinion about. Last, so a reader sees
  // the stated fields and the deferred ones as two separate decisions.
  unstatedKnobs(body, defaults);
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
 *
 * `strict: true` IS ALSO EXACTLY WHAT OPENAI ITSELF WANTS — structured outputs
 * are only guaranteed there when the flag is set — so the body Package F sends
 * to a provider is the body that was already being sent to a vLLM, unchanged.
 * The thinking switch below is still governed by `takesThinkField`, which no
 * hosted model name matches; `completionsBody` carries that argument in full.
 */
export function constrainedChatBody(
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
  maxModelLen: number | null = null,
  defaults: ServedDefaults | null = null,
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
  // The same three, for the same reason: constraining the DECODE says nothing
  // about how the tokens inside the grammar are sampled.
  unstatedKnobs(body, defaults);
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
  let response: HttpResponse;
  try {
    response = await withBusyWait(
      () => transport.post(`${base}/chat/completions`, body),
      { retryOn: BUSY_STATUSES, where: `${base}/chat/completions` },
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
  let parsed: {
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
    usage?: unknown;
  };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    return { text: null, degraded: `vllm at ${base} answered 200 with something that is not JSON` };
  }
  // What this call cost, counted where it is reported. See `recordUsage`.
  const spent = readUsage(parsed.usage);
  recordUsage(spent.input, spent.output);
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
 *
 * THE ONE EXCEPTION IS A 429, and it has already been waited out by the time a
 * status reaches this line — `withBusyWait` holds the argument (transport.ts).
 * A rate limit is the only status that means "there, and not yet".
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
  const response = await withBusyWait(
    () => transport.post(
      `${base}/chat/completions`,
      completionsBody(served.id, system, user, tuning, served.maxModelLen, served.defaults),
    ),
    { retryOn: BUSY_STATUSES, where: `${base}/chat/completions` },
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
  // What this call cost, counted where it is reported. See `recordUsage`.
  const spent = readUsage((parsed as { usage?: unknown })?.usage);
  recordUsage(spent.input, spent.output);
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
