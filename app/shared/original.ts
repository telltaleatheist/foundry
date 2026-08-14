import type { ProjectDocument } from './types';

/**
 * THE DOCUMENT A PROJECT EXISTS TO HOLD — the one rule, shared by both sides.
 *
 * A project is a folder around ONE book, and everything else in it was made from
 * that book. So there is a right answer to "open this project", and there is a
 * matching right answer to "what happens if this file is deleted": erasing the
 * original erases the thing every other document in the folder was derived FROM,
 * and a project without it is a set of outputs with no source — which is not a
 * project, it is litter. Deleting it therefore deletes the project.
 *
 * IT LIVES IN `shared/` BECAUSE BOTH SIDES HAVE TO AGREE, and they have to agree
 * about a question where disagreeing is expensive in one specific direction: the
 * renderer decides which warning to show and MAIN decides what may actually be
 * erased. Two copies of this ordering that drifted would let the renderer offer
 * "delete this file" over a document main would then refuse — or, far worse,
 * show a file-sized warning for something that takes the whole folder with it.
 *
 * The order, most-original first:
 *
 *   1. THE LIVE PDF (`archive`) — the scan or born-digital PDF the user
 *      imported, which is the thing the project is about. Nearly always this.
 *   2. THE IMPORTED BOOK (`imported`) — a project started from an EPUB the user
 *      already had has no scan; their own book is the original.
 *   3. THE CAST BOOK (`cast`) — a project whose source has been moved or deleted
 *      still has the book Foundry made from it, and treating that as the
 *      original beats treating nothing as one.
 *   4. ANYTHING ELSE STILL OPENABLE — a translation, the real-text PDF. By this
 *      point the question is not "which is the original" but "is there anything
 *      here at all", and the honest answer is whatever there is.
 *
 * MISSING FILES ARE SKIPPED AT EVERY STEP rather than preferred and then failed
 * on: a row that opens or deletes a dead path is a gesture that produces an
 * error about bookkeeping the user never saw. `.txt` is skipped for the older
 * reason — there is no text tab in this app, so it cannot be what a click lands
 * on, and it is never the thing a project is about.
 *
 * Null when the folder holds nothing openable, which is a real state: a project
 * left behind by a run that did not finish.
 */
export function originalOf(documents: readonly ProjectDocument[]): ProjectDocument | null {
  const openable = documents.filter(
    (document) => !document.missing && document.kind !== 'txt');
  const byRole = (role: ProjectDocument['role']): ProjectDocument | undefined =>
    openable.find((document) => document.role === role);
  return byRole('archive') ?? byRole('imported') ?? byRole('cast') ?? openable[0] ?? null;
}

/**
 * Is this path the project's original?
 *
 * Folded, because on Windows one file arrives spelled three ways and the two
 * sides of the app do not always spell it the same way as each other.
 */
export function isOriginal(documents: readonly ProjectDocument[], filePath: string): boolean {
  const original = originalOf(documents);
  if (original === null) return false;
  return fold(original.path) === fold(filePath);
}

/** One spelling for a path, so Windows' three become one. */
export function fold(target: string): string {
  return target.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}
