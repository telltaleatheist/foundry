/**
 * `foundry footnotes --epub` end to end, against a synthetic book.
 *
 * The model is a stub here — what is under test is everything AROUND it: the
 * spine walk, the projection, the report, and the two promises about bytes.
 * A book is read once and never diffed against its source, so "the output
 * differs from the input only where a marker was" has to be a test, not an
 * intention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { crc32, writeZip, type ZipEntry } from '../../src/export/zip.js';
import { runEpubFootnotes } from '../../src/epub/footnotes-stage.js';
import { entryBytes, readZip } from '../../src/epub/zip-read.js';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="s.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="nav"/><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li>x</li></ol></nav></body></html>`;

/** The chapter with markers in it. */
const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <p class="tx">He left Munich.<sup><a href="n.xhtml#n1" id="r1">1</a></sup> The rest is prose.</p>
    <p class="tx">Nothing to remove in this one at all.</p>
  </body>
</html>`;

/** The chapter with none, which must come back byte-identical. */
const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><p>Clean prose, start to finish.</p></body>
</html>`;

function buildEpub(dir: string): string {
  const text = (path: string, body: string): ZipEntry => {
    const data = new TextEncoder().encode(body);
    return {
      path,
      data: new Uint8Array(deflateRawSync(data)),
      method: 8,
      crc: crc32(data),
      uncompressedSize: data.length,
    };
  };
  const entries: ZipEntry[] = [
    { path: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
    text('META-INF/container.xml', CONTAINER),
    text('OEBPS/content.opf', OPF),
    text('OEBPS/nav.xhtml', NAV),
    text('OEBPS/ch1.xhtml', CH1),
    text('OEBPS/ch2.xhtml', CH2),
    text('OEBPS/s.css', 'p { margin: 0 }'),
  ];
  const path = join(dir, 'in.epub');
  writeFileSync(path, writeZip(entries));
  return path;
}

/** A model that finds the one marker in the book and nothing else. */
const stubModel = async (prompts: readonly string[]): Promise<string[]> =>
  prompts.map((p) => (p.includes('Munich.1') ? 'Munich.1 → Munich.' : 'none'));

test('an EPUB is edited where the marker is and nowhere else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    const input = buildEpub(dir);
    const before = readFileSync(input);
    const output = join(dir, 'out.epub');

    const report = await runEpubFootnotes({
      epubPath: input, outputPath: output, model: 'stub', generate: stubModel,
    });

    // The input is never written to.
    assert.deepEqual(readFileSync(input), before);

    assert.equal(report.totals.documents, 2, 'the nav document is not a document to read');
    assert.deepEqual(report.skipped.map((s) => s.path), ['OEBPS/nav.xhtml']);
    assert.equal(report.totals.unitsAsked, 3);
    assert.equal(report.totals.unitsFired, 1);
    assert.equal(report.totals.deletionsApplied, 1);
    assert.equal(report.totals.deletionsRejected, 0);
    assert.equal(report.totals.elementsRemoved, 1);
    assert.equal(report.totals.documentsEdited, 1);

    // Every entry the stage did not edit comes back with the SAME compressed
    // bytes — not re-deflated, not re-stored.
    const inEntries = new Map(readZip(new Uint8Array(before)).map((e) => [e.path, e]));
    const outEntries = new Map(readZip(new Uint8Array(readFileSync(output))).map((e) => [e.path, e]));
    assert.deepEqual([...outEntries.keys()], [...inEntries.keys()], 'entry order is the input\'s');
    for (const [path, entry] of inEntries) {
      const after = outEntries.get(path)!;
      if (path === 'OEBPS/ch1.xhtml') {
        assert.notDeepEqual(after.raw, entry.raw);
        continue;
      }
      assert.deepEqual(after.raw, entry.raw, `${path} was rewritten and should not have been`);
      assert.equal(after.method, entry.method);
      assert.equal(after.crc, entry.crc);
    }

    // And the one edited document lost exactly its marker.
    const edited = new TextDecoder().decode(entryBytes(outEntries.get('OEBPS/ch1.xhtml')!));
    assert.equal(edited, CH1.replace('<sup><a href="n.xhtml#n1" id="r1">1</a></sup>', ''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report carries the context a human reviews, and the lost id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    const input = buildEpub(dir);
    const report = await runEpubFootnotes({
      epubPath: input, outputPath: null, model: 'stub', generate: stubModel,
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.applied.length, 1);
    assert.equal(report.applied[0]!.removed, '1');
    assert.match(report.applied[0]!.context, /He left Munich\.\[REMOVED: "1"\] The rest is prose\./);
    assert.deepEqual(report.removedElements[0]!.ids, ['r1']);
    assert.deepEqual(report.documents.map((d) => d.edited), [true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry run writes no EPUB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    const input = buildEpub(dir);
    await runEpubFootnotes({ epubPath: input, outputPath: null, model: 'stub', generate: stubModel });
    assert.equal(existsSync(join(dir, 'out.epub')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing over the input is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    const input = buildEpub(dir);
    await assert.rejects(
      runEpubFootnotes({ epubPath: input, outputPath: input, model: 'stub', generate: stubModel }),
      /never written to/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not a ZIP is named, not guessed at', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    const bogus = join(dir, 'not.epub');
    writeFileSync(bogus, 'this is not an archive');
    await assert.rejects(
      runEpubFootnotes({ epubPath: bogus, outputPath: null, model: 'stub', generate: stubModel }),
      /not a ZIP archive/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zip with no container is not an EPUB, and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    const path = join(dir, 'bare.epub');
    writeFileSync(path, writeZip([{ path: 'a.txt', data: new TextEncoder().encode('hi') }]));
    await assert.rejects(
      runEpubFootnotes({ epubPath: path, outputPath: null, model: 'stub', generate: stubModel }),
      /META-INF\/container\.xml/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a document that is not UTF-8 stops the run, named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-epub-'));
  try {
    // Latin-1 bytes: `Caf<E9>`. Decoded as UTF-8 they become a replacement
    // character, and writing the result back would transcode the whole book.
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Caf'),
      0xE9,
      ...new TextEncoder().encode('.</p></body></html>'),
    ]);
    const entries: ZipEntry[] = [
      { path: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
      { path: 'META-INF/container.xml', data: new TextEncoder().encode(CONTAINER) },
      { path: 'OEBPS/content.opf', data: new TextEncoder().encode(OPF) },
      { path: 'OEBPS/nav.xhtml', data: new TextEncoder().encode(NAV) },
      { path: 'OEBPS/ch1.xhtml', data: latin1 },
      { path: 'OEBPS/ch2.xhtml', data: new TextEncoder().encode(CH2) },
      { path: 'OEBPS/s.css', data: new TextEncoder().encode('p{}') },
    ];
    const path = join(dir, 'latin1.epub');
    writeFileSync(path, writeZip(entries));
    await assert.rejects(
      runEpubFootnotes({ epubPath: path, outputPath: null, model: 'stub', generate: stubModel }),
      /ch1\.xhtml is not valid UTF-8/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
