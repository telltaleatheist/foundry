/**
 * context-need, the arithmetic both builds share: how many tokens of context a
 * request needs, and the line a measuring run prints it on.
 *
 * Owen, 2026-11-11/12: a run requests the context it needs before its model
 * loads, measured every time, in Foundry and BookForge alike. The engine
 * measures its own stages (src/engine/context-need.ts); the queue reads what
 * they print (src/node/context-need.ts); and an app that builds its prompts in
 * its own process (BookForge's pronunciation guide and EPUB cleanup) counts
 * them here, so that one count serves every caller.
 *
 * ONE ARITHMETIC. A request's need is its prompt plus the answer room it asks
 * for, counted the way `capFor` (src/engine/translate/vllm.ts) counts against a
 * server's window: a deliberately PESSIMISTIC 2.5 characters to a token, plus a
 * fixed slack. Guessing high only asks for a little more context than the run
 * uses; guessing low is a request the model cannot hold.
 *
 * No imports, so the engine bundle, the CommonJS library and the ESM library
 * can all take it as it is.
 */

const CHARS_PER_TOKEN = 2.5;
const PROMPT_SLACK_TOKENS = 256;

/** The line a measuring run prints its need on, so the queue can find it among anything else on stdout. */
export const CONTEXT_NEED_PREFIX = 'FOUNDRY_CONTEXT_NEED ';

/** The pessimistic token estimate of a prompt (system plus user message), as `capFor` sizes against. */
export function promptTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / CHARS_PER_TOKEN) + PROMPT_SLACK_TOKENS;
}

/** One request's need: its prompt, counted as `promptTokens` counts it, plus the answer room it asks for. */
export function requestNeed(system: string, user: string, answerTokens: number): number {
  return promptTokens(system, user) + answerTokens;
}
