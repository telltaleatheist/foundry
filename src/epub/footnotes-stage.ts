/**
 * footnotes-stage (EPUB mode) — strip inline reference markers from a book that
 * is already a book.
 *
 * `foundry footnotes --run <dir>` reads a scan foundry made. This reads an EPUB
 * somebody else made, which is the case where the markers were never OCR debris
 * to begin with: they are `<sup><a href="#fn3">3</a></sup>`, welded into
 * publisher markup, and a narrator reads them out loud as numbers.
 *
 * NOTHING ABOUT THE MODEL PATH IS DIFFERENT HERE. The same
 * `planFootnotes(texts, generate)` seam, the same prompt, the same
 * subsequence-guarded applier, the same stop token. That was the design: the
 * applier's own doc comment names `texts` as the block-iteration seam because
 * this loop used to walk EPUB chapters before it walked scan blocks. What is new
 * is only the walking and the PROJECTION — text offsets back onto markup — and
 * that lives in `document.ts`.
 *
 * The output rules:
 *
 *  - **The input file is never written to.** The output is a separate archive,
 *    and `--dry-run` writes no archive at all.
 *  - **A document with no applied deletion is copied through with the bytes it
 *    arrived with**, still deflated, never re-serialized. So a diff between the
 *    input and the output is exactly the set of paragraphs that changed.
 *  - **The report is the product of a dry run.** Every applied deletion with its
 *    surrounding text, and every refused line verbatim with the reason — because
 *    the number that decides whether this model may be pointed at a library is
 *    the false-fire rate, and that is a judgement a human makes by reading
 *    (ARCHITECTURE §7).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { planFootnotes, type FootnoteGenerator } from '../footnotes/applier.js';
import { crc32, writeZip, type ZipEntry } from '../export/zip.js';
import { proseUnits, projectDeletions, spliceSource, type ProseUnit } from './document.js';
import { readEpubPackage } from './package.js';
import { parseXml } from './xml.js';
import { entryText, readZip, METHOD_DEFLATE, type ZipReadEntry } from './zip-read.js';

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export interface FootnoteCounts {
  /** Prose units found (`<p>`, `<blockquote>`). */
  units: number;
  /** Units skipped because the whole unit was one hyperlink — a TOC line. */
  unitsNavigation: number;
  /** Units actually put to the model. */
  unitsAsked: number;
  /** Units the model proposed at least one deletion for. */
  unitsFired: number;
  deletionsProposed: number;
  deletionsApplied: number;
  deletionsRejected: number;
  /** Inline elements removed because a deletion left them with no text. */
  elementsRemoved: number;
}

export interface DocumentReport extends FootnoteCounts {
  path: string;
  /** Did this document's bytes change? */
  edited: boolean;
}

export interface AppliedRow {
  document: string;
  /** The characters removed. */
  removed: string;
  /** `…anchor [REMOVED: "1"] following…` — whitespace collapsed, ~80 chars each side. */
  context: string;
  /** The model's line, verbatim. */
  before: string;
  after: string;
}

export interface RejectedRow {
  document: string;
  /** The model's line, verbatim — this is the thing to read. */
  before: string;
  after: string;
  reason: string;
}

export interface RemovedElementRow {
  document: string;
  tag: string;
  /** The element's markup, as it was in the book. */
  source: string;
  /**
   * Every id inside the removed span. A non-empty list means a link that
   * pointed here — a "return to text" arrow in the notes section — now points
   * at nothing. That is the cost of removing the marker it was attached to, and
   * it is counted rather than hidden.
   */
  ids: string[];
}

export interface EpubFootnotesReport {
  epub: string;
  output: string | null;
  dryRun: boolean;
  generatedAt: string;
  model: string;
  totals: FootnoteCounts & { documents: number; documentsEdited: number };
  /** Spine items not read, and why. */
  skipped: Array<{ path: string; why: string }>;
  documents: DocumentReport[];
  applied: AppliedRow[];
  rejected: RejectedRow[];
  removedElements: RemovedElementRow[];
}

export interface EpubFootnotesOptions {
  epubPath: string;
  /** Where the edited EPUB goes, or null for a dry run. */
  outputPath: string | null;
  /** What weights answered — recorded in the report, never used to decide anything. */
  model: string;
  generate: FootnoteGenerator;
  log?: (message: string) => void;
}

function emptyCounts(): FootnoteCounts {
  return {
    units: 0, unitsNavigation: 0, unitsAsked: 0, unitsFired: 0,
    deletionsProposed: 0, deletionsApplied: 0, deletionsRejected: 0, elementsRemoved: 0,
  };
}

function addCounts(into: FootnoteCounts, from: FootnoteCounts): void {
  into.units += from.units;
  into.unitsNavigation += from.unitsNavigation;
  into.unitsAsked += from.unitsAsked;
  into.unitsFired += from.unitsFired;
  into.deletionsProposed += from.deletionsProposed;
  into.deletionsApplied += from.deletionsApplied;
  into.deletionsRejected += from.deletionsRejected;
  into.elementsRemoved += from.elementsRemoved;
}

interface LoadedDocument {
  path: string;
  source: string;
  units: ProseUnit[];
  counts: FootnoteCounts;
}

/**
 * Run the footnotes stage over an EPUB.
 *
 * One planning pass over the WHOLE book, in reading order, and then the edits.
 * Reading order matters twice: `planFootnotes` dedupes identical texts, and the
 * applier lands each deletion on the first remaining occurrence of its anchor.
 */
export async function runEpubFootnotes(options: EpubFootnotesOptions): Promise<EpubFootnotesReport> {
  const log = options.log ?? ((): void => {});
  const inputPath = path.resolve(options.epubPath);
  const outputPath = options.outputPath === null ? null : path.resolve(options.outputPath);
  if (outputPath !== null && outputPath === inputPath) {
    throw new Error(
      `footnotes: --output is the input file (${inputPath}). The source book is never written to.`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(inputPath));
  } catch (e) {
    throw new Error(`footnotes: cannot read ${inputPath}: ${(e as Error).message}`);
  }

  const archive = readZip(bytes);
  const byPath = new Map<string, ZipReadEntry>(archive.map((e) => [e.path, e]));
  const pkg = readEpubPackage(byPath);
  log(`footnotes: ${pkg.documents.length} spine documents in ${path.basename(inputPath)}`);
  for (const s of pkg.skipped) log(`  footnotes: skipping ${s.path} — ${s.why}`);

  // ── read every document, in reading order ────────────────────────────────
  const docs: LoadedDocument[] = [];
  for (const doc of pkg.documents) {
    const source = entryText(byPath.get(doc.path)!);
    let units: ProseUnit[];
    try {
      units = proseUnits(parseXml(source), source);
    } catch (e) {
      throw new Error(`footnotes: ${doc.path} cannot be parsed: ${(e as Error).message}`);
    }
    const counts = emptyCounts();
    counts.units = units.length;
    counts.unitsNavigation = units.filter((u) => u.linkOnly).length;
    const asked = units.filter((u) => !u.linkOnly && u.text.trim().length > 0);
    counts.unitsAsked = asked.length;
    docs.push({ path: doc.path, source, units: asked, counts });
  }

  const texts: string[] = [];
  for (const doc of docs) for (const unit of doc.units) texts.push(unit.text);
  const total = texts.length;
  log(`footnotes: ${total} prose units to ask about`);

  const plan = await planFootnotes(texts, options.generate, {
    onProgress: (done, all) => log(`  footnotes: ${done}/${all} units`),
  });

  // ── project the plan onto the markup ─────────────────────────────────────
  const applied: AppliedRow[] = [];
  const rejected: RejectedRow[] = [];
  const removedElements: RemovedElementRow[] = [];
  const documents: DocumentReport[] = [];
  const outputText = new Map<string, string>();

  for (const doc of docs) {
    const ranges: Array<{ start: number; end: number }> = [];
    for (const unit of doc.units) {
      const deletions = plan.get(unit.text);
      if (!deletions || deletions.length === 0) continue;
      doc.counts.unitsFired++;
      doc.counts.deletionsProposed += deletions.length;

      const projection = projectDeletions(unit, deletions, doc.source);
      doc.counts.deletionsApplied += projection.applied.length;
      doc.counts.deletionsRejected += projection.rejected.length;
      doc.counts.elementsRemoved += projection.emptied.length;
      ranges.push(...projection.ranges);

      for (const a of projection.applied) {
        applied.push({
          document: doc.path,
          removed: a.removed,
          context: a.context,
          before: a.deletion.before,
          after: a.deletion.after,
        });
      }
      for (const r of projection.rejected) {
        rejected.push({
          document: doc.path,
          before: r.deletion.before,
          after: r.deletion.after,
          reason: r.reason,
        });
      }
      for (const el of projection.emptied) {
        removedElements.push({ document: doc.path, tag: el.tag, source: el.source, ids: el.ids });
      }
    }

    const edited = ranges.length > 0;
    if (edited) outputText.set(doc.path, spliceSource(doc.source, ranges));
    documents.push({ path: doc.path, edited, ...doc.counts });
  }

  const totals = { ...emptyCounts(), documents: docs.length, documentsEdited: 0 };
  for (const doc of documents) {
    addCounts(totals, doc);
    if (doc.edited) totals.documentsEdited++;
  }

  log(
    `footnotes: ${totals.deletionsApplied} markers removed across ${totals.documentsEdited} documents, `
    + `${totals.deletionsRejected} edits refused by the guards, `
    + `${totals.elementsRemoved} emptied elements removed`,
  );

  // ── write the book, unless this was a dry run ────────────────────────────
  if (outputPath !== null) {
    writeEditedEpub(archive, outputText, outputPath);
    log(`footnotes: wrote ${outputPath}`);
  }

  return {
    epub: inputPath,
    output: outputPath,
    dryRun: outputPath === null,
    generatedAt: new Date().toISOString(),
    model: options.model,
    totals,
    skipped: pkg.skipped,
    documents,
    applied,
    rejected,
    removedElements,
  };
}

/**
 * Write the archive back out, with only the edited documents replaced.
 *
 * Every other entry keeps its payload, its method and its CRC exactly — the
 * writer copies the compressed bytes rather than round-tripping them — and the
 * entry ORDER is the input's, which is what keeps a `mimetype`-first EPUB
 * `mimetype`-first.
 *
 * The edited documents are re-deflated here, in the stage, not in the writer:
 * `src/export/zip.ts` has no compressor and is not getting one. Written to a
 * temporary file and renamed, so an interrupted run leaves no half-EPUB with a
 * book's name on it.
 */
function writeEditedEpub(
  archive: readonly ZipReadEntry[],
  edited: ReadonlyMap<string, string>,
  outputPath: string,
): void {
  const entries: ZipEntry[] = archive.map((entry) => {
    const text = edited.get(entry.path);
    if (text === undefined) {
      return {
        path: entry.path,
        data: entry.raw,
        method: entry.method === METHOD_DEFLATE ? 8 : 0,
        crc: entry.crc,
        uncompressedSize: entry.uncompressedSize,
      } as ZipEntry;
    }
    const plain = new TextEncoder().encode(text);
    if (entry.method !== METHOD_DEFLATE) {
      return { path: entry.path, data: plain };
    }
    return {
      path: entry.path,
      data: new Uint8Array(deflateRawSync(plain)),
      method: 8,
      crc: crc32(plain),
      uncompressedSize: plain.length,
    };
  });

  const out = writeZip(entries);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.partial`;
  fs.writeFileSync(staging, out);
  fs.renameSync(staging, outputPath);
}
