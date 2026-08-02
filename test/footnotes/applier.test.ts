/**
 * The footnotes applier — the safety boundary (MIGRATION §3, ARCHITECTURE §7).
 *
 * Every assertion here is about what the applier REFUSES. The model is allowed
 * to fail to remove a marker; it is not allowed to alter the text, and each
 * adversarial case asserts the text came back untouched rather than asserting
 * that an error was raised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFootnoteDeletions, isDeletionOnly, parseFootnotesAnswer, planFootnotes,
  splitForFootnotes,
} from '../../src/footnotes/applier.js';
import { FOOTNOTES_STOP, FOOTNOTES_SYSTEM_PROMPT } from '../../src/footnotes/prompt.js';
import { BLOCKS_STOP, toRawPrompt } from '../../src/blocks/encoder.js';

// ── the subsequence guard ───────────────────────────────────────────────────

test('isDeletionOnly accepts a marker removal', () => {
  assert.equal(isDeletionOnly('Germany.*', 'Germany.'), true);
  assert.equal(isDeletionOnly('wrote.”', 'wrote.'), true);
  assert.equal(isDeletionOnly('treaty 3 was', 'treaty  was'), true);
  assert.equal(isDeletionOnly('anything', 'anything'), true);
  assert.equal(isDeletionOnly('anything', ''), true);
});

/**
 * The hole the model found on its first held-out run: an anchor that really does
 * occur in the source, paired with a replacement that is not the anchor minus a
 * marker but a DIFFERENT WORD.
 */
test('isDeletionOnly refuses `aspires.<marker>` -> `aspirations.`', () => {
  assert.equal(isDeletionOnly('aspires.*', 'aspirations.'), false);
});

test('isDeletionOnly refuses any inserted or reordered character', () => {
  assert.equal(isDeletionOnly('the cat', 'the cats'), false);   // insertion
  assert.equal(isDeletionOnly('the cat', 'cat the'), false);    // reorder
  assert.equal(isDeletionOnly('colour', 'color'), true);        // deletion only
  assert.equal(isDeletionOnly('color', 'colour'), false);       // the reverse is not
});

// ── the parser ──────────────────────────────────────────────────────────────

test('`none` and empty answers parse to no deletions', () => {
  assert.deepEqual(parseFootnotesAnswer('none'), []);
  assert.deepEqual(parseFootnotesAnswer('NONE'), []);
  assert.deepEqual(parseFootnotesAnswer('  '), []);
  assert.deepEqual(parseFootnotesAnswer(''), []);
});

test('both arrow forms parse, and unparseable lines are dropped not guessed', () => {
  const out = parseFootnotesAnswer('Germany.* → Germany.\nno arrow at all\nwrote.” -> wrote.\nnone');
  assert.deepEqual(out, [
    { before: 'Germany.*', after: 'Germany.' },
    { before: 'wrote.”', after: 'wrote.' },
  ]);
});

test('a line with an empty left side is dropped', () => {
  assert.deepEqual(parseFootnotesAnswer(' → something'), []);
});

// ── the applier ─────────────────────────────────────────────────────────────

const SRC = 'He wrote.* Then he wrote.* again, in Germany.†';

test('deletions land on the first remaining occurrence, in document order', () => {
  const r = applyFootnoteDeletions(SRC, [
    { before: 'wrote.*', after: 'wrote.' },
    { before: 'wrote.*', after: 'wrote.' },
    { before: 'Germany.†', after: 'Germany.' },
  ]);
  assert.equal(r.text, 'He wrote. Then he wrote. again, in Germany.');
  assert.deepEqual(r.removed, ['*', '*', '†']);
  assert.equal(r.rejected, 0);
});

test('an anchor that is not in the text is refused, and the text is untouched', () => {
  const r = applyFootnoteDeletions(SRC, [{ before: 'painted.*', after: 'painted.' }]);
  assert.equal(r.text, SRC);
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.removed, []);
});

test('a rewrite is refused even though its anchor occurs', () => {
  const src = 'His aspires.* were plain.';
  const r = applyFootnoteDeletions(src, [{ before: 'aspires.*', after: 'aspirations.' }]);
  assert.equal(r.text, src);
  assert.equal(r.rejected, 1);
});

test('an empty `after` is refused — it is a malformed line, not a delete instruction', () => {
  const r = applyFootnoteDeletions(SRC, [{ before: 'wrote.*', after: '' }]);
  assert.equal(r.text, SRC);
  assert.equal(r.rejected, 1);
});

test('one good deletion survives a bad sibling', () => {
  const r = applyFootnoteDeletions(SRC, [
    { before: 'nowhere.*', after: 'nowhere.' },
    { before: 'Germany.†', after: 'Germany.' },
  ]);
  assert.equal(r.text, 'He wrote.* Then he wrote.* again, in Germany.');
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.removed, ['†']);
});

test('an empty deletion list is a no-op', () => {
  const r = applyFootnoteDeletions(SRC, []);
  assert.equal(r.text, SRC);
  assert.equal(r.rejected, 0);
});

// ── unit splitting ──────────────────────────────────────────────────────────

test('paragraphs are the unit, and blank lines separate them', () => {
  assert.deepEqual(splitForFootnotes('one.*\n\ntwo.†\n\n\n  three  '), ['one.*', 'two.†', 'three']);
});

test('a paragraph past the ceiling wraps at whitespace, never mid-token', () => {
  const word = 'Germany.* ';
  const para = word.repeat(400).trim();          // ~4000 chars
  const units = splitForFootnotes(para);
  assert.ok(units.length > 1);
  for (const u of units) {
    assert.ok(u.length <= 1600, `unit of ${u.length} chars`);
    assert.equal(u.trim(), u);
  }
  // Nothing is lost or invented: the units rejoin to the paragraph.
  assert.equal(units.join(' '), para);
});

test('a run with no whitespace is still cut, so the loop makes progress', () => {
  const units = splitForFootnotes('x'.repeat(4000));
  assert.deepEqual(units.map((u) => u.length), [1600, 1600, 800]);
});

// ── the planning loop and its seams ──────────────────────────────────────────

test('the prompt is the trained-against string in the trained-against template', async () => {
  const prompts: string[][] = [];
  await planFootnotes(['Germany.*'], async (batch) => {
    prompts.push([...batch]);
    return batch.map(() => 'Germany.* → Germany.');
  });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0], toRawPrompt({ system: FOOTNOTES_SYSTEM_PROMPT, user: 'Germany.*' }));
  assert.ok(prompts[0][0].includes('<think>\n\n</think>'), 'the empty think block is missing');
  assert.equal(FOOTNOTES_STOP, BLOCKS_STOP);
});

test('identical texts are asked about once and share one plan entry', async () => {
  let asked = 0;
  const plan = await planFootnotes(['Germany.*', 'Germany.*', 'clean prose'], async (batch) => {
    asked += batch.length;
    return batch.map((p) => (p.includes('Germany.*') ? 'Germany.* → Germany.' : 'none'));
  });
  assert.equal(asked, 2, 'the duplicate text was sent twice');
  assert.equal(plan.size, 1);
  assert.deepEqual(plan.get('Germany.*'), [{ before: 'Germany.*', after: 'Germany.' }]);
  assert.equal(plan.has('clean prose'), false, 'a text with no deletions must be absent');
});

test('a multi-unit text collects its units in document order', async () => {
  const text = 'first.*\n\nsecond.†';
  const plan = await planFootnotes([text], async (batch) =>
    batch.map((p) => (p.includes('first.*') ? 'first.* → first.' : 'second.† → second.')));
  assert.deepEqual(plan.get(text), [
    { before: 'first.*', after: 'first.' },
    { before: 'second.†', after: 'second.' },
  ]);
});

test('a generator that returns the wrong number of answers throws — no fallback', async () => {
  await assert.rejects(
    () => planFootnotes(['a.*', 'b.*'], async () => ['only one']),
    /returned 1 answers for 2 prompts/);
  await assert.rejects(
    () => planFootnotes(['a.*'], async () => [undefined as unknown as string]),
    /returned no answer/);
});

test('an aborted signal throws rather than finishing quietly', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => planFootnotes(['a.*'], async (b) => b.map(() => 'none'), { signal: controller.signal }),
    /Job cancelled/);
});

test('no texts means no round trips at all', async () => {
  let called = false;
  const plan = await planFootnotes([], async (b) => { called = true; return b.map(() => 'none'); });
  assert.equal(called, false);
  assert.equal(plan.size, 0);
});
