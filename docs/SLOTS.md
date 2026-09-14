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
| C | App: server registry (name, url, headers), drag order, enable; slots; per-row `waitFor`; dispatch: header map per spawn, capability read for the model, `load-model` before spawn, the three 409s rendered by name | Crucible SDK shapes | next |
| D | Catalog: generated lineup JSON, tile gating, CPU rule | BookForge's `[local]` block | after C |
| E | Setup/settings: Crucible install offer + connect-to-existing; Ollama wizard stays; dots download; page-reader row | B, C | after C |
| F | Cloud slots: OpenAI (the `openai` door + key), Anthropic (third dialect); per-job opt-in; 429 as the wait; cost shown | C | **ENGINE HALF LANDED** 2026-09-14; app half after C |
| — | Lease client (transport.ts) | Owen's ruling, Crucible's routes | owed |
