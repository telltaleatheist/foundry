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
nothing downstream is offered — no read, no narrate, no export. P1
measured the structural half already: `reading.needed` keys off
`manifest.archive?.kind === 'pdf'`, so an archiveless capture project
offers nothing downstream with no new gating written — and the audit
still walks every predicate rather than resting on that one line.

Three rulings recorded from P1's plan-back (items 3, 5, 6):

- **The mint sets the manifest archive as well as appending the step.**
  A step alone leaves `reading.needed` false forever and the minted
  book unreadable. Both writes at the same commit point.
- **A capture project is keyed at creation from a random 8-hex id** —
  it must exist empty, before any content exists to hash, so
  `contentKey` for captures is a creation id rather than a content
  hash, and its doc comment says so. The key never changes on re-mint:
  the project is its identity, not its current PDF.
- **`takenAt` stays a UTC instant.** Intake applies
  `OffsetTimeOriginal` when present (all 27 shoot files carry it);
  wall time with no offset is interpreted in the machine's zone and
  the photo record says so; no EXIF time at all falls back to file
  mtime, recorded, never silent.

**The mint job row** is a new `JobKind` member whose row shows in the
shelf with progress and cancel but NEVER occupies the queue's serial
engine slot — an interactive renderer-driven mint must not block a
read behind it for minutes. `enqueueEnvInstall` is the precedent; the
mechanism is P1's to pick after reading `executeJob`'s dispatch, and
the verdict lands in the Wave 16 seam audit.

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
      "width": 3024,
      "height": 4032,
      "takenAt": "2026-08-17T14:03:22Z",
      "takenAtSource": "exif-offset",
      "split": { "x": 0.51 },
      "pages": [
        { "id": "9f2c…:0", "quad": [[0.034,0.029],[0.487,0.040],[0.483,0.958],[0.028,0.947]], "struck": false },
        { "id": "9f2c…:1", "quad": [[0.499,0.039],[0.965,0.032],[0.969,0.956],[0.501,0.960]], "struck": false }
      ]
    }
  ],
  "order": ["9f2c…:0", "9f2c…:1"],
  "descending": false
}
```

Conventions, pinned:

- `id` is the sha of the original bytes. `pages[].id` is `<photoId>:<n>`.
- `width`/`height` are the DECODED working-copy dimensions, stored so
  the 2% aspect rule is answerable without decoding anything — and
  because EXIF's dimensions are the other grid and must never be the
  ones stored. `takenAtSource` (`exif-offset` | `exif-local` | `mtime`)
  is the item-3 provenance record. `split` is `{x} | null` — null for
  an unsplit photo; the sample shows the split case.
- **Every coordinate in the recipe is a NORMALIZED FRACTION (0..1) of
  the WORKING COPY's grid** — quads and `split.x` (fraction of width)
  alike. One unit for the whole file. Ruled 2026-08-19 after P1
  measured the shoot (26 photos 4032x3024, IMG_0238 5712x4284): an
  absolute-pixel quad copied onto the odd one out lands outside the
  image and fails as black edges. Corner handles clamp to [0,1]; the
  mint multiplies by the working copy's dimensions at rasterize time.
- **Normalizing does NOT make copying safe, and the rule that does is
  pinned here** (P2's interaction finding): after orientation baking,
  26 shoot photos are PORTRAIT and IMG_0238 stays LANDSCAPE, and a
  normalized quad copied across that boundary is a silent STRETCH —
  in-bounds, plausible, wrong, and invisible all the way into the PDF.
  So **apply-to-all and late-drop inheritance SKIP any photo whose
  baked aspect ratio differs from the source's by more than 2%**, and
  the surface names what it skipped and why. A skipped photo keeps its
  own quads. On the acceptance shoot exactly one card skips, which is
  correct: a landscape frame in a portrait shoot is a different
  photograph, not one the same crop happens to fit.
- **Quad corner order is [top-left, top-right, bottom-right, bottom-left]
  OF THE OUTPUT PAGE.** The corner assignment IS the orientation: the
  rotate gesture permutes the assignment, and no separate rotation field
  exists to disagree with it. One value, one meaning — the two-things-
  sharing-a-name lesson applied in advance.
- `split` is kept for the editor's line handle (re-dragging re-derives the
  two quads); the quads are authoritative for the mint.
- `order` lists every page id, struck included; the mint filters strikes.
- **Output page size has ONE implementation**: `outputSizeFor(quadPx)`
  in `app/shared/` (P1 ground, added in Merge 1; the editor's preview
  and main's `mint-begin` both import it). The formula is pinned here
  because the two-bodies version already existed for a morning:
  `width = max(hypot(TL,TR), hypot(BL,BR))`,
  `height = max(hypot(TL,BL), hypot(TR,BR))`, Euclidean on WORKING-COPY
  PIXELS, then `Math.round`, then clamped to a minimum of 1. Rounding is
  part of the contract: round-vs-floor is a one-pixel disagreement per
  page that no typecheck catches. MediaBox at a nominal 300 dpi; the
  read renders at 200 dpi under a 2 MP budget downstream, so nominal is
  fine.

## Where the work runs — and why

**Intake (main) decodes HEIC once, into a PNG working copy beside the
original** — Chromium cannot decode HEIC, so `createImageBitmap` never
sees one. **PNG, not JPEG — ruled by Owen 2026-08-19**: the shoot is
small, poor-quality print, HEIC is already one lossy generation, and a
JPEG working copy would bake in a second before any page reached the
mint. PNG is lossless; the only cost is disk on a file that is
derivable and disposable.

**The working copy is UPRIGHT — and upright is the DECODER'S DEFAULT,
not work** (measured, channel seq 19): libheif applies the container's
`irot` during decode, so the buffer comes back already upright and
intake writes it to PNG unchanged. **Applying EXIF Orientation on top
is a DOUBLE ROTATION** — it would have turned 26 of 27 shoot photos 90°
wrong, uniformly enough to look deliberate. The dependency and version
are pinned because this is libheif behaviour, not format truth:
**`libheif-js@1.19.8`**, accepted as P1's dependency; any future bump
re-runs the two-line dimension probe. **Dimensions come from the
DECODER, never from EXIF**: EXIF says 4032x3024 for a file the decoder
returns as 3024x4032 — both correct about different grids, the
two-things-sharing-a-name shape in a new hat. Recipe coordinates,
quads, and the grid are all the DECODED grid — the one the editor
draws on and the mint samples from, with no orientation field anywhere
to disagree. (Had baking been needed, not baking would have meant
spelling one rotation four ways in P2 — shader, corner hit-testing,
split line, drag maths.) The original bytes stay the bank, untouched.

**Intake also emits a display thumbnail beside each working copy**
(`capture/thumbs/<sha>.jpg`, 640 px long edge, JPEG ~0.85 — display
only, never in any quality chain). Ruled after both packages converged
on it: intake already holds the decoded RGBA, so a thumbnail costs one
downscale and one encode, and it spares the grid pulling ~540 MiB of
full-res PNG through the door and decoding it on EVERY project open.
The grid reads thumbs; the editor reads the full PNG for the ONE open
photo; the mint reads full PNGs one page at a time.

**Resolution is never
reduced anywhere in this chain** — the mint output size is the quad
edge maxima, and only the read stage downsamples, per read, under its
own pixel budget, baked into nothing.

**The renderer does the raster work.** Decode via `createImageBitmap`
(of the working copy),
projective rectification in WebGL, JPEG encode via `canvas.toBlob` at
quality 0.92 for the PDF pages — JPEG at the PDF because a lossless
PDF of a full shoot runs to gigabytes; 0.92 at full resolution is the
one lossy step after the camera, and it is taken at the LAST moment,
from a lossless source. A lossless-PDF option is in the deferral list
if the archive ever wants it. All three are native-speed browser
primitives; the editor
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

Handles (all `capture:` prefixed; P3 regenerates `docs/IPC-CHANNELS.md`).
Two spellings were corrected from Merge 1 rather than ruled in advance,
both accepted: **`projectDir`, not `projectId`** — this codebase
addresses a project by its directory and has no id concept, and a
second name for an existing thing is the defect shape this feature
keeps finding; and **`void`, not `{ok}`** — an `{ok: true}` that can
never be false is a field with no reader, and a rejected promise
already carries the failure:

| Channel | Direction | Signature |
| --- | --- | --- |
| `capture:intake` | invoke | `{projectDir, paths: string[]}` → `{recipe, token}` — copy, hash, EXIF-read, decode + working copy + thumb, append photos, inherit prior photo's settings; token because intake is the other moment a project first has pixels to show |
| `capture:recipe-load` | invoke | `{projectDir}` → `{recipe, token}` — the token mints the door's allow-list entry for this project (the `book:load` pattern) |
| `capture:recipe-save` | invoke | `{projectDir, recipe}` → `void` — whole document; renderer debounces |
| `capture:mint-begin` | invoke | `{projectDir}` → `{mintId, pages: [{pageId, workingCopy, quadPx, sourceWidth, sourceHeight, outWidth, outHeight}]}` — **main computes the final list; the renderer renders exactly that list.** `quadPx` is WORKING-COPY PIXELS, denormalized ONCE by main (the recipe stays fractions; the unit is in the name so no reader has to remember which side of the bridge they are on). `workingCopy` is the door NAME for `foundry-file://capture/<token>/<name>`, never a filesystem path. `sourceWidth`/`sourceHeight` let the renderer assert its decoded bitmap matches what main measured rather than trusting it |
| `capture:mint-page` | invoke | `{mintId, index, jpeg: ArrayBuffer}` → `void` |
| `capture:mint-commit` | invoke | `{mintId}` → `{step}` — writes the PDF, appends the minted step |
| `capture:mint-abort` | invoke | `{mintId}` → `void` |

**The door, answered (checkpoint 2 — both packages located it
independently):** the `foundry-file:` scheme in `app/electron/mount.ts`
(registered ~:210, handled ~:268) serves one host today, `book`, behind
a token allow-list; everything else 404s by design. P1 adds a SECOND
host — `foundry-file://capture/<token>/<name>` — allow-listed the same
way, token minted by a successful `capture:recipe-load`. **Pixels reach
the renderer ONLY through that door** (P2's D3, road a): an `img`
element on the scheme, then `createImageBitmap(img)` — allowed by the
existing CSP (`img-src … foundry-file:`) with no CSP edit, while
`fetch()` on the scheme stays refused by `connect-src`. Working copies
and thumbnails NEVER move as IPC bytes for display; only mint page
JPEGs cross the bridge, one at a time, renderer to main.

## Work packages

**P1 — intake and mint (electron side).** `app/electron/capture.ts` (new):
originals copy-in with hashing, the HEIC decode to working copies, EXIF
`DateTimeOriginal` (the `Exif` payload sits in the HEIC meta box and a
bounded scan finds it — measured on the real files; a proper box walk
is the implementer's call), recipe read/write, the
mint session (`mint-begin`/`page`/`commit`/`abort`), PDF assembly with
pdf-lib, the minted step appended to the ledger, job-queue row with
progress and cancel. Registers the `capture:` handles in `ipc.ts`, the
seven methods on `FoundryApi` in `app/shared/api.ts`, and the
`preload.ts` wiring — **api.ts and preload.ts are P1 ground** (P2
consumes, never edits).

**P1's Merge 1 is CONTRACT-ONLY** (P2's D1, adopted by P1): types.ts
recipe shapes + the `mint` JobKind member + the capture step shape,
api.ts declarations, preload wiring, ipc.ts handlers registered and
throwing not-implemented. The lead merges it to main early so P2
builds against real types while P1 fills the bodies. Doc custody
stays with the lead: P1 sends exact wording here for rulings rather
than editing this file.

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
2. **The image-serving door — ANSWERED**, see "The door, answered" in
   the IPC section: second `foundry-file:` host, token allow-list, no
   CSP edit.
3. **The `stages.ts` audit list** (P1 walks every predicate, writes the
   verdict here via the lead).
4. **The HEIC double-rotation measurement — SETTLED at channel seq 19,
   before any rotation code existed** (P2 named the hazard and both
   branches; P1 ran the decode): IMG_0211 (EXIF Orientation 6, stored
   4032x3024) decodes to 3024x4032 under libheif-js 1.19.8, and the
   container `irot` agrees with the EXIF tag in both probed files. So
   the buffer is ALREADY upright: intake applies nothing, and the rule
   lives in the working-copy section above. Scope honestly stated:
   two files probed, dimensions only — colour, chroma and alpha are
   Merge 3 acceptance concerns.

## Deferred out loud

- **Automatic de-skew** — Owen: later, after this lands.
- **AI sharpen** — Owen: later, after this lands.
- CV auto-detection of gutters/edges — superseded by apply-to-all for v1.
- Carrying banked readings across a re-mint when page pixels are unchanged.
- A lossless-PDF mint option (PNG/FLATE pages) for archival use — the
  working copies already preserve everything it would need.
- **The engine reading rectified images directly** (an image-manifest
  document kind; PDF demoted to just another export). Considered with
  Owen 2026-08-19; deferred: the read's per-run pixel budget makes the
  VLM's input pixels effectively identical either way, and the recipe
  + PNG working copies preserve everything a later pivot would need.
  The lever that actually helps small print is the READ budget, which
  is per-run and adjustable today.
- A PNG-encode dependency: P1 writes the encoder in-house (zlib +
  IHDR/IDAT — the buffer format is fully under our control) and asks
  for `pngjs` BY NAME if that does not come out clean, rather than
  quietly hand-rolling something fragile.
- Fine (non-quarter) rotation as a separate gesture — the quad already
  absorbs small tilt; a dedicated dial can come with de-skew.

## Gates

The five, as always, run by the lead before any commit: `bun test` (384),
root `bunx tsc --noEmit`, from `app/`: `tsc -p tsconfig.electron.json`,
`tsc -p tsconfig.app.json`, `ng build` — never `app/tsconfig.json` — plus
the raw-control-byte scan. Agents never commit; the lead verifies, commits,
and pushes. **`bunx`, never `npx`**: at this repo's root, `npx tsc`
fetches a joke package that prints "This is not the tsc command you are
looking for" and EXITS 0 — the vacuous gate in its purest form,
measured the hard way during Merge 1.
