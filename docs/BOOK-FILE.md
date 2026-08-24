# The book file — format contract, v3

The canonical structured form of a book inside Foundry. One writer (the
engine's `vlm-book`), many readers (main, the renderer, export). The app-side
parser (`app/shared/book.ts`) is a MIRROR of `src/vlm/book-file.ts` and the two
grow together in the same commit, always — the unrender.ts precedent, promoted
to a rule.

This file is the contract. An implementation detail may live in code; a field,
an invariant, or a policy lives HERE first.

---

## 1. The two layers, and the wall between them

```
readings/<key>.jsonl          THE RECEIPT — what the model said, verbatim
readings/<key>.book.jsonl     THE BOOK FILE — everything else, derived
readings/<key>.images/        THE CUT ASSETS — figure crops, derived
```

**The receipt is never reconfigured, normalized, or edited.** It is append-only
while a reading runs and immutable after. Every improvement Foundry has made to
its book-building has been a free re-parse of unchanged receipts; normalizing
the receipt into a "nicer" shape would freeze today's parsing rules into the
only copy of an artifact that cost GPU-hours. The receipt's job is to be dumb
money.

**The book file is a pure function of the receipt**: `book = f(receipt)`, where
`f` is the engine's reflow (dehyphenation, page-turn joins, running-head
suppression, heading merges, note splitting, marker linking, chapter
detection). No user decision is ever written into it — decisions are ops in the
project ledger, keyed by block id. This purity is what every future capability
stands on: `f` can improve forever, and regeneration is seconds.

**AND THE RECEIPT IS NOT ALWAYS A BANK.** A project imported as an EPUB has no
bank and never will: a bank models pages and an EPUB has none, and reading real
text back through a vision model would trade exact data for a guess at it
(RENDERER.md §6, the refinement). For such a project the receipt is **the
container itself** — archived immutable, `book = f(epub)` — and `f` is the
engine's explode (spine order, semantic markup → categories, the publisher's own
noteref anchors → refs, nav → chapters, figures copied). Everything the two
routes produce is one format, one set of readers, one kind of op:

```
readings/<key>.jsonl          THE RECEIPT, read from pages      → f = reflow
archive/<book>.epub           THE RECEIPT, imported as a book   → f = explode
readings/<key>.book.jsonl     THE BOOK FILE, either way
readings/<key>.images/        THE CUT ASSETS (cut, or copied)
```

**Ids are stable under regeneration by construction** (§4). That is the load-
bearing property: ops, chapter markers, and translation records survive a
better `f`.

## 2. Lifecycle and integrity

- **Written once, at read-landing** ("reconfigure the bank as soon as it's
  created" — the ruling this design serves), by the orchestration that also
  produces the facsimile.
- **Written atomically**: temp file + rename, never in place. A crash leaves
  the old file or none, never half a book.
- **Regenerated only deliberately** — never silently on open. The header
  carries `source.bankSha` (sha-256 of the receipt, first 16 hex) and
  `source.generation`; a loader that finds a mismatch REFUSES BY NAME and the
  one door that may rebuild (main's ensure step) does so as an announced
  action. Silent regeneration mid-session could strand ops against vanished
  ids with nothing on screen saying why.
- **Version discipline**: fields are ADDED, never renamed or repurposed,
  without a version bump. Readers ignore unknown fields (forward-compatible);
  readers refuse an unknown `book` version by name (regeneration is cheap and
  the refusal says so). The writer stamps `engine` (the foundry version) for
  provenance.
- **Determinism**: same receipt, same engine version → byte-identical book
  file. No timestamps, no randomness (the codebase's fixed-timestamp ethos).

## 3. The grammar

JSONL. Line 1 is the header; every following line is a row. Rows are in
**reading order**, and order is carried by position in the file — never by a
field — so a reorder op is a move, not a renumbering.

### Header

```jsonc
{"book": 3,
 "engine": "<foundry version>",
 "language": "en",                        // the read's declared language
 "source": {"pages": 17, "unreadable": [{"page": 9, "reason": "…"}],
            "generation": "<uuid>", "bankSha": "<16 hex>"},
 "figures": {"blocks": 4, "cut": 4, "from": "pdf"|"pages"|"epub"|null},  // OPTIONAL — see §6
 "chapters": [{"id": "b5-1", "title": "…", "kind": "chapter"?}, …],  // the SEED; ownership is ops'
 "typography": {"bodyPx": 36.0, "categories": {"Footnote": {…}}} | null,
 "seams": [{"after": "b8-3", "before": "b9-1"}, …],   // page turns f declined to join — block ids, not pages
 "loose": {"markers": [{"block": "b2-2", "at": 742, "len": 1, "printed": 20}, …],
           "notes": ["b6-5#0", …]}}
```

On the **imported-EPUB route** the same header fields say the same kinds of
thing about a different receipt: `source.pages` is the count of SPINE DOCUMENTS
(the format has one field for "how much source was there", and a document is
that book's unit of it); `source.unreadable` is always `[]`, because a spine
document that will not parse stops the run rather than being skipped — an EPUB
either explodes whole or does not explode; `source.bankSha` is the first 16 hex
of a sha-256 over the **EPUB's own bytes**, which is the receipt in exactly the
bank's sense; and `language` is the package's `dc:language`, declared by the
publisher, which `--language` may override and never silently defaults over.
`chapters` is the publisher's nav (or NCX) verbatim, entry by entry, resolved to
the row each href lands on. A `Footnote` row on this route carries no `note`
ordinal — there is no banked block for it to be the nth note of — and carries
`refs` like every other note row, `[]` included.

### Row

```jsonc
{"id": "b2-3",
 "category": "Text",
 "text": "…the finished text, dehyphenated, joined, reflowed…",
 "page": 2, "pages": [2, 3],              // estimates; NOTHING is addressed by them
 "box": {"x1":…, "y1":…, "x2":…, "y2":…}, // composed under merge (origin+heights+union)
 "pageWidth": 1653, "pageHeight": 2450,
 "parts": [                               // how the text was assembled, char-exact
   {"src": "2:3", "page": 2, "chars": [0, 412]},
   {"src": "3:1", "page": 3, "chars": [412, 731], "fused": "self-representation"}],
 "note": 3,                                // Footnote rows only: ordinal in its banked block
 "refs": [{"block": "b2-2", "at": 742, "len": 1}],   // Footnote rows only, may be []
 "image": "p0002-3.png",                   // Picture rows only: name in readings/<key>.images/
 "shelf": "furniture" | "suppressed-head", // ABSENT for a flow row
 "why": "recurs at the top of 11 pages at body size"  // shelved rows only
}
```

`parts` supersedes v2's bare `src` array (same information plus the char
ranges and the fused words). `src` coordinates remain the re-keying bridge for
anything recorded before ids existed.

### The no-page frame — an EPUB-sourced row's geometry

A book exploded out of an imported EPUB has **no pages at all**, so every one of
its rows wears the same documented frame and no reader has to ask which kind of
book it is holding:

```jsonc
"page": 0, "pages": [0],
"box": {"x1": 0, "y1": 0, "x2": 0, "y2": 0},
"pageWidth": 0, "pageHeight": 0,
"parts": [{"src": "e:<n>", "page": 0, "chars": [0, <len>]}]
```

and the header's `"typography": null`, `"seams": []`.

**Page 0 is not a page.** It is the number that names none, and writing it costs
nothing precisely because *nothing in this format is addressed by a page* — the
rule the whole file has been under since v1. A row on this route also has exactly
ONE part, because nothing was ever broken across anything to be joined; `src` is
`e:<n>`, the same ordinal the id carries.

**`typography` is null because there is nothing to measure**, not because the
measurement was skipped. The report is medians over BOXES (type size is a box's
height over its line count) and there are no boxes; null is the contract's own
spelling of "the base sheet's type rules stand", which is the documented silence
rather than a guess dressed as a measurement.

**No facsimile is ever made from such a book**, and `vlm-compile` writes no
`epub:type="pagebreak"` anchor for page 0 — a print-source citation to a leaf
that was never printed is the one claim page provenance exists to make truthfully.

## 4. Ids

- Minted from the FIRST banked answer a block is made of:
  `b<page>-<order>[-<part>][#<noteOrdinal>]`. A merge consumes the second
  block and leaves the first where it was, so a better join rule changes which
  ids exist and never what an existing id means.
- **`e-<n>` for a block exploded out of an imported EPUB** — the spine-order
  element ordinal, 1-based across the whole book (spine order, then document
  order inside each spine document). There is no bank under such a book, so
  there is no `b<page>-<order>` to mint and no page number may be invented to
  stand in for one. What an EPUB has instead is an ORDER, it is total, it is the
  publisher's own, and it does not move when the explode improves — which is the
  only property an id has to have. `#` and `/` ride on it exactly as they ride on
  a banked name.
- **`u<n>` for a block a person added** — the `insert` op's mint
  (app/shared/ops.ts), for the block the reading never produced at all: it
  descends from nothing, so there is no page, no banked answer and no spine
  ordinal to derive a name from. The sheet mints the first free ordinal over
  the replayed rows and the op records it. Admitted for `e-<n>`'s reason
  exactly (below), found the hard way: the first inserted block to reach
  `vlm-compile` was refused by name (2026-08-24). `#` and `/` ride on it as on
  the other families.
- User splits (ops, not `f`) mint `b2-3/1`, `b2-3/2` — and `e-7/1`, `e-7/2` —
  derived, deterministic, collision-free with both minters' names. The book
  file's parser accepts the grammar; only replay mints them.
- Shelved rows mint ids exactly like flow rows. Restoring one to the flow is
  an op against its id. (The explode shelves nothing: an EPUB has no page
  furniture and no running heads to suppress.)
- An id is never reused, including across regenerations.

### Why `e-<n>` did not move the version

The version bump rule of §2 says a field is never renamed or repurposed without
one. This renames nothing and repurposes nothing: it ADMITS NEW NAMES into a
field whose grammar was already open on both ends, and it invalidates no file
that has ever been written — no `e-` id exists anywhere until the first EPUB is
exploded by a build that has this grammar. An older build that meets one refuses
it by name with the id-grammar sentence, which is the **correct** answer from a
build that has no explode and could not draw such a book anyway. Bumping the
version instead would have made every existing book file unreadable by the new
build for a change that affects none of them.

The two regexes that state this grammar — `ROW_ID` in `src/vlm/book-file.ts` and
the prose statement on `BookRow.id` in `app/shared/book.ts` — grow in the same
commit, always, by the mirror rule at the head of this document.

## 5. The shelf — nothing is ever silently gone

Every block the model answered is a row. A row is either IN THE FLOW or ON THE
SHELF, and the shelf says why in a sentence:

- `furniture` — the model tagged it Page-header/Page-footer.
- `suppressed-head` — `f` judged a body-tagged block to be a running head
  (`suppressRunningHeads`); `why` carries its evidence.

The Furniture Review panel is a listing of the shelf; "restore" is an ordinary
op that flips the row into the flow at its reading-order position, undoable
like everything else. Renderers do not draw shelved rows in the flow.

## 6. The cut assets

At creation, figure crops are cut ONCE into `readings/<key>.images/`, named
deterministically by source coordinate (`p<page>-<order>.png`). Rows reference
by name; the renderer, every export, and every future feature reuse the same
files instead of re-cropping per cast. Cutting requires the pages, so `vlm-book`
takes them — **`--pdf` for a scanned document or `--pages` for a directory of
page photographs, never both** — and opens ONLY the pages that carry Picture
blocks; with neither it writes no images and says so (the imported-EPUB route
has no pages to cut). The directory is regenerable and swept with the book file.

**The two faces are the read's two faces** (`VlmSource`, `src/vlm/bridge.ts`), and
the box means the same thing in both because the bank records the box in the PAGE
RENDER's frame: for a PDF the render is the raster at the pinned dpi, so the box
goes back to points and that patch is drawn again at the same dpi; for a page
image the render IS the photograph, so the box is already in its pixel grid and
those pixels are copied out at 1:1. **Page N is `pagesInDirectory(dir)[N - 1]`**,
the single ordering rule the read banked its answers under — a second spelling of
it is how page 12's figure gets cut from page 13.

**The header records what became of the pictures** — `figures`, optional. Three
facts: `blocks` (Picture rows, shelf excluded), `cut` (how many have a file), and
`from` (**what the run was given**: `pdf`, `pages`, `epub`, or `null` for none).
`from` records an OFFER, not an outcome, and that is what makes the app's
auto-heal terminate: a book remade with a source says so forever, so "was made
with nothing to cut from" can never be true twice for the same book. **Absent is
legal and means an engine older than the field wrote the file** — a reader that
finds it missing learns nothing about the figures and must look at the rows (a
Picture row with no `image` was not cut). No version bump: the field is additive,
old readers ignore it, and every existing book file passes through the unknown
state exactly once, because the remake it may trigger writes the marker.

**On the EPUB route the figures are COPIED, not cut** — into the same directory,
which the engine derives from `--out` (`<stem>.book.jsonl` → `<stem>.images/`),
the exact inverse of the app's `bookFileFor`/`imagesDirFor` pair so the two agree
by construction. A publisher's figure is already a file somebody made; re-encoding
it would produce a different file that means the same thing. Names are the Picture
row's own id with the source extension (`e11.png` for row `e-11`) — deterministic,
collision-free, and a name no other row claims. The extension must be one an EPUB
may legally carry (GIF, JPEG, PNG, SVG, WebP); anything else is refused BY NAME at
the explode, because the media type declared in a package manifest is the one
thing a reading system consults before it draws a picture. `figureMediaType`
(`src/vlm/book-file.ts`) is the single table both the explode and `vlm-compile`
read it from.

## 7. What stays out, deliberately

- **Ops and any user decision** — the ledger's. Purity is the point.
- **Translations / transforms** — derived book files with the SAME ids
  (RENDERER.md §4); records files remain the step payloads.
- **Absolute paths, timestamps, machine names** — determinism and portability.
