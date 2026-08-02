/**
 * The four §9d facts, and the two units that are easy to get wrong: indent is
 * in BODY-SIZE units and gapAbove is an ADVANCE ratio in PITCH units, top of
 * line to top of line, not an ink gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeBlockGeometry, GeometryInputError } from '../../src/paragraphs/geometry.js';
import type { CalibrationVerdict, ScanLine } from '../../src/pipeline/artifacts.js';

const CAL: CalibrationVerdict = {
  convention: 'indent', degraded: false,
  bodyHeight: 28, pitch: 40, flushLeft: 200, measure: 800, bodyRight: 1000,
  indent: { separation: 1.5, upperShare: 0.17, threshold: 0.75, samples: 100, fired: true, why: 'x' },
  gap: { separation: 0, upperShare: 0, threshold: 1, samples: 100, fired: false, why: 'x' },
  message: 'ok',
};

function line(id: string, page: number, x0: number, y0: number, x1: number, text: string): ScanLine {
  return { id, page, bbox: [x0, y0, x1, y0 + 28], text, conf: 90 };
}

test('the four facts are measured in the calibrated frame', () => {
  const lines = [
    line('l1', 0, 200, 100, 1000, 'the first line of the'),
    line('l2', 0, 200, 140, 640, 'paragraph ends short.'),
    line('l3', 0, 242, 180, 1000, 'A new paragraph opens.'),
  ];
  const g = computeBlockGeometry(
    [{ id: 'b1', page: 0, lineIds: ['l1', 'l2'] }, { id: 'b2', page: 0, lineIds: ['l3'] }],
    lines, CAL,
  );

  const first = g.get('b1')!;
  assert.equal(first.firstLineIndent, 0);
  assert.equal(first.gapAbove, null, 'the first block of the book has nothing above it');
  assert.equal(first.prevLineShort, false);
  assert.equal(first.prevEndsWrapHyphen, false);

  const second = g.get('b2')!;
  // 42px of indent over a 28px body height.
  assert.ok(Math.abs(second.firstLineIndent - 1.5) < 1e-9, `${second.firstLineIndent}`);
  // Top-to-top advance of 40px over a 40px pitch.
  assert.equal(second.gapAbove, 1);
  // The previous line stopped 360px short of a 1000px right edge: ~12.9 body
  // heights, far past the 2.0 that counts as short.
  assert.equal(second.prevLineShort, true);
});

test('gapAbove is an advance ratio, not an ink gap', () => {
  // Two lines 60px apart, top to top, on a 40px pitch: 1.5, the blank-line gap.
  // An ink-gap measure would report (60-28)/40 = 0.8 and never clear a
  // threshold expressed in pitch units.
  const lines = [line('l1', 0, 200, 100, 1000, 'one'), line('l2', 0, 200, 160, 1000, 'two')];
  const g = computeBlockGeometry(
    [{ id: 'b1', page: 0, lineIds: ['l1'] }, { id: 'b2', page: 0, lineIds: ['l2'] }], lines, CAL,
  );
  assert.equal(g.get('b2')!.gapAbove, 1.5);
});

test('gapAbove is null across a page break, always', () => {
  // The distance from the bottom of one page to the top of the next is a fact
  // about the trim size. Treating it as leading would make the first paragraph
  // of every page look new.
  const lines = [line('l1', 0, 200, 1700, 1000, 'end of page'), line('l2', 1, 200, 100, 1000, 'top of the next')];
  const g = computeBlockGeometry(
    [{ id: 'b1', page: 0, lineIds: ['l1'] }, { id: 'b2', page: 1, lineIds: ['l2'] }], lines, CAL,
  );
  assert.equal(g.get('b2')!.gapAbove, null);
  // The other three facts still cross the page: they are the only evidence left.
  assert.equal(g.get('b2')!.firstLineIndent, 0);
  assert.equal(g.get('b2')!.prevLineShort, false);
});

test('a wrap hyphen across the junction is detected', () => {
  const lines = [line('l1', 0, 200, 100, 1000, 'the inter-'), line('l2', 0, 200, 140, 1000, 'national scene')];
  const g = computeBlockGeometry(
    [{ id: 'b1', page: 0, lineIds: ['l1'] }, { id: 'b2', page: 0, lineIds: ['l2'] }], lines, CAL,
  );
  assert.equal(g.get('b2')!.prevEndsWrapHyphen, true);
});

test('a hyphen not followed by a letter is not a wrap hyphen', () => {
  const lines = [line('l1', 0, 200, 100, 1000, 'the inter-'), line('l2', 0, 200, 140, 1000, '3 scenes')];
  const g = computeBlockGeometry(
    [{ id: 'b1', page: 0, lineIds: ['l1'] }, { id: 'b2', page: 0, lineIds: ['l2'] }], lines, CAL,
  );
  assert.equal(g.get('b2')!.prevEndsWrapHyphen, false);
});

test('a negative indent is reported as measured, not clamped', () => {
  // A drop cap or marginalia starts left of the margin. The number is evidence
  // and the consumer decides; silently flooring it to zero would make it look
  // like an ordinary flush line.
  const lines = [line('l1', 0, 200, 100, 1000, 'a'), line('l2', 0, 144, 140, 1000, 'b')];
  const g = computeBlockGeometry(
    [{ id: 'b1', page: 0, lineIds: ['l1'] }, { id: 'b2', page: 0, lineIds: ['l2'] }], lines, CAL,
  );
  assert.equal(g.get('b2')!.firstLineIndent, -2);
});

test('a dangling line id throws, naming the block and the line', () => {
  assert.throws(
    () => computeBlockGeometry([{ id: 'b1', page: 0, lineIds: ['nope'] }], [], CAL),
    (e: unknown) => {
      assert.ok(e instanceof GeometryInputError);
      assert.match(e.message, /block b1 references line nope, which is not in scan\/lines\.json/);
      return true;
    },
  );
});

test('a block with no lines throws', () => {
  assert.throws(
    () => computeBlockGeometry([{ id: 'b1', page: 0, lineIds: [] }], [], CAL),
    /block b1 has no lines/,
  );
});
