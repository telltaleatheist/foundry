#!/usr/bin/env bash
#
# build-env — cast one relocatable Python environment for one platform.
#
#   tools/env/build-env.sh wsl-x64     <workdir>   # linux: vllm (the reader)
#   tools/env/build-env.sh windows-x64 <workdir>   # windows: pymupdf (the rasteriser)
#   tools/env/build-env.sh mac-arm64   <workdir>   # mac: mlx-vlm + pymupdf (both)
#
# WHY PREBUILT. `pip install vllm` on an end user's machine is a 2 GB download
# resolved against whatever PyPI serves that day; these archives are the ONE
# environment each platform was measured with, built once, hashed, and served
# from the GitHub release. The versions below are not "latest" — each is pinned
# to the interpreter and packages of the environment the conversion was PROVEN
# on (WSL `dots`: 3.12.13 + vllm 0.11.0; mac `vlmtest`: 3.11.15 + mlx-vlm
# 0.6.10 + pymupdf 1.28.0). Bumping one is a deliberate act that re-runs the
# measurement, not a chore.
#
# RELOCATABLE BY CONSTRUCTION. The interpreter is python-build-standalone,
# which runs from any directory; packages are installed into its own
# site-packages (never a venv — a venv bakes its creation path into every
# shebang). Callers invoke `<env>/python/bin/python -m <module>` and never a
# bin/ script, so the absolute-path shebangs pip writes are dead weight rather
# than a trap.
#
# OUTPUT (in <workdir>):
#   foundry-env-<target>-v1.tar.gz            the environment, one top dir `python/`
#   foundry-env-<target>-v1.tar.gz.partN      the same bytes in <2 GiB slices
#                                             (only when the archive needs them;
#                                             GitHub Releases caps a file at 2 GiB)
#   foundry-env-<target>-v1.json              bytes + sha256 of archive and parts
#
# The .json is the build's testimony: the app's catalog copies these numbers,
# and a download that does not hash to them is deleted and named, never used.
set -euo pipefail

TARGET="${1:?usage: build-env.sh <wsl-x64|windows-x64|mac-arm64> <workdir>}"
WORKDIR="${2:?usage: build-env.sh <target> <workdir>}"

PBS_TAG=20260807
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}"

case "$TARGET" in
  wsl-x64)
    PBS_ASSET="cpython-3.12.13+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz"
    PIP_SPEC=("vllm==0.11.0" "pymupdf==1.28.0")
    PYBIN="python/bin/python3"
    ;;
  windows-x64)
    PBS_ASSET="cpython-3.12.13+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz"
    PIP_SPEC=("pymupdf==1.28.0")
    PYBIN="python/python.exe"
    ;;
  mac-arm64)
    PBS_ASSET="cpython-3.11.15+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"
    PIP_SPEC=("mlx-vlm==0.6.10" "pymupdf==1.28.0")
    PYBIN="python/bin/python3"
    ;;
  *)
    echo "build-env: unknown target '$TARGET'" >&2; exit 2 ;;
esac

NAME="foundry-env-${TARGET}-v1"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "==> $NAME: interpreter ($PBS_ASSET)"
rm -rf python "$NAME".tar.gz "$NAME".tar.gz.part* "$NAME".json
curl -fsSL -o pbs.tar.gz "${PBS_BASE}/${PBS_ASSET}"
tar -xzf pbs.tar.gz   # extracts to python/
rm pbs.tar.gz

echo "==> $NAME: packages (${PIP_SPEC[*]})"
"./$PYBIN" -m pip install --no-cache-dir --disable-pip-version-check "${PIP_SPEC[@]}"

# Bytecode caches are a third of some site-packages and regenerate on first
# import; they have no business being downloaded by every user.
find python -name '__pycache__' -type d -prune -exec rm -rf {} +

# The env states what it is, from inside: the installer writes settings from
# this rather than guessing, and a future doctor can verify an env against it.
"./$PYBIN" - "$TARGET" <<'PYEOF'
import json, sys, platform
import importlib.metadata as md
target = sys.argv[1]
pkgs = {}
for dist in md.distributions():
    name = dist.metadata["Name"]
    if name and name.lower() in ("vllm", "pymupdf", "mlx-vlm", "torch", "mlx"):
        pkgs[name.lower()] = dist.version
manifest = {
    "name": f"foundry-env-{target}-v1",
    "target": target,
    "python": platform.python_version(),
    "packages": pkgs,
}
with open("python/foundry-env.json", "w") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest))
PYEOF

echo "==> $NAME: archive"
tar -czf "$NAME.tar.gz" python

# GitHub Releases refuses a file over 2 GiB; slice under it with headroom.
BYTES=$(wc -c < "$NAME.tar.gz" | tr -d ' ')
PARTS=()
if [ "$BYTES" -gt 1900000000 ]; then
  echo "==> $NAME: ${BYTES} bytes — splitting"
  split -b 1900m -d -a 1 "$NAME.tar.gz" "$NAME.tar.gz.part"
  for p in "$NAME".tar.gz.part*; do PARTS+=("$p"); done
fi

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

echo "==> $NAME: hashes"
{
  echo '{'
  echo "  \"name\": \"$NAME\","
  echo "  \"target\": \"$TARGET\","
  echo "  \"pythonRelpath\": \"$PYBIN\","
  echo "  \"bytes\": $BYTES,"
  echo "  \"sha256\": \"$(sha "$NAME.tar.gz")\","
  echo -n '  "parts": ['
  first=1
  for p in "${PARTS[@]:-}"; do
    [ -z "$p" ] && continue
    [ $first -eq 0 ] && echo -n ', '
    first=0
    echo -n "{\"name\": \"$p\", \"bytes\": $(wc -c < "$p" | tr -d ' '), \"sha256\": \"$(sha "$p")\"}"
  done
  echo ']'
  echo '}'
} > "$NAME.json"
cat "$NAME.json"
echo "==> $NAME: DONE"
