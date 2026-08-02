/**
 * The shared display-run fixture, replayed against THIS repo's copy of the rule.
 *
 * `src/blocks/display-run-merge.ts` exists twice — here and in BookForgeApp at
 * `shared/ocr/display-run-merge.ts` — because the two programs are separate
 * repositories and the merge has to be the same decision in both: foundry runs
 * it before the blocks model classifies anything, BookForge runs it when a
 * corpus book's blocks are formed. A rule that drifted between them would train
 * the model on one segmentation and infer with another, which reads as a bad
 * model rather than as a bug.
 *
 * `fixtures/display-run-merge.fixture.json` is the drift alarm: the identical
 * file is checked into BookForgeApp at `shared/ocr/display-run-merge.fixture.json`
 * and replayed there by `tools/test-display-run-merge.js`. Change the rule in one
 * repo and this test goes red in the other.
 *
 * Beyond the replay, three properties the fixture cannot state as data:
 * order-independence, idempotence, and that malformed geometry throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  planDisplayRuns,
  DisplayRunInputError,
  DISPLAY_RUN_RULE,
  type DisplayRunBlock,
} from '../../src/blocks/display-run-merge.js';
import { formBlocks, mergeDisplayRuns } from '../../src/commands.js';
import type { ScanLine, ScanPage } from '../../src/pipeline/artifacts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', '..', 'fixtures', 'display-run-merge.fixture.json');

interface FixtureCase {
  name: string;
  why: string;
  blocks: DisplayRunBlock[];
  expect: {
    runs: string[][];
    modalFontSize: number;
    bodyColumnWidth: number;
    furnitureIds: string[];
  };
}
interface FixtureError {
  name: string;
  why: string;
  blocks: DisplayRunBlock[];
  expectErrorContains: string;
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as {
  rule: string;
  cases: FixtureCase[];
  errors: FixtureError[];
};

test('the fixture was written for this version of the rule', () => {
  assert.equal(fixture.rule, DISPLAY_RUN_RULE.version);
});

for (const c of fixture.cases) {
  test(`fixture: ${c.name}`, () => {
    const plan = planDisplayRuns(c.blocks);
    assert.deepEqual(plan.runs, c.expect.runs, c.why);
    assert.equal(plan.modalFontSize, c.expect.modalFontSize);
    assert.equal(plan.bodyColumnWidth, c.expect.bodyColumnWidth);
    assert.deepEqual(plan.furnitureIds, c.expect.furnitureIds);
  });
}

for (const e of fixture.errors) {
  test(`fixture error: ${e.name}`, () => {
    assert.throws(
      () => planDisplayRuns(e.blocks),
      (err: unknown) => {
        assert.ok(err instanceof DisplayRunInputError, `expected DisplayRunInputError, got ${err}`);
        // The message must NAME the offender: an error that says "a block is
        // malformed" over a 6,000-block book is not actionable.
        assert.ok(
          err.message.includes(e.expectErrorContains),
          `${e.why}\n  message did not name ${e.expectErrorContains}: ${err.message}`,
        );
        return true;
      },
    );
  });
}

/** Deterministic shuffle so a failure is reproducible. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('the plan does not depend on the order blocks arrive in', () => {
  for (const c of fixture.cases) {
    const straight = planDisplayRuns(c.blocks);
    for (const seed of [1, 7, 99]) {
      const shuffled = planDisplayRuns(shuffle(c.blocks, seed));
      assert.deepEqual(shuffled.runs, straight.runs, `${c.name} (seed ${seed})`);
      assert.deepEqual(shuffled.furnitureIds, straight.furnitureIds, `${c.name} (seed ${seed})`);
    }
  }
});

/** Apply a plan the way both callers do, so the result can be re-planned. */
function applyPlan(blocks: readonly DisplayRunBlock[], runs: readonly string[][]): DisplayRunBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const swallowed = new Set(runs.flatMap((r) => r.slice(1)));
  const leadOf = new Map(runs.map((r) => [r[0], r]));
  const out: DisplayRunBlock[] = [];
  for (const b of blocks) {
    if (swallowed.has(b.id)) continue;
    const run = leadOf.get(b.id);
    if (!run) { out.push(b); continue; }
    const members = run.map((id) => byId.get(id)!);
    const x0 = Math.min(...members.map((m) => m.x));
    const y0 = Math.min(...members.map((m) => m.y));
    out.push({
      ...b,
      x: x0,
      y: y0,
      width: Math.max(...members.map((m) => m.x + m.width)) - x0,
      height: Math.max(...members.map((m) => m.y + m.height)) - y0,
      fontSize: Math.max(...members.map((m) => m.fontSize)),
      lineCount: members.reduce((n, m) => n + m.lineCount, 0),
      text: members.map((m) => m.text).join(' ').trim(),
    });
  }
  return out;
}

test('running the rule on its own output is a no-op', () => {
  for (const c of fixture.cases) {
    const plan = planDisplayRuns(c.blocks);
    const merged = applyPlan(c.blocks, plan.runs);
    assert.deepEqual(
      planDisplayRuns(merged).runs, [],
      `${c.name}: the merged blocks wanted merging again, so the fixed point is not one`,
    );
  }
});

test('a book with no type size at all is refused, not guessed at', () => {
  const blocks: DisplayRunBlock[] = [{
    id: 'sizeless', page: 0, x: 0, y: 0, width: 100, height: 20,
    fontSize: 0, lineCount: 0, pageWidth: 450, pageHeight: 666, text: '[Image 100x20]',
  }];
  assert.throws(() => planDisplayRuns(blocks), DisplayRunInputError);
});

test('an empty book plans nothing rather than dividing by zero', () => {
  assert.throws(() => planDisplayRuns([]), DisplayRunInputError);
});

// ── the wiring, not just the rule ───────────────────────────────────────────
//
// The gap splitter is what CREATES the problem this rule solves, so the two are
// tested together: real scan lines in, one heading out, and the merged block
// carrying every line of the heading in reading order.

function scanPage(page: number): ScanPage {
  return { page, widthPx: 1200, heightPx: 1800, deskewDeg: 0, dpi: 200 };
}

let lineSeq = 0;
function scanLine(page: number, x: number, y: number, w: number, h: number, text: string): ScanLine {
  return { id: `l${lineSeq++}`, page, bbox: [x, y, x + w, y + h], text, conf: 90 };
}

test('a chapter opening the gap splitter cut apart comes back as one block', () => {
  const pages = [scanPage(0), scanPage(1), scanPage(2)];
  const lines: ScanLine[] = [
    // Page 0, a chapter opening: a small tracked kicker, a title over two lines,
    // then an epigraph and body. The gap splitter cuts all four apart.
    scanLine(0, 300, 200, 200, 30, 'CHAPTER 1'),
    scanLine(0, 200, 300, 700, 60, 'One Reich, One People,'),
    scanLine(0, 200, 400, 700, 60, 'One Church!'),
    scanLine(0, 250, 600, 600, 26, 'an epigraph line that is body sized'),
    scanLine(0, 200, 700, 800, 26, 'body text begins here and runs on'),
    scanLine(0, 200, 735, 800, 26, 'for several more lines of prose'),
    scanLine(0, 200, 770, 800, 26, 'until the page is full of it'),
  ];
  // Two more pages of plain body, so the modal type size is the body's.
  for (const p of [1, 2]) {
    for (let i = 0; i < 12; i++) {
      lines.push(scanLine(p, 200, 200 + i * 35, 800, 26, `body line ${i} of page ${p}`));
    }
  }

  const raw = formBlocks(pages, lines);
  const page0Raw = raw.filter((b) => b.page === 0);
  assert.equal(
    page0Raw.length, 5,
    `the splitter was supposed to cut the heading into three; it made ${page0Raw.length} blocks`,
  );

  const merged = mergeDisplayRuns(pages, raw, lines);
  const page0 = merged.filter((b) => b.page === 0);
  assert.equal(page0.length, 3, 'the kicker and both title lines became one block');

  const heading = page0[0];
  assert.equal(heading.lineCount, 3);
  assert.equal(heading.text, 'CHAPTER 1\nOne Reich, One People,\nOne Church!');
  // Rebuilt through makeBlock, so the box covers every line it swallowed.
  assert.equal(heading.bbox[1], 200);
  assert.equal(heading.bbox[3], 460);

  // Ids stay dense and in order after blocks disappear from the middle.
  assert.deepEqual(page0.map((b) => b.id), ['p0000b000', 'p0000b001', 'p0000b002']);
});

test('merging refuses a block whose page the scan does not have, naming it', () => {
  const lines = [scanLine(0, 200, 200, 800, 26, 'body text on a page nobody declared')];
  const raw = formBlocks([scanPage(0)], lines);
  assert.throws(
    () => mergeDisplayRuns([scanPage(9)], raw, lines),
    /is on page 0, which is not in scan\/pages\.json/,
  );
});
