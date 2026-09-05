/**
 * The bare-EPUB FAILSAFE — Owen, 2026-09-05: it stays, and it is never the
 * standard method.
 *
 * What is pinned here is the ruling and nothing else: the pass rides
 * `translate`'s EPUB route, so **every unedited byte of the container survives**
 * — the file list, the ids, the spine, `dc:identifier`, every `data-bf-*`
 * attribute, the unedited text nodes and the elements around them — and the run
 * writes a **readable stamp**, into the package document and beside the book.
 *
 * The model is a stub that proposes nothing, so what changes is stage 1 and
 * stage 2 alone. That is deliberate: this suite is about the READER and the
 * WRITER, and the three stages have 393 keepers of their own.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cleanTextEpub } from '../../src/clean/epub.js';
import { readNarrationStampFile, type NarrationTextStampMeta } from '../../src/clean/stamp.js';
import type { NumberNormalizerRunner } from '../../src/clean/tts-number-normalizer.js';
import { writeZip, zipText } from '../../src/export/zip.js';
import { readZip } from '../../src/translate/unzip.js';

const OPF_PATH = 'EPUB/package.opf';
const CHAPTER_PATH = 'EPUB/text/c0001.xhtml';

/**
 * A book with one paragraph the number rules WILL rewrite, one they will leave
 * exactly alone, an `<em>` splitting a paragraph into three text nodes, and a
 * stamp already in the package — so the re-stamp path is the one under test.
 */
const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>The Committee</title></head>
<body>
<h1 id="h-1" data-bf-page="1" data-bf-cat="chapter">The Committee</h1>
<p id="p-1" data-bf-page="1" data-bf-cat="text">They paid $5,000 for the <em>press</em> in 1914.</p>
<p id="p-2" data-bf-page="1" data-bf-cat="text">Nothing here needs a narrator's help at all.</p>
</body>
</html>
`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:the-one-that-must-not-move</dc:identifier>
    <dc:title>The Committee</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
    <meta name="bookforge:narration-text" content="{&quot;stampVersion&quot;:2,&quot;normalizerVersion&quot;:&quot;n0&quot;,&quot;punctuationSpec&quot;:&quot;s0&quot;,&quot;model&quot;:&quot;older&quot;,&quot;at&quot;:&quot;2020-01-01T00:00:00Z&quot;,&quot;punctuationRefused&quot;:0}"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="text/c0001.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>
`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>The Committee</title></head>
<body><nav epub:type="toc" id="toc"><ol><li><a href="text/c0001.xhtml">The Committee</a></li></ol></nav></body>
</html>
`;

function book(): Uint8Array {
  return writeZip([
    zipText('mimetype', 'application/epub+zip'),
    zipText('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
      + `  <rootfiles><rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/></rootfiles>\n`
      + '</container>\n'),
    zipText('EPUB/style.css', 'body { margin: 0 5%; }\n'),
    zipText(CHAPTER_PATH, CHAPTER),
    zipText('EPUB/nav.xhtml', NAV),
    zipText(OPF_PATH, OPF),
  ]);
}

/** A model that proposes nothing — every judgement here is the rules'. */
const SILENT: NumberNormalizerRunner = {
  model: 'a stub that proposes no edit',
  async generate(): Promise<string> { return '{"edits": []}'; },
  async release(): Promise<void> { /* nothing was loaded. */ },
};

function membersOf(bytes: Uint8Array): Map<string, string> {
  return new Map(readZip(bytes).map((m) => [m.path, m.text()] as const));
}

describe('clean-text --epub, the failsafe', () => {
  test('every unedited byte survives, and the stamp is readable in both places', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-epub-'));
    const inPath = path.join(dir, 'in.epub');
    const outPath = path.join(dir, 'out.epub');
    fs.writeFileSync(inPath, book());

    const outcome = await cleanTextEpub({
      epubPath: inPath, outPath, runner: SILENT, log: () => {},
    });
    expect(outcome.blocks).toBe(3);

    const before = membersOf(new Uint8Array(fs.readFileSync(inPath)));
    const after = membersOf(new Uint8Array(fs.readFileSync(outPath)));

    // ── The container: the same entries, in the same order, and only two of
    // them touched at all.
    expect([...after.keys()]).toEqual([...before.keys()]);
    const differ = [...after.keys()].filter((p) => after.get(p) !== before.get(p));
    expect(differ.sort()).toEqual([OPF_PATH, CHAPTER_PATH].sort());

    // ── The chapter: the edited text node, and NOTHING else.
    const chapter = after.get(CHAPTER_PATH)!;
    // The money is the number rules'; the bare year is the model's to judge and
    // this stub proposed nothing, so it stands exactly as printed — which is the
    // pass's own rule and is why it is asserted rather than worked around.
    expect(chapter).toContain('They paid five thousand dollars for the <em>press</em> in 1914.');
    // The markup around the edit is the book's own — no re-wrapping, no lost
    // attribute, no moved id.
    expect(chapter).toContain('<p id="p-1" data-bf-page="1" data-bf-cat="text">');
    expect(chapter).toContain('<h1 id="h-1" data-bf-page="1" data-bf-cat="chapter">The Committee</h1>');
    // The paragraph nothing changed is byte-identical, whitespace and all.
    expect(chapter).toContain(
      '<p id="p-2" data-bf-page="1" data-bf-cat="text">Nothing here needs a narrator\'s help at all.</p>');
    // The prolog, the head and the body tags are the file's own.
    expect(chapter.slice(0, chapter.indexOf('<body>'))).toBe(
      CHAPTER.slice(0, CHAPTER.indexOf('<body>')));

    // ── The package document: the stamp, and only the stamp.
    const opf = after.get(OPF_PATH)!;
    expect(opf).toContain('<dc:identifier id="pub-id">urn:uuid:the-one-that-must-not-move</dc:identifier>');
    expect(opf).toContain('<dc:language>en</dc:language>');
    const line = /<meta name="bookforge:narration-text"[^>]*\/>/;
    expect(opf.replace(line, 'STAMP')).toBe(OPF.replace(line, 'STAMP'));
    // Replaced, never joined: one claim about one file.
    expect(opf.match(/bookforge:narration-text/g)).toHaveLength(1);

    // ── The stamp itself, read back through the reader BookForge mirrors.
    const meta = JSON.parse(
      opf.match(/content="([^"]*)"\/>\s*<\/metadata>/)![1]!
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    ) as NarrationTextStampMeta;
    expect(meta.stampVersion).toBe(2);
    expect(meta.blocks).toBe(3);
    expect(typeof meta.textDigest).toBe('string');

    const sidecar = readNarrationStampFile(`${outPath}.stamp.json`);
    expect(sidecar.stampVersion).toBe(2);
    expect(sidecar.textDigest).toBe(meta.textDigest);
    // The sidecar carries the MAP; the package carries the count.
    expect(Object.keys(sidecar.blocks!)).toEqual([
      `${CHAPTER_PATH}#0`, `${CHAPTER_PATH}#1`, `${CHAPTER_PATH}#2`,
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('--out is refused when it is --epub itself', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-epub-'));
    const inPath = path.join(dir, 'in.epub');
    fs.writeFileSync(inPath, book());
    await expect(cleanTextEpub({
      epubPath: inPath, outPath: inPath, runner: SILENT, log: () => {},
    })).rejects.toThrow(/is --epub itself/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
