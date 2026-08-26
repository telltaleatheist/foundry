/**
 * analyze/nli-bridge — the seam between foundry and the entailment model.
 *
 * ── THE FIRST RESIDENT WORKER ───────────────────────────────────────────────
 *
 * `vlm/bridge.ts` is a BATCH seam: the config goes in, stdin closes, pages come
 * back, the process ends. This one is RESIDENT. The model costs ten to ninety
 * seconds to load and a book is scored in at least two passes (sentences, then
 * sliding windows), so stdin stays open, requests and responses interleave as
 * newline-delimited JSON, EOF is the shutdown and SIGKILL after two seconds is
 * the backstop for an interpreter that has wedged.
 *
 * The wire contract is briefcase's, kept verbatim so its measurements transfer
 * — see `nli_worker.py`'s docstring, which is the other half of it, and
 * docs/ANALYSIS.md §4, which is the contract both are written against.
 *
 * ── PER-REQUEST FAILURE AND PROCESS DEATH ARE DIFFERENT OUTCOMES ────────────
 *
 * A worker that answers `{"id": n, "error": "..."}` has decided it cannot score
 * ONE request; it is still alive and the next request may well succeed. That is
 * an `NliRequestError` and the caller decides. A worker that EXITS has ended the
 * run: every pending request is rejected with the same reason, the worker is
 * marked dead, and every later call refuses immediately rather than spawning a
 * second interpreter behind the caller's back.
 *
 * NEITHER IS A FALLBACK. briefcase degrades to an LLM discovery pass when its
 * worker is missing; Foundry does not have one and is not growing one
 * (ARCHITECTURE.md §8, docs/ANALYSIS.md §9). A missing interpreter, a missing
 * package and a missing model each end the run with a sentence naming what was
 * looked for and where — and the report keeps every verdict that had already
 * landed, which is resumability and not degradation.
 *
 * ── THE SCRIPT TRAVELS WITH THE BRIDGE ──────────────────────────────────────
 *
 * `nli_worker.py` is imported as TEXT (`with { type: 'text' }`) so a compiled
 * binary carries its own copy, and materialised to tmp under a name derived
 * from its CONTENT — `vlm/bridge.ts`'s trick, for its reasons: `bun build
 * --compile` cannot hand an external interpreter a path inside the executable,
 * a changed helper writes a different file rather than running an old one out
 * of a cache, and two foundry versions on one machine cannot fight over the
 * same path. The `.d.ts` shim that makes tsc accept a `.py` import already
 * exists and is a wildcard (`src/vlm/py-text.d.ts`, `declare module '*.py'`),
 * so it covers this import too; a second copy of the same ambient declaration
 * would be a duplicate identifier rather than a second shim.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The worker's source, embedded at build time. See `scriptPath()`.
import NLI_WORKER_SOURCE from './nli_worker.py' with { type: 'text' };

import { ensureDir } from '../fsdirs.js';

/**
 * The model, named on this side too.
 *
 * It is in the report header as the provenance of every score in the file, and
 * `nli_worker.py` holds the same constant. The ready line carries the worker's
 * copy and this module CHECKS the two agree — a header claiming
 * deberta-v3-base while some other worker had actually answered would be a
 * false claim about how the whole book was scored, and it would be invisible.
 */
export const NLI_MODEL_ID = 'MoritzLaurer/deberta-v3-base-zeroshot-v2.0';

/** The worker could not be started, or has died. The run ends. */
export class NliWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NliWorkerError';
  }
}

/** The worker refused ONE request and is still alive. */
export class NliRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NliRequestError';
  }
}

/**
 * How long to wait for the ready line — the model load.
 *
 * briefcase's 180 s, kept. It is generous because a cold load off a spinning
 * disk with a cold page cache genuinely takes a minute, and a timeout that
 * fires on slow-but-working makes the feature look broken on the hardware it is
 * for. What it protects against is an interpreter that will never answer.
 */
const READY_TIMEOUT_MS = 180_000;

/**
 * How long to wait for one scoring response.
 *
 * briefcase's 600 s, kept, and it is a per-REQUEST budget rather than a
 * per-sentence one: a request is the whole sentence pass or the whole window
 * pass of a book. briefcase measured one pass over a 60-minute transcript (801
 * sentences) at about 45 s on MPS; a three-hundred-page book is an order of
 * magnitude more text, which is what the order-of-magnitude headroom is for.
 */
const SCORE_TIMEOUT_MS = 600_000;

/** How long a wedged interpreter gets between EOF and SIGKILL. briefcase's 2 s. */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * Where `nli_worker.py` is. See this file's header for why it is embedded.
 */
function scriptPath(): string {
  const override = process.env['FOUNDRY_NLI_SCRIPT'];
  if (override) {
    if (!fs.existsSync(override)) {
      throw new NliWorkerError(`FOUNDRY_NLI_SCRIPT points at ${override}, which does not exist`);
    }
    return override;
  }
  // Source tree: the file beside this module IS the worker, and running it
  // directly is what makes an edit take effect without a build step.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(here, 'nli_worker.py');
  if (fs.existsSync(beside)) return beside;

  const digest = createHash('sha256').update(NLI_WORKER_SOURCE).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'foundry-nli');
  const materialised = path.join(dir, `nli_worker-${digest}.py`);
  if (!fs.existsSync(materialised)) {
    ensureDir(dir);
    // Written beside the target and renamed: two foundry runs starting at once
    // must never hand python a half-written script.
    const partial = `${materialised}.${process.pid}.part`;
    fs.writeFileSync(partial, NLI_WORKER_SOURCE, 'utf8');
    fs.renameSync(partial, materialised);
  }
  return materialised;
}

/**
 * Interpreter candidates for the NLI worker — NAMED, never searched for.
 *
 * ── WHY THIS IS NOT `defaultLocalPythonCandidates()` ────────────────────────
 *
 * That list is the RASTERISER's: conda `vlmtest`, which holds PyMuPDF and
 * mlx-vlm. This worker needs torch and transformers, which are a different
 * installation entirely, and `FOUNDRY_VLM_PYTHON` means the first one — so
 * overloading either the variable or the list would make a `doctor` report
 * about one environment into a claim about another (docs/ANALYSIS.md §2).
 *
 * The two BookForge-shipped environments really do carry torch, because that is
 * what its text-to-speech runs on, so they are worth naming; the conda `nli`
 * env is the name this program would suggest to somebody making one. NOTHING IS
 * PROBED ON PATH: `python3` on a developer machine is whatever Homebrew last
 * installed, and picking it up would produce an ImportError from a subprocess
 * about a package the operator installed an hour ago somewhere else.
 *
 * The real answer for the first cut is `--nli-python` (docs/ANALYSIS.md §9 —
 * there is no shipped NLI environment yet), and every miss prints this whole
 * list so a person knows exactly what to pass.
 */
export function defaultNliPythonCandidates(): string[] {
  const home = os.homedir();
  const roots = [
    ...(process.platform === 'darwin' ? ['/opt/homebrew/Caskroom/miniconda/base'] : []),
    path.join(home, 'miniconda3'),
    path.join(home, 'miniforge3'),
    path.join(home, 'anaconda3'),
  ];
  const conda = roots.map((root) => (process.platform === 'win32'
    ? path.join(root, 'envs', 'nli', 'python.exe')
    : path.join(root, 'envs', 'nli', 'bin', 'python')));

  const bookforgeRuntime = process.platform === 'win32'
    ? path.join(
      process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'),
      'bookforge', 'runtime', 'e2a-env', 'python.exe',
    )
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'bookforge', 'runtime', 'e2a-env', 'bin', 'python')
      : path.join(home, '.config', 'bookforge', 'runtime', 'e2a-env', 'bin', 'python');
  const e2aCheckout = process.platform === 'win32'
    ? path.join(home, 'Projects', 'ebook2audiobook', 'python_env', 'python.exe')
    : path.join(home, 'Projects', 'ebook2audiobook', 'python_env', 'bin', 'python');

  return [...conda, bookforgeRuntime, e2aCheckout];
}

/** The interpreter this run uses, or a refusal naming every path tried. */
export function resolveNliPython(explicit?: string): string {
  const named = explicit ?? process.env['FOUNDRY_NLI_PYTHON'];
  if (named) {
    if (!fs.existsSync(named)) {
      throw new NliWorkerError(
        `${explicit ? '--nli-python' : 'FOUNDRY_NLI_PYTHON'} ${named} does not exist`,
      );
    }
    return named;
  }
  const candidates = defaultNliPythonCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new NliWorkerError(
    'no Python for the analysis worker was found. It needs torch and transformers, plus the '
    + `${NLI_MODEL_ID} weights; name the interpreter with --nli-python or FOUNDRY_NLI_PYTHON. `
    + 'Tried:\n'
    + candidates.map((c) => `  ${c}`).join('\n'),
  );
}

/**
 * Where the weights live — `HF_HOME` for the worker.
 *
 * ── WHY THIS IS A DECISION AND NOT AN OBVIOUS DEFAULT ───────────────────────
 *
 * briefcase put `HF_HOME` inside its worker DIRECTORY, which it also owned and
 * provisioned. Foundry has no worker directory: the script is materialised into
 * tmp by content hash, and tmp is swept — a 750 MB model cache under a
 * temporary name would be downloaded again after every reboot on some machines
 * and never on others. Beside the INTERPRETER is worse: a conda env or
 * BookForge's shipped runtime is shared, sometimes read-only, and model weights
 * are not part of somebody else's environment.
 *
 * So the precedence is, in order:
 *
 *   1. `--nli-home`, because a flag is always the answer;
 *   2. `FOUNDRY_NLI_HOME`, its environment spelling;
 *   3. AN `HF_HOME` THE PERSON ALREADY SET, honoured verbatim — somebody who
 *      has told their whole machine where its Hugging Face cache is has already
 *      answered this question, and a program that quietly overrode them would
 *      re-download a model that is on the disk;
 *   4. foundry's own config directory, `<config>/nli` — stable, user-owned,
 *      backed up with the rest of a profile, and the same root `settings.json`
 *      lives under.
 *
 * A run that finds nothing there refuses by name and points at
 * `--fetch-nli-model`, which is the one door that may write into it.
 */
export function nliHome(explicit?: string): string {
  const named = explicit ?? process.env['FOUNDRY_NLI_HOME'] ?? process.env['HF_HOME'];
  if (named && named.trim().length > 0) return named;
  return path.join(configDirForCache(), 'nli');
}

/**
 * `backend/settings.ts`'s `configDir()`, restated for the one case it refuses.
 *
 * That function THROWS when `%APPDATA%` is unset, which is right for a settings
 * file — there is nowhere to write one and the person needs to know. Here there
 * is a perfectly good answer for that machine (the profile directory), and a
 * cache location is not worth ending a run over. Everything else is the same
 * three paths, deliberately, so a foundry profile is one directory.
 */
function configDirForCache(): string {
  const override = process.env['FOUNDRY_CONFIG_DIR'];
  if (override) return override;
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'foundry',
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'foundry');
    default:
      return path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'foundry');
  }
}

export interface NliWorkerOptions {
  /** `--nli-python`, or the env, or a named candidate. */
  python?: string;
  /** `--nli-home`, or the env, or foundry's config directory. */
  home?: string;
  /**
   * `--fetch-nli-model` / `FOUNDRY_NLI_FETCH=1`: lift the offline variables for
   * this run so the weights can be pulled ONCE. See the field's use below.
   */
  fetch?: boolean;
  /** Progress and diagnostics. stderr, per the house rule. */
  log: (line: string) => void;
}

interface WorkerResponse {
  id?: number;
  ready?: boolean;
  device?: string;
  model?: string;
  scores?: number[][];
  error?: string;
  /** The worker's traceback tail when `error` is set — see the worker's except. */
  trace?: string;
}

/**
 * A text the tokenizer will accept, with every offset into it still true.
 *
 * A SCANNED BOOK CARRIES BROKEN CHARACTERS, and one of them is a hard stop
 * three layers down. Flashpoint of Revival (2026-08-25): the reading pipeline
 * mangled a close-quote (`”`, three UTF-8 bytes) into U+FFFD followed by a
 * LONE LOW SURROGATE — a code unit that is legal in a JS string and in a JSON
 * escape and in a Python str, and unencodable as UTF-8. `JSON.stringify`
 * carries it to the worker intact (well-formed stringify escapes it as
 * `\udc9d`), `json.loads` rebuilds it, and the Rust tokenizer under
 * transformers refuses the string at the PyO3 boundary with the five words
 * that cost this project an evening: `TextInputSequence must be str`. Every
 * plainer probe passes — the sentence LOOKS like a string from every side but
 * the one the scorer stands on.
 *
 * So each unpaired surrogate becomes U+FFFD here, at the seam, before the
 * wire. ONE CODE UNIT FOR ONE CODE UNIT — the substitution never moves an
 * offset, so the `[start, end)` a finding carries into the report still names
 * the same characters of the row the book file holds. Scoring-only: nothing
 * this function touches is ever written anywhere.
 */
export function scorableText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
}

/**
 * One resident worker, from spawn to shutdown.
 *
 * `start()` resolves when the model is loaded, `score()` is one round trip, and
 * `stop()` is EOF plus the SIGKILL backstop. There is no restart: a worker that
 * died took the run with it (see the header), and the caller's next act is to
 * write down what it already has.
 */
export class NliWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (scores: number[][]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Set the moment the process is gone. Every later call refuses with it. */
  private dead: string | null = null;
  /** True while `stop()` is tearing it down, so the exit is not a fault. */
  private stopping = false;
  /** The last 40 lines the worker wrote to stderr — the error message's body. */
  private readonly stderrTail: string[] = [];
  private ready = false;
  /** Which device the worker reported. Read for the log line, once. */
  device = 'unknown';

  private constructor(readonly python: string, readonly script: string, private readonly log: (line: string) => void) {}

  /**
   * Spawn the worker and wait for its ready line.
   *
   * The environment is the parent's plus four variables:
   *
   *  - `HF_HOME` — where the weights are (see `nliHome`);
   *  - `HF_HUB_OFFLINE` and `TRANSFORMERS_OFFLINE` — an analysis NEVER blocks on
   *    a network fetch, so a missing model refuses in a second instead of an
   *    hour into a run. Both are lifted, and only both, by `--fetch-nli-model`,
   *    whose entire purpose is to make the one download that this rule
   *    otherwise forbids;
   *  - `TOKENIZERS_PARALLELISM=false` — briefcase's, and it silences the fork
   *    warning that tokenizers prints on every request.
   */
  static async start(options: NliWorkerOptions): Promise<NliWorker> {
    const python = resolveNliPython(options.python);
    const script = scriptPath();
    const home = nliHome(options.home);
    ensureDir(home);

    const worker = new NliWorker(python, script, options.log);
    const offline = options.fetch === true
      ? {}
      : { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    if (options.fetch === true) {
      options.log(
        `analyze: --fetch-nli-model — the worker may download ${NLI_MODEL_ID} into ${home} this `
        + 'once. Every run without the flag is offline and refuses rather than fetching.',
      );
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(python, ['-u', script], {
        env: { ...process.env, HF_HOME: home, TOKENIZERS_PARALLELISM: 'false', ...offline },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new NliWorkerError(`could not start ${python}: ${(error as Error).message}`);
    }
    worker.child = child;
    worker.attach(child);

    await worker.waitForReady(home);
    return worker;
  }

  /** Wire the two streams up. Everything below is driven by these two handlers. */
  private attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message: WorkerResponse;
        try {
          message = JSON.parse(line) as WorkerResponse;
        } catch {
          /*
           * The worker points fd 1 at stderr precisely so this cannot happen.
           * If it does, something below Python is writing to the protocol
           * channel, and the line is reported rather than parsed as a score.
           */
          this.log(`analyze: the analysis worker sent a line that is not JSON: ${line.slice(0, 200)}`);
          continue;
        }
        this.deliver(message);
      }
    });

    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      let newline = stderr.indexOf('\n');
      while (newline !== -1) {
        const line = stderr.slice(0, newline);
        stderr = stderr.slice(newline + 1);
        newline = stderr.indexOf('\n');
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        /*
         * The LOAD is echoed and the scoring is not. Before the model is up
         * there is nothing else on screen and a person waiting ninety seconds
         * deserves to see what the interpreter is doing; after it, transformers
         * draws a progress bar per batch and echoing them would bury the run's
         * own progress lines under thousands of carriage returns.
         */
        if (!this.ready && line.trim().length > 0) this.log(`analyze: [nli] ${line.trim()}`);
      }
    });

    child.on('error', (error) => this.die(`worker process error: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      const detail = this.stderrTail.map((l) => l.trim()).filter((l) => l.length > 0).slice(-5);
      this.die(
        `the analysis worker exited (code=${code}, signal=${signal})`
        + (detail.length > 0 ? `. Its last output:\n${detail.map((l) => `  ${l}`).join('\n')}` : ''),
      );
    });
  }

  /**
   * The ready line, or a refusal.
   *
   * The MODEL CHECK is here rather than trusted: the report header names the
   * NLI model as the provenance of every score in the file, and this is the one
   * moment the claim can be tested against what actually loaded.
   */
  private async waitForReady(home: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(new NliWorkerError(
          `the analysis worker did not load ${NLI_MODEL_ID} within ${READY_TIMEOUT_MS / 1000}s. It was `
          + `run as ${this.python} with its model cache at ${home}.`,
        ));
      }, READY_TIMEOUT_MS);
      this.readyWaiter = {
        resolve: (message) => {
          clearTimeout(timer);
          this.readyWaiter = null;
          if (typeof message.model === 'string' && message.model !== NLI_MODEL_ID) {
            reject(new NliWorkerError(
              `the analysis worker loaded ${message.model} and this foundry writes reports that name `
              + `${NLI_MODEL_ID}. A report claiming one model for scores another produced is a false `
              + 'record of how the book was read.',
            ));
            return;
          }
          this.ready = true;
          this.device = message.device ?? 'unknown';
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.readyWaiter = null;
          reject(error);
        },
      };
    });

    this.log(
      `analyze: ${NLI_MODEL_ID} is loaded on ${this.device} (${this.python})`
      + (this.device === 'cpu'
        ? ' — no GPU was offered to it, so ranking will take minutes rather than seconds'
        : ''),
    );
  }

  private readyWaiter: {
    resolve: (message: WorkerResponse) => void;
    reject: (error: Error) => void;
  } | null = null;

  /** One response line: the ready handshake, or an answer to a pending request. */
  private deliver(message: WorkerResponse): void {
    if (message.ready === true) {
      this.readyWaiter?.resolve(message);
      return;
    }
    const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id as number);
    if (typeof message.error === 'string') {
      const trace = typeof message.trace === 'string' && message.trace.trim().length > 0
        ? `\n${message.trace.trim().split('\n').map((l) => `  ${l}`).join('\n')}`
        : '';
      entry.reject(new NliRequestError(message.error + trace));
      return;
    }
    entry.resolve(message.scores ?? []);
  }

  /**
   * The worker is gone. Everything waiting on it fails with the same sentence,
   * and every later call fails with it too — there is no second attempt, because
   * a worker that died once on a machine will die the same way on the retry and
   * the second minute of waiting buys nothing.
   */
  private die(reason: string): void {
    if (this.dead === null) this.dead = reason;
    const error = new NliWorkerError(this.dead);
    this.readyWaiter?.reject(error);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  /**
   * One request/response round trip: `texts` x `hypotheses`, row-major.
   *
   * A per-request refusal from the worker arrives as `NliRequestError`; a dead
   * worker as `NliWorkerError`. See the header for why the caller must be able
   * to tell them apart.
   */
  async score(texts: readonly string[], hypotheses: readonly string[]): Promise<number[][]> {
    if (this.dead !== null) throw new NliWorkerError(this.dead);
    const child = this.child;
    if (child === null) throw new NliWorkerError('the analysis worker is not running');
    if (texts.length === 0 || hypotheses.length === 0) return [];

    const sane = texts.map(scorableText);
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NliWorkerError(
          `the analysis worker did not answer a ${texts.length}-text request within `
          + `${SCORE_TIMEOUT_MS / 1000}s`,
        ));
      }, SCORE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, texts: sane, hypotheses })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new NliWorkerError(`could not write to the analysis worker: ${(error as Error).message}`));
      }
    });
  }

  /**
   * Give the memory back.
   *
   * EOF is the documented exit and SIGKILL is only the backstop for a wedged
   * interpreter. Best-effort and never throwing, for `unloadModel`'s reason: it
   * runs after the report has been written, and a run that produced everything
   * it was asked for must not be reported as failed because a subprocess was
   * slow to close.
   */
  stop(): void {
    const child = this.child;
    if (child === null) return;
    this.stopping = true;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, SHUTDOWN_GRACE_MS);
    killer.unref?.();
    child.once('exit', () => clearTimeout(killer));
  }
}
