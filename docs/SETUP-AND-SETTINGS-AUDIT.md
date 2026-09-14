# Setup and settings — every question this app asks, and whether it should

> An audit, not a change. Nothing outside this file moved. Written 2026-09-14
> against `main` @ `3b13392`, after docs/SLOTS.md (the plan of record for
> compute), docs/SETUP.md, docs/IPC-CHANNELS.md and docs/PLAN.md "Wave 61".

## 0. Why this pass, and the one sentence it is measured against

Owen's product is in SLOTS.md §1 and it is two sentences, not one:

> *"foundry should work if they have no idea what theyre doing and they just
> want to convert PDFs to EPUB. but if they do know what theyre doing and they
> want access to speed, they can use crucible."*

and, the floor he settled on 2026-09-14:

> *"i think either they use the 27b or they use an api key for Claude or OpenAI.
> thats probably the best solution."*

Those two together decide almost every row below. **The friend who cannot
install WSL must still get an EPUB** — so anything on the path from a dropped
PDF to a rendered book is load-bearing and stays, whatever else goes. **The
speed tier is a separate program with its own installer and its own operator
page** — so anything in Foundry that installs, configures, administers or
explains that program is a second copy of somebody else's screen and goes.

BookForge ran this same pass today and went 8 wizard steps → 4, 15 settings
sections → 11, on the rule that the engine owns "download an engine / a model /
a voice". **Foundry is not BookForge and cannot take that rule whole.** BookForge
*requires* Crucible; Foundry must work with none. The line here is therefore not
"the engine owns downloads" but a narrower one:

> **The engine owns everything that is only true because there is an engine.**
> What Foundry downloads for a machine with NO engine is Foundry's, permanently.

There are exactly two such downloads and both survive this audit: the local page
reader (llama.cpp + the dots.ocr GGUF pair) and the prebuilt rasteriser Python.
Section F argues each at length, because both were on the table and deleting
either one deletes the product.

### The four shapes this repo keeps finding, and where they turned up

1. **A fact stored in two places.** The analysis floor (§F.3) — docs/SLOTS.md,
   docs/SETUP.md and docs/PLAN.md all say Crucible's 27B row declares
   `minimumFor: [translate, simplify, analysis]`; the vendored file says
   `["translate","simplify"]` (`app/shared/model-lineup.json:65-68`). Three
   documents and the data disagree, and the data wins silently.
2. **A setting read by nobody.** `CloudSettingsView.hosted`
   (`app/shared/slots.ts:437`), `LlmChoices.current`
   (`app/shared/types.ts:2039`), `LineupRow.minimum`
   (`app/shared/model-lineup.json:64`), and `decideProvisioning`'s `settings`
   parameter (`app/electron/env-provision.ts:59`).
3. **A reader that disagrees with its writer.** `act-gates.ts:95` sends every
   refusal to *"Settings › Language model"* to pull a model. That card has no
   pull button and never had one — the only pull in the app is the wizard's
   Ollama step (`setup-wizard.component.ts:289-294`).
4. **A control that can only refuse.** Three today: door 3's "Install it for me"
   (disabled on every machine, by construction), the Cloud card drawn hosted
   with live Save/Test controls whose module header claims a read-only mode
   that does not exist, and the env card's Mac analysis row, which is published
   nowhere and cannot be installed anywhere.

---

## A. The first-run wizard

`app/src/app/components/setup-wizard/setup-wizard.component.ts` — seven steps in
one `STEPS` table (`:96-140`), mounted unconditionally by the shell, suppressed
hosted at `:774-778`. Every step is skippable and every skip is recorded.

### A.1 Chrome — the parts that are not a step

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| The rail of dots | `setup-wizard.component.ts:151-159` | one dot per step, past/here | the person | KEEP | It is the only thing telling somebody how much is left; seven dots becoming four is the whole visible result of this pass. |
| ✕ Close setup | `:161`, `dismiss()` `:892-900` | closes, and records every step from here on as skipped | `setup:finish` → `AppSettings.setupSkipped` | KEEP | Leaving is a completed setup, not an abandoned one. The rule is right and survives any re-cut of the steps. |
| Back / Next | `:440-451`, `:862-871` | walk the table | — | KEEP | |
| Skip this | `:447-449`, `skip()` `:873-877` | records the id and advances | `setupSkipped`, read by `llm-card:112` | KEEP | |
| Start using Foundry | `:445`, `finish()` `:902-904` | `setup:finish` with what was skipped | — | KEEP | |
| `skippable()` — Welcome and Ready are not | `:734-737` | hides Skip on the two prose pages | — | KEEP | A Skip beside a paragraph means nothing, and a skipped id naming prose would make the settings warning say something false. |
| Hosted suppression | `:774-778` (`api.hosted()` awaited *with* `setup:state`) | the wizard never opens inside BookForge | — | KEEP | The race is real and the comment argues it correctly — `hosted` is filled by a promise started at module load. |

### A.2 Step 1 — Welcome

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Blurb: *"Four things to set up."* | `:99-101` | the rail's first caption | the person | REWORD | There are FIVE actionable steps between Welcome and Ready (library, ollama, crucible, envs, reading). The number was true when the table had six rows; the Crucible step was added in Package E and the blurb was not touched. After this pass it should name whatever the new count is — or, better, stop counting. |
| Lead: *"Foundry turns a scanned or PDF book into text…"* | `:172-176` | what the app is | the person | KEEP | The one paragraph on this screen that is about the product rather than about plumbing. |
| *"Nothing on the next screens downloads until you press the button…"* | `:177-180` | the permission rule, said once | the person | KEEP | This is the promise the whole wizard is built on (SETUP.md §2) and every step honours it. |
| The machine sentence | `:181-184`, `loadProfile()` `:806-810`, `system:probe` | `SystemProfile.detail` — GPU, VRAM, RAM, disk | the person | KEEP | Free to read, and it is the fact every later step's refusal refers back to. |

### A.3 Step 2 — Your library

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Blurb: *"Where finished books live…"* | `:102-106` | caption | the person | KEEP | Accurate and free of jargon. |
| *"Changing it later affects new work only"* | `:188-191` | the no-migration promise | the person | KEEP | Matches `AppSettings.libraryDir`'s docblock (`app-settings.ts:130-139`) exactly; two surfaces, one sentence. |
| Library folder path + **Choose…** | `:192-198`, `pickLibrary()` `:913-920` | `library:choose` then `library:set`; main's answer wins | `AppSettings.libraryDir` | KEEP | The one step on this screen that costs nothing, answers a question the app genuinely cannot guess, and has no engine equivalent. First for that reason. |

### A.4 Step 3 — Ollama and a model

This is the step the pass hurts most, and §F.3 argues why.

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Blurb: *"The model this machine runs text on…"* | `:107-111` | caption | the person | REWORD | It says a card that cannot hold a 27B *"reaches translation another way"* without naming the way. The agreed words are "a GPU engine (Crucible) or a cloud key", and the caption is where somebody decides whether to spend twenty minutes here. |
| Ollama state dot + `facts.ollama.detail` | `:204-207`, `ollama:facts` | is a server answering | the person | KEEP | Two questions (running / installed at all) answered honestly, never cached. |
| *"Foundry does not install or manage ollama…"* | `:210-214` | sets the expectation before the installer opens | the person | KEEP | The only honest thing to say about a handoff into another vendor's installer. |
| **Download the ollama installer** | `:216-218`, `getOllama()` `:943-955`, `ollama:install` | fetches `OllamaSetup.exe`/`Ollama.dmg`, hands it to `shell.openPath` | — | RULING | **Should Foundry still walk a first-time user into a second vendor's installer, given the floor?** On any machine under 18.5 GB this installs a program that will light no tile (see §F.3). Keep it and the step must say so up front; drop it and Ollama becomes a thing you configure in Settings if you already have it. |
| **Check again** | `:219`, `reprobe()` `:938-941` | re-reads `ollama:choices` | — | KEEP | The install finishes in a window this app does not own; the probe is the only thing that ever says it landed. |
| `facts.profile.detail` | `:222` | the machine, again | the person | KEEP | Repeated from Welcome deliberately — this is where the number matters. |
| `translateFloorMiss` warning | `:232-239`; composed `electron/setup.ts:76-82` | *"Translation and simplification need X or larger…"* | the person | REWORD | Two defects. (a) It says *"connect a Crucible server or a cloud provider in Settings"* — the agreed words are "GPU engine (Crucible)". (b) It is computed from `eligibleFor('translate')` alone and the next sentence on screen (`modelSaid`, below) then promises analysis will work. |
| `facts.crucible` — *"…already serves X here, so Foundry will not pull a second copy"* | `:249-255`; `LlmChoices.crucible`, `setup.ts:99` | says why the download buttons are off | the person | KEEP | SLOTS.md §5b, implemented exactly: said in the rows, not by hiding them. |
| The model rows | `:256-280`; `lineupFor` `llm-catalog.ts:400-446` | 8 Ollama tags with size, fit, installed, recommended | the person | KEEP | Describing the machine is this screen's job and the list does it honestly, including rows that do not fit. |
| **Use `<tag>`** | `:284-287`, `useModel()` `:976-981` | `llm:set-model` | `AppSettings.defaultLlmModel` | KEEP | |
| **Download `<tag>` (N GB) and use it** | `:288-294`, `pullModel()` `:963-974`, `ollama:pull` | streamed `POST /api/pull` | — | KEEP | The permission-is-the-button rule, honoured with the size on the button. |
| Cancel | `:296-298`, `cancelOllama()` `:957-961` | aborts install or pull | — | KEEP | |
| Pull progress bar + detail | `:302-307`, `ollama:progress` | one LAYER's percentage, and says so | the person | KEEP | |
| `modelSaid`: *"Translation, simplification and analysis will start from `<tag>`."* | `:308`, set at `:980` | confirmation after Use/Download | the person | REWORD | **It is false on every machine under the translate floor**, which is the machine this step exists for. On a 12 GB card the screen warns that translate and simplify will not run and then says all three will start from the 9B. It should name the acts the chosen tag can actually serve. |
| *No row for the Clean text model* | — (`textRows()` `llm-catalog.ts:272-278` filters to `classes ⊇ translate`) | — | — | RULING | **Should the wizard offer to pull the cleanup model?** `DEFAULT_CLEAN_TEXT_MODEL` is `qwen3.5:9b-q8_0` (`shared/pipeline.ts:110`); it is a `clean`-class row, so it is not in this list, and **nothing anywhere in Foundry offers to download it**. The Settings card lets you pick it; pressing Clean text then fails at Ollama. |

### A.5 Step 4 — Crucible (optional)

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Blurb: *"Most people should skip this."* | `:113-124` | caption, with a long comment arguing the position in the table | the person | REWORD | The position is right and the word is wrong. "Crucible" is a product name a first-time user has never heard; the agreed first-mention is **GPU engine (Crucible)**. Keep *"most people should skip this"* verbatim. |
| Lead: *"Crucible is a separate program that serves models over the network…"* | `:316-320` | explains the concept | the person | REWORD | Same word problem, and it is the first mention in the whole flow. |
| *"What it buys is speed and reach…"* | `:321-325` | the two reasons to bother | the person | KEEP | This paragraph is the honest case for the tier, and it is the one thing on the step that the engine's own console cannot say (it is about *this* machine's slot being replaced). |
| *"Already registered: `<names>`"* | `:326-331`, `crucibleNames()` `:852-854` | proof an Add landed | `crucible:settings` | KEEP | The only feedback the step gives; the doors close and say nothing more. |
| `<app-crucible-doors>` | `:332`; the doors themselves are audited at **B.5** | mounts the three doors | — | KEEP (the mount) | One component, two hosts, so the wizard and Settings cannot teach different things about one registry — that part is right and stays. What is inside door 3 is not; see B.5. |
| *No "Open engine console" here* | — (`crucible:open` exists, `ipc.ts:3334`, but is wired only to the Servers card) | — | — | RULING | **Should the wizard offer to open the engine's console once a server is registered?** SLOTS.md §7's superseded note says door 3 *"collapses to a single Open engine console button wherever a server already exists"*; that button exists in Settings and not here. |

### A.6 Step 5 — Python environments

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| The step itself | `STEPS` `:125-129`, body `:336-379` | offers the prebuilt Pythons | `env:catalog` | **DELETE** | See §F.2. On Windows this step offers two rows: the rasteriser, which **the app already installs by itself at startup** (`env-provision.ts:73-78`), and the analysis worker. On a Mac it offers the MLX archive (same auto-install rule, `:93-101`) and an analysis worker that **has no published hash and cannot be installed at all** (`env-catalog.ts:128-133`). A whole wizard step for one optional 528 MB download is a step that teaches the word "rasteriser" for nothing. The env card stays in Settings (B.7) and the startup provisioner stays untouched. Cost: somebody who wants the analysis worker on day one has to find Settings. |
| Blurb: *"Prebuilt, hash-checked, and the exact versions foundry was measured with."* | `:126-128` | caption | the person | DELETE | With the step. It is a sentence about supply-chain discipline aimed at a person who has not yet converted a book. |
| *"These are complete Pythons with the exact package versions…"* | `:337-341` | the argument for not using pip | the person | DELETE | With the step; the same argument is already in the env card (`env-card:49-53`). |
| Per-row: label, dot, "installed"/"not yet published" badges | `:342-349` | state | `EnvCatalogItem` | DELETE | With the step; the card draws the same rows. |
| Per-row: purpose + python version + packages | `:350-351` | what it buys | — | DELETE | With the step. |
| Per-row: queue-driven progress | `:352-363`, `envJob()` `:991-994` | bar, phase word, failure | `queue:list` | DELETE | With the step. |
| **Download `<size>` and install** | `:364-370`, `installEnv()` `:1015-1023` | `env:install`, queued | — | DELETE | With the step. |
| *"This one has not been published yet… It is not offered."* | `:371-373` | the Mac analysis worker's refusal | `isPublished()` | DELETE-AFTER — **`nli-mac-arm64` is built and published, or the entry is dropped from `ENV_SPECS`** | A row that exists only to say it cannot be used is the house's "a control that can only refuse". It has been in this state since 2026-08-26. |
| *"Nothing on this platform needs a prebuilt Python."* | `:376-378` | the empty case | `targetsForPlatform()` | REWORD (then DELETE with the step) | **On Linux this sentence is false and dangerous.** `env-catalog.ts` has no Linux entry at all, and every tier rasterises locally with PyMuPDF — so a Linux machine is told it needs nothing and then cannot convert anything. The env card carries the same sentence (`env-card:55-57`) and inherits the defect. |

### A.7 Step 6 — The page reader

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Blurb: *"What actually reads the pages. On most machines this is the one download that matters."* | `:130-134` | caption | the person | KEEP | True, and after this pass it is *the* download that matters. |
| Lead naming dots.ocr and Ollama | `:384-388` | why this one is fetched by Foundry | the person | REWORD | It says *"goes to the ollama on the last step"* — a positional reference that breaks the moment a step moves, which this pass moves. Name the step, or name neither. |
| `it.platformNote` | `:389`, `pageReaderState()` | which build this machine gets, or why none | `PageReaderState.platformNote` | KEEP | |
| `it.detail` | `:390` | one sentence about what is here and what is missing | — | KEEP | |
| *"It is fetched once and kept…"* | `:391-394` | offline afterwards, and the analysis weights are elsewhere | the person | REWORD (if A.6 lands) | The second half points at *"the previous step"* for the analysis model. With the env step gone that reference dangles. |
| **Download the page reader (`<size>`)** | `:395-403`, `getReader()` `:1053-1062`, `page-reader:install` | llama.cpp build + 2 GGUF, resumable, sha256-checked | — | KEEP | §F.1. This is the friend's only path to an EPUB. |
| Cancel | `:404-406`, `cancelReader()` `:1064-1067` | stops it; what is fetched is kept | — | KEEP | |
| Progress bar + `progress.item` | `:409-416`, `page-reader:progress` | per-file, five phases | — | KEEP | |
| `readingSaid` | `:420` | the install's own last sentence | `InstallOutcome.detail` | KEEP | Belt and braces against a broadcast that arrives after a reload; the card does the same. |

### A.8 Step 7 — Ready

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Blurb + *"That is everything foundry needs to be asked for."* | `:135-139`, `:425` | closing | the person | KEEP | |
| *"Skipped: `<titles>`. Settings has a button that opens this again…"* | `:426-433`, `skippedTitles()` `:879-883` | names what was declined | `setupSkipped` | KEEP | "You skipped the analysis worker" is actionable; "setup was not completed" is not. |
| *"Open a PDF or a folder of photographs from Home to start a book."* | `:434` | the next action | the person | KEEP | The only sentence in the wizard that tells somebody what to do with the app. |

**Section A: 56 rows** — KEEP 36, REWORD 9, DELETE 7, DELETE-AFTER 1, RULING 3.
(The Crucible doors themselves are audited once, in B.5.)

---

## B. Settings

`app/src/app/pages/settings/settings-page.component.ts` — two columns. Left is a
read-only measurement (`foundry doctor --json`); right is nine cards, two of
which are hidden hosted.

### B.1 The page shell and the left column

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Page title **"Backend"** | `settings-page.component.ts:38` | the heading | the person | REWORD | Nothing else in the app calls anything "the backend". The screen now holds the library, three compute destinations, two model stores and the cloud keys; "Settings" is what it is. |
| **Re-probe** | `:39-41`, `probe()` `:335-353` | re-runs `doctor:run` at the URL **on screen** | — | KEEP | Probing the typed URL rather than the saved one is right and is argued in place. |
| Engine line — command, args, version, source | `:47-52`, `engine:info` | which `foundry` binary would be spawned | — | KEEP | The one line that answers "which build am I running" when a bug report arrives. |
| Rasteriser card | `:55-64` | PyMuPDF availability + the interpreter path | `DoctorReport.rasteriser` | KEEP | §F.2 — this is the thing that has to be true before any tier does anything. |
| Tier cards + "chosen" badge | `:66-75` | endpoint / wsl-vllm / mlx / native | `DoctorReport.tiers` | KEEP | The engine's own measurement, rendered and never second-guessed. |
| Tier label `'wsl-vllm' → "vLLM in WSL"` | `:383` (with a comment saying it is a label for a measurement, not an action) | names a tier this app can no longer act on | — | DELETE-AFTER — **the engine drops the `wsl-vllm` tier** | Owen ruled vLLM is Crucible-only; the app's launcher is gone. Keeping a tier card that says "vLLM in WSL" on a screen whose whole point is now "connect to an engine" re-teaches the thing the wave deleted. It cannot go from here alone: `runDoctor` is `src/`, which is out of scope. |
| *"No tier would be used…"* | `:77-82` | the engine names rather than degrades | — | KEEP | |
| "No report" card | `:83-90` | doctor could not run, with its own text | `DoctorResult.reason` | KEEP | An engine too old to have the command is a card, not an error. |

### B.2 The `settings.json` form (hidden hosted, `:109`)

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card + file path | `:110-112`, `settings:read` | names the engine's file | — | KEEP | The path is the only way to find the file by hand when this form refuses. |
| `settingsProblem` | `:114-116` | the file exists and will not parse | `SettingsView.problem` | KEEP | Reported, never overwritten — correct. |
| **Mode** select — auto / endpoint / mlx | `:118-125` | `backend.mode` | the engine, every run, machine-wide | RULING | **Does a person who has a GPU engine ever set this by hand?** With slots, WHERE a job runs is a per-row choice; `mode` is a machine-wide engine setting that predates slots and now competes with them. It is also the switch that decides whether `readGate` even consults the local page reader (`act-gates.ts:328-338`). Two owners of "where does a read go". |
| **Endpoint URL** | `:127-131` | `backend.endpointUrl`, default `http://localhost:8000/v1` | the engine; also `act-gates.ts:329`, `page-reader.ts` port 8000 | RULING | Same question. Today this field is how a reading job finds the local page reader — and the page-reader card never mentions it. Somebody who types a different URL here silently turns off the reader they downloaded, and no screen says so. |
| **Python** (*"needs PyMuPDF; every run rasterises locally"*) | `:133-137` | `backend.python` | the engine | KEEP | §F.2. It is the rasteriser, it is not a model, and a person with a conda env full of PyMuPDF has a legitimate reason to point at it. |
| **Save** + "Saved" | `:139-145`, `save()` `:355-374` | `settings:write`, then re-probe | — | KEEP | |
| Hosted guard on the whole card | `:109`, and `settings:write` refuses at `ipc.ts:3038-3045` | | | KEEP | Correct on both sides — the hiding is not a decoration. Found by BookForge's audit and fixed properly. |

### B.3 Library location (hidden hosted, `:156`)

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card + current path | `library-card.component.ts:22-25` | `library:dir` | `AppSettings.libraryDir` | KEEP | |
| *"Conversions are written to `workspace`… Changing it affects new work only"* | `:26-30` | the no-migration promise | the person | KEEP | |
| **Choose folder…** | `:32-37`, `browse()` `:98-113` | picker then `library:set`; main's value wins | | KEEP | |
| Hosted guard | `settings-page:156`, and `library:set`/`library:choose` refuse at `ipc.ts:2822,2826` | | | KEEP | The house rule stated in the comment at `settings-page:149-155` — *a control that can only refuse is not a control* — applied correctly. It is the precedent every hosted row below is measured against. |

### B.4 Language model

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card title **"Language model"** | `llm-card.component.ts:55` | | | REWORD | It is *this machine's* Ollama and nothing else (the module header says so at `:19-31`); the title reads as though it governed every language act, including the ones that run on an engine or a key. "Models on this computer" or "Ollama on this computer". |
| *"What Translate, Simplify and Analyse open with…"* | `:58-61` | the seed-not-lock rule | the person | REWORD | On a sub-27B machine Translate and Simplify are dark, so two of the three named acts cannot be opened at all. Say which acts this tag can serve here. |
| **Default model** text field | `:63-67`, `llm:stored` / `llm:set-model` | `AppSettings.defaultLlmModel` | four dialogs via `llm:defaults` | KEEP | Free text on purpose (`clampModelTag`, `app-settings.ts:507-512`) — somebody who pulled their own model has said something true a table cannot know. |
| **Clean text model** select | `:74-85`, `cleanTextModelsFor` `shared/pipeline.ts:150-158` | `AppSettings.cleanTextModel` | Clean dialog; BookForge's own door reads the same key | KEEP | Its own setting because it is its own economy (~50 blocks/min vs ~9). |
| `unlistedClean` — a stored tag not on the list rides at the top | `:188-192` | shows what is actually saved | | KEEP | A picker that silently replaced a stored tag with the default on the next Save would be a setting that edits itself. |
| *"Clean text runs its own model…"* | `:86-89` | why there are two fields | the person | KEEP | |
| `Ollama: <url>` mono line | `:90`, `llm:stored` | prints `AppSettings.ollamaUrl` | | RULING | **Should the Ollama URL be editable anywhere?** `llm:set-ollama-url` exists (`ipc.ts:3291`) and **no surface in the app calls it**. Either the field is drawn here or the door should go — a writable setting with no writer is a setting that can only be changed by hand-editing JSON. |
| **Save** | `:92-95`, `save()` `:222-241` | writes both tags, answers with what was stored | | KEEP | |
| **Run first-run setup again** (hidden hosted) | `:103-105`, `UiService.openSetup` `ui.service.ts:251-267` | reopens the wizard | | KEEP | The only thing that makes "every step is skippable" a real offer. Guarded on both sides. |
| *"Skipped during setup: …"* / *"Setup has not been run"* | `:108-114` | names what was declined | `AppSettings.setupSkipped` | KEEP | |
| *No pull control anywhere on this card* | — | — | — | **RULING** | `act-gates.ts:95` tells every dark tile to *"pull one from Settings › Language model"*. There is nothing here to pull with. Either the card grows a pull, or the gate's sentence names the wizard. This is the audit's clearest reader/writer disagreement. |

### B.5 Servers — and the three doors

Card: `app/src/app/pages/settings/servers-card.component.ts`.
Doors: `app/src/app/components/crucible-doors/crucible-doors.component.ts`,
mounted here (`:186`) and by the wizard (`setup-wizard:332`).

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card title **"Servers"** | `servers-card:94` | | | REWORD | **"GPU engines"**. "Server" is what the thing is; "GPU engine" is what Owen calls it to a person, and this card is where the word is first met in Settings. |
| Hosted branch: read-only slot list + *"Change them there"* | `:98-106` | draws the host's slots, no controls | `CrucibleSettingsView.hosted` | KEEP | The library card's rule, applied correctly, and backed by `refuseHostedRegistryChange` (`crucible-registry.ts:327`). |
| Hosted empty case: *"The host has offered no slots…"* | `:104-105` | | | KEEP | A sentence rather than an empty list, per `SlotAvailability`'s design. |
| Detail: *"Crucible servers this machine can send translation… to"* | `:108-112` | what the card is for | the person | REWORD | Product name on first mention; and it should say what the engine buys (speed, a bigger card, models held resident) rather than listing act names. |
| Row: **name** field | `:121-123` | the slot's name, and what a row's `waitFor` says | `crucibleServers[].name` | KEEP | |
| Row: **On** toggle | `:124-128` | enabled | `crucibleServers[].enabled` | KEEP | Load-bearing in a way it was not before: SLOTS.md §7 rules that disabling is the one way to say "do not coordinate with that one". |
| Row: **Remove** | `:129`, `drop()` `:340-343` | drops the row from the edit set | | KEEP | |
| Row: **url** field | `:131-133` | base URL without `/v1` | `crucibleServers[].url` | KEEP | `clampCrucibleUrl` normalises the paste people actually have. |
| Row: **token** password field (write-only) | `:135-138` | a NEW token, or `null` = keep stored | `crucibleServers[].token` | RULING | **Does a token field survive the connect-code change?** SLOTS.md §7 says the connect door *"gains one field that takes a connect code (`parsePairing`)"* and that `parsePairing` will not be reimplemented here. If a connect code replaces name+url+token, this row's three boxes become an edit surface for something that was pasted as one string. |
| Row: **Test connection** | `:139-142`, `crucible:test` | `client.info()`; failure keeps the SDK's sentence | | KEEP | |
| Row: **Open** | `:150-151`, `openUi()` `:408-415`, `crucible:open` → `crucible-ui.ts:76` | opens the server's own operator page in a locked-down window | | REWORD | **This is already the thing this whole pass is about** — and it is labelled with one word, "Open", on a row of five controls. The agreed words are **Open engine console**. `crucible-ui.ts`'s header (`:6-12`) already carries Owen's 2026-09-14 ruling verbatim; the button does not carry its consequence. |
| Row: probe result line | `:153-161` | the SDK's own words, ok or not | `CrucibleProbe` | KEEP | |
| Row: loopback note | `:162-167` | *"…replaces the local GPU slot"* | `isLoopbackUrl` | KEEP | The one fact about a local engine a person cannot work out from anywhere else. |
| Empty: *"No servers. Everything runs on this computer."* | `:169-171` | | | KEEP | Exactly the right sentence for Owen's default user. |
| **Add a row by hand** | `:174`, `add()` `:332-338` | appends a blank editable row | | **DELETE** | It is door 1 with the guard rails off: no Test before Add, no refusal by name, and a row that fails `clampCrucibleServers` is silently dropped at the save with the card showing what was typed until it re-reads. Door 1 (`Connect`) is the same gesture done properly, sits eight lines below, and is shared with the wizard. Cost: an operator who wants to paste three rows quickly loses a shortcut; they gain three tested ones. |
| **Save** | `:175-177`, `save()` `:371-398` | `crucible:save` — the whole list, order is rank | | KEEP | One door for add/remove/rename/reorder/enable is argued correctly in `writeCrucibleServers`. |
| `problem()` line | `:179` | main's refusal, by name | | KEEP | |
| **New jobs wait for** select | `:192-199`, `crucible:set-new-jobs-wait-for` | `AppSettings.newJobsWaitFor` | `waitForOfNewJob()` `crucible-registry.ts:482` | REWORD | It is drawn unconditionally. With one slot — the overwhelming majority of installs — "the top-ranked slot" and "any" name the same machine, so it is a question with one answer. Draw it only when `slots().length > 1`, which is the rule the sentence below it already uses. |
| *"Slots, in order: …"* (only when >1) | `:201-206` | names the slots and points at the row picker | | KEEP | |
| Orphan warning + **Send them to any slot** | `:208-222`, `refreshOrphans()` `:442-451`, `freeOrphans()` `:454-458` | rows naming a slot that is off or gone | the queue mirror | KEEP | Owen's *told, never moved silently*, built exactly. |

**The doors** (`crucible-doors.component.ts`) — one component, two hosts:

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Door 1 header *"Connect to a Crucible server"* | `:64-67` | | | REWORD | *"Connect to a GPU engine"*, with the note naming Crucible once. |
| Door 1 **Name** | `:70-74` | | | KEEP | |
| Door 1 **Address** | `:75-79` | | | KEEP | |
| Door 1 **Token** (*"crucible token --show, on that machine"*) | `:80-84` | | | RULING | **Is the connect line a token, or a connect code?** The placeholder currently teaches a CLI command on another computer — which is the exact class of instruction Owen's ruling moved to the engine. `parsePairing` is owed by `@crucible/client` 0.6.0. |
| Door 1 **Test** | `:86-88`, `crucible:test-at` | probes without writing | | KEEP | *Adding a server in order to find out whether it is a server leaves a dead entry behind every failure* — the rule this card gets right and "Add a row by hand" does not. |
| Door 1 **Add** | `:89-91`, `crucible:add` | one writer, replaces by name in place | | KEEP | |
| Door 1 probe result | `:93-101` | | | KEEP | |
| Door 2 header *"Use the Crucible on this machine"* | `:106-111` | | | REWORD | *"Use the GPU engine on this computer"*. |
| Door 2 **WSL distro** field + its paragraph | `:114-131`, `saveDistro()` `:366-369`, `crucible:set-wsl-distro` | `AppSettings.wslDistro`; used only to `cat` config.toml through `wsl.exe` | `crucible-registry.ts:707` | RULING | **Should Foundry ask which WSL guest an engine lives in?** It is the single most "you are configuring somebody else's server" control on the screen, and it exists because the token lives in a file on the far side of a guest boundary. A connect code from the engine's own console removes the need for it entirely. Until then it is load-bearing and there is deliberately no default. |
| Door 2 button | `:132-136`, `addLocal()` `:379-399`, `crucible:add-local` | reads config.toml, registers, replaces in place | | KEEP | Pressing it again after `crucible init --force` is the supported token refresh and the note says so. |
| Door 2 note | `:137-139` | what was added, from where | `LocalCrucibleAdd` | KEEP | |
| Door 3 header *"Install Crucible here"* | `:144-147` | | | **DELETE-AFTER** — **Crucible publishes an installer and a console reachable before a server is registered** | Owen, 2026-09-14, already written down in `crucible-ui.ts:6-12`: *"Foundry stops printing install steps and pull lists: administering a server belongs to the server."* SLOTS.md §7 marks this door SUPERSEDED. What replaces it is one paragraph and a link. |
| Door 3 `it.machine` sentence | `:151`, `crucible-install.ts:154` | repeats the hardware probe | | DELETE-AFTER | With the door. |
| Door 3 *"no build for this platform"* warning | `:152-157` | Crucible is CUDA-on-Linux or MLX | `installPlatform()` | KEEP | This one sentence must survive the door: it is the only place the app says the speed tier does not exist for this machine. Move it beside door 1. |
| Door 3 numbered steps (8 of them) | `:159-170`; composed `crucible-install.ts:174-259` | conda create / pip install wheel / init --enable-llm / install llm / service install / capability --write / **models pull qwen3.5-9b qwen3.8-27b-4bit dots-ocr** / come back | the person | **DELETE-AFTER** (same condition) | Eight commands for another program, including a model-pull list that is a second copy of Crucible's own catalog and will go stale the moment its manifests move. This is the largest single block of "the engine's console owns it now" in the app. Cost: a determined Windows user loses a copyable sequence; they gain Crucible's own installer, which is the thing that is actually maintained. |
| Door 3 elevated steps | `:172-185`; `crucible-install.ts:269-288` | `wsl --install -d Ubuntu`; `loginctl enable-linger` | the person | **DELETE-AFTER** (same condition) | Same argument. **Note the cost precisely:** this is currently the only place in Foundry that tells a Windows user they need WSL at all. That sentence has to land somewhere — see the proposal in §H.1. |
| Door 3 **Install it for me** (disabled on every machine) | `:187-192`, `drive()` `:411-424`, `crucible:install` → `driveCrucibleInstall` rejects `crucible-install.ts:330` | nothing, ever | | **DELETE** | The house rule, stated plainly: *a control that can only refuse should not be drawn*. It has never been enabled on any machine and its enabling condition (`@crucible/bootstrap`, a package deliberately not in `app/package.json`) has now been overtaken by the ruling that Crucible ships its own installer. Delete the button, the `crucible:install` door, `driveCrucibleInstall`, the `Bootstrap*` type transcriptions and `MAC_CONDA_ROOTS`. Cost: the four-step turn-on recipe in SETUP.md §5b becomes history rather than a plan. |
| Door 3 `drivenWhy` sentence under it | `:192`, `DRIVEN_INSTALL_UNAVAILABLE` `crucible-install.ts:119-121` | explains the disabled button | | DELETE | With the button. |
| Door 3 `installSaid` | `:193` | prints a failure that cannot happen | | DELETE | With the button. |
| Door 3 README link | `:194-197`, `crucible-install.ts:157` | `https://github.com/telltaleatheist/crucible` | | KEEP | This is what door 3 becomes. |
| Accordion — one door at a time | `toggle()` `:311-317` | the three are alternatives | | KEEP | With two doors it matters more, not less. |
| Lazy `crucible:install-plan` read | `:316`, `loadPlan()` `:319-322` | spawns `wsl.exe -l -v` only when door 3 opens | | DELETE-AFTER | With the door and `crucibleInstallPlan()`. The one thing worth rescuing is the WSL-present check, which belongs in the "no build for this platform" sentence. |

### B.6 Cloud providers

`app/src/app/pages/settings/cloud-card.component.ts`.

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card title **"Cloud providers"** | `cloud-card:88` | | | KEEP | Plain words, no product name, right position (last of the three compute cards). |
| Detail: *"…so translation, simplification, narration cleanup and analysis can run on usage credits… Reading the pages never goes to a provider"* | `:92-96` | scope | the person | KEEP | The exception is the important half and it is said out loud. |
| Row: **name** | `:101-103` | | `cloudProviders[].name` | KEEP | |
| Row: **kind** select (OpenAI / Anthropic) | `:104-108` | decides the header and `--server` | `cloudProviders[].kind` | KEEP | Declared, never sniffed — the engine's own rule. |
| Row: **On** toggle | `:109-113` | enabled ⇒ a slot | | KEEP | |
| Row: **Remove** | `:114` | | | KEEP | |
| Row: **model** free text | `:122-124`, hint `CLOUD_PROVIDER_MODEL_HINT` | the provider's own id | `cloudProviders[].model` | KEEP | No compiled catalog, deliberately — hosted line-ups change monthly and Test is the proof. |
| Row: **endpoint** (optional) | `:132-134`, `CLOUD_PROVIDER_ENDPOINT` | empty = the provider's own | `cloudProviders[].endpoint` | KEEP | Resolved at the placement so a provider moving its API is one line of this build. |
| Row: **API key** password (write-only) | `:137-140` | `apiKey: null` keeps the stored one | `cloudProviders[].apiKey` | KEEP | |
| Row: **Test** | `:141-144`, `cloud:test` → `probeCloud` | `GET /v1/models`, unbilled | | KEEP | Proves the key and the model id in one request that costs nothing. |
| `CLOUD_KEY_SENTENCE` under the key box | `:151`, declared `shared/slots.ts` | *"Text you translate, simplify, clean or analyse is sent to that provider."* | | KEEP | Declared once so no surface can word it differently. The most important sentence on the card. |
| Probe result — listed / not listed / failed | `:153-174`, `notListed()` `:323-328` | three different pieces of news | `CloudProbe` | KEEP | A working key with an unlisted model is a warning beside a success, not a failure — correct. |
| Empty: *"No cloud providers. Nothing in this app sends text anywhere."* | `:176-178` | | | KEEP | |
| **Connect a provider** | `:181`, `add()` `:335-350` | appends a row | | KEEP | |
| **Save** | `:182-184`, `save()` `:370-392`, `cloud:save` | replaces the whole list | | KEEP | |
| Cloud-slot sentence | `:188-195`, `slotNames()` `:307-309` | names the slots and says `any` never falls into them | | KEEP | The safety story lives in the dispatcher; this is where it is *said*. |
| **The card is drawn hosted with every control live** | `settings-page:193` (no `@if`), and `cloud-card` never reads `view.hosted` | Save/Test/Remove all work hosted | `cloud:save` **does not refuse hosted** (`cloud-providers.ts:236-251`) | KEEP (the behaviour) + **DELETE** (`CloudSettingsView.hosted`) + REWORD (the module header) | The *behaviour* is the 2026-09-14 ruling: hosted, this settings file IS the host's userData, there is one store, and a laptop under the floor needs the key. But `CloudSettingsView.hosted` (`shared/slots.ts:437`) is **computed by main and read by nobody**, and the card's own header (`cloud-card:41-46`) still claims *"the card draws read-only and main refuses the write"* — a paragraph describing a behaviour that was deliberately reversed. Two stale facts about one door. |

### B.7 Environments

`app/src/app/pages/settings/env-card.component.ts`.

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card title **"Environments"** + **Re-check** | `env-card:44-48` | | `env:catalog` | KEEP | The card stays even though the wizard step goes (A.6): this is where somebody who wants the analysis worker, or a different location, comes. |
| Detail: *"…Anything missing is fetched automatically at startup — it appears in the shelf"* | `:49-53` | says the app provisions itself | | KEEP | This sentence is the reason the wizard step is redundant, and it is already here. |
| *"There is no prebuilt environment for this platform."* | `:55-57` | the empty case | `targetsForPlatform` | REWORD | Same Linux defect as A.6: on Linux this is drawn and is not the truth. It should say what a Linux machine has to do instead (a system PyMuPDF, named in `backend.python`). |
| Row: label, dot, badges (**not yet published** / **in use**) | `:60-69` | state | `EnvCatalogItem` | KEEP | |
| Row: purpose, python version, packages, size, parts | `:71-76` | what it buys, before asking | | KEEP | |
| Row: `item.detail` | `:77` | where it is and whether it matches settings | | KEEP | |
| *"The release has no sha256… Install stays disabled rather than fetching it unchecked."* | `:79-84` | the null-hash refusal | `isPublished` | DELETE-AFTER — **`nli-mac-arm64` published, or the entry dropped** | The rule is right and permanent; what is wrong is that one entry has sat in this state since 2026-08-26, so on every Apple-silicon Mac this card draws a row that exists only to refuse. |
| Row: **Destination** field + **Browse…** | `:86-95`, `env:choose-dest`, `destOf/setDest` `:278-289` | install somewhere other than the default | `EnvInstallRequest.dest` | RULING | **Does anybody move a Python environment?** It is one of two reasons the card exists (its own header says so at `:22-24`), it is not remembered between visits, and a non-default destination is not written into settings for `nli` roles — so the engine finds it only if it happens to be on `defaultNliPythonCandidates()`. A destination picker that can silently produce an environment the engine cannot find is worse than no picker. |
| Row: **Install / Reinstall / Try again** | `:112-133`, `install()` `:316-324`, `env:install` | queues the download | | KEEP | |
| Row: progress bar, phase word, **Cancel** | `:98-110`, `env:install-progress` + the queue | the event animates, the queue adjudicates | | KEEP | Correctly split, and the indeterminate bar refuses to invent a percentage. |
| *"Installed, but settings point somewhere else."* | `:129-131` | | `EnvCatalogItem.configured` | KEEP | The sentence that catches exactly the failure the destination picker can cause. |

### B.8 Page reader (local)

`app/src/app/pages/settings/page-reader-card.component.ts`.

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card title **"Page reader (local)"** + Installed pill | `page-reader-card:45-52` | | `PageReaderState.installed` | REWORD | *"(local)"* is a distinction that only means something if you already know there is a non-local one. "Page reader" is enough; the `supersededBy` line already says when an engine has taken it over. |
| `platformNote` | `:55` | which build this machine gets | | KEEP | |
| Unsupported warning | `:57-58` | no llama.cpp build here | `buildFor()` `page-reader.ts:484-511` | KEEP | |
| `detail` | `:60` | what is present, what is missing | | KEEP | |
| `supersededBy` sentence | `:71-77` | a LOCAL engine is reading pages, so this copy is not needed | `pageReaderSuperseded()` (gated on `CRUCIBLE_READS`) | KEEP | SLOTS.md §5b built exactly, including the honest half: while `CRUCIBLE_READS` is false this is null and the Install button stays on. |
| File list — `llama-server` + the two GGUF, with sizes | `:80-98` | what "installed" actually means | `PageReaderState.binary/models` | KEEP | *"Installed" with nothing behind it is what a person has to take on trust.* |
| **Download it (`<size>`)** | `:102-112`, `install()` `:275-292` | `page-reader:install` | | KEEP | §F.1. |
| **Cancel** | `:113-115` | keeps what was fetched | | KEEP | |
| **Start** / **Stop** | `:116-123`, `start()` `:299-318`, `stop()` `:320-324` | pre-warm; Stop disabled for a server we did not start | `page-reader:start/stop` | RULING | **Does a person ever start a page reader by hand?** The queue starts it when a reading job runs and stops it on the keep-warm timer; the only use is pre-warming so the first book of an evening does not pay the load. If that is not a thing Owen wants on the screen, two buttons and the server status block below them go with it. |
| **Check again** | `:124`, `refresh()` `:253-258` | re-measures the directory | | KEEP | |
| Progress bar + item | `:127-134`, `page-reader:progress` | per-file | | KEEP | |
| Server status row + **not ours** badge + URL + model | `:137-143`, `status` `:233-235` | live from `page-reader:status-changed` | | KEEP (unless Start/Stop go) | A server this app merely adopted is named as such — the fact that stops somebody killing work they were in the middle of. |
| Log tail `<pre>` | `:144` | the server's own words on a failure | `ServerStatus.detail` | KEEP | The only thing that says why. |
| **Keep warm for** N minutes | `:146-152`, `saveKeepWarm()` `:326-331` | `AppSettings.keepServerWarmMinutes`, clamped 0-240 | `job-queue.ts:1578,3843` | KEEP | App policy, not engine settings; the queue reads it at every drain so a change applies to the next one. |
| Stale comment: *"PACKAGE E GOES HERE: the offer to connect a Crucible server"* | `:156-162` | nothing | | **DELETE** | Package E landed on 2026-09-14. The marker points at work that is done, in a card that sits two cards below the thing it was marking a place for. |
| *No mention of `backend.endpointUrl`* | — | — | — | RULING (same as B.2) | This card downloads and serves a reader on port 8000 and never says that a reading job reaches it only when the engine's `mode` is `endpoint` and its URL points there. Two cards, one fact, no link between them. |

### B.9 Models on this machine

`app/src/app/pages/settings/machine-models-card.component.ts`.

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| Card title + total pill | `machine-models-card:60-65`, `total()` `:262-270` | every store added up, or *"size partly unknown"* | `models:inventory` | KEEP | §5b's *"duplication is seen rather than discovered from a full disk"*, and the only card in Settings that describes consequences rather than setting anything. |
| §5b offer block + **Remove Foundry's page reader (frees N)** | `:75-83`, `freeing()` `:254-259` | the REMOTE-engine case: an offer with a number | `RemovalOffer` | KEEP | *"A REMOTE Crucible removes nothing"* — the offer with its sentence *"page reading will then need `<server>` to be reachable"*. |
| §5b sentence with no button | `:84-94` | either nothing to remove, or this copy is still doing the work | | KEEP | A null server means removing is not a choice this screen may offer — the house rule, applied. |
| Store rows: Foundry's own / Ollama / a local engine | `:96-118`, `machineModels()` `machine-models.ts:86-151` | names, sizes, one detail each | | KEEP | |
| **Remove Foundry's downloads** (only on Foundry's store) | `:126-133`, `remove()` `:233-243`, `models:remove-page-reader` | deletes `pageReaderDir()` and nothing else | | KEEP | One owner per store; Ollama has no button by rule. |
| Removal outcome sentence | `:137` | main's words, with the number in them | `RemovalOutcome.detail` | KEEP | The card does not compose "freed 0 GB" over an unmeasurable directory. |
| *"Catalog: `<generatedBy>` · `<generatedAt>`"* | `:139`, `LINEUP_PROVENANCE` `llm-catalog.ts:245-251` | which Crucible commit the lineup came from | | KEEP | This is how the §F.3 defect will eventually be caught by a person rather than by an audit. |
| `models:changed` subscription | `:205-212` | re-reads when §5b's automatic removal fires | | KEEP | Without it the card lists four gigabytes that are not there. |

**Section B: 124 rows** — KEEP 90, REWORD 12, DELETE 5, DELETE-AFTER 7, RULING 10.

---

## C. `AppSettings` — every field in `app/electron/app-settings.ts`

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| `keepServerWarmMinutes` | `:125`, clamp `:403-406` | minutes an app-started page reader outlives a drained queue | `ipc.ts:3101`, `job-queue.ts:1578,3843` | KEEP | The ceiling exists so "never indefinite" is true by construction. |
| `libraryDir` | `:140`, clamp `:416-421`, host override `:742` | the shelf | `projectsDir`, the Save pickers, `library:dir` | KEEP | The override at the SETTING rather than at each reader is right and is argued at `:424-445`. |
| `analysisCategories` | `:161`, clamp `:473-495` | the user's own analysis categories | `analysis:read/write-categories`, `workspace:plan-analysis` | KEEP | App-level because they are the reader's, not one project's. Not on the settings screen at all — edited in the analysis dialog — which is correct and worth not "fixing". |
| `defaultLlmModel` | `:180`, clamp `:507-512` | seeds Translate / Simplify / Analyse | `llm:defaults` via `openingModelFor` | KEEP | |
| `cleanTextModel` | `:199` | seeds Clean text; **BookForge's own door reads the same key** | `llm:defaults`, `narration-clean-text.ts` in the host | KEEP | One file, two doors, one model — the property the design exists to keep. |
| `ollamaUrl` | `:208`, clamp `:711-722` | where Ollama is | `probeOllama` everywhere, `llm:stored` | RULING | Written by `llm:set-ollama-url` (`ipc.ts:3291`), which **no renderer calls**. Draw the field or retire the door. |
| `crucibleServers` (`CrucibleServerEntry[]`, array position IS the rank) | `:255`, type `:54-63`, clamp `:559-580` | the engine registry; token never leaves main | `crucible-registry.ts`, dispatch, slots | KEEP | The single best-argued structure in this file. No `rank` field, deliberately. |
| `cloudProviders` (`CloudProviderEntry[]`, order is NOT a rank) | `:276`, type `:87-105`, clamp `:608-634` | the keys; never leaves main | `cloud-providers.ts`, slots, `act-gates` | KEEP | The difference from the array above is stated rather than left to be found. |
| `newJobsWaitFor` | `:287`, clamp `:517-519` | what a new row's `waitFor` starts as | `waitForOfNewJob()` | KEEP (the field) | The *control* is B.5's REWORD; the field is fine. |
| `wslDistro` | `:303`, clamp `:530-535` | which guest to `cat` config.toml in | `crucible-registry.ts:707` only | RULING | See B.5, door 2. One reader, one purpose, and the purpose disappears the day a connect code exists. |
| `setupCompleted` | `:319` | wizard finished OR dismissed | `setup:state` | KEEP | An explicit marker rather than "does the file exist" — the argument at `:304-318` is correct. |
| `setupSkipped` | `:329`, clamp `:725-736` | which steps were declined | `llm-card:112` | KEEP | Free-form strings so renaming a step is not a migration. **After this pass the stored ids `envs` and any deleted step become stale entries** — harmless by design, and worth checking that the reader still reads them as such. |
| `pageReaderRemoved` (`PageReaderRemoval \| null`) | `:346`, type `:358-363`, clamp `:766-777` | the receipt for §5b's automatic deletion | `machine-models.ts:94,188`, torn up by `page-reader:install` | KEEP | A receipt, not a flag — the disk is measured every time. |
| **Retired:** `llmServer` | named at `:236-240`, never read | — | nobody | KEEP (the comment) | The migration IS the deletion, and the paragraph explaining why is the only thing stopping somebody re-adding it. |
| **Retired:** `vllmUrl` | `:241-247` | — | nobody | KEEP (the comment) | *"A stored `vllmUrl` becomes NOTHING"* — Owen's ruling, argued, not laziness. |
| **Retired:** `vllmModel` | `:247-249` | — | nobody | KEEP (the comment) | |
| `CRUCIBLE_SERVER_MAX = 8` | `:66` | ceiling | `clampCrucibleServers` | KEEP | |
| `CLOUD_PROVIDER_MAX = 4` | `:112` | ceiling | `clampCloudProviders` | KEEP | |
| `KEEP_WARM_MAX_MINUTES = 240` | `:365` | ceiling | `clampKeepWarm` | KEEP | |
| `CUSTOM_CATEGORY_MAX = 40` | `:368` | ceiling | `clampAnalysisCategories` | KEEP | |

**Section C: 19 rows** — KEEP 17, RULING 2.

---

## D. The engine's `settings.json`, as this screen edits it

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| `backend.mode` | `shared/types.ts:1693`, form `settings-page:118-125` | auto / endpoint / mlx, machine-global | the engine every run; `act-gates.ts:329` | RULING | See B.2. It is the second owner of "where does a read go", beside slots. |
| `backend.endpointUrl` | `types.ts:1694`, form `:127-131` | where an `endpoint`-mode read goes | the engine; `isLocalPageReader()` | RULING | See B.2 and B.8. |
| `backend.python` | `types.ts:1695`, form `:133-137` | the rasteriser interpreter | the engine; `env-install.ts` writes it for `read`-role installs | KEEP | §F.2 — not a model, and the one setting on this screen a Linux user must have. |
| `backend.endpointModel` | not in `BackendSettingsPatch`; preserved on write (`settings.ts:9-19`) | the served id | the engine | KEEP | Preserving a key a newer engine reads is what makes going back a checkout rather than a restore. |
| **Retired:** `backend.wslDistro` | `types.ts:1697-1706`; preserved, never read | — | an older engine | KEEP | Not deleted from anybody's file, deliberately. |
| **Retired:** `backend.vllmPython` | same | — | an older engine | KEEP | |

**Section D: 6 rows** — KEEP 4, RULING 2.

---

## E. The IPC doors behind all of it

Counted from `app/electron/ipc.ts`. Only the families this audit covers.

| item | where it lives | what it does | who reads it | disposition | why |
|---|---|---|---|---|---|
| `setup:state` | `ipc.ts:3152` | completed + skipped | wizard, llm-card | KEEP | |
| `setup:finish` | `:3153` | records the end, however it was left | | KEEP | |
| `system:probe` | `:3156` | the machine, cached, force flag | wizard, install plan, gates, `llm:defaults` | KEEP | |
| `doctor:run` | `:3021` | the engine's own report | settings page, startup provisioner | KEEP | |
| `engine:info` | `:3020` | which binary | settings page | KEEP | |
| `settings:read` | `:3023` | the engine's file | settings page | KEEP | |
| `settings:write` | `:3037-3045` | three keys, preserves the rest, refuses hosted | | KEEP | |
| `library:dir` | `:2821` | the effective library | everywhere | KEEP | |
| `library:set` | `:2822` | refuses hosted | | KEEP | |
| `library:choose` | `:2826` | picker, refuses hosted | | KEEP | |
| `llm:stored` | `:3214` | the tags as stored, for the editor | llm-card | KEEP | Separate from `llm:defaults` on purpose — an editor seeded from a resolved answer writes the resolution back on the first Save. |
| `llm:defaults` | `:3222` | what a dialog opens with, resolved per class | four dialogs | KEEP | |
| `llm:set-model` | `:3266` | | | KEEP | |
| `llm:set-clean-model` | `:3268` | | | KEEP | |
| `llm:ollama-url` | `:3289` | reads the URL | **nobody** (llm-card reads it off `llm:stored`) | RULING | Two doors answering one field; one of them has no caller. |
| `llm:set-ollama-url` | `:3291` | writes it | **nobody** | RULING | See C/`ollamaUrl`. |
| `ollama:facts` | `:3158` | running? installed at all? | | KEEP | |
| `ollama:choices` | `:3159` → `llmChoices()` `setup.ts:84-101` | the whole model step in one read | wizard | KEEP | |
| `ollama:install` | `:3174` | fetch + hand over the installer | wizard | KEEP (subject to A.4's ruling) | `ok` means it was OPENED, never that Ollama is installed. |
| `ollama:install-cancel` | `:3176` | | | KEEP | |
| `ollama:pull` | `:3177` | streamed pull, fires `acts:gates-changed` | wizard | KEEP | |
| `ollama:pull-cancel` | `:3189` | | | KEEP | |
| `ollama:progress` (push) | `broadcast` | installer download AND model pull, one shape | wizard | KEEP | |
| `page-reader:state` | `:3100` | everything the card and the step need, one read | card, wizard | KEEP | |
| `page-reader:install` | `:3109` | fetch + verify + unpack; tears up the §5b receipt | | KEEP | |
| `page-reader:install-cancel` | `:3129` | keeps what was fetched | | KEEP | |
| `page-reader:start` | `:3132` | pre-warm, or adopt | card | RULING | With B.8's Start/Stop. |
| `page-reader:stop` | `:3133` | only if we started it | card | RULING | With B.8's Start/Stop. |
| `page-reader:set-keep-warm` | `:3138` | app policy, not engine settings | card | KEEP | |
| `page-reader:progress` / `:status-changed` (pushes) | | | card, wizard | KEEP | |
| `env:catalog` | `:3064` | what this machine could install | card, wizard | KEEP | |
| `env:install` | `:3070` | queued, never awaited across IPC | card, wizard | KEEP | |
| `env:cancel` | `:3074` | through the queue, so it settles as `cancelled` | card | KEEP | |
| `env:choose-dest` | `:3076` | the destination picker | card | RULING | With B.7's destination field. |
| `env:install-progress` (push) | | the bar | card, wizard | KEEP | |
| `crucible:settings` | `:3305` | registry + slots + newJobsWaitFor + wslDistro + hosted, one read | card, doors, wizard | KEEP | |
| `crucible:save` | `:3306` | whole registry, refuses hosted, runs `afterRegistryChanged` | card | KEEP | |
| `crucible:test` | `:3317` | `client.info()` on a stored row | card | KEEP | |
| `crucible:open` | `:3334` → `crucible-ui.ts:76` | the server's own console, sandboxed, token never in the renderer | card | KEEP | **The most important door in this audit.** Every DELETE in B.5 is paid for by this one existing. |
| `crucible:test-at` | `:3335` | probe an unsaved address | doors | KEEP | |
| `crucible:add` | `:3344` | one server, the registry's one writer | doors | KEEP | |
| `crucible:add-local` | `:3349` | reads config.toml through `wsl.exe` | doors | KEEP (subject to B.5's WSL ruling) | |
| `crucible:set-wsl-distro` | `:3377` | | doors | RULING | With `AppSettings.wslDistro`. |
| `crucible:set-new-jobs-wait-for` | `:3379` | | card | KEEP | |
| `crucible:install-plan` | `:3361` → `crucibleInstallPlan()` | the hand sequence; spawns `wsl.exe -l -v` | door 3 | DELETE-AFTER — with door 3 | Keep only whatever carries the "no build for this platform" sentence. |
| `crucible:install` | `:3372` → rejects always | nothing | door 3 | **DELETE** | A door that can only refuse, behind a button that can only refuse. Its own comment says a disabled control over an open door is a decoration — the honest fix is now to close both. |
| `cloud:settings` | `:3398` | providers + slots + hosted | card | KEEP | |
| `cloud:save` | `:3399` | whole list; **does not refuse hosted**, by ruling | card | KEEP | |
| `cloud:test` | `:3430` | unbilled listing | card | KEEP | |
| `slots:list` | `:3449` | `SlotAvailability` — the list, or the reason there is none | queue view, cards | KEEP | |
| `slots:rows-waiting-for` | `:3454` | rows naming one slot | (the card derives its own) | KEEP | |
| `acts:gates` | `:3471` | five acts, one probe | the dock | KEEP | |
| `acts:gates-changed` (push) | `gatesChanged()` `:539-541` | no payload | the dock | KEEP | |
| `models:inventory` | `:3483` | every store, measured | card | KEEP | |
| `models:remove-page-reader` | `:3484` | the one door that deletes model files | card | KEEP | |
| `models:changed` (push) | | §5b's automatic removal | card | KEEP | |

**Section E: 56 rows** — KEEP 48, DELETE 1, DELETE-AFTER 1, RULING 6.

---

## F. The three things that were on the table, argued

### F.1 The local page reader — KEEP, and it is not close

`app/electron/page-reader.ts` (1602 lines) downloads a llama.cpp build for this
machine and the dots.ocr GGUF pair the catalog names, verifies both against
published sha256, and serves them on port 8000.

**What breaks if it goes.** Everything. Reading a page is the one act with **no
Ollama path** — Ollama does not serve dots.ocr — and the engine's own tiers are
`endpoint`, `wsl-vllm`, `mlx`, `native`. On the machine SLOTS.md §1 names, a
Windows box whose owner cannot install WSL: `wsl-vllm` is out by definition,
`mlx` is a Mac, `native` is not a VLM, and `endpoint` is precisely this reader.
Deleting it means a dropped PDF produces nothing at all on the exact machine the
product exists for. There is no version of "the engine owns it now" that reaches
this file, because the whole premise is a person with no engine.

Two things about it are still **unmeasured** and SETUP.md §7 says so out loud:
whether the Q8_0 GGUF answers in the layout dialect `src/vlm/dots.ts` parses,
and seconds per page on CPU and on a small card. Neither changes the
disposition; both change how confident anybody should be that the friend's path
works at all. **Read one page and look at the JSON before reading three
hundred.**

What *can* go with the engine is the day `CRUCIBLE_READS` flips: a machine with a
local engine serving `pages` stops needing this copy, §5b deletes it with a
receipt, and the card says so. That machinery is built and inert, and it is
correct that it is inert — `job-queue.ts` starts the local reader *before* it
resolves a placement, so deleting on the strength of a capability record alone
would delete the thing still doing the work.

### F.2 The prebuilt Pythons — KEEP the rasteriser, DELETE the wizard step

`app/electron/env-catalog.ts` holds four entries. They are **not one kind of
thing** and the audit splits them:

| entry | role | what it is | disposition |
|---|---|---|---|
| `windows-x64` | `read` | python 3.12 + **PyMuPDF 1.28.0**, 62 MB | KEEP |
| `mac-arm64` | `read` | python 3.11 + mlx-vlm + PyMuPDF, 219 MB | KEEP |
| `nli-windows-x64` | `nli` | torch (CPU) + transformers + **DeBERTa weights baked in**, 528 MB | KEEP |
| `nli-mac-arm64` | `nli` | the same, **never built, sha256 null** | DELETE-AFTER — built, or the entry dropped |

**PyMuPDF is not a model and the engine does not own it.** *"Every tier
rasterises locally before anything reads"* (`env-provision.ts:74-78`): a page
becomes an image on **this** disk before it is sent anywhere, including to a
remote Crucible. So the rasteriser is on the friend's path exactly as the page
reader is, and it goes nowhere.

It also **already installs itself**. `decideProvisioning` queues it at startup
when `foundry doctor` says there is no PyMuPDF anywhere — which is why the
wizard's step is redundant for it, and why deleting that step (A.6) costs
nothing on Windows or Mac.

The analysis worker is the one genuine candidate for MOVE→ENGINE, and it cannot
move today: Foundry asks a Crucible for `llm` and nothing else
(`crucible-install.ts:216`), Crucible has no `nli` job type, and the worker is a
DeBERTa entailment pass rather than an LLM call. So it stays, behind the
Settings card, where somebody who wants analysis finds it.

**Two holes worth naming, neither of them this pass's to fill.** There is no
Linux entry at all, so a Linux machine is told *"nothing on this platform needs a
prebuilt Python"* and then cannot rasterise. And `nli-mac-arm64` has been a
refusal-shaped row since 2026-08-26.

### F.3 The floors, the tiles, and the model step — the defect this audit found

This is the one place where the documents and the data disagree, and it changes
what the wizard should say.

**The claim.** docs/SLOTS.md ("Package E — landed"), docs/SETUP.md §5 and
docs/PLAN.md (Package E) all state that Crucible's `qwen3.8-27b-4bit` row
declares `minimumFor: [translate, simplify, analysis]`, and each draws the
consequence out loud: *"analysis now floors at the 4-bit 27B and a 12 GB card
that used to light the Analysis tile does not."*

**The data.** `app/shared/model-lineup.json:64-68` declares
`"minimumFor": ["translate", "simplify"]`. No row in either lineup file names
`analysis` at all. `eligibleFor('analysis')` (`llm-catalog.ts:384-388`) therefore
finds no floor and returns the whole list. **Analysis has no floor and the
Analysis tile lights on a 0.8B.** Three documents say otherwise.

**What follows on a real machine — a 12 GB card, which is an ordinary card:**

- translate/simplify floor = `qwen3.5:27b`, 18.5 GB → nothing fits → both dark,
  with `OTHER_ROUTES` naming the engine and the cloud key. Correct.
- analysis → no floor → the 9B fits and is installed → lit. Whether that is
  right is a product question nobody has answered; what is certain is that it is
  not what the plan of record says is happening.
- clean → no floor, but the cleanup's default model `qwen3.5:9b-q8_0` is a
  `clean`-class row, so **it is not in the wizard's list and nothing in the app
  offers to pull it**.
- the wizard recommends the largest that fits — the 9B — and then prints
  *"Translation, simplification and analysis will start from qwen3.5:9b"*
  (`setup-wizard:980`) directly under a warning saying translation will not run.

So the Ollama step's honest sentence on such a machine is not *"here is your
model"* but *"this card can run the analysis pass and the narration cleanup; for
translation and simplification you need a GPU engine or a key."* That is a
REWORD, not a deletion — but it is the difference between a step that describes
the machine and one that oversells it.

**`LineupRow.minimum`** (`model-lineup.json:64`, `model-lineup-local.json`) is
read by nothing; `llm-catalog.ts` says so in as many words. It is the same fact
as `minimumFor.length > 0` and a boolean cannot say which class.

---

## G. The words

The agreed people-words are **"GPU engine (Crucible)"** on first mention,
**"connect code"** for a pairing line, **"Open engine console"** for the page.
Every occurrence on a surface a person reads:

| surface | says today | should say |
|---|---|---|
| Wizard step 4 title | *"Crucible (optional)"* | *"GPU engine (optional)"* |
| Wizard step 4 blurb | *"…how a second machine, or a faster path on this one, gets used."* | keep; it is already product language |
| Wizard step 4 lead | *"Crucible is a separate program that serves models over the network"* | *"A GPU engine (Crucible) is a separate program…"* — one mention, then "engine" |
| Wizard translate-floor warning | *"connect a Crucible server or a cloud provider in Settings"* | *"connect a GPU engine or a cloud key in Settings"* |
| Settings card title | *"Servers"* | *"GPU engines"* |
| Servers card detail | *"Crucible servers this machine can send… to"* | *"GPU engines this computer can send work to"* |
| Servers row button | *"Open"* | **"Open engine console"** |
| Door 1 | *"Connect to a Crucible server"* | *"Connect to a GPU engine"* |
| Door 1 token placeholder | *"crucible token --show, on that machine"* | a **connect code** field, once `parsePairing` exists (RULING 6) |
| Door 2 | *"Use the Crucible on this machine"* | *"Use the GPU engine on this computer"* |
| Door 3 | *"Install Crucible here"* + 8 commands | one paragraph + the README link |
| `act-gates.ts:105` `OTHER_ROUTES` | *"Settings › Servers (a Crucible server) or Settings › Cloud providers (an OpenAI or Claude key)"* | *"Settings › GPU engines, or Settings › Cloud providers"* |
| `act-gates.ts:95` `SETTINGS_PATH` | *"Settings › Language model"* — for an action that card cannot perform | see RULING 2 |
| Page reader card title | *"Page reader (local)"* | *"Page reader"* |
| Settings page title | *"Backend"* | *"Settings"* |

---

## H. What this should become

### H.1 THE WIZARD AFTER THE PASS

Foundry differs from BookForge in one way that decides the shape: **it must work
with no engine at all**, so a step that assumes one is wrong, and the engine step
cannot be a requirement, cannot be early, and cannot be the place the app's
capability is established. Five steps, down from seven:

1. **Welcome.** What the app does, and the promise that nothing downloads until
   you press the button that downloads it.
   *Engine present:* one extra line — *"A GPU engine is already connected; the
   next two screens are shorter."*
   *Engine absent:* unchanged.

2. **Your library.** The folder. Unchanged, first, free.
   *Same either way* — the library is never the engine's.

3. **This computer.** The merged model step: the hardware sentence, Ollama's
   state, the lineup, and — this is the change — **what this machine can and
   cannot do, per act, before any download**. It is `act-gates` rendered as prose
   with the two routes off the machine named.
   *Engine absent:* the Ollama install handoff, the lineup, the pull button, and
   the honest sentence about which acts the chosen tag serves here.
   *Engine present and serving the class:* the rows still list (describing the
   machine is the step's job) with the download buttons off and the engine named
   — which is exactly what `LlmChoices.crucible` already does.

4. **A GPU engine (optional).** Doors 1 and 2 only, plus the one sentence about
   platforms with no build, plus a link to Crucible's own install docs.
   *Engine absent:* two doors and a link. The blurb keeps *"most people should
   skip this."*
   *Engine present:* the doors collapse to the registered list and **one button,
   "Open engine console"** — the thing SLOTS.md §7 asked for and that already
   exists in Settings.

5. **The page reader.** Unchanged, and now the only download the wizard asks
   for.
   *Engine absent:* the size, the button, the progress.
   *Engine present and serving `pages` locally:* the `supersededBy` sentence and
   no button — already built, already correct, waiting on `CRUCIBLE_READS`.

**Ready** stays as the closing page (it is not a step; nothing on it can be
skipped).

**Gone:** the Python environments step (A.6 — the rasteriser installs itself,
the analysis worker is one optional card in Settings, and the Mac half does not
exist).

**Where the WSL sentence lands.** Deleting door 3 deletes the only place Foundry
says a Windows user needs WSL. It moves into step 4's platform sentence: *"On
Windows the engine runs inside WSL, which Crucible's own installer sets up."*
One sentence, no commands.

### H.2 THE SETTINGS AFTER THE PASS

Nine sections, in this order, right column; the left column (the doctor
measurement) is unchanged:

1. **Library location** — hidden hosted. Unchanged.
2. **Models on this computer** (today's *Language model*) — the default tag, the
   cleanup tag, the Ollama address as an editable field or not at all (RULING 3),
   a way to pull a model or a sentence that points at the wizard (RULING 2), and
   "Run first-run setup again".
3. **GPU engines** (today's *Servers*) — the list, the ranking, the enable
   switch, **Open engine console** per row, and doors 1 and 2. No hand-added
   rows, no install sequence, no "Install it for me".
4. **Cloud providers** — unchanged, and drawn hosted with live controls as ruled.
5. **Page reader** — unchanged but for the title and the stale marker comment,
   and with whatever B.8's Start/Stop ruling decides.
6. **Environments** — unchanged; it absorbs the deleted wizard step's job.
7. **Models on this machine** — unchanged. Last, because it describes the
   consequences of everything above it.
8. **settings.json** — hidden hosted, and pending RULING 4 on whether `mode` and
   `endpointUrl` still belong to a person.

That is a reduction of one section only, which is the honest answer: unlike
BookForge, almost nothing in Foundry's Settings is an engine download. The
reduction this pass really buys is **inside** section 3 — a card that was
teaching somebody how to install and administer another program becomes a card
that lists engines and opens their consoles.

### H.3 THE RULINGS

Twenty-three rows above carry RULING; several of them are the same question
asked on different surfaces, so they collapse to eleven. Every RULING row is
covered by one of these, and the row references say which.

1. **The Ollama installer handoff.** On a machine under the translate floor,
   installing Ollama lights no tile that matters. Keep *"Download the ollama
   installer"* in the wizard for everyone — or draw it only when the machine can
   hold a model that serves an act, and otherwise send people straight to the
   engine/key step? *(A.4)*
2. **Where does a person pull a model?** Every dark tile says *"pull one from
   Settings › Language model"* and that card has no pull. Add a pull control to
   the Settings card — or change the sentence to name the first-run wizard?
   *(B.4, act-gates.ts:95)*
3. **The Ollama address.** `llm:ollama-url` / `llm:set-ollama-url` have no
   caller. Draw an editable Ollama address field on the Models card — or delete
   both doors and leave the URL to `app-settings.json`? *(B.4, C, E)*
4. **`backend.mode` and `backend.endpointUrl`.** With slots deciding where each
   job runs, do these two stay a person's setting on this screen — or become
   derived (auto unless the local page reader is installed, in which case
   endpoint at its own URL) and drop out of the form? *(B.2, B.8, D)*
5. **The analysis floor.** The plan of record says analysis floors at the 4-bit
   27B; the vendored catalog gives it no floor at all. Is the catalog right (no
   floor — a small model does analysis a sentence at a time) or are the documents
   right (27B), and is the fix a re-vendor from Crucible or a correction to three
   docs? *(F.3)*
6. **Token or connect code.** Does door 1 keep three fields (name, address,
   token) — or become one **connect code** field the moment `parsePairing` ships
   in `@crucible/client` 0.6.0, with the Servers row's token box going with it?
   *(B.5)*
7. **The WSL distro field.** Keep it (it is the only way to read a local
   engine's config.toml today) — or delete door 2 entirely and make "the engine
   on this machine" just another connect code pasted from its console? *(B.5, C)*
8. **The page reader's Start/Stop.** Does anybody pre-warm a page reader by
   hand? Keep the two buttons and the server status block — or delete them and
   let the queue own the server's whole life? *(B.8, E)*
9. **The environment destination picker.** Does anybody install a Python
   somewhere other than the default? Keep Browse… — or delete it, given that a
   non-default `nli` destination produces an environment the engine may not find?
   *(B.7, E)*
10. **The cleanup model.** Nothing in the app offers to pull `qwen3.5:9b-q8_0`.
    Add the `clean`-class rows to the wizard's list — or leave Clean text as a
    hosted-only act whose model is the host's problem? *(A.4, F.3)*
11. **"Open engine console" in the wizard.** `crucible:open` is wired only to
    the Servers card. Does the wizard's engine step grow the same button once a
    server is registered — or does administering an engine stay a Settings
    errand, so the wizard only ever connects? *(A.5)*

### H.4 WHAT BREAKS IF WE ARE WRONG

**1. DELETE the wizard's Python-environments step (A.6).** Least sure of the
three. The argument is that the rasteriser auto-installs and the analysis worker
is optional — but `decideProvisioning` only fires when `foundry doctor` runs and
answers, and it deliberately provisions the Mac archive **only when BOTH mlx and
the rasteriser are missing** (`env-provision.ts:98-100`). A Mac with a working
MLX and no PyMuPDF is auto-provisioned nothing, and after this deletion has no
wizard step either — it would meet the problem as a failed conversion, which is
precisely the failure SETUP.md §1 was written to end.
*Evidence that would settle it:* run a fresh install on (a) a Windows box with no
Python, (b) a Mac with mlx-vlm present and PyMuPDF absent, and check the shelf at
startup. If (b) provisions nothing, this becomes REWORD (fix the rule) rather
than DELETE (remove the step).

**2. DELETE-AFTER door 3's numbered install sequence (B.5).** The ruling behind
it is Owen's and is already written down, so the direction is not in doubt — the
*timing* is. `@crucible/client` 0.6.0 is not published, `@crucible/bootstrap` is
not a dependency, and `crucible:open` only works for a server that is **already
registered**. So between deleting door 3 and Crucible shipping a reachable
installer there is a window where Foundry says "install it elsewhere" and points
at a README. That may be exactly right, or it may be the app losing its only
on-ramp for a whole wave.
*Evidence that would settle it:* Crucible's published installer and whether its
console is reachable before pairing. If a person can get from "no engine" to "a
connect code" using only Crucible's own artefacts, delete door 3 today; if not,
keep the elevated-commands block until they can.

**3. KEEP the Cloud card's hosted behaviour while DELETING
`CloudSettingsView.hosted` (B.6).** The behaviour is a deliberate 2026-09-14
reversal and I am confident about it. What I am not confident about is that the
field is genuinely dead rather than *about to be needed*: BookForge vendors this
app, and a host that later wants the card read-only would want exactly this flag.
Deleting it is a one-line save that could cost a round trip through the vendoring
process.
*Evidence that would settle it:* ask BookForge whether any hosted surface reads
or intends to read `CloudSettingsView.hosted`. If the answer is no, delete it and
fix the card's stale header; if yes, keep the field and make the card *use* it.

---

## I. Tally

| section | rows | KEEP | REWORD | MOVE→ENGINE | DELETE | DELETE-AFTER | RULING |
|---|---|---|---|---|---|---|---|
| A — the wizard | 56 | 36 | 9 | 0 | 7 | 1 | 3 |
| B — settings | 124 | 90 | 12 | 0 | 5 | 7 | 10 |
| C — `AppSettings` | 19 | 17 | 0 | 0 | 0 | 0 | 2 |
| D — `settings.json` | 6 | 4 | 0 | 0 | 0 | 0 | 2 |
| E — IPC doors | 56 | 48 | 0 | 0 | 1 | 1 | 6 |
| **total** | **261** | **195** | **21** | **0** | **13** | **9** | **23** |

Counted by script over this file's own tables, not from memory — this repo's
standing rule about a figure quoted as a gate (docs/IPC-CHANNELS.md, three
times). The RULING rows collapse to the eleven questions in §H.3.

**MOVE→ENGINE is zero, and that is the finding.** Foundry's settings screen
contains almost nothing the Crucible console could own, because almost nothing on
it is about an engine: it is a library folder, a rasteriser, a page reader, an
Ollama, a registry and a set of keys. What the engine takes over is not a
*setting* but a *lesson* — eight install commands, a model-pull list and a
platform prerequisite — and that is a block of teaching material inside one door,
not a section of the screen. The wizard shrinks by one step because a download
already installs itself; the settings screen shrinks by one section because the
engine's console replaces a document. The rest of both screens is the friend's
path to an EPUB, and it stays.
