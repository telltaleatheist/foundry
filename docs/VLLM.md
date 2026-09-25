# The three inference doors for the text acts

> **2026-09-14 — THE LOCAL DOOR IS BACK, AND A CLOUD ONE JOINED IT.** For one night this
> document said there was a single OpenAI-compatible door and that Foundry could
> not run without an inference service. Owen reversed the premise the same night
> and **docs/SLOTS.md is the plan of record**: *"foundry should be prepared to
> operate without crucible present. it should do translation through ollama,
> simplify, analyze, VLM pdf conversion, all of it — but it should go through the
> normal doors accessible on windows or mac. if we want the speed tricks, we can
> connect to a crucible server."* So `--server openai|ollama` is back, declared
> and never sniffed, and with it `num_ctx`, `/api/tags` and the release at the
> end of a run. Two things did NOT come back: there is no `--keep-model` (the
> Ollama unload is unconditional, Package A's headline ruling) and there are no
> act-level model defaults (`--model` is REQUIRED on Ollama, refused by name when
> it is absent). The `openai` KIND was spelled `vllm` before — renamed because
> that door serves Crucible, a local llama-server, a vLLM and OpenAI's own API
> alike; `src/translate/vllm.ts` keeps its filename so this document's
> measurements keep their addresses. **A THIRD DOOR LANDED THE SAME DAY**:
> `--server anthropic` (Package F, docs/SLOTS.md §6), which is a dialect and
> not a URL — `/v1/messages`, a top-level `system`, content blocks, a forced
> tool for a constrained answer. The current contract is §§1–5.

Owen, 2026-09-08, the ruling that put the door in: *"lets build in vllm
batching. ollama batching doesnt work. its an unfinished feature ollama tried to
implement but isnt accessible on the mac or pc. cuda graphs/vllm would probably
be the best for all three features. go ahead."*

The acts are **translate**, **simplify** (`translate --rewrite`), the
**narration cleanup** (`clean-text`) and **analyze**. All four speak to whichever
door `--server` names, and nothing a pass DECIDES changes with it.

---

## 1. Why, in one paragraph

Every one of the acts is a POOL of requests over a book of thousands of blocks —
twelve in flight by default on the OpenAI door, four on Ollama and four on a
cloud provider (§2a says why a provider's four is a rate limit rather than a
card). A pool only pays
if the server runs the requests *together*, and that is what the OpenAI door is
for: continuous batching, one CUDA graph replayed across the batch, and
throughput that climbs with the number of requests in flight. **The pool is the
prerequisite and batching is the payoff**: the server's *single-stream* latency
is no better than a serial runner's, so a serial caller hands it a batch of one
and gains nothing. Ollama is the door that is simply THERE on a person's own
machine — it batches far less well, which is why its default is smaller and why
the OpenAI door is the speed tier rather than the only one.

---

## 2. The flags, and what the engine decides for itself

```
foundry translate  … [--server <openai|ollama|anthropic>] [--endpoint <url>] [--model <name>] [--concurrency <n>]
foundry clean-text … [--server <openai|ollama|anthropic>] [--endpoint <url>] [--model <name>] [--concurrency <n>]
foundry analyze    … [--server <openai|ollama|anthropic>] [--endpoint <url>] [--model <name>] [--concurrency <n>]
```

`--server` is **declared, never sniffed from the URL**, and an unknown value is
refused by name (`--server takes openai, ollama or anthropic, not "x"`). A sniff
gets it right until it doesn't — a proxy in front of both, an Ollama on 8000
because somebody moved it — and what a wrong guess costs is not an error but a
book translated by a model nobody chose.

`--endpoint` is the server. Absent on the `openai` door, the engine reads
`backend.endpointUrl` from its settings — **the same setting the reading door
reads**, because on that door it is the same server: the page reader and the text
models are made resident on it in turn. Absent on `ollama` it is
`http://localhost:11434` and absent on `anthropic` it is
`https://api.anthropic.com`, and the SETTING IS NOT CONSULTED on either: handing
an OpenAI-compatible URL to a run about to speak `/api/tags` or `/v1/messages`
would point a person's local or cloud job at their vLLM. The app passes the flag
on every line it composes, so a job never depends on the engine's fallback.

| | `openai` (default) | `ollama` | `anthropic` |
|---|---|---|---|
| Who is on the other end | Crucible, a local llama-server, a vLLM, **or OpenAI's own API** | the friend's own Ollama | Anthropic's API, or a proxy that speaks it |
| Route | `POST /v1/chat/completions` | `POST /api/chat` | `POST /v1/messages` |
| The system prompt | a `{role:'system'}` message | a `{role:'system'}` message | a top-level `system` field |
| Credential | whatever the header map holds (`Authorization: Bearer …` at OpenAI) | none | `x-api-key` from the header map; `anthropic-version: 2023-06-01` is added by the ENGINE, because it is a property of the dialect and not of the endpoint |
| Model proof | `GET /v1/models`, exact id match; the listing's `id` is what every record names | `GET /api/tags`, exact tag or its `:latest`; the refusal lists what it HAS | `GET /v1/models`, exact id match — and a listing that does not answer SKIPS the check OUT LOUD rather than refusing |
| `--model` absent | **the served model**, resolved before any cache key and recorded; over more than one it is refused, quoting up to twelve ids and counting the rest | **refused by name** — an Ollama holds a library, and there is no act-level default to fall back on | **refused by name** — a provider holds a catalog, which is the same argument |
| Thinking switch | `chat_template_kwargs: {enable_thinking: false}` for the qwen3 family — on its way to a server-side manifest default. No `gpt-*` or `o*` name matches that rule, so a provider never sees the field | `think: false`, same family rule, and never on a model without thinking support (qwen2.5 answers a 400 naming the field) | **nothing is sent** — Claude models do not reason unless asked, so the absence of a field is the setting |
| Context window | the server's, read back as `max_model_len`; a request is sized INTO it, and one that cannot fit is refused by name before it is sent. A provider publishes none, so `capFor` gets null and the wanted budget goes out unclamped | `num_ctx` per request, PINNED once a book (`contextWindowFor`) or once a stage (`stageNumCtx`), because Ollama reloads the runner on any change | the provider's: nothing read back, nothing pinned, nothing measured |
| The constrained answer (`analyze`) | `response_format: {type:'json_schema', json_schema:{…, strict:true}` | `format: <the schema object>` on `/api/generate` | one tool whose `input_schema` IS that schema, forced with `tool_choice: {type:'tool', name}`; the verdict is read from the `tool_use` block's `input` |
| Truncation signal | `finish_reason === 'length'` | `done_reason === 'length'` | `stop_reason === 'max_tokens'` |
| A 429 | **waited out**, not the end of the run (§2a) | never asked for — Ollama queues instead | **waited out**, and a 529 "overloaded" with it |
| `--concurrency` default | 12 (`DEFAULT_TEXT_CONCURRENCY`) on an anonymous vLLM; on a **Crucible chat door** the server's own stated `chat.max_in_flight`, and 4 (`CRUCIBLE_CHAT_CONCURRENCY`) when it states none — §2b | 4 (`DEFAULT_OLLAMA_CONCURRENCY`) | 4 (`DEFAULT_CLOUD_CONCURRENCY`) |
| Loading | **never** — the operator makes a model resident before a pass is spawned (§5) | **never** — foundry does not pull and does not warm | **never** — there is nothing to load |
| End of the run | **nothing** — a pass ending is not a reason to take a model off a card somebody else owns | **unloaded, always** (`keep_alive: 0`), success or failure, and there is no flag to keep it | **nothing** — there was never a card |

The unload is Owen's, 2026-09-13: *"ollama should always, always bring down the
model as soon as the job is done. they arent chatting with it, theyre using it
for a job and then closing the connection."* `--keep-model` existed for an Ollama
shared with other work; it is gone, because that other work reloads in seconds
where a card held by a finished job costs the next job everything.

Unchanged whichever door answers: the prompts byte for byte, the temperature,
the retries, the validators, the records/bank cache, the stamp,
`NORMALIZER_VERSION`, `PUNCTUATION_SPEC_VERSION`. A book cleaned through one and
the same book cleaned through the other are the same pass asked of different
plumbing — the bank does not carry across, and §4 says why that is right.

Files: `src/translate/transport.ts` (HTTP as a value, and the numbers and rules
every door shares — including the rate-limit wait and the usage tally),
`src/translate/vllm.ts` (the OpenAI dialect), `src/translate/ollama.ts` (the
Ollama dialect), `src/translate/anthropic.ts` (the Anthropic dialect),
`src/translate/model-server.ts` (the choice, the proof and the record), and four
call sites — `src/translate/run.ts`, `src/clean/run.ts`, `src/clean/epub.ts`,
`src/analyze/run.ts`.

### 2a. Cloud providers — Package F (Owen, 2026-09-14)

Owen: *"give them the option of connecting an api key for openai or claude
instead of using the 27b or the 9b. if the user wants to they can use usage
credits from a cloud model… for weaker systems."* **Text acts only** — page
reading stays local — and it is a deliberate per-job choice in the app, never
something `any` falls through to (docs/SLOTS.md §3).

**Only ONE of the two needed a dialect.** OpenAI's own API is an
OpenAI-compatible server, so it is the door that already existed: `--server
openai --endpoint https://api.openai.com/v1`, `--model` named because a listing
of dozens has no default, and the key in the header map as
`{"Authorization": "Bearer sk-…"}`. Anthropic is a different wire end to end,
so it is `--server anthropic`.

**What is sent.** On `anthropic`: `{model, system, messages:[{role:'user',
content}], max_tokens, temperature}` to `POST <endpoint>/v1/messages`, where
`max_tokens` is `ChatTuning.numPredict ?? answerBudget` unclamped, and the
answer is `content[0].text`. For a verdict, that body plus one tool whose
`input_schema` is the caller's schema and a `tool_choice` forcing it. On
`openai`, byte for byte what a vLLM has always been sent.

**What is NEVER sent.** No thinking switch on `anthropic` (the absence is the
setting) and none to any provider on `openai` either, because `takesThinkField`
matches the qwen3 family prefix and no hosted model name does. No window field,
no `num_ctx`, no load, no unload, no `keep_alive`. No `max_completion_tokens`:
the `openai` door sends `max_tokens` to everything, because deciding otherwise
per request would mean sniffing the URL or the model name, and the honest shape
for a provider whose wire genuinely differs is a DECLARED kind of its own —
which is exactly what `anthropic` is. A model that refuses `max_tokens` answers
400 naming the field, and that message is quoted back verbatim.

**What a 429 does.** It is a **busy signal, not a dead server** — the one
status where this program's "it will not be there on the second attempt either"
rule is exactly wrong. `withBusyWait` (transport.ts) honours `retry-after` when
the provider sends one (seconds or an HTTP date, capped at 60), else backs off
from 2 s doubling to 30 s, up to **six attempts**, LOGGING each wait with the
status, the reason and the number of seconds; after the sixth the response is
handed back untouched and the block takes its normal failure path. Anthropic's
529 "overloaded" is read the same way and is declared by that door alone. Every
other 5xx and every transport failure still ends the run. The wait lives in ONE
place both cloud doors call, and Ollama never calls it.

**What a run costs.** Both providers return token counts —
`usage.prompt_tokens`/`completion_tokens` at OpenAI,
`usage.input_tokens`/`output_tokens` at Anthropic — and they are accumulated
per run and printed as ONE line at the end, in the act's own prefix:

```
translate: 412 requests, 1,203,441 tokens in, 388,120 out
```

**foundry does not price it.** Prices change weekly and differ per key and tier;
a number invented here would be wrong in a way that looks authoritative. The app
multiplies. The tally is reset by `openModelServer`, which every run calls
exactly once before its first request, and a door that reported no usage at all
prints nothing rather than a line of zeroes.

### 2b. How many requests are in flight — the SERVER states it (2026-09-20)

**The number is `chat.max_in_flight`, published by the server on `/v1/activity`,
and 4 is the fallback for a server that states none.** Crucible 1.0.10 ADMITS
that many chat completions per engine and refuses the rest `503
chat_queue_full`, with `details.max_in_flight`, `details.max_in_flight_basis`,
`details.retry_after` and a `Retry-After` header. On the Mac's serial `mlx-lm`
it is 2 (engine concurrency 1, plus one). A vLLM behind the same door states
nothing — it batches and is not bounded — and `null` there means *"it did not
say"*, never a limit of zero.

`resolveConcurrency` (src/translate/model-server.ts) owns the whole rule and
every text act calls it:

| what | number |
|---|---|
| `--concurrency` given | that, **clamped down** to the stated maximum if it is higher |
| nothing given, Crucible states a depth | the stated depth |
| nothing given, nothing stated | `concurrencyFor` — 12 on a vLLM, 4 on a Crucible chat door, 4 on Ollama and on a provider |

**The flag does not win upwards, and that exception is paid for.** The number
arriving on `--concurrency` is most often not a person: it is
`Placement.concurrency`, composed by whatever build of the app is running, and a
running dist cannot be corrected without a restart. An admission limit is not an
opinion about throughput to be weighed against the Sep 8 knee — it is what the
other end will ACCEPT, and a pool above it is never right whoever asked for it.
A flag BELOW the stated maximum is honoured untouched: fewer is a preference the
server has no view on.

**Why it matters, measured the hard way.** On 2026-09-20 the clean pass sent
four at a server admitting two. Two were admitted and generated ~30 s blocks;
the two refused burned six attempts at the server's 4 s `Retry-After` and then
failed the whole pass on a condition seconds from clearing. Both halves are
fixed: the pool now comes from the server, and the busy wait is a CLOCK
(`REQUEST_TIMEOUT_MS`, the same budget a request gets to be answered in) rather
than six attempts — 60 attempts survives only as a guard against a server
answering `retry-after: 0` for ever. Tests:
`test/translate/chat-pool-from-server.test.ts`, and the placement's own over
real HTTP in `app/test/crucible-http.test.ts`.

**The app reads the same field for the placement** (`chatDepthFor`,
app/electron/crucible-dispatch.ts), and does so with a raw authenticated GET
rather than through the SDK: `@crucible/client` 1.0.10's `Activity.chat` parses
`in_flight` and `rows` and drops `max_in_flight`. The day the SDK carries it,
that function is one line of `client.activity()`.

### analyze asks a different KIND of question

The three text acts ask for prose. `analyze` asks a CLOSED question and
constrains the decode to the legal answers — measured both more accurate and
about five times cheaper than asking politely and parsing hopefully
(`src/analyze/verify.ts`'s header). The three doors spell that constraint three
ways and mean one thing: `response_format: {type: "json_schema"}` on a chat turn
here, `format: <the schema object>` on `/api/generate` there, and on `anthropic`
a single TOOL whose `input_schema` is that same schema object with `tool_choice`
forcing it — all three grammar-constrained decoding underneath, and the third
executes nothing: the forced call IS the answer, read from its `input` and
re-serialised so `parseVerdict` sees one string whichever door produced it.
`askConstrained` sends the schema object, the prompt string, temperature 0 and a
small token ceiling every way, and adds `num_ctx` on the Ollama side only.

**Ollama's thinking trap is ported, and it is not optional.** Measured in
briefcase with qwen3.8:27b: a JSON grammar sent to a THINKING model constrains
the whole output stream from the first token, so the model never opens an answer
channel and the object arrives in `thinking` with `response` EMPTY. So
`readGenerateAnswer` reads `thinking` when a schema WAS sent and `response` came
back empty, and never otherwise. Skip the port and the stage returns zero
verdicts against a perfectly healthy server.

Two details worth knowing. The call sends **one user message and no system
message**, which is the shape the verdict prompts were measured under —
`/v1/completions` would take the string raw, past the chat template, and hand
the model something it was never trained to read. And a degradation stays a
degradation: one bad call must not end a stage making hundreds of tiny ones.

**analyze's concurrency default is 12 like the others on the OpenAI door, and 4
on Ollama and on `anthropic`.** It was 1 on Ollama for its whole history, and four there mostly buys
queueing rather than throughput — Ollama serialises per model unless its own
parallelism was turned up — but a pool never moved a verdict on either door.
The pool dispatches in the same strongest-first order Owen ruled,
and the findings are composed by walking the jobs' own order afterwards, so
what a pool changes is how long the stage takes and never what it wrote.

---

## 3. The four things the OpenAI door does that needed code, not just a URL

*(Each of these is the half of a disagreement with Ollama that §2's table names.
Read them as "what is different over here", not as "how a text act works".)*

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

3. **The model may be unnamed HERE, and may not be on Ollama.** This server
   holds ONE resident model, the one the operator put there, and naming it on a
   command line is asking somebody to retype a choice already made. So an absent
   `--model` means *whatever is served*; the engine asks, uses it, logs it, and
   records it. A name that WAS given is still proved, and a mismatch is refused
   with both names in the sentence — and the engine never loads the one it
   wanted instead (§5). An Ollama holds a LIBRARY, so the same absence there is a
   run with no way to choose between qwen3.8:27b and llama3.1:8b; it is refused
   by name before any work, and there is no act-level default behind it. (There
   used to be: `DEFAULT_TRANSLATE_MODEL` and `DEFAULT_NORMALIZER_MODEL`. The
   first survives as an export the app's picker starts from — a picker's default,
   not a run's — and the second is not an engine fallback any more.)

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

## 5. Who owns the server's life — RULED, and it depends which door

**On Ollama, foundry never loads and ALWAYS unloads.** It does not `ollama
serve`, does not pull and does not warm anything up — a server that is not
answering ends the run naming the URL that was silent, because the person
reading that is about to type `ollama serve` and the only thing they need is
which endpoint. But the end of a run is different from every other moment: the
model comes down, success or failure, in a `finally`, best effort, because a job
is not a chat and a finished job holds no card. There is no `--keep-model`.

**On the OpenAI door the engine never loads a model and never unloads one.**
Ruled 2026-09-13
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

The narration stamp (`bookforge:narration-text`) carries `model`, and on the
`openai` door that field holds the **served id** — on `ollama` it holds the tag
that was named and proved. Either way it is the name that ANSWERED, read back
from the proved server rather than from argv. No new field, no `stampVersion`
bump, no change to the cross-repo contract BookForge reads.

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

- **THE APP NO LONGER LAUNCHES A vLLM, ANYWHERE.** Until 2026-09-13 there was a
  second half to this section: a "vLLM in WSL" card that listed distros, built a
  conda or venv environment, `pip install vllm`'d into it and then started and
  stopped the server, plus a `vllm-server.ts` in main that owned its lifetime.
  All of it is deleted (docs/SLOTS.md §6 package B; Owen: *"the plan is to leave
  VLLM to crucible only"*). A vLLM is now reached exactly the way any other
  OpenAI-compatible server is — you run it, you put its URL in Settings, and
  nothing in the app starts, stops or configures it. What the app DOES start is
  the local page reader, which is llama.cpp serving a dots.ocr GGUF and has
  nothing to do with this door (`app/electron/page-reader.ts`, docs/SETUP.md §7).

### What decides the batch depth on THESE models (measured 2026-09-08)

Worth writing down because both sessions guessed it wrong twice before reading
the config. The Qwen 3.5 9B and 3.8 27B are **hybrid**: three of every four
layers are linear attention (Gated DeltaNet) carrying a fixed-size recurrent
state per sequence, and only one in four is full attention with a KV cache.

The consequence is that the ordinary reasoning about KV does not apply. Per-token
KV is tiny — tens of kilobytes — but the per-sequence recurrent state is large
enough to set the granularity of the whole pool, and vLLM's hybrid allocator
unifies every layer's page to the largest: a Mamba page comes from the state's
shapes and does not scale with `block_size`, so it is the ATTENTION layers that
get scaled UP to match (`new_block_size = layer_spec.block_size * ratio`,
`v1/core/kv_cache_utils.py`). A sequence therefore costs pages of roughly 1,600
tokens rather than 16. That is why a 3.3 GB pool on the 9B reported 22,420
tokens and admitted **7** concurrent: page granularity, not bytes.

So on these models:

- **`--kv-cache-dtype fp8` buys little.** KV is already the small half.
- **Prefix caching buys little DEPTH** (pages are too coarse to share much),
  though it still buys the prefill compute above.
- **`--mamba-ssm-cache-dtype` IS ALREADY AT ITS FLOOR, and this file said
  otherwise until 2026-09-15.** It claimed `float16` "halves the state and
  therefore roughly doubles admission". It does not, and the correction is
  BookForge's, read out of the pinned vLLM 0.29.0 source rather than reasoned:
  `MambaSpec.page_size_bytes` ← `state_content_size_bytes` ← `qwen3_5.py`'s
  `get_mamba_state_dtype_from_config` → `gated_delta_net_state_dtype` →
  `_mamba_state_dtype`, where **`auto` resolves to the MODEL's dtype** and
  `mamba_ssm_cache_dtype: auto` copies it. Both checkpoints declare
  `dtype: bfloat16`, so the state is already 16-bit; `float16` is two bytes
  against `bfloat16`'s two. There is nothing smaller to reach for either —
  `MambaDType` is `auto | float32 | float16 | bfloat16` and there is no fp8.
  **The "tens to hundreds of megabytes" figure this file used to quote is the
  fp32 HYPOTHETICAL**, not what ran: ~50 MB on the 9B at fp32 is ~25 MiB at
  bf16. fp32 is real for other architectures (`kda_state_dtype` pins its
  temporal state to float32) but Qwen3.5/3.8 take the gated-delta-net path, and
  nobody ever set a non-`auto` value on either side. Recorded at this length so
  that nobody spends a card run on the knob later.

None of this reaches foundry: `--concurrency` asks for a number in flight and
vLLM admits what it can, queueing the rest. Twelve against an admission of seven
is the harmless direction. It is recorded here so the next person sizing a run
starts from the right mechanism.

---

## 8. What was deliberately not done

- **analyze's NLI ranker is untouched.** It is a resident Python worker with its
  own model and its own lifecycle; none of this reaches it, and the ranking half
  of a run costs exactly what it always cost. (Since 2026-09-25 the ranker is a
  Crucible decide pass, `analyze-rank` — docs/ANALYSIS.md §4 — and still none
  of this reaches it.)
- **The 27B is unmeasured.** The 9B has now been measured (§9) and the 27B has
  not: it is a 21 GB 4-bit build on a 24 GB card, so its batch depth is the open
  question, and every number about it in this file is arithmetic rather than a
  reading.
- **The concurrency default of 12 is not a measurement either.** It is the
  number `DEFAULT_VLM_CONCURRENCY` was measured at against a vLLM on this
  project's own hardware, borrowed because it is the same scheduler being fed.
  `--concurrency` overrides it, and on a small card that is the first flag to
  reach for. It is also only reached now when no server states a depth of its
  own — see §2b.
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
