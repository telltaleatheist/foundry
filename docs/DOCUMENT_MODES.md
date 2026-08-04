# Document modes — the working PDF is the pipeline's state

The run directory (docs/PIPELINE.md) is still here and still the contract for
the stage-by-stage path. This document describes the OTHER shape foundry now
has, and the rule it is built on:

> **Every stage is document-in → document-out.** A stage ends by writing a real
> file any external tool can open. Nothing is parked in a run directory waiting
> to be "applied", and foundry never invents a filename — every input and every
> output is named on the command line.

## The working document

An untouched original PDF is cast ONCE into a working PDF. Every stage after
that writes INTO that file as a PDF **incremental update**: bytes appended, no
byte moved, the objects a stage replaces still present earlier in the file.

Three properties follow, and they are the point of the whole design:

- **The file is a valid PDF at every stage boundary.** Not once the run
  finishes — at every boundary, openable by any reader.
- **A stage boundary is a byte offset.** "Reset to that stage" is
  `truncate(file, offset)` (`truncateToBoundary` in `src/pdf/document.ts`).
- **A stage's output is inspectable with the tools everyone already has.** The
  text layer is selectable in Preview; the block layer is a set of annotations
  in Acrobat's sidebar, coloured and named.

```
  original.pdf                      never written to, by anything
        │
        ├── foundry scan --pages <dir> --run <dir>          Tesseract reads renders
        │   └── foundry get-text --pdf … --run … --out working.pdf
        │                                                   FULL REWRITE, class `scanned`
        └── foundry scan --pdf original.pdf --run <dir> --out working.pdf
                                                            FULL REWRITE, class `text`
  working.pdf
        ├── foundry blocks --run <dir> --pdf working.pdf     += annotations
        ├── foundry footnotes --pdf working.pdf --report …   text layer rewritten
        └── foundry reflow --pdf working.pdf --out book.epub → the book
```

The cast is the ONE full rewrite. It re-serializes the object graph in a single
pass, which is also what drops a linearization — a first-page layout declaration
that an append silently invalidates (docs/PDF_SPIKE.md §5).

## What the document carries

### The catalog: `/Foundry`

```
/Foundry << /Version 1 /Class /scanned /Lang (eng) /Dpi 200
            /SourceSHA256 (…) /Producer (foundry 0.3.1) >>
```

- **`/Class`** is `scanned` or `text`, and it decides whether the ocr model is
  pointed at the book. A scan's words came out of Tesseract and are repaired
  line by line; a text document's words are the publisher's and are not touched.
  This is a fact about the document, so it lives in the document — a side file
  saying which one it is would be a second source of truth for whether a model
  edits somebody's book, and the wrong answer is silent either way.
- **`/Dpi`** is the pixel frame everything geometric in the file is expressed
  in. See "One frame" below.
- **`/SourceSHA256`** is the ORIGINAL's hash, and it is what the EPUB's
  `dc:identifier` is built from — stable across every recast, and unlike the
  working document's own hash it does not change every time a stage appends.

### The text layer

Written by `get-text` for a scan: one invisible text run per recognized line,
positioned at that line's box, in reading order. The font is a glyphless
Type0/Identity-H with no embedded program and a `/ToUnicode` CMap covering the
whole BMP, so every character survives — ligatures, daggers, accented capitals,
Greek in a footnote. The page records the stream under `/FoundryText`, so a
later stage rewrites exactly foundry's layer and nothing else.

For a `text`-class document the text layer is the publisher's own and foundry
only reads it.

### The block layer

One `/Square` annotation per block (`src/pdf/annotations.ts`):

| key | what it is |
|---|---|
| `/Rect` | the block's box, in the page's own coordinates |
| `/C` | the category's colour (`--palette` supplies the caller's) |
| `/NM` | the block id |
| `/T` | `id category` — what a reader's annotation list shows |
| `/Contents` | the block's text. For a `chapter`, this IS the title |
| `/FoundryCategory` | the category, machine-readable |
| `/FoundrySeq` | position in the book's reading order |
| `/FoundryMerged` | the ids this annotation was merged from |
| `/FoundryDeleted` | present and true iff this block is dropped |

`blocks --pdf` REPLACES: every annotation carrying `/FoundryCategory` is removed
and the new set written, as one incremental update. A publisher's links and a
reader's own highlights are untouched.

### Deletion

Three ways to say "not this", and reflow honours all three:

1. `/FoundryDeleted true` on a block annotation.
2. `/FoundryPageDeleted true` on a page — every block on it goes.
3. Removing the annotation outright. A line that no block contains is not in the
   book, so deleting a box in any PDF editor deletes its text.

`reflow --exclude <category>` is the fourth, and it is the CLI's, not the
document's — it is a statement about this export rather than about the book.

## One frame

Foundry measures everything in the SCAN's frame: pixels at 200 dpi, origin
top-left, y down, half-open boxes. Every model was trained on numbers in that
frame and every deterministic rule — calibration, the paragraph splitter, the
display-run merge — has its thresholds derived from it (ARCHITECTURE §5).

PDF user space is points, origin bottom-left, y up. `src/pdf/frame.ts` converts
at the edge and carries the page's CROP BOX origin, which is not always (0,0) —
a trimmed scanner margin is the common case, and a renderer's pixel (0,0) is the
crop box's corner, not the media box's.

`scan --pdf` projects a text PDF's geometry into the same 200 dpi frame, so a
book that never met Tesseract still hands the blocks model the numbers it was
trained on.

## Known limits

- **`/Rotate` is refused.** A page that declares a rotation is read in its own
  unrotated coordinates while a reader shows it rotated, so a text layer or a
  block box would land somewhere other than on the words. Both extraction and
  `get-text` stop and name the page.
- **The text layer is written in the STRAIGHTENED frame.** A scan's line boxes
  are measured after the band segmenter deskews the page, and `get-text` does
  not rotate them back — so on a page with a nonzero deskew the invisible text
  is offset from the visible ink by that angle (at most 3°, the segmenter's
  search bound). The angle is recorded per page as `/FoundryDeskew`. Reflow
  reads the same frame the layer was written in, so the BOOK is unaffected; what
  degrades is selection alignment in a reader, on tilted pages only.
- **`footnotes --pdf` requires the `scanned` class.** A text document's layer is
  the publisher's page description, and rewriting that from a parse of it would
  re-lay-out the book. Export it and use `footnotes --epub`, where the markers
  are markup.
- **The run directory is still an input to `blocks`.** The blocks stage reads
  `scan/{pages,lines}.json` and writes both `blocks/blocks.json` and the
  annotations. Only `reflow` and `footnotes --pdf` are document-only today.
