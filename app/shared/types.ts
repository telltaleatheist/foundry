/**
 * The wire shapes — everything that crosses the process boundary, declared once.
 *
 * Compiled by BOTH programs: the main process through tsconfig.electron.json
 * (relative import), the Angular renderer through tsconfig.app.json (the
 * `@shared/*` alias). Nothing in here has a runtime: types only, so neither
 * bundle carries a byte of it and the two sides cannot drift.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The job queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a row in the shelf IS.
 *
 * `epub` is the only thing the engine casts. `env-install` is not a conversion
 * at all — it is the app fetching a prebuilt Python — but it shares the queue on
 * purpose: it is long, it is cancellable, and a conversion that needs the
 * environment must wait BEHIND it rather than race it. One serial queue gives
 * that for free.
 *
 * `translate` is a conversion whose INPUT is an EPUB and whose output is
 * another one. It is not in `ConversionKind` and that is deliberate: a
 * conversion kind doubles as the output's file extension (see below), and a
 * file called `book.translate` is not a thing. Its output is named by
 * `planTranslation` instead, which knows the language tag belongs in the
 * middle. It shares the serial queue for the same reason an install does — it
 * holds a GPU for hours and two at once is two runs that each take twice as
 * long.
 */
/**
 * The five things the queue can be holding.
 *
 * `read` IS THE ONE THAT COSTS ANYTHING, and separating it out is the change the
 * whole front door turned on. A conversion used to be one act: read three
 * hundred pages with a vision model AND write an EPUB, chosen together in one
 * dialog, so asking for the same book as plain text afterwards meant either
 * re-reading it or knowing that `--reuse-readings` existed.
 *
 * They are two acts and they have nothing in common. READING is hours of GPU
 * against pages nobody has seen, it is resumable, it is batched, and its product
 * is the BANK. GENERATING is arithmetic over answers that are already on the
 * disk — seconds, offline, free, and repeatable as often as somebody likes. The
 * queue holds both because both spawn the engine; everything else about them
 * differs, starting with the fact that one waits for a person to press Start and
 * the other must never.
 */
export type JobKind = ConversionKind | 'read' | 'env-install' | 'translate';

/**
 * What the OCR panel can ask for. An env install is never enqueued this way.
 *
 * It is also the engine's `--format`, spelled the same, because it is the same
 * decision: a job's kind IS the extension its output carries, and the two
 * drifting apart would mean the app naming a file `.epub` and the engine
 * writing text into it — which the engine refuses outright (src/vlm/text-out.ts).
 *
 * `pdf` IS a third way of writing the book, and it used not to be. It once
 * produced the source document with an invisible layer over its pages — the
 * scan, made searchable. It now reprints the book as real, visible type on fresh
 * pages the shape of the scan's, at the positions the model measured, and throws
 * the scan's pixels away (src/vlm/pdf-text.ts). What comes out is a
 * born-digital PDF the app opens in the same PDF tab it opens any other, and it
 * is a SECOND document rather than an improvement of the first — which is why
 * the project catalogue gives it a row of its own (`ProjectGeneratedRole`).
 */
export type ConversionKind = 'epub' | 'txt' | 'pdf';

/**
 * Where a job is, and `held` is the one that needed adding.
 *
 * NOTHING EXPENSIVE STARTS BY BEING ENQUEUED. Reading a book is hours of GPU
 * against a file the user picked in a dialog they may well have picked wrong, and
 * the old queue began the first one the instant the dialog closed — so the moment
 * of commitment was the moment of configuring, and building a BATCH was
 * impossible: by the time the second book was chosen the first was already
 * reading. `held` is a job that is configured, ordered, visible and doing
 * nothing, and `queued` means what it always said it meant: waiting for the
 * machine rather than waiting for the person.
 *
 * WHICH IS WHY A RENDERING IS NEVER HELD. It spends no GPU — it is built from a
 * bank that already exists — so there is nothing for a person to commit to, and
 * a hold there would be the mechanism applied to the case it was never about.
 * See `enqueue` in electron/job-queue.ts.
 *
 * `held` is deliberately NOT a terminal state and never becomes one. A held job
 * that is no longer wanted is REMOVED — it never ran, so there is nothing to
 * cancel and nothing to leave a row about (see `queue.remove`).
 */
export type JobState = 'held' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  /** Pages finished. */
  page: number;
  /** Pages in the run — the right-hand side of the engine's own fraction. */
  total: number;
  /**
   * Which pass is counting. The endpoint route rasterises the whole book first
   * (`page 3/317: rendered`) and then reads it, and a bar that did not say
   * which of the two it was tracking would appear to restart halfway.
   *
   * `translate` counts BLOCKS, not pages, which is why the phase has to reach
   * the UI: "412/2,081" means paragraphs and the shelf must not call them
   * pages. The field is still `page` because it is the same quantity to every
   * bar that draws it — a count of finished things out of a known total.
   */
  phase: 'render' | 'read' | 'translate';
}

/**
 * Everything the OCR dialog decides before a job is enqueued.
 *
 * PER-JOB CHOICES ONLY. There is no endpoint field and no backend field: the
 * settings screen owns which backend reads the pages, and a second place to
 * override it was a second place for the two to disagree. There is no output
 * path either — `outputPath` and `readingsPath` come from `workspace.plan`, not
 * from a text box, because a conversion opens in the app when it is done and is
 * copied out on Save As (electron/workspace.ts).
 */
export type JobRequest = ReadRequest | GenerateRequest;

/**
 * READ THE PAGES. `foundry vlm-read --pdf X --readings Y`.
 *
 * THE PRODUCT IS THE BANK and there is no output file at all, which is the whole
 * shape of the change. This job fills `readings/<key>.jsonl` and drops the
 * completion marker beside it, and that is the expensive, irreplaceable thing a
 * project is built on; what a person eventually reads is generated from it
 * afterwards, for nothing, as often as they like.
 *
 * A SEPARATE SHAPE from the generate request rather than more optional fields on
 * one, because nothing they carry is the same field: this has no output, no
 * format and no overlay — a curation cannot exist before the blocks it is about
 * do. It is the pattern `TranslateRequest` already follows, and it is what keeps
 * `argsFor` honest: a request cannot carry a flag the command it becomes does
 * not have.
 */
export interface ReadRequest {
  kind: 'read';
  /** The pixels: `WorkspacePlan.sourcePath`, which is the archived original. */
  inputPath: string;
  /** `--readings`. The product of this job, not an input to it. */
  readingsPath: string;
  /** `--skip-pages`, verbatim: "3,17,19-24". Pages that are not part of the book. */
  skipPages?: string;
  /** `--language`: the BCP-47 tag, declared and never detected. */
  language?: string;
  /**
   * THE STEP THIS BANK BELONGS TO, minted with the path and travelling with it.
   *
   * ── Why a request carries an id for a step that does not exist yet ──────────
   *
   * A branching re-read writes a bank of its own — `readings/<key>.<id8>.jsonl`,
   * where `id8` is the front of the new step's uuid — and the step that lands
   * hours later has to be THAT step, or the file is named after a row nobody ever
   * created. Minting the id at the landing instead would mean composing the path
   * from an id the path could not know, so the id is minted once, in main, at the
   * moment the path is decided (`planReading`), and carried here.
   *
   * SPENT ONLY ON AN APPEND, which is `LandedRun.id`'s own rule and the reason
   * this is safe to mint speculatively: a landing that turns out to be a replace
   * swaps a payload into the step that already exists and throws this away. A
   * replace already had a path to aim at — the target step's own — so the two
   * halves agree in both directions.
   *
   * Optional because a job enqueued by a build that predates this carries none,
   * and the landing mints its own exactly as it always did.
   */
  stepId?: string;
}

/**
 * RENDER THE BOOK. `foundry vlm-convert --reuse-readings --format <kind>`.
 *
 * OFFLINE, AGAINST A BANK THAT IS ALREADY COMPLETE. No model, no server, no GPU
 * and no pages read — the answers exist and this is the pass that turns them into
 * a document. That is why it does not wait for Start: the hold exists so that
 * hours of GPU are never spent by the act of configuring them, and there are no
 * hours here to spend.
 */
export interface GenerateRequest {
  kind: ConversionKind;
  /** The book's pages. Still passed: some renderings measure them. */
  inputPath: string;
  /** From `WorkspacePlan.outputPath`. The managed workspace, always. */
  outputPath: string;
  /** `--readings`, from `WorkspacePlan.readingsPath`. Always passed; see workspace.ts. */
  readingsPath: string;
  /**
   * `--overlay`, from `WorkspacePlan.overlayPath` — the block editor's file of
   * corrections.
   *
   * Optional on the REQUEST and conditional on the command line: a job enqueued
   * before this field existed carries none, and a job that carries one still only
   * gets the flag when the file is on disk when the engine starts. A run told to
   * apply an overlay that is not there is refused by the engine, by name, which
   * would turn "nobody has curated this book" into a failed conversion.
   */
  overlayPath?: string;
  /*
   * NO `--skip-pages` HERE, and its absence is the split doing its work. It is a
   * statement about READING the book — which pages are not part of it — so it is
   * answered once, in the OCR dialog, and is a fact about the bank from then on.
   * A rendering that could be given a different page-skip from the reading it
   * renders would be a rendering of a book that was never read.
   */
  /**
   * `--records` — A TRANSFORM'S WORDS, PUT INTO THE BLOCKS AS THE BOOK IS
   * WRITTEN. The translated book, and the whole of what replaced the two-stage
   * pipeline.
   *
   * ── What this field is instead of ───────────────────────────────────────────
   *
   * A Generate standing under a translation used to be TWO engine runs under one
   * queue row: `vlm-convert` into a nameless EPUB in the OS temp directory, then
   * `translate` reading that file and writing the real one — plus, for an export,
   * a third run to tidy the result into an edition. Every one of those stages
   * existed because the translation was a FILE, and the only way to get a
   * translated book with this position's strikes in it was to make the book, hand
   * it to the translator, and take back whatever came out.
   *
   * A translation is a RECORDS FILE now (`translate --records`): one row per
   * flowing block, keyed by the block's own position in the reading bank. So the
   * translated book is CAST rather than converted — one `vlm-convert` over the
   * same bank, through the same reflow, the same curation, the same chapters and
   * the same edition rules as the source book, with different words in the blocks.
   * Two spawns, one intermediate and one whole class of failure go with the
   * change, and every decision a person has made about the source reaches the
   * translated product for free.
   *
   * RESOLVED AT PLAN TIME like everything else about a Generate (`overlayPath`
   * says why at length): WHICH translation this book is being cast in is the state
   * of the project the user chose when they pressed the button, and a pointer move
   * made while the job waited must not silently produce a different language.
   *
   * Absent for every Generate that is not standing under a translation, which is
   * most of them — and the engine refuses a `--records` file that is not there, by
   * name, so a path is only ever carried when the plan proved one.
   */
  records?: string;
  /**
   * `--language` — the tag the cast declares itself to be in.
   *
   * IT TRAVELS WITH `records` AND ONLY WITH IT. A file of sentences does not
   * declare a language, so `dc:language` and every `xml:lang` in a translated cast
   * come from here; without it the engine writes the book as the language it has
   * always defaulted to, which for a Hungarian translation is a book that lies
   * about itself to every reader that asks.
   */
  language?: string;
  /**
   * `--book` — THE DOCUMENT THIS RUN COMPILES, when the position carries changes
   * a person applied on the proof sheet.
   *
   * ── What it swaps out, which is the whole command ───────────────────────────
   *
   * With it the job is `foundry vlm-compile --book <derived> --out <product>`
   * rather than `foundry vlm-convert --readings <bank> …`. Everything the engine
   * would otherwise work out from the bank is already settled in the file: the
   * struck rows are absent, the words are as the person left them, and the header
   * says where the book divides. The compile replays nothing and decides nothing
   * (docs/RENDERER.md §6), which is precisely why it can be handed a book somebody
   * edited at all.
   *
   * WHOSE FILE IT IS: main's, written at plan time from the position the person
   * was standing on when they pressed the button — the same rule `overlayPath` and
   * `records` obey, and for the same reason. A pointer move made while the job
   * waited in the queue must not silently export a different state of the book
   * than the dialog said it would.
   *
   * SWEPT WHEN THE JOB SETTLES, success or failure. It is derived from a file on
   * disk and a chain in the ledger and costs a read and a replay to make again, so
   * keeping one would be hoarding a copy of a book nobody can name.
   *
   * Absent for every generate, every facsimile and every export of a book nobody
   * has edited — see `WorkspacePlan.bookPath`, which is where it comes from.
   */
  bookPath?: string;
  /**
   * THIS IS ONE STEP'S OWN DOCUMENT — what a `curate`, `translate` or `read`
   * landing makes of itself, named after the step it belongs to.
   *
   * A SAVE'S BOOK is the project's flowing book with that snapshot applied, so
   * standing on an old save shows the book as it was then. A TRANSLATION'S BOOK is
   * the same book with that step's records substituted into the blocks, and it
   * exists for a sharper reason: the run that made the translation wrote per-block
   * answers and no document at all, so without a cast the row would have nothing a
   * pane could show.
   *
   * A READING'S FACSIMILE is the third, and it is the one that is not a book: the
   * scan's own pages reprinted from that reading's answers as real text
   * (docs/RENDERER.md §0 A3). It is TERMINAL — nothing is made from it and there
   * is no place to stand on it — so what it wants from this field is precisely
   * what the other two want: a landing that catalogues nothing. It is drawn as a
   * leaf under the book from a name composed off the same step
   * (`ProjectSummary.facsimiles`), never from what is in `generated/`.
   *
   * ── Why the landing has to be told, when the path already says it ──────────
   *
   * It does not say it. `generated/<stem>.<id8>.epub` is a filename, and working
   * out which row a rendering is about by reading characters out of one is the
   * thing this codebase's oldest house rule forbids — the job knows, so the job
   * hands it over, exactly as a translation hands over its language rather than
   * leaving it legible in a pair of parentheses.
   *
   * WHAT IT CHANGES IS THE LANDING, and it changes it to almost nothing. A
   * per-step cast is a RENDERING of a payload that is already a step: free, made
   * again from that step's snapshot or records at any time, and deliberately NOT
   * catalogued as a document. Two things depend on that. `castBook`
   * (electron/projects.ts) must go on meaning the project's one flowing book — a
   * per-step cast filed as a `generated/` origin would be the newest one, so a read
   * row would start showing whichever save was pressed last, which is precisely the
   * confusion the per-step cast exists to end. And Home's document rows go on
   * listing the documents a person made rather than growing one per Apply.
   *
   * A TRANSLATION'S BOOK IS UNCATALOGUED FOR THE SAME REASON AND AT A PRICE WORTH
   * NAMING: Home's per-type EPUB list no longer holds a row for a translated book,
   * where the old EPUB→EPUB translator's output was filed there as one. The tree
   * draws from the ledger (docs/WORKBENCH.md §6c) and the translate step is in it,
   * which is where a person looks for their translation now.
   *
   * The file is not orphaned by being uncatalogued: the step delete composes the
   * same name and sweeps it (`planStepSweep`).
   */
  forStep?: string;
  /**
   * THIS RENDERING IS TERMINAL — it lands in `final/` and nothing is ever made
   * from it.
   *
   * ── Why one flag rather than a fourth request shape ─────────────────────────
   *
   * An export is the SAME RUN as a Generate in every respect that reaches a
   * command line: the same bank, the same curation, the same `--format`, the same
   * translate stage when the position stands under a translation. `planExport`
   * composes it with `planConversion`'s own machinery and changes exactly one
   * thing — where `outputPath` points. A separate request shape would be four
   * fields copied out of `GenerateRequest` and one place for `argsFor` to forget a
   * flag, which is the argument `ReadRequest` and `TranslateRequest` make in the
   * other direction: they are separate because nothing they carry is the same
   * field, and everything this carries is.
   *
   * WHAT IT CHANGES IS THE LANDING, and that is the whole of it. A Generate's
   * output is an ORIGIN: catalogued on its type's chain, rotated aside rather than
   * replaced, unpacked into a working tree, and — for a translation — a row in the
   * step ledger. An export is none of those. The user's ruling is the reason:
   * "it wont go into the working files as a step because it isnt the base for new
   * steps. its a terminal step. so its an export." So the queue records a
   * `ProjectFinal` row and stops — no documents row, no ledger step, no live-PDF
   * refresh — and the left nav lists it under the project as a thing that was
   * made rather than as a step in the making.
   *
   * Absent rather than `false` for every job this app has ever run, because a
   * flag that is only ever true or missing says what it means at the one place it
   * is read and leaves the ordinary case looking ordinary.
   */
  export?: true;
}

/*
 * `ThenTranslate` USED TO LIVE HERE, and its removal is the shape of this whole
 * change rather than a tidy-up.
 *
 * It described the SECOND SPAWN of a Generate standing under a translation:
 * render the curated book into a nameless EPUB in the OS temp directory, then run
 * `translate` over that file into the row's own one. Five fields travelled with
 * it — the language, the bank, the model, the endpoint, the step it landed under
 * — because the second run was a translation in every sense, with a bank to fill
 * and a row to file.
 *
 * A translation is a RECORDS FILE now (`GenerateRequest.records`), so there is no
 * second spawn to describe: the translated book is one `vlm-convert` with the
 * records substituted into the blocks as it writes. Nothing composes a translate
 * stage inside another job any more, and a shape nothing composes is a shape that
 * quietly grows a field the day somebody adds one to its siblings.
 */

/**
 * Everything the Translate dialog decides before a job is enqueued.
 *
 * A SEPARATE SHAPE from `JobRequest` rather than more optional fields on it,
 * because nothing the two carry is the same field: there is no readings bank
 * (a translation is not resumable — the engine banks nothing), no page skips,
 * no `--format`. Two shapes that share a queue is what `EnvInstallRequest`
 * already is, and it is the pattern that keeps `argsFor` honest — a request
 * cannot carry a flag the command it will become does not have.
 *
 * The endpoint IS here, unlike the conversion request's reading backend. Ollama
 * is not a backend this app owns, starts or configures anywhere else, so there
 * is no settings screen for the dialog to contradict.
 */
export interface TranslateRequest {
  kind: 'translate';
  /**
   * The document the person had open when they asked.
   *
   * IT IS THE JOB'S IDENTITY AND NOT ITS INPUT any more. The engine reads
   * `bookPath` below; this is what main admitted, what the queue re-checks
   * against the same allow-list, and what the settle names in its message. The
   * cast it points at dies in R6 with the rest of §7.
   */
  inputPath: string;
  /**
   * `--book`: THE BOOK THIS RUN TRANSLATES — the position's book file, with every
   * op on the way to it already replayed in by main.
   *
   * ── Why the source stopped being an EPUB ────────────────────────────────────
   *
   * A cast is a RENDERING of the book: the words have to be recovered from the
   * markup they were written into, and every block is named by the `data-bf-src`
   * stamped on it — a coordinate in the reading bank rather than a name for the
   * paragraph. A book file is one row per block with an id that IS its name
   * (docs/BOOK-FILE.md), so the records this run writes are keyed by that id, and
   * the derived book the landing materialises from them keeps the same ids
   * (docs/RENDERER.md §4). Source and translation are then two files that agree
   * about what every paragraph is called, which is what an aligned view is made
   * of and what makes a strike on either side the same op.
   *
   * AND IT IS WHY TRANSLATING AN EDITED BOOK WORKS AT ALL. A struck row is not in
   * a materialised book file, so nothing about a strike crosses the boundary and
   * nothing on the far side has to know what one is. `planTranslation` used to
   * refuse this position outright.
   *
   * SCRATCH, AND THE QUEUE'S TO SWEEP: a uuid in the OS temp directory, made when
   * the button was pressed and remade for nothing whenever it is wanted again
   * (`sweepDerivedBook`).
   */
  bookPath: string;
  /**
   * `--records`: WHERE THE ANSWERS GO, and the whole product of this job.
   *
   * ── The output path that used to be here, and why it is gone ────────────────
   *
   * A translation wrote a SECOND EPUB: same container, same pictures, same page
   * provenance, translated text inside every stamped element. That worked and it
   * was a dead end for everything downstream — striking a paragraph out of it,
   * correcting one sentence, casting it as plain text, translating it again into
   * a third language are all decisions about a BLOCK, and an EPUB has no blocks
   * left to decide about, only markup to re-parse and re-splice.
   *
   * So this run writes `readings/<key>.<tag>[.<id8>].records.jsonl` — one row per
   * flowing block, keyed by the block's own position in the reading bank — and no
   * book at all. The book is CAST from it afterwards, by `vlm-convert --records`,
   * through the same reflow and curation as the source (`GenerateRequest.records`).
   *
   * IT IS THE PRODUCT, WHICH IS WHY IT IS ALSO THE JOB'S IDENTITY. `ReadRequest`
   * has had exactly this shape for as long as reading has been its own job: no
   * output document, one file that IS the expensive thing, and the queue dedupes
   * and reveals on it (`enqueue`). Two translations of one book into one language
   * from one step are one job, and the file they would both write is what says so.
   *
   * AND IT IS ITS OWN BANK. `--bank` is refused beside it by the engine: an
   * unchanged block has an unchanged question, its key is already in the records
   * file, and it is never asked twice. One file to copy onto a branch, one file to
   * sweep with the step, one file for the ledger to name as this step's payload.
   */
  recordsPath: string;
  /** `--to`: the BCP-47 tag to translate INTO. */
  to: string;
  /**
   * `--from`. Absent means the model is told to determine it.
   *
   * COMPOSED BY MAIN FOR A CHAIN, typed by the person otherwise. Translating a
   * translation asks its questions of the PARENT'S words, so the source language
   * is a fact the ledger holds (`params.language` of the parent translate step)
   * rather than a guess the dialog invites — and nothing reads a language out of a
   * records file, because a file of sentences is not a declaration.
   */
  from?: string;
  /*
   * `sourceRecords` USED TO BE HERE — `--source-records`, the chain.
   *
   * The user's own case is unchanged: *"if they click the english translation and
   * then click translate to hungarian, it translates from english to hungarian,
   * thus creating a chain of translations: german to english to hungarian."* What
   * changed is that it needs no flag. The flag existed because the engine read a
   * cast of the SOURCE book and had to be told, per position, to prefer the
   * parent's answer; the book file at a position under a translation IS the
   * parent's answers, materialised (docs/RENDERER.md §4), so the words this run
   * translates are already the parent's and its question keys already hash them.
   * The re-ask precision is the same and now falls out of the file: correcting one
   * English record changes one row of the derived book, which changes one
   * question. The engine refuses `--book` beside `--source-records` by name.
   */
  /**
   * `--generation`: the reading this records file is about, carried into every row
   * and never interpreted by the engine.
   *
   * `Overlay.generation`'s contract exactly, one folder over. It exists so that
   * records made against THIS pass over the pages can be told from records left
   * beside a book that has since been read again — the same defence an overlay has
   * had since amendments could outlive the blocks they name.
   */
  generation?: string;
  /** `--model`: the Ollama model that translates. */
  model: string;
  /** `--ollama`: the server's URL. Used, never started. */
  ollama: string;
  /** `--instructions`: appended to the system prompt verbatim, per book. */
  instructions?: string;
  /**
   * A RECORDS FILE TO COPY OVER `recordsPath` AT SPAWN when `recordsPath` does not
   * exist yet — the answers a branch starts life with.
   *
   * ── Why a branch starts with its parent's answers ───────────────────────────
   *
   * Translating from a save made under a translation branches, and a branch
   * deliberately owns its own file (docs/TRANSLATION-STEPS.md §2) — but an EMPTY
   * one would make that first run a full re-translation of a book that is already
   * translated, when the whole promise of a question-keyed record is that an
   * unchanged block is never asked twice. The keys are hashes of the blocks' own
   * text, so the parent's answers are exactly as true in the branch as they were
   * at home: the stricken blocks are simply never looked up, and only text
   * somebody edited since is re-asked.
   *
   * BOTH DOORS SEED, WHICH THEY DID NOT USED TO. This was composed only by the
   * Generate-under-a-translation path, so a branch ordered from the Translate
   * dialog started empty and paid full model price for a book whose translation
   * was sitting one row up. One rule now, at the one spawn.
   *
   * COPIED AT SPAWN, NOT AT PLAN, because a plan is not a commitment: a held job
   * that is removed must leave `readings/` exactly as it found it, and a file
   * seeded at plan time would sit there named by no step, invisible to the sweep,
   * forever. Absent when the run replaces a translate step that already has its
   * own answers, and `argsFor` never reads it — the engine never knows it happened.
   */
  seedRecords?: string;
  /**
   * THE STEP THIS FILE BELONGS TO, minted with it and travelling with it.
   *
   * Exactly `ReadRequest.stepId`'s arrangement, for exactly its reason: a branching
   * translation writes `readings/<key>.<tag>.<id8>.records.jsonl`, where `id8` is
   * the front of the new step's uuid — so the step that lands hours later has to BE
   * that step, or the file is named after a row nobody ever created. Minting the id
   * at the landing would mean composing the path from an id the path could not know.
   *
   * Spent only on an append (`LandedRun.id`): a landing that turns out to be a
   * replace swaps into the step that already exists and throws this away, and it
   * already had paths to aim at — that step's own.
   *
   * Optional because a job enqueued by a build that predates this carries none.
   */
  stepId?: string;
}

export interface Job {
  id: string;
  inputPath: string;
  outputPath: string;
  kind: JobKind;
  state: JobState;
  progress: JobProgress | null;
  /**
   * What the shelf calls this row. A conversion falls back to the input file's
   * basename; an env install has no file to name itself after and sets this.
   */
  title?: string;
  /**
   * Set on `env-install` rows only: which of the four phases, and how far.
   * Separate from `progress` because pages and megabytes are not the same
   * quantity and a bar that silently changed units mid-run would be a lie.
   */
  envProgress?: EnvInstallProgress | null;
  /** The engine's own words on a failure. Never paraphrased, never an exit code. */
  error?: string;
  /** The last line the engine wrote — the job log, one line deep. */
  message?: string;
  /**
   * The last thing the engine said that was NOT a count, cleared the moment a
   * count arrives. Null while the run is simply progressing.
   *
   * It exists because a bar alone cannot tell working from wedged. A block that
   * draws a sixteen-thousand-character answer takes two minutes, gets rejected,
   * and is asked twice more: six minutes in which the count does not move and
   * the engine is talking the whole time. The shelf showed a frozen fraction,
   * which is what a hung job looks like — and a person watching a job they
   * believe is hung kills it, which is how an hour of GPU gets thrown away by
   * the progress display.
   *
   * CLEARED BY THE NEXT COUNT, and that is what makes it mean "since". A note
   * that lingered would still be on screen ten blocks later, which is the same
   * lie in the other direction.
   */
  note?: string | null;
  /**
   * The step this job's product will be recorded as being made FROM — the
   * project's position pointer, CAPTURED AT ENQUEUE.
   *
   * ── Why it is captured here and not read when the run lands ─────────────────
   *
   * Moving the pointer is free, instant and unconfirmed: it is a repaint, and
   * people do it while they wait. A job sits held in the shelf for as long as it
   * takes somebody to assemble a batch, and then runs for three hours. Reading
   * the position at either end of that would file the run against whichever row
   * the user happened to be looking at when it finished — so queueing a
   * translation from the reading, then clicking back through the history to
   * compare two saves, would silently produce a translation of a save.
   *
   * The user's commitment is the press. This is the state of the project at the
   * moment of it, and it is what the landing appends against.
   *
   * NULL for a job in a project whose ledger has no steps to point at, and absent
   * on an `env-install`, which is not about a book at all.
   */
  parentStep?: string | null;
  /**
   * THIS ROW IS ONE STEP'S OWN BOOK — see `GenerateRequest.forStep`, which is
   * where it comes from and where the whole argument lives.
   *
   * ── Why the SHELF has to be able to tell, and not only the landing ─────────
   *
   * Because a finished `epub` job OPENS ITSELF (`OPENS_ITSELF`, TabsService), and
   * that rule was written about the two `epub` jobs that existed: a Generate and
   * the cast after a reading, both of which somebody asked for and wants to look
   * at. A per-step cast is neither. A save's is made by pressing Apply — a gesture
   * whose whole point is to keep working — and the book it produces is the one
   * already on screen, frozen; a translation's is made by the landing of the
   * translation itself, and the position has already moved onto that row, so the
   * pane is about to show it anyway. Opening a tab for either would put a pane in
   * front of somebody who did not ask for one.
   *
   * The renderer therefore needs the fact on the ROW, because the row is all it
   * has: `kind` says `epub` for all three, and the only other thing that differs
   * is a filename, which is not a thing this app reads facts out of.
   */
  forStep?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// `foundry doctor --json` — the engine's contract, version 1
// ─────────────────────────────────────────────────────────────────────────────

export type TierId = 'endpoint' | 'wsl-vllm' | 'mlx' | 'native';

export interface TierReport {
  id: TierId;
  available: boolean;
  detail: string;
}

export interface DoctorReport {
  version: number;
  platform: string;
  /** PyMuPDF — every run needs it, on every tier, so it is reported beside them. */
  rasteriser: { available: boolean; python: string | null; detail: string };
  tiers: TierReport[];
  /** The tier a run would use, or null with the reason in that tier's detail. */
  chosen: TierId | null;
  /**
   * WSL itself, separate from the `wsl-vllm` TIER: "WSL exists but nothing in
   * it can import vllm" is the state the setup screen exists for, and the tier
   * alone cannot tell it apart from "there is no WSL". OPTIONAL — engine builds
   * that predate it simply do not carry it, and the app falls back to asking
   * wsl.exe itself.
   */
  wsl?: { available: boolean; distros: string[] };
}

/**
 * A doctor run, including the ways it can legitimately have no report.
 *
 * `ok: false` is not an error state of the app — an engine build that predates
 * `doctor`, or one that is not installed, is a thing the settings screen says
 * rather than a thing it crashes on.
 */
export type DoctorResult =
  | { ok: true; report: DoctorReport }
  | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// settings.json — the ENGINE owns this schema (foundry src/backend/settings.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type BackendMode = 'auto' | 'endpoint' | 'mlx';

/**
 * The keys this app knows how to edit. Still a SUBSET of what the engine reads
 * (`endpointModel` is also legal): the writer preserves every key it does not
 * recognise, so a newer engine's settings survive an older app saving over them.
 *
 * `wslDistro` and `vllmPython` are written by the SETUP RUNNER rather than
 * typed into a field — they are the two facts that make an environment this app
 * built findable by the engine, and the settings form leaves them undefined so
 * saving a URL never clears them.
 */
export interface BackendSettingsPatch {
  mode?: BackendMode;
  endpointUrl?: string;
  python?: string;
  /** The WSL distro the vLLM environment lives in. */
  wslDistro?: string;
  /** The interpreter INSIDE that distro that can import vllm. Tilde-form is fine. */
  vllmPython?: string;
}

export interface SettingsView {
  /** Where the file lives, so the screen can name it. */
  path: string;
  backend: BackendSettingsPatch;
  /** Set when the file exists but could not be read or parsed. */
  problem?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// WSL — the facts, the setup run, and the server
// ─────────────────────────────────────────────────────────────────────────────

export interface WslFacts {
  /** True only when wsl.exe ran AND named at least one distro. */
  available: boolean;
  distros: string[];
  /** Why not. Printed verbatim: "not on PATH" and "installed but empty" differ. */
  reason: string | null;
}

/** What a distro can build an environment with. Both routes always reported. */
export interface EnvTooling {
  /** Path to a conda binary inside the distro, tilde-form, or null. */
  conda: string | null;
  /** True when that distro's python3 can import venv. */
  venv: boolean;
  detail: string;
}

/** Which way the environment gets built. The user picks; nothing falls back. */
export type SetupRoute = 'conda' | 'venv';

export interface SetupRequest {
  distro: string;
  route: SetupRoute;
}

/**
 * One line out of a setup run. `step` is this app talking (the command about to
 * run, what was skipped); `stdout`/`stderr` are the guest's, verbatim.
 */
export interface SetupLogEvent {
  stream: 'step' | 'stdout' | 'stderr';
  line: string;
}

export interface SetupResult {
  ok: boolean;
  /** The interpreter that now exists, when there is one. */
  pythonPath: string | null;
  detail: string;
}

export type ServerState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface ServerStatus {
  state: ServerState;
  /** On a failure this carries the guest's log tail. Never paraphrased. */
  detail: string;
  url: string;
  model: string;
  /** True when the port was already answering: used as-is, never stopped. */
  external: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prebuilt Python environments — electron/env-catalog.ts owns the numbers
// ─────────────────────────────────────────────────────────────────────────────

/** One environment on the release. Not a platform: `wsl-x64` is driven from win32. */
export type EnvTarget = 'windows-x64' | 'wsl-x64' | 'mac-arm64';

/**
 * The four things an install does, in order. Only `download` has a meaningful
 * percentage — the other three are a bar the UI draws as indeterminate rather
 * than a number invented to keep it moving.
 */
export type EnvPhase = 'download' | 'verify' | 'unpack' | 'configure';

export interface EnvInstallProgress {
  target: EnvTarget;
  phase: EnvPhase;
  /** 0–100 during `download`. Meaningless in the other phases; read `detail`. */
  percent: number;
  /** The sentence on screen. Bytes, the part being fetched, files unpacked. */
  detail: string;
}

/** A catalog row as the settings card sees it: the fixed facts plus this machine's. */
export interface EnvCatalogItem {
  target: EnvTarget;
  label: string;
  purpose: string;
  pythonVersion: string;
  packages: string[];
  /** The reassembled download size, or null when the entry is not published. */
  bytes: number | null;
  /** How many release assets it arrives in. 1 means it was uploaded whole. */
  partCount: number;
  /**
   * False when the catalog has no sha256 for it. The card says "not yet
   * published" and disables Install — never downloads it unverified.
   */
  published: boolean;
  /** Where it goes by default. A WSL target names a path inside the distro. */
  defaultDest: string;
  /** True when the environment lives in WSL, so there is no directory picker. */
  inWsl: boolean;
  /** The interpreter, when one is actually on disk. Null when it is not installed. */
  installedPath: string | null;
  /** True when settings.json already points the engine at that interpreter. */
  configured: boolean;
  /** One sentence about THIS machine — installed where, or why it could not be checked. */
  detail: string;
}

export interface EnvInstallRequest {
  target: EnvTarget;
  /** Overrides the default location. Meaningless for a WSL target; ignored there. */
  dest?: string;
  /** Which distro to extract into. WSL target only. */
  distro?: string;
}

export interface EnvInstallResult {
  ok: boolean;
  /** The interpreter that now exists, when there is one. */
  pythonPath: string | null;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Which engine is actually being driven
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineInfo {
  /** The program spawned, and its fixed leading arguments. */
  command: string;
  args: string[];
  /** Why this one — "FOUNDRY_BIN", "packaged binary", "dev checkout". */
  source: string;
  /** `foundry --version`, or null when it could not be asked. */
  version: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The managed workspace — electron/projects.ts owns the naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where one conversion writes, decided by main and never typed by a user.
 *
 * Both paths land inside ONE PROJECT — `<libraryDir>/projects/<key>/` — whose
 * key is derived from the source document's CONTENT, so the same book always
 * lands in the same folder and resumes against the same bank of answers however
 * it was named or wherever it was dragged from.
 */
export interface WorkspacePlan {
  /** `<basename>-<8 hex>` — the project's directory name and the bank's stem. */
  key: string;
  /**
   * `<libraryDir>/projects/<key>/archive/<the file as imported>` — THE PIXELS.
   *
   * WHAT THE ENGINE READS, AND NOT WHAT THE USER POINTED AT. A conversion reads
   * a book's PAGES, and the pages live in the scan the project was made from —
   * which is in `archive/`, which nothing in this app ever writes.
   *
   * The user points at "the PDF", meaning the one this app shows them, and after
   * a real-text conversion that document has no pixels in it at all: it is type
   * on blank paper. Converting THAT would read a reprint of a reading. So the
   * app resolves the source itself, every time, and the person asking never has
   * to know which of the copies on disk is the one with the ink in it.
   *
   * It is also what makes a self-overwrite impossible by construction rather
   * than by refusal: the input is always under `archive/` and the output never
   * is, so the two paths cannot be equal and there is nothing left to check.
   */
  sourcePath: string;
  /**
   * `<libraryDir>/projects/<key>/generated/<the book's name>.<ext>`.
   *
   * The GENERATED layer, because what the engine writes is an origin: it is the
   * record of what the model read, it is never written again, and the copy the
   * user edits is unpacked or copied from it.
   *
   * A TWO-STAGE GENERATE WRITES THE TRANSLATION'S OWN NAME — `<book> (hu).epub`,
   * or a branch's `<book> (hu).<id8>.epub` — because the product of standing on a
   * translation and pressing Generate IS that translation, made again. The name
   * comes from `translationTarget` rather than from the book and the format, so
   * the file this writes and the row it lands in are one decision.
   */
  outputPath: string;
  /**
   * `<libraryDir>/projects/<key>/readings/<key>.jsonl`.
   *
   * THE PRODUCT OF A READ AND AN INPUT TO EVERY GENERATE. Passed on every job of
   * either kind, and keyed by the BOOK rather than by any format, which is what
   * makes generating the same book as EPUB and as text two renderings of one
   * reading instead of two readings.
   */
  readingsPath: string;
  /**
   * `<libraryDir>/projects/<key>/overlays/<key>.json` — the curation, if there is
   * one.
   *
   * ALWAYS DERIVED, PASSED ONLY WHEN THE FILE EXISTS (see job-queue's `argsFor`).
   * The path is a fact about the project and can be composed the moment the plan
   * is made; whether there is a file at it is a fact about the moment the engine
   * starts, which is hours later for a queued batch and may be after somebody has
   * spent the wait striking two hundred running heads.
   */
  overlayPath: string;
  /**
   * The translation's own words, when the position stands under a translation —
   * carried onto the request by whoever enqueues, and absent for every other
   * rendering.
   *
   * The dialog copies it rather than composing it: WHICH translation a button
   * press is about is main's decision, taken from a ledger the renderer holds only
   * a mirror of (`renderPipeline`, shared/pipeline.ts). See
   * `GenerateRequest.records`, which is where this goes and where the argument is.
   */
  records?: string;
  /** The tag that cast declares itself to be in. Travels with `records`, always. */
  language?: string;
  /**
   * THE BOOK WITH THIS POSITION'S CHANGES ALREADY IN IT — a derived book file,
   * written when the plan was made, and the whole of what an export over an edited
   * book is.
   *
   * ── Why the plan carries a file rather than a flag ──────────────────────────
   *
   * The engine compiles a book out of pages and a curation and has never heard of
   * the op grammar; the changes a person makes on the proof sheet are ops in the
   * ledger, and the document they describe is the reading's book file with those
   * ops replayed over it. That replay lives in one place — `shared/ops.ts`, in
   * main's own process, because the renderer draws from it too — so main
   * MATERIALISES the answer as a book file and the engine compiles THAT
   * (docs/RENDERER.md §6). What crosses the process boundary is a document, not a
   * decision.
   *
   * ABSENT IS THE ORDINARY EXPORT, and it means exactly what it says: this
   * position has no applied changes on the way to it, so the reading's own pages
   * are the book and `vlm-convert` compiles them as it always has. Absent is also
   * every facsimile, which is the RAW bank reprinted page for page and is a record
   * of the reading rather than of any state of the book downstream of it.
   *
   * IT IS SCRATCH. Nothing catalogues it, nothing opens it twice, and the queue
   * removes it when the job settles either way.
   */
  bookPath?: string;
}

/**
 * What an OCR job needs, which is a shorter answer than a rendering's.
 *
 * NO OUTPUT PATH, because there is no output: the bank is the product. And no
 * rotation either — `planConversion` moves the previous `generated/` file aside
 * before a rendering overwrites it, and a reading writes nothing there to
 * collide with. What the engine does about a bank that already exists is the
 * engine's own rule (resume, or archive and re-read) and this app has never had
 * a flag that could second-guess it.
 */
export interface ReadingPlan {
  key: string;
  /** The pixels — `archive/`, which nothing in this app ever writes. */
  sourcePath: string;
  /**
   * The bank THIS reading fills, which is no longer one path per project.
   *
   * `readings/<key>.jsonl` for the first read of a book and for every re-read that
   * asks the same question — a replace, aimed at the step it will swap into. A
   * re-read asking a DIFFERENT question branches, and a branch gets a bank of its
   * own (`readings/<key>.<id8>.jsonl`) so that the older row goes on naming the
   * reading it is actually about.
   */
  readingsPath: string;
  /**
   * The step the path above belongs to — see `ReadRequest.stepId`, which is where
   * it is going. Decided in the same breath as the path, because the two are one
   * decision: which reading is this, the one that exists or a new one?
   */
  stepId: string;
}

/**
 * What a TRANSLATION job needs, which is a different answer again.
 *
 * A NAMED SHAPE RATHER THAN AN INLINE OBJECT AT EACH END, and it earned that the
 * day it grew a fourth field: main composes it, the preload passes it, the api
 * declares it and the dialog reads it, and a shape spelled four times is a shape
 * that grows a field in three of them. `ReadingPlan` is the same arrangement for
 * the same reason.
 */
export interface TranslationPlan {
  key: string;
  /**
   * The document the person had open when they asked — how main resolved the
   * project, and what the allow-list is about. NOT what the engine reads: see
   * `bookPath`.
   */
  sourcePath: string;
  /**
   * THE BOOK THE ENGINE TRANSLATES — the position's book file with its whole
   * chain replayed into it, written into the OS temp directory at plan time
   * (`planTranslation`, electron/workspace.ts).
   *
   * A struck row is not in it, a retyped paragraph is in it as the person left
   * it, and under a translation it is that translation's derived book — so a
   * chain's source words are the parent's without a second file being named. The
   * records this run writes are keyed by the ROWS' OWN IDS, which is what lets
   * the landing materialise a derived book in the target language with those same
   * ids (docs/RENDERER.md §4).
   */
  bookPath: string;
  /**
   * The per-block answers this run writes, and the whole of what it produces:
   * `readings/<key>.<tag>.records.jsonl` for the first translation into a
   * language, `readings/<key>.<tag>.<id8>.records.jsonl` for a second one made
   * from a different step — the branch the user's own scenario (translate, strike,
   * commit, translate again) produces, and which used to write both editions into
   * one filename.
   *
   * THERE IS NO OUTPUT EPUB TO NAME any more; the book is cast from this file
   * afterwards. See `TranslateRequest.recordsPath`.
   */
  recordsPath: string;
  /*
   * `sourceRecords` USED TO BE HERE and is gone with the flag it carried. A chain
   * needed to be told where the parent's words were while the engine read a CAST
   * of the SOURCE book; the book file at a position under a translation IS the
   * parent's words, so the question is answered by the file rather than by a
   * second path (`planTranslation`, and the engine refuses the pair by name).
   */
  /**
   * `--from` for a chain: the language the parent translation is IN.
   *
   * The dialog's own From field answers this for a translation made straight from
   * the book, and is not offered when the source is a standing translation — the
   * ledger already knows what language that row is, and inviting somebody to
   * disagree with it would put "German → Hungarian" on a prompt holding English.
   */
  from?: string;
  /**
   * The records a BRANCH starts life as a copy of — see
   * `TranslateRequest.seedRecords`, which is where this goes and where the whole
   * argument lives.
   *
   * Composed by main because it is the same question the chain is: which row is
   * above this one. Absent when the run replaces a translation that already has
   * its own answers, and absent for the first translation of a book.
   */
  seedRecords?: string;
  /**
   * The reading generation these records are bound to — `--generation`, written
   * into every row and interpreted by nobody. Absent for a project whose reading
   * predates recorded generations.
   */
  generation?: string;
  /**
   * The step the records file belongs to — see `TranslateRequest.stepId`. Decided
   * in the same breath as the path, because it is the same decision: is this
   * translation the one that already exists, or a new one beside it?
   */
  stepId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects — one folder per book, in FOUR LAYERS. electron/projects.ts owns it
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Every document in a project exists twice: an ORIGIN that is never written, and
 * a LIVE COPY that is what the user means when they say "the PDF" or "the EPUB".
 * The origin is what makes stepping back — or starting over — possible at all.
 *
 *   archive/    the imported originals. Some of these are very old documents and
 *               the imported file may be the only copy of that scan that will
 *               ever exist. Never written.
 *   generated/  the model's cast EPUB, or the EPUB the user imported. Sacrosanct
 *               on its own argument: it is the single record of what the model
 *               actually read, every curation decision is measured against it,
 *               and "start over" means rebuilding `working/` from it.
 *   working/    what the user edits — the unpacked EPUB tree, and the live PDF.
 *   final/      what Save and Export produce, named for the project.
 *
 * NONE OF THESE NAMES EVER REACHES A PERSON. The user sees one document per
 * kind — `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf` and the matching
 * `.epub` — as a single unit, and the layer a given row happens to resolve to is
 * this app's bookkeeping.
 */

/**
 * What one file in `generated/` IS, as opposed to what format it is written in.
 *
 * The pair is not redundant: `cast`, `imported` and `translation` are all
 * `.epub`, and `searchable` is a `.pdf` — the book reprinted as real text at the
 * positions it was printed at, rather than the EPUB's reflowed chapters.
 *
 * THE NAME IS OLDER THAN WHAT IT NAMES. `searchable` was written when this
 * conversion laid an invisible layer over the scan and the only thing it changed
 * was whether the file answered to a search. It now produces a different
 * document entirely, and the token is kept anyway: it is written into every
 * `project.json` on every user's disk, renaming it would orphan those rows, and
 * what it still says about the file — that this is the PDF you can search — is
 * true and more true than it was.
 */
export type ProjectGeneratedRole = 'cast' | 'imported' | 'translation' | 'searchable' | 'text';

/** The three extensions a project holds. `txt` is listed but never opened here. */
export type ProjectDocumentKind = 'pdf' | 'epub' | 'txt';

/**
 * The import, copied into `archive/` and never written again.
 *
 * NULLABLE, because a project adopted from a flat workspace directory has files
 * the engine made and no import at all — the conversion that made them ran
 * before projects existed, and inventing an original would be a guess.
 */
export interface ProjectArchive {
  /** The name inside `archive/`. A NAME, never a path: the folder is implied. */
  file: string;
  kind: 'pdf' | 'epub';
  /** The 8 hex characters the project key ends in — the content hash. */
  contentKey: string;
  /**
   * Where it was copied FROM, recorded and never read back to find the file.
   * A user's folder of scans moves; the copy in `archive/` does not.
   */
  originPath: string | null;
}

/** One origin the engine produced, or the EPUB the user imported. */
export interface ProjectGenerated {
  /** The name inside `generated/`. */
  file: string;
  kind: ProjectDocumentKind;
  role: ProjectGeneratedRole;
  madeAt: number;
}

/**
 * One unpacked book under `working/`, and the ORDER its members go back in.
 *
 * The order is the whole reason this is written down. A repack that lost it
 * produces an EPUB with `mimetype` somewhere in the middle, which some readers
 * open and others silently reject — and the order used to survive only in
 * memory, from the unzip that created the tree. A tree that outlives the process
 * has to carry it on disk.
 */
export interface ProjectWorkingTree {
  /** The archive it was unpacked from, project-relative: `generated/x.epub`. */
  from: string;
  /** The directory under `working/` holding it. */
  dir: string;
  /** Every member, in archive order, `mimetype` first. */
  members: string[];
  unpackedAt: number;
  /**
   * WHICH LIFE OF THIS WORKING COPY THIS IS — a fresh uuid every time the tree
   * is unpacked, and the one field in this catalogue that exists for a file the
   * catalogue does not otherwise mention.
   *
   * The undo ledger on disk (electron/history.ts) records rows that name
   * `data-bf-id="p47-3"` in a member. THAT NAME IS ONLY MEANINGFUL FOR THE
   * WORKING COPY IT WAS RECORDED AGAINST. Start over rebuilds `working/` from
   * `generated/`, a re-cast reassigns ids, and a row from a previous life would
   * then put a paragraph into a block that is not the one it came from — the
   * one failure mode worse than having no undo at all, because it looks like it
   * worked. So the history file carries the generation it was written under, and
   * a history whose generation is not this one is archived aside rather than
   * replayed.
   *
   * Empty for a tree recorded before this field existed; `treeGeneration` mints
   * one on first use, which is safe precisely because no history file can name a
   * generation that was never written.
   */
  generation: string;
}

/**
 * The live PDF — the one the user sees, and the one metadata edits will land in.
 *
 * A copy is made at import so the file EXISTS from the start; writing to it is
 * not implemented yet, and this is the file that will be written when it is.
 * It is the SCAN and stays the scan: a conversion produces a document of its
 * own and never replaces this one (`recordGenerated`). The one exception is a
 * project adopted from the old flat layout, whose `generated/` PDF really was
 * the scan with a layer over it.
 */
export interface ProjectWorkingFile {
  /** The name inside `working/`. */
  file: string;
  kind: 'pdf';
  /** Where it was copied from: `archive/x.pdf` or `generated/x.pdf`. */
  from: string;
  madeAt: number;
}

/** One file the user filed, inside the project's own `final/`. */
export interface ProjectFinal {
  file: string;
  kind: ProjectDocumentKind;
  madeAt: number;
}

/**
 * One reading's page-for-page reprint, in `generated/`. See
 * `ProjectSummary.facsimiles`, which is the only thing that carries these and
 * where the whole argument for the shape lives.
 *
 * NO `kind`, unlike the row above it. A facsimile is a PDF and can be nothing
 * else — it is the scan's own pages, set back as type — so a field saying so
 * would be a fact the type system already knows, offered to a reader as though
 * it might one day say something different.
 */
export interface ProjectFacsimile {
  /** Project-relative, forward slashes: `generated/<book> (facsimile).<id8>.pdf`. */
  file: string;
  /** The read step's own moment — see `ProjectSummary.facsimiles`. */
  madeAt: number;
}

/**
 * `project.json` — a CATALOGUE, not a store.
 *
 * BookForge put editor state in its manifest and measured 146.6 MB of 148 MB of
 * manifest content being re-parsed on every library load. Nothing that grows
 * without bound goes in here: no per-block state, no history, no page text. The
 * member list is the one long field and it is bounded by the book's own file
 * count (a few hundred), not by how much anybody edits.
 */
/** One file type's whole record on disk: its chain, newest last. */
export interface ProjectTypeRecord {
  kind: ProjectDocumentKind;
  /** Never empty — a type with no origin is not a type this project has. */
  steps: ProjectStep[];
}

export interface ProjectManifest {
  /**
   * 2. Bumped only when a reader of an older file would get it wrong.
   *
   * VERSION 2 REPLACED `generated` WITH `documents`. A v1 catalogue listed the
   * files this app had made, each with a role; a v2 one lists the file TYPES the
   * project has, each with the chain of files behind it. A v1 reader handed a v2
   * file would find no `generated` array and conclude nothing had ever been made
   * from the book — which is why this number moved. `readManifest` migrates v1
   * in memory on every read (`migrateToSteps`), so an old project opens without
   * ceremony and is rewritten in the new shape the next time anything edits it.
   */
  version: number;
  /** `<slug>-<8 hex>`, and the directory's own name. */
  key: string;
  /** The display name — the book's `dc:title` once anything has read one. */
  title: string;
  /**
   * The base filename every document in this project shares.
   *
   * `Working Towards The Fuhrer. Kershaw, Ian. (1993)` — taken from the import,
   * unslugged, so the PDF and the EPUB read as one document with two extensions.
   * The SLUG is for the directory and nothing else.
   */
  stem: string;
  createdAt: number;
  archive: ProjectArchive | null;
  /**
   * One record per file type this project has — the PDF, the EPUB, the text.
   *
   * Replaced `generated: ProjectGenerated[]`, which was one entry per file this
   * app had written. That shape could not answer the question the app is now
   * built around ("what types does this book have, and what has been done to
   * each?") without the caller reconstructing it from roles, and two callers
   * reconstructing it differently is how the same project came to be drawn as
   * two rows on Home and one in the picker.
   */
  documents: ProjectTypeRecord[];
  working: {
    trees: ProjectWorkingTree[];
    files: ProjectWorkingFile[];
  };
  final: ProjectFinal[];
  /**
   * Which reading of this book the block editor's corrections are about, or null
   * for a project nobody has corrected yet.
   *
   * See `ProjectReading`. Null is the ordinary state and is not a hole in the
   * catalogue: it is minted the first time anybody amends a block, because before
   * that there is nothing for a generation to bind.
   */
  reading: ProjectReading | null;
  /**
   * The step ledger — every retained payload this project holds, and the pointer.
   *
   * OPTIONAL, AND A MANIFEST WITHOUT ONE IS NOT A BROKEN MANIFEST. Every project
   * on every disk predates this field, and `migrateLedger` (shared/ledger.ts)
   * builds one from `archive`, `reading` and the per-type chains on read. So
   * absent means "not migrated yet", which is the ordinary state of the whole
   * library the first time this ships, and not a hole to refuse.
   *
   * THE LEDGER IS THE TRUTH AND `documents` IS A VIEW OF IT. Both are written,
   * and they must never be two opinions: the per-type rows are derived from the
   * ledger (`currentStandard`), which is the arrangement that keeps "the PDF" and
   * "what was actually done to this book" from disagreeing.
   */
  ledger?: ProjectLedger;
}

/**
 * The identity of a READING — the model's pass over the pages — so that a file of
 * corrections can say which one it is about.
 *
 * ── The hazard, which is why this exists at all ─────────────────────────────
 *
 * An overlay names blocks as `(page, order, part)`: the page, the element's place
 * in the model's answer for that page, and the piece of it a split cut out. Those
 * numbers are stable across every RE-RENDER of a bank, which is the whole reason
 * the scheme works — the answers are replayed verbatim and the split is
 * deterministic over them. They are not stable across a RE-READ. The engine
 * archives a completed bank and reads every page again, the model answers
 * differently, and `{"page": 7, "order": 14}` afterwards is whatever the new pass
 * happened to answer fourteenth. Amendments from the previous life would then
 * strike a different block and split the book in a different place, with nothing
 * on screen saying anything had happened. That is the failure this app spends its
 * refusals avoiding, and it is exactly the one `ProjectWorkingTree.generation`
 * guards for a book's undo history.
 *
 * ── Why a READING mints one and a rendering does not ────────────────────────
 *
 * The obvious design mints a uuid when any conversion finishes. It is wrong in
 * one ordinary case and the case is common: converting a book to plain text
 * after curating its EPUB runs the engine again, records another step, and
 * replays the SAME bank — every block identical, every amendment still exactly
 * about the block it was made about. A generation minted per job would throw
 * that curation aside and tell the user their corrections had been archived, for
 * a run that changed nothing.
 *
 * So a generation is minted by a READING LANDING and by nothing else, which is
 * exactly the event that renumbers the blocks. The authority is the read step's
 * own `params.generation` (`LedgerParams.generation`) and the one a viewer
 * compares against is the POSITION'S — the nearest read step on the ancestry, so
 * two branches of a book compare their overlays against their own pass over the
 * pages. `readingGeneration` (electron/projects.ts) is where that is asked; this
 * record is what answers for a project whose ledger holds no read step at all.
 *
 * ── It used to count archive folders, and both legs were knocked out ────────
 *
 * `passes` was how many banks the `readings/archived-<stamp>/` folders held when
 * the generation was minted, on the reading that the engine archived a completed
 * bank before reading it again — so a re-read incremented the count and a
 * re-render did not. That was always a proxy, and two changes landed together
 * that made it a false one: a re-read now writes a PENDING bank and swaps it in
 * on success (docs/BANK-LIFECYCLE.md §2), so nothing archives and the count
 * never moves; and a re-read asking for a different page range BRANCHES to a
 * bank of its own, which never archived anything either. Both would have kept
 * the old generation over renumbered blocks — the exact silent misapplication
 * this whole record exists to prevent.
 */
export interface ProjectReading {
  /** The uuid the overlay file and its undo ledger both carry. */
  generation: string;
  /**
   * DEAD, AND KEPT SO AN OLD CATALOGUE IS NOT REFUSED. It counted the archived
   * banks under `readings/` when the generation was minted; nothing archives a
   * bank any more (see above), nothing reads this, and nothing writes a new one.
   * A catalogue that carries one parses exactly as it did and the field drops
   * out the next time anything edits the project.
   */
  passes?: number;
  /**
   * The engine's completion marker for this bank when this generation was
   * minted or adopted — `completedAt` parsed to epoch milliseconds — or absent
   * when there was no marker to record.
   *
   * THE HONEST SUCCESSOR TO "THE FOLDER COUNT MOVED". A bank can be replaced
   * without this app watching: `foundry vlm-read` from a terminal reads the
   * pages again and swaps a new bank into the same path, and every block is
   * renumbered with nothing in the catalogue changed. What DOES change is the
   * marker beside the bank, so the stamp is recorded next to the generation and
   * a stamp that disagrees with the disk is a reading this app did not see.
   *
   * ABSENT IS SAFE AND IS WHY IT IS OPTIONAL. A record with no stamp is one
   * minted before there was a marker — a generation minted while the first OCR
   * was still running is the ordinary case — and the answer to a marker
   * appearing where none was recorded is to ADOPT it, never to re-mint: the
   * pages already read keep their numbers when a run resumes into the same bank,
   * and an overlay made against them survives the run finishing.
   *
   * PER-STEP, WHEREVER THERE IS A STEP. This is the project-wide copy and it
   * answers only for a project whose ledger holds no read step; a step carries
   * its own (`LedgerParams.completedAt`), because a branch has its own bank and
   * its own marker and one field could not describe both.
   */
  completedAt?: number;
  /**
   * When a reading of this book COMPLETED, or 0 for one that never has.
   *
   * THE FACT THE WHOLE FRONT DOOR TURNS ON. A project with a PDF and no reading
   * is a project whose next step is known — and the app says so, on its row,
   * lit, until it is done. Written by `recordReading` when the OCR job lands,
   * which is the only moment anything can honestly claim a bank is finished.
   *
   * It is not the only evidence and it is not allowed to be: a bank filled by a
   * `foundry vlm-read` run from a terminal is just as complete and this app
   * never saw it happen. The engine's own completion marker beside the bank is
   * the other half, and `summarise` accepts either.
   */
  readAt: number;
  /** Page answers in the bank when it completed. For the row's own sentence. */
  pages: number;
}

/**
 * How one step in a file type's history came about.
 *
 * `origin` is step 0 and every type has exactly one: the file as it was when it
 * became unchangeable. For the PDF that is the import; for the EPUB it is the
 * cast (or the import, when the project started from a book); for the text it is
 * the moment it was generated.
 *
 * `edit` IS DECLARED AND NOTHING MINTS ONE YET, which is deliberate rather than
 * an oversight. Editing a book is continuous — a hundred keystrokes are not a
 * hundred steps — so it lands in the working copy, and the working copy is the
 * material of whatever the last step produced. A step is a DISCRETE APPLIED
 * OPERATION, the kind with a name you could put on a button. When something in
 * this app applies one of those to a book's text, it mints this.
 */
export type ProjectStepKind = 'origin' | 'convert' | 'translate' | 'edit';

/**
 * One point in the life of one file type — what it was, after what was done.
 *
 * THE CHAIN IS THE FEATURE. A project's PDF is not a file, it is a sequence: the
 * scan as imported, then the same book reprinted as real text. Keeping the
 * sequence rather than only the newest is what lets somebody compare two of
 * them, export an earlier one, or step back to where they started — and it costs
 * nothing to keep, because every one of these files is on disk already. What was
 * missing was the record of which file was which and what had been done to it.
 */
export interface ProjectStep {
  /** Project-relative, forward slashes: `archive/x.pdf`, `generated/x.epub`. */
  file: string;
  /**
   * What was applied, in words a person would recognise.
   *
   * "The scan you imported", "Reprinted as real text", "Translated into English".
   * Never a path and never a role name: this is the only part of a project's
   * bookkeeping the user is meant to read.
   */
  label: string;
  appliedAt: number;
  kind: ProjectStepKind;
  /**
   * WHAT IT WOULD COST TO GET THIS BACK — the field the whole store turns on.
   *
   * THREE STATES AND NOT A BOOLEAN, and the third one was learned the hard way.
   * A first version of this asked only "is it expensive?", with cheap meaning
   * "regenerate rather than store". That rule is right about machine work and
   * DANGEROUSLY WRONG about a person's: a hundred keystrokes are trivial for a
   * computer to write out again and impossible for anybody to reproduce. A
   * two-state field could not tell those apart, and the first thing it would
   * have got wrong is the one thing in a project that is genuinely unrecoverable.
   *
   * So the question is not "was this expensive" but "what happens if it is
   * gone", and there are three answers:
   *
   *   `irreplaceable` — NOTHING gets it back. The file the user imported, whose
   *   provenance only they know; and anything a PERSON made, at any size. Never
   *   swept, never regenerated, and named first in any warning about erasing it.
   *
   *   `expensive` — a machine can make it again, at a cost somebody would feel.
   *   Hours of GPU: a vision model over three hundred pages, a translation of
   *   every block. Kept because redoing it is a real price, not because it
   *   cannot be redone.
   *
   *   `regenerable` — cheap, deterministic, and derivable from what is still
   *   here. Zipping a tree, unpacking one, rendering a deliverable at export.
   *   These are MATERIALISED WHEN ASKED FOR rather than stored, which is the
   *   whole reason the folder does not fill with copies nobody can account for.
   *
   * ── What the store is actually for ──────────────────────────────────────
   *
   * Not "a copy of every file we ever wrote". The user's words: "this is about
   * retaining data from steps that took a lot of resources to run or acquire…
   * being able to step back if they make a mistake, or to keep different
   * steps/changes easily." So the store keeps the top two and lets the third go,
   * and the two operations it is designed for are STEPPING BACK and HOLDING
   * VARIANTS — not delivering files. A deliverable is a rendering of retained
   * data and is made at export.
   *
   * The READINGS BANK is this exact principle one layer down: the bank is the
   * `expensive` thing, the reprint is a `regenerable` rendering of it, and that
   * is precisely why a rerun is free.
   *
   * ── Why it is DATA and not a rule in the code ───────────────────────────
   *
   * Four passes ask this question — the asset sweep, the rotation, the delete
   * warning and the step chain — and a rule re-derived at each of them from the
   * role, the directory or the file extension is a rule that drifts. Asked of
   * the step, there is one answer, written down by the code that knew.
   */
  retention: StepRetention;
  /** Why, in words a warning can quote without rephrasing. */
  why: string;
  /*
   * NO GENERATOR VERSION IS RECORDED HERE, and that is a decision rather than an
   * omission. There was briefly a `madeBy` stamp, to catch a rendering made by
   * an older build so a compare screen could not blame our change on the user's.
   * It is gone: the churn it guarded against is this week's tuning of the PDF
   * emitter, not how the shipped program behaves. Rendering from retained data
   * is deterministic — one program, one answer — so a re-render IS the same
   * document, and permanent machinery built around a temporary condition is
   * machinery that outlives its reason and confuses whoever finds it.
   *
   * If a rendering looks stale while the emitter is being tuned, the fix is to
   * render it again, which is free precisely because the expensive data is what
   * this store keeps.
   */
}

/** See `ProjectStep.retention`. */
export type StepRetention = 'irreplaceable' | 'expensive' | 'regenerable';

/** The reasons, spelled once so every warning quotes the same words. */
export const WHY_IMPORTED =
  'the only copy of this document Foundry knows of — nobody knows where it came from';
export const WHY_MODEL_PASS =
  'hours of GPU: a model read every page of it';
export const WHY_HANDMADE =
  'changes you made by hand, which nothing can reproduce';

/**
 * ONE ROW PER FILE TYPE — the PDF, the EPUB, the text. Never one per file.
 *
 * ── What this replaced, and why ─────────────────────────────────────────────
 *
 * A row used to be a FILE with a role attached, which meant a project that had
 * been converted showed the scan and the reprint as two documents with the same
 * name, differing only by the directory this app happened to file them in. The
 * user's account of what they wanted is the whole correction: "each file type
 * has its own row in the system… all they see is the different available file
 * types."
 *
 * So the identity of a row is its KIND. Everything else about it — which file is
 * live, what was done to get there, what it was before — is the `steps` chain,
 * and the user sees only the top of it unless they go looking.
 *
 * `path` is what a click opens: the working copy for a type that has one, the
 * latest step's file otherwise. It is deliberately NOT the last step's `file`
 * for every type — a PDF's live copy lives in `working/` and its step chain
 * records the origins those copies were made from.
 */
export interface ProjectDocument {
  /** The row's identity. There is at most one row of each kind in a project. */
  kind: ProjectDocumentKind;
  /** What opening this row opens. */
  path: string;
  /**
   * The file's own name — `Working Towards The Fuhrer. Kershaw, Ian. (1993).epub`.
   * Never a layer name, never a path, never a slug.
   */
  label: string;
  at: number;
  missing: boolean;
  /**
   * True for anything Foundry MADE. False for a document the user imported: they
   * have it in a folder they chose, so it carries no "saved nowhere" dot.
   */
  managed: boolean;
  /**
   * Step 0 is this type's origin; the last is what is live. Never empty.
   *
   * The array IS the pointer: the live file is `steps[steps.length - 1]`, and
   * there is no separate `current` field precisely so the two can never
   * disagree about which one that is.
   */
  steps: ProjectStep[];
  /**
   * True when this row's origin is the PROJECT's own import — the book itself.
   *
   * The PDF for a scanned book; the EPUB for a project started from one. It is
   * `isOriginal` generalised from a file to a row (`shared/original.ts`), and it
   * is what makes deleting this row a project delete: everything else in the
   * folder was made from it, so there is nothing left to be a project without it.
   */
  origin: boolean;
}

/**
 * What the in-app confirmation says before something is erased.
 *
 * COMPOSED IN MAIN, DRAWN IN THE RENDERER, and the split is the point. Main is
 * the only side that knows the size on disk, how many pages the readings bank
 * holds and whether a copy was filed — and those sentences are what make the
 * warning worth reading rather than an "Are you sure?" people learn to click
 * through. The renderer owns the card it is drawn in and nothing about the words.
 *
 * `detail` is paragraphs rather than one string so the card can space them; the
 * readings-bank sentence in particular has to be able to stand on its own.
 */
export interface DeletionPrompt {
  /** The headline: what is about to happen, naming the thing. */
  message: string;
  /** The paragraphs under it, in order. Each is a sentence worth reading. */
  detail: string[];
  /** The label on the destructive button — never "OK". */
  confirm: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Every question this app asks, in this app's own voice
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A QUESTION COMPOSED IN MAIN AND DRAWN BY THE APP'S OWN CARD.
 *
 * ── What this replaced, and what the OS chrome was costing ──────────────────
 *
 * Five questions in this program went out as `dialog.showMessageBox`: the
 * closing document, the unlinked footnote, the re-read, and the two echoes
 * between a page heading and its contents entry. A native box is genuinely
 * modal to the WINDOW, which is the one thing it did better than anything in
 * here — and it is the OS's rectangle, in the OS's fonts, with the OS's button
 * order and the OS's idea of which button is dangerous. A program whose every
 * other question is a card in its own idiom, asking these five through a system
 * alert, reads as a program interrupted by something else; the user's ruling was
 * "we should have zero js alerts. they should all be custom modals."
 *
 * ── The split that did NOT move ─────────────────────────────────────────────
 *
 * The sentences stay MAIN'S. `aboutTheCorrections` knows what a save is worth
 * and `aboutTheCopy` knows where a copy is not; the renderer knows neither and
 * must never start writing its own copy, which is how a warning worth reading
 * becomes "Are you sure?". So what crosses the seam is the composed question,
 * and what comes back is the answer's own WORD (`QuestionChoice.key`) rather
 * than a button index. An index means different things in boxes of different
 * shapes — `response === 0` was "close it" in one of these and "save first" in
 * the other — and the way that goes wrong is silent. The key is the answer
 * union's own member, so main's composition and the caller's `switch` are held
 * together by the compiler instead of by a lookup table.
 *
 * `detail` is paragraphs rather than one string, as `DeletionPrompt` learned:
 * the card spaces them, and the native box's `\n\n` was a layout instruction
 * smuggled inside a sentence.
 */
export interface AppQuestion {
  /** The head of the card — the question itself, short enough to be read at a glance. */
  title: string;
  /** The lead sentence: what is true, naming the thing it is true of. */
  message: string;
  /** The paragraphs under it, in order. Each is a sentence worth reading. */
  detail: string[];
  /**
   * The buttons, IN THE ORDER THEY ARE DRAWN — which is a safety property and
   * not a layout one. The card puts them in the DOM exactly as they arrive, so a
   * composer that wants the destructive answer to be reached deliberately puts
   * it last and says so in its own words.
   */
  choices: QuestionChoice[];
  /** The key of the choice that is focused, and therefore what Enter takes. */
  preferred: string;
  /**
   * The key a DISMISSAL means — Escape, the scrim, another dialog opening over
   * this one. Never destructive: a question nobody answered has not been agreed
   * to.
   */
  dismissed: string;
  /** The standing-answer offer, or null for a question that cannot be silenced. */
  checkbox: QuestionCheckbox | null;
}

/** One button on the card, and the word it answers with. */
export interface QuestionChoice {
  /** What comes back when this is pressed — a member of the caller's answer union. */
  key: string;
  /** What the button says. Never "OK" (see `DeletionPrompt.confirm`). */
  label: string;
  /** Drawn in the error colour: this answer ends something. At most one. */
  danger?: boolean;
}

/**
 * "Don't ask again" — the offer, and WHICH answers may be stored.
 *
 * `remembers` is the rule rather than a flag, because two of these questions
 * have an answer that must never become standing. A stored "always put the
 * number back" would make deleting a footnote reference impossible, with no
 * dialog left to explain why every attempt undoes itself. Main names the
 * storable answers; a ticked box on any other choice is ignored.
 */
export interface QuestionCheckbox {
  label: string;
  remembers: string[];
}

/** What the card was answered with: the choice's key, and the box's state. */
export interface QuestionAnswer {
  key: string;
  /** True when the standing-answer box was ticked. False when there was none. */
  standing: boolean;
}

/**
 * WHAT MAIN HANDS BACK WHEN IT IS ASKED ONE OF THE FIVE QUESTIONS: a question to
 * draw, or an answer that was already given.
 *
 * The second case is the standing answer, and it is the whole reason this is a
 * union rather than an `AppQuestion`. Main consults `app-settings.json` BEFORE
 * composing anything, so a person who ticked "do this every time" gets no card,
 * no scrim and no flicker — the same silence the native box gave them, which was
 * never about the box.
 */
export type Asked<Answer extends string> =
  | { kind: 'ask'; question: AppQuestion }
  | { kind: 'answered'; answer: Answer };

/** What main will do about a request to delete one document, before it does it. */
export interface DocumentDeletion {
  prompt: DeletionPrompt;
  /**
   * True when this file is the document the project exists to hold.
   *
   * Deleting it takes the project with it (`shared/original.ts`), so the prompt
   * above describes the PROJECT, and the caller must run the project delete
   * rather than the document one. Main refuses the document delete outright for
   * this path, so a renderer that ignored the flag would get a sentence rather
   * than a half-erased folder.
   */
  original: boolean;
  /** The project the file belongs to — what to delete when `original` is true. */
  projectDir: string;
  /** The file is already gone; only its row in the catalogue is left to clear. */
  missing: boolean;
}

/**
 * What a listing says about a project's reading — three facts and no probing.
 *
 * DERIVED FROM THE RECORD, not from counting the bank on every render. Home is
 * redrawn every time it comes back on screen and a library is dozens of folders;
 * streaming every `.jsonl` in all of them to count newlines would make the
 * library screen slower the more books somebody has. The manifest says when a
 * reading landed and how big it was, and one `exists` per project catches the
 * bank this app did not fill itself.
 */
export interface ProjectReadingState {
  /** A completed reading exists. */
  done: boolean;
  /** True when this book HAS pages to read and nobody has read them. */
  needed: boolean;
  /** Pages in the completed bank, or 0 when nothing recorded one. */
  pages: number;
}

/** A project row on Home, with the documents it expands to. */
export interface ProjectSummary {
  key: string;
  /** The project directory itself, for Reveal. */
  dir: string;
  title: string;
  createdAt: number;
  /** The newest open of anything inside it, or `createdAt` if never opened. */
  openedAt: number;
  documents: ProjectDocument[];
  /**
   * Whether the model has read this book's pages, and how many.
   *
   * ON EVERY ROW because it decides what the row OFFERS. A project whose pages
   * have never been read cannot generate anything — there are no answers to
   * render — so its next step is OCR and Home lights it. Once a reading exists
   * the light goes out and stays out; nothing but losing the bank brings it back.
   *
   * `needed` is false for a project started from an EPUB as well as for one
   * already read: a book that arrived as a book has no pages to photograph and
   * never wanted this step at all.
   */
  reading: ProjectReadingState;
  /** True once anything has been filed into `final/`. */
  filed: boolean;
  /**
   * The terminal documents this project has produced — what the left nav lists,
   * indented under the project row.
   *
   * ── Why a listing carries these and `documents` does not ────────────────────
   *
   * `documents` is one row per file TYPE, and every row in it is a base for
   * further work: the scan, the flowing book, the reprint. An export is the other
   * thing — "it wont go into the working files as a step because it isnt the base
   * for new steps. its a terminal step. so its an export." Folding exports into
   * `documents` would put three EPUBs on a row that promises to hold one, and
   * would offer a step chain for a file that has no history because nothing was
   * ever done TO it.
   *
   * `file` is PROJECT-RELATIVE with forward slashes — `final/<the book's name>.epub`
   * — and never a bare name, because this codebase's oldest house rule is that a
   * project holds `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf`
   * at once and nothing may ever match the last segment. The renderer joins it to
   * `dir` and opens that; it never has to know a layer name, and it never puts one
   * on screen — an export is labelled by what it IS and when it was made.
   *
   * Newest first, because that is the order somebody looks for the thing they just
   * exported. Rows whose file has left the disk are not listed: `final/` is the
   * user's own tray and they may tidy it by hand, and a row that opens nothing is
   * worse than no row at all.
   */
  exports: ProjectFinal[];
  /**
   * THE BOOKS THE STEPS CAST FOR THEMSELVES — project-relative, forward slashes,
   * one per step that renders one, in ledger order.
   *
   * ── The bug this exists to end ──────────────────────────────────────────────
   *
   * A per-step cast is a RENDERING: free, remade from the step's own snapshot at
   * any time, and deliberately NOT a row in `documents` (`castForCurateStep`,
   * electron/projects.ts, holds the whole argument — a cast filed as a
   * `generated/` origin would become the project's newest book, so a read row
   * would start showing whichever save was pressed last).
   *
   * The library tree took `documents` as its list of "paths a step already speaks
   * for", and a cast is not in it. So opening a translation — which shows a cast —
   * put a SECOND row in the tree beside the step that made it, in the branch meant
   * for files somebody went and opened by hand, wearing the only name that branch
   * had for it: *"EPUB - a copy you open… this doesnt make any sense… the naming
   * scheme is wrong, the organizing is wrong, the user should never see 'epub' -
   * not until they actually export an epub directly themselves. it's deceptive."*
   *
   * Both halves of that row were false. Nobody opened it — standing on the step
   * did — and it is not an EPUB in any sense the reader is owed, it is the
   * rendering of a step whose payload is a `.jsonl` of records. The tree could
   * neither of those things because it had no way to know the file belonged to a
   * step, so this is that way: the names, composed by the side that knows how they
   * are composed, so the renderer never spells one and never guesses.
   *
   * NAMES AND NOT A PROMISE THAT THE FILE IS THERE. A cast is made on demand and
   * swept with its step; `summarise` stats nothing for this, because the question
   * it answers is "would a step show this path", which is true whether or not the
   * rendering has been made yet.
   */
  renderings: string[];
  /**
   * THE PAGE-FOR-PAGE RECORD EACH READING MADE — one per read step that has one
   * on disk, project-relative with forward slashes.
   *
   * ── Why this is a list of its own and not one of the two above ─────────────
   *
   * A facsimile is TERMINAL in exactly the sense an export is: nothing is made
   * from it, no step takes it as a parent, and there is no place to stand on it
   * (docs/RENDERER.md §0 A3). So it wants the row an export gets — a leaf under
   * the book, named by what it is and when it was made — and it fits neither of
   * the neighbouring fields. `documents` is one row per file TYPE and every row
   * in it is a base for further work, so filing a facsimile there would put it on
   * the PDF's chain beside the scan and make Home offer it as the document this
   * app edits. `renderings` is only a set of paths the tree already speaks for:
   * it draws nothing, and a facsimile listed there would vanish from the panel
   * rather than appear in it. `exports` is `final/`, which is the user's own
   * tray — a file this app made unasked has no business in it.
   *
   * COMPOSED, NOT CATALOGUED, which is `castForCurateStep`'s arrangement and its
   * argument: the name comes off the read step's own id, so the landing writes
   * nothing, `project.json` grows no row, and the same three parties — the plan
   * that writes the file, this listing, and the sweep that removes it with its
   * step — cannot come to three answers. What is on disk is the authority on
   * whether the row exists at all, which is why main stats each one and drops
   * the rows it cannot find: a nav row that opens nothing is worse than no row,
   * and every project reads before this existed has a reading and no facsimile.
   *
   * `madeAt` is the READ STEP's own moment rather than the file's mtime. The
   * facsimile is that reading's product and is remade whenever the reading is,
   * so the date a person is owed is the day the pages were read — and a stat for
   * a second opinion about it would be this listing asking the filesystem to
   * date somebody's history.
   */
  facsimiles: ProjectFacsimile[];
  /**
   * Set when `project.json` could not be read. The row is still listed — Home
   * is the only door back to a book — but it offers Reveal and nothing else,
   * because guessing at the contents of a catalogue that will not parse is how
   * a project gets opened as the wrong book.
   */
  problem: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs, the documents in them, and Home's list
// ─────────────────────────────────────────────────────────────────────────────

/** The two things this app opens. Everything else is refused at the door. */
export type RecentKind = 'pdf' | 'epub';

export interface RecentDocument {
  path: string;
  kind: RecentKind;
  /** The EPUB's `dc:title` where there is one, the file's basename otherwise. */
  title: string;
  openedAt: number;
  /** True while the file lives inside a Foundry project and nowhere else. */
  managed: boolean;
  /**
   * Measured on every read, never stored: a book on a drive that is not plugged
   * in is missing this minute and present the next.
   */
  missing?: boolean;
}

/** One entry in the chapter sidebar. Spine order; the nav supplies label and indent. */
export interface EpubChapter {
  /** The document's path inside the book, forward-slashed, OPF-relative resolved. */
  href: string;
  label: string;
  /** 0 for a chapter, 1 for a chapter inside a part, and so on. */
  depth: number;
  /** The `foundry-file://epub/<id>/<href>` URL the iframe points at. */
  url: string;
}

/**
 * What a tab has to say for itself before it closes.
 *
 * ── TWO FACTS NOW, AND THE THIRD ONE IS A RULING RATHER THAN A DELETION ─────
 *
 * There used to be three, and the one that went is `unsaved` — "no copy of this
 * exists anywhere you chose", the Chrome dot. It was true FROM BIRTH for every
 * book this app opens out of a project, so closing a tab somebody had merely
 * looked at raised a warning about a loss that had not happened: the book is in
 * its project, Home still lists it, the working copy holds every edit, and
 * closing the tab loses track of nothing. The user ruled it out in one sentence
 * — *"only pop up a confirmation alert if changes have been made"* — and the
 * ruling was already implied by the surface around it: saving is the export
 * modal's job now (docs/WORKBENCH.md §6), so "you have not filed a copy of this"
 * is a warning about a workflow this app no longer has.
 *
 * The dot itself STAYS. `Tab.unsaved` is a statement about where a document
 * lives and it is worth drawing; what it is not is a reason to interrupt
 * somebody on their way out of a tab.
 *
 * So what is left is two genuine losses. `modified` is "you have edited this
 * since the copy YOU chose was written" — a copy on the user's own disk that is
 * now behind, which closing does not fix and nothing else will mention.
 * `corrections` is not an unsaved edit at all: a scan's block decisions land on
 * disk as they are made, and what is missing is a RESTORE POINT (see
 * `UncommittedCuration`). Main writes a different sentence for each, and a tab
 * that is neither closes without a question.
 */
export interface CloseWarning {
  title: string;
  modified: boolean;
  /** Where a copy was last written, when there is one. */
  savedPath: string | null;
  /**
   * The corrections this book has no save of, or null when there is nothing to
   * ask about — which is the ordinary answer for every book and every EPUB.
   */
  corrections: UncommittedCuration | null;
  /**
   * How many changes are on the book pane's stack with no Apply behind them, or
   * null when this tab is not a book or has nothing waiting.
   *
   * ── The one loss in this app that closing genuinely destroys ────────────────
   *
   * `UncommittedCuration` exists to say that the block editor has NO unsaved
   * state — every strike is written into the live curation as it is made, and
   * what closing ends is the way BACK to a state, not the state. The book's stack
   * is the opposite and the warning has to be too: it is in memory, it is the
   * only copy, and the ruling is that closing without Apply scraps it
   * (docs/RENDERER.md §3). So this is the rare case where "you will lose this"
   * is the true sentence, and it is worth having a field of its own precisely so
   * that the two cards cannot end up saying each other's words.
   *
   * A COUNT AND NOT A LIST. The card says how much is at stake; what each op says
   * is on the paper behind the dialog, in the cancel marks and the changed
   * paragraphs, which is a better description of five strikes than five lines of
   * prose about them would be.
   */
  edits: number | null;
}

/**
 * How a closing document's question was answered.
 *
 * THREE ANSWERS AND NOT A BOOLEAN, because "proceed or cancel" is not enough for
 * a question about work the user would rather keep. A dialog whose only way to
 * keep the corrections is *cancel, find Save, close again* has made the person do
 * the app's job for it, and the way that ends is that they stop reading the box
 * and press the button that makes it go away. `save` is the offer to commit and
 * then close; a commit main refuses leaves the tab open, because a close that
 * happened anyway would have thrown away the very thing the answer asked to keep.
 */
export type CloseAnswer = 'close' | 'save' | 'keep';

/**
 * How "Read this book again?" was answered.
 *
 * A WORD RATHER THAN THE BOOLEAN THE CALLER WANTS, because the card answers with
 * the key of the button that was pressed and `true` is not the name of a button.
 * The api layer collapses it to the boolean the OCR dialog asks for; what
 * crosses the seam says which of the two things a person chose. See
 * `RE_READ_PROCEED` (shared/reread.ts) for the labels those two keys wear.
 */
export type ReReadAnswer = 'again' | 'leave';

/**
 * Corrections a book holds that no save of it does — what closing actually costs.
 *
 * ── This is NOT "unsaved changes", and the difference is the whole point ────
 *
 * There is no unsaved state in the block editor. Every strike, reclassification
 * and chapter edit is written whole into the live curation the instant it is
 * made, so closing discards nothing and every correction is exactly where it was
 * left when the book is opened again. What a person can lack is a RESTORE POINT:
 * a curation step they could step back to. Foundry's step-by-step undo lasts only
 * as long as the document is open, so closing is the moment "undoable" becomes
 * "permanent" — and a save is the only thing that replaces it.
 *
 * Composed by `uncommittedCuration` (shared/uncommitted.ts), which returns null —
 * and asks nothing — for a book nobody has corrected and for a book whose
 * corrections a save already holds.
 */
export interface UncommittedCuration {
  /**
   * How many blocks stand differently now than they do in that save.
   *
   * A DIFFERENCE AND NOT A TOTAL: a block corrected since, corrected differently,
   * or corrected and then put back all count, and none of the blocks the save
   * already agrees about do. With no save to measure against it is simply how many
   * blocks this book has decisions about.
   */
  blocks: number;
  /** True when the chapter list differs from that save's — a spine is labour too. */
  chapters: boolean;
  /**
   * What the save is called — "Applied changes (23)" — or null when this book
   * has none that these corrections could be measured against.
   */
  since: string | null;
}

/**
 * A footnote nothing points at any more, and the number that used to.
 *
 * Produced by `setBlockHtml` when an in-place edit deleted the last reference to
 * a note (electron/epub-reader.ts), carried to the renderer, and handed straight
 * back to main so the question can be asked with the note NAMED — a person about
 * to lose a footnote has to be able to tell which one it is, and "a footnote"
 * tells them nothing.
 */
export interface UnlinkedNote {
  /** The `<aside>`'s own id — `fn25`. */
  noteId: string;
  /** What the reference read on the page — the printed number, usually. */
  printed: string;
  /** The words the note itself begins with, clipped, so it can be recognised. */
  opening: string;
}

/**
 * Which world a word edit on an open book lands in — main's answer to
 * `translation:of-document`, asked once per tab and cached by the renderer.
 *
 * NULL (the IPC's other answer) is the ordinary book: the source cast, a save's
 * cast, or a foreign EPUB — a word edit there mirrors to the overlay's `text`
 * field, or to nothing at all when the book is in no project. Non-null means
 * the document is a TRANSLATE step's book, where a word edit is a per-language
 * correction: a human row in that step's records file, never an amendment in
 * the source curation.
 */
export interface TranslationWorld {
  /** The step's recorded target language — `params.language`, `''` where unrecorded. */
  language: string;
  /**
   * A translate row from before translations were records: its payload is the
   * EPUB the old pipeline wrote and there is no records file, so a correction
   * has nowhere durable to go. The renderer says so instead of writing.
   */
  legacy: boolean;
}

/**
 * What the user said about an unlinked footnote.
 *
 * THREE ANSWERS, and they write three different things: `cut` strikes the note
 * as well, `keep` leaves it standing and unreachable, `cancel` puts the
 * reference number back by restoring the block's previous markup. Main answers
 * with the standing preference instead of asking when one has been stored — see
 * `unlinkedNoteAnswer` in electron/app-settings.ts.
 */
export type UnlinkedNoteAnswer = 'cut' | 'keep' | 'cancel';

/**
 * The stored form of that answer — the two worth remembering, plus `ask`.
 *
 * `cancel` is deliberately NOT one of them. "Always put the number back" is an
 * instruction never to be able to delete a reference number again, with no
 * dialog left to explain why every attempt undoes itself.
 */
export type UnlinkedNoteStanding = 'ask' | 'cut' | 'keep';

// ═════════════════════════════════════════════════════════════════════════════
// The page and the contents are two statements
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE WORDS ON THE PAGE AND THE ENTRY IN THE CONTENTS ARE ALLOWED TO DIFFER,
 * and that is the whole of the design these types serve.
 *
 * The text should say what the book says; the contents should say what the
 * book's own apparatus says. Those are usually the same sentence and sometimes
 * deliberately are not — the caster composes a nav label the page never carried
 * ("Part II — The Road to War" over a page that reads "II"), and that divergence
 * is correct. So neither side is derived from the other, nothing is kept in
 * sync, and renaming one OFFERS to update the other.
 *
 * An "echo" is that offer: the other side, as it stands, when it still reads
 * what the side just renamed used to read. Where the two already differ there
 * is no echo and no question — the difference is a decision somebody has
 * already made, and asking about it on every rename would train a person to
 * dismiss the dialog without reading it.
 */
export type EchoAnswer = 'update' | 'leave';

/**
 * The stored form of that answer.
 *
 * PER ANSWER, exactly as `UnlinkedNoteStanding` is: "always update the other"
 * and "never update the other" are two different standing instructions about
 * somebody else's book, and collapsing them into one silenced-question flag
 * would mean the app picking which of them was meant. `ask` is the default.
 */
export type EchoStanding = 'ask' | 'update' | 'leave';

/** The page heading a contents rename could carry with it. */
export interface HeadingEcho {
  /** The document the heading lives in — a book-relative member href. */
  member: string;
  /** What the heading reads now, which is what the contents entry read before. */
  was: string;
  /** What the contents entry now reads, and what the heading would become. */
  now: string;
}

/**
 * What a contents rename did, and what it is offering to do next.
 *
 * The nav half has ALREADY HAPPENED when this arrives — the contents is the
 * thing that was renamed, and renaming it is exactly what was asked. The echo
 * is the question.
 */
export interface HeadingRenameOutcome {
  /** True when a contents entry's label was rewritten. */
  navChanged: boolean;
  /** The page heading that still reads the old label, when there is one to offer. */
  echo: HeadingEcho | null;
}

/**
 * One block whose `data-bf-cat` a relabel actually moved, and what it said
 * before.
 *
 * MAIN ANSWERS WITH THIS because main is the only thing that read the file. A
 * marquee over a page catches paragraphs and captions together, so "relabel
 * these thirty as footnote" is thirty different previous labels — and the undo
 * ledger has to put each one back to its own. A renderer that assumed they were
 * all the category the inspector happened to be showing would quietly rewrite
 * the ones that were not.
 */
export interface RelabelledBlock {
  /** Its `data-bf-id`. */
  id: string;
  /** The `data-bf-cat` it carried until this call. */
  was: string;
}

/** The contents entry an in-place heading edit could carry with it. */
export interface NavEcho {
  /** The contents entry's href, in the shape the sidebar and `renameHeading` use. */
  href: string;
  /** What the entry reads now, which is what the heading read before the edit. */
  was: string;
  /** What the heading now reads, and what the entry would become. */
  now: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// A document's own record
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The six Dublin Core fields `foundry epub-meta` reads and writes. `null` is
 * "the package declares none", which is a legal answer for three of the six.
 */
export interface EpubMetadataFields {
  title: string | null;
  creator: string | null;
  language: string | null;
  publisher: string | null;
  date: string | null;
  identifier: string | null;
}

/** The four Info-dictionary fields `foundry pdf-meta` reads and writes. */
export interface PdfMetadataFields {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
}

/**
 * What a document says about itself, in the shape the engine answered with.
 *
 * A DISCRIMINATED UNION rather than one bag of optional fields, because an EPUB
 * and a PDF do not have the same record and pretending they do is how a dialog
 * ends up offering a `dc:language` box for a scan. The engine has two commands
 * for the same reason.
 */
/**
 * A document's record, or the sentence saying why it could not be read.
 *
 * NOT A REJECTION, because the engine's refusals are the useful half here: a
 * package with two `dc:creator` elements is refused BY NAME, and that sentence
 * belongs in the dialog beside the fields rather than in a console nobody has
 * open.
 */
export type MetadataOutcome =
  | { ok: true; metadata: DocumentMetadata }
  | { ok: false; reason: string };

/**
 * The same answer, plus THE HISTORY THE WRITE JUST CHANGED.
 *
 * A metadata edit is a step now, so a write that used to change one file changes
 * two things a person is looking at: the document, and the list of steps beside
 * it. The renderer must not have to ask again for the second — a re-read is a
 * second answer composed a moment later, and the accordion would sit a turn
 * behind its own new row (`LedgerService.adopt`, which is where this lands). So
 * the landing travels back with the record, exactly as `overlay:commit`'s does.
 *
 * `landed` IS ABSENT FOR EVERY WRITE THAT MINTED NOTHING, and those are ordinary
 * rather than exceptional: a loose file the user opened off their own disk has no
 * project and no ledger to append to, and a patch with no changed fields in it is
 * a read wearing a Save button. The dialog treats absent as "nothing to adopt".
 */
export type MetadataWriteOutcome =
  | {
    ok: true;
    metadata: DocumentMetadata;
    landed?: { ledger: ProjectLedger; rows: StepRow[] };
  }
  | { ok: false; reason: string };

/**
 * WHAT A `metadata` STEP RETAINED — the patch exactly as it was applied.
 *
 * ── Why the payload is the values and the params are the names ──────────────
 *
 * This file is what an export replays. Materialisation walks the position's
 * ancestry, takes the newest value of each field, and hands the merged patch to
 * `epub-meta` or `pdf-meta` as the last thing that happens to the product — which
 * is only possible because the values were written down at the moment they were
 * typed. The dialog's write to the live document is what the user SEES; this is
 * what survives to be applied to a book cast three weeks later out of a bank that
 * never knew the title had been corrected.
 *
 * `kind` IS LOAD-BEARING AND IS NOT A CONVENIENCE. A project holds a scan and the
 * book cast from it, and they do not keep the same record: an Info dictionary's
 * `author` and a package's `dc:creator` are the same fact under two spellings,
 * and `subject`/`keywords` exist for one of them only. A row edited while
 * standing on the import is about the SCAN, and applying its fields to an EPUB
 * export would be this app moving somebody's words between two documents' records
 * because the two happen to be in one folder.
 */
export interface MetadataPatch {
  kind: 'epub' | 'pdf';
  /** Field name → the value written. Never empty: an empty value is not a patch. */
  fields: Record<string, string>;
}

export type DocumentMetadata =
  | {
    kind: 'epub';
    fields: EpubMetadataFields;
    /** What `<package unique-identifier>` names. Null means that link is broken. */
    uniqueIdentifier: string | null;
    /** How many elements each field has. More than one is legal, and unwritable. */
    counts: Record<string, number>;
  }
  | {
    kind: 'pdf';
    fields: PdfMetadataFields;
    pages: number;
    /** Read, never written: the software chain that made the file. */
    creator: string | null;
    producer: string | null;
  };

/**
 * An open book. `id` is what closes it again — a tab that is closed, and every
 * tab on quit, hands its id back so main stops serving its members.
 *
 * CLOSING DELETES NOTHING NOW. The chapters are served out of the project's own
 * `working/` tree, which is the book's durable working copy and outlives both
 * the tab and the process; only the registry entry goes.
 */
export interface EpubBook {
  id: string;
  /** The .epub the user named. Not necessarily the archive the tree came from. */
  filePath: string;
  /**
   * True when `filePath` lives inside a Foundry project. Measured by MAIN,
   * because it decides what Save may write: a book opened from the user's own
   * disk grants plain Save to that file (it already IS a copy they chose), and
   * a project's own file grants nothing until the save dialog says so. The
   * renderer uses it to seed `savedPath` for the same reason.
   */
  managed: boolean;
  title: string;
  author: string | null;
  chapters: EpubChapter[];
  /**
   * EVERY DOCUMENT OF THE SPINE, IN READING ORDER — what the book RENDERS, as
   * distinct from `chapters`, which is what its contents LISTS.
   *
   * ── Why these had to come apart ─────────────────────────────────────────────
   *
   * They were one field, and the flowing book was drawn by walking `chapters`.
   * That worked for exactly as long as `chapters` was guaranteed to name every
   * spine document — which it was, because a document neither the nav nor its own
   * `<title>` would name got a row anyway, labelled with its FILENAME. Take that
   * invented row away (and it had to go: *"no fallbacks. i hate fallbacks…"*, and
   * a filename is the one thing this app's copy never shows) and the document
   * stops being drawn at all. A contents list quietly deciding which pages of
   * somebody's book exist is a far worse bug than the one being fixed.
   *
   * So the spine is carried in its own right. The reader draws THIS, complete and
   * in order, and the contents list is free to be an honest account of the
   * divisions the book actually declares — including declaring none.
   *
   * `url` rides along because composing one is main's (`memberUrl` mints it
   * against the id of this unpacking) and a renderer spelling the scheme itself
   * would be a second implementation of the protocol handler's contract.
   */
  members: { href: string; url: string }[];
  /**
   * The navigation document's member path, or null for a book that has none.
   *
   * The renderer knows every OTHER member it edits, because every other edit is
   * addressed by a chapter href it is already holding. The nav is the exception:
   * renaming a contents entry writes a file nothing in the renderer can name,
   * and the undo stack records `{ member, before, after }` — so without this,
   * the one action that writes two members could record neither.
   */
  navMember: string | null;
  /**
   * What could not be done while opening this book, or null.
   *
   * NOT a `problem`: the book opened, it renders, it is readable. This is for
   * the case where something the app does BESIDE opening it did not work —
   * today, an imported EPUB the engine would not stamp, which reads perfectly
   * and whose select mode has nothing to address. It lands in the notice strip
   * once, because a door that is shut has to say so on the way in rather than
   * by doing nothing when somebody tries it.
   */
  notice: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The undo ledger, and the file it survives in
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Which setter puts one ledger row back.
 *
 * THE FIELD IS THE ROUTE, and there are five because there are five things this
 * app can do to a document. Each names a call that already exists in main, with
 * its own validator, keyed by the same id the original edit used.
 *
 * IN SHARED TYPES rather than in the service that uses them, because the ledger
 * is written to disk now and main is what writes it. Main never REPLAYS a row —
 * that is still entirely the renderer's, through the setters — but it does have
 * to recognise one, so that a history file carrying a field this app cannot
 * route is refused as the wrong shape instead of being handed back to a Ctrl+Z
 * that would fall through every branch and do nothing.
 */
export type LedgerField =
  | 'cut' | 'category' | 'html' | 'note-cut' | 'nav-label' | 'page-heading'
  /*
   * `join` IS A BOOK ROW THAT WRITES NO BOOK. The manual paragraph join is a
   * decision in the curation and nothing else — the two paragraphs on screen
   * merge at the next cast, not at the gesture — so its replay skips the
   * member setters entirely and re-amends the overlay, resolved through the
   * same provenance read the gesture used. `target` is the continuation
   * element's `data-bf-id`; `member` is the chapter that element is in, kept
   * so an undo made with some other chapter on screen can still resolve the
   * name. `'1'` and `''` are the two sides, exactly as `cut` spells them.
   */
  | 'join'
  /*
   * ── AND THE FOUR THE BLOCK EDITOR ADDS ──────────────────────────────────
   *
   * The same idea one document earlier. The first three name a block in a SCAN's
   * readings — `page:order`, or `page:order:part` — and their setter is not a
   * call into somebody's markup but one line of the overlay file
   * (shared/overlay.ts, `amendOverlay`): the same shape as every field above it,
   * a targeted validated write of one value, so an undo is that call again with
   * the old one.
   *
   * `member` for all four is the overlay's own key, which is the readings bank's
   * key, which is the project's. A scan has no chapters to be a member of; what
   * it has is one bank and one file of decisions about it.
   *
   * The empty string is "nothing said", and it is a real value rather than a
   * missing one: un-striking a block is not writing `strike: false`, it is
   * REMOVING the field, and `before: ''` is what makes that undoable.
   *
   * `chapters` IS THE ODD ONE AND IT CARRIES THE WHOLE LIST. Its `target` is the
   * overlay key again rather than a block, because the spine is one statement
   * about the book: adding a chapter, removing one and renaming one are all "it
   * used to run like this and now runs like that", and the first chapter edit of
   * all turns an ABSENT list into a seeded one — a state no per-chapter row could
   * return from, since undoing one row would leave the other fifty-nine written
   * out explicitly, which means something different from having said nothing.
   */
  | 'strike' | 'block-category' | 'block-text' | 'chapters';

/**
 * One element, one field, and what it said on each side of an action.
 *
 * `target` is a `data-bf-id` for the three block fields, a footnote's own id
 * (`fn25`) for `note-cut`, and a contents entry's href for the two rename
 * fields — in every case, the name the ORIGINAL setter was called with, so the
 * replay is that call again with the other value.
 *
 * AND THAT IS WHY THE FILE IS BOUND TO A GENERATION. Every one of those names is
 * a name in ONE working copy: `p47-3` is the third stamped element on page 47 of
 * the tree it was recorded against, and a re-cast is free to call something else
 * that. See `ProjectWorkingTree.generation`.
 */
export interface LedgerRow {
  /** The member the setter writes. Not always the chapter on screen. */
  member: string;
  target: string;
  field: LedgerField;
  before: string;
  after: string;
}

/**
 * One action — Owen's action number — and every row it moved.
 *
 * A batch is ONE action with many rows: a marquee's worth of cuts, an
 * all-of-this-category strike, sixteen blocks relabelled at once. Ctrl+Z
 * reverses all of them, and it falls out rather than being arranged: the gesture
 * is one call to main, main answers with everything it moved, and that answer IS
 * the rows.
 */
export interface LedgerAction {
  seq: number;
  /** Past tense: "struck 14 blocks" → "Undid: struck 14 blocks." */
  label: string;
  rows: readonly LedgerRow[];
}

/** Both stacks of one document, as they cross IPC and as they sit on disk. */
export interface LedgerStacks {
  done: LedgerAction[];
  undone: LedgerAction[];
}

/**
 * `history/<working tree>.json` — one document's undo ledger, on disk.
 *
 * WRITTEN AFTER EVERY MUTATION OF EITHER STACK, whole, atomically, because
 * "flush on every change" plus a crash mid-write is exactly the case this
 * feature exists for and a half-written history must never be what survives.
 * See electron/history.ts for the write and for what happens to a file whose
 * `generation` is not the working copy's.
 */
export interface DocumentHistory {
  /** 1. Bumped only when a reader of an older file would get it wrong. */
  version: number;
  /** The `ProjectWorkingTree.generation` these rows name blocks in. */
  generation: string;
  /** The origin the tree was unpacked from — `generated/x.epub`. For a human. */
  document: string;
  savedAt: number;
  done: LedgerAction[];
  undone: LedgerAction[];
}

/**
 * What `history:load` answers with: the stacks, and what had to be said about
 * getting them.
 *
 * THE NOTICE IS NOT AN ERROR CHANNEL. Every one of the three outcomes is
 * normal — a history restored, a history that belongs to a book that no longer
 * exists, a history that will not parse — and the last two both END WITH EMPTY
 * STACKS AND A SENTENCE naming the file and where it went. Never silently
 * empty: a Ctrl+Z that does nothing because a file was quietly discarded is
 * indistinguishable from one that is broken (ARCHITECTURE §8).
 */
export interface LedgerLoad {
  actions: LedgerStacks;
  /** One sentence for the strip, or null when there was nothing to say. */
  notice: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The block editor: what the engine says is on a scan's pages
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One block of one page, as the model read it.
 *
 * STRAIGHT OFF THE READINGS BANK, through a command that prints it — the app
 * never parses the bank itself, for the same reason it never opens an EPUB by
 * hand: the bank's shape is the engine's, the split into parts is the engine's,
 * and a second reader of it would be a second opinion about what a block is.
 */
export interface PdfBlock {
  /** 1-based, the PDF's own numbering. */
  page: number;
  /** The element's index in the model's answer for that page. */
  order: number;
  /** Which piece of that element this is, after the markdown split. */
  part: number;
  /** What the model called it — one of `OVERLAY_CATEGORIES`. */
  category: string;
  /** The block's box IN THE RENDER'S PIXEL FRAME. See `PdfBlockPage.width`. */
  box: { x1: number; y1: number; x2: number; y2: number };
  /** What the model read. Shown in the inspector beside any override of it. */
  text: string;
}

/**
 * One page's blocks, and the frame their boxes are measured in.
 *
 * THE RENDER SIZE IS NOT THE PAGE SIZE and the difference is the whole reason it
 * is carried. The model was shown a raster of the page at whatever resolution the
 * conversion rasterised it at, and every box it answered with is in those pixels.
 * The viewer draws the page at a CSS size that depends on the window and the
 * zoom. So a box is scaled by `cssPageWidth / width` — axis-aligned, one factor,
 * because both frames are the same page in the same orientation.
 */
export interface PdfBlockPage {
  page: number;
  width: number;
  height: number;
  blocks: PdfBlock[];
}

/**
 * The blocks of a whole document, or the sentence saying why there are none.
 *
 * A RESULT AND NOT A REJECTION, exactly like `MetadataOutcome`: "this book has
 * never been read by the model" and "this engine build has no blocks command" are
 * both ordinary answers that belong on screen as words, and neither is a reason
 * for a tab to break.
 */
export type PdfBlocksOutcome =
  | { ok: true; pages: PdfBlockPage[]; chapters: PdfDetectedChapter[] }
  | { ok: false; reason: string };

/**
 * Where the ENGINE thinks a chapter starts, and what it would call it.
 *
 * REPORTED SO THE APP CAN SEED, and for nothing else. The overlay's `chapters`
 * list, once written, supersedes detection completely — but a person opening the
 * chapter accordion on a three-hundred-page book must not be handed an empty list
 * and told to find forty chapter openings by hand. So the detected spine is what
 * the accordion shows until somebody touches it, drawn as detected-not-confirmed,
 * and the first edit writes it out as theirs.
 */
export interface PdfDetectedChapter {
  page: number;
  order: number;
  part?: number;
  /** What the engine derived, usually the block's own words. */
  title: string;
}

/**
 * What `overlay:load` answers with: the amendments, and what had to be said about
 * getting them.
 *
 * The same three outcomes `LedgerLoad` has, for the same reasons — restored, or
 * archived aside with a sentence naming the file and where it went. Never
 * silently empty.
 */
export interface OverlayLoad {
  /**
   * THE LIVE FILE as it stands, or an empty one bound to the current reading —
   * and the only thing in this answer anything is allowed to write.
   */
  file: OverlayFileWire;
  /**
   * The frozen curation the position DISPLAYS, or null when what is on the pages
   * is the live file.
   *
   * ── Why the answer carries two curations rather than resolving to one ───────
   *
   * `locateOverlay` has kept these apart on the disk side since the day snapshots
   * existed: `file` is where a correction goes and `displayed` is what the pages
   * draw, because resolving one to the other would mean the next strike anybody
   * made while standing on a save silently rewrote that save. What was missing is
   * that the second one never crossed IPC, so the block editor drew the LIVE
   * outlines over a book it was showing frozen — read-only and honest about it,
   * and showing the wrong corrections. The entire point of clicking an old save
   * is to see the book as it was then.
   *
   * IT IS NOT WHAT A GENERATE IS MADE WITH, which it was until translations
   * landed. Standing on a `translate` row, a Generate applies the curation the
   * translation was taken under while the pane shows the live corrections — the
   * row froze a bank of translated blocks and nobody's strikes, so there is
   * nothing there to display frozen and somebody standing on it is trying to
   * correct the book they just translated. `DISPLAYS_ITSELF` (shared/ledger.ts)
   * is the ruling; docs/TRANSLATION-STEPS.md §4 is why the gap between the two
   * answers is closed by pressing Save rather than by picking one of them.
   *
   * NULL IS THE ORDINARY ANSWER, and it is null for every project nobody has
   * pressed Save in and for every position that is not standing on a save. It is
   * also null for a snapshot this app would not read — one bound to an earlier
   * reading, or one that will not parse — because outlines drawn from a curation
   * about different blocks are the one failure worse than showing none, and
   * `notice` says which happened.
   */
  frozen: FrozenOverlayWire | null;
  notice: string | null;
}

/**
 * The overlay as it crosses IPC.
 *
 * Structurally the `OverlayFile` of shared/overlay.ts and deliberately declared
 * again here rather than imported: this file is the wire, it is imported by the
 * preload, and a type alias reaching into a module with a class in it would drag
 * that module across a boundary it has no business on.
 */
export interface OverlayFileWire {
  overlay: number;
  generation: string;
  amendments: {
    /**
     * `note` names one note of a Footnote block — the ordinal `splitNotes`
     * gives it, stamped on the aside as `data-bf-note`. A note target may
     * carry ONLY `strike`; both readers refuse `category`/`text` on it by
     * name, because the bank holds one answer for the whole block and a
     * per-note category would be a decision with nowhere to live.
     */
    at: { page: number; order: number; part?: number; note?: number };
    strike?: boolean;
    category?: string;
    text?: string;
  }[];
  /** Absent means the engine decides. See `OverlayFile.chapters`. A chapter never names a note. */
  chapters?: { at: { page: number; order: number; part?: number }; title: string }[];
  /**
   * A phantom, carried across the wire for the reason `OverlayFile.frozen`
   * carries it: it makes a `FrozenOverlayWire` unassignable here, so the frozen
   * curation the renderer is handed for DISPLAY cannot be passed to
   * `overlay.save` — which takes this type — however it is passed around in
   * between. Nothing ever sets it and nothing ever reads it.
   */
  frozen?: never;
}

/**
 * A committed snapshot as it crosses IPC — the same bytes, marked as the copy
 * that may be shown and not written. See `OverlayLoad.frozen`.
 */
export interface FrozenOverlayWire extends Omit<OverlayFileWire, 'frozen'> {
  frozen: true;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE STEP LEDGER — a project's whole history, as a tree that reads as a list
// ═════════════════════════════════════════════════════════════════════════════

/*
 * TWO THINGS IN THIS APP ARE CALLED A LEDGER AND THEY ARE NOT RELATED. The one
 * above — `LedgerRow`, `LedgerAction`, `LedgerStacks` — is the block editor's
 * UNDO history: keystroke-grained, capped, thrown away when the working copy is
 * rebuilt. This one is the project's STEP history: a handful of rows, each the
 * retained payload of one completed action, kept forever. Nothing crosses
 * between them, and the names here all begin with `Step` or `Ledger…Step` so
 * that a reader who lands on one can tell which ledger they are in.
 *
 * The logic lives in `shared/ledger.ts`; only the shapes live here, because
 * these cross IPC and the preload must be able to name them without pulling a
 * module with a runtime in it across the boundary.
 */

/**
 * The five things that mint a step. Everything else a project does is free.
 *
 * IT IS A SHORT LIST BECAUSE A STEP IS A RETAINED PAYLOAD, not an event. The
 * queue is where expense happens, a step is what one expensive job left behind,
 * and everything else — rendering an EPUB, a PDF, a text file; moving the
 * pointer; opening a tab — is a rendering of a payload that already exists and
 * costs nothing to make again.
 *
 * `curate` IS THE ODD ONE OUT AND EARNS ITS PLACE ANYWAY. It spends no GPU and
 * needs no queue job — it is the user pressing Save in the block editor, which
 * freezes the live overlay as a snapshot. It is here because the retention rule
 * is about what it costs to GET SOMETHING BACK, not what it cost to make, and a
 * person's judgement about four hundred blocks is the one thing in a project
 * that nothing can reproduce.
 *
 * ── AND `metadata` IS THE SECOND ONE OF THOSE, FOR THE SAME REASON ──────────
 *
 * The user's own ruling put it here — "only steps that are going to lead to
 * another step or to export are added to the steps ledger. including edit
 * metadata" (docs/WORKBENCH.md §1) — and the ledger was lying by omission until
 * it was: the dialog wrote a title straight into the open document's package and
 * NOTHING else learned it had happened. No row, no announce, and, worse, an
 * EXPORT that quietly lost the edit, because an export is cast fresh from the
 * bank and the working tree's package is not one of its inputs. Both of those
 * stop being true the moment the edit is a step: the row is the durable record,
 * and materialisation applies the chain of them to whatever it makes.
 *
 * IRREPLACEABLE, on the same clause of the retention rule `curate` sits on. A
 * title, an author, a publisher and a date are typed by a person out of the
 * book in their hands — no machine makes them again at any price, and the fact
 * that the write itself costs milliseconds is exactly the thing that rule was
 * written to stop mattering.
 *
 * AND THE POINTER DOES NOT MOVE FOR IT (`RETAINED_BESIDE_YOU`). A metadata edit
 * does not make a new state of the book to go and stand in; it records something
 * about the state you are already standing in, and a pointer that jumped would
 * take the block editor read-only as the reward for correcting an author's name.
 * Each Apply appends its own row — two corrections are two decisions, and the
 * newest value of a field is what the exports carry.
 *
 * NO `generate`, deliberately. A rendering is reproducible from its step's
 * payload at any time, and minting a step for one would put a filename where an
 * action belongs. If "what did I export and when" is ever wanted, it is an
 * export log — a separate thing, and not this.
 */
/*
 * `edit` IS THE BOOK'S OWN ACTION, and it is the one this whole renderer plan is
 * built around. What it retains is a JSONL file of OPS — one line per decision,
 * keyed by block id (`shared/ops.ts`, docs/RENDERER.md §3) — written whole when
 * somebody presses Apply and never appended to afterwards. It is a DELTA: what
 * the book says at any position is the reflowed book file with the ops of every
 * edit step on the path replayed over it, in order.
 *
 * IRREPLACEABLE, on the clause of the retention rule `curate` and `metadata` sit
 * on. A strike, a retyped sentence and a relabelled heading are somebody's
 * judgement about their book; no run remakes them at any price, and the fact that
 * writing the file costs milliseconds is exactly what that rule exists to stop
 * mattering.
 *
 * AND THE POINTER MOVES ONTO IT, which is where it parts company with a save.
 * A curate step is retained BESIDE you because the live overlay already carries
 * the decisions and standing on the snapshot would only take the editor
 * read-only. An edit step is the opposite: its ops reach the page ONLY through
 * the chain from the position, so a pointer left behind would mean pressing
 * Apply and watching every change vanish off the paper. See `RETAINED_BESIDE_YOU`
 * in shared/ledger.ts, where that is said once.
 */
export type StepAction = 'import' | 'read' | 'curate' | 'translate' | 'metadata' | 'edit';

/**
 * What was ASKED FOR, and what the run recorded about the answer.
 *
 * ── Why one flat bag rather than a union per action ─────────────────────────
 *
 * The typed alternative is a discriminated union — `{action: 'read'; params:
 * {generation, pages}} | {action: 'translate'; params: {language}}` — and it
 * would be better typing for exactly one caller and worse for every other
 * reader of a step. A union on `action` makes `LedgerStep` a union, which makes
 * `LedgerStep[]` a union array, which makes every function that does not care
 * about params at all (staleness, the subtree, the chronological list, the
 * delete confirm) narrow a discriminant to reach a field it never touches.
 *
 * SO THE ACTION-SPECIFICITY IS ENFORCED WHERE IT MATTERS INSTEAD: `parseLedger`
 * refuses a params field the action has no use for, BY NAME — a read that
 * carries a `language` is a step something wrote wrong, and it is refused
 * rather than typed out of existence. Which field belongs to which action is
 * `PARAMS_OF` in shared/ledger.ts, one table, checked on read.
 *
 * EVERY FIELD IS OPTIONAL, and that is not laziness either. A project migrated
 * from a catalogue that predates all of this has a reading whose generation
 * nobody wrote down and a translation whose language is only visible in a
 * filename. Requiring the fields would force the migration to invent them, and
 * a migration that writes fiction into somebody's project is worse than one
 * that admits what the old catalogue did not say.
 */
export interface LedgerParams {
  /**
   * `read`, `curate` — which pass over the pages this is about.
   *
   * See `ProjectReading.generation`. A re-read mints a new one, which is
   * precisely why it is EXCLUDED from the re-run comparison: two readings of
   * one book are the same question asked twice, and comparing the answers'
   * generations would make every re-read a new branch — the rule inverted.
   */
  generation?: string;
  /**
   * `read` — page answers in the bank when it completed.
   *
   * AN ANSWER, NOT A QUESTION, which is why it is in `MINTED_BY_THE_RUN` beside
   * the generation: it is counted off the bank AFTER the run, so a step carries
   * the number of pages that came back rather than the number anybody asked for.
   * It is here for the row's own sentence ("Read (317 pages)") and for nothing
   * else. What identifies a reading is `skipPages` and `language`.
   */
  pages?: number;
  /**
   * `read` — the engine's completion marker for THIS step's bank, `completedAt`
   * parsed to epoch milliseconds, as it stood when this step's generation was
   * minted. Absent for a step landed before this was recorded, and for one whose
   * run left no marker.
   *
   * WHAT IT IS FOR, in one sentence: it is how the app notices that the bank a
   * step names has been read again by something other than the app. See
   * `ProjectReading.completedAt`, which says the whole of it — this is the
   * per-step copy, and the per-step copy is the real one, because a branch has
   * its own bank and its own marker.
   *
   * ANOTHER ANSWER, NOT A QUESTION, so it goes in `MINTED_BY_THE_RUN` beside the
   * generation and the page count. Two readings of the same pages finish at two
   * different instants and are still the same question asked twice; comparing
   * the instants would make every re-read branch, which is the trap
   * `MINTED_BY_THE_RUN` was named for.
   */
  completedAt?: number;
  /** `curate` — how many decisions the snapshot froze. For the row's sentence. */
  amendments?: number;
  /**
   * `edit` — how many ops this Apply wrote. For the row's sentence, and nothing
   * else.
   *
   * A TALLY AND NOT A RECORD, on `amendments`' precedent exactly: the ops
   * themselves are the step's payload, because that is what a replay reads, and a
   * params bag is not a place to keep a second copy of a thing the file already
   * holds. The count is here so the row can say "Applied changes (5)" without
   * opening a file to find out.
   */
  ops?: number;
  /**
   * `metadata` — WHICH FIELDS THIS EDIT SET, by name, for the row's sentence.
   *
   * "Metadata (title, author)" rather than "Metadata", because a project can hold
   * half a dozen of these rows and a list of identical labels is a list nobody can
   * click on purpose. The names are the patch's own keys — `title`, `creator`,
   * `language` for a package, `title`, `author`, `subject`, `keywords` for a scan
   * — in the order the dialog composed them.
   *
   * THE NAMES AND NOT THE VALUES, which is the line this field is drawn on. What
   * was actually written is the step's PAYLOAD (`metadata/<uuid>.json`), because
   * that is what an export has to replay and a params bag is not a place to keep a
   * record something is made from. Putting the values here as well would be two
   * copies of one fact, and the day they disagreed the row would describe an edit
   * the export did not make.
   *
   * A LIST, so `readParams` checks it as one: it is the only param in this app that
   * is neither a word nor a count, and the alternative — a comma-joined string, on
   * `skipPages`' precedent — would be a list pretending to be a spelling. See
   * `LISTS` in shared/ledger.ts.
   */
  fields?: string[];
  /**
   * `translate` — the translation bank this run wrote, project-relative.
   *
   * WHAT IT IS FOR: a translation's payload is the EPUB, and the bank beside it is
   * the per-block record the EPUB was assembled from — the thing that makes
   * re-translating this row nearly free and the thing a rendering FROM this row
   * has to read. There is no longer one bank per book per language (two
   * translations into one language from two different steps are two banks,
   * `translationTarget`), so composing the path from the key and the tag would be
   * the same lie `readings/<key>.jsonl` was for readings: the older row naming a
   * file the newer run wrote over.
   *
   * AN ANSWER, NOT A QUESTION, so it sits in `MINTED_BY_THE_RUN` beside the
   * reading's generation and page count. Nobody chose it — the plan composed it
   * out of the replace-or-branch decision itself — and comparing it would make a
   * bank that ever moved look like a different translation.
   *
   * ABSENT ON EVERY TRANSLATION MADE BEFORE THIS WAS RECORDED, and those fall back
   * to the path their language composes (`translationBankOf`), which is the only
   * name `planTranslation` could ever have written.
   */
  bank?: string;
  /**
   * `read` — `--skip-pages`, verbatim: "3,17,19-24". See `ReadRequest.skipPages`.
   *
   * ONE OF THE TWO THINGS A READING IS IDENTIFIED BY. Reading the book again
   * with the same pages left out is the same question asked twice and replaces;
   * reading it with a different range is a different question and branches. It
   * is stored exactly as the engine was given it, because the string IS what was
   * asked — "3,17" and "17,3" are two ways of saying one thing and this app does
   * not claim to know that, so they branch. Absent means nothing was skipped.
   */
  skipPages?: string;
  /**
   * `translate` — the language this translation was made OUT OF, when it was made
   * out of another translation.
   *
   * ── Why a chain records both ends and a single hop records neither ──────────
   *
   * "Translated (hu)" is a complete sentence about a book read in German: there is
   * one other language in the story and it is the book's. It stops being one the
   * moment a project holds *German → English → Hungarian*, because two rows then
   * say "Translated (hu)" and "Translated (en)" while the interesting fact — which
   * of them the Hungarian was made from — is legible only by walking the parents.
   * So a chained run records the language it consumed and `labelFor` says both
   * ends: "Translated (en → hu)". A run made straight from the book records
   * nothing here, and its row keeps the words it has always had.
   *
   * AN ANSWER, NOT A QUESTION (`MINTED_BY_THE_RUN`). Nobody typed it: the plan
   * read it off the parent translate step, which `reRunTarget` already compares by
   * identity before it looks at any param — so comparing this as well would be a
   * second opinion about the same fact, and a parent whose own language was
   * corrected would make its child unrecognisable to the row it should replace.
   */
  from?: string;
  /**
   * `read` — `--language`, the BCP-47 tag the pages were declared to be in.
   * `translate` — the language translated INTO, as the dialog named it.
   *
   * ONE FIELD FOR TWO ACTIONS, which is worth saying out loud because they are
   * not the same fact: one says what the model should expect to see, the other
   * says what it should produce. They share a key because both are the language
   * THAT ACTION WAS ASKED FOR — the same word the engine's own flag uses — and
   * `PARAMS_OF` keys the meaning by action, so nothing ever has to read one and
   * wonder which question it answers.
   */
  language?: string;
}

/**
 * One retained payload, and what it was made from.
 *
 * THE PARENT IS THE WHOLE DESIGN. Photoshop's history truncates: act from an
 * earlier state and everything after it is gone. This one appends — a step
 * records which step it was made FROM, so translating from the reading a second
 * time adds a second translation rather than erasing the first. Structurally
 * that is a tree; the UI draws it as a flat chronological list with one quiet
 * "from …" annotation where the chain jumps, and that annotation is the entire
 * concession to the tree.
 */
export interface LedgerStep {
  /** Unique within this project's ledger, and never reused after a delete. */
  id: string;
  /** The step this was made from. Null for the origin, and only the origin. */
  parent: string | null;
  action: StepAction;
  /**
   * PROJECT-RELATIVE, forward slashes: `archive/Book.pdf`, `readings/<key>.jsonl`,
   * `curations/<uuid>.json`. Never absolute, never a basename.
   *
   * The house rule about never matching files by basename across directories is
   * why: a project holds several files of one name in different layers, and a
   * path that had lost its layer would let a delete take the wrong one.
   */
  payload: string;
  params?: LedgerParams;
  /**
   * What it would cost to get this payload back. See `ProjectStep.retention`.
   *
   * A FUNCTION OF THE ACTION, and written down anyway. The sweep and the delete
   * confirm ask this question without knowing the action vocabulary, and one
   * answer recorded by the code that knew beats the same rule re-derived at
   * four call sites. `parseLedger` refuses a row whose retention disagrees with
   * its action — a stored file calling a reading `regenerable` would be a file
   * authorising a sweep to delete hours of GPU.
   */
  retention: StepRetention;
  createdAt: number;
  /**
   * What the row says, in the app's own voice: "Read (17 pages)", "Applied
   * changes (23)", "Translated (Hungarian)". Never a filename.
   *
   * STORED, NOT DERIVED, which is why a project can hold two spellings of one
   * kind of row: `labelFor` is asked once, when the step is recorded, and a
   * rename of the vocabulary afterwards leaves the old rows saying what they were
   * stamped with. Nothing keys off the words — the action does — and rewriting a
   * person's history to tidy the app's own naming would be editing the record of
   * what happened to their book.
   */
  label: string;
  /**
   * Set when an ancestor's payload was replaced by a re-run.
   *
   * A DISPLAY STATE AND NOT A DELETION. A translation made from a reading that
   * has since been replaced still has its own bank, and that bank is still a
   * true record of what was translated — so the row stays clickable, dimmed,
   * with the reason on hover. Absent is the ordinary state; the field is only
   * ever written as `true`.
   */
  stale?: boolean;
}

/**
 * A project's steps and the pointer standing in them.
 *
 * ORDER IS PART OF THE VALUE. `steps` is in creation order and `parseLedger`
 * refuses a file where it is not, because that order IS the chronological list
 * the UI draws and the thing "the row immediately above" means.
 */
export interface ProjectLedger {
  /**
   * Which step the user is standing on. ABSENT MEANS THE NEWEST, which is the
   * state a project spends nearly all its life in — a pointer written on every
   * append would be a manifest rewritten for a fact already implied by the
   * array.
   */
  position?: string;
  steps: LedgerStep[];
}

/**
 * One row of the Steps accordion: the step, and the one word about its parent.
 *
 * `from` IS NULL FOR ALMOST EVERY ROW and that is the design working. It is
 * only set when the step's parent is not the row immediately above it — the
 * moment somebody stepped back and acted from an earlier state — so a project
 * that was worked straight through draws as a plain list with no annotations at
 * all, and the one book where somebody branched shows exactly where.
 */
export interface StepRow {
  step: LedgerStep;
  /** The parent's label, when the chain jumps. Null when it does not. */
  from: string | null;
}

/** One step a delete would take, and what losing it costs. */
export interface StepCasualty {
  id: string;
  /** The step's own label — "Read (317 pages)". Never a filename. */
  label: string;
  /**
   * `deleteCost`'s sentence, verbatim, composed in MAIN.
   *
   * The renderer draws the card and owns nothing about the words, exactly as it
   * does for `DeletionPrompt`. The three retentions are three genuinely different
   * losses and the sentence for each is written once, in shared/ledger.ts, so
   * that every warning in this app says the same words about the same loss.
   */
  cost: string;
  /** True for a row that was already dimmed. It still costs what it costs. */
  stale: boolean;
}

/**
 * What deleting one step would take with it — the facts, not the card.
 *
 * DESCRIBED AND DELETED BY TWO CALLS, exactly as a document is. The describe
 * composes the facts AND proves the delete is currently allowed, so the app never
 * puts a warning on screen for something it would refuse a click later; the
 * delete proves it again, because a renderer that skipped the question must meet
 * the same refusal.
 */
export interface StepDeletion {
  /** The step the ✕ was pressed on. */
  stepId: string;
  label: string;
  /**
   * Every step that goes, in creation order, the named one among them.
   *
   * A DELETE CASCADES AND EVERY CASUALTY IS NAMED — that was the ruling, and the
   * naming is what makes the cascade safe. Somebody deleting a reading is
   * deleting the translations made from it, and the only version of that which is
   * not a surprise is the one where they read the list first.
   */
  casualties: StepCasualty[];
  /**
   * The payload files this delete would actually destroy, as absolute paths, so
   * the window can let go of any it has open BEFORE main is asked to unlink them.
   *
   * ── Why the renderer is told, when main refuses anyway ──────────────────────
   *
   * The document delete settled this shape and the step delete follows it: MAIN
   * REFUSES an open book (`deleteDocument` throws while the working tree is held)
   * and the RENDERER CLOSES THE TAB between the confirm and the call, because
   * only the renderer can. Main cannot close a tab — tabs are the window's — and
   * without the close, deleting a translation whose EPUB is open would meet
   * main's refusal one line after the user said yes, which is a dialog that asks
   * a question and then declines to act on the answer.
   *
   * ABSOLUTE, because that is what a tab's path is, and matching a tab by
   * anything less than a whole path is the basename matching this codebase has
   * already paid for twice. Only the files that are genuinely being destroyed are
   * listed: a payload some surviving step still names stays on disk, and closing
   * the book showing it would be shutting a document nothing happened to.
   */
  files: string[];
  /**
   * What ELSE goes with those payloads, in a sentence, or null when it is only
   * the files themselves.
   *
   * ── Because a confirm may not destroy something it did not name ─────────────
   *
   * A payload does not travel alone. A translation's EPUB has a working copy
   * unpacked from it, an undo history named after that copy, and however many
   * versions earlier runs rotated aside; a reading's bank has its own archived
   * predecessors. All of it is swept, because a delete that left it would leave
   * bytes nothing in the app can ever reach again — and all of it therefore has to
   * be said out loud first, in the same card, before somebody agrees.
   *
   * A SENTENCE RATHER THAN THREE COUNTS, for `StepCasualty.cost`'s reason: main
   * is the only side that knows what is on the disk, and a renderer composing this
   * from numbers would arrive at "and 3 other items" within a month.
   */
  belongings: string | null;
}
