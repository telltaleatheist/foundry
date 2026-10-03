/**
 * clean/fixed-readings — readings a cleanup is HANDED, applied before anything
 * is judged or asked, and never asked about again (2026-10-03).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The sentence pass sees one sentence and has to guess what a printed form IS.
 * *Deathstalker: Hellworld* prints "esp" twenty-six times for a psychic sense;
 * shown "touched the sphere with her esp." alone, the model read it "especial",
 * and the same book came out saying "ESP" in one place and "especial" in two.
 * The evidence was in the book, just not in the sentence.
 *
 * So the caller (BookForge's narration glossary) decides each printed form from
 * sentences across the whole book — and, where one form means two things in one
 * book ("esp" the psychic sense, "esp." short for especially), each OCCURRENCE —
 * and hands the answers here. This module knows nothing about how they were
 * decided or what a pronunciation is: it is a list of exact strings and what to
 * print in their place.
 *
 * ── TWO KINDS OF READING ─────────────────────────────────────────────────────
 *
 *   BOOK-WIDE   {find, replace}: read wherever the find stands as a whole token
 *               run. Longer finds win where two overlap ("Wolf IV" before "IV").
 *               A find ending in a period consumes it, except where it also ends
 *               the block.
 *   AT A SPOT   {find, replace, at, nth}: read at ONE occurrence — the `nth`
 *               (0-based) whole-token run of `find` in the block whose target key
 *               is `at`. `replace` is printed verbatim: the caller, who knows
 *               which meaning this spot has, says whether a period stays.
 *
 * A whole token run is one with no letter or digit touching it on either side.
 * Case-sensitive, exact. Spots are read first, against the block's own text;
 * book-wide readings then read what is left.
 *
 * Applied to every block's stage-one text (after punctuation, before the number
 * rules and the model), in BOTH the cleanup and its triage, so the two see the
 * same words: a triage has no reason to flag a form that is already read, and the
 * model is shown "Wolf Four" and has no "IV" left to re-read.
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
  /** A spot: the target key of the one block it applies to. Absent: book-wide. */
  at?: string;
  /** A spot: which whole-token run of `find` in that block, from 0. */
  nth?: number;
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
      + '({"format": "fixed-readings/v1", "readings": [{"find", "replace", "at"?, "nth"?}, ...]}).',
    );
  }
  return validateFixedReadings(doc.readings, where);
}

/** The list, checked entry by entry. Exported for the tests and for in-memory callers. */
export function validateFixedReadings(list: readonly unknown[], where = 'fixed readings'): FixedReading[] {
  const out: FixedReading[] = [];
  const bookWide = new Map<string, string>();
  const spots = new Set<string>();
  list.forEach((raw, i) => {
    const one = raw as { find?: unknown; replace?: unknown; at?: unknown; nth?: unknown };
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
    const hasAt = one.at !== undefined;
    const hasNth = one.nth !== undefined;
    if (hasAt !== hasNth) {
      throw new CleanTextError(`${where}: reading ${i} ("${find}") names ${hasAt ? '"at" without "nth"' : '"nth" without "at"'}; a spot needs both.`);
    }
    if (hasAt) {
      if (typeof one.at !== 'string' || one.at.length === 0 || !Number.isInteger(one.nth) || (one.nth as number) < 0) {
        throw new CleanTextError(`${where}: reading ${i} ("${find}") needs a block key "at" and a whole number "nth".`);
      }
      const spot = `${one.at}\u0000${find}\u0000${one.nth as number}`;
      if (spots.has(spot)) {
        throw new CleanTextError(`${where}: "${find}" is read twice at ${one.at} #${one.nth as number}. One spot, one reading.`);
      }
      spots.add(spot);
      if (find !== replace) out.push({ find, replace, at: one.at, nth: one.nth as number });
      return;
    }
    const earlier = bookWide.get(find);
    if (earlier !== undefined && earlier !== replace) {
      throw new CleanTextError(
        `${where}: "${find}" is given two book-wide readings, "${earlier}" and "${replace}". A form read `
        + 'two ways is read at its spots ("at" and "nth"), never twice book-wide.',
      );
    }
    if (earlier === undefined && find !== replace) out.push({ find, replace });
    bookWide.set(find, replace);
  });
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `find` stand at `at` as a whole token run — nothing word-like touching either side? */
function standsAt(text: string, at: number, find: string): boolean {
  if (!text.startsWith(find, at)) return false;
  const end = at + find.length;
  return !(at > 0 && WORD.test(text[at - 1]!)) && !(end < text.length && WORD.test(text[end]!));
}

/**
 * Where `find` stands as a whole token run in `text`, in order. The one
 * definition of "the nth occurrence": `clean-forms` numbers a spot with it, and a
 * spot is found with it here.
 */
export function wholeTokenOffsets(text: string, find: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) {
    if (standsAt(text, at, find)) out.push(at);
  }
  return out;
}

/** The finds, longest first, and one pattern that finds where any of them may start. */
interface Matcher { finds: string[]; pattern: RegExp }

function matcherFor(readings: readonly FixedReading[]): Matcher | null {
  if (readings.length === 0) return null;
  const finds = [...readings].map((r) => r.find).sort((a, b) => b.length - a.length);
  return { finds, pattern: new RegExp(finds.map(escape).join('|'), 'gu') };
}

/**
 * Every occurrence of a book-wide reading in `text`, in order and
 * non-overlapping. Where finds start at the same place the LONGEST that stands
 * there wins — and a shorter one still gets its turn when the longer does not
 * stand ("Dr.Smith": "Dr." is glued to a word, "Dr" is not).
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

/** The readings that belong to the block with target key `at`: its spots, and every book-wide one. */
function forBlock(readings: readonly FixedReading[], at: string | undefined): { spots: FixedReading[]; bookWide: FixedReading[] } {
  const spots: FixedReading[] = [];
  const bookWide: FixedReading[] = [];
  for (const reading of readings) {
    if (reading.at === undefined) bookWide.push(reading);
    // A table's key covers its cells (`<row>#c<n>`), whose text the grid is spliced from.
    else if (at !== undefined && (reading.at === at || reading.at.startsWith(`${at}#c`))) spots.push(reading);
  }
  return { spots, bookWide };
}

export interface FixedApplication {
  text: string;
  /** find → how many times it was read in this text. */
  applied: Map<string, number>;
  /** Spots whose occurrence was not in this text — the block changed since they were decided. */
  missed: FixedReading[];
}

/** Apply the readings that belong to the block keyed `at` to its text. */
export function applyFixedReadings(text: string, readings: readonly FixedReading[], at?: string): FixedApplication {
  const applied = new Map<string, number>();
  const missed: FixedReading[] = [];
  const { spots, bookWide } = forBlock(readings, at);

  // ── The spots, against the block's own text, back to front ────────────────
  const edits: { at: number; length: number; replace: string; find: string }[] = [];
  for (const spot of spots) {
    if (spot.at !== at) continue; // a cell's spot belongs to that cell's own text
    const offset = wholeTokenOffsets(text, spot.find)[spot.nth!];
    if (offset === undefined) { missed.push(spot); continue; }
    edits.push({ at: offset, length: spot.find.length, replace: spot.replace, find: spot.find });
  }
  edits.sort((a, b) => b.at - a.at);
  let out = text;
  let floor = Infinity;
  for (const edit of edits) {
    if (edit.at + edit.length > floor) { missed.push(spots.find((s) => s.find === edit.find)!); continue; }
    out = out.slice(0, edit.at) + edit.replace + out.slice(edit.at + edit.length);
    floor = edit.at;
    applied.set(edit.find, (applied.get(edit.find) ?? 0) + 1);
  }

  // ── Then the book-wide readings, over what is left ────────────────────────
  const matcher = matcherFor(bookWide);
  if (matcher === null) return { text: out, applied, missed };
  const byFind = new Map(bookWide.map((r) => [r.find, r.replace] as const));
  let result = '';
  let from = 0;
  for (const hit of occurrences(out, matcher)) {
    const replace = byFind.get(hit.find)!;
    const end = hit.at + hit.find.length;
    /*
     * A PERIOD THAT IS BOTH THE ABBREVIATION'S AND THE BLOCK'S. "3 vols." closing a
     * paragraph read "three volumes" would end the paragraph with no stop, so where
     * nothing but closing quotes or brackets follows, the stop is kept. Mid-block
     * the two cannot be told apart ("ed. Smith" against "esp. Then") — which is
     * what a spot is for: its caller knows which this one is.
     */
    const keepsStop = hit.find.endsWith('.') && !replace.endsWith('.')
      && /^["'’”)\]]*\s*$/u.test(out.slice(end));
    result += out.slice(from, hit.at) + replace + (keepsStop ? '.' : '');
    from = end;
    applied.set(hit.find, (applied.get(hit.find) ?? 0) + 1);
  }
  return { text: result + out.slice(from), applied, missed };
}

/**
 * What the readings add to a block's cache key: '' when none applies to `text`,
 * so a block the glossary never touches keeps every key it had. `at` is the
 * block's target key (a table's row key covers its cells' spots).
 */
export function fixedKeyField(text: string, readings: readonly FixedReading[], at?: string): string {
  const { spots, bookWide } = forBlock(readings, at);
  const used: string[] = spots.map((s) => `${s.at}\u0003${s.nth}\u0003${s.find}\u0001${s.replace}`);
  const matcher = matcherFor(bookWide);
  if (matcher !== null) {
    const byFind = new Map(bookWide.map((r) => [r.find, r.replace] as const));
    for (const find of new Set(occurrences(text, matcher).map((hit) => hit.find))) {
      used.push(`${find}\u0001${byFind.get(find)!}`);
    }
  }
  if (used.length === 0) return '';
  return `fixed/v1:${used.sort().join('\u0002')}`;
}

/** What the receipt says about the readings this run was handed. */
export interface FixedReadingsRecord {
  /** How many readings the run was handed. */
  given: number;
  /** find → how many times it was read across the blocks this run cleaned. */
  applied: Record<string, number>;
  /** Spots whose occurrence was not where they said — their block changed since. Left as printed. */
  missed: { at: string; find: string; nth: number }[];
}

/**
 * Apply the readings to every stage-one text in `texts` (keyed by target key),
 * in place, and say what was read.
 */
export function applyFixedToAll(
  texts: Map<string, string>,
  readings: readonly FixedReading[],
): FixedReadingsRecord {
  const applied: Record<string, number> = {};
  const missed: FixedReadingsRecord['missed'] = [];
  if (readings.length > 0) {
    for (const [key, text] of texts) {
      const one = applyFixedReadings(text, readings, key);
      for (const spot of one.missed) missed.push({ at: spot.at!, find: spot.find, nth: spot.nth! });
      if (one.applied.size === 0) continue;
      texts.set(key, one.text);
      for (const [find, n] of one.applied) applied[find] = (applied[find] ?? 0) + n;
    }
  }
  return { given: readings.length, applied, missed };
}
