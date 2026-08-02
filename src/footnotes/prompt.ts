/**
 * The footnotes model's prompt — a trained-against artifact, moved verbatim from
 * BookForgeApp `electron/dagger-footnotes.ts` (MIGRATION §3). Only the constant
 * was renamed.
 *
 * The prompt has to arrive VERBATIM, in the Qwen3 template with thinking
 * disabled — the empty `<think>\n\n</think>` block a stock template omits. That
 * template lives in `src/blocks/encoder.ts` (`toRawPrompt`) and is imported, not
 * re-typed: a near-miss here would read as a bad model rather than a bad wire
 * hop, which is the single hardest failure in this area to diagnose.
 * See ARCHITECTURE §4.
 */
import { BLOCKS_STOP } from '../blocks/encoder.js';

/**
 * The training system prompt, byte for byte. Changing a word here changes the
 * task the model believes it was given; if the prompt ever has to change, the
 * model has to be retrained and its id's version bumped.
 */
export const FOOTNOTES_SYSTEM_PROMPT =
  'Find inline footnote reference markers. Output one line per marker: the marker with '
  + "its left anchor, then ' → ', then the anchor without it. Output 'none' if there are none.";

/**
 * What the model emits at the end of an answer; the server must stop here.
 *
 * The same token as blocks, and deliberately the same constant rather than a
 * second copy of the string: both fine-tunes were trained under one chat
 * template, so one of these drifting from the other is a wire bug that presents
 * as a model bug.
 */
export const FOOTNOTES_STOP = BLOCKS_STOP;
