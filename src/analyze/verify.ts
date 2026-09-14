/**
 * analyze/verify — the one question the ranker cannot answer.
 *
 * ── WHAT THIS STAGE IS FOR ──────────────────────────────────────────────────
 *
 * An entailment model cannot tell STANCE apart. "These people are vermin" and
 * "he called them vermin, which is monstrous" score identically on the same
 * hypothesis, because both passages are about the same proposition — one
 * asserts it and the other reports it, and nothing in the score says which.
 * That is the stage that keeps a history of propaganda from being flagged as
 * propaganda, and nothing upstream can do it.
 *
 * So every (window, category) the ranker kept gets exactly one question asked
 * about the whole passage: is the AUTHOR asserting this claim as their own
 * position, or reporting, quoting, questioning or arguing against it? The
 * answer is a verdict and nothing else. **There is no generated explanation and
 * no severity** — the flagged passage IS the finding, and inventing a rationale
 * would be fabrication (docs/ANALYSIS.md §1).
 *
 * ── EVERY VERDICT IS STORED, INCLUDING THE SKIPS ────────────────────────────
 *
 * briefcase discarded a "skip" — it was re-running anyway, so a rejected
 * candidate cost nothing to lose. Foundry captures once at the widest net and
 * filters at display time, and the loosest tier SHOWS the rejections, ghosted
 * and labelled as the verifier's own. A person hunting for "almost everything"
 * is owed the net's whole contents, told honestly which fish the verifier threw
 * back. So a skip is a stored answer here, not a discarded one.
 *
 * ── THE EMPHASIS LADDER IS DELIBERATELY NOT PORTED ──────────────────────────
 *
 * briefcase's prompt carried a `VERIFICATION_EMPHASIS` line that leaned the
 * verdict harder toward "flag" at higher sensitivities. It existed to make ONE
 * RE-RUN's verdicts looser, and Foundry does not re-run: verdicts are stored
 * once and sliced afterwards. The prompt below is briefcase's level 2 — the
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
import { constrainedChatBody, readChatAnswer } from '../translate/vllm.js';
import type { FlagWindow, WindowCategory } from './rank.js';

/**
 * The schema the constrained decode carries. Two tokens, one of two values.
 * See this file's header for the measurement that makes it mandatory.
 */
export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['flag', 'skip'] },
  },
  required: ['verdict'],
  additionalProperties: false,
};

/**
 * How much answer one verdict may generate.
 *
 * A SMALL FIXED CONSTANT, and explicitly NOT translate's `answerBudget`, which
 * sizes generation from the SOURCE — a 600-character passage would buy a
 * verdict nearly a thousand tokens to ramble in, on a question whose answer is
 * `{"verdict":"flag"}`. briefcase measured the constrained decode at 27-30
 * output tokens end to end; 128 is four times that, which is headroom rather
 * than an expectation, and it is the same floor `answerBudget` uses for a
 * one-word block. An answer that somehow hits it is reported as a degradation
 * and counted, never guessed at.
 */
const VERDICT_PREDICT_TOKENS = 128;

/**
 * Verify ONE (window, category) pair.
 *
 * briefcase's `buildFlagVerificationPrompt` at sensitivity 2, with "speaker"
 * rewritten to "author" throughout and its opening line changed from
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

Respond with JSON only: {"verdict":"flag"} or {"verdict":"skip"}`;
}

/**
 * The verdict in an answer, or null where there is none.
 *
 * Regex first, then the substring XOR. The schema makes the JSON reliable, so
 * the first branch is what always fires; the second exists because a model
 * whose template inlines its reasoning can wrap the object in prose, and an
 * answer that says "flag" and nothing else is not worth throwing away over
 * punctuation. The XOR is the whole safety of that branch: text containing BOTH
 * words has not answered anything.
 *
 * NULL IS A REAL ANSWER AND THE CALLER TREATS IT AS A SKIP PLUS A WARNING,
 * NEVER AS A FLAG. An unreadable answer must not be able to accuse anybody.
 */
export function parseVerdict(text: string): 'flag' | 'skip' | null {
  if (!text) return null;
  const json = /"verdict"\s*:\s*"(flag|skip)"/i.exec(text);
  if (json) return json[1]!.toLowerCase() as 'flag' | 'skip';

  const lower = text.trim().toLowerCase();
  const hasFlag = lower.includes('flag');
  const hasSkip = lower.includes('skip');
  if (hasFlag && !hasSkip) return 'flag';
  if (hasSkip && !hasFlag) return 'skip';
  return null;
}

/** What one call produced: a verdict, or the reason there is not one. */
export interface VerdictOutcome {
  verdict: 'flag' | 'skip' | null;
  /** Set only where `verdict` is null — the sentence the run reports. */
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
 * ── THE THINKING-MODEL TRAP, AND IT IS NOT OPTIONAL ─────────────────────────
 *
 * MEASURED IN BRIEFCASE (under Ollama, before this engine had one door) with
 * qwen3.8:27b: when a JSON grammar is sent
 * to a THINKING model, it constrains the whole output stream from the first
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
 * verdicts against a perfectly healthy server.
 *
 * A transport failure, a non-200 and an answer that is not the door's documented
 * shape all come back as degradations rather than throwing, because ONE bad
 * call must not end a stage that is making hundreds of tiny ones.
 *
 * THE CONSTRAINT IS `response_format: {type:"json_schema"}` — the same
 * grammar-constrained decode the measurement above was taken under, in the one
 * spelling this engine's door speaks (translate/vllm.ts). No window is sent:
 * the server's is fixed when the model is made resident, and `capFor` clamps
 * the ANSWER against what the server said it can hold, which is the part that
 * still matters.
 */
export async function askConstrained(
  transport: Transport,
  server: ModelServer,
  prompt: string,
  schema: Record<string, unknown>,
  predictTokens: number,
): Promise<ConstrainedAnswer> {
  const answer = await readChatAnswer(
    transport,
    server.endpoint,
    constrainedChatBody(server.model, prompt, schema, predictTokens, server.maxModelLen),
  );
  if (answer.text === null) return { text: null, degraded: answer.degraded ?? 'no answer' };
  if (answer.truncated === true) {
    return {
      text: null,
      degraded: `the answer hit the ${predictTokens}-token ceiling, so it was cut off`,
    };
  }
  return { text: answer.text };
}

/**
 * Ask the server for one verdict.
 *
 * The envelope, the schema and the thinking-model trap are `askConstrained`'s;
 * what is left here is the READING — and its one rule, which is the reason a
 * degradation is never allowed to be an accusation: a null verdict is recorded
 * by the caller as a skip plus a warning. A stage where EVERY call degraded is
 * the caller's problem and it refuses.
 */
export async function askVerdict(
  transport: Transport,
  server: ModelServer,
  prompt: string,
): Promise<VerdictOutcome> {
  const answer = await askConstrained(transport, server, prompt, VERDICT_SCHEMA, VERDICT_PREDICT_TOKENS);
  if (answer.text === null) return { verdict: null, degraded: answer.degraded ?? 'no answer' };
  const verdict = parseVerdict(answer.text);
  if (verdict === null) {
    return {
      verdict: null,
      degraded: `no verdict in the answer: ${answer.text.trim().slice(0, 120) || '(empty)'}`,
    };
  }
  return { verdict };
}

/**
 * One finding, in sentence-index terms — what the report turns into rows.
 *
 * ONE PER WINDOW, when a window can have several flagged categories. The
 * complaint the window machinery exists to answer was over-splitting: four
 * back-to-back flags for one moment. Emitting one finding per flagged category
 * on the same passage is that complaint in a different costume — three markers
 * stacked on the same paragraph. So the finding carries the strongest flagged
 * category and names the others in `also`; nothing is lost, because both reach
 * the panel.
 */
export interface WindowFinding {
  /**
   * The primary: the highest-scoring category the verifier FLAGGED, or the
   * highest-scoring category outright where it flagged none.
   */
  category: string;
  /** The other flagged categories, strongest first. Empty on a skip. */
  also: string[];
  /**
   * The primary category's own best score — NOT the window's noisy-OR.
   *
   * This is the number the app's display tiers slice on (strict 0.9, moderate
   * 0.7, loose everything), and those numbers ARE briefcase's calibrated
   * per-category ladder, so the thing they are compared against has to be a
   * per-category score. The noisy-OR is a different quantity with a different
   * meaning — it saturates at 1.0000 for any window with two strong categories
   * — and its one job is ordering the verification queue.
   */
  score: number;
  /** What the verifier said about the window as a whole. */
  verdict: 'flag' | 'skip';
  /** Inclusive sentence-index span the finding covers. */
  from: number;
  to: number;
}

/**
 * Turn one window's verdicts into its finding.
 *
 * THE SPAN IS MEASURED, never a fixed window: it runs from the first to the
 * last sentence that fired a FLAGGED category, and the finding is that span
 * read verbatim. Sentences that fired only a category the verifier rejected do
 * not stretch it, and the surrounding context the model was shown is not part
 * of it — a person clicking a finding lands on the words that earned it.
 *
 * A WINDOW THE VERIFIER FLAGGED NOTHING IN still becomes a row, because the
 * loosest display tier shows the rejections. There is no flagged category to
 * measure the span from, so it is measured from every category that fired: the
 * ghost covers what the ranker actually caught, which is what a person looking
 * at the loose tier is asking to see.
 */
export function windowFinding(window: FlagWindow, flagged: readonly WindowCategory[]): WindowFinding {
  const ranked = [...(flagged.length > 0 ? flagged : window.categories)].sort((a, b) => b.score - a.score);
  const primary = ranked[0]!;
  const fired = ranked.flatMap((c) => c.sentenceIndices);
  return {
    category: primary.category,
    also: flagged.length > 0 ? ranked.slice(1).map((c) => c.category) : [],
    score: primary.score,
    verdict: flagged.length > 0 ? 'flag' : 'skip',
    from: Math.min(...fired),
    to: Math.max(...fired),
  };
}
