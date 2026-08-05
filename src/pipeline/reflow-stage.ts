/**
 * reflow-stage — the working PDF in, the EPUB out. Nothing else.
 *
 * This is the stage the whole document redesign is for. It opens ONE file — the
 * working document — and writes ONE file, the book. No run directory, no
 * blocks.json, no exclusion list, no overrides file: everything it needs is in
 * the PDF, because every stage before it wrote its answer INTO the PDF.
 *
 *   text layer   → the words, with their geometry (`get-text`, or the
 *                  publisher's own for a text-class document)
 *   annotations  → what every block IS, where it is, what it says, whether it
 *                  is deleted, and where it sits in the reading order (`blocks`)
 *   catalog      → the document class, the language, the frame's dpi, and the
 *                  sha256 of the original this was cast from
 *
 * ## The four steps, in the order they have to happen
 *
 *  1. **Drop what is not in the book.** Deleted blocks, deleted pages, excluded
 *     categories. FIRST, because everything after it costs something per line
 *     and none of that should be spent on text nobody will read.
 *  2. **Repair the OCR — scanned class only.** Per line, through the existing
 *     ocr adapter and its guards, over the KEPT lines. A text-class document
 *     skips this entirely: its words are the author's, and a model editing them
 *     could only make them worse.
 *  3. **Reflow.** The book's own calibration, the paragraph rules, the
 *     line-join — including the wrap-hyphen healing that is decided by the
 *     BOOK'S OWN vocabulary and never by a rule about what letter comes next.
 *  4. **Chapters** from the `chapter` annotations, whose text is the title.
 *
 * ## Which text a chapter title comes from
 *
 * The annotation's `/Contents` is the definitive chapter title — that is what
 * lets a user retype a mangled heading in any PDF reader and have the book take
 * it. But a title that nobody has touched is still what the scan read, and step
 * 2 has just repaired those same lines. So: **if the annotation still says
 * exactly what the text layer says, the repaired text wins; if it says
 * something else, a person changed it and the person wins.** That is the same
 * ladder `export --overrides` already has, with the override living in the
 * document instead of in a file beside it.
 *
 * ## Lines belong to the block that contains them
 *
 * An annotation is a box; a line is a box. A line joins the block whose box
 * contains its centre, and the smallest one when boxes overlap. A line inside
 * no block is not in the book — which is exactly what deleting a box in a
 * reader means, and it is why deletion needs no separate list.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { PDFDocument } from '@cantoo/pdf-lib';

import type { BlocksCategory } from '../blocks/encoder.js';
import { buildEpub, type EpubMetadata } from '../export/epub.js';
import { NEVER_EMITTED, resolveCategory } from '../export/exclude.js';
import { attestationFromLines } from '../paragraphs/hyphen.js';
import { calibrate } from '../paragraphs/calibration.js';
import { computeBlockGeometry } from '../paragraphs/geometry.js';
import { joinLines } from '../export/linejoin.js';
import { readBlockAnnotations, type BlockAnnotation } from '../pdf/annotations.js';
import { isPageDeleted, readMarker, type FoundryMarker } from '../pdf/document.js';
import { extractDocument, type ExtractedPage } from '../pdf/extract.js';
import type { PageFrame } from '../pdf/frame.js';
import { repairLines, type OcrGenerate } from '../ocr/stage.js';
import type { Block, ScanLine } from './artifacts.js';

/** Resolves the ocr adapter and returns its wire. Called only for a scan. */
export type OcrSupplier = () => Promise<OcrGenerate>;

export class ReflowError extends Error {
  constructor(message: string) {
    super(`reflow: ${message}`);
    this.name = 'ReflowError';
  }
}

export interface ReflowOptions {
  /** The working document. Read, never written. */
  pdfPath: string;
  /** Where the EPUB goes. Explicit — foundry never invents a name. */
  outPath: string;
  /** Categories to drop, on top of what the annotations say is deleted. */
  excludeCategories?: readonly string[];
  /** An image to embed as the cover. Outside the document, like the EPUB is. */
  coverPath?: string;
  /**
   * How to reach the ocr adapter, for a `scanned` document.
   *
   * A FACTORY, not a wire, and that is the point: it is called only once the
   * document has said it is a scan. A text-class book therefore never resolves
   * the ocr weights, never starts a server and never needs either on disk —
   * while a scanned book with no weights fails at the moment it needs them,
   * with the message that names them.
   */
  ocr?: OcrSupplier;
  log: (message: string) => void;
}

export interface ReflowResult {
  outPath: string;
  documentClass: FoundryMarker['documentClass'];
  /** Blocks the annotations declared, before anything was dropped. */
  totalBlocks: number;
  keptBlocks: number;
  /** Lines under the kept blocks. */
  keptLines: number;
  /** Lines the model was asked about, and what it changed. */
  ocrAsked: number;
  ocrCorrected: number;
  ocrRefused: number;
  sections: number;
  healedHyphens: number;
  keptHyphens: number;
  /** Line breaks that fell on a soft hyphen (U+00AD) and were closed up. */
  softJoinedHyphens: number;
  /** Soft hyphens removed with no break to close — invisible formatting. */
  strippedSoftHyphens: number;
  degraded: boolean;
}

/** The frame every page's geometry is in, rebuilt from the document itself. */
function frameOf(doc: PDFDocument, page: ExtractedPage): PageFrame {
  const crop = doc.getPage(page.frame.page).getCropBox();
  return {
    page: page.frame.page,
    widthPx: page.frame.widthPx,
    heightPx: page.frame.heightPx,
    widthPt: crop.width,
    heightPt: crop.height,
    offsetXPt: crop.x,
    offsetYPt: crop.y,
    deskewDeg: page.frame.deskewDeg,
  };
}

/** `p0007l0012` — ids are internal to this stage; nothing outside sees them. */
function lineId(page: number, index: number): string {
  return `p${String(page).padStart(4, '0')}l${String(index).padStart(4, '0')}`;
}

const centreOf = (box: readonly number[]): { x: number; y: number } =>
  ({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });

const areaOf = (box: readonly number[]): number => (box[2] - box[0]) * (box[3] - box[1]);

/**
 * Assign every line to the block that contains it.
 *
 * The smallest containing box wins, so a `footnote` block sitting inside the
 * bounds of something larger keeps its own lines. A line no box contains is
 * dropped, and that is the deletion mechanism: a box removed in a reader takes
 * its lines out of the book.
 */
export function assignLinesToBlocks(
  lines: readonly ScanLine[], blocks: readonly BlockAnnotation[],
): Map<string, string[]> {
  const byPage = new Map<number, BlockAnnotation[]>();
  for (const block of blocks) {
    const list = byPage.get(block.page);
    if (list) list.push(block); else byPage.set(block.page, [block]);
  }

  const assigned = new Map<string, string[]>();
  for (const block of blocks) assigned.set(block.id, []);

  for (const line of lines) {
    const candidates = byPage.get(line.page) ?? [];
    const centre = centreOf(line.bbox);
    let best: BlockAnnotation | null = null;
    for (const block of candidates) {
      const [x0, y0, x1, y1] = block.box;
      if (centre.x < x0 || centre.x > x1 || centre.y < y0 || centre.y > y1) continue;
      if (best === null || areaOf(block.box) < areaOf(best.box)) best = block;
    }
    if (best !== null) assigned.get(best.id)!.push(line.id);
  }
  return assigned;
}

export async function runReflowStage(options: ReflowOptions): Promise<ReflowResult> {
  const pdfPath = resolve(options.pdfPath);
  const outPath = resolve(options.outPath);
  const bytes = readFileSyncOrExplain(pdfPath);

  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const marker = readMarker(doc);

  const extracted = await extractDocument(bytes, { dpi: marker.dpi });
  if (extracted.pages.length !== doc.getPageCount()) {
    throw new ReflowError(
      `pdf.js reads ${extracted.pages.length} pages and pdf-lib reads ${doc.getPageCount()} in the `
      + 'same file. The two disagree about the document, and page indices are the key everything '
      + 'in it is written against.',
    );
  }

  // ── the lines, in reading order, in the scan's frame ──────────────────────
  const frames = new Map<number, PageFrame>();
  const lines: ScanLine[] = [];
  for (const page of extracted.pages) {
    frames.set(page.frame.page, frameOf(doc, page));
    page.lines.forEach((line, i) => {
      lines.push({
        id: lineId(page.frame.page, i),
        page: page.frame.page,
        bbox: line.box,
        text: line.text,
        conf: null,
      });
    });
  }
  if (lines.length === 0) {
    throw new ReflowError(
      `${pdfPath} has no text layer to read. A working document carries one from the moment it is `
      + 'cast — by `foundry get-text` for a scan, by `foundry scan --pdf` for a book that already '
      + 'had text — so a document with none was never cast, or was truncated past that stage.',
    );
  }

  // ── what the document says is in the book ─────────────────────────────────
  const all = readBlockAnnotations(doc, frames);
  if (all.length === 0) {
    throw new ReflowError(
      `${pdfPath} carries no block annotations, so nothing in it has been identified as a chapter, a `
      + 'paragraph or a running head. Run `foundry blocks --run <dir> --pdf <this file>` first.',
    );
  }

  const excluded = new Set<BlocksCategory>(
    (options.excludeCategories ?? []).map(resolveCategory),
  );
  const deletedPages = new Set<number>();
  for (let i = 0; i < doc.getPageCount(); i++) {
    if (isPageDeleted(doc.getPage(i).node)) deletedPages.add(i);
  }

  const dropped = { deleted: 0, page: 0, category: 0, furniture: 0 };
  const kept: BlockAnnotation[] = [];
  for (const block of all) {
    if (block.deleted) { dropped.deleted++; continue; }
    if (deletedPages.has(block.page)) { dropped.page++; continue; }
    if (NEVER_EMITTED.has(block.category)) { dropped.furniture++; continue; }
    if (excluded.has(block.category)) { dropped.category++; continue; }
    kept.push(block);
  }
  if (kept.length === 0) {
    throw new ReflowError(
      `nothing survived: ${all.length} blocks in, ${dropped.deleted} deleted, ${dropped.page} on `
      + `deleted pages, ${dropped.category} excluded by category, ${dropped.furniture} page `
      + 'furniture. There is no book to write.',
    );
  }

  const assignment = assignLinesToBlocks(lines, kept);
  const keptLineIds = new Set<string>([...assignment.values()].flat());
  options.log(
    `reflow: ${kept.length} of ${all.length} blocks kept (${dropped.deleted} deleted, `
    + `${dropped.page} on deleted pages, ${dropped.category} excluded, ${dropped.furniture} furniture)`
    + ` — ${keptLineIds.size} of ${lines.length} lines`,
  );

  // ── step 2: repair the OCR, for a scan and only for a scan ────────────────
  const text = new Map(lines.map(l => [l.id, l.text] as const));
  let ocrAsked = 0;
  let ocrCorrected = 0;
  let ocrRefused = 0;
  if (marker.documentClass === 'scanned') {
    if (!options.ocr) {
      throw new ReflowError(
        'this is a scanned document, and its words came out of Tesseract. The ocr adapter repairs '
        + 'them line by line before anything is joined into a paragraph, so reflow cannot run '
        + 'without it.',
      );
    }
    const result = await repairLines({
      lines: lines.map(l => ({ id: l.id, text: l.text })),
      keep: keptLineIds,
      generate: await options.ocr(),
      onProgress: (done, total) => {
        if (done % 100 === 0) options.log(`  reflow: ocr ${done}/${total} lines`);
      },
    });
    for (const line of result.lines) text.set(line.id, line.text);
    ocrAsked = result.asked;
    ocrCorrected = result.corrected;
    ocrRefused = result.refused;
    options.log(
      `reflow: ocr repaired ${ocrCorrected} of ${ocrAsked} lines asked, `
      + `${ocrRefused} outputs refused by the guards, ${result.skipped} lines not in the book`,
    );
  } else {
    // A text-class document. Its words are the publisher's, so no model is
    // pointed at them and none is loaded — the supplier is simply never called.
    options.log('reflow: text-class document — the words are the publisher\'s, so the ocr model stays off');
  }

  // ── steps 3 and 4: reflow, chapters, EPUB ─────────────────────────────────
  const corrected: ScanLine[] = lines.map(l => ({ ...l, text: text.get(l.id)! }));
  const calibration = calibrate(corrected.map(l => ({ page: l.page, bbox: l.bbox })));
  options.log(
    `reflow: paragraph convention "${calibration.convention}"`
    + `${calibration.degraded ? ' — DEGRADED: ' : ' — '}${calibration.message}`,
  );

  const blocks: Block[] = kept.map(block => ({
    id: block.id,
    page: block.page,
    bbox: block.box,
    lineIds: assignment.get(block.id)!,
    category: block.category,
    geometry: { firstLineIndent: 0, gapAbove: null, prevLineShort: false, prevEndsWrapHyphen: false },
  }));
  const geometry = computeBlockGeometry(blocks, corrected, calibration);
  for (const block of blocks) {
    const g = geometry.get(block.id);
    if (!g) throw new ReflowError(`block ${block.id} got no geometry — computeBlockGeometry skipped it`);
    block.geometry = g;
  }

  // The vocabulary is the WHOLE book's, including the lines of blocks that were
  // dropped: a word is attested by the book, not by the subset somebody chose
  // to narrate, and letting a deletion change how a hyphen elsewhere resolves
  // would make the text depend on the filter.
  const attestation = attestationFromLines(corrected.map(l => l.text));

  const byId = new Map(corrected.map(l => [l.id, l] as const));
  const blockText = new Map<string, string[]>();
  for (const block of kept) {
    const units = assignment.get(block.id)!.map(id => byId.get(id)!.text);
    blockText.set(block.id, chapterTextFor(block, units, attestation));
  }

  const result = buildEpub({
    blocks,
    lines: corrected,
    blockText,
    calibration,
    metadata: deriveMetadata(doc, marker, kept, blockText, pdfPath),
    attestation,
    ...(options.coverPath ? { cover: readCover(options.coverPath) } : {}),
  });

  writeAtomically(outPath, result.zip);
  options.log(
    `reflow: ${result.sections.length} sections, ${result.healedHyphens} hyphens healed, `
    + `${result.keptHyphens} kept unproven, ${result.softJoinedHyphens} soft-hyphen joins, `
    + `${result.strippedSoftHyphens} stray soft hyphens removed → ${outPath}`,
  );
  if (result.grouping.degraded) options.log(result.grouping.message);

  return {
    outPath,
    documentClass: marker.documentClass,
    totalBlocks: all.length,
    keptBlocks: kept.length,
    keptLines: keptLineIds.size,
    ocrAsked,
    ocrCorrected,
    ocrRefused,
    sections: result.sections.length,
    healedHyphens: result.healedHyphens,
    keptHyphens: result.keptHyphens,
    softJoinedHyphens: result.softJoinedHyphens,
    strippedSoftHyphens: result.strippedSoftHyphens,
    degraded: result.grouping.degraded,
  };
}

/**
 * The units a block ships as — and, for a chapter or a title, the one place the
 * annotation's own text can overrule them.
 *
 * See the header: the annotation wins when a person changed it, and the
 * repaired lines win when nobody did. "Nobody did" is decided by comparing the
 * annotation against the lines JOINED THE SAME WAY the blocks stage joined them
 * when it wrote the annotation, so the comparison is between two things that
 * were computed identically.
 */
function chapterTextFor(
  block: BlockAnnotation, units: readonly string[], attestation: Parameters<typeof joinLines>[1],
): string[] {
  if (block.category !== 'chapter' && block.category !== 'title') return [...units];
  const joined = joinLines(units, attestation).text;
  if (block.text.trim().length === 0 || block.text === joined) return [...units];
  // Somebody retyped it. Their line is the heading, as one unit — there is no
  // wrap hyphen in a line a person typed and nothing for the join rules to do.
  return [block.text];
}

/**
 * The book's metadata, derived from the document.
 *
 *  - **identifier**: `urn:sha256:<the ORIGINAL PDF's hash>`, which the working
 *    document recorded when it was cast. Stable across every recast of the same
 *    book and different for a different book — the whole job of a publication
 *    identifier — and deliberately not the working document's own hash, which
 *    changes every time a stage appends to it.
 *  - **title**: the book's own `title` block, else its first `chapter` block,
 *    else the `/Title` the PDF declares, else the file's name. The first two are
 *    what the labeller decided the title is, which beats anything this function
 *    could invent.
 *  - **language**: what the document says. A book that declares none says `und`,
 *    which is the ISO code for exactly that.
 */
function deriveMetadata(
  doc: PDFDocument,
  marker: FoundryMarker,
  blocks: readonly BlockAnnotation[],
  blockText: ReadonlyMap<string, readonly string[]>,
  pdfPath: string,
): EpubMetadata {
  const titleBlock = blocks.find(b => b.category === 'title')
    ?? blocks.find(b => b.category === 'chapter');
  const fromBlock = titleBlock ? (blockText.get(titleBlock.id) ?? []).join(' ').trim() : '';
  const declared = (doc.getTitle() ?? '').trim();
  const fromFile = basename(pdfPath).replace(/\.[^.]+$/, '').trim();

  const language = marker.language ?? '';
  return {
    title: fromBlock.length > 0 ? fromBlock : (declared.length > 0 ? declared : fromFile),
    language: ISO_639_2_TO_1[language] ?? (language.length > 0 ? language : 'und'),
    identifier: `urn:sha256:${marker.sourceSha256}`,
  };
}

/** The same short table `export-stage` uses; see its comment for why it is short. */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it',
  nld: 'nl', dut: 'nl', por: 'pt', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi',
  pol: 'pl', rus: 'ru', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', lat: 'la',
  jpn: 'ja', kor: 'ko', chi_sim: 'zh', chi_tra: 'zh', ara: 'ar', heb: 'he',
  tur: 'tr', hun: 'hu', ron: 'ro', rum: 'ro', ukr: 'uk', cat: 'ca',
};

function readFileSyncOrExplain(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new ReflowError(`no such working PDF: ${path}`);
  }
}

function readCover(coverPath: string): { data: Uint8Array; sourcePath: string } {
  const resolved = resolve(coverPath);
  try {
    return { data: new Uint8Array(readFileSync(resolved)), sourcePath: resolved };
  } catch {
    throw new ReflowError(`--cover: no such file: ${resolved}`);
  }
}

/** Staged temp plus rename: a half-written EPUB in a synced folder is worse than none. */
function writeAtomically(target: string, bytes: Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.foundry-tmp`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the failure below is the news */ }
    throw err;
  }
}
