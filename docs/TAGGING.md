# Tagging — one document, against somebody's own vocabulary

`foundry tag` answers one question about one document: **which of these tags
apply, and what else would you call it?**

The reader it is for is a lawyer with a personal tag vocabulary —
"christian nationalism", "free speech", "ban" — and her own software, which
loops over her documents, converts each to plain text, and calls this command
once per document. It is deliberately the small sibling of `analyze`
(docs/ANALYSIS.md): the same NLI worker, the same widest net, the same
schema-constrained verifier, a different question, and no map.

---

## 1. The contract

```
foundry tag --doc <file.txt> --tags <tags.txt> [--out <file.json>]
            [--model <name>] [--ollama <url>]
            [--nli-python <path>] [--nli-home <dir>] [--fetch-nli-model]
```

- **`--doc`** is UTF-8 plain text. **No PDF, no DOCX, no EPUB, by ruling** —
  the software that calls this converts first (§5).
- **`--tags`** is her vocabulary, one tag per line, blank lines skipped.
  Repeats and lines with no word in them are dropped and counted.
  **An empty file is a legal run**: nothing is ranked, no entailment model is
  loaded, and the answer is suggestions alone — which is the first run, before
  there is a vocabulary to compare against. An ABSENT file is refused; it is a
  path that is wrong, and answering it with "no tags applied" would be a claim
  about a comparison that never happened.
- **`--model` / `--ollama`** default to the standing rulings, `qwen3.8:27b` and
  `http://localhost:11434`. foundry never starts, stops or pulls a server.
- **`--nli-python`** names the interpreter for the NLI worker, env fallback
  `FOUNDRY_NLI_PYTHON`, and it is `analyze`'s worker, `analyze`'s env and
  `analyze`'s rules whole: no PATH search, and a miss names every candidate that
  was tried. It is required only when there is something to rank.
- **stdout is the answer, stderr is the progress.** With `--out` the JSON is
  written there and the absolute PATH is the last line on stdout — the house
  convention, so a caller shelling several foundry commands back to back never
  has to know which one it is reading. Without `--out` the JSON itself goes to
  stdout and no file is invented.
- **Exit 2 is a bad command line and nothing ran** — a missing `--doc`, a
  missing `--tags`, a missing interpreter. **Exit 1 is a failure after work
  began.** Progress lines are monotonic: `tag: rank <n>/<m>`,
  `tag: verify <n>/<m> (<tag>)`.

---

## 2. The pipeline

**1. RANK.** The document is cut into paragraphs (blank-line separated,
everything inside one collapsed to single spaces — a single newline is somebody's
word wrap and means nothing) and each paragraph into sentences by `analyze`'s
segmenter. Every sentence and every sliding three-sentence window is then scored
against every tag by the same resident Python worker
(`MoritzLaurer/deberta-v3-base-zeroshot-v2.0`, `multi_label`), at
`analyze`'s capture floor of 0.2 with its rescue rule at 0.15. **There is no
sensitivity knob here either**, for `analyze`'s reason (ARCHITECTURE.md §5): the
good value is known, and it is "the widest net, once".

**The hypothesis is aboutness, and the template is not touched.** A category in
`analyze` carries a stance proposition an author could assert. A tag is a
subject heading, so the hypothesis is `about <tag>` — and because the worker
wraps every hypothesis in the transformers pipeline's default template,
`"This example is {}."`, which is the calibration and is never edited
(`nli_worker.py` carries the incident), the label is written to COMPLETE that
wrapper: *"This example is about free speech."* The whole stance/aboutness
difference is those two words.

**2. VERIFY.** Each tag anything scored for costs exactly one
schema-constrained Ollama call, carrying that tag's five best passages:
does this document genuinely concern that subject? A yes puts the tag in
`applies`, **spelled as she spelled it**. A tag nothing reached the floor for
costs no call — there is nothing to show a model but the word itself.

**THE QUESTION IS NOT `analyze`'S.** `analyze` asks whether the AUTHOR asserts
a claim, because it is hunting for what a book is pushing, and that question is
what keeps a history of propaganda from being flagged as propaganda. It is the
wrong question here: an opinion striking a ban down is about "ban" and about
"free speech", and a brief attacking a doctrine is about that doctrine. Both are
yes.

**3. SUGGEST.** One more call, over the document's highest-signal passages and
her whole vocabulary: up to ten NEW tags, in the style of her list, short
lowercase noun phrases. They are trimmed, lowercased, dropped if they are a
clause rather than a name, and deduplicated — against her list and against each
other — by a normal form that folds case, quotes, dashes and a trailing plural,
so a suggestion of "bans" against her "ban" is not offered as new. **With nothing
ranked** (an empty vocabulary, or a document that matched none of it) the sample
is an even stride across the whole document, because a term-frequency pick with
no corpus to weigh against finds the most repetitive passage and the first N
sentences find the title page.

**A degraded call is a "no", never a "yes"** — an unreadable answer must not be
able to label a document. A run where EVERY aboutness call degraded refuses
rather than writing "no tags applied", which is exactly what a document about
none of them looks like; so does a run whose suggestion call produced nothing,
because an empty `suggested` is a claim this program would not have made.

---

## 3. The output, which is a cross-repo contract

```json
{
  "applies": ["christian nationalism", "free speech", "ban"],
  "suggested": ["first amendment", "public education", "legislative intent"]
}
```

- `applies` — her tags that hold for this document, **verbatim as she wrote
  them and in her file's order**. Nothing recases, re-spaces or rewrites a
  vocabulary; it is a person's own words.
- `suggested` — tags that are not in her list, in the order the model offered
  them.

Two keys, two arrays of strings, always both present, arrays possibly empty.
**Her software consumes this file, so the shape is a contract**: fields are
added, never renamed or removed, and any change is ANNOUNCED before it ships
rather than met as a parse failure on the far side — the same standing posture
as `analyze`'s report header and `vtt-book`'s decode recipe.

---

## 4. What is deliberately not built, out loud

- **No map of where a tag matched.** That is `analyze` (docs/ANALYSIS.md §6):
  block ids and character offsets, a panel, highlights, travel. This command
  answers a SET, and building the locator twice would be two answers to one
  question that could disagree.
- **No PDF, DOCX or EPUB handling.** The parent software converts. One program
  owning document conversion is the arrangement that keeps a second, quieter
  converter from growing here.
- **No sensitivity knob**, per §2.
- **No fallbacks of any kind.** No LLM-only route when the worker is missing, no
  NLI-only route when Ollama is: either would answer a different question from
  the one this JSON claims to answer (ARCHITECTURE.md §8).
- **No scores, no confidences, no explanations.** The tag set IS the answer —
  `analyze`'s ruling (§1 there), for the same reason: a rationale invented for a
  label the model has just chosen is a fabrication that reads like evidence.
- **No report file and no cache.** A tag run is one document and minutes, so it
  holds its answers in memory and writes once at the end. `analyze`'s
  append-and-fsync report exists because a book is hours.
- **No calibration of its own.** The floors are `analyze`'s, carried over
  whole, and nothing has been measured against a legal vocabulary. That is the
  first thing to revisit when there are real documents to audit against.
