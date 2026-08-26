# Analysis — the book, read against the categories

Owen, 2026-08-25: *"it goes through a book and flags all the psychotic stuff.
jehovahs witness anti evolution material, christian nationalist books, project
2025, etc."* — *"it should light up/highlight text that matches the categories,
and have a list of hits in blocks on the right side, where compare would
normally be"* — *"the analysis can probably live as another step under the step
it was run against, just like the regular workflow."*

This file is the contract. The engine half is §2–§5, the app half is §6–§8,
and §9 is what is deliberately not being built, out loud.

---

## 1. Where the method comes from, and what it is not

The method is **briefcase's measured flag pipeline**
(`briefcase/backend/src/analysis/nli-ranker.service.ts` and neighbours),
ported, not reinvented. BookForge's old book-analysis is **deprecated and is
not the model**: it asked an LLM to read a chapter and discover quotes, which
fails the way open-ended discovery always fails — the model returns the two or
three most obvious hits and stops — and then fuzzy-matched the (often
reworded) quotes back into the book, which is why a whole recovery module
exists over there. Foundry has block identity; nothing here matches a quote to
anything, ever.

Three stages, each doing the half the engine is actually good at:

1. **RANK** — every sentence, and every sliding 3-sentence window, scored
   against every enabled category's stance hypotheses by a zero-shot NLI
   model (`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`, `multi_label`) in a
   resident Python worker. Exhaustive and cheap: nothing is missed because a
   model stopped early.
2. **WINDOW** — surviving sentences expand to the sentences around them and
   merge, category-blind, into paragraph-sized passages. Scoring stays per
   sentence; judging moves to the passage.
3. **VERIFY** — one schema-constrained Ollama call per (window, category),
   answering exactly one question: is the author asserting this claim as
   their own position, or reporting / quoting / questioning / arguing
   against it? This is the stage that keeps a history of propaganda from
   being flagged as propaganda, and nothing upstream can do it — "these
   people are vermin" and "he called them vermin, which is monstrous" score
   identically on the same hypothesis.

The verifier answers a verdict and nothing else. **There is no generated
explanation and no severity** — the flagged passage IS the finding, and the
ranker's window score is the only ordering. Inventing a rationale would be
fabrication; briefcase measured this and Foundry keeps the ruling.

---

## 2. The engine: `analyze`

A new command in the house shape (`src/commands.ts` conventions: shared
`OptionSpec`s, stderr = progress, stdout = the result path, exit 2 before
work, exit 1 after):

```
foundry analyze --book <key.book.jsonl> --out <report.jsonl>
                    [--categories <cats.json>]
                    [--model <name>] [--ollama <url>]
                    [--nli-python <path>] [--fresh]
```

**There is no sensitivity flag, and that is a ruling, not an omission**
(Owen, 2026-08-25): *"it flags absolutely anything that could possibly match
and then we have a button that displays things that match strictly (only
turn up a few options), a moderate filter, or a very loose filter."* The run
captures ONCE at the widest calibrated net; strictness is a display-time
filter over the stored scores (§8), so changing it costs a click, never a
re-run. briefcase's per-run sensitivity ladder exists because it re-runs;
Foundry's report remembers, so the knob would be a knob whose good value is
known (ARCHITECTURE.md §5) — the good value is "everything, once".

- `--book` is the book file (`docs/BOOK-FILE.md`) — read, never written.
  Loaded with `parseBookFile`; the rows analysed are `shelf === undefined`
  and prose-category (`Text`, `Quote`, `List-item`, `Caption`, `Footnote`,
  `Section-header`, `Title` — the translate set minus furniture).
- `--nli-python` names the interpreter for the NLI worker, env fallback
  `FOUNDRY_NLI_PYTHON`. **Not** `FOUNDRY_VLM_PYTHON` — that name means the
  PyMuPDF/MLX interpreter and overloading it would be wrong. No PATH search,
  same as `resolvePython`: a miss names every candidate tried.
- `--model` / `--ollama` default to the standing rulings:
  `qwen3.8:27b` / `http://localhost:11434` (*"27b is the standard we'll use
  for every task"*).
- Progress on stderr, counting finished, monotonic:
  `analyze: rank <n>/<m> sentences`, `analyze: verify <n>/<m>
  (<category>)`. The result path is the last line on stdout.

**Runtime honesty:** ranking a book is minutes; verification is one Ollama
call per surviving (window, category) and can be an hour on a hot book. The
report file is therefore written with `records.ts` discipline — appended and
fsynced as each verdict lands, question-keyed so a re-run pays only for what
changed, replaced only via pending-swap. A run killed at 400/456 keeps 399.

---

## 3. Sentences — the first segmenter in the project

Nothing in `src/` splits sentences today; translate's unit is the block, on
purpose. Analysis's unit is the sentence, so it gets the project's first
segmenter — **TS-side, in `src/analyze/`**, offsets `[start, end)` into
`BookRow.text`, the same shape as `parts[].chars`. The locator is measured
from source structure; no model ever emits one.

The split rule is briefcase's, calibrated with the 0.7 threshold:
`/[.!?]+["')\]]*(?=\s|$)/g` — terminal marks, optional closing quote/paren,
followed by whitespace or end. Trailing text with no terminal mark is a
sentence too. Whitespace inside a block is already normalised by the reflow;
the segmenter does not rewrite anything, it only measures.

The numeric axis downstream (window expansion caps, merge gaps) was tuned in
seconds against 3–6 s spoken sentences. It ports as **words, not seconds**:
the 40 s merged-window cap was "a paragraph, 100–130 spoken words", so the
book constants are word-count equivalents, named and argued at declaration,
retunable when the first reference books are audited.

---

## 4. The NLI worker — a resident subprocess, the first one

`src/analyze/nli-bridge.ts` + `src/analyze/nli_worker.py`. The existing
`bridge.ts` seam is batch (stdin closed after config); this worker is
resident: line-delimited JSON requests in, line-delimited responses out,
stdin stays open, EOF is the shutdown, SIGKILL after 2 s the backstop.

Wire contract (briefcase's, kept verbatim so measurements transfer):

- worker → `{"ready": true, "device": "cuda|mps|cpu"}` once the model is
  loaded; ready timeout 180 s.
- host → `{"id": n, "texts": [...], "hypotheses": [...]}`
- worker → `{"id": n, "progress": k}` per internal chunk — foundry's one
  addition to briefcase's wire: it moves the queue bar every few seconds and
  re-arms the response timeout, which therefore measures SILENCE rather than
  the length of the book (a flat per-request deadline was quietly a cap on
  book size).
- worker → `{"id": n, "scores": [[...], ...]}` — row-major texts ×
  hypotheses, raw per-hypothesis probabilities (`multi_label`, rows do not
  sum to 1); or `{"id": n, "error": "...", "trace": "..."}` — the traceback
  rides in the response because the host echoes worker stderr only during
  the model load.
- **The transformers pipeline returns labels sorted by score; the worker
  must re-map to input hypothesis order before emitting.** This is the one
  place a reimplementation silently breaks, so it is said here and in the
  worker.
- The worker duplicates fd 1 and reassigns stdout to stderr for everything
  but the protocol writer (`vlm_page.py`'s hardening, kept) and runs with
  `HF_HOME` under the worker dir, `HF_HUB_OFFLINE=1`,
  `TRANSFORMERS_OFFLINE=1` — an analysis never blocks on a network fetch; a
  missing model refuses by name and at once.

The worker source is embedded at build time (`import ... with {type:
'text'}` + a `.d.ts` shim, `bun build --compile` requirement) and
materialised to tmp by content hash, like `vlm_page.py`.

**No fallback.** briefcase degrades to the old discovery pass when the
worker is missing; Foundry's §8 ruling (ARCHITECTURE.md — fallbacks are bugs
with a delay on them) says no: a missing worker env ends the run with the
exact candidate list that was tried and what to install. A worker that dies
mid-run ends the run the same way; the report keeps every verdict that
landed, and a re-run reuses them.

---

## 5. Plan, thresholds, verify — the measured constants

Ported verbatim from `nli-ranker.service.ts` (lines cited in the source),
with one systematic rewrite: hypotheses phrase the **author**, not the
speaker — *"The author asserts that…"* — because a book is not a transcript.
The propositional form is the load-bearing part and is kept: a hypothesis is
a proposition the sentence can entail, never an analyst's description of the
act, never a bare noun-matcher (the rejected forms and their false-positive
scores are quoted beside the hypotheses in briefcase; the port carries the
lesson, not the corpse).

- Tuned categories carried over: political-demonization, hate, conspiracy,
  dehumanization (5 hypotheses), violence, false-prophecy,
  **christian-nationalism** (3 hypotheses), prosperity-gospel, extremism,
  political-violence. `misinformation` stays excluded — measured 19/20
  verified false positives; entailment cannot rank it.
- **The hypothesis template is the pipeline's default** ("This example is
  {}."), because that is the configuration every ported threshold was
  calibrated against — briefcase's own worker marks it "do not clean this
  up; changing the template silently moves the threshold." The port briefly
  shipped the bare template on readability reasoning and was corrected
  against the real worker on the Mac (2026-08-25); the rank cache key was
  bumped so no bare-template score survives as an answer.
- Owen's book categories that have no tuned hypothesis yet — **anti-evolution
  / science denial** (the JW material), and the Project 2025 /
  authoritarian-blueprint family — enter as description-backed categories
  (the untuned fallback shape) with first-draft hypotheses in the
  propositional form, and are flagged in the report as untuned. Tuning
  against reference books is the follow-up work, indexed in PLAN.md.
- **Capture floor 0.2, rescue floor 0.15, fixed** — briefcase's widest
  sensitivity, run unconditionally, because the tiers are applied at display
  time (§8) and a score below the loosest tier is a score nobody can ask
  for. The measured ladder 0.9 / 0.7 (calibrated) / 0.5 / 0.35 / 0.2 becomes
  the DISPLAY tiers, not run parameters. Rescue rule intact at the floor:
  ≥2 categories at ≥0.15 on a sentence nothing else claimed — the 0.15
  clamp is load-bearing (measured in briefcase: without it the widest
  setting "rescued" everything at 0.008).
- Sliding window 3, stride 1; window dedupe highest-score-first; expansion
  ±2 sentences under the word-cap; merge gap 1 sentence, category-blind,
  merged cap ~the-paragraph constant (§3); noisy-OR window score
  `1 − Π(1 − sᵢ)`; ordering by `Σ log(1 − s)` because the noisy-OR
  saturates in float64.
- Verify: the briefcase prompt with "speaker" → "author", passage = the
  window's sentences, one call per (window, category), **sequential and in
  DESCENDING window-score order** — the strict tier's findings are verified
  first, so a run interrupted an hour in has already finished the findings
  most worth trusting, and the append-as-landed report makes them readable
  before the loose tail is done. **Every candidate is verified and every
  verdict is stored** — `flag` and `skip` both — because the loosest display
  tier shows the skips (ghosted, labelled as the verifier's rejection)
  rather than hiding them; a person hunting for "almost everything" is owed
  the net's whole contents, told honestly which fish the verifier threw
  back. The `VERIFICATION_EMPHASIS` ladder is NOT ported: it existed to
  lean one re-run's verdicts, and with verdicts stored once the calibrated
  prompt (briefcase's level 2, the deliberately empty emphasis) is the only
  one asked. Temperature 0, one pinned `num_ctx` sized from the largest
  prompt for the whole stage (Ollama reloads on any change), answer budget
  a small constant — never translate's `answerBudget`, which would grant a
  verdict thousands of tokens. Schema-constrained via Ollama's `format` field
  (`{"verdict": "flag"|"skip"}`) — measured 9/10 recall at 2.9 s/call vs
  6/10 at 20.3 s unconstrained — **including the thinking-model trap**: with
  a grammar from token 0 the answer can arrive in `thinking` with
  `response` empty, and the client reads `thinking` only when a format was
  requested and `response` is empty. An unreadable answer is a skip and a
  warning, never a flag: an unreadable answer must not be able to accuse
  anybody. `think:false` for qwen3-family, `requireModel` preflight,
  `unloadModel` courtesy at the end — all `ollama.ts`'s existing rulings.

---

## 6. The report — a step's payload

`analysis/<stepId>.jsonl` in the project (a new layer beside `ops/` and
`curations/`), the payload of a new ledger step:

- **Step action `analysis`**, child of the step it was run against — Owen's
  ruling verbatim. Retention `expensive` (a model pass; re-runnable but
  hours). Params carry what was asked (categories, model) — sorted
  consciously against `MINTED_BY_THE_RUN`.
- Header line first, rows after, **no timestamp anywhere in the body path**
  (same input, same bytes): the header carries the book's `source.bankSha`
  and generation, the NLI model id, the hypothesis-set version, the verify
  model, and the capture floor. A loader that finds a changed bank refuses by
  name — a report keyed to `b12-3` is only meaningful against the bank that
  minted it.
- One row per **candidate** window — verified or not: `{ id, start, end,
  category, also: [...], score, verdict: 'flag' | 'skip', sentences: n }` —
  `id` is the block id (`b<page>-<order>[-<part>]`), `start`/`end` are
  `[start, end)` character offsets into that row's `text` as the book file
  carries it, `category` the primary (highest-scoring category the verifier
  flagged, or highest-scoring outright when it flagged none), `also` the
  other flagged categories of the window. The verdict rides every row
  because the display tiers slice on `(verdict, score)` and the loosest tier
  shows the skips. A window spanning blocks carries one row per block it
  touches, sharing a `hit` ordinal so the app can light them as one finding.
- Cache rows (rank scores, verdicts) live in the same file under their own
  `kind`, question-keyed (hash over sentence text ∥ NLI model ∥ hypothesis
  set ∥ threshold, and passage ∥ category ∥ verify model ∥ prompt), so a
  re-run against an edited book re-pays only the edited blocks.

---

## 7. The app: the step, the queue, the panel

- `'analysis'` joins `STEP_ACTIONS` (one array, union derived — the capture
  lesson), `JobKind`, and `JOB_RESOURCE` as **gpu** (Ollama holds the card,
  translate's reason). Lane wording added to the shelf. New progress phase
  `analyze` in `JobProgress` and `parseProgressLine` — pattern order there
  is load-bearing, insert carefully.
- A plan door `workspace:plan-analysis` mints the step id and the payload
  path (main owns names), `family:verb`, `ipcMain.handle`, and
  `docs/IPC-CHANNELS.md` regenerated in the same commit.
- Launch from the action menu beside Translate, a small dialog in the
  translate-dialog shape: category checklist, model + endpoint text inputs
  defaulted from `app/shared/pipeline.ts` — no sensitivity control, because
  strictness is the panel's filter (§8), not the run's. Enqueued held, like
  everything expensive. **No unapplied guard**: the run reads the book file
  and writes a report; it consumes no rendering (the sweep's rule, decided
  explicitly).
- Jobs land via `landStep` under the standing step. Hosted world routes
  through the host queue like everything else.

## 8. The surface: lit text, and the hits where compare goes

- **The hits panel takes compare's slot**: a second column in the workspace
  `.row`, behind a `StageService` discriminated union
  (`secondColumn: {kind: 'compare' …} | {kind: 'analysis' …} | null`) so the
  two are mutually exclusive by construction and the clearing rules stay a
  computed, not a thing call sites remember. Two equal halves or one whole —
  the standing layout ruling — is kept; the panel is a column, not a modal,
  precisely so travel does not have to close anything.
- A pure `app/src/app/core/analysis.ts` mirrors `sweep.ts`: it maps the
  stored report onto `BookStack.view().rows` — skipping shelved rows,
  ghosting struck ones, and reporting hits whose offsets no longer land as
  **sentences on the load, not a refusal to open** (the `unplaced`
  precedent). Hit keys are `${id}#${start}`.
- **The strictness filter is three buttons on the panel** — Owen's ruling
  (2026-08-25) verbatim in §2. They slice the stored `(verdict, score)`;
  nothing re-runs:
  - **Strict** — verifier-flagged findings at score ≥ 0.9. "Only turn up a
    few options": the near-certain entailments.
  - **Moderate** — verifier-flagged at score ≥ 0.7, briefcase's calibrated
    default. The set a default briefcase run would have produced.
  - **Loose** — everything the net caught, down to the 0.2 capture floor,
    including windows the verifier skipped — drawn ghosted and labelled as
    the verifier's rejection (reported speech, quotation, argument against),
    the same shown-but-inert treatment struck rows get. "Matches almost
    everything", and honest about which of it the verifier threw back.
  The tier is session display state, not persisted, not a param of the step
  — the report is the same file under every button.
- The panel copies the sweep's mechanics wholesale: rows grouped by category
  with counts, one hover listener on the container, the fixed-position
  `pointer-events: none` glance for the fuller quotation, travel =
  `pane.reveal(id)` + pulse. Category colour in chrome carries the role,
  never the paper hex.
- **Highlights are runs, not overlays**: `cut()` in the book view already
  closes a run when marker coverage changes; analysis spans join the same
  cursor walk and emit a `hit` class on the run. No `innerHTML` (banned on
  this surface), no absolutely-positioned layer (an overlay that ate
  gestures would make a flagged paragraph the one nobody can select). One
  highlight ink on the paper — the page must not turn into confetti — with
  the category named in the gutter chip and the panel; a panel filter lights
  one category at a time when asked.
- Highlights draw only when the analysis panel is open. The paper is a
  workbench; a report is an apparatus a reader summons, not a permanent
  recolouring of the book.

---

## 9. Not being built, out loud

- **No discovery fallback** (§4). briefcase keeps one for workerless
  machines; Foundry refuses by name instead.
- **No severity and no generated rationales** (§1). The passage is the
  finding.
- **No shipped NLI env yet.** The first cut runs against a hand-provisioned
  interpreter named by `--nli-python` / `FOUNDRY_NLI_PYTHON` (torch +
  transformers + the deberta weights). The `env-catalog.ts` target, release
  assets, `doctor` tier and `env-provision.ts` rule are indexed follow-up
  work — deferred, not forgotten.
- **No misinformation category** — measured out in briefcase; entailment
  cannot rank it and the verifier drowned.
- **Hypothesis tuning for the book categories** (anti-evolution, Project
  2025 family) is follow-up work against reference books; until then those
  categories run description-backed and say so in the report.
- **BookForge parity**: the deprecated BookForge analysis is not touched;
  this reaches BookForge by the normal re-vendor, later.
