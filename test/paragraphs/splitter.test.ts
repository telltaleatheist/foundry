/**
 * The paragraph-start splitter's evidence rules, on geometry laid out by hand.
 *
 * What is being held down here is the ASYMMETRY (BLOCKS_TRAINING §13b): a
 * paragraph opening that is not cut is unreachable forever — no rung of the
 * grouping ladder and no future `continues` bit can place a break where there is
 * no junction — while a cut nothing votes for is rejoined by the merge bias one
 * stage later. So the tests come in two shapes:
 *
 *   - **must cut**: every convention's opening, in a book that uses it.
 *   - **must not cut**: the four liars that would forge a convention — a centred
 *     display line, a page-final short line, the flush line after a heading, and
 *     a wrap hyphen. A false cut through the last one is not even recoverable:
 *     the exporter heals hyphens per paragraph group.
 *
 * The geometry is built the way the real fixtures are: a wobble on every
 * coordinate, because a rule that only works on exact arithmetic is measuring
 * the fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calibrate, type CalibrationLine } from '../../src/paragraphs/calibration.js';
import {
  planParagraphSplits, PARAGRAPH_SPLIT_RULE,
  type SplitBlock, type SplitLine,
} from '../../src/paragraphs/splitter.js';

const BODY_H = 28;
const PITCH = 40;
const LEFT = 200;
const RIGHT = 1000;
/** 1.5 body heights — an ordinary first-line indent. */
const INDENT = 42;
/** How far short of the measure a paragraph's last line stops. */
const SHORT = 260;

const wobble = (i: number): number => ((i * 2654435761) % 3) - 1;

interface Row {
  text: string;
  /** Left inset from the margin, px. */
  indent?: number;
  /** Right edge short of the measure, px. */
  short?: number;
  /** Extra advance above this line, in pitches. */
  gapAbove?: number;
  /** Centred between the margins, at this width. */
  centredWidth?: number;
}

/** One page-worth of lines, laid out top to bottom, as ONE block per group. */
interface Layout {
  /** Each entry is a block: its rows in reading order. */
  blocks: Row[][];
}

let seq = 0;

function lay(layout: Layout, page = 0): { blocks: SplitBlock[]; lines: SplitLine[] } {
  const lines: SplitLine[] = [];
  const blocks: SplitBlock[] = [];
  let y = 100;
  for (const rows of layout.blocks) {
    const ids: string[] = [];
    for (const row of rows) {
      const i = seq++;
      y += Math.round(PITCH * (row.gapAbove ?? 0));
      const x0 = row.centredWidth !== undefined
        ? Math.round(LEFT + (RIGHT - LEFT - row.centredWidth) / 2)
        : LEFT + (row.indent ?? 0);
      const x1 = row.centredWidth !== undefined
        ? x0 + row.centredWidth
        : RIGHT - (row.short ?? 0);
      const id = `l${String(i).padStart(4, '0')}`;
      lines.push({ id, text: row.text, bbox: [x0 + wobble(i), y, x1 + wobble(i + 7), y + BODY_H + wobble(i + 3)] });
      ids.push(id);
      y += PITCH;
    }
    blocks.push({ id: `b${blocks.length}`, page, lineIds: ids });
    // Blocks are what the gap rule already separated: leave a real hole.
    y += PITCH;
  }
  return { blocks, lines };
}

/** A whole book of one shape, so the book-level thresholds have samples. */
function book(paragraph: (n: number) => Row[], count: number, perBlock = 4): {
  blocks: SplitBlock[]; lines: SplitLine[]; calibration: ReturnType<typeof calibrate>;
} {
  const groups: Row[][] = [];
  let rows: Row[] = [];
  for (let n = 0; n < count; n++) {
    rows.push(...paragraph(n));
    if ((n + 1) % perBlock === 0) { groups.push(rows); rows = []; }
  }
  if (rows.length) groups.push(rows);
  const { blocks, lines } = lay({ blocks: groups });
  const calLines: CalibrationLine[] = lines.map(l => ({ page: 0, bbox: l.bbox }));
  return { blocks, lines, calibration: calibrate(calLines) };
}

/** Line ids the plan cuts before. */
function cutIds(
  blocks: SplitBlock[], lines: SplitLine[], calibration: ReturnType<typeof calibrate>,
): Set<string> {
  const { splits } = planParagraphSplits(blocks, lines, calibration);
  const byId = new Map(blocks.map(b => [b.id, b]));
  return new Set(splits.map(s => byId.get(s.blockId)!.lineIds[s.lineIndex]));
}

// ── the three signals ───────────────────────────────────────────────────────

/** An indent book: first line inset, last line short, no extra leading. */
const indentParagraph = (n: number): Row[] => [
  { text: `Opening of paragraph ${n}.`, indent: INDENT },
  { text: 'A middle line that runs the full measure.' },
  { text: 'Another middle line that runs the full measure.' },
  { text: `The last line stops early ${n}.`, short: SHORT },
];

test('an indent book is cut at every first-line indent', () => {
  const { blocks, lines, calibration } = book(indentParagraph, 24);
  const { splits, report } = planParagraphSplits(blocks, lines, calibration);
  assert.equal(report.indent.fired, true, report.indent.why);
  // The book's own midpoint, between flush (0) and 1.5 body heights.
  assert.ok(report.thresholds.indent! > 0.4 && report.thresholds.indent! < 1.2, `${report.thresholds.indent}`);

  const cut = cutIds(blocks, lines, calibration);
  const openings = lines.filter(l => l.text.startsWith('Opening'));
  const inside = openings.filter(l =>
    blocks.some(b => b.lineIds.indexOf(l.id) > 0));
  assert.ok(inside.length > 0);
  for (const l of inside) assert.ok(cut.has(l.id), `missed the opening at ${l.id}: ${l.text}`);
  // And nothing else in the running text.
  const middles = lines.filter(l => l.text.startsWith('A middle') || l.text.startsWith('Another'));
  for (const l of middles) assert.equal(cut.has(l.id), false, `cut a middle line at ${l.id}`);
  assert.ok(splits.length >= inside.length);
});

/** A FLUSH book: no indent, no extra leading — only the short last line says so. */
const flushParagraph = (n: number): Row[] => [
  { text: `Opening of paragraph ${n}.` },
  { text: 'A middle line that runs the full measure.' },
  { text: 'Another middle line that runs the full measure.' },
  { text: `The last line stops early ${n}.`, short: SHORT },
];

test('a FLUSH book is cut after every short last line — the case indent and gap cannot see', () => {
  const { blocks, lines, calibration } = book(flushParagraph, 24);
  const { report } = planParagraphSplits(blocks, lines, calibration);
  // This is the §13b case: the book has no indent, and the gap threshold
  // calibration derived is INERT — it was measured over the holes BETWEEN
  // blocks, which the gap rule already cut, so nothing inside a block clears it.
  // Exactly the Kershaw finding, and the fill signal is what is left.
  assert.equal(report.indent.fired, false, report.indent.why);
  assert.equal(report.byRule.gap, 0, 'the gap threshold cut nothing inside a block');
  assert.equal(report.fill.fired, true, report.fill.why);
  assert.ok(report.thresholds.fill! >= PARAGRAPH_SPLIT_RULE.SHORT_LINE_UNITS, `${report.thresholds.fill}`);

  const cut = cutIds(blocks, lines, calibration);
  const openings = lines.filter(l => l.text.startsWith('Opening') && blocks.some(b => b.lineIds.indexOf(l.id) > 0));
  for (const l of openings) assert.ok(cut.has(l.id), `missed the flush opening at ${l.id}`);
});

/** A gap book: flush left, a blank line between paragraphs. */
const gapParagraph = (n: number): Row[] => [
  { text: `Opening of paragraph ${n}.`, gapAbove: 0.5 },
  { text: 'A middle line that runs the full measure.' },
  { text: 'Another middle line that runs the full measure.' },
  { text: `The last line stops early ${n}.`, short: SHORT },
];

test("a gap book is cut at the book's own gap threshold, which calibration measured", () => {
  const { blocks, lines, calibration } = book(gapParagraph, 24);
  const { report } = planParagraphSplits(blocks, lines, calibration);
  assert.equal(calibration.convention, 'block', calibration.message);
  assert.equal(report.gap.available, true);
  assert.equal(report.gap.threshold, calibration.gap.threshold);

  const cut = cutIds(blocks, lines, calibration);
  const openings = lines.filter(l => l.text.startsWith('Opening') && blocks.some(b => b.lineIds.indexOf(l.id) > 0));
  for (const l of openings) assert.ok(cut.has(l.id), `missed the gapped opening at ${l.id}`);
});

test('a book with no signal at all cuts nothing, and says so rather than guessing', () => {
  // Every line full, every line flush, uniform leading: there is no paragraph
  // information in this geometry. §9d decision 5's sanctioned degradation.
  // ONE block, so there is not even a hole between blocks for calibration to
  // read a gap convention out of.
  const { blocks, lines, calibration } = book(() => [
    { text: 'A line that runs the full measure.' },
    { text: 'Another line that runs the full measure.' },
    { text: 'A third line that runs the full measure.' },
    { text: 'A fourth line that runs the full measure.' },
  ], 24, 24);
  const { splits, report } = planParagraphSplits(blocks, lines, calibration);
  assert.equal(splits.length, 0);
  assert.equal(report.indent.fired, false);
  assert.equal(report.fill.fired, false);
  assert.match(report.message, /NO PARAGRAPH-START SIGNAL/);
});

// ── the liars ───────────────────────────────────────────────────────────────

test('a page-final short line cannot produce a cut — that junction already exists', () => {
  // The last line of a block is short because the page ended, not because the
  // paragraph did. It has no successor inside the block, so there is nothing to
  // cut before; the block boundary is already a junction.
  const { blocks, lines, calibration } = book(flushParagraph, 24);
  const { splits } = planParagraphSplits(blocks, lines, calibration);
  const byId = new Map(blocks.map(b => [b.id, b]));
  for (const s of splits) {
    const b = byId.get(s.blockId)!;
    assert.ok(s.lineIndex >= 1 && s.lineIndex < b.lineIds.length, `cut at ${s.lineIndex} of ${b.lineIds.length}`);
  }
});

test('the flush first line after a heading is not cut — the heading is its own block', () => {
  // Post-heading openings are set FLUSH in an indent book. They are invisible to
  // every rule here, and they do not need to be visible: the heading is a
  // separate block, so the junction is already there.
  const { blocks: bookBlocks, lines: bookLines } = book(indentParagraph, 24);
  const heading = lay({
    blocks: [
      [{ text: 'A Chapter Heading', centredWidth: 420 }],
      // The chapter's first paragraph: flush, by convention.
      [{ text: 'Opening after the heading.' },
       { text: 'A middle line that runs the full measure.' },
       { text: 'The last line stops early.', short: SHORT }],
    ],
  }, 1);
  const blocks = [...bookBlocks, ...heading.blocks];
  const lines = [...bookLines, ...heading.lines];
  const calibration = calibrate(lines.map(l => ({ page: 0, bbox: l.bbox })));
  const cut = cutIds(blocks, lines, calibration);
  const opening = heading.lines.find(l => l.text.startsWith('Opening after'))!;
  // It is block-initial, so it is not a candidate at all.
  assert.equal(cut.has(opening.id), false);
});

test('a centred display block is never cut between its lines', () => {
  const { blocks: bookBlocks, lines: bookLines } = book(indentParagraph, 24);
  const title = lay({
    blocks: [[
      { text: 'CHAPTER ONE', centredWidth: 300 },
      { text: 'The Title Of The Book', centredWidth: 520 },
      { text: 'And Its Subtitle', centredWidth: 360 },
    ]],
  }, 1);
  const blocks = [...bookBlocks, ...title.blocks];
  const lines = [...bookLines, ...title.lines];
  const calibration = calibrate(lines.map(l => ({ page: 0, bbox: l.bbox })));
  const cut = cutIds(blocks, lines, calibration);
  for (const l of title.lines) {
    assert.equal(cut.has(l.id), false, `cut a centred display line: ${l.text}`);
  }
});

test('a wrap hyphen is never cut through, whatever the geometry says', () => {
  // The strongest evidence there is that two lines are one sentence (132/133,
  // §9d decision 2). Here it sits at a line that is indented AND follows a short
  // line — both rules fire, and both are refused.
  const { blocks: bookBlocks, lines: bookLines } = book(indentParagraph, 24);
  const trap = lay({
    blocks: [[
      { text: 'A line that ends in a wrap hyphen and is short, ques-', short: SHORT },
      { text: 'tion, the rest of the word.', indent: INDENT },
      { text: 'A middle line that runs the full measure.' },
    ]],
  }, 1);
  const blocks = [...bookBlocks, ...trap.blocks];
  const lines = [...bookLines, ...trap.lines];
  const calibration = calibrate(lines.map(l => ({ page: 0, bbox: l.bbox })));
  const { splits, report } = planParagraphSplits(blocks, lines, calibration);
  const byId = new Map(blocks.map(b => [b.id, b]));
  const cut = new Set(splits.map(s => byId.get(s.blockId)!.lineIds[s.lineIndex]));
  const tail = trap.lines.find(l => l.text.startsWith('tion,'))!;
  assert.equal(cut.has(tail.id), false, 'cut through a wrap hyphen');
  assert.ok(report.hyphenBlocked >= 1, 'the refusal is counted, not silent');
});

test('a block quote inset on both sides does not read as a page of paragraph openings', () => {
  // Every line of it is inset from the BOOK's margin, so a book-relative rule
  // would cut at each one. The frame is the BLOCK's own margin, so none of them
  // is indented relative to its neighbours.
  const { blocks: bookBlocks, lines: bookLines } = book(indentParagraph, 24);
  const quote = lay({
    blocks: [[
      { text: 'A quotation set inside both margins,', indent: 3 * BODY_H, short: 2 * BODY_H },
      { text: 'running over several lines of its own,', indent: 3 * BODY_H, short: 2 * BODY_H },
      { text: 'none of which opens a new paragraph.', indent: 3 * BODY_H, short: 2 * BODY_H },
    ]],
  }, 1);
  const blocks = [...bookBlocks, ...quote.blocks];
  const lines = [...bookLines, ...quote.lines];
  const calibration = calibrate(lines.map(l => ({ page: 0, bbox: l.bbox })));
  const cut = cutIds(blocks, lines, calibration);
  for (const l of quote.lines) assert.equal(cut.has(l.id), false, `cut inside a block quote: ${l.text}`);
});

test('a drop cap over-splits rather than under-splits, and the ladder can undo it', () => {
  // The initial sits in its own band and the two lines beside it are inset by
  // its width. They read as indented, and they are cut. That is the recoverable
  // direction, and the test exists so the behaviour is a decision rather than a
  // surprise.
  const { blocks: bookBlocks, lines: bookLines } = book(indentParagraph, 24);
  const drop = lay({
    blocks: [[
      { text: 'W', centredWidth: 60 },
      { text: 'hen the chapter opens with a drop cap,', indent: 3 * BODY_H },
      { text: 'the second line is inset by it too,', indent: 3 * BODY_H },
      { text: 'and then the text returns to the margin.' },
      { text: 'A middle line that runs the full measure.' },
    ]],
  }, 1);
  const blocks = [...bookBlocks, ...drop.blocks];
  const lines = [...bookLines, ...drop.lines];
  const calibration = calibrate(lines.map(l => ({ page: 0, bbox: l.bbox })));
  const cut = cutIds(blocks, lines, calibration);
  const inset = drop.lines.filter(l => l.text.startsWith('hen the') || l.text.startsWith('the second'));
  assert.ok(inset.some(l => cut.has(l.id)), 'the drop-cap lines were expected to be cut (over-split)');
});

// ── input contract ──────────────────────────────────────────────────────────

test('a block naming a line that is not in the line table throws, naming both', () => {
  assert.throws(
    () => planParagraphSplits(
      [{ id: 'b1', page: 0, lineIds: ['l1', 'ghost'] }],
      [{ id: 'l1', text: 'x', bbox: [0, 0, 10, 10] }],
      calibrate(Array.from({ length: 20 }, (_, i) => ({ page: 0, bbox: [200, i * 40, 1000, i * 40 + 28] as const }))
        .map(l => ({ page: l.page, bbox: [...l.bbox] as [number, number, number, number] }))),
    ),
    /ghost/,
  );
});
