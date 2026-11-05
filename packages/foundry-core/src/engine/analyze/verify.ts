/**
 * analyze/verify — the one question the ranker cannot answer.
 *
 * ── WHAT THIS STAGE IS FOR ──────────────────────────────────────────────────
 *
 * A ranker cannot tell STANCE apart. "These people are vermin" and "he called
 * them vermin, which is monstrous" read alike to it, because both passages are
 * about the same proposition — one asserts it and the other reports it, and
 * nothing in a ranking says which. That is the stage that keeps a history of
 * propaganda from being flagged as propaganda, and nothing upstream can do it.
 *
 * So every (window, category) the ranker kept gets exactly one question asked
 * about the whole passage: is the AUTHOR asserting this claim as their own
 * position, or reporting, quoting, questioning or arguing against it? The
 * answer is a verdict and the verifier's REASON for it — one or two sentences
 * naming what the author says and why that is or is not the claim. There is
 * still no severity.
 *
 * ── THE REASON IS ASKED FOR, AFTER THE VERDICT ──────────────────────────────
 *
 * briefcase's v4 prompt (flag-verify/v4-justified-2026-09-24) and Owen's
 * ruling here (2026-09-25: *"yes, side panel should show the reasoning"*). The
 * schema puts `verdict` FIRST, so the answer is committed before the
 * justification is written and the reason explains the call rather than
 * steering it — the measurement below is what room to reason BEFORE answering
 * cost.
 *
 * ── EVERY VERDICT IS STORED; ONLY THE FLAGS ARE FOUND ───────────────────────
 *
 * A skip is kept in the report's cache like a flag, so a re-run never pays for
 * the same question twice. But the report's FINDINGS are the flags alone (Owen,
 * 2026-09-25: *"we wont have two separate categories in this. confirmed
 * only"*) — the ghosted rejections the loose display tier used to show are gone
 * with the tiers.
 *
 * ── THE EMPHASIS LADDER IS DELIBERATELY NOT PORTED ──────────────────────────
 *
 * briefcase's prompt carried a `VERIFICATION_EMPHASIS` line that leaned the
 * verdict harder toward "flag" at higher sensitivities. It existed to make ONE
 * RE-RUN's verdicts looser, and Foundry does not re-run: verdicts are stored
 * once and read back. The prompt below is briefcase's level 2 — the
 * CALIBRATED one, whose emphasis string is deliberately empty — and it is the
 * only one ever asked. Leaning it would mean the stored verdicts were the
 * answer to a different question from the one the report claims.
 *
 * ── AND THE PROMPT IS CONSTRAINED, WHICH INVERTS BRIEFCASE'S OTHER RULING ───
 *
 * briefcase measured that constraining its open-ended DISCOVERY call hurt —
 * recall 7.3 -> 5.7 of 11 — because the suppressed reasoning was paying for the
 * assert-vs-debunk judgment. This call is the opposite shape: the candidate is
 * already chosen, the claim is already stated, and the answer is one of two
 * tokens. The measurement inverts with the shape (briefcase's
 * `final-score.txt`, qwen3.8:27b, same 70 candidates, same prompt):
 *
 *   constrained    9/10 recall vs the hand audit,  2.90s/call median,   204s total
 *   UNCONSTRAINED  6/10 recall vs the hand audit, 20.30s/call median, 3,091s total
 *
 * Unconstrained was worse on quality AND about seven times slower: given room
 * to reason about one line, the model talks itself out of real flags. So the
 * schema is not optional and there is no opt-out.
 */
import type { ModelServer } from '../translate/model-server.js';
import type { Transport } from '../translate/transport.js';
import { readGenerateAnswer } from '../translate/ollama.js';
import { constrainedChatBody, readChatAnswer } from '../translate/vllm.js';
import { constrainedToolBody, readMessageAnswer } from '../translate/anthropic.js';
import type { WindowCategory } from './rank.js';

/**
 * The schema the constrained decode carries — briefcase's
 * `FLAG_VERIFICATION_SCHEMA`. See this file's header for the measurement that
 * makes the constraint mandatory, and for why `verdict` is first.
 */
export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['flag', 'skip'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

/**
 * Which prompt asked — part of every verdict's cache key, and stamped into the
 * report header. briefcase's `FLAG_VERIFICATION_PROMPT_VERSION` with this
 * port's author rewrite, so it is named as its own.
 */
export const VERIFY_PROMPT_VERSION = 'foundry-verify/v4-justified-2026-09-25';

/**
 * How much answer one verdict may generate.
 *
 * A SMALL FIXED CONSTANT, and explicitly NOT translate's `answerBudget`, which
 * sizes generation from the SOURCE. briefcase measured the bare verdict at
 * 27-30 output tokens end to end; the reason adds one or two sentences — call
 * it sixty to a hundred tokens — and 512 is several times the two together,
 * which is headroom rather than an expectation. An answer that somehow hits it
 * is reported as a degradation and counted, never guessed at: a reason cut off
 * mid-sentence is not one to show anybody.
 */
const VERDICT_PREDICT_TOKENS = 512;

/**
 * The output budget num_ctx is SIZED from — a different number, on purpose.
 *
 * briefcase's `VERIFY_OUTPUT_BUDGET_TOKENS`. It is 2048 rather than 128 because
 * its only job is to keep the bucketed num_ctx at its floor, so that every call
 * in the stage lands on the same context size and Ollama never reloads the
 * model mid-stage. Sizing from 128 would let a short passage bucket lower than
 * a long one and buy exactly the reload this is arranged to avoid.
 *
 * OLLAMA ONLY. The other door's window was fixed when its model was made
 * resident, so nothing about it is sized here — see `askConstrained`.
 */
const VERIFY_OUTPUT_BUDGET_TOKENS = 2048;

/**
 * The num_ctx ceiling for a model, from the parameter count sniffed out of its
 * tag — ported from briefcase's `model-utils.ts`, which took it from BookForge.
 *
 * The ceiling keeps weights and KV cache on the GPU, because spilling a layer
 * to CPU bottlenecks every token:
 *   - 15B or under: 16384 tokens.
 *   - larger (32B-class) or an unrecognised size: 12288, conservatively —
 *     guessing low costs a rare clamp, guessing high cripples the whole stage.
 *
 * MoE tags (`mixtral:8x7b`) count experts times size, which is the memory the
 * weights actually take.
 */
export function numCtxMaxForModel(model: string): number {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(model);
  const dense = /(\d+(?:\.\d+)?)b/i.exec(model);
  const sizeB = moe
    ? parseInt(moe[1]!, 10) * parseFloat(moe[2]!)
    : dense
      ? parseFloat(dense[1]!)
      : null;
  if (sizeB !== null && sizeB <= 15) return 16384;
  return 12288;
}

/**
 * The num_ctx for a stage, sized from its LARGEST prompt — briefcase's
 * `estimateNumCtx`, ported with its two constraints intact:
 *
 *  - **Bucket to 4096.** Ollama fully reloads the model on ANY num_ctx change,
 *    so per-request estimates that each land on a slightly different value
 *    cause relentless reload churn. Rounding up to coarse buckets makes
 *    similar-sized prompts reuse the runner that is already loaded.
 *  - **Cap at `numCtxMaxForModel`.** Keep the KV cache on the GPU.
 *
 * Three characters to the token is deliberately pessimistic; the 512 and the
 * 1.2 are slack for a tokenizer that disagrees. It is called ONCE per stage,
 * with the longest prompt of the whole run, and the answer is pinned for every
 * call — which is what makes the stage pay one load instead of hundreds.
 */
export function estimateNumCtx(promptChars: number, model: string, outputBudgetTokens: number): number {
  const CHARS_PER_TOKEN = 3;
  const NUM_CTX_BUCKET = 4096;
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const raw = Math.ceil((inputTokens + outputBudgetTokens + 512) * 1.2);
  const bucketed = Math.max(NUM_CTX_BUCKET, Math.ceil(raw / NUM_CTX_BUCKET) * NUM_CTX_BUCKET);
  return Math.min(numCtxMaxForModel(model), bucketed);
}

/** The num_ctx this whole stage pins, from the longest prompt it will send. */
export function stageNumCtx(prompts: readonly string[], model: string): number {
  const longest = prompts.reduce((max, prompt) => Math.max(max, prompt.length), 0);
  return estimateNumCtx(longest, model, VERIFY_OUTPUT_BUDGET_TOKENS);
}

/**
 * Verify ONE (window, category) pair.
 *
 * briefcase's `buildFlagVerificationPrompt` (v4, the justified one), with
 * "speaker" rewritten to "author" throughout and its opening line changed from
 * "Transcript passage." — the ONE change beyond the systematic rewrite, and it
 * is not optional: telling a model that a page of a book is a transcript is a
 * false premise in the first four words of the prompt.
 *
 * WHY A PASSAGE AND NOT A MARKED SENTENCE. The unit of scoring is the sentence;
 * the unit of JUDGMENT is the passage the hot sentences were expanded into.
 * briefcase measured what asking about a marked sentence produces: one stored
 * finding per sentence, so an author who spends four sentences on one point
 * comes back as four back-to-back flags for a single moment. One question per
 * passage means one verdict per passage — and the neighbouring sentences that
 * used to be labelled "context" are now part of what is being judged, which is
 * also what a human reviewer would do.
 *
 * WHAT IT DELIBERATELY DOES NOT CONTAIN, per briefcase's prompt-hygiene ruling:
 * no incorrect examples and no ban lists. Both verdicts are defined POSITIVELY
 * — what earns "flag", what earns "skip" — rather than illustrated with a wrong
 * answer the model might copy.
 */
export function buildVerificationPrompt(
  passage: readonly string[],
  categoryName: string,
  proposition: string,
): string {
  return `Passage from a book.

${passage.join('\n')}

CLAIM (${categoryName}): ${proposition}

Question: anywhere in this passage, is the author asserting or promoting that claim as their own position?
Answer "flag" if the author asserts it, endorses it, or repeats it approvingly as true.
Answer "skip" if the author is reporting that other people make that claim, quoting it neutrally, asking about it, arguing against it, or if the passage does not make that claim at all.

Then give the reason in one or two sentences: what the author says in this passage, and why that is or is not asserting the claim. Name the author's own words where they settle it.

Respond with JSON only: {"verdict":"flag" or "skip","reason":"..."}`;
}

/** One verdict and the verifier's account of it. */
export interface Verification {
  verdict: 'flag' | 'skip';
  /** The verifier's one or two sentences. Empty where the answer carried none. */
  reason: string;
}

/**
 * The verdict and reason in an answer, or null where there is no verdict —
 * briefcase's `parseVerification`.
 *
 * Regex first, then the substring XOR. The schema makes the JSON reliable, so
 * the first branch is what always fires, and the reason comes from parsing the
 * object it sits in; the second exists because a model whose template inlines
 * its reasoning can wrap the object in prose, and an answer that says "flag"
 * and nothing else is not worth throwing away over punctuation. The XOR is the
 * whole safety of that branch: text containing BOTH words has not answered
 * anything. In that branch the prose IS the reason, as briefcase reads it.
 *
 * NULL IS A REAL ANSWER AND THE CALLER NEVER TREATS IT AS A FLAG. An
 * unreadable answer must not be able to accuse anybody.
 */
export function parseVerification(text: string): Verification | null {
  if (!text) return null;
  const json = /"verdict"\s*:\s*"(flag|skip)"/i.exec(text);
  if (json) {
    let reason = '';
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { reason?: unknown };
      if (typeof parsed.reason === 'string') reason = parsed.reason.trim();
    } catch {
      const quoted = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(text);
      if (quoted) reason = quoted[1]!.replace(/\\"/g, '"').trim();
    }
    return { verdict: json[1]!.toLowerCase() as 'flag' | 'skip', reason };
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const hasFlag = lower.includes('flag');
  const hasSkip = lower.includes('skip');
  const prose = trimmed.length > 12 ? trimmed : '';
  if (hasFlag && !hasSkip) return { verdict: 'flag', reason: prose };
  if (hasSkip && !hasFlag) return { verdict: 'skip', reason: prose };
  return null;
}

/** What one call produced: a verification, or the reason there is not one. */
export interface VerdictOutcome {
  verification: Verification | null;
  /** Set only where `verification` is null — the sentence the run reports. */
  degraded?: string;
}

/** The answer text of one constrained call, or the reason there is not one. */
export interface ConstrainedAnswer {
  /** The model's answer, still unparsed. Null where the call produced none. */
  text: string | null;
  /** Set only where `text` is null — the sentence the run reports. */
  degraded?: string;
}

/**
 * Ask the server one closed question and hand back what it said.
 *
 * The transport half of `askVerdict`, standing on its own so that asking a
 * closed question and deciding what the answer MEANS stay separate. It parses
 * the ENVELOPE and nothing else, because the same string is read differently
 * depending on what was asked — and because the trap below must have exactly one
 * copy.
 *
 * ── THREE DIALECTS, ONE QUESTION ────────────────────────────────────────────
 *
 * The question is identical on every door — same prompt string, same schema
 * object, same temperature 0, same token ceiling — and so is the CONSTRAINT:
 * Ollama's `format` on `/api/generate`, the OpenAI door's `response_format:
 * {type:"json_schema"}` on a chat turn, and Anthropic's single forced TOOL whose
 * `input_schema` is that same schema object are three spellings of one
 * grammar-constrained decode, which is why this can be a transport branch rather
 * than a second way of asking. The third is the least obvious of the three and
 * is argued where it is written (`constrainedToolBody`, translate/anthropic.ts):
 * nothing is executed and nothing is handed back to the model — `tool_choice`
 * naming the tool is simply that API's way of saying "your next output is an
 * object of this shape". Its answer arrives as the tool call's `input`, and the
 * dialect re-serialises it, so what reaches `parseVerification` below is the same
 * string whichever door produced it.
 *
 * WHAT DOES NOT CROSS IS `num_ctx`. It is a request option on Ollama, where
 * `stageNumCtx`'s whole argument applies — one size per stage, because that
 * server reloads the runner on a change. The OpenAI door's window was fixed when
 * its model was made resident, so the number is simply not sent there and
 * `capFor` clamps the ANSWER against what the server said it can hold, which is
 * the part that still matters. A provider publishes no window at all, so
 * neither the size nor the clamp applies there and the token ceiling goes out
 * as it was measured.
 *
 * AND THE DEGRADATION VOCABULARY IS SHARED. A transport failure, a non-200 and
 * an answer that is not the door's documented shape all come back as
 * degradations rather than throwing, on this function's own rule: ONE bad call
 * must not end a stage that is making hundreds of tiny ones. The truncation is
 * read from two different fields and reported as one sentence.
 *
 * ── THE THINKING-MODEL TRAP, AND IT IS NOT OPTIONAL ─────────────────────────
 *
 * MEASURED IN BRIEFCASE, on Ollama, with qwen3.8:27b: when a JSON grammar is
 * sent to a THINKING model, it constrains the whole output stream from the first
 * token, so the model never opens an answer channel — the object it emits is
 * classified as reasoning and arrives in `thinking` with `response` EMPTY.
 *
 *   format + think:low  ->  eval_count 29,  response "",  thinking '{"verdict": ...}'
 *   think:low alone     ->  eval_count 261, response '{"verdict": ...}'
 *
 * The constrained call is both more accurate and about five times cheaper, so
 * it is worth keeping — which means reading `thinking` when a format WAS
 * requested and `response` came back empty. This is deliberately narrow: with a
 * non-empty `response`, `thinking` is never read, because then it really is
 * reasoning prose. A JSON SCHEMA constrains harder than `'json'` does, so this
 * matters more here, not less. Skip the port and the stage returns zero
 * verdicts against a perfectly healthy server. The port lives beside the body
 * that provokes it (`readGenerateAnswer`, translate/ollama.ts); the OpenAI door
 * has its own answer to the same problem in `withoutThinking`.
 */
export async function askConstrained(
  transport: Transport,
  server: ModelServer,
  prompt: string,
  numCtx: number,
  schema: Record<string, unknown>,
  predictTokens: number,
): Promise<ConstrainedAnswer> {
  const answer = server.kind === 'ollama'
    ? await readGenerateAnswer(
      transport, server.endpoint, server.model, prompt, numCtx, schema, predictTokens,
    )
    : server.kind === 'anthropic'
      ? await readMessageAnswer(
        transport,
        server.endpoint,
        constrainedToolBody(server.model, prompt, schema, predictTokens),
      )
      : await readChatAnswer(
        transport,
        server.endpoint,
        constrainedChatBody(
          server.model, prompt, schema, predictTokens, server.maxModelLen, server.defaults,
        ),
      );
  if (answer.truncated === true) {
    return {
      text: null,
      degraded: `the answer hit the ${predictTokens}-token ceiling, so it was cut off`,
    };
  }
  if (answer.text === null) return { text: null, degraded: answer.degraded ?? 'no answer' };
  return { text: answer.text };
}

/**
 * Ask the server for one verdict.
 *
 * The envelope, the schema and the thinking-model trap are `askConstrained`'s;
 * what is left here is the READING — and its one rule, which is the reason a
 * degradation is never allowed to be an accusation: a null verification is
 * never a flag, and it is not stored, so the next run asks again. A stage where
 * EVERY call degraded is the caller's problem and it refuses.
 */
export async function askVerdict(
  transport: Transport,
  server: ModelServer,
  prompt: string,
  numCtx: number,
): Promise<VerdictOutcome> {
  const answer = await askConstrained(
    transport, server, prompt, numCtx, VERDICT_SCHEMA, VERDICT_PREDICT_TOKENS,
  );
  if (answer.text === null) return { verification: null, degraded: answer.degraded ?? 'no answer' };
  const verification = parseVerification(answer.text);
  if (verification === null) {
    return {
      verification: null,
      degraded: `no verdict in the answer: ${answer.text.trim().slice(0, 120) || '(empty)'}`,
    };
  }
  return { verification };
}

/**
 * One finding, in sentence-index terms — what the report turns into rows.
 *
 * ONE PER WINDOW, when a window can have several flagged categories. The
 * complaint the window machinery exists to answer was over-splitting: four
 * back-to-back flags for one moment. Emitting one finding per flagged category
 * on the same passage is that complaint in a different costume — three markers
 * stacked on the same paragraph. So the finding carries the strongest flagged
 * category and names the others in `also`, each with the verifier's reason;
 * nothing is lost, because all of it reaches the panel.
 */
export interface WindowFinding {
  /** The highest-scoring category the verifier FLAGGED. */
  category: string;
  /** Why the verifier flagged it. */
  reason: string;
  /** The other flagged categories, strongest first... */
  also: string[];
  /** ...and the verifier's reason for each, in the same order. */
  alsoReasons: string[];
  /**
   * The primary category's own score — its best evidence in the window, the
   * ranker's s_c (spans.ts). Not the window's noisy-OR, which saturates at
   * 1.0000 for any window with two strong categories. It orders nothing any
   * more; it is recorded so a reader can see how hot the ranker ran here.
   */
  score: number;
  /** Inclusive sentence-index span the finding covers. */
  from: number;
  to: number;
}

/** A flagged category of a window, with the verifier's reason. */
export interface FlaggedCategory {
  category: WindowCategory;
  reason: string;
}

/**
 * Turn one window's FLAGGED categories into its finding, or null where the
 * verifier flagged none — a window it rejected entirely is not a finding.
 *
 * THE SPAN IS MEASURED, never a fixed window: it runs from the first to the
 * last sentence that fired a FLAGGED category, and the finding is that span
 * read verbatim. Sentences that fired only a category the verifier rejected do
 * not stretch it, and the surrounding context the model was shown is not part
 * of it — a person clicking a finding lands on the words that earned it.
 */
export function windowFinding(flagged: readonly FlaggedCategory[]): WindowFinding | null {
  if (flagged.length === 0) return null;
  const ranked = [...flagged].sort((a, b) => b.category.score - a.category.score);
  const primary = ranked[0]!;
  const fired = ranked.flatMap((one) => one.category.sentenceIndices);
  return {
    category: primary.category.category,
    reason: primary.reason,
    also: ranked.slice(1).map((one) => one.category.category),
    alsoReasons: ranked.slice(1).map((one) => one.reason),
    score: primary.category.score,
    from: Math.min(...fired),
    to: Math.max(...fired),
  };
}
