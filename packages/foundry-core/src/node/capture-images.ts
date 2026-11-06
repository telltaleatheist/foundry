/**
 * capture-images — decoding HEIC, encoding PNG, thumbnails and reading a gutter from an image.
 */
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { CaptureGutter } from '../shared/types';
import { gutterOf, lumaFromBgra } from '../shared/gutter';
/*
 * THE TEMP DIR AND THE IMAGE CODEC COME THROUGH THE PLATFORM PORT (2026-11-04).
 * They were `app.getPath('temp')` and `nativeImage`, the only two reasons capture.ts
 * imported Electron; `mountFoundry` hands over Electron's own `nativeImage`,
 * so every decode, resize and encode below runs exactly the code it ran before.
 */
import { images, type PlatformImage } from './platform';
import { CaptureError } from './capture-paths';

/**
 * Deflate off the main thread.
 *
 * `deflateSync` was ~600 ms of unbroken main-thread work per photograph, on top
 * of the decode — a third of the freeze, and the third that did not have to be
 * there at all. The async form hands the compression to libuv’s pool, so the
 * event loop keeps turning while a 36 MiB raster is squeezed.
 */
export const deflate = promisify(zlib.deflate);

// ─────────────────────────────────────────────────────────────────────────────
// Decoding — HEIC in, upright RGBA out
// ─────────────────────────────────────────────────────────────────────────────

export interface DecodedImage {
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
export interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(into: { data: Uint8ClampedArray; width: number; height: number }, done: (out: unknown) => void): void;
}

export interface HeifModule { HeifDecoder: new () => { decode(bytes: Buffer): HeifImage[] } }

export let heif: HeifModule | null = null;

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
export function decoderModule(): HeifModule {
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
export async function decodeHeic(bytes: Buffer, name: string): Promise<DecodedImage> {
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
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
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
export async function encodePng(image: DecodedImage): Promise<Buffer> {
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
    pngChunk('IDAT', await deflate(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The long edge of a thumbnail, in pixels. */
export const THUMB_EDGE = 640;

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
 *
 * ── IT HANDS BACK THE IMAGE, NOT THE JPEG, since 2026-09-21 ────────────────
 *
 * It returned the encoded bytes while the thumbnail had one reader. It has two
 * now: the file the grid draws, and the gutter measured off the same bitmap
 * (`gutterFromImage`). Resizing twice would be two decodes and two resamples of
 * a 36 MiB raster per photograph — the expensive half of an intake — to produce
 * two copies of one picture that must agree, since the gutter is a fraction of
 * the frame the person is looking at. One resize, two readings.
 */
export function thumbnailOf(png: Buffer, image: { width: number; height: number }): PlatformImage {
  const wide = image.width >= image.height;
  return images().createFromBuffer(png).resize({
    ...(wide ? { width: THUMB_EDGE } : { height: THUMB_EDGE }),
    quality: 'best',
  });
}

/**
 * WHERE THE FOLD LOOKED TO BE on this thumbnail — the one place main turns a
 * picture into a `CaptureGutter`.
 *
 * `shared/gutter.ts` carries the algorithm and the argument for it; this is the
 * decode. Null for a fold it cannot see AND for an image it cannot read, which
 * is a conflation this can afford and the recipe cannot: the recipe's absent
 * means NEVER MEASURED and is what the backfill looks for, so the callers
 * decide which of the two they are in — intake has a bitmap in hand and writes
 * whatever this says, while `gutteredRecipe` checks the file first and leaves
 * the field absent when there is no thumbnail to read.
 *
 * `toBitmap()` is BGRA at scale factor 1, which is what an image built from a
 * buffer has; `lumaFromBgra` is where that order is written down.
 */
export function gutterFromImage(image: PlatformImage): CaptureGutter | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width < 2 || height < 2) return null;
  return gutterOf(lumaFromBgra(image.toBitmap(), width, height), width, height);
}
