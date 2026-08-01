/**
 * The contract invariants from BookForgeApp `tools/galley/contract-crosscheck.mjs`,
 * as tests (MIGRATION §2).
 *
 * That tool exists to answer one question: does a gold edit — a TRUE correction,
 * round-trip verified when the corpus was built — survive the applier that will
 * actually run? If it does not, integration silently loses recall and no scorer
 * would show it: the model looks fine and the books do not improve.
 *
 * It measured that against BookForge's `applyEditList` (electron/ai-cleanup-prepass),
 * a DIFFERENT contract with nine semantic guards and word-boundary lookarounds,
 * and found it landed 18.6% of gold edits. Root cause: 72.5% of gold anchors sit
 * MID-WORD, and that matcher requires a word boundary at any alphanumeric edge.
 * That applier is BookForge's AI-cleanup path and is NOT moving to Foundry, so
 * what is preserved here is the half that is about the contract itself:
 *
 *   1. every gold anchor occurs VERBATIM in its block
 *   2. every gold anchor occurs EXACTLY ONCE
 *   3. the applier accepts every gold row whole — zero rejections
 *   4. the applied text is reproducible from the wire format, not just from the
 *      in-memory edit list
 *   5. mid-word anchors are the NORM, not an anomaly — the measurement that
 *      explains the 18.6%, kept so that anyone who ever adds a word-boundary
 *      guard to this applier sees it go red immediately
 *
 * The fixture is 120 real gold rows (60 identity, 60 with edits) sampled at a
 * fixed stride from `/Volumes/Callisto/training/rubric/galley/sft/eval.jsonl`.
 * The whole 9,016-row corpus is run by `tools/crosscheck-ocr.mjs`; this is the
 * part that travels with the repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEdits, formatEdits, parseEdits } from '../../src/ocr/edits.js';

interface GoldRow {
  book: string;
  page: number;
  blockId: string;
  ocr: string;
  target: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const rows: GoldRow[] = fs
  .readFileSync(path.join(here, 'fixtures/gold-rows.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as GoldRow);

const isIdentity = (r: GoldRow): boolean => /^none$/i.test(r.target.trim());

test('the fixture is what it claims to be', () => {
  assert.equal(rows.length, 120);
  assert.equal(rows.filter(isIdentity).length, 60);
  assert.equal(rows.filter((r) => !isIdentity(r)).length, 60);
});

test('gold parses with no unparseable lines', () => {
  let edits = 0;
  for (const r of rows) {
    const p = parseEdits(r.target);
    assert.equal(p.bad, 0, `${r.blockId}: ${p.bad} unparseable gold lines`);
    if (isIdentity(r)) assert.equal(p.edits.length, 0);
    else assert.ok(p.edits.length > 0, `${r.blockId}: an edit row with no edits`);
    edits += p.edits.length;
  }
  assert.ok(edits > 100, `only ${edits} gold edits in the fixture`);
});

test('every gold anchor occurs verbatim, exactly once', () => {
  for (const r of rows) {
    for (const e of parseEdits(r.target).edits) {
      const at = r.ocr.indexOf(e.before);
      assert.notEqual(at, -1, `${r.blockId}: anchor ${JSON.stringify(e.before)} is not in the block`);
      assert.equal(r.ocr.indexOf(e.before, at + 1), -1,
        `${r.blockId}: anchor ${JSON.stringify(e.before)} occurs more than once`);
    }
  }
});

test('the applier accepts every gold row whole', () => {
  for (const r of rows) {
    const applied = applyEdits(r.ocr, parseEdits(r.target).edits);
    assert.equal(applied.rejected.length, 0,
      `${r.blockId}: ${JSON.stringify(applied.rejected)}`);
    assert.equal(applied.ok, true, r.blockId);
    if (isIdentity(r)) assert.equal(applied.text, r.ocr);
    else assert.notEqual(applied.text, r.ocr, `${r.blockId}: an edit row that changed nothing`);
  }
});

test('the applied text survives a round trip through the wire format', () => {
  for (const r of rows) {
    const direct = applyEdits(r.ocr, parseEdits(r.target).edits);
    const wire = applyEdits(r.ocr, parseEdits(formatEdits(parseEdits(r.target).edits)).edits);
    assert.equal(wire.text, direct.text, r.blockId);
    assert.equal(wire.ok, direct.ok, r.blockId);
  }
});

/**
 * The measurement that explained BookForge's 81.4% block rate. A word-boundary
 * guard would reject the MAJORITY of true corrections, because OCR damage is
 * mid-word by nature ("tbe", "rnain", "exeellent"). If this ever drops toward
 * zero, either the corpus changed shape or someone taught the applier to
 * require boundaries — both are worth stopping for.
 */
test('mid-word anchors are the norm, so no word-boundary guard may be added', () => {
  const ALNUM = /[A-Za-zÀ-ÿ0-9]/;
  let total = 0, boundaryKilled = 0;
  for (const r of rows) {
    for (const e of parseEdits(r.target).edits) {
      total++;
      const at = r.ocr.indexOf(e.before);
      const end = at + e.before.length;
      const preBad = ALNUM.test(e.before[0]) && at > 0 && ALNUM.test(r.ocr[at - 1]);
      const postBad = ALNUM.test(e.before[e.before.length - 1]) && end < r.ocr.length && ALNUM.test(r.ocr[end]);
      if (preBad || postBad) boundaryKilled++;
    }
  }
  assert.ok(total > 0);
  assert.ok(boundaryKilled / total > 0.5,
    `only ${boundaryKilled}/${total} gold anchors are mid-word; the corpus has changed shape`);
});
