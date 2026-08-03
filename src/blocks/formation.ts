/**
 * formation — the name of the segmentation a run's blocks were formed under.
 *
 * ARCHITECTURE §5's cardinal rule is that a different segmentation is a
 * different input distribution: the models were trained against one definition
 * of "a block", and serving them another reads as a bad model rather than a bad
 * pipeline. The marker exists so a prediction can be identified later — which
 * grouping saw these pages, and therefore which corpus it is comparable to.
 *
 * It is COMPOSED from the rules that actually ran, in the order they run:
 *
 *   gap-v0          the vertical-gap / column-change cut in `formBlocks`
 *   para-split-v1   the paragraph-start splitter (`paragraphs/splitter.ts`)
 *   display-run-v1  the display-heading rejoin (`blocks/display-run-merge.ts`)
 *
 * Composed rather than typed out, so a rule that versions itself cannot leave a
 * stale marker behind: change `PARAGRAPH_SPLIT_RULE.version` and every artifact
 * written afterwards says so, at the one place that decides.
 *
 * `blocks/blocks.json` carries the result in `formation`. Before Aug 3 2026 it
 * carried nothing: the string existed but was only logged, so the claim in the
 * comments that a prediction "is recorded in the artifact" was not true of any
 * file on disk. That is why the blocks artifact is at format version 2.
 */
import { DISPLAY_RUN_RULE } from './display-run-merge.js';
import { PARAGRAPH_SPLIT_RULE } from '../paragraphs/splitter.js';

/** The line→block cut this repo has always had: gap, or no horizontal overlap. */
export const GAP_RULE_VERSION = 'gap-v0';

/** What this build writes into `blocks/blocks.json` as `formation`. */
export const BLOCK_FORMATION =
  `${GAP_RULE_VERSION}+${PARAGRAPH_SPLIT_RULE.version}+${DISPLAY_RUN_RULE.version}`;

/** What every build before the paragraph splitter wrote — and never recorded. */
export const BLOCK_FORMATION_BEFORE_PARAGRAPH_SPLIT =
  `${GAP_RULE_VERSION}+${DISPLAY_RUN_RULE.version}`;
