/**
 * epub/stamp — reading the structure a publisher's EPUB already states.
 *
 * A born-digital EPUB from a publisher carries no foundry stamps: no
 * `data-bf-cat`, no `data-bf-id`, no page provenance. Every downstream thing
 * therefore refuses it or does nothing — `readFoundryBook` admits a book only if
 * some document carries a category, so `translate` and `epub-final` both refuse
 * it BY NAME, select mode outlines nothing, and the inspector shows no
 * categories. The project model imports such a book happily and then nothing can
 * act on it. This command is what closes that gap.
 *
 * A PUBLISHER'S EPUB IS NOT A DEGRADED SCAN; IT IS A BETTER SOURCE. The vision
 * route has to infer structure from ink — where a line sits in the column, how
 * tall its type is, whether a paragraph carried over a page turn — because a
 * photograph of a page is all it has. An EPUB's markup ALREADY STATES the
 * structure, and EPUB 3's `epub:type` / DPUB-ARIA `role` vocabulary states it
 * explicitly. Nothing here guesses at anything the file already says; it reads
 * the file, in layers, most certain first, and the report says which layer
 * decided how many blocks.
 *
 * WHAT IT WRITES IS ONLY WHAT IS MISSING, attribute by attribute. A book already
 * carrying `data-bf-cat` keeps every one of them — a person's relabelling in the
 * inspector is not something a later pass gets to overrule — and a cast book
 * that predates `data-bf-id` gets ids and nothing else. Running it twice
 * therefore changes nothing the second time, which is asserted in the tests
 * because it is the property that makes running it on every import safe.
 *
 * NOTHING HERE SERIALIZES A DOCUMENT, for `xml.ts`'s reason: every write is an
 * INSERTION of a few attributes at one offset inside one start tag, computed
 * from the parser's source ranges. A document this command did not stamp comes
 * back byte-identical, and one it did differs only inside the start tags it
 * added attributes to. Re-serialising would renormalise attribute quoting,
 * entity spelling and self-closing syntax across a whole book, which is an
 * invisible diff in every chapter and a re-encode of every plate.
 *
 * PAGE PROVENANCE IS KEPT, NEVER INVENTED. Many publisher EPUBs carry
 * `<span epub:type="pagebreak">` for the printed edition's pagination, and where
 * they exist the blocks after each one carry that page exactly as a cast book
 * does — real provenance, worth having, and what makes a quotation citable.
 * Where they do not exist the attribute is simply ABSENT. A page number this
 * program made up would be a claim about a printed edition nobody consulted, and
 * it would look exactly like the true kind. Owen's word on it: "page number
 * isnt really necessary in an epub anyway... we should keep it if its available
 * but we dont need it".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { spliceAll } from '../translate/blocks.js';
import { containerFromMembers } from '../translate/book.js';
import type { ZipMember } from '../translate/unzip.js';
import { FinalError, readEpubInput } from './final.js';
import { decodeEntities, elements, findElement, parseXml, type XmlElement } from './xml.js';

/** A book this command will not stamp. Always names the path or the flag. */
export class StampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StampError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The attributes, and the eleven categories they may say
// ═════════════════════════════════════════════════════════════════════════════

const CATEGORY_ATTRIBUTE = 'data-bf-cat';
const PAGE_ATTRIBUTE = 'data-bf-page';
const ID_ATTRIBUTE = 'data-bf-id';

/**
 * Which layer decided a block's category, counted so the report can say.
 *
 * The order is the order of certainty, and it is the whole design: a
 * declaration the publisher wrote beats a reading of the element's shape, which
 * beats an argument from where the element sits, which beats the default. Where
 * two layers disagree the earlier one wins and nothing is averaged.
 */
export type StampLayer = 'declaration' | 'shape' | 'position' | 'default';

/**
 * EPUB 3 structural semantics and DPUB-ARIA roles, mapped onto foundry's eleven.
 *
 * THIS IS A DECLARATION, NOT AN INFERENCE. `epub:type="footnote"` is the
 * publisher saying, in the vocabulary the specification defines for saying it,
 * that this element is a footnote. Reading it is not a guess and it outranks
 * every other rule here — including the element's own tag, because a house style
 * that renders epigraphs as `<p class="epi">` has still said `epub:type` on it.
 *
 * Both spellings of each token are in the table because both are in the wild:
 * `epub:type` carries the bare EPUB token (`footnote`, `epigraph`) and `role`
 * carries the DPUB-ARIA one (`doc-footnote`, `doc-epigraph`), and a publisher
 * may write either, both, or one on the element and the other on its wrapper.
 *
 * The vocabulary is much larger than this. Only tokens that name a BLOCK OF
 * WORDS with an unambiguous foundry category are here: `chapter`, `preface` and
 * `part` are on the `<section>` that CONTAINS a chapter and say nothing about
 * any block inside it, and inventing a category for that section would put a box
 * around the whole page in select mode.
 */
const DECLARED_CATEGORIES: ReadonlyMap<string, string> = new Map(Object.entries({
  // A note, wherever the edition prints it. foundry has one category for all
  // three, because "at the foot of the page" and "at the end of the book" is a
  // typesetting decision and not a difference in what the words are.
  footnote: 'footnote',
  'doc-footnote': 'footnote',
  endnote: 'footnote',
  'doc-endnote': 'footnote',
  rearnote: 'footnote',
  note: 'footnote',
  // Prose set off from the paragraph around it.
  epigraph: 'quote',
  'doc-epigraph': 'quote',
  pullquote: 'quote',
  'doc-pullquote': 'quote',
  // The book's own name, and the parts a title page carries.
  title: 'title',
  fulltitle: 'title',
  covertitle: 'title',
  halftitle: 'title',
  subtitle: 'title',
  'doc-subtitle': 'title',
  // A heading with no sectioning of its own — exactly a section header.
  bridgehead: 'section-header',
  // The words under a plate.
  credit: 'caption',
  'doc-credit': 'caption',
}));

/**
 * Tokens that say "this element is APPARATUS or a CONTAINER, not a block".
 *
 * Named rather than left to fall through, because the shape layer below would
 * otherwise read some of them as blocks and be wrong every time: an
 * `<ol epub:type="endnotes">` is not a list of list-items, it is the note
 * apparatus, and its `<li epub:type="endnote">` children are the blocks. A
 * `<span epub:type="pagebreak">` is the page marker itself and stamping it would
 * make the marker a block that carries its own page.
 *
 * Suppression stops at the element. The CHILDREN of a suppressed element are
 * judged on their own, which is the entire point for the endnotes case.
 */
const DECLARED_APPARATUS: ReadonlySet<string> = new Set([
  'footnotes', 'endnotes', 'rearnotes', 'doc-endnotes',
  'toc', 'doc-toc', 'landmarks', 'page-list', 'doc-pagelist',
  'pagebreak', 'doc-pagebreak',
  'noteref', 'doc-noteref', 'backlink', 'doc-backlink',
  'annoref', 'doc-biblioref', 'doc-glossref', 'doc-index',
]);

/**
 * Tags that make an ancestor a CONTAINER rather than a block.
 *
 * The leaf test below asks whether an element has one of these under it, and a
 * `<div>` wrapping a chapter does — which is precisely why it is never stamped.
 * `<img>` is deliberately NOT here: an image inside a paragraph is content, not
 * structure, and a paragraph with a picture in it is still one paragraph.
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'section', 'article', 'aside', 'blockquote', 'ul', 'ol', 'li',
  'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'figure', 'figcaption', 'pre', 'hr', 'header', 'footer', 'nav',
  'main', 'address', 'details', 'summary', 'fieldset', 'hgroup', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LIST_TAGS: ReadonlySet<string> = new Set(['ul', 'ol', 'dl']);
const ITEM_TAGS: ReadonlySet<string> = new Set(['li', 'dt', 'dd']);

/**
 * Where the DEFAULT rule is allowed to fire.
 *
 * `<p>` is the case the rule exists for. `<div>` and `<pre>` are here because a
 * house style that sets paragraphs in either is common and a book whose prose is
 * `<div class="para">` would otherwise come out of this command with no `text`
 * blocks at all — but only as a LEAF, so the container argument is unaffected: a
 * `<div>` with any structural element under it is never a candidate.
 */
const PROSE_TAGS: ReadonlySet<string> = new Set(['p', 'div', 'pre', 'address']);

/** A sentinel category: a heading, whose real value the position layer decides. */
const HEADING = '\u0000heading';

// ═════════════════════════════════════════════════════════════════════════════
// The report
// ═════════════════════════════════════════════════════════════════════════════

export interface StampReport {
  /** The directory stamped in place, or the file written. */
  outPath: string;
  /** True when `--epub` was a working tree and was stamped where it stands. */
  inPlace: boolean;
  /** Spine documents. The nav document is among them when the spine carries it, and is never stamped. */
  documents: number;
  /** Documents whose text changed. Zero on a second run. */
  documentsWritten: number;
  /** Blocks stamped by this run, by the category they were given. */
  stamped: Record<string, number>;
  /** Blocks stamped by this run, by the layer that decided. */
  byLayer: Record<StampLayer, number>;
  /** Elements that already carried `data-bf-cat` and were left exactly alone. */
  alreadyStamped: number;
  /** `data-bf-id` written where there was none. */
  idsWritten: number;
  /** Elements that already carried `data-bf-id`. */
  alreadyNamed: number;
  /** Printed pages the book's own pagebreak markers declare. Zero is legal. */
  pages: number;
  /** `data-bf-page` written from those markers. */
  pagesStamped: number;
  /** Elements that already carried `data-bf-page`. */
  alreadyPaged: number;
  /**
   * Documents whose headings became `title` rather than `chapter`, because the
   * document carries no prose at all. Named, because it is the one positional
   * rule whose answer is not obvious from the file.
   */
  titleOnlyDocuments: string[];
  /** Documents whose first heading became the chapter opener. */
  chapterOpeners: number;
}

function emptyReport(outPath: string, inPlace: boolean): StampReport {
  return {
    outPath,
    inPlace,
    documents: 0,
    documentsWritten: 0,
    stamped: {},
    byLayer: { declaration: 0, shape: 0, position: 0, default: 0 },
    alreadyStamped: 0,
    idsWritten: 0,
    alreadyNamed: 0,
    pages: 0,
    pagesStamped: 0,
    alreadyPaged: 0,
    titleOnlyDocuments: [],
    chapterOpeners: 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading one element
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `epub:type` and `role` together, as the token lists they are.
 *
 * Only those two. A bare `type` attribute is HTML's — `<input type="text">`,
 * `<ol type="1">` — and reading it as vocabulary would turn a form control into
 * a block of body text.
 */
function declaredTokens(el: XmlElement): string[] {
  const out: string[] = [];
  for (const name of ['epub:type', 'role'] as const) {
    const value = el.attrs.get(name);
    if (value === undefined) continue;
    for (const token of value.split(/\s+/)) if (token.length > 0) out.push(token.toLowerCase());
  }
  return out;
}

/** The publisher's own answer, `null` if it gave none, `false` if it said "apparatus". */
function declaredCategory(el: XmlElement): string | null | false {
  for (const token of declaredTokens(el)) {
    if (DECLARED_APPARATUS.has(token)) return false;
  }
  for (const token of declaredTokens(el)) {
    const category = DECLARED_CATEGORIES.get(token);
    if (category !== undefined) return category;
  }
  return null;
}

/** Is there a structural element under this one? Then it is a container. */
function hasStructureInside(el: XmlElement): boolean {
  for (const inner of elements(el)) {
    if (inner !== el && STRUCTURAL_TAGS.has(inner.tag)) return true;
  }
  return false;
}

/** Everything between an element's tags, entity-decoded, tags removed. */
function textInside(source: string, el: XmlElement): string {
  let out = '';
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.kind === 'text') out += source.slice(child.start, child.end);
      else if (child.kind === 'other' && child.what === 'cdata') {
        out += source.slice(child.innerStart, child.innerEnd);
      } else if (child.kind === 'element') walk(child);
    }
  };
  walk(el);
  return decodeEntities(out);
}

function hasWords(source: string, el: XmlElement): boolean {
  return /\S/.test(textInside(source, el));
}

/** The only element child, when there is exactly one and nothing else but space. */
function soleElementChild(source: string, el: XmlElement): XmlElement | null {
  let only: XmlElement | null = null;
  for (const child of el.children) {
    if (child.kind === 'element') {
      if (only !== null) return null;
      only = child;
      continue;
    }
    if (child.kind === 'text' && /\S/.test(decodeEntities(source.slice(child.start, child.end)))) return null;
  }
  return only;
}

/**
 * What the element's SHAPE says, when the publisher declared nothing.
 *
 * These are readings of markup that means one thing: a `<blockquote>` is set-off
 * prose in every stylesheet ever written, an `<li>` is a list item by
 * definition, a `<figcaption>` is the caption of the figure it is in. The two
 * that are not one-to-one are worth naming:
 *
 *  - a `<table>` inside a wrapper is stamped on the WRAPPER, because that is
 *    what `dots-book.ts` emits (`<div class="tablewrap" …><table>`) and the two
 *    books must be indistinguishable in kind to everything downstream;
 *  - a `<p>` or `<div>` whose entire content is one `<img>` is a picture, not a
 *    paragraph. The default rule would find no words in it and leave it
 *    unstamped, and a plate that select mode cannot address is a plate nobody
 *    can remove.
 */
function shapeCategory(source: string, el: XmlElement): string | null {
  if (HEADING_TAGS.has(el.tag)) return HEADING;
  switch (el.tag) {
    case 'figure': return 'picture';
    case 'figcaption': case 'caption': return 'caption';
    case 'img': return 'picture';
    case 'table': return 'table';
    case 'blockquote': return 'quote';
    default: break;
  }
  if (LIST_TAGS.has(el.tag) || ITEM_TAGS.has(el.tag)) return 'list-item';

  const only = soleElementChild(source, el);
  if (only !== null && (el.tag === 'div' || el.tag === 'section')) {
    if (only.tag === 'table') return 'table';
  }
  if (only !== null && only.tag === 'img' && (el.tag === 'p' || el.tag === 'div')) return 'picture';
  return null;
}

/**
 * The emitter's own container/child pairs, and NOTHING else.
 *
 * `dots-book.ts` stamps both halves of exactly three shapes — `<ul>` over its
 * `<li>`, `<blockquote>` over its `<p>`, `<figure>` over what belongs to it —
 * and a stamped element's other descendants are its INSIDES: the `<td>`s of a
 * table, the `<em>` in a sentence, the `<img>` in a figure. Stamping those would
 * draw a box inside a box in select mode and give the translator a cell to
 * translate twice.
 *
 * Returns the category the child takes, or null when it is not one of the pairs
 * — which is the signal to leave it alone entirely.
 */
function pairedCategory(container: XmlElement, containerCategory: string, el: XmlElement): string | null {
  if (container.tag === 'blockquote' && el.tag === 'p') return containerCategory;
  if (LIST_TAGS.has(container.tag) && ITEM_TAGS.has(el.tag)) return containerCategory;
  // A list nested inside an item: the same pair, one level down. Cast books
  // never nest, but publishers' do, and an unstamped inner list would leave
  // every item under it unaddressable.
  if (ITEM_TAGS.has(container.tag) && LIST_TAGS.has(el.tag)) return containerCategory;
  if (container.tag === 'figure' && el.tag === 'figcaption') return 'caption';
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The printed pages, where the book has them
// ═════════════════════════════════════════════════════════════════════════════

interface PageMarker { at: number; page: string }

function isPagebreak(el: XmlElement): boolean {
  const tokens = declaredTokens(el);
  return tokens.includes('pagebreak') || tokens.includes('doc-pagebreak');
}

/**
 * What page a marker names, from wherever this publisher put it.
 *
 * Four spellings, in order of how directly each states the number. `title` and
 * `aria-label` are the two the wild actually uses — the label is what a screen
 * reader announces, so it is the printed number by construction — and the
 * marker's own text is the last resort for a visible marker. A marker naming no
 * page at all is not an error and not a guess: it is skipped, and the blocks
 * after it keep whatever page was last stated.
 */
function pageOfMarker(source: string, el: XmlElement): string | null {
  const candidates = [
    el.attrs.get(PAGE_ATTRIBUTE),
    el.attrs.get('title'),
    el.attrs.get('aria-label'),
    /^pb[-_]?(.+)$/i.exec(el.attrs.get('id') ?? '')?.[1],
    textInside(source, el),
  ];
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim();
    if (value.length > 0) return printedPage(value);
  }
  return null;
}

/**
 * The printed number inside a marker's label, or the label as it stands.
 *
 * `aria-label` is what a screen reader ANNOUNCES, so publishers write "Page 12"
 * in it far more often than "12" — and a book stamped with
 * `data-bf-page="Page 12"` would still work, since every rule downstream
 * compares pages for equality, but it would read wrong in every log line and
 * every refusal that quotes a page. The word in front is the reading system's;
 * the number is the book's.
 *
 * A label this does not recognise is kept VERBATIM rather than dropped. It is
 * still the page the book named, and losing provenance to tidiness is the one
 * thing this file is written not to do. (`mint` below is where an unusual page
 * stops being able to name an id, and it says so there.)
 */
function printedPage(raw: string): string {
  const label = raw.replace(/\s+/g, ' ').trim();
  const numbered = /^(?:page|pg\.?|p\.|seite|s\.)\s*([0-9]+[a-z]?|[ivxlcdm]+)$/i.exec(label);
  return numbered === null ? label : numbered[1]!;
}

/**
 * The offset a block's own content begins at, leading whitespace skipped.
 *
 * This is what decides which page a block belongs to, and the whitespace skip is
 * the load-bearing part. A cast book writes the marker INSIDE the first block of
 * its page — `<h1 …><span epub:type="pagebreak"…></span>Der Staat</h1>` — so the
 * block's own start tag comes before its page's marker; a publisher's book more
 * often writes the marker as a sibling between two blocks. Measuring from the
 * first content rather than from the start tag reads both correctly, and it also
 * gives the right answer for the third case: a marker in the MIDDLE of a
 * paragraph belongs to the page the paragraph ran onto, and the paragraph itself
 * began on the page before.
 */
function firstContentOffset(source: string, el: XmlElement): number {
  let at = el.innerStart;
  while (at < el.innerEnd && /\s/.test(source[at]!)) at += 1;
  return at;
}

// ═════════════════════════════════════════════════════════════════════════════
// One document
// ═════════════════════════════════════════════════════════════════════════════

interface Insertion { start: number; end: number; text: string }

/**
 * Where an attribute goes in a start tag: just before its own `>` or `/>`.
 *
 * `innerStart` is the offset one past the whole start tag in every case the
 * parser produces — a normal element, an explicitly self-closed one, and an HTML
 * void tag written without a slash — so the `>` is always the character before
 * it, and a `/` before that is the only other thing that can be in the way.
 */
function attributeInsertPoint(source: string, el: XmlElement): number {
  let at = el.innerStart - 1;
  if (source[at] !== '>') {
    // Unreachable against a tree this parser produced; named rather than
    // silently mis-spliced, because a wrong offset here writes an attribute into
    // the middle of somebody's prose.
    throw new StampError(`the start tag of <${el.name}> at offset ${el.start} does not end in ">"`);
  }
  if (source[at - 1] === '/') at -= 1;
  return at;
}

interface DocumentPlan {
  source: string;
  /** The new text, or the source unchanged when nothing was missing. */
  written: string;
}

interface Counters {
  /** `p<page>-<n>`, per page, held across documents exactly as the emitter does. */
  perPage: Map<string, number>;
  /** `c<document>-<n>`, per document. */
  perDocument: Map<string, number>;
  /** Every `data-bf-id` this book already contains, so nothing minted collides. */
  taken: Set<string>;
  /** Printed pages the book declares, counted once each however often marked. */
  pagesSeen: Set<string>;
}

/**
 * `c<document>-<n>` — the id for a block on a book that has no pagination.
 *
 * Derived from the member's own NAME rather than from its position in the spine,
 * so the id is stable: moving a chapter, or inserting one before it, renames
 * nothing. The `c` prefix is what keeps the two id spaces apart — a page id is
 * `p` and a digit, and no document token can produce that shape.
 *
 * Collisions between two members whose names reduce to the same token are broken
 * by the members' own sorted order, which is a property of the book rather than
 * of the run: `text/ch-1.xhtml` and `text/ch1.xhtml` become `ch1` and `ch1-2`,
 * and they do so identically on every machine.
 */
export function documentTokens(paths: readonly string[]): Map<string, string> {
  const reduce = (p: string): string => {
    const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
    const token = base.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return token.length > 0 ? token : 'doc';
  };
  const groups = new Map<string, string[]>();
  for (const p of [...paths].sort()) {
    const token = reduce(p);
    groups.set(token, [...(groups.get(token) ?? []), p]);
  }
  const out = new Map<string, string>();
  for (const [token, members] of groups) {
    for (const [index, member] of members.entries()) {
      out.set(member, index === 0 ? token : `${token}-${index + 1}`);
    }
  }
  return out;
}

/**
 * Stamp one document, and say what it now says.
 *
 * The three attributes are decided INDEPENDENTLY, and that decomposition is what
 * makes "write only what is missing" mean something precise:
 *
 *  - `data-bf-cat` is written only where there is none AND this pass has a
 *    category to give. An element that already carries one is a block already,
 *    and its value may have been corrected by a person in the inspector.
 *  - `data-bf-id` is written on every element that carries a category once this
 *    pass is done — its own or one it already had — and lacks an id. That is the
 *    whole of the "a cast book that predates ids gets ids and nothing else"
 *    case, and it falls out rather than being a mode.
 *  - `data-bf-page` is written the same way, and only where the book's own
 *    markers state a page.
 */
function planDocument(
  docPath: string,
  source: string,
  token: string,
  counters: Counters,
  report: StampReport,
): DocumentPlan {
  const root = parseXml(source, 'xhtml');
  const body = findElement(root, 'body') ?? root;
  const all = [...elements(body)].filter((el) => el !== body);

  // ── the page markers this document declares ────────────────────────────────
  const markers: PageMarker[] = [];
  for (const el of all) {
    if (!isPagebreak(el)) continue;
    const page = pageOfMarker(source, el);
    if (page === null) continue;
    markers.push({ at: el.start, page });
    counters.pagesSeen.add(page);
  }

  /*
   * THE PAGE IS NEVER CARRIED ACROSS A DOCUMENT, and never back before the
   * first marker in one. A block that no marker precedes is a block this book
   * has said nothing about, and answering "the last page the previous chapter
   * mentioned" would be a page number nobody printed — indistinguishable from
   * the true kind, and wrong exactly where a citation would rest on it.
   */
  const pageAt = (offset: number): string | null => {
    let answer: string | null = null;
    for (const marker of markers) {
      if (marker.at > offset) break;
      answer = marker.page;
    }
    return answer;
  };

  /*
   * NOTHING INSIDE A <nav> IS A BLOCK. A contents page's list is the book's
   * apparatus, not its prose — stamping it would outline the whole table of
   * contents in select mode and hand the translator the chapter titles a second
   * time, competing with `navLabels`, which is what actually relabels them.
   */
  const insideNav = (el: XmlElement): boolean => {
    for (let up: XmlElement | null = el; up !== null; up = up.parent) {
      if (up.tag === 'nav') return true;
    }
    return false;
  };

  // ── layer 1-4: what each element IS ───────────────────────────────────────
  const category = new Map<XmlElement, string>();
  const layer = new Map<XmlElement, StampLayer>();
  const nearestStamped = (el: XmlElement): XmlElement | null => {
    for (let up = el.parent; up !== null; up = up.parent) {
      if (category.has(up)) return up;
    }
    return null;
  };

  for (const el of all) {
    if (insideNav(el)) continue;

    const existing = el.attrs.get(CATEGORY_ATTRIBUTE);
    if (existing !== undefined) {
      report.alreadyStamped += 1;
      category.set(el, existing);
      continue;
    }

    const declared = declaredCategory(el);
    if (declared === false) continue;

    const container = nearestStamped(el);
    if (container !== null) {
      // Inside a block already. Only the emitter's own pairs go on, and only as
      // a DIRECT child: a `<p>` two levels down inside a `<blockquote>` is that
      // quotation's insides.
      if (el.parent !== container) continue;
      const paired = pairedCategory(container, category.get(container)!, el);
      if (paired === null) continue;
      category.set(el, declared ?? paired);
      layer.set(el, declared !== null ? 'declaration' : 'shape');
      continue;
    }

    if (declared !== null) {
      category.set(el, declared);
      layer.set(el, 'declaration');
      continue;
    }

    const shape = shapeCategory(source, el);
    if (shape !== null) {
      /*
       * A SHAPE WITH NOTHING IN IT IS NOT A BLOCK. An empty `<h2>`, a `<li>`
       * used as a spacer, a `<table>` a converter left behind: each would become
       * a box drawn on the page in select mode with nothing inside it to select.
       * `picture` is the one exemption, because an image is exactly the block
       * that has no words.
       */
      if (shape !== 'picture' && !hasWords(source, el)) continue;
      category.set(el, shape);
      layer.set(el, 'shape');
      continue;
    }

    if (PROSE_TAGS.has(el.tag) && !hasStructureInside(el) && hasWords(source, el)) {
      category.set(el, 'text');
      layer.set(el, 'default');
    }
  }

  // ── layer 3: what a heading is, from where it sits ────────────────────────
  /*
   * THE FIRST HEADING IN A SPINE DOCUMENT IS THE CHAPTER OPENER, because that is
   * what a spine document IS: the unit the book divides into, and the unit the
   * app splits on. `chapter` is foundry's own category rather than one of dots'
   * — the picker's "Chapter Openings — the EPUB split points" — and it is the
   * control a person uses to move a division. Later headings are sections inside
   * it.
   *
   * A DOCUMENT WITH NO PROSE AT ALL IS NOT A CHAPTER. A half-title, a part
   * divider, a dedication leaf: nothing on it but headings, and calling the
   * first one a chapter opener would divide the book at a page that has no
   * chapter on it. Those become `title`, which is what they are, and the report
   * names the documents where this fired because it is the one positional
   * decision a reader of the file cannot see for themselves.
   */
  const headings = all.filter((el) => category.get(el) === HEADING);
  if (headings.length > 0) {
    const prose = [...category.values()].some((value) => value === 'text');
    if (!prose) {
      report.titleOnlyDocuments.push(docPath);
      for (const el of headings) category.set(el, 'title');
    } else {
      const alreadyOpened = [...category.values()].some((value) => value === 'chapter');
      for (const [index, el] of headings.entries()) {
        const opener = index === 0 && !alreadyOpened;
        category.set(el, opener ? 'chapter' : 'section-header');
        if (opener) report.chapterOpeners += 1;
      }
    }
    for (const el of headings) layer.set(el, 'position');
  }

  // ── the writes ────────────────────────────────────────────────────────────
  /*
   * An id has to be a NAME, and a page is whatever the book printed.
   *
   * `p<page>-<n>` only works while the page is something an id may be spelled
   * with: the app addresses a block by matching `data-bf-id` against a pattern
   * before it will touch a document (`locateBlock`, app/electron/epub-reader.ts),
   * and a page labelled "A–3" or "Tafel II" would mint an id with a space or a
   * dash-that-is-not-a-dash in it and make that block unaddressable — silently,
   * because the attribute would still be there. Such a block takes a
   * document-scoped id instead and KEEPS its `data-bf-page` exactly as the book
   * wrote it. The provenance is the part that cannot be regenerated.
   */
  const idSafePage = (page: string | null): boolean =>
    page !== null && /^[A-Za-z0-9][A-Za-z0-9_.]*$/.test(page);

  const mint = (rawPage: string | null): string => {
    const page = idSafePage(rawPage) ? rawPage : null;
    for (;;) {
      let candidate: string;
      if (page !== null) {
        const n = counters.perPage.get(page) ?? 1;
        counters.perPage.set(page, n + 1);
        candidate = `p${page}-${n}`;
      } else {
        const n = counters.perDocument.get(token) ?? 1;
        counters.perDocument.set(token, n + 1);
        candidate = `c${token}-${n}`;
      }
      // An id already in the book — a partly-named cast book, or a page number
      // that is not a number and collides with a token. The counter simply moves
      // on: two elements sharing a name is invalid XHTML and unaddressable
      // besides, and it is the one thing this command must never produce.
      if (!counters.taken.has(candidate)) {
        counters.taken.add(candidate);
        return candidate;
      }
    }
  };

  const insertions: Insertion[] = [];
  for (const el of all) {
    const value = category.get(el);
    if (value === undefined) continue;

    const written: string[] = [];
    const isNew = el.attrs.get(CATEGORY_ATTRIBUTE) === undefined;

    const page = el.attrs.get(PAGE_ATTRIBUTE) ?? null;
    if (page !== null) report.alreadyPaged += 1;
    const known = page ?? pageAt(firstContentOffset(source, el));
    if (page === null && known !== null) {
      written.push(` ${PAGE_ATTRIBUTE}="${escapeAttribute(known)}"`);
      report.pagesStamped += 1;
    }

    if (isNew) {
      written.push(` ${CATEGORY_ATTRIBUTE}="${value}"`);
      report.stamped[value] = (report.stamped[value] ?? 0) + 1;
      report.byLayer[layer.get(el) ?? 'default'] += 1;
    }

    if (el.attrs.get(ID_ATTRIBUTE) === undefined) {
      written.push(` ${ID_ATTRIBUTE}="${mint(known)}"`);
      report.idsWritten += 1;
    } else {
      report.alreadyNamed += 1;
    }

    if (written.length === 0) continue;
    const at = attributeInsertPoint(source, el);
    insertions.push({ start: at, end: at, text: written.join('') });
  }

  return { source, written: insertions.length === 0 ? source : spliceAll(source, insertions) };
}

/** An attribute value on its way into a document this program did not write. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═════════════════════════════════════════════════════════════════════════════
// The run
// ═════════════════════════════════════════════════════════════════════════════

export interface StampOptions {
  /** An EPUB file, or the directory one was unpacked into. */
  epubPath: string;
  /** Where the stamped book is written. Required for a file, refused for a directory. */
  outPath?: string | undefined;
  log: (message: string) => void;
}

export async function epubStamp(opts: StampOptions): Promise<StampReport> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(opts.epubPath);
  } catch (error) {
    throw new StampError(
      `${opts.epubPath} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}. `
      + '--epub takes an EPUB file or an unpacked EPUB directory.',
    );
  }

  /*
   * A DIRECTORY IS STAMPED IN PLACE, AND A FILE IS NOT.
   *
   * The directory form is the app's working tree — foundry's own copy of the
   * book, unpacked, the thing every edit already writes to — and mutating it is
   * the entire point: a working copy nothing can address is a book select mode
   * cannot open. The file form is somebody's `.epub`, possibly the only copy of
   * that scan there will ever be, and foundry never writes over an input
   * (ARCHITECTURE §8's sibling rule, stated in `translate` and `epub-final`
   * both). So `--out` is REQUIRED for a file and REFUSED for a directory —
   * refused rather than ignored, because a flag this program drops on the floor
   * is how somebody ends up believing they made a second file and did not.
   */
  const inPlace = stat.isDirectory();
  if (!inPlace && !stat.isFile()) {
    throw new StampError(`${opts.epubPath} is neither a file nor a directory, and --epub takes one of those`);
  }
  if (!inPlace && (opts.outPath === undefined || opts.outPath === '')) {
    throw new StampError(
      `${opts.epubPath} is a file, and --out says where the stamped book is written. foundry never `
      + 'writes over an input: pass --out, or point --epub at an unpacked EPUB directory, which is '
      + 'stamped where it stands.',
    );
  }
  if (inPlace && opts.outPath !== undefined && opts.outPath !== '') {
    throw new StampError(
      `${opts.epubPath} is a directory, so it is stamped in place and --out ${opts.outPath} would `
      + 'not be written. Pass the .epub file if you want a second file; packing a working tree back '
      + 'into an archive is `foundry epub-final`.',
    );
  }

  // The same reader `epub-final` uses, and the same refusals: a directory with
  // no `mimetype`/`META-INF` is not an unpacked EPUB, and a ZIP that will not
  // parse says which entry failed. The question is identical, so the sentence
  // is; only the class differs, so a caller can tell which command raised it.
  let members: ZipMember[];
  try {
    members = readEpubInput(opts.epubPath);
  } catch (error) {
    if (error instanceof FinalError) throw new StampError(error.message);
    throw error;
  }

  // NOT `bookFromMembers`: that refuses a book with no stamps in it, which is
  // every book this command exists for. Every other structural refusal stands.
  const book = containerFromMembers(members);

  const report = emptyReport(inPlace ? opts.epubPath : opts.outPath!, inPlace);
  report.documents = book.documents.length;

  /*
   * The nav document is never stamped, even when the spine carries it — which
   * EPUBs routinely do, so that the contents page is a page a reader can turn
   * to. Its list is the book's apparatus; see `insideNav` for the argument.
   */
  const skip = new Set<string>(book.navPath === null ? [] : [book.navPath]);

  const counters: Counters = {
    perPage: new Map(),
    perDocument: new Map(),
    taken: new Set(),
    pagesSeen: new Set(),
  };
  for (const doc of book.documents) {
    for (const match of doc.source.matchAll(/\bdata-bf-id\s*=\s*"([^"]*)"|\bdata-bf-id\s*=\s*'([^']*)'/g)) {
      counters.taken.add(match[1] ?? match[2] ?? '');
    }
  }

  const tokens = documentTokens(book.documents.map((doc) => doc.path));
  const rewritten = new Map<string, string>();
  for (const doc of book.documents) {
    if (skip.has(doc.path)) continue;
    const plan = planDocument(doc.path, doc.source, tokens.get(doc.path) ?? 'doc', counters, report);
    if (plan.written !== plan.source) rewritten.set(doc.path, plan.written);
  }
  report.documentsWritten = rewritten.size;
  report.pages = counters.pagesSeen.size;

  // ── what lands on disk ────────────────────────────────────────────────────

  if (inPlace) {
    for (const [memberPath, text] of rewritten) {
      fs.writeFileSync(path.join(opts.epubPath, ...memberPath.split('/')), text, 'utf8');
    }
    opts.log(
      `epub-stamp: ${rewritten.size} of ${report.documents} documents rewritten in ${opts.epubPath}`,
    );
    return report;
  }

  /*
   * The file form, written exactly as `epub-final` writes an edition: `mimetype`
   * first and stored so a reader can identify the archive at byte offset 30, and
   * every member nobody edited carried through with the bytes, method and
   * checksum it arrived with. A book whose only stamped document was chapter
   * nine comes out differing from its input in chapter nine and nowhere else —
   * the plates are not re-encoded, so nothing about the file has changed that
   * this command did not change on purpose.
   */
  const ordered = [
    ...members.filter((m) => m.path === 'mimetype'),
    ...members.filter((m) => m.path !== 'mimetype'),
  ];
  const entries: ZipEntry[] = ordered.map((member): ZipEntry => {
    const edited = rewritten.get(member.path);
    if (edited !== undefined) return zipText(member.path, edited);
    return {
      path: member.path,
      data: member.raw,
      method: member.method === 8 ? 8 : 0,
      crc: member.crc,
      uncompressedSize: member.uncompressedSize,
    };
  });
  await Bun.write(opts.outPath!, writeZip(entries));
  opts.log(
    `epub-stamp: ${entries.length} members written, ${rewritten.size} of ${report.documents} `
    + 'documents stamped',
  );
  return report;
}
