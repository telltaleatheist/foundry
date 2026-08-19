# The capture stage — photographs become the book the pipeline reads

Opened 2026-08-19. Status: **PLANNED** — this is the plan of record for the
feature. Ruled by Owen in conversation the same day; the work packages at the
bottom are how three agents build it in parallel without treading on each
other. The contract between the packages is the recipe schema and the IPC
table in this document — **change either only by editing this document
first**, then building. That rule exists because the last collaboration's
recurring defect was two agents holding two spellings of one interface.

## What this is

Owen photographed bound volumes at the American Atheists headquarters archive
— *The Index* (1876) is the first — and the photos need to become a PDF the
existing pipeline can read. Each photo is a two-page spread, tilted a few
degrees, desk visible around the book, perspective lean from the camera
angle. This feature is an entirely new section of the pipeline, UPSTREAM of
everything that exists: photo intake, a light-table editor (reorder, rotate,
split, crop), and a mint that produces an ordinary image-only PDF.

**From the minted PDF onward, nothing changes.** The read banks page answers
against its pages, figures crop from them, the derived book and export work
as they do today. That seam is the most important decision in this document:
the entire feature is invisible to the engine.

Ruled by Owen, 2026-08-19:

- The stage lives **inside the project** — a new arrival kind, not a
  standalone tool. The originals and the recipe stay with the project and
  stay re-editable after a read has happened.
- The crop tool is a **four-corner quad**, which removes perspective lean in
  the same gesture. On a straight-on shot the quad is a rectangle.
- Assist is explicit **"apply to all"** (copy semantics), plus late-dropped
  photos inheriting the previous photo's settings. No computer vision in v1.
- **Automatic de-skew and AI sharpen are wanted LATER** — deferred out loud
  at the bottom, not forgotten.

## The model — three truths

**1. The originals are the bank of this stage.** Dropped files are copied
into the project untouched and content-addressed (`capture/originals/<sha>`,
extension preserved). Nothing ever edits them. Every other artifact of this
stage is derivable from originals + recipe, which is the same guarantee the
derived book gives one stage later.

**2. The edits are a recipe, and the recipe is plain current-state JSON —
NOT an ops journal.** This is a deliberate divergence from the derived-book
model, and the reason is recorded so it is not mistaken for an
inconsistency: the book uses ops-replay because strikes must replay onto
regenerated banks. Here nothing upstream ever regenerates — the originals
are immutable bytes — so there is nothing to replay onto, and a journal
would be machinery without a customer. Same non-destructive guarantee,
simpler mechanism.

**3. The PDF is a minted step.** Minting rasterizes each unstruck page-quad,
assembles an image-only PDF, and appends a step to the ledger. It costs no
model time — cheap by the queue=expense rule — but takes minutes of local
compute, so it runs as a job with progress and cancel.

**Re-mint semantics, stated now because it will be asked later:** a re-mint
after recipe edits produces a NEW step and a NEW document. Readings hang off
the old one, untouched; the new document reads fresh. Carrying banked
answers across a re-mint for pages whose pixels did not change is a real
optimization and is DEFERRED OUT LOUD — v1 does not attempt it.

## The arrival and the ledger

A project can now arrive as a **capture**: the first step holds the photo
set and the recipe lives beside it. The mint appends a step whose payload is
the produced PDF, **parented to the capture step and marked as minted** —
shaped so that everything downstream that asks "where is the document?"
finds the same answer it finds for an imported PDF.

The exact shape of that step (a new action vs. an `import` step with minted
provenance) is settled by P3's audit of `app/shared/stages.ts` — every
predicate in that file (`canRunHostActFrom`, `hostActPositionFrom`,
`hasBookAt`, `arrivedAsBook`, `importedAsEpub`, and the rest) gets walked
against the capture arrival, and the audit result is written back into this
document. Wave 15's Narrate gating and Wave 16's queue seam are the two
places most likely to notice; neither may regress. Until a PDF is minted,
nothing downstream is offered — no read, no narrate, no export.

## The surface — one grid, three gestures

**Entry:** a "New project" button; the empty project shows a persistent
drop zone along the side. Files can keep landing there for the life of the
project.

**The grid IS the main viewer** for a capture project with no minted PDF:
one card per page (initially one per photo), sorted by capture time — EXIF
`DateTimeOriginal`, falling back to file mtime — with an ascending/
descending toggle. Cards drag to reorder; once the user has dragged, the
sort is history and their order is the order.

- **Reverse operates on capture order, not on split halves.** A book shot
  back-to-front reverses into reading order by spread; within each split
  the left page still precedes the right. Reversing raw page cards would
  silently swap every pair.

**The gestures**, each on a single page with an "apply to all" affordance:

- **Rotate** — quarter turns. Apply-to-all stamps the turn on every page.
- **Split** — drag a line onto the page, press Split, the card becomes two
  cards in the original's slot, left then right. "Apply this split to all"
  touches **only unsplit photos** — a page already split and hand-adjusted
  is never re-split out from under the user.
- **Crop** — the quad. Four corners dragged onto the page's corners; the
  mint rectifies that quad to an upright rectangle, resolving tilt,
  keystone, and crop in one transform. Apply-to-all copies the quad(s) to
  every photo.

**"Apply to all" is a copy, not a link.** It stamps the current value onto
every page at that moment; adjusting one page afterward never disturbs the
others.

**A photo dropped in later starts from the settings of the photo before
it** — the one trace of carry-forward that survives, so late additions do
not reset to blank.

Striking: a page card can be struck (a retake, a blur); a struck page stays
visible on the grid the way struck rows stay visible on the workbench, and
is excluded from the mint.

## The recipe, exactly

`capture/recipe.json`, whole-document read/write (it is small — hundreds of
photos is kilobytes of JSON):

```json
{
  "version": 1,
  "photos": [
    {
      "id": "9f2c…",
      "file": "originals/9f2c….jpg",
      "takenAt": "2026-08-17T14:03:22Z",
      "split": { "x": 0.51 },
      "pages": [
        { "id": "9f2c…:0", "quad": [[102,88],[1963,120],[1948,2905],[85,2871]], "struck": false },
        { "id": "9f2c…:1", "quad": [[2010,118],[3891,96],[3905,2899],[2022,2911]], "struck": false }
      ]
    }
  ],
  "order": ["9f2c…:0", "9f2c…:1"],
  "descending": false
}
```

Conventions, pinned:

- `id` is the sha of the original bytes. `pages[].id` is `<photoId>:<n>`.
- **Quad points are in ORIGINAL-image pixel coordinates** — the bank's own
  grid, never a rotated or scaled copy's.
- **Quad corner order is [top-left, top-right, bottom-right, bottom-left]
  OF THE OUTPUT PAGE.** The corner assignment IS the orientation: the
  rotate gesture permutes the assignment, and no separate rotation field
  exists to disagree with it. One value, one meaning — the two-things-
  sharing-a-name lesson applied in advance.
- `split` is kept for the editor's line handle (re-dragging re-derives the
  two quads); the quads are authoritative for the mint.
- `order` lists every page id, struck included; the mint filters strikes.
- Output page size = the quad's opposite-edge maxima; MediaBox at a nominal
  300 dpi. The read renders at 200 dpi under a 2 MP budget downstream, so
  nominal is fine.

## Where the work runs — and why

**Intake (main) decodes HEIC once, into a JPEG working copy beside the
original** — Chromium cannot decode HEIC, so `createImageBitmap` never
sees one. The working copy is pixel-identical in dimensions, so recipe
quads in original-image coordinates apply to both without translation.
The original bytes stay the bank; the working copy is derivable and
disposable.

**The renderer does the raster work.** Decode via `createImageBitmap`
(of the working copy),
projective rectification in WebGL, JPEG encode via `canvas.toBlob` at
quality ~0.9. All three are native-speed browser primitives; the editor
needs the identical transform for its live preview anyway, so the mint and
the preview are one shader, not two implementations. Zero new dependencies.

**Main assembles the PDF with `pdf-lib` — already a dependency** (six files
use it today: `src/commands.ts`, `src/pdf/meta.ts`, `src/vlm/pdf-text.ts`,
`app/electron/engine.ts`, `ipc.ts`, `job-queue.ts`). Page JPEGs cross IPC
one page at a time so no full-book buffer ever exists in one heap.

Alternatives considered and refused, for the record: PyMuPDF (the engine's
rasterizer) is Python-side and would drag an interpreter into a stage that
must work before any environment is installed; `sharp` is a native
dependency with vendoring consequences for BookForge; pure-JS resampling in
main is seconds per page against WebGL's milliseconds.

Consequence, recorded: **the mint needs the window alive.** Acceptable — it
is an interactive stage in an interactive app; the job row still shows in
the queue with progress. The mint is never routed to the host scheduler
(it is not model expense); the host still sees it via the Wave 16 shelf
mirror. P3 audits that seam.

## The IPC surface — the contract, pinned

Handles (all `capture:` prefixed; P3 regenerates `docs/IPC-CHANNELS.md`):

| Channel | Direction | Signature |
| --- | --- | --- |
| `capture:intake` | invoke | `{projectId, paths: string[]}` → `{recipe}` — copy, hash, EXIF-read, append photos, inherit prior photo's settings |
| `capture:recipe-load` | invoke | `{projectId}` → `{recipe}` |
| `capture:recipe-save` | invoke | `{projectId, recipe}` → `{ok}` — whole document; renderer debounces |
| `capture:mint-begin` | invoke | `{projectId}` → `{mintId, pages: [{pageId, photoFile, quad, outWidth, outHeight}]}` — **main computes the final list; the renderer renders exactly that list** |
| `capture:mint-page` | invoke | `{mintId, index, jpeg: ArrayBuffer}` → `{ok}` |
| `capture:mint-commit` | invoke | `{mintId}` → `{step}` — writes the PDF, appends the minted step |
| `capture:mint-abort` | invoke | `{mintId}` → `{ok}` |

Originals reach the renderer for display through the app's existing
image-serving door (the workbench already shows page images and figure
crops); P1 names that door here when it wires it, rather than minting a
second mechanism.

## Work packages

**P1 — intake and mint (electron side).** `app/electron/capture.ts` (new):
originals copy-in with hashing, the HEIC decode to working copies, EXIF
`DateTimeOriginal` (the `Exif` payload sits in the HEIC meta box and a
bounded scan finds it — measured on the real files; a proper box walk
is the implementer's call), recipe read/write, the
mint session (`mint-begin`/`page`/`commit`/`abort`), PDF assembly with
pdf-lib, the minted step appended to the ledger, job-queue row with
progress and cancel. Registers the `capture:` handles in `ipc.ts`.

**P2 — the light table (renderer).** New standalone components: the capture
grid (cards, drag-reorder, sort/reverse, drop zone, strike), the page
editor (rotate / split line / quad corners, apply-to-all), the WebGL
rectify used by both live preview and mint, and the mint driver that walks
`mint-begin`'s list. OnPush throughout; recipe edits debounce into
`recipe-save`. No engine knowledge beyond the schema above.

**P3 — wiring and gating.** The `stages.ts` predicate audit (result written
back into this doc), New Project entry point and action-menu entries, the
Wave 16 queue-seam audit for the mint job, host-ops shelf visibility,
`IPC-CHANNELS.md` regeneration, the PLAN.md entry, and the gates run.

P1 and P2 meet ONLY at the recipe schema and the IPC table. P3 touches the
seams both sides plug into. Any of the three finding the contract wrong
edits this document first and says so on the channel.

## Checkpoints before P1/P2 start

1. **SETTLED 2026-08-19, measured against the real shoot** (27 files,
   `E:/index images july`, the first acceptance case): **all 27 are HEIC**
   (`ftypheic`), ~1.5 MiB each, EXIF capture times present and sequential
   (`2026:08:18 17:55:01`, `:08` — seconds apart, the sort's exact case).
   So HEIC decode is v1 scope: **wasm libheif at intake** (pure wasm,
   vendoring-safe, no native build) — one new dependency, recorded here
   because dependencies are contract. The folder name carries spaces;
   let that stay a test, not a surprise.
2. **The image-serving door** for originals (P1 finds, names it here).
3. **The `stages.ts` audit list** (P3 walks every predicate, writes the
   verdict here).

## Deferred out loud

- **Automatic de-skew** — Owen: later, after this lands.
- **AI sharpen** — Owen: later, after this lands.
- CV auto-detection of gutters/edges — superseded by apply-to-all for v1.
- Carrying banked readings across a re-mint when page pixels are unchanged.
- Fine (non-quarter) rotation as a separate gesture — the quad already
  absorbs small tilt; a dedicated dial can come with de-skew.

## Gates

The five, as always, run by the lead before any commit: `bun test` (384),
root `bunx tsc --noEmit`, from `app/`: `tsc -p tsconfig.electron.json`,
`tsc -p tsconfig.app.json`, `ng build` — never `app/tsconfig.json` — plus
the raw-control-byte scan. Agents never commit; the lead verifies, commits,
and pushes.
