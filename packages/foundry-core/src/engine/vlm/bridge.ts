/**
 * vlm/bridge — the seam between a read and the page rasteriser.
 *
 * The pages of a book are rendered in-process on MuPDF (`raster.ts`), and this
 * module turns that into pages while reporting each one as it lands. It was
 * the seam to `vlm_page.py` — one Python subprocess per book, which also read
 * the pages with MLX. That local reader is RETIRED (Owen, 2026-11-04: Foundry
 * ships with Crucible and every model call goes to Crucible), and with it the
 * interpreter. What lives here is still everything that must FAIL rather than
 * be accepted:
 *
 *  - **the rasteriser refuses** — a page that renders to nothing, a skip list
 *    naming pages the document does not have — and its sentence is the message
 *  - **a page hit the token cap** (`finishReason === 'length'`) — the model was
 *    still writing when it was cut off, so that page is TRUNCATED. Half a page
 *    reads as a whole one in the finished book
 *  - **a page came back empty** — a blank page in a book is a claim, and a
 *    model that answered with nothing did not make it
 *  - **the pages do not arrive once each, in order** — a page named by
 *    `excludePages` is expected NOT to arrive; every other page of the
 *    document is, exactly once, in ascending order
 *
 * The middle two judge an ANSWER and a rendering produces none: every page
 * this module returns is `skipped` (rendered, not read), and the endpoint pass
 * (`endpoint.ts`) or the bank supplies the text. They stay because the shapes
 * they guard are the ones the read path is built on.
 *
 * A run that would have to READ a page here — no endpoint, and a page with no
 * banked answer — is refused by name before a page is rendered.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { VlmModelDef } from './models.js';
import { cropPages, readTextLayer, RasterError, renderPages } from './raster.js';

export class VlmBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmBridgeError';
  }
}

/**
 * The pixel budget the MLX path handed the processor, and it is a measurement.
 *
 * The MLX reader is retired; the number is not. It is the frame every box a
 * local read banked was measured in, and a bank old enough to record no budget
 * of its own is rescaled with it (`blocks-dump.ts`).
 *
 * dots.ocr's own processor allows 11,289,600 pixels, which at 200 dpi means a
 * page is passed through untouched — and costs about twice as long per page on
 * this machine as the same page capped here, with no difference anybody could
 * see in the text or in the boxes. So the MLX path caps it, and the SAME number
 * goes to the dialect: the model answers in the frame the processor resized to,
 * and a box scaled with the wrong budget is a few per cent out everywhere.
 *
 * The endpoint path does NOT cap. A vLLM server was started with a processor
 * config and this program did not choose it; the model's own cap is the honest
 * assumption there, and it makes the scale 1.0 at 200 dpi.
 */
export const MLX_MAX_PIXELS = 2_000_000;

/** One page, as the model and the rasteriser measured it. */
export interface VlmPage {
  number: number;
  /** Rendered pixel size, at the pinned dpi. */
  width: number;
  height: number;
  renderSeconds: number;
  /** Inference only — the render is separate because they scale differently. */
  seconds: number;
  chars: number;
  tokens: number;
  finishReason: string | null;
  /** The model's answer, verbatim, in its own dialect. Empty when not read. */
  text: string;
  /**
   * The page was rendered and NOT read — either its answer was already on disk
   * (`--readings`) or this run only wanted the render (the endpoint path).
   * Never a failure, and never confused with one: an unreadable page is in
   * `VlmRunResult.unreadable`, by name.
   */
  skipped: boolean;
}

/** A page the model could not usefully answer for. Always carries a reason. */
export interface VlmUnreadablePage {
  number: number;
  reason: string;
}

/** What the PDF says about itself, before a model has seen a page of it. */
export interface VlmDocumentInfo {
  pages: number;
  /** Empty when the PDF does not carry one. Never invented. */
  title: string;
  author: string;
  widthPt: number;
  heightPt: number;
  /**
   * The canonical render size this run snapped near-identical pages onto, in
   * render pixels — the "mode" the rasteriser computed over every page's true size,
   * or was handed for a resume. NULL where nothing was snapped: a page-image
   * source, or a PDF with no pages left after exclusions. See the render snap in
   * `raster.ts`. Optional because a mock carries no field.
   */
  renderMode?: readonly [number, number] | null;
}

export interface VlmRunResult {
  document: VlmDocumentInfo;
  pages: VlmPage[];
  /** Empty unless `unreadablePages: 'record'` — see the option. */
  unreadable: VlmUnreadablePage[];
  /** Process start through model resident — 0 now that nothing is loaded here. */
  loadSeconds: number;
  renderSeconds: number;
  inferenceSeconds: number;
  /**
   * The engine process's peak resident set in bytes (`process.resourceUsage`),
   * now that the pages are rendered in it rather than in a helper. Null where
   * the platform cannot answer — never 0, which would read as a run that used
   * no memory.
   */
  peakRssBytes: number | null;
}

/**
 * WHERE A READ'S PAGES COME FROM.
 *
 * Owen's ruling, 2026-08-20: a capture project's product is its PAGES, and a
 * PDF is something somebody exports on purpose. The mint used to wrap each
 * photograph in a PDF page at the photograph's own size, and this bridge then
 * asked the helper to rasterise that wrapper back into an image -- a decode and
 * a re-encode of the same JPEG, to arrive where it started.
 *
 * Both kinds answer the same questions and produce the same page events, so
 * nothing downstream of the rasteriser's page source knows which one it read. See
 * docs/CAPTURE.md, "The mint's output is PAGES".
 */
export type VlmSource =
  /** A document to rasterise, at `dpi`. */
  | { readonly kind: 'pdf'; readonly path: string }
  /**
   * Pages that are already pictures, IN READING ORDER. The order is the
   * caller's and is never re-derived here: page N of the book is `paths[N - 1]`,
   * which is the one-based-against-zero-based seam and the only place it exists.
   */
  | { readonly kind: 'pages'; readonly paths: readonly string[] };

/**
 * The pages in a directory, IN READING ORDER.
 *
 * Sorted NUMERICALLY on the first run of digits in the name, so `page-2` sorts
 * before `page-10` — the trap a plain name sort walks into, and the reason the
 * writer's zero-padding is a courtesy rather than a contract this depends on.
 * Names with no digits fall back to name order, together, after the numbered
 * ones: an unnumbered file in a pages directory is not a page anybody planned,
 * and putting it last is quieter than guessing where it belongs.
 */
export function pagesInDirectory(dir: string): string[] {
  const named = fs.readdirSync(dir)
    .filter((name) => PAGE_IMAGE.test(name))
    .map((name) => ({ name, at: /\d+/.exec(name) }));
  named.sort((a, b) => {
    if (a.at !== null && b.at !== null && a.at[0] !== b.at[0]) {
      return Number(a.at[0]) - Number(b.at[0]);
    }
    if ((a.at === null) !== (b.at === null)) return a.at === null ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return named.map((one) => path.join(dir, one.name));
}

/** What this build can hand a model as a page. Matches the rasteriser's loader. */
const PAGE_IMAGE = /\.(jpe?g|png|tiff?|bmp|webp)$/i;

/** What a source is called when something has to say so in a sentence. */
export function sourceName(source: VlmSource): string {
  return source.kind === 'pdf' ? source.path : `${source.paths.length} page image(s)`;
}

export interface VlmRunOptions {
  source: VlmSource;
  model: VlmModelDef;
  dpi: number;
  /** Keep the page renders here instead of deleting them. */
  rendersDir?: string;
  /**
   * The processor's pixel budget for this run. Absent means the model's own,
   * which is what the model card says and what a server would use.
   */
  maxPixels?: number;
  /**
   * The book's canonical render size to snap near-identical pages onto, from an
   * EARLIER run of this same book — recorded beside the readings bank, keyed by
   * the PDF's sha (`readings.ts`). Absent on a first run: the rasteriser computes the
   * mode itself and reports it in the document event, and the caller records it.
   * Present on a RESUME so the resumed run snaps to the SAME grid rather than
   * recomputing the mode off a different page subset. Ignored for a page-image
   * source, which is never snapped. It changes only the page box a snapped page
   * is rendered to — never dpi, never `maxPixels`.
   */
  renderMode?: readonly [number, number];
  /**
   * Collapse near-identical pages onto ONE render grid — the snap.
   *
   * OPT-IN, because not every render wants it: `blocks-dump` re-measures a page
   * to recover the TRUE frame an old bank's boxes were measured in, and snapping
   * there would hand it a frame the model never saw. The bank-producing route
   * (`read.ts`) sets it; the rasteriser then either snaps to `renderMode` when one is
   * given or computes the book's mode and snaps to that. Ignored for a page-image
   * source and when `renderMode` is given (an explicit mode is itself the ask).
   */
  snap?: boolean;
  /**
   * Render every page and read NONE of them — no model is loaded at all.
   *
   * The endpoint path (`endpoint.ts`) does its own inference over HTTP but
   * still needs the pages rasterised, as does a replay of a bank. Without it a
   * run with a page to read is refused: the local reader is retired.
   */
  renderOnly?: boolean;
  /**
   * Also write a grayscale PGM beside each PNG.
   *
   * IT HAS NO READER LEFT, and that is written down rather than quietly true.
   * It was written for the ink test: the dots dialect measured the ink in a
   * page's render to decide a page-turn join, and PGM is the one raster format
   * foundry reads with no decoder (`scan/pgm.ts`). The join is the bank's
   * answer now and samples no pixel at all (`dots-book.ts`), so nothing on this
   * side opens one of these files.
   *
   * Kept for one more pass because taking it out is not this pass's change:
   * it alters what a
   * run leaves behind under `--renders`, which is a directory somebody may be
   * looking at. Whoever removes it should remove `src/scan/pgm.ts` in the same
   * breath — that module's last caller went with the ink test too.
   */
  grayscale?: boolean;
  /**
   * Pages whose answers are already in hand. Rendered, never inferred.
   *
   * NOT `excludePages`, and the difference is the difference between a cache
   * and a curation: a page in this list is still part of the book and still
   * arrives, it just costs no GPU.
   */
  skipPages?: readonly number[];
  /**
   * Pages that are not part of the book at all — `--skip-pages`.
   *
   * Never rasterised, never read, never reported: a page somebody deleted in a
   * picker costs nothing, which is the entire point of passing the deletions
   * rather than converting a physically-subsetted PDF (see `pages.ts`). Such a
   * page never appears in `VlmRunResult.pages`, and the pages that survive
   * keep their true PDF numbers rather than being renumbered around the gap.
   */
  excludePages?: readonly number[];
  /**
   * What an unusable page does: stop the run, or be recorded and carried on
   * past.
   *
   * `stop` is the default and the rule for the markdown dialects: their answer
   * is prose, a short page is invisible in the finished book, and the run has
   * to fail where a person can see it. `record` is for a dialect whose answer
   * is per-page structured data that a report can name and a cached re-read can
   * repair — see the header of `dots.ts`.
   */
  unreadablePages?: 'stop' | 'record';
  /** Called as each page lands, for progress. */
  onPage?: (page: VlmPage, total: number) => void;
  onLoaded?: (seconds: number) => void;
  /**
   * The document event, as it lands — before a single page is rendered.
   *
   * The caller records `renderMode` HERE, not at the end of the run, so that
   * even an interrupted first read leaves the snap size on disk for the resume
   * that follows it (`readings.ts`).
   */
  onDocument?: (document: VlmDocumentInfo) => void;
}

/** Render every page of the source; read none of them. */
export async function readPagesWithVlm(opts: VlmRunOptions): Promise<VlmRunResult> {
  const source = opts.source;
  if (source.kind === 'pdf') {
    if (!fs.existsSync(source.path)) {
      throw new VlmBridgeError(`no such PDF: ${source.path}`);
    }
  } else {
    if (source.paths.length === 0) {
      throw new VlmBridgeError('a read of page images was given no pages');
    }
    // Named one at a time rather than counted: a run that dies on page 300 of a
    // capture project should say WHICH photograph went missing, because that is
    // the file the person has to go and find.
    const gone = source.paths.find((one) => !fs.existsSync(one));
    if (gone !== undefined) {
      throw new VlmBridgeError(`no such page image: ${gone}`);
    }
  }

  let document: VlmDocumentInfo | null = null;
  const pages: VlmPage[] = [];
  const banked = new Set(opts.skipPages ?? []);
  const excluded = new Set(opts.excludePages ?? []);
  let renderSeconds: number;
  try {
    ({ renderSeconds } = await renderPages({
      source: source.kind === 'pdf'
        ? { kind: 'pdf', path: path.resolve(source.path) }
        : { kind: 'pages', paths: source.paths.map((one) => path.resolve(one)) },
      dpi: opts.dpi,
      ...(opts.rendersDir ? { rendersDir: path.resolve(opts.rendersDir) } : {}),
      grayscale: opts.grayscale === true,
      excludePages: [...excluded],
      ...(opts.renderMode !== undefined ? { renderMode: opts.renderMode } : {}),
      snap: opts.snap === true,
      onDocument: (info) => {
        // Known only now, with the document open: is there a page this run
        // would have to READ? That was the MLX reader's job, and it is retired.
        if (opts.renderOnly !== true) {
          for (let page = 1; page <= info.pages; page += 1) {
            if (!excluded.has(page) && !banked.has(page)) {
              throw new VlmBridgeError(
                `page ${page} has no answer and nothing on this machine can read it: the local MLX reader is `
                + 'retired, and every page is read by a Crucible. Pass --vlm-endpoint <url> (a Crucible\'s OpenAI '
                + 'door), or set backend.mode to "endpoint" with backend.endpointUrl.',
              );
            }
          }
        }
        document = info;
        opts.onDocument?.(info);
      },
      onPage: (rendered) => {
        const page: VlmPage = {
          number: rendered.number,
          width: rendered.width,
          height: rendered.height,
          renderSeconds: rendered.renderSeconds,
          seconds: 0,
          chars: 0,
          tokens: 0,
          finishReason: null,
          text: '',
          skipped: true,
        };
        pages.push(page);
        opts.onPage?.(page, document?.pages ?? 0);
      },
    }));
  } catch (err) {
    if (err instanceof RasterError) throw new VlmBridgeError(err.message);
    throw err;
  }

  if (!document) throw new VlmBridgeError('the rasteriser finished without describing the document');
  const doc: VlmDocumentInfo = document;

  /*
   * The pages this run was ever going to be about, in order: `1..doc.pages`
   * with the `--skip-pages` gaps taken out — and the gaps are what the checks
   * are stated against, because a rasteriser that silently dropped page nine
   * and one that was TOLD to drop page nine produce exactly the same stream.
   */
  const expected: number[] = [];
  for (let page = 1; page <= doc.pages; page += 1) {
    if (!excluded.has(page)) expected.push(page);
  }

  if (pages.length !== expected.length) {
    throw new VlmBridgeError(
      excluded.size === 0
        ? `the PDF has ${doc.pages} pages and the rasteriser reported ${pages.length} of them`
        : `the PDF has ${doc.pages} pages with ${excluded.size} skipped, so ${expected.length}`
          + ` were expected and the rasteriser reported ${pages.length}`,
    );
  }

  const record = opts.unreadablePages === 'record';
  const unreadable: VlmUnreadablePage[] = [];
  const usable: VlmPage[] = [];
  for (const [index, page] of pages.entries()) {
    if (page.number !== expected[index]) {
      throw new VlmBridgeError(
        `pages arrived out of order: expected page ${expected[index]}, got page ${page.number}`,
      );
    }
    // A skipped page was never offered to the model on this run, so nothing
    // about its answer is this run's to judge.
    if (page.skipped) { usable.push(page); continue; }

    const truncated = page.finishReason === 'length'
      ? `it hit the ${opts.model.maxTokens}-token cap, so the model was still writing when it was`
        + ' cut off. That page is truncated and the book would be missing the end of it with'
        + ' nothing to show for it.'
      : null;
    const empty = page.text.trim().length === 0
      ? `it came back empty from ${opts.model.id}. A blank page in a book is a claim about the`
        + ' source, and nothing here can make it.'
      : null;
    const reason = truncated ?? empty;
    if (reason === null) { usable.push(page); continue; }
    if (!record) throw new VlmBridgeError(`page ${page.number}: ${reason}`);
    unreadable.push({ number: page.number, reason });
  }

  const maxRss = process.resourceUsage().maxRSS;
  return {
    document: doc,
    pages: usable,
    unreadable,
    loadSeconds: 0,
    renderSeconds,
    inferenceSeconds: 0,
    peakRssBytes: Number.isFinite(maxRss) && maxRss > 0 ? maxRss * 1024 : null,
  };
}


// ── cropping a picture out of a page ────────────────────────────────────────

/** One picture to cut out of a page render, in render pixels. */
export interface VlmCropRequest {
  page: number;
  box: { x1: number; y1: number; x2: number; y2: number };
  /** The file name it gets, inside the container. */
  name: string;
}

export interface VlmCropResult {
  name: string;
  mediaType: string;
  data: Uint8Array;
}


/**
 * Cut the pictures out of the renders.
 *
 * The boxes are not known until the pages have been parsed, which is why this
 * cannot be folded into the render pass.
 *
 * IT TAKES A `VlmSource`, THE SAME ONE A READ TAKES, and that is the whole of
 * what Wave 37 changed here. A crop is pixels out of a page, a page is either a
 * leaf of a document or a photograph somebody took, and this had only ever
 * believed the first — so a captured book, whose archive IS its pages, reflowed
 * with nothing to cut and refused every one of its figures at export. The same
 * page sources the render builds are built here, so the pixels a crop is taken
 * from are the pixels the model was shown (`cropPages`, raster.ts, says what a
 * box means in each face).
 */
export async function cropPageRenders(opts: {
  source: VlmSource;
  dpi: number;
  cropsDir: string;
  requests: readonly VlmCropRequest[];
}): Promise<VlmCropResult[]> {
  if (opts.requests.length === 0) return [];
  const written: { name: string; path: string }[] = [];
  try {
    await cropPages({
      source: opts.source.kind === 'pdf'
        ? { kind: 'pdf', path: path.resolve(opts.source.path) }
        : { kind: 'pages', paths: opts.source.paths.map((page) => path.resolve(page)) },
      dpi: opts.dpi,
      cropsDir: path.resolve(opts.cropsDir),
      crops: opts.requests.map((r) => ({ page: r.page, name: r.name, box: [r.box.x1, r.box.y1, r.box.x2, r.box.y2] as const })),
      onCrop: (name, file) => written.push({ name, path: file }),
    });
  } catch (err) {
    if (err instanceof RasterError) throw new VlmBridgeError(`cropping failed: ${err.message}`);
    throw err;
  }

  if (written.length !== opts.requests.length) {
    throw new VlmBridgeError(
      `${opts.requests.length} pictures were asked for and ${written.length} were written`,
    );
  }
  return written.map((entry) => ({
    name: entry.name,
    mediaType: 'image/png',
    data: new Uint8Array(fs.readFileSync(entry.path)),
  }));
}


// ── reading the PDF's own text layer ────────────────────────────────────────

/**
 * One piece of type the PDF itself reports: where its centre sits on the
 * displayed page (points, top-left origin — the frame the renders are made
 * in), the size it is set at, and how many characters it carries.
 */
export interface VlmLayerSpan {
  x: number;
  y: number;
  /** Font size in points — frame-independent, which is why no dpi rides along. */
  size: number;
  chars: number;
}

/**
 * Every text span the PDF already carries, page by page.
 *
 * A born-digital PDF, and a scan whose publisher ran real OCR over it, states
 * the size of every run of type in its own text layer — a measurement of the
 * printed page made by whoever set it, which no formula over the model's
 * boxes can beat. The facsimile route asks for it here and sizes its type
 * from it where it exists (`pdf-text.ts`).
 *
 * A pure scan has no layer and comes back as an EMPTY map, and that is an
 * absence rather than an error: the facsimile's own measurements stand, as
 * they always did. The one hard failure is an unopenable PDF, because that
 * is a machine or file problem, not a fact about the book.
 */
export async function readPdfTextLayer(opts: {
  pdfPath: string;
}): Promise<Map<number, VlmLayerSpan[]>> {
  let layer: Map<number, [number, number, number, number][]>;
  try {
    layer = await readTextLayer(path.resolve(opts.pdfPath));
  } catch (err) {
    if (err instanceof RasterError) throw new VlmBridgeError(`reading the PDF's text layer failed: ${err.message}`);
    throw err;
  }
  const out = new Map<number, VlmLayerSpan[]>();
  for (const [page, spans] of layer) out.set(page, spans.map(([x, y, size, chars]) => ({ x, y, size, chars })));
  return out;
}
