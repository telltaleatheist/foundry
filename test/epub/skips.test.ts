/**
 * The two populations that must never reach the model — note bodies and index
 * entries.
 *
 * Every fixture here is lifted from a real book, because the whole point is
 * that these shapes exist in books people own:
 *
 *  - **Killing America** (Broadside/HarperCollins) keeps its notes INSIDE the
 *    chapter document, as `<p class="fn">` opening with a same-document
 *    back-link: 320 of them across 14 chapters.
 *  - **Heinrich Himmler** (Longerich, OUP, Calibre-converted) keeps its notes in
 *    their own spine documents, each note a `<p>` in a `<blockquote>` opening
 *    with a back-link into the chapter it came from: 3,526 of them. Its index
 *    is two documents and 3,050 units of `Ahnenerbe (Ancestral Heritage) 260,
 *    266, 271, 275–9`.
 *
 * And the prose fixtures are the false positives the predicates were measured
 * against — a dateline, a copyright line, a printing-history line and a
 * bibliography shelfmark all have the index SHAPE, which is why the shape alone
 * never skips anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { crc32, writeZip, type ZipEntry } from '../../src/export/zip.js';
import {
  isIndexDocument, isIndexShaped, proseUnits, type ProseUnit,
} from '../../src/epub/document.js';
import { runEpubFootnotes } from '../../src/epub/footnotes-stage.js';
import { parseXml } from '../../src/epub/xml.js';

/** Parse a body fragment and hand back its prose units. */
function units(body: string): ProseUnit[] {
  const source = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;
  return proseUnits(parseXml(source), source);
}

function one(body: string): ProseUnit {
  const found = units(body);
  assert.equal(found.length, 1, 'the fixture should be exactly one prose unit');
  return found[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Note bodies — the structural test
// ─────────────────────────────────────────────────────────────────────────────

test('a Killing America note body opens with a same-document back-link', () => {
  const unit = one(
    '<p class="fn"><span class="fn"><a href="#fn_1" id="fn-1">1.</a></span>Thomas Paine, '
    + '<i>Common Sense</i> (London: H.D. Symonds, 1776), Thomas Paine Society; '
    + '<a href="https://www.thomaspainesociety.org/common-sense">https://www.thomaspainesociety.org/common-sense</a>; '
    + 'accessed April 19, 2024.</p>',
  );
  assert.equal(unit.noteBody, true);
  assert.equal(unit.linkOnly, false, 'the note is not one hyperlink — it only starts with one');
});

test('a Himmler note body opens with a back-link into another document', () => {
  const unit = one(
    '<blockquote class="calibre26"><p class="calibre27"><a id="filepos2162783" class="calibre15"></a>'
    + '<a href="CR%21C9A24G218X4VKBR6TB1A6091JAPC_split_009.html#filepos27843" class="calibre28">1</a>'
    + '. Himmler and his companions were apprehended by two freed Soviet POWs.</p></blockquote>',
  );
  assert.equal(unit.noteBody, true, 'the empty <a id> in front contributes no ink and is stepped over');
});

test('a translator\'s note keyed with an asterisk is a note body too', () => {
  const unit = one(
    '<blockquote><p><span><a id="filepos3646001"></a>'
    + '<a href="CR%21C9A24G218X4VKBR6TB1A6091JAPC_split_011.html#filepos59029">*</a> '
    + '<em>Translators’ note</em>: senior academic teacher.</span></p></blockquote>',
  );
  assert.equal(unit.noteBody, true);
});

test('prose carrying a marker at the END is not a note body', () => {
  const unit = one('<p class="tx">He left Munich.<sup><a href="n.xhtml#n1" id="r1">1</a></sup> The rest is prose.</p>');
  assert.equal(unit.noteBody, false, 'this is the unit the model exists to fix');
});

test('a paragraph opening with a link that leaves the book is prose', () => {
  const unit = one(
    '<p><a href="https://example.org/1963">1963</a> was the year the commission reported.</p>',
  );
  assert.equal(unit.noteBody, false, 'an external citation is not a back-link');
});

test('a paragraph opening with a WORD back-link is prose', () => {
  const unit = one('<p><a href="ch02.xhtml">Chapter 2</a> takes up the question of the camps.</p>');
  assert.equal(unit.noteBody, false, 'a cross-reference is not a note\'s own number');
});

test('a paragraph opening with an anchor that has no href is prose', () => {
  const unit = one('<p><a id="filepos99">1</a>2 men were counted that morning.</p>');
  assert.equal(unit.noteBody, false, 'a bookmark target is not a link anywhere');
});

// ─────────────────────────────────────────────────────────────────────────────
// Index entries — the shape test
// ─────────────────────────────────────────────────────────────────────────────

test('the real index shapes, from Himmler’s two index documents', () => {
  for (const line of [
    'Ahnenerbe (Ancestral Heritage) 260, 266, 271, 275–9',
    'Ahrens, Georg Friedrich 158',
    'gypsies 670',
    'alcohol abuse, among SS leaders 321–4',
    'Alvensleben, Ludolf von 325–6, 336, 349, 430–1',
    'Abwehr, relations with Gestapo 189–90',
    'Adenauer, Konrad 698',
    '1924 (Dec) 81, 82',
  ]) {
    assert.equal(isIndexShaped(line), true, line);
  }
});

test('an index sub-head with no page numbers is not index-SHAPED', () => {
  // Harmless either way — it carries no digits for the model to fire on — but
  // the predicate should say what it means.
  for (const line of ['abortion:', 'see also final solution; Jews', 'Bold entries refer to illustrations.']) {
    assert.equal(isIndexShaped(line), false, line);
  }
});

test('the shape rejections, each one a measured false positive', () => {
  assert.equal(isIndexShaped('1 2 3 4 5 6 7 8 / 28 27 26 25 24'), false, 'printing history: no letter in the head');
  assert.equal(isIndexShaped('Casualties: 12, 45, 78'), false, 'a statistic: sentence punctuation in the head');
  assert.equal(isIndexShaped('He was shot in Dallas on 22 November 1963.'), false, 'a sentence ends with a full stop');
  assert.equal(isIndexShaped(' 260, 266, 271'), false, 'a page range with no head is not an entry');
  assert.equal(
    isIndexShaped(
      'The commission sat for eighteen months, took evidence from four hundred witnesses in '
      + 'seven cities, and published the whole of its findings in the autumn of 1964',
    ),
    false,
    'a paragraph is too long to be an entry',
  );
});

test('the shapes the predicate DOES fire on that are not index entries', () => {
  // Documented deliberately: these are why `isIndexShaped` is never acted on
  // without `isIndexDocument`. The first four are real units from the two books
  // — a copyright line, a publication line, a dateline and a bibliography
  // shelfmark — and the last is the general case: any short sentence that ends
  // in a year, with no full stop after it, has this shape.
  for (const line of [
    '© Peter Longerich, 2012',
    'First published 2012',
    'July 2008',
    'Fonds 504',
    'He died in Lüneburg in 1945',
  ]) {
    assert.equal(isIndexShaped(line), true, `${line} — has the shape, is not an entry`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The density gate
// ─────────────────────────────────────────────────────────────────────────────

function indexDoc(count: number, prose: number): ProseUnit[] {
  const body = [
    ...Array.from({ length: count }, (_, i) => `<p>Entry number ${'x'.repeat(i % 5 + 1)} ${100 + i}</p>`),
    ...Array.from({ length: prose }, () => '<p>A paragraph of ordinary prose, with nothing to strip.</p>'),
  ].join('');
  return units(body);
}

test('a document that is mostly index-shaped units IS an index', () => {
  const doc = indexDoc(40, 4);
  assert.equal(doc.filter((u) => u.indexShaped).length, 40);
  assert.equal(isIndexDocument(doc), true);
});

test('a front-matter document with a handful of index-shaped units is NOT an index', () => {
  // Himmler's copyright page: 3 index-shaped units of 19. The highest-scoring
  // non-index document in either book, and it is nowhere near the gate.
  const doc = indexDoc(3, 16);
  assert.equal(isIndexDocument(doc), false, 'too few, and far too small a share');
});

test('a short document that is entirely index-shaped is still not an index', () => {
  const doc = indexDoc(19, 0);
  assert.equal(isIndexDocument(doc), false, 'nineteen entries is a page of statistics, not an index');
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end: the counts, and --ask-everything
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title></metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="idx" href="index.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="idx"/></spine>
</package>`;

/** A chapter with a TOC line, a note body, prose carrying a marker, and prose. */
const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <p class="toc"><a href="ch1.xhtml#s1">3The Façade</a></p>
    <p class="tx">He left Munich.<sup><a href="#fn_1" id="fn-1">1</a></sup> The rest is prose.</p>
    <p class="fn"><span class="fn"><a href="#fn-1" id="fn_1">1.</a></span>Thomas Paine, Common Sense, 1776.</p>
    <p class="tx">Nothing to remove in this one at all.</p>
  </body>
</html>`;

const INDEX = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <p>Bold entries refer to illustrations.</p>
    ${Array.from({ length: 30 }, (_, i) => `<p>Ahnenerbe ${'a'.repeat(i % 4 + 1)} ${200 + i}, ${300 + i}–${310 + i}</p>`).join('\n    ')}
  </body>
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
  const file = join(dir, 'in.epub');
  writeFileSync(file, writeZip([
    { path: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
    text('META-INF/container.xml', CONTAINER),
    text('OEBPS/content.opf', OPF),
    text('OEBPS/ch1.xhtml', CH1),
    text('OEBPS/index.xhtml', INDEX),
  ]));
  return file;
}

/** Records what it was asked, and never fires. */
function recorder(): { asked: string[]; generate: (p: readonly string[]) => Promise<string[]> } {
  const asked: string[] = [];
  return {
    asked,
    generate: async (prompts) => { asked.push(...prompts); return prompts.map(() => 'none'); },
  };
}

test('every skip is counted by reason, per document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-skips-'));
  try {
    const model = recorder();
    const report = await runEpubFootnotes({
      epubPath: buildEpub(dir), outputPath: null, model: 'stub', generate: model.generate,
    });

    assert.equal(report.askEverything, false);
    assert.equal(report.totals.unitsNavigation, 1, 'the TOC line');
    assert.equal(report.totals.unitsNoteBody, 1, 'the <p class="fn"> note body');
    assert.equal(report.totals.unitsIndex, 30, 'the index entries');
    assert.equal(report.totals.unitsIndexShaped, 30);
    assert.equal(report.totals.unitsAsked, 3, 'two chapter paragraphs and the index’s one prose line');

    const [chapter, index] = report.documents;
    assert.equal(chapter!.indexDocument, false);
    assert.equal(chapter!.unitsNoteBody, 1);
    assert.equal(chapter!.unitsIndex, 0);
    assert.equal(chapter!.unitsAsked, 2);
    assert.equal(index!.indexDocument, true);
    assert.equal(index!.unitsIndex, 30);
    assert.equal(index!.unitsAsked, 1);

    // And what actually went to the model contains neither population.
    assert.equal(model.asked.length, 3);
    assert.ok(!model.asked.some((p) => p.includes('Thomas Paine')), 'the note body was never asked about');
    assert.ok(!model.asked.some((p) => p.includes('Ahnenerbe')), 'no index entry was asked about');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--ask-everything puts the note bodies and the index back, and only those', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-skips-'));
  try {
    const model = recorder();
    const report = await runEpubFootnotes({
      epubPath: buildEpub(dir),
      outputPath: null,
      model: 'stub',
      generate: model.generate,
      askEverything: true,
    });

    assert.equal(report.askEverything, true);
    assert.equal(report.totals.unitsNoteBody, 0);
    assert.equal(report.totals.unitsIndex, 0);
    assert.equal(report.documents[1]!.indexDocument, false);
    assert.equal(report.totals.unitsNavigation, 1, 'the navigation skip is structural and stays');
    assert.equal(report.totals.unitsAsked, 34);
    assert.ok(model.asked.some((p) => p.includes('Thomas Paine')));
    assert.ok(model.asked.some((p) => p.includes('Ahnenerbe')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
