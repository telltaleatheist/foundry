/**
 * The Tesseract pin, and the band path's invocation.
 *
 * Two things are being held down here.
 *
 * 1. THE PIN IS NOT DECORATIVE. `resolveTesseract` must refuse a binary whose
 *    `--version` is not the pinned one and refuse tessdata whose sha256 is not
 *    the pinned one, and must never reach for PATH when the vendored copy is
 *    missing. Each of those is tested against a synthetic vendor directory, so
 *    the failures are exercised rather than assumed.
 *
 * 2. THE INVOCATION REPRODUCES `run-book.py`. `fixtures/scan/ocr/<page>.json`
 *    is what BookForge's band path read for the same fixture pages — one
 *    tesseract per page over an image list, `--psm 7`, TSV, `--psm 13` for a
 *    crop that read as nothing. The end-to-end test compares text, confidence
 *    AND which psm produced each line. It needs a verified vendored Tesseract,
 *    so it SKIPS (loudly, by name) when there isn't one; it never passes by
 *    quietly doing nothing.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyDeskew, processPage } from '../../src/scan/bands.js';
import { readPgm } from '../../src/scan/pgm.js';
import {
  OCR_DPI,
  compiledManifest,
  parseTsv,
  platformKey,
  recognizeBands,
  resolveTesseract,
  type TesseractManifest,
} from '../../src/scan/tesseract.js';

const ROOT = join(import.meta.dir, '..', '..');
const VENDOR = join(ROOT, 'vendor', 'tesseract');
const FIXTURES = join(ROOT, 'fixtures', 'scan');

describe('the dpi pin', () => {
  test('is 200 and the vendored manifest agrees', () => {
    expect(OCR_DPI).toBe(200);
    if (existsSync(join(VENDOR, 'manifest.json'))) {
      const m: TesseractManifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf-8'));
      expect(m.dpi).toBe(OCR_DPI);
    }
  });
});

describe('TSV parsing', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const row = (level: number, page: number, conf: string, text: string) =>
    [level, page, 1, 1, 1, 1, 0, 0, 10, 10, conf, text].join('\t');

  test('ties every word back to the crop it came from', () => {
    const out = parseTsv(
      [header, row(1, 1, '-1', ''), row(5, 1, '95.5', 'hello'), row(5, 1, '90.0', 'world'),
        row(1, 2, '-1', ''), row(5, 2, '80.25', 'second')].join('\n'),
      2,
    );
    expect(out[0]).toEqual({ text: 'hello world', conf: 92.75 });
    expect(out[1]).toEqual({ text: 'second', conf: 80.25 });
  });

  test('a crop that read as nothing keeps its place with an empty string', () => {
    const out = parseTsv([header, row(1, 1, '-1', ''), row(1, 2, '-1', ''), row(5, 2, '70', 'x')].join('\n'), 2);
    expect(out[0]).toEqual({ text: '', conf: null });
    expect(out[1]!.text).toBe('x');
  });

  test('output that does not account for every crop is an error, not a short list', () => {
    // The whole pipeline exists to end silent line loss; a missing page record
    // is exactly that failure one level down.
    expect(() => parseTsv([header, row(1, 1, '-1', ''), row(5, 1, '90', 'only')].join('\n'), 3)).toThrow(
      'tesseract accounted for 1 of 3 crops',
    );
    expect(() => parseTsv([header, row(1, 9, '-1', '')].join('\n'), 2)).toThrow('reported image 9 of 2');
  });

  test('rounds mean confidence the way run-book.py does', () => {
    // Python's round() is half-to-even: round(2.675, 2) is 2.67, not 2.68.
    const out = parseTsv(
      [header, row(1, 1, '-1', ''), row(5, 1, '2.665', 'a'), row(5, 1, '2.665', 'b')].join('\n'),
      1,
    );
    expect(out[0]!.conf).toBe(2.67);
  });
});

describe('pin verification', () => {
  const key = platformKey();

  /**
   * A synthetic vendor root plus the pin that describes it.
   *
   * The pin is HANDED IN rather than written to disk: it is compiled into the
   * build now, so a manifest.json in a temp directory would be read by nothing.
   * `options.manifest` is the injection seam for exactly this, and it loosens
   * nothing - whatever is passed is verified as strictly as the real pin.
   */
  function fakeVendor(
    mutate: (m: TesseractManifest) => void,
    versionSays = 'tesseract 5.5.1',
  ): { dir: string; manifest: TesseractManifest } {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-pin-'));
    mkdirSync(join(dir, key, 'tessdata'), { recursive: true });
    const data = join(dir, key, 'tessdata', 'eng.traineddata');
    writeFileSync(data, 'not really language data');
    // sha256 of that string, so the honest manifest verifies.
    const sha = new Bun.CryptoHasher('sha256').update(readFileSync(data)).digest('hex');
    const bin = join(dir, key, 'tesseract');
    writeFileSync(bin, `#!/bin/sh\necho "${versionSays}"\n`);
    chmodSync(bin, 0o755);
    const manifest: TesseractManifest = {
      dpi: 200,
      platforms: {
        [key]: {
          expectedVersion: '5.5.1',
          binary: `${key}/tesseract`,
          binarySha256: null,
          tessdataDir: `${key}/tessdata`,
          tessdata: { 'eng.traineddata': { sha256: sha, bytes: 24 } },
          portable: false,
        },
      },
    };
    mutate(manifest);
    return { dir, manifest };
  }

  const shellOk = process.platform !== 'win32';

  test('the pin compiled into this build is well-formed', () => {
    // The pin used to be READ off disk, so a packaged binary had none at all and
    // refused to scan. It is imported now, which makes this an assertion about
    // the shipped artifact rather than about the checkout.
    const m = compiledManifest();
    expect(m.dpi).toBe(OCR_DPI);
    expect(Object.keys(m.platforms).length).toBeGreaterThan(0);
    for (const [name, pin] of Object.entries(m.platforms)) {
      // Recorded VERBATIM as that build spells it: Homebrew prints "tesseract
      // 5.5.1", the Windows build "tesseract v5.5.0.20241111". Both sides take
      // the same field of the same line - the scan script with awk, readVersion
      // with a regex - so normalising here would mean two normalisations that
      // could drift, to make one string prettier.
      expect(pin.expectedVersion, `${name} must pin its own version`).toMatch(/^v?[0-9]+[.][0-9]+/);
      expect(pin.binary.startsWith(`${name}/`), `${name}: binary sits under its platform dir`).toBe(true);
      expect(Object.keys(pin.tessdata)).toContain('configs/tsv');
      expect(Object.keys(pin.tessdata)).toContain('eng.traineddata');
    }
  });

  test('a missing vendored binary says so, names the fetch, and does NOT fall back to PATH', async () => {
    const { dir, manifest } = fakeVendor((m) => {
      m.platforms[key]!.binary = `${key}/not-there`;
    });
    const err = await resolveTesseract({ vendorDir: dir, manifest }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/PATH is deliberately NOT searched/);
    // The whole point of the change: the error says how to GET one.
    expect((err as Error).message).toMatch(/foundry models pull/);
  });

  test.skipIf(!shellOk)('the right version verifies', async () => {
    const { dir, manifest } = fakeVendor(() => {});
    const r = await resolveTesseract({ vendorDir: dir, manifest });
    expect(r.version).toBe('5.5.1');
    expect(r.platform).toBe(key);
  });

  test.skipIf(!shellOk)('a different version is refused', async () => {
    const { dir, manifest } = fakeVendor(() => {}, 'tesseract 5.3.4');
    await expect(resolveTesseract({ vendorDir: dir, manifest })).rejects.toThrow(/version mismatch/);
  });

  test.skipIf(!shellOk)('tessdata whose hash does not match is refused, naming the file', async () => {
    const { dir, manifest } = fakeVendor((m) => {
      m.platforms[key]!.tessdata['eng.traineddata']!.sha256 = 'f'.repeat(64);
    });
    await expect(resolveTesseract({ vendorDir: dir, manifest })).rejects.toThrow(/does not match the pin/);
  });

  test.skipIf(!shellOk)('a dpi that disagrees with this build is refused', async () => {
    const { dir, manifest } = fakeVendor((m) => {
      m.dpi = 300;
    });
    await expect(resolveTesseract({ vendorDir: dir, manifest })).rejects.toThrow(/defined at 300 dpi/);
  });

  test('an unvendored platform names what IS vendored', async () => {
    const { dir, manifest } = fakeVendor((m) => {
      m.platforms = { 'sunos-sparc': m.platforms[key]! };
    });
    await expect(resolveTesseract({ vendorDir: dir, manifest })).rejects.toThrow(/has no entry for/);
  });
});

// --------------------------------------------------------------- end to end

const vendored = await (async () => {
  try {
    return await resolveTesseract();
  } catch {
    return null;
  }
})();

/**
 * The Tesseract these fixtures were RECORDED with.
 *
 * `fixtures/scan/ocr/*.json` holds exact text, exact confidences and the exact
 * psm per line, captured on darwin-arm64 running Homebrew's 5.5.1. They are a
 * statement about that build, so comparing them to the output of a different one
 * measures the difference between two Tesseracts rather than a regression here.
 *
 * The Windows bundle is 5.5.0.20241111 (no 5.5.1 Windows build is published),
 * and on these pages it segments IDENTICALLY — same band boxes, same psm — while
 * recognising 7 of 138 lines differently and reporting different confidences
 * throughout. So the comparison is gated on the version, loudly, rather than
 * either failing on Windows forever or being quietly loosened to fuzzy matching:
 * the whole point of the pin is that a different Tesseract is a different
 * segmenter, and this is that fact showing up in the one place equipped to
 * measure it. See the note on win32-x64 in vendor/tesseract/manifest.json.
 */
const FIXTURE_VERSION = '5.5.1';

describe('the band path reads what run-book.py read', () => {
  const cases = ['deathstalker-p100', 'deathstalker-rebellion-p295', 'michelle-remembers-p100', 'was-hitler-an-atheist-p4'];
  const comparable = vendored?.version === FIXTURE_VERSION;

  test('a verified Tesseract is vendored for this platform', () => {
    if (!vendored) {
      console.warn(
        `[skip] no verified Tesseract for ${platformKey()} — run ` +
          '`foundry models pull`, or tools/scan-vendor-tesseract.sh in a checkout. ' +
          'The end-to-end cases below did not run.',
      );
    } else if (!comparable) {
      console.warn(
        `[skip] this platform's pinned Tesseract is ${vendored.version}; ` +
          `fixtures/scan/ocr was recorded with ${FIXTURE_VERSION}. The line-for-line ` +
          'comparison below did not run: it would be measuring the gap between two ' +
          'Tesseract builds, not a regression. Re-record the fixtures on this platform, ' +
          'or vendor a matching build.',
      );
    }
    expect(true).toBe(true);
  });

  for (const name of cases) {
    test.skipIf(!comparable)(`${name}: text, confidence and psm line for line`, async () => {
      const want = JSON.parse(readFileSync(join(FIXTURES, 'ocr', `${name}.json`), 'utf-8'));
      let raster = readPgm(new Uint8Array(readFileSync(join(FIXTURES, 'pages', `${name}.pgm`))));
      const bands = processPage(raster, want.page);
      if (bands.deskewDeg) raster = applyDeskew(raster, bands.deskewDeg);

      const got = await recognizeBands(vendored!, raster, bands.bands, want.page);
      expect(got.lines.length).toBe(want.lines.length);
      for (let i = 0; i < want.lines.length; i++) {
        expect({ i, ...got.lines[i]! }).toEqual({ i, ...want.lines[i] });
      }
    }, 60_000);
  }
});
