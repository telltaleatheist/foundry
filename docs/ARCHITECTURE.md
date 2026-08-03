# Foundry — architecture

The decisions, and why. These are settled; this document exists so they are not
relitigated by whoever reads the code next, including a later version of the
person who made them.

---

## 1. Core language: TypeScript, compiled with Bun

Foundry is TypeScript. `bun build --compile` produces a self-contained
per-platform executable — the Bun runtime is embedded in the binary, so the end
user installs nothing.

The obvious alternative was Python, because everything *around* this problem is
Python: the training rig, the corpus tooling, the band segmenter, the scoring
scripts. That was rejected, and the reason is worth being precise about, because
"the ML world is Python" is a strong pull.

**The code that must move is not the ML code. It is the prompt encoder and the
edit appliers — and those are already TypeScript, tested, and dangerous to
port.**

Sort the code by what a porting bug costs:

- **Dangerous to port — already TS.** The prompt encoder and the appliers. A
  prompt encoder is a bit-exact artifact: it must emit the same token sequence
  the model was trained on, down to the whitespace and the empty
  `<think>\n\n</think>` block (§4). A port that is 99% right produces a model
  that is *slightly worse in a way nobody can attribute*, and the natural
  conclusion is "the model needs more training data," which is expensive and
  wrong. Same for the appliers: the subsequence guard and the edit-match rule
  are the safety property of the whole system, and a subtly different guard
  fails open rather than loudly.
- **Safe to port — currently Python.** The Tesseract band-merger geometry
  (`bands.py`): projection profiles, deskew, box merging. Pure arithmetic over
  numbers, with pages as fixtures. A port is verified by running both
  implementations over the same renders and diffing the boxes. If they agree on
  every page of the fixture set, the port is done; if they disagree, the diff
  says exactly where.

So: port the code whose correctness is *checkable*, and do not touch the code
whose correctness is *invisible*. That is the whole argument.

Secondary, but real:

- **One binary, no runtime.** A Python distribution means shipping an
  interpreter and a dependency tree, or asking a user who wants to read a book
  to manage a virtualenv. `bun build --compile` is one file.
- **BookForge is TypeScript.** The types describing a block, a category, and an
  edit are shared vocabulary with the caller.
- **This process is I/O-bound**, not compute-bound. The work happens in
  llama-server and Tesseract, both subprocesses. Foundry orchestrates, encodes
  prompts, and applies edits. Nothing here needs NumPy.

The training rig stays Python and stays in BookForgeApp. Foundry is *inference
and packaging*, not training.

---

## 2. Single implementation — BookForge becomes a thin client

The prompt encoders and edit appliers move here **whole**. They are not copied,
forked, vendored, or re-exported. BookForge deletes its copies and calls the
`foundry` binary as a subprocess.

Two copies of a prompt format is the specific failure being designed out. Within
a month one of them has the v-next class list and the other does not, both
"work", and there is no obvious stale one — the symptom is a quality regression
in one application and not the other, which reads as a model problem.

BookForge already drives ebook2audiobook as a subprocess. This is the same
shape, and it means Foundry can ship on its own schedule.

Interface:

```
BookForge ──spawn──> foundry convert in.pdf -o out.epub [--llama-server <path>]
```

`--llama-server` exists because BookForge already bundles a llama.cpp binary for
local AI cleanup. There is no reason to ship a second one inside its app bundle.
The flag overrides *which binary is used*; it does not change how it is invoked
or relax any check.

---

## 3. Three stage models on one resident base model

One Qwen3-4B base (`foundry:4b`), and one model per stage.

| Stage | Id | Kind | Formerly | Unit of work |
|---|---|---|---|---|
| blocks | `foundry-blocks-v1-4b` | full (fused, 8 GB) | rubric | one page of blocks |
| ocr | `foundry-ocr-v1-4b` | adapter (126 MB) | galley / proof | one line |
| footnotes | `foundry-footnotes-v1-4b` | adapter (126 MB) | dagger | one text segment |

Two of the three are LoRA adapters hot-swapped per request via llama-server's
multi-LoRA support, and that is the design: three separate 4B models would mean
several gigabytes of unload/reload every time the pipeline moved from one stage
to the next, and `convert` moves between them constantly. Adapters are tens of
megabytes. One base loads, stays resident, and the adapter swaps.

**`blocks` is fused, and that is a fact about the checkpoint rather than a
choice.** The weights that scored were trained as a merged model, and shipping a
re-derived LoRA would be shipping a model nobody has measured. So its entry
declares `kind: 'full'`, it is served with `-m <its own file>` and no
`--lora-scaled`, and it does not need the base on disk at all. Each stage builds
its own server from its own plan, which is what lets the two shapes sit in one
chain — the fused stage loads and unloads around the base+adapter stages instead
of pretending to join them. When blocks is retrained as a LoRA against
`foundry:4b`, its entry lands as `kind: 'adapter'` with a higher rank and the
fused one stays.

The catalog therefore declares packaging per entry and never infers it from the
id: `foundry-blocks-v1-4b` names the stage, the release and the base size, and
none of that says whether the tune was merged.

**The id carries version and size, and the version is load-bearing.** An id
without a version parses as v1. Model ids are therefore validated, not trusted.

**But the release version is NOT the prompt version.** Foundry's stage lines
restart at v1 while the prompt formats carried on from BookForge, so
`foundry-blocks-v1-4b` is release v1 of a **v5 prompt**. The format the weights
were trained on is declared as `promptVersion` on the catalog entry and is
required on every `blocks` entry; reading it off the id would select the retired
sixteen-class taxonomy, which does not error and just quietly scores worse. The
filename rule (`blocksVersionFor`) remains the answer for `--base-model` /
`--adapter` overrides, where there is no entry to ask.

Old catalog entries are never deleted: someone is mid-book with the weights they
already have on disk. A `rank` field decides the default.

---

## 4. The prompt is sacred — verbatim, to `/completion`, never a chat endpoint

**This is the single most fragile invariant in the project.**

Training used Qwen3's chat template with thinking disabled. That template
inserts an empty `<think>\n\n</think>` block that stock chat templates omit. A
server that builds the prompt itself — any `/v1/chat/completions` endpoint,
Ollama's chat API, anything that takes `messages` — will construct a *different*
prompt from the same content, and hand the model a shape it never saw in
training.

The failure mode is what makes this dangerous: it does not error. Answers just
get worse, in a way that looks like an undertrained model rather than a
malformed request. The natural response is to train longer on more data, which
costs days and fixes nothing.

Therefore:

- The prompt is built **by our own encoder**, in this repo, one implementation.
- It is sent **verbatim** to llama-server's **`/completion`** endpoint, which
  takes `prompt` as a string and does not re-template it.
- **No chat endpoint. Ever.** Not for convenience, not for a quick test, not
  "just to check if the server is up".
- The server layer knows nothing about pages, blocks or footnotes. It takes a
  prompt string and returns a completion string. Prompt formats live with the
  stage that owns them; parsing answers happens there too.

The stop token is part of the format, not a tuning knob.

---

## 5. Pinned Tesseract, never PATH Tesseract

Foundry ships an **exact Tesseract version with exact tessdata**, both
sha-verified, and runs pages at **200 dpi**.

Tesseract is not a preprocessing detail here — it is the segmenter the models
were *trained against*. The blocks model learned to label the blocks that one
specific Tesseract produces; the ocr model learned to repair the specific errors
that build makes at that resolution. Layout analysis changes between Tesseract
versions, and paragraph grouping moves with resolution.

So picking up whatever `tesseract` is on `PATH` silently shifts the input
distribution. Nothing errors. Blocks come out slightly differently grouped,
labels get slightly worse, corrections misfire slightly more often — and every
symptom points at the models.

Rules:

- Resolution is **200 dpi**, everywhere, including any tool that generates
  training or fixture data. Not a setting.
- The bundled binary and tessdata are **verified by hash** before use. A hash
  mismatch is an error naming the file, not a warning.
- `--tesseract <path>` overrides *which binary is used* — for development, and
  for a packager who has a verified system copy. It **still runs the version
  check**. It is not an escape hatch from the pin.
- There is no "use system tesseract if the bundled one is missing" path. A
  missing bundled tesseract is an error that says so.

---

## 6. Weights on HuggingFace, code on GitHub

**Code** lives in git. **Weights** never do.

- Hosting: `huggingface.co/owenmorgan/<repo>`, direct resolve URLs.
- On disk: a platform data directory, not the repo, not the install location.
  `--models-dir <path>` overrides it.
- Every entry in the catalog carries `url`, `sha256`, `bytes`, `rank`.
- Downloads are verified on arrival. **A file whose hash does not match is
  deleted and named.** It is never used, and there is no "probably fine" path.
- `foundry models pull` fetches what is missing. `foundry models list` shows
  what is present and whether it verifies.

The base model is a few gigabytes; the adapters are small. Neither belongs in a
git history, and neither belongs inside the compiled binary — a 4 GB executable
is not a distribution strategy. A `.gguf` appearing in `git status` means
something resolved to the wrong directory.

**A catalog entry is not a published model.** The entry can be written and
committed while the weights do not yet exist at that URL, and the failure lands
on a user's first run. Publishing is part of shipping a model version, not a
follow-up.

---

## 7. Edit contracts — the models emit edits, not prose

Neither text model is allowed to hand back rewritten text. Both emit **edits**,
and a deterministic applier does the editing. This is what makes a 4B model safe
to point at someone's book.

**ocr** emits `before → after` pairs. The applier finds `before` verbatim in the
line; if it cannot, the edit is **rejected**. A hallucinated correction fails to
match and is dropped, rather than silently replacing a sentence the author
wrote.

Hyphenation across a line break is a **JOIN, never a completion**. The two
halves are rejoined as they appear. The model is never asked to guess the rest
of a word — that is generation, and generation is how a scan becomes fiction.

**footnotes** emits `<anchor+marker> → <anchor>` lines, or the single word
`none`. The applier enforces a **subsequence guard**: `after` must be reachable
from `before` by *deleting characters only*. A model that tries to reword, fix
punctuation, or resupply a letter on the way past is rejected by construction
rather than by review.

The evaluation follows from the contract:

- Judge by the edits, not by loss. Loss says nothing about whether an applier
  accepted the edit.
- The number that matters for **footnotes** is the **false-fire rate** on blocks
  with no markers at all — editing clean prose is the thing that damages a book.
  A model that never fires scores a perfect false-fire and is useless, so read
  it beside recall, never alone.
- Track **applier rejections** separately. They are harmless to the text — that
  is the point of the contract — but they are the model failing to copy, and
  they cost recall silently.

---

## 8. No fallbacks

A missing binary, a missing weight, a failed checksum, a missing input file, an
unparseable answer: each is an error that **names the missing thing** and exits
nonzero.

No silent substitution of a system binary. No "continue without the model". No
writing an empty output file and returning 0. No catching an error to keep the
pipeline moving.

The reason is the failure economics of this specific program. Its output is a
book, read once, possibly narrated to audio, by someone who will not be diffing
it against the scan. A quiet degradation is not caught downstream — it ships. An
error that stops the run costs minutes; a fallback that produces a slightly
wrong book costs the book.

This applies to the stubs, too: an unimplemented command exits **1**, and does
not produce a plausible-looking empty result.

---

## 9. Layout

```
src/
  cli.ts          entry, dispatch, top-level help
  args.ts         dependency-free argv parser
  commands.ts     command surface (currently: stubs)

  scan/           pinned tesseract, page render, band merge
  blocks/         block-category encoder + answer parser
  ocr/            edit derivation + applier
  footnotes/      deletion parser + subsequence-guarded applier
  export/         categories → XHTML → EPUB
  serve/          llama-server lifecycle, adapter swap, /completion client
  models/         catalog, download, sha256 verification

docs/
  ARCHITECTURE.md this file
  MIGRATION.md    what moves from BookForgeApp, and from where
```

`serve/` knows nothing about books. Each stage owns its own prompt format and
its own answer parsing — the server takes a string and returns a string.
