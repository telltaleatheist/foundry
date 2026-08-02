/**
 * geometry — the four per-block facts of RUBRIC_TRAINING §9d decision 1.
 *
 * The boxes model is fed the geometry as explicit numbers so it weighs soft
 * evidence (flush-left styles, dialogue, poetry) instead of re-deriving
 * arithmetic from raw coordinates — a 4B model doing long division on bounding
 * boxes is spending its capacity on the part we can compute exactly.
 *
 * The same four numbers then drive the deterministic grouping rules, and they
 * are PERSISTED into `boxes/blocks.json` rather than recomputed at export time.
 * That is deliberate: an export must be explainable from the run directory
 * alone. "Why did this paragraph run for two pages" has to be answerable by
 * reading a file, not by re-running the pipeline under a debugger.
 *
 * Every quantity is expressed in the calibrated frame — body heights and line
 * pitches, never pixels — so a block's facts mean the same thing at any dpi and
 * on any page size, and so the thresholds that read them can be typographic
 * constants rather than per-book magic numbers.
 */
import type { BlockGeometry, CalibrationVerdict, ScanLine } from '../pipeline/artifacts.js';
import { isWrapHyphenBreak } from './hyphen.js';

/** What geometry needs from a block: identity, page, and its lines in reading order. */
export interface GeometryBlock {
  id: string;
  page: number;
  lineIds: readonly string[];
}

/**
 * How far short of the measure a line must stop to count as SHORT, in body-size
 * units. Two body heights is roughly two ems of white at the right margin —
 * past what justification or a wide word-space produces, and short of calling
 * every slightly ragged line the end of a paragraph.
 */
const SHORT_LINE_UNITS = 2.0;

/** A block whose lines are not in the line table, or which has none. */
export class GeometryInputError extends Error {
  constructor(reason: string) {
    super(`block geometry: ${reason}`);
    this.name = 'GeometryInputError';
  }
}

/**
 * Derive the geometry facts for every block, in reading order.
 *
 * `blocks` must be in reading order and `lines` must contain every id they
 * reference; both are violations that throw, because a block with a dangling
 * line id is a broken upstream stage and inventing a default for it would put
 * the invention into the model's prompt.
 */
export function computeBlockGeometry(
  blocks: readonly GeometryBlock[],
  lines: readonly ScanLine[],
  calibration: CalibrationVerdict,
): Map<string, BlockGeometry> {
  const byId = new Map<string, ScanLine>();
  for (const l of lines) byId.set(l.id, l);

  const lineOf = (blockId: string, lineId: string): ScanLine => {
    const l = byId.get(lineId);
    if (!l) throw new GeometryInputError(`block ${blockId} references line ${lineId}, which is not in scan/lines.json`);
    return l;
  };

  const { bodyHeight, pitch, flushLeft, bodyRight } = calibration;
  const out = new Map<string, BlockGeometry>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.lineIds.length === 0) throw new GeometryInputError(`block ${b.id} has no lines`);
    const first = lineOf(b.id, b.lineIds[0]);

    const prev = i > 0 ? blocks[i - 1] : null;
    const prevLast = prev ? lineOf(prev.id, prev.lineIds[prev.lineIds.length - 1]) : null;

    // gapAbove is an ADVANCE ratio, top of the previous line to top of this
    // one, in pitch units: 1.0 is normal leading, ~1.5 a blank-line gap. Ink
    // gaps were the alternative and they are worse — an ink gap shrinks when a
    // line happens to have no descenders, which is a property of the words, not
    // of the layout.
    //
    // null ACROSS A PAGE BREAK, always. The distance from the bottom of one
    // page to the top of the next is a fact about the trim size; treating it as
    // leading would make every page's first paragraph look like a new one, in a
    // book that indents and does not break.
    const gapAbove = prevLast && prev && prev.page === b.page
      ? (first.bbox[1] - prevLast.bbox[1]) / pitch
      : null;

    out.set(b.id, {
      firstLineIndent: (first.bbox[0] - flushLeft) / bodyHeight,
      gapAbove,
      prevLineShort: prevLast ? (bodyRight - prevLast.bbox[2]) / bodyHeight > SHORT_LINE_UNITS : false,
      prevEndsWrapHyphen: prevLast ? isWrapHyphenBreak(prevLast.text, first.text) : false,
    });
  }

  return out;
}
