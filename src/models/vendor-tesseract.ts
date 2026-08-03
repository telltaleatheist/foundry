/**
 * vendor-tesseract — fetch the pinned Tesseract the way weights are fetched.
 *
 * Tesseract is a prerequisite in exactly the sense the weights are: it is the
 * SEGMENTER the models were trained against (ARCHITECTURE §5), so a machine
 * without it cannot read a page any more than one without the blocks model can
 * label one. It therefore rides the same command — `foundry models pull` means
 * "download whatever is missing", and this is one of the things that can be
 * missing — and the same guarantees: a published artifact, a sha256 pasted from
 * the uploaded bytes, verification on arrival, and a mismatch deleted and named.
 *
 * WHY IT IS NOT ON HUGGINGFACE like the weights. HuggingFace hosts models; a
 * Tesseract build is a program. It goes on the GitHub release that already hosts
 * this repo's own binaries, under a stable `assets` tag — the same shape
 * BookForge uses for its component artifacts, so there is one convention to
 * learn rather than two.
 *
 * The bundle is per platform and self-contained: the executable, every non-system
 * library it loads, and the pinned tessdata (`eng.traineddata` plus `configs/tsv`,
 * which decides the OUTPUT FORMAT and is the war story in the README).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  platformKey,
  requirePin,
  resolveTesseract,
  vendorRoots,
  type TesseractPlatformPin,
} from '../scan/tesseract.js';
import { extractTarGz } from './archive.js';
import { downloadVerified, type DownloadProgress } from './download.js';
import { vendorTesseractDir } from './paths.js';

/** Where this platform's bundle already sits, or null. */
export function installedVendorRoot(pin: TesseractPlatformPin = requirePin()): string | null {
  for (const root of vendorRoots()) {
    if (fs.existsSync(path.join(root, pin.binary))) return root;
  }
  return null;
}

/**
 * One line for `foundry models list`, plus the detail under it.
 *
 * Reported alongside the weights rather than under a heading of its own,
 * because to a user "can this machine run a scan" is one question — and the
 * answer used to be split between a models list that said everything was fine
 * and a run that failed at the first page.
 */
export async function describeVendorTesseract(): Promise<string[]> {
  const key = platformKey();
  let pin: TesseractPlatformPin;
  try {
    pin = requirePin(key);
  } catch (err) {
    return ['tesseract (the pinned segmenter):', `  NOT RECORDED for ${key} — ${(err as Error).message}`];
  }

  const out = [`tesseract (the pinned segmenter):`];
  const root = installedVendorRoot(pin);
  if (!root) {
    const size = pin.artifact ? `, ${mib(pin.artifact.bytes)}` : '';
    out.push(
      `  ${pin.expectedVersion}  missing${size} — ${
        pin.artifact ? 'run `foundry models pull`' : 'no bundle is published for this platform yet'
      }`,
    );
    out.push(`    searched: ${vendorRoots().join(', ')}`);
    return out;
  }

  // Resolution is the real check — it verifies the binary's hash, its version,
  // every library and every tessdata file. Reporting "present" off an existsSync
  // would be reporting the one thing that was never in doubt.
  try {
    const resolved = await resolveTesseract({ vendorDir: root });
    out.push(`  ${resolved.version}  present, verified  (${resolved.binary})`);
  } catch (err) {
    out.push(`  ${pin.expectedVersion}  PRESENT BUT NOT USABLE — ${(err as Error).message}`);
  }
  return out;
}

/**
 * Download and install this platform's Tesseract bundle, unless it is already
 * here. Returns the root it lives in.
 *
 * The install is proved before it is reported: after extraction the whole
 * resolution runs against the new root, so a bundle that unpacks to the wrong
 * layout, or whose contents do not match the pin it was recorded with, fails
 * HERE — naming the file — rather than at the first page of somebody's book.
 */
export async function ensureVendorTesseract(
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  const key = platformKey();
  const pin = requirePin(key);

  const existing = installedVendorRoot(pin);
  if (existing) return existing;

  const artifact = pin.artifact;
  if (!artifact) {
    throw new Error(
      `No Tesseract bundle is published for ${key}. The pin records what this build expects `
      + `(${pin.expectedVersion}), but there is nothing to download: vendor/tesseract/README.md `
      + `describes what a per-platform bundle needs, and tools/scan-vendor-tesseract.sh records `
      + `one. A verified local copy can be used meanwhile with --tesseract <path>.`,
    );
  }

  const root = vendorTesseractDir();
  const dest = path.join(root, key);
  fs.mkdirSync(root, { recursive: true });
  const tarball = path.join(root, artifact.name);

  // downloadVerified is the same function the weights use: it streams, hashes
  // as the bytes arrive, and renames into place only once the hash matches, so
  // a tarball at this path is a tarball that verified.
  await downloadVerified({
    url: artifact.url,
    destPath: tarball,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    onProgress,
  });

  try {
    extractTarGz(fs.readFileSync(tarball), dest);
  } finally {
    // The archive is not kept: it is several tens of megabytes whose only
    // purpose was to become the directory beside it, and a stale one would be
    // re-extracted by a future version of this function without re-verifying.
    try {
      fs.unlinkSync(tarball);
    } catch {
      /* already gone */
    }
  }

  try {
    await resolveTesseract({ vendorDir: root });
  } catch (err) {
    throw new Error(
      `The Tesseract bundle for ${key} downloaded and its sha256 matched, but the installed `
      + `files do not satisfy the pin: ${(err as Error).message}\n`
      + `The archive is not what ${artifact.name} was recorded from. It is at ${dest}; nothing `
      + `will use it until this is resolved.`,
    );
  }
  return root;
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
