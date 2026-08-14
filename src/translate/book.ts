/**
 * translate/book — finding the book inside the container, and proving it is
 * one of ours.
 *
 * An EPUB is a ZIP with a pointer chain in it: `META-INF/container.xml` names
 * the package document, the package's manifest names every file, and its spine
 * says which of them are the book and in what order. This file walks that chain
 * and nothing more. It does not build an EPUB — `packageVlmEpub` in
 * `src/vlm/epub.ts` does that, from blocks, and it is the wrong tool here for a
 * reason worth writing down: rebuilding the package from parsed values would
 * regenerate the manifest, the nav and the metadata from this program's idea of
 * them, and every field the original carried that this program does not model
 * would vanish. A translation must change the sentences and the language
 * declaration. Everything else in the container is somebody's book and is
 * carried through as bytes.
 *
 * THE CONTRACT CHECK IS THE ADMISSION RULE, and it is deliberately narrow.
 * This command replaces the text inside the categories `dots-book.ts` stamps.
 * An EPUB from a publisher has no stamps, so there would be no blocks, so the
 * run would "succeed" and write out a byte-for-byte copy of the input with a
 * different `dc:language` — a file that claims to be an English edition and is
 * entirely in German. That is the worst possible outcome and it is the one a
 * missing check produces, so the check is up front and the refusal says what
 * the book would have needed.
 */
import { decodeEntities, findElement, findElements, parseXml, type XmlElement } from '../epub/xml.js';
import { readZip, type ZipMember } from './unzip.js';

/** An EPUB this command will not translate. Always says what is missing. */
export class BookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookError';
  }
}

/** One document of the book, with the archive path it lives at. */
export interface BookDocument {
  /** Path inside the ZIP, e.g. `EPUB/text/c0001.xhtml`. */
  path: string;
  source: string;
  /** Whether this document carries foundry's stamps. */
  stamped: boolean;
}

export interface FoundryBook {
  members: ZipMember[];
  /** Path inside the ZIP of the package document. */
  opfPath: string;
  opfSource: string;
  /** Spine documents, in reading order. */
  documents: BookDocument[];
  /** The nav document, when the manifest declares one. */
  navPath: string | null;
  navSource: string | null;
}

/**
 * Resolve an href against the directory its declaring document sits in.
 *
 * Percent-decoded, because a manifest may legally write `my%20chapter.xhtml`
 * for an entry whose ZIP name has a space in it, and a lookup on the raw href
 * would miss it.
 */
export function resolveHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // A stray `%` that is not an escape. The raw form is the better guess than
    // failing the book, and if it is wrong the lookup misses and says so.
    decoded = clean;
  }
  const parts = (baseDir === '' ? [] : baseDir.split('/')).concat(decoded.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The text between an element's tags, entity-decoded is not needed here. */
function attr(el: XmlElement, name: string): string | undefined {
  return el.attrs.get(name);
}

/**
 * What the stamps are needed FOR, as the refusal says it.
 *
 * The admission rule is shared and the SENTENCE is not: `translate` needs the
 * stamps because it replaces the text inside them, and `epub-final` needs them
 * because a cut is marked on one. A refusal that names the wrong reason sends a
 * person to look at the wrong part of their book, so the caller supplies its
 * own half of the sentence and the default is the one translate has always
 * printed.
 */
const TRANSLATION_NEEDS_STAMPS = 'translation replaces text inside the categories foundry stamps';

export function readFoundryBook(bytes: Uint8Array, needs: string = TRANSLATION_NEEDS_STAMPS): FoundryBook {
  return bookFromMembers(readZip(bytes), needs);
}

/**
 * The same walk, over members somebody already has.
 *
 * `epub-final` reads a WORKING TREE — an EPUB the app keeps unpacked so that a
 * cut costs one chapter file rather than a 20 MB rezip — and there is no
 * archive to hand this function. Everything past the unzip is identical, so the
 * chain walk lives here and `readFoundryBook` is the zip-shaped door onto it.
 */
export function bookFromMembers(members: ZipMember[], needs: string = TRANSLATION_NEEDS_STAMPS): FoundryBook {
  const byPath = new Map(members.map((m) => [m.path, m] as const));

  const mimetype = byPath.get('mimetype');
  if (mimetype === undefined || mimetype.text().trim() !== 'application/epub+zip') {
    throw new BookError(
      'this archive has no `mimetype` entry saying application/epub+zip — it is a ZIP, but it is not an EPUB',
    );
  }

  const container = byPath.get('META-INF/container.xml');
  if (container === undefined) {
    throw new BookError('this EPUB has no META-INF/container.xml, so nothing says where its package document is');
  }
  const rootfile = findElement(parseXml(container.text(), 'xml'), 'rootfile');
  const opfPath = rootfile === undefined ? undefined : attr(rootfile, 'full-path');
  if (opfPath === undefined) {
    throw new BookError('META-INF/container.xml names no rootfile, so nothing says where the package document is');
  }
  const opf = byPath.get(opfPath);
  if (opf === undefined) {
    throw new BookError(`META-INF/container.xml points at "${opfPath}", and there is no such entry in the archive`);
  }

  const opfSource = opf.text();
  const opfRoot = parseXml(opfSource, 'xml');
  const opfDir = directoryOf(opfPath);

  const manifest = new Map<string, { href: string; properties: string }>();
  for (const item of findElements(opfRoot, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (id === undefined || href === undefined) continue;
    manifest.set(id, { href, properties: attr(item, 'properties') ?? '' });
  }

  const documents: BookDocument[] = [];
  for (const ref of findElements(opfRoot, 'itemref')) {
    const idref = attr(ref, 'idref');
    if (idref === undefined) continue;
    const item = manifest.get(idref);
    if (item === undefined) {
      throw new BookError(`the spine references manifest id "${idref}", which the manifest does not declare`);
    }
    const path = resolveHref(opfDir, item.href);
    const member = byPath.get(path);
    if (member === undefined) {
      throw new BookError(`the manifest declares "${path}", and there is no such entry in the archive`);
    }
    const source = member.text();
    documents.push({ path, source, stamped: source.includes('data-bf-cat') });
  }

  if (documents.length === 0) {
    throw new BookError('this EPUB has an empty spine — there is no book in it');
  }
  if (!documents.some((d) => d.stamped)) {
    throw new BookError(`not a foundry-converted book; ${needs}, and this book has none.`);
  }

  let navPath: string | null = null;
  for (const [, item] of manifest) {
    if (item.properties.split(/\s+/).includes('nav')) {
      navPath = resolveHref(opfDir, item.href);
      break;
    }
  }
  const nav = navPath === null ? undefined : byPath.get(navPath);

  return {
    members,
    opfPath,
    opfSource,
    documents,
    navPath: nav === undefined ? null : navPath,
    navSource: nav === undefined ? null : nav.text(),
  };
}

/**
 * The source range of `dc:language`'s content, so the tag can be replaced
 * without reserialising the package.
 *
 * A package with no `dc:language` is invalid EPUB, and this command is being
 * asked to state a language — so an absent element is an error rather than
 * something to insert. Inserting one would mean guessing where in the metadata
 * it belongs and what indentation the file uses, in a document this program
 * otherwise never writes.
 */
export function languageRange(opfSource: string): { start: number; end: number } {
  const root = parseXml(opfSource, 'xml');
  for (const el of findElements(root, 'language')) {
    return { start: el.innerStart, end: el.innerEnd };
  }
  throw new BookError(
    'the package document declares no dc:language. Every EPUB must, and this command sets it '
    + '— it does not invent where it goes.',
  );
}

/**
 * The nav document's `<a>` labels, as source ranges.
 *
 * Returned as ranges rather than as text because the nav is rewritten the same
 * way everything else here is: by splicing the original file, so the entries
 * this stage cannot map are untouched down to their whitespace.
 */
export interface NavLabel {
  /** The `href`, as written — document path and fragment both still in it. */
  href: string;
  /** Where the anchor's text sits in the nav source. */
  innerStart: number;
  innerEnd: number;
  /** The label as it reads now: entities decoded, whitespace collapsed. */
  text: string;
}

export function navLabels(navSource: string): NavLabel[] {
  const root = parseXml(navSource, 'xhtml');
  const out: NavLabel[] = [];
  for (const el of findElements(root, 'a')) {
    const href = attr(el, 'href');
    if (href === undefined) continue;
    // Only anchors whose content is plain text. One carrying markup is not a
    // label this stage knows how to replace, and replacing it would mean
    // deciding what happens to the markup — a decision with no right answer and
    // no way to check it. Those are left alone and counted.
    if (el.children.some((c) => c.kind !== 'text')) continue;
    out.push({
      href,
      innerStart: el.innerStart,
      innerEnd: el.innerEnd,
      text: decodeEntities(navSource.slice(el.innerStart, el.innerEnd)).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}
