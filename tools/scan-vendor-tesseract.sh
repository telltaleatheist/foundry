#!/usr/bin/env bash
#
# scan-vendor-tesseract.sh — record the Tesseract pin for THIS platform.
#
# Foundry ships an exact Tesseract with exact tessdata and verifies both by hash
# before reading a page (ARCHITECTURE 5). This script is what produces the
# recorded side of that check: it copies a Tesseract build and its language data
# into vendor/tesseract/<platform>/ and writes the version string, the binary's
# sha256 and every tessdata file's sha256 into vendor/tesseract/manifest.json.
#
#     tools/scan-vendor-tesseract.sh [path/to/tesseract] [lang ...]
#
# With no argument it takes the tesseract on PATH - which is the ONE place PATH
# is allowed to matter, because this is the developer choosing what to vendor,
# not the program choosing what to run. src/scan/tesseract.ts never looks there.
#
# Only manifest.json, the README and this script are committed. The binary and
# the .traineddata files are not: they are fetched or built by the packaging
# step, and .gitignore keeps them out (see /vendor/** there).
#
# HONESTY REQUIREMENT. A Homebrew or apt tesseract is dynamically linked against
# its package manager's libraries, so copying the executable alone does NOT give
# a build that runs on another machine. This script records what it actually
# copied, including whether it is relocatable, and writes `portable: false` when
# it is not. It does not pretend. See vendor/tesseract/README.md for what a real
# per-platform vendored build needs.

set -euo pipefail

# An interpreter that actually RUNS, not merely one that is on PATH. Windows
# puts a `python3` stub in WindowsApps that exits "Permission denied" until
# somebody installs from the Store, so `command -v python3` finds a name that is
# not a Python. Each candidate is probed.
PYTHON=""
for cand in "${PYTHON:-}" python3 python py; do
  [ -n "$cand" ] || continue
  if "$cand" -c "import sys" >/dev/null 2>&1; then PYTHON="$cand"; break; fi
done
if [ -z "$PYTHON" ]; then
  echo "no working python interpreter (tried python3, python, py); set PYTHON=<path>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/tesseract"

BIN="${1:-}"
if [ -n "$BIN" ]; then shift; fi
if [ -z "$BIN" ]; then
  BIN="$(command -v tesseract || true)"
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "no tesseract to vendor: pass a path, or install one on PATH" >&2
  exit 1
fi
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"
# Follow the symlink a package manager left on PATH; the Cellar/keg path is the
# real build, and its sha is the one worth recording.
if [ -L "$BIN" ]; then BIN="$("$PYTHON" -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$BIN")"; fi

LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then LANGS=(eng deu); fi

case "$(uname -s)" in
  Darwin) PLAT_OS=darwin ;;
  Linux)  PLAT_OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) PLAT_OS=win32 ;;
  *) echo "unknown platform $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) PLAT_ARCH=arm64 ;;
  x86_64|amd64)  PLAT_ARCH=x64 ;;
  *) echo "unknown architecture $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="$PLAT_OS-$PLAT_ARCH"

VERSION_LINE="$("$BIN" --version 2>&1 | head -1)"
VERSION="$(printf '%s' "$VERSION_LINE" | awk '{print $2}')"
if [ -z "$VERSION" ]; then
  echo "could not read a version from: $VERSION_LINE" >&2
  exit 1
fi

# Where this build keeps its language data. TESSDATA_PREFIX is deliberately the
# LAST resort: package managers point it at their own install, which is how a
# resolved-from-elsewhere tesseract ends up reporting zero languages.
BINDIR="$(dirname "$BIN")"
TESSDATA=""
for cand in "$BINDIR/tessdata" "$BINDIR/../share/tessdata" "$BINDIR/../share/tesseract-ocr/5/tessdata" \
            "$BINDIR/../share/tesseract-ocr/4.00/tessdata" "${TESSDATA_PREFIX:-}" "${TESSDATA_PREFIX:-}/tessdata"; do
  if [ -n "$cand" ] && [ -f "$cand/${LANGS[0]}.traineddata" ]; then
    TESSDATA="$(cd "$cand" && pwd)"
    break
  fi
done
if [ -z "$TESSDATA" ]; then
  echo "no tessdata directory holding ${LANGS[0]}.traineddata found near $BIN" >&2
  exit 1
fi

DEST="$VENDOR/$PLATFORM"
mkdir -p "$DEST/tessdata"
# Windows keeps the .exe suffix: the loader needs it, and the manifest records
# the name that is actually on disk rather than a tidied one.
BINNAME=tesseract
if [ "$PLAT_OS" = "win32" ]; then BINNAME=tesseract.exe; fi
cp -f "$BIN" "$DEST/$BINNAME"
chmod +x "$DEST/$BINNAME"

# On Windows the executable is an ~88 KB launcher and the engine is
# libtesseract-5.dll beside it, so the DLLs it loads are part of what gets
# vendored and part of what gets hash-pinned. Only the TRANSITIVE CLOSURE of
# tesseract.exe is copied: the install directory also carries pango, cairo, glib
# and ICU for text2image and the training tools, which a scan never loads.
if [ "$PLAT_OS" = "win32" ]; then
  if [ ! -f "$ROOT/tools/pe-closure.mjs" ]; then
    echo "tools/pe-closure.mjs is missing; cannot determine which DLLs to vendor" >&2
    exit 1
  fi
  DLLS="$(node "$ROOT/tools/pe-closure.mjs" "$BIN")"
  if [ -z "$DLLS" ]; then
    echo "no DLL closure computed for $BIN - refusing to vendor an exe with no libraries" >&2
    exit 1
  fi
  while IFS= read -r dll; do
    [ -n "$dll" ] || continue
    cp -f "$(dirname "$BIN")/$dll" "$DEST/$dll"
  done <<EOF
$DLLS
EOF
  echo "  vendored $(printf '%s\n' "$DLLS" | wc -l | tr -d ' ') DLLs beside $BINNAME"
fi

COPIED=()
for lang in "${LANGS[@]}"; do
  if [ -f "$TESSDATA/$lang.traineddata" ]; then
    cp -f "$TESSDATA/$lang.traineddata" "$DEST/tessdata/$lang.traineddata"
    COPIED+=("$lang.traineddata")
  else
    echo "  (no $lang.traineddata in $TESSDATA - skipped)" >&2
  fi
done
if [ ${#COPIED[@]} -eq 0 ]; then
  echo "vendored no language data at all; the pin would verify nothing" >&2
  exit 1
fi

# The `tsv` output mode is a CONFIG FILE inside tessdata, not a built-in flag:
# `tesseract ... tsv` reads <tessdata>/configs/tsv, which holds one line,
# `tessedit_create_tsv 1`. Point --tessdata-dir at a directory without it and
# tesseract prints "read_params_file: Can't open tsv" to stderr, exits ZERO, and
# emits PLAIN TEXT - which parses as no crops at all. So configs/ is part of what
# gets vendored, and configs/tsv is part of what gets hash-pinned.
if [ ! -f "$TESSDATA/configs/tsv" ]; then
  echo "no configs/tsv in $TESSDATA - the TSV output mode would silently fall back to text" >&2
  exit 1
fi
mkdir -p "$DEST/tessdata/configs"
cp -f "$TESSDATA/configs/tsv" "$DEST/tessdata/configs/tsv"

# Relocatable? On macOS a copied Homebrew binary still resolves its dylibs from
# /opt/homebrew, so it runs here and nowhere else. Record that rather than hide it.
PORTABLE=true
NOTE=""
case "$PLAT_OS" in
  darwin)
    DEPS="$(otool -L "$DEST/tesseract" | tail -n +2 | awk '{print $1}' | grep -v '^/usr/lib/' | grep -v '^/System/' || true)"
    if [ -n "$DEPS" ]; then
      PORTABLE=false
      NOTE="dynamically linked against $(printf '%s\n' "$DEPS" | wc -l | tr -d ' ') non-system libraries ($(printf '%s' "$DEPS" | head -3 | tr '\n' ' ')...); runs on this machine only. See vendor/tesseract/README.md."
    fi
    ;;
  linux)
    DEPS="$(ldd "$DEST/tesseract" 2>/dev/null | awk '{print $1}' | grep -v -E '^(linux-vdso|ld-linux|libc\.so|libm\.so|libpthread|libdl|librt)' || true)"
    if [ -n "$DEPS" ]; then
      PORTABLE=false
      NOTE="dynamically linked against $(printf '%s\n' "$DEPS" | wc -l | tr -d ' ') non-libc libraries; runs on this machine only. See vendor/tesseract/README.md."
    fi
    ;;
esac

# A human fact about this build that the probes cannot derive - "this is not the
# version the fixtures were recorded on", say. Wins over the computed note, and
# is the only way a deliberate divergence gets written down where the pin is read.
if [ -n "${VENDOR_NOTE:-}" ]; then NOTE="$VENDOR_NOTE"; fi

PLATFORM="$PLATFORM" VERSION="$VERSION" VERSION_LINE="$VERSION_LINE" \
PORTABLE="$PORTABLE" NOTE="$NOTE" VENDOR="$VENDOR" SOURCE_BIN="$BIN" SOURCE_TESSDATA="$TESSDATA" \
BINNAME="$BINNAME" \
"$PYTHON" - <<'PY'
import hashlib, json, os, datetime

vendor = os.environ["VENDOR"]
platform = os.environ["PLATFORM"]
dest = os.path.join(vendor, platform)
mpath = os.path.join(vendor, "manifest.json")

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

manifest = {"dpi": 200, "platforms": {}}
if os.path.exists(mpath):
    with open(mpath) as fh:
        manifest = json.load(fh)
    manifest.setdefault("dpi", 200)
    manifest.setdefault("platforms", {})
    # expectedVersion used to be GLOBAL, one number for every platform. It could
    # only ever be satisfied on the platform it was taken from - Homebrew ships
    # 5.5.1, the Windows builds report a datestamped 5.5.0.20241111 - so it moved
    # into each platform's own pin, and the global key is dropped on sight.
    manifest.pop("expectedVersion", None)

tessdata = {}
for name in sorted(os.listdir(os.path.join(dest, "tessdata"))):
    if not name.endswith(".traineddata"):
        continue
    full = os.path.join(dest, "tessdata", name)
    tessdata[name] = {"sha256": sha256(full), "bytes": os.path.getsize(full)}
# configs/tsv decides the OUTPUT FORMAT this program parses; a missing or
# different one degrades to plain text without an error code, so it is pinned
# exactly like the language data.
cfg = os.path.join(dest, "tessdata", "configs", "tsv")
tessdata["configs/tsv"] = {"sha256": sha256(cfg), "bytes": os.path.getsize(cfg)}

binname = os.environ["BINNAME"]

# Shared libraries sitting beside the binary. Hashed exactly like the language
# data: on Windows the .exe is a launcher and libtesseract-5.dll is the actual
# segmenter, so a pin that covered only the executable would verify the wrapper.
libraries = {}
for name in sorted(os.listdir(dest)):
    if name.lower().endswith(".dll"):
        full = os.path.join(dest, name)
        libraries[name] = {"sha256": sha256(full), "bytes": os.path.getsize(full)}

entry = {
    "binary": "%s/%s" % (platform, binname),
    "binarySha256": sha256(os.path.join(dest, binname)),
    "expectedVersion": os.environ["VERSION"],
    "versionLine": os.environ["VERSION_LINE"],
    "tessdataDir": "%s/tessdata" % platform,
    "tessdata": tessdata,
    "portable": os.environ["PORTABLE"] == "true",
    "recorded": datetime.date.today().isoformat(),
    "recordedFrom": {"binary": os.environ["SOURCE_BIN"], "tessdata": os.environ["SOURCE_TESSDATA"]},
}
if libraries:
    entry["libraries"] = libraries

# The published bundle is recorded SEPARATELY, by tools/record-vendor-artifact.mjs,
# after the tarball has been uploaded and its bytes re-downloaded and hashed. A
# re-scan must not silently drop it - nor keep it when the files it describes have
# changed underneath - so it is carried over only when the binary still hashes the
# same.
previous = manifest["platforms"].get(platform, {})
prev_artifact = previous.get("artifact")
if prev_artifact:
    if previous.get("binarySha256") == entry["binarySha256"]:
        entry["artifact"] = prev_artifact
    else:
        print("  NOTE: dropped the recorded artifact - the binary changed, so %s "
              "no longer describes this pin. Rebuild and re-upload the bundle."
              % prev_artifact.get("name", "it"))
if os.environ.get("NOTE"):
    entry["note"] = os.environ["NOTE"]
manifest["platforms"][platform] = entry

with open(mpath, "w") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=True)
    fh.write("\n")

print("%s  tesseract %s  %s" % (platform, entry["expectedVersion"],
                                "portable" if entry["portable"] else "NOT portable"))
for name, rec in tessdata.items():
    print("  %-24s %s  %d bytes" % (name, rec["sha256"][:16] + "...", rec["bytes"]))
if libraries:
    print("  %d libraries pinned, %d bytes total"
          % (len(libraries), sum(r["bytes"] for r in libraries.values())))
if entry.get("note"):
    print("  note: %s" % entry["note"])
print("wrote %s" % mpath)
PY
