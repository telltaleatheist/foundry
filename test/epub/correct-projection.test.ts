/**
 * The correction projection, on its own.
 *
 * `correct-mode.test.ts` drives the whole stage; this drives the one function
 * that decides whether an ACCEPTED correction may be written into somebody's
 * markup. Each case here is a way the text view and the byte view differ — an
 * entity standing for one character in five bytes, a `<br/>` standing for a
 * character with no bytes at all, a CDATA payload where escaping is inverted —
 * and each one is a way to corrupt a book silently if it is guessed at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractUnit } from '../../src/epub/document.js';
import {
  correctableUnits, escapeXmlText, projectCorrections, spliceReplacements,
} from '../../src/epub/correct-document.js';
import { parseXml, type XmlElement } from '../../src/epub/xml.js';

/** The document's one `<p>`, with its char-by-char map back to the source. */
function unitOf(source: string): ReturnType<typeof extractUnit> {
  const root = parseXml(source);
  let found: XmlElement | null = null;
  for (const el of (function* walk(n: XmlElement): Generator<XmlElement> {
    yield n;
    for (const c of n.children) if (c.kind === 'element') yield* walk(c);
  })(root)) {
    if (el.tag === 'p') { found = el; break; }
  }
  assert.ok(found, 'the fixture has no <p>');
  return extractUnit(found, source);
}

/** Correct `before` → `after` in the unit, and return the spliced source. */
function correct(source: string, before: string, after: string): {
  text: string;
  applied: number;
  reasons: string[];
} {
  const unit = unitOf(source);
  const at = unit.text.indexOf(before);
  assert.ok(at >= 0, `the fixture's text does not contain "${before}": ${unit.text}`);
  const projection = projectCorrections(unit, [{ edit: { before, after }, at }], source);
  return {
    text: spliceReplacements(source, projection.replacements),
    applied: projection.applied.length,
    reasons: projection.rejected.map(r => r.reason),
  };
}

test('an anchor covering a whole entity replaces the whole entity', () => {
  // `&amp;` is five source characters standing for one decoded one. Replacing
  // three of them would leave `&am` in somebody's book.
  const src = '<p>R&amp;D tbe future</p>';
  const r = correct(src, 'R&D', 'R&D,');
  assert.equal(r.applied, 1);
  assert.equal(r.text, '<p>R&amp;D, tbe future</p>');
});

test('a replacement is escaped for a text node, and only where it must be', () => {
  assert.equal(escapeXmlText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  // Quotes are only special inside attributes; escaping them here would put
  // `&quot;` into prose whose every other quotation mark is literal.
  assert.equal(escapeXmlText(`he said "no" and 'yes'`), `he said "no" and 'yes'`);
  const r = correct('<p>Smith Jones</p>', 'Smith Jones', 'Smith & Jones');
  assert.equal(r.text, '<p>Smith &amp; Jones</p>');
});

test('an anchor that straddles a tag is refused, and the markup is untouched', () => {
  const src = '<p>The r<em>n</em>ain point</p>';
  const r = correct(src, 'rn', 'm');
  assert.equal(r.applied, 0);
  assert.deepEqual(r.reasons, ['the anchor crosses a markup boundary, and correction never rewrites markup']);
  assert.equal(r.text, src, 'nothing was written');
});

test('an anchor that spans a <br/> is refused — it has no bytes to replace', () => {
  const src = '<p>one<br/>two</p>';
  const r = correct(src, 'one\ntwo', 'one two');
  assert.equal(r.applied, 0);
  assert.deepEqual(r.reasons, ['the anchor spans a line break, which has no source characters to replace']);
  assert.equal(r.text, src);
});

test('an anchor inside a CDATA section is refused — escaping is inverted there', () => {
  const src = '<p><![CDATA[tbe raw & text]]></p>';
  const r = correct(src, 'tbe', 'the');
  assert.equal(r.applied, 0);
  assert.deepEqual(r.reasons, ['the anchor is inside a CDATA section, which this stage does not write into']);
  assert.equal(r.text, src);
});

test('an anchor that splits an astral entity is refused', () => {
  // `&#x1F600;` decodes to ONE character made of TWO UTF-16 units, both mapped
  // to the whole entity. An anchor covering one of them would replace bytes it
  // only half describes.
  const src = '<p>a&#x1F600;b</p>';
  const unit = unitOf(src);
  assert.equal(unit.text.length, 4, 'the emoji is a surrogate pair in the decoded text');
  const projection = projectCorrections(
    unit, [{ edit: { before: unit.text.slice(0, 2), after: 'x' }, at: 0 }], src,
  );
  assert.deepEqual(
    projection.rejected.map(r => r.reason),
    ['the anchor begins or ends inside an entity reference'],
  );
});

test('several corrections in one unit are written back-to-front, all of them', () => {
  const src = '<p>tbe first and tbf second</p>';
  const unit = unitOf(src);
  const projection = projectCorrections(unit, [
    { edit: { before: 'tbe', after: 'the' }, at: unit.text.indexOf('tbe') },
    { edit: { before: 'tbf', after: 'the' }, at: unit.text.indexOf('tbf') },
  ], src);
  assert.equal(projection.applied.length, 2);
  assert.equal(spliceReplacements(src, projection.replacements), '<p>the first and the second</p>');
});

test('two corrections claiming the same bytes are an error, not a race', () => {
  assert.throws(
    () => spliceReplacements('<p>abcdef</p>', [
      { start: 3, end: 6, text: 'X' },
      { start: 5, end: 8, text: 'Y' },
    ]),
    /claim the same bytes/,
  );
});

test('an anchor at an offset the text does not have is refused, never guessed', () => {
  const unit = unitOf('<p>the point</p>');
  const projection = projectCorrections(unit, [{ edit: { before: 'the', after: 'a' }, at: 4 }], '<p>the point</p>');
  assert.deepEqual(
    projection.rejected.map(r => r.reason),
    ['the anchor does not occur in the unit at the offset it was derived at'],
  );
});

test('correctable units are the leaf-most block elements, tables included', () => {
  const src = '<body><div><p>one</p><h3>two</h3></div>'
    + '<table><tr><td>three</td></tr></table><ul><li>four</li></ul></body>';
  const units = correctableUnits(parseXml(src), src);
  assert.deepEqual(units.map(u => u.text), ['one', 'two', 'three', 'four']);
  // The `<div>` holds paragraphs, so it is not itself a unit — its text would
  // otherwise be asked about twice.
  assert.equal(units.some(u => u.element.tag === 'div'), false);
});
