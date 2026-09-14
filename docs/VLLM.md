# The one inference door for the text acts

> **2026-09-13 — ONE KIND OF SERVER, BY RULING.** Owen: *"everything compute
> intensive must go through crucible. if theres no crucible server, theres no
> foundry. it's a necessary service. we could send requests through crucible to
> ollama but i dont think thats necessary. we should adapt it to using the
> models through crucible instead."* The Ollama transport this document once
> described beside the vLLM one is **gone** — no `--server` flag, no `--ollama`
> URL, no `num_ctx`, no `--keep-model`, no release at the end of a run. What
> remains is the OpenAI-compatible chat door below, which is what the inference
> service fronts on every machine (vLLM-shaped on CUDA, mlx-lm-shaped on a Mac,
> the same door either way). Sections that describe the Ollama side are kept
> only where they record a measurement; the current contract is §§1–5.

Owen, 2026-09-08, the ruling that put the door in: *"lets build in vllm
batching. ollama batching doesnt work. its an unfinished feature ollama tried to
implement but isnt accessible on the mac or pc. cuda graphs/vllm would probably
be the best for all three features. go ahead."*

The acts are **translate**, **simplify** (`translate --rewrite`), the
**narration cleanup** (`clean-text`) and **analyze**. All four speak to one
server, and nothing about a pass changes with the machine it runs on.

---

## 1. Why, in one paragraph

Every one of the acts is a POOL of requests over a book of thousands of blocks —
twelve in flight by default. A pool only pays if the server runs the requests
*together*, and that is what the door is for: continuous batching, one CUDA
graph replayed across the batch, and throughput that climbs with the number of
requests in flight. **The pool is the prerequisite and batching is the payoff**:
the server's *single-stream* latency is no better than a serial runner's, so a
serial caller hands it a batch of one and gains nothing.

---

## 2. The flags, and what the engine decides for itself

```
foundry translate  … [--endpoint <url>] [--model <name>] [--concurrency <n>]
foundry clean-text … [--endpoint <url>] [--model <name>] [--concurrency <n>]
foundry analyze    … [--endpoint <url>] [--model <name>] [--concurrency <n>]
```

`--endpoint` is the server. Absent, the engine reads `backend.endpointUrl` from
its settings — **the same setting the reading door reads**, because it is the
same server: the page reader and the text models are made resident on it in
turn. The app passes the flag on every line it composes, so a job never depends
on the engine's fallback to say which machine it runs on.

| | the door |
|---|---|
| Route | `POST /v1/chat/completions` |
| Model proof | `GET /v1/models`, exact id match; the listing's `id` is what every record names |
| `--model` absent | **the served model**, resolved before any cache key and recorded |
| Thinking switch | `chat_template_kwargs: {enable_thinking: false}` for the qwen3 family — on its way to a server-side manifest default |
| Context window | the server's, read back as `max_model_len`; a request is sized INTO it, and one that cannot fit is refused by name before it is sent |
| `--concurrency` default | 12 (`DEFAULT_TEXT_CONCURRENCY`) |
| Loading, unloading | **neither, ever** — the operator makes a model resident before a pass is spawned, and a pass ending is not a reason to take it off (§5) |

Unchanged from the day the door was built: the prompts byte for byte, the
temperature, the retries, the validators, the records/bank cache, the stamp,
`NORMALIZER_VERSION`, `PUNCTUATION_SPEC_VERSION`.

Files: `src/translate/transport.ts` (HTTP as a value, and the numbers every act
shares), `src/translate/vllm.ts` (the dialect), `src/translate/model-server.ts`
(the proof and the record), and four call sites — `src/translate/run.ts`,
`src/clean/run.ts`, `src/clean/epub.ts`, `src/analyze/run.ts`.

### analyze asks a different KIND of question

The three text acts ask for prose. `analyze` asks a CLOSED question and
constrains the decode to the legal answers — measured both more accurate and
about five times cheaper than asking politely and parsing hopefully
(`src/analyze/verify.ts`'s header). The spelling is
`response_format: {type: "json_schema"}`, which the server implements with
grammar-constrained decoding underneath; `askConstrained` sends the schema
object, the prompt string, temperature 0 and a small token ceiling.

Two details worth knowing. The call sends **one user message and no system
message**, which is the shape the verdict prompts were measured under —
`/v1/completions` would take the string raw, past the chat template, and hand
the model something it was never trained to read. And a degradation stays a
degradation: one bad call must not end a stage making hundreds of tiny ones.

**analyze's concurrency default is 12 like the others.** It was 1 under the
serial server this engine no longer speaks to, and a pool never moved a verdict
there either. The pool dispatches in the same strongest-first order Owen ruled,
and the findings are composed by walking the jobs' own order afterwards, so
what a pool changes is how long the stage takes and never what it wrote.

---

## 3. The four things the door does that needed code, not just a URL

1. **The context window is the server's.** It is fixed when the model is made
   resident and the KV cache is pre-allocated against it; there is no
   per-request window field and none is invented. `/v1/models` reports
   `max_model_len`, and `capFor` clamps `max_tokens` against it (prompt
   estimated pessimistically at 2.5 chars/token plus slack), because the server
   answers an over-long request with a **400**. **And a request that cannot
   fit is refused before it is sent**: when the prompt alone leaves under 128
   tokens, `capFor` would send a cap that cannot hold an edit list and the
   truncated answer would be counted as a parse failure — the model blamed for
   a request that could never have been answered. `clean-text` knows its longest
   request before the first one goes out, measures it against the window
   (`fitsWindow`), and stops by name — the block's length, the window, the
   model — with nothing asked. A server that reported no window is not
   second-guessed; it says so itself on the first request.

2. **The thinking switch is advisory.** It is an argument handed to the Jinja
   chat template, and a template or build that ignores it would put a
   `<think>…</think>` block in front of every answer in the book. So
   `withoutThinking` strips exactly that — a block at the very front, with its
   closing tag present, and nothing else. A `<think>` mid-answer belongs to the
   text; an unterminated one is a truncation the validators must be allowed to
   see. The server is growing per-model sampling and thinking defaults applied
   on its side; until they land the switch is still sent, and nothing new is
   built on it.

3. **The model may be unnamed.** The server holds ONE resident model, the one
   the operator put there, and naming it on a command line is asking somebody
   to retype a choice already made. So an absent `--model` means *whatever is
   served*; the engine asks, uses it, logs it, and records it. A name that WAS
   given is still proved, and a mismatch is refused with both names in the
   sentence — and the engine never loads the one it wanted instead (§5).

4. **The served name is resolved before any cache key is computed.**
   `clean-text` hashes the model into every block's records key (`cleanKey`) and
   `translate` hashes it into the bank key, so a run that learned the name late
   would file its answers under a name that did not answer. `src/clean/run.ts`
   and `src/clean/epub.ts` therefore resolve it up front — **the one case where
   a run with nothing left to ask still touches the server**, which is honest: a
   run that did not name its model cannot know what it already answered.

---

## 4. Consequence to expect: banks and records do not carry across

The model name is part of the cache key on purpose ("two models are two
different answers"). `qwen3.5:9b-q8_0` and `Qwen/Qwen3.5-9B` are two strings, so
a book cleaned through Ollama re-asks every block when it is next cleaned
through vLLM. That is correct rather than a defect — different weights served by
different stacks at a different precision are a different answer — and it is
also the reason to pick one server per machine and stay there.

**Nothing already on disk is invalidated by this change.** No version constant
moved, the stamp's shape is untouched, and every existing book, records file,
bank and stamp reads exactly as before.

### RULED 2026-09-08: the key stays verbatim, and is not canonicalised

Raised from the Mac: the same weights at the same precision carry three
spellings across Owen's two machines — `qwen3.5:9b-mlx-bf16` (Ollama's MLX
runner), `qwen3.5:9b-bf16` (Ollama's llama.cpp), `Qwen3.5-9B-bf16` (the vLLM
served name) — and the projects live on a shared library, so a book cleaned on
one machine re-asks every block on the other. The proposal was a small table
mapping known spellings onto a canonical *weights + precision* id.

**Refused, and here is the argument, so it is not re-had.**

The key answers exactly one question — *may this answer be reused?* — and the
table would answer **yes** for a pair nobody has measured. The same weights
through different kernels, different sampler code and different tokenizer edge
handling agree on most blocks at temperature 0 and are not known to agree on all
of them.

Its failure modes point the wrong way. A MISSING entry costs GPU: loud,
recoverable, obvious. A WRONG entry silently ships a book carrying answers from a
stack that never produced them, and nothing downstream can tell.

And it would be keyed on a string somebody types at server launch. §6 makes
`--served-model-name` the provenance record precisely because foundry cannot
discover a precision; making that same string decide cache identity would let a
typo at launch change which answers a book inherits — one string doing two jobs,
and the second one failing quietly.

So a different stack is a different sampler, the key says so, and a cross-machine
re-clean is the price.

**Offered and NOT built** (Owen's to want): a run whose model differs from the
one named in the stamp beside the records could say so in its opening sentence,
before it asks anything — *"this book's records were written by X; this run is Y,
so every block is asked again."* One line, no new state, no table. It turns the
re-clean from a discovery into a fact somebody can act on.

**Filed separately, and NOT under this ruling:** two machines writing one
project on a shared library have no coordination, and that behaves the same
whatever the spellings are. The records file appends, so nothing is lost from it,
but materialisation takes the LAST row per position and the stamp is a single
file replaced outright — so the later run's text and its claim about the model
win. Identical keys would have made the second run cheap, not safe. BookForge
holds it as its own open item.

---

## 5. Who owns the server's life — RULED, and not Foundry

**The engine never loads a model and never unloads one.** Ruled 2026-09-13
with the BookForge session, which owns the door shapes: the operator makes a
model resident before a pass is spawned (the app does it on the operator's
action, through the service's job API), a load EVICTS whatever else was on the
card, and only one model is resident at a time — so a pass that loaded its own
model would be one job taking a narrator's voice off the card mid-sentence. A
server answering but holding the wrong model is therefore a refusal **by
name**, naming what is resident instead, and the run stops. There is no
release: a pass ending is not a reason to take a model off. The paragraph
below is the older half of the same rule, kept because it is still true.

A vLLM process **is** its model: the weights load at launch, the KV cache is
allocated against them, and there is no request that means "let go". The only
way to free the card is to stop the process — and a text pass must not do that,
because the thing that decides when a 24 GB card changes hands has to watch
*every* job, not one of them. BookForge's GPU arbiter owns starting and stopping
it (their 2026-09-08 plan: the same arbiter that brackets a Higgs render). From
foundry's side the endpoint is simply up when it is invoked. This is exactly
what `src/translate/transport.ts`'s header says about a server somebody else
runs, applied to a server whose lifetime somebody else really does own.

---

## 6. The stamp records the model, and that is the whole record

The narration stamp (`bookforge:narration-text`) carries `model`, and under vLLM
that field holds the **served id**. No new field, no `stampVersion` bump, no
change to the cross-repo contract BookForge reads.

An earlier design (shelved 2026-09-08, before this was built) added an optional
`precision` key. It is not built, and deliberately: foundry cannot *discover* a
server's precision — `/v1/models` does not report dtype — so the value could only
come from a flag somebody remembers to set, and a stamp confidently naming the
wrong precision is worse than one that names none.

**So the served name must be honest.** `vllm serve --served-model-name` decides
what every cleaned book claims about itself. Name it for what it is —
`Qwen3.5-9B-bf16` — rather than mimicking an Ollama tag, or two books cleaned at
two precisions become byte-indistinguishable in their records.

Whatever the value, **it is recorded and surfaced, never gated on**: gating
would re-clean the library the day somebody changed precision.

---

## 7. Running one (the PC, 2026-09-08)

vLLM is already installed in WSL here — 0.28.0 in `higgs3`, 0.7.3 in
`orpheus_tts` — so this is a launch, not an install. Weights belong on ext4
inside the distro, never under `/mnt`, or the server loads them over 9p.

```bash
vllm serve <model> \
  --served-model-name <the honest name §6> \
  --port 8300 \
  --max-model-len 8192 \
  --enable-prefix-caching
```

- **CUDA graphs are on by default** — that is `enforce_eager` being false, so
  the thing to do about them is *not pass `--enforce-eager`*. There is nothing
  for foundry to configure.
- **Prefix caching pays, and pays in COMPUTE rather than in batch depth.** All
  four acts send the same long system prompt on every block; with prefix caching
  its prefill is done once for the whole book instead of once per block, which
  the first live run confirmed at a 95% hit rate. What it does NOT buy on these
  particular models is room for more requests — see the hybrid note below.
- `--max-model-len` is what `capFor` reads back through `/v1/models`. It caps
  how long ONE sequence may get and reserves nothing; 8192 matches what the
  Ollama path pinned for translate.
- Then in the app: **Settings → Language model**, with the URL and
  (optionally) the served model beside it. The four dialogs open against it
  from that moment; the queue puts `--endpoint <url>` on every line it
  composes. (The server-kind switch this line once described is gone with the
  second dialect; the picker rework that reads the service's capability
  record replaces the model field.)

### What decides the batch depth on THESE models (measured 2026-09-08)

Worth writing down because both sessions guessed it wrong twice before reading
the config. The Qwen 3.5 9B and 3.8 27B are **hybrid**: three of every four
layers are linear attention (Gated DeltaNet) carrying a fixed-size recurrent
state per sequence, and only one in four is full attention with a KV cache.

The consequence is that the ordinary reasoning about KV does not apply. Per-token
KV is tiny — tens of kilobytes — but the per-sequence recurrent state is tens to
hundreds of megabytes, and vLLM's hybrid allocator pads the attention page to
match that state. A sequence therefore costs pages of roughly 1,600 tokens
rather than 16. That is why a 3.3 GB pool on the 9B reported 22,420 tokens and
admitted **7** concurrent: page granularity, not bytes.

So on these models:

- **`--kv-cache-dtype fp8` buys little.** KV is already the small half.
- **Prefix caching buys little DEPTH** (pages are too coarse to share much),
  though it still buys the prefill compute above.
- **`--mamba-ssm-cache-dtype float16` is the knob that matters** — it halves the
  state and therefore the page, and therefore roughly doubles how many sequences
  are admitted.

None of this reaches foundry: `--concurrency` asks for a number in flight and
vLLM admits what it can, queueing the rest. Twelve against an admission of seven
is the harmless direction. It is recorded here so the next person sizing a run
starts from the right mechanism.

---

## 8. What was deliberately not done

- **analyze's NLI ranker is untouched.** It is a resident Python worker with its
  own model and its own lifecycle; none of this reaches it, and the ranking half
  of a run costs exactly what it always cost.
- **The 27B is unmeasured.** The 9B has now been measured (§9) and the 27B has
  not: it is a 21 GB 4-bit build on a 24 GB card, so its batch depth is the open
  question, and every number about it in this file is arithmetic rather than a
  reading.
- **The concurrency default of 12 is not a measurement either.** It is the
  number `DEFAULT_VLM_CONCURRENCY` was measured at against a vLLM on this
  project's own hardware, borrowed because it is the same scheduler being fed.
  `--concurrency` overrides it, and on a small card that is the first flag to
  reach for.
- **No tests were added** (house rule: none unasked). None was invalidated —
  823 still pass.

---

## 9. The first live run — measured 2026-09-08

BookForge's launcher, Qwen3.5-9B-bf16 on port 8300, WSL, RTX 3090 Ti; foundry
19f5e70 through BookForge's own CLI clean door with `--server vllm` and no
`--model`.

| | Ollama | vLLM |
|---|---|---|
| clean-text, 1,001 blocks | 110 blocks/min | **458 blocks/min** (131 s) |

**4.2×**, and not the ceiling: seven requests decoding with three queued, a
95% prefix-cache hit rate, the card at 99%, and a 3.3 GB pool left after 18.3 GB
of weights at `gpu_memory_utilization` 0.90.

Two things this proved beyond the speed. The **discovery path**: `--model` was
omitted, the run asked the server, and the stamp records `Qwen3.5-9B-bf16` — the
served name really is the record (§6). And that **the pass did not change what it
decides**: 209 blocks changed and 99 edits refused, the shapes an Ollama run of
the same book gives.

---

## 10. Headers an endpoint wants — added 2026-09-13

A server can sit behind something that wants to know who is calling. The one
this was built against wants two headers on every request: a bearer token it
minted, and a constant naming the API version the caller speaks. A request
missing the second is refused with **426**, not 401, which is worth knowing
because it looks nothing like an authentication failure.

**Foundry carries an opaque MAP, not a token.** One environment variable:

```
FOUNDRY_ENDPOINT_HEADERS={"Authorization":"Bearer <token>","X-Crucible-Api":"1"}
```

Every request to the endpoint carries every pair in it, on **both** doors — the
page reader and the four text acts. Foundry does not know which pair is the
credential and does not need to; the day a server wants a third header, or a
different one, or none, nothing in `src/` changes. That is deliberate: a
`FOUNDRY_API_TOKEN` would have carried the secret and left the version constant
to be hardcoded, which is teaching this program what one particular product is,
inside files whose whole job is to know only that something at a URL speaks
OpenAI. **The word for that product does not appear in `src/`.**

### Why the environment, and never a flag

A command line is the most copied thing a program has — pasted into bug reports,
printed by the queue that composed it (`app/electron/job-queue.ts` can spell one
without spawning it), listed by the process table, remembered by shells. A secret
on one is a secret in all of those afterwards.

The settings file is the honest alternative and loses on one point.
`fromFlagOrSettings` **prints** a settings-sourced value into the run log,
deliberately — a run reading through an endpoint nobody typed must say where the
URL came from, or the file becomes spooky action. Keeping a secret out of a code
path that prints values *by design* is a rule somebody has to remember every time
that code is touched. The environment's weakness is inheritance, and that is
fixed **once, mechanically**, at each spawn. A mechanical fix beats a remembered
one.

So `backend.endpointHeaders` in `settings.json` exists as the fallback for a
person running the CLI by hand, the environment wins when both are present, and
that one setting is the only one never echoed.

### What it refuses

- **A malformed map refuses the run**, never gets dropped. Dropping it would
  either fail at the server with an error about something else, or — worse —
  reach a server that does not require the headers and *succeed*, having
  silently stopped doing what it was configured to do.
- `content-type`, `content-length` and `host` are refused by name: foundry sets
  them, and a map that changed `content-type` would describe the body as
  something it is not.
- **No error ever quotes a value.** They name the key and where the map came
  from. A message that printed the value to be helpful would write the token into
  the log this design exists to keep it out of.

### The rasteriser never sees it

`src/vlm/bridge.ts` spawns Python three times, and all three now pass an explicit
`env` with the map removed. `vlm_page.py` renders pages and runs MLX locally and
makes no HTTP request at all, so a credential in its environment could only leak,
never be used. It **strips** rather than allowlists: an allowlist breaks the first
time somebody adds a fourth spawn, and the repair for that is always to pass
everything again, which puts the secret back.

## 11. Two refusals that used to look identical

**The page reader now asks what the server serves.** It used to send a model name
and hope, so every way that could be wrong arrived as the same bare 4xx on page
one — wrong weights, nothing resident, a name that moved when an upstream org
renamed itself, the wrong machine entirely. One listing separates them, against a
run about to cost GPU-minutes a page.

A server that **will not** list is allowed to proceed, and says so. Strict about
what it claims to understand, silent about what it makes no claim about: a server
that answers the listing has stated what it serves, and a name absent from that
statement is worth refusing; a server that does not answer has stated nothing,
and refusing there would break working setups over a check the server never
agreed to. That is the absence of a check said out loud, not a fallback.

It runs **behind the same seam as the reading it guards** (`VlmBridge.confirmModel`).
A caller injecting a bridge is saying nothing in this run reaches the outside
world, and a check that went straight to `fetch` would have made that false — the
suite would have started depending on whatever was listening on port 8000.

**A text act refuses a page-reading model.** vLLM's default port is 8000, a
reading server is usually on 8000, and this program shipped 8000 as the default
for *both* doors. Turn the text acts to `vllm`, leave the URL alone, and a cleanup
dialled a vision model — and because a text act with no `--model` asks the server
what it serves and *accepts the answer*, nothing refused. The prose went to a page
reader, the answer was banked under that model's name, and the name was stamped
into the EPUB as provenance: **a wrong answer, cached, recorded as true.**

Moving the default port would have made that rarer without making it less severe.
So `isPageReadingModel` (`src/vlm/models.ts`) is asked instead, matching on the
segment after the last slash so a renamed org or an MLX conversion still matches,
and the refusal names the shared-port cause.

**Both are the same correction**, and it is worth naming because it will come up
again: *adopting a discovered name instead of asserting an intended one.*
`requireServedModel` was already right about this — it compares and refuses rather
than adopting — which is why the fix for one door was the fix for the other.
