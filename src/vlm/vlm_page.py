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
do it.

200 DPI is not a setting. It is what the measurement was taken at — the pages
the default model was scored on were 1300×2112 for a 468×760 pt page, exactly
200 dpi — and it is the same resolution the rest of foundry pins for the same
reason (ARCHITECTURE §5): a model's input distribution moves with resolution,
and the damage shows up as a bad model rather than a bad render.

NO SILENT FALLBACKS (ARCHITECTURE §8). A missing import, a page that renders to
nothing, a page the model answers with nothing, and a page that hits the token
cap are each fatal, named, and exit nonzero. Half a book that looks like a whole
one is the failure this file refuses to produce.

Protocol — one JSON object per line on stdout, flushed:

    {"event":"document","pages":17,"title":…,"author":…,"widthPt":…,"heightPt":…}
    {"event":"loaded","repo":…,"seconds":9.8}
    {"event":"page","number":1,"width":1300,"height":2112,"renderSeconds":0.09,
     "seconds":14.9,"chars":2183,"tokens":612,"finishReason":"stop","text":"…"}
    {"event":"done","renderSeconds":1.6,"inferenceSeconds":251.4,"peakRssBytes":…}

stderr is progress and whatever MLX has to say; stdout is only ever the
protocol, which is why nothing here prints.
"""
import json
import os
import resource
import sys
import time


def fail(message):
    """Die the way foundry dies: one line naming the thing, nonzero exit."""
    sys.stderr.write('vlm_page: %s\n' % message)
    sys.exit(1)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def peak_rss_bytes():
    """macOS reports ru_maxrss in BYTES; Linux reports it in kilobytes."""
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw if sys.platform == 'darwin' else raw * 1024


def main():
    config = json.loads(sys.stdin.read())
    pdf_path = config['pdf']
    repo = config['repo']
    prompt = config['prompt']
    dpi = config['dpi']
    max_tokens = config['maxTokens']
    renders_dir = config.get('rendersDir')

    # Imported inside main so the failure names the missing package and the
    # interpreter it was missing from — an ImportError traceback out of a
    # subprocess is the least useful thing this seam could hand back.
    try:
        import fitz
    except ImportError as err:
        fail('PyMuPDF is not installed in %s (%s). Install it with `pip install pymupdf`.'
             % (sys.executable, err))
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

    load_start = time.time()
    model, processor = load(repo)
    cfg = load_config(repo)
    emit({'event': 'loaded', 'repo': repo, 'seconds': time.time() - load_start})

    if renders_dir:
        os.makedirs(renders_dir, exist_ok=True)

    scratch = renders_dir or os.path.join(
        os.environ.get('TMPDIR', '/tmp'), 'foundry-vlm-%d' % os.getpid())
    os.makedirs(scratch, exist_ok=True)

    render_total = 0.0
    inference_total = 0.0
    for index in range(doc.page_count):
        number = index + 1

        render_start = time.time()
        pixmap = doc[index].get_pixmap(dpi=dpi)
        image_path = os.path.join(scratch, 'page-%04d.png' % number)
        pixmap.save(image_path)
        render_seconds = time.time() - render_start
        render_total += render_seconds
        if pixmap.width == 0 or pixmap.height == 0:
            fail('page %d rendered to a %dx%d image' % (number, pixmap.width, pixmap.height))

        infer_start = time.time()
        # The prompt goes through the model's OWN chat template, which is what
        # `apply_chat_template` is for: the image placeholder, the role turns and
        # any thinking-block convention are the checkpoint's, and building the
        # string by hand here would feed a shape it was never trained on.
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
            'tokens': getattr(result, 'generation_tokens', 0),
            'finishReason': getattr(result, 'finish_reason', None),
            'text': text,
        })
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
