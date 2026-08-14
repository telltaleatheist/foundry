import type { ProjectDocument } from './types';

/**
 * WHICH ROW IS THE BOOK — the rule, shared by both sides.
 *
 * ── What this used to be, and why it changed shape ──────────────────────────
 *
 * It used to pick a FILE out of a project by an ordering of roles: the archived
 * scan first, then an imported book, then a cast one. That was the right answer
 * to the wrong question, and the question was wrong because a project's rows
 * were files. Now a row is a FILE TYPE with a chain behind it, and the question
 * has a direct answer: the book is the row whose chain STARTS with the file the
 * user handed over.
 *
 * `ProjectDocument.origin` carries that, decided in `summarise` from the step's
 * own recorded cost — the origin step of the imported type is the one marked
 * irreplaceable, because it came from outside this program and there may be no
 * other copy of it anywhere. So the ordering is gone and with it the chance of
 * the two sides ordering differently.
 *
 * ── Why both sides need it ──────────────────────────────────────────────────
 *
 * The renderer decides which warning to show; MAIN decides what may actually be
 * erased. Two copies of this rule that drifted would let the renderer offer
 * "delete this file" over the document every other document was made FROM — or,
 * far worse, show a file-sized warning for something that takes the whole folder
 * with it.
 */
export function bookRow(documents: readonly ProjectDocument[]): ProjectDocument | null {
  return documents.find((document) => document.origin) ?? null;
}

/**
 * The row a click on a project opens, and what a delete of it would mean.
 *
 * The book itself where there is one; otherwise whatever the project does have,
 * because a project that lost its import is still a folder with work in it and
 * a row that opens nothing is worse than a row that opens something.
 *
 * MISSING ROWS ARE SKIPPED rather than preferred and then failed on: a click
 * that lands on a dead path produces an error about bookkeeping the user never
 * saw. `.txt` is skipped for the older reason — there is no text tab in this
 * app, so it cannot be what a click lands on.
 */
export function originalOf(documents: readonly ProjectDocument[]): ProjectDocument | null {
  const openable = documents.filter(
    (document) => !document.missing && document.kind !== 'txt');
  return openable.find((document) => document.origin) ?? openable[0] ?? null;
}

/** Is this row the book — the one whose delete is the project's delete? */
export function isBook(documents: readonly ProjectDocument[], filePath: string): boolean {
  const book = bookRow(documents);
  if (book === null) return false;
  return fold(book.path) === fold(filePath)
    || book.steps.some((step) => fold(step.file).endsWith(fold(filePath).split('/').pop() ?? ''));
}

/** One spelling for a path, so Windows' three become one. */
export function fold(target: string): string {
  return target.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}
