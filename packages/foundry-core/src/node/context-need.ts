/**
 * context-need — the queue's half: reading the floor a measuring run printed.
 *
 * The engine's half (src/engine/context-need.ts) prints one line on stdout,
 * `FOUNDRY_CONTEXT_NEED {"contextTokens":N}`. This is a separate build that
 * cannot import the engine, so the prefix is spelled twice, and
 * test/engine/context-need.test.ts fails the day the two spellings differ.
 */

export const CONTEXT_NEED_PREFIX = 'FOUNDRY_CONTEXT_NEED ';

/**
 * What a measuring run printed: `{ contextTokens: N }`, `{ contextTokens: null }`
 * for a run that would ask no model anything, or null when no line of the output
 * is one — which only a run that broke produces. A line that starts with the
 * prefix and does not parse is a defect of this pair of functions, and throws.
 */
export function readContextNeed(output: string): { contextTokens: number | null } | null {
  let found: { contextTokens: number | null } | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(CONTEXT_NEED_PREFIX)) continue;
    const parsed: unknown = JSON.parse(line.slice(CONTEXT_NEED_PREFIX.length));
    const value = (parsed as { contextTokens?: unknown }).contextTokens;
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
      throw new Error(`a measuring run printed "${line}", which is not a context need`);
    }
    found = { contextTokens: value };
  }
  return found;
}
