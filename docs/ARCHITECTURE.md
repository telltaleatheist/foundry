# Foundry — architecture

The decisions, and why. These are settled; this document exists so they are not
relitigated by whoever reads the code next, including a later version of the
person who made them.

Foundry used to carry two routes to a book: a Tesseract + stage-model pipeline
(scan → blocks → ocr → footnotes → export) and a document-VLM route
(`vlm-convert`). The VLM route won — one model that sees the whole page
answered better than three that each saw a piece — and the pipeline was
stripped. The complete pipeline, its models, its docs and its tests live at the
git tag **`pre-vlm-strip`**. Section numbers below are preserved from the
two-route era because the code cites them (§1, §4, §5, §8); sections that only
described the stripped pipeline are marked retired rather than renumbered.

---

## 1. Core language: TypeScript — and one Python seam

Foundry is TypeScript. **Since 2026-09-24 the engine is bundled into the app,
not compiled into an executable:** `tools/build-engine.mjs` (esbuild) writes
`src/` as one CommonJS file into `app/engine/`, committed and checked against
`src/` by the test suite, and the app runs it with its own Electron as Node.
Owen: *"i dont think it needs to be an exe anymore. it can be an engine but
maybe we should explode it out into normal code that moves along with the
app."* Every model had moved to a Crucible server by then; what was left was
file work and HTTP, and a 100 MB per-platform binary with its own release train
was a second copy of the app's version to keep in step. Bun remains the dev
runtime and the test runner. What follows is the original reasoning, kept
because it is still why this is TypeScript — read "one file" as "one bundle
inside the app" where it said "one binary".

*(Original:)* `bun build --compile` produced a self-contained per-platform
executable — the Bun runtime embedded in the binary, so the end user installed
nothing.

The obvious alternative was Python, because everything *around* this problem is
Python: the ML ecosystem, the VLM runtimes, the rasterisers. It was rejected
for the distribution: a Python program means shipping an interpreter and a
dependency tree, or asking a user who wants to read a book to manage a
virtualenv. `bun build --compile` is one file. BookForge — the main caller —
is also TypeScript, so the types describing a page and a category are shared
vocabulary.

**The one seam: `src/vlm/vlm_page.py`.** Running a vision model locally on
Apple silicon is MLX, which is Python, and rasterising a PDF page is PyMuPDF,
which is also Python — foundry's embedded pdf.js is text-only and its canvas
layer could not survive `bun build --compile` (nor a Node bundle). So `vlm-convert` shells out to ONE
interpreter subprocess per book: a JSON config in on stdin, one JSON object per
page out on stdout. The script's source is embedded in the bundle at build time
and materialised at run time, so the engine still travels as one file.
The seam is drawn to be as thin as a seam can be, and everything on the far
side of it is checked loudly (§8): a missing interpreter, a missing package and
a page that renders to nothing are each named, fatal errors.

With `--vlm-endpoint`, inference moves to any OpenAI-compatible server (vLLM in
practice — an order of magnitude faster than local MLX) and Python's remaining
job is rasterisation and cropping.

---

## 2. Single implementation — BookForge is a thin client

BookForge calls the `foundry` binary as a subprocess and reads what it writes.
There is exactly one implementation of the conversion, and it is here.

```
BookForge ──spawn──> foundry vlm-convert --pdf in.pdf --out out.epub
```

Two copies of anything load-bearing is the specific failure being designed out:
within a month one of them is stale, both "work", and the symptom is a quality
regression that reads as a model problem. BookForge already drives
ebook2audiobook as a subprocess; this is the same shape, and it means foundry
ships on its own schedule.

---

## 3. One model reads the page *(rewritten for the VLM route)*

The stage-model design this section used to describe is retired with the
pipeline. What replaced it:

One document VLM reads each page image whole and answers in its own dialect.
The registry (`src/vlm/models.ts`) declares each model foundry can drive — its
HuggingFace repo, its verbatim prompt, its answer dialect — and the parser for
each dialect lives in `src/vlm/dialect.ts`. Adding a model is one registry
entry plus one parser, and nothing else.

**dots-ocr is the default** because it is the only registered model that
answers with GEOMETRY: `{bbox, category, text}` per block, in reading order,
over eleven categories. Every structural feature of the output book — dropped
running headers, cropped Pictures with their Captions, footnotes collected at
chapter ends, epigraphs told from paragraphs by measuring against the body
column — follows from having boxes and categories rather than a stream of
markdown.

---

## 4. The prompt is the model's interface — verbatim, always

**This is the single most fragile invariant in the project.**

Every model in the registry is asked the exact prompt its own model card
documents, byte for byte, and none of them may be adjusted to a house style.
This was learned the expensive way, twice: asking Qwen2.5-VL for an ad-hoc JSON
layout produced FABRICATED bounding boxes and straightened quotes, while asking
it for `QwenVL HTML` — the format it was trained to emit — produced real
geometry and the book's own typography.

The failure mode is what makes this dangerous: a prompt that is nearly right
does not error. Answers just get worse, in a way that looks like a bad model
rather than a malformed request.

For a document VLM the published interface IS the chat template — the MLX path
reaches it through `apply_chat_template`, and `--vlm-endpoint` reaches the same
one through an OpenAI-compatible server. Temperature is 0 everywhere. The
serving layer knows nothing about pages or books; dialect parsing lives with
the registry entry that owns it.

---

## 5. Pinned resolution — 200 dpi is not a setting

Pages are rendered at **200 dpi**, everywhere, and the pixel budget handed to a
model's processor is the same number the answer's boxes are scaled with.

A model's input distribution moves with resolution, and the damage shows up as
a bad model rather than a bad render: nothing errors, boxes land slightly off,
categories get slightly worse, and every symptom points at the weights. 200 dpi
is the resolution the registered models were measured at, so it is pinned
rather than exposed as a knob. A processor that will not accept the pixel
budget is a failure, not a silent ignore.

**Pinned WHERE depends on who holds the weights**, and since 2026-09-18 that is
two answers rather than one. On the local MLX route this program loads the
model and runs its processor, so the numbers are its own and live in code
(`src/vlm/vlm_page.py`, `VLM_DPI` and `MLX_MAX_PIXELS` in `src/vlm/read.ts`).
Against `--vlm-endpoint` they are not: the server holds the weights, so it
publishes the dpi, the pixel budget, the prompt, the token ceiling and the
dialect on `GET /v1/info` (`pages_engine.request`), and `src/vlm/contract.ts`
reads them for every run. A copy here would be the same fact with two owners —
they would agree until the day they did not, and that day costs a book quietly.
A server that publishes no such contract is refused before the first page; it
is never answered out of a local default.

---

## 6. Weights are pulled, never committed

**Code** lives in git. **Weights** never do.

VLM weights are mlx-community / model-owner conversions pulled by the runtime
(mlx-vlm, or the server behind `--vlm-endpoint`) into the HuggingFace cache on
first use. Foundry does not host, mirror or checksum them — they are somebody
else's published models. Nothing multi-gigabyte belongs in a git history or
inside the engine bundle; a weight file appearing in `git status` means
something resolved to the wrong directory.

---

## 7. Retired — edit contracts

The edit-contract design (models emit edits, deterministic appliers apply
them) belonged to the stripped pipeline's ocr and footnotes stages. It lives at
`pre-vlm-strip`. The principle it encoded — a model is never trusted to rewrite
prose wholesale without a check — survives in the VLM route as parse-or-refuse:
an answer that does not parse in its declared dialect stops the run or excludes
the page BY NAME, and is never patched up into something plausible.

---

## 8. No fallbacks

A missing interpreter, a missing package, a page that came back empty, a page
that hit the token cap mid-sentence, an answer that does not parse: each is an
error that **names the missing thing** and exits nonzero.

No silent substitution. No "continue without the model". No writing an empty
output file and returning 0. No catching an error to keep the run moving.

The reason is the failure economics of this specific program. Its output is a
book, read once, possibly narrated to audio, by someone who will not be diffing
it against the scan. A quiet degradation is not caught downstream — it ships.
An error that stops the run costs minutes; a fallback that produces a slightly
wrong book costs the book.

---

## 9. Layout

```
src/
  cli.ts          entry, dispatch, top-level help
  args.ts         dependency-free argv parser
  commands.ts     the command surface (vlm-convert)
  version.ts      version + git commit, baked in at build

  vlm/            the conversion: registry, dialects, bridge, assembly
    models.ts       which VLMs foundry drives, each with its verbatim prompt
    dialect.ts      one parser per answer dialect
    dots.ts         dots-ocr's JSON dialect
    dots-book.ts    boxes+categories → book structure (chapters, notes, joins)
    bridge.ts       the subprocess seam: spawn, stream, refuse
    vlm_page.py     the Python half: rasterise, read (MLX), crop
    endpoint.ts     --vlm-endpoint: the OpenAI-compatible client
    readings.ts     the answer bank: resume, archive, reuse
    epub.ts         assembled book → EPUB3
    convert.ts      the run: orchestrates all of the above
    pages.ts        page-list parsing (--skip-pages)

  epub/xml.ts     small XML parser (dialects parse markup with it)
  epub/final.ts   the curated book becomes the edition: cuts applied, wreckage tidied
  epub/stamp.ts   a publisher's EPUB gains foundry's stamps, read from its own markup
  epub/meta.ts    the OPF's Dublin Core fields, spliced by source offset
  pdf/meta.ts     the PDF Info dictionary, through pdf-lib (rewrites the whole file)
  export/zip.ts   deterministic zip writer (EPUB is a zip)
  scan/pgm.ts     PGM raster reader (ink measurements on page renders)

docs/
  ARCHITECTURE.md this file
  DEPLOYING.md    how a release is built and shipped
```
