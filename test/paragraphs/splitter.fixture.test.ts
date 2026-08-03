/**
 * The splitter against REAL pages, through the real block formation.
 *
 * `fixtures/scan/ocr/<page>.json` is what the band path actually read for the
 * fixture renders — genuine Tesseract line boxes and text, from books with
 * genuine typography. Five of them are one book (Deathstalker, an indent-set
 * novel with a running head and a folio on every page), which is enough of a
 * book for the book-level thresholds to be measured rather than asserted.
 *
 * This is the level the unit tests cannot reach: hand-laid geometry can be made
 * to prove anything, and the failure this whole stage exists to fix was only
 * visible on a real run (BLOCKS_TRAINING §13b — 24 body blocks for ~53
 * paragraphs). So the assertions here are about the SHAPE of the result on real
 * ink: the openings the page shows are cut, the running heads and folios are
 * not touched, no cut lands inside a word, and the count moves the way the
 * measurement says it should.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formBlocks, mergeDisplayRuns, splitParagraphs } from '../../src/commands.js';
import { calibrate } from '../../src/paragraphs/calibration.js';
import { planParagraphSplits } from '../../src/paragraphs/splitter.js';
import { isWrapHyphenBreak } from '../../src/paragraphs/hyphen.js';
import type { ScanLine, ScanPage } from '../../src/pipeline/artifacts.js';

const OCR_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'scan', 'ocr');

interface OcrFixture {
  page: number;
  widthPx: number;
  heightPx: number;
  lines: Array<{ bbox: [number, number, number, number]; text: string; conf: number | null; psm: number }>;
}

/** Load fixture pages as one book, numbered in the order given. */
function loadBook(names: readonly string[]): { pages: ScanPage[]; lines: ScanLine[] } {
  const pages: ScanPage[] = [];
  const lines: ScanLine[] = [];
  names.forEach((name, page) => {
    const f = JSON.parse(readFileSync(join(OCR_DIR, `${name}.json`), 'utf8')) as OcrFixture;
    pages.push({ page, widthPx: f.widthPx, heightPx: f.heightPx, deskewDeg: 0, dpi: 200 });
    f.lines.forEach((l, i) => {
      lines.push({
        id: `p${String(page).padStart(4, '0')}l${String(i).padStart(4, '0')}`,
        page, bbox: l.bbox, text: l.text, conf: l.conf, psm: l.psm,
      });
    });
  });
  return { pages, lines };
}

const DEATHSTALKER = ['deathstalker-p1', 'deathstalker-p64', 'deathstalker-p100', 'deathstalker-p176', 'deathstalker-p521'];

function form(names: readonly string[]) {
  const { pages, lines } = loadBook(names);
  const calibration = calibrate(lines.map(l => ({ page: l.page, bbox: l.bbox })));
  const gap = formBlocks(pages, lines);
  const cut = splitParagraphs(gap, lines, calibration);
  return {
    pages, lines, calibration, gap,
    split: cut.blocks, report: cut.report,
    merged: mergeDisplayRuns(pages, cut.blocks, lines),
    mergedBefore: mergeDisplayRuns(pages, gap, lines),
  };
}

test('a real indent-set novel: the splitter finds the indent it is set in', () => {
  const { report } = form(DEATHSTALKER);
  assert.equal(report.indent.fired, true, report.indent.why);
  // Deathstalker's first-line indent is about one em — the threshold is the
  // book's own midpoint between flush and that, so it lands under one body
  // height. If this ever needs a constant, the rule stopped being book-relative.
  assert.ok(
    report.thresholds.indent! > 0.2 && report.thresholds.indent! < 1.5,
    `threshold ${report.thresholds.indent}`,
  );
  assert.ok(report.cuts > 0, report.message);
});

test('no cut is unexplained: every one names the rule that proposed it', () => {
  const { lines, gap, calibration } = form(DEATHSTALKER);
  const { splits } = planParagraphSplits(gap, lines, calibration);
  assert.ok(splits.length > 0);
  for (const s of splits) {
    assert.ok(
      s.rules.indent || s.rules.gap || s.rules.fill,
      `${s.blockId}@${s.lineIndex} was cut by nothing`,
    );
  }
});

test('the cuts are paragraph openings on the page, checked by hand', () => {
  // deathstalker-p176 is the sample: flush lines start at x≈49, openings at
  // x≈76. Every opening on that page must be cut, and nothing else may be.
  const { pages, lines, calibration } = form(['deathstalker-p176']);
  const gap = formBlocks(pages, lines);
  const { splits } = planParagraphSplits(gap, lines, calibration);
  const byBlock = new Map(gap.map(b => [b.id, b]));
  const cut = new Set(splits.map(s => byBlock.get(s.blockId)!.lineIds[s.lineIndex]));

  const inBlockLines = gap.flatMap(b => b.lineIds.slice(1));
  const indented = inBlockLines.filter(id => lines.find(l => l.id === id)!.bbox[0] >= 70);
  const flush = inBlockLines.filter(id => lines.find(l => l.id === id)!.bbox[0] < 70);
  assert.ok(indented.length >= 3, `only ${indented.length} indented lines inside blocks`);
  for (const id of indented) {
    assert.ok(cut.has(id), `missed the opening at ${id}: ${lines.find(l => l.id === id)!.text}`);
  }
  // Flush lines may still be cut by the fill rule (a short previous line is
  // real evidence), but never MOST of them — that would be a shredded page.
  const flushCut = flush.filter(id => cut.has(id)).length;
  assert.ok(flushCut < flush.length / 2, `${flushCut} of ${flush.length} flush lines cut`);
});

test('no cut lands inside a hyphenated word', () => {
  // The exporter heals wrap hyphens per paragraph GROUP, so a cut that survived
  // the ladder would ship half a word. Checked over both fixture books.
  for (const names of [DEATHSTALKER, ['michelle-remembers-p100'], ['was-hitler-an-atheist-p4']]) {
    const { lines, gap, calibration } = form(names);
    const byId = new Map(lines.map(l => [l.id, l]));
    const byBlock = new Map(gap.map(b => [b.id, b]));
    const { splits } = planParagraphSplits(gap, lines, calibration);
    for (const s of splits) {
      const ids = byBlock.get(s.blockId)!.lineIds;
      const prev = byId.get(ids[s.lineIndex - 1])!;
      const next = byId.get(ids[s.lineIndex])!;
      assert.equal(
        isWrapHyphenBreak(prev.text, next.text), false,
        `cut through "${prev.text.slice(-20)}" / "${next.text.slice(0, 20)}"`,
      );
    }
  }
});

test('a running head and a folio are one-line blocks and cannot be cut', () => {
  const { merged } = form(DEATHSTALKER);
  const heads = merged.filter(b => /^DEATHSTALKER/i.test(b.text));
  assert.ok(heads.length > 0);
  for (const h of heads) assert.equal(h.lineCount, 1, `${h.id} carries ${h.lineCount} lines`);
});

test('block formation splits, and the display-run merge still rejoins what it rejoined', () => {
  // The splitter runs BEFORE the display rule. If it damaged that rule's input,
  // the headings it merged before would come apart — so compare the multi-line
  // display units on both sides by their line sets.
  const { merged, mergedBefore, gap } = form(DEATHSTALKER);
  assert.ok(merged.length > gap.length, `${gap.length} -> ${merged.length}: nothing was split`);

  const after = new Set(merged.map(b => b.lineIds.join(',')));
  const runsBefore = mergedBefore.filter(b => b.lineCount > 1 && b.fontSizePx > 0);
  // Every unit the merge built before must still exist, OR its lines must have
  // been display material this stage had no business touching. The fixture book
  // has no chapter openings on these five pages, so the strict form holds.
  const lost = runsBefore.filter(b => !after.has(b.lineIds.join(',')));
  const stillDisplay = lost.filter(b => b.fontSizePx > 1.3 * medianFontSize(mergedBefore));
  assert.equal(stillDisplay.length, 0, `display units broken: ${stillDisplay.map(b => b.text).join(' | ')}`);
});

function medianFontSize(blocks: readonly { fontSizePx: number; lineCount: number }[]): number {
  const sizes = blocks.filter(b => b.lineCount > 1).map(b => b.fontSizePx).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)] ?? 0;
}

test('the count moves the way §13b says it must: more blocks, more junctions, same lines', () => {
  const { gap, split, lines, report } = form(DEATHSTALKER);
  const linesIn = (bs: readonly { lineIds: readonly string[] }[]): string[] =>
    bs.flatMap(b => [...b.lineIds]);
  // A split partitions: same lines, same order, more blocks.
  assert.deepEqual(linesIn(split), linesIn(gap));
  assert.equal(linesIn(split).length, lines.length);
  assert.equal(split.length, gap.length + report.cuts);
  assert.ok(report.cuts > 10, `only ${report.cuts} cuts over ${lines.length} lines`);
});
