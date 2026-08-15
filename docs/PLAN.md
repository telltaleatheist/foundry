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
| — | The specs for everything below, and this file | `f2a8141`, `da96196`, `fea8f6b` |

Phase C's premise was corrected by survey before it was built: struck
BLOCKS were already really removed (they die at `applyOverlay`, upstream of
the format fork). What leaked was struck NOTES, the editing stamps, and a
second untidied door. Recorded because the plan's own memory of itself was
wrong, and the next survey should be trusted over the next memory too.

---

## 4. In flight and next — the execution order

Fences are disjoint within a wave; a wave lands before the next starts.

### Wave 2 — Unit D1 LANDED (`cd919d0`); Unit M running

- **Unit M — metadata joins the ledger, and a curate step casts its own
  book.** Spec: WORKBENCH §9. Closes two deferrals from §3/§6 of that file
  AND a hole the survey found: exports silently lose metadata edits today,
  because the export casts fresh from the bank and the edit lives in the
  working tree's OPF. Also fixes `canEditMetadata`, which never got the
  import-row gate its own comment says it has.
- ~~Unit D1~~ — landed. The format it wrote is the contract D2 consumes;
  it is spelled out in WORKBENCH §10 rather than left in a report.
  Grouping came free rather than being rebuilt: the cast's own container
  markup already groups a list with its items, so `planChunks` and its
  siblings were reused verbatim. What D1 leaves for D2 (its own words):
  the one-hop refusal at `pipeline.ts:207-214`, the `landsUnder`
  generalization, `params.language` → `--from` wiring, and the
  "Translate (English → Hungarian)" labels.

### Wave 3

- **Unit D2 — the app switches to records.** Planning, ledger, sweep and
  seeding move to record files; **and CHAINS**: the one-hop refusal
  (`pipeline.ts:207-214`) comes out, `landsUnder` generalizes, a
  translate under a translate takes the parent's record text as its
  source. User-ruled 2026-08-15, reversing a same-day deferral of mine.
- **Unit K — the continuous book and chapter lines.** Spec: WORKBENCH
  §11. The whole book in one scroll; a chapter is a green dotted line
  wearing its title — drag to move, double-click to rename, click the
  gutter to add. Reverses the earlier "no dotted lines" decision. May run
  beside D2 if the fences verify disjoint.

### Wave 4

- **Unit D3 — the ops.** "Edit transformed text" (a human row in the
  records file, per-language by construction), "edit block text" mirroring
  to the overlay instead of dying in the working tree, and **the manual
  join op** — promised the day the ink test died, never built, recovered
  by the 2026-08-15 sweep.

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
