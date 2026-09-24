/**
 * version — what this build is, baked in at compile time.
 *
 * The version is IMPORTED FROM package.json, which makes that file the one
 * authority. It is still not a runtime read: `import` of a JSON module is
 * resolved by the bundler, so tools/build-engine.mjs inlines the literal into the
 * engine bundle and there is no package.json to find beside it.
 *
 * It used to be a second constant here, hand-bumped alongside package.json — and
 * it went stale exactly the way two copies of a number do: v0.2.0 and v0.2.1
 * both shipped binaries that introduced themselves as `foundry 0.1.0`, so the
 * one string a user pastes into a bug report named a release from two tags ago.
 * One number, one place, or it is not a version.
 *
 * The BUILD STAMP is injected by the build (esbuild `define`), so a bundle can
 * always be traced back to the sources it was built from. Since the engine is
 * committed inside the app (2026-09-24) the stamp is a digest of those sources,
 * `src 1a2b3c4d5e6f`, not a git commit — a commit cannot contain its own hash;
 * see tools/build-engine.mjs. Run without the define (`bun run src/cli.ts`, the
 * tests) there is no stamp to report, and `--version` says so rather than
 * inventing one. That is not a fallback: "nothing was recorded" is the truth
 * about that run.
 */

import pkg from '../package.json';

/**
 * Injected at build time as a string literal. `declare` only — this identifier
 * is never defined at runtime, and `typeof` on an undeclared global is the one
 * safe way to test for it (a bare reference would be a ReferenceError under
 * `bun run`).
 */
declare const FOUNDRY_GIT_COMMIT: string | undefined;

/** The release version. Bumped in package.json, with a tag and a release. */
export const VERSION: string = pkg.version;

/** The build stamp (`src <digest>`) of the sources this bundle was built from, or null. */
export const GIT_COMMIT: string | null =
  typeof FOUNDRY_GIT_COMMIT === 'string' && FOUNDRY_GIT_COMMIT.length > 0
    ? FOUNDRY_GIT_COMMIT
    : null;

/** `2.0.2 (src 1a2b3c4d5e6f)`, or just `2.0.2` when nothing was baked in. */
export function versionString(): string {
  return GIT_COMMIT ? `${VERSION} (${GIT_COMMIT})` : VERSION;
}
