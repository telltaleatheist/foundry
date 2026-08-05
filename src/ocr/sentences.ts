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
 * ## When in doubt, send more through (Owen, 2026-08-05)
 *
 * The unit boundary is ARBITRARY. It could be the paragraph; the sentence was
 * picked because it is the shape least likely to exhaust the context the model
 * was trained on, not because a sentence is the true atom of anything. That
 * makes the two ways of being wrong unequal, and an earlier ruling here — that
 * the boundary rule should stay dull and not know about abbreviations — had them
 * the wrong way round:
 *
 *   - A MISSED boundary yields a LONGER unit, still capped at 400 characters.
 *     It costs nothing. More context is what the sentence unit is for.
 *   - A WRONG boundary manufactures a FRAGMENT — `Mr.` on its own, or a unit
 *     opening `12 The next morning…` — which is the one failure this file
 *     exists to prevent.
 *
 * So the boundary rule guesses AGAINST cutting, and both guards below can only
 * ever lengthen a unit:
 *
 *  - **An abbreviation is not a sentence end.** A closed list, English and
 *    German, plus a lone letter (`J. R. R.`, `z. B.`) in EITHER case — German's
 *    commonest abbreviations are lowercase, and the cost of treating a real
 *    one-letter sentence end as an initial is one longer unit. A missing entry
 *    costs a short unit and can never cost wrong text. Only `.` is ambiguous
 *    this way; `!`, `?` and `…` are never abbreviation marks.
 *  - **A footnote reference rides on the sentence it marks.** `…lost the war.12
 *    The next morning` ends a sentence AFTER the `12`, not before it and not —
 *    as it did until today — nowhere at all: the terminator is not followed by
 *    whitespace, so no boundary was found, and once the paragraph ran past the
 *    cap the word-boundary fallback cut wherever it landed. One to three digits,
 *    ASCII or superscript, optionally behind the closing quote (`war."12`).
 *
 * A terminator PRECEDED by a digit is not a boundary under that second rule:
 * `3.14 dollars` is one number, not two sentences. The guard is only on the
 * digit-suffix form — `in 1945. The next` is an ordinary sentence end and stays
 * one.
 *
 * The abbreviation list is a per-language guess and always will be. That is an
 * argument for keeping it short and current, not for having none.
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
 * A sentence terminator, its closing quotes and brackets, an optional footnote
 * reference, and the whitespace that follows all of it.
 *
 * The closing run is what keeps `…said so." Then` from cutting between the stop
 * and the quotation mark, which would leave a unit opening with a bare `"`. The
 * digit run is what keeps `…the war.12 The next` from having no boundary at all;
 * it belongs to the sentence it marks, so the cut falls after it. Anchored on
 * whitespace rather than on the next character's case, because a sentence may
 * legitimately open with a digit, a bracket or a lowercase name.
 *
 * This only proposes a boundary. `isSentenceEnd` is what accepts one.
 */
const SENTENCE_END = /[.!?…]["'’”»)\]]*(?:[0-9]{1,3}|[¹²³⁰⁴-⁹]{1,3})?(?=\s)/g;

/** Did a candidate consume a footnote reference? Then the decimal guard applies. */
const ENDS_IN_REFERENCE = /[0-9¹²³⁰⁴-⁹]$/;

/** The last word before a terminator, which is what an abbreviation check reads. */
const WORD_BEFORE_STOP = /[A-Za-zÀ-ɏ]+$/;

/**
 * Abbreviations that end in a full stop and are not sentence ends.
 *
 * Short and current beats long and stale: a missing entry costs one longer unit
 * (see the header), so this is the set that actually turns up in the books this
 * pipeline reads — English scholarly apparatus and its German equivalents,
 * which the corpus is half made of.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  // Titles and names.
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'rev', 'hon', 'sr', 'jr',
  // Scholarly apparatus. `no` is numero, which also means the WORD "no." never
  // closes a unit — the cheap direction, and one longer unit is all it costs.
  'vs', 'etc', 'ca', 'cf', 'ed', 'eds', 'vol', 'no', 'pp', 'op', 'cit',
  'ibid', 'al', 'inc', 'ltd', 'co',
  // Months.
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // German apparatus: herausgegeben, Band, vergleiche, beziehungsweise, Nummer.
  'hrsg', 'bd', 'vgl', 'bzw', 'nr',
]);

/**
 * Is a candidate boundary a real one?
 *
 * Both tests can only REFUSE a cut, never invent one, which is the direction the
 * header rules this file must guess in.
 */
function isSentenceEnd(text: string, from: number, at: number, matched: string): boolean {
  // A stop riding on digits is a decimal — `3.14 dollars` is one number. Only
  // the digit-suffix form is at risk: `in 1945. The next` consumed no reference
  // and is an ordinary sentence end.
  if (ENDS_IN_REFERENCE.test(matched) && at > from && /[0-9]/.test(text[at - 1]!)) return false;

  if (text[at] !== '.') return true;
  const word = WORD_BEFORE_STOP.exec(text.slice(from, at));
  if (word === null) return true;
  if (ABBREVIATIONS.has(word[0].toLowerCase())) return false;
  // A lone letter is an initial — `J. R. R.`, `z. B.`, `u. a.` — in either case.
  return word[0].length > 1;
}

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

/** Cut one line into sentences at every SENTENCE_END the guards accept. */
function sentenceSpans(text: string, line: TextUnit): TextUnit[] {
  const out: TextUnit[] = [];
  let at = line.start;
  SENTENCE_END.lastIndex = line.start;
  for (;;) {
    const m = SENTENCE_END.exec(text);
    if (m === null || m.index >= line.end) break;
    // A refused candidate is not a boundary and not an error: the unit keeps
    // growing and the scan continues past it.
    if (!isSentenceEnd(text, at, m.index, m[0])) continue;
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
