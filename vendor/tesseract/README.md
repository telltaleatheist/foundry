# vendor/tesseract — the pin

Foundry uses an **exact Tesseract with exact tessdata** and verifies both by
hash before it reads a page (ARCHITECTURE §5). Tesseract is not a preprocessing
detail here — it is the segmenter the models were *trained against*. Layout
analysis changes between versions and paragraph grouping moves with resolution,
so picking up whatever `tesseract` is on `PATH` silently shifts the input
distribution: nothing errors, blocks come out slightly differently grouped,
labels get slightly worse, and every symptom points at the models.

```
manifest.json                     the pin: versions + sha256s  (COMMITTED)
README.md                         this file                    (COMMITTED)
<platform>/tesseract[.exe]        the binary                   (never committed)
<platform>/*.dll                  its libraries, on Windows    (never committed)
<platform>/tessdata/eng.traineddata                            (never committed)
<platform>/tessdata/configs/tsv                                (never committed)
```

`<platform>` is `${process.platform}-${process.arch}` — `darwin-arm64`,
`linux-x64`, `win32-x64`. `.gitignore` keeps everything under `vendor/` out of
git except this file and `manifest.json`: a binary and 4 MB of language data
belong to the packaging step, but the *pin* is code.

## Where the pin lives, and where the files live

The two are deliberately separate.

**The pin is compiled into the binary.** `src/scan/tesseract.ts` imports
`manifest.json`, so the bundler inlines it and a packaged foundry carries its own
pin. It used to be read off disk relative to `import.meta.url`, which in a
`bun build --compile` executable points *beside the exe* — and the release ships
one file. A packaged install therefore looked for its pin in
`…/components/foundry-cli/vendor/tesseract/manifest.json`, found nothing, and
refused to scan. Scan worked only from a checkout.

**The files are found, in this order:**

1. `--tesseract <path>` — overrides *which binary runs*, and nothing else. The
   version check still runs against it and the tessdata still comes from a
   vendor root. It is not an escape hatch from the pin.
2. the dev checkout's `vendor/tesseract/<platform>/`, when there is one. First,
   so that re-vendoring a build to test it does what you meant.
3. the platform data dir — `<data>/foundry/vendor/tesseract/<platform>/`, beside
   the weights — which is where `foundry models pull` puts the download.

There is no fourth. A missing Tesseract is an error naming every path checked
and the command that fetches one.

## Fetching it

`foundry models pull` downloads this platform's bundle along with the weights,
because a scan needs the segmenter exactly as much as a label needs the blocks
model. The bundle is recorded in the pin as `artifact: {name, url, sha256,
bytes}`, hosted on the repo's stable `assets` release tag, verified on arrival
by the same downloader the weights use, and extracted only after its sha256
matches. `foundry models list` reports whether it is present and verified.

Record a platform with:

```
tools/scan-vendor-tesseract.sh [path/to/tesseract] [lang ...]
```

Then publish and record the bundle — in that order, always:

```
tar -czf tesseract-<version>-<platform>.tar.gz -C vendor/tesseract/<platform> .
gh release upload assets tesseract-<version>-<platform>.tar.gz --clobber
node tools/record-vendor-artifact.mjs <platform> <url>
```

`record-vendor-artifact.mjs` **downloads the URL and hashes what arrives**. It
never reads the tarball you just built. A hash taken from the local file asserts
things nobody checked — that the upload finished, that it landed on the tag you
meant, that nothing rewrote it — and each of those failures then surfaces as a
checksum mismatch on a stranger's first run, pointing at their network instead
of at the release. Same rule the model catalog states: upload, verify the
uploaded bytes, *then* record.

## What is verified, before the first page

The binary's sha256, its `--version` against that platform's `expectedVersion`,
every bundled library's sha256, and every tessdata file's sha256 and byte count.
A mismatch is an error naming the file.

The libraries are in that list because on Windows `tesseract.exe` is an 88 KB
launcher and `libtesseract-5.dll` is the actual engine. A pin covering only the
executable would verify the wrapper and leave the segmenter unchecked.

## Why the version is per platform

`expectedVersion` used to be one global number. It could only ever be satisfied
on the platform it was taken from: Homebrew publishes `5.5.1`, and the Windows
builds report a datestamped `v5.5.0.20241111`. There is no single Tesseract
version that exists as a real build everywhere, so the pin records one per
platform and the check compares against that platform's.

`dpi` stays global, and that one genuinely is: it keys the training corpus.

The version string is recorded **verbatim**, as that build spells it — `5.5.1`
on one, `v5.5.0.20241111` on another. The scan script takes the second field of
`--version` with awk and `readVersion` takes it with a regex; normalising would
mean two normalisations that can drift, in exchange for a prettier string.

## Why `configs/tsv` is pinned too

`tesseract … tsv` is not a built-in flag. It is a **config file inside tessdata**
— `<tessdata>/configs/tsv`, whose entire content is `tessedit_create_tsv 1`.
Point `--tessdata-dir` at a directory that lacks it and Tesseract prints
`read_params_file: Can't open tsv` to stderr, **exits zero**, and emits plain
text instead. Plain text has no `page_num` column, so it accounts for no crops
at all and the whole page reads as empty. It cost an afternoon once; it is hash-
pinned now, and the parser refuses output that does not account for every crop.

## The honest state of the vendored builds (Aug 2026)

### win32-x64 — recorded, published, and NOT the fixtures' version

The UB Mangoes build (via scoop) is genuinely self-contained: `tesseract.exe`
plus the 34 DLLs it actually loads, all hash-pinned. `tools/pe-closure.mjs` walks
the PE import table to decide which those are — the install directory carries 56,
but 22 are pango, cairo, glib and ICU for `text2image` and the training tools,
which a scan never touches.

**It is 5.5.0.20241111, not the 5.5.1 the corpus and the fixtures were recorded
on, because no Windows build of 5.5.1 is published.** On the fixture pages it
segments *identically* — same band boxes, same psm — but recognises 7 of 138
lines differently (`rebellion` → `tebellion`, stray trailing punctuation) and
reports different confidences throughout. So Windows output is expected to be
very slightly worse than the darwin measurements until either a 5.5.1 Windows
build is vendored or the corpus is re-measured against this one.

That is written down rather than smoothed over, and the end-to-end fixture
comparison in `test/scan/tesseract.test.ts` skips loudly when the resolved
version is not the fixtures' — it would otherwise be measuring the gap between
two Tesseracts and calling it a regression.

### darwin-arm64 — recorded, NOT portable, NOT publishable

Taken from Homebrew, `"portable": false`, and it must stay that way until a real
bundle is built:

```
$ otool -L vendor/tesseract/darwin-arm64/tesseract
  /opt/homebrew/Cellar/tesseract/5.5.1/lib/libtesseract.5.dylib
  /opt/homebrew/opt/leptonica/lib/libleptonica.6.dylib
  /opt/homebrew/opt/libarchive/lib/libarchive.13.dylib
  …
```

The copied executable is 103 KB — a launcher for `libtesseract.5.dylib`, which
is not beside it. It runs on **that machine**, because the dylibs are still at
`/opt/homebrew`, and on no other. It therefore has **no `artifact`**: publishing
it would produce a bundle that fails at `dlopen` on a user's Mac, which is worse
than not shipping one. **The Mac packaged story is still open** — `models pull`
on macOS reports that no bundle is published for the platform, and a Mac user
needs `--tesseract` pointing at their own install until a relocatable bundle is
built and recorded.

### linux-x64 — unrecorded

`models pull` says so, and the error says how to record one.

### What a real vendored build needs, per platform

| platform | what to produce |
|---|---|
| **darwin-arm64 / darwin-x64** | A relocatable bundle: `tesseract` plus `libtesseract`, `libleptonica`, `libarchive`, `libtiff`, `libpng`, `libjpeg`, `libwebp`, `libopenjp2`, `zlib`, with `install_name_tool -change`/`-add_rpath` rewriting every non-system `LC_LOAD_DYLIB` to `@executable_path/../lib`. Then codesign, because a rewritten Mach-O has an invalid signature and Gatekeeper kills it. Or build Tesseract and Leptonica statically and link one executable, which is the smaller headache. |
| **linux-x64** | Static, or a bundle with `$ORIGIN` rpaths. glibc is the sharp edge: build on the OLDEST supported distro or the binary will not start on it. |
| **win32-x64** | Done — see above. |

`eng.traineddata` is 4.1 MB and is the same file on every platform (it is data,
not code): the win32 copy hashes byte-identical to the darwin one, which is the
claim actually checked rather than assumed. It is recorded per platform anyway,
because the pin is a statement about a whole install and splitting it would
invite the two halves to drift.
