/**
 * reflow, and the block layer it reads.
 *
 * These run the document pipeline end to end without a model: a PDF is cast
 * into a working document, a block layer is written into it, and the book is
 * built from that file alone. What is being checked is that the DOCUMENT is
 * sufficient — that nothing reflow needs is still living in a run directory —
 * and that each of the ways a user says "not this" reaches the book.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

import { DEFAULT_PALETTE } from '../../src/pdf/annotations.js';
import { textString } from '../../src/pdf/strings.js';
import { PAGE_DELETED_KEY, WorkingPdf } from '../../src/pdf/document.js';
import { mergeDisplayCategories, readBlockLayer, writeBlockLayer, type ClassifiedBlock } from '../../src/pipeline/blocks-document.js';
import { runEmbeddedScanStage, runGetTextStage } from '../../src/pipeline/document-stage.js';
import { runReflowStage } from '../../src/pipeline/reflow-stage.js';
import { readScanLines, readScanPages, writeArtifact, type ScanLine, type ScanPage } from '../../src/pipeline/artifacts.js';
import type { Box } from '../../src/scan/bands.js';

const DPI = 200;
const WIDTH_PT = 612;
const HEIGHT_PT = 792;
const WIDTH_PX = Math.round((WIDTH_PT * DPI) / 72);
const HEIGHT_PX = Math.round((HEIGHT_PT * DPI) / 72);

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-reflow-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const quiet = (): void => {};

/** The user turn of the ocr prompt — the line the model is being asked about. */
const USER_TURN = /<\|im_start\|>user\n([\s\S]*?)<\|im_end\|>/;

/** Unzip one entry out of an EPUB, as text. */
function epubEntry(zip: Uint8Array, path: string): string {
  // Central-directory-free reader: every entry this exporter writes is stored
  // deflated, so the file is read through Bun's own zip via a temp file.
  const dir = mkdtempSync(join(tmpdir(), 'foundry-unzip-'));
  try {
    const file = join(dir, 'book.epub');
    writeFileSync(file, zip);
    const out = Bun.spawnSync(['powershell', '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
      + `$z=[System.IO.Compression.ZipFile]::OpenRead('${file.replace(/\\/g, '\\\\')}'); `
      + `$e=$z.GetEntry('${path}'); $r=New-Object System.IO.StreamReader($e.Open()); `
      + `$r.ReadToEnd()`]);
    if (out.exitCode !== 0) throw new Error(new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A book with real text on it: a heading, five body lines and a folio per page.
 *
 * The size is not arbitrary. Paragraph calibration measures the BOOK's own
 * rhythm and refuses to invent one from a handful of lines (twelve is its
 * floor), so a fixture small enough to read at a glance is a fixture the
 * pipeline correctly declines to process.
 */
const BODY_LINES = 5;
/** Blocks per page: the heading, the body lines, and the folio. */
const BLOCKS_PER_PAGE = BODY_LINES + 2;

async function textPdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([WIDTH_PT, HEIGHT_PT]);
    page.setFont(font);
    page.drawText(`Chapter ${i + 1}`, { x: 72, y: 700, size: 20 });
    page.drawText(`The treaty collapsed in the spring of ${1930 + i}.`, { x: 72, y: 650, size: 12 });
    for (let line = 1; line < BODY_LINES; line++) {
      page.drawText(`It had never been ratified by anyone, line ${line}.`, { x: 72, y: 650 - line * 20, size: 12 });
    }
    page.drawText(`${i + 1}`, { x: 300, y: 60, size: 10 });
  }
  writeFileSync(path, await doc.save());
}

/**
 * Classify a scan the way the model would: the top line of each page is the
 * chapter, the bottom line is a folio, the rest is body.
 */
function classify(pages: readonly ScanPage[], lines: readonly ScanLine[]): ClassifiedBlock[] {
  const blocks: ClassifiedBlock[] = [];
  for (const page of pages) {
    const mine = lines.filter(l => l.page === page.page);
    mine.forEach((line, i) => {
      const last = i === mine.length - 1;
      blocks.push({
        id: `p${String(page.page).padStart(4, '0')}b${String(i).padStart(3, '0')}`,
        page: page.page,
        bbox: line.bbox,
        lineIds: [line.id],
        category: i === 0 ? 'chapter' : last ? 'footer' : 'body',
      });
    });
  }
  return blocks;
}

/** The whole pipeline up to reflow, with no model anywhere. */
async function textClassDocument(dir: string, pages = 4): Promise<{
  working: string; blocks: ClassifiedBlock[]; scanPages: ScanPage[]; scanLines: ScanLine[];
}> {
  const source = join(dir, 'book.pdf');
  const working = join(dir, 'working.pdf');
  const runDir = join(dir, 'run');
  await textPdf(source, pages);
  await runEmbeddedScanStage({ pdfPath: source, runDir, outPath: working, log: quiet });
  const scanPages = readScanPages(runDir).pages;
  const scanLines = readScanLines(runDir).lines;
  const blocks = classify(scanPages, scanLines);
  await writeBlockLayer({
    pdfPath: working, blocks, lines: scanLines, pages: scanPages,
    pitchPx: 40, palette: DEFAULT_PALETTE, log: quiet,
  });
  return { working, blocks, scanPages, scanLines };
}

// ── the display merge ───────────────────────────────────────────────────────

const box = (y0: number, y1: number, x0 = 100, x1 = 900): Box => [x0, y0, x1, y1];

test('adjacent chapter blocks close together become one', () => {
  const blocks: ClassifiedBlock[] = [
    { id: 'a', page: 0, bbox: box(100, 140), lineIds: ['l1'], category: 'chapter' },
    { id: 'b', page: 0, bbox: box(145, 185), lineIds: ['l2'], category: 'chapter' },
    { id: 'c', page: 0, bbox: box(300, 340), lineIds: ['l3'], category: 'body' },
  ];
  const { blocks: out, merged } = mergeDisplayCategories(blocks, 40);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.deepEqual(out[0].lineIds, ['l1', 'l2']);
  assert.deepEqual(out[0].bbox, [100, 100, 900, 185]);
  assert.deepEqual(merged.get('a'), ['a', 'b']);
});

test('a gap wider than a paragraph keeps two chapters apart', () => {
  const blocks: ClassifiedBlock[] = [
    { id: 'a', page: 0, bbox: box(100, 140), lineIds: ['l1'], category: 'chapter' },
    { id: 'b', page: 0, bbox: box(400, 440), lineIds: ['l2'], category: 'chapter' },
  ];
  const { blocks: out, merged } = mergeDisplayCategories(blocks, 40);
  assert.equal(out.length, 2);
  assert.equal(merged.size, 0);
});

test('something between them keeps two chapters apart', () => {
  const blocks: ClassifiedBlock[] = [
    { id: 'a', page: 0, bbox: box(100, 140), lineIds: ['l1'], category: 'chapter' },
    { id: 'b', page: 0, bbox: box(145, 185), lineIds: ['l2'], category: 'body' },
    { id: 'c', page: 0, bbox: box(190, 230), lineIds: ['l3'], category: 'chapter' },
  ];
  const { blocks: out } = mergeDisplayCategories(blocks, 40);
  assert.deepEqual(out.map(b => b.id), ['a', 'b', 'c']);
});

test('body blocks are never merged — the paragraph grouper owns that junction', () => {
  const blocks: ClassifiedBlock[] = [
    { id: 'a', page: 0, bbox: box(100, 140), lineIds: ['l1'], category: 'body' },
    { id: 'b', page: 0, bbox: box(145, 185), lineIds: ['l2'], category: 'body' },
  ];
  const { blocks: out } = mergeDisplayCategories(blocks, 40);
  assert.equal(out.length, 2);
});

test('a page turn keeps two chapters apart', () => {
  const blocks: ClassifiedBlock[] = [
    { id: 'a', page: 0, bbox: box(100, 140), lineIds: ['l1'], category: 'chapter' },
    { id: 'b', page: 1, bbox: box(100, 140), lineIds: ['l2'], category: 'chapter' },
  ];
  const { blocks: out } = mergeDisplayCategories(blocks, 40);
  assert.equal(out.length, 2);
});

// ── the block layer in the document ─────────────────────────────────────────

test('the block layer round-trips through the document', async () => {
  const { dir, done } = scratch();
  try {
    const { working, blocks, scanPages } = await textClassDocument(dir);
    const back = await readBlockLayer(working, scanPages);
    assert.equal(back.length, blocks.length);
    assert.deepEqual(back.map(a => a.id), blocks.map(b => b.id));
    assert.deepEqual(back.map(a => a.category), blocks.map(b => b.category));
    assert.equal(back[0].text, 'Chapter 1');
    // Geometry survives the trip into the page's points and back.
    for (let k = 0; k < 4; k++) {
      assert.ok(Math.abs(back[0].box[k] - blocks[0].bbox[k]) < 1);
    }
  } finally {
    done();
  }
});

// ── reflow ──────────────────────────────────────────────────────────────────

test('reflow builds the book from the document alone', async () => {
  const { dir, done } = scratch();
  try {
    const { working } = await textClassDocument(dir);
    const out = join(dir, 'book.epub');
    const result = await runReflowStage({ pdfPath: working, outPath: out, log: quiet });

    assert.equal(result.documentClass, 'text');
    // Three chapters, three folios dropped as furniture, six body lines.
    assert.equal(result.totalBlocks, 4 * BLOCKS_PER_PAGE);
    assert.equal(result.keptBlocks, 4 * (BLOCKS_PER_PAGE - 1));
    // The text class never asks the model anything.
    assert.equal(result.ocrAsked, 0);
    assert.equal(result.sections, 4);

    const opf = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/package.opf');
    assert.match(opf, /<dc:title>Chapter 1<\/dc:title>/);
    // The identifier is the ORIGINAL's hash, not the working document's — it
    // has to survive every stage appending to the working file.
    assert.match(opf, /<dc:identifier id="pub-id">urn:sha256:[0-9a-f]{64}<\/dc:identifier>/);

    const first = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/text/s0001.xhtml');
    assert.match(first, /<h1[^>]*>Chapter 1<\/h1>/);
    assert.match(first, /The treaty collapsed in the spring of 1930\./);
    // The folio was furniture and is not in the book.
    assert.doesNotMatch(first, /<p[^>]*>1<\/p>/);
  } finally {
    done();
  }
});

test('a deleted block annotation takes its text out of the book', async () => {
  const { dir, done } = scratch();
  try {
    const { working, scanPages } = await textClassDocument(dir);

    // Flag the first chapter deleted, the way an editor would.
    const flagged = await WorkingPdf.open(working);
    const annots = flagged.doc.getPage(0).node.Annots() as PDFArray;
    (annots.lookup(0) as PDFDict).set(PDFName.of('FoundryDeleted'), PDFBool.True);
    flagged.markChanged(annots.get(0));
    await flagged.appendUpdate();

    const back = await readBlockLayer(working, scanPages);
    assert.equal(back.filter(a => a.deleted).length, 1);

    const out = join(dir, 'book.epub');
    const result = await runReflowStage({ pdfPath: working, outPath: out, log: quiet });
    assert.equal(result.keptBlocks, 4 * (BLOCKS_PER_PAGE - 1) - 1);
    const body = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/text/s0001.xhtml');
    assert.doesNotMatch(body, /Chapter 1/);
  } finally {
    done();
  }
});

test('a deleted page takes every block on it', async () => {
  const { dir, done } = scratch();
  try {
    const { working } = await textClassDocument(dir);

    const flagged = await WorkingPdf.open(working);
    flagged.doc.getPage(1).node.set(PAGE_DELETED_KEY, PDFBool.True);
    flagged.markChanged(flagged.doc.getPage(1).node);
    await flagged.appendUpdate();

    const out = join(dir, 'book.epub');
    const result = await runReflowStage({ pdfPath: working, outPath: out, log: quiet });
    // Page 1's folio was already furniture; its heading and body lines go too.
    assert.equal(result.keptBlocks, 3 * (BLOCKS_PER_PAGE - 1));
    assert.equal(result.sections, 3);
  } finally {
    done();
  }
});

test('--exclude drops a category the labeller kept', async () => {
  const { dir, done } = scratch();
  try {
    const { working } = await textClassDocument(dir);
    const out = join(dir, 'book.epub');
    const result = await runReflowStage({
      pdfPath: working, outPath: out, excludeCategories: ['body'], log: quiet,
    });
    assert.equal(result.keptBlocks, 4);
    const body = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/text/s0001.xhtml');
    assert.doesNotMatch(body, /treaty collapsed/);
    assert.match(body, /<h1[^>]*>Chapter 1<\/h1>/);
  } finally {
    done();
  }
});

test('a retyped chapter annotation is the chapter title', async () => {
  const { dir, done } = scratch();
  try {
    const { working, scanPages, scanLines } = await textClassDocument(dir);

    // Retype the first chapter's annotation — the same thing a person does in a
    // reader. The ANNOTATION is the object that changed, so the annotation's
    // reference is what has to be marked; marking the page it sits on would
    // write a page whose array still points at the old text.
    void scanLines;
    void scanPages;
    const edit = await WorkingPdf.open(working);
    const annots = edit.doc.getPage(0).node.Annots() as PDFArray;
    const first = annots.lookup(0) as PDFDict;
    first.set(PDFName.of('Contents'), textString('One: The Beer Hall'));
    edit.markChanged(annots.get(0));
    await edit.appendUpdate();

    const out = join(dir, 'book.epub');
    await runReflowStage({ pdfPath: working, outPath: out, log: quiet });
    const opf = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/package.opf');
    assert.match(opf, /<dc:title>One: The Beer Hall<\/dc:title>/);
    const body = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/text/s0001.xhtml');
    assert.match(body, /<h1[^>]*>One: The Beer Hall<\/h1>/);
  } finally {
    done();
  }
});

// ── the scanned class ───────────────────────────────────────────────────────

test('a scanned document is OCR-repaired, and only over the lines that ship', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'scan.pdf');
    const working = join(dir, 'working.pdf');
    const runDir = join(dir, 'run');

    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([WIDTH_PT, HEIGHT_PT]);
    writeFileSync(source, await doc.save());

    // Two pages: a heading, a body line the model will repair, and a folio.
    const texts = [
      ['Chapter One', 'The treaty col1apsed in the spring.', 'It had never been ratifIed.',
        'A third line of prose.', 'A fourth line of prose.', 'A fifth line of prose.', '1'],
      ['Chapter Two', 'The second page opens here.', 'It continues for a while.',
        'A third line of prose.', 'A fourth line of prose.', 'A fifth line of prose.', '2'],
      ['Chapter Three', 'The third page opens here.', 'It continues for a while.',
        'A third line of prose.', 'A fourth line of prose.', 'A fifth line of prose.', '3'],
    ];
    writeArtifact(runDir, 'run', {
      runId: 'r', createdAt: 'c', foundryVersion: 't',
      input: { path: 'pages', sha256: '0'.repeat(64), pages: 3 },
      segmenter: { kind: 'tesseract', version: '5.3.4', binarySha256: 'x', tessdata: ['eng'], dpi: DPI },
      models: {},
      stages: {
        scan: { status: 'done' }, blocks: { status: 'pending' }, ocr: { status: 'pending' },
        footnotes: { status: 'pending' }, export: { status: 'pending' },
      },
    });
    writeArtifact(runDir, 'scanPages', {
      pages: [0, 1, 2].map(page => ({ page, widthPx: WIDTH_PX, heightPx: HEIGHT_PX, deskewDeg: 0, dpi: DPI })),
    });
    writeArtifact(runDir, 'scanLines', {
      lines: texts.flatMap((page, p) => page.map((text, i) => ({
        id: `p${String(p).padStart(4, '0')}l${String(i).padStart(4, '0')}`,
        page: p,
        bbox: [300, 300 + i * 120, 300 + text.length * 30, 380 + i * 120] as Box,
        text,
        conf: 90,
      }))),
    });

    await runGetTextStage({ pdfPath: source, runDir, outPath: working, log: quiet });
    const scanPages = readScanPages(runDir).pages;
    const scanLines = readScanLines(runDir).lines;
    await writeBlockLayer({
      pdfPath: working, blocks: classify(scanPages, scanLines), lines: scanLines,
      pages: scanPages, pitchPx: 120, palette: DEFAULT_PALETTE, log: quiet,
    });

    const asked: string[] = [];
    const out = join(dir, 'book.epub');
    const result = await runReflowStage({
      pdfPath: working,
      outPath: out,
      log: quiet,
      ocr: async () => async (request) => {
        // The prompt is the trained-against chat template; the line is its user
        // turn. Answering with a whole corrected line is what the real model
        // does, and the guards then judge it.
        const line = USER_TURN.exec(request.prompt)?.[1] ?? '';
        asked.push(line);
        return line.replace('col1apsed', 'collapsed').replace('ratifIed', 'ratified');
      },
    });

    assert.equal(result.documentClass, 'scanned');
    // Eighteen blocks ship (three chapters, fifteen body lines); the three
    // folios are furniture and their lines are never sent.
    assert.equal(result.ocrAsked, 18);
    assert.equal(asked.some(l => l === '1' || l === '2' || l === '3'), false,
      'a line the book will not contain was sent to the model');
    assert.equal(result.ocrCorrected, 2);

    const body = epubEntry(new Uint8Array(readFileSync(out)), 'EPUB/text/s0001.xhtml');
    assert.match(body, /The treaty collapsed in the spring\./);
    assert.doesNotMatch(body, /col1apsed/);
  } finally {
    done();
  }
});

test('a scanned document with no ocr wire stops, naming what is missing', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'scan.pdf');
    const working = join(dir, 'working.pdf');
    const runDir = join(dir, 'run');
    const doc = await PDFDocument.create();
    doc.addPage([WIDTH_PT, HEIGHT_PT]);
    writeFileSync(source, await doc.save());
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
      lines: [{ id: 'p0000l0000', page: 0, bbox: [300, 300, 900, 380] as Box, text: 'A line', conf: 90 }],
    });
    await runGetTextStage({ pdfPath: source, runDir, outPath: working, log: quiet });
    const scanPages = readScanPages(runDir).pages;
    const scanLines = readScanLines(runDir).lines;
    await writeBlockLayer({
      pdfPath: working,
      blocks: [{ id: 'p0000b000', page: 0, bbox: [300, 300, 900, 380], lineIds: ['p0000l0000'], category: 'body' }],
      lines: scanLines, pages: scanPages, pitchPx: 100, palette: DEFAULT_PALETTE, log: quiet,
    });

    await assert.rejects(
      () => runReflowStage({ pdfPath: working, outPath: join(dir, 'book.epub'), log: quiet }),
      /scanned document.*ocr adapter repairs them/s,
    );
  } finally {
    done();
  }
});

test('reflow refuses a PDF that is not a working document', async () => {
  const { dir, done } = scratch();
  try {
    const source = join(dir, 'book.pdf');
    await textPdf(source, 1);
    await assert.rejects(
      () => runReflowStage({ pdfPath: source, outPath: join(dir, 'book.epub'), log: quiet }),
      /carries no foundry marker/,
    );
  } finally {
    done();
  }
});
