# The reflow pass — bank to flowing base

Spec, 2026-08-15. This is phase A of `docs/DERIVED-BOOK.md`, written out far
enough to build from. Read `DERIVED-BOOK.md` §1 and §2 first — the rulings
there bind this document, and §2's three findings are the argument for it.

Every "today the code does X" claim below was verified against the tree at
commit `8972101` and carries a file:line. If one of them is wrong, the spec
is wrong: say so and stop rather than building around it.

---

## 1. What this pass is

**A deterministic, bank-only function from banked page answers to a flowing
document model.** No rasters, no model, no I/O beyond the bank. Same bank in,
same base out, byte for byte, on any machine.

It exists because the rules that turn pages into a book — furniture
suppression, dehyphenation, prose reflow, cross-page joins, note collection,
chapter proposals — are today *side effects of writing XHTML*. They live
inside `buildDotsBook` (`src/vlm/dots-book.ts:2130`), interleaved with string
concatenation, and they are consequently:

- **impossible to show the user** before a file exists;
- **written twice** — `detectChapters` (`dots-book.ts:2005`) is a hand-copied
  replay of the same prologue, kept in step by an assertion
  (`test/vlm/blocks-dump.test.ts:211`);
- **lossy** — the continuation half of a cross-page paragraph never reaches
  `stamp()` (`dots-book.ts:1608-1620`), so it carries no id, no category and
  no page and is invisible to the picker and to `epub-final`.

The pass is the fix for all three at once. The app's flowing editing surface
(phase B) renders its output; the emitters consume it; `vlm-blocks` seeds
from it instead of replaying it.

## 2. What this pass is NOT — the scope fence

**It is a hoist, not a behaviour change.** This is the single most important
sentence in the spec, because it is what makes the work verifiable.

For any bank that has ever been converted, `vlm-convert` must produce **byte-
identical output before and after this pass**, with exactly one class of
exception: paragraph joins that only the ink test ever made now do not
happen, so those two paragraphs stay two paragraphs. That exception is
countable, and the run must count it (§6).

Specifically OUT of scope, and each for a reason:

- **The emitted `data-bf-id` scheme does not change.** It stays the per-page
  emission counter (`stampId`, `dots-book.ts:1239`). Collapsing it onto
  `(page, order, part)` is right and is coming, but `epub-final`'s cut
  machinery and every unpacked working tree on the user's disk are keyed to
  today's scheme, and those retire in phase E. Two identity spaces for one
  more phase is a known cost; a silent id migration under somebody's working
  tree is not.
- **The continuation block still gets no stamp.** Closing that hole changes
  the element numbering of every joined paragraph, which is output churn, and
  output churn is what §2's contract forbids. The BASE model closes the hole
  — every flow block carries its full parts list including continuations, so
  the information exists from now on — and the emitter starts using it when
  ids move, not before.
- **No new join rules.** Not a smarter heuristic, not a model call, not a
  caseless-script signal. `continuesTextually` plus the hyphen carry, exactly
  as they are, and nothing else. `DERIVED-BOOK.md` §2 accepts what that costs.
- **The real-text PDF route is untouched.** It forks before every book rule
  at `convert.ts:556` and that fork is correct — it is §1's diagram already
  written in the engine.

## 3. The model the pass produces

A `FlowBook`: a flat ordered list of flow blocks, plus the collected notes
and the chapter proposals. Names are the builder's to choose; the shape is
not.

```
FlowBlock {
  parts:    readonly BlockPart[]   // (page, order, part) — one, or several when joined
  category: DotsCategory
  text:     string                 // dehyphenated, reflowed, joins resolved
  source:   DotsBlock              // the FIRST source block, by object identity
}
```

Three requirements on this shape:

- **`parts` is the provenance and it is ordered.** A block that swallowed a
  page turn lists both halves, in reading order. This is what makes "which
  page did this come from" answerable after pagination is erased, and it is
  the key ops and transform records are written against.
- **`source` is the block OBJECT, not a copy.** `measureTypeSizes` and the
  typography report key `Map<DotsBlock, …>` (`dots-book.ts:1353`), which is
  why `applyOverlay` deliberately returns the same object when nothing
  changed (`src/vlm/overlay.ts:554-559`). A pass that copies blocks freely
  loses every type size silently. Hold identity or the typography dies.
- **`text` is the joined, resolved string.** The one hyphen resolution, done
  once. `joinTexts` (`dots-book.ts:1701`) survives as that single
  implementation; `appendToParagraph`'s duplicate arithmetic (`1712`) does
  not — see §5.

Notes and chapters ride alongside: the notes list is what `splitNotes`
(`1686`) and the gather loop (`1413-1424`) already produce, and the chapter
list is `proposeSections`' output (`652`) unchanged.

## 4. The passes, in order — and the order is a constraint

Today's sequence in `buildDotsBook` (`2137`-`2196`), which the pass adopts:

1. `suppressRunningHeads` (`416`)
2. `mergeAdjacentHeadings` (`1032`)
3. flatten pages to blocks (`2153`) — **pagination stops being structure here**
4. `measureTypeSizes` (`2171`)
5. dehyphenate each block against `BookLexicon` (`2176-2179`)
6. `reflowWrappedProse` (`2180`)
7. typography / body column (`2184-2186`)
8. `proposeSections` (`2187`)
9. leading span, `foldDuplicateSections` (`2191-2219`)

**Steps 1 and 2 must precede 5 and 6.** `suppressRunningHeads` reads type
sizes and line heights, and `lineHeight` (`src/vlm/dots.ts:667`) counts
newlines — which dehyphenation and reflow rewrite. The existing code argues
this at `dots-book.ts:424-434` and `test/vlm/typography.test.ts` asserts it.
Do not reorder for tidiness.

**The cross-page join is new work in this pass**, because today it happens
during emission (`1602-1620`) rather than in the prologue. ~~It runs after
step 6 and before step 8: joined text is what chapter detection should
see.~~

> **THIS SPEC SAID THE JOIN RUNS BEFORE `proposeSections`, AND THE BUILD
> PROVED IT CANNOT** (2026-08-15). Joining first removes a page's first
> block, which shifts `firstIndexOnPage` — and "is this block first on its
> page" is a condition `proposeChapters` tests, so a heading that is not
> proposed today would start being proposed. A join could also then cross a
> section start, which is impossible today because `buildChapterBody` is
> called once per span. Either one changes the emitted book, which §2
> forbids.
>
> So the order is: propose and fold in **banked-index space** (behaviour
> untouched), then join with the post-fold starts as hard boundaries, then
> translate the starts into flow space. Chapter detection still sees joined
> text in the only sense that matters, because no proposal rule reads a
> joined block's text — headings never join.
>
> **§2 beat §4, which is the fence working as designed.** Recorded rather
> than quietly fixed: the next person to read §4 would otherwise re-derive
> the same wrong order.

Join gate, unchanged in substance from `dots-book.ts:1602`:

- the previous flow block is ordinary prose (today: the previous element was
  a `<p>` and `alignmentClass(...) === ''` — a centred epigraph never joins);
- `adjoins` (`1186`): same page, or exactly the next one. A `--skip-pages`
  gap is a hard boundary;
- `continuesTextually(previousText, nextText)` (`dots.ts:681`) **or** the
  hyphen carry (`trailingHyphenWord` + `leadingWord`, `dots.ts:576`/`582`).

And then the deletion:

> **`carriesOver` (`dots-book.ts:1142`) is deleted, with its only call site
> (`1604-1606`).** With it go `inkExtent` from `DotsPageImages` (`149`),
> `inkExtentIn` (`195`), and the PGM raster caching inside `openPageImages`
> (`222-235`) — `openPageImages` survives for picture and cover crops, which
> are a different job. `lineHeight` STAYS; typography needs it.

## 5. The tangle to unpick

`appendToParagraph` (`dots-book.ts:1712-1736`) is the pass's whole reason for
existing, in one function. It:

1. re-opens a closed element with `paragraph.replace(/<\/p>$/, '')`;
2. does character arithmetic on **rendered markup** to find and remove the
   trailing hyphenated word;
3. splices a `<span epub:type="pagebreak">` into the seam of a word;
4. re-closes the element;

and then line `1620` recomputes the same join over **plain text** with
`joinTexts`, because the accumulated `lastParagraphText` has to stay correct
for the next `continuesTextually` call. Two implementations of one hyphen
resolution, in two representations, that must not disagree.

After this pass: **the join happens once, in the model, over plain text.**
The emitter receives an already-joined flow block and writes one `<p>` — the
pagebreak marker is placed from the block's `parts` list, since the position
of the page turn inside the joined text is exactly what `parts` records.
`appendToParagraph` goes away. `joinTexts` is the survivor.

## 6. What the run must SAY

`DERIVED-BOOK.md` §6 forbids silent truncation, and this pass's one accepted
behaviour change is invisible unless it is reported. So:

- The conversion report gains a count of **joins the ink test used to make
  and the bank cannot** — i.e. page turns where `adjoins` held and the
  textual test said no. Log it on the completion line in the file's own
  voice, in the register of the existing "N skipped" and "N PAGE(S) ARE NOT
  IN THE BOOK" lines (`src/commands.ts:609-631`).
- For a caseless-script book this number will be enormous, which is exactly
  the case `DERIVED-BOOK.md` §2 says must read as a known cost rather than a
  defect. Word it so it does.

## 7. Wiring the consumers

- **`buildDotsBook`** calls the pass and consumes its output. Its own
  prologue (2137-2196) is deleted, not duplicated.
- **`detectChapters` (`2005`) becomes a thin call to the pass** — it exists
  only because the prologue could not be run without emitting a book, and
  now it can. `test/vlm/blocks-dump.test.ts:211` ("the seed and the render
  agree") should become trivially true rather than coincidentally true, and
  it stays as the regression guard.
- **`vlm-blocks`** (`src/vlm/blocks-dump.ts:220,231`) parses the bank twice
  today for the same reason. One parse now.
- **The emitters** (`epub.ts:267`, `text-out.ts:369`) are unchanged in this
  phase. Note for later, not now: `packageVlmText` re-parses the XHTML that
  `buildChapterBody` just wrote (`text-out.ts:329`), so plain text is
  currently downstream of EPUB markup. Once the base exists, text should come
  off the base directly. That is a phase-C tidy, and doing it here would
  break §2's byte-identical contract.

## 8. Tests — do not write any

**Standing rule (user, 2026-08-15): no new tests unless asked for.** *"we
dont need all these tests. i didnt even ask for tests. keep only whats
necessary."*

That rule costs this phase less than it looks, because the verification it
needs already exists. `test/vlm/dots.test.ts` is ~128 assertions written
directly against the assembler's behaviour, and §2's contract is that this
behaviour does not change. **The existing suite IS the byte-identical
guard** — a hoist that keeps the suite green has demonstrated the only thing
this phase claims. Writing a fresh contract test would be re-asserting, in
new scaffolding, what the old scaffolding already asserts.

So: run the gates, keep them green, add nothing.

**Expect to break, and fix rather than delete** (these are the assertions
that pin today's behaviour, all in `test/vlm/dots.test.ts`):

- `:386-464` — the ink tests. These go with `carriesOver`.
- `:1143` — "a paragraph joined across a page turn is one paragraph, hyphen
  resolved". It asserts exactly one `<p`, the fused word, `joinedPages.length
  === 1`, and the pagebreak id *inside* the paragraph. This must still pass:
  it is the case the pass exists to keep working.
- `:428`/`:438` (gap boundary), `:460` (ordering), `:1078`/`:1111` (id
  uniqueness), `:1134` (footnotes at chapter end).

A test that breaks because output changed is a **failure of the scope fence
in §2**, not a test to update — unless the change is an ink-only join, which
is the one exception. If you find yourself editing an assertion for any other
reason, stop and report it.

## 9. Build order inside this phase

Land it in increments that each keep the tree green, rather than one commit
that rewrites the assembler:

1. The pass, alongside the existing prologue, unused. Contract test green.
2. `detectChapters` and `vlm-blocks` switch to it. `blocks-dump.test.ts:211`
   proves the two agree — this is the cheap proof the pass is faithful,
   before anything user-visible depends on it.
3. `buildDotsBook` switches to it, prologue deleted. Full suite green.
4. The join moves into the pass; `appendToParagraph` deleted; `carriesOver`
   and the ink machinery deleted; the report gains its count.

Step 2 is the load-bearing one. If the pass and the existing prologue
disagree, that assertion catches it before the emitter is touched.

## 9a. Owed after phase A — the ink's leftovers (2026-08-15)

Deleting the ink test stranded the machinery that fed it. Both are LEFT IN
PLACE deliberately, because removing them was not in the fence and neither is
free:

- **`src/scan/pgm.ts` is now unreferenced.** `readPgm`'s last caller went with
  `carriesOver`. Deleting it means updating `docs/ARCHITECTURE.md` §9, which
  is where the file is described.
- **A grayscale PGM is still written for every page and now never read** —
  `src/vlm/bridge.ts` (`grayscale`), `src/vlm/read.ts`, and `vlm_page.py`'s
  `write_pgm`. Removing it crosses the Python seam and changes what
  `--renders` leaves on disk. All three sites now carry a comment saying the
  write is owed a removal, so the waste is documented where somebody will
  meet it rather than only here.

Neither is urgent — one is dead code, the other is disk somebody asked for
with `--renders`. Both are cheap to do in a pass that is already touching the
Python seam.

## 10. Decisions taken here, so nobody re-opens them mid-build

- **Ids do not move in this phase.** §2.
- **The continuation stamp hole stays open one more phase.** §2 — the base
  records the information now; the emitter uses it when ids move.
- **`openPageImages` survives**; only its raster/ink half dies. Crops are a
  different job and the cover comes off the scan.
- **The pass is bank-pure and takes no `images` argument at all.** If a
  signature needs one, something is still sampling the page and the ruling
  has been broken. That is the test to apply when in doubt.
