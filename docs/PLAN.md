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
- **Five gates before any report, every unit**: `bun test` (396 pass at
  `da96196`); root `bunx tsc --noEmit`; from `app/`:
  `bunx tsc -p tsconfig.electron.json --noEmit`,
  `bunx tsc -p tsconfig.app.json --noEmit`, `bunx ng build` (the
  550.51 kB against a 500 kB budget WARNING is pre-existing; an ERROR is
  not). Plus a raw-control-byte scan of every touched file.
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
   the stack to the ledger step and clears it; closing without applying
   scraps it. Standing on any step = base bank + replay of the chain.

3. **Then the deletions.** `working/` trees, `setBlockCuts` and the
   splicing family, `overlays/*.json`, `curations/*.json`,
   `curation-lock.ts`, the generation reconciliation, the per-step
   EPUBs. This is most of Phase E and it is subtractive.

4. **The renderer itself** — the user's direction is Angular-native
   rather than an iframe of somebody's markup, on the grounds that
   Foundry generates these books and sanitises the one kind it does
   not. Not specced yet; it does not block 2 or 3.

### Wave 5

- **Phase E — retire the old surfaces.** The html-editor machinery (dead
  since its buttons went), `history.ts`, **and DERIVED-BOOK phase 0**
  (undo goes in-memory — specced first, executed never; both undo
  persistences retire together), nav-label/page-heading ops moving into
  the ledger, the PDF reduced to view-and-produce-facsimile. Deletes what
  C, D and K replace, so it goes last.

### Wave 6

- **The branched-read overlay ping-pong.** Banks went per-step; the live
  overlay did not, so hopping between two read branches archives the
  working corrections back and forth. Half-fixed for months, now
  scheduled: per-read-branch overlay files on the bank scheme.

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
- **The bundle is 550 kB against a 500 kB budget.** Pre-existing; Phase
  E's deletions should move it down rather than up.
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
  the library tree still shows the step. (3) Re-translating a row
  whose book is open in a tab leaves the old cast showing until the
  next cast — the recast is refused while a working tree is held, and
  logged.
- **The bundle figure is 573.44 kB** (550.90 → 565.23 with D2's
  dependency reinstall, → 573.44 with D3's renderer additions and
  `unrender.ts`). Still a WARNING, not an ERROR; Phase E's deletions
  should move it down.
- **`app/shared/unrender.ts` is a deliberate second copy** of the
  engine's `flowtext.ts` inline table — the app never imports the
  engine. Verified byte-identical on eight emitter constructs. **If
  `dotsInline` grows a tag, both tables grow**; there is nothing that
  will remind you but this line.
- **D3 has no independent review.** Every other app-side unit this
  week got a second agent over its diff. This one's was killed by the
  wrap-up. Named here so it is a known debt, not an assumption of
  parity.
- **A part-divider's composed label stays in the source language** under
  records materialization (e.g. `PART III — RESISTANCE`). Nav labels and
  headings translate, because they are read off the substituted heading;
  a part divider's label is composed by the page classifier before any
  substitution exists. Found and recorded by D1 rather than papered over;
  a fix belongs with whoever owns `partVerdict`.

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
