# The pdf-lib validation spike — findings

**Verdict: @cantoo/pdf-lib 2.8.1's incremental-update path is sound, and the
document pipeline is built on it.** Every question below was answered by running
it, on synthesized documents and on real scanned books, and the runs are kept in
the suite as `test/pdf/spike.test.ts`. A regression there is not a red test — it
is every working document in the field one stage away from losing a chapter.

Measured 2026-08-03 on Windows 11 / bun 1.3.14, @cantoo/pdf-lib 2.8.1,
pdfjs-dist 6.2.108.

---

## The one thing that must be got right: marking

`saveIncremental(snapshot)` writes an object automatically when its object
number is past the snapshot's high-water mark — i.e. when the object is NEW.
An object that already existed is written **only if it has been marked**
(`snapshot.markObjForSave` / `markRefForSave`).

This was measured the hard way: pushing an annotation reference onto a page's
existing `/Annots` array and saving produced a valid, parseable incremental
update **that did not contain the annotation**. No error, no warning — the
change was simply not in the file.

That is the whole reason `src/pdf/document.ts` exists and why every mutation of
an existing object in this repository goes through `WorkingPdf.markChanged`.
It is not a wrapper for tidiness; it is the guard for the one silent failure
this library has.

---

## 1. Sequential incremental appends

Each round: read the file, `PDFDocument.load(bytes, { forIncrementalUpdate: true })`,
`takeSnapshot()`, add one square annotation carrying a value unique to that
round, `saveIncremental`, append the returned bytes to the file. Every 20 rounds
the file is re-parsed from scratch and **every annotation written so far** is
checked for its own value, plus the page count.

| document | pages | base | appends | total time | per append | growth |
|---|---|---|---|---|---|---|
| synthesized | 300 | 194,793 B | **220** | 42.6 s | 194 ms | +145,810 B (663 B each) |
| Kershaw, *Working Towards the Führer* | 17 | 3,677,256 B | 25 | 6.8 s | 273 ms | +19,671 B (787 B each) |
| Kershaw, *The 'Hitler Myth'* | 324 | 42,675,967 B | 3 | 9.7 s | 3.2 s | +2,232 B (744 B each) |

Nothing was lost at any checkpoint: after 220 appends all 220 annotations were
present with their own contents, and the page count was still 300.

**Reading:** the cost of an append is dominated by re-parsing the whole document
(a 41 MB book is 3.2 s), and the bytes written are ~700 per annotation
regardless of document size. That is the property the design needs — a stage
that adds a block layer to a 41 MB scan writes kilobytes, not megabytes.

`saveIncremental` returns **only the difference**, not the whole file. The
caller appends it. (`commit()` returns the whole file instead; foundry does not
use it — the file on disk is the document, and appending to it is the point.)

## 2. Truncate to a boundary

The byte length after each append is a stage boundary. Truncating the file to an
earlier boundary yields a document that:

- parses, with the right page count;
- contains exactly the annotations written up to that boundary and none after;
- can be appended to again.

All three verified. `truncateToBoundary` refuses an offset past the end of the
file rather than growing it — a boundary beyond the end belongs to a different
document.

## 3. Invisible text layer

Written with `pushOperators`: `q BT 3 Tr /FoundryText <size> Tf <a> 0 0 1 <x>
<y> Tm <hex> Tj ET Q` per line, into a content stream appended to the page and
recorded on the page dictionary as `/FoundryText`.

The font is a **glyphless Type0 / Identity-H** with no embedded font program: the
two-byte code IS the UTF-16 code unit, and a `/ToUnicode` CMap states the
identity over the whole BMP in 256 spec-legal `bfrange` blocks. The descendant
font declares `/DW 500` and no `/W`, so the natural width of a run is exact
arithmetic (`0.5 · n · size`) and the horizontal scale that fits it to its box is
a division rather than a metrics lookup.

Round trip verified through pdf.js (`src/pdf/extract.ts`), character for
character, **including `ﬁ`, `—` and `“ ”`** — with `disableNormalization: true`,
without which pdf.js decomposes the ligature to `fi` and the layer would put a
word in a book that the book does not contain. Positions come back within 1 px
at 200 dpi of where they were written.

A WinAnsi standard font was rejected: `ﬁ`, `†`, `—` and `Ü` all appear in the
German-history scans this pipeline is for, and WinAnsi carries three of the four.

## 4. Custom annotation keys

`/FoundryCategory` (name), `/FoundrySeq` (number), `/FoundryMerged` (array of
strings), `/FoundryDeleted` (boolean), alongside the standard `/NM`, `/T` and
`/Contents`. All survive `register` → `saveIncremental` → append → fresh
`PDFDocument.load` → `lookup`. Verified for a merged chapter block, a body
block, and a deleted footnote block, on separate pages.

Replacement was verified too: a second write removes every annotation carrying
`/FoundryCategory` and leaves everything else on the page alone, so re-running
`blocks` leaves the document describing **one** segmentation.

## 5. Linearized input

Neither real fixture is linearized, and this repository has no linearizer, so
the case is a hand-built fixture (`test/pdf/linearized.ts`): a valid one-page PDF
whose first object is a `/Linearized` parameter dictionary declaring the file's
own total length in `/L`. It is not a *complete* linearization — there is no hint
stream and no first-page cross-reference section — and it does not need to be:
`/L` is the declaration a reader checks before trusting the fast-web-view layout,
and it is the declaration an append destroys.

Measured:

- pdf-lib parses the linearized file and an incremental update succeeds — the
  document still works.
- The file now declares a length shorter than it is. **The linearization cannot
  be repaired by appending**, because repairing it means rewriting bytes at the
  front of the file, which is the one thing an incremental update does not do.
  So a linearized input degrades to a document carrying a false claim about
  itself.
- A full rewrite through pdf-lib removes the linearization — **but only because
  foundry removes it.** Measured: pdf-lib's own `save()` carries the
  linearization parameter dictionary through as an ORPHAN object (nothing
  references it; it is found by being first in the file), still declaring the
  original length. `dropLinearization()` in `src/pdf/document.ts` deletes it, so
  the working document makes no claim about a layout it does not have.

**This is why `get-text` and `scan --pdf` are full rewrites** rather than a copy
plus an incremental update: they cast the working document once, in one pass,
and everything after them appends to a file with no stale front matter in it.

---

## The other dependency: pdf.js under `bun build --compile`

pdf-lib cannot extract text — it parses the object graph, not the content
streams' text — so extraction is `pdfjs-dist` (pure JavaScript, legacy build).
Under `bun run` it works out of the box. **In a compiled binary it does not
start**, for two reasons, both fixed in `src/pdf/runtime.ts`:

1. pdf.js's canvas layer constructs a `DOMMatrix` and a `Path2D` at module load.
   In Node it gets them from `@napi-rs/canvas`, a NATIVE optional dependency,
   which cannot be embedded in a `bun --compile` binary. Both are stubbed before
   pdf.js is imported; every method on the stubs throws, because nothing in text
   extraction may legitimately call one.
2. pdf.js loads its worker with `import('./pdf.worker.mjs')` — a dynamic import
   of a path that only exists in `node_modules`, so it is not bundled and the
   binary fails with `Cannot find module './pdf.worker.mjs'`. The worker is
   therefore imported **statically** and assigned to `globalThis.pdfjsWorker`,
   which is the hook pdf.js checks before it resolves any path.

Proven by building and running a real binary in `test/pdf/compile.test.ts` —
not by reasoning about the bundler.

Cost of the two dependencies in the shipped executable: **+3.4 MB**
(98.5 MB for a bun hello-world, 101.9 MB with pdf.js and pdf-lib linked in).

Extraction throughput: 17 pages / 798 lines in 0.77 s; 324 pages / 12,000 lines
in 1.76 s.

## Known limits, recorded rather than worked around

- **`/Rotate` is refused.** A page that declares a rotation is read by foundry
  in its own unrotated coordinates while a reader shows it rotated, so a text
  layer or a block box would land somewhere other than on the words. Both
  extraction and `get-text` stop and name the page.
- **Text on a rotated or sheared baseline is refused**, for the same reason: a
  line at an angle measures as a box far taller than its type, and every
  paragraph rule is calibrated on that measurement.
- **The text layer is written in the STRAIGHTENED frame.** A scan's line boxes
  are measured after the band segmenter deskews the page, and `get-text` does
  not rotate them back — so on a page with a nonzero deskew the invisible text
  is offset from the visible ink by that angle (at most 3°, the segmenter's
  search bound). The angle is recorded per page as `/FoundryDeskew` so the
  difference is stated in the document. Reflow reads the same frame it was
  written in, so the BOOK is unaffected; what degrades is selection alignment in
  a reader, on tilted pages only.
