/**
 * epub/final — the last step: a curated book becomes the edition.
 *
 * Everything before this produces a WORKING book: the vision model's cast with
 * foundry's stamps on every element, plus whatever a person marked for removal
 * in select mode. This command turns that into the file somebody would hand to
 * a library — the marked elements gone, the wreckage a removal leaves tidied
 * up, the two editing-only attributes stripped, and an integrity report saying
 * what the book can and cannot prove about itself.
 *
 * NOTHING HERE SERIALIZES A DOCUMENT. Every edit is a source-range splice
 * computed from `xml.ts`'s offsets, and every untouched member is written back
 * with the exact bytes, method and CRC it arrived with (`ZipEntry.method` 8 is
 * a pass-through — see the header on `src/export/zip.ts`). A book whose only
 * cut was in chapter nine comes out differing from its input in chapter nine,
 * the package and the nav, and nowhere else. Re-encoding a 20 MB scan's figures
 * to produce a different file that means the same thing is work done to lose
 * the ability to say that.
 *
 * WHAT A CUT LEAVES DANGLING, AND WHY EACH ONE IS TIDIED HERE. A cut is one
 * attribute on one element, which is the whole point of representing it that
 * way — but the element it sits on is referred to by other parts of the book,
 * and none of those references is validated anywhere else:
 *
 *  - a footnote whose only reference was cut — the `<aside>` survives with a
 *    backlink pointing at an id that no longer exists;
 *  - a `<section class="footnotes">` holding nothing but its `<hr/>`, which a
 *    reader sees as a rule with nothing under it;
 *  - a contents entry whose `#sh3` target went with the heading;
 *  - an image nothing points at any more, still costing its megabytes;
 *  - and the subtle one: `dots-book.ts` emits a page's
 *    `<span epub:type="pagebreak">` INSIDE THE FIRST BLOCK of that page, so
 *    cutting that block deletes the page marker and the page silently vanishes
 *    from the book's own pagination. The marker is re-homed to the next
 *    surviving block on its page.
 *
 * ONLY WHAT THIS RUN REMOVED IS TIDIED. A contents entry that pointed nowhere
 * before the run is somebody else's business — it may be hand-written, it may
 * be a defect in the cast, and either way this command did not create it and
 * removing it would be an edit nobody ordered. Every rule below is written as
 * "referenced before and not now", never as "unreferenced".
 *
 * THE FILE IS WRITTEN ANYWAY. The integrity report can say that eleven
 * reference numbers never found a note and that the book declares no cover, and
 * the edition is still produced. Those are facts about the SCAN — `dots-book.ts`
 * refuses to guess which note an unmatched marker belongs to, and no link beats
 * a wrong one — and a book somebody cannot produce is worse than one with a
 * stated gap. What refuses is an input that is not a foundry book, an input
 * that cannot be read, and an `--out` that is the input itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { crc32, writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { spliceAll } from '../translate/blocks.js';
import { bookFromMembers, resolveHref, type FoundryBook } from '../translate/book.js';
import { readZip, type ZipMember } from '../translate/unzip.js';
import { elements, findElements, parseXml, type XmlElement } from './xml.js';

/** An input this command will not turn into an edition. Always names the path. */
export class FinalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalError';
  }
}

/**
 * Why this command needs foundry's stamps, for the shared admission rule in
 * `book.ts`. A publisher's EPUB has no `data-bf-cut` in it and never will, so
 * running this over one would produce a byte-for-byte copy of somebody's book
 * under a new name and call it an edition.
 */
const FINAL_NEEDS_STAMPS =
  'the final edition is made by removing the elements a curator marked, and a mark sits on '
  + 'the categories foundry stamps';

export interface FinalReport {
  outPath: string;
  /** Spine documents read. */
  documents: number;
  /** Elements removed for carrying `data-bf-cut`. Outermost only — a cut takes its children. */
  cuts: number;
  /** Notes removed because the cut took every reference to them. */
  notesDropped: number;
  /** `<section class="footnotes">` elements removed for holding nothing but a rule. */
  noteSectionsDropped: number;
  /** Reference numbers demoted back to a plain `<sup>` because their note was cut. */
  noterefsDemoted: number;
  /** Contents entries removed outright because this run removed what they pointed at. */
  navRemoved: number;
  /**
   * Contents entries whose target went but whose sub-entries did not: the link
   * became a plain label rather than the entry taking its children with it.
   */
  navDemoted: number;
  /** Image members dropped, by archive path. */
  imagesDropped: string[];
  /** Printed pages whose marker moved to the next surviving block on the page. */
  pagesRehomed: string[];
  /** Printed pages that lost their marker because nothing on them survived. */
  pagesLost: string[];
  /** Reference numbers in the finished book that link to a note. */
  noterefs: number;
  /** Reference numbers that stayed a plain `<sup>` — the emitter could not match a note. */
  unlinkedMarkers: number;
  /** Notes in the finished book. */
  notes: number;
  /** Notes nothing points at. */
  unreferencedNotes: number;
  /** Whether the package declares a cover image. */
  cover: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// The input: a zip, or a tree that has not been zipped yet
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The members of the input book, whether it arrived as a file or as a
 * directory.
 *
 * THE DIRECTORY FORM IS NOT A CONVENIENCE. The app keeps the working copy of a
 * book UNPACKED and never rezips it until this moment — a cut writes one
 * chapter file of a few kilobytes, where a repack of a 20 MB scan costs 20 MB
 * per edit and can fail halfway. Requiring a zip here would mean zipping the
 * book once just to read it straight back.
 *
 * A directory is admitted only if it looks like an unpacked EPUB — `mimetype`
 * and `META-INF/container.xml` — and refused BY NAME otherwise. The failure
 * being designed out is somebody passing a project folder, a library root or
 * the parent of the working tree and getting a ZIP diagnostic about a file
 * they never named.
 */
export function readEpubInput(inputPath: string): ZipMember[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(inputPath);
  } catch (error) {
    throw new FinalError(
      `${inputPath} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}. `
      + '--epub takes an EPUB file or an unpacked EPUB directory.',
    );
  }

  if (stat.isFile()) {
    // The zip route. Its own diagnostics stand — `unzip.ts` says which entry
    // failed its checksum or which two headers disagree, and nothing this layer
    // could say about the same bytes would be more use.
    return readZip(new Uint8Array(fs.readFileSync(inputPath)));
  }
  if (!stat.isDirectory()) {
    throw new FinalError(`${inputPath} is neither a file nor a directory, and --epub takes one of those`);
  }

  for (const needed of ['mimetype', 'META-INF/container.xml']) {
    if (!fs.existsSync(path.join(inputPath, ...needed.split('/')))) {
      throw new FinalError(
        `${inputPath} is a directory with no ${needed} in it, so it is not an unpacked EPUB. `
        + '--epub takes an EPUB file or the directory an EPUB was unpacked into.',
      );
    }
  }

  const relative: string[] = [];
  collectFiles(inputPath, inputPath, relative);

  /*
   * `mimetype` first, and the rest in path order.
   *
   * The OCF spec requires the first entry of an EPUB to be an uncompressed
   * `mimetype`, so that a reader can identify the file at byte offset 30
   * without parsing anything. A directory listing has no order to preserve —
   * the order the archive had was lost when it was unpacked — so one is chosen
   * here, deterministically, rather than left to the filesystem's enumeration.
   */
  relative.sort();
  const ordered = ['mimetype', ...relative.filter((p) => p !== 'mimetype')];

  return ordered.map((rel): ZipMember => {
    const data = new Uint8Array(fs.readFileSync(path.join(inputPath, ...rel.split('/'))));
    // Stored, because nothing in an unpacked tree is compressed. `raw` is the
    // same bytes for the same reason: there is no compressed form to keep.
    return {
      path: rel,
      data,
      raw: data,
      method: 0,
      crc: crc32(data),
      uncompressedSize: data.length,
      text: () => new TextDecoder().decode(data),
    };
  });
}

function collectFiles(root: string, dir: string, into: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { collectFiles(root, full, into); continue; }
    if (entry.isFile()) {
      into.push(path.relative(root, full).split(path.sep).join('/'));
      continue;
    }
    // A socket, a device node or a dangling symlink inside a book. Named rather
    // than skipped: an entry silently left out of the edition is a missing
    // chapter nobody was told about (ARCHITECTURE §8).
    throw new FinalError(`${full} is not a regular file, and every entry of an unpacked EPUB is one`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading one document's cuts
// ═════════════════════════════════════════════════════════════════════════════

/** The mark a curator leaves on an element. `data-bf-id` is how they named it. */
const CUT_ATTRIBUTE = 'data-bf-cut';

/**
 * The attributes that mean nothing outside this program, as they appear in a
 * start tag.
 *
 * `data-bf-page` and `data-bf-cat` are NOT in here and never will be: page
 * provenance is what makes a scan citable, it is invisible to a reader, and it
 * is what every later pass — a translation, a text export, a picker — reads.
 *
 * IT WAS TWO AND IT IS FOUR, and the two that were added are the two that were
 * born after this command was written. `data-bf-src` names the banked answers an
 * element's words came from and `data-bf-note` says which note of its block an
 * aside is; both exist so that a decision made on the flowing page can be
 * written back against the model's own answer, both are addressed to this
 * program alone, and both were shipping to readers inside every edition this
 * command produced. The list is not "the marks a curator leaves" — it is
 * everything foundry writes for its own use, and anything else added for that
 * purpose belongs here on the day it is added.
 */
const EDITING_ATTRIBUTES =
  /\s+data-bf-(?:cut|id|src|note)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s/>]*))?/gi;

interface DocPlan {
  path: string;
  /** The directory the document sits in, for resolving its own hrefs. */
  dir: string;
  source: string;
  root: XmlElement;
  /** Every element, in document order. */
  all: XmlElement[];
  /** Every element this run removes — the marked ones and everything under them. */
  removed: Set<XmlElement>;
  /** The ids this run removed from this document. */
  removedIds: Set<string>;
  /** Marked elements, outermost only. */
  cuts: number;
  /** Stamped elements before the cut, for "this document has no content left". */
  stampedBefore: number;
}

function directoryOf(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? '' : p.slice(0, slash);
}

/** Is any ancestor of this element already being removed? See the splice loop. */
function insideRemoved(el: XmlElement, removed: ReadonlySet<XmlElement>): boolean {
  for (let up = el.parent; up !== null; up = up.parent) {
    if (removed.has(up)) return true;
  }
  return false;
}

/**
 * Find the marked elements, and everything that goes with them.
 *
 * A MARK INSIDE A MARK IS NOT A SECOND CUT. The walk is depth-first, so an
 * outer marked element is reached first and claims its whole subtree; a mark
 * further down is already in `removed` by the time it comes round. Splicing
 * both would mean two edits fighting over one span of somebody's book, which
 * `spliceAll` refuses — correctly, but the count would also have been wrong.
 */
function planCuts(docPath: string, source: string): DocPlan {
  const root = parseXml(source, 'xhtml');
  const all = [...elements(root)];
  const removed = new Set<XmlElement>();
  let cuts = 0;

  for (const el of all) {
    if (!el.attrs.has(CUT_ATTRIBUTE) || removed.has(el)) continue;
    cuts += 1;
    for (const inner of elements(el)) removed.add(inner);
  }

  const removedIds = new Set<string>();
  for (const el of removed) {
    const id = el.attrs.get('id');
    if (id !== undefined) removedIds.add(id);
  }

  return {
    path: docPath,
    dir: directoryOf(docPath),
    source,
    root,
    all,
    removed,
    removedIds,
    cuts,
    stampedBefore: all.filter((el) => el.attrs.has('data-bf-cat')).length,
  };
}

/** `<a epub:type="noteref">` — a reference number that links to a note. */
function isNoteref(el: XmlElement): boolean {
  return el.tag === 'a' && (el.attrs.get('epub:type') ?? '').split(/\s+/).includes('noteref');
}

/** `<aside epub:type="footnote">` — a note. */
function isNote(el: XmlElement): boolean {
  return el.tag === 'aside' && (el.attrs.get('epub:type') ?? '').split(/\s+/).includes('footnote');
}

function isPagebreak(el: XmlElement): boolean {
  return el.tag === 'span' && (el.attrs.get('epub:type') ?? '').split(/\s+/).includes('pagebreak');
}

function isFootnotesSection(el: XmlElement): boolean {
  return (el.attrs.get('epub:type') ?? '').split(/\s+/).includes('footnotes')
    || (el.tag === 'section' && (el.attrs.get('class') ?? '').split(/\s+/).includes('footnotes'));
}

/**
 * What a link points at, as `document#fragment`.
 *
 * Keyed by document as well as fragment because ids are only unique within a
 * document: `sh1` removed from chapter three must not make a contents entry
 * pointing at chapter five's `sh1` look dead.
 */
function targetKey(baseDir: string, docPath: string, href: string): string | null {
  const hash = href.indexOf('#');
  if (hash < 0) return null;
  const fragment = href.slice(hash + 1);
  if (fragment === '') return null;
  const target = hash === 0 ? docPath : resolveHref(baseDir, href);
  return `${target}#${fragment}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Editing one document
// ═════════════════════════════════════════════════════════════════════════════

interface Edit { start: number; end: number; text: string }

/**
 * The range a whole-line element occupies, indentation and newline included.
 *
 * Splicing `el.start..el.end` alone is correct and leaves a line of spaces
 * behind for every block that was cut. A book with two hundred cuts in it then
 * carries two hundred blank indented lines — invisible to a reader, ugly to
 * anybody who opens the document, and a diff against the working copy that is
 * larger than the edit. The range is only widened over WHITESPACE, and only
 * when the element had its line to itself; an inline element in the middle of a
 * sentence takes exactly its own span and nothing else.
 */
function removalRange(source: string, el: XmlElement): Edit {
  let start = el.start;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start -= 1;
  const atLineStart = start === 0 || source[start - 1] === '\n';

  let end = el.end;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t' || source[end] === '\r')) end += 1;
  const toLineEnd = end >= source.length || source[end] === '\n';

  if (!atLineStart || !toLineEnd) return { start: el.start, end: el.end, text: '' };
  return { start, end: end < source.length ? end + 1 : end, text: '' };
}

/** Drop `data-bf-cut` and `data-bf-id` from a start tag, or null if it carries neither. */
function stripEdit(source: string, el: XmlElement): Edit | null {
  // `innerStart` is the offset just past the start tag, self-closing or not, so
  // this is the whole of `<p …>` and none of what it contains.
  const tag = source.slice(el.start, el.innerStart);
  const stripped = tag.replace(EDITING_ATTRIBUTES, '');
  if (stripped === tag) return null;
  return { start: el.start, end: el.innerStart, text: stripped };
}

/**
 * Sort so that an INSERTION at an offset lands before a removal that starts
 * there.
 *
 * `spliceAll` sorts by start and refuses overlapping ranges; a zero-length
 * insertion at the same offset as a removal is not an overlap, but the check
 * only sees that if the insertion comes first. Array sort is stable, so
 * ordering ties here survives the sort inside `spliceAll`. The case is real: a
 * re-homed page marker goes at the start of a block whose own first child may
 * itself have been cut.
 */
function orderEdits(edits: Edit[]): Edit[] {
  return [...edits].sort((a, b) => (a.start - b.start) || ((a.end - a.start) - (b.end - b.start)));
}

interface TidyCounts {
  notesDropped: number;
  noteSectionsDropped: number;
  noterefsDemoted: number;
  pagesRehomed: string[];
  pagesLost: string[];
}

/**
 * Everything that follows from a document's cuts, spliced in one pass.
 *
 * Order matters and is not arbitrary: the notes and the note sections decide
 * what else is removed, so they run before the page markers look for a landing
 * place and before the attributes are stripped off survivors. `plan.removed`
 * and `plan.removedIds` are still growing while that happens, which is why the
 * nav is not touched until every document has been through here.
 */
function tidyDocument(
  plan: DocPlan,
  refsBefore: ReadonlyMap<string, number>,
  refsAfter: ReadonlyMap<string, number>,
): { source: string; counts: TidyCounts } {
  const { source, all, removed, removedIds } = plan;
  const counts: TidyCounts = {
    notesDropped: 0,
    noteSectionsDropped: 0,
    noterefsDemoted: 0,
    pagesRehomed: [],
    pagesLost: [],
  };

  const drop = (el: XmlElement): void => {
    for (const inner of elements(el)) {
      removed.add(inner);
      const id = inner.attrs.get('id');
      if (id !== undefined) removedIds.add(id);
    }
  };

  /*
   * A NOTE WHOSE ONLY REFERENCE WAS CUT GOES WITH IT. That is the choice, and
   * the alternative — keeping the note and demoting its backlink to a plain
   * <sup> — was rejected: the note annotates a sentence the book no longer
   * contains, so what it would leave behind is a numbered remark at the end of
   * a chapter that refers to nothing a reader can find. A printer removing a
   * paragraph removes its footnote. The count is reported, so the removal is
   * never silent.
   *
   * A note that NEVER had a reference is left exactly alone. `dots-book.ts`
   * matches a marker to a note by (page, printed number) and deliberately
   * refuses to guess when it cannot — that unmatched note is a fact about the
   * scan, it was there before this run, and removing it would be an edit
   * nobody ordered. It is counted in the integrity report instead.
   */
  for (const el of all) {
    if (removed.has(el) || !isNote(el)) continue;
    const id = el.attrs.get('id');
    if (id === undefined) continue;
    const key = `${plan.path}#${id}`;
    if ((refsBefore.get(key) ?? 0) === 0) continue;
    if ((refsAfter.get(key) ?? 0) > 0) continue;
    drop(el);
    counts.notesDropped += 1;
  }

  /*
   * A footnotes section with no notes left in it is an `<hr/>` and nothing
   * else — a horizontal rule at the end of a chapter with white space under
   * it, which a reader sees. Unlike every other rule here this one does not
   * ask whether the emptiness is new, because an empty note section is not
   * something a person can have meant either way and nothing in a cast book
   * ever emits one.
   */
  for (const el of all) {
    if (removed.has(el) || !isFootnotesSection(el)) continue;
    const alive = [...elements(el)].some((inner) => inner !== el && isNote(inner) && !removed.has(inner));
    if (alive) continue;
    drop(el);
    counts.noteSectionsDropped += 1;
  }

  const edits: Edit[] = [];

  /*
   * THE PAGE MARKER IS RE-HOMED, NOT LOST WITH ITS BLOCK. `dots-book.ts` emits
   * a page's `<span epub:type="pagebreak">` inside the FIRST block of that
   * page rather than as a sibling — so cutting a running header, an epigraph or
   * the opening paragraph of a page takes the page's only marker with it and
   * the page disappears from the book's own pagination. Nothing else in the
   * book records where page 47 began, so nothing downstream could put it back.
   *
   * It moves to the next surviving block on the SAME page, innermost first: a
   * `<ul>` and its `<li>` are both stamped with the page, and a page marker
   * between `<ul>` and `<li>` is not markup. Innermost is also exactly where
   * the emitter puts it. When no block on that page survives the page really
   * is gone, the marker goes with it, and the report says which page.
   */
  for (const span of all) {
    if (!removed.has(span) || !isPagebreak(span)) continue;
    const page = span.attrs.get('data-bf-page')
      ?? /^pb-(.+)$/.exec(span.attrs.get('id') ?? '')?.[1]
      ?? span.attrs.get('aria-label')
      ?? null;
    if (page === null) {
      // A marker carrying no page, no `pb-N` id and no label names no page, so
      // "the next block on the same page" has nothing to mean. Reported as lost
      // rather than dropped quietly — it is still a page that left the book.
      counts.pagesLost.push('(unnumbered)');
      continue;
    }

    // A pagebreak span carries its own `data-bf-page`, so it would otherwise
    // qualify as a block on its own page — and a page marker nested inside
    // another page marker is not markup anybody meant.
    const onThisPage = (el: XmlElement): boolean =>
      !removed.has(el) && !isPagebreak(el) && el.attrs.get('data-bf-page') === page;
    const home = all.find((el) =>
      onThisPage(el)
      && el.start > span.start
      && ![...elements(el)].some((inner) => inner !== el && onThisPage(inner)));

    if (home === undefined) { counts.pagesLost.push(page); continue; }
    // Verbatim, so the id, the role and the aria-label move intact — minus the
    // editing attributes, which the strip pass below cannot reach because the
    // span's own start tag is inside a range that is about to be deleted.
    const marker = source.slice(span.start, span.end).replace(EDITING_ATTRIBUTES, '');
    edits.push({ start: home.innerStart, end: home.innerStart, text: marker });
    counts.pagesRehomed.push(page);
  }

  /*
   * THE MIRROR CASE: a reference whose NOTE was cut. Somebody who selects a
   * footnote and deletes it leaves every marker in the prose linking to an id
   * that is gone — a superscript that does nothing in one reader and jumps to
   * the top of the chapter in another. The number itself stays, because it is
   * printed on the page and this program does not delete what the scan shows;
   * only the link goes, which is `dots-book.ts`'s own rule for a marker it
   * could not match. No link beats a wrong one.
   */
  const demoted = new Set<XmlElement>();
  for (const el of all) {
    if (removed.has(el) || !isNoteref(el) || el.selfClosing) continue;
    const href = el.attrs.get('href') ?? '';
    const hash = href.indexOf('#');
    if (hash < 0) continue;
    // Only a note in THIS document: the removals of the other documents are
    // still being decided as this runs, and a cross-document noteref — which
    // `dots-book.ts` never emits, since notes collect in the chapter their
    // markers are in — would be judged against a half-finished answer.
    if (hash > 0 && resolveHref(plan.dir, href) !== plan.path) continue;
    const fragment = href.slice(hash + 1);
    if (fragment === '' || !removedIds.has(fragment)) continue;
    demoted.add(el);
    edits.push({ start: el.start, end: el.innerStart, text: '' });
    edits.push({ start: el.innerEnd, end: el.end, text: '' });
    counts.noterefsDemoted += 1;
  }

  /*
   * The outermost removals only: a range inside another range is already gone,
   * and asking for both is the overlap `spliceAll` refuses.
   *
   * THE WHOLE ANCESTRY, not just the parent. Every nesting a foundry book
   * writes today is one deep — `<ul>` over `<li>`, `<blockquote>` over its
   * `<p>` — so a parent test happens to be enough right now. It stops being
   * enough the moment anything sits two levels down: a cut inside a cut inside
   * a cut would pass the parent test, both ranges would be handed to
   * `spliceAll`, and the command would THROW on a real book rather than write
   * it. The walk costs nothing and the trap it removes is a crash.
   */
  for (const el of all) {
    if (!removed.has(el)) continue;
    if (insideRemoved(el, removed)) continue;
    edits.push(removalRange(source, el));
  }

  for (const el of all) {
    if (removed.has(el) || demoted.has(el)) continue;
    const edit = stripEdit(source, el);
    if (edit !== null) edits.push(edit);
  }

  return { source: spliceAll(source, orderEdits(edits)), counts };
}

// ═════════════════════════════════════════════════════════════════════════════
// The contents
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The nav document, with the entries this run orphaned taken out.
 *
 * NOT BUILT ON `navLabels`. That returns source RANGES and skips any anchor
 * whose content is not plain text, which is right for relabelling and wrong
 * here twice over: removing an entry means walking from the anchor up to its
 * `<li>`, which a range cannot do, and an entry whose label carries an `<em>`
 * still points at a heading that may be gone.
 *
 * AN ENTRY WHOSE TARGET NEVER RESOLVED IS LEFT ALONE. A cast book can carry a
 * contents entry pointing at an id nothing declares; that is not something this
 * run created, a person may have written it, and this command's whole claim is
 * that the edition differs from the working copy only where a cut required it.
 */
function tidyNav(
  book: FoundryBook,
  plans: ReadonlyMap<string, DocPlan>,
  emptyDocuments: ReadonlySet<string>,
): { source: string; removed: number; demoted: number } | null {
  if (book.navPath === null || book.navSource === null) return null;
  const source = book.navSource;
  const navDir = directoryOf(book.navPath);
  const root = parseXml(source, 'xhtml');
  const all = [...elements(root)];

  const nearestLi = (el: XmlElement): XmlElement | null => {
    for (let p = el.parent; p !== null; p = p.parent) if (p.tag === 'li') return p;
    return null;
  };

  const deadAnchors = new Set<XmlElement>();
  for (const el of all) {
    if (el.tag !== 'a') continue;
    const href = el.attrs.get('href');
    if (href === undefined) continue;
    const target = resolveHref(navDir, href);
    const plan = plans.get(target);
    if (plan === undefined) continue;

    const hash = href.indexOf('#');
    const fragment = hash < 0 ? null : href.slice(hash + 1);
    // A document every one of whose blocks was cut is a chapter that is not in
    // the book any more, whatever its file still says. Its entry goes whether
    // or not the anchor carried a fragment.
    if (emptyDocuments.has(target)) { deadAnchors.add(el); continue; }
    if (fragment !== null && fragment !== '' && plan.removedIds.has(fragment)) deadAnchors.add(el);
  }
  if (deadAnchors.size === 0) return { source, removed: 0, demoted: 0 };

  /*
   * An entry is a whole `<li>`, and an `<li>` may hold the sub-entries of the
   * chapter it names. Removing it outright would take a heading's sub-sections
   * out of the contents because the heading itself was cut — so an `<li>` dies
   * only when nothing is left under it, and otherwise its link becomes a plain
   * `<span>`, which the EPUB nav grammar allows exactly for a label with no
   * document of its own. Iterated to a fixed point because a sub-entry dying
   * can be what empties its parent.
   */
  const lis = all.filter((el) => el.tag === 'li');
  const ownAnchors = new Map<XmlElement, XmlElement[]>();
  const subLis = new Map<XmlElement, XmlElement[]>();
  for (const el of all) {
    const li = nearestLi(el);
    if (li === null) continue;
    if (el.tag === 'a') ownAnchors.set(li, [...(ownAnchors.get(li) ?? []), el]);
    if (el.tag === 'li') subLis.set(li, [...(subLis.get(li) ?? []), el]);
  }

  const dead = new Set<XmlElement>();
  for (;;) {
    let changed = false;
    for (const li of lis) {
      if (dead.has(li)) continue;
      const anchors = ownAnchors.get(li) ?? [];
      if (anchors.length === 0 || !anchors.every((a) => deadAnchors.has(a))) continue;
      if ((subLis.get(li) ?? []).some((sub) => !dead.has(sub))) continue;
      dead.add(li);
      changed = true;
    }
    if (!changed) break;
  }

  // An `<ol>` all of whose items died is an empty list, which is not legal nav
  // and reads as a stray indent in anything that renders it anyway. The list
  // goes instead of its items.
  for (const ol of findElements(root, 'ol')) {
    const items = ol.children.filter((c): c is XmlElement => c.kind === 'element' && c.tag === 'li');
    if (items.length > 0 && items.every((li) => dead.has(li))) dead.add(ol);
  }

  const insideDead = (el: XmlElement): boolean => {
    for (let p = el.parent; p !== null; p = p.parent) if (dead.has(p)) return true;
    return false;
  };

  const edits: Edit[] = [];
  for (const el of dead) {
    if (insideDead(el)) continue;
    edits.push(removalRange(source, el));
  }
  let demoted = 0;
  for (const anchor of deadAnchors) {
    const li = nearestLi(anchor);
    if ((li !== null && dead.has(li)) || insideDead(anchor)) continue;
    edits.push({ start: anchor.start, end: anchor.innerStart, text: '<span>' });
    edits.push({ start: anchor.innerEnd, end: anchor.end, text: '</span>' });
    demoted += 1;
  }

  // The two are disjoint on purpose: an entry is either gone or kept as a
  // label, and reporting the demoted ones inside the removed count would say a
  // book lost a contents entry it still has.
  return { source: spliceAll(source, orderEdits(edits)), removed: deadAnchors.size - demoted, demoted };
}

// ═════════════════════════════════════════════════════════════════════════════
// The package
// ═════════════════════════════════════════════════════════════════════════════

interface ManifestItem {
  el: XmlElement;
  href: string;
  mediaType: string;
  properties: string;
}

function manifestItems(opfSource: string): ManifestItem[] {
  const root = parseXml(opfSource, 'xml');
  const out: ManifestItem[] = [];
  for (const el of findElements(root, 'item')) {
    const href = el.attrs.get('href');
    if (href === undefined) continue;
    out.push({
      el,
      href,
      mediaType: el.attrs.get('media-type') ?? '',
      properties: el.attrs.get('properties') ?? '',
    });
  }
  return out;
}

/** Whether the package says which image is the cover. */
function declaresCover(opfSource: string): boolean {
  const root = parseXml(opfSource, 'xml');
  for (const item of manifestItems(opfSource)) {
    if (item.properties.split(/\s+/).includes('cover-image')) return true;
  }
  // The EPUB 2 spelling, which reading systems still honour and which a book
  // that came through a conversion tool may carry instead.
  for (const meta of findElements(root, 'meta')) {
    if (meta.attrs.get('name') === 'cover') return true;
  }
  return false;
}

/** Every archive path a document's markup points at, resolved. */
const REFERENCING_ATTRIBUTES = ['src', 'href', 'xlink:href', 'poster'] as const;

function referencesOf(baseDir: string, root: XmlElement, into: Set<string>): void {
  for (const el of elements(root)) {
    for (const name of REFERENCING_ATTRIBUTES) {
      const value = el.attrs.get(name);
      if (value === undefined || value === '' || value.startsWith('#')) continue;
      // An absolute URL points out of the container, so it names no member.
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
      into.add(resolveHref(baseDir, value));
    }
  }
}

/** `url(…)` in a stylesheet. A background image is a reference like any other. */
const CSS_URL = /url\(\s*['"]?([^'")]+)/gi;

function cssReferences(baseDir: string, css: string, into: Set<string>): void {
  for (const match of css.matchAll(CSS_URL)) {
    const value = match[1].trim();
    if (value === '' || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    into.add(resolveHref(baseDir, value));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The run
// ═════════════════════════════════════════════════════════════════════════════

export interface FinalOptions {
  /** An EPUB file, or the directory one was unpacked into. Never written to. */
  epubPath: string;
  outPath: string;
  log: (message: string) => void;
}

export async function epubFinal(opts: FinalOptions): Promise<FinalReport> {
  const members = readEpubInput(opts.epubPath);
  const book = bookFromMembers(members, FINAL_NEEDS_STAMPS);

  // ── what each document loses ───────────────────────────────────────────────

  const plans = new Map<string, DocPlan>();
  for (const doc of book.documents) plans.set(doc.path, planCuts(doc.path, doc.source));

  /*
   * The references counted BEFORE and AFTER, over the whole book.
   *
   * Both numbers are needed for every rule here, and neither can be derived
   * from the other: a note is dropped when it HAD a reference and has none now,
   * and a note that never had one is left alone. Counting only what survives
   * would make those two cases indistinguishable — the same argument as the
   * contents entry that pointed nowhere before the run.
   */
  const refsBefore = new Map<string, number>();
  const refsAfter = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const plan of plans.values()) {
    for (const el of plan.all) {
      if (!isNoteref(el)) continue;
      const key = targetKey(plan.dir, plan.path, el.attrs.get('href') ?? '');
      if (key === null) continue;
      bump(refsBefore, key);
      if (!plan.removed.has(el)) bump(refsAfter, key);
    }
  }

  const rewritten = new Map<string, string>();
  const report: FinalReport = {
    outPath: opts.outPath,
    documents: book.documents.length,
    cuts: 0,
    notesDropped: 0,
    noteSectionsDropped: 0,
    noterefsDemoted: 0,
    navRemoved: 0,
    navDemoted: 0,
    imagesDropped: [],
    pagesRehomed: [],
    pagesLost: [],
    noterefs: 0,
    unlinkedMarkers: 0,
    notes: 0,
    unreferencedNotes: 0,
    cover: declaresCover(book.opfSource),
  };

  const referencedBefore = new Set<string>();
  const referencedAfter = new Set<string>();

  for (const plan of plans.values()) {
    referencesOf(plan.dir, plan.root, referencedBefore);
    const { source, counts } = tidyDocument(plan, refsBefore, refsAfter);
    report.cuts += plan.cuts;
    report.notesDropped += counts.notesDropped;
    report.noteSectionsDropped += counts.noteSectionsDropped;
    report.noterefsDemoted += counts.noterefsDemoted;
    report.pagesRehomed.push(...counts.pagesRehomed);
    report.pagesLost.push(...counts.pagesLost);
    if (source !== plan.source) rewritten.set(plan.path, source);
  }

  // ── the contents ───────────────────────────────────────────────────────────

  const emptyDocuments = new Set<string>();
  for (const plan of plans.values()) {
    if (plan.stampedBefore === 0) continue;
    const alive = plan.all.some((el) => el.attrs.has('data-bf-cat') && !plan.removed.has(el));
    if (!alive) emptyDocuments.add(plan.path);
  }

  const nav = tidyNav(book, plans, emptyDocuments);
  if (nav !== null) {
    report.navRemoved = nav.removed;
    report.navDemoted = nav.demoted;
    if (nav.source !== book.navSource) rewritten.set(book.navPath!, nav.source);
  }

  // ── the integrity of what was written ──────────────────────────────────────

  /*
   * Counted off the FINISHED documents rather than off the plans, at the cost
   * of one more parse each. The report is a claim about the file that is about
   * to be written, and a number derived from the tree before the edits would be
   * a claim about a book that never existed.
   */
  const noterefTargets = new Set<string>();
  const notes: { key: string }[] = [];
  for (const plan of plans.values()) {
    const finalSource = rewritten.get(plan.path) ?? plan.source;
    const root = parseXml(finalSource, 'xhtml');
    referencesOf(plan.dir, root, referencedAfter);
    for (const el of elements(root)) {
      if (isNoteref(el)) {
        report.noterefs += 1;
        const key = targetKey(plan.dir, plan.path, el.attrs.get('href') ?? '');
        if (key !== null) noterefTargets.add(key);
        continue;
      }
      if (isNote(el)) {
        report.notes += 1;
        const id = el.attrs.get('id');
        if (id !== undefined) notes.push({ key: `${plan.path}#${id}` });
        continue;
      }
      /*
       * A reference number the emitter could not match stayed a plain `<sup>`
       * in the prose. Told apart from a note's own leading number by its
       * ancestors: inside an `<a>` it is a working link, and inside an
       * `<aside>` it is the note's own number rather than a reference to one.
       */
      if (el.tag === 'sup') {
        let inside = false;
        for (let p = el.parent; p !== null; p = p.parent) {
          if (p.tag === 'a' || p.tag === 'aside') { inside = true; break; }
        }
        if (!inside) report.unlinkedMarkers += 1;
      }
    }
  }
  report.unreferencedNotes = notes.filter((n) => !noterefTargets.has(n.key)).length;

  if (nav !== null) {
    referencesOf(directoryOf(book.navPath!), parseXml(rewritten.get(book.navPath!) ?? nav.source, 'xhtml'), referencedAfter);
  }
  for (const member of members) {
    if (!member.path.toLowerCase().endsWith('.css')) continue;
    cssReferences(directoryOf(member.path), member.text(), referencedBefore);
    cssReferences(directoryOf(member.path), member.text(), referencedAfter);
  }

  // ── the images nothing points at any more ──────────────────────────────────

  /*
   * An image is dropped only when the book USED to point at it and no longer
   * does — the same discipline as the contents entry that pointed nowhere. An
   * image no `<figure>` ever named may be a cover a later version of this
   * program will declare, or a plate somebody means to place; it was dead
   * weight before this run and dropping it would be a decision this command was
   * not asked to make. A declared cover is never dropped whatever the documents
   * say, because a cover is referenced by the package rather than by prose.
   */
  const opfDir = directoryOf(book.opfPath);
  const droppedPaths = new Set<string>();
  const opfEdits: Edit[] = [];
  for (const item of manifestItems(book.opfSource)) {
    if (!item.mediaType.toLowerCase().startsWith('image/')) continue;
    if (item.properties.split(/\s+/).includes('cover-image')) continue;
    const target = resolveHref(opfDir, item.href);
    if (!referencedBefore.has(target) || referencedAfter.has(target)) continue;
    droppedPaths.add(target);
    opfEdits.push(removalRange(book.opfSource, item.el));
  }
  if (opfEdits.length > 0) {
    report.imagesDropped = [...droppedPaths].sort();
    rewritten.set(book.opfPath, spliceAll(book.opfSource, orderEdits(opfEdits)));
  }

  // ── the file ───────────────────────────────────────────────────────────────

  /*
   * `mimetype` first, because the OCF spec says a reader must be able to
   * identify an EPUB at byte offset 30 without parsing anything. It already is
   * first in every book foundry writes; moving it costs nothing when it is and
   * saves the edition when the input came back from a tool that reordered it.
   */
  const ordered = [
    ...members.filter((m) => m.path === 'mimetype'),
    ...members.filter((m) => m.path !== 'mimetype'),
  ];
  const entries: ZipEntry[] = [];
  for (const member of ordered) {
    if (droppedPaths.has(member.path)) continue;
    const edited = rewritten.get(member.path);
    if (edited !== undefined) { entries.push(zipText(member.path, edited)); continue; }
    // Untouched: the bytes, the method and the checksum it arrived with, so the
    // only entries that differ from the input are the ones a cut required.
    entries.push({
      path: member.path,
      data: member.raw,
      method: member.method === 8 ? 8 : 0,
      crc: member.crc,
      uncompressedSize: member.uncompressedSize,
    });
  }

  await Bun.write(opts.outPath, writeZip(entries));
  opts.log(
    `epub-final: ${entries.length} members written, ${rewritten.size} edited, `
    + `${members.length - entries.length} dropped`,
  );
  return report;
}
