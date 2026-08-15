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
 * ── Into `generated/`, unless it is terminal ─────────────────────────────────
 *
 * What the engine writes is an ORIGIN, not a working copy: it is the record of
 * what the model actually read, every curation decision downstream is measured
 * against it, and "start over" means unpacking a fresh working tree from it. So
 * a conversion writes into `generated/` and nothing ever writes there again —
 * a second run of the same book rotates the first aside rather than replacing
 * it (electron/projects.ts, `rotateGenerated`).
 *
 * AN EXPORT IS THE EXCEPTION AND IT PROVES THE SENTENCE. `planExport` runs the
 * identical rendering and aims it at `final/`, because what comes out is not an
 * origin: nothing is ever made from it, no working tree is unpacked from it, and
 * no step in anybody's history points at it. The user's ruling is what draws the
 * line — "it wont go into the working files as a step because it isnt the base for
 * new steps. its a terminal step. so its an export." Two plans, one composition,
 * and the layer is the whole of the difference.
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
  ProjectError,
  archiveFileOf,
  bankForReading,
  bankForTranslation,
  generatedFileFor,
  importDocument,
  ledgerOf,
  readManifest,
  readingBank,
  readingIsComplete,
  renderingOverlay,
  rotationRefusal,
} from './projects';
import { translationBankOf } from '../shared/ledger';
import type { ReadAsk } from '../shared/ledger';
import {
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_TRANSLATE_MODEL,
  renderPipeline,
} from '../shared/pipeline';
import type {
  ConversionKind,
  LedgerStep,
  ProjectManifest,
  ReadingPlan,
  ThenTranslate,
  TranslationPlan,
  WorkspacePlan,
} from '../shared/types';

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
 *
 * ── AND IT IS NO LONGER ALWAYS ONE RUN ──────────────────────────────────────
 *
 * The position used to reach a Generate through exactly one field — which
 * `--overlay` — and standing on a translation rendered the book it was made FROM,
 * in the language it was made OUT of. That was the honest approximation while
 * there was nothing better available, and it is a German book handed to somebody
 * who clicked the row labelled *Translated (Hungarian)*.
 *
 * So the plan now READS THE ANCESTRY (`renderPipeline`, shared/pipeline.ts) and a
 * position standing under a translation becomes two runs under one job: render
 * the curated book out of the readings bank into a file in the OS temp directory,
 * then translate that file into the row's own EPUB. Nothing about the first three
 * rows of that table changed — a project with no translation on the path cannot
 * reach the second stage at all, and gets exactly the plan it has always got.
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
  return planRendering(inputPath, kind, GENERATED);
}

/**
 * Where this book's EXPORT goes — the same rendering, aimed at `final/`.
 *
 * ── One run, two landings, and which of them this is ────────────────────────
 *
 * An export IS a Generate. Same bank, same curation, same `--format`, same
 * translate stage when the position stands under a translation — everything that
 * reaches a command line is identical, which is why it is composed by the same
 * function above rather than by a second copy of that composition. The user's
 * ruling is about what happens AFTERWARDS: "it wont go into the working files as a
 * step because it isnt the base for new steps. its a terminal step. so its an
 * export." So the file lands in the project's tray instead of in the layer this
 * app treats as an origin, and the queue records a `ProjectFinal` row rather than a
 * step on a chain (`GenerateRequest.export`).
 *
 * ── What `final/` does not owe, and why that is not laxity ──────────────────
 *
 * `generated/` is rotated aside rather than replaced, catalogued as a chain,
 * unpacked into working trees, and REFUSED while a tab is reading one of those
 * trees. Only the first of those follows an export into the tray, and it follows it
 * for its own reason (`rotateFinal`): the name is composed from the book, so
 * exporting twice writes one path twice, and a second run silently overwriting the
 * first is the failure the rotation exists to prevent wherever a name is composed
 * rather than chosen. The refusal does NOT follow, because there is no working tree
 * hanging off a filed document for a rename to pull out from under anybody — and a
 * refusal here would stop somebody exporting the book they are looking at, which is
 * the most ordinary reason to export at all.
 *
 * ── The refusals it DOES keep, verbatim ─────────────────────────────────────
 *
 * The reading has to be finished, said in the same words about the same bank: an
 * export that quietly resumed a half-read book would put a vision model behind a
 * button labelled with a file format, which is the rule this whole layer is built
 * around (`--reuse-readings`, docs/DERIVED-BOOK.md §7). And a position standing
 * under a translation can only be exported as an EPUB, because there is no version
 * of `vlm-convert --format pdf` that reprints the scan's own pages in Hungarian.
 */
export async function planExport(
  inputPath: string,
  kind: ConversionKind = 'epub',
): Promise<WorkspacePlan> {
  return planRendering(inputPath, kind, FINAL);
}

/**
 * The two layers a rendering can be aimed at, spelled once.
 *
 * `electron/projects.ts` owns these names for the catalogue's purposes and keeps
 * its own constants; these are the two this module composes INTO, and they are
 * here rather than imported because a plan naming a third layer would be a plan
 * writing somewhere no landing knows how to record.
 */
const GENERATED = 'generated';
const FINAL = 'final';

/** The layer a rendering writes into. See `planConversion` and `planExport`. */
type RenderingLayer = typeof GENERATED | typeof FINAL;

async function planRendering(
  inputPath: string,
  kind: ConversionKind,
  layer: RenderingLayer,
): Promise<WorkspacePlan> {
  const { dir } = await importDocument(inputPath, 'pdf');
  /*
   * ── ONE READING OF THE CATALOGUE, AND EVERY ANSWER BELOW COMES OUT OF IT ───
   *
   * This used to ask `bankForPosition` and `overlayForPosition`, each of which
   * reads the manifest for itself — which was two answers about one project and
   * fine while they were two independent facts. They are not independent any
   * more: which bank, which curation, whether there is a translate stage and
   * which row it lands in are FOUR ANSWERS ABOUT ONE POSITION, and a save
   * committed between two reads would give a plan whose curation came from one
   * ledger and whose landing came from another. So the manifest is read once and
   * the same in-memory ledger answers all of it.
   */
  const manifest = await readManifest(dir);
  const { key, stem } = manifest;
  /*
   * THE PIPELINE, WHICH IS THE ANCESTRY READ AS A PLAN. It refuses here rather
   * than at the enqueue for a translation of a translation — one hop is what this
   * pass runs (docs/TRANSLATION-STEPS.md §3) — and a refusal at plan time is one
   * the dialog can say to somebody's face while the card is still open.
   */
  const pipeline = renderPipeline(ledgerOf(manifest));
  /*
   * ── THE READING HAS TO BE FINISHED, AND THIS IS EVERY GENERATE ─────────────
   *
   * A Generate is a RENDERING: it replays a bank somebody already paid for and
   * writes a document out of it, and the flag that makes that true is
   * `--reuse-readings`, which `argsFor` puts on every conversion with no switch
   * anywhere that could turn it off. That flag only means "read nothing" over a
   * bank the engine marked complete. Over one it did not — a reading killed at
   * page 9 of 17, a bank adopted from an older layout, a branch read that never
   * finished — the engine has nothing to replay, and until this refusal existed
   * it resumed instead: the pages missing from the bank went to a vision model,
   * because somebody pressed a button labelled with a file format.
   *
   * THIS TEST USED TO EXIST AND ONLY FOR TRANSLATIONS. `translateStage` asked it,
   * and `translateStage` runs only when the position stands under a translate
   * step — so the two commonest positions in the app, standing on the reading and
   * standing on a save, were planned with nothing checking the marker at all. It
   * is hoisted here because the fact it is about belongs to the PLAN and not to
   * one stage of it: every plan below names a bank, and this is the sentence
   * about that bank.
   *
   * ASKED OF THE BANK THIS PLAN WILL ACTUALLY NAME. `readingIsComplete` resolves
   * `readingBank(dir, manifest)` — the position's own read step and its own
   * payload, `readings/<key>.<id8>.jsonl` for a branch — rather than composing a
   * path from the project key. Composing it is how a branch read that never
   * finished passed a test about the ORIGINAL reading's marker and rendered
   * somebody else's pages (`readingBank`'s own header).
   *
   * NAMED BY THE ROW, never by the file: `pipeline.reading` is the step this
   * position renders from, and its label is what the user sees in the Steps list.
   * A project with no reading at all is a different sentence, because "your
   * reading did not finish" is a false thing to say to somebody who has not read
   * the book yet.
   */
  if (!await readingIsComplete(dir, manifest)) {
    throw new ProjectError(
      pipeline.reading === null
        ? 'This book has not been read yet, so there is nothing to generate from — a Generate '
          + 'renders the pages a reading already banked rather than reading them. Run OCR on it '
          + 'first, and every format after that is free.'
        : `“${pipeline.reading.label}” carries no completion marker, so that reading was interrupted `
          + 'and generating would mean reading the pages that are missing from it. Run OCR again — it '
          + 'picks up where it stopped, and pays only for what is missing — and this generates from '
          + 'the finished reading afterwards, for nothing.',
    );
  }
  const staged = pipeline.translate === null
    ? null
    : await translateStage(dir, manifest, pipeline.translate, pipeline.landsUnder, kind, layer);
  /*
   * THE NAME IS THE BOOK'S EITHER WAY, and the layer is the only thing the export
   * changes about it.
   *
   * A staged plan takes its name from `translationTarget` — `<book> (hu).epub`, or
   * `<book> (hu).<id8>.epub` for a branch — because the product of standing on a
   * translation and asking for it again IS that translation. That decision belongs
   * to the ledger and is the same decision wherever the file lands, so the basename
   * is lifted off it and joined to whichever layer was asked for. For a generated
   * rendering that reconstructs exactly the path the stage composed; for an export
   * it puts the same book, under the same name, in the tray.
   */
  const file = staged === null
    ? generatedFileFor(stem, kind)
    : path.basename(staged.outputPath);
  const outputPath = path.join(dir, layer, file);
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
   *
   * AND AN EXPORT DOES NOT ASK IT, because the sentence it would say is not true of
   * the tray. `rotationRefusal` is about a working TREE: it refuses when the book
   * in `generated/` that a rerun would move aside has been unpacked and is being
   * read in a tab, because the rename takes the chapters out from under that
   * reader. Nothing is ever unpacked from `final/` — a filed EPUB opened in a tab
   * was unpacked under its own name into `working/` and the tab reads that tree —
   * so there is no reader to protect, and asking anyway would refuse the most
   * ordinary export there is: the book somebody is looking at, again.
   */
  if (layer === GENERATED) {
    const blocked = await rotationRefusal(dir, file);
    if (blocked !== null) throw new Error(blocked);
  }
  await fsp.mkdir(path.join(dir, layer), { recursive: true });
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
     * So the plan asks the row instead: `readingBank` walks up from the
     * position to the reading this branch of the story is about and answers with
     * that step's own payload. A project with one reading — which is every project
     * that existed before this — gets exactly the path it always got, because that
     * is what its read step already says. Nothing moves on disk.
     *
     * RESOLVED AT PLAN TIME for `overlayPath`'s reason, one paragraph down: it is
     * which state of the book the user chose when they pressed Generate, and
     * re-resolving it at spawn would let a pointer move made while the job waited
     * silently render a different reading than the dialog said it would.
     *
     * IT IS THE FIRST STAGE'S BANK IN A TWO-STAGE PLAN, and unchanged by being
     * one: the vlm run reads the same pages out of the same reading whether its
     * output is the book or the input to a translation.
     */
    readingsPath: readingBank(dir, manifest),
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
     * got: `renderingOverlay` finds no curation step and answers with the live
     * `overlays/<key>.json`.
     *
     * IT IS THE SAME ANSWER IN A TWO-STAGE PLAN, and that is the whole of why the
     * strike-then-re-render walkthrough needs no new overlay machinery: standing
     * on a save made UNDER a translation, this is that save, so the vlm stage
     * writes the curated book and the translate stage never sees the struck
     * blocks. A block stricken before a translation was never translated and one
     * stricken after is translated in the bank and simply not asked for — same
     * artefact either way, and only the ledger's story about the order differs.
     */
    overlayPath: renderingOverlay(dir, manifest),
    ...(staged === null ? {} : { thenTranslate: staged.thenTranslate }),
  };
}

/**
 * The second stage of a Generate standing under a translation: where it writes,
 * and what it is asked.
 *
 * ── Where it writes is NOT the translate step's payload, quite ──────────────
 *
 * It is on a re-render of the translation itself, and it is deliberately not on a
 * re-render of a curation made under one. Both fall out of asking
 * `translationTarget` the question the LANDING will ask — same action, same
 * parent, same language — which is the same arrangement `planTranslation` already
 * has and for the same reason: the engine is handed paths and writes into them
 * for hours, so a plan that named files by one rule and a landing that filed the
 * row by another would leave the two describing different translations.
 *
 * Standing ON the translation, the parent is that row's own parent, so the target
 * is that row: its EPUB, its bank, its step id, and a landing that REPLACES.
 * Standing on a save made under it, the parent is the save, so nothing matches
 * and the target is a branch — `<book> (hu).<id8>.epub` and a bank of its own,
 * appended as a translate step parented at that save. That is the honest answer
 * rather than a convenience: the strikes are applied before the translate stage
 * sees a word, so the EPUB is a different book from the one the translation's
 * payload holds, and writing it there would leave that row describing a book with
 * paragraphs missing that nothing in the ledger admits to removing. Generate from
 * the same save twice and the second run replaces the first, because it is the
 * same question from the same parent — which is exactly what the walkthrough
 * describes.
 *
 * ── The three refusals, all of them at plan time ────────────────────────────
 *
 * EPUB ONLY. A translation is a transform of the BOOK, and there is no version of
 * `vlm-convert --format pdf` that reprints the scan's own pages in Hungarian. The
 * Generate dialog disables the other two cards for a position under a translation
 * (docs/TRANSLATION-STEPS.md §3), and this is the same rule where it can actually
 * be enforced — a dialog bound is a courtesy, and main does not take the
 * renderer's word for what a job is.
 *
 * A LANGUAGE IT NEVER RECORDED. A translation migrated out of the old catalogue
 * carries no `params.language`, because the language survived only inside a
 * filename and reading a fact out of one is what this codebase's oldest house
 * rule forbids. There is nothing to put after `--to`, and guessing from the
 * parentheses in its name is the one thing this app will not do.
 *
 * A READING WITH NO COMPLETION MARKER — AND IT IS NO LONGER ASKED HERE. It was,
 * and being asked here was the defect: this function runs only for a position
 * standing under a translation, so the rule "a Generate replays a finished
 * reading" was enforced for the one Generate in five that translates and for none
 * of the others. It is `planConversion`'s now, above the pipeline's stages, where
 * every plan passes. Nothing is weakened by the move — the same function
 * (`readingIsComplete`) asks the same question of the same bank, one call earlier
 * — and `replaysCompletedBank` (src/vlm/read.ts) stays TRUE BY CONSTRUCTION for
 * this stage's vlm run, which is what lets the queue skip the reading server for
 * the whole job. There is deliberately no second test here: two tests of one fact
 * are two answers the day either of them moves.
 */
async function translateStage(
  dir: string,
  manifest: ProjectManifest,
  translate: LedgerStep,
  landsUnder: string | null,
  kind: ConversionKind,
  /**
   * Which landing this stage is composing for — and the ONE thing it changes here
   * is which bank the answers go into.
   *
   * See the note above `seed` below. Everything else about the stage is identical,
   * which is the whole reason `planExport` reuses it.
   */
  layer: RenderingLayer,
): Promise<{ outputPath: string; thenTranslate: ThenTranslate }> {
  if (kind !== 'epub') {
    throw new ProjectError(
      `“${translate.label}” can only be generated as an EPUB. A translation is a transform of the book `
      + 'itself, and reprinting the scan\'s own pages in another language is not something this engine '
      + 'does — step back to the reading to make a PDF or a text file of the original.',
    );
  }
  const language = translate.params?.language?.trim() ?? '';
  if (language.length === 0) {
    throw new ProjectError(
      `“${translate.label}” does not say which language it was made into, so there is nothing to ask the `
      + 'model for. It was recorded before Foundry kept that, and the way to get a fresh edition is to '
      + 'translate again from the step it was made from.',
    );
  }
  const planned = await bankForTranslation(dir, language, landsUnder);
  /*
   * A BRANCH IS SEEDED FROM ITS PARENT'S BANK — the plan names the source here,
   * and the copy itself waits for the spawn (`pump()`), because a held job that
   * is removed must leave `readings/` untouched. The branch test is the step id:
   * `translationTarget` spends the minted uuid only when no existing row is the
   * re-run target, so an id that is not the ancestral row's is a new row with an
   * empty bank ahead of it — the one case where a first Generate would otherwise
   * pay for a whole book whose translation already exists (see `seedBank`).
   */
  const seed = planned.stepId !== translate.id
    ? translationBankOf(translate, manifest.key)
    : null;
  /*
   * ── AN EXPORT FILLS THE ANCESTRAL BANK RATHER THAN MINTING ONE ─────────────
   *
   * The paragraph above is about a branch that will BECOME A ROW: `planned.stepId`
   * is minted here, the landing spends it, and the bank ends up named after a step
   * that exists. An export lands no step at all — that is the whole of what makes
   * it an export — so a branch bank composed for it would be
   * `readings/<key>.<tag>.<id8>.jsonl` named after a row nobody will ever create:
   * invisible to every listing, unreachable by the sweep that clears a deleted
   * step's banks (`orphanedBanks`), and permanent.
   *
   * So an export aims `--bank` at the translation it descends FROM. That is safe
   * for the reason the seeding was safe in the first place: the bank is keyed by
   * the whole question — model, languages, instructions, the block's own text — so
   * answers written from a curated descendant are exactly as true in the parent's
   * bank as they were going to be in a copy of it. Struck blocks are never asked,
   * edited text asks a new question and gets a new key, and nothing already in
   * there is touched. What the export gains is every unchanged block for free; what
   * the project gains is one bank per translation instead of one per export.
   *
   * `seedBank` goes with it, because there is nothing left to seed: the file it
   * would have copied FROM is now the file being written TO.
   */
  const bankPath = layer === FINAL && seed !== null
    ? path.join(dir, ...seed.split('/'))
    : planned.bankPath;
  return {
    outputPath: planned.outputPath,
    thenTranslate: {
      to: language,
      bank: bankPath,
      ...(seed !== null && layer !== FINAL
        ? { seedBank: path.join(dir, ...seed.split('/')) }
        : {}),
      /*
       * NOBODY CHOSE THESE, BECAUSE THERE IS NO DIALOG HERE. The row is the
       * picker (docs/TRANSLATION-STEPS.md §3) — Generate asks for a format and
       * nothing else — so the stage takes the same defaults the Translate
       * dialog's fields open on, out of the one place both of them read them
       * from. A model recorded per step was considered and refused in §2: a
       * re-translation with a different model is somebody refining THIS
       * translation, so the model is not part of what identifies one, and a step
       * that carried it would make every model bump a new row.
       */
      model: DEFAULT_TRANSLATE_MODEL,
      ollama: DEFAULT_OLLAMA_ENDPOINT,
      parent: landsUnder,
      stepId: planned.stepId,
    },
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
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  /*
   * ── WHICH TRANSLATION THIS IS, AND THEREFORE WHAT ITS FILES ARE CALLED ────
   *
   * This used to compose `<stem> (<tag>).epub` from the stem and the language
   * alone — one name per book per language, forever — which was true while a book
   * could hold one translation into a language and became a collision the moment
   * the ledger let it hold two. The user's own scenario is exactly that: translate
   * the reading, strike some blocks, commit, translate the curation. Two steps,
   * two sets of answers, and one filename holding whichever ran last.
   *
   * So the plan asks the ledger instead (`bankForTranslation` → `translationTarget`,
   * shared/ledger.ts): a re-translation from the same step aims at that step's own
   * EPUB and its own bank — which is what makes it nearly free, every unchanged
   * block being a cache hit — and a translation from a DIFFERENT step mints
   * `<name>.<id8>.<ext>` for both, `id8` being the front of the step's uuid.
   *
   * THE STEP ID IS MINTED HERE AND TRAVELS WITH THE JOB (`TranslateRequest.stepId`),
   * for `planReading`'s reason: the files are named after a step that will not
   * exist for hours, and minting a second id at the landing would leave them named
   * after a row nobody created.
   */
  const planned = await bankForTranslation(dir, targetLanguage);
  const outputPath = planned.outputPath;
  const file = path.basename(outputPath);
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
   *
   * PER STEP AS WELL AS PER LANGUAGE now, and the name is composed where the
   * output's is (`translationTarget`) rather than by a second copy of the tag rule
   * here — the two files are one decision and a folder holding a branch's EPUB
   * beside the first translation's bank would be answers filed under the wrong
   * book.
   */
  return {
    key,
    sourcePath,
    outputPath,
    bankPath: planned.bankPath,
    stepId: planned.stepId,
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
