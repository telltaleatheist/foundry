/**
 * llama-binary — which llama-server to run.
 *
 * Ported from `resolveBinary` in BookForge's `electron/llama-bridge.ts` (exported
 * there as `resolveLlamaServerBinary`), reduced to the two sources Foundry has:
 *
 *   1. `--llama-server <path>` — an explicit override, passed by BookForge,
 *      which already bundles a llama.cpp binary for its local AI cleanup and has
 *      no reason to ship a second one inside its app bundle (ARCHITECTURE §2).
 *   2. The vendored binary, next to the foundry executable.
 *
 * **There is no PATH lookup, and there will not be one.** This is the same rule
 * as the pinned Tesseract (ARCHITECTURE §5) and for a weaker but real version of
 * the same reason: whatever `llama-server` happens to be on a developer's PATH
 * is an unknown llama.cpp revision with unknown flag semantics, and the flags
 * this file passes — multi-LoRA, `--no-webui` — are not ancient. A binary that
 * silently does not support `--lora-scaled` gives you a server that answers,
 * with no adapter applied, which is a quality regression that looks like a bad
 * model. Better to say "there is no llama-server here" and stop.
 *
 * The dropped BookForge sources and why:
 *   - The Windows CUDA component pack: that is its optional-component system.
 *   - The managed/auto-updated binary: that is its update server.
 * Foundry vendors one binary per platform at packaging time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Platform+arch directory under `vendor/llama/`.
 *
 * Arch is in the name, not just platform, because a darwin-arm64 and a
 * darwin-x64 build are different files and the repo holds both during
 * development — `package.json` builds four targets. A compiled binary ships
 * with only its own, but the resolver has to be right in both situations.
 *
 * Exported as the single source of truth so the packaging step and the resolver
 * cannot disagree about where the binary goes.
 */
export function llamaVendorPlatformDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/** Binary name, `.exe` on Windows. */
export function llamaBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * Roots under which `vendor/llama/...` is looked for, in order.
 *
 * Two, because there are two ways this program runs:
 *
 *  - **Compiled** (`bun build --compile`): `process.execPath` is the foundry
 *    binary itself, and `vendor/` sits beside it in the install.
 *  - **From source** (`bun run src/cli.ts`): `process.execPath` is bun, which
 *    is somewhere else entirely, so the repo root is derived from this module's
 *    own location.
 *
 * Checking both is resolution, not a fallback ladder: they are two spellings of
 * "next to this program", and neither substitutes a *different* binary the way
 * a PATH lookup would.
 */
export function llamaSearchRoots(): string[] {
  const roots: string[] = [path.dirname(process.execPath)];

  // In a compiled binary this module lives in a virtual filesystem, so the
  // derived repo root does not exist on disk and is simply not offered.
  const moduleDir = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(moduleDir, '..', '..');
  try {
    if (fs.statSync(repoRoot).isDirectory() && !roots.includes(repoRoot)) {
      roots.push(repoRoot);
    }
  } catch {
    /* not a real directory: compiled build */
  }

  return roots;
}

/** Where the vendored binary would be under each search root. */
export function vendoredLlamaCandidates(roots: string[] = llamaSearchRoots()): string[] {
  const rel = path.join('vendor', 'llama', llamaVendorPlatformDir(), llamaBinaryName());
  return roots.map((root) => path.join(root, rel));
}

/**
 * Resolve the llama-server binary, or throw naming every path that was checked.
 *
 * @param explicitPath `--llama-server <path>`. When given it is the ONLY source
 *   considered — a bad override is an error about that override, not a quiet
 *   substitution of the vendored binary. Someone who names a path is telling you
 *   which binary they want to run; running a different one is how a test of a
 *   patched llama.cpp silently measures the old one.
 */
export function resolveLlamaServer(explicitPath?: string): string {
  const explicit = explicitPath?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    assertExecutableFile(
      resolved,
      `--llama-server points at ${resolved}, which is`,
    );
    return resolved;
  }

  const candidates = vendoredLlamaCandidates();
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }

  throw new Error(
    `No llama-server binary found. Checked:\n`
    + candidates.map((c) => `  ${c}`).join('\n')
    + `\nThis build has no vendored llama-server for ${llamaVendorPlatformDir()}. `
    + `Either install one at the path above, or pass --llama-server <path> to `
    + `point at one you already have. Foundry does not search PATH: an unknown `
    + `llama.cpp revision may ignore the multi-LoRA flags and answer anyway, `
    + `with no adapter applied.`,
  );
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertExecutableFile(candidate: string, prefix: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new Error(`${prefix} not there.`);
  }
  if (!stat.isFile()) {
    throw new Error(`${prefix} not a file.`);
  }
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    throw new Error(`${prefix} not executable.`);
  }
}
