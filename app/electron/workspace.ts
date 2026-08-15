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
 * `--readings` is passed on EVERY job, always. Not a checkbox: there is no
 * version of "read three hundred pages again because the window closed" that
 * anyone wants.
 *
 * WHICH BANK IS A QUESTION NOW, and it used to be a fact. It was
 * `<project>/readings/<key>.jsonl` composed from the key at both plans, on the
 * belief that a project has one bank — and a re-read asking for a different page
 * range branches by design, so a project can hold two readings and both of them
 * named that one file. Neither plan composes it any more: `planConversion` asks
 * the step at the position which bank its row is about, and `planReading` decides
 * whether this reading replaces one that exists or gets a bank of its own. Both
 * answers come from electron/projects.ts, which is the module that decides where
 * anything lives.
 *
 * WHAT CHANGED IS WHICH JOB IT IS THE PRODUCT OF. There are two plans below
 * because there are two jobs: `planReading` names the bank an OCR run FILLS, and
 * `planConversion` names the file a rendering writes out of a bank that already
 * exists. They were one function while reading and writing were one act, and
 * that is precisely what made the output format a question somebody had to
 * answer before a single page had been read.
 *
 * A rendering passes `--reuse-readings` with it (electron/job-queue.ts), which
 * is the flag that keeps it free. Without it the engine treats a completed bank
 * beside its marker as a book to read AGAIN — its own rule, and the right one
 * for a command line, but the wrong answer to somebody pressing a button
 * labelled with a file format.
 *
 * The bank living IN the project also fixes something the flat layout got wrong
 * by accident. The engine's completion marker is named FOR ITS BANK —
 * `<key>.completed.json`, beside `<key>.jsonl` — and it did not always used to
 * be: it was once a bare `completed.json` in the bank's directory, so a folder
 * holding every book's bank held exactly one marker, belonging to whichever run
 * happened to finish last. One bank per directory would have fixed that on its
 * own; the engine fixed it properly by naming the marker after the thing it is
 * about (src/vlm/readings.ts), and this app reads it under that name
 * (`readingState`).
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  archiveFileOf,
  bankForPosition,
  bankForReading,
  generatedFileFor,
  importDocument,
  overlayForPosition,
  rotationRefusal,
  translationFileFor,
} from './projects';
import type { ReadAsk } from '../shared/ledger';
import type { ConversionKind, ReadingPlan, WorkspacePlan } from '../shared/types';

/**
 * Where this book's ANSWERS go — everything an OCR job needs, and no more.
 *
 * ── Why this is not `planConversion` with a field left out ──────────────────
 *
 * The two jobs want different things and the difference is the whole point of
 * splitting the front door. A reading has no output file, so there is no name to
 * compose and no `generated/` predecessor to rotate aside; it has no format, so
 * there is no extension for a `--format` to contradict. What it has is a source
 * of pixels and a bank to fill.
 *
 * IT STILL RESOLVES THE PIXELS ITSELF, which is the one thing both plans share
 * and the reason neither of them takes the user's word for the input. Somebody
 * points at "the PDF", meaning the one this app shows them — and after a
 * real-text rendering that document is type on blank paper with no photograph in
 * it at all. Reading THAT would be reading a reprint of a reading. So the source
 * is `archive/`, always, and the person asking never has to know there is more
 * than one copy.
 *
 * The directories are made here rather than by the engine, because the engine is
 * handed a path and a path whose parent does not exist is a run that dies after
 * the last page.
 */
export async function planReading(
  inputPath: string,
  /**
   * WHAT THE DIALOG ASKED, and the reason this plan takes an argument it never
   * used to need.
   *
   * The bank's path is no longer a fact about the project — it is a fact about
   * WHICH READING this is, and that is decided by comparing what was asked with
   * what the project's existing readings were asked (`bankForReading`). Read the
   * same pages again and this is a replace, aimed at the step that already exists;
   * ask for a different page range and it is a branch, which gets a bank of its
   * own so the older row goes on naming the reading it is actually about.
   *
   * So the two fields the OCR form holds have to reach the plan, and reach it
   * BEFORE the enqueue: the engine is handed one path and fills it for three
   * hours, and by the time anything lands there is nothing left to decide.
   *
   * Defaulted for a caller with nothing to say, which asks the plain question —
   * the whole book, no language declared — exactly as `recordReading` does.
   */
  asked: ReadAsk = {},
): Promise<ReadingPlan> {
  const { dir, key } = await importDocument(inputPath, 'pdf');
  const sourcePath = await archiveOriginal(dir) ?? inputPath;
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  const bank = await bankForReading(dir, asked);
  return {
    key,
    sourcePath,
    readingsPath: bank.readingsPath,
    // Minted with the path and spent at the landing, so the file and the row agree
    // about which reading the bank belongs to. See `ReadRequest.stepId`.
    stepId: bank.stepId,
  };
}

/**
 * Where this PDF's RENDERING goes, and which answers it is made from.
 *
 * It used to be the plan for the whole conversion — read the pages and write the
 * book, one act. The reading moved out (`planReading`); what is left is the
 * cheap half: a name for the file, the bank to build it from, and the curation to
 * apply on the way.
 *
 * The directories are created HERE rather than by the engine, because the engine
 * is handed two paths and a path whose parent does not exist is a run that dies
 * after the last page.
 *
 * THE PREVIOUS ORIGIN IS ROTATED ASIDE BY THE QUEUE, not here. It used to happen
 * at plan time on the reasoning that "planned" and "about to run" are the same
 * instant — which is true of a job that runs and false of every other kind, and
 * the false cases left the catalogue pointing into an archive folder for a run
 * that never wrote a byte. See the note at the refusal below.
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
  /*
   * THE ROTATION IS NOT HERE ANY MORE, and moving it is the whole of a fix.
   *
   * This function used to move the previous output aside before the job was even
   * enqueued. The new file was recorded only if the run SUCCEEDED — so a
   * generate that failed, or was cancelled, or sat in the queue and was removed,
   * left the previous output in `generated/archived-<stamp>/` with the
   * catalogue's chain pointing at it and nothing in `generated/` at all. The
   * document went on listing and opening; what it opened was silently the run
   * BEFORE last, forever.
   *
   * A rotation is now made at the moment the engine is about to write
   * (electron/job-queue.ts) and put back if it does not (`restoreRotation`), so
   * a run that produces nothing leaves the catalogue exactly as it was.
   *
   * WHAT STAYS HERE IS THE REFUSAL, asked early so it can be said to somebody's
   * face: the same rule, from the same function, because a rotation that would be
   * refused at spawn is a job worth not queueing. It is asked AGAIN at the
   * rotation itself, because a tab can be opened in between and only the second
   * answer authorizes anything.
   */
  const blocked = await rotationRefusal(dir, file);
  if (blocked !== null) throw new Error(blocked);
  await fsp.mkdir(path.join(dir, 'generated'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    key,
    sourcePath,
    outputPath,
    /*
     * ── WHICH BANK, WHICH IS THE SAME QUESTION `overlayPath` BELOW ANSWERS ────
     *
     * The bank is keyed by the BOOK and never by the format: both outputs are
     * assembled from the same per-page answers, so converting a book to text after
     * converting it to EPUB must not read three hundred pages again, and a readings
     * path with the format in it would guarantee that it did.
     *
     * WHAT CHANGED IS THAT THE BOOK CAN HAVE MORE THAN ONE. A re-read asking for a
     * different page range branches by design, and while this line composed
     * `readings/<key>.jsonl` from the key, both read steps named one file — so
     * standing on the older row and pressing Generate rendered the NEWER reading.
     * The row named a bank that had been written over from under it and nothing on
     * screen admitted the swap.
     *
     * So the plan asks the row instead: `bankForPosition` walks up from the
     * position to the reading this branch of the story is about and answers with
     * that step's own payload. A project with one reading — which is every project
     * that existed before this — gets exactly the path it always got, because that
     * is what its read step already says. Nothing moves on disk.
     *
     * RESOLVED AT PLAN TIME for `overlayPath`'s reason, one paragraph down: it is
     * which state of the book the user chose when they pressed Generate, and
     * re-resolving it at spawn would let a pointer move made while the job waited
     * silently render a different reading than the dialog said it would.
     */
    readingsPath: await bankForPosition(dir),
    /*
     * ── WHICH CURATION, WHICH IS A QUESTION THIS APP DID NOT USED TO HAVE ─────
     *
     * There was one overlay per book, so `--overlay` had one answer and it was a
     * fact about the project. There is more than one now: the live file, and a
     * frozen snapshot for every time somebody pressed Save. The POSITION decides
     * which — standing on a save renders the book as it was at that save,
     * standing on the reading renders it with the live corrections — and without
     * that, a committed snapshot would be a file with a row in the history and no
     * way on earth to see its effect.
     *
     * RESOLVED AT PLAN TIME, and the alternative was considered and is worse.
     * `argsFor` tests for the file's EXISTENCE as the engine starts, deliberately,
     * because a batch waits hours and the hours are when somebody sits with the
     * block editor open — but WHICH overlay is a different question from whether
     * it is there. It is what the user chose when they pressed Generate, and
     * re-resolving it at spawn would let a pointer move made while the job waited
     * silently render a different state of the book than the dialog said it would.
     * The same rule as `Job.parentStep`, one layer down.
     *
     * A project nobody has committed a save in gets exactly the path it always
     * got: `overlayForPosition` finds no curation step and answers with the live
     * `overlays/<key>.json`.
     */
    overlayPath: await overlayForPosition(dir),
  };
}

/*
 * `overlayPathFor` USED TO LIVE HERE and is gone, which is worth a line because
 * its argument was right and only stopped applying.
 *
 * It composed `<project>/overlays/<key>.json`, and it existed so that the app had
 * ONE answer to "where is the curation for this book" rather than two call sites
 * spelling the same path. There is no longer one curation to point at: there is
 * the live file and a frozen snapshot for every save, and which of them a
 * rendering reads is decided by the position rather than composed from the key.
 * So the single answer moved to where the position is known —
 * `projects.renderingOverlay`, and `overlayForPosition` for a caller that has not
 * read the catalogue yet — and a function here that could still compose the live
 * path would be the second opinion its own comment existed to prevent.
 */

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
 *
 * THE PREVIOUS EDITION IS ROTATED ASIDE BY THE QUEUE, not here — the same
 * correction `planConversion` above already carries, arrived at second because
 * the translation had one honest-looking reason to rotate early and the
 * conversion had none. See the note at the refusal below.
 */
export async function planTranslation(
  inputPath: string,
  targetLanguage: string,
): Promise<{ key: string; sourcePath: string; outputPath: string; bankPath: string }> {
  const { dir, key, stem } = await importDocument(inputPath, 'epub');
  const file = translationFileFor(stem, targetLanguage);
  const outputPath = path.join(dir, 'generated', file);
  /*
   * THE ROTATION IS NOT HERE ANY MORE, AND NEITHER IS THE SOURCE SUBSTITUTION
   * THAT USED TO JUSTIFY IT.
   *
   * A RE-TRANSLATION READS THE COPY IT IS ABOUT TO REPLACE, which is the fact
   * that kept this function moving files for as long as it did. Translating the
   * English edition into English again names one path twice: the output is
   * composed from the PROJECT's stem and the language, so asking for a language a
   * document already is lands on that document. That is not refused — the user
   * asked for something perfectly sensible ("do that again") and a refusal would
   * have been a sentence about this app's own filing — and the rotation is what
   * makes it work rather than a special case: the copy moved aside IS the source
   * of record, and the engine reads it there. Read from what was, write to what
   * will be.
   *
   * All of which is true AT THE MOMENT THE ENGINE STARTS, and none of it is true
   * when a job is merely planned. This function used to move the previous edition
   * into `generated/archived-<stamp>/` — with the chain rewritten to point there —
   * before the job was even enqueued, and the new file was recorded only if the
   * run SUCCEEDED. So a translation that failed, or was cancelled, or sat HELD in
   * the shelf and was removed, stranded the previous edition in an archive folder
   * with nothing in `generated/` at all. The document went on listing and opening;
   * what it opened was silently the edition before last, forever. That is the
   * exact failure `restoreRotation` was written to end for conversions, and this
   * plan was the one caller still causing it.
   *
   * So the rotation happens where the engine is the next thing that happens
   * (electron/job-queue.ts) and is put back if the run writes nothing
   * (`restoreRotation`) — and the substitution travels WITH it, because there is
   * no moved-aside path to name until the rotation has made one. The queue fixes
   * the effective `--epub` up after rotating and before `argsFor`.
   *
   * WHAT STAYS HERE IS THE REFUSAL, asked early so it can be said to somebody's
   * face, exactly as `planConversion` asks it: a rotation that would be refused at
   * spawn is a job worth not queueing. It used to be asked here only as a side
   * effect of the rotation throwing, which meant it was asked at all only because
   * the destructive act was here too. It is asked AGAIN at the rotation itself,
   * because a tab can be opened in between and only the second answer authorizes
   * anything.
   */
  const blocked = await rotationRefusal(dir, file);
  if (blocked !== null) throw new Error(blocked);
  /*
   * SO THE PLAN'S SOURCE IS THE INPUT, VERBATIM, and it stays a field rather than
   * becoming an identity because it is the answer to a different question than it
   * used to be. It was "which copy of this book will the engine read" — a fact
   * about the rotation, and now unknowable until the rotation happens. It is now
   * "which file did this plan admit", which is what main's allow-list adds and
   * what the queue re-checks (`queue:enqueue-translate`). The stored request
   * carries THAT path, the one a person could name; the archived path the run
   * actually reads is composed inside `pump()`, past every admission gate, and is
   * never handed to the renderer at all.
   */
  const sourcePath = inputPath;
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

/*
 * `samePath` USED TO LIVE HERE and went with the rotation, which is worth a line
 * because the comparison itself is unchanged and only moved house.
 *
 * It existed for one caller: `planTranslation` asking whether the edition it was
 * about to rotate aside was also the file the run would read. That question is
 * now asked at the moment of rotating, in electron/job-queue.ts, and it is asked
 * there with the same case-folded resolve — the per-module path fold this
 * codebase keeps beside whoever needs it (electron/recents.ts has its own, so
 * does electron/overlays.ts). A copy left here would be a helper for nobody.
 */
