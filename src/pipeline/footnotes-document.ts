/**
 * footnotes-document — strip the markers, and rewrite the text layer they were
 * in.
 *
 * The third input this stage takes. `--run` reads a scan's artifacts, `--epub`
 * edits somebody's finished book, and `--pdf` edits a working document: the
 * model reads the text layer `get-text` wrote, and the layer is rewritten with
 * the markers gone. It is one incremental update — the text streams are
 * REPLACED in place, so the page's contents, its annotations and every other
 * object are untouched and the boundary is one byte offset.
 *
 * ## Only a scanned document
 *
 * A working document of the `text` class carries the PUBLISHER's text layer:
 * their fonts, their encodings, their positioning, spread through the content
 * streams of a book somebody typeset. Foundry does not rewrite that — it would
 * mean re-emitting another program's page description from a parse of it, and
 * a book whose paragraphs are subtly re-laid-out is a worse outcome than a book
 * that still says "47" in the middle of a sentence. The stage stops and names
 * the class rather than doing something plausible to the wrong kind of file.
 *
 * (The markers in such a book are markup, not OCR debris, which is exactly what
 * `footnotes --epub` is for once it has been exported.)
 *
 * ## Prose only
 *
 * The same rule run mode has: a running head is not prose and has no footnote
 * markers in it, so asking about it spends a round-trip and gives the model a
 * chance to fire on clean furniture — the failure that damages a book
 * (ARCHITECTURE §7). The categories come from the block annotations, which is
 * the whole reason this can be done at the document level at all.
 */
import { PDFDict } from '@cantoo/pdf-lib';

import { applyFootnoteDeletions, planFootnotes, type FootnoteDeletion, type FootnoteGenerator } from '../footnotes/applier.js';
import { readBlockAnnotations, type BlockAnnotation } from '../pdf/annotations.js';
import { WorkingPdf } from '../pdf/document.js';
import { extractDocument } from '../pdf/extract.js';
import type { PageFrame } from '../pdf/frame.js';
import { hasTextLayer, rewriteTextLayer, type TextLayerLine } from '../pdf/textlayer.js';
import { assignLinesToBlocks } from './reflow-stage.js';
import type { ScanLine } from './artifacts.js';

export class FootnotesDocumentError extends Error {
  constructor(message: string) {
    super(`footnotes: ${message}`);
    this.name = 'FootnotesDocumentError';
  }
}

/**
 * Categories whose text is never asked about — the same set run mode uses.
 * Duplicated as a value here rather than imported from the CLI because the CLI
 * is the wiring; this is the rule.
 */
export const NON_PROSE: ReadonlySet<string> = new Set([
  'header', 'footer', 'image', 'caption', 'table', 'list', 'discard',
]);

export interface AppliedRow {
  blockId: string;
  category: string;
  page: number;
  /** The characters removed. */
  removed: string;
  /** `…anchor [REMOVED: "1"] following…` — whitespace collapsed, ~80 chars each side. */
  context: string;
  before: string;
  after: string;
}

export interface RejectedRow {
  blockId: string;
  before: string;
  after: string;
  reason: string;
}

export interface PdfFootnotesReport {
  pdf: string;
  dryRun: boolean;
  generatedAt: string;
  model: string;
  totals: {
    blocks: number;
    prose: number;
    blocksEdited: number;
    applied: number;
    rejected: number;
    linesRewritten: number;
  };
  applied: AppliedRow[];
  rejected: RejectedRow[];
}

export interface PdfFootnotesOptions {
  pdfPath: string;
  /** Write the report and leave the document alone — the measuring pass. */
  dryRun: boolean;
  /** What weights answered. Recorded, never used to decide anything. */
  model: string;
  generate: FootnoteGenerator;
  log: (message: string) => void;
}

export interface PdfFootnotesResult {
  report: PdfFootnotesReport;
  /** The file's length after the update, or null on a dry run. */
  boundary: number | null;
}

export async function runPdfFootnotes(options: PdfFootnotesOptions): Promise<PdfFootnotesResult> {
  const working = await WorkingPdf.open(options.pdfPath);
  const marker = working.marker();

  if (marker.documentClass !== 'scanned') {
    throw new FootnotesDocumentError(
      `${options.pdfPath} is a ${marker.documentClass}-class working document: its text layer is the `
      + 'publisher\'s, not one foundry wrote. Rewriting somebody else\'s page description from a '
      + 'parse of it would re-lay-out the book, which is worse than a marker left in. Export it '
      + 'first and run `foundry footnotes --epub`, where the markers are markup.',
    );
  }

  const bytes = new Uint8Array(await Bun.file(options.pdfPath).arrayBuffer());
  const extracted = await extractDocument(bytes, { dpi: marker.dpi });

  const frames = new Map<number, PageFrame>();
  const lines: ScanLine[] = [];
  const perPage = new Map<number, ScanLine[]>();
  for (const page of extracted.pages) {
    const node = working.doc.getPage(page.frame.page).node;
    if (!hasTextLayer(node)) {
      throw new FootnotesDocumentError(
        `page ${page.frame.page + 1} of ${options.pdfPath} has no foundry text layer to rewrite. `
        + 'A scanned working document carries one on every page from the moment `get-text` casts it.',
      );
    }
    const crop = working.doc.getPage(page.frame.page).getCropBox();
    frames.set(page.frame.page, {
      page: page.frame.page,
      widthPx: page.frame.widthPx,
      heightPx: page.frame.heightPx,
      widthPt: crop.width,
      heightPt: crop.height,
      offsetXPt: crop.x,
      offsetYPt: crop.y,
      deskewDeg: page.frame.deskewDeg,
    });
    const mine: ScanLine[] = page.lines.map((line, i) => ({
      id: `p${String(page.frame.page).padStart(4, '0')}l${String(i).padStart(4, '0')}`,
      page: page.frame.page,
      bbox: line.box,
      text: line.text,
      conf: null,
    }));
    perPage.set(page.frame.page, mine);
    lines.push(...mine);
  }

  const blocks = readBlockAnnotations(working.doc, frames);
  if (blocks.length === 0) {
    throw new FootnotesDocumentError(
      `${options.pdfPath} carries no block annotations, so nothing in it is known to be prose. `
      + 'Run `foundry blocks --run <dir> --pdf <this file>` first: this stage asks about body text '
      + 'and never about running heads, and the categories are what tells them apart.',
    );
  }

  const assignment = assignLinesToBlocks(lines, blocks);
  const byId = new Map(lines.map(l => [l.id, l] as const));
  const prose: Array<{ block: BlockAnnotation; lineIds: string[]; text: string }> = [];
  for (const block of blocks) {
    if (block.deleted || NON_PROSE.has(block.category)) continue;
    const lineIds = assignment.get(block.id)!;
    // The block's text as the applier sees it: its lines, newline-joined. That
    // is the same shape run mode builds, so the model sees one surface.
    const text = lineIds.map(id => byId.get(id)!.text).join('\n');
    if (text.trim().length === 0) continue;
    prose.push({ block, lineIds, text });
  }
  options.log(`footnotes: ${prose.length} prose blocks of ${blocks.length}`);

  const plan = await planFootnotes(
    prose.map(p => p.text),
    options.generate,
    { onProgress: (done, total) => options.log(`  footnotes: ${done}/${total} units`) },
  );

  const applied: AppliedRow[] = [];
  const rejected: RejectedRow[] = [];
  const rewritten = new Map<string, string>();
  let blocksEdited = 0;

  for (const entry of prose) {
    const deletions = plan.get(entry.text);
    if (!deletions || deletions.length === 0) continue;

    // Applied ONE AT A TIME so the report can say which deletions landed rather
    // than just how many. Identical to the bulk call: the applier edits the
    // first remaining occurrence in document order.
    let text = entry.text;
    let landed = 0;
    for (const deletion of deletions) {
      const result = applyFootnoteDeletions(text, [deletion]);
      if (result.rejected) {
        rejected.push({
          blockId: entry.block.id,
          before: deletion.before,
          after: deletion.after,
          reason: 'the applier refused it: `after` is not `before` with characters deleted, or '
            + '`before` is not in the block verbatim',
        });
        continue;
      }
      applied.push({
        blockId: entry.block.id,
        category: entry.block.category,
        page: entry.block.page,
        removed: removedCharacters(deletion),
        context: contextAround(result.text, deletion),
        before: deletion.before,
        after: deletion.after,
      });
      text = result.text;
      landed++;
    }
    if (landed === 0) continue;
    blocksEdited++;

    // Back to LINES. The deletions were projected onto a newline-joined text
    // and a deletion never inserts a newline, so splitting restores exactly the
    // line structure they were computed against — which is what the text layer
    // is written from.
    const parts = text.split('\n');
    if (parts.length !== entry.lineIds.length) {
      throw new FootnotesDocumentError(
        `block ${entry.block.id} had ${entry.lineIds.length} lines and its rewritten text has `
        + `${parts.length}. A marker deletion can only remove characters, so the two cannot differ — `
        + 'this block\'s text and its lines are out of step.',
      );
    }
    entry.lineIds.forEach((id, i) => rewritten.set(id, parts[i]));
  }

  const report: PdfFootnotesReport = {
    pdf: options.pdfPath,
    dryRun: options.dryRun,
    generatedAt: new Date().toISOString(),
    model: options.model,
    totals: {
      blocks: blocks.length,
      prose: prose.length,
      blocksEdited,
      applied: applied.length,
      rejected: rejected.length,
      linesRewritten: rewritten.size,
    },
    applied,
    rejected,
  };

  if (options.dryRun || rewritten.size === 0) {
    options.log(
      `footnotes: ${applied.length} markers would be removed from ${blocksEdited} blocks, `
      + `${rejected.length} edits refused by the guards`
      + `${options.dryRun ? ' — dry run, the document is untouched' : ''}`,
    );
    return { report, boundary: null };
  }

  // ── the rewrite: one incremental update for the whole book ────────────────
  for (const [pageIndex, pageLines] of perPage) {
    if (!pageLines.some(l => rewritten.has(l.id))) continue;
    const node: PDFDict = working.doc.getPage(pageIndex).node;
    const next: TextLayerLine[] = pageLines.map(l => ({
      text: rewritten.get(l.id) ?? l.text,
      box: l.bbox,
    }));
    const ref = rewriteTextLayer(working.doc, node, frames.get(pageIndex)!, next);
    working.markChanged(ref);
  }
  const boundary = await working.appendUpdate();

  options.log(
    `footnotes: ${applied.length} markers removed from ${blocksEdited} blocks, `
    + `${rejected.length} edits refused by the guards — ${rewritten.size} lines rewritten, `
    + `boundary ${boundary}`,
  );
  return { report, boundary };
}

/** What the deletion took out — the model's own before/after, differenced. */
function removedCharacters(deletion: FootnoteDeletion): string {
  let removed = '';
  let j = 0;
  for (let i = 0; i < deletion.before.length; i++) {
    if (j < deletion.after.length && deletion.before[i] === deletion.after[j]) { j++; continue; }
    removed += deletion.before[i];
  }
  return removed;
}

const CONTEXT = 80;

/**
 * `…anchor [REMOVED: "1"] following…`, whitespace collapsed.
 *
 * The context is taken from the text AFTER the deletion landed, so what is
 * shown is what the book will say with the marker gone — which is the thing a
 * reviewer is judging.
 */
function contextAround(text: string, deletion: FootnoteDeletion): string {
  const at = text.indexOf(deletion.after);
  const collapse = (s: string): string => s.replace(/\s+/g, ' ');
  if (at === -1) return collapse(deletion.after);
  const before = collapse(text.slice(Math.max(0, at - CONTEXT), at));
  const after = collapse(text.slice(at + deletion.after.length, at + deletion.after.length + CONTEXT));
  return `${before}${collapse(deletion.after)} [REMOVED: "${removedCharacters(deletion)}"]${after}`;
}
