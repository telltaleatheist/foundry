/**
 * book — the book file, made if it is not there, read, and handed to the pane.
 *
 * ── Why this is a module and not four lines in main.ts ──────────────────────
 *
 * Because it is three separate pieces of knowledge that each belong to somebody
 * else, and the only thing this file adds is the ORDER they go in. Where the file
 * lives is `projects.ts`'s (every path in a project is composed there, once, so a
 * branch read cannot end up answering for the other reading's bank). How to run
 * the engine is `engine.ts`'s (this app never imports foundry; it spawns it). What
 * the file's grammar is belongs to `shared/book.ts`, which mirrors the engine's own
 * writer. main.ts registers the door and knows none of it — which is the shape
 * `overlays.ts` and `workspace.ts` already have.
 *
 * ── ENSURING THE FILE IS ALSO THE MIGRATION, AND THAT IS DELIBERATE ─────────
 *
 * Every project in the library predates this format: they hold a bank and no book
 * file at all. Nothing has to be migrated for them, because the book file is
 * DERIVED — the bank is the reset point and the reflow is seconds of arithmetic
 * over it — so "open a read position" and "produce the book file for the first
 * time" are one code path and there is no second one to keep true
 * (docs/RENDERER.md §9, R2).
 *
 * IT IS MADE ONLY WHEN IT IS ABSENT. A book file that exists is the one the ops
 * are keyed to, and re-running the reflow over it because a pane was opened would
 * be this process rewriting the document somebody is editing every time they look
 * at it. Regenerating on purpose is a different gesture and it is not this one.
 *
 * ── Every failure is a sentence, and it carries no path ─────────────────────
 *
 * What comes back from here goes onto the paper (RENDERER-DESIGN.md §5: errors
 * render as main's own sentence on the sheet, never a toast), and the house rule
 * is that a filename never appears in copy a person reads. So the sentence names
 * the BOOK's problem and the terminal gets the path — which is where somebody
 * debugging their own library goes looking, and the one place it is any use.
 */
import { promises as fsp } from 'node:fs';

import { writeBookFile } from './engine';
import { bookAtPosition } from './projects';
import { BookFileError, parseBookFile, type BookOutcome } from '../shared/book';

/** Does this path exist? Nothing else about it is asked. */
async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The book at this project's position — reflowed first if nothing has reflowed it.
 *
 * NEVER ANSWERS EMPTY. A pane with no rows in it and no sentence is
 * indistinguishable from a book with nothing in it, and the two want opposite
 * things from the person looking at them — so every way this can fail comes back
 * as `{ok: false}` carrying words to put on the paper (`BookOutcome`).
 *
 * IT STILL REJECTS FOR A DIRECTORY THAT IS NOT A PROJECT. That is the security
 * gate refusing, not the book being unavailable, and it must not be renderable as
 * a polite sentence in a pane.
 */
export async function loadBook(projectDir: string): Promise<BookOutcome> {
  const at = await bookAtPosition(projectDir);

  if (!await exists(at.book)) {
    /*
     * THE BANK IS PROVEN BEFORE THE ENGINE IS SPAWNED, so that "this project has
     * never been read" is answered in words rather than as whatever the command
     * says about a file it could not open. It is the ordinary state of a project
     * somebody imported five minutes ago and it is not a failure of anything.
     */
    if (!await exists(at.bank)) {
      return {
        ok: false,
        reason: 'This book has not been read yet, so there is nothing to open. Read its pages '
          + 'first and the book is made from them.',
      };
    }
    const made = await writeBookFile(at.bank, at.book);
    if (!made.ok) {
      // The engine's own words to the terminal, with the paths that make them
      // actionable; the sentence the person reads says what happened to the book.
      console.error(`[book] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}`);
      return {
        ok: false,
        reason: 'The pages this book was read from could not be turned into a book. The engine '
          + 'refused, and its own words are in the terminal.',
      };
    }
  }

  let text: string;
  try {
    text = await fsp.readFile(at.book, 'utf8');
  } catch (err) {
    console.error(`[book] ${at.book} could not be read: ${(err as Error).message}`);
    return { ok: false, reason: 'This book was made and then could not be read back.' };
  }

  try {
    const parsed = parseBookFile(text);
    return {
      ok: true,
      // THE TITLE IS THE PROJECT'S. A book file is a list of blocks and has no
      // idea what the book is called; the catalogue is where that has lived for
      // every other surface in this app (`ProjectsService.nameFor`).
      title: at.manifest.title,
      rows: parsed.rows,
      chapters: parsed.header.chapters,
      typography: parsed.header.typography,
      loose: parsed.header.loose,
    };
  } catch (err) {
    if (err instanceof BookFileError) {
      console.error(`[book] ${at.book} is not a book this app can read: ${err.message}`);
      // The parser's sentences are written to be read by a person and name blocks
      // rather than files, so this passes them through instead of paraphrasing.
      return { ok: false, reason: `This book could not be opened: ${err.message}` };
    }
    throw err;
  }
}
