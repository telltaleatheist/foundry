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
foundry convert scan.pdf -o book.epub
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

`foundry convert` runs all five. Each stage is also a standalone command reading
and writing the same blocks JSON, so a run can be stopped, inspected by hand,
edited, and resumed.

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
BookForge ──spawn──> foundry convert in.pdf -o out.epub --llama-server <its own>
```

Nothing in Foundry knows what an audiobook is.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the decisions and why,
and [`docs/MIGRATION.md`](docs/MIGRATION.md) for what still has to move over.

---

## Status

**Scaffold.** The command surface exists; every command is a stub that prints
what the stage will do and exits 1. No code has been migrated yet.

```bash
bun run src/cli.ts --help
bun run src/cli.ts convert --help
```

Build:

```bash
bun run build          # this platform
bun run build:all      # mac arm64/x64, linux x64, windows x64
```
