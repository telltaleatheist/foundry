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
   * NO `--skip-pages` AND NO `--language` HERE, and their absence is the split
   * doing its work. Both are statements about READING the book — which pages are
   * not part of it, and what language the pages are in — so they are answered
   * once, in the OCR dialog, and are facts about the bank from then on. A
   * rendering that could be given a different page-skip from the reading it
   * renders would be a rendering of a book that was never read.
   */
}

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
  /** The EPUB to read. Never written to. */
  inputPath: string;
  /** From `WorkspacePlan.outputPath`. The managed workspace, always. */
  outputPath: string;
  /** `--to`: the BCP-47 tag to translate INTO. */
  to: string;
  /** `--from`. Absent means the model is told to determine it. */
  from?: string;
  /** `--model`: the Ollama model that translates. */
  model: string;
  /** `--ollama`: the server's URL. Used, never started. */
  ollama: string;
  /** `--instructions`: appended to the system prompt verbatim, per book. */
  instructions?: string;
  /**
   * `--bank`: where each accepted block is written the moment it is accepted.
   *
   * From `planTranslation`, and passed on every translation — a translation is
   * hours of GPU and a run that dies at block 400 of 456 used to have written
   * nothing at all. The engine keys every entry by the whole QUESTION (model,
   * languages, instructions, the block's own text), so a resumed run asks only
   * for what it still owes, and editing one paragraph re-asks that paragraph.
   */
  bankPath: string;
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
  readingsPath: string;
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
 * ── Why it counts passes rather than being stamped by the job ───────────────
 *
 * The obvious design mints a uuid when a conversion finishes. It is wrong in one
 * ordinary case and the case is common: converting a book to plain text after
 * curating its EPUB runs the engine again, records another step, and replays the
 * SAME bank — every block identical, every amendment still exactly about the
 * block it was made about. A generation minted per job would throw that curation
 * aside and tell the user their corrections had been archived, for a run that
 * changed nothing.
 *
 * So the generation is bound to the thing that actually moves: `passes` is how
 * many banks the `readings/archived-<stamp>` folders held when it was minted, and
 * the engine's `archiveReadingsBank` is the only thing that puts one there. A re-read
 * increments it and a re-render does not, which is precisely the distinction the
 * overlay cares about.
 */
export interface ProjectReading {
  /** The uuid the overlay file and its undo ledger both carry. */
  generation: string;
  /** Archived banks under `readings/` when this generation was minted. */
  passes: number;
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
 * TWO FACTS, kept apart because they are different losses. `unsaved` is "no copy
 * of this exists anywhere you chose" — the Chrome dot. `modified` is "you have
 * edited this since the copy you chose was written", which only means anything
 * once there IS such a copy. Main writes a different sentence for each, and a
 * tab that is neither closes without a question.
 */
export interface CloseWarning {
  title: string;
  unsaved: boolean;
  modified: boolean;
  /** Where a copy was last written, when there is one. */
  savedPath: string | null;
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
  /** The file as it stands, or an empty one bound to the current reading. */
  file: OverlayFileWire;
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
    at: { page: number; order: number; part?: number };
    strike?: boolean;
    category?: string;
    text?: string;
  }[];
  /** Absent means the engine decides. See `OverlayFile.chapters`. */
  chapters?: { at: { page: number; order: number; part?: number }; title: string }[];
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
 * The four things that mint a step. Everything else a project does is free.
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
 * NO `generate`, deliberately. A rendering is reproducible from its step's
 * payload at any time, and minting a step for one would put a filename where an
 * action belongs. If "what did I export and when" is ever wanted, it is an
 * export log — a separate thing, and not this.
 */
export type StepAction = 'import' | 'read' | 'curate' | 'translate';

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
  /** `read` — page answers in the bank when it completed. */
  pages?: number;
  /** `curate` — how many decisions the snapshot froze. For the row's sentence. */
  amendments?: number;
  /** `translate` — the language translated INTO, as the dialog named it. */
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
   * What the row says, in the app's own voice: "Read (17 pages)", "Saved
   * corrections (23)", "Translated (Hungarian)". Never a filename.
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
