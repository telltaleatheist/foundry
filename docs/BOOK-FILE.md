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
 "chapters": [{"id": "b5-1", "title": "…", "kind": "chapter"?}, …],  // the SEED; ownership is ops'
 "typography": {"bodyPx": 36.0, "categories": {"Footnote": {…}}} | null,
 "seams": [{"after": "b8-3", "before": "b9-1"}, …],   // page turns f declined to join — block ids, not pages
 "loose": {"markers": [{"block": "b2-2", "at": 742, "len": 1, "printed": 20}, …],
           "notes": ["b6-5#0", …]}}
```

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

## 4. Ids

- Minted from the FIRST banked answer a block is made of:
  `b<page>-<order>[-<part>][#<noteOrdinal>]`. A merge consumes the second
  block and leaves the first where it was, so a better join rule changes which
  ids exist and never what an existing id means.
- User splits (ops, not `f`) mint `b2-3/1`, `b2-3/2` — derived, deterministic,
  collision-free with bank-derived names. The book file's parser accepts the
  grammar; only replay mints them.
- Shelved rows mint ids exactly like flow rows. Restoring one to the flow is
  an op against its id.
- An id is never reused, including across regenerations.

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
files instead of re-cropping per cast. Cutting requires the page renders, so
`vlm-book` takes `--pdf` (the archived original) and rasterizes ONLY the pages
that carry Picture blocks; without `--pdf` it writes no images and says so
(the imported-EPUB route has no pages to cut). The directory is regenerable
and swept with the book file.

## 7. What stays out, deliberately

- **Ops and any user decision** — the ledger's. Purity is the point.
- **Translations / transforms** — derived book files with the SAME ids
  (RENDERER.md §4); records files remain the step payloads.
- **Absolute paths, timestamps, machine names** — determinism and portability.
