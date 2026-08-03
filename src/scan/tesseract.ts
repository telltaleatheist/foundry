/**
 * tesseract.ts — the pinned Tesseract, and the line-level call the band path
 * makes of it.
 *
 * Ported from BookForgeApp's `electron/ocr-service.ts` (the invocation rules and
 * the dpi pin) and `tools/ocr-lab/run-book.py` (the band path's own call: one
 * process per page over an image list, TSV out, `--psm 7`, a `--psm 13` rescue).
 * The Electron project store, the render cache and the progress events stay
 * behind; none of them are this program's problem.
 *
 * ADDED here, because BookForge does not have it: the PIN IS VERIFIED. BookForge
 * assumes an installed Tesseract and asks the component system where it is.
 * Foundry vendors one, and vendoring is worthless without a check — so the
 * resolved binary's `--version`, its libraries' sha256s and every tessdata
 * file's sha256 are compared against the pin before a single page is read, and a
 * mismatch is an error naming the file (ARCHITECTURE §5).
 *
 * The pin — `vendor/tesseract/manifest.json` — is IMPORTED, so the bundler
 * compiles it into the binary. The FILES it describes are found either in a dev
 * checkout's `vendor/tesseract/` or in the platform data dir, where
 * `foundry models pull` downloads them. That split is the point: the statement
 * about which Tesseract this build was measured against travels with the build,
 * and only the bytes have to be fetched.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import manifestJson from '../../vendor/tesseract/manifest.json';
import { vendorTesseractDir } from '../models/paths.js';
import { pyRoundTo, type Band } from './bands.js';
import { writePgm, type GrayRaster } from './pgm.js';

/**
 * Tesseract is always spawned ASYNCHRONOUSLY, with an ARGUMENT ARRAY.
 *
 * With an argument array, because the default Windows install path is
 * `C:\Program Files\Tesseract-OCR\tesseract.exe` and the tessdata directory
 * beside it carries the same space. Interpolating either into a command line
 * hands cmd.exe `C:\Program` as the program name, so a perfectly good install
 * reports itself as MISSING. Every invocation below is an explicit execFile
 * with an argument array instead — never a shell string, ever.
 */
const execFileAsync = promisify(execFile);

/**
 * The one render resolution the whole OCR path uses, in dpi.
 *
 * NOT A SETTING. Tesseract's layout analysis is resolution-dependent — it
 * groups lines by PHYSICAL distance, so the same page rasterised at a different
 * dpi comes back with different blocks — and every label in the training corpus
 * is defined against the segmentation at 200 dpi. A caller that renders at some
 * other dpi produces different blocks and silently invalidates the labels keyed
 * to them, and the models trained on those labels get quietly worse in a way
 * that reads as an undertrained model rather than a malformed input.
 *
 * It moved once by accident already: a literal 300 in BookForge's headless OCR
 * path had drifted from the 200 everywhere else, so Tesseract was told the page
 * was 1.5x smaller than it was. That is why the number lives in exactly one
 * place, here, and is passed through on every invocation.
 *
 * Anything that rasterises a page for OCR renders at this number. Move it only
 * if you mean to re-key the corpus.
 */
export const OCR_DPI = 200;

/** Image pixels per PDF point in an OCR raster — 200/72. */
export const OCR_RENDER_SCALE = OCR_DPI / 72;

/**
 * One line per crop. The band path has already decided where the lines are, so
 * recognition never has to do layout: every crop holds exactly one line.
 */
const PSM_SINGLE_LINE = 7;

/**
 * Second chance for a crop `--psm 7` read as nothing. psm 7 still runs layout
 * analysis inside the line; a crop a few pixels taller than the type - the
 * ascenders of the line below just clipping the bottom edge - can make it decide
 * there is no line there and return an EMPTY STRING, with no error and full exit
 * status. That is the exact failure this pipeline exists to end, one level down.
 * psm 13 skips the analysis and recognizes the raster as one line, and it read
 * all 16 of deathstalker's silently-empty body bands correctly. The retry only
 * ever runs on a band that produced nothing (32 of 22,600 there), it is counted,
 * and every line records the psm that produced it.
 */
const RESCUE_PSM = 13;

/** Tesseract's own TSV header row, which is not data. */
const TSV_HEADER = 'level\tpage_num';

// ------------------------------------------------------------------- manifest

export interface TessdataEntry {
  sha256: string;
  bytes: number;
}

/** A downloadable, self-contained vendor bundle for one platform. */
export interface TesseractArtifact {
  /** Basename of the tarball, which carries its version and platform. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface TesseractPlatformPin {
  /**
   * The exact `tesseract --version` number this platform's bundle reports.
   *
   * PER PLATFORM, and it has to be: there is no single Tesseract version that
   * exists as a real build everywhere. Homebrew publishes `5.5.1`; the Windows
   * builds report a datestamped `5.5.0.20241111`. A global pin could only ever
   * be satisfied on the one platform it was taken from, which is precisely the
   * state this field replaces — scan worked on exactly one machine.
   */
  expectedVersion: string;
  /** The whole first line of `--version`, as recorded. For humans. */
  versionLine?: string;
  /** Path to the binary, relative to the vendor root. */
  binary: string;
  /** sha256 of that binary, or null when the platform is not vendored yet. */
  binarySha256: string | null;
  /**
   * Shared libraries shipped beside the binary, path relative to the vendor
   * root's platform dir. Hashed like the tessdata, because on Windows the
   * `tesseract.exe` that carries the version is an 88 KB launcher and
   * `libtesseract-5.dll` is the actual engine — verifying only the executable
   * would leave the segmenter itself unchecked.
   */
  libraries?: Record<string, TessdataEntry>;
  /** Directory holding `<lang>.traineddata`, relative to the vendor root. */
  tessdataDir: string;
  tessdata: Record<string, TessdataEntry>;
  /** False when the recorded binary is not relocatable — see vendor/tesseract/README.md. */
  portable: boolean;
  /**
   * The fetchable bundle, when one has been published for this platform.
   * Absent means the platform is recorded but only usable from a checkout that
   * already holds the files.
   */
  artifact?: TesseractArtifact;
  note?: string;
}

export interface TesseractManifest {
  /**
   * The dpi the pin is defined at. Cross-checked against OCR_DPI.
   *
   * Global, and unlike the version it genuinely is: dpi keys the training
   * corpus, so it is one number for the whole program on every platform.
   */
  dpi: number;
  platforms: Record<string, TesseractPlatformPin>;
}

export interface ResolvedTesseract {
  binary: string;
  tessdataDir: string;
  lang: string;
  version: string;
  platform: string;
  manifest: TesseractManifest;
}

export interface TesseractOptions {
  /**
   * `--tesseract <path>`: overrides WHICH binary is used, for development and
   * for a packager with a verified system copy. It does NOT relax any check —
   * the version test still runs against it, and the tessdata still comes from
   * the vendor directory. It is not an escape hatch from the pin.
   */
  binaryPath?: string;
  /**
   * Pin one vendor root instead of searching. Used by the tests, and by anyone
   * who wants a specific bundle rather than "whichever this machine has".
   */
  vendorDir?: string;
  /** Language, and the tessdata file that must verify. */
  lang?: string;
  /**
   * Use this pin instead of the one compiled into the build.
   *
   * Injected for the same reason `PlatformContext` is injected in
   * `models/paths.ts`: the verification branches — wrong version, wrong hash,
   * missing file, unrecorded platform — have to be exercisable from ONE machine,
   * and the compiled-in pin describes only the platform the test is running on.
   *
   * It is not a way to loosen anything. Whatever is passed is checked exactly as
   * strictly as the real pin; there is no shape of manifest that verifies less.
   */
  manifest?: TesseractManifest;
}

/** `<platform>-<arch>`, the key into the manifest. */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * The pin, compiled INTO this build.
 *
 * Imported rather than read off disk, and that is the fix for the bug that
 * started this: the loose-file version resolved `manifest.json` relative to
 * `import.meta.url`, which in a `bun build --compile` binary points beside the
 * executable. The release tarball ships one file — `foundry.exe` — so a packaged
 * foundry looked for its pin in `…/components/foundry-cli/vendor/tesseract/
 * manifest.json`, found nothing, and refused to scan. Scan worked only from a
 * checkout.
 *
 * The manifest is COMMITTED CODE — a statement about which Tesseract this build
 * was measured against — so compiling it in is what it always should have been.
 * A packaged install now needs no manifest.json on disk at all, and the
 * downloadable bundle is just the binary, its libraries and the tessdata.
 */
const MANIFEST = manifestJson as unknown as TesseractManifest;

/**
 * The pin this build carries. Exported so a test can assert on the SHIPPED pin
 * rather than on a file in the checkout, which is the difference that mattered.
 */
export function compiledManifest(): TesseractManifest {
  return MANIFEST;
}

/**
 * `<root>/vendor/tesseract` relative to this source file, or null when that is
 * not a real directory — which is exactly the compiled-binary case.
 *
 * fileURLToPath, not `url.pathname`: on Windows the latter yields `/C:/…`,
 * which is not a path.
 */
function checkoutVendorDir(): string | null {
  let dir: string;
  try {
    dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'tesseract');
  } catch {
    // A compiled binary's import.meta.url is not a file: URL at all.
    return null;
  }
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Every root that could hold a vendored Tesseract for this platform, in order.
 *
 * ONE search order, used by every caller. `runScan` used to compute its own and
 * pass it as `vendorDir`, which pinned a single root and meant the packaged
 * binary looked beside the .exe and nowhere else — so a downloaded bundle in the
 * data dir was invisible to the one command that needed it. Two resolvers is the
 * bug; this is the fix.
 *
 *   1. the dev CHECKOUT, when this is running from source. First and
 *      deliberately: someone who has just re-vendored a build to test it must
 *      get theirs, not a copy the data dir is holding from a previous release.
 *      In a compiled binary `import.meta.url` is a virtual path that does not
 *      exist on disk, so this candidate simply is not offered.
 *   2. BESIDE THE EXECUTABLE, and one level up — which covers a packager who
 *      ships `vendor/` next to the binary, and a `bin/foundry` + `vendor/`
 *      layout. Deliberate placement by whoever built the install, so it
 *      outranks the download.
 *   3. the platform DATA DIR, where `foundry models pull` puts what it fetched.
 *
 * Every one of them is "a Tesseract someone chose for this program"; none of
 * them is a PATH lookup, which is the line that matters.
 */
export function vendorRoots(explicit?: string): string[] {
  if (explicit) return [path.resolve(explicit)];
  const roots: string[] = [];
  const checkout = checkoutVendorDir();
  if (checkout) roots.push(checkout);
  const beside = path.dirname(process.execPath);
  roots.push(path.join(beside, 'vendor', 'tesseract'));
  roots.push(path.resolve(beside, '..', 'vendor', 'tesseract'));
  roots.push(vendorTesseractDir());
  // Dedupe: run from a checkout with bun and `beside` can repeat the checkout.
  return [...new Set(roots)];
}

/** The pin for this platform, or an error naming what is recorded instead. */
export function requirePin(
  key: string = platformKey(),
  manifest: TesseractManifest = MANIFEST,
): TesseractPlatformPin {
  const pin = manifest.platforms[key];
  if (!pin) {
    throw new Error(
      `This build's Tesseract pin has no entry for ${key}. Recorded platforms: ` +
        `${Object.keys(manifest.platforms).join(', ') || '(none)'}. ` +
        `Run tools/scan-vendor-tesseract.sh on a machine of this platform to record one, ` +
        `then publish its bundle — see vendor/tesseract/README.md.`,
    );
  }
  return pin;
}

/**
 * Resolve the binary and the tessdata, and verify BOTH against the pin.
 *
 * Resolution order, and there is no entry after the last:
 *   1. an explicit path (the CLI's `--tesseract`) — overrides WHICH BINARY, and
 *      nothing else: the version check and the tessdata verification still run
 *   2. the dev checkout's `vendor/tesseract/<platform>/`, when there is one
 *   3. the platform data dir, `<data>/foundry/vendor/tesseract/<platform>/` —
 *      where `foundry models pull` puts the downloaded bundle
 *
 * PATH is never consulted. Picking up whatever `tesseract` happens to be
 * installed silently shifts the input distribution the models were trained
 * against: layout analysis changes between Tesseract versions, blocks come out
 * differently grouped, labels get slightly worse, and every symptom points at
 * the models (ARCHITECTURE §5). A missing vendored Tesseract is an error naming
 * every path that was checked and the command that fetches it — not a reason to
 * go looking elsewhere.
 */
export async function resolveTesseract(options: TesseractOptions = {}): Promise<ResolvedTesseract> {
  const lang = options.lang ?? 'eng';
  const manifest = options.manifest ?? MANIFEST;

  if (manifest.dpi !== OCR_DPI) {
    throw new Error(
      `The Tesseract pin is defined at ${manifest.dpi} dpi but this build renders at ${OCR_DPI} dpi. ` +
        `The pin and the renderer must agree — see the OCR_DPI comment in src/scan/tesseract.ts.`,
    );
  }

  const key = platformKey();
  const pin = requirePin(key, manifest);

  // 1. the vendor root: the first one that actually holds this platform's binary.
  const roots = vendorRoots(options.vendorDir);
  const vendorDir = roots.find((root) => fs.existsSync(path.join(root, pin.binary)));

  // 2. the binary. An explicit --tesseract does not need a vendor root to exist
  //    for the BINARY, but the tessdata still comes from one, so a missing root
  //    is still an error — just a different one, raised below.
  const binary = options.binaryPath ?? (vendorDir ? path.join(vendorDir, pin.binary) : null);
  if (!binary || !fs.existsSync(binary)) {
    if (options.binaryPath) {
      throw new Error(
        `No Tesseract binary at the path given with --tesseract (${options.binaryPath}).`,
      );
    }
    throw new Error(
      `No vendored Tesseract for ${key}. Checked:\n` +
        roots.map((r) => `  ${path.join(r, pin.binary)}`).join('\n') +
        `\n\nRun \`foundry models pull\` to download it` +
        (pin.artifact ? ` (${pin.artifact.name}, ${mib(pin.artifact.bytes)})` : '') +
        `.\n\nPATH is deliberately NOT searched: the models were trained against the ` +
        `segmentation of one exact Tesseract build, and a different one degrades them ` +
        `silently rather than failing.`,
    );
  }

  if (!options.binaryPath && pin.binarySha256) {
    const got = await sha256(binary);
    if (got !== pin.binarySha256) {
      throw new Error(
        `Vendored Tesseract does not match the pin: ${binary}\n` +
          `  expected sha256 ${pin.binarySha256}\n  got      sha256 ${got}\n` +
          `A binary that is not the pinned one is not used, and it is not "probably fine".`,
      );
    }
  }

  // 3. the version — run even for an explicit --tesseract, which overrides
  //    which binary is used and nothing else. The expectation is the PLATFORM's:
  //    no single version number exists as a real build everywhere.
  const version = await readVersion(binary);
  if (version !== pin.expectedVersion) {
    throw new Error(
      `Tesseract version mismatch: ${binary} reports ${version}, the pin for ${key} is ` +
        `${pin.expectedVersion}. Layout analysis moves between versions, so this is a ` +
        `different segmenter from the one the models were trained against, not a near-enough one.`,
    );
  }

  if (!vendorDir) {
    throw new Error(
      `--tesseract named a binary, but the pinned language data for ${key} is not on this ` +
        `machine. Checked:\n` +
        roots.map((r) => `  ${path.join(r, pin.tessdataDir)}`).join('\n') +
        `\n\nRun \`foundry models pull\` to download the vendor bundle. --tesseract overrides ` +
        `which binary runs; it does not replace the pinned tessdata.`,
    );
  }

  // 4. the libraries beside the binary, where the platform ships any. On Windows
  //    tesseract.exe is a launcher and libtesseract-5.dll is the engine, so
  //    leaving these unchecked would verify the wrapper and not the segmenter.
  const platformDir = path.dirname(path.join(vendorDir, pin.binary));
  for (const [file, want] of Object.entries(pin.libraries ?? {})) {
    await verifyFile(path.join(platformDir, file), want, 'A pinned Tesseract library');
  }

  // 3. the tessdata. Passed explicitly on every invocation with --tessdata-dir,
  //    because TESSDATA_PREFIX is set by whichever package manager installed
  //    something else, and a Tesseract resolved from anywhere else then reports
  //    zero languages and cannot read a page.
  const tessdataDir = path.join(vendorDir, pin.tessdataDir);
  const wanted = `${lang}.traineddata`;
  const entry = pin.tessdata[wanted];
  if (!entry) {
    throw new Error(
      `The pin for ${key} records no ${wanted}. Pinned language data: ` +
        `${Object.keys(pin.tessdata).join(', ') || '(none)'}.`,
    );
  }
  for (const [file, want] of Object.entries(pin.tessdata)) {
    await verifyFile(path.join(tessdataDir, file), want, 'Pinned language data');
  }

  return { binary, tessdataDir, lang, version, platform: key, manifest };
}

/** Size then hash, so a truncated file reads as truncated rather than as wrong. */
async function verifyFile(full: string, want: TessdataEntry, what: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(full);
  } catch {
    throw new Error(`${what} is missing: ${full}`);
  }
  if (stat.size !== want.bytes) {
    throw new Error(`${full}: pinned at ${want.bytes} bytes, found ${stat.size}`);
  }
  const got = await sha256(full);
  if (got !== want.sha256) {
    throw new Error(
      `${full} does not match the pin\n  expected sha256 ${want.sha256}\n  got      sha256 ${got}`,
    );
  }
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

/** The first line of `tesseract --version`, e.g. "tesseract 5.5.1" -> "5.5.1". */
async function readVersion(binary: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['--version'], { encoding: 'utf-8' }));
  } catch (err) {
    // Tesseract writes --version to stdout, but some builds use stderr; a
    // nonzero exit with usable output is still an answer, and anything else is
    // a real failure that gets named.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout || e.stderr || '';
    if (!stdout) throw new Error(`${binary} --version failed: ${e.message ?? 'no output'}`);
  }
  const first = stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const m = /^tesseract\s+(\S+)/i.exec(first);
  if (!m) throw new Error(`${binary} --version did not report a tesseract version; it said: ${first}`);
  return m[1]!;
}

// ---------------------------------------------------------------- recognition

export interface RecognizedLine {
  /** The band's TIGHT box in render pixels — the crop was that box plus padding. */
  bbox: [number, number, number, number];
  text: string;
  /** Mean word confidence, 0-100, or null when the crop produced no words. */
  conf: number | null;
  /** Which psm produced this line: 7, or 13 when the rescue pass did. */
  psm: number;
}

export interface PageRecognition {
  page: number;
  widthPx: number;
  heightPx: number;
  lines: RecognizedLine[];
  /** How many bands only the psm-13 rescue could read. */
  rescued: number;
}

/**
 * One tesseract over an image list; one entry out per image, in list order.
 *
 * The crops of a page go to ONE process as an image list (a text file of image
 * paths) rather than one process per crop: process start-up dominates a crop
 * that small — 4.0 s for a 44-line page in the metric-C sample, almost all of it
 * spent loading the language model 44 times.
 *
 * The output is read as TSV rather than plain text because its `page_num`
 * column ties every word back to the image it came from, which is a guarantee
 * the plain-text form cannot give: there the images are separated by form feeds
 * and a blank line is indistinguishable from a missing one. TSV also carries
 * per-word confidence, which is what the caller gets.
 *
 * No fallbacks: a run that fails, or whose output does not account for every
 * crop, throws.
 */
export async function recognizeImageList(
  tess: ResolvedTesseract,
  imagePaths: string[],
  psm: number = PSM_SINGLE_LINE,
): Promise<Array<{ text: string; conf: number | null }>> {
  if (imagePaths.length === 0) return [];
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-tess-'));
  try {
    const listPath = path.join(dir, 'list.txt');
    await fsp.writeFile(listPath, `${imagePaths.join('\n')}\n`);
    // Note the argument shape: it is run-book.py's, exactly. In particular
    // there is no --oem: Tesseract 5 defaults to LSTM, and the corpus this
    // pipeline's models were trained on came from a call without it.
    const args = [
      listPath,
      'stdout',
      '--psm',
      String(psm),
      '--dpi',
      String(OCR_DPI),
      '-l',
      tess.lang,
      '--tessdata-dir',
      tess.tessdataDir,
      'tsv',
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(tess.binary, args, {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        // One page per process already, so the OpenMP pool inside each one only
        // fights the pool in every other one.
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      }));
    } catch (err) {
      const e = err as { code?: number; stderr?: string; message?: string };
      throw new Error(
        `tesseract exited ${e.code ?? '?'}: ${(e.stderr ?? e.message ?? '').trim().slice(-400)}`,
      );
    }
    return parseTsv(stdout, imagePaths.length);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Tesseract's TSV, one row per level, into one text+confidence per image.
 *
 * A level-1 row is the page record for an image; every image must produce one,
 * and an output that accounts for fewer images than were handed in means crops
 * went unread — which is the silent-loss failure this whole pipeline exists to
 * end, so it throws rather than returning a short list.
 */
export function parseTsv(stdout: string, imageCount: number): Array<{ text: string; conf: number | null }> {
  const words: string[][] = Array.from({ length: imageCount }, () => []);
  const confs: number[][] = Array.from({ length: imageCount }, () => []);
  const seen = new Set<number>();

  for (const row of stdout.split(/\r?\n/)) {
    if (!row || row.startsWith(TSV_HEADER)) continue;
    const f = row.split('\t');
    if (f.length < 12) continue;
    const level = Number.parseInt(f[0]!, 10);
    const pageNum = Number.parseInt(f[1]!, 10);
    if (!Number.isInteger(level) || !Number.isInteger(pageNum)) continue;
    const i = pageNum - 1; // tesseract counts images from 1
    if (i < 0 || i >= imageCount) {
      throw new Error(`tesseract reported image ${pageNum} of ${imageCount}`);
    }
    if (level === 1) {
      seen.add(i);
      continue;
    }
    if (level !== 5) continue;
    const text = f[11]!.trim();
    if (!text) continue;
    words[i]!.push(text);
    const conf = Number.parseFloat(f[10]!);
    if (Number.isFinite(conf)) confs[i]!.push(conf);
  }
  if (seen.size !== imageCount) {
    throw new Error(`tesseract accounted for ${seen.size} of ${imageCount} crops`);
  }
  return words.map((w, i) => {
    const c = confs[i]!;
    const sum = c.reduce((a, b) => a + b, 0);
    return { text: w.join(' '), conf: c.length ? pyRoundTo(sum / c.length, 2) : null };
  });
}

/**
 * Read every band of one page.
 *
 * The crops are written as binary PGM, which leptonica reads and which this
 * program can write without an image encoder — the same reason `bands.ts` takes
 * a raster rather than a file (see pgm.ts). The raster handed in must be the one
 * the bands were measured on: on a page with a nonzero `deskewDeg` that is the
 * DESKEWED raster, or the crops are off by the page's own tilt.
 *
 * There is exactly one entry out per band, in band order, and a band that read
 * as nothing keeps its place with "". A dropped line is a silent loss.
 */
export async function recognizeBands(
  tess: ResolvedTesseract,
  raster: GrayRaster,
  bands: Band[],
  page: number,
): Promise<PageRecognition> {
  const result: PageRecognition = {
    page,
    widthPx: raster.width,
    heightPx: raster.height,
    lines: [],
    rescued: 0,
  };
  if (bands.length === 0) return result;

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `foundry-page${page}-`));
  try {
    const paths: string[] = [];
    for (let i = 0; i < bands.length; i++) {
      const crop = bands[i]!.crop;
      const x0 = Math.max(0, crop[0]);
      const y0 = Math.max(0, crop[1]);
      const x1 = Math.min(raster.width, crop[2]);
      const y1 = Math.min(raster.height, crop[3]);
      if (x1 <= x0 || y1 <= y0) {
        throw new Error(`page ${page}: band ${i} has an empty crop [${crop.join(', ')}]`);
      }
      const file = path.join(dir, `b${String(i).padStart(4, '0')}.pgm`);
      await fsp.writeFile(file, writePgm(subRaster(raster, x0, y0, x1, y1)));
      paths.push(file);
    }

    const texts = await recognizeImageList(tess, paths, PSM_SINGLE_LINE);
    const psms = new Array<number>(paths.length).fill(PSM_SINGLE_LINE);
    const blank = texts.map((t, i) => (t.text ? -1 : i)).filter((i) => i >= 0);
    if (blank.length) {
      const again = await recognizeImageList(
        tess,
        blank.map((i) => paths[i]!),
        RESCUE_PSM,
      );
      for (let k = 0; k < blank.length; k++) {
        if (again[k]!.text) {
          texts[blank[k]!] = again[k]!;
          psms[blank[k]!] = RESCUE_PSM;
          result.rescued += 1;
        }
      }
    }
    for (let i = 0; i < bands.length; i++) {
      result.lines.push({
        bbox: [...bands[i]!.tight] as [number, number, number, number],
        text: texts[i]!.text,
        conf: texts[i]!.conf,
        psm: psms[i]!,
      });
    }
    return result;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function subRaster(raster: GrayRaster, x0: number, y0: number, x1: number, y1: number): GrayRaster {
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    data.set(raster.data.subarray((y0 + y) * raster.width + x0, (y0 + y) * raster.width + x1), y * width);
  }
  return { width, height, data };
}
