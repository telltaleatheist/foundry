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
import * as os from 'node:os';
import * as path from 'node:path';

import { materializeBook } from './book';

import {
  ProjectError,
  archiveFileOf,
  bankForReading,
  generatedFileFor,
  importDocument,
  ledgerOf,
  overlayFileFor,
  readManifest,
  readingBank,
  readingIsComplete,
  recordsForTranslation,
  rotationRefusal,
} from './projects';
import {
  curateCastFile,
  editsInEffect,
  facsimileFile,
  languageTagFor,
  readingInEffect,
  translationCastFile,
  translationInEffect,
  translationRecordsOf,
} from '../shared/ledger';
import type { ReadAsk } from '../shared/ledger';
import { renderPipeline } from '../shared/pipeline';
import type {
  ConversionKind,
  LedgerStep,
  ProjectLedger,
  ProjectManifest,
  ReadingPlan,
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
  return (await planRendering(inputPath, kind, GENERATED)).plan;
}

/**
 * The same rendering, KEYED TO ONE STEP instead of to the position — the plan a
 * landing's own book is cast from.
 *
 * ── The bug this shape exists to avoid ──────────────────────────────────────
 *
 * A save does not move the pointer (`RETAINED_BESIDE_YOU`, shared/ledger.ts):
 * pressing Apply leaves the user standing exactly where they were, which is
 * almost always the reading. So `planConversion` here would ask the position
 * which corrections are in effect, get the LIVE overlay, and write it out under
 * the save's name — the book as it is right now, filed as the book as it was
 * then, and indistinguishable from the real thing forever after. The step is
 * handed in instead, and every question below is asked of IT.
 *
 * ── TWO KINDS OF LANDING CAST A BOOK, AND THE SECOND IS WHY THIS GENERALIZED ─
 *
 * A CURATE step's book is the project's flowing book with that snapshot applied.
 * A TRANSLATE step's book is the project's flowing book with that step's RECORDS
 * substituted into the blocks — because a translation writes records and no
 * document at all now, so the row has nothing to show until one is cast. Both are
 * `<stem>…<id8>.epub` in `generated/`, both are renderings that are nobody's
 * payload, both are swept when their step is deleted, and both are planned here
 * so that the overlay, the bank and the records are read off the STEP.
 *
 * ── EPUB, always, and not a parameter ───────────────────────────────────────
 *
 * What either row shows is the flowing book (`documentAtPosition`), which is the
 * one format everything downstream of a reading works on. A facsimile of a save is
 * a thing somebody can ask for through Export, from the row, at any time.
 *
 * ── A save under a translation is NOT declined any more ─────────────────────
 *
 * It used to be, and the refusal was right about the pipeline it was written for:
 * casting that book meant running the translator, which is model time, and this
 * plan is made by a landing rather than by a person pressing a button. Casting it
 * now means reading the ancestral translation's records — arithmetic over a file
 * that is already on disk — so the justification for doing it unasked ("it takes
 * seconds, it is free") is true again, and the row shows the translated book as of
 * that save. What is still declined is a save under a translation made BEFORE
 * records existed: there is no file to read, and the only way to get one is a run
 * that spends the model.
 */
export async function planConversionForStep(
  inputPath: string,
  step: LedgerStep,
): Promise<WorkspacePlan> {
  return (await planRendering(inputPath, 'epub', GENERATED, step)).plan;
}

/**
 * Where this READING's page-for-page record goes — the same rendering, aimed at
 * `generated/` as a PDF and keyed to the read step that made the bank.
 *
 * ── Why a reading gets a second product, unasked ────────────────────────────
 *
 * Because a bank is not a thing anybody can look at, and the flowing book is
 * only half of what is in it. The other half is the pages as they were printed,
 * set back as real text: *"from the bank, pdf facsimile can be generated. that's
 * a terminal item"* (docs/RENDERER.md §0 A3, §6). It costs what every other cast
 * costs — `--reuse-readings` over a bank marked complete one line earlier, no
 * model, no socket, seconds — which is the whole of why it can happen without
 * anybody pressing anything.
 *
 * ── PDF, always, and keyed to the step for `planConversionForStep`'s reason ──
 *
 * A facsimile is the only thing this plan can be: `--format pdf` reprints the
 * scan's own photographed lines, which is a statement about the READING and not
 * about any state of the book downstream of it. And it is keyed to the step
 * because a project can hold two readings — a re-read asking for a different
 * page range branches by design — so a plan that asked the POSITION which bank
 * to replay would reprint whichever reading the pointer happened to be under
 * while the name said this one. Both halves of that agreement are made here:
 * `readingBank` resolves the step's own payload, and `facsimileFile` names the
 * file after the same step.
 *
 * THE CURATION IT RESOLVES IS NOT USED, and the caller says so where it enqueues
 * (`castFacsimile`, electron/job-queue.ts). A facsimile is the record of what
 * was read; it compiles from the raw bank and from nothing else (§6), so the
 * plan's `overlayPath` is deliberately left on the floor rather than carried
 * onto the request.
 */
export async function planFacsimile(
  inputPath: string,
  step: LedgerStep,
): Promise<WorkspacePlan> {
  return (await planRendering(inputPath, 'pdf', GENERATED, step)).plan;
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
 * ── AND IT IS THE ONE RENDERING THAT COMPILES THE EDITED BOOK ───────────────
 *
 * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
 * §6.) A position with applied changes on the way to it used to be refused here,
 * because the engine builds from the pages that were read and the changes live
 * beside them — so the book that came out would have had none of them in it. It
 * is not refused any more: main replays the chain into a derived book file and
 * the engine compiles THAT (`vlm-compile`), which is what makes a person who
 * struck forty running heads and pressed Export get a book without them.
 *
 * The other renderings still refuse, each for its own reason — see
 * `refuseOverEdits` — and a FACSIMILE export never touches any of this: it
 * reprints the reading's own pages from the raw bank, which is a statement about
 * what was read rather than about any state of the book downstream of it.
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
  const planned = await planRendering(inputPath, kind, FINAL);
  if (!planned.compiles) return planned.plan;
  /*
   * ── THE BOOK WITH THE CHANGES IN IT, WRITTEN OUT FOR THE ENGINE ────────────
   *
   * *"Export → materialize (replay) → engine compiles EPUB/txt."*
   * (docs/RENDERER.md §6.) `planRendering` has just decided that this export both
   * CAN and MUST carry changes — the layer, the format, the absence of a
   * translation and the presence of applied changes are what that turns on — so
   * here is the other half: the position's book file with its whole chain
   * replayed into it, as a book file of its own, which is the only language main
   * and the engine both speak.
   *
   * AT PLAN TIME, on `overlayPath`'s rule one function down: which state of the
   * book this is is the state the person chose when they pressed the button, and
   * materialising at spawn would let a pointer move made while the job waited
   * export a different book than the dialog said it would.
   *
   * INTO THE OS TEMP DIRECTORY, under a folder of foundry's own — the same place
   * the metadata stage puts the file it stamps (electron/job-queue.ts), and for
   * the same reason: it is scratch, it belongs to one job, nothing catalogues it
   * and the queue removes it when the job settles. `generated/` was the other
   * candidate and is worse: everything in there is drawn, swept and reasoned
   * about by the ledger, and a file nobody can name would be the one exception.
   */
  const derived = await materializeBook(planned.dir, path.join(os.tmpdir(), 'foundry'));
  /*
   * A REFUSAL HERE IS THE PERSON'S OWN SENTENCE. `materializeBook` answers in
   * words for everything a person can be told about — a book file whose bank has
   * moved, a step whose payload will not read — and the export dialog shows main's
   * sentences verbatim, which is where those belong. What it will not do is queue
   * a job over a book it could not read: an export that ran anyway would be the
   * cast of an unedited book filed as an edition, which is the silence this whole
   * wave exists to end.
   */
  if (!derived.ok) throw new ProjectError(derived.reason);
  return { ...planned.plan, bookPath: derived.path };
}

/**
 * A CHAIN WITH APPLIED CHANGES IN IT CANNOT BE RENDERED BY THE BANK ROUTE, and
 * this is the one place that says so.
 *
 * ── Why a refusal is the only honest answer here ────────────────────────────
 *
 * The engine's `vlm-convert` compiles a book out of a readings bank and a
 * curation. It has never heard of the op grammar and it is never going to: the
 * changes a person makes on the proof sheet are ops in the ledger, replayed by
 * one implementation that lives in this process (docs/RENDERER.md §9, R1). So a
 * rendering that went down that route from a position with edit steps on its path
 * would run perfectly and produce a document with none of those changes in it —
 * the strikes back, the retyped sentences reverted, the relabelled headings as the
 * model first read them — and nothing on screen saying so. That is the worst
 * outcome available: silent, plausible, and discovered in a finished file.
 *
 * ── AND WHAT THE ROOT FIX TOOK OFF IT ───────────────────────────────────────
 *
 * *"A person who struck forty running heads and pressed Export would file a book
 * that still has them."* Not any more: an EXPORT of an untranslated book to EPUB
 * or to plain text goes through the compile now (`planExport`), so the sentence
 * this refusal was written to prevent is prevented by making the book properly
 * instead. What still comes here is everything that route cannot carry, and each
 * of them for a reason rather than for the want of a wave:
 *
 *  - GENERATE, whose product is the `generated/` CAST — a workbench book carrying
 *    the very editing stamps an edition withholds, which is what `translate`
 *    reads and what select mode addresses. Compiling one is a different question
 *    and is R6's, when the two collapse into one route.
 *  - A FACSIMILE, which reprints the scan's own photographed lines page for page.
 *    It is a record of the READING and compiles from the raw bank by definition
 *    (§6); there is nothing about an edit for it to carry.
 *  - AN EXPORT STANDING UNDER A TRANSLATION, whose words come out of a records
 *    file keyed to the bank's own positions. Putting those words into a book file
 *    the ops have restructured is the derived-book half of R5 and is not this
 *    unit; until it lands, the refusal is the honest answer.
 *
 * ── ONE CHOKE POINT, NOT ONE PER BUTTON ─────────────────────────────────────
 *
 * `planRendering` is where every rendering in this app is composed — Generate,
 * Export, a landing's own cast, a facsimile — and `planTranslation` is where the
 * only other engine run is. Two calls, and every door in the UI goes through one
 * of them. Refusing at the buttons instead would be five copies of this rule and
 * a sixth door somebody adds without it.
 *
 * ── ASKED OF THE STEP WHEN THE PLAN IS ABOUT ONE ────────────────────────────
 *
 * `planRendering`'s own rule, and it keeps this from firing where it must not. A
 * read landing's facsimile is keyed to the read step, whose ancestry is the import
 * and itself — an edit made afterwards is a CHILD of that row and not an ancestor
 * of it — so the automatic reprint is never refused by an edit somebody makes
 * later. A save's cast under an edit chain IS refused, and rightly: that book
 * would be the same lie with a step's name on it, and `castStepBook` already
 * treats a plan it cannot make as a console line rather than a failed save
 * (electron/job-queue.ts).
 *
 * NAMED BY THE ROW, like every refusal in this function, and never by a file.
 */
function refuseOverEdits(ledger: ProjectLedger, forStep: LedgerStep | null): void {
  const edits = editsInEffect(ledger, forStep);
  const oldest = edits[0];
  if (oldest === undefined) return;
  throw new ProjectError(
    edits.length === 1
      ? `“${oldest.label}” is on the way to where you are standing, and this one is built from the `
        + 'pages that were read rather than from the book you have been editing — so it would hand '
        + 'you a document with none of those changes in it. Export the book instead and every one of '
        + 'them is in what you get, or stand on a step below that one to make this.'
      : `${edits.length} rows of applied changes are on the way to where you are standing, beginning `
        + `with “${oldest.label}”, and this one is built from the pages that were read rather than `
        + 'from the book you have been editing — so it would hand you a document with none of them '
        + 'in it. Export the book instead and every one of them is in what you get, or stand on a '
        + 'step below the first of them to make this.',
  );
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

/**
 * The plan, and the two facts about it that are this module's business and
 * nobody else's.
 *
 * `WorkspacePlan` is what crosses the bridge to the window that asked, and it is
 * a list of paths and nothing else. `dir` is where the project lives, which the
 * renderer must never be handed (composing a project path over there is how a
 * branch read ends up answering for the other reading's bank); `compiles` is the
 * answer to "can this rendering carry the changes on the way to it", which is
 * decided once, below, and read once, by `planExport`.
 */
interface PlannedRendering {
  plan: WorkspacePlan;
  dir: string;
  compiles: boolean;
}

async function planRendering(
  inputPath: string,
  kind: ConversionKind,
  layer: RenderingLayer,
  /**
   * THE STEP THIS RENDERING IS ABOUT, when it is about one rather than about the
   * position. See `planConversionForStep`, which is the only caller that passes it
   * and the header that argues for it.
   *
   * It changes exactly three of the answers below — which corrections are applied,
   * which translation's words go in, and what the file is called — and deliberately
   * nothing else: the pixels, the completion refusal and the rotation rule are the
   * same facts about the same project however this plan was reached.
   */
  forStep: LedgerStep | null = null,
): Promise<PlannedRendering> {
  const { dir } = await importDocument(inputPath, 'pdf');
  /*
   * ── ONE READING OF THE CATALOGUE, AND EVERY ANSWER BELOW COMES OUT OF IT ───
   *
   * This used to ask `bankForPosition` and `overlayForPosition`, each of which
   * reads the manifest for itself — which was two answers about one project and
   * fine while they were two independent facts. They are not independent any
   * more: which bank, which curation and whose words go in the blocks are THREE
   * ANSWERS ABOUT ONE POSITION, and a save committed between two reads would give
   * a plan whose curation came from one ledger and whose records came from
   * another. So the manifest is read once and the same in-memory ledger answers
   * all of it.
   */
  const manifest = await readManifest(dir);
  const { stem } = manifest;
  const ledger = ledgerOf(manifest);
  /*
   * THE PIPELINE, WHICH IS THE ANCESTRY READ AS A PLAN — and asked of the STEP
   * when this plan is about one, because a landing casts a book while the pointer
   * is somewhere else entirely (`planConversionForStep`).
   *
   * IT NO LONGER REFUSES ANYTHING. It used to throw for a translation of a
   * translation, one hop being what the two-stage pipeline could run; a chain is
   * resolved when its records are WRITTEN now, so materialisation reads one file
   * of answers however many languages the book passed through (shared/pipeline.ts).
   */
  const pipeline = renderPipeline(ledger, forStep);
  /*
   * ── WHICH ROUTE THIS RENDERING TAKES, AND IT IS FOUR FACTS ─────────────────
   *
   * An EXPORT of an untranslated book to EPUB or to plain text, FROM A POSITION
   * THAT CARRIES APPLIED CHANGES, is compiled from a materialised book file —
   * the one route that can carry what a person did on the proof sheet
   * (docs/RENDERER.md §6). Everything else is the bank route, and everything else
   * therefore still refuses over an edit chain; `refuseOverEdits` below carries
   * the argument for each of the three cases it still fires on.
   *
   * A BOOK NOBODY HAS EDITED KEEPS THE LEGACY PATH, deliberately and for now. The
   * two routes produce the same edition out of the same reading when there is
   * nothing to replay — `vlm-convert --final` and `vlm-compile` write the same
   * elements through the same emitter — so nothing is bought by moving it today
   * and one thing is risked: every export in the library changing command at once.
   * R6 COLLAPSES THEM, and it is the wave that can, because it is where the cast
   * in `generated/` stops being a file anybody unpacks. Until then this condition
   * is a line that gets deleted rather than a branch that grows.
   */
  const compiles = layer === FINAL
    && (kind === 'epub' || kind === 'txt')
    && pipeline.translate === null
    && editsInEffect(ledger, forStep).length > 0;
  // A no-op for the export that just took the compile route, and for every
  // position with nothing applied on the way to it — which is most of them.
  if (!compiles) refuseOverEdits(ledger, forStep);
  /*
   * ── THE READING HAS TO BE FINISHED, AND THIS IS EVERY RENDERING ────────────
   *
   * A rendering REPLAYS a bank somebody already paid for and writes a document out
   * of it, and the flag that makes that true is `--reuse-readings`, which `argsFor`
   * puts on every conversion with no switch anywhere that could turn it off. That
   * flag only means "read nothing" over a bank the engine marked complete. Over one
   * it did not — a reading killed at page 9 of 17, a bank adopted from an older
   * layout, a branch read that never finished — the engine has nothing to replay,
   * and until this refusal existed it resumed instead: the pages missing from the
   * bank went to a vision model, because somebody pressed a button labelled with a
   * file format.
   *
   * ASKED OF THE BANK THIS PLAN WILL ACTUALLY NAME, which is why it takes the step
   * this plan is about. `readingIsComplete` resolves `readingBank(dir, manifest,
   * at)` — that row's own read step and its own payload,
   * `readings/<key>.<id8>.jsonl` for a branch — rather than composing a path from
   * the project key. Composing it is how a branch read that never finished passed a
   * test about the ORIGINAL reading's marker and rendered somebody else's pages
   * (`readingBank`'s own header), and asking the POSITION here while naming the
   * step's bank below would be the same lie in a shorter window: a cast keyed to a
   * step under one reading, cleared by a test about the other one.
   *
   * NAMED BY THE ROW, never by the file: `pipeline.reading` is the step this
   * position renders from, and its label is what the user sees in the tree. A
   * project with no reading at all is a different sentence, because "your reading
   * did not finish" is a false thing to say to somebody who has not read the book
   * yet.
   */
  if (!await readingIsComplete(dir, manifest, forStep)) {
    throw new ProjectError(
      pipeline.reading === null
        ? 'This book has not been read yet, so there is nothing to make it from — a rendering '
          + 'replays the pages a reading already banked rather than reading them. Run OCR on it '
          + 'first, and every format after that is free.'
        : `“${pipeline.reading.label}” carries no completion marker, so that reading was interrupted `
          + 'and rendering would mean reading the pages that are missing from it. Run OCR again — it '
          + 'picks up where it stopped, and pays only for what is missing — and this is made from '
          + 'the finished reading afterwards, for nothing.',
    );
  }
  /*
   * WHOSE WORDS GO IN THE BLOCKS, when the position stands under a translation.
   * Null for a rendering of the book in its own language, which is most of them.
   *
   * THE STEP TRAVELS WITH THE ANSWER because the NAME below needs it: a translated
   * book made in `generated/` is that translation's own cast, and a cast is named
   * for the row it belongs to.
   */
  const translated = pipeline.translate === null
    ? null
    : { step: pipeline.translate, ...translatedWords(dir, pipeline.translate, kind) };
  /*
   * THE NAME IS THE BOOK'S EITHER WAY, and the layer is the whole of what changes
   * about it.
   *
   * A TRANSLATED BOOK IN `generated/` IS THAT TRANSLATION'S CAST, whoever asked for
   * it — the landing that casts one unasked and a person asking for the book by
   * file format are the same rendering of the same records, so they must be the
   * same file. Naming it `<book> (hu).epub` instead would be two different books
   * one filename apart: that name is the PAYLOAD of every translate step made
   * before records, and `rotateGenerated` — which takes a basename and knows
   * nothing about the ledger — would move that row's own book into an archive
   * folder to make room for this one. Named for the row, nothing ever collides,
   * and a second ask rotates only its own previous copy.
   *
   * AN EXPORT KEEPS THE HUMAN NAME, because `final/` is a tray a person opens and
   * nothing in it is anybody's payload: `<book> (hu).epub`, beside `<book>.epub`.
   * Two translations into one language exported twice land on one name and the
   * second rotates the first aside, which is exactly what `rotateFinal` exists for
   * wherever a name is composed rather than chosen.
   *
   * AND A PER-STEP CAST IS NAMED FOR ITS STEP — `<stem>.<id8>.epub` for a save,
   * `<stem> (hu).<id8>.epub` for a translation — the scheme readings already use,
   * composed by the ledger (`curateCastFile`, `translationCastFile`) so that the
   * plan, the resolution that shows the file and the sweep that removes it cannot
   * come to three answers.
   */
  const file = forStep !== null
    ? castNameFor(stem, forStep, translated?.language ?? '')
    : translated === null
      ? generatedFileFor(stem, kind)
      : layer === GENERATED
        ? translationCastFile(stem, translated.language, translated.step.id)
        : generatedFileFor(`${stem} (${languageTagFor(translated.language)})`, kind);
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
   * rendering that failed, or was cancelled, or sat in the queue and was removed,
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
    dir,
    compiles,
    plan: {
    key: manifest.key,
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
     * standing on the older row and rendering rendered the NEWER reading. The row
     * named a bank that had been written over from under it and nothing on screen
     * admitted the swap.
     *
     * So the plan asks the row: `readingBank` walks up from the position — or from
     * the step this plan is about — to the reading this branch of the story is
     * about, and answers with that step's own payload. A project with one reading —
     * which is every project that existed before this — gets exactly the path it
     * always got, because that is what its read step already says. Nothing moves on
     * disk.
     *
     * RESOLVED AT PLAN TIME for `overlayPath`'s reason, one paragraph down: it is
     * which state of the book the user chose when they asked, and re-resolving it at
     * spawn would let a pointer move made while the job waited silently render a
     * different reading than the dialog said it would.
     *
     * IT IS THE SAME BANK FOR A TRANSLATED BOOK, and that is the point of records:
     * a translation is not a second reading of anything, it is different words in
     * the same blocks of the same pass over the pages.
     */
    readingsPath: readingBank(dir, manifest, forStep),
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
     * it is there. It is what the user chose when they asked, and re-resolving it
     * at spawn would let a pointer move made while the job waited silently render
     * a different state of the book than the dialog said it would. The same rule
     * as `Job.parentStep`, one layer down.
     *
     * IT IS THE PIPELINE'S OWN ANSWER, which is what makes a per-step cast honest:
     * `renderPipeline` was asked of the STEP, so a save's cast gets that save's
     * frozen snapshot (the walk finds the step itself) and a translation's cast
     * gets the curation the translation was made under. Asking the position
     * instead would write the live overlay under a step-shaped name — the book as
     * it is now, filed as the book as it was then.
     *
     * A project nobody has committed a save in gets exactly the path it always
     * got: the walk finds no curation step and `overlayFileFor` answers with the
     * live `overlays/<key>.json`.
     *
     * IT IS THE SAME ANSWER FOR A TRANSLATED BOOK, and that is the whole of why
     * the strike-then-re-render walkthrough needs no new overlay machinery:
     * standing on a save made UNDER a translation, this is that save, so the
     * struck blocks are dropped before a word is written and their records are
     * simply never looked up. A block stricken before a translation was never
     * translated and one stricken after is translated in the records and not asked
     * for — same artefact either way, and only the ledger's story about the order
     * differs.
     */
    overlayPath: overlayFileFor(dir, manifest, pipeline.curation),
    ...(translated === null
      ? {}
      : { records: translated.records, language: translated.language }),
    },
  };
}

/**
 * What a landing's own document is called — one composition, chosen by what kind
 * of row made it.
 *
 * All three names come from shared/ledger.ts rather than being spelled here, for
 * the reason every path in this app is composed where the ledger can see it: the
 * plan that writes the file, the resolution that shows it and the sweep that
 * removes it when the step goes must not be three answers.
 *
 * THE FORMAT IS DECIDED WITH THE NAME AND NOT BESIDE IT, which is the one thing
 * to be careful of here: a read step's document is a PDF and the other two are
 * EPUBs, so the extension this composes is a fact about the ACTION rather than
 * about the `kind` the plan was called with. The two agree because there is one
 * door per row — `planFacsimile` is the only caller that hands over a read step
 * and it is the only one that asks for `pdf` — and a third door that paired them
 * differently would be asking the engine for a format its own `--out` refuses.
 */
function castNameFor(stem: string, step: LedgerStep, language: string): string {
  if (step.action === 'read') return facsimileFile(stem, step.id);
  return step.action === 'translate'
    ? translationCastFile(stem, language, step.id)
    : curateCastFile(stem, step.id);
}

/**
 * The translation's own words and the language they are in — or a refusal naming
 * what this app will not do.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 *
 * A second engine run. The book was rendered into a nameless EPUB in the OS temp
 * directory and handed to `translate`, which read it and wrote the real file; an
 * export added a THIRD run to tidy what came back into an edition, because
 * `translate` reads the very stamps an edition withholds. All of that was the cost
 * of a translation being a FILE. It is a records file now, so the translated book
 * is CAST by the same run that assembles every other book — the records go in at
 * the one point where a block's words are written, upstream of the format fork and
 * upstream of the edition rules — and the temp directory, the splice, the tidy and
 * the second bank all go with the change.
 *
 * ── The three refusals, all of them at plan time ────────────────────────────
 *
 * NO FACSIMILE. The PDF route reprints the PAGE — the scan's own photographed
 * lines, set back as type — and there is nowhere in it for a translated paragraph
 * to go; the engine refuses the pair by name for the same reason
 * (src/vlm/convert.ts). What CAN be made from here is the EPUB and the plain text,
 * which is one product more than the two-stage pipeline could offer: that one
 * ended in `translate`, which reads a book and writes a book, so the text route
 * was unreachable through it. Records reach the text emitter because they are
 * substituted before the format fork.
 *
 * A LANGUAGE IT NEVER RECORDED. A translation migrated out of the old catalogue
 * carries no `params.language`, because the language survived only inside a
 * filename and reading a fact out of one is what this codebase's oldest house rule
 * forbids. There is nothing to declare the cast as, and guessing from the
 * parentheses in its name is the one thing this app will not do.
 *
 * A TRANSLATION THAT PREDATES RECORDS. Its answers are a bank keyed by the masked
 * XHTML of a book, and the masking moved a stage earlier when records arrived
 * (`KEY_FORMAT`, src/translate/bank.ts) — so every key in it misses by design, and
 * a run that read it would re-ask the model for the whole book while claiming to
 * be arithmetic. The honest answer is the sentence: that row still has the EPUB it
 * made, standing on it still shows that book, and translating again from the step
 * it was made from puts the project on records for good.
 */
function translatedWords(
  dir: string,
  translate: LedgerStep,
  kind: ConversionKind,
): { records: string; language: string } {
  if (kind === 'pdf') {
    throw new ProjectError(
      `“${translate.label}” cannot be made into a facsimile. A facsimile reprints the scan's own `
      + 'photographed pages, and there is nowhere on a photograph of a German page to put a '
      + 'Hungarian paragraph — step back to the reading to make a facsimile of the original.',
    );
  }
  const language = translate.params?.language?.trim() ?? '';
  if (language.length === 0) {
    throw new ProjectError(
      `“${translate.label}” does not say which language it was made into, so there is nothing to `
      + 'declare the book as. It was recorded before Foundry kept that, and the way to get a fresh '
      + 'edition is to translate again from the step it was made from.',
    );
  }
  const records = translationRecordsOf(translate);
  if (records === null) {
    throw new ProjectError(
      `“${translate.label}” was made before Foundry kept a translation as records, so its words exist `
      + 'only inside the book that run wrote. That book is still here and standing on that step still '
      + 'shows it — but making anything else from it means translating again from the step it was '
      + 'made from, and everything after that is free.',
    );
  }
  return { records: path.join(dir, ...records.split('/')), language };
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
 * Where this book's TRANSLATION goes — which is a records file, and no book.
 *
 * IN THE SAME PROJECT AS THE BOOK IT CAME FROM, which is the whole reason this
 * function stopped keying on the input's own content. A German original and its
 * English and French editions are one book with three sets of answers about it,
 * kept in the folder that holds the reading they were all taken of, rather than in
 * three unrelated directories that nothing on disk connects.
 *
 * ── WHAT IT WRITES CHANGED, AND EVERYTHING FOLLOWS FROM THAT ───────────────
 *
 * It wrote `generated/<book> (hu).epub`: a second EPUB, same container, same
 * pictures, translated text inside every stamped element. It writes
 * `readings/<key>.hu[.<id8>].records.jsonl` now — one row per flowing block,
 * keyed by that block's own position in the reading bank — and no document at all.
 * The book a person reads is CAST from those records afterwards, by the same
 * `vlm-convert` that assembles every other book in this app.
 *
 * Three things this function used to owe went with the EPUB. There is no
 * `.epub` extension to keep load-bearing (nothing opens a records file in a tab).
 * There is no previous edition to rotate aside, and therefore no rotation refusal
 * and no self-overwrite case — this run writes into `readings/`, where nothing is
 * ever unpacked and no tab is ever pointed. And there is no separate bank: the
 * records file IS the cache, which is why the engine refuses `--bank` beside
 * `--records` by name.
 *
 * ── AND IT MAY BE A CHAIN, WHICH THE LEDGER DECIDES AND NOBODY ELSE ────────
 *
 * The user: *"if they click the english translation and then click translate to
 * hungarian, it translates from english to hungarian."* Standing under a
 * translation, this run's questions are asked of the PARENT'S answers rather than
 * of the book's own words — `--source-records`, plus `--from` naming the language
 * those answers are in. Both are read off the nearest translate step on the
 * ancestry, HERE, because the renderer holds a mirror of the ledger and a source
 * language taken from a mirror is a prompt that can be told the wrong thing about
 * what it is holding.
 */
export async function planTranslation(
  inputPath: string,
  targetLanguage: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  /*
   * ── WHICH TRANSLATION THIS IS, AND THEREFORE WHAT ITS FILE IS CALLED ──────
   *
   * This used to compose `<stem> (<tag>).epub` from the stem and the language
   * alone — one name per book per language, forever — which was true while a book
   * could hold one translation into a language and became a collision the moment
   * the ledger let it hold two. The user's own scenario is exactly that: translate
   * the reading, strike some blocks, commit, translate the curation. Two steps,
   * two sets of answers, and one filename holding whichever ran last.
   *
   * So the plan asks the ledger instead (`recordsForTranslation` →
   * `translationTarget`, shared/ledger.ts): a re-translation from the same step
   * aims at that step's own records — which is what makes it nearly free, every
   * unchanged block already answered in there — and a translation from a DIFFERENT
   * step mints `<name>.<id8>.jsonl`, `id8` being the front of the step's uuid.
   *
   * THE STEP ID IS MINTED HERE AND TRAVELS WITH THE JOB (`TranslateRequest.stepId`),
   * for `planReading`'s reason: the file is named after a step that will not exist
   * for hours, and minting a second id at the landing would leave it named after a
   * row nobody created.
   */
  // The same refusal `planRendering` makes, at the other engine door — a
  // translation reads a CAST of the position's book, and a cast of a position
  // with applied changes on its path is the document those changes are missing
  // from. See `refuseOverEdits`.
  refuseOverEdits(ledger, null);
  const planned = await recordsForTranslation(dir, targetLanguage);
  /*
   * ── WHAT THIS RUN IS ASKED OF, WHICH IS TWO SEPARATE FACTS ────────────────
   *
   * The nearest translate step above the position, if there is one. It decides two
   * things that are not the same thing, and folding them into one flag was wrong
   * in a way worth writing down.
   *
   * `--from` IS ABOUT THE WORDS THE MODEL WILL BE SHOWN, and standing anywhere
   * under a translation those words are that row's. The engine is handed the
   * position's own document — for a records row its CAST, for a row made before
   * records the book that run wrote — and either way what is inside it is that
   * translation's text. So the source language is that row's `params.language`,
   * recorded rather than guessed, and it is said for BOTH kinds of parent. Left
   * out, the model is told to work the language out from the text, which is a
   * needless guess about a fact the ledger is holding.
   *
   * `--source-records` IS ABOUT WHERE THE WORDS COME FROM, and only a records row
   * has such a file. It makes each question about the parent's newest row for that
   * position rather than about the book's own text — which is what makes correcting
   * one English record re-ask exactly the Hungarian blocks that record feeds, and
   * nothing else. A row made before records has no file to point at, and pointing
   * at nothing is not a state the engine admits.
   *
   * SO A PRE-RECORDS PARENT STILL CHAINS, and the chain is honest: the run reads
   * that row's own book and is told which language it is in. What it does not get
   * is the re-ask precision above, because the words it consumed live inside an
   * EPUB rather than in rows a person can correct.
   */
  const parent = translationInEffect(ledger);
  const parentLanguage = parent?.params?.language?.trim() ?? '';
  /*
   * ASKING FOR THE PARENT'S OWN LANGUAGE IS NOT A TRANSLATION AND IS REFUSED HERE
   * AS WELL AS IN THE DIALOG.
   *
   * It would spend hours asking a model to say an English book in English, and file
   * the result as a row that means nothing. The dialog says so before the button
   * (`sameLanguage`) because a refusal met before a press is worth more than the
   * same refusal after one — and main says it too, because a renderer's guard is a
   * courtesy and this one is the rule. The comparison is the same fold on the same
   * pair, so the two cannot come to different answers about what was pressed.
   *
   * REDOING A TRANSLATION IS A DIFFERENT GESTURE and the sentence names it: stand
   * on the step it was made FROM and ask for that language again, which
   * `reRunTarget` resolves to the row that already exists and fills its own file.
   */
  if (parentLanguage.length > 0 && sameTag(parentLanguage, targetLanguage)) {
    throw new ProjectError(
      `“${parent?.label ?? 'That step'}” is already in ${parentLanguage}, so translating it into `
      + `${targetLanguage} would ask the model to say the same thing again. To make that `
      + 'translation afresh, stand on the step it was made from and translate there — that '
      + 'replaces the one you have rather than adding a second.',
    );
  }
  const source = parentLanguage.length > 0 ? parentLanguage : null;
  const sourceRecords = parent === null || source === null ? null : translationRecordsOf(parent);
  /*
   * ── AND THE SEED: WHAT THIS RUN STARTS LIFE HOLDING ───────────────────────
   *
   * A BRANCH IS A SECOND TRANSLATION INTO ONE LANGUAGE FROM A DIFFERENT STEP, and
   * the user's own scenario produces one: translate the reading into English,
   * strike some blocks on the book, apply, then translate THAT save into English.
   * Two rows, two files, one language — which is the branch `translationTarget`
   * mints an `<id8>` for. An EMPTY file there would make the second run a full
   * re-translation of a book that is already translated, when the whole promise of
   * a question-keyed record is that an unchanged block is never asked twice.
   *
   * SO THE SEED IS THE NEWEST OTHER TRANSLATION INTO THIS LANGUAGE, wherever it
   * hangs, and NOT the parent. That distinction is the whole of the fix. The
   * sibling case above is the common one and no walk from the position can reach
   * it: a save made under the READING has the English translation as a SIBLING,
   * off the same reading, and `translationInEffect` correctly refuses to find it —
   * it is not on the path from the import to where that save stands.
   *
   * IT IS SAFE FOR THE PARENT'S OWN REASON: a records row is keyed by the block's
   * own text and remembered by the block's own position, so a sibling's answer
   * about page 12 block 3 is the same true answer about the same paragraph. Struck
   * blocks are simply never looked up, and text edited since asks a new question
   * and gets a new key.
   *
   * NEVER WHEN THIS RUN IS ASKED OF ANOTHER LANGUAGE, which is where the two halves
   * of this paragraph meet. A chain's questions are asked of the PARENT'S words, so
   * a sibling's answers — true as they are about the German — are keyed to
   * questions this run will not ask, and every one of them would be re-asked
   * anyway. Copying a file to gain nothing is a file copied for nothing.
   *
   * THE SEED IS A PATH AND NOT A COPY. It is copied at SPAWN (`pump()`), because a
   * plan is not a commitment: a held job that is removed must leave `readings/`
   * exactly as it found it, and a file seeded here would sit there named by no step,
   * invisible to the sweep, forever. A replace never spends it — its own file is
   * already there, holding its own answers, and the copy is skipped by existence.
   */
  const seed = source !== null ? null : newestRecordsInto(ledger, targetLanguage, planned.records);
  /*
   * SO THE PLAN'S SOURCE IS THE INPUT, VERBATIM, and it stays a field rather than
   * becoming an identity because it is the answer to a different question than it
   * used to be. It was "which copy of this book will the engine read" — a fact
   * about a rotation that no longer happens. It is now "which file did this plan
   * admit", which is what main's allow-list adds and what the queue re-checks
   * (`queue:enqueue-translate`).
   *
   * AND IT IS THE CAST RATHER THAN THE EDITION, which the engine enforces and this
   * app must not be able to get wrong: records mode reads `data-bf-src` off every
   * translatable block and refuses a book that carries none, and `--final`
   * withholds exactly those. What the dialog hands over is the position's own
   * document, which is the cast.
   */
  const sourcePath = inputPath;
  const generation = readingGenerationOf(ledger, manifest);
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    key,
    sourcePath,
    recordsPath: planned.recordsPath,
    stepId: planned.stepId,
    // Two fields, two facts: the language the words are IN, said for any parent
    // translation, and the file they come OUT of, said only for one that keeps its
    // words as records. See the note above them both.
    ...(source !== null ? { from: source } : {}),
    ...(sourceRecords !== null
      ? { sourceRecords: path.join(dir, ...sourceRecords.split('/')) }
      : {}),
    ...(seed !== null ? { seedRecords: path.join(dir, ...seed.split('/')) } : {}),
    /*
     * THE READING THESE ANSWERS ARE ABOUT, carried into every row and interpreted
     * by nobody — `Overlay.generation`'s contract, one folder over. Read off the
     * step rather than minted: this is a plan, and minting a generation is
     * something a LANDING does (`generationForLanding`). A project whose reading
     * predates recorded generations says nothing, which is the honest answer and
     * costs the rows a field they never had.
     */
    ...(generation !== null ? { generation } : {}),
  };
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
function sameTag(one: string, other: string): boolean {
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
function newestRecordsInto(
  ledger: ProjectLedger,
  language: string,
  writing: string,
): string | null {
  let found: string | null = null;
  for (const step of ledger.steps) {
    const said = step.params?.language ?? '';
    if (said.length === 0 || !sameTag(said, language)) continue;
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
 * different bank; a plan that minted one would re-bind every overlay in the project
 * because somebody pressed Translate.
 */
function readingGenerationOf(ledger: ProjectLedger, manifest: ProjectManifest): string | null {
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
