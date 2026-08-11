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

/** What a job produces. `epub` is the only thing the engine casts today. */
export type JobKind = 'epub';

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
   */
  phase: 'render' | 'read';
}

/** Everything the OCR panel decides before a job is enqueued. */
export interface JobRequest {
  inputPath: string;
  outputPath: string;
  kind: JobKind;
  /** Overrides the configured backend endpoint for this job only. */
  endpointUrl?: string;
  /** `--readings`: bank each page's answer so an interrupted run resumes. */
  readingsPath?: string;
  /** `--skip-pages`, verbatim: "3,17,19-24". */
  skipPages?: string;
  /** `--chapters`: write the chapter proposals out beside the book. */
  chaptersPath?: string;
}

export interface Job {
  id: string;
  inputPath: string;
  outputPath: string;
  kind: JobKind;
  state: JobState;
  progress: JobProgress | null;
  /** The engine's own words on a failure. Never paraphrased, never an exit code. */
  error?: string;
  /** The last line the engine wrote — the job log, one line deep. */
  message?: string;
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
