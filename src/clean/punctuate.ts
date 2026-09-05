/**
 * clean/punctuate — stage 1, as spans a splice can apply.
 *
 * Lifted out of BookForge's `electron/narration-text-pass.ts` (vendored
 * verbatim at this repo's anchor commit) with its arguments intact and its one
 * dependency on a document tree removed. `punctuationSpans` and `nodeHolding`
 * are that file's, line for line; what changed is that the array they are asked
 * about is `markerSegments`' answer rather than a list of text-node lengths
 * (src/clean/segments.ts carries the whole of why).
 *
 * WHY STAGE 1 PRODUCES SPANS AT ALL, rather than just handing back the
 * canonical string. Because canonicalization is computed over the WHOLE text
 * and applied per SEGMENT, and those are not the same thing. `. . .` can
 * straddle an emphasis marker, and a segment's end is not a line's end —
 * trimming "trailing" whitespace at the end of a segment that has a `**` after
 * it would weld two words together. So the canonical form is computed once over
 * everything, and the spans that turn out to cross a marker are REFUSED and
 * recorded rather than applied. A refusal is a fact about the book; a flattened
 * marker is damage nobody can find.
 *
 * AND WHY STAGE 1 IS APPLIED BEFORE STAGE 2 EVEN LOOKS. The order is
 * load-bearing and docs/CLEAN-TEXT.md states it: `normalizeQuotes` turning `…`
 * into `...` AFTER `applyNumberRules` had computed offsets would invalidate
 * every one of them, and the number rules' `find` strings routinely contain
 * characters stage 1 created — `"250 members` opens with a quote the printed
 * book set curly. Two writes, never one, and never composed into a single
 * rewrite list: that would mean either refusing every number standing beside a
 * canonicalized quote, or hand-merging overlapping spans into a second
 * coordinate system to keep true.
 */
import { diffChars } from 'diff';

import { markerSegments } from './segments.js';
import type { NarrationNumberTarget, NarrationTextRewrite } from './targets.js';
import { canonicalizePunctuation, PUNCTUATION_SPEC_VERSION } from './tts-punctuation.js';

/** One punctuation span the pass could read but was not allowed to apply. */
export interface PunctuationRefusal {
  /** The block the span sits in — a row id, or `chapter:<division id>`. */
  key: string;
  /** The file it came out of. */
  file: string;
  /** What the book prints there. */
  find: string;
  /** What the canonical form would have been. */
  replace: string;
  reason: string;
}

/** What the punctuation stage did to a book. */
export interface PunctuationStageRecord {
  spec: string;
  /** How many of the book's blocks changed at all. */
  targetsChanged: number;
  /** How many spans were rewritten. */
  spansApplied: number;
  /** Per rule name, how many times it fired — `PUNCTUATION_RULES` are the keys. */
  counts: Record<string, number>;
  /** Spans that would have had to cross an inline marker. Never silent. */
  refused: PunctuationRefusal[];
}

/**
 * The character spans that turn `before` into `after`, at their offsets in
 * `before`.
 *
 * `diffChars` from the `diff` package, grouped so that a removal and the
 * insertion beside it are ONE replacement rather than two edits at the same
 * offset. The offsets are in the BEFORE text because that is the text the book
 * prints and the splice writes into.
 *
 * A PURE INSERTION is possible, and an earlier cut of this threw on it, blaming
 * a condition its author had declared impossible. The rules are innocent — they
 * only delete and replace — but `diffChars` chooses a different minimal
 * alignment when a deletion sits near a run of identically-replaced glyphs, and
 * emits an insertion group. `"a­b “c” d "` is enough: a soft
 * hyphen, two curly quotes, an NBSP and a trailing space in one short string.
 * Long prose gives the differ unique anchors and never trips it; short blocks —
 * a heading, a chapter title, a one-line caption — are exactly the regime where
 * it does (BookForge's adversarial review, 2026-09-04: 40,027 of 386,344 fuzzed
 * strings).
 *
 * So an insertion is ABSORBED into the character beside it, which is always
 * well defined and preserves the canonical text exactly: an insertion at `p`
 * becomes a replacement of `text[p-1]` by itself plus the inserted characters
 * (or of `text[0]` when there is nothing before it). Nothing throws, and a span
 * that then turns out to cross a marker is refused like any other.
 *
 * WHICH DIFFER THIS IS, IS PART OF THE CONTRACT. The alignment a differ picks
 * decides which spans exist, and therefore which of them get refused for
 * crossing a marker — so `diff` is pinned to the exact version BookForge
 * resolves rather than re-implemented. A hand-rolled differ would be a change
 * to what this pass does wearing a `NORMALIZER_VERSION` that says nothing
 * changed, which is the one failure the version policy exists to prevent.
 */
export function punctuationSpans(before: string, after: string): NarrationTextRewrite[] {
  if (before === after) return [];
  const parts = diffChars(before, after);
  const out: NarrationTextRewrite[] = [];
  let at = 0;
  let i = 0;
  while (i < parts.length) {
    if (!parts[i]!.added && !parts[i]!.removed) {
      at += parts[i]!.value.length;
      i++;
      continue;
    }
    const start = at;
    let find = '';
    let replace = '';
    while (i < parts.length && (parts[i]!.added === true || parts[i]!.removed === true)) {
      if (parts[i]!.removed === true) {
        find += parts[i]!.value;
        at += parts[i]!.value.length;
      } else {
        replace += parts[i]!.value;
      }
      i++;
    }
    if (find === '') {
      // Absorb the neighbour, preferring the one BEFORE — an insertion belongs
      // to the text it follows, and taking the character before keeps the span
      // out of the way of whatever the differ emits next.
      if (start > 0) {
        out.push({ at: start - 1, find: before[start - 1]!, replace: before[start - 1]! + replace });
      } else if (before.length > 0) {
        out.push({ at: 0, find: before[0]!, replace: replace + before[0]! });
      }
      // A span of an empty string cannot carry an insertion anywhere; there is
      // nothing to canonicalize in it either.
      continue;
    }
    out.push({ at: start, find, replace });
  }
  return out;
}

/** Which segment of a target a span sits in, or -1 when it crosses one. */
export function nodeHolding(segments: readonly number[], at: number, end: number): number {
  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    if (at >= start && end <= start + segments[i]!) return i;
    start += segments[i]!;
  }
  return -1;
}

/** What the punctuation stage settled about one block. */
export interface PunctuatedTarget {
  rewrites: NarrationTextRewrite[];
  counts: Record<string, number>;
  refused: PunctuationRefusal[];
}

/**
 * Canonicalize one block's punctuation, as spans a splice may apply.
 *
 * The `preformatted` refusal is kept from the source and is UNREACHABLE on this
 * route, deliberately rather than by accident: a book file row carries no
 * styling, so nothing can say whether its spaces are a layout the author set,
 * and `bookRowPlan` hands every row over with `preformatted: false`. The branch
 * stays because it is the shape of the refusal a later route will need — the
 * app can already tell a code listing from prose — and deleting it would mean
 * re-deriving the sentence when it does.
 */
export function punctuateTarget(target: NarrationNumberTarget): PunctuatedTarget {
  // THE AUTHOR'S OWN WHITESPACE IS NOT AN ARTIFACT. A code listing, an ASCII
  // table or a verse laid out with leading spaces — and `REPEATED_SPACE` and
  // `TRAILING_SPACE` would flatten every one of them. Refused by name and
  // counted, so the receipt says how much of the book nobody normalized.
  if (target.preformatted) {
    return {
      rewrites: [],
      counts: {},
      refused: [{
        key: target.key,
        file: target.file,
        find: target.text.slice(0, 80),
        replace: '(not attempted)',
        reason: 'the block preserves its own whitespace and canonicalizing it would flatten a '
          + 'layout the author set',
      }],
    };
  }
  const outcome = canonicalizePunctuation(target.text);
  if (outcome.text === target.text) return { rewrites: [], counts: {}, refused: [] };

  const rewrites: NarrationTextRewrite[] = [];
  const refused: PunctuationRefusal[] = [];
  for (const span of punctuationSpans(target.text, outcome.text)) {
    if (nodeHolding(target.segments, span.at, span.at + span.find.length) < 0) {
      refused.push({
        key: target.key, file: target.file, find: span.find, replace: span.replace,
        reason: 'the span crosses an inline marker — an emphasis delimiter or a superscript note '
          + 'number sits in it',
      });
      continue;
    }
    rewrites.push(span);
  }
  // The counts describe the canonicalization the rules FOUND, which is what the
  // audit compares against the corpora; the refusals above say which of them did
  // not make it into the book.
  return { rewrites, counts: outcome.counts, refused };
}

/**
 * Apply a block's accepted punctuation spans, or say why one would not land.
 *
 * Back to front, so an earlier splice cannot move a later offset, and the find
 * is re-checked against the text at its recorded position first. BookForge's
 * writer proves every rewrite landed or destroys its output
 * (`writeNarrationEpub`'s `rewrittenSpans` check); this is the same proof over
 * a string, and it throws for the same reason — a splice that went in at the
 * wrong offset has written words into a paragraph nobody validated them
 * against, and no later stage could tell.
 */
export function applySpans(
  text: string,
  spans: readonly NarrationTextRewrite[],
  where: string,
): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.at - a.at)) {
    if (out.slice(span.at, span.at + span.find.length) !== span.find) {
      throw new CleanTextError(
        `clean-text could not splice "${span.find}" into ${where} at ${span.at} — the text there `
        + `reads "${out.slice(span.at, span.at + span.find.length)}". Nothing was written.`,
      );
    }
    out = out.slice(0, span.at) + span.replace + out.slice(span.at + span.find.length);
  }
  return out;
}

/** A run this command will not finish. Always says what is wrong. */
export class CleanTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanTextError';
  }
}

/**
 * Stage 1 over every block, and the record of what it did.
 *
 * The canonical text of each block comes back beside the record because stages
 * 2 and 3 read it: the two writes are a real sequence, not a bookkeeping
 * convenience. BookForge materialises the intermediate as a whole second EPUB
 * on disk; here it is a string per row, which is the same two writes with the
 * zip taken out.
 */
export function punctuateBlocks(
  targets: readonly NarrationNumberTarget[],
): { text: Map<string, string>; record: PunctuationStageRecord } {
  const text = new Map<string, string>();
  const counts: Record<string, number> = {};
  const refused: PunctuationRefusal[] = [];
  let spansApplied = 0;
  let targetsChanged = 0;

  for (const target of targets) {
    const settled = punctuateTarget(target);
    for (const [rule, n] of Object.entries(settled.counts)) {
      counts[rule] = (counts[rule] ?? 0) + n;
    }
    refused.push(...settled.refused);
    if (settled.rewrites.length === 0) {
      text.set(target.key, target.text);
      continue;
    }
    targetsChanged += 1;
    spansApplied += settled.rewrites.length;
    text.set(target.key, applySpans(target.text, settled.rewrites, target.key));
  }

  return {
    text,
    record: { spec: PUNCTUATION_SPEC_VERSION, targetsChanged, spansApplied, counts, refused },
  };
}

/**
 * The segments of a block after stage 1 has rewritten it.
 *
 * Re-derived rather than carried, and that is the whole reason stage 1's output
 * is a STRING and not a set of spans held against the original: the canonical
 * text is a different string, the markers may sit at different offsets in it,
 * and stages 2 and 3 measure everything against the text they are shown. The
 * marker runs themselves are never touched by canonicalization — none of the
 * ten punctuation rules matches `*`, `_` or a superscript digit — so this
 * re-derivation finds the same markers in their new places, which is what makes
 * it safe rather than merely convenient.
 */
export function segmentsAfter(text: string): number[] {
  return markerSegments(text);
}
