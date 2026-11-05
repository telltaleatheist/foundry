/**
 * settings — read and write the ENGINE's settings file.
 *
 * `%APPDATA%\foundry\settings.json` on Windows, the platform equivalent
 * elsewhere, `FOUNDRY_CONFIG_DIR` overriding both — the same three rules
 * foundry's own src/backend/settings.ts applies, because the app and the engine
 * disagreeing about where the file is means an app that appears to save nothing.
 *
 * The SCHEMA IS THE ENGINE'S. This module writes only the three keys the
 * settings screen edits and PRESERVES every other key in the file, at both
 * levels: a newer engine's `endpointModel` must survive an older app saving a
 * URL over it. (The keys the engine itself stopped reading are the one
 * exception, dropped once by `retireSettingsKeys` below.) Reading is equally forgiving:
 * unknown keys are ignored, and a file that will not parse is reported rather
 * than replaced, because overwriting an operator's broken JSON destroys the
 * thing they need to see to fix it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readJson } from '../shared/json';
import type { BackendMode, BackendSettingsPatch, SettingsView } from '../shared/types';

const MODES: readonly BackendMode[] = ['auto', 'endpoint'];

export function configDir(): string {
  const override = process.env['FOUNDRY_CONFIG_DIR'];
  if (override) return override;
  switch (process.platform) {
    case 'win32': {
      const appData = process.env['APPDATA'];
      if (!appData) throw new Error('%APPDATA% is not set; cannot locate foundry\'s config directory.');
      return path.join(appData, 'foundry');
    }
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'foundry');
    default: {
      const xdg = process.env['XDG_CONFIG_HOME'];
      return path.join(xdg ?? path.join(os.homedir(), '.config'), 'foundry');
    }
  }
}

export function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

/** The whole file as it is on disk, or null when there is not one. */
function readRaw(): { parsed: Record<string, unknown> | null; problem?: string } {
  const file = settingsPath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { parsed: null };
    return { parsed: null, problem: `${file} could not be read: ${(err as Error).message}` };
  }
  try {
    const parsed: unknown = readJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { parsed: null, problem: `${file} does not hold a JSON object.` };
    }
    return { parsed: parsed as Record<string, unknown> };
  } catch (err) {
    return { parsed: null, problem: `${file} is not valid JSON: ${(err as Error).message}` };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readSettings(): SettingsView {
  const { parsed, problem } = readRaw();
  const view: SettingsView = { path: settingsPath(), backend: {} };
  if (problem) view.problem = problem;
  if (!parsed) return view;

  const backend = parsed['backend'];
  if (typeof backend !== 'object' || backend === null || Array.isArray(backend)) return view;
  const b = backend as Record<string, unknown>;

  const mode = asString(b['mode']);
  if (mode && (MODES as readonly string[]).includes(mode)) view.backend.mode = mode as BackendMode;
  const url = asString(b['endpointUrl']);
  if (url) view.backend.endpointUrl = url;
  return view;
}

/**
 * Keys nothing reads any more, dropped from the file ONCE and said ONCE.
 *
 * Foundry has no Python and runs no model server of its own (2026-11-04): the
 * pages are rasterised in-process on MuPDF and every model call goes to
 * Crucible. So `backend.python` (the interpreter the rasteriser and the MLX
 * reader ran in, written by the environment installer), `backend.mode: "mlx"`
 * (the local reader), and `backend.vllmPython` / `backend.wslDistro` (where the
 * doctor looked for a vLLM it could start) name things that no longer exist —
 * and the engine REFUSES an unknown mode, so a file still saying "mlx" would
 * stop every run. They are taken out and the file
 * is written back, with one sentence saying so, rather than ignored (the key
 * would outlive everyone who knew what it was) or refused (an upgrade would
 * break a working install). Every other key is carried across untouched, as
 * `writeSettings` carries them. The environments the installer downloaded are
 * left on disk — they are the user's files — and the sentence says where.
 *
 * Null when there was nothing to drop, or no readable file to drop it from.
 */
export function retireSettingsKeys(): string | null {
  const { parsed, problem } = readRaw();
  if (problem || !parsed) return null;
  const existing = parsed['backend'];
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) return null;
  const backend: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
  const dropped: string[] = [];
  if ('python' in backend) {
    dropped.push(`backend.python (${JSON.stringify(backend['python'])})`);
    delete backend['python'];
  }
  for (const key of ['vllmPython', 'wslDistro']) {
    if (key in backend) {
      dropped.push(`backend.${key} (${JSON.stringify(backend[key])})`);
      delete backend[key];
    }
  }
  if (backend['mode'] === 'mlx') {
    dropped.push('backend.mode "mlx"');
    delete backend['mode'];
  }
  if (dropped.length === 0) return null;
  parsed['backend'] = backend;
  const file = settingsPath();
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const envs = process.platform === 'win32'
    ? path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'foundry', 'envs')
    : path.join(os.homedir(), 'Library', 'Application Support', 'foundry', 'envs');
  return `${file}: dropped ${dropped.join(', ')} — Foundry has no local Python or model server any more `
    + `(pages render in-process; every model call goes to Crucible). Any environment it downloaded under ${envs} is unused `
    + 'and can be deleted by hand.';
}

/**
 * Merge the keys this app owns into the file and write it back.
 *
 * An EMPTY STRING clears its key — that is the field the user emptied, and
 * leaving the old value behind would make the screen a liar. Everything else in
 * the file, at both levels, is carried across untouched.
 *
 * A file that would not parse is REFUSED rather than clobbered: the operator's
 * broken JSON is the only record of what they meant.
 */
export function writeSettings(patch: BackendSettingsPatch): SettingsView {
  const { parsed, problem } = readRaw();
  if (problem) throw new Error(`${problem} Nothing was saved — fix or move the file aside first.`);

  const root: Record<string, unknown> = parsed ?? {};
  const existing = root['backend'];
  const backend: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const apply = (key: keyof BackendSettingsPatch): void => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value === 'string' && value.trim().length === 0) delete backend[key];
    else backend[key] = typeof value === 'string' ? value.trim() : value;
  };
  apply('mode');
  apply('endpointUrl');

  root['backend'] = backend;

  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return readSettings();
}
