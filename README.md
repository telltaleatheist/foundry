# Foundry

**Recasts broken scans into clean books.**

A type foundry melts down worn and damaged type and casts it fresh. This one
takes a badly scanned PDF — skewed pages, blown-out serifs, running heads and
page numbers embedded in the text, footnote daggers glued to the ends of
sentences — and casts it back into an EPUB you can actually read, or hand to a
narrator.

It is a single command-line program. End users install no runtime, no Python, no
Node: the distribution is **three binaries and a set of weights**.

```
foundry convert --pages page-renders/ --run run/ -o book.epub
```

---

## The pipeline

```
  input.pdf
      │
      ▼
 ┌──────────┐   pinned Tesseract, 200 dpi. One record per text block:
 │   scan   │   page, bounding box, raw recognized text, word confidences.
 └──────────┘   The ONLY stage that touches the PDF.
      │  blocks.json
      ▼
 ┌──────────┐   adapter: foundry-boxes
 │  boxes   │   What IS this block? body · chapter opening · subheading ·
 └──────────┘   running head · page number · footnote · caption · table
      │         fragment · title · discard
      │  blocks.json + categories
      ▼
 ┌──────────┐   adapter: foundry-ocr
 │   ocr    │   Repair what Tesseract got wrong, line by line, under an edit
 └──────────┘   contract: the model emits `before → after`, an applier applies
      │         it, and an edit that does not match the source is rejected.
      │  blocks.json + corrected text
      ▼
 ┌──────────┐   adapter: foundry-footnotes
 │footnotes │   Delete the inline reference markers (†, ‡, *, superscript
 └──────────┘   numbers) so a narrator does not read them out loud.
      │  blocks.json, clean
      ▼
 ┌──────────┐   Categories drive the XHTML: what is narrated, what is dropped,
 │  export  │   where the chapters split, where the paragraphs actually end.
 └──────────┘
      │
      ▼
  output.epub
```

`foundry convert` runs all five. Each stage is also a standalone command, and
they do not pass data hand to hand — **every stage writes its artifact into a
run directory at a documented path, and the next stage reads it from there**
(see [`docs/PIPELINE.md`](docs/PIPELINE.md)). So a run can be stopped, inspected
by hand, edited, and resumed, and BookForge can read the data at every step
rather than only the EPUB at the end.

```
foundry scan      --pages <renders> --run <run>
foundry boxes     --run <run>
foundry ocr       --run <run>
foundry footnotes --run <run>
foundry export    --run <run> -o book.epub [--exclude footnote]... [--exclude-ids ids.txt]
```

## Page input

**Foundry does not rasterize PDFs yet.** `scan` takes a directory of page
renders — binary PGM (P5), 8-bit grayscale, **rendered at 200 dpi** — and reads
them in natural page order.

That is not a placeholder for a missing feature so much as a boundary that is
currently drawn in the right place: BookForge already has a pooled mupdf.js
renderer and hands over the pages it has already produced. Standalone PDF input
is the next milestone, and it must land at 200 dpi — every model here was
trained against the segmentation of one Tesseract at that resolution, and a
render at any other silently changes the input distribution (see "the
strip-down" below).

There is deliberately no "close enough" path: a directory with no PGM pages is
an error that says what the format is, not a scan of nothing.

---

## The models

Three LoRA adapters over **one shared Qwen3-4B base** (`foundry:4b`). One
resident base model; adapters are hot-swapped per request through
llama-server's multi-LoRA support.

| Adapter | Id | Was called | Does |
|---|---|---|---|
| boxes | `foundry-boxes-v1-4b` | rubric | Labels every text block on a page with what it is |
| ocr | `foundry-ocr-v1-4b` | galley / proof | Repairs Tesseract errors, line level, under the edit contract |
| footnotes | `foundry-footnotes-v1-4b` | dagger | Removes inline footnote reference markers |

**The id carries the version and the size, and both are load-bearing.** The
encoder parses the version out of the id to choose the prompt format and the
legal class list. An id without a version reads as v1 and builds a prompt
advertising a taxonomy that was retired.

Weights are hosted on HuggingFace under **owenmorgan**, pulled on first run and
verified by sha256. Code lives on GitHub. Nothing is bundled into the binary.

```
foundry models list     # catalog: id, version, size, sha256, present?, verified?
foundry models pull     # download what is missing, verify on arrival
```

---

## The strip-down

There is no runtime to install. Foundry is TypeScript compiled by
`bun build --compile` into a self-contained per-platform executable, and it
ships beside two other binaries it drives as subprocesses:

```
foundry           the CLI itself — one file, no Node, no Python
tesseract         a PINNED build with PINNED tessdata, sha-verified
llama-server      bundled llama.cpp, serving the base model on /completion
+ weights         pulled on first run from HuggingFace, sha256-verified
```

**Pinned Tesseract, never PATH Tesseract.** Every model here was trained on the
output of one specific Tesseract at 200 dpi, and its layout segmentation moves
between versions. Picking up the distro's tesseract silently shifts the input
distribution, and the damage reads as a bad model rather than a bad
installation. `--tesseract <path>` overrides which binary is used; it does not
skip the version check.

**No fallbacks anywhere.** A missing binary, a missing weight, a missing input
file, an unverified checksum: each is an error that names the missing thing and
exits nonzero. Nothing degrades quietly into doing less than it was asked.

---

## Relationship to BookForge

Foundry is extracted from [BookForgeApp](https://github.com/telltaleatheist/bookforge),
which builds audiobooks and needed clean text before it could narrate anything.

**This repository is the single implementation.** The prompt encoders and the
edit appliers live here and only here — they are not copied into BookForge,
because two copies of a prompt format means one of them is wrong within a month
and neither is obviously the stale one.

BookForge consumes Foundry as a **subprocess**, the same way it already drives
ebook2audiobook. It can pass `--llama-server <path>` to reuse the llama.cpp
binary it already bundles, rather than shipping a second copy of it.

```
BookForge ──spawn──> foundry scan  --pages <its mupdf renders> --run <run>
          ──spawn──> foundry boxes --run <run> --llama-server <its own>
          ──reads───> <run>/boxes/blocks.json   (paints pdf-picker's category layer)
          ──spawn──> foundry export --run <run> -o out.epub --exclude-ids <deleted boxes>
```

Nothing in Foundry knows what an audiobook is.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the decisions and why,
and [`docs/MIGRATION.md`](docs/MIGRATION.md) for what still has to move over.

---

## Status

**v0.1.0 — the scan pipeline runs; the model stages are waiting on published
weights.**

| | |
|---|---|
| `models list` / `pull` | wired. The catalog is **empty**: no weights are published yet, and both commands say exactly that rather than reporting a missing file. |
| `scan` | **works.** Verified end to end on fixture pages: pinned Tesseract 5.5.1, band segmentation, `scan/pages.json` + `scan/lines.json` + `run.json`. |
| `boxes` | wired end to end — block formation, prompt encoding, llama-server lifecycle, answer parsing, `boxes/blocks.json`. Verified against a real trained checkpoint via `--base-model` + `--llama-server`. Stops at the catalog otherwise. |
| `ocr` | **blocked on a migration.** The edit contract and applier are here; the trained-against system prompt is still only in BookForgeApp and will not be re-typed (docs/MIGRATION.md §2). The command says so and exits 1. |
| `footnotes` | wired end to end — prose-block selection, prompt, subsequence-guarded applier, `footnotes/deletions.json`. Verified against a real trained checkpoint. |
| `export` | **works.** Categories drive the XHTML, the §9d rules assemble the paragraphs, wrap hyphens are healed only on the book's own evidence, and exclusion composes at both granularities. Writes `export/book.epub` + `export/exclusions.json`; `-o` additionally copies. Verified: a real EPUB out of real scanned pages. |
| `convert` | chains all five. It stops at the first stage that cannot run — today that is `ocr` — and every artifact written before that point stays on disk, with the failure recorded in `run.json`. |

Local weights can be pointed at directly, which is how the wired stages are
verified before anything is published:

```bash
foundry boxes --run <run> \
  --base-model <merged.gguf> \
  --llama-server <path to llama-server>
```

`--base-model` with no `--adapter` means a **merged** fine-tune: the base answers
directly and no adapter is applied. With both, the adapter's filename carries the
version that picks the prompt format.

## Build

```bash
bun run typecheck
bun test
bun run build            # this machine
bun run build:all        # darwin arm64/x64, linux x64, windows x64
tools/release-package.sh # tarballs + checksums.txt into dist/release/
```

`tools/release-build.sh` bakes the git commit into the binary, so
`foundry --version` reports `0.1.0 (a1b2c3d)` and a build from a dirty tree says
`+dirty` rather than claiming the commit it was nearly built from.

## Install

A release asset is one binary in a tarball. **The vendored Tesseract is not in
it** — see [`vendor/tesseract/README.md`](vendor/tesseract/README.md) for what a
portable build per platform actually requires; only `darwin-arm64` is recorded
today and that copy is not relocatable. Until those exist, run with
`--tesseract <path>` pointing at a Tesseract 5.5.1 that matches the pin.

`vendor/` is resolved beside the executable (or one directory up), never from
`PATH`.
