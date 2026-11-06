/**
 * capture-serve — the foundry-file door: the tokens a capture's pictures are served under.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// The door
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `foundry-file://capture/<token>/<name>` — ONE FLAT DIRECTORY of this stage's
 * pictures, and nothing else on this disk.
 *
 * Minted per directory and reused, exactly like the book host's: the map stays
 * the size of the library rather than growing with every project open. The token
 * is the whole authorisation — a URL the renderer composes for a directory
 * nothing registered meets a 403 rather than a read.
 *
 * ── ONE DIRECTORY AGAIN, AND THE SECOND ONE IS A GRAVESTONE (Wave 41) ──────
 *
 * For two days this served `derived/` AND a mint's `archive/<stem> pages/`,
 * because the mint wrote page images and no container, so the page view had to
 * be handed the pictures themselves. The mint writes a PDF again (`mintCommit`,
 * `recordMint`), the page view is deleted, and this host is back to the one
 * layer it began with: the decoded working copies and thumbnails the light table
 * draws.
 *
 * The MECHANISM is untouched and stays general on purpose — a caller inside this
 * module asks for a token for a directory it named, and nothing outside can ask
 * for a token at all. What retired is the second CALLER, not the second
 * directory's right to exist.
 *
 * THE ORIGINALS STILL HAVE NO HOST AND CANNOT BE GIVEN ONE FROM OUTSIDE. The
 * served directory holds files this app MADE — decoded working copies,
 * thumbnails — every one of them remakeable from the photographs plus the
 * recipe. The photographs themselves, which for an archive shoot may be the only
 * copies that exist, are addressable through no host here.
 */
export const captureTokens = new Map<string, string>();

export const captureDirs = new Map<string, string>();

export function tokenForServing(dir: string): string {
  const known = captureTokens.get(dir);
  if (known !== undefined) return known;
  const token = randomUUID();
  captureTokens.set(dir, token);
  captureDirs.set(token, dir);
  return token;
}

/**
 * The file behind `foundry-file://capture/<token>/<name>`, or null for anything
 * this process never agreed to serve.
 *
 * THE NAME MUST BE A PLAIN BASENAME, on `bookFigureFile`'s argument and with its
 * refusals: the served directory is FLAT — intake writes `derived/` flat — so a
 * separator in the name is not a file this app made. It is a traversal, and it
 * meets the same null an unknown token does rather than a `resolve()` that might
 * climb.
 */
export function captureServedFile(token: string, name: string): string | null {
  const dir = captureDirs.get(token);
  if (dir === undefined) return null;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return path.join(dir, name);
}
