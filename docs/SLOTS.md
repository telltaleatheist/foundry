# Slots — how Foundry uses a GPU, and how Crucible fits (Owen, 2026-09-13/14)

> The plan of record for the compute story after the 2026-09-13 reframe. It
> supersedes the "one door, Crucible is mandatory" reading built earlier that
> night (docs/PLAN.md Wave 60), which Owen reversed in his own words: *"foundry
> should be prepared to operate without crucible present. it should do
> translation through ollama, simplify, analyze, VLM pdf conversion, all of it
> — but it should go through the normal doors accessible on windows or mac. if
> we want the speed tricks, we can connect to a crucible server."*

> **Superseded in part, 2026-09-14 evening — read docs/PLAN.md Wave 62 and
> crucible `docs/PHASE15-HOST.md` first.** Owen: *"they dont have ollama
> fallbacks or cloud anything at all … one contract, one SDK, one API."* The
> Crucible server is the one door; routes and upstreams (Anthropic, OpenAI, an
> Ollama) are the ENGINE's settings and Foundry draws a window onto them; a
> no-WSL Windows box runs a host-mode server. §1's "works without Crucible"
> vision, §2's `ollama`/`anthropic` doors, §3's local and cloud slots and §5b
> are therefore on their way out — kept until Wave 62's gate is watched. What
> stays exactly as written: the registry, the lease, the four 409s, atomic
> placement, coordinate-on-connect, and the page reader (its fate is Wave 62's
> one open question).

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
- ~~*"the friend sees a single gpu slot if theyre local — their GPU slot. if
  theyre using crucible on their local machine, the local GPU disappears… or
  they can add a remote crucible server, like to the mac… itll show the mac's
  gpu slot as open and usable, plus their local GPU."*~~ **SUPERSEDED, Wave 66**
  by the ruling below.
- **Wave 66, and it deletes the local slot** — *"everything goes through a
  crucible server now, including local… there should be no local gpu listed in
  the queue."* And precisely: *"cpu slots are always local. we dont outsource
  simple cpu work to crucible. one gpu slot in the queue per connected crucible
  server. including the local crucible, which is indistinguishable from the
  remote crucible server."*
- Tiles: *"if their system just isnt powerful enough for translation (smaller
  than 9b) then translation and simplify is disabled. the tiles arent lit up
  until the models are present."* And: *"if a job is going to take an
  obscenely long time, like translation on cpu, it should just be disabled."*
- **The floor, settled 2026-09-14** — *"i think either they use the 27b or they
  use an api key for Claude or OpenAI. thats probably the best solution."* So
  `minimumFor: [translate, simplify]` sits on a 27B in both catalogs, analysis
  carries no floor at all, and a machine under the floor reaches those two acts
  through a Crucible or a connected provider. The dark tile names both routes.
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

- ~~**Local** — the machine's own GPU (or CPU).~~ **DELETED, Wave 66.** There is
  no local slot. A Crucible installed on this machine is an ordinary registry
  entry and is *"indistinguishable from the remote crucible server"*. The CPU
  side of the board is untouched by that ruling and is not a slot at all: it is
  a count (`CPU_LANE_SLOTS = 2`), it is always this machine, and simple CPU work
  is never outsourced.
- **A Crucible server** — one per ENABLED registered server, in drag order, and
  they are the whole of the GPU side. An entry that resolves to an orchestrator
  with no engine behind it (PHASE17 §6) is not a slot — a lane there could never
  take a job — read from the resolver's cache only, so an unprobed entry keeps
  its lane.
- **No slot at all** — the ordinary state of a machine with nothing registered.
  GPU work is REFUSED by name (*"No GPU engine is connected — add one in
  Settings › Servers"*) rather than run here or parked for ever; CPU work runs
  exactly as before.
- **A cloud provider** — never busy, nothing resident, text acts only; a
  deliberate per-job choice, never something `any` falls through to. **Drawn
  hosted as well** (2026-09-14): Owen's rule is that a machine under the
  translate floor reaches those acts through a 27B or *"an api key for Claude
  or OpenAI"*, and a BookForge user on a laptop is that machine — suppressing
  it there left them no path at all. The key is the host USER's own, typed into
  Foundry's card, and hosted that settings file IS the host's userData, so
  there is one store and the host's own doors read it rather than keeping a
  second list of keys.

Rules: a job is **atomic per slot**. `waitFor` on a row is a slot name or
`any`; `any` walks the enabled slots in priority order and takes the first that
will start the job, and never includes a cloud slot. A busy slot is waited
for, and the wait is rendered with the holder's name. Disabling a slot
surfaces the rows that name it. The vendored (BookForge-hosted) app takes its
slot list from the host and shows no Ollama wizard; a host that offers no
registry leaves that window with no GPU slot, and its GPU rows are refused with
the host's own sentence rather than quietly run in the host's process.

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
  official homes on install (the dots GGUF pair from the Hugging Face repo the
  catalog's `pages` row names, Ollama tags through Ollama's library, Crucible's
  through its manifests),
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

**STATE (Package E, 2026-09-14).** Every bullet above is built. The three-valued
`localCrucibleServes` answers from the registry's capability reads; a REMOTE
Crucible's offer is drawn with its number and its sentence; the Ollama wizard
will not pull for a class a local Crucible serves and says so in the rows;
Ollama's own store still has no Remove button and never will. The automatic
deletion carries **one further condition that the bullet assumes and does not
spell**: reading must actually go to that Crucible. `CRUCIBLE_READS` is still
false, so a `read` job takes the local path — and deleting the reader on the
strength of a capability record alone would delete the thing still doing the
work. While that is so the card shows the sentence and no button. See "Package E
— landed" below for the one constant that turns it on.

## 6. Packages, and their order

| # | Package | Depends on | Status |
|---|---|---|---|
| A | Engine: `--server ollama` restored beside `openai`; unload always; `--model` required on Ollama; CTX pin for Ollama, `fitsWindow` for openai | nothing | **LANDED** (docs/PLAN.md, Wave 61) |
| B | App: delete `vllm-server.ts`; local page reader = llama-server + dots GGUF, downloaded in setup; reading jobs ensure it | nothing | building |
| C | App: server registry (name, url, headers), drag order, enable; slots; per-row `waitFor`; dispatch: header map per spawn, capability read for the model, `load-model` before spawn, the three 409s rendered by name | Crucible SDK shapes | **LANDED** (§7) |
| D | Catalog: generated lineup JSON, tile gating, CPU rule | BookForge's `[local]` block | **LANDED** (below) |
| E | Setup/settings: Crucible install offer + connect-to-existing; Ollama wizard stays; dots download; page-reader row | B, C | **LANDED** (below) |
| F | Cloud slots: OpenAI (the `openai` door + key), Anthropic (third dialect); per-job opt-in; 429 as the wait; cost shown | C | **LANDED** — engine 2026-09-14, app half the same day (§7) |
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

**The slots** are `computeSlots()`: ~~the local slot (`kind: 'local'`) unless an
enabled entry is loopback, then~~ one per enabled server (`kind: 'crucible'`).
**Struck — Wave 66: there is no local slot and `kind: 'local'` is gone from the
union, so the compiler refuses a slot that claims to be this machine's card.**
~~`kind: 'cloud'` is declared and never constructed — Package F's seam, excluded
from the `any` walk by name.~~ **Struck — Package F (app), below: one cloud slot
per enabled provider, after every Crucible, stepped past by the `any` walk with
a sentence rather than skipped in silence.** ~~Hosted, the whole list comes from `FoundryHost.slots?()`.~~ **Struck
2026-09-14 — the host hands over the REGISTRY, not the slot list.** `slots?()`
gave away the list and kept the credentials, and hosted that split did not
work: a placement resolves a slot's name back to an entry for its address and
token, and hosted that lookup read this app's own registry, which is always
empty there. A row pinned to a host-offered server parked for ever on *"X is no
longer registered"* — two lists, one of them guaranteed empty, and the break
only showed on a press nobody had made. `FoundryHost.servers?()` now answers
`{name, url, token, enabled}[]` in priority order and the slots are DERIVED
from it by the same code standalone uses (`readRegistry` and `slotsFrom`,
electron/crucible-registry.ts), so the two cannot compute different slots from
the same servers and a credential lookup cannot miss a slot that exists. There
is no local slot to suppress hosted any more, and the cloud slot IS drawn
hosted (below). A host that offers no
registry gets no slots and a SENTENCE the board draws, not an empty list that
reads as "you have added none".

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
(`SLOT_CAPACITY` — `crucible` and `cloud` are both 1 today; raising either is a
deliberate change to that line with the rate limit argued beside it). The CPU
lane stays the constant `CPU_LANE_SLOTS = 2`: a compile is this machine's disk
however many rooms away the models are, and Wave 66 protects it by name — *"cpu
slots are always local. we dont outsource simple cpu work to crucible."*
~~**An empty slot list answers with exactly one lane**, named for the local
slot.~~ **Struck — Wave 66: an empty slot list is NO GPU lane.** A GPU row on
such a board is admitted by `canStart` anyway, so that the placement can refuse
it by name instead of leaving it queued for ever.

**The scheduler** (`electron/job-queue.ts`) keys occupancy by slot NAME:
`Slot.on` is the machine a run holds. It is reserved when the pump PICKS the row
wherever the answer is already knowable — a row pinned to a slot holds that one,
and a row that is never placed at all (`placesOnASlot`, the one copy of
`placeJob`'s early return) holds this machine's card lane when one of the lanes
IS this machine's card — which since Wave 66 means a loopback Crucible, there
being no local slot. Every GPU kind has a capability class today, so that arm is
reached only if `CRUCIBLE_READS` is ever turned back off. `canStart` takes the ROW
now and asks *is there a lane this row could take*, so a busy local card no
longer stops a row that was only ever going to run on the Mac. An `any` row's
lane is claimed by the walk, inside `placeJob`, through a `LaneClaim` the queue
hands down: the placement decision stays where it was, the claim is synchronous
against main's own map so two walks cannot take one machine, and a slot this app
is already running on is stepped past with a sentence like any other busy one. A
run nobody here scheduled (a host's, the Export dialog's) claims nothing, for
`detachedRuns`' standing reason.

**One card, one lane.** This machine's card is the lane of a Crucible registered
at a loopback address, if there is one, and whatever still runs locally holds
THAT lane — `localLane()`, read by both programs, so the bench draws the run on
the card the scheduler is holding rather than inventing a second one over the
same GPU.

**The bench** (`core/queue-view.service.ts`, `pages/queue`) is one card per
compute slot — its name, whose it is, what is running there, and the parked row's
own sentence about what it is waiting for — then the two CPU cards. A card's
occupant comes from `Job.ranOn` through `laneOfRun`, so the GPU half is no longer
dealt in queue order. ~~The `on <slot>` tag stays on the CPU cards.~~ **Struck — Wave 66:** it said
the local slot's name, an unplaced run records no machine now, and the CPU lane
is always this computer. A run on a machine that has left the list keeps
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

### Package E — landed 2026-09-14

**The wizard offers Crucible, the two inert seams are live, and the lineup is
Crucible's file.**

**THREE DOORS, ONE COMPONENT, TWO HOSTS.** Owen: *"offer to install Crucible, or
to point at one elsewhere."* `crucible-doors.component.ts` is mounted by the
setup wizard's new **Crucible (optional)** step — after Ollama, before the
environments — and by the Settings **Servers** card, which keeps the LIST
(editing, ranking, switching off) and lost its own "Add the Crucible on this
machine" button to door 2. One set of doors so the two screens cannot teach
different things about one registry.

1. *Connect to a Crucible server* — Test through `crucible:test-at`, which writes
   NOTHING (adding a server to find out whether it is a server leaves a dead entry
   behind every failure); Add through `crucible:add` → `writeCrucibleServers`,
   the registry's one writer, replacing an existing name in place.
2. *Use the Crucible on this machine* — package C's `addLocalCrucible`, config.toml
   through `wsl.exe`, the distro field beside the button that needs it.
3. *Install Crucible here* — the sequence as numbered steps with every command
   copyable, the two elevated ones listed apart, and the README link. The button
   that will drive it is **present and disabled**, wearing main's own sentence.

> **SUPERSEDED, AND WAITING ON A PUBLISHED PACKAGE (2026-09-14).** Crucible
> ships its own operator page and its own installer, so door 3 collapses to a
> single *Open engine console* button wherever a server already exists — the
> numbered list goes — and the connect door gains one field that takes a
> *connect code* (`parsePairing`). Neither is built: both need
> `@crucible/client` 0.6.0, which is not published. `parsePairing` will not be
> reimplemented here, because its percent-encoding and refusals are exactly the
> kind of fact that drifts when it is written twice.
>
> **AND THE "SET UP FOR FOUNDRY" BUTTON IS NOT BEING BUILT AT ALL.** Owen,
> 2026-09-14: *"lets make it as simple as possible."* An app that finds a
> server coordinates with it automatically — reads `GET /v1/catalog` and posts
> its module as a task ONLY when something is missing — on every ENABLED
> server, local or remote, with no consent step. The person sees the progress
> sentence and nothing else. Disabling a server in Settings is the one way to
> say "not that one", which makes the enable switch load-bearing in a way it
> was not before.

**The Ollama step is untouched and remains the beginner's path.** The whole
Crucible step is skippable like every other, and its blurb says most people
should skip it.

**THE DRIVEN INSTALL IS A SEAM, TYPED AGAINST THE REAL SURFACE.**
`driveCrucibleInstall()` (`app/electron/crucible-install.ts`) is shaped to
`@crucible/bootstrap` 0.5.0's `install()` — transcribed from its `.d.ts`, not
invented — and rejects with `DRIVEN_INSTALL_UNAVAILABLE`, the same sentence the
button wears. `crucible:install` refuses too: a door reachable by IPC must refuse
at the door or the disabling is a decoration. The package is deliberately **not**
in `app/package.json` until Crucible's next release exists. docs/SETUP.md §5b
lists the four-step change that turns it on, the Mac's `condaRoots` value, and
what to print off a `BootstrapStepFailed`.

**THE PROVIDER SEAM IS LIVE.** `localCrucibleServes(cls)` (`crucible-provider.ts`)
reads package C's registry and `GET /v1/capability` — the dispatcher's own
`readCapability`, exported rather than written twice, with a **3 s timeout on
this path only** (a placement may wait; a tooltip may not). `yes` when an enabled
LOOPBACK entry's class row is `enabled` with a non-empty `selected`; `no` when
every local entry that answered said otherwise; **`unknown`** when there is no
local entry, nothing has probed, or a local server was silent. The answers are
cached for 15 s and forgotten on `crucible:save`; `refreshCrucibleFacts()` is
awaited by `actGates`, `machineModels`, `pageReaderState` and `llmChoices`, and
the accessors stay synchronous because three of their callers are.

**§5b IS BUILT AND WIRED, AND ITS PRECONDITION HAS TWO HALVES.**
`applyPageReaderRemoval()` deletes Foundry's own reader and writes a RECEIPT
(`AppSettings.pageReaderRemoved`: server, bytes, date) so the sentence survives
the app being closed. It fires from exactly two places — `crucible:save` and once
at startup — and **never from a read**: a screen that deleted four gigabytes as a
side effect of being opened is a screen nobody can open safely. Installing the
reader again tears the receipt up.

**IT ALSO REQUIRES `CRUCIBLE_READS`, AND THAT IS §5b READ EXACTLY RATHER THAN A
HEDGE.** §5b removes the files *"only when a LOCAL Crucible has TAKEN OVER that
class"*. Serving it is half of that; the other half is this app SENDING page
reads there, and it does not: `CRUCIBLE_READS` is still false, a `read` job takes
the local path, and `job-queue.ts` starts the local llama-server BEFORE it
resolves a placement at all. Removing on the strength of a capability record
alone would delete the thing still doing the work, and the next PDF would fail
with *"the local page reader is not installed yet"* on a machine whose owner had
done nothing but register their own server. So while that constant is false the
card shows the sentence and NO button, the page-reader card's Install button
stays enabled, and the OCR tile does not claim a Crucible is reading pages. **The
day `CRUCIBLE_READS` flips, all four of those become the automatic behaviour with
no other change** — the condition is spelled once in `machine-models.ts`, echoed
in `pageReaderSuperseded` and read by `readGate`. Owen owes the ruling that flips
it, together with the read path resolving its placement before it starts a
server. A REMOTE Crucible removes
nothing and the Models card shows the offer with the number on the button and
§5b's sentence, *"page reading will then need <server> to be reachable"*. The
page-reader card's Install button is **off with a sentence** rather than gone.
The Ollama wizard will not pull for a class a local Crucible serves and says so
IN THE ROWS (`LlmChoices.crucible`), rather than hiding them. Ollama's own models
are never removed by this app.

**THE LINEUP IS CRUCIBLE'S FILE, PLUS OURS, MERGED.**
`app/shared/model-lineup.json` is `foundry-lineup.json` vendored byte for byte
from crucible `7e63905`; nothing here edits it, so a keeper can compare it by
content. `app/shared/model-lineup-local.json` is Foundry's own additions — the
smaller Qwen tags Ollama serves and Crucible has no manifest for — with a `note`
header arguing why they are KEPT and kept SEPARATE, every id prefixed `foundry/`
so it can never collide with a Crucible id. `llm-catalog.ts` reads both, derives
`crucible: true|false` from which file a row came out of, and **sorts the merged
list by `needsGB.value`** because everything downstream depends on smallest-first
and neither file is sorted. `minimumFor` replaces `minimum_for`; `minimum` is
read by nothing (it is `minimumFor.length > 0`, and a boolean cannot say which
class).

**ONE CONSEQUENCE, STATED RATHER THAN HIDDEN: the ANALYSIS floor moved.**
Package D gave analysis no floor, on Owen's *"analysis is a sentence at a time
and a small model does it."* Crucible's `qwen3.8-27b-4bit` row declares
`minimumFor: [translate, simplify, analysis]`, so analysis now floors at the
4-bit 27B and a 12 GB card that used to light the Analysis tile does not. Foundry
did not overrule the catalog of record. If it is wrong it is wrong in Crucible's
manifests, and it is fixed there and re-vendored. Translate and simplify keep the
9B floor, which the local file declares — where two catalogs each declare a floor
the SMALLEST wins, because Crucible's is what a Crucible will serve and ours is
what an Ollama on this desk can be asked for.

**THE PAGE READER TAKES ITS WEIGHTS FROM THE CATALOG.** `page-reader.ts`'s
`HF_REPO`/`MODEL_FILE`/`MMPROJ_FILE` constants are gone; `pagesForm()` is the one
owner. The row names `anthonym21/dots.ocr-GGUF` at commit `42ab3102…` with an F16
projector, which is a DIFFERENT pair from the one this app used to fetch — so
`pageReaderFootprint` now walks the models directory rather than the current pair,
and a superseded file is listed and marked rather than going unaccounted on
somebody's disk.

**Channels added:** `crucible:test-at`, `crucible:add`, `crucible:install-plan`,
`crucible:install`, and the push `models:changed`. Nothing was removed.

**Not done, deliberately.** The driven install (above). The tree footer's "from
here" acts and the four dialogs' own refusals still gate on the book alone — the
machine gate is the dock's, and a second surface for the same sentence is still
owed. The gate does not probe a configured non-Ollama endpoint for reachability.
`CRUCIBLE_READS` is still `false`: a `pages` job still takes the local path even
where a Crucible serves the class, which is why §5b's removal is about DISK and
not about routing — the local reader is removed because the Crucible on this
machine will be asked for pages once that constant flips, and until then the
machine reads through whatever `backend.endpointUrl` names.

### Package F (app) — landed 2026-09-14

**A key is a slot. It is never busy, nothing is resident on it, it does text and
never pages, and no walk ever falls into it.**

Owen's sentence is the whole brief (§1): *"give them the option of connecting an
api key for openai or claude instead of using the 27b or the 9b. if the user
wants to they can use usage credits from a cloud model… for weaker systems."*
The engine half landed the same day (§2, docs/VLLM.md §2a): `--server
openai|anthropic`, `--model` required on both, a 429 waited out, one usage line
per run. This is the app half.

**THE ENTRIES.** `AppSettings.cloudProviders` — `{kind: 'openai' | 'anthropic',
name, apiKey, model, endpoint, enabled}[]`. The KEY is stored there and nowhere
else and never leaves main: the renderer's shape is `CloudProviderView`
(shared/slots.ts), which carries `keySet: boolean` where the entry carries a
credential; it is never logged, never in argv, and never in an answer. The array
order is NOT a rank, unlike `crucibleServers`, and the difference is stated
rather than left to be found: a rank exists because `any` walks the list, and
`any` never reaches these.

`model` is the provider's own id, free text, **and there is deliberately no
catalog of cloud models in this build** — hosted line-ups change monthly, so a
compiled list would be wrong by the next release, offering retired models and
hiding the one somebody is paying for. The box carries a placeholder per
provider (`gpt-4o-mini`, `claude-sonnet-4-5`) and the PROOF is Test, which lists
the provider's own `/v1/models` from main with the right header per kind
(`Authorization: Bearer` / `x-api-key` plus `anthropic-version`) and says
whether the id in the box is among them. A working key with an unlisted model is
drawn as a WARNING beside a successful listing, not as a failure, and saving is
still allowed: a provider may serve a model it does not list, and refusing the id
somebody typed would make this app the authority on somebody else's catalog.

`endpoint` is empty for the provider's own address and resolves at the PLACEMENT
(`CLOUD_PROVIDER_ENDPOINT`), so a provider moving its API is one line of this
build rather than a migration of everybody's settings file. The two defaults are
spelled the way each engine door wants them — `https://api.openai.com/v1` (that
door appends `/v1` when it is missing) and `https://api.anthropic.com` (that
door strips a trailing version and composes `/v1/messages` itself).

**THE CARD** is Settings → **Cloud providers**, directly under Servers: the three
cards read downwards as the three places a text act can go — this machine's
Ollama, a Crucible somebody runs, a provider somebody pays — and the paid one is
last. Add, remove, enable, Test, and **the sentence Owen's rule requires under
the key field**, declared once in `shared/slots.ts` so no surface can word it
differently: *"Text you translate, simplify, clean or analyse is sent to that
provider."* Hosted it is read-only and the write refuses at the door, on the
Servers card's argument.

**THE SLOTS.** `computeSlots()` appends one `kind: 'cloud'` slot per ENABLED
provider, **after every Crucible slot**, and the position is the statement: the
`any` walk has already tried everything that costs nothing before it reaches
them. It carries **no `url`**, and that is not an oversight — `localLane`
(shared/queue-board.ts) decides which lane is this machine's card by asking
whether a lane's url is loopback, and an OpenAI-compatible endpoint at
`http://localhost:8000/v1` is an ordinary thing to configure; a cloud slot
carrying it would be adopted as this machine's card, and whatever genuinely runs
on that card would go unguarded behind a provider's rate limit. A duplicate name is
dropped there as the last word, and refused by name at BOTH writers, which read
each other's list.

**`any` STEPS PAST THEM WITH A SENTENCE**, which is the one change to the walk:
*"X" is a cloud provider, and cloud slots are chosen on purpose*. Skipping in
silence would park every row on a cloud-only machine reading "no slot is
available", when the true statement is that there is one and this walk will not
spend somebody's money to reach it. `waitForOfNewJob` resolves `top` to the top
**non-cloud** slot for the same reason, in the same words.

**THE PLACEMENT** (`placeOnCloud`, crucible-dispatch.ts) is the shortest in that
module and the absences are the design: no capability read (a provider has no
card to measure), no residency, no lease, no `wait` arm at all (a provider's way
of saying "later" is a 429 and the ENGINE waits it out — parking the row here
would be a second waiter over one queue), and **no network call of any kind**. A
`read` pinned to one is refused BY NAME, once, everywhere: *"<provider> cannot
read pages; page reading stays on this machine or a Crucible."*

The command line a cloud placement produces, credential-free as every line this
queue prints is:

```
foundry translate --book <book> --records <records> --to <lang> \
  --model gpt-4o-mini --endpoint https://api.openai.com/v1

foundry clean-text --book <book> --records <r> --stamp <s> \
  --model claude-sonnet-4-5 --server anthropic --endpoint https://api.anthropic.com
```

`--server` is written out for `anthropic` and left off for `openai`, which is the
engine's default (`serverArgs`, job-queue.ts — a switch over the whole union, so
a fourth door cannot silently spawn against the default). The key travels in the
child's ENVIRONMENT and only there:
`FOUNDRY_ENDPOINT_HEADERS={"Authorization":"Bearer ‹key›"}` on the OpenAI door,
`FOUNDRY_ENDPOINT_HEADERS={"x-api-key":"‹key›"}` on Anthropic. **Nothing else is
in that map** — no `X-Crucible-*` (those are what a Crucible's own log is keyed
by, and sending them to OpenAI would be this app naming somebody else's product
on a wire that has never heard of it) and no `anthropic-version`, which the
engine adds itself because it is a property of the dialect.

**THE LANE STAYS ONE**, and the comment now argues it rather than deferring it
(`SLOT_CAPACITY`, shared/queue-board.ts): a Crucible's lane is one because the
GPU is one, and a provider has no card — it has a rate limit, per key, already
honoured one layer down by `DEFAULT_CLOUD_CONCURRENCY` (four in flight) and by
the engine's 429 wait. Two runs on one key would share one limit, trip it more
often and spend the difference asleep while still paying for every retry that
landed. A person who wants two at once configures a second provider entry, which
is a second key and a second limit, said out loud.

**COST SHOWN, NEVER PRICED.** The engine's one usage line —
`translate: 412 requests, 1,203,441 tokens in, 388,120 out` — is read off the
same stderr the progress counts come off (`parseUsageLine`, electron/engine.ts,
which is its OWN reader and not a fourth pattern in `parseProgressLine`: that
function's whole discipline is that everything it returns is work done out of
work to do). It lands on `Job.usage` and is drawn on the finished row and on the
bench card as `1,203,441 in / 388,120 out`, with the request count in the hover.
**Absent means "nothing counted" and never zero**: Ollama reports no usage, so
the engine prints no line rather than a line of noughts. Foundry does not price
it, on docs/VLLM.md §2a's ruling — prices change weekly and differ per key and
tier, and a number invented here would be wrong in a way that looks
authoritative.

**THE TILES** (act-gates.ts): an enabled provider lights translate, simplify,
analysis and clean **after the machine itself has said no**, keeping the
machine's own sentence and adding *"this can run via <provider> (cloud)"*. Last
and not first, because Owen asked for it as the answer for a weaker system — a
provider that lit these tiles unconditionally would quietly move the default
answer for a 24 GB card off its own GPU and onto a bill, and the tile is not
where that choice is made anyway; the picker is. **Reading is lit by nobody**:
`readGate` does not consult a provider at all.

**THE PICKER** draws them in an `<optgroup>` of their own headed **"Cloud —
costs credits"**, below the machines. Every mechanism that keeps `any` out of
them is in main and invisible on screen; the group heading is where the
difference is SAID.

**Channels added:** `cloud:settings`, `cloud:save`, `cloud:test` — a family of
their own, because a provider is not a Crucible (no capability record, no
residency, no lease, no busy state) and because a brand-new family is the
cheapest possible answer to the collision audit that is still open. Nothing was
removed and no existing shape narrowed. `LlmServerKind` gained `'anthropic'`;
`Job` gained the optional `usage`.

**Not done, deliberately.** No price, above. No model catalog, above. No
per-provider concurrency knob: the engine's `--concurrency` exists and this app
does not spell it for a cloud run, so that door's own measured default (four)
stands — a second place to configure a number is a second place for it to be
wrong. No reachability probe at the placement, on `interpretFailure`'s posture: a
round trip in front of every row would tell the run nothing it will not learn in
its first request, with a better sentence. No cloud slot for reading, which is
§3's rule rather than an omission. No wizard step: the setup wizard offers Ollama
and Crucible, and a third door asking a first-time user for a credit-card-backed
key belongs behind a deliberate visit to Settings. And the `cloudProviders` of a
standalone Foundry are NOT merged into a hosted window's slot list — hosted, the
work runs on the host's compute and the bill is the host's, so a host that offers
no cloud slot sees none.
