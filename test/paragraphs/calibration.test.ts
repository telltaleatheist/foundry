/**
 * Calibration decides which signal carries paragraph information in a book, and
 * the failure that matters is not "got it wrong" — it is "claimed a convention
 * that is not there". A confident wrong verdict produces false breaks, and a
 * false break is a full stop in the middle of a sentence (§9d decision 3).
 *
 * So the liars get their own tests: centred headings (indented on the left by
 * construction), a book that is merely noisy, a book whose leading is uneven.
 * None of them may forge a convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calibrate, CalibrationInputError, type CalibrationLine } from '../../src/paragraphs/calibration.js';

const BODY_H = 28;
const PITCH = 40;
const LEFT = 200;
const RIGHT = 1000;
const INDENT = 42; // 1.5 body heights, a normal first-line indent

/**
 * A deterministic ±1px wobble, keyed off the line index. Real deskewed scans
 * never produce identical coordinates, and a calibrator that only works on
 * exact arithmetic would be measuring the fixture rather than the method.
 */
const wobble = (i: number): number => ((i * 2654435761) % 3) - 1;

interface BookShape {
  paragraphs: number;
  linesPerParagraph: number;
  linesPerPage: number;
  indent: boolean;
  gap: boolean;
}

function makeBook(shape: BookShape): CalibrationLine[] {
  const lines: CalibrationLine[] = [];
  let page = 0;
  let y = 100;
  let onPage = 0;
  let i = 0;
  for (let p = 0; p < shape.paragraphs; p++) {
    for (let l = 0; l < shape.linesPerParagraph; l++) {
      if (onPage >= shape.linesPerPage) { page++; y = 100; onPage = 0; }
      const first = l === 0;
      // A paragraph's last line stops short — that is what makes it the last one.
      const last = l === shape.linesPerParagraph - 1;
      const x0 = LEFT + (first && shape.indent ? INDENT : 0) + wobble(i);
      const x1 = (last ? LEFT + 520 : RIGHT) + wobble(i + 7);
      if (first && shape.gap && onPage > 0) y += Math.round(PITCH * 0.5);
      lines.push({ page, bbox: [x0, y, x1, y + BODY_H + wobble(i + 3)] });
      y += PITCH;
      onPage++;
      i++;
    }
  }
  return lines;
}

const INDENT_BOOK: BookShape = { paragraphs: 40, linesPerParagraph: 6, linesPerPage: 30, indent: true, gap: false };
const BLOCK_BOOK: BookShape = { paragraphs: 40, linesPerParagraph: 6, linesPerPage: 30, indent: false, gap: true };
const NO_CONVENTION: BookShape = { paragraphs: 40, linesPerParagraph: 6, linesPerPage: 30, indent: false, gap: false };

test('an indent-style book calibrates to the indent convention', () => {
  const v = calibrate(makeBook(INDENT_BOOK));
  assert.equal(v.convention, 'indent');
  assert.equal(v.degraded, false);
  assert.equal(v.indent.fired, true);
  assert.equal(v.gap.fired, false, `gap should not fire: ${v.gap.why}`);
  // The threshold is the book's OWN midpoint, not a constant: flush ~0 against
  // an indent of 42/28 = 1.5 body heights puts it near 0.75.
  assert.ok(v.indent.threshold > 0.5 && v.indent.threshold < 1.1, `threshold ${v.indent.threshold}`);
  // One opening per 6-line paragraph.
  assert.ok(Math.abs(v.indent.upperShare - 1 / 6) < 0.05, `share ${v.indent.upperShare}`);
});

test('a block-style book calibrates to the block convention', () => {
  const v = calibrate(makeBook(BLOCK_BOOK));
  assert.equal(v.convention, 'block');
  assert.equal(v.degraded, false);
  assert.equal(v.gap.fired, true);
  assert.equal(v.indent.fired, false, `indent should not fire: ${v.indent.why}`);
  // ~1.5x pitch gaps against 1.0x leading: the midpoint lands between them.
  assert.ok(v.gap.threshold > 1.05 && v.gap.threshold < 1.5, `threshold ${v.gap.threshold}`);
});

test('a book with neither signal degrades to none, loudly, and does not throw', () => {
  const v = calibrate(makeBook(NO_CONVENTION));
  assert.equal(v.convention, 'none');
  assert.equal(v.degraded, true);
  assert.equal(v.indent.fired, false);
  assert.equal(v.gap.fired, false);
  assert.match(v.message, /NO PARAGRAPH CONVENTION DETECTED/);
  assert.match(v.message, /few or no breaks/);
  assert.match(v.message, /Nothing is guessed/);
  // Both signals still report WHY, so the verdict is diagnosable from the artifact.
  assert.ok(v.indent.why.length > 0);
  assert.ok(v.gap.why.length > 0);
});

test('the calibrated frame is measured, not assumed', () => {
  const v = calibrate(makeBook(INDENT_BOOK));
  assert.ok(Math.abs(v.bodyHeight - BODY_H) <= 1, `bodyHeight ${v.bodyHeight}`);
  assert.ok(Math.abs(v.pitch - PITCH) <= 1, `pitch ${v.pitch}`);
  assert.ok(Math.abs(v.flushLeft - LEFT) <= 1, `flushLeft ${v.flushLeft}`);
  assert.ok(Math.abs(v.bodyRight - RIGHT) <= 2, `bodyRight ${v.bodyRight}`);
  assert.ok(Math.abs(v.measure - (RIGHT - LEFT)) <= 3, `measure ${v.measure}`);
});

test('the pitch unit excludes the paragraph gaps it is used to detect', () => {
  // In a block-style book 1 line in 6 is preceded by a 1.5x advance. If those
  // advances leaked into the pitch, the unit would inflate and the gap cluster
  // would stop clearing its own threshold.
  const v = calibrate(makeBook(BLOCK_BOOK));
  assert.ok(Math.abs(v.pitch - PITCH) <= 1, `pitch ${v.pitch} should be the body leading, not the mean advance`);
});

test('centred headings do not forge an indent convention', () => {
  // The specific trap: a centred line is indented on the left by construction.
  // A book with no indent convention but a centred heading on every page must
  // still calibrate to 'none'.
  const lines = makeBook(NO_CONVENTION);
  for (let page = 0; page < 8; page++) {
    lines.push({ page, bbox: [LEFT + 250, 60, RIGHT - 250, 60 + BODY_H] });
  }
  const v = calibrate(lines);
  assert.equal(v.convention, 'none', `centred lines forged: ${v.indent.why}`);
});

test('a handful of indented outliers is not a convention', () => {
  const lines = makeBook(NO_CONVENTION);
  // Six deeply indented lines in a 240-line book: a poem, not a rhythm.
  for (let i = 0; i < 6; i++) lines[i * 30] = { page: lines[i * 30].page, bbox: [LEFT + 80, lines[i * 30].bbox[1], RIGHT, lines[i * 30].bbox[3]] };
  const v = calibrate(lines);
  assert.equal(v.convention, 'none');
  assert.match(v.indent.why, /outliers, not a rhythm/);
});

test('two indent depths are not indent-vs-flush', () => {
  // The margin is set by something other than the prose — a long stretch of
  // verse or a wide list flush against it — while the prose itself sits inset,
  // half of it further in than the rest. Two indent DEPTHS is a category
  // difference (a block quote against body text), not a paragraph convention,
  // and the tell is that the lower cluster is not on the margin.
  const lines: CalibrationLine[] = makeBook(NO_CONVENTION).map((l, i) => ({
    page: l.page,
    bbox: [l.bbox[0] + (i % 2 ? 60 : 20), l.bbox[1], l.bbox[2], l.bbox[3]] as [number, number, number, number],
  }));
  for (let i = 0; i < 130; i++) {
    lines.push({ page: i % 8, bbox: [LEFT, 1400 + (i % 8) * PITCH, LEFT + 90, 1400 + (i % 8) * PITCH + BODY_H] });
  }
  const v = calibrate(lines);
  assert.notEqual(v.convention, 'indent');
  assert.match(v.indent.why, /two indent depths, not indent-vs-flush/);
});

test('wider leading alone is not a blank-line gap', () => {
  // Advances alternating 1.0x and 1.15x pitch: uneven leading in a scan, well
  // short of the ~1.5x a blank line produces.
  const lines: CalibrationLine[] = [];
  let y = 100;
  for (let i = 0; i < 200; i++) {
    lines.push({ page: Math.floor(i / 30), bbox: [LEFT, y, RIGHT, y + BODY_H] });
    if (i % 30 === 29) y = 100; else y += i % 2 ? PITCH : Math.round(PITCH * 1.15);
  }
  const v = calibrate(lines);
  assert.equal(v.gap.fired, false, `gap fired on uneven leading: separation ${v.gap.separation}`);
});

test('when both signals fire the stronger one wins, and both are reported', () => {
  const v = calibrate(makeBook({ ...INDENT_BOOK, gap: true }));
  assert.equal(v.indent.fired, true);
  assert.equal(v.gap.fired, true);
  assert.ok(v.convention === 'indent' || v.convention === 'block');
  assert.equal(v.degraded, false);
  // Whichever won, the loser's measurement survives into the artifact.
  assert.ok(v.indent.separation > 0 && v.gap.separation > 0);
});

test('the measured margins survive a cluster straddling a bucket boundary', () => {
  // Regression. The body's 200 right edges jitter across x=999..1001 and land
  // in two histogram buckets; 130 short lines all sit at one x and land in one.
  // Before the mode summed over neighbouring buckets, the smaller aligned
  // cluster won and the body measure came out at an eighth of its true width —
  // which then let every downstream filter through the wrong lines.
  const lines: CalibrationLine[] = makeBook(NO_CONVENTION);
  for (let i = 0; i < 130; i++) {
    lines.push({ page: i % 8, bbox: [LEFT, 1400 + (i % 8) * PITCH, LEFT + 90, 1400 + (i % 8) * PITCH + BODY_H] });
  }
  const v = calibrate(lines);
  assert.ok(Math.abs(v.bodyRight - RIGHT) <= 2, `bodyRight ${v.bodyRight}, expected ~${RIGHT}`);
  assert.ok(Math.abs(v.measure - (RIGHT - LEFT)) <= 3, `measure ${v.measure}`);
});

test('calibration is deterministic — same book, same verdict', () => {
  const a = calibrate(makeBook(INDENT_BOOK));
  const b = calibrate(makeBook(INDENT_BOOK));
  assert.deepEqual(a, b);
});

// ── bad input throws; bad FORMATTING does not ───────────────────────────────

test('too little geometry to calibrate against throws, naming the shortfall', () => {
  assert.throws(() => calibrate([{ page: 0, bbox: [0, 0, 10, 10] }]), (e: unknown) => {
    assert.ok(e instanceof CalibrationInputError);
    assert.match(e.message, /1 lines is not enough geometry/);
    return true;
  });
});

test('lines with no vertical extent throw rather than returning a verdict', () => {
  const flat: CalibrationLine[] = [];
  for (let i = 0; i < 40; i++) flat.push({ page: 0, bbox: [LEFT, i * 40, RIGHT, i * 40] });
  assert.throws(() => calibrate(flat), /median line height is zero/);
});

test('lines with no horizontal extent throw rather than returning a verdict', () => {
  const thin: CalibrationLine[] = [];
  for (let i = 0; i < 40; i++) thin.push({ page: 0, bbox: [LEFT, i * 40, LEFT, i * 40 + BODY_H] });
  assert.throws(() => calibrate(thin), /no horizontal extent/);
});

test('a book with no vertical rhythm throws — one line per page is not a book', () => {
  const scattered: CalibrationLine[] = [];
  for (let i = 0; i < 40; i++) scattered.push({ page: i, bbox: [LEFT, 100, RIGHT, 100 + BODY_H] });
  assert.throws(() => calibrate(scattered), /no readable vertical rhythm/);
});
