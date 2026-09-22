/**
 * vlm/endpoint — reading the pages on somebody else's GPU.
 *
 * The MLX path holds the model in one Python process on this machine and reads
 * the pages one at a time, because that is what Apple silicon can do. A vLLM
 * server on a 3090 reads twelve at a time and is an order of magnitude faster
 * per book, and it speaks the OpenAI chat-completions shape. `--vlm-endpoint`
 * points at one; everything else about the run is identical, and deliberately
 * so — the SAME verbatim prompt, the same 200 dpi render, the same dialect.
 *
 * A CHAT ENDPOINT IS ALLOWED HERE, AND IS NOT ALLOWED ANYWHERE ELSE IN FOUNDRY.
 * ARCHITECTURE §4 forbids one for the stage models, and the reason is precise:
 * those weights were trained on a prompt THIS PROJECT built, byte for byte,
 * with an empty `<think>\n\n</think>` block a stock template omits — so a server
 * that re-templates hands the model a shape it never saw and quietly answers
 * worse. A document VLM is the other case. Its published interface IS the chat
 * template: the model card's example is a chat turn with an image part and a
 * text part, the MLX path reaches the same template through
 * `apply_chat_template`, and building the string by hand HERE would be the
 * violation. What is sacred is that the model gets the shape it was trained on.
 * On this route that shape is a chat turn.
 *
 * TEMPERATURE COMES FROM THE SERVER'S CONTRACT and is zero on every reader
 * there is. A layout answer is a measurement of a page; the same page read
 * twice has one right answer, and sampling would make a book that cannot be
 * reproduced from the PDF it came from. What changed is WHERE the number is
 * written down: it sits beside the prompt and the pixel budget in
 * `pages_engine.request`, because all three are facts about the weights, and a
 * pinned zero here would be this file quietly overriding the one side that
 * knows (`contract.ts`).
 *
 * CONCURRENCY IS TWELVE by default, which is the measured knee on the machine
 * this was built against — the server keeps its batch full and per-page latency
 * has not started climbing. It is an option because the number is a property of
 * somebody else's GPU, not of this program.
 *
 * WEATHER IS RETRIED, MISCONFIGURATION IS NAMED, AND A RUN IS NEVER FAILED BY
 * THE SERVER'S WEATHER (Owen's rule, BookForge, 2026-09-20; landed here
 * 2026-09-21 after Everyday Denazification lost eleven in-flight pages to one
 * 502).
 *
 * ── What happened ─────────────────────────────────────────────────────────
 *
 * Page 32 of a 329-page book got `502 Bad Gateway {"error":{"code":
 * "engine_unreachable", ... "ReadError: ."}}` from Crucible's proxy: a stale
 * keep-alive socket between the proxy and vLLM, with vLLM itself healthy and
 * answering. This file threw, `read.ts` let the throw out, the CLI printed it
 * and exited 1, the hosted dispatcher released the Crucible lease, Crucible's
 * settlement unloaded the engine, and the eleven pages that were in flight
 * beside page 32 -- answers already computed on the card -- were thrown away
 * with the process. One socket hiccup cost a lease, an engine load and twelve
 * pages of GPU time. The old header said "NOTHING IS RETRIED ... the re-run
 * pays for the pages that did not [land]", and that sentence was true and was
 * the defect: it priced a socket reset as a page that did not land.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * A transient fault from the model server -- 502, 503, 504, 429, a connect
 * timeout, a reset, a ReadError, anything the socket rather than the server's
 * CONTRACT said -- is WEATHER. It is retried within a STATED budget
 * (`WEATHER_WAITS_MS`: three quick tries at 2/5/10 s, then longer waits with
 * the process alive so whatever lease it holds stays held), each wait said out
 * loud through `onWeather`. If the weather outlasts the budget the run is
 * PARKED: the page and the endpoint are named, the pages in flight are allowed
 * to LAND (see `readPagesFromEndpoint`), and the process exits with
 * `PARKED_EXIT_CODE` rather than 1 -- a dispatcher can tell a park from a
 * failure, and `--readings` makes the resume free because every page that
 * landed is on disk.
 *
 * FAIL-BY-NAME STAYS for what a person has to repair: a bad URL (404), a
 * credential (401/403), a model the server is not holding, a 400 from a
 * request the server will never accept. Retrying those would be a band-aid
 * over a sentence somebody needs to read.
 *
 * THE PAGE DEADLINE IS A PARK, NOT A RETRY. A request that hit
 * `requestDeadlineMs` waited a dozen minutes for a server that never spoke;
 * sending the same page again for another dozen is not a budget, it is an
 * evening. It is weather all the same -- nothing about it is a
 * misconfiguration -- so it parks by name rather than failing.
 */
import * as fs from 'node:fs';

import { explainHttpRefusal } from '../backend/http-refusal.js';

export class VlmEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmEndpointError';
  }
}

/**
 * THE EXIT CODE OF A PARKED RUN -- sysexits' EX_TEMPFAIL, "temporary failure;
 * the user is invited to retry", which is exactly the sentence. A dispatcher
 * reading the CLI's exit sees 0 (done), 75 (parked: resume later, nothing is
 * lost) or 1 (failed: read the message). Before this every non-zero exit was
 * a failure, and the hosted dispatcher's only honest answer to one was to let
 * the lease go.
 */
export const PARKED_EXIT_CODE = 75;

/**
 * THE RUN IS PARKED: the server's weather outlasted the budget on one page.
 *
 * It is a `VlmEndpointError` so every catch that names endpoint trouble still
 * catches it, and it carries the exit code so the CLI can tell a park from a
 * failure without importing this file's vocabulary. `page` and `endpoint` are
 * the two nouns Owen's rule says a park owes.
 */
export class VlmParkedError extends VlmEndpointError {
  readonly exitCode = PARKED_EXIT_CODE;
  constructor(
    readonly endpoint: string,
    readonly page: number,
    detail: string,
  ) {
    super(
      `parked: ${endpoint} did not answer page ${page} -- ${detail} `
      + 'Every page that landed is banked; run the same command again to read the rest.',
    );
    this.name = 'VlmParkedError';
  }
}

/**
 * THE WEATHER BUDGET, as the waits between tries, in milliseconds.
 *
 * Three quick tries (2, 5, 10 s) catch the fault that page 32 hit -- a stale
 * socket the proxy drops and reopens on the next request -- and the longer
 * waits (30 s, 1, 2, 4 min) hold the process, and with it any lease it is
 * running under, through an engine restart or a card that is briefly busy.
 * Eight tries over about eight minutes; the ninth failure parks. The numbers
 * are stated here because a budget nobody can read is a hang.
 */
export const WEATHER_WAITS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 240_000];

/**
 * HTTP statuses that are weather: the server is there and is not saying no,
 * it is saying not now. 429 is the card being busy; the 5xx three are a proxy
 * or an engine between restarts.
 */
const WEATHER_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** What one failed try was, for the retry loop to decide on and the sentences to say. */
type Fault =
  | { kind: 'weather'; said: string }
  | { kind: 'deadline'; said: string }
  | { kind: 'refused'; said: string };

/** One page, read over HTTP. Same shape the MLX path reports. */
export interface EndpointPageResult {
  number: number;
  text: string;
  tokens: number;
  finishReason: string | null;
  seconds: number;
  /**
   * THE SERVER'S WHOLE ANSWER, decoded and otherwise untouched.
   *
   * The four fields above are what this program reads out of it, and they used
   * to be all that survived this function. Everything else the server said went
   * on the floor here: the prompt/completion token split, the model id it
   * actually served under, the response id that identifies the request in its
   * own logs, and whatever a particular build adds. A page costs GPU-minutes, so
   * getting any of that back means reading the page again — which is the one
   * thing the bank exists to prevent. It is carried up to `convert.ts` and
   * banked verbatim beside the parsed fields (`readings.ts`).
   */
  response: unknown;
}

export interface EndpointRequest {
  number: number;
  /** The PNG the render pass left on disk. */
  imagePath: string;
}

export interface VlmEndpointOptions {
  /** Base URL, OpenAI-compatible — `http://host:8000/v1`. */
  endpoint: string;
  /** The name the server was started with. */
  model: string;
  /** The model card's prompt, verbatim. Never built here. */
  prompt: string;
  /**
   * What to sample at, from the server's published contract.
   *
   * It was pinned at zero in this file and is not any more, for the reason the
   * prompt was never built here: the number belongs to whoever owns the
   * weights. Zero is still what a page reader publishes — a layout is not a
   * thing to be creative about — and the difference is that the day it is not,
   * this program sends what the server asked for instead of quietly
   * disagreeing with it.
   */
  temperature: number;
  /**
   * The token cap for a page — a NUMBER, or a question asked at the send.
   *
   * ── Why a function may be passed ────────────────────────────────────────────
   *
   * A cap is a property of the RUN and not of the model. dots.ocr's 8,192 is set
   * where no real page can reach it, which is correct and is also why a runaway
   * costs 8.3x an ordinary page before anything refuses it: measured, 22 pages
   * across a library of 18,202 spent 64 minutes of GPU and produced nothing.
   *
   * The caller can narrow that per page from what the book has actually shown it
   * -- see capFor in band.ts and the walk in read.ts -- but it can only do so if
   * the number is read WHEN THE PAGE IS SENT. The pages array is built before
   * dispatch, so a number on it would be fixed before the first answer landed.
   *
   * THIS FILE STAYS IGNORANT OF WHY. It does not know what a band is, or a book;
   * it asks the caller for a number and puts it on the request. A bridge that
   * understood the rule would be a second place the rule lived.
   */
  maxTokens: number | ((page: EndpointRequest) => number);
  concurrency: number;
  pages: readonly EndpointRequest[];
  onPage: (page: EndpointPageResult) => void;
  /**
   * What this endpoint wants on every request — an opaque map, never
   * interpreted here. A server behind a private router wants a bearer token
   * and its own API-version constant; this file does not know which is which,
   * and `backend/endpoint-headers.ts` explains why it must not.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * A sentence about weather -- a try that failed and the wait before the
   * next -- for the run's log. Optional because the reader has no log of its
   * own; a caller that passes nothing waits in silence, which is the one
   * thing Owen's rule forbids, so `read.ts` always passes one.
   */
  onWeather?: (sentence: string) => void;
  /**
   * The waits between tries, overriding `WEATHER_WAITS_MS`. For tests, which
   * cannot spend eight minutes proving a park, and for a caller with a stated
   * budget of its own. An empty list means one try and then a park.
   */
  weatherWaitsMs?: readonly number[];
}

/** The cap for this page, whether the caller fixed one or answers per page. */
function capOf(cap: VlmEndpointOptions['maxTokens'], page: EndpointRequest): number {
  return typeof cap === 'function' ? cap(page) : cap;
}

/**
 * Pages in flight at once, and THE ADAPTIVE CAP'S SAFETY DEPENDS ON THIS NUMBER.
 *
 * ── The coupling, written here because this is where the change would be made ─
 *
 * `read.ts` narrows each page's token cap from the longest page the book has
 * accepted SO FAR, and "so far" means "so far as answers have landed". With N
 * pages in flight, a page is sent under a band that is up to N pages out of
 * date, so the margin in `band.ts` has to absorb that staleness.
 *
 * IT WAS MEASURED AT THIS VALUE. Walked over 18,202 pages: at twelve in flight
 * the lag costs ZERO accepted pages, and at twenty-four it costs two. The 4x
 * margin and the 2x retry factor were both chosen against a lag of twelve.
 *
 * SO IF THIS NUMBER IS RAISED, THOSE TWO MUST BE REVISITED IN THE SAME COMMIT --
 * see `band.ts` and `models.ts`. A knob in one file silently deciding the
 * correctness of a rule in another is the defect this project has paid for more
 * than once; it is written in both places because a reader arrives at one or the
 * other, never at a document.
 */
export const DEFAULT_VLM_CONCURRENCY = 12;

/**
 * The total deadline on ONE page's request, and why it is generous rather than
 * tight.
 *
 * A page sent to a batching server gets NO bytes back until its batch finishes,
 * and its batch can sit behind one already running — up to ~2 full batches of
 * silence, which Crucible measured at ~350 s at twelve in flight on a
 * 3,895-token paperback page. Bun's `fetch` has a default idle timeout, and an
 * default fetch timeout cannot tell that silence apart from a dead socket: it
 * trips inside the NORMAL wait and fails the page. That is what killed a
 * 384-page book at page 73 — a page that would have landed a few seconds later.
 *
 * So the fetch carries an EXPLICIT deadline (an `AbortSignal.timeout`, which
 * replaces Bun's default) set where only a hung or dead server reaches it: the
 * number of pages that can be queued ahead of this one (the concurrency) times
 * a per-page ceiling well above even a runaway page. A page waiting for its
 * batch is weather and waits; a server that has genuinely stopped answering
 * fails by name after the deadline. See Owen's transient-vs-misconfiguration
 * rule — a wait, not a kill.
 */
const PER_PAGE_DEADLINE_MS = 60_000;
function requestDeadlineMs(concurrency: number): number {
  return Math.max(1, concurrency) * PER_PAGE_DEADLINE_MS;
}

export async function readPagesFromEndpoint(opts: VlmEndpointOptions): Promise<void> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const queue = [...opts.pages];
  const workers = Math.max(1, Math.min(opts.concurrency, queue.length));

  /*
   * THE FIRST THROW STOPS THE HANDING-OUT, NOT THE PAGES IN FLIGHT.
   *
   * `Promise.all` rejects on the first worker that throws, and the caller then
   * throws out of the run -- while the other eleven workers are still waiting
   * on answers the card is in the middle of computing. Those answers used to
   * arrive at an `onPage` nobody was listening to, or not at all, because the
   * CLI had already exited. So a throw is HELD: the worker that hit it stops,
   * `next` hands out nothing more, every other worker finishes the page it is
   * on and banks it through `onPage` as if nothing had happened, and only when
   * the last of them is done is the held throw let out. Eleven pages of GPU
   * time land instead of being thrown away; the resume reads twelve fewer.
   *
   * Every kind of throw is held this way, not only a park. A misconfiguration
   * named on one worker is the same misconfiguration the others are about to
   * name, and the in-flight pages are lost either way -- but a page that DOES
   * land in that window is banked, and the first sentence is the one said.
   */
  let held: unknown = null;
  const next = (): EndpointRequest | undefined => (held === null ? queue.shift() : undefined);

  const run = async (): Promise<void> => {
    for (let page = next(); page !== undefined; page = next()) {
      try {
        opts.onPage(await readOnePage(url, page, opts));
      } catch (err) {
        if (held === null) held = err;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  if (held !== null) throw held;
}

/**
 * ONE PAGE, THROUGH THE WEATHER: try, and on weather wait and try again until
 * the budget is spent, then park by name. A refusal that is not weather is
 * thrown at once, as it always was.
 */
async function readOnePage(
  url: string,
  page: EndpointRequest,
  opts: VlmEndpointOptions,
): Promise<EndpointPageResult> {
  const waits = opts.weatherWaitsMs ?? WEATHER_WAITS_MS;
  const tries = waits.length + 1;
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await tryOnePage(url, page, opts);
    if (!('fault' in outcome)) return outcome;
    const { fault } = outcome;
    if (fault.kind === 'refused') throw new VlmEndpointError(`page ${page.number}: ${fault.said}`);
    if (fault.kind === 'deadline') {
      throw new VlmParkedError(opts.endpoint, page.number, `${fault.said}.`);
    }
    const wait = waits[attempt - 1];
    if (wait === undefined) {
      const minutes = ((Date.now() - started) / 60_000).toFixed(1);
      throw new VlmParkedError(
        opts.endpoint,
        page.number,
        `${tries} tries over ${minutes} min all met weather; the last: ${fault.said}`,
      );
    }
    opts.onWeather?.(
      `page ${page.number}: ${fault.said} That is weather, not a refusal -- trying again in `
      + `${wait >= 60_000 ? `${wait / 60_000} min` : `${wait / 1000} s`} (${attempt} of ${tries}).`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * ONE TRY AT ONE PAGE: the answer, or the fault, classified.
 *
 * The classification is the whole of Owen's rule in one place. A throw out of
 * `fetch` is the socket speaking -- a connect timeout, a reset, a proxy's
 * ReadError re-thrown as "could not be reached" -- and the socket cannot
 * misconfigure anything, so it is weather; except the deadline's own abort,
 * which is its own kind (see the header). A status in `WEATHER_STATUSES` is
 * weather. Every other refusal is a sentence for a person, explained by
 * `explainHttpRefusal` exactly as before.
 */
async function tryOnePage(
  url: string,
  page: EndpointRequest,
  opts: VlmEndpointOptions,
): Promise<EndpointPageResult | { fault: Fault }> {
  const image = fs.readFileSync(page.imagePath).toString('base64');
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // An EXPLICIT deadline, which replaces Bun's default fetch timeout — the
      // one that fired inside a normal batch wait and failed a page that would
      // have landed seconds later. A page gets no bytes until its batch
      // completes, so the only honest limit is this total deadline, generous
      // enough that only a hung server reaches it. See PER_PAGE_DEADLINE_MS.
      signal: AbortSignal.timeout(requestDeadlineMs(opts.concurrency)),
      headers: { ...(opts.headers ?? {}), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        temperature: opts.temperature,
        max_tokens: capOf(opts.maxTokens, page),
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
            { type: 'text', text: opts.prompt },
          ],
        }],
      }),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'TimeoutError') {
      const minutes = Math.round(requestDeadlineMs(opts.concurrency) / 60_000);
      return { fault: { kind: 'deadline', said: `${url} gave no answer within the ${minutes} min deadline` } };
    }
    return { fault: { kind: 'weather', said: `${url} could not be reached (${why}).` } };
  }

  if (!response.ok) {
    const said = `${url} ${explainHttpRefusal(response.status, response.statusText, await response.text())}`;
    return { fault: { kind: WEATHER_STATUSES.has(response.status) ? 'weather' : 'refused', said } };
  }

  /*
   * Decoded ONCE and read twice: `payload` is the record that gets banked and
   * `answer` is the same object seen through the few fields this program needs.
   * Parsing it a second time into a narrower shape would be the moment the two
   * could disagree about what the server said.
   */
  const payload: unknown = await response.json();
  const answer = payload as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { completion_tokens?: number };
  };
  const choice = answer.choices?.[0];
  if (!choice || typeof choice.message?.content !== 'string') {
    throw new VlmEndpointError(
      `page ${page.number}: the server's answer carries no message content. `
      + `It was: ${JSON.stringify(payload).slice(0, 400)}`,
    );
  }

  return {
    number: page.number,
    text: choice.message.content.trim(),
    tokens: answer.usage?.completion_tokens ?? 0,
    finishReason: choice.finish_reason ?? null,
    seconds: (Date.now() - started) / 1000,
    response: payload,
  };
}
