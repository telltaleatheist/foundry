# The pipeline contract — the run directory IS the API

Owner's product definition (Aug 1 2026): a user feeds in a PDF — bad scan or
decent one — and it reflows into a readable EPUB. Standard fonts (one CSS we
control; no font matching, ever). Proper structure: title sections, chapter
markers where `chapter` blocks were found, headings, flowing paragraphs.
Footnotes are NOT linked to their body markers; the markers themselves are
removed by foundry-footnotes once that adapter ships. The CLI can exclude whole
box categories (`--exclude footnotes --exclude captions`). BookForge needs the
data at every step, because its users open the categorized PDF in pdf-picker
and delete arbitrary boxes — a category, two footnotes, one body block — and
re-export.

The design answer to all of that is one rule:

> **Every stage writes its artifact to a documented, stable path inside the run
> directory, and the EPUB is merely the last consumer of them.** Foundry's
> integration surface is files, not function calls.

## Run directory layout

```
<run>/
├── run.json            # pipeline state: stage status, versions, input hash,
│                       # model ids, and `segmenter` — WHAT PRODUCED THE LINES,
│                       # as a tagged union: the pinned Tesseract over renders,
│                       # or `embedded-text` where a PDF's own text layer was
│                       # read and nothing was rasterized at all. The resume /
│                       # audit record.
├── scan/
│   ├── pages.json      # per page: width, height, deskewDeg, render dpi
│   └── lines.json      # per line: band box [x0,y0,x1,y1] full-page px
│                       # (half-open, PIL crop order), page, OCR text,
│                       # word confidences
├── blocks/
│   └── blocks.json     # per block: id, page, bbox, line ids, category,
│                       # continues bit, geometry facts fed to the model
│                       # (first-line indent, gap-above, prev-line-short,
│                       # wrap-hyphen), calibration verdict for the book,
│                       # and `formation` — WHICH SEGMENTATION formed these
│                       # blocks (gap cut + paragraph splitter + display-run
│                       # rejoin, composed in run order). A prediction is only
│                       # comparable to a corpus segmented the same way.
├── ocr/
│   └── lines.json      # per line: corrected text + the edit list that was
│                       # applied + rejections (before/why)
├── footnotes/
│   └── deletions.json  # per block: marker deletions applied + rejects
└── export/
    ├── book.epub
    └── exclusions.json # exactly what was excluded, by category and/or
                        # block id — the export is reproducible from this
```

Formats are versioned in `run.json`. A field is never repurposed; additions are
backwards-compatible; a breaking change bumps the format version and old
readers refuse loudly (no silent misreads).

## Export semantics

- **Exclusion is one filter at two granularities.** `--exclude <category>`
  (CLI) and an explicit block-id list (BookForge's per-box deletion) compose:
  a block is dropped if its category is excluded OR its id is listed. One
  export implementation serves both consumers.
- **Chapters**: a `chapter` block starts a new spine item / TOC entry. `title`
  opens the title section. `heading`/`subheading` emit `h2`/`h3` in place.
- **Paragraphs**: the §9d rules (see BookForgeApp docs/RUBRIC_TRAINING.md §9d)
  — applier-owned hard rules (wrap-hyphen ⇒ continue, category transition ⇒
  break), model `continues` for the residue, merge when unsure. A book with no
  detectable paragraph convention degrades to few/no breaks, REPORTED loudly,
  never a failure.
- **Hyphens**: an ASCII wrap hyphen is JOIN EVIDENCE and is decided against the
  book's own vocabulary; unproven keeps the hyphen. A **soft hyphen (U+00AD)**
  is not ambiguous — it is a typesetter's discretionary break, invisible unless
  the line falls on it — so it joins unconditionally, and one that did not fall
  on a break is invisible formatting and is stripped. Both are counted in the
  stage's summary line. (Measured on Kershaw 2026-08-04: an ASCII-only rule read
  those line ends as carrying no hyphen and emitted `totali tarianism`.)
- **Footnotes**: rendered as an end-of-chapter section, no body linking. With
  `--exclude footnotes` they are dropped entirely.
- **Fonts/CSS**: one standard stylesheet shipped with the exporter. No
  per-book font decisions.
- **Re-export is cheap by construction**: editing exclusions and re-running
  `foundry export` touches no upstream stage — no re-scan, no re-inference.
  This is the pdf-picker interaction (delete boxes → instant reflow).

## BookForge's consumption

BookForge shells into the CLI per stage (or `convert` end-to-end), then reads
the run directory: paints pdf-picker's category layer from `blocks/blocks.json`,
lets the user delete boxes, writes the block-id exclusion list, and invokes
`foundry export`. BookForge never re-implements pipeline logic; where it has
its own legacy implementation today, the migration plan (MIGRATION.md) retires
it after parity is proven.

## The other shape: the working document

Everything above is the run directory, and it is still the contract for the
stage-by-stage path. Foundry also has a **document mode**, whose rule is that
every stage is document-in → document-out: the words, the categories and the
deletions all live in a working PDF, and `foundry reflow` builds the book from
that file alone. See [`DOCUMENT_MODES.md`](DOCUMENT_MODES.md).

The two overlap at one stage. `blocks` reads the run directory and, given
`--pdf`, writes its answer into BOTH `blocks/blocks.json` and the document —
the run artifact because BookForge reads it today, the annotations because that
is where the pipeline is going.
