/**
 * clean/sentences — the unit a cleanup asks about, since 2026-09-24.
 *
 * Owen, 2026-09-24, after Pursuit of Power's n8 run left ~330 regnal numerals,
 * 39 decimals and a "fini sh" in blocks the model HAD been shown: *"it seems
 * like its being given too many things to fix at once. if we went to the
 * sentence level, we could reduce the number of things that are analyzed at
 * all, and it would be able to focus on a single unit at a time. but we'd have
 * to write it back to the block that it came out of, in the exact same place."*
 * And on the size: *"we could set a minimum. at least 30 characters. if its
 * less, combine with the next sentence."*
 *
 * ── A SENTENCE IS A RANGE OF ITS BLOCK, NEVER A COPY ────────────────────────
 *
 * Every span is a half-open `[start, end)` into the block's own stage-1 text,
 * trimmed of the whitespace around it. What lies between two spans — the
 * spaces after a full stop — is never shown to a model and never changes, so
 * the block is put back as `gap + sentence + gap + sentence …` with each
 * sentence's accepted edits applied at offsets inside it. That is the whole of
 * "the exact same place": no quotation is matched back into a paragraph.
 *
 * ── THE SPLIT LEANS TOWARD NOT SPLITTING ────────────────────────────────────
 *
 * This is NOT `analyze/sentences.ts`. That one is frozen byte-for-byte to
 * briefcase's rule because its calibration was measured against it, and it cuts
 * at every "Dr." and every initial. Here a wrong cut is the costly direction:
 * "F. S. L. Lyons" in four requests, or "Mr." shown to the model with no name
 * after it. A sentence left too LONG costs nothing but a slightly bigger ask, so
 * every doubt keeps the text together:
 *
 *  - a boundary needs terminal punctuation, optional closing quotes or brackets,
 *    whitespace, and then something that can START a sentence — a capital, an
 *    opening quote or bracket, or a digit;
 *  - never after a known abbreviation ("Dr.", "St.", "ed.", "transl.", "c.",
 *    "vol.", a month's short form …), a single capital initial ("F."), or a
 *    dotted run ("e.g.", "U.S.");
 *  - then any sentence shorter than `MIN_SENTENCE_CHARS` joins the NEXT one (the
 *    last one joins the one before it), which is Owen's floor.
 */

/** One sentence: where it sits in its block's text. `text` is exactly `block.slice(start, end)`. */
export interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

/** Owen, 2026-09-24: "at least 30 characters. if its less, combine with the next sentence." */
export const MIN_SENTENCE_CHARS = 30;

/**
 * The words whose period is NOT a sentence's end. Compared lower-cased and
 * without the period. Deliberately generous — a missed boundary is free.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  // titles and ranks
  'mr', 'mrs', 'ms', 'dr', 'st', 'mt', 'prof', 'rev', 'hon', 'gen', 'col', 'capt', 'cpt', 'lt',
  'maj', 'sgt', 'cpl', 'adm', 'cmdr', 'gov', 'sen', 'rep', 'pres', 'supt', 'insp', 'fr', 'sr',
  'jr', 'esq', 'messrs', 'mme', 'mlle', 'mgr', 'bros',
  // scholarly apparatus
  'ed', 'eds', 'trans', 'transl', 'tr', 'comp', 'vol', 'vols', 'no', 'nos', 'p', 'pp', 'ch',
  'chap', 'fig', 'figs', 'pl', 'sec', 'art', 'col', 'cf', 'viz', 'ibid', 'op', 'cit', 'loc',
  'repr', 'rev', 'ser', 'suppl', 'n', 'nn', 'l', 'll', 'f', 'ff', 'c', 'ca', 'fl', 'b', 'd',
  'r', 'approx', 'esp', 'incl', 'orig', 'misc', 'dept', 'univ', 'assn', 'inst',
  // latin and common
  'etc', 'vs', 'v', 'al', 'e', 'i', 'eg', 'ie',
  // places and addresses
  'ave', 'rd', 'blvd', 'sq', 'ft', 'co', 'corp', 'inc', 'ltd',
  // months and days
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  // scripture books a period can follow ("Rom. 5:17" is one sentence)
  'gen', 'ex', 'exod', 'lev', 'num', 'deut', 'josh', 'judg', 'sam', 'kgs', 'chron', 'neh',
  'esth', 'ps', 'psa', 'pss', 'prov', 'eccl', 'eccles', 'isa', 'jer', 'lam', 'ezek', 'dan',
  'hos', 'obad', 'mic', 'nah', 'hab', 'zeph', 'hag', 'zech', 'mal', 'matt', 'mk', 'lk', 'jn',
  'rom', 'cor', 'gal', 'eph', 'phil', 'col', 'thess', 'tim', 'tit', 'philem', 'phlm', 'heb',
  'jas', 'pet', 'jud', 'rev',
]);

/** Terminal marks, then closing quotes/brackets, then the whitespace a boundary sits in. */
const BOUNDARY = /[.!?…]+["'’”)\]]*(\s+)/g;

/** What may begin a sentence. */
const CAN_START = /^["'‘“([\p{Lu}\d]/u;

/** Is the period ending `before` an abbreviation's rather than a sentence's? */
function endsInAbbreviation(before: string): boolean {
  // The token the terminal mark is glued to.
  const token = /(\S+)$/.exec(before)?.[1] ?? '';
  if (!token.endsWith('.')) return false;
  const bare = token.replace(/^["'‘“([]+/, '').replace(/\.+$/, '');
  if (bare === '') return false;
  // A single letter: an initial ("F.") or a list letter.
  if (/^\p{L}$/u.test(bare)) return true;
  // A dotted run: "e.g", "U.S", "i.e", "a.m".
  if (/^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u.test(bare)) return true;
  return ABBREVIATIONS.has(bare.toLowerCase());
}

/**
 * Split one block's stage-1 text into the sentences a cleanup asks about.
 *
 * The spans cover every non-whitespace character of the text exactly once, in
 * order; a text with no boundary is one span. An all-whitespace text has none.
 */
export function cleanSentences(text: string): SentenceSpan[] {
  const cuts: Array<{ end: number; next: number }> = [];
  for (const m of text.matchAll(BOUNDARY)) {
    const end = m.index + m[0].length - m[1]!.length;
    const next = m.index + m[0].length;
    if (next >= text.length) continue;
    if (!CAN_START.test(text.slice(next))) continue;
    if (endsInAbbreviation(text.slice(0, end).replace(/["'’”)\]]+$/, ''))) continue;
    cuts.push({ end, next });
  }

  // The raw pieces, trimmed.
  const raw: SentenceSpan[] = [];
  let from = 0;
  const push = (start: number, end: number): void => {
    while (start < end && /\s/.test(text[start]!)) start += 1;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
    if (end > start) raw.push({ start, end, text: text.slice(start, end) });
  };
  for (const cut of cuts) {
    push(from, cut.end);
    from = cut.next;
  }
  push(from, text.length);

  // Owen's floor: a short sentence joins the next; the last joins the one before.
  const merged: SentenceSpan[] = [];
  let open: { start: number; end: number } | null = null;
  for (const piece of raw) {
    const start: number = open === null ? piece.start : open.start;
    const span = { start, end: piece.end };
    if (span.end - span.start < MIN_SENTENCE_CHARS) {
      open = span;
      continue;
    }
    merged.push({ ...span, text: text.slice(span.start, span.end) });
    open = null;
  }
  if (open !== null) {
    const last = merged.pop();
    const start = last === undefined ? open.start : last.start;
    merged.push({ start, end: open.end, text: text.slice(start, open.end) });
  }
  return merged;
}

/**
 * Put a block back together from its sentences.
 *
 * `cleaned[i]` replaces `spans[i]`; everything between the spans — and before
 * the first and after the last — is the block's own text, byte for byte.
 */
export function reassemble(text: string, spans: readonly SentenceSpan[], cleaned: readonly string[]): string {
  if (cleaned.length !== spans.length) {
    throw new Error(`reassemble: ${spans.length} sentence(s) and ${cleaned.length} answer(s).`);
  }
  let out = '';
  let at = 0;
  spans.forEach((span, i) => {
    out += text.slice(at, span.start) + cleaned[i]!;
    at = span.end;
  });
  return out + text.slice(at);
}
