/**
 * vlm/vtt-book — AN AUDIOBOOK'S TRANSCRIPT, MINTED INTO THE BOOK FILE.
 *
 * ── The ruling this file is the whole of ────────────────────────────────────
 *
 * BookForge wants `analyze` run over an audiobook, including the audiobooks
 * that have no text source at all — a recording and nothing else. `analyze`
 * reads exactly one thing, the book file (`book-file.ts`), so somebody has to
 * turn a transcript into one. The question was only ever WHO, and the answer is
 * the standing cross-repo ruling: **Foundry owns all text processing.** BookForge
 * never writes this format. The worker.py divergence is what a foreign
 * hand-rolled writer of a measured format ends as — two programs with two
 * opinions about one file, drifting apart a field at a time, and the drift is
 * only ever discovered by a book that renders wrong months later.
 *
 * So this is the third `f`. `book-run.ts` is `f(bank)`, `epub-explode.ts` is
 * `f(epub)`, and this is `f(vtt)`. All three produce the same value, `BookFile`,
 * and all three go out through the same `formatBookFile`. There is ONE writer of
 * the format and there are three ways to make a book, which is exactly the shape
 * the contract describes.
 *
 * ── ONE CUE IS ONE ROW, ALWAYS, EVEN WHEN IT HOLDS TWO SENTENCES ────────────
 *
 * The obvious refinement — a cue carrying "He left. She stayed." becomes two
 * rows — is refused, and refusing it is the point of this file rather than a
 * simplification of it. A finding's location in this project is a row id and a
 * pair of character offsets INTO THAT ROW'S TEXT (docs/ANALYSIS.md §6), and
 * BookForge turns a finding into a moment in an audio file by taking the row
 * back to the cue it came from and the offsets back to a fraction of that cue's
 * span. Cut one cue into two rows and every offset downstream is measured from
 * a string that no longer corresponds to anything with a timestamp on it.
 *
 * Nothing is lost by holding still: `analyze` cuts sentences INSIDE a row
 * (`splitSentences`, `src/analyze/sentences.ts`), so a two-sentence cue is
 * scored as two sentences either way. The only difference the split would make
 * is to the coordinate system, and the coordinate system is the contract.
 *
 * ── THE IDENTITY IS MINTED HERE, AND IT IS A FUNCTION OF THE CUES ───────────
 *
 * `BookSource.bankSha` is REQUIRED, and its principle is wider than its name:
 * it is the identity of the source this file is a pure function of, so that a
 * reader holding ids can tell whether the thing that minted them has moved
 * underneath it. A bank hashes the receipt's bytes; an EPUB hashes the
 * container's. A transcript could have hashed its bytes too, and that would have
 * been the wrong answer for a format nobody's writer serialises the same way
 * twice: a VTT re-emitted with `\r\n` line endings, or with the cue identifiers
 * renumbered, or with a comment added at the top, is the SAME transcript, and a
 * byte hash would call it a different book and refuse every report ever filed
 * against it.
 *
 * So the digest is taken over the PARSED CANONICAL CUES and not over the file:
 *
 *     sha-256 over the NUL-joined sequence of, for each cue in VTT order,
 *       index (1-based, as a decimal string)
 *       startMs (integer milliseconds, as a decimal string)
 *       endMs (integer milliseconds, as a decimal string)
 *       text (after tag-stripping and entity-decoding — the row's own text)
 *     first 16 hex of the digest.
 *
 * That has the two properties an identity needs and a byte hash has only one
 * of. It is INSENSITIVE to the serialisation — whitespace, line endings, cue
 * identifiers, `NOTE` blocks, cue settings, the order fields were written in —
 * so re-exporting a transcript does not orphan an hour of verdicts. And it is
 * SENSITIVE to every cue's content and timing, so a re-transcribe (different
 * words, or the same words cut at different moments) mints a different identity
 * and a report filed against the old one refuses BY CONSTRUCTION, downstream,
 * with nobody having to remember to check. Foundry mints it and BookForge never
 * passes one in: an identity a caller can hand you is an identity a caller can
 * get wrong, and there is no second opinion to have about it.
 *
 * ── `NOTE` BLOCKS ARE METADATA, AND ARE COUNTED OUT LOUD ────────────────────
 *
 * BookForge tags the stretches where forced alignment gave up and ASR filled in
 * with a `NOTE asr-fallback` block. A `NOTE` is a comment: it is not a cue, so
 * it is not a row and it is not in the digest — a transcript that gains a
 * comment is the same transcript. But it is not NOTHING either, because a book
 * whose transcript is entirely ASR is a book whose text is a machine's guess at
 * what was said, and that is worth knowing before reading a report about it. So
 * they are counted and the count is on the summary line, which puts it in the
 * run log where a person looking at a surprising report will find it.
 *
 * ── THE NO-PAGE FRAME, WHICH THIS ROUTE INHERITS RATHER THAN INVENTS ────────
 *
 * Every row is `page: 0`, `pages: [0]`, a zero box, a zero page size, one part
 * covering the whole text, and `typography` is null for the whole book. That is
 * `epub-explode.ts`'s frame, taken deliberately and unchanged: an audiobook has
 * no pages for the same reason an EPUB has none, `page` is an estimate that
 * NOTHING is addressed by (`book-file.ts`'s header), and a box exists to be
 * measured for type size and column width, of which a recording has neither. The
 * ids are the `e-<n>` family for the same reason as well — it is the bank-less
 * family, counted from 1 along a TOTAL ORDER the source itself supplies, which
 * for an EPUB is the spine and here is the tape.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { ensureDir } from '../fsdirs.js';
import { VERSION } from '../version.js';
import { formatBookFile, parseBookFile, type BookFile, type BookRow } from './book-file.js';

/** A transcript this command will not mint. Always says what about it stopped it. */
export class VttBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VttBookError';
  }
}

/** One cue, canonical — the four facts the identity and the row are made of. */
export interface VttCue {
  /** 1-based, in VTT order. This is the `n` of the row's `e-<n>`. */
  index: number;
  /** Integer milliseconds from the start of the recording. */
  startMs: number;
  endMs: number;
  /** The row's text: tags stripped, entities decoded, otherwise verbatim. */
  text: string;
}

/** What a transcript was found to hold. */
export interface VttParse {
  cues: VttCue[];
  /**
   * `NOTE` blocks met, `NOTE asr-fallback` among them. Counted rather than
   * kept: see this file's header on why a comment is not a row and is still
   * worth saying out loud.
   */
  notes: number;
}

/** The field separator inside the digest — `report.ts`'s reason, and `bank.ts`'s. */
const NUL = '\u0000';

/**
 * A cue's timing, in milliseconds.
 *
 * WebVTT writes `hh:mm:ss.mmm` and allows the hour to be dropped, which is the
 * only variation in the grammar and is entirely a matter of how long the
 * recording is. Both spellings mean the same instant, so both parse to the same
 * number — which is part of what makes the digest indifferent to who wrote the
 * file.
 */
function timestampMs(stamp: string): number | null {
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d)\.(\d{3})$/.exec(stamp);
  if (match === null) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  return ((hours * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
}

/** `<i>`, `</v>`, `<c.loud>`, `<v Roger Bingham>`, `<00:01:02.000>` — and nothing else. */
const CUE_TAG = /<\/?(?:[A-Za-z]+(?:\.[^\s.>]+)*(?:[ \t][^>]*)?|(?:\d+:)?\d{1,2}:\d{2}\.\d{3})>/g;

/**
 * A cue's text, decoded — and the ORDER OF THE TWO PASSES IS THE WHOLE OF IT.
 *
 * The tags come out FIRST and the entities are decoded SECOND, because the
 * escape exists precisely so that a transcript can carry a literal angle
 * bracket. Decode first and `&lt;i&gt;` — somebody who was actually talking
 * about the markup, or a line of a play with a stage direction in brackets —
 * becomes `<i>`, which the tag pass then eats. The words a person said would be
 * silently gone, which is the one thing this whole route exists to not do.
 *
 * ONLY WELL-FORMED TAGS ARE STRIPPED. `a < b` has an angle bracket in it and is
 * not markup; a pattern that took `<` to the next `>` would swallow a clause.
 * The three named entities are the ones WebVTT requires an escape for; anything
 * else stays exactly as the transcript typed it, because inventing a decoding
 * for it would be this program guessing at a convention it was not told about.
 *
 * NOTHING IS TRIMMED and nothing is collapsed. The reflow does that to a scan
 * because a scan's whitespace is an artefact of the printing; a cue's text is
 * what the transcriber wrote, and offsets into it are what BookForge anchors
 * time with, so the string this returns is the string the row carries.
 *
 * THIS RECIPE IS A CROSS-REPO CONTRACT, NOT AN IMPLEMENTATION DETAIL. BookForge
 * reimplements it (`analysisText` on its cues), verifies every run row-by-row
 * against the book file this program actually wrote, and FAILS its run on a
 * mismatch — deliberately, so a drifted recipe mis-anchors nothing and breaks
 * loudly instead (their keeper pins 16 cases). The standing agreement
 * (2026-08-26): any change to the tag stripping, the entity decoding or the
 * no-trim rule is ANNOUNCED to the BookForge side before it ships and lands in
 * the same release they follow it in. Changing this function quietly does not
 * break foundry; it breaks the next audiobook analysis on every machine that
 * kept its word.
 */
export function decodeCueText(raw: string): string {
  return raw
    .replace(CUE_TAG, '')
    .replace(/&(amp|lt|gt);/g, (_whole, name: string) =>
      (name === 'amp' ? '&' : name === 'lt' ? '<' : '>'));
}

/**
 * Read a transcript into its cues, or say exactly which line stopped it.
 *
 * ── WHAT IS A BLOCK, AND WHAT EACH KIND OF BLOCK IS ─────────────────────────
 *
 * A VTT is a signature line, an optional header, and then blocks separated by
 * blank lines. A block is a cue (an optional identifier line, a timing line,
 * then its text), a `NOTE` comment, or one of the two presentation blocks
 * `STYLE` and `REGION`. Only the first is a row: a comment is a comment, and a
 * stylesheet has no more business becoming a paragraph of somebody's book than
 * a `<style>` element does on the EPUB route.
 *
 * ── AND A BAD CUE STOPS THE RUN RATHER THAN BEING SKIPPED ───────────────────
 *
 * `vlm-book` names and skips a page whose answer will not parse, because one bad
 * page must not cost the other two hundred and ninety-nine and a bank is a
 * measurement of an unreliable thing. A transcript is not that. It was written
 * by a program that either works or does not, its cues are consecutive, and —
 * the load-bearing part — the row ids are the CUE INDEX, so skipping cue 40
 * would either renumber every row after it or leave a hole, and both of those
 * are a coordinate system that quietly disagrees with the file BookForge is
 * holding. So a malformed cue is a refusal that names the line.
 */
export function parseVtt(text: string, source: string): VttParse {
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  const first = lines[0] ?? '';
  if (!/^WEBVTT(?:[ \t].*)?$/.test(first)) {
    throw new VttBookError(
      `${source} does not begin with WEBVTT, so it is not a transcript this command can read. Every `
      + 'WebVTT file starts with that word on its first line; a file that does not is some other '
      + 'format, and reading it as this one would produce a book made of whatever happened to have '
      + 'an arrow in it.',
    );
  }

  // The header block runs to the first blank line and holds nothing this format
  // models — the file's own metadata, not the book's.
  let at = 1;
  while (at < lines.length && lines[at]!.trim().length > 0) at += 1;

  const cues: VttCue[] = [];
  let notes = 0;
  while (at < lines.length) {
    if (lines[at]!.trim().length === 0) { at += 1; continue; }
    const opened = at;
    const block: string[] = [];
    while (at < lines.length && lines[at]!.trim().length > 0) {
      block.push(lines[at]!);
      at += 1;
    }
    const head = block[0]!.trim();
    if (head === 'NOTE' || /^NOTE[ \t]/.test(head)) { notes += 1; continue; }
    if (head === 'STYLE' || head === 'REGION') continue;

    /*
     * The identifier is OPTIONAL and is not read. It is a name a writer chose
     * for a cue — very often just its ordinal, sometimes a uuid — and naming is
     * this format's own job (`e-<n>`, off the position, which cannot drift).
     * Keeping it out of the digest is the same decision said twice: a transcript
     * whose identifiers were renumbered by a re-export is the same transcript.
     */
    const timingAt = block[0]!.includes('-->') ? 0 : 1;
    const timing = block[timingAt];
    if (timing === undefined || !timing.includes('-->')) {
      throw new VttBookError(
        `${source} line ${opened + 1}: this block is neither a cue, a NOTE, a STYLE nor a REGION — `
        + 'its first two lines carry no "-->" timing, so there is nothing here that says when it was '
        + 'said.',
      );
    }
    const parts = /^\s*(\S+)[ \t]+-->[ \t]+(\S+)\s*(.*)$/.exec(timing);
    const startMs = parts === null ? null : timestampMs(parts[1]!);
    const endMs = parts === null ? null : timestampMs(parts[2]!);
    if (startMs === null || endMs === null) {
      throw new VttBookError(
        `${source} line ${opened + timingAt + 1}: "${timing.trim()}" is not a cue timing. A cue is `
        + 'timed "hh:mm:ss.mmm --> hh:mm:ss.mmm", with the hour optional and one space or tab either '
        + 'side of the arrow, and the moment a cue was said is half of what this file is for.',
      );
    }
    if (endMs < startMs) {
      throw new VttBookError(
        `${source} line ${opened + timingAt + 1}: this cue ends before it begins. Its span is what `
        + 'anchors a finding to a moment in the recording, and a negative one anchors nothing.',
      );
    }
    /*
     * NOT CHECKED: that the cues are in ascending order, or that they do not
     * overlap. Both are true of every transcript anybody writes and neither is
     * load-bearing here — the rows are in the file's own order whatever the
     * clock says, and a refusal on this would be this command rejecting a
     * perfectly readable transcript over a fact it does not use.
     */
    const cueText = decodeCueText(block.slice(timingAt + 1).join('\n'));
    if (cueText.trim().length === 0) {
      throw new VttBookError(
        `${source} line ${opened + 1}: this cue carries no words. Every cue becomes a row of the book `
        + 'and every row is named by its cue\'s position, so an empty one cannot be dropped without '
        + 'moving every name after it — and cannot be kept without putting a blank paragraph in '
        + 'somebody\'s book.',
      );
    }
    cues.push({ index: cues.length + 1, startMs, endMs, text: cueText });
  }
  return { cues, notes };
}

/**
 * The transcript's identity — the recipe in this file's header, in code.
 *
 * Read that argument before changing anything here: the choice of WHAT is
 * hashed is the whole reason a re-exported transcript keeps its reports and a
 * re-transcribed one loses them. The fields are joined with NUL because it is
 * the one byte a transcript cannot contain, so no two different cue sets can
 * flatten to the same string by moving a boundary.
 */
export function cueDigest(cues: readonly VttCue[]): string {
  const flat: string[] = [];
  for (const cue of cues) {
    flat.push(String(cue.index), String(cue.startMs), String(cue.endMs), cue.text);
  }
  return crypto.createHash('sha256').update(flat.join(NUL), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The cues as a book — the no-page frame, one row each.
 *
 * Separated from the run below so the arithmetic is testable without a
 * directory to write into, which is the seam `bookFromEpub` and `explodeEpub`
 * already sit either side of.
 */
export function bookFromCues(cues: readonly VttCue[], language: string): BookFile {
  const rows: BookRow[] = cues.map((cue): BookRow => ({
    id: `e-${cue.index}`,
    // A transcript is prose and nothing else. There is no markup to read a
    // heading out of and no box to measure one from, and a classifier that
    // guessed at chapter openings from the words would be this program adding
    // an opinion to a document that carries none. Everything is Text, which is
    // in `analyze`'s prose set, which is what this book is for.
    category: 'Text',
    text: cue.text,
    page: 0,
    pages: [0],
    box: { x1: 0, y1: 0, x2: 0, y2: 0 },
    pageWidth: 0,
    pageHeight: 0,
    // One part, always: a cue is one utterance and was never broken across
    // anything to be joined. `src` is the coordinate the row was minted at,
    // spelled as the EPUB route spells it, because it is the same id family and
    // two spellings of one coordinate is how two readers of it disagree.
    parts: [{ src: `e:${cue.index}`, page: 0, chars: [0, cue.text.length] }],
  }));

  return {
    engine: VERSION,
    language,
    source: {
      // The cues, which is what a transcript has instead of pages: the format
      // has one field for "how much source was there" and this is this book's
      // unit of it. (`epub-explode.ts` puts its spine documents here for the
      // same reason.)
      pages: cues.length,
      // Nothing was skipped. A cue that would not parse stopped the run, so a
      // transcript either mints whole or does not mint.
      unreadable: [],
      bankSha: cueDigest(cues),
    },
    // WRITTEN, AND ZERO, rather than left absent. Absent means "an engine older
    // than the field wrote this" (`BookFigures`), which would be a lie told to
    // the app's figure heal; `blocks: 0` with `from: null` says the true thing,
    // which is that a recording has no pictures in it and none was offered.
    figures: { blocks: 0, cut: 0, from: null },
    rows,
    // NO CHAPTER SEED. A transcript declares no divisions — no markup, no
    // contents, no page furniture — and detecting them from the words would be
    // an invention rather than a reading. Empty, never absent.
    chapters: [],
    // NO TYPOGRAPHY REPORT: the report is medians over boxes and there are no
    // boxes. Null is the contract's own spelling of that.
    typography: null,
    // NO SEAMS: a seam is a page turn the reflow declined to join, and there
    // are no pages.
    seams: [],
    // NO NOTES AND THEREFORE NO MARKERS. Nothing in a transcript is a footnote,
    // so neither linking flag can have an entry.
    loose: { markers: [], notes: [] },
  };
}

export interface VttBookOptions {
  vttPath: string;
  outPath: string;
  /** `--language`, declared and never detected. `en` where nothing says. */
  language: string;
  log: (line: string) => void;
}

export interface VttBookReport {
  /** Absolute, and the last line this command puts on stdout. */
  outPath: string;
  cues: number;
  notes: number;
  language: string;
  bankSha: string;
}

/**
 * THE RUN: a transcript in, a book file out.
 *
 * ── THE SELF-CHECK, AND WHY IT IS NOT PARANOIA ──────────────────────────────
 *
 * The file is written beside where it was asked for, READ BACK THROUGH
 * `parseBookFile`, and only then renamed into place. Two rules meet here. The
 * pending swap is the house's (`explodeEpub`, `buildBookFile`): a crash leaves
 * the old book or none, never half of one. The check on top of it is this
 * route's own, and it is here because this is the first minter written against a
 * format for a CALLER IN ANOTHER REPOSITORY. A minter that can emit a file its
 * own parser refuses hands BookForge a dud, and BookForge — which by ruling
 * knows nothing about this format — would report a Foundry parse error against a
 * file Foundry had just written and declared good. Checking costs a read of a
 * file that is already in the page cache; not checking costs a cross-repo
 * afternoon.
 *
 * The pending file is REMOVED when the check fails, because a `.tmp` that a
 * later run silently overwrites is debris rather than evidence, and the parser's
 * own sentence — which is quoted into the refusal — is the evidence.
 */
export function mintVttBook(opts: VttBookOptions): VttBookReport {
  const vttPath = path.resolve(opts.vttPath);
  if (!fs.existsSync(vttPath)) {
    throw new VttBookError(
      `no such transcript: ${vttPath}. This route mints a book out of an audiobook's own cues; there `
      + 'is no model here and no second source to fall back on, so an absent file is nothing it can '
      + 'make up for.',
    );
  }
  const parsed = parseVtt(fs.readFileSync(vttPath, 'utf8'), vttPath);
  if (parsed.cues.length === 0) {
    /*
     * REFUSED AT THE EARLIER, CLEARER SEAM. `analyze` would refuse this book
     * anyway — it has no prose to read — but it would refuse it two commands
     * later, about a file this one had declared good, and the person reading
     * that message would be looking for a defect in the book rather than at an
     * empty transcript.
     */
    throw new VttBookError(
      `${vttPath} holds no cues${parsed.notes > 0 ? ` (${parsed.notes} NOTE comment(s), which are not cues)` : ''}`
      + '. A book file made from it would have no text in it at all, and there is nothing for an '
      + 'analysis to read.',
    );
  }

  const book = bookFromCues(parsed.cues, opts.language);
  const resolved = path.resolve(opts.outPath);
  ensureDir(path.dirname(resolved));
  const pending = `${resolved}.tmp`;
  fs.writeFileSync(pending, formatBookFile(book), 'utf8');
  try {
    parseBookFile(stripBom(fs.readFileSync(pending, 'utf8')));
  } catch (err) {
    try {
      fs.unlinkSync(pending);
    } catch {
      // The refusal below is the thing worth reporting; a temp file that would
      // not delete must not replace it with a message about a temp file.
    }
    throw new VttBookError(
      'the book file this run wrote does not survive this program\'s own reader, so it was not put in '
      + `place: ${(err as Error).message}. That is a defect in foundry rather than in the transcript, `
      + 'and it is refused here rather than handed on as a book.',
    );
  }
  fs.renameSync(pending, resolved);

  opts.log(
    `vtt-book: ${parsed.cues.length} cue(s) as ${book.rows.length} row(s), `
    + `${parsed.notes} NOTE block(s) skipped as metadata`,
  );
  opts.log(`vtt-book: the language is ${opts.language}, declared on the command line`);
  opts.log(`vtt-book: the transcript's identity is ${book.source.bankSha} — sha-256 over the cues, not `
    + 'over the file, so re-exporting this transcript mints the same book and re-transcribing it '
    + 'mints a different one');
  opts.log(`vtt-book: wrote ${resolved}`);

  return {
    outPath: resolved,
    cues: parsed.cues.length,
    notes: parsed.notes,
    language: opts.language,
    bankSha: book.source.bankSha,
  };
}
