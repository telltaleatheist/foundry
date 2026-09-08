# vLLM for the three text acts — `--server vllm`

Owen, 2026-09-08: *"lets build in vllm batching. ollama batching doesnt work.
its an unfinished feature ollama tried to implement but isnt accessible on the
mac or pc. cuda graphs/vllm would probably be the best for all three features.
go ahead."*

The three features are **translate**, **simplify** (`translate --rewrite`) and
the **narration cleanup** (`clean-text`). All three now run against either an
Ollama or a vLLM, chosen by a flag, with nothing else about the pass changed.

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
| `--concurrency` default | 4 | 12 |
| `--keep-model` / release | `keep_alive: 0` on a bodyless call | **a declared no-op** (§5) |

Unchanged on both: the prompts byte for byte, the temperature, the retries, the
validators, the records/bank cache, the stamp, `NORMALIZER_VERSION`,
`PUNCTUATION_SPEC_VERSION`. **A book cleaned through Ollama and the same book
cleaned through vLLM are the same pass asked of different plumbing.**

Files: `src/translate/vllm.ts` (the transport), `src/translate/model-server.ts`
(the one place that chooses), and three call sites — `src/translate/run.ts`,
`src/clean/run.ts`, `src/clean/epub.ts`.

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
- **Prefix caching pays here specifically.** All three acts send the same long
  system prompt on every block; with prefix caching its KV is computed once for
  the whole book instead of once per block.
- `--max-model-len` is what `capFor` reads back through `/v1/models`. Setting it
  short buys KV cache for a bigger batch and lowers the ceiling on a long
  paragraph's answer; 8192 matches what the Ollama path pinned for translate.
- Then in the app: **Settings → Language model → Server → vLLM**, with the URL
  and (optionally) the served model beside it. The three dialogs open against it
  from that moment; the queue puts `--server vllm` on every line it composes.

---

## 8. What was deliberately not done

- **`analyze` still speaks Ollama only.** It was not in the ask, its engine path
  (`src/analyze/run.ts`) calls the Ollama client directly, and it has a second
  model (the NLI worker) with its own lifecycle. Adding it is a small piece of
  the same shape when somebody wants it.
- **No measurement.** Nothing here claims a speedup. The pool's real gain
  against a real vLLM is Owen's to measure on his own card, which is also the
  only card the answer would be true of.
- **The concurrency default of 12 is not a measurement either.** It is the
  number `DEFAULT_VLM_CONCURRENCY` was measured at against a vLLM on this
  project's own hardware, borrowed because it is the same scheduler being fed.
  `--concurrency` overrides it, and on a small card that is the first flag to
  reach for.
- **No tests were added** (house rule: none unasked). None was invalidated —
  823 still pass.
