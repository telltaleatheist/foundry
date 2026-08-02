/**
 * exclude — one filter, two granularities.
 *
 * PIPELINE.md: `--exclude <category>` from the CLI and an explicit block-id
 * list from BookForge's per-box deletion COMPOSE. A block is dropped if its
 * category is excluded OR its id is listed, and one implementation serves both
 * consumers — because the pdf-picker interaction (delete boxes, re-export,
 * instant reflow) and the CLI flag are the same operation seen from two ends.
 *
 * Separately, and NOT part of the request, some categories are never emitted at
 * all: running heads, running feet and `discard`. They are page furniture and
 * non-content by definition; there is no book in which narrating them is
 * correct. They are recorded in `exclusions.json` under their own key anyway,
 * so "why is my running head missing" is answerable from the artifact rather
 * than from the source.
 *
 * Bad input throws. An unknown category and an unknown block id are both real
 * mistakes with real consequences — a typo'd `--exclude captoins` that silently
 * did nothing would produce a book full of captions and a user who believes
 * they excluded them.
 */
import type { Block, ExclusionsArtifact } from '../pipeline/artifacts.js';
import type { BoxesCategory } from '../boxes/encoder.js';
import { BOXES_CATEGORIES_V6 } from '../boxes/encoder.js';

/**
 * Categories the exporter structurally never emits.
 *
 * PIPELINE.md names them: "running heads/footers/page furniture and `discard`
 * never emitted".
 */
export const NEVER_EMITTED: ReadonlySet<BoxesCategory> =
  new Set<BoxesCategory>(['header', 'footer', 'discard']);

export interface ExclusionRequest {
  /** Category names. The plural forms PIPELINE.md writes are accepted too. */
  readonly categories?: readonly string[];
  readonly blockIds?: readonly string[];
}

export class ExclusionError extends Error {
  constructor(message: string) {
    super(`exclusions: ${message}`);
    this.name = 'ExclusionError';
  }
}

const LEGAL = new Set<string>(BOXES_CATEGORIES_V6);

/**
 * Resolve one `--exclude` argument to a category name.
 *
 * PIPELINE.md's worked example is `--exclude footnotes --exclude captions`,
 * while the taxonomy's names are singular (`footnote`, `caption`). Rather than
 * pick one and make the documented invocation fail, both spellings resolve —
 * the plural is a documented alias, not a fuzzy match. Anything else throws
 * with the legal list, so a typo is a stop rather than a silent no-op.
 */
export function resolveCategory(name: string): BoxesCategory {
  const trimmed = name.trim().toLowerCase();
  if (LEGAL.has(trimmed)) return trimmed as BoxesCategory;
  const singular = trimmed.endsWith('s') ? trimmed.slice(0, -1) : null;
  if (singular && LEGAL.has(singular)) return singular as BoxesCategory;
  throw new ExclusionError(
    `"${name}" is not a category. Legal categories are: ${BOXES_CATEGORIES_V6.join(', ')}`,
  );
}

export interface ExclusionResult {
  /** The blocks that survived, in their original order. */
  kept: Block[];
  /** The record written to `export/exclusions.json`. */
  record: Omit<ExclusionsArtifact, 'formatVersion'>;
}

/**
 * Drop the excluded blocks and record exactly what was dropped.
 *
 * A block excluded by BOTH its category and its id counts against the category:
 * `droppedById` is what the id list removed that the category list would not
 * have, which is the number that tells a user whether their per-box deletions
 * are doing anything.
 */
export function applyExclusions(
  blocks: readonly Block[],
  request: ExclusionRequest = {},
): ExclusionResult {
  const categories = (request.categories ?? []).map(resolveCategory);
  const excluded = new Set<BoxesCategory>(categories);
  const ids = new Set<string>(request.blockIds ?? []);

  const present = new Set(blocks.map(b => b.id));
  const unknown = [...ids].filter(id => !present.has(id));
  if (unknown.length > 0) {
    throw new ExclusionError(
      `${unknown.length} excluded block id(s) are not in boxes/blocks.json: ${unknown.slice(0, 10).join(', ')}`
      + `${unknown.length > 10 ? ', …' : ''}.`
      + ' The id list was written against a different run of the boxes stage; re-export from the'
      + ' blocks that are actually there rather than dropping ids that no longer exist.',
    );
  }

  const droppedByCategory: Record<string, number> = {};
  const droppedByNeverEmitted: Record<string, number> = {};
  let droppedById = 0;
  const kept: Block[] = [];

  for (const b of blocks) {
    if (NEVER_EMITTED.has(b.category)) {
      droppedByNeverEmitted[b.category] = (droppedByNeverEmitted[b.category] ?? 0) + 1;
      continue;
    }
    if (excluded.has(b.category)) {
      droppedByCategory[b.category] = (droppedByCategory[b.category] ?? 0) + 1;
      continue;
    }
    if (ids.has(b.id)) {
      droppedById++;
      continue;
    }
    kept.push(b);
  }

  return {
    kept,
    record: {
      excludedCategories: categories,
      excludedBlockIds: [...ids],
      neverEmittedCategories: [...NEVER_EMITTED],
      droppedByCategory,
      droppedByNeverEmitted,
      droppedById,
      totalBlocks: blocks.length,
      keptBlocks: kept.length,
    },
  };
}
