/**
 * vlm/contract — WHAT A PAGE REQUEST IS, read from the server that will answer it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Page reading has no job type of its own: a page is a chat completion with one
 * `image_url` part, so the CLIENT builds the request. Until now this program
 * built it out of constants pinned in its own source — `DOTS_PROMPT`,
 * `maxTokens: 8192`, `maxPixels: 11289600`, `VLM_DPI = 200` — and the server
 * that answers those requests pins the same four numbers in
 * `crucible/pages.py`. Two owners, nothing comparing them.
 *
 * WHAT THAT COSTS IS NOT AN ERROR. They agree today. The day one of them moves
 * — a processor config that changed under the weights, a prompt corrected
 * against the model card, a ceiling raised for a denser corpus — the run keeps
 * working and reads WORSE: boxes scaled out of the wrong frame land a few per
 * cent off, so a paragraph loses its indent test and a Picture is cropped
 * slightly wrong. Nothing refuses, nothing logs, and the natural conclusion is
 * that the model got worse.
 *
 * So the server publishes the contract on `GET /v1/info` as `pages_engine`, for
 * exactly this reason, in its own words: the client *"was building it out of
 * constants pinned in its own source — a prompt and a pixel budget are facts
 * about the weights, and the division-of-knowledge ruling puts those here."*
 * Every backend answers from ONE function, so vLLM in WSL, llama.cpp on Windows
 * and mlx-vlm on a Mac hand back the same block; this file reads it, and the
 * endpoint route reads nothing else.
 *
 * ── AND WHY A SERVER THAT DOES NOT PUBLISH IT IS REFUSED ────────────────────
 *
 * There is no "use ours if the server is quiet" arm here, and that absence is
 * the whole design. A default would put the pinned copies straight back, with
 * the added property that nobody could tell which run used which — and the
 * failure it hides is a silently worse book. A server with no `pages_engine`
 * has not agreed to serve pages under this contract, and saying so before the
 * first page costs one request against a run that is about to cost GPU-minutes
 * a page.
 *
 * THE LOCAL MLX ROUTE IS NOT AFFECTED and must not be. There this program holds
 * the weights, runs the processor and chooses the budget itself
 * (`MLX_MAX_PIXELS`, `bridge.ts`), so the numbers in `models.ts` are its own
 * facts rather than a copy of somebody's — which is why they are still there
 * and why this file is reached only when `--vlm-endpoint` is.
 */

import { fetchTransport } from '../translate/transport.js';
import type { Transport } from '../translate/transport.js';

/** The server would not say what a page request is. Always names the URL. */
export class PageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageContractError';
  }
}

/**
 * `pages_engine.request`, in this program's terms.
 *
 * Every field is required and none has a default here. A field the server did
 * not send is this file's refusal, not this file's guess — see the header.
 */
export interface PageReadContract {
  /** What to send as `model`. The server's own id for the page reader. */
  model: string;
  /** What the CLIENT rasterises at; the boxes come back scaled from this. */
  dpi: number;
  /** The processor's pixel budget — the frame the model's boxes are in. */
  maxPixels: number;
  /** The CEILING for one page. A per-page cap may be lower, never higher. */
  maxTokens: number;
  /** A layout is not a thing to be creative about. */
  temperature: number;
  /** The model card's prompt, verbatim. Never edited on the way through. */
  prompt: string;
  /** What the answer is shaped like. `dialect.ts` holds the parsers. */
  dialect: string;
  /** The `finish_reason` that means the model was still writing. */
  truncatedFinishReason: string;
  /** Which engine answers here — for a log line, never branched on. */
  engine: string | null;
}

/**
 * THE OPENAI BASE A PLACEMENT HANDS THE ENGINE, AND WHERE `/v1/info` IS FROM IT.
 *
 * A Crucible mounts its OpenAI-shaped routes at `<root>/openai/v1` and the app
 * composes exactly that: `crucible-dispatch.ts` puts `<engine.url>/openai` on
 * the placement and `job-queue.ts` appends `/v1`, because `endpoint.ts` speaks
 * `<base>/chat/completions`. So the document is at `<root>/v1/info`, and the
 * root is this base with that suffix taken off.
 *
 * MATCHED AS A SUFFIX AND NOT SEARCHED FOR. A `replace` of `/openai/v1`
 * anywhere in the string would corrupt a URL that carried it in a path prefix,
 * and that is a class of bug nobody would look for in a reader of a reader.
 */
const OPENAI_DOOR = '/openai/v1';

export function pagesInfoUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (!base.endsWith(OPENAI_DOOR)) {
    throw new PageContractError(
      `${endpoint} is not a Crucible's OpenAI door, so there is nowhere to read the page-reading `
      + `contract from. A reading endpoint ends in "${OPENAI_DOOR}" — the placement composes it `
      + '— and the server publishes the prompt, the dpi, the pixel budget and the token ceiling '
      + 'on GET /v1/info. This program no longer keeps a copy of those to fall back on: they are '
      + 'facts about the weights, and reading a book with the wrong ones costs the book, quietly.',
    );
  }
  return `${base.slice(0, -OPENAI_DOOR.length)}/v1/info`;
}

/** A field of the request block, refused by name rather than defaulted. */
function fieldOf<T>(
  block: Record<string, unknown>,
  key: string,
  kind: 'string' | 'number',
  url: string,
): T {
  const value = block[key];
  if (typeof value !== kind || (kind === 'number' && !Number.isFinite(value))) {
    throw new PageContractError(
      `${url} published a pages_engine.request with no usable "${key}" (got `
      + `${JSON.stringify(value)}). The whole block is the contract; a request built out of `
      + 'part of it is a request this program invented the rest of.',
    );
  }
  return value as T;
}

/**
 * The `/v1/info` document, turned into the contract or refused.
 *
 * Separate from the fetch so a test can hand in the bytes a real server sent,
 * which is the only honest way to prove a parse.
 */
export function parsePagesEngine(document: unknown, url: string): PageReadContract {
  if (typeof document !== 'object' || document === null) {
    throw new PageContractError(`${url} did not answer with a JSON object`);
  }
  const block = (document as Record<string, unknown>)['pages_engine'];
  if (block === undefined || block === null) {
    throw new PageContractError(
      `${url} publishes no "pages_engine", so this server is not serving pages under the `
      + 'contract this program reads. Either it predates it or it is not a Crucible. Nothing is '
      + 'assumed on its behalf: the prompt, the dpi and the pixel budget are facts about the '
      + 'weights, and a run that guessed them would read the book worse without failing.',
    );
  }
  const engineBlock = block as Record<string, unknown>;
  const request = engineBlock['request'];
  if (typeof request !== 'object' || request === null) {
    throw new PageContractError(
      `${url}'s pages_engine carries no "request" block, so it says which engine reads a page `
      + 'here and not what a page request is. The second is the half this program needs.',
    );
  }
  const row = request as Record<string, unknown>;
  const engine = engineBlock['engine'];
  return {
    model: fieldOf<string>(row, 'model', 'string', url),
    dpi: fieldOf<number>(row, 'dpi', 'number', url),
    maxPixels: fieldOf<number>(row, 'max_pixels', 'number', url),
    maxTokens: fieldOf<number>(row, 'max_tokens', 'number', url),
    temperature: fieldOf<number>(row, 'temperature', 'number', url),
    prompt: fieldOf<string>(row, 'prompt', 'string', url),
    dialect: fieldOf<string>(row, 'dialect', 'string', url),
    truncatedFinishReason: fieldOf<string>(row, 'truncated_finish_reason', 'string', url),
    // `engine` is for an operator looking at a machine — which of the three
    // read this book — and a client that branched on it would be the exact
    // thing the contract exists to forbid. Null is a complete answer.
    engine: typeof engine === 'string' ? engine : null,
  };
}

/**
 * Ask the server that is about to read the pages what a page request is.
 *
 * ONE REQUEST, ONCE A RUN, BEFORE A PAGE IS RENDERED — because the dpi is in
 * the answer and the rasterisation is the first thing that happens. A run that
 * read the contract after rendering would have rendered at a resolution the
 * server did not ask for and had nothing to do about it.
 */
export async function readPageContract(
  endpoint: string,
  headers: Readonly<Record<string, string>> | undefined,
  transport: Transport = fetchTransport(undefined, headers),
): Promise<PageReadContract> {
  const url = pagesInfoUrl(endpoint);
  let response;
  try {
    response = await transport.get(url);
  } catch (error) {
    throw new PageContractError(
      `${url} could not be reached (${(error as Error).message}), so this run does not know what `
      + 'a page request is on that server. It is the same address the pages would have been '
      + 'posted to.',
    );
  }
  if (response.status !== 200) {
    throw new PageContractError(
      `${url} answered ${response.status}. A Crucible publishes the page-reading contract there; `
      + 'something else is listening, or this token cannot read it.',
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(response.body);
  } catch {
    throw new PageContractError(`${url} answered 200 with something that is not JSON`);
  }
  return parsePagesEngine(document, url);
}
