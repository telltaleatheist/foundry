/**
 * vlm/epub-explode — AN IMPORTED EPUB, EXPLODED INTO THE BOOK FILE.
 *
 * ── The ruling this file is the whole of ────────────────────────────────────
 *
 * `docs/RENDERER.md` §6 said, from the beginning, that an imported EPUB becomes
 * block rows and that everything downstream is identical by construction. Its
 * refinement paragraph is the part that decides what this file may and may not
 * do: THE UNIFICATION LAYER IS THE BOOK FILE, NOT THE BANK. An EPUB is never
 * read by a vision model into a bank — a bank models pages and an EPUB has none,
 * and re-reading real text through a model would trade exact data for a guess at
 * it. The publisher's data is RETAINED, not rediscovered. The EPUB itself is the
 * receipt: archived immutable, `book = f(epub)`, regenerable like any reflow.
 *
 * So this is `f`. It is the sibling of `book-run.ts` — that one is `f(bank)` and
 * this one is `f(epub)` — and the two produce the same value, `BookFile`, which
 * goes out through the same `formatBookFile`. There is one writer of the format
 * and there are two ways to make a book, which is exactly the shape the contract
 * describes.
 *
 * ── WHAT `f` KEEPS, AND WHERE EACH OF IT COMES FROM ─────────────────────────
 *
 * THE SPINE IS THE ORDER. `container.xml` names the package, the package's spine
 * says which documents are the book and in what order, and document order inside
 * each of them is the rest of it. That order is total and is the publisher's own,
 * so it is what the ids are minted from: `e-<n>`, counted from 1 across the whole
 * book (docs/BOOK-FILE.md §4). It does not move when this explode improves, which
 * is the only property an id has to have.
 *
 * THE MARKUP IS THE CATEGORY. `h1` is a Title because the publisher set it as
 * one; `blockquote` is a Quote, `figcaption` a Caption, `li` a List-item, `table`
 * a Table, `img` a Picture, and anything carrying `epub:type="footnote"` is a
 * Footnote. There is no classifier here and there must not be one: the whole
 * point of the ruling above is that a book which already says what its parts are
 * does not get asked again. An element this table has no rule for becomes a Text
 * row AND A LOG LINE, which is this codebase's standing answer to an ambiguity —
 * never a silent guess and never a dropped paragraph.
 *
 * THE PUBLISHER'S NOTEREFS MINT THE REFS EXACTLY. The bank route has to MATCH a
 * printed number to a note, because a scan carries no link and printed numbering
 * restarts wherever the printer felt like restarting it. An EPUB carries the link
 * itself — `<a epub:type="noteref" href="#fn12">` — so the correspondence is read
 * rather than inferred, and a well-made EPUB produces no loose markers at all.
 *
 * THE NAV IS THE CHAPTERS. The publisher's own table of contents, entry by entry,
 * label verbatim, resolved to the row its href lands on. `detectChapters` never
 * runs: proposing divisions for a book that has published its own would be the
 * program overruling the source it is here to retain.
 *
 * ── THE NO-PAGE FRAME, WHICH IS THE ONE THING THAT LOOKS LIKE A COMPROMISE ──
 *
 * Every row is `page: 0`, `pages: [0]`, a zero box and a zero page size, and
 * `typography` is null for the whole book. That is not a hole where a measurement
 * should be — it is the format's own rule read straight. `page` is an estimate
 * and NOTHING is addressed by it (`book-file.ts`'s header), so a book with no
 * pages writes the number that is not a page; the box exists to be measured for
 * type size and column width, and there is nothing to measure, so the report is
 * null and the base sheet's own type rules stand, which is the documented silence
 * rather than a guess dressed as a measurement. No facsimile is ever made, for
 * the same reason: nothing page-shaped exists to draw one of.
 *
 * ── SANITIZING IS STRUCTURAL, AND IT HAPPENS BEFORE ANYTHING IS READ ────────
 *
 * `click-reporter.ts` strips script/iframe/object/embed, every `on*` handler and
 * every `javascript:` URL out of a chapter on its way to an iframe, because that
 * chapter was about to be EXECUTED by a browser. Nothing here is executed by
 * anything — a book file carries text and source-level markers — so the danger is
 * different and smaller and still real: a `<script>`'s content is code, and a
 * walk that extracted text from it would put a line of JavaScript in the middle
 * of somebody's chapter as a paragraph. So the same elements are dropped WITH
 * their content at the walk, `<style>` with them (its content is CSS, which is
 * the same failure spelled differently), and the count of what was met is
 * reported per document rather than swallowed. Handler attributes and
 * `javascript:` URLs need no rule at all: this reads five attributes by name and
 * writes markup for nothing, so there is nowhere for one to survive.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import { decodeEntities, findElements, parseXml, type XmlElement, type XmlNode } from '../epub/xml.js';
import { containerFromMembers, resolveHref } from '../translate/book.js';
import { readZip, type ZipMember } from '../translate/unzip.js';
import { VERSION } from '../version.js';
import {
  figureMediaType,
  formatBookFile,
  type BookChapter,
  type BookFile,
  type BookLooseMarker,
  type BookRow,
} from './book-file.js';
import { checkTableHtml, SUPERSCRIPT_RUN, type DotsCategory } from './dots.js';

/** An EPUB this command will not explode. Always says what about it stopped it. */
export class EpubExplodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubExplodeError';
  }
}

export interface EpubExplodeOptions {
  epubPath: string;
  outPath: string;
  /**
   * `--language`, which OVERRIDES the package's `dc:language`.
   *
   * The publisher's declaration is the better answer and is the default for that
   * reason — it is a fact the book states about itself, where the bank route's
   * language is a fact the person running the read states about a scan. The
   * override exists because a package can be wrong and nothing else in the
   * program could then fix it.
   */
  language?: string;
  log: (line: string) => void;
}

export interface EpubExplodeReport {
  rows: BookRow[];
  /** Spine documents walked. This is `source.pages` — see `bookFromEpub`. */
  documents: number;
  chapters: number;
  /** The figures copied out of the container, by the name a row calls them. */
  images: string[];
  /** Reference markers minted off the publisher's own noteref anchors. */
  refs: number;
  /** The language written into the header, and where it came from. */
  language: string;
  languageFrom: 'package' | 'command line';
}

// ─────────────────────────────────────────────────────────────────────────────
// the element tables — the whole of this file's opinion about markup
// ─────────────────────────────────────────────────────────────────────────────

/** Dropped WITH their content at the walk. See the header on sanitizing. */
const DROPPED: ReadonlySet<string> = new Set(['script', 'style', 'iframe', 'object', 'embed']);

/**
 * Descended into and never rows of their own — a grouping is not a block.
 *
 * A `<div>` is in here and is ALSO a Text row when it holds nothing but inline
 * content, which is not a contradiction: a div wrapping three paragraphs is a
 * grouping, and a div holding one sentence is a paragraph somebody wrote without
 * a `<p>`. The test is what is inside it, which is a fact rather than a guess.
 */
const CONTAINERS: ReadonlySet<string> = new Set([
  'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav',
  'hgroup', 'center', 'details', 'noscript', 'dl',
]);

/** A heading is a division; `h1` opens the book's, the rest open sections. */
const HEADINGS: ReadonlyMap<string, DotsCategory> = new Map<string, DotsCategory>([
  ['h1', 'Title'], ['h2', 'Section-header'], ['h3', 'Section-header'],
  ['h4', 'Section-header'], ['h5', 'Section-header'], ['h6', 'Section-header'],
]);

/**
 * Inline emphasis, folded to the source markers the model itself writes.
 *
 * `dotsInline` is the one renderer of a row's text and its grammar is `**bold**`
 * and `*italic*` (src/vlm/dots.ts). So an `<em>` folds to `*…*` and a `<strong>`
 * to `**…**` — not because markdown is a good way to carry emphasis, but because
 * a book file has exactly one dialect and a row that spelled its emphasis some
 * other way would render as literal punctuation in every export. `i`/`b` are the
 * presentational spellings of the same two and fold identically; `cite`, `var`
 * and `dfn` are italic by every stylesheet ever written for them.
 */
const EMPHASIS: ReadonlyMap<string, string> = new Map(Object.entries({
  em: '*', i: '*', cite: '*', var: '*', dfn: '*',
  strong: '**', b: '**',
}));

/** The superscript digits `dotsInline` reads as a reference marker. */
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/**
 * `epub:type` tokens that say "this element is a note".
 *
 * EPUB 3's own vocabulary, and it is the publisher DECLARING the thing rather
 * than this program recognising it — which is the difference the ruling turns on.
 * The attribute is read wherever it appears and not only on an `<aside>`: the
 * ruling names the aside because that is where publishers put a note, and the
 * declaration is the attribute, not the tag it happens to sit on.
 */
const NOTE_TYPES: ReadonlySet<string> = new Set(['footnote', 'endnote', 'rearnote', 'note']);

/**
 * The class names an `<aside>` may carry INSTEAD of a declaration — and the only
 * inference in this file.
 *
 * Read only when `epub:type` is absent, and only on an `<aside>`, which is
 * already the element for "set apart from the main flow": an aside called
 * `footnote` is not a thing two readings can be had of. Everything else that
 * might be a note by some publisher's private convention — a `<p class="fn">`, a
 * `<div class="note">` — becomes a Text row and a log line, because there is no
 * rule that reads those the same way twice and a wrong Footnote is a paragraph
 * moved to the end of a chapter.
 */
const NOTE_CLASSES: ReadonlySet<string> = new Set(['footnote', 'footnotes', 'fn', 'note', 'endnote']);

// ─────────────────────────────────────────────────────────────────────────────
// the walk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A noteref met mid-fold, measured against the string the fold is building.
 *
 * `printed` is the number the anchor SHOWS a reader, in either alphabet, and it
 * is null where the anchor shows anything else. EPUB 3 does not need it — the
 * `epub:type` said what the anchor was — and EPUB 2 is nothing but it; see the
 * `case 'a'` branch of the fold and the resolution loop, which are the two ends
 * of the one piece of evidence.
 */
interface FoundRef {
  /** `<document path>#<fragment>` — the note it names, in the container. */
  target: string;
  at: number;
  len: number;
  printed: number | null;
}

/** One noteref anchor, as it stood in the prose. */
interface Noteref extends FoundRef {
  /** The row whose text carries the anchor's own words. */
  block: string;
}

/** Everything the walk accumulates across the whole book. */
interface Explosion {
  rows: BookRow[];
  /** The next ordinal — see the header on why an id is an order and not a page. */
  ordinal: number;
  /** `<document path>#<id>` → the row that element's words ended up in. */
  anchors: Map<string, string>;
  /** The first row of each spine document, for a nav entry with no fragment. */
  opens: Map<string, string>;
  noterefs: Noteref[];
  /** Every Picture row's href in the container, resolved, in mint order. */
  figures: { href: string; row: BookRow }[];
  /** What the sanitize met, by tag, across the book. */
  dropped: Map<string, number>;
  /** Element names that had no rule and became Text, by tag. */
  loose: Map<string, number>;
  /** Inline `<img>` met inside a block, which a row has nowhere to put. */
  inlineImages: number;
}

/** The document being walked, and where its ids live. */
interface DocumentWalk {
  source: string;
  /** Path of this document inside the container, for anchor keys and refusals. */
  docPath: string;
  /** Its directory, for resolving an href written relative to it. */
  dir: string;
  /** Container ids descended past and not yet bound to a row. */
  pending: string[];
  /** The category a row takes from the element it is nested inside, or null. */
  inherited: DotsCategory | null;
}

/** `epub:type`'s tokens, lower-cased. Empty where the attribute is absent. */
function epubTypes(el: XmlElement): string[] {
  const said = el.attrs.get('epub:type');
  return said === undefined ? [] : said.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

function classes(el: XmlElement): string[] {
  const said = el.attrs.get('class');
  return said === undefined ? [] : said.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** Is this element the publisher's own declaration of a note? */
function isNote(el: XmlElement): boolean {
  const types = epubTypes(el);
  if (types.length > 0) return types.some((type) => NOTE_TYPES.has(type));
  return el.tag === 'aside' && classes(el).some((name) => NOTE_CLASSES.has(name));
}

/**
 * The number this text PRINTS, in either alphabet, or null if it prints none.
 *
 * Both alphabets, because the fold has already turned a `<sup>` of digits into
 * the dialect's superscript run by the time an enclosing anchor sees it, and an
 * anchor around a `<sup>` and a `<sup>` around an anchor are the same markup to
 * a reader. The superscript half reads through `SUPERSCRIPT_DIGITS` rather than
 * a second character class written out, so the one alphabet cannot drift.
 */
function printedNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed);
  const digits = [...trimmed].map((char) => SUPERSCRIPT_DIGITS.indexOf(char));
  if (digits.some((digit) => digit < 0)) return null;
  return Number(digits.join(''));
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

/**
 * Elements that are a block in their own right — one row, or a descent into
 * several. Everything NOT in here and not in `CONTAINERS` is inline by default,
 * which is the right default: the inline vocabulary is open-ended and every
 * member of it means "these words, marked somehow", so an element nobody has
 * heard of contributes its words and no structure.
 */
const BLOCKS: ReadonlySet<string> = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'blockquote', 'figure', 'figcaption', 'table', 'ul', 'ol', 'li',
  'aside', 'pre', 'dt', 'dd', 'hr', 'img', 'svg',
]);

/** Does this element hold anything that is a block in its own right? */
function hasBlockChildren(el: XmlElement): boolean {
  return el.children.some(
    (child) => child.kind === 'element'
      && !DROPPED.has(child.tag)
      && (BLOCKS.has(child.tag) || CONTAINERS.has(child.tag)),
  );
}

/** Is this child a thing the walk must stop the inline run for? */
function isBlockish(child: XmlElement): boolean {
  return BLOCKS.has(child.tag) || CONTAINERS.has(child.tag) || hasBlockChildren(child);
}

/**
 * The first character the prose of this node list begins with, or `''`.
 *
 * Needed for exactly one decision and it is worth the walk: `dotsInline` renders
 * `*italic*` only where the run is not welded to a word (`(?<![*\w])` before and
 * `(?!\w)` after), so an `<em>` inside a word — `pre<em>fix</em>ed` — folded to
 * markers would render as literal asterisks in every export. Knowing the
 * character that follows is what lets the fold write the plain words instead.
 */
function firstCharAfter(children: readonly XmlNode[], from: number, source: string): string {
  for (let i = from; i < children.length; i += 1) {
    const node = children[i]!;
    if (node.kind === 'text') {
      /*
       * THE WHITESPACE IS THE ANSWER AS OFTEN AS THE LETTER IS. What follows the
       * run in the FOLDED text is what the dialect's `(?!\w)` will look at, and
       * the fold collapses a pretty-printer's newline and eight spaces of indent
       * into one space — so a node of nothing but whitespace answers "a space",
       * which is safe, and stripping it first would answer with the first letter
       * of the next word and refuse the markers on every emphasis in a
       * pretty-printed book. (It did exactly that until this line was fixed.)
       */
      const text = decodeEntities(source.slice(node.start, node.end)).replace(/\s+/g, ' ');
      if (text.length > 0) return text[0]!;
      continue;
    }
    if (node.kind === 'other') continue;
    if (DROPPED.has(node.tag)) continue;
    const found = firstCharAfter(node.children, 0, source);
    if (found.length > 0) return found;
  }
  return '';
}

/**
 * One block element's words, with the markup folded into the dialect's markers.
 *
 * ── WHITESPACE IS COLLAPSED, AND A `<br/>` IS THE ONE THAT IS NOT ───────────
 *
 * XHTML in a book is pretty-printed: a paragraph arrives with a newline and eight
 * spaces of indent after every sentence, and those are not in the book — they are
 * in the file. A row's text carrying them would render as `<br/>` at every one of
 * them (`dotsInline`'s last rule: a newline that reached it is a break the page
 * had), which is a paragraph shattered into lines. So runs of whitespace collapse
 * to one space, exactly as every rendering of HTML has done since HTML, and the
 * one break that survives is the one the publisher WROTE — `<br/>`, which becomes
 * the newline `dotsInline` turns back into a break. `<pre>` is the documented
 * exception and keeps what it was given.
 *
 * The noterefs found on the way are pushed into `found` with their offsets into
 * the text this returns, which is why the fold is where they are collected: after
 * it, the anchor is characters in a string and there is nothing left to find.
 *
 * `pictures` is the same arrangement for the `<img>`/`<svg>` met inside the run.
 * The fold cannot decide what they are — a picture inside a sentence has nowhere
 * to go in this format, and a picture that is the block's ENTIRE content is the
 * block — and it cannot know which it is looking at until the whole fold is done
 * and the text is either words or nothing. So it collects and the caller rules.
 */
function foldInline(
  nodes: readonly XmlNode[],
  walk: DocumentWalk,
  book: Explosion,
  found: FoundRef[],
  pictures: XmlElement[],
  keepSpace: boolean,
): string {
  let out = '';
  /*
   * ── EVERY OFFSET IS REBASED ON THE WAY BACK UP, WHICH IS THE WHOLE TRICK ───
   *
   * A nested fold measures what it found against its OWN string, starting at
   * zero, because that is the only thing it can see. The caller knows where that
   * string landed, so it adds the base — and adds `shift` too, which is how far
   * the inner text moved inside what was actually emitted (a trimmed superscript
   * moves back, an emphasis marker moves it forward). Every level does this
   * exactly once as the stack unwinds, so a noteref inside a `<sup>` inside an
   * `<em>` comes out pointing at the characters it actually occupies. Refs are
   * character coordinates into somebody's text, and one that is off by the width
   * of an asterisk names the wrong words.
   */
  const nested = (
    child: XmlElement,
    emit: (inner: string) => { text: string; shift: number },
  ): string => {
    const from = found.length;
    const base = out.length;
    const inner = foldInline(child.children, walk, book, found, pictures, keepSpace);
    const made = emit(inner);
    for (let i = from; i < found.length; i += 1) found[i]!.at += base + made.shift;
    return made.text;
  };
  /** How much whitespace a trim takes off the front — the shift a trim causes. */
  const lead = (text: string): number => text.length - text.replace(/^\s+/, '').length;

  for (const [index, child] of nodes.entries()) {
    if (child.kind === 'other') continue;
    if (child.kind === 'text') {
      const raw = decodeEntities(walk.source.slice(child.start, child.end));
      out += keepSpace ? raw : raw.replace(/\s+/g, ' ');
      continue;
    }
    if (DROPPED.has(child.tag)) {
      book.dropped.set(child.tag, (book.dropped.get(child.tag) ?? 0) + 1);
      continue;
    }
    if (child.tag === 'br') { out += '\n'; continue; }
    if (child.tag === 'img' || child.tag === 'svg') {
      // Kept for the caller, which is the only place that can tell a picture
      // inside a paragraph from a paragraph that IS a picture. See `pictures`
      // above and `whole()` below.
      pictures.push(child);
      continue;
    }
    if (child.tag === 'sup') {
      // A superscript of DIGITS is a reference marker and becomes the dialect's
      // own alphabet for one, which is what makes it linkable downstream — and
      // the mapping is one character for one, so nothing inside it moves but the
      // trim. A superscript of anything else — `1ˢᵗ`, a dagger, an author's
      // sigil — is ordinary words set high, and it keeps its words.
      out += nested(child, (inner) => {
        const trimmed = inner.trim();
        const text = /^[0-9]+$/.test(trimmed)
          ? [...trimmed].map((digit) => SUPERSCRIPT_DIGITS[Number(digit)]!).join('')
          : trimmed;
        return { text, shift: -lead(inner) };
      });
      continue;
    }
    if (child.tag === 'a') {
      const at = out.length;
      const text = nested(child, (inner) => ({ text: inner, shift: 0 }));
      out += text;
      const href = child.attrs.get('href');
      /*
       * The publisher's own link between a number and its note. Recorded by
       * TARGET here and resolved to a row after the whole book is walked, because
       * an endnote lives in a document the spine has not reached yet. Pushed
       * AFTER the fold, so the rebase above cannot move the anchor's own claim.
       *
       * ── AND THE SAME DECLARATION IN THE OLDER SPELLING ─────────────────────
       *
       * `epub:type="noteref"` is EPUB 3's word for this and EPUB 2 has no such
       * word — it has no `epub:type` at all. What it has is the link itself, and
       * an anchor whose WHOLE TEXT is a number, aimed at a fragment, is the same
       * statement made with the only vocabulary that spec had. So a printed
       * number is recorded as a candidate too, with the number it printed, and
       * the resolution loop is where it either finds its answer or does not.
       *
       * THE BACK-LINK IS THE HAZARD AND IT IS ALREADY CLOSED. A note's own return
       * anchor is `<a href="#fn_1">1.</a>` and points back INTO the prose; the
       * period keeps it out of this test and it stays prose, as it should. One
       * spelled with bare digits would be recorded here and would then resolve to
       * an ordinary paragraph that does not open with its number, and the loop
       * would refuse it — no side's evidence converts anything alone.
       */
      if (href !== undefined && text.length > 0) {
        const printed = printedNumber(text);
        if (printed !== null || epubTypes(child).includes('noteref')) {
          const hash = href.indexOf('#');
          if (hash >= 0) {
            const document = hash === 0 ? walk.docPath : resolveHref(walk.dir, href);
            found.push({ target: `${document}#${href.slice(hash + 1)}`, at, len: text.length, printed });
          }
        }
      }
      continue;
    }
    const mark = EMPHASIS.get(child.tag);
    if (mark !== undefined) {
      const after = firstCharAfter(nodes, index + 1, walk.source);
      const before = out.slice(-1);
      out += nested(child, (inner) => {
        const trimmed = inner.trim();
        /*
         * MARKED ONLY WHERE THE DIALECT WOULD READ IT BACK. `**` has no boundary
         * rule and always survives; `*` is refused a weld to a word character on
         * either side, and neither survives an asterisk already inside the run
         * (the pairing is non-greedy and would close early). Where the fold
         * cannot be read back, the WORDS are kept and the emphasis is not — a row
         * rendering as `pre*fix*ed` would put punctuation in somebody's book that
         * the publisher never set.
         */
        const safe = trimmed.length > 0
          && !trimmed.includes('*')
          && (mark === '**' || (!/[\w*]/.test(before) && !/\w/.test(after)));
        return safe
          ? { text: `${mark}${trimmed}${mark}`, shift: mark.length - lead(inner) }
          : { text: inner, shift: 0 };
      });
      continue;
    }
    // Every other inline element — span, small, q, code, u, abbr, ruby, sub —
    // carries its words and nothing this format models. The words come through.
    out += nested(child, (inner) => ({ text: inner, shift: 0 }));
  }
  return out;
}

/**
 * The finished text of a block: folded, collapsed, trimmed at both ends.
 *
 * The tidy runs ONCE, here, over the whole block — collapsing repeated spaces the
 * fold's per-node collapse left touching, and taking the spaces off either side
 * of a publisher's own `<br/>`. It can only shorten runs of whitespace, so the
 * one offset correction anything found needs is the leading trim, which is
 * measured and applied to all of them.
 */
function blockText(
  children: readonly XmlNode[],
  walk: DocumentWalk,
  book: Explosion,
  found: FoundRef[],
  pictures: XmlElement[],
  keepSpace = false,
): string {
  const raw = foldInline(children, walk, book, found, pictures, keepSpace);
  if (keepSpace) return raw.replace(/^\n+|\s+$/g, '');
  const start = raw.length - raw.replace(/^\s+/, '').length;
  for (const ref of found) ref.at -= start;
  return raw.trim();
}

/**
 * Mint one row.
 *
 * THE ORDINAL IS TAKEN HERE AND NOWHERE ELSE, so that "the nth block of this
 * book" is a fact about the order rows were made in rather than a number two
 * places agree to keep in step. Every field but the words is the no-page frame,
 * which is this file's header and §3 of the contract.
 */
function mint(book: Explosion, category: DotsCategory, text: string): BookRow {
  const id = `e-${book.ordinal}`;
  book.ordinal += 1;
  const row: BookRow = {
    id,
    category,
    text,
    page: 0,
    pages: [0],
    box: { x1: 0, y1: 0, x2: 0, y2: 0 },
    pageWidth: 0,
    pageHeight: 0,
    // `src` is the coordinate the row was minted at, which for an EPUB is its
    // place in the spine order and not a `page:order` in a bank. One part,
    // always: nothing here was ever broken across anything to be joined.
    parts: [{ src: `e:${id.slice(2)}`, page: 0, chars: [0, text.length] }],
  };
  book.rows.push(row);
  return row;
}

/**
 * Bind every id these nodes carry to the row their words went into.
 *
 * ── WHY THE WHOLE SUBTREE AND NOT JUST THE ELEMENT ──────────────────────────
 *
 * A link into a book lands on an id, and the id a publisher hangs a note or a
 * chapter on is as often on a `<span>` inside a paragraph as on the paragraph.
 * The smallest thing this format can point at is a ROW, so every id inside the
 * nodes that made one names that row — which is the honest answer to "where does
 * this link go" and the only one the sheet can act on.
 *
 * `pending` is the other direction: ids on the groupings the walk descended past
 * without minting anything, which belong to the next row to come out, because
 * that is the first thing on the page after the anchor.
 */
function bindAnchors(
  nodes: readonly XmlNode[],
  walk: DocumentWalk,
  book: Explosion,
  row: BookRow,
): void {
  for (const id of walk.pending) book.anchors.set(`${walk.docPath}#${id}`, row.id);
  walk.pending.length = 0;
  const claim = (node: XmlNode): void => {
    if (node.kind !== 'element') return;
    const id = node.attrs.get('id');
    if (id !== undefined && id.length > 0) {
      const key = `${walk.docPath}#${id}`;
      // FIRST CLAIM WINS. Two elements of one id is invalid XHTML; the row that
      // came first in reading order is the one a link would have landed on.
      if (!book.anchors.has(key)) book.anchors.set(key, row.id);
    }
    for (const child of node.children) claim(child);
  };
  for (const node of nodes) claim(node);
  if (!book.opens.has(walk.docPath)) book.opens.set(walk.docPath, row.id);
}

/** Record a block's noterefs against the row they ended up inside. */
function keepRefs(
  found: readonly FoundRef[],
  row: BookRow,
  book: Explosion,
): void {
  for (const ref of found) {
    if (ref.at < 0 || ref.at + ref.len > row.text.length) continue;
    book.noterefs.push({
      target: ref.target, block: row.id, at: ref.at, len: ref.len, printed: ref.printed,
    });
  }
}

/**
 * One `<img>` or `<svg>`, as a Picture row — or as nothing, said out loud.
 *
 * WRITTEN ONCE BECAUSE IT IS READ FROM TWO PLACES. A picture standing as a block
 * of its own and a picture that is the entire content of a `<p>` are the same
 * picture, and the day one of them learns something about `srcset` or about an
 * `<svg>` of two `<image>` elements, the other must not be sitting a hundred
 * lines away spelling the old rule. The row is minted through the caller's own
 * `row`, so the anchors and the refs of whatever element the walk is standing on
 * are bound exactly as they would have been.
 */
function mintPicture(
  el: XmlElement,
  walk: DocumentWalk,
  book: Explosion,
  row: (category: DotsCategory, text: string) => BookRow,
): boolean {
  if (el.tag === 'img') {
    const src = el.attrs.get('src');
    if (src === undefined || src.length === 0) return false;
    const made = row('Picture', (el.attrs.get('alt') ?? '').replace(/\s+/g, ' ').trim());
    book.figures.push({ href: resolveHref(walk.dir, src), row: made });
    return true;
  }
  /*
   * An `<svg>` wrapping one `<image>` is how nearly every EPUB sets its cover,
   * and the picture is the file that image names. An SVG that draws anything
   * ELSE is a drawing this format has no row for — there is no file to point at
   * — so it is counted and named rather than flattened into whatever text
   * happens to be inside it.
   */
  const images = findElements(el, 'image');
  const href = images.length === 1
    ? (images[0]!.attrs.get('xlink:href') ?? images[0]!.attrs.get('href'))
    : undefined;
  if (href === undefined || href.length === 0) {
    book.loose.set('svg', (book.loose.get('svg') ?? 0) + 1);
    return false;
  }
  const made = row('Picture', '');
  book.figures.push({ href: resolveHref(walk.dir, href), row: made });
  return true;
}

/**
 * One element of a spine document, as rows.
 *
 * ── THE TABLE IS THE ONE THING CARRIED AS MARKUP ────────────────────────────
 *
 * A Table row's text IS HTML by the format's own contract — that is how the bank
 * route carries one and how `vlm-compile` writes it — so the publisher's table
 * comes across as the source it was written as, checked well-formed and with the
 * executable elements taken out of it. Folding a table into prose would turn a
 * grid into a run-on sentence, and rebuilding one from a parse would reserialise
 * somebody's markup for no reason (src/epub/xml.ts's whole argument).
 */
function explodeElement(el: XmlElement, walk: DocumentWalk, book: Explosion): void {
  if (DROPPED.has(el.tag)) {
    book.dropped.set(el.tag, (book.dropped.get(el.tag) ?? 0) + 1);
    return;
  }

  const found: FoundRef[] = [];
  const row = (category: DotsCategory, text: string): BookRow => {
    const made = mint(book, category, text);
    bindAnchors([el], walk, book, made);
    keepRefs(found, made, book);
    return made;
  };
  /*
   * ── A BLOCK THAT HOLDS NOTHING BUT A PICTURE IS THE PICTURE ────────────────
   *
   * EPUB 3 sets a plate as `<img>` or `<svg>` standing on its own, which the
   * table below has a case for. EPUB 2 sets the identical plate as
   * `<p class="full-img"><img src="cover.jpg"/></p>`, because that spec's authors
   * were writing XHTML 1.1 and a `<p>` is where you put content in XHTML 1.1.
   * The wrapper is the stylesheet's business and not the book's: a paragraph
   * whose entire text is EMPTY and whose entire content is an image holds no
   * prose to lose and one picture to keep, so it mints the picture. That is not
   * a guess about what the publisher meant — it is a reading of what is there.
   *
   * The old rule stands wherever there are words: a picture beside prose has
   * nowhere in the format to go, because a row's `image` names ONE figure and
   * that row is the prose. Those are still counted and still said out loud.
   */
  const whole = (category: DotsCategory, keepSpace = false): void => {
    const pictures: XmlElement[] = [];
    const text = blockText(el.children, walk, book, found, pictures, keepSpace);
    if (text.length > 0) {
      row(category, text);
      book.inlineImages += pictures.length;
      return;
    }
    let minted = false;
    for (const picture of pictures) minted = mintPicture(picture, walk, book, row) || minted;
    if (!minted) claimLater(el, walk);
  };

  // A NOTE IS ONE ROW WHATEVER IT IS MADE OF. Its `refs` name it and a person
  // strikes it whole, so a note set as two paragraphs is one row with the breaks
  // the publisher wrote between them — not two rows, one of which the reference
  // number would point at and the other of which would be an orphan.
  if (isNote(el)) {
    const pictures: XmlElement[] = [];
    const text = blockText(el.children, walk, book, found, pictures);
    book.inlineImages += pictures.length;
    const made = row('Footnote', text);
    made.refs = [];
    return;
  }

  const heading = HEADINGS.get(el.tag);
  if (heading !== undefined) { whole(heading); return; }

  switch (el.tag) {
    case 'p': {
      /*
       * ── A CLASS THAT SPELLS A HEADING TAG IS A DECLARED HEADING ────────────
       *
       * `<p class="h1">NOTES</p>` is not a paragraph a classifier has to squint
       * at. The publisher NAMED the element after the tag it stands in for —
       * that is what "h1" means and there is no other thing it could mean — and
       * a house that sets its headings this way (every EPUB 2 built from a print
       * stylesheet does) has stated the structure as plainly as `<h1>` states it,
       * in the only vocabulary its CSS gave it. Reading the class literally is
       * retaining the publisher's data, which is this file's whole rule; refusing
       * to would throw away a declaration because of where it was written.
       *
       * SECTION-HEADER AND NOT TITLE, whatever digit the class carries. `h1` maps
       * to Title in `HEADINGS` because a real `<h1>` is rare and load-bearing; a
       * `class="h1"` is a type size, and books like this one use it for the head
       * over every subsection. What says which heads open divisions is the nav,
       * and the pass below reads it — so this rule states the kind and lets that
       * one state the rank.
       */
      const declared = classes(el).some((name) => /^h[1-6]$/.test(name));
      whole(declared ? 'Section-header' : walk.inherited ?? 'Text');
      return;
    }
    case 'dt': case 'dd': whole(walk.inherited ?? 'Text'); return;
    case 'pre': whole(walk.inherited ?? 'Text', true); return;
    case 'figcaption': whole('Caption'); return;
    // A quotation of several paragraphs is several Quote rows, because each of
    // them is a paragraph somebody may strike; a quotation of one sentence is one
    // row, which is what the descent's own inline run makes of it.
    case 'blockquote': descendInto(el, walk, book, 'Quote'); return;
    // An item's own words are one row and a list nested inside it is descended
    // into after them, so a sub-item is a row of its own and not a sentence glued
    // onto its parent. The descent does both in document order.
    case 'li': descendInto(el, walk, book, 'List-item'); return;
    case 'ul': case 'ol': case 'figure': case 'aside':
      descendInto(el, walk, book, walk.inherited);
      return;
    case 'table':
      row('Table', checkTableHtml(stripUnsafeMarkup(walk.source.slice(el.start, el.end)), 0));
      return;
    case 'img': case 'svg':
      mintPicture(el, walk, book, row);
      return;
    case 'hr':
      // Typography and not text. The format has no row for a rule, no words are
      // lost, and a Text row holding nothing would be a blank block on the sheet.
      return;
    default: break;
  }

  /*
   * AN ELEMENT WITH NO RULE, and there are two honest answers depending on what
   * is inside it. Holding blocks, it is a grouping and is descended into — and
   * the tag is counted for the log, because a grouping this table has never heard
   * of is the sort of thing that earns a line in it. Holding words, it is inline
   * by the default `BLOCKS` states, and the descent's own inline run turns those
   * words into a Text row: never a dropped paragraph, which is the only answer to
   * an ambiguity this codebase accepts.
   */
  if (!CONTAINERS.has(el.tag) && hasBlockChildren(el)) {
    book.loose.set(el.tag, (book.loose.get(el.tag) ?? 0) + 1);
  }
  descendInto(el, walk, book, walk.inherited);
}

/** An id on an element that produced no row goes to whatever row comes next. */
function claimLater(el: XmlElement, walk: DocumentWalk): void {
  const id = el.attrs.get('id');
  if (id !== undefined && id.length > 0) walk.pending.push(id);
}

/**
 * The children of a grouping, in document order — blocks exploded, and every run
 * of inline content between them made a row of its own.
 *
 * ── WHY THE INLINE RUNS ARE COLLECTED RATHER THAN SKIPPED ───────────────────
 *
 * The obvious descent walks the element children and ignores everything else,
 * and it silently deletes prose: `<div>Some words<p>a paragraph</p></div>` is
 * markup real books contain, and the words before the paragraph are as much the
 * book as the paragraph is. So the walk keeps a buffer of the inline nodes it
 * passes and flushes it into a row whenever a block interrupts or the element
 * ends. A grouping that holds nothing BUT inline content — the `<div>` somebody
 * wrote a sentence in without a `<p>` — falls out of the same rule as one row,
 * with no special case for it.
 */
function descendInto(
  el: XmlElement,
  walk: DocumentWalk,
  book: Explosion,
  inherited: DotsCategory | null,
): void {
  claimLater(el, walk);
  const was = walk.inherited;
  walk.inherited = inherited;
  let run: XmlNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const carried = run;
    run = [];
    const found: FoundRef[] = [];
    // A picture in a loose run of inline content sits beside the words of that
    // run, so it is the counted case and not the minted one — `whole()` above is
    // the only place a block turns out to BE its picture.
    const pictures: XmlElement[] = [];
    const text = blockText(carried, walk, book, found, pictures);
    book.inlineImages += pictures.length;
    if (text.length === 0) return;
    const made = mint(book, inherited ?? 'Text', text);
    bindAnchors(carried, walk, book, made);
    keepRefs(found, made, book);
  };
  for (const child of el.children) {
    if (child.kind === 'other') continue;
    if (child.kind === 'element' && !DROPPED.has(child.tag) && isBlockish(child)) {
      flush();
      explodeElement(child, walk, book);
      continue;
    }
    run.push(child);
  }
  flush();
  walk.inherited = was;
}

/**
 * The executable markup out of a fragment carried across as source.
 *
 * ONE CALLER — the table, which is the only thing here that travels as markup
 * rather than as folded words. Everything else in this file is sanitized
 * structurally, by not being read (see the module header); a table is sliced out
 * of the document whole, so the slice gets the same treatment
 * `click-reporter.ts` gave a chapter on its way to an iframe, in the engine,
 * where the explode is. That surface dies with wave R6b and this does not.
 */
export function stripUnsafeMarkup(markup: string): string {
  return markup
    .replace(/<(script|iframe|object|embed|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:script|iframe|object|embed|style)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href|action|formaction|data)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// the package, the nav and the whole run
// ─────────────────────────────────────────────────────────────────────────────

/** The publisher's declared language, or null where the package declares none. */
function packageLanguage(opfSource: string): string | null {
  for (const el of findElements(parseXml(opfSource, 'xml'), 'language')) {
    const said = decodeEntities(opfSource.slice(el.innerStart, el.innerEnd)).trim();
    if (said.length > 0) return said;
  }
  return null;
}

/** One entry of the publisher's contents: the href, its label, how deep it nests. */
interface NavEntry {
  href: string;
  title: string;
  /**
   * How many contents entries this one sits INSIDE — 0 for a top-level entry.
   * Not decoration: together with the href it is how the division builder tells
   * a chapter nested under a part from a heading printed inside a chapter, which
   * is a distinction the flat list this used to be could not carry (see the
   * builder's own comment for what that cost).
   */
  depth: number;
}

/**
 * The publisher's table of contents, entry by entry, in its own order.
 *
 * EPUB 3's nav document first — the `<nav epub:type="toc">` a package declares
 * with `properties="nav"` — and the NCX where there is none, which is every EPUB 2
 * and a good many EPUB 3s that kept one for old reading systems. Both are read the
 * same way and neither is interpreted: the label is the label, verbatim.
 *
 * EVERY ENTRY AND NOT ONLY THE TOP LEVEL, each carrying its depth. Dropping the
 * sub-entries here would be this function deciding which of somebody's contents
 * count, and it decides nothing — but the CALLER has to (a nested entry can be a
 * chapter inside a part or a heading inside a chapter, and only the hrefs can
 * tell those apart), so what nests under what leaves here as a number instead of
 * being flattened away.
 */
function navEntries(navSource: string | null, ncxSource: string | null): NavEntry[] {
  if (navSource !== null) {
    const root = parseXml(navSource, 'xhtml');
    const navs = findElements(root, 'nav');
    const toc = navs.find((nav) => epubTypes(nav).includes('toc')) ?? navs[0];
    if (toc !== undefined) {
      const out: NavEntry[] = [];
      /*
       * The depth is `<ol>` nesting: the toc's own list is the surface, so an
       * anchor in it lands at 0 and each list inside a list adds one. The walk
       * starts at -1 because the nav element itself is not a level — and the
       * result is clamped, so an anchor a malformed nav left outside any list
       * reads as top-level rather than inventing a hierarchy below zero.
       */
      const walk = (el: XmlElement, depth: number): void => {
        for (const child of el.children) {
          if (child.kind !== 'element') continue;
          if (child.tag === 'a') {
            const href = child.attrs.get('href');
            if (href === undefined || href.length === 0) continue;
            const title = decodeEntities(navSource.slice(child.innerStart, child.innerEnd))
              .replace(/<[^>]*>/g, '')
              .replace(/\s+/g, ' ')
              .trim();
            if (title.length > 0) out.push({ href, title, depth: Math.max(0, depth) });
            continue;
          }
          walk(child, child.tag === 'ol' ? depth + 1 : depth);
        }
      };
      walk(toc, -1);
      if (out.length > 0) return out;
    }
  }
  if (ncxSource === null) return [];
  const root = parseXml(ncxSource, 'xml');
  const out: NavEntry[] = [];
  /*
   * THE NEEDLE IS LOWER-CASE BECAUSE THE PARSER'S TAGS ARE. `src/epub/xml.ts`
   * spells every tag it reads `name.toLowerCase()` and the comparisons below run
   * against that, so a needle written the way the NCX DTD writes it — `navPoint`,
   * camel-cased — matched nothing, ever. It cost every EPUB 2 book its entire
   * table of contents, silently, because an NCX with no `navPoint` in it is
   * indistinguishable here from a book that declared no contents at all.
   *
   * The walk recurses because an NCX nests its navPoints the way a nav nests its
   * lists, and the depth is the count of navPoint ancestors: a point met inside
   * no other point is 0, exactly as an anchor in the toc's own list is.
   */
  const dig = (el: XmlElement, depth: number): void => {
    for (const child of el.children) {
      if (child.kind !== 'element') continue;
      if (child.tag !== 'navpoint') { dig(child, depth); continue; }
      const content = child.children.find(
        (grand): grand is XmlElement => grand.kind === 'element' && grand.tag.endsWith('content'),
      );
      const href = content?.attrs.get('src');
      const label = findElements(child, 'text')[0];
      if (href !== undefined && href.length > 0 && label !== undefined) {
        const title = decodeEntities(ncxSource.slice(label.innerStart, label.innerEnd))
          .replace(/\s+/g, ' ')
          .trim();
        if (title.length > 0) out.push({ href, title, depth });
      }
      dig(child, depth + 1);
    }
  };
  dig(root, 0);
  return out;
}

/** The container's own bytes, identified — the receipt, exactly as a bank is. */
function epubSha(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * WHERE THE FIGURES GO — derived from `--out`, and only on this route.
 *
 * `book-run.ts` names the crops after the BANK, because the crops belong to the
 * reading and a second book file written to a temporary directory must not
 * scatter a second copy of the pictures beside itself. There is no bank here, so
 * that rule has nothing to hang on and the book file is the only path the run is
 * given. The derivation is the exact inverse of the app's own
 * `bookFileFor`/`imagesDirFor` pair (app/electron/projects.ts): a book at
 * `readings/<key>.book.jsonl` puts its figures in `readings/<key>.images/`, which
 * is the directory the app composes for itself and reads back. The two are
 * written to agree by construction rather than by coincidence, which is the
 * grow-together rule applied to a path instead of to a parser.
 */
export function epubImagesDir(outPath: string): string {
  const resolved = path.resolve(outPath);
  const stem = resolved.toLowerCase().endsWith('.book.jsonl')
    ? resolved.slice(0, -'.book.jsonl'.length)
    : resolved.replace(/\.jsonl$/i, '');
  return `${stem}.images`;
}

/**
 * The whole of `f(epub)` — the container in, a `BookFile` value out.
 *
 * Separated from the run below so that the arithmetic is testable without a
 * directory to write into, which is the same seam `bookFile` and `buildBookFile`
 * already sit either side of.
 */
export function bookFromEpub(
  bytes: Buffer,
  opts: { language?: string; log: (line: string) => void },
): { book: BookFile; report: Omit<EpubExplodeReport, 'images'>; figures: { href: string; row: BookRow }[]; members: Map<string, ZipMember> } {
  const members = readZip(new Uint8Array(bytes));
  const container = containerFromMembers(members);
  const byPath = new Map(members.map((member) => [member.path, member] as const));

  const declared = packageLanguage(container.opfSource);
  if (opts.language === undefined && declared === null) {
    throw new EpubExplodeError(
      'this EPUB\'s package document declares no dc:language, so nothing says what language the book '
      + 'is in. Every EPUB must declare one; pass --language <bcp47> to state it for this book '
      + 'rather than having a language invented for it.',
    );
  }
  const language = opts.language ?? declared!;

  const book: Explosion = {
    rows: [],
    ordinal: 1,
    anchors: new Map(),
    opens: new Map(),
    noterefs: [],
    figures: [],
    dropped: new Map(),
    loose: new Map(),
    inlineImages: 0,
  };

  for (const document of container.documents) {
    let root: XmlElement;
    try {
      root = parseXml(document.source, 'xhtml');
    } catch (err) {
      /*
       * A DOCUMENT THAT DOES NOT PARSE STOPS THE RUN. It is XHTML, which is XML,
       * and a reading system handed one that does not parse shows a reader
       * nothing at all — so the file is already broken for its own purpose, and a
       * tree guessed out of it would put somebody's chapter in the middle of
       * somebody else's. The refusal names the document.
       */
      throw new EpubExplodeError(
        `"${document.path}" is a document of this book's spine and it is not well-formed XHTML `
        + `(${err instanceof Error ? err.message : String(err)}). Nothing here guesses at a shape for `
        + 'it: a tree read out of broken markup moves whole paragraphs.',
      );
    }
    const walk: DocumentWalk = {
      source: document.source,
      docPath: document.path,
      dir: directoryOf(document.path),
      pending: [],
      inherited: null,
    };
    const body = findElements(root, 'body')[0];
    // A spine document with no `<body>` is a file the reading system would draw
    // nothing of either; it contributes no rows and is not an error.
    if (body === undefined) continue;
    explodeElement(body, walk, book);
  }

  if (book.rows.length === 0) {
    throw new EpubExplodeError(
      `the ${container.documents.length} document(s) of this book's spine hold no text a book is made `
      + 'of, so there is no book to write.',
    );
  }

  /*
   * ── THE NOTEREFS, RESOLVED — AND WHAT IT TAKES TO MAKE A NOTE OF A TARGET ──
   *
   * The old ruling here was that a target which is not already a declared note is
   * never made into one: `epub:type` says which elements are notes, and inventing
   * a Footnote because something pointed at a paragraph would move that paragraph
   * to the end of a chapter on the strength of one attribute. That reasoning was
   * right about the danger and wrong about the evidence available, and a book
   * with no `epub:type` anywhere in it — every EPUB 2 ever made — lost all of its
   * notes to it.
   *
   * THE EVIDENCE IS TWO-SIDED, AND EITHER SIDE ALONE STILL CONVERTS NOTHING. A
   * number in the prose that LINKS somewhere is one half of a statement. A target
   * that answers by PRINTING the same number at its own start is the other half.
   * Together they are not this program recognising a note — they are the
   * publisher stating a correspondence at both of its ends, in the only spelling
   * EPUB 2 had, and reading it is retaining the data rather than guessing at it.
   * A link to a paragraph that opens with different words, or with no number at
   * all, converts nothing and is reported exactly as before; so is a number that
   * links nowhere resolvable. It takes both.
   */
  const rowById = new Map(book.rows.map((row) => [row.id, row] as const));
  let refs = 0;
  let unresolved = 0;
  for (const ref of book.noterefs) {
    const id = book.anchors.get(ref.target);
    const target = id === undefined ? undefined : rowById.get(id);
    if (target === undefined) { unresolved += 1; continue; }
    if (target.category !== 'Footnote') {
      // The leading `*` are the fold's emphasis markers: a house that sets its
      // note numbers in bold prints `**1.** Thomas Paine…`, and the number it
      // printed is still the first thing in the row.
      const opens = /^[\s*]*(\d+)/.exec(target.text);
      if (ref.printed === null || opens === null || opens[1] !== String(ref.printed)) {
        unresolved += 1;
        continue;
      }
      target.category = 'Footnote';
      if (target.refs === undefined) target.refs = [];
    }
    target.refs!.push({ block: ref.block, at: ref.at, len: ref.len });
    refs += 1;
  }

  /*
   * THE MARKERS NOTHING CLAIMS. A superscript run in the prose that no noteref
   * put a reference on is a number the book prints and this file cannot answer
   * for — the format's `loose.markers`, which is the flag a renderer draws in the
   * margin (§3 of the contract). A well-made EPUB produces none of these, which
   * is the whole difference between reading a link and matching a number.
   */
  const claimed = new Map<string, { at: number; len: number }[]>();
  for (const row of book.rows) {
    for (const ref of row.refs ?? []) {
      const already = claimed.get(ref.block);
      if (already === undefined) claimed.set(ref.block, [{ at: ref.at, len: ref.len }]);
      else already.push({ at: ref.at, len: ref.len });
    }
  }
  const loose: BookLooseMarker[] = [];
  for (const row of book.rows) {
    if (row.category === 'Footnote') continue;
    const taken = claimed.get(row.id) ?? [];
    for (const match of row.text.matchAll(SUPERSCRIPT_RUN)) {
      const at = match.index;
      const len = match[0].length;
      if (taken.some((span) => at < span.at + span.len && span.at < at + len)) continue;
      const printed = Number([...match[0]].map((c) => SUPERSCRIPT_DIGITS.indexOf(c)).join(''));
      loose.push({ block: row.id, at, len, printed });
    }
  }

  /* The publisher's contents, resolved onto rows. */
  const navSource = container.navSource;
  const ncxPath = ncxIn(container.opfSource, directoryOf(container.opfPath));
  const ncx = ncxPath === null ? undefined : byPath.get(ncxPath);
  const navDir = container.navPath === null ? directoryOf(container.opfPath) : directoryOf(container.navPath);
  const chapters: BookChapter[] = [];
  const seen = new Set<string>();
  /** The documents the accepted divisions open, for the heading test below. */
  const divided = new Set<string>();
  let unplaced = 0;
  let inside = 0;
  for (const entry of navEntries(navSource, ncx === undefined ? null : ncx.text())) {
    const hash = entry.href.indexOf('#');
    const base = hash < 0 ? entry.href : entry.href.slice(0, hash);
    const document = resolveHref(navDir, base);
    /*
     * ── A NESTED ENTRY POINTING INSIDE A CHAPTER IS A HEADING, NOT A DIVISION ──
     *
     * This loop used to make a division of every entry at every depth, on the
     * argument that a nested entry is a division the publisher drew — and for
     * the entries that name documents of their own that argument stands: a
     * chapter nested under a part is a division wherever the publisher nested
     * it, and it still becomes one here. But a nested entry whose href is a
     * FRAGMENT into a document an entry above it already claimed is the
     * publisher pointing at a heading INSIDE that chapter, and this model
     * already has a word for those: the row's own Section-header category,
     * which the element table gave it on the walk. Minting a division for it
     * flattened every sub-heading into a top-level chapter, and Foundry's own
     * export was the proof — the cast writes sections as nested entries under
     * their chapter, so a book exported and reopened came back with every
     * section wearing a chapter's dot (user report, 2026-08-17: *"they all
     * show up as chapters instead of just the proper chapters"*). The model
     * must survive its own round trip: divisions stay divisions, headings stay
     * headings, in both directions — and a publisher's book keeps the same
     * two-register reading, which the app can then indent exactly as it
     * indents its own.
     */
    if (entry.depth > 0 && hash >= 0 && divided.has(document)) { inside += 1; continue; }
    const id = hash < 0
      ? book.opens.get(document)
      : book.anchors.get(`${document}#${entry.href.slice(hash + 1)}`) ?? book.opens.get(document);
    // A DIVISION MUST NAME A ROW. An entry pointing at a document that exploded
    // to nothing, or at a fragment inside one, has nothing on the sheet to sit
    // above; it is counted and reported rather than written as a chapter over a
    // block that is not there, which every reader of this file refuses by name.
    if (id === undefined || seen.has(id)) { unplaced += 1; continue; }
    seen.add(id);
    divided.add(document);
    chapters.push({ id, title: entry.title });
  }

  /*
   * ── THE ROWS THAT PRINT A DIVISION'S OWN NAME ARE ITS TITLE ────────────────
   *
   * A nav entry is the publisher declaring what this place in the book is
   * CALLED. The rows sitting at the place it lands on, printing that name, are
   * therefore the division's title blocks — whatever the stylesheet spelled them
   * as, and this is the point of doing it here rather than in the element table:
   * `<p class="ct">KILLING AMERICA</p>` and `<h1>KILLING AMERICA</h1>` are one
   * thing, and only the contents can say so.
   *
   * PART OF THE NAME COUNTS, WHICH IS THE WHOLE REASON IT IS A WALK. A label
   * reads "Chapter 1: Killing America" and the page sets it as two blocks — a
   * number block "1" and a title block "KILLING AMERICA" — because that is how a
   * chapter opening is typeset. Each of them prints a PIECE of the name, so the
   * test is containment in either direction and it runs over the run of rows, not
   * one row. Four is where it stops: a chapter opening is a number, a title, a
   * subtitle and an epigraph attribution at the very most, and a longer walk
   * would start eating prose the moment a book repeated its own title in a
   * sentence.
   *
   * AND ANYTHING ELSE ENDS IT IMMEDIATELY. A row of prose is longer than the
   * label and contains none of it, so it fails; a Picture row — the cover, whose
   * entry is "Cover" and whose landing row is the image — fails on its category
   * and the walk stops before it starts, which is right, because a cover's title
   * block is the cover. Prose never restates a label, so the first row that does
   * not print the name is the end of the title and everything after it is the
   * chapter.
   */
  const rowAt = new Map(book.rows.map((row, index) => [row.id, index] as const));
  /** Emphasis markers off, whitespace collapsed, case folded — the name itself. */
  const nameOnly = (text: string): string => text
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  for (const chapter of chapters) {
    const start = rowAt.get(chapter.id);
    const label = nameOnly(chapter.title);
    if (start === undefined || label.length === 0) continue;
    for (let i = start; i < book.rows.length && i < start + 4; i += 1) {
      const row = book.rows[i]!;
      if (row.category !== 'Text' && row.category !== 'Section-header') break;
      const printed = nameOnly(row.text);
      if (printed.length === 0) break;
      if (!label.includes(printed) && !printed.includes(label)) break;
      row.category = 'Title';
    }
  }

  const made: BookFile = {
    engine: VERSION,
    language,
    source: {
      // The spine's documents, which is what an EPUB has instead of pages. The
      // field is `pages` because the format has one field for "how much source
      // was there", and a document is this book's unit of it.
      pages: container.documents.length,
      // Nothing was skipped: a document that would not parse stopped the run
      // above, so an EPUB either exploded whole or did not explode.
      unreadable: [],
      bankSha: epubSha(bytes),
    },
    rows: book.rows,
    chapters,
    // NO TYPOGRAPHY REPORT, and null is the contract's own spelling of that. The
    // report is medians over BOXES and there are no boxes; the base sheet's type
    // rules stand, which is the documented silence.
    typography: null,
    // NO SEAMS. A seam is a page turn the reflow declined to join and there are
    // no page turns — the publisher's paragraphs arrived whole.
    seams: [],
    loose: {
      markers: loose,
      notes: book.rows.filter((row) => row.category === 'Footnote' && row.refs!.length === 0)
        .map((row) => row.id),
    },
  };

  for (const [tag, count] of book.dropped) {
    opts.log(`vlm-book: ${count} <${tag}> element(s) dropped with their content — nothing executable or `
      + 'presentational becomes text in a book file');
  }
  for (const [tag, count] of book.loose) {
    opts.log(`vlm-book: ${count} <${tag}> element(s) had no rule in the category table and their words `
      + 'were kept as Text');
  }
  if (book.inlineImages > 0) {
    opts.log(`vlm-book: ${book.inlineImages} picture(s) sit inside a paragraph, where a row has no field `
      + 'to name one. Their words are unaffected; the images are not carried.');
  }
  if (unresolved > 0) {
    opts.log(`vlm-book: ${unresolved} noteref anchor(s) point at something this book does not declare as `
      + 'a note. The numbers stay in the prose; no reference was invented for them.');
  }
  if (unplaced > 0) {
    opts.log(`vlm-book: ${unplaced} contents entry(ies) name a place with no block in it, so no division `
      + 'was drawn there.');
  }
  if (inside > 0) {
    opts.log(`vlm-book: ${inside} contents entry(ies) point at headings inside a chapter; they stay `
      + 'headings on the page rather than divisions of the book.');
  }

  return {
    book: made,
    report: {
      rows: book.rows,
      documents: container.documents.length,
      chapters: chapters.length,
      refs,
      language,
      languageFrom: opts.language === undefined ? 'package' : 'command line',
    },
    figures: book.figures,
    members: byPath,
  };
}

/** The NCX the package declares, resolved, or null where it declares none. */
function ncxIn(opfSource: string, opfDir: string): string | null {
  for (const item of findElements(parseXml(opfSource, 'xml'), 'item')) {
    if (item.attrs.get('media-type') !== 'application/x-dtbncx+xml') continue;
    const href = item.attrs.get('href');
    if (href !== undefined && href.length > 0) return resolveHref(opfDir, href);
  }
  return null;
}

/**
 * THE RUN: an imported EPUB in, a book file (and its figures) out.
 *
 * `buildBookFile`'s shape one source along — open the receipt, hash its bytes,
 * make the book, write it atomically beside where it was asked for. Written with
 * a temp file and a rename for that function's reason exactly: a crash leaves the
 * old book or none, never half of one.
 */
export async function explodeEpub(opts: EpubExplodeOptions): Promise<EpubExplodeReport> {
  const epubPath = path.resolve(opts.epubPath);
  if (!fs.existsSync(epubPath)) {
    throw new EpubExplodeError(
      `no such EPUB: ${epubPath}. This route explodes a publisher's own container into the book file; `
      + 'it reads no page from a model, so an absent archive is nothing it can make up for.',
    );
  }
  const bytes = fs.readFileSync(epubPath);
  const made = bookFromEpub(bytes, {
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    log: opts.log,
  });

  const images = copyFigures(made.figures, made.members, opts);

  const resolved = path.resolve(opts.outPath);
  ensureDir(path.dirname(resolved));
  const pending = `${resolved}.tmp`;
  fs.writeFileSync(pending, formatBookFile(made.book), 'utf8');
  fs.renameSync(pending, resolved);

  const flow = made.book.rows.length;
  const notes = made.book.rows.filter((row) => row.category === 'Footnote').length;
  opts.log(
    `vlm-book: ${flow} block(s) from ${made.report.documents} spine document(s) — ${notes} note(s), `
    + `${images.length} figure(s), ${made.report.chapters} division(s) from the publisher's contents`,
  );
  opts.log(
    `vlm-book: ${made.report.refs} reference marker(s) taken from the book's own noteref anchors, `
    + `${made.book.loose.markers.length} marker(s) with no note, `
    + `${made.book.loose.notes.length} note(s) nothing points at`,
  );
  opts.log(
    `vlm-book: the language is ${made.report.language}, declared by the ${made.report.languageFrom}`,
  );
  opts.log(`vlm-book: wrote ${resolved}`);
  return { ...made.report, images };
}

/**
 * The pictures, COPIED once — §6 of the contract, on a route that cuts nothing.
 *
 * The bank route crops pixels out of page renders because a scan's figure exists
 * only as part of a page. An EPUB's figure is already a file, made by the
 * publisher, and the only honest thing to do with it is copy it: re-encoding
 * would produce a different file that means the same thing, which is work done to
 * lose fidelity (`unzip.ts`'s own argument for passing untouched entries through).
 *
 * NAMED AFTER THE ROW AND NOT AFTER THE SOURCE. A row's `image` is a NAME inside
 * this book's own directory (§3), and naming a copy after its container path
 * would put slashes in it or invent a flattening rule; naming it after the row
 * that points at it is deterministic, collision-free and traceable by hand. A
 * figure used twice is copied twice under two names, which costs a few kilobytes
 * and buys the property that a row's picture is a file nothing else claims.
 *
 * THE DIRECTORY IS MADE FRESH, for `cutFigures`' reason: it is derived,
 * regenerable and swept with the book file, and a regeneration must not leave the
 * picture of a row that no longer exists sitting beside the ones that do.
 */
function copyFigures(
  figures: readonly { href: string; row: BookRow }[],
  members: ReadonlyMap<string, ZipMember>,
  opts: EpubExplodeOptions,
): string[] {
  const dir = epubImagesDir(opts.outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  if (figures.length === 0) return [];
  ensureDir(dir);

  const written: string[] = [];
  for (const figure of figures) {
    const member = members.get(figure.href);
    if (member === undefined) {
      /*
       * A ROW POINTING AT A FILE THE CONTAINER DOES NOT HOLD is a broken picture
       * in every reader of this book, and it is the publisher's archive that is
       * short rather than anything here — so it is said out loud and the row
       * simply names no image, which is a state `vlm-compile` already refuses by
       * name if anybody tries to export it.
       */
      opts.log(
        `vlm-book: a figure points at "${figure.href}", which is not in this container. The block `
        + 'names no picture.',
      );
      continue;
    }
    const dot = figure.href.lastIndexOf('.');
    const name = `${figure.row.id.replace('-', '')}${dot < 0 ? '' : figure.href.slice(dot).toLowerCase()}`;
    // Typed before it is written: an extension no EPUB may legally carry is
    // refused here, where the sentence can name the file, rather than in a
    // package manifest a reading system silently rejects.
    figureMediaType(name);
    fs.writeFileSync(path.join(dir, name), member.data);
    figure.row.image = name;
    written.push(name);
  }
  if (written.length > 0) opts.log(`vlm-book: ${written.length} figure(s) copied into ${dir}`);
  return written;
}
