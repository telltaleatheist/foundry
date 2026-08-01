/**
 * The band segmenter's no-fallback contract, and the fixture reader.
 *
 * bands.py's docstring states the contract this port had to preserve:
 *
 *   > No fallbacks: a page that cannot be segmented raises, is reported by
 *   > number, and makes the run exit nonzero.
 *
 * So a page with no ink is not "a page with zero bands" and a black page is not
 * "a page whose paper is dark". Both are errors carrying the page number, and
 * the failure messages below are the Python implementation's, verified against
 * it on the same synthetic rasters.
 */

import { describe, expect, test } from 'bun:test';

import { PageSegmentationError, processPage } from '../../src/scan/bands.js';
import { readPgm, writePgm, type GrayRaster } from '../../src/scan/pgm.js';

function flat(value: number, width = 180, height = 200): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

describe('a page that cannot be segmented raises, carrying its page number', () => {
  test('a blank page has no ink, and that is an error', () => {
    // Verified against bands.py: ValueError("no ink found after border masking")
    expect(() => processPage(flat(255), 42)).toThrow(PageSegmentationError);
    try {
      processPage(flat(255), 42);
      throw new Error('unreachable');
    } catch (err) {
      const e = err as PageSegmentationError;
      expect(e.page).toBe(42);
      expect(e.message).toBe('page 42: no ink found after border masking');
    }
  });

  test('flat mid-grey is the same failure — no ink is no ink', () => {
    expect(() => processPage(flat(128), 3)).toThrow('page 3: no ink found after border masking');
  });

  test('a black page names its paper tone rather than segmenting it', () => {
    // Verified against bands.py: ValueError("page is black (paper tone 0) - not a scan?")
    expect(() => processPage(flat(0), 9)).toThrow('page 9: page is black (paper tone 0) - not a scan?');
  });
});

describe('the PGM reader', () => {
  test('round-trips a raster', () => {
    const raster = flat(200, 7, 5);
    raster.data[11] = 3;
    const back = readPgm(writePgm(raster));
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(raster.data));
  });

  test('reads comments and multi-line headers', () => {
    const text = 'P5\n# a comment\n4 2\n255\n';
    const bytes = new Uint8Array([...new TextEncoder().encode(text), ...new Uint8Array(8).fill(9)]);
    const r = readPgm(bytes);
    expect([r.width, r.height, r.data[0]]).toEqual([4, 2, 9]);
  });

  test('names what is wrong rather than guessing', () => {
    expect(() => readPgm(new TextEncoder().encode('P6\n1 1\n255\n '), 'x.pgm')).toThrow(/not a binary PGM/);
    expect(() => readPgm(new TextEncoder().encode('P5\n2 2\n65535\n '), 'x.pgm')).toThrow(/only 8-bit/);
    expect(() => readPgm(new TextEncoder().encode('P5\n4 4\n255\nab'), 'x.pgm')).toThrow(/PGM is short/);
  });
});
