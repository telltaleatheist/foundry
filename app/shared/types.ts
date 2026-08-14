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
export type JobKind = ConversionKind | 'env-install' | 'translate';

/**
 * What the OCR panel can ask for. An env install is never enqueued this way.
 *
 * It is also the engine's `--format`, spelled the same, because it is the same
 * decision: a job's kind IS the extension its output carries, and the two
 * drifting apart would mean the app naming a file `.epub` and the engine
 * writing text into it — which the engine refuses outright (src/vlm/text-out.ts).
 *
 * `pdf` is not a third way of writing the book. It is the SOURCE document with
 * an invisible text layer over its pages — the scan, made searchable — so it
 * comes out looking like what went in and the app can open it in the same PDF
 * tab it opens any other (src/vlm/pdf-layer.ts).
 */
export type ConversionKind = 'epub' | 'txt' | 'pdf';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

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
export interface JobRequest {
  inputPath: string;
  /** From `WorkspacePlan.outputPath`. The managed workspace, always. */
  outputPath: string;
  kind: ConversionKind;
  /** `--readings`, from `WorkspacePlan.readingsPath`. Always passed; see workspace.ts. */
  readingsPath: string;
  /** `--skip-pages`, verbatim: "3,17,19-24". */
  skipPages?: string;
  /** `--strip-note-markers`: drop footnote reference numbers. For a narration build. */
  stripNoteMarkers?: boolean;
  /** `--language`: the BCP-47 tag written as `dc:language`. Declared, never detected. */
  language?: string;
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
   * `<libraryDir>/projects/<key>/generated/<the book's name>.<ext>`.
   *
   * The GENERATED layer, because what the engine writes is an origin: it is the
   * record of what the model read, it is never written again, and the copy the
   * user edits is unpacked from it.
   */
  outputPath: string;
  /** `<libraryDir>/projects/<key>/readings/<key>.jsonl`. Passed on every job. */
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
 * `.epub`, and `searchable` is a `.pdf` that is the archived scan with a text
 * layer over it rather than a second way of writing the book.
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
}

/**
 * The live PDF — the one the user sees, and the one metadata edits will land in.
 *
 * A copy is made at import so the layer EXISTS from the start; writing to it is
 * not implemented yet, and this is the file that will be written when it is.
 * Remade from `generated/` when a searchable conversion lands, so "the PDF"
 * quietly becomes the one with a text layer without ever being a second row.
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
export interface ProjectManifest {
  /** 1. Bumped only when a reader of an older file would get it wrong. */
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
  generated: ProjectGenerated[];
  working: {
    trees: ProjectWorkingTree[];
    files: ProjectWorkingFile[];
  };
  final: ProjectFinal[];
}

/** One openable (or merely listable) document inside a project, as Home sees it. */
export interface ProjectDocument {
  path: string;
  kind: ProjectDocumentKind;
  /** This app's own reasoning about the row. Never rendered. */
  role: ProjectGeneratedRole | 'archive';
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
}
