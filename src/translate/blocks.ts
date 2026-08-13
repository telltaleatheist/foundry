/**
 * translate/blocks — which parts of a foundry chapter are words, and which are
 * not.
 *
 * `dots-book.ts` stamps every element it writes with `data-bf-cat`, the model's
 * own category for the block it came from, lower-cased. That attribute exists
 * so BookForge's picker can select "every footnote" in a format with no page
 * concept — and it turns out to be exactly the index a translator needs, for
 * the same reason: it is the only place in an EPUB where the book says what
 * each paragraph IS.
 *
 * THE INNERMOST STAMP WINS, and this is not a detail. A quote is written as
 * `<blockquote data-bf-cat="quote"><p data-bf-cat="quote">…</p></blockquote>`
 * and a list as `<ul data-bf-cat="list-item">` around `<li data-bf-cat="list-item">`
 * — the stamp is on the wrapper AND on the thing inside it, because the picker
 * needs to select either. A rule that translated every stamped element would
 * translate each of those blocks twice, and the second pass would be handed the
 * `<p>` tags of the first as if they were prose. So an element that CONTAINS
 * another stamped element is not a block; the thing inside it is.
 *
 * THREE CATEGORIES ARE SKIPPED, AND THE COUNT IS REPORTED.
 *
 *  - **table** is the model's own HTML (`checkTableHtml` in `dots.ts`), not
 *    foundry's markup. A `<table>` is a grid whose meaning lives in which cell
 *    sits under which header, and a model rewriting the prose inside one has
 *    every opportunity to merge two cells, drop a row, or move a `<th>`. A
 *    table with German headers is a table somebody can read; a table whose
 *    columns quietly swapped is worse than no translation at all, and it looks
 *    fine.
 *  - **formula** is notation. There are no words in it to translate, and every
 *    edit a model makes to it is damage.
 *  - **picture** is a `<figure>` around a cropped PNG. Its caption is a
 *    separate block with its own stamp and IS translated.
 *
 * The count of each goes in the run's summary, because a book that came back
 * with fourteen untranslated tables in it must say so on the way out rather
 * than be discovered on page 200.
 *
 * A CATEGORY THIS FILE HAS NO RULE FOR STOPS THE RUN. The eleven below are the
 * whole of what `dots-book.ts` writes. A twelfth means the emitter grew a
 * category and this file did not hear about it, and the two possible silent
 * outcomes — translating something that should not be, or skipping prose — are
 * both invisible in the output (ARCHITECTURE §8).
 */
import { elements, parseXml, type XmlElement } from '../epub/xml.js';

/** A category no rule here covers. Always names it. */
export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockError';
  }
}

/** The stamps whose text is replaced with a translation. */
export const TRANSLATED_CATEGORIES: ReadonlySet<string> = new Set([
  'text', 'title', 'section-header', 'quote', 'footnote', 'caption', 'list-item', 'chapter',
]);

/** The stamps left exactly as they are. See the header for each one's reason. */
export const SKIPPED_CATEGORIES: ReadonlySet<string> = new Set(['table', 'formula', 'picture']);

const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** One translatable block: where its words are, and what it is. */
export interface BlockSite {
  category: string;
  tag: string;
  /** The PDF page it was read from, for naming it in a refusal. Absent is legal. */
  page: string | null;
  /** The element's own id, when it has one — what a nav link points at. */
  id: string | null;
  /** Whether this block is a heading, which is what a nav label can come from. */
  heading: boolean;
  /** Source range of the inner XHTML, from `xml.ts`'s offsets. */
  innerStart: number;
  innerEnd: number;
}

export interface ChapterBlocks {
  sites: BlockSite[];
  /** Skipped category → how many. */
  skipped: Map<string, number>;
  /** The range of the `<html>` start tag, where `lang`/`xml:lang` live. */
  htmlTagStart: number;
  htmlTagEnd: number;
}

/**
 * Every block in one chapter document, in document order.
 *
 * Document order matters twice: it is the order the blocks are translated in,
 * which makes the progress log follow the book, and it is what lets the first
 * heading in the file be identified as the chapter's title for the nav.
 */
export function findBlocks(source: string, where: string): ChapterBlocks {
  const root = parseXml(source, 'xhtml');

  // Every element that carries a stamp, so the innermost test below can ask
  // whether any of a candidate's descendants is one of them.
  const stamped = new Set<XmlElement>();
  for (const el of elements(root)) {
    if (el.attrs.has('data-bf-cat')) stamped.add(el);
  }

  const hasStampedDescendant = (el: XmlElement): boolean => {
    for (const child of elements(el)) {
      if (child !== el && stamped.has(child)) return true;
    }
    return false;
  };

  const sites: BlockSite[] = [];
  const skipped = new Map<string, number>();
  let htmlTagStart = -1;
  let htmlTagEnd = -1;

  for (const el of elements(root)) {
    if (el.tag === 'html' && htmlTagStart < 0) {
      htmlTagStart = el.start;
      htmlTagEnd = el.innerStart;
    }
    const category = el.attrs.get('data-bf-cat');
    if (category === undefined) continue;

    if (SKIPPED_CATEGORIES.has(category)) {
      // Counted on the OUTERMOST stamp only, so a skipped block whose wrapper
      // and inner element are both stamped is one table, not two.
      if (el.parent !== null && !ancestorIsStamped(el, stamped)) {
        skipped.set(category, (skipped.get(category) ?? 0) + 1);
      }
      continue;
    }
    if (!TRANSLATED_CATEGORIES.has(category)) {
      throw new BlockError(
        `${where} carries data-bf-cat="${category}", which this stage has no rule for. `
        + 'Every category is either translated or deliberately skipped and counted; a new one '
        + 'means src/translate/blocks.ts has fallen behind the emitter.',
      );
    }
    if (hasStampedDescendant(el)) continue;
    // An empty element — a `<p>` whose whole content was a page-break span, or
    // a heading the book left blank — has nothing to send anywhere. Skipping it
    // silently is right: there is no text, so there is no translation to be
    // missing, and a refusal here would fail a book over whitespace.
    if (source.slice(el.innerStart, el.innerEnd).trim().length === 0) continue;

    sites.push({
      category,
      tag: el.tag,
      page: el.attrs.get('data-bf-page') ?? null,
      id: el.attrs.get('id') ?? null,
      heading: HEADING_TAGS.has(el.tag),
      innerStart: el.innerStart,
      innerEnd: el.innerEnd,
    });
  }

  if (htmlTagStart < 0) {
    throw new BlockError(`${where} has no <html> element — it is not an XHTML document`);
  }
  return { sites, skipped, htmlTagStart, htmlTagEnd };
}

function ancestorIsStamped(el: XmlElement, stamped: ReadonlySet<XmlElement>): boolean {
  for (let p = el.parent; p !== null; p = p.parent) {
    if (stamped.has(p)) return true;
  }
  return false;
}

/**
 * Replace source ranges, right to left.
 *
 * Right to left because every edit before an earlier one would move it: doing
 * it the other way needs a running offset, and a running offset is the kind of
 * arithmetic that is correct until somebody adds a second kind of edit. The
 * ranges are asserted disjoint rather than assumed — an overlap here means two
 * edits fighting over one span of somebody's book.
 */
export function spliceAll(
  source: string,
  edits: readonly { start: number; end: number; text: string }[],
): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new BlockError(
        `two edits overlap at offset ${sorted[i].start} — this is a defect in the block walk, `
        + 'not something the book did',
      );
    }
  }
  let out = source;
  for (let i = sorted.length - 1; i >= 0; i--) {
    out = out.slice(0, sorted[i].start) + sorted[i].text + out.slice(sorted[i].end);
  }
  return out;
}

/**
 * Rewrite `lang` and `xml:lang` on a start tag, adding them if they are absent.
 *
 * A translated document that still declares the source language is a document
 * that hyphenates German rules over English words and hands a screen reader the
 * wrong voice. Both spellings are set because XHTML in an EPUB is served as XML
 * to some reading systems and as HTML to others, and `dots-book.ts` writes both
 * for the same reason.
 */
export function retagLanguage(startTag: string, language: string): string {
  const escaped = language.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  let out = startTag;
  let found = false;
  out = out.replace(/\b(xml:lang|lang)\s*=\s*("[^"]*"|'[^']*')/g, (_m, name: string) => {
    found = true;
    return `${name}="${escaped}"`;
  });
  if (found) return out;
  // No declaration at all: insert one just before the tag closes, which is
  // where an attribute may always go.
  return out.replace(/\s*\/?>$/, (close) => ` xml:lang="${escaped}" lang="${escaped}"${close.trimStart()}`);
}
