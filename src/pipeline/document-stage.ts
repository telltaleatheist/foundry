/**
 * document-stage — casting the WORKING DOCUMENT, by either of the two routes a
 * book arrives by.
 *
 * The pipeline's first act is to turn somebody's PDF into a document foundry
 * can write into. There are exactly two kinds of PDF and they need opposite
 * things:
 *
 *  - **A scan.** Pictures of pages, no text. `get-text` takes the original plus
 *    a scan's line geometry and writes the words back in as an invisible text
 *    layer, positioned line by line. Class: `scanned` — its words came out of
 *    Tesseract, so the ocr model repairs them before they are reflowed.
 *  - **A text PDF.** The words are already there, set by whoever made the book.
 *    `scan --pdf` reads them out with their geometry and emits the SAME
 *    `scan/pages.json` and `scan/lines.json` a Tesseract scan emits, so
 *    everything downstream sees one input shape. Class: `text` — the words are
 *    the author's, and pointing an OCR-repair model at them would be a model
 *    editing text that has no OCR errors in it.
 *
 * Both write the working document as ONE FULL REWRITE and then never do that
 * again: every stage after this appends. A full rewrite is what re-serializes
 * the object graph in one pass and drops a linearization — a first-page layout
 * declaration that an append silently invalidates (docs/PDF_SPIKE.md §5).
 *
 * Both also stamp the class INTO the document. Nothing else knows it, and
 * nothing else should have to be kept in step with it: `reflow` reads the
 * working PDF alone and has to be able to answer "does this book need the OCR
 * model" from the file in front of it.
 *
 * ## The original is never written to
 *
 * `--pdf` is read. `--out` is written. They may not be the same path, and the
 * check is by resolved path rather than by string, because an original
 * overwritten by its own working copy is a book that cannot be recast.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PDFDocument } from '@cantoo/pdf-lib';

import { extractDocument } from '../pdf/extract.js';
import { assertRenderMatches, type PageFrame } from '../pdf/frame.js';
import { writeTextLayer, type TextLayerLine } from '../pdf/textlayer.js';
import { writeMarker, writeWholeDocument, MARKER_VERSION, type DocumentClass } from '../pdf/document.js';
import { versionString } from '../version.js';
import {
  ARTIFACTS, readRun, readScanLines, readScanPages, writeArtifact,
  type RunArtifact, type ScanLine, type ScanPage, type StageName, type StageState,
} from './artifacts.js';
import { STAGE_NAMES } from './artifacts.js';
import { OCR_DPI } from '../scan/tesseract.js';

/** The extractor this build reads text layers with, recorded in run.json. */
export const EXTRACTOR_ID = 'pdfjs-dist@6.2.108';

export class DocumentStageError extends Error {
  constructor(stage: string, message: string) {
    super(`${stage}: ${message}`);
    this.name = 'DocumentStageError';
  }
}

function readPdf(stage: string, path: string): Uint8Array {
  if (!existsSync(path)) throw new DocumentStageError(stage, `no such PDF: ${path}`);
  return new Uint8Array(readFileSync(path));
}

function refuseOverwrite(stage: string, source: string, target: string): void {
  if (resolve(source) === resolve(target)) {
    throw new DocumentStageError(
      stage,
      `--out is the input PDF (${target}). The original is the one thing this pipeline never `
      + 'writes to: every working document is cast from it, so overwriting it is the one mistake '
      + 'that cannot be undone by re-running.',
    );
  }
}

/**
 * Load the original for a full rewrite.
 *
 * NOT `forIncrementalUpdate`: this is the pass that re-serializes everything,
 * and loading for an incremental update would preserve exactly the layout it
 * exists to discard.
 */
async function loadOriginal(stage: string, bytes: Uint8Array, path: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new DocumentStageError(
      stage, `${path} could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The visible page — the crop box where one is declared, else the media box. */
function visibleBox(doc: PDFDocument, index: number): { x: number; y: number; width: number; height: number } {
  const page = doc.getPage(index);
  const crop = page.getCropBox();
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ═════════════════════════════════════════════════════════════════════════════
// get-text — the scanned route
// ═════════════════════════════════════════════════════════════════════════════

export interface GetTextOptions {
  /** The original PDF. Read, never written. */
  pdfPath: string;
  /** The run directory holding the scan this text layer is written from. */
  runDir: string;
  /** Where the working document goes. */
  outPath: string;
  log: (message: string) => void;
}

export interface GetTextResult {
  pages: number;
  lines: number;
  bytes: number;
  language: string | null;
}

export async function runGetTextStage(options: GetTextOptions): Promise<GetTextResult> {
  const stage = 'get-text';
  refuseOverwrite(stage, options.pdfPath, options.outPath);

  const run = readRun(options.runDir);
  if (run.segmenter.kind !== 'tesseract') {
    throw new DocumentStageError(
      stage,
      `${options.runDir} was scanned by ${run.segmenter.kind}, not Tesseract. get-text writes a text `
      + 'layer for a book that HAS no text; a document read through its own text layer already has '
      + 'one, and `foundry scan --pdf` casts its working document in the same pass.',
    );
  }

  const scanPages = readScanPages(options.runDir).pages;
  const scanLines = readScanLines(options.runDir).lines;
  if (scanPages.length === 0) {
    throw new DocumentStageError(stage, `${ARTIFACTS.scanPages.path} has no pages — there is nothing to write`);
  }

  const bytes = readPdf(stage, options.pdfPath);
  const doc = await loadOriginal(stage, bytes, options.pdfPath);

  if (doc.getPageCount() !== scanPages.length) {
    throw new DocumentStageError(
      stage,
      `${options.pdfPath} has ${doc.getPageCount()} pages and the scan has ${scanPages.length}. The `
      + 'text layer is written page for page, so these have to be the same document — a scan of a '
      + 'different edition, or of the same book with its cover stripped, would put every page\'s '
      + 'words on some other page.',
    );
  }

  const byPage = new Map<number, ScanLine[]>();
  for (const line of scanLines) {
    const list = byPage.get(line.page);
    if (list) list.push(line); else byPage.set(line.page, [line]);
  }

  let written = 0;
  for (const scanPage of scanPages) {
    const box = visibleBox(doc, scanPage.page);
    const frame: PageFrame = {
      page: scanPage.page,
      widthPx: scanPage.widthPx,
      heightPx: scanPage.heightPx,
      widthPt: box.width,
      heightPt: box.height,
      offsetXPt: box.x,
      offsetYPt: box.y,
      deskewDeg: scanPage.deskewDeg,
    };
    assertRenderMatches(frame, scanPage.dpi);

    const lines: TextLayerLine[] = (byPage.get(scanPage.page) ?? [])
      .filter(l => l.text.trim().length > 0)
      .map(l => ({ text: l.text, box: l.bbox }));
    writeTextLayer(doc, doc.getPage(scanPage.page).node, frame, lines);
    written += lines.length;
  }

  const language = run.segmenter.tessdata[0] ?? null;
  writeMarker(doc, {
    version: MARKER_VERSION,
    documentClass: 'scanned',
    language,
    dpi: run.segmenter.dpi,
    sourceSha256: sha256(bytes),
    producer: `foundry ${versionString()}`,
  });

  const size = await writeWholeDocument(doc, options.outPath);
  options.log(
    `get-text: ${written} lines over ${scanPages.length} pages → ${options.outPath} `
    + `(${size} bytes, class scanned)`,
  );
  return { pages: scanPages.length, lines: written, bytes: size, language };
}

// ═════════════════════════════════════════════════════════════════════════════
// scan --pdf — the embedded-text route
// ═════════════════════════════════════════════════════════════════════════════

export interface EmbeddedScanOptions {
  /** The PDF whose own text layer is being read. Read, never written. */
  pdfPath: string;
  /** The run directory the scan artifacts go into. */
  runDir: string;
  /** Where the working document goes. */
  outPath: string;
  log: (message: string) => void;
}

export interface EmbeddedScanResult {
  pages: number;
  lines: number;
  bytes: number;
  language: string | null;
}

/** Every stage 'pending' — the shape a run record is born with. */
function pendingStages(): Record<StageName, StageState> {
  const stages = {} as Record<StageName, StageState>;
  for (const name of STAGE_NAMES) stages[name] = { status: 'pending' };
  return stages;
}

export async function runEmbeddedScanStage(options: EmbeddedScanOptions): Promise<EmbeddedScanResult> {
  const stage = 'scan';
  refuseOverwrite(stage, options.pdfPath, options.outPath);

  const bytes = readPdf(stage, options.pdfPath);
  const extracted = await extractDocument(bytes, { dpi: OCR_DPI });

  const total = extracted.pages.reduce((n, p) => n + p.lines.length, 0);
  if (total === 0) {
    throw new DocumentStageError(
      stage,
      `${options.pdfPath} carries no text layer — ${extracted.pages.length} pages and not one line of `
      + 'extractable text. This is a scan: render its pages and run `foundry scan --pages <dir>`, '
      + 'then `foundry get-text` to write the words into a working document.',
    );
  }

  const pages: ScanPage[] = [];
  const lines: ScanLine[] = [];
  for (const page of extracted.pages) {
    pages.push({
      page: page.frame.page,
      widthPx: page.frame.widthPx,
      heightPx: page.frame.heightPx,
      // Nothing was rasterized and nothing was straightened: the geometry is
      // the page's own, projected into the pixel frame.
      deskewDeg: 0,
      dpi: OCR_DPI,
    });
    page.lines.forEach((line, i) => {
      lines.push({
        id: lineId(page.frame.page, i),
        page: page.frame.page,
        bbox: line.box,
        text: line.text,
        // Confidence is a RECOGNIZER's statement about what it read. Nothing
        // recognized anything here — the characters are the ones the document
        // declares — so there is no confidence to report, and inventing 100
        // would tell every consumer this text was measured when it was copied.
        conf: null,
      });
    });
  }

  const doc = await loadOriginal(stage, bytes, options.pdfPath);
  if (doc.getPageCount() !== pages.length) {
    throw new DocumentStageError(
      stage,
      `pdf.js read ${pages.length} pages and pdf-lib reads ${doc.getPageCount()} in the same file. `
      + 'The two disagree about the document, and page indices are the key every artifact uses.',
    );
  }

  writeMarker(doc, {
    version: MARKER_VERSION,
    documentClass: 'text',
    language: extracted.language,
    dpi: OCR_DPI,
    sourceSha256: sha256(bytes),
    producer: `foundry ${versionString()}`,
  });
  const size = await writeWholeDocument(doc, options.outPath);

  const run: RunArtifact = {
    formatVersion: ARTIFACTS.run.version,
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    foundryVersion: versionString(),
    input: { path: options.pdfPath, sha256: sha256(bytes), pages: pages.length },
    segmenter: {
      kind: 'embedded-text',
      extractor: EXTRACTOR_ID,
      language: extracted.language,
      dpi: OCR_DPI,
    },
    models: {},
    stages: pendingStages(),
  };
  run.stages['scan'] = {
    status: 'done',
    startedAt: run.createdAt,
    finishedAt: new Date().toISOString(),
  };
  writeArtifact(options.runDir, 'run', run);
  writeArtifact(options.runDir, 'scanPages', { pages });
  writeArtifact(options.runDir, 'scanLines', { lines });

  options.log(
    `scan: ${lines.length} lines over ${pages.length} pages from the document's own text layer `
    + `(${EXTRACTOR_ID}, language ${extracted.language ?? 'undeclared'})`,
  );
  options.log(`scan: wrote ${options.outPath} (${size} bytes, class text)`);
  return { pages: pages.length, lines: lines.length, bytes: size, language: extracted.language };
}

/** `p0007l0012` — the same id shape the Tesseract path produces. */
function lineId(page: number, index: number): string {
  return `p${String(page).padStart(4, '0')}l${String(index).padStart(4, '0')}`;
}

/** For the CLI's help and for callers that want the class without opening a doc. */
export const DOCUMENT_CLASS_OF_ROUTE: Readonly<Record<'get-text' | 'scan --pdf', DocumentClass>> = {
  'get-text': 'scanned',
  'scan --pdf': 'text',
};
