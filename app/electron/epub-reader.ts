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

// The inline whitelist an in-place edit is held to, read from the module that
// injects the frame script — so the check the frame makes before a word is
// typed and the check main makes when the words come back cannot drift apart.
import { INLINE_TAGS } from './click-reporter';
// The only thing that stamps a book is the engine. See `stampBook`.
import { stampEpub } from './engine';
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
import { CATEGORY_IDS } from '../shared/categories';
import type {
  EpubBook,
  EpubChapter,
  HeadingEcho,
  HeadingRenameOutcome,
  NavEcho,
  RelabelledBlock,
  UnlinkedNote,
} from '../shared/types';

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

// ─────────────────────────────────────────────────────────────────────────────
// Select mode's three edits — the cut mark, a block's words, and minting ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * These three functions are the whole of what select mode may do to a book, and
 * they are HERE — in main, by targeted string surgery — for the reason
 * `renameEpubHeading` above is: the app never imports the engine, it spawns it,
 * so an attribute the app writes is an attribute the app writes itself. The
 * precedent is that function, down to `LEADING_SPANS`: find the exact thing,
 * change the smallest part of it, leave every other byte of the document alone.
 *
 * WHAT THEY ARE ALLOWED TO CHANGE IS DELIBERATELY TINY. `data-bf-cut="1"` goes
 * on or comes off ONE start tag; the text between one element's tags is
 * replaced; ids are stamped into start tags that have none. No repack (that
 * died with the projects change) and no reformatting: a chapter that has been
 * cut and uncut is byte-identical to the one that was opened.
 *
 * EVERY REFUSAL NAMES THE THING (ARCHITECTURE section 8). An id that is not in
 * the document, an id that is in it TWICE, an edit that moved a tag — each is a
 * sentence about that block in that file, never a silent no-op and never a
 * guess. The duplicate case matters most: two elements with one name means the
 * book is not the shape this app believes it is, and picking one of them is how
 * the wrong paragraph disappears out of somebody's book.
 */

/** The mark `foundry epub-final` removes an element by. Nothing else reads it. */
const CUT_ATTRIBUTE = 'data-bf-cut';

/** The name a block is addressed by — the only id in a cast book that is stable. */
const ID_ATTRIBUTE = 'data-bf-id';

/** One start tag, located in a document. `end` is just past its `>`. */
interface StartTag {
  name: string;
  start: number;
  end: number;
  text: string;
  selfClosing: boolean;
}

/**
 * The one element carrying `data-bf-id="<blockId>"`, or a refusal that says why
 * there is not exactly one.
 *
 * Scoped to the ONE member being edited rather than to the whole book: this is
 * the file about to be written, so it is the file in which a second element of
 * the same name could make the surgery land on the wrong paragraph. (Book-wide
 * uniqueness is the minting pass's problem, and it is the only thing that ever
 * invents an id here.)
 */
function locateBlock(markup: string, blockId: string, label: string): StartTag {
  // The shape of an id foundry writes, checked before it is put in a RegExp and
  // before it is quoted into an error message. Permissive enough for a book
  // stamped by some later scheme, narrow enough that nothing arriving from a
  // frame can be pattern syntax.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(blockId)) {
    throw new EpubError(
      `"${blockId}" is not a shape ${ID_ATTRIBUTE} is ever written in, so nothing is being changed.`,
    );
  }
  const quoted = escapeRegExp(blockId);
  const pattern = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\b${ID_ATTRIBUTE}\\s*=\\s*("${quoted}"|'${quoted}')[^>]*>`,
    'g',
  );
  const found: StartTag[] = [];
  for (const match of markup.matchAll(pattern)) {
    const text = match[0];
    // `index` is optional on the platform's match type and never actually
    // absent for a match that came from a string; skipping rather than
    // asserting keeps the count honest either way.
    if (match.index === undefined) continue;
    found.push({
      name: (match[1] ?? '').toLowerCase(),
      start: match.index,
      end: match.index + text.length,
      text,
      selfClosing: /\/\s*>$/.test(text),
    });
  }
  if (found.length === 0) {
    throw new EpubError(
      `Nothing in ${label} carries ${ID_ATTRIBUTE}="${blockId}". The chapter on screen is older `
      + 'than the file, or this book was re-cast under the tab — reopen it and try again.',
    );
  }
  if (found.length > 1) {
    throw new EpubError(
      `${found.length} elements in ${label} carry ${ID_ATTRIBUTE}="${blockId}", and an id names one `
      + 'element. Refusing to guess which of them you meant.',
    );
  }
  return found[0]!;
}

/** `<p …>` with the cut mark added, or the tag unchanged when it already has one. */
function withCutMark(tag: string): string {
  if (new RegExp(`\\b${CUT_ATTRIBUTE}\\s*=`).test(tag)) return tag;
  const closeAt = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
  return `${tag.slice(0, closeAt).replace(/\s+$/, '')} ${CUT_ATTRIBUTE}="1"${tag.slice(closeAt)}`;
}

/** …and with it taken off, whitespace and all, so an un-cut restores the byte. */
function withoutCutMark(tag: string): string {
  return tag.replace(new RegExp(`\\s+${CUT_ATTRIBUTE}\\s*=\\s*("[^"]*"|'[^']*')`, 'g'), '');
}

/*
 * THERE IS NO `setBlockCut` FOR ONE BLOCK ANY MORE, and its absence is the
 * point. Select mode's selection is a SET — one block is a set of one — so
 * every cut in the app now arrives at `setBlockCuts` below, which is the door
 * that locates every id before a byte moves. A separate single-block door would
 * be a second implementation of the same surgery, one edit away from the two
 * disagreeing about what an already-struck block means.
 */

/**
 * Mark the footnote itself, after its last reference was deleted by hand.
 *
 * Addressed by the note's OWN id (`fn25`) rather than by `data-bf-id`, because
 * that is the name the reference used and the only one the app knows at this
 * point — it read it out of the `href` it just removed.
 *
 * It is a CUT and not a deletion: the `<aside>` gains `data-bf-cut` like
 * anything else struck in select mode, so it is drawn struck through, it can be
 * un-struck by pressing Delete on it again, and it does not actually leave the
 * book until `foundry epub-final` builds the edition. A footnote is evidence,
 * and evidence removed by a dialog answered in half a second should be
 * recoverable by the same gesture as everything else.
 */
export async function setNoteCut(
  id: string,
  memberPath: string,
  noteId: string,
  cut: boolean,
): Promise<boolean> {
  const member = resolveEpubMember(id, memberPath);
  if (member === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  const markup = await fs.promises.readFile(member, 'utf8');
  const found = [...markup.matchAll(START_TAGS)].filter((match) =>
    new RegExp(`\\bid\\s*=\\s*["']${escapeForRegExp(noteId)}["']`, 'i').test(match[0]));
  if (found.length === 0) {
    throw new EpubError(`No footnote with id="${noteId}" is in ${memberPath}.`);
  }
  if (found.length > 1) {
    throw new EpubError(
      `${found.length} elements in ${memberPath} carry id="${noteId}". An id names one element, `
      + 'and striking the wrong footnote is worse than striking none.',
    );
  }
  const tag = found[0]!;
  const start = tag.index!;
  const replacement = cut ? withCutMark(tag[0]) : withoutCutMark(tag[0]);
  // FALSE MEANS IT ALREADY SAID THIS. Reported rather than swallowed, so the
  // undo ledger does not record a row promising to bring back a footnote that
  // was struck before this was called.
  if (replacement === tag[0]) return false;
  await fs.promises.writeFile(
    member,
    markup.slice(0, start) + replacement + markup.slice(start + tag[0].length),
    'utf8',
  );
  return true;
}

/**
 * Where the element opened by `block` closes — the offset of its `</…>`.
 *
 * Depth-counted over its OWN tag name only, which is all that is needed for
 * well-formed XHTML: a `<blockquote>` inside a `<blockquote>` has to close
 * before the outer one does, and a `<p>` in between cannot close either. -1
 * when the document never closes it.
 */
function closeTagOffset(markup: string, block: StartTag): number {
  const pattern = new RegExp(`<(/?)${escapeRegExp(block.name)}\\b([^>]*)>`, 'gi');
  pattern.lastIndex = block.end;
  let depth = 1;
  for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (!/\/\s*$/.test(match[2] ?? '')) {
      depth += 1;
    }
  }
  return -1;
}

/** One tag as the scanner sees it, for the comparison below. */
interface ScannedTag {
  name: string;
  closing: boolean;
  attributes: string;
}

/**
 * Every tag in a fragment, in order.
 *
 * Regular expressions again, for the reason this whole file gives: the app has
 * no XML parser, the markup is foundry's own, and the one construct that would
 * defeat this — a `>` inside an attribute value — is not something the emitter
 * writes and not something a browser's serializer produces from what it wrote.
 * Comments, CDATA and processing instructions are refused outright by the
 * caller before this is reached, so `<` here is always a tag.
 */
function scanTags(fragment: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  for (const match of fragment.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g)) {
    tags.push({
      name: (match[2] ?? '').toLowerCase(),
      closing: match[1] === '/',
      attributes: (match[3] ?? '').replace(/\/\s*$/, ''),
    });
  }
  return tags;
}

/**
 * A start tag reduced to what it MEANS: its name and its attributes, sorted,
 * with entities decoded.
 *
 * NOT the raw tag text, and the difference is the whole reason this function
 * exists. The old markup comes off disk as the emitter wrote it; the new markup
 * comes out of a browser's serializer, which is free to re-quote an attribute,
 * write `&#39;` where the file had `&apos;`, or hand back attributes in a
 * different order — none of which changes the document at all. Comparing raw
 * text would refuse honest edits over a serializer's punctuation, which would
 * make the mode useless; comparing this refuses exactly what it should, because
 * a footnote reference whose `href` changed, or whose `epub:type` went missing,
 * produces a different signature every time.
 *
 * The cost is that an edit could in principle reorder a tag's attributes. That
 * is a difference no reader, no parser and no later pass can observe.
 */
function tagSignature(tag: ScannedTag): string {
  const attributes: string[] = [];
  for (const match of tag.attributes.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = match[1]!;
    /*
     * NAMESPACE DECLARATIONS ARE THE SERIALIZER'S, NOT THE USER'S.
     *
     * A chapter is XHTML, so the frame's `innerHTML` runs through the XML
     * serializer — and serializing a FRAGMENT means every element whose
     * namespace is not declared inside that fragment gets the declaration
     * written onto it. A footnote reference that sat in the file as
     * `<a class="noteref" epub:type="noteref" href="#fn25">` comes back as the
     * same anchor wearing `xmlns="http://www.w3.org/1999/xhtml"` and
     * `xmlns:epub="http://www.idpf.org/2007/ops"`.
     *
     * MEASURED, on the first real edit: a block with three noterefs in it was
     * refused for "losing" and "gaining" the same anchors, differing by nothing
     * but those two attributes. Left in the signature, every block that carries
     * any inline markup at all is uneditable — which is most of the prose in a
     * book with footnotes, and the exact blocks somebody wants to fix.
     *
     * They are dropped rather than compared because they are not content: they
     * declare the namespace the element is already in, they are re-derived by
     * whatever writes the document next, and no reader, parser or later pass
     * can observe their absence. Every OTHER attribute is still compared
     * exactly, so an `href` that changed or an `epub:type` that went missing
     * still refuses.
     */
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    attributes.push(`${name}=${decodeEntities(match[3] ?? match[4] ?? '')}`);
  }
  attributes.sort();
  return `<${tag.name}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`;
}

/**
 * The things an editor may delete from a block by hand.
 *
 * A `noteref` anchor is the reference number's link and a `<sup>` is the number
 * itself — the emitter writes the anchor around the sup when it could match a
 * note, and a bare sup when it could not (`dots-book.ts` refuses to guess a
 * link). Both are marks a person reads and may want gone from a sentence, which
 * is why the engine has `--strip-note-markers` to remove all of them at once.
 * This is the same act, one at a time.
 *
 * Matched on the signature's CLASS rather than its tag alone, so an `<a>` that
 * is not note apparatus — there are none in a cast book, but an imported EPUB is
 * somebody else's markup — cannot be deleted by this door.
 *
 * ── And `<br>`, which was being protected as though it pointed at something ──
 *
 * Owen edited a title holding three of them and was refused for losing them,
 * with a message that said "a page marker is not a word" about a tag that is
 * not a page marker. The rule was counting every tag alike, and `<br>` is not
 * like the others: everything else this guard protects is a POINTER — a
 * pagebreak span's id, an href, a noteref's target — and losing one silently
 * breaks a link to somewhere. A `<br>` has no attribute, no id and no
 * referent. It is typography, and where a title breaks its lines is precisely
 * what a person editing a title is deciding.
 *
 * So it may go. See `isFreelyTypeable` for the other half of the same fact:
 * it may also arrive, which the editor has invited by leaving Shift+Enter
 * alone since the day it was written.
 */
function isRemovableMarker(signature: string): boolean {
  if (signature.startsWith('<sup')) return true;
  if (isFreelyTypeable(signature)) return true;
  return signature.startsWith('<a ') && signature.includes('class=noteref');
}

/**
 * The tags a person may ADD to a block, which until now was none of them.
 *
 * The gained side of the count was absolute: any tag that was not there before
 * refused the edit. That is right for everything that carries a reference and
 * wrong for the line break, and the contradiction was already sitting in the
 * editor — `click-reporter.ts` deliberately lets Shift+Enter through *"so a
 * genuine `<br>` is still typeable in a book that uses them"*, and then this
 * guard threw the result away. One half of a feature invited the keystroke and
 * the other half rejected it.
 *
 * A break has nothing to point at, so an invented one cannot point at the
 * wrong thing — the entire reason the exact-match rule exists. It stays exact
 * for every other tag, and a `<br>` with attributes on it (which the emitter
 * never writes) is NOT this: the signature carries its attributes, so a
 * decorated break is a different signature and refuses like anything else.
 */
function isFreelyTypeable(signature: string): boolean {
  return signature === '<br>';
}

function countSignatures(tags: readonly ScannedTag[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tag of tags) {
    if (tag.closing) continue;
    const signature = tagSignature(tag);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

/**
 * THE EDIT MUST BE A WORD CHANGE AND NOTHING ELSE. This is where that is true.
 *
 * Three refusals, each by name:
 *
 *   1. Anything that is not a tag — a comment, a CDATA section, a processing
 *      instruction — and any tag that is not in the inline whitelist. This is
 *      what stops a paste of a whole paragraph, and what makes "editing a
 *      blockquote" a sentence rather than a mystery.
 *   2. A start tag whose signature is not in the original, or one of the
 *      original's that is no longer there. Same tags, same attributes, same
 *      count: a footnote reference, a pagebreak span and their attributes
 *      cannot be altered, dropped or invented, while the words AROUND them are
 *      free. That is the entire contract of editing in place.
 *   3. An unescaped `&`. These documents are XHTML and are parsed strictly; a
 *      bare ampersand does not produce a slightly wrong paragraph, it produces
 *      a chapter that will not render at all.
 *
 * And one judgement: an edit that empties a block which had words is refused,
 * because a block with nothing in it is what a CUT is for and the two are one
 * keystroke apart.
 */
function refuseUnlessWordEdit(before: string, after: string, blockId: string, label: string): void {
  const where = `${ID_ATTRIBUTE}="${blockId}" in ${label}`;

  if (/<[!?]/.test(after)) {
    throw new EpubError(
      `That edit to ${where} contains a comment, a CDATA section or a processing instruction. `
      + 'Editing in place changes words; anything else is the Edit HTML pane.',
    );
  }
  if (/&(?!#[0-9]+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/.test(after)) {
    throw new EpubError(
      `That edit to ${where} contains a bare "&". These chapters are XHTML and are parsed `
      + 'strictly, so an unescaped ampersand would stop the whole chapter rendering.',
    );
  }

  const edited = scanTags(after);
  for (const tag of edited) {
    if (INLINE_TAGS.has(tag.name)) continue;
    throw new EpubError(
      `That edit to ${where} introduces <${tag.name}>, which is not inline markup. Editing in `
      + `place may change words around ${[...INLINE_TAGS].join(', ')} and nothing else — `
      + 'structure is the Edit HTML pane\'s job.',
    );
  }

  const was = countSignatures(scanTags(before));
  const now = countSignatures(edited);
  const dropped: string[] = [];
  const added: string[] = [];
  for (const [signature, count] of was) {
    const left = now.get(signature) ?? 0;
    /*
     * A REFERENCE NUMBER IS A WORD ON THE PAGE, and deleting one by hand is a
     * thing an editor does. It is the same act `--strip-note-markers` performs
     * across a whole book; refusing it here would mean the only way to remove
     * one marker is to remove all of them.
     *
     * So a noteref anchor and a `<sup>` may DISAPPEAR. Nothing else may, and
     * nothing at all may be gained: an href that changed, a pagebreak span that
     * went missing, an <em> that evaporated and any invented tag all still
     * refuse, because none of those is something a person meant to type.
     *
     * The unlinked note is not this function's problem — `setBlockHtml` reports
     * which notes lost their last reference and the app asks what to do about
     * them. A footnote nobody can reach is a decision, not a validation error.
     */
    if (left < count && isRemovableMarker(signature)) continue;
    if (left < count) dropped.push(`${signature}${count - left > 1 ? ` ×${count - left}` : ''}`);
  }
  for (const [signature, count] of now) {
    const had = was.get(signature) ?? 0;
    // A LINE BREAK MAY BE TYPED. See `isFreelyTypeable`: it is the one tag with
    // nothing to point at, and the editor has been letting Shift+Enter make one
    // all along.
    if (count > had && isFreelyTypeable(signature)) continue;
    if (count > had) added.push(`${signature}${count - had > 1 ? ` ×${count - had}` : ''}`);
  }
  if (dropped.length > 0 || added.length > 0) {
    const parts: string[] = [];
    if (dropped.length > 0) parts.push(`it loses ${dropped.join(', ')}`);
    if (added.length > 0) parts.push(`it gains ${added.join(', ')}`);
    throw new EpubError(
      `That edit to ${where} changes the markup inside the block and not only its words: `
      + `${parts.join(' and ')}. Editing in place changes words and line breaks; anything that `
      + 'points at something else — a page anchor, a link, a note\'s reference — has to come back '
      + 'exactly as it went in.',
    );
  }

  if (before.trim().length > 0 && after.trim().length === 0) {
    throw new EpubError(
      `That edit would leave ${where} with no words at all. A block with nothing in it is a `
      + 'block to CUT — press Delete on it instead.',
    );
  }
}

/**
 * Replace one block's inner markup with the edited words.
 *
 * The whole check is `refuseUnlessWordEdit`; everything here is finding the two
 * offsets to splice between and refusing when there are not two. Like the cut,
 * it writes one member and repacks nothing, and the caller does not bump the
 * revision: the frame is already showing these words.
 */
export async function setBlockHtml(
  id: string,
  memberPath: string,
  blockId: string,
  html: string,
): Promise<UnlinkedNote[]> {
  const member = resolveEpubMember(id, memberPath);
  if (member === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  const markup = await fs.promises.readFile(member, 'utf8');
  const block = locateBlock(markup, blockId, memberPath);
  if (block.selfClosing) {
    throw new EpubError(
      `${ID_ATTRIBUTE}="${blockId}" in ${memberPath} is written as an empty element `
      + `(<${block.name}/>), so it has no words to edit.`,
    );
  }
  const closeAt = closeTagOffset(markup, block);
  if (closeAt < 0) {
    throw new EpubError(
      `The <${block.name}> carrying ${ID_ATTRIBUTE}="${blockId}" in ${memberPath} is never closed, `
      + 'so there is no range to replace. That chapter needs the Edit HTML pane.',
    );
  }
  const before = markup.slice(block.end, closeAt);
  if (before === html) return [];
  refuseUnlessWordEdit(before, html, blockId, memberPath);
  const written = markup.slice(0, block.end) + html + markup.slice(closeAt);
  await fs.promises.writeFile(member, written, 'utf8');
  return notesLeftUnreachable(before, html, written);
}

/**
 * Which notes this edit just cut loose, asked of the WHOLE document.
 *
 * A reference deleted from one paragraph does not orphan its note if another
 * paragraph still points at it — the emitter links every marker with the same
 * printed number to one note, and only the first carries the backlink's target.
 * So the question is not "what did this block lose" but "what does the finished
 * chapter no longer reach", and it is asked against the bytes just written.
 *
 * The note itself is left exactly alone. Whether an unreachable footnote should
 * go is an editorial decision with an obvious wrong answer if guessed — a note
 * silently deleted is evidence gone — so this only reports, and the app asks.
 */
function notesLeftUnreachable(before: string, after: string, document: string): UnlinkedNote[] {
  const linked = (markup: string): Map<string, string> => {
    const found = new Map<string, string>();
    for (const match of markup.matchAll(
      /<a\b[^>]*\bclass\s*=\s*["']noteref["'][^>]*\bhref\s*=\s*["']#([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      found.set(match[1]!, match[2]!.replace(/<[^>]*>/g, '').trim());
    }
    return found;
  };
  const lost = linked(before);
  for (const id of linked(after).keys()) lost.delete(id);
  const out: UnlinkedNote[] = [];
  for (const [noteId, printed] of lost) {
    // Still reached from somewhere else in this chapter: not an orphan at all.
    if (new RegExp(`class\\s*=\\s*["']noteref["'][^>]*href\\s*=\\s*["']#${escapeForRegExp(noteId)}["']`, 'i')
      .test(document)) continue;
    // And there has to BE a note with that id, or there is nothing to ask about.
    if (!new RegExp(`\\bid\\s*=\\s*["']${escapeForRegExp(noteId)}["']`, 'i').test(document)) continue;
    out.push({ noteId, printed, opening: noteOpening(document, noteId) });
  }
  return out;
}

/**
 * The words the note itself begins with, so the dialog can name it.
 *
 * READ HERE, IN MAIN, and not asked of the frame: main is holding the whole
 * document at this instant, the frame is showing a chapter that may be scrolled
 * a thousand words away from the note, and a question about a footnote somebody
 * is about to lose must be answerable from the file rather than from what
 * happens to be rendered.
 *
 * Best effort by construction — the caller has already established that an
 * element with this id exists, and an empty string here only ever costs the
 * sentence half its detail. A note whose text cannot be found is still named by
 * its printed number, which is the half a reader recognises anyway.
 */
function noteOpening(document: string, noteId: string): string {
  const at = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\bid\\s*=\\s*["']${escapeForRegExp(noteId)}["'][^>]*>`,
    'i',
  ).exec(document);
  if (at === null) return '';
  const text = document
    .slice(at.index + at[0].length)
    .replace(/<[^>]*>/g, ' ')
    // The backlink arrow the emitter writes into every note (U+21A9 and the two
    // variation selectors that follow it), which is not a word of the note and
    // would otherwise be the first thing the sentence quoted.
    .replace(/[↩︎️]/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
}

/**
 * Put a block's words back exactly as they were before the last edit — the
 * "cancel" answer to the unlinked-footnote question, AND the door every undo of
 * a word edit goes through.
 *
 * THE UNDO LEDGER USES THIS AND NEVER `setBlockHtml`, which is the one thing to
 * get right about undoing an edit in this app. An edit is ALLOWED to delete a
 * footnote's reference number; undoing it puts that number back; and putting
 * markup back is exactly what the ordinary door forbids. Redo goes the other
 * way, through `setBlockHtml`, because redoing replays the original edit and
 * the original edit was legal by definition.
 *
 * IT CANNOT GO THROUGH `setBlockHtml`, and the reason is the rule that function
 * enforces: nothing may be GAINED. Restoring a deleted reference number is a
 * `<sup>` and an anchor reappearing, which is precisely what an ordinary edit
 * is forbidden to do — so a cancel routed through that door would be refused
 * every time, and the third button would be a button that does nothing.
 *
 * The check is the SAME check with its arguments the other way round: what is on
 * disk right now must be a legal word-edit OF the text being restored. If it is,
 * then what happened between them was an edit this app permits, and writing the
 * earlier side back is undoing that edit rather than smuggling markup into a
 * book. If it is not — the file moved under the tab, somebody else wrote the
 * chapter — the restore is refused by name instead of overwriting whatever is
 * there now with a paragraph from a document that no longer exists.
 */
export async function restoreBlockHtml(
  id: string,
  memberPath: string,
  blockId: string,
  html: string,
): Promise<void> {
  const member = resolveEpubMember(id, memberPath);
  if (member === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  const markup = await fs.promises.readFile(member, 'utf8');
  const block = locateBlock(markup, blockId, memberPath);
  const closeAt = closeTagOffset(markup, block);
  if (closeAt < 0) {
    throw new EpubError(
      `The <${block.name}> carrying ${ID_ATTRIBUTE}="${blockId}" in ${memberPath} is never closed, `
      + 'so there is no range to put back.',
    );
  }
  const current = markup.slice(block.end, closeAt);
  if (current === html) return;
  try {
    refuseUnlessWordEdit(html, current, blockId, memberPath);
  } catch (err) {
    throw new EpubError(
      `The earlier words cannot be put back into ${blockId} in ${memberPath}: what is in that `
      + 'block now is not what the edit being taken back produced, so restoring it would throw away '
      + `somebody else's change. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  await fs.promises.writeFile(
    member,
    markup.slice(0, block.end) + html + markup.slice(closeAt),
    'utf8',
  );
}

/**
 * Strike — or bring back — every block in a list, in ONE read and ONE write.
 *
 * THE ONLY DOOR A CUT COMES THROUGH, whether the user pressed Delete on one
 * block, dragged a marquee over thirty, or struck a whole category. A gesture
 * has to land as ONE write: a per-block call two hundred times is two hundred
 * read-modify-writes of the same file, and a failure in the middle of them
 * leaves a chapter half struck with a count on screen that describes neither
 * state. So every id is located FIRST — which is where the refusals happen, by
 * name — and only then is a single new text written. One block is a list of one
 * and takes the same path, which is what stops a second implementation of this
 * surgery existing to disagree with it.
 *
 * RETURNS THE IDS THAT ACTUALLY MOVED, which is not always the ids that came in:
 * a block already carrying the mark it is being given is not a change. The
 * count is what the app says out loud, and the LIST is what its undo ledger
 * records — this function is the only thing that read the file, so it is the
 * only thing that can say which of thirty blocks were standing beforehand.
 * Guessing that in the renderer would put a row in the ledger claiming to
 * restore a mark that was never there.
 */
export async function setBlockCuts(
  id: string,
  memberPath: string,
  blockIds: readonly string[],
  cut: boolean,
): Promise<string[]> {
  const member = resolveEpubMember(id, memberPath);
  if (member === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  // Deduplicated first, and it is not a formality: the same id twice would be
  // located twice at the same offset and spliced twice, which puts the mark's
  // own bytes through `withCutMark` a second time and corrupts the start tag.
  const wanted = [...new Set(blockIds)];
  if (wanted.length === 0) {
    throw new EpubError('No blocks were named, so there is nothing to strike.');
  }
  const markup = await fs.promises.readFile(member, 'utf8');
  // Located before anything is written, and sorted so the splices below run
  // back to front — an edit at offset 900 must not move the offsets of the one
  // at 1400 that has not happened yet.
  const found = wanted.map((blockId) => ({
    blockId,
    tag: locateBlock(markup, blockId, memberPath),
  }));
  found.sort((a, b) => b.tag.start - a.tag.start);
  const changed: string[] = [];
  let text = markup;
  for (const { blockId, tag } of found) {
    const replacement = cut ? withCutMark(tag.text) : withoutCutMark(tag.text);
    if (replacement === tag.text) continue;
    text = text.slice(0, tag.start) + replacement + text.slice(tag.end);
    changed.push(blockId);
  }
  if (changed.length === 0) return [];
  await fs.promises.writeFile(member, text, 'utf8');
  return changed;
}

/**
 * Relabel a whole list of blocks, in ONE read and ONE write — the inspector's
 * Category row applied to a marquee's worth of selection.
 *
 * THE SAME SHAPE AS `setBlockCuts`, and for the same reason: a hundred calls to
 * a per-block door are a hundred read-modify-writes of one file, and a
 * failure in the middle of them leaves half a marquee relabelled with nothing
 * on screen saying which half. Every id is located first — which is where the
 * refusals happen, by name — and only then is a single new text written.
 *
 * ── IT CHANGES THE LABEL, NOT THE SHAPE ──────────────────────────────────────
 *
 * A paragraph relabelled `footnote` is still a `<p>`, still in the prose, still
 * exactly where the page printed it. It does NOT become an `<aside>`, it does
 * not gain an id, it does not move into the `<section class="footnotes">` and
 * nothing starts pointing at it. Anybody reading this will assume the two go
 * together; they do not, and the re-shaping is `foundry epub-final`'s work, in
 * the engine, not in this app. What this attribute does is tell the engine and
 * the translator what the block IS — `src/translate/blocks.ts` reads it to
 * decide what to send the model, and `src/epub/final.ts` reads it to build the
 * edition — which is why it is worth correcting on its own.
 *
 * The category is checked against the emitter's own list before a byte moves: a
 * value nothing writes would make `blocks.ts` refuse the whole book by name on
 * the next translation, and the place to catch that is the click that invented
 * it. No revision bump either — the frame repaints its own colours off the
 * attributes it just set, and reloading the iframe would throw the reader to
 * the top of the chapter to show them something already on screen.
 *
 * A block that is ALREADY this category is not a change and is not counted; a
 * block carrying no `data-bf-cat` at all is a refusal, because relabelling
 * corrects what the model called a block and cannot invent a call it never
 * made. Both are decided before the write, so the batch lands whole.
 */
export async function setBlockCategories(
  id: string,
  memberPath: string,
  blockIds: readonly string[],
  category: string,
): Promise<RelabelledBlock[]> {
  if (!CATEGORY_IDS.has(category)) {
    throw new EpubError(
      `"${category}" is not a category foundry writes, so nothing is being relabelled. The ones `
      + `that exist are ${[...CATEGORY_IDS].join(', ')}.`,
    );
  }
  const member = resolveEpubMember(id, memberPath);
  if (member === null) {
    throw new EpubError(`"${memberPath}" is not part of a book this app has open.`);
  }
  // Deduplicated for the reason the cut batch is: the same id twice is the same
  // offset spliced twice, and the second splice lands inside the bytes the
  // first one wrote.
  const wanted = [...new Set(blockIds)];
  if (wanted.length === 0) {
    throw new EpubError('No blocks were named, so there is nothing to relabel.');
  }
  const markup = await fs.promises.readFile(member, 'utf8');
  const found = wanted.map((blockId) => ({
    blockId,
    tag: locateBlock(markup, blockId, memberPath),
  }));
  // Back to front, so an edit at offset 900 cannot move the offsets of the one
  // at 1400 that has not happened yet.
  found.sort((a, b) => b.tag.start - a.tag.start);
  const changed: RelabelledBlock[] = [];
  let text = markup;
  for (const { blockId, tag } of found) {
    const was = /\bdata-bf-cat\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag.text);
    const replacement = tag.text.replace(
      /(\bdata-bf-cat\s*=\s*)("[^"]*"|'[^']*')/i,
      (_whole, lead: string) => `${lead}"${category}"`,
    );
    if (replacement === tag.text) {
      if (new RegExp(`\\bdata-bf-cat\\s*=\\s*("${category}"|'${category}')`, 'i').test(tag.text)) {
        continue;
      }
      throw new EpubError(
        `The <${tag.name}> carrying ${ID_ATTRIBUTE}="${blockId}" in ${memberPath} has no `
        + 'data-bf-cat at all, so there is no label on it to change. Nothing in this selection has '
        + 'been relabelled.',
      );
    }
    text = text.slice(0, tag.start) + replacement + text.slice(tag.end);
    // WHAT IT WAS, not just that it moved. Thirty blocks relabelled in one
    // gesture were not all the same thing beforehand — a marquee over a page
    // catches paragraphs and captions together — so an undo has to put each one
    // back to its own label, and this is the only place that label still exists.
    changed.push({ id: blockId, was: was?.[2] ?? was?.[3] ?? '' });
  }
  if (changed.length === 0) return [];
  await fs.promises.writeFile(member, text, 'utf8');
  return changed;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every start tag of a document, for the two passes that walk them all. */
const START_TAGS = /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g;

/**
 * A stamped element carries a CATEGORY — what foundry says the block is.
 *
 * THE CATEGORY IS THE CONTRACT AND THE PAGE IS OPTIONAL PROVENANCE, and this
 * test used to have that backwards: it asked for `data-bf-page`, which is right
 * about a book cast from a scan and wrong about every other kind. A born-digital
 * EPUB stamped by `foundry epub-stamp` has categories on every block and no
 * pagination at all — the printed edition it would cite does not exist — so the
 * old test found nothing stamped anywhere, concluded there was nothing to do,
 * and opened select mode on a book where no block was addressable, with no error
 * to explain it. Everything downstream keys on the category too: `blocks.ts`
 * decides what to translate by it, `final.ts` builds the edition from it, and
 * `book.ts` admits a book at all on it.
 */
function isStamped(tag: string): boolean {
  return /\bdata-bf-cat\s*=/.test(tag);
}

/** …and one that has already been named carries an id. */
function isNamed(tag: string): boolean {
  return /\bdata-bf-id\s*=/.test(tag);
}

/**
 * Stamp this book — through the ENGINE, which is the only thing that stamps.
 *
 * WHY THIS EXISTS AT ALL: `data-bf-cat` is what select mode outlines and
 * `data-bf-id` is what a cut is recorded against, and every other id in a book
 * renumbers — `sh1` is chapter-local, `fn7` is book-wide, `c0003` is a chapter
 * ordinal, so removing one heading renames everything after it. A book with
 * neither attribute has nothing this mode can address, and pressing Select on
 * one used to open a page where every gesture failed with no explanation.
 *
 * IT USED TO MINT THE IDS HERE, by string surgery, with its own idea of the
 * scheme. That was one rule too many: the engine has to know the scheme anyway
 * (`vlm-convert` writes it, `epub-stamp` writes it, `epub-final` strips it), and
 * two implementations of one rule are one edit away from a book whose ids the
 * engine and the app disagree about. So this spawns `foundry epub-stamp` on the
 * working tree — a DIRECTORY, which that command stamps in place, which is
 * exactly what the working copy is for — and the app's job is reduced to saying
 * whether it is worth starting a process at all.
 *
 * THE GUARD IS NOT A SECOND STAMPING RULE. It answers one question — is every
 * stamped element in this book already named? — and its only power is to skip a
 * spawn that would write nothing. It is deliberately conservative: a book with
 * no categories anywhere fails it and the engine runs, which is the publisher's
 * EPUB case and the whole point.
 *
 * `members` is the spine, in reading order, from the renderer, which is where
 * the reading order is known. Every one is still resolved through the
 * allow-list — the renderer says which files, main says whether they are files
 * of this book.
 */
export async function stampBook(
  id: string,
  members: readonly string[],
): Promise<{ minted: number; documents: number }> {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');

  const seen = new Set<string>();
  let stamped = 0;
  let named = 0;
  for (const href of members) {
    if (seen.has(href)) continue;
    seen.add(href);
    const file = resolveEpubMember(id, href);
    if (file === null) {
      throw new EpubError(`"${href}" is not part of a book this app has open.`);
    }
    const markup = await fs.promises.readFile(file, 'utf8');
    for (const match of markup.matchAll(START_TAGS)) {
      if (!isStamped(match[0])) continue;
      stamped += 1;
      if (isNamed(match[0])) named += 1;
    }
  }
  if (stamped > 0 && named === stamped) return { minted: 0, documents: 0 };

  const outcome = await stampEpub(book.root);
  if (!outcome.ok) {
    throw new EpubError(
      `This book could not be stamped, so there is nothing select mode can address in it yet. `
      + `${outcome.reason ?? 'The engine said nothing.'}`,
    );
  }
  return { minted: outcome.ids, documents: outcome.documents };
}

/**
 * Rename a TOC entry: THE NAV LABEL, and an OFFER about the heading it stands
 * for.
 *
 * `entryHref` is a sidebar row's href — `text/c0003.xhtml` for a chapter,
 * `text/c0003.xhtml#sh2` for a section header inside one. The nav anchor ALWAYS
 * changes: the nav is the table of contents' truth, and renaming the row is
 * exactly what was asked.
 *
 * THE PAGE IS NOT TOUCHED HERE, and that is a deliberate change. It used to
 * follow automatically and silently whenever its text matched the old label,
 * which quietly made one of the two statements a copy of the other. They are
 * two statements: the text should say what the book says, and the contents
 * should say what the book's own apparatus says, and the caster composes labels
 * the page never carried ("Part II — The Road to War" over a page that reads
 * "II") precisely because that divergence is correct. So this function reports
 * the heading as an ECHO — the other side, as it stands, when it still reads
 * what the entry used to read — and the caller asks. `renameEpubPageHeading`
 * below is what writes it if the answer is yes.
 *
 * WHERE THE TWO ALREADY DIFFER THERE IS NO ECHO AND NO QUESTION. That is a
 * decision somebody has already made about this book, and re-asking it on every
 * contents rename would train a person to dismiss the dialog unread. It also
 * means the fragment case no longer rewrites a mismatched heading by id, which
 * it used to do unconditionally — the same silent copying, in the one place it
 * was least visible.
 *
 * Attributes are never rewritten — data-bf-*, ids, classes and the pagebreak
 * span a heading opens with all survive; only inner TEXT changes, XML-escaped.
 * The writes land in the working tree, like every other edit, and repack
 * nothing: the user's own file is written only by an explicit Save to it.
 *
 * Throws when nothing in the book matches the entry AT ALL — no nav row, no
 * heading — because a rename that could change nothing must not report success
 * and mark the tab modified.
 */
export async function renameEpubHeading(
  id: string,
  entryHref: string,
  newLabel: string,
): Promise<HeadingRenameOutcome> {
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

  // ── The nav, first: it holds the OLD label the echo rule needs. ──────────
  let navChanged = false;
  let oldLabel: string | null = null;
  const navFile = book.nav === null ? null : resolveEpubMember(id, book.nav);
  if (navFile !== null && book.nav !== null) {
    const navText = await fs.promises.readFile(navFile, 'utf8');
    const renamed = renameNavAnchor(navText, book.nav, file, fragment, escaped);
    oldLabel = renamed.oldLabel;
    if (renamed.changed) {
      await fs.promises.writeFile(navFile, renamed.text, 'utf8');
      navChanged = true;
    }
  }

  // ── The page, read and NOT written. ──────────────────────────────────────
  const markup = await fs.promises.readFile(member, 'utf8');
  // No nav (a foreign book): the sidebar label came from the document's own
  // <title>, so that is the "old label" the equality rule compares against.
  const previous = oldLabel ?? documentTitle(markup);
  const current = fragment !== null ? headingTextById(markup, fragment) : firstHeadingText(markup);
  const echo: HeadingEcho | null =
    previous !== null && current !== null && current === previous && current !== label
      ? { member: file, was: current, now: label }
      : null;

  if (!navChanged && echo === null) {
    throw new EpubError(
      'Nothing in the book carries that label — the nav names no such entry and no heading matched.',
    );
  }
  return { navChanged, echo };
}

/**
 * The other half: write the new label onto the page, once somebody has said so.
 *
 * A DOOR OF ITS OWN, on `restoreBlockHtml`'s reasoning — the question is asked
 * after the nav has already been written, the answer arrives from a dialog, and
 * the write it authorises is a different write to a different file. Folding it
 * back into the function above as a boolean would mean that function could not
 * return until a modal closed.
 *
 * `was` is the text the caller was shown and agreed to replace, and it is
 * CHECKED against what is on disk rather than trusted. Between the question and
 * the answer the frame may have written this very heading — select mode edits
 * land as they are typed — and overwriting somebody's newer words with a
 * dialog's older idea of them is the one failure this door could introduce.
 */
export async function renameEpubPageHeading(
  id: string,
  entryHref: string,
  newLabel: string,
  was: string,
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

  const markup = await fs.promises.readFile(member, 'utf8');
  const current = fragment !== null ? headingTextById(markup, fragment) : firstHeadingText(markup);
  if (current !== was) {
    throw new EpubError(
      `The heading in "${file}" no longer reads "${was}" — it now reads `
      + `${current === null ? 'nothing this app can find' : `"${current}"`}. It was changed after `
      + 'the question was asked, so nothing has been written over it. The contents entry keeps its '
      + 'new name.',
    );
  }

  const edited = fragment !== null
    ? renameHeadingById(markup, fragment, escaped)
    : renameChapterHeading(markup, was, escaped);
  if (edited === markup) {
    throw new EpubError(`The heading in "${file}" could not be rewritten, so nothing was changed.`);
  }
  await fs.promises.writeFile(member, edited, 'utf8');
}

/**
 * The contents entry an in-place heading edit could carry with it, or null.
 *
 * THE DIRECTION THAT DID NOT EXIST. Editing a heading in select mode wrote the
 * page and stopped there, so fixing a typo on the page left the typo in the
 * contents forever with nothing on screen to say so. That was a bug, not a
 * design choice — the divergence the design protects is a deliberate one, and
 * a misspelling nobody chose is not it.
 *
 * `was` is the block's markup as it stood before the edit, handed over by the
 * frame; its plain text is what the contents entry has to still read for there
 * to be anything to offer. Four things must all hold, and each of them is a way
 * this can legitimately answer null:
 *
 *  - the edited block is a HEADING. A paragraph's words are not a chapter's
 *    name, and no contents entry ever claimed to be a copy of them.
 *  - the book has a nav with a `toc` in it.
 *  - some toc anchor points at this document — at the heading's own id when it
 *    has one, or at the document itself.
 *  - that anchor's label still reads exactly what the heading used to read.
 *    Where it does not, the two already differ, and the difference is somebody
 *    else's decision.
 */
export async function navEchoForBlock(
  id: string,
  memberPath: string,
  blockId: string,
  was: string,
): Promise<NavEcho | null> {
  const book = unpacked.get(id);
  if (!book || book.nav === null) return null;
  const member = resolveEpubMember(id, memberPath);
  const navFile = resolveEpubMember(id, book.nav);
  if (member === null || navFile === null) return null;

  const markup = await fs.promises.readFile(member, 'utf8');
  const block = locateBlock(markup, blockId, memberPath);
  if (!/^h[1-6]$/.test(block.name)) return null;

  const previous = plainText(was);
  if (previous.length === 0) return null;
  const closeAt = closeTagOffset(markup, block);
  if (closeAt < 0) return null;
  const now = plainText(markup.slice(block.end, closeAt));
  if (now.length === 0 || now === previous) return null;

  const ownId = attribute(block.text, 'id');
  const navText = await fs.promises.readFile(navFile, 'utf8');
  const entry = tocEntryReading(navText, book.nav, memberPath, ownId, previous);
  return entry === null ? null : { href: entry, was: previous, now };
}

/**
 * The href of the toc entry pointing at this document and reading exactly
 * `label`, in the shape the sidebar and `renameEpubHeading` use.
 *
 * Scoped to `epub:type="toc"` for `renameNavAnchor`'s reason: the landmarks nav
 * points at chapter files too, and its labels ("Beginning") are semantics
 * rather than names.
 *
 * An entry whose fragment names some OTHER element in this document is not a
 * candidate, even when its label matches — two section headers of a chapter can
 * legitimately read the same words, and renaming the wrong one is a change
 * nobody would notice until they went looking for the right one.
 */
function tocEntryReading(
  navText: string,
  navHref: string,
  memberPath: string,
  headingId: string | null,
  label: string,
): string | null {
  const toc = /(<nav\b[^>]*epub:type\s*=\s*"toc"[^>]*>)([\s\S]*?)(<\/nav>)/i.exec(navText);
  if (!toc) return null;
  for (const match of (toc[2] ?? '').matchAll(/(<a\b[^>]*>)([\s\S]*?)(<\/a\s*>)/gi)) {
    const href = attribute(match[1] ?? '', 'href');
    if (href === null) continue;
    const [filePart, fragmentPart] = href.split('#');
    if (joinHref(navHref, filePart ?? href) !== memberPath) continue;
    const fragment = fragmentPart && fragmentPart.length > 0 ? fragmentPart : null;
    if (fragment !== null && fragment !== headingId) continue;
    if (plainText(match[2] ?? '') !== label) continue;
    return fragment === null ? memberPath : `${memberPath}#${fragment}`;
  }
  return null;
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

/**
 * What the heading carrying `id="<fragment>"` reads, or null when there is none.
 *
 * The leading pagebreak spans are stripped by `plainText` along with every
 * other tag, which is exactly right here: the page marker is not part of what
 * the heading SAYS, and a comparison that counted it would never match a
 * contents label.
 */
function headingTextById(markup: string, fragment: string): string | null {
  const pattern = new RegExp(
    `<h([1-6])\\b[^>]*\\bid\\s*=\\s*"${escapeRegExp(fragment)}"[^>]*>([\\s\\S]*?)</h\\1\\s*>`,
    'i',
  );
  const match = pattern.exec(markup);
  if (match === null) return null;
  const text = plainText(match[2] ?? '');
  return text.length > 0 ? text : null;
}

/** What the document's FIRST heading reads, or null when it carries none. */
function firstHeadingText(markup: string): string | null {
  const match = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(markup);
  if (match === null) return null;
  const text = plainText(match[2] ?? '');
  return text.length > 0 ? text : null;
}

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
 * The attribute that says a book is FOUNDRY'S — the model's own category,
 * stamped on every block either by the conversion that cast the book or by
 * `foundry epub-stamp` over one that came from a publisher.
 *
 * IT IS THE ENGINE'S OWN TEST, spelled the same way (`bookFromMembers`,
 * src/translate/book.ts, admits a book when any spine document contains this
 * string) and that is the whole reason it is this attribute rather than
 * `data-bf-id`, which a person reading the markup would reach for first. The two
 * are written together and nothing produces one without the other, so they agree
 * about every book that exists — but the app is deciding here whether to hand a
 * book to a command that will make its OWN admission decision, and two spellings
 * of one question is one place for the answers to differ.
 */
const STAMP_ATTRIBUTE = 'data-bf-cat';

/**
 * Is this open book one of ours?
 *
 * ASKED OF THE WORKING TREE, which is the copy that is true right now: a book
 * stamped in select mode an hour ago is stamped in the tree and not in whatever
 * file it was imported from. The allow-list is the same one every other reader
 * here uses, so this walks the members the book declares rather than whatever
 * happens to be lying in the directory.
 *
 * IT STOPS AT THE FIRST DOCUMENT THAT ANSWERS YES, which for a foundry book is
 * the first document: every block of every chapter carries the stamp. The whole
 * walk is only paid by a book that is NOT ours, where the answer is the same
 * whichever member is read last.
 *
 * A member that cannot be read is not an answer and is skipped. The question is
 * "does this book carry foundry's stamps", and a chapter that would not open is
 * a different problem which the reader itself will report the moment anybody
 * looks at it.
 */
export async function isFoundryBook(id: string): Promise<boolean> {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');
  for (const member of book.files) {
    if (!/\.x?html?$/i.test(member)) continue;
    try {
      const source = await fs.promises.readFile(path.join(book.root, ...member.split('/')), 'utf8');
      if (source.includes(STAMP_ATTRIBUTE)) return true;
    } catch {
      continue;
    }
  }
  return false;
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
 * ── Which book, and why the old test was a trap ─────────────────────────────
 *
 * A book is found BY ITS PATH, and the path it is matched against is the origin
 * its tree was unpacked from — resolved through this app's own record of where
 * that tree came from, never by comparing basenames or by joining strings and
 * hoping. That much is unchanged.
 *
 * WHAT CHANGED IS THE MISS. It used to return the input path unchanged when no
 * open book matched, on the reasoning that "a translation ordered from Home" has
 * nothing to export. That is true and it is also how an edited book could be
 * translated in the state it was in before the curation: if the match failed for
 * any OTHER reason — the tab pointing at a path the registry does not know,
 * which is exactly what the outside-file window used to produce — the fallthrough
 * silently handed the engine the unedited origin and reported nothing. The one
 * failure this function exists to prevent, produced by the function itself.
 *
 * So the two cases are separated. NO BOOK IS OPEN ON THIS FILE AT ALL is the
 * ordinary miss and returns the path: there is no working tree, so there is
 * nothing that could be newer than what is on disk. A BOOK IS OPEN ON THIS
 * PROJECT'S TREE but its origin is not this path is the dangerous one, and it
 * refuses by name rather than exporting the wrong book or the right book's older
 * self.
 */
export async function exportWorkingCopy(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const fold = (target: string): string => path.resolve(target).toLowerCase();
  for (const book of unpacked.values()) {
    if (fold(path.join(book.projectDir, ...book.entry.split('/'))) === fold(resolved)) {
      const destination = path.join(book.projectDir, 'working', path.basename(resolved));
      await repackEpub(book.id, destination);
      return destination;
    }
  }
  /*
   * An open book in the same project, unpacked from something else. The caller
   * asked for a file this app is holding edits NEAR, and answering with the path
   * would mean handing the engine a document while a newer version of its
   * neighbour sits unwritten — which is the state where "translated the wrong
   * copy" is indistinguishable from success.
   */
  const neighbour = [...unpacked.values()].find(
    (book) => fold(resolved).startsWith(`${fold(book.projectDir)}${path.sep}`.toLowerCase()));
  if (neighbour !== undefined) {
    throw new EpubError(
      `${path.basename(resolved)} is not the book Foundry has open in that project — it is holding `
      + `${path.basename(neighbour.entry)}. Open the document you mean and try again, so the run `
      + 'reads the copy with your edits in it rather than an older one.',
    );
  }
  return resolved;
}

/**
 * The unpacked working tree of an open book — the directory the engine's
 * directory-form commands take.
 *
 * Handed out rather than a path the renderer could name, on this file's usual
 * rule: the renderer says WHICH BOOK by its id, and main says where that book's
 * bytes are. `epub-meta --epub <tree>` edits it in place, which is the whole
 * reason that form of the command exists.
 */
export function workingTreeOf(id: string): string {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');
  return book.root;
}

/** The project a currently open book belongs to — for the Save dialog's folder. */
export function projectOf(id: string): string | null {
  return unpacked.get(id)?.projectDir ?? null;
}

/**
 * The name of a book from this project that is open RIGHT NOW, or null.
 *
 * MAIN'S OWN ANSWER to "is anything in here in use", for `projects:delete`. The
 * renderer asks the same question of its tab list before it asks the user, and
 * that check is the one that gives a good sentence; this is the one that is an
 * AUTHORIZATION. A renderer that was talked into calling delete with an empty
 * tab list would otherwise have main erase the working tree its own protocol
 * handler is serving chapters out of — every image a 404, every save a failure —
 * and on Windows the delete would stop halfway on the first locked file and
 * leave a project that is neither there nor gone.
 *
 * `entry` is the origin under `generated/` the tree was unpacked from, so its
 * basename is the book's own filename: the thing the user recognises.
 *
 * Answers for the OPEN BOOKS only, which is what `unpacked` holds — a PDF tab is
 * bytes the renderer was handed once and holds in memory, with no directory of
 * this app's open underneath it.
 */
export function openBookIn(projectDir: string): string | null {
  const wanted = path.resolve(projectDir).toLowerCase();
  for (const book of unpacked.values()) {
    if (path.resolve(book.projectDir).toLowerCase() === wanted) return path.basename(book.entry);
  }
  return null;
}

/**
 * The two facts that name an open book's DOCUMENT rather than its session: the
 * project it lives in, and the origin its working tree was unpacked from.
 *
 * The undo history on disk is keyed by these and never by `id`, which is a uuid
 * minted per open and would file every launch's ledger under a new name — a
 * history nothing could ever find again, which is the same thing as no history.
 * Handed out rather than a path the renderer could name, on this file's usual
 * rule: the renderer says WHICH BOOK, main says where its bytes are.
 */
export function documentOf(id: string): { projectDir: string; entry: string } {
  const book = unpacked.get(id);
  if (!book) throw new EpubError('That book is not open in this app any more.');
  return { projectDir: book.projectDir, entry: book.entry };
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
  const { dir: projectDir, entry: archiveEntry, notice } = await importDocument(resolved, 'epub');
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
    // The navigation document, named so the renderer's undo stack can snapshot
    // it. A contents rename writes a member the renderer otherwise has no name
    // for — every other edit in the app is addressed by a chapter href it
    // already holds — and an undo entry that cannot name the file it changed is
    // an undo entry that cannot put it back.
    navMember: navItem?.href ?? null,
    // Carried out of the import rather than logged there: the import runs in
    // main and the person is looking at a window.
    notice,
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
