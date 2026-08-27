/**
 * The markdown dialect's inline pass, pinned at the one place it broke a book.
 *
 * `inlineMarkdown` is private, so everything here goes through `parsePage` the
 * way a reading does. The defect these tests hold shut: `***bold italic***`
 * with no rule of its own was shredded by the `**` and `*` passes into
 * `<strong><em>…</strong></em>` — crossed tags, not well-formed XML — so the
 * exported EPUB's spine document refused to parse and Foundry's own reader
 * could not open the export it had just written (the witches book, 2026-08-26).
 * Every emitted fragment is therefore also checked as XML, because "the tags
 * looked right" is exactly the assertion that failed in the field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePage } from '../../src/vlm/dialect.js';
import { parseXml } from '../../src/epub/xml.js';

function paragraphOf(text: string): string {
  const { blocks } = parsePage(text, 'markdown', 1);
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.kind, 'paragraph');
  return (block as { kind: 'paragraph'; xhtml: string }).xhtml;
}

/** The field assertion: whatever the pass emits must parse as XML. */
function wellFormed(xhtml: string): void {
  assert.doesNotThrow(() => parseXml(`<p>${xhtml}</p>`, 'xhtml'));
}

test('*** becomes <strong><em>…</em></strong>, not crossed tags', () => {
  const xhtml = paragraphOf('***bold italic***');
  assert.equal(xhtml, '<strong><em>bold italic</em></strong>');
  wellFormed(xhtml);
});

test('the witches line: *** followed by prose survives whole', () => {
  const xhtml = paragraphOf('***The Cosby Show***—Have you ever noticed');
  assert.equal(xhtml, '<strong><em>The Cosby Show</em></strong>—Have you ever noticed');
  wellFormed(xhtml);
});

test('em inside strong still nests: **a *b* c**', () => {
  const xhtml = paragraphOf('**a *b* c**');
  assert.equal(xhtml, '<strong>a <em>b</em> c</strong>');
  wellFormed(xhtml);
});

test('an unbalanced star cannot pair across an emitted tag', () => {
  // One stray star before a strong, one after: the old capture crossed the
  // </strong> between them. The stars must come out literal, the strong whole.
  const xhtml = paragraphOf('a *stray **bold** more* prose');
  wellFormed(xhtml);
  assert.ok(xhtml.includes('<strong>bold</strong>'));
  assert.ok(!/<em>[^<]*<\/strong>/.test(xhtml));
});

test('plain emphasis is untouched by the tightening', () => {
  assert.equal(paragraphOf('*em* and **strong** and _under_'), '<em>em</em> and <strong>strong</strong> and <em>under</em>');
});
