/**
 * A multi-line display heading arrives from block formation as SEVERAL
 * consecutive blocks — the gap splitter cannot see that three large-type lines
 * are one heading. The exporter must treat a same-page run of same-category
 * openers as ONE section, or every fragment becomes a garbage chapter (the
 * Barnett book shipped `FOR.` / `THE SOUL` / `OF THE` / `PEOPLE` as four
 * chapters before this rule existed).
 *
 * The page bound is part of the contract: a part divider on its own page ahead
 * of a chapter opening keeps its own TOC entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { calibrate, type CalibrationLine } from '../../src/paragraphs/calibration.js';
import { computeBlockGeometry } from '../../src/paragraphs/geometry.js';
import { writeArtifact, type Block, type ScanLine } from '../../src/pipeline/artifacts.js';
import type { BlocksCategory } from '../../src/blocks/encoder.js';
import { runExportStage } from '../../src/pipeline/export-stage.js';
import { unzipMap } from './unzip.js';

const DPI = 200;
const PAGE_W = 1240;
const PAGE_H = 1754;

/** One line per call, stacked down the page at a uniform pitch. */
function makeRun(runDir: string): void {
  const lines: ScanLine[] = [];
  const raw: Array<{ page: number; category: BlocksCategory; texts: string[] }> = [
    // Page 0: a three-block display heading, then prose.
    { page: 0, category: 'chapter', texts: ['Nationalism, Nazism, and'] },
    { page: 0, category: 'chapter', texts: ['the Churches:'] },
    { page: 0, category: 'chapter', texts: ['The Early Period'] },
    {
      page: 0, category: 'body', texts: [
        'The body of the chapter follows the heading and runs for long',
        'enough that the paragraph machinery has something to hold, and',
        'the calibration stage has the dozen lines of real geometry it',
        'refuses to work without. Every line here is set at the same',
        'pitch, so the measurements are boring on purpose.',
      ],
    },
    // Page 1: a part divider alone on its page.
    { page: 1, category: 'chapter', texts: ['OMENS'] },
    // Page 2: the next chapter — a different page, so a separate section.
    { page: 2, category: 'chapter', texts: ['The Lost Empire'] },
    {
      page: 2, category: 'body', texts: [
        'A second stretch of prose so the last section is a real one and',
        'not an empty spine item that a reader would refuse to open at',
        'all. It also feeds the calibration a few more uniform lines,',
        'which keeps the verdict machinery away from its minimums, and',
        'one extra so the advance count clears the floor as well.',
      ],
    },
  ];

  const blocks: Array<Omit<Block, 'geometry'>> = [];
  const yByPage = new Map<number, number>();
  for (const [i, r] of raw.entries()) {
    const ids: string[] = [];
    for (const text of r.texts) {
      const y = yByPage.get(r.page) ?? 200;
      yByPage.set(r.page, y + 44);
      const id = `l${String(lines.length + 1).padStart(4, '0')}`;
      lines.push({
        id, page: r.page, text, conf: 96,
        bbox: [180, y, 180 + Math.min(880, text.length * 18), y + 30],
      });
      ids.push(id);
    }
    const first = lines[lines.length - r.texts.length];
    const last = lines[lines.length - 1];
    blocks.push({
      id: `b${String(i + 1).padStart(4, '0')}`,
      page: r.page,
      bbox: [180, first.bbox[1], 1060, last.bbox[3]],
      lineIds: ids,
      category: r.category,
    });
  }

  const calLines: CalibrationLine[] = lines.map(l => ({ page: l.page, bbox: l.bbox }));
  const calibration = calibrate(calLines);
  const geometry = computeBlockGeometry(blocks as Block[], lines, calibration);
  const full: Block[] = blocks.map(b => ({ ...b, geometry: geometry.get(b.id)! }));

  writeArtifact(runDir, 'run', {
    runId: 'synthetic-heading-merge',
    createdAt: '1980-01-01T00:00:00Z',
    foundryVersion: 'fixture',
    input: { path: 'heading-merge.pdf', sha256: '0'.repeat(64), pages: 3 },
    tesseract: { version: '5.3.4', binarySha256: '0'.repeat(64), tessdata: ['eng'], dpi: DPI },
    models: { base: 'foundry:4b', blocks: 'foundry-blocks-v6-4b' },
    stages: {
      scan: { status: 'done' },
      blocks: { status: 'done' },
      ocr: { status: 'pending' },
      footnotes: { status: 'pending' },
      export: { status: 'pending' },
    },
  });
  writeArtifact(runDir, 'scanPages', {
    pages: [0, 1, 2].map(page => ({ page, widthPx: PAGE_W, heightPx: PAGE_H, deskewDeg: 0, dpi: DPI })),
  });
  writeArtifact(runDir, 'scanLines', { lines });
  writeArtifact(runDir, 'blocks', { calibration, blocks: full });
}

const METADATA = {
  title: 'Heading Merge',
  language: 'en',
  identifier: 'urn:uuid:00000000-0000-4000-8000-00000000face',
};

test('a same-page run of chapter blocks is one section with a joined label', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-heading-merge-'));
  try {
    const runDir = join(root, 'book');
    makeRun(runDir);
    const result = runExportStage({ runDir, metadata: METADATA, log: () => {} });

    const files = unzipMap(result.zip);
    const nav = files.get('EPUB/nav.xhtml')!.text();
    const labels = [...nav.matchAll(/<a href="[^"]+">([^<]+)<\/a>/g)].map(m => m[1]);

    assert.deepEqual(labels, [
      'Nationalism, Nazism, and the Churches: The Early Period',
      'OMENS',
      'The Lost Empire',
    ]);

    // The merged section carries all three heading fragments AND the prose.
    const first = files.get('EPUB/text/s0001.xhtml')!.text();
    for (const piece of ['Nationalism, Nazism, and', 'the Churches:', 'The Early Period', 'body of the chapter']) {
      assert.ok(first.includes(piece), `s0001 is missing ${JSON.stringify(piece)}`);
    }
    // The part divider did NOT swallow the chapter that follows it.
    assert.ok(files.get('EPUB/text/s0002.xhtml')!.text().includes('OMENS'));
    assert.ok(files.get('EPUB/text/s0003.xhtml')!.text().includes('The Lost Empire'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
