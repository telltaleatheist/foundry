/**
 * ocr/stage — the ship configuration of the OCR repair, in one place.
 *
 * Extracted from the `ocr` command so that `reflow` runs the SAME code rather
 * than a second copy of it. Two implementations of "repair a line" is the same
 * failure as two copies of a prompt format: within a month one of them has the
 * guard and the other does not, both look like they work, and the difference
 * shows up as a book that is subtly wrong.
 *
 * One line goes: model → per-word guard → edit derivation → applier round-trip.
 * The model answers with a whole corrected line (free text — it CAN invent a
 * word, and nothing in the wire format stops it), so a result is only ever built
 * from an output that survived the guard AND could be expressed as
 * contract-legal edits.
 *
 * Rejection is never silent and never fatal: the line ships unchanged and the
 * result records why. That is the measured ship configuration (checkpoint-2
 * scoring, Aug 1 2026), not a fallback: EN degraded rows 37 → 15 with CER
 * improving, DE degraded 52 → 29.
 *
 * ## The keep-list
 *
 * A line the book is not going to contain does not need a GPU pointed at it.
 * `reflow` drops deleted blocks and excluded categories before it repairs
 * anything, and hands the ids it kept; every other line passes through
 * unchanged, recorded as untouched rather than quietly absent. On a book where
 * the user has deleted the notes apparatus that is a third of the lines and a
 * third of the time.
 *
 * A keep-list is not a filter on the OUTPUT: every line still comes back, in
 * order, so a caller cannot end up with a line that was neither repaired nor
 * shipped.
 */
import { applyEdits, deriveEdits } from './edits.js';
import { OCR_GUARD_SHIPPED_POLICY, ocrGuardResolve, type OcrGuardPolicy } from './guard.js';
import { extractOcrAnswer, OCR_STOP, toOcrRawPrompt } from './prompt.js';
import type { OcrLine } from '../pipeline/artifacts.js';

/** One line as this stage needs it: an id and what was read. */
export interface RepairableLine {
  id: string;
  text: string;
}

/**
 * The wire. Takes the prompt this stage built and the generation ceiling it
 * computed, returns the model's answer — nothing more, so the stage owns the
 * prompt and the caller owns the server (ARCHITECTURE §4).
 */
export type OcrGenerate = (request: {
  prompt: string;
  stop: string[];
  nPredict: number;
}) => Promise<string>;

export interface RepairLinesOptions {
  lines: readonly RepairableLine[];
  /**
   * The ids worth spending the model on. Absent means every line — which is
   * what the standalone `ocr` stage means by default, because it does not know
   * what a later export will drop.
   */
  keep?: ReadonlySet<string>;
  generate: OcrGenerate;
  onProgress?: (done: number, total: number) => void;
  /**
   * How far one illegal run reaches (src/ocr/guard.ts). Defaults to the
   * measured ship configuration; anything else is an experiment and has to be
   * asked for by name.
   */
  guardPolicy?: OcrGuardPolicy;
}

export interface RepairLinesResult {
  lines: OcrLine[];
  /** Lines actually sent to the model. */
  asked: number;
  /** Lines the model changed and every guard accepted. */
  corrected: number;
  /** Outputs a guard refused. Harmless to the text; never silent. */
  refused: number;
  /** Lines skipped because they were empty or not in the keep-list. */
  skipped: number;
}

/**
 * One line through the ship configuration. Exported because it is the unit the
 * contract tests are written against.
 */
export function repairLine(
  id: string,
  src: string,
  out: string,
  guardPolicy: OcrGuardPolicy = OCR_GUARD_SHIPPED_POLICY,
): OcrLine {
  if (out === src) return { id, text: src, edits: [], rejected: [] };

  const verdict = ocrGuardResolve(src, out, { policy: guardPolicy });
  // Under `whole-unit` this is the model's answer or the source, and nothing
  // below can tell the difference from the previous whole-string branch. Under
  // `per-run` it can also be the mixture — in which case the refusal is still
  // recorded, because a reverted run is recall lost and lost recall is never
  // silent here.
  const candidate = verdict.text;
  if (candidate === src) {
    return { id, text: src, edits: [], rejected: [{ before: out, why: `per-word guard: ${verdict.why}` }] };
  }
  const refusals = verdict.ok
    ? []
    : [{ before: out, why: `per-word guard reverted ${verdict.rejectedRuns} run(s): ${verdict.why}` }];

  // Express the accepted correction as contract-legal edits. A pair too far
  // apart to derive is a rewrite the guard's word-local view could not see.
  const derived = deriveEdits(src, candidate);
  if (!derived) {
    return {
      id, text: src, edits: [],
      rejected: [{ before: out, why: 'edit derivation refused: output too far from the source line' }],
    };
  }

  // Round-trip through the applier — a result must never claim an edit list
  // that does not reproduce its own text.
  const applied = applyEdits(src, derived.edits);
  if (!applied.ok || applied.text !== candidate) {
    return {
      id, text: src, edits: [],
      rejected: [{ before: out, why: 'applier round-trip failed to reproduce the model output' }],
    };
  }

  return { id, text: candidate, edits: derived.edits, rejected: refusals };
}

export async function repairLines(options: RepairLinesOptions): Promise<RepairLinesResult> {
  const work = options.lines.filter(l => wanted(l, options.keep));
  const results: OcrLine[] = [];
  let asked = 0;
  let skipped = 0;

  for (const line of options.lines) {
    if (!wanted(line, options.keep)) {
      results.push({ id: line.id, text: line.text, edits: [], rejected: [] });
      skipped++;
      continue;
    }
    const raw = await options.generate({
      prompt: toOcrRawPrompt(line.text),
      stop: [OCR_STOP],
      // eval-line.py's budget, exactly: the answer is the line again, so its
      // own length plus headroom bounds the generation.
      nPredict: line.text.length + 64,
    });
    results.push(repairLine(line.id, line.text, extractOcrAnswer(raw), options.guardPolicy));
    asked++;
    options.onProgress?.(asked, work.length);
  }

  return {
    lines: results,
    asked,
    skipped,
    corrected: results.filter(l => l.edits.length > 0).length,
    refused: results.reduce((n, l) => n + l.rejected.length, 0),
  };
}

function wanted(line: RepairableLine, keep: ReadonlySet<string> | undefined): boolean {
  if (line.text.trim().length === 0) return false;
  return keep === undefined || keep.has(line.id);
}
