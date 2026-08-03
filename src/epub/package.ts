/**
 * package — what an EPUB says its own documents are, and in what order.
 *
 * The spine is the reading order, and reading order is what the footnotes stage
 * needs: `planFootnotes` applies each deletion to the first remaining occurrence
 * of its anchor, so a repeated anchor only lands correctly if the texts arrive
 * in the order the book is read (see the applier's document-order note).
 *
 * Nothing here guesses. The container names the package, the package names the
 * manifest, the manifest names the files and the spine names the order — and a
 * link that leads nowhere is an error naming it, not a file quietly skipped. An
 * EPUB missing a spine document is a broken EPUB, and editing it would produce
 * a book with an unexplained hole in it.
 */
import { entryText, type ZipReadEntry } from './zip-read.js';
import { findElement, findElements, parseXml } from './xml.js';

export interface SpineDocument {
  /** The entry path inside the archive. */
  path: string;
  /** The manifest id, for error messages. */
  id: string;
  mediaType: string;
}

export interface EpubPackage {
  /** Archive path of the OPF. */
  opfPath: string;
  /** The XHTML documents of the spine, in reading order. */
  documents: SpineDocument[];
  /**
   * Spine items deliberately not read, and why — the EPUB3 navigation document
   * and anything in the spine that is not XHTML. A nav document is a table of
   * contents: it is a list of chapter numbers welded to chapter titles, which
   * is the exact shape of an anchor with a marker on it, and asking the model
   * about it buys nothing and risks eating the numbering.
   */
  skipped: Array<{ path: string; why: string }>;
}

export class EpubError extends Error {
  constructor(message: string) {
    super(`epub: ${message}`);
    this.name = 'EpubError';
  }
}

const XHTML_TYPES: ReadonlySet<string> = new Set(['application/xhtml+xml', 'text/html']);

/** Resolve an OPF-relative href against the OPF's own directory, percent-decoded. */
export function resolveHref(opfPath: string, href: string): string {
  const raw = href.split('#')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A href with a stray `%` is not a URI; it is a filename that happens to
    // contain one, and the archive spells it exactly that way.
    decoded = raw;
  }
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const parts = (base ? `${base}/${decoded}` : decoded).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/** Read the container and the package document, and return the spine. */
export function readEpubPackage(entries: ReadonlyMap<string, ZipReadEntry>): EpubPackage {
  const container = entries.get('META-INF/container.xml');
  if (!container) {
    throw new EpubError('there is no META-INF/container.xml — this file is not an EPUB');
  }
  const containerRoot = parseXml(entryText(container), 'xml');
  const rootfile = findElement(containerRoot, 'rootfile');
  const fullPath = rootfile?.attrs.get('full-path');
  if (!fullPath) {
    throw new EpubError('META-INF/container.xml names no <rootfile full-path=…> — there is no package document');
  }
  const opfPath = resolveHref('', fullPath);
  const opfEntry = entries.get(opfPath);
  if (!opfEntry) {
    throw new EpubError(`the container points at "${opfPath}", which is not in the archive`);
  }

  const opf = parseXml(entryText(opfEntry), 'xml');
  const manifest = findElement(opf, 'manifest');
  const spine = findElement(opf, 'spine');
  if (!manifest) throw new EpubError(`${opfPath} has no <manifest>`);
  if (!spine) throw new EpubError(`${opfPath} has no <spine>`);

  const items = new Map<string, { path: string; mediaType: string; properties: string }>();
  for (const item of findElements(manifest, 'item')) {
    const id = item.attrs.get('id');
    const href = item.attrs.get('href');
    if (!id || !href) continue;
    items.set(id, {
      path: resolveHref(opfPath, href),
      mediaType: (item.attrs.get('media-type') ?? '').toLowerCase(),
      properties: item.attrs.get('properties') ?? '',
    });
  }

  const documents: SpineDocument[] = [];
  const skipped: Array<{ path: string; why: string }> = [];

  for (const ref of findElements(spine, 'itemref')) {
    const idref = ref.attrs.get('idref');
    if (!idref) throw new EpubError(`${opfPath} has an <itemref> with no idref`);
    const item = items.get(idref);
    if (!item) {
      throw new EpubError(`${opfPath}: the spine references "${idref}", which the manifest does not declare`);
    }
    if (!entries.has(item.path)) {
      throw new EpubError(`${opfPath}: the spine item "${idref}" points at "${item.path}", which is not in the archive`);
    }
    if (item.properties.split(/\s+/).includes('nav')) {
      skipped.push({ path: item.path, why: 'the EPUB3 navigation document' });
      continue;
    }
    if (!XHTML_TYPES.has(item.mediaType)) {
      skipped.push({ path: item.path, why: `media type ${item.mediaType || 'unstated'} is not XHTML` });
      continue;
    }
    documents.push({ path: item.path, id: idref, mediaType: item.mediaType });
  }

  if (documents.length === 0) {
    throw new EpubError(`${opfPath}: the spine holds no XHTML documents — there is nothing to read`);
  }
  return { opfPath, documents, skipped };
}
