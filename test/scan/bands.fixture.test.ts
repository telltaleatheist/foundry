/**
 * The band-segmenter port's verification: bands.ts against bands.py, box for box.
 *
 * MIGRATION.md §6 makes this the definition of "ported":
 *
 *   > Run `bands.py` and `bands.ts` over the same fixture renders and diff the
 *   > emitted JSON box-for-box. The port is done when they agree on every page
 *   > of the fixture set, and not before.
 *
 * So this is not a smoke test with a tolerance. `fixtures/scan/reference/` holds
 * what the Python implementation emitted for each fixture page (produced by
 * `tools/scan-make-fixtures.py`, which is also what wrote the .pgm each page is
 * read from — one `convert("L")` feeds both sides, so "same input" is a fact and
 * not an assumption about decoders). Every field is compared EXACTLY, including
 * `deskewDeg`: no epsilon is used anywhere in this file, because none was needed.
 *
 * A failure prints the first disagreement with its page, its band index and both
 * values, which is the whole point of keeping the reference around.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { processPage, type PageBands } from '../../src/scan/bands.js';
import { readPgm } from '../../src/scan/pgm.js';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'scan');
const PAGES_DIR = join(FIXTURE_DIR, 'pages');
const REF_DIR = join(FIXTURE_DIR, 'reference');

interface FixtureNote {
  name: string;
  book: string;
  page: number;
  why: string;
}

const notes: FixtureNote[] = JSON.parse(readFileSync(join(FIXTURE_DIR, 'fixtures.json'), 'utf-8')).fixtures;
const names = readdirSync(PAGES_DIR)
  .filter((f) => f.endsWith('.pgm'))
  .map((f) => f.slice(0, -4))
  .sort();

/** Every difference between the port's answer and the reference, in reading order. */
function differences(got: PageBands, want: PageBands): string[] {
  const out: string[] = [];
  const scalar = (field: string, a: unknown, b: unknown) => {
    if (!Object.is(a, b)) out.push(`${field}: got ${JSON.stringify(a)}, reference ${JSON.stringify(b)}`);
  };

  scalar('widthPx', got.widthPx, want.widthPx);
  scalar('heightPx', got.heightPx, want.heightPx);
  scalar('columns', got.columns, want.columns);
  scalar('deskewDeg', got.deskewDeg, want.deskewDeg);
  for (let i = 0; i < 4; i++) scalar(`contentRect[${i}]`, got.contentRect[i], want.contentRect[i]);
  for (const key of Object.keys(want.stats) as Array<keyof PageBands['stats']>) {
    scalar(`stats.${key}`, got.stats[key], want.stats[key]);
  }

  scalar('bands.length', got.bands.length, want.bands.length);
  const n = Math.min(got.bands.length, want.bands.length);
  for (let i = 0; i < n; i++) {
    const a = got.bands[i]!;
    const b = want.bands[i]!;
    for (let k = 0; k < 4; k++) {
      scalar(`bands[${i}].tight[${k}]`, a.tight[k], b.tight[k]);
      scalar(`bands[${i}].crop[${k}]`, a.crop[k], b.crop[k]);
    }
    scalar(`bands[${i}].tall`, a.tall, b.tall);
  }
  return out;
}

describe('bands.ts reproduces bands.py exactly', () => {
  test('the fixture set is present and non-trivial', () => {
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.length).toBe(notes.length);
  });

  for (const name of names) {
    const note = notes.find((f) => f.name === name);
    test(`${name} — ${note?.why ?? 'no note'}`, () => {
      const raster = readPgm(new Uint8Array(readFileSync(join(PAGES_DIR, `${name}.pgm`))), `${name}.pgm`);
      const want: PageBands = JSON.parse(readFileSync(join(REF_DIR, `${name}.json`), 'utf-8'));
      const got = processPage(raster, want.page);

      const diffs = differences(got, want);
      if (diffs.length) {
        const shown = diffs.slice(0, 12).join('\n  ');
        throw new Error(
          `${name}: ${diffs.length} difference(s) from bands.py\n  ${shown}` +
            (diffs.length > 12 ? `\n  ... and ${diffs.length - 12} more` : ''),
        );
      }
      expect(got.bands.length).toBe(want.bands.length);
    });
  }
});
