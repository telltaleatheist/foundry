/**
 * shared/unrender — a flowing block's TEXT, read back out of the markup the
 * emitter cast it into.
 *
 * ── Why the app needs the engine's inverse ──────────────────────────────────
 *
 * The in-place word editor edits a block of a CAST book, and what it holds when
 * the typing stops is inner XHTML — `<em>`, `<strong>`, a noteref anchor, a
 * pagebreak span. What a DECISION holds is the flowing dialect: `*italic*`,
 * `**bold**`, a Unicode superscript run. The overlay's `text` field replaces
 * the model's own words at the parse (`applyOverlay`), and a translation record
 * stands in place of `FlowBlock.text` at materialization, so both of the word
 * ops this app records — "edit block text" and "edit transformed text" — have
 * to hand over the dialect, not the markup. This module is the crossing.
 *
 * ── IT IS A SECOND STATEMENT OF ONE TABLE, and that is a maintained risk ────
 *
 * The engine already owns this inverse: `flowTextOf` in
 * `src/translate/flowtext.ts` recovers the flowing base from a cast so that
 * `translate --records` can ask the model about text instead of markup. The app
 * cannot import it — the app never imports the engine, it spawns it — and
 * spawning a process per keystroke to undo three substitutions would be absurd,
 * so the table is restated here, entry for entry, with the engine's file named
 * as the contract. If the emitter's inline vocabulary ever grows
 * (`dotsInline`, src/vlm/dots-book.ts), BOTH tables grow, and the refusal
 * below is what makes forgetting this one loud instead of silent: an element
 * with no rule refuses the whole mirror by tag name rather than passing markup
 * through as if it were words.
 *
 * ── The table (flowtext.ts's, verbatim) ─────────────────────────────────────
 *
 *  - `<strong>`/`<b>` → `**…**`, `<em>`/`<i>` → `*…*`.
 *  - `<sup>14</sup>` → `¹⁴`; an `<a>` whose whole content is one `<sup>` — a
 *    noteref or a backlink, the only anchors the emitter writes — → the same.
 *  - `<br/>` → the newline it stands for, and nothing where the file already
 *    carries that newline as text (`dotsInline` writes `<br/>\n`).
 *  - `<span epub:type="pagebreak">` → nothing. The page marker was minted at
 *    emit from provenance and was never in anybody's text.
 *  - anything else → refused, by tag, so the caller can say the edit stayed in
 *    the book and why it could not be recorded.
 *
 * Strictness is the module's whole value. A lenient inverse that flattened an
 * unknown element to its words would record a correction that renders
 * differently from the book the person was looking at — undetectable by
 * reading the output, and undetectable is the property this codebase will not
 * ship.
 */

/** Refusals from this module, named so a caller can tell them from anything else. */
export class UnrenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrenderError';
  }
}

/** dots.ts's own digits, in value order — the inverse of its `<sup>` pass. */
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

const STRONG_TAGS: ReadonlySet<string> = new Set(['strong', 'b']);
const ITALIC_TAGS: ReadonlySet<string> = new Set(['em', 'i']);

/**
 * One start or end tag, scanned in place. Quote-aware on the attributes, so a
 * `>` inside a value cannot end the tag early — the emitter never writes one,
 * but this string came out of a browser's serializer and defensiveness here
 * costs four characters of pattern.
 */
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/;

/** A named attribute's value out of a tag's attribute text, or null. */
function attributeOf(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match === null ? null : (match[1] ?? match[2] ?? '');
}

/**
 * Entities back to characters — the five XML names plus numeric references,
 * which is everything a cast book's text nodes can hold: `dotsInline` escaped
 * the text on its way in, and XHTML defines no other names. Decoded because
 * the dialect is what the model reads (`Bär`, not `B&auml;r`), and because a
 * record's text is re-escaped on its way back into a document.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    switch (body) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
      default: return whole;
    }
  });
}

/** `14` → `¹⁴`, refusing anything a printed note number is not. */
function superscriptOf(digits: string): string {
  const trimmed = digits.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    throw new UnrenderError(
      `a superscript in this block reads "${digits.slice(0, 20)}", and the emitter only ever writes `
      + 'a printed note number there — this block was not written by Foundry\'s own renderer.',
    );
  }
  return [...trimmed].map((digit) => SUPERSCRIPT_DIGITS[Number(digit)]!).join('');
}

/**
 * The flowing text of one block's inner markup, or a refusal naming the first
 * thing the table has no rule for.
 */
export function unrenderBlock(inner: string): string {
  let at = 0;

  /** The next tag, consumed. The caller has established `inner[at] === '<'`. */
  const readTag = (): { closing: boolean; name: string; attrs: string; selfClosing: boolean } => {
    if (inner.startsWith('<!', at) || inner.startsWith('<?', at)) {
      throw new UnrenderError(
        'this block carries a comment, a CDATA section or a processing instruction, which is not '
        + 'something the emitter writes and not something a flowing block\'s text can hold.',
      );
    }
    const match = TAG.exec(inner.slice(at));
    if (match === null) {
      throw new UnrenderError('this block\'s markup has a "<" that opens no tag, so it cannot be read back as text.');
    }
    at += match[0].length;
    return {
      closing: match[1] === '/',
      name: (match[2] ?? '').toLowerCase(),
      attrs: match[3] ?? '',
      selfClosing: match[4] === '/',
    };
  };

  /**
   * Everything up to (and consuming) the close of `until`, as dialect text.
   * `null` reads to the end of the string — the top level.
   */
  const walk = (until: string | null): string => {
    let out = '';
    for (;;) {
      const lt = inner.indexOf('<', at);
      const stop = lt < 0 ? inner.length : lt;
      out += decodeEntities(inner.slice(at, stop));
      at = stop;
      if (lt < 0) {
        if (until !== null) {
          throw new UnrenderError(`a <${until}> in this block is never closed, so its words cannot be read back.`);
        }
        return out;
      }
      const tag = readTag();
      if (tag.closing) {
        if (tag.name === until) return out;
        throw new UnrenderError(
          `this block closes a <${tag.name}> that is not open, so its markup cannot be read back as text.`,
        );
      }
      out += element(tag);
    }
  };

  /** One element, dispatched through the table. */
  const element = (tag: { name: string; attrs: string; selfClosing: boolean }): string => {
    if (STRONG_TAGS.has(tag.name) && !tag.selfClosing) return `**${walk(tag.name)}**`;
    if (ITALIC_TAGS.has(tag.name) && !tag.selfClosing) return `*${walk(tag.name)}*`;
    if (tag.name === 'sup') return superscriptOf(tag.selfClosing ? '' : walk('sup'));
    if (tag.name === 'br') {
      // The newline this element stands for, and only where the file does not
      // already carry it: `dotsInline` writes `<br/>\n`, so in a cast book the
      // newline is the text node after this element and adding one here would
      // double every line break in a poem.
      return inner.startsWith('\n', at) ? '' : '\n';
    }
    if (tag.name === 'span' && attributeOf(tag.attrs, 'epub:type') === 'pagebreak') {
      if (!tag.selfClosing && walk('span').trim().length > 0) {
        throw new UnrenderError(
          'a page-break span in this block has words inside it. The emitter writes an empty one and '
          + 'nothing else does, so dropping this would drop text.',
        );
      }
      return '';
    }
    if (tag.name === 'a') {
      /*
       * Note apparatus, and only note apparatus. In a cast book every anchor is
       * a noteref or a backlink and each contains exactly one `<sup>` holding
       * the number the page printed. An anchor holding anything else is a link
       * somebody put in a book by hand, and flattening it to its words would
       * silently lose where it points.
       */
      if (tag.selfClosing) {
        throw new UnrenderError('an empty <a/> in this block is not a note reference, and its purpose cannot be kept.');
      }
      let sup: string | null = null;
      for (;;) {
        const lt = inner.indexOf('<', at);
        const stop = lt < 0 ? inner.length : lt;
        if (inner.slice(at, stop).trim().length > 0) {
          throw new UnrenderError(
            '<a> in this block is not a note reference — in a cast book every anchor holds one <sup> '
            + 'and nothing else. Flattening it would lose where it points.',
          );
        }
        at = stop;
        if (lt < 0) throw new UnrenderError('an <a> in this block is never closed, so its words cannot be read back.');
        const child = readTag();
        if (child.closing) {
          if (child.name !== 'a') {
            throw new UnrenderError(
              `this block closes a <${child.name}> inside an anchor that is not open, so its markup `
              + 'cannot be read back as text.',
            );
          }
          break;
        }
        if (child.name !== 'sup' || sup !== null) {
          throw new UnrenderError(
            '<a> in this block is not a note reference — in a cast book every anchor holds one <sup> '
            + 'and nothing else. Flattening it would lose where it points.',
          );
        }
        sup = superscriptOf(child.selfClosing ? '' : walk('sup'));
      }
      if (sup === null) {
        throw new UnrenderError(
          '<a> in this block is not a note reference — in a cast book every anchor holds one <sup> '
          + 'and nothing else. Flattening it would lose where it points.',
        );
      }
      return sup;
    }
    // The sentence reaches a notice strip, so it names no files — the header
    // above says where this table and the engine's live and that they grow
    // together.
    throw new UnrenderError(
      `<${tag.name}> is an element a recorded correction has no words for. A block's recorded text `
      + 'carries emphasis and superscript note numbers and nothing else.',
    );
  };

  return walk(null);
}
