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

### Wave 20 — the capture stage: photographs become the book (Owen, 2026-08-19) — PLANNED, docs/CAPTURE.md

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
- **The bundle is 552.88 kB against a 500 kB budget.** Pre-existing.
  R6c's deletions took it from 657.06 kB — the first time it has ever
  moved down — and it is still a WARNING rather than an ERROR. What is
  left is Angular plus this app's own components; there is no second
  editing surface in it to remove.
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
- **A part-divider's composed label stays in the source language** under
  records materialization (e.g. `PART III — RESISTANCE`). Nav labels and
  headings translate, because they are read off the substituted heading;
  a part divider's label is composed by the page classifier before any
  substitution exists. Found and recorded by D1 rather than papered over;
  a fix belongs with whoever owns `partVerdict`.
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
