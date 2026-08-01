/**
 * The metric logic from BookForgeApp `tools/dagger-score.js`, as tests over small
 * hand-built cases (MIGRATION §3).
 *
 * DO NOT JUDGE THIS MODEL BY LOSS. Its output is a deletion list and a
 * deterministic applier does the editing, so the numbers that matter are:
 *
 *   deletion P/R/F1  — did it find the markers, and only the markers
 *   FALSE-FIRE RATE  — of the blocks with NO markers, how many did it edit
 *                      anyway. This is the one that would damage a book, and a
 *                      model that never fires scores a perfect 0 here while
 *                      being useless, so read it beside recall, never alone.
 *   applier-reject   — emitted anchors the applier would refuse because they do
 *                      not occur in the input. Harmless to the text (that is the
 *                      point of the contract) but it is the model failing to
 *                      copy, and it silently costs recall.
 *
 * THE SHORTCUT RISK, from that file's header, is what most of these cases are
 * built to expose: the corpus's positives are dominated by one book, so a model
 * can score well by learning "delete trailing junk after the final period"
 * rather than "find the reference marker". The lookalike negatives are the
 * discriminator — watch false-fire, not F1, when deciding whether the shortcut
 * was learned. The `shortcut` model below scores recall 1.00 and a respectable
 * F1 while editing every clean block it is shown; the assertions say so, and
 * say which pair of numbers is needed to tell it from a correct model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFootnoteDeletions, isDeletionOnly, parseFootnotesAnswer,
  type FootnoteDeletion,
} from '../../src/footnotes/applier.js';

/** One scored example: the source text, the gold answer, the model's answer. */
interface Row { src: string; gold: string; pred: string; }

interface Report {
  deletions: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  exactMatch: number;
  applied: { match: number; unchanged: number; wrong: number };
  negatives: { n: number; falseFire: number; falseFireRate: number };
  positives: { n: number; silent: number; silentRate: number };
  format: { emitted: number; applierRejects: number; rewriteAttempts: number };
}

const key = (d: FootnoteDeletion): string => `${d.before} ${d.after}`;

/**
 * The scorer, ported from `dagger-score.js` and pointed at the real applier
 * rather than at a private copy of it — which is the point of the move: the
 * number quoted for a model is produced by the code that will edit the book.
 *
 * `rewriteAttempts` is counted here with `isDeletionOnly` because the applier
 * reports one rejection count for all three of its refusals, and a rewrite
 * attempt is the one worth naming separately: it is the model trying to alter
 * the text and being stopped by construction.
 */
function score(rows: readonly Row[]): Report {
  let tp = 0, fp = 0, fn = 0, exact = 0;
  let appliedMatch = 0, appliedUnchanged = 0, appliedWrong = 0;
  let goldNone = 0, falseFire = 0, goldPos = 0, silentOnPos = 0;
  let emitted = 0, applierRejects = 0, rewriteAttempts = 0;

  for (const { src, gold, pred } of rows) {
    const g = parseFootnotesAnswer(gold);
    const p = parseFootnotesAnswer(pred);

    const goldSet = new Set(g.map(key));
    const predSet = new Set(p.map(key));
    if (goldSet.size === predSet.size && [...goldSet].every((k) => predSet.has(k))) exact++;

    // THE metric. Pair equality punishes a model for choosing a different but
    // equally valid anchor span — "war effort.! -> war effort." and
    // "effort.! -> effort." delete the same marker and leave identical text,
    // yet set-equality scores that as one miss AND one spurious edit. What
    // ships is the text, so compare the text after the applier has run.
    const goldText = applyFootnoteDeletions(src, g).text;
    const predText = applyFootnoteDeletions(src, p).text;
    if (goldText === predText) appliedMatch++;
    else if (predText === src) appliedUnchanged++;
    else appliedWrong++;

    for (const d of p) {
      emitted++;
      if (!isDeletionOnly(d.before, d.after) || !d.after) rewriteAttempts++;
      else if (!src.includes(d.before)) applierRejects++;
      if (goldSet.has(key(d))) tp++; else fp++;
    }
    for (const d of g) if (!predSet.has(key(d))) fn++;

    if (g.length === 0) { goldNone++; if (p.length) falseFire++; }
    else { goldPos++; if (p.length === 0) silentOnPos++; }
  }

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    deletions: { tp, fp, fn, precision, recall, f1 },
    exactMatch: rows.length ? exact / rows.length : 0,
    applied: { match: appliedMatch, unchanged: appliedUnchanged, wrong: appliedWrong },
    negatives: { n: goldNone, falseFire, falseFireRate: goldNone ? falseFire / goldNone : 0 },
    positives: { n: goldPos, silent: silentOnPos, silentRate: goldPos ? silentOnPos / goldPos : 0 },
    format: { emitted, applierRejects, rewriteAttempts },
  };
}

// Three blocks that DO carry markers, all of the "trailing junk after the final
// period" shape that dominates the corpus …
const POSITIVES: Array<[string, string]> = [
  ['The treaty was signed in Berlin.*', 'Berlin.* → Berlin.'],
  ['He never returned to the village.†', 'village.† → village.'],
  ['That was the end of the matter.”', 'matter.” → matter.'],
];
// … and two LOOKALIKE NEGATIVES: clean prose that ends in exactly the kind of
// character a shortcut would strip. These are the discriminator.
const NEGATIVES: Array<[string, string]> = [
  ['And then, incredibly, he laughed!', 'none'],
  ['She said only: "we shall see."', 'none'],
];

const CORPUS: Array<[string, string]> = [...POSITIVES, ...NEGATIVES];

test('a model that never fires scores a PERFECT false-fire rate and is useless', () => {
  const r = score(CORPUS.map(([src, gold]) => ({ src, gold, pred: 'none' })));
  assert.equal(r.negatives.falseFireRate, 0);      // perfect on the damaging metric
  assert.equal(r.deletions.recall, 0);             // …because it found nothing
  assert.equal(r.positives.silentRate, 1);
  assert.equal(r.applied.match, 2);                // only the two clean blocks
  assert.equal(r.applied.unchanged, 3);
  assert.equal(r.applied.wrong, 0);
});

/**
 * The shortcut: "strip the last character off the last word". It never looks at
 * whether that character is a reference marker, and on a corpus whose positives
 * all end in one it is indistinguishable from the real task.
 */
const shortcut = (src: string): string => {
  const lastWord = src.split(/\s+/).pop()!;
  return `${lastWord} → ${lastWord.slice(0, -1)}`;
};

test('the shortcut model finds every marker and edits every clean block too', () => {
  const r = score(CORPUS.map(([src, gold]) => ({ src, gold, pred: shortcut(src) })));

  // On the positives it is flawless, and recall is the metric a model is
  // usually defended with.
  assert.equal(r.deletions.recall, 1);
  assert.equal(r.positives.silent, 0);
  assert.equal(r.deletions.tp, 3);

  // And it damages every clean block it is shown.
  assert.equal(r.negatives.n, 2);
  assert.equal(r.negatives.falseFire, 2);
  assert.equal(r.negatives.falseFireRate, 1);
  assert.equal(r.applied.wrong, 2);                // two books quietly altered

  // F1 stays respectable while that happens, which is the whole trap.
  assert.equal(r.deletions.f1 > 0.7, true);
});

test('neither F1 nor false-fire alone separates the three models; together they do', () => {
  const silent = score(CORPUS.map(([src, gold]) => ({ src, gold, pred: 'none' })));
  const short = score(CORPUS.map(([src, gold]) => ({ src, gold, pred: shortcut(src) })));
  const right = score(CORPUS.map(([src, gold]) => ({ src, gold, pred: gold })));

  // Read false-fire alone and the useless model wins.
  assert.equal(silent.negatives.falseFireRate, 0);
  assert.equal(right.negatives.falseFireRate, 0);
  assert.equal(short.negatives.falseFireRate, 1);

  // Read recall alone and the dangerous model ties with the correct one.
  assert.equal(short.deletions.recall, 1);
  assert.equal(right.deletions.recall, 1);
  assert.equal(silent.deletions.recall, 0);

  // Only one model has both, and only one leaves every block agreeing with gold.
  assert.equal(right.applied.match, CORPUS.length);
  assert.equal(silent.applied.match < CORPUS.length, true);
  assert.equal(short.applied.match < CORPUS.length, true);
});

test('a correct model: F1 1.00, false-fire 0, every block byte-identical to gold', () => {
  const r = score(CORPUS.map(([src, gold]) => ({ src, gold, pred: gold })));
  assert.equal(r.deletions.f1, 1);
  assert.equal(r.negatives.falseFireRate, 0);
  assert.equal(r.positives.silentRate, 0);
  assert.equal(r.exactMatch, 1);
  assert.equal(r.applied.match, CORPUS.length);
  assert.equal(r.applied.wrong, 0);
  assert.equal(r.format.applierRejects, 0);
  assert.equal(r.format.rewriteAttempts, 0);
});

test('an equally valid anchor span scores 0 on pairs and 1 on applied text', () => {
  const src = 'It was decisive for the war effort.!';
  const r = score([{
    src,
    gold: 'war effort.! → war effort.',
    pred: 'effort.! → effort.',
  }]);
  assert.equal(r.deletions.tp, 0);
  assert.equal(r.deletions.fp, 1);
  assert.equal(r.deletions.fn, 1);
  assert.equal(r.deletions.f1, 0);              // pair equality says: total failure
  assert.equal(r.applied.match, 1);             // the text says: identical to gold
  assert.equal(r.exactMatch, 0);
});

test('an anchor the model could not copy is an applier reject, not damage', () => {
  const src = 'The treaty was signed in Berlin.*';
  const r = score([{ src, gold: 'Berlin.* → Berlin.', pred: 'Berlyn.* → Berlyn.' }]);
  assert.equal(r.format.emitted, 1);
  assert.equal(r.format.applierRejects, 1);
  assert.equal(r.format.rewriteAttempts, 0);
  assert.equal(r.applied.unchanged, 1);         // the marker survives
  assert.equal(r.applied.wrong, 0);             // the prose does not change
  assert.equal(r.deletions.recall, 0);          // and it cost recall, silently
});

test('a rewrite attempt is counted, blocked, and never reaches the text', () => {
  const src = 'His aspires.* were plain.';
  const r = score([{ src, gold: 'aspires.* → aspires.', pred: 'aspires.* → aspirations.' }]);
  assert.equal(r.format.rewriteAttempts, 1);
  assert.equal(r.format.applierRejects, 0);     // the anchor WAS there — that is the trap
  assert.equal(r.applied.unchanged, 1);
  assert.equal(r.applied.wrong, 0);
  assert.equal(applyFootnoteDeletions(src, parseFootnotesAnswer('aspires.* → aspirations.')).text, src);
});

test('an unparseable answer is silence, not a guess', () => {
  const src = 'The treaty was signed in Berlin.*';
  const r = score([{ src, gold: 'Berlin.* → Berlin.', pred: 'I think the marker is the asterisk' }]);
  assert.equal(r.format.emitted, 0);
  assert.equal(r.positives.silent, 1);
  assert.equal(r.applied.unchanged, 1);
});
