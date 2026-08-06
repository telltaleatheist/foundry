/**
 * The vlm-convert dialects, and the book they build.
 *
 * What is worth asserting here is what the mode CLAIMS: that page furniture the
 * model tagged is gone, that a footnote marker survives as a marker, that a
 * malformed fragment stops the run instead of reaching a reader, and that the
 * container is an EPUB rather than a zip full of XHTML.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePage, VlmDialectError } from '../../src/vlm/dialect.js';
import { buildVlmEpub } from '../../src/vlm/epub.js';
import { unzipMap } from '../export/unzip.js';
import { checkXml } from '../export/xmlcheck.js';

const META = { title: 'A Book', language: 'en', identifier: 'urn:x:1' };

test('nanonets: tagged furniture is dropped and counted', () => {
  const parsed = parsePage(
    '<page_number>106</page_number>\nThe body of the page.\n\n'
    + '<footer>This content downloaded from\n147.8.204.164\nAll use subject to terms</footer>',
    'nanonets-markdown', 4,
  );
  assert.equal(parsed.dropped, 2);
  assert.deepEqual(parsed.blocks, [{ kind: 'paragraph', xhtml: 'The body of the page.' }]);
});

test('nanonets: the same tags are NOT dropped in a dialect that does not emit them', () => {
  // olmOCR writes no furniture tags, so a `<page_number>` from it would be text
  // the model typed. Dropping it there would be this program guessing.
  const parsed = parsePage('<page_number>106</page_number>', 'markdown', 4);
  assert.equal(parsed.dropped, 0);
  assert.equal(parsed.blocks.length, 1);
});

test('markdown: headings, italics, and a footnote marker as a marker', () => {
  const parsed = parsePage(
    '# INTRODUCTION\n\nHitler\'s *modus operandi*, on 4 September!¹⁴\n',
    'nanonets-markdown', 1,
  );
  assert.deepEqual(parsed.blocks, [
    { kind: 'heading', level: 1, xhtml: 'INTRODUCTION', text: 'INTRODUCTION' },
    {
      kind: 'paragraph',
      xhtml: 'Hitler&apos;s <em>modus operandi</em>, on 4 September!<sup>14</sup>',
    },
  ]);
});

test('markdown: a bullet run is one list, and prose is not', () => {
  const parsed = parsePage('*   Stalin was interventionist.\n*   Hitler was not.\n\nA paragraph.',
    'nanonets-markdown', 2);
  assert.deepEqual(parsed.blocks, [
    { kind: 'list', ordered: false, items: ['Stalin was interventionist.', 'Hitler was not.'] },
    { kind: 'paragraph', xhtml: 'A paragraph.' },
  ]);
});

test('markdown: a table that never closes stops the page', () => {
  assert.throws(
    () => parsePage('<table>\n<tr><td>x</td></tr>\n', 'nanonets-markdown', 7),
    (err: unknown) => err instanceof VlmDialectError && /page 7/.test(err.message),
  );
});

test('markdown: a table whose markup is broken stops the page', () => {
  assert.throws(
    () => parsePage('<table>\n<tr><td>x</tr>\n</table>\n', 'nanonets-markdown', 8),
    (err: unknown) => err instanceof VlmDialectError && /page 8/.test(err.message),
  );
});

test('qwen: bboxes come off and the blocks survive', () => {
  const parsed = parsePage(
    '<h2 data-bbox="10 20 30 40">Chapter One</h2><p data-bbox="1 2 3 4">Text <i>here</i>.</p>',
    'qwen-html', 3,
  );
  assert.deepEqual(parsed.blocks, [
    { kind: 'heading', level: 2, xhtml: 'Chapter One', text: 'Chapter One' },
    { kind: 'paragraph', xhtml: 'Text <em>here</em>.' },
  ]);
});

test('the book splits on the highest heading level the model actually used', () => {
  const pages = [{
    number: 1,
    blocks: parsePage('## One\n\nA.\n\n### Sub\n\nB.\n\n## Two\n\nC.', 'markdown', 1).blocks,
  }];
  const built = buildVlmEpub(META, pages);
  assert.deepEqual(built.chapters.map((c) => c.label), ['One', 'Two']);
});

test('text before the first heading gets a section of its own', () => {
  const pages = [{ number: 1, blocks: parsePage('Front matter.\n\n# One\n\nA.', 'markdown', 1).blocks }];
  const built = buildVlmEpub(META, pages);
  assert.deepEqual(built.chapters.map((c) => c.label), ['Section 1', 'One']);
});

test('the container is an EPUB: mimetype first and stored, and every document parses', () => {
  const pages = [
    { number: 1, blocks: parsePage('# One\n\nA & B <notatag>.', 'markdown', 1).blocks },
    { number: 2, blocks: parsePage('More.', 'markdown', 2).blocks },
  ];
  const built = buildVlmEpub(META, pages);
  const entries = unzipMap(built.bytes);

  const mimetype = entries.get('mimetype')!;
  assert.equal(mimetype.text(), 'application/epub+zip');
  assert.equal(mimetype.method, 0);
  // The OCF spec's reason for the rule: a reader identifies the file at byte 30
  // without parsing the central directory, so the entry has to be the first one.
  assert.equal(mimetype.localOffset, 0);

  for (const [path, entry] of entries) {
    if (!path.endsWith('.xhtml') && !path.endsWith('.opf') && !path.endsWith('.xml')) continue;
    checkXml(entry.text(), path, { xhtml: path.endsWith('.xhtml') });
  }

  const chapter = entries.get('EPUB/text/c0001.xhtml')!.text();
  // The page a paragraph was read from travels with it — the one thing that is
  // otherwise unrecoverable once the pages are joined.
  assert.match(chapter, /data-bf-page="1"/);
  assert.match(chapter, /A &amp; B &lt;notatag&gt;\./);
});
