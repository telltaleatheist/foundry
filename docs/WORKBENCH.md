# The workbench — the app surface, as the user ruled it

Settled with the user 2026-08-15, from a hand-test of the whole flow. This
document is the app-surface authority for the wave that builds it.
`docs/DERIVED-BOOK.md` remains the authority on the data model (bank, steps,
ops, Generate); nothing here contradicts it — this is the surface that model
was always supposed to wear. Where this document reverses an earlier decision
it says so out loud.

---

## 1. The workflow, in the user's words

> "i open the app. i drag/drop a pdf in. it highlights the OCR tool. that's
> where i start. i hit OCR, it sends it through the vlm. it generates a bank.
> from that bank, we create an html page of the document - a proto epub.
> that's the step that appears automatically the moment i OCR something. i
> can now either click back to step 1, which shows the original pdf, or i can
> click the ocr step, which shows the PDF in html/epub form. if i want, i can
> click export (new button), select 'facsimile pdf' or something, and itll
> produce a new facsimile pdf, which opens as a new tab that i can save to
> disk if i want. it wont go into the working files as a step because it isnt
> the base for new steps. its a terminal step. so its an export."

> "only steps that are going to lead to another step or to export are added
> to the steps ledger. including edit metadata."

> "there will be no 'save a copy' or 'save' buttons along the top of panels.
> those buttons are reserved for the export modal that pops up when you click
> the export button on the nav rail."

> "clicking the project will bring me to the working system, with steps
> listed and everything, and the most recent step selected and shown on the
> main tab. however, under the project and indented, there will be terminal
> files i generated from the project. pdf facsimile, epub, whatever i
> exported. clicking it will open the file in a new pane, and each pane has
> an X on its tab so i can close it if i want. clicking another file will
> automatically close the one i was looking at and open the one i just
> clicked, unless i pin the file by right-clicking the chrome-style tab at
> the top."

> "if a user clicks a step to display it, it opens in the main panel with a
> chrome-style tab along the top with an X. they can right-click a different
> step and click open, and itll split the screens between the one they just
> opened and the one they already had open. if they open a different step the
> normal way, by clicking it, it opens in a new tab. if they grab the tab and
> drag it to one of the sides, it enters split screen with the tab that was
> currently active when they dragged it."

Plus three defects from the same session: deleting in select mode drags the
scrollbar ("i delete a footnote and the next thing i know, im looking at the
chapter header"); there is no Apply-changes button that writes select-mode
edits to the ledger as a step; and `overlay:blocks` throws an OverlayError
into the console for a book that has not been read.

And two direct questions that are rulings once answered: "i thought we got
rid of html editing? the buttons and logic are still there" (the buttons go;
the logic stays, as previously ruled for the Block section) and "what does
the blocks btuton do? does that belong on here?" (it does not — see §6).

---

## 2. The one insight that makes this cheap

**The proto-epub already exists. It is `vlm-convert --format epub`.** The
flowing HTML document the OCR step shows is not a new surface to build — it
is the EPUB the engine already casts from the bank, deterministically, with
every block stamped (`data-bf-id`, `data-bf-page`), which the app already
knows how to render, select over, strike and relabel. What is missing is
purely wiring:

- nobody casts it automatically when a read lands;
- the read step's document still resolves to the working PDF
  (`documentAtPosition`, `app/electron/projects.ts:1919`), so clicking the
  OCR step shows the scan instead of the book;
- there is no Export anywhere (`StepAction`'s own header already ruled that
  exports are "an export log — a separate thing", `app/shared/types.ts:2063`
  — the log was just never built);
- the pane chrome (tabs, pin, split) was removed in an earlier session and
  the user has now specced it back.

---

## 3. The model: three kinds of file, and only one of them is a step

| kind | lives in | listed as | example |
|---|---|---|---|
| step document | `working/`, `generated/` | a row in Steps | the scan; the proto-epub |
| export (terminal) | `final/` | indented under the project in the left nav | facsimile PDF, exported EPUB, plain text |
| debris | `os.tmpdir()` | nowhere | piped-translate intermediate |

- **A step is a base for further work.** Import, read, curate, translate.
  Its document is what the pane shows when you stand on it.
- **An export is terminal.** Produced by the Export modal, deterministic
  (never a model — DERIVED-BOOK §7 ruling stands), lands in `final/`,
  recorded as a `ProjectFinal` row (the shape already exists,
  `app/shared/types.ts:936`), opens as a tab, never enters the steps ledger,
  never becomes anyone's parent.
- Generate-the-button dies. **Export replaces it** — same planning
  machinery (`planConversion` / `renderPipeline`, including
  generate-under-a-translation), different landing.

**Deferred, recorded so it is not lost:** the user ruled metadata edits
belong in the steps ledger ("including edit metadata"). That is a new
`StepAction` with position/retention/deletion semantics and is NOT in this
wave; today metadata keeps writing directly to the live document. Same for
re-casting the proto-epub at a curate landing (curate rows show the live
working tree, which already wears the marks) and for the full §3 op
vocabulary (phase D).

---

## 4. What each unit builds

### Unit E — electron + shared (fence: `app/electron/**` except
`click-reporter.ts`, plus `app/shared/**`)

1. **Read lands → cast the proto-epub.** In `job-queue.ts`, when a `read`
   job settles at code 0 (after `recordReading`, `:1062`), plan and enqueue
   a `kind: 'epub'` conversion for the same project (via `planConversion`;
   the bank just completed so its refusal cannot fire). It is deterministic,
   so it is never held and never waits for vLLM (`endpointFor` rule at
   `:716` already guarantees this). Its landing goes through
   `recordGenerated` as today — a rendering, not a ledger step. Guard
   against loops: a conversion landing must never enqueue anything.
2. **Read/curate rows show the proto-epub.** `documentAtPosition`
   (`projects.ts:1919`): for a read or curate row, resolve to the epub
   rendering produced from the position's reading (walk the `documents`
   catalogue / per-type records for an epub record belonging to that reading
   step). Fall back to today's `working/<live pdf>` while the cast is still
   in flight or for a legacy project that has none. The import row is
   unchanged (the scan).
3. **Export.** New IPC `workspace:plan-export (inputPath, kind)` — a
   `planConversion` that aims `outputPath` at `final/<stem>.<ext>` instead of
   `generated/`, with the same incomplete-bank refusals and the same
   `thenTranslate` composition. `GenerateRequest` gains `export?: true`.
   Landing: when `export` is set, do NOT call `recordGenerated` — append a
   `ProjectFinal` row (`recordFinal` already exists, `projects.ts:2746`;
   loosen or wrap it so a queue landing can use it), rotate a displaced
   predecessor into `final/archived-<stamp>/` (mirror `rotateGenerated`,
   `job-queue.ts:824`), announce projects, and let `OPENS_ITSELF` open the
   result. No documents row, no ledger step, no live-pdf refresh.
4. **Exports reach the renderer.** `projects:list` exposes each project's
   `final` rows (kind + madeAt + project-relative path) so the left nav can
   list them. Extend the shared `ProjectInfo` shape accordingly.
5. **`overlay:blocks` stops throwing into the console.** The handler
   (`main.ts:2202`) catches `OverlayError` and returns the soft
   `{ ok: false, reason }` shape `readPdfBlocks` already uses — the renderer
   already renders that shape in the pane. An unread book is a state, not an
   exception.
6. **Application menu:** if main's menu template carries Save / Save As
   items, they become one `Export…` item that sends an `export` event the
   renderer routes to the modal.

### Unit R2 — renderer components (fence: `tool-rail`, `generate-dialog` →
`export-dialog`, `pdf-view`, `epub-view`, `ui.service.ts`,
`app/electron/click-reporter.ts`)

1. **Export button + modal.** The rail's Generate button becomes **Export**
   (same slot, same enablement logic broadened: enabled when the active
   project has a completed reading). `generate-dialog` is reworked into
   `export-dialog`: choose Facsimile PDF / EPUB / Plain text, call
   `api.workspace.planExport`, enqueue. Copy speaks in products ("a PDF of
   the same pages, reprinted as real text"), never filenames.
2. **Save buttons leave the pane toolbars.** `Save a copy…` off
   `pdf-view.component.ts:199`, `Save…` off `epub-view.component.ts:110`.
   Saving is the export modal's job now. The underlying `save`/`saveAs`
   service methods stay (the close-dialog path still uses them).
3. **Edit HTML button goes** — off the rail (`tool-rail.component.ts:166`)
   and off the EPUB toolbar (`epub-view.component.ts:87`). The
   `html-editor` component and `toggleEditor` machinery stay untouched
   (DERIVED-BOOK already retires them properly in phase E; the user asked
   for the *buttons* to stop being offered).
4. **Blocks button goes** — off the rail (`tool-rail.component.ts:148`) and
   off the PDF toolbar (`pdf-view.component.ts:155`). See §6.
5. **Select-mode deletion keeps its place.** The EPUB iframe reloads on
   failure paths and on stamping, and every reload lands the reader at the
   top of the chapter. Fix at the reload seam so every path is covered at
   once: `epub-view` captures the frame's scroll position (reporter message
   on scroll, throttled, or read at teardown) and restores it after
   `foundry:reporter-ready`. `click-reporter.ts` gains the scroll
   report/restore messages. Deleting a footnote must leave the reader
   looking at where the footnote was.

### Unit R1 — the pane chrome (fence: `tabs.service.ts`,
`workspace.component`, `viewer`, `open-documents`, `inspector`, `app.ts`)
— runs AFTER E and R2 land, because it wires their seams together.

1. **Tab strips return.** `Pane` grows from `tabId: string | null` to an
   ordered `tabIds: string[]` + `activeTabId`. Each pane renders a
   chrome-style strip: title, close ✕ per tab, drag to reorder, drag to
   another pane's edge band to split (the edge-band drop already exists at
   `workspace.component.ts:232`; it gains tabs as a drag source, not just
   documents-list rows). **This reverses the earlier removal** documented at
   `tabs.service.ts:68–74` — the user specced it back explicitly, with pin
   and drag-split the strips' whole point this time. Update that comment to
   say so rather than deleting it.
2. **Pin.** Right-click a tab → context menu with Pin/Unpin (and Close).
   Pinned tabs are exempt from auto-replacement (below) and their ✕ hides.
3. **Auto-close-unless-pinned.** Opening a project file or export from the
   left nav replaces the currently active unpinned tab in the focused pane
   (close it, open the new one in its slot) instead of accumulating tabs.
   Opening a *step* follows §1's quote: normal click shows that step's
   document as a tab in the active pane; right-click a step row → "Open in
   split" puts it beside the current one.
4. **Steps drive tabs across kinds.** `showPosition`
   (`tabs.service.ts:785`) currently swaps a path on a follower PDF tab.
   Now the position's document can change KIND (import → PDF, read →
   proto-epub). When the document at the position is a different kind,
   open/reveal the right tab in the same pane (both may sit in the strip;
   clicking between steps activates between them). Nothing threads
   "this is a PDF" through the renderer — the seam is
   position → document → show it (DERIVED-BOOK §7).
5. **Exports in the left nav.** `open-documents` lists each project's
   export rows indented under the project (from the extended
   `projects:list`), labelled by product and date, never by filename.
   Clicking opens with §3's auto-close-unless-pinned semantics. Its ✕
   closes; its context menu keeps Show-in-file-manager / Delete.
6. **Apply changes.** Select-mode strikes/relabels on the proto-epub
   currently write the working tree only — the ledger never hears about
   them. Mirror each successful cut/restore/relabel into the overlay via
   the existing `amendBlocks` path, keyed by the block's bank key — FIRST
   verify the stamped `data-bf-id` on a cast EPUB block equals the overlay's
   `page:order` key space; if it does not, STOP and report rather than
   invent a mapping. Then the existing commit machinery is the button:
   surface **Apply changes** in the inspector's Steps section (where `Save
   corrections` sits, `inspector.component.ts:184`) whenever the position
   holds uncommitted decisions, wired to the same `overlay:commit` →
   curate-step path. One button, one sentence, fixed-size hint rules apply.
7. **Gate `loadBlockView`.** No call to `api.overlay.blocks` when the
   position has no reading (`positionView().outlines === false`). With the
   Blocks button gone, the remaining callers are position-driven; gate them
   there. Main's soft refusal (Unit E) is the backstop, not the fix.
8. **Route the `export` menu event** to the export modal.

---

## 5. Contracts (so E and R2 build in parallel without meeting)

- `api.workspace.planExport(inputPath: string, kind: 'epub' | 'txt' | 'pdf')`
  → same plan shape `workspace:plan` returns, with `outputPath` under
  `final/`. Preload + `app/shared/api.ts` typing land with Unit E; R2 calls
  it.
- `GenerateRequest.export?: true` — set by the export dialog, read by the
  queue landing. Lands with Unit E in `app/shared/types.ts`.
- `ProjectInfo` (the `projects:list` row) gains
  `exports: { file: string; kind: ProjectDocumentKind; madeAt: number }[]`.
- `overlay:blocks` may now resolve with `{ ok: false, reason }` where it
  used to reject; the renderer call site (`tabs.service.ts:1942`) already
  handles that shape.
- `click-reporter.ts` gains `foundry:scroll-report` (frame → shell,
  throttled) and `foundry:scroll-restore` (shell → frame) messages; R2 owns
  both ends.

---

## 6. Rulings recorded (2026-08-15)

- **Export is terminal and never a step** — user: "it wont go into the
  working files as a step because it isnt the base for new steps. its a
  terminal step. so its an export." The absence of a `generate` StepAction
  was this ruling waiting to be needed.
- **Save lives in the export modal and nowhere else** — user: "there will be
  no 'save a copy' or 'save' buttons along the top of panels."
- **The chrome-style tab strips come back** — with ✕, right-click pin, and
  drag-to-edge split. This reverses the strips' earlier removal; the removal
  traded chrome for a list, and the user has now specced the chrome as the
  mechanism for pin/split/close. The vertical documents list stays (it is
  the project/export navigator, a different job).
- **The Blocks button does not belong on the rail** — user: "what does the
  blocks btuton do? does that belong on here?" It toggled the PDF block
  overlay (the scan-side editing surface). Editing belongs to the flowing
  surface; the PDF's future is view-and-export-facsimile (DERIVED-BOOK
  phase E). The *machinery* stays — the position still lights outlines
  where standing on a reading requires them — but no button offers the
  scan as an editing surface.
- **HTML-editing buttons withdrawn, logic stays** — same shape as the Block
  section ruling: the offer disappears; the machinery waits for phase E to
  remove it properly.
- **A delete must not move the page** — user: "i delete a footnote and the
  next thing i know, im looking at the chapter header."
- **Edits are applied, not ambient** — user: "there's supposed to be an
  apply changes button that writes those changes to the ledger and adds it
  as a step."
- **Metadata belongs in the ledger** — user: "including edit metadata."
  Deferred from this wave (§3), recorded here so it is built as a step
  action later, not as another silent write.

---

## 6a. Unit A2 — Apply changes, unblocked (added after R1 stopped honestly)

R1 proved the mapping does not exist: the cast book stamps
`data-bf-id="p<page>-<n>"` where `n` counts *emitted XHTML elements* per page
(`dots-book.ts:1234-1245` says so — a list writes `<ul>` AND `<li>`, both
stamped), while the ledger keys `page:order[:part]` off the model's answer
index (`overlay.ts:283`, `targetKey`). Only the emitter, holding the live
`elementNumbers` map, ever knew the correspondence, and it writes it nowhere.
No renderer-side mapping is possible or permitted. The fix is provenance,
which is DERIVED-BOOK §2's own finding #1 finally closed:

1. **Engine** (`src/vlm/dots-book.ts`, `src/vlm/epub.ts` as needed): the
   stamp also writes `data-bf-src` — the block's source parts as
   `page:order` (or `page:order:part` for a sub-split), space-separated when
   a flow block was joined from several source blocks. Every stamped element
   of one block carries the same `data-bf-src`. Deterministic, from the
   FlowBook's own provenance; no new tests (fix any the new attribute
   invalidates).
2. **Reporter** (`app/electron/click-reporter.ts`): block messages
   (`blocks-cut`, `blocks-relabelled`, `block-click`, `block-selected`)
   carry each block's `src` alongside its id.
3. **Mirror** (`tabs.service.ts`): at the choke point where a cut/restore or
   relabel is KNOWN to have landed in the working tree (so undo replays
   pass through the same door), amend the overlay via the existing
   `amendBlocks` path with targets parsed from `data-bf-src`. Verify the
   overlay IPC resolves an epub tab's path to the project's overlay
   (locateOverlay resolves the project and never reads the named file —
   confirm, don't assume). Note cuts: mirror only if the overlay's
   vocabulary already holds them; otherwise leave them out and report.
4. **The button** (`inspector`): **Apply changes** in the Steps section,
   shown when the position holds uncommitted decisions
   (`overlay:uncommitted`), wired to the existing `saveCorrections` →
   `overlay:commit` → curate-step machinery, its gating broadened beyond
   the PDF block view. Sections stay Steps #1 / Chapters #2 / Categories
   #3, stationary; hint blocks keep their fixed reserve.

A book cast BEFORE this lands carries no `data-bf-src`; the mirror must
treat a missing attribute as "this book predates provenance" and skip
silently — the next cast repairs it.

---

## 6b. Unit A3 — the vocabulary grows the two entries A2 found missing

A2 left two gestures working-tree-only, reported not fudged: a chapter
relabel and a footnote cut. Settled with the user 2026-08-15; both designs
follow from rulings already on the books.

### Chapter relabels — the title was never missing

The chapter op already exists end to end: the overlay's `chapters` spine
carries markers with titles, the Chapters section edits it, and the reflow
consumes exactly it (`FlowBookOptions.overlay` — "Only the CHAPTERS are
read here"). The gesture recorded nothing because a marker wants a title
the relabel does not supply — but it does: **the block is the title.**

- Relabelling a block to "Chapter opening" on the book writes a chapter
  marker into the overlay's `chapters` spine at the block's source key,
  title defaulting to the block's own text (whitespace collapsed). That is
  "machine proposes, user owns" verbatim: the Chapters section renames it
  afterwards if the heading is not the name.
- Relabelling it back to anything else removes the marker.
- It is NOT a category amendment — there is no `chapter` category in the
  bank's vocabulary, and that dead end is why `bankCategory()` returns null
  today. The gesture forks: bank categories go to category amendments,
  chapter goes to the spine.
- If the scan-side picker also offers "chapter" and also records nothing,
  both surfaces route through the same fork — one behaviour, two panes.
- Undo replays through the same door; a frozen save refuses the gesture
  before anything is written, like every other decision.
- No engine change, no format change. The next cast divides where the
  marker says because the reflow already obeys the spine.

### Footnote cuts — the target key grows a note ordinal

`splitNotes` cuts one banked Footnote block into several notes, so five
notes can share one `data-bf-src`; "cut note 3" is unsayable in a
vocabulary whose smallest unit is the block. Three pieces:

1. **Engine stamps identity**: each emitted `<aside>` already carries
   `data-bf-src`; it also gets `data-bf-note="<n>"`, the note's ordinal
   within its source block. Ordinal, not the printed number — the printed
   number can be null and is display, not identity; the ordinal is
   deterministic from the same bank.
2. **The overlay says it**: targets gain an optional `note` dimension
   (`page:order[:part]` + note ordinal) in `app/shared/overlay.ts` AND in
   the engine's overlay reader — the same file crosses the seam via
   `--overlay`, so both sides must speak it and old files without the
   field must parse untouched. At cast time the engine marks a cut note
   the way block cuts are marked today; when phase C makes cuts real at
   materialization, note cuts come along free because they live in the
   same decision set.
3. **The mirror routes through it** (the A2 pattern exactly): a
   `set-note-cut` success amends the overlay at the note target; undo
   un-mirrors through the same replay bucket; a pre-provenance book (no
   stamps) skips silently and its next cast repairs it.

Both gestures then reach **Apply changes** with no further work — the
button already answers "does the project hold decisions no step keeps."
When both land, DERIVED-BOOK §3's op table gains its two rows: `cut note`
(per-note, source-level) and the chapter marker's book-side gesture.

---

## 6c. The library tree — one selector, settled 2026-08-15

The user, after living with the built wave: "i feel like the available
documents (on the left sidebar) and the steps (right sidebar) are
confusing. i could have a document open, the epub, but have the pdf import
step selected, and id never know that i just ran translate against the
original pdf rather than the generated epub because i had the wrong step
selected, since the right document was open."

The diagnosis: the app has **two selectors pretending to be one**. The left
sidebar selects a file, the right sidebar selects a step, and actions key
off a mix of both. The resolution, in the user's words: "maybe we merge
them and top level things get arrows that expand down. steps applied to
[x] document. the original document can be the root since thats where it
all started … this is kind of set up like final cut pro, where the left
side is the events/libraries/etc, and the right side is the effects to
apply to each thing."

### The tree

The left sidebar becomes the **library**: one tree per project, rooted at
the original import, plus loose files as childless top-level rows.

```
▾ moby-dick.pdf                      ← import, the root. Click = the scan.
   ▾ Book · read 8/12               ← the reading. Click = the reflowed HTML.
        Applied changes · 8/13       ← curation save
        ▾ Translated · 8/14          ← translate = a new book, so it nests
             Applied changes · 8/14
   Facsimile PDF · 8/14              ← export: terminal, no arrow,
   EPUB · 8/15                          nothing ever under it
```

- **Every step is a tree node.** The ledger was always secretly a tree
  (every step has a parent); the flat Steps list was that tree with the
  indentation removed. Children of the import: the reading and the
  exports. Children of a reading: its curation saves and any translate
  built from it. A translate is a new book, so it nests and grows its own
  saves.
- **Exports are children of the root**, at the same indent as the Book —
  visibly terminal (no expand arrow), labelled by product and date, never
  filename. NOT fully top-level: with several projects open, orphaned
  exports would lose their parentage. This amends §4-R1's "indented under
  the project" only in that the project row IS the import root now.
- **Loose files** stay top-level, childless, file-keyed (no ledger, so no
  position; their actions keep taking the file).

### One selection

- **Clicking a tree node moves the position** and shows that node's
  document (import → the scan; reading/save → the book as of that step;
  export → the exported file). Same `ledger:go` → `showPosition` seam.
- **Focusing a tab moves the position back** — the scan tab stands on the
  import; a book tab stands on the newest step of its chain (the only one
  you can act from). Tabs are windows onto the selection, never a second
  selector.
- **Every action keys off the position, never the open tab.** Translate on
  a reading = the book as read; on a save = as curated; on the import row
  = disabled. Same rule for Export and Metadata. The open tab stops being
  an input to anything.
- Right-click a step still offers "Open in split"; exports drag into a
  split for comparison exactly as tabs do.

### The right sidebar

**Steps leaves the inspector.** The tree absorbed it. Chapters and
Categories stay, describing whatever node the position stands on. In the
vacated top slot sits a one-line **standing strip** — the standing step's
label — with the **Apply changes** button and its sentence beneath it,
gated exactly as today. The right side is the inspector in the Final Cut
sense — details and actions for the selected thing, never a competing
selection. This amends the stationary-sections rule: the sections that
remain still hold their order and their fixed hint reserves; there is
simply one fewer of them, and the standing strip is the new fixed top.

### Naming

**The working document is never called "EPUB".** It is **the Book** — the
evolving thing you read, curate, and translate. "EPUB" appears in exactly
two places: the export modal's card and an export row's label. The word
means "finished". (User: "im thinking we shouldnt call the working files
'epub' until we export.")

### Going home

**Right-click the import root → Close project.** Closes the project's
tabs (through the ordinary close question — uncommitted decisions still
get their one ask), and the tree leaves the library — a project is open
while one of its documents is, which is the existing ruling, unchanged.
(Amended by the 2026-08-15 debris pass: the root also wears a
hover-revealed ✕ — the same action through the same dispatch — because
a right-click with nothing on screen to suggest it was the only door,
and an invisible door is not a door.)
With nothing open, the workbench shows its empty state — home. Closed
projects live on the home screen's "Your books", not in the library.

### The build — units T1, T2, T3

Survey facts this plan stands on: the renderer already holds the whole
DAG (`StepRow.step.parent` is the full parent id; `types.ts:2385–2391`
says the flat list was a deliberate flattening); today NO rail button
reads the position (`tool-rail` gates on `tabs.activeDocument()`;
Translate's input is the focused tab's path,
`translate-dialog.component.ts:283–286`; Export's is the project's
original, `export-dialog.component.ts:370–376`); and tab focus never
writes the position (`activateInPane` / `focusPane`,
`tabs.service.ts:1733–1754`, call nothing on the ledger — the complete
list of `this.ledger.*` calls is lines 715, 953, 980, 1052, 1293, 2633,
2924, 2936, none of them `go`).

**Unit T1 — main + shared** (fence: `app/electron/**`, `app/shared/**`)

1. New IPC **`ledger:stand-for (dir, absolutePath)`** — resolve which
   step the document belongs to, move the position there, return
   `{ ledger, rows }` exactly like `ledger:go`. The mapping lives next
   to `documentAtPosition` (`projects.ts`), because that is the forward
   direction and the two must agree:
   - a path under `final/` → no-op (exports are terminal; viewing one
     never moves the position);
   - the working scan / origin payload → the origin step;
   - the cast book in `generated/` → the NEWEST step of the chain
     descending from the reading that cast it (the read, or its latest
     curate save) — the newest is the only step you can act from;
   - a translation's book (a translate step's payload) → the newest
     step of that translate's own chain;
   - anything that resolves to no step → no-op, return current.
   Standing where the position already stands must not rewrite the
   ledger file — skip the write when nothing moved.
2. Preload + `app/shared/api.ts`: `api.ledger.standFor(dir, path)`.
3. `labelFor` curate rename (`shared/ledger.ts:296–311`):
   `'Saved corrections'` → `'Applied changes'` — the button says Apply
   changes, the step should say what the button did. Old persisted
   labels stay as stored; labels are display-only.

**Unit T2 — the library tree** (fence:
`open-documents.component.ts`, `inspector.component.ts`, and
`ledger.service.ts` only if ensure-wiring proves necessary)

1. `open-documents` becomes the **library**. For each OPEN project (the
   existing has-open-tabs rule, `groups()` `:650–651`, stands), render
   the ledger tree from `ledger.historyFor(dir)` — verify the ledger is
   actually held for every open project (`ensure` runs somewhere near
   `tabs.service.ts:2633`; wire it in `open-documents`/`ledger.service`
   if a project can be open unheld). Root = the origin step, labelled
   with the project title. Children by `step.parent`. Exports
   (`ProjectSummary.exports`) render as children of the root — no
   expand arrow, labelled by product + date (existing `exportLabel` /
   `exportWhen`). Node labels: **"Book"** for read steps, `step.label`
   for everything else; date tally per the inspector's `when()` rule.
   `.current` marks `standingId()`. Clicking any step node →
   `ledger.go(dir, step.id)` (the inspector's `stand()`,
   `inspector.component.ts:1389–1399`, moves here). Clicking an export
   row keeps today's open semantics.
2. Rows that die: the per-project document rows — open, available, and
   their `typeLabel` names ("EPUB" as a working-document label dies
   with them). Rows that stay: loose tabs (top-level, childless),
   editor (HTML) faces indented under their root, "a copy you opened".
3. Context menus: root → **Close project** (the group-✕ semantics,
   `closeProject()` `:885–888` — ordinary tab close so the B1 questions
   fire) + Show in file manager; step node → **Open in split** (move
   the inspector's `openInSplit` wiring, `:1430–1445`) + **Delete this
   step…** (move the inspector's `discard` flow, `:1454–1472`); export
   node → existing Show / Delete. The per-row ✕ stays a tab-closing
   affordance only — a step is not a tab and its deletion hides behind
   the menu.
4. `inspector` loses the Steps section (template 80–205 and its class
   members). In the vacated top slot: the standing strip — one line,
   the standing step's label — and the Apply changes button + sentence,
   gated by `unkept()` exactly as today (`:1313–1317`, `:1484–1487`).
   Update the furniture comment (`:81–98`) to record the reversal and
   point here; Chapters / Categories keep their order and their fixed
   hint reserves.
5. The panel header says **Library**.

**Unit T3 — one selection** (fence: `tabs.service.ts`,
`workspace.component.ts`, `tool-rail.component.ts`,
`translate-dialog.component.ts`, `export-dialog.component.ts`,
`metadata-dialog.component.ts`, `queue-shelf.component.ts`) — runs
after T1 (needs its API) and after T2 (works on its landscape).

1. **The focus mirror.** The user's focus gestures — strip tab click
   (`workspace.component.ts:141`), pane pointerdown (`:109`), Ctrl+Tab
   (`nextTab`), Ctrl+1…5 (`focusPaneAt`) — call a new
   `standForTab(tabId)`: loose file → no-op; **if the tab's path IS the
   position's shown document → no-op** (the guard that matters:
   standing on an older step and clicking into its document must not
   yank the position to newest); else `api.ledger.standFor(dir, path)`
   and fold the returned history into `LedgerService` the way `go()`
   does. Programmatic reveals (`showPosition` / `showDocument`) must
   NOT mirror — only the user-gesture call sites do.
2. Expose **`documentShownFor(dir)`** as a signal-backed read — the
   `documentShown` map (`tabs.service.ts:921`) mirrors its writes into
   a signal so dialogs and gates can react to it.
3. **Dialogs key off the position.** Translate `source()`: in a
   project, the position's shown document (must be the book; standing
   on the import → empty state, "Stand on the book to translate it");
   a loose EPUB tab keeps file keying. Export enablement: in a
   project, reading done AND the standing step's action is not
   `import`; a loose PDF keeps today's rule. Metadata: in a project,
   the position's document; loose unchanged.
4. **The naming audit** (§6c Naming): `translate-dialog` `:158`/`:164`
   ("Open an EPUB first" → book language), `queue-shelf` `:133`/`:177`
   (the automatic cast is "the book"; an export stays "EPUB"), rail
   button titles. The working document is never called EPUB; the word
   appears only on the export modal's card and export rows. `typeLabel`
   itself survives (it names files — loose rows and copies).

T1 and T2 run in parallel (disjoint fences, no shared contract). T3
runs after both. The lead verifies and commits; agents never commit.

---

## 7. Order, gates, house rules

Units E and R2 run in parallel (disjoint fences, contracts in §5). Unit R1
runs after both land. The lead verifies and commits; agents never commit.

Every unit, before reporting: `bun test`; root `bunx tsc --noEmit`; from
`app/`: `bunx tsc -p tsconfig.electron.json --noEmit`,
`bunx tsc -p tsconfig.app.json --noEmit`, `bunx ng build` (the ~521 kB
budget warning is pre-existing). No new tests (user ruling; fix invalidated
ones, don't add). Long WHY comments in the codebase's voice. Escape
backticks as \` in Angular template prose. Never a raw control byte. Never
match basenames across directories. No filenames in user-facing copy.

---

## 8. Phase C — what lands in `final/` is an edition (specced 2026-08-15)

DERIVED-BOOK phase C promised "cuts really removed and apparatus tidied at
materialization". A line-referenced survey of the tree corrected the
premise before it became the spec: **struck blocks are already really
removed from every format** — `applyOverlay` drops them
(`src/vlm/overlay.ts:690`) at `convert.ts:483`, upstream of the format
fork, and select-mode strikes mirror into the overlay since A2. What still
leaks into an export today:

1. **Struck footnotes ship present.** A note strike renders as
   `data-bf-cut="1"` on the `<aside>` (`dots-book.ts:1858-1863`) — marks,
   not removal, by design, because the CAST book is the working surface
   and the user must see what they struck. But no export path ever runs
   the removal: the exported EPUB contains the struck note and its live
   `noteref` link, and the plain-text export contains the note's TEXT
   with no mark at all (`packageVlmText` tag-strips the same XHTML,
   `dots-book.ts:2973`).
2. **Editing stamps ship.** `data-bf-id` on every element, `data-bf-src`,
   `data-bf-note` — the picker's plumbing, exported to the reader.
3. **The second door is worse.** Save-As (`epub:save`,
   `app/electron/main.ts:2242-2254`) repacks the working tree VERBATIM
   into `final/` and records it as an export — every mark, every stamp,
   zero tidying.

`epub-final` (`src/epub/final.ts`, entry `epubFinal` at `:771`; 22 tests
in `test/epub/final.test.ts`) already knows the whole tidy: cut removal,
orphaned-note drop, noteref demotion to a bare `<sup>` (`:528-545`),
empty-footnotes-section removal, nav tidy, page-marker re-homing,
attribute stripping (`:226` — strips `data-bf-cut` + `data-bf-id`, KEEPS
`data-bf-page` + `data-bf-cat`, `:218-225`). Nothing in `app/` invokes it.

**The ruling.** `generated/` is the workbench and keeps its marks;
anything that lands in `final/` is an EDITION: struck notes absent, their
references demoted to the printed number, no editing attributes. Two
mechanisms, chosen by where the product is made:

- **Fresh casts get a `--final` mode in the engine** (assembly-time,
  upstream of the format fork), because the txt route can only be fixed
  there — a post-zip pass on the EPUB would leave the note's text in the
  plain-text export. `vlm-convert --final`: a struck note's `<aside>` is
  never emitted; its noterefs emit as bare `<sup>n</sup>` (the
  `epub-final` demotion, done at the source); a chapter whose every note
  is struck emits no footnotes section; `data-bf-id`/`data-bf-src`/
  `data-bf-note`/`data-bf-cut` are not emitted; `data-bf-page` and
  `data-bf-cat` stay (the `final.ts:218-225` ruling, unchanged). Default
  off — the cast path must stay byte-identical, and the suite pins it.
- **Already-built EPUBs go through `epubFinal`** — the translate-descended
  export (stage 1 must keep stamps because `translate` requires them,
  `src/translate/book.ts:124-130`, so the tidy must run AFTER the last
  stage: translate writes to a tmp intermediate and an `epub-final` stage
  lands the file in `final/`) and the Save-As door (repack to tmp, tidy
  into the destination; a book without stamps — a loose EPUB that was
  never foundry's — repacks verbatim as today, since `epub-final` refuses
  it and there is nothing of ours to strip).

**The facsimile is exempt, and honestly.** The PDF branch forks before
notes exist (`convert.ts:568`); a note is just text on the printed page
there. Block strikes already apply to the facsimile (they die at
`applyOverlay`); a NOTE strike does not reach it, and page-faithful is
what a facsimile is for. Recorded as the known asymmetry, not a defect.

### Unit C — the edition (fence: `src/**`, `test/**`,
`app/electron/workspace.ts`, `app/electron/job-queue.ts`,
`app/electron/engine.ts`, `app/electron/epub-reader.ts`,
`app/electron/main.ts` — the `epub:save` handler only)

1. **Engine**: `--final` on `vlm-convert` (register in `src/commands.ts`;
   thread through `convert.ts` into the assembly). Emission rules above.
   The struck-note set must be consultable at noteref-emission time
   (`buildChapterBody`'s callback, `dots-book.ts:1582-1592`, matches via
   `noteFor` `:1575-1578` — the same `(page, printed)` match `noteStruck`
   uses).
2. **Engine**: extend `epub-final`'s `EDITING_ATTRIBUTES` (`final.ts:226`)
   to also strip `data-bf-src` and `data-bf-note` — the two attributes
   born after it was written. Fix the one test this invalidates
   (`final.test.ts:122`); add none.
3. **App, plain export**: `argsFor`'s conversion branch
   (`job-queue.ts:578-612`) appends `--final` when the request is an
   export (`request.export`). The cast path (no `export`) is untouched.
4. **App, translate-descended export**: today the pipeline's last stage
   writes `final/<name>.epub` directly. Insert the tidy: the translate
   stage aims at a tmp intermediate and a new `epub-final` stage
   (`engine.ts` gains the wrapper) writes the destination. Held/immediate
   and rotation rules unchanged (`job-queue.ts:223`, `:874-897`).
5. **App, Save-As**: the `epub:save` path repacks to tmp and runs
   `epubFinal` into the destination when the book is a foundry book;
   verbatim repack otherwise. `recordFinal` unchanged.
6. Every changed behavior gets its WHY comment; the cast-vs-edition
   distinction (point of this section) belongs at the `--final` flag's
   declaration.

---

## 9. Unit M — metadata joins the ledger, and a curate step casts its own
book (specced 2026-08-15; the two §3/§6 deferrals, built)

Both rulings are already on the books: "Metadata belongs in the ledger"
(§6) and re-casting at a curate landing (§3, deferred; the deferral is
even recorded in code at `projects.ts:1941-1945`). Survey line refs are
current at `a82797c`.

### The metadata step

Today the dialog writes straight into the live document — the OPF inside
the open book's working tree (`meta:write-epub`, `main.ts:2313-2317` →
`workingTreeOf`) or the working PDF whole-file (`meta:write-pdf`,
`:2377-2381`) — and nothing else learns it happened: no step, no
announce, only `noteDocumentEdited`. Two consequences the spec fixes:
the ledger lies by omission, and **an export silently loses the edits**
(the export casts fresh from the bank; the working tree's OPF is not an
input to it).

- **New `StepAction` `'metadata'`**, shaped like curate: retention
  `irreplaceable` (typed human values; each Apply is a deliberate act
  and appends its own row), `RETAINED_BESIDE_YOU: true` (the pointer
  does not move for a save-shaped step), `DISPLAYS_ITSELF: false`
  (a metadata row does not freeze the editor), `SHOWS_ITS_PAYLOAD:
  false`, `BOUNDS_THE_WALK: false`, `PARAMS_OF: ['fields']` — the
  changed-field names, for the label. `labelFor`: **Metadata** (with
  the fields in parens when short, e.g. "Metadata (title, author)").
  Adding the action makes the six `Record<StepAction, …>` tables
  compile errors — that is the design working; the full checklist of
  switches is in the survey (ledger.ts:94, :111, :138, :175, :251,
  :309, :1705, :1865, :1997; glyph map
  open-documents.component.ts:1537).
- **Payload**: `metadata/<uuid>.json` — the patch as applied (kind,
  fields, values). A new `recordMetadata(dir, payload, params)` beside
  `recordCuration` (`projects.ts:1712-1738`), same
  `deletableProjectDir → withManifest → landStep → writeManifest →
  announceProjects` shape, called from the `meta:write-*` handler tails
  in main.ts. The write to the live document stays (the user sees the
  edit at once); the step is the durable record. Deleting the step
  deletes the record, not the applied values — the same honesty curate
  already has, and `deleteCost` says so.
- **Exports apply the chain.** At materialization, the position's
  accumulated metadata patches (walk the ancestry, newest value per
  field wins) are applied to the product as a final stage: `epub-meta`
  on the packed EPUB (the zip form the engine already has,
  `src/epub/meta.ts:679-699`), `pdf-meta` for the facsimile. This
  closes the exports-lose-metadata hole the same way Unit C closes the
  cuts hole. Plain-text exports carry no metadata; skip.
- **The rail gate joins the ruling it already cites.**
  `canEditMetadata` (`tool-rail.component.ts:506-509`) is tab-keyed
  and has no import-row disable, despite `:444-452` recording "Same
  rule for Export and Metadata." Fix: in a project, enabled only when
  the standing step's action is not `import` (the Export shape,
  `:459-466`); loose files keep tab keying.

### The curate re-cast

A curate row shows `castBook(manifest)` — the project's ONE cast
(`documentAtPosition`, `projects.ts:1989-1996`) — so every curate step
shows the same document: the live tree wearing the marks. The ruling:
**a curate landing casts its own book**, so standing on an older save
shows the book as of that save.

- Per-step cast name: `generated/<stem>.<id8>.epub`, `id8` from the
  curate step's own uuid — the exact scheme readings and translations
  already use (`bankForReading` `projects.ts:2365-2370`,
  `translationTarget` `ledger.ts:1165-1171`).
- The plan must be keyed to the STEP, not the position: a curate
  landing leaves the pointer where it was (`RETAINED_BESIDE_YOU`), so
  `planRendering`'s `renderingOverlay(dir, manifest)` would render the
  live overlay under a step-shaped name. A `planConversionForStep`
  variant passes the landed step's own payload via
  `overlayFileFor(dir, manifest, step)` (`projects.ts:1814-1822`, the
  existing seam) and the per-step output name.
- Hook: after `overlay:commit` returns in main.ts (`:2472-2473`) —
  main is where the queue is already reachable (`queue.ensureCast`
  precedent at `main.ts:1101`); `projects.ts`/`overlays.ts` cannot
  import the queue (cycle). Fire-and-forget like `ensureCast`; a
  failed cast is a console line, never a failed save.
- `documentAtPosition`'s read-or-curate arm asks for the standing
  curate step's own cast first (`onDisk`), falling back to
  `castBook` — projects from before this unit keep working. The
  reverse mapping moves with it: `stepStandingFor` maps a per-step
  cast's path to its curate step; `positionPicture` already carries
  the step id when `own` is true.
- The cast is a RENDERING — free, regenerable, never anyone's payload.
  Deleting the curate step sweeps its cast file (`planStepSweep`
  learns the name); the queue's rotation refusal is satisfied by the
  per-step name (nothing overwrites).

Fence: `app/shared/types.ts`, `app/shared/ledger.ts`,
`app/electron/projects.ts`, `app/electron/overlays.ts`,
`app/electron/main.ts`, `app/electron/workspace.ts`,
`app/electron/job-queue.ts` (export stage + cast hook only),
`app/src/app/components/metadata-dialog/**`, `tool-rail.component.ts`,
`open-documents.component.ts` (glyph + label only),
`inspector.component.ts` (standing-strip label only if needed).
Runs AFTER Unit C lands (shares workspace.ts/job-queue.ts).

---

## 10. Phase D — transforms as records: the rulings and the cut
(specced 2026-08-15)

The survey corrected DERIVED-BOOK §5's optimism in four places; these
rulings absorb the findings so no agent re-litigates them:

1. **The bank re-keys, loudly.** Text-level masking changes the masked
   source, which is a key input; `KEY_FORMAT` (`bank.ts:136`) exists
   exactly for this. Bump it (`foundry-translate-bank-2`). Every
   existing translation bank stops matching and a re-generate re-asks
   the model. Considered and rejected: migrating old answers by
   re-keying — recomputing a cross-version masked form is precisely
   the ambiguity KEY_FORMAT forbids. The bank is a cost cache, not
   truth; the honest price is one full re-ask per book, and it is
   accepted.
2. **Footnote records are per-note.** One banked Footnote answer
   becomes several notes only at emit; a whole-block foreign-language
   record has no handle to drop note 3 of 5, so §5's "every language
   drops the block on replay" fails for single notes. Ruling: the
   transform consumes Footnote blocks SPLIT per note (the split rule —
   leading superscript at line start — runs on SOURCE text, so it is
   language-neutral), and a record's `parts` key carries the `#note`
   dimension the overlay grammar already has. A note strike then drops
   its record at materialization like a block strike drops a block.
3. **Chains stay refused this wave.** §5 said translate-of-translate
   "falls out for free"; it does not — the one-hop refusal
   (`pipeline.ts:207-214`), `landsUnder`, and a composed key are real
   design work. Records make chains POSSIBLE; building them is
   deferred and recorded here, not silently dropped.
4. **The EPUB-shaped jobs move into materialization.** A records-mode
   translate produces no EPUB, so `dc:language`/`xml:lang` retagging
   and nav relabelling move to the cast/export: the emitter substitutes
   record text BEFORE nav is minted, so nav headings come out
   translated with no before/after comparison at all, and the language
   tags are set from the step's `params.language`.
5. **Success = the records file's own atomic write.** Pending file +
   swap-into-place, the readings pattern (`readings.ts:399/:574`).
6. **The branched-read overlay ping-pong is pre-existing and out of
   scope.** One live overlay per project vs per-step generations
   archives working corrections on every branch hop
   (`overlays.ts:491-497`). Phase D must not REBUILD the hazard
   (records are per step and consumed per position — they don't), but
   fixing it is separate work, recorded here.
7. **"Edit transformed text" is a human row in the records file.** A
   per-record, per-language correction appends `{key, parts, text,
   author: 'user'}`; materialization takes the newest row per key.
   Per-language by construction (one records file per translate step).
   "Edit block text" (source-level) mirrors to the overlay's existing
   `text` field and re-keys the block's records automatically — the
   masked source changed, so the question changed.

**The cut** (serial where fences overlap):

- **Unit D1 — the engine (fence: `src/**`, `test/**`)**: the
  text-level masker (markdown emphasis pairs + Unicode superscript
  runs; no direct tests exist for `markers.ts` today — write the new
  masker's characterization as fixes to the run.test contract, not a
  parallel suite); grouping rebuilt over FlowBlocks (consecutive
  List-items travel together; Table text is raw model HTML and keeps
  the whole-group refusal); `translate --records` mode: consumes the
  reflowed base of a stamped EPUB, emits
  `readings/<key>.<tag>[.<id8>].records.jsonl` rows
  `{key, parts, generation, text}`, pending+swap, KEY_FORMAT bump;
  materialization substitution: the emitter takes an optional records
  map and uses record text in place of `flow.text` at the one `inline`
  call (`dots-book.ts:1676` area) — provenance/`data-bf-src` keeps
  naming the source block (it is computed from parts, not text);
  language retag + translated nav from substitution; per-note Footnote
  records per ruling 2. The EPUB→EPUB mode STAYS working this unit
  (the app still drives it until D2 lands) — `--records` is additive.
- **Unit D2 — the app (fence: `app/shared/**`, `app/electron/**`,
  renderer dialog/queue surfaces)**: `translateStage`/`planTranslation`
  plan records jobs; the two-stage export becomes cast-with-records
  (vlm-convert reads the step's records file; no tmp EPUB splice); the
  ledger learns the records path (`PARAMS_OF`/`MINTED_BY_THE_RUN` gain
  `records` as `bank` was added; `orphanedBanks`/`destroyedBy`/
  `planStepSweep` learn the third name — the survey names the exact
  lines); the dialog-branch seeding asymmetry is fixed (a branch from
  the dialog seeds records by copy exactly as Generate seeds banks,
  `job-queue.ts:1026-1033`); the shelf's progress parsing keeps
  working (`translate: block N/M` line shape is load-bearing,
  `engine.ts:225-228`).
- **Unit D3 — the ops (fence: renderer + `app/shared/overlay.ts` +
  engine `parseOverlay`/reflow as needed)**: "edit transformed text"
  per ruling 7 (the in-place word editor over a translated book writes
  a human record row instead of the working tree); "edit block text"
  mirrors to the overlay `text` field (today it writes the working
  tree only — the survey's finding 1); both keep
  `refuseUnlessWordEdit` as the guard. **Plus the MANUAL JOIN OP** —
  DERIVED-BOOK §2/§3 promised it the day the ink test died ("the user
  sees the seam on the flowing page, joins it, and the ledger records
  labour like any other decision") and it was never built: the overlay
  vocabulary has no join field, the reflow consumes none, no gesture
  offers it. A 2026-08-15 sweep caught it as a dropped half. The op:
  source-level `join` decision (join this block to its predecessor),
  consumed by the reflow's seam logic, offered on the book where two
  adjacent blocks meet at a page seam, mirrored and committed like
  every other decision. The existing text-override exclusion for
  multi-part elements is a recorded limit — do not silently widen it.

D1 runs alongside Unit M (disjoint: engine vs app). D2 after D1 and M.
D3 after D2. Phase E (retirement) runs last, after D3.

**Folded into phase E, so it stops being forgotten:** DERIVED-BOOK
phase 0 (undo goes in-memory) never landed — `overlay:ledger-load/save`
are still registered (`main.ts:2455-2458`) and the scan-side undo still
persists. The 2026-08-15 ruling (§3 of DERIVED-BOOK, later than the
"survives the app dying" build) stands: BOTH undo persistences —
`overlays/<key>.ledger.json` and `history/<tree>.json` — retire in
phase E, stacks go in-memory per session, fresh per open and per
generation change (not per position move), and the live overlay's
continuous persistence is what makes a crash lose only undo DEPTH,
never decisions.

**Scheduled as its own unit, after E — the branched-read overlay
ping-pong** (foundry-step-model's standing ARCHITECTURAL item, half
fixed by BANK-LIFECYCLE): banks are per-step now, but the live overlay
is still ONE file per project while generations are per read step, so
standing on branch B archives branch A's working corrections aside
(`overlays.ts:491-497`), and hopping back archives again — corrections
ping-pong into stamped folders. The fix follows the bank scheme:
per-read-branch overlay files (`overlays/<key>.<id8>.json` keyed to the
read step), `locateOverlay`/`overlayFileFor` ask the position's read
step, archive-on-mismatch becomes the rare case (a re-read) instead of
the every-hop case.
