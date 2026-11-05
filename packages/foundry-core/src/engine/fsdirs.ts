/**
 * fsdirs — mkdir that survives Windows shell folders.
 *
 * Bun on Windows (verified on 1.3.14) throws EEXIST from
 * `mkdirSync(dir, { recursive: true })` when `dir` already exists but carries
 * the ReadOnly attribute — which Downloads, Documents and Desktop all do, as
 * ordinary shell folders. Node returns silently in the same case, and so does
 * Bun for attribute-free directories, which is why the failure surfaced not in
 * a test but on the first real book written to Downloads.
 *
 * So: EEXIST where the existing entry IS a directory is success — the state
 * the call was asked to produce. Every other failure (a FILE in the way,
 * permissions, a bad drive) still throws, unchanged.
 */
import * as fs from 'node:fs';

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && fs.statSync(dir).isDirectory()) return;
    throw err;
  }
}
