/**
 * book-correct — correcting one block, and sweeping derived files gone stale.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ProjectError, recordCorrection } from './projects';
import { type BookOutcome } from '../shared/book';
import { BookOpsError } from '../shared/ops';
import { loadBook } from './book-load';
import { openBookAtPosition } from './book-open';
import { materializeTextPass } from './book-translation';

/**
 * A CORRECTED PARAGRAPH ON A TRANSLATED POSITION — the words go to the records,
 * never to a text op.
 *
 * ── The rule, and why it is not a preference ────────────────────────────────
 *
 * *"Translated edits are per-language record corrections."* (docs/RENDERER.md §5.)
 * The words of a translated block belong to the records file: that file is the
 * step's payload, it is the truth the derived book is a pure function of, and
 * every position under the translation is drawn from that derived book. A `text`
 * op over the same block would put the person's sentence in the ops chain while
 * the records still held the machine's — two accounts of one paragraph, which is
 * precisely the failure `translationWorldOf` was built to prevent one surface over
 * ("mirroring it into the source curation would write Hungarian over the German
 * bank, silently", electron/projects.ts). So the edit goes where the words live.
 *
 * ── THE ID MUST BE A ROW OF THE BOOK FILE, and this is where that is proven ──
 *
 * A record is keyed by a block id and read back by looking that id up in the book
 * being materialised (`translationWords`). The pane can hold ids that book has
 * never had — the halves of an unapplied cut, `b2-3/1` and `b2-3/2`, which exist
 * only in the replay — and a record filed under one of those would be a row that
 * every future materialisation reports as stale and no reader ever finds. It is
 * refused by name instead, with the sentence saying which gesture comes first.
 *
 * ── The order, and what the caller gets back ────────────────────────────────
 *
 * Append, re-materialise, re-read. The derived book is stale from the instant the
 * row is appended until it is made again (main's `translation:record-edit` door
 * makes the same pair of calls for the same reason), and the pane cannot draw the
 * corrected words until it is. So the answer is the WHOLE BOOK back — one question,
 * one answer, on `loadBook`'s own rule — rather than an acknowledgement the pane
 * would have to follow with a second round trip.
 *
 * IT REJECTS, on `applyBookOps`'s rule: the person's words are in front of them
 * and a refusal is something they can act on.
 */
export async function correctBookBlock(
  projectDir: string,
  id: string,
  text: string,
  /** The queue's answer to "is a run writing this file right now" — main holds both. */
  busy: (recordsFile: string) => string | null = () => null,
): Promise<BookOutcome> {
  const read = await openBookAtPosition(projectDir);
  if (!read.ok) {
    // The load's own sentence, thrown rather than returned: this is a write door,
    // and a book that cannot be opened is a correction that cannot be recorded.
    throw new ProjectError(read.reason);
  }
  const { at, parsed, transform } = read.opened;
  if (transform === null) {
    throw new BookOpsError(
      'These words are not a translation\'s, so there is no translation to record a correction in. '
      + 'An edit here is an ordinary change to the book.',
    );
  }
  if (!parsed.rows.some((row) => row.id === id)) {
    throw new ProjectError(
      'This paragraph is not one the translation answered for — it was made by a change that is '
      + 'still waiting to be applied. A translation keeps its words block by block, so apply the '
      + 'change first and the corrected words have somewhere to be recorded.',
    );
  }
  const records = await recordCorrection(at.dir, transform, id, text, busy);
  await materializeTextPass(records);
  return loadBook(projectDir);
}

/**
 * MATERIALISE — the position's book with its whole chain replayed into it,
 * written out as a book file of its own.
 *
 * ── What it is for, and why it is a file at all ─────────────────────────────
 *
 * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
 * §6.) The engine has never heard of the op grammar and is never going to: the
 * replay lives once, in shared/, because the renderer needs it in-process, so
 * MAIN materialises and the engine compiles what it is handed (§9, R1). This is
 * the seam between those two sentences, and a file is what crosses it.
 *
 * ── IT IS SCRATCH, AND IT IS THE CALLER'S TO SWEEP ──────────────────────────
 *
 * A derived book file is `regenerable` retention in the strongest sense — it is a
 * pure function of a file on disk and a chain in the ledger, and remaking it costs
 * a read and a replay — so nothing catalogues it, nothing points at it, and the
 * job that asked for one removes it when it settles. `into` is the directory it
 * goes in, which the caller chooses precisely because THIS module has no business
 * deciding whether a scratch file belongs in the OS temp directory or beside the
 * project.
 *
 * WRITTEN ATOMICALLY, like every other file this app writes: a temp path and a
 * rename, so an interrupted write leaves nothing rather than half a book — and
 * half a book file is a compile that refuses on a row that was cut in two.
 */
/**
 * DROP DERIVED BOOKS NOTHING IS GOING TO COMPILE, before writing another.
 *
 * Standalone these are swept at settle and this finds nothing. HOSTED NOTHING
 * SWEEPS THEM — the row belongs to the host's queue — so without this they
 * accumulate one per export forever. A day is far longer than any job waits and
 * far shorter than a person would notice the space.
 *
 * Best-effort by construction: a failure here must never stop an export, and a
 * file that will not unlink is one file, not a run.
 */
export async function sweepStaleDerived(into: string): Promise<void> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = await fsp.readdir(into);
  } catch {
    return; // No directory yet: nothing to sweep, and the write will make it.
  }
  await Promise.all(names.map(async (name) => {
    // AND THE NARROWED STAMPS BESIDE THEM (`narrowedStamp`, electron/workspace.ts),
    // which are scratch for exactly one export on exactly this file's terms: named
    // after the derived book, written when a merge sits above a cleanup, and
    // unreferenced the moment that job settles.
    if (!name.endsWith('.book.jsonl') && !name.endsWith('.stamp.json')) return;
    const here = path.join(into, name);
    try {
      const stat = await fsp.stat(here);
      if (Date.now() - stat.mtimeMs > DAY_MS) await fsp.rm(here, { force: true });
    } catch { /* raced with another sweep, or gone already. Either is fine. */ }
  }));
}
