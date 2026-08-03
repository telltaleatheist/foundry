/**
 * The tar.gz reader.
 *
 * It exists because a packaged foundry cannot depend on a system `tar` being
 * present and behaving the same on three platforms, so the container is parsed
 * here — which means the parsing is this program's problem and gets tested like
 * anything else it owns.
 *
 * The cases that matter are the refusals. A vendored Tesseract is regular files
 * in directories; anything else in that archive is either a mistake or an
 * attack, and both are worth stopping on rather than skipping quietly.
 */
import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractTarGz, readTarGz } from '../../src/models/archive.js';

const BLOCK = 512;

/** A tar header, checksummed the way tar defines it. */
function header(name: string, size: number, typeflag = '0', mode = '0000644'): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf-8');
  h.write(mode.padStart(7, '0') + '\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum field, as spaces, while summing
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** A whole gzipped tar out of [name, contents] pairs. */
function tarGz(files: Array<[string, string, string?]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body, typeflag] of files) {
    const data = Buffer.from(body, 'utf-8');
    parts.push(header(name, data.length, typeflag ?? '0'));
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end of archive
  return gzipSync(Buffer.concat(parts));
}

describe('reading a tar.gz', () => {
  test('regular files come back with their names and bytes', () => {
    const entries = readTarGz(tarGz([
      ['./tesseract.exe', 'MZ fake'],
      ['./tessdata/eng.traineddata', 'language data'],
      ['./tessdata/configs/tsv', 'tessedit_create_tsv 1\n'],
    ]));
    expect(entries.map((e) => e.name)).toEqual([
      'tesseract.exe',
      'tessdata/eng.traineddata',
      'tessdata/configs/tsv',
    ]);
    expect(entries[2]!.data.toString('utf-8')).toBe('tessedit_create_tsv 1\n');
  });

  test('a directory entry carries no file', () => {
    const entries = readTarGz(tarGz([['./tessdata/', '', '5'], ['./tessdata/x', 'y']]));
    expect(entries.map((e) => e.name)).toEqual(['tessdata/x']);
  });

  test('a symlink is refused rather than skipped', () => {
    // Skipping it would produce a bundle that is missing a file and says nothing,
    // which is the failure mode this whole program is built to refuse.
    expect(() => readTarGz(tarGz([['evil', '/etc/passwd', '2']]))).toThrow(/not a regular file/);
  });

  test('a corrupt header is named by its offset, not guessed past', () => {
    const good = tarGz([['a', 'b']]);
    const raw = Buffer.from(require('node:zlib').gunzipSync(good));
    raw.write('!!!!!!!!', 148, 8, 'ascii'); // clobber the checksum
    expect(() => readTarGz(gzipSync(raw))).toThrow(/does not checksum/);
  });

  test('an entry claiming more bytes than the archive holds is refused', () => {
    const parts = [header('big', 4096), Buffer.alloc(BLOCK, 0)];
    expect(() => readTarGz(gzipSync(Buffer.concat(parts)))).toThrow(/the archive ends first/);
  });
});

describe('extracting', () => {
  test('writes the tree and reports what it wrote', () => {
    const dest = mkdtempSync(join(tmpdir(), 'foundry-tar-'));
    const written = extractTarGz(tarGz([
      ['./tesseract.exe', 'MZ fake'],
      ['./tessdata/eng.traineddata', 'language data'],
    ]), dest);
    expect(written.length).toBe(2);
    expect(existsSync(join(dest, 'tesseract.exe'))).toBe(true);
    expect(readFileSync(join(dest, 'tessdata', 'eng.traineddata'), 'utf-8')).toBe('language data');
  });

  test('a path that escapes the destination is refused, and nothing is installed', () => {
    const dest = mkdtempSync(join(tmpdir(), 'foundry-tar-'));
    expect(() => extractTarGz(tarGz([['../escaped', 'nope']]), dest)).toThrow(/resolves outside/);
    expect(existsSync(join(dest, '..', 'escaped'))).toBe(false);
  });

  test('a traversal buried mid-path is caught too', () => {
    // `a/../../b` is the spelling that a naive "does it start with ..?" check
    // lets through, which is why the check is on the RESOLVED path.
    const dest = mkdtempSync(join(tmpdir(), 'foundry-tar-'));
    expect(() => extractTarGz(tarGz([['a/../../b', 'nope']]), dest)).toThrow(/resolves outside/);
  });

  test('an archive with no files at all is an error, not a silent success', () => {
    const dest = mkdtempSync(join(tmpdir(), 'foundry-tar-'));
    expect(() => extractTarGz(tarGz([]), dest)).toThrow(/no files/);
  });
});
