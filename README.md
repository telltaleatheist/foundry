# Foundry

**Recasts broken scans into clean books.**

A type foundry melts down worn and damaged type and casts it fresh. This one
takes a badly scanned PDF — skewed pages, blown-out serifs, running heads and
page numbers embedded in the text, footnote daggers glued to the ends of
sentences — and casts it back into an EPUB you can actually read, or hand to a
narrator.

A document vision model reads each page picture whole and answers with
marked-up text; foundry parses the answers and assembles the book.

```
foundry vlm-convert --pdf book.pdf --out book.epub \
    [--vlm-model <id>] [--python <path>] [--readings answers.jsonl] \
    [--fresh-readings | --reuse-readings] [--skip-pages 3,17,19-24] \
    [--chapters chapters.json] [--vlm-endpoint http://host:8000/v1]
```

Foundry used to carry a second, entirely separate route: a Tesseract +
stage-model pipeline (scan → blocks → ocr → footnotes → export) with its own
trained Qwen3-4B checkpoints. The VLM route won the comparison the two were
built to have, and the pipeline was stripped. The whole thing — code, docs,
tests — is preserved at the git tag **`pre-vlm-strip`**.

`--skip-pages` leaves pages out of the book — not rasterised, not read, not in
the EPUB. It is a **skip, not a subset**: the PDF is never rewritten, so its
sha256 (the identity `--readings` is keyed to) survives the curation, and every
page that stays keeps its true page number in `data-bf-page`. A paragraph is
never joined across the hole a skip leaves.

What foundry needs beyond its own binary is a Python with PyMuPDF in it, and
with MLX too unless the reading happens elsewhere — `src/vlm/vlm_page.py`
renders the pages at 200 dpi and, on the MLX path, reads them in ONE subprocess
for the whole book (one model load, not one per page), streaming a JSON object
per page back.

## dots.ocr, the default — the one that answers with geometry

`dots-ocr` (`mlx-community/dots.ocr-4bit`) does not answer with a stream of
text. It answers with a JSON array of `{bbox, category, text}` in reading order
over eleven categories, and **everything this mode can do that a markdown model
cannot follows from that**:

| what | how |
|---|---|
| page furniture goes | `Page-header` / `Page-footer` are dropped because the model says which blocks they are — no tag convention to rely on, no running head left in the prose |
| the furniture it MISLABELLED goes too | a running head the model called a `Title` is found by the book's own repetition: the same text, reduced past letter-spacing, decoration and folio, in the top 15% of three or more pages, at least one of them tagged furniture. Both facts are required — `THE DEFENSE` heads 55 pages of Nuremberg *and* names its third part, and only the height on the page tells them apart |
| a picture is a picture | the `Picture` box is cropped out of the page at 200 dpi, embedded, and kept with its `Caption` |
| footnotes are endnotes | `Footnote` blocks collect at the end of their **chapter** — not per page — split into one paragraph per note at the superscript that opens it |
| a marker is markup | reference numbers arrive as dedicated superscript codepoints, so they become real `<sup>`, or come out entirely with `--strip-note-markers` for a narration build |
| centered means centered | alignment is judged against the **book's own body column** (the median edges of its full-width `Text` blocks), never the page — a justified column is itself centered on the paper, so a page-relative rule calls every paragraph in the book centered |
| a paragraph survives a page turn | the words decide when they can (no terminal punctuation, next block opens lowercase); when they cannot, the **ink** does — a continuing paragraph fills its last line to the right margin, and a genuinely new one starts with a first-line indent |
| a broken word is one word | the fuse-or-keep decision uses **the book as its own dictionary**: fuse if the fused form appears in it, keep the hyphen if the compound does, otherwise fuse iff the continuation is lowercase |
| markdown never reaches the reader | dots writes `# …` headings and `> ` quote runs *inside* a text field; they become real headings and blockquotes |
| a newline is a line ending | it reflows wrapped prose, so a break it kept is one the page had — a contents entry, a line of verse — and becomes `<br/>` |
| except when it is a print line | it does not reflow *every* paragraph (386 of Nuremberg's blocks kept their print breaks), so a `Text` block with no blank line in it whose every line but the last is ≥ 45 characters is put back together: a justified column fills every line to the margin, and verse does not |

Chapters are **proposed, not decided**: a `Title` or `Section-header`, first on
its page, in the top 45%, short, and either chapter-ish or centered.
`--chapters` writes the list out as data with the reason each one fired. It
over-includes — decorative half-titles land in it — and that is the design: an
extra costs a click, a missed chapter cannot be recovered.

A **bare arabic number** is the one heading that proposal rule asks the whole
book about. `16` is a chapter in a novel numbered 1, 2, 3 and a section mark in
a work of history that renumbers from 1 in every part, and the difference is the
SEQUENCE: two or more bare numbers that do not strictly increase across the book
are section marks, and none of them proposes a chapter. They still render where
the printer put them. Roman numerals are the part rule's business and untouched.

Every element in the book carries **`data-bf-page`** (the PDF page it was read
from) and **`data-bf-cat`** (the model's own category, lower-cased:
`text`, `title`, `section-header`, `footnote`, `caption`, `table`, `picture`,
`quote`, `formula`, `list-item`) — with one value that is not the model's:
**`chapter`**, on the heading a chapter proposal points at, and on the display
headings of a part divider. That is BookForge's own palette category ("Chapter
Openings"), and it is what makes a proposal something a person can see and move
rather than an offer nothing in the book records. An EPUB has no page concept
and no memory of a layout model's opinion, and both are unrecoverable once the
pages are joined — these two attributes are what let a picker say "every
footnote" or "everything that was on page 3". Standard `epub:type="pagebreak"`
markers are emitted at the page boundaries as well, inside the paragraph when
the turn happened mid-sentence.

The three markdown models stay in the registry. They are what dots is measured
against, and each is asked in the prompt its own model card documents,
VERBATIM. That prompt is load-bearing (ARCHITECTURE §4): asking Qwen2.5-VL for
an ad-hoc JSON layout produced fabricated bounding boxes, while asking it for
`QwenVL HTML` — its trained format — produced real geometry. Adding a model is
a registry entry plus a dialect parser, and nothing else.

## Reading the pages somewhere else, and only once

`--readings <file.jsonl>` banks every page's answer as it lands, fsynced, and a
re-run reads only what is missing. It is a cache of **answers**, not of books:
the pages are still rendered, parsed and assembled every time, so a change to
the parser or the assembler costs no GPU at all.

**A bank a finished run left behind is not a run to resume.** A run that writes
its EPUB drops `completed.json` beside its readings; the next run that finds
that marker rotates the bank into `archived-<timestamp>/` and **reads every page
again**, because ordering a conversion that already finished is ordering the
work rather than a replay of it. Without the marker the bank is an interrupted
run and is resumed exactly as before. Nothing is ever deleted — a page costs
GPU-minutes and a book costs hours.

Two flags override that, and they are opposites. `--reuse-readings` rebuilds the
book from the banked answers despite the marker: the deliberate free reconvert,
for iterating on the parser or the assembler over answers that are already known
good. `--fresh-readings` archives and re-reads whatever the marker says — the
explicit form, for a caller whose own records know the conversion finished, since
a bank written before markers existed carries none. Passing both, or either
without `--readings`, is refused rather than half-obeyed, and whichever of the
three happens the run states it in one sentence before it renders a page.

`--vlm-endpoint <url>` sends the pages to an OpenAI-compatible server (vLLM)
instead of loading MLX — same verbatim prompt, same 200 dpi render, temperature
0, twelve pages in flight by default. A chat endpoint is right *here* and
nowhere else (ARCHITECTURE §4): a document VLM's published interface *is* the
chat template, and the MLX path reaches the same one through
`apply_chat_template`.

The two paths differ in exactly one number, and it is the one that matters. A
Qwen-family processor resizes a page to a multiple of 28 inside a pixel budget,
and **a model that answers with boxes answers in that resized frame**. On MLX
the budget is pinned at 2,000,000 — measured: it halves the per-page cost with
no visible difference — and the same number scales the boxes back. A server was
started with its own processor config, so the model's own cap (11,289,600) is
assumed there. The run prints the frame it measured in, and refuses outright if
the boxes overflow it: a budget that is silently wrong crops every picture
wrong and flips every indent test, on a book that reads fine.

## Where the reading runs

- **Apple silicon** reads pages locally: MLX, in the Python subprocess.
- **Everywhere else** reads pages through `--vlm-endpoint`, an OpenAI-compatible
  server. In practice that is **vLLM** — on Windows it runs in WSL, because
  vLLM publishes no Windows wheels — and the speedup is not optional: roughly
  **3 s a page against vLLM versus 30 s** through slower backends.
- **Python is needed in every case**: even with `--vlm-endpoint`, the pages are
  rasterised (and Pictures cropped) by PyMuPDF. The interpreter is passed with
  `--python` or `FOUNDRY_VLM_PYTHON`, or a `vlmtest` conda environment is
  looked for.

## Measured

On a 17-page born-digital article (Kershaw, "Working Towards the Führer", 1993),
M1 Ultra: `dots-ocr` at 4-bit MLX reads it at **0.80% character error** against
the PDF's own text layer. `Nanonets-OCR2-3B` reads it slightly more accurately —
0.80% over the same pages, 0.56% over the sixteen pages of running prose — and
produces a **worse book**, because a third of what it returns as ordinary
paragraphs is furniture a reader would never want narrated, and nothing
downstream can tell which third.

Nothing degrades silently. A page that came back empty, a page that hit the
token cap while the model was still writing, and a page whose answer does not
parse are each named. For the markdown dialects that stops the run; for
dots.ocr — whose answer is per-page structured data and whose answers are
cached — the page is left out of the book and reported by number, in the log, in
`--chapters`, and again on the last line of the run.

## Relationship to BookForge

Foundry is extracted from [BookForgeApp](https://github.com/telltaleatheist/bookforge),
which builds audiobooks and needed clean text before it could narrate anything.

**This repository is the single implementation.** BookForge consumes foundry as
a **subprocess**, the same way it already drives ebook2audiobook:

```
BookForge ──spawn──> foundry vlm-convert --pdf in.pdf --out out.epub
```

Nothing in foundry knows what an audiobook is. Shipping a change to BookForge
is one command — `tools/deploy.sh`, no version to bump on the BookForge side —
see [`docs/DEPLOYING.md`](docs/DEPLOYING.md).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the decisions and why.

## Build

```bash
bun run typecheck
bun test
bun run build            # this machine
bun run build:all        # darwin arm64/x64, linux x64, windows x64
tools/release-package.sh # tarballs + checksums.txt into dist/release/
```

`tools/release-build.sh` bakes the git commit into the binary, so
`foundry --version` reports the version and commit, and a build from a dirty
tree says `+dirty` rather than claiming the commit it was nearly built from.

## Install

A release asset is one binary in a tarball. Beyond it, a run needs a Python
with **PyMuPDF** (and **mlx-vlm**, on Apple silicon reading locally), and — off
Apple silicon — a VLM server to point `--vlm-endpoint` at. Weights are pulled
by the runtime into the HuggingFace cache on first use; foundry hosts none.
