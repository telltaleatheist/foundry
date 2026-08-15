/**
 * translate/bank — the answers, on disk, one JSON object per line.
 *
 * A translation used to hold every answer in memory and write the EPUB at the
 * very end, which means a run that died at block 400 of 456 — a crash, an
 * Ollama restart, the app closing, somebody pressing stop — had written
 * NOTHING, and the next run started again at block 1. Measured on a real book:
 * 152 blocks of 456 translated, the run killed, nothing to show for it. A whole
 * book is fifteen minutes of GPU on a small one and hours on a real one.
 *
 * So `--bank` names a file, every accepted answer is appended and FSYNCED the
 * moment it is accepted, and a run that starts against an existing file asks
 * only for the blocks that are not in it. A kill costs the requests that were
 * in flight and nothing else. This is the same machinery `--readings` is for
 * `vlm-convert` (`src/vlm/readings.ts`), deliberately in the same vocabulary,
 * and it differs in the two places where the two problems differ. Both of them
 * are below, because both of them are the design.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE: THE KEY IS THE QUESTION, NOT THE POSITION.
 *
 * `readings.ts` is keyed by page number, and that is right there: page 12 of a
 * PDF is a fixed thing, the answer IS the page, and the file cannot be edited
 * between runs without becoming a different PDF.
 *
 * A block is not that. The working copy is a book somebody is EDITING — that is
 * what the app is for — so "block 400" tomorrow is not block 400 today. A bank
 * keyed by position would hand a translation of a deleted paragraph to the
 * paragraph that moved up into its place: a book that renders perfectly, reads
 * plausibly, and is wrong in a way no reader can detect, which is the failure
 * this whole command exists to refuse.
 *
 * So a banked answer is reusable only if THE EXACT SAME QUESTION would be asked
 * again, and the key is a hash of the whole question:
 *
 *  - the block's MASKED SOURCE TEXT — the exact string that would be sent;
 *  - the model, because two models are two different answers;
 *  - the target language and the source language (or the fact that the model is
 *    being asked to work it out);
 *  - `--instructions`, verbatim, because they are part of the prompt and a book
 *    translated under "leave 'völkisch' untranslated" is a different book.
 *
 * What follows from that is the whole feature, and each of these is a test:
 *
 *  - editing one paragraph in the working copy re-translates that paragraph and
 *    NOTHING ELSE;
 *  - changing `--model` or `--instructions` invalidates everything, correctly,
 *    because every answer would have been different;
 *  - reordering or inserting blocks costs nothing — position is not in the key;
 *  - a block that appears twice in a book is asked once, because the first
 *    answer is banked before the second block is looked up. The exception is
 *    two duplicates that are IN FLIGHT TOGETHER under `--concurrency`, which
 *    are asked twice: nothing looks in a request that has not landed. That
 *    costs one request and nothing else — the second answer replaces the first
 *    under the same key, and the next run over the book has one answer for
 *    both.
 *
 * THE MASKED TEXT, NOT THE PLAIN TEXT, and that is not an accident either. The
 * masked form carries the marker ids (`⟦e1⟧`, `⟦m2⟧`) that the answer must give
 * back, and `restoreMarkers` puts THIS block's own markup back from them. Keyed
 * on plain words, an answer carrying ⟦e1⟧ could be restored into a block whose
 * ⟦e1⟧ is a different `<em>` — the emphasis landing on the wrong word, silently.
 * Keyed on the masked text, an answer is only ever replayed into the block whose
 * markers it was written against.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO: THERE IS NO COMPLETION MARKER HERE, AND `readings.ts` NEEDS ONE.
 *
 * A readings bank has to tell "this run was killed" from "this run finished",
 * because ordering a conversion that already completed means READ THE BOOK
 * AGAIN, and replaying the bank instead obeys nobody's instruction and does no
 * work. That distinction is necessary there precisely because the key is a
 * position: the bank cannot tell whether anything about the job changed.
 *
 * Keyed by the question, this bank can. A re-run over an unchanged book with an
 * unchanged model asks nothing and writes the same book — not a stale replay,
 * but the correct answer to the same question, arrived at for free. The moment
 * anything about the question changes, exactly the blocks whose question changed
 * are asked again, with no marker and no flag involved. `--fresh-bank` remains,
 * for the one thing the key cannot express: a person who wants the SAME question
 * asked again, because a model is not deterministic and a second opinion on a
 * chapter is a legitimate thing to want.
 *
 * THE BANK IS NEVER DELETED. `--fresh-bank` rotates the whole file into
 * `archived-<timestamp>/` and leaves it there. Deleting somebody's GPU-hours to
 * save a directory entry is not a trade this program makes.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { ensureDir } from '../fsdirs.js';

/** Something is wrong with the bank itself — the file, or the flags about it. */
export class TranslateBankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslateBankError';
  }
}

/**
 * Everything that decides whether a banked answer may be reused, and nothing
 * else. See this file's header: if two runs would ask the model the same thing,
 * these five fields are identical, and if they are identical the runs would.
 */
export interface BankQuestion {
  /** The block's masked source text — the exact string that goes on the wire. */
  text: string;
  model: string;
  /** Target language TAG, not its name: the tag is what the caller chose. */
  to: string;
  /** Source language tag, or null where the model is asked to determine it. */
  from: string | null;
  /** `--instructions`, appended to the prompt verbatim. */
  instructions: string | undefined;
}

/**
 * Stamped into every key, so a change to what a key MEANS cannot be mistaken
 * for a change to the question. If the fields below ever change, this string
 * changes with them and every old key stops matching — which re-asks the book
 * rather than replaying answers to a question this version never asked.
 */
const KEY_FORMAT = 'foundry-translate-bank-1';

/**
 * The field separator inside a key. See `bankKey` for why it is this one, and
 * written as a code point rather than an escape so no source file in this
 * project has to carry a NUL byte in it.
 */
const NUL = String.fromCharCode(0);

/**
 * The question, as one hex string.
 *
 * The fields are joined with NUL, which cannot occur in any of them: the text
 * comes out of an XHTML document, where a NUL is not a legal character, and the
 * rest are a model name, two language tags and a line of prompt. Joining with
 * anything that CAN occur would let two different questions collide by moving a
 * character across a boundary.
 *
 * The whole digest is kept rather than a prefix. A collision here is not a
 * missing answer, it is the WRONG answer spliced into a paragraph and shipped.
 */
export function bankKey(question: BankQuestion): string {
  const fields = [
    KEY_FORMAT,
    question.model.trim(),
    question.to,
    question.from ?? '',
    (question.instructions ?? '').trim(),
    question.text,
  ];
  return createHash('sha256').update(fields.join(NUL), 'utf8').digest('hex');
}

/** One line of the file: an answer, and the question it answers. */
export interface BankedAnswer {
  /** `bankKey` of the question. What lookup matches on. */
  key: string;
  /**
   * The masked source this answers. Not read back — the key is the identity —
   * but written so the file is a thing a PERSON can open, read and correct. An
   * answer somebody fixes by hand is honoured exactly as the model's was.
   */
  source: string;
  /** The accepted answer, exactly as it was accepted. */
  answer: string;
}

export class TranslationBank {
  private readonly byKey = new Map<string, BankedAnswer>();

  private constructor(readonly filePath: string) {}

  /**
   * Open a bank file, reading whatever is already in it.
   *
   * A malformed LAST line is an interrupted append and is dropped; a malformed
   * line anywhere else is a file this program did not write, and it fails
   * naming the line. The difference matters: the first is the normal
   * consequence of a kill — the whole case this file exists for — and the
   * second is a wrong `--bank` path about to supply somebody else's answers to
   * a book they are not from.
   */
  static open(filePath: string): TranslationBank {
    const bank = new TranslationBank(path.resolve(filePath));
    if (!fs.existsSync(bank.filePath)) return bank;
    // Same door and the same mark as the readings bank: a BOM a shell put on
    // the front of the file must not condemn the first answer in it (`bom.ts`).
    const lines = stripBom(fs.readFileSync(bank.filePath, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const last = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (last) break;
        throw new TranslateBankError(
          `${bank.filePath}, line ${index + 1} is not JSON `
          + `(${err instanceof Error ? err.message : String(err)}). This file is not a translation bank.`,
        );
      }
      const record = parsed as Partial<BankedAnswer>;
      if (typeof record.key !== 'string' || typeof record.answer !== 'string') {
        throw new TranslateBankError(
          `${bank.filePath}, line ${index + 1} carries no key and answer. `
          + 'This file is not a translation bank.',
        );
      }
      bank.byKey.set(record.key, {
        key: record.key,
        source: record.source ?? '',
        answer: record.answer,
      });
    }
    return bank;
  }

  get size(): number {
    return this.byKey.size;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** The banked answer for this question, or undefined where there is none. */
  get(key: string): string | undefined {
    return this.byKey.get(key)?.answer;
  }

  /**
   * Append and fsync. The whole point is that a kill costs the requests that
   * were in flight, so this happens the moment an answer is ACCEPTED and never
   * at the end of a document, a chunk or a run.
   *
   * The write is synchronous from open to close, which is also what makes it
   * safe under `--concurrency`: several workers accept answers in the same
   * event loop and none of them can interleave a line into the middle of
   * another's.
   */
  append(entry: BankedAnswer): void {
    this.byKey.set(entry.key, entry);
    ensureDir(path.dirname(this.filePath));
    const handle = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
}

/**
 * Move the bank into `archived-<timestamp>/`, and return that directory.
 *
 * A rename, not a copy: the point is that the LIVE bank is gone, so the run
 * that follows asks for every block, and the answers that cost GPU-hours are
 * still on disk for anybody who wants them back. The timestamp is the ISO
 * instant with its colons replaced, because a colon is not a legal character in
 * a Windows filename and this program runs there.
 *
 * An archive directory that already exists is refused rather than merged into:
 * two banks in one directory is two runs' answers under one name.
 */
export function archiveTranslationBank(bankPath: string, at: Date): string {
  const resolved = path.resolve(bankPath);
  const runDir = path.dirname(resolved);
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(runDir, `archived-${stamp}`);
  if (fs.existsSync(archiveDir)) {
    throw new TranslateBankError(
      `${archiveDir} already exists, so this run cannot archive the bank beside it without mixing `
      + 'two runs\' answers into one directory. Move it aside and run again.',
    );
  }
  ensureDir(archiveDir);
  if (fs.existsSync(resolved)) {
    fs.renameSync(resolved, path.join(archiveDir, path.basename(resolved)));
  }
  return archiveDir;
}

export type BankAction =
  /** Every block is asked of the model. Any bank that was here has been archived. */
  | 'ask-fresh'
  /** A block whose question is banked is not asked; the rest are. */
  | 'resume';

export interface BankOutcome {
  action: BankAction;
  /** The bank this run answers out of and appends to. Empty for `ask-fresh`. */
  bank: TranslationBank;
  /** Where the previous bank went, or null where nothing was archived. */
  archivedTo: string | null;
  /** ONE sentence, printed by the run. Never empty — every decision is stated. */
  sentence: string;
}

export interface BankRequest {
  bankPath: string;
  /** `--fresh-bank`: archive whatever is banked and ask for every block again. */
  freshRequested: boolean;
  /** Injectable so a test can pin the archive directory's name. */
  now?: Date;
}

/**
 * Decide what to do with the bank this run was pointed at, do it, and say so.
 *
 * Two outcomes rather than the readings file's three, and the missing one is
 * `reuse` — see this file's header for why a question-keyed bank does not need
 * to be told that a finished run is finished.
 *
 * The sentence is not optional and not conditional. A run that is about to skip
 * three hundred blocks because a file on disk already answers for them has to
 * say so in the log, at the top, in one line, or the next person to read that
 * log cannot tell a resumed run from a fast model.
 */
export function openTranslationBank(request: BankRequest): BankOutcome {
  const bankPath = path.resolve(request.bankPath);
  const existing = TranslationBank.open(bankPath);
  const banked = existing.size;

  if (request.freshRequested) {
    if (banked === 0) {
      return {
        action: 'ask-fresh',
        bank: existing,
        archivedTo: null,
        sentence: `translate: a fresh bank was asked for and ${bankPath} banks nothing, so every `
          + 'block is asked of the model and banked there as it lands.',
      };
    }
    const archivedTo = archiveTranslationBank(bankPath, request.now ?? new Date());
    return {
      action: 'ask-fresh',
      bank: TranslationBank.open(bankPath),
      archivedTo,
      sentence: `translate: a fresh bank was asked for, so the ${banked} banked answer(s) were `
        + `archived to ${archivedTo} and every block is asked of the model again.`,
    };
  }

  if (banked === 0) {
    return {
      action: 'ask-fresh',
      bank: existing,
      archivedTo: null,
      sentence: `translate: nothing is banked in ${bankPath}, so every block is asked of the model `
        + 'and banked there as it lands.',
    };
  }

  return {
    action: 'resume',
    bank: existing,
    archivedTo: null,
    sentence: `translate: ${banked} answer(s) are banked in ${bankPath} — a block whose exact `
      + 'question is in there is not asked again, and every new answer is added to it.',
  };
}
