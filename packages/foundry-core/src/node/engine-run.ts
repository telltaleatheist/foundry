/**
 * engine-run — which engine command runs, running it, killing it, and its doctor.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DoctorResult, EngineInfo } from '../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Which program
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineCommand {
  command: string;
  /** Fixed leading arguments — the bundle's path when this is Electron-as-Node, none for FOUNDRY_BIN. */
  args: string[];
  /**
   * What the child's environment gets on top of this process's, for EVERY run —
   * `ELECTRON_RUN_AS_NODE` for the bundle, nothing for FOUNDRY_BIN. A run's own
   * `extraEnv` goes on top of this.
   */
  env: Readonly<Record<string, string>>;
  source: string;
}

/**
 * The bundled engine: `engine/foundry-engine.cjs` in THIS PACKAGE, found from the
 * package's own `package.json` (FOUNDRY-CORE-PLAN step 3, 2026-11-04).
 *
 * One path in every place the package is installed, because `engine/` sits in
 * the package itself: this repo's `packages/foundry-core`, the copy an app has
 * in its `node_modules/@owen/foundry-core`, and a packaged app, where that copy
 * is in the archive with the rest of its dependencies. No host counts
 * directories from its own build any more; it asks the package.
 */
export function engineBundlePath(): string {
  return path.join(path.dirname(require.resolve('@owen/foundry-core/package.json')), 'engine', 'foundry-engine.cjs');
}

export let cached: EngineCommand | null = null;

/**
 * THE constant. Two answers, in precedence order:
 *
 *   1. `FOUNDRY_BIN` — an operator pointing at a build of their own. A command,
 *      run with the job's arguments and nothing in front of them.
 *   2. The bundled engine, `engine/foundry-engine.cjs`, run by THIS app's own
 *      Electron as Node (`ELECTRON_RUN_AS_NODE=1`).
 *
 * ── THE ENGINE IS CODE THAT MOVES WITH THE APP (2026-09-24) ─────────────────
 *
 * It used to be a `bun build --compile` executable — foundry.exe — shipped as
 * its own release, downloaded by BookForge as an add-on, and found here in
 * `resources/` or, in a dev checkout, run as `bun run src/cli.ts`. Owen: *"i
 * dont think it needs to be an exe anymore. it can be an engine but maybe we
 * should explode it out into normal code that moves along with the app."* So
 * the engine is bundled into this folder (tools/build-engine.mjs, committed and
 * checked against `src/` by the test suite), and there is no second program to
 * version, download or find. A dev checkout runs the same bundle as a packaged
 * app and as BookForge: an edit to `src/` takes effect after
 * `node tools/build-engine.mjs`, which `electron:dev` runs first.
 *
 * It is STILL A CHILD PROCESS — see tools/build-engine.mjs for why — and its
 * Node is the one in this Electron, so the engine can never find itself on a
 * runtime the app did not ship.
 *
 * A MISSING BUNDLE IS REFUSED BY NAME. It is part of the app folder, so its
 * absence is a broken copy or a broken package, never a state to route around.
 */
export function engineCommand(): EngineCommand {
  if (cached) return cached;

  const declared = process.env['FOUNDRY_BIN']?.trim();
  if (declared) {
    cached = { command: declared, args: [], env: {}, source: 'FOUNDRY_BIN' };
    return cached;
  }

  const bundle = engineBundlePath();
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `no engine: ${bundle} does not exist. It is part of the Foundry app folder `
      + '(engine/, written by tools/build-engine.mjs in the foundry repo), so this '
      + 'copy of the app is incomplete — re-copy or rebuild it.',
    );
  }
  cached = {
    command: process.execPath,
    args: [bundle],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    source: 'bundled engine',
  };
  return cached;
}

/** The environment one run is spawned with: this process's, the command's, then the run's own. */
export function childEnv(cmd: EngineCommand, extraEnv?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, ...cmd.env, ...(extraEnv ?? {}) };
}

/** `foundry --version`, or null. Asked once, at startup, for the settings screen. */
export function engineInfo(): EngineInfo {
  const cmd = engineCommand();
  let version: string | null = null;
  try {
    const probe = spawnSync(cmd.command, [...cmd.args, '--version'], {
      env: childEnv(cmd),
      timeout: 30_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (probe.status === 0) version = (probe.stdout || '').trim() || null;
  } catch {
    version = null;
  }
  return { command: cmd.command, args: cmd.args, source: cmd.source, version };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running it
// ─────────────────────────────────────────────────────────────────────────────

export interface RunHandle {
  /** Resolves when the child exits, however it exits. */
  done: Promise<{ code: number; stdout: string; stderr: string }>;
  /** Take the whole tree down. A cancel that left the model loaded is not a cancel. */
  cancel(): void;
}

export function runEngine(
  args: string[],
  onLine?: (line: string) => void,
  /**
   * WHAT THIS RUN'S ENVIRONMENT GETS ON TOP OF THE PROCESS'S — per spawn, and
   * the only way a credential ever reaches the engine.
   *
   * `FOUNDRY_ENDPOINT_HEADERS` is a JSON object of header name to value, and the
   * engine sends every pair on both its doors. It is an environment variable and
   * not a flag deliberately and permanently (docs/BOOKFORGE-HANDOFF.md, the
   * 2026-09-13 note): a command line is spelled into the terminal by the queue,
   * pasted into bug reports, and listed by the process table, and there should
   * never be a flag for this.
   *
   * PER SPAWN, WHICH IS WHY IT IS AN ARGUMENT rather than something set once on
   * `process.env`. Two rows in flight may be placed on two different Crucible
   * servers with two different tokens (docs/SLOTS.md §3), and a variable set on
   * this process would be one credential for both — sent to whichever server the
   * other row is talking to.
   *
   * ABSENT IS EXACTLY TODAY: the child inherits this process's environment and
   * nothing else, which is what every run in this app did before slots existed.
   */
  extraEnv?: Readonly<Record<string, string>>,
): RunHandle {
  const cmd = engineCommand();
  let child: ChildProcess | null = null;
  let cancelled = false;

  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child = spawn(cmd.command, [...cmd.args, ...args], {
      /*
       * A COPY, and the copy is load-bearing: `childEnv` builds a new object,
       * so nothing this run adds is visible to the next one. Spreading into `process.env` itself would set the variable on this
       * process, which is the failure the argument exists to prevent.
       */
      env: childEnv(cmd, extraEnv),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let pending = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!onLine) return;
      // Line-buffered, deliberately: see the module note.
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) onLine(line);
    });

    child.on('error', (err) => {
      resolve({
        code: 127,
        stdout,
        stderr: `${stderr}\n${cmd.command} could not be started (${cmd.source}): ${err.message}`,
      });
    });
    child.on('close', (code) => {
      if (pending.trim().length > 0 && onLine) onLine(pending);
      resolve({ code: cancelled ? -1 : (code ?? 1), stdout, stderr });
    });
  });

  return {
    done,
    cancel(): void {
      cancelled = true;
      killTree(child);
    },
  };
}

/**
 * Kill the child AND everything it started.
 *
 * The engine spawns Python (the rasteriser, and on a local route a reader that
 * holds a GPU). `child.kill()` reaches the
 * first of those and none of the rest, so a cancelled job would go on rendering
 * pages with nothing left listening — on Windows the only reliable answer is
 * taskkill's tree flag.
 */
export function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      return;
    } catch {
      // fall through to the signal
    }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `foundry doctor --json`, or a sentence saying why there is no report.
 *
 * Never throws. `doctor` is newer than some engine builds and the app is older
 * than some others: an unknown command exits 2, a missing binary never starts,
 * and both are states the settings screen renders rather than crashes on.
 */
export async function runDoctor(endpointUrl?: string): Promise<DoctorResult> {
  const args = ['doctor', '--json'];
  if (endpointUrl && endpointUrl.trim().length > 0) args.push('--endpoint', endpointUrl.trim());

  const run = runEngine(args);
  const timer = setTimeout(() => run.cancel(), 120_000);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    // Exit 2 is foundry's "the command line was wrong", which for a command
    // that does not exist yet is exactly what it means.
    const unknown = result.code === 2 || /unknown command/i.test(said);
    return {
      ok: false,
      reason: unknown
        ? `doctor unavailable in this engine build.\n${said}`
        : said || `The engine exited ${result.code} with nothing to say.`,
    };
  }

  try {
    return { ok: true, report: JSON.parse(result.stdout) };
  } catch (err) {
    return {
      ok: false,
      reason:
        `foundry doctor --json answered, but not with JSON (${(err as Error).message}). `
        + `First 200 characters: ${result.stdout.slice(0, 200)}`,
    };
  }
}
