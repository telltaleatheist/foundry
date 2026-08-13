/**
 * translate/markers — sending a paragraph to a model without sending it markup.
 *
 * A block in a foundry EPUB is not a string. It is a `<p>` whose inner XHTML
 * may carry emphasis, a superscript, a footnote reference anchored to an id
 * elsewhere in the document, and a `<span epub:type="pagebreak">` marking where
 * the printed page turned mid-sentence. All of that has to survive a round trip
 * through a language model that is being asked to rewrite the words between it.
 *
 * WHY NOT JUST SEND THE XHTML. Measured, and it is the worse of the two failure
 * modes. A model handed `<a class="noteref" epub:type="noteref" role="doc-noteref"
 * href="#fn12"><sup>12</sup></a>` will sometimes hand back `<a href="#fn12">12</a>`,
 * sometimes `<sup>12</sup>`, sometimes the right tags with `role` dropped, and
 * occasionally a link to `#fn13` — a footnote reference that now points at the
 * wrong note, in a book that renders perfectly and is wrong. Every one of those
 * is a plausible-looking repair, which is precisely the class of failure
 * ARCHITECTURE §8 exists to refuse. The attributes are not content; asking a
 * translator to retype them is asking for a transcription error.
 *
 * So the markup is REMOVED before the model sees it and PUT BACK from the
 * original source afterwards. What the model receives is prose with opaque
 * tokens in it:
 *
 *     Der ⟦e1⟧völkische⟦/e1⟧ Staat⟦m1⟧ war das Ziel.⟦m2⟧
 *
 * and what comes back is prose with the same tokens somewhere in it. The
 * attributes are never retyped because they never left this file.
 *
 * TWO KINDS OF TOKEN, AND THE DIFFERENCE IS WHETHER THERE ARE WORDS INSIDE.
 *
 *  - **Paired `⟦e1⟧…⟦/e1⟧`** wraps an element whose content is translatable
 *    text: `<em>`, `<strong>` and their legacy spellings. The words inside are
 *    part of the sentence and have to be translated with it; what must survive
 *    is that SOME span of the translation is emphasised.
 *  - **Atomic `⟦m1⟧`** stands for a whole element, preserved verbatim, contents
 *    and all: a noteref anchor, a `<sup>` note number, a pagebreak span, a
 *    `<br/>`. None of them holds prose. A `<sup>14</sup>` is a number the book
 *    printed and the note apparatus resolves by it; "fourteen" would be a
 *    translation of it and would break the link.
 *
 * `<a>` IS ATOMIC EVEN THOUGH A LINK CAN HOLD WORDS. In a foundry-converted
 * book every anchor is note apparatus — a noteref or a backlink, both of which
 * contain exactly a `<sup>` number (see `dots-book.ts`). Treating them as prose
 * would put the note numbering in the model's hands for no gain.
 *
 * THE TAG TABLE IS EXHAUSTIVE AND AN UNKNOWN TAG REFUSES THE BLOCK. Same rule
 * and same reason as `text-out.ts`'s: the alternative is passing an element
 * through as atomic, which quietly leaves whatever prose is inside it in the
 * source language, in a book that otherwise reads as fully translated. That is
 * undetectable by looking at the output, and undetectable is the one property
 * this codebase will not ship.
 *
 * ORDER IS NOT CHECKED. NESTING IS. A German sentence and its English
 * translation do not put the emphasised phrase in the same place, and the
 * footnote reference at the end of the German clause belongs at the end of the
 * English one — which may be four words earlier. Demanding the original
 * sequence would refuse correct translations. What is demanded is that every
 * token appears EXACTLY ONCE, that no token appears that was never sent, and
 * that the pairs nest properly, because those are the properties whose absence
 * produces markup this file cannot put back together.
 */
import { decodeEntities, parseXml, type XmlElement } from '../epub/xml.js';

/** Markup this file will not take apart. Always names the tag. */
export class MarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkerError';
  }
}

/**
 * Elements whose content is part of the sentence.
 *
 * `i` and `b` are here because a foundry EPUB is not the only EPUB this command
 * may be pointed at — the contract check upstream proves the book carries
 * foundry's stamps, not that every inline element inside them was written by
 * `dialect.ts`, which emits only `em` and `strong`.
 */
const PAIRED: ReadonlySet<string> = new Set(['em', 'strong', 'i', 'b', 'cite', 'q', 'small', 'u']);

/** Elements preserved whole, contents included. See the header on `<a>`. */
const ATOMIC: ReadonlySet<string> = new Set(['a', 'sup', 'sub', 'span', 'br', 'img', 'code', 'wbr']);

/** U+27E6/U+27E7. Chosen because no book and no model emits them by accident. */
const OPEN = '⟦';
const CLOSE = '⟧';

/** Matches any token this file could have written, and nothing else. */
const TOKEN = /⟦(\/?)([em]\d+)⟧/g;

/** Matches anything token-SHAPED, so an invention can be named rather than ignored. */
const TOKEN_SHAPED = /⟦([^⟦⟧]*)⟧/g;

interface PairedMarker {
  kind: 'paired';
  id: string;
  /** The start tag exactly as the book wrote it, attributes and all. */
  open: string;
  close: string;
}

interface AtomicMarker {
  kind: 'atomic';
  id: string;
  /** The whole element, verbatim. */
  source: string;
}

export type Marker = PairedMarker | AtomicMarker;

export interface MaskedBlock {
  /** What the model is sent: prose, with tokens where the markup was. */
  text: string;
  markers: Marker[];
  /**
   * Markup peeled off the block's EDGES, never shown to the model at all.
   *
   * Measured on the first real run of this command (Völkischer Beobachter,
   * qwen3:32b): the heading "Kirchenwahlen 1932" refused three times running
   * because the model kept dropping its one atomic token — a pagebreak span,
   * which `dots-book.ts` writes at the START of the first block of every page,
   * so nearly every page's first block carries one. A two-word heading is
   * mostly token, and a model translating two words sheds the part that is not
   * words. But an atomic marker at the edge of a block needs nothing from the
   * model: it has no prose inside it and its position is an invariant — the
   * start stays the start in any language. So it is removed here and
   * reattached mechanically after `restoreMarkers`, and the model's obligation
   * shrinks to the markers whose position genuinely depends on the sentence:
   * the interior ones.
   */
  leading: string;
  trailing: string;
}

/**
 * Escape text going back INTO an XHTML document.
 *
 * Only the three characters that would change the document's structure. Quotes
 * are left alone: this text lands between tags, never inside an attribute, and
 * `&quot;` all through a translated book would be a diff against the original
 * that means nothing.
 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Take a block's inner XHTML apart into prose and markers.
 *
 * `inner` is the source between a block element's tags, taken by offset out of
 * the document (`xml.ts` keeps every node's span), so the markup put back later
 * is the book's own bytes rather than anything this program serialised.
 */
export function maskBlock(inner: string): MaskedBlock {
  const root = parseXml(inner, 'xhtml');
  const markers: Marker[] = [];
  let paired = 0;
  let atomic = 0;

  const walk = (node: XmlElement): string => {
    let out = '';
    for (const child of node.children) {
      if (child.kind === 'text') {
        // Entities are decoded on the way out and re-escaped on the way back.
        // The model should read `Bär`, not `B&auml;r`, and the alternative —
        // passing entities through as opaque tokens — would break a word in
        // half in the middle of a sentence it is being asked to translate.
        out += decodeEntities(inner.slice(child.start, child.end));
        continue;
      }
      if (child.kind === 'other') {
        // A comment or a CDATA section inside a paragraph. Preserved whole and
        // never shown to the model: it is not prose, and a translated comment
        // is a change to a document nobody asked to change.
        atomic += 1;
        const id = `m${atomic}`;
        markers.push({ kind: 'atomic', id, source: inner.slice(child.start, child.end) });
        out += `${OPEN}${id}${CLOSE}`;
        continue;
      }

      const tag = child.tag;
      if (PAIRED.has(tag) && !child.selfClosing) {
        paired += 1;
        const id = `e${paired}`;
        markers.push({
          kind: 'paired',
          id,
          open: inner.slice(child.start, child.innerStart),
          close: inner.slice(child.innerEnd, child.end),
        });
        out += `${OPEN}${id}${CLOSE}${walk(child)}${OPEN}/${id}${CLOSE}`;
        continue;
      }
      if (ATOMIC.has(tag) || (PAIRED.has(tag) && child.selfClosing)) {
        atomic += 1;
        const id = `m${atomic}`;
        markers.push({ kind: 'atomic', id, source: inner.slice(child.start, child.end) });
        out += `${OPEN}${id}${CLOSE}`;
        continue;
      }

      throw new MarkerError(
        `<${child.name}> is an element this stage has no rule for. Translating around it would `
        + 'either retype its attributes or leave the words inside it untranslated, and both are '
        + 'silent damage — add it to PAIRED or ATOMIC in src/translate/markers.ts.',
      );
    }
    return out;
  };

  let text = walk(root);
  const byId = new Map(markers.map((m) => [m.id, m] as const));
  const peeled = new Set<string>();
  let leading = '';
  let trailing = '';

  /*
   * The edge peel — see `MaskedBlock.leading`. Whitespace travels with the
   * side it was on, so `<span/>Wort` and `<span/> Wort` both come back exactly
   * as written. Only ATOMIC tokens peel: a paired token at the edge wraps
   * prose, and prose is the model's. The loops run until the edge is prose,
   * so a block opening on two spans loses both.
   */
  const LEAD = /^(\s*)⟦(m\d+)⟧(\s*)/;
  const TAIL = /(\s*)⟦(m\d+)⟧(\s*)$/;
  for (let hit = LEAD.exec(text); hit !== null; hit = LEAD.exec(text)) {
    const marker = byId.get(hit[2]) as AtomicMarker;
    leading += hit[1] + marker.source + hit[3];
    peeled.add(marker.id);
    text = text.slice(hit[0].length);
  }
  for (let hit = TAIL.exec(text); hit !== null; hit = TAIL.exec(text)) {
    const marker = byId.get(hit[2]) as AtomicMarker;
    trailing = hit[1] + marker.source + hit[3] + trailing;
    peeled.add(marker.id);
    text = text.slice(0, hit.index);
  }

  return { text, markers: markers.filter((m) => !peeled.has(m.id)), leading, trailing };
}

/**
 * Everything that can be wrong with a response's tokens, said in one sentence.
 *
 * Returns null when the response is usable. The sentence is what gets logged on
 * a retry and what names the block in the refusal, so it says what was expected
 * and what arrived rather than "invalid".
 */
export function checkMarkers(masked: MaskedBlock, response: string): string | null {
  const expected = new Map<string, Marker>(masked.markers.map((m) => [m.id, m] as const));

  // Anything token-SHAPED that is not a token this stage wrote. Caught first
  // because `⟦e1 ⟧` and `⟦E1⟧` are the shapes a model actually produces, and
  // reporting them as "missing ⟦e1⟧" would send somebody looking for the wrong
  // defect.
  const invented: string[] = [];
  for (const match of response.matchAll(TOKEN_SHAPED)) {
    const body = match[1];
    const id = body.startsWith('/') ? body.slice(1) : body;
    if (!expected.has(id) || !/^[em]\d+$/.test(id)) invented.push(`${OPEN}${body}${CLOSE}`);
  }
  if (invented.length > 0) {
    return `the answer contains ${invented.length} marker(s) that were never sent: ${invented.slice(0, 4).join(' ')}`;
  }

  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  const stack: string[] = [];
  for (const match of response.matchAll(TOKEN)) {
    const closing = match[1] === '/';
    const id = match[2];
    const marker = expected.get(id)!;
    if (marker.kind === 'atomic') {
      if (closing) return `${OPEN}/${id}${CLOSE} was closed, but ${OPEN}${id}${CLOSE} stands for a whole element and has no pair`;
      opens.set(id, (opens.get(id) ?? 0) + 1);
      continue;
    }
    if (closing) {
      closes.set(id, (closes.get(id) ?? 0) + 1);
      const top = stack.pop();
      if (top !== id) {
        return top === undefined
          ? `${OPEN}/${id}${CLOSE} closes a marker that was never opened`
          : `${OPEN}/${id}${CLOSE} closes while ${OPEN}${top}${CLOSE} is still open — the markers cross`;
      }
    } else {
      opens.set(id, (opens.get(id) ?? 0) + 1);
      stack.push(id);
    }
  }
  if (stack.length > 0) {
    return `${OPEN}${stack[stack.length - 1]}${CLOSE} is opened and never closed`;
  }

  const missing: string[] = [];
  const doubled: string[] = [];
  for (const marker of masked.markers) {
    const nOpen = opens.get(marker.id) ?? 0;
    if (nOpen === 0) missing.push(`${OPEN}${marker.id}${CLOSE}`);
    else if (nOpen > 1) doubled.push(`${OPEN}${marker.id}${CLOSE}`);
    if (marker.kind === 'paired') {
      const nClose = closes.get(marker.id) ?? 0;
      if (nOpen === 1 && nClose > 1) doubled.push(`${OPEN}/${marker.id}${CLOSE}`);
    }
  }
  if (missing.length > 0) {
    return `the answer dropped ${missing.length} of ${masked.markers.length} marker(s): ${missing.slice(0, 6).join(' ')}`;
  }
  if (doubled.length > 0) {
    return `the answer repeated ${doubled.slice(0, 6).join(' ')} — every marker stands for one thing and appears once`;
  }
  return null;
}

/**
 * Put the book's own markup back around the model's words.
 *
 * Call only after `checkMarkers` has returned null; this function assumes the
 * tokens are the ones that were sent, and it is the last step before the text
 * becomes part of somebody's book.
 */
export function restoreMarkers(masked: MaskedBlock, response: string): string {
  const table = new Map<string, Marker>(masked.markers.map((m) => [m.id, m] as const));
  let out = '';
  let at = 0;
  for (const match of response.matchAll(TOKEN)) {
    out += escapeText(response.slice(at, match.index));
    const marker = table.get(match[2]);
    if (marker === undefined) {
      throw new MarkerError(`${OPEN}${match[2]}${CLOSE} is not a marker this block sent`);
    }
    out += marker.kind === 'atomic'
      ? marker.source
      : match[1] === '/' ? marker.close : marker.open;
    at = match.index + match[0].length;
  }
  return out + escapeText(response.slice(at));
}

/**
 * The block's words with every token taken out — what the completeness checks
 * measure, on both sides.
 *
 * Comparing raw strings would count the tokens themselves, which are identical
 * in the source and the answer by construction and so dilute exactly the
 * measurement they are being counted in: a one-word block carrying four
 * pagebreak spans would look 90% as long as its source however little the model
 * returned.
 */
export function stripMarkers(text: string): string {
  return text.replace(TOKEN, '').replace(/\s+/g, ' ').trim();
}
