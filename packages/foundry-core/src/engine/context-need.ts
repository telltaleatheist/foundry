/**
 * context-need — how much context a run's largest request needs, said before
 * any model is loaded.
 *
 * Owen, 2026-11-11, after a Simplify failed because Crucible started the 27B at
 * a context its own sums got wrong: *"maybe we can request the context we'll
 * need from crucible before it loads the model"*, and, asked whether a fixed
 * figure per kind of work would do, he chose to measure each book first.
 *
 * Crucible takes the figure as `contextTokens` on a queue session, and from
 * 2.0.39 loads the model at exactly that context (Owen, 2026-11-12: "we don't
 * need 16k if the paragraphs are all small"). So the figure is the context the
 * run cannot do without, and it is measured with the run's own planning: a stage
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
import { CONTEXT_NEED_PREFIX } from '../shared/context-need.js';

// The counting and the line's prefix are shared with the queue and with apps
// that count their own prompts (src/shared/context-need.ts).
export { CONTEXT_NEED_PREFIX, requestNeed } from '../shared/context-need.js';

/** The name a measuring run plans under in place of a model it never asked a server for. */
export const MEASURING_MODEL = '(measuring)';

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
