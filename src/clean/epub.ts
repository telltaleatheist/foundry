/**
 * clean/epub — the FAILSAFE door: a bare EPUB in, the same EPUB with cleaned
 * text out.
 *
 * ── WHAT THIS IS FOR, AND WHAT IT IS NOT FOR ────────────────────────────────
 *
 * Owen, 2026-09-05, ruling on the second measured gap: the bare-EPUB cleanup
 * **STAYS, as a FAILSAFE** — for a person who exported a book and only then
 * remembered the pass, whom BookForge asks about at the narrate door — **and
 * never as the standard method.** The standard method is `--book --records`: a
 * cleanup is a STEP, its product is records keyed by the row ids the derived
 * book keeps, and everything the person does afterwards carries the cleanup
 * along. This route produces a FILE and nothing that remembers how it was made,
 * so a re-export from the project loses it. That is not a defect of this door;
 * it is what a door onto a finished file can be.
 *
 * ── ONE IMPLEMENTATION OF THE PASS, WHICH IS WHY IT RIDES `translate`'s ROUTE ─
 *
 * The alternative was a second cleanup — a copy of the three stages against a
 * document tree — and two implementations of a load-bearing definition is the
 * failure this whole feature exists to remove (ARCHITECTURE §2; the engine took
 * ownership of `NORMALIZER_VERSION` precisely so BookForge would stop carrying
 * its own). So this file is a READER and a WRITER around the same
 * `punctuateBlocks` / `askAboutEach` the book route runs, and every judgement it
 * makes about text is made by code neither route owns.
 *
 * What it reuses, named, so nothing here is mistaken for new machinery:
 *
 *  - `readFoundryBook` (src/translate/book.ts) — the container chain and the
 *    admission rule. An EPUB with no `data-bf-cat` anywhere is refused and told
 *    about `foundry epub-stamp`, exactly as `translate` refuses one.
 *  - `findBlocks` (src/translate/blocks.ts) — the same walk over the same
 *    stamped categories, so the blocks a cleanup touches on this route are the
 *    blocks a translation would.
 *  - `spliceAll` (same file) — every answer goes back into the SOURCE RANGE it
 *    came out of, right to left, with overlaps refused rather than resolved. The
 *    container, the ids, the file layout, the spine, `dc:identifier` and every
 *    unedited byte are preserved BY CONSTRUCTION rather than by intention.
 *
 * ── SEGMENTATION: TEXT NODES, WHICH IS WHAT THE PASS WAS WRITTEN FOR ────────
 *
 * The book-file route re-spells a segment as `markerSegments` because a row's
 * markup is IN its string (`**bold**`), and src/clean/segments.ts carries that
 * whole argument. THIS route has the real thing: a block is an element, its
 * markup is `<em>`, `<sup>` and anchors, and `segments` is the length of each
 * descendant TEXT NODE — which is the array the vendored pass was written
 * against and the array all three copies of its `SPANS_MARKUP` walk were typed
 * for. So the vendored code's own segmentation is used here, unchanged, and
 * `markerSegments` is not consulted at all: a `*` inside a publisher's paragraph
 * is an asterisk the author printed, not an emphasis delimiter, and protecting
 * it would refuse edits for a reason that is only true one route over.
 *
 * ── HOW AN ANSWER GETS BACK INTO THE DOCUMENT ───────────────────────────────
 *
 * Per TEXT NODE, and only where the node's text actually changed. A node the
 * pass did not touch keeps its own bytes — its entities, its whitespace, its
 * spelling — because nothing writes to it. A node that changed is written as
 * `escapeXmlText` of its new text, which is a faithful encoding of that text
 * (escape-then-decode is the identity) even where it is a different SPELLING of
 * it: `&#8212;` comes back as a literal em dash inside a node the pass rewrote,
 * and outside one it is untouched.
 *
 * THE ONE SPELLING THAT IS NOT SAFE TO RE-ENCODE is an entity this program does
 * not know. `decodeEntityAt` leaves `&oelig;` as its own seven characters — the
 * right answer for a reader building offsets, and the wrong thing to re-escape,
 * because `&amp;oelig;` would turn a œ a reader sees into the literal text
 * "&oelig;". So a block holding one is LEFT AS PRINTED and named, on
 * `translate`'s own mercy: it is a fact about ONE block, and killing a run over
 * it is the trade the flyleaf accession number settled.
 *
 * ── THE POSITIONS IN THIS ROUTE'S STAMP ARE THE ARCHIVE'S OWN ───────────────
 *
 * `<archive path>#<n>`, the block's ordinal in its document. A bare EPUB has no
 * book file and may carry no provenance at all — `epub-stamp` writes categories
 * and pages, not `data-bf-src` — so there is no row id to name. What follows is
 * stated rather than discovered: handing this route's `.stamp.json` to
 * `vlm-compile --narration-stamp` refuses, naming positions no book file has,
 * which is the correct answer. The stamp that matters on this route is the one
 * written into `--out`'s own package document, and it is written there.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { ensureDir } from '../fsdirs.js';
import { writeZip, zipText, type ZipEntry } from '../export/zip.js';
import { insertPackageMeta } from '../epub/meta.js';
import { decodeEntityAt, parseXml, type XmlElement, type XmlNode } from '../epub/xml.js';
import { BookError, readFoundryBook, type BookDocument } from '../translate/book.js';
import { findBlocks, spliceAll, type BlockSite } from '../translate/blocks.js';
import { TranslationBank } from '../translate/bank.js';
import { DEFAULT_OLLAMA_ENDPOINT, DEFAULT_TRANSLATE_MODEL } from '../translate/run.js';
import type { Transport } from '../translate/ollama.js';

import { blockDigest } from './digest.js';
import { narrationTextPrompt } from './prompt.js';
import { CleanTextError, nodeHolding, punctuateTarget } from './punctuate.js';
import type { PunctuationRefusal, PunctuationStageRecord } from './punctuate.js';
import { openOllamaRunner } from './runner.js';
import {
  narrationStampMeta, narrationTextStamp, NARRATION_TEXT_STAMP_NAME, type NarrationTextStamp,
} from './stamp.js';
import type { NarrationNumberTarget, NarrationTextRewrite } from './targets.js';
import { askAboutEach, EVERY_CLASS, NORMALIZER_VERSION } from './tts-number-normalizer.js';
import type {
  NumberEditRecord, NumberNormalizerRunner, NumberUnitRecord,
} from './tts-number-normalizer.js';
import { PUNCTUATION_SPEC_VERSION } from './tts-punctuation.js';

/** Fields are NUL-joined so no field's content can spell another's boundary. */
const NUL = String.fromCharCode(0);

/**
 * The question this route asks about one block, as one hex string.
 *
 * ── WHY THERE ARE TWO KEY FORMATS AND NOTHING IS MIGRATED ───────────────────
 *
 * `bank.ts`'s `KEY_FORMATS` rule, arrived at for the same reason one file over.
 * `cleanKey` (src/clean/run.ts) hashes a book file ROW: one string in the
 * flowing dialect, answered with one string. This route hashes a document
 * ELEMENT: the same words cut into text nodes, answered with one string PER
 * NODE. The same paragraph therefore asks a different question here — and the
 * answers are not interchangeable in either direction, because a node array
 * replayed into a different markup shape would put a cleaned clause inside the
 * wrong `<em>`.
 *
 * SO THE SPLIT IS IN THE KEY, not only the words. Two blocks whose text is
 * identical but whose emphasis falls in different places are two questions, and
 * a banked answer can only ever be replayed into the shape it was written for —
 * which is what makes the replay a splice rather than a guess.
 */
export function cleanEpubKey(request: { nodes: readonly string[]; model: string }): string {
  const fields = [
    'clean/xhtml/v1',
    request.model.trim(),
    NORMALIZER_VERSION,
    PUNCTUATION_SPEC_VERSION,
    ...request.nodes,
  ];
  return createHash('sha256').update(fields.join(NUL), 'utf8').digest('hex');
}

/** Where the answers are banked, so a killed run re-buys nothing. */
export function cleanEpubBankPath(outPath: string): string {
  return `${path.resolve(outPath)}.clean-bank.jsonl`;
}

/** Where the stamp lands beside the book — the sidecar/OPF pair, on this route too. */
export function cleanEpubStampPath(outPath: string): string {
  return `${path.resolve(outPath)}.stamp.json`;
}

/** One descendant text node of a block, and how to write it back. */
interface TextNodeSpan {
  /** Source range of the RAW text, entities and all. */
  start: number;
  end: number;
  /** The text a reader sees — what the pass measures and rewrites. */
  text: string;
  /**
   * Whether the raw source holds an `&` this program could not decode.
   *
   * See the file header: such a node cannot be re-encoded without changing what
   * a reader sees, so a block holding one is left as printed rather than
   * rewritten.
   */
  unknownEntity: boolean;
}

/** A block of the book, as this route sees it. */
interface EpubBlock {
  /** `<archive path>#<n>` — this route's spelling of a position. */
  position: string;
  documentPath: string;
  site: BlockSite;
  nodes: TextNodeSpan[];
  /** The block's whole text: the nodes, concatenated. */
  text: string;
  /** The length of each node, in order. Sums to `text.length`. */
  segments: number[];
}

export interface CleanEpubOptions {
  epubPath: string;
  outPath: string;
  /** Default `DEFAULT_OLLAMA_ENDPOINT`. */
  endpoint?: string;
  /** Default `DEFAULT_TRANSLATE_MODEL`. */
  model?: string;
  /** Leave the weights loaded when the run ends. */
  keepModel?: boolean;
  /** Injected so the tests drive the whole pass with no server and no GPU. */
  transport?: Transport;
  /** Injected so a test can settle every block without a transport at all. */
  runner?: NumberNormalizerRunner;
  log: (message: string) => void;
}

export interface CleanEpubOutcome {
  /** How many blocks the walk covered. */
  blocks: number;
  /** How many came out different from what the book printed. */
  changed: number;
  /** Punctuation spans plus model edits the validators would not accept. */
  refused: number;
  /** Blocks answered out of the bank, costing nothing. */
  reused: number;
  /** Blocks left exactly as printed, each named in the log. */
  keptAsPrinted: number;
  /** Documents whose bytes changed. The rest are copied through untouched. */
  documentsRewritten: number;
  stamp: NarrationTextStamp;
}

/**
 * Every descendant text node of a fragment, in order, with document offsets.
 *
 * `getUnitTextContent` and `textNodeSegments` are ONE CONTRACT in the vendored
 * pass — the segments are text-node lengths that must sum to `text.length` —
 * and this is both halves of it computed in one walk, which is the only way
 * they cannot disagree.
 *
 * A CDATA SECTION MAKES THE BLOCK UNREADABLE HERE and says so by returning
 * null. Its payload is text a reader sees, so ignoring it would hand the model
 * a block missing some of its own words; and writing into one is a different
 * escaping rule from every other node. Nothing this project emits writes CDATA,
 * so the honest answer is to leave that block as printed and name it.
 */
function textNodesOf(source: string, site: BlockSite): TextNodeSpan[] | null {
  const fragment = source.slice(site.innerStart, site.innerEnd);
  let root: XmlElement;
  try {
    root = parseXml(fragment, 'xhtml');
  } catch {
    return null;
  }
  const out: TextNodeSpan[] = [];
  let cdata = false;
  const walk = (node: XmlNode): void => {
    if (node.kind === 'text') {
      const raw = fragment.slice(node.start, node.end);
      let text = '';
      let unknownEntity = false;
      for (let i = 0; i < raw.length;) {
        const entity = decodeEntityAt(raw, i);
        if (entity !== null) { text += entity.text; i += entity.length; continue; }
        // A `&` that opened nothing this program knows. See `TextNodeSpan`.
        if (raw[i] === '&') unknownEntity = true;
        text += raw[i];
        i += 1;
      }
      out.push({
        start: site.innerStart + node.start,
        end: site.innerStart + node.end,
        text,
        unknownEntity,
      });
      return;
    }
    if (node.kind === 'other') {
      if (node.what === 'cdata') cdata = true;
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return cdata ? null : out;
}

/** Text on its way back into a document. `epub/meta.ts`'s `escapeText`, verbatim. */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Apply accepted spans to a block's text AND to its segment lengths.
 *
 * The book route re-derives its segments from the rewritten string
 * (`segmentsAfter`), which it may because a marker run is a run of characters no
 * punctuation rule and no reading touches. A TEXT NODE boundary cannot be
 * re-derived from a string at all — it is a fact about the document — so it is
 * carried, and a span is proved to sit inside ONE node before it moves anything.
 *
 * Back to front, so an earlier splice cannot move a later offset, and the node
 * a span sits in is looked up in the segments as they stand: a node's START is
 * never moved by an edit inside it or after it, so every earlier span still
 * resolves to the node it resolved to before.
 *
 * A SPAN THAT CROSSES A NODE HERE IS A DEFECT, not a fact about the book. All
 * three of the vendored pass's `SPANS_MARKUP` checks run against these same
 * segments before an edit is ever accepted, so reaching this is the checks and
 * the writer disagreeing, and it throws rather than flattening somebody's
 * markup.
 */
function applyToNodes(
  text: string,
  segments: readonly number[],
  spans: readonly NarrationTextRewrite[],
  where: string,
): { text: string; segments: number[] } {
  let out = text;
  const lengths = [...segments];
  for (const span of [...spans].sort((a, b) => b.at - a.at)) {
    const end = span.at + span.find.length;
    if (out.slice(span.at, end) !== span.find) {
      throw new CleanTextError(
        `clean-text could not splice "${span.find}" into ${where} at ${span.at} — the text there `
        + `reads "${out.slice(span.at, end)}". Nothing was written.`,
      );
    }
    const node = nodeHolding(lengths, span.at, end);
    if (node < 0) {
      throw new CleanTextError(
        `clean-text accepted an edit in ${where} that crosses a text node — "${span.find}" would `
        + 'have reached across an <em>, a <sup> or a link. The validators and the writer disagree '
        + 'about this block; nothing was written.',
      );
    }
    lengths[node] = lengths[node]! + (span.replace.length - span.find.length);
    out = out.slice(0, span.at) + span.replace + out.slice(end);
  }
  return { text: out, segments: lengths };
}

/** Every disposition that means the validators would not let an edit through. */
function isRefusal(status: string): boolean {
  return status !== 'APPLIED' && status !== 'APPLIED_RULE'
    && status !== 'SCRIPTURE_PROTECTED' && status !== 'NOOP';
}

/**
 * Clean the text of a Foundry-stamped EPUB and write a new one.
 *
 * The three stages are the doctrine's, in the doctrine's order, over the same
 * code the book route runs. What is here is the reading, the splice and the
 * stamp.
 */
export async function cleanTextEpub(opts: CleanEpubOptions): Promise<CleanEpubOutcome> {
  const started = Date.now();
  const at = new Date().toISOString();
  const model = opts.model ?? DEFAULT_TRANSLATE_MODEL;
  const endpoint = opts.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
  const epubPath = path.resolve(opts.epubPath);
  const outPath = path.resolve(opts.outPath);

  /*
   * THE ENGINE'S STANDING SELF-OVERWRITE REFUSAL. The input is somebody's book
   * and this command writes a different one; a run that wrote over its own
   * source would leave nothing to re-run against when the answer was wrong.
   */
  if (epubPath === outPath) {
    throw new CleanTextError(
      `--out ${outPath} is --epub itself. This command writes a NEW book and never edits one in `
      + 'place: the input is what a second run would have to read, and a pass that consumed it '
      + 'would make its own result impossible to check. Name a different --out.',
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(epubPath));
  } catch (err) {
    throw new CleanTextError(`--epub ${epubPath} cannot be read (${(err as Error).message}).`);
  }

  let book;
  try {
    book = readFoundryBook(
      bytes,
      'a cleanup rewrites the text inside the categories foundry stamps, and `foundry epub-stamp` '
      + 'is the command that puts them on a publisher\'s book',
    );
  } catch (err) {
    if (!(err instanceof BookError)) throw err;
    throw new CleanTextError(`--epub ${epubPath}: ${err.message}`);
  }

  // ── The walk: exactly the blocks a translation would touch ────────────────
  const blocks: EpubBlock[] = [];
  const keptAsPrinted: string[] = [];
  const perDocument = new Map<string, BlockSite[]>();

  for (const document of book.documents) {
    if (!document.stamped) continue;
    const found = findBlocks(document.source, document.path);
    perDocument.set(document.path, found.sites);
    for (const [category, count] of found.skipped) {
      opts.log(`clean-text: ${count} ${category} block(s) in ${document.path} skipped — no words to clean`);
    }
    for (const note of found.notes) opts.log(`clean-text: ${note}`);

    for (const [ordinal, site] of found.sites.entries()) {
      const position = `${document.path}#${ordinal}`;
      const nodes = textNodesOf(document.source, site);
      if (nodes === null) {
        keptAsPrinted.push(`${position} holds a CDATA section, whose payload is text this stage has `
          + 'no rule for writing back');
        continue;
      }
      const text = nodes.map((node) => node.text).join('');
      if (text.trim().length === 0) continue;
      blocks.push({
        position,
        documentPath: document.path,
        site,
        nodes,
        text,
        segments: nodes.map((node) => node.text.length),
      });
    }
  }
  for (const one of keptAsPrinted) opts.log(`clean-text: LEFT AS PRINTED — ${one}`);

  if (blocks.length === 0) {
    throw new CleanTextError(
      `--epub ${epubPath} carries foundry's stamps and not one stamped block with words in it, so `
      + 'there is nothing to clean.',
    );
  }

  /*
   * ── THE BANK, FOR bank.ts's OWN MEASURED REASON ────────────────────────────
   *
   * This route's product is a ZIP written at the very end, so a run killed at
   * block 400 of 456 has written NOTHING — which is the exact measurement
   * `--bank` exists because of. It is not a flag here because there is nothing
   * to choose: the book route's cost cache is the records file the caller names,
   * and this route names no records file, so the cache is a sidecar off `--out`
   * exactly as the stamp is. It is said out loud rather than left to be found.
   */
  const bankPath = cleanEpubBankPath(outPath);
  const bank = TranslationBank.open(bankPath);
  const keyOf = new Map<string, string>();
  for (const block of blocks) {
    keyOf.set(block.position, cleanEpubKey({ nodes: block.nodes.map((n) => n.text), model }));
  }
  const outstanding = blocks.filter((block) => bank.get(keyOf.get(block.position)!) === undefined);
  const reused = blocks.length - outstanding.length;
  opts.log(
    bank.size === 0
      ? `clean-text: nothing is banked in ${bankPath}, so every block is asked of the model and `
        + 'banked there as it lands — a killed run resumes and re-buys nothing.'
      : `clean-text: ${bank.size} answer(s) are banked in ${bankPath}; ${reused} of `
        + `${blocks.length} block(s) are already answered at this exact question and are not asked `
        + 'again.',
  );

  // ── Stage 1 — punctuation, over the blocks this run will actually clean ───
  const cleanText = new Map<string, string>();
  const cleanSegments = new Map<string, number[]>();
  const punctuationRefused: PunctuationRefusal[] = [];
  const punctuationCounts: Record<string, number> = {};
  let punctuationSpans = 0;
  let punctuationChanged = 0;

  for (const block of outstanding) {
    const target: NarrationNumberTarget = {
      key: block.position,
      kind: 'unit',
      file: block.documentPath,
      tag: block.site.tag,
      statedCategory: block.site.category,
      text: block.text,
      segments: block.segments,
      /*
       * THE AUTHOR'S OWN WHITESPACE, as far as this route can see it. A `<pre>`
       * block, or one holding a `<pre>`, is refused by both stages and counted.
       * WHAT IS NOT CHECKED IS STATED: an ANCESTOR `<pre>` outside the block,
       * and an inline `white-space:` declaration on the element, are invisible
       * here — `findBlocks` reports a block's tag and range, not its attributes
       * or its ancestry. Neither is a shape this project's emitter writes, and
       * `epub-stamp` stamps blocks rather than layout wrappers, so the gap is a
       * publisher's hand-built book and it is named rather than papered over.
       */
      preformatted: block.site.tag === 'pre'
        || /<pre[\s>]/i.test(sourceOfBlock(book.documents, block)),
    };
    const settled = punctuateTarget(target);
    for (const [rule, n] of Object.entries(settled.counts)) {
      punctuationCounts[rule] = (punctuationCounts[rule] ?? 0) + n;
    }
    for (const refusal of settled.refused) {
      punctuationRefused.push(refusal);
      opts.log(
        `clean-text: REFUSED a punctuation span in ${refusal.key} — "${refusal.find}" would have `
        + `become "${refusal.replace}", and ${refusal.reason}.`,
      );
    }
    if (settled.rewrites.length === 0) {
      cleanText.set(block.position, block.text);
      cleanSegments.set(block.position, [...block.segments]);
      continue;
    }
    punctuationChanged += 1;
    punctuationSpans += settled.rewrites.length;
    const written = applyToNodes(block.text, block.segments, settled.rewrites, block.position);
    cleanText.set(block.position, written.text);
    cleanSegments.set(block.position, written.segments);
  }
  opts.log(
    `clean-text: punctuation (${PUNCTUATION_SPEC_VERSION}) rewrote ${punctuationSpans} span(s) `
    + `across ${punctuationChanged} block(s); ${punctuationRefused.length} refused.`,
  );

  // ── Stages 2 and 3 — the rules, then the model, on every block ────────────
  const asks = outstanding.map((block, index) => ({
    key: block.position,
    text: cleanText.get(block.position)!,
    segments: cleanSegments.get(block.position)!,
    // The neighbours are the blocks either side in DOCUMENT order across the
    // whole book, taken from the outstanding list for the book route's reason:
    // a neighbour answered on an earlier run has no cleaned text this run holds,
    // and showing the book's own words for it would show two dialects at once.
    previous: index > 0 ? cleanText.get(outstanding[index - 1]!.position)! : null,
    next: index + 1 < outstanding.length ? cleanText.get(outstanding[index + 1]!.position)! : null,
  }));

  const runner = opts.runner ?? (asks.length === 0
    ? NOTHING_TO_ASK
    : await openOllamaRunner({
      model,
      endpoint,
      ...(opts.transport === undefined ? {} : { transport: opts.transport }),
      ...(opts.keepModel === undefined ? {} : { keepModel: opts.keepModel }),
      log: opts.log,
    }));

  const settled = await askAboutEach(
    asks,
    runner,
    narrationTextPrompt(),
    (done, total, label) => {
      // `clean-text: <done>/<total>` — BookForge mirrors the shape, so it stays
      // exactly this, and the release tick is not a block (src/clean/run.ts).
      if (total > 0 && label !== 'Releasing model') opts.log(`clean-text: ${done}/${total}`);
    },
    'every-block',
    EVERY_CLASS,
  );

  // ── The verdicts, applied, and the answers banked as they land ────────────
  const units: NumberUnitRecord[] = [];
  let modelRefused = 0;

  for (const block of outstanding) {
    const decision = settled.decisions.get(block.position);
    if (decision === undefined) {
      throw new CleanTextError(
        `clean-text reached no decision about ${block.position} of ${epubPath}. The loop and the `
        + 'walk disagree about what this book holds, and nothing was written.',
      );
    }
    const before = cleanText.get(block.position)!;
    const written = applyToNodes(
      before, cleanSegments.get(block.position)!, decision.accepted, block.position);
    cleanText.set(block.position, written.text);
    cleanSegments.set(block.position, written.segments);

    for (const record of decision.records) {
      if (!isRefusal(record.status)) continue;
      modelRefused += 1;
      sayRefusal(opts.log, block.position, record);
    }
    units.push({
      key: block.position,
      kind: 'unit',
      file: block.documentPath,
      status: decision.status,
      text: block.text,
      edits: decision.records,
    });

    // Banked the moment the block has settled, never at the end of a document
    // or a run — `bank.ts`'s rule, for the measurement that produced it.
    bank.append({
      key: keyOf.get(block.position)!,
      source: block.text,
      answer: JSON.stringify(nodeTexts(written.text, written.segments, block.position)),
    });
  }

  // ── The splice: every answer back into the range it came out of ───────────
  const rewritten = new Map<string, string>();
  const edits = new Map<string, { start: number; end: number; text: string }[]>();
  /**
   * What each position holds IN THE FILE THIS RUN WRITES, which is what the
   * stamp is a claim about.
   *
   * It is filled here rather than read off the bank afterwards because the two
   * can disagree in exactly one place and it matters: a block left as printed
   * has an answer in the bank and none of it in the book. Digesting the bank
   * would put a claim in the package document about text a reader will not find,
   * which is the whole defect the digest exists to end — arriving by the back
   * door of this route's own mercy.
   */
  const finalText = new Map<string, string>();
  let changed = 0;

  for (const block of blocks) {
    const banked = bank.get(keyOf.get(block.position)!);
    if (banked === undefined) {
      throw new CleanTextError(
        `clean-text has no answer for ${block.position} after asking about it. Nothing was written.`,
      );
    }
    const parts = JSON.parse(banked) as string[];
    if (parts.length !== block.nodes.length) {
      throw new CleanTextError(
        `clean-text banked ${parts.length} text node(s) for ${block.position} and the book has `
        + `${block.nodes.length}. The bank at ${bankPath} answers a question this book does not ask; `
        + 'delete it and run again. Nothing was written.',
      );
    }
    const blockEdits: { start: number; end: number; text: string }[] = [];
    let unwritable: string | null = null;
    for (const [index, node] of block.nodes.entries()) {
      if (parts[index] === node.text) continue;
      if (node.unknownEntity) {
        unwritable = 'it holds an entity this program does not decode, and re-encoding the node '
          + 'would turn what a reader sees into its own source characters';
        break;
      }
      blockEdits.push({ start: node.start, end: node.end, text: escapeXmlText(parts[index]!) });
    }
    if (unwritable !== null) {
      keptAsPrinted.push(`${block.position} — ${unwritable}`);
      opts.log(`clean-text: LEFT AS PRINTED — ${block.position}: ${unwritable}`);
      finalText.set(block.position, block.text);
      continue;
    }
    finalText.set(block.position, parts.join(''));
    if (blockEdits.length === 0) continue;
    changed += 1;
    const list = edits.get(block.documentPath) ?? [];
    list.push(...blockEdits);
    edits.set(block.documentPath, list);
  }

  for (const document of book.documents) {
    const list = edits.get(document.path);
    if (list === undefined || list.length === 0) continue;
    rewritten.set(document.path, spliceAll(document.source, list));
  }

  /*
   * ── THE STAMP, AND IT IS THE ONLY CHANGE TO THE PACKAGE DOCUMENT ───────────
   *
   * `insertPackageMeta` splices by SOURCE OFFSET and never re-serialises, so
   * `dc:identifier`, `dc:language`, `dc:title`, the manifest, the spine and
   * every refinement come through as their own bytes. A stamp already present is
   * replaced rather than joined — two stamps would be two claims about one file.
   */
  const digests = new Map<string, string>();
  for (const block of blocks) {
    digests.set(block.position, blockDigest(finalText.get(block.position) ?? block.text));
  }
  const stamp = narrationTextStamp({
    model,
    at,
    punctuationRefused: punctuationRefused.length,
    blocks: digests,
  });
  rewritten.set(book.opfPath, insertPackageMeta(
    book.opfPath,
    book.opfSource,
    NARRATION_TEXT_STAMP_NAME,
    JSON.stringify(narrationStampMeta(stamp)),
  ));

  const entries: ZipEntry[] = book.members.map((member): ZipEntry => {
    const edited = rewritten.get(member.path);
    if (edited !== undefined) return zipText(member.path, edited);
    // Untouched: the bytes, the method and the checksum it arrived with —
    // `translate`'s writer, for `unzip.ts`'s reason. This is what keeps the
    // pictures, the fonts and the stylesheet free.
    return {
      path: member.path,
      data: member.raw,
      method: member.method === 8 ? 8 : 0,
      crc: member.crc,
      uncompressedSize: member.uncompressedSize,
    };
  });

  ensureDir(path.dirname(outPath));
  await Bun.write(outPath, writeZip(entries));

  const stampPath = cleanEpubStampPath(outPath);
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');

  const receiptPath = `${outPath}.receipt.json`;
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model,
    at,
    source: epubPath,
    punctuation: {
      spec: PUNCTUATION_SPEC_VERSION,
      targetsChanged: punctuationChanged,
      spansApplied: punctuationSpans,
      counts: punctuationCounts,
      refused: punctuationRefused,
    } satisfies PunctuationStageRecord,
    units,
    keptAsPrinted,
    unitsAsked: settled.asked,
    unitsParseFailed: settled.parseFailed,
  }, null, 2)}\n`, 'utf8');

  opts.log(
    `clean-text: ${edits.size} document(s) rewritten; the container, the ids, the spine and `
    + `every unedited byte are the book's own. The stamp is ${stampPath} and it is also in `
    + `${book.opfPath}; the receipt is ${receiptPath}.`,
  );
  const refused = punctuationRefused.length + modelRefused;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  opts.log(`clean-text: ${blocks.length} blocks, ${changed} changed, ${refused} edits refused in ${seconds}s`);

  return {
    blocks: blocks.length,
    changed,
    refused,
    reused,
    keptAsPrinted: keptAsPrinted.length,
    documentsRewritten: edits.size,
    stamp,
  };
}

/**
 * A block's text cut back into its nodes, by the segment lengths the writes
 * carried through.
 *
 * The lengths are the contract every reader of `segments` checks — they sum to
 * `text.length` — so this is a slice and never a search, and it is asserted
 * rather than assumed: a sum that has drifted means an edit moved a boundary
 * nobody accounted for, and the answer would be markup written into the wrong
 * element.
 */
function nodeTexts(text: string, segments: readonly number[], where: string): string[] {
  const total = segments.reduce((sum, n) => sum + n, 0);
  if (total !== text.length) {
    throw new CleanTextError(
      `clean-text finished ${where} with ${segments.length} text node(s) accounting for ${total} `
      + `character(s) of a ${text.length}-character block. Nothing was written.`,
    );
  }
  const out: string[] = [];
  let at = 0;
  for (const length of segments) {
    out.push(text.slice(at, at + length));
    at += length;
  }
  return out;
}

/** The block's own source, for the `<pre>` test. */
function sourceOfBlock(documents: readonly BookDocument[], block: EpubBlock): string {
  const document = documents.find((one) => one.path === block.documentPath);
  return document === undefined
    ? ''
    : document.source.slice(block.site.innerStart, block.site.innerEnd);
}

/**
 * The runner for a run that has no question — every method is a defect if it is
 * ever called. `src/clean/run.ts`'s `NOTHING_TO_ASK`, for its reasons.
 */
const NOTHING_TO_ASK: NumberNormalizerRunner = {
  model: '(no model — every block was already answered)',
  generate(): Promise<string> {
    throw new CleanTextError(
      'clean-text opened no model because every block of this book was already banked, and then '
      + 'something asked one anyway. Nothing was written.',
    );
  },
  async release(): Promise<void> { /* nothing was ever loaded. */ },
};

/** Say a refused edit, by its disposition's own name. `run.ts`'s `sayRefusal`. */
function sayRefusal(
  log: (message: string) => void,
  key: string,
  record: NumberEditRecord,
): void {
  log(
    `clean-text: REFUSED ${record.status} in ${key} — "${record.find}" → "${record.replace}"`
    + `${record.detail === undefined ? '' : ` (${record.detail})`}`,
  );
}
