/**
 * clean/forms — the PRINTED FORMS of a book, each with sentences from across it
 * (2026-10-03). `foundry clean-forms`.
 *
 * The inventory half of a book glossary: every token a narrator does not read
 * as printed (the light gate's `isPrintedForm` — one definition, so the
 * inventory and the gate cannot disagree about what a printed form is), grouped
 * into the forms a book uses and handed out with up to SAMPLES sentences spread
 * evenly across the book. Whoever decides the readings (BookForge's narration
 * glossary) asks about a form ONCE with this evidence, and hands its answers
 * back to clean-text as `--fixed-readings` (src/clean/fixed-readings.ts).
 *
 * NOTHING HERE DECIDES A READING. It lists and counts.
 *
 * ── WHAT IS A FORM, AND WHAT IS LEFT TO THE SENTENCE PASS ───────────────────
 *
 * Measured on Hellworld and The Pursuit of Power, 2026-10-03:
 *
 *   - A ROMAN NUMERAL is listed WITH the word in front of it: "Wolf IV" (a
 *     planet, "Wolf Four") and "Henry IV" (a king, "Henry the Fourth") are
 *     different questions. Only a numeral spelled as a valid one counts.
 *   - A RUN OF CAPITALS ("SPD", "ESP") is a form — except inside a heading (a
 *     title or section-header block, or one set in capitals), whose case the
 *     narrator folds.
 *   - An ABBREVIATION is a form, keyed lower-case without a closing period, so
 *     "esp" and "esp." are one question; every printed spelling is listed. One
 *     that is ALSO an everyday word ("no", "art", "co", "rev") is a form only
 *     where it is printed as the abbreviation: with its period ("No. 12"), or as
 *     a title before a name ("Gen Patton"). Measured on Hellworld, 2026-10-03:
 *     210 of its 213 "no"s were the word, and the guide's review was a wall of them.
 *   - NUMBERS are not forms: every one is its own reading, and the number rules
 *     read them per sentence. Nor are brackets, line-break hyphens, a run of
 *     dots, two words glued by a period ("slowly.over"), or a lone initial.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import { stripBom } from '../bom.js';
import { readBookFile } from '../translate/bookrows.js';
import { cleanBlocks } from './blocks.js';
import { isPrintedForm } from './light-gate.js';
import { wholeTokenOffsets } from './fixed-readings.js';
import { CleanTextError } from './punctuate.js';
import { cleanSentences } from './sentences.js';
import { romanValue } from './tts-spoken-forms.js';

export const PRINTED_FORMS_FORMAT = 'printed-forms/v1';

/** Sentences handed out per form: enough to tell what a form IS, few enough to ask about cheaply. */
export const SAMPLES = 6;

export type FormKind = 'roman' | 'caps' | 'abbreviation';

export interface PrintedForm {
  /** The question's name: "Wolf IV", "SPD", "esp". */
  key: string;
  kind: FormKind;
  /** How many times the book prints it. */
  count: number;
  /**
   * The exact strings the book prints for it, each with its count — what a
   * reading replaces. A roman numeral's is its whole phrase ("Wolf IV").
   */
  printed: Record<string, number>;
  /** Up to SAMPLES sentences, spread evenly across the book, with every printed spelling among them. */
  samples: { parts: string; sentence: string }[];
  /**
   * EVERY OCCURRENCE, in the book's order — what a reading AT A SPOT names
   * (src/clean/fixed-readings.ts): the block's target key, which whole-token run
   * of `printed` in that block it is (`wholeTokenOffsets`, the one definition),
   * its sentence, and whether it ends that sentence — which is what decides
   * whether a period after it is the sentence's or the abbreviation's.
   */
  occurrences: FormOccurrence[];
}

export interface FormOccurrence {
  at: string;
  nth: number;
  printed: string;
  sentence: string;
  /** Where in `sentence` it starts — so a sentence printing it twice can say which. */
  inSentence: number;
  endsSentence: boolean;
}

export interface PrintedFormsFile {
  format: typeof PRINTED_FORMS_FORMAT;
  /** The book file read. */
  source: string;
  forms: PrintedForm[];
}

/**
 * ABBREVIATIONS THAT ARE ALSO EVERYDAY WORDS, lower-cased — the light gate's
 * period-less list (src/clean/light-gate.ts) where it meets the dictionary. The
 * gate rightly keeps every one from being rewritten; the INVENTORY lists one only
 * where the book prints the abbreviation (see `formOf`).
 */
const WORDS_TOO: ReadonlySet<string> = new Set([
  'no', 'nos', 'art', 'sec', 'rep', 'co', 'ed', 'col', 'rev', 'gen', 'mar', 'trans', 'ave',
  'fig', 'figs', 'al', 'hon', 'sept', 'ser', 'pl', 'sen', 'maj',
]);

/** Of those, the ones a book prints bare as a TITLE before a name ("Gen Patton", "Rev Smith"). */
const TITLES_TOO: ReadonlySet<string> = new Set(['rev', 'gen', 'col', 'sen', 'hon', 'maj']);

/** The token with its outer punctuation (quotes, brackets, commas…) set aside — light-gate.ts's `core`. */
function core(token: string): string {
  return token.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&.]+$/gu, '');
}

/**
 * A HEADING'S CAPITALS ARE NOT ACRONYMS. A block the book marks as a title or a
 * section header, or one set mostly in capitals, is a heading, and the narrator
 * folds a heading's case — so "CHAPTER ONE: Broken Men" lists no "CHAPTER" and no
 * "ONE" (measured 2026-10-03: asked about them, the model lowered three chapter
 * numbers and left a fourth). A numeral in one still is a form: "Part IV" needs
 * reading whatever its case.
 */
function heading(block: { target: { text: string; statedCategory: string | null } }): boolean {
  if (block.target.statedCategory !== null && /title|header/.test(block.target.statedCategory)) return true;
  const letters = block.target.text.replace(/[^\p{L}]/gu, '');
  return letters.length > 0 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length >= 0.7;
}

/** Words that are never a name before a numeral. */
const DETERMINERS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'his', 'her', 'its', 'our', 'their', 'my', 'your', 'every',
  'each', 'no', 'any', 'some', 'many', 'all', 'as', 'of', 'in', 'on', 'and', 'or',
]);

/** What a printed-form token is, as a question — or null when it is the sentence pass's. */
function formOf(tokens: readonly string[], i: number, heading: boolean): { kind: FormKind; key: string; printed: string } | null {
  const token = tokens[i]!;
  const bare = core(token).replace(/['’]s$/, '');
  if (/\d/.test(token) || /[[\]()&]/.test(token) || /-$/.test(token)) return null;
  if (/\.{2,}$/.test(bare) || /\p{L}{2}\.\p{L}{2}/u.test(bare)) return null;   // "blood..", "slowly.over"
  if (/^\p{L}\.$/u.test(bare)) return null;                                     // "J."
  if (/\p{Script=Han}|\p{Script=Cyrillic}|\p{Script=Greek}/u.test(bare)) return null;
  // A sentence's own period is not part of a numeral or an acronym ("on Wolf IV.").
  const unstopped = bare.replace(/\.$/, '');
  if (/^[IVXLCDM]+$/.test(unstopped) && romanValue(unstopped) !== null) {
    /*
     * A NUMERAL IS A NUMERAL WHERE A NUMERAL IS WHAT A BOOK PRINTS — after a
     * name or a label ("Wolf IV", "Pius XI", "PART II", "World War I"), and then
     * WITH that word, because "Wolf IV" is not "Henry IV". With none, only a run
     * of I, V and X ("II", "IX" numbering a list) is one; "the DC" (Deutsche
     * Christen) and "a CD" are capitals that happen to be legal numerals, and a
     * lone "I" is the pronoun. Measured 2026-10-03 on God's People, whose "DC"
     * was listed as the numeral 600 five times over ("the DC", "a DC", …).
     */
    const before = i > 0 ? core(tokens[i - 1]!).replace(/['’]s$/, '') : '';
    // A name's number is I, V and X — no ruler or pope reaches L — and "The DC",
    // "Washington DC", "An IV" are not a name and its number.
    const named = /^\p{Lu}[\p{L}'’-]+$/u.test(before) && romanValue(before.toUpperCase()) === null
      && /^[IVX]+$/.test(unstopped) && !DETERMINERS.has(before.toLowerCase());
    if (named) return { kind: 'roman', key: `${before} ${unstopped}`, printed: `${before} ${unstopped}` };
    if (/^[IVX]{2,}$/.test(unstopped)) return { kind: 'roman', key: unstopped, printed: unstopped };
  }
  if (/^\p{Lu}{2,}$/u.test(unstopped)) return heading ? null : { kind: 'caps', key: unstopped, printed: unstopped };
  // A lower-case run of numeral letters that is not a valid numeral is a word ("did", "civil").
  if (/^[ivxlcdm]+$/.test(unstopped) && romanValue(unstopped) === null) return null;
  if (!/^[\p{L}.]+$/u.test(bare)) return null;
  const key = unstopped.toLowerCase();
  if (WORDS_TOO.has(key) && !bare.endsWith('.')) {
    // Bare, it is the word — unless it is a title set before a name ("Gen Patton").
    const next = i + 1 < tokens.length ? core(tokens[i + 1]!) : '';
    const title = TITLES_TOO.has(key) && /^\p{Lu}/u.test(unstopped) && /^\p{Lu}\p{Ll}/u.test(next)
      && token === bare;
    if (!title) return null;
  }
  return { kind: 'abbreviation', key, printed: bare };
}

/** Up to n items spread evenly from first to last. */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, k) => items[Math.round((k * (items.length - 1)) / (n - 1))]!);
}

/**
 * THE SAMPLES: spread across the book, and every printed spelling among them. A
 * form that is two things in one book often differs by its spelling ("esp" the
 * sense, "esp." for especially), and a rare spelling a spread happens to miss is
 * the one whose meaning nobody would be asked about.
 */
function samplesOf(occurrences: readonly FormOccurrence[]): { parts: string; sentence: string }[] {
  const chosen = spread(occurrences, SAMPLES);
  for (const spelling of new Set(occurrences.map((o) => o.printed))) {
    if (chosen.some((o) => o.printed === spelling)) continue;
    chosen.push(...occurrences.filter((o) => o.printed === spelling).slice(0, 2));
  }
  chosen.sort((a, b) => occurrences.indexOf(a) - occurrences.indexOf(b));
  return chosen.map((o) => ({ parts: o.at, sentence: o.sentence }));
}

/** Every printed form of the book, most printed first within each kind. */
export function collectPrintedForms(bookText: string, where: string): PrintedForm[] {
  const book = readBookFile(bookText, where);
  const { blocks } = cleanBlocks(book, where);
  interface Gathering { kind: FormKind; key: string; printed: Map<string, number>; hits: FormOccurrence[] }
  const forms = new Map<string, Gathering>();
  for (const block of blocks) {
    const inHeading = heading(block);
    const text = block.target.text;
    /*
     * A CHAPTER'S CAPITALISED LEAD-IN IS TYPOGRAPHY, NOT ACRONYMS. Shift opens
     * its sections "DONALD KEPT THE thick folder" — the first words set in
     * capitals — and listed "THE", "KEPT" and "WAS" as forms. The block's opening
     * run of words with no lower-case letter is skipped for capitals; the
     * narrator reads them as the words they are.
     */
    let leadEnd = 0;
    for (const m of text.matchAll(/\S+/g)) {
      if (/\p{Ll}/u.test(m[0]) || !/\p{Lu}/u.test(m[0])) break;
      leadEnd = m.index! + m[0].length;
    }
    for (const span of cleanSentences(text)) {
      // The tokens WITH their offsets in the block, so an occurrence can be named.
      const found = [...span.text.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: span.start + m.index! }));
      const tokens = found.map((t) => t.text);
      for (let i = 0; i < tokens.length; i++) {
        if (!isPrintedForm(tokens, i)) continue;
        const form = formOf(tokens, i, inHeading);
        if (form === null) continue;
        // Which whole-token run of the printed spelling this is: the one inside
        // this token (or, for "Wolf IV", starting in the token before it).
        const from = form.printed.includes(' ') && i > 0 ? found[i - 1]!.at : found[i]!.at;
        const to = found[i]!.at + found[i]!.text.length;
        const offsets = wholeTokenOffsets(text, form.printed);
        const nth = offsets.findIndex((o) => o >= from && o < to);
        if (nth < 0) continue;
        if (form.kind === 'caps' && offsets[nth]! < leadEnd) continue;
        const id = `${form.kind}\u0000${form.key}`;
        let gathering = forms.get(id);
        if (gathering === undefined) {
          gathering = { kind: form.kind, key: form.key, printed: new Map(), hits: [] };
          forms.set(id, gathering);
        }
        gathering.printed.set(form.printed, (gathering.printed.get(form.printed) ?? 0) + 1);
        gathering.hits.push({
          at: block.target.key, nth, printed: form.printed, sentence: span.text,
          inSentence: offsets[nth]! - span.start, endsSentence: i === tokens.length - 1,
        });
      }
    }
  }
  const order: FormKind[] = ['roman', 'caps', 'abbreviation'];
  return [...forms.values()]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.hits.length - a.hits.length
      || a.key.localeCompare(b.key))
    .map((g) => ({
      key: g.key,
      kind: g.kind,
      count: g.hits.length,
      printed: Object.fromEntries([...g.printed].sort((a, b) => b[1] - a[1])),
      samples: samplesOf(g.hits),
      occurrences: g.hits,
    }));
}

/** `foundry clean-forms --book <book.jsonl> --out <forms.json>`. */
export function runCleanForms(opts: { bookPath: string; outPath: string; log: (message: string) => void }): PrintedFormsFile {
  const where = path.resolve(opts.bookPath);
  let text: string;
  try {
    text = stripBom(fs.readFileSync(where, 'utf8'));
  } catch (err) {
    throw new CleanTextError(`--book ${where} cannot be read (${(err as Error).message}).`);
  }
  const forms = collectPrintedForms(text, where);
  const file: PrintedFormsFile = { format: PRINTED_FORMS_FORMAT, source: where, forms };
  const out = path.resolve(opts.outPath);
  ensureDir(path.dirname(out));
  const partial = `${out}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  fs.renameSync(partial, out);
  const byKind = new Map<FormKind, number>();
  for (const form of forms) byKind.set(form.kind, (byKind.get(form.kind) ?? 0) + 1);
  opts.log(
    `clean-forms: ${forms.length} printed form(s) — ${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'} `
    + `— written to ${out}`,
  );
  return file;
}
