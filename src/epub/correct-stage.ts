/**
 * correct-stage (EPUB mode) — repair the words of a book that is already a book.
 *
 * `foundry ocr-correct --epub` is the ONLY correction the pipeline offers.
 * Correction lives on the EPUB because that is where every text transformation
 * lives, and because correction buried inside `reflow` is invisible,
 * un-re-runnable and un-reviewable: it happens once, on the way past, and
 * nothing comes out of it that a person can read. The planned PDF text-layer
 * correction mode is DROPPED — the working PDF's text is never edited.
 *
 * NOTHING ABOUT THE MODEL PATH IS DIFFERENT HERE. The same `repairLines` seam
 * from `src/ocr/stage.ts`, the same prompt sent verbatim, the same per-word
 * guard, the same edit derivation and applier round-trip. Two implementations of
 * "repair a line" is the same failure as two copies of a prompt format, and this
 * file contains none of it. What is new is the UNIT (a sentence —
 * `src/ocr/sentences.ts`) and the PROJECTION back onto markup
 * (`correct-document.ts`).
 *
 * ## Offered on every book, never refused
 *
 * An earlier draft refused a book whose text is the publisher's, on the grounds
 * that those words are not OCR output. Owen's counter-example kills it: a book
 * can have been converted from a PDF before it was ever imported, our knowledge
 * of provenance is incomplete, and the error class is identical either way. So
 * the caveat is SAID — in the log and in the report — and the door is not shut.
 *
 * ## The output rules, which are the footnotes stage's
 *
 *  - **The input file is never written to.** The output is a separate archive,
 *    and `--dry-run` writes no archive at all.
 *  - **A document with no applied edit is copied through with the bytes it
 *    arrived with.** So a diff between the input and the output is exactly the
 *    set of paragraphs that changed.
 *  - **The report is the product.** Every correction with its surrounding text,
 *    and every refusal verbatim with the reason — because the number that
 *    decides whether this model may be pointed at a library is one a human
 *    reaches by reading (ARCHITECTURE §7).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repairLines, type OcrGenerate } from '../ocr/stage.js';
import { correctionUnits, CORRECTION_UNIT_MAX_CHARS, type TextUnit } from '../ocr/sentences.js';
import { requireUtf8, writeEditedEpub } from './archive.js';
import {
  correctableUnits, projectCorrections, spliceReplacements, type SourceReplacement,
} from './correct-document.js';
import type { ProseUnit } from './document.js';
import { readEpubPackage } from './package.js';
import { parseXml, type XmlElement } from './xml.js';
import { entryText, readZip, type ZipReadEntry } from './zip-read.js';

/**
 * The caveat, in the report as well as the log.
 *
 * In the report because the report is what a reviewer reads a month later, by
 * which time nobody remembers which button was pressed on which book.
 */
export const PUBLISHER_TEXT_CAVEAT =
  'Correction is offered on every book. If this EPUB\'s text is the publisher\'s own, '
  + 'it has no OCR errors to repair and every change below is the model editing an author. '
  + 'Provenance is not knowable from the file — a book converted from a PDF before import '
  + 'looks the same — so the run is not refused; read the report.';

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export interface CorrectionCounts {
  /** Correctable block elements found (`<p>`, `<h2>`, `<li>`, `<td>`, …). */
  units: number;
  /** Units skipped because the whole unit was one hyperlink — a TOC line. */
  unitsNavigation: number;
  /** Units skipped because they hold no text at all. */
  unitsEmpty: number;
  /** Units the model was asked about, in one or more sentences each. */
  unitsAsked: number;
  /** Sentence units put to the model — one prompt each. */
  sentences: number;
  /**
   * Sentence units that exceeded the cap because a single word did.
   *
   * Counted because it is the one place the packing rule is overruled, and a
   * book with many of them is a book whose text is not what it looks like.
   */
  sentencesOverCap: number;
  /** Sentences the model changed and every guard accepted. */
  sentencesCorrected: number;
  /** Sentences whose output a guard refused. Harmless to the text; never silent. */
  sentencesRefused: number;
  /** Corrections written into the markup. */
  editsApplied: number;
  /** Accepted corrections the PROJECTION refused — markup, entities, CDATA. */
  editsRejected: number;
}

export interface DocumentReport extends CorrectionCounts {
  path: string;
  /** Did this document's bytes change? */
  edited: boolean;
}

/** Where in the book a correction landed, when the book says. */
export interface Provenance {
  /**
   * `data-bf-blocks` — the block ids this element was rendered from, which are
   * the same ids the working PDF's annotations carry. Empty for a book foundry
   * did not build: those attributes are v0.5.0's and a publisher's EPUB has
   * none, which is a real absence and not a missing value to invent.
   */
  blocks: string;
  /** `data-bf-category` — what the blocks model called it. */
  category: string;
}

export interface AppliedRow extends Provenance {
  document: string;
  before: string;
  after: string;
  /** `…the [was "tbe" now "the"] point…` — whitespace collapsed, ~80 chars each side. */
  context: string;
}

export interface RejectedRow extends Provenance {
  document: string;
  /** The sentence as it was sent. */
  asked: string;
  /** The model's answer, verbatim — this is the thing to read. */
  answer: string;
  reason: string;
}

export interface EpubCorrectionReport {
  epub: string;
  output: string | null;
  dryRun: boolean;
  generatedAt: string;
  model: string;
  /** The packing cap the sentences were cut to. */
  unitMaxChars: number;
  caveat: string;
  totals: CorrectionCounts & { documents: number; documentsEdited: number };
  /** Spine items not read, and why. */
  skipped: Array<{ path: string; why: string }>;
  documents: DocumentReport[];
  applied: AppliedRow[];
  rejected: RejectedRow[];
}

export interface EpubCorrectionOptions {
  epubPath: string;
  /** Where the corrected EPUB goes, or null for a dry run. */
  outputPath: string | null;
  /** What weights answered — recorded in the report, never used to decide anything. */
  model: string;
  generate: OcrGenerate;
  /** The sentence packing cap. Exposed for tests and measurement, not for tuning. */
  maxChars?: number;
  log?: (message: string) => void;
}

function emptyCounts(): CorrectionCounts {
  return {
    units: 0, unitsNavigation: 0, unitsEmpty: 0, unitsAsked: 0,
    sentences: 0, sentencesOverCap: 0, sentencesCorrected: 0, sentencesRefused: 0,
    editsApplied: 0, editsRejected: 0,
  };
}

function addCounts(into: CorrectionCounts, from: CorrectionCounts): void {
  into.units += from.units;
  into.unitsNavigation += from.unitsNavigation;
  into.unitsEmpty += from.unitsEmpty;
  into.unitsAsked += from.unitsAsked;
  into.sentences += from.sentences;
  into.sentencesOverCap += from.sentencesOverCap;
  into.sentencesCorrected += from.sentencesCorrected;
  into.sentencesRefused += from.sentencesRefused;
  into.editsApplied += from.editsApplied;
  into.editsRejected += from.editsRejected;
}

/**
 * What the book says this element is, walking outwards.
 *
 * The stamps sit on the OUTERMOST element of a rendered group (`export/epub.ts`)
 * — the `<blockquote>`, not the `<p>` inside it — so the nearest ancestor
 * carrying them is the one that describes this unit.
 */
function provenanceOf(element: XmlElement): Provenance {
  for (let el: XmlElement | null = element; el; el = el.parent) {
    const blocks = el.attrs.get('data-bf-blocks');
    const category = el.attrs.get('data-bf-category');
    if (blocks !== undefined || category !== undefined) {
      return { blocks: blocks ?? '', category: category ?? '' };
    }
  }
  return { blocks: '', category: '' };
}

/** One sentence of one unit of one document, as it travels to the model and back. */
interface Sentence {
  id: string;
  document: number;
  unit: number;
  span: TextUnit;
}

interface LoadedDocument {
  path: string;
  source: string;
  units: ProseUnit[];
  /** Index into `units` for each unit that is actually asked about. */
  asked: number[];
  counts: CorrectionCounts;
}

/**
 * Run the correction stage over an EPUB.
 *
 * One pass to read and cut the whole book into sentences, one pass through the
 * model, one pass to project the answers back onto the markup. Reading order is
 * kept throughout so a progress count means what it looks like.
 */
export async function runEpubCorrection(
  options: EpubCorrectionOptions,
): Promise<EpubCorrectionReport> {
  const log = options.log ?? ((): void => {});
  const maxChars = options.maxChars ?? CORRECTION_UNIT_MAX_CHARS;
  const inputPath = path.resolve(options.epubPath);
  const outputPath = options.outputPath === null ? null : path.resolve(options.outputPath);
  if (outputPath !== null && outputPath === inputPath) {
    throw new Error(
      `ocr-correct: --output is the input file (${inputPath}). The source book is never written to.`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(inputPath));
  } catch (e) {
    throw new Error(`ocr-correct: cannot read ${inputPath}: ${(e as Error).message}`);
  }

  const archive = readZip(bytes);
  const byPath = new Map<string, ZipReadEntry>(archive.map((e) => [e.path, e]));
  const pkg = readEpubPackage(byPath);
  log(`ocr-correct: ${pkg.documents.length} spine documents in ${path.basename(inputPath)}`);
  for (const s of pkg.skipped) log(`  ocr-correct: skipping ${s.path} — ${s.why}`);
  log(`ocr-correct: ${PUBLISHER_TEXT_CAVEAT}`);

  // ── read every document and cut it into sentences ────────────────────────
  const docs: LoadedDocument[] = [];
  const sentences: Sentence[] = [];
  for (const doc of pkg.documents) {
    const source = requireUtf8('ocr-correct', doc.path, entryText(byPath.get(doc.path)!));
    let units: ProseUnit[];
    try {
      units = correctableUnits(parseXml(source), source);
    } catch (e) {
      throw new Error(`ocr-correct: ${doc.path} cannot be parsed: ${(e as Error).message}`);
    }

    const counts = emptyCounts();
    counts.units = units.length;
    const asked: number[] = [];
    const index = docs.length;
    for (let u = 0; u < units.length; u++) {
      const unit = units[u]!;
      // Every unit falls in exactly ONE bucket, so the three counts add up to
      // `units` and nothing is skipped twice or skipped silently.
      if (unit.linkOnly) { counts.unitsNavigation++; continue; }
      if (unit.text.trim().length === 0) { counts.unitsEmpty++; continue; }
      const spans = correctionUnits(unit.text, maxChars);
      if (spans.length === 0) { counts.unitsEmpty++; continue; }
      asked.push(u);
      counts.unitsAsked++;
      spans.forEach((span, s) => {
        counts.sentences++;
        if (span.text.length > maxChars) counts.sentencesOverCap++;
        sentences.push({ id: `d${index}u${u}s${s}`, document: index, unit: u, span });
      });
    }
    docs.push({ path: doc.path, source, units, asked, counts });
  }

  const total = sentences.length;
  const overCap = docs.reduce((n, d) => n + d.counts.sentencesOverCap, 0);
  log(
    `ocr-correct: ${total} sentence units to correct, cut at ${maxChars} characters`
    + `${overCap > 0 ? ` (${overCap} exceed it because a single word does)` : ''}`,
  );
  if (total === 0) {
    throw new Error(
      `ocr-correct: ${inputPath} has no correctable text. Its spine documents hold no `
      + '<p>, <div>, heading, list item or table cell with words in it — that is not a book '
      + 'this stage can repair, and writing an unchanged copy of it would say it corrected one.',
    );
  }

  const result = await repairLines({
    lines: sentences.map((s) => ({ id: s.id, text: s.span.text })),
    generate: options.generate,
    onProgress: (done, all) => {
      if (done % 100 === 0) log(`  ocr-correct: ${done}/${all} sentences`);
    },
  });
  const byId = new Map(result.lines.map((l) => [l.id, l]));
  // The sentences of one unit, in reading order — the shape the projection needs.
  const byUnit = new Map<string, Sentence[]>();
  for (const s of sentences) {
    const key = `${s.document}:${s.unit}`;
    const list = byUnit.get(key);
    if (list) list.push(s); else byUnit.set(key, [s]);
  }

  // ── project the answers back onto the markup ─────────────────────────────
  const applied: AppliedRow[] = [];
  const rejected: RejectedRow[] = [];
  const documents: DocumentReport[] = [];
  const outputText = new Map<string, string>();

  for (let d = 0; d < docs.length; d++) {
    const doc = docs[d]!;
    const replacements: SourceReplacement[] = [];

    for (const u of doc.asked) {
      const unit = doc.units[u]!;
      const where = provenanceOf(unit.element);
      const edits: Array<{ edit: { before: string; after: string }; at: number }> = [];

      // Every unit in `asked` produced at least one sentence — that is what put
      // it there — so an absence is the cut and the ask having parted company.
      const inUnit = byUnit.get(`${d}:${u}`);
      if (!inUnit) {
        throw new Error(
          `ocr-correct: unit ${u} of ${doc.path} was asked about but no sentence was cut from it.`,
        );
      }
      for (const sentence of inUnit) {
        const line = byId.get(sentence.id);
        if (!line) {
          throw new Error(
            `ocr-correct: the repair stage returned no answer for ${sentence.id}. Every line goes `
            + 'in and every line comes back, in order, so a missing one is a broken wire.',
          );
        }
        for (const r of line.rejected) {
          doc.counts.sentencesRefused++;
          rejected.push({
            document: doc.path, ...where,
            asked: sentence.span.text, answer: r.before, reason: r.why,
          });
        }
        if (line.edits.length === 0) continue;
        doc.counts.sentencesCorrected++;
        for (const edit of line.edits) {
          // `deriveEdits` guarantees the anchor occurs exactly once in the text
          // it was derived against — this sentence — so its offset inside the
          // unit is that index plus where the sentence starts. Found here rather
          // than passed through the repair stage, which is line-shaped by design
          // and must not grow an offset field for one caller.
          const at = sentence.span.text.indexOf(edit.before);
          if (at < 0) {
            throw new Error(
              `ocr-correct: the derived anchor "${edit.before}" is not in the sentence it was `
              + `derived from (${sentence.id} of ${doc.path}). deriveEdits guarantees it occurs `
              + 'exactly once, so this is a bug in the edit contract, not a bad answer.',
            );
          }
          edits.push({ edit, at: sentence.span.start + at });
        }
      }

      if (edits.length === 0) continue;
      const projection = projectCorrections(unit, edits, doc.source);
      doc.counts.editsApplied += projection.applied.length;
      doc.counts.editsRejected += projection.rejected.length;
      replacements.push(...projection.replacements);

      for (const a of projection.applied) {
        applied.push({
          document: doc.path, ...where,
          before: a.edit.before, after: a.edit.after, context: a.context,
        });
      }
      for (const r of projection.rejected) {
        rejected.push({
          document: doc.path, ...where,
          asked: unit.text, answer: `${r.edit.before} → ${r.edit.after}`, reason: r.reason,
        });
      }
    }

    const edited = replacements.length > 0;
    if (edited) outputText.set(doc.path, spliceReplacements(doc.source, replacements));
    documents.push({ path: doc.path, edited, ...doc.counts });
  }

  const totals = { ...emptyCounts(), documents: docs.length, documentsEdited: 0 };
  for (const doc of documents) {
    addCounts(totals, doc);
    if (doc.edited) totals.documentsEdited++;
  }

  log(
    `ocr-correct: ${totals.editsApplied} corrections written across ${totals.documentsEdited} `
    + `documents, ${totals.sentencesRefused} model outputs refused by the guards, `
    + `${totals.editsRejected} accepted corrections the markup would not take`,
  );

  // ── write the book, unless this was a dry run ────────────────────────────
  if (outputPath !== null) {
    writeEditedEpub(archive, outputText, outputPath);
    log(`ocr-correct: wrote ${outputPath}`);
  }

  return {
    epub: inputPath,
    output: outputPath,
    dryRun: outputPath === null,
    generatedAt: new Date().toISOString(),
    model: options.model,
    unitMaxChars: maxChars,
    caveat: PUBLISHER_TEXT_CAVEAT,
    totals,
    skipped: pkg.skipped,
    documents,
    applied,
    rejected,
  };
}
