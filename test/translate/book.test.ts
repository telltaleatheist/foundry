/**
 * The container: reading an EPUB back in, and refusing one that is not a
 * foundry book.
 *
 * The pass-through property is tested against a DEFLATED entry, because that is
 * the case where "the bytes come back unchanged" and "the content comes back
 * unchanged" are different claims and the reader has to make both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { crc32, writeZip, zipText } from '../../src/export/zip.js';
import { BookError, languageRange, navLabels, readFoundryBook, resolveHref } from '../../src/translate/book.js';
import { readZip, readZipMap, UnzipError } from '../../src/translate/unzip.js';
import { CHAPTER_PATH, foundryEpub, NAV_PATH, OPF_PATH, PICTURE, plainEpub } from './fixture.js';

test('a stored archive round-trips, content and raw bytes alike', () => {
  const bytes = writeZip([
    zipText('mimetype', 'application/epub+zip'),
    { path: 'bin/data', data: new Uint8Array([0, 1, 2, 255, 128]) },
  ]);
  const members = readZip(bytes);
  assert.deepEqual(members.map((m) => m.path), ['mimetype', 'bin/data']);
  assert.equal(members[0].text(), 'application/epub+zip');
  assert.equal(members[0].method, 0);
  assert.deepEqual([...members[1].data], [0, 1, 2, 255, 128]);
  assert.deepEqual([...members[1].raw], [0, 1, 2, 255, 128]);
});

test('a deflated entry inflates, and its raw bytes stay compressed for pass-through', () => {
  const content = new TextEncoder().encode('x'.repeat(4000));
  const packed = new Uint8Array(deflateRawSync(content));
  const bytes = writeZip([
    { path: 'a.txt', data: packed, method: 8, crc: crc32(content), uncompressedSize: content.length },
  ]);
  const member = readZip(bytes)[0];
  assert.equal(member.method, 8);
  assert.equal(member.uncompressedSize, 4000);
  assert.equal(member.text(), 'x'.repeat(4000));
  assert.ok(member.raw.length < 4000, 'the raw bytes are the compressed ones');

  // The pass-through the translator does: hand the raw bytes straight back.
  const again = writeZip([{
    path: member.path, data: member.raw, method: 8,
    crc: member.crc, uncompressedSize: member.uncompressedSize,
  }]);
  assert.equal(readZip(again)[0].text(), 'x'.repeat(4000));
});

test('a truncated archive says so rather than returning half a book', () => {
  const bytes = writeZip([zipText('a.txt', 'hello')]);
  assert.throws(() => readZip(bytes.slice(0, 10)), UnzipError);
});

test('a damaged payload fails its checksum by name', () => {
  const bytes = writeZip([zipText('a.txt', 'hello there')]);
  const damaged = bytes.slice();
  damaged[40] = damaged[40] ^ 0xFF;
  assert.throws(
    () => readZip(damaged),
    (error: Error) => error instanceof UnzipError && /a\.txt/.test(error.message),
  );
});

test('the synthetic book is read the way the real chain is walked', () => {
  const book = readFoundryBook(foundryEpub());
  assert.equal(book.opfPath, OPF_PATH);
  assert.equal(book.navPath, NAV_PATH);
  assert.deepEqual(book.documents.map((d) => d.path), [CHAPTER_PATH]);
  assert.equal(book.documents[0].stamped, true);
  assert.deepEqual([...readZipMap(foundryEpub()).get('EPUB/images/p0009-1.png')!.data], [...PICTURE]);
});

test('an EPUB without foundry stamps is refused, and the sentence says why', () => {
  assert.throws(
    () => readFoundryBook(plainEpub()),
    (error: Error) => error instanceof BookError && error.message ===
      'not a foundry-converted book; translation replaces text inside the categories foundry '
      + 'stamps, and this book has none.',
  );
});

test('a ZIP that is not an EPUB is refused before the pointer chain is walked', () => {
  const bytes = writeZip([zipText('hello.txt', 'not a book')]);
  assert.throws(
    () => readFoundryBook(bytes),
    (error: Error) => error instanceof BookError && /not an EPUB/.test(error.message),
  );
});

test('an EPUB whose container names a package that is not there says which', () => {
  const bytes = writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="EPUB/gone.opf"/></rootfiles></container>'),
  ]);
  assert.throws(
    () => readFoundryBook(bytes),
    (error: Error) => error instanceof BookError && /EPUB\/gone\.opf/.test(error.message),
  );
});

test('dc:language is found as a source range, not as a value', () => {
  const book = readFoundryBook(foundryEpub());
  const range = languageRange(book.opfSource);
  assert.equal(book.opfSource.slice(range.start, range.end), 'de');
});

test('a package with no dc:language is an error rather than an insertion', () => {
  const book = readFoundryBook(foundryEpub());
  const stripped = book.opfSource.replace(/ *<dc:language>de<\/dc:language>\n/, '');
  assert.throws(() => languageRange(stripped), BookError);
});

test('nav labels come back with their ranges and their text decoded', () => {
  const book = readFoundryBook(foundryEpub());
  const labels = navLabels(book.navSource!);
  assert.deepEqual(labels.map((l) => l.text), ['Der Staat', 'Die Ordnung', 'Ein Eintrag ohne Ziel']);
  assert.deepEqual(labels.map((l) => l.href), [
    'text/c0001.xhtml', 'text/c0001.xhtml#sh1', 'text/c0001.xhtml#nowhere',
  ]);
  assert.equal(book.navSource!.slice(labels[0].innerStart, labels[0].innerEnd), 'Der Staat');
});

test('hrefs resolve against the package directory, dots and escapes included', () => {
  assert.equal(resolveHref('EPUB', 'text/c0001.xhtml'), 'EPUB/text/c0001.xhtml');
  assert.equal(resolveHref('EPUB/text', '../nav.xhtml'), 'EPUB/nav.xhtml');
  assert.equal(resolveHref('', 'a/./b.xhtml#frag'), 'a/b.xhtml');
  assert.equal(resolveHref('EPUB', 'my%20chapter.xhtml'), 'EPUB/my chapter.xhtml');
});
