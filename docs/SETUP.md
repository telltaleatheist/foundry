# First-run setup — the screen, and the environment it installs

Opened 2026-08-26. This is the design for the wizard a person meets the first
time foundry is opened on their own computer, and for the analysis-worker
environment it can now install.

The occasion, in Owen's words: a lawyer with a Windows machine and an RTX 2070.
Eight gigabytes of video memory, no interest whatsoever in Python, and no way
of knowing that the model name sitting in the Translate dialog is seventeen
gigabytes of weights her card cannot hold.

---

## 1. What was actually wrong

A fresh install of foundry needed four things that do not arrive with the
application, and discovered each of them **by failing at it**:

| Thing | How a new installation found out |
| --- | --- |
| A library folder | It did not. `~/Documents/Foundry` appeared silently. |
| Ollama | The first translation failed with a connection error. |
| A model that fits | It did not. `qwen3.8:27b` was hardcoded in three dialogs. |
| A rasteriser Python | The startup provisioner queued it, unexplained. |
| An analysis worker Python | The first analysis refused, naming five paths. |

Only the fourth of those had any machinery behind it, and it ran without asking.
Everything else was a failure message standing in for a question nobody had been
asked.

## 2. The shape

`app/src/app/components/setup-wizard/setup-wizard.component.ts` — six steps,
mounted by the shell, drawn over everything at z-index 1250.

```
Welcome  →  Library  →  Ollama and a model  →  Python environments
                                                     →  The page reader  →  Ready
```

**It is a FLOW, not a question**, and three decisions follow from that:

* It is **not** in `UiService.dialogs`. That list is the one-modal rule, and
  `only()` clearing this boolean would take a half-finished setup off the screen
  the moment any dialog opened over it.
* It is **mounted unconditionally** by `App` and holds its own `@if`. An `@if`
  around the component is a destroy, and this component holds the subscriptions
  that draw an environment download and an ollama pull — both of which run for
  many minutes in other processes. A wrapper flag that flickered would take the
  only visible progress off the screen while the work carried on.
* **Closing it is never a failure.** `setup:finish` is called however it is left,
  and what was skipped is written down.

### Nothing downloads because you arrived somewhere

Every step that costs bytes has a button, and the button is the permission. The
size is always beside it. Arriving at a step reads what is free to read — a
request to localhost, a directory check — and spends nothing.

### Every step is skippable, and every skip is recoverable

Skips are recorded in `AppSettings.setupSkipped` so the settings screen can name
them, and **Settings → Language model → "Run first-run setup again"** opens the
whole wizard. A step that could be declined but not revisited would be a
decision somebody is stuck with.

### Never when hosted

Inside BookForge the library is the host's, the environments are the host's
component manager's, and `library:set` refuses outright. A first-run wizard there
would be five steps of asking for things somebody else already decided.

## 3. Measuring the machine

`app/electron/system-probe.ts`. Cached for the life of the process (you do not
gain VRAM at lunchtime); `probeSystem(true)` re-reads for the one real case,
somebody who installed a GPU driver while the app was open.

| Field | How |
| --- | --- |
| `cuda` | `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. First line only. |
| `ramMB` | `os.totalmem()`. |
| `freeDiskMB` | `fs.promises.statfs` on `userData`, then on home. |
| `modelMemoryMB` | VRAM on a discrete GPU · 75% of RAM on Apple silicon · RAM otherwise. |

**Null is an answer and it is not zero.** "No nvidia-smi" (no NVIDIA driver) and
"a card whose VRAM could not be parsed" are different states and must not
collapse into one; every field that can be unknown is `T | null` and `detail`
carries the sentence. An unmeasurable disk **skips** the space warning rather
than raising it.

Every probe is a spawn with a deadline. `execSync` here would freeze the renderer
on a machine with a wedged driver — which is the machine most in need of a setup
screen.

## 4. Ollama

`app/electron/ollama.ts`. **Foundry does not manage ollama and this does not
change that** — nothing here starts it, stops it, or configures it. What is new
is first-run help.

**Detection is two questions.** `GET /api/version` says whether a server is
answering; a filesystem check of the platform's known install paths, then
`ollama --version`, says whether the binary is here at all. A machine that has
ollama installed and not running is common, and offering that person a second
install would be the app failing to look. The known paths are tried before the
PATH probe because a Windows `PATH` is not refreshed inside a process that was
launched before the installer ran — which is exactly the process asking.

**The installer is fetched and handed over, never run.**

```
win32   https://ollama.com/download/OllamaSetup.exe
darwin  https://ollama.com/download/Ollama.dmg
```

One const, `OLLAMA_INSTALLER`. Those are the hrefs behind the buttons on
ollama.com — stable aliases that redirect to the current release, verified
2026-08-26, which is why they are not version-pinned. The file is downloaded to
a temp directory and handed to `shell.openPath`, so the user lands in ollama's
own install screen with its own licence and its own elevation prompt.

**Which means there is no "done" to report.** The install finishes outside this
process, in a window this app does not own. Nothing claims success; the wizard
re-probes when the user comes back, and the probe is the only thing that ever
says ollama is present. The temp file is deliberately **not** cleaned up — the
installer is still running when the call returns.

**The pull** is `POST /api/pull` streamed. The percentage is one LAYER's, and the
bar says so: ollama reports `completed`/`total` per layer, the totals arrive as
each layer starts, and summing them gives a denominator that keeps growing and a
bar that goes backwards. The deadline is on **silence** (five minutes), not on
the pull — eighty-one gigabytes on a domestic line is most of a day and is not a
failure.

Neither of these goes through the job queue, unlike an env install. The queue
exists to stop two expensive GPU runs overlapping and to give a run a cancellable
row; an ollama pull is neither, it happens in ollama's process, and it finishes
whether or not this app is looking.

## 5. The model lineup

**THE TABLE IS A VENDORED FILE SINCE WAVE 61 PACKAGE D**, not a const:
`app/shared/model-lineup.json`, read by `app/electron/llm-catalog.ts`. Crucible's
manifests are the catalog of record (docs/SLOTS.md §4); each carries a `[local]`
block naming the model's local form — an Ollama tag, or a GGUF plus its mmproj —
with a memory figure and its BASIS, and a generator
(`crucible/scripts/gen-foundry-lineup.py`) will emit `foundry-lineup.json` for
Foundry to vendor. Until that generator exists the file's `generatedBy` says
`"hand — pending …"` in as many words, and the rows are the ones this const used
to hold. Sizes are ollama's own published figures for `qwen3.5` (read
2026-08-26). The shipping line, plus the four `clean` rows the narration cleanup
picks from and the `pages` row the page reader serves.

One row is NEW, and it is the app's own default: `qwen3.8:27b`
(`DEFAULT_TRANSLATE_MODEL`) was never in `QWEN_LINEUP`, so the wizard could
describe and pull every model except the one every dialog opens with. It is there
now, after `qwen3.5:27b`, carrying the Crucible id BookForge already uses
(`qwen3.8-27b-4bit`) — which makes it the recommendation on a card that holds
exactly one 27B.

```
needsGB = downloadGB + OVERHEAD_GB      OVERHEAD_GB = 1.5
```

That arithmetic is what the hand-written file was BUILT WITH; the file's own
numbers are what the code now reads, each carrying `basis: "declared"`. The day
Crucible measures a model's real resident footprint, that row's basis becomes
`"measured"` and no code changes.

The overhead is the KV cache, the runner's buffers, and whatever the desktop has
already taken off the card. **It errs small on purpose**: being wrong this way
costs somebody a smaller model than they could have had, which they change in one
field; being wrong the other way costs an hour of a translation running at a word
a second, or an out-of-memory failure after a seventeen-gigabyte download.

| tag | download | needs | 8 GB card |
| --- | --- | --- | --- |
| `qwen3.5:0.8b` | 1.0 GB | 2.5 GB | fits |
| `qwen3.5:2b` | 2.7 GB | 4.2 GB | fits |
| `qwen3.5:4b` | 3.4 GB | 4.9 GB | **fits — recommended** |
| `qwen3.5:9b` | 6.6 GB | 8.1 GB | does not fit |
| `qwen3.5:27b` | 17 GB | 18.5 GB | does not fit |
| `qwen3.8:27b` | 17 GB | 18.5 GB | does not fit |
| `qwen3.5:35b-a3b` | 24 GB | 25.5 GB | does not fit |
| `qwen3.5:122b-a10b` | 81 GB | 82.5 GB | does not fit |

**An RTX 2070 is offered `qwen3.5:4b`, not `9b`**, and that is not a bug: 6.6 +
1.5 is 8.1, and 8.1 does not fit in 8.0. The 9b row is still listed, still
selectable, and still says why it is marked as not fitting.

**One place the rule inverts.** "Largest that fits" is right only while memory is
what binds. On a machine with no GPU it is not: sixteen gigabytes of RAM will
hold `qwen3.5:9b` and then generate at a word or two a second, which for a
three-hundred-page book is not slow, it is not going to finish. A
processor-only machine is therefore recommended the **smallest**, with every row
still showing its real fits/doesn't-fit and the line above saying there is no GPU.

Every row is selectable whether or not it fits. Nothing is disabled for being
large; the sentence beside it is the whole intervention.

**THE TILES ARE A DIFFERENT MATTER, and they DO refuse** (Wave 61 package D,
docs/SLOTS.md §1). This screen's job is to describe the machine, so it lists
everything; the dock's job is to not start an eight-day job, so Translate and
Simplify light only where a model at or above the `minimum_for` floor — the 9B —
both fits and is installed, and not at all on a machine with no GPU a model can
use. Analysis takes the same CPU rule with no floor. The gate is
`app/electron/act-gates.ts`, answered over `acts:gates`, and every refusal names
the model that would light it.

## 6. The default model setting

`AppSettings.defaultLlmModel` and `AppSettings.ollamaUrl`
(`app/electron/app-settings.ts`), reached over `llm:defaults` / `llm:set-model`.

`qwen3.8:27b` — Owen's 2026-08-22 ruling that 27b is the standard for every task
— **remains the fallback when the setting is unset**, so nothing about an
existing machine changes. What the setting buys is the machine that cannot run
it.

**It is a seed, not a lock.** Translate, Simplify and Analyse each still show an
editable model field and still send whatever is in it; this decides what is in it
when the dialog opens (`app/src/app/core/llm-defaults.ts`, one helper so three
copies cannot drift). A different model typed for one book stays a choice about
that book.

`clampModelTag` does not validate against the lineup. The lineup is what setup
*offers*, not what ollama can run, and somebody who pulled their own model and
typed its name has said something true that a hardcoded table cannot know.

## 7. Where the weights come from — all three of them, plainly

This is the question the wizard's model step exists to answer honestly, because
the three answers are genuinely different.

### The language model (translate / simplify / analyse)

Pulled by **ollama**, on request, during setup. Progress on screen. Ollama's
store, ollama's business.

### The analysis model (`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`)

**Inside the environment tarball.** See §8. First analysis is offline because
there is nothing left to fetch.

### The reading model (`dots.ocr`) — REWRITTEN 2026-09-13

**This step was a disclosure and is now a download**, and the change is the whole
of Wave 61 package B (docs/SLOTS.md §6).

What it used to say was true of what used to be there: the weights arrived inside
vLLM's or mlx-vlm's own Hugging Face cache on the first read, nothing set
`HF_HOME`, nothing reported where the ~6 GB landed, and this app had no door to
them except a button that started a server. The only pre-pull it could honestly
offer was on Windows, and only if the user had already built a vLLM inside WSL.

**The local page reader replaced all of it** (`app/electron/page-reader.ts`).
Reading a page is the one act with no Ollama path — Ollama does not serve
dots.ocr, only an open request to — so this is the one piece of weights foundry
fetches itself:

* **llama.cpp**, from `ggml-org/llama.cpp`'s releases. The newest `b<number>`
  build with an asset for this machine: the CUDA 12.4 Windows build plus the
  separate CUDA runtime zip when `nvidia-smi` answers, the CPU build otherwise,
  and the macOS build (Metal is compiled in) on a Mac. Verified against the
  release's own published sha256. CUDA 12.4 rather than 13.x because 13 needs a
  580-series driver and 12.4 runs on 550 and anything above it.
* **Two GGUF files** from `ggml-org/dots.ocr-GGUF` — `dots.ocr-Q8_0.gguf`
  (1.89 GB) and `mmproj-dots.ocr-Q8_0.gguf` (1.34 GB). BOTH, because llama.cpp
  serves a vision model as a text tower plus a separate projector: a server
  started without the second loads, answers `/v1/models`, and then refuses every
  request that carries an image. Verified against the LFS sha256 the Hugging Face
  model index publishes.

The download is **resumable and skips what is already there**, which is the point
of a 3.2 GB fetch on somebody's home line: a cancel keeps the part file, and the
next attempt sends a `Range` header. The step prints the size before asking, and
prints only what is actually missing.

It is served as `llama-server -m <gguf> --mmproj <mmproj> --alias dots.ocr --host
127.0.0.1 --port 8000 --ctx-size 16384`, plus `-ngl 99` where there is a GPU. The
port is still 8000 — llama-server's own default is 8080 and is deliberately
ignored — because that is where every existing `backend.endpointUrl` already
points and where a hand-started vLLM lives. **A server already answering on that
port is ADOPTED, never owned**: used as it is, never stopped by this app.

### TWO THINGS ABOUT THIS ARE UNMEASURED, AND NOBODY SHOULD PRETEND OTHERWISE

Written down because the path was built without a GPU in the room:

1. **Whether the Q8_0 GGUF answers in the layout dialect the parser expects.**
   `src/vlm/dots.ts` (`parseDotsPage`) reads one JSON array of
   `{bbox, category, text}` per page, over eleven categories, and the whole book
   — dropped furniture, cropped pictures, centred epigraphs, joined paragraphs —
   is built out of it. Quantised weights under llama.cpp's own vision stack are
   not bf16 weights under vLLM, and a model that answers in prose, or with a
   truncated array, or with boxes in a different frame, produces a BOOK rather
   than an error. **Read one page and look at the JSON before reading three
   hundred.**
2. **Seconds per page, on CPU and on a small card.** The MLX 4-bit path is ~27 s
   a page on an M1 Ultra (`src/vlm/models.ts`) and vLLM on a 3090 Ti is far
   faster. Where a Q8 GGUF lands between them, and whether the CPU build is
   usable at all or merely possible, are numbers this work could not produce.

If (1) fails, the F16 pair in the same repo (3.56 GB + 2.53 GB) is the next thing
to try, and the two file names are two constants at the top of
`app/electron/page-reader.ts`.

## 8. The analysis-worker environment

Two new catalog entries, `nli-windows-x64` and `nli-mac-arm64`, alongside the
three reading environments. Same release (`env-v1`), same layout, same
sha256-or-refusal rule.

```
python/
  foundry-env.json          the manifest AND the marker
  python.exe                (windows) or bin/python3 (mac)
  Lib/site-packages/
    sitecustomize.py        points HF_HOME at the cache below
    torch/ transformers/ …
  hf-cache/                 the DeBERTa weights, ~380 MB
```

**Why the weights are baked in.** `src/analyze/nli_worker.py` runs with
`HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, deliberately, so a missing model
fails in a second instead of an hour into an analysis. An environment that
shipped only torch and transformers would install perfectly and then refuse the
first book with a sentence about a cache the user has never heard of.

**How the worker finds the cache.** `sitecustomize.py` in site-packages, imported
by `site` at interpreter startup — the only moment early enough, because
huggingface_hub reads `HF_HOME` once at import and freezes the paths it derives.
It computes the cache from `sys.prefix`, so the path is correct wherever the
archive was unpacked, and it uses `setdefault` — somebody who exports `HF_HOME`
because they keep one shared cache for every tool on the machine has said
something, and an environment overriding it would download a second copy of every
model they own.

**No symlinks survive in the archive.** huggingface_hub keeps one copy under
`blobs/` and links `snapshots/` at it; the app unpacks with the system tar, and
on Windows a symlink in the stream is a privilege error that fails the install
for everyone. So the build flattens the cache — every snapshot entry becomes a
real file, `blobs/`, `.locks/` and `.no_exist/` are deleted — and then **re-loads
the model offline from the flattened cache before it will tar anything.** If that
ever stops being true the build fails there, which is the only place that failure
is cheap.

**Torch is the CPU build on Windows.** The card on a machine running foundry is
holding the reading model or the LLM; a 2.5 GB CUDA torch would double the
archive to contend for a card that is already busy. Scoring on the processor is
roughly an order of magnitude slower and the worker says `"device": "cpu"` on its
ready line, so a slow pass has a one-word explanation. On Apple silicon there is
no such split — PyPI's macOS wheel is the Metal-capable one — so the mac target
takes it as published and the worker picks `mps`.

**Nothing is written into settings.json for these.** `EnvSpec.role` is `'nli'`,
and the installer's configure step skips the write. `backend.python` is the
*rasteriser*: pointing it at an interpreter with torch and no PyMuPDF would break
every conversion on the machine, silently, at the next job, as the reward for
installing the analysis worker. The engine finds this one **by name** instead —
the default destination is the first entry in `defaultNliPythonCandidates()`
(`src/analyze/nli-bridge.ts`), so an install that lands where the catalog says is
already configured. That path is a contract between the two files and is
commented as one on both sides.

### Published state

| target | asset | bytes | sha256 |
| --- | --- | --- | --- |
| `nli-windows-x64` | `foundry-env-nli-windows-x64-v1.tar.gz` | 528,417,092 | `3a4f32f3…f8b00d2` |
| `nli-mac-arm64` | — | — | **null — not built** |

The mac entry's null is the honest state, not an oversight:
`tools/env/build-env.sh nli-mac-arm64` downloads a darwin-aarch64 interpreter and
then **executes** it to install wheels and bake the weights, which no cross-build
can do. It has to run on an Apple-silicon Mac. Until it does, `requirePublished`
throws on that entry, the card greys it out, and nobody downloads an archive
nobody can name the hash of.

## 9. Building and publishing an environment

See `docs/DEPLOYING.md` § "The Python environments" for the runbook.

## 10. Deliberately not built

* **The mac analysis environment.** Needs an Apple-silicon Mac to build; the
  script is written and the catalog entry is `null`. (§8.)
* **~~A pre-pull for `dots.ocr` on macOS.~~ DONE 2026-09-13.** The local page
  reader downloads the GGUF on every platform, macOS included, with a real
  progress bar over `page-reader:progress`. A Mac with mlx-vlm installed does not
  need it and is offered it anyway, because a Mac WITHOUT that environment has no
  other way to read a page. (§7.)
* **~~A progress bar for the `dots.ocr` first-serve download.~~ DONE 2026-09-13,
  by removing the thing it was a bar for.** There is no first-serve download any
  more: the files are fetched by name, by byte count, against a published sha256,
  before any server starts. (§7.)
* **A measurement of the page reader.** Both numbers in §7's box. The path is one
  click; nobody has clicked it with a stopwatch.
* **Any change to how a job composes `--model`.** `job-queue.ts` still passes
  through whatever the dialog sent. The setting seeds the dialog, which is where
  a person can still see and change it. (§6.)
* **A linux analysis environment.** There is no linux entry in the reading
  catalog either, and naming a path the app never installs to would put a line in
  the worker's refusal message that can never become true.
