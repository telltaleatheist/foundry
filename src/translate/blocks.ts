/**
 * translate/blocks — which parts of a foundry chapter are words, which are not,
 * and which of them have to travel together.
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
 * ────────────────────────────────────────────────────────────────────────────
 * A BLOCK IS WHAT GETS SPLICED. A GROUP IS WHAT GETS SENT.
 *
 * Those used to be the same thing and they should not be. A `<li>` handed to a
 * model on its own has lost the list it was an item of, and the parallel
 * grammar that made the six items read as one sentence goes with it — each item
 * comes back in whatever construction the model chose for that item alone. A
 * table cell is worse: "Zahl" over a column of years and "Zahl" over a column
 * of member counts are different words in English, and a cell arriving without
 * its column header is not a hard translation, it is an unanswerable one.
 *
 * So this file also says which blocks belong in ONE request. A group is the
 * OUTERMOST stamped container and its parts:
 *
 *  - a stamped `<ul>`/`<ol>` (`list-item`) and its `<li>` elements;
 *  - a stamped `<blockquote>` (`quote`) and its stamped child blocks;
 *  - a `table` and every `<td>`/`<th>` under it, in row order.
 *
 * Each part keeps its OWN source range, because the answer is spliced back into
 * the element it came out of. The group is a fact about the request, never
 * about the document: nothing here merges two elements or rewrites one.
 *
 * A CONTAINER THIS FILE CANNOT TAKE APART CLEANLY IS NOT A GROUP. A `<ul>` with
 * a stamped list nested inside one of its items, a `<tr>` holding something
 * that is not a cell, two tables inside one wrapper — each of those is handed
 * back as its innermost blocks, exactly as before, and named in `notes` so the
 * run says out loud that it sent one item at a time (ARCHITECTURE §8). Guessing
 * a structure would put a translated cell in the wrong cell, which is the one
 * failure a reader cannot see.
 *
 * TWO CATEGORIES ARE SKIPPED, AND THE COUNT IS REPORTED.
 *
 *  - **formula** is notation. There are no words in it to translate, and every
 *    edit a model makes to it is damage.
 *  - **picture** is a `<figure>` around a cropped PNG. Its caption is a
 *    separate block with its own stamp and IS translated.
 *
 * **table USED TO BE THE THIRD AND IS NOT ANY MORE**, and the reversal is worth
 * writing down because the old reason was correct at the time. A `<table>` is
 * the vision model's own HTML (`checkTableHtml` in `dots.ts`), and a grid whose
 * meaning lives in which cell sits under which header; a model asked to rewrite
 * the prose inside one had every opportunity to merge two cells, drop a row or
 * move a `<th>`, and a table whose columns quietly swapped is worse than a
 * table nobody translated, because it looks fine. That opportunity is now gone.
 * THE MODEL NEVER SEES THE TABLE. It sees rows of words with `|` between the
 * cells; the `<tr>`s, the `<td>`s, the attributes and the cell boundaries are
 * held here and never leave this process, and an answer with the wrong number
 * of cells in a row is rejected mechanically rather than spliced. Structure the
 * model cannot touch is structure the model cannot break — so the words in a
 * table are translated like any other words, and the grid is still the book's.
 *
 * The count of each skipped category goes in the run's summary, because a book
 * that came back with fourteen untranslated figures in it must say so on the
 * way out rather than be discovered on page 200.
 *
 * A CATEGORY THIS FILE HAS NO RULE FOR STOPS THE RUN. The ten below are the
 * whole of what `dots-book.ts` writes. An eleventh means the emitter grew a
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
  'text', 'title', 'section-header', 'quote', 'footnote', 'caption', 'list-item', 'chapter', 'table',
]);

/** The stamps left exactly as they are. See the header for each one's reason. */
export const SKIPPED_CATEGORIES: ReadonlySet<string> = new Set(['formula', 'picture']);

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

/**
 * What kind of thing the parts of a group came out of.
 *
 * `single` is a block that stands alone — a paragraph, a heading, a caption, a
 * footnote — and is exactly what this file used to return for everything. The
 * other three are containers, and the kind is what tells `run.ts` how to render
 * the parts for the model and what to call the group in the log.
 */
export type GroupKind = 'single' | 'list' | 'quote' | 'table';

export interface BlockGroup {
  kind: GroupKind;
  /** Every translatable part, in document order. Never empty. */
  parts: BlockSite[];
  /**
   * `table` only: how many cells each row holds, in row order, summing to
   * `parts.length`. It is the whole of the grid this program keeps — the flat
   * list of cells plus these numbers is what turns an answer's pipe rows back
   * into the cells they belong in.
   */
  rowSizes: number[];
}

export interface ChapterBlocks {
  /** Every group in document order. `sites` is exactly these, flattened. */
  groups: BlockGroup[];
  sites: BlockSite[];
  /** Skipped category → how many. */
  skipped: Map<string, number>;
  /**
   * Containers this file could not take apart, each said in a sentence for the
   * run's log. Their blocks are still in `sites` — they are translated one at a
   * time instead of together, which is a worse translation and never a silent
   * one.
   */
  notes: string[];
  /** The range of the `<html>` start tag, where `lang`/`xml:lang` live. */
  htmlTagStart: number;
  htmlTagEnd: number;
}

/**
 * Every block in one chapter document, grouped, in document order.
 *
 * Document order matters three times: it is the order the blocks are translated
 * in, which makes the progress log follow the book; it is what lets the first
 * heading in the file be identified as the chapter's title for the nav; and it
 * is the order the parts of a group are rendered in, which is the ONLY thing
 * that says which answer belongs to which element.
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

  /** Whether an element's content is nothing but whitespace. */
  const blank = (el: XmlElement): boolean =>
    source.slice(el.innerStart, el.innerEnd).trim().length === 0;

  const siteOf = (el: XmlElement, category: string, page: string | null): BlockSite => ({
    category,
    tag: el.tag,
    page: el.attrs.get('data-bf-page') ?? page,
    id: el.attrs.get('id') ?? null,
    heading: HEADING_TAGS.has(el.tag),
    innerStart: el.innerStart,
    innerEnd: el.innerEnd,
  });

  const groups: BlockGroup[] = [];
  const skipped = new Map<string, number>();
  const notes: string[] = [];
  /*
   * The elements a group has already claimed. The walk is depth-first and a
   * container is reached before its items, so by the time an `<li>` comes round
   * its `<ul>` has either taken it or decided it could not — and an item taken
   * by a group must not become a block of its own as well, which would ask the
   * model for the same words twice and then splice both answers into one range.
   */
  const claimed = new Set<XmlElement>();
  let htmlTagStart = -1;
  let htmlTagEnd = -1;

  for (const el of elements(root)) {
    if (el.tag === 'html' && htmlTagStart < 0) {
      htmlTagStart = el.start;
      htmlTagEnd = el.innerStart;
    }
    const category = el.attrs.get('data-bf-cat');
    if (category === undefined || claimed.has(el)) continue;

    if (SKIPPED_CATEGORIES.has(category)) {
      // Counted on the OUTERMOST stamp only, so a skipped block whose wrapper
      // and inner element are both stamped is one figure, not two.
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

    /*
     * A TABLE IS A GROUP OR IT IS NOTHING. Its cells are not stamped — they are
     * the vision model's own HTML — so they are found structurally, and there
     * is no innermost-stamp reading of a table that would produce blocks. If
     * the grid cannot be read out cleanly the whole table is left as the book
     * wrote it, counted where the skipped figures are counted, and named.
     */
    if (category === 'table') {
      if (ancestorIsStamped(el, stamped)) continue;
      for (const inside of elements(el)) claimed.add(inside);
      const rows = tableRows(el);
      if (rows === null || rows.length === 0) {
        skipped.set('table', (skipped.get('table') ?? 0) + 1);
        notes.push(
          `${where}: a table on page ${el.attrs.get('data-bf-page') ?? '?'} is not a grid this stage `
          + 'can read out cell by cell (a nested table, or a row holding something that is not a '
          + 'cell). It is in the book exactly as it was written, in the source language.',
        );
        continue;
      }
      const page = el.attrs.get('data-bf-page') ?? null;
      groups.push({
        kind: 'table',
        parts: rows.flat().map((cell) => siteOf(cell, 'table', page)),
        rowSizes: rows.map((r) => r.length),
      });
      continue;
    }

    if (hasStampedDescendant(el)) {
      /*
       * A CONTAINER. Its items go in one request when this file can prove what
       * the items are; otherwise the walk carries on and each innermost stamp
       * becomes its own block, which is what this file did for everything until
       * grouping existed. Either way the container itself is never a block.
       */
      const kind = containerKind(el, category);
      const items = kind === null ? null : leafChildren(el, stamped, hasStampedDescendant);
      if (kind !== null && items !== null) {
        for (const item of items) claimed.add(item);
        const parts = items.filter((item) => !blank(item)).map((item) => siteOf(item, category, null));
        if (parts.length > 0) groups.push({ kind, parts, rowSizes: [] });
        continue;
      }
      if (kind !== null) {
        notes.push(
          `${where}: the ${kind} on page ${el.attrs.get('data-bf-page') ?? '?'} holds something other `
          + 'than plain items — its blocks are translated one at a time rather than together, which '
          + 'costs the parallel grammar a list gets from being read whole.',
        );
      }
      continue;
    }

    // An empty element — a `<p>` whose whole content was a page-break span, or
    // a heading the book left blank — has nothing to send anywhere. Skipping it
    // silently is right: there is no text, so there is no translation to be
    // missing, and a refusal here would fail a book over whitespace.
    if (blank(el)) continue;

    groups.push({ kind: 'single', parts: [siteOf(el, category, null)], rowSizes: [] });
  }

  if (htmlTagStart < 0) {
    throw new BlockError(`${where} has no <html> element — it is not an XHTML document`);
  }
  return { groups, sites: groups.flatMap((g) => g.parts), skipped, notes, htmlTagStart, htmlTagEnd };
}

/**
 * Which kind of group a stamped container would be, or null if it is not one.
 *
 * Matched on the TAG as well as the category because the category is a fact
 * about the words and the tag is a fact about the shape: a `<div>` that somehow
 * carries `list-item` is not a list whose items are its children, and rendering
 * it as numbered lines would be this file inventing a structure the document
 * does not have.
 */
function containerKind(el: XmlElement, category: string): GroupKind | null {
  if (category === 'list-item' && (el.tag === 'ul' || el.tag === 'ol')) return 'list';
  if (category === 'quote' && el.tag === 'blockquote') return 'quote';
  return null;
}

/**
 * A container's stamped children, when every stamped element under it is one of
 * them. Null when it is not.
 *
 * The strictness is the point. A `<ul>` with a nested stamped `<ul>` inside one
 * of its items has items that are not leaves, and treating the outer list's
 * `<li>`s as parts would send the inner list's text twice — once inside its
 * item's line and once as its own block — and then splice two answers into
 * overlapping ranges. Rather than model nesting, this returns null and the
 * caller falls back to one request per innermost block, out loud.
 */
function leafChildren(
  el: XmlElement,
  stamped: ReadonlySet<XmlElement>,
  hasStampedDescendant: (el: XmlElement) => boolean,
): XmlElement[] | null {
  const items: XmlElement[] = [];
  for (const child of el.children) {
    if (child.kind !== 'element') continue;
    if (!stamped.has(child)) {
      // Unstamped furniture between the items — a `<hr/>`, a wrapper — is fine
      // as long as no block is hiding in it. One that is would be a block this
      // group silently never sent.
      if (hasStampedDescendant(child)) return null;
      continue;
    }
    if (hasStampedDescendant(child)) return null;
    items.push(child);
  }
  return items.length === 0 ? null : items;
}

/**
 * A table's cells, row by row, or null if this is not a grid.
 *
 * `<thead>`/`<tbody>`/`<tfoot>` are transparent — the rows are found by walking
 * for `<tr>` wherever they sit — but a `<tr>` whose children are not all cells,
 * and a wrapper holding more than one `<table>`, both return null. Those are
 * shapes whose row order this stage would be GUESSING at, and a guess here puts
 * a translated cell under the wrong header.
 */
function tableRows(wrapper: XmlElement): XmlElement[][] | null {
  let tables = 0;
  const rows: XmlElement[][] = [];
  for (const el of elements(wrapper)) {
    if (el.tag === 'table') tables += 1;
    if (el.tag !== 'tr') continue;
    const cells: XmlElement[] = [];
    for (const child of el.children) {
      if (child.kind !== 'element') continue;
      if (child.tag !== 'td' && child.tag !== 'th') return null;
      cells.push(child);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (tables > 1) return null;
  return rows;
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
