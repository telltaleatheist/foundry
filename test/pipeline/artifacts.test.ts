/**
 * The run directory is an API with an external consumer (BookForge reads
 * `blocks/blocks.json` to paint pdf-picker's category layer), so these tests are
 * about the two properties that make it safe to depend on: a version gate that
 * REFUSES rather than misreads, and validation that names the bad field.
 *
 * The negative cases carry the weight. Every one of them is a way a malformed
 * artifact could otherwise be read as a plausible book.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ARTIFACTS, ArtifactError, ArtifactVersionError,
  artifactPath, epubPath, hasArtifact,
  parseBlocks, parseExclusions, parseFootnoteDeletions, parseOcrLines,
  parseRun, parseScanLines, parseScanPages,
  readBlocks, readExclusions, readFootnoteDeletions, readOcrLines,
  readRun, readScanLines, readScanPages,
  writeArtifact,
  type ArtifactName, type BlocksArtifact, type CalibrationVerdict,
} from '../../src/pipeline/artifacts.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'foundry-artifacts-'));
}

/** Write a raw JSON body straight into a run directory, bypassing the writer. */
function put(runDir: string, name: ArtifactName, body: unknown): void {
  const p = artifactPath(runDir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body), 'utf8');
}

const CALIBRATION: CalibrationVerdict = {
  convention: 'indent',
  degraded: false,
  bodyHeight: 28,
  pitch: 40,
  flushLeft: 200,
  measure: 800,
  bodyRight: 1000,
  indent: { separation: 1.5, upperShare: 0.2, threshold: 0.75, samples: 300, fired: true, why: 'ok' },
  gap: { separation: 0.01, upperShare: 0, threshold: 1, samples: 300, fired: false, why: 'flat' },
  message: 'Indent convention.',
};

const BLOCKS: Omit<BlocksArtifact, 'formatVersion'> = {
  calibration: CALIBRATION,
  blocks: [
    {
      id: 'b1', page: 0, bbox: [200, 100, 1000, 240], lineIds: ['l1', 'l2'], category: 'body',
      geometry: { firstLineIndent: 1.5, gapAbove: null, prevLineShort: false, prevEndsWrapHyphen: false },
    },
    {
      id: 'b2', page: 0, bbox: [200, 260, 1000, 400], lineIds: ['l3'], category: 'body',
      continues: { value: true, confidence: 0.9 },
      geometry: { firstLineIndent: 0.02, gapAbove: 1.0, prevLineShort: false, prevEndsWrapHyphen: true },
    },
  ],
};

// ── round trips ─────────────────────────────────────────────────────────────

test('every artifact round-trips through the writer and its reader', () => {
  const dir = scratch();
  try {
    writeArtifact(dir, 'run', {
      runId: 'r1', createdAt: '2026-08-01T00:00:00Z', foundryVersion: '0.1.0',
      input: { path: 'in.pdf', sha256: 'abc', pages: 3 },
      tesseract: { version: '5.3.4', binarySha256: 'def', tessdata: ['eng'], dpi: 200 },
      models: { base: 'foundry:4b', blocks: 'foundry-blocks-v1-4b' },
      stages: {
        scan: { status: 'done', startedAt: 'a', finishedAt: 'b' },
        blocks: { status: 'done' },
        ocr: { status: 'pending' },
        footnotes: { status: 'pending' },
        export: { status: 'failed', error: 'no blocks survived the exclusions' },
      },
    });
    const run = readRun(dir);
    assert.equal(run.formatVersion, ARTIFACTS.run.version);
    assert.equal(run.input.pages, 3);
    assert.equal(run.tesseract.dpi, 200);
    assert.equal(run.models.blocks, 'foundry-blocks-v1-4b');
    assert.equal(run.stages.export.error, 'no blocks survived the exclusions');
    assert.equal(run.stages.ocr.status, 'pending');

    writeArtifact(dir, 'scanPages', {
      pages: [{ page: 0, widthPx: 1200, heightPx: 1800, deskewDeg: 0.4, dpi: 200 }],
    });
    assert.equal(readScanPages(dir).pages[0].widthPx, 1200);

    writeArtifact(dir, 'scanLines', {
      lines: [
        { id: 'l1', page: 0, bbox: [200, 100, 980, 128], text: 'A line.', conf: 92.5, wordConfidences: [93, 92], psm: 7 },
        { id: 'l2', page: 0, bbox: [200, 140, 700, 168], text: 'blank', conf: null },
      ],
    });
    const lines = readScanLines(dir);
    assert.equal(lines.lines[0].wordConfidences?.length, 2);
    assert.equal(lines.lines[1].conf, null);

    writeArtifact(dir, 'blocks', BLOCKS);
    const blocks = readBlocks(dir);
    assert.equal(blocks.blocks.length, 2);
    assert.equal(blocks.blocks[1].continues?.value, true);
    assert.equal(blocks.blocks[0].geometry.gapAbove, null);
    assert.equal(blocks.calibration.convention, 'indent');

    writeArtifact(dir, 'ocrLines', {
      lines: [{
        id: 'l1', text: 'A line.',
        edits: [{ before: 'À', after: 'A' }],
        rejected: [{ before: 'ghost', why: 'not present in the block' }],
      }],
    });
    const ocr = readOcrLines(dir);
    assert.equal(ocr.lines[0].edits[0].after, 'A');
    assert.equal(ocr.lines[0].rejected[0].why, 'not present in the block');

    writeArtifact(dir, 'footnoteDeletions', {
      blocks: [{ blockId: 'b1', applied: [{ before: 'Germany.*', after: 'Germany.' }], rejected: 2, text: 'Germany.' }],
    });
    assert.equal(readFootnoteDeletions(dir).blocks[0].rejected, 2);

    writeArtifact(dir, 'exportExclusions', {
      excludedCategories: ['footnote'], excludedBlockIds: ['b9'],
      neverEmittedCategories: ['header', 'footer', 'discard'],
      droppedByCategory: { footnote: 4 }, droppedByNeverEmitted: { header: 12 },
      droppedById: 1, totalBlocks: 40, keptBlocks: 23,
    });
    const ex = readExclusions(dir);
    assert.equal(ex.droppedByCategory['footnote'], 4);
    assert.equal(ex.keptBlocks, 23);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the writer serializes formatVersion first, and always its own', () => {
  const dir = scratch();
  try {
    // A caller trying to stamp a version it does not implement is overruled.
    writeArtifact(dir, 'scanPages', { formatVersion: 99, pages: [] } as never);
    const raw = readFileSync(artifactPath(dir, 'scanPages'), 'utf8');
    assert.ok(raw.startsWith('{\n  "formatVersion": 1'), raw.slice(0, 40));
    assert.equal(readScanPages(dir).formatVersion, 1);
    assert.ok(raw.endsWith('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes are atomic: no temp file is left behind', () => {
  const dir = scratch();
  try {
    writeArtifact(dir, 'scanPages', { pages: [] });
    assert.equal(existsSync(`${artifactPath(dir, 'scanPages')}.tmp`), false);
    assert.equal(hasArtifact(dir, 'scanPages'), true);
    assert.equal(hasArtifact(dir, 'blocks'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths follow the documented layout', () => {
  assert.equal(artifactPath('/r', 'blocks'), '/r/blocks/blocks.json');
  assert.equal(artifactPath('/r', 'scanLines'), '/r/scan/lines.json');
  assert.equal(artifactPath('/r', 'exportExclusions'), '/r/export/exclusions.json');
  assert.equal(epubPath('/r'), '/r/export/book.epub');
});

// ── the version gate ────────────────────────────────────────────────────────

test('an unknown formatVersion is REFUSED, naming the file and both versions', () => {
  const dir = scratch();
  try {
    put(dir, 'blocks', { ...BLOCKS, formatVersion: 2 });
    assert.throws(() => readBlocks(dir), (e: unknown) => {
      assert.ok(e instanceof ArtifactVersionError);
      assert.equal(e.found, 2);
      assert.equal(e.expected, 1);
      assert.match(e.message, /blocks\/blocks\.json/);
      assert.match(e.message, /version 1/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a MISSING formatVersion is refused too — no "version 1 means unversioned"', () => {
  const body: Record<string, unknown> = { ...BLOCKS };
  assert.throws(() => parseBlocks(JSON.stringify(body)), ArtifactVersionError);
});

test('the version gate runs before any field is read', () => {
  // Nothing in this body is valid except the version, which is wrong. The
  // version error must be what surfaces, not a field error from deeper in.
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 7, blocks: 'not an array' })),
    ArtifactVersionError,
  );
});

// ── validation names the bad thing ──────────────────────────────────────────

test('a missing artifact names its path and what produces it', () => {
  const dir = scratch();
  try {
    assert.throws(() => readBlocks(dir), (e: unknown) => {
      assert.ok(e instanceof ArtifactError);
      assert.match(e.message, /blocks\/blocks\.json: not found/);
      assert.match(e.message, /run the stage that produces it/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid JSON says so rather than throwing a SyntaxError', () => {
  assert.throws(() => parseRun('{ not json'), (e: unknown) => {
    assert.ok(e instanceof ArtifactError);
    assert.match(e.message, /run\.json: is not valid JSON/);
    return true;
  });
});

test('a bad field is named by its exact path', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  (bad['blocks'] as Array<Record<string, unknown>>)[1]['geometry'] = {
    firstLineIndent: 0, gapAbove: 'soon', prevLineShort: false, prevEndsWrapHyphen: false,
  };
  assert.throws(() => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })), (e: unknown) => {
    assert.match((e as Error).message, /blocks\[1\]\.geometry\.gapAbove must be a finite number/);
    return true;
  });
});

test('a missing required field is not defaulted', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  delete ((bad['blocks'] as Array<Record<string, unknown>>)[0]['geometry'] as Record<string, unknown>)['prevLineShort'];
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })),
    /blocks\[0\]\.geometry\.prevLineShort must be a boolean/,
  );
});

test('an illegal category is refused and the legal list is printed', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  (bad['blocks'] as Array<Record<string, unknown>>)[0]['category'] = 'front_matter';
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })),
    /is not a blocks category .*discard/s,
  );
});

test('duplicate block ids are refused — the id is the exclusion key', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  (bad['blocks'] as Array<Record<string, unknown>>)[1]['id'] = 'b1';
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })),
    /blocks\[1\]\.id "b1" is a duplicate/,
  );
});

test('duplicate line ids are refused — the id is a key too', () => {
  assert.throws(() => parseScanLines(JSON.stringify({
    formatVersion: 1,
    lines: [
      { id: 'l1', page: 0, bbox: [0, 0, 1, 1], text: 'a', conf: null },
      { id: 'l1', page: 0, bbox: [0, 2, 1, 3], text: 'b', conf: null },
    ],
  })), /lines\[1\]\.id "l1" is a duplicate/);
});

test('an inverted bbox is refused, with the box printed', () => {
  assert.throws(() => parseScanLines(JSON.stringify({
    formatVersion: 1,
    lines: [{ id: 'l1', page: 0, bbox: [900, 0, 200, 30], text: 'a', conf: null }],
  })), /lines\[0\]\.bbox is inverted: \[900,0,200,30\]/);
});

test('a bbox of the wrong arity is refused', () => {
  assert.throws(() => parseScanLines(JSON.stringify({
    formatVersion: 1,
    lines: [{ id: 'l1', page: 0, bbox: [0, 0, 1], text: 'a', conf: null }],
  })), /must be \[x0,y0,x1,y1\], found 3 entries/);
});

test('an absent conf is refused, but a null one is kept', () => {
  assert.throws(() => parseScanLines(JSON.stringify({
    formatVersion: 1, lines: [{ id: 'l1', page: 0, bbox: [0, 0, 1, 1], text: 'a' }],
  })), /lines\[0\]\.conf must be a finite number/);
  const ok = parseScanLines(JSON.stringify({
    formatVersion: 1, lines: [{ id: 'l1', page: 0, bbox: [0, 0, 1, 1], text: 'a', conf: null }],
  }));
  assert.equal(ok.lines[0].conf, null);
});

test('calibration cannot claim degraded without the none verdict', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  (bad['calibration'] as Record<string, unknown>)['degraded'] = true;
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })),
    /degraded is true but convention is "indent"/,
  );
});

test('a none verdict must admit it is degraded', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  (bad['calibration'] as Record<string, unknown>)['convention'] = 'none';
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })),
    /degraded is false but convention is "none"/,
  );
});

test('a continues confidence outside 0..1 is refused', () => {
  const bad = structuredClone(BLOCKS) as Record<string, unknown>;
  (bad['blocks'] as Array<Record<string, unknown>>)[1]['continues'] = { value: true, confidence: 1.4 };
  assert.throws(
    () => parseBlocks(JSON.stringify({ formatVersion: 1, ...bad })),
    /continues\.confidence is 1\.4, expected 0\.\.1/,
  );
});

test('a failed stage with no message is refused', () => {
  const stages = {
    scan: { status: 'done' }, blocks: { status: 'done' }, ocr: { status: 'done' },
    footnotes: { status: 'done' }, export: { status: 'failed' },
  };
  assert.throws(() => parseRun(JSON.stringify({
    formatVersion: 1, runId: 'r', createdAt: 'c', foundryVersion: '0',
    input: { path: 'p', sha256: 's', pages: 1 },
    tesseract: { version: 'v', binarySha256: 'b', tessdata: [], dpi: 200 },
    models: {}, stages,
  })), /stages\.export is 'failed' with no error message/);
});

test('a pre-rename run directory is refused by name, not by a bare missing field', () => {
  // The `boxes` stage became `blocks` pre-release, with no compatibility arm.
  // The old key must produce a message that says so — the failure a stranger
  // meets is otherwise "stages.blocks must be an object, found undefined",
  // which names neither the cause nor the fix.
  const stages = {
    scan: { status: 'done' }, boxes: { status: 'done' }, ocr: { status: 'done' },
    footnotes: { status: 'done' }, export: { status: 'done' },
  };
  assert.throws(() => parseRun(JSON.stringify({
    formatVersion: 1, runId: 'r', createdAt: 'c', foundryVersion: '0',
    input: { path: 'p', sha256: 's', pages: 1 },
    tesseract: { version: 'v', binarySha256: 'b', tessdata: [], dpi: 200 },
    models: { boxes: 'foundry-boxes-v6-4b' }, stages,
  })), /stages\.boxes is present.*rename of the `boxes` stage to `blocks`.*Start a fresh run/s);
});

test('an unknown stage status is refused and the legal set printed', () => {
  const stages = {
    scan: { status: 'skipped' }, blocks: { status: 'done' }, ocr: { status: 'done' },
    footnotes: { status: 'done' }, export: { status: 'done' },
  };
  assert.throws(() => parseRun(JSON.stringify({
    formatVersion: 1, runId: 'r', createdAt: 'c', foundryVersion: '0',
    input: { path: 'p', sha256: 's', pages: 1 },
    tesseract: { version: 'v', binarySha256: 'b', tessdata: [], dpi: 200 },
    models: {}, stages,
  })), /stages\.scan\.status is "skipped", expected one of pending, running, done, failed/);
});

test('the other parsers validate their own shapes', () => {
  assert.throws(() => parseScanPages(JSON.stringify({ formatVersion: 1, pages: {} })),
    /pages must be an array, found object/);
  assert.throws(() => parseOcrLines(JSON.stringify({
    formatVersion: 1, lines: [{ id: 'l', text: 't', edits: [{ before: 'a' }], rejected: [] }],
  })), /lines\[0\]\.edits\[0\]\.after must be a string/);
  assert.throws(() => parseFootnoteDeletions(JSON.stringify({
    formatVersion: 1, blocks: [{ blockId: 'b', applied: [], rejected: 'two', text: '' }],
  })), /blocks\[0\]\.rejected must be a finite number/);
  assert.throws(() => parseExclusions(JSON.stringify({
    formatVersion: 1, excludedCategories: ['a'], excludedBlockIds: [],
    neverEmittedCategories: [], droppedByCategory: { a: 'four' }, droppedByNeverEmitted: {},
    droppedById: 0, totalBlocks: 1, keptBlocks: 1,
  })), /droppedByCategory\.a must be a finite number/);
});
