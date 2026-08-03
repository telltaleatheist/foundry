/**
 * A run directory built from a page script, for tests about STRUCTURE.
 *
 * The export fixtures in `fixtures/export/` are one book laid out three ways,
 * which is the right shape for the paragraph rules and the wrong shape for
 * questions about the front of the book — those need a page that carries
 * nothing but a title, or a chapter that starts on page 3. So this builds a run
 * directory from a list of blocks-per-page.
 *
 * The geometry is generated but not faked: lines are stacked at a uniform
 * pitch and the block facts come from the production `calibrate()` and
 * `computeBlockGeometry()`, exactly as the fixture generator does it.
 */
import { calibrate, type CalibrationLine } from '../../src/paragraphs/calibration.js';
import { computeBlockGeometry } from '../../src/paragraphs/geometry.js';
import { writeArtifact, type Block, type ScanLine } from '../../src/pipeline/artifacts.js';
import type { BlocksCategory } from '../../src/blocks/encoder.js';

const DPI = 200;
const PAGE_W = 1240;
const PAGE_H = 1754;

/** One block: a category and its lines, on a page. */
export interface SyntheticBlock {
  page: number;
  category: BlocksCategory;
  texts: string[];
}

export function buildSyntheticRun(runDir: string, script: readonly SyntheticBlock[]): void {
  const lines: ScanLine[] = [];
  const blocks: Array<Omit<Block, 'geometry'>> = [];
  const yByPage = new Map<number, number>();

  for (const [i, entry] of script.entries()) {
    const ids: string[] = [];
    for (const text of entry.texts) {
      const y = yByPage.get(entry.page) ?? 200;
      yByPage.set(entry.page, y + 44);
      const id = `l${String(lines.length + 1).padStart(4, '0')}`;
      lines.push({
        id, page: entry.page, text, conf: 96,
        bbox: [180, y, 180 + Math.min(880, text.length * 18), y + 30],
      });
      ids.push(id);
    }
    const first = lines[lines.length - entry.texts.length];
    const last = lines[lines.length - 1];
    blocks.push({
      id: `b${String(i + 1).padStart(4, '0')}`,
      page: entry.page,
      bbox: [180, first.bbox[1], 1060, last.bbox[3]],
      lineIds: ids,
      category: entry.category,
    });
  }

  const calLines: CalibrationLine[] = lines.map(l => ({ page: l.page, bbox: l.bbox }));
  const calibration = calibrate(calLines);
  const geometry = computeBlockGeometry(blocks as Block[], lines, calibration);
  const full: Block[] = blocks.map(b => ({ ...b, geometry: geometry.get(b.id)! }));
  const pages = Math.max(...script.map(s => s.page)) + 1;

  writeArtifact(runDir, 'run', {
    runId: 'synthetic-structure',
    createdAt: '1980-01-01T00:00:00Z',
    foundryVersion: 'fixture',
    input: { path: 'structure.pdf', sha256: '0'.repeat(64), pages },
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
    pages: Array.from({ length: pages }, (_, page) => ({
      page, widthPx: PAGE_W, heightPx: PAGE_H, deskewDeg: 0, dpi: DPI,
    })),
  });
  writeArtifact(runDir, 'scanLines', { lines });
  writeArtifact(runDir, 'blocks', { calibration, blocks: full });
}

/** Enough prose that calibration has real lines to measure. */
export const PROSE = [
  'The body of the chapter follows the heading and runs for long',
  'enough that the paragraph machinery has something to hold, and',
  'the calibration stage has the dozen lines of real geometry it',
  'refuses to work without. Every line here is set at the same',
  'pitch, so the measurements are boring on purpose.',
];

export const MORE_PROSE = [
  'A second stretch of prose so the last section is a real one and',
  'not an empty spine item that a reader would refuse to open at',
  'all. It also feeds the calibration a few more uniform lines,',
  'which keeps the verdict machinery away from its minimums, and',
  'one extra so the advance count clears the floor as well.',
];

export const METADATA = {
  title: 'A Structured Book',
  language: 'en',
  identifier: 'urn:uuid:00000000-0000-4000-8000-0000000000ab',
};
