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

The method is **briefcase's measured flag pipeline**, ported, not reinvented.
Since 2026-09-25 that is briefcase's **snap flag ranker** — the version that
replaced the entailment ranker there (briefcase main d80cc71,
`backend/src/scorer/flags/`, `scorer/crucible-decide.ts`,
`analysis/flag-windows.ts`, `analysis/prompts/analysis-prompts.ts`) and
replaces it here (Owen: *"full replacement … we're replacing the logic — the
way it works. not the ui"*). BookForge's old book-analysis is **deprecated and
is not the model**: it asked an LLM to read a chapter and discover quotes, which
fails the way open-ended discovery always fails — the model returns the two or
three most obvious hits and stops — and then fuzzy-matched the (often
reworded) quotes back into the book, which is why a whole recovery module
exists over there. Foundry has block identity; nothing here matches a quote to
anything, ever.

Two acts on two models, run by the app as two queue rows (the cleanup's triage
and its cleanup are the precedent):

1. **RANK** — `foundry analyze-rank`, on a small decide model on a Crucible
   (the server's clean row, the 9B — Owen: *"9b for triage"*). Every sentence
   of the book, in overlapping groups of three, is QUOTED in one multiple-
   choice question over the enabled categories and "none"; the decide door
   returns the model's probability on each answer letter, never generated text.
   Each sentence's vector is the mean of its groups'. Exhaustive and cheap:
   nothing is missed because a model stopped early.
2. **VERIFY** — `foundry analyze --ranks`. The rating map becomes spans (each
   category measured against its OWN usual level in this book, so a book about
   a subject does not light up end to end), sections of about a long paragraph,
   and merged verification windows; then one schema-constrained model call per
   (window, category) answers exactly one question: is the author asserting
   this claim as their own position, or reporting / quoting / questioning /
   arguing against it? This is the stage that keeps a history of propaganda
   from being flagged as propaganda, and nothing upstream can do it — "these
   people are vermin" and "he called them vermin, which is monstrous" read
   alike to any ranker.

The verifier answers a verdict **and its reason** — one or two sentences on
what the author says and why that is or is not the claim (briefcase's v4
prompt; Owen, 2026-09-25: *"the side panel should show the reasoning"*). The
schema puts the verdict first, so the reason explains the call rather than
steering it. **There is still no severity.** Only the flags are findings
(Owen: *"confirmed only"*); every verdict, flag or skip, is stored as the cache.

---

## 2. The engine: `analyze-rank`, then `analyze`

Two commands in the house shape (`src/commands.ts` conventions: shared
`OptionSpec`s, stderr = progress, stdout = the result path, exit 2 before
work, exit 1 after):

```
foundry analyze-rank --book <key.book.jsonl> --out <ranks.json>
                     --endpoint <crucible base url> --model <decide model>
                     [--categories <cats.json>]

foundry analyze --book <key.book.jsonl> --ranks <ranks.json> --out <report.jsonl>
                [--categories <cats.json>]
                [--model <name>] [--endpoint <url>] [--server <openai|ollama|anthropic>]
                [--concurrency <n>] [--fresh]
```

**There is no sensitivity flag and no display tier.** The run ranks every
sentence, verifies every ranked window and reports what the verifier flagged.
(The Strict / Moderate / Loose tiers of 2026-08-25 sliced a report that kept
every verdict and an entailment score; they went with the entailment ranker.)

- `--book` is the book file (`docs/BOOK-FILE.md`) — read, never written, by
  BOTH commands, through one reader (`readProse`, src/analyze/prose.ts): rows
  with `shelf === undefined` and a prose category (`Text`, `Quote`,
  `List-item`, `Caption`, `Footnote`, `Section-header`, `Title` — the
  translate set minus furniture), cut into sentences (§3).
- `--categories` must be the same file for both; the rank file records which
  questions were asked (`optionSetVersion`) and `analyze` refuses one asked
  about a different list, one made from another bank, or one whose units do
  not match the book it is handed — each by name.
- `analyze-rank --endpoint` is the Crucible's BASE address and `--model` the
  resident decide model; the credential comes from `FOUNDRY_ENDPOINT_HEADERS`.
  It never loads a model: the app places and leases it. The book is cut into
  chunks that fit the context the model is LOADED at, read off the server's
  `/v1/models` (§4); a server that does not say is refused.
- `analyze --model` absent on `--server openai` means the model the server
  holds; absent on `--server ollama` it is REFUSED by name. `--endpoint`
  absent means `backend.endpointUrl` on the OpenAI door and
  `http://localhost:11434` on the Ollama one.
- Progress on stderr, counting finished, monotonic: `analyze: rank <n>/<m>`
  (units) from the first, `analyze: verify <n>/<m> (<category>)` from the
  second. The result path is the last line on stdout.

**Runtime honesty:** ranking a book is a few minutes on the 9B; verification is
one model call per ranked (window, category) and can be an hour on a hot book.
The report is written with `records.ts` discipline — every verdict appended
and fsynced as it lands, question-keyed so a re-run pays only for what changed,
replaced only via pending-swap. A run killed at 400/456 keeps 399. The rank
file is written whole at the end of its run.

---

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
server preflight it was pointed at a dead port for.

---

## 2c. Which server answers the verdicts (Wave 58, 2026-09-08; two doors again since 2026-09-14)

**`--server openai|ollama|anthropic`, declared and never sniffed** — docs/SLOTS.md §2 is
the ruling and **docs/VLLM.md** owns the whole story. Briefly: `openai` (the
default) speaks `/v1/chat/completions` to anything OpenAI-compatible, `ollama`
speaks `/api/generate` to the Ollama on this machine.

The verdicts have not moved through any of it: same prompts, same schema, same
temperature 0, same verdict-cache key. **The constraint is the same decode under
two spellings** — `response_format: {type:"json_schema"}` on the chat door,
`format: <the schema object>` on Ollama's — which is why this is a transport
branch rather than a second way of asking, and it is the spelling the
measurements below were taken under.

`--concurrency` defaults to **12 on the OpenAI door and 4 on Ollama**: the first
batches the calls in flight together, and the sequential stage §5 describes was
Ollama's shape (it serialises per model unless its own parallelism was turned
up), not a property of the question. The pool dispatches strongest-first as
always, and the flagged categories are composed by walking the jobs' own order
afterwards, so a pool changes how long the stage takes and never what it wrote.

Two things are Ollama's alone. **`num_ctx` is pinned once for the whole stage**
(`stageNumCtx`), sized from the longest prompt, because Ollama reloads the model
on any change to it and these prompts differ only by passage length — the OpenAI
door is told no window at all and the log line does not claim one. And **the
model is unloaded when the run ends**, success or failure, in the run's
`finally`.

`--model` may be omitted on the OpenAI door — the served id is used and written
into the report header — and is required on Ollama. **The ranking is
`analyze-rank`'s and none of this reaches it**: it speaks only the Crucible
decide door (§4).

## 3. Sentences — the first segmenter in the project

Nothing in `src/` splits sentences today; translate's unit is the block, on
purpose. Analysis's unit is the sentence, so it gets the project's first
segmenter — **TS-side, in `src/analyze/`**, offsets `[start, end)` into
`BookRow.text`, the same shape as `parts[].chars`. The locator is measured
from source structure; no model ever emits one.

The split rule is briefcase's (`assembleSentences`, which its snap ranker still
builds its units from):
`/[.!?]+["')\]]*(?=\s|$)/g` — terminal marks, optional closing quote/paren,
followed by whitespace or end. Trailing text with no terminal mark is a
sentence too. Whitespace inside a block is already normalised by the reflow;
the segmenter does not rewrite anything, it only measures.

The numeric axis downstream (span merge gaps, section sizes, window expansion
caps, merge gaps) was tuned in seconds against spoken sentences. It ports as
**words, not seconds**, through ONE declared rate, 3.25 words a second
(`WORDS_PER_SECOND`, rank.ts): the 40 s merged-window cap was "a paragraph,
100–130 spoken words", and the top of that range against the 40 s is the rate.
briefcase-mac-1 suggested 2.5 (150 wpm) for the snap port; one rate for every
converted constant was kept instead. Every conversion is named and argued at
its declaration, retunable when the first reference books are audited.

---

## 4. The ranker — briefcase's snap flag ranker on a Crucible's decide door

`src/analyze/snap.ts` (the half that needs the card) and `src/analyze/spans.ts`
(the half that does not). The entailment worker it replaced — `nli-bridge.ts`,
`nli_worker.py`, the `nli-*` environments — is deleted.

- **Units** (`buildUnits`, briefcase's `unitsFromSentences`): the §3 sentences,
  a sentence under 4 words folded into the next (ContentStudio's
  `min_words=4`), a unit over 60 words cut into ~30-word pieces. briefcase's
  30-second run-on cap is dropped: it is 98 words at the declared rate, so the
  60-word cap always bound first. Each unit records the sentences it came
  from and its position in WORDS from the start of the prose.
- **Chunks** (`planChunks`, briefcase's `planFlagChunks`): one chunk up to the
  single-chunk ceiling, else equal cores with overlap context each side,
  every unit owned by exactly one core. briefcase's ceiling is 16k / 12k / 2k
  tokens on a scorer it loads at 32k itself; Foundry does not load the model,
  so the plan keeps those proportions and scales them to what the server says
  the model is loaded at, less 4096 for the legend, frame and a question
  (`chunkBudget`). A 9B loaded without a stated context comes up at 16,384
  (Crucible's manifest `context_default`), giving 12,288 / 9,216 / 1,536; at a
  32k load it is briefcase's plan exactly. Tokens are estimated at chars/3.6.
- **State and questions** — briefcase's 'prefix' layout, its default: the
  chunk's units one per line, a blank line, then `Categories (the options in
  the questions below):` and one `- <category>: <line>` per category plus
  `- none: None of these: ordinary talk about something else`. Groups of 3
  units, stride 2 (consecutive groups share one unit), 64 questions per
  request, each QUOTING its passage (units clipped to 300 characters):
  `Passage from the text above: "…"` / `Which of the categories listed above
  does the author do in this passage?` — briefcase's words with this port's
  one systematic rewrite (author, not speaker; text, not transcript). Options
  are the category ids with their titles ("Political demonization"), then
  `none`; option order is letter order, which is why an integer-like category
  name is refused (a JSON object would reorder it).
- **The wire** (the shared `backend/decide-door.ts`, which cleanup triage uses
  too): `POST <crucible>/v1/decide` with `missing: "report"`, `503
  chat_queue_full` waited out, transport failures retried five times. Each
  answer is read as briefcase's `floorAnswer` reads it: a label outside the
  engine's top-K (`missing_labels`) gets the tighter of two upper bounds the
  answer itself proves, never under ln 1e-12, and the row is renormalised; an
  answer with under **1%** of its mass on the letters is read as no evidence
  (uniform) and counted.
- **The rating map** is written to the rank file (`foundry-analysis-rank/v1`):
  units, the per-unit mean vectors `[...categories, none]`, label mass, the
  chunk plan, the model and the loaded context — kept whole so spans can be
  re-derived with other numbers without the card.
- **Spans** (spans.ts, briefcase's `flag-spans.ts`): baseline per category =
  min(0.5, its median over the book); evidence = rise above it as a share of
  the headroom; hotness = the unit's strongest evidence; a two-state Viterbi
  (switch cost 0.5 nats, τ −1: an isolated unit opens a span at hot > 0.5, a
  span extends at > 0.27, one cold unit breaks it at < 0.12); runs merged
  category-blind across ≤ 1 unit or ≤ 16 words; per span the categories within
  0.34 of the top one's evidence; strength Σ log(1 − s_c), so two categories
  at 0.9 outrank one at 0.97. A span over **293 words** (briefcase's 90 s) is
  cut at its quietest boundary into sections of at least **65 words** (20 s),
  recursively, a lull with no category left dropped. Then every (section,
  category) goes through rank.ts's `buildWindows` — unchanged from the
  entailment port — and the windows are verified strongest first.
- **No verify budget.** briefcase caps verifier calls at max(20, 60 × hours)
  and stores the rest unverified; Foundry verifies every window.

**No fallback.** A Crucible with no decide model, a model not resident, a
server that will not say its loaded context — each ends the run by name.

---

## 5. Categories and the verifier — the carried constants

- **The scorer's lines** are briefcase's `SNAP_OPTION_TEXTS`, verbatim (they
  name an act with no subject, so they read of an author as of a speaker),
  for the ten tuned categories: political-demonization, hate, conspiracy,
  dehumanization, violence, false-prophecy, christian-nationalism,
  prosperity-gospel, extremism, political-violence. A scorer reads a
  category's DESCRIPTION as content, so it never sees one of those.
- **The propositions** the verifier tests are briefcase's `FLAG_PROPOSITIONS`
  with "the author" for "the speaker" — unchanged from the entailment port.
- **Owen's two book categories** — anti-evolution and authoritarian-blueprint
  — have lines written for the port in briefcase's style (Owen, 2026-09-25:
  *"write one line for each in briefcase's style"*) and are `tuned: false`,
  named untuned in the report. **A category the user writes** is ranked by the
  first sentence of its description (≤ 140 characters, briefcase's
  `customOptionText`) and verified against the whole of it, untuned.
- `misinformation` stays excluded — measured 19/20 verified false positives
  under the entailment ranker, and briefcase's snap ranker skips it by default
  for the same reason. At most 25 categories (26 letters, one for none).
- **Verify**: briefcase's v4 prompt (`flag-verify/v4-justified`) with "speaker"
  → "author" and "Transcript passage." → "Passage from a book." (a transcript
  is a false premise about a book), versioned here as
  `foundry-verify/v4-justified-2026-09-25`. One call per (window, category),
  passage = the window's sentences joined by newlines, DISPATCHED strongest
  first. Schema-constrained `{"verdict": "flag"|"skip", "reason": string}`,
  verdict first — measured 9/10 recall at 2.9 s/call constrained vs 6/10 at
  20.3 s unconstrained, which is why there is no opt-out. Temperature 0; the
  answer budget is 512 tokens, room for the sentence and the object. The
  parser is briefcase's `parseVerification`: the verdict by regex, the reason
  from the object around it, prose as the reason when a door answered without
  the schema. A call that fails, hits the ceiling or carries no verdict is
  **not a finding and is not stored**, so the next run asks again; a stage
  where every call failed refuses rather than writing a clean-looking report.
  The `VERIFICATION_EMPHASIS` ladder is not ported: one grader, the measured
  one.

---

## 6. The report — a step's payload

`analysis/<stepId>.jsonl` in the project, the payload of a ledger step,
**format 2** (2026-09-25; format 1, the entailment ranker's, is refused whole
by the engine and by the app's reader):

- **Step action `analysis`**, child of the step it was run against — Owen's
  ruling verbatim. Retention `expensive` (a model pass; re-runnable but
  hours). Params carry what was asked (categories, model).
- Header line first, rows after, **no timestamp anywhere in the body path**:
  the book's `source.bankSha` and generation; `ranker: "snap-v1"`; `decide`
  (the ranking model as the door named it); `options` (`optionSetVersion`);
  `spans` (`spanParamsVersion`, the numbers the map was read with); `verify`
  (the verifying model); `prompt` (`VERIFY_PROMPT_VERSION`); `categories`,
  `untuned`, and `hues` + `names` so the report owns its display facts on any
  device. A loader that finds a changed bank says so rather than lighting the
  wrong paragraphs.
- One row per **flagged** window per block it touches: `{ kind: 'finding',
  hit, id, start, end, category, reason, also: [...], alsoReasons: [...],
  score, sentences }` — `id` the block id, `start`/`end` `[start, end)`
  character offsets into that row's text as the book file carries it,
  `category` the strongest flagged category, `reason` the verifier's for it,
  `also` the other flagged categories with `alsoReasons` in the same order,
  `score` the primary category's evidence in the window (recorded, not
  sliced on). A window spanning blocks writes one row per block, sharing a
  `hit` ordinal so the app lights them as one finding. A window the verifier
  rejected entirely writes no row.
- Cache rows: `{ kind: 'verdict', key, verdict, reason }`, key = sha256 over
  `foundry-analysis-verdict-2` ∥ verify model ∥ category ∥ passage ∥ prompt.
  Flags AND skips, so a re-run against an edited book re-pays only the
  edited passages.
- **This header is a cross-repo contract** (BookForge reads it directly and
  refuses on a missing field). Format 2 is announced to BookForge before it
  ships, and reaches them with the `app/` re-vendor, which carries the engine
  bundle (`app/engine/foundry-engine.cjs`).
- The rank file (`<report>.rank.json`, `analysisRankFileFor`) is the pair's
  scratch: written by the ranking row, read by the analysis row, removed when
  the analysis lands, kept on any other ending so a Retry of the analysis
  does not pay the card for the ranking again.

---

## 7. The app: the step, the queue, the panel

- **An analysis is two queue rows, pressed as one** (2026-09-25):
  `analysis-rank` on the decide act — placed on the server's `clean` row, the
  model a cleanup's triage runs on, leased as decide (`placeJob`) — and
  `analysis` on the analysis class, waiting behind it (`Job.after`). Both are
  held, pinned together to the server the dialog chose, and released together
  by Start; the dialog draws the ranking's bar, then the check's. A ranking that
  fails takes the analysis with it. `enqueueAnalysis` answers both rows,
  `enqueueTriagedCleanup`'s shape. The rank row lands no step.
- `'analysis'` joins `STEP_ACTIONS` (one array, union derived — the capture
  lesson), `JobKind`, and `JOB_RESOURCE` as **gpu** (the model holds the card,
  translate's reason); `'analysis-rank'` is a `JobKind` on the gpu lane too. Lane wording added to the shelf. Two new progress
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
  translate-dialog shape: category checklist and the server to run on — no
  sensitivity control, because there is no strictness to choose (§2).
  Enqueued held, like everything expensive. **No unapplied guard**: the run reads the book file
  and writes a report; it consumes no rendering (the sweep's rule, decided
  explicitly).
- **The checklist can be added to** (Owen, 2026-08-25: *"maybe the user can
  add more categories - even one-sentence descriptive ones. and they check off
  which ones they want to search for in this document."*). A category the user
  writes is a NAME and ONE SENTENCE; the sentence IS the question — its first
  sentence the ranker's line (`customOptionText`), the whole of it the
  verifier's claim — and the category is marked untuned (§5). Two facts, two homes: WHAT
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
- **Free text still never reaches a model's question by accident**, and the old
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
  (`<report>.categories.json`, read by BOTH rows of the pair) carries
  `{name, enabled}` and, for a user's own category, `description` and `label`.
  Four fields and no more: `parseCategoriesJson`
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
- ~~**The strictness filter is three buttons on the panel** — Strict (flagged,
  score ≥ 0.9), Moderate (flagged, ≥ 0.7), Loose (everything, skips ghosted).~~
  **GONE, 2026-09-25, by Owen**: *"we wont have two separate categories in
  this. confirmed only."* The report holds the flags alone, each card shows the
  verifier's reason under its quotation, and the legend is the only filter.
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
  for cream at `hsl(H 75% 68% / .32)` —
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
  (`≈`, the sheet's own estimate mark), the quotation as the body, the
  verifier's reason under it, and the other flagged categories named with
  their own reasons where there are any. (Until 2026-09-25 it also carried the
  entailment score and, under Loose, the verifier's rejection.)
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
- **THE LEGEND IS THE FILTER.** Each category present in the report gets
  a chip — dot, name, count — and pressing it switches that category's cards
  AND its highlights on the paper off, because they are one list (`hits` is
  what the panel draws and what `litRanges` paints). This is the clause this
  section promised and Unit AN-2 deferred out loud. It is a set of the HIDDEN
  and not of the shown, so an empty set means everything and a report that
  grows an unfamiliar category shows it. Counts are taken BEFORE the filter, so
  a switched-off row keeps the number telling you what turning it back on
  would bring.
- **NO BLOCK IDS.** `b151-5` is a coordinate this program keys ops and travel
  by and is not a thing a reader has any use for; the no-filenames-in-copy rule
  is read as covering it. Travel is the WHOLE CARD (a chip-sized target inside
  a paragraph-sized row is a target you can miss), with a 1px hover raise as
  the affordance — never a growth, which is the "rows that move under the hand"
  fault Owen ruled against on the sweep.
- **NO TOOLTIP THAT REPEATS THE CARD.** The `also` categories are named
  instead of counted behind a `+2`, each with its reason on the card. (The
  tier buttons and the score, the two that carried a hover sentence of their
  own, went with the tiers.)
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
    listener on the list with `closest('.card')` as the test, and the legend
    deliberately outside it, because changing what is shown is not
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

- **No discovery fallback and no local ranker** (§4). Without a Crucible that
  serves a decide model, analysis refuses by name.
- **No severity** (§1). The verifier's reason is shown; nothing ranks a
  finding's badness.
- **No verify budget and no display tier** (§4, §8). Every window is verified
  and only the flags are shown.
- **No chapters from the ranker.** briefcase's snap engine also outlines and
  chapters a video; a book takes its chapters from its structure, so only the
  flag half is ported.
- **No misinformation category** — measured out in briefcase, and its snap
  ranker skips it by default too.
- **Tuning** — the span numbers (τ, λ, the 0.34 floor, the baseline, the
  section sizes) are briefcase's plan arithmetic, unmeasured on flags even
  there, and the book categories' lines are first drafts. Both are follow-up
  work against reference books; the rank file keeps the rating map so the
  spans can be re-read without the card.
- **BookForge parity**: the deprecated BookForge analysis is not touched;
  this reaches BookForge by the normal re-vendor, later.
