/**
 * capture — photographs become a project the rest of this app can read.
 *
 * A capture project arrives as pictures of a bound volume rather than as a file
 * (docs/CAPTURE.md). This module owns everything that happens to those pictures
 * BEFORE a PDF exists: copying them in, hashing them, decoding them once, and
 * keeping the recipe of splits and quads that says how they become pages. The
 * mint that turns the recipe into a PDF is the other half and lands later; from
 * the minted PDF onward nothing in this app knows this stage happened.
 *
 * ── THE LAYOUT, AND WHICH HALF OF IT HAS A DOOR ──────────────────────────────
 *
 *   capture/originals/<sha>.<ext>    the bank. Never written, NEVER SERVED
 *   capture/derived/<sha>.png        the upright working copy
 *   capture/derived/<sha>.640.jpg    the thumbnail the grid draws
 *   capture/recipe.json              the splits, quads, strikes and order
 *
 * ONE SERVED DIRECTORY, FLAT NAMES. The renderer reaches pixels only through
 * `foundry-file://capture/<token>/<name>`, whose token maps to `derived/` and
 * whose name must be a plain basename — the same allow-list shape as the book
 * host next door (`bookFigureFile`, electron/book.ts), kept character for
 * character rather than replaced with a cleverer path check that has to stay
 * right forever.
 *
 * The consequence is the reason the layout is this one: NO STRING A RENDERER CAN
 * COMPOSE REACHES THE ORIGINALS. The irreplaceable half of this stage — often
 * the only copy of an afternoon in an archive that does not lend its books — is
 * not merely un-served, it is unaddressable through the scheme. A second host
 * segment, or a token that reached `capture/` itself, would have left the bank
 * one accepted path component away from being readable, guarded by a check
 * instead of by arithmetic.
 *
 * `derived/` and not `working/`, which was the first proposal: `working/` is
 * already a project directory (`WORKING`, electron/projects.ts) holding the live
 * PDF, and one word may not mean two things one folder apart. The name is also
 * true of the contents — everything in it is reconstructible from the originals
 * plus the recipe, which is this stage's first truth, and it makes the deletion
 * rule readable without a comment.
 *
 * ── UPRIGHT IS THE DECODER'S DEFAULT, AND APPLYING ORIENTATION IS A BUG ──────
 *
 * libheif applies the container's `irot` while decoding, so the buffer comes
 * back already upright and this module writes it out unchanged. Applying EXIF
 * Orientation on top would be a DOUBLE ROTATION: measured on the acceptance
 * shoot, it would have turned 26 of 27 photographs 90° wrong — uniformly enough
 * to look deliberate rather than broken. The dependency is pinned to an exact
 * `libheif-js@1.19.8` for that reason: this is decoder behaviour, not format
 * truth, and a caret would let a routine install change it without a person
 * deciding to.
 *
 * DIMENSIONS COME FROM THE DECODER, NEVER FROM EXIF. EXIF says 4032x3024 for a
 * file the decoder hands back as 3024x4032; both are correct about different
 * grids. The recipe, the editor and the mint all live on the DECODED grid, and
 * there is no orientation field anywhere to disagree with it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { nativeImage } from 'electron';

import { PDFDocument } from 'pdf-lib';

import type {
  CaptureMintBegun,
  CaptureMintPage,
  CapturePage,
  CapturePhoto,
  CaptureQuad,
  CaptureRecipe,
  CaptureTimeSource,
  LedgerStep,
  PixelQuad,
} from '../shared/types';
import {
  CAPTURE_RECIPE_PAYLOAD,
  emptyRecipe,
  outputSizeFor,
  recipeBytes,
  sameShape,
} from '../shared/capture';
import { beginMint, cancelHere, mintCancelled, noteMintPage, settleMint } from './job-queue';
import { readManifest, recordMint } from './projects';
import { writeAtomically } from './atomic';

// Re-exported so a caller that already imports this module does not need to
// know the constant lives one directory over.
export { CAPTURE_RECIPE_PAYLOAD };

const CAPTURE = 'capture';
const ORIGINALS = 'originals';
const DERIVED = 'derived';
const RECIPE = 'recipe.json';
// Staging for a mint in progress. NOT served: the door reaches `derived/`
// and nothing else, and a half-finished book is nobody's business but
// this module's.
const MINTS = 'mints';

/** Refusals from this module, named so a caller can tell them from an fs error. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export function captureDir(projectDir: string): string {
  return path.join(projectDir, CAPTURE);
}

function originalsDir(projectDir: string): string {
  return path.join(captureDir(projectDir), ORIGINALS);
}

function derivedDir(projectDir: string): string {
  return path.join(captureDir(projectDir), DERIVED);
}

function recipeFile(projectDir: string): string {
  return path.join(captureDir(projectDir), RECIPE);
}

// ─────────────────────────────────────────────────────────────────────────────
// The door
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `foundry-file://capture/<token>/<name>` — the working copies and thumbnails of
 * ONE project's `derived/`, and nothing else on this disk.
 *
 * Minted per directory and reused, exactly like the book host's: the map stays
 * the size of the library rather than growing with every project open. The token
 * is the whole authorisation — a URL the renderer composes for a directory
 * nothing registered meets a 403 rather than a read.
 */
const captureTokens = new Map<string, string>();
const captureDirs = new Map<string, string>();

function tokenForDerived(dir: string): string {
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
 * refusals: intake writes `derived/` flat, so a separator in the name is not a
 * file this app made — it is a traversal, and it meets the same null an unknown
 * token does rather than a `resolve()` that might climb.
 */
export function captureDerivedFile(token: string, name: string): string | null {
  const dir = captureDirs.get(token);
  if (dir === undefined) return null;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return path.join(dir, name);
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipe, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One recipe write at a time, per project.
 *
 * `recipe.json` is rewritten WHOLE (it is kilobytes even for hundreds of
 * photographs), so a save that crossed an intake would drop whichever landed
 * first. A promise chain per directory is the smallest thing that makes that
 * impossible — the same answer `withManifest` gives for the catalogue, for the
 * same reason, and it is a separate chain because a recipe edit must not queue
 * behind an unrelated manifest write.
 */
const recipeEdits = new Map<string, Promise<unknown>>();

function withRecipe<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectDir).toLowerCase();
  const previous = recipeEdits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed edit must not poison the ones queued behind it */ })
    .then(work);
  recipeEdits.set(key, next);
  return next;
}

// `emptyRecipe` and `recipeBytes` come from shared/ — see the argument there.
export { emptyRecipe };


/**
 * The recipe this project holds.
 *
 * A MISSING FILE IS A REFUSAL AND NOT AN EMPTY RECIPE. `capture:create` writes
 * `recipe.json` before it returns, so a capture project without one is damaged
 * rather than new — and answering "no photographs" for a project whose
 * `originals/` is full of them would invite the surface to save that answer back
 * over the file, which is how one missing read becomes a real loss.
 */
export async function readRecipe(projectDir: string): Promise<CaptureRecipe> {
  const file = recipeFile(projectDir);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new CaptureError(
      `${file} could not be read, so this project's photographs have no recipe: `
      + `${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CaptureError(`${file} is not JSON (${(err as Error).message}).`);
  }
  return validRecipe(parsed, file);
}

/**
 * Write the recipe, whole, or refuse it.
 *
 * VALIDATED ON THE WAY IN even though the renderer composed it, because "the
 * renderer would not send that" is a claim about code that does not exist yet.
 * A recipe that reaches disk malformed is not a bug that throws — it is a
 * project that will not open tomorrow, and its photographs are the one thing
 * here nobody can remake.
 */
export async function writeRecipe(projectDir: string, recipe: CaptureRecipe): Promise<void> {
  const checked = validRecipe(recipe, recipeFile(projectDir));
  await withRecipe(projectDir, async () => {
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(checked)));
  });
}

function fail(file: string, what: string): never {
  throw new CaptureError(`${file} is not a recipe this app can read: ${what}.`);
}

function validQuad(value: unknown, file: string, where: string): CaptureQuad {
  if (!Array.isArray(value) || value.length !== 4) fail(file, `${where} is not four corners`);
  const corners = value.map((corner, index) => {
    if (!Array.isArray(corner) || corner.length !== 2) fail(file, `${where} corner ${index} is not a pair`);
    const [x, y] = corner as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      fail(file, `${where} corner ${index} is not two finite numbers`);
    }
    /*
     * FRACTIONS, AND THE BOUNDS ARE PART OF THE UNIT. Every coordinate in this
     * file is a fraction of the working copy's grid; a value outside [0,1] is
     * either pixels that took a wrong turn at the bridge or a corner dragged off
     * the photograph, and both produce black edges in a minted page rather than
     * an error anybody sees.
     */
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      fail(file, `${where} corner ${index} is outside the photograph (${x}, ${y}) — coordinates are fractions`);
    }
    return [x, y] as const;
  });
  return corners as unknown as CaptureQuad;
}

function validRecipe(value: unknown, file: string): CaptureRecipe {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, 'it is not an object');
  const row = value as Record<string, unknown>;
  if (row['version'] !== 1) fail(file, `it is version ${String(row['version'])} and this app reads version 1`);
  const photos = row['photos'];
  const order = row['order'];
  if (!Array.isArray(photos)) fail(file, 'it names no photographs');
  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) fail(file, 'its order is not a list of ids');

  const seen = new Set<string>();
  const checked: CapturePhoto[] = photos.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) fail(file, `photograph ${index} is not an object`);
    const photo = entry as Record<string, unknown>;
    const text = (key: string): string => {
      const held = photo[key];
      if (typeof held !== 'string' || held.length === 0) fail(file, `photograph ${index} names no ${key}`);
      return held;
    };
    const count = (key: string): number => {
      const held = photo[key];
      if (typeof held !== 'number' || !Number.isFinite(held) || held <= 0) {
        fail(file, `photograph ${index} has no positive ${key}`);
      }
      return held;
    };
    const id = text('id');
    if (seen.has(id)) fail(file, `two photographs share the id ${id}`);
    seen.add(id);
    const source = photo['takenAtSource'];
    if (source !== 'exif-offset' && source !== 'exif-local' && source !== 'mtime') {
      fail(file, `photograph ${index} says its time came from ${String(source)}`);
    }
    const split = photo['split'];
    let splitAt: { x: number } | null = null;
    if (split !== null && split !== undefined) {
      const x = (split as Record<string, unknown>)['x'];
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
        fail(file, `photograph ${index} has a split at ${String(x)}, which is not a fraction of its width`);
      }
      splitAt = { x };
    }
    const pages = photo['pages'];
    if (!Array.isArray(pages)) fail(file, `photograph ${index} names no pages`);
    const checkedPages: CapturePage[] = pages.map((page, pageIndex) => {
      if (typeof page !== 'object' || page === null) fail(file, `page ${pageIndex} of photograph ${index} is not an object`);
      const held = page as Record<string, unknown>;
      const pageId = held['id'];
      if (typeof pageId !== 'string' || pageId.length === 0) fail(file, `page ${pageIndex} of photograph ${index} has no id`);
      if (typeof held['struck'] !== 'boolean') fail(file, `page ${pageId} does not say whether it is struck`);
      return {
        id: pageId,
        quad: validQuad(held['quad'], file, `page ${pageId}`),
        struck: held['struck'] as boolean,
      };
    });
    /*
     * A PHOTOGRAPH IS ONE PAGE OR TWO, and a split means two.
     *
     * The split line is the gesture that DERIVES the second quad, so a recipe
     * claiming a split over one page has lost one of them somewhere between the
     * editor and here — and the mint would print a spread as a single page
     * without ever noticing the other was gone. The converse is deliberately
     * NOT checked: two quads and no split line is a person who cropped both
     * halves by hand, which is allowed.
     */
    if (checkedPages.length < 1 || checkedPages.length > 2) {
      fail(file, `photograph ${index} has ${checkedPages.length} pages, and a photograph is one page or two`);
    }
    if (splitAt !== null && checkedPages.length !== 2) {
      fail(file, `photograph ${index} is split but holds ${checkedPages.length} page(s)`);
    }
    return {
      id,
      file: text('file'),
      workingCopy: text('workingCopy'),
      thumb: text('thumb'),
      width: count('width'),
      height: count('height'),
      takenAt: text('takenAt'),
      takenAtSource: source as CaptureTimeSource,
      split: splitAt,
      pages: checkedPages,
    };
  });

  /*
   * ── THE ORDER AND THE PAGES MUST BE THE SAME SET ──────────────────────────
   *
   * `order` is the only stored truth about arrangement, and the mint walks IT
   * rather than the photographs. So a page id missing from it is a leaf that is
   * never printed and never drawn — invisible on the grid, so nobody can even
   * see that it is gone — and a repeated id mints the same page twice.
   *
   * FOUND ON P2’S READ-BACK, and not hypothetically: their reverse() dropped an
   * id it could not resolve instead of preserving it, so an inconsistent recipe
   * accepted here would have had a page silently deleted by the next press of a
   * button. Each half of that was nearly unreachable alone. Together they were a
   * path, which is what most real losses are made of.
   */
  const pageIds = checked.flatMap((photo) => photo.pages.map((page) => page.id));
  const listed = new Set(order as string[]);
  if (listed.size !== order.length) fail(file, 'its order lists the same page twice');
  if (listed.size !== pageIds.length || pageIds.some((id) => !listed.has(id))) {
    const missing = pageIds.filter((id) => !listed.has(id));
    const unknown = (order as string[]).filter((id) => !pageIds.includes(id));
    fail(file, 'its order does not list every page exactly once'
      + (missing.length > 0 ? ` (missing ${missing.length})` : '')
      + (unknown.length > 0 ? ` (naming ${unknown.length} that do not exist)` : ''));
  }

  return { version: 1, photos: checked, order: order as string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening — the recipe plus the token that makes its pictures loadable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the light table needs to draw itself, in one round trip.
 *
 * The token is minted HERE rather than by a door of its own because the two
 * arrive together every time: a recipe whose pictures cannot be addressed is a
 * grid of broken images, and a token for a recipe nobody has read has nothing to
 * point at.
 */
export async function openCapture(projectDir: string): Promise<{ recipe: CaptureRecipe; token: string }> {
  const dir = derivedDir(projectDir);
  await fsp.mkdir(dir, { recursive: true });
  return { recipe: await readRecipe(projectDir), token: tokenForDerived(dir) };
}

/**
 * The same thing, for a project that does not have a recipe yet.
 *
 * SEPARATE FROM `openCapture` BECAUSE THE REFUSAL IS THE POINT OF THAT ONE. A
 * missing `recipe.json` means damage everywhere except here, at the single
 * moment a capture project is created and there is genuinely nothing to read
 * yet. Folding the two would make every later load answer "no photographs" for
 * a project whose `originals/` is full of them, and invite the surface to save
 * that answer back over the file.
 */
export async function ensureCapture(projectDir: string): Promise<{ recipe: CaptureRecipe; token: string }> {
  await fsp.mkdir(originalsDir(projectDir), { recursive: true });
  await fsp.mkdir(derivedDir(projectDir), { recursive: true });
  const file = recipeFile(projectDir);
  try {
    await fsp.access(file);
  } catch {
    await writeAtomically(file, Buffer.from(recipeBytes(emptyRecipe())));
  }
  return openCapture(projectDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoding — HEIC in, upright RGBA out
// ─────────────────────────────────────────────────────────────────────────────

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/*
 * `libheif-js` ships a wasm build and no types. Loaded through `require` at the
 * moment of use rather than imported at the top: the wasm module costs real
 * memory to instantiate, and an app that never opens a capture project should
 * never pay for it.
 */
interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(into: { data: Uint8ClampedArray; width: number; height: number }, done: (out: unknown) => void): void;
}
interface HeifModule { HeifDecoder: new () => { decode(bytes: Buffer): HeifImage[] } }

let heif: HeifModule | null = null;

/**
 * The decoder, or a refusal that says the APP is missing something.
 *
 * ── WHY THIS FAILURE IS NOT A PER-FILE REFUSAL ─────────────────────────────
 *
 * `intakePhotos` reports what it could not read file by file, which is exactly
 * right for a truncated HEIC among twenty-seven good ones — that is what the
 * refusal list is for. It is exactly WRONG for an absent decoder, because that
 * condition fails every file: a person who dropped a folder is told twenty-seven
 * times that their photographs are unreadable, in a sentence containing a Node
 * require stack, and the true cause is nowhere in the message. They would report
 * it as "capture is broken" and be right about the symptom and helpless about the
 * reason.
 *
 * Found by P2 running this intake against real files on a worktree whose
 * `node_modules` predated the dependency (feature channel, seq 57). The
 * distinction is the one the pdf-lib note already made: a per-file refusal is
 * ABOUT THE FILE, and this is about the installation.
 *
 * IT IS ALSO THE PACKAGED-BUILD SHAPE. `libheif-js` is a real dependency of
 * app/package.json, so a packaged build carries it — but if that ever stops
 * being true, the failure a person meets must say so rather than blame the only
 * copies of an afternoon in an archive.
 */
function decoderModule(): HeifModule {
  if (heif === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      heif = require('libheif-js') as HeifModule;
    } catch (err) {
      throw new CaptureError(
        'This copy of Foundry cannot read photographs: its HEIC decoder (libheif-js) is not '
        + 'installed beside the app. Nothing is wrong with your photographs and none of them '
        + `were read. (${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)})`,
      );
    }
  }
  return heif;
}

/**
 * Decode one HEIC, upright, and hand back the pixels.
 *
 * APPLIES NOTHING. See the header: the buffer that comes back has already had
 * the container's rotation applied, and the EXIF Orientation tag is a fact about
 * a grid this app never looks at.
 */
async function decodeHeic(bytes: Buffer, name: string): Promise<DecodedImage> {
  const images = new (decoderModule().HeifDecoder)().decode(bytes);
  const image = images[0];
  if (image === undefined) throw new CaptureError(`${name} holds no image the decoder could find.`);
  const width = image.get_width();
  const height = image.get_height();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CaptureError(`${name} decoded to ${width}x${height}, which is not a picture.`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data: rgba, width, height }, (out) => {
      if (out) resolve();
      else reject(new CaptureError(`${name} could not be decoded to pixels.`));
    });
  });
  return { width, height, rgba };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG, written here rather than encoded by somebody else
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHY THIS IS HAND-WRITTEN AND NOT `nativeImage.createFromBitmap` ──────────
 *
 * Electron can encode a bitmap, but its buffer is BGRA or RGBA depending on the
 * platform and premultiplied on some of them — an ambiguity that would be
 * resolved by trying it, on the ONE file every page of the finished book is
 * sampled from. A PNG chunk writer is forty lines with no ambiguity in it at
 * all: these bytes, in this order, on every platform. The thumbnail below does
 * use Electron, and it is handed a PNG rather than a bitmap for exactly this
 * reason — there is no channel order to get wrong in a decoded file format.
 *
 * COLOUR TYPE 2 (RGB), NOT 6 (RGBA). The decoder hands back four channels and a
 * photograph's fourth is opaque everywhere; carrying it would add a quarter to a
 * file that is already ~12 MiB per photograph. A HEIC that genuinely carried
 * transparency would flatten to opaque here, which is the right answer for a
 * photograph of a page and the wrong one for nothing this stage accepts.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * RGBA pixels to PNG bytes.
 *
 * FILTER 1 (SUB) AND DEFLATE LEVEL 3, both measured on the acceptance shoot
 * rather than chosen: against filter 0 at the same level, Sub takes a 3024x4032
 * photograph from 16.7 MiB to 11.5 MiB for 77 ms more work, while raising the
 * deflate level to 6 buys 0.9 MiB for 172 ms. A lossless working copy is meant
 * to be big; it is not meant to be slow, and 27 of them are decoded in one
 * intake.
 */
function encodePng(image: DecodedImage): Buffer {
  const { width, height, rgba } = image;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 1; // Sub
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const here = row + x * 4;
      const left = x === 0 ? -1 : here - 4;
      raw[at++] = (rgba[here]! - (left < 0 ? 0 : rgba[left]!)) & 0xff;
      raw[at++] = (rgba[here + 1]! - (left < 0 ? 0 : rgba[left + 1]!)) & 0xff;
      raw[at++] = (rgba[here + 2]! - (left < 0 ? 0 : rgba[left + 2]!)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // eight bits a channel
  header[9] = 2; // colour type 2 — RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The long edge of a thumbnail, in pixels. */
const THUMB_EDGE = 640;

/**
 * The picture the grid draws — 640 px on its long edge, JPEG, display only.
 *
 * NEVER IN ANY QUALITY CHAIN. Nothing downstream of this stage ever sees this
 * file: the editor opens the full PNG for the one photograph it is showing, and
 * the mint samples full PNGs a page at a time. It exists so that opening a
 * project does not pull half a gigabyte of lossless PNG through the door and
 * decode it, every time, to draw twenty-seven cards.
 *
 * FED THE ENCODED PNG rather than the raw bitmap, which is the same decision the
 * encoder above explains: a decoded file format has no channel order to get
 * wrong, and this is the one place Electron's imaging is in the path at all.
 */
function encodeThumbnail(png: Buffer, image: DecodedImage): Buffer {
  const wide = image.width >= image.height;
  const thumb = nativeImage.createFromBuffer(png).resize({
    ...(wide ? { width: THUMB_EDGE } : { height: THUMB_EDGE }),
    quality: 'best',
  });
  return thumb.toJPEG(85);
}

// ─────────────────────────────────────────────────────────────────────────────
// When the photograph was taken
// ─────────────────────────────────────────────────────────────────────────────

/** `Exif\0\0` — the payload marker, and NOT the item declaration that shares it. */
const EXIF_SIGNATURE = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/**
 * How far into the file the EXIF payload is allowed to be.
 *
 * Measured on the acceptance shoot: the payload begins between 31,653 and 35,731
 * bytes in, across all 27 files. 128 KiB is comfortably past that without
 * walking a 1.5 MiB file looking for a needle that is not there.
 */
const EXIF_LIMIT = 128 * 1024;

interface ExifTimes {
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
}

/**
 * Find the EXIF payload and read the two time tags out of it.
 *
 * ── THE FIRST MATCH IS A DECOY, IN EVERY FILE, AND THAT IS THE FINDING ──────
 *
 * Searching for `Exif\0\0` and trusting the first hit reads garbage: in ALL 27
 * files of the acceptance shoot the first occurrence is at offset 1554 (or 1864
 * in one), inside the `infe` box where the container DECLARES it holds an Exif
 * item, and the bytes after it are zeroes rather than a TIFF header. The real
 * payload is ~32 KiB further in, and it is the only one of the two that is
 * followed by a byte-order marker and the number 42.
 *
 * So this VALIDATES rather than trusts: every occurrence is examined, and the
 * first one that is actually a TIFF header wins. Measured across the shoot, that
 * rule finds exactly one candidate per file — the decoy never validates and the
 * payload always does.
 *
 * A BOUNDED SCAN AND NOT A BOX WALK, deliberately. A full ISOBMFF walk is the
 * more correct program and a much longer one, and its failure mode on a file
 * this scan cannot read is the same as this one's: no time, `mtime` recorded as
 * the source, nothing silent. The scan is what the acceptance shoot needed; the
 * walk is written the day a camera arrives that this refuses.
 */
function readExifTimes(bytes: Buffer): ExifTimes {
  const none: ExifTimes = { dateTimeOriginal: null, offsetTimeOriginal: null };
  const hay = bytes.subarray(0, Math.min(bytes.length, EXIF_LIMIT));
  let tiff = -1;
  let bigEndian = false;
  for (let at = hay.indexOf(EXIF_SIGNATURE); at >= 0; at = hay.indexOf(EXIF_SIGNATURE, at + 1)) {
    const start = at + EXIF_SIGNATURE.length;
    if (start + 8 > bytes.length) break;
    const order = bytes.readUInt16BE(start);
    const be = order === 0x4d4d;
    if (!be && order !== 0x4949) continue;
    if ((be ? bytes.readUInt16BE(start + 2) : bytes.readUInt16LE(start + 2)) !== 42) continue;
    tiff = start;
    bigEndian = be;
    break;
  }
  if (tiff < 0) return none;

  const u16 = (at: number): number => (bigEndian ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at));
  const u32 = (at: number): number => (bigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at));

  /** The entries of one IFD, for the tags asked about and no others. */
  const readIfd = (at: number, wanted: readonly number[]): Map<number, string | number> => {
    const found = new Map<number, string | number>();
    if (at < 0 || at + 2 > bytes.length) return found;
    const entries = u16(at);
    for (let i = 0; i < entries; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      const tag = u16(entry);
      if (!wanted.includes(tag)) continue;
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      const width = type === 3 ? 2 : type === 4 ? 4 : 1;
      const size = width * count;
      if (size > 1024) continue; // a time is twenty bytes; anything else is not one
      const value = size <= 4 ? entry + 8 : tiff + u32(entry + 8);
      if (value < 0 || value + size > bytes.length) continue;
      found.set(tag, type === 2
        ? bytes.toString('latin1', value, value + count).replace(/\0[\s\S]*$/, '').trim()
        : u32(value));
    }
    return found;
  };

  const EXIF_IFD_POINTER = 0x8769;
  const DATE_TIME_ORIGINAL = 0x9003;
  const OFFSET_TIME_ORIGINAL = 0x9011;

  const subAt = readIfd(tiff + u32(tiff + 4), [EXIF_IFD_POINTER]).get(EXIF_IFD_POINTER);
  if (typeof subAt !== 'number') return none;
  const sub = readIfd(tiff + subAt, [DATE_TIME_ORIGINAL, OFFSET_TIME_ORIGINAL]);
  const taken = sub.get(DATE_TIME_ORIGINAL);
  const offset = sub.get(OFFSET_TIME_ORIGINAL);
  return {
    dateTimeOriginal: typeof taken === 'string' && taken.length > 0 ? taken : null,
    offsetTimeOriginal: typeof offset === 'string' && offset.length > 0 ? offset : null,
  };
}

interface TakenAt {
  takenAt: string;
  takenAtSource: CaptureTimeSource;
}

/**
 * When this photograph was taken, as a UTC instant, and how sure we are.
 *
 * ── THE SORT IS THE CUSTOMER, AND IT IS WHY THE SOURCE IS RECORDED ──────────
 *
 * EXIF writes wall time with no zone: `2026:08:18 17:55:01` is what the clock in
 * the room said. The acceptance shoot also carries `OffsetTimeOriginal` (-04:00
 * on all 27), which turns that reading into an instant; a camera that omits it
 * leaves us interpreting the wall time in THIS machine's zone, which is right
 * for photographs taken here and wrong by hours for photographs that travelled.
 * Either way a single shoot sorts correctly, because every photograph in it is
 * wrong by the same amount.
 *
 * `takenAtSource` exists so that nothing downstream has to guess which of the
 * three answers it is holding, and so that a project whose order looks wrong can
 * be asked WHY rather than argued with. `mtime` is the honest last resort — a
 * file copied by a photo manager can carry a modification time that has nothing
 * to do with the shutter, and saying so is better than a confident wrong instant.
 */
function takenAtFrom(times: ExifTimes, modifiedAt: Date): TakenAt {
  const stamp = times.dateTimeOriginal;
  const match = stamp === null
    ? null
    : /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (match === null) {
    return { takenAt: modifiedAt.toISOString(), takenAtSource: 'mtime' };
  }
  const [, year, month, day, hour, minute, second] = match;
  const offset = times.offsetTimeOriginal;
  if (offset !== null && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    const instant = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
    if (!Number.isNaN(instant.getTime())) {
      return { takenAt: instant.toISOString(), takenAtSource: 'exif-offset' };
    }
  }
  // No offset: the wall time is read in this machine's zone, and the record says
  // so rather than pretending the reading was UTC.
  const local = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  if (Number.isNaN(local.getTime())) {
    return { takenAt: modifiedAt.toISOString(), takenAtSource: 'mtime' };
  }
  return { takenAt: local.toISOString(), takenAtSource: 'exif-local' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Intake
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole photograph, as a single page, before anybody has cropped anything.
 *
 * The corner order is [top-left, top-right, bottom-right, bottom-left] OF THE
 * OUTPUT PAGE, which for an uncropped photograph is the photograph's own
 * corners. There is no rotation field to disagree with it: the assignment IS the
 * orientation.
 */
const WHOLE_FRAME: CaptureQuad = [[0, 0], [1, 0], [1, 1], [0, 1]];

function pagesFor(photoId: string, from: CapturePhoto | null, decoded: DecodedImage): {
  pages: CapturePage[];
  split: { x: number } | null;
  inherited: boolean;
} {
  if (from !== null && sameShape(from, decoded) && from.pages.length > 0) {
    return {
      pages: from.pages.map((page, index) => ({
        id: `${photoId}:${index}`,
        quad: page.quad,
        // A strike is a decision about a PAGE, never about a crop, so it is the
        // one thing a late arrival does not inherit: nobody has looked at this
        // photograph yet, and starting it struck would hide it in the grid.
        struck: false,
      })),
      split: from.split,
      inherited: true,
    };
  }
  return {
    pages: [{ id: `${photoId}:0`, quad: WHOLE_FRAME, struck: false }],
    split: null,
    inherited: false,
  };
}

/** What intake did, beyond the recipe it hands back. */
export interface IntakeReport {
  recipe: CaptureRecipe;
  token: string;
  added: number;
  /** Files already in this project, by sha — dropped twice, copied once. */
  duplicates: string[];
  /** Files this stage will not read, and the reason, in words. */
  refused: { file: string; why: string }[];
}

/**
 * What this stage accepts.
 *
 * HEIC ONLY IN v1, AND THE REFUSAL IS DELIBERATE. The acceptance shoot is 27
 * HEIC files and libheif's behaviour on them is measured. A JPEG would decode
 * through Electron instead, on a path where EXIF Orientation is applied by
 * somebody else's rules — which is the exact hazard that nearly turned this
 * shoot 90° wrong, and it would arrive untested. A named refusal is a sentence
 * a person can act on; a sideways working copy is a bug they have to notice.
 */
const READABLE = new Set(['.heic', '.heif']);

/**
 * Copy photographs into the project, decode them once, and add them to the
 * recipe.
 *
 * ── ONE PHOTOGRAPH AT A TIME, ON PURPOSE ────────────────────────────────────
 *
 * A decoded 12-megapixel frame is 48 MiB of RGBA and its PNG is another 12; the
 * acceptance shoot is 27 of them. Held together that is a gigabyte and a half of
 * live heap in the main process for no reason at all, since nothing here needs
 * two photographs at once. Sequential also means an intake that fails halfway
 * leaves every photograph before the failure fully written and catalogued.
 */
export async function intakePhotos(projectDir: string, paths: readonly string[]): Promise<IntakeReport> {
  /*
   * ASKED FOR ONCE, BEFORE ANY DIRECTORY IS MADE OR ANY FILE IS COPIED. If the
   * decoder is missing this throws HERE — one loud failure about the app —
   * rather than inside the loop, where it would become one refusal per
   * photograph about the photographs. Failing before the first `mkdir` also
   * means an intake that cannot possibly work leaves nothing behind.
   */
  decoderModule();
  const originals = originalsDir(projectDir);
  const derived = derivedDir(projectDir);
  await fsp.mkdir(originals, { recursive: true });
  await fsp.mkdir(derived, { recursive: true });

  return withRecipe(projectDir, async () => {
    const recipe = await readRecipe(projectDir);
    const photos = [...recipe.photos];
    const order = [...recipe.order];
    const duplicates: string[] = [];
    const refused: { file: string; why: string }[] = [];
    let added = 0;

    for (const each of paths) {
      const resolved = path.resolve(each);
      const name = path.basename(resolved);
      const extension = path.extname(resolved).toLowerCase();
      if (!READABLE.has(extension)) {
        refused.push({
          file: name,
          why: `${extension || 'a file with no extension'} is not a photograph this stage reads yet — HEIC only for now`,
        });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(resolved);
      } catch (err) {
        refused.push({ file: name, why: `it could not be read: ${(err as Error).message}` });
        continue;
      }

      /*
       * CONTENT-ADDRESSED, so dropping the same folder twice copies nothing and
       * adds nothing. The id IS the hash, so a second copy could not be given an
       * id of its own without breaking the one rule the page ids rest on.
       */
      const id = createHash('sha256').update(bytes).digest('hex');
      if (photos.some((photo) => photo.id === id)) {
        duplicates.push(name);
        continue;
      }

      let decoded: DecodedImage;
      try {
        decoded = await decodeHeic(bytes, name);
      } catch (err) {
        refused.push({ file: name, why: (err as Error).message });
        continue;
      }

      const original = `${id}${extension}`;
      const workingCopy = `${id}.png`;
      const thumb = `${id}.${THUMB_EDGE}.jpg`;
      const png = encodePng(decoded);
      await writeAtomically(path.join(originals, original), bytes);
      await writeAtomically(path.join(derived, workingCopy), png);
      await writeAtomically(path.join(derived, thumb), encodeThumbnail(png, decoded));

      const stat = await fsp.stat(resolved);
      const { pages, split } = pagesFor(id, photos[photos.length - 1] ?? null, decoded);
      photos.push({
        id,
        file: `${ORIGINALS}/${original}`,
        workingCopy,
        thumb,
        // THE DECODER'S DIMENSIONS. EXIF's are about the other grid, and storing
        // them here would make the aspect rule above answer about a photograph
        // nobody is looking at.
        width: decoded.width,
        height: decoded.height,
        ...takenAtFrom(readExifTimes(bytes), stat.mtime),
        split,
        pages,
      });
      order.push(...pages.map((page) => page.id));
      added += 1;
    }

    const next: CaptureRecipe = { version: 1, photos, order };
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(next)));
    return { recipe: next, token: tokenForDerived(derived), added, duplicates, refused };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The mint
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHO DOES WHAT, AND WHY IT IS SPLIT THIS WAY ─────────────────────────────
 *
 * MAIN decides the list, the sizes and the order; THE RENDERER rasterizes
 * exactly that list and sends back one JPEG at a time; MAIN assembles the PDF.
 * The rectifying happens in the renderer because it is a WebGL shader the
 * editor already runs for its live preview — one implementation, native speed —
 * and doing it here would mean a second one in JavaScript, seconds a page.
 *
 * ONE PAGE AT A TIME ACROSS THE BRIDGE, and each one lands on disk before the
 * next is asked for. A shoot is hundreds of megabytes of JPEG; holding it in
 * one heap to assemble at the end would put the whole book in memory twice, in
 * a process that also has an app in it.
 *
 * THE PAGES ARE STAGED INSIDE THE PROJECT rather than in the system temp
 * directory. A mint interrupted by a crash leaves a numbered directory under
 * `capture/mints/` that nothing reads and the next mint does not touch. That is
 * a visible mess in one folder, which is better than an invisible one in
 * %TEMP% — and it cannot become a cross-volume rename at commit.
 */
interface MintSession {
  projectDir: string;
  /** The shelf row. The renderer never sees this; a cancel arrives through it. */
  jobId: string;
  staging: string;
  pages: CaptureMintPage[];
  received: Set<number>;
}

const mints = new Map<string, MintSession>();

/** Nominal dots per inch for the page box. 72 points to the inch. */
const MINT_DPI = 300;

function sessionOf(mintId: string): MintSession {
  const session = mints.get(mintId);
  if (session === undefined) {
    throw new CaptureError(
      `There is no mint called ${mintId} in progress. It was finished, given up on, or belongs to a `
      + 'run of this app that has since closed.',
    );
  }
  return session;
}

async function forget(session: MintSession, mintId: string): Promise<void> {
  mints.delete(mintId);
  await fsp.rm(session.staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
}

/**
 * Work out what this mint will print, and open a session for it.
 *
 * ── MAIN DENORMALIZES EXACTLY ONCE, AND THIS IS THE ONCE ────────────────────
 *
 * The recipe is fractions from end to end. Here they are multiplied by the
 * working copy's decoded dimensions and never again — the renderer is handed
 * `quadPx` in pixels beside the `sourceWidth`/`sourceHeight` they were computed
 * against, so it can ASSERT its decoded bitmap matches what main measured
 * rather than trusting it. There is no second conversion anywhere to disagree
 * with this one, which is the guarantee that makes `PixelQuad` being a mere
 * alias tolerable.
 *
 * ── THE ORDER IS THE ORDER, AND STRIKES ARE DROPPED HERE ────────────────────
 *
 * `recipe.order` lists every page id including struck ones, and this is the one
 * place they are filtered. The renderer receives a list that is already the
 * book: no strike logic on that side, no chance of the two sides disagreeing
 * about which leaf is in.
 */
export async function mintBegin(projectDir: string): Promise<CaptureMintBegun> {
  const recipe = await readRecipe(projectDir);
  const photoOf = new Map<string, CapturePhoto>();
  const pageOf = new Map<string, CapturePage>();
  for (const photo of recipe.photos) {
    for (const page of photo.pages) {
      photoOf.set(page.id, photo);
      pageOf.set(page.id, page);
    }
  }

  const pages: CaptureMintPage[] = [];
  for (const pageId of recipe.order) {
    const page = pageOf.get(pageId);
    const photo = photoOf.get(pageId);
    // The validator already refuses a recipe whose order and pages disagree, so
    // reaching here means the file changed under us between load and mint.
    if (page === undefined || photo === undefined) {
      throw new CaptureError(
        `The recipe lists a page (${pageId}) that no photograph holds. Reopen the project before minting.`,
      );
    }
    if (page.struck) continue;
    const quadPx = page.quad.map(
      ([x, y]) => [x * photo.width, y * photo.height] as const,
    ) as unknown as PixelQuad;
    const size = outputSizeFor(quadPx);
    pages.push({
      pageId,
      workingCopy: photo.workingCopy,
      quadPx,
      sourceWidth: photo.width,
      sourceHeight: photo.height,
      outWidth: size.width,
      outHeight: size.height,
    });
  }

  if (pages.length === 0) {
    throw new CaptureError(
      'Every page in this project is struck, so there is nothing to mint. Restore a page first.',
    );
  }

  const mintId = randomUUID();
  const staging = path.join(captureDir(projectDir), MINTS, mintId);
  await fsp.mkdir(staging, { recursive: true });
  const manifest = await readManifest(projectDir).catch(() => null);
  mints.set(mintId, {
    projectDir,
    jobId: beginMint(projectDir, manifest?.title ?? path.basename(projectDir), pages.length),
    staging,
    pages,
    received: new Set<number>(),
  });
  return { mintId, pages };
}

/**
 * One rectified page, as the renderer finished it.
 *
 * THE CANCEL IS CHECKED HERE and nowhere else. Pressing ✕ sets the shelf row to
 * cancelled in a microsecond, but the renderer is midway through a page and will
 * keep sending; nothing in main can reach across and stop it. So the first page
 * to arrive after a cancel is refused, the staging directory goes, and the
 * renderer learns the mint is over by being told no. Within one page, rather
 * than instantly — which for a stage measured in minutes is the same thing.
 */
export async function mintPage(mintId: string, index: number, jpeg: ArrayBuffer): Promise<void> {
  const session = sessionOf(mintId);
  if (mintCancelled(session.jobId)) {
    await forget(session, mintId);
    throw new CaptureError('This mint was cancelled, so its pages are no longer being collected.');
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.pages.length) {
    throw new CaptureError(
      `Page ${index} is not one of the ${session.pages.length} pages this mint asked for.`,
    );
  }
  await writeAtomically(path.join(session.staging, `${index}.jpg`), Buffer.from(jpeg));
  session.received.add(index);
  noteMintPage(session.jobId, session.received.size);
}

/**
 * Assemble the PDF, file it as the project's document, and answer with the step.
 *
 * ── AN IMAGE-ONLY PDF, WHICH IS THE ENTIRE OUTPUT OF THIS STAGE ─────────────
 *
 * One JPEG per page, drawn to fill its own page box, no text layer and no
 * fonts. From here the book is an ordinary scanned PDF and nothing downstream
 * knows a photograph was ever involved — which is the seam this whole feature
 * was designed around.
 *
 * THE PAGE BOX IS THE PIXELS AT A NOMINAL 300 DPI. Nothing is resampled: the
 * JPEG goes in at its own resolution and the box is sized to suit it, so the
 * declared page is roughly the physical page it was photographed from. The read
 * stage rasterizes at its own budget later; this number never constrains it.
 *
 * REFUSES A BOOK WITH A HOLE IN IT. Every page main asked for must have come
 * back. A missing one would print a book quietly short a leaf, which is exactly
 * the failure the order cross-check exists to prevent one layer up.
 */
export async function mintCommit(mintId: string): Promise<LedgerStep> {
  const session = sessionOf(mintId);
  if (mintCancelled(session.jobId)) {
    await forget(session, mintId);
    throw new CaptureError('This mint was cancelled before it could be finished.');
  }
  const missing = session.pages
    .map((_page, index) => index)
    .filter((index) => !session.received.has(index));
  if (missing.length > 0) {
    throw new CaptureError(
      `${missing.length} of ${session.pages.length} pages never arrived, so this book would be `
      + `short a leaf. Missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}.`,
    );
  }

  try {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < session.pages.length; index++) {
      const asked = session.pages[index]!;
      const jpeg = await fsp.readFile(path.join(session.staging, `${index}.jpg`));
      const image = await pdf.embedJpg(jpeg);
      const width = (asked.outWidth * 72) / MINT_DPI;
      const height = (asked.outHeight * 72) / MINT_DPI;
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
    const bytes = Buffer.from(await pdf.save());
    const step = await recordMint(session.projectDir, bytes, session.pages.length);
    settleMint(session.jobId, { file: path.join(session.projectDir, ...step.payload.split('/')) });
    await forget(session, mintId);
    return step;
  } catch (err) {
    // The row must not sit at `running` for the rest of the session because an
    // embed threw. The staging pages are kept: the failure is worth looking at.
    settleMint(session.jobId, { error: err instanceof Error ? err.message : String(err) });
    mints.delete(mintId);
    throw err;
  }
}

/** Give up. Nothing is left behind and no step is appended. */
export async function mintAbort(mintId: string): Promise<void> {
  const session = mints.get(mintId);
  if (session === undefined) return; // giving up twice is giving up
  cancelHere(session.jobId);
  await forget(session, mintId);
}
