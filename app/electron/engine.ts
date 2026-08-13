/**
 * engine — the one place that knows how to run foundry.
 *
 * foundry is a STANDALONE UNIT. This app never imports a line of it; it spawns
 * it, reads its stderr, and believes its exit code (0 ok, 1 the run failed,
 * 2 the command line was wrong). Everything about *which* program that is lives
 * in `engineCommand()` below and nowhere else, so replacing the dev checkout
 * with a packaged binary is one function.
 *
 * Cribbed from BookForge's electron/foundry-bridge.ts: the argument-array spawn
 * (never a shell string — a binary under `C:\Program Files\…` interpolated into
 * a command line becomes the program `C:\Program`), the line-buffered stderr
 * reader (a progress callback fired on half a line is a UI showing half a page
 * number), and returning a nonzero exit rather than throwing on it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import type { DoctorResult, EngineInfo, JobProgress } from '../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Which program
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineCommand {
  command: string;
  /** Fixed leading arguments — `run <cli.ts>` for the dev checkout, none for a binary. */
  args: string[];
  source: string;
}

/** dist/electron -> dist -> app -> the foundry checkout this app lives in. */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

let cached: EngineCommand | null = null;

/**
 * THE constant. Three answers, in precedence order:
 *
 *   1. `FOUNDRY_BIN` — an operator pointing at a build of their own.
 *   2. A binary shipped beside a packaged app (resources/foundry[.exe]).
 *   3. The dev checkout: `bun run <repo>/src/cli.ts`.
 *
 * (3) is derived from __dirname rather than hardcoded, so a clone anywhere
 * works. When foundry ships a binary with the installer, only (2) changes.
 */
export function engineCommand(): EngineCommand {
  if (cached) return cached;

  const declared = process.env['FOUNDRY_BIN']?.trim();
  if (declared) {
    cached = { command: declared, args: [], source: 'FOUNDRY_BIN' };
    return cached;
  }

  const binaryName = process.platform === 'win32' ? 'foundry.exe' : 'foundry';
  const packaged = path.join(process.resourcesPath ?? '', binaryName);
  if (app.isPackaged && fs.existsSync(packaged)) {
    cached = { command: packaged, args: [], source: 'packaged binary' };
    return cached;
  }

  cached = {
    command: 'bun',
    args: ['run', path.join(repoRoot(), 'src', 'cli.ts')],
    source: 'dev checkout',
  };
  return cached;
}

/** `foundry --version`, or null. Asked once, at startup, for the settings screen. */
export function engineInfo(): EngineInfo {
  const cmd = engineCommand();
  let version: string | null = null;
  try {
    const probe = spawnSync(cmd.command, [...cmd.args, '--version'], {
      timeout: 30_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (probe.status === 0) version = (probe.stdout || '').trim() || null;
  } catch {
    version = null;
  }
  return { ...cmd, version };
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
): RunHandle {
  const cmd = engineCommand();
  let child: ChildProcess | null = null;
  let cancelled = false;

  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child = spawn(cmd.command, [...cmd.args, ...args], {
      env: process.env,
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
 * `bun run src/cli.ts` is a shell of a process in front of the real work, and
 * the real work spawns Python that holds a GPU. `child.kill()` reaches the
 * first of those and none of the rest, so a cancelled job would go on rendering
 * pages with nothing left listening — on Windows the only reliable answer is
 * taskkill's tree flag.
 */
function killTree(child: ChildProcess | null): void {
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
// Progress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One stderr line -> a page count, or null.
 *
 * Cribbed verbatim in shape from BookForge's shared/vlm/conversion.ts
 * `parseVlmProgressLine`, including the ORDER of the three patterns, which is
 * load-bearing:
 *
 *   `page 3/317: rendered`        the rasteriser's own line, forwarded through
 *                                 foundry, with NO `vlm-convert:` prefix — which
 *                                 is why the prefix test cannot come first;
 *   `vlm-convert: … page 12 (5/317)`   the endpoint route, checked before the
 *                                 local pattern because it also contains
 *                                 "page N" and would be read as a count;
 *   `vlm-convert: … page 5/317`   the local route.
 */
export function parseProgressLine(line: string): JobProgress | null {
  const trimmed = line.trim();

  const rendered = /^page\s+(\d+)\/(\d+):\s+rendered$/.exec(trimmed);
  if (rendered) {
    return { phase: 'render', page: Number(rendered[1]), total: Number(rendered[2]) };
  }

  /*
   * `translate: block 412/2081 (EPUB/text/c0003.xhtml)`.
   *
   * Matched before the `vlm-convert:` gate because it is a different command
   * with its own prefix, and matched on `block` specifically so the engine's
   * OTHER translate lines — the rejected-answer notices, which also carry a
   * fraction (`attempt 2/3`) — cannot be read as progress. A bar that jumped to
   * 67% because an answer was retried would be a bar reporting the wrong
   * quantity entirely.
   */
  const block = /^translate:\s+block\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (block) {
    return { phase: 'translate', page: Number(block[1]), total: Number(block[2]) };
  }

  if (!trimmed.startsWith('vlm-convert:')) return null;

  const viaEndpoint = /\bpage\s+\d+\s+\((\d+)\/(\d+)\)/.exec(trimmed);
  if (viaEndpoint) {
    return { phase: 'read', page: Number(viaEndpoint[1]), total: Number(viaEndpoint[2]) };
  }

  const local = /\bpage\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (local) {
    return { phase: 'read', page: Number(local[1]), total: Number(local[2]) };
  }

  return null;
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
