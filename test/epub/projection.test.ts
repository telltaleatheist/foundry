/**
 * The projection — text offsets back onto the markup they came from.
 *
 * These are the cases the EPUB mode exists to get right, and every one of them
 * asserts on the SOURCE STRING rather than on a re-serialization, because the
 * promise is about bytes: a document nobody edited comes back identical, and a
 * document that was edited differs only where the marker was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectDeletions, proseUnits, spliceSource } from '../../src/epub/document.js';
import { parseXml } from '../../src/epub/xml.js';

/** Parse, take the one prose unit, apply the deletions, and splice. */
function edit(
  source: string,
  deletions: Array<{ before: string; after: string }>,
  which = 0,
): { out: string; applied: string[]; rejected: string[]; emptied: string[] } {
  const units = proseUnits(parseXml(source), source);
  const unit = units[which]!;
  const projection = projectDeletions(unit, deletions, source);
  return {
    out: spliceSource(source, projection.ranges),
    applied: projection.applied.map((a) => a.removed),
    rejected: projection.rejected.map((r) => r.reason),
    emptied: projection.emptied.map((e) => e.source),
  };
}

const DOC = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title/></head>\n<body>\n${body}\n</body>\n</html>\n`;

// ── the marker is plain text inside one node ────────────────────────────────

test('a marker inside a single text node is cut out of that node', () => {
  const src = DOC('<p>The treaty collapsed.47 Nobody signed it.</p>');
  const { out, applied } = edit(src, [{ before: 'collapsed.47', after: 'collapsed.' }]);
  assert.equal(out, DOC('<p>The treaty collapsed. Nobody signed it.</p>'));
  assert.deepEqual(applied, ['47']);
});

// ── the marker spans a text-node boundary ──────────────────────────────────

test('a deletion that crosses into an inline element cuts both halves', () => {
  // `collapsed.` is in the paragraph's own text node; the marker is in the sup.
  const src = DOC('<p>The treaty collapsed.<sup>47</sup> Nobody signed it.</p>');
  const { out, applied, emptied } = edit(src, [{ before: 'collapsed.47', after: 'collapsed.' }]);
  assert.equal(out, DOC('<p>The treaty collapsed. Nobody signed it.</p>'));
  assert.deepEqual(applied, ['47']);
  assert.deepEqual(emptied, ['<sup>47</sup>']);
});

test('a deletion whose anchor spans two inline elements still lands', () => {
  const src = DOC('<p>The <i>treaty collapsed.</i><sup><a href="#fn47">47</a></sup> Done.</p>');
  const { out, emptied } = edit(src, [{ before: 'collapsed.47', after: 'collapsed.' }]);
  assert.equal(out, DOC('<p>The <i>treaty collapsed.</i> Done.</p>'));
  assert.deepEqual(emptied, ['<sup><a href="#fn47">47</a></sup>']);
});

// ── the marker IS an inline element's whole content ────────────────────────

test('an inline element the deletion empties is removed, outermost only', () => {
  const src = DOC('<p>Munich.<sup class="x"><a href="#fn3" id="r3">3</a></sup></p>');
  const { out, emptied } = edit(src, [{ before: 'Munich.3', after: 'Munich.' }]);
  assert.equal(out, DOC('<p>Munich.</p>'));
  // The <a> is emptied too, but only the outermost span is cut — cutting both
  // would be two overlapping ranges over the same bytes.
  assert.deepEqual(emptied, ['<sup class="x"><a href="#fn3" id="r3">3</a></sup>']);
});

test('an element that keeps a character keeps its markup', () => {
  const src = DOC('<p>Munich.<sup>3a</sup> Next.</p>');
  const { out } = edit(src, [{ before: 'Munich.3', after: 'Munich.' }]);
  assert.equal(out, DOC('<p>Munich.<sup>a</sup> Next.</p>'));
});

test('an element holding an image is never removed as empty', () => {
  const src = DOC('<p>Munich.<span>3<img src="i.png"/></span> Next.</p>');
  const { out, emptied } = edit(src, [{ before: 'Munich.3', after: 'Munich.' }]);
  assert.equal(out, DOC('<p>Munich.<span><img src="i.png"/></span> Next.</p>'));
  assert.deepEqual(emptied, []);
});

// ── repeated anchors in one paragraph ──────────────────────────────────────

test('two identical anchors are consumed in document order, one each', () => {
  const src = DOC(
    '<p>He wrote.<sup>1</sup> Then he wrote.<sup>2</sup> Twice.</p>',
  );
  const { out, applied } = edit(src, [
    { before: 'wrote.1', after: 'wrote.' },
    { before: 'wrote.2', after: 'wrote.' },
  ]);
  assert.equal(out, DOC('<p>He wrote. Then he wrote. Twice.</p>'));
  assert.deepEqual(applied, ['1', '2']);
});

test('a repeated anchor with the SAME marker edits the first, then the second', () => {
  const src = DOC('<p>He wrote.<sup>1</sup> He wrote.<sup>1</sup></p>');
  const { out, applied } = edit(src, [
    { before: 'wrote.1', after: 'wrote.' },
    { before: 'wrote.1', after: 'wrote.' },
  ]);
  assert.equal(out, DOC('<p>He wrote. He wrote.</p>'));
  assert.deepEqual(applied, ['1', '1']);
});

// ── entities ───────────────────────────────────────────────────────────────

test('an entity next to a deletion survives, spelled as it was', () => {
  const src = DOC('<p>Marks &amp; Spencer.<sup>5</sup> Later.</p>');
  const { out } = edit(src, [{ before: 'Spencer.5', after: 'Spencer.' }]);
  assert.equal(out, DOC('<p>Marks &amp; Spencer. Later.</p>'));
});

test('an entity INSIDE the deleted span is removed whole, not by character', () => {
  // The model sees `Munich.†`; the source spells the dagger as an entity.
  const src = DOC('<p>Munich.&dagger; Next.</p>');
  const { out, applied } = edit(src, [{ before: 'Munich.†', after: 'Munich.' }]);
  assert.equal(out, DOC('<p>Munich. Next.</p>'));
  assert.deepEqual(applied, ['†']);
});

test('the model reads the DECODED text, so an entity anchor matches', () => {
  const src = DOC('<p>Marks &amp; Spencer.<sup>5</sup></p>');
  const units = proseUnits(parseXml(src), src);
  assert.equal(units[0]!.text, 'Marks & Spencer.5');
});

// ── refusals ───────────────────────────────────────────────────────────────

test('the applier guards travel with the projection', () => {
  const src = DOC('<p>He aspires.<sup>*</sup> Onward.</p>');
  const { out, rejected } = edit(src, [
    { before: 'aspires.*', after: 'aspirations.' },   // not a deletion
    { before: 'never here.*', after: 'never here.' }, // anchor absent
    { before: 'aspires.*', after: '' },               // empty replacement
  ]);
  assert.equal(out, src, 'a refused edit changes nothing');
  assert.deepEqual(rejected, [
    'the replacement is not the anchor with characters deleted',
    'the anchor does not occur in the text',
    'the replacement is empty',
  ]);
});

test('a deletion that would have to remove a line break is refused', () => {
  const src = DOC('<p>Munich<br/>3 Next.</p>');
  const { out, rejected } = edit(src, [{ before: 'Munich\n3', after: 'Munich' }]);
  assert.equal(out, src);
  assert.deepEqual(rejected, ['the deletion spans a line break, which has no characters to remove']);
});

// ── what is asked about, and what is not ───────────────────────────────────

test('a table-of-contents line is a navigation unit, not prose', () => {
  const src = DOC(
    '<p class="toc"><a href="ch03.xhtml"><span>3</span>The Façade</a></p>'
    + '<p>Body text.<sup><a href="#fn1">1</a></sup></p>',
  );
  const units = proseUnits(parseXml(src), src);
  assert.equal(units.length, 2);
  assert.equal(units[0]!.linkOnly, true);
  assert.equal(units[1]!.linkOnly, false, 'a marker link covers the marker, not the paragraph');
});

test('a blockquote yields its paragraphs once, not twice', () => {
  const src = DOC('<blockquote><p>Quoted.</p></blockquote>');
  const units = proseUnits(parseXml(src), src);
  assert.deepEqual(units.map((u) => u.text), ['Quoted.']);
});

test('headings, list items and table cells are not prose units', () => {
  const src = DOC('<h3>3<br/>Struggle</h3><ul><li>One.</li></ul><table><tr><td><p>Cell.</p></td></tr></table>');
  assert.deepEqual(proseUnits(parseXml(src), src).map((u) => u.text), []);
});

// ── the byte-identity promise ──────────────────────────────────────────────

test('no ranges means the source string itself comes back', () => {
  const src = DOC('<p>Nothing to do here.</p>');
  assert.equal(spliceSource(src, []), src);
});

test('everything outside the edit is byte-identical, quoting and all', () => {
  const marker = '<sup class="calibre35"><a id="k" class="c"></a>'
    + '<a href="x.html#y" class="calibre28">1</a></sup>';
  const src = '<?xml version=\'1.0\' encoding=\'utf-8\'?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n'
    + '  <body class=\'calibre\'>\n'
    + '    <!-- a comment -->\n'
    + `    <p class = "calibre20" >Munich.${marker}</p>\n`
    + '  </body>\n</html>\n';
  const { out, emptied } = edit(src, [{ before: 'Munich.1', after: 'Munich.' }]);
  // Single quotes, the spaces around `=`, the comment and the prolog all
  // survive: nothing was re-serialized, one range was cut.
  assert.equal(out, src.replace(marker, ''));
  // The whole `<sup>` goes, and it takes a bookmark anchor with it — that is
  // reported, because a back-link from the notes now points at nothing.
  assert.deepEqual(emptied.length, 1);
});

test('the ids inside a removed span are reported, not silently dropped', () => {
  const src = DOC('<p>Munich.<sup><a id="back3"/><a href="n.html#n3">3</a></sup></p>');
  const units = proseUnits(parseXml(src), src);
  const projection = projectDeletions(units[0]!, [{ before: 'Munich.3', after: 'Munich.' }], src);
  assert.deepEqual(projection.emptied[0]!.ids, ['back3']);
});

test('a deletion that removes nothing is refused, not counted as an edit', () => {
  // `6.Ibid. → 6.Ibid.` really does come back from the model on a notes list.
  // It passes every applier guard and deletes the empty string, which would
  // inflate "markers removed" with edits that changed nothing.
  const src = DOC('<p>6.Ibid.</p>');
  const { out, applied, rejected } = edit(src, [{ before: '6.Ibid.', after: '6.Ibid.' }]);
  assert.equal(out, src);
  assert.deepEqual(applied, []);
  assert.deepEqual(rejected, ['the deletion removes nothing']);
});
