/**
 * clean/blocks — WHICH BLOCKS A CLEANUP IS ABOUT, and the text it sees of each.
 *
 * Two commands read a book for the same pass and have to agree about it to the
 * character: `clean-text`, which cleans, and `clean-triage`, which decides
 * beforehand which blocks need cleaning at all (src/clean/triage.ts). A triage
 * verdict is only worth anything if the block it judged is the block the
 * cleaner would have asked about, in the text the cleaner would have shown —
 * so both build their blocks HERE, from `bookRowPlan`, and both read a block's
 * stage-1 text through `stageOneUnits` rather than each computing its own.
 *
 * Lifted out of run.ts unchanged (2026-09-23): what a block is, how a table is
 * taken apart into cells, and why the spine is not in it are argued there and
 * still are.
 */
import * as path from 'node:path';

import { bookRowPlan } from '../translate/bookrows.js';
import type { BookBlock } from '../translate/bookrows.js';
import type { BookFile } from '../vlm/book-file.js';
import type { TableGrid } from '../translate/tablecells.js';

import { punctuateBlocks } from './punctuate.js';
import type { PunctuationStageRecord } from './punctuate.js';
import { markerSegments } from './segments.js';
import { cleanSentences } from './sentences.js';
import type { NarrationNumberTarget } from './targets.js';

/**
 * One block of the book, as everything downstream sees it.
 *
 * `parts` is the RECORD's position and `target` is the pass's own target; they
 * are carried together because a table's cells are several targets under one
 * position and nothing else would be able to put them back.
 */
export interface Block {
  target: NarrationNumberTarget;
  /** `b12-3`, or `chapter:<division id>`. */
  parts: string;
  /** A cell's index in its grid, for a table. Absent everywhere else. */
  cell?: number;
}

/** A table row, held open until every one of its cells has a verdict. */
export interface PendingTable {
  parts: string;
  where: string;
  grid: TableGrid;
  cells: number[];
  words: Map<number, string>;
  /** The whole grid's source text — what the key is computed over. */
  source: string;
}

export interface CleanBlocks {
  blocks: Block[];
  tables: PendingTable[];
  plan: ReturnType<typeof bookRowPlan>;
}

/**
 * The blocks of `book` a cleanup is about — exactly the rows a translation
 * would touch, a table as its cells, and not the spine (run.ts argues all
 * three).
 */
export function cleanBlocks(book: BookFile, where: string): CleanBlocks {
  const plan = bookRowPlan(book, where);
  const blocks: Block[] = [];
  const tables: PendingTable[] = [];
  const fileName = path.basename(where);

  const targetOf = (key: string, block: BookBlock): NarrationNumberTarget => ({
    key,
    kind: 'row',
    file: fileName,
    tag: '',
    statedCategory: block.category.toLowerCase(),
    text: block.text,
    segments: markerSegments(block.text),
    // A book file row carries no styling and no `white-space` declaration, so
    // nothing here can say the spaces are the author's. `targets.ts` names what
    // that costs.
    preformatted: false,
  });

  for (const group of plan.groups) {
    if (group.kind === 'table' && group.grid !== undefined) {
      const row = group.parts[0]!;
      const table: PendingTable = {
        parts: row.id,
        where: `${where} block ${row.id} (Table, page ${row.page})`,
        grid: group.grid,
        cells: group.parts.map((part) => part.cell!),
        words: new Map(),
        source: row.text,
      };
      tables.push(table);
      for (const part of group.parts) {
        // A CELL IS ITS OWN TARGET AND THE GRID IS NEVER SHOWN TO A MODEL —
        // run.ts carries the argument.
        blocks.push({
          target: targetOf(`${row.id}#c${part.cell!}`, part),
          parts: row.id,
          cell: part.cell!,
        });
      }
      continue;
    }
    for (const part of group.parts) {
      blocks.push({ target: targetOf(part.id, part), parts: part.id });
    }
  }
  return { blocks, tables, plan };
}

/**
 * ONE POSITION OF THE BOOK AS A TRIAGE SEES IT — a row, or a whole table.
 *
 * A table's cells are asked of the cleaning model one by one, but its RECORD is
 * the whole grid (run.ts, "half a grid is not one"), so it is cleaned or kept
 * whole and it is judged whole: its cells' stage-1 text, joined in grid order.
 */
export interface StageOneUnit {
  parts: string;
  /** The stage-1 (punctuated) text a triage is shown and its verdict is bound to. */
  text: string;
  /** The block's category as the book states it, lower case — null where it states none. */
  category: string | null;
}

/**
 * The stage-1 text of every position among `blocks`, in the plan's order.
 *
 * `punctuated` is `punctuateBlocks` over (at least) these blocks' targets. It
 * is PER BLOCK — `punctuateTarget` reads one target and nothing else — so the
 * text of a block is the same whichever run computed it, which is what lets a
 * verdict written by `clean-triage` be checked by `clean-text` against its own
 * punctuation.
 */
export function stageOneUnits(
  blocks: readonly Block[],
  punctuated: ReadonlyMap<string, string>,
): StageOneUnit[] {
  const units: StageOneUnit[] = [];
  const byParts = new Map<string, StageOneUnit>();
  for (const block of blocks) {
    const text = punctuated.get(block.target.key);
    if (text === undefined) {
      throw new Error(`stageOneUnits: no stage-1 text for ${block.target.key}`);
    }
    const open = byParts.get(block.parts);
    if (open !== undefined && block.cell !== undefined) {
      open.text = `${open.text}${CELL_JOIN}${text}`;
      continue;
    }
    const unit = { parts: block.parts, text, category: block.target.statedCategory };
    byParts.set(block.parts, unit);
    units.push(unit);
  }
  return units;
}

/** How a table's cells are joined for a triage to read — never shown to the cleaner. */
const CELL_JOIN = ' | ';

/** `punctuateBlocks` over every block, for a caller that needs every position's stage-1 text. */
export function punctuateAll(blocks: readonly Block[]): {
  text: Map<string, string>;
  record: PunctuationStageRecord;
} {
  return punctuateBlocks(blocks.map((b) => b.target));
}

/**
 * WHAT ONE QUESTION IS ABOUT — a sentence (the default since 2026-09-24) or a
 * whole block. `block` is kept so a run can flip back (Owen: *"we'll test it. if
 * it isnt right, we can flip back"*). src/clean/sentences.ts carries the why.
 */
export type CleanUnit = 'sentence' | 'block';
export const DEFAULT_CLEAN_UNIT: CleanUnit = 'sentence';
export const CLEAN_UNITS: readonly CleanUnit[] = ['sentence', 'block'];

/** A sentence's position: its block's key, then `#s<index>`. */
export function sentenceKey(blockKey: string, index: number): string {
  return `${blockKey}#s${index}`;
}

/**
 * The units a triage judges, in the plan's order.
 *
 * `block` is `stageOneUnits` exactly. `sentence` splits every block that is not
 * a table into its sentences (`cleanSentences`), each its own position
 * `<parts>#s<i>` bound to its own stage-1 text; a TABLE is still judged whole,
 * because its cells are asked whole and a grid is never half asked.
 */
export function triageUnits(
  blocks: readonly Block[],
  punctuated: ReadonlyMap<string, string>,
  unit: CleanUnit,
): StageOneUnit[] {
  const whole = stageOneUnits(blocks, punctuated);
  if (unit === 'block') return whole;
  const tables = new Set(blocks.filter((b) => b.cell !== undefined).map((b) => b.parts));
  const out: StageOneUnit[] = [];
  for (const one of whole) {
    if (tables.has(one.parts)) { out.push(one); continue; }
    cleanSentences(one.text).forEach((sentence, i) => {
      out.push({ parts: sentenceKey(one.parts, i), text: sentence.text, category: one.category });
    });
  }
  return out;
}
