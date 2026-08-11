/**
 * backend/probe — can each reading backend actually be reached, right now?
 *
 * Every probe answers the same shape: available or not, and a DETAIL string a
 * person can act on. The detail is the product here, exactly as error messages
 * are in the rest of foundry: "wsl-vllm unavailable" helps nobody, while
 * "distro Ubuntu found; ~/miniconda3/envs/vllm/bin/python: no module named
 * vllm" says what to install and where.
 *
 * PROBES REPORT; THEY NEVER DECIDE. Ranking and choosing live in plan.ts, and
 * degrading lives nowhere (ARCHITECTURE §8): a probe that finds nothing
 * produces a named reason, not a quieter tier.
 *
 * The contract probed is the one foundry actually consumes:
 *
 *  - endpoint   GET <url>/models answers with the OpenAI list shape. This is
 *               the FIRST probe on every platform because it is the real
 *               dependency — vLLM in WSL, Docker, or a GPU box across the room
 *               all look identical from here, and none of them need
 *               understanding if the URL answers.
 *  - wsl-vllm   wsl.exe lists a distro, and a named interpreter inside it can
 *               import vllm. This is the "could foundry START a server" probe,
 *               for the settings screen; nothing here starts one.
 *  - mlx        a local interpreter can import mlx_vlm (Apple silicon only).
 *  - rasteriser a local interpreter can import fitz (PyMuPDF). Needed by EVERY
 *               run, endpoint or not — the pages are rendered locally.
 *
 * Module presence is checked with importlib.util.find_spec rather than a real
 * import: importing vllm or mlx_vlm costs seconds and can drag CUDA
 * initialisation in with it, and "installed" is the question here, not
 * "warmed up".
 *
 * Subprocesses run through an injectable runner so the WSL and python probes
 * are testable without a machine that has either.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { FoundrySettings } from './settings.js';

export interface RunResult {
  /** null when the process could not be started or timed out. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process never ran or was cut off, and says which. */
  failure?: string;
}

export type Runner = (cmd: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

/** The default runner: spawn, capture, kill at the deadline. */
export const spawnRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: '', failure: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => errBuf.push(d));
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: '', failure: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: decodeConsole(Buffer.concat(out)),
        stderr: decodeConsole(Buffer.concat(errBuf)),
        ...(timedOut ? { failure: `timed out after ${timeoutMs}ms` } : {}),
      });
    });
  });

/**
 * wsl.exe writes UTF-16LE to a pipe — `wsl -l -q` piped through anything on
 * the Windows side arrives with a NUL after every character. Everything else
 * writes UTF-8. The NUL byte is the tell: legal in neither encoding's text,
 * present in every UTF-16 line.
 */
export function decodeConsole(buf: Buffer): string {
  if (buf.includes(0)) return buf.toString('utf16le').replace(/^﻿/, '');
  return buf.toString('utf8');
}

export interface ProbeReport {
  available: boolean;
  detail: string;
}

export interface EndpointProbe extends ProbeReport {
  url: string;
  models: string[];
  latencyMs: number | null;
}

/**
 * GET <url>/models with a short deadline. `url` is the base the run would be
 * given (`http://host:8000/v1`), so the probe exercises the exact base the
 * chat request would extend.
 */
export async function probeEndpoint(url: string, timeoutMs = 3000): Promise<EndpointProbe> {
  const miss = (detail: string): EndpointProbe =>
    ({ available: false, detail, url, models: [], latencyMs: null });
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err instanceof Error && err.name === 'TimeoutError'
      ? `no answer within ${timeoutMs}ms`
      : (err as Error).message;
    return miss(`${url}: ${cause}`);
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) return miss(`${url}/models answered ${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return miss(`${url}/models did not answer JSON`);
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return miss(`${url}/models answered without the OpenAI "data" list — not an OpenAI-compatible server`);
  }
  const models = data
    .map((m) => (typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : null))
    .filter((id): id is string => id !== null);
  return {
    available: true,
    detail: `${url} answered in ${latencyMs}ms${models.length > 0 ? `, serving ${models.join(', ')}` : ''}`,
    url,
    models,
    latencyMs,
  };
}

export interface WslVllmProbe extends ProbeReport {
  distro: string | null;
  python: string | null;
  /**
   * Every distro wsl.exe listed, whatever else was or was not found — the
   * facts a setup screen needs to OFFER creating an environment. Empty when
   * WSL itself is absent (or this is not Windows).
   */
  distros: string[];
}

/** One python -c line: exit 0 if the module resolves, 3 if not. No heavy import. */
function findSpecProgram(module: string): string {
  return `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('${module}') else 3)`;
}

/**
 * Interpreter candidates inside a WSL distro, tried in order. Same philosophy
 * as bridge.ts's local list: NAMED candidates, and a miss that reports every
 * one, never a PATH search that finds somebody else's python.
 */
function wslPythonCandidates(settings: FoundrySettings): string[] {
  const explicit = settings.backend?.vllmPython;
  if (explicit) return [explicit];
  // `dots` is the env dots.ocr is actually served from on the machine this was
  // built on; `vllm`/`vlmtest` are the generic spellings. Names, not
  // requirements — backend.vllmPython overrides, and a miss prints them all.
  const envs = ['vllm', 'dots', 'vlmtest'];
  const roots = ['~/miniconda3', '~/miniforge3', '~/anaconda3'];
  const conda = roots.flatMap((root) => envs.map((env) => `${root}/envs/${env}/bin/python`));
  return [...conda, '~/.venvs/vllm/bin/python'];
}

/** win32 only: is there a WSL distro whose named interpreter can import vllm? */
export async function probeWslVllm(
  settings: FoundrySettings,
  run: Runner = spawnRunner,
): Promise<WslVllmProbe> {
  let known: string[] = [];
  const miss = (detail: string): WslVllmProbe =>
    ({ available: false, detail, distro: null, python: null, distros: known });
  if (process.platform !== 'win32') return miss('WSL is a Windows feature; not win32');

  const list = await run('wsl.exe', ['-l', '-q'], 15_000);
  if (list.failure || list.exitCode !== 0) {
    return miss(`wsl.exe -l -q failed: ${list.failure ?? list.stderr.trim() ?? `exit ${list.exitCode}`}`);
  }
  const distros = list.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  known = distros;
  if (distros.length === 0) return miss('wsl.exe lists no installed distros');

  const wanted = settings.backend?.wslDistro;
  if (wanted && !distros.includes(wanted)) {
    return miss(`settings name WSL distro "${wanted}" but wsl.exe lists: ${distros.join(', ')}`);
  }
  const targets = wanted ? [wanted] : distros;

  const candidates = wslPythonCandidates(settings);
  const misses: string[] = [];
  for (const distro of targets) {
    for (const candidate of candidates) {
      // sh -c so `~` resolves inside the distro; the candidate list is ours,
      // not user input, so interpolation here is interpolation of our own
      // constants (or the operator's own settings value).
      const probe = await run(
        'wsl.exe',
        ['-d', distro, '--', 'sh', '-c', `${candidate} -c "${findSpecProgram('vllm')}"`],
        20_000,
      );
      if (probe.exitCode === 0) {
        return {
          available: true,
          detail: `distro ${distro}, ${candidate} can import vllm`,
          distro,
          python: candidate,
          distros,
        };
      }
      misses.push(`${distro}: ${candidate} (${probe.failure ?? `exit ${probe.exitCode}`})`);
    }
  }
  return miss(
    `no interpreter with vllm found. Tried:\n${misses.map((m) => `  ${m}`).join('\n')}`
    + '\nName one in settings (backend.vllmPython) if it lives elsewhere.',
  );
}

export interface PythonProbe extends ProbeReport {
  python: string | null;
}

/**
 * Local interpreter candidates — ONE list, shared with vlm/bridge.ts.
 *
 * The doctor probes these and the bridge runs the first that exists; a
 * candidate the doctor reports as the rasteriser MUST be one the bridge would
 * pick, or `doctor` says "ok" about an interpreter no run ever uses. Conda
 * roots in both their unix (`env/bin/python`) and Windows (`env\python.exe`)
 * spellings, then the envs BookForge ships.
 */
export function defaultLocalPythonCandidates(): string[] {
  const home = os.homedir();
  const roots = [
    // The Homebrew cask root is a macOS location; on Windows path.join turns
    // it into a plausible-looking backslash path that can never exist.
    ...(process.platform === 'darwin' ? ['/opt/homebrew/Caskroom/miniconda/base'] : []),
    path.join(home, 'miniconda3'),
    path.join(home, 'miniforge3'),
    path.join(home, 'anaconda3'),
  ];
  const conda = roots.flatMap((root) =>
    process.platform === 'win32'
      ? [path.join(root, 'envs', 'vlmtest', 'python.exe')]
      : [path.join(root, 'envs', 'vlmtest', 'bin', 'python')]);

  /*
   * BookForge ships a relocatable Python WITH PyMuPDF in it (ebook2audiobook's
   * runtime env, unpacked under its user-data directory), and it is how
   * BookForge already rasterises for this very engine on Windows. A machine
   * with BookForge on it therefore has a working rasteriser whether or not
   * anyone made a conda env — named here so foundry finds it too.
   */
  const bookforgeRuntime =
    process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'bookforge', 'runtime', 'e2a-env', 'python.exe')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'bookforge', 'runtime', 'e2a-env', 'bin', 'python')
        : path.join(home, '.config', 'bookforge', 'runtime', 'e2a-env', 'bin', 'python');
  const e2aCheckout =
    process.platform === 'win32'
      ? path.join(home, 'Projects', 'ebook2audiobook', 'python_env', 'python.exe')
      : path.join(home, 'Projects', 'ebook2audiobook', 'python_env', 'bin', 'python');

  return [...conda, bookforgeRuntime, e2aCheckout];
}

/** Can a named local interpreter import `module`? Reports every miss by path. */
export async function probeLocalPython(
  module: string,
  settings: FoundrySettings,
  run: Runner = spawnRunner,
): Promise<PythonProbe> {
  const explicit = settings.backend?.python ?? process.env['FOUNDRY_VLM_PYTHON'];
  const candidates = explicit ? [explicit] : defaultLocalPythonCandidates();
  const misses: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      misses.push(`${candidate} (does not exist)`);
      continue;
    }
    const probe = await run(candidate, ['-c', findSpecProgram(module)], 15_000);
    if (probe.exitCode === 0) {
      return { available: true, detail: `${candidate} can import ${module}`, python: candidate };
    }
    misses.push(`${candidate} (${probe.failure ?? `no module ${module}`})`);
  }
  return {
    available: false,
    python: null,
    detail:
      `no interpreter with ${module} found. Tried:\n${misses.map((m) => `  ${m}`).join('\n')}`
      + '\nPass one with --python, FOUNDRY_VLM_PYTHON, or settings (backend.python).',
  };
}
