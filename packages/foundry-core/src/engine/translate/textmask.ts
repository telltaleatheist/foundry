/**
 * translate/textmask — the same trick as `markers.ts`, one stage earlier.
 *
 * `markers.ts` masks a block's inner XHTML: it takes `<em>` and a noteref
 * anchor out of a rendered document, hands the model tokens in their place, and
 * splices the answer back into the file the markup came from. That is the right
 * shape for the EPUB→EPUB mode, where the product IS a document.
 *
 * A RECORD IS NOT A DOCUMENT. It is the translated TEXT of a flowing block, and
 * the flowing block's text is what `reflowBook` resolved out of the bank —
 * `dots-book.ts`'s `FlowBlock.text`, in the dialect the vision model answers in
 * and the emitter renders from (`dotsInline`, `src/vlm/dots.ts`). At that level
 * the markup is not markup at all. It is two constructions in the words:
 *
 *  - **markdown emphasis pairs** — `**bold**` and `*italic*`, which
 *    `dotsInline` turns into `<strong>` and `<em>`, in that order and with
 *    those exact patterns. They are PAIRED: there are words inside them, the
 *    words are part of the sentence, and what has to survive is that SOME span
 *    of the translation is emphasised.
 *  - **Unicode superscript runs** — `¹⁴`, the footnote reference numbers these
 *    books set as dedicated codepoints, which `dotsInline` turns into a
 *    `<sup>` or a link to the note it names. They are ATOMIC: a run is a number
 *    the book printed and the note apparatus resolves by it, and "fourteen"
 *    would be a translation of it that breaks the link.
 *
 * THE PATTERNS ARE THE EMITTER'S OWN, COPIED DELIBERATELY. `maskText` matches
 * with the same three regular expressions `dotsInline` replaces with, applied
 * in the same order, so that what is masked here is exactly what would become
 * an element there — no more (a lone `*` in a footnote is not emphasis to
 * either of them) and no less. If that file's patterns ever change, this file
 * changes with them, and the record format's key string is what makes the
 * change loud rather than silent (`bank.ts`, `KEY_FORMATS`).
 *
 * ── THERE IS NO EDGE PEEL HERE, AND THAT IS NOT AN OVERSIGHT ────────────────
 *
 * `markers.ts` peels an atomic marker off the START and the END of a block and
 * never shows it to the model at all (`MaskedBlock.leading`). It had to: the
 * emitter writes a `<span epub:type="pagebreak">` at the first element of every
 * page, so nearly every page's first block opened with a token, and a two-word
 * heading that is mostly token loses the token to any model translating two
 * words.
 *
 * THAT SPAN DOES NOT EXIST AT THIS LEVEL. It is not text the model ever read
 * and not text the reflow ever carried — the emitter mints it while it writes
 * the file, from `FlowPart.page`, which is why substituting a record's words
 * cannot lose one. Nothing else in a flow block's text is a start-of-block
 * atomic except a footnote's own printed number, and losing that is already
 * handled where it matters: `checkMarkers` notes a dropped marker and keeps the
 * answer, and the emitter takes a note's printed number from the SOURCE text
 * rather than from the record, so the digit on the page survives a model that
 * shed it. So `leading` and `trailing` are always empty here, and every marker
 * a block carries is a marker the model is asked to place.
 *
 * ── THE ROUND TRIP IS VERIFIED, NOT ASSUMED ─────────────────────────────────
 *
 * `roundTrips` re-renders the masked form with `restoreText` and compares it to
 * the string that went in. A block that does not come back byte for byte is
 * refused by name rather than translated: the only ways to fail it are a text
 * that already contains this file's own token characters and a pattern that
 * overlaps itself, and both would put a token in front of a reader or restore
 * the wrong markup around somebody's words.
 */
import { SUPERSCRIPT_RUN } from '../vlm/dots.js';
import type { Marker, MarkerCounter, MaskedBlock } from './markers.js';

/** U+27E6/U+27E7 — `markers.ts`'s tokens, so one vocabulary reaches the model. */
const OPEN = '⟦';
const CLOSE = '⟧';

/** Matches any token this file could have written, and nothing else. */
const TOKEN = /⟦(\/?)([em]\d+)⟧/g;

/**
 * `dotsInline`'s own two emphasis patterns, in `dotsInline`'s own order.
 *
 * Strong first, because that is the order the emitter applies them in and the
 * order decides what `**a *b* c**` is: one strong span with an italic inside
 * it, rather than two adjacent italics around a stray pair of asterisks. The
 * inner text of a strong match is left alone by this pass and reaches the
 * italic pass exactly as it reaches `dotsInline`'s.
 */
const STRONG = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
const ITALIC = /(?<![*\w])\*(?=\S)([\s\S]*?\S)\*(?!\w)/g;

/**
 * Take a flowing block's text apart into prose and markers.
 *
 * `counter` is mutated: pass one shared object to mask every part of a group —
 * a run of list items, the paragraphs of a quotation — because all of them
 * arrive in the model's answer as one string and two parts that both said
 * `⟦e1⟧` would be two different emphases wearing one name. Omit it for a block
 * that travels alone. Same contract, same reason and the same type as
 * `maskBlock`'s.
 */
export function maskText(text: string, counter?: MarkerCounter): MaskedBlock {
  const markers: Marker[] = [];
  const numbers = counter ?? { paired: 0, atomic: 0 };

  const pair = (open: string, close: string, inner: string): string => {
    numbers.paired += 1;
    const id = `e${numbers.paired}`;
    markers.push({ kind: 'paired', id, open, close });
    return `${OPEN}${id}${CLOSE}${inner}${OPEN}/${id}${CLOSE}`;
  };
  const atom = (source: string): string => {
    numbers.atomic += 1;
    const id = `m${numbers.atomic}`;
    markers.push({ kind: 'atomic', id, source });
    return `${OPEN}${id}${CLOSE}`;
  };

  let masked = text.replace(STRONG, (_all, inner: string) => pair('**', '**', inner));
  masked = masked.replace(ITALIC, (_all, inner: string) => pair('*', '*', inner));
  masked = masked.replace(SUPERSCRIPT_RUN, (run) => atom(run));

  /*
   * `leading`/`trailing` are the empty string and always will be — see the
   * header. They are still filled in rather than left off the object, because
   * every reader of a `MaskedBlock` concatenates all three and a mode that
   * quietly handed back a partial one would be a second shape of the same type.
   */
  return { text: masked, markers, leading: '', trailing: '' };
}

/**
 * Put the block's own emphasis and its printed numbers back around the model's
 * words.
 *
 * The `markers.ts` twin of this ESCAPES what it writes, because the string it
 * builds is going straight into an XHTML document. This one must not: what it
 * builds is a flowing block's text, which reaches a file only through
 * `dotsInline`, and `dotsInline` escapes. Escaping here would put `&amp;` in
 * the record, and the record would render as a literal `&amp;` on the page.
 *
 * A TOKEN THIS BLOCK NEVER SENT IS DROPPED, exactly as `restoreMarkers` drops
 * one and for exactly its reason: an invented `⟦e9⟧` names no markup, so there
 * is nothing to restore it to, and writing the token itself into a record would
 * put this program's private syntax in front of a reader.
 */
export function restoreText(masked: MaskedBlock, response: string): string {
  const table = new Map<string, Marker>(masked.markers.map((m) => [m.id, m] as const));
  let out = '';
  let at = 0;
  for (const match of response.matchAll(TOKEN)) {
    out += response.slice(at, match.index);
    at = match.index + match[0].length;
    const marker = table.get(match[2]!);
    if (marker === undefined) continue;
    out += marker.kind === 'atomic'
      ? marker.source
      : match[1] === '/' ? marker.close : marker.open;
  }
  return out + response.slice(at);
}

/**
 * Does this masking put the block back exactly as it was found?
 *
 * Null when it does. A sentence naming the block's own words when it does not,
 * which is what a refusal is written from — the caller keeps the source text
 * rather than translating a block it cannot reassemble.
 */
export function roundTrips(original: string, masked: MaskedBlock): string | null {
  const back = restoreText(masked, masked.text);
  if (back === original) return null;
  return 'masking this block\'s emphasis and note numbers does not put it back as it was found'
    + ` — "${original.slice(0, 60)}…" came back as "${back.slice(0, 60)}…", which usually means the`
    + ` text already contains the characters ${OPEN} and ${CLOSE} that this stage sends markers in`;
}
