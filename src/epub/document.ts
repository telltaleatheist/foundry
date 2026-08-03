/**
 * document — the projection: text offsets back onto the markup they came from.
 *
 * This is the engineering the EPUB mode is made of. The footnotes model works on
 * TEXT (`planFootnotes`'s `texts` argument is the seam, and it was designed to
 * be), while a book is MARKUP, and a marker is almost never a plain character in
 * the paragraph's own text node — it is inside a `<sup>`, an `<a>`, a styled
 * `<span>`, or all three nested. So the flow is:
 *
 *   markup → prose units → decoded text (+ a char-by-char map back to source)
 *          → the model's deletions → deleted TEXT ranges
 *          → deleted SOURCE ranges → splices on the original bytes
 *
 * Two rules the design turns on:
 *
 *  - **Nothing is re-serialized.** An edit is a splice on the source string, so
 *    every byte outside an edit survives exactly — attribute quoting, entity
 *    spelling, indentation, the prolog. A document with no deletions is written
 *    back byte-identical because it is written back UNREAD.
 *  - **An inline element emptied by a deletion goes with it.** A marker is
 *    usually the entire content of its `<sup>`/`<a>`, and removing the digit
 *    while leaving `<a href="#fn3"></a>` behind is not preserving formatting, it
 *    is leaving a dead artifact where the marker was. NOTE the consequence,
 *    which the report counts: when that anchor carried an `id`, a back-link from
 *    the notes section now points at nothing. That is the intended trade —
 *    a book whose markers are gone has no marker to jump back from.
 *
 * The applier's contract is untouched and is not re-implemented: `isDeletionOnly`
 * and `applyFootnoteDeletions` come from `src/footnotes/applier.ts`, and every
 * projection is CROSS-CHECKED against what the applier produced on the plain
 * text. A disagreement throws — it would mean the markup edit and the text edit
 * had parted company, which is the one failure that could alter a book.
 */
import { applyFootnoteDeletions, isDeletionOnly, type FootnoteDeletion } from '../footnotes/applier.js';
import { decodeEntityAt, elements, type XmlElement, type XmlNode } from './xml.js';

/**
 * Where one character of the decoded text came from.
 *
 * `srcStart < 0` marks a SYNTHETIC character — the newline a `<br/>` stands for.
 * It has no bytes to delete, which is why a deletion that touches one is
 * refused rather than approximated.
 */
export interface CharSource {
  srcStart: number;
  srcEnd: number;
  /** The element the character's text node sits directly inside. */
  owner: XmlElement;
}

/** One block of prose, as the model will be asked about it. */
export interface ProseUnit {
  element: XmlElement;
  /** Entity-decoded text content, in reading order. */
  text: string;
  /** One entry per UTF-16 unit of `text`. */
  chars: CharSource[];
  /**
   * Every character of this unit sits inside ONE hyperlink — so it is a
   * navigation entry, not prose, and it is never asked about.
   *
   * This is how a table of contents is recognised without a filename rule. A
   * TOC line is `<p><a href="ch03.xhtml"><span>3</span>The Façade</a></p>`,
   * whose text is `3The Façade` — a digit welded to the front of a phrase,
   * which is precisely what this model is trained to strip. An EPUB2 book's TOC
   * carries no `epub:type` and no `nav` property to declare itself with, so
   * the structure has to be the tell. A body paragraph fails the test on the
   * first word, because its links cover only the marker.
   */
  linkOnly: boolean;
}

/**
 * The block-level tags a prose unit can be.
 *
 * `p` and `blockquote` only, and the omissions are the argument:
 *
 *  - **Headings are out.** `foundry footnotes --run` never sees a chapter
 *    number and its title as one block; an EPUB heading routinely holds both
 *    (`<h3>3<br/>Struggle and Renunciation</h3>`), and "digit welded to the
 *    front of a phrase" is precisely the shape this model was trained to
 *    delete. Asking would risk eating chapter numbers to gain markers that
 *    display headings almost never carry.
 *  - **List items and table cells are out**, matching the run mode, which never
 *    asks about `list` or `table` blocks (ARCHITECTURE §7: firing on furniture
 *    is the failure that damages a book).
 */
const PROSE_TAGS: ReadonlySet<string> = new Set(['p', 'blockquote']);

/** Tags that a marker's container is never one of — so never removed when emptied. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'html', 'body', 'head', 'section', 'article', 'aside', 'nav', 'header', 'footer',
  'div', 'p', 'blockquote', 'pre', 'hr', 'br', 'figure', 'figcaption',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/** Content that is not text and must never be dropped with an emptied wrapper. */
const NON_TEXT_TAGS: ReadonlySet<string> = new Set([
  'img', 'image', 'svg', 'video', 'audio', 'object', 'embed', 'iframe', 'canvas',
]);

const TABLE_TAGS: ReadonlySet<string> = new Set(['table']);

function hasAncestorTag(el: XmlElement, tags: ReadonlySet<string>): boolean {
  for (let p = el.parent; p; p = p.parent) if (tags.has(p.tag)) return true;
  return false;
}

/**
 * The prose units of one document, in reading order.
 *
 * A unit is a prose tag with no prose tag inside it, so `<blockquote><p>…</p>`
 * yields the paragraph once rather than its text twice. Units inside a table are
 * skipped for the same reason table blocks are skipped in run mode.
 */
export function proseUnits(root: XmlElement, source: string): ProseUnit[] {
  const out: ProseUnit[] = [];
  for (const el of elements(root)) {
    if (!PROSE_TAGS.has(el.tag)) continue;
    if (hasAncestorTag(el, TABLE_TAGS)) continue;
    let nested = false;
    for (const inner of elements(el)) {
      if (inner !== el && PROSE_TAGS.has(inner.tag)) { nested = true; break; }
    }
    if (nested) continue;
    out.push(extractUnit(el, source));
  }
  return out;
}

/** Decode one element's text content, recording where every character came from. */
export function extractUnit(element: XmlElement, src: string): ProseUnit {
  const chars: CharSource[] = [];
  let text = '';

  const pushRaw = (from: number, to: number, owner: XmlElement): void => {
    for (let i = from; i < to;) {
      const ent = decodeEntityAt(src, i);
      if (ent) {
        // One decoded character may stand for several source characters; each
        // decoded unit maps to the WHOLE entity, so deleting any of them deletes
        // the entity rather than half of it.
        for (const ch of ent.text) {
          for (let k = 0; k < ch.length; k++) {
            chars.push({ srcStart: i, srcEnd: i + ent.length, owner });
          }
          text += ch;
        }
        i += ent.length;
        continue;
      }
      chars.push({ srcStart: i, srcEnd: i + 1, owner });
      text += src[i];
      i++;
    }
  };

  const walk = (node: XmlNode): void => {
    if (node.kind === 'text') { pushRaw(node.start, node.end, node.parent); return; }
    if (node.kind === 'other') {
      // Comments and PIs are invisible; CDATA is literal text, entities and all.
      if (node.what !== 'cdata') return;
      for (let i = node.innerStart; i < node.innerEnd; i++) {
        chars.push({ srcStart: i, srcEnd: i + 1, owner: node.parent });
        text += src[i];
      }
      return;
    }
    if (node.tag === 'br') {
      // A line break IS a character in the text the model reads, and it has no
      // bytes of its own — attributed to the parent so it never makes the `<br>`
      // look like an element with content.
      chars.push({ srcStart: -1, srcEnd: -1, owner: node.parent ?? node });
      text += '\n';
      return;
    }
    for (const child of node.children) walk(child);
  };

  for (const child of element.children) walk(child);
  return { element, text, chars, linkOnly: isLinkOnly(element, text, chars) };
}

/** Is every non-blank character of this unit inside one and the same `<a href>`? */
function isLinkOnly(element: XmlElement, text: string, chars: readonly CharSource[]): boolean {
  const ink: CharSource[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i]!)) ink.push(chars[i]!);
  }
  if (ink.length === 0) return false;

  const anchors: XmlElement[] = [];
  for (let el: XmlElement | null = ink[0]!.owner; el && el !== element; el = el.parent) {
    if (el.tag === 'a' && el.attrs.has('href')) anchors.push(el);
  }
  return anchors.some((anchor) => ink.every((ch) => {
    for (let el: XmlElement | null = ch.owner; el && el !== element; el = el.parent) {
      if (el === anchor) return true;
    }
    return false;
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection
// ─────────────────────────────────────────────────────────────────────────────

/** A half-open source range to cut out. */
export interface SourceRange { start: number; end: number }

export interface AppliedProjection {
  deletion: FootnoteDeletion;
  /** The characters actually removed, concatenated. */
  removed: string;
  /** Whitespace-collapsed context: `…before [REMOVED: "1"] after…`. */
  context: string;
}

export type RejectionReason =
  | 'the replacement is empty'
  | 'the replacement is not the anchor with characters deleted'
  | 'the anchor does not occur in the text'
  | 'the deletion removes nothing'
  | 'the deletion spans a line break, which has no characters to remove';

export interface RejectedProjection {
  deletion: FootnoteDeletion;
  reason: RejectionReason;
}

export interface UnitProjection {
  applied: AppliedProjection[];
  rejected: RejectedProjection[];
  /** Source ranges to cut, including whole elements the deletions emptied. */
  ranges: SourceRange[];
  /** Inline elements removed because a deletion left them with no text at all. */
  emptied: Array<{ tag: string; ids: string[]; source: string }>;
  /** The unit's text after the applied deletions — the applier's own answer. */
  text: string;
}

const CONTEXT = 80;

/**
 * Apply one unit's deletions and say which BYTES they correspond to.
 *
 * The guards are the applier's, in the applier's order, so this cannot be more
 * permissive than `applyFootnoteDeletions` — plus one refusal of its own, for a
 * deletion that would have to remove a `<br/>`.
 */
export function projectDeletions(
  unit: ProseUnit,
  deletions: readonly FootnoteDeletion[],
  source: string,
): UnitProjection {
  let text = unit.text;
  let chars = unit.chars.slice();
  const removedChars = new Set<CharSource>();
  const applied: AppliedProjection[] = [];
  const rejected: RejectedProjection[] = [];
  const accepted: FootnoteDeletion[] = [];

  for (const deletion of deletions) {
    const { before, after } = deletion;
    if (!after) { rejected.push({ deletion, reason: 'the replacement is empty' }); continue; }
    if (!isDeletionOnly(before, after)) {
      rejected.push({ deletion, reason: 'the replacement is not the anchor with characters deleted' });
      continue;
    }
    if (before === after) {
      // `6.Ibid. → 6.Ibid.` — a line that announces a marker and then removes
      // none of it. The applier counts that as an applied edit that deleted the
      // empty string, which is true and useless: it inflates "markers removed"
      // with edits that changed nothing, in a report whose whole job is to say
      // how much of the book moved. Refused by name instead. The text is
      // identical either way, so the cross-check below is unaffected.
      rejected.push({ deletion, reason: 'the deletion removes nothing' });
      continue;
    }
    const at = text.indexOf(before);
    if (at < 0) {
      rejected.push({ deletion, reason: 'the anchor does not occur in the text' });
      continue;
    }

    // Which indices inside the anchor `after` does not keep — the same two-pointer
    // walk the applier uses to name the deleted characters, run for its indices.
    const cut: number[] = [];
    let i = 0;
    for (const ch of after) {
      const j = before.indexOf(ch, i);
      if (j < 0) break;  // unreachable: isDeletionOnly has passed
      for (let k = i; k < j; k++) cut.push(at + k);
      i = j + 1;
    }
    for (let k = i; k < before.length; k++) cut.push(at + k);

    if (cut.some((idx) => chars[idx]!.srcStart < 0)) {
      rejected.push({
        deletion,
        reason: 'the deletion spans a line break, which has no characters to remove',
      });
      continue;
    }

    applied.push({
      deletion,
      removed: cut.map((idx) => text[idx]).join(''),
      context: contextLine(text, cut),
    });
    accepted.push(deletion);
    for (const idx of cut) removedChars.add(chars[idx]!);

    // Spliced by UTF-16 unit, in lockstep, so `chars[i]` never stops describing
    // `text[i]`. (Not `[...text]`, which iterates code points and would slide
    // the two apart the first time a book used an emoji or a rare CJK glyph.)
    const gone = new Set(cut);
    let nextText = '';
    const nextChars: CharSource[] = [];
    for (let idx = 0; idx < text.length; idx++) {
      if (gone.has(idx)) continue;
      nextText += text[idx];
      nextChars.push(chars[idx]!);
    }
    text = nextText;
    chars = nextChars;
  }

  // THE CROSS-CHECK. The markup edit and the text edit must be the same edit; a
  // difference means the projection has drifted from the applier, and the
  // applier is the contract (ARCHITECTURE §7).
  const check = applyFootnoteDeletions(unit.text, accepted);
  if (check.text !== text) {
    throw new Error(
      'footnotes --epub: the projected edit disagrees with the applier on '
      + `<${unit.element.tag}> at offset ${unit.element.start}. This is a bug in the `
      + 'projection, not a bad answer from the model, and the document is left unedited.',
    );
  }

  const emptied = emptiedElements(unit, removedChars);
  const ranges: SourceRange[] = emptied.map((el) => ({ start: el.start, end: el.end }));
  for (const ch of removedChars) ranges.push({ start: ch.srcStart, end: ch.srcEnd });

  return {
    applied,
    rejected,
    ranges,
    emptied: emptied.map((el) => ({
      tag: el.tag,
      // Every id in the removed span, not just the wrapper's own. A `<sup>` in a
      // Calibre book holds a bookmark anchor beside the marker, and removing the
      // sup takes that anchor with it — so a "return to text" link from the
      // notes section now points at nothing. The report says which, because it
      // is a real consequence of removing markers and not a thing to discover
      // later in a reader.
      ids: [...elements(el)].map((e) => e.attrs.get('id')).filter((id): id is string => !!id),
      source: source.slice(el.start, el.end),
    })),
    text,
  };
}

/** `…anchor text [REMOVED: "1"] following text…`, whitespace collapsed for reading. */
function contextLine(text: string, cut: readonly number[]): string {
  const first = cut[0]!;
  const last = cut[cut.length - 1]!;
  const flat = (s: string): string => s.replace(/\s+/g, ' ');

  let span = '';
  let run = '';
  for (let i = first; i <= last; i++) {
    if (cut.includes(i)) { run += text[i]; continue; }
    if (run) { span += `[REMOVED: "${run}"]`; run = ''; }
    span += flat(text[i]!);
  }
  if (run) span += `[REMOVED: "${run}"]`;

  const pre = flat(text.slice(Math.max(0, first - CONTEXT), first));
  const post = flat(text.slice(last + 1, last + 1 + CONTEXT));
  return `${first > CONTEXT ? '…' : ''}${pre}${span}${post}${last + 1 + CONTEXT < text.length ? '…' : ''}`;
}

/**
 * The inline elements a deletion left with NO text content at all.
 *
 * "At all" is literal: an element still holding a space keeps its span, because
 * removing it would join the words either side of it. Elements holding an image
 * or a non-text child are never removed, and neither is anything block-level —
 * an emptied paragraph is a paragraph the model emptied, and that is not this
 * function's business to tidy away.
 *
 * Only the OUTERMOST emptied element is returned: removing `<sup>` already takes
 * the `<a>` inside it, and returning both would produce overlapping cuts.
 */
function emptiedElements(unit: ProseUnit, removed: ReadonlySet<CharSource>): XmlElement[] {
  const before = new Map<XmlElement, number>();
  const after = new Map<XmlElement, number>();
  for (const ch of unit.chars) {
    const gone = removed.has(ch);
    for (let el: XmlElement | null = ch.owner; el; el = el.parent) {
      before.set(el, (before.get(el) ?? 0) + 1);
      if (!gone) after.set(el, (after.get(el) ?? 0) + 1);
      if (el === unit.element) break;
    }
  }

  const candidates: XmlElement[] = [];
  for (const el of elements(unit.element)) {
    if (el === unit.element) continue;
    if (BLOCK_TAGS.has(el.tag)) continue;
    if ((before.get(el) ?? 0) === 0) continue;
    if ((after.get(el) ?? 0) !== 0) continue;
    let carriesNonText = false;
    for (const inner of elements(el)) {
      if (NON_TEXT_TAGS.has(inner.tag)) { carriesNonText = true; break; }
    }
    if (carriesNonText) continue;
    candidates.push(el);
  }

  const set = new Set(candidates);
  return candidates.filter((el) => {
    for (let p = el.parent; p && p !== unit.element; p = p.parent) if (set.has(p)) return false;
    return true;
  });
}

/**
 * Cut the ranges out of the source.
 *
 * Ranges are sorted and merged first, because an emptied element's span
 * SUBSUMES the character cuts inside it and the two arrive mixed. Overlapping
 * cuts that are not nested cannot occur — the model's deletions land on
 * disjoint text — and if one ever did, merging is still the safe reading: cut
 * the union once, never twice.
 */
export function spliceSource(source: string, ranges: readonly SourceRange[]): string {
  if (ranges.length === 0) return source;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
      continue;
    }
    merged.push({ ...range });
  }
  let out = '';
  let at = 0;
  for (const range of merged) {
    out += source.slice(at, range.start);
    at = range.end;
  }
  return out + source.slice(at);
}
