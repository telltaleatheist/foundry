/**
 * clean/stamp — the claim a FILE makes about itself.
 *
 * ── WHY A STAMP EXISTS BESIDE THE RECORDS ───────────────────────────────────
 *
 * A records file says what `clean-text` decided about a BOOK. The stamp says
 * that a particular EPUB was written from that decision — and the two are
 * needed because the render door is handed a FILE. By the queue, by a CLI, by a
 * batch chain on another machine: whatever hands the narrator an EPUB, the
 * narrator has only the EPUB, and it has to answer for itself.
 *
 * ── THE CONSTANTS ARE A CROSS-REPO CONTRACT AND ARE NEVER RETYPED ───────────
 *
 * `stampVersion` versions the SHAPE of this record; `normalizerVersion` and
 * `punctuationSpec` name the rules that produced the text. BookForge reads all
 * three back (`readNarrationTextStamp`, `narrationTextGate`) and a mismatch
 * against ITS build's versions means the book reads `stale` and the pass has to
 * run again. So the values are the contract, and two things follow that this
 * file exists to make impossible:
 *
 *  1. `normalizerVersion` and `punctuationSpec` are READ FROM THE MODULES that
 *     define them — `NORMALIZER_VERSION` and `PUNCTUATION_SPEC_VERSION`, both
 *     imported here — and never written as string literals. A literal is
 *     exactly the bug the training repo had: the rules moved, the constant
 *     moved with them, and a copy of the old value somewhere else went on
 *     claiming a pass that no longer runs. There is one place either version can
 *     be changed, and every stamp on every route reads it from there.
 *  2. The NAME and the shape are BookForge's, byte for byte. Same meta name,
 *     same field names, same `stampVersion` number. A stamp foundry writes and a
 *     stamp BookForge writes are the same six fields or the gate is reading a
 *     file it does not understand, and it reads an unreadable stamp as `stale`
 *     — which would silently make every foundry-cleaned book look uncleaned.
 *
 * ── EPUB 2's `name`/`content` FORM, ON PURPOSE ──────────────────────────────
 *
 * It needs no `prefix` declaration on `<package>`, every reader and every
 * validator ignores an unknown `name`, and both EPUB versions this project
 * writes carry it unchanged. A stamp already present is REPLACED, never joined:
 * two stamps would be two claims about one file.
 */
import * as fs from 'node:fs';

import { stripBom } from '../bom.js';
import { checkStampBlocks, textDigestOf } from './digest.js';
import { NORMALIZER_VERSION } from './tts-number-normalizer.js';
import { PUNCTUATION_SPEC_VERSION } from './tts-punctuation.js';

/** A stamp file this command will not read, or will not write. Always names it. */
export class NarrationStampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NarrationStampError';
  }
}

/**
 * The `<meta name>` the stamp is written under — BookForge's, verbatim.
 *
 * Not `foundry:` anything. The reader on the other side of this seam looks up
 * this exact string, and renaming it here would produce books that carry a
 * perfectly good stamp nothing will ever find.
 */
export const NARRATION_TEXT_STAMP_NAME = 'bookforge:narration-text';

/**
 * The shape of the record, versioned apart from the rules it records.
 *
 * It went 1 → 2 when `punctuationRefused` became required and the validator
 * learned that a reading must be a reading. Neither is a change to the
 * punctuation spec, so bumping `PUNCTUATION_SPEC_VERSION` would have told the
 * training side that a rule moved when none had; `NORMALIZER_VERSION` moved on
 * its own account. What changed was what a stamp MEANS, so books stamped by an
 * earlier build read stale by rule rather than by accident.
 */
export const NARRATION_TEXT_STAMP_VERSION = 2;

export interface NarrationTextStamp {
  /** `NARRATION_TEXT_STAMP_VERSION` — the shape of this record. */
  stampVersion: number;
  /** `NORMALIZER_VERSION` — the number rules and the prompt, together. */
  normalizerVersion: string;
  /** `PUNCTUATION_SPEC_VERSION` — the punctuation half. */
  punctuationSpec: string;
  /** The model tag that read the residue. */
  model: string;
  /** When the pass finished, ISO 8601. */
  at: string;
  /**
   * How many punctuation spans the pass could NOT canonicalize.
   *
   * Carried in the stamp and not only in the receipt so that a book with three
   * hundred unreachable spans is not byte-indistinguishable from a clean one,
   * and so the "nothing to do" line on a second run can say how many spans it
   * could not reach rather than claiming the book is already canonical.
   */
  punctuationRefused: number;
  /**
   * Every block this cleanup produced: its position → a digest of the text.
   *
   * ── WHY THE STAMP CARRIES THIS AND WHAT IT IS FOR ──────────────────────────
   *
   * The six fields above say a pass RAN, at these versions, with this model, and
   * every one of them is true of a pass that ran over a completely different
   * book. That is not a hypothetical: BookForge measured `vlm-compile
   * --narration-stamp` writing a valid stamp into the UNCLEANED parent book, and
   * the render door believed it. So the stamp now says what it cleaned, and the
   * commands that write it into a book recompute the same digests over the book
   * they were actually handed and refuse by name on a mismatch
   * (src/clean/digest.ts, which owns the text form and every argument about it).
   *
   * ── OPTIONAL, AND THAT IS NOT SOFTNESS ─────────────────────────────────────
   *
   * `stampVersion` STAYS 2 (Owen, 2026-09-05), because BookForge's reader
   * refuses a MISSING field and never enumerates keys — so the six it knows must
   * all still be there, and a field it has never heard of costs it nothing.
   * A stamp with no `blocks` therefore still reads: BookForge's own in-app pass
   * writes one, and so did foundry 1.1.0. What it does NOT get is a check, and
   * the command that writes it says so out loud rather than implying one
   * happened.
   */
  blocks?: Record<string, string>;
  /**
   * `blocks` as ONE order-independent digest — the whole-book form.
   *
   * This is the field that goes into the package document, because a `<meta
   * content=…>` holding thousands of hashes is not a package document.
   * `textDigestOf` computes it and argues the ordering.
   */
  textDigest?: string;
}

/**
 * The stamp as a PACKAGE DOCUMENT carries it.
 *
 * Owen, 2026-09-05: the OPF gets the six fields plus `textDigest` and the block
 * COUNT, never the per-block map. One word, `blocks`, and two renderings of it
 * — the map in the sidecar and how many positions that map holds in the package
 * — because they are the same fact and the package cannot hold the first form.
 * A reader wanting the map has the sidecar; a reader wanting to know whether two
 * files were cleaned from the same text has `textDigest`, which is what the map
 * is for anyway.
 */
export interface NarrationTextStampMeta {
  stampVersion: number;
  normalizerVersion: string;
  punctuationSpec: string;
  model: string;
  at: string;
  punctuationRefused: number;
  /** How many positions the cleanup produced. Absent with `textDigest`. */
  blocks?: number;
  textDigest?: string;
}

/**
 * The stamp for a run that has just finished.
 *
 * The two version fields are not parameters. See this file's header: the point
 * of a single constructor is that no caller anywhere can supply its own idea of
 * what `n6` is. `textDigest` is not a parameter either, and for the mirror
 * reason — it is a pure function of `blocks`, and a caller able to supply its own
 * would be able to supply one that does not describe the map beside it.
 */
export function narrationTextStamp(request: {
  model: string;
  at: string;
  punctuationRefused: number;
  /** Position → `blockDigest` of the cleaned text. Empty is legal and honest. */
  blocks: ReadonlyMap<string, string>;
}): NarrationTextStamp {
  return {
    stampVersion: NARRATION_TEXT_STAMP_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model: request.model,
    at: request.at,
    punctuationRefused: request.punctuationRefused,
    blocks: Object.fromEntries(request.blocks),
    textDigest: textDigestOf(request.blocks),
  };
}

/**
 * The package document's form of a stamp — see `NarrationTextStampMeta`.
 *
 * A stamp that carries no `blocks` produces neither field rather than a `0` and
 * an empty digest: zero cleaned blocks is a thing a stamp could honestly say,
 * and a stamp that never said it must not be made to.
 */
export function narrationStampMeta(stamp: NarrationTextStamp): NarrationTextStampMeta {
  return {
    stampVersion: stamp.stampVersion,
    normalizerVersion: stamp.normalizerVersion,
    punctuationSpec: stamp.punctuationSpec,
    model: stamp.model,
    at: stamp.at,
    punctuationRefused: stamp.punctuationRefused,
    ...(stamp.blocks === undefined ? {} : { blocks: Object.keys(stamp.blocks).length }),
    ...(stamp.textDigest === undefined ? {} : { textDigest: stamp.textDigest }),
  };
}

/**
 * Recompute a stamp over the text actually being stamped, and hand back what
 * the package document should carry.
 *
 * ── THE ONE DOOR EVERY STAMP GOES THROUGH ON ITS WAY INTO A BOOK ────────────
 *
 * `vlm-compile` and `vlm-convert` both write this claim into somebody's OPF, so
 * both of them ask this, and neither of them holds an opinion about what a
 * digest is or which text form it is over — src/clean/digest.ts owns both and is
 * the only place either is written down. What the caller supplies is the thing
 * it is holding: position → text, as ITS book actually reads.
 *
 * A STAMP THAT NAMES NO BLOCKS IS CARRIED AND SAID OUT LOUD. BookForge's in-app
 * pass writes one, and so did foundry 1.1.0; refusing them would refuse every
 * book cleaned before today for carrying a stamp that was correct when it was
 * written. What is not acceptable is implying a check that did not happen, so
 * the note names the omission and says what to do about it (ARCHITECTURE §8).
 */
export function checkedNarrationStampMeta(request: {
  /** The stamp, as this program serialized the file it read. */
  stampJson: string;
  /** The file it was read from — a person fixes a path, not a JSON blob. */
  stampPath: string;
  /** Position → text, as the thing about to be stamped holds it. */
  texts: ReadonlyMap<string, string>;
  /** What is being stamped, for the refusal and the note. */
  where: string;
  /** `vlm-compile` / `vlm-convert` — whose log this is. */
  command: string;
  /** This route's own sentence about what to do instead. */
  remedy: string;
  log: (message: string) => void;
  /** The caller's own error class. A refusal is never this file's to choose. */
  fail: (message: string) => never;
}): string {
  // Parsed back from this program's own `JSON.stringify` of a file
  // `readNarrationStampFile` already checked field by field, which is why this
  // is a cast and not a second validator.
  const stamp = JSON.parse(request.stampJson) as NarrationTextStamp;

  if (stamp.blocks === undefined) {
    request.log(
      `${request.command}: --narration-stamp ${request.stampPath} names no cleaned block positions, `
      + 'so NOTHING WAS RECOMPUTED and this run is taking the stamp\'s word for it that '
      + `${request.where} is the book that cleanup produced. Stamps written by this build carry a `
      + 'digest per position and are checked; re-run `foundry clean-text` to get one.',
    );
    return JSON.stringify(narrationStampMeta(stamp));
  }

  const check = checkStampBlocks({
    blocks: stamp.blocks,
    texts: request.texts,
    stampPath: request.stampPath,
    where: request.where,
    remedy: request.remedy,
    fail: request.fail,
  });
  request.log(
    `${request.command}: --narration-stamp recomputed over ${request.where} — ${check.matched} `
    + `block(s) hold exactly the text the cleanup produced${check.skipped === 0 ? '' : `, and `
      + `${check.skipped} position(s) the stamp names are not in this book at all (a struck block `
      + 'is legitimately absent, so those are skipped rather than refused)'}.`,
  );
  return JSON.stringify(narrationStampMeta(stamp));
}

/**
 * Read a stamp file written by this command or by BookForge, or refuse it.
 *
 * EVERY FIELD IS CHECKED AND EACH ONE IS NAMED WHEN IT IS WRONG, because the
 * caller is about to write this JSON into a book's package document and a
 * malformed stamp there is worse than none: the gate reads a stamp it cannot
 * parse as `stale`, so a book carrying rubbish looks exactly like a book that
 * was never cleaned, and the person who runs the pass again to fix it gets the
 * same rubbish written a second time.
 *
 * A stamp whose versions do not match THIS build is read and returned anyway.
 * That is deliberate: `vlm-compile --narration-stamp` is stamping a book with
 * what a pass actually did, and a pass that ran at `n5` produced text at `n5`.
 * Writing today's version over it would be this command lying on the pass's
 * behalf. The gate downstream is what decides that `n5` is stale, which is the
 * job it exists for.
 */
export function readNarrationStampFile(stampPath: string): NarrationTextStamp {
  let raw: string;
  try {
    raw = stripBom(fs.readFileSync(stampPath, 'utf8'));
  } catch (err) {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} cannot be read (${(err as Error).message}). It is the file `
      + '`foundry clean-text --stamp` writes; name that file, or leave the flag off.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} is not JSON (${(err as Error).message}).`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} holds ${Array.isArray(parsed) ? 'an array' : typeof parsed}, `
      + 'and a narration text stamp is one JSON object of six fields.',
    );
  }

  const row = parsed as Partial<NarrationTextStamp>;
  const missing: string[] = [];
  if (typeof row.stampVersion !== 'number') missing.push('stampVersion (a number)');
  if (typeof row.normalizerVersion !== 'string') missing.push('normalizerVersion (a string)');
  if (typeof row.punctuationSpec !== 'string') missing.push('punctuationSpec (a string)');
  if (typeof row.model !== 'string') missing.push('model (a string)');
  if (typeof row.at !== 'string') missing.push('at (an ISO-8601 string)');
  if (typeof row.punctuationRefused !== 'number') missing.push('punctuationRefused (a number)');
  if (missing.length > 0) {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} is not a narration text stamp: it is missing or mistypes `
      + `${missing.join(', ')}. The six fields are stampVersion, normalizerVersion, `
      + 'punctuationSpec, model, at and punctuationRefused, and `foundry clean-text --stamp` '
      + 'writes all of them.',
    );
  }

  /*
   * A SHAPE FROM THE FUTURE IS REFUSED RATHER THAN COPIED THROUGH.
   *
   * `stampVersion` is the one field that says how to read the other five, so a
   * stamp claiming a shape this build does not know is a stamp this build
   * cannot check — and writing it into a book would be putting a claim in front
   * of a reader that nothing here has read. A stamp from an EARLIER shape is
   * refused for the mirror reason: version 1 had no `punctuationRefused`, so a
   * file that passed the field checks above while calling itself version 1 is
   * describing itself wrongly, and the honest answer is to say so.
   */
  if (row.stampVersion !== NARRATION_TEXT_STAMP_VERSION) {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} says stampVersion ${row.stampVersion}, and this build reads `
      + `stampVersion ${NARRATION_TEXT_STAMP_VERSION}. A stamp whose shape this program cannot `
      + 'check is one it will not write into a book. Re-run `foundry clean-text` to produce a '
      + 'stamp this build wrote.',
    );
  }

  /*
   * ── THE BLOCK MAP IS CHECKED AS A SHAPE, AND ONLY AS A SHAPE ────────────────
   *
   * Absent is legal (see `NarrationTextStamp.blocks`). Present and not a flat
   * object of strings is not: the caller is about to hash text against these
   * values, and a `blocks` holding a number or a nested object would compare
   * every position against something that is not a digest and refuse the whole
   * book — a false accusation, in the one place this program is asserting that
   * somebody's book is not what it claims to be. Whether the digests are RIGHT
   * is exactly the question `checkStampBlocks` exists to ask; whether they are
   * digest-shaped is this reader's, because it is the only reader.
   */
  const blocks = readBlocks(row.blocks, stampPath);
  if (blocks !== undefined && typeof row.textDigest !== 'string') {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} names ${Object.keys(blocks).length} cleaned block(s) and `
      + 'carries no textDigest over them. The two are written together by one constructor '
      + '(`narrationTextStamp`), so a stamp with one and not the other was assembled by hand or by '
      + 'a program that does not know what either means.',
    );
  }
  return {
    stampVersion: row.stampVersion,
    normalizerVersion: row.normalizerVersion!,
    punctuationSpec: row.punctuationSpec!,
    model: row.model!,
    at: row.at!,
    punctuationRefused: row.punctuationRefused!,
    ...(blocks === undefined ? {} : { blocks }),
    ...(typeof row.textDigest === 'string' ? { textDigest: row.textDigest } : {}),
  };
}

/** `blocks`, proved to be a flat map of strings, or undefined where absent. */
function readBlocks(raw: unknown, stampPath: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NarrationStampError(
      `--narration-stamp ${stampPath} holds a "blocks" that is `
      + `${Array.isArray(raw) ? 'an array' : typeof raw}. In a stamp FILE, blocks is the map from `
      + 'each cleaned block\'s position to a digest of the text the cleanup produced there '
      + '(a package document carries the COUNT instead).',
    );
  }
  const out: Record<string, string> = {};
  for (const [position, digest] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof digest !== 'string') {
      throw new NarrationStampError(
        `--narration-stamp ${stampPath} holds a "blocks" entry for ${position} that is not a digest `
        + `but ${typeof digest}. Every value in that map is one block's text digest, as hex.`,
      );
    }
    out[position] = digest;
  }
  return out;
}
