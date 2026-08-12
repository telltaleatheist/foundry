/**
 * epub-reader — unpack one of OUR EPUBs and say what is in it.
 *
 * This is deliberately not a general EPUB library. Foundry WROTE these books
 * (src/vlm/epub.ts), so their shape is known and small: EPUB3, one XHTML per
 * chapter, a nav document, a single stylesheet, `data-bf-page`/`data-bf-cat`
 * attributes on the blocks. Everything here is written against that shape and
 * FAILS LOUDLY on anything else rather than degrading into half a book.
 *
 * ── Why a ZIP reader by hand ─────────────────────────────────────────────────
 *
 * Three routes were on the table and two were rejected:
 *
 *   `System32\tar.exe` (what env-downloader pins for the environment archives)
 *   does read ZIP — bsdtar handles the format — but it is a process spawn per
 *   book, it is Windows-only in that pinned form, and it would make opening a
 *   400 KB file depend on an external program's exit code. The environments are
 *   five gigabytes and earn their spawn; a book does not.
 *
 *   A dependency (adm-zip, yauzl) buys nothing here: the app has no zip
 *   dependency today, and this is ~120 lines of a format that has not changed
 *   since 1993.
 *
 *   So: the central directory is parsed here, and `zlib.inflateRawSync` — which
 *   is in Node — handles the one compressed method ZIP actually uses. Foundry's
 *   own writer (src/export/zip.ts) is store-only, so our books take the STORED
 *   path and never inflate at all; DEFLATE is supported anyway because an EPUB
 *   that came back through some other tool is still an EPUB.
 *
 * ── Why unpack to disk at all ────────────────────────────────────────────────
 *
 * Because the chapters are served to an <iframe> through `foundry-file://`
 * (electron/main.ts), and an iframe resolves `style.css` and `img/plate-3.png`
 * RELATIVELY. Serving out of an in-memory map would work too, but a directory
 * on disk is the thing the protocol handler already knows how to stream and the
 * thing an OS file cache already knows how to keep.
 *
 * The temp directory is removed when the tab closes and on quit. Both, because
 * either one alone leaves books behind: a tab that is never closed, or an app
 * that is killed.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { app } from 'electron';

import { packEpub, writeAtomically } from './epub-writer';
import { rememberRecent } from './recents';
import { contentKey, isManaged, slugify, workspaceDir } from './workspace';
import type { EpubBook, EpubChapter } from '../shared/types';

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP
// ─────────────────────────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** The largest a ZIP comment may be, so the largest distance back the EOCD hides. */
const MAX_COMMENT = 0xffff;

interface ZipMember {
  name: string;
  data: Buffer;
}

/**
 * Every member of a ZIP, read through its CENTRAL DIRECTORY.
 *
 * The central directory and not a walk of the local headers, because the local
 * header's sizes are allowed to be zero with the real ones in a trailing data
 * descriptor — a walker that trusted them would read past the end of the first
 * entry and never recover. The central directory always carries the truth.
 */
function readZip(archive: Buffer, label: string): ZipMember[] {
  const eocd = findEocd(archive, label);
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);

  const members: ZipMember[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new EpubError(
        `${label} is not a ZIP this app can read: its central directory stops after `
        + `${index} of ${count} entries.`,
      );
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    // A directory entry, which a ZIP records as a zero-length name ending in /.
    if (name.endsWith('/')) continue;

    if (archive.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new EpubError(`${label} names an entry "${name}" whose local header is not where the directory says.`);
    }
    // The LOCAL header's own name/extra lengths, not the central one's: the two
    // are allowed to differ in the extra field, and this is the offset arithmetic
    // that a lot of hand-rolled readers get wrong.
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);

    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else {
      // Never paraphrased into "unsupported archive": the method number is the
      // thing somebody would look up.
      throw new EpubError(
        `${label} stores "${name}" with ZIP compression method ${method}. `
        + 'Only stored (0) and deflate (8) are implemented.',
      );
    }

    // The declared size against the delivered one. A mismatch here is the
    // signature of a truncated download, and catching it now names the archive
    // rather than letting a half-written chapter reach the viewer as blank.
    if (uncompressedSize !== data.length) {
      throw new EpubError(
        `${label} declares "${name}" as ${uncompressedSize} bytes but delivers ${data.length}.`,
      );
    }
    members.push({ name, data });
  }
  return members;
}

/** The end-of-central-directory record, searched backwards from the tail. */
function findEocd(archive: Buffer, label: string): number {
  const earliest = Math.max(0, archive.length - MAX_COMMENT - 22);
  for (let at = archive.length - 22; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) === SIG_EOCD) return at;
  }
  throw new EpubError(
    `${label} has no ZIP end-of-central-directory record, so it is not an EPUB `
    + '(an EPUB is a ZIP). It may have been truncated in transit.',
  );
}

/**
 * Refuse a member name that would escape the directory it is unpacked into.
 *
 * "Zip slip": an archive is free to name `../../../../etc/passwd`, and the
 * unpacker that joins it onto a destination writes exactly there. Ours never
 * would, but "ours never would" is not a check, and the user can hand this
 * function any file they like.
 */
function safeMemberPath(root: string, name: string): string {
  if (name.includes('\\')) {
    throw new EpubError(`This EPUB names an entry with a backslash in it ("${name}"), which ZIP does not permit.`);
  }
  const resolved = path.resolve(root, name);
  const inside = path.relative(root, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new EpubError(`This EPUB names an entry outside itself ("${name}"). Refusing to unpack it.`);
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// The OPF, the nav, and the spine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed with regular expressions, on purpose and within a known blast radius.
 *
 * The app has no XML parser and is not gaining one to read four elements out of
 * a file it wrote itself. Every one of these reads is against markup emitted by
 * src/vlm/epub.ts — fixed attribute order, no namespace prefixes on the elements
 * that matter, no CDATA, no comments. Anything that does not match produces a
 * NAMED failure below rather than an empty list, which is the difference between
 * "this is not a foundry EPUB" and "this book has no chapters".
 */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)
    ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return match?.[1] ?? null;
}

/**
 * Tags out, entities in, whitespace collapsed.
 *
 * The collapse is not cosmetic: foundry's nav labels carry the chapter heading
 * verbatim, and a heading that was two lines in the book arrives with a newline
 * and an em-rule in the middle of it. In a one-line sidebar button that renders
 * as a label that has been cut off for no visible reason.
 */
function plainText(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The inverse, for text this app WRITES into a book (a renamed heading). */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A literal string on its way into a RegExp source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `OEBPS/ch001.xhtml` + `../img/a.png` -> `img/a.png`. Forward slashes throughout. */
function joinHref(base: string, href: string): string {
  const stack = base.split('/').slice(0, -1);
  for (const part of href.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

interface ManifestItem {
  id: string;
  /** Relative to the OPF's own directory, as written. */
  href: string;
  properties: string;
}

/**
 * One entry of the nav's table of contents, in nav order.
 *
 * `fragment` is kept: a fragmentless entry names a chapter DOCUMENT, and a
 * fragment entry names a section header inside one (`c0003.xhtml#sh2` — what
 * the engine emits for the h2s it anchored). The sidebar nests the second
 * kind one level under the first.
 */
interface NavEntry {
  /** The target document, nav-relative href resolved to an OPF-rooted path. */
  file: string;
  fragment: string | null;
  label: string;
  depth: number;
}

/**
 * The nav document's table of contents, in order.
 *
 * Depth comes from counting `<ol>` nesting, which is exactly how EPUB3 expresses
 * a part containing chapters and exactly what src/vlm/epub.ts's `renderNav`
 * emits. Only the `epub:type="toc"` nav is read — the landmarks nav is hidden
 * and would otherwise contribute a phantom "Beginning" row.
 */
function readNavEntries(xhtml: string, navHref: string): NavEntry[] {
  const entries: NavEntry[] = [];
  const toc = /<nav\b[^>]*epub:type\s*=\s*"toc"[^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml);
  if (!toc?.[1]) return entries;

  let depth = 0;
  const tokens = toc[1].matchAll(/<(\/?)(ol|a)\b([^>]*)>([\s\S]*?)(?=<)/gi);
  for (const token of tokens) {
    const closing = token[1] === '/';
    const tag = (token[2] ?? '').toLowerCase();
    if (tag === 'ol') {
      depth += closing ? -1 : 1;
      continue;
    }
    if (closing) continue;
    const href = attribute(token[3] ?? '', 'href');
    if (href === null) continue;
    const label = plainText(token[4] ?? '');
    if (label.length === 0) continue;
    // The nav's hrefs are relative to the NAV, which lives beside the OPF here,
    // but joining rather than assuming costs nothing and survives a book whose
    // nav is in a subdirectory.
    const [filePart, fragmentPart] = href.split('#');
    entries.push({
      file: joinHref(navHref, filePart ?? href),
      fragment: fragmentPart && fragmentPart.length > 0 ? fragmentPart : null,
      label,
      depth: Math.max(0, depth - 1),
    });
  }
  return entries;
}

/** The `<title>` of an XHTML document, for a spine entry the nav never names. */
function documentTitle(xhtml: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xhtml);
  const text = match?.[1] === undefined ? '' : plainText(match[1]);
  return text.length > 0 ? text : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Open, and eventually close
// ─────────────────────────────────────────────────────────────────────────────

interface Unpacked {
  id: string;
  root: string;
  /** The .epub this came out of. Never written unless it IS the workspace copy. */
  source: string;
  /** True when `source` already lives in the workspace — a conversion's output. */
  managed: boolean;
  /**
   * Where the editor's write-through repacks to.
   *
   * For a managed book that is `source` itself. For a book opened from the
   * user's own disk it starts NULL and a workspace copy is created on the first
   * edit — the flush must never rewrite a file the user did not ask this app to
   * write. Their original is only ever written by an explicit Save to it.
   */
  writeTarget: string | null;
  /**
   * The nav document's path inside the book, when the manifest names one.
   * Renaming a chapter has to rewrite its nav label — the nav is the TOC's
   * truth — and this is where the nav is.
   */
  nav: string | null;
  /**
   * Every file this unpack produced, by its forward-slashed relative path, IN
   * THE ORDER THE ARCHIVE HELD THEM.
   *
   * An ALLOW-LIST, the same decision main.ts makes for `foundry-file://open`:
   * the protocol handler answers a request only for a path that is in here. A
   * "is it under the temp root" test would have to stay correct against symlinks
   * and `..` forever; a set of the files we ourselves wrote cannot be wrong.
   *
   * The ORDER is load-bearing on the way back out: repacking preserves it, so a
   * book saved without edits differs from the one that was opened only in its
   * compression, and `mimetype` — which the reader put first — stays first.
   */
  files: string[];
}

const unpacked = new Map<string, Unpacked>();

/** The absolute file for one member of one open book, or null. */
export function resolveEpubMember(id: string, memberPath: string): string | null {
  const book = unpacked.get(id);
  if (!book) return null;
  if (!book.files.includes(memberPath)) return null;
  return path.join(book.root, ...memberPath.split('/'));
}

/**
 * One member's text, for the HTML editor.
 *
 * Read off DISK rather than out of a cache of the original archive, because the
 * unpacked directory is the working copy: an edit made a minute ago is in the
 * file, and a reader that answered from the archive would hand the editor back
 * the text the user had already changed.
 */
export async function readEpubMember(id: string, memberPath: string): Promise<string> {
  const resolved = resolveEpubMember(id, memberPath);
  if (resolved === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  return fs.promises.readFile(resolved, 'utf8');
}

/**
 * Replace one member's text and REPACK the workspace copy.
 *
 * The repack is the point. Without it the edit lives only in a temp directory
 * that is deleted when the tab closes, and the unsaved-tab warning — which
 * promises the book is still in the workspace — would be a lie the moment
 * anybody typed. Writing through means the workspace copy is always the newest
 * version of the book, and "modified" only ever means "the copy YOU chose to
 * keep is older than this one".
 *
 * THE WORKSPACE COPY, never the user's own file. A conversion's output already
 * is one; a book opened from the user's disk gets one created here on the first
 * edit, keyed off the original's content the way a conversion is keyed — the
 * debounced flush behind this fires 700 ms after a keystroke, and a keystroke
 * is not consent to rewrite a file the user owns. Their file changes only on an
 * explicit Save to it.
 *
 * Returns the bytes written, so the caller can say how big the book now is
 * without reading it back.
 */
export async function writeEpubMember(
  id: string,
  memberPath: string,
  text: string,
): Promise<number> {
  const book = unpacked.get(id);
  const resolved = resolveEpubMember(id, memberPath);
  if (!book || resolved === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  await fs.promises.writeFile(resolved, text, 'utf8');
  return flushToWorkspace(book);
}

/**
 * Repack the working copy to the workspace, creating the copy the first time.
 *
 * The shared tail of every edit path — the chapter editor's flush and a
 * heading rename both end here. One place owns the lazy-copy rule so the two
 * paths cannot drift: managed books repack onto themselves, unmanaged ones get
 * a workspace copy keyed off the ORIGINAL's content on their first edit, and
 * the copy is put in recents the moment it exists so Home can offer it back.
 */
async function flushToWorkspace(book: Unpacked): Promise<number> {
  const created = book.writeTarget === null;
  if (book.writeTarget === null) {
    const key = `${slugify(path.basename(book.source))}-${await contentKey(book.source)}`;
    await fs.promises.mkdir(workspaceDir(), { recursive: true });
    book.writeTarget = path.join(workspaceDir(), `${key}.epub`);
  }
  const bytes = await repackEpub(book.id, book.writeTarget);
  if (created) {
    // A copy that just came into being has to be findable: Home's list is the
    // only door back to it once the tab closes. Recorded AFTER the repack so
    // the row never names a file that does not exist yet.
    rememberRecent(book.writeTarget, 'epub', path.basename(book.writeTarget), true);
  }
  return bytes;
}

/**
 * Rename a TOC entry: the nav label, and the heading it stands for.
 *
 * `entryHref` is a sidebar row's href — `text/c0003.xhtml` for a chapter,
 * `text/c0003.xhtml#sh2` for a section header inside one. What changes:
 *
 *   FRAGMENT entry — precise by construction: the `<h_ id="sh2">` heading in
 *   that document gets the new inner text, and so does the nav anchor that
 *   points at `#sh2`.
 *
 *   CHAPTER entry — the nav anchor ALWAYS changes: the nav is the TOC's truth
 *   and renaming the TOC row is exactly what was asked. The chapter document's
 *   own first heading and its `<title>` change ONLY when their text equals the
 *   old nav label exactly — when the classifier composed a label the heading
 *   never carried ("Part II — The Road to War" over a page that says "II"),
 *   the content is not touched: the user renamed the table of contents, not
 *   the words on the page.
 *
 * Attributes are never rewritten — data-bf-*, ids, classes and the pagebreak
 * span a heading opens with all survive; only inner TEXT changes, XML-escaped.
 * The writes go through the same workspace flush as every other edit: a
 * managed book repacks onto itself, an unmanaged one gets its lazy workspace
 * copy and the user's original file is not written.
 *
 * Throws when nothing in the book matches the entry — a rename that changed
 * nothing must not report success and mark the tab modified.
 */
export async function renameEpubHeading(
  id: string,
  entryHref: string,
  newLabel: string,
): Promise<void> {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');
  const label = newLabel.trim();
  if (label.length === 0) throw new EpubError('A heading cannot be renamed to nothing.');
  const escaped = escapeXml(label);

  const [file, fragment = null] = entryHref.split('#') as [string, string?];
  const member = resolveEpubMember(id, file);
  if (member === null) {
    throw new EpubError(`"${file}" is not part of a book this app has open.`);
  }

  let changed = false;

  // ── The nav, first: it holds the OLD label the content rule needs. ───────
  let oldLabel: string | null = null;
  const navFile = book.nav === null ? null : resolveEpubMember(id, book.nav);
  if (navFile !== null && book.nav !== null) {
    const navText = await fs.promises.readFile(navFile, 'utf8');
    const renamed = renameNavAnchor(navText, book.nav, file, fragment, escaped);
    oldLabel = renamed.oldLabel;
    if (renamed.changed) {
      await fs.promises.writeFile(navFile, renamed.text, 'utf8');
      changed = true;
    }
  }

  // ── The content. ─────────────────────────────────────────────────────────
  const markup = await fs.promises.readFile(member, 'utf8');
  let edited = markup;
  if (fragment !== null) {
    edited = renameHeadingById(markup, fragment, escaped);
  } else {
    // No nav (a foreign book): the sidebar label came from the document's own
    // <title>, so that is the "old label" the equality rule compares against.
    const previous = oldLabel ?? documentTitle(markup);
    if (previous !== null) {
      edited = renameChapterHeading(markup, previous, escaped);
    }
  }
  if (edited !== markup) {
    await fs.promises.writeFile(member, edited, 'utf8');
    changed = true;
  }

  if (!changed) {
    throw new EpubError(
      'Nothing in the book carries that label — the nav names no such entry and no heading matched.',
    );
  }
  await flushToWorkspace(book);
}

/**
 * Replace the text of the toc anchors that point at (file, fragment).
 *
 * Scoped to the `epub:type="toc"` nav element: the landmarks nav also points
 * at chapter files, but its labels ("Beginning") are semantics, not names,
 * and a rename must not overwrite them.
 */
function renameNavAnchor(
  navText: string,
  navHref: string,
  file: string,
  fragment: string | null,
  escaped: string,
): { text: string; oldLabel: string | null; changed: boolean } {
  const toc = /(<nav\b[^>]*epub:type\s*=\s*"toc"[^>]*>)([\s\S]*?)(<\/nav>)/i.exec(navText);
  if (!toc || toc.index === undefined) return { text: navText, oldLabel: null, changed: false };

  let oldLabel: string | null = null;
  let changed = false;
  const body = (toc[2] ?? '').replace(
    /(<a\b[^>]*>)([\s\S]*?)(<\/a\s*>)/gi,
    (whole, open: string, inner: string, close: string) => {
      const href = attribute(open, 'href');
      if (href === null) return whole;
      const [filePart, fragmentPart] = href.split('#');
      const targetFile = joinHref(navHref, filePart ?? href);
      const targetFragment = fragmentPart && fragmentPart.length > 0 ? fragmentPart : null;
      if (targetFile !== file || targetFragment !== fragment) return whole;
      oldLabel ??= plainText(inner);
      changed = true;
      return `${open}${escaped}${close}`;
    },
  );
  if (!changed) return { text: navText, oldLabel: null, changed: false };
  const start = toc.index + (toc[1] ?? '').length;
  const end = toc.index + toc[0].length - (toc[3] ?? '').length;
  return { text: navText.slice(0, start) + body + navText.slice(end), oldLabel, changed };
}

/**
 * The leading pagebreak span(s) of a heading's inner markup, kept on a rename.
 *
 * The engine puts the page marker INSIDE the first element of its page, which
 * is often a heading — a rename that replaced the whole inner text would
 * silently delete the page anchor.
 */
const LEADING_SPANS = /^(?:\s*<span\b[^>]*>\s*<\/span>)*\s*/;

/** Rewrite the inner text of the heading carrying `id="<fragment>"`. */
function renameHeadingById(markup: string, fragment: string, escaped: string): string {
  const pattern = new RegExp(
    `(<h([1-6])\\b[^>]*\\bid\\s*=\\s*"${escapeRegExp(fragment)}"[^>]*>)([\\s\\S]*?)(</h\\2\\s*>)`,
    'i',
  );
  return markup.replace(pattern, (_whole, open: string, _level, inner: string, close: string) => {
    const lead = LEADING_SPANS.exec(inner)?.[0] ?? '';
    return `${open}${lead}${escaped}${close}`;
  });
}

/**
 * Rewrite the document's FIRST heading and its <title>, each only when its
 * text equals `oldLabel` — see renameEpubHeading's chapter rule.
 */
function renameChapterHeading(markup: string, oldLabel: string, escaped: string): string {
  let out = markup.replace(
    /(<h([1-6])\b[^>]*>)([\s\S]*?)(<\/h\2\s*>)/i,
    (whole, open: string, _level, inner: string, close: string) => {
      if (plainText(inner) !== oldLabel) return whole;
      const lead = LEADING_SPANS.exec(inner)?.[0] ?? '';
      return `${open}${lead}${escaped}${close}`;
    },
  );
  out = out.replace(
    /(<title[^>]*>)([\s\S]*?)(<\/title>)/i,
    (whole, open: string, inner: string, close: string) =>
      (plainText(inner) === oldLabel ? `${open}${escaped}${close}` : whole),
  );
  return out;
}

/**
 * Pack the working copy into a .epub at `destination`.
 *
 * Used for both halves of saving: the write-through to the workspace copy above,
 * and Save/Save As to wherever the user finally names.
 */
export async function repackEpub(id: string, destination: string): Promise<number> {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');
  const bytes = await packEpub(book.root, book.files);
  await writeAtomically(destination, bytes);
  return bytes.length;
}

/**
 * Unpack a book and describe it.
 *
 * The whole file is read into memory first. A foundry EPUB is text plus whatever
 * plates the model kept — a few megabytes — and the central directory is at the
 * END of a ZIP, so a streaming reader would seek to the tail and back anyway.
 */
export async function openEpub(filePath: string): Promise<EpubBook> {
  const resolved = path.resolve(filePath);
  const label = path.basename(resolved);
  const archive = await fs.promises.readFile(resolved);
  const members = readZip(archive, label);

  const byName = new Map<string, Buffer>();
  for (const member of members) byName.set(member.name, member.data);

  const text = (name: string): string | null => {
    const data = byName.get(name);
    return data === undefined ? null : data.toString('utf8');
  };

  const container = text('META-INF/container.xml');
  if (container === null) {
    throw new EpubError(`${label} has no META-INF/container.xml, so it is not an EPUB.`);
  }
  const rootfile = /<rootfile\b([^>]*)>/i.exec(container);
  const opfHref = rootfile?.[1] === undefined ? null : attribute(rootfile[1], 'full-path');
  if (opfHref === null) {
    throw new EpubError(`${label}'s META-INF/container.xml names no rootfile, so nothing says where the book is.`);
  }
  const opf = text(opfHref);
  if (opf === null) {
    throw new EpubError(`${label} points at "${opfHref}" as its package document, and there is no such entry in it.`);
  }

  const manifest = new Map<string, ManifestItem>();
  for (const match of opf.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const tag = match[1] ?? '';
    const id = attribute(tag, 'id');
    const href = attribute(tag, 'href');
    if (id === null || href === null) continue;
    manifest.set(id, { id, href: joinHref(opfHref, decodeEntities(href)), properties: attribute(tag, 'properties') ?? '' });
  }

  const spine: ManifestItem[] = [];
  for (const match of opf.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const idref = attribute(match[1] ?? '', 'idref');
    const item = idref === null ? undefined : manifest.get(idref);
    if (item) spine.push(item);
  }
  if (spine.length === 0) {
    throw new EpubError(`${label}'s package document lists no spine, so the book has no reading order.`);
  }

  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  const navText = navItem ? text(navItem.href) : null;
  const navEntries = navItem && navText !== null ? readNavEntries(navText, navItem.href) : [];
  const entriesByFile = new Map<string, NavEntry[]>();
  for (const entry of navEntries) {
    const list = entriesByFile.get(entry.file);
    if (list) list.push(entry);
    else entriesByFile.set(entry.file, [entry]);
  }

  // ── On disk ──────────────────────────────────────────────────────────────
  const id = crypto.randomUUID();
  const root = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'foundry-epub-'));
  const files: string[] = [];
  for (const member of members) {
    const destination = safeMemberPath(root, member.name);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, member.data);
    files.push(member.name);
  }
  // Managed is measured HERE, in main, because it decides where edits may land
  // — a fact the renderer consumes but never gets to assert.
  const managed = isManaged(resolved);
  unpacked.set(id, {
    id,
    root,
    source: resolved,
    managed,
    writeTarget: managed ? resolved : null,
    nav: navItem?.href ?? null,
    files,
  });

  // ── What the sidebar shows ───────────────────────────────────────────────
  // The SPINE is the backbone, because it is complete and in reading order; the
  // nav supplies the label and the indent where it names that document. A
  // nav-driven list would silently drop a chapter the table of contents forgot.
  // The nav's FRAGMENT entries — the section headers the engine anchored — nest
  // one level under their spine item; a book from before that engine change has
  // none and renders exactly as it always did.
  const chapters: EpubChapter[] = spine.flatMap((item) => {
    const entries = entriesByFile.get(item.href) ?? [];
    const named = entries.find((entry) => entry.fragment === null);
    const fromDocument = named ? null : documentTitle(text(item.href) ?? '');
    const depth = named?.depth ?? 0;
    const rows: EpubChapter[] = [{
      href: item.href,
      label: named?.label ?? fromDocument ?? item.href.split('/').pop() ?? item.href,
      depth,
      url: memberUrl(id, item.href),
    }];
    for (const entry of entries) {
      if (entry.fragment === null) continue;
      rows.push({
        href: `${item.href}#${entry.fragment}`,
        label: entry.label,
        depth: depth + 1,
        url: `${memberUrl(id, item.href)}#${encodeURIComponent(entry.fragment)}`,
      });
    }
    return rows;
  });

  const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  const title = titleMatch?.[1] === undefined ? null : plainText(titleMatch[1]);
  const authorMatch = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf);
  const author = authorMatch?.[1] === undefined ? null : plainText(authorMatch[1]);

  return {
    id,
    filePath: resolved,
    managed,
    title: title !== null && title.length > 0 ? title : label,
    author: author !== null && author.length > 0 ? author : null,
    chapters,
  };
}

/** The `foundry-file://` URL one member of one open book is served at. */
export function memberUrl(id: string, memberPath: string): string {
  const encoded = memberPath.split('/').map(encodeURIComponent).join('/');
  return `foundry-file://epub/${id}/${encoded}`;
}

/**
 * Forget a book and delete what it unpacked.
 *
 * The registry entry goes FIRST, so the protocol stops answering for it even if
 * the directory removal loses a race with Windows still holding the iframe's
 * last read. A directory that survives is a few hundred kilobytes in %TEMP%; a
 * protocol that keeps serving a book the app believes it closed is a bug.
 */
export async function closeEpub(id: string): Promise<void> {
  const book = unpacked.get(id);
  if (!book) return;
  unpacked.delete(id);
  await fs.promises.rm(book.root, { recursive: true, force: true }).catch(() => {
    // Best effort, deliberately silent: this runs while a tab is closing, and a
    // failure to tidy %TEMP% is not a thing to interrupt that with. The OS
    // clears the directory eventually; `closeAllEpubs` tries again on quit.
  });
}

/** Quit. Everything still unpacked goes. */
export function closeAllEpubs(): void {
  for (const book of unpacked.values()) {
    try {
      fs.rmSync(book.root, { recursive: true, force: true });
    } catch {
      /* the OS owns %TEMP%; it will get there */
    }
  }
  unpacked.clear();
}
