#!/usr/bin/env bash
#
# release-package — turn built binaries into release assets.
#
#   tools/release-package.sh [dist-dir] [out-dir]
#
# Produces, for every binary present in the dist directory:
#
#   <out>/foundry-<platform>-<arch>.tar.gz   one executable, named `foundry`
#   <out>/checksums.txt                      sha256 of every asset
#
# THE NAMING IS A CONTRACT. BookForge's foundry-cli component builds a download
# URL from `<platform>-<arch>` and verifies the asset against `checksums.txt`,
# so these names are read by a program, not just by a person. The version is not
# in the filename because it is in the release tag the assets hang from; a name
# that carried both could disagree with itself.
#
# Only binaries that ACTUALLY EXIST are packaged. A target that failed to build
# is absent from the release and absent from checksums.txt, rather than present
# as a stale copy of a previous build — a release asset that is quietly older
# than its tag is worse than a missing one, because it installs.
set -euo pipefail

cd "$(dirname "$0")/.."

DIST="${1:-dist}"
OUT="${2:-dist/release}"

rm -rf "$OUT"
mkdir -p "$OUT"

pack() {
  local binary="$1" platform="$2" name="$3"
  if [ ! -f "$DIST/$binary" ]; then
    echo "-- $platform: $DIST/$binary not built, skipping"
    return
  fi
  local stage
  stage="$(mktemp -d)"
  cp "$DIST/$binary" "$stage/$name"
  chmod +x "$stage/$name"
  # -C so the archive holds `foundry`, not `dist/foundry-darwin-arm64`: an
  # archive that unpacks a path is an archive that unpacks somewhere surprising.
  tar -czf "$OUT/foundry-$platform.tar.gz" -C "$stage" "$name"
  rm -rf "$stage"
  echo "== $platform  $(cd "$OUT" && du -h "foundry-$platform.tar.gz" | cut -f1)"
}

pack foundry-darwin-arm64     darwin-arm64  foundry
pack foundry-darwin-x64       darwin-x64    foundry
pack foundry-linux-x64        linux-x64     foundry
pack foundry-windows-x64.exe  windows-x64   foundry.exe

(
  cd "$OUT"
  # Plain `sha256sum` format, so `sha256sum -c checksums.txt` works on Linux and
  # the file is trivially parsed by the BookForge component.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*.tar.gz > checksums.txt
  else
    shasum -a 256 ./*.tar.gz > checksums.txt
  fi
  sed -i.bak 's|\./||' checksums.txt && rm -f checksums.txt.bak
  cat checksums.txt
)
