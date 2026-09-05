/**
 * clean/runner — the model, wired to the engine's own Ollama client.
 *
 * ── WHY THE VENDORED DRIVER'S OWN TRANSPORT DID NOT COME ACROSS ─────────────
 *
 * `tts-number-normalizer.ts` never held an HTTP call. It takes a
 * `NumberNormalizerRunner` — four members, `{model, pinContextTo?, generate,
 * release}` — and BookForge binds one to its `ai-bridge`, which streams NDJSON
 * off `POST /api/generate`, resets an inactivity timer on each chunk, and then
 * pulls exactly one `<answer>…</answer>` block out of the reply.
 *
 * Foundry already has an Ollama client (`src/translate/ollama.ts`) and it maps
 * onto that seam cleanly, so this is thirty lines of adapter rather than a
 * second transport. THE THREE DIFFERENCES ARE DELIBERATE AND EACH IS PAID FOR:
 *
 *  - `/api/chat` RATHER THAN `/api/generate`. The prompt is a system message and
 *    the block is a user message on both routes; `chat` is the endpoint this
 *    repo's client speaks, it is the one `translate` is measured on, and it is
 *    where `requireModel`'s named refusals already live — "no model named
 *    qwen3.8:27b — installed: …" is a sentence somebody can act on, and
 *    re-deriving it against a second endpoint would be a second copy of it.
 *  - NOT STREAMED. BookForge streams so a desktop progress bar can move inside
 *    one block; this pass reports progress per BLOCK, so a stream would buy an
 *    inactivity timer and nothing else. `fetchTransport`'s deadline is a total
 *    one, which is the honest shape for a request nobody is watching.
 *  - NO `<answer>` EXTRACTION HERE. `askForEdits` already calls
 *    `firstJsonObject` over whatever comes back, which finds the object inside
 *    the tags the prompt asks for. What made BookForge's extractor necessary is
 *    a REASONING model emitting a `<think>` block that could contain a JSON
 *    object of its own — and `chatBody` sends `think: false` for every qwen3
 *    tag, which the default `qwen3.8:27b` is. A model that thinks anyway
 *    produces a parse failure, which is a recorded disposition and not a
 *    silently wrong answer.
 *
 * ── TEMPERATURE 0, AND IT IS NOT THIS FILE'S TO REVISE ──────────────────────
 *
 * The doctrine pins it (docs/CLEAN-TEXT.md: *one call per block, temperature
 * 0*), the retry rules depend on it — a parse failure is retried once at the
 * SAME settings, because a second identical answer is the model's real answer
 * and a re-roll would be a different pass — and the training corpora are
 * normalized under it. `num_predict` is BookForge's own fixed 2048.
 */
import {
  chat, fetchTransport, normaliseEndpoint, requireModel, unloadModel, type ChatTuning,
  type Transport,
} from '../translate/ollama.js';
import type { NumberNormalizerRunner } from './tts-number-normalizer.js';

/**
 * How much answer one block may generate, in tokens. BookForge's number, kept.
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
 * Ollama fully reloads the runner on any `num_ctx` change, so a per-block
 * estimate would evict and reload a 17 GB model between paragraphs — which on a
 * book of two thousand blocks is the run. BookForge sizes it the same way and
 * for the same reason; the arithmetic is its own: roughly three characters to a
 * token, plus what the answer may generate, plus headroom, plus a fifth for
 * being wrong about all of it.
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

export interface OllamaRunnerOptions {
  model: string;
  endpoint: string;
  /** Injected so the tests can drive the whole pass with no server. */
  transport?: Transport;
  /**
   * Leave the weights loaded when the run ends.
   *
   * `translate --keep-model`'s flag and its argument: an Ollama somebody else is
   * also using is not foundry's to unload. Absent means the model is released,
   * which is the default because this pass is minutes of a one-GPU machine and
   * whatever runs next wants the VRAM.
   */
  keepModel?: boolean;
  /** Said out loud — the release is best effort and never fails the run. */
  log: (message: string) => void;
}

/**
 * Prove the server is there and holds the model, then hand back the runner.
 *
 * The proof is FIRST, before a single block is read, for `requireModel`'s own
 * reason: a book's worth of planning takes a second, the run would discover a
 * missing model on request one anyway, and what is bought by asking early is
 * the MESSAGE. A server that is not answering ends the run naming the URL that
 * was silent, which is the only thing the person about to type `ollama serve`
 * needs from this program.
 */
export async function openOllamaRunner(
  options: OllamaRunnerOptions,
): Promise<NumberNormalizerRunner> {
  const transport = options.transport ?? fetchTransport();
  const endpoint = normaliseEndpoint(options.endpoint);
  await requireModel(transport, endpoint, options.model);

  let tuning: ChatTuning = {
    temperature: 0,
    numCtx: CTX_BUCKET,
    numPredict: EDIT_LIST_NUM_PREDICT,
  };

  return {
    model: options.model,
    pinContextTo(systemPrompt: string, longestInput: string): void {
      const numCtx = contextWindowFor(systemPrompt, longestInput);
      tuning = { ...tuning, numCtx };
      options.log(
        `clean-text: ${options.model} at ${endpoint}, temperature 0, context ${numCtx} tokens `
        + `(pinned once, from the longest of this book's requests at ${longestInput.length} `
        + 'characters)',
      );
    },
    async generate(input: string, systemPrompt: string): Promise<string> {
      return chat(transport, endpoint, options.model, systemPrompt, input, tuning);
    },
    async release(): Promise<void> {
      if (options.keepModel === true) return;
      const unloaded = await unloadModel(transport, endpoint, options.model);
      if (!unloaded) {
        options.log(
          `clean-text: ${endpoint} did not acknowledge the request to unload ${options.model}. The `
          + 'book is written; a server that has already gone away has released the memory anyway.',
        );
      }
    },
  };
}
