/**
 * clean/digest — what makes the stamp a claim the render door can CHECK.
 *
 * ── THE GAP THIS CLOSES, AS IT WAS MEASURED ─────────────────────────────────
 *
 * BookForge measured it on 2026-09-05: `vlm-compile --narration-stamp` stamped
 * whatever book it was handed. Compiling the UNCLEANED parent book with the flag
 * produced an EPUB whose package document claimed a narration text cleanup over
 * text still reading *"Dr. Smith"* and *"$5,000"* — a perfectly well-formed
 * stamp, every one of its six fields true about a pass that really did run, and
 * a lie about the file it was written into. The render door reads the FILE, so
 * it believed it, and the narrator read the digits.
 *
 * Owen's ruling the same day: *"recompute over the book handed and refuse by
 * name on mismatch."* So `clean-text` now writes down WHAT it cleaned, block by
 * block, and every command that writes that stamp into a book recomputes the
 * same thing over the book it is actually holding.
 *
 * ── THE TEXT FORM, DEFINED ONCE, HASHED BY BOTH SIDES ───────────────────────
 *
 * A digest is only a check if the two sides hash the same string, so there is
 * ONE definition of what that string is and both sides call the same function
 * to hash it:
 *
 *   THE BLOCK'S OWN TEXT, AS THE BOOK FILE HOLDS IT — the flowing dialect
 *   string (docs/BOOK-FILE.md; `**bold**`, `*italic*`, a run of superscript
 *   digits for a note marker), BEFORE any rendering transform. Before the
 *   emitter turns it into XHTML, before entities are escaped, before pagebreak
 *   markers are written into it, before a superscript run becomes a noteref
 *   anchor, and before the nav or the OPF have been thought about.
 *
 * On the writing side that string is the cleaned text a record's `text` field
 * holds — or, at a position where no row was appended because nothing changed,
 * the book's own text, which is what materialisation leaves there. On the
 * reading side it is `BookRow.text` at that position in the book handed. The two
 * are the same string when, and only when, the book handed is the one the
 * cleanup produced. That is exactly the question being asked.
 *
 * WHY NOT HASH THE RENDERED XHTML. Because the renderer is allowed to change:
 * an emitter that writes `&#8217;` where it used to write `’`, or a pagebreak
 * marker in a new place, would break every digest in every stamp on disk while
 * changing not one word of anybody's book. The text is the thing the cleanup
 * acted on and the thing a narrator reads; it is the thing worth pinning.
 *
 * ── WHY A POSITION THE BOOK DOES NOT HAVE IS SKIPPED, NOT REFUSED ───────────
 *
 * Owen ruled it and the reason is the shelf. A person strikes a block after the
 * cleanup ran — a running head the classifier missed, a duplicated paragraph —
 * and the block is legitimately gone from the book without one character of the
 * remaining text having moved. Refusing that would mean any edit that REMOVES
 * something invalidates a cleanup that is still entirely true about everything
 * left, and the only way out would be to re-buy the whole book's model time.
 * So an absent position is SKIPPED AND COUNTED, said out loud, and a position
 * that is PRESENT and DIFFERENT refuses: the difference is that the second one
 * is text this cleanup never saw being shipped under a claim that it did.
 *
 * The one absence that is not an edit is EVERY absence. A stamp naming
 * positions of which not one is in this book is not a book somebody trimmed, it
 * is a stamp about a different book — `refuseForeignRecords`' existence test,
 * one file over, for its reason.
 */
import { createHash } from 'node:crypto';

import { chapterPosition } from '../translate/records.js';
import type { BookFile } from '../vlm/book-file.js';

/**
 * Stamped into every block digest, so a change to WHAT is hashed cannot be
 * mistaken for a change to the text.
 *
 * `bank.ts`'s `KEY_FORMATS` rule. If the text form defined in this file's header
 * ever moves, this string moves with it, every digest on disk stops matching,
 * and every stamped book refuses at the door — which is loud, correct, and the
 * only honest outcome for a check whose meaning changed.
 */
const DIGEST_FORMAT = 'clean/blocktext/v1';

/** Joined with NUL so no field's content can spell another's boundary. */
const NUL = String.fromCharCode(0);

/**
 * One block's text, as one hex string.
 *
 * THE WHOLE DIGEST, never a prefix. `bank.ts` argues it for a cost cache and it
 * is stronger here: a truncated digest that collides is not a missing check, it
 * is a block of somebody's book passing a check it should have failed, and the
 * failure it was meant to catch shipping to a narrator. A sidecar is not a
 * package document and 64 characters a block is what a check nobody has to
 * reason about costs.
 */
export function blockDigest(text: string): string {
  return createHash('sha256').update([DIGEST_FORMAT, text].join(NUL), 'utf8').digest('hex');
}

/**
 * Every block digest as ONE compact digest, order-independent.
 *
 * This is the field that goes in the package document, because a `<meta
 * content=…>` holding thousands of hashes is not a package document — it is a
 * sidecar somebody pasted into a book. What it is good for is the whole-book
 * question: two stamps carrying the same `textDigest` describe the same text at
 * the same positions, and a person comparing two files has one string to look
 * at rather than three thousand.
 *
 * ORDER-INDEPENDENT BY SORTING HERE, rather than by taking the caller's order.
 * A `Map`'s iteration order is an accident of insertion — the order the plan
 * happened to walk the book in — and two runs that produced identical block
 * digests must produce an identical string or the field means nothing. The
 * position goes into the hash beside its digest, so moving a paragraph's text
 * to a different position changes the answer, which is the point: a book whose
 * blocks were reordered is not the book that was cleaned.
 */
export function textDigestOf(blocks: ReadonlyMap<string, string>): string {
  const lines = [...blocks.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([position, digest]) => `${position}${NUL}${digest}`);
  return createHash('sha256').update([DIGEST_FORMAT, ...lines].join('\n'), 'utf8').digest('hex');
}

/**
 * Every position a book file holds, and the text it holds there.
 *
 * THE READING SIDE OF THE CONTRACT, and deliberately not `bookRowPlan`. The
 * plan decides which blocks are worth ASKING a model about — it skips a formula,
 * a picture and a blank, it takes a table apart into cells, and it has opinions
 * about chapter titles. None of that is a question here. Here the question is
 * only *"what does this book say at the position the stamp names?"*, and the
 * answer for every position is the row's own text: for a `Table` row that is the
 * whole grid, which is exactly what a record about a Table row holds
 * (`bookrows.ts`, `BookBlock.id`).
 *
 * A SHELVED ROW IS NOT IN THE BOOK and is therefore not in this map — the flow
 * is the book, which is `vlm-compile`'s own line of the same argument. It comes
 * back to the caller as an ABSENT position, which is skipped and counted. See
 * this file's header for why that is the right answer and not a hole.
 */
export function bookPositionTexts(book: BookFile): Map<string, string> {
  const texts = new Map<string, string>();
  for (const row of book.rows) {
    if (row.shelf !== undefined) continue;
    texts.set(row.id, row.text);
  }
  // A division's name is a position like any other (`chapterPosition`,
  // records.ts) and it is the one position that is not a row.
  for (const chapter of book.chapters) texts.set(chapterPosition(chapter.id), chapter.title);
  return texts;
}

/** What a recompute found. Every field reaches the log, whatever the verdict. */
export interface StampCheck {
  /** Positions the stamp names that this book has, and that agreed. */
  matched: number;
  /** Positions the stamp names that this book does not have at all. */
  skipped: number;
  /** Positions that are present and hold different text. Empty on a pass. */
  differing: string[];
}

/** How many differing positions a refusal names before it says "and N more". */
const NAMED_IN_REFUSAL = 5;

/**
 * Recompute a stamp's block digests over the text actually in hand.
 *
 * Returns the tally on agreement and THROWS on any disagreement, because the
 * caller's next act is to write the stamp into a package document: past this
 * point the claim is in somebody's book, and a reader downstream has no way to
 * tell a stamp that was checked from one that was not.
 */
export function checkStampBlocks(request: {
  /** `blocks` out of the stamp: position → digest of the text the pass produced. */
  blocks: Readonly<Record<string, string>>;
  /** Position → text, as the thing being stamped actually holds it. */
  texts: ReadonlyMap<string, string>;
  /** The stamp file, for the refusal. */
  stampPath: string;
  /** The book being stamped, for the refusal. */
  where: string;
  /** What to tell somebody to do instead. Each caller's own route. */
  remedy: string;
  /** Every refusal is a class the caller already throws. */
  fail: (message: string) => never;
}): StampCheck {
  const named = Object.entries(request.blocks);
  let matched = 0;
  let present = 0;
  const differing: string[] = [];
  for (const [position, digest] of named) {
    const text = request.texts.get(position);
    if (text === undefined) continue;
    present += 1;
    if (blockDigest(text) === digest) matched += 1;
    else differing.push(position);
  }

  /*
   * NOT ONE POSITION IN COMMON IS NOT A TRIMMED BOOK.
   *
   * `refuseForeignRecords` (src/clean/run.ts) makes this argument about a
   * records file and it is the same argument: absence is the ordinary
   * consequence of an edit, and TOTAL absence cannot be. A stamp whose every
   * position this book has never heard of was written about a different book —
   * or by the `--epub` route, whose positions are an archive's own coordinates
   * and which no book file can answer for — and skipping all of it would let
   * that stamp through unchecked, which is the whole defect this file exists to
   * end.
   */
  if (named.length > 0 && present === 0) {
    request.fail(
      `--narration-stamp ${request.stampPath} names ${named.length} cleaned block position(s), and `
      + `${request.where} has not one of them. That stamp was written about a different book. `
      + `${request.remedy} Nothing was written.`,
    );
  }

  if (differing.length > 0) {
    const shown = differing.slice(0, NAMED_IN_REFUSAL).join(', ');
    const more = differing.length > NAMED_IN_REFUSAL
      ? ` and ${differing.length - NAMED_IN_REFUSAL} more`
      : '';
    request.fail(
      `--narration-stamp ${request.stampPath} claims a narration text cleanup over ${named.length} `
      + `block(s), and ${differing.length} of them do not hold the text that cleanup produced — `
      + `${shown}${more}. THE BOOK HANDED IS NOT THE ONE THIS CLEANUP PRODUCED: a stamp is a claim `
      + 'about a FILE, and this recomputed it over the book it was actually given. '
      + `${request.remedy} Nothing was written.`,
    );
  }

  return { matched, skipped: named.length - present, differing };
}
