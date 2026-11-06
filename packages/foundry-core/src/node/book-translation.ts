/**
 * book-translation — a text pass made into its book, and finding a translation's source.
 */
import * as path from 'node:path';
import { projectDirOf, readStepLedger, type LedgerView } from './projects';
import { type BookFile } from '../shared/book';
import { isTextPass } from '../shared/ledger';
import { materialize } from '../shared/materialize';
import { BookOpsError } from '../shared/ops';
import type { LedgerStep } from '../shared/types';
import { openBookAtPosition, writeTranslationBook } from './book-open';

/**
 * The derived book for a translation that has just landed, made now.
 *
 * ── Named by the file the run wrote, exactly as `ensureTranslateCast` is ────
 *
 * The settle holds the records path and nothing else: the step was minted by
 * `recordTextPass` a moment earlier, inside a manifest write the queue
 * deliberately does not reach into. So the row is looked up by the payload it
 * names — the same whole-project-relative-path rule every other lookup in this
 * app obeys, and emphatically not by reading anything back out of a filename.
 *
 * IT IS NOT FATAL TO THE LANDING. A translation that landed is hours of GPU
 * safely on disk in its records file, and the derived book is a pure function of
 * that file and the ledger — regenerable retention in the strongest sense, and
 * remade by the next open (`ensureTextPassBook`) if this could not write it
 * now. So a failure here is a console line and not a job reported as failed.
 */
export async function materializeTextPass(recordsPath: string): Promise<void> {
  const dir = projectDirOf(recordsPath);
  if (dir === null) {
    console.error(
      `[book] ${recordsPath} is outside any project, so no translated book was made from it.`,
    );
    return;
  }
  try {
    const view = await readStepLedger(dir);
    const relative = path.relative(dir, path.resolve(recordsPath)).split(path.sep).join('/');
    // ANY TEXT PASS THAT NAMES THESE ANSWERS, by the whole project-relative path
    // — the family rather than the translation alone, or a rewrite's and a
    // cleanup's landing would each find no step and make no book, leaving the
    // pane to make it again on the first open (`ensureTextPassBook`).
    const step = view?.ledger.steps.find(
      (row) => isTextPass(row.action) && row.payload === relative,
    );
    if (step === undefined) {
      console.warn(
        '[book] a translation landed and no step in that project\'s history names those answers, '
        + 'so no book was made from them.',
      );
      return;
    }
    const made = await writeTranslationBook(dir, view!.ledger, step);
    if (!made.ok) console.error(`[book] ${recordsPath}: ${made.reason}`);
  } catch (err) {
    console.error(
      `[book] a translation landed and its book could not be made `
      + `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

/**
 * THE LEFT-HAND COLUMN — the parent book as the records answered it.
 *
 * ── It is `writeTranslationBook`'s own first half, and that is the point ────
 *
 * That function materialises `parent book file + chain ops` and then puts the
 * records' words into the result (docs/RENDERER.md §4). What comes back from here
 * is the state at the end of its first sentence: the same parent, opened the same
 * way, with the same chain replayed by the same `materialize`. So the ids in these
 * rows are the ids in the derived file BY CONSTRUCTION rather than by hope — the
 * two columns are one book twice, which is the only reason locking them together
 * by id is honest.
 *
 * ── ROWS, AND NO OPS ───────────────────────────────────────────────────────
 *
 * The chain is already IN them. Handing the pane an ops list beside these rows
 * would invite it to replay a second time, and a strike replayed twice takes out a
 * row the first one already removed. There is also nothing to edit here: the left
 * column is context (source edits stand above the translation, where they
 * invalidate the records by changing the question the cost cache is keyed on), so
 * there is no gesture on that sheet that could mint an op to carry.
 *
 * ── EVERY REFUSAL IS THE LEFT SHEET'S AND NEVER THE PANE'S ─────────────────
 *
 * See `BookTranslation.source`: the position is drawable without its context, so
 * nothing here is allowed to take the whole load down. Each way this fails already
 * has a sentence written to be read, and they are passed through rather than
 * paraphrased.
 */
export async function sourceOfTranslation(
  projectDir: string,
  ledger: LedgerView['ledger'],
  transform: LedgerStep,
): Promise<{ ok: true; rows: BookFile['rows'] } | { ok: false; reason: string }> {
  const parent = ledger.steps.find((step) => step.id === transform.parent) ?? null;
  if (parent === null) {
    console.error(
      `[book] step ${transform.id} names parent ${String(transform.parent)}, which this project's `
      + 'history does not hold, so there is no source to show beside it.',
    );
    return {
      ok: false,
      reason: `The step “${transform.label}” was made from is not in this project's history, so there `
        + 'is no source to set beside these words.',
    };
  }
  const read = await openBookAtPosition(projectDir, parent);
  if (!read.ok) return read;
  let made: ReturnType<typeof materialize>;
  try {
    made = materialize(read.opened.parsed, [...read.opened.ops, ...(read.opened.tip ?? [])]);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    console.error(`[book] the source under ${transform.id} could not be materialised: ${err.message}`);
    return {
      ok: false,
      // NAMED BY THE ACT THAT WAS ORDERED, because a simplify is a translate step
      // and this sentence is read on the very sheet the pair is drawn on: telling
      // somebody their rewrite was "translated from" a book is the pane's own
      // vocabulary failure in main's voice. The label already says which it was.
      reason: `The changes recorded above “${transform.label}” could not be replayed onto the book it `
        + `was ${transform.params?.rewrite === undefined ? 'translated' : 'simplified'} from, so its `
        + `source cannot be set beside it: ${err.message}`,
    };
  }
  /*
   * A CHANGE THAT LANDED ON NOTHING IS SAID OUT LOUD AND IS NOT FATAL — the same
   * ruling `materializeBook` and `writeTranslationBook` both make about the same
   * list, and the same one for the same reason: the column is context, and
   * refusing to show any of it over one stale strike is the worst answer here too.
   */
  if (made.missing.length > 0) {
    console.error(
      `[book] ${made.missing.length} recorded change(s) could not be replayed for the source beside `
      + `${transform.id} — ${made.missing.map((one) => `${one.op.op} ${one.id}`).join(', ')}`,
    );
  }
  return { ok: true, rows: made.book.rows };
}
