#!/usr/bin/env bash
#
# build-env — cast one relocatable Python environment for one platform.
#
#   tools/env/build-env.sh wsl-x64          <workdir>   # linux: vllm (the reader)
#   tools/env/build-env.sh windows-x64      <workdir>   # windows: pymupdf (the rasteriser)
#   tools/env/build-env.sh mac-arm64        <workdir>   # mac: mlx-vlm + pymupdf (both)
#   tools/env/build-env.sh nli-windows-x64  <workdir>   # windows: torch + transformers + DeBERTa
#   tools/env/build-env.sh nli-mac-arm64    <workdir>   # mac: the same, MPS-capable
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
# ── THE `nli-*` TARGETS CARRY THEIR OWN WEIGHTS ─────────────────────────────
#
# The analysis worker (src/analyze/nli_worker.py) loads
# MoritzLaurer/deberta-v3-base-zeroshot-v2.0 with HF_HUB_OFFLINE set, because
# "nothing here downloads a model during an analysis". An environment that
# shipped only torch and transformers would therefore install successfully and
# then refuse the first analysis with a sentence about a cache it has never
# seen — so these two targets BAKE the weights into `python/hf-cache` and bake
# a `sitecustomize.py` that points HF_HOME at it. The env answers for itself:
# no engine edit, no environment variable the user has to know about, and a
# first run that is offline because there is nothing left to fetch.
#
# NO SYMLINKS SURVIVE IN THE ARCHIVE. huggingface_hub stores one copy of each
# file under `blobs/` and links `snapshots/` at it; the app unpacks with the
# system tar, and on Windows a symlink in the stream is a privilege error that
# fails the whole install. So the cache is FLATTENED — every snapshot entry is
# made a real file and `blobs/` is deleted — and then the build re-loads the
# model OFFLINE from the flattened cache before it will tar anything. If that
# ever stops being true this script fails here, at build time, which is the only
# place that failure is cheap.
#
# TORCH IS THE CPU BUILD ON WINDOWS, DELIBERATELY. The GPU on a machine running
# foundry is holding the reading model or the LLM; a 2.5 GB CUDA torch would
# double this archive to contend for a card that is already busy. Scoring a book
# on CPU is roughly an order of magnitude slower than on CUDA and the worker
# says which one it got on its ready line. On Apple silicon there is no such
# split — PyPI's macOS wheel is the Metal-capable one — so the mac target takes
# it as published and the worker picks `mps`.
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

TARGET="${1:?usage: build-env.sh <wsl-x64|windows-x64|mac-arm64|nli-windows-x64|nli-mac-arm64> <workdir>}"
WORKDIR="${2:?usage: build-env.sh <target> <workdir>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PBS_TAG=20260807
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}"

# Extra index arguments for the one pip call. Empty for every target that takes
# PyPI as published.
PIP_INDEX=()
# 1 for the targets that bake the NLI weights and verify them offline.
BAKE_NLI=0

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
  nli-windows-x64)
    # `2.9.1+cpu` is a LOCAL VERSION that exists only on pytorch's own index, so
    # naming it is what makes the choice unambiguous: PyPI has `2.9.1` (which on
    # Windows is also CPU-only today, but is not promised to stay that way) and
    # pip would take whichever it saw first. sentencepiece and protobuf are the
    # DeBERTa-v3 tokenizer's dependencies — transformers converts its
    # SentencePiece model on load and fails with a one-line "you need
    # sentencepiece" if they are absent.
    PBS_ASSET="cpython-3.12.13+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz"
    PIP_SPEC=("torch==2.9.1+cpu" "transformers==4.57.6" "sentencepiece==0.2.2" "protobuf")
    PIP_INDEX=(--extra-index-url https://download.pytorch.org/whl/cpu)
    PYBIN="python/python.exe"
    BAKE_NLI=1
    ;;
  nli-mac-arm64)
    PBS_ASSET="cpython-3.12.13+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"
    PIP_SPEC=("torch==2.9.1" "transformers==4.57.6" "sentencepiece==0.2.2" "protobuf")
    PYBIN="python/bin/python3"
    BAKE_NLI=1
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
"./$PYBIN" -m pip install --no-cache-dir --disable-pip-version-check \
  ${PIP_INDEX[@]+"${PIP_INDEX[@]}"} "${PIP_SPEC[@]}"

if [ "$BAKE_NLI" = "1" ]; then
  # ── the weights, and the file that makes them findable ────────────────────
  #
  # Written BEFORE the download so the populate step and every later run agree
  # on one cache directory: sitecustomize sets HF_HOME from `sys.prefix`, which
  # is `<dest>/python` wherever the archive is unpacked, so the path is correct
  # by construction on the build machine and on the user's.
  SITE_PACKAGES="$("./$PYBIN" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  cat > "$SITE_PACKAGES/sitecustomize.py" <<'PYEOF'
"""sitecustomize — this environment carries its own Hugging Face cache.

Imported by `site` at interpreter startup, before anything else in the process,
which is the only moment early enough to matter: huggingface_hub reads HF_HOME
once at import and freezes the paths it derives from it, so a value set after
`import transformers` is a value that changes nothing.

`setdefault`, never an assignment: somebody who has exported HF_HOME because
they keep one shared cache for every tool on the machine has said something,
and an environment overriding it would silently download a second copy of every
model they own. The baked cache is the DEFAULT for this interpreter, not a law.

`sys.prefix` rather than a path written at build time: the archive is unpacked
wherever the user chose, and an absolute path from the build machine would name
a directory that has never existed on theirs.
"""
import os
import sys

_cache = os.path.join(sys.prefix, 'hf-cache')
if os.path.isdir(_cache):
    os.environ.setdefault('HF_HOME', _cache)
PYEOF

  echo "==> $NAME: baking MoritzLaurer/deberta-v3-base-zeroshot-v2.0"
  "./$PYBIN" - <<'PYEOF'
import os, sys
# Set before transformers is imported at all — see sitecustomize's docstring.
os.environ['HF_HOME'] = os.path.join(sys.prefix, 'hf-cache')
os.environ.pop('HF_HUB_OFFLINE', None)
os.environ.pop('TRANSFORMERS_OFFLINE', None)
from transformers import pipeline
# Loading through the PIPELINE rather than snapshot_download: the pipeline is
# what nli_worker.py calls, so this fetches exactly the files that worker will
# ask for and nothing else, and it proves the configuration loads before a
# gigabyte is tarred.
clf = pipeline('zero-shot-classification',
               model='MoritzLaurer/deberta-v3-base-zeroshot-v2.0',
               device='cpu')
out = clf('The court remanded the case for resentencing.',
          candidate_labels=['a legal ruling', 'a recipe'], multi_label=True)
print('bake:', out['labels'], [round(s, 4) for s in out['scores']])
PYEOF

  echo "==> $NAME: flattening the cache (no symlinks, no blobs)"
  "./$PYBIN" - <<'PYEOF'
import os, shutil, sys
root = os.path.join(sys.prefix, 'hf-cache')

# 1. Every snapshot entry becomes a REAL FILE. On a machine where the hub could
#    create symlinks these are links into blobs/; the app's unpacker is the
#    system tar and on Windows a symlink in the stream is a privilege error that
#    fails the install for everyone.
links = 0
for base, dirs, files in os.walk(root):
    for name in files:
        path = os.path.join(base, name)
        if os.path.islink(path):
            real = os.path.realpath(path)
            os.unlink(path)
            shutil.copy2(real, path)
            links += 1

# 2. blobs/, .locks/ and .no_exist/ go. Offline resolution reads refs/ and
#    snapshots/ only — `try_to_load_from_cache` composes
#    snapshots/<rev>/<file> and asks whether that is a file — so the blob copies
#    are pure duplication once step 1 has run. The offline verify below is what
#    holds this claim to account.
dropped = 0
for base, dirs, files in os.walk(root, topdown=True):
    for name in list(dirs):
        if name in ('blobs', '.locks', '.no_exist'):
            victim = os.path.join(base, name)
            dropped += sum(len(f) for _, _, f in os.walk(victim))
            shutil.rmtree(victim)
            dirs.remove(name)

total = sum(os.path.getsize(os.path.join(b, f))
            for b, _, fs in os.walk(root) for f in fs)
print('flatten: %d symlinks made real, %d duplicate files dropped, cache is %.1f MB'
      % (links, dropped, total / 1e6))
PYEOF

  echo "==> $NAME: OFFLINE verify (a fresh interpreter, no HF_HOME in the environment)"
  # No HF_HOME here on purpose: this run must find the cache the way the user's
  # machine will, through sitecustomize alone. The offline flags are the ones
  # nli-bridge.ts sets for every analysis.
  ( unset HF_HOME; HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "./$PYBIN" - <<'PYEOF'
import os
from transformers import pipeline
print('offline: HF_HOME =', os.environ.get('HF_HOME'))
clf = pipeline('zero-shot-classification',
               model='MoritzLaurer/deberta-v3-base-zeroshot-v2.0', device='cpu')
out = clf('The court remanded the case for resentencing.',
          candidate_labels=['a legal ruling', 'a recipe'], multi_label=True)
print('offline:', out['labels'], [round(s, 4) for s in out['scores']])
PYEOF
  )

  # ── one request through the REAL worker ───────────────────────────────────
  # The pipeline loading is not the contract; the wire is. This drives the
  # worker the app will drive, over the stdio protocol nli-bridge.ts speaks,
  # and refuses to build an archive whose worker does not answer.
  if [ -f "$REPO_ROOT/src/analyze/nli_worker.py" ]; then
    echo "==> $NAME: one request through src/analyze/nli_worker.py"
    printf '{"id":1,"texts":["The court remanded the case for resentencing."],"hypotheses":["a legal ruling","a recipe"]}\n' \
      | ( unset HF_HOME; HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
          "./$PYBIN" "$REPO_ROOT/src/analyze/nli_worker.py" ) \
      | tee worker-probe.txt
    grep -q '"scores"' worker-probe.txt \
      || { echo "build-env: the worker never answered with scores" >&2; exit 3; }
    rm -f worker-probe.txt
  else
    echo "build-env: WARNING — $REPO_ROOT/src/analyze/nli_worker.py not found; wire unverified" >&2
  fi
fi

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
    if name and name.lower() in ("vllm", "pymupdf", "mlx-vlm", "torch", "mlx",
                                 "transformers", "sentencepiece"):
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
