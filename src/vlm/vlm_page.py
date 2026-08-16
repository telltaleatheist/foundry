#!/usr/bin/env python3
"""vlm_page — the Python half of `foundry vlm-convert`.

Foundry is TypeScript compiled to one standalone binary (ARCHITECTURE §1), and
a vision model on Apple silicon is MLX, which is Python. So this mode is the one
place foundry shells out to an interpreter, and the seam is drawn to be as thin
as a seam can be: ONE process for a whole book, a JSON config in on stdin, one
JSON object per page out on stdout.

ONE PROCESS, NOT ONE PER PAGE. Loading a 3B 8-bit model costs about ten seconds
and every page after the first costs nothing extra; a per-page spawn would pay
that ten seconds seventeen times on a seventeen-page book and fifty minutes of
it on a real one. The cost of holding the model is that this script owns the
whole run, which is why it reports progress per page rather than at the end.

RASTERISATION HAPPENS HERE, in PyMuPDF, and that is a decision rather than a
convenience. Foundry's pdf.js is loaded with a DELIBERATELY BROKEN DOMMatrix
(`src/pdf/runtime.ts`): the library is embedded for text extraction only, its
canvas layer cannot survive `bun build --compile`, and every drawing method on
the shim throws so that a rendering path fails loudly instead of drawing with an
identity transform. There is no rasteriser on the TypeScript side to reuse. The
page image is already crossing this seam, so it is rendered on the side that can
do it — and so is the other pixel job this mode has, for the same reason: the
crop that turns a Picture block into a picture. The grayscale raster below is a
third that has outlived its reader; see `grayscale` in `src/vlm/bridge.ts`.

200 DPI is not a setting. It is what the measurement was taken at — the pages
the models were scored on were 1300×2112 for a 468×760 pt page, exactly 200 dpi
— and it is the same resolution the rest of foundry pins for the same reason
(ARCHITECTURE §5): a model's input distribution moves with resolution, and the
damage shows up as a bad model rather than a bad render.

THE PIXEL BUDGET IS THE MODEL'S COORDINATE SYSTEM. A model that answers with
boxes answers in the frame its processor resized the page to, so `maxPixels` is
not a performance knob that can be set here and forgotten: whatever is set here
is what the TypeScript side must scale the boxes with. It is therefore passed IN
rather than chosen here, and a processor that will not accept it is a failure
rather than a silent ignore.

NO SILENT FALLBACKS (ARCHITECTURE §8). A missing import, a page that renders to
nothing, a processor that cannot be told its budget, and a crop that lands
outside its page are each fatal, named, and exit nonzero. Half a book that looks
like a whole one is the failure this file refuses to produce.

A PAGE IN `excludePages` IS NOT PART OF THE BOOK. It is not rasterised, not
read and not emitted — `--skip-pages`, the deletions somebody made in a picker,
arriving as a list rather than as a re-written PDF so that the file's sha256
(and with it the readings cache) survives the curation. Every page that does
survive keeps its own page number; nothing is renumbered around the gap.

Four modes, one script:

    read       render every page and read it with the model  (the MLX path)
    render     render every page and read none of them       (the endpoint path)
    crop       cut named boxes out of named pages            (Picture blocks)
    textlayer  report every text span the PDF itself carries (facsimile sizing)

Protocol — one JSON object per line on stdout, flushed:

    {"event":"document","pages":17,"title":…,"author":…,"widthPt":…,"heightPt":…}
    {"event":"loaded","repo":…,"seconds":9.8,"maxPixels":2000000}
    {"event":"page","number":1,"width":1300,"height":2112,"renderSeconds":0.09,
     "seconds":14.9,"chars":2183,"tokens":612,"finishReason":"stop",
     "skipped":false,"text":"…"}
    {"event":"crop","name":"p0005-0.png","path":"…/crops/p0005-0.png"}
    {"event":"done","renderSeconds":1.6,"inferenceSeconds":251.4,"peakRssBytes":…}

stderr is progress and whatever MLX has to say; stdout is only ever the
protocol, which is why nothing here prints.
"""
import json
import os
# Unix only. Windows has no `resource`, and this mode reaches Windows through
# --vlm-endpoint: the model runs on a server (vLLM), while the PAGES are still
# rendered here, by this script, in PyMuPDF. Imported conditionally rather than
# guarded at the call site so the absence is stated once, next to the reason.
try:
    import resource
except ModuleNotFoundError:  # pragma: no cover - platform-dependent
    resource = None
import sys
import time

# The protocol channel is the REAL stdout, held privately — and file
# descriptor 1 is then pointed at stderr. This is not decoration: MuPDF's C
# library writes its warnings to fd 1 DIRECTLY, below Python, and one such
# line ("MuPDF error: ...") in the middle of the event stream fails the whole
# run at the bridge's JSON parser (QAnon book, 2026-08-11: 276/276 pages
# rendered, then the summary line arrived corrupted). After this swap, nothing
# in this process — not fitz, not a native library, not a stray print — can
# reach the protocol except emit().
_protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())


def fail(message):
    """Die the way foundry dies: one line naming the thing, nonzero exit."""
    sys.stderr.write('vlm_page: %s\n' % message)
    sys.exit(1)


def emit(obj):
    _protocol.write(json.dumps(obj, ensure_ascii=False) + '\n')
    _protocol.flush()


def peak_rss_bytes():
    """macOS reports ru_maxrss in BYTES; Linux reports it in kilobytes.

    None where the platform cannot answer. That is a REAL absence and is
    reported as one — a zero would be indistinguishable from a process that
    somehow used no memory, and this number only ever appears in a log line
    about how much the run cost.
    """
    if resource is None:
        return None
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw if sys.platform == 'darwin' else raw * 1024


def import_fitz():
    # Imported inside a function so the failure names the missing package and
    # the interpreter it was missing from — an ImportError traceback out of a
    # subprocess is the least useful thing this seam could hand back.
    try:
        import fitz
    except ImportError as err:
        fail('PyMuPDF is not installed in %s (%s). Install it with `pip install pymupdf`.'
             % (sys.executable, err))
    return fitz


def write_pgm(path, pixmap):
    """The grayscale raster, as the one image format foundry reads with no codec.

    Written by hand rather than through the library's own PGM writer: the
    reader on the other side (`src/scan/pgm.ts`) accepts binary P5 with a
    single whitespace after the header and an 8-bit maxval, and this is the
    nine bytes that guarantees it.

    NOTHING ON THE OTHER SIDE OPENS ONE ANY MORE. It fed the ink test that used
    to decide a page-turn join, and that test is gone — see `grayscale` in
    `src/vlm/bridge.ts` for why this survives one more pass anyway.
    """
    samples = pixmap.samples
    if len(samples) != pixmap.width * pixmap.height:
        fail('a grayscale pixmap of %dx%d carried %d bytes, so its rows are padded and this '
             'writer would mis-shape them' % (pixmap.width, pixmap.height, len(samples)))
    with open(path, 'wb') as out:
        out.write(b'P5\n%d %d\n255\n' % (pixmap.width, pixmap.height))
        out.write(samples)


def cap_pixels(processor, max_pixels):
    """Tell the image processor its budget, or fail naming what it is.

    Every spelling transformers has used is set, because all of them are live in
    the wild: a bare `max_pixels` attribute on the older image processors, a
    plain `size` dict on the next, and a `SizeDict` dataclass with
    `longest_edge` on the current fast ones — which is what
    `mlx-community/dots.ocr-4bit` loads today. At least one has to exist. A
    processor with none of them is a processor whose coordinate frame this
    program cannot predict, and predicting it is the whole point: the number set
    here is the number the TypeScript side scales the model's boxes with.
    """
    image_processor = getattr(processor, 'image_processor', None)
    if image_processor is None:
        fail('the processor has no image_processor, so its pixel budget cannot be set — and '
             'the boxes it answers with could not be scaled back to the render')
    touched = []
    if getattr(image_processor, 'max_pixels', None) is not None:
        image_processor.max_pixels = max_pixels
        touched.append('max_pixels')
    size = getattr(image_processor, 'size', None)
    if isinstance(size, dict):
        for key in ('max_pixels', 'longest_edge'):
            if key in size:
                size[key] = max_pixels
                touched.append('size[%s]' % key)
    elif size is not None:
        for key in ('max_pixels', 'longest_edge'):
            if getattr(size, key, None) is not None:
                setattr(size, key, max_pixels)
                touched.append('size.%s' % key)
    if not touched:
        fail('%s carries no pixel budget under any name this program knows (max_pixels, '
             'size[max_pixels], size[longest_edge]), so %d cannot be applied to it and the '
             'frame its boxes are in cannot be predicted'
             % (type(image_processor).__name__, max_pixels))
    sys.stderr.write('  pixel budget %d applied to %s\n' % (max_pixels, ', '.join(touched)))


def write_png(pixmap, path):
    """A pixmap onto the disk, without betting the run on a Windows delete.

    MuPDF's own writer removes an existing file before it writes, and on
    Windows that remove is refused the moment ANYTHING holds the old file
    open without delete-sharing — the app showing the figure it cropped last
    time, an antivirus pass over it, a sync client. One stale PNG then
    killed an entire read landing (2026-08-16, a re-read over an existing
    project). So the bytes are taken from the pixmap and written beside the
    target, and the finished file is moved over the old one with os.replace,
    which Windows allows in strictly more states than a bare delete. The
    locks that remain are transient by nature, so the move is retried
    briefly — and then the failure is the real one, named, with the file it
    is about.
    """
    data = pixmap.tobytes('png')
    last = None
    for attempt in range(5):
        if attempt > 0:
            time.sleep(0.2)
        # Truncate-and-write first: a reader that shares writing — which is how
        # browsers and viewers open files — permits this even while it blocks
        # every rename onto the name, because Windows keeps a deleted-or-
        # replaced name occupied until the last handle closes.
        try:
            with open(path, 'wb') as out:
                out.write(data)
            return
        except OSError as err:
            last = err
        # A holder that does not share writing may still share deletion; going
        # through a sibling temp file also covers the case where the write
        # above failed midway and the target must be re-made whole.
        tmp = path + '.part'
        try:
            with open(tmp, 'wb') as out:
                out.write(data)
            os.replace(tmp, path)
            return
        except OSError as err:
            last = err
            try:
                os.unlink(tmp)
            except OSError:
                pass
    fail('%s could not be written (%s). Something on this machine is holding the old file '
         'open — a window showing it, a sync client, an antivirus scan. Close it and run '
         'again; the readings are banked, so nothing is read twice.' % (path, last))


def run_crop(config):
    """Cut boxes out of pages, straight from the PDF at the pinned dpi.

    Re-rendered rather than cut out of the page PNG: the crop is a picture that
    goes into somebody's book, the PDF still has it at full fidelity, and a
    second decode of a lossless render to get the same pixels is work for
    nothing.
    """
    fitz = import_fitz()
    pdf_path = config['pdf']
    dpi = config['dpi']
    crops_dir = config['cropsDir']
    os.makedirs(crops_dir, exist_ok=True)

    doc = fitz.open(pdf_path)
    scale = 72.0 / dpi
    for crop in config['crops']:
        number = crop['page']
        if number < 1 or number > doc.page_count:
            fail('a crop names page %d of a %d-page document' % (number, doc.page_count))
        page = doc[number - 1]
        x1, y1, x2, y2 = crop['box']
        rect = fitz.Rect(x1 * scale, y1 * scale, x2 * scale, y2 * scale) & page.rect
        if rect.is_empty:
            fail('the crop for %s on page %d lies outside the page' % (crop['name'], number))
        pixmap = page.get_pixmap(dpi=dpi, clip=rect)
        if pixmap.width == 0 or pixmap.height == 0:
            fail('the crop for %s on page %d rendered to a %dx%d image'
                 % (crop['name'], number, pixmap.width, pixmap.height))
        path = os.path.join(crops_dir, crop['name'])
        write_png(pixmap, path)
        emit({'event': 'crop', 'name': crop['name'], 'path': path})


def run_textlayer(config):
    """Every text span the PDF already carries: where it sits, how big it is.

    A born-digital PDF — and a scan a publisher ran real OCR over, which is
    what JSTOR ships — states the size of every piece of type on every page,
    in points, in its own text layer. That statement is a MEASUREMENT of the
    printed page by whoever set or OCR'd it, and the facsimile route uses it
    to size its type instead of solving sizes back out of the model's boxes
    (`pdf-text.ts`). A pure scan has no layer, emits nothing here, and the
    facsimile falls back on its own measurements; nothing about this mode is
    required for a book to come out.

    One event per page that has spans, spans as compact arrays: centre-x,
    centre-y (points, top-left origin, the displayed page's frame — the same
    frame the renders are made in), font size in points, and how many
    characters the span carries. The characters ride along so the reader can
    take a median WEIGHTED by them: a two-character superscript must not
    outvote the paragraph it annotates.
    """
    fitz = import_fitz()
    doc = fitz.open(config['pdf'])
    for index in range(doc.page_count):
        page = doc[index]
        spans = []
        for block in page.get_text('dict')['blocks']:
            if block.get('type') != 0:
                continue
            for line in block.get('lines', []):
                for span in line.get('spans', []):
                    text = span.get('text', '').strip()
                    size = span.get('size', 0)
                    if not text or size <= 0:
                        continue
                    rect = fitz.Rect(span['bbox'])
                    if page.rotation:
                        # get_text answers in the unrotated page's frame; the
                        # renders — and so the model's boxes — are of the page
                        # as DISPLAYED. One matrix moves the span into the
                        # frame everything else already shares.
                        rect = rect * page.rotation_matrix
                    spans.append([
                        round((rect.x0 + rect.x1) / 2, 2),
                        round((rect.y0 + rect.y1) / 2, 2),
                        round(size, 2),
                        len(text),
                    ])
        if spans:
            emit({'event': 'layer', 'page': index + 1, 'spans': spans})
    emit({'event': 'done'})


def main():
    config = json.loads(sys.stdin.read())
    mode = config.get('mode', 'read')
    if mode == 'crop':
        return run_crop(config)
    if mode == 'textlayer':
        return run_textlayer(config)
    if mode not in ('read', 'render'):
        fail('mode "%s" is not one of read, render, crop, textlayer' % mode)

    pdf_path = config['pdf']
    repo = config['repo']
    prompt = config['prompt']
    dpi = config['dpi']
    max_tokens = config['maxTokens']
    max_pixels = config.get('maxPixels')
    renders_dir = config.get('rendersDir')
    grayscale = config.get('grayscale', False)
    # Two different lists, and the difference is a cache against a curation.
    # `skipPages` are pages whose answer is already banked: still rendered,
    # still reported, just not read. `excludePages` are pages that are not part
    # of the book — `--skip-pages` — and they are not rendered, not read and not
    # reported at all. See src/vlm/pages.ts.
    skip_pages = set(config.get('skipPages') or [])
    exclude_pages = set(config.get('excludePages') or [])

    fitz = import_fitz()
    if mode == 'read':
        try:
            from mlx_vlm import generate, load
            from mlx_vlm.prompt_utils import apply_chat_template
            from mlx_vlm.utils import load_config
        except ImportError as err:
            fail('mlx-vlm is not installed in %s (%s). Install it with `pip install mlx-vlm`.'
                 % (sys.executable, err))

    doc = fitz.open(pdf_path)
    if doc.page_count == 0:
        fail('%s has no pages' % pdf_path)

    # How many pages the document has is known HERE and nowhere earlier, so the
    # two refusals that need that number are made here — before a page is
    # rasterised and before a model is loaded. The syntax of the list was
    # already refused on the TypeScript side (src/vlm/pages.ts); neither
    # refusal exists twice.
    beyond = sorted(p for p in exclude_pages if p > doc.page_count)
    if beyond:
        fail('--skip-pages names %s of a %d-page document'
             % (', '.join('page %d' % p for p in beyond), doc.page_count))
    if len(exclude_pages) >= doc.page_count:
        fail('--skip-pages names every page of the %d-page document, so there would be no book '
             'left to write' % doc.page_count)

    meta = doc.metadata or {}
    first = doc[0].rect
    emit({
        'event': 'document',
        'pages': doc.page_count,
        # Straight from the PDF, empty when the PDF does not say. Nothing here
        # invents a title or an author; the TypeScript side falls back to the
        # filename, which is a FACT about the file rather than a guess about the
        # book.
        'title': (meta.get('title') or '').strip(),
        'author': (meta.get('author') or '').strip(),
        'widthPt': first.width,
        'heightPt': first.height,
    })

    # Is there a page left that this run will actually pay a model for? An
    # excluded page is not in the book and a banked one is already answered, so
    # a run with neither loads nothing at all.
    reads_something = any(
        number not in exclude_pages and number not in skip_pages
        for number in range(1, doc.page_count + 1)
    )

    model = processor = cfg = None
    if mode == 'read' and reads_something:
        load_start = time.time()
        model, processor = load(repo)
        cfg = load_config(repo)
        if max_pixels:
            cap_pixels(processor, max_pixels)
        emit({'event': 'loaded', 'repo': repo, 'seconds': time.time() - load_start,
              'maxPixels': max_pixels})

    if renders_dir:
        os.makedirs(renders_dir, exist_ok=True)

    scratch = renders_dir or os.path.join(
        os.environ.get('TMPDIR', '/tmp'), 'foundry-vlm-%d' % os.getpid())
    os.makedirs(scratch, exist_ok=True)

    render_total = 0.0
    inference_total = 0.0
    for index in range(doc.page_count):
        number = index + 1
        if number in exclude_pages:
            # Not rasterised, not read, not emitted. A page somebody deleted has
            # to cost nothing, which is why this is a `continue` and not a flag
            # on the page event: the bridge counts the pages it was told to
            # expect (see bridge.ts), so a silent omission is still caught.
            sys.stderr.write('  page %d/%d: skipped\n' % (number, doc.page_count))
            continue

        render_start = time.time()
        pixmap = doc[index].get_pixmap(dpi=dpi)
        image_path = os.path.join(scratch, 'page-%04d.png' % number)
        # Through the same writer as the crops: a kept renders directory is
        # overwritten on every re-read, which is the exact exposure.
        write_png(pixmap, image_path)
        if grayscale:
            write_pgm(os.path.join(scratch, 'page-%04d.pgm' % number),
                      fitz.Pixmap(fitz.csGRAY, pixmap))
        render_seconds = time.time() - render_start
        render_total += render_seconds
        if pixmap.width == 0 or pixmap.height == 0:
            fail('page %d rendered to a %dx%d image' % (number, pixmap.width, pixmap.height))

        skipped = mode == 'render' or number in skip_pages
        text = ''
        result = None
        infer_seconds = 0.0
        if not skipped:
            infer_start = time.time()
            # The prompt goes through the model's OWN chat template, which is
            # what `apply_chat_template` is for: the image placeholder, the role
            # turns and any thinking-block convention are the checkpoint's, and
            # building the string by hand here would feed a shape it was never
            # trained on.
            formatted = apply_chat_template(processor, cfg, prompt, num_images=1)
            result = generate(model, processor, formatted, [image_path],
                              max_tokens=max_tokens, temperature=0.0, verbose=False)
            # mlx-vlm has returned both a bare string and a result object across
            # versions; `.text` when it is there, the string when it is not.
            text = (getattr(result, 'text', None) or str(result)).strip()
            infer_seconds = time.time() - infer_start
            inference_total += infer_seconds

        if not renders_dir:
            os.unlink(image_path)

        emit({
            'event': 'page',
            'number': number,
            'width': pixmap.width,
            'height': pixmap.height,
            'renderSeconds': render_seconds,
            'seconds': infer_seconds,
            'chars': len(text),
            'tokens': getattr(result, 'generation_tokens', 0) if result is not None else 0,
            'finishReason': getattr(result, 'finish_reason', None) if result is not None else None,
            'skipped': skipped,
            'text': text,
        })
        if skipped:
            sys.stderr.write('  page %d/%d: rendered\n' % (number, doc.page_count))
        else:
            sys.stderr.write('  page %d/%d: %d chars in %.1fs\n'
                             % (number, doc.page_count, len(text), infer_seconds))

    emit({
        'event': 'done',
        'renderSeconds': render_total,
        'inferenceSeconds': inference_total,
        'peakRssBytes': peak_rss_bytes(),
    })


if __name__ == '__main__':
    main()
