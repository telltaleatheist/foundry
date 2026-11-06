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
 * `workspace.ts` already has.
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
 * ── AND A TRANSLATION HAS A BOOK FILE OF ITS OWN ────────────────────────────
 *
 * *"When a translate lands, main materializes parent book file + chain ops +
 * records → readings/<key>.<lang>.book.jsonl — same format, parent ids kept
 * verbatim, struck rows absent, text replaced from records. Downstream positions
 * read the NEAREST ancestor book file, so replay is always one short hop."*
 * (docs/RENDERER.md §4.) That file is written HERE, three ways: by the landing
 * the moment the records exist, by a correction appended to those records, and —
 * the ensure posture again — by the first open of a translation recorded before
 * either of those doors existed. The ops replayed on top of it are only the ones
 * made SINCE it (`editsSinceTransform`, shared/ledger.ts); everything above it
 * was baked in when it was written, and replaying those a second time would
 * strike rows that are already gone.
 *
 * ── THE BANK'S IDENTITY IS CHECKED ON EVERY OPEN ────────────────────────────
 *
 * The book file is a pure function of the receipt, and its header carries the
 * receipt's identity (`source.bankSha`, docs/BOOK-FILE.md §2). A loader that
 * finds the bank has changed under the book is holding ids that may name
 * nothing, and the contract's answer is the one given here: REFUSE BY NAME, as
 * a sentence, and let the one door that may rebuild do it as an announced
 * action. That door is the read-landing orchestration's, not this open.
 *
 * ── Every failure is a sentence, and it carries no path ─────────────────────
 *
 * What comes back from here goes onto the paper (RENDERER-DESIGN.md §5: errors
 * render as main's own sentence on the sheet, never a toast), and the house rule
 * is that a filename never appears in copy a person reads. So the sentence names
 * the BOOK's problem and the terminal gets the path — which is where somebody
 * debugging their own library goes looking, and the one place it is any use.
 */
export { bookFigureFile } from './book-figures';
export { materializeTextPass } from './book-translation';
export { loadBook, loadBookAt } from './book-load';
export { correctBookBlock } from './book-correct';
export { materializeBook, applyBookOps, viewExportedBook } from './book-materialize';
export { amendBookOps, savePendingStack, readPendingStack, clearPendingStack } from './book-pending';
