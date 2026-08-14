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
  refuseSelfOverwrite(inputPath, outputPath, file);
  await rotateGenerated(dir, file);
  await fsp.mkdir(path.join(dir, 'generated'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    key,
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
): Promise<{ key: string; outputPath: string; bankPath: string }> {
  const { dir, key, stem } = await importDocument(inputPath, 'epub');
  const file = translationFileFor(stem, targetLanguage);
  const outputPath = path.join(dir, 'generated', file);
  refuseSelfOverwrite(inputPath, outputPath, file);
  await rotateGenerated(dir, file);
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
  return { key, outputPath, bankPath: path.join(dir, 'readings', `${key}.${tag}.bank.jsonl`) };
}

/**
 * A job whose output IS its input, refused by name before anything moves.
 *
 * Reachable in one gesture: open a project's own searchable PDF and ask for a
 * searchable PDF, or open its English translation and ask to translate it into
 * English. Both name a file inside a project, so the plan finds that project and
 * lands on the file that is open in front of the user — and the rotation that
 * runs next would move the engine's own input aside a moment before it tried to
 * read it, which arrives as a missing-file error from a subprocess about a path
 * nobody typed.
 *
 * Said out loud instead. The user asked for something that cannot mean what they
 * meant, and the sentence names the file and the way out.
 */
function refuseSelfOverwrite(inputPath: string, outputPath: string, file: string): void {
  if (path.resolve(inputPath).toLowerCase() !== path.resolve(outputPath).toLowerCase()) return;
  throw new Error(
    `That document IS this project's ${file}, so this run would have to read and replace the same `
    + 'file. Run it on the original instead, or ask for a different format or language.',
  );
}
