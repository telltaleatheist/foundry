/**
 * clean/targets — the two shapes the vendored pass was typed against, re-homed.
 *
 * `tts-number-rules.ts` and `tts-number-normalizer.ts` arrived here importing
 * `NarrationTextRewrite` and `NarrationNumberTarget` from BookForge's
 * `electron/epub-processor.ts` — a 9,000-line module that opens zips, parses
 * XHTML with xmldom, walks a spine and writes an EPUB back out. Both imports
 * are `import type`, and both name a plain data record with no method on it. So
 * what the pass actually depended on was thirteen fields, and what dragging the
 * module across would have bought is an EPUB reader inside an engine that
 * already has one.
 *
 * They are copied here verbatim in their fields and their comments, with the
 * two changes the engine forces named below, because they are the vocabulary
 * every stage of the pass speaks and a second spelling of them is the drift
 * this whole move exists to remove.
 *
 * ── WHAT `segments` IS, AND WHY THE PORT LIVES OR DIES ON IT ────────────────
 *
 * BookForge's targets are ELEMENTS of a document, and `segments` is the length
 * of each descendant TEXT NODE in order, summing to `text.length`. Everything
 * the pass refuses about markup is expressed against that one array: a span
 * that fits inside one segment can be spliced into that text node with every
 * tag around it untouched; a span that crosses a boundary would have to reach
 * across an `<em>`, a `<sup>` or a link, and is refused `SPANS_MARKUP` rather
 * than flattened. Three separate copies of the same four-line walk enforce it —
 * `withinOneNode` in `applyNumberRules`, `withinOneNode` in
 * `validateNumberEdits`, and `nodeHolding` in the punctuation stage.
 *
 * FOUNDRY HAS NO DOCUMENT TREE HERE. A block of a book file is one string in
 * the flowing dialect (docs/BOOK-FILE.md; `src/vlm/dots.ts`), and its markup is
 * IN that string: `**bold**`, `*italic*`, and a run of Unicode superscript
 * digits for a note marker. There are no text nodes to measure.
 *
 * So the port does not weaken the rule, it RE-SPELLS what a segment is:
 * `markerSegments` (src/clean/segments.ts) cuts a row into the runs of plain
 * text between its inline markers and the markers themselves, in order,
 * summing to `text.length` exactly as a document's text nodes do. Every one of
 * those three checks then works unchanged, and the disposition they record is
 * still `SPANS_MARKUP`, because it still means the same thing: an edit may not
 * reach across an inline marker. That is the whole of the marker rule, and it
 * is enforced by code nobody had to re-derive.
 */

/**
 * One span of a target's text, replaced by the words it is read as.
 *
 * `at` is an offset into the target's OWN text and it is carried rather than
 * re-derived because the pass that produced the edit is the one that proved the
 * span occurs exactly once. Re-searching here would be a second opinion about
 * where the edit goes, and the two could differ.
 */
export interface NarrationTextRewrite {
  /** The printed text, copied verbatim from the target. */
  find: string;
  /** What the narrator says instead. */
  replace: string;
  /** Where it sits in the target's text. */
  at: number;
}

/**
 * What kind of thing a target is.
 *
 * BookForge's four are an element of a chapter, a nav anchor, an NCX label and
 * the OPF title. Foundry's route has neither a nav nor an NCX to read — it is
 * handed the BOOK, before any of that is rendered — so two of its own are added
 * rather than borrowing a word that would be false in the record:
 *
 *  - `row` is a block of the book file, named by its row id (`bookrows.ts`).
 *  - `chapter` is a division's title, named `chapter:<id>` (`records.ts`).
 *
 * The four EPUB kinds stay in the union because the record types quote it and
 * because the training side reads records written by both programs; a value
 * this engine never produces costs nothing and keeps one vocabulary.
 */
export type NarrationNumberTargetKind = 'unit' | 'nav' | 'ncx' | 'opf-title' | 'row' | 'chapter';

/**
 * One piece of a book that a voice reads aloud, as the normalizer sees it.
 *
 * `segments` is what makes an edit provably safe to apply without touching
 * markup — see this file's header for what a segment is on each route. A span
 * that fits inside ONE segment can be spliced and leave the markup alone; a span
 * that crosses a boundary is refused (`SPANS_MARKUP`) by the caller, which is
 * the only place that disposition can be decided without re-reading the source.
 */
export interface NarrationNumberTarget {
  /** How the writer finds this again: a row id, or `chapter:<division id>`. */
  key: string;
  kind: NarrationNumberTargetKind;
  /** Where this lives — the book file's path, for the record and the log. */
  file: string;
  /** The element's tag, lowercased. `''` on a route with no markup around it. */
  tag: string;
  /** The book's own word for this block — the dots category, lower-cased. */
  statedCategory: string | null;
  /** The whole of the block's text, in the dialect the rows are written in. */
  text: string;
  /** The length of each segment, in order. Sums to `text.length`. */
  segments: number[];
  /**
   * THE WHITESPACE IN THIS TEXT IS THE AUTHOR'S, and no pass may touch it.
   *
   * A `<pre>` on the EPUB route. Always false on the book-file route and that
   * is stated rather than assumed: a book file row carries no styling and no
   * `white-space` declaration, so there is nothing to read the answer off. What
   * it costs is named in docs/CLEAN-TEXT.md — a code listing the vision model
   * categorised as `Text` is canonicalized like prose here, where the EPUB
   * route would have refused it.
   */
  preformatted: boolean;
}
