#!/usr/bin/env bash
#
# deploy — put THIS commit in front of every BookForge, in one command.
#
#   tools/deploy.sh                 # next patch version (0.6.0 -> 0.6.1)
#   tools/deploy.sh --minor         # next minor  (0.6.0 -> 0.7.0)
#   tools/deploy.sh 0.9.0           # exactly this version
#   tools/deploy.sh --local         # build + point this machine at it; NO release
#   tools/deploy.sh --notes "…"     # release title/notes (default: the commit subject)
#
# WHY THIS EXISTS. Deploying used to be: run release-build, run release-package,
# remember `gh release create`, remember that the four tarballs and checksums.txt
# ship together, and then wonder why BookForge still ran the old binary. Four
# steps, three of them silent when skipped. It is one step now.
#
# ── WHAT BOOKFORGE DOES WITH THIS ────────────────────────────────────────────
#
# NO VERSION PIN NEEDS EDITING IN BOOKFORGE. Its foundry-cli component carries a
# pinned version, but that pin is a FLOOR, not a target: at startup it asks
# GitHub for the newest release, and `chooseTargetVersion` takes anything newer
# than the pin, reading the hashes out of that release's own checksums.txt
# (electron/components/foundry-release-check.ts). So publishing IS deploying.
#
# The one thing that must never be broken, because a program reads it:
#   foundry-<platform>-<arch>.tar.gz  +  checksums.txt, in the same release.
# `release-package.sh` produces exactly that pair; an artifact published without
# its line in checksums.txt is refused by name at install time rather than
# installed unverified.
#
# ── THE DEVELOPER'S MACHINE IS DIFFERENT ─────────────────────────────────────
#
# This machine's BookForge points at `dist/foundry-<host>` directly (an
# "external" component recorded in installed.json), so it does NOT download
# releases and does NOT notice new ones. It sees a rebuild and nothing else,
# which is why a repo commit alone never reached the app. `--local` is that
# rebuild on its own; a full deploy does it too, so the machine you released
# from is never the one running yesterday's binary.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO='telltaleatheist/foundry'
BUMP='patch'
VERSION=''
NOTES=''
LOCAL_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --minor)  BUMP='minor'; shift ;;
    --major)  BUMP='major'; shift ;;
    --local)  LOCAL_ONLY=1; shift ;;
    --notes)  NOTES="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "deploy: unknown flag '$1'" >&2; exit 2 ;;
    *)  VERSION="$1"; shift ;;
  esac
done

# A release must describe a commit that exists for everyone. A dirty tree still
# BUILDS (release-build marks the binary `+dirty`), but it must not be published:
# the tag would name a commit whose contents nobody else can get.
if [ "$LOCAL_ONLY" -eq 0 ] && ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "deploy: working tree is dirty. Commit first, or use --local." >&2
  exit 1
fi
if [ "$LOCAL_ONLY" -eq 0 ]; then
  if ! git diff --quiet "@{upstream}" HEAD 2>/dev/null; then
    echo "deploy: HEAD is not pushed. Push first — a release tag must name a public commit." >&2
    exit 1
  fi
fi

host_binary() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)  echo 'dist/foundry-darwin-arm64' ;;
    Darwin/x86_64) echo 'dist/foundry-darwin-x64' ;;
    Linux/x86_64)  echo 'dist/foundry-linux-x64' ;;
    *) echo '' ;;
  esac
}

if [ "$LOCAL_ONLY" -eq 1 ]; then
  echo "==> building for this machine only"
  tools/release-build.sh host
  bin="$(host_binary)"
  echo
  echo "deploy: built $bin ($("$bin" --version 2>/dev/null || echo 'version unknown'))"
  echo "deploy: BookForge on this machine points at it directly — restart the app to pick it up."
  exit 0
fi

# The version to publish. Derived from the LATEST PUBLISHED RELEASE rather than
# from package.json: the releases are what BookForge orders itself against, and
# a package.json that drifted from them would silently publish a version that
# every installed app considers older than what it already has.
latest="$(gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
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

[ -n "$NOTES" ] || NOTES="$(git log -1 --pretty=%s)"

echo "==> deploying v$VERSION (was v$latest) — $(git rev-parse --short HEAD)"
echo "==> 1/4 build (all four targets)"
tools/release-build.sh
echo "==> 2/4 package"
tools/release-package.sh
echo "==> 3/4 publish"
gh release create "v$VERSION" -R "$REPO" \
  --title "v$VERSION — $NOTES" \
  --notes "$(printf '%s\n\nCommit: %s' "$NOTES" "$(git rev-parse HEAD)")" \
  dist/release/*.tar.gz dist/release/checksums.txt

# Belt and braces: every asset BookForge can ask for must be in the release it
# just became. A release missing a platform is a platform of users whose install
# fails, and the failure happens on their machine, not here.
echo "==> 4/4 verify"
published="$(gh release view "v$VERSION" -R "$REPO" --json assets --jq '.assets[].name')"
missing=0
for want in foundry-darwin-arm64.tar.gz foundry-darwin-x64.tar.gz \
            foundry-linux-x64.tar.gz foundry-windows-x64.tar.gz checksums.txt; do
  if ! grep -qx "$want" <<<"$published"; then
    echo "   MISSING: $want" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "deploy: release is incomplete — fix and re-upload." >&2; exit 1; }

echo
echo "deploy: v$VERSION is published with all five assets."
echo "deploy: every BookForge takes it at its next startup check. No pin to edit."
echo "deploy: this machine points at dist/ directly — restart the app to pick up the rebuild."
