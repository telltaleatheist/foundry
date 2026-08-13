/**
 * The marker scheme: markup out, markup back, and every way an answer can be
 * wrong about it.
 *
 * The round-trip test is the important one. Its assertion is that masking a
 * block and restoring the masked text UNCHANGED gives back the original inner
 * XHTML byte for byte — which is the property the whole design rests on, since
 * it is what proves no attribute is ever retyped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkMarkers, maskBlock, MarkerError, restoreMarkers, stripMarkers,
} from '../../src/translate/markers.js';

const NOTEREF = '<a class="noteref" epub:type="noteref" role="doc-noteref" href="#fn12"><sup>12</sup></a>';
const PAGEBREAK = '<span epub:type="pagebreak" role="doc-pagebreak" id="pb-7" data-bf-page="7" aria-label="7"></span>';

test('a block with emphasis and a noteref round-trips byte for byte', () => {
  const inner = `${PAGEBREAK}Ein <em>voelkischer</em> Staat war das Ziel${NOTEREF} der Bewegung.`;
  const masked = maskBlock(inner);

  // The pagebreak leads the block, so it is PEELED — the model never sees it
  // and never has to be trusted with it. The noteref is interior; its position
  // depends on the sentence, so it travels.
  assert.equal(masked.text, 'Ein ⟦e1⟧voelkischer⟦/e1⟧ Staat war das Ziel⟦m2⟧ der Bewegung.');
  assert.equal(masked.leading, PAGEBREAK);
  assert.equal(masked.trailing, '');
  assert.equal(masked.leading + restoreMarkers(masked, masked.text) + masked.trailing, inner);
});

test('edge atomics peel with their whitespace, and the model owes nothing for them', () => {
  // The failure this exists for: "Kirchenwahlen 1932" — a two-word heading
  // whose only marker was its leading pagebreak — refused three attempts
  // running because qwen3:32b kept dropping the token. A heading that is
  // mostly token sheds the part that is not words; so the part that is not
  // words no longer travels.
  const inner = `${PAGEBREAK}Kirchenwahlen 1932`;
  const masked = maskBlock(inner);
  assert.equal(masked.text, 'Kirchenwahlen 1932');
  assert.deepEqual(masked.markers, []);
  assert.equal(masked.leading + restoreMarkers(masked, 'Church Elections 1932') + masked.trailing,
    `${PAGEBREAK}Church Elections 1932`);

  // Trailing, with a space that belongs to the edge: byte-for-byte back.
  const tail = maskBlock(`Am Ende. <br/>`);
  assert.equal(tail.text, 'Am Ende.');
  assert.equal(tail.trailing, ' <br/>');
  assert.equal(tail.leading + restoreMarkers(tail, tail.text) + tail.trailing, 'Am Ende. <br/>');
});

test('a block that is nothing but markup keeps everything on its edges', () => {
  // A heading that is only its pagebreak span: no words, no markers left, and
  // the edges reassemble to the source exactly. `run.ts` skips the model for
  // this shape — there is nothing to ask it.
  const masked = maskBlock(`${PAGEBREAK}<br/>`);
  assert.equal(masked.text, '');
  assert.deepEqual(masked.markers, []);
  assert.equal(masked.leading + masked.text + masked.trailing, `${PAGEBREAK}<br/>`);
});

test('an atomic element inside a paired one nests, and still round-trips', () => {
  const inner = `Ein <em>Wort mit ${NOTEREF} darin</em> und mehr.`;
  const masked = maskBlock(inner);

  assert.equal(masked.text, 'Ein ⟦e1⟧Wort mit ⟦m1⟧ darin⟦/e1⟧ und mehr.');
  assert.equal(checkMarkers(masked, masked.text), null);
  assert.equal(restoreMarkers(masked, masked.text), inner);
});

test('nested emphasis numbers by document order and restores by identity', () => {
  const inner = '<strong>Sehr <em>sehr</em> wichtig</strong>';
  const masked = maskBlock(inner);
  assert.equal(masked.text, '⟦e1⟧Sehr ⟦e2⟧sehr⟦/e2⟧ wichtig⟦/e1⟧');
  assert.equal(restoreMarkers(masked, masked.text), inner);
});

test('entities are decoded for the model and re-escaped on the way back', () => {
  const masked = maskBlock('Krieg &amp; Frieden, 5 &lt; 6');
  assert.equal(masked.text, 'Krieg & Frieden, 5 < 6');
  assert.equal(restoreMarkers(masked, masked.text), 'Krieg &amp; Frieden, 5 &lt; 6');
});

test('a translation may move its markers — order is not the contract', () => {
  const inner = `Das Ziel${NOTEREF} war ein <em>Staat</em>.`;
  const masked = maskBlock(inner);
  // English puts the emphasised word first and the note at the end.
  const answer = 'A ⟦e1⟧state⟦/e1⟧ was the goal⟦m1⟧.';
  assert.equal(checkMarkers(masked, answer), null);
  assert.equal(restoreMarkers(masked, answer), `A <em>state</em> was the goal${NOTEREF}.`);
});

test('an element with no rule refuses the block and names the tag', () => {
  assert.throws(
    () => maskBlock('Ein <marquee>Wort</marquee>.'),
    (error: Error) => error instanceof MarkerError && error.message.includes('<marquee>'),
  );
});

test('a dropped marker is caught and counted', () => {
  const masked = maskBlock(`Ziel${NOTEREF} war <em>gut</em>.`);
  const complaint = checkMarkers(masked, 'Goal was ⟦e1⟧good⟦/e1⟧.');
  assert.ok(complaint !== null);
  assert.match(complaint, /dropped 1 of 2 marker\(s\)/);
  assert.match(complaint, /⟦m1⟧/);
});

test('a repeated marker is caught', () => {
  const masked = maskBlock(`Ziel${NOTEREF}.`);
  const complaint = checkMarkers(masked, 'Goal⟦m1⟧ and again⟦m1⟧.');
  assert.ok(complaint !== null);
  assert.match(complaint, /repeated/);
});

test('an invented marker is caught before anything is called missing', () => {
  const masked = maskBlock('Ein <em>Wort</em>.');
  const complaint = checkMarkers(masked, 'A ⟦e1⟧word⟦/e1⟧⟦e9⟧.');
  assert.ok(complaint !== null);
  assert.match(complaint, /never sent/);
  assert.match(complaint, /⟦e9⟧/);
});

test('crossed pairs are caught', () => {
  const masked = maskBlock('<strong>Sehr <em>sehr</em> gut</strong>');
  const complaint = checkMarkers(masked, '⟦e1⟧Very ⟦e2⟧very⟦/e1⟧ good⟦/e2⟧');
  assert.ok(complaint !== null);
  assert.match(complaint, /cross/);
});

test('an unclosed pair is caught', () => {
  const masked = maskBlock('Ein <em>Wort</em>.');
  const complaint = checkMarkers(masked, 'A ⟦e1⟧word.');
  assert.ok(complaint !== null);
  assert.match(complaint, /never closed/);
});

test('closing an atomic marker is caught', () => {
  const masked = maskBlock(`Ziel${NOTEREF}.`);
  const complaint = checkMarkers(masked, 'Goal⟦m1⟧⟦/m1⟧.');
  assert.ok(complaint !== null);
  assert.match(complaint, /has no pair/);
});

test('a clean answer complains about nothing', () => {
  const masked = maskBlock(`Ein <em>Wort</em>${NOTEREF}.`);
  assert.equal(checkMarkers(masked, 'A ⟦e1⟧word⟦/e1⟧⟦m1⟧.'), null);
});

test('markup the model writes into its answer is escaped, not honoured', () => {
  const masked = maskBlock('Ein Wort.');
  assert.equal(restoreMarkers(masked, 'A <b>word</b> & more'), 'A &lt;b&gt;word&lt;/b&gt; &amp; more');
});

test('stripMarkers leaves the words and collapses the space they stood in', () => {
  assert.equal(stripMarkers('⟦m1⟧Ein  ⟦e1⟧Wort⟦/e1⟧ hier'), 'Ein Wort hier');
});

test('a comment inside a block is preserved and never shown to the model', () => {
  const masked = maskBlock('Ein <!-- Anmerkung --> Wort.');
  assert.equal(masked.text, 'Ein ⟦m1⟧ Wort.');
  assert.equal(restoreMarkers(masked, masked.text), 'Ein <!-- Anmerkung --> Wort.');
});
