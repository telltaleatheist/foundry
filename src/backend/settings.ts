/**
 * backend/settings — the persisted backend configuration, and nothing else.
 *
 * One JSON file in the platform config directory. The ENGINE owns this schema:
 * the Electron app (and anything else) may write the file, but what a key
 * means, which values are legal, and what happens when one is wrong is decided
 * here. A writer that wants to survive schema growth preserves keys it does
 * not recognise; this reader REFUSES values it recognises and cannot use
 * (ARCHITECTURE §8) — a typo'd mode that silently meant "auto" would send a
 * 40-minute book to a 40-hour backend without a word.
 *
 * A MISSING file is not an error. No settings is a legitimate state — every
 * behaviour the file can configure has a flag, and flags always win. The
 * precedence, everywhere a setting is consulted:
 *
 *     explicit CLI flag  >  settings.json  >  built-in resolution
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** How the reading backend is picked. */
export const BACKEND_MODES = ['auto', 'endpoint', 'mlx'] as const;
export type BackendMode = (typeof BACKEND_MODES)[number];

export interface BackendSettings {
  /** auto: first available tier wins. endpoint/mlx: that tier or a loud error. */
  mode?: BackendMode;
  /** The OpenAI-compatible server vlm-convert reads through (e.g. vLLM). */
  endpointUrl?: string;
  /** The model name that server was started with, when it differs from the registry's. */
  endpointModel?: string;
  /** WSL distro to look for vLLM in. Default: every distro wsl.exe lists. */
  wslDistro?: string;
  /** Interpreter inside WSL with vllm importable. Default: named candidates. */
  vllmPython?: string;
  /** Local interpreter with PyMuPDF (and mlx-vlm on Apple silicon). Same as --python. */
  python?: string;
}

export interface FoundrySettings {
  backend?: BackendSettings;
}

export class SettingsError extends Error {}

/**
 * Where settings.json lives. `FOUNDRY_CONFIG_DIR` overrides — for tests, and
 * for an app that wants a portable profile — and is used verbatim.
 */
export function configDir(): string {
  const override = process.env['FOUNDRY_CONFIG_DIR'];
  if (override) return override;
  switch (process.platform) {
    case 'win32': {
      const appData = process.env['APPDATA'];
      if (!appData) throw new SettingsError('%APPDATA% is not set; cannot locate the config directory');
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

function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SettingsError(`settings.json: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Read and validate the settings file.
 *
 * Unknown keys are IGNORED, not rejected — a newer app writing a newer schema
 * must not brick an older engine. Known keys with illegal values are rejected
 * BY NAME: the file is operator-written state, and a value this engine
 * recognises but cannot honour is a misconfiguration to fix, not to guess
 * around.
 */
export function loadSettings(): FoundrySettings {
  const file = settingsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SettingsError(`settings.json could not be read (${file}): ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SettingsError(`settings.json is not valid JSON (${file}): ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SettingsError(`settings.json must hold a JSON object (${file})`);
  }

  const result: FoundrySettings = {};
  const backendRaw = (parsed as Record<string, unknown>)['backend'];
  if (backendRaw === undefined) return result;
  if (typeof backendRaw !== 'object' || backendRaw === null || Array.isArray(backendRaw)) {
    throw new SettingsError('settings.json: "backend" must be an object');
  }

  const b = backendRaw as Record<string, unknown>;
  const backend: BackendSettings = {};
  if (b['mode'] !== undefined) {
    const mode = requireString(b['mode'], 'backend.mode');
    if (!(BACKEND_MODES as readonly string[]).includes(mode)) {
      throw new SettingsError(
        `settings.json: "backend.mode" is "${mode}"; it must be one of ${BACKEND_MODES.join(', ')}`,
      );
    }
    backend.mode = mode as BackendMode;
  }
  if (b['endpointUrl'] !== undefined) {
    const url = requireString(b['endpointUrl'], 'backend.endpointUrl');
    try {
      new URL(url);
    } catch {
      throw new SettingsError(`settings.json: "backend.endpointUrl" is not a URL: "${url}"`);
    }
    backend.endpointUrl = url;
  }
  if (b['endpointModel'] !== undefined) backend.endpointModel = requireString(b['endpointModel'], 'backend.endpointModel');
  if (b['wslDistro'] !== undefined) backend.wslDistro = requireString(b['wslDistro'], 'backend.wslDistro');
  if (b['vllmPython'] !== undefined) backend.vllmPython = requireString(b['vllmPython'], 'backend.vllmPython');
  if (b['python'] !== undefined) backend.python = requireString(b['python'], 'backend.python');

  result.backend = backend;
  return result;
}
