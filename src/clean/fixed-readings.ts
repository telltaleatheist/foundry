/**
 * clean/fixed-readings — readings a cleanup is HANDED, applied everywhere and
 * never asked about again (2026-10-03).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The sentence pass sees one sentence and has to guess what a printed form IS.
 * *Deathstalker: Hellworld* prints "esp" twenty-six times for a psychic sense;
 * shown "touched the sphere with her esp." alone, the model read it "especial",
 * and the same book came out saying "ESP" in one place and "especial" in two.
 * The evidence was in the book, just not in the sentence.
 *
 * So the caller (BookForge's narration glossary) decides each printed form ONCE,
 * from sentences across the whole book, and hands the answers here. This module
 * knows nothing about how they were decided or what a pronunciation is: it is a
 * list of exact strings and what to print in their place.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 *
 * Applied to every block's stage-one text (after punctuation, before the number
 * rules and the model), in BOTH the cleanup and its triage, so the two see the
 * same words: a triage then has no reason to flag a form that is already read,
 * and the model is shown "Wolf Four" and has no "IV" left to re-read.
 *
 * A find matches as a whole token run: the characters on either side of it are
 * not letters or digits. Case-sensitive, exact. Longer finds win where two
 * overlap, so "Wolf IV" is read before a bare "IV" could be.
 *
 * ── AND THE CACHE ────────────────────────────────────────────────────────────
 *
 * A block's question changes only when a reading that APPLIES to it changes
 * (`fixedKeyField`): a book whose glossary gains "esp → ESP" re-asks the blocks
 * printing "esp" and keeps every other answer it paid for.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { CleanTextError } from './punctuate.js';

export const FIXED_READINGS_FORMAT = 'fixed-readings/v1';

export interface FixedReading {
  /** Exactly as the book prints it. */
  find: string;
  /** What is printed in its place. */
  replace: string;
}

/** Inline markup is structure and never part of a reading (run.ts, `MARKUP`). */
const MARKUP = /[*_⁰¹²³⁴⁵⁶⁷⁸⁹]/;

/** What a reading may not touch on either side: a letter or a digit. */
const WORD = /[\p{L}\p{N}]/u;

/**
 * Read a `--fixed-readings` file, or say exactly what is wrong with it. A file
 * that is not one is MISCONFIGURATION — something a person can repair — so it
 * is refused by name rather than half-applied.
 */
export function readFixedReadingsFile(file: string): FixedReading[] {
  const where = path.resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(where, 'utf8')));
  } catch (err) {
    throw new CleanTextError(`--fixed-readings ${where} cannot be read as JSON (${(err as Error).message}).`);
  }
  const doc = parsed as { format?: unknown; readings?: unknown };
  if (doc?.format !== FIXED_READINGS_FORMAT || !Array.isArray(doc.readings)) {
    throw new CleanTextError(
      `--fixed-readings ${where} is not a ${FIXED_READINGS_FORMAT} file `
      + '({"format": "fixed-readings/v1", "readings": [{"find", "replace"}, ...]}).',
    );
  }
  return validateFixedReadings(doc.readings, where);
}

/** The list, checked entry by entry. Exported for the tests and for in-memory callers. */
export function validateFixedReadings(list: readonly unknown[], where = 'fixed readings'): FixedReading[] {
  const out: FixedReading[] = [];
  const seen = new Map<string, string>();
  list.forEach((raw, i) => {
    const one = raw as { find?: unknown; replace?: unknown };
    if (typeof one?.find !== 'string' || typeof one.replace !== 'string') {
      throw new CleanTextError(`${where}: reading ${i} needs a string "find" and a string "replace".`);
    }
    const find = one.find;
    const replace = one.replace;
    if (find.trim() !== find || find.length === 0) {
      throw new CleanTextError(`${where}: reading ${i} has an empty or space-edged find ${JSON.stringify(find)}.`);
    }
    if (replace.trim() !== replace || replace.length === 0) {
      throw new CleanTextError(`${where}: reading ${i} ("${find}") has an empty or space-edged replace.`);
    }
    if (MARKUP.test(find) || MARKUP.test(replace)) {
      throw new CleanTextError(
        `${where}: reading ${i} ("${find}" → "${replace}") touches inline markup — emphasis or a `
        + 'superscript note number — which a reading never crosses.',
      );
    }
    const earlier = seen.get(find);
    if (earlier !== undefined && earlier !== replace) {
      throw new CleanTextError(
        `${where}: "${find}" is given two readings, "${earlier}" and "${replace}". One printed form, one reading.`,
      );
    }
    if (earlier === undefined && find !== replace) out.push({ find, replace });
    seen.set(find, replace);
  });
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The finds, longest first, and one pattern that finds where any of them may start. */
interface Matcher { finds: string[]; pattern: RegExp }

function matcherFor(readings: readonly FixedReading[]): Matcher | null {
  if (readings.length === 0) return null;
  const finds = [...readings].map((r) => r.find).sort((a, b) => b.length - a.length);
  return { finds, pattern: new RegExp(finds.map(escape).join('|'), 'gu') };
}

/** Does `find` stand at `at` as a whole token run — nothing word-like touching either side? */
function standsAt(text: string, at: number, find: string): boolean {
  if (!text.startsWith(find, at)) return false;
  const end = at + find.length;
  return !(at > 0 && WORD.test(text[at - 1]!)) && !(end < text.length && WORD.test(text[end]!));
}

/**
 * Every occurrence of a reading in `text` that stands as a whole token run, in
 * order and non-overlapping. Where finds start at the same place the LONGEST
 * that stands there wins — and a shorter one still gets its turn when the
 * longer does not stand ("Dr.Smith": "Dr." is glued to a word, "Dr" is not).
 */
function occurrences(text: string, matcher: Matcher): { at: number; find: string }[] {
  const out: { at: number; find: string }[] = [];
  const { pattern, finds } = matcher;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const at = m.index;
    const find = finds.find((one) => standsAt(text, at, one));
    if (find === undefined) {
      // Nothing stands here ("esp" inside "especially"); look again one character on.
      pattern.lastIndex = at + 1;
      continue;
    }
    out.push({ at, find });
    pattern.lastIndex = at + find.length;
  }
  return out;
}

export interface FixedApplication {
  text: string;
  /** find → how many times it was read in this text. */
  applied: Map<string, number>;
}

/** Apply the readings to one text. */
export function applyFixedReadings(text: string, readings: readonly FixedReading[]): FixedApplication {
  const applied = new Map<string, number>();
  const matcher = matcherFor(readings);
  if (matcher === null) return { text, applied };
  const byFind = new Map(readings.map((r) => [r.find, r.replace] as const));
  let out = '';
  let from = 0;
  for (const hit of occurrences(text, matcher)) {
    const replace = byFind.get(hit.find)!;
    const end = hit.at + hit.find.length;
    /*
     * A PERIOD THAT IS BOTH THE ABBREVIATION'S AND THE BLOCK'S. "3 vols." closing a
     * paragraph read "three volumes" would end the paragraph with no stop, so where
     * nothing but closing quotes or brackets follows, the stop is kept. Mid-block
     * the two cannot be told apart ("ed. Smith" against "esp. Then"), which is why
     * a caller hands the bare form for a word the book also prints without one.
     */
    const keepsStop = hit.find.endsWith('.') && !replace.endsWith('.')
      && /^["'’”)\]]*\s*$/u.test(text.slice(end));
    out += text.slice(from, hit.at) + replace + (keepsStop ? '.' : '');
    from = end;
    applied.set(hit.find, (applied.get(hit.find) ?? 0) + 1);
  }
  return { text: out + text.slice(from), applied };
}

/**
 * What the readings add to a block's cache key: '' when none applies to `text`,
 * so a block the glossary never touches keeps every key it had.
 */
export function fixedKeyField(text: string, readings: readonly FixedReading[]): string {
  const matcher = matcherFor(readings);
  if (matcher === null) return '';
  const byFind = new Map(readings.map((r) => [r.find, r.replace] as const));
  const used = [...new Set(occurrences(text, matcher).map((hit) => hit.find))].sort();
  if (used.length === 0) return '';
  return `fixed/v1:${used.map((find) => `${find}\u0001${byFind.get(find)!}`).join('\u0002')}`;
}

/** What the receipt says about the readings this run was handed. */
export interface FixedReadingsRecord {
  /** How many readings the run was handed. */
  given: number;
  /** find → how many times it was read across the blocks this run cleaned. */
  applied: Record<string, number>;
}

/**
 * Apply the readings to every stage-one text in `texts` (keyed however the
 * caller keys them), in place, and say what was read.
 */
export function applyFixedToAll(
  texts: Map<string, string>,
  readings: readonly FixedReading[],
): FixedReadingsRecord {
  const applied: Record<string, number> = {};
  if (readings.length > 0) {
    for (const [key, text] of texts) {
      const one = applyFixedReadings(text, readings);
      if (one.applied.size === 0) continue;
      texts.set(key, one.text);
      for (const [find, n] of one.applied) applied[find] = (applied[find] ?? 0) + n;
    }
  }
  return { given: readings.length, applied };
}
