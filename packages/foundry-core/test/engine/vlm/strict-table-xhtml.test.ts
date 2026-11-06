/**
 * A table's markup enters the book as strict XHTML, and the export's check is
 * strict (2026-11-06, Owen ruling on the lead's recommendation).
 *
 * The vision model writes HTML for a table — bare `<br>`, `&nbsp;`, a raw `&`,
 * valueless and unquoted attributes, `<TD>` closed by `</td>` — and the export
 * check used a lenient parser, so books went out that a reading system's XML
 * parser stops on. The first test plants every one of those faults in one
 * table and builds the book: it fails on main at the strict parse of the
 * exported document. The second hands the package a document broken by hand
 * and expects the refusal, which on main was a pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkTableHtml, type DotsBlock } from '../../../src/engine/vlm/dots.js';
import { buildDotsBook } from '../../../src/engine/vlm/dots-book.js';
import { packageVlmEpub, XHTML_HEAD, XHTML_TAIL } from '../../../src/engine/vlm/epub.js';
import { parseXml } from '../../../src/engine/epub/xml.js';
import { strictXhtmlFragment } from '../../../src/engine/epub/strict-xhtml.js';
import { unzipMap } from '../export/unzip.js';

/** Every fault the exporter used to write, in one grid. */
const PLANTED = '<TABLE border=1 class="grid"><TR><TD nowrap width=50>Smith &amp; Sons&nbsp;Ltd'
  + '<br>est. 1902 &copy; R&D</TD><td>caf&eacute; &#233; &#x153; &oelig;uvre &zzz; a < b</td></TR>'
  + '<tr><th colspan=\'2\'>&hellip;<BR/>end<hr></th></tr></TABLE>';

function block(overrides: Partial<DotsBlock>): DotsBlock {
  return {
    page: 1, order: 0, part: 0, category: 'Text',
    box: { x1: 200, y1: 300, x2: 1100, y2: 700 }, text: 'body', pageWidth: 1300, pageHeight: 2112,
    ...overrides,
  };
}

test('every fault the exporter wrote is respelled, and nothing else changes', () => {
  assert.equal(strictXhtmlFragment(PLANTED),
    '<table border="1" class="grid"><tr><td nowrap="nowrap" width="50">Smith &amp; Sons Ltd'
    + '<br/>est. 1902 © R&amp;D</td><td>café é œ œuvre &amp;zzz; a &lt; b</td></tr>'
    + '<tr><th colspan="2">…<br/>end<hr/></th></tr></table>');
  // And it is the spelling checkTableHtml hands every route that enters the book.
  assert.equal(checkTableHtml(PLANTED, 3), strictXhtmlFragment(PLANTED));
  parseXml(`<x>${strictXhtmlFragment(PLANTED)}</x>`, 'strict');
});

test('an attribute value is decoded once, through the full list, then escaped', () => {
  // The parser decodes values itself, through its short list only — so the raw
  // value is what is decoded here: `&amp;` once (never `&amp;amp;`), `&nbsp;`
  // and `&oelig;` to their characters, an unknown name kept visible.
  assert.equal(
    strictXhtmlFragment('<td title="R&amp;D" abbr="a&nbsp;b" axis=\'&oelig;uvre &zzz; "q"\'>x</td>'),
    '<td title="R&amp;D" abbr="a b" axis="œuvre &amp;zzz; &quot;q&quot;">x</td>',
  );
});

test('a surrogate half, by reference or as a character, is dropped like a C0 control', () => {
  assert.equal(strictXhtmlFragment('<td>a&#xD800;b&#55296;c\uDC00d&#1;e\u0001f</td>'), '<td>abcdef</td>');
  // A real pair is one character, and stays.
  assert.equal(strictXhtmlFragment('<td>\u{1F600}&#x1F600;</td>'), '<td>\u{1F600}\u{1F600}</td>');
  assert.equal(strictXhtmlFragment('<td title="a&#xDFFF;b">x</td>'), '<td title="ab">x</td>');
});

test('void elements written bare, in any case, close themselves in lower case', () => {
  assert.equal(strictXhtmlFragment('<TD>a<BR>b<Hr>c<IMG src=x>d</td>'), '<td>a<br/>b<hr/>c<img src="x"/>d</td>');
  parseXml(`<x>${strictXhtmlFragment('<TD>a<BR>b<Hr>c<IMG src=x>d</td>')}</x>`, 'strict');
});

test('a structure that does not close is still refused at the page, never guessed', () => {
  assert.throws(() => checkTableHtml('<table><tr><td>x</tr></table>', 7), /page 7|not well-formed/);
});

test('a table planted with every fault exports as well-formed XML', async () => {
  const built = await buildDotsBook({
    metadata: { title: 'Tables', language: 'en', identifier: 'urn:x:tables' },
    pages: [{
      page: 1,
      furniture: [],
      rawExtent: { x: 1100, y: 700 },
      blocks: [
        block({ category: 'Title', text: 'CHAPTER ONE', box: { x1: 450, y1: 200, x2: 860, y2: 260 } }),
        block({ category: 'Table', text: PLANTED }),
      ],
    }],
    images: { crop: async () => [] },
    stripNoteMarkers: false,
  });
  const documents = [...unzipMap(built.bytes)].filter(([path]) => path.endsWith('.xhtml'));
  assert.ok(documents.length > 0);
  for (const [path, entry] of documents) {
    const text = entry.text();
    assert.doesNotThrow(() => parseXml(text, 'strict'), `${path} is not strict XML`);
    if (path.startsWith('EPUB/text/')) assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE html>\n/);
  }
  const chapter = documents.find(([path]) => path === 'EPUB/text/c0001.xhtml')![1].text();
  assert.match(chapter, /<td nowrap="nowrap" width="50">Smith &amp; Sons Ltd<br\/>/);
});

test('the export refuses a document broken by hand, naming it', () => {
  for (const broken of ['<p>one<br>two</p>', '<p>a&nbsp;b</p>', '<p>R&D</p>', '<td nowrap>x</td>', '<P>x</p>']) {
    assert.throws(
      () => packageVlmEpub(
        { title: 'Broken', language: 'en', identifier: 'urn:x:broken' },
        [{ id: 'c1', href: 'text/c0001.xhtml', label: 'One', xhtml: `${XHTML_HEAD('One', 'en')}${broken}${XHTML_TAIL}` }],
        [],
        '',
      ),
      /"text\/c0001\.xhtml" is not well-formed XHTML/,
      broken,
    );
  }
});
