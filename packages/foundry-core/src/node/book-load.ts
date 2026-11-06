/**
 * book-load — loading a book file, and a book from its parts.
 */
// From the allow-list's own file, not documents.ts — that one holds the window.
import { admit } from './openable';
import { bookAtPosition, imagesDirFor, ledgerOf } from './projects';
import { type BookOutcome } from '../shared/book';
import type { LedgerStep } from '../shared/types';
import { figuresPrefixFor } from './book-figures';
import { openBookAtPosition } from './book-open';
import { sourceOfTranslation } from './book-translation';

/**
 * The book at this project's position — reflowed first if nothing has reflowed
 * it, and handed to the pane with the two things the file itself cannot say.
 *
 * NEVER ANSWERS EMPTY (`BookOutcome`): a pane with no rows in it and no sentence
 * is indistinguishable from a book with nothing in it, and the two want opposite
 * things from the person looking at them.
 */
export async function loadBook(projectDir: string): Promise<BookOutcome> {
  return await bookFrom(projectDir, null);
}

/**
 * THE BOOK AS OF A NAMED STEP — Compare's read, and the only new question this
 * unit asks of main.
 *
 * ── It is `loadBook` with the row named instead of pointed at ───────────────
 *
 * Every piece of machinery this needs already existed and already took the
 * parameter: `openBookAtPosition` has carried a `from: LedgerStep | null` since
 * translations began materialising their derived books at the LANDING rather than
 * at the pointer, and `bookAtPosition` and `editsSinceTransform` take it for the
 * same reason. All that was missing was a door that turns an id into that step. So
 * this is not a second replay — it is the replay, asked about a different row, and
 * `bookFrom` below is the body both doors share so that it cannot become two.
 *
 * WHY THE COMPARISON NEEDS IT AT ALL. The compared column is locked to a step the
 * person picked out of their own history, and the position is somewhere else by
 * definition — that is what comparing means. `book:load` would answer with the
 * book at the POINTER, which is the book they are already looking at in the other
 * column, and the feature would draw the same page twice.
 *
 * A STEP THIS PROJECT DOES NOT HOLD IS A SENTENCE, NOT A THROW, because every
 * other way this call fails is a sentence the sheet draws (`BookOutcome`) and a
 * stale id is the ordinary consequence of a delete landing between the picker
 * being drawn and the answer arriving. The one thing that still rejects is the
 * directory gate, which is `bookAtPosition`'s and refuses before a byte is read.
 */
export async function loadBookAt(projectDir: string, stepId: string): Promise<BookOutcome> {
  /*
   * PROVEN FIRST, AND BY THE GATE THE REST OF THE FAMILY USES. `bookAtPosition`
   * runs `deletableProjectDir` before it touches the disk, so asking it for the
   * project is how this door refuses a directory that is not one of Home's — the
   * same refusal, in the same place, rather than a second check written here that
   * could come to disagree with it.
   */
  const at = await bookAtPosition(projectDir);
  const step = ledgerOf(at.manifest).steps.find((row) => row.id === stepId) ?? null;
  if (step === null) {
    return {
      ok: false,
      reason: 'That step is not in this book\'s history any more, so there is nothing to compare '
        + 'against. It was probably deleted while this column was open.',
    };
  }
  return await bookFrom(projectDir, step);
}

/**
 * The body `loadBook` and `loadBookAt` share — everything from the replay to the
 * pair, with the row it is about handed in.
 *
 * `from === null` IS THE POSITION and is what every viewer in the app asks for;
 * a step is Compare's read-only column. Nothing below branches on which of the two
 * it was, and that is the point: a compared step gets the same figures prefix, the
 * same unplaced sentences and the same aligned pair as standing on it would,
 * because it IS standing on it — read-only, in the other column.
 */
export async function bookFrom(projectDir: string, from: LedgerStep | null): Promise<BookOutcome> {
  const read = await openBookAtPosition(projectDir, from);
  if (!read.ok) return read;
  const { at, parsed, ops, tip, transform } = read.opened;
  const unplaced = read.opened.unplaced ?? [];
  /*
   * The figures prefix is minted only when a row will ask for one. `null` is the
   * pane's ordinary answer for a book with no cut images — no --pdf at reflow, or
   * no pictures in the book — and the plate placeholder is what draws in that
   * silence.
   */
  const figures = parsed.rows.some((row) => row.image !== undefined)
    ? figuresPrefixFor(imagesDirFor(at.bank))
    : null;
  /*
   * THE SCAN, FOR THE PAGE-BESIDE-THE-BLOCK PANE — `at.pdf`, which is
   * `bookAtPosition`'s own resolution of it and not a second one composed here.
   * That field is already null for an EPUB project and for a project holding no
   * PDF archive, which is exactly the silence `BookLoad.originalPath` documents,
   * so this needs no test of its own: asking the resolver twice would be two
   * answers to "what did this reading photograph".
   *
   * ── AND IT IS ADMITTED HERE, WHICH IT HAS TO BE ────────────────────────────
   *
   * `document:read-bytes` is gated by `admitted`, whose refusal is *"was never
   * opened in this app"* — and an archived scan HAS never been opened. Nobody
   * opened the file; they opened the PROJECT, and the book they are reading is
   * a bank made from a document they may never have seen a page of. So without
   * this line the pane asks for the one thing it exists to show and is refused
   * by the app's own front door. MEASURED, not reasoned: the card mounted, sat
   * with an unpainted 300x150 canvas, and settled on the sentence *"Error
   * invoking remote method 'document:read-bytes'"*. Six gates were green.
   *
   * `admit` and not a widening of the gate, because `admit`'s own docblock is
   * this exact case written down in advance: *"MAIN RESOLVED IT, SO MAIN ADMITS
   * IT — for the paths this process composes and then hands to a renderer that
   * is about to open them. Never for a path the renderer named."* This process
   * composed it, out of the catalogue, and the renderer is about to open it.
   *
   * NO EXISTENCE CHECK. The pane opens it and says what happened; a check here
   * would be a second opinion taken a moment earlier, and the honest failure is
   * the one the reader meets at the moment they ask for the page.
   */
  if (at.pdf !== null) admit(at.pdf);
  /*
   * A SECOND ADMIT STOOD HERE FOR THE PAGES FOLDER (Wave 41's gravestone). A
   * captured project's archive was a directory of photographs, so `at.pdf` was
   * null and a second field held the paper. There is one field now and one
   * admit: a photographed book's original is a PDF like any other's.
   */
  return {
    ok: true,
    // THE TITLE IS THE PROJECT'S. A book file is a list of blocks and has no idea
    // what the book is called; the catalogue is where that has lived for every
    // other surface in this app (`ProjectsService.nameFor`).
    title: at.manifest.title,
    language: parsed.header.language,
    rows: parsed.rows,
    chapters: parsed.header.chapters,
    typography: parsed.header.typography,
    seams: parsed.header.seams,
    loose: parsed.header.loose,
    figures,
    originalPath: at.pdf,
    ops,
    tip,
    /*
     * The sentences an old save left behind, when there are any — carried on the
     * load so the sheet can say them where the book is, rather than raised as a
     * failure of a book that opened perfectly well. See `BookLoad.unplaced`.
     */
    ...(unplaced.length > 0 ? { unplaced } : {}),
    /*
     * AND THE PAIR, WHEN THERE IS ONE — *"two scroll-locked columns over two book
     * files with the same ids"* (docs/RENDERER.md §5), carried in the one answer
     * the pane already asks for. See `sourceOfTranslation` for what the left-hand
     * rows are and why they are rows and nothing else.
     */
    translation: transform === null
      ? null
      : {
        // The step's own param, which is where a translation's language has lived
        // since `recordTextPass` began writing it: nothing reads a language out
        // of a file of sentences. `parsed.header.language` says the same thing —
        // `translated` declares it from this very field — and this is the side of
        // the pair that is a fact about the STEP rather than about a file.
        language: transform.params?.language?.trim() ?? parsed.header.language,
        // AND WHICH REWRITE, WHERE THERE WAS ONE. The step's own ACTION says which
        // of the three passes this is now (2026-09-05), and the mode says which of
        // the three rewrites a simplify was — which is what the pane's sentences
        // name. Absent for a translation and for a cleanup, neither of which has
        // one; `readParams` guarantees that a `rewrite` which survived parsing is
        // a mode this build can name.
        ...(transform.params?.rewrite !== undefined ? { rewrite: transform.params.rewrite } : {}),
        source: await sourceOfTranslation(at.dir, ledgerOf(at.manifest), transform),
      },
  };
}
