/**
 * platform — the four things the work code needs from the Electron app it runs
 * in, handed over once at startup instead of imported.
 *
 * ── Why this file exists (2026-11-04, FOUNDRY-CORE-PLAN step 1) ─────────────
 *
 * Foundry's main-process logic is moving into a headless library both apps
 * share (docs/FOUNDRY-CORE-PLAN.md). Before anything moves, that code has to be
 * plain Node, and only four edges kept it from being: a push to the windows
 * (`host-ops.ts` → `window.ts`), the userData directory (`app-settings`,
 * `recents`, `system-probe`), the temp directory and the image codec (`capture`).
 * Each of those imported `electron`, or imported a file that did, so nearly the
 * whole main process reached `BrowserWindow` through them. They now ask this
 * module, and whoever owns the process tells it — `mountFoundry` does, before
 * anything else in it runs, so the standalone shell and BookForge set it by the
 * same call and neither has a second path to drift along.
 *
 * ── The four, and why each is a FUNCTION rather than a value ────────────────
 *
 * `userDataDir()` and `tempDir()` are asked at the moment of use, exactly as
 * `app.getPath(…)` was. Capturing a string at mount would freeze whatever the
 * path was then, and a host that moves its userData (`app.setPath`) after the
 * mount would be read from the old one, silently. Laziness is the behaviour this
 * replaces, so laziness is what the port keeps.
 *
 * `broadcast` is the window module's own push, with its dead-window guard — the
 * port moves where the import points, not what a push does.
 *
 * `image` is the decode/resize/encode subset of `nativeImage` that capture.ts
 * actually calls, typed structurally so Electron's own object satisfies it as
 * it is. A headless consumer brings any codec with the same six methods.
 *
 * ── Unset is misconfiguration, and it is refused by name ────────────────────
 *
 * There is no default platform. A library that guessed — a temp dir from
 * `os.tmpdir()`, a broadcast that went nowhere — would be wrong in the one way
 * nobody notices: settings written to the wrong file, a tree that never
 * redraws. So reading the port before `setPlatform` throws a sentence naming
 * which member was asked for, and what should have set it. Reads are lazy, so a
 * consumer that never reaches userData (a CLI that only spawns the engine) is
 * never refused for not having one.
 *
 * SET AGAIN REPLACES. One process has one platform; a second `setPlatform` is a
 * test or a host re-mounting, and the newest answer is the true one.
 */

/** One image, as far as capture.ts needs one. Electron's `NativeImage` is one. */
export interface PlatformImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  /** BGRA, scale factor 1. */
  toBitmap(): Buffer;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): PlatformImage;
}

/** The codec. Electron's `nativeImage` module is one. */
export interface PlatformImages {
  createFromPath(file: string): PlatformImage;
  createFromBuffer(bytes: Buffer): PlatformImage;
}

export interface Platform {
  /** Where the app's own files live — `app.getPath('userData')` in Electron. */
  userDataDir(): string;
  /** Scratch space — `app.getPath('temp')` in Electron. */
  tempDir(): string;
  /** One push to every window the process has. */
  broadcast(channel: string, payload: unknown): void;
  image: PlatformImages;
}

const MEMBERS = ['userDataDir', 'tempDir', 'broadcast', 'image'] as const;

let current: Platform | null = null;

/**
 * Hand the work code its platform. Called by `mountFoundry` first thing; a
 * headless consumer calls it before its first use of the library.
 */
export function setPlatform(platform: Platform): void {
  // Checked at runtime as well as by the type, because a host written in plain
  // JS (BookForge's CLI requires the compiled files) gets no type to fail.
  const missing = MEMBERS.filter((name) => platform[name] === undefined || platform[name] === null);
  if (missing.length !== 0) {
    throw new Error(`setPlatform: the platform is missing ${missing.join(', ')}.`);
  }
  current = platform;
}

/** The platform, or the refusal that names what was asked of it too early. */
function platformFor(name: keyof Platform): Platform {
  if (current === null) {
    throw new Error(
      `The Foundry platform was asked for ${name} before it was set. `
      + 'mountFoundry() sets it; anything that uses this code without mounting must call setPlatform() first.',
    );
  }
  return current;
}

// Called ON the platform object rather than lifted off it, so a host whose
// members are methods (and use `this`) works as written.
export function userDataDir(): string {
  return platformFor('userDataDir').userDataDir();
}

export function tempDir(): string {
  return platformFor('tempDir').tempDir();
}

export function broadcast(channel: string, payload: unknown): void {
  platformFor('broadcast').broadcast(channel, payload);
}

export function images(): PlatformImages {
  return platformFor('image').image;
}
