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

## 2b. `vtt-book` — an audiobook, made analysable (Wave 50, BUILT)

`analyze` reads exactly one thing, the book file. An audiobook is a
recording and a transcript, and for an audio-only book there is no other
text anywhere — so something has to turn the transcript into a book file.
**That something is Foundry**, by the standing cross-repo ruling: *Foundry
owns all text processing*, BookForge never writes this format, and the
worker.py divergence is what a foreign hand-rolled writer of a measured
format ends as. BookForge shells `vtt-book` and then `analyze`.

```
foundry vtt-book --vtt <transcript.vtt> --out <book.jsonl>
                 [--language <bcp47>]        # declared, never detected; en
```

It is `src/vlm/vtt-book.ts` — the third `f`, beside `book-run.ts`'s
`f(bank)` and `epub-explode.ts`'s `f(epub)`, all three producing a
`BookFile` through the one `formatBookFile`. No model, no bank, no
rasteriser; it costs a read of the file.

- **One cue is one row, always.** A cue holding two sentences stays ONE
  row. A finding is a row id plus `[start, end)` into that row's own text
  (§6), and BookForge turns that into a moment in the audio by taking the
  row back to its cue and the offsets to a fraction of that cue's span.
  Splitting a cue would measure every offset from a string with no
  timestamp on it. Nothing is lost: §3's segmenter cuts sentences INSIDE a
  row, so a two-sentence cue is scored as two sentences either way.
- **Ids are `e-<n>`**, n the 1-based cue index in transcript order — the
  bank-less family (docs/BOOK-FILE.md §4), used for the reason an imported
  EPUB uses it: no page and no banked answer to derive a name from, and a
  total order the source itself supplies (the spine there, the tape here).
  Row n is cue n with no gaps, which is why a malformed cue **stops the
  run** rather than being named and skipped the way a bad page is: skipping
  one would move every name after it.
- **Category `Text`** on every row, and the no-page frame throughout —
  `page: 0`, `pages: [0]`, a zero box and page size, one part covering the
  whole text, `typography: null`, no chapter seed, `figures: {blocks: 0,
  cut: 0, from: null}`. A recording has no pages to estimate and nothing to
  measure type from; detecting chapters from the words would be an
  invention rather than a reading.
- **The text is the cue's, verbatim.** Well-formed inline tags are stripped
  (`<i>`, `<v Speaker>`, `<c.loud>`, timestamp tags), and `&amp; &lt; &gt;`
  are decoded **after** that — in that order, so a transcript that escaped
  an angle bracket keeps the words it escaped it for. Nothing is trimmed,
  collapsed or reflowed. Multi-line cue text joins with a newline.
- **`NOTE` blocks are metadata**, `NOTE asr-fallback` among them: never a
  row, never part of the identity — a transcript that gains a comment is
  the same transcript — but **counted**, and the count is on the summary
  line, because a wholly-ASR transcript is a book whose text is a machine's
  guess at what was said and that belongs in the run log.

**There is no `--bank-sha`, and that is the point.** Foundry mints the
identity itself, because an identity a caller passes in is one a caller can
get wrong, silently, and the failure shows up a year later as a report that
refuses (or fails to refuse) for no visible reason. The recipe, documented
here and in the command's `--help` so BookForge can reproduce it for a
cross-check:

> sha-256 over the NUL-joined sequence of, for each cue in transcript
> order: the 1-based cue index, the start in whole milliseconds, the end in
> whole milliseconds, and the cue's decoded text — four fields per cue,
> decimal strings and the row's own text, one NUL between every field.
> `bankSha` is the first 16 hex of the digest.

Taken over the **cues** and not over the file, which is what makes it
useful in both directions. A transcript re-exported with different line
endings, renumbered cue identifiers, added comments, dropped cue settings
or different inline markup is the SAME transcript and mints the SAME book,
so re-exporting does not orphan an hour of verdicts. Change any cue's words
or its timing and the identity moves, so a **re-transcribe refuses by
construction** downstream (§7's staleness sentence), with nobody having to
remember to check. Measured on the fixtures: the canonical file and a
CRLF/renumbered/`<i>`→`<b>` re-export produced byte-identical book files;
one word changed in one cue moved the digest.

**Refusals, and where.** A transcript with no cues is refused by name here
rather than one command later — `analyze` would refuse the proseless book
anyway, but about a file this command had declared good. A malformed cue
timing names the line. Exit 2 is a bad command line and nothing ran; exit 1
is a failure after work began and `--out` is untouched; on success the
absolute path is the last line on stdout and the progress lines
(`vtt-book:` cue count, NOTE count, language, minted identity) are on
stderr — `analyze`'s own contract, because the caller shells them back to
back and must not have to know which one it is reading.

**The file is checked before it is put in place**: written beside `--out`,
read back through `parseBookFile`, and only then renamed over. A minter
that can emit a file its own parser refuses must fail loudly rather than
hand a dud to another repository that by ruling knows nothing about this
format.

`analyze` needed **zero changes** for any of this — verified from source
before the command was offered and again after it was built: it never
touches a bank, staleness is digest-based, the rank and verdict caches are
text-keyed so a re-transcribe re-pays only the changed cues, and `Text` is
in its prose set. Proved end to end: a five-cue fixture minted, then
`analyze --book` over it read 5 rows / 5 prose / **8 sentences** (the
two-sentence cue cut inside its row, as promised) before failing at the
Ollama preflight it was pointed at a dead port for.

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
  model, the capture floor, and `hues` + `names` — each category's display hue
  and display name, so the report owns its display facts on any device
  (`categoryHue`/`CATEGORY_NAMES` in plan.ts; the app's shared table is their
  named mirror; a custom category's name is the label its author typed).
  Labels are display-only and deliberately outside `hypothesisSetVersion` —
  relabelling changes no question a score answered. A loader that finds a changed bank refuses by
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
  translate's reason). Lane wording added to the shelf. Two new progress
  phases — `rank` and `verify` — in `JobProgress` and `parseProgressLine`,
  where pattern order is load-bearing (insert carefully) and the stage word
  the pattern already matched on is CAPTURED. It was one phase, `analyze`,
  and the one bar drawn over both stages filled to the end and started
  again; Owen read that as a fault, which is what it looks like. The queue's
  two bar-drawing surfaces stack a small bar per stage
  (`QueueViewService.stageBars`); the chip's hairline stays one bar,
  measuring the stage that is running.
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
- **The checklist can be added to** (Owen, 2026-08-25: *"maybe the user can
  add more categories - even one-sentence descriptive ones. and they check off
  which ones they want to search for in this document."*). A category the user
  writes is a NAME and ONE SENTENCE; the sentence IS the hypothesis, wrapped by
  `describedHypothesis` and marked untuned, which is the door
  description-backed categories have always come through (§5, and the two
  built-in book categories entered by it). Two facts, two homes: WHAT
  CATEGORIES EXIST is the reader's and persists app-level in
  `app-settings.json` (`AppSettings.analysisCategories`, beside the library
  folder) so it reaches every book on the machine; WHICH ONES ARE TICKED is
  one run's question and is decided in the dialog each time, never remembered
  — a remembered tick is an hour somebody paid for without choosing to. Two
  doors, `analysis:read-categories` / `analysis:write-categories`; the write
  takes the whole list and answers with it as stored, ids re-derived from
  names (`customCategoryId`), fields capped, collisions with a built-in or
  with each other dropped (`clampAnalysisCategories` — this file CLAMPS rather
  than refusing, which is `app-settings.json`'s own philosophy, and the dialog
  does the refusing in sentences because a clamp is the wrong answer to
  somebody who has just typed something).
- **Free text still never reaches a hypothesis by accident**, and the old
  sentence needed a new true form rather than a quiet deletion. A typed name
  becomes a category ONLY by being saved through main's door, where it is
  slugged and checked; `workspace:plan-analysis` then admits a name only if
  the settings file already holds it. So the path from a text box to a prompt
  runs through a deliberate act of saving, and what the ledger records and the
  engine is handed is always a string main itself minted.
- **Removing a custom category costs no report.** A report carries its own
  category list (`AnalysisReading.categories`) and the panel says an
  unfamiliar id aloud rather than refusing to draw it
  (`analysisCategoryName`), so a report naming a category that has since been
  deleted renders in full, colour and all.
- The categories file main writes beside the report
  (`<report>.categories.json`) carries `{name, enabled}` and, for a user's own
  category, `description`. Three fields and no more: `parseCategoriesJson`
  REFUSES an entry carrying a field it does not read, so anything this app
  grew on its own request shape would end the run the day it was added.
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
- **Highlights are runs, not overlays**: `cut()` in the book view already
  closes a run when marker coverage changes; analysis spans join the same
  cursor walk and emit a `hit` class on the run. No `innerHTML` (banned on
  this surface), no absolutely-positioned layer (an overlay that ate
  gestures would make a flagged paragraph the one nobody can select). The
  panel's legend switches a category's cards and its highlights off together
  (§8a — the clause that was deferred and is now built).
- ~~**One highlight ink on the paper** — the page must not turn into
  confetti.~~ **OVERRULED, 2026-08-25, by Owen**: *"maybe make the text's
  highlighted color the same color as the analysis block"*, and then, when the
  first attempt came back too solid, *"the text shouldn't be a different
  color, just a light highlight color difference."* The paper takes the
  category's colour. The strikethrough is deliberate — the old ruling was
  right about a page with no key beside it, and what changed is that there is
  now a legend two inches away and a card wearing the same hue on its rail, so
  the tint and the card are one fact drawn twice rather than two facts
  competing. **What survives intact is the alpha discipline**, which is where
  the real risk always was (`shared/categories.ts`: *"applied as an outline and
  a tint, never as text colour: this is a book, and recolouring its words makes
  it unreadable"*): nothing colours a glyph, ever; the hue appears only as a
  pale stroke behind the words. One hue source (`analysisCategoryHue`), two
  treatments — the panel mixes it for charcoal, `tintOf` (book-view) mixes it
  for cream at `hsl(H 75% 68% / .32)` for a flag and `/ .14` for a rejection —
  so the two grounds are accommodated where they must be (lightness and alpha)
  and the identity is shared where it must be (the hue). A shared colour
  *string* would have had to be legible on both, which nothing is.
- Highlights draw only when the analysis panel is open. The paper is a
  workbench; a report is an apparatus a reader summons, not a permanent
  recolouring of the book.

### 8a. The panel, as reworked (Owen, 2026-08-25)

The first cut copied the sweep's mechanics wholesale — rows grouped by
category, one hover listener on the container, a fixed-position glance for the
fuller quotation, a chip naming the block id. Owen read it and ruled:

> *"lets rework it a bit so each item is in its own block, in the order in
> which it appears. maybe each category has its own color or something. and
> maybe the user can add more categories - even one-sentence descriptive ones.
> and they check off which ones they want to search for in this document.
> also, im not sure what the items next to the quotes mean. b151-5? b159-2?
> those arent necessary for a human to see. the tool tips are just repeating
> whats already on screen - unnecessary. and they shouldnt be highlighted
> inside the analysis, they should be highlighted inside the document viewer
> (as they are). as i scroll/click highlighted text, it should jump to that
> spot in the analysis"*

What that is, clause by clause:

- **ONE CARD PER FINDING, IN THE BOOK'S ORDER.** The grouping is gone. The
  list is the flat sequence `place()` already returns, which is reading order.
  A list beside a book is read AGAINST the book, and grouping scatters one
  page's findings down five sections. Each card: the category name, the page
  (`≈`, the sheet's own estimate mark), the score, the quotation as the body,
  the other categories named where there are any, and the verifier's rejection
  as a sentence where the verdict was a skip.
- **A HUE PER CATEGORY.** The card's left edge is a rail in
  the category's colour — the block chrome's gutter-rail idiom — and the same
  colour is the legend's dot and the card's category name. The hues are one
  table beside the names (`ANALYSIS_CATEGORIES.hue`,
  `app/shared/analysis-categories.ts`), hand-checked so the smallest gap is
  24° and dealt out with a stride so two categories adjacent in the LEGEND are
  never adjacent on the wheel. **The assignment is deliberately arbitrary**:
  §1 rules that there is no severity, and a cool-to-hot table would smuggle one
  back in through the paint. A category the user wrote has no row, so its hue
  is a 32-bit FNV-1a of its id folded into the wheel — stable across sessions
  and machines with nothing stored, needing to know nothing about what else is
  on screen, and allowed to land near a built-in's because every dot and every
  rail has the category's NAME beside it. The shared table exports a NUMBER
  rather than a colour, because the hue is a fact about the category and the
  colour it becomes is a decision about one surface's ground — **and the paper
  now makes that decision too**, by Owen's overruling of the one-ink rule
  (§8 above and `tintOf`, book-view.component.ts).
- **THE LEGEND IS THE FILTER.** Each category present at the current tier gets
  a chip — dot, name, count — and pressing it switches that category's cards
  AND its highlights on the paper off, because they are one list (`hits` is
  what the panel draws and what `litRanges` paints). This is the clause this
  section promised and Unit AN-2 deferred out loud. It is a set of the HIDDEN
  and not of the shown, so an empty set means everything and a report that
  grows an unfamiliar category shows it. Counts are taken BEFORE the filter, so
  a switched-off row keeps the number telling you what turning it back on
  would bring. The three tier buttons stay above it.
- **NO BLOCK IDS.** `b151-5` is a coordinate this program keys ops and travel
  by and is not a thing a reader has any use for; the no-filenames-in-copy rule
  is read as covering it. Travel is the WHOLE CARD (a chip-sized target inside
  a paragraph-sized row is a target you can miss), with a 1px hover raise as
  the affordance — never a growth, which is the "rows that move under the hand"
  fault Owen ruled against on the sweep.
- **NO TOOLTIP THAT REPEATS THE CARD.** The `also` categories are named
  instead of counted behind a `+2`; the verifier's rejection is a sentence
  instead of a two-word chip with the sentence hidden on hover. The three that
  remain each say something the surface does not: what a tier means (×3), and
  that the score is not a severity.
- **THE GLANCE IS CUT.** It was the one hover here that showed MORE than the
  row did, so it passes the "repeats what is on screen" test — and it goes
  anyway, because the sync below gives its job to something better: a card
  click travels to the passage AND the paper scrolls the list back, so the
  fuller passage is the book in the column beside the list rather than a
  rectangle appearing under a pointer held still — over the very spot the
  pointer is now aiming a click at. `sweep.widen` is untouched; that card is a
  modal over the page and has no book beside it to travel to.
- **THE QUOTATION IN THE PANEL IS PLAIN PROSE.** *"They shouldnt be
  highlighted inside the analysis, they should be highlighted inside the
  document viewer (as they are)."* The flagged words keep a little weight and
  a brighter ink so the eye finds them in the sentence; there is no marker-pen
  background. Two surfaces painting one highlight makes the panel a second copy
  of the page instead of an index into it.
- **DOCUMENT → PANEL, BOTH WAYS.** *"As i scroll/click highlighted text, it
  should jump to that spot in the analysis."* The paper does the measuring
  (its DOM) and holds no opinion; the panel does the obeying (its manners).
  - CLICK: `LitRange` carries the earliest covering finding's `key`, `cut()`
    closes a run when the key changes, and the run wears it as `data-hit`. The
    press that already reads `data-id`/`data-note`/`data-jump` off whatever it
    landed on reads this the same way and calls `AnalysisViewService.select`.
    **The guard is structural**: there is no `.run.hit[data-hit]` in the DOM
    unless a panel is open, because the class and the attribute both come from
    `lit()`. **Block selection is untouched** — the paragraph still becomes the
    selection, Alt still takes the category, the original panel is still aimed;
    a flagged paragraph must not be the one paragraph nobody can act on, which
    is the very failure the no-overlay ruling was written against. The panel
    scrolls that card into view, always, because a deliberate act that sometimes
    does nothing is the worst of the three available behaviours; `pointedAt`
    carries a counter beside `selected` so clicking the same passage twice
    brings the panel back to it even though the state did not change.
  - **SELECTION, AND A PULSE THAT LASTS** (Owen, after the first cut: *"when i
    click a highlighted block, the corresponding analysis block only blinks for
    about 1/4 of a second. can we make it pulse? on either side. have it pulse
    as long as it's selected. if i click the block, the text block pulses until
    i click somewhere else or scroll offscreen."*). A blink ANNOUNCES and is
    gone; a pulse is a STATE — which is what a two-surface instrument needs,
    because the whole point of clicking a passage is to then look at the other
    end of the room, by which time a flash has finished. One nullable hit key
    (`AnalysisViewService.selected`), both surfaces drawing it: the card
    breathes in the panel and the passage's lit runs breathe on the paper,
    whichever end the click came from, at the same 1.9s so the two read as one
    selection seen twice. **The emphasis is a ring and never a colour** — the
    tint underneath is already the category's and twelve of those exist, so an
    emphasis in any hue would read as "a different category" on whichever card
    shared it; the paper uses its own soft `--ink` and the panel uses
    `--accent`, neither of which can be mistaken for one of the twelve.
    **Reduced motion holds the ring still at the breath's midpoint** rather
    than dropping the emphasis — the book view's glide sets that precedent
    (skip the movement, keep the destination). Let go of by: a click that is
    not on the selected finding (paper — in `release`, so it catches only a
    plain click on the words and never a right-click, a marquee, a marker peek
    or a gutter chip, each of which returns or never reaches it; panel — one
    listener on the list with `closest('.card')` as the test, and the tiers and
    the legend deliberately outside it, because changing what is shown is not
    the same act as looking away from a finding), a click that selects another,
    or **the passage scrolling off the page**. That last one IS an
    IntersectionObserver, and it is the one place one is right here: it watches
    the selected finding's BLOCK (which always has a box) rooted on the bench
    (which is the thing that scrolls), and the question is genuinely a threshold
    rather than a position. It refuses to fire until it has SEEN the block
    arrive, because an observer reports its element's state on registration and
    the selection is usually made a frame before the `reveal` that brings the
    block into view.
  - SCROLL: **an IntersectionObserver over the lit runs was the obvious shape
    and is the wrong one, measured.** The runs live inside `.body`, which is
    under `content-visibility: auto`; a skipped subtree generates no boxes for
    its descendants, so an off-screen run has no geometry at all — an observer
    reports it as not intersecting (true and useless) and a rect asked for
    directly comes back as zeros, which reads as a rectangle at the viewport
    origin and would make the FURTHEST finding look like the nearest. So the
    tracking is a rect walk over BLOCKS, which always have boxes (the
    containment is on a wrapper inside each block, never on the block, so the
    gutter marks are not clipped). `Line.hitKey` puts the block's first
    finding on it as `data-hit-key`, and `followAnalysis` — `followOriginal`'s
    walk, narrowed by that selector to the handful of lit blocks — takes the
    first at or below the fold, or the last when the reader has scrolled past
    every finding. It runs on the same native capture-phase scroll listener,
    outside Angular's scheduling, and writes its signal only when the answer
    CHANGES.
  - **THE FOLLOWING MUST NOT FIGHT THE READER.** The pointer resting over the
    panel pauses it outright (no ambiguity about what a hand on a list is
    doing); scrolling the panel by hand pauses it for `FOLLOW_REST_MS` = 4s —
    long enough to read two cards, short enough that going back to the book
    resumes before the next paragraph. A self-scroll suppression window
    (`SELF_SCROLL_MS` = 600ms, a smooth scroll's whole animation) stops the
    following switching itself off on its first success. The panel scrolls by
    arithmetic on its own list and never by `scrollIntoView`, which would
    scroll ancestors this component has no business moving, and it does nothing
    at all when the card is already comfortably in view.
- Travel is still `pane.reveal(id)` + pulse, and the panel still closes
  nothing. Category colour in chrome carries the role, never the paper hex.

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
