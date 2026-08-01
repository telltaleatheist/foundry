#!/usr/bin/env python3
"""
scan-make-fixtures.py — build the band-segmenter fixture set and its reference
answers from the ORIGINAL Python implementation.

The TypeScript port of `bands.py` is verified the only way a geometry port can
be: both implementations run over the same page renders and the emitted boxes
are diffed box-for-box (MIGRATION.md §6, "Port protocol"). This script produces
the two halves of that comparison:

    fixtures/scan/pages/<book>-p<N>.pgm      the page, as a raw grayscale raster
    fixtures/scan/reference/<book>-p<N>.json bands.py's answer for that raster

PGM (P5) is the fixture format because it IS the raster — no codec sits between
the fixture and either implementation, so a fixture cannot drift because a PNG
library changed. The reference run reads the same pixels: the render is put
through `Image.convert("L")` ONCE here, and both the .pgm and the temporary
.png handed to bands.py are written from that one array.

    python3 tools/scan-make-fixtures.py [--lab DIR] [--bands PATH] [--out DIR]

Needs the ocr-lab renders and BookForgeApp's bands.py, so it is a regeneration
tool, not part of the test run. The committed fixtures are its output.
"""

import argparse
import importlib.util
import json
import os
import sys
import tempfile

import numpy as np
from PIL import Image

DEFAULT_LAB = "/Volumes/Callisto/training/ocr-lab"
DEFAULT_BANDS = "/Volumes/Callisto/Projects/BookForgeApp/tools/ocr-lab/bands.py"

# The fixture set. Pages are chosen to exercise the paths that the geometry
# actually turns on, not to be a random sample: each line says what it is for,
# and several are the very pages the comments in bands.py cite as the reason a
# rule exists.
FIXTURES = [
    ("deathstalker", 100, "ordinary body page, straight book (deskewDeg 0.0)"),
    ("deathstalker", 1, "front matter: display type, tall bands, high missed coverage"),
    ("deathstalker", 64, "tightBox's case: one stray ink pixel in the right margin"),
    ("deathstalker", 176, "edgeStrip's case: a dark blob nine columns in from the left edge"),
    ("deathstalker", 521, "orphan rescue: a short last line that never clears the ink threshold"),
    ("deathstalker-rebellion", 295, "the book's largest tilt (+0.950 deg) - deskew, bicubic rotate, deskewRect"),
    ("deathstalker-rebellion", 108, "a NEGATIVE tilt (-0.300 deg): Python's %% takes the divisor's sign"),
    ("deathstalker-rebellion", 103, "heaviest edge trim in the book (47k ink px) - blindToType under load"),
    ("michelle-remembers", 100, "a different book: 33%% larger type, fainter scan, self-derived thresholds"),
    ("was-hitler-an-atheist", 4, "two columns - findGutter's accepted branch"),
]


def load_bands_module(path):
    spec = importlib.util.spec_from_file_location("ocrlab_bands", path)
    if spec is None or spec.loader is None:
        raise SystemExit("cannot import bands.py from %s" % path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ocrlab_bands"] = mod
    spec.loader.exec_module(mod)
    return mod


def write_pgm(path, arr):
    h, w = arr.shape
    with open(path, "wb") as fh:
        fh.write(b"P5\n%d %d\n255\n" % (w, h))
        fh.write(arr.astype(np.uint8).tobytes())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lab", default=DEFAULT_LAB)
    ap.add_argument("--bands", default=DEFAULT_BANDS)
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "scan"))
    args = ap.parse_args(argv)

    bands = load_bands_module(args.bands)
    pages_dir = os.path.join(args.out, "pages")
    ref_dir = os.path.join(args.out, "reference")
    os.makedirs(pages_dir, exist_ok=True)
    os.makedirs(ref_dir, exist_ok=True)

    manifest = []
    total = 0
    with tempfile.TemporaryDirectory(prefix="foundry-scan-fixtures-") as tmp:
        for book, page, why in FIXTURES:
            src = os.path.join(args.lab, book, "renders", "page-%d.png" % page)
            if not os.path.exists(src):
                raise SystemExit("missing render: %s" % src)
            gray = np.asarray(Image.open(src).convert("L"), dtype=np.uint8)
            name = "%s-p%d" % (book, page)

            # The PGM and the PNG bands.py reads are written from the SAME array,
            # so "same input" is a fact rather than an assumption about decoders.
            pgm_path = os.path.join(pages_dir, name + ".pgm")
            write_pgm(pgm_path, gray)
            png_path = os.path.join(tmp, "page-%d.png" % page)
            Image.fromarray(gray, mode="L").save(png_path)

            result = bands.process_page(png_path, page)
            with open(os.path.join(ref_dir, name + ".json"), "w") as fh:
                json.dump(result, fh, indent=1, sort_keys=True)

            size = os.path.getsize(pgm_path)
            total += size
            manifest.append({
                "name": name, "book": book, "page": page, "why": why,
                "widthPx": result["widthPx"], "heightPx": result["heightPx"],
                "bands": len(result["bands"]),
                "deskewDeg": result["deskewDeg"],
                "columns": result["columns"],
                "pgmBytes": size,
            })
            print("%-32s %4dx%4d  %4d bands  deskew %+.3f  cols %d  %.1f MB"
                  % (name, result["widthPx"], result["heightPx"], len(result["bands"]),
                     result["deskewDeg"], result["columns"], size / 1e6))

    with open(os.path.join(args.out, "fixtures.json"), "w") as fh:
        json.dump({"generatedBy": "tools/scan-make-fixtures.py",
                   "bandsPy": args.bands,
                   "lab": args.lab,
                   "fixtures": manifest}, fh, indent=1)
    print("\n%d fixtures, %.1f MB of PGM" % (len(manifest), total / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
