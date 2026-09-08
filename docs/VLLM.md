# vLLM for the three text acts — `--server vllm`

Owen, 2026-09-08: *"lets build in vllm batching. ollama batching doesnt work.
its an unfinished feature ollama tried to implement but isnt accessible on the
mac or pc. cuda graphs/vllm would probably be the best for all three features.
go ahead."*

The three features are **translate**, **simplify** (`translate --rewrite`) and
the **narration cleanup** (`clean-text`). **analyze** joined them an hour later —
Owen: *"lets add analyze. why not."* All four now run against either an Ollama or
a vLLM, chosen by a flag, with nothing else about the pass changed.

---

## 1. Why, in one paragraph

Every one of the three acts is a POOL of requests over a book of thousands of
blocks — four in flight by default. A pool only pays if the server runs the
requests *together*. That is what vLLM is for: continuous batching, one CUDA
graph replayed across the batch, and throughput that climbs with the number of
requests in flight. Ollama's own batching is not reachable on either of Owen's
machines, so a pool against Ollama queues. **The pool is the prerequisite and
vLLM is the payoff**: vLLM's *single-stream* latency is no better than
llama.cpp's, so a serial caller hands it a batch of one and gains nothing.

---

## 2. The flag, and everything it decides

```
foundry translate  … [--server ollama|vllm] [--ollama <url>]   [--model <name>]
foundry clean-text … [--server ollama|vllm] [--endpoint <url>] [--model <name>]
foundry analyze    … [--server ollama|vllm] [--ollama <url>]   [--model <name>]
```

`--server` is **declared, never sniffed from the URL**. A sniff is right until a
proxy sits in front of both, or somebody moved an Ollama onto 8000; and what a
wrong guess costs is not an error but a book run by a model nobody chose. A
person who launched a vLLM knows they launched one.

What the choice changes, and nothing else does:

| | `ollama` (default) | `vllm` |
|---|---|---|
| Endpoint default | `http://localhost:11434` | `http://localhost:8000/v1` |
| Route | `POST /api/chat` | `POST /v1/chat/completions` |
| Model proof | `GET /api/tags`, exact tag match | `GET /v1/models`, exact id match |
| `--model` absent | the act's declared default | **the served model**, resolved and recorded |
| No-think switch | `think: false` (a real field) | `chat_template_kwargs: {enable_thinking: false}` |
| Context window | `num_ctx` per request, pinned once a book | the server's `--max-model-len`, fixed at launch |
| `--concurrency` default | 4 (analyze: 1) | 12 |
| `--keep-model` / release | `keep_alive: 0` on a bodyless call | **a declared no-op** (§5) |

Unchanged on both: the prompts byte for byte, the temperature, the retries, the
validators, the records/bank cache, the stamp, `NORMALIZER_VERSION`,
`PUNCTUATION_SPEC_VERSION`. **A book cleaned through Ollama and the same book
cleaned through vLLM are the same pass asked of different plumbing.**

Files: `src/translate/vllm.ts` (the transport), `src/translate/model-server.ts`
(the one place that chooses), and four call sites — `src/translate/run.ts`,
`src/clean/run.ts`, `src/clean/epub.ts`, `src/analyze/run.ts`.

### analyze asks a different KIND of question, and that needed its own branch

The three text acts ask for prose on `/api/chat`. `analyze` (and `tag`) ask a
CLOSED question and constrain the decode to the legal answers — measured both
more accurate and about five times cheaper than asking politely and parsing
hopefully (`src/analyze/verify.ts`'s header). Ollama takes the schema as
`format` on `/api/generate`; the OpenAI spelling is
`response_format: {type: "json_schema"}`, which vLLM implements with the same
grammar-constrained decoding underneath. So `askConstrained` dispatches on the
server and both branches send the same schema object, the same prompt string,
the same temperature 0 and the same token ceiling.

Two details worth knowing. The vLLM call sends **one user message and no system
message**, because Ollama's `/api/generate` applies the chat template to
`prompt` — `/v1/completions` would be the literal counterpart of the route and
the wrong counterpart of the request, handing the model an untemplated string.
And a degradation stays a degradation on both routes: one bad call must not end a
stage making hundreds of tiny ones.

**analyze's concurrency default is 1, not 4.** Its stage was deliberately
sequential — Ollama serialises per model anyway, so a pool there buys queueing —
and that is unchanged: an Ollama run is byte for byte the run it always was. Under
vLLM it becomes 12, and the stage (hundreds of tiny closed questions over one
loaded model) is the shape that gains most. The pool dispatches in the same
strongest-first order Owen ruled, and the findings are composed by walking the
jobs' own order afterwards, so what a pool changes is how long the stage takes
and never what it wrote.

`foundry tag` asks its two closed questions through the same door and therefore
already speaks both dialects — it simply has no `--server` flag yet, which is
now the whole of what adding it would take.

---

## 3. The four differences that needed code, not just a URL

1. **The context window is the server's.** vLLM fixes it at launch and
   pre-allocates the KV cache against it; there is no per-request `num_ctx`. So
   `ChatTuning.numCtx` is *dropped* on this route rather than translated into
   something. `/v1/models` reports `max_model_len`, and `capFor` clamps
   `max_tokens` against it (prompt estimated pessimistically at 2.5 chars/token
   plus slack), because vLLM answers an over-long request with a **400** where
   Ollama would simply have generated less. `clean-text`'s "context pinned"
   log line says so instead of claiming a pin that did not happen.

2. **The thinking switch is advisory.** Ollama's `think: false` is enforced by
   the server. vLLM's equivalent is an argument handed to the Jinja chat
   template, and a template or build that ignores it would put a
   `<think>…</think>` block in front of every answer in the book. So
   `withoutThinking` strips exactly that — a block at the very front, with its
   closing tag present, and nothing else. A `<think>` mid-answer belongs to the
   text; an unterminated one is a truncation the validators must be allowed to
   see.

3. **The model may be unnamed.** An Ollama holds a library, so a run must say
   which model it means. A vLLM process serves the model it was launched with
   and no other, and naming it on a command line is asking somebody to retype an
   HF path exactly right. So an absent `--model` means *whatever is served*; the
   engine asks, uses it, logs it, and records it. A name that WAS given is still
   proved, and a mismatch is refused with both names in the sentence.

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

`releaseModel` answers `not-ours` under vLLM and both callers say so out loud.

A vLLM process **is** its model: the weights load at launch, the KV cache is
allocated against them, and there is no request that means "let go". The only
way to free the card is to stop the process — and a text pass must not do that,
because the thing that decides when a 24 GB card changes hands has to watch
*every* job, not one of them. BookForge's GPU arbiter owns starting and stopping
it (their 2026-09-08 plan: the same arbiter that brackets a Higgs render). From
foundry's side the endpoint is simply up when it is invoked. This is exactly
what `src/translate/ollama.ts`'s header has always said about a server somebody
else runs, applied to a server whose lifetime somebody else really does own.

`--keep-model` is therefore moot under vLLM: nothing is unloaded either way.

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
- Then in the app: **Settings → Language model → Server → vLLM**, with the URL
  and (optionally) the served model beside it. The four dialogs open against it
  from that moment; the queue puts `--server vllm` on every line it composes.

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

- **`foundry tag` has no `--server` flag.** Its two closed questions go through
  the same `askConstrained` door analyze uses, so the transport is already there;
  only the option and its pass-through are missing.
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
