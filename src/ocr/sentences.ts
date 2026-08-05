/**
 * sentences — the unit `ocr-correct --epub` asks the model about.
 *
 * The `ocr` stage asks about a LINE, because on the scan path a line is what
 * exists: the band segmenter found it and Tesseract read it. An EPUB has no
 * lines. Its text is the publisher's flowing paragraphs, and the unit has to be
 * chosen rather than inherited.
 *
 * **It is the sentence.** More context disambiguates more errors — `tbe` is
 * unarguable in a clause and a coin flip on its own — and the generation budget
 * is already derived from the input (`text.length + 64` in `stage.ts`), so a
 * longer unit costs proportionally and nothing has to be re-tuned. A whole
 * paragraph is out for the opposite reason: the model is line-trained, and a
 * 2,000-character prompt is a shape it never saw.
 *
 * **The prompt is NOT reworded for this.** `prompt.ts` says a near-miss prompt
 * is worse than an error and `tools/crosscheck-ocr-prompt.mjs` exists to catch
 * drift; the sentence it opens with — "a single line of text" — is still true
 * of a sentence, which is a line of text. Rewording it would move the trained
 * distribution in the one dimension this repo guards hardest, and that is a
 * retrain, not an edit.
 *
 * ## The three rules, in the order they beat each other
 *
 *  1. **A newline ends a unit, always.** A newline in an EPUB's text comes from
 *     a `<br/>`, and `extractOcrAnswer` reduces the model's reply to its FIRST
 *     line — so a prompt containing a newline can never round-trip, and
 *     `deriveEdits` refuses an anchor containing one anyway. This is not a
 *     preference; it is the wire format.
 *  2. **Split only at a sentence boundary, and pack up to the cap.** A fixed cut
 *     at N characters lands mid-sentence and recreates the fragment problem the
 *     sentence unit exists to escape.
 *  3. **A sentence longer than the cap splits at a word boundary — never
 *     mid-word.** And where a single WORD is longer than the cap, that word is
 *     its own unit and the unit is over the cap. The cap governs PACKING; "never
 *     mid-word" governs everything, because half a word is a fragment no amount
 *     of context repairs and the model would be asked to complete it.
 *
 * ## What this deliberately does not know
 *
 * Abbreviations. `Mr. Smith` is cut after `Mr.`, and that is fine: the cost of a
 * wrong boundary is a SHORTER unit, which is less context and never wrong text,
 * while an abbreviation list is a per-language guess that fails silently on the
 * language it was not written for. The rule stays dull on purpose.
 */

/**
 * The packing cap, in characters.
 *
 * ~400 is a couple of sentences of ordinary prose. It is a budget, not a
 * measurement: the number that matters is the one the model was trained
 * against (a line), and this is the smallest multiple of that which buys the
 * surrounding clause.
 */
export const CORRECTION_UNIT_MAX_CHARS = 400;

/** One unit of text to correct, and where it sits in the text it came from. */
export interface TextUnit {
  /** Index into the source text of the first character. */
  start: number;
  /** Index one past the last character. */
  end: number;
  /** `text.slice(start, end)` — carried so callers do not re-slice. */
  text: string;
}

/**
 * A sentence terminator, its closing quotes and brackets, and the whitespace
 * that follows it.
 *
 * The closing run is what keeps `…said so." Then` from cutting between the stop
 * and the quotation mark, which would leave a unit opening with a bare `"`.
 * Anchored on whitespace rather than on the next character's case, because a
 * sentence may legitimately open with a digit, a bracket or a lowercase name.
 */
const SENTENCE_END = /[.!?…]["'’”»)\]]*(?=\s)/g;

/** Split at every newline. A `<br/>` is a break in the text, not a space. */
function lineSpans(text: string): TextUnit[] {
  const out: TextUnit[] = [];
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    const span = trimmedSpan(text, at, end);
    if (span) out.push(span);
    if (nl < 0) break;
    at = nl + 1;
  }
  return out;
}

/** The span with its leading and trailing whitespace removed, or null if blank. */
function trimmedSpan(text: string, from: number, to: number): TextUnit | null {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end <= start) return null;
  return { start, end, text: text.slice(start, end) };
}

/** Cut one line into sentences at SENTENCE_END. */
function sentenceSpans(text: string, line: TextUnit): TextUnit[] {
  const out: TextUnit[] = [];
  let at = line.start;
  SENTENCE_END.lastIndex = line.start;
  for (;;) {
    const m = SENTENCE_END.exec(text);
    if (m === null || m.index >= line.end) break;
    const end = Math.min(m.index + m[0].length, line.end);
    const span = trimmedSpan(text, at, end);
    if (span) out.push(span);
    at = end;
  }
  const tail = trimmedSpan(text, at, line.end);
  if (tail) out.push(tail);
  return out;
}

/**
 * Cut one over-long sentence at word boundaries.
 *
 * Greedy: take words while they fit, and start a new unit at the word that does
 * not. A word longer than the cap on its own becomes a unit that EXCEEDS the cap
 * — rule 3 beats rule 2, because splitting it would hand the model half a word.
 */
function wordSpans(text: string, sentence: TextUnit, max: number): TextUnit[] {
  const out: TextUnit[] = [];
  let start = sentence.start;
  let at = sentence.start;

  const flush = (to: number): void => {
    const span = trimmedSpan(text, start, to);
    if (span) out.push(span);
    start = to;
  };

  while (at < sentence.end) {
    // Step over one word and the whitespace that follows it.
    let wordEnd = at;
    while (wordEnd < sentence.end && !/\s/.test(text[wordEnd]!)) wordEnd++;
    let next = wordEnd;
    while (next < sentence.end && /\s/.test(text[next]!)) next++;

    if (wordEnd - start > max && start < at) {
      // Adding this word overflows and there is already something to emit.
      flush(at);
      continue;
    }
    at = next;
  }
  flush(sentence.end);
  return out;
}

/**
 * The text of one block, cut into the units the model will be asked about.
 *
 * Every returned unit's `text` is exactly `text.slice(start, end)` with no
 * leading or trailing whitespace, so a caller can map an offset inside a unit
 * straight back onto the block it came from. Whitespace BETWEEN units belongs to
 * no unit and is never sent — correction changes words, and the space between
 * two sentences is not a word.
 */
export function correctionUnits(text: string, max: number = CORRECTION_UNIT_MAX_CHARS): TextUnit[] {
  if (max <= 0) {
    throw new Error(`correctionUnits: the cap must be a positive number of characters, got ${max}`);
  }

  const units: TextUnit[] = [];
  for (const line of lineSpans(text)) {
    let open: TextUnit | null = null;
    const close = (): void => {
      if (open) units.push(open);
      open = null;
    };

    for (const sentence of sentenceSpans(text, line)) {
      const pieces = sentence.text.length > max ? wordSpans(text, sentence, max) : [sentence];
      for (const piece of pieces) {
        if (open === null) { open = piece; continue; }
        // Pack against the span the two would OCCUPY, which includes the
        // whitespace between them — that whitespace is in the prompt.
        if (piece.end - open.start <= max) {
          open = { start: open.start, end: piece.end, text: text.slice(open.start, piece.end) };
          continue;
        }
        close();
        open = piece;
      }
    }
    close();
  }
  return units;
}
