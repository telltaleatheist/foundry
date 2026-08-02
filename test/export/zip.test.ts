/**
 * The ZIP writer, read back by an INDEPENDENT reader (test/export/unzip.ts).
 *
 * The failure worth catching is an archive that this codebase can open and no
 * other reader can, so the reader here parses the central directory the way the
 * spec says to and cross-checks every local header against it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc32, writeZip, zipText, ZipError } from '../../src/export/zip.js';
import { unzip, unzipMap } from './unzip.js';

test('crc32 matches the known vector', () => {
  // The standard check value for "123456789".
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('entries round-trip through an independent reader, crcs verified', () => {
  const bytes = writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml', '<container/>'),
    { path: 'bin/data', data: new Uint8Array([0, 1, 2, 255, 128]) },
  ]);
  const entries = unzip(bytes);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.path), ['mimetype', 'META-INF/container.xml', 'bin/data']);
  assert.equal(entries[0].text(), 'application/epub+zip');
  assert.deepEqual([...entries[2].data], [0, 1, 2, 255, 128]);
});

test('everything is STORED — no entry is compressed', () => {
  const bytes = writeZip([zipText('a.txt', 'x'.repeat(5000))]);
  const e = unzip(bytes)[0];
  assert.equal(e.method, 0);
  assert.equal(e.data.length, 5000);
});

test('the first entry starts at offset 0 and its name sits at offset 30', () => {
  // The OCF rule this exists to serve: a reader identifies an EPUB by reading
  // "mimetype" + its content straight out of the head of the file.
  const bytes = writeZip([zipText('mimetype', 'application/epub+zip'), zipText('other', 'x')]);
  const head = new TextDecoder().decode(bytes.subarray(30, 30 + 8));
  assert.equal(head, 'mimetype');
  const value = new TextDecoder().decode(bytes.subarray(38, 38 + 20));
  assert.equal(value, 'application/epub+zip');
  // No extra field on that entry, which the spec also requires.
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint16(28, true), 0, 'mimetype must carry no extra field');
});

test('entry order is the caller\'s and is never rearranged', () => {
  const bytes = writeZip([zipText('z', '1'), zipText('a', '2'), zipText('m', '3')]);
  assert.deepEqual(unzip(bytes).map(e => e.path), ['z', 'a', 'm']);
});

test('empty entries and an empty archive are both legal', () => {
  const withEmpty = unzipMap(writeZip([zipText('empty', '')]));
  assert.equal(withEmpty.get('empty')!.data.length, 0);
  assert.equal(unzip(writeZip([])).length, 0);
});

test('non-ASCII names round-trip and set the UTF-8 flag', () => {
  const bytes = writeZip([zipText('text/kapitel-über.xhtml', 'x')]);
  const entries = unzip(bytes);
  assert.equal(entries[0].path, 'text/kapitel-über.xhtml');
  // Bit 11 on the local header.
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
});

test('an ASCII name does not set the UTF-8 flag', () => {
  const bytes = writeZip([zipText('plain.txt', 'x')]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint16(6, true) & 0x0800, 0);
});

test('output is reproducible — same entries, identical bytes', () => {
  const build = () => writeZip([zipText('a', 'hello'), zipText('b/c', 'world')]);
  assert.deepEqual([...build()], [...build()]);
});

test('timestamps are fixed, not wall-clock', () => {
  // Two archives written at different moments must not differ. The DOS time and
  // date fields sit at offsets 10 and 12 of the local header.
  const bytes = writeZip([zipText('a', 'x')]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint16(10, true), 0);
  assert.equal(view.getUint16(12, true), (1 << 5) | 1);
});

// ── refusals ────────────────────────────────────────────────────────────────

test('a duplicate path is refused', () => {
  assert.throws(() => writeZip([zipText('a', '1'), zipText('a', '2')]), (e: unknown) => {
    assert.ok(e instanceof ZipError);
    assert.match(e.message, /entry "a" appears twice/);
    return true;
  });
});

test('a backslashed path is refused', () => {
  assert.throws(() => writeZip([zipText('a\\b', 'x')]), /forward-slashed/);
});

test('an absolute path is refused', () => {
  assert.throws(() => writeZip([zipText('/etc/passwd', 'x')]), /is absolute/);
});

test('a traversal segment is refused', () => {
  assert.throws(() => writeZip([zipText('a/../b', 'x')]), /relative path segment/);
  assert.throws(() => writeZip([zipText('a//b', 'x')]), /relative path segment/);
});

test('an empty path is refused', () => {
  assert.throws(() => writeZip([zipText('', 'x')]), /empty path/);
});
