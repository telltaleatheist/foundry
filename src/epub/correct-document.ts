/**
 * correct-document — the projection, for an edit that REPLACES rather than
 * deletes.
 *
 * `document.ts` maps a footnote deletion's text range back onto the bytes it
 * came from and cuts them out. Correction needs the same map and one more
 * promise, because it puts characters IN: the bytes it writes over must be
 * bytes it is allowed to write over.
 *
 *   markup → correctable units → decoded text (+ a char-by-char map back)
 *          → the model's edits, guarded by src/ocr/{guard,edits}.ts
 *          → TEXT ranges → SOURCE ranges → splices on the original bytes
 *
 * The rules that decide whether an accepted edit may actually be written:
 *
 *  - **Nothing is re-serialized.** An edit is a splice on the source string, so
 *    every byte outside it survives exactly — attribute quoting, entity
 *    spelling, indentation, the prolog. A document with no applied edit is
 *    written back byte-identical because it is written back UNREAD.
 *  - **An anchor must be ONE CONTIGUOUS RUN of source characters.** A run that
 *    is contiguous cannot have markup inside it, because a tag's bytes would sit
 *    between two of its characters. That is the whole markup-preservation
 *    argument: correction changes words, and a word that spans `</em> <em>`
 *    cannot be changed without deciding what happens to the emphasis — so it is
 *    refused by name instead of guessed at.
 *  - **An anchor may not begin or end inside an entity.** `&amp;` is five source
 *    characters standing for one; replacing three of them leaves `&am` in
 *    somebody's book.
 *  - **A CDATA payload is never written to.** Escaping is opposite inside it.
 *
 * Every refusal is recorded with the model's own line, because the number that
 * decides whether this model may be pointed at a library is read, not computed
 * (ARCHITECTURE §7).
 */
import type { Edit } from '../ocr/edits.js';
import { decodeEntities, elements, type XmlElement } from './xml.js';
import { extractUnit, type CharSource, type ProseUnit } from './document.js';

/**
 * The block-level tags whose text is corrected.
 *
 * WIDER than `document.ts`'s `PROSE_TAGS`, and the difference is the model.
 * Footnote removal DELETES digits welded onto prose, so a heading holding a
 * chapter number and a title is a place it can do damage for no gain. The
 * corrector repairs misrecognized characters, and a misrecognized chapter title
 * is as wrong as a misrecognized sentence — arguably worse, because it is the
 * one line of the chapter a reader sees before deciding to read it.
 *
 * A unit is a tag in this set with no tag from this set inside it, so
 * `<blockquote><p>…</p></blockquote>` yields the paragraph once rather than its
 * text twice, and `<div>` — which real books use as a paragraph when their
 * toolchain felt like it — yields nothing when it merely contains paragraphs.
 */
const CORRECTABLE_TAGS: ReadonlySet<string> = new Set([
  'p', 'blockquote', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'dt', 'dd',
  'td', 'th', 'caption', 'figcaption',
]);

/**
 * The correctable units of one document, in reading order.
 *
 * Note what is NOT excluded here that `proseUnits` excludes: tables. A table
 * cell holds words a scanner misread exactly like a paragraph does, and unlike
 * marker deletion, repairing them cannot restructure anything.
 */
export function correctableUnits(root: XmlElement, source: string): ProseUnit[] {
  const out: ProseUnit[] = [];
  for (const el of elements(root)) {
    if (!CORRECTABLE_TAGS.has(el.tag)) continue;
    let nested = false;
    for (const inner of elements(el)) {
      if (inner !== el && CORRECTABLE_TAGS.has(inner.tag)) { nested = true; break; }
    }
    if (nested) continue;
    out.push(extractUnit(el, source));
  }
  return out;
}

/** A half-open source range and what replaces it. */
export interface SourceReplacement {
  start: number;
  end: number;
  /** Already escaped for XML text content. */
  text: string;
}

export type CorrectionRejection =
  | 'the anchor does not occur in the unit at the offset it was derived at'
  | 'the anchor spans a line break, which has no source characters to replace'
  | 'the anchor is inside a CDATA section, which this stage does not write into'
  | 'the anchor crosses a markup boundary, and correction never rewrites markup'
  | 'the anchor begins or ends inside an entity reference'
  | 'the source bytes do not decode to the anchor — the projection has drifted';

export interface AppliedCorrection {
  edit: Edit;
  /** Whitespace-collapsed context: `…before [was "tbe" now "the"] after…`. */
  context: string;
}

export interface RejectedCorrection {
  edit: Edit;
  reason: CorrectionRejection;
}

export interface UnitCorrection {
  applied: AppliedCorrection[];
  rejected: RejectedCorrection[];
  replacements: SourceReplacement[];
}

const CONTEXT = 80;

/**
 * Project one unit's accepted edits onto the bytes they must be written into.
 *
 * `at` is the offset of each edit's anchor WITHIN THE UNIT'S TEXT — the caller
 * knows it because `deriveEdits` guarantees the anchor occurs exactly once in
 * the unit it was derived against, and it is passed rather than re-found so a
 * unit that was split into several prompts cannot land an edit in the wrong one.
 *
 * Edits are independent: one refused for crossing markup does not stop the
 * others, because each is a separate repair of a separate word and throwing
 * away good ones for a bad neighbour is the failure the whole-unit guard is
 * already being measured for.
 */
export function projectCorrections(
  unit: ProseUnit,
  edits: readonly { edit: Edit; at: number }[],
  source: string,
): UnitCorrection {
  const applied: AppliedCorrection[] = [];
  const rejected: RejectedCorrection[] = [];
  const replacements: SourceReplacement[] = [];

  for (const { edit, at } of edits) {
    const to = at + edit.before.length;
    if (at < 0 || to > unit.text.length || unit.text.slice(at, to) !== edit.before) {
      rejected.push({ edit, reason: 'the anchor does not occur in the unit at the offset it was derived at' });
      continue;
    }

    const span = sourceSpan(unit.chars, at, to);
    if (typeof span === 'string') {
      rejected.push({ edit, reason: span });
      continue;
    }

    // THE CROSS-CHECK. The bytes about to be overwritten must decode to exactly
    // the anchor the model quoted. A difference means the char-by-char map and
    // the source have parted company, and the one failure that could alter a
    // book is a correct-looking edit written at the wrong offset.
    if (decodeEntities(source.slice(span.start, span.end)) !== edit.before) {
      rejected.push({ edit, reason: 'the source bytes do not decode to the anchor — the projection has drifted' });
      continue;
    }

    replacements.push({ start: span.start, end: span.end, text: escapeXmlText(edit.after) });
    applied.push({ edit, context: contextLine(unit.text, at, to, edit.after) });
  }

  return { applied, rejected, replacements };
}

/**
 * The source range one run of decoded characters occupies, or the reason there
 * is not one.
 *
 * Contiguity is the load-bearing test and it is stated as "each character
 * begins where the previous one ended". Two decoded characters standing for the
 * SAME source range are contiguous too — that is one entity expanding to a
 * surrogate pair — so they are allowed explicitly rather than by accident.
 */
function sourceSpan(
  chars: readonly CharSource[], from: number, to: number,
): { start: number; end: number } | CorrectionRejection {
  for (let i = from; i < to; i++) {
    const ch = chars[i]!;
    if (ch.srcStart < 0) return 'the anchor spans a line break, which has no source characters to replace';
    if (ch.literal) return 'the anchor is inside a CDATA section, which this stage does not write into';
    if (i > from) {
      const prev = chars[i - 1]!;
      const sameEntity = ch.srcStart === prev.srcStart && ch.srcEnd === prev.srcEnd;
      if (!sameEntity && ch.srcStart !== prev.srcEnd) {
        return 'the anchor crosses a markup boundary, and correction never rewrites markup';
      }
    }
  }

  const start = chars[from]!.srcStart;
  const end = chars[to - 1]!.srcEnd;

  // A neighbour sharing bytes with the first or last character means the anchor
  // begins or ends in the middle of an entity reference.
  const before = chars[from - 1];
  const after = chars[to];
  if (before && before.srcStart >= 0 && before.srcEnd > start) {
    return 'the anchor begins or ends inside an entity reference';
  }
  if (after && after.srcStart >= 0 && after.srcStart < end) {
    return 'the anchor begins or ends inside an entity reference';
  }
  return { start, end };
}

/**
 * Escape text for an XML text node.
 *
 * The three that MUST be escaped and no more. `"` and `'` are only special
 * inside attribute values, and escaping them here would put `&quot;` into the
 * prose of a book whose every other quotation mark is a literal one — a diff
 * across the paragraph that has nothing to do with the correction.
 */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `…the [was "tbe rnain" now "the main"] point…`, whitespace collapsed for reading. */
function contextLine(text: string, from: number, to: number, after: string): string {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const pre = flat(text.slice(Math.max(0, from - CONTEXT), from));
  const post = flat(text.slice(to, to + CONTEXT));
  return `${from > CONTEXT ? '…' : ''}${pre}`
    + `[was "${flat(text.slice(from, to))}" now "${flat(after)}"]`
    + `${post}${to + CONTEXT < text.length ? '…' : ''}`;
}

/**
 * Write the replacements into the source.
 *
 * Applied from the END backwards so an earlier splice cannot move a later one's
 * offsets. Overlapping replacements are impossible — `deriveEdits` rejects
 * overlapping anchors and every unit's edits come from one derivation — but two
 * that did overlap would silently produce nonsense, so it is an error naming
 * both rather than a race between them.
 */
export function spliceReplacements(
  source: string, replacements: readonly SourceReplacement[],
): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      throw new Error(
        `ocr-correct: two corrections claim the same bytes — [${sorted[i - 1]!.start}, `
        + `${sorted[i - 1]!.end}) and [${sorted[i]!.start}, ${sorted[i]!.end}). The edit contract `
        + 'rejects overlapping anchors, so this is a bug in the projection and the document is '
        + 'left unedited.',
      );
    }
  }
  let out = source;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]!;
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}
