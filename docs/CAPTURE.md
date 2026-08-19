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

**The exact shape of that step is SETTLED (P1's narrow audit, seq 50,
measured by grep across three layers): action `import`, parented to the
capture step, retention `irreplaceable`.** Seven sites branch on a step's
action and all seven test for 'import' — with `import` every one is
correct for a minted PDF with zero edits; a new 'mint' action makes all
seven silently wrong-by-default, the Merge 1 defaulting-switch shape
times seven. The marker for minted costs no new field: `originStep`
(ledger.ts:431) is the ONLY construction site of an import step and
always writes `parent: null`, so **an import step WITH a parent is a
mint by construction**. Stronger than honest — FORCED: parseLedger
enforces one root (ledger.ts:664), and a capture ledger's root is the
capture step, so a null-parent mint would be a second root and the
ledger would be REFUSED. Retention stays `irreplaceable` because it is
true: a re-mint is a NEW document and readings do not follow it; the
only false thing was the discard sentence, which now branches on
`parent === null` — the question it always meant (did this come from
OUTSIDE?). Accepted wording for the minted branch: Discarding X
destroys the pages you minted and every reading hung off them. The
photographs and their recipe stay, so you can mint again — but a new
mint is a new document, and readings do not follow it. Merge 4 also
catches the docblock at ledger.ts:414 (the only step whose parent is
null — already stale since captureStep). The REST of the audit
(canRunHostActFrom against an unminted capture, Wave 15's Narrate
gating, Wave 16's queue seam) is UNRUN and stays in the Merge 5 pool;
nothing here vouches for it. **The COMPLEMENT audit is also run and
clean (P2, seq 52): twenty-one sites read `parent === null` as this-is-
the-import; the four structurally load-bearing ones (parseLedger root,
appendStep, deleteSubtree, originOf) all go the right way**, and
deleteSubtree supplies the strongest reason neither audit started with:
it REFUSES TO DELETE A ROOT, so `import` + `parent: null` would have
made minted pages UNDISCARDABLE and the discard sentence unreachable
text. One visible change, owned by P2 and ruled more-accurate-not-less:
a reading hung off a MINTED pdf shows the mint step's label on its
lineage line rather than the project title. One wording item recorded
so it is not re-found: parseLedger's refusal (a project begins with the
file that was imported) and appendStep's (every step after the import)
are both stale of a capture project — reachable only through a
programming error, not worth a merge, known.

**`ProjectSummary` gains `capture: boolean` (ruled from P2 seq 54; P1
lands it — shared/types.ts and projects.ts are its ground; additive,
ahead of or with Merge 4).** Main answers it from the LEDGER for free
(createCaptureProject writes the capture step), never by reading the
recipe. It is NOT inferred from an empty document list, for P2's reason,
recorded because it looks like an oversight and is the opposite: an
empty document list is exactly what a project whose files have all gone
missing looks like — that is what the nothing-to-open tag EXISTS for,
and inferring capture from emptiness would turn a genuinely broken
project into a light table and hide the one message that says the
files are gone. A row's page-count tag (reading the recipe) is deferred;
the boolean is enough to open the light table and tell the truth.
Landed with Merge 4 (f4f1fca), which also fixed TWO defects already on
main, both found by the FIRST end-to-end run rather than by reading:

- **The union and the runtime list were two spellings of one set.**
  `STEP_ACTIONS` (runtime array, ledger.ts) never gained `capture` when
  the `StepAction` union (types.ts) did, and parseLedger validates
  against THE ARRAY — so every capture project the app created was
  REFUSED by the app that wrote it, thirty seconds later. Fix is the
  cause, not the symptom: `StepAction` is now DERIVED
  (`typeof STEP_ACTIONS[number]`), so adding an action is one edit and
  the compiler resumes naming every consequence. Note P1's Merge 2
  scope sentence (manifest write typechecked, not run) turned out to be
  covering an actual break, not a theoretical gap — honest scope
  statements are where the next bug lives.
- **A step is the retained payload of an action; minting one whose
  payload does not exist is writing a promise the project cannot
  keep.** createCaptureProject appended the capture step but only the
  IPC handler knew to also write the recipe — creation alone made a
  project that refused to open. Creation now writes the recipe ITSELF,
  before the step; `emptyRecipe`/`recipeBytes` live in shared/capture.ts
  so both writers import one implementation (the dependency arrow only
  goes one way: capture.ts already depends on projects.ts).

**Ruled from P2 seq 57 (P1 lands, small follow-up): a missing DECODER
throws OUT of intakePhotos — one loud failure naming the installation
— rather than becoming N per-file refusals.** The per-file try/catch is
exactly right for a file that will not decode (a truncated HEIC among
27 good ones is what CaptureIntaken exists to report) and exactly wrong
for an absent decoder, which refuses EVERY file and tells the person 27
times that their photographs are unreadable, in a sentence carrying a
require stack. The distinction is the pdf-lib one: a refusal is about
the FILE; this is about the INSTALLATION. Same packaged-build shape,
worse failure mode: not a crash, a book that silently refuses every
photograph. LANDED at 7e72d1b, measured by REMOVING the module: throws
once before the first mkdir (an intake that cannot work leaves nothing
behind — not even copied originals), the sentence names the decoder
and says nothing is wrong with the photographs, no require stack
reaches the person. The gate ledger's summary line is P1's: THE
GATES PROVE THE CODE COMPILES, AND ONLY RUNNING IT PROVES IT RUNS.
Sixth (P2, seq 63), past the boundary of running: four green gates,
twelve injected defects caught, eight acceptance checks passing — and
the central gesture of the feature DID NOTHING, because every one of
those measures the PIPELINE and a gesture needs HANDS. The image was
the only thing that could have told anybody: LOOK AT THE PAGES.

Until ProjectSummary.capture is used by P2, Home draws a fresh capture
project disabled and mislabelled — known, temporary, blocks a row and
not the feature.
Related fact, checked by P2 and recorded so nobody re-raises it:
`hasBookAt` is correctly FALSE on an unminted capture project — line
120 refuses on !reading.done && !arrived before the action test can
answer true. And the renderer names the seven this-tab-is-a-project
sites ONCE (`pathIsProject`, a type predicate — the compile promptly
proved one old `=== 'book'` test was doing invisible load-bearing
narrowing); a fourth directory-shaped kind joins by being added there. Wave 15's Narrate gating and Wave 16's queue seam are the two
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
- **A capture project is keyed at creation as `slugify(title)-<8
  random hex>`** — it must exist empty, before any content exists to
  hash, so `contentKey` for captures is a creation id rather than a
  content hash, and its doc comment says so. The key never changes on
  re-mint: the project is its identity, not its current PDF. Creation
  happens only through `capture:create` (the eighth door), and the
  ledger grows a `captureStep` SIBLING of `originStep` rather than a
  parameter on it — a function named originStep that sometimes makes
  a capture step would be the two-things-one-name defect again.
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

**The grid is what a CAPTURE STEP shows — whether or not a PDF has been
minted.** (Reworded from "a capture project with no minted PDF" after the
read-back traced the ledger: a capture row names no document and no proof
sheet by design, so the first phrasing would have left a post-mint capture
row showing NOTHING, with no door back to the corners — contradicting this
doc's own promise that the recipe stays re-editable after a read. Standing
on the capture step always shows the light table; standing on the minted
step shows the PDF.) For a project not yet minted, that makes the grid the
main viewer:
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
      "workingCopy": "9f2c….png",
      "thumb": "9f2c….640.jpg",
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
}
```

Conventions, pinned:

- `id` is the sha of the original bytes. `pages[].id` is `<photoId>:<n>`.
- `workingCopy` and `thumb` are DOOR NAMES, written by intake (seq 37:
  the grid needs 27 thumbnail URLs before any mint exists, and the one
  file the recipe named was the HEIC original — exactly the file an
  `img` must never point at). Nothing derives layout by convention;
  `CaptureMintPage.workingCopy` repeats a fact the recipe carries
  rather than being its only home, and the on-disk layout is intake's
  business alone.
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
  own quads. **A new photo inherits from `photos[photos.length - 1]`,
  the last photo in ARRAY order (intake order), not the last in
  `order` (the arrangement)** — ruled from P1 seq 45: at intake time
  "the previous photograph" means the one that most recently arrived,
  and the two differ the moment anyone drags a card.
  On the acceptance shoot exactly one card skips, which is
  correct: a landscape frame in a portrait shoot is a different
  photograph, not one the same crop happens to fit. Two more skips,
  same family (P2, seq 43), both REFUSALS rather than guesses,
  enforced in the service because only it can see the other photos:
  a SPLIT copies only onto UNSPLIT photos, and a CROP copies only
  between photos with the SAME PAGE COUNT -- two quads onto an
  unsplit photo would have to invent a split to hold the second, and
  one quad onto a split photo would leave its right-hand page
  half-updated; neither is what was asked for. Every skip, all three
  kinds, NAMES the photographs it skipped in the notice bar.
- **Quad corner order is [top-left, top-right, bottom-right, bottom-left]
  OF THE OUTPUT PAGE.** The corner assignment IS the orientation: the
  rotate gesture permutes the assignment, and no separate rotation field
  exists to disagree with it. One value, one meaning — the two-things-
  sharing-a-name lesson applied in advance.
- `split` is kept for the editor's line handle (re-dragging re-derives the
  two quads); the quads are authoritative for the mint.
- `order` lists every page id, struck included; the mint filters strikes.
- **`order` is the ONLY stored truth about arrangement -- `descending`
  is GONE from the recipe** (ruled from P2 seq 43, following its own
  reasoning to the end: the service derives the toggle state by
  comparing the current order against the takenAt sort in either
  direction, so a stored flag would be a boolean that can disagree
  with the array next to it -- the sixth appearance of the
  two-things-one-name shape, refused in advance like the fifth.
  Accepted imprecision, by design: drag a card away and back and the
  toggle returns. Create and intake write NO `descending` field; the
  empty recipe is `{version, photos: [], order: []}`.
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
- **The aspect-agreement predicate has ONE implementation too** (ruled
  from P2 seq 46 -- the same drift outputSizeFor already survived,
  caught this time while the two copies still agree): main side
  |a-b|/source <= 0.02 and renderer sameShape |a-b| <= 0.02*source are
  algebraically identical TODAY, so the function moves to
  app/shared/capture.ts beside outputSizeFor, keeps the height-zero
  guard, and both sides import it. P1 lands the shared move (its file,
  its main-side caller); P2 switches its import on rebase and deletes
  sameShape.
- **Editor corners CLAMP to [0,1] at the drag site** (P2 seq 46, its
  own find against its own docblock): there is nothing outside the
  frame, so a crop hanging off the edge is not a crop of anything, and
  preventing it beats narrating it. Unclamped, one drag past the frame
  edge made every subsequent debounced save fail validation -- a live
  surface over a file that stopped listening, the worst shape
  available. withinSource stays as the shader honest report and
  becomes should-never-happen. The validator stays strict; the fix is
  P2 side.

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
(`capture/derived/<sha>.640.jpg`, 640 px long edge, JPEG ~0.85 — display
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

**Main assembles the PDF with `pdf-lib` — which is NOT yet a dependency
of the app, and the lead's earlier claim that it was rested on a grep
that counted comment MENTIONS as imports** (corrected by P1 at seq 40:
the only real imports are `src/pdf/meta.ts` and `src/vlm/pdf-text.ts`,
both in the ROOT package — the bun-compiled engine, a different program
with a different package.json). The trap is worse than the correction:
Node resolution from `app/electron` walks up and finds the root copy,
so the import works in dev and through every gate, and the first thing
to break would be the PACKAGED build — electron-builder ships the
app's own production dependencies, not the root's — in the mint, on a
user's machine. **Merge 4 LANDED pdf-lib in `app/package.json` at an exact 1.17.1
(f4f1fca) — trap closed.** Version pins here are EXACT, never caret: npm wrote
`^1.19.8` for libheif-js where this doc pins 1.19.8, and a caret bump
arriving on a routine install would silently change whether the
decoder still applies `irot` — the one measurement the upright rule
rests on. Fixed to exact in package.json and the lockfile.

Page JPEGs cross IPC one page at a time so no full-book buffer ever
exists in one heap.

Alternatives considered and refused, for the record: PyMuPDF (the engine's
rasterizer) is Python-side and would drag an interpreter into a stage that
must work before any environment is installed; `sharp` is a native
dependency with vendoring consequences for BookForge; pure-JS resampling in
main is seconds per page against WebGL's milliseconds.

Consequence, recorded: **the mint needs the window alive.** Acceptable — it
is an interactive stage in an interactive app; the job row still shows in
the queue with progress. **Mechanism, as built (seq 56): the shelf row is
born `running`, never `queued` — pump selects only `queued`, so it
never sees the row; no exclusion list, no second gate, and a mint and a
read genuinely run at once.** env-install is the precedent for a row
nobody enqueued, different in exactly one recorded way: an install DOES
take the slot because it competes for the same disk and network; a mint
competes with nothing. The mint is never routed to the host scheduler
(it is not model expense). **The shelf sentence, NARROWED to what the
audit measured (P1, seq 65, correcting this doc's earlier claim): a mint
row is drawn on FOUNDRY'S shelf, hosted or not, and its cancel works
locally. The mirror is ONE-WAY — FoundryHostQueue has no outbound row
channel, so nothing can tell a host about a row it did not schedule.**
Whether a person hosted inside BookForge looks at Foundry's shelf or
BookForge's own is not answerable from this repo; it goes to the
BookForge channel with the vendoring notice, and if the answer is
BookForge's shelf, that is a new outbound channel — real work, not
wording. The audit itself (five positions, nine predicates, minted vs
imported control): ZERO differences between the minted and imported
PDF on all nine — the sentence the feature rests on, measured. Two
defects found and fixed at e296188: hasBookAt/hostActPositionFrom said
'import' where they meant ARRIVAL (standing on the photographs of a
read project offered Translate/Simplify/Export; both now read
BOUNDS_THE_WALK — one fact, one table, not a second pair of trues to
drift); and three queue-seam sites asked kind === 'env-install' where
they meant DID THIS ROW EVER ROUTE — hosted, a mint drew NO ROW and
its cancel forwarded our id to a host that never heard of it; now a
Readonly<Record<JobKind, boolean>> (NEVER_ROUTED), the STEP_ACTIONS
lesson applied in a second file. Unwalked and said so: Narrate gating
(narrate is not a stages.ts export), and no hosted run was performed.

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
| `capture:create` | invoke | `{title}` → `{projectDir, recipe, token}` — the EIGHTH door (seq 36): births the project through the same serialized path `importDocument` uses, keys it `slugify(title)-<8 random hex>` per the creation-id ruling, writes the empty recipe, mints the door token, and **appends the capture step AT CREATE** — forced by the light-table-belongs-to-the-step ruling, because a project between New Project and the first drop must already have the surface that receives the drop. An abandoned empty capture is an honest record, same shape as an adopted project with an empty ledger. Title is what the person typed; empty becomes `Photographs`; the stem is ONE-SHOT (the catalogue never renames files under anybody). Answers with ImportedDocument-shaped data whose `entry` is `capture/recipe.json` — there is no document yet, so do NOT read that entry as a file to open |
| `capture:intake` | invoke | `{projectDir, paths: string[]}` → `{recipe, token}` — copy, hash, EXIF-read, decode + working copy + thumb, append photos, inherit prior photo's settings; token because intake is the other moment a project first has pixels to show. **Answer is `CaptureIntaken`: `{recipe, token, added, duplicates: string[], refused: [{file, why}]}`** (P1 departure, seq 45, accepted: without it a drop holding a JPEG and three photos the project already has is indistinguishable from a clean import of nothing). The refusal wording is USER-VISIBLE by design ('.txt is not a photograph this stage reads yet -- HEIC only for now') -- a named refusal is a sentence a person can act on. **v1 intake is HEIC ONLY**: a JPEG would decode through Electron on a path where EXIF Orientation is applied by somebody else's rules, the exact hazard that nearly turned this shoot 90 degrees wrong; JPEG/PNG intake is deferred below, orientation measured first |
| `capture:recipe-load` | invoke | `{projectDir}` → `{recipe, token}` — the token mints the door's allow-list entry for this project (the `book:load` pattern) |
| `capture:recipe-save` | invoke | `{projectDir, recipe}` → `void` — whole document; renderer debounces. The validator ALSO cross-checks internal consistency (ruled from P2 seq 46, P1 lands it): order and the pages describe the SAME SET -- every page id exactly once, no orphans, no repeats; split non-null means pages.length === 2; pages.length is 1 or 2. The CONVERSE is unchecked ON PURPOSE (P1, seq 48): two quads with no split line is somebody who cropped both halves by hand, and a validator that refuses states the surface can legitimately reach is the editor-clamp failure one flight down. An inconsistent recipe accepted at the door loses a leaf invisibly (the grid cannot draw a page the order omits) or mints one twice |
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

**The served layout — ruled by P1 from the door's own ground (seq 40),
option (a) with the directory renamed:**

    capture/originals/<sha>.<ext>   the bank. HEIC. NEVER served, never written
    capture/derived/<sha>.png       the upright working copy
    capture/derived/<sha>.640.jpg   the 640 px thumbnail
    capture/recipe.json             the recipe

`derived/` and never `working/`: `projects.ts:232` already defines
`working/` as a project's live-PDF directory, so `capture/working/`
would put one word with two meanings inside one project tree — the
fifth appearance of the two-things-one-name shape tonight, and the
first we got to refuse in advance. `derived/` is the honest name: everything in it is reconstructible
from originals + recipe, so the deletion rule is self-evident —
`derived/` can be wiped and rebuilt, `originals/` never can.
`workingCopy` and `thumb` are door names, not paths: plain basenames
served by `foundry-file://capture/<token>/<name>` out of
`capture/derived/`, the ONLY directory the capture token reaches,
with the book host's name rule kept character for character (no `/`,
no backslash, no `..`). The property that decided it: with one
directory and flat names **the originals are unaddressable through
the scheme by construction rather than by refusal** — no string a
renderer can compose reaches out of `derived/`. The bank is
somebody's only copy of an afternoon in an archive; it is guarded by
arithmetic, not by a check that has to stay right forever.

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
5. **The acceptance harness EXISTS and is itself tested (P2, seq 52)**:
   nine checks (C0—C8) over recipe, derived files and PDF — from
   outputSizeFor sha-pinned drift detection through order/pages cross-
   agreement to C8, which diffs each minted page against its own source
   AND two decoy neighbours and passes only on a clear-margin win
   (measured: correct pages win at 0.11—0.20, a swapped pair loses at
   5.5, line at 0.6). A fixture generator injects twelve specific
   defects; the self-test proves each is caught BY THE CHECK THAT
   CLAIMS IT, and that a correct project passes clean. Scratch tooling,
   not a committed test (the no-unasked-tests rule); it takes a project
   directory and a PDF and nothing else, so it runs unchanged against
   the real 27 the day the mint lands. Limits stated: drawn axis-
   aligned fixtures, no HEIC through it, PDF assembled by a stand-in
   — where the stand-in and the mint disagree, the mint is right.
6. **THE WHOLE LOOP IS MEASURED (P2, seq 63): 27 real photographs
   through create/intake/edit/mint with the SHIPPED rectify shader,
   all eight checks green.** Page identity proven, not fingerprinted:
   own-source diff 0.75—1.07 of 255 (JPEG quantisation and nothing
   else), nearest decoy 24—78, ratios 0.01—0.04 against the 0.6 line.
   Every embedded image exactly outputSizeFor's size; every page its
   image x 0.24 = 72/300, the 300 dpi read back from the other side.
   The seq 19 colour/chroma/alpha residue is ANSWERED. Disk, so
   reconstructible is worth acting on: 44 MB of originals became
   336 MB of derived/ and a 67 MB PDF. THEN THE PAGES WERE LOOKED AT
   — the first eyes on a minted page all night — and: the shoot is
   SIDEWAYS SPREADS (the real book is a quarter turn + a split on all
   27 = 54 pages; the un-edited 27-page state is not a defect, it is
   what the gestures are FOR, and apply-to-all is the difference
   between ~4 gestures and 54); IMG_0238 is a framed set of
   handwritten letters, not a page — the aspect-skip sentence (a
   different photograph, not one the same crop happens to fit) was
   LITERALLY true, and a strike is that card's honest state; and three
   split-gesture defects (fixed f3b9aba: the split never built its
   second page on the photo it was performed on; the handle drawn on
   quads[0] jumped on every drag; the drag read the photograph's X
   while the line lay along the quad — invisible while everything is
   upright, wrong the moment a spread is turned).

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
- ~~A PNG-encode dependency~~ SETTLED at Merge 2: the encoder is
  hand-written (zlib + IHDR/IDAT/IEND, ~40 lines) and came out clean
  — real signature, correct dimensions, colour type 2, verified on
  all 27. The reason stands in capture.ts’s docblock:
  `nativeImage.createFromBitmap`’s buffer is BGRA or RGBA by platform
  and premultiplied on some, an ambiguity nobody should resolve by
  trying it on the one file every page of the finished book is
  sampled from. Electron IS used for the thumbnail, handed the
  encoded PNG so there is no channel order to get wrong.
- An intake progress channel: **27 photographs take 55.2 s (2.0 s
  each, measured on this machine at Merge 2)** and `capture:intake`
  is a plain invoke, so the renderer holds a spinner for a minute
  with nothing to show. Deferred rather than invented mid-merge;
  when it comes, decide whether the mint’s job-row shape belongs to
  intake too, so progress has ONE shape in this feature, not two.
- JPEG/PNG intake: v1 refuses them by name. Before adding, MEASURE
  who applies EXIF Orientation on Electron’s decode path, the same
  question libheif already answered for HEIC (a wrong answer turns
  a shoot sideways silently).
- An exhaustiveness helper on defaulting switch arms over StepAction
  (read-back section 4): the two Translated-stamp defects compiled green
  because default: hides a widened union; a never-check would make the
  compiler name them. Out of scope tonight, worth its own small pass.
- Whether Mint is ALSO an act orderable from the action rail: the mint
  button lives on the light table's own footer (you press it looking at
  the pages it will make); the rail question is about the rail's
  grammar, not about capture (P2, seq 54).
- Fine (non-quarter) rotation as a separate gesture — the quad already
  absorbs small tilt; a dedicated dial can come with de-skew.

## Gates

The five, as always, run by the lead before any commit: `bun test` (384),
root `bunx tsc --noEmit`, from `app/`: `tsc -p tsconfig.electron.json`,
`tsc -p tsconfig.app.json`, `ng build` — never `app/tsconfig.json` — plus
the raw-control-byte scan, WHOSE FILE LIST COMES FROM git show --name-only HEAD, never git status --porcelain (P1, seq 45: a clean tree makes the status list empty, so the scan reads nothing and prints CLEAN -- a gate that cannot fail, found because P1 watched it pass suspiciously fast). Third of the
night, same shape (P1, seq 48): an acceptance that runs against BUILD
OUTPUT must rebuild inside the same command as the run -- P1 edited
the validator, ran the acceptance against a stale app/dist, and
watched four just-written checks fail against the previous file;
had the stale build happened to agree, a green run would have vouched
for code that never executed. Fourth (P1, seq 56), the sharpest: a green typecheck over a set the
type system was not the authority on — the StepAction union and the
STEP_ACTIONS runtime array were hand-maintained twins, the union
widened and the array did not, and no compile can see a runtime list
disagree with a type. The fix (derive the type from the list) is the
only gate that works there. Fifth (P2, seq 57), the boundary itself:
EVERY gate we run is a compile, and a compile cannot see an absent
runtime dependency — three green gates on a worktree whose decoder
was missing. Rule: after rebasing onto a merge that touches
package.json, INSTALL BEFORE BELIEVING A GATE. Two more gate hazards,
both measured: npx tsc exits 0 without compiling at THREE sites on
this machine now, so the leaf configs run ./node_modules/.bin/tsc by
path; and bunx at root, never npx. Agents never commit; the lead verifies, commits,
and pushes. **`bunx`, never `npx`**: at this repo's root, `npx tsc`
fetches a joke package that prints "This is not the tsc command you are
looking for" and EXITS 0 — the vacuous gate in its purest form,
measured the hard way during Merge 1.
