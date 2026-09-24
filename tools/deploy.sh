#!/usr/bin/env bash
#
# deploy — publish THIS commit's desktop installers as a Foundry release.
#
#   tools/deploy.sh                 # next patch version (2.0.2 -> 2.0.3)
#   tools/deploy.sh --minor         # next minor  (2.0.2 -> 2.1.0)
#   tools/deploy.sh 3.0.0           # exactly this version
#   tools/deploy.sh --notes "…"     # release title/notes (default: the commit subject)
#
# ── THERE IS NO ENGINE RELEASE ANY MORE (2026-09-24) ─────────────────────────
#
# The engine used to be a `bun build --compile` executable per platform, cut by
# release-build.sh, tarred by release-package.sh, published here beside a
# checksums.txt, and downloaded by every BookForge at startup as its
# `foundry-cli` add-on. Owen: *"i dont think it needs to be an exe anymore. it
# can be an engine but maybe we should explode it out into normal code that
# moves along with the app."* So the engine is bundled into the app folder
# (`app/engine/`, tools/build-engine.mjs) and travels with it:
#
#   - Foundry's installers carry it in their archive, like the rest of the app;
#   - BookForge carries it in its vendored copy of `app/` (`foundry-app/`), so
#     BookForge takes a new engine by RE-VENDORING, not from this release.
#
# What this publishes is the two desktop installers and nothing else.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO='telltaleatheist/foundry'
BUMP='patch'
VERSION=''
NOTES=''

while [ $# -gt 0 ]; do
  case "$1" in
    --minor)  BUMP='minor'; shift ;;
    --major)  BUMP='major'; shift ;;
    --notes)  NOTES="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) echo "deploy: unknown flag '$1'" >&2; exit 2 ;;
    *)  VERSION="$1"; shift ;;
  esac
done

# A release must describe a commit that exists for everyone: a dirty or
# unpushed tree would tag a commit whose contents nobody else can get.
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "deploy: working tree is dirty. Commit first." >&2
  exit 1
fi
if ! git diff --quiet "@{upstream}" HEAD 2>/dev/null; then
  echo "deploy: HEAD is not pushed. Push first — a release tag must name a public commit." >&2
  exit 1
fi

# The engine inside the installers must be the one src/ builds to. The test
# suite checks this too; checking here as well means an installer built from a
# stale app/engine/ is never published.
node tools/build-engine.mjs --check

# The version to publish. Derived from the LATEST PUBLISHED RELEASE rather than
# from package.json alone: a package.json that drifted from them would publish
# a version older than one already out.
latest="$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null || true)"
latest="${latest#v}"
if [ -z "$latest" ]; then
  echo "deploy: could not read the latest release from $REPO (gh auth?)." >&2
  exit 1
fi

if [ -z "$VERSION" ]; then
  IFS='.' read -r maj min pat <<<"$latest"
  case "$BUMP" in
    patch) pat=$((pat + 1)) ;;
    minor) min=$((min + 1)); pat=0 ;;
    major) maj=$((maj + 1)); min=0; pat=0 ;;
  esac
  VERSION="${maj}.${min}.${pat}"
fi

if gh release view "v$VERSION" -R "$REPO" >/dev/null 2>&1; then
  echo "deploy: v$VERSION already exists. Pick another version." >&2
  exit 1
fi

# A tag must never claim a version different from the engine's or the desktop's.
# Versions are committed before this script runs, not invented after compilation.
cli_version="$(node -p "require('./package.json').version")"
app_version="$(node -p "require('./app/package.json').version")"
if [ "$cli_version" != "$VERSION" ] || [ "$app_version" != "$VERSION" ]; then
  echo "deploy: requested $VERSION, engine is $cli_version and desktop is $app_version. Update both package versions/locks, commit and push before publishing." >&2
  exit 1
fi

DESKTOP_ASSETS=(
  "app/release/Foundry-$VERSION-windows-x64.exe"
  "app/release/Foundry-$VERSION-macos-arm64.dmg"
)
for asset in "${DESKTOP_ASSETS[@]}"; do
  if [ ! -s "$asset" ]; then
    echo "deploy: missing desktop artifact $asset. Build Windows and Apple Silicon installers from this source first." >&2
    exit 1
  fi
done

[ -n "$NOTES" ] || NOTES="$(git log -1 --pretty=%s)"

echo "==> deploying v$VERSION (was v$latest) — $(git rev-parse --short HEAD)"
echo "==> 1/2 publish"
gh release create "v$VERSION" -R "$REPO"   --target "$(git rev-parse HEAD)" --prerelease --latest=false   --title "v$VERSION — $NOTES"   --notes "$(printf '%s

Commit: %s' "$NOTES" "$(git rev-parse HEAD)")"   "${DESKTOP_ASSETS[@]}"

# Every installer must be in the release it just became before it is promoted.
echo "==> 2/2 verify"
published="$(gh release view "v$VERSION" -R "$REPO" --json assets --jq '.assets[].name')"
missing=0
for want in "Foundry-$VERSION-windows-x64.exe" "Foundry-$VERSION-macos-arm64.dmg"; do
  if ! grep -qx "$want" <<<"$published"; then
    echo "   MISSING: $want" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "deploy: release is incomplete — fix and re-upload." >&2; exit 1; }
gh release edit "v$VERSION" -R "$REPO" --prerelease=false --latest=true

echo
echo "deploy: v$VERSION is published with both installers."
echo "deploy: BookForge takes this engine by re-vendoring app/, not from this release."
