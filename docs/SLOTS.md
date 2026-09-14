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

Two dialects, **declared, never sniffed from the URL**:

| `--server` | who is on the other end | model | window | end of run |
|---|---|---|---|---|
| `openai` (default) | Crucible, a local llama-server, vLLM, or a cloud provider — anything OpenAI-compatible | absent = the served model; a given name is proved | the server's, read back as `max_model_len`; a request that cannot fit is refused by name before it is sent | **nothing** — the engine never loads or unloads on this door |
| `ollama` | the friend's local Ollama | **required** (an Ollama holds a library; the app's picker names it) | `num_ctx` pinned once a book | **unloaded, always** (`keep_alive: 0`); no flag to keep it |

Everything else is dialect-agnostic and stays: the prompts, temperature, the
validators, the bank/records/stamp keyed by the served model id, the act
naming (`translate:` / `simplify:`), the header map (`FOUNDRY_ENDPOINT_HEADERS`).
Cloud OpenAI is the `openai` door plus a credential in the header map. Anthropic
is a third dialect and a later package (§6).

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

## 6. Packages, and their order

| # | Package | Depends on | Status |
|---|---|---|---|
| A | Engine: `--server ollama` restored beside `openai`; unload always; `--model` required on Ollama; CTX pin for Ollama, `fitsWindow` for openai | nothing | building |
| B | App: delete `vllm-server.ts`; local page reader = llama-server + dots GGUF, downloaded in setup; reading jobs ensure it | nothing | building |
| C | App: server registry (name, url, headers), drag order, enable; slots; per-row `waitFor`; dispatch: header map per spawn, capability read for the model, `load-model` before spawn, the three 409s rendered by name | Crucible SDK shapes | next |
| D | Catalog: generated lineup JSON, tile gating, CPU rule | BookForge's `[local]` block | after C |
| E | Setup/settings: Crucible install offer + connect-to-existing; Ollama wizard stays; dots download; page-reader row | B, C | after C |
| F | Cloud slots: OpenAI (the `openai` door + key), Anthropic (third dialect); per-job opt-in; 429 as the wait; cost shown | C | later |
| — | Lease client (transport.ts) | Owen's ruling, Crucible's routes | owed |
