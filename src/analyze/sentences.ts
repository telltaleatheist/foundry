/**
 * analyze/sentences — the project's first sentence segmenter.
 *
 * ── WHY THIS DID NOT EXIST UNTIL NOW ────────────────────────────────────────
 *
 * Translate's unit is the BLOCK, on purpose: a paragraph is the smallest thing
 * that carries enough grammar to be translated, and cutting one into sentences
 * would hand a model half a clause and no antecedent. Analysis's unit is the
 * SENTENCE, for the opposite reason: an entailment model scores a proposition
 * against a claim, and a paragraph containing one hateful sentence and four
 * neutral ones dilutes to nothing (measured in briefcase as stretch-level
 * dilution, which is what moved scoring down to the sentence in the first
 * place). So the book gets a segmenter, and it lives here.
 *
 * ── IT MEASURES AND IT NEVER REWRITES ───────────────────────────────────────
 *
 * Every sentence is a half-open `[start, end)` pair of character offsets into
 * the row's OWN text, the same shape `BookRow.parts[].chars` already uses — so
 * a finding can be pointed at the exact characters a person will see on screen,
 * and nothing downstream ever has to match a quotation back into a book. That
 * is the whole difference between this pipeline and the deprecated
 * quote-and-fuzzy-match one (docs/ANALYSIS.md §1): here the locator is measured
 * from source structure and no model ever emits one.
 *
 * The `text` a sentence carries is therefore always exactly
 * `row.text.slice(start, end)`. It is handed along because every consumer wants
 * it and slicing it once is cheaper than slicing it five times; it is never a
 * cleaned-up, normalised or re-cased version of the source. Whitespace inside a
 * block was already normalised by the reflow (`vlm-book`), so there is nothing
 * left here to tidy.
 *
 * ── THE SPLIT RULE IS BRIEFCASE'S, VERBATIM ─────────────────────────────────
 *
 * `/[.!?]+["')\]]*(?=\s|$)/g` — one or more terminal marks, then any closing
 * quotes or brackets that belong to the same sentence, then whitespace or the
 * end of the string. The punctuation STAYS WITH THE SENTENCE it ends, which is
 * what makes a hypothesis about an assertion score against a complete
 * assertion. Trailing text with no terminal mark at all is a sentence too: a
 * heading, a list item and a caption are all ordinary rows of this book and
 * almost none of them are punctuated, and a rule that dropped them would make
 * the analysis blind to exactly the categories that live in headings.
 *
 * It is kept byte-identical to briefcase's `assembleSentences` because the 0.7
 * calibration and every measured number quoted in `plan.ts` and `rank.ts` were
 * measured against THIS division of the text. A "better" rule here — one that
 * knew about "Dr." or "e.g." — would be a different division, and every
 * measurement carried over would silently be about something else.
 *
 * WHAT IT THEREFORE GETS WRONG, said out loud rather than patched: an
 * abbreviation ends a sentence early ("Dr. King said" is two), and an ellipsis
 * or a decimal point can too. The cost is bounded and it is the cheap
 * direction — a short fragment scores LOW on every stance hypothesis, so the
 * failure is a candidate that does not appear, not a passage flagged for
 * something it does not say. The sliding three-sentence window pass
 * (`rank.ts`) reads across such a cut anyway.
 */

/** One sentence of one row: where it is, and the characters that are there. */
export interface Sentence {
  /** Character offset into the row's text where the sentence begins. */
  start: number;
  /** Character offset one past its last character. `[start, end)`. */
  end: number;
  /** Exactly `text.slice(start, end)`. Never a rewritten form of it. */
  text: string;
}

/**
 * Every terminal-punctuation boundary. See the header: this expression is
 * briefcase's and is not improved here, because the calibration is about it.
 *
 * Declared at module scope with `g` and reset per call — a `g` regexp carries
 * `lastIndex` between uses, and a shared one that was not reset would skip the
 * first sentences of every row after the first.
 */
const BOUNDARY = /[.!?]+["')\]]*(?=\s|$)/g;

/**
 * Cut one block's text into sentences.
 *
 * Pure, TS-side, no model and no subprocess. A row of whitespace, or of
 * nothing, is no sentences rather than one empty one — an empty string entails
 * nothing and would cost an NLI column and a report row saying so.
 */
export function splitSentences(text: string): Sentence[] {
  /*
   * The boundaries, as offsets one past the punctuation. A tail with no
   * terminal mark closes with the string's own end — briefcase's rule, and the
   * reason a heading is a sentence here.
   */
  const bounds: number[] = [];
  BOUNDARY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOUNDARY.exec(text)) !== null) bounds.push(match.index + match[0].length);
  if (bounds.length === 0 || bounds[bounds.length - 1]! < text.length) bounds.push(text.length);

  const out: Sentence[] = [];
  let cursor = 0;
  for (const bound of bounds) {
    /*
     * briefcase trims the slice and keeps the string. This keeps the OFFSETS,
     * so the trim has to be walked rather than performed: the separator
     * whitespace between two sentences belongs to neither of them, and a
     * `start` that pointed at a space would light a highlight one character
     * early on every sentence in the book.
     */
    let start = cursor;
    let end = bound;
    while (start < end && isSpace(text.charCodeAt(start))) start += 1;
    while (end > start && isSpace(text.charCodeAt(end - 1))) end -= 1;
    if (end > start) out.push({ start, end, text: text.slice(start, end) });
    cursor = bound;
  }
  return out;
}

/**
 * Whitespace, by code point rather than by `/\s/` on a one-character string.
 *
 * The set is the one `String.prototype.trim` uses for the characters this book
 * can actually contain: space, tab, the line terminators, and the non-breaking
 * space, which a scan of a printed page produces often and which `\s` does not
 * match in a plain character class without the Unicode flag.
 */
function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    || code === 0x0b || code === 0x0c || code === 0xa0;
}

/**
 * How many words a piece of text is, for the window caps in `rank.ts`.
 *
 * A WORD IS A RUN OF NON-WHITESPACE, which is the same thing every "100–130
 * spoken words" figure in the measured literature counts, and it is the only
 * definition that does not need a language. It lives here rather than in
 * `rank.ts` because it is a fact about a string, and because the sentence is
 * the thing whose words get counted.
 */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
