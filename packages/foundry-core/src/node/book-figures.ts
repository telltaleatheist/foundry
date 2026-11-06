/**
 * book-figures — where a book's figures are served from, and healing the ones missing.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/** Does this path exist? Nothing else about it is asked. */
export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/*
 * ── The figures door ─────────────────────────────────────────────────────────
 *
 * A Picture row names its crop by NAME, and the renderer is a page under a CSP
 * that loads images off the `foundry-file:` scheme and nowhere else on disk. So
 * a successful
 * load REGISTERS the book's image directory under an opaque token, hands the
 * pane `foundry-file://book/<token>/` as a prefix, and the protocol handler
 * (electron/mount.ts) asks this table before it serves a byte. An ALLOW-LIST, not a path
 * scheme: a URL the renderer invents for a directory nothing registered is a
 * 403 rather than a read.
 *
 * The token is minted per DIRECTORY and reused across reloads, so the map stays
 * the size of the library rather than growing with every glance at a pane.
 */
export const figureTokens = new Map<string, string>();

export const figureDirs = new Map<string, string>();

export function figuresPrefixFor(imagesDir: string): string {
  const known = figureTokens.get(imagesDir);
  if (known !== undefined) return `foundry-file://book/${known}/`;
  const token = randomUUID();
  figureTokens.set(imagesDir, token);
  figureDirs.set(token, imagesDir);
  return `foundry-file://book/${token}/`;
}

/**
 * The file behind `foundry-file://book/<token>/<name>`, or null for anything
 * this process never agreed to serve.
 *
 * THE NAME MUST BE A PLAIN BASENAME. The engine writes the crops flat into one
 * directory (`p<page>-<order>.png`), so a separator in the name is not a figure
 * this app cut — it is a traversal, and it meets the same null as an unknown
 * token rather than a resolve() that might climb.
 */
export function bookFigureFile(token: string, name: string): string | null {
  const dir = figureDirs.get(token);
  if (dir === undefined) return null;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return path.join(dir, name);
}

/**
 * THE BOOKS THIS PROCESS HAS ALREADY TRIED TO GIVE ITS FIGURES BACK TO.
 *
 * ── The loop this closes ────────────────────────────────────────────────────
 *
 * `figuresMissing` is answered from the file on the disk, so a remake that
 * SUCCEEDS answers it "no" forever after: the new header records the source it
 * was given, and `from === null` can never be true again for that book. That is
 * the real guard and it is a property of the marker rather than of this set
 * (`BookFigures`, shared/book.ts).
 *
 * What this set covers is the other ending — a remake that FAILS. The engine
 * writes atomically, so a refusal leaves the old figure-less book exactly where
 * it was, `figuresMissing` still says yes, and every open of that pane would
 * spawn another engine that fails the same way. Once per book per process is
 * enough to learn that; the person's next launch tries again, which is right,
 * because what was wrong with it may have been fixed in between.
 *
 * FOLDED WHOLE PATHS, never basenames — `oneWriterOf`'s rule (electron/engine.ts)
 * for its reason: two projects both have a `readings/…book.jsonl`.
 */
export const figuresHealed = new Set<string>();

/**
 * WAS THIS BOOK MADE WITH NOTHING TO CUT ITS PICTURES FROM?
 *
 * ── Why the question is asked of the file rather than remembered ────────────
 *
 * Owen exported a captured book on 2026-08-22 and the engine refused: *"is a
 * picture and this book never had its figures cut"*. It was right, and nothing
 * in the app was ever going to fix it — the reflow had run months earlier with
 * no source (its archive is a folder of photographs, and `vlm-book` took only
 * `--pdf` until Wave 37), the book file it wrote is perfectly valid, and the
 * ensure step below sees a valid book file and stops. The one thing that had
 * changed was the ENGINE's ability to cut from those photographs, and a person
 * has no way to ask for a reflow.
 *
 * So the ensure step asks one more question than it used to. This is not a
 * fallback and not a repair pass: it is the same "is the file on the disk the
 * one this project should have" the function has always asked, with a fact in
 * it that only became knowable when the engine learned to record it.
 *
 * ── Two answers, and the second one is a migration ──────────────────────────
 *
 * THE HEADER SAYS SO, for anything a current engine wrote: `from === null` means
 * the run was offered no pages at all, and `blocks > cut` means there were
 * pictures it therefore did not cut. Both, or this book is as good as it can be.
 * Note `from` records the OFFER: a book remade WITH pages says `pages` even if
 * something went wrong afterwards, which is exactly why this terminates.
 *
 * THE ROWS SAY SO, for anything older, and every book file in anybody's library
 * today is older. There is no marker, so the honest reading is "unknown" and the
 * evidence is the rows themselves: a Picture row with no `image` is a picture
 * with no file. That costs one read of a file the caller is about to read again,
 * and it costs it ONCE IN THE LIFE OF THE PROJECT — the remake writes a marker,
 * and every open after that takes the branch above.
 *
 * A FILE THAT WILL NOT PARSE IS NOT THIS FUNCTION'S PROBLEM. It answers false and
 * the load a few lines later refuses it by name, in the parser's own sentence,
 * which is a far better sentence than anything this could say about it.
 */
export async function figuresMissing(bookPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await fsp.readFile(bookPath, 'utf8');
  } catch {
    return false;
  }
  const head = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  let header: unknown;
  try {
    header = JSON.parse(head);
  } catch {
    return false;
  }
  const figures = (header as { figures?: { blocks?: unknown; cut?: unknown; from?: unknown } })
    .figures;
  if (figures !== undefined && figures !== null) {
    return figures.from === null
      && typeof figures.blocks === 'number' && typeof figures.cut === 'number'
      && figures.blocks > figures.cut;
  }
  /*
   * The rows, for a book made before the marker. Read as JSON per line rather
   * than pattern-matched over the text: `"category":"Picture"` also occurs inside
   * a paragraph that happens to quote it, and a book that says its own format's
   * words in its prose must not be remade every time it is opened.
   */
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    const one = row as { category?: unknown; image?: unknown; shelf?: unknown };
    if (one.category === 'Picture' && one.shelf === undefined && one.image === undefined) {
      return true;
    }
  }
  return false;
}
