# Clean text — the narration text pass

**One text-normalization definition, shared by the Orpheus training corpora and
BookForge's narration**, run as an intentional step the user queues and the book
remembers.

---

> **PROVENANCE, AND WHO OWNS THIS NOW.** The body of this document below the
> engine section is BookForge's `docs/NARRATION_TEXT_PASS.md`, vendored
> byte-identical from `bookforge` main at commit **`0f962d5f`** and then edited
> only where it names a file path that has moved. Every ruling in it is Owen's
> and stands unchanged.
>
> Owen ruled on **2026-09-05** that the pass MOVES INTO THE ENGINE: the act is
> called **Clean text**, it is one of three sibling text acts (`translate` /
> `simplify` / `clean-text`) sharing the records-file machinery, and **Foundry
> becomes the owner of `NORMALIZER_VERSION` and `PUNCTUATION_SPEC_VERSION`** and
> the source the `orpheus-finetune` training repo vendors from.
>
> The five modules, the two prompts, the word list and both fixture files live
> in `src/clean/` and `test/clean/fixtures/`, and the commit that put them there
> changed not one byte of any of them — it is the anchor a drift check pins to.
> The version-bump policy below is now THIS repository's to obey.

---

## The engine's door — `foundry clean-text`

```
foundry clean-text --book <book.jsonl> --records <out.records.jsonl>
                   --stamp <out.stamp.json> [--generation <id>]
                   [--endpoint <url>] [--model <name>] [--keep-model]
```

`--generation` is `translate`'s field in `translate`'s words — the app's binding
of a records file to the reading it was made from, written into every row and
never interpreted here. It is not decoration: the app's shared argv builder
appends `--generation <reading generation>` to **every** text pass, so a hosted
**Clean text** press against 1.1.0 died on `unknown option --generation` before a
block was read. Sharing `records.ts` and not sharing the field that binds a
records file to its reading is sharing half a format.

Input is a **book file** (docs/BOOK-FILE.md), not an EPUB — the engine is handed
the book itself, one row per block, before any spine or package document exists.
Output is a **records file** in `src/translate/records.ts`'s format and a
**stamp**. No second book is written: the app materialises the cleaned edition
from the records and the parent book together (docs/RENDERER.md §4), which is
exactly how a translation reaches a file.

### Which blocks — the plan is `translate`'s, imported

`bookRowPlan` + `bookTitlePlan` (`src/translate/bookrows.ts`), unchanged, so
**exactly the blocks a translation would touch are the blocks a cleanup
touches**. That file argues every one of its decisions and each is as true of a
cleanup as of a translation: a shelved row is not in the book, `Formula` and
`Picture` are skipped and counted, a `Table` is taken apart into cells and put
back by splicing rather than by asking a model to preserve a grid, a folio is
carried without being asked about, and a chapter title is asked for only where
it cannot be PROVED to be a copy of a heading the run already handled. Sharing
the plan is what makes the two acts commutable.

**This is where the engine diverges from BookForge, deliberately.** That pass
runs `selectNumberTargets`, which drops a **caption** and a **footnote** — and
its reason is stated below: the narration cut has already removed them from the
file the pass is handed. *There is no cut here.* `clean-text` produces records
about a BOOK, and a caption and a footnote are blocks of the book that
`translate` transforms like any other. So the plan decides, the selector is not
consulted, and what a narration copy contains stays the cut's decision, made
later, by whoever makes it.

`preformatted` is likewise always false on this route, and that is stated rather
than assumed: a book file row carries no styling and no `white-space`
declaration, so nothing can read the answer off it. What it costs: a code
listing the vision model categorised as `Text` is canonicalized like prose here,
where the EPUB route would have refused it by name.

### The marker rule — what `SPANS_MARKUP` means on a book file

Every refusal this pass makes about markup is expressed against ONE array,
`segments`: on the EPUB route, the length of each descendant **text node** of an
element, summing to `text.length`. A span inside one segment can be spliced with
every tag around it untouched; a span that crosses a boundary would reach across
an `<em>`, a `<sup>` or a link and is refused `SPANS_MARKUP` rather than
flattened. Three copies of the same four-line walk enforce it —
`withinOneNode` in `applyNumberRules`, `withinOneNode` in
`validateNumberEdits`, `nodeHolding` in the punctuation stage.

**A book file row has no text nodes.** Its markup is IN the string: `**bold**`,
`*italic*`, `***both***`, `_italic_`, and a run of Unicode superscript digits
for a note marker (`dotsInline`, `src/vlm/dots.ts`; the mirror is
`app/shared/inline.ts`). Two obvious answers were both rejected:

* **One segment (`[text.length]`)** — which is what the vendored plain-text
  driver does for the `.txt` audition path, saying so out loud: *"a block is one
  text node, so `SPANS_MARKUP` can never fire"*. Harmless on an audition. On a
  BOOK it lets a punctuation span or a model edit delete one of a pair of
  asterisks, and the damage does not appear until the book is rendered — a
  `<strong>` that never closes, or `starEmphasis`' single-star pass pairing the
  survivor with a star on the far side of an emitted element, which
  `src/vlm/dialect.ts` carries the measured version of.
* **Masking the markers** the way `translate` does (`textmask.ts`), showing the
  model prose with `⟦e1⟧` in it. That breaks the pass at its centre: the
  validators judge an edit by its WORDS — `keepsEveryWord`, `classifyEdit`, the
  one-token law — and a token is a word to all of them. The one-token law would
  be deciding cases about this program's own private syntax.

**So a segment is re-spelled and nothing else moves.** `markerSegments`
(`src/clean/segments.ts`) cuts a row into the runs of plain text between its
markers and the marker runs themselves, in order, summing to `text.length`
exactly as text nodes do. All three checks work unchanged, on unchanged code,
and the disposition is still `SPANS_MARKUP` because it still means the same
thing: **an edit may not reach across an inline marker.** The markers come
through byte for byte around whatever changed.

The boundary is drawn on the **characters** — every maximal run of `*`, `_` or a
superscript digit — rather than on any one emitter's pairing rule, because this
asks *"could a character here be markup?"*, not *"is this pair emphasis?"*, and
its two errors are not symmetric:

| | cost |
|---|---|
| over-protect | one cleanup span is refused, BY NAME, in the receipt and in the stamp's `punctuationRefused` count. A person can read it. |
| under-protect | a star is deleted from the middle of a book by a pass that reported success, and a reader finds it. |

Character runs are provably a superset of every pattern `starEmphasis`,
`inlineMarkdown` and `textmask.ts` apply — each of those matches only spans
built out of these characters — so no marker any renderer would write can fall
inside a plain segment however the pairing rules move. What it costs is named:
an edit spanning the underscore of `AfW_HH_231191` is refused, and a lone
asterisk a scan left in the prose protects the two characters beside it.

### The records contract

One row per block asked, in `src/translate/records.ts`'s format — the same file
`translate --records` writes, and the same reader on the other side.

| field | on this route |
|---|---|
| `key` | `cleanKey`: sha-256 over a format string, the **model**, `NORMALIZER_VERSION`, `PUNCTUATION_SPEC_VERSION` and the block's **source text**. |
| `parts` | the row's own id (`b12-3`, `b12-3#1`, `b2-3/1`), or `chapter:<division id>` for a title. |
| `text` | the cleaned text, in the flowing block's own dialect. |

**The file is the cost cache.** A key already in it is never asked of a model
again, so a killed run resumes and pays for nothing it already bought — resume
semantics identical to `translate`'s appends. What the four key fields buy:
editing one paragraph re-cleans that paragraph and nothing else; changing
`--model` re-cleans everything; **a bump to either version re-cleans
everything**, which is correct rather than unfortunate — a book cleaned at `n5`
was cleaned by rules this build no longer runs. A paragraph that appears twice
is asked once and gets two rows, because materialization looks up by POSITION.

A row is only appended where it says something new, so re-running over an
unchanged book writes nothing at all. A position whose newest row a **person**
wrote is left exactly as they left it, unless the source text under it has since
changed — in which case the machine's row goes on top, the run says so, and the
correction is still in the file above it, because this format appends.

A table is the one block whose record is written once for the whole ROW: the
cells are cleaned separately and spliced back into the source string's own
ranges, so the tags, the attributes and the cell order are untouched by
construction. A grid the answers broke is left as printed and named.

### The stamp

`--stamp` writes BookForge's `NarrationTextStamp`, field for field:

```json
{"stampVersion": 2, "normalizerVersion": "n6", "punctuationSpec": "s1",
 "model": "qwen3.8:27b", "at": "2026-09-05T…Z", "punctuationRefused": 0,
 "blocks": {"b12-3": "6ac778d1…", "chapter:c3": "a40703bd…"},
 "textDigest": "22abe835…"}
```

The two version fields are **read from the modules that define them** and are
never literals — `narrationTextStamp` is the only constructor and it takes no
version parameter, so no caller anywhere can supply its own idea of what `n6`
is. A stale copy of a version somewhere else is a claim about a pass that no
longer runs, which is the exact defect this ownership move exists to end.

It is written on **every** run, even one that changed not a single character,
because the stamp is what unlocks the render: a book that merely printed no
curly quote and no digit has still HAD the pass.

`punctuationRefused` is the count of punctuation-stage spans the pass could read
and was not allowed to apply, and **every one of them is named** — on stderr as
it happens, and in the receipt with its `find`, its `replace` and its reason. So
a book with three hundred unreachable spans is not byte-indistinguishable from a
clean one.

### The digest contract — a claim the render door can CHECK

> Owen, 2026-09-05, on the gap BookForge measured: **"recompute over the book
> handed and refuse by name on mismatch."**

`vlm-compile --narration-stamp` used to stamp whatever book it was handed.
Compiling the **uncleaned** parent book with the flag produced an EPUB whose OPF
claimed a cleanup over text still reading *"Dr. Smith"* and *"$5,000"* — six
fields all true about a pass that really ran, and a lie about the file they were
written into. The render door reads the FILE, so it believed it.

So the stamp says **what** it cleaned. Two fields, beside the six:

| field | in the `.stamp.json` sidecar | in the OPF |
|---|---|---|
| `blocks` | position → sha-256 of the cleaned text | how many positions that map holds |
| `textDigest` | one order-independent digest over the whole map | the same string |

`stampVersion` **stays 2**. BookForge's reader refuses a MISSING field and never
enumerates keys, so the six it knows are all still there and a field it has never
heard of costs it nothing.

**The text form is defined once and both sides import it** (`blockDigest`,
`src/clean/digest.ts`): *the block's own text, as the book file holds it — the
flowing dialect string, BEFORE any rendering transform.* Before the emitter turns
it into XHTML, before entities are escaped, before pagebreak markers, before a
superscript run becomes a noteref anchor. On the writing side that is the newest
record's `text` at the position, or the book's own text where no row was written
— which is exactly what materialisation puts there, hand-corrected rows included.
On the reading side it is `BookRow.text` at that position. Hashing the RENDERED
XHTML was rejected: an emitter that writes `&#8217;` where it used to write `’`
would break every digest on disk while changing not one word of anybody's book.

**An absent position is SKIPPED and counted; a present one that differs
REFUSES.** Owen ruled it, and the reason is the shelf: a person strikes a block
after the cleanup ran and it is legitimately gone without one character of the
remaining text having moved. Refusing that would make every removal re-buy the
whole book's model time. A block that is *present and different* is text this
cleanup never saw, shipping under a claim that it did.

**Not ONE position in common is not a trimmed book** — it is a stamp about a
different book, and it is refused as one. `refuseForeignRecords`' existence test,
for its reason.

The refusal names the count and the first five positions and says what it means:

> `--narration-stamp <path>` claims a narration text cleanup over 7 block(s), and
> 6 of them do not hold the text that cleanup produced — e-2, e-3, e-4, e-5, e-6
> and 1 more. **THE BOOK HANDED IS NOT THE ONE THIS CLEANUP PRODUCED**: a stamp
> is a claim about a FILE, and this recomputed it over the book it was actually
> given. Compile the position that sits UNDER the clean step — the book file
> materialised from that step's records — or run `foundry clean-text` over this
> book and stamp with the stamp it writes. Nothing was written.

**`vlm-convert --narration-stamp` REFUSES a stamp that names blocks**, and points
at `vlm-compile`. That route reads a PDF and mints the book as it writes it: it
is handed no book file, its own records are keyed by the cast's `page:order`
coordinates rather than by row ids, and there is nothing to hash the stamp's
positions against. Carrying it unchecked would be the measured defect at its
worst — a book read fresh off a PDF has by definition never had the pass.

A stamp carrying **no** `blocks` (BookForge's own pass writes one; so did foundry
1.1.0) is still carried, and the run says on stderr that **nothing was
recomputed** rather than implying a check that did not happen.

Hand the file to `vlm-compile --narration-stamp` or `vlm-convert
--narration-stamp` and it goes into the OPF's `<metadata>` as
`<meta name="bookforge:narration-text" content="…"/>` — EPUB 2's form, spliced
in by `insertPackageMeta` (`src/epub/meta.ts`) by source offset, never by
re-serialising the package. Ignored with a note on stderr for a non-EPUB format;
a file that is not a stamp of this shape is refused by name before any work.

### What the run says

Progress on stderr, line-buffered — **BookForge mirrors these shapes, so they do
not move**:

```
clean-text: <done>/<total>
clean-text: <n> blocks, <m> changed, <k> edits refused in <s>s
```

The **receipt** lands at `<records>.receipt.json`, a suffix on the whole path and
never a rename (`pendingRecordsPath`'s idiom): every punctuation rule and how
often it fired, every span the punctuation stage could not reach, every block
that was asked about, every edit the model proposed and the validator's verdict
on it. Every refusal is ALSO said on stderr by its **disposition's own name** —
`REFUSED NOT_A_READING`, `REFUSED SPANS_MARKUP` — because those names are argued
in this document and a person reading one can find the paragraph that governs
it, where a person reading "the replacement was not accepted" cannot.

### Refusals by name

* a `--book` that cannot be read, or is not a book file;
* a book with no block that has words in it;
* a `--records` file written about a **different book** — the test is EXISTENCE,
  not coverage: one position in common proves the file is about this book, and
  zero, with rows in it, cannot be an accident (a partial file is the normal
  state of a resumed run and must not trip it);
* a server that does not answer, naming the URL, and a model the server has not
  got, listing the models it HAS;
* **more than 10% of blocks failing to parse fails the run** — that is a model
  this pass cannot use, not a hard book.

A run whose every block is already answered **never opens the server at all**,
which is `askAboutEach`'s own rule one layer out: an Ollama that is down must
not fail a pass that had nothing to ask it.

### The model

`qwen3.8:27b` by default (`DEFAULT_TRANSLATE_MODEL` — Owen, 2026-08-22: 27b is
the standard for every task), **temperature 0**, `num_predict` 2048, one call
per block, over `/api/chat` through the engine's own Ollama client
(`src/translate/ollama.ts`). The context window is pinned ONCE for the whole
book, because Ollama reloads the runner on any change to it. The weights are
released when the run ends unless `--keep-model` says the machine is shared.

---

> Owen, 2026-09-04: *"We should make this its own intentional step that the user
> runs and persists, so we don't have to run it again. It runs the step on an
> epub that foundry exported/completed and it creates an updated epub. This
> should be a foundry step that's necessary before it goes to TTS."*
>
> And on where it sits: *"a step that can be performed at any point, including on
> an epub, but it's a computationally expensive step that needs to take place
> somewhere along the line, and everything after it is finalized/fixed … a step
> that goes in just like translate/simplify."*

---

## What the pass does

Three stages, over every text of the book, **in this order**:

| # | stage | what | where |
|---|---|---|---|
| 1 | **Punctuation** | canonical ellipsis `...`, the quote map, control characters and invisibles deleted, every space variant to U+0020, repeated spaces collapsed, `--` to an em dash, `?!!` to one mark, trailing line space trimmed. **Dashes the book printed are kept.** | `electron/tts-punctuation.ts` (spec `s1`) |
| 2 | **The number rules** | the shapes a narrator's reading is *guaranteed*: dates, clock times, money, percent, decades, ordinals, `#N`, comma-grouped and bare integers. Citation apparatus is left as printed — and so, since n6, is every **scripture reference**, which this stage only *detects and protects*. | `electron/tts-number-rules.ts` |
| 3 | **The model, on EVERY block** | every judgement only the sentence can settle: number residue, abbreviations, all-caps runs, bracketed apparatus, spaced hyphens, roman numerals, footnote markers. Every edit passes a wall of validators; a rejected edit means the text stands as printed and the rejection is recorded by name. | `electron/tts-number-normalizer.ts` (`NORMALIZER_VERSION`) |

> Owen, 2026-09-04: *"send every single block through to be sure. I suspect
> deterministic decisions on this aren't the right way to do it. Let the model
> decide what should be updated."*
>
> So stage 3's selection is **not** a digit test. Every block of the book goes to
> the model — one call per block, `qwen3.8:27b`, temperature 0 — with the whole
> instruction set as the prompt. That cost is accepted for this pass because the
> pass runs **once** and the book keeps the result. The plain-text audition path
> (`--tts --text`) keeps the digit test: it has no chain, no stamp, and no book.

**The order is load-bearing.** `normalizeQuotes` turning `…` into `...` *after*
`applyNumberRules` had computed offsets would invalidate every one of them.

Stage 1 writes a book and stages 2–3 read it — two writes, not one. Stage 1's
offsets are into the printed book, and the number rules' `find` strings routinely
contain characters stage 1 created (`"250 members` opens with a quote the printed
book set curly). Composing them into one rewrite list would mean either refusing
every number that stands beside a canonicalized quote, or hand-merging
overlapping spans: a second coordinate system to keep true. Both writes go
through `writeNarrationEpub`, which proves every rewrite landed or destroys its
output, and the intermediate is content-addressed and reused.

### What the model may and may not do

The model returns an **anchored edit list** — `{find, replace}` pairs, each a
verbatim span of the block — or an empty list. It never returns rewritten text.
Every edit is judged by `validateNumberEdits`, and the class it belongs to is
derived from the span (`classifyEdit`), never declared by the model.

A **number** edit has a lexical anchor: `keepsEveryWord` proves every prose word
of the find survives, and `NUMBER_DROPPED` proves every printed number came out
as words. Those invariants are unchanged.

A **text** edit — an abbreviation, an acronym, a bracketed aside — has no such
anchor: "Dr." → "Doctor" legitimately replaces the letters, so nothing can
compare the two sides word for word. What guards it instead:

| invariant | disposition |
|---|---|
| the find is verbatim in the block and occurs exactly once | `NOT_FOUND` / `AMBIGUOUS_FIND` |
| the find is at most 200 characters — a span, not a clause | `EDIT_TOO_LONG` |
| the replacement is spoken words, and carries no digit | `REPLACE_NOT_WORDS` / `DIGIT_IN_REPLACE` |
| the replacement is at most `4 × find + 40` characters | `REPLACE_TOO_LONG` |
| a **removal** is allowed only for a whole bracketed insertion | `EMPTY_REPLACE` |
| the text edits together replace at most 25% of the block (floor: 80 characters, so a heading's one edit is not refused) | `BLOCK_BUDGET` |
| at most 24 edits are accepted per block | `TOO_MANY_EDITS` |
| the edit may not touch a span the deterministic rules already rewrote | `OVERLAPS_APPLIED` |
| the span may not cross a text node — an `<em>`, a `<sup>`, a link | `SPANS_MARKUP` |

A block whose answer will not parse is retried once at the same settings
(temperature is pinned to 0 for every request), then recorded `UNIT_PARSE_FAIL`
with its text intact; more than 10% of blocks failing to parse fails the whole
pass by name. **A paraphrase is never silently accepted** — but see the OPEN
CONCERN below.

### The one-token law — what stands in for a lexical anchor

> Owen, 2026-09-04: for a non-number class the replacement must preserve every
> alphabetic word of the find, in order, EXCEPT the single token the class is
> allowed to change. **One-token edits only.**
>
> And the second adversarial review's ruling on top of it: the validator must
> verify that the replacement **is a reading of that token**.

A *number* edit has a lexical anchor: `keepsEveryWord` proves every prose word of
the find survives and `NUMBER_DROPPED` proves every printed number came out as
words. A *text* edit has none — "Dr." to "Doctor" legitimately replaces the
letters — so before this law the caps bounded size and nothing bounded meaning.
The adversarial review of 2026-09-04 measured what got through: a name swapped, a
negation flipped, an OCR "correction", a heading rewritten whole, an
89-character sentence 80 of whose characters were replaced. Every one is refused
now, and every one is a keeper test.

How it is enforced:

* the span's class is derived from the span (`classifyEdit`), never declared by
  the model;
* a span whose class is **other** — ordinary prose — is `NOT_A_CLASS`;
* at most **one** word token of the find may be missing from the replacement, and
  that one must be the class's own: a dotted abbreviation, a run of capitals, a
  roman numeral. Anything else is `WORDS_DROPPED`;
* a **spaced hyphen** edit may change no word at all — it is punctuation;
* a **removal** is allowed only for a whole bracketed insertion of at most three
  alphabetic words, so `[sic]` and `(see page twelve)` go and
  `(the guarantee would hold)` stays;
* a **number** reading may hold the find's own words, its number words and three
  joins, and no more — `WORDS_ADDED`, which is what stops
  "The 12 men who refused were shot" becoming "… were spared, and the men who
  shot" while passing every number invariant.

* **nothing may be ADDED** either — the replacement's words are the find's words,
  minus the token that changed, plus that token's reading, and no more
  (`WORDS_ADDED`). Without it a replacement could keep every word and append a
  sentence, or insert a "not";
* and the replacement must be **a reading of the token that changed**
  (`NOT_A_READING`). The model decides WHETHER a token is read differently;
  `electron/tts-spoken-forms.ts` decides what it may become:

| class | allowed reading |
|---|---|
| all-caps | its own letters, spaced (`FBI` → `F B I`), or its own word in ordinary case (`SAID` → `said`), **in that case exactly** — "The f b i had" was applied and written verbatim before the case was checked. The lower-cased reading needs **four letters and the lower-cased form to be an English word** in `electron/data/english-words.json`; a denylist could not bound an open class (OSCE, RSHA, SHAEF, BOAC, ICAO, IATA, ASEAN, SWAPO, UNITA, FRELIMO, COMECON, UNPROFOR, ELAS, EOKA, ODESSA all passed it). `US` and `WHO` get the letters reading only, by length. An acronym that happens to be a word (ARMS) keeps both readings, which is accepted. An acronym a person listed as *said as a word* (NASA, NATO, …) is read as printed |
| abbreviation | an entry from the curated table — Dr. Prof. St. Mt. Ave. Blvd. Rd. Jr. Sr. No. e.g. i.e. etc. vs. viz. cf. a.m. p.m. and the rest — in the case the table wrote it, all lower, or capitalized on the first letter. **An unknown abbreviation is REFUSED and named**, never guessed. Mr./Mrs./Ms. are deliberately absent — the prompt says to leave them |
| roman | exactly the cardinal or ordinal words of its value, with or without a leading "the" — **and only where a book prints a numeral**: after a part word, before a century, or after a name from the **curated regnal list** (monarchs, popes, emperors). "Any capitalized word" read "Doctor Smith MD" as "Smith one thousand five hundred". MD, CD, DC, MC, CV, MM, XL, DI, LI, IX, CIV and MIX are legal numerals *and* ordinary acronyms, and forcing them through the roman table made `M I X` impossible. **The letters reading is never forbidden** |
| bracket | **square** brackets: an interpolation of WORDS is READ — the permitted edit is to drop the brackets and keep the words (`[he said]` → `he said`) — and only apparatus is deleted (`[sic]`, `[12]`, `[ed.]`, `[…]`, `[*]`). **round** brackets: the author's, deleted only when the contents match an apparatus PATTERN with a digit, a citation abbreviation or a fixed editorial term (`(sic)`, `(see page twelve)`, `(emphasis added)`, `(Kershaw 1993)`, `(12)`), so `(note she wept)` and `(source of evil)` stay |

**A table key that is also an English word** (`no.`, `co.`, `am.`, `st.`) carries a
context rule and is refused without it: `am.` needs a number before it,
`st.`/`co.` a capitalized word on one side, and **`no.` must be NUMBERING
something** — a digit after it *and* a thing being numbered in front of it (a
capitalized word, a word like "file"/"doc"/"item", or the start of the block).
A digit alone was not enough: "The answer was no. 12 men voted" read "…was
number 12 men voted", taking the next sentence's number as its own. Without them
"a flat no. The committee" read "a flat number The committee" — the wrong word
*and* a fused sentence.

**A reading may not move the punctuation** around the word it changes: every
mark of the find outside the changed token must reappear, in order.

**An abbreviation whose period may end a sentence must keep it.** Asked of the
BLOCK at the token — what follows the *token*, not what follows the *find* —
because the prompt tells the model to widen a find until it is unique and the
guard used to switch off the moment it did. "Oxford St. The rain" reads "Oxford
Street. The rain" however wide the find is. The exception is a **title prefixing
a name** (`Dr.`, `Prof.`, `Mt.`, and `St.` when nothing capitalized already
stands in front of it): the capital after it is the name, not a new sentence, so
"Dr. Kempner" reads "Doctor Kempner".

**The ampersand** is its own class, and it has two shapes. A **spaced** `&`
reads "and". A **glued** one is a single token whose sides are read as class-3
tokens and joined by " and ": `AT&T` → `A T and T`, `R&D` → `R and D`,
`Smith&Jones` → `Smith and Jones`. A bare replace served both once, and wrote
`ATandT` into a book.

`classifyEdit` is per-token and position-aware: a period at the **end** of a span
is a sentence, not an abbreviation, so `He did not believe it.` is prose; a period
anywhere else is an abbreviation; a span-final one counts only when the table
already knows it.

The em dash is **the one character this pass may invent**. A spaced hyphen read
as a dash is checked by SHAPE — the replacement must be the find with its spaced
hyphens turned into em dashes and nothing else changed — so it works beside a
digit (`12 - and` → `12—and`), which it could not before: the find classified as a
number edit and the replacement was refused for carrying a digit.


## Where it runs

> The three doors below are **BookForge's**, over an EPUB, and they are recorded
> here because they are the requirements the rules were shaped by — the ledger,
> the gate, the stamp and the streaming path all still behave exactly as
> described. The engine's own door is `foundry clean-text`, above. Until
> BookForge calls it instead of running its own compiled copy, there are two
> implementations of this pass and the version-bump policy at the end of this
> document is what keeps them from drifting.

### 1. As a ledger pass — the main door

**The button is "Clean text…"**, on every EPUB version row of the versions page,
immediately left of "Narrate…" (`studio-versions.component.ts`,
`cleanNarrationText`). It submits through `processing:submit-chain` with the
pressed file as `sourcePath`, so the planner resolves the chain that file belongs
to and the pass cleans that book rather than the default family's.

The Narrate gate's offer (below) is the second door, not the only one — the first
cut of this work had no first-class control at all, which made the pass's own
"run it again" message name something the user could not find.

Kind `narration-text`, label **"Narration text cleanup"**, listed in
`BOOK_PASS_OPTIONS` beside `footnote-refs` / `simplify` / `translate` — a list
that **has no consumer today**: the passes modal it fed was deleted on
2026-08-18 and nothing renders it, so the entry keeps the data true and offers
nothing on its own. The live control is the **"Clean text…"** button above.
Planned by
`electron/processing-chain.ts`, queued through `processing:submit-chain`, run by
`electron/queue-steps/pass.ts`'s shared `passModule`, executed by
`runNarrationTextPass` in `electron/processing-passes.ts`. It never runs inline.

It records:

* `stages/NN-narration-text/diff.json` — the frozen receipt the versions page's
  **Review changes** reads (`writePassDiff` / `readPassDiff`);
* `stages/NN-narration-text/narration-text.receipt.json` — the full record:
  per-rule punctuation counts, every refusal, and the number pass's own unit
  record with every proposed edit and the validator's verdict on it;
* an `appliedPasses` entry and a **ledger entry** with the diff as its receipt.

**Nothing to do is a refusal by name.** A book that already carries a current
stamp gets a sentence saying so and nothing is recorded — `footnote-refs`' rule.
The one difference: a book that merely prints no curly quote and no digit is
still a real run, because the *stamp* is what unlocks the render.

### 2. As a CLI stage

```bash
python cli/bookforge-tts.py --narration-text --input book.epub
python cli/bookforge-tts.py --narration-text --project "<projectDir>"
```

**`--project` and `--input` are two different acts.** `--project` runs the app's
own pass (`planProcessingChain` + `runProcessingPass`), so the ledger, the
provenance record, the working-copy promotion and the narration re-cut all
happen exactly as they do from the button — writing a cleaned file *beside* a
project and touching nothing else left the project reading `missing` in the app
while its file carried a current stamp, which is the divergence that made the
re-run deadlock reachable. `--input` is the bare-EPUB door, for a file with no
project around it.

`--input` writes `<stem>.narration.epub` and
`<stem>.narration.narration-text.json` beside the input. A file that already exists and describes a **different** book
is never overwritten — `uniqueOutputPath` gives the new one its `" (2)"`. A
cleaned book whose receipt names *this* source at *this* version is reused, and
the reuse check enumerates **every** ` (n)` sibling: stat-ing only the bare name
meant that after one collision every later run minted a new copy and paid for a
full model pass while correctly-cleaned copies sat unread.

`cli/narration-text-step.js` is the one door; `cli/narration-text.js` is the
standalone command; both call the compiled `runNarrationTextPass` — the same
function the queue job runs, never a reimplementation.

`orpheus-batch-render.js` and `orpheus-audiobook-render.js` run that step
**automatically** before the prep, because an unattended chain has nobody to ask.

### 3. On the streaming path — punctuation only

**All three doors**, each immediately before `splitForTts`: the live stream
(`electron/tts-api-server.ts`, `electron/reader-stream-bridge.ts`, in
`handleSpeak`) and the persistent whole-book render the same bookshelf reader
plays from (`electron/book-render-service.ts`, both plan builders). The text is
passed through `canonicalizePunctuationText` and nothing else. Stage 1 is pure and instant and
has no opinion to get wrong; stages 2 and 3 are minutes of model time over a book
and are a *pass*, not something to do to a paragraph somebody is waiting to hear.

The `.txt` audition path (`--tts --text`, `--tts --input passage.txt`) keeps
cleaning inline in `prepareNarrationInput` — a plain-text audition has no document
chain to carry a stamp — and now runs stage 1 before the numbers there too, so an
audition measures the pipeline it claims to.

---

## The stamp

```xml
<meta name="bookforge:narration-text"
      content='{"normalizerVersion":"n6","punctuationSpec":"s1","model":"qwen3.5:9b-q8_0","at":"2026-09-05T…Z"}'/>
```

Written into the OPF's `<metadata>` by `writeNarrationTextStamp`, read by
`readNarrationTextStamp` (both `electron/epub-processor.ts`). EPUB-2's
`name`/`content` form on purpose: it needs no `prefix` declaration on `<package>`,
every reader and validator ignores an unknown `name`, and both EPUB versions this
app writes carry it unchanged. A stamp already present is **replaced**, never
joined — two stamps would be two claims about one file.

The ledger says a pass ran on a *project*; the stamp says it ran on a *file*. The
render door is handed a file — by the queue, by the CLI, by a batch chain on
another machine — so the file has to answer for itself.

---

## The gate

Two gates, one meaning:

| gate | asks | used by |
|---|---|---|
| `narrationTextGate(bookPath)` — `electron/narration-text-pass.ts` | a **file**: is there a stamp, and is it this build's version? | `prepareNarrationInput`, `cli/narration-text-step.js`, and the Narrate gate for the pressed row |
| `narrationTextReadiness(appliedPasses)` — `electron/narration-text-readiness.ts` | a **project**: is there a `narration-text` entry, and is it the LAST text-changing one? | the app's Narrate door, over IPC `narration:text-readiness` |

The project gate knows something the file cannot: a `simplify` or `translate`
recorded *after* the cleanup leaves the stamp on the book (those passes rewrite
text nodes, not the OPF) while making it a claim about text that is no longer
there. So the answer is three-valued, and the third value has its own sentence:

* **missing** — "This book has not had the Narration text cleanup, so its
  punctuation is whatever the book printed and its numbers are still digits.
  Narration reads the text exactly as it stands, so it has to run first."
* **stale** — "The Narration text cleanup ran, but a later pass rewrote the text
  after it, so what it cleaned is not what a narrator would be handed now. It has
  to run again." (Or, for a version mismatch: "…ran at n4/s1, and this build reads
  text by n6/s1. It has to run again.")
* **ok**.

A stamp this build cannot read — malformed, or written by a version that did not
record every field — reads **stale**, carrying the reader's own sentence inside
the reason. It never throws out of the render door.

**The pass guards itself with the LEDGER, not the stamp.** `simplify` copies the
OPF byte for byte, so a book cleaned and then simplified still carries a current
stamp while its text is no longer the text that was cleaned — which is exactly
why the project gate reports `stale`. Guarding the pass on the stamp made the
"Run cleanup again, then narrate" flow a hard deadlock: the pass refused as
"already done", the step failed, and the chained narration never ran. There is
one authority now, and "nothing to do" is a **success with a note** rather than a
failure, because work is chained behind it.

**Three answers, not two.** The readiness IPC returns the chain's answer *and*
the pressed file's own, because they can disagree:

| chain | file | what the modal does |
|---|---|---|
| not ok | — | offers the cleanup, chains the narration behind it |
| ok | not ok | "This version was exported before the cleanup" — offers to narrate the current book instead |
| unresolvable (two chains, the row names neither) | ok | proceeds; the file's stamp is authoritative |
| unresolvable | not ok | refuses, naming the chain problem and the file's reason |

The gate only fires when something will actually be **read** — a cache-context
run ("assemble the clips I already rendered") reads no book text and is not
asked about.

`prepareNarrationInput` refuses with the file gate's sentence plus
`"(Narration was asked to read <book>; nothing was rendered.)"`. It does **not**
run the pass itself: an hour of model time inside a render's prep is exactly what
the ruling moved out of there.

"Everything after it is finalized/fixed" is what that staleness rule means in
code: the pass may be run at any point, and the TTS copy is always cut from the
book as it stands after it.

### The gate is a question, not a lock

> Owen, 2026-09-04: *"If the user hits narrate before it does cleanup, it tells
> the user it still needs to do the cleanup step; then it does the cleanup step
> on whatever the last step they did before exporting the epub they were trying
> to narrate, and then they export the epub and queue narration."*

So the narration modal's `onSubmit` asks `narration:text-readiness` **before it
queues anything**. When the answer is missing or stale it shows a confirm dialog:

* **title** — "Narration text cleanup"
* **message** — the readiness sentence verbatim (see the three above)
* **detail** — "Run it now? The cleanup is queued first, and this narration run is
  queued behind it — it will read the book the cleanup produced. It is minutes of
  model time over the blocks of the book, and it only has to happen once."
* **confirm** — "Run cleanup, then narrate" (or "Run cleanup again, then narrate"
  when the state is stale) · **cancel** — "Cancel"

**Cancel** puts the readiness sentence in the dialog's error line and queues
nothing. **Confirm** queues ONE run through `QueueService.submitProcessingRun` —
which is `processing:submit-chain` with a `followOn` — so the whole thing is a
single queue-engine job with ordered steps:

1. `narration-text` (the pass, on the family's book)
2. `tts-conversion`
3. `rvc-enhancement` — when the run asked for it
4. `final-denoise` / `reassembly` — when the run asked for them
5. `video-assembly` — when the run asked for it

**What the follow-on narration reads is chosen by the PASS, not by the caller.**
The queue gives a chained step its parent's produced artifact and nothing else
(`queue-engine.resolveInput`: `sourceRef` is consulted only for a step with no
parent), and `tts-conversion` reads `ctx.input.path` with no config fallback. So
a caller "setting" `epubPath` on a follow-on job is inert — measured. The pass
therefore re-cuts the family's narration copy from the book it has just rewritten
(`ensureNarrationEpub`, which re-cuts exactly when `fromEpubSha256` no longer
matches) and names it in `PassJobResult.narrationInputPath`;
`queue-steps/pass.ts` produces that as the step's artifact. A re-cut that fails
is **said** — the pass still succeeded, the book is written and recorded — and
the chained step then reads the book itself, which `prepareNarrationInput` cuts
on its way in; what is lost is the user's own strikes, and the note says so.

The CLI's unattended chains do the same thing without asking, because they have
nobody to ask.

---

## What the pass will not touch

**A digit run glued to letters that OPEN a token** — `105mm`, `9mm`, `20km`,
`5kg`, `12V`, `8GB`, `6ft`, `4a`. That shape is a measurement or a designation
and its letters are a unit; this rule has no table of units, so it goes to the
model. The letter-prefix and hyphenated forms are exactly what the rule is for
and are untouched: `B-17`, `COVID-19`, `R2D2`, `F8F`, `C18`, `V-2`, `MP3`,
`7-Eleven`, `24-hour`, `30-year-old`.

**A digit run whose suffix another rule owns** — `mid-1920s`, `pre-1914`,
`mid-19th`, and the `<br/>`-fused forms `3rdday`, `21stcentury`, `90sera`. Those
are the decade, year and ordinal rules' shapes, and reading them here produced
`mid-one thousand nine hundred twenty s`.

**Preformatted text.** A `<pre>`, anything inside or containing one, and anything
whose inline style declares `white-space: pre` / `pre-wrap` / `pre-line` /
`break-spaces` is refused by BOTH stages and counted
(`NarrationNumberTarget.preformatted`). Everywhere else a run of spaces is a
layout artifact; in a code listing, an ASCII table or a verse laid out by hand it
is the content, and the pass rewrites the working copy — so collapsing it
destroys the user's book with only the archive to recover from.

**Footnote and reference markers.** The render door strips them from the
narration copy deterministically (`stripSupMarkers`). The prompt says so, and
does not ask the model for them.

**A span that crosses a text node.** Refused and recorded, never flattened.

Every refusal is counted in the receipt AND in the stamp
(`punctuationRefused`), so a book with three hundred unreachable ellipses is not
byte-indistinguishable from a clean one, and the "nothing to do" line on a second
run says how many spans it could not reach rather than claiming the book is
already canonical.

## The stamp's own version

`stampVersion` (currently **2**) versions the SHAPE of the stamp, apart from the
rules it records. It went 1 → 2 when `punctuationRefused` became required and the
validator learned that a reading must be a reading: neither is a change to the
punctuation spec, so bumping `PUNCTUATION_SPEC_VERSION` would have told the
training side a rule moved when none did, and `NORMALIZER_VERSION` moved on its
own account (`n5` → `n6`, the scripture ruling of 2026-09-05). What changed here
is what a stamp *means*, so books
stamped by an earlier build read stale **by rule** rather than by accident.

## Known limitation, not fixed here

`<br/>` fuses the words either side of it in the string the walk produces
(`<p>a<br/>b</p>` reads `"ab"`), so a heading split across a line break reaches
the rules and the model as `Chapter 1Dawn`. Pre-existing, and NOT fixed in this
pass: `getUnitTextContent` and `textNodeSegments` are one contract — the segments
are text-node lengths that must sum to `text.length` — and every offset in this
pass, in `applyNumberRules` and in `applyTextNodeRewrites` is expressed against
it. Inserting a synthetic space for a `<br/>` would make the segments describe a
string that is not the DOM's, which is precisely the class of bug the two-write
staging exists to make impossible. It belongs in the extractor, with its own
tests, not here.

**A THREE-PART CLOCK LEAVES A RAW COLON.** `He ran the marathon in 3:42:15.`
comes out `three forty two:15` — the book-less rule matches the first two parts
and its trailing lookahead (`(?![A-Za-z\d])`) is satisfied by the `:` that
follows, so half the time is read and the rest is left with a colon standing next
to a digit. That is the exact wreckage shape the Ask-2b comment says must never
happen, and it reaches the model, which correctly declines a fragment it cannot
parse. **Pre-existing — it is on `main` too** (found by the adversarial review of
2026-09-05 while probing this branch) and it is not this branch's to fix: the
book-less rule is untouched here on purpose, because every change to it is a
change to how `main` reads text that has nothing to do with scripture.

## Version bump policy — THIS repository's to obey

**Changing `src/clean/tts-punctuation.ts`, `src/clean/tts-number-rules.ts`,
`src/clean/tts-number-normalizer.ts`, `src/clean/tts-spoken-forms.ts` or
either file in `src/clean/prompts/` is a change to the TRAINING CORPORA's text
transform.** Owen moved the ownership here on 2026-09-05; the paragraphs below
were written when it lived one repository over and every one of them still
holds, with the paths re-pointed.

The orpheus-finetune side vendors this transform byte-for-byte into
`pipeline/normalization/vendor/` and drift-checks it on every training build
(`check_vendored.py`, `PROVENANCE.json`). A silent change there means a fine-tune
is handed text that is not the text it learned. **It vendors from `src/clean/`
now**, pinned to the commit named at the head of this document.

So, on any such change:

1. bump `NORMALIZER_VERSION` (`src/clean/tts-number-normalizer.ts`) and say in
   its comment what changed — a stale `.nN.` copy on disk is a claim about a pass
   that no longer runs, and the cache keys on it. **The `clean-text` key holds it
   too**, so a bump correctly re-buys every block of every book;
2. bump `PUNCTUATION_SPEC_VERSION` (`src/clean/tts-punctuation.ts`) when a
   punctuation rule changes;
3. **tell the orpheus-finetune side to re-vendor** from the new commit, and
   mirror any new fixture case into `pipeline/normalization/fixtures/cases.json`;
4. **tell BookForge**, which still carries its own copy of these modules for its
   in-app pass. Two copies of a load-bearing definition is the failure
   ARCHITECTURE §2 exists to design out, and this move only half-closes it: the
   engine owns the versions, and BookForge's copy has to follow until it calls
   `foundry clean-text` instead of running its own;
5. re-run the keepers and the training side's harness:

```bash
tsc --noEmit && bun test
node C:/Users/tellt/Projects/orpheus-finetune/pipeline/normalization/run_fixtures.js \
     --mode bookforge --bookforge <this checkout>
node C:/Users/tellt/Projects/orpheus-finetune/pipeline/normalization/run_fixtures.js \
     --compare --bookforge <this checkout>
```

Bumping the version invalidates every cached copy and makes every stamped book
read **stale** — which is correct: those books were cleaned by rules this build no
longer uses.

---

## What the training side should vendor

`pipeline/normalization/vendor/` currently holds

```
electron/ai-cleanup-prepass.js
electron/number-expansion.js
electron/tts-number-normalizer.js
electron/tts-number-rules.js
prompts/tts-number-normalize.txt
shared/text/line-join.js
shared/text/sup-markers.js
```

**Add TWO files:**

```
electron/tts-punctuation.js
electron/tts-spoken-forms.js
```

`tts-spoken-forms.js` is what `tts-number-normalizer.js` now requires, and it is
a **leaf**: it imports nothing from this repo, so it drags nothing behind it. It
does read one DATA file at first use, through `fs` and `path` alone —

```
electron/data/english-words.json
```

— which decides whether a run of capitals is a word the author shouted or an
initialism. It is a positive list, compiled for this repository (no third-party
licence applies), and a word it does not carry is refused the lower-cased reading
and offered the spaced-letters one, which is the safe direction. Vendor it beside
the module. The number words a roman numeral may be read as are passed
*in* by the caller, which already has them — one definition, no second copy.

It is a straight port of `pipeline/normalization/punctuation.js` — same exported
names (`PUNCTUATION_SPEC_VERSION`, `CANONICAL_ELLIPSIS`, `CANONICAL_DASH`,
`PUNCTUATION_RULES`, `canonicalizePunctuation`, `canonicalizePunctuationText`,
re-exported `normalizeQuotes`), same rules in the same order — and its compiled
form requires **only** `./ai-cleanup-prepass.js`, which is already vendored, so it
loads under plain node with no Electron stub. Once vendored, `punctuation.js` on
that side can become a re-export of it, and the two halves of the shared
definition are both BookForge's.

### Shared fixtures — and what the training side owes

`tools/fixtures/text-normalization-cases.json` began as a copy of their
`fixtures/cases.json`, case ids kept. **The two files have diverged**: 132 cases
here against 53 there, and **until their file is updated the corpora and the
renders normalize differently** — by design, from rulings they have not mirrored,
not by accident.

| what | how many | which |
|---|---|---|
| expectations to **change** | 3 | `leave-page-cite`, `leave-doc-code`, `leave-glued` |
| `known_defect` now **fixed** | 1 | `leave-archive` |
| cases moved `rules` → `model` | 9 | every `scripture-*` case, from the n6 ruling: the deterministic pass no longer reads a reference, so `want` is what the MODEL must produce |
| `known_defect` now **deferred to the model** | 2 | `scripture-ref-abbrev-numbered-book`, `scripture-ref-abbrev-plain-book` — their two 2026-09-05 cases, ids kept, at stage `model` |
| cases to **add** | 64 | every one marked `added_in` with its ruling or review row |

Those four changed expectations are exactly the four differences
`run_fixtures.js --compare` reports. The 56 additions cover the cross-chapter
scripture range, the archive sigil's opposite direction, the page and glued
readings, the unit suffixes, the `<br/>`-fused ordinals, and the
year/decade/ordinal shapes the glued rule must leave to the model.

A sample of the earliest of them:

| id | why |
|---|---|
| `leave-archive` | their `known_defect` — **fixed** in n5 (`isArchiveSigil`) |
| `scripture-cross-chapter` | Ask 2b: `(Col. 3:19-4:1 and parallels)` |
| `scripture-cross-chapter-endash` | the same range with an en dash |
| `scripture-verse-range-plain` | the other direction: a verse range is unchanged |
| `scripture-lone-ref` | the other direction: a lone reference is unchanged |
| `archive-sigil-not-prose` | the other direction: `The 11 men` is still read |

---

## Owen's 2026-09-04 revision of the leave-as-printed list

Two shapes moved OFF it, into rules of their own:

| printed | read | rule |
|---|---|---|
| `p. 23` | page twenty three | `page` |
| `pp. 65-71` | pages sixty five to seventy one | `page` |
| `COVID-19` | COVID-nineteen | `glued` |
| `B-17` | B-seventeen | `glued` |
| `I-95` | I-ninety five | `glued` |
| `7-Eleven` | seven-Eleven | `glued` |
| `R2D2` | R two D two | `glued` |
| `1940s-era` | nineteen forties-era | `decade` (it already owned it) |

Owen: *"COVID-nineteen is actually correct, that's how it's pronounced in real
life."*

**The cardinals are unhyphenated**, because that is what `cardinalWords` produces
and what the fine-tunes were trained on — `tts-number-rules.ts`'s own doctrine
note says the hyphenating `integerToWords` serves the OCR pass instead. So this
produces `I-ninety five` and `page twenty three` where the handoff's prose wrote
`I-ninety-five` and `twenty-three`: same reading, the corpus's own spelling. The
range word for pages is **"to"**, not the verse range's "through". The letters
are the book's and are never re-cased — `7-Eleven` keeps its capital E.

`CITATION_LEAD` lost `p.`/`pp.` and kept `vol. no. ibid. cf. fol.`. The guard is
shared with the model validator, so removing the page lead is what lets the model
read one too. The `glued` rule runs LAST of all the rules and refuses by shape,
not by list: a digit run over four digits, more than three runs, a leading zero,
a `/` on either side, or a `.` followed by a digit. `X-007`, `Z-12345`,
`A1B2C3D4`, `v1.2`, `298/38`, `Document II 9/34` and `AfW HH R 231191` are all
still printed as printed.

## Ask 2c — a comma is a separator inside one number

`NUMBER_DROPPED` counted runs of digits, and a comma splits one number into
several, so `"5,000 copies"` → *"five thousand copies"* was refused for having
two number words where three were demanded. Measured by the training side on
tr_dn3 (NORMALIZATION_SPEC.md §F4): it also refused `18,000-strong` and
`20-30,000`, and both rows still print their digits in the served corpus.
`digitRuns` now reads a comma-grouped number as ONE number. The floor it was
protecting still fires: `20:6` → *"twenty"* and `1914-1918` → *"nineteen
fourteen"* are both still refused.

The keepers sit in **two** suites on purpose. `tools/test-text-normalization.js`
judges the shared definition; `tools/test-tts-number-normalizer.js` owns the
disposition itself, so a regression in `digitRuns` has to fail the suite that
owns `NUMBER_DROPPED` and not only the fixture one. The comma-grouped cases are
in both, in both directions — `5,000` → *"five"* and `20-30,000` → *"twenty
thousand"* are still `NUMBER_DROPPED`, and `5,000 copies in 12 crates` →
*"five thousand copies in crates"* proves a comma-grouped number standing beside
a **bare** one is still two numbers.

Two notes the record needs. `18,000-strong` may be read *"eighteen
thousand-strong"* or *"eighteen thousand strong"* — the prompt lets a
replacement carry a hyphen and the compound's own hyphen is the book's (as in
`1940s-era` → *"nineteen forties-era"*), so the validator accepts both and the
choice is the model's. And a find whose second number is dropped **along with
its prose words** — `5,000 copies and 12 men` → *"five thousand copies"* — is
refused one check earlier, as `WORDS_DROPPED`: `keepsEveryWord` runs ahead of
the number floor. Refused either way; the record just names the right reason.

## The two rule fixes in n5

**Ask 2 — an archive sigil in front of a bare integer is citation apparatus.**
`HSG 11 Js. Sond. 298/38` read the `11`. `isArchiveSigil` admits a 2–4 letter
token that is entirely uppercase (`HSG`, `HH`) or carries a capital after its
first character (`GnH`, `AfW`), and only in front of a **bare integer**, so
`The 11 men` is still read.

The other half of that ask — an *abbreviation after* the span (`Js.`, `Sond.`) —
is **deliberately not adopted**. It would also match `the 11 U.S. soldiers`,
`3 Dr. Smiths`, and every other abbreviation prose prints after a number; and this
guard is shared with the model validator (`CITATION_CODE`), so a false positive
means the digits reach the narrator with nothing downstream able to convert them.
The sigil is a shape; "a period on the next word" is not.

**Ask 2b — a chapter-crossing scripture range orphaned its colon.**
`SCRIPTURE_REF` modelled the range's second number as a *verse* only, so
`(Col. 3:19-4:1)` emitted `…through four` and left `:1` standing — a *malformed*
number, worse than an unconverted one, and invisible to every downstream guard
(`NUMBER_DROPPED` watches the model, not the rules; `stillHasDigits` sent the
wreckage to the model, which correctly declined a fragment it could not parse).
The range now admits its own chapter: *"three nineteen through four one"*. The
keeper scans a generated matrix of every reference shape these rules claim and
asserts no digit-adjacent colon survives.

## Scripture: the rules DETECT it, the model READS it (n6)

### The ruling

Owen, 2026-09-05, after a Higgs A/B render of the deathstalker book narrated
`(1 Pet. 3:7)` as *"one pet three seven"*:

> **"I don't want to do it deterministically. An AI takes over. There are a
> billion ways Bible verses are abbreviated."**

Until n5 stage 2 *read* a reference from a table of book abbreviations
(`2 Cor. 10:4` → *"Second Corinthians ten four"*). A table is the wrong
instrument for an open set: `Pet.`, `1 Pt.`, `I Pet.`, `1 P.` and a hundred
house styles are one book, and a table that is 95% complete does not read the
last 5% *as printed* — it hands them to the generic integer rule, which narrates
"one pet three seven". So the table is gone from the shipped path.

### What stage 2 does now

`scriptureSpans(text)` recognizes a reference and returns it as a span.
`applyNumberRules` **closes** every such span before any rule runs, exactly as it
closes a clock range: nothing is rewritten inside one. The digits are therefore
still there when the model is asked, which is the only reason the model can read
it, and the block is never `RULES_ONLY`.

### The evidence test — three shapes, and no abbreviation table

Detection **consults no table of abbreviations**. A reference is claimed when the
token standing in front of the `c:v` carries one of exactly three kinds of
evidence:

| # | evidence | example |
|---|---|---|
| (a) | an **abbreviation** — the token carries its own period | `Pet. 3:7`, `Ps. 63:6`, `Zeph. 3:17` |
| (b) | a **volume number** in front of it — arabic `1-3`, roman `I/II/III`, or the ordinal forms | `1 John 3:16`, `II Cor. 5:17`, `1st John 1:9` |
| (c) | the token is one of the **73 full canonical book names** | `Genesis 3:15`, `Revelation 21:4`, `Qoheleth 3:1` |
| (d) | the token is **two or three letters** with no period at all | `Ps 23:1`, `Jn 3:16`, `Rev 21:4`, `Mt 5:3` |

and the rest of the reference comes with it:

| shape | detected | example |
|---|---|---|
| ranges, verse letters, `ff.`, chapter-crossing | yes, inside the same span | `Jer. 44:17-19`, `Gen. 1:1a-2b`, `Matt. 5:16ff.`, `Col. 3:19-4:1` |
| a LIST of references, bare verses included | yes, as **one** span, bounded (below) | `Lev. 19:31; 20:6`, `Genesis 6:11, 13 and 7:1` |
| chapter-only **with a volume number** | yes | `1 Pet. 3`, `2 Chron. 7` |
| chapter-only **without** one | **no** — see below | `Gen. 3` |
| a numbered book with no reference | yes (nine full names, John excluded) | `2 Corinthians`, `II Corinthians` |
| a book-LESS `c:v` | **no** — it is not known to be scripture | `3:16`, `5:45` |

**(d) is WEAK evidence, admitted on purpose, and it is cheap because of the claim
test.** A dotless `Ps 23:1` is the same shape as `Map 2:1` and `Bus 47:15`, so on
its own it proves nothing. It is admitted because (a)–(c) alone left every
dotless abbreviation *unreadable*: the model's `Psalm twenty three, verse one` was
refused `WORDS_DROPPED` — that relaxation is scoped to detected spans — and the
digits reached the narrator. Losing `Ps`, `Jn`, `Rev` and `Mt` is a regression
from this app's own behaviour in exactly the domain the branch exists for.

What pays for it is the **claim test** below, the same thing that makes a detected
`Sec. 3:7` affordable: the chapter-and-verse pause is asked only of a reading that
names a canonical book or an ordinal volume. So one detection serves both —
`Jn 3:16` → *"John three, verse sixteen"* is accepted as a reference, and
`Map 2:1` → *"Map two one"*, `Bus 47:15` → *"Bus forty seven fifteen"* are accepted
as the prose they are. The model decides which it is looking at, which is the
arrangement Owen ruled for.

**What (d) costs, stated rather than discovered later:** a 2–3 letter token in
front of a `c:v` is now *protected*, so the book-less rule no longer reads it and
its reading depends on the model where it used to be deterministic. The surface is
small — exactly two or three letters, no period, verse of ten or more
(`Bus 47:15`). **Four letters and up stay out**: `Then 9:45`, `Score 21:19`,
`Case 5:12`, `Odds 5:2`, `Route 66:1` and every longer word keep `main`'s
deterministic reading. Months are refused whether or not they print the period
(`Jan 3:7`), and so is the other grammatical slot — a short word that *points* at
a number instead of naming a thing (`See 20:6`, `In 20:16`). That exclusion list
is closed in a way the old deny-list of capitalised nouns never was, and the
reason is the length: the English function words of two or three letters are a
fixed, countable set; the capitalised nouns that can precede a colon-number are
not.

**The reading of Owen's ruling that (c) and (d) rest on — he may veto either.** His
objection was to enumerating *abbreviations*: "there are a billion ways Bible
verses are abbreviated", and that set really is open. The set of full canonical
names is neither open nor invented — 73 fixed words, closed since the canon was —
and it is used as a **shape**, never as a reading. If Owen reads the ruling as
forbidding this list too, delete `CANONICAL_BOOK_NAMES`; shapes (a) and (b) still
stand, and the cost is that a fully spelled book with no volume number
(`Genesis 3:15`) stops being protected. (d) asks the token's *length*, not its
identity, so it is not a table either — but it is the loosest of the four and the
one to remove first if he wants the detector tighter; deleting it restores
(a)–(c) exactly and costs the dotless abbreviations again.

**What is deliberately NOT detected.** A **single-letter** abbreviation
(`S. of S. 2:1`) — the token pattern needs two letters, because a one-letter
abbreviation is also every initial in a name. And a **longer dotless word**:
`Widescreen 16:9`, `Score 21:19`, `Wednesday 9:45`, `Then 9:45`. Four letters and
up with no period is the shape of every capitalised noun in English, and (d) stops
short of it deliberately.

**The list tail is bounded.** A tail carrying its own `c:v` is a reference
whatever its size; a **bare** tail number is admitted only when it could be a
verse — no verse is above Psalm 119:176 — and never when it is the head of a
comma-grouped number. Without those bounds `Quoting Rom. 8:28, 250 members left`
swallowed the 250 and `Isa. 5:20 and 1,000 copies` swallowed the grouped number,
and a swallowed number is one no rule can read any more. What the bounds do *not*
settle is `Gen. 1:1, 12 of them agreed`: 12 is a possible verse and nothing in the
shape says otherwise, so the model recovers it.

**A false positive is NOT free — measured, and it is why the evidence test
exists.** The first cut of this detector fired on any capitalised token in front
of a `c:v`, on the theory that "a span detected in error is merely sent to the
model". The adversarial review of 2026-09-05 falsified it: inside a detected span
the validator demands a chapter-and-verse pause, so the model's *correct* reading
of `Widescreen 16:9` → *"sixteen nine"* was refused and the digits reached the
narrator — and the book-less rule, which read `Score 21:19` correctly on `main`,
never got the chance. Detection took work away from a rule that was right.

Two things answer it, and both are in place: detection now requires **strong
evidence** (the three shapes above), and the pause is demanded only of a reading
that is *claiming* to be a reference (below). A miss is now what the design
originally claimed a false positive was: cheap.

**Why detection may use a list where a reading may not.** A missing entry in a
*reading* table produces a wrong reading, out loud, with nothing downstream to
catch it. A missing entry in the canonical-name list only means one span is not
protected — it is treated exactly as it was before this branch.

### The chapter-only decision

`Gen. 3` is **not** detected, and that is a decision, not an oversight. Telling
`Gen. 3` from `Fig. 3` requires knowing that Genesis is a book and a figure is
not, which is the table the ruling removed. A **leading volume number** is
evidence that survives without one — English prints `1 Pet. 3` and never
`1 Fig. 3` — so the numbered form is detected and the bare form is not. A bare
`Gen. 3` reaches the model with its digit intact and is read there.

### The must-NOT list

Owen's, 2026-09-05, one keeper each in `tools/test-tts-number-rules.js`:

| must not fire | why | what happens instead |
|---|---|---|
| `Jan. 3:7`, `Sept. 4:9` | a month is not a book | left as printed |
| `Gen. Patton` | no reference behind it | left as printed |
| `vs. 3:7`, `ex. 3:7` | lowercase — a book name is capitalized | left as printed |
| `1 Pet 3` (no period) | without the period the token is just a word | the integer rule reads the digits, as before n6 |
| `Chapter 3:7`, `Room 3:15`, `Act 3:2`, `Table 4:2` | an ordinary noun in front of a colon-number | the book-less rule reads it, or nothing does |
| `Verses 28:7-8`, `Chapters 3:1-4:2` | the plural of an ordinary noun | as above |
| `See 20:6`, `Read 20:6`, `Compare 20:16`, `In 20:16` | the sentence capitalized an ordinary word | as above |
| `at 3:16 John left` | a book name AFTER the digits is no evidence | the book-less reading, *"three sixteen"*, with no scripture pause |
| `Widescreen 16:9`, `Lakers 3:1`, `Route 66:1`, `Ratios 3:7` | four letters or more, no period, no volume number, no canonical name | left as printed, as on `main` |
| `Score 21:19`, `Flight 12:30`, `Windows 3:11`, `Docket 5:12`, `Recording 12:34` | same | the **book-less** reading — *"twenty one nineteen"* — which is what `main` read |
| `Map 2:1`, `Bus 47:15`, `BWV 3:7`, `Act 3:2` | three letters — evidence **(d) claims these** | detected, and the model reads them as the prose they are (`Map two one`); the claim test is what lets it |
| `Wednesday 9:45`, `Meeting Tuesday 14:30`, `Then 9:45` | a weekday or an adverb the sentence capitalised | the book-less reading, as on `main` |
| `2:00 p.m.`, `Luke 2:30 p.m.` | a meridiem says it was never a reference | the clock rule |
| `5:30-6:00` | a clock range is not a verse range | left whole |

**There is no deny-list of ordinary words any more, and there never could have
been one.** The first cut tried: months, nouns, their plurals, the
sentence-initial words. The review walked straight through it with `Lakers 3:1`,
`Widescreen 16:9`, `Flight 12:30`, `Route 66:1`, `Docket 5:12`, `BWV 3:7`,
`Recording 12:34`, every weekday (`Wednesday 9:45`), a sentence-initial `Then`,
and the short forms of words whose long forms were listed (`Ch.`, `Sec.`,
`Art.`, `Pt.`). Every case above is refused by the **evidence test** instead, and
each is a keeper carrying `main`'s own reading as its expected output.

**Months are the one word-level exception that remains**, because they have shape
(a): `Jan. 3:7` and `Sept. 4:9` are abbreviations carrying their periods, and
Owen's must-NOT list names them. Every other non-book abbreviation (`Sec.`,
`Ch.`, `Mr.`) *is* detected, and is read by the model as what it actually is.

The one shape kept from n5 is the **book-less `c:v`** (rule `verse-or-clock`,
renamed from `scripture`): with no book named, the pass does not know what the
digits are, so it reads them only where the verse and the clock readings
coincide — a verse of ten or more — and leaves the rest to the model. It is
deliberately **not** given the scripture pause.

### The reading — measured, not chosen

Whisper over the 23 scripture references carrying numbers in the deathstalker
corpus (`E:\training\deathstalker\build\ds_ad4s\scripture_spoken_forms_report.txt`,
2026-09-05) found:

* **22 of 23** say **"verse" / "verses"**; **1** is bare; **0** say "chapter".
* **"Psalm" singular** before a number, **4 times out of 4**.

So the default the prompt asks for is **`<Book> <chapter>, verse <n>`** —
*"First Peter three, verse seven"* — with ranges *"verses N to M"*
(*"Matthew twelve, verses thirty-four to thirty-six"*) and lists
*"verse N, M, and P"* (*"Psalm one hundred nineteen, verse ninety-seven, one
hundred one, and one hundred two"*). A leading book number is an **ordinal**
("First", "Second", "Third"), and the abbreviation is expanded to the book's full
name — and a **roman** volume numeral is the same number as an arabic one, so
`II Cor. 5:17` reads *"Second Corinthians five, verse seventeen"*. **The bare
comma form is accepted** (*"First John one, nine"* — the one bare clip), and
**"chapter" is refused**.

The prompt is the artifact the narrator hears, so which form it *asks for* is
pinned by its own keeper (`tools/test-prompt-examples.js`) and not only by which
forms the validator accepts: every chapter-and-verse reading the prompt states in
prose must carry "verse" and must not carry "chapter". Without that, a prompt
asking for the 1-of-23 minority form passes every other check on this branch —
including the `--scripture` probe, which scores `accept.some(...)` and holds the
comma form in every list.

### The validators — exactly one invariant relaxed

For an edit whose span overlaps a **detected reference**, and nowhere else:

* **Relaxed:** `keepsEveryWord` becomes `scriptureWordsSurvive` — the one-token
  law the text classes already live under. At most one prose word of the find may
  be missing, and **the word it was short for** must have arrived in its place:
  longer, and carrying the token's letters in order, which is what an
  abbreviation is. That admits every contraction a publisher prints (`Jas.` →
  James, `Phlm.` → Philemon, `Mk.` → Mark, `Pss.` → Psalms) and the ordinary words
  that are not scripture at all (`Sec.` → Section, `Ch.` → Chapter), and refuses
  "chapter" or "verse" standing in for `Pet.`. A **canonical book name** also
  counts, for the abbreviation whose reading is the book's other name (`Cant.` →
  Song of Songs). Without any of this, *"Pet." → "Peter"* is `WORDS_DROPPED`,
  which is what threw away 57 correct expansions on the 2026-09-02 run.
  A **roman volume numeral** is stripped from the words that must survive, for
  the same reason an arabic one is: it is a number, not a name. Without that,
  `II Cor. 5:17` cost two words and *every* reading of it was refused.
* **Relaxed:** the **citation guard** does not claim a detected reference.
  `sitsInCitation` reads a leading roman numeral as apparatus (`Document II
  9/34`), which is right everywhere except where a roman numeral is a volume:
  `II Cor. 5:17` was refused `CITATION_CODE` and narrated as digits. Outside a
  detected span the guard is untouched.
* **Added:** `SCRIPTURE_UNREAD`, last of the number invariants so every earlier
  one keeps its own name. It refuses a reference that came back half-read:
  * an **abbreviation still standing** — any token ending in a period except the
    last;
  * the **chapter/verse boundary gone** — fewer pauses (a comma, or the word
    "verse") than the find has printed `c:v` references;
  * the word **"chapter"**.

  The last two are asked **only of a reading that is claiming to be a
  reference** — one naming a canonical book or an ordinal volume. Detection
  admits any abbreviation with its period, and plenty of those are not books:
  `Sec. 3:7` of a statute is a detected span whose correct reading, *"Section
  three seven"*, has no pause in it and must pass. Demanding the pause of every
  reading of every detected span is what made a false positive expensive.

  (A **remaining digit** is the fourth thing a half-read reference can do, and
  `DIGIT_IN_REPLACE` has already refused it, for every class.)

  The measured residue this exists for: the deathstalker corpus served
  **"(Ps. sixty three six)"** — digits spelled out, the abbreviation intact and
  the boundary simply gone. Every other invariant passed it.

Nothing else is loosened. The same edit outside a detected span is judged exactly
as it was in n5. Every protected reference is also **named in the receipt**, as a
`SCRIPTURE_PROTECTED` line and a `scriptureReferences` count on the record: a
block that still holds digits after the rules ran has to be able to say why, and
a reference the model declines would otherwise leave a block that was asked
about, changed nothing, and explained nothing.

### Where the narration cuts go — an e2a-era path, owed to Phase 6

`narrationCutsDir()` is `path.join(getDefaultE2aTmpPath(), 'narration-cuts')`,
and `getDefaultE2aTmpPath()` falls back to `<e2a checkout>/tmp` when
`e2aScratchDir` is unset. Only `main.ts` ever sets it (`applyE2aScratchDir`,
Settings `ttsScratchPath`, else `<library>/tmp`) — so **anything without a main
process writes app state into a third-party checkout.**

Measured, 2026-09-05: `tools/test-narration-text-two-family.js` had been writing
its content-addressed copies into the real
`Projects\ebook2audiobook\tmp\narration-cuts\` for at least a day, and on a
second run *reused* them — including a punctuation copy written by a **different
branch**, because that key is `s1` and does not move when the number rules do. A
green keeper could therefore be a replay of another branch's output. The keeper
now calls `setE2aScratchDir` on its own temp root, as
`tools/test-cli-narration-prep.js` already did, asserts the model was actually
called, and deletes the root afterwards.

**Owed to Phase 6:** narration cuts have nothing to do with e2a. The fallback
should be library-derived (`<library>/tmp`, which is what the app sets anyway) or
a loud refusal. A silent fallback into someone else's checkout is precisely the
class of thing that hid this.

### Where the book table went

`tools/fixtures/scripture-readings.json` — 102 cases: the 66 books in the
abbreviations a publisher prints, the deuterocanon, every shape, and the readings
measured off the corpus. It is used twice:

* **offline**, in `tools/test-tts-number-rules.js`: every reference must be
  DETECTED, whole, and left as printed. A book the detector misses is a book the
  model is never asked about.
* **with a model**, Ollama-gated and never in the keeper sweep:
  `node tools/test-tts-number-normalizer.js --scripture <model>` reads each one
  through the real prompt and reports how many readings match. Without the flag
  it does not run and nothing pretends it did.

`accept` is a **list** per case, because the narrator is not uniform: the comma
form, the "verse" form, and the default that carries both are all correct.

## What the 2026-09-04 live run settled

The first run against a real model (`qwen3.8:27b-24g`, Kershaw, 68 blocks, 120 s,
36 edits, 0 parse failures) is the evidence behind the three rulings below.

### All-caps initialisms are LEFT AS PRINTED

The model left every all-caps initialism in the book alone — `SA`, `SS` and the
rest came back exactly as printed, not as "ess ay" or "Sturmabteilung". **That is
not a defect and it is not to be "fixed".** The Orpheus training corpora carry
initialisms as printed, so leaving them is the reading that matches the
fine-tunes; a pass that expanded them would be feeding the voice a shape it was
never trained on.

The rule of record: **an all-caps initialism stays as printed unless the model
judges a spoken expansion necessary.** The judgement is the model's, per block,
and the validator's job is only to keep whatever it decides to a single token
(`capsReadingRefusal`). Nothing deterministic touches these.

### A day-first date with no year reads the American spoken way

`DATE_DAY_FIRST` required a year, so `"…his last detailed report, which was on 4
September."` fell through to the bare-integer rule and shipped as **"on four
September"**. The model's own correct repair — "September fourth" — was then
refused, because a mangled date is not one of the classes a reading may be about.

`DATE_DAY_FIRST_NO_YEAR` closes it: the with-year rule minus the year, both
orders (`4 September` and `September 4`). Two guards keep it honest — a lookahead
for a following year, so `4 September 1939` stays the with-year rule's; and
`DATE_LEAD_BLOCK`, so `Chapter 4 September` and `p. 4 September` keep the digit a
numbered thing.

The month abbreviation's period is the subtle half. `"4 Sept. and later"` is an
abbreviation mid-sentence and reads *"September fourth and later"*; `"4 Sept. The
next day"` is both an abbreviation and a sentence end and reads *"September
fourth. The next day"*. So the period is swallowed only when the month is
**abbreviated**, and written back when what follows could start a sentence. After
a full month name the period is never touched.

### A citation lead and an abbreviated page range are apparatus

The run read `iii. 1281-2` as **"one thousand two hundred eighty-one to two"** —
a volume, a page and a range misread at once. Two shapes now sit in
`sitsInCitation`, which stops the deterministic rules and the model alike:

- **A roman numeral and a period in front of a number** (`iii. 1281-2`, `II. 45`).
  The numeral grammar is **strict** — thousands, hundreds, tens, units — because a
  loose `[ivxlcdm]+` also spells ordinary English: `he did. 45 men`, `it was mild.
  12 degrees` and `the civil. 90 percent` all matched the loose form and would
  have had their numbers refused as apparatus.
- **An abbreviated page range behind a page lead** (`pp. 51-2`, `fol. 128-9`),
  where the second number is shorter than the first because it drops the shared
  leading digits. The page rule itself used to read `pp. 51-2` as *"pages fifty
  one to two"*; it now leaves the span whole.

**The page lead is required, and that is a deliberate narrowing of the ruling.**
The wider form — any abbreviated range — contradicts the shipped number prompt,
which teaches `"112–14" is "one hundred twelve to one hundred fourteen"`, and
`test-prompt-examples` refused it on exactly that line. So a **prose** range keeps
the prompt's reading, which is the correct one, and only an **apparatus** range is
left as printed. A year range (`1935-36`) abbreviates identically and reads
differently again, so it is never claimed here — that judgement is the model's,
and the live run measured it making it correctly.

---
---

## Files — in THIS repository, which owns them

| file | what |
|---|---|
| `src/clean/tts-punctuation.ts` | stage 1, the shared spec (`PUNCTUATION_SPEC_VERSION`) |
| `src/clean/tts-number-rules.ts` | stage 2 — the rules, and `scriptureSpans` (detect-and-protect) |
| `src/clean/tts-number-normalizer.ts` | stage 3, the validators and the record (`NORMALIZER_VERSION`) |
| `src/clean/tts-spoken-forms.ts` | what a token may be read AS — the curated tables |
| `src/clean/data/english-words.json` | the word test behind the emphasis reading |
| `src/clean/ai-cleanup-prepass.ts`, `number-expansion.ts`, `line-join.ts` | the three leaves the four above import |
| `src/clean/prompts/tts-number-normalize.txt` | the number prompt — what the training side vendors |
| `src/clean/prompts/tts-narration-text.txt` | the wider instruction, appended to it |
| `src/clean/prompt.ts` | the two, joined the one way, embedded in the binary |
| `src/clean/segments.ts` | the marker rule — what a segment IS on a book file row |
| `src/clean/targets.ts` | the two shapes the pass is typed against |
| `src/clean/punctuate.ts` | stage 1 as spans, and the splice that proves each one landed |
| `src/clean/runner.ts` | the model, on the engine's own Ollama client |
| `src/clean/stamp.ts` | the stamp: the name, the shape, the versions, the reader |
| `src/clean/run.ts` | **the pass** — the plan, the key, the rows, the receipt |
| `src/commands.ts` | the `clean-text` command and `--narration-stamp` |
| `src/epub/meta.ts` | `insertPackageMeta` — how a `<meta>` gets into an OPF |
| `test/clean/fixtures/text-normalization-cases.json` | the shared definition's 132 cases |
| `test/clean/fixtures/scripture-readings.json` | the books, the shapes and the measured readings |
| `test/clean/*.test.ts` | the ported keepers |

### And where each of them came from

| bookforge (read-only, `0f962d5f`) | what |
|---|---|
| `electron/tts-punctuation.ts` | stage 1, the shared spec (`s1`) |
| `electron/tts-number-rules.ts` | stage 2 — the rules, and `scriptureSpans` (detect-and-protect) |
| `electron/tts-number-normalizer.ts` | stage 3 + the record (`NORMALIZER_VERSION`) |
| `electron/narration-text-pass.ts` | the pass, the receipt, `narrationTextGate` |
| `electron/narration-text-readiness.ts` | the ledger-side gate |
| `electron/epub-processor.ts` | `readNarrationTextStamp` / `writeNarrationTextStamp` |
| `electron/processing-passes.ts` | `runNarrationTextPass` — the ledger pass |
| `electron/queue-steps/pass.ts` | `narrationTextStep` |
| `cli/narration-text-step.js`, `cli/narration-text.js` | the CLI door and command |
| `tools/test-text-normalization.js` | the shared fixtures + both fixes |
| `tools/fixtures/scripture-readings.json` | the 66 books, the deuterocanon and the measured readings — evidence for the MODEL, never a rule |
| `tools/test-narration-text-pass.js` | the pass over a real book, no GPU |
| `tools/test-narration-text-readiness.js` | the ledger gate |
| `tools/test-narration-text-two-family.js` | a TWO-CHAIN project, end to end, no GPU |
| `electron/tts-spoken-forms.ts` | what a token may be read AS — the curated tables (a LEAF: imports nothing from this repo) |
| `electron/data/english-words.json` | the word test behind the emphasis reading |
| `tools/test-prompt-examples.js` | every prompt example, through the validator that judges it |
| `electron/prompts/tts-narration-text.txt` | the wider instruction, appended to the number prompt |
| `shared/processing/book-passes.ts` etc. | the pass kind, registered in fourteen tables (that list itself has no consumer — see above) |
| `tools/test-prompt-examples.js` | every prompt example, through the validator that judges it |
| `studio-versions.component.ts` | the **Clean text…** button, beside Narrate |
| `electron/book-render-service.ts` | the third streaming door |
