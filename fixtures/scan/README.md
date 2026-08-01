# Scan fixtures — the band segmenter's port verification

`src/scan/bands.ts` is a port of `tools/ocr-lab/bands.py` in BookForgeApp.
MIGRATION.md §6 defines when such a port is finished:

> Run `bands.py` and `bands.ts` over the same fixture renders and diff the
> emitted JSON box-for-box. The port is done when they agree on every page of
> the fixture set, and not before.

This directory is that fixture set.

```
pages/<name>.pgm       the page as a raw 8-bit grayscale raster (binary PGM, P5)
reference/<name>.json  what bands.py emitted for that raster
fixtures.json          provenance + what each page is for
```

`test/scan/bands.fixture.test.ts` reads both sides and compares **every field
exactly** — content rect, all page stats, `deskewDeg`, and every band's tight
box, crop box and tall flag. **No tolerance is used anywhere.** None was needed:
all ten pages agree exactly, integer for integer, including the two that are
rotated before profiling.

Regenerate with `python3 tools/scan-make-fixtures.py` (needs the ocr-lab renders
and BookForgeApp's `bands.py`; both are developer-machine paths, which is why
the outputs are committed and the inputs are not).

## Why PGM

The raster with a nine-byte header and no codec. `bands.ts` takes a plain
`{width, height, data}` and owns no image decoder, so the fixtures cannot drift
because a PNG library changed, and the reader is thirty lines of arithmetic.
The generator puts each render through `Image.convert("L")` **once** and writes
both the `.pgm` and the temporary `.png` that `bands.py` reads from that one
array — so "both implementations saw the same pixels" is a fact about the
generator, not an assumption about two decoders agreeing.

Cost: 11.8 MB. That is the price of a port whose correctness is checkable
rather than argued.

## The pages, and what each is for

All renders are 200 dpi (ARCHITECTURE §5 — the pin), from
`/Volumes/Callisto/training/ocr-lab/<book>/renders/page-<N>.png`.
Page numbers are 0-indexed, as everything in ocr-lab is (`page-N` = PDF page N+1).

| fixture | size | bands | deskew | what it is for |
|---|---|---|---|---|
| `deathstalker-p100` | 787×1289 | 45 | 0.000 | ordinary body page of a straight book — the common case |
| `deathstalker-p1` | 781×1289 | 21 | 0.000 | front matter: display type, tall-band flag, high missed coverage |
| `deathstalker-p64` | 795×1289 | 44 | 0.000 | `tightBox`'s reason: one stray ink pixel in the right margin used to widen a nine-word line to the full measure |
| `deathstalker-p176` | 787×1289 | 44 | 0.000 | `edgeStrip`'s reason: a dark blob starting nine columns in, which `walk` cannot reach |
| `deathstalker-p521` | 778×1289 | 43 | 0.000 | orphan rescue: a short last line that never clears the ink threshold |
| `deathstalker-rebellion-p295` | 739×1259 | 44 | **+0.950** | the tilted sibling's largest tilt — deskew estimate, bicubic rotate, `deskewRect` |
| `deathstalker-rebellion-p108` | 732×1257 | 44 | **−0.300** | a NEGATIVE angle: Python's `%` takes the divisor's sign, so `-0.3 % 360` is `359.7` and its radians are a different double |
| `deathstalker-rebellion-p103` | 732×1257 | 34 | 0.000 | the book's heaviest edge trim (47k ink px) — `blindToType` under load |
| `michelle-remembers-p100` | 1075×1720 | 27 | 0.000 | a different book: 33% larger type, fainter scan, every threshold self-derived |
| `was-hitler-an-atheist-p4` | 1200×1800 | 22 | 0.000 | two columns — `findGutter`'s accepted branch and the per-column banding |

Four of these are the very pages `bands.py`'s comments cite as the reason a rule
exists. That is deliberate: a fixture set of ordinary pages proves the ordinary
path and nothing else, and every rule in that file was bought with a specific
page.

## `ocr/` — the reference for the Tesseract invocation

`ocr/<name>.json` is what BookForge's `run-book.py` read for the same page: one
tesseract per page over an image list, `--psm 7`, TSV, a `--psm 13` rescue for a
crop that read as nothing. `test/scan/tesseract.test.ts` compares text,
confidence and *which psm produced each line*, so the port of the invocation is
held to the same standard as the port of the geometry. Those cases skip — by
name, loudly — when no verified Tesseract is vendored for the platform.

## Beyond the committed ten

The ten pages here are what a checkout can re-verify. During the port a wider
sweep ran the same comparison over **61 further pages across seven books**
(deathstalker, deathstalker-rebellion, michelle-remembers, was-hitler-an-atheist,
gods-people, understanding-jehovahs-witnesses, rise-and-fall) — 2,299 bands, and
**zero disagreements**, including every deskewed page in the sample. Those pages
are not committed because they are another 60 MB of raster and they proved a
point rather than guarding one. Re-run it by pointing
`tools/scan-make-fixtures.py` at a longer list.

One page in that sweep, `understanding-jehovahs-witnesses` page 316, is refused
by `bands.py` with *"no ink found after border masking"*. `bands.ts` refuses it
the same way, with the page number attached. That contract is tested directly in
`test/scan/bands.contract.test.ts`.

## What the port had to reproduce, and what it caught

The geometry is arithmetic, so the port is arithmetic — including numpy's and
Pillow's, which is where the two implementations actually disagreed:

- **Python's `round()` is half-to-EVEN.** `int(round(0.5 * pitch))` ties on
  every odd line pitch, and `Math.round(12.5)` is 13 where Python's is 12.
- **`np.median` is the mean of the middle two**, which is not the same rounding
  as `np.percentile(x, 50)`. bands.py uses both, in different places.
- **Pillow's `resize` coefficients and its float32 intermediate**, because the
  local paper tone is compared with `<` against integer pixel values and a
  last-ulp difference flips a pixel between paper and ink.
- **Pillow's BICUBIC affine is the a = −1 cubic in COEFFICIENT form**, not the
  Catmull-Rom a = −0.5 of its resample path, and not a sum of four kernel
  weights. The weighted-sum spelling is the same function on paper; in floating
  point a flat run of four identical samples returns `V * 0.9999999999999998`,
  which truncates one level dark. That was 8.6% of a rotated page's pixels and
  it moved two band boxes — caught by these fixtures, not by reading the code.
