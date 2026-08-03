/**
 * version — what this build is, baked in at compile time.
 *
 * The version is IMPORTED FROM package.json, which makes that file the one
 * authority. It is still not a runtime read: `import` of a JSON module is
 * resolved by the bundler, so `bun build --compile` inlines the literal into the
 * executable and there is no package.json to find beside the binary.
 *
 * It used to be a second constant here, hand-bumped alongside package.json — and
 * it went stale exactly the way two copies of a number do: v0.2.0 and v0.2.1
 * both shipped binaries that introduced themselves as `foundry 0.1.0`, so the
 * one string a user pastes into a bug report named a release from two tags ago.
 * One number, one place, or it is not a version.
 *
 * The COMMIT is injected by the build (`bun build --define`), so a binary can
 * always be traced back to the tree it was cut from — `tools/release-build.sh`
 * passes it. Built without the define (e.g. `bun run src/cli.ts`) there is no
 * commit to report, and `--version` says so rather than inventing one. That is
 * not a fallback: "no commit was recorded" is the truth about that build.
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

/** Short commit hash of the tree this binary was built from, or null. */
export const GIT_COMMIT: string | null =
  typeof FOUNDRY_GIT_COMMIT === 'string' && FOUNDRY_GIT_COMMIT.length > 0
    ? FOUNDRY_GIT_COMMIT
    : null;

/** `0.1.0 (a1b2c3d)`, or just `0.1.0` when no commit was baked in. */
export function versionString(): string {
  return GIT_COMMIT ? `${VERSION} (${GIT_COMMIT})` : VERSION;
}
