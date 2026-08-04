/**
 * Casting the working document, by both routes.
 *
 * The two stages are opposites — one writes text INTO a book that has none, the
 * other reads text OUT of a book that has it — and they meet at one place: the
 * working document. So the tests check the same three things of both. Does the
 * document carry what it is (the class, which decides whether a model is
 * pointed at the book)? Does the geometry survive the trip into the PDF's frame
 * and back? And is the original still the original?
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

import { runEmbeddedScanStage, runGetTextStage } from '../../src/pipeline/document-stage.js';
import { readMarker } from '../../src/pdf/document.js';
import { extractDocument } from '../../src/pdf/extract.js';
import { ARTIFACTS, readRun, readScanLines, readScanPages, writeArtifact } from '../../src/pipeline/artifacts.js';

const DPI = 200;
const WIDTH_PT = 612;
const HEIGHT_PT = 792;
const WIDTH_PX = Math.round((WIDTH_PT * DPI) / 72);
const HEIGHT_PX = Math.round((HEIGHT_PT * DPI) / 72);

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-docstage-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const quiet = (): void => {};

/** A PDF with real, selectable text on it — the `text` class's input. */
async function textPdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([WIDTH_PT, HEIGHT_PT]);
    page.setFont(font);
    page.drawText(`Chapter ${i + 1}`, { x: 72, y: 700, size: 18 });
    page.drawText('The treaty collapsed in the spring.', { x: 72, y: 660, size: 12 });
    page.drawText('It had never been ratified.', { x: 72, y: 640, size: 12 });
  }
  writeFileSync(path, await doc.save());
}

/** A PDF with no text at all — a stand-in for a scan. */
async function blankPdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([WIDTH_PT, HEIGHT_PT]);
  writeFileSync(path, await doc.save());
}

/** A run directory as `foundry scan --pages` would leave it. */
function scanArtifacts(runDir: string, pages: number, linesPerPage: string[][]): void {
  writeArtifact(runDir, 'run', {
    runId: 'test', createdAt: '2026-08-03T00:00:00Z', foundryVersion: 'test',
    input: { path: 'pages', sha256: '0'.repeat(64), pages },
    segmenter: { kind: 'tesseract', version: '5.3.4', binarySha256: 'x', tessdata: ['eng'], dpi: DPI },
    models: {},
    stages: {
      scan: { status: 'done' }, blocks: { status: 'pending' }, ocr: { status: 'pending' },
      footnotes: { status: 'pending' }, export: { status: 'pending' },
    },
  });
  writeArtifact(runDir, 'scanPages', {
    pages: Array.from({ length: pages }, (_, page) => ({
      page, widthPx: WIDTH_PX, heightPx: HEIGHT_PX, deskewDeg: 0, dpi: DPI,
    })),
  });
  writeArtifact(runDir, 'scanLines', {
    lines: linesPerPage.flatMap((texts, page) => texts.map((text, i) => ({
      id: `p${String(page).padStart(4, '0')}l${String(i).padStart(4, '0')}`,
      page,
      bbox: [300, 300 + i * 60, 300 + text.length * 24, 340 + i * 60] as [number, number, number, number],
      text,
      conf: 92,
    }))),
  });
}

// ── get-text ────────────────────────────────────────────────────────────────

test('get-text writes the scan\'s lines into the PDF, and they come back out', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'original.pdf');
    const out = join(dir, 'working.pdf');
    const runDir = join(dir, 'run');
    await blankPdf(source, 2);
    const texts = [
      ['Working Towards the Führer', 'the treaty col—lapsed “quietly”'],
      ['ﬁnally, a second page'],
    ];
    scanArtifacts(runDir, 2, texts);

    const result = await runGetTextStage({ pdfPath: source, runDir, outPath: out, log: quiet });
    assert.equal(result.pages, 2);
    assert.equal(result.lines, 3);
    assert.equal(result.language, 'eng');

    // The document says what it is.
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(out)));
    const marker = readMarker(doc);
    assert.equal(marker.documentClass, 'scanned');
    assert.equal(marker.language, 'eng');
    assert.equal(marker.dpi, DPI);

    // And the text is really in it, character for character.
    const extracted = await extractDocument(new Uint8Array(readFileSync(out)), { dpi: DPI });
    assert.deepEqual(extracted.pages.map(p => p.lines.map(l => l.text)), texts);

    // In the frame it was written in, to within the round trip through points.
    const scanned = readScanLines(runDir).lines;
    const first = extracted.pages[0].lines[0];
    for (let k = 0; k < 4; k++) {
      assert.ok(Math.abs(first.box[k] - scanned[0].bbox[k]) < 1,
        `box[${k}] came back as ${first.box[k]}, was written as ${scanned[0].bbox[k]}`);
    }

    // The original is untouched: it still has no text in it.
    const original = await extractDocument(new Uint8Array(readFileSync(source)), { dpi: DPI });
    assert.equal(original.pages.reduce((n, p) => n + p.lines.length, 0), 0);
  } finally {
    done();
  }
});

test('get-text refuses to write over the book it was given', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'original.pdf');
    const runDir = join(dir, 'run');
    await blankPdf(source, 1);
    scanArtifacts(runDir, 1, [['a line']]);
    await assert.rejects(
      () => runGetTextStage({ pdfPath: source, runDir, outPath: source, log: quiet }),
      /--out is the input PDF/,
    );
  } finally {
    done();
  }
});

test('get-text refuses a scan of a different document', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'original.pdf');
    const runDir = join(dir, 'run');
    await blankPdf(source, 2);
    scanArtifacts(runDir, 3, [['a'], ['b'], ['c']]);
    await assert.rejects(
      () => runGetTextStage({ pdfPath: source, runDir, outPath: join(dir, 'out.pdf'), log: quiet }),
      /has 2 pages and the scan has 3/,
    );
    assert.equal(existsSync(join(dir, 'out.pdf')), false, 'a failed stage writes nothing');
  } finally {
    done();
  }
});

test('get-text refuses a render made at the wrong resolution', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'original.pdf');
    const runDir = join(dir, 'run');
    await blankPdf(source, 1);
    scanArtifacts(runDir, 1, [['a line']]);
    // 300 dpi renders against a pipeline pinned to 200.
    writeArtifact(runDir, 'scanPages', {
      pages: [{
        page: 0,
        widthPx: Math.round((WIDTH_PT * 300) / 72),
        heightPx: Math.round((HEIGHT_PT * 300) / 72),
        deskewDeg: 0,
        dpi: DPI,
      }],
    });
    await assert.rejects(
      () => runGetTextStage({ pdfPath: source, runDir, outPath: join(dir, 'out.pdf'), log: quiet }),
      /rendered at 300\.0 dpi, and the pipeline is pinned to 200 dpi/,
    );
  } finally {
    done();
  }
});

test('get-text refuses a run that never met Tesseract', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'original.pdf');
    const runDir = join(dir, 'run');
    await blankPdf(source, 1);
    scanArtifacts(runDir, 1, [['a line']]);
    const run = readRun(runDir);
    writeArtifact(runDir, 'run', {
      ...run,
      segmenter: { kind: 'embedded-text', extractor: 'x', language: null, dpi: DPI },
    });
    await assert.rejects(
      () => runGetTextStage({ pdfPath: source, runDir, outPath: join(dir, 'out.pdf'), log: quiet }),
      /was scanned by embedded-text, not Tesseract/,
    );
  } finally {
    done();
  }
});

// ── scan --pdf ──────────────────────────────────────────────────────────────

test('scan --pdf emits the same artifacts a Tesseract scan does, and casts the document', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'book.pdf');
    const out = join(dir, 'working.pdf');
    const runDir = join(dir, 'run');
    await textPdf(source, 3);

    const result = await runEmbeddedScanStage({ pdfPath: source, runDir, outPath: out, log: quiet });
    assert.equal(result.pages, 3);
    assert.equal(result.lines, 9);

    // The scan artifacts are the shape everything downstream reads.
    const pages = readScanPages(runDir).pages;
    assert.equal(pages.length, 3);
    assert.equal(pages[0].dpi, DPI);
    assert.equal(pages[0].widthPx, WIDTH_PX);
    assert.equal(pages[0].deskewDeg, 0);

    const lines = readScanLines(runDir).lines;
    assert.equal(lines.length, 9);
    assert.equal(lines[0].id, 'p0000l0000');
    assert.equal(lines[0].text, 'Chapter 1');
    // Nothing recognized anything, so there is no confidence to report.
    assert.equal(lines[0].conf, null);
    // Geometry is in the 200 dpi pixel frame, not in points: a line 700 pt down
    // a 792 pt page is past pixel 200.
    assert.ok(lines[0].bbox[1] > 200 && lines[0].bbox[1] < 300, `top was ${lines[0].bbox[1]}`);

    // The run record names what read it.
    const run = readRun(runDir);
    assert.equal(run.segmenter.kind, 'embedded-text');
    assert.equal(run.stages.scan.status, 'done');
    assert.equal(run.input.pages, 3);

    // And the document says it is the text class — the ocr model stays off.
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(out)));
    assert.equal(readMarker(doc).documentClass, 'text');
    assert.equal(doc.getPageCount(), 3);
  } finally {
    done();
  }
});

test('scan --pdf on a book with no text says it is a scan, and names the route', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'scan.pdf');
    await blankPdf(source, 2);
    await assert.rejects(
      () => runEmbeddedScanStage({
        pdfPath: source, runDir: join(dir, 'run'), outPath: join(dir, 'out.pdf'), log: quiet,
      }),
      /carries no text layer.*foundry scan --pages.*get-text/s,
    );
    assert.equal(existsSync(join(dir, 'out.pdf')), false);
    assert.equal(existsSync(join(dir, 'run', ARTIFACTS.scanLines.path)), false);
  } finally {
    done();
  }
});

test('scan --pdf refuses to write over the book it was given', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'book.pdf');
    await textPdf(source, 1);
    await assert.rejects(
      () => runEmbeddedScanStage({
        pdfPath: source, runDir: join(dir, 'run'), outPath: source, log: quiet,
      }),
      /--out is the input PDF/,
    );
  } finally {
    done();
  }
});
