/**
 * workspace-records — what the text passes share: seed records, the declared language, the newest records and the reading's generation, and archiving an original.
 */
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { parseBookFile } from '../shared/book';
import { archiveFileOf } from './projects';
import { languageTagFor, readingInEffect, translationRecordsOf } from '../shared/ledger';
import type { ProjectLedger, ProjectManifest, RewriteMode } from '../shared/types';

/**
 * THE SEED, AS AN ABSOLUTE PATH — or null, WITH THE REASON SAID OUT LOUD.
 *
 * ── F8, which cost a full book's model time in silence ─────────────────────
 *
 * The copy at the spawn is guarded by `existsSync` on both ends, so a seed the
 * ledger names and the disk no longer holds was a silent no-op: the run started
 * empty and paid full price, which is verbatim the defect the seed was added to
 * end. Nothing said anything, because "no seed" and "a seed that has gone" were
 * the same absent field.
 *
 * They are not the same fact and this is where they stop looking alike. A ledger
 * that names no sibling answers null quietly — the ordinary first pass. A ledger
 * that NAMES one whose file is gone (a Start over, a deleted step, a library that
 * moved) is logged by name and then answers null, so the row still runs and the
 * terminal says what it is about to pay for.
 */
export function seedRecordsPath(dir: string, relative: string | null, what: string): string | null {
  if (relative === null) return null;
  const absolute = path.join(dir, ...relative.split('/'));
  if (existsSync(absolute)) return absolute;
  console.warn(
    `[workspace] this ${what} named ${absolute} as its seed and that file is not there, so it `
    + 'starts with no answers and pays the model for every block. A Start over, a deleted step '
    + 'or a moved library removes a seed the ledger still remembers.',
  );
  return null;
}

/**
 * WHAT LANGUAGE A BOOK FILE SAYS IT IS IN, or the empty string for one that says
 * nothing.
 *
 * READ BACK OFF THE FILE THAT WAS JUST WRITTEN rather than threaded out of
 * `materializeBook`, because that function's answer is a PATH — it is the seam
 * between the replay and the engine, and every other caller wants a file to hand
 * over rather than a fact about the book inside it. Widening it so this one caller
 * can skip a read would put a book's header in the return type of the thing that
 * writes books for compilers.
 *
 * THROUGH `parseBookFile` AND NOT PAST IT. Taking the first line and reaching for
 * a key would be this module holding a second opinion about what a book file is,
 * and the day the header moved it would be the opinion that was wrong. A parse
 * that refuses answers the empty string: this is asked in order to compose a
 * refusal sentence, and a book that cannot be read is a book that has not said.
 */
export async function declaredLanguageOf(bookPath: string): Promise<string> {
  try {
    const text = await fsp.readFile(bookPath, 'utf8');
    return parseBookFile(text).header.language.trim();
  } catch (err) {
    console.error(`[workspace] ${bookPath} could not be asked its language: ${(err as Error).message}`);
    return '';
  }
}

/**
 * TWO LANGUAGES, ONE ANSWER — folded the way every filename in this app folds a
 * language, so `EN` and `en` are the same language here as they are there.
 *
 * `languageTagFor` is the single spelling of that reduction (shared/ledger.ts) and
 * the case fold is what stops a capital letter turning "the same language" into a
 * chain nobody asked for. The Translate dialog folds the identical pair the
 * identical way before it lets the button be pressed, so the window and main
 * cannot come to different answers about what a person just did.
 */
export function sameTag(one: string, other: string): boolean {
  return languageTagFor(one).toLowerCase() === languageTagFor(other).toLowerCase();
}

/**
 * The newest records file in this project holding this language, other than the
 * one this run is about to write — or null when there is none.
 *
 * THE NEWEST BY THE ARRAY'S ORDER, which is the ledger's own chronology
 * (`parseLedger` refuses a file whose rows run backwards) — so "the last one
 * matching" and "the most recently made" are one sentence, with no comparator and
 * no dependence on anything sorting.
 *
 * WHEREVER IT HANGS, which is the point: the translation a branch wants to start
 * from is usually its SIBLING — both made from the same reading, one from the row
 * itself and one from a save under it — and no walk from the position can reach a
 * sibling. See `planTranslation`'s seed note for why that is safe: a records row
 * is keyed by a block's own text and remembered by that block's own position, so
 * any translation of this book into this language holds true answers about the
 * same paragraphs.
 *
 * A STEP THAT PREDATES RECORDS IS NOT ONE, and answers null through
 * `translationRecordsOf`: its answers are a bank keyed by the masked XHTML of a
 * book, which the masking move re-keyed wholesale, so copying it would be copying
 * a file every question in this run is going to miss.
 */
export function newestRecordsInto(
  ledger: ProjectLedger,
  language: string,
  writing: string,
  /**
   * THE REWRITE THIS RUN IS, and a candidate has to be the same one — absent
   * meaning an ordinary translation, which likewise only ever seeds from another
   * ordinary translation.
   *
   * ── Why a cross-mode seed is not merely wasteful ────────────────────────────
   *
   * A record's key hashes the MASKED SOURCE QUESTION — the paragraph as it stands
   * in the book being read — and not the prompt that was asked about it. So a
   * German book simplified into plain terms and the same German book simplified
   * into easy language produce records with THE SAME KEYS AND DIFFERENT ANSWERS,
   * and seeding one from the other would hand every block of a learner edition an
   * answer written for a specialist and never ask the model about it. The run
   * would finish in seconds and be the wrong book.
   *
   * The equality is exact rather than folded, unlike the language beside it: a
   * mode is one of three values this app writes and `readParams` refuses anything
   * else, where a language tag is somebody's typing.
   */
  rewrite?: RewriteMode,
): string | null {
  let found: string | null = null;
  const wanted = rewrite === undefined ? 'translate' : 'simplify';
  for (const step of ledger.steps) {
    /*
     * THE ACTION IS TESTED FIRST, and it is not redundant with the mode test below
     * it. `PARAMS_OF` keeps `rewrite` off a translation and every simplify carries
     * one, so today the two tests agree — but a row that predates the heal, or a
     * `clean` step that carries no params at all, would reach the language test and
     * be judged on a field it does not have. Asking what the row IS is the honest
     * question, and it is the one the split made available.
     */
    if (step.action !== wanted) continue;
    const said = step.params?.language ?? '';
    if (said.length === 0 || !sameTag(said, language)) continue;
    if (step.params?.rewrite !== rewrite) continue;
    const records = translationRecordsOf(step);
    if (records === null || records === writing) continue;
    found = records;
  }
  return found;
}

/**
 * The generation the position's reading recorded, or null for one that recorded
 * none.
 *
 * THE STEP FIRST AND THE PROJECT RECORD SECOND, which is `generationInEffect`'s own
 * order and for its reason: a project can hold two readings and only the steps can
 * say which of them a position is about, while `manifest.reading` is one record per
 * project and is the only answer a project with no read step has.
 *
 * IT NEVER MINTS. Minting is what a landing does, on evidence that a bank is a
 * different bank; a plan that minted one would stamp a fresh id into records that
 * are about the reading somebody actually read.
 */
export function readingGenerationOf(ledger: ProjectLedger, manifest: ProjectManifest): string | null {
  const recorded = readingInEffect(ledger)?.params?.generation ?? manifest.reading?.generation;
  return recorded !== undefined && recorded.length > 0 ? recorded : null;
}

/**
 * The immutable original this project was made from, or null for a legacy one.
 *
 * `archive/` is written exactly once, by `importDocument`, and by nothing else
 * ever. That makes it the source of record: the bytes the user handed over,
 * unedited, however many conversions have since been run over them.
 *
 * NULL IS A REAL ANSWER, not an error. A project adopted from the old flat
 * workspace has outputs and no archive — nobody kept the scan, because the old
 * layout had nowhere to keep it — and the honest fallback for those is the
 * document the caller was pointing at. It is what that project has.
 *
 * ── Why there is no refusal anywhere near here ──────────────────────────────
 *
 * `refuseSelfOverwrite` used to live in this file and it is gone. It compared
 * the input path with the output path and threw when they matched, which could
 * happen because the user was allowed to point the engine at a file this app
 * had filed in `generated/`. That is a guard against a state the architecture
 * should never be able to reach, and a guard like that documents the
 * architecture failing rather than protecting anybody: the person who met it had
 * asked for something perfectly reasonable and was told to go and choose a
 * different file because of where their conversions were being kept.
 *
 * Two invariants replace it, and both are properties of how paths are BUILT:
 *
 *   THE ARCHIVE IS NEVER A WRITE TARGET. Every output path in this app is
 *   composed by `planExport` or `planTranslation`, and both compose into
 *   `generated/`. Nothing anywhere composes one into `archive/`.
 *
 *   THE USER IS ALWAYS IN A WORKING COPY. What they point at is a copy the app
 *   made and may replace, so applying a change to it is always allowed. There is
 *   no case left where this app knows better than the person who asked.
 *
 * The ENGINE keeps its own `--out == --pdf` refusal (src/vlm/convert.ts), and
 * that one is not this one: it belongs to a command-line program anyone may hand
 * two arbitrary paths, and it protects a run from destroying the input it is
 * reading halfway through. This app simply never hands it such a pair.
 */
export async function archiveOriginal(dir: string): Promise<string | null> {
  const archive = await archiveFileOf(dir);
  return archive === null ? null : path.join(dir, 'archive', archive);
}
