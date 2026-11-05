/**
 * The grayscale raster the band segmenter works on, and a reader for the one
 * file format that carries it with no codec.
 *
 * `bands.ts` is pure geometry over numbers. Giving it an image decoder would
 * drag a native dependency into the most portable part of the program and make
 * the fixture set hostage to a PNG library's version, so it takes a plain
 * raster instead: width, height, one byte per pixel, row-major, 0 = black.
 * Whoever has the page — a PDF renderer, a PNG decoder, a test — hands over
 * that and nothing else.
 *
 * Binary PGM (P5) is the fixture format for exactly that reason: it IS the
 * raster with a nine-byte header, so a fixture cannot drift because a decoder
 * changed, and the reader below is thirty lines of arithmetic with no
 * dependencies. The fixtures are produced from the same page renders the
 * Python reference implementation reads (see fixtures/scan/README.md).
 */

export interface GrayRaster {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, row-major, `data[y * width + x]`. 0 = black. */
  readonly data: Uint8Array;
}

/**
 * Read a binary PGM (P5). Only 8-bit maxvals are accepted: a 16-bit PGM would
 * have to be range-reduced to fit `GrayRaster`, and silently halving someone's
 * page is the kind of quiet substitution this program does not do.
 */
export function readPgm(bytes: Uint8Array, what = '<pgm>'): GrayRaster {
  if (bytes.length < 2 || bytes[0] !== 0x50 /* P */ || bytes[1] !== 0x35 /* 5 */) {
    throw new Error(`${what}: not a binary PGM — expected a "P5" magic number`);
  }

  let pos = 2;
  const nextToken = (): string => {
    for (;;) {
      while (pos < bytes.length && isPgmSpace(bytes[pos]!)) pos++;
      if (pos < bytes.length && bytes[pos] === 0x23 /* # */) {
        while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
        continue;
      }
      break;
    }
    const start = pos;
    while (pos < bytes.length && !isPgmSpace(bytes[pos]!)) pos++;
    if (pos === start) throw new Error(`${what}: truncated PGM header`);
    return String.fromCharCode(...bytes.subarray(start, pos));
  };

  const width = pgmInt(nextToken(), 'width', what);
  const height = pgmInt(nextToken(), 'height', what);
  const maxval = pgmInt(nextToken(), 'maxval', what);
  if (maxval !== 255) {
    throw new Error(`${what}: maxval is ${maxval}; only 8-bit (255) PGM is read here`);
  }
  // Exactly ONE whitespace byte separates the header from the pixels.
  if (pos >= bytes.length || !isPgmSpace(bytes[pos]!)) {
    throw new Error(`${what}: no whitespace after the PGM header`);
  }
  pos++;

  const need = width * height;
  const have = bytes.length - pos;
  if (have < need) {
    throw new Error(`${what}: PGM is short — ${have} pixel bytes for a ${width}x${height} page (need ${need})`);
  }
  return { width, height, data: bytes.subarray(pos, pos + need) };
}

/** Serialise a raster back to binary PGM — used to write fixtures and dumps. */
export function writePgm(raster: GrayRaster): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${raster.width} ${raster.height}\n255\n`);
  const out = new Uint8Array(header.length + raster.data.length);
  out.set(header, 0);
  out.set(raster.data, header.length);
  return out;
}

function isPgmSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

function pgmInt(token: string, field: string, what: string): number {
  if (!/^[0-9]+$/.test(token)) {
    throw new Error(`${what}: PGM ${field} is "${token}", not a number`);
  }
  return Number(token);
}
