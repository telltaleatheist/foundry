/**
 * app-settings — the APP's own knobs, in the app's own file.
 *
 * `userData/app-settings.json`, deliberately NOT the engine's settings.json:
 * that file's schema belongs to the engine, is read by every `vlm-convert` on
 * the machine (BookForge's included), and describes WHERE reading happens.
 * Server lifecycle is nobody's concern but this app's — the engine neither
 * starts nor stops servers — so its knob lives here, where no other consumer
 * of the engine can trip over it.
 *
 * Same forgiveness rules as the engine-settings module: unknown keys in the
 * file are preserved on write and ignored on read, and out-of-range values
 * clamp to something legal rather than throwing — a hand-edited "999999" is a
 * user asking for "a long time", not a corrupt installation.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { app } from 'electron';

import { readJson } from '../shared/json';

export interface AppSettings {
  /**
   * Minutes an app-started vLLM server stays up after the queue drains.
   *
   * 0 — the default — stops it as soon as the queue is empty. The ceiling
   * exists because "never indefinite" needs a number to be true: whatever is
   * written here, an idle server always has a scheduled end.
   */
  keepServerWarmMinutes: number;
  /**
   * The folder this app treats as the user's library.
   *
   * `<libraryDir>/workspace` is where every conversion lands, and it is what
   * the Save pickers open on. It is under Documents rather than under userData
   * because a finished book is the user's property: userData is where an app
   * keeps its own bookkeeping, and a folder a person is expected to open,
   * back up and sync does not belong there.
   *
   * Changing it affects NEW work only. Nothing is migrated and nothing is
   * rewritten — recents hold absolute paths, and moving a hundred books because
   * a text field changed is not a thing a settings screen should do behind
   * somebody's back.
   */
  libraryDir: string;
}

export const KEEP_WARM_MAX_MINUTES = 240;

/** `~/Documents/Foundry`. Created on demand, never at startup. */
export function defaultLibraryDir(): string {
  return path.join(os.homedir(), 'Documents', 'Foundry');
}

/**
 * The fixed part of the defaults. `libraryDir`'s default is a FUNCTION
 * (`defaultLibraryDir`) rather than a constant because it reads the home
 * directory, and a module-level constant would freeze whatever HOME happened to
 * be when this file was first imported.
 */
const DEFAULTS = { keepServerWarmMinutes: 0 };

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

/** Whatever the file holds, as an object; null when absent or unreadable. */
function readRaw(): Record<string, unknown> | null {
  try {
    const parsed: unknown = readJson(fs.readFileSync(settingsFile(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Absent, unreadable or unparsable all read as defaults. Unlike the
    // engine's file this one has no other writers whose intent could be lost,
    // so there is nothing to protect by refusing.
    return null;
  }
}

/** A finite number of minutes in [0, max]; anything else is the fallback. */
export function clampKeepWarm(value: unknown, fallback = DEFAULTS.keepServerWarmMinutes): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(KEEP_WARM_MAX_MINUTES, Math.max(0, Math.round(value)));
}

/**
 * An absolute directory path, or the default.
 *
 * ABSOLUTE is the whole check: a relative path in this field would be resolved
 * against whatever the process's working directory happens to be — the install
 * directory when launched from the Start menu, and something else entirely when
 * launched from a terminal — so the same setting would name two folders.
 */
export function clampLibraryDir(value: unknown, fallback = defaultLibraryDir()): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) return fallback;
  return path.normalize(trimmed);
}

export function readAppSettings(): AppSettings {
  const raw = readRaw();
  return {
    keepServerWarmMinutes: clampKeepWarm(raw?.['keepServerWarmMinutes']),
    libraryDir: clampLibraryDir(raw?.['libraryDir']),
  };
}

export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const root: Record<string, unknown> = readRaw() ?? {};
  if (patch.keepServerWarmMinutes !== undefined) {
    root['keepServerWarmMinutes'] = clampKeepWarm(patch.keepServerWarmMinutes);
  }
  if (patch.libraryDir !== undefined) {
    root['libraryDir'] = clampLibraryDir(patch.libraryDir);
  }
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return readAppSettings();
}
