/**
 * translate/flowtext — reading a flowing block's TEXT back out of the book it
 * was written into.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * A records-mode translation is a translation of `FlowBlock.text`
 * (`dots-book.ts`) — the flowing base, which is what the reflow resolved out of
 * the bank and what the emitter renders every element from. That is the string
 * a record must be a translation OF, because that is the string materialization
 * puts the record in place of.
 *
 * This command's input is not the base. It is a stamped EPUB — the CAST of that
 * base — because that is what `translate` has always been pointed at, what the
 * app has in its hands at the moment somebody orders a translation, and what
 * `readFoundryBook`'s admission rule is written against. The cast is a lossless
 * rendering of the base for every category this stage translates: the emitter
 * writes each flow block through one `dotsInline` call, and `dotsInline` is
 * three substitutions over the block's own words. So the base's text is
 * recoverable from the file, exactly, by undoing those three substitutions and
 * dropping the two things the emitter MINTED rather than carried.
 *
 * THE TABLE IS EXHAUSTIVE AND AN UNKNOWN TAG REFUSES THE BLOCK, which is
 * `markers.ts`'s rule and `text-out.ts`'s rule and is the same rule for the
 * same reason: the alternative is passing an element through as if it were
 * words, which leaves prose in the source language inside a book that reads as
 * fully translated. Undetectable by looking at the output, and undetectable is
 * the property this codebase will not ship.
 *
 * ── THE TABLE ───────────────────────────────────────────────────────────────
 *
 *  - `<strong>`/`<b>` → `**…**`, `<em>`/`<i>` → `*…*`. The emitter writes only
 *    the first spelling of each; the legacy pair is accepted for the same
 *    reason `markers.ts` accepts it — this command may be pointed at a book
 *    that was stamped rather than cast.
 *  - `<sup>14</sup>` → `¹⁴`, and a noteref or backlink `<a>` whose whole
 *    content is one `<sup>` → the same. The anchor is apparatus the emitter
 *    minted from the number; the number is the text.
 *  - `<br/>` → the newline the emitter wrote it FOR. `dotsInline` replaces a
 *    newline with `<br/>` followed by that same newline, so the newline is
 *    still in the file as text and the element contributes nothing. A `<br/>`
 *    that is NOT followed by one — a book stamped by hand — contributes the
 *    newline itself, so no line ending is ever lost.
 *  - `<span epub:type="pagebreak">` → nothing. The page marker is minted at
 *    emit from `FlowPart.page` and was never in anybody's text; this is the
 *    same fact that makes the edge peel unnecessary one file over
 *    (`textmask.ts`).
 *  - anything else → refused, by tag, naming the block.
 *
 * WHAT IS DELIBERATELY NOT HERE: `<table>` and everything under it. A Table
 * block's text is the vision model's own HTML (`checkTableHtml` in `dots.ts`)
 * and the emitter writes it into the document verbatim — there is no dialect to
 * undo, and taking a grid apart into words is exactly what the EPUB→EPUB mode
 * already does through `blocks.ts`. Records mode refuses tables whole and says
 * so, which is `run.ts`'s existing behaviour for a table it cannot mask.
 */
import { decodeEntities, parseXml, type XmlElement } from '../epub/xml.js';
import { MarkerError } from './markers.js';

/** `dots.ts`'s own digits, in value order — the inverse of its `<sup>` pass. */
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

const STRONG_TAGS: ReadonlySet<string> = new Set(['strong', 'b']);
const ITALIC_TAGS: ReadonlySet<string> = new Set(['em', 'i']);

/**
 * A flowing block's text, as the reflow had it, out of the element the emitter
 * wrote it into.
 *
 * `inner` is the source between the element's tags, taken by offset out of the
 * document exactly as `maskBlock` takes it, so nothing here re-serialises
 * anybody's markup.
 *
 * Throws `MarkerError` naming the tag for anything the table above does not
 * cover. The caller keeps the block in the source language and says so.
 */
export function flowTextOf(inner: string): string {
  const root = parseXml(inner, 'xhtml');

  const walk = (node: XmlElement): string => {
    let out = '';
    for (const child of node.children) {
      if (child.kind === 'text') {
        // Decoded, because the model reads `Bär` and not `B&auml;r` — and
        // because a record's text is re-escaped on its way back into a document
        // by `dotsInline`, so an entity left in it would be written twice.
        out += decodeEntities(inner.slice(child.start, child.end));
        continue;
      }
      if (child.kind === 'other') {
        throw new MarkerError(
          'this block carries a comment or a CDATA section, which is not something the emitter '
          + 'writes and not something a flowing block\'s text can hold. Its words have not '
          + 'travelled.',
        );
      }

      const tag = child.tag;
      if (STRONG_TAGS.has(tag) && !child.selfClosing) { out += `**${walk(child)}**`; continue; }
      if (ITALIC_TAGS.has(tag) && !child.selfClosing) { out += `*${walk(child)}*`; continue; }
      if (tag === 'sup') { out += superscriptOf(walk(child)); continue; }
      if (tag === 'br') {
        /*
         * The newline this element stands for, and only where the file does not
         * already carry it. `dotsInline` writes `<br/>\n`, so in a cast book the
         * newline is the text node after this element and adding one here would
         * double every line break in a poem.
         */
        out += inner.slice(child.end, child.end + 1) === '\n' ? '' : '\n';
        continue;
      }
      if (tag === 'span' && child.attrs.get('epub:type') === 'pagebreak') {
        if (inner.slice(child.innerStart, child.innerEnd).trim().length > 0) {
          throw new MarkerError(
            'a page-break span in this block has words inside it. The emitter writes an empty one '
            + 'and nothing else does, so dropping this would drop text.',
          );
        }
        continue;
      }
      if (tag === 'a') {
        /*
         * Note apparatus, and only note apparatus. In a cast book every anchor
         * is a noteref or a backlink and each contains exactly one `<sup>`
         * holding the number the page printed (`dots-book.ts`). An anchor
         * holding anything else is a link somebody put in a book by hand, and
         * flattening it to its words would silently lose the destination.
         */
        const only = child.children.filter(
          (c) => c.kind !== 'text' || inner.slice(c.start, c.end).trim().length > 0,
        );
        const one = only.length === 1 ? only[0]! : null;
        if (one !== null && one.kind === 'element' && one.tag === 'sup') {
          out += superscriptOf(walk(one));
          continue;
        }
        throw new MarkerError(
          '<a> in this block is not a note reference — in a cast book every anchor holds one <sup> '
          + 'and nothing else. Flattening it would lose where it points.',
        );
      }

      throw new MarkerError(
        `<${child.name}> is an element this stage has no rule for at the text level. A flowing `
        + 'block\'s text carries markdown emphasis and superscript numbers and nothing else — add '
        + 'it to the table in src/translate/flowtext.ts.',
      );
    }
    return out;
  };

  return walk(root);
}

/**
 * `14` → `¹⁴`. The inverse of `dotsInline`'s digit pass.
 *
 * A `<sup>` whose content is not digits is refused rather than guessed at: the
 * emitter only ever writes digits there, so anything else is a book this stage
 * did not write, and a superscript letter turned into a digit run would be a
 * footnote reference to a note that does not exist.
 *
 * ONE ASYMMETRY, RECORDED. A run the emitter LINKED — `⁰⁵` on a page whose
 * notes it matched — reaches the file as `<sup>5</sup>`, because the linker
 * reads the run as a number to find the note by. So `⁰⁵` comes back as `⁵`. It
 * costs nothing downstream: the record's run renders through the same linker
 * again and produces the same `<sup>5</sup>` the cast has, so the page a reader
 * sees is identical either way. It is written down here because it is the one
 * place this file is not a byte-exact inverse.
 */
function superscriptOf(digits: string): string {
  const trimmed = digits.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    throw new MarkerError(
      `<sup>${digits.slice(0, 20)}</sup> is not a printed note number. The emitter writes digits `
      + 'there and nothing else, so this block was not written by foundry\'s own renderer.',
    );
  }
  return [...trimmed].map((d) => SUPERSCRIPT_DIGITS[Number(d)]!).join('');
}
