/**
 * clean/runner — the model, wired to the server this machine is pointed at.
 *
 * ── ONE SEAM, ONE SERVER ────────────────────────────────────────────────────
 *
 * Until 2026-09-13 this adapter chose between two servers on `--server
 * ollama|vllm`. Owen ended the choice (translate/transport.ts carries the
 * ruling): every model call goes to one OpenAI-compatible door, the operator
 * makes the model resident before the pass is spawned, and the pass never loads
 * or unloads anything. The prompt is the same bytes, the temperature is the
 * same zero, the validators and the records and the stamp are untouched.
 *
 * ── WHY THE VENDORED DRIVER'S OWN TRANSPORT DID NOT COME ACROSS ─────────────
 *
 * `tts-number-normalizer.ts` never held an HTTP call. It takes a
 * `NumberNormalizerRunner` — four members, `{model, pinContextTo?, generate,
 * release}` — and BookForge binds one to its `ai-bridge`. Foundry's own door
 * (`translate/model-server.ts`) maps onto that seam cleanly, so this is thirty
 * lines of adapter rather than a second transport. TWO OF THE FOUR MEMBERS ARE
 * NAMED FOR A WORLD THIS ENGINE HAS LEFT, and the names stay because the
 * interface is the vendored contract:
 *
 *  - `pinContextTo` was an instruction to size a per-request window. There is
 *    no such window now; the server's is fixed when the model is made resident.
 *    What the call still carries is the LONGEST REQUEST OF THE BOOK, known
 *    before the first one is sent, and that is exactly what a refusal needs: a
 *    request the window cannot hold is refused HERE, by name, rather than sent
 *    to come back truncated and counted as a parse failure against the 10%
 *    share that fails the run. A wrong answer arriving silently is worse than
 *    the refusal.
 *  - `release` gives the card back. Nothing is given back: the operator put the
 *    model there and a pass ending is not a reason to take it off. It is a
 *    declared no-op and says nothing, because there is nothing to say.
 *
 * NOT STREAMED. BookForge streams so a desktop progress bar can move inside one
 * block; this pass reports progress per BLOCK, so a stream would buy an
 * inactivity timer and nothing else. `fetchTransport`'s deadline is a total
 * one, which is the honest shape for a request nobody is watching.
 *
 * NO `<answer>` EXTRACTION HERE. `askForEdits` already calls `firstJsonObject`
 * over whatever comes back, which finds the object inside the tags the prompt
 * asks for. What made BookForge's extractor necessary is a REASONING model
 * emitting a `<think>` block that could contain a JSON object of its own — and
 * the door sends the thinking switch off for every qwen3 family model, then
 * strips a leading `<think>` block if one arrives anyway (`withoutThinking`).
 * A model that thinks past that produces a parse failure, which is a recorded
 * disposition and not a silently wrong answer.
 *
 * ── TEMPERATURE 0, AND IT IS NOT THIS FILE'S TO REVISE ──────────────────────
 *
 * The doctrine pins it (docs/CLEAN-TEXT.md: *one call per block, temperature
 * 0*), the retry rules depend on it — a parse failure is retried once at the
 * SAME settings, because a second identical answer is the model's real answer
 * and a re-roll would be a different pass — and the training corpora are
 * normalized under it.
 */
import { askModel, openModelServer } from '../translate/model-server.js';
import { fetchTransport, type ChatTuning, type Transport } from '../translate/transport.js';
import { fitsWindow, promptTokens, VllmError } from '../translate/vllm.js';
import type { NumberNormalizerRunner } from './tts-number-normalizer.js';

/**
 * How much answer one block may generate, in tokens.
 *
 * BookForge has TWO edit-list budgets and this is the think-OFF one: its
 * number-normalizer runner's `NUMBER_NUM_PREDICT` (2048), sized for the JSON
 * alone because that pass sends `think:false`. Its other, `EDITLIST_NUM_PREDICT`
 * (6144), is cogito's in-band chain-of-thought budget and would size every
 * window three times larger than a pass that does not think needs — BookForge's
 * own comment on the 2048 says exactly that. This pass does not think (the
 * server will apply that from the model's manifest; until then the thinking
 * switch goes on the wire), so the two numbers are not a disagreement about one
 * fact. A manifest that turned thinking ON for the clean model would make 2048
 * clip the reasoning, and that is a manifest defect, not a reason to triple this.
 *
 * An edit list is bounded by the edits a paragraph can carry — the validator
 * accepts at most 24 — so this is not a length derived from the block the way
 * `answerBudget` derives a translation's. It is a ceiling over a JSON object,
 * and it is generous because the cost of clipping one is a parse failure, which
 * is counted against the 10% share that fails the whole run.
 */
const EDIT_LIST_NUM_PREDICT = 2048;

export interface ModelRunnerOptions {
  /**
   * The model to ask for, ALWAYS a name by the time it reaches here.
   *
   * A run may leave `--model` off and mean "whatever is served", and that is
   * resolved by the CALLER (`run.ts`, `epub.ts`) rather than here — because the
   * records cache keys every block on the model's name (`cleanKey`), and a key
   * computed before the server was asked would file this run's answers under a
   * name that is not the one that answered.
   */
  model: string;
  endpoint: string;
  /** Injected so the tests can drive the whole pass with no server. */
  transport?: Transport;
  /** Said out loud — the refusal below names the block and the window. */
  log: (message: string) => void;
}

/**
 * Prove the server is there and holds the model, then hand back the runner.
 *
 * The proof is FIRST, before a single block is read, for `requireServedModel`'s
 * own reason: a book's worth of planning takes a second, the run would discover
 * a missing model on request one anyway, and what is bought by asking early is
 * the MESSAGE. A server that is not answering ends the run naming the URL that
 * was silent; a server holding the wrong model ends it naming what it holds.
 */
export async function openModelRunner(options: ModelRunnerOptions): Promise<NumberNormalizerRunner> {
  const transport = options.transport ?? fetchTransport();
  const server = await openModelServer({
    transport,
    endpoint: options.endpoint,
    model: options.model,
  });
  const tuning: ChatTuning = { temperature: 0, numPredict: EDIT_LIST_NUM_PREDICT };

  return {
    model: server.model,
    pinContextTo(systemPrompt: string, longestInput: string): void {
      /*
       * THE ONE CHECK THIS BOOK GETS, before request one. `capFor` (vllm.ts)
       * would send a request that nearly fills the window with a 128-token
       * answer budget, which cannot hold an edit list; the model's answer would
       * be cut off and the cut-off would be counted as a parse failure — the
       * model blamed for a request that could never have been answered. So the
       * longest request is measured against the window here and refused by
       * name if it does not fit. A server that reported no window is not
       * second-guessed; it will say so itself on the first request.
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
      options.log(
        `clean-text: ${server.model} at ${server.endpoint}, temperature 0. The context window `
        + 'is the server\'s own, fixed when the model was made resident'
        + `${server.maxModelLen === null ? '' : ` (${server.maxModelLen} tokens)`}; this book's `
        + `longest request is ${longestInput.length} characters and fits.`,
      );
    },
    async generate(input: string, systemPrompt: string): Promise<string> {
      return askModel(transport, server, systemPrompt, input, tuning);
    },
    async release(): Promise<void> {
      /*
       * Nothing to give back. The operator made the model resident and a pass
       * ending is not a reason to take it off the card — a load evicts, so an
       * unload here would be one job deciding for whatever runs next.
       */
    },
  };
}
