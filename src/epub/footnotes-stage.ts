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

import { planFootnotes, type FootnoteGenerator } from '../footnotes/applier.js';
import { requireUtf8, writeEditedEpub } from './archive.js';
import {
  isIndexDocument, proseUnits, projectDeletions, spliceSource, type ProseUnit,
} from './document.js';
import { readEpubPackage } from './package.js';
import { parseXml } from './xml.js';
import { entryText, readZip, type ZipReadEntry } from './zip-read.js';

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export interface FootnoteCounts {
  /** Prose units found (`<p>`, `<blockquote>`). */
  units: number;
  /** Units skipped because the whole unit was one hyperlink — a TOC line. */
  unitsNavigation: number;
  /** Units skipped because they open with an intra-book back-link — note bodies. */
  unitsNoteBody: number;
  /**
   * Units skipped because they are index entries: index-shaped AND in a
   * document dense enough with index-shaped units to BE an index.
   */
  unitsIndex: number;
  /**
   * Units matching the index SHAPE, whether or not they were skipped.
   *
   * Reported so the gate is legible: a document with a high count and
   * `indexDocument: false` is an index this run decided to ask about anyway,
   * and a reader of the report can see it rather than deduce it.
   */
  unitsIndexShaped: number;
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
  /** Did the density gate call this document an index? */
  indexDocument: boolean;
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
  /** Were the note-body and index skips turned off for this run? */
  askEverything: boolean;
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
  /**
   * Ask about note bodies and index entries too — `--ask-everything`.
   *
   * The two skips are ON by default because the units they remove are, in the
   * measured books, entirely false-fire risk: a note body's leading number is
   * the note's own label and an index entry's trailing numbers are page
   * references, and neither is a marker a narrator would read out. The flag
   * exists because that is a judgement about books, not a law about them.
   */
  askEverything?: boolean;
  log?: (message: string) => void;
}

function emptyCounts(): FootnoteCounts {
  return {
    units: 0, unitsNavigation: 0, unitsNoteBody: 0, unitsIndex: 0, unitsIndexShaped: 0,
    unitsAsked: 0, unitsFired: 0,
    deletionsProposed: 0, deletionsApplied: 0, deletionsRejected: 0, elementsRemoved: 0,
  };
}

function addCounts(into: FootnoteCounts, from: FootnoteCounts): void {
  into.units += from.units;
  into.unitsNavigation += from.unitsNavigation;
  into.unitsNoteBody += from.unitsNoteBody;
  into.unitsIndex += from.unitsIndex;
  into.unitsIndexShaped += from.unitsIndexShaped;
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
  indexDocument: boolean;
}

/**
 * Which units of one document go to the model, and why the rest did not.
 *
 * Every unit falls in exactly ONE bucket, in this order — navigation, note
 * body, index entry, asked — so the four counts add up to the units that have
 * any text at all, and no unit is skipped twice or skipped silently.
 */
function selectUnits(
  units: readonly ProseUnit[],
  askEverything: boolean,
): { asked: ProseUnit[]; counts: FootnoteCounts; indexDocument: boolean } {
  const counts = emptyCounts();
  counts.units = units.length;
  counts.unitsNavigation = units.filter((u) => u.linkOnly).length;

  let candidates = units.filter((u) => !u.linkOnly && u.text.trim().length > 0);
  if (!askEverything) {
    counts.unitsNoteBody = candidates.filter((u) => u.noteBody).length;
    candidates = candidates.filter((u) => !u.noteBody);
  }

  counts.unitsIndexShaped = candidates.filter((u) => u.indexShaped).length;
  const indexDocument = !askEverything && isIndexDocument(candidates);
  if (indexDocument) {
    counts.unitsIndex = counts.unitsIndexShaped;
    candidates = candidates.filter((u) => !u.indexShaped);
  }

  counts.unitsAsked = candidates.length;
  return { asked: candidates, counts, indexDocument };
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
  const askEverything = options.askEverything === true;
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
    const source = requireUtf8('footnotes', doc.path, entryText(byPath.get(doc.path)!));
    let units: ProseUnit[];
    try {
      units = proseUnits(parseXml(source), source);
    } catch (e) {
      throw new Error(`footnotes: ${doc.path} cannot be parsed: ${(e as Error).message}`);
    }
    const selected = selectUnits(units, askEverything);
    docs.push({
      path: doc.path,
      source,
      units: selected.asked,
      counts: selected.counts,
      indexDocument: selected.indexDocument,
    });
    if (selected.indexDocument) {
      log(`  footnotes: ${doc.path} is an index — ${selected.counts.unitsIndex} entries not asked about`);
    }
  }

  const texts: string[] = [];
  for (const doc of docs) for (const unit of doc.units) texts.push(unit.text);
  const total = texts.length;
  const skippedNav = docs.reduce((a, d) => a + d.counts.unitsNavigation, 0);
  const skippedNote = docs.reduce((a, d) => a + d.counts.unitsNoteBody, 0);
  const skippedIndex = docs.reduce((a, d) => a + d.counts.unitsIndex, 0);
  log(
    `footnotes: ${total} prose units to ask about `
    + `(skipped ${skippedNav} navigation, ${skippedNote} note bodies, ${skippedIndex} index entries`
    + `${askEverything ? '; --ask-everything is on, so only navigation was skipped' : ''})`,
  );

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
    documents.push({ path: doc.path, edited, indexDocument: doc.indexDocument, ...doc.counts });
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
    askEverything,
    totals,
    skipped: pkg.skipped,
    documents,
    applied,
    rejected,
    removedElements,
  };
}
