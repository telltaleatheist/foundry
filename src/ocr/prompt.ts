/**
 * The ocr stage's trained-against prompt — moved VERBATIM from BookForgeApp
 * `tools/galley/build-dataset.py` (the SYSTEM constant), which is where the
 * training data was built. `tools/crosscheck-ocr-prompt.mjs` compares this
 * string byte-for-byte against that file on the machine that has both repos;
 * its last run is recorded in `test/ocr/CROSSCHECK.md`.
 *
 * Why a near-miss is worse than an error: a prompt that differs from the
 * trained one by a word does not fail, it makes the model quietly worse, and
 * the natural (wrong, expensive) conclusion is "the model needs more training
 * data". So this string is load-bearing down to its line breaks, including the
 * two-space continuation indents inside the rules — they were present in every
 * training row.
 *
 * The hyphen rule is the single most load-bearing sentence: the model sees ONE
 * line and cannot know a line-final hyphen is a wrap. Without the rule it
 * "fixes" the hyphen and corrupts the join that the export stage performs
 * later (hyphenation is a JOIN, never a completion — src/ocr/edits.ts header).
 */
export const OCR_SYSTEM_PROMPT: string = [
  'You correct OCR errors in a single line of text from a scanned book.',
  '',
  'Reply with the corrected line and nothing else.',
  '',
  'Rules:',
  '- Reply with the whole line, not just the part you changed.',
  '- Correct only what the scanner misread. Do not reword, translate, modernise',
  '  spelling, or change punctuation that is merely old-fashioned.',
  '- Keep a hyphen at the end of the line exactly as it is. The word finishes on',
  '  the next line, which you cannot see.',
  '- If the line has no OCR errors, reply with it unchanged.',
].join('\n');

/**
 * Qwen3's chat template with thinking DISABLED, built by hand — the same
 * construction as `toRawPrompt()` in src/boxes/encoder.ts and `qwen3_prompt()`
 * in BookForgeApp tools/galley/eval-line.py, which is the harness every score
 * was measured on.
 *
 * The empty `<think>\n\n</think>` block is the point: training ran with
 * enable_thinking=False, which inserts it. A stock template stops at
 * `<|im_start|>assistant\n` and feeds the model a shape it never saw.
 */
export function toOcrRawPrompt(line: string): string {
  return `<|im_start|>system\n${OCR_SYSTEM_PROMPT}<|im_end|>\n`
    + `<|im_start|>user\n${line}<|im_end|>\n`
    + `<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

export const OCR_STOP = '<|im_end|>';

/**
 * The model's raw completion, reduced to the line it answered with — exactly
 * `raw.strip().split('\n')[0].strip()` from eval-line.py `_one()`. Every
 * measured number went through this reduction, so the runtime must too.
 */
export function extractOcrAnswer(raw: string): string {
  return raw.trim().split('\n')[0]?.trim() ?? '';
}
