/**
 * translate/transport — HTTP as a value, and the numbers every act shares.
 *
 * ── THE SERVER IS SOMEBODY ELSE'S, AND THERE ARE THREE KINDS OF IT ──────────
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
 * schema-constrained verdict — `vllm.ts` holds only the OpenAI one, and
 * `anthropic.ts` (Owen, 2026-09-14, docs/SLOTS.md §6 Package F) holds only
 * Anthropic's `/v1/messages`. Which of the three is spoken is DECLARED on
 * `--server`, never sniffed from the URL.
 *
 * ── WHAT IS STILL HERE, AND WHY IT IS HERE AND NOT IN ANY DIALECT ───────────
 *
 * `Transport` is the seam the tests drive the whole verification loop through
 * without a GPU; `fetchTransport` is the one real implementation and the one
 * place an endpoint's headers are attached. `answerBudget` and `ChatTuning` are
 * measurements shared by every act, and `takesThinkField` is the rule for which
 * model families take a thinking switch — one rule, spelled two ways on the
 * wire (`think: false` there, `chat_template_kwargs` here). They are the
 * act-independent and dialect-independent half; the three other files are the
 * dialects.
 *
 * TWO MORE THINGS MOVED IN HERE WITH PACKAGE F, and both are here for the same
 * reason the thinking rule is: they are true of MORE THAN ONE dialect and a
 * second copy would be a second answer. `withBusyWait` is the rate-limit wait
 * both cloud doors share — a 429 is not a dead server, it is "not yet" — and
 * the usage tally (`recordUsage`, `usageLine`) is the run's one count of what
 * it spent, accumulated wherever a server reports it and printed once at the
 * end by the act. Neither is Ollama's: a local Ollama queues instead of
 * rate-limiting, and it reports its counts under different names nobody is
 * billing for.
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

/**
 * WHY A FAILURE THIS PROGRAM COMPOSED IS RE-READ OUT OF ITS OWN PROSE, AND WAS.
 *
 * `fetchTransport` turns an `AbortError` into the sentence *"<url> — no answer
 * in 300s"*, and until 2026-09-20 that sentence was the ONLY record of what
 * happened: the clean pass's `isTransportFailure` regexed the words back out
 * (`fetch|network|ECONNRESET|timeout|…`) to decide whether a failure was worth
 * one re-roll. The engine's own deadline matched none of those words, so the
 * one failure this program raises itself was the one failure it did not
 * recognise — a dropped socket re-rolled and a timeout ended the book.
 *
 * So the cause is a FIELD, set where the sentence is composed, and the prose is
 * for people. Three values, and every one of them means the same thing to a
 * caller deciding whether to ask again — the failure is a property of the
 * MOMENT, not of the input, so asking the same question again is worth doing
 * exactly once:
 *
 *  - `timeout` — this program's own deadline fired. Nothing came back at all.
 *  - `network` — `fetch` itself failed: a refused connection, a reset socket,
 *    a name that did not resolve.
 *  - `http` — the door turned a refusing STATUS into a throw. Nothing in this
 *    file composes one; it is here so a door that does never has to invent a
 *    fourth spelling of "the transport failed" for a reader to regex.
 */
export type TransportFailure = 'timeout' | 'network' | 'http';

/** The server did not do its job. Always names the endpoint. */
export class TransportError extends Error {
  /**
   * WHAT went wrong, as a value. See `TransportFailure` for why it is a field.
   *
   * It rides on `cause` — the name the language already gave this — rather than
   * on a second one of our own, so a reader who knows Error knows where to look
   * and a caller in another module can read it off a plain object without
   * importing this class.
   */
  declare readonly cause: TransportFailure;

  constructor(message: string, cause: TransportFailure) {
    super(message, { cause });
    this.name = 'TransportError';
  }
}

export interface HttpResponse {
  status: number;
  body: string;
  /**
   * The response's own headers, lower-cased, where the transport had any.
   *
   * ADDED FOR EXACTLY ONE READER and deliberately not for general use:
   * `withBusyWait` needs `retry-after`, because a provider that says how long
   * to wait has told this program something better than any backoff curve it
   * could invent. Optional because a fake transport does not have to make one
   * up — a missing map is read as "it did not say", which is the honest
   * reading, and the backoff takes over.
   *
   * Nothing here is ever logged except the number of seconds parsed out of
   * `retry-after`. A response header is not a credential, but the rule in this
   * program is that header VALUES do not reach the log, and one exception would
   * be the beginning of the rule not holding.
   */
  headers?: Readonly<Record<string, string>>;
}

/**
 * The HTTP boundary, as a value.
 *
 * Injected rather than called directly so the tests can drive every branch of
 * the verification loop — a dropped marker, an echo, an empty answer, a retry
 * that succeeds — without a live server and without a GPU. Nothing else in this
 * command is hard to test; this is the one seam that matters.
 *
 * ── THE OPTIONAL `headers` ARGUMENT IS THE DIALECT'S, NOT THE ENDPOINT'S ────
 *
 * The endpoint's headers are a property of the ENDPOINT and are attached once,
 * inside `fetchTransport`, so that no call site has to remember them. What this
 * argument carries is the other kind: a header that is a property of the
 * DIALECT — `anthropic-version: 2023-06-01` is required by Anthropic's API of
 * every caller, whatever endpoint it is reached at and whoever owns the
 * credential, so the engine sends it itself rather than asking the app to put a
 * protocol constant in a credential map.
 *
 * It is optional, so a transport written before this existed — every fake in
 * the tests — still satisfies the type and simply ignores it.
 */
export interface Transport {
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<HttpResponse>;
  post(
    url: string,
    body: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<HttpResponse>;
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
export const REQUEST_TIMEOUT_MS = 300_000;

/**
 * THE DEADLINE A POOL OF `n` REQUESTS NEEDS, AND WHY IT IS NOT 300 SECONDS.
 *
 * `REQUEST_TIMEOUT_MS` is armed at SEND (`fetchTransport`'s `setTimeout` runs
 * before `fetch` resolves anything), so it is a TOTAL deadline and not an
 * inactivity one — and it cannot be an inactivity one, because this transport
 * does not stream: it awaits `response.text()` in one piece, and a response
 * that has not started has no activity to time. So the only honest way to make
 * the deadline agree with the pool is to scale it.
 *
 * What that fixes, measured against a Crucible chat door on 2026-09-08: twelve
 * blocks in flight against a SERIAL backend are not twelve requests being
 * worked on — one is, and eleven are in the server's queue with their clocks
 * already running. The twelfth's 300 s therefore covers the eleven ahead of it,
 * so any per-block time above ~27 s times out the tail of every pool. The
 * failure looks like a slow model and is a queueing deadline.
 *
 * `concurrency × per-request budget` is the floor stated in the bug hunt
 * (BUG-HUNT-2026-09-20 §A F3a: *"pool depth and deadline must at least agree"*)
 * and it is what this returns. It is NOT capped: a cap would be the same
 * disagreement written smaller, and the deadline's whole job is to catch a
 * request that will never answer AT ALL — which stays true however long the
 * queue in front of it is.
 */
export function deadlineForConcurrency(concurrency: number): number {
  return REQUEST_TIMEOUT_MS * Math.max(1, Math.floor(concurrency));
}

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
 *
 * ── THE THREE LAYERS OF HEADERS, AND WHY THEY ARE IN THIS ORDER ─────────────
 *
 * A dialect's own constants go on FIRST, the endpoint's map second, and
 * `content-type` last. So a map wins over a dialect constant — a person who
 * wrote `anthropic-version` into their own map for THIS endpoint has said
 * something specific and gets it — and `content-type` wins over everything,
 * because the body really is JSON and a header that said otherwise would be
 * this program lying about what it sent. `parseEndpointHeaders` already refuses
 * that name, so the ordering is belt and the refusal is braces.
 */
export function fetchTransport(
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  headers: Readonly<Record<string, string>> | undefined = resolveEndpointHeaders(),
): Transport {
  const extra = headers ?? {};
  /*
   * THE LAYERS ARE MERGED BY HEADER NAME, CASE-INSENSITIVELY. HTTP header
   * names are, and a plain object is not: `{ 'Content-Type': a, 'content-type': b }`
   * is two keys, and Node's fetch (undici) sends BOTH, joined —
   * `content-type: application/json, application/json` — which a server's
   * JSON parser does not recognise, so the body is not read as JSON at all.
   * Bun happened to keep one. This surfaced the day the engine moved onto
   * Node (2026-09-24): every `clean-triage` request to a Crucible decide door
   * came back `400 invalid_request`. `Headers.set` replaces whatever spelling
   * came before, which is the "later layer wins" the order below promises.
   */
  const merged = (...layers: ReadonlyArray<Readonly<Record<string, string>> | undefined>): Headers => {
    const out = new Headers();
    for (const layer of layers) {
      for (const [name, value] of Object.entries(layer ?? {})) out.set(name, value);
    }
    return out;
  };
  const call = async (url: string, init: RequestInit): Promise<HttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const seen: Record<string, string> = {};
      response.headers.forEach((value, name) => { seen[name.toLowerCase()] = value; });
      return { status: response.status, body: await response.text(), headers: seen };
    } catch (error) {
      // THE CAUSE IS STATED HERE, where the sentence is composed and the abort
      // is still distinguishable from anything else `fetch` can throw. One line
      // later it is prose, and prose is what `isTransportFailure` used to have
      // to guess from. See `TransportFailure`.
      const timedOut = (error as Error).name === 'AbortError';
      const reason = timedOut
        ? `no answer in ${(timeoutMs / 1000).toFixed(0)}s`
        : (error as Error).message;
      throw new TransportError(`${url} — ${reason}`, timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    get: (url, dialect) => call(url, { method: 'GET', headers: merged(dialect, extra) }),
    post: (url, body, dialect) => call(url, {
      method: 'POST',
      headers: merged(dialect, extra, { 'content-type': 'application/json' }),
      body,
    }),
  };
}

/**
 * Where a line that nobody threaded a sink to goes.
 *
 * `commands.ts`'s own `log` writes to stderr — "progress and diagnostics go to
 * stderr; command RESULTS go to stdout" — so this is the same file descriptor
 * the act's lines are already on, reached without threading a sink through four
 * acts, two dialects and a retry loop to arrive at it. A default of SILENCE was
 * the alternative and it is the wrong one: a run that waited half a minute on a
 * rate limit and said nothing looks like a run that hung.
 */
function stderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * ── A RATE LIMIT IS A BUSY SIGNAL, NOT A DEAD SERVER (docs/SLOTS.md §3) ─────
 *
 * Everywhere else in this program the rule is that a server which did not
 * answer will not answer on the second attempt either, and a retry only delays
 * the message. A 429 is the one status where that reasoning is exactly wrong:
 * the provider is there, it understood the request, and it has said "not yet".
 * Ending a two-thousand-block book on the first one would throw away hours of
 * work over a condition whose whole meaning is that waiting fixes it. Anthropic
 * has a second status with the same meaning — 529, its own "overloaded" — and
 * it is passed in by that door rather than assumed here, because 529 is not a
 * standard status and reading it this way at an endpoint that meant something
 * else by it would be a guess.
 *
 * WHAT IS NOT RETRIED IS EVERYTHING ELSE, and that is deliberate: a 5xx other
 * than the one a door declares, a 4xx about the request itself, and a transport
 * failure all end the run as they always did. A retry on those is the thing
 * this program has refused to do since the beginning.
 *
 * `retry-after` WINS WHEN IT IS THERE. A provider that says how long to wait
 * knows something no backoff curve does; it is capped at a minute so a
 * misconfigured proxy answering `retry-after: 86400` cannot park a book for a
 * day. Where it is absent the wait doubles from two seconds and stops at
 * thirty, which is long enough to outlast a token bucket refilling and short
 * enough that six attempts is under two minutes rather than an afternoon.
 *
 * ── AND IT IS BOUNDED BY A CLOCK, WHICH IS NOT WHAT IT USED TO BE ──────────
 *
 * It was SIX ATTEMPTS. That is the right shape for a token bucket, whose refill
 * is a property of a key and has nothing to do with how long this program is
 * willing to wait, and it is the WRONG shape for a serial engine: a `503
 * chat_queue_full` from a Crucible means *"a slot frees when the block in front
 * of you finishes"*, and the block in front takes as long as it takes. On
 * 2026-09-20 four requests went out against a server admitting two; the two
 * refused ones burned their six attempts at the server's own 4 s `Retry-After`
 * — twenty-four seconds — while the admitted two were a third of the way
 * through ~30 s blocks, and the whole pass then failed on a condition that was
 * about to clear. Six attempts is not a budget; it is six attempts.
 *
 * So the bound is TIME, and it is the SAME time a request gets to be answered
 * in: `REQUEST_TIMEOUT_MS`. Waiting for a slot and waiting for an answer are the
 * same wait from the caller's side — a block that takes five minutes to come
 * back is a block that takes five minutes, and it should not matter whether the
 * minutes went on a queue or on decode. One clock, stated once, and a pool's
 * transport deadline (`deadlineForConcurrency`) is already `n` times it, so the
 * wait can never outlast the request that contains it.
 *
 * THE ATTEMPT CAP SURVIVES AS A GUARD AND NOT AS THE BOUND. A server answering
 * `retry-after: 0` for ever would otherwise spin this loop as fast as the
 * network allows; sixty attempts is far past any honest wait and cheap to carry.
 *
 * When either bound is reached the response is handed back EXACTLY as it
 * arrived and the caller's normal failure path runs, with a line naming how long
 * this program waited and what the server said while it did.
 *
 * ONE COPY, AND THE CALLERS DO NOT KNOW ABOUT IT. Both cloud doors send through
 * here; Ollama does not, because a local Ollama queues rather than refusing and
 * a wait there would be a wait for nothing.
 */
const BUSY_ATTEMPTS = 60;
const BUSY_FIRST_WAIT_MS = 2_000;
const BUSY_MAX_WAIT_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

/** What a status MEANS, for the line the wait is announced with. */
function busyReason(status: number): string {
  if (status === 429) return 'rate limited';
  if (status === 529) return 'overloaded';
  // A Crucible's two ways of saying the card is busy rather than broken; the
  // list a door waits on is the door's own (`BUSY_STATUSES`, vllm.ts).
  if (status === 503) return 'no lane free';
  if (status === 409) return 'the lane is leased';
  return `busy (${status})`;
}

/**
 * `retry-after` in milliseconds, or null where the server did not say.
 *
 * The header is defined as either a number of seconds or an HTTP date, and
 * providers send both; reading only the first would silently fall back to the
 * backoff for the other, which is a smaller mistake than guessing but still a
 * worse wait than the one that was offered. A value that is neither, or is in
 * the past, is read as "it did not say".
 */
export function retryAfterMs(headers: Readonly<Record<string, string>> | undefined): number | null {
  const said = headers?.['retry-after'];
  if (said === undefined || said.trim().length === 0) return null;
  const seconds = Number(said.trim());
  if (Number.isFinite(seconds)) {
    return seconds <= 0 ? 0 : Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  const at = Date.parse(said);
  if (Number.isNaN(at)) return null;
  const wait = at - Date.now();
  return wait <= 0 ? 0 : Math.min(wait, RETRY_AFTER_CAP_MS);
}

/**
 * THE SERVER'S OWN WORDS, TRIMMED, for the one line that ends a busy wait.
 *
 * Quoted rather than summarised because a `503` from a queue and a `503` from a
 * misconfiguration wear the same status and are told apart only by what the
 * body says. Bounded at 200 characters: this goes in a log line beside a number,
 * not into a report, and an HTML error page pasted whole would bury it.
 */
function saidBy(body: string): string {
  const said = body.trim().replace(/\s+/g, ' ');
  if (said === '') return '(it said nothing)';
  return said.length > 200 ? `${said.slice(0, 200)}…` : said;
}

/** Send, and wait out the statuses this door declares to mean "not yet". */
export async function withBusyWait(
  send: () => Promise<HttpResponse>,
  options: {
    /** The statuses that mean "wait" on THIS door. Never Ollama's. */
    retryOn: readonly number[];
    /** The URL the wait is about, for the line. Never carries a credential. */
    where: string;
    /**
     * HOW LONG THIS REQUEST MAY SPEND WAITING FOR A SLOT, in milliseconds.
     *
     * Defaults to `REQUEST_TIMEOUT_MS` — the same budget the request gets to be
     * ANSWERED in — because from the caller's side the two waits are one wait;
     * the header above carries the argument. A caller with a different clock
     * states it; nothing in this program does today, and a door that starts to
     * should say why in its own file rather than here.
     */
    budgetMs?: number;
    log?: (line: string) => void;
  },
): Promise<HttpResponse> {
  const log = options.log ?? stderrLine;
  const budgetMs = options.budgetMs ?? REQUEST_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let backoff = BUSY_FIRST_WAIT_MS;
  for (let attempt = 1; ; attempt += 1) {
    const response = await send();
    if (!options.retryOn.includes(response.status)) return response;
    const said = retryAfterMs(response.headers);
    const wait = said ?? backoff;
    const waited = Date.now() - startedAt;
    /*
     * THE NEXT WAIT IS MEASURED AGAINST THE BUDGET, not the last one. Sleeping
     * past the deadline and only then noticing would spend time this request was
     * never allowed to spend, and would report a wait longer than the budget it
     * was refused for.
     */
    const overBudget = Date.now() + wait > deadline;
    if (overBudget || attempt >= BUSY_ATTEMPTS) {
      log(
        `${options.where} answered ${response.status} (${busyReason(response.status)}) and was `
        + `still refusing after ${(waited / 1000).toFixed(1)}s of waiting for a slot`
        + (overBudget
          ? ` — the next wait of ${(wait / 1000).toFixed(1)}s would outrun this request's `
            + `${(budgetMs / 1000).toFixed(0)}s budget`
          : ` and ${attempt} attempts, which is this loop's guard against a server that says `
            + `${response.status} for ever`)
        + `, so it is refused with the server's own answer: ${saidBy(response.body)}`,
      );
      return response;
    }
    log(
      `${options.where} answered ${response.status} (${busyReason(response.status)}) — waiting `
      + `${(wait / 1000).toFixed(1)}s${said === null ? '' : ' (its own retry-after)'} and asking `
      + `again; ${(waited / 1000).toFixed(1)}s of this request's `
      + `${(budgetMs / 1000).toFixed(0)}s slot budget spent so far.`,
    );
    await new Promise<void>((resolve) => { setTimeout(resolve, wait); });
    backoff = Math.min(backoff * 2, BUSY_MAX_WAIT_MS);
  }
}

/**
 * ── WHAT THE RUN SPENT, COUNTED WHERE IT IS REPORTED ────────────────────────
 *
 * Owen, 2026-09-14: a cloud provider's cost is the thing the person chose it
 * with, and a run that will not say what it used is a run they cannot budget.
 * Both cloud dialects hand back token counts on every answer — OpenAI as
 * `usage.prompt_tokens`/`completion_tokens`, Anthropic as
 * `usage.input_tokens`/`output_tokens` — and a local vLLM reports the same
 * OpenAI-shaped numbers, so the tally is kept whenever a server offers one
 * rather than only when the door is a cloud one. It is a count of REQUESTS AND
 * TOKENS and nothing else: **this program does not price it**. Prices change
 * weekly, they differ per key and per tier, and a number invented here would be
 * wrong in a way that looks authoritative. The app multiplies.
 *
 * A PROCESS IS A RUN, which is what makes a module-level tally honest here: the
 * CLI is spawned once per job, and `openModelServer` — called exactly once, and
 * before any request — resets it, so the count can never belong to two runs. A
 * test harness that drives several runs in one process gets the same reset for
 * the same reason.
 */
export interface UsageTally {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

let tally: UsageTally = { requests: 0, inputTokens: 0, outputTokens: 0 };

/** One answer's counts. A door that read none of them calls this with zeroes. */
export function recordUsage(inputTokens: number, outputTokens: number): void {
  tally = {
    requests: tally.requests + 1,
    inputTokens: tally.inputTokens + inputTokens,
    outputTokens: tally.outputTokens + outputTokens,
  };
}

/** The run starts here. See the header: one process, one run, one count. */
export function forgetUsage(): void {
  tally = { requests: 0, inputTokens: 0, outputTokens: 0 };
}

export function usageSoFar(): UsageTally {
  return tally;
}

/**
 * The one line an act prints at the end of a run, or null where there is
 * nothing to say.
 *
 * NULL RATHER THAN A LINE OF ZEROES: a door that reported no usage at all —
 * Ollama, or a server that omits the field — has told this program nothing, and
 * printing "0 tokens" would be a claim about a run that really did generate
 * text. Silence is the honest answer to a server that did not count.
 */
export function usageLine(act: string): string | null {
  if (tally.requests === 0) return null;
  const n = (value: number): string => value.toLocaleString('en-US');
  return `${act}: ${n(tally.requests)} requests, ${n(tally.inputTokens)} tokens in, `
    + `${n(tally.outputTokens)} out`;
}

/**
 * `usage` in an answer, in whichever of the two spellings this door uses.
 *
 * ONE READER FOR BOTH because the fact is one fact — how many tokens went in
 * and how many came out — and the two providers merely named the fields
 * differently. A door passes the object it parsed; anything missing reads as
 * zero, because a provider that omitted a count did not charge this run nothing,
 * it simply did not say, and inventing a number would be worse than a low one.
 */
export function readUsage(usage: unknown): { input: number; output: number } {
  const row = (usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    input: num(row['prompt_tokens']) + num(row['input_tokens']),
    output: num(row['completion_tokens']) + num(row['output_tokens']),
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
 * not want it simply ignores. The two LOCAL doors ask the same question of the
 * same string and write two different bodies, which is exactly the shape a
 * shared rule with a dialect file either side of it is for.
 *
 * THE ANTHROPIC DOOR NEVER ASKS IT, and that is not an omission. Claude models
 * do not reason unless a request asks them to, so the switch there is the
 * ABSENCE of a field rather than a field set to false — and `anthropic.ts`
 * therefore never calls this. A `gpt-*` or `o*` name reaching the OpenAI door
 * fails this prefix too, which is what keeps `chat_template_kwargs` — a field a
 * provider would reject outright — off a cloud request.
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
 * ── AND `numCtx` IS A FIELD EXACTLY ONE OF THE THREE DOORS HAS ────────────
 *
 * The context window is a per-request option on Ollama, a property of the SERVER
 * on an OpenAI-compatible one, and a property of the PROVIDER on the cloud one.
 * So this carries it and `ollama.ts` is the only file that reads it:
 * `completionsBody` drops it, because a vLLM's window was fixed when the model
 * was made resident and the KV cache was allocated against it, and there is no
 * request that can move it — there a request is sized INTO the window instead
 * (`capFor`, vllm.ts). `messagesBody` drops it too, and does not even size
 * against a window, because a provider publishes no number to size against.
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
