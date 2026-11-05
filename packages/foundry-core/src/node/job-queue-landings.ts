/**
 * job-queue-landings — what a finished reading lands, and remaking a book file.
 */
import * as path from 'node:path';
import { writeBookFile } from './engine';
import { bookAtPosition, projectDirOf } from './projects';
import { samePath } from './job-queue-state';

/**
 * Everything `bookAtPosition` answers, named once so the two halves of a read
 * landing hand each other one shape rather than five arguments. Inferred rather
 * than declared, because the shape is electron/projects.ts's and a copy of it
 * here would be a second declaration of somebody else's answer.
 */
export type BookAtPosition = Awaited<ReturnType<typeof bookAtPosition>>;

/**
 * A READING LANDED, SO ITS ONE DOCUMENT CAN EXIST — the book file. It is not a
 * step; it is recorded as this reading's product (docs/RENDERER.md §6).
 *
 * ── WHICH READING, PROVEN RATHER THAN ASSUMED ───────────────────────────────
 *
 * `recordReading` has just stamped the catalogue and left the pointer standing on
 * the row it landed — a read is not retained beside you (`RETAINED_BESIDE_YOU`),
 * and a replace swaps into the step it re-ran and stands there too — so
 * `bookAtPosition` reads back exactly the reading this job just made: its bank,
 * the language it was asked in, and the archived pages the figures are cut out
 * of — a document or a folder of photographs. That is one source for facts that
 * would otherwise be composed
 * here from a request and a filename.
 *
 * AND IT IS CHECKED, because `recordReading` NEVER THROWS. A catalogue it could
 * not write is a console line of its own and a bank that is still on disk — and
 * the position then still names the reading BEFORE this one, whose book file is
 * about a different pass over the pages. Remaking that would quietly re-cut
 * another reading's figures on the strength of this run finishing. So the two
 * answers are put side by side: the position must name a reading at all, and that
 * reading's bank must be the file this run filled. Anything else is a sentence in
 * the terminal and nothing touched — which is a refusal, not a fallback: there is
 * no second guess at which reading this is, and the reflow stays as it was until
 * somebody opens the book, which ensures it (`loadBook`).
 */
export async function landReadProducts(bankPath: string, readFrom: string): Promise<void> {
  const dir = projectDirOf(bankPath);
  if (dir === null) {
    console.error(`[job] ${bankPath} was filled outside any project, so no book file was made `
      + 'from it.');
    return;
  }
  let at: BookAtPosition;
  try {
    at = await bookAtPosition(dir);
  } catch (err) {
    console.error(
      `[job] the reading of ${path.basename(readFrom)} landed, but ${dir} could not say which `
      + `reading is in effect (${err instanceof Error ? err.message : String(err)}), so no book `
      + 'was made from it.',
    );
    return;
  }
  if (at.reading === null || !samePath(at.bank, bankPath)) {
    console.error(
      `[job] the reading that filled ${bankPath} is not the one ${dir} now stands on `
      + `(${at.reading === null ? 'no reading is recorded there' : at.bank}), so nothing was `
      + 'remade from it — the bank is complete and the book is free to make from it whenever it '
      + 'is asked for.',
    );
    return;
  }
  await remakeBookFile(at);
}

/**
 * THE BOOK FILE, REMADE BECAUSE THE READING LANDED — the one door the contract
 * allows to rebuild one, taken as an announced action.
 *
 * ── Why it overwrites, and why that is the safe direction ───────────────────
 *
 * A book file is a pure function of the receipt (docs/BOOK-FILE.md §1) and is
 * regenerated ONLY deliberately, never silently on open, because ops are keyed to
 * the ids in it. This is the deliberate moment: a NEW BANK has just landed at this
 * path, so a book file sitting beside it is the reflow of answers that no longer
 * exist — stale by definition, and the loader would refuse it by name on the next
 * open (`bankSha`, electron/book.ts). Rebuilding it here is what turns that
 * refusal into a book somebody can read, and the log line is the announcement §2
 * asks for.
 *
 * THE FIGURES COME WITH IT AND ARE NOT THIS SIDE'S BUSINESS. The archived
 * original is passed as `--pdf` and the engine sweeps `readings/<key>.images/`,
 * re-cutting only the pages that carry Picture blocks (src/vlm/book-run.ts). A
 * project whose original is an EPUB has no pages to cut and the engine says so —
 * an ordinary answer, not a hole.
 *
 * THE PAGES FACE WAS WAVE 37 AND IS GONE FROM THIS SIDE AT WAVE 41. It was a
 * real hole: this call passed `--pdf` or nothing, so a captured project — whose
 * archive was a FOLDER — landed its reading and reflowed with no source at all,
 * cutting none of its figures; the book was valid, opened fine, and refused every
 * picture at export months later. Wave 37 gave the engine `--pages` to close it;
 * Wave 41 closed it one layer further back, by making a captured project's
 * archive a PDF, so both faces of this call are one face again.
 *
 * A REFUSAL IS THE ENGINE'S OWN WORDS TO THE TERMINAL AND NOTHING ELSE. The bank
 * is real, it is complete, and it is what those hours bought; reporting the
 * reading as a failure because the reflow after it would not run would be this
 * app calling somebody's GPU time lost over a file it can make again in seconds.
 * The next open of the book makes it (`loadBook`), which is the same command with
 * the same arguments.
 */
export async function remakeBookFile(at: BookAtPosition): Promise<void> {
  console.log(
    `[job] the reading landed, so ${at.book} is being remade from ${at.bank}`
    + `${at.pdf === null ? ' (nothing archived to cut figures from)' : ''}.`,
  );
  const made = await writeBookFile(at.bank, at.book, {
    pdfPath: at.pdf,
    language: at.language,
  });
  if (!made.ok) {
    console.error(
      `[job] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}\n`
      + 'The bank is complete and the reading stands; opening the book makes it again.',
    );
  }
}
