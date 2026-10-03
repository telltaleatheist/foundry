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
 *   - A RUN OF CAPITALS ("SPD", "ESP") is a form — except inside a block set
 *     in capitals, which is a heading and folds its case at narration.
 *   - An ABBREVIATION is a form, keyed lower-case without a closing period, so
 *     "esp" and "esp." are one question; every printed spelling is listed.
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
  /** Up to SAMPLES sentences, spread evenly across the book. */
  samples: { parts: string; sentence: string }[];
}

export interface PrintedFormsFile {
  format: typeof PRINTED_FORMS_FORMAT;
  /** The book file read. */
  source: string;
  forms: PrintedForm[];
}

/** The token with its outer punctuation (quotes, brackets, commas…) set aside — light-gate.ts's `core`. */
function core(token: string): string {
  return token.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&.]+$/gu, '');
}

/** A block set in capitals is a heading; the narrator folds its case, so its words are not acronyms. */
function shouted(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length > 0 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length >= 0.7;
}

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
    // WITH the word in front: "Wolf IV" is not "Henry IV".
    const before = i > 0 ? core(tokens[i - 1]!).replace(/['’]s$/, '') : '';
    const phrase = before.length > 0 && /^\p{L}+$/u.test(before) ? `${before} ${unstopped}` : unstopped;
    return { kind: 'roman', key: phrase, printed: phrase };
  }
  if (/^\p{Lu}{2,}$/u.test(unstopped)) return heading ? null : { kind: 'caps', key: unstopped, printed: unstopped };
  // A lower-case run of numeral letters that is not a valid numeral is a word ("did", "civil").
  if (/^[ivxlcdm]+$/.test(unstopped) && romanValue(unstopped) === null) return null;
  if (!/^[\p{L}.]+$/u.test(bare)) return null;
  return { kind: 'abbreviation', key: unstopped.toLowerCase(), printed: bare };
}

/** Up to n items spread evenly from first to last. */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, k) => items[Math.round((k * (items.length - 1)) / (n - 1))]!);
}

/** Every printed form of the book, most printed first within each kind. */
export function collectPrintedForms(bookText: string, where: string): PrintedForm[] {
  const book = readBookFile(bookText, where);
  const { blocks } = cleanBlocks(book, where);
  interface Gathering { kind: FormKind; key: string; printed: Map<string, number>; hits: { parts: string; sentence: string }[] }
  const forms = new Map<string, Gathering>();
  for (const block of blocks) {
    const heading = shouted(block.target.text);
    for (const span of cleanSentences(block.target.text)) {
      const tokens = span.text.split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        if (!isPrintedForm(tokens, i)) continue;
        const form = formOf(tokens, i, heading);
        if (form === null) continue;
        const id = `${form.kind}\u0000${form.key}`;
        let gathering = forms.get(id);
        if (gathering === undefined) {
          gathering = { kind: form.kind, key: form.key, printed: new Map(), hits: [] };
          forms.set(id, gathering);
        }
        gathering.printed.set(form.printed, (gathering.printed.get(form.printed) ?? 0) + 1);
        gathering.hits.push({ parts: block.parts, sentence: span.text });
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
      samples: spread(g.hits, SAMPLES),
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
