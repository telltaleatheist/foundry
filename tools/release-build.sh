#!/usr/bin/env bash
#
# release-build — compile foundry for one or more platforms, with the commit
# baked in.
#
#   tools/release-build.sh                    # every target
#   tools/release-build.sh host               # just this machine's
#   tools/release-build.sh darwin-arm64       # just this one
#
# WHY THIS IS A SCRIPT AND NOT FOUR package.json LINES.
#
# The build has to inject the git commit (`--define`), and the value is a shell
# substitution wrapped in the quoting that makes it a JS string literal:
#
#     --define FOUNDRY_GIT_COMMIT='"a1b2c3d"'
#
# Spelling that four times inside JSON, where every quote needs escaping, is how
# one of the four ends up subtly different and ships a binary that reports the
# wrong commit — or none. One place, four call sites.
#
# `bun build --compile --target=<platform>` downloads that platform's Bun
# runtime the first time it is asked for it, so a cross-compile needs network on
# the first run. A target that fails is REPORTED and the script exits nonzero;
# it is never skipped quietly, because a missing binary in a release is a
# platform of users who cannot install.
set -euo pipefail

cd "$(dirname "$0")/.."

# Bun is not assumed to be on PATH: this repo is developed with it installed
# under ~/.bun, and a `command not found` at release time is a bad moment to
# discover the difference.
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

# `bash` on a Windows PATH is a race System32 usually wins, so an npm script
# that says `bash tools/release-build.sh` can land HERE, inside WSL, where
# ~/.bun is the distro's empty home. The Windows bun still serves: WSL's
# interop runs .exe files, and a /mnt/c working directory maps back to C:\ for
# them, so relative paths in the command survive the crossing. Looked for on
# PATH first (WSL usually appends the Windows PATH), then in the two homes a
# Windows bun install actually uses — the official ~/.bun and scoop's.
if [ ! -x "$BUN" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  for candidate in \
    "$(command -v bun.exe 2>/dev/null || true)" \
    /mnt/c/Users/*/.bun/bin/bun.exe \
    /mnt/c/Users/*/scoop/apps/bun/current/bun.exe \
    /mnt/c/Users/*/scoop/shims/bun.exe; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      BUN="$candidate"
      break
    fi
  done
fi

if [ ! -x "$BUN" ]; then
  echo "release-build: no bun executable (looked at '$BUN'). Set BUN=<path>." >&2
  exit 1
fi

# The tree's identity, and whether it is clean. A dirty tree is allowed — it is
# how you test a build — but it is MARKED, so a binary that reports `a1b2c3d+`
# can never be mistaken for the commit it was nearly built from.
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
if [ -n "$COMMIT" ] && ! git diff-index --quiet HEAD -- 2>/dev/null; then
  COMMIT="${COMMIT}+dirty"
fi

ALL_TARGETS=(darwin-arm64 darwin-x64 linux-x64 windows-x64)
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=("${ALL_TARGETS[@]}")
fi

# `host` is spelled out rather than left to a default, so that `release-build.sh`
# with no arguments always means "everything a release ships" and can never
# quietly produce one binary because of where it was run.
if [ "${TARGETS[0]}" = "host" ]; then
  host_os="$(uname -s)"
  host_arch="$(uname -m)"
  case "$host_os" in
    Darwin) host_os=darwin ;;
    Linux)  host_os=linux ;;
    # Git Bash / MSYS2 report MINGW64_NT-…; the bun target is spelled `windows`
    # while the platform key elsewhere is `win32`. Without this, `npm run build`
    # simply refused to run on the one platform whose packaging bug this repo
    # most recently had.
    MINGW*|MSYS*|CYGWIN*) host_os=windows ;;
    *)      echo "release-build: no target for host OS '$host_os'" >&2; exit 2 ;;
  esac
  case "$host_arch" in
    arm64|aarch64) host_arch=arm64 ;;
    x86_64|amd64)  host_arch=x64 ;;
    *) echo "release-build: no target for host arch '$host_arch'" >&2; exit 2 ;;
  esac
  TARGETS=("${host_os}-${host_arch}")
fi

mkdir -p dist

for target in "${TARGETS[@]}"; do
  case "$target" in
    darwin-arm64) bun_target='bun-darwin-arm64'; out='dist/foundry-darwin-arm64' ;;
    darwin-x64)   bun_target='bun-darwin-x64';   out='dist/foundry-darwin-x64' ;;
    linux-x64)    bun_target='bun-linux-x64';    out='dist/foundry-linux-x64' ;;
    windows-x64)  bun_target='bun-windows-x64';  out='dist/foundry-windows-x64.exe' ;;
    *)
      echo "release-build: unknown target '$target'. Known: ${ALL_TARGETS[*]}" >&2
      exit 2
      ;;
  esac

  echo "==> $target  (commit ${COMMIT:-none})"
  "$BUN" build src/cli.ts \
    --compile \
    --target="$bun_target" \
    --define "FOUNDRY_GIT_COMMIT=\"${COMMIT}\"" \
    --outfile "$out"
  ls -lh "$out"
done
