/**
 * translate/records — a transform's product, on disk, one JSON object per line.
 *
 * ── WHAT A RECORD IS, AND WHY IT IS NOT AN EPUB ─────────────────────────────
 *
 * `translate` has always produced a SECOND BOOK: it read a stamped EPUB,
 * translated the words inside every stamped element, and spliced them back into
 * a copy of the container. That works, it shipped, and it is what the app still
 * drives — and it has a shape problem that every feature after it ran into.
 * The translation lives in a FILE. A person who wants to strike a paragraph out
 * of the translated edition, correct one sentence of it, re-cast it as plain
 * text, or translate it again into a third language is holding an EPUB, and
 * every one of those operations has to be re-implemented over markup instead of
 * over the book's own blocks.
 *
 * A RECORD IS THE ANSWER WITHOUT THE FILE. One line per flowing block:
 *
 *     {"key":"…","parts":"12:3 13:0","generation":"g7","text":"The state was…"}
 *
 *  - `parts` is WHERE, in the only spelling this program has ever had for a
 *    position: `page:order[:part]`, space-joined when the reflow made one
 *    paragraph out of blocks from two pages, plus `#note` for one note of a
 *    Footnote block. It is `data-bf-src`'s value exactly (`dots-book.ts`) and
 *    `parseTargetKey`'s grammar exactly (the app's `overlay.ts`) — one spelling,
 *    three readers, no translation table. Materialization looks a block up by
 *    this and writes the record's words in place of the source's.
 *  - `key` is WHAT WAS ASKED: `bankKey` over the masked source text, the model,
 *    the two languages and the instructions (`bank.ts`). It is what makes this
 *    file its own cost cache — an unchanged block has an unchanged key, and a
 *    key already in the file is never asked of a model again.
 *  - `generation` is the app's binding of this file to the reading it was made
 *    from, carried and never interpreted, exactly as `Overlay.generation` is.
 *  - `text` is the translation, in the FLOWING BLOCK'S dialect — markdown
 *    emphasis and Unicode superscript runs, the same dialect the vision model
 *    answers in — because that is what it stands in place of.
 *  - `author` is absent for a row a model produced and `"user"` for a row a
 *    person wrote. It is how "edit transformed text" corrects one paragraph of
 *    a translation without re-asking anything (docs/WORKBENCH.md §10, ruling 7).
 *
 * ── ONE FILE, TWO INDEXES, AND THE DIFFERENCE MATTERS ───────────────────────
 *
 * `key` and `parts` are not the same identity and neither is redundant.
 *
 * Two paragraphs with identical words have ONE key and TWO positions: the model
 * is asked once and both positions get a row, because materialization looks up
 * by position and a position with no row keeps its source text. One position
 * can carry SEVERAL rows: a later run over an edited block, or a person
 * correcting the words by hand, appends rather than rewrites — so the reader
 * takes the LAST row for a position and the file keeps its own history.
 *
 * That is why a run that finds a key already answered still writes a row. The
 * saving is the GPU, not the line.
 *
 * ── THE FILE IS ONLY REPLACED BY A FILE THAT EXISTS ─────────────────────────
 *
 * Appended and fsynced as each answer lands, for `bank.ts`'s reason: a run
 * killed at block 400 of 456 has 399 answers on disk and the next run pays for
 * none of them. And a run asked to redo the whole thing writes into a PENDING
 * file beside the real one, which is renamed over it at the one moment that
 * means the gamble paid off — the readings pattern (`src/vlm/readings.ts`), the
 * bank pattern (`bank.ts`), and the same rule as both: nothing somebody paid
 * for is destroyed until its replacement is on disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { ensureDir } from '../fsdirs.js';

/** Something is wrong with the records file itself, or with the flags about it. */
export class TranslateRecordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslateRecordsError';
  }
}

/** Who wrote a row. Absent means the model, through a run of this command. */
export type RecordAuthor = 'user';

/** One line of the file. See this file's header for what each field is for. */
export interface TranslationRecord {
  /** `bankKey` of the question this answers. The cost cache's identity. */
  key: string;
  /** `page:order[:part]`, space-joined, `#note` for one note. The position. */
  parts: string;
  /** The app's binding token, carried verbatim. Absent where nobody said. */
  generation?: string;
  /** The translation, in the flowing block's own dialect. */
  text: string;
  /** Absent for a model's row; `"user"` for a person's correction. */
  author?: RecordAuthor;
}

export class TranslationRecords {
  /** The newest row per POSITION — what materialization reads. */
  private readonly byParts = new Map<string, TranslationRecord>();
  /** The newest row per QUESTION — what the cost cache reads. */
  private readonly byKey = new Map<string, TranslationRecord>();
  private rows = 0;

  private constructor(readonly filePath: string) {}

  /**
   * Open a records file, reading whatever is already in it.
   *
   * A malformed LAST line is an interrupted append and is dropped; a malformed
   * line anywhere else is a file this program did not write, and it fails
   * naming the line. Exactly `TranslationBank.open`'s rule, for exactly its
   * reason: the first is the normal consequence of a kill, and the second is a
   * wrong path about to supply somebody else's translation to a book they are
   * not from.
   */
  static open(filePath: string): TranslationRecords {
    const records = new TranslationRecords(path.resolve(filePath));
    if (!fs.existsSync(records.filePath)) return records;
    const lines = stripBom(fs.readFileSync(records.filePath, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const last = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (last) break;
        throw new TranslateRecordsError(
          `${records.filePath}, line ${index + 1} is not JSON `
          + `(${err instanceof Error ? err.message : String(err)}). This file is not a records file.`,
        );
      }
      const row = parsed as Partial<TranslationRecord>;
      if (typeof row.parts !== 'string' || typeof row.text !== 'string') {
        throw new TranslateRecordsError(
          `${records.filePath}, line ${index + 1} carries no parts and text. `
          + 'This file is not a records file.',
        );
      }
      records.remember({
        key: typeof row.key === 'string' ? row.key : '',
        parts: row.parts,
        ...(typeof row.generation === 'string' ? { generation: row.generation } : {}),
        text: row.text,
        ...(row.author === 'user' ? { author: 'user' as const } : {}),
      });
    }
    return records;
  }

  /**
   * Last row wins, in both indexes.
   *
   * A row with no key — which a hand-written correction is allowed to be, since
   * a person editing one paragraph has no way to compute a question hash — is
   * remembered by POSITION only. It must never enter the cost cache: an empty
   * key is not the answer to any question, and letting one match would hand
   * every unrelated block the same paragraph.
   */
  private remember(row: TranslationRecord): void {
    this.rows += 1;
    this.byParts.set(row.parts, row);
    if (row.key.length > 0) this.byKey.set(row.key, row);
  }

  /** How many lines were read. Not how many positions they cover. */
  get size(): number {
    return this.rows;
  }

  /** How many distinct positions this file answers for. */
  get positions(): number {
    return this.byParts.size;
  }

  /** The banked answer for this question, or undefined where there is none. */
  get(key: string): string | undefined {
    return key.length === 0 ? undefined : this.byKey.get(key)?.text;
  }

  /** The newest text for this position — what materialization substitutes. */
  textFor(parts: string): string | undefined {
    return this.byParts.get(parts)?.text;
  }

  /**
   * The newest ROW for this position, author and all.
   *
   * A run needs more than the words: whether the last thing said about this
   * position was said by a person, and which question it was an answer to. See
   * `run.ts`'s `recordRow` for what it does with both.
   */
  rowFor(parts: string): TranslationRecord | undefined {
    return this.byParts.get(parts);
  }

  /** Every position this file answers for, newest row each. */
  positionMap(): Map<string, string> {
    return new Map([...this.byParts].map(([parts, row]) => [parts, row.text] as const));
  }

  /**
   * Append and fsync, the moment an answer is accepted — never at the end of a
   * chunk, a document or a run. `bank.ts` has the measurement behind that rule.
   *
   * Synchronous from open to close, which is also what makes it safe under
   * `--concurrency`: several workers accept answers in the same event loop and
   * none can interleave a line into the middle of another's.
   */
  append(row: TranslationRecord): void {
    this.remember(row);
    ensureDir(path.dirname(this.filePath));
    const handle = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
}

/** `<records>.pending` — the whole path plus a suffix, never a rename of it. */
export function pendingRecordsPath(recordsPath: string): string {
  return `${path.resolve(recordsPath)}.pending`;
}

/**
 * The pending records become the records, and what they replace is gone.
 *
 * Called at the one moment that means the gamble paid off — every block
 * settled — and never before it. `pending === null` is every ordinary run, one
 * that was appending to the real file all along, and for it this does nothing.
 *
 * THE CALLER PASSES WHAT IT ACTUALLY WROTE TO. A `.pending` on disk that this
 * run did not open belongs to somebody else's abandoned attempt, and renaming
 * it over a good file would be the failure this arrangement exists to refuse.
 */
export function swapPendingRecordsIntoPlace(recordsPath: string, pending: string | null): void {
  if (pending === null) return;
  const resolved = path.resolve(recordsPath);
  const pendingResolved = path.resolve(pending);
  if (!fs.existsSync(pendingResolved)) {
    throw new TranslateRecordsError(
      `${pendingResolved} was this run's records file and it is not there, so there is nothing to `
      + `put in place of ${resolved}. The file that is there has been left exactly as it was found.`,
    );
  }
  ensureDir(path.dirname(resolved));
  fs.renameSync(pendingResolved, resolved);
}

export interface RecordsOutcome {
  /** The file this run answers out of and appends to. */
  records: TranslationRecords;
  /** The pending file, or null where it appends the real one. */
  pendingPath: string | null;
  /** ONE sentence, printed by the run. Never empty — every decision is stated. */
  sentence: string;
}

/**
 * Decide what to do with the records file this run was pointed at, do it, and
 * say so.
 *
 * `openTranslationBank`'s two outcomes, its reasoning and its sentence, over
 * this file instead: a question-keyed file cannot hold a wrong answer to the
 * question being asked, so an ordinary run resumes in place and only a run that
 * asked for the whole thing again gambles into a pending file.
 *
 * A FRESH RUN THAT WAS KILLED IS RESUMED RATHER THAN RESTARTED, and its pending
 * file is where that is recorded — the second opinion costs the same GPU the
 * first one did.
 */
export function openTranslationRecords(request: {
  recordsPath: string;
  /** `--fresh-bank`: ask for every block again, into a file that replaces this one. */
  freshRequested: boolean;
}): RecordsOutcome {
  const recordsPath = path.resolve(request.recordsPath);
  const existing = TranslationRecords.open(recordsPath);

  if (request.freshRequested && existing.size > 0) {
    const pending = pendingRecordsPath(recordsPath);
    ensureDir(path.dirname(pending));
    fs.closeSync(fs.openSync(pending, 'a'));
    const carried = TranslationRecords.open(pending);
    return {
      records: carried,
      pendingPath: pending,
      sentence: carried.size === 0
        ? `translate: a fresh translation was asked for, so every block is asked of the model again `
          + `— the ${existing.size} record(s) in ${recordsPath} are left exactly as they are and the `
          + `new ones go to ${pending}, which replaces them only when this run finishes.`
        : `translate: a fresh translation was asked for and one was already begun — ${carried.size} `
          + `record(s) are in ${pending}, a block whose exact question is in there is not asked `
          + `again, and it replaces ${recordsPath} only when this run finishes.`,
    };
  }

  return {
    records: existing,
    pendingPath: null,
    sentence: existing.size === 0
      ? `translate: nothing is recorded in ${recordsPath}, so every block is asked of the model and `
        + 'recorded there as it lands.'
      : `translate: ${existing.size} record(s) covering ${existing.positions} position(s) are in `
        + `${recordsPath} — a block whose exact question is in there is not asked again, and every `
        + 'new answer is added to it.',
  };
}
