# vendor/tesseract — the pin

Foundry ships an **exact Tesseract with exact tessdata** and verifies both by
hash before it reads a page (ARCHITECTURE §5). Tesseract is not a preprocessing
detail here — it is the segmenter the models were *trained against*. Layout
analysis changes between versions and paragraph grouping moves with resolution,
so picking up whatever `tesseract` is on `PATH` silently shifts the input
distribution: nothing errors, blocks come out slightly differently grouped,
labels get slightly worse, and every symptom points at the models.

```
manifest.json                     the pin: version + sha256s   (COMMITTED)
README.md                         this file                    (COMMITTED)
<platform>/tesseract              the binary                   (never committed)
<platform>/tessdata/eng.traineddata                            (never committed)
<platform>/tessdata/configs/tsv                                (never committed)
```

`<platform>` is `${process.platform}-${process.arch}` — `darwin-arm64`,
`linux-x64`, `win32-x64`. `.gitignore` keeps everything under `vendor/` out of
git except this file and `manifest.json`: a binary and 4 MB of language data
belong to the packaging step, but the *pin* is code.

Record a platform with:

```
tools/scan-vendor-tesseract.sh [path/to/tesseract] [lang ...]
```

`src/scan/tesseract.ts` then verifies, before the first page: the resolved
binary's `--version` against `expectedVersion`, its sha256 against
`binarySha256` when it came from here, and every file in `tessdata` against its
recorded sha256 and byte count. A mismatch is an error naming the file.

`--tesseract <path>` overrides **which binary is used** — for development, and
for a packager with a verified system copy. It still runs the version check, and
the tessdata still comes from this directory. It is not an escape hatch from the
pin, and there is no "use the system tesseract if the bundled one is missing"
path: a missing vendored Tesseract is an error that says which paths were
checked.

## Why `configs/tsv` is pinned too

`tesseract … tsv` is not a built-in flag. It is a **config file inside tessdata**
— `<tessdata>/configs/tsv`, whose entire content is `tessedit_create_tsv 1`.
Point `--tessdata-dir` at a directory that lacks it and Tesseract prints
`read_params_file: Can't open tsv` to stderr, **exits zero**, and emits plain
text instead. Plain text has no `page_num` column, so it accounts for no crops
at all and the whole page reads as empty. It cost an afternoon once; it is hash-
pinned now, and the parser refuses output that does not account for every crop.

## The honest state of the vendored binaries (Aug 2026)

**Only `darwin-arm64` is recorded, it was taken from Homebrew, and it is NOT
portable.** `manifest.json` says so: `"portable": false`, with a note listing
the libraries it needs.

```
$ otool -L vendor/tesseract/darwin-arm64/tesseract
  /opt/homebrew/Cellar/tesseract/5.5.1/lib/libtesseract.5.dylib
  /opt/homebrew/opt/leptonica/lib/libleptonica.6.dylib
  /opt/homebrew/opt/libarchive/lib/libarchive.13.dylib
  …
```

The copied executable is 103 KB — a launcher for `libtesseract.5.dylib`, which
is not beside it. It runs on **this machine**, because the dylibs are still at
`/opt/homebrew`, and on no other. Copying it into a release would produce a
binary that fails at `dlopen` on a user's Mac, which is a worse failure than not
shipping one, so the manifest records what is actually true rather than what the
layout implies. The verification logic does not care either way: it checks the
hashes it was given, and `portable` is a fact about the recorded build, not a
switch.

### What a real vendored build needs, per platform

| platform | what to produce |
|---|---|
| **darwin-arm64 / darwin-x64** | A relocatable bundle: `tesseract` plus `libtesseract`, `libleptonica`, `libarchive`, `libtiff`, `libpng`, `libjpeg`, `libwebp`, `libopenjp2`, `zlib`, with `install_name_tool -change`/`-add_rpath` rewriting every non-system `LC_LOAD_DYLIB` to `@executable_path/../lib`. Then codesign, because a rewritten Mach-O has an invalid signature and Gatekeeper kills it. Or build Tesseract and Leptonica statically and link one executable, which is the smaller headache. |
| **linux-x64** | Static, or a bundle with `$ORIGIN` rpaths. glibc is the sharp edge: build on the OLDEST supported distro or the binary will not start on it. |
| **win32-x64** | The UB Mangoes build ships a self-contained `tesseract.exe` with its DLLs beside it. Vendor the whole directory and record every DLL's hash. |

All three must be **the same Tesseract version**, and it must be the version the
models were trained against — the script refuses to record a second platform at
a different version without a deliberate change to `expectedVersion`.

`eng.traineddata` is 4.1 MB and is the same file on every platform (it is data,
not code), so it is the one part of this that already is portable. It is
recorded per platform anyway, because the pin is a statement about a whole
install and splitting it would invite the two halves to drift.
