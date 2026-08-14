/**
 * translate/ollama — the model, and the fact that it is somebody else's server.
 *
 * OLLAMA IS EXTERNAL. This file sends it HTTP and reads what comes back. It
 * does not start one, does not stop one, does not pull a model and does not
 * warm anything up. A server that is not answering is not a condition to
 * recover from — it is the end of the run, said in a sentence that names the
 * URL that was tried, because the person reading it is about to type
 * `ollama serve` into a terminal and the only thing they need from foundry is
 * WHICH endpoint was silent.
 *
 * That is a deliberate difference from `vlm-convert`, whose app-side plumbing
 * will start a vLLM server for you. The distinction is ownership: vLLM there is
 * a thing foundry stood up to do foundry's work, and Ollama here is a service
 * the person already runs, with their own models in it, probably serving
 * something else in another window. Killing or reconfiguring it would be
 * foundry reaching outside its own process for no better reason than
 * convenience.
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
 * `think: false` FOR qwen3, AND NOT FOR qwen2.5. The qwen3 family are thinking
 * models: left alone they emit a reasoning pass before the answer, which on a
 * translation — a task with no search in it — is pure latency, and at ten
 * seconds a block across two thousand blocks it is hours. Ollama takes `think`
 * as a top-level field on /api/chat. It is NOT tolerant of it on a model that
 * has no thinking support: qwen2.5 answers such a request with a 400 naming the
 * field, and the run would fail on block one. So the field is sent only where
 * the model name says it belongs, and the detection is the name prefix because
 * that is the only thing known before the first request.
 *
 * TEMPERATURE IS 0.2 AND IS NOT A SETTING. Zero made the 14b model repeat
 * whole clauses on long paragraphs; above ~0.4 the 32b model started inventing
 * connective sentences that were not in the source. 0.2 is where both stopped,
 * and a knob here would be a knob whose good values are already known
 * (ARCHITECTURE §5).
 */

/** The server did not do its job. Always names the endpoint. */
export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaError';
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

export function fetchTransport(timeoutMs: number = REQUEST_TIMEOUT_MS): Transport {
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
      throw new OllamaError(`${url} — ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    get: (url) => call(url, { method: 'GET' }),
    post: (url, body) => call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  };
}

/** No trailing slash, so every call site can concatenate a path. */
export function normaliseEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Whether this model takes `think`. See the header.
 *
 * Matched on the family prefix rather than a list of tags, because `qwen3:32b`,
 * `qwen3.1:8b-instruct-q4_K_M` and somebody's `qwen3:32b-custom` are all the
 * same question and a list would be wrong about the next one.
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

/** The exact JSON body sent for one block. Separate so a test can read it. */
export function chatBody(model: string, system: string, user: string): string {
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
    options: { temperature: 0.2, num_ctx: 8192, num_predict: answerBudget(user) },
  };
  if (takesThinkField(model)) body['think'] = false;
  return JSON.stringify(body);
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
): Promise<string> {
  const url = `${normaliseEndpoint(endpoint)}/api/chat`;
  const response = await transport.post(url, chatBody(model, system, user));
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
      + 'server and never starts one — run `ollama serve`, or pass --ollama with the URL of the '
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
