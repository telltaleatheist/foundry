/**
 * vlm/raster — the page pixels and the PDF's own text layer, on MuPDF.
 *
 * THIS WAS `vlm_page.py`, and it is the same engine. The helper rasterised in
 * PyMuPDF because the TypeScript side had no rasteriser (pdf.js is embedded for
 * text only, with a deliberately broken DOMMatrix — `src/pdf/runtime.ts`), and
 * the page image was crossing a Python seam anyway for the MLX reader. Owen,
 * 2026-11-04: Foundry always ships with Crucible, so every model call goes to
 * Crucible — the local MLX `read` mode is RETIRED, and with it the only reason
 * for an interpreter. What the helper did besides reading is ported here,
 * faithfully, onto the official `mupdf` package: the same MuPDF C library
 * PyMuPDF wraps, compiled to WebAssembly. Three jobs, one module:
 *
 *    render     render every page of a source              (the endpoint path)
 *    crop       cut named boxes out of named pages          (Picture blocks)
 *    textlayer  report every text span the PDF itself carries (facsimile sizing)
 *
 * The page images ARE the models' input, so "faithful" is measured, not
 * assumed: the same pages of real PDFs rendered through the helper and through
 * this module, pixel for pixel (docs/FOUNDRY-CORE-BASELINE.md, "A2").
 *
 * ── WHY `mupdf` IS LOADED AT RUN TIME AND NOT BUNDLED ───────────────────────
 *
 * It is an ES module that awaits its WebAssembly at top level, and the engine
 * is a CommonJS bundle (tools/build-engine.mjs): esbuild cannot fold a
 * top-level await into CommonJS, and Node 20 cannot `require()` it. So it stays
 * a real dependency of the package — installed beside the bundle, the way any
 * consumer's npm puts it — and is imported by URL the first time a page is
 * needed. The URL is resolved from THIS file (the bundle, in a build), so it is
 * the copy installed next to the engine that runs, and a command that never
 * touches a page never pays for the WebAssembly.
 *
 * ── WHAT IS STILL TRUE FROM THE HELPER ──────────────────────────────────────
 *
 * 200 DPI is not a setting here either — it is passed in (`read.ts`'s VLM_DPI,
 * or the server's contract) and never chosen. NO SILENT FALLBACKS: a page that
 * renders to nothing and a crop that lands outside its page are each fatal and
 * named. A page in `excludePages` is not rasterised and not emitted, and every
 * page that survives keeps its own number. The one grid for a book of
 * nearly-identical pages (`dominantRenderSize`) is the helper's arithmetic,
 * including Python's rounding.
 *
 * MuPDF's own warnings go to stderr, named as MuPDF's (`setLog` below). The
 * helper had to point file descriptor 1 at stderr to keep them out of its
 * protocol; in-process there is no protocol to corrupt, but `vlm-blocks` writes
 * its result to stdout, so they are routed explicitly rather than left to a
 * default.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';

import { ensureDir } from '../fsdirs.js';

type Mupdf = typeof import('mupdf');
type Pixmap = import('mupdf').Pixmap;
type PDFPage = import('mupdf').PDFPage;
type Page = import('mupdf').Page;
type Doc = import('mupdf').Document;
type Rect = [number, number, number, number];

export class RasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RasterError';
  }
}

let loading: Promise<Mupdf> | null = null;

/** The MuPDF module, loaded once per process, its log pointed at stderr. */
export function loadMupdf(): Promise<Mupdf> {
  loading ??= (async () => {
    let entry: string;
    try {
      entry = createRequire(import.meta.url).resolve('mupdf');
    } catch (err) {
      throw new RasterError(
        'the `mupdf` package is not installed beside the engine, so no page can be rasterised '
        + `(${err instanceof Error ? err.message : String(err)}). It is a dependency of @owen/foundry-core; `
        + 'reinstall the package.',
      );
    }
    const mupdf = await import(pathToFileURL(entry).href) as Mupdf;
    mupdf.setLog({
      warning: (message) => process.stderr.write(`MuPDF warning: ${message}\n`),
      error: (message) => process.stderr.write(`MuPDF error: ${message}\n`),
    });
    return mupdf;
  })();
  return loading;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing a page or a crop to disk
// ─────────────────────────────────────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Bytes onto the disk, without betting the run on a Windows delete.
 *
 * The helper's `write_png`, unchanged in substance: one stale PNG held open by
 * a viewer, a sync client or an antivirus pass killed an entire read landing
 * once (2026-08-16, a re-read over an existing project). So: truncate-and-write
 * first (a reader that shares writing permits it while blocking every rename),
 * then a sibling `.part` moved over the target, five attempts 200 ms apart, and
 * then the failure is the real one, named, with the file it is about.
 */
export function writeImageFile(data: Uint8Array, file: string): void {
  let last: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) sleepSync(200);
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      last = err;
    }
    const tmp = `${file}.part`;
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      last = err;
      try { fs.unlinkSync(tmp); } catch { /* the temp file may never have been made */ }
    }
  }
  throw new RasterError(
    `${file} could not be written (${last instanceof Error ? last.message : String(last)}). Something on this `
    + 'machine is holding the old file open — a window showing it, a sync client, an antivirus scan. Close it '
    + 'and run again; the readings are banked, so nothing is read twice.',
  );
}

/**
 * The grayscale raster, as the one image format foundry reads with no codec —
 * binary P5, one whitespace after the header, maxval 255 (`src/scan/pgm.ts`).
 * Nothing opens one any more; see `grayscale` in `bridge.ts` for why it is
 * still written.
 */
function writePgm(file: string, mupdf: Mupdf, pixmap: Pixmap): void {
  const gray = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceGray, false);
  try {
    const width = gray.getWidth();
    const height = gray.getHeight();
    const stride = gray.getStride();
    const samples = gray.getPixels();
    if (stride !== width) {
      throw new RasterError(
        `a grayscale pixmap of ${width}x${height} carried ${stride * height} bytes, so its rows are padded and `
        + 'this writer would mis-shape them',
      );
    }
    const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'latin1');
    fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, width * height)]));
  } finally {
    gray.destroy();
  }
}

/**
 * A pixmap as PNG bytes, its samples AS THEY ARE.
 *
 * mupdf.js's `asPNG` converts an ICC-tagged pixmap to sRGB on the way out;
 * PyMuPDF's `tobytes('png')` wrote the raw samples and the profile beside them
 * in an iCCP chunk. A page reader decoding the file (PIL, in a server) reads
 * the raw samples and leaves the profile alone, so the raw samples are what a
 * model was shown — and they are what is written here. A photograph that
 * arrived with a profile keeps it: `icc` is the profile read out of the source
 * file (`iccProfileOf`), spliced in as the iCCP chunk PyMuPDF wrote, named as
 * MuPDF names the colourspace.
 */
export function pngBytes(mupdf: Mupdf, pixmap: Pixmap, icc: Uint8Array | null = null): Uint8Array {
  const colorspace = pixmap.getColorSpace();
  if (colorspace === null || !colorspace.getName().startsWith('ICCBased')) return pixmap.asPNG();
  const device = colorspace.isGray() ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const relabelled = new mupdf.Pixmap(device, pixmap.getBounds() as Rect, pixmap.getAlpha() !== 0);
  try {
    relabelled.getPixels().set(pixmap.getPixels());
    relabelled.setResolution(pixmap.getXResolution(), pixmap.getYResolution());
    const png = relabelled.asPNG();
    return icc === null ? png : withIccp(png, colorspace.getName(), icc);
  } finally {
    relabelled.destroy();
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** The PNG with an iCCP chunk before its first IDAT. */
function withIccp(png: Uint8Array, name: string, profile: Uint8Array): Uint8Array {
  const bytes = Buffer.from(png);
  const keyword = Buffer.from(name.slice(0, 79), 'latin1');
  const chunk = pngChunk('iCCP', Buffer.concat([keyword, Buffer.from([0, 0]), zlib.deflateSync(profile)]));
  let at = PNG_SIGNATURE.length;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') break;
    at += 12 + length;
  }
  return Buffer.concat([bytes.subarray(0, at), chunk, bytes.subarray(at)]);
}

/**
 * The ICC profile embedded in a PNG (iCCP) or a JPEG (APP2 ICC_PROFILE
 * segments, in sequence), or null — the bytes MuPDF built the image's
 * colourspace from, and so the bytes PyMuPDF wrote back out.
 */
export function iccProfileOf(file: Buffer): Uint8Array | null {
  if (file.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let at = 8;
    while (at + 8 <= file.length) {
      const length = file.readUInt32BE(at);
      const type = file.toString('latin1', at + 4, at + 8);
      if (type === 'iCCP') {
        const data = file.subarray(at + 8, at + 8 + length);
        const end = data.indexOf(0);
        return zlib.inflateSync(data.subarray(end + 2));
      }
      if (type === 'IDAT') return null;
      at += 12 + length;
    }
    return null;
  }
  if (file[0] === 0xff && file[1] === 0xd8) {
    const parts: Buffer[] = [];
    let at = 2;
    while (at + 4 <= file.length && file[at] === 0xff) {
      const marker = file[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = file.readUInt16BE(at + 2);
      const body = file.subarray(at + 4, at + 2 + length);
      if (marker === 0xe2 && body.toString('latin1', 0, 12) === 'ICC_PROFILE\0') parts[body[12] - 1] = body.subarray(14);
      at += 2 + length;
    }
    return parts.length > 0 && parts.every(Boolean) ? Buffer.concat(parts) : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Python's arithmetic, where the helper's numbers depend on it
// ─────────────────────────────────────────────────────────────────────────────

/** Python's `round(x)` to an integer: ties go to the even neighbour. */
export function pyRoundInt(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Python's `round(x, 2)`: the double's exact decimal value, rounded, ties to
 * even. `toFixed` rounds that same exact value but sends a tie UP; an exact tie
 * at the third decimal is only possible when x is an odd multiple of 1/8 (the
 * only such decimals a double holds exactly), so that is the case corrected.
 */
export function pyRound2(x: number): number {
  const eighths = x * 8;
  if (Number.isInteger(eighths) && !Number.isInteger(x * 4)) {
    const hundredths = x * 100; // exact: an odd multiple of 12.5
    const down = Math.floor(hundredths);
    return (down % 2 === 0 ? down : down + 1) / 100;
  }
  return Number(x.toFixed(2));
}

/** Python's `str.strip()` with no argument: Unicode whitespace (str.isspace). */
const PY_SPACE_CLASS = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_SPACE = new RegExp(`^${PY_SPACE_CLASS}+|${PY_SPACE_CLASS}+$`, 'g');
export function pyStrip(text: string): string {
  return text.replace(PY_SPACE, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Where a page comes from
//
// A READ TAKES PAGES; A PDF IS ONE WAY TO HAVE SOME (Owen, 2026-08-20). Two
// sources answering the same questions, so nothing downstream of `render` can
// tell which one it holds — the helper's `PdfPages` and `ImagePages`.
// ─────────────────────────────────────────────────────────────────────────────

interface PageSource {
  readonly name: string;
  readonly count: number;
  credits(): { title: string; author: string };
  frame(): { width: number; height: number };
  render(index: number, dpi: number): Pixmap;
  /** The ICC profile a page arrived with, for its PNG (`pngBytes`). */
  icc(index: number): Uint8Array | null;
  close(): void;
}

/** Pages rasterised out of a PDF, at a dpi. */
export class PdfPages implements PageSource {
  readonly doc: Doc;
  readonly name: string;
  private readonly pages = new Map<number, Page>();

  constructor(readonly mupdf: Mupdf, file: string) {
    this.name = file;
    // Opened from its bytes with the path as the type hint — the extension
    // `fitz.open(path)` went by.
    this.doc = mupdf.Document.openDocument(fs.readFileSync(file), file);
  }

  get count(): number {
    return this.doc.countPages();
  }

  page(index: number): Page {
    let page = this.pages.get(index);
    if (page === undefined) {
      page = this.doc.loadPage(index);
      this.pages.set(index, page);
    }
    return page;
  }

  credits(): { title: string; author: string } {
    return {
      title: pyStrip(this.doc.getMetaData('info:Title') ?? ''),
      author: pyStrip(this.doc.getMetaData('info:Author') ?? ''),
    };
  }

  frame(): { width: number; height: number } {
    const [x0, y0, x1, y1] = this.page(0).getBounds();
    return { width: x1 - x0, height: y1 - y0 };
  }

  /** `page.get_pixmap(dpi=dpi)`: scaled by dpi/72 both ways, RGB, no alpha, annotations drawn, resolution stamped. */
  render(index: number, dpi: number): Pixmap {
    const zoom = dpi / 72;
    const pixmap = this.page(index).toPixmap([zoom, 0, 0, zoom, 0, 0], this.mupdf.ColorSpace.DeviceRGB, false, true);
    pixmap.setResolution(dpi, dpi);
    return pixmap;
  }

  /**
   * This page's TRUE render size in pixels, without drawing it: the page box in
   * points times dpi/72, which is the grid `render` produces. Reads a rectangle
   * and multiplies; nothing is rasterised.
   */
  renderSize(index: number, dpi: number): [number, number] {
    const [x0, y0, x1, y1] = this.page(index).getBounds();
    return [(x1 - x0) * dpi / 72, (y1 - y0) * dpi / 72];
  }

  /**
   * Draw the page onto an EXACT width x height grid — the snap. Only the page
   * box a snapped page is drawn to moves (by at most the band); the size then
   * reported is the pixmap's own, so the box-to-render mapping (`renderScale`,
   * dots.ts) stays exact either way.
   */
  renderTo(index: number, width: number, height: number): Pixmap {
    const [x0, y0, x1, y1] = this.page(index).getBounds();
    return this.page(index).toPixmap(
      [width / (x1 - x0), 0, 0, height / (y1 - y0), 0, 0], this.mupdf.ColorSpace.DeviceRGB, false, true,
    );
  }

  /** A PDF page is drawn in DeviceRGB: no profile travels with it. */
  icc(_index: number): Uint8Array | null {
    return null;
  }

  close(): void {
    for (const page of this.pages.values()) page.destroy();
    this.pages.clear();
    this.doc.destroy();
  }
}

/**
 * Pages that are ALREADY pictures — a capture project's photographs.
 *
 * `dpi` is accepted and ignored: a photograph arrives with its pixels already
 * chosen. Colour is normalised so a page reaches the model as something it can
 * read: an alpha channel is dropped and anything not grey or RGB (a scanner's
 * CMYK TIFF) is converted rather than refused — `fitz.Pixmap(path)`, then
 * `Pixmap(pix, 0)`, then `Pixmap(csRGB, pix)`, as the helper did.
 */
export class ImagePages implements PageSource {
  readonly name: string;
  private readonly paths: string[];

  constructor(private readonly mupdf: Mupdf, paths: readonly string[]) {
    this.paths = [...paths];
    this.name = `${this.paths.length} page image(s)`;
    const missing = this.paths.find((p) => !fs.existsSync(p));
    if (missing !== undefined) throw new RasterError(`no such page image: ${missing}`);
  }

  get count(): number {
    return this.paths.length;
  }

  /** A photograph carries no title and no author, and none is invented. */
  credits(): { title: string; author: string } {
    return { title: '', author: '' };
  }

  /** Reported as points because that is the field's name; a photograph's pixels ARE its frame. */
  frame(): { width: number; height: number } {
    const pixmap = this.render(0, 0);
    try {
      return { width: pixmap.getWidth(), height: pixmap.getHeight() };
    } finally {
      pixmap.destroy();
    }
  }

  render(index: number, _dpi: number): Pixmap {
    const image = new this.mupdf.Image(fs.readFileSync(this.paths[index]));
    let pixmap = image.toPixmap();
    image.destroy();
    if (pixmap.getAlpha()) {
      const opaque = dropAlpha(this.mupdf, pixmap);
      pixmap.destroy();
      pixmap = opaque;
    }
    const colorspace = pixmap.getColorSpace();
    const n = colorspace === null ? 0 : colorspace.getNumberOfComponents();
    if (n !== 1 && n !== 3) {
      const rgb = pixmap.convertToColorSpace(this.mupdf.ColorSpace.DeviceRGB, false);
      pixmap.destroy();
      pixmap = rgb;
    }
    return pixmap;
  }

  icc(index: number): Uint8Array | null {
    return iccProfileOf(fs.readFileSync(this.paths[index]));
  }

  close(): void {}
}

/**
 * `fitz.Pixmap(pix, 0)`: the same colourspace without the alpha channel, the
 * colour samples copied as they are (MuPDF keeps them premultiplied, so a
 * transparent pixel comes out dark — what the helper handed the model).
 * MuPDF's own conversion refuses to drop alpha, so this is PyMuPDF's copy.
 */
function dropAlpha(mupdf: Mupdf, pixmap: Pixmap): Pixmap {
  const colorspace = pixmap.getColorSpace();
  if (colorspace === null) throw new RasterError("cannot drop alpha for 'NULL' colorspace");
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const x = pixmap.getX();
  const y = pixmap.getY();
  const out = new mupdf.Pixmap(colorspace, [x, y, x + width, y + height], false);
  out.setResolution(pixmap.getXResolution(), pixmap.getYResolution());
  const colorants = colorspace.getNumberOfComponents();
  const inN = pixmap.getNumberOfComponents(); // MuPDF's n counts the alpha channel
  const from = pixmap.getPixels();
  const to = out.getPixels();
  const inStride = pixmap.getStride();
  const outStride = out.getStride();
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const s = row * inStride + col * inN;
      const d = row * outStride + col * colorants;
      for (let k = 0; k < colorants; k += 1) to[d + k] = from[s + k];
    }
  }
  return out;
}

export type RasterSource =
  | { readonly kind: 'pdf'; readonly path: string }
  | { readonly kind: 'pages'; readonly paths: readonly string[] };

function openSource(mupdf: Mupdf, source: RasterSource): PdfPages | ImagePages {
  return source.kind === 'pdf' ? new PdfPages(mupdf, source.path) : new ImagePages(mupdf, source.paths);
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE GRID FOR A BOOK OF NEARLY-IDENTICAL PAGES
//
// A batching VLM server groups pages of the SAME processor grid, and a scanned
// book's +/-1-2% page-size jitter lands leaves of one book on ADJACENT grids, so
// the batches go shallow and the run runs about twice as slow. The book's
// dominant render size — its "mode" — is computed once over every page's true
// render size, and any page within the band of it on BOTH axes is drawn AT the
// mode. dpi and maxPixels never move; only the page box a snapped page is drawn
// to. The mode is computed on the RENDER size (page box x dpi/72), post-dpi and
// pre-smartResize.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 4%, per axis, independent. Measured jitter on a real scanned book was +/-1.5%
 * on both axes with one true outlier at +8%: 4% is twice the jitter and half
 * the outlier's distance, so the cluster collapses and the outlier keeps its grid.
 */
export const SNAP_BAND = 0.04;

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

export function withinBand(value: number, mode: number): boolean {
  return Math.abs(value - mode) <= SNAP_BAND * mode;
}

/** Does a page of `size` collapse onto `mode`? Within the band on width AND height. */
export function snapsTo(size: readonly [number, number], mode: readonly [number, number]): boolean {
  return withinBand(size[0], mode[0]) && withinBand(size[1], mode[1]);
}

/**
 * The book's dominant render size, or null for no pages: the median of the
 * pages within the band of the book's overall median, per axis — the clean
 * centre of the pages that agree with one another, the fold-out dropped out of
 * the number entirely. Rounded the way Python's `round` rounds.
 */
export function dominantRenderSize(sizes: readonly (readonly [number, number])[]): [number, number] | null {
  if (sizes.length === 0) return null;
  const medW = median(sizes.map(([w]) => w));
  const medH = median(sizes.map(([, h]) => h));
  const cluster = sizes.filter(([w, h]) => withinBand(w, medW) && withinBand(h, medH));
  if (cluster.length === 0) return null;
  return [pyRoundInt(median(cluster.map(([w]) => w))), pyRoundInt(median(cluster.map(([, h]) => h)))];
}

// ─────────────────────────────────────────────────────────────────────────────
// render — every page of a source, read by none of them
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderedDocument {
  pages: number;
  title: string;
  author: string;
  widthPt: number;
  heightPt: number;
  renderMode: [number, number] | null;
}

export interface RenderedPage {
  number: number;
  width: number;
  height: number;
  renderSeconds: number;
}

export interface RenderOptions {
  source: RasterSource;
  dpi: number;
  /** Keep the PNGs here; without it they go to a scratch folder and are deleted page by page. */
  rendersDir?: string;
  grayscale?: boolean;
  /** Not part of the book: not rasterised, not emitted. */
  excludePages?: readonly number[];
  /** The mode an earlier run of this book chose — snap to exactly it. */
  renderMode?: readonly [number, number];
  /** Compute the book's mode and snap to it (ignored when `renderMode` is given). */
  snap?: boolean;
  onDocument?: (document: RenderedDocument) => void;
  /** Called with the page PNG still on disk; it is deleted after this returns unless `rendersDir` keeps it. */
  onPage?: (page: RenderedPage, imagePath: string) => void;
}

/** The helper's `read`/`render` loop, minus the reading. Returns the total render seconds. */
export async function renderPages(opts: RenderOptions): Promise<{ renderSeconds: number }> {
  const mupdf = await loadMupdf();
  const source = openSource(mupdf, opts.source);
  try {
    if (source.count === 0) throw new RasterError(`${source.name} has no pages`);
    const exclude = new Set(opts.excludePages ?? []);

    // How many pages the document has is known HERE and nowhere earlier, so the
    // two refusals that need that number are made here, before a page is drawn.
    const beyond = [...exclude].filter((p) => p > source.count).sort((a, b) => a - b);
    if (beyond.length > 0) {
      throw new RasterError(
        `--skip-pages names ${beyond.map((p) => `page ${p}`).join(', ')} of a ${source.count}-page document`,
      );
    }
    if (exclude.size >= source.count) {
      throw new RasterError(
        `--skip-pages names every page of the ${source.count}-page document, so there would be no book left to write`,
      );
    }

    // Only for a PDF: a photograph's pixels are somebody's measurement, and
    // resampling it to shave a 4% jitter is the second opinion ImagePages refuses.
    let mode: [number, number] | null = null;
    if (source instanceof PdfPages) {
      if (opts.renderMode !== undefined) {
        mode = [Math.trunc(opts.renderMode[0]), Math.trunc(opts.renderMode[1])];
      } else if (opts.snap === true) {
        const sizes: [number, number][] = [];
        for (let index = 0; index < source.count; index += 1) {
          if (!exclude.has(index + 1)) sizes.push(source.renderSize(index, opts.dpi));
        }
        mode = dominantRenderSize(sizes);
      }
    }

    const { title, author } = source.credits();
    const frame = source.frame();
    opts.onDocument?.({
      pages: source.count, title, author, widthPt: frame.width, heightPt: frame.height, renderMode: mode,
    });

    if (opts.rendersDir) ensureDir(opts.rendersDir);
    const scratch = opts.rendersDir
      ?? path.join(process.env['TMPDIR'] ?? '/tmp', `foundry-vlm-${process.pid}`);
    ensureDir(scratch);

    let total = 0;
    for (let index = 0; index < source.count; index += 1) {
      const number = index + 1;
      if (exclude.has(number)) {
        process.stderr.write(`  page ${number}/${source.count}: skipped\n`);
        continue;
      }
      const started = performance.now();
      const pixmap = mode !== null && source instanceof PdfPages && snapsTo(source.renderSize(index, opts.dpi), mode)
        ? source.renderTo(index, mode[0], mode[1])
        : source.render(index, opts.dpi);
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const image = path.join(scratch, `page-${String(number).padStart(4, '0')}.png`);
      try {
        writeImageFile(pngBytes(mupdf, pixmap, source.icc(index)), image);
        if (opts.grayscale === true) {
          writePgm(path.join(scratch, `page-${String(number).padStart(4, '0')}.pgm`), mupdf, pixmap);
        }
      } finally {
        pixmap.destroy();
      }
      const seconds = (performance.now() - started) / 1000;
      total += seconds;
      if (width === 0 || height === 0) throw new RasterError(`page ${number} rendered to a ${width}x${height} image`);
      opts.onPage?.({ number, width, height, renderSeconds: seconds }, image);
      if (!opts.rendersDir) fs.unlinkSync(image);
      process.stderr.write(`  page ${number}/${source.count}: rendered\n`);
    }
    return { renderSeconds: total };
  } finally {
    source.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// crop — boxes out of pages
// ─────────────────────────────────────────────────────────────────────────────

const FZ_EPSILON = Math.fround(0.001);
const f32 = Math.fround;

/** `fz_round_rect`, in MuPDF's float arithmetic. */
function roundRect(r: Rect): Rect {
  return [
    Math.floor(f32(f32(r[0]) + FZ_EPSILON)),
    Math.floor(f32(f32(r[1]) + FZ_EPSILON)),
    Math.ceil(f32(f32(r[2]) - FZ_EPSILON)),
    Math.ceil(f32(f32(r[3]) - FZ_EPSILON)),
  ];
}

function intersect(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function isEmpty(r: Rect): boolean {
  return r[0] >= r[2] || r[1] >= r[3];
}

export interface CropRequest {
  page: number;
  /** In the page RENDER's pixel frame. */
  box: readonly [number, number, number, number];
  name: string;
}

/**
 * Cut boxes out of pages — from the one source this run was given.
 *
 * A banked box is in THE PAGE RENDER'S PIXEL FRAME, and what "the render" is is
 * the only thing that differs between the faces:
 *
 *   pdf     the frame is the raster at the pinned dpi. The box goes back to
 *           POINTS (x * 72/dpi), is clipped against the page, and that patch is
 *           drawn AGAIN at the same dpi — `page.get_pixmap(dpi, clip=rect)`.
 *   pages   the page IS a photograph and its pixel grid is the frame. The box is
 *           rounded outward to whole pixels, intersected with the image, and
 *           those pixels are copied out at 1:1 — no rasteriser.
 *
 * PAGE N IS THE PAGE THE READ CALLED N: the list is `pagesInDirectory`'s, the
 * one ordering rule (bridge.ts). One photograph is held at a time, because the
 * crops arrive in row order and row order is page order.
 */
export async function cropPages(opts: {
  source: RasterSource;
  dpi: number;
  cropsDir: string;
  crops: readonly CropRequest[];
  onCrop?: (name: string, file: string) => void;
}): Promise<void> {
  const mupdf = await loadMupdf();
  ensureDir(opts.cropsDir);
  const source = openSource(mupdf, opts.source);
  const scale = 72 / opts.dpi;
  let heldIndex = -1;
  let held: Pixmap | null = null;
  try {
    for (const crop of opts.crops) {
      const number = crop.page;
      if (number < 1 || number > source.count) {
        throw new RasterError(`a crop names page ${number} of a source with ${source.count} page(s)`);
      }
      const [x1, y1, x2, y2] = crop.box;
      let pixmap: Pixmap;
      if (source instanceof PdfPages) {
        const page = source.page(number - 1);
        const bounds = page.getBounds() as Rect;
        // Python doubles, as `fitz.Rect(...) & page.rect` computed it.
        const rect = intersect([x1 * scale, y1 * scale, x2 * scale, y2 * scale], bounds);
        if (isEmpty(rect)) throw new RasterError(`the crop for ${crop.name} on page ${number} lies outside the page`);
        pixmap = renderClip(mupdf, page, opts.dpi, rect, bounds);
      } else {
        if (number - 1 !== heldIndex) {
          held?.destroy();
          held = source.render(number - 1, opts.dpi);
          heldIndex = number - 1;
        }
        const image = held!;
        const box = intersect(roundRect([x1, y1, x2, y2]), [0, 0, image.getWidth(), image.getHeight()]);
        if (isEmpty(box)) throw new RasterError(`the crop for ${crop.name} on page ${number} lies outside the page`);
        pixmap = copyOut(mupdf, image, box);
      }
      try {
        if (pixmap.getWidth() === 0 || pixmap.getHeight() === 0) {
          throw new RasterError(
            `the crop for ${crop.name} on page ${number} rendered to a ${pixmap.getWidth()}x${pixmap.getHeight()} image`,
          );
        }
        const file = path.join(opts.cropsDir, crop.name);
        writeImageFile(pngBytes(mupdf, pixmap, source.icc(number - 1)), file);
        opts.onCrop?.(crop.name, file);
      } finally {
        pixmap.destroy();
      }
    }
  } finally {
    held?.destroy();
    source.close();
  }
}

/**
 * `page.get_pixmap(dpi=dpi, clip=rect)`, which PyMuPDF draws through a display
 * list: the list's bounds intersected with the clip, transformed by the
 * dpi/72 matrix and rounded outward — in MuPDF's floats — is the pixmap; the
 * page is drawn into it, white behind, resolution stamped.
 */
function renderClip(mupdf: Mupdf, page: Page, dpi: number, clip: Rect, bounds: Rect): Pixmap {
  const zoom = f32(dpi / 72);
  const area = intersect(bounds, clip.map(f32) as Rect);
  const irect = roundRect([f32(area[0] * zoom), f32(area[1] * zoom), f32(area[2] * zoom), f32(area[3] * zoom)]);
  const list = page.toDisplayList(true);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, irect, false);
  pixmap.clear(255);
  const device = new mupdf.DrawDevice([zoom, 0, 0, zoom, 0, 0], pixmap);
  try {
    list.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
    list.destroy();
  }
  pixmap.setResolution(dpi, dpi);
  return pixmap;
}

/** `fitz.Pixmap(src, src.width, src.height, box)`: the box's pixels, unscaled. */
function copyOut(mupdf: Mupdf, image: Pixmap, box: Rect): Pixmap {
  const out = new mupdf.Pixmap(image.getColorSpace()!, box, false);
  const n = image.getNumberOfComponents(); // MuPDF's n counts any alpha channel
  const from = image.getPixels();
  const to = out.getPixels();
  const inStride = image.getStride();
  const outStride = out.getStride();
  const rowBytes = (box[2] - box[0]) * n;
  for (let y = box[1]; y < box[3]; y += 1) {
    const start = y * inStride + box[0] * n;
    to.set(from.subarray(start, start + rowBytes), (y - box[1]) * outStride);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// textlayer — the PDF's own statement of its type sizes
// ─────────────────────────────────────────────────────────────────────────────

/** `[centre-x, centre-y, size, chars]` in points, top-left origin, the displayed page's frame. */
export type LayerSpan = [number, number, number, number];

/** PyMuPDF's TEXTFLAGS_DICT: ligatures, whitespace, images, mediabox clip, CID for unknown Unicode. */
const DICT_OPTIONS = 'preserve-ligatures,preserve-whitespace,preserve-images,clip,use-cid-for-unknown-unicode';

const FLT_EPSILON = 1.1920928955078125e-7;

/**
 * Every text span the PDF already carries: `page.get_text('dict')` as the
 * helper read it, spans grouped and boxed the way PyMuPDF groups and boxes
 * them, then reduced to the four numbers the facsimile route uses.
 *
 * A born-digital PDF, and a scan a publisher ran real OCR over (what JSTOR
 * ships), states the size of every piece of type in its own text layer; the
 * facsimile route sizes its type from it (`pdf-text.ts`). A pure scan has no
 * layer and yields nothing, which is an absence rather than an error.
 */
export async function readTextLayer(pdfPath: string): Promise<Map<number, LayerSpan[]>> {
  const mupdf = await loadMupdf();
  const source = new PdfPages(mupdf, pdfPath);
  const layer = new Map<number, LayerSpan[]>();
  try {
    for (let index = 0; index < source.count; index += 1) {
      const spans = pageSpans(source, index);
      if (spans.length > 0) layer.set(index + 1, spans);
    }
  } finally {
    source.close();
  }
  return layer;
}

interface Span {
  size: number;
  text: string;
  chars: number;
  bbox: Rect;
}

function pageSpans(source: PdfPages, index: number): LayerSpan[] {
  const page = source.page(index) as PDFPage;
  // `page.get_textpage()` sets the page's /Rotate to 0 for the extraction and
  // restores it (it answers in the unrotated frame); the rotation is applied to
  // each span afterwards, by `page.rotation_matrix`.
  const pageObj = page.getObject();
  const rotation = normRotation(pageObj.getInheritable('Rotate').asNumber());
  const rotate = rotation === 0 ? null : rotationMatrix(pageObj, rotation);
  if (rotation !== 0) pageObj.put('Rotate', 0);
  let spans: Span[];
  try {
    const stext = page.toStructuredText(DICT_OPTIONS);
    try {
      spans = dictSpans(stext, page.getBounds() as Rect, pageGlyphs(source.mupdf, page, stext));
    } finally {
      stext.destroy();
    }
  } finally {
    if (rotation !== 0) pageObj.put('Rotate', rotation);
  }

  const out: LayerSpan[] = [];
  for (const span of spans) {
    const text = pyStrip(span.text);
    if (text.length === 0 || span.size <= 0) continue;
    let rect = span.bbox;
    if (rotate !== null) rect = transformRect(rect, rotate);
    // Characters, not UTF-16 units: Python's len().
    out.push([pyRound2((rect[0] + rect[2]) / 2), pyRound2((rect[1] + rect[3]) / 2), pyRound2(span.size), [...text].length]);
  }
  return out;
}

function normRotation(value: number): number {
  let rotation = Math.trunc(value);
  rotation %= 360;
  if (rotation < 0) rotation += 360;
  return rotation % 90 === 0 ? rotation : 0;
}

/** `JM_rotate_page_matrix`: the displayed frame's matrix, from the CropBox size. */
function rotationMatrix(pageObj: import('mupdf').PDFObject, rotation: number): number[] {
  const media = pdfRect(pageObj.getInheritable('MediaBox'));
  let mediabox: Rect = media === null || isEmpty(media) ? [0, 0, 612, 792] : media;
  if (mediabox[2] - mediabox[0] < 1 || mediabox[3] - mediabox[1] < 1) mediabox = [0, 0, 1, 1];
  const crop = pdfRect(pageObj.getInheritable('CropBox'));
  const cropbox = crop === null || isEmpty(crop) ? mediabox : crop;
  const w = Math.abs(cropbox[2] - cropbox[0]);
  const h = Math.abs((mediabox[3] - cropbox[1]) - (mediabox[3] - cropbox[3]));
  if (rotation === 90) return [0, 1, -1, 0, h, 0];
  if (rotation === 180) return [-1, 0, 0, -1, w, h];
  return [0, -1, 1, 0, 0, w];
}

/** `pdf_to_rect`, normalised; null where the object is not a 4-number array. */
function pdfRect(obj: import('mupdf').PDFObject): Rect | null {
  if (!obj.isArray() || obj.length !== 4) return null;
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => f32(obj.get(i).asNumber()));
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/**
 * `Rect * Matrix` in PyMuPDF: MuPDF's `fz_transform_rect`, in floats. The page
 * rotations are the axis-swapping matrices, which take its second branch.
 */
function transformRect(rIn: Rect, mIn: number[]): Rect {
  const r = rIn.map(f32) as Rect;
  const [a, b, c, d, e, f] = mIn.map(f32);
  const point = (x: number, y: number): [number, number] => [
    f32(f32(f32(x * a) + f32(y * c)) + e),
    f32(f32(f32(x * b) + f32(y * d)) + f),
  ];
  const axisAligned = Math.abs(b) < FLT_EPSILON && Math.abs(c) < FLT_EPSILON;
  const swapped = Math.abs(a) < FLT_EPSILON && Math.abs(d) < FLT_EPSILON;
  if (axisAligned || swapped) {
    if ((axisAligned ? a : b) < 0) [r[0], r[2]] = [r[2], r[0]];
    if ((axisAligned ? d : c) < 0) [r[1], r[3]] = [r[3], r[1]];
    const s = point(r[0], r[1]);
    const t = point(r[2], r[3]);
    return [s[0], s[1], t[0], t[1]];
  }
  const corners = [point(r[0], r[1]), point(r[0], r[3]), point(r[2], r[3]), point(r[2], r[1])];
  return [
    Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1])),
  ];
}

/**
 * The spans of `extractDICT`, built the way PyMuPDF's `JM_make_spanlist` builds
 * them: a new span whenever the size, the font flags (superscript, italic,
 * serif, mono, bold), the character flags (minus SYNTHETIC), the colour, the
 * font name (subset prefix dropped) or the bidi level changes; each character
 * boxed by `JM_char_bbox`; characters whose box misses the page skipped; a
 * line's final span dropped when its box is empty.
 *
 * mupdf.js's walker does not hand over two things PyMuPDF reads — a
 * character's flags and its font's ascender/descender. Both are recovered
 * exactly, by `pageGlyphs` (below).
 */
function dictSpans(stext: import('mupdf').StructuredText, mediabox: Rect, glyphs: PageGlyphs): Span[] {
  interface Char {
    c: string; origin: number[]; font: import('mupdf').Font; size: number; quad: Quad; color: unknown;
    bidi: number; glyph: Glyph | null;
  }
  const spans: Span[] = [];
  let lines: { wmode: number; dir: [number, number]; chars: Char[] }[] = [];
  stext.walk({
    beginLine: (_bbox, wmode, dir) => { lines.push({ wmode, dir: [dir[0], dir[1]], chars: [] }); },
    onChar: (c, origin, font, size, quad, color, bidi) => {
      lines[lines.length - 1].chars.push({ c, origin, font, size, quad, color, bidi, glyph: glyphs.at(origin, font.getName()) });
    },
  });

  for (const line of lines) {
    const firstOriginY = line.chars.length > 0 ? line.chars[0].origin[1] : 0;
    let current: (Span & { key: string }) | null = null;
    for (const [i, ch] of line.chars.entries()) {
      // A space MuPDF inserted for a gap has no glyph of its own; it carries
      // the flags of the character after it, and LARGE when the gap is over
      // twice SPACE_DIST (stext-device.c, `add_space = 1 + (spacing > SPACE_DIST*2)`).
      const synthetic = ch.glyph === null && ch.c === ' ';
      const owner = synthetic ? line.chars.slice(i + 1).find((next) => next.glyph !== null)?.glyph ?? null : ch.glyph;
      let flags = owner === null ? FZ_STEXT_FILLED : owner.flags;
      if (synthetic) {
        const spacing = f32(((ch.quad[6] - ch.quad[4]) * line.dir[0] + (ch.quad[7] - ch.quad[5]) * line.dir[1]) / ch.size);
        if (spacing > f32(SPACE_DIST * 2)) flags |= FZ_STEXT_SYNTHETIC_LARGE;
      }
      if (ch.font.isBold()) flags |= FZ_STEXT_BOLD;
      const metric = owner?.metric ?? glyphs.metric(ch.font.getName()) ?? quadMetric(ch.origin, ch.size, ch.quad, line.dir);
      const r = charBbox(line.wmode, line.dir, ch.origin, ch.size, ch.quad, ch.font, ch.c, metric);
      if (!overlaps(mediabox, r)) continue;
      const superscript = line.wmode === 0 && line.dir[0] === 1 && line.dir[1] === 0
        && ch.origin[1] < firstOriginY - ch.size * 0.1;
      const name = ch.font.getName();
      const plus = name.indexOf('+');
      const fontName = plus === 6 ? name.slice(plus + 1) : name;
      const key = [
        f32(ch.size), superscript ? 1 : 0, ch.font.isItalic() ? 1 : 0, ch.font.isSerif() ? 1 : 0,
        ch.font.isMono() ? 1 : 0, ch.font.isBold() ? 1 : 0, flags,
        Array.isArray(ch.color) ? ch.color.join(',') : String(ch.color), fontName,
      ].join('|');
      if (current === null || current.key !== key) {
        if (current !== null) spans.push({ size: current.size, text: current.text, chars: current.chars, bbox: current.bbox });
        current = { key, size: ch.size, text: '', chars: 0, bbox: r };
      }
      current.bbox = union(current.bbox, r);
      current.text += ch.c;
      current.chars += 1;
    }
    if (current !== null && !isEmpty(current.bbox)) {
      spans.push({ size: current.size, text: current.text, chars: current.chars, bbox: current.bbox });
    }
  }
  lines = [];
  return spans;
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a[0] >= b[2] || a[1] >= b[3] || a[2] <= b[0] || a[3] <= b[1]);
}

function isValid(r: Rect): boolean {
  return r[0] <= r[2] && r[1] <= r[3];
}

/** `fz_union_rect`. */
function union(a: Rect, b: Rect): Rect {
  if (!isValid(b)) return a;
  if (!isValid(a)) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

type Quad = number[];

/** structured-text.h's character flags, the ones a span is split on. */
const FZ_STEXT_BOLD = 8;
const FZ_STEXT_FILLED = 16;
const FZ_STEXT_STROKED = 32;
const FZ_STEXT_CLIPPED = 64;
const FZ_STEXT_UNICODE_IS_CID = 128;
const FZ_STEXT_SYNTHETIC_LARGE = 512;
/** stext-device.c's SPACE_DIST. */
const SPACE_DIST = f32(0.15);

/** A font's ascender and descender, as MuPDF holds them (`fz_font_ascender` / `_descender`). */
interface FontMetric {
  asc: number;
  dsc: number;
}

/** One glyph the page drew: its device-space origin, how it was drawn, and its font's metric. */
interface Glyph {
  x: number;
  y: number;
  font: string;
  flags: number;
  /** The glyph's UP vector — the second column of its trm concatenated with the ctm. */
  c: number;
  d: number;
  metric: FontMetric | null;
}

interface PageGlyphs {
  /** The glyph drawn at this origin in this font, or null (a space MuPDF inserted, an ActualText run). */
  at(origin: number[], font: string): Glyph | null;
  /** A font's metric, from whichever of its characters was matched. */
  metric(font: string): FontMetric | null;
}

/**
 * The fallback for a character no glyph could be matched for and whose font
 * has no matched character at all: the up vector's length taken as the size,
 * which is exact unless the text is horizontally scaled.
 */
function quadMetric(origin: number[], size: number, quad: Quad, dir: [number, number]): FontMetric {
  const up = (x: number, y: number): number => ((x - origin[0]) * dir[1] - (y - origin[1]) * dir[0]) / (size === 0 ? 1 : size);
  return { asc: up(quad[0], quad[1]), dsc: up(quad[4], quad[5]) };
}

/**
 * Every glyph the page draws, for the two facts PyMuPDF reads off a structured-
 * text character and mupdf.js does not hand over.
 *
 * THE FLAGS. The structured-text device stamps each character with how its text
 * call drew it — fill: FILLED, stroke: STROKED, a clip: the same plus CLIPPED,
 * invisible (`ignoreText`, OCR's render mode 3): neither — and UNICODE_IS_CID
 * when the font had no Unicode for it (stext-device.c `fz_stext_extract`). A
 * device that listens for the same five calls sees the same thing.
 *
 * THE METRIC. `JM_char_quad` re-boxes a character whose font states nonsense
 * (asc - dsc < 1, or no ascender) from the font's ascender and descender.
 * MuPDF built the character's quad from exactly those two numbers — origin +
 * asc and origin + dsc along the glyph's UP vector (stext-device.c
 * `add_char_to_line`) — so with the glyph's matrix in hand they read straight
 * back: asc = (ul - origin) · up / |up|². The up vector's length is NOT the
 * font size whenever the text is horizontally scaled (`Tz`, every OCR'd JSTOR
 * page), which is why the size cannot stand in for it.
 *
 * A character is matched to its glyph by device-space origin and font.
 */
function pageGlyphs(mupdf: Mupdf, page: Page, stext: import('mupdf').StructuredText): PageGlyphs {
  const buckets = new Map<string, Glyph[]>();
  const bucket = (x: number, y: number): string => `${Math.round(x)},${Math.round(y)}`;
  const collect = (text: import('mupdf').Text, ctm: import('mupdf').Matrix, flags: number): void => {
    text.walk({
      showGlyph: (font, trm, _glyph, unicode) => {
        const m = mupdf.Matrix.concat(trm, ctm);
        const glyph: Glyph = {
          x: m[4], y: m[5], font: font.getName(), c: m[2], d: m[3], metric: null,
          flags: flags | (unicode === 0xfffd ? FZ_STEXT_UNICODE_IS_CID : 0),
        };
        const key = bucket(glyph.x, glyph.y);
        let list = buckets.get(key);
        if (list === undefined) buckets.set(key, list = []);
        list.push(glyph);
      },
    });
  };
  const device = new mupdf.Device({
    fillText: (text, ctm) => collect(text, ctm, FZ_STEXT_FILLED),
    strokeText: (text, _stroke, ctm) => collect(text, ctm, FZ_STEXT_STROKED),
    clipText: (text, ctm) => collect(text, ctm, FZ_STEXT_FILLED | FZ_STEXT_CLIPPED),
    clipStrokeText: (text, _stroke, ctm) => collect(text, ctm, FZ_STEXT_STROKED | FZ_STEXT_CLIPPED),
    ignoreText: (text, ctm) => collect(text, ctm, 0),
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }

  const at = (origin: number[], font: string): Glyph | null => {
    const [x, y] = origin;
    let found: Glyph | null = null;
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        for (const g of buckets.get(`${Math.round(x) + dx},${Math.round(y) + dy}`) ?? []) {
          // The LAST drawn wins: a glyph drawn twice in one place (fill, then
          // stroke) is one character whose flags MuPDF merged; the later call is
          // the one whose flags it kept unless they combine (handled by OR).
          if (g.font === font && Math.abs(g.x - x) < 1e-3 && Math.abs(g.y - y) < 1e-3) {
            found = found === null ? g : { ...g, flags: g.flags | found.flags };
          }
        }
      }
    }
    return found;
  };

  const metrics = new Map<string, FontMetric>();
  stext.walk({
    onChar: (_c, origin, font, _size, quad) => {
      const glyph = at(origin, font.getName());
      if (glyph === null) return;
      const length2 = glyph.c * glyph.c + glyph.d * glyph.d;
      if (length2 === 0) return;
      const along = (x: number, y: number): number => ((x - origin[0]) * glyph.c + (y - origin[1]) * glyph.d) / length2;
      // MuPDF's floats: the ascender and descender are single-precision values.
      const metric = { asc: f32(along(quad[0], quad[1])), dsc: f32(along(quad[4], quad[5])) };
      if (!metrics.has(glyph.font)) metrics.set(glyph.font, metric);
    },
  });
  return {
    at: (origin, font) => {
      const glyph = at(origin, font);
      return glyph === null ? null : { ...glyph, metric: metrics.get(font) ?? null };
    },
    metric: (font) => metrics.get(font) ?? null,
  };
}

/** `JM_char_bbox`: the corrected quad's rectangle, stretched to the size in vertical writing. */
function charBbox(
  wmode: number, dir: [number, number], origin: number[], size: number, quad: Quad,
  font: import('mupdf').Font, c: string, metric: FontMetric,
): Rect {
  const q = wmode === 0 ? charQuad(dir, origin, size, quad, font, c, metric) : quad;
  const r: Rect = [
    Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]),
    Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7]),
  ];
  if (wmode === 0) return r;
  if (r[3] < r[1] + size) r[1] = r[3] - size;
  return r;
}

/**
 * `JM_char_quad` for horizontal text — PyMuPDF's C++ (extra.i), so in single
 * precision, every operation rounded to a float as the compiled code rounds it.
 * Quads here are mupdf.js's `[ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y]`.
 */
function charQuad(
  dir: [number, number], origin: number[], fsizeIn: number, quad: Quad, font: import('mupdf').Font, ch: string,
  metric: FontMetric,
): Quad {
  const fsize = f32(fsizeIn);
  let asc = f32(metric.asc);
  let dsc = f32(metric.dsc);
  let ascDsc = f32(f32(asc - dsc) + FLT_EPSILON);
  if (ascDsc >= 1) return quad;
  if (asc < 1e-3) {
    dsc = f32(-0.1);
    asc = f32(0.9);
    ascDsc = 1;
  }
  if (ascDsc < 1) {
    dsc = f32(dsc / ascDsc);
    asc = f32(asc / ascDsc);
  }
  ascDsc = f32(asc - dsc);
  asc = f32(f32(asc * fsize) / ascDsc);
  dsc = f32(f32(dsc * fsize) / ascDsc);

  const c = f32(dir[0]);
  const s = f32(dir[1]);
  const trm1 = [c, -s, s, c, 0, 0];
  const trm2 = [c, s, -s, c, 0, 0];
  if (c === -1) {
    trm1[3] = 1;
    trm2[3] = 1;
  }
  /** `fz_transform_point`: x*a + y*c + e, each step a float. */
  const apply = (q: Quad, m: number[]): Quad => {
    const out: Quad = [];
    for (let i = 0; i < 8; i += 2) {
      out.push(
        f32(f32(f32(q[i] * m[0]) + f32(q[i + 1] * m[2])) + m[4]),
        f32(f32(f32(q[i] * m[1]) + f32(q[i + 1] * m[3])) + m[5]),
      );
    }
    return out;
  };
  const ox = f32(origin[0]);
  const oy = f32(origin[1]);
  let q = apply(quad.map(f32), [1, 0, 0, 1, -ox, -oy]);
  q = apply(q, trm1);
  // ul = 0,1  ur = 2,3  ll = 4,5  lr = 6,7
  if (c === 1 && q[1] > 0) {
    q[1] = asc; q[3] = asc; q[5] = dsc; q[7] = dsc;
  } else {
    q[1] = -asc; q[3] = -asc; q[5] = -dsc; q[7] = -dsc;
  }
  if (q[4] < 0) {
    q[4] = 0;
    q[0] = 0;
  }
  if (f32(q[6] - q[4]) < FLT_EPSILON) {
    const glyph = font.encodeCharacter(ch);
    if (glyph) {
      q[6] = f32(q[4] + f32(f32(font.advanceGlyph(glyph, 0)) * fsize));
      q[2] = q[6];
    }
  }
  q = apply(q, trm2);
  return apply(q, [1, 0, 0, 1, ox, oy]);
}
