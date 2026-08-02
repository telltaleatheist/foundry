/**
 * version — what this build is, baked in at compile time.
 *
 * The version number is a constant in the source rather than a read of
 * `package.json`, because `bun build --compile` produces a single executable
 * with no package.json beside it: a runtime read would work from a checkout and
 * throw from the binary, which is the worst possible split.
 *
 * The COMMIT is injected by the build (`bun build --define`), so a binary can
 * always be traced back to the tree it was cut from — `tools/release-build.sh`
 * passes it. Built without the define (e.g. `bun run src/cli.ts`) there is no
 * commit to report, and `--version` says so rather than inventing one. That is
 * not a fallback: "no commit was recorded" is the truth about that build.
 */

/**
 * Injected at build time as a string literal. `declare` only — this identifier
 * is never defined at runtime, and `typeof` on an undeclared global is the one
 * safe way to test for it (a bare reference would be a ReferenceError under
 * `bun run`).
 */
declare const FOUNDRY_GIT_COMMIT: string | undefined;

/** The release version. Bumped by hand, with a tag and a release. */
export const VERSION = '0.1.0';

/** Short commit hash of the tree this binary was built from, or null. */
export const GIT_COMMIT: string | null =
  typeof FOUNDRY_GIT_COMMIT === 'string' && FOUNDRY_GIT_COMMIT.length > 0
    ? FOUNDRY_GIT_COMMIT
    : null;

/** `0.1.0 (a1b2c3d)`, or just `0.1.0` when no commit was baked in. */
export function versionString(): string {
  return GIT_COMMIT ? `${VERSION} (${GIT_COMMIT})` : VERSION;
}
