/**
 * footnotes --pdf: the markers come out of the text layer they are in.
 *
 * No model here — the generator is a stub that answers the way the trained one
 * does, `<anchor+marker> → <anchor>` — because what is being tested is the
 * document half: does the right text reach the model, does the rewrite land in
 * the text layer, and does the document still say everything it said apart from
 * the markers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PDFDocument } from '@cantoo/pdf-lib';

import { DEFAULT_PALETTE } from '../../src/pdf/annotations.js';
import { extractDocument } from '../../src/pdf/extract.js';
import { runPdfFootnotes } from '../../src/pipeline/footnotes-document.js';
import { writeBlockLayer, type ClassifiedBlock } from '../../src/pipeline/blocks-document.js';
import { runEmbeddedScanStage, runGetTextStage } from '../../src/pipeline/document-stage.js';
import { readScanLines, readScanPages, writeArtifact } from '../../src/pipeline/artifacts.js';
import type { Box } from '../../src/scan/bands.js';

const DPI = 200;
const WIDTH_PT = 612;
const HEIGHT_PT = 792;
const WIDTH_PX = Math.round((WIDTH_PT * DPI) / 72);
const HEIGHT_PX = Math.round((HEIGHT_PT * DPI) / 72);

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-fnpdf-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const quiet = (): void => {};

/** The lines of the fixture book, page by page. */
const PAGES: string[][] = [
  [
    'A HISTORY OF THE REICH',
    'The treaty collapsed in the spring.47 It had never been',
    'ratified by anyone who mattered, and the Chancellor knew it.',
    'The Reichstag met twice that year.48 Neither session',
    'produced anything that could be called a decision.',
    'A fifth line of ordinary prose with no markers in it at all.',
    '104',
  ],
  [
    'A HISTORY OF THE REICH',
    'By the autumn the question was settled.49 Nobody in Berlin',
    'expected the settlement to hold beyond the winter.',
    'A third line of ordinary prose with no markers in it.',
    'A fourth line of ordinary prose with no markers in it.',
    'A fifth line of ordinary prose with no markers in it.',
    '105',
  ],
];

/**
 * A stub footnotes model.
 *
 * Answers with the contract's own shape: for every line carrying a digit run
 * welded onto a word, `<anchor+marker> → <anchor>`; otherwise `none`.
 */
async function stubModel(prompts: readonly string[]): Promise<string[]> {
  return prompts.map(prompt => {
    const unit = /<\|im_start\|>user\n([\s\S]*?)<\|im_end\|>/.exec(prompt)?.[1] ?? '';
    const lines: string[] = [];
    for (const match of unit.matchAll(/(\w+\.)(\d{2})(?=\s|$)/g)) {
      lines.push(`${match[1]}${match[2]} → ${match[1]}`);
    }
    return lines.length > 0 ? lines.join('\n') : 'none';
  });
}

/** A scanned working document carrying PAGES, with a block layer on it. */
async function scannedDocument(dir: string): Promise<string> {
  const source = join(dir, 'scan.pdf');
  const working = join(dir, 'working.pdf');
  const runDir = join(dir, 'run');

  const blank = await PDFDocument.create();
  for (let i = 0; i < PAGES.length; i++) blank.addPage([WIDTH_PT, HEIGHT_PT]);
  writeFileSync(source, await blank.save());

  writeArtifact(runDir, 'run', {
    runId: 'r', createdAt: 'c', foundryVersion: 't',
    input: { path: 'pages', sha256: '0'.repeat(64), pages: PAGES.length },
    segmenter: { kind: 'tesseract', version: '5.3.4', binarySha256: 'x', tessdata: ['eng'], dpi: DPI },
    models: {},
    stages: {
      scan: { status: 'done' }, blocks: { status: 'pending' }, ocr: { status: 'pending' },
      footnotes: { status: 'pending' }, export: { status: 'pending' },
    },
  });
  writeArtifact(runDir, 'scanPages', {
    pages: PAGES.map((_, page) => ({ page, widthPx: WIDTH_PX, heightPx: HEIGHT_PX, deskewDeg: 0, dpi: DPI })),
  });
  writeArtifact(runDir, 'scanLines', {
    lines: PAGES.flatMap((page, p) => page.map((text, i) => ({
      id: `p${String(p).padStart(4, '0')}l${String(i).padStart(4, '0')}`,
      page: p,
      bbox: [300, 300 + i * 120, 300 + text.length * 20, 380 + i * 120] as Box,
      text,
      conf: 90,
    }))),
  });

  await runGetTextStage({ pdfPath: source, runDir, outPath: working, log: quiet });

  const scanPages = readScanPages(runDir).pages;
  const scanLines = readScanLines(runDir).lines;
  // The first line of each page is a running head, the last a folio, the rest
  // body — one block per line, so a rewritten block is a rewritten line.
  const blocks: ClassifiedBlock[] = scanLines.map(line => {
    const index = Number(line.id.slice(-4));
    return {
      id: `p${String(line.page).padStart(4, '0')}b${String(index).padStart(3, '0')}`,
      page: line.page,
      bbox: line.bbox,
      lineIds: [line.id],
      category: index === 0 ? 'header' : index === PAGES[line.page].length - 1 ? 'footer' : 'body',
    };
  });
  await writeBlockLayer({
    pdfPath: working, blocks, lines: scanLines, pages: scanPages,
    pitchPx: 120, palette: DEFAULT_PALETTE, log: quiet,
  });
  return working;
}

test('the markers come out of the text layer, and nothing else moves', async () => {
  const { dir, done } = scratch();
  try {
    const working = await scannedDocument(dir);
    const before = statSync(working).size;

    const { report, boundary } = await runPdfFootnotes({
      pdfPath: working, dryRun: false, model: 'stub', generate: stubModel, log: quiet,
    });

    assert.equal(report.totals.applied, 3);
    assert.equal(report.totals.rejected, 0);
    assert.equal(report.totals.blocksEdited, 3);
    assert.equal(report.totals.linesRewritten, 3);
    // Running heads and folios are never asked about.
    assert.equal(report.totals.blocks, PAGES.flat().length);
    assert.equal(report.totals.prose, PAGES.flat().length - 4);

    // An incremental update: the file grew, and it grew by a fraction of itself.
    assert.ok(boundary !== null && boundary > before);
    assert.ok(boundary - before < before, 'the update rewrote the document instead of appending');
    assert.equal(statSync(working).size, boundary);

    const extracted = await extractDocument(new Uint8Array(readFileSync(working)), { dpi: DPI });
    const text = extracted.pages.map(p => p.lines.map(l => l.text));
    assert.equal(text[0][1], 'The treaty collapsed in the spring. It had never been');
    assert.equal(text[0][3], 'The Reichstag met twice that year. Neither session');
    assert.equal(text[1][1], 'By the autumn the question was settled. Nobody in Berlin');
    // Every other line is exactly what it was.
    assert.equal(text[0][0], PAGES[0][0]);
    assert.equal(text[0][2], PAGES[0][2]);
    assert.equal(text[0][6], PAGES[0][6]);
    assert.equal(text[1][5], PAGES[1][5]);

    // The report says where each one was, in the book's own words.
    assert.match(report.applied[0].context, /\[REMOVED: "47"\]/);
    assert.equal(report.applied[0].category, 'body');
  } finally {
    done();
  }
});

test('--dry-run writes the report and leaves the document alone', async () => {
  const { dir, done } = scratch();
  try {
    const working = await scannedDocument(dir);
    const before = readFileSync(working);

    const { report, boundary } = await runPdfFootnotes({
      pdfPath: working, dryRun: true, model: 'stub', generate: stubModel, log: quiet,
    });

    assert.equal(report.totals.applied, 3);
    assert.equal(report.dryRun, true);
    assert.equal(boundary, null);
    assert.deepEqual(new Uint8Array(readFileSync(working)), new Uint8Array(before));
  } finally {
    done();
  }
});

test('a text-class document is refused, and told where to go instead', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'book.pdf');
    const working = join(dir, 'working.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([WIDTH_PT, HEIGHT_PT]);
    page.drawText('The treaty collapsed in the spring.47', { x: 72, y: 700, size: 12 });
    writeFileSync(source, await doc.save());
    await runEmbeddedScanStage({ pdfPath: source, runDir: join(dir, 'run'), outPath: working, log: quiet });

    await assert.rejects(
      () => runPdfFootnotes({
        pdfPath: working, dryRun: false, model: 'stub', generate: stubModel, log: quiet,
      }),
      /text-class working document.*footnotes --epub/s,
    );
  } finally {
    done();
  }
});

test('a document with no block layer is refused — prose is a category', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'scan.pdf');
    const working = join(dir, 'working.pdf');
    const runDir = join(dir, 'run');
    const blank = await PDFDocument.create();
    blank.addPage([WIDTH_PT, HEIGHT_PT]);
    writeFileSync(source, await blank.save());
    writeArtifact(runDir, 'run', {
      runId: 'r', createdAt: 'c', foundryVersion: 't',
      input: { path: 'pages', sha256: '0'.repeat(64), pages: 1 },
      segmenter: { kind: 'tesseract', version: '5.3.4', binarySha256: 'x', tessdata: ['eng'], dpi: DPI },
      models: {},
      stages: {
        scan: { status: 'done' }, blocks: { status: 'pending' }, ocr: { status: 'pending' },
        footnotes: { status: 'pending' }, export: { status: 'pending' },
      },
    });
    writeArtifact(runDir, 'scanPages', {
      pages: [{ page: 0, widthPx: WIDTH_PX, heightPx: HEIGHT_PX, deskewDeg: 0, dpi: DPI }],
    });
    writeArtifact(runDir, 'scanLines', {
      lines: [{ id: 'p0000l0000', page: 0, bbox: [300, 300, 1200, 380] as Box, text: 'A line.47', conf: 90 }],
    });
    await runGetTextStage({ pdfPath: source, runDir, outPath: working, log: quiet });

    await assert.rejects(
      () => runPdfFootnotes({
        pdfPath: working, dryRun: false, model: 'stub', generate: stubModel, log: quiet,
      }),
      /no block annotations.*foundry blocks/s,
    );
  } finally {
    done();
  }
});
