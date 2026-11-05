/**
 * clean/segments — where a row's inline markers sit, so a cleanup may not
 * reach across one.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 *
 * BookForge's pass runs over a document tree, and every refusal it makes about
 * markup is expressed against ONE array: the length of each descendant text
 * node of an element, in order, summing to the element's text. A span that fits
 * inside one of those lengths can be spliced into that text node with every tag
 * around it untouched; a span that crosses a boundary would have to reach
 * across an `<em>`, a `<sup>` or a link, and it is refused `SPANS_MARKUP`
 * rather than flattened. Three copies of the same four-line walk enforce it —
 * `withinOneNode` inside `applyNumberRules`, `withinOneNode` inside
 * `validateNumberEdits`, and `nodeHolding` in the punctuation stage.
 *
 * A BOOK FILE ROW HAS NO TEXT NODES. It is one string in the flowing dialect
 * (docs/BOOK-FILE.md; `dotsInline`, src/vlm/dots.ts), and its markup is IN the
 * string: `**bold**`, `*italic*`, `***both***`, `_italic_`, and a run of Unicode
 * superscript digits for a note marker. There is nothing to measure the length
 * of, so the port would have had two choices and took neither of the obvious
 * ones:
 *
 *  - HAND THE MODEL ONE SEGMENT (`[text.length]`) — which is what the vendored
 *    `normalizeTextBlocks` does for the audition path, and it says so:
 *    *"a block is one text node, so SPANS_MARKUP can never fire"*. On a `.txt`
 *    audition that is true and harmless. On a BOOK it would mean a punctuation
 *    span or a model edit could delete one of a pair of asterisks, and the
 *    damage does not show until the book is rendered — a `<strong>` that never
 *    closes, or the emitter's single-star pass pairing the survivor with a star
 *    on the far side of an emitted element (`starEmphasis`, src/vlm/dialect.ts,
 *    which carries the measured version of that failure).
 *  - MASK THE MARKERS the way `translate` does (`textmask.ts`) and show the
 *    model prose with `⟦e1⟧` in it. That breaks the pass at its centre: the
 *    validators judge an edit by its WORDS — `keepsEveryWord`, `classifyEdit`,
 *    the one-token law — and a token is a word to all of them. `⟦e1⟧` would be a
 *    dropped word here and an added word there, and the one-token law would be
 *    deciding cases about this program's own private syntax.
 *
 * SO A SEGMENT IS RE-SPELLED, AND NOTHING ELSE MOVES. `markerSegments` cuts a
 * row into the runs of plain text between its markers and the marker runs
 * themselves, in order, summing to `text.length` exactly as a document's text
 * nodes do. All three checks then work unchanged, on unchanged code, and the
 * disposition they record is still `SPANS_MARKUP` — because it still means what
 * it always meant: an edit may not reach across an inline marker.
 *
 * ── WHY THIS IS A SUPERSET AND NOT A COPY OF THE EMITTER'S PATTERNS ─────────
 *
 * Two files in this repo already decide what emphasis IS. `starEmphasis`
 * (src/vlm/dialect.ts) is the one body of the star rules — `***` first, then
 * `**`, then a single `*` whose capture may not cross a tag — and
 * `inlineMarkdown` adds `_underscore_` beside it. `textmask.ts` carries a
 * narrower pair for the masking `translate` does. They disagree, in small ways,
 * about unpaired stars.
 *
 * THIS FILE ASKS A DIFFERENT QUESTION AND ITS ERRORS ARE NOT SYMMETRIC. A
 * renderer asks *"is this pair emphasis?"* and has to be right, because a wrong
 * answer is visible on the page. This asks *"could a character here be markup?"*
 * — and the two ways of being wrong cost wildly different things:
 *
 *   over-protect  one cleanup span is refused, BY NAME, in the receipt and in
 *                 the stamp's `punctuationRefused` count. Somebody can read it.
 *   under-protect a star is deleted from the middle of a book by a pass that
 *                 reported success, and it is found by a reader.
 *
 * So the boundary is drawn on the CHARACTERS rather than on any one file's
 * pairing rule: every maximal run of `*`, `_` or superscript digits is a marker
 * segment, paired or not. That is provably a superset of every pattern either
 * emitter applies — each of them matches only spans built out of these
 * characters — so no marker any renderer would write can fall inside a plain
 * segment, however the pairing rules move. What it costs is named: an edit
 * spanning the underscore of `AfW_HH_231191` is refused, and a lone asterisk a
 * scan left in the prose protects the two characters around it.
 *
 * IT FOLLOWS THE ROW OUT AND NEVER BACK IN. Nothing here rewrites, escapes or
 * re-cases anything; the marker runs are carried through the whole pass as
 * bytes of segments no edit is allowed to touch, which is what
 * docs/CLEAN-TEXT.md means by *markers are preserved byte-for-byte around
 * unchanged text*.
 */

/**
 * A character that could be inline markup in the flowing dialect.
 *
 * `*` (every emphasis rule either emitter has), `_` (`inlineMarkdown`'s second
 * em pattern), and the ten Unicode superscript digits `SUPERSCRIPT_RUN` claims
 * (src/vlm/dots.ts) — a footnote reference number, which is atomic: the note
 * apparatus resolves a note BY that number, so an edit that reached into one
 * would break the link rather than change a word.
 */
const MARKER_RUN = /[*_⁰¹²³⁴⁵⁶⁷⁸⁹]+/g;

/**
 * A row's text as segment lengths — plain, marker, plain, marker — in order.
 *
 * Sums to `text.length`, always, which is the contract every reader of this
 * array checks (`applyNumberRules` throws on a mismatch by name). A row with no
 * marker in it is `[text.length]`, which is the same array the audition path
 * passes and means the same thing: one span, nothing to reach across.
 *
 * The empty string is `[]` rather than `[0]`, because a zero-length segment is
 * a boundary that holds nothing and `nodeHolding` would report an empty span as
 * living inside it.
 */
export function markerSegments(text: string): number[] {
  if (text.length === 0) return [];
  const segments: number[] = [];
  let at = 0;
  for (const match of text.matchAll(MARKER_RUN)) {
    const start = match.index;
    if (start > at) segments.push(start - at);
    segments.push(match[0].length);
    at = start + match[0].length;
  }
  if (at < text.length) segments.push(text.length - at);
  return segments;
}

/**
 * How many of a row's characters are marker, for the log.
 *
 * A run that reports "0 edits refused" over a book full of emphasis is saying
 * something different from one that reports it over a book with none, and the
 * completion line has no way to tell them apart without this.
 */
export function markerCharacters(text: string): number {
  let count = 0;
  for (const match of text.matchAll(MARKER_RUN)) count += match[0].length;
  return count;
}
