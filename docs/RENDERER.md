# The renderer — Foundry's one editing surface, and the plan that gets there

Opened 2026-08-16. **This is the plan of record for the endgame.** Where it
conflicts with WORKBENCH §11 (the iframe continuous book) or DERIVED-BOOK's
phases, this file wins; where it is silent, those stand. PLAN.md indexes it.

Written to be executed after a context compaction: everything needed to build
is IN this file or in the named source files, and nothing depends on the
conversation that produced it.

---

## 0. The rulings this plan is built on (user, 2026-08-15/16)

1. **No EPUB as working form.** *"we arent supposed to be rendering the book as
   an epub. it's supposed to be rendered as an html page… an open, permanently
   unzipped html page… the user isnt reading a book on foundry, they're editing
   the contents of a book… when the user hits export, thats when the contents of
   the bank are compiled into whatever format they choose."*
2. **Facsimile first, then reflow, immediately.** *"lets render a facsimile pdf
   the moment the vlm finishes, and then reflow the bank immediately. fix
   hyphenated words, join paragraphs split across pages, etc."*
3. **One file, merged blocks, unique ids, positions kept.** *"merge the bank
   into a single file, merge blocks that were split by pages, and keep page
   numbers as a rough estimate IF WE CAN. give each block a unique ID after
   merging the split ones back together, and make sure we have their position on
   the page."* Pages are kept and **not trusted**; identity is the id.
4. **Footnotes are complete on their page** — *"standard publishing practice"* —
   which is what makes splitting them into rows safe.
5. **Ledger-based, with derived banks at commits.** *"we should still operate
   off of a ledger-based system, and when the changes are saved/committed, we
   could produce a new, second bank with the updates/changes."* The stack is
   LIFO in memory; Apply writes it to disk as a step and clears it; closing
   without applying scraps it.
6. **No fallbacks, ever.** Fix at the root; error if there's a problem.
7. **No OCR errors.** *"assume they dont exist."* Kills bulk-fix and suspicion
   heuristics; keeps only LINKING flags (a marker with no note, a note with no
   marker), which are structural, not OCR.
8. **Priorities.** Tier-2 structure ops (drag/split/merge, reading-order
   repair, furniture review, unlinked-ref flags) are *"the biggest wins"*.
   Aligned translation view is *"great"*. **Export preview is high priority.**
   Ops-timeline, live streaming: only if nearly free. Crop adjustment, table
   grid: later. The block outlines today are *"sloppy and ugly"* — fixed by
   owning the chrome.
9. **Footnote ↔ reference numbers.** Better catching/linking wanted; *"if i
   delete footnotes, it removes their corresponding reference numbers."*
10. **Imported EPUBs** are valid originals: strip every script, then treat as a
    normal document. The renderer is Angular-native, *"fully integrated into
    the angular system."*

Assumptions the user can veto (stated here so they are vetoed BEFORE the build):

- **A1 — one editing surface.** The PDF block editor (select mode over page
  images) retires with the overlay system. The scan and the facsimile stay
  viewable; editing happens on the rendered book only.
- **A2 — transport is Electron IPC**, not websockets. Websockets buy nothing
  inside one Electron app; revisit only if a browser/remote client becomes a
  goal.
- **A3 — the facsimile is a terminal row under the import** (the user's own
  tree: *"from the bank, pdf facsimile can be generated. that's a terminal
  item"*).
  **Superseded in part, user ruling 2026-08-16: it is produced ON DEMAND, not
  at read-landing.** The automatic production was protection from before the
  bank was kept unconditionally — a reprint on the disk was the one record of a
  reading nothing downstream could invalidate. The bank is always kept now, so
  the bank IS the protection and a facsimile needs none: it is `vlm-convert
  --format pdf --reuse-readings`, offline, seconds, repeatable forever. A read
  landing produces the book file and nothing else; the reprint is made when
  somebody asks (Export → Facsimile PDF), and its row is deletable exactly as an
  export's is.

---

## 1. The model, in one page

```
archive/<scan>.pdf                the untouched original (irreplaceable)
readings/<key>.jsonl              RAW BANK: model answers per page (expensive)
    │
    ├─► facsimile PDF             made ON DEMAND (vlm-convert --format pdf);
    │   (terminal, deletable)      the page-for-page record
    │
    └─► readings/<key>.book.jsonl BOOK FILE: one row per block, ids minted,
        (regenerable)              hyphens fused, page turns joined, notes split
             │
   ledger steps carry OPS         deltas keyed by block id (§3)
   committed transforms           DERIVED book files, parent ids kept (§4)
             │
   RENDERER shows                 replay(nearest ancestor book file, ops chain)
   EXPORT compiles                the same replay → epub / txt via the engine
```

- The engine's `vlm-book` (landed, `src/vlm/book-run.ts`) and `--format html`
  (landed) already exist. The app never unzips anything again.
- The raw bank is the reset point. Derived book files are `regenerable`
  retention — sweep freely, rebuild from parent + ledger.
- One strike lives in exactly ONE place: an op in the ledger. (Today it lives in
  four — frame DOM, spliced XHTML in `working/`, `overlays/<key>.json`,
  `curations/<uuid>.json` — and every guard in the app exists to reconcile
  them. See PLAN.md wave 4e for the diagnosis.)

## 2. Book file v2 (engine)

v1 is landed (`src/vlm/book-file.ts`): merge across pages, `b<page>-<order>`
ids derived from the first banked answer (a merge consumes the SECOND block, so
re-running never renames survivors), composed boxes (origin of first part +
summed heights + union width), notes as rows `b<page>-<order>#<ordinal>` with
the footnote area shared by characters. v2 adds:

- **Reference markers as data.** Each note row gains
  `refs: [{block: "b2-3", at: <offset>, len: <n>}]` — resolved at reflow by the
  same printed-number matcher the emitter uses today (`dots-book.ts`, noteref
  matching). The renderer draws each marker as an element bound to its note id;
  **deleting a note removes its number as a DERIVED fact** (and restore restores
  it) — never a second op. A marker with no note and a note with no marker are
  flagged in the margin; `{op:"link"}` (§3) fixes a missed match by hand.
- **Split ids.** A user split of `b2-3` mints `b2-3/1`, `b2-3/2` — derived from
  the parent id, deterministic, never colliding with bank-derived names.
- **Chapter seed.** The file carries the engine's detected chapter starts (block
  ids + labels) as a `chapters` header field. Ownership is by ops exactly as
  today's confirmed-list rule: the first chapter op takes the list over; "Use
  Foundry's" is an op that returns it.
- **Inline markup stays source-level.** Block text keeps the model's inline
  markers (`*italics*`, superscripts); the renderer renders them through the
  same inline rules the emitter uses (`dotsInline`, ported to shared/). Text
  edits edit the source string. Rich WYSIWYG editing of inline markup is
  deferred.

## 3. The op grammar (ledger payloads)

One JSONL file per Apply — the step's payload, a DELTA (never cumulative), keyed
by block id only:

```
{"op":"strike","id":"b2-4#3"}          {"op":"restore","id":"b2-4#3"}
{"op":"text","id":"b2-3","text":"…"}   {"op":"category","id":"b7-2","category":"Quote"}
{"op":"merge","id":"b8-1","into":"b7-9"}     — into keeps its id, absorbs text
{"op":"split","id":"b2-3","at":214}          — mints b2-3/1, b2-3/2
{"op":"move","id":"b4-2","before":"b4-6"}    — reading-order repair
{"op":"chapter","set":"b5-1","title":"…"}    — also move/remove/rename/reset
{"op":"link","block":"b2-3","at":214,"len":1,"note":"b2-4#0"}
{"op":"restore-furniture","id":"b3-0"}       — un-drop a shelved row (keyed by id
                                               since v3 made the shelf ROWS; the
                                               src spelling predated that)
```

- Replay is a pure function `blocks → blocks` in `shared/`, used identically by
  the renderer (a computed signal) and by export materialization. Ops that name
  a block a bank no longer has are **reported, never guessed at**.
- Undo/redo is the in-memory stack; Apply writes and clears; the existing
  uncommitted-close dialog survives as the scrap-guard. `history.ts` and the
  overlay ledger retire (undo does not persist across sessions — already ruled
  in DERIVED-BOOK §3).
- **Standing on any step = replay of that chain.** No snapshots, no frozen
  copies, no `curation-lock.ts` — there is nothing to diverge, so there is
  nothing to guard. Editing while standing on an old step starts the stack from
  that step's state; Apply lands the new step as its child (branching is what
  the tree already draws).

## 4. Derived book files at transform commits

When a translate (later: simplify) lands, main materializes
`parent book file + chain ops + records → readings/<key>.<lang>.book.jsonl` —
same format, **parent ids kept verbatim**, struck rows absent, text replaced
from records. Downstream positions read the NEAREST ancestor book file, so
replay is always one short hop, and the aligned view (§6) is two files with the
same ids. Derived files are regenerable; the records file remains the step's
payload (truth), the derived file is a materialization.

Translation records re-key from `page:order[:part]` to block ids; the book
file's `src` column is the mechanical mapping (that is why it exists).

## 5. The renderer (app)

**Angular-native. No iframe, no sandbox, no postMessage, no injected script.**
A block is a component; the book is `@for (block of view())` under CDK virtual
scroll (a 400-page book is ~30 live components). `click-reporter.ts` (~2,200
lines) deletes entirely, and with it the sloppy outlines: selection, hover,
struck-X, drag handles, chapter lines are our own chrome, styled properly,
animated where it helps.

- **Data path:** main reads book file + ledger → IPC → signals. Pictures serve
  over the existing `foundry-file` protocol. Imported-EPUB blocks are sanitized
  in main (`sanitizeChapter` already exists) before they ever reach a template;
  model-produced text is rendered through our own inline rules, not
  `innerHTML` of foreign markup.
- **Gestures → ops:** click/marquee select; Delete strikes (X chrome stays
  visible always — landed rule); Enter-at-caret splits; a drag handle merges;
  drag to reorder in an explicit order-repair mode; drag chapter lines; click a
  flagged marker to link it.
- **Panels:** Chapters (already one unit — rewired to ops), **Notes** (every
  note, jump-to-marker, unlinked flags both directions), **Furniture review**
  (the running heads the reflow dropped, listed with un-drop — today a log line
  nobody can act on), Category legend (kept).
- **Export preview — high priority.** The same replay projected through the
  export rules (struck elements absent — a struck note's number cut from the
  prose with it, per ruling 9 — live refs demoted, edition attributes
  withheld — the `--final` table in `dots-book.ts`) with the export stylesheet.
  A toggle, not a build: nothing is written, no engine spawns.
- **Aligned translation view:** two scroll-locked columns over two book files
  with the same ids; edit either side (source edits invalidate that block's
  records — already the records model's rule; translated edits are per-language
  record corrections).
- **Streaming (only because it is nearly free):** the records file is appended
  row-by-row as the model answers; main tails it and pushes rows over IPC; the
  aligned view fills in live. If it grows beyond a file-tail and a signal, it
  waits.

## 6. Orchestration and export

- **Read lands →** main runs `vlm-book` and nothing else. It is the read step's
  product and is not a step of its own. **(Amended, user ruling 2026-08-16: the
  facsimile no longer lands with it — see §0 A3. It is produced when asked, and
  a facsimile already on disk is deletable from its row like an export.)**
- **Open a book →** renderer over the position's book file + ops. No unzip, no
  `working/`, no cast EPUBs.
- **Export →** materialize (replay) → engine compiles EPUB/txt; facsimile
  compiles from the RAW bank only. `epub-final`'s tidy rules run inside the
  compile as they do today.
- **Imported EPUB (its own wave):** sanitize → explode spine HTML into block
  rows (one per element, ids `e-<n>` in spine order, no boxes → no typography
  derivation, no facsimile) → same book file, same ops, same renderer.
  Everything downstream is identical by construction.
  **Refinement (user ruling, 2026-08-16): the publisher's data is retained,
  not rediscovered.** The unification layer is the BOOK FILE, not the bank —
  an EPUB is never OCR'd into a bank (a bank models pages and an EPUB has
  none; re-reading real text through a vision model would trade exact data
  for a guess at it). The EPUB itself is the receipt: archived immutable,
  `book = f(epub)`, regenerable like any reflow. What `f` keeps:
  the publisher's nav/NCX becomes the chapters header verbatim; semantic
  markup maps to categories (h1→Title, h2/h3→Section-header,
  blockquote→Quote, figcaption→Caption, `aside epub:type="footnote"`→
  Footnote rows, figure/img→Picture, table→Table, li→List-item, p→Text);
  the publisher's own noteref anchors mint `refs` EXACTLY (no printed-number
  matching, so no loose markers from a well-made EPUB); images copy once
  into the `.images/` directory; inline emphasis folds to the same source
  markers the model writes. `vlm-compile` already exports any book file
  with no reference to a bank, so the whole downstream — ops, panels,
  Edition, export — works on day one of the explode.

## 7. What dies, and what stays

Dies (the bulk of app/electron's document machinery — deletion, not bypass):
`working/` unpacking and the whole working-tree lifecycle; `epub-reader.ts`'s
byte-splicing family (`setBlockCuts`, `setBlockHtml`, `renameEpubHeading`,
`renameNavAnchor`…); `overlays.ts` and the `{page,order,note}` grammar;
`curations/*` snapshots; `curation-lock.ts`; `history.ts`; `click-reporter.ts`;
the epub-view iframe stack; per-step cast EPUBs (`castForCurateStep`,
`castForTranslateStep`, `castBook`) and `ProjectSummary.renderings`; the
generation reconciliation (`readingGeneration`, `overlayFate`, archived-aside
folders); the html-editor machinery; the PDF block editor's WRITE half (A1).
Wave-6 "branched-read overlay ping-pong" (PLAN.md) is **superseded** — there
are no overlay files to ping-pong.

**Landed at R6b, with the deletion proven by grep and the gates:**

- **The cast EPUBs — DONE.** `ensureCast`, `castFlowingBook`, `ensureStepCast`,
  `castStepBook`, `ensureTranslateCast`, `towardTheFlowingBook`,
  `planConversion`, `planConversionForStep`, `castNameFor` and the
  `workspace:plan` door are deleted whole. A reading's landing makes the book
  file and nothing else (the facsimile stopped landing with it on the 2026-08-16
  ruling, §0 A3); a save's landing and a translation's landing make no document
  at all, because the row they mint is answered by the sheet. `planRendering`
  composes exactly two things now: a facsimile into `generated/`, and an export
  into `final/`.
- **The legacy export branch — DONE.** `compiles` was three conjuncts and is
  now one (`kind === 'epub' || kind === 'txt'`): EVERY epub and txt export
  materialises and compiles, edited or not, in either language. The facsimile
  is the only rendering that still goes down the bank route, which is what it
  has always been a record of.
- **Standing on a `curate` row — DONE, and it is §8's re-key.** See §8.

**Landed at R6c — every item above, and the app has ONE editing surface.**
Item by item, all DONE:

- **`overlays.ts` + `shared/overlay.ts` — DONE.** Both files deleted whole, and
  with them the `{page,order,note}` grammar: no module in this app can spell an
  overlay target. `curate-bridge.ts` reads a frozen snapshot with its own closed
  parser and imports nothing from either (it imports two types, from `./book`
  and `./ops`, and nothing else).
- **`curation-lock.ts` — DONE**, and every consultation with it: `lockIn`,
  `lockOn`, `heldByASave`, the inspector's frozen banner, the PDF pane's notice.
  There is no `electron/curation-lock.ts` and never was; the module was shared
  only. Standing on any step is a replay of that chain, so there is nothing to
  diverge and nothing to guard.
- **`uncommitted.ts` — DONE, whole.** It was about the live CURATION and nothing
  else. The BOOK pane's scrap-guard is a different mechanism entirely — the
  pane's `BookStack.pending()`, read in `questionBefore` — and it is untouched;
  what came out of that function is the `corrections` arm and `CloseWarning`'s
  field for it.
- **`history.ts` — DONE**, with the `history:*` channels, the `ledgers` map, the
  `LedgerRow`/`LedgerAction`/`LedgerStacks`/`LedgerLoad`/`LedgerField` types and
  `replay`'s four non-book doors. Undo is the pane's in-memory stack alone.
- **`click-reporter.ts` and the iframe stack — DONE.** The epub-view and
  html-editor components are deleted, the `epub` and `editor` tab kinds are gone
  (`TabKind` is `'pdf' | 'book'`), the `foundry-file://epub/` host and the
  reporter's support-file serve are removed from the protocol handler, and
  `frame-src foundry-file:` is out of the renderer's CSP. The `book` host — the
  figure crops — stays and is now the only one.
- **`epub-reader.ts` — DONE, whole.** Nothing surviving reads an OPF through it:
  `meta:read-epub`/`meta:write-epub` went with it, because both resolved an open
  book's WORKING TREE from a tab's book id and there is no such tab. The engine
  owns every OPF read this app still makes (`epub-meta`, spawned), so **no
  survivor had to be extracted**.
- **`epub-writer.ts` — the pack half DONE, `writeAtomically` SURVIVES** in
  `electron/atomic.ts`, named for what it does. Its two callers are `book.ts`
  (the book file and the ops payloads) and `projects.ts` (a records append).
- **The `working/` lifecycle — DONE for the TREES.** `workingTreeName`,
  `WorkingTreeRecord`, `workingTreeFor`, `recordWorkingTree`, `treeGeneration`,
  the hold registry, `rotationRefusal`, the rotation's tree passenger and every
  `working.trees` read and write are gone. **`working.files` and the live PDF
  SURVIVE, deliberately**: that row is the project's writable copy of the scan,
  it is what `meta:write-pdf` writes into and what Home draws the scan's row
  from, and the metadata step machinery is an invariant of this wave. The two
  are different tenants of one folder name. Old manifests still parse — see §7a.
- **The PDF block editor — DONE, and the DISPLAY went with the write half.**
  A1 retires the editor and promises the scan and the facsimile stay VIEWABLE;
  it does not promise the outlines. What would have remained after the gestures
  came out reads the overlay file, so keeping it would have meant keeping the
  grammar this wave deletes whole — to draw less than the proof sheet draws, over
  a photograph, in the chrome ruling 8 calls *"sloppy and ugly"*. **This is a
  judgement made in-wave and it is the one place R6c went further than the
  brief**: the pane is now a viewer (page, text layer, thumbnails, search) and
  `overlay:blocks`, `readPdfBlocks` and the `PdfBlock*` types went with it.
- **`castForCurateStep`/`castForTranslateStep`/`castBook`/`renderingsOf`/
  `ProjectSummary.renderings` — DONE**, and so are `documentAtPosition`'s dead
  arms: a read, a save and an edit row answer **null**, which is `positionView.sheet`
  saying the proof sheet is what that position shows. `curateCastFile` and
  `translationCastFile` are deleted from `shared/ledger.ts` with them.
- **The UI doors — DONE.** Select on the dock; the viewer's two tab-kind
  branches; the library tree's HTML-face row, its editor drop refusal and its
  editor glyph; the Settings **Curation card** and all three standing answers it
  set (`unlinkedNoteAnswer`, `contentsRenameEcho`, `headingEditEcho`) with their
  three question handlers and `confirmUnlinkedNote`/`confirmHeadingEcho`/
  `confirmNavEcho`; the inspector's Category section, its scan/EPUB Chapters
  section, its word-correction box and its **Apply changes** button (Apply lives
  on the paper, beside the changes it applies). An EPUB export row and a finished
  epub job are **reveal-only** — an export is a product and this app has one
  viewer for a file. And `inspectorUp` now admits a `book` tab, which it never
  did: the proof sheet's own panels were unreachable until this wave.

**Two narrowings, named rather than left to be found.** PDF metadata editing is
now the only metadata dialog write (the EPUB arm had no document to write into);
and a loose `.epub` opened from disk no longer makes a tab of its own — it is an
IMPORT, and the project's proof sheet is what opens when the import lands
(`awaitBook`, core/tabs.service.ts).

Stays: the ledger model whole (steps, payloads, retention, staleness, deletes,
the tree, one-selection), the queue, Home, imports, metadata steps, exports
into `final/`, the Ollama teardown, the engine's every command.

## 7a. What an old project on disk keeps, and what stops reading it

Nothing is swept and no version is bumped. `readManifest` gates on the version
(1 or 2) and never on a key, and it REBUILDS the catalogue from named fields —
so a field it stops naming never reaches memory and simply leaves disk the next
time anything writes the project for a reason of its own. That is the precedent
`ProjectReading.passes` already set.

- **`working.trees`** — tolerated on read, never read, never written. The
  `working/<tree>/` directories themselves are left where they are: they are a
  book's markup and this app does not delete somebody's files to tidy a folder.
- **`overlays/<key>.json` and its `.ledger.json`** — never opened again. The
  decisions in them are not lost: a `curate` step's frozen snapshot is the
  record, and §8's bridge replays it as ops on every open.
- **`history/<tree>.json`** — never opened again. Session-scoped undo was always
  the ruling (DERIVED-BOOK §3); this is the persistence that outlived it.
- **`curations/<uuid>.json`** — READ, forever, by `curate-bridge.ts`. This is
  the one thing in the list that is still live, and it is the reason `curationsDir`
  survives.

## 8. Migration (small, runs once per project on open)

Existing projects predate ids. On first open under the new model: build the
book file from the raw bank; re-key old curate amendments and translation
records through the book file's `src` mapping; archive `overlays/` and
`curations/` aside (never deleted). The user's library is small and
dev-stage; the re-key is mechanical because `src` records exactly the old
coordinates.

**As built at R6b, and the one place the built thing differs from the sentence
above — deliberately.** The re-key is NOT a pass that rewrites anything on
disk; it happens when the book is opened, every time, in
`shared/curate-bridge.ts`. Two reasons, and both are this plan's own rules:

1. **A curate step's payload is that row's record and it is `irreplaceable`**
   (`RETENTION_OF`, shared/ledger.ts). Converting payloads in place would be
   this app editing somebody's history to make its own reading easier, and the
   invariant everything else here rests on is that no step is deleted from
   anybody's ledger and no step's payload is deleted by migration. So
   `curations/<uuid>.json` stays exactly where and as it was written.
2. **Ensuring the book file was already the migration** (§9, R2). There is no
   "first open under the new model" hook to hang a one-shot pass on, and adding
   one would be a second thing that has to stay true.

So: `editsSinceTransform` admits `curate` rows onto the replay walk;
`openBookAtPosition` reads the snapshot and re-keys it through `parts[].src`;
the decisions replay as ordinary ops. `strike`/`restore`, `category` and `text`
map one to one. The chapter spine is stated in FULL — every seeded division the
save did not keep is `remove`d and every division it named is `set` — because
the old format's list was definitive where the op grammar's takeover rule starts
from the engine's seed, and saying it in full is what makes the two agree.

**What does not map is said on the paper, never guessed at** (§3). An amendment
whose coordinate is in no row of this book, a text override whose banked answer
this reflow reads as several blocks, and every `join` — a manual page-turn join,
which is a SEAM on the sheet now and is joined against the two ids the seam
names — produce no op and one sentence each, carried on the load as
`BookLoad.unplaced` and drawn above the sheet. `archive overlays/ aside` was
NOT built and is not needed by any of this; it belongs with the deletion of the
overlay system in R6c.

## 9. Execution order

Rules of engagement are PLAN.md §1's, unchanged — five gates every unit,
Angular gates only in the main checkout, agents never commit, no new tests
unless asked, an honest partial beats a bent whole.

- **R1 (engine)** — LANDED `8e68348`: book file v2 — ref markers, chapter seed, version bump;
  `vlm-book` regeneration keeps ids. **Materialization is NOT here**: the
  replay lives once, in `app/shared` (the renderer needs it in-process), so
  MAIN materializes derived book files and the engine never replays ops —
  one implementation, not two. The engine learns to COMPILE FROM a book
  file in R5, which is when export needs it.
- **R1b (engine)** — LANDED `d9c222a`: book file v3 per **docs/BOOK-FILE.md** — the format
  contract, written as an architect would: receipt/book wall, purity
  (`book = f(receipt)`), atomic writes, bankSha integrity, deliberate-only
  regeneration, forward-compatible versioning, `parts` with char ranges,
  the shelf (furniture + suppressed heads as restorable rows), seams as
  block-id pairs, figure crops cut once into `readings/<key>.images/`.
  User ruling 2026-08-16: *"i want to do this right, even if it takes up a
  little bit more disk space."* The app mirror (`app/shared/book.ts`)
  updates to v3 in the same commit that lands R1b or the one immediately
  after R2 — never later. (Done: the mirror landed v3 in `7f234e4`, the
  commit after R1b, with the seams and shelf on the pane, the figure
  crops served through an allow-listed `book` host, `--pdf`/`--language`
  through the ensure step, and bankSha verified on every open.)
- **R2 (app spine)** — LANDED `b3e8351`: book file + ops over IPC; renderer skeleton READ-ONLY —
  blocks, virtual scroll, selection, proper chrome per RENDERER-DESIGN.md.
  Opening a read position ENSURES the book file (main spawns `vlm-book` if
  absent), which doubles as the migration for existing projects.
  Facsimile-at-read-landing is split out as **R2b** — small, separate, after
  the skeleton proves the pipeline.
- **R3 (ops core)** — LANDED `b82b2a8`: the shared replay; the in-memory stack; strike/restore
  (with derived ref removal), text edit, category; Apply → step; standing on
  any step renders its chain; branch-on-edit-at-old-step.
- **R4 (structure ops)** — LANDED `1fa72ff` (replay: every §3 op performed) +
  `ade0c97` (surfaces: seam-join click, Enter-at-caret split, Ctrl+J merge,
  chip rename; Chapters/Notes/Furniture panels in the inspector pushing onto
  the pane's stack). Drag-to-reorder and rule-dragging deferred out loud —
  the `move` and chapter-`move` ops exist; the drag machinery waits, with
  comments standing where each would hang.
- **R5 (projections)** — LANDED in four slices: `fb974af` (R5a, the Edition
  toggle), `de5cd2f` (R5b, materialize + `vlm-compile`, export refusal
  lifted), `f2b39f6` (R5c, translations through the book file: `--book`
  source, block-id records, derived files at translate landings, the
  second edit-walk bound, translate + translated-export refusals lifted),
  and **R5d — the aligned translation view**. `book:load` on a translated
  position carries the pair in ONE answer (`BookTranslation`: the target
  language, and the parent position MATERIALISED — rows only, no ops chain,
  because it is `writeTranslationBook`'s own first half and that is exactly
  why the ids line up). An `Alone | Aligned` toggle stands beside
  `Workbench | Edition` on translated positions only — not a third segment,
  because Aligned composes with the workbench and is meaningless against the
  edition — refused in Edition and below ~68rem of pane, with the sentence
  said as a title AND on the notice strip. Two scrollers are locked BY ID,
  the column a hand is on holding the wheel until `scrollend`; where a row
  is on one side only (struck under the translation, the halves of a cut)
  the anchor is the NEAREST PRECEDING shared row — a documented rule with
  its own pure function (`sharedAnchor`, book-view/flow.ts), chosen because
  it is the same answer whichever column drives. The hover tint reaches
  across the gap by id. And a TEXT EDIT on a translated block routes to
  `book:correct`, which appends a block-id-keyed row to the records,
  re-materialises the derived book and answers with it: a `text` op there
  would leave the ops chain and the records saying different things about
  one paragraph, which is `translationWorldOf`'s own argument. Structure ops
  (strike, category, merge, split, chapter) stay ordinary ops. Source edits
  stay where they already were — above the translation, where changing the
  words changes the question the cost cache is keyed on. **Records streaming
  did not land**; §10 says why.
- **R6 (subtraction)** — landing in slices:
  - **R6a — LANDED `65b150b`:** the imported-EPUB explode. The container is the
    receipt, `book = f(epub)`, the publisher's nav and semantics kept.
  - **R6b — LANDED (this commit):** the cast EPUBs deleted whole; the legacy
    `vlm-convert --overlay --final` export branch collapsed, so every epub and
    txt export materialises and compiles; the proof sheet made the answer for
    `curate` and `translate` rows; §8's re-key built as a read-time bridge so an
    old save replays as ops and says out loud what it cannot place. WORKBENCH
    §11 marked superseded. §7's remaining list is annotated with what landed and
    what did not.
  - **R6c — LANDED (this commit):** the deletion the wave is named for. Eleven
    files gone whole (`overlays.ts`, `shared/overlay.ts`, `curation-lock.ts`,
    `uncommitted.ts`, `history.ts`, `click-reporter.ts`, `epub-reader.ts`,
    `epub-writer.ts`, `unrender.ts`, the epub-view and html-editor components,
    the Settings curation card), `writeAtomically` extracted to
    `electron/atomic.ts`, `TabKind` down to `'pdf' | 'book'`, the working-TREE
    lifecycle out (the live PDF stays — §7), the block layer off the PDF pane
    including its read-only display (§7 says why that went further than A1
    required), and every UI door with them. **THE APP HAS ONE EDITING SURFACE.**
    §7 carries the item-by-item marks and §7a says what an old project keeps.

Each wave lands and pushes before the next starts. R1 and R2 can run in
parallel (disjoint trees: `src/` vs `app/`); everything after is serial through
the main checkout.

## 10. Deferred out loud (with reasons)

- Crop adjustment — WANTED, back-burner by ruling (2026-08-16): *"im going
  to want crop adjustment but i think we should get the system nailed down
  first."* Table grid editor — *"talk more about it later."*
- Ops-timeline UI — the data model provides it whenever wanted; no UI now.
- Bulk fix / OCR suspicion — no OCR errors (ruling 7).
- Re-read-a-block at higher resolution — build only if garbling ever appears.
- Scan-crop-beside-block affordance — valuable, not in these waves.
- Websockets / remote client — A2.
- Rich WYSIWYG inline-markup editing — source-level text edits first.
- **Records streaming into the aligned view — LEFT OUT AT R5d, and the reason
  is not effort.** §5 admits it *"only because it is nearly free"* — a file
  tail and a signal — and the thing it would fill in does not exist while a
  run is going. A translate step is minted at its LANDING (`recordTranslation`
  is called from the queue's settle, electron/job-queue.ts), so while the
  model is answering there is no step in the ledger, no position under it, no
  derived book, and therefore no aligned view for rows to arrive in. The one
  case that IS reachable is a RE-RUN over a step somebody happens to be
  standing on, and paying for it would mean: a watcher per pane with a
  lifecycle across tab moves and position moves, an offset reader tolerant of
  the whole-file rename a correction makes under it, a channel and a
  subscription through preload, and a rule for what the column means while it
  is half the old translation and half the new one. That is not a file tail
  and a signal. The honest place for it is beside a translate step that exists
  from the moment the job is queued — which is a change to the ledger, not to
  this pane.
