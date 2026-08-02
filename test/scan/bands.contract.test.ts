/**
 * The band segmenter's no-fallback contract, and the fixture reader.
 *
 * bands.py's docstring states the contract this port had to preserve:
 *
 *   > No fallbacks: a page that cannot be segmented raises, is reported by
 *   > number, and makes the run exit nonzero.
 *
 * One place that contract drew the line wrong, and this port has since
 * corrected it: a page with zero ink is BLANK, not unsegmentable. Real books
 * carry blank endpapers, and under the Python rule one clean endpaper aborted a
 * whole 360-page run (Michelle Remembers p8, Aug 2 2026). A blank page now
 * comes out as a zero-band page, exactly like the near-blank pages that always
 * squeaked through on a few pixels of dirt. A black page is still an error —
 * that is a bad render, not a page.
 *
 * Error messages count pages 1-based to match the scan log; the `page` field
 * keeps the artifacts' 0-based index.
 */

import { describe, expect, test } from 'bun:test';

import { PageSegmentationError, processPage } from '../../src/scan/bands.js';
import { readPgm, writePgm, type GrayRaster } from '../../src/scan/pgm.js';

function flat(value: number, width = 180, height = 200): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

describe('blank pages are pages, unreadable pages are errors', () => {
  test('a blank page segments to zero bands', () => {
    const r = processPage(flat(255), 42);
    expect(r.page).toBe(42);
    expect(r.bands).toEqual([]);
    expect(r.stats.inkPx).toBe(0);
    expect(r.deskewDeg).toBe(0);
  });

  test('flat mid-grey is the same page — uniform tone is no ink', () => {
    const r = processPage(flat(128), 3);
    expect(r.bands).toEqual([]);
    expect(r.stats.inkPx).toBe(0);
  });

  test('a black page names its paper tone rather than segmenting it', () => {
    // Verified against bands.py: ValueError("page is black (paper tone 0) - not a scan?")
    // 0-based index 9 = the log's page 10.
    expect(() => processPage(flat(0), 9)).toThrow('page 10: page is black (paper tone 0) - not a scan?');
    try {
      processPage(flat(0), 9);
      throw new Error('unreachable');
    } catch (err) {
      expect((err as PageSegmentationError).page).toBe(9);
    }
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
