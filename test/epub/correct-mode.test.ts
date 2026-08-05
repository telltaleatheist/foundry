/**
 * `foundry ocr-correct --epub` end to end, against a synthetic book.
 *
 * The model is a stub — what is under test is everything AROUND it: the spine
 * walk, the sentence cut, the projection back onto markup, the report, and the
 * two promises about bytes. The promise that matters most here is the one that
 * separates correction from every other pass: **the words change and the markup
 * does not**, which is only a promise if the cases where it CANNOT be kept are
 * refused by name rather than approximated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { crc32, writeZip, type ZipEntry } from '../../src/export/zip.js';
import { runEpubCorrection } from '../../src/epub/correct-stage.js';
import { entryBytes, readZip } from '../../src/epub/zip-read.js';
import { OCR_STOP } from '../../src/ocr/prompt.js';

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

/**
 * The chapter with damage in it. Every element here is deliberate:
 *
 *  - a `<p>` with a plain misreading, and foundry's own v0.5.0 provenance stamps
 *  - an `<h2>` — headings are asked about, unlike in footnote removal
 *  - a `<td>` — table cells are asked about too
 *  - a `<p>` whose damage sits WHOLLY inside an `<em>`: correctable, and the
 *    emphasis survives because only the text node is spliced
 *  - a `<p>` whose damage STRADDLES the `<em>` boundary: not correctable
 *    without deciding what happens to the emphasis, so it is refused by name
 *  - a table-of-contents line, whose whole text is one link: never asked
 */
const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h2 data-bf-category="heading" data-bf-group="g3" data-bf-blocks="p0002b001">Tbe Reichstag</h2>
    <p data-bf-category="body" data-bf-group="g4" data-bf-blocks="p0002b002">He left Munich in tbe spring. The rest is prose.</p>
    <p><a href="ch2.xhtml">3The Fa&#231;ade</a></p>
    <p>A word inside <em>rnarkup</em> here.</p>
    <p>The r<em>n</em>ain point stands.</p>
    <table><tr><td>Rnunich</td></tr></table>
  </body>
</html>`;

/** The chapter with nothing wrong, which must come back byte-identical. */
const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><p>Clean prose, start to finish.</p></body>
</html>`;

function buildBook(dir: string): string {
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

/**
 * The line the model was asked about, pulled back out of the prompt.
 *
 * The prompt is built by `toOcrRawPrompt` and sent verbatim — the stub reads it
 * rather than being handed the text, so a change that stopped sending the
 * sentence would fail here rather than pass quietly.
 */
function askedLine(prompt: string): string {
  const open = '<|im_start|>user\n';
  const from = prompt.indexOf(open) + open.length;
  return prompt.slice(from, prompt.indexOf('<|im_end|>', from));
}

/** Repairs the four rn/b misreadings planted above; everything else comes back unchanged. */
const stubModel = async (request: { prompt: string }): Promise<string> => {
  const line = askedLine(request.prompt);
  return line
    .replace(/\btbe\b/g, 'the')
    .replace(/\bTbe\b/g, 'The')
    .replace(/rnarkup/g, 'markup')
    .replace(/rnain/g, 'main')
    .replace(/Rnunich/g, 'Munich');
};

async function correct(dir: string, outputPath: string | null): ReturnType<typeof runEpubCorrection> {
  return runEpubCorrection({
    epubPath: buildBook(dir),
    outputPath,
    model: 'stub',
    generate: stubModel,
  });
}

test('the words change and every other byte survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-correct-'));
  try {
    const input = buildBook(dir);
    const before = readFileSync(input);
    const output = join(dir, 'out.epub');
    const report = await runEpubCorrection({
      epubPath: input, outputPath: output, model: 'stub', generate: stubModel,
    });

    assert.deepEqual(new Uint8Array(readFileSync(input)), new Uint8Array(before),
      'the source book was written to');

    const entries = new Map(readZip(new Uint8Array(readFileSync(output))).map(e => [e.path, e]));
    const ch1 = new TextDecoder().decode(entryBytes(entries.get('OEBPS/ch1.xhtml')!));

    // The corrections landed, in the markup they came from.
    assert.match(ch1, /<h2 data-bf-category="heading" data-bf-group="g3" data-bf-blocks="p0002b001">The Reichstag<\/h2>/);
    assert.match(ch1, /He left Munich in the spring\./);
    assert.match(ch1, /<td>Munich<\/td>/, 'a table cell is corrected too');

    // The provenance stamps are untouched — they are the book's own record, and
    // correction changes words, never structure.
    assert.match(ch1, /data-bf-blocks="p0002b002"/);
    // The entity in the navigation line is untouched, because navigation is
    // never asked about.
    assert.match(ch1, /3The Fa&#231;ade/);

    // A document nobody corrected keeps its exact bytes.
    const ch2Before = readZip(new Uint8Array(before)).find(e => e.path === 'OEBPS/ch2.xhtml')!;
    assert.deepEqual(entries.get('OEBPS/ch2.xhtml')!.raw, ch2Before.raw);
    assert.equal(entries.get('OEBPS/ch2.xhtml')!.crc, ch2Before.crc);

    // `mimetype` stays first and stored — an EPUB is identified by byte 30.
    assert.equal(readZip(new Uint8Array(readFileSync(output)))[0]!.path, 'mimetype');

    assert.equal(report.totals.editsApplied >= 4, true, `only ${report.totals.editsApplied} applied`);
    assert.equal(report.totals.documentsEdited, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a correction straddling a tag is REFUSED by name, and the rest still land', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-correct-'));
  try {
    const report = await correct(dir, join(dir, 'out.epub'));
    const crossing = report.rejected.filter(r => /crosses a markup boundary/.test(r.reason));
    assert.equal(crossing.length, 1, JSON.stringify(report.rejected, null, 2));
    // The refusal carries the model's own edit, verbatim — that is the thing a
    // reviewer reads.
    assert.equal(crossing[0]!.answer, 'rn → m');
    assert.equal(report.totals.editsRejected, 1);

    const entries = new Map(
      readZip(new Uint8Array(readFileSync(join(dir, 'out.epub')))).map(e => [e.path, e]),
    );
    const ch1 = new TextDecoder().decode(entryBytes(entries.get('OEBPS/ch1.xhtml')!));
    assert.match(ch1, /The r<em>n<\/em>ain point stands\./,
      'the markup was rewritten to make the fix fit');
    // The same misreading WHOLLY inside an inline element is repaired, and the
    // element comes through: only the text node was spliced.
    assert.match(ch1, /A word inside <em>markup<\/em> here\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report names where every correction landed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-correct-'));
  try {
    const report = await correct(dir, null);
    // The anchors are the edit contract's — minimal and unique in their unit, so
    // `Tbe → The` derives as `b → h`. The CONTEXT is what makes a row readable,
    // and it is what a reviewer is given.
    const heading = report.applied.find(a => a.blocks === 'p0002b001');
    assert.ok(heading, JSON.stringify(report.applied, null, 2));
    assert.equal(heading.document, 'OEBPS/ch1.xhtml');
    assert.equal(heading.category, 'heading', 'the book says what it called this block');
    assert.equal(heading.context, 'T[was "b" now "h"]e Reichstag');
    // A publisher's EPUB carries no stamps, and an absent one is reported as
    // absent rather than invented.
    const cell = report.applied.find(a => a.context === '[was "Rn" now "M"]unich');
    assert.equal(cell?.blocks, '');
    assert.equal(cell?.category, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry run writes no book and still writes the whole report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-correct-'));
  try {
    const report = await correct(dir, null);
    assert.equal(existsSync(join(dir, 'out.epub')), false);
    assert.equal(report.dryRun, true);
    assert.equal(report.output, null);
    assert.ok(report.applied.length > 0);
    assert.ok(report.caveat.includes('publisher'), 'the caveat is in the report, not only the log');
    assert.equal(report.unitMaxChars, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the input is never the output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-correct-'));
  try {
    const input = buildBook(dir);
    await assert.rejects(
      () => runEpubCorrection({
        epubPath: input, outputPath: input, model: 'stub', generate: stubModel,
      }),
      /never written to/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt and the stop token are the ocr stage\'s, unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-correct-'));
  const seen: Array<{ prompt: string; stop: string[]; nPredict: number }> = [];
  try {
    await runEpubCorrection({
      epubPath: buildBook(dir),
      outputPath: null,
      model: 'stub',
      generate: async (request) => { seen.push(request); return stubModel(request); },
    });
    assert.ok(seen.length > 0);
    for (const request of seen) {
      assert.deepEqual(request.stop, [OCR_STOP]);
      // The generation budget is derived from the input, so it scales with the
      // unit rather than being a constant somebody has to remember to raise.
      assert.equal(request.nPredict, askedLine(request.prompt).length + 64);
      assert.equal(request.prompt.includes('<think>\n\n</think>'), true);
      assert.equal(askedLine(request.prompt).includes('\n'), false, 'a prompt spanned a line break');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
