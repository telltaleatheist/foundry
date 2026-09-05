/**
 * clean/run — the third text act, over the same machinery as the other two.
 *
 * ── WHAT THIS COMMAND IS ────────────────────────────────────────────────────
 *
 * Owen, 2026-09-05: the narration text pass moves into the engine, the act is
 * called **Clean text**, and it stands beside `translate` and `simplify` as one
 * of three things a person does to the words of a book. All three read a BOOK
 * FILE, ask a local model about the blocks of it, and write RECORDS — one JSONL
 * row per block, keyed by the question, positioned by the block's own id. The
 * app materialises a derived book from those records with the parent's ids kept
 * verbatim (docs/RENDERER.md §4), so the source and the cleaned edition are two
 * files that agree about what every paragraph is called.
 *
 * The pass itself is BookForge's and is vendored, not rewritten: three stages
 * over every block, in an order that is load-bearing, and docs/CLEAN-TEXT.md is
 * the doctrine that governs all of it. What lives HERE is the part that could
 * only ever have been the engine's — which blocks, from where, keyed how, and
 * written into what.
 *
 * ── ONE: EXACTLY THE BLOCKS A TRANSLATION WOULD TOUCH ───────────────────────
 *
 * `bookRowPlan` + `bookTitlePlan` (src/translate/bookrows.ts), unchanged and
 * imported rather than re-derived. Not "every row of the file": that plan is
 * where a shelved row is not in the book, a `Formula` and a `Picture` are
 * skipped and counted, a `Table` is taken apart into cells and put back by
 * splicing rather than by asking a model to preserve a grid, a folio is carried
 * without being asked about, and a chapter title is asked for only where it
 * cannot be PROVED to be a copy of a heading the run already handled.
 *
 * Every one of those decisions is argued at length in that file and every one of
 * them is as true of a cleanup as of a translation. Sharing the plan is what
 * makes the two acts commutable: a book that has been cleaned and then
 * translated has had the same population of blocks through both, so a record
 * from either names a position the other one also knows.
 *
 * IT IS ALSO WHERE THIS DIVERGES FROM BOOKFORGE, DELIBERATELY. That pass runs
 * `selectNumberTargets`, which drops a CAPTION and a FOOTNOTE — and its reason
 * is stated: the narration cut has already removed them from the file the pass
 * is handed, and *"this pass must not make a caption speakable that the cut
 * would have removed"*. There is no cut here. `clean-text` produces records
 * about a BOOK, not a narration copy, and a caption and a footnote are blocks
 * of the book that `translate` transforms like any other. So the plan decides,
 * the selector is not consulted, and what a narration copy contains stays the
 * cut's decision, made later, by whoever makes it.
 *
 * ── TWO: THE KEY, WHICH IS WHY A RE-RUN COSTS NOTHING ───────────────────────
 *
 * `cleanKey` hashes the block's own source text, the model, `NORMALIZER_VERSION`
 * and `PUNCTUATION_SPEC_VERSION`. A key already in the records file is never
 * asked of a model again — `records.ts` is the cost cache and this is the
 * question it caches. What follows from those four fields is the whole
 * behaviour a person would want and none they would not:
 *
 *  - editing one paragraph re-cleans that paragraph and nothing else;
 *  - changing `--model` re-cleans everything, because every answer would have
 *    been a different model's;
 *  - a bump to either version re-cleans everything, which is correct and is the
 *    reason those two are in the key rather than merely in the stamp: a book
 *    cleaned at `n5` was cleaned by rules this build no longer runs;
 *  - a paragraph that appears twice in a book is asked once and gets two rows,
 *    because materialization looks up by POSITION and a position with no row
 *    keeps its source text.
 *
 * ── THREE: A ROW IS APPENDED, NEVER OVERWRITTEN ─────────────────────────────
 *
 * `appendRecord` is `run.ts`'s rule verbatim, for its reasons: a row that says
 * nothing new is not written, so re-running over an unchanged book writes
 * nothing at all; and a position whose newest row a PERSON wrote is left
 * exactly as they left it, unless the source text under it has since changed —
 * in which case the machine's row goes on top and the run says so out loud, and
 * the correction is still in the file above it, because this format appends.
 *
 * ── FOUR: THE STAMP IS ABOUT A FILE AND THE RECORDS ARE ABOUT A BOOK ────────
 *
 * `--stamp` is written every run, even one that changed not a single character,
 * because the stamp is what unlocks the render: a book that merely printed no
 * curly quote and no digit has still HAD the pass, and a gate that could not
 * tell that apart from a book that never ran it would ask for the model time
 * again. src/clean/stamp.ts carries the rest of that argument.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { ensureDir } from '../fsdirs.js';
import { stripBom } from '../bom.js';
import { bookRowPlan, bookTitlePlan, readBookFile } from '../translate/bookrows.js';
import type { BookBlock } from '../translate/bookrows.js';
import { chapterPosition, TranslationRecords } from '../translate/records.js';
import { spliceTableGrid, type TableGrid } from '../translate/tablecells.js';
import { DEFAULT_OLLAMA_ENDPOINT, DEFAULT_TRANSLATE_MODEL } from '../translate/run.js';
import type { Transport } from '../translate/ollama.js';

import { blockDigest, bookPositionTexts } from './digest.js';
import { narrationTextPrompt } from './prompt.js';
import { applySpans, CleanTextError, punctuateBlocks, segmentsAfter } from './punctuate.js';
import type { PunctuationStageRecord } from './punctuate.js';
import { openOllamaRunner } from './runner.js';
import { markerCharacters, markerSegments } from './segments.js';
import { narrationTextStamp, type NarrationTextStamp } from './stamp.js';
import type { NarrationNumberTarget } from './targets.js';
import {
  askAboutEach, classifyEdit, EVERY_CLASS, NORMALIZER_VERSION,
} from './tts-number-normalizer.js';
import type {
  NumberEditRecord, NumberNormalizerRunner, NumberUnitRecord,
} from './tts-number-normalizer.js';
import { PUNCTUATION_SPEC_VERSION } from './tts-punctuation.js';

export { CleanTextError };

/**
 * What the key is a hash OF, spelled into the hash itself.
 *
 * `bank.ts`'s `KEY_FORMATS` rule, for its reason: a key that does not say what
 * kind of question it is could be matched by a different question that happened
 * to hash the same fields, and the first symptom would be a paragraph answered
 * with somebody else's answer. It also means a records file that holds both a
 * translation's rows and a cleanup's rows can never confuse them.
 */
const KEY_FORMAT = 'clean/dialect/v1';

/** Fields are NUL-joined so no field's content can spell another's boundary. */
const NUL = String.fromCharCode(0);

/**
 * The question this run is asking about one block.
 *
 * FOUR FIELDS AND NOT ONE MORE. The endpoint is not in it — the same model at
 * two URLs is the same question, and putting the URL in would re-buy a whole
 * book for moving the server. Nor is the block's POSITION: two paragraphs with
 * identical words are one question and two rows, which is the arrangement
 * `records.ts` exists to hold.
 */
export function cleanKey(request: {
  text: string;
  model: string;
}): string {
  const fields = [
    KEY_FORMAT,
    request.model.trim(),
    NORMALIZER_VERSION,
    PUNCTUATION_SPEC_VERSION,
    request.text,
  ];
  return createHash('sha256').update(fields.join(NUL), 'utf8').digest('hex');
}

/** Where a cleanup's full receipt lands, beside the records it explains. */
export function receiptPath(recordsPath: string): string {
  return `${path.resolve(recordsPath)}.receipt.json`;
}

/**
 * The frozen record of what this run did, written beside the records file.
 *
 * BookForge's `NarrationTextReceipt`, with the two EPUB-only fields dropped and
 * the book file's own identity in their place. It exists for the reason that
 * one does: everything a reviewer needs to judge the pass WITHOUT re-running
 * it — which punctuation rule fired how often, every span the punctuation stage
 * could not reach, every edit the model proposed and the verdict the validator
 * gave it. A pass whose only output is cleaner text is a pass nobody can audit.
 */
export interface CleanTextReceipt {
  normalizerVersion: string;
  punctuationSpec: string;
  model: string;
  at: string;
  /** The book file this pass read. */
  source: string;
  punctuation: PunctuationStageRecord;
  /** Every block that was asked about, with every proposed edit and its status. */
  units: NumberUnitRecord[];
  /** Disposition name → how many times the validator gave it. */
  dispositions: Record<string, number>;
  /** Edit class → how many were applied. */
  appliedByClass: Record<string, number>;
  /** How many blocks reached the model at all. */
  unitsAsked: number;
  /** How many of those came back with an answer nothing could parse. */
  unitsParseFailed: number;
}

export interface CleanTextOptions {
  bookPath: string;
  recordsPath: string;
  stampPath: string;
  /** Default `DEFAULT_OLLAMA_ENDPOINT`. */
  endpoint?: string;
  /** Default `DEFAULT_TRANSLATE_MODEL` — Owen's standard for every task. */
  model?: string;
  /** Leave the weights loaded when the run ends. */
  keepModel?: boolean;
  /**
   * The app's binding of this records file to the reading it was made from,
   * written into every row and NEVER INTERPRETED here — `translate --generation`
   * verbatim, because it is the same field of the same format.
   *
   * It is not optional in practice and it was missing: the app's shared argv
   * builder appends `--generation <reading generation>` to every text pass, so a
   * hosted Clean text press against 1.1.0 died on `unknown option --generation`
   * before a block was read. Sharing `records.ts` and not sharing the field that
   * binds a records file to its reading is sharing half a format.
   */
  generation?: string;
  /** Injected so the tests drive the whole pass with no server and no GPU. */
  transport?: Transport;
  /** Injected so a test can settle every block without a transport at all. */
  runner?: NumberNormalizerRunner;
  /** Progress and diagnostics. Line-buffered, on stderr, by the caller. */
  log: (message: string) => void;
}

export interface CleanTextOutcome {
  /** How many blocks the plan covered. */
  blocks: number;
  /** How many came out different from what the book printed. */
  changed: number;
  /** Punctuation spans plus model edits the validators would not accept. */
  refused: number;
  /** How many blocks were answered out of the records file, costing nothing. */
  reused: number;
  /** Rows appended. Zero is the correct answer for a re-run over a clean book. */
  written: number;
  stamp: NarrationTextStamp;
  receipt: CleanTextReceipt;
}

/**
 * One block of the book, as everything downstream sees it.
 *
 * `parts` is the RECORD's position and `target` is the pass's own target; they
 * are carried together because a table's cells are several targets under one
 * position and nothing else in this file would be able to put them back.
 */
interface Block {
  target: NarrationNumberTarget;
  /** `b12-3`, or `chapter:<division id>`. */
  parts: string;
  /** A cell's index in its grid, for a table. Absent everywhere else. */
  cell?: number;
}

/** A table row, held open until every one of its cells has a verdict. */
interface PendingTable {
  parts: string;
  where: string;
  grid: TableGrid;
  cells: number[];
  words: Map<number, string>;
  /** The whole grid's source text — what the key is computed over. */
  source: string;
}

/**
 * Read the book, or say exactly what about it is not one.
 *
 * `readBookFile`'s own refusal, re-worded for this command, because its message
 * says "translate" and a person running `clean-text` needs to be told about the
 * command they typed.
 */
function openBook(bookPath: string): { text: string; where: string } {
  const where = path.resolve(bookPath);
  let text: string;
  try {
    text = stripBom(fs.readFileSync(where, 'utf8'));
  } catch (err) {
    throw new CleanTextError(
      `--book ${where} cannot be read (${(err as Error).message}). It is the book file the app `
      + 'materialises for a step (docs/BOOK-FILE.md) — one JSON object per line, the header first.',
    );
  }
  return { text, where };
}

/**
 * Refuse a records file that is about a DIFFERENT BOOK.
 *
 * A records file names its positions and nothing else, so the only thing that
 * can be asked of it is whether it answers for anything this book has. A file
 * with rows in it, not ONE of whose positions is a row or a division of this
 * book, is somebody else's file: `--records` was pointed at a translation of
 * another edition, or at the wrong step's output. Appending to it would put this
 * book's cleaned paragraphs into a file the app will read against a book that
 * has no such blocks — reported as stale, correctly, for every position, with
 * nothing anywhere saying why.
 *
 * The test is EXISTENCE, not coverage. A partial file is the normal state of a
 * resumed run, a file that only holds chapter titles is what a titles-only pass
 * left, and a book somebody has edited will have positions in the file that the
 * book no longer has. One position in common is enough to prove the file is
 * about this book; zero, with rows present, cannot be an accident.
 */
function refuseForeignRecords(
  records: TranslationRecords,
  known: ReadonlySet<string>,
  recordsPath: string,
  bookPath: string,
): void {
  if (records.positions === 0) return;
  for (const parts of records.positionMap().keys()) {
    if (known.has(parts)) return;
  }
  throw new CleanTextError(
    `--records ${recordsPath} holds ${records.size} row(s) covering ${records.positions} `
    + `position(s), and not one of them names a block of --book ${bookPath}. That file was `
    + 'written about a different book. Appending to it would file this book\'s cleaned paragraphs '
    + 'under positions nothing in the other book answers to, and every one of them would be read '
    + 'as stale with nothing to say why. Name the records file for THIS book, or a path that does '
    + 'not exist yet.',
  );
}

/**
 * The runner for a run that has no question — every one of its methods is a
 * defect if it is ever called.
 *
 * `askAboutEach` returns before touching a runner when nothing reaches the
 * model, so this stands in for a server that was never opened. It THROWS rather
 * than returning an empty answer, because a silent stub would turn "the loop
 * asked a question this run had decided not to ask" into a book full of
 * unchanged blocks nobody could account for.
 */
const NOTHING_TO_ASK: NumberNormalizerRunner = {
  model: '(no model — every block was already answered)',
  generate(): Promise<string> {
    throw new CleanTextError(
      'clean-text opened no model because every block of this book was already answered in the '
      + 'records file, and then something asked one anyway. Nothing was written.',
    );
  },
  async release(): Promise<void> { /* nothing was ever loaded. */ },
};

/** Every disposition that means the validators would not let an edit through. */
function isRefusal(status: string): boolean {
  return status !== 'APPLIED' && status !== 'APPLIED_RULE'
    && status !== 'SCRIPTURE_PROTECTED' && status !== 'NOOP';
}

/**
 * Clean the words of a book, and write the records, the receipt and the stamp.
 *
 * The stages run in the doctrine's order over every block — punctuation, then
 * the number rules, then the model on EVERY block, whatever it prints, because
 * an abbreviation and an acronym are invisible to a digit test (Owen,
 * 2026-09-04: *"send every single block through to be sure"*). What that costs
 * is accepted here for the reason the doctrine gives: the pass runs ONCE and the
 * book keeps the result.
 */
export async function runCleanText(opts: CleanTextOptions): Promise<CleanTextOutcome> {
  const started = Date.now();
  const at = new Date().toISOString();
  const model = opts.model ?? DEFAULT_TRANSLATE_MODEL;
  const endpoint = opts.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;

  const { text: bookText, where } = openBook(opts.bookPath);
  const book = readBookFile(bookText, where);

  // ── The plan: exactly the blocks a translation would touch ────────────────
  const plan = bookRowPlan(book, where);
  for (const [category, count] of plan.skipped) {
    opts.log(`clean-text: ${count} ${category} row(s) skipped — they have no words to clean`);
  }
  for (const one of plan.notes) opts.log(`clean-text: ${one}`);
  for (const one of plan.kept) {
    opts.log(`clean-text: LEFT AS PRINTED — ${one}`);
  }

  const blocks: Block[] = [];
  const tables: PendingTable[] = [];
  const fileName = path.basename(where);

  const targetOf = (key: string, block: BookBlock, kind: 'row' | 'chapter'): NarrationNumberTarget => ({
    key,
    kind,
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
        /*
         * A CELL IS ITS OWN TARGET AND THE GRID IS NEVER SHOWN TO A MODEL.
         *
         * `bookrows.ts` makes the whole argument one act over: a Table row's
         * text is the vision model's own HTML, and handing that to a model with
         * "do not touch any of it" is how a table's columns quietly swap. The
         * cells are separable, they travel as plain strings, and the answers go
         * back into the source string's OWN ranges — so the tags, the
         * attributes and the cell order are untouched by construction rather
         * than by asking nicely. Every cell wears a key of its own here because
         * the pass needs one per target; the RECORD is written once, against the
         * row, when the last cell has settled.
         */
        blocks.push({
          target: targetOf(`${row.id}#c${part.cell!}`, part, 'row'),
          parts: row.id,
          cell: part.cell!,
        });
      }
      continue;
    }
    for (const part of group.parts) {
      blocks.push({ target: targetOf(part.id, part, 'row'), parts: part.id });
    }
  }

  /*
   * AND THE SPINE, WHICH IS NOT MADE OF ROWS. `bookTitlePlan` is deliberately
   * short — most titles are a provable copy of a heading this run has already
   * cleaned, and asking about one would be asking a question twice and shipping
   * two answers to it. What is left is a division somebody renamed and a part
   * divider whose label the page classifier composed out of two blocks: neither
   * can be proved to be a copy of anything, and before this both carried into
   * the cleaned book exactly as printed.
   */
  for (const title of bookTitlePlan(book)) {
    const parts = chapterPosition(title.id);
    blocks.push({
      target: targetOf(parts, {
        id: parts, category: 'Title', text: title.title, page: 0,
      }, 'chapter'),
      parts,
    });
  }

  if (blocks.length === 0) {
    throw new CleanTextError(
      `--book ${where} has no block with words in it, so there is nothing to clean. A book file `
      + 'whose every row is shelved, skipped or blank is not a book this pass can act on.',
    );
  }

  // ── The records file, and whether it is about this book ───────────────────
  const recordsPath = path.resolve(opts.recordsPath);
  const records = TranslationRecords.open(recordsPath);
  refuseForeignRecords(records, new Set(blocks.map((b) => b.parts)), recordsPath, where);
  opts.log(records.size === 0
    ? `clean-text: nothing is recorded in ${recordsPath}, so every block is asked of the model and `
      + 'recorded there as it lands.'
    : `clean-text: ${records.size} record(s) covering ${records.positions} position(s) are in `
      + `${recordsPath} — a block whose exact question is in there is not asked again, and every `
      + 'new answer is added to it.');

  /*
   * WHAT IS ALREADY PAID FOR IS NOT ASKED AGAIN — and for a table, the unit of
   * "paid for" is the ROW. A grid whose record is in the file is complete; a
   * grid with three of five cells banked has no record, because a record about
   * a Table row holds the whole grid and half a grid is not one.
   */
  const keyOf = new Map<string, string>();
  for (const block of blocks) keyOf.set(block.target.key, cleanKey({ text: block.target.text, model }));
  const tableKey = new Map<string, string>();
  for (const table of tables) tableKey.set(table.parts, cleanKey({ text: table.source, model }));

  const bankedTable = new Set<string>();
  for (const table of tables) {
    if (records.get(tableKey.get(table.parts)!) !== undefined) bankedTable.add(table.parts);
  }
  const outstanding = blocks.filter((block) => {
    if (block.cell !== undefined) return !bankedTable.has(block.parts);
    return records.get(keyOf.get(block.target.key)!) === undefined;
  });
  const reused = blocks.length - outstanding.length;
  if (reused > 0) {
    opts.log(
      `clean-text: ${reused} of ${blocks.length} block(s) are already answered in the records file `
      + 'at this exact question, and are not asked again.',
    );
  }

  // ── Stage 1 — punctuation, over the blocks this run will actually clean ───
  const punctuated = punctuateBlocks(outstanding.map((b) => b.target));
  for (const refusal of punctuated.record.refused) {
    opts.log(
      `clean-text: REFUSED a punctuation span in ${refusal.key} — "${refusal.find}" would have `
      + `become "${refusal.replace}", and ${refusal.reason}.`,
    );
  }
  opts.log(
    `clean-text: punctuation (${PUNCTUATION_SPEC_VERSION}) rewrote ${punctuated.record.spansApplied} `
    + `span(s) across ${punctuated.record.targetsChanged} block(s); `
    + `${punctuated.record.refused.length} refused.`,
  );

  // ── Stages 2 and 3 — the rules, then the model, on every block ────────────
  //
  // The asks are built over the PUNCTUATED text and its re-derived segments,
  // because that is the string the rules compute offsets into and the string
  // the model is shown. Two writes, never one — punctuate.ts's header carries
  // the argument, and it is the one thing about the order that cannot bend.
  const cleanText = new Map<string, string>();
  for (const block of outstanding) {
    cleanText.set(block.target.key, punctuated.text.get(block.target.key)!);
  }

  const asks = outstanding.map((block, index) => {
    const text = cleanText.get(block.target.key)!;
    return {
      key: block.target.key,
      text,
      segments: segmentsAfter(text),
      /*
       * The neighbours are the blocks either side IN THE PLAN'S OWN ORDER, and
       * they are taken from the outstanding list rather than from the whole
       * book. Context is shown so the model can tell a year from a quantity —
       * "the paragraph before a date is usually digit-free, and that is exactly
       * the paragraph that says whether 1200 is a year" — and a neighbour that
       * was answered on an earlier run is one this run has no cleaned text for,
       * so showing the book's own words for it would show two dialects at once.
       */
      previous: index > 0 ? cleanText.get(outstanding[index - 1]!.target.key)! : null,
      next: index + 1 < outstanding.length
        ? cleanText.get(outstanding[index + 1]!.target.key)!
        : null,
    };
  });

  /*
   * ── A RUN WITH NOTHING TO ASK NEVER TOUCHES THE SERVER ─────────────────────
   *
   * `askAboutEach` already refuses to load a model it has no question for —
   * *"an Ollama that is down must not fail a pass that had nothing to ask it"* —
   * and this is the same rule one layer out. `openOllamaRunner` proves the
   * server is there and holds the model BEFORE any work starts, which is right
   * and is worth the round trip for a run that is about to spend an hour of
   * GPU; asking it of a run whose every block is already banked would make a
   * re-run over a finished book fail because a machine somewhere is off.
   *
   * A CALLER-SUPPLIED RUNNER IS ALWAYS USED, banked or not: a test that passes
   * one is asserting what happens to it, and silently swapping in a stub would
   * make "the model was never called" unprovable.
   */
  const runner = opts.runner ?? (asks.length === 0
    ? NOTHING_TO_ASK
    : await openOllamaRunner({
      model,
      endpoint,
      ...(opts.transport === undefined ? {} : { transport: opts.transport }),
      ...(opts.keepModel === undefined ? {} : { keepModel: opts.keepModel }),
      log: opts.log,
    }));

  const settled = await askAboutEach(
    asks,
    runner,
    narrationTextPrompt(),
    (done, total, label) => {
      /*
       * `clean-text: <done>/<total>`, per block, and BookForge mirrors the
       * shape — so it stays exactly this, and both numbers count blocks
       * FINISHED rather than a position, which is what keeps a progress bar
       * drawn from it monotonic.
       *
       * THE RELEASE TICK IS NOT A BLOCK. `askAboutEach` calls this once more
       * from its `finally`, at `(total, total, 'Releasing model')`, so that a
       * desktop bar reaches its end even on the failure path. Printing it would
       * put `7/7` on the log twice, and a reader counting lines would be told
       * the book had eight blocks in it.
       */
      if (total > 0 && label !== 'Releasing model') opts.log(`clean-text: ${done}/${total}`);
    },
    'every-block',
    EVERY_CLASS,
  );

  // ── The verdicts, applied ─────────────────────────────────────────────────
  const units: NumberUnitRecord[] = [];
  const dispositions: Record<string, number> = {};
  const appliedByClass: Record<string, number> = {};
  let modelRefused = 0;

  for (const block of outstanding) {
    const decision = settled.decisions.get(block.target.key);
    if (decision === undefined) {
      throw new CleanTextError(
        `clean-text reached no decision about ${block.target.key} of ${where}. The loop and the `
        + 'plan disagree about what this book holds, and nothing was written.',
      );
    }
    const before = cleanText.get(block.target.key)!;
    cleanText.set(block.target.key, applySpans(before, decision.accepted, block.target.key));

    for (const record of decision.records) {
      dispositions[record.status] = (dispositions[record.status] ?? 0) + 1;
      if (isRefusal(record.status)) {
        modelRefused += 1;
        sayRefusal(opts.log, block.target.key, record);
        continue;
      }
      if (record.status === 'APPLIED' || record.status === 'APPLIED_RULE') {
        const klass = record.editClass ?? classifyEdit(record.find);
        appliedByClass[klass] = (appliedByClass[klass] ?? 0) + 1;
      }
    }
    units.push({
      key: block.target.key,
      kind: block.target.kind,
      file: fileName,
      status: decision.status,
      text: block.target.text,
      edits: decision.records,
      ...(decision.rawAnswer === undefined ? {} : { rawAnswer: decision.rawAnswer }),
    });
  }

  // ── The rows ──────────────────────────────────────────────────────────────
  let written = 0;
  let humanKept = 0;
  let changed = 0;

  const appendRecord = (parts: string, key: string, text: string): void => {
    const newest = records.rowFor(parts);
    if (newest !== undefined && newest.text === text && newest.key === key) return;
    if (newest?.author === 'user') {
      const asked = records.questionFor(parts);
      if (asked === undefined || asked === key || newest.key === key) {
        humanKept += 1;
        return;
      }
      opts.log(
        `clean-text: ${parts} was corrected by hand and its source text has since changed, so this `
        + 'run\'s answer takes over — the correction is still in the file, above it.',
      );
    }
    records.append({
      key,
      parts,
      ...(opts.generation === undefined ? {} : { generation: opts.generation }),
      text,
    });
    written += 1;
  };

  for (const table of tables) {
    if (bankedTable.has(table.parts)) continue;
    for (const cell of table.cells) {
      table.words.set(cell, cleanText.get(`${table.parts}#c${cell}`)!);
    }
    const spliced = spliceTableGrid(table.grid, table.words);
    if ('complaint' in spliced) {
      /*
       * A GRID THE ANSWERS BROKE IS LEFT AS PRINTED, named, and the run goes on.
       * `translate`'s rule for the same event: the cells are still in the book
       * exactly as the model wrote them, and refusing the whole book over one
       * table would throw away everything else the run paid for.
       */
      opts.log(`clean-text: LEFT AS PRINTED — ${table.where}: ${spliced.complaint}`);
      continue;
    }
    if (spliced.text !== table.source) changed += 1;
    appendRecord(table.parts, tableKey.get(table.parts)!, spliced.text);
  }

  for (const block of outstanding) {
    if (block.cell !== undefined) continue;
    const text = cleanText.get(block.target.key)!;
    if (text !== block.target.text) changed += 1;
    appendRecord(block.parts, keyOf.get(block.target.key)!, text);
  }

  // ── The receipt and the stamp ─────────────────────────────────────────────
  const receipt: CleanTextReceipt = {
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model,
    at,
    source: where,
    punctuation: punctuated.record,
    units,
    dispositions,
    appliedByClass,
    unitsAsked: settled.asked,
    unitsParseFailed: settled.parseFailed,
  };
  const receiptOut = receiptPath(recordsPath);
  ensureDir(path.dirname(receiptOut));
  fs.writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  /*
   * ── WHAT THIS CLEANUP PRODUCED, BLOCK BY BLOCK, SO THE CLAIM CAN BE CHECKED ─
   *
   * Owen, 2026-09-05, on the gap BookForge measured: *"recompute over the book
   * handed and refuse by name on mismatch."* The stamp used to say only that a
   * pass RAN — six fields all of which are true of a pass over a different book
   * — so `vlm-compile --narration-stamp` cheerfully stamped the UNCLEANED parent
   * and the render door believed it. This is the half of the claim that can be
   * disproved: every position this run covered, and a digest of the text a
   * reader will actually find there.
   *
   * THE TEXT IS THE ONE MATERIALISATION WILL PUT AT THAT POSITION, which is the
   * newest row of the records file, or the book's own text where no row was
   * written — and that fallback is not a corner case, it is the ordinary state
   * of a paragraph the pass had nothing to change. A HAND-CORRECTED row is the
   * newest row like any other and is therefore what is hashed: the person's
   * words are what the narrator gets, so the person's words are what the stamp
   * has to be a claim about.
   *
   * IT COVERS EVERY BLOCK OF THE PLAN AND NOT ONLY THIS RUN'S, because a resumed
   * run whose every block was banked still writes a stamp, and a stamp naming
   * only the handful of blocks the last invocation happened to buy would let
   * everything else through unchecked.
   *
   * The positions and the text form both come from src/clean/digest.ts, which is
   * also where `vlm-compile` reads them — one definition, so the two sides
   * cannot drift into hashing different strings.
   */
  const sourceTexts = bookPositionTexts(book);
  const digests = new Map<string, string>();
  for (const parts of new Set(blocks.map((b) => b.parts))) {
    const text = records.rowFor(parts)?.text ?? sourceTexts.get(parts);
    if (text === undefined) {
      throw new CleanTextError(
        `clean-text cleaned ${parts} of ${where} and can find no text at that position to stand `
        + 'behind the stamp. The plan and the book file disagree about what this book holds, and '
        + 'nothing was stamped.',
      );
    }
    digests.set(parts, blockDigest(text));
  }

  const stamp = narrationTextStamp({
    model,
    at,
    punctuationRefused: punctuated.record.refused.length,
    blocks: digests,
  });
  ensureDir(path.dirname(path.resolve(opts.stampPath)));
  fs.writeFileSync(path.resolve(opts.stampPath), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');

  if (humanKept > 0) {
    opts.log(
      `clean-text: ${humanKept} position(s) whose newest row a person wrote were left exactly as `
      + 'they left them — their source text has not changed since.',
    );
  }
  opts.log(`clean-text: the receipt is ${receiptOut}; the stamp is ${path.resolve(opts.stampPath)}`);
  opts.log(
    `clean-text: the stamp names ${digests.size} block position(s) and their text digest is `
    + `${stamp.textDigest} — vlm-compile --narration-stamp recomputes both over the book it is `
    + 'handed and refuses by name if it is not this one.',
  );

  const refused = punctuated.record.refused.length + modelRefused;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  opts.log(
    `clean-text: ${blocks.length} blocks, ${changed} changed, ${refused} edits refused in `
    + `${seconds}s`,
  );
  if (written === 0) {
    opts.log(
      'clean-text: no row was appended, because none of them says anything the records file did '
      + 'not already say. That is what a re-run over an unchanged book costs.',
    );
  }
  const markers = blocks.reduce((n, b) => n + markerCharacters(b.target.text), 0);
  if (markers > 0) {
    opts.log(
      `clean-text: ${markers} character(s) of the book are inline markers — emphasis delimiters `
      + 'and superscript note numbers — and no edit was allowed to cross one.',
    );
  }

  return { blocks: blocks.length, changed, refused, reused, written, stamp, receipt };
}

/**
 * Say a refused edit, by its disposition's own name.
 *
 * The validators already decide WHY, and each disposition is a word with a
 * meaning argued in docs/CLEAN-TEXT.md — `WORDS_DROPPED`, `NOT_A_READING`,
 * `SPANS_MARKUP`, `SCRIPTURE_UNREAD`. So the log prints the name rather than a
 * paraphrase of it: a person reading `NOT_A_READING` can find the paragraph of
 * the doctrine that governs it, and a person reading "the replacement was not
 * accepted" cannot.
 */
function sayRefusal(
  log: (message: string) => void,
  key: string,
  record: NumberEditRecord,
): void {
  log(
    `clean-text: REFUSED ${record.status} in ${key} — "${record.find}" → "${record.replace}"`
    + `${record.detail === undefined ? '' : ` (${record.detail})`}`,
  );
}
