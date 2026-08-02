/**
 * The stage that turns a run directory into a book.
 *
 * The interesting behaviour is the text ladder — footnotes over ocr over scan —
 * and the fact that it is a PIPELINE ORDER rather than a fallback chain. The
 * difference is testable: a stage that ran must have covered the whole book, and
 * a half-populated artifact throws instead of quietly mixing corrected and
 * uncorrected text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExportStage, deriveMetadata, ExportStageError } from '../../src/pipeline/export-stage.js';
import { readBlocks, readRun, readScanLines, writeArtifact, artifactPath } from '../../src/pipeline/artifacts.js';
import { buildRun, runDirFor } from '../../fixtures/export/generate.js';
import { applyFootnoteDeletions } from '../../src/footnotes/applier.js';
import { unzipMap } from '../export/unzip.js';

const METADATA = { title: 'A Synthetic Book', language: 'en', identifier: 'urn:uuid:test' };

function scratchRun(convention: 'indent' | 'block' | 'none' = 'indent'): { runDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'foundry-stage-'));
  const runDir = join(root, `${convention}-book`);
  buildRun(convention, runDir);
  return { runDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const prose = (zip: Uint8Array): string =>
  [...unzipMap(zip)].filter(([p]) => p.startsWith('EPUB/text/')).map(([, e]) => e.text()).join('\n');

test('the stage writes the EPUB and exclusions.json to their documented paths', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.equal(r.epubPath, join(runDir, 'export/book.epub'));
    assert.ok(existsSync(r.epubPath));
    assert.ok(existsSync(artifactPath(runDir, 'exportExclusions')));
    // Atomic: no temp file left behind.
    assert.equal(existsSync(`${r.epubPath}.tmp`), false);
  } finally { cleanup(); }
});

test('without an ocr artifact the scan text is used', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /This book exists to exercise the exporter/);
  } finally { cleanup(); }
});

test('ocr/lines.json supersedes the scan text', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const lines = readScanLines(runDir).lines;
    writeArtifact(runDir, 'ocrLines', {
      lines: lines.map(l => ({
        id: l.id,
        text: l.text.replace('exercise the exporter', 'EXERCISE THE EXPORTER'),
        edits: [], rejected: [],
      })),
    });
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /EXERCISE THE EXPORTER/);
    assert.equal(prose(r.zip).includes('exercise the exporter'), false);
  } finally { cleanup(); }
});

test('a PARTIAL ocr artifact throws rather than mixing corrected and uncorrected text', () => {
  // The quiet degradation this rule exists to prevent: half the book silently
  // uncorrected, and no way to tell from the output which half.
  const { runDir, cleanup } = scratchRun();
  try {
    const lines = readScanLines(runDir).lines;
    writeArtifact(runDir, 'ocrLines', {
      lines: lines.slice(0, 5).map(l => ({ id: l.id, text: l.text, edits: [], rejected: [] })),
    });
    assert.throws(() => runExportStage({ runDir, metadata: METADATA, log: () => {} }), (e: unknown) => {
      assert.ok(e instanceof ExportStageError);
      assert.match(e.message, /ocr\/lines\.json is present but does not cover \d+ line\(s\)/);
      assert.match(e.message, /re-run the ocr stage over the whole book/);
      return true;
    });
  } finally { cleanup(); }
});

test('footnotes/deletions.json replaces a block\'s text wholesale', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    // The artifact must DERIVE from the block's current lines — the export
    // replays the recorded deletions and refuses a rewrite it cannot
    // reproduce. So build it the way the footnotes stage does: apply a real
    // deletion to the real text.
    const target = readBlocks(runDir).blocks.find(b => b.category === 'footnote')!;
    const lines = readScanLines(runDir).lines;
    const byId = new Map(lines.map(l => [l.id, l.text]));
    const base = target.lineIds.map(id => byId.get(id)!).join('\n');
    const applied = [{ before: '1. A', after: 'A' }];
    const stripped = applyFootnoteDeletions(base, applied);
    assert.equal(stripped.rejected, 0);
    writeArtifact(runDir, 'footnoteDeletions', {
      blocks: [{ blockId: target.id, applied, rejected: 0, text: stripped.text }],
    });
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /A footnote at the foot/);
    assert.equal(prose(r.zip).includes('1. A footnote at the foot'), false);
  } finally { cleanup(); }
});

test('a footnotes rewrite that does not derive from the current lines is refused', () => {
  // The bug the 2-page end-to-end run caught, pinned: dagger derived its
  // deletions from the RAW scan text, ocr corrected the lines afterwards, and
  // the export silently shipped raw text minus markers for every block dagger
  // touched — OCR corrections discarded. Now the export replays the recorded
  // deletions against the shipping text and refuses a rewrite that does not
  // reproduce.
  const { runDir, cleanup } = scratchRun();
  try {
    const target = readBlocks(runDir).blocks.find(b => b.category === 'footnote')!;
    writeArtifact(runDir, 'footnoteDeletions', {
      blocks: [{ blockId: target.id, applied: [{ before: '1. A', after: 'A' }], rejected: 0, text: 'A stale rewrite from another text base.' }],
    });
    assert.throws(() => runExportStage({ runDir, metadata: METADATA, log: () => {} }), (e: unknown) => {
      assert.ok(e instanceof ExportStageError);
      assert.match(e.message, /does not derive from the current text/);
      assert.match(e.message, /Re-run the footnotes stage/);
      return true;
    });
  } finally { cleanup(); }
});

test('the hyphen vocabulary is the whole book, not the exported subset', () => {
  // "question" is attested only in a block the user excluded. The heal must
  // still happen: a word is attested by the BOOK, and letting an exclusion
  // change how a hyphen resolves elsewhere would make the text depend on the
  // filter.
  const { runDir, cleanup } = scratchRun();
  try {
    const attesting = readBlocks(runDir).blocks
      .find(b => b.category === 'body')!;
    const r = runExportStage({
      runDir, metadata: METADATA, log: () => {}, exclude: { blockIds: [attesting.id] },
    });
    assert.equal(prose(r.zip).includes('This book exists to exercise'), false, 'the block was not excluded');
    assert.match(prose(r.zip), /like question, which/);
    assert.equal(r.healedHyphens, 1);
  } finally { cleanup(); }
});

test('a run directory with no blocks.json says which stage to run', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-empty-run-'));
  try {
    assert.throws(
      () => runExportStage({ runDir: root, metadata: METADATA, log: () => {} }),
      /boxes\/blocks\.json: not found .* run the stage that produces it/s,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the degradation banner goes to the log, framed so it cannot be missed', () => {
  const { runDir, cleanup } = scratchRun('none');
  const said: string[] = [];
  try {
    runExportStage({ runDir, metadata: METADATA, log: m => said.push(m) });
    const banner = said.join('\n');
    assert.match(banner, /─{72}/, 'the degraded verdict is not framed');
    assert.match(banner, /DEGRADED PARAGRAPH ASSEMBLY/);
    assert.match(banner, /Calibration measured/);
  } finally { cleanup(); }
});

test('a calibrated book logs its verdict without the alarm', () => {
  const { runDir, cleanup } = scratchRun('indent');
  const said: string[] = [];
  try {
    runExportStage({ runDir, metadata: METADATA, log: m => said.push(m) });
    const banner = said.join('\n');
    assert.match(banner, /Paragraphs assembled under the indent convention/);
    assert.equal(banner.includes('DEGRADED'), false);
    assert.equal(banner.includes('─'.repeat(72)), false);
  } finally { cleanup(); }
});

test('the committed fixtures export without being mutated', () => {
  // A guard on the tests themselves: exporting reads the committed run dirs in
  // other suites, and a stray write there would break the drift check silently.
  for (const convention of ['indent', 'block', 'none'] as const) {
    const before = JSON.stringify(readBlocks(runDirFor(convention)));
    const { runDir, cleanup } = scratchRun(convention);
    try {
      runExportStage({ runDir, metadata: METADATA, log: () => {} });
    } finally { cleanup(); }
    assert.equal(JSON.stringify(readBlocks(runDirFor(convention))), before);
  }
});

// ── the CLI's surface ───────────────────────────────────────────────────────

test('--output writes a copy WITHOUT replacing the canonical artifact', () => {
  // The run directory is the contract: a book exported to the desktop must
  // still leave the run complete enough to re-export from.
  const { runDir, cleanup } = scratchRun();
  const dest = join(runDir, '..', 'somewhere-else.epub');
  try {
    const r = runExportStage({ runDir, metadata: METADATA, outputPath: dest, log: () => {} });
    assert.equal(r.epubPath, join(runDir, 'export/book.epub'));
    assert.ok(existsSync(r.epubPath), 'the canonical artifact was not written');
    assert.ok(existsSync(dest), 'the --output copy was not written');
    assert.deepEqual(readFileSync(dest), readFileSync(r.epubPath));
  } finally { cleanup(); }
});

test('--output pointing at the canonical path writes it once, not twice', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const canonical = join(runDir, 'export/book.epub');
    const r = runExportStage({ runDir, metadata: METADATA, outputPath: canonical, log: () => {} });
    assert.equal(r.outputPath, r.epubPath);
    assert.ok(existsSync(canonical));
  } finally { cleanup(); }
});

test('metadata is DERIVED from the run directory when the caller has none', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({ runDir, log: () => {} });
    const opf = unzipMap(r.zip).get('EPUB/package.opf')!.text();
    // Title from the book's own title block.
    assert.match(opf, /<dc:title>A Synthetic Book<\/dc:title>/);
    // Language from the tessdata the book was recognized with, not a default.
    assert.match(opf, /<dc:language>en<\/dc:language>/);
    // Identifier from the input hash: stable across re-exports, different per source.
    assert.match(opf, /<dc:identifier id="pub-id">urn:sha256:0{64}<\/dc:identifier>/);
  } finally { cleanup(); }
});

test('a derived title falls to the chapter, then the filename', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const blocks = readBlocks(runDir);
    // Drop the title block: the first chapter is the next best answer.
    const noTitle = blocks.blocks.filter(b => b.category !== 'title');
    writeArtifact(runDir, 'boxesBlocks', { calibration: blocks.calibration, blocks: noTitle });
    const meta = deriveMetadata(runDir, noTitle, new Map(noTitle.map(b => [b.id, ['Chapter One']])));
    assert.equal(meta.title, 'Chapter One');

    // With neither, the input filename — which run.json records as indent.pdf.
    const bodyOnly = noTitle.filter(b => b.category !== 'chapter');
    assert.equal(deriveMetadata(runDir, bodyOnly, new Map()).title, 'indent');
  } finally { cleanup(); }
});

test('a non-English tessdata pin produces a non-English dc:language', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const run = readRun(runDir);
    writeArtifact(runDir, 'run', { ...run, tesseract: { ...run.tesseract, tessdata: ['deu'] } });
    const r = runExportStage({ runDir, log: () => {} });
    assert.match(unzipMap(r.zip).get('EPUB/package.opf')!.text(), /<dc:language>de<\/dc:language>/);
  } finally { cleanup(); }
});
