/**
 * book-filename — BookForge's filename convention, read back into a book's metadata.
 *
 *   "Title - Subtitle. LastName, FirstName. (Year).ext"
 *   "Title. LastName, FirstName. (Year).ext"
 *   "Title. Author.ext"
 *
 * ── ONE PARSER FOR BOTH APPS ────────────────────────────────────────────────
 *
 * This is BookForge's `parseFilename` (electron/ebook-library.ts), moved here
 * whole so both apps read a name the same way: BookForge fills a book's
 * manifest with it at import, and Foundry's export card seeds itself with it
 * (Owen, 2026-11-05: the card should be filled, and a folder named in this
 * convention says who the book is). Moved, not copied — two parsers of one
 * convention is how one book comes to have two names. `path.extname` is spelled
 * as string operations because `shared/` is also the renderer's.
 *
 * `mintMetaFromName` is the strict half Foundry uses: it fills the card only
 * from a name that IS the convention, never from one the parser merely got
 * through. See its docblock.
 */

import { generatedFilename, type MintMeta } from './mint-meta';

/** What a name says about its book. BookForge's `BookMetadata`, the fields the name can carry. */
export interface BookFilenameMeta {
  title: string;
  subtitle?: string;
  authorFirst?: string;
  authorLast?: string;
  /** Always the natural "First Last" order. */
  authorFull?: string;
  year?: number;
}

/** `path.extname`, as strings: from the last dot of the name, or '' when that dot leads it. */
function extnameOf(filename: string): string {
  const name = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/**
 * Parse metadata from a filename following naming convention:
 * "Title - Subtitle. LastName, FirstName. (Year).ext"
 * "Title. LastName, FirstName. (Year).ext"
 * "Title. Author.ext"
 */
export function parseBookFilename(filename: string): BookFilenameMeta {
  const ext = extnameOf(filename);
  return parseBookName(filename.replace(ext, ''));
}

/** The same parse of a name with no extension on it: a project's stem. */
export function parseBookName(base: string): BookFilenameMeta {
  const meta: BookFilenameMeta = { title: base };

  // Try: Title - Subtitle. Author. (Year)
  // Or:  Title. Author. (Year)
  // Or:  Title. Author
  const yearMatch = base.match(/\.\s*\((\d{4})\)\s*$/);
  let yearStr = '';
  let stripped = base;
  if (yearMatch) {
    meta.year = parseInt(yearMatch[1]!);
    yearStr = yearMatch[0];
    stripped = base.substring(0, base.length - yearStr.length);
  }

  // Split on ". " to separate title from author
  const dotParts = stripped.split(/\.\s+/);
  if (dotParts.length >= 2) {
    const authorPart = dotParts[dotParts.length - 1]!.trim();
    const titlePart = dotParts.slice(0, -1).join('. ').trim();

    // Check for "Title - Subtitle" in title part
    const dashIdx = titlePart.indexOf(' - ');
    if (dashIdx !== -1) {
      meta.title = titlePart.substring(0, dashIdx).trim();
      meta.subtitle = titlePart.substring(dashIdx + 3).trim();
    } else {
      meta.title = titlePart;
    }

    // Parse author under the ONE rule (Owen, 2026-08-16): a comma means the
    // segment is written "[Last], [First]" — strip the comma and read it that
    // way; no comma means "[First] [Last]".
    //
    // `authorFull` is ALWAYS the natural "[First] [Last]" form. Every consumer
    // treats it as display order and derives "Last, First" itself when it
    // needs the file-as form (computeDescriptiveFilename, the shelf's
    // fallback) — handing the comma'd form through is how a file named
    // "… Bailey, Gene.epub" was inverted a second time into "Gene, Bailey,"
    // on the first imported version.
    if (authorPart.includes(',')) {
      const parts = authorPart.split(',').map(s => s.trim()).filter(Boolean);
      meta.authorLast = parts[0];
      const first = parts.slice(1).join(' ');
      if (first) meta.authorFirst = first;
      meta.authorFull = first ? `${first} ${parts[0]}` : parts[0];
    } else if (authorPart.includes(' ')) {
      const parts = authorPart.split(/\s+/);
      meta.authorFirst = parts.slice(0, -1).join(' ');
      meta.authorLast = parts[parts.length - 1];
      meta.authorFull = authorPart;
    } else {
      meta.authorLast = authorPart;
      meta.authorFull = authorPart;
    }
  }

  return meta;
}

/**
 * A project's name, as the export card's last seed — or null when the name is
 * not the convention.
 *
 * ── ONLY A NAME THAT IS THE CONVENTION FILLS ANYTHING ───────────────────────
 *
 * The parser above always answers: given "Agents of Light and Darkness - Simon
 * R. Green" it reads the subtitle "Simon R" and the author "Green", and given a
 * name cut off mid-author it reads whatever is left. A card filled from that is
 * worse than an empty one, because it looks decided. So a name counts only when
 *
 *   - it names an author the convention's way, "Last, First" (the comma form
 *     BookForge writes whenever it knows both halves), and
 *   - writing the parse back out through the convention's own generator gives
 *     the name exactly back.
 *
 * Anything else fills nothing.
 */
export function mintMetaFromName(name: string): MintMeta | null {
  const said = name.replace(/\s+/g, ' ').trim();
  const parsed = parseBookName(said);
  if (!parsed.authorFirst || !parsed.authorLast) return null;
  const meta: MintMeta = {
    title: parsed.title,
    contributors: [{ first: parsed.authorFirst, last: parsed.authorLast }],
    ...(parsed.subtitle ? { subtitle: parsed.subtitle } : {}),
    ...(parsed.year !== undefined ? { year: String(parsed.year) } : {}),
  };
  const written = generatedFilename(meta, 'x');
  return written === `${said}.x` ? meta : null;
}
