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
}

/**
 * The stamp for a run that has just finished.
 *
 * The two version fields are not parameters. See this file's header: the point
 * of a single constructor is that no caller anywhere can supply its own idea of
 * what `n6` is.
 */
export function narrationTextStamp(request: {
  model: string;
  at: string;
  punctuationRefused: number;
}): NarrationTextStamp {
  return {
    stampVersion: NARRATION_TEXT_STAMP_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model: request.model,
    at: request.at,
    punctuationRefused: request.punctuationRefused,
  };
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

  return {
    stampVersion: row.stampVersion,
    normalizerVersion: row.normalizerVersion!,
    punctuationSpec: row.punctuationSpec!,
    model: row.model!,
    at: row.at!,
    punctuationRefused: row.punctuationRefused!,
  };
}
