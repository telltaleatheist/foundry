/**
 * The precedence ladder of §9d decision 2, one test per rung, plus the two
 * properties the ladder exists to guarantee:
 *
 *   - the model NEVER overrules a hard rule, and
 *   - every "I don't know", at any rung, resolves to CONTINUE.
 *
 * The asymmetry is the whole design (§9d decision 3): a missed break is a long
 * prosody run, which the owner accepts; a false break is a full stop in the
 * middle of a sentence, which is the actual damage. So the adversarial cases
 * here are the ones that could manufacture a break.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupParagraphs, GroupingInputError, FLOWING_CATEGORIES } from '../../src/paragraphs/grouping.js';
import type { Block, CalibrationVerdict } from '../../src/pipeline/artifacts.js';
import type { BoxesCategory } from '../../src/boxes/encoder.js';

function verdict(convention: 'indent' | 'block' | 'none'): CalibrationVerdict {
  return {
    convention,
    degraded: convention === 'none',
    bodyHeight: 28, pitch: 40, flushLeft: 200, measure: 800, bodyRight: 1000,
    indent: {
      separation: 1.5, upperShare: 0.17, threshold: 0.75, samples: 240,
      fired: convention === 'indent', why: 'x',
    },
    gap: {
      separation: 0.5, upperShare: 0.17, threshold: 1.25, samples: 240,
      fired: convention === 'block', why: 'x',
    },
    message: convention === 'none' ? 'NO PARAGRAPH CONVENTION DETECTED. …' : 'ok',
  };
}

interface BlockSpec {
  id: string;
  category?: BoxesCategory;
  page?: number;
  indent?: number;
  gapAbove?: number | null;
  prevLineShort?: boolean;
  hyphen?: boolean;
  continues?: { value: boolean; confidence?: number };
}

function block(spec: BlockSpec): Block {
  return {
    id: spec.id,
    page: spec.page ?? 0,
    bbox: [200, 100, 1000, 240],
    lineIds: [`${spec.id}-l1`],
    category: spec.category ?? 'body',
    continues: spec.continues,
    geometry: {
      firstLineIndent: spec.indent ?? 0,
      gapAbove: spec.gapAbove === undefined ? 1.0 : spec.gapAbove,
      prevLineShort: spec.prevLineShort ?? false,
      prevEndsWrapHyphen: spec.hyphen ?? false,
    },
  };
}

const run = (specs: BlockSpec[], convention: 'indent' | 'block' | 'none' = 'indent') =>
  groupParagraphs(specs.map(block), verdict(convention));

// ── rung 1: the hard rules ──────────────────────────────────────────────────

test('a wrap hyphen on the previous block continues, whatever the geometry says', () => {
  // Deeply indented AND gapped — every geometric signal screams "new paragraph"
  // — but the previous block ends mid-word, so the two are one paragraph.
  const { groups, junctions } = run([
    { id: 'a' },
    { id: 'b', hyphen: true, indent: 4.0, gapAbove: 3.0 },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].blockIds, ['a', 'b']);
  assert.equal(junctions[0].decision, 'continue');
  assert.equal(junctions[0].reason, 'hard:wrap-hyphen');
  assert.equal(junctions[0].level, 'hard');
});

test('a wrap hyphen outranks a confident model bit saying break', () => {
  const { groups, junctions } = run([
    { id: 'a' },
    { id: 'b', hyphen: true, continues: { value: false, confidence: 1 } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(junctions[0].reason, 'hard:wrap-hyphen');
});

test('a category transition breaks, whatever the geometry says', () => {
  const { groups, junctions } = run([
    { id: 'a', category: 'body' },
    { id: 'b', category: 'heading', indent: 0, gapAbove: 1.0 },
    { id: 'c', category: 'body', indent: 0, gapAbove: 1.0 },
  ]);
  assert.equal(groups.length, 3);
  assert.equal(junctions[0].reason, 'hard:category-transition');
  assert.equal(junctions[1].reason, 'hard:category-transition');
  assert.ok(junctions.every(j => j.decision === 'break'));
});

test('two adjacent blocks of the same non-flowing category still stand alone', () => {
  const { groups, junctions } = run([
    { id: 'a', category: 'caption' },
    { id: 'b', category: 'caption' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(junctions[0].reason, 'hard:non-flowing-category');
});

test('body and quote are the only categories a paragraph flows through', () => {
  assert.deepEqual([...FLOWING_CATEGORIES].sort(), ['body', 'quote']);
  const { groups } = run([{ id: 'a', category: 'quote' }, { id: 'b', category: 'quote' }]);
  assert.equal(groups.length, 1, 'quote flows into quote');
});

test('a category transition beats a wrap hyphen, and the conflict is counted', () => {
  // The documented tiebreak: a hyphen spanning a category change is a
  // segmentation error, and honouring it would weld a body sentence onto a
  // footnote. Break, but say so.
  const { groups, junctions, report } = run([
    { id: 'a', category: 'body' },
    { id: 'b', category: 'footnote', hyphen: true },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(junctions[0].decision, 'break');
  assert.equal(junctions[0].reason, 'hard:conflict-category-over-hyphen');
  assert.equal(report.conflicts, 1);
});

// ── rung 2: the model's bit ─────────────────────────────────────────────────

test('a confident continues bit decides the junction', () => {
  const yes = run([{ id: 'a' }, { id: 'b', indent: 4.0, continues: { value: true, confidence: 0.9 } }]);
  assert.equal(yes.groups.length, 1, 'a confident true merges despite a break-sized indent');
  assert.equal(yes.junctions[0].reason, 'model:continues');

  const no = run([{ id: 'a' }, { id: 'b', indent: 0, continues: { value: false, confidence: 0.9 } }]);
  assert.equal(no.groups.length, 2, 'a confident false breaks despite flush geometry');
  assert.equal(no.junctions[0].reason, 'model:continues');
  assert.equal(no.junctions[0].level, 'model');
});

test('a bit with no confidence is taken at face value', () => {
  // Its presence IS the assertion; a v6 answer carrying no probability is not
  // thereby a doubtful one.
  const { junctions } = run([{ id: 'a' }, { id: 'b', continues: { value: false } }]);
  assert.equal(junctions[0].reason, 'model:continues');
  assert.equal(junctions[0].decision, 'break');
});

test('a LOW-confidence bit is not used — it falls to geometry', () => {
  const { groups, junctions } = run([
    { id: 'a' },
    { id: 'b', indent: 2.0, continues: { value: true, confidence: 0.2 } },
  ]);
  assert.equal(junctions[0].reason, 'geometry:indent');
  assert.equal(junctions[0].decision, 'break');
  assert.equal(groups.length, 2);
});

test('a low-confidence bit with no geometry to fall back on MERGES, never breaks', () => {
  // §9d decision 3 verbatim: low-confidence continues output means merge. It is
  // implemented as "the bit is not used", so an unsure model can never
  // manufacture a break.
  const { groups, junctions } = run(
    [{ id: 'a' }, { id: 'b', continues: { value: false, confidence: 0.1 } }],
    'none',
  );
  assert.equal(groups.length, 1);
  assert.equal(junctions[0].decision, 'continue');
  assert.equal(junctions[0].reason, 'merge:unsure');
});

test('an absent bit falls to geometry', () => {
  const { junctions } = run([{ id: 'a' }, { id: 'b', indent: 2.0 }]);
  assert.equal(junctions[0].reason, 'geometry:indent');
});

// ── rung 3: geometry, per convention ────────────────────────────────────────

test('indent convention: a first line past the book threshold breaks', () => {
  const { groups, junctions } = run([{ id: 'a' }, { id: 'b', indent: 1.5 }, { id: 'c', indent: 0.0 }]);
  assert.equal(junctions[0].decision, 'break');
  assert.equal(junctions[1].decision, 'continue');
  assert.ok(junctions.every(j => j.reason === 'geometry:indent'));
  assert.deepEqual(groups.map(g => g.blockIds), [['a'], ['b', 'c']]);
});

test('indent convention: the dead zone merges rather than guessing', () => {
  // Threshold 0.75, continue band <= 0.375. An indent of 0.5 is neither.
  const { groups, junctions } = run([{ id: 'a' }, { id: 'b', indent: 0.5 }]);
  assert.equal(junctions[0].reason, 'merge:unsure');
  assert.equal(junctions[0].decision, 'continue');
  assert.equal(groups.length, 1);
});

test('indent convention survives a page break — an indent is horizontal', () => {
  const { groups } = run([
    { id: 'a', page: 0 },
    { id: 'b', page: 1, gapAbove: null, indent: 1.5 },
    { id: 'c', page: 1, gapAbove: 1.0, indent: 0 },
  ]);
  assert.deepEqual(groups.map(g => g.blockIds), [['a'], ['b', 'c']]);
});

test('block convention: an advance past the book threshold breaks', () => {
  const { groups, junctions } = run(
    [{ id: 'a' }, { id: 'b', gapAbove: 1.5 }, { id: 'c', gapAbove: 1.0 }], 'block',
  );
  assert.equal(junctions[0].decision, 'break');
  assert.equal(junctions[1].decision, 'continue');
  assert.ok(junctions.every(j => j.reason === 'geometry:gap'));
  assert.deepEqual(groups.map(g => g.blockIds), [['a'], ['b', 'c']]);
});

test('block convention: the dead zone merges', () => {
  // Threshold 1.25, continue band < 1.125. An advance of 1.2 is neither.
  const { junctions } = run([{ id: 'a' }, { id: 'b', gapAbove: 1.2 }], 'block');
  assert.equal(junctions[0].reason, 'merge:unsure');
  assert.equal(junctions[0].decision, 'continue');
});

test('block convention across a page break: a full last line continues', () => {
  const { groups, junctions } = run(
    [{ id: 'a', page: 0 }, { id: 'b', page: 1, gapAbove: null, prevLineShort: false }], 'block',
  );
  assert.equal(junctions[0].reason, 'geometry:prev-line-full');
  assert.equal(junctions[0].decision, 'continue');
  assert.equal(groups.length, 1);
});

test('block convention across a page break: a short last line is unsure, so it merges', () => {
  // The page may have ended where the paragraph did, or merely on a short line.
  // There is no way to tell, and the tie goes to merging.
  const { groups, junctions } = run(
    [{ id: 'a', page: 0 }, { id: 'b', page: 1, gapAbove: null, prevLineShort: true }], 'block',
  );
  assert.equal(junctions[0].reason, 'merge:unsure');
  assert.equal(junctions[0].decision, 'continue');
  assert.equal(groups.length, 1);
});

// ── rung 4: the degradation ─────────────────────────────────────────────────

test('the none convention merges every flowing junction and reports it loudly', () => {
  const { groups, junctions, report } = run([
    { id: 'a' }, { id: 'b', indent: 4.0 }, { id: 'c', gapAbove: 3.0 }, { id: 'd', prevLineShort: true },
  ], 'none');

  assert.equal(groups.length, 1, 'every flowing junction merged');
  assert.deepEqual(groups[0].blockIds, ['a', 'b', 'c', 'd']);
  assert.ok(junctions.every(j => j.reason === 'merge:unsure' && j.decision === 'continue'));

  assert.equal(report.degraded, true);
  assert.equal(report.convention, 'none');
  assert.equal(report.breaks, 0);
  assert.equal(report.byLevel.merge, 3);
  assert.match(report.message, /DEGRADED PARAGRAPH ASSEMBLY/);
  assert.match(report.message, /NO DETECTABLE PARAGRAPH CONVENTION/);
  assert.match(report.message, /THE RUN DID NOT FAIL/);
  assert.match(report.message, /merged rather than guessed/);
});

test('a degraded book still breaks on the hard rules', () => {
  const { groups, report } = run([
    { id: 'a', category: 'chapter' },
    { id: 'b', category: 'body' },
    { id: 'c', category: 'body' },
    { id: 'd', category: 'footnote' },
  ], 'none');
  assert.deepEqual(groups.map(g => g.blockIds), [['a'], ['b', 'c'], ['d']]);
  assert.equal(report.breaks, 2);
  assert.equal(report.degraded, true);
});

// ── the report ──────────────────────────────────────────────────────────────

test('the report accounts for every junction, by level and by reason', () => {
  const { report, junctions } = run([
    { id: 'a' },
    { id: 'b', hyphen: true },                                  // hard
    { id: 'c', category: 'heading' },                           // hard
    { id: 'd', category: 'body', indent: 1.5 },                 // hard (transition)
    { id: 'e', continues: { value: true, confidence: 0.9 } },   // model
    { id: 'f', indent: 1.5 },                                   // geometry
    { id: 'g', indent: 0.5 },                                   // merge
  ]);
  assert.equal(report.junctions, 6);
  assert.equal(junctions.length, 6);
  assert.equal(report.byLevel.hard + report.byLevel.model + report.byLevel.geometry + report.byLevel.merge, 6);
  assert.equal(report.breaks + report.continues, 6);
  assert.equal(Object.values(report.byReason).reduce((a, b) => a + b, 0), 6);
  assert.equal(report.blocks, 7);
  assert.equal(report.groups, groupsOf(report));
  assert.equal(report.byLevel.model, 1);
  assert.equal(report.byLevel.merge, 1);
  // Only body/quote-to-body/quote junctions could ever have merged.
  assert.equal(report.flowingJunctions, 4);
  assert.match(report.message, /Paragraphs assembled under the indent convention/);
});

/** groups == breaks + 1, always: a break starts a group and block 0 starts one. */
function groupsOf(r: { breaks: number }): number {
  return r.breaks + 1;
}

test('group ids are stable and ordered', () => {
  const { groups } = run([{ id: 'a' }, { id: 'b', indent: 1.5 }, { id: 'c', indent: 1.5 }]);
  assert.deepEqual(groups.map(g => g.id), ['p0001', 'p0002', 'p0003']);
});

test('a group carries the page it opens on', () => {
  const { groups } = run([
    { id: 'a', page: 3 },
    { id: 'b', page: 4, gapAbove: null, indent: 1.5 },
  ]);
  assert.deepEqual(groups.map(g => g.page), [3, 4]);
});

test('an empty book groups into nothing rather than throwing', () => {
  const { groups, report } = groupParagraphs([], verdict('indent'));
  assert.deepEqual(groups, []);
  assert.equal(report.groups, 0);
  assert.equal(report.junctions, 0);
});

// ── bad input ───────────────────────────────────────────────────────────────

test('blocks out of reading order throw, naming both blocks and pages', () => {
  assert.throws(() => run([{ id: 'a', page: 5 }, { id: 'b', page: 2 }]), (e: unknown) => {
    assert.ok(e instanceof GroupingInputError);
    assert.match(e.message, /block b is on page 2, after block a on page 5/);
    return true;
  });
});
