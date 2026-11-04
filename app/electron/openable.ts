/**
 * openable — the allow-list of files this app will read for a renderer.
 *
 * Moved out of documents.ts on 2026-11-04 (FOUNDRY-CORE-PLAN step 1) so that
 * `book.ts`, which admits the PDF a photographed book's export opens, no longer
 * imports a file that holds BrowserWindow and dialog. The list and both its
 * doors are unchanged, and there is still exactly ONE list: documents.ts adds to
 * it through `admit` and re-exports both doors, so nothing that asked
 * `documents` for them had to change.
 *
 * The renderer is a page on http://localhost:4260 (dev) or file:// (packaged),
 * and neither may load an arbitrary `file://` URL as an image. So the app serves
 * the bytes itself, on a scheme of its own — and what it will serve is what is
 * in here.
 *
 * The list is ALLOW-LIST rather than path-check: a renderer that was talked into
 * asking for `C:\Users\…\id_rsa` gets a refusal rather than meeting a cleverer
 * path check that has to stay right forever.
 */
import * as path from 'node:path';

const openable = new Set<string>();

/**
 * The allow-list question, asked in ONE place — for `document:read-bytes`, which
 * hands an opened document to the app's own pdf.js viewer, and for every other
 * door that reads a path the renderer named. A second copy of
 * `openable.has(path.resolve(…))` is a second authorization path, and the day one
 * copy learns a new rule is the day the other one is a hole. Null means no.
 */
export function admitted(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  return openable.has(resolved) ? resolved : null;
}

/**
 * MAIN RESOLVED IT, SO MAIN ADMITS IT — for the paths this process composes and
 * then hands to a renderer that is about to open them. Never for a path the
 * renderer named: a door that grants access for being asked a question is not a
 * gate.
 */
export function admit(target: string): void {
  openable.add(path.resolve(target));
}
