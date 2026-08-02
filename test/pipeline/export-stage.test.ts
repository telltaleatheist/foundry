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
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExportStage, ExportStageError } from '../../src/pipeline/export-stage.js';
import { readBlocks, readScanLines, writeArtifact, artifactPath } from '../../src/pipeline/artifacts.js';
import { buildRun, runDirFor } from '../../fixtures/export/generate.js';
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
    const target = readBlocks(runDir).blocks.find(b => b.category === 'footnote')!;
    writeArtifact(runDir, 'footnoteDeletions', {
      blocks: [{ blockId: target.id, applied: [{ before: '1. A', after: 'A' }], rejected: 0, text: 'A footnote with its marker gone.' }],
    });
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /A footnote with its marker gone\./);
    assert.equal(prose(r.zip).includes('1. A footnote at the foot'), false);
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
