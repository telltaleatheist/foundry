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
 ┌──────────┐   adapter: foundry-blocks
 │  blocks  │   What IS this block? body · chapter opening · subheading ·
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
foundry blocks    --run <run>
foundry ocr       --run <run>
foundry footnotes --run <run>
foundry export    --run <run> -o book.epub [--exclude footnote]... [--exclude-ids ids.txt]
```

## Document mode — the PDF itself is the pipeline's state

The run directory is a good API and a bad hand-off. Every consumer has to be
told what the files mean, nothing in it can be opened by a person, and the state
of a half-finished book lives in five JSON files that have to stay in step with
each other and with a PDF nobody is holding.

So there is a second shape, and its rule is that **every stage is document-in →
document-out**. An untouched original is cast once into a WORKING PDF; every
stage after that writes into that file as a PDF incremental update — bytes
appended, nothing moved — so the file is a valid PDF at every stage boundary, a
boundary is a byte offset, and "reset to that stage" is a truncate.

```
# a scan: Tesseract finds the lines, then the words go back INTO the PDF
foundry scan      --pages <renders> --run <run>
foundry get-text  --pdf original.pdf --run <run> --out working.pdf

# a book that already carries text: no Tesseract anywhere near it
foundry scan      --pdf original.pdf --run <run> --out working.pdf

# then, whichever it was
foundry blocks    --run <run> --pdf working.pdf [--palette colours.json]
foundry footnotes --pdf working.pdf --report review.json [--dry-run]
foundry reflow    --pdf working.pdf --out book.epub [--exclude footnote]...
```

What that buys, concretely:

- **`get-text` makes a scan a document.** One invisible text run per recognized
  line, at that line's box — the OCRmyPDF technique. The pages are still the
  scan; the text is selectable, searchable and copyable in any reader.
- **`blocks --pdf` writes its answer as annotations.** One coloured square per
  block, named by id, carrying the block's text. Open the working PDF in
  anything that shows annotations and the categories are there. Move a box,
  retype a heading, delete one — you have edited the pipeline's state, and there
  is no side file to keep in step. `--palette` takes the caller's own colours.
- **`reflow` reads the document and nothing else.** No run directory, no
  exclusion list, no overrides file. It drops what the annotations say is
  deleted, repairs the OCR for a scanned document only and only over the lines
  that survived, reflows with the book's own calibration, and takes its chapters
  from the chapter annotations — whose text IS the title, so a heading retyped
  in a PDF reader is the chapter title.
- **Whether a book needs the OCR model is written IN the document.** `get-text`
  stamps `scanned`; `scan --pdf` stamps `text`. A publisher's words are never
  handed to a model trained to fix Tesseract's mistakes.

`foundry` never invents a filename: every input and output above is named on the
command line, and the original PDF is never written to.

See [`docs/DOCUMENT_MODES.md`](docs/DOCUMENT_MODES.md) for what the working
document carries, and [`docs/PDF_SPIKE.md`](docs/PDF_SPIKE.md) for the
measurements the incremental-update design rests on.

## The other route — a vision model reads the page

`vlm-convert` answers the same question by different means: instead of
segmenting a page and labelling its blocks, it hands the whole page picture to a
document VLM and takes back a description of the page.

> Shipping a change to BookForge is one command — `tools/deploy.sh`, and there
> is no version to bump on the BookForge side. See **docs/DEPLOYING.md**, which
> also covers what each platform needs for this mode (Windows and Linux read
> pages from a server; only Apple Silicon reads them locally).

```
foundry vlm-convert --pdf book.pdf --out book.epub \
    [--vlm-model <id>] [--python <path>] [--readings answers.jsonl] \
    [--skip-pages 3,17,19-24] \
    [--chapters chapters.json] [--vlm-endpoint http://host:8000/v1]
```

`--skip-pages` leaves pages out of the book — not rasterised, not read, not in
the EPUB. It is a **skip, not a subset**: the PDF is never rewritten, so its
sha256 (the identity `--readings` is keyed to) survives the curation, and every
page that stays keeps its true page number in `data-bf-page`. A paragraph is
never joined across the hole a skip leaves.

It shares **no stage, no artifact and no model** with the pipeline above, on
purpose: the two are meant to be comparable, which they stop being the moment
they share a step. What it needs that the rest of foundry does not is a Python
with PyMuPDF in it, and with MLX too unless the reading happens elsewhere —
`src/vlm/vlm_page.py` renders the pages at 200 dpi and, on the MLX path, reads
them in ONE subprocess for the whole book (one model load, not one per page),
streaming a JSON object per page back.

### dots.ocr, the default — the one that answers with geometry

`dots-ocr` (`mlx-community/dots.ocr-4bit`) does not answer with a stream of
text. It answers with a JSON array of `{bbox, category, text}` in reading order
over eleven categories, and **everything this mode can do that a markdown model
cannot follows from that**:

| what | how |
|---|---|
| page furniture goes | `Page-header` / `Page-footer` are dropped because the model says which blocks they are — no tag convention to rely on, no running head left in the prose |
| a picture is a picture | the `Picture` box is cropped out of the page at 200 dpi, embedded, and kept with its `Caption` |
| footnotes are endnotes | `Footnote` blocks collect at the end of their **chapter** — not per page — split into one paragraph per note at the superscript that opens it |
| a marker is markup | reference numbers arrive as dedicated superscript codepoints, so they become real `<sup>`, or come out entirely with `--strip-note-markers` for a narration build |
| centered means centered | alignment is judged against the **book's own body column** (the median edges of its full-width `Text` blocks), never the page — a justified column is itself centered on the paper, so a page-relative rule calls every paragraph in the book centered |
| a paragraph survives a page turn | the words decide when they can (no terminal punctuation, next block opens lowercase); when they cannot, the **ink** does — a continuing paragraph fills its last line to the right margin, and a genuinely new one starts with a first-line indent |
| a broken word is one word | the fuse-or-keep decision uses **the book as its own dictionary**: fuse if the fused form appears in it, keep the hyphen if the compound does, otherwise fuse iff the continuation is lowercase |
| markdown never reaches the reader | dots writes `# …` headings and `> ` quote runs *inside* a text field; they become real headings and blockquotes |
| a newline is a line ending | it reflows wrapped prose, so a break it kept is one the page had — a contents entry, a line of verse — and becomes `<br/>` |

Chapters are **proposed, not decided**: a `Title` or `Section-header`, first on
its page, in the top 45%, short, and either chapter-ish or centered.
`--chapters` writes the list out as data with the reason each one fired. It
over-includes — decorative half-titles land in it — and that is the design: an
extra costs a click, a missed chapter cannot be recovered.

Every element in the book carries **`data-bf-page`** (the PDF page it was read
from) and **`data-bf-cat`** (the model's own category, lower-cased:
`text`, `title`, `section-header`, `footnote`, `caption`, `table`, `picture`,
`quote`, `formula`, `list-item`). An EPUB has no page concept and no memory of a
layout model's opinion, and both are unrecoverable once the pages are joined —
these two attributes are what let a picker say "every footnote" or "everything
that was on page 3". Standard `epub:type="pagebreak"` markers are emitted at the
page boundaries as well, inside the paragraph when the turn happened mid-sentence.

The three markdown models stay in the registry. They are what dots is measured
against, and each is asked in the prompt its own model card documents,
VERBATIM. That prompt is load-bearing exactly the way the stage prompts are
(ARCHITECTURE §4): asking Qwen2.5-VL for an ad-hoc JSON layout produced
fabricated bounding boxes, while asking it for `QwenVL HTML` — its trained
format — produced real geometry. Adding a model is a registry entry plus a
dialect parser, and nothing else.

### Reading the pages somewhere else, and only once

`--readings <file.jsonl>` banks every page's answer as it lands, fsynced, and a
re-run reads only what is missing. It is a cache of **answers**, not of books:
the pages are still rendered, parsed and assembled every time, so a change to
the parser or the assembler costs no GPU at all.

`--vlm-endpoint <url>` sends the pages to an OpenAI-compatible server (vLLM)
instead of loading MLX — same verbatim prompt, same 200 dpi render, temperature
0, twelve pages in flight by default. A chat endpoint is right *here* and wrong
everywhere else in foundry: ARCHITECTURE §4 forbids one for the stage models
because their prompt is one this project builds byte for byte, while a document
VLM's published interface *is* the chat template, and the MLX path reaches the
same one through `apply_chat_template`.

The two paths differ in exactly one number, and it is the one that matters. A
Qwen-family processor resizes a page to a multiple of 28 inside a pixel budget,
and **a model that answers with boxes answers in that resized frame**. On MLX
the budget is pinned at 2,000,000 — measured: it halves the per-page cost with
no visible difference — and the same number scales the boxes back. A server was
started with its own processor config, so the model's own cap (11,289,600) is
assumed there. The run prints the frame it measured in, and refuses outright if
the boxes overflow it: a budget that is silently wrong crops every picture
wrong and flips every indent test, on a book that reads fine.

### Measured

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

## Stripping markers from a book that is already a book

`footnotes` has a second input. A publisher's EPUB carries its reference markers
as markup — `<sup><a href="#fn3">3</a></sup>` — rather than as the OCR debris the
run directory holds, and a narrator reads them out as numbers either way.

```
foundry footnotes --epub in.epub --report review.json --dry-run
foundry footnotes --epub in.epub --report review.json -o out.epub
```

`--epub` and `--run` are alternatives; naming both, or neither, is refused by
name. The model path is identical in the two modes — same prompt, same stop
token, same subsequence-guarded applier. What differs is the walk and the
**projection**: the text of every `<p>` and `<blockquote>` in spine order goes to
the model, and the deletions it returns are mapped back onto the DOM text nodes
they came from, whether the marker sits inside one text node, spans a boundary,
or is the entire content of a `<sup>` or an `<a>` — an inline element a deletion
empties is removed with it.

Two promises about bytes. **The input is never written to.** And a document
nobody edited is copied through with the exact bytes, method and CRC it arrived
with — nothing is re-serialized — so a diff between the book that went in and
the book that came out is exactly the paragraphs that changed.

`--report` is required, and a dry run is what it is for: per-document counts,
every applied deletion with ~80 characters of context either side, and every
refused line verbatim with its reason. The number that decides whether this may
be pointed at a library is the false-fire rate on clean prose, and that is
something a human judges by reading.

Not asked about, deliberately: headings (an EPUB heading welds the chapter
number to the title, and a digit welded to a phrase is what this model deletes),
and list items and table cells (matching run mode's prose-only rule).

Three more populations are skipped for the same reason — each has the shape this
model is trained to delete, digits welded onto prose, without carrying a marker.
None is recognised by filename or by class attribute:

| skipped | test | why |
|---|---|---|
| navigation | the unit's whole text sits inside one hyperlink | `3The Façade` is a table-of-contents line |
| note body | the unit OPENS with an intra-book back-link whose anchor text is a number | `1. Himmler and his companions were…` — the leading number is the note's own label, and deleting it destroys the numbering of the notes section |
| index entry | a short phrase ending in page numbers, **in a document that is mostly such units** | `Ahnenerbe (Ancestral Heritage) 260, 266, 271, 275–9` |

The index shape alone never skips anything: a dateline (`July 2008`), a
copyright line and a bibliography shelfmark (`Fonds 504`) all have it, and all
three occur in the front matter of the books this was measured on. The document
has to be an index too — ≥20 index-shaped units and ≥50% of what it would be
asked about. Measured, the two real index documents score 92% and the highest-
scoring document that is *not* an index scores 16% on 3 units.

Measured on two real books: **Heinrich Himmler** 10,030 units asked → 3,690
(3,526 note bodies, 2,814 index entries), with **zero** units skipped in any
chapter document. **Killing America** 1,323 → 1,003 (320 in-chapter
`<p class="fn">` note bodies); of the 313 deletions a real model run applied to
that book, exactly one was inside a note body — and it was the known false fire,
`2018.Ibid.` → `2018.`

Every skip is counted by reason, per document, in the report, along with the
index-shaped count for documents the density gate declined. **`--ask-everything`**
turns the note-body and index skips off; the navigation skip is structural and
stays.

## Correcting a book that is already a book

`ocr-correct --epub` is the **only** correction the pipeline offers a user.

```
foundry ocr-correct --epub in.epub --report review.json --dry-run
foundry ocr-correct --epub in.epub --report review.json -o out.epub
```

Correction lives on the EPUB because that is where every text transformation
lives, and because correction buried inside `reflow` is invisible,
un-re-runnable and un-reviewable — it happens once, on the way past, and nothing
comes out of it a person can read. There is no `--pdf` mode: a working
document's text layer is never edited. The scan path keeps its per-line
correction inside `reflow` as an implementation detail of building the book.

**Run it first among the EPUB passes.** Footnote removal measures 97.0/0.5 on
corrected text against 90.5/2.1 on raw, so correcting afterwards takes the worse
number for nothing; and simplify and translate rewrite the prose, so correcting
after them edits the model's output rather than the book.

**The unit is a sentence**, packed to about 400 characters. More context
disambiguates more errors — `tbe` is unarguable in a clause and a coin flip on
its own — and the generation budget is already derived from the input length, so
a longer unit costs proportionally and nothing has to be re-tuned. Three rules,
in the order they beat each other: a `<br/>` always ends a unit (the model
answers with one line, so a prompt containing a line break could not
round-trip); units are packed only up to a sentence boundary; and a sentence
longer than the cap is cut at a word boundary and **never** mid-word — where a
single word is longer than the cap, that word is its own unit and the unit
exceeds it.

**The boundary guesses against cutting.** The unit is arbitrary — it could be
the paragraph — so a missed boundary is a longer unit and costs nothing, while a
wrong one manufactures the fragment the sentence unit exists to escape. So an
abbreviation is not a sentence end (a closed English and German list, plus a
lone letter in either case: `J. R. R.`, `z. B.`), a footnote reference rides on
the sentence it marks (`…lost the war.12 The next morning` cuts after the `12`,
which is otherwise no boundary at all), and a stop behind a digit is a decimal
rather than either.

**The prompt is not reworded for any of this.** It opens "a single line of
text", and a sentence is a line of text; rewording it would move the trained
distribution in the one dimension this repo guards hardest.

**One illegal run costs one clause, not the sentence.** The per-word guard's
rule is the line stage's rule exactly — a changed run is legal only if it swaps
N words for N words, each pair within Levenshtein 2 — but what one violation
costs is chosen per unit. Measured 2026-08-05 on 400-character units at 7% CER:
discarding the whole unit kept 6 corrections across 102 units where reverting
run by run kept 96, and net CER favours per-run in 5 of 6 measured cells. At
sentence length a whole-unit guard is not a guard, it is an off switch. So this
stage reverts the illegal runs and ships the legal ones, the `ocr` line stage
keeps whole-unit (where the two are indistinguishable), and the report records
which it ran under along with `sentencesRefused` — answers discarded entire —
kept apart from `sentencesPartlyReverted`.

The model path is otherwise the `ocr` stage's, unchanged: the same prompt, the
same edit contract and applier round-trip. What is new is
the **projection** — the accepted edit's text offsets mapped back onto the bytes
they came from — and its three refusals, each reported by name:

| refused | why |
|---|---|
| markup boundary | the anchor straddles a tag. `the r<em>n</em>ain point` cannot be repaired without deciding what happens to the emphasis, so it is not |
| entity | the anchor begins or ends inside `&amp;`, which stands for one character in five bytes |
| CDATA | escaping is inverted inside one, and this stage does not write into them |

A correction wholly inside an inline element is written into that element's text
node and the element survives — only the bytes of the words change.

Asked about: paragraphs, block quotes, headings, list items, definition lists,
table cells, captions and bare divs. Wider than the footnotes stage on purpose —
repairing a misread word cannot restructure a book the way deleting a digit can,
and a misread chapter title is the one line a reader sees before deciding to
read at all. A unit whose whole text sits inside one hyperlink is navigation and
is skipped.

**Offered on every book, never refused.** A book whose text is the publisher's
own has no OCR errors, and every change would be the model editing an author —
but provenance is not knowable from the file (a book converted from a PDF before
import looks identical), so the caveat is stated in the log and carried in the
report rather than used to lock the door.

Same two promises about bytes as `footnotes --epub`: the input is never written
to, and a document nobody corrected is copied through with the exact bytes,
method and CRC it arrived with. Where foundry built the book, the report also
names the block each correction landed in, read out of the `data-bf-blocks` and
`data-bf-category` stamps the exporter wrote; a publisher's EPUB carries none,
and the report says so rather than inventing one.

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
| blocks | `foundry-blocks-v1-4b` | rubric | Labels every text block on a page with what it is |
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
          ──spawn──> foundry blocks --run <run> --llama-server <its own>
          ──reads───> <run>/blocks/blocks.json   (paints pdf-picker's category layer)
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
| `blocks` | wired end to end — block formation, prompt encoding, llama-server lifecycle, answer parsing, `blocks/blocks.json`. Verified against a real trained checkpoint via `--base-model` + `--llama-server`. Stops at the catalog otherwise. |
| `ocr` | **blocked on a migration.** The edit contract and applier are here; the trained-against system prompt is still only in BookForgeApp and will not be re-typed (docs/MIGRATION.md §2). The command says so and exits 1. |
| `footnotes` | wired end to end — prose-block selection, prompt, subsequence-guarded applier, `footnotes/deletions.json`. Verified against a real trained checkpoint. **`--epub` also works**: an existing book in, the same model path, an edited book and a review report out, measured on two real books. |
| `export` | **works.** Categories drive the XHTML, the §9d rules assemble the paragraphs, wrap hyphens are healed only on the book's own evidence, and exclusion composes at both granularities. Writes `export/book.epub` + `export/exclusions.json`; `-o` additionally copies. Verified: a real EPUB out of real scanned pages. |
| `convert` | chains all five. It stops at the first stage that cannot run — today that is `ocr` — and every artifact written before that point stays on disk, with the failure recorded in `run.json`. |

Local weights can be pointed at directly, which is how the wired stages are
verified before anything is published:

```bash
foundry blocks --run <run> \
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
