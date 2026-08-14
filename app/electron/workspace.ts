/**
 * workspace — which file inside which project a job is about to write.
 *
 * The OCR dialog used to ask for an output path. It no longer does, and this is
 * the module that made that possible: every conversion writes into the PROJECT
 * for the document it was run on, opens in a tab the moment it finishes, and is
 * copied out of there only when the user presses Save As. Nothing is ever
 * written beside the source PDF, so a folder of scans stays a folder of scans.
 *
 * This file used to own the naming too — a flat `<libraryDir>/workspace/` and a
 * key derived from the source's content. The key is unchanged and the reasons
 * for it are unchanged; both moved to electron/projects.ts, which is now the one
 * module that decides where anything lives. What is left here is the two
 * questions a JOB asks, and the answers are three paths inside one folder.
 *
 * ── Into `generated/`, always ────────────────────────────────────────────────
 *
 * What the engine writes is an ORIGIN, not a working copy: it is the record of
 * what the model actually read, every curation decision downstream is measured
 * against it, and "start over" means unpacking a fresh working tree from it. So
 * a conversion writes into `generated/` and nothing ever writes there again —
 * a second run of the same book rotates the first aside rather than replacing
 * it (electron/projects.ts, `rotateGenerated`).
 *
 * The FILE is named for the book and not for its role:
 * `Working Towards The Fuhrer. Kershaw, Ian. (1993).epub`, beside the `.pdf` of
 * the same name. The slug is for the project's directory and nothing else.
 *
 * ── The readings bank ────────────────────────────────────────────────────────
 *
 * `--readings` is passed on EVERY job, always, at
 * `<project>/readings/<key>.jsonl`. Not a checkbox: there is no version of "read
 * three hundred pages again because the window closed" that anyone wants. The
 * engine decides for itself whether a bank beside a completion marker is a
 * resume or a re-read (README §Reading the pages somewhere else, and only once)
 * — it archives and re-reads a completed one. This app does not second-guess
 * that and has no flag that could.
 *
 * The bank living IN the project also fixes something the flat layout got wrong
 * by accident: the engine writes its completion marker as `completed.json`
 * beside the bank, so a directory holding every book's bank held exactly one
 * marker, belonging to whichever run happened to finish last. One bank per
 * directory means a marker that names the book it is about.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  archiveFileOf,
  generatedFileFor,
  importDocument,
  rotateGenerated,
  translationFileFor,
} from './projects';
import type { ConversionKind, WorkspacePlan } from '../shared/types';

/**
 * Where this PDF's conversion goes, and where its answers are banked.
 *
 * The directories are created HERE rather than by the engine, because the engine
 * is handed two paths and a path whose parent does not exist is a run that dies
 * after the last page.
 *
 * The PREVIOUS origin of the same kind is rotated aside first, not overwritten
 * — see `rotateGenerated`. That happens at plan time because the engine writes
 * to `outputPath` itself and there is no moment between the two this app is
 * awake for; the dialog calls this immediately before it enqueues, so "planned"
 * and "about to run" are the same instant in practice.
 */
export async function planConversion(
  inputPath: string,
  /**
   * What the output will hold, which is what its extension says.
   *
   * The engine refuses an `--out` whose extension contradicts its `--format`
   * (src/vlm/text-out.ts), and it is right to: a `.epub` full of plain text
   * opens wrong everywhere. So the kind reaches the NAME rather than only the
   * command line, and the app cannot construct that contradiction.
   */
  kind: ConversionKind = 'epub',
): Promise<WorkspacePlan> {
  const { dir, key, stem } = await importDocument(inputPath, 'pdf');
  const file = generatedFileFor(stem, kind);
  const outputPath = path.join(dir, 'generated', file);
  /*
   * THE SOURCE IS THE APP'S TO CHOOSE, and that is the whole correction here.
   *
   * `inputPath` is whatever document the user was looking at when they asked.
   * It is not necessarily the thing with the pages in it: after a real-text
   * conversion the PDF this app shows them is type on blank paper, and reading
   * THAT would be converting a reprint of a reading. So the pixels are fetched
   * from where they are kept — `archive/`, which is written once at import and
   * never again — and the user is never asked which copy is which.
   *
   * There used to be a `refuseSelfOverwrite` on the next line, and its removal
   * is the point rather than a side effect. It fired when somebody asked to
   * convert the reprint, and it told them to go and pick a different file: a
   * refusal caused entirely by where this app had filed something, handed to
   * the person who is not supposed to know that the filing exists. The state it
   * guarded against is now unreachable — the input is always under `archive/`
   * and no output path is ever composed there — so there is nothing to guard.
   */
  const sourcePath = await archiveOriginal(dir) ?? inputPath;
  await rotateGenerated(dir, file);
  await fsp.mkdir(path.join(dir, 'generated'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    key,
    sourcePath,
    outputPath,
    /*
     * The bank is keyed by the BOOK, not by the format.
     *
     * Both outputs are assembled from the same per-page answers, so converting a
     * book to text after converting it to EPUB must not read three hundred pages
     * again — and a readings path with the format in it would guarantee that it
     * did. What the engine then does with a bank a finished run left behind is
     * the engine's rule, and this app does not second-guess it.
     */
    readingsPath: path.join(dir, 'readings', `${key}.jsonl`),
  };
}

/**
 * Where this book's TRANSLATION goes.
 *
 * IN THE SAME PROJECT AS THE BOOK IT CAME FROM, which is the whole reason this
 * function stopped keying on the input's own content. The German original and
 * its English and French editions are three files in one folder, named after the
 * one book — `Buch.epub`, `Buch (en).epub`, `Buch (fr).epub` — rather than three
 * unrelated directories that nothing on disk connects. Asking for the same
 * translation twice still lands on the same file, which is the behaviour every
 * other job in this app has, and the old one is rotated aside rather than
 * clobbered.
 *
 * It still ends in `.epub`, and that is load-bearing: main's `openDocument`
 * admits a finished file by its extension, so an output named anything else
 * could never be opened, read or shown in a tab.
 *
 * No readings bank. A translation banks nothing — the engine holds every block
 * in memory and writes one file at the end — so `WorkspacePlan.readingsPath`
 * would be a path to a file that never exists.
 */
export async function planTranslation(
  inputPath: string,
  targetLanguage: string,
): Promise<{ key: string; sourcePath: string; outputPath: string; bankPath: string }> {
  const { dir, key, stem } = await importDocument(inputPath, 'epub');
  const file = translationFileFor(stem, targetLanguage);
  const outputPath = path.join(dir, 'generated', file);
  /*
   * A RE-TRANSLATION READS THE COPY IT IS ABOUT TO REPLACE.
   *
   * Translating the English edition into English again names one path twice:
   * the output is composed from the PROJECT's stem and the language, so asking
   * for a language a document already is lands on that document. This used to be
   * refused, and the refusal is gone for the reason the conversion's was — the
   * user asked for something perfectly sensible ("do that again") and got a
   * sentence about the app's own filing.
   *
   * The rotation is what makes it work rather than a special case. `generated/`
   * is never overwritten, so the previous edition is moved aside before the run
   * regardless; when the run's own input is that edition, the copy just rotated
   * aside IS the source of record and the engine reads it there. Read from what
   * was, write to what will be — the same shape as every other job here.
   */
  const movedAside = await rotateGenerated(dir, file);
  const sourcePath = movedAside !== null && samePath(inputPath, outputPath)
    ? movedAside
    : inputPath;
  await fsp.mkdir(path.join(dir, 'generated'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  /*
   * THE TRANSLATION BANK, beside the readings bank and for the same reason:
   * both are hours of GPU held as answers, and both belong to this book.
   *
   * PER LANGUAGE, because the language is part of what was asked — a German
   * book's English and French editions are two sets of answers and one file
   * holding both would be a file whose keys never collide but whose size is
   * twice what anybody needs. The engine keys every entry by the whole question
   * anyway (model, languages, instructions, the block's text), so this split is
   * for the person who opens the folder, not for correctness.
   *
   * Passed on EVERY translation, never a checkbox. There is no version of "spend
   * four more hours re-translating the four hundred blocks that already
   * succeeded" that anybody wants, and the run that made this necessary is on
   * record: 152 blocks, killed, nothing kept.
   */
  const tag = targetLanguage.trim().replace(/[^A-Za-z0-9-]+/g, '') || 'translated';
  return {
    key,
    sourcePath,
    outputPath,
    bankPath: path.join(dir, 'readings', `${key}.${tag}.bank.jsonl`),
  };
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
 *   composed by `planConversion` or `planTranslation`, and both compose into
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
async function archiveOriginal(dir: string): Promise<string | null> {
  const archive = await archiveFileOf(dir);
  return archive === null ? null : path.join(dir, 'archive', archive);
}

/** One spelling for a path, so Windows' three become one. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
