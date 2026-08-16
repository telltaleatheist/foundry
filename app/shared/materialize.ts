/**
 * shared/materialize — THE REPLAY, WRITTEN DOWN AS A BOOK.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
 * §6.) The renderer draws `replayOps(rows, chain)` as a signal; an export needs
 * the same answer as a FILE, because the thing that turns a book into an EPUB is
 * a separate program and the only language it and this app both speak is the book
 * file (docs/BOOK-FILE.md). So this takes the book the reading produced and the
 * ops that were applied to it, and writes the same format back out: same version,
 * same ids, parent ids kept verbatim (§4), struck rows absent, text as the person
 * left it.
 *
 * IT IS PURE, and that is the whole reason it is in shared/ rather than in
 * electron/. It touches no disk, no clock and no Electron; what is in electron/ is
 * the ten lines that read the files and write the answer atomically. A test — and
 * a script — can hand it rows and ops and read the book that comes out.
 *
 * ── THE DERIVED FILE IS THE FINISHED DOCUMENT ───────────────────────────────
 *
 * Which is a stronger statement than "the same book with edits in it", and three
 * of the decisions below follow from it and from nothing else:
 *
 * A STRUCK ROW IS NOT IN IT. Struck is a state of the working document — drawn
 * cancelled, brought back by pressing Delete again — and an edition leaves it out
 * (docs/RENDERER.md §5). The compile therefore never has to know what a strike is.
 *
 * THE SHELF IS NOT IN IT EITHER. A shelved row is out of the flow by the reflow's
 * judgement and stays out unless somebody restores it, which is an op that puts it
 * back in the flow before this ever sees it (`restore-furniture`). Carrying the
 * shelf into a derived file would carry a decision the reader of that file has no
 * ops to act on.
 *
 * AND A STRUCK NOTE TAKES ITS REFERENCE NUMBER WITH IT. *"if i delete footnotes,
 * it removes their corresponding reference numbers."* (§0, ruling 9.) The number
 * belongs to the note, so it goes when the note goes — as a DERIVED FACT computed
 * here, never as a second op recorded beside the first (§2), which is why
 * restoring the note brings the number back for free: the strike is gone from the
 * chain, so this cut never happens. The characters come out of the body text and
 * everything that pointed past them — the other notes' refs, the unlinked markers,
 * the parts that say which banked answer contributed which characters — is moved
 * by exactly as much as was removed.
 *
 * ── AND WHAT IT REFUSES TO PRETEND ABOUT ────────────────────────────────────
 *
 * `parts` on a row somebody restructured is stale by construction (`ReplayedRow`,
 * shared/ops.ts): the ranges claim to tile the row's text and stop doing so the
 * moment a merge concatenates two of them or a split cuts one in half. A book file
 * whose parts do not tile is not a book file — both parsers prove that claim
 * rather than trusting it — so it cannot simply be carried, and there is no
 * arithmetic that recovers the true division of words a person retyped. See
 * `partsFor` for what is written instead, and why it is the only honest thing
 * left to say.
 */
import type {
  BookFile,
  BookLoose,
  BookLooseMarker,
  BookPart,
  BookRef,
  BookRow,
} from './book';
import { replayOps, type BookOp, type MissingOp, type ReplayedRow } from './ops';

/** The derived book, and what the chain could not do to it. */
export interface Materialized {
  book: BookFile;
  /**
   * Ops the replay could not perform — carried out, never swallowed.
   *
   * REPORTED AND NOT FATAL, which is `Replayed.missing`'s own ruling: a chain can
   * name a block a later reading no longer has, and refusing to export somebody's
   * book over one stale strike would be the worst of the three available answers.
   * The caller says the number out loud where somebody can see it.
   */
  missing: MissingOp[];
}

/** A run of characters coming out of a body row — a struck note's number. */
interface Cut {
  at: number;
  len: number;
}

/**
 * Where an offset in the old text lands in the new one, after the cuts.
 *
 * MONOTONE AND EXACT: everything before the offset that was removed is subtracted
 * from it, so a position inside a cut collapses onto the seam and a position after
 * one moves by the whole of what came out. Nothing that reaches this is inside a
 * cut — two reference numbers cannot claim the same characters, which the book
 * file's own parser proves — so every offset it is asked about is a real position
 * in the text that survives.
 */
function mapped(at: number, cuts: readonly Cut[]): number {
  let moved = at;
  for (const cut of cuts) {
    if (cut.at >= at) break;
    moved -= Math.min(at, cut.at + cut.len) - cut.at;
  }
  return moved;
}

/** The text with those runs taken out. */
function cutText(text: string, cuts: readonly Cut[]): string {
  const kept: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    kept.push(text.slice(from, cut.at));
    from = cut.at + cut.len;
  }
  kept.push(text.slice(from));
  return kept.join('');
}

/**
 * The parts a derived row carries.
 *
 * ── A ROW NOBODY EDITED KEEPS THE ENGINE'S OWN ANSWER, VERBATIM ─────────────
 *
 * Which is most of the book, and it matters more than it looks: those ranges were
 * worked out at reflow with the pages in front of the writer, and re-deriving them
 * here would replace the engine's answer with this one for no reason at all.
 *
 * ── A ROW SOMEBODY EDITED SAYS THE ONE THING THAT IS STILL TRUE ─────────────
 *
 * `chars` is a claim about ANOTHER field of the same row — these characters of
 * this text came from that banked answer — and a merge, a split or a retype makes
 * that claim false in a way no arithmetic can repair: the true division of a
 * sentence somebody rewrote is not a fact anybody holds. The format has three
 * spellings available and two of them are lies. Keeping the old ranges is a lie
 * with a number in front of it, and both parsers refuse it outright. Dividing the
 * new text between the old parts in proportion is the same lie with arithmetic in
 * front of it, which the book file's own header names as the thing never to do.
 *
 * So a restructured row carries ONE part, naming where the row STARTED — the same
 * answer the format already gives its `page` and its `box`, and the same one the
 * engine gives a merged block, whose id is minted from its first part and never
 * from the one it swallowed. The other coordinates are not lost by this: the row a
 * merge consumed is not a row of this document any more, and its own name is the
 * only thing anything downstream could have re-keyed through it.
 */
function partsFor(row: BookRow, edited: boolean): BookPart[] {
  const first = row.parts[0];
  if (first === undefined) {
    // Unreachable through the parser, which refuses a row with no parts, and
    // asserted rather than assumed because this is the one function that would
    // otherwise write a book file that cannot be read back.
    throw new Error(`block "${row.id}" carries no parts, so there is nothing to say it came from`);
  }
  if (!edited) return row.parts;
  return [{ src: first.src, page: first.page, chars: [0, row.text.length] }];
}

/** The parts, moved by the cuts — see `mapped`. Ranges still tile, and may empty. */
function cutParts(parts: readonly BookPart[], cuts: readonly Cut[]): BookPart[] {
  return parts.map((part) => ({
    ...part,
    chars: [mapped(part.chars[0], cuts), mapped(part.chars[1], cuts)] as [number, number],
  }));
}

/**
 * The book, with a chain replayed into it and written as the finished document.
 *
 * The order below is the whole of the correctness: the replay first, because
 * every other question is about the book AS IT NOW STANDS; then which rows survive
 * it; then the reference numbers of the notes that did not, because those come out
 * of text the rows that DID survive are made of; and only then the header, whose
 * every list has to name rows this file actually holds.
 */
export function materialize(book: BookFile, ops: readonly BookOp[]): Materialized {
  const replayed = replayOps(book.rows, ops, book.header.loose, book.header.chapters);
  const kept: ReplayedRow[] = replayed.rows.filter(
    (row) => row.struck !== true && row.shelf === undefined,
  );
  const held = new Set(kept.map((row) => row.id));
  /** The file's own words for each id — what "somebody edited this" is measured against. */
  const before = new Map(book.rows.map((row) => [row.id, row.text] as const));

  /*
   * THE NUMBERS OF THE NOTES THAT ARE NOT IN THIS BOOK, gathered off the rows the
   * replay struck. A struck note's `refs` are still exactly where they were —
   * striking a note does not edit the paragraph its number is printed in — so this
   * is the last moment those coordinates are true, and it is where the cut has to
   * be made.
   */
  const cuts = new Map<string, Cut[]>();
  for (const row of replayed.rows) {
    if (row.struck !== true) continue;
    for (const ref of row.refs ?? []) {
      if (!held.has(ref.block)) continue;
      const already = cuts.get(ref.block);
      if (already === undefined) cuts.set(ref.block, [{ at: ref.at, len: ref.len }]);
      else already.push({ at: ref.at, len: ref.len });
    }
  }
  for (const runs of cuts.values()) runs.sort((one, other) => one.at - other.at);

  const rows: BookRow[] = [];
  for (const row of kept) {
    const runs = cuts.get(row.id) ?? [];
    const edited = before.get(row.id) !== row.text;
    const parts = partsFor(row, edited);
    /*
     * `struck` IS NOT A FIELD OF THIS FORMAT and never becomes one. It is the
     * replay's own answer about a row of the working document, and every row that
     * reaches here is one nobody struck — so the field is dropped rather than
     * written as false, which would put a state into a file whose whole claim is
     * that the decisions live somewhere else.
     */
    const { struck: _struck, ...carried } = row;
    if (runs.length === 0) {
      rows.push(parts === row.parts ? carried : { ...carried, parts });
      continue;
    }
    rows.push({ ...carried, text: cutText(row.text, runs), parts: cutParts(parts, runs) });
  }

  /*
   * EVERY REFERENCE THIS BOOK STILL CARRIES, moved to where its characters now
   * are — and dropped where the block it named is not in the book at all, which is
   * what striking a whole paragraph does to the numbers printed in it. A note left
   * pointing at nothing is not an error: it is one of the two LINKING flags, and
   * it goes in the header where a reader can be told about it.
   */
  const orphaned: string[] = [];
  const derived: BookRow[] = rows.map((row) => {
    if (row.refs === undefined) return row;
    const refs: BookRef[] = [];
    for (const ref of row.refs) {
      if (!held.has(ref.block)) continue;
      const runs = cuts.get(ref.block);
      refs.push(runs === undefined ? ref : { ...ref, at: mapped(ref.at, runs) });
    }
    if (refs.length === 0) orphaned.push(row.id);
    return { ...row, refs };
  });

  const markers: BookLooseMarker[] = [];
  for (const marker of replayed.loose.markers) {
    if (!held.has(marker.block)) continue;
    const runs = cuts.get(marker.block);
    markers.push(runs === undefined ? marker : { ...marker, at: mapped(marker.at, runs) });
  }
  const loose: BookLoose = {
    markers,
    notes: [...new Set([...replayed.loose.notes.filter((id) => held.has(id)), ...orphaned])],
  };

  return {
    book: {
      header: {
        // THE ENGINE THAT WROTE THE PARENT, carried and not restamped. This file
        // is a materialisation of that reflow rather than a new reading of the
        // pages, and provenance is a fact about where the words came from.
        engine: book.header.engine,
        language: book.header.language,
        // The receipt this book is a pure function of, verbatim — including its
        // sha, which still identifies the bank underneath every id in the file.
        source: book.header.source,
        chapters: replayed.chapters.filter((chapter) => held.has(chapter.id)),
        typography: book.header.typography,
        /*
         * A DERIVED FILE'S SEAMS ARE SPENT DECISIONS. A seam is an offer to join
         * two paragraphs the reflow declined to join, made to a person with the
         * ops to act on it; by the time a book is being compiled the offer has
         * either been taken (there is a merge in the chain and the two rows are
         * one) or declined by silence. Carrying the list into a document nobody
         * can edit would be an invitation with no door behind it.
         */
        seams: [],
        loose,
      },
      rows: derived,
    },
    missing: replayed.missing,
  };
}
