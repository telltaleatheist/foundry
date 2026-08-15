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
