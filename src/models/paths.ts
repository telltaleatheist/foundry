/**
 * paths — where weights live on this machine.
 *
 * Weights are downloaded, not shipped (ARCHITECTURE §6): the base model is
 * several gigabytes, so it belongs neither in git nor inside the compiled
 * binary. It goes in a platform data directory:
 *
 *   macOS:   ~/Library/Application Support/foundry/models
 *   Windows: %LOCALAPPDATA%\foundry\models   (Local, not Roaming — too big to roam)
 *   Linux:   $XDG_DATA_HOME/foundry/models  or  ~/.local/share/foundry/models
 *
 * `--models-dir <path>` overrides the lot, and is threaded through as an
 * explicit argument rather than read from a global — a resolver that consults
 * ambient state is a resolver you cannot test on three platforms at once.
 *
 * Two things this deliberately does NOT do:
 *
 *  - No legacy migration. BookForge's `shared-paths.ts` carries a
 *    `migrateLegacyDir` that moves a pre-existing per-app directory into the
 *    shared one, because it had installs in the field with weights already on
 *    disk. Foundry has no previous layout, and importing one on day one would
 *    be inventing debt.
 *  - No OwenMorgan shared dir. That is BookForge's cross-app location for assets
 *    shared with its siblings. Foundry is a standalone binary and owns its own.
 *
 * Nothing outside this file stores an absolute path to a weight: a model is
 * referenced by id and resolved here, so the directory can move without
 * invalidating anything that was written down.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getModelDef } from './catalog.js';

/** Directory name under the platform data root. Also the vendor name. */
const APP_DIR = 'foundry';

/**
 * The platform inputs `defaultModelsDir` reads.
 *
 * Injectable so the per-platform branches are testable from any one platform.
 * Production callers pass nothing and get the real process.
 */
export interface PlatformContext {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

function currentPlatform(): PlatformContext {
  return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

/**
 * The platform-default models directory. Pure — resolves a path, creates
 * nothing, so it is safe to call for display (`foundry models list`) on a
 * machine that has never downloaded anything.
 */
export function defaultModelsDir(ctx: PlatformContext = currentPlatform()): string {
  const { platform, env, homedir } = ctx;

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', APP_DIR, 'models');
  }

  if (platform === 'win32') {
    // LOCALAPPDATA is set on every supported Windows, but the documented
    // fallback location is the same directory it points at — this reconstructs
    // the default, it does not substitute a different place.
    const local = env['LOCALAPPDATA']?.trim() || path.join(homedir, 'AppData', 'Local');
    return path.join(local, APP_DIR, 'models');
  }

  // Linux and everything else: the XDG base directory spec.
  const dataHome = env['XDG_DATA_HOME']?.trim() || path.join(homedir, '.local', 'share');
  return path.join(dataHome, APP_DIR, 'models');
}

/**
 * The models directory to use, honouring an explicit `--models-dir`.
 *
 * Resolved to an absolute path — a relative `--models-dir` would otherwise mean
 * a different directory depending on where the user happened to be standing,
 * and `foundry models list` and `foundry convert` could disagree about whether
 * a model is installed.
 */
export function modelsDir(override?: string, ctx?: PlatformContext): string {
  const explicit = override?.trim();
  if (explicit) return path.resolve(explicit);
  return defaultModelsDir(ctx ?? currentPlatform());
}

/**
 * The models directory, created if missing.
 *
 * Separate from `modelsDir` because reading (list, status) must never have the
 * side effect of creating a directory tree; only writing (pull) should.
 */
export function ensureModelsDir(override?: string, ctx?: PlatformContext): string {
  const dir = modelsDir(override, ctx);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Absolute path to a model's file. The file need not exist — this is where it
 * WOULD be. An unknown id throws rather than returning a plausible path into
 * nowhere, since the next thing to touch it would report a missing file and
 * send the reader looking at the disk instead of at the id.
 */
export function modelFilePath(id: string, override?: string, ctx?: PlatformContext): string {
  const def = getModelDef(id);
  if (!def) {
    throw new Error(
      `Unknown model id: ${id}. Run \`foundry models list\` for the ids in the catalog.`,
    );
  }
  return path.join(modelsDir(override, ctx), def.filename);
}

/**
 * Present when the file is on disk at exactly its catalogued size.
 *
 * Size-checked rather than existence-checked, and the reason is specific: an
 * interrupted download that somehow got renamed into place, or a half-copied
 * file, reads as installed and then llama-server fails to load it with a
 * complaint about the file format — which sends the reader looking at the model
 * rather than at the transfer. Size is the cheap check; `sha256File` in
 * download.ts is the real one, and is what `models list --verify` reports.
 */
export function isModelPresent(id: string, override?: string, ctx?: PlatformContext): boolean {
  const def = getModelDef(id);
  if (!def) return false;
  try {
    return fs.statSync(modelFilePath(id, override, ctx)).size === def.bytes;
  } catch {
    return false;
  }
}
