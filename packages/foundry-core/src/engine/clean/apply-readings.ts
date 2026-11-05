/**
 * clean/apply-readings — A READINGS-ONLY PASS: the readings a host decided,
 * written into a book, and nothing else (2026-11-01).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * A cleanup is handed a file of fixed readings (`fixed-readings.ts`) and writes
 * them into the blocks it cleans, protecting every one from its own sentence
 * pass. That made the readings reachable only through a cleanup: a book nobody
 * wanted cleaned could not have them at all, and nothing showed what they had
 * changed. The host asked for the readings to be a step of their own — applied,
 * seen in the history, undone by going back to the step above — and cleaned, or
 * not, afterwards.
 *
 * So this is the cleanup's book route with every stage that asks or judges taken
 * out: no punctuation spec, no number rules, no removal, no triage, no model, no
 * server. Each block's text is read with `applyFixedReadings` exactly as a
 * cleanup's stage one reads it, and filed in the same RECORDS file, with the same
 * STAMP, so the step lands, compiles and draws in the tree as a cleanup does
 * (`CleanRequest.readingsOnly`, app/shared/types.ts).
 *
 * ── THE APPLIED RECORD ───────────────────────────────────────────────────────
 *
 * Beside the records it writes `<records>.applied.json` (`appliedReadingsPathFor`):
 * every reading that landed, the block it is in, which occurrence it was in the
 * book it was made from (`nthBefore`), and which whole-token run of the written
 * text it now is in the block this pass wrote (`nthAfter`). A later cleanup made
 * from this step can be handed `{ find: replace, replace, at, nth: nthAfter }` as a
 * KEPT spot, which `fixed-readings.ts` protects from its sentence pass. That is
 * the host's to compose; this pass only says where things are.
 *
 * ── RE-RUNNING IT ────────────────────────────────────────────────────────────
 *
 * Every block is written every run, keyed by its text and the readings that apply
 * to it (`readingsOnlyKey`). A re-run with fewer readings — a word taken back out —
 * writes the blocks that word touched back as the book printed them and leaves
 * every other row alone, because their key did not move.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { ensureDir } from '../fsdirs.js';
import { stripBom } from '../bom.js';
import { readBookFile } from '../translate/bookrows.js';
import { TranslationRecords } from '../translate/records.js';
import { spliceTableGrid } from '../translate/tablecells.js';
import { cleanBlocks } from './blocks.js';
import { blockDigest, bookPositionTexts } from './digest.js';
import {
  applyFixedReadings, fixedKeyField, wholeTokenOffsets, type FixedReading,
} from './fixed-readings.js';
import { CleanTextError } from './punctuate.js';
import { narrationTextStamp, type NarrationTextStamp } from './stamp.js';

export const APPLIED_READINGS_FORMAT = 'applied-readings/v1';

/** The model a readings-only pass's stamp names: none asked, and it says so. */
export const READINGS_ONLY_MODEL = 'readings-only';

const KEY_FORMAT = 'clean-readings/v1';

/** One reading that landed. */
export interface AppliedReading {
  /** The block's target key (a table cell's `<row>#c<n>`). */
  at: string;
  /** Which whole-token run of `find` it was in the block it was made from; null for a book-wide reading. */
  nthBefore: number | null;
  find: string;
  /** What was written in its place, exactly as it stands in the output (a kept spot: `find` itself). */
  replace: string;
  /** Which whole-token run of `replace` it now is in the written block; null when `replace` stands as no run. */
  nthAfter: number | null;
}

export interface AppliedReadingsFile {
  format: typeof APPLIED_READINGS_FORMAT;
  /** The step this pass was made from, when the caller said; null otherwise. */
  from: string | null;
  applied: AppliedReading[];
}

/** `<book>.clean.….records.jsonl` → `<…>.applied.json`, beside it. */
export function appliedReadingsPathFor(recordsPath: string): string {
  return `${path.resolve(recordsPath).replace(/\.jsonl$/i, '')}.applied.json`;
}

/** A block's question in a readings-only pass: its text and the readings that apply to it. */
export function readingsOnlyKey(request: { text: string; fixed: readonly FixedReading[]; at: string }): string {
  return createHash('sha256')
    .update([KEY_FORMAT, request.text, fixedKeyField(request.text, request.fixed, request.at)].join('\u0000'), 'utf8')
    .digest('hex');
}

export interface ApplyReadingsOptions {
  bookPath: string;
  recordsPath: string;
  stampPath: string;
  fixedReadings: readonly FixedReading[];
  generation?: string;
  /** The step the book was made from, written into the applied record. */
  from?: string | null;
  log: (message: string) => void;
}

export interface ApplyReadingsOutcome {
  blocks: number;
  /** Blocks whose text a reading changed. */
  changed: number;
  /** Rows appended to the records file. */
  written: number;
  /** Readings that landed (read or kept). */
  applied: number;
  /** Spots whose occurrence was not where they said. */
  missed: number;
  appliedPath: string;
  stamp: NarrationTextStamp;
}

export async function runApplyReadings(opts: ApplyReadingsOptions): Promise<ApplyReadingsOutcome> {
  const at = new Date().toISOString();
  if (opts.fixedReadings.length === 0) {
    throw new CleanTextError(
      'clean-text --readings-only was handed no readings, so it would write a copy of the book and '
      + 'call it a step. Name a --fixed-readings file that holds at least one reading.',
    );
  }
  const where = path.resolve(opts.bookPath);
  let bookText: string;
  try {
    bookText = stripBom(fs.readFileSync(where, 'utf8'));
  } catch (err) {
    throw new CleanTextError(`--book ${where} cannot be read (${(err as Error).message}).`);
  }
  const book = readBookFile(bookText, where);
  const { blocks, tables } = cleanBlocks(book, where);
  if (blocks.length === 0) {
    throw new CleanTextError(`--book ${where} has no block with words in it, so there is nothing to write readings into.`);
  }

  const recordsPath = path.resolve(opts.recordsPath);
  const records = TranslationRecords.open(recordsPath);
  const known = new Set(blocks.map((b) => b.parts));
  if (records.positions > 0 && ![...records.positionMap().keys()].some((parts) => known.has(parts))) {
    throw new CleanTextError(
      `--records ${recordsPath} holds ${records.size} row(s), and not one of them names a block of --book ${where}. `
      + 'That file was written about a different book. Name the records file for THIS book, or a path that does not exist yet.',
    );
  }

  const fixed = opts.fixedReadings;
  const applied: AppliedReading[] = [];
  let changed = 0;
  let written = 0;
  let missed = 0;

  const append = (parts: string, key: string, text: string): void => {
    const newest = records.rowFor(parts);
    if (newest !== undefined && newest.text === text && newest.key === key) return;
    // A row a person wrote over this exact question stands.
    if (newest?.author === 'user' && records.questionFor(parts) === key) return;
    records.append({ key, parts, ...(opts.generation === undefined ? {} : { generation: opts.generation }), text });
    written += 1;
  };

  /** Read one block's (or cell's) text, and record where each reading landed. */
  const read = (key: string, text: string): string => {
    const one = applyFixedReadings(text, fixed, key);
    for (const spot of one.missed) {
      missed += 1;
      opts.log(`clean-text: a reading for "${spot.find}" #${spot.nth} in ${spot.at} found no such occurrence (the block changed since it was decided); left as printed.`);
    }
    for (const place of one.placed) {
      const landed = one.text.slice(place.at, place.end);
      const runs = landed.length === 0 ? [] : wholeTokenOffsets(one.text, landed);
      const nthAfter = runs.indexOf(place.at);
      applied.push({
        at: key,
        nthBefore: place.reading.nth ?? null,
        find: place.reading.find,
        replace: landed,
        nthAfter: nthAfter < 0 ? null : nthAfter,
      });
    }
    return one.text;
  };

  const tableByParts = new Map(tables.map((table) => [table.parts, table] as const));
  const doneTables = new Set<string>();
  for (const block of blocks) {
    if (block.cell === undefined) {
      const text = read(block.target.key, block.target.text);
      if (text !== block.target.text) changed += 1;
      append(block.parts, readingsOnlyKey({ text: block.target.text, fixed, at: block.target.key }), text);
      continue;
    }
    if (doneTables.has(block.parts)) continue;
    doneTables.add(block.parts);
    const table = tableByParts.get(block.parts)!;
    for (const cell of table.cells) {
      const cellBlock = blocks.find((b) => b.parts === table.parts && b.cell === cell)!;
      table.words.set(cell, read(cellBlock.target.key, cellBlock.target.text));
    }
    const spliced = spliceTableGrid(table.grid, table.words);
    if ('complaint' in spliced) {
      opts.log(`clean-text: LEFT AS PRINTED — ${table.where}: ${spliced.complaint}`);
      continue;
    }
    if (spliced.text !== table.source) changed += 1;
    append(table.parts, readingsOnlyKey({ text: table.source, fixed, at: table.parts }), spliced.text);
  }

  const appliedPath = appliedReadingsPathFor(recordsPath);
  const file: AppliedReadingsFile = { format: APPLIED_READINGS_FORMAT, from: opts.from ?? null, applied };
  ensureDir(path.dirname(appliedPath));
  fs.writeFileSync(appliedPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  const sourceTexts = bookPositionTexts(book);
  const digests = new Map<string, string>();
  for (const parts of new Set(blocks.map((b) => b.parts))) {
    const text = records.rowFor(parts)?.text ?? sourceTexts.get(parts);
    if (text === undefined) {
      throw new CleanTextError(`clean-text wrote readings into ${parts} of ${where} and can find no text at that position to stand behind the stamp.`);
    }
    digests.set(parts, blockDigest(text));
  }
  const stamp = narrationTextStamp({ model: READINGS_ONLY_MODEL, at, punctuationRefused: 0, blocks: digests });
  ensureDir(path.dirname(path.resolve(opts.stampPath)));
  fs.writeFileSync(path.resolve(opts.stampPath), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');

  opts.log(
    `clean-text: readings only — ${fixed.length} reading(s) handed in, ${applied.length} landed across `
    + `${changed} of ${blocks.length} block(s), ${missed} not found; ${written} row(s) written. `
    + `Where each one landed: ${appliedPath}`,
  );
  return { blocks: blocks.length, changed, written, applied: applied.length, missed, appliedPath, stamp };
}
