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
 * THE BANK IS NEVER DESTROYED UNTIL ITS REPLACEMENT EXISTS. `--fresh-bank` used
 * to rotate the whole file into `archived-<timestamp>/` before a single block was
 * asked, which meant that a fresh run killed at block 400 of 456 had thrown away
 * a complete bank and produced nothing to put in its place. So the second opinion
 * is asked into a PENDING BANK beside the real one, and that file is renamed over
 * the bank when the run writes its EPUB — the same rule, the same ordering and
 * the same reasoning as `src/vlm/readings.ts`, which has the long version.
 *
 * The difference here is how narrow the case is: this bank has no completion
 * marker, so the pending path is used under `--fresh-bank` AND NOWHERE ELSE. An
 * ordinary run resumes the bank in place, because a question-keyed bank cannot
 * hold a wrong answer to the question being asked — the worst it can do is not
 * hold one.
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
  /**
   * WHICH STAGE THE TEXT WAS MASKED AT. Absent is `xhtml`, which is what the
   * EPUB→EPUB mode has always asked and what every bank on disk holds.
   *
   * See `KEY_FORMATS` below for why this is part of the key rather than a
   * detail of the caller.
   */
  masking?: MaskingLevel;
}

/**
 * Where a question's markers came from: the book's XHTML, or the flowing
 * block's own text.
 *
 * `xhtml` is `markers.ts` over a stamped element's inner markup — the mode that
 * splices a translation back into an EPUB. `text` is `textmask.ts` over a
 * FlowBlock's text, which is what a RECORD is a translation of.
 */
export type MaskingLevel = 'xhtml' | 'text';

/**
 * Stamped into every key, so a change to what a key MEANS cannot be mistaken
 * for a change to the question. If the fields below ever change, this string
 * changes with them and every old key stops matching — which re-asks the book
 * rather than replaying answers to a question this version never asked.
 *
 * ── WHY THERE ARE TWO OF THEM, AND WHY NOTHING IS MIGRATED ──────────────────
 *
 * Records mode masks one stage earlier (`textmask.ts`): the markers stand for
 * `**emphasis**` and a superscript run rather than for `<strong>` and a
 * noteref anchor, and the text around them is the flowing block's own words
 * rather than a slice of somebody's XHTML with entities in it. The same
 * paragraph therefore produces a DIFFERENT masked string in the two modes —
 * which is precisely a changed question, and precisely what this constant
 * exists to make loud.
 *
 * So `text` questions carry `foundry-translate-bank-2` and `xhtml` questions
 * carry the string they have always carried. Nothing about the EPUB→EPUB mode
 * moves, no bank on disk stops matching, and the two modes cannot hand each
 * other an answer to a question the other asked — which they could not usefully
 * do anyway: one answer carries `<em>` and the other carries `*`.
 *
 * CONSIDERED AND REJECTED: migrating old answers by re-keying them under the
 * new format. To do it, this file would have to recompute a cross-version
 * masked form — take a bank line written against XHTML markers, work out what
 * the same paragraph's TEXT masking would have produced, and hash that. That
 * recomputation is exactly the ambiguity a key format forbids: it would be a
 * guess about a string this version never saw, and a wrong guess hands a
 * paragraph an answer to a different question, silently. The bank is a cost
 * cache and not truth. The honest price is one full re-ask the first time a
 * book is translated into records, and it is accepted
 * (docs/WORKBENCH.md §10, ruling 1).
 */
const KEY_FORMATS: Record<MaskingLevel, string> = {
  xhtml: 'foundry-translate-bank-1',
  text: 'foundry-translate-bank-2',
};

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
    KEY_FORMATS[question.masking ?? 'xhtml'],
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

/** `<bank>.pending` — the whole bank path plus a suffix, never a rename of it. */
export function pendingBankPath(bankPath: string): string {
  return `${path.resolve(bankPath)}.pending`;
}

/**
 * The pending bank becomes the bank, and the answers it replaces are gone.
 *
 * Called by the run at the one moment that means the gamble paid off — the EPUB
 * on disk — and never before it. Two steps rather than the readings bank's four,
 * because there is no completion marker here to delete first and none to write
 * afterwards: rename, and the run is done. A crash before it leaves the old bank
 * exactly as it was with the second opinion beside it as resumable debris, which
 * is the whole point.
 *
 * `pending === null` is every ordinary run — one that was appending to the real
 * bank all along — and for it this does nothing at all. THE CALLER PASSES WHAT IT
 * ACTUALLY WROTE TO: a `.pending` on disk that this run did not open belongs to
 * somebody else's abandoned `--fresh-bank`, and renaming it over a good bank
 * would be the failure this whole arrangement exists to refuse.
 */
export function swapPendingBankIntoPlace(bankPath: string, pending: string | null): void {
  if (pending === null) return;
  const resolved = path.resolve(bankPath);
  const pendingResolved = path.resolve(pending);
  if (!fs.existsSync(pendingResolved)) {
    throw new TranslateBankError(
      `${pendingResolved} was this run's bank and it is not there, so there is nothing to put in `
      + `place of ${resolved}. The bank that is there has been left exactly as it was found.`,
    );
  }
  ensureDir(path.dirname(resolved));
  fs.renameSync(pendingResolved, resolved);
}

export type BankAction =
  /** Every block is asked of the model. Nothing that was here has been touched. */
  | 'ask-fresh'
  /** A block whose question is banked is not asked; the rest are. */
  | 'resume';

export interface BankOutcome {
  action: BankAction;
  /** The bank this run answers out of and appends to. Empty for `ask-fresh`. */
  bank: TranslationBank;
  /**
   * The pending file this run appends to, or null where it appends the bank
   * directly. Handed back to `swapPendingBankIntoPlace` when the EPUB lands.
   */
  pendingPath: string | null;
  /** ONE sentence, printed by the run. Never empty — every decision is stated. */
  sentence: string;
}

export interface BankRequest {
  bankPath: string;
  /**
   * `--fresh-bank`: ask for every block again, into a bank that replaces this one
   * only if the run finishes. It does not archive and it destroys nothing.
   */
  freshRequested: boolean;
}

/**
 * Decide what to do with the bank this run was pointed at, do it, and say so.
 *
 * Two outcomes rather than the readings file's three, and the missing one is
 * `reuse` — see this file's header for why a question-keyed bank does not need
 * to be told that a finished run is finished.
 *
 * A `--fresh-bank` RUN THAT WAS KILLED IS RESUMED RATHER THAN RESTARTED, and its
 * pending file is where that is recorded. The second opinion is worth exactly
 * what the first one was — it costs the same GPU — so a fresh run interrupted at
 * block 400 picks up at 401 rather than paying for 400 answers a second time.
 * There is no request sidecar as there is beside a readings bank, and none is
 * needed: the key IS the question, so a pending answer that was asked under a
 * different model, language or set of instructions simply does not match and is
 * never handed to a block it is not an answer to.
 *
 * A pending left by an abandoned fresh run is left alone by an ordinary run,
 * which appends to the real bank and never looks at it. It costs a directory
 * entry, it holds real answers, and the next `--fresh-bank` finishes what it
 * started.
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

  if (request.freshRequested && banked > 0) {
    /*
     * The gamble is opened here and the empty file created rather than waited
     * for, so that the directory says out loud that a second opinion is in
     * progress from the moment it is, rather than only once an answer lands.
     */
    const pending = pendingBankPath(bankPath);
    ensureDir(path.dirname(pending));
    fs.closeSync(fs.openSync(pending, 'a'));
    const carried = TranslationBank.open(pending);
    return {
      action: carried.size === 0 ? 'ask-fresh' : 'resume',
      bank: carried,
      pendingPath: pending,
      sentence: carried.size === 0
        ? `translate: a fresh bank was asked for, so every block is asked of the model again — the `
          + `${banked} banked answer(s) in ${bankPath} are left exactly as they are and the new `
          + `answers go to ${pending}, which replaces them only when this run writes its book.`
        : `translate: a fresh bank was asked for and one was already begun — ${carried.size} `
          + `answer(s) are in ${pending}, a block whose exact question is in there is not asked `
          + `again, and it replaces ${bankPath} only when this run writes its book.`,
    };
  }

  if (banked === 0) {
    return {
      action: 'ask-fresh',
      bank: existing,
      pendingPath: null,
      sentence: request.freshRequested
        ? `translate: a fresh bank was asked for and ${bankPath} banks nothing, so every block is `
          + 'asked of the model and banked there as it lands.'
        : `translate: nothing is banked in ${bankPath}, so every block is asked of the model `
          + 'and banked there as it lands.',
    };
  }

  return {
    action: 'resume',
    bank: existing,
    pendingPath: null,
    sentence: `translate: ${banked} answer(s) are banked in ${bankPath} — a block whose exact `
      + 'question is in there is not asked again, and every new answer is added to it.',
  };
}
