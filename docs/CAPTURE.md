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

**Hosted, capture has no door (Owen via bookforge-sync seq 105: "The
foundry page where the user would add a new book should not be
available on Bookforge — Bookforge is the project manager, foundry is
the workhorse").** The dock pins Home as permanent chrome, so a hosted
bare window is always one click from the hero — and "Photograph a
book..." sits OUTSIDE the hero's hosted() guard today. Ruled: the
button moves behind `!hosted()`, one line, P2. BookForge's own half
(passing the book's file as opts.document so the bare window lands on
the import rather than on Home) is theirs and is answered on their
channel; the two together make Owen's principle true.

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

**Drops are window-scoped when a light table is in front** (Owen live
defect, seqs 72/76, fixed 75c7bea): the grid's drop zone is a STRIP
down one side — kept as the obvious place to aim, not the only one —
and the window handler routes a drop ANYWHERE to intake when the front
tab is a capture project, in ONE batched call (intake answers once; a
call per file would write the recipe per photograph and overwrite the
notice bar 26 times). Writing the fix exposed the tenth
two-things-one-name: the handler routed on the FRONT TAB while
intake() read the root-provided SERVICE's directory — two facts about
which project is being worked on that can name different ones, plus a
silent null during recipe load. intake now TAKES the project
directory; one fact. New Project is a MODAL (CaptureNewDialogComponent
matching confirm-dialog, registered in UiService's dialog list; Enter
submits, Escape/scrim cancel, nothing cancels while create is in
flight because it makes a folder) — Owen's ruling, and the house
convention: five dialogs existed and the inline field was the
deviation.

**The editor walks the book (Owen, live, 2026-08-19): prev/next page
buttons inside the page editor with a position readout ("page 7 of
54"), so refining fifty-four crops is one sitting, not fifty-four
round-trips through the grid.** And the crop workflow is named in his
terms — GLOBAL then PER-PAGE: "set the global position of the rect,
then change the shape on the page level; global + page 1 + page 2 +
page 3". Ruled as SURFACE, not schema: "global" is the existing
apply-to-all machinery given its honest name (a Set for all pages act
in the editor, aspect-skip rules unchanged), and a page-level drag
after it is the per-page override it always was. The recipe keeps ONE
kind of quad; no stored global layer, no merge semantics, no
re-flowing when global changes later — that heavier model (a
persistent global quad that non-overridden pages keep following) is
DEFERRED OUT LOUD below unless Owen asks for it by name. And the
yardstick, in the owner's words when offered the layered model (his
call, delegated back): this feature is just designed to make it so i
can crop backgrounds out quickly and easily. Per-page quads stay
because the MINT needs concrete coordinates per page -- storage, not
ceremony; everything above that floor answers to quick-and-easy.

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
  kinds, NAMES the photographs it skipped in the notice bar. **The
LIMIT of the whole family, named from the finished PDF (P2, seq 67):
the aspect rule protects against a DIFFERENTLY-SHAPED photograph, not
against a same-shaped photograph OF A DIFFERENT THING at a different
orientation.** The real shoot contains both: IMG_0238 (landscape,
caught and struck) and a same-shaped modern magazine page that
inherits the volume's three turns and comes out sideways — wrong in a
way no check can see and no rule can catch, because sameShape
truthfully says yes. Nothing detects it but a person looking at the
grid, WHICH IS WHAT THE GRID IS FOR. Not a defect; a boundary,
written down so apply-to-all skips what it must not touch is never
read as covering it.
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
**ANSWERED AND SETTLED (bookforge-pc-2, bookforge-sync seq 100,
derived from their side): hosted, a person is looking at FOUNDRY'S
pane** — the hosted window renders Foundry's bundle alone, and both of
BookForge's queue surfaces live in their MAIN window (the titlebar chip
is explicitly gated off for single-purpose windows). A row we draw is
a row they see; NOTHING IS NEEDED, no outbound row channel, no mount
contract change. Their stated caveat, which does not change the
answer: their Queue tab is where long work is watched, but a mint runs
under the person's own hands in the window their hands are in.
BookForge also verified from the vendored source that our shelfJobs
COMPOSES host rows with local rows rather than replacing — their
setHostQueueRows push cannot erase a running mint. The audit itself (five positions, nine predicates, minted vs
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
| `capture:remove` | invoke | `{projectDir, photoIds: string[]}` → `{recipe}` — the TENTH door (Owen, live: "if i accidentally drag/drop too many/the wrong images, i want to be able to remove them", then "maybe give me a marquee/drag tool so i can pick what gets deleted"). REMOVAL IS NOT STRIKE: strike keeps the photograph and excludes it from the mint; remove takes it out of the project — recipe entries, their pages out of `order`, derived working copies + thumbnails, AND their bank originals, deleted together so nothing orphans. Deleting the bank copies is safe to say out loud because the bank holds COPIES: the files the person dragged in still exist wherever they dragged them from, and the confirm dialog says exactly that, with the count. BATCH by design — the marquee selects many, the door takes the list, ONE confirm, one recipe write. Refused mid-mint (a mint reading a photo that vanishes under it is the alternative). P1 the door, P2 the surface: MARQUEE (rubber-band) selection on the grid + click/ctrl-click, Delete key and a button, confirm through the house dialog |
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
   5.5, line at 0.6). A fixture generator injects THIRTEEN specific
   defects; the self-test proves each is caught BY THE CHECK THAT
   CLAIMS IT, and that a correct project passes clean. (Corrected from
   twelve at seq 73: a pages-swapped defect existed in the fixture with
   no row in the self-test map — a gap in the thing whose job is
   finding gaps, caught by P2 re-reading its own parked run. The fixed
   row asserts BOTH halves: check.js blind to the swap AND page-diff.js
   catching it — before that, C8's value was the one claim taken on
   trust. 13/13 is the number the parked README carries.) Scratch tooling,
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
7. **THE REHEARSAL (P2, seq 67): the 52-page book a person would
   actually want, minted through the shipped geometry — 8/8 checks,
   identity ratios 0.01—0.02 on a book where EVERY page is 2016x3024
   (the header fingerprint is degenerate there and C8's pixel contest
   still separates facing halves of the same spread by 60x). The
   gesture sequence, measured not guessed: THREE quarter turns (one is
   180 degrees short — minted and read upside down before anybody
   believed it; turning is the one gesture whose correctness no number
   shows), split at 0.5, apply-to-all across the 26 same-shaped
   frames, strike IMG_0238, then crop (undone as yet: each half still
   carries a strip of desk and a sliver of the facing page). What
   remains is PERSON-SIZED, not measurable: nobody has pressed the
   button in a running window, and CaptureService has never run inside
   the app.
8. **THE DOOR SERVES BYTES (P1, seq 68): the SHIPPED mount.ts handler
   and the SHIPPED CSP (mountFoundry with no host, no window shown), a
   hidden BrowserWindow loading an <img> exactly as the grid does.**
   Thumbnail 480x640 and working copy 3024x4032 LOADED — the working
   copy decoded by CHROMIUM and matching the recipe, so two
   independent readers of the hand-written encoder's bytes now agree,
   and one of them is the engine the app draws with. Refused, each
   measured: unknown token, ../ traversal, %2F-encoded separator (the
   split-then-decode-then-check ordering P2 verified by reading at seq
   46, now verified by running), fetch() on the scheme (the CSP doing
   what the plan said with no CSP edit ever written) — and THE
   ORIGINAL HEIC: the bank has no door, measured rather than argued.
9. **THE SURFACE RUNS (P1, seq 75): the real AOT renderer from
   dist/renderer, bootstrapped in a never-shown window (the show()
   handler simply not attached — openWindow's own mechanism, minus one
   listener), same preload, isolated userData.** All eight capture
   methods on the bridge; recipeLoad from the RENDERER returned a real
   recipe; zero renderer console errors. Narrows the live drop defect
   to ROUTING ALONE. Second probe (seq 78, corrected at 79/80): the New
   Project modal opens, focuses its field, takes Enter, creates a
   project with capture=true, closes itself, and the light table
   renders — measured BY IDENTITY (querySelector, activeElement,
   listProjects) and standing. A companion claim ("the veil flipped;
   the front-tab signal is live") was WITHDRAWN at seq 80: the probe
   matched /Drop / by PATTERN, took the last hit, and printed it under
   a self-written label — the veil lives behind @if (dropping()) and
   cannot render without a real dragenter, so the drop ROUTING and the
   veil wording remain unexercised by any probe. The rule the ledger
   takes from it: A PROBE FINDS ITS TARGET BY IDENTITY, NOT BY PATTERN
   — a right-looking string under a confident label is worse than a
   wrong number, because a wrong number makes you look. RETIRED at seq
   82 by P2's branch-detection method run on P1's rig: a synthetic
   DataTransfer needs no real paths because the two branches answer
   with two different sentences. Measured: .drop-veil BY IDENTITY,
   null before the drag, present during it, carrying dropSays()'s two
   real strings by front tab; a drop with a light table in front
   produced capture.service.ts:216's refusal — the ONE emitter in the
   codebase, so its appearance proves INTAKE RAN — and Owen's
   documents.service sentence did not appear. Control honestly
   bounded: with Home in front intake did NOT run (its sentence
   absent), and the silence was traced TO SOURCE at seq 83: openDropped
   returns on an empty path two lines before it could speak, so the
   quiet control is an artefact of synthetic files, not a defect — and
   the ROUTING claim (capture front → intake; Home front → not) is
   MEASURED IN FULL, both halves, unique discriminator. The residue is
   a fact about openDropped, older than capture, recorded in PLAN.md. Second probe-defect in the same hour, recorded: the notice
   bar never dismisses on a timer, so the FIRST drop's sentence was
   still on screen when the control read it — RESET WHAT YOU ARE ABOUT
   TO MEASURE, and never quote a probe's hardcoded summary line as a
   finding. What remains for hands: the real drag with real HEICs.

## Wave 21 — the staged editor (Owen, 2026-08-19 evening; BUILD ON
BRANCHES, MERGE ONLY ON HIS WORD — he is mid-crop on the current model)

Owen rejected the linked-global model in favour of STAGES, and his
version is better because it deletes the hardest part: no page follows
anything, every page simply HAS its setting, and the workflow comes
from sequencing rather than linkage. His words: "we hit apply, it
shows up that way on every page... and now when we flip through every
page, we're in a new stage where we can change it per-page."

1. GRID INTERACTION CHANGES: single click SELECTS (marquee, reorder,
   delete); DOUBLE-CLICK or Enter with one selected OPENS THE EDITOR,
   which becomes a MODAL (PDFElement register: page, rect, prev/next).
2. STAGE 1, GLOBAL: the modal edits one rect (and one split). APPLY
   stamps every same-shaped page (aspect-skip family unchanged, skips
   named) — even if nothing was changed first; pressing Apply IS what
   advances the stage.
3. STAGE 2, PER-PAGE: flipping now edits the page in front of you.
   Two buttons: APPLY (this page — marks it SET BY HAND) and APPLY TO
   ALL (re-stamp, which SKIPS hand-set pages BY DEFAULT and names them
   in the existing notice voice: "Left alone: pages 3, 7 — you set
   those by hand", with an explicit include-them override). The
   hand-set mark is the ONE schema addition: `pages[].byHand:
   boolean` (optional, default false), stored so a re-stamp NEXT
   SESSION still cannot silently destroy outlier work. Validator and
   mint ignore it.
4. THE SPLIT LINE GENERALIZES: `split` becomes a SEGMENT — two
   endpoints, each a draggable handle RIDING AN EDGE of the quad
   (opposite edges), so vertical, horizontal, and angled gutters are
   one gesture. The edge-riding constraint is load-bearing: both
   halves stay four-cornered quads the mint can print. Schema:
   `split: {a: [x,y], b: [x,y]}` in working-copy fractions, replacing
   `{x}`; splitAt generalizes from a vertical lerp to the chord.
   Migration: an old `{x}` reads as the vertical segment it always
   meant.
5b. P2's plan-back (seq 128), all five ruled in: the STAGE IS DERIVED,
   never stored -- the modal opens in stage 1 only on a virgin project
   (all whole-frame, unsplit, nothing byHand); anything else opens
   stage 2, so reopening to fix page 31 can never land on the button
   that stamps everything. The two applies are ONE BODY that ALWAYS
   skips byHand and names the skips -- stage 1 is just the call where
   the byHand set is empty, which makes a wrong stage derivation fail
   SAFE (skips and says so) instead of destructive. Within one stamp,
   SPLIT GOES FIRST, then the rect onto the halves (rect-first would
   skip every unsplit photo on page-count grounds with a reasonable-
   sounding refusal list). The stamp CARRIES THE TURN for free (the
   corner order IS the orientation), subsuming stage-1 turn-all; the
   STANDALONE TURN-ALL IS KEPT IN STAGE 2 (ruled) -- it is the one act
   that changes every page without overwriting hand-set crops, and a
   rect stamp cannot express it. The already-split skip RETIRES in
   favour of byHand (split-ness was a proxy for hand-adjusted from
   before the word existed; keeping it would make the first global
   split permanently un-re-splittable). And byHand has one consistent
   lifecycle: per-page Apply SETS it, every global stamp CLEARS it on
   the pages it touches -- otherwise the feature works exactly once
   per project, and a mark left standing after an explicit re-stamp
   is a lie that costs the next global too.

6. FINALIZE (Owen, same evening): the modal ends in a SUBMIT that
   permanently applies the configuration -- the full flow is GLOBAL ->
   OUTLIERS -> FINALIZE, for the rect and the splitter alike. His
   model: PDFElement writes the files, and thereafter you work with
   the pages as configured; keep the old ones so stepping back is
   possible. Shape to plan-back (not yet settled beyond intent):
   finalize rasterizes each page through the SHIPPED rectify -- the
   mint's own path, ONE implementation as always -- into a
   finalized/ set the light table then shows; the bank and the recipe
   REMAIN, so step-back is deleting finalized/ and returning to the
   live recipe (reconstructible, not archived copies -- the derived/
   rule extended, not broken). PLAN-BACKS ARE IN (P2 seq 131; P1's
   mint measurement seq 132) and they overturn the shape, not the
   intent -- ESCALATED TO OWEN, nothing cut until he rules:
   - Step-back is ALREADY FREE here. "Keep the old ones" is a
     PDFElement requirement because PDFElement writes over things;
     Foundry's originals are immutable content-addressed bytes and
     every page is derivable from originals + recipe. finalized/
     cannot buy safety -- only a view or speed.
   - The RESOLUTION TRAP: the mint must never assemble from
     finalized/. If those files are less than full output resolution,
     pressing Finalize silently DEGRADES the minted PDF -- a commit
     button that makes the deliverable worse, invisible until someone
     zooms. And P1 measured the mint needs no change at all (each
     page is the maxima of its own opposing edges; a leaning cut
     resamples nothing downward) -- one implementation, untouched.
   - The BILL, measured on his live project: full-resolution
     finalized/ adds ~229 MB to a 459 MB project (25 pages, mean
     9.1 MB rectified) -- half again, for pixels derivable from bytes
     beside them. And it is a FOURTH place a page can live, keyed by
     nothing: re-edit after finalize and the table draws the old page
     while the recipe holds the new one -- the recurring defect with
     a new folder name.
   - PROPOSED SHAPE (what "work with the pages as configured" costs
     when it is a VIEW): finalize is a MODE, one persisted bit. The
     light table stops drawing photographs-with-outlines and draws
     PAGES -- rectified, cropped, turned, a spread as two cards, no
     corner mark -- through the same Rectifier the editor preview
     runs, over the 640px thumbnails (fractions apply at any
     resolution; the unit decision pays for this). Derived on every
     draw, so it cannot go stale and re-editing needs no answer.
     Step-back is a button, not a deletion. If full-res assembly ever
     hurts, the speed fix is a CACHE keyed by (photo sha, quad,
     output size), filled by the mint's own path -- byte-identical by
     construction, wantable independently, later.
   - OWEN'S CALL: his words were files on disk; the agents' case is
     the mode. If he wants files after reading the bill, files get
     built -- knowingly, at full resolution only.

5. The staged flow REPLACES the apply-to-all buttons on the light
   table (two ways to say everywhere would be the drift disease as
   UI). The Turned/Split/Crop set acknowledgements and the corner mark
   carry over into the modal.

Clarified by P1's plan-back (seq 125), all five accepted:

- The validator CARRIES `byHand` and refuses a non-boolean (the `name`
  rule); it never CONSULTS it. "Ignore" was the wrong word: validRecipe
  REBUILDS pages field by field, so an unlisted field is not ignored,
  it is DROPPED — and the mark would not have survived one save. The
  mint ignores it for real.
- Split POINTS are stored as ruled but are GESTURE STATE (the quads
  stay authoritative, as `split` always was): a corner drag after a
  split leaves the stored segment stale against the crop, so the modal
  RE-SEATS endpoints on their nearest edges rather than trusting them.
  Endpoints resolving to ADJACENT edges are refused (a corner cut is a
  triangle and a pentagon, not two printable quads).
- `joined()` generalizes with the same edge knowledge: the vertical-only
  reconstruction returns a BOW TIE for a horizontal cut, and the editor
  draws its gutter from it.
- Page order generalizes by one word: THE HALF HOLDING THE QUAD'S
  TOP-LEFT CORNER COMES FIRST — same answer as left-then-right for
  every vertical split, right answer for horizontal, orientation-aware
  for free because the corner order IS the orientation.
- The chord lives in shared/capture.ts beside outputSizeFor, sameShape
  and mintedPageIds — the FOURTH application of one-implementation, the
  first applied at design time: `halvesOf(quad, split) ->
  [CaptureQuad, CaptureQuad] | null` (null = segment does not resolve
  to opposite edges; validator refuses, editor re-seats) and
  the chord family, final signatures (P2 seq 127, converged): the
  wrong joined() for a horizontal cut is NOT a detectable bow tie
  — measured, it is a CONVEX quad of EXACTLY HALF the sheet's area at
  every cut position, so no self-intersection or area guard can catch
  it; the function must KNOW, not check. And joined() has a WRITE
  path (setSplit derives and stores the halves), so the bug class is
  wrong-half-of-the-sheet-in-the-PDF, not a misplaced handle.
  - `halvesOf(quad, split) -> [CaptureQuad, CaptureQuad] | null` —
    top-left-corner half first; null = endpoints not on opposite
    edges.
  - `joinedQuad(quads, split)` — the split is read for ORIENTATION
    ONLY (which pair of opposite edges: a stale segment's position
    goes stale, its orientation does not — dragging a crop corner
    slides endpoints along their edges, never across to another),
    never for position. The re-seat rule keeps its one stated
    exception with a reason.
  - `splitFromFraction(quad, x)` — the vertical segment {x} always
    meant, ONE body: main's migration and the Split button's default
    both call it.
  - `seatSplit(quad, split, which, to) -> CaptureSplit` — THE ONLY
    way a segment is ever constructed from a pointer; incapable of
    returning what halvesOf nulls, so null genuinely means a
    hand-edited file, never "the handle got there by dragging" — the
    draws-fine-refuses-to-save class, refused by construction. The
    dragged end projects onto the edge OPPOSITE its partner, the
    partner re-seats on the way past. It does NOT stop an end at a
    corner (sliver half) — that is a gesture question, P2's.
  - `cutOf(quad, split) -> SplitCut | null` — the RESOLVER (re-seat +
    refusal), named so seatSplit keeps sole claim on "seat":
    SplitCut carries a and b each with {edge, at, point} plus
    halves: side-by-side | stacked, so handles draw at .point
    without re-deriving edges.
  - `WHOLE_FRAME` — the one whole-frame quad constant (was WHOLE in
    capture.service.ts, now imported).
  The words left/right die in the same commit (splitAt's tuple, the
  CapturePage docblock) — a stale comment asserting the wrong thing is
  how the last geometry bug survived two readings.
  Main needs the chord for the {x} migration; the renderer for the
  handles; two bodies would be found in a minted PDF.
- Migration of `{x}` happens ON READ, every open, not one-shot — an old
  recipe stays readable forever and the next save writes the new form.
- Mint chord expectation ("needs nothing — quads were never
  axis-aligned") MEASURED TRUE (P1 seq 132, through mintBegin
  arithmetic on a leaning cut): each page is the maxima of its own
  opposing edges, so the lean keeps the longer edge and nothing is
  resampled downward. NO MINT CHANGE.

The byHand MIGRATION (P2 measured seq 130, P1 built seq 132, ruled
in): Owen's live recipe already holds Wave 21 executed by hand --
24 pages on one global quad, IMG_0212 hand-dragged -- and byHand
defaults false, so unmigrated, the first Apply-to-all in the new
editor destroys that outlier. The mark is DERIVED ON READ, beside
the {x} migration: the most-common quad among same-shaped
photographs is the global; every page not EXACTLY equal to it gets
byHand: true. Exact float equality, no tolerance (the stamp COPIES
quads, it never computes them); compared PER PAGE SLOT (comparing
across slots would mark every right half of a split shoot); a group
with no single most-common quad is left entirely alone (a tie is
absence of a stamp, not evidence of a hand); and it runs ONLY WHILE
THE FILE HAS NOT SPOKEN -- if any page carries the field, every mark
is a statement and nothing is derived, because a page hand-set BACK
to the global crop is a stored fact a geometry-only inference would
silently clear on the next open (and per seq 129, applies set and
clear the mark; an inference running after them would be a third
writer). Where the rule degrades it degrades SAFE: over-marking
costs a named skip and one click of the override; under-marking
costs an evening of cropping. Measured on his recipe read-only:
exactly one page comes back marked, and it is IMG_0212.

Built (P2 seq 136, ruled in by foundry-pc-2):

- THE orderFor DEFECT, LIVE ON MAIN SINCE SPLITTING EXISTED: the
  docblock promised to fold a newly-cut page in beside the page it
  came from; the code recognised a new page by the old id VANISHING.
  A cut adds :1 and leaves :0 in place, so the id never vanishes and
  every right-hand page fell to the sweep at the end -- four
  photographs split in one act gave A:0 B:0 C:0 D:0 A:1 B:1 C:1 D:1,
  a whole book of versos then a whole book of rectos, visible in the
  minted PDF and nowhere before it. The everyday case is quieter
  (P1, confirmed against the shipped body): split ONE spread of
  twenty-five and its recto lands after all twenty-five -- one page
  adrift in an otherwise perfect book, the first gesture anyone
  would actually make. It survived because nothing had ever split a
  real shoot. Main is otherwise CLEAN of the class (P1 checked: the
  three other order writers -- intake append, removal filter,
  mintBegin walk -- none infers a new page). And the validator
  passes the bug AND SHOULD: it guarantees the SET (every page
  listed once), never the SEQUENCE -- the arrangement is the
  person's, and the only rule strong enough to catch this would
  refuse the deliberate drag-apart the fix preserves. The order is
  the one part of the recipe no validator can defend; only cases
  against the real function body reach it. Fixed on the branch by the NARROWER rule:
  a page the arrangement already names keeps its own slot; only a
  page it has never heard of is folded in beside its sibling --
  narrower because somebody who dragged the halves of a spread apart
  has an order that says so, and "keep a photograph's pages
  together" would quietly undo it on the next stamp. Nine cases run
  against the real function body. UNTIL THE WAVE 21 MERGE, SPLITTING
  AND MINTING ON MAIN PRODUCES A MIS-ORDERED BOOK.
- THE STAMP DISSOLVED split-before-rect RATHER THAN NEEDING IT: the
  stamp copies THE SOURCE'S PAGES, and the split, crop, and turn are
  already in those quads -- one assignment, no sequence, nothing to
  get backwards. The 5b line stands as intent; it is enforced by
  there being one act, not by an order between two. This also
  retires the PAGE-COUNT SKIP on the stamp arm (that refusal existed
  because a quad copy could not invent a split; this arm copies the
  split too, so the count follows). byHand is the only guard left
  on the stamp arm, which is what the ruling wanted; the aspect skip
  stands.
- PER-PAGE APPLY MOVES NO CORNER (ratified): corners save as they
  are dragged -- that is what stops a flip losing an adjustment --
  so the button's whole job is the part that was never expressible:
  this setting was chosen FOR THIS PAGE. It TOGGLES byHand (a mark
  set by mistake must not need a global-with-override to escape);
  the label states the state: Apply, then Set by hand.
- THE INCLUDE-HAND-SET OVERRIDE IS DRAWN ONLY WHEN HAND-SET PAGES
  EXIST, carrying the count ("including the 3 set by hand") -- a
  permanently present tick box about a condition that usually does
  not hold is a control people learn to stop reading.
- THE SLIVER FLOOR, RULED AND ASSIGNED (P1 the chord, P2 the
  gesture): the honest measure is not the endpoint, it is THE AREA
  OF EACH HALF -- measured through the shipped chord, a half's area
  is EXACTLY AFFINE in the dragged seat, so "neither half below X%
  of the sheet" is a closed-form solve inside seatSplit, no search,
  no tolerance, the lean already in the arithmetic. The same
  measurement shows why the old 2%-off-the-end clamp was the wrong
  rule all along: at a corner, a leaning cut's smaller half is still
  14.7% of the sheet -- the corner is not the sliver and the sliver
  is not at the corner (the {x} disease again: a rule only right for
  cuts parallel to the sides). FLOOR = 2% OF THE SHEET PER HALF --
  NOT A NEW DECISION (P2 seq 139, overturning the lead's first 5%):
  the pre-Wave-21 clamp was 2% along the edge, and for the only cut
  that then existed 2% along the edge IS 2% of the area, so this is
  the old rule restated in the measure that survives a lean, and
  Owen does not have to be asked. It stays LOW because a floor has
  NO OVERRIDE: 5% would silently refuse a legitimate unequal cut (a
  narrow column, an inset, a foldout leaf) as a handle that sticks
  for no reason -- degeneracy is the clamp's job, taste is the
  preview's, which draws each half at mint size through the same
  shader. The floor almost never binds: even an end ON the corner
  leaves the smaller half 10.7-11.5% of the sheet; the only thing
  2% catches is both ends crowding the same side, which is the
  sliver. TWO IMPLEMENTATION FACTS THAT MUST NOT BE LOST: the
  affinity is PROVABLE, not just measured (dragging one end moves
  exactly one vertex of each half, shoelace is linear in each
  vertex, the seat is linear in t -- confirmed on five quads, worst
  second difference 3.3e-16), and THE SLOPE IS PER-QUAD, NOT A
  CONSTANT (0.410-0.505 across five shapes): the solve evaluates
  the half's area at t=0 and t=1 for the quad in hand and inverts
  that line -- two area calls and a divide -- and never carries a
  measured number, which would be right on the acceptance shoot and
  wrong on the next book by twenty percent. seatSplit clamps, so
  the surface still cannot express a state anything downstream
  refuses.
- NO HAND HAS TOUCHED ANY OF IT: four gates, nine order cases, and
  the chord numbers underneath -- and the modal has never been
  opened by a person. First act when the gate lifts: open the modal
  and split one spread.

Package split: P1 — schema (byHand, split segment), validator, mint
chord measurement, migration of {x}, the shared chord; P2 — the modal,
stages, buttons, edge-riding handles, grid double-click/Enter/selection
rework, building against P1's halvesOf signature.
Frontend-design skill pointer applies to the modal treatment.

## Deferred out loud

- **Validator page-level refusals name pages by sha** ("page
  aaaa...:0 says it was set by hand in something that is not a yes
  or a no") — the sentence a person sees when a recipe refuses to
  open. Predates Wave 21; pages carry no name. Fix shape when taken:
  name the photograph (CapturePhoto.name, the Wave-20 field) plus
  the half, sha prefix only as fallback. Noticed by P1 seq 132;
  deferred by foundry-pc-2.
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
- ~~An intake progress channel~~ **UN-DEFERRED BY OWEN, live (2026-08-19):
  he dropped the 27 and the app FROZE for a minute — no progress, the
  window unmovable — because the decode runs in MAIN and blocks its
  event loop.** Ruled: a NINTH channel, `capture:intake-progress`, a
  PUSH following the `env:install-progress` precedent exactly
  (broadcast in main during the intake invoke, subscribed in preload);
  payload `{projectDir, done, total, file}` per photograph. P1 emits it
  AND yields between files so the window stays alive between decodes;
  the ~2 s wasm decode of each photo still blocks in main, and the
  REAL unblocking (decode in a utilityProcess) is deferred out loud.
  P2 draws the PROGRESS MODAL Owen asked for — his words: it should
  pop up a progress modal — showing done/total and the current file.
  No cancel in v1 (an aborted intake mid-append is its own design),
  deferred out loud. The one-progress-shape aspiration yields to the
  owner's ask: the mint keeps its queue row, intake gets a modal, and
  the difference is honest — a mint is background work you leave, an
  intake is a drop you are standing in front of. LANDED both halves
  (f6b7138 + f990b33): payload decisions REMOVE arithmetic from the
  modal (`file` names the photo IN HAND so done sits one behind it;
  `total` counts every path asked for so the bar cannot run backwards
  on a stray file; a closing push so the card never hangs at n-1).
  Freeze measured before/after by heartbeat: event-loop turns 13→47,
  median lateness 31→0 ms; the ~1.4 s wasm decode per photo REMAINS
  (one hitch per photograph, live window between), utility process
  still the real fix, still deferred. Modal decisions, endorsed: shown
  ON THE INVOKE, not the first push — P1 measured the first push at
  ~110 ms so the original latency reason fell, and the stronger one
  replaced it (seq 96): the card must not be COUPLED to the channel;
  a push that never comes must not mean a card that never shows.
  Cleared in a finally, not on the closing push (done===total arrives
  while the recipe writes; vanishing then uncovers an empty table for
  a beat). NOT in UiService's one-question list (a modal is a
  QUESTION, this is a REPORT — only() closing it would be precisely
  wrong).
- JPEG/PNG intake: v1 refuses them by name. Before adding, MEASURE
  who applies EXIF Orientation on Electron’s decode path, the same
  question libheif already answered for HEIC (a wrong answer turns
  a shoot sideways silently).
- An exhaustiveness helper on defaulting switch arms over StepAction
  (read-back section 4): the two Translated-stamp defects compiled green
  because default: hides a widened union; a never-check would make the
  compiler name them. Out of scope tonight, worth its own small pass.
- A PERSISTENT global-quad layer (pages without their own override
  keep following later changes to the global): a real schema change
  with merge semantics; the v1 surface (apply-to-all named "global" +
  per-page overrides) covers the workflow without it.
- A time-provenance badge (P1, seq 122, found by the unread-field
  grep): the grid sorts by takenAt, and a photograph whose time FELL
  BACK TO MTIME sits in Newest first at a position that is not a fact
  about when it was taken -- a copied or re-saved file carries a
  modification time with no relation to the shutter. On a mixed shoot
  the sort silently interleaves two kinds of time. Unreachable on the
  acceptance shoot (27/27 exif-offset, measured); when a capture
  project ever holds an mtime photograph, ONE SENTENCE in the grid
  header (the sibling of Your order -- the capture-time sort no longer
  applies, same place, same voice: N of these times are file dates,
  not capture times) -- never a per-card badge, because the mark is
  about the ORDER, not the photographs, and the photographs are the
  one bright thing on that table (P2, seq 123). The sort DERIVATION is
  unbroken either way, checked: an mtime is still a time, so
  monotonicity has the same answer; what breaks is what Newest first
  MEANS -- truthfulness, not correctness, which is why nothing fails.
  takenAtSource itself stays write-only ON PURPOSE -- provenance on
  disk, askable, is a legitimate never-read shape, unlike an unwired
  boolean.
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
package.json, INSTALL BEFORE BELIEVING A GATE. Sixth (P2, seq 136),
the probe that agrees with the bug: orderFor shipped broken under
green gates AND green end-to-end probes, because the probes diffed
each split page against the source they had COMPUTED for it -- the
same wrong assumption twice is not a check. The defect was found by
TESTING THE FUNCTION BEFORE BELIEVING IT: the docblock and the code
disagreed, and the docblock was the true one. Rule: a probe must
hold at least one fact the code under test does not derive (here,
the human-known right order), or it measures agreement, not
correctness. Two more gate hazards,
both measured: npx tsc exits 0 without compiling at THREE sites on
this machine now, so the leaf configs run ./node_modules/.bin/tsc by
path; and bunx at root, never npx. Agents never commit; the lead verifies, commits,
and pushes. **`bunx`, never `npx`**: at this repo's root, `npx tsc`
fetches a joke package that prints "This is not the tsc command you are
looking for" and EXITS 0 — the vacuous gate in its purest form,
measured the hard way during Merge 1.
