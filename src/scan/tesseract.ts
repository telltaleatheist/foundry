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
 * resolved binary's `--version` and every tessdata file's sha256 are compared
 * against `vendor/tesseract/manifest.json` before a single page is read, and a
 * mismatch is an error naming the file (ARCHITECTURE §5).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

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

export interface TesseractPlatformPin {
  /** Path to the binary, relative to the vendor root. */
  binary: string;
  /** sha256 of that binary, or null when the platform is not vendored yet. */
  binarySha256: string | null;
  /** Directory holding `<lang>.traineddata`, relative to the vendor root. */
  tessdataDir: string;
  tessdata: Record<string, TessdataEntry>;
  /** False when the recorded binary is not relocatable — see vendor/tesseract/README.md. */
  portable: boolean;
  note?: string;
}

export interface TesseractManifest {
  /** The exact version string this build of Foundry was measured against. */
  expectedVersion: string;
  /** The dpi the pin is defined at. Cross-checked against OCR_DPI. */
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
  /** Vendor root; defaults to `vendor/tesseract` in the repo/install. */
  vendorDir?: string;
  /** Language, and the tessdata file that must verify. */
  lang?: string;
}

/** `<platform>-<arch>`, the key into the manifest. */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function defaultVendorDir(): string {
  // src/scan/tesseract.ts -> <root>/vendor/tesseract
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'vendor', 'tesseract');
}

/**
 * Resolve the binary and the tessdata, and verify BOTH against the manifest.
 *
 * Resolution order, and there is no third entry:
 *   1. an explicit path (the CLI's `--tesseract`)
 *   2. `vendor/tesseract/<platform>/`
 *
 * PATH is never consulted. Picking up whatever `tesseract` happens to be
 * installed silently shifts the input distribution the models were trained
 * against: layout analysis changes between Tesseract versions, blocks come out
 * differently grouped, labels get slightly worse, and every symptom points at
 * the models (ARCHITECTURE §5). A missing vendored Tesseract is an error that
 * says which paths were checked, not a reason to go looking elsewhere.
 */
export async function resolveTesseract(options: TesseractOptions = {}): Promise<ResolvedTesseract> {
  const lang = options.lang ?? 'eng';
  const vendorDir = options.vendorDir ?? defaultVendorDir();
  const manifestPath = path.join(vendorDir, 'manifest.json');

  let manifest: TesseractManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as TesseractManifest;
  } catch (err) {
    throw new Error(
      `No Tesseract pin: ${manifestPath} could not be read (${(err as Error).message}). ` +
        `The manifest records the expected version and the tessdata hashes; without it there is ` +
        `nothing to verify against, and an unverified Tesseract is not one this program will use.`,
    );
  }
  if (manifest.dpi !== OCR_DPI) {
    throw new Error(
      `${manifestPath} pins ${manifest.dpi} dpi but this build renders at ${OCR_DPI} dpi. ` +
        `The pin and the renderer must agree — see the OCR_DPI comment in src/scan/tesseract.ts.`,
    );
  }

  const key = platformKey();
  const pin = manifest.platforms[key];
  if (!pin) {
    throw new Error(
      `${manifestPath} has no pin for ${key}. Vendored platforms: ` +
        `${Object.keys(manifest.platforms).join(', ') || '(none)'}. ` +
        `Run tools/scan-vendor-tesseract.sh on a machine of this platform to record one.`,
    );
  }

  // 1. the binary
  const vendored = path.join(vendorDir, pin.binary);
  const binary = options.binaryPath ?? vendored;
  if (!fs.existsSync(binary)) {
    const checked = options.binaryPath
      ? `the path given with --tesseract (${options.binaryPath})`
      : `the vendored binary (${vendored})`;
    throw new Error(
      `No Tesseract binary at ${checked}. PATH is deliberately NOT searched: the models were ` +
        `trained against the segmentation of one exact Tesseract build, and a different one ` +
        `degrades them silently. Vendor ${pin.binary} or pass --tesseract <path>.`,
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

  // 2. the version — run even for an explicit --tesseract, which overrides
  //    which binary is used and nothing else.
  const version = await readVersion(binary);
  if (version !== manifest.expectedVersion) {
    throw new Error(
      `Tesseract version mismatch: ${binary} reports ${version}, the pin is ` +
        `${manifest.expectedVersion}. Layout analysis moves between versions, so this is a ` +
        `different segmenter from the one the models were trained against, not a near-enough one.`,
    );
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
    const full = path.join(tessdataDir, file);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(full);
    } catch {
      throw new Error(`Pinned language data is missing: ${full}`);
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

  return { binary, tessdataDir, lang, version, platform: key, manifest };
}

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
