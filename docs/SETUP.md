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

`app/src/app/components/setup-wizard/setup-wizard.component.ts` — seven steps,
mounted by the shell, drawn over everything at z-index 1250.

```
Welcome  →  Library  →  Ollama and a model  →  Crucible (optional)
              →  Python environments  →  The page reader  →  Ready
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

> **SUPERSEDED 2026-09-15 — FOUNDRY KEEPS NO MODEL.** Owen: *"we dont have any
> local models. crucible handles all model orchestration. if theres no connected
> crucible server then tiles should be disabled. crucible is a service that
> foundry installs locally and connects to."*
>
> **This whole section is history.** The wizard step, the installer handoff and
> the model pull are deleted, with the doors behind them (`ollama:install`,
> `ollama:install-cancel`, `ollama:pull`, `ollama:pull-cancel`, `ollama:facts`,
> `ollama:choices` and the `ollama:progress` push). `probeOllama` survives with
> ONE caller — the "Models on this machine" disk inventory (§5b), which counts
> weights already on this disk and says nothing about where work runs.

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

> **SUPERSEDED 2026-09-15 — FOUNDRY KEEPS NO MODEL.** Owen: *"we dont have any
> local models. crucible handles all model orchestration. if theres no connected
> crucible server then tiles should be disabled. crucible is a service that
> foundry installs locally and connects to."*
>
> **Half of this section is history.** `app/shared/model-lineup-local.json` is
> DELETED: it existed to give the wizard smaller Ollama tags to offer, and there
> is no wizard step to offer them to. `app/shared/model-lineup.json` — Crucible's
> own vendored file — STAYS, with two readers: `pagesForm()` (the page reader's
> GGUF pair, the one weights Foundry still fetches itself) and
> `LINEUP_PROVENANCE` (the "Catalog:" line on the Models card). The `vendoredWith`
> block that lived in the deleted file is now the `VENDORED_WITH` const in
> `app/electron/llm-catalog.ts`, and is still updated by hand at each re-vendor.
> `eligibleFor`, `fitsOn`, `heldBy`, `heldSet`, `lineupFor`, `suggestedTag`,
> `openingModelFor`, `OVERHEAD_GB` and `LineupRow.crucible` are all deleted with
> their readers.

**THE TABLE IS TWO VENDORED FILES SINCE WAVE 61 PACKAGE E**, and neither is a
const. `app/electron/llm-catalog.ts` reads both and merges them.

`app/shared/model-lineup.json` is **Crucible's own `foundry-lineup.json`**,
vendored byte for byte from `telltaleatheist/crucible` @ `7e63905`
(`feat/phase6-remote-render`), itself generated from manifest commit
`4e178423…`. Crucible's manifests are the catalog of record (docs/SLOTS.md §4);
each carries a `[local]` block naming the model's local form — an Ollama tag, or
a GGUF plus its mmproj — with a memory figure and its BASIS, and
`crucible/scripts/gen-foundry-lineup.py` emits the file. **Nothing in Foundry
edits it**, which is what lets a keeper compare it against a fresh emission by
content. It lists three models: `dots-ocr` (pages), `qwen3.5-9b` at bf16 (clean)
and `qwen3.8-27b-4bit` (translate, simplify, analysis).

`app/shared/model-lineup-local.json` is **Foundry's own additions**, and its
`note` header argues the case in full. Short version: Crucible's file lists what
a CRUCIBLE serves, and Foundry's local path is Ollama on whatever card the person
already owns — which means the smaller quantised Qwen tags that Crucible has no
manifest for. Dropping them would leave an 8 GB laptop being offered exactly one
model, 17.7 GB, that the same screen then marks as too big. Every id in that file
is prefixed `foundry/` so a row of ours can never collide with a Crucible id, and
the merged row carries `crucible: false` recording which file it came from.

**The merged ORDER is computed**, not read: both files are concatenated and
sorted by `needsGB.value` (ties on the id), because everything downstream depends
on smallest-first — `lineupFor` takes the last one that fits, `eligibleFor`
slices at a floor's POSITION, and the tile gate names "the largest present one".
Neither file is sorted, and sorting the vendored one in place would break the
content comparison.

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
Simplify light only where a model at or above the `minimumFor` floor — the 9B —
both fits and is installed, and not at all on a machine with no GPU a model can
use. The gate is `app/electron/act-gates.ts`, answered over `acts:gates`, and
every refusal names the model that would light it.

**A FLOOR MOVED WHEN THE FILE BECAME CRUCIBLE'S, and it is worth saying out
loud.** Package D's hand-written table gave ANALYSIS no floor at all, on Owen's
*"analysis is a sentence at a time and a small model does it, a translation is a
book."* Crucible's row declares `minimumFor: [translate, simplify, analysis]` —
*"the smallest model those three may run on"* — so **analysis now floors at the
4-bit 27B**, and a 12 GB card that used to light the Analysis tile no longer
does. Foundry did not overrule the catalog of record; if that is wrong it is a
fact in Crucible's manifests and it is fixed there and re-vendored.

**TWO CATALOGS MAY EACH DECLARE A FLOOR, AND THE SMALLEST WINS.** The local file
keeps the 9B as the floor for translate and simplify (the two acts Owen named);
Crucible declares the 27B. `eligibleFor` takes the first declaring row in sorted
order, which is the smaller — because the two files answer different questions:
Crucible's floor is what a Crucible will serve, and Foundry's is what an Ollama
on this desk can be asked for.

**AND THE WIZARD WILL NOT PULL FOR A CLASS A LOCAL CRUCIBLE SERVES**
(docs/SLOTS.md §5b). The rows still list — the step's job is to describe the
machine — and each says so, with the server's name, and the Download button is
off. A REMOTE Crucible changes nothing here: it is a slot, not an owner of
anything on this disk, and somebody may well want a local model for the evenings
the Mac is asleep.

## 5b. The Crucible step — three doors, and none of them is a requirement

`STEPS` puts it after Ollama and before the environments. After, because the
Ollama step is what most people will use and a Crucible offered first would read
as a requirement; before the environments, because it is a DECISION rather than a
download and finding it out after paying for two Pythons is finding it out too
late. Its blurb says in as many words that most people should skip it.

The three doors are `app/src/app/components/crucible-doors/crucible-doors.component.ts`,
a child component the **Settings → Servers card mounts as well** — one set of
doors, two hosts, so the two screens cannot drift apart. The Servers card keeps
the LIST (editing, ranking, switching off); the doors add something new.

1. **Connect to a Crucible server** — name, address, token. **Test** goes through
   `crucible:test-at`, which does NOT write anything: adding a server in order to
   find out whether it is a server leaves a dead entry behind every failure. The
   answer is `client.info()`'s backend/GPU/version, or the SDK's own error
   sentence, never reworded. **Add** goes through `crucible:add` → the registry's
   one writer (`writeCrucibleServers`); an existing name is replaced in place,
   keeping its rank.

2. **Use the Crucible on this machine** — `crucible:add-local`, which reads that
   server's own `config.toml` (through `wsl.exe -d <distro>` on Windows) so the
   file stays the token's single owner. The WSL distro field lives inside this
   door, beside the button that needs it, and there is **no default**: *"the
   default distro"* is whatever `wsl --set-default` last said, and a token read
   out of the wrong guest is a wrong token.

3. **Install Crucible here** — today a DOCUMENT and a disabled button, and
   **superseded** once `@crucible/client` 0.6.0 is published: Crucible ships
   its own installer and its own operator page, so this becomes one *Open
   engine console* button wherever a server exists (docs/SLOTS.md §7). What is
   below describes what ships today.

### The hand sequence, and the two commands Foundry may not run

`crucible:install-plan` composes it for this machine
(`app/electron/crucible-install.ts`). The only process it spawns is
`wsl.exe -l -v`, which lists; everything else in the answer is a string to read
and run. On Windows every line runs **inside the guest**; on macOS and Linux, in
a terminal on the machine itself.

1. **A WSL2 distribution** — the one step this app can CHECK, and it does: the
   row says "already here" and names them, or says there is none.
2. `conda create -n crucible python=3.11 -y`
3. `conda run -n crucible pip install <the release wheel>` — `CRUCIBLE_WHEEL`,
   `app/shared/slots.ts`, the same 0.5.0 `@crucible/client` is pinned to.
4. `conda run -n crucible crucible init --enable-llm` — writes
   `~/.crucible/config.toml` at 0600 and mints the token. **`llm` and nothing
   else**: Foundry's two model acts (text, and page reading) are both that job
   type, and `tts`/`asr`/`align`/`rvc` belong to BookForge's pipeline.
5. `conda run -n crucible crucible install llm` — several gigabytes, once.
6. `conda run -n crucible crucible service install` — a systemd user unit, or a
   launchd agent on the Mac.
7. `conda run -n crucible crucible capability --write` — until this runs, a
   client asking what the machine can do is told *undecided*, which is
   deliberately different news from *nothing fit*.
8. `conda run -n crucible crucible models pull qwen3.5-9b qwen3.8-27b-4bit dots-ocr`
9. Come back and press **Use the Crucible on this machine**.

Listed APART, because each needs a privilege this app does not have and must not
ask for silently — which is `@crucible/bootstrap`'s own rule, quoted from its
README: *"A missing prerequisite is a named refusal carrying the exact command
the host must run. Elevation, a reboot, a sudo password — those are the app's to
obtain."*

* Windows, if there is no distribution yet: `wsl --install -d Ubuntu`, in an
  ELEVATED PowerShell, **then reboot**. The first launch asks for a username.
* Linux, to keep the server up when logged out: `sudo loginctl enable-linger "$USER"`.
* macOS needs neither: its service is a launchd agent.

### The seam, and what turning it on costs

`driveCrucibleInstall()` (`app/electron/crucible-install.ts`) is shaped to
`@crucible/bootstrap` 0.5.0's `install()` verbatim — the surface is transcribed
into that file from the package's own `.d.ts` rather than invented. It REJECTS
today with one sentence, `DRIVEN_INSTALL_UNAVAILABLE`, which is the same sentence
the disabled button wears; the `crucible:install` door refuses as well, because
something reachable by an IPC message must refuse at the door or the disabling is
a decoration.

The package is NOT in `app/package.json`: it is released with Crucible's next
version and a dependency on a tarball that does not exist is a build that does
not run. Turning it on is four things, and no caller changes:

1. `npm i @crucible/bootstrap@<release tarball URL>` — its peer dependency is
   `@crucible/client` **0.5.0 exactly**, which is what this app pins;
2. swap the local `Bootstrap*` types for `import type … from '@crucible/bootstrap'`;
3. replace the one `throw` with the `install(…)` call written out in full in the
   comment directly above it, then `ensureRunning()` → `readLocalConfig()` →
   `addCrucibleServer(name, url, token)`;
4. drop the disabled state in the renderer.

Two facts worth carrying: on the Mac, `condaRoots` must include
`/opt/homebrew/Caskroom/miniconda/base` — the package's three defaults are the
official installers' paths and a Homebrew cask is none of them, so a `no_conda`
refusal on a machine that plainly has conda reads as the installer being broken.
And a failure throws `BootstrapStepFailed` carrying `step`, `exitCode`, `tail`
and `stepsDone`: print all four, because partial work survives a failure and
telling somebody which of seven steps did not finish is the difference between
resuming and starting again.

## 6. The default model setting

> **SUPERSEDED 2026-09-15 — FOUNDRY KEEPS NO MODEL.** Owen: *"we dont have any
> local models. crucible handles all model orchestration. if theres no connected
> crucible server then tiles should be disabled. crucible is a service that
> foundry installs locally and connects to."*
>
> **This whole section is history.** `AppSettings.defaultLlmModel`,
> `AppSettings.cleanTextModel` and `AppSettings.ollamaUrl` are deleted, with the
> `llm:*` doors that read and wrote them and the four dialog fields they seeded.
> The model a run uses is the ENGINE's capability record's `selected`, applied
> over the request at the spawn (`doorArgs`, electron/job-queue.ts). What Foundry
> may still do — and does, unchanged — is DRAW the engine's own settings: the
> route per class and the upstream keys, through `crucible:engine-settings*`.
> Owen, the same day: *"foundry does pass through settings to crucible."*

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

### ~~The analysis model (`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`)~~

**Gone, 2026-09-25.** Analysis ranks on a Crucible's decide model now
(docs/ANALYSIS.md §4), so there are no analysis weights on this machine to fetch.

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
* **Two GGUF files, NAMED BY THE CATALOG AND NOT BY THIS CODE** (Wave 61
  package E). `page-reader.ts` held `HF_REPO`/`MODEL_FILE`/`MMPROJ_FILE` as
  constants and `model-lineup.json`'s `pages` row wrote the same four facts down
  again; two owners of "which weights is the reader" is a re-vendored catalog
  quietly disagreeing with what the installer fetches. The row is the owner now,
  read through `pagesForm()`.

  What it names today is `anthonym21/dots.ocr-GGUF` at commit `42ab3102…` —
  `Dots.Ocr-1.8B-Q8_0.gguf` plus `mmproj-Dots.Ocr-F16.gguf`, ~4.42 GB, with an
  **F16 projector** per llama.cpp's own guidance (the mmproj is small and
  quantising it costs more than it saves). BOTH files, because llama.cpp serves a
  vision model as a text tower plus a separate projector: a server started
  without the second loads, answers `/v1/models`, and then refuses every request
  that carries an image. Verified against the LFS sha256 the Hugging Face model
  index publishes **at that revision** — the revision is in the index read AND in
  the download URL, or it is in neither: reading `main`'s hashes and fetching a
  pinned commit's bytes would compare a file against a checksum for a different
  file and delete it as corrupt.

  That is a DIFFERENT PAIR from the `ggml-org` Q8/Q8 one this app used to fetch,
  so a machine that installed the reader before this change holds two superseded
  files. `pageReaderFootprint` walks the models DIRECTORY rather than the current
  pair precisely so they cannot go unaccounted — they are listed, marked
  superseded, and the Remove button takes the whole directory.

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

## 8. ~~The analysis-worker environment~~ — removed 2026-09-25

The `nli-windows-x64` and `nli-mac-arm64` catalog entries (torch, transformers
and the DeBERTa weights, for the entailment ranker) are gone with the ranker:
analysis ranks on a Crucible's decide door (docs/ANALYSIS.md §4), and the
published v1 archives are orphaned on the release, never offered again.
`EnvTarget` is the two reading environments.

## 9. Building and publishing an environment

See `docs/DEPLOYING.md` § "The Python environments" for the runbook.

## 10. Deliberately not built

* **~~The mac analysis environment.~~** Moot since 2026-09-25: there is no
  analysis environment on any platform. (§8.)
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
