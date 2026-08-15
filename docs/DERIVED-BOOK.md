# The derived book — the settled architecture, and the plan to build it

Settled with the user 2026-08-15. This document is the handoff: it carries the
whole design so a fresh session can build from it. It supersedes the earlier
draft of this file and, where they disagree, every older document. Background
that still binds: `docs/STEP-LEDGER.md` (the step model),
`docs/BANK-LIFECYCLE.md` (banks swap on success, per-step paths, per-step
generations), `docs/TRANSLATION-STEPS.md` (translate steps, the pipeline —
which §6 below retires in place). The scout trace grounding the facts here
(assembler, editors, `history.ts`, `epub-final`, translate extraction) is in
the session notes; every "today the code does X" claim below was verified
against the tree at commit `f03a50c`.

---

## 1. The model, in one page

**The readings bank is the only truth a book has.** Everything else is a
projection: computed from the bank by deterministic passes, plus recorded
human decisions, plus recorded transform answers.

**Two sources, forked at the start, both trustworthy, mutually incompatible:**

```
                       readings bank  (per-page model answers — the truth)
                        /          \
        facsimile PDF              REFLOW (deterministic, bank-only)
        (paginated branch,          → the flowing HTML base
         terminal: produce            (paragraphs joined, hyphens fixed,
         facsimile and stop)           pagination erased, provenance kept)
                                          |
                                    ops + transforms (the ledger)
                                          |
                                    Generate, from any step
                                          → the final document
```

- **The PDF has exactly one function: produce the facsimile.** No PDF-surface
  editing now (maybe down the line). Per-page geometry belongs to the source
  language and to that branch alone.
- **All work happens on the flowing HTML base.** It is laid out exactly as the
  EPUB will be — an EPUB is effectively HTML — so the user edits the thing
  they will get. Deletions, text edits, joins, chapter markers: all made on
  the flowing page, all recorded as ops.
- **Save adds to the ledger; Generate executes it.** A save is a curate step
  holding the ops as they stand. Generate, from WHICHEVER step the user
  selects — the three block deletions, the translate step, or all the way
  back at facsimile production — replays that step's ancestry and produces
  the FINAL document in the requested format: ops applied, cuts really
  removed, footnotes tidied, zipped, opened for viewing. Generate is the one
  materialization verb; there is no separate "save as final".

---

## 2. The reflow — bank → flowing base

Runs as soon as the reading lands ("as soon as it's placed by the vlm").
Deterministic and **bank-only** — this is a hard ruling:

**THE INK TEST IS DEAD.** Today's cross-page paragraph join falls back to
sampling the page raster's ink extent (`carriesOver`,
`src/vlm/dots-book.ts:1142`). The user's ruling: *"the ink test is not
trustworthy — footnotes are often at the bottom of pages. We rely on the vlm
to tell us or do it mostly deterministically. Too many eggs in one basket."*
So the reflow joins on what the bank says, or does not join at all:

- **Join rule**: the textual test only — previous block does not end in
  terminal punctuation, next page's first prose block opens lowercase
  (`continuesTextually`, `src/vlm/dots.ts:681`), plus the hyphen-carry case.
  Both are pure functions of banked text.
- **Ambiguous cases do not join.** The cost is an occasional paragraph seam
  at a page turn. The fix is a **manual join op** — the user sees the seam on
  the flowing page, joins it, and the ledger records labour like any other
  decision. Machine passes are conservative; judgment is recorded, never
  guessed.
- Dehyphenation stays as built (`BookLexicon`, bank-pure). Running-head and
  page-furniture suppression stays. `consumeMarkdown` sub-splits stay.
- **Pagination is erased as structure; provenance is kept as metadata.**
  Every flowing block remembers its source parts `[(page, order, part), …]`.
  Invisible in the text; it is what keeps "which page did this come from"
  answerable, keeps records and ops stable, and keeps a future PDF-side
  feature possible.
- **Footnotes go to the end of the chapter** (the emitter already does this;
  the reflow owns it now).
- The flowing base is a REGENERABLE projection (bank + join ops → base), not
  a payload. The read step stays the payload-bearing row; the base is
  rebuilt deterministically whenever needed and may be cached.

**Chapters are proposed by the machine and owned by the user.** Detection
seeds the markers (today's `proposeSections`); the user approves or redefines
them, and redefining must be EASY and FAST because *"they'll likely have to
do it a lot — it doesn't often get it exactly right."* Chapter set/move/
remove are first-class ops on the flowing page (the overlay's `chapters`
spine already exists and carries over as their record).

---

## 3. Ops — every edit is a ledger entry

The op vocabulary IS the editor's vocabulary. Everything the user can do to
the flowing page is one of these, keyed by source parts, recorded in the
live decision set (today's overlay, generalized), snapshotted by a save:

| op | notes |
|---|---|
| delete block / restore block | the strike, as today |
| edit block text | source-level: invalidates that block's transform records (the source changed → re-asked) |
| edit transformed text | per-record, per-language: fixing an awkward sentence in the Hungarian touches the Hungarian only |
| set category | as today |
| join blocks | the manual paragraph join across a seam (§2) |
| set/move/remove chapter marker | the user owning the spine (§2) |
| nav label / heading text | document-level ops, same ledger |

- Deletes, restores, categories, joins, chapters: **source-level, universal**
  — made while reading any translation, applied to every projection, because
  nothing downstream stores its own copy of a decision.
- **The raw textarea editor is retired** (user ruling). A freeform byte
  editor has nothing to write to when the surface is derived. The in-place
  block editor's machinery (word-level validation, `refuseUnlessWordEdit`)
  survives as the text-edit op's guard.
- Undo/redo is **in-memory, per session**; commits are the durable history
  (NEXT-WORK §6, already specced — the close-with-uncommitted-corrections
  dialog that makes it safe is built and landed). `history.ts` and the
  working-tree persistence retire WITH the old editor, not before it.

---

## 4. Steps and Generate — the loop, stated by the user

*"If the user translates and then deletes 3 blocks, then saves: the translate
step is logged, and the save-changes step is logged with three removals. If
they click Generate sitting on that step, it generates a document that has
been translated (that happened before the deletions) and has the deletions
applied. Generate produces the final document they intend to use — the full
record of what they did is applied, and it's zipped and prepared for
download/use/viewing."*

This is the step model as built (`STEP-LEDGER.md`), completed:

- Every step keeps its identity rules, retention, staleness, per-step
  payloads and banks, and the replace/branch landing machinery — all landed
  this week, all kept.
- **Facsimile production is a generate-able point too**: standing at the
  start and generating produces the facsimile PDF. Reflow-descended
  positions produce reflowed formats (epub/txt). Translate-descended
  positions produce the translation. No step picker — the row is the picker,
  as ruled.
- **Generate's output is FINAL**: ops executed, deleted blocks really absent
  (not marked — the `data-bf-cut`-marks-survive-Save gap closes here),
  orphaned footnotes and nav entries tidied (`epub-final`'s logic runs as
  part of materialization), zipped, opened. The queue rules stand: a
  generate that can spend model time (a transform with cache misses) is
  held; a pure replay runs at once.

---

## 5. Transforms — translation, simplify, whatever is next

A transform consumes the flowing base's blocks (complete thoughts, no OCR
artifacts — the reflow guarantees it) and produces **records**:

```
{ parts: [(page, order, part), …], generation, key, text }
```

- `key` = hash of (transform, params, masked source text) — the existing
  question-keyed bank remains the cost layer: unchanged text is never asked
  twice, across branches, saves, and re-generates.
- Masking moves to text level (the successor of `maskBlock` one stage
  earlier): superscript note digits and emphasis survive verbatim.
- Records live per step (`readings/<key>.<tag>.records.jsonl`-shaped), owned
  by their step, swept with it, seeded by copy on a branch — all exactly the
  bank lifecycle already built.
- Strikes are never in the records; a strike is source-level and every
  language drops the block on replay.
- Translate-of-translate chains and showing translated text on the flowing
  page both fall out of block-keyed records for free.
- Transforms output reflowed formats only. (`TRANSLATION-STEPS.md`'s
  EPUB→EPUB pipeline shipped and works; it is the bridge and §6's phase D
  retires it.)

---

## 6. The plan — phases for build agents

Rules of engagement (unchanged all week): agents never commit — the lead
verifies and commits; five gates before any report (`bun test`; root
`bunx tsc --noEmit`; from `app/`: `tsconfig.electron.json`,
`tsconfig.app.json`, `bunx ng build`); long WHY comments in the codebase's
voice; escape backticks as \` in Angular template prose; never a raw control
byte (write ` `); never match basenames across directories; pure logic
in `app/shared/` for bun tests. Read the docs named at the top before
writing a line.

**Ordering constraint that shapes everything: the current PDF block editor is
the only editing surface until the flowing surface exists.** Build the new
surface first; demote the PDF view after. Never leave a gap where nothing
can edit.

- **Phase 0 — undo goes in-memory** (small, standalone, fully specced in
  NEXT-WORK §6): delete `overlays/<key>.ledger.json` persistence and the
  `overlay:ledger-load/save` IPC; stacks in-memory, fresh per open and per
  generation change, NOT per position move; `history.ts` untouched (it
  retires later, in phase E, not now). Deletes code the later phases would
  otherwise have to carry.

- **Phase A — the reflow pass (engine)**: bank → flowing blocks with
  provenance; bank-only joins (ink test removed); furniture suppression,
  dehyphenation, footnote collection, chapter seeds — hoisted from the
  emitter into a pass that PRODUCES the base rather than a side effect of
  writing XHTML. Contract tests: same bank → same base, byte for byte.
  The emitter consumes the base (no output change expected — pin with
  fixture comparisons, EXCEPT joins that only the ink test made, which now
  stay split; count and log them).

- **Phase B — the flowing surface (app)**: render the base in a tab; the op
  vocabulary of §3 wired as gestures (delete/restore, text edit with the
  word-level guard, category, join, chapter markers); ops recorded against
  source parts in the live decision set; in-memory undo; Save = the existing
  curate commit. The PDF view keeps its editor UNTIL this lands (constraint
  above), then phase E demotes it.

- **Phase C — Generate materializes anywhere**: any step → final document;
  facsimile as a generate-able point; cuts really removed and apparatus
  tidied at materialization (fold `epub-final`'s logic in); zipped, opened.
  Queue rules as landed (held when model time is possible).

- **Phase D — transforms as records (engine + app)**: text-level masking;
  record files with the bank-lifecycle ownership rules; `translate` gains
  the records mode; the app's two-stage pipeline switches to it; chains and
  translated-text-on-the-page arrive with it.

- **Phase E — retire the old surfaces**: textarea editor gone; working-tree
  truth and `history.ts` gone (their one surviving duty — nav/page-heading
  ops — moved into §3's ledger); PDF view reduced to: view, and produce
  facsimile.

- **Phase F — compare, side by side** (NEXT-WORK §3, unchanged by all of
  this): a step's rendering read-only in the second pane; a view, not a
  position move; original beside translation.

- **Phase G — the user's hand-test.** Nothing this week has been through
  their hands. The walkthrough: import → read → reflow appears → strike and
  join on the flowing page → save → translate → strike more → save →
  Generate at each of three steps → three correct final documents; plus the
  facsimile from the start row. Not automatable; listed so it is not skipped.

Phases 0, A are independent and can run in parallel. B needs A. C needs B
(ops must exist to execute). D needs A (the base is the transform input) and
benefits from C. E needs B+C+D. F is independent of everything after 0.

---

## 7. Standing decisions carried forward (so nobody re-litigates)

- Two-level text overrides (source invalidates records; per-language record
  overrides) — user, 2026-08-15.
- Textarea editor retired — user, 2026-08-15.
- No ink sampling anywhere, ever — user, 2026-08-15.
- Provenance kept, pagination erased — user, 2026-08-15.
- Chapter markers: machine proposes, user owns, redefinition must be cheap —
  user, 2026-08-15.
- PDF: facsimile only, for now — user, 2026-08-15.
- Generate = the final document, from any selected step — user, 2026-08-15.
- Snapshots display themselves and lock; everything else edits live —
  landed (`f03a50c`).
- The queue is where expense happens; held when model time is possible —
  landed (`b5a7264`).
- Banks swap on success; steps own their payloads; generations are
  per-step — landed (`BANK-LIFECYCLE.md`, six commits).
