/**
 * clean/runner — the model, wired to whichever server this machine is pointed at.
 *
 * ── ONE SEAM, THREE SERVERS ─────────────────────────────────────────────────
 *
 * `--server openai|ollama|anthropic`. The choice is made in
 * `translate/model-server.ts` and nothing below this line knows about it: the
 * prompt is the same bytes, the temperature is the same zero, the validators and
 * the records and the stamp are untouched. What changes is the transport and the
 * two things that hang off it, and this file is where both of them show:
 *
 *  - THE WINDOW. `pinContextTo` is an OLLAMA instruction — that server takes
 *    `num_ctx` per request and fully reloads the runner on a change, so the size
 *    is computed ONCE from the longest request of the whole book
 *    (`contextWindowFor`). On the OpenAI door the window was fixed when the
 *    model was made resident and the KV cache was allocated against it; there is
 *    nothing to pin, so the same call does the other useful thing instead — it
 *    measures the longest request against what the server said it can hold and
 *    REFUSES BY NAME if it does not fit, rather than sending a request that
 *    comes back truncated and is counted as a parse failure against the 10%
 *    share that fails the run. On a cloud provider there is no published window
 *    to measure against, so the check has nothing to compare and lets the book
 *    through — the same answer `fitsWindow` gives any server that reported
 *    nothing, and the provider names its own limit if a block exceeds it. The
 *    log line says which of the three happened, because a line claiming a pinned
 *    window on a server that was told nothing, or a fitted one against a window
 *    nobody published, would be this program reporting a check it did not make.
 *  - THE END OF THE RUN. `release` gives the card back, and on Ollama it always
 *    does (Owen's ruling; `releaseModel`, translate/model-server.ts). On the
 *    other two it asks nothing: on the OpenAI door the operator put the model
 *    there and a pass ending is not a reason to take it off, and on a provider
 *    there was never a card.
 *
 * ── WHY THE VENDORED DRIVER'S OWN TRANSPORT DID NOT COME ACROSS ─────────────
 *
 * `tts-number-normalizer.ts` never held an HTTP call. It takes a
 * `NumberNormalizerRunner` — four members, `{model, pinContextTo?, generate,
 * release}` — and BookForge binds one to its `ai-bridge`, which streams NDJSON
 * off `POST /api/generate`, resets an inactivity timer on each chunk, and then
 * pulls exactly one `<answer>…</answer>` block out of the reply. Foundry's own
 * door (`translate/model-server.ts`) maps onto that seam cleanly, so this is
 * thirty lines of adapter rather than a second transport. THE THREE DIFFERENCES
 * ARE DELIBERATE AND EACH IS PAID FOR:
 *
 *  - `/api/chat` RATHER THAN `/api/generate`, on the Ollama route. The prompt is
 *    a system message and the block is a user message on both routes; `chat` is
 *    the endpoint this repo's client speaks, it is the one `translate` is
 *    measured on, and it is where `requireModel`'s named refusals already live —
 *    "no model named qwen3.8:27b — installed: …" is a sentence somebody can act
 *    on, and re-deriving it against a second endpoint would be a second copy.
 *  - NOT STREAMED. BookForge streams so a desktop progress bar can move inside
 *    one block; this pass reports progress per BLOCK, so a stream would buy an
 *    inactivity timer and nothing else. `fetchTransport`'s deadline is a total
 *    one, which is the honest shape for a request nobody is watching.
 *  - NO `<answer>` EXTRACTION HERE. `askForEdits` already calls `firstJsonObject`
 *    over whatever comes back, which finds the object inside the tags the prompt
 *    asks for. What made BookForge's extractor necessary is a REASONING model
 *    emitting a `<think>` block that could contain a JSON object of its own —
 *    and both LOCAL doors send the thinking switch off for every qwen3 family
 *    model, with the OpenAI one also stripping a leading `<think>` block if one
 *    arrives anyway (`withoutThinking`); on `anthropic` there is nothing to
 *    switch, because Claude models do not reason unless a request asks them to.
 *    A model that thinks past that produces a parse failure, which is a recorded
 *    disposition and not a silently wrong answer.
 *
 * ── TEMPERATURE 0, AND IT IS NOT THIS FILE'S TO REVISE ──────────────────────
 *
 * The doctrine pins it (docs/CLEAN-TEXT.md: *one call per block, temperature
 * 0*), the retry rules depend on it — a parse failure is retried once at the
 * SAME settings, because a second identical answer is the model's real answer
 * and a re-roll would be a different pass — and the training corpora are
 * normalized under it.
 */
import {
  askModel, openModelServer, releaseModel, type ServerKind,
} from '../translate/model-server.js';
import {
  fetchTransport, usageLine, type ChatTuning, type Transport,
} from '../translate/transport.js';
import { fitsWindow, promptTokens, VllmError } from '../translate/vllm.js';
import type { ModelServerFacts, NumberNormalizerRunner } from './tts-number-normalizer.js';

/**
 * How much answer one block may generate, in tokens.
 *
 * BookForge has TWO edit-list budgets and this is the think-OFF one: its
 * number-normalizer runner's `NUMBER_NUM_PREDICT` (2048), sized for the JSON
 * alone because that pass sends `think:false`. Its other, `EDITLIST_NUM_PREDICT`
 * (6144), is cogito's in-band chain-of-thought budget and would size every
 * window three times larger than a pass that does not think needs — BookForge's
 * own comment on the 2048 says exactly that. This pass does not think (the
 * OpenAI door's server will apply that from the model's manifest; until then the
 * thinking switch goes on the wire, and on Ollama it always does), so the two
 * numbers are not a disagreement about one fact. A manifest that turned thinking
 * ON for the clean model would make 2048 clip the reasoning, and that is a
 * manifest defect, not a reason to triple this.
 *
 * An edit list is bounded by the edits a paragraph can carry — the validator
 * accepts at most 24 — so this is not a length derived from the block the way
 * `answerBudget` derives a translation's. It is a ceiling over a JSON object,
 * and it is generous because the cost of clipping one is a parse failure, which
 * is counted against the 10% share that fails the whole run.
 */
const EDIT_LIST_NUM_PREDICT = 2048;

/**
 * The context window, sized ONCE from the longest request of the whole book.
 *
 * OLLAMA ONLY, and the reason is the reason it is once: Ollama allocates the KV
 * cache when it loads a runner for a given `num_ctx` and fully reloads on any
 * change to it, so a per-block estimate would evict and reload a 17 GB model
 * between paragraphs — which on a book of two thousand blocks IS the run.
 * BookForge sizes it the same way and for the same reason; the arithmetic is its
 * own: roughly three characters to a token, plus what the answer may generate,
 * plus headroom, plus a fifth for being wrong about all of it.
 *
 * The OpenAI door is told nothing about its window and this is not computed for
 * it — see `pinContextTo` below, where the same measurement is spent on a
 * refusal instead.
 */
const CHARS_PER_TOKEN = 3;
const CTX_HEADROOM_TOKENS = 512;
const CTX_SAFETY = 1.2;
const CTX_BUCKET = 4096;
const CTX_MAX = 16384;

export function contextWindowFor(systemPrompt: string, longestInput: string): number {
  const tokens = (systemPrompt.length + longestInput.length) / CHARS_PER_TOKEN
    + EDIT_LIST_NUM_PREDICT + CTX_HEADROOM_TOKENS;
  const wanted = Math.ceil((tokens * CTX_SAFETY) / CTX_BUCKET) * CTX_BUCKET;
  return Math.min(Math.max(wanted, CTX_BUCKET), CTX_MAX);
}

export interface ModelRunnerOptions {
  /**
   * The model to ask for, ALWAYS a name by the time it reaches here.
   *
   * On the OpenAI door a run may leave `--model` off and mean "whatever is
   * served", and that is resolved by the CALLER (`run.ts`, `epub.ts`) rather
   * than here — because the records cache keys every block on the model's name
   * (`cleanKey`), and a key computed before the server was asked would file this
   * run's answers under a name that is not the one that answered. On Ollama a
   * name was always required and the refusal came before any of this.
   */
  model: string;
  endpoint: string;
  /** Which dialect is on the other end. Default `openai`. */
  server?: ServerKind;
  /** Injected so the tests can drive the whole pass with no server. */
  transport?: Transport;
  /** Said out loud — the window line, and the release, which never fails a run. */
  log: (message: string) => void;
}

/**
 * Prove the server is there and holds the model, then hand back the runner.
 *
 * The proof is FIRST, before a single block is read, for `requireModel`'s own
 * reason: a book's worth of planning takes a second, the run would discover a
 * missing model on request one anyway, and what is bought by asking early is
 * the MESSAGE. A server that is not answering ends the run naming the URL that
 * was silent; a server that has not got the model ends it naming what it has.
 */
export async function openModelRunner(options: ModelRunnerOptions): Promise<NumberNormalizerRunner> {
  const transport = options.transport ?? fetchTransport();
  const kind: ServerKind = options.server ?? 'openai';
  const server = await openModelServer({
    kind,
    transport,
    endpoint: options.endpoint,
    model: options.model,
    log: options.log,
  });
  let tuning: ChatTuning = { temperature: 0, numPredict: EDIT_LIST_NUM_PREDICT };
  /*
   * THE FACTS GO IN THE RECEIPT; THE LOG SAYS WHAT IS BEING DONE.
   *
   * Until 2026-09-20 `pinContextTo` wrote a paragraph to the log — endpoint,
   * dialect, temperature, the window and why it was or was not pinned, the
   * longest request — and BookForge draws the last log line on the queue slot,
   * so a person watching a book read "NOTHING IS PINNED here (16384 tokens)".
   * Owen: *"it can just say what its doing generically."* The paragraph was
   * provenance, and provenance belongs in the receipt where it can be compared
   * across books; it is kept there in full (`ModelServerFacts`). What the log
   * says now is the one thing a watcher wants: which model is cleaning.
   */
  const facts: ModelServerFacts = {
    kind: server.kind,
    endpoint: server.endpoint,
    model: server.model,
    temperature: 0,
    contextWindow: server.kind === 'ollama' ? null : server.maxModelLen,
    contextPinned: false,
    longestRequestChars: null,
  };

  return {
    model: server.model,
    serverFacts: () => ({ ...facts }),
    pinContextTo(systemPrompt: string, longestInput: string): void {
      facts.longestRequestChars = longestInput.length;
      if (server.kind === 'ollama') {
        const numCtx = contextWindowFor(systemPrompt, longestInput);
        tuning = { ...tuning, numCtx };
        facts.contextWindow = numCtx;
        facts.contextPinned = true;
        options.log(`clean-text: cleaning with ${server.model}`);
        return;
      }
      /*
       * THE ONE CHECK THIS BOOK GETS ON THE OTHER DOOR, before request one.
       * `capFor` (vllm.ts) would send a request that nearly fills the window
       * with a 128-token answer budget, which cannot hold an edit list; the
       * model's answer would be cut off and the cut-off would be counted as a
       * parse failure — the model blamed for a request that could never have
       * been answered. So the longest request is measured against the window
       * here and refused by name if it does not fit. A server that reported no
       * window is not second-guessed; it will say so itself on the first request.
       */
      if (!fitsWindow(systemPrompt, longestInput, EDIT_LIST_NUM_PREDICT, server.maxModelLen)) {
        throw new VllmError(
          `clean-text: this book's longest request is ${longestInput.length} characters `
          + `(about ${promptTokens(systemPrompt, longestInput)} tokens with the prompt), and `
          + `${server.model} at ${server.endpoint} has a window of ${server.maxModelLen} tokens `
          + `— not enough to hold it and a ${EDIT_LIST_NUM_PREDICT}-token answer. Nothing was `
          + 'asked. Make the model resident with a longer context, or split the block.',
        );
      }
      options.log(`clean-text: cleaning with ${server.model}`);
    },
    async generate(input: string, systemPrompt: string): Promise<string> {
      return askModel(transport, server, systemPrompt, input, tuning);
    },
    async release(): Promise<void> {
      /*
       * ALWAYS, ON OLLAMA, AND THERE IS NO FLAG. Owen: a job is not a chat, and
       * a job that is over holds nothing. This pass is minutes of a one-GPU
       * machine and whatever runs next wants the VRAM. Best effort by
       * construction — `unloadModel` cannot throw — so a book that was written
       * is never reported as failed because a courtesy went unacknowledged.
       */
      const outcome = await releaseModel(transport, server.kind, server.endpoint, server.model);
      if (outcome === 'not-ours') {
        options.log(
          `clean-text: nothing to unload at ${server.endpoint} — this pass never loaded a model, `
          + 'and nothing on the other end is this pass\'s to take down '
          + '(translate/model-server.ts).',
        );
      } else {
        options.log(
          outcome === 'released'
            ? `clean-text: asked ollama to unload ${server.model} — the card is free for the next `
              + 'job.'
            : `clean-text: ${server.endpoint} did not acknowledge the request to unload `
              + `${server.model}. The book is written; a server that has already gone away has `
              + 'released the memory anyway.',
        );
      }
      /*
       * WHAT THE RUN SPENT, once, last. It is printed here rather than by the
       * callers because this is the only place in the clean-text pass that runs
       * after the last request on every route — the book file's and the bare
       * EPUB's — and a count printed twice would read as two runs. Null where
       * no server reported any usage at all (Ollama), which is silence rather
       * than a line of zeroes; see `usageLine`.
       */
      const spent = usageLine('clean-text');
      if (spent !== null) options.log(spent);
    },
  };
}
