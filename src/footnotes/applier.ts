/**
 * footnotes — footnote reference markers, found by the model and removed by a
 * deterministic applier.
 *
 * Moved from BookForgeApp `electron/dagger-footnotes.ts` (MIGRATION §3).
 * Symbols renamed dagger→footnotes; the parser, the guard and the applier are
 * unchanged. What DID change shape is the planning loop: in BookForge the unit
 * of work was an EPUB chapter's prose segments, and here it is a block from the
 * blocks JSON, so the model-driving loop is separated from whatever walks the
 * document (see `planFootnotes` and the seam above it).
 *
 * Scanned books carry the publisher's superscript reference markers welded into
 * the prose by OCR, and they are almost never digits by the time they reach us:
 * the corpus this model trained on removes `*`, `”`, `’`, `°`, `?`, `!`, `>`,
 * `®`, `§` and stray letters far more often than it removes a number. That is
 * why the shape-based inference this replaces could only ever see part of the
 * problem — it was built to recognise a numeric chain.
 *
 * THE CONTRACT, and the reason a small model is enough:
 *
 *   The model never rewrites prose. It emits a DELETION LIST — one
 *   `<anchor+marker> → <anchor>` line per marker, or the single word `none` —
 *   and the applier below does the editing. Every line is checked twice before
 *   anything is spliced (see `applyFootnoteDeletions`), so the worst a wrong
 *   answer can do is fail to remove a marker. It cannot alter the book.
 *
 * The metrics that follow from that contract — false-fire rate on clean blocks,
 * applier rejections, and applied-text agreement rather than pair equality —
 * are in `test/footnotes/score.test.ts` and ARCHITECTURE §7.
 */
import { toRawPrompt } from '../boxes/encoder.js';
import { FOOTNOTES_SYSTEM_PROMPT } from './prompt.js';

/** One edit the model proposed. Neither field is trusted until the applier checks it. */
export interface FootnoteDeletion {
  /** The anchor WITH the marker still on it, as the model copied it from the text. */
  before: string;
  /** The same anchor with the marker's characters gone — and nothing else changed. */
  after: string;
}

/**
 * A plan, keyed by the EXACT text it was derived from.
 *
 * Keyed rather than positional because the consumer is a pure function whose
 * transform closure may run several times over the same text. A map keyed by
 * the text is order-independent and idempotent, which is what that design
 * needs — and it is why two identical blocks share one entry rather than
 * doubling every deletion in it.
 */
export type FootnotePlan = Map<string, FootnoteDeletion[]>;

/** The model's `→`, plus the ASCII form in case a decode mangles the arrow. */
const ARROW = /\s*(?:→|->)\s*/;

/**
 * Parse one answer into deletions. Unparseable lines are DROPPED, never guessed
 * at: a half-read line would become a splice into somebody's book.
 */
export function parseFootnotesAnswer(text: string): FootnoteDeletion[] {
  const raw = (text ?? '').trim();
  if (!raw || /^none$/i.test(raw)) return [];
  const out: FootnoteDeletion[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^none$/i.test(trimmed)) continue;
    const parts = trimmed.split(ARROW);
    if (parts.length !== 2 || !parts[0]) continue;
    out.push({ before: parts[0], after: parts[1] });
  }
  return out;
}

/**
 * Is `after` reachable from `before` by DELETING characters only? Two pointers,
 * so it is a subsequence test.
 *
 * This is the guard the model found the hole in on its first held-out run: it
 * emitted `aspires.<marker> → aspirations.` — an anchor that really does occur
 * in the source, paired with a replacement that is not the anchor minus a marker
 * but a DIFFERENT WORD. An applier that only checks "does `before` occur"
 * accepts that and rewrites the prose. Requiring `after` to be a subsequence of
 * `before` restores the property the whole small-model design rests on: the
 * model can fail to remove a marker, but it cannot alter the text.
 */
export function isDeletionOnly(before: string, after: string): boolean {
  let i = 0;
  for (const ch of after) {
    i = before.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

/** The characters `before` loses on its way to `after` — i.e. the marker itself. */
function deletedChars(before: string, after: string): string {
  const parts: string[] = [];
  let i = 0;
  for (const ch of after) {
    const j = before.indexOf(ch, i);
    if (j < 0) break;   // unreachable — isDeletionOnly has already passed
    parts.push(before.slice(i, j));
    i = j + 1;
  }
  parts.push(before.slice(i));
  return parts.join('');
}

export interface FootnoteApplyResult {
  text: string;
  /** The marker text actually removed, one entry per applied edit, in order. */
  removed: string[];
  /** Edits the guards refused. Harmless to the text — that is the point. */
  rejected: number;
}

/**
 * Apply a deletion list to one piece of text. THIS IS THE SAFETY BOUNDARY.
 *
 * Three checks, all of them load-bearing:
 *   1. `after` must be non-empty. The anchor minus its marker is never nothing,
 *      so an empty replacement is a malformed line, not an instruction to delete
 *      a whole phrase. (No gold example in the corpus has one.)
 *   2. `after` must be `before` with characters DELETED ONLY — see isDeletionOnly.
 *   3. `before` must occur VERBATIM in the text. A model that paraphrased its
 *      own anchor gets no edit rather than an edit somewhere approximate.
 *
 * Edits land on the FIRST remaining occurrence, applied in document order, which
 * is what makes a repeated anchor work: once the first `wrote.*` has become
 * `wrote.`, the next identical deletion naturally finds the second one.
 */
export function applyFootnoteDeletions(
  src: string,
  deletions: readonly FootnoteDeletion[],
): FootnoteApplyResult {
  let text = src;
  const removed: string[] = [];
  let rejected = 0;
  for (const { before, after } of deletions) {
    if (!after || !isDeletionOnly(before, after)) { rejected++; continue; }
    const at = text.indexOf(before);
    if (at < 0) { rejected++; continue; }
    text = text.slice(0, at) + after + text.slice(at + before.length);
    removed.push(deletedChars(before, after));
  }
  return { text, removed, rejected };
}

/**
 * The longest user turn in the training corpus is 1661 characters; the median is
 * 349. A book paragraph IS the unit this model saw — the corpus was built from
 * OCR blocks — so the split below is paragraph-first and only wraps the rare
 * paragraph that runs past the ceiling.
 */
const MAX_UNIT_CHARS = 1600;

/**
 * Cut one piece of prose into the units the model is asked about.
 *
 * Over-long paragraphs are wrapped at WHITESPACE, never mid-token, because a
 * marker is usually glued straight onto its anchor (`Germany.*`) and a split
 * inside that pair would hand the model an orphan. The corpus does contain a
 * minority of ` *` markers where a space intervenes, so a wrap landing on
 * exactly that space loses the marker — a silent miss, which is the safe
 * direction, and only reachable on paragraphs past 1600 characters.
 */
export function splitForFootnotes(segmentText: string): string[] {
  const units: string[] = [];
  for (const para of segmentText.split(/\n\s*\n/)) {
    let rest = para.trim();
    if (!rest) continue;
    while (rest.length > MAX_UNIT_CHARS) {
      let cut = rest.lastIndexOf(' ', MAX_UNIT_CHARS);
      const nl = rest.lastIndexOf('\n', MAX_UNIT_CHARS);
      if (nl > cut) cut = nl;
      // A 1600-character run with no whitespace is not prose; cut it anyway so
      // the loop always makes progress.
      if (cut <= 0) cut = MAX_UNIT_CHARS;
      const head = rest.slice(0, cut).trim();
      if (head) units.push(head);
      rest = rest.slice(cut).trim();
    }
    if (rest) units.push(rest);
  }
  return units;
}

export interface FootnotePlanOptions {
  /** Reported after each batch so a book-length pass is not a frozen bar. */
  onProgress?: (done: number, total: number) => void;
  /** Checked between batches; an aborted job throws rather than finishing. */
  signal?: AbortSignal;
}

/**
 * THE MODEL SEAM.
 *
 * `planFootnotes` builds the raw prompts and hands them over as strings; what
 * runs them is somebody else's problem. That keeps this module free of any
 * server, and it is what makes the prompt testable without one.
 *
 * The implementation must send each prompt VERBATIM to `/completion` with
 * `FOOTNOTES_STOP` as the stop token, and return one answer per prompt in the
 * same order. NO FALLBACK: a missing model, a dead server or an HTTP error
 * throws. The alternative would be a book that quietly keeps its markers and
 * narrates "the treaty three was signed", which is indistinguishable from
 * success until somebody listens to it.
 */
export type FootnoteGenerator = (prompts: readonly string[]) => Promise<readonly string[]>;

/**
 * How many units go to the generator per round-trip. llama-server runs them
 * sequentially (`-np 1`), so this is purely the progress/cancellation
 * granularity, not a concurrency knob.
 */
const BATCH = 16;

/**
 * Ask the model where the markers are in a list of prose texts.
 *
 * THE BLOCK-ITERATION SEAM IS THE `texts` ARGUMENT. In BookForge this loop was
 * `planChapterFootnotes(segments, …)` and it walked an EPUB chapter's prose
 * segments. In Foundry the unit is a BLOCK from the blocks JSON, so the walking
 * lives in the caller: it selects the narratable blocks, hands their text in
 * reading order, and maps the returned plan back onto block ids by text. This
 * function knows only about text, units, batching and answers — which is why it
 * did not need to change to follow the unit from chapters to blocks.
 *
 * Returns a plan keyed by the exact input text. A text with no deletions is
 * absent from the map rather than present-and-empty.
 */
export async function planFootnotes(
  texts: readonly string[],
  generate: FootnoteGenerator,
  opts: FootnotePlanOptions = {},
): Promise<FootnotePlan> {
  const plan: FootnotePlan = new Map();

  // The text layout first, then the unique units. A book repeats short
  // paragraphs more often than you would think and every duplicate is a
  // round-trip; the answer for identical text is identical anyway (temperature 0).
  const layout: Array<{ text: string; units: string[] }> = [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    // Two identical texts share one entry — filling the same key twice would
    // double every deletion in it.
    if (plan.has(text)) continue;
    plan.set(text, []);
    const units = splitForFootnotes(text);
    layout.push({ text, units });
    for (const unit of units) {
      if (seen.has(unit)) continue;
      seen.add(unit);
      unique.push(unit);
    }
  }
  if (unique.length === 0) return new Map();

  const answers = new Map<string, FootnoteDeletion[]>();
  for (let i = 0; i < unique.length; i += BATCH) {
    if (opts.signal?.aborted) throw new Error('Job cancelled');
    const slice = unique.slice(i, i + BATCH);
    const result = await generate(
      slice.map((unit) => toRawPrompt({ system: FOOTNOTES_SYSTEM_PROMPT, user: unit })),
    );
    if (!Array.isArray(result) || result.length !== slice.length) {
      // A short or missing answer array is a broken generator, not an empty
      // answer. Coercing it to '' is how a run "succeeds" having found nothing.
      throw new Error(
        `The footnote-marker model returned ${Array.isArray(result) ? result.length : 'no'} `
        + `answers for ${slice.length} prompts`);
    }
    slice.forEach((unit, k) => {
      const answer = result[k];
      if (typeof answer !== 'string') {
        throw new Error('The footnote-marker model returned no answer for a prompt');
      }
      answers.set(unit, parseFootnotesAnswer(answer));
    });
    opts.onProgress?.(Math.min(i + BATCH, unique.length), unique.length);
  }

  // Re-walk in DOCUMENT ORDER. The applier edits the first remaining occurrence
  // of each anchor, so a list out of order would aim the second `wrote.*` at the
  // first one's position.
  for (const { text, units } of layout) {
    const list = plan.get(text)!;
    for (const unit of units) list.push(...(answers.get(unit) ?? []));
    if (list.length === 0) plan.delete(text);
  }
  return plan;
}
