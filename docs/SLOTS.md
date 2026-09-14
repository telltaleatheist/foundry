# Slots — how Foundry uses a GPU, and how Crucible fits (Owen, 2026-09-13/14)

> The plan of record for the compute story after the 2026-09-13 reframe. It
> supersedes the "one door, Crucible is mandatory" reading built earlier that
> night (docs/PLAN.md Wave 60), which Owen reversed in his own words: *"foundry
> should be prepared to operate without crucible present. it should do
> translation through ollama, simplify, analyze, VLM pdf conversion, all of it
> — but it should go through the normal doors accessible on windows or mac. if
> we want the speed tricks, we can connect to a crucible server."*

## 1. The vision, in Owen's words

- *"foundry should work if they have no idea what theyre doing and they just
  want to convert PDFs to EPUB. but if they do know what theyre doing and they
  want access to speed, they can use crucible."*
- *"the plan is to leave VLLM to crucible only"* — the app's own vLLM-in-WSL
  launcher is deleted; all WSL complexity lives in Crucible.
- *"bookforge requires crucible. it doesnt have an ollama fallback like foundry
  will… no local fallbacks necessary in the vendored version of foundry."*
- *"ollama should always, always bring down the model as soon as the job is
  done. they arent chatting with it, theyre using it for a job."*
- *"jobs never start on one slot and finish on another. its atomic."*
- *"the friend sees a single gpu slot if theyre local — their GPU slot. if
  theyre using crucible on their local machine, the local GPU disappears… or
  they can add a remote crucible server, like to the mac… itll show the mac's
  gpu slot as open and usable, plus their local GPU."*
- Tiles: *"if their system just isnt powerful enough for translation (smaller
  than 9b) then translation and simplify is disabled. the tiles arent lit up
  until the models are present."* And: *"if a job is going to take an
  obscenely long time, like translation on cpu, it should just be disabled."*
- Cloud: *"give them the option of connecting an api key for openai or claude
  instead of using the 27b or the 9b… for weaker systems."*

## 2. The doors (engine)

Three dialects, **declared, never sniffed from the URL**:

| `--server` | who is on the other end | model | window | end of run |
|---|---|---|---|---|
| `openai` (default) | Crucible, a local llama-server, vLLM, or a cloud provider — anything OpenAI-compatible | absent = the served model; a given name is proved | the server's, read back as `max_model_len`; a request that cannot fit is refused by name before it is sent | **nothing** — the engine never loads or unloads on this door |
| `ollama` | the friend's local Ollama | **required** (an Ollama holds a library; the app's picker names it) | `num_ctx` pinned once a book | **unloaded, always** (`keep_alive: 0`); no flag to keep it |
| `anthropic` | Anthropic's API, or a proxy that speaks it | **required** (a provider holds a catalog); checked against `GET /v1/models`, and a listing that does not answer skips the check OUT LOUD | the provider's — nothing read back, nothing pinned | **nothing** |

Everything else is dialect-agnostic and stays: the prompts, temperature, the
validators, the bank/records/stamp keyed by the served model id, the act
naming (`translate:` / `simplify:`), the header map (`FOUNDRY_ENDPOINT_HEADERS`).
Cloud OpenAI is the `openai` door plus a credential in the header map. Anthropic
is a third dialect and LANDED with Package F (§6): `POST /v1/messages`, a
top-level `system`, `x-api-key` through the header map with
`anthropic-version: 2023-06-01` added by the engine, a forced tool for a
constrained verdict, and `https://api.anthropic.com` when `--endpoint` is absent.
On both cloud doors a **429 is a wait, not a dead server** (§3): `retry-after`
honoured, else 2 s doubling to 30 s, six attempts, each wait logged; and each run
prints one line counting its requests and tokens, which the app prices.

## 3. Slots (app)

A **slot** is a place a job's compute can go. The queue lists one row per slot.

- **Local** — the machine's own GPU (or CPU). Text acts go to Ollama; page
  reading goes to a local llama-server serving dots.ocr (llama.cpp PR 17575,
  `ggml-org/dots.ocr-GGUF`), downloaded in setup, never shipped. On the Mac
  the MLX bridge remains a local reader.
- **A Crucible server** — one per registered server, in drag order; a
  loopback Crucible **replaces** the local slot (one card, one owner).
- **A cloud provider** — never busy, nothing resident, text acts only; a
  deliberate per-job choice, never something `any` falls through to.

Rules: a job is **atomic per slot**. `waitFor` on a row is a slot name or
`any`; `any` walks the enabled slots in priority order and takes the first that
will start the job, and never includes a cloud slot. A busy slot is waited
for, and the wait is rendered with the holder's name. Disabling a slot
surfaces the rows that name it. The vendored (BookForge-hosted) app takes its
slot list from the host and shows no local slot and no Ollama wizard.

## 4. The catalog

Crucible's manifests are the catalog of record. Each may carry a `[local]`
block naming the model's local form (an Ollama tag, or a GGUF + mmproj) with
a memory figure and its basis. A generator writes Foundry's lineup table
(`app/shared/model-lineup.json`, shape in the 2026-09-14 message to BookForge),
vendored into Foundry; a keeper compares by content. `minimum` on a row
carries the tile rule: translate/simplify do not light below it, and a
CPU-only machine does not light them at all.

## 5. Residency and eviction on a shared Crucible

The operator loads (the app, on the user's action, before spawning the engine);
a load evicts; one model is resident at a time; the engine refuses by name on
`model_not_resident` and never loads. A chat holds no lane, so a second
client's load can evict a running job's model mid-book. **Proposed by
BookForge, ruling owed to Owen:** an explicit lease on the resident model
(`POST /v1/models/{id}/lease`, heartbeat, `DELETE` at run end); while leased,
load/unload refuse `409 model_leased` naming the client, act and since.

## 5b. Weights on disk — one owner per capability per machine (Owen, 2026-09-14)

Owen: *"id really rather not have multiple copies of gigantic models floating
around… the models cant cross the wsl barrier right?"* They can, but it does
not help: Ollama holds its own quantised GGUF blobs, Crucible on WSL holds
safetensors for vLLM, Crucible on the Mac holds MLX weights. The 27B in each
store is a different file. So the rule is ownership, not sharing:

- **Nothing ships weights.** dots, the 9B, the 27B are downloaded from their
  official homes on install (the dots GGUF from ggml-org on Hugging Face,
  Ollama tags through Ollama's library, Crucible's through its manifests),
  verified against the source's published sha256 before use — the same
  discipline as the pinned environment tarballs on the `env-v1` release,
  where a null hash is a refusal to install.
- **Foundry deletes only what Foundry downloaded, only when a LOCAL Crucible
  has taken over that class** (its capability record lists the class as
  served — not merely "a server was configured"), and never silently: the
  settings row says what was removed and the gigabytes freed. Re-download
  restores it. Today that is the dots GGUF for the page reader.
- **A REMOTE Crucible removes nothing.** It takes nothing from this disk, and
  configured is not present — the local reader is what works when the Mac is
  asleep. The settings row OFFERS removal with a number on it and the sentence
  "page reading will then need <server> to be reachable".
- **Ollama is left alone.** It is its own model manager. The app never pulls
  into it while a local Crucible serves the class, and offers removal of the
  models it pulled before, by name and size, but never removes one itself.
- **A "Models on this machine" settings row** lists every store the app knows
  (Foundry's own downloads, Ollama's list, a local Crucible's residency) with
  sizes, so duplication is seen rather than discovered from a full disk.

## 6. Packages, and their order

| # | Package | Depends on | Status |
|---|---|---|---|
| A | Engine: `--server ollama` restored beside `openai`; unload always; `--model` required on Ollama; CTX pin for Ollama, `fitsWindow` for openai | nothing | **LANDED** (docs/PLAN.md, Wave 61) |
| B | App: delete `vllm-server.ts`; local page reader = llama-server + dots GGUF, downloaded in setup; reading jobs ensure it | nothing | building |
| C | App: server registry (name, url, headers), drag order, enable; slots; per-row `waitFor`; dispatch: header map per spawn, capability read for the model, `load-model` before spawn, the three 409s rendered by name | Crucible SDK shapes | **LANDED** (§7) |
| D | Catalog: generated lineup JSON, tile gating, CPU rule | BookForge's `[local]` block | **LANDED** (below) |
| E | Setup/settings: Crucible install offer + connect-to-existing; Ollama wizard stays; dots download; page-reader row | B, C | after C |
| F | Cloud slots: OpenAI (the `openai` door + key), Anthropic (third dialect); per-job opt-in; 429 as the wait; cost shown | C | **ENGINE HALF LANDED** 2026-09-14; app half after C |
| G | App: lane capacity derived from the slot list — one lane per compute slot, the bench one card per slot | C | **LANDED** (§7) |
| — | Lease client | **RULED 2026-09-14** — built in Package C, app-side | **LANDED** (§7) |

## 7. Package C — landed

`@crucible/client` 0.5.0 is pinned in `app/package.json` by its release tarball
URL, exactly as BookForge pins it. The word "crucible" appears in `app/` and in
these docs and **nowhere under `src/`**: the engine still speaks an OpenAI
dialect to whatever is at `--endpoint` and cannot tell one server from another.

**The registry** is `AppSettings.crucibleServers` — `{name, url, token,
enabled}[]`, in priority order, **array position IS the rank** (no rank field;
two owners of one ordering is how a drag and a walk start disagreeing). The
token is stored there and never leaves the main process: the renderer is told
`tokenSet: boolean` and may send a new one, and `token: null` on a save means
"keep what is stored". Settings → **Servers** card: drag to reorder, enable,
rename, Test connection (`client.info()`, and every failure keeps the SDK's own
sentence), and **Add the Crucible on this machine**, which reads that server's
own `<CRUCIBLE_HOME>/config.toml` — through `wsl.exe -d <distro> --exec bash -c`
on Windows, where the distro is `AppSettings.wslDistro` and there is no default.
Pressing it again after `crucible init --force` refreshes the token in place.
The TOML reader understands `[server] name/host/port` and `[auth] token` and
**refuses** any line inside those two tables whose shape it cannot read, rather
than skipping it — a skipped `token` line would report "missing" about a file
that has one.

**The slots** are `computeSlots()`: the local slot (`kind: 'local'`) unless an
enabled entry is loopback, then one per enabled server (`kind: 'crucible'`).
`kind: 'cloud'` is declared and never constructed — Package F's seam, excluded
from the `any` walk by name. Hosted, the whole list comes from
`FoundryHost.slots?()`; a host that registers none gets an empty list, which
every job reads as "the path this took before slots existed", and a `local` slot
offered by a host is dropped.

**The rows** carry `waitFor` (a slot name or `any`, resolved at the PRESS from
`AppSettings.newJobsWaitFor`, so re-ranking servers moves no queued row) and
`ranOn` (where it actually started). The picker is drawn on the queue page only,
only on a held/queued row, and only when there are two or more slots. Switching
a server off surfaces the rows naming it in the Servers card with one press that
sends them to `any` — told, never moved.

**Dispatch** (`placeJob`, `app/electron/crucible-dispatch.ts`) runs immediately
before the spawn, once, and the answer is `go` / `wait` / `refuse`. A `wait`
puts the row back to `queued` wearing the sentence, with a 3 s → 30 s backoff
(`parkedUntil`, job-queue.ts) so the GPU lane is not held by somebody else's
narration. `any` walks the enabled slots in rank order and takes the first that
will start; a refusal that is about the REQUEST stops the walk. The Crucible
sequence is: `GET /v1/capability` → the class's `selected` model id → `models()`
→ `loadModel` and watch its events if it is not resident → **lease** →
`--model <id> --endpoint <url>/openai` with `FOUNDRY_ENDPOINT_HEADERS` composed
per spawn (`Authorization`, `X-Crucible-Api: 1`, `X-Crucible-Act: <class>`). The
token is in the child's environment and never in argv, so the command line the
queue prints is safe to paste.

**The lease** (Owen, 2026-09-14) is taken after the load and before the spawn:
`POST /v1/models/{id}/lease {act, ttl_seconds: 120}`, heartbeat every 40 s,
`DELETE /v1/leases/{id}` from the queue's SETTLE — the one place every ending
passes through. A release that fails is logged and expires; failing a finished
job because the tidying failed would report a loss that did not happen. The four
routes this app calls by hand (capability plus the three lease routes) are not
on the SDK at 0.5.0 and are **to be switched to its own methods when they land**;
they go through one helper that maps status codes onto the SDK's error types, so
a 409 is a 409 everywhere.

**Rendered by name**, on the row: `server_busy` → the SDK's `busyLine` ("busy:
bookforge, tts qwen3.5-9b 62% done"; a null holder is "an unnamed client", never
a guess); `engine_in_use` → *someone is narrating on "X"*; `model_not_resident`
from a load → *"X" is holding a different model for someone else*; `model_leased`
→ *"X" is leased by <client> for <act> since <since>*; unreachable → *"X" is
unreachable*; a disabled class → *"X" cannot translate: <reason> (n.n GiB
short)*; `capability_undecided` → *"X" has not measured its card yet — run
`crucible capability --write` there*, which is deliberately different from
"nothing fit".

**Retired**: `llmServer`, `vllmUrl`, `vllmModel` (a stored `vllmUrl` becomes
nothing — vLLM is Crucible-only by ruling), `LlmServers`, the request field
`server?: LlmServerKind`, and the `llm:servers` / `llm:set-servers` channels.
`LlmServerKind` is now the engine's own vocabulary, `'openai' | 'ollama'`, and
is decided by the placement rather than stored.

**Deliberately not done.** Reads stay on their local path behind
`CRUCIBLE_READS = false` (Package B owns that reader). ~~The GPU lane is still
one (`SLOTS`, shared/queue-board.ts), so two Crucible servers do not yet run two
text jobs at once — dispatch is per-row correct, concurrency is not yet
per-slot, and making it so means a lane capacity both programs derive from the
slot list. The bench cards are still GPU/CPU lanes with an "on <slot>" line, not
one card per slot.~~ **Both struck — Package G, below.**

### Package G — landed 2026-09-14

**The GPU lane is one lane per machine, and the bench draws the machines.**

Owen's sentence is the whole of it (§1): *"if there are more than one servers
connected, there will be more than one GPU slot listed in the queue that can be
filled… an emergent property of having multiple servers configured is the
distributed load."*

**The capacity is derived, in `app/shared/queue-board.ts`**, which is the one
place both programs already read the board from. `computeLanes(slots)` answers
one lane per compute slot, each with the capacity its KIND carries
(`SLOT_CAPACITY` — `local`, `crucible` and `cloud` are all 1 today; the cloud
row exists so package F needs no edit here, and raising it is a deliberate
change to that line with the rate limit argued beside it). The CPU lane stays
the constant `CPU_LANE_SLOTS = 2`: a compile is this machine's disk however many
rooms away the models are. **An empty slot list answers with exactly one lane**,
named for the local slot — today's single GPU lane, unchanged — which is what
makes this invisible to a host that registers no slot provider.

**The scheduler** (`electron/job-queue.ts`) keys occupancy by slot NAME:
`Slot.on` is the machine a run holds. It is reserved when the pump PICKS the row
wherever the answer is already knowable — a row pinned to a slot holds that one,
and a row that is never placed at all (`placesOnASlot`, the one copy of
`placeJob`'s early returns) holds the LOCAL lane, because a page reading loads
dots on this machine's card whatever the registry says. `canStart` takes the ROW
now and asks *is there a lane this row could take*, so a busy local card no
longer stops a row that was only ever going to run on the Mac. An `any` row's
lane is claimed by the walk, inside `placeJob`, through a `LaneClaim` the queue
hands down: the placement decision stays where it was, the claim is synchronous
against main's own map so two walks cannot take one machine, and a slot this app
is already running on is stepped past with a sentence like any other busy one. A
run nobody here scheduled (a host's, the Export dialog's) claims nothing, for
`detachedRuns`' standing reason.

**One card, one lane, even with two names.** An enabled loopback Crucible hides
the local slot, and what still runs locally holds THAT lane — `localLane()`,
read by both programs, so the bench draws the run on the card the scheduler is
holding rather than inventing a second one over the same GPU.

**The bench** (`core/queue-view.service.ts`, `pages/queue`) is one card per
compute slot — its name, whose it is, what is running there, and the parked row's
own sentence about what it is waiting for — then the two CPU cards. A card's
occupant comes from `Job.ranOn` through `laneOfRun`, so the GPU half is no longer
dealt in queue order. The `on <slot>` tag stays on the CPU cards, where it still
says something the card does not. A run on a machine that has left the list keeps
its card, marked, until it ends: **re-ranking or disabling a server moves
nothing** — not a running job (atomic per slot) and not a queued row's `waitFor`
(package C's rule), and a row naming a slot that is gone is still picked so that
it gets dispatch's sentence rather than waiting in silence.

**The slot list is read once, by the service**, and both the bench and the row
picker read it from there: two reads of `slots:list` in one window are two
answers that can differ for a frame.

**Nothing changed on the wire.** No IPC channel was added, removed or renamed;
`slots:list` answers exactly what it did, and `Job.waitFor` / `Job.ranOn` carry
what they carried. A host that offers no slots gets the behaviour it has now,
verified by reading the hosted paths: `hostSlots()` → empty → one lane, and every
row a host schedules arrives through `runJob`, which is detached and claims no
lane at all.

**Deliberately not done.** A second run in one slot: every capacity is 1, so the
bench's dealing loop is written for more but nothing produces it. Live slot
updates: the list is still read once per window, so enabling a server while the
queue page is open does not redraw the bench until it is rebuilt — the same rule
the picker has had since package C, and a push channel is more than this change
should decide. And the `any` walk still does not prefer a machine nobody is
queued for: FIFO order decides, which is what the board has always promised.

### Package D — landed 2026-09-14

**The catalog is a file, the tiles gate on the machine, and the disk says what
is on it.**

**`app/shared/model-lineup.json`** is the vendored table, in the agreed shape:
one row per model with a Crucible `id`, its `classes`, a `local` block
(`kind: "ollama"` with a tag, or `kind: "gguf"` with repo/revision/file/mmproj)
and a `needsGB` carrying its `basis`. `llm-catalog.ts` READS it —
`resolveJsonModule` is on in `tsconfig.electron.json`, `rootDir` is `app/`, so
tsc copies it to `dist/shared/` and `electron-builder`'s `dist/shared/**` ships
it. `lineupFor` keeps its fit and CPU rules unchanged; `needsGB` now comes from
the file rather than from arithmetic at the call site. The renderer never imports
it: its tsconfig has no `resolveJsonModule` and it has no business holding a
catalog.

**It is written by hand and says so** — `generatedBy: "hand — pending
crucible/scripts/gen-foundry-lineup.py"` — with every `basis` set to
`"declared"`, the download plus the 1.5 GB overhead, which is exactly what the
code used to compute. Two things in it are NOT in the old const and are worth
naming: **`qwen3.8:27b`**, the app's own `DEFAULT_TRANSLATE_MODEL`, which
`QWEN_LINEUP` never listed (so the wizard could pull every model except the one
every dialog opens with) — it carries BookForge's id `qwen3.8-27b-4bit`; and the
four **`clean`** rows plus the **`pages`** row (`dots-ocr`, the GGUF pair from
`page-reader.ts`'s own constants). Rows Crucible has no manifest for carry
`"crucible": false` rather than being omitted: they exist locally, and a Crucible
cannot be asked for them.

**The tile gate is `app/electron/act-gates.ts`**, one function answering
`{lit, why}` for all five acts, read over `acts:gates` and pushed at on
`acts:gates-changed`. `minimum_for` is a **floor, not a name**: the 9B row
carries it for translate and simplify, and every row at or above it in lineup
order qualifies — reading it as "only this row lights translate" would dark a
24 GB card holding the 27B. `memoryBasis === 'ram'` darks translate, simplify and
analysis outright (Owen's "obscenely long time"); clean is exempt, because a
cleanup is only offered in a hosted window, where the compute is the host's. Four
things deliberately do NOT refuse: a hosted window (the work runs on the host's
compute — BookForge has no ollama at all), a machine pointed at a non-Ollama
server (the weights are over there, and this gate does not probe it), clean on a
processor, and reading through a remote endpoint. `why` is always set, lit or
dark, and a dark one names the model that would change it.

**"Models on this machine" is `machine-models-card.component.ts`** over
`models:inventory`: Foundry's own downloads (itemised, with the whole `bin/`
directory counted rather than the 3 MB executable), Ollama's list with the sizes
`/api/tags` reports and **no Remove button**, and the Crucible line, which today
says none is configured. `models:remove-page-reader` deletes `pageReaderDir()`
whole — the only directory this app wrote — stopping the server first if it is
ours, and answers with the gigabytes freed in main's own sentence.

**§5b's deletion rule is built and inert.** `pageReaderRemovalOffer`
(`machine-models.ts`) computes what it WOULD remove; `crucible-provider.ts`
answers `unknown` for every class, and `unknown` takes the same branch as `no` —
the three-valued answer exists so that a silence cannot read as a permission to
delete three gigabytes. **Package C** replaces the two function bodies; nothing
above them changes.

**Not done, deliberately:** the tree footer's "from here" acts (never disabled by
design — they dim and stay pressable, `open-documents.component.ts`) and the four
dialogs' own refusals still gate on the book alone; a machine gate there is a
second surface for the same sentence and belongs with package E's settings work.
The gate does not probe a configured non-Ollama server for reachability.
