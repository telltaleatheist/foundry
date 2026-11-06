/**
 * engine-book — writing a book file and an EPUB from it, one writer per file.
 */
import * as path from 'node:path';
import { fold } from '../shared/original';
import { engineCommand, runEngine } from './engine-run';

// ─────────────────────────────────────────────────────────────────────────────
// vlm-book
// ─────────────────────────────────────────────────────────────────────────────

/** What `foundry vlm-book` did, or the sentence saying why it would not. */
export interface BookOutcome {
  ok: boolean;
  /** The engine's own words, when it refused. Never paraphrased. */
  reason: string | null;
}

/**
 * ONE WRITER PER BOOK FILE — the lock that was missing, and whose absence cost a
 * user their figures on 2026-08-19.
 *
 * ── The defect, exactly ─────────────────────────────────────────────────────
 *
 * Two places in this app write the same book file and neither knew about the
 * other. `remakeBookFile` (electron/job-queue.ts) rebuilds it the moment a
 * reading lands, because a fresh bank makes the old book stale by definition.
 * `ensureReadingBook` (electron/book.ts) builds it when somebody opens the book
 * and there is no file yet. Those two events are ONE EVENT in ordinary use: the
 * read finishes, the window is told, the person clicks straight into the book
 * that just appeared. `ensureReadingBook`'s only guard was
 * \`if (await exists(at.book)) return\` — a check-then-act with an await in the
 * middle of it, which is the classic shape of a race and not a lock at all. The
 * file does not exist until the FIRST engine renames its temp file into place at
 * the very end of its run, so for the whole minute that run takes, `exists`
 * answers false and a second engine is spawned over the same target.
 *
 * Two engines over one target is not merely wasteful. `cutFigures`
 * (src/vlm/book-run.ts) clears `readings/<key>.images/` at the top of its run,
 * deliberately, so that a regeneration cannot leave the crop of a figure that is
 * now named something else sitting beside the one that is. The second engine
 * reached that rm while the first was still writing crops into the directory,
 * and Windows — which will not unlink a file another process holds open — raised
 * EBUSY partway through. With different timing it would not have raised anything
 * at all: it would simply have deleted crops the first run had already finished,
 * and the book would have come out naming plates that are not on the disk.
 *
 * ── Why the fix is HERE and not at the two call sites ───────────────────────
 *
 * Because a lock at the call sites is a lock two future callers can forget to
 * take, and there is already a third writer of book files in this module
 * (`writeEpubBook`) reached through the same check-then-act. The contended
 * resource is the OUT PATH, so the gate belongs where the out path is named,
 * which is here. A second caller for a path already being written AWAITS THE
 * FIRST RUN and answers with its outcome — which is the true answer to their
 * question, because a book file is a pure function of the receipt it is made
 * from and one run over that receipt is what both of them wanted.
 *
 * AND WHY A RETRY LADDER WOULD HAVE BEEN THE WRONG FIX. It was the first thing
 * proposed on the channel, when the lock was assumed to be somebody else's — a
 * network share, an antivirus scanner. It is not: the lock was OURS, held by our
 * own second process, and a retry would have let the second engine win the rm a
 * few hundred milliseconds later and delete the first run's finished crops with
 * no error anywhere. It would have hidden a data race behind a green tick. The
 * ladder is still worth having, and it is in `cutFigures` where a genuinely
 * external holder would be met — labelled there as defence in depth, and only as
 * that.
 *
 * FOLDED, on the house rule every path key in this app obeys: on Windows one
 * file arrives spelled three ways and two spellings of one path would be two
 * entries in this map, which is no gate at all. Resolved first, because a
 * relative path and its absolute twin are the same file too.
 *
 * THE ENTRY IS CLEARED WHEN THE RUN SETTLES, FAILURE INCLUDED. A refusal that
 * left its promise in the map would answer every future open of that book with
 * the same stale sentence for the life of the process, and the ordinary cure for
 * a refused reflow — fix whatever it complained about and open the book again —
 * would stop working.
 */
export const writingBook = new Map<string, Promise<BookOutcome>>();

/** See `writingBook`. One run per target path; everybody else awaits it. */
export function oneWriterOf(outPath: string, write: () => Promise<BookOutcome>): Promise<BookOutcome> {
  const key = fold(path.resolve(outPath));
  const running = writingBook.get(key);
  if (running !== undefined) {
    console.log(
      `[engine] ${outPath} is already being written by a run in flight, so this caller waits for `
      + 'that run instead of starting a second engine over the same file.',
    );
    return running;
  }
  const started = write().finally(() => { writingBook.delete(key); });
  writingBook.set(key, started);
  return started;
}

/**
 * Reflow a readings bank into the book file:
 * `foundry vlm-book --readings <bank.jsonl> --out <book.jsonl>`.
 *
 * WHAT THE COMMAND IS FOR, in one line: the bank is one row per PAGE holding the
 * model's answer for it, and it knows nothing about a paragraph — so this is the
 * pass that fuses the hyphens, joins the paragraphs the printer broke across a
 * leaf, cuts the footnote areas into notes and mints an id for every block. The
 * result is the document every op in the project is keyed to (docs/RENDERER.md
 * §1), and it is REGENERABLE: the bank is the reset point, and running this again
 * over the same bank produces the same ids for the same blocks.
 *
 * `--out` MAY NOT BE `--readings`. The bank is the irreplaceable thing in a
 * project — hours of GPU with no second copy anywhere — and the engine writes the
 * book beside it under a name of its own (`bookFileFor`, electron/projects.ts).
 *
 * NEVER THROWS, on `stampEpub`'s and `finalizeEpub`'s rule: this runs on the way
 * into a pane, and a bank the engine could not reflow is a fact about that
 * project that belongs on the sheet in words. What the CALLER MUST NOT DO is
 * treat a refusal as a success — there is no book file after one, so parsing what
 * is at the path would either fail on nothing or read a stale file from an
 * earlier run, and both are worse than the sentence.
 *
 * SERIALISED PER TARGET PATH by `oneWriterOf`, whose docblock carries the whole
 * argument. Two callers for one book file get one engine and one answer, and the
 * caller who arrived second waits rather than racing the first one's figures out
 * from under it.
 *
 * THE PAGES AND `--language` ARE PASSED ONLY WHERE THE CALLER HAS THEM. The pages
 * buy one thing — the figure crops, cut once into `readings/<key>.images/` — and
 * without them the engine cuts nothing and says so; the language goes in the
 * book's header, and the engine's default (`en`) is the engine's own documented
 * rule rather than a spelling this side repeats.
 *
 * ── ONE FIELD FOR THE PAGES AGAIN (Wave 41), AND THE ENGINE KEEPS TWO ───────
 *
 * A `pagesPath` stood beside `pdfPath` from Wave 37 to Wave 41, naming a
 * DIRECTORY of page photographs, because a capture project's archive WAS a
 * folder — `--pdf` was the reflow's only face until Wave 37, so such a project
 * reflowed with no source at all and every Picture block in it refused at export.
 *
 * The app no longer has such a project to describe: a mint writes a PDF and
 * `healMintedArchive` gives one to every project made before it, so
 * `bookAtPosition` answers `pdf` for a photographed book exactly as it does for
 * an imported scan. Owen: *"the system isnt trying to sift through images, it's
 * using the original pdf just like it normally would."*
 *
 * `vlm-book --pages` IS UNTOUCHED AND STAYS. It is engine surface area — a
 * capability the command has, documented on the command, usable from a terminal
 * — and Wave 37's work behind it is exactly as good as it was. What retired is
 * the APP's selection of it, which is a different thing from the ability.
 */
export function writeBookFile(
  readingsPath: string,
  outPath: string,
  opts: { pdfPath: string | null; language: string | null },
): Promise<BookOutcome> {
  return oneWriterOf(outPath, async () => {
    const args = ['vlm-book', '--readings', readingsPath, '--out', outPath];
    if (opts.pdfPath !== null) args.push('--pdf', opts.pdfPath);
    if (opts.language !== null) args.push('--language', opts.language);
    const run = runEngine(args);
    /*
     * The same two minutes `stampEpub` and `finalizeEpub` allow, for work of the
     * same order over the same book — a few hundred pages of banked answers parsed,
     * reflowed and written once. Past that nothing is happening and a pane is
     * waiting on it with `Opening the book…` on screen.
     *
     * THE CLOCK STARTS WHEN THIS RUN STARTS, which is why the gate is outside the
     * timer and not inside it. A caller that waits for somebody else's run is not
     * being timed out at two minutes into its own wait; it is riding a run that
     * has its own two minutes and will answer when that run answers.
     */
    const timer = setTimeout(() => run.cancel(), 120_000);
    const result = await run.done.finally(() => clearTimeout(timer));

    if (result.code !== 0) {
      const said = result.stderr.trim() || result.stdout.trim();
      const unknown = result.code === 2 && /unknown command/i.test(said);
      return {
        ok: false,
        reason: unknown
          ? `vlm-book is not in this engine build (${engineCommand().source}).`
          : said || `The engine exited ${result.code} with nothing to say.`,
      };
    }
    return { ok: true, reason: null };
  });
}

/**
 * Explode an imported EPUB into the book file:
 * `foundry vlm-book --epub <archive.epub> --out <book.jsonl>`.
 *
 * ── The same command, the other source ──────────────────────────────────────
 *
 * A project that arrived as an EPUB has no bank and will never have one: a bank
 * models pages, an EPUB has none, and reading real text back through a vision
 * model would trade exact data for a guess at it (docs/RENDERER.md §6, the
 * refinement paragraph). So the container IS the receipt, `book = f(epub)`, and
 * the engine writes the same book file out of it — the spine is the order, the
 * publisher's markup is the category, its own noteref anchors are the reference
 * markers and its nav is the divisions. Everything downstream — the ops, the
 * panels, the Edition, the export — is identical by construction.
 *
 * NO `--language`, AND THAT IS THE DIFFERENCE FROM `writeBookFile`. The bank
 * route's language is what the person running the read declared, so this side
 * passes it on. An EPUB's package DECLARES its language, and the engine reads it
 * from there; sending a language would overrule the publisher's own statement
 * with a field this project does not have (`bookAtPosition` answers null for an
 * EPUB project, because no reading recorded one).
 *
 * NO `--pdf` EITHER: the figures are copied out of the container, not cut out of
 * a page, because they are already files somebody made.
 *
 * NEVER THROWS, on `writeBookFile`'s rule and for its reason — this runs on the
 * way into a pane.
 *
 * SERIALISED PER TARGET PATH THROUGH THE SAME GATE, and it needs it for the same
 * reason rather than by symmetry: `ensureReadingBook`'s check-then-act guards
 * BOTH of its branches, so two windows opening one imported-EPUB project at once
 * spawn two explodes over one file; and `viewExportedBook` has the same shape
 * over a temp cache two tabs can want at the same instant. A project is never
 * both a bank and a container, so a caller can never be handed the other
 * command's answer for its path — and if that ever stopped being true, one book
 * at one path is still the only correct outcome.
 */
export function writeEpubBook(epubPath: string, outPath: string): Promise<BookOutcome> {
  return oneWriterOf(outPath, async () => {
    const run = runEngine(['vlm-book', '--epub', epubPath, '--out', outPath]);
    // The same two minutes the reflow allows, for work of the same order: one
    // container unzipped, a few dozen documents parsed, one file written.
    const timer = setTimeout(() => run.cancel(), 120_000);
    const result = await run.done.finally(() => clearTimeout(timer));

    if (result.code !== 0) {
      const said = result.stderr.trim() || result.stdout.trim();
      const unknown = result.code === 2 && /unknown (command|option)|--epub/i.test(said);
      return {
        ok: false,
        reason: unknown
          ? `vlm-book cannot explode an EPUB in this engine build (${engineCommand().source}).`
          : said || `The engine exited ${result.code} with nothing to say.`,
      };
    }
    return { ok: true, reason: null };
  });
}
