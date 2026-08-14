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
 * ── The unpacked tree IS the book now ────────────────────────────────────────
 *
 * It used to be a `mkdtemp` in %TEMP% that was deleted when the tab closed, and
 * that one fact drove everything expensive here: an edit's only durability was a
 * repack, so `writeEpubMember` ended in `flushToWorkspace` and every keystroke
 * that settled rewrote the whole archive. On a 20.6 MB book that is a 20 MB
 * write per edit, and the select mode this precedes would make fifty of them in
 * a minute.
 *
 * The tree lives in the project now — `<project>/working/<tree>/`, catalogued in
 * `project.json` — and it is not deleted by anything. That inverts the cost: a
 * member write is one chapter file of a few KB, and it is also the COMMIT, so
 * there is no repack left that can fail halfway through. Reopening the book
 * does not unzip at all; it opens what is already there, edits and all.
 *
 * ZIPPING HAPPENS IN EXACTLY TWO PLACES and both are explicit: `epub:save`
 * (Save / Save As, in main.ts) and an export — today, writing the tree out where
 * the engine can read it before a translation runs (`exportWorkingCopy`). If a
 * third appears, this comment is wrong and the phase's whole point is lost.
 *
 * The MEMBER ORDER is what `project.json` had to learn to carry. It used to
 * survive only in memory, from the unzip that made the tree; a tree that
 * outlives the process must record it on disk, `mimetype` first, or a repack
 * after a restart produces an archive that some readers open and others reject.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { packEpub, writeAtomically } from './epub-writer';
import {
  holdWorkingTree,
  importDocument,
  isManaged,
  noteProjectTitle,
  readManifest,
  recordWorkingTree,
  releaseWorkingTree,
  workingTreeFor,
  workingTreeName,
} from './projects';
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
  /** `<project>/working/<tree>` — the durable working copy, never deleted. */
  root: string;
  /** The project this book belongs to. */
  projectDir: string;
  /**
   * The origin the tree was unpacked from, project-relative — always something
   * under `generated/`. Kept because it is the tree's identity in `project.json`
   * and because an export has to know which file it is bringing up to date.
   */
  entry: string;
  /**
   * The nav document's path inside the book, when the manifest names one.
   * Renaming a chapter has to rewrite its nav label — the nav is the TOC's
   * truth — and this is where the nav is.
   */
  nav: string | null;
  /**
   * Every file this book is made of, by its forward-slashed relative path, IN
   * THE ORDER THE ARCHIVE HELD THEM.
   *
   * An ALLOW-LIST, the same decision main.ts makes for the protocol handler: it
   * answers a request only for a path that is in here. A "is it under the
   * working root" test would have to stay correct against symlinks and `..`
   * forever; a set of the files we ourselves wrote cannot be wrong.
   *
   * The ORDER is load-bearing on the way back out: repacking preserves it, so a
   * book saved without edits differs from the one that was opened only in its
   * compression, and `mimetype` — which the reader put first — stays first. It
   * comes from `project.json` now rather than from this process's memory of the
   * unzip, because the tree outlives the process (see the header).
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
 * Replace one member's text. AND REPACK NOTHING.
 *
 * This function is the phase's whole point, and the deletion is the change: it
 * used to end in `flushToWorkspace`, which rezipped the entire book so that the
 * edit would survive the temp directory being deleted on close. Nothing is
 * deleted on close any more — the working tree lives in the project — so the
 * member write IS the durable commit, and a 20 MB rewrite has become a few KB.
 *
 * The user's own file is still never written. It never was: the flush targeted a
 * workspace copy precisely because a keystroke is not consent to rewrite a file
 * somebody owns. Now the working tree holds that line structurally — the only
 * thing this can write is a member of a tree inside a project.
 *
 * Returns the bytes written, so the caller can say what landed without reading
 * it back. That number is the MEMBER's now, not the book's; nothing has read a
 * book's size out of this since the write-through went away.
 */
export async function writeEpubMember(
  id: string,
  memberPath: string,
  text: string,
): Promise<number> {
  const resolved = resolveEpubMember(id, memberPath);
  if (resolved === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  await fs.promises.writeFile(resolved, text, 'utf8');
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
 * The writes land in the working tree, like every other edit, and repack
 * nothing: the user's own file is written only by an explicit Save to it.
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
 * Pack the working tree into a .epub at `destination`.
 *
 * ONE OF THE TWO PLACES A ZIP HAPPENS. Its callers are `epub:save` — Save and
 * Save As, both gated by main's grant list — and `exportWorkingCopy` below.
 * Nothing else may call it without making the header's promise false.
 */
export async function repackEpub(id: string, destination: string): Promise<number> {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');
  const bytes = await packEpub(book.root, book.files);
  await writeAtomically(destination, bytes);
  return bytes.length;
}

/**
 * Write the working tree out where the ENGINE can read it, before a job runs.
 *
 * The export half of "zipping happens in exactly two places" — and it does NOT
 * write into `generated/`, which is the record of what the model read and is
 * never written by anything. It writes a sibling in `working/`, named for the
 * book, and returns that path for the job to use as its input.
 *
 * The alternative is silent and wrong: the working tree and the origin it came
 * from drift apart the moment anybody edits, because an edit no longer repacks,
 * and the translator is a separate process handed a path. Without this it would
 * translate the book as it was before the curation — which is exactly the thing
 * the curation exists to prevent reaching the model.
 *
 * Returns the path unchanged when no open book was unpacked from it. That is the
 * common case (a translation ordered from Home) and there is nothing to export.
 */
export async function exportWorkingCopy(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  for (const book of unpacked.values()) {
    if (path.resolve(path.join(book.projectDir, ...book.entry.split('/'))) !== resolved) continue;
    const destination = path.join(book.projectDir, 'working', path.basename(resolved));
    await repackEpub(book.id, destination);
    return destination;
  }
  return resolved;
}

/** The project a currently open book belongs to — for the Save dialog's folder. */
export function projectOf(id: string): string | null {
  return unpacked.get(id)?.projectDir ?? null;
}

/**
 * Ensure this book has a working tree, and say where it is and what is in it.
 *
 * THE TREE IS NOT REBUILT WHEN IT IS ALREADY THERE. That is requirement one of
 * the project model: reopening a book opens the edits the last session made, not
 * the archive they were made against — which by then is the older document.
 *
 * The order of the three steps that create one is chosen so that every way this
 * can be interrupted leaves a state the next open can recover from:
 *
 *   1. read and parse the ZIP, which touches no disk of ours and throws by name
 *      on anything malformed, so a bad archive writes nothing at all;
 *   2. RECORD the tree in `project.json` — before it exists, deliberately. A
 *      crash here leaves a catalogue entry whose directory is missing, and the
 *      branch below simply unpacks again;
 *   3. unpack into a sibling `.unpacking-<uuid>` and rename it into place, so
 *      the directory the catalogue names is either absent or complete and never
 *      half a book.
 *
 * A directory the catalogue does NOT name is refused rather than cleared. It can
 * only be somebody's edits — from a project whose manifest was lost or hand-
 * edited — and deleting a working copy to make room for a fresh unpack is
 * exactly the data loss this whole model exists to make impossible.
 */
async function ensureWorkingTree(
  projectDir: string,
  entry: string,
  label: string,
): Promise<{ root: string; files: string[] }> {
  const recorded = await workingTreeFor(projectDir, entry);
  if (recorded !== null && await directoryExists(recorded.root)) {
    return { root: recorded.root, files: recorded.members };
  }

  const root = path.join(projectDir, 'working', workingTreeName(entry));
  if (recorded === null && await directoryExists(root)) {
    throw new EpubError(
      `${root} is a working copy that ${path.join(projectDir, 'project.json')} does not list, so `
      + 'Foundry cannot tell which book it holds or what order its files go back in. Move it aside '
      + 'to unpack this book fresh — it is not being deleted.',
    );
  }

  const archive = await fs.promises.readFile(path.join(projectDir, ...entry.split('/')));
  const members = readZip(archive, label);
  await recordWorkingTree(projectDir, entry, members.map((member) => member.name));

  const staging = `${root}.unpacking-${crypto.randomUUID()}`;
  try {
    for (const member of members) {
      const destination = safeMemberPath(staging, member.name);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, member.data);
    }
    await fs.promises.mkdir(path.dirname(root), { recursive: true });
    await fs.promises.rename(staging, root);
  } catch (err) {
    // Only ever the directory this call made, and only when it never became the
    // book. Nothing anybody has edited can be under this name.
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
    throw err;
  }
  return { root, files: members.map((member) => member.name) };
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Open a book and describe it.
 *
 * READ OFF THE WORKING TREE, never off the archive, and that ordering is not an
 * optimisation: after an edit the tree is the newer document, so a sidebar built
 * from the zip would name chapters the book no longer calls that. The archive is
 * read exactly once — by `ensureWorkingTree`, when there is no tree yet.
 *
 * The whole file is read into memory when it IS read. A foundry EPUB is text
 * plus whatever plates the model kept — a few megabytes — and the central
 * directory is at the END of a ZIP, so a streaming reader would seek to the tail
 * and back anyway.
 */
export async function openEpub(filePath: string): Promise<EpubBook> {
  const resolved = path.resolve(filePath);
  const label = path.basename(resolved);

  // The project first: a file from the user's own disk is IMPORTED here — copied
  // into `archive/` as the untouched original and again into `generated/` as the
  // origin this app works from, never moved and never written. `resolved` stays
  // what the user named, because main's save grant is about THAT file (main.ts,
  // `epub:open`) and their own file is the one Save may still update.
  const { dir: projectDir, entry: archiveEntry } = await importDocument(resolved, 'epub');
  const { root, files } = await ensureWorkingTree(projectDir, archiveEntry, label);

  const text = async (name: string): Promise<string | null> => {
    if (!files.includes(name)) return null;
    try {
      return await fs.promises.readFile(path.join(root, ...name.split('/')), 'utf8');
    } catch {
      return null;
    }
  };

  const container = await text('META-INF/container.xml');
  if (container === null) {
    throw new EpubError(`${label} has no META-INF/container.xml, so it is not an EPUB.`);
  }
  const rootfile = /<rootfile\b([^>]*)>/i.exec(container);
  const opfHref = rootfile?.[1] === undefined ? null : attribute(rootfile[1], 'full-path');
  if (opfHref === null) {
    throw new EpubError(`${label}'s META-INF/container.xml names no rootfile, so nothing says where the book is.`);
  }
  const opf = await text(opfHref);
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
  const navText = navItem ? await text(navItem.href) : null;
  const navEntries = navItem && navText !== null ? readNavEntries(navText, navItem.href) : [];
  const entriesByFile = new Map<string, NavEntry[]>();
  for (const navEntry of navEntries) {
    const list = entriesByFile.get(navEntry.file);
    if (list) list.push(navEntry);
    else entriesByFile.set(navEntry.file, [navEntry]);
  }

  /*
   * The <title> of every spine document the nav does not name, read BEFORE the
   * sidebar is assembled rather than inside it.
   *
   * Members come off disk now, which makes reading one an await, and an await
   * cannot happen inside the `flatMap` below without turning the chapter list
   * into a list of promises. Only the documents that actually need a fallback
   * label are read, so a book with a complete table of contents reads none.
   */
  const fallbackTitles = new Map<string, string | null>();
  for (const item of spine) {
    const named = (entriesByFile.get(item.href) ?? []).some((row) => row.fragment === null);
    if (named) continue;
    fallbackTitles.set(item.href, documentTitle(await text(item.href) ?? ''));
  }

  // ── The registry ─────────────────────────────────────────────────────────
  const id = crypto.randomUUID();
  // Managed is measured HERE, in main, because it decides what Save may write —
  // a fact the renderer consumes but never gets to assert.
  const managed = isManaged(resolved);
  unpacked.set(id, { id, root, projectDir, entry: archiveEntry, nav: navItem?.href ?? null, files });
  // Held for as long as the book is open, so a re-run of the conversion that
  // made it is refused by name rather than moving this tree out from under it.
  holdWorkingTree(root);

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
    const fromDocument = named ? null : (fallbackTitles.get(item.href) ?? null);
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

  // A project born from a PDF is named after a filename, because that is all a
  // scan offers before it has been read. The cast EPUB carries the book's real
  // title, and this is the first moment anything in the app can see it.
  if (title !== null && title.length > 0) await noteProjectTitle(projectDir, title);

  return {
    id,
    filePath: resolved,
    managed,
    // The book's own title, then the PROJECT's, then the filename. The project's
    // comes second rather than last because a book with no `dc:title` is exactly
    // the case where the filename is least likely to be the book's name.
    title: title !== null && title.length > 0
      ? title
      : (await projectTitle(projectDir) ?? label),
    author: author !== null && author.length > 0 ? author : null,
    chapters,
  };
}

/** The project's display name, or null when its catalogue cannot say. */
async function projectTitle(projectDir: string): Promise<string | null> {
  try {
    const title = (await readManifest(projectDir)).title.trim();
    return title.length > 0 ? title : null;
  } catch {
    // Already surfaced by whatever tried to USE the catalogue; a fallback title
    // is not the place to raise it a second time.
    return null;
  }
}

/** The `foundry-file://` URL one member of one open book is served at. */
export function memberUrl(id: string, memberPath: string): string {
  const encoded = memberPath.split('/').map(encodeURIComponent).join('/');
  return `foundry-file://epub/${id}/${encoded}`;
}

/**
 * Forget a book. NOTHING IS DELETED.
 *
 * This used to remove a temp directory, and a closed tab therefore threw the
 * book's working copy away — which is why every edit had to be repacked into an
 * archive first. The working tree is the project's now: it is the newest version
 * of the book, it survives the tab, the quit and the machine, and reopening the
 * file opens it rather than the archive it was unpacked from.
 *
 * What still has to happen is that the PROTOCOL stops answering for this id — a
 * handler that keeps serving a book the app believes it closed is a bug — and
 * that the tree is released, so a re-run of the conversion that made it is no
 * longer refused on the grounds that somebody is reading it.
 */
export function closeEpub(id: string): void {
  const book = unpacked.get(id);
  if (!book) return;
  unpacked.delete(id);
  releaseWorkingTree(book.root);
}

/** Quit. The registry goes; the books on disk stay exactly where they are. */
export function closeAllEpubs(): void {
  for (const book of unpacked.values()) releaseWorkingTree(book.root);
  unpacked.clear();
}
