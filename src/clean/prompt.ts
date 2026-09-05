/**
 * clean/prompt — the instruction the model is given, assembled the one way.
 *
 * TWO FILES, JOINED BY A BLANK LINE, IN THIS ORDER. That is BookForge's
 * `loadNarrationTextPrompt` exactly: the number prompt first, the wider
 * instruction after it. The number prompt is the artifact the orpheus-finetune
 * side vendors and drift-checks — it is what the corpora were normalized under
 * — and the wider file is what turns the number pass into the narration text
 * pass by naming the classes that print no digit at all: abbreviations,
 * all-caps runs, bracketed apparatus, spaced hyphens, roman numerals.
 *
 * THE ORDER AND THE SEPARATOR ARE PART OF THE ARTIFACT. `test-prompt-examples`
 * on the BookForge side, and its port under test/clean/, parse BOTH files for
 * worked examples and run every one through the validator that would judge it —
 * so what the prompt ASKS FOR and what the validator ACCEPTS are proved to be
 * the same thing. That proof is about these bytes in this arrangement, and a
 * second way of joining them would be a prompt nothing has checked.
 *
 * EMBEDDED, NOT READ. `{ type: 'text' }` makes the bundler inline both files
 * into the compiled binary — `src/vlm/bridge.ts`'s precedent for `vlm_page.py`,
 * and for its reason: foundry ships one file, so a prompt loaded from a path
 * beside the module is a prompt that exists in the checkout and nowhere else.
 * It also removes an entire class of failure the vendored code had to guard
 * against, where a build that forgot to copy `electron/prompts` into `dist`
 * produced a pass that ran and read nothing.
 */
import NARRATION_TEXT_PROMPT from './prompts/tts-narration-text.txt' with { type: 'text' };
import NUMBER_NORMALIZE_PROMPT from './prompts/tts-number-normalize.txt' with { type: 'text' };

/** The whole instruction, exactly as `loadNarrationTextPrompt` assembles it. */
export function narrationTextPrompt(): string {
  return `${NUMBER_NORMALIZE_PROMPT.trim()}\n\n${NARRATION_TEXT_PROMPT.trim()}`;
}

/** The number half alone — what the training side vendors, for its own keeper. */
export function numberNormalizePrompt(): string {
  return NUMBER_NORMALIZE_PROMPT.trim();
}

/** The wider half alone, same reason. */
export function narrationClassesPrompt(): string {
  return NARRATION_TEXT_PROMPT.trim();
}
