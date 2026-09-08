# Compare shows what changed

**The compare column lights every word the two steps disagree about — removals
struck red on the older side, additions washed green on the newer — computed on
demand from the two sheets' own rows, through the run mechanism the analysis
highlight already uses.**

---

## 1. The ask

> Owen, 2026-09-08 (relayed by BookForge): *"I want to be able to compare what
> changed side-by-side in ai cleanup. It should highlight the changes on each
> side, like in analysis, so I can see what it was before and what it is now.
> Maybe on hover it shows the original. Something like that. Same with simplify.
> It should show the changes. Probably via a stored diff that runs while the job
> runs."*

## 2. What was built

- **The side-by-side already existed** — `StageService.startCompare(stepId)`
  puts a read-only second column (`app-compare-column`) beside the live book
  pane, showing the book at another ledger step through
  `app-book-view [atStep]`. A text pass (clean / simplify / translate) keeps its
  block ids, so the two columns' rows line up by `row.id`. Nothing about that
  changed.
- **`app/shared/word-diff.ts`** — `wordDiff(before, after)`, pure, no
  dependencies. Tokenises each string into runs of three kinds (words —
  `\p{L}\p{N}` with an apostrophe or hyphen kept inside a word when word
  characters stand on both sides; whitespace; everything else), takes the LCS
  over the token lists (a `Uint16Array` table after common prefix/suffix
  stripping, walked forward so ranges come out in the block's order), and emits
  merged `[start, end)` character ranges: `removed` indexed into the older text,
  `added` into the newer. Whitespace and punctuation tokens compare by equality
  like words, so a doubled space or a dropped comma shows.
- **`app/src/app/core/changes.service.ts`** — `ChangesService`, the one diff both
  sheets read. Each book view that is a **party** to the comparison publishes
  its own replayed rows (`live` / `compared`) — the chain and the pending stack
  already replayed, so the light agrees with the paper strike by strike.
  `order` decides which side is BEFORE from the ledger's chronological `steps`
  array (compared index against the position's; equal means the live side is
  after, because only the unapplied stack can differ then). `changes` diffs
  every block both sides flow, neither has struck, and whose strings differ —
  string inequality first, so the thousands of identical blocks cost one
  comparison each — memoised per id on the pair of strings so a live edit
  re-diffs one block. `liveRanges` / `comparedRanges` hand each sheet its half.
  `changedBlocks`, `changedIds` (book order), `enabled`, and the `reveal` stamp
  for the walk.
- **The book view** — `Piece.hit` widened to `'lit' | 'ghost' | 'added' |
  'removed' | null`; `cut()` takes the change ranges as a fourth sorted list on
  the same cursor as the analysis ranges, closing a run where a change begins
  or ends. `.run.added` is a 22% wash of the new `--ink-added` (#3a7d44, a
  green mixed for the cream sheet beside `--ink-edit` and `--ink-chapter`);
  `.run.removed` is an 18% wash of `--ink-strike` with a line through it. The
  words stay black — a wash only, on Owen's standing alpha rule. Both draw
  under the edition register as well, because the compare column's pane is
  always in it (`viewing()`); the edition strips `.body` tints and rails and
  leaves the runs' backgrounds, as it already did for the analysis light.
- **The compare column's head**, when the target is a book: a mono chip
  (`N blocks changed` / `no changes` / `changes off`, drawn only once both
  sheets have published), a `Changes` checkbox bound to `enabled`, and ↑↓ that
  walk `changedIds` — both parties watch `reveal` and scroll themselves to the
  block, wrapping at either end.

## 3. Why on demand, and not the stored diff Owen guessed at

*"Probably via a stored diff that runs while the job runs"* was a guess at
mechanism, and it is the wrong one for three reasons, each sufficient:

1. **Any pair of steps.** A stored diff exists only for the pair the job had in
   hand — a cleanup against its parent. Computed from whatever two lists the
   columns actually show, the highlight works for a cleanup against the edit
   two rows earlier, a simplification against a translation, or the position
   with its pending stack against its own recorded row.
2. **It can never go stale.** The live side's rows include the unapplied stack;
   an edit made a moment ago is in the diff a moment later. A file written at
   landing is a second account of the book that nothing keeps in step.
3. **No engine release.** The engine's text passes are untouched; this is a
   pure function in `shared/` run by the renderer, and the vendored copy in
   BookForge needs no new dependency.

And it is cheap: a block is a paragraph, the table is tiny, and only blocks
whose strings differ are aligned. The same `wordDiff` could run at landing later
and be kept beside the step if a stored diff is ever wanted for something the
columns are not; nothing here would have to change to read it.

## 4. Why hover-shows-original is not built

The other column **is** the original, side by side, at reading size — which is
what Owen asked for in the first sentence. A tooltip on hover would be a second,
smaller, transient copy of a thing already on screen, over a surface whose
pointer already carries selection, the marker coupling and the twin light. If a
single-column want for it ever arrives, the diff is already computed and the
older text is one map lookup away.

## 5. The granularity guard

An LCS of a paragraph against its **translation** finds every "the", comma and
space the two languages share and lights the rest as confetti — technically the
smallest edit, visually a lie. So when the **words** the two sides share are
fewer than 15% of the shorter side's words, `wordDiff` answers whole-string
ranges: the entire older text removed, the entire newer text added. Words, not
tokens, decide the ratio, because punctuation and whitespace match across any
two sentences in the same script and would vote "mostly the same" on a
translation. The same whole-string answer is given when either side exceeds
1500 tokens.

## 6. Deferred, out loud

- **Structural changes are not diffed.** A block only one side holds (a split's
  new half, a join's absent one) is shown by its absence in one column, not as
  a word diff. A row struck on either side is skipped, on `litRanges`'s rule.
- **The walk's ↑↓ do not select the block** on either sheet; they scroll and
  pulse, which is what `scrollTo` does for every jump.
- **No stored diff.** §3 says why, and how one would be added if wanted.
