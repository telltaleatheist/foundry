/**
 * context-need — how much context a run's largest request needs, said before
 * any model is loaded.
 *
 * Owen, 2026-11-11, after a Simplify failed because Crucible started the 27B at
 * a context its own sums got wrong: *"maybe we can request the context we'll
 * need from crucible before it loads the model"*, and, asked whether a fixed
 * figure per kind of work would do, he chose to measure each book first.
 *
 * Crucible 2.0.38 takes the figure as `contextTokens` on a queue session: the
 * model starts at its default, or at this when it is more, or at the most the
 * card affords below that, but never under it. So the figure is a FLOOR the run
 * cannot do without, and it is measured with the run's own planning: a stage
 * given `--measure-context` reads the book, plans its requests exactly as a
 * real run would, prints the largest one's need on stdout and exits without
 * opening a server.
 *
 * ONE ARITHMETIC. A request's need is its prompt plus the answer room it asks
 * for, counted the way `capFor` (translate/vllm.ts) counts against a server's
 * window: the same pessimistic characters-to-tokens rate and slack. A need
 * counted any other way would be a floor that disagrees with the check the run
 * makes against the window it was given.
 */
import { promptTokens } from './translate/vllm.js';

/**
 * The line a measuring run prints, so the queue can find it among anything else on stdout.
 * The queue reads it with `readContextNeed` (src/node/context-need.ts, a separate build that
 * cannot import this one); test/context-need.test.ts holds the two spellings together.
 */
export const CONTEXT_NEED_PREFIX = 'FOUNDRY_CONTEXT_NEED ';

/** The name a measuring run plans under in place of a model it never asked a server for. */
export const MEASURING_MODEL = '(measuring)';

/** One request's need: its prompt, counted as `capFor` counts it, plus the answer room it asks for. */
export function requestNeed(system: string, user: string, answerTokens: number): number {
  return promptTokens(system, user) + answerTokens;
}

/**
 * Say the run's need, on stdout, as the one line the queue reads. NULL is a run
 * that would ask no model anything (a cleanup the rules finish alone), said out
 * loud so that a missing line can only mean a run that broke.
 */
export function printContextNeed(contextTokens: number | null): void {
  if (contextTokens !== null && (!Number.isInteger(contextTokens) || contextTokens < 1)) {
    throw new Error(`a measured context need must be a positive whole number of tokens, not ${contextTokens}`);
  }
  process.stdout.write(`${CONTEXT_NEED_PREFIX}${JSON.stringify({ contextTokens })}\n`);
}
