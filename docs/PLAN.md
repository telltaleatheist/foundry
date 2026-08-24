# The plan of record — everything left, and who it is waiting on

Opened 2026-08-15, and this file is the ANSWER TO ONE COMPLAINT the user
made after a week of half-built features:

> "i feel like a lot of my problems route back to the fact that i explained
> what feature i wanted and instead of building it, half was built and the
> other half was put on the back burner and ignored. i just want to make
> sure everything is fully formed out as expected and theres nothing being
> forgotten about"

So: every promised thing is on this list, including the ones already built,
including the ones deliberately not being built, including the halves that
were dropped once and recovered. **A thing is allowed to be deferred. It is
not allowed to be deferred silently.** If a wave ends and something on this
list is neither done nor explicitly deferred with a reason, that is a defect
in the process, not a detail.

**How to use this file.** It is the INDEX AND THE STATUS. The designs live
where they were argued — `docs/WORKBENCH.md` (app surface + the endgame
specs §8–§11), `docs/DERIVED-BOOK.md` (the data model, phases 0/A–G),
`docs/STEP-LEDGER.md`, `docs/BANK-LIFECYCLE.md`, `docs/TRANSLATION-STEPS.md`
— and this file says what is done, what is running, what is next, and what
is knowingly not being done. When a unit lands, update its row here in the
same commit that lands it.

---

## 1. The rules of engagement (unchanged all week)

- **Agents never commit.** The lead verifies and commits; the lead pushes.
- **Five gates before any report, every unit**: `bun test` (the gate is
  ZERO FAIL, not a pinned count — a stale "396 pass" sat here while the
  suite measured 384, and a number nobody re-measures is not a gate);
  root `bunx tsc --noEmit`; from `app/`:
  `bunx tsc -p tsconfig.electron.json --noEmit`,
  `bunx tsc -p tsconfig.app.json --noEmit`, `bunx ng build` (the
  801.07 kB against a 500 kB budget WARNING is pre-existing; an ERROR is
  not — and see §7, where that number was 145 kB stale until somebody
  re-measured it). Plus a raw-control-byte scan of every touched file.
- **No new tests** (user ruling). Fix the ones a change invalidates; name
  each in the report. Do not add a suite nobody asked for.
- Long WHY comments in the codebase's essay voice. Escape backticks as \`
  in Angular template prose. Never a raw control byte — write `\u0000`
  escapes. Never match basenames across directories — fold whole paths.
  No filenames in user-facing copy.
- **An honest partial beats a bent whole.** An agent that finds the spec
  contradicting the code stops and says so; it does not improvise around
  the contradiction.

---

## 2. The tree, in the user's words (2026-08-15)

This is the model everything below serves, quoted so it stays the standard:

> "the user imports a pdf - that's a top level item. under that, the OCR
> process reads the imported item. from the bank, pdf facsimile can be
> generated. that's a terminal item in the tree - it doesnt go anywhere
> else… the user can make deletions to the bank, since the bank will be
> displayed as html/proto epub. those changes can be indented and saved
> since they apply specifically to the bank. the user can create a
> translation from those deletions, or they can create a translation from
> the top-level bank item… if they click the english translation and then
> click translate to hungarian, it translates from english to hungarian,
> thus creating a chain of translations: german to english to hungarian."

> "each action they take is applied to the step that they actively have
> applied"

Built already: the tree itself (one provenance tree per open book, root =
import, exports as terminal children), one-selection (every action keys off
the standing step, never the focused tab), curate lines indented under the
book. Remaining: chains (§4, unit D2), and the book's own surface (§4,
unit K).

---

## 3. Done and pushed

| # | what | commit |
|---|---|---|
| 1 | The library tree — one selector, merged from two sidebars | `9ac53fb` |
| 2 | One selection — every tool obeys the position | `1ad1a4a` |
| 3 | A deleted book's ledger answers "gone", not "broken" | `a82797c` |
| 4 | Debris: stale comments, dead `openConfirm()`, duplicate toolbar titles, visible Close-book ✕ on the tree root | `54bb437` |
| 5 | **Phase C — what lands in `final/` is an edition**: struck notes never emitted, noterefs demoted to the printed digit, editing attributes withheld, translated exports tidied after their last stage, Save-As no longer zips the workbench verbatim | `2beeaf5` |
| 6 | **Unit D1 — the engine's records mode**: text-level masking (a new tokenizer; the edge-peel hack proved unnecessary), `translate --records` + `--source-records` (chain-ready), `vlm-convert --records` substitution at the emitter, per-note footnote records, KEY_FORMAT bumped, composes with `--final` | `cd919d0` |
| 7 | **Unit D2 — the app orders records, and chains**: a translate step's payload IS its records file; the two-stage export pipeline deleted, not bypassed; the one-hop refusal out, chains in; plain text of a translation works for the first time; `SHOWS_ITS_PAYLOAD` renamed `A_BOOK_OF_ITS_OWN` | see §4 |
| — | The specs for everything below, and this file | `f2a8141`, `da96196`, `fea8f6b` |

Phase C's premise was corrected by survey before it was built: struck
BLOCKS were already really removed (they die at `applyOverlay`, upstream of
the format fork). What leaked was struck NOTES, the editing stamps, and a
second untidied door. Recorded because the plan's own memory of itself was
wrong, and the next survey should be trusted over the next memory too.

---

## 4. In flight and next — the execution order

Fences are disjoint within a wave; a wave lands before the next starts.

### Wave 2 — LANDED (D1 `cd919d0`, M `55d40f7`)

- ~~Unit M~~ — landed. Metadata is a step; a save casts its own book;
  exports carry the metadata chain; `canEditMetadata` got the import-row
  gate its own comment had claimed for weeks. **The spec's ancestry rule
  was wrong and the builder caught it**: an Apply leaves the pointer put,
  so a metadata row is a CHILD of the position, never an ancestor, and
  the specced upward walk would have found nothing in the ordinary case —
  reintroducing the exact silence the unit exists to end. The rule built
  instead: a patch is in effect when the step it was made from is on the
  path from the import to where you stand. Also routed by the lead
  (outside the unit's fence): the per-save cast must not open itself, or
  every Apply drops a tab in front of work in progress.
- ~~Unit D1~~ — landed. The format it wrote is the contract D2 consumes;
  it is spelled out in WORKBENCH §10 rather than left in a report.
  Grouping came free rather than being rebuilt: the cast's own container
  markup already groups a list with its items, so `planChunks` and its
  siblings were reused verbatim. What D1 leaves for D2 (its own words):
  the one-hop refusal at `pipeline.ts:207-214`, the `landsUnder`
  generalization, `params.language` → `--from` wiring, and the
  "Translate (English → Hungarian)" labels.

### Wave 3 — LANDED (K `0e2cd1c` + `e9ed0ef`; D2 in this commit)

**Unit K's residual is DISCHARGED.** The combined five-gate run on
D2's landing — run by the lead, in the main tree — came back green:
396 pass, three clean typechecks, `ng build` complete with the
pre-existing budget WARNING only. That run is what K's narrower
gate claim was waiting on.

Also learned, so nobody repeats the hour: an isolated worktree cannot
run the Angular gates. `bunx tsc -p tsconfig.app.json` and `ng build`
work only in `C:\Users\tellt\Projects\foundry` — `@angular/*` is not
in either `node_modules` and junctioning them into a worktree does not
reproduce whatever resolves it. Verify app-side units in the main tree,
one at a time, or accept a narrower claim and say so. (D2's builder
then found `app/node_modules` missing `@angular` entirely and repaired
it with `bun install` — npm's own install refuses with EBUSY while the
Foundry app is running. The reinstall moved the bundle figure from
550.90 kB to 565.23 kB; attribution to the reinstall is likely but was
not proven, because a stash-and-rebuild mid-unit risked more than
14 kB of attribution is worth.)

- ~~Unit K~~ — landed. Viewer-side stacking; the cast format is
  untouched and the engine never learned about it. Route 2 (a
  single-flow cast) was never needed. Two limits stated, not hidden: a
  chapter line cannot be dragged across a document boundary (remove and
  re-add through that document's gutter), and a long book is that many
  live frames with no virtualization. **Three spec assumptions of mine
  were wrong and the builder said so**: the inspector's Chapters
  section did not serve the book at all (it was scan-only, so the
  second projection had to be built, not reused); the overlay door I
  named needs a scan's block view and was unusable from a book tab; and
  undo did not already cover a chapters row on a book — it would have
  thrown. A routed one-line fix (`e9ed0ef`) taught the book's undo
  ledger the `chapters` field, which would otherwise have archived a
  book's whole undo history aside on next open.

- ~~Unit D2~~ — landed. A translate step's payload is now its RECORDS
  file — the builder's argument was a symmetry, not a preference: a
  records translation is the same shape of act as a reading, so the
  payload rule, orphan sweep, displacement handling and debris sweep
  all fell out of machinery that already existed. **One reported
  divergence from the spec**: `PARAMS_OF.translate` did NOT gain
  `records` (the payload IS the file; a param would be two copies of
  one fact) — it gained `from` instead, which is what the chain labels
  need. `SHOWS_ITS_PAYLOAD` renamed `A_BOOK_OF_ITS_OWN` because that
  was the question all three consumers were asking. The two-stage
  export pipeline was deleted, not bypassed (`ThenTranslate`,
  `translationStage`, `withoutExport`, `landsUnder`, both tmp
  intermediates); three things got better as side effects: plain text
  of a translation works for the first time, a translated export is
  immediate, and a save under a translation casts its own book. The
  builder ran an independent review over its own diff; all six
  findings were real and fixed (the worst: a translated rendering
  catalogued as the project's flowing book, and a `generated/` name
  collision with every legacy translate payload that would have let
  `rotateGenerated` archive a row's own book). One routed fix outside
  the fence, applied by the lead: `translate` left `OPENS_ITSELF`
  (tabs.service.ts) — its product is a `.jsonl` nobody reads, and
  opening it produced a refusal notice per finished translation.
- ~~Unit K~~ — landed (see above). Continuous book, chapter lines.

**What an old translate step can no longer do, ruled honest by the
bank math**: export from it (or from a save under it) is refused with
a sentence saying to translate again — after D1's KEY_FORMAT bump its
bank misses every key, so the old pipeline would have re-translated
the whole book at full model price while claiming to be arithmetic.
Re-translating a legacy row replaces it in place (payload swaps to the
records file, displaced EPUB and orphaned bank destroyed) and
everything after that is free. Everything else about a legacy row —
parsing, rendering, focusing, deleting, chaining FROM it — works
unchanged.

### Wave 4 — LANDED

- ~~Unit D3 — the ops~~ — landed. All three: "edit block text" mirrors
  to the overlay (and the one-block-wide re-ask was VERIFIED through the
  real key path — edited block's key changes, neighbour's does not —
  which closes D2's stale-translation cost); "edit transformed text"
  writes a keyless human row per language; **the manual join op**, the
  flagship recovered half, runs overlay → reflow → gesture → ledger →
  undo. The user's ruling that editing must reach chapter HEADERS was
  already satisfied — the gesture targets `data-bf-cat`, which every
  stamped element carries including `h1`–`h6` — and a header rename
  propagates to the TOC because nav is minted from the substituted
  heading. Verified end to end by script.

  **The find that made op 2 real**: D1's "a run never appends over a
  user row" refusal compared `newest.key === key`, but a human row is
  KEYLESS by construction — so the comparison was never true and every
  correction would have been silently overwritten on the next run,
  under a log line falsely claiming the source had changed. Fixed with
  `questionFor(parts)`: the newest KEYED row at a position is the
  question the person was answering; same key, the correction stands;
  different key, the machine takes over and says so.

  **Three spec assumptions corrected by survey**: the ink test is
  already gone (so the join is compensation for a cost being paid, not
  a tie-break restored); `continuesTextually`'s own docstring lied
  about a caller that no longer exists (fixed in place); and a join
  CANNOT ride `applyOverlay`, because that runs at the parse where
  blocks have no neighbours and there is no seam to decide — it reads
  at `reflowBook` through the new `joinDecisionFor`.

  **`history.ts` FIELDS gained `'join'`** — the same trap unit K hit;
  omitting it archives a book's whole undo history on first reopen.

  **The one honest gap**: the independent review agent D2 had was
  killed by the wrap-up order, so this unit has no second pair of
  eyes. Everything was self-verified against real modules with
  throwaway scripts. If a session has budget for one thing, that is
  the thing.

### Wave 4b — THE HAND-TEST'S FIRST THREE (run before Phase E)

Found by the user clicking, 2026-08-15, within minutes of D3 landing.
**All three are one shape**: a rule that was right for the surface it
was written against, still aimed at that surface after the surface
moved. That is the exact failure mode this file exists for, and it is
why Phase G is not optional — the gates caught none of them.

1. **Deleting an export throws.** The library tree offers the ✕ to
   export rows (`open-documents.component.ts:315`, `kind === 'export'`),
   but main's `findDocument` (`main.ts:1988`) searches only
   `project.documents`. Export rows come from a DIFFERENT catalogue —
   `manifest.final` → `filedDocuments` (`projects.ts:4670`) →
   `project.exports` — so the lookup can never succeed, and it fails
   with a sentence written for a foreign path ("not a document in any
   of Foundry's projects") about a file this app made and listed.
   **Fix**: an export delete is its own door, not the document door —
   an export has no steps, no origin, cannot be the project's
   original, and its removal is "unlink the file, drop the manifest
   row". Teaching `findDocument` about `manifest.final` is the wrong
   direction: it would make export rows answer questions
   (original? retention? steps?) that do not apply to them.
2. **`<br>` is protected as though it were a page marker.**
   `refuseUnlessWordEdit` lets only `<sup>` and a noteref `<a>`
   disappear; every other tag must return exactly. A `<br>` carries no
   attribute, no id, no reference — it is typography, and where a
   title breaks its lines is precisely what a person editing a title
   is deciding. The refusal even says "a page marker is not a word"
   about a tag that is not a page marker. **And the twin, unhit but
   certain**: the editor's keydown deliberately leaves Shift+Enter
   alone *"so a genuine `<br>` is still typeable"*
   (`click-reporter.ts:2005`) while the guard refuses ANY gained tag —
   the editor invites the keystroke and then rejects the edit. **Fix**:
   `<br>` becomes freely droppable AND typeable; every pointer-bearing
   tag keeps exact-match protection; the message stops calling a line
   break a page marker.
3. **Renaming a chapter from the inspector throws.** The Contents
   rename needs a nav anchor matching on file AND fragment exactly
   (`epub-reader.ts:1532`, no fallback), or a page heading still
   reading what the nav said. After unit K the book is CONTINUOUS —
   many chapters inside one document — so the inspector's rows carry
   in-document fragments the per-document nav anchors do not have, and
   a chapter line's title is not a heading element for the fallback to
   find either. **Fix, and it follows the user's own ruling** (*"that
   dotted line is the definitive chapter info for the book"*): a
   rename from the inspector amends the CHAPTERS overlay row — the
   same write the line's own double-click performs — instead of
   hunting for an anchor. Confirm the diagnosis against a live cast's
   nav before building; the fragment mismatch is strongly indicated
   but was not observed directly.

### Wave 4c — THE SECOND SITTING (user, 2026-08-15, after 4b)

Four more, and the user's judgement on them is part of the record:
*"theres a lot that's incomplete here, and hasnt implement what i
intended and what we discussed in great detail, and that concerns
me."* That is the same complaint this file opens with, and it is
being made about work that landed AFTER this file was written. Do not
explain it away.

4. ~~**The translation model is never brought down.**~~ FIXED, and
   pushed as `3622069` — the user said "fix that now" and it was the
   one item that could be fixed in place with certainty. Ollama holds
   a model for five minutes after its last request and this program
   never asked it not to, so a finished book left ~20 GB pinned on the
   card the reading server wants next. Every run now ends with
   `keep_alive: 0`, in a `finally` so a FAILED run gives the card back
   too, best-effort so it can never fail a run that produced its book.
   `--keep-model` is the hatch for an Ollama this machine does not own;
   the app never passes it.
5. **Chapter mode is a mode, not a hover.** User ruling, verbatim:
   *"chapter markers shouldnt light up when i drag the mouse around,
   it should be a button i press - add chapter. then it lets me pick
   where it goes, then it exits chapter mode. i should be able to
   delete chapters or move them around freely."* So: the gutter's
   add-affordance stops responding to an idle pointer entirely. A
   button — **Add chapter** — enters a mode; the next click places the
   line; placing it EXITS the mode. Deleting a line and dragging one
   are free actions available without entering any mode. Unit K built
   the drag and the double-click rename correctly; what it got wrong
   is that adding was ambient instead of asked for.
6. ~~**A translation lands in the inspector's Contents but not in the
   left nav's tree.**~~ FIXED in wave 4d, and BOTH recorded guesses
   were wrong — worth keeping as an argument for the diagnose-first
   rule rather than as a wrong turn to be tidied away. The translate
   step WAS in the ledger and WAS drawn. What was also drawn, one line
   under it, was a second row for the same book: the cast. See 4d.1.

### Wave 4d — THE THIRD SITTING (user, 2026-08-15, after 4c)

The user asked, before any of this was built, that the understanding
be stated back first: *"can you explain what you think i want fixed so
i know we're on the same page"* — and then answered each item. Their
answer to two of the five is one sentence, and it is now a rule of
this repo as much as §1's are:

> *"no fallbacks. i hate fallbacks. fallbacks are bugs. theyre
> unexpected code paths. that is a cardinal rule… we fix things at the
> root, and we error if theres a problem."*

Read it against the four defects below and it is the whole diagnosis:
every one of them was a second-choice branch, reached for on
emptiness, doing something plausible and wrong.

1. ~~**"EPUB — a copy you opened"**~~ FIXED. A per-step cast is
   uncatalogued on purpose, so the tree — which took `documents` as
   its list of paths a step already speaks for — drew the translation's
   cast in its loose-file branch, labelled by container format. Both
   halves were false: nobody opened it, and *"the user should never
   see 'epub' — not until they actually export an epub directly
   themselves. it's deceptive."* Root fix: `ProjectSummary.renderings`
   carries the cast names, composed by the side that knows how they
   are composed, and the tree speaks for them.
   **Answered on the record: no, steps are NOT zipped EPUB snapshots.**
   The ledger holds the archived PDF, a `.jsonl` bank and a `.jsonl`
   records file. The storage was already right; the naming lied about it.
2. ~~**Contents and Chapters were two panels for one question.**~~
   FIXED — *"correct. should be the same unit: chapters."* Contents
   drew the cast's nav, which is minted FROM the chapter lines, so the
   panel offered the record and its own photocopy and let a person
   rename the photocopy. One section now. Which list it draws is asked
   of the document (`BookSpine.banked`), never inferred from a list
   coming back empty: a book Foundry read has a marker spine, a book
   somebody imported whole has only its own table of contents.
3. ~~**Two identical "Contents" rows, the first one an image.**~~
   FIXED. It was the COVER, and the row said the book's title because
   the cover document's `<title>` is the book's title. Under it sat a
   three-rung fallback chain ending in the FILENAME on a panel whose
   whole discipline is that a filename never appears. Now: the cover is
   excluded by its own `epub:type="cover"` declaration (and by an EPUB 2
   `<guide>` reference), and a document neither the nav nor its own
   `<title>` will name gets no row at all. Which forced the other half —
   `EpubBook.members` — because the flowing book was drawn by walking
   the contents list, so an unnamed document would have stopped being
   RENDERED. A table of contents may not decide which pages exist.
4. ~~**"Undo history restored: 13 actions…, from C:\…\ad6dcb.json"**~~
   FIXED. The app congratulating itself about a success nobody asked
   about, at the moment a book opened, by naming an absolute path. Both
   copies of it (`history.ts`, `overlays.ts`) are silent now. The
   FAILURE notices keep their paths: there the file is the actionable
   half of the sentence.

5. ~~**The cover.**~~ REMOVED, feature and all. The first fix took it
   out of the contents list and left it rendering, which is how the
   user met it again: *"why does the translation still have page 2 of
   the book as the first page of the translation"* — an untranslatable
   image of an English scan at the front of a German book. Ruling:
   *"dont insert the book cover, and dont infer what the book cover
   might be. we'll set the book cover through metadata later. just
   remove the feature that adds book covers since it's apparently
   incorrect most of the time."*

   The word is INFER. The old rule — the first page the book CONTAINS,
   not page 1, because `--skip-pages 1-6` is ordinary — was a good
   guess and still a guess, and a wrong cover looks exactly as
   convincing as a right one. Gone from `packageVlmEpub`, from
   `buildDotsBook` (`DotsCover`, the crop, the report field), from
   `vlm-convert`'s report and log lines, and from `epub-final`'s
   every-run "this book declares NO COVER" warning — that sentence
   advised re-running a feature that no longer exists.

   **KEPT ON PURPOSE:** `epub-final` still *preserves* a cover it finds,
   and its image sweep still refuses to drop one. A book somebody
   imported may have a real cover and that one is theirs. The app's
   contents list keeps excluding a declared cover for the same reason.

   Debt, recorded rather than hidden: deleting the cover tests took
   `epub-final FINDS the cover foundry wrote` with them, which was the
   only exercise of `declaresCover` and of the sweep's keep-the-cover
   rule. Re-covering it needs an EPUB built by hand with a cover in it,
   since nothing in this program writes one any more.

6. ~~**Type sizes in the reflowed book.**~~ FIXED. User: *"everything
   should be a uniform, set size. chapter headers, titles, section
   headers, etc. should all be set to the median size of the blocks in
   the original document so it doesnt all look ridiculous"* — and, on
   scope, *"im more worried about making the text sizes correct in the
   reflowed html and the eventual epub that gets generated"*.

   `typography.ts` already measured a median per category and wrote it
   into the stylesheet once. What it ALSO did was write an inline
   `font-size` on any block measuring more than 25% off its category's
   median, so a paragraph could sit at `1.48em` in the middle of the
   page. That was defended as preserving a printer's emphasis; against
   a rectangle divided by a line count it is at least as often a box
   the model drew generously, and the wrong version is invisible in the
   report and unmistakable on the page. Gone: the outlier pass, the
   `sizes` map, `TypeMeasurement.counted` (which existed only to gate
   it), and `sized()` in the emitter.

   Second half, and it is the one that made headings look worst:
   `h1`/`h2` were the only selectors in the base sheet naming no size,
   so a book with fewer than four Titles fell through to the reading
   system's own 2em/1.5em — a size chosen by nobody, on the loudest
   element in the book. They now state 1.5em and 1.15em, which a
   measured rule still overrides wherever there are enough blocks to
   measure.

   **THE FACSIMILE IS UNTOUCHED**, deliberately: `pdf-text.ts` keeps
   its own per-block sizing because there the type must fit the box it
   came out of. That route is a picture of the page; this one is a book.

7. **Standing on a save, and editing from it.** The user walked the
   whole gesture: *"i removed footnotes. then i hit apply changes. it
   correctly entered it in the ledger. when i click 'applied changes',
   it should pull up the document with the items stricken — it should
   show the footnotes with Xes across them. if i click them and hit
   delete again, it should un-delete them. then i click apply, and it
   becomes a new ledger entry that i can click to and see which changes
   i applied… then, if i run a translate job or an 'export' job or
   anything else from that step position, it will render whatever i do
   WITHOUT the items i excluded."*

   Checked against their own project on disk — import → read →
   `Applied changes (52)`, position on the curate step, per-step cast
   carrying 51 `data-bf-cut` attributes:

   | step of the gesture | state |
   | --- | --- |
   | strike, Apply, a row in the ledger | works |
   | the row's cast keeps the cuts in the file | works |
   | the cuts are VISIBLE on the page | ~~broken~~ FIXED, below |
   | Delete again to un-cut, from that row | **REFUSED** |
   | Apply again → a second row | **REFUSED** (button hidden) |
   | translate/export from there excludes them | works (`curationInEffect`) |

   ~~**The cuts were invisible.**~~ FIXED. `[data-bf-cut]`'s appearance
   lived inside `SELECT_CSS`, which is *"added when the mode opens and
   removed when it closes"* — so fifty-one struck notes drew as
   fifty-one ordinary notes the moment the tool was put down, which is
   exactly the moment somebody clicks the row to go and look at what
   they decided. It is now `CUT_CSS`: injected at load, never removed.
   A cut is not a mode — it is a decision that is in the file — and it
   can never paint over anything a reader was meant to read, because an
   edition removes struck elements outright.

   **THE OTHER TWO ARE A DESIGN QUESTION AND ARE NOT FIXED.** Standing
   on a curate step, the block editor is read-only by construction:
   `editingIsHeld` is `displayedCuration(ledger) !== null`, and
   `shared/curation-lock.ts` argues it at length. The fear is real —
   the pane draws the frozen snapshot while `overlay.save` writes the
   LIVE overlay, so an edit would land in a different set of decisions
   from the ones on screen, and the first you would know is a Generate
   missing your strike.

   What the user is asking for is not "remove the guard", it is CHECK
   OUT: standing on a save and editing should seed the live overlay
   FROM that save and carry on there, after which the pane and the
   edits agree and Apply lands a second row parented to the first.
   Sketch, not a licence to start — the live overlay records which save
   it was checked out from; `displayedCuration` answers the snapshot
   only while live has NOT been checked out from that step; the seed
   happens on the first edit at a save position; the undo ledger and
   `marksEditable` follow. That is a unit of work with a file-format
   field in it, not an inline fix, and it wants the user's ruling on
   what happens to uncommitted live corrections at the moment of
   check-out.

Left standing, and said out loud rather than quietly done:

- **Chapter rename from the inspector still throws** (4b item 3). Not
  touched this sitting.
- **Books already cast carry the old typography**, exactly as they
  carry the old cover. A cast is only remade when something changes;
  deleting the file in `generated/` is what forces it.
- **`docs/REFLOW.md` still says crops exist "for picture and cover
  crops"** in two places. Left as written: it is a completed phase's
  plan, one of the two lines is inside a block quote of an earlier
  spec, and its actual argument — crops are a different job from ink
  sampling — is untouched by any of this.

### Wave 4e — THE ZIP AT THE START (user, 2026-08-15)

The diagnosis the whole endgame turns on, reached by the user asking
the same question three times until the answer was the real one:
*"im still not seeing what's complicating it."*

**The app has no renderer.** Only the engine can turn a bank into a
document, and its only product was a zipped EPUB. So to put a book on
screen the app spawned the engine, took an `.epub`, **unzipped it into
`working/`**, and served the loose XHTML. Once the thing on screen is
FILES rather than a rendering, every edit has to be written into those
files — `setBlockCuts` byte-splices `data-bf-cut="1"` into a start tag
and writes the file back — and every file can drift from the bank.

So one strike was recorded in FOUR places: the attribute in the frame's
DOM, the splice in `working/…/EPUB/text/c0001.xhtml`, an amendment in
`overlays/<key>.json`, and a copy of that in `curations/<uuid>.json` at
Apply. (Verified: the curation snapshot and the live overlay were
byte-identical, 6038 bytes each.) Generations, snapshots, the read-only
lock, `locateOverlay`'s two paths, `epub-final`'s cuts-survive-Save gap
— every one of them is bookkeeping to keep those four agreeing, and
every one exists because of the zip at the start.

The user's ruling: *"we arent supposed to be rendering the book as an
epub. it's supposed to be rendered as an html page… an open,
permanently unzipped html page that's used to display the bank in a
clear, clean, flowing way to the user. the user isnt reading a book on
foundry, they're editing the contents of a book… when the user hits
export, thats when the contents of the bank are compiled into whatever
format they choose."* And on the frame: *"we dont need to worry about
safety measures for epubs because we're the ones that generate the
epubs from pdfs. if the user imports an epub as an original document…
all javascript is stripped from it… then we can use js to generate a
wysiwyg style renderer with angular… fully integrated into the angular
system."*

1. ~~**The engine cannot emit HTML.**~~ DONE, this commit.
   `vlm-convert --format html --out book.html` writes `book.html`,
   `style.css` and `images/` in that folder. One page; each chapter a
   `<section id>`; every `data-bf-*` stamp kept; nothing compressed.
   Proved against the user's own bank: 17 pages, 125 stamped blocks,
   51 notes, the picture rewritten from `../images/` to `images/`.
   `VlmSidecar` is how a packager hands back the files that go beside
   `--out` without the assembler touching a disk.

1b. ~~**The bank is not the book.**~~ DONE. `foundry vlm-book
   --readings <bank> --out <book.jsonl>` runs the reflow ONCE and writes
   it down. User's ruling: *"lets render a facsimile pdf the moment the
   vlm finishes, and then reflow the bank immediately. fix hyphenated
   words, join paragraphs split across pages, etc… merge the bank into a
   single file, merge blocks that were split by pages, and keep page
   numbers as a rough estimate IF WE CAN. give each block a unique ID
   after merging the split ones back together, and make sure we have
   their position on the page."*

   Proved on the real bank: 17 pages → **90 blocks**, 11 of them joined
   across a leaf, 39 reflowed out of print lines, ids unique, no broken
   word left in prose.

   - **Ids are derived, not counted** — `b<page>-<order>` off the first
     banked answer. A sequential number would renumber the whole book the
     day a better join merged one more pair, and every op after that
     point would silently point one block back. A merge consumes the
     SECOND block and leaves the first where it was, so re-running
     changes which ids exist and never what an existing id means.
   - **Pages kept, nothing addressed by them** — *"they just shouldnt be
     trusted."* `page` is where a block started, `pages` is every leaf it
     touches, and identity is `id` alone.
   - **The box survives the merge**, exactly as ruled: first part's
     origin, height the sum, width the union. Verified — a two-page
     paragraph came out 527px tall, the sum of its parts. It is a
     rectangle on no page and is still right about the two things
     anything asks it (type size, column width), because both are ratios.

   - **Notes are rows of their own**, `b<page>-<order>#<ordinal>`, on the
     user's ruling: *"footnotes will always be on the page of the note
     that contains them, and they will always be complete. standard
     publishing practice."* Checked against the book before building:
     16 footnote blocks, 51 notes, not one spanning a leaf. 125 rows in
     all, which is the same count the HTML page carries — the two
     representations agree block for block.
     The footnote area is shared out among its notes **by characters
     rather than by lines**, because the model reflows: a note the
     printer set over three lines arrives as one long line, so a line
     count gives a wrapped note and a one-line note beside it equal
     shares of a rectangle they do not equally fill. Notes are set in
     one size and one column, so characters describe the page.

   **Also not built: the facsimile-first orchestration.** The engine can
   already do it (`vlm-convert --format pdf`); what is missing is the app
   firing it, then `vlm-book`, when a reading lands.

2. **The app renders that page and never writes to it.** NOT STARTED.
   A strike pushes `{at:{page,order,note}, strike}` onto the in-memory
   stack and the frame paints it; nothing touches a file. Apply writes
   the stack to the ledger step and clears it. (Scrap-on-close was
   REVERSED at Wave 29: the stack flushes to a sidecar and survives.)
   Standing on any step = base bank + replay of the chain.

3. **Then the deletions.** `working/` trees, `setBlockCuts` and the
   splicing family, `overlays/*.json`, `curations/*.json`,
   `curation-lock.ts`, the generation reconciliation, the per-step
   EPUBs. This is most of Phase E and it is subtractive.

4. **The renderer itself** — the user's direction is Angular-native
   rather than an iframe of somebody's markup, on the grounds that
   Foundry generates these books and sanitises the one kind it does
   not. Not specced yet; it does not block 2 or 3.

### Wave 4f — THE RENDERER PLAN OF RECORD (user, 2026-08-16)

**`docs/RENDERER.md` is the endgame plan now.** It carries the rulings
(no EPUB as working form; reflow at read landing and the facsimile on
demand — RENDERER §0 A3, amended by the user 2026-08-16, because the
bank is kept unconditionally and is therefore the protection the
automatic reprint used to be; one
book file with minted ids; ops keyed by id; derived book files at
transform commits; no OCR errors; tier-2 structure ops and export
preview as the priorities), the formats, the renderer architecture,
the deletion list, the migration, and execution waves R1–R6.

Progress (RENDERER.md §9 carries the same marks): **R1 landed**
(`8e68348`, book file v2), **R2 landed** (`b3e8351`, the read-only
renderer skeleton), **R1b landed** (`d9c222a`, book file v3 —
provenance, parts, seams, shelf, figures, atomic writes), and the
**v3 mirror landed** (`7f234e4` — app parser to v3, bankSha checked
on open, `--pdf`/`--language` through the ensure step, seams and
shelf and plates on the pane). R2b, R3, R4, R5a–R5d and **R6a**
(`65b150b`, the imported-EPUB explode) all landed since.

**R6 landed in three slices and R6c is the last of them.** R6b took
the casts out whole, collapsed the legacy export branch so every epub
and txt export now materialises and compiles, made the proof sheet the
answer for `curate` and `translate` rows, and built §8's re-key as a
read-time bridge. **R6c is the deletion the wave is named for and it
has landed**: the overlay system, the iframe stack, persisted undo, the
working-TREE lifecycle, the per-step casts' last arms and the PDF block
editor are off the disk, and **the app has ONE editing surface**.
RENDERER.md §7 carries the item-by-item marks, §7a says what an old
project on disk keeps, and §9 records the wave.

Supersessions, so nothing dangles:

- **Wave 5 (Phase E) is absorbed** into RENDERER.md §7/R6 — the same
  retirements, plus the iframe stack and the overlay system whole.
- **Wave 6 (branched-read overlay ping-pong) is SUPERSEDED** — there
  are no overlay files to ping-pong; ops ride the ledger and are keyed
  by block id, so a branch is just a chain.
- **WORKBENCH §11's iframe continuous book** is superseded by the
  Angular-native renderer (marked in R6, not silently).
- Wave 4b item 3 (chapter rename throws) and 4c item 6 residue die
  with the surfaces that host them; they are not fixed, they are
  removed with their bug class. If either surface survives past R6,
  the items come back on this list.
  **Checked at R6b: the surface had not died yet, so 4b item 3 came
  back onto the list. CONFIRMED CLOSED AT R6c.** The item was the
  inspector's Contents rename hunting for a nav anchor through
  `renameEpubHeading` in `epub-reader.ts`. That file is deleted whole,
  the inspector's Contents section is deleted with it, `renameHeading`
  and the two echo questions it raised are gone from the service, main
  and the preload, and the standing answers they stored are out of
  `app-settings.json`'s schema. There is no surface left to host the
  bug and no code left to throw. It is removed with its bug class,
  exactly as this list said it would be — not repaired.

### Wave 5 — ABSORBED into RENDERER.md (kept for the record)

- **Phase E — retire the old surfaces.** The html-editor machinery (dead
  since its buttons went), `history.ts`, **and DERIVED-BOOK phase 0**
  (undo goes in-memory — specced first, executed never; both undo
  persistences retire together), nav-label/page-heading ops moving into
  the ledger, the PDF reduced to view-and-produce-facsimile. Deletes what
  C, D and K replace, so it goes last.

### Wave 6 — CLOSED AT R6c (verified against the code 2026-08-17)

- ~~**The branched-read overlay ping-pong.**~~ Banks went per-step; the
  live overlay did not, so hopping between two read branches archived
  the working corrections back and forth. Scheduled as per-read-branch
  overlay files on the bank scheme — and R6c delivered the same end a
  different way before this was ever started: corrections are RETAINED
  PAYLOADS now, one file per step (`curations/<uuid>.json`,
  `ops/<id8>.jsonl`), so every branch's decisions are keyed to the row
  that made them and there is no live overlay left to ping-pong.
  Verified before starting the work rather than assumed: `overlays/`
  is neither read nor written anywhere (projects.ts names it a legacy
  sibling of the departed system), the archive-on-generation-mismatch
  machinery has no implementation left to find, and the one remaining
  reader is `countAmendments`, which walks the legacy folder so the
  delete card still counts a v1 project's work. Two comments that
  spoke of the machinery as alive were corrected with this closure
  (projects.ts `curationsDir`, workspace.ts `samePath`).

### Wave 7 — the BookForge hosting seam (ruled 2026-08-16, LANDED same cycle)

The user ruled the integration: BookForge hosts the Foundry window;
steps are managed inside it; exports file into BookForge's versions
list; the two stay separate codebases with Foundry copied in nearly
verbatim. The design lives in docs/BOOKFORGE-HANDOFF.md §8, the letter
of the contract in its `#foundrynotes`. All five obligations landed:

- **The mount seam** — `app/electron/mount.ts`
  (`mountFoundry`/`openFoundryWindow`/`stopFoundry`), with main.ts
  reduced to the standalone shell over the same calls; the factoring
  put the IPC doors in `ipc.ts`, the window in `window.ts`, the open
  door in `documents.ts`, the who-mounted-us record in `host.ts`.
- **The export-landed hook** — `job-queue.onExportLanded`, fired after
  `final/` has the file and the tray recorded it; the host's throw is
  caught.
- **Deep-link** — `openFoundryWindow(dir)` pushes `project:open`,
  consumed in App by the same `openProject` Home's row click uses.
- **Settings partition** — the host's `libraryDir` wins inside
  `readAppSettings` itself; `library:set`/`library:choose` refuse
  hosted; the renderer hides Home (dock + the library list on the Home
  page — the hero's drop target stays for the Import-via-Foundry door)
  and the settings library card behind `hosted()`
  (`core/foundry.ts`).
- **The channel audit** — `docs/IPC-CHANNELS.md`, generated from
  source; BookForge's keeper test reads it as the authority. Verdict
  from their side: zero full-name collisions, no prefix on either
  side.

### Wave 8 — one viewer, no tabs (ruled 2026-08-17)

The user ruled out the tab system entirely: *"i dont think we should have
tabs in foundry. i think its making things a bit confusing. however, the
user should be able to compare two steps sometimes. so i think the
solution is to have a single viewer window/single tab, and if the user
wants to compare two steps, theres a compare button they can click and
then they can choose the step to compare."* This REVERSES the strips'
return (the reversal-of-the-reversal; TabsService's header carries the
first one) and RETIRES the pane model with them — the panes' founding
comparison, a translation beside its source, has lived inside
app-book-view as the Aligned pair since §5 landed, so the columns no
longer earn their machinery. One selection was already the position
(WORKBENCH.md §6c); after this wave there is one viewer obeying it.

- **8a — the head off the paper. LANDED (this commit).** The
  `Workbench | Final version` register was `position: sticky` inside the
  bench scroller, so the words scrolled UNDER the buttons (user: *"the
  workspace/final version buttons at the top cover the file when i
  scroll down"*). The head now stands in a row of the host's column
  ABOVE the pair; the book scrolls in its own box below. The bottom
  tray (Apply) keeps its sticky edge on purpose — a verb rides the
  scroll, a register holds still.
- **8b — the single viewer. LANDED (this commit).** Delete panes, strips, pin, drag-split,
  dividers, the drag shield, `MAX_PANES`, `focusPaneAt`/Ctrl+1–5, the
  `split-right` menu item (electron/main.ts + shared/api.ts + app.ts)
  and the `expectOwnPane`/`expectPane`/`expectReplace` bookkeeping —
  with one viewer, replace-what-is-showing is the only behaviour and
  needs no flags. KEEP: the flat tab list and its state (modified,
  savedPath, revision, thumbnails, layerView), the documents list as
  navigator (`reorder` included), `heldProject`/`goHome`/
  `releaseProject`, Ctrl+Tab cycling the flat list, the auto-open of
  finished jobs (now: activate in THE viewer), and every closing/saving
  question. `active` becomes one signal; Home is `active === null`.
- **8c — the service split. LANDED (this commit).** One deliberate
  amendment to the shape below: the RAW pointer signal lives in
  `OpenDocumentsService` (every door that opens a document ends by
  showing it, and four of the five doors are IPC- or effect-driven with
  no caller to hoist to), while its MEANING — `active` as a computed
  validated against the list on read — lives in `StageService` exactly
  as specified, so the arrow still runs one way. Undo/redo take the tab
  as an argument for the same reason. Dead orphans of the iframe-editor
  world went with the split (`SourceJump`, `FrameSelection`,
  `CategoryCounts`, `bucket`). `TabsService` (3.4k lines, ~14 injection
  sites) breaks along its real seams AFTER 8b shrinks it:
  `NoticeService` (the strip's sentence — half the dialogs inject the
  whole service for this one signal); `OpenDocumentsService` (the flat
  list, identity, naming, flags, adopt/relocate, opening doors,
  closing/saving + `pendingFlush`); `StageService` (what is on screen:
  the active pointer as a `computed` that falls back to null when the
  list loses it — so close never has to reach into the stage;
  `heldProject`; later the compare state); `PositionSyncService` (the
  three constructor effects, `showPosition`/`followDocuments`/
  `standForTab`/`documentShown` — depends on all three above plus
  ledger/projects, nothing depends on it); `BookStacksService` (the
  `BookStack` registry, park/claim, undo/redo routing). Dependencies
  run one way: Notice ← Documents ← Stage ← PositionSync.
- **8d — Compare. LANDED (this commit), closing the wave.** Two
  channels added (`book:load-at`, `ledger:document-at-step`),
  IPC-CHANNELS.md regenerated (66 → 68, keeper-shape verified against
  source). Every clearing rule is a computed on the stage, not a
  callback: live document closed, project changed, compared step
  deleted. One decision to revisit if the user asks: the compare column
  renders the FINISHED-BOOK projection (the `viewOnly` register), so a
  compared edit step shows as its edition, not its workbench — chosen
  over threading register state between columns. A Compare button on the single viewer opens a step
  picker (the ledger's own rows, the app's scrim+menu idiom); picking
  one splits the workspace into the live position-driven viewer beside
  a READ-ONLY viewer locked to the chosen step, ✕ to leave, state
  session-only. Main grows step-addressed reads beside the
  position-addressed ones: `book:load-at(projectDir, stepId)` (replay
  as of that step; refactor of `openBookAtPosition`'s position→row
  resolution) and a step-addressed document resolve for pdf steps. The
  book side reuses the `viewOnly` projection the export view already
  is; scroll-locking the two columns is deferred out loud (the aligned
  pair's machinery exists if it is ever asked for).

- **8e — chapter markers at the hand (ruled 2026-08-17, LANDED
  `7d34935`).** Same sitting, separate ruling: *"give me the ability
  to delete a chapter marker inline. the green dotted line can have an
  X next to the text. and give me the abiltiy to right-click a block
  and hit 'add chapter marker', and itll add a chapter break above
  that block."* Both gestures push the ops the Chapters panel already
  speaks (`{op:'chapter', set/remove}`, title seeded from the block's
  first line exactly as `makeSheetChapter` seeds it), so undo, Apply
  and the panel agree about them for free. The ✕ rides the chip on the
  rule, hover-revealed; the menu item hides where a division already
  starts (a \`set\` there would retitle under a label that says add).

**The BookForge constraint, binding on every unit above.** Foundry's
`app/` is vendored WHOLESALE into BookForge (`foundry-app/`, a sealed
snapshot laid down by `git archive` at a named commit, hash-verified;
never hand-edited on that side; `VENDORED.md` records the commit).
So the whole wave must stay inside `app/`; the mount seam
(`app/electron/mount.ts`, `host.ts`) keeps its contract; every
`hosted()` behaviour survives 8b (running out of documents closes the
hosted window); 8b adds/removes/renames NO IPC channel; whatever
channels 8d adds regenerate `docs/IPC-CHANNELS.md` in the landing
commit so BookForge's keeper test stays green. After a unit lands and
pushes, propagation is a STEP, not automatic: tell a BookForge session
"re-vendor foundry".

### Wave 9 — host-ops round 2 — LANDED (this commit)
### (BookForge channel, 2026-08-17; Owen's rulings from first real use)

The inbound section headed "2026-08-18 — host-ops round 2" (so dated by
both harnesses' clock skew that evening; the real date is 2026-08-17) of
C:\tmp\bookforge-to-foundry.md is the letter of the ask. Four items, all
additive, socket shape survives. BookForge is vendored at `6925d21` and
re-vendors after this lands; if `invoke`'s signature changes it must be
announced loudly on the outbound channel and in #foundrynotes.

- **9a — `stepId` on ExportLanding and on `final[]`.** The landing
  carries the ledger step the export replayed to; `final[]` rows in
  project.json record it so the host's sweep can read it for landings
  it missed; the tree's export rows learn their parent step. Backward
  compatible: absent stepId = unique-export-or-refuse, exactly today.
  ExportLanding's docblock currently argues "no step, no ledger" — the
  reversal is recorded there in BookForge's words, not papered over.
- **9b — host operations offered from EXPORT rows.** The export row IS
  the file narration consumes; `offeredFrom` runs for export rows with
  `appliesTo: 'book'` ops appearing there, invoke carrying the precise
  target 9a makes possible.
- **9c — the in-window operation dialog + rail button.**
  `HostOperationOffer` grows optional `form?: HostOpField[]` (select /
  number / toggle / text, options, default, min/max, help);
  Foundry renders a generic dialog from it in the translate dialog's
  visual language; `invoke(projectDir, nodeId, settings)` gains the
  answers. An op without `form` invokes immediately, exactly today.
  The nav rail offers hosted ops with forms against the current book's
  export target (per 9a/9b rules) — host-agnostic: no Foundry surface
  says "narrate".
- **9d — NOT WANTED, recorded so nobody builds it:** no queue tray in
  the Foundry window. Tree state via setHostNodes is the whole of it.
- **9e — failed host nodes (the same-day addendum).** A failed narrate
  card offered "from here: Enhance / Assemble" — chaining onto audio
  that was never produced — and no way out of the window Owen stood
  in. Two rules: a node whose state is failed or cancelled offers NO
  chaining ops (display logic, no contract); failed nodes offer
  `Retry` and `Dismiss` instead, as a fixed pair — the contract shape
  is ours and is: `FoundryHost.onNodeAction?(projectDir, nodeId,
  action: 'retry' | 'dismiss')`, invoked over a new
  `host-ops:node-action` handle on invoke's own error-travel rule (a
  rejection is said where the button was). The buttons render only
  when the host registered the callback — a button that silently does
  nothing is the socket's one forbidden outcome.

### Wave 10 — only the possible is offered — LANDED (this commit)
### (Owen's ruling, 2026-08-17 20:30, via the bridge)

Owen, after using the tree on a project with no export: *"just put
'export EPUB' as the only option on things that aren't capable of
narration or whatever. The only options that exist are the ones that
are possible for that stage."* A button whose only possible outcome is
a refusal is not drawn. Two halves:

- **10a — `NodeOutput` grows `'export'`.** Export rows produce it;
  ledger steps never do; an op with `appliesTo: 'export'` is therefore
  offered ONLY on export rows. Two-member hosts (`'book' | 'audio'`)
  keep working unchanged — their `'book'` ops keep landing on steps.
  The rail's formed-op gate accepts `'book' | 'export'`. BookForge
  moves narrate onto the new member at its next re-vendor; the member
  is grown in the same commit as everything that understands it, per
  the union's own doc rule.
- **10c — the two rulings minutes after 10a shipped (LANDED, the
  commit after 10a/10b's).** (1) The export-row footer was RIGHT in
  rule and unreachable in gesture — `pickRow` cleared the selection for
  every file row on a premise 10a had just made false, so narrate's one
  correct home never drew its footer (Owen: *"theres no narration step
  available to press under the epub i generated"*; BookForge traced it
  to the line). An export row takes the selection now, alongside
  everything its click already did; a copy still clears. Also: only the
  EPUB export row produces `'export'` — a txt or reprint offering a
  file-consuming act could only refuse. (2) The rail's host acts GRAY
  when the project has no EPUB export (Owen: *"if the step the user has
  selected cant run tts then its grayed out"*), on a new
  `hasEpubExport` predicate in stages.ts — the same function the press
  refuses by, and the press's target now counts only EPUBs so a txt in
  the tray cannot cause a false ambiguity refusal.
- **10b — Foundry's own offers obey the same rule.** Translate,
  Simplify, Export and the rest are drawn on a stage only where the
  act is POSSIBLE from that stage — and each offer's possibility test
  must be the same predicate the act itself checks on invocation (one
  function per act, so the button and the refusal can never disagree
  about what a stage can do).

### Wave 11 — six rulings from the first real narrate (Owen, 2026-08-17 22:30, via the bridge) — LANDED (`e8396b4`)

The inbound section is the letter; his numbering kept. No lockstep with
BookForge needed; partial landings fine; say the sha per subset.

- **11a** — the export row's footer drops the "from here" label — just
  the button. Steps keep the label (things are made FROM them).
- **11b** — `HostOperationOffer.submitLabel?: string`; the dialog's
  submit says it when declared ("Add to queue"), keeps today's default
  when absent. Only the host knows whether an invoke runs now or files
  work. Payload-section row in IPC-CHANNELS.md.
- **11c** — the export row's press sends a nodeId that names the EXPORT
  ROW (spelling ours, documented, told to BookForge), and host nodes
  whose `parentStepId` names an export draw as children of that export
  row. Step-named parents keep working. BookForge echoes parentStepId
  verbatim already; their invoke's unique-epub fallback covers
  resolution — confirmed on the bridge before relying on it.
- **11d** — the EPUB export row nests under its `madeFrom` step. Owen
  overrules the tray doctrine ("records what was made, never the
  position") — lineage is drawn. A null-`madeFrom` export keeps its
  current home under the book, said out loud where the code decides.
- **11e** — the sidebar widens again, slightly (346 → ~384).
- **11f** — the rail's buttons move INTO the left sidebar, pinned to
  its bottom; the tree pins to the top and scrolls in the space above
  them. The bottom dock row goes; the collapsed sidebar's stub keeps a
  way to reopen; what the stub shows of the buttons is the builder's
  call, said in the report.

### Wave 12 — the action menu (Owen, 2026-08-18 01:05, via the bridge) — LANDED (this commit)

Owen, on seeing Wave 11's dock in the sidebar, verbatim: *"instead of
clustering the buttons on the bottom left like that, lets make an ordered
list of actions for the user. no longer a nav rail, now its an action
menu. [icon] [action], one after another."*

- Vertical rows, one action per row, icon then the action's name in
  words, in a deliberate order — the pipeline's own reading order is the
  obvious spelling (read, then the acts that consume the words, then the
  host's audio work), but the order is the builder's to pick and state.
  **Landed as three groups divided by rules:** Home and Documents
  (navigation, above the first rule); then Read the pages, Translate,
  Simplify, Export, Metadata and the host's acts (the pipeline in the
  order it runs — Export moved down from beside OCR, because exporting
  before translating exports the wrong book, and Metadata is last of
  ours because it is a record ABOUT the book rather than a step in
  making one); then Settings below a rule of its own, unchanged, on the
  reason it always had — it is not a tool.
- **Renamed with the geometry**, because *"no longer a nav rail, now
  its an action menu"* is a naming ruling too: `ActionMenuComponent`,
  `app-action-menu`, `action-menu.component.ts`, and the CSS
  vocabulary inside it (`.menu`, `.menu-item`, `.menu-icon`,
  `.menu-label`) renamed with it. Button LABELS are untouched — the
  ruling is about arrangement and the component's name, and renaming
  "OCR" would be a second opinion nobody asked for.
- The graying ruling stands unchanged: a row whose stage cannot run it
  is present and disabled, never hidden.
- Everything else about the sidebar stands as landed: tree pinned top,
  menu pinned bottom, tree scrolls in the space above.
- Nothing moves on BookForge's side; they re-vendor at the sha.

### Wave 13 — narrate from any step (Owen, 2026-08-18, via the bridge) — LANDED (this commit)

Owen, on finding the host's acts offered only where a file already
existed, verbatim: *"i dont think its intuitive to know you have to
create an epub before you can narrate. i think we should make any of the
steps possible to narrate. if they arent doing it from an epub then we
export the epub automatically and then run the task they assigned."*

Wave 10 taught the socket to say "this act consumes the finished FILE",
which was the right spelling of the wrong premise: it put narrate where
the file was rather than where the person was. This wave keeps the
spelling and removes the premise — an act may now say it consumes BOTH,
and Foundry will make the export when the step it was ordered from has
none. Foundry's half only; the host's half is built against it.

- **13a — `HostOperationOffer.appliesTo` accepts a list.**
  `NodeOutput | readonly NodeOutput[]`, read through one test in
  `offeredFrom` (shared/host-ops.ts), so a host declaring a single value
  behaves byte for byte as it did. A host that wants an act on both the
  steps and the export rows declares `['book', 'export']` and the tree
  offers it in both places with no special case anywhere. Payload-section
  row in IPC-CHANNELS.md; the contract is spelled in the handoff's
  `#foundrynotes`.
- **13b — the mount seam grows `exportEpubFromStep(projectDir, stepId)`.**
  The export dialog's own path with nobody in front of it: same
  `planExport`, same request shape, same queue, same `final/` name, same
  rotation, same tray row, same landing — because an export made for a
  host must be indistinguishable from one somebody pressed for. It
  resolves with the `ExportLanding` (re-exported from mount.ts for the
  host to type) and rejects with main's own sentences when the plan
  refuses or the run files nothing.
- **13c — the queue publishes a settle.** `onJobSettled` — many
  listeners, each unsubscribing — because a job that FAILS announces
  nothing and an unattended export cannot wait forever for a landing that
  is not coming. It fires LAST, after whatever the settle produced, so a
  waiter sees the landing before it hears the ending; a row somebody
  removes from the shelf counts as one, since for a waiter it is the only
  ending it will get. No polling.
- **13d — the render-from step and the facsimile key come apart.**
  `planRendering` read one parameter as both "render from this row" and
  "name the file after this row", which is true of a facsimile and false
  of an export ordered from a step — that export is still the BOOK's and
  keeps its `final/<stem>.epub` name (and the `(hu)` arm, resolved from
  the passed step rather than from the pointer). `materializeBook` takes
  the step too, which `openBookAtPosition` always could.
- **13e — the action menu greys on the STAGE, not on the tray.**
  `canRunHostActFrom` (shared/stages.ts) — `hasBookAt` by name, the same
  test Export greys by, read by the gray AND by the press, per that
  module's one rule. An act consuming the book sends the standing step's
  own id (the id the tree row would send); an act consuming only the
  export keeps one-export-or-refuse, which is reachable again now that
  the gray no longer counts exports. `hasEpubExport` stays, meaning what
  it says and nothing more.

### Wave 14 — the host's acts move up, and the host gets a chip (Owen, 2026-08-18) — LANDED (this commit)

Two rulings, one about where an act sits and one about what a hosted
window owes the application around it.

- **14a — the host's acts sit next to Translate and Simplify.** Owen,
  verbatim: *"there should be a narration button in the options sidebar
  menu, right next to translate and simplify. it makes sense for it to be
  there."* They were LAST among the acts, argued from run order — audio
  is made from the export, so it came after the export. That is true of
  the pipeline and turned out not to be true of the MENU: a list is
  searched rather than stepped through, and what a person searching holds
  in mind is what the act is aimed at. Translate, Simplify and a
  narration all take the book in front of you and make another version of
  it; Export files what is there and Metadata edits a claim about it. So
  the acts read Read → Translate → Simplify → the host's → Export →
  Metadata, and run order still decides everything else. **Graying,
  pressing and the ids sent are untouched** — one group moved position,
  nothing changed behaviour, and the docblock now argues Owen's grouping
  rather than a sequence it had stopped describing.
- **14b — a HOST STATUS CHIP in the window's chrome.** The host runs a
  queue Foundry knows nothing about; in the host's own windows its state
  is in the top corner, and in this window it was invisible, so somebody
  editing a book here had to go and find another window to learn whether
  the work they ordered was moving. The chip is that corner, lent out:
  `setHostStatus(status | null)` on the mount seam, pushed on
  `host-ops:status-changed`, seeded from `host-ops:status`, drawn as the
  first row of the shell above the body and pinned right.
  **Domain-blind by construction** — a headline, an optional second line,
  an optional percent and an optional pending count (`HostStatus`,
  shared/host-ops.ts), all the host's own words, drawn verbatim and read
  by this app for length and nothing else. There is no word about queues,
  narration or books anywhere in the component.
  **Conditional by construction** — null (standalone always, and hosted
  until the host speaks) is `display: none` on the chip's own host
  element, padding included, so a window nobody mounted is unchanged in
  every pixel and there is no "am I hosted" branch anywhere.
- **14c — the click is optional and its absence is drawn.**
  `FoundryHost.onStatusOpen?: () => void` — registering it makes the chip
  a `<button>` with cursor, hover and focus ring; leaving it out makes the
  chip a readout that plainly cannot be pressed. Two elements rather than
  one with its affordances switched off, on the socket's standing rule
  that a button which silently does nothing is the one forbidden outcome.
  The probe rides on the `host-ops:status` answer (`openable`) for
  `host-ops:offers`' reason: same question, same round trip, no extra name
  for BookForge's keeper to audit.
- **14d — docs.** Three rows added to IPC-CHANNELS.md (two doors, one
  push; counts 69→71 and 12→13 pushes, 6→7 broadcasts) and a payload
  section for `HostStatus`; the contract, the host's obligations and the
  `onStatusOpen` semantics are in the handoff's `#foundrynotes`.
- Nothing moves on BookForge's side until they want the chip; they
  re-vendor at the sha and call `setHostStatus` when they do.

### Wave 15 — narrate is available where the user clicks (Owen, 2026-08-18, via the switchboard) — LANDED (this commit)

Owen, using the hosted window: *"the narrate button in the bottom left of
the foundry window is disappearing and disabling seemingly at random. it
should be available pretty much anywhere the user clicks, but if theres no
epub already minted, it mints an epub from that position and then queues
the narration."*

Three causes, enumerated from source by bookforge-pc-2 and re-verified
here. The DISAPPEARING half was theirs and is fixed (bookforge
`577a70db`: an un-awaited narrate-form refresh raced our constructor's one
and only `host-ops:offers` ask). The two below are ours.

- **15a — the import row stops greying a host act, and a press there
  names the reading.** `canRunHostActFrom` delegates to `hasBookAt`, which
  refuses `standing.action === 'import'`; clicking the top row of the tree
  is an ordinary thing to do, so from the chair that IS "disabling at
  random". The refusal's own reasoning (WORKBENCH §6c — stepping back PAST
  a reading, to act on the untouched scan) is about acts that DERIVE from
  the position, and a host act does not: its position names provenance and
  what to export, and the import row's book is the reading's book. So the
  clause goes for host acts only — Foundry's own acts keep it — and a press
  from the import row sends the READING's step id, because
  `exportEpubFromStep` will be asked for that position and `canExportFrom`
  refuses the import. An UNREAD scan stays greyed: no bank, no book,
  nothing to mint from, and Read is already the act offered there.
- **15b — offers can be revised: a `host-ops:offers-changed` push.**
  `HostOpsService` asks `host-ops:offers` exactly once, in its constructor,
  and nothing can revise the answer — so a host whose form legitimately
  changes while the window is up (voices installed since, settings changed
  since) cannot publish it. bookforge-pc-2 asked for the push in preference
  to a re-ask, and they are right: it is the problem `setHostStatus` solved
  for the chip, one surface along, and the pattern to copy is directly
  below the ask in the same file. A PUSH, so the handle count stays 71 and
  the push table grows.
- **15c — what the build settled, since both units forced a choice.** The gray
  and the id are now TWO questions: `canRunHostActFrom(project)` takes no step
  at all (on `canReadPages`' precedent — once the import clause goes, nothing
  left in it reads a position), and `hostActPositionFrom(ledger, standing)`
  beside it answers what a press names. Its third answer is a REFUSAL: a scan
  whose bank exists but whose ledger holds no `read` step — real, because
  `summarise` accepts the engine's own completion marker, so a bank filled from
  a terminal makes `reading.done` true with nothing in the history to name — is
  told to press the step it means rather than handed an id whose export would
  decline. The tree's press was wired to the same resolver though it cannot
  reach that answer today (a root row offers host acts only where the import IS
  the book, and such an import names itself); one rule, two sites, not two
  versions. The mount seam is `setHostOperations`, named for `hostOperations`
  on `FoundryHost` and shaped like `setHostNodes`/`setHostStatus`, and both the
  ask and the push are one expression in main (`hostOffers`) so they cannot
  drift. IPC-CHANNELS.md regenerated from source: **71 handles, unchanged**;
  pushes 13→14 and broadcasts 7→8.

### Wave 16 — the queue centralizes in BookForge (Owen, 2026-08-18, via the switchboard) — LANDED (this commit)

Owen, verbatim: *"we need to centralize the queue in bookforge. foundry
has their own queue but things shouldnt be queued in foundry's queue from
within bookforge. we need to centralize the queue."*

STANDALONE FOUNDRY IS UNTOUCHED BY ALL OF IT. This is the hosted window
only, and the compatibility posture is `appliesTo`'s: a host that has not
moved gets exactly today's behaviour.

WHY IT IS URGENT RATHER THAN TIDY: BookForge's engine schedules on a
declared `gpu` resource and Foundry's pump is a second scheduler that
knows nothing about it, so a Foundry read and a BookForge narration can
both hold the 4090. One machine's GPU needs one owner.

THE SPLIT: they decide WHEN, we still do the WORK. Their queue never
reimplements the ledger writes, the bank, the rotations or the export
landings — two copies of that bookkeeping is how the two apps start
disagreeing about what a book is.

- **16a — `runJob(request, {parentStep, onProgress, signal})`.** Execute
  ONE job now, no waiting. It still MINTS A Job ROW and still fires
  `onJobSettled` / `onExportLanded`: those listeners are what
  `exportEpubFromStep` awaits and what the host's node reconciliation
  reads, so a runJob that bypassed the row would break the host's own
  narrate. What disappears in hosted mode is the WAITING — a row is born
  running.
- **16b — `hostQueue` on `mountFoundry`, and the routing switch.**
  Present: `enqueue` mints no local row and returns the host's.
  Absent: everything is exactly as today. `cancel`, `remove`, `start`,
  `clearFinished` forward. **Only what a PERSON PRESSED in the hosted
  window routes** — work the host itself ordered through the mount seam
  (`exportEpubFromStep`) stays on the internal path, because by calling
  us the host has already made the scheduling decision. That line is what
  keeps their scheduler from being re-entered while inside a call it is
  awaiting.
- **16c — `setHostQueueRows` and the mirrored shelf.** The hosted shelf
  draws the HOST's rows for the whole machine, never a second list that
  can disagree. The shelf mirrors one global list across projects, so the
  push carries an empty list once on the falling edge (a project that
  loses its last row) — the one piece of news the mirror cannot infer.
- **16d — `hostQueueDrained()`, and drain stops being ours to derive.**
  The reading server's lifetime hangs off queue drain
  (`noteQueueIdle`/`noteQueueBusy`), and `keepServerWarmMinutes` DEFAULTS
  TO 0, which stops the server outright rather than arming a timer. Under
  `hostQueue` the local list is empty after every job, so deriving drain
  from it would tear the server down between every pair of the host's
  rows. The host says when its queue has drained of Foundry work, after
  its pump has chosen; busy stays ours, because every job start already
  says so.
- **16e — env installs stay ours.** They are a precondition of the engine
  running at all, not GPU work, and routing them through a host queue
  would deadlock the first install behind a job that needs it.
- **16f — what the build settled, since every unit forced a choice.**
  - **The pump split in two along the line it already had.** `pump()` is the
    SCHEDULER (the serial slot, the hold, the drain) and `executeJob()` is
    everything that used to happen after a row was chosen — one body, two
    callers, no host test anywhere inside it. The two things the callers
    genuinely differ about are an interface of two members plus an optional
    third (`RunWires`: `claim` the live child, `release` it, and `watch` the
    lines): the pump claims into its serial slot, `runJob` claims into a
    `detachedRuns` registry beside it. Every `void pump()` that used to sit at
    the end of a landing arm is now ONE call in the scheduler, which is what
    makes the executor reusable and is why the arms read shorter.
  - **A run ordered by the host is OUTSIDE the serial slot, deliberately.** It
    must not wait for the slot (the host said now, and a `runJob` that queued
    behind Foundry's own work would hang the host's pump on a list it cannot
    see) and it must not hold it (a host awaiting `exportEpubFromStep` while a
    three-hour reading held the slot would be waiting for that reading — a
    deadlock built from two correct-looking rules). `shutdown` stops both kinds
    of child; `cancelHere` looks in both places.
  - **Routed versus internal is a DOOR, not a flag.** `enqueue` routes and
    `enqueueHere` never does; `cancel` routes and `cancelHere` never does;
    `enqueueEnvInstall` and `runJob` have no routed twin at all. The internal
    doors exist exactly where there is an internal caller, and the one that
    proves the pattern is `cancelEnvInstalls`, which would otherwise have sent
    one of OUR ids into the host's list while the download went on running.
    Nothing beneath the doors asks the question — `hostQueue()` appears in the
    six gestures, the drain and the two mirror functions, and nowhere else.
  - **`runJob` resolves with the settled `Job` row** (the lead's mid-build
    correction, taken as given and argued in the docblock): a result type
    cannot say CANCELLED, and a cancel filed as a failure is how a retry
    restarts work somebody just stopped.
  - **Drain: the local signal is kept AND guarded.** `pump()`'s idle branch
    still declares drain for the internal path, and `runJob` deliberately does
    NOT pump when it ends — if it did, that branch would be reached between
    every pair of the host's rows and stop the server after each one, which is
    the whole hazard 16d names. The one remaining crossing (an env install
    finishing while a host READING posts pages) is closed by a guard: a live
    detached run holds the drain, because `noteQueueIdle(0)` is an immediate
    stop with no window for a busy signal to beat.
  - **The mirror is one function, `shelfJobs()`** — the host's accumulated rows
    where a host queue is registered, `listJobs()` otherwise — and both the
    `queue:list` door and the `queue:changed` push are that one expression, on
    `hostOffers`' rule. `listJobs()` stays OURS and is what `foundryBusy` and
    the delete guards read, so a host-ordered run still refuses a project
    delete. **The first paint rides on `host-ops:nodes`** rather than arriving
    as a new door: it is the only moment main learns which project a window is
    drawing, and no channel moved (71 handles, 14 pushes, counted from source).
  - **`clearFinished` forwards AND sweeps our own list.** Hosted there are two
    lists and only one is visible; every `runJob` row lives in ours, and a press
    that cleared only what was on screen would leave the invisible half growing
    for the life of the process.
  - **The dedupe moves to the host with the scheduling, and is written into the
    handoff as an obligation.** `enqueueHere` still refuses two live rows
    writing one file; routed, that check never runs, and `runJob` deliberately
    does not re-impose it (answering a scheduler's decision with somebody else's
    row would be overruling a decision we were told about rather than asked
    for). The guard is available in one line inside `runJob` — `pendingFor` over
    our own list would catch two concurrent runs on one output — if BookForge
    would rather Foundry kept it.
  - **Two things reported rather than quietly fixed**, neither touched: (1) the
    READ landing arm has never called `settled()` — a reading has always ended
    without publishing a settle, which predates this wave; `runJob` answers with
    its own row and does not depend on it, but a host waiting on `onJobSettled`
    for a reading would wait forever. (2) Hosted with a host queue, an ENV
    INSTALL row is invisible in the shelf and in the settings card's
    `busy`/failure display, because the mirror draws the host's rows and never a
    merge — the progress bar itself still works (`env:install-progress` is its
    own push) and `env:cancel` still stops it. The one-line change if the ruling
    ever softens is a union of the host's rows with our `env-install` rows,
    which cannot double-count because an install never routes.

DEFERRED OUT LOUD: the queue has no persistence — no state file, no
restore path — so an app restart drops a held read silently and a read is
hours. Centralizing makes the host's persisted engine the store for
hosted work; standalone Foundry still wants it, as its own later wave,
because building a store here now is building one we are about to stop
using for the hosted case.

### Wave 17 — three defects from Owen's live run (2026-08-19, via the switchboard) — LANDED (this commit)

All three surfaced while Owen used the hosted window for real, and all
three were diagnosed jointly on the channel. Fences are disjoint.

- **17a — TWO REFLOWS CAN RUN AT ONCE, AND THEY DELETE EACH OTHER'S
  FIGURES.** `writeBookFile` has two unserialised callers for one target
  path: `job-queue.ts` (`remakeBookFile`, when a read lands) and
  `book.ts` (`ensureReadingBook`, when a book is opened, guarded only by
  a check-then-act `exists`). Owen hit it: the queue's reflow was cutting
  crops into `readings/<key>.images/` when the window asked for the book,
  the second engine cleared that directory mid-write
  (`book-run.ts:361`), and Windows raised EBUSY on a file the first
  process still held. **The lock was ours, not SMB's** — which is why a
  retry ladder alone would have hidden a data race rather than fixed it.
  Confirmed from the log tags in Owen's paste: `[job]` announced the
  reflow, `[book]` raised the error. No figures were lost that time (16
  referenced, 16 present); with different timing they would have been,
  silently. THE FIX IS SERIALISATION AT THE CHOKEPOINT: one in-flight
  promise per folded target path inside `writeBookFile` itself, so a
  second caller awaits the first's result instead of spawning a rival
  engine. Retry on EBUSY/EPERM/EACCES stays as DEFENCE IN DEPTH for a
  genuine external lock, labelled as such. And the refusal stops lying:
  a failure while a book file exists must not say the book could not be
  made.
  DEFERRED OUT LOUD: per-file deletion with freshness by name. It was
  designed on the channel when SMB timing was believed to be the cause;
  with the race removed the retry covers what is left, and it is not
  worth the complexity until something proves otherwise.
- **17b — struck PICTURES show no X.** The strike mark is two diagonal
  gradients as `background-image` on `.body`, which paints BEHIND
  content. Prose works because glyphs cover a few percent of the box; an
  opaque plate covers all of it. The other two halves of the treatment
  land (the plate dims, the caption strikes), so the block changes state
  while the one mark that says *struck* is hidden. Fix it for Pictures
  without disturbing prose, where the background approach is right and
  deliberate.
- **17c — hosted, an env-install row is invisible in the shelf.**
  BookForge asked for the union (their words: *"an install is real work
  with real progress and the shelf is the window's answer to what is
  this machine doing"*). It cannot double-count: env installs never
  route, so the two lists are disjoint by construction.
- **17d — what the build settled**, since each unit forced a choice.
  - **The gate covers `writeEpubBook` too, and that is the fix rather than an
    extension of it.** `ensureReadingBook`'s check-then-act guards BOTH its
    branches, so two windows opening one imported-EPUB project race exactly as
    two reflows did; `viewExportedBook` has the same shape over a temp cache.
    Leaving the sibling ungated would have left the fixed hazard reachable
    through the same door. The key is the OUT PATH — the contended resource —
    so both commands share one map, and a project is never both a bank and a
    container.
  - **The timeout stays INSIDE the gated run.** A caller waiting on somebody
    else's engine is not being timed out at two minutes into its own wait; it
    rides a run that has its own two minutes.
  - **A refusal with a book on the disk OPENS THAT BOOK** rather than trading
    one wrong sentence for another. There is no channel from `ensureReadingBook`
    for an "ok, but" — so the news goes to the terminal beside the engine's own
    words, which is exactly `remakeBookFile`'s posture for the same event on the
    other side of the wall. It is safe because the loader hashes the receipt and
    refuses any book whose `bankSha` has moved, by name, a few lines later: a
    stale file gets that accurate refusal, a current one gets drawn.
    DEFERRED OUT LOUD: the EPUB-explode branch of the same function keeps its
    old sentence. It has the identical shape and would want the identical three
    lines; it is not the branch Owen hit and it is a copy change with no
    correctness driver in this wave, so it is named here rather than folded in.
  - **The X on a plate is a pseudo-element over the figure, and prose did not
    move.** `figure` is the Picture case's own element and appears nowhere else
    in the template, so the selector is the condition — no class through the
    switch, no `:has()` to find one. Three things were carried across by name:
    the `background-size` pair (the overlay exists always and is 0%×0% unstruck,
    or the mark pops instead of growing), the blend (`.body` is already an
    isolation group twice over — `content-visibility: auto` implies paint
    containment and a struck body is at `opacity: .45` — so the multiply lands
    on the plate and the composite then fades over the paper), and the
    reduced-motion list, which covers selectors by name and now names this one.
    The body's own paint is turned OFF under a figure, or a narrow plate would
    carry two marks at two sizes and an uncut plate would carry both in full.
    The mark is stated once as `--strike-x` so the two carriers cannot drift.
    NAMED COST: multiply darkens and cannot lighten, so across a near-black
    region of a plate the X approaches invisibility; the alternative reads as a
    sticker on every ordinary plate to buy back the rare one, and the dim and
    the struck caption carry the state there. THE DARK THEME IS NOT A FACTOR:
    the sheet's palette is fixed light and the only themed token is `--bench`,
    the ground behind the paper, which no mark ever blends against.
  - **Drawing a row made its ✕ reachable, so `cancel` and `remove` stopped
    routing an install.** `remove`'s docblock asserted that every id off a
    hosted shelf came from the host; 17c makes that false. The test is the KIND
    and not "is it in our list", because our list also holds the rows `runJob`
    mints for work the host scheduled and those cancels are the host's. This is
    `cancelEnvInstalls`' existing rule reaching the two gestures a person can
    now press. Without it 17c would have traded an invisible row for a dead
    button.
  - **Nothing was verified by eye.** 17b is reasoned from the emitted CSS (all
    four rules and the `:has()` shim confirmed in the build output) and from the
    palette being fixed light; the hand-test is where it gets looked at.

NOT IN THIS WAVE, recorded so it is not lost: a reading never fires
`onJobSettled` (pre-existing; nothing on BookForge's side subscribes, but
it hangs rather than fails, so it wants its own wave), and Owen's
emphasis/Table ruling is Wave 18.

### Wave 18 — the model's formatting reaches the page (Owen, 2026-08-19, via the switchboard) — LANDED (this commit)

Owen: *"i also notice that the vlm is returning things with **asterisks**,
and those are printing to the epub. i believe (possibly) the vlm prints
them as asterisks to signify when something should be bolded or
italicized. lets make sure that text effect makes it to the
workbench/'final version' and into the eventual epub. the bank should
display it correctly, basically. the table of contents in the pokemon
book also came through as actual html rather than displaying it."*

Measured on his Pokemon project by BookForge: 20 of 156 raw bank pages
carry `**`, becoming 124 rows in the book file; exactly one `Table` row,
whose category is ALREADY correct and whose text is the model's own HTML.

THE CONSTRAINT THAT DECIDES THE WHOLE DESIGN, and it is not obvious:
**Foundry's edit ops index into block text BY CHARACTER OFFSET** — a
split names a cut at an offset, a delete names `from` and `len`, and
`BookRef`s carry offsets into a block (shared/ops.ts, whose own comment
at ~817 says a text edit invalidates every ref offset into that block).
So parsing at reflow and STRIPPING the markers would shift every offset
in every edited block by four characters per pair, and replaying a
curated project's ops would land its strikes and splits in the wrong
places, silently. THE BANK AND THE BOOK FILE DO NOT CHANGE. Interpretation
happens only where text is DISPLAYED.

- **18a — one `productOf(request)`.** The row-identity rule (a read is
  its BANK, a translate its RECORDS, anything else its product) is
  spelled in three functions — `enqueueHere`, `enqueueTranslate` and
  `runJob` — all correct today, and Wave 16 added the third. BookForge
  shipped a defect of exactly this shape hours ago (`readingsPath ??
  outputPath`, which made every rendering dedupe against the read that
  fills the same bank) and their diagnosis was *"I had written the
  correct rule once and the wrong rule twice, three functions apart."*
  Three correct copies is a defect with a delay on it.
- **18b — emphasis becomes the effect, in BOTH display surfaces.** The
  `**` is prose to every layer today: the engine escapes it into the
  EPUB as literal asterisks and the renderer draws them as characters.
  A minimal, defined subset, parsed at display: `**bold**`, and italics
  in whichever spelling the model actually produces. UNBALANCED MARKERS
  DEGRADE TO LITERAL TEXT, because a strike or a split can cut a block
  mid-pair and a greedy parser would swallow the rest of the paragraph.
- **18c — the Table block draws as a table, IN THE RENDERER ONLY.** The
  EPUB is already correct on both engine routes (`compile.ts` emits
  `checkTableHtml`, which returns the fragment or throws and never
  escapes; `dots-book.ts` uses `flow.text` and not `words`, deliberately,
  with its own essay). What escapes it is the renderer's `@default`,
  which catches Text, Table, Formula and List-item alike — a gap this
  file already deferred out loud (*"their own shapes are later waves"*).
  Model-authored markup is NOT trusted input: a strict allowlist, never
  raw innerHTML of whatever arrived.

- **18d — what the build settled**, and the first item is a correction to
  this entry rather than a detail of it.
  - **THE ENGINE HALF OF 18b WAS ALREADY BUILT, AND THE SPEC ABOVE IS WRONG
    ABOUT IT.** *"The `**` is prose to every layer today: the engine escapes
    it into the EPUB as literal asterisks"* — it does not, and has not for as
    long as `dotsInline` has existed. `src/vlm/dots.ts:492-493` applies
    `**bold**` → `<strong>` and `*italic*` → `<em>`, after escaping and before
    the note-marker pass; BOTH writers reach it (`compile.ts`'s `worded`,
    `dots-book.ts`'s `inline`); `test/vlm/dots.test.ts:235` has asserted it all
    along; and `src/translate/textmask.ts` masks the same two patterns so a
    translation keeps its emphasis. PROVED ON THE DISK rather than argued: the
    EPUB already sitting in the user's own `Killing America` project carries
    `<strong>` elements and **not one asterisk** in any of its XHTML. So the
    engine was NOT TOUCHED — touching it would have been improvising against
    working code — and what Owen saw was the WORKBENCH, which is the surface
    that drew four asterisks around the name of every person who blurbed his
    book. Recorded at length because the wave's premise named the wrong
    culprit and the survey is what caught it, which is this file's own rule
    working.
  - **The parse is MIRRORED, not shared, and `app/shared/inline.ts` already
    argued why.** That file exists to restate the engine's inline alphabet on
    the app side, with the engine's files named as the contract, on the
    standing ground that *"the app never imports a line of the engine — it
    spawns it"*. The two emphasis expressions are now its third entry, beside
    the superscript run and the printed note number. This is the repo's
    established answer to this exact question, not a new one; the engine is the
    reference implementation and the mirror cites it.
  - **VERIFIED BY EQUIVALENCE, ON REAL DATA.** A throwaway script rendered
    every asterisk-bearing block in the user's library through BOTH
    implementations and compared them character by character with per-character
    bold/italic flags: **734 blocks, ZERO disagreements.** The degradation
    cases were checked by hand and agree too — `**Kari Lake` (a pair cut by a
    split) stays literal, `* Intercede for your city` stays a bullet and does
    not become an italic, `**a *b* c**` nests.
  - **THE SUBSET IS `**bold**` AND `*italic*`, ESTABLISHED FROM THE DATA.**
    Across every bank in the library: those two in quantity, `***` never,
    `_underscore_` never, `~~` never, backticks never, `[text](href)` never.
    No general Markdown parser was written. **Found and deliberately NOT
    implemented:** the model sometimes writes an ATX heading marker into a
    heading's own text (`## Heroes Arise`, four occurrences, always on a block
    already categorised `Page-header` or `Section-header`). It is a structure
    marker and not a text effect, the category already carries the fact, and
    interpreting it would mean DELETING characters the engine keeps — which
    would make the bench and the export disagree about the same string. It is
    named here rather than done quietly.
  - **Emphasis is cut in ONE walk with the note markers**, in the renderer's
    `cut()`, because both are offsets into the same source string and two
    passes over one string are two chances to disagree about where character
    forty is. The BLOCK EDITOR IS UNTOUCHED: it renders `line.row.text`
    verbatim on the standing ruling that what is edited is the model's source
    string, and the split's caret arithmetic counts that string, so an edit
    still commits exactly the characters the bank holds.
  - **The table sanitiser is stronger than an allowlist over `innerHTML` and
    was built that way on purpose.** Not one character of the model's string
    becomes markup: `readTable` reads the fragment into rows, cells and two
    clamped integers, and the component draws THAT with its own template. No
    `innerHTML`, no `bypassSecurityTrust*`, no `DomSanitizer` — nothing a later
    hand could relax. What it does with what it rejects, all three stated in
    the file: an unlisted element inside a cell keeps its words and loses its
    tag (except `script`/`style`/`template`, whose contents are code and are
    dropped with them); an unlisted element where a row or cell belongs is not
    drawn; and **a fragment with no rows at all is REFUSED VISIBLY** — the
    model's string is printed as prose, exactly as it was before this wave,
    under an amber sentence saying this app looked at it and could not make a
    table of it. A blank block was never an option. Exercised against a real
    DOM: script payloads, `img onerror`, nested tables, absurd `colspan`,
    junk spans, bare `<tr>` runs, `<tfoot>`, unclosed cells — all correct.
  - **Three losses named rather than hidden**: a `<caption>`'s words are not
    drawn, a `<tfoot>`'s rows ARE (they are `tr`s, and dropping a table's
    totals silently is the failure the section is written against), and two
    tables in one fragment draw the first.
  - **`productOf` takes the WIDE request type**, so `enqueueHere` and
    `enqueueTranslate` each hand it a narrower one. Narrowing the parameter to
    fit either caller would have put the fork straight back where it came from.
    All three answers are byte-identical to what they were.
  - **Nothing was verified by eye.** The emphasis is proved by equivalence
    against the engine and the table by a real DOM; how the grid and the amber
    refusal LOOK on the paper is the hand-test's.

FOUND WHILE VERIFYING, NOT IN ANY FENCE AND NOT FIXED: a translate mask
token leaked into a stored records file. `Working-Towards-The-Fuhrer`'s
`.de.records.jsonl` and `.de.book.jsonl` contain `⟧/e1⟧` — the model
answered with the CLOSING bracket where `textmask.ts`'s `TOKEN` expects
the opening one, so `restoreText` did not match it, did not restore the
emphasis it named, and wrote this program's private syntax into a book a
reader will see. It is pre-existing, it is in the translate path rather
than in any display surface, and it wants its own wave.

STILL DEFERRED, out loud: a reading never fires `onJobSettled` (nothing
on BookForge's side subscribes, confirmed by them, but it hangs rather
than fails and wants its own wave), and the table GRID EDITOR, which is
a later wave than merely drawing one.

### Wave 19 — the env install refuses a folder WSL cannot see (found from bookforge-pc-2's report, 2026-08-19) — LANDED (`961a726`, corrected here)

Not a ruling. BookForge reported a defect of their own on the channel —
WSL2 auto-mounts FIXED drives only, so their `windowsToWslPath()` handed
a guest `/mnt/z/…` for a library on a mapped network drive and the guest
looked somewhere that cannot exist. Foundry was checked for the same
class, because a reported class is worth more than a reported instance,
and it had it.

WHERE: `app/electron/env-install.ts` downloads the environment archive to
`makeTempDir()`, and `unpackInDistro` hands that path to the distro
through `toWslPath`. `toWslPath` refuses a UNC path (`\\server\share`)
but has no way to refuse `Z:\…` — a mapped drive is a network path
wearing a letter, and nothing about the spelling tells them apart.

WHY IT IS REACHABLE RATHER THAN THEORETICAL: `FOUNDRY_ENV_TMP` exists
precisely so "a machine whose %TEMP% is on a small SSD" can point the
five-gigabyte download somewhere roomier — and the roomier place on a
machine like this one is the NAS. On this PC `Z:` is `\\TITAN\iO`, and
`realpath.native` was run against it to confirm rather than assume.

THE FIX, and the three things it deliberately does NOT do:

- `networkPathBehind()` in `wsl.ts` asks the FILESYSTEM which share a
  path really lives on. Only the OS can answer that, so it is not pure —
  and `toWslPath` stays pure, with its docblock corrected to say that its
  UNC refusal is not the whole guard.
- The check runs in `run()` right after the temp dir is made, and ONLY
  when a distro is involved: the host-side unpack reads the archive with
  Node and is perfectly happy on a share, so refusing there would break a
  working case. It runs BEFORE the download, so the failure costs a
  second instead of five gigabytes.
- A path that cannot be resolved answers null. "I could not tell" must
  never read as "it is a network drive" and refuse an install over a
  missing directory.

NOT COPIED FROM BOOKFORGE: their fix stages the file into the distro
through `\\wsl$`, which is right for a session-state file of a few
kilobytes and wrong for a five-gigabyte archive — it would double both
the copy and the disk. Refusing early with an actionable sentence is the
cheaper correct answer here.

A NOTE ON HOW THIS ENTRY GOT WRITTEN, because it cost a commit: the first
attempt spliced this section in with `String.prototype.replace`, and the
`$` immediately before a backtick in "wsl$`" is JavaScript's "everything
before the match" — which duplicated 1,507 lines of this file into the
middle of the paragraph. `split`/`join` has no such interpretation. The
same class of trap as the defect above: a character that means one thing
to a human reader and another to the machine handling it.

### Small known defect, pre-existing, deferred out loud (2026-08-19)

openDropped (documents.service.ts) silently ignores a File with no
path: `if (!candidate) return;` two lines before its refusal sentence.
Real case, not synthetic: a drag out of another application's virtual
folder (Outlook attachment, zip preview) yields a File without a path,
and the app does nothing at all — no notice, no tab, no reason. The
capture intake path already answers the same case with "could not be
read from where it was dragged from"; the document path predates it
and stays silent. One line plus a sentence, in the app's oldest drop
path; found by the capture routing control at foundry-feature seq
82/83. Not capture work; do when next in that file.

Same date, same family: EIGHT components now carry identical private
copies of the ghost/primary button rules (confirm, export, host-op,
metadata, ocr, simplify, translate, capture-new). House pattern joined
rather than changed unilaterally, but eight copies of one visual
decision is the drift shape refused five times tonight in code,
wearing CSS. Lift to one shared sheet when next doing renderer-wide
work. (foundry-feature seq 87.)

### Wave 20 — the capture stage: photographs become the book (Owen, 2026-08-19) — BUILT AND MEASURED 2026-08-19, main ea6dc36; human acceptance pending, docs/CAPTURE.md

Owen photographed bound volumes at the American Atheists archive and wants
photo -> light table (reorder / rotate / split / quad-crop) -> minted
image-only PDF -> the existing pipeline, unchanged from the PDF onward.
Ruled: inside the project as a new arrival kind; quad crop that also
removes perspective lean; apply-to-all assist, no CV. The full plan of
record — model, recipe schema, IPC contract, three work packages for the
foundry-feature channel — is docs/CAPTURE.md, not duplicated here.

DEFERRED OUT LOUD, per Owen: automatic de-skew and AI sharpen come after
this lands; re-mint reading reuse and CV auto-detect are recorded in the
doc's deferral list.

### Wave 22 — the reader runs away on a bleed-through page (Owen, live,
### 2026-08-20) — v1 ON MAIN (53be1d7), design in `docs/READ-TRUST.md`

A blank verso photographed with writing showing through from the other
side is the lowest-signal page the reader ever meets, and dots does not
stop: 25,000 characters of invention on one page. Owen's constraint is
absolute and shapes every instrument -- "its doing a fine job with
everything else so i dont want to cripple its other work."

- RULED ALREADY: the blank-page PRE-filter is CLOSED. Bleed-through and a
  faint real page are the SAME PIXELS (differing by mirroring and
  position, not intensity), so any threshold that excludes one excludes
  chapter openers, colophons and every lighter-exposed scan -- and it
  fails in the direction that DELETES a page. The instrument is a
  degeneration POST-filter, whose cost to a healthy page is zero by
  construction rather than by calibration.
- THE CAP IS NOT THE LEVER: 8192 is high on purpose (a dense index ran
  past 4096); lowering it is the one fix the constraint forbids.
- WAITING ON ONE MEASUREMENT, from the bank Owen already has: did the
  runaway hit the cap and get REFUSED (book clean, minutes wasted) or
  stop under it and get ACCEPTED (nonsense in the book)? And is the
  nonsense an n-gram cycling or varied invention -- that decides whether
  the post-filter is repetition detection or length-in-context.
- OWEN'S TO RULE: what a caught page BECOMES -- a silent blank page, or a
  refusal he is told about.
- DEFERRED OUT LOUD, found on the way and not created by this: the ink
  facility is DEAD (removed `f192c50`) but its two ends survive -- the
  `grayscale` flag still writes PGMs nothing reads, and `src/scan/pgm.ts`
  has zero callers. They should go together, in their own commit, when
  somebody is in that file for a reason of their own.

### Wave 23 — the page beside the block (Owen, 2026-08-20) — IN THIS COMMIT

*"i want to hover over a block and see that page of the original beside
it."*

Everything the answer needs has been in the book file since v2 and no
surface had ever read it: a row carries `page`, `box`, `pageWidth` and
`pageHeight`. WHAT WAS MISSING WAS THE SCAN — a `book` tab's path is the
PROJECT directory, and nothing on the load named the document the reading
photographed. So the whole of the new door is one field,
`BookLoad.originalPath`, and everything else is drawing.

- REST, NOT ENTER. A pane of prose is swept across on the way somewhere
  else, and a card on every crossing would flash a dozen times down a page,
  each flash costing a PDF page render. The timer is 180 ms and lives in
  the sheet's own `pointerenter`/`pointerleave`.
- IT IS NOT THE PEEK CARD. The sheet already has a card beside the hand —
  the note peek, opened by CLICKING a marker. This wears the same paper on
  purpose and keeps separate state, because they are different gestures: a
  peek is asked for and STAYS, a glance follows the pointer and GOES.
- NO OUTLINE ON A BLOCK THAT CROSSED A LEAF. A merged row's box is
  composed — origin from the first part, height SUMMED — so outlining one
  would draw a rectangle running off the bottom of the page. The page is
  still shown and the footer says it carried on, which is the true thing a
  box cannot say.
- pdf.js IS LOADED ON THE FIRST GLANCE. `app-book-view` is not deferred, so
  a static import would put half a bundle in the boot chunk. Measured:
  initial 695.96 → 702.64 kB (+6.68), and pdf.js stayed lazy — it is now a
  484 kB chunk SHARED with `app-pdf-view` rather than duplicated.
- ~~DEFERRED OUT LOUD, and it is Wave 21's arrival that creates it: a
  CAPTURED book would be the one book in the app that denied having any
  paper, in a sentence written for an EPUB~~ — **CLOSED ON ARRIVAL.** It
  is not a union: `bookAtPosition` gives `pages` its own field rather than
  a second meaning for `pdf`, so `BookLoad` mirrors that split with
  `originalPages` and the card asks about the captured book FIRST. The
  card still cannot DRAW a photographed page; what it stops doing is
  claiming there are none, and `originalPages` is the field whoever draws
  them will read. **That drawing is the open half of this wave.**
- **THE CARD WAS BEING REBUILT FOR EVERY GLANCE, and that is the finding
  worth carrying.** The wip commit left one open question — canvas hang or
  cold pdf.js load — and the answer was neither: it paints every time, in
  under a second. What the measuring found instead was that `book-view`
  mounted the card behind `@if (glanceAt())`, destroying the component on
  every `pointerleave`. Two sections of `page-glance`'s own header describe
  state that survives a glance — one worker "built once and kept", a cache
  making a repeat glance free — and BOTH WERE FALSE. Counted at the
  `Worker` constructor over a ten-rest walk: **10 rests → 10 workers, none
  terminated, ~748 ms a glance; mounted once → 1 worker, terminated on
  close, ~210 ms** (and 210 ms is the probe's own floor). A docblock
  arguing for an economy is not evidence there is one, and the thing that
  made every word of it untrue was one `@if` in a different file.
- **AN INDIRECTION WAS BUILT, MEASURED, AND DROPPED.** The cache-hit path
  paints in the effect's own turn, which `draw()`'s docblock reads like a
  reason it should fail, so the paint was routed through a signal. Then the
  old direct draw was put BACK and measured against repeat rests: it
  painted every time. Fresh renders land at 500-650 ms and cache hits at
  the 210 ms floor, a gap far wider than the resolution, so those repeats
  were certainly hits. The finding went into the docblock and the code
  stayed simple.

### Wave 24 — the book's crop, and the page that has its own (Owen, 2026-08-21) — BUILT

*"the two buttons at the bottom are confusing as hell… the whole paradigm of
how we're doing it now versus global+individual"*

**Designed and built. Full record at docs/CAPTURE.md § Wave 24**, whose second
half — *Wave 24, BUILT* — carries what the walk found and what is still open.
Contract before code, per that doc's own rule.

Six gates green: 418 pass / 0 fail, root `tsc`, both app tsconfigs, `ng build`
at **704.40 kB** (down from 704.53 — the wave is a net deletion), cascade-check
1013 elements with 0 rules quietly losing, control-byte scan clean on all eight
touched files. Walked in the running app against a scratch copy of the index
shoot; the scratch copy has been deleted.

- **The diagnosis is one sentence: there is no NOUN for the book's crop.**
  `byHand` is not a property of a page, it is a property of what a future
  button press will do to that page — which is why its control can only be
  named after a policy (*"Let apply-to-all change it again"*) instead of an
  outcome. Apply-to-all is a verb with no noun: it copies from whichever
  photograph you are standing on and is then gone.
- **THE SEMANTICS ARE NOT CHANGING, and that is the useful finding.** Owen:
  *"if i change crop positions for a page, it should be assumed correct and
  should not be overwritten"* — which is already exactly what the code does.
  The rule was never wrong; it was invisible, and its escape hatch was named
  after a policy. This wave is naming and visibility.
- **The same missing noun is the split line "not persisting" between pages.**
  The proposal resets to dead centre on every step, deliberately, because with
  no book's cut the only fallbacks are "this photograph's" or "the middle". One
  cause, two complaints.
- **A global mode and an individual mode were proposed by Owen and argued
  down**, recorded in CAPTURE.md so they are not re-proposed: a mode makes
  dragging mean different things depending on state you cannot see, and the
  thing it would buy — watching a change land everywhere — is not visible,
  because the editor shows one photograph at a time.
- **Split becomes a checkbox rather than a mode**, which also ends the primary
  button's shape-shifting between "Cut this one into two pages" and the global
  stamp.
- **One control rule carries most of the design**, and it is this stage's own
  precedent: *a control that would change nothing is not shown*. A photograph
  that matches the rest carries no buttons at all.
- **Found while designing, not built:** the gutter can already be grabbed
  ANYWHERE along its length and slid — `slideSplit` is wired — but there is no
  cursor rule anywhere in that editor, so the line reads as decoration. An
  affordance, not a feature.
- **The open question is answered.** *Crop all* carries the cut too, so a
  button labelled Crop can cut twenty-three photographs in two. Owen ruled: ONE
  button, and the consequence line carries it — *"Becomes the book's crop and
  cut. 23 photographs take them, two pages each."*
- **Three PRE-EXISTING defects the walk exposed, all fixed here.** Intake and
  removal rebuilt the recipe from scratch and so DELETED the prepare rail's
  ticks on every drop (and would have deleted the standing). The override
  dialog was gated on "is anything hand-set", counting the source itself —
  which the stamp never skips — so it asked about a page that was about to
  become the standard. And the stamp turned a spread's two pages
  independently, which puts them in the book BACKWARDS on a half turn: the
  arithmetic `turned` has measured since Wave 21, arriving through a door
  nobody had checked.
- **One thing the design got wrong, found by measuring rather than reading.**
  Taking the book's cut marked the photograph as its own, so accepting the
  standing opted it out of the standing. The mark now follows where the cut
  came FROM — the book's cut leaves it following, the middle is a placement —
  which is why `cutHere` is a service door and not geometry in a component.
- **Deferred out loud: the rail's "N by hand" count is still not clickable.**
  The card mark is built and is the half that matters; selecting exactly those
  cards from the rail needs a selection input on the grid, whose `chosen` is
  private today. Not half-built.

### Wave 25 — two passes, and the complete page (Owen, 2026-08-21) — CONTRACT DRAWN

Designed over mockups (the "The Book's Crop" canvas) in conversation;
the full contract is **docs/CAPTURE.md § Wave 25**, not duplicated here.
The three ideas: THE SURFACE NAMES THE SCOPE (card = photograph, rail =
book, modal = the photograph it has open — no mode, ever); CROP AND
SPLIT BECOME PASSES IN ORDER (crop → Apply → split on the cropped
projection → Finish, because applied crops register the pages and one
cut then fits the book); and COMPLETE, one state unifying Wave 24's
by-hand protection with a per-page say-so mark — a complete photograph
is skipped by every global act until an explicit release, and is left
out of the STAMP, never the MINT. Apply is a commitment point (the
projection flips everywhere; pixels are cut once, at Finish).

Work packages W25-P1 (model) / P2 (table) / P3 (modal) are fenced in
the contract, P1 first. Closes Wave 24's deferred "N by hand is not
clickable" and retires its override dialog. Deferred out loud: the
Book-card stacked see-through editor, until the one-cut-fits-all
promise is measured weaker than designed. Owen signed off 2026-08-21.

**~~P1~~ — LANDED (this commit).** `complete`/`pass` on the schema,
`isComplete` as the one skip predicate, `placed()` deleting a stored
answer on every hand placement, `applyCrops`/`applyCuts`/`reopen`,
`recordCrop`/`recordCut` (record-without-stamp), the electron
validator carrying both fields. Five gates green by the builder AND
re-run by the lead: 418/0, three clean typechecks, `ng build`
707.15 kB (WARNING only; was 704.40). The build's decisions are
adopted into CAPTURE.md § Wave 25 ("What W25-P1 settled"). P2 (table)
and P3 (modal) run next, sequentially in the main tree.

**~~P2~~ — LANDED (this commit).** The rail is the sequence (Crop →
Split → Finish), the complete dot + pressable populations (closes
Wave 24's deferred clickable count), right-click Release with the
scrim the grid's menu never had, and the cropped projection after
Apply — measured in the running app: 50 cards, median 3.3 ms each,
one GL context, lazy so only the viewport pays. One fix routed by the
lead at landing on P2's own recommendation: `applyPopulations` is the
one walk whose lengths ARE `applyCost`, replacing the view's second
walk. Gates re-run by the lead: 418/0, three clean typechecks,
`ng build` 721.54 kB (WARNING only). Record in CAPTURE.md § Wave 25
("What W25-P2 settled"). P3 (modal) runs next.

**~~P3~~ — LANDED (this commit), and the WAVE IS BUILT.** Pass-aware
modal (line-only on the rectified page in the split pass, with the
photograph↔page coordinate crossing done through the shader's own
closed form); record-not-stamp; the say-so in both passes; "Follow the
book again" discovered to BE the release (`wearing` already clears the
mark); the ghost shipped; the stamp-on-press path, override dialog,
`stampCost` and `completeNames` deleted with gravestones. Gates re-run
by the lead: 418/0, three clean typechecks, `ng build` 728.87 kB
(WARNING only). Record in CAPTURE.md § Wave 25 ("What W25-P3
settled"). **OPEN: the hand-test** — nothing in P3 was exercised in
the running app; the split-pass gutter drag and the ghost first, then
the whole loop with a release and a reopen on the way.

### Wave 26 — hosted, there is no shelf (Owen, 2026-08-21, via the switchboard) — LANDED (this commit)

Owen, verbatim: *"when im in bookforge, the shelf shouldnt appear at
all. thats the hangup. bookforge should be using its own queue. and it
does add it to the bookforge queue. but the shelf still appears in
bookforge's foundry vendor."* Diagnosed jointly on `bookforge-sync`
(seqs 152–154): routing was FINE (their trace); the shelf was the
defect — no dismiss, its only ✕ routed and CANCELLED the job, and the
head toggle read as dead because `column-reverse` rendered the real
head at the FOOT dressed as a status line while the job row sat on top
wearing a titlebar and an ✕. Two agents read the toggle's logic and
found it sound; the defect was geometry.

- **Hosted renders NOTHING** — one `@if (!hosted())` around the whole
  shelf, live region included. The host's queue page releases a held
  read (their side traced held → queued → picked end to end; caveat
  recorded there: not yet smoke-tested, and their ▶ un-pauses their
  whole queue — theirs to own).
- **`summonShelf(focus)` on UiService** is the one door the four
  dialogs now use (ocr/export/simplify/translate); hosted it does
  nothing, and the gate is ALSO on the render because a summons with
  nobody home and a home nobody can summon are two halves of one rule.
- **The head is the top of the panel** — `column-reverse` → `column`,
  so the one clickable strip sits where every panel keeps its chrome.
  Standalone keeps its shelf exactly as it was otherwise.
- **The six dialog hosts got confirm-dialog's inert-host rule**
  (`pointer-events: none` + auto on scrim/card): all were safe only
  because an @if unmounts them, which is safety by accident. Promised
  to BookForge at seq 153; done here.
- BookForge gets all of it at the next re-vendor, which still HOLDS
  until Owen's Wave 25 hand-test passes.
- **ADDENDUM, LANDED `fd899bf`:** the gate and the host's hold-removal
  crossed and left a hosted Add with NO confirmation anywhere (found by
  the host side before anybody hit it). `confirmQueued` on UiService is
  the one door: hosted the sentence lands on the notice surface (the
  toast tray, as of Wave 32), standalone
  on the shelf's live region as before; all four dialogs route through
  it, and the hosted OCR sentence drops the Start clause because a
  routed read runs on its own now (their hold is gone, their 1ed04c1d).

### Wave 27 — a dots table draws no rules (Owen, 2026-08-22) — LANDED (`3deb4b2`)

Owen, on the Julius Streicher TOC: *"a table generated by dots looks
ridiculous with borders."* What the model writes as a Table is contents
pages and indexes — set type in columns, which no printer ever ruled.
Borders to zero in all three surfaces in one commit so the bench and
the export agree: the renderer's hairlines (book-view §18c), epub.ts's
full cell grid, dots-book's header underline. A cast already exported
keeps its borders until re-exported, as ever.

### Wave 28 — the action menu becomes the tile grid (Owen, 2026-08-22) — LANDED (`080ef8e`)

Owen picked direction B from the "The Action Menu" design canvas:
navigation as one slim strip, the acts as a 3-column grid of
icon-over-label tiles, every unicode glyph replaced with the app's own
`ft-` symbol sheet. **Found on the way, fixed with it:** the symbol
sheet was defined inside the library panel's expanded branch, so every
mark in the app vanished exactly when the panel collapsed to
icons-only. Order, active, waiting-pulse, disabled-not-hidden, hosted
rules and the 30px stub all survive; the component docblock records
the fourth arrangement without deleting the first three.

### Wave 29 — nothing unapplied is skipped or lost (Owen, 2026-08-22) — LANDED (this commit)

**Built and landed.** What the build settled beyond the contract:
`unappliedIn`/`applyUnapplied` moved INTO BookStacksService so the ask
card and the close question share one predicate and one apply door; the
gate sits at every act door (the action menu's five, the tree footer's,
the app menu's export) and at dialog OPEN — checked honest: none of the
three make-dialogs has a source picker, so the book at open is the book
for the card's life. The sidecar is `ops/pending.jsonl` (fixed name, in
ops/ because that directory's own contract is never-swept), guarded by
step id + sixteen hex of the bank receipt, refused OUT LOUD when stale,
cleared by Apply and by the explicit Discard. Named costs: a host-
ordered export through the mount seam cannot ask (recorded at
`exportEpubFromStep`); one sidecar per project means a rare step-
hopping sequence overwrites held work after announcing it. Found on the
way: IPC-CHANNELS.md had drifted to three different counts (doc 71,
table 79, source 80) — reconciled to 84/84/84 from source, plus the
push and family the table never had.

Diagnosed on Owen's own hosted project, read-only: his chapter rename
and text edits never became ops (unapplied stack), the export honestly
replayed the ledger — every APPLIED op verified present in the EPUB —
and the stack was later scrapped, likely by the hosted window closing
past the per-tab question. Owen's "go ahead" REVERSES the old ruling
("closing without applying scraps it") in favor of never-silently-
scrapped. Two units, one agent:

- **F1** — Export/Translate/Simplify (and the renderer-side host-act
  press) ask at press when `unwritten > 0`: Apply and continue /
  Without them / Cancel — the same predicate and the same apply door
  the close question already uses. Known limit, recorded: a host-
  ordered export through the mount seam runs in main and cannot ask.
- **F2** — the pending stack flushes to a sidecar under the project
  (debounced, atomic, the capture recipe's own pattern), hydrated on
  open behind an identity guard, cleared by Apply and by the explicit
  discard answer. New IPC doors; IPC-CHANNELS.md regenerates in the
  landing commit for BookForge's keeper.

### Wave 31 — the capture intake reads screenshots, and the table sorts (Owen, 2026-08-22) — LANDED (this commit)

Two rulings from Owen photographing-by-screenshot: *"i just took
screenshots of a book"* (179 PNGs refused by the v1 HEIC-only gate) and
*"it should be able to sort them by filename or by date saved,
ascending or descending."* Intake now reads HEIC/HEIF (libheif, as
ever), PNG (working copy = the bytes themselves, byte-identical) and
JPEG (one transcode by the imaging that decoded it) — and applies NO
rotation of its own, ever: the v1 refusal's double-rotation fear is
answered by the table showing the truth and Turn being one gesture.
The reverse button became a **Sort ▾** menu of four acts (name A–Z/Z–A
with natural compare, oldest/newest first), sorting by spread so split
pages never swap, stable on ties, and usable even on an arranged table
— choosing a rule is deliberately abandoning the arrangement.
`reverse()` and `descending` retired with gravestones.

### Wave 32 — the notices become toasts (Owen, 2026-08-22) — LANDED (this commit)

*"we should probably add toast notifications."* The `notice.set` door
did not move — the new toast tray CONSUMES the signal (append, reset to
null), so zero call sites changed and two silent losses of the strip
died with it: a second sentence no longer overwrites an unread first,
and two identical refusals are no longer one. Bottom-right above the
shelf's corner (z 1100, between shelf 900 and dialogs 1200), 8s with
hover-pause, ✕, four visible + a queue that never drops, pre-line for
multi-line reports, permanent polite live region. notice-bar deleted
whole. NAMED COST, deferred not forgotten: no severity field yet, so a
refusal expires on the same clock as a confirmation — severity is the
next wave if it bites.

### Wave 33 — the walk's rulings: the gate goes, the book's apply reaches the modal, and the room loses its clutter (Owen, 2026-08-22) — LANDED (this commit)

Owen's first real walk of the Wave 25 passes, arriving as rulings:

- **The mint gate is REVERSED**: *"sometimes i wont need to do any of the
  three... i should be able to click finish/finalize anyway. it should
  auto-check the one i already worked on."* Finish is pressable whenever
  there are pages; the ticks stay as the record and are now SAID-OR-
  EVIDENT (`CaptureService.evident` — a turn performed, a crop placed or
  a standing set, a cut made). The old ruling's surviving half: nothing
  ever CLEARS a tick a person set.
- **Record-and-apply in one press, in the modal** — *"it wasnt obvious
  that i had to apply all crops from the main window"*: a second button
  under the record ("Make it the book's crop and apply to all", cut twin
  in the split pass), the same two doors underneath in order.
- **Side arrows on the editor's stage** — the lightbox walk, absent at
  either end; Back/Next and arrow keys survive.
- **The drop strip draws only on an EMPTY table** — the window is the
  drop target whenever a capture tab is up (verified at app.ts's drop
  routing before removal).
- **The inspector nulls itself on the light table** — its subject is the
  ledger; the recipe's inspector is the rail.
- **The Chapters acts are sticky at the list's foot** — pick a block
  anywhere, the press is right there.
- **`qwen3.8:27b` is the default translate/simplify model** — Owen:
  *"27b is the standard we'll use for every task."* Both copies of the
  constant, the CLI help, and the five test-fixture pins moved together;
  `takesThinkField`'s prefix already covered the new family. (The
  installed `qwen3.8:27b-24g` variant is noted in case it is the wanted
  one.)

### Wave 36 — the captured face exports, and the unapplied question becomes Discard/Apply everywhere (Owen, 2026-08-22)

- **LANDED (this commit): the captured face.** Owen's full walk ended at
  *"Open a book first"* from Export over an applied, read, captured
  book: a captured project's archive is PAGES (a folder, since
  `ecbf238`), so `originalOf` finds no origin row and all THREE
  make-dialogs' `source()` answered null. Each now answers the PROJECT
  DIR for a captured, read project — the same face the OCR dialog
  accepts, resolved by `importDocument`'s own inside-a-project rule
  (`projectDirOf` resolves the dir to itself; verified before use).
  **SUPERSEDED BY WAVE 41 — the branch is retired with a gravestone in
  each of the three files.** It was a correct patch aimed at one
  consumer of a fact that was wrong at the source: a project whose
  archive names no file. The mint files a PDF, so `originalOf` answers
  for a captured book and the line under the retired branch —
  unchanged, the ordinary one — does the whole job. The class this
  item belonged to (the pages view, the figure `--pages` face, this)
  is closed at its source rather than patched a fourth time.
- **BUILT (this commit): the unapplied question, Owen's refinement of
  Wave 29.** Verbatim: *"any action they take, whether it's switching to
  a different step or narrating or anything at all, should ask if they
  want to apply changes in a modal. discard/apply changes."* The card's
  three answers are now TWO — **Apply changes** (apply, then run) and
  **Discard changes** (drop the stack, then run the chosen act on the
  step as recorded, wearing the error colour and aimed at, on the
  closing card's precedent) — plus dismissal (Escape or the scrim) as
  cancel, said in the card's own words because a way out nobody is told
  about is not one. `without` is retired with a gravestone in
  `UnappliedAnswer`; `MakeAct` is untouched and the seam now carries
  `UnappliedAct = MakeAct | 'stand'`, because half a dozen tests mean
  "an act that makes a book" by the old name.
  - **Gated:** the five make-act presses that already were, plus the
    tree's step/root click and the tree footer's `read` — both through
    `stand`, which is the ONE person-initiated position move in the
    window (`LedgerService.go` has exactly one caller). A make-act press
    that stands on its row first passes `asked` so the card is raised
    once per press, by whichever half of the press costs something.
  - **Deliberately NOT gated:** `PositionSyncService`, which REACTS to a
    pointer main has already moved (a landed job, another window, the
    move an Apply causes) — a card there would ask permission for
    something already true. Compare's second column, which loads at a
    step without moving the pointer. Re-clicking the row already stood
    on, which is not a move. And `exportEpubFromStep`, Wave 29's named
    limit, still unreachable from a window.
  - **Discard reaches all three holders** through
    `BookStacksService.discardUnapplied`: the live viewer's own signals
    (new `BookStack.discard`, which returns `pending` to `landedOps` —
    the RECORDED book, not an empty one — and drops the live editor
    uncommitted), the parked copy, and the sidecar. The pane is the one
    the closing card never had to empty, because there the tab is going.
  - **Nothing greys**: verified that no act predicate in the action menu,
    the tree footer or `shared/stages.ts` reads the stack at all.
  - **The obvious Apply** is at the HEAD of the book pane — the one
    accent-filled control on the surface, drawn only while `waiting() > 0`
    (absent, not disabled), in the edition as well as the bench, wearing
    the tray's own label so there is one wording. The side tray's button
    is unchanged and stays disabled-at-zero, so the affordance can still
    be learnt before there is anything to press it with.
  - **Unchanged named cost:** the gate looks at book PANES, so unapplied
    work whose tab has been closed is not asked about — the sidecar's
    identity guard still refuses it out loud at the new step.

### Wave 37 — the reflow learns the pages face, and figures heal (Owen, 2026-08-22) — LANDED (this commit)

Star Gods refused to export: *"b28-9 is a picture and this book never
had its figures cut."* The read learned pages at Wave 21; the REFLOW
never did — `vlm-book` cut figures only from `--pdf`, and a captured
archive is a folder. Now: `--pages <dir>` beside `--pdf` (mutually
exclusive, refused together by name), crops cut 1:1 from the page's
own pixels through THE READ'S OWN ordering rule (`pagesInDirectory`,
one function, so page N cannot drift), verified on a synthetic book on
both faces. The header gains `figures: {blocks, cut, from}` — the
OFFER recorded, not the outcome, which is the loop guard — and both
ensure doors REMAKE a book whose figures are missing when a source now
exists (absent marker = older engine, resolved by reading the rows
once; a failing remake caps at one attempt per launch). The refusal's
there. The refusal's advice no longer implies the original must be a PDF.
Also landed beside it: the PDF viewer's selection stops re-inking the hidden text
layer white (`color: transparent` on the layer's own ::selection — the
global rule was winning the color per-property).

**PARTIALLY SUPERSEDED BY WAVE 41, and the halves are worth separating.**
THE ENGINE'S `--pages` FACE STAYS, whole and untouched: `vlm-book --pages`
is a capability of the command, documented on the command, usable from a
terminal, and the crop-from-a-page's-own-pixels work behind it is exactly
as good as it was. `BookFigures.from` keeps its `'pages'` member for the
same reason — a book file written that way must go on parsing here.
WHAT RETIRES IS THE APP'S SELECTION OF IT: `writeBookFile` loses its
`pagesPath` option, `bookAtPosition` loses its `pages` field, and the
figure heal's source is `at.pdf` alone, because a captured project's
archive is a PDF now and there is no second shape of pixels for this side
to describe. THE FIGURE HEAL ITSELF IS UNTOUCHED and composes with the new
container heal by ordering: `bookAtPosition` awaits `healMintedArchive`
before it composes `pdf`, so the PDF exists before `ensureReadingBook`
asks whether the figures do. PDF first, then figures.

### Wave 38 — the Home intake workspace (Owen, 2026-08-22) — BUILT (this commit)

Owen, verbatim intent: the OCR… button leaves Home; the drop zone
accepts images (HEIC/PNG/JPG) as well as PDFs; dropped images land in
a WORKSPACE accordion in the sidebar (the inspector's accordion idiom;
each open book becomes an accordion with ✕ and collapse); select
images → right-click → *Create new book* → a naming modal → a capture
project with those pages MOVED in, opening as Photograph-a-book does;
closing the workspace clears the unassigned (re-upload to recover) —
the assigned are already safe in their projects. Mixed drops: PDFs
keep today's behaviour, images go to the workspace. All of it built;
the ruling is quoted in full at `IntakeWorkspaceService`'s head and
again over the accordion that draws it.

- **THE SEAM IS THE WINDOW'S DROP HANDLER, NOT HOME'S RECTANGLE.** Home's
  target is decorative and always has been — the whole window takes the
  drop, and the rectangle exists so anybody knows that — so hanging the
  workspace off that element would have rebuilt the exact failure the
  capture front-tab routing was written to fix (a strip you can miss,
  and every miss coming back as "IMG_0238.HEIC is not something Foundry
  opens"). `App.onDrop` SORTS the files instead of classifying the drop:
  a capture tab in front still swallows everything, then images go to
  the workspace and the rest through `openDropped`, one tab each. Mixed
  drops therefore work without a rule about which kind "wins".
- **IT IS NOT GATED ON HOME BEING ON SCREEN**, deliberately. The
  workspace lives in the library sidebar, which is permanent chrome on
  every route, so the rule is about the FILE and not about what is in
  front of it — an image is never a document this app opens, and gating
  on the route would mean the same gesture one second apart either
  organised a shoot or raised the refusal Owen was ending.
- **THE EXTENSION LIST MOVED TO `shared/capture.ts`** as
  `PHOTOGRAPH_TYPES` (+ `isPhotographName`), with the whole HEIC/PNG/JPEG
  argument and the EXIF no-rotation ruling carried across intact. It was
  `READABLE`, private to main, which was right while only main had an
  opinion about what a photograph is; the renderer has one now, and a
  second list of five extensions would be two answers to the question
  the capture stage exists to answer once.
- **CREATE IS THE TWO EXISTING DOORS AND THE WORD "THEN".**
  `capture:create` (named, empty project) then `capture:intake` (copy,
  hash, decode, append), then the light table opened from the DIRECTORY
  exactly as `CaptureNewDialogComponent` opens one — "just as though they
  had started a new book from the home page" kept true by doing the same
  thing rather than something equivalent. `CaptureService.intake` split
  into a `File` door and a path door (`intakePaths`) and now RETURNS the
  report it used to swallow, because "did it run at all" is a question
  the notice cannot answer and a list must not be emptied on a guess.
- **PARTIAL REFUSALS: WHAT WAS ASSIGNED IS ASSIGNED.** The intake's own
  report goes to the toasts as it does for every other drop (counts,
  duplicates, each refusal in main's words); the workspace then drops the
  whole selection, refusals included, because the only handle this side
  has on a refused file is a BASENAME and matching one back onto a table
  that may hold `page-001.png` from two folders is the fold this repo
  forbids everywhere else. A wrong match would silently keep the wrong
  picture and destroy the right one. An intake that never ran changes
  nothing and the named project still opens, so its light table is the
  recovery.
- **THE ACCORDIONS ARE CHROME AROUND THE GROUPS**, in the inspector's
  idiom — head, caret, small-caps label, count — with a ✕ on each book's
  head mirroring the close-book door the root card and the right-click
  already carry (three doors, one `closeProject`; the head's exists
  because a folded book has no root card on screen). Shut-not-open, like
  the node collapse one level down, so a book that opens while you are
  looking at the library appears open. The caret is `.acaret` and not
  `.twist`: `.twist` is taken by the card's own expander, and two rules
  of one name at one specificity is a coin flip dressed as a cascade.
- **A HEIC MAY NOT DRAW AND THE CARD ASKS RATHER THAN ASSUMES.**
  Chromium decodes PNG/JPEG in an `<img>` and not reliably HEIC — the
  format of the case this feature exists for. Decoding through main
  would mean decoding every dropped photograph before anybody has said
  which are a book, in the process that must not block, for a 96-pixel
  picture. So `(error)` swaps in the tree's own camera mark, and a later
  Chromium that learns HEIC simply draws it.
- Standalone only, decided in one place (`IntakeWorkspaceService.available`)
  for the reason "Photograph a book…" is behind the same guard: hosted,
  a project born here would land in a library the host is not keeping,
  and hosted has no Home. Hosted, images meet the document door exactly
  as before.
- Gates: 418 pass / 0 fail, three clean typechecks, `ng build` complete
  with the pre-existing budget WARNING at **757.63 kB** (746.57 at the
  last landing).

### Wave 43 — a BookForge-shaped queue: bar, dropdown, page (Owen, 2026-08-22) — BUILT (this commit)

*"looks like we didnt implement a bookforge-style queue. can you make
the queue shelf a bar along the top right that i can click and look at,
and put a button in it for 'more info' thatll take me to a queue page
that looks like bookforge's queue page? this is just ui work mostly,
not changing the way it works on an engine level."*

UI ONLY, and the last sentence was the fence: the scheduler
(`electron/job-queue.ts`), the slot table (`shared/queue-board.ts`),
QueueService's doors, the drain contract and the held/Start semantics
are untouched. The same facts moved into new chrome.

- **The shelf was modelled on the wrong BookForge component.** It was
  built after `setup-download-dock` — which is BookForge's first-run
  DOWNLOAD dock, not its queue. Its actual queue is a chip in the title
  bar (`features/queue/components/queue-chip`), a dropdown tray under it
  (`queue-tray`), and a page behind that (`features/queue/queue.component`).
  Wave 43 is the shelf finally being modelled on the thing it was always
  meant to resemble. `QueueShelfComponent` is DELETED with a gravestone
  at the head of `queue-bar` naming where each of its behaviours went —
  headline, aggregate bar, the two-meaning ✕, Start-with-count, the
  export-done unroll, the focus hand-off, the sr-only live region, the
  hosted gate. Not one died.
- **One description of the queue, read by both surfaces.**
  `core/queue-view.service.ts` holds the board, the lanes, the headline,
  the row sentences and the three row actions. BookForge's own page
  header is the argument: before it had a shared service its two queue
  surfaces *"spoke different dialects"*. Copying the shelf's methods
  into two components would have been a drift machine with a two-week
  fuse.
- **The page adds the BENCH** — one card per slot, always all three,
  occupied or free — which is a reading of `SLOTS`, not a new fact. A
  lane's running rows are dealt into its slots in queue order; main
  never says which slot is which and the page does not pretend to know.
- **Route `/queue`, standalone-only by `canMatch`** rather than
  `canActivate`: a refused match falls through to the wildcard and lands
  on the workspace, where a refused activation would leave a window
  restoring a saved URL having arrived nowhere. Owen's 2026-08-21 hosted
  ruling now covers three surfaces instead of one.
- **The toast tray anchors at `bottom: 16px` in BOTH worlds.** Its 424px
  standalone offset was arithmetic about the shelf's height; the shelf is
  gone, so the gap held space for a case that cannot occur. The hosted
  override and its `hosted` injection are deleted with it, and the
  `max-height` followed the anchor down. The anti-motion argument the old
  clause rested on is kept in the docblock — a tray that READ queue state
  and moved is still forbidden.
- **Renamed off dead furniture**: `shelfExpanded` → `queueOpen`,
  `shelfSaid` → `queueSaid`, `focusShelfAt` → `focusStartAt`,
  `summonShelf` → `summonQueue`, plus the four dialogs' call sites and
  two user-facing strings that said *"It is in the queue shelf."*

DEFERRED OUT LOUD: no per-book Start on the page (`queue.start()`
releases the whole held batch — a per-book button would silently start
four other books, and the gap is named in the page's header rather than
papered over); no Retry on a failed row (nothing in main re-runs a
settled job); no ETA, covers, temperatures or per-stage bars, which
BookForge's page carries and Foundry's queue knows nothing about. The
queue still has no persistence — a held read is still lost on restart,
unchanged since Wave 16.

### Wave 35 — the queue as a slot board (Owen, 2026-08-22) — BUILT (this commit)

*"the queue shelf should probably look a bit more like the bookforge
queue, where it has two cpu slots and one gpu slot, and i can see
details about the step thats taking place."* NOT a coat of paint: the
standalone queue was deliberately ONE serial slot (the pump), so lanes
are a scheduler change with resource declarations, not a shelf
restyle. Contract first, in `docs/QUEUE-BOARD.md`, and the Wave 16
lesson applies — one machine's GPU wants one owner, so the lanes must
not let a CPU export and a GPU read fight the card's feeding.

- **The table lives in `app/shared/queue-board.ts`** —
  `Readonly<Record<JobKind, JobResource>>` plus `SLOTS = {gpu: 1, cpu:
  2}` — read by the scheduler AND by the shelf, so the lane a row waits
  in and the lane it runs in cannot disagree. A new kind fails the
  typecheck; there is no default, because a default resource is a
  fallback.
- **Two of the contract's own rows were wrong and were corrected in the
  file first** (it is written to be corrected). `env-install` is
  `exclusive`, not "outside the slots": 16e is about ROUTING, and an
  install has always taken the serial slot on purpose — a downloader
  running beside the lanes would let a read start against the Python it
  is replacing. A queued install is also a BARRIER, or cheap CPU rows
  would step over it forever. `mint` is `unscheduled`, not `cpu`: it is
  born running and the pump never sees it.
- **`slots` replaces `running` AND `starting`.** The slot is taken at
  the moment of choosing, before any await, so the window the flag
  existed to cover is closed by the occupancy every later pump reads.
  The slot outlives the child (released at the end of the whole run,
  not at the child's exit), which is what the single slot did and what
  keeps a landing from being raced by the next row's rotation.
- **Drain is the same three facts, counted across lanes**: nothing on
  the board, nothing queued, no live detached run. Measured firing once
  at the end of a three-job board (`keepServerWarmMinutes` defaults to
  0, so an early drain STOPS the reading server — treated as
  correctness, not tidying).
- **The shelf draws lanes only when the board holds two kinds of work**;
  one lonely job still draws the flat list it always did. The running
  row grew a second line carrying the engine's own last sentence — the
  step Owen asked to see — instead of it being crammed onto the count
  line at 80 characters.
- **The landing arms were walked** for serial assumptions and the walk
  found the ledger already defended: every catalogue write is
  `withManifest` (a promise chain per project), every book file write is
  `oneWriterOf` (per target path), `landReadProducts` PROVES which
  reading the position names rather than assuming, and
  `materializeTranslation` resolves its own step by payload rather than
  by the pointer. ONE newly reachable race, reported and not fixed:
  `rotateGenerated` / `rotateFinal` refuse when `archived-<stamp>`
  already exists, and two rotations in ONE project inside one
  millisecond would now be possible (before, never). It fails loudly
  before the engine starts, moves nothing and loses nothing; the fix if
  it is ever seen is a free-name suffix in `stampedArchive`.

DEFERRED OUT LOUD, unchanged from Wave 16: the queue still has no
persistence, so a held read is still lost on restart, and the lanes do
not make that better or worse.

### Wave 30 — the glance obeys the click (Owen, 2026-08-22) — BUILT (this commit)

Owen's ruling on Wave 23's page glance, verbatim intent: it appears
only when a block is CLICKED (not on hover-rest); it sits to the RIGHT
of the page, outside the visible paper, unless it will not fit — then
it may sit where it does today; and with multiple blocks selected it
does not show at all. All three built, in two files.

- **THE CLICK IS THE ONE THAT WAS ALREADY THERE.** No new gesture and no
  new listener: `release`'s plain branch already made a block THE
  selection, and it now also aims the card. Clicking the next paragraph
  re-aims rather than opening a second card, because there is one card
  for the same reason there is one selection. `GLANCE_REST_MS` (180 ms)
  and its `pointerenter` timer are deleted with a gravestone — Wave 23's
  rest-not-enter argument was RIGHT FOR A HOVER TRIGGER and the hover is
  what went, so the reasoning is kept in the stone rather than thrown
  out. The timer is deleted rather than set to zero: a zero-length rest
  is a hover trigger wearing a constant's clothes.
- **THE CARD STANDS IN THE BENCH'S DEAD SPACE WHEN IT FITS.** One inline
  `left` decides both placements — an over-constrained absolute box
  ignores its `right` in LTR, so the fallback needs no class and no
  `@media`, it is simply the component's own stylesheet unchallenged.
  Measured, root font 13px: sheet `min(46rem, 92%)` = 598 px, card
  15rem = 195 px, wanting 195 + 12 + 12 = 219 px of margin. A 1280 px
  bench leaves 341 px a side, so it fits with 122 px to spare. Below
  ~1038 px of bench the 92% rule takes over and dead space collapses to
  4 % a side; the aligned pair's columns are narrower still. **The
  fallback is not an edge case, it is what a laptop sees.**
- **THE WIDTH IS READ OFF THE ELEMENT, WHICH IS WHY `display: none`
  BECAME `visibility: hidden`.** Wave 23 paid for a `px` constant in
  book-view mirroring a `rem` width in page-glance — root font 13px, the
  constant said 256 about a box that renders at 195, and the card landed
  on the paragraph being read. A box with no layout has no width, so
  keeping `display: none` would have made the FIRST click of every
  session measure zero and fail the fit. Everything `display: none`
  bought is still bought: invisible, out of the a11y tree, no pointer,
  no room in the flow (it is absolutely positioned).
- **MULTI-SELECT: REFUSED AT THE GESTURE, CLEARED AT THE BACKSTOP.**
  Alt-click (whole category) and Ctrl/Shift-click dismiss and never
  summon — *the rule is about the gesture, not the count*, so a Ctrl
  click that happens to land back on one block still does not summon.
  An effect on `chosen().size > 1` catches every other door (marquee,
  split's two halves, join, a panel reaching through the stack). **It
  CLEARS rather than masks, and that asymmetry is the ruling**: a
  computed that merely hid would resurrect a card aimed ten gestures ago
  the moment a selection fell back to one. The glance answers a click.
- Dismissed by Escape (which now puts down both cards — one key,
  because a reader cannot tell which of two handlers they are
  addressing), by a click on no block, by the register flip and by a
  load. **The card no longer goes on `pointerleave`** — a card somebody
  asked for does not leave because the hand moved.
- Re-placed on a PANE resize rather than `window:resize`, hooked into
  the `ResizeObserver` that was already there: the dead space is a fact
  about this pane and changes when the left nav or inspector opens
  without the window moving. Only the placement signals are written, so
  page-glance's one effect does not run and **no page is re-rendered by
  dragging a window edge.**
- **NOT DONE, SAID OUT LOUD:** no vertical clamp against the viewport
  was added. The card is ink in SHEET coordinates — that is what lets it
  ride a scroll instead of being chased down one — and a viewport clamp
  is a promise that frame cannot keep past the next wheel click. Today's
  top clamp (`GLANCE_GAP`, off the paper's head margin) is unchanged and
  there is still no bottom clamp, exactly as in Wave 23.
- **NOT DONE, SAID OUT LOUD:** there is no ✕ on the card. The ruling
  named "the existing close affordance" and there has never been one —
  the card takes no pointer. Escape and a click on empty paper are the
  two outs, and `press`'s own comment notes there is little empty paper
  on a dense sheet, so if that bites, a ✕ (and the `pointer-events` that
  comes with it) is the next move.

Gates: 418 pass / 0 fail, root `tsc`, both app tsconfigs, `ng build` at
**738.63 kB** (WARNING, pre-existing; baseline re-measured at 737.93 kB
on `cf995c5` in a clean worktree, so this wave is +0.70 kB), control-byte
scan clean on both touched files. The build was gated in a detached
worktree because another agent's in-flight capture edits were in the main
tree and broke the Angular compiler on files this wave does not touch.

### Wave 34 — the minted book opens as pages (Owen, 2026-08-22) — BUILT (this commit)

> *"when i do finalize, it creates 'this book' in the worktree. correct. but
> when i click it, i expected it to take me to a pdf-like layout (even if we
> havent assembled into a pdf officially yet) where i can scroll through each
> page as it would look in a pdf. then i can run OCR on it, then i can strike
> things… thats what i expected."*

**What the click did, traced before anything was written.** The minted row
stands on a step whose picture the router had no third branch for: `sheet`
sent a row to the proof sheet, everything else went to `showDocument`.
`documentAtPosition` answered a mint with `archive/<stem> pages` — a
DIRECTORY, because `exists` says yes to one — the renderer handed it to
`openFile`, `openDocument` read no extension off it and refused, and the
app announced that the pages were no longer there while they sat on the
disk. The ROOT row (the capture step) resolved to nothing and revealed
whichever project tab came first, which is why it looked like the click did
nothing at all.

**The brief's premise was stale and Owen's own parenthesis is why.** There
is no minted PDF to open: the mint has written page images and no container
since `ecbf238` (2026-08-20, Owen's *"i agree that this doesnt need to be a
pdf"*). So the smallest honest answer is not a route into pdf.js — it is
the pages, drawn as pages.

- **`positionView.pages`** — the third picture, spelled once
  (`mintedFromPhotographs`: an import step WITH a parent is a mint by
  construction). Main resolves documents by the same test, so the surface
  and the resolver cannot disagree about one click.
- **`documentOfStep` answers null for a mint**, which is what "this row
  names no document of its own" has always meant. Nothing consumed the
  folder: the two callers that once tested the position's document for
  `.epub` were rewritten waves ago.
- **A fourth tab kind, `pages`**, path = the project directory, contents
  re-asked on every pointer move — the book tab's shape, over pictures. So
  standing on an older mint still opens THAT mint's book. It joined at
  `pathIsProject` and nowhere else, which is that predicate's promise kept.
- **`app-pages-view`** — one scroller, `<img loading="lazy">` with an
  `aspect-ratio: auto <ratio>` box so a 400-page shoot is not fetched at
  once. `capture:pages-load` lists the names and mints a token; the
  pictures come back through the EXISTING capture host, whose token now
  covers two directories (`captureServedFile`). No new protocol host.
- **The light table keeps every door.** *Edit the photographs* is gated on
  the project being a capture, so it lights from the page view too; and the
  capture row now shows the table BY RULE (`showTable`) rather than by the
  accident of a project having had exactly one tab.
- **The OCR dialog was a REGRESSION WAITING** and is fixed in the same
  breath: its source list keyed off `kind === 'capture'`, so pressing OCR
  in front of the pages would have met *"Open a PDF first"*. Both faces of
  one project now qualify (`photographed`), and they name one directory, so
  the reading is identical either way. Verified from source, not assumed:
  the picker never went through the import step's payload.
- The minted card in the tree is called **The pages**, not *The original*.

**NOT DONE, SAID OUT LOUD:** no zoom, no page counter, no thumbnail rail on
the page view — it shows and holds nothing, and every one of those is a
control somebody has to ask for. No image PDF export either; that is still
the deferred *"if the user explicitly wants to export it as one, they
can"*. And a drop onto the page view is not routed to intake, because the
window's drop handler reads the FRONT TAB and the front tab is a finished
book — if that bites, it is one clause in `intaking`.

Gates: the lead runs them. Scoped: root `tsc`, both app tsconfigs clean.

**SUPERSEDED BY WAVE 41, AND THE BRIEF'S OWN PREMISE IS WHY.** This wave
opened by recording that *"the brief's premise was stale"* — Owen expected
pdf.js and there was no PDF to open, so the smallest honest answer was the
pages drawn as pages. Wave 41 makes the premise true instead: the mint
assembles the PDF, so the minted row opens in pdf.js, which is what the
quoted brief asked for verbatim. Retired with it: `app-pages-view`,
`capture:pages-load`, the fourth tab kind, `positionView.pages`,
`showPages`, `documentOfStep`'s null-for-a-mint arm, and the OCR dialog's
`photographed()` second face. WHAT SURVIVES: the light table keeps every
door (*Edit the photographs* is still gated on the project being a capture,
and `showTable` still draws the capture row by rule); the minted card in
the tree is still called **The pages**; and the three NOT-DONE items above
are answered by a PDF viewer that already has a page count and a scroll.
The deferred image-PDF export is answered too — the container exists, and a
Save from the minted book copies it out.

### Wave 41 — the mint produces a PDF, and a captured project becomes ordinary (Owen, 2026-08-22) — BUILT (this commit)

> *"maybe we should mint a pdf from the pages after theyre fully arranged
> and complete, and then we build the bank after that (not necessarily from
> the pdf, but the pdf can exist so it doesnt confuse bookforge or anything
> else). the pdf is just the images on each page."*

and, on being told this would also retire the night's pages-face patches:

> *"this might fix our current problem as well. the system isnt trying to
> sift through images, it's using the original pdf just like it normally
> would."*

and, mid-build, settling the read:

> *"if we're building the bank from the images anyway maybe we should just
> build it from the pdf. why not? it would help maintain provenance, and
> nothing will be lost."*

**THE DEFECT THIS ENDS IS A CLASS, NOT A BUG.** BookForge's adoption refused
both of Owen's captured projects — *"records no imported original — its
catalogue's archive names no file"* — because a captured project's
`manifest.archive` was `{kind: 'pages', file: '<stem> pages'}`, a FOLDER.
Every consumer that asks a project what it was made from hit the same wall,
and three of them had been patched one at a time in a single evening (Wave
36's make-dialog faces, Wave 34's page viewer, Wave 37's figure `--pages`).
The ruling ends it at the source: THE MINT PRODUCES A PDF AS THE ARCHIVED
ORIGINAL, and from that moment a captured project is an ORDINARY project.

- **The mint assembles and catalogues.** `mintCommit` binds the rectified
  page JPEGs into an image-only PDF (pdf-lib, `embedJpg`, no re-encode, page
  box = pixels at a nominal 300 dpi) and `recordMint` files it exactly as
  `importDocument` files a scan: `archive/<stem>.pdf`, `manifest.archive`
  with `kind: 'pdf'`, the live copy in `working/`, and a `documents` origin
  row (`retention: 'irreplaceable'`, `WHY_MINTED`). `originalOf` answers,
  Home draws a book, the make-dialogs find a source, the figure cutter has a
  PDF, and a host reading the catalogue finds a file. The four writes are one
  function, `catalogueMint`, shared with the heal so the two cannot drift.
- **THE CALL ON THE FOLDER, STATED: a new mint leaves none.** The JPEGs go
  into the container byte for byte, so a folder beside it would be a second
  complete copy of the shoot kept for readers that no longer exist. MEASURED
  on Owen's star-gods: 179 pages, 126.1 MB of JPEG in, 126.2 MB of PDF out —
  the container costs 0.1 MB and nothing is decoded. The HEAL is the other
  way round on purpose and says so in its own comment: it KEEPS the folder,
  unreferenced, because a migration that frees disk by erasing the thing it
  was migrating has no way to be sorry.
- **The heal.** `healMintedArchive` assembles the missing PDF from the pages
  folder a project already holds (order = the folder's own zero-padded names,
  verified against the writer that made them), rewrites the manifest through
  `catalogueMint`, and re-points the mint step's payload at the PDF in the
  same `withManifest`. Once per project per process, on the figure heal's
  posture — a refusal is a log line and the project opens exactly as it did.
  AWAITED at `bookAtPosition` (so the container exists before anything reads
  `pdf`) and FIRED-NOT-AWAITED at `listProjects` (so Home and a host's
  adoption converge within a second of launch without a library screen held
  behind a migration). Proved end to end on a copy of Owen's real project:
  179 pages assembled in 1.5 s, manifest rewritten, folder still on disk.
  **The named cost:** a listing composed in the second before a heal lands
  draws that project as photographs. It is what it drew yesterday, it is
  recoverable by doing nothing, and `announceProjects` redraws it.
- **The retirement sweep**, each with a gravestone naming this wave:
  `app-pages-view` (deleted), `capture:pages-load` + `loadMintedPages` +
  `CaptureMintedPages` + the preload arm + the `FoundryApi` member, the
  `pages` TAB KIND and `pagesTabIn`, `positionView.pages` and `showPages`,
  `documentOfStep`'s null-for-a-mint arm, `ProjectSummary.pages` (every
  consumer now asks `originalOf(project) === null`, which is what they all
  meant), `BookLoad.originalPages` and the glance card's second sentence,
  `bookAtPosition.pages`, `writeBookFile`'s `pagesPath`, `ReadSourceKind` /
  `ReadingPlan.sourceKind` / `ReadRequest.inputKind`, `planReading`'s
  project-directory face, and the three make-dialogs' captured branches.
  **Clicking the minted book opens pdf.js**, which is Wave 34's brief
  verbatim.
- **WHAT IS KEPT, AND WHY** — the audit is in the wave's report, and three
  decisions are worth this file: (1) the ENGINE keeps `vlm-read --pages` and
  `vlm-book --pages` untouched, along with `BookFigures.from`'s `'pages'`
  member — that is engine surface area, and what retired is the app being in
  two minds about which flag it wants; (2) `ProjectArchive.kind` keeps
  `'pages'` as READ-ONLY history, because refusing the value at `readArchive`
  would make an unhealed project unparseable in the same breath as taking
  away the only thing that could heal it; (3) `archiveAfterLoss`'s pages arm,
  `destroyPayload`'s ask-the-disk, `documentArchive`'s narrowing and
  `readingState.needed`'s `'pages'` clause all stay as TRANSITIONAL guards
  for a project touched between launch and its heal.
- **`mintedFromPhotographs` survives** with one caller: the library tree calls
  a minted row *The pages* rather than *The original*, which is a true and
  lasting difference between a book somebody dragged in and one this app
  printed out of photographs.
- Gates: 418 pass / 0 fail, root `tsc`, both leaf configs, `ng build` complete
  with the pre-existing budget WARNING at **756.21 kB** (760.68 at the last
  landing — the sweep took 4.47 kB off). Control-byte scan clean over every
  touched file. IPC: **84 handles / 84 names, down from 85**, and
  docs/IPC-CHANNELS.md is regenerated — including the correction that its own
  count had been reading 71 against a source measuring 85.

### Wave 42 — the version floor (proposed at the vendor, 2026-08-22) — RULED-PENDING

Found by BookForge at the f5af135a vendor and CONFIRMED here from source:
the engine a hosted read spawns is whatever binary is installed, the
app's version probe feeds the settings screen and nothing else, and a
70-commit-stale engine RUNS QUIETLY under an app that expects ten of
those commits' behaviours. A fallback wearing a version number. The
proposed floor: the app refuses an engine older than the version it was
built against, with a sentence naming both versions and the rebuild
command. Awaiting Owen's word; the immediate gap is closed operationally
(fresh 0.9.2 artifact built at 98031b0, component refresh in front of
Owen).

### Wave 44 — the spine is translated too (Owen, 2026-08-22) — BUILT

> "when i translate, does it translate the chapters in the spine as well?
> the chapter names on the green dotted lines? if not, id like it to.
> everything should be translated."

It did not. `translated()` re-titles a chapter from its heading row's
translated text, but ONLY where the title is provably a copy of that
heading's source text (`titledFrom`). A division a person renamed is a
keyless human string no row of the book says, and a part divider's label
is composed by the page classifier out of two blocks — neither can be
proved to be a copy of anything, so both carried into the translated
book VERBATIM. A book whose paragraphs were all English under a contents
page still in German.

**A TITLES PASS IN THE RUN, and the whole of it rides machinery that
already existed.** `bookTitlePlan` (src/translate/bookrows.ts) reads the
divisions out of the book file the app ALREADY hands over — the position
materialised, renames replayed in — and returns the ones no heading
answers for. They become `PendingBlock`s like any other: same text-level
masking with the round trip checked, same chunking (batched as one
numbered-lines request; a book's worth of titles is one request beside
the two thousand a book costs), same verification, same retries, same
refusal discipline, same records file and therefore the same cost cache
and the same resume. Their answers are appended as records keyed
`chapter:<division id>` — a third spelling of a position in a field that
already carries two, argued at `chapterPosition` (src/translate/records.ts).

**Nothing new crosses the app/engine boundary, and that is deliberate.**
The plan asked for the titles to be computed app-side and passed in;
they are already in the file on `--book`, which is `materializeBook`'s
output with the chain replayed. Respelling them on the command line
would have been two spellings of one fact — the thing this codebase
refuses about `--epub` and `--book` in the same command's own refusals.
So the app-side change is confined to reading the new rows.

**The order at materialization is the correctness**: copy-derivation
first (free, and the only order under which the spine and the chapter
head cannot disagree — `relabelNav`'s measured failure), the title record
second, the source text third and named. A records file with no title
rows in it — every translation already on disk — lands on exactly the
old behaviour, which is what makes the format change safe in both
directions.

Also closed by this: the part-divider cost in §7.

### Wave 45 — the sweep: a census of a pattern, verdicted (Owen, 2026-08-22) — BUILT

> "give me the ability to detect things in parentheses, light them up, and
> strike them selectively. maybe line them up in a list and i scroll
> through and click what i want to keep or delete from the blocks. theres
> a lot of (see sandoval p. 170), etc. stuck in this one book… maybe i
> should be able to regex search for something, have it listed in the
> list, and selectively delete/keep them as well."

A census modal (Owen chose direction A over the in-place "lit galley" on
the design canvas): preset chips for parentheses and brackets plus a free
regex field, every match listed with its sentence quoted and the span lit,
a CUT/KEEP verdict per row starting from all-cut, `Keep all`/`Cut all` as
the two workflows, and a landing verb that names its count. A span cut is
a `text` op with the seam mended; a match that empties its block is a
`strike`; one variadic push lands the sitting and the tray's Apply flow is
untouched. On a translated pass the sweep does what the hand does —
serial record corrections for spans, ops for strikes. The full contract
is **docs/SWEEP.md**; deferred out loud there: saved patterns,
multi-pattern sittings, batch undo, cross-block matches.

**Built whole, §2.7 included** — `core/sweep.ts` (the scan, the seam and the
plan, as pure functions), `SweepDialogComponent`, a `Sweep` tile between OCR
and Translate, `UiService.sweepOpen`, and two new members on `BookStack`:
`translated()` and `correct(id, text)`, the second wired straight to the
viewer's own correction machinery so the one-in-flight rule, the load ticket
and the book refresh stay in one place.

**Four divergences from the contract, each argued where it is built.** (1) A
SHELVED ROW IS NOT SWEPT: it is in the file and not in the flow, so `reveal`
cannot travel to it and no edition emits it — a verdict about it would be a
verdict about text nobody can see. (2) The verdict inks are the SHELL's
`--error` and `--warn`, not the paper's `--ink-strike` / `--ink-flag`: those
are declared on the book viewer's own host and mixed for a cream sheet, and
the same hex on charcoal is a strike nobody can read. (3) A VIEW-ONLY TAB IS
REFUSED at the tile and again in the card, because the viewer's `push` refuses
one with a sentence and the card would otherwise have closed and announced the
cuts on top of that refusal. (4) The seam's both-sides-whitespace clause keeps
a NEWLINE over a space where the two meet, since a line break inside a block
is structure a person can see.

### Wave 46 — the apparatus survives the scan's spellings (Owen, 2026-08-23) — BUILT (this commit)

Diagnosed on evangelische-kirche, the first book through the capture →
mint → read path: 72 loose markers and 31 orphaned notes, and every one
of them traced to the SCAN's spelling of a fact the engine already
handles — not to the translation that made them visible. Three engine
fixes, two bench fixes, all landed together:

- **A note lead may wear a period.** `ASCII_NOTE_LEAD` admits
  `1. Die Bezeichnung…` beside `1 Die…` (dots-book.ts); the period rides
  in `run` so every caller that slices the lead takes it too. Four notes
  on the user's own page 11 stood orphaned on this alone.
- **A `<sup>34</sup>` the model wrote as HTML becomes the codepoints**
  at the parse (`foldSupTags`, dots.ts), so a rebuild from the bank
  heals a book read before the fix — ten blocks carried literal tags,
  and the translator welded their digits to the prose ("Reich Bishop34").
- **A footnote the model filed as `List-item` is adopted back**
  (`adoptListItemNotes`, dots-book.ts): note lead + not measurably
  body-sized + (its number cited as a superscript on its page or the
  page before, OR it continues the page's note sequence). 73 adopted on
  evangelische-kirche; the genuine numbered lists on pp. 33/36 refused.
  `typeSizeIsMeasured` (typography.ts) is the new honesty seam: the
  40 px `lineHeight` estimate reads small type as body type, so an
  estimate neither convicts nor acquits.
- Rebuild verified against the real bank: 382 markers linked, ONE loose
  marker (its note never transcribed), ONE orphaned note (the `*`
  asterisk-note, which has no number) — from 72 and 31.
- **The sienna ordinal counts the page's notes** (book-view `linesOf`),
  not `row.note` — which is "which note of its BLOCK" and wore "1" on
  every note once the model answered each note as its own block.
- **A chip pressed inside a multi-selection recategorises the whole
  selection** — the chip carries the count, the list says the plural
  before it happens, one push so the gesture is one thing.

The same walk's second half — Owen: *"go ahead and fix everything"* —
landed the three that were deferred above, later the same day:

- **The original panel** (BUILT) — and the name is Owen's correction:
  *"shouldnt be facsimile comparison, it should be pdf comparison.
  facsimile is created after dots runs… i want the original pdf
  comparison, so i know what im looking at and how to correct it if
  dots makes a mistake."* The page-glance card retired into
  `./original-panel` — a full-height column docked at the pair's right
  edge, toggled by "Original" in the head row, drawing
  `BookLoad.originalPath` (never the facsimile). It follows the reading
  — the click that selects a block and the bench's own scroll both aim
  it (`followOriginal`, signal written only when the topmost block
  CHANGES) — with a vertical nudge putting the aimed block's printed
  box a quarter down the panel. Steppers page freely (parked), ⌖ and
  any new aim come home. "Original" and never "compare" in the names:
  compare is the app's word for standing two STEPS side by side. The
  card's placement arithmetic died with the card; gravestones at the
  old mount and over `GLANCE_GAP` carry the succession.
- **Tables translate, cell by cell** (BUILT — book-rows route) — the
  fix that un-Germans the printed TOC. `src/translate/tablecells.ts`
  reads a Table row's grid with the engine's own XML parser and
  splices translated cell text back right-to-left; the model never
  sees a tag, which honours the old refusal's whole argument. One
  record per Table ROW at the row's own id, holding the reassembled
  grid (a `#c<n>` key would match no row and be dropped as stale).
  Folio cells — no letters, or a canonical Roman numeral — are carried
  untranslated and counted; `DC` is knowingly carried as though it
  were 600 (the status-quo direction; the cell beside it translates).
  A partial grid is written KEYLESS so the next run asks again instead
  of freezing a bad evening's refusals into the file. THE CAST ROUTE
  (`--epub --records`) STILL REFUSES TABLES WHOLE — its docblock now
  names the three pieces the wiring needs (positionOf on the stamped
  wrapper, findBlocks handing back the inner range, a document-source
  splice) so nobody rediscovers them.
- **The EPUB metadata door** (BUILT) — `meta:read-epub`/`meta:write-epub`
  IPC beside the PDF pair; `canEditMetadata` admits an export view
  (`isExportView`: a `book` tab, viewOnly, `.epub` in `final/` — there
  is no EPUB tab kind, and the ONLY editable EPUB is a finished
  export); the dialog's EPUB arm unblocked, saving through the same
  ledger-step/payload path as the PDF arm with `kind: 'epub'`.
  `writeEpubMetadata` was never callable as audited (it passed no
  `--out`, the engine's directory form) — re-aimed at the file through
  a `.meta-tmp` side file and one rename. Known and accepted: the
  export tab is not marked modified after a save (the file on screen IS
  the file just written), and `dc:` edits do not repaint the proof
  sheet.

And the evening's two corrections, caught by Owen on the running app:

- **Side by side, centred** — with the original panel open the sheet
  centred itself in the leftover and the panel hugged the far edge. Now
  `.pair.original` centres the two as one group: the bench's basis drops
  to just over the sheet's own 46rem and the pair justifies centre —
  pure flex, nothing measured, closing the panel restores every rule.
  (Two of this codebase's own recorded pitfalls were re-paid on the way:
  a backtick inside the styles literal, and — new to the list — a CSS
  comment closed with the HTML `-->`, which legally ate every rule from
  `:host` to mid-`.frame` and no gate can see it. Found over CDP.)
- **The work tree told a lie about captured books** — Owen: *"if we're
  deriving the bank from the pdf rather than the original images then
  the work tree is deceptive."* The read step was parented at the
  CAPTURE root while `planReading` reads the minted PDF. Fixed at the
  rule (`documentOriginOf`: the newest mint owns the document; used by
  the plan, the landing, the re-read preview and step-standing), healed
  in every existing ledger on read (`healReadParents` — reparent to the
  newest mint at or before the read; heal-on-read, persist-on-write,
  readLedger's own pattern), and re-worded where the tree draws: the
  root of a captured book is *"the photographs it all started from"*,
  the mint card is **The scan** (it opens the PDF; "The pages" was Wave
  41's leftover from when a mint wrote loose images), and the book row
  reads *from The scan* — which is the true chain: photographs → scan →
  book.

### Wave 47 — the press names a file, and the mint asks who the book is (Owen, 2026-08-24)

**Ruled and BUILT — the dock names the file.** Owen, after the German
narration of an English book: *"yes, it should name the file im actually
exporting. not generically."* The dock's book-currency branch no longer
speaks the position: it names the export being VIEWED when the focused
tab is one of this project's finished EPUBs, else the one finished EPUB,
else a pick-in-the-tree sentence; with no export at all the make-one path
survives only from a position that names itself — an arrival-parked
position gets a sentence instead of `hostActPositionFrom`'s silent hop
onto the reading (the hop that chose German). The mapping survives for
tree row presses, where the row says which lineage was meant. BookForge's
half (their sweep learning `stepId` from the tray; the auto-export guard)
is theirs.

**DESIGNED, AWAITING OWEN — the mint-time metadata modal.** His ask:
*"just tell foundry to design this modal and make sure it has the options
that bookforge contains."* The design, mirrored field-for-field on
BookForge's metadata editor and naming pass:

- THE EXPORT DIALOG GROWS THE FORM — one surface already stands before
  every mint, and a second modal stacked on it would be two doors to one
  decision. Fields: title; subtitle; AUTHORS as an array of {first, last}
  with add/remove (combined display "First Last, First Last"; a comma in
  an ingested single string means it is ALREADY "Last, First" — Owen's
  2026-08-16 rule, never re-invert); year; LANGUAGE as a select
  (en/es/fr/de/it/pt/ja/zh) PRE-FILLED FROM THE POSITION — a translate
  step's `to`, else the read's language — which is the load-bearing field
  this whole incident was about; cover picker with true-aspect preview
  (EPUB embedding rides the deferred packageVlmEpub cover wave; until it
  lands the cover is stored and announced, not embedded).
- INHERITANCE: `project.json` gains a `meta` block the modal reads and
  writes — seeded once from the manifest title, the archive's Info
  author, and the position's language; every later mint pre-fills from it.
- THE FILENAME, BookForge's convention exactly (their
  computeDescriptiveFilename + generatedFilename): `Title[ - Subtitle].
  Authors. (Year).ext`, year at the end, each segment owning its own
  leading ". "; authors as "Last, First" / "A and B" / "first et al.";
  collapse double dots in the base, collapse whitespace runs; the ON-DISK
  name ASCII-folded (diacritics stripped, ß→ss) with <>:"/\|?* → _ while
  embedded metadata keeps real Unicode. Live-generated; a manual edit
  stops regeneration; focusing the empty field seeds it with the
  generated name. One shared implementation in app/shared.
- HOST MINTS (`exportEpubFromStep`) show no modal: metadata comes from
  the stored `meta` — except LANGUAGE, which always follows the step's
  own chain, because an auto-export of a German step must say de whatever
  the project's stored preference is.
- THE LANDING CARRIES IT: `ExportLanding.metadata? { title, subtitle?,
  contributors[], year?, language?, filename }` so BookForge's variant
  records inherit the mint's own declaration (their ask; shape proposed
  to them, pending this design's approval).
- 2b — THE NARRATE CONFIRMATION: the host-op dialog gains a target card —
  the file's name, title, authors, year and LANGUAGE (tinted as a warning
  when it differs from the project's newest translation) — so the wrong
  text can never queue unseen.

Still deferred OUT LOUD from that walk:

- **The cover** — a separate build-time wave centred on
  `packageVlmEpub`: a STATED image (Owen's ruling forbids inferring
  one, not stating one), zipped in with `properties="cover-image"` plus
  the EPUB-2 `<meta name="cover">`, chosen in the metadata dialog and
  carried as a metadata-step payload; a cover cannot ride the
  `epub-meta` stamp, which splices text and cannot add a file to the
  container.
- **Tables on the cast route** — see above; wire it when a cast
  translation matters again.

### Then — the user's

- **Phase G — the hand-test.** Import → read → strike and join on the
  book → apply → translate → chain a second language → strike more →
  apply → export at three positions → three correct final documents, plus
  the facsimile from the root. Not automatable, and it is where every
  real defect this month came from. The gates prove types and contracts;
  they have never once caught what a person clicking found.

---

## 5. Recovered halves — the things that had been forgotten

Kept as its own section deliberately: these were promised, dropped, and
found again by a sweep on 2026-08-15. The list is short because it is
supposed to be, and it exists so the same failure is visible next time.

1. **The manual join op.** When the ink test was killed, the deal was that
   ambiguous page-seams stay split and the user joins them with a recorded
   op. The reflow landed; the seams stay split; the op was never built. The
   cost landed without its compensation — the worst shape a dropped half
   can take. → Unit D3.
2. **Phase 0 (undo in memory).** Listed FIRST in DERIVED-BOOK's own phase
   plan, described as small and standalone, never executed; the
   persistence IPC is still registered. → Phase E.
3. **The branched-read overlay hazard.** Marked ARCHITECTURAL and unresolved
   in the project notes, half-addressed when banks went per-step, then left.
   → Wave 6.
4. **Exports lose metadata edits.** Not previously known at all — found by
   the Unit M survey. → Unit M.
5. **`canEditMetadata` never got its import-row gate**, though the ruling is
   recorded in a comment three lines above it. → Unit M.

---

## 6. Deferred ON PURPOSE — with the reason, so it is not mistaken for a gap

- **Fine-tuning.** Excluded by the user. The corrections-as-labels plan
  stands in the project notes for when it is wanted.
- **PDF-surface editing.** "i dont want to mess with editing pdfs right
  now." The PDF's future is view-and-produce-facsimile.
- **A bank-only join signal for caseless scripts.** Until it exists, a
  CJK book joins nothing automatically and every page turn is a manual
  join. Written down in DERIVED-BOOK §2 as a KNOWN COST with a known fix,
  so that when somebody imports a Japanese book and finds three hundred
  seams it reads as a price that was accepted, not a bug.
- **Compare-side-by-side as originally specced** (NEXT-WORK §3) —
  superseded, not dropped: "Open in split" and drag-to-edge split are the
  built form of it.
- **A facsimile that reprints struck footnotes.** The PDF branch forks
  before notes exist; block strikes reach it, note strikes do not, and
  page-faithful is what a facsimile is for. Recorded in WORKBENCH §8 as
  a deliberate asymmetry.
- **The metadata step does not un-apply values when deleted.** Deleting
  the record deletes the record. Same honesty curate already has.

---

## 7. Known and accepted, not scheduled

- **The app has no tests at all.** `test/` covers the engine only;
  `ledger.ts`, `pipeline.ts`, `projects.ts` and the whole renderer are
  held by typecheck and `ng build`. This is the largest standing risk to
  every app-side unit and the reason the hand-test is not optional. Not
  scheduled because the standing ruling is no unasked tests — if that
  changes, this is where the work starts.
- **The bundle is 801.07 kB against a 500 kB budget.** Pre-existing.
  It went 695.96 → 702.98 (Wave 23, the glance card) → 704.14 (Wave 21's
  mint-writes-pages) → 704.53 (the captured book's sentence) → 737.93
  (waves 24 through 32, unattributed between them) → 738.63 (Wave 30,
  the glance's placement) → 801.07 (waves 33 through 45, unattributed
  between them; the sweep itself measured +0.13 against the tree it
  landed on. Re-measured at Wave 45's landing, 2026-08-22 — this list
  had drifted a third time, reading 738.63 against a source measuring
  801.07, caught by the Wave 45 builder).

  The 737.93 baseline was re-measured on 2026-08-22 on `cf995c5` in a
  clean detached worktree, per this file's own rule below.

  **THIS FIGURE WAS 145 kB STALE AND IS THE SECOND TIME THIS LIST HAS DONE
  IT.** It read 552.88 kB here and 550.51 kB in §1 on 2026-08-20, when the
  build measured 695.96 kB — and the two spellings had drifted from each
  other as well, which is the tell. §1's own rule already names the class
  from the test suite ("a stale 396 pass sat here while the suite measured
  384, and a number nobody re-measures is not a gate"), and the same rule
  applies to every number in this file: A FIGURE QUOTED AS A GATE IS A
  MEASUREMENT OR IT IS DECORATION. Measured twice on 2026-08-20, on main
  at `e0e301c`, independently by two agents who agreed to the byte.

  It is still a WARNING rather than an ERROR, which is the thing the gate
  actually tests. What is left is Angular plus this app's own components;
  there is no second editing surface in it to remove. (R6c's deletions did
  take it down once — the only fall in this list's history — and the
  657.06 → 552.88 recorded for that is the last figure here anybody
  measured at the time they wrote it.)
- **`epub-final` writes with `Bun.write`**, so the Save-As edition path is
  not atomic where the old repack was. Same as the queue's `final/`
  writes. Flagged when it landed rather than buried.
- **The reported footnote count includes struck notes** in edition mode
  (the counter mints ids book-wide; returning the emitted count would make
  two chapters share one). Documented at the filter.
- **D1's new machinery has no suite behind it** — the text masker, the
  un-renderer that recovers flowing text from a cast, the records file and
  the substitution were verified by throwaway scripts against a real cast
  and then the scripts were deleted, per the no-unasked-tests ruling. The
  builder named this as the one honest gap in the unit, and it is repeated
  here rather than left in a report nobody re-reads. If the testing ruling
  ever relaxes, this is the second place to spend it (after the app).
- **D2's named costs, kept visible until their closers land.** (1) An
  edit to source text under a translation yields STALE translated text
  at export until the translation is re-run — records are looked up by
  position, so materialization substitutes what was recorded. Ruling 7
  (unit D3) is what closes this; the old pipeline hid it by re-asking
  the model at export time. (2) Home's per-type EPUB list loses
  translation rows for records-mode translations — a translation's
  book is a rendering and renderings are uncatalogued, like a save's;
  the library tree still shows the step. (3) ~~Re-translating a row
  whose book is open in a tab leaves the old cast showing~~ — **CLOSED
  AT R6c**: there are no casts and no working trees, so there is
  nothing to be stale and nothing to refuse. A translated position is
  the proof sheet over the derived book its landing wrote.
- **The bundle figure was 573.44 kB and is 552.88 kB.** It went
  657.06 → 552.88 at R6c, which is the first fall in this list's
  history; the entry above carries the standing figure.
- ~~**`app/shared/unrender.ts` is a deliberate second copy**~~ —
  **CLOSED AT R6c.** The file is deleted. Its only consumer was the
  word-mirror that carried an edit out of a cast book's markup back into
  the curation, and that whole path went with the iframe reader
  (RENDERER.md §7). There is one inline table in the app again — the
  renderer's own, in `shared/ops.ts` via `shared/inline.ts` — so the
  drift this line was written to warn about cannot happen.
- **D3 has no independent review.** Every other app-side unit this
  week got a second agent over its diff. This one's was killed by the
  wrap-up. Named here so it is a known debt, not an assumption of
  parity.
- ~~**A part-divider's composed label stays in the source language**~~ —
  **CLOSED AT WAVE 44**, on the route every export now takes, and the
  closing is worth stating precisely because the cost was recorded about
  a route that has since stopped being reachable.

  What was true: `vlm-convert --records` mints the nav from `body.label`
  at compile, read off the substituted heading, and a part divider's
  label is composed by the page classifier out of two blocks before any
  substitution exists (`sectionName`, src/vlm/dots-book.ts). That
  sentence is still true OF THAT COMMAND and is left standing in its own
  docblock. It is no longer true of the app: `compiles` is
  `epub || txt`, so every EPUB and every plain-text export materialises
  the position's book and compiles THAT (`planExport` → `vlm-compile
  --book`), and there the chapter names come from the book file's header
  and nowhere else — *"THE HEADER IS THE ANSWER AND THERE IS NO SECOND
  OPINION"* (`spansOf`, src/vlm/compile.ts). A composed part label is a
  `header.chapters[].title` that no heading is a provable copy of, which
  is exactly the population Wave 44's titles pass asks the model about
  (`bookTitlePlan`, src/translate/bookrows.ts). Verified end to end
  against a book file carrying `TEIL III: WIDERSTAND` over a heading
  reading `TEIL III`.

  **The residue, named rather than left implied**: a title that IS a
  provable copy of a heading the model then REFUSED. The proof held, so
  no title was asked; the heading came back in the source language, so
  nothing derives; the title carries and `Translated.untitled` says
  which. Closing it would mean planning the titles after the work, which
  puts a growing denominator in `block N/M` — the one number the app's
  progress bar is drawn from.
- **Hosted, the held bench is reachable while documents remain open**
  (8b). Closing the shown document lands on the quiet bench even when
  other documents are still open — before the single viewer, the strip
  fell back to a neighbour, so a hosted window always had a document
  up. The bench's "Back to the library" button points at a Home this
  hosted window deliberately hides behind the hero drop target. Named
  by the 8b builder; accepted rather than special-cased, because the
  bench also says the tree is one click away, which is true and is the
  way back a hosted user actually uses.

---

## 8. Session hygiene

- Push everything to main; the user has standing authorization.
- Never write into `C:\Users\tellt\Documents\Foundry\projects\` — user
  data, read-only for verification.
- Agents die when the session limit hits. Their edits either landed on
  disk or did not; `git status` is the only truth about it, and a resumed
  agent must be told so explicitly rather than trusting its memory of what
  it wrote. (This happened on 2026-08-15 to both wave-2 units; the tree
  was clean and both rebuilt from scratch.)
