/**
 * vlm/blocks-dump — the blocks of a banked reading, as data, for something else
 * to draw.
 *
 * The app has to put the page in front of a person with every block outlined on
 * it, so that they can strike one, reclassify one or say the book divides here —
 * and then write those decisions into an overlay keyed by `(page, order, part)`
 * (`overlay.ts`). It cannot import this engine; it spawns a command and reads
 * stdout, exactly as it does for `epub-meta` and `pdf-meta`. This is what that
 * command is made of.
 *
 * THE IDS AND THE BOXES MUST BE THE ONES THE RENDERERS WILL SEE, and that is the
 * whole difficulty. A box only means something in a frame, and the frame comes
 * from two numbers — the size the page was RENDERED at and the pixel budget the
 * processor resized that render to (`smartResize` in `dots.ts`). Get the pair
 * wrong and every outline on the screen is a few per cent off from the block it
 * is supposed to be around, which is invisible until somebody strikes the wrong
 * paragraph. So the geometry is never guessed:
 *
 *  - FROM THE BANK, where the run that read the page wrote down what it showed
 *    the model (`VlmReading.render` and `maxPixels`). This is the whole point of
 *    recording them: a bank read this way needs no PDF, no rasteriser and no
 *    Python to be turned back into blocks.
 *  - FROM THE PDF, for a bank written before those fields existed — the pages
 *    are rendered again at the same pinned dpi, by the same helper, which is
 *    what `convert.ts` does on every run anyway. It costs a render pass and it
 *    is exact.
 *
 * A page whose answer cannot be parsed is REPORTED AND SKIPPED, page by page,
 * because that is what `dots.ts` promises and what `convert.ts` already does
 * with the same failure: one bad page must not cost a person the other 299.
 *
 * WHAT THIS IS NOT: the blocks a finished book is made of. `reflowBook` in
 * `dots-book.ts` suppresses mistagged running heads, merges headings printed on
 * two lines, rewrites hyphens, reflows paragraphs and joins the ones that ran
 * over a page turn. None of that has happened here, and none of it should:
 * those passes act on the book, and a person curating blocks is looking at the
 * PAGE. What is here is exactly what `parseDotsPage` produced — the same
 * blocks, with the same ids, that the overlay is about.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MLX_MAX_PIXELS, readPagesWithVlm } from './bridge.js';
import { VLM_DPI } from './read.js';
import { detectChapters, type DetectedChapter } from './dots-book.js';
import {
  DotsPageError,
  parseDotsPage,
  type DotsBlock,
  type DotsParsedPage,
  type Size,
} from './dots.js';
import { requireVlmModel } from './models.js';
import { VlmReadings } from './readings.js';

export class VlmBlocksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmBlocksError';
  }
}

/** One block, reduced to what an editing surface needs to draw and address it. */
export interface BlockRecord {
  page: number;
  order: number;
  part: number;
  category: string;
  box: { x1: number; y1: number; x2: number; y2: number };
  text: string;
}

export interface PageBlocks {
  page: number;
  /** The render's pixel size — the frame every box below is in. */
  render: Size;
  /** The budget those boxes were scaled out of. */
  maxPixels: number;
  /** `bank` when the run recorded its geometry, `render` when the PDF supplied it. */
  geometry: 'bank' | 'render';
  /**
   * Every block on the page, furniture included, in the model's own answer
   * order.
   *
   * The two lists `parseDotsPage` splits its answer into are put back together
   * here, and the sort is by `(order, part)` — the same reassembly `pdf-text.ts`
   * does, for the same reason. A person looking at a page is looking at all of
   * it: the folio and the running head are blocks they can strike or reclassify,
   * and a page with holes in it where the furniture was is a page whose outlines
   * do not match the paper.
   */
  blocks: BlockRecord[];
}

export interface BlocksDump {
  version: 1;
  kind: 'blocks';
  /** The bank these blocks were parsed out of, absolute. */
  readings: string;
  /** The model whose dialect they were parsed in. */
  model: string;
  pages: PageBlocks[];
  /**
   * WHERE THIS ENGINE WOULD DIVIDE THE BOOK, and what it would call each
   * division — the chapter list a run with no overlay produces.
   *
   * It is here so that an editor can open with the engine's own answer in front
   * of somebody rather than with an empty spine, and so that saving it back
   * unchanged renders the identical book. Each location is a `(page, order,
   * part)` an overlay's `chapters` list can name verbatim.
   *
   * It is the DETECTION's answer, over the blocks as the model gave them: no
   * overlay is applied here, because the seed is what the engine would do and
   * the overlay is what a person does about it.
   */
  chapters: DetectedChapter[];
  /** Pages in the bank whose answer could not be read, each with the reason. */
  unreadable: { page: number; reason: string }[];
}

export interface BlocksDumpOptions {
  readingsPath: string;
  /** Only needed where the bank recorded no geometry. Never written to. */
  pdfPath?: string;
  modelId: string;
  /** Interpreter for the render pass, when there has to be one. */
  python?: string;
  /**
   * The pages were read through a server rather than through MLX.
   *
   * It decides ONE number and only when the bank did not record it: the pixel
   * budget. This program picks the budget on the MLX route and does not on the
   * endpoint route, where the server's own processor config is what the boxes
   * are in — `convert.ts` makes exactly this choice, and a dump that made a
   * different one would draw every outline in the wrong place.
   */
  viaEndpoint?: boolean;
  log: (message: string) => void;
}

export async function dumpBlocks(opts: BlocksDumpOptions): Promise<BlocksDump> {
  const readingsPath = path.resolve(opts.readingsPath);
  if (!fs.existsSync(readingsPath)) {
    throw new VlmBlocksError(
      `no such readings file: ${readingsPath}. This command reads a bank of page answers; it never `
      + 'reads a page from a model, so an absent bank is nothing it can make up for.',
    );
  }
  const model = requireVlmModel(opts.modelId);
  if (model.dialect !== 'dots-json') {
    throw new VlmBlocksError(
      `${model.id} answers in the ${model.dialect} dialect, which is prose: it reports what a page `
      + 'says and never where on the page it says it. There are no blocks and no boxes to draw. Use '
      + 'a dialect that answers with geometry — dots-ocr does, and it is the default.',
    );
  }

  /*
   * OPENED, NEVER JUDGED. `VlmReadings.open` reads the file and that is all that
   * happens to the bank here: no completion marker is written, nothing is
   * archived, and no page is decided to be missing. Those are decisions about
   * whether to spend GPU, and this command spends none — it must be safe to run
   * over somebody's bank in the middle of their run.
   */
  const readings = VlmReadings.open(readingsPath);
  const pages = readings.pages();
  if (pages.length === 0) {
    throw new VlmBlocksError(
      `${readingsPath} banks no page answers, so there is nothing to draw. A conversion that has not `
      + 'read a page yet has an empty bank, and so does a path that names the wrong file.',
    );
  }

  /*
   * The budget for a page the bank did not record one for. Absent geometry means
   * the run predates the fields, and a run that predates them made this exact
   * choice on the command line it was given — which is why the flag exists.
   */
  const fallbackBudget = opts.viaEndpoint === true ? model.maxPixels : MLX_MAX_PIXELS;
  const missing = pages.filter((page) => readings.geometry(page) === null);
  const rendered = missing.length > 0
    ? await renderSizes(missing, opts, readingsPath, fallbackBudget)
    : new Map<number, Size>();
  if (missing.length > 0) {
    opts.log(
      `blocks: ${missing.length} of ${pages.length} banked page(s) carry no render size, so the PDF `
      + `was rasterised again at ${VLM_DPI} dpi to measure them. A bank written by this version `
      + 'records the geometry beside every answer and needs no PDF at all.',
    );
  }

  const out: PageBlocks[] = [];
  const unreadable: { page: number; reason: string }[] = [];
  /*
   * ONE PARSE, AND THE DETECTION CHEWS UP THE SAME BLOCKS THIS COMMAND
   * REPORTS.
   *
   * It used to be two, because the passes behind the chapter detection delete
   * blocks, join headings and rewrite text IN PLACE, and what this command
   * reports has to be the page exactly as an overlay is keyed to it. The
   * second parse was the cheap way to keep those apart while the rules only
   * existed inside a function that wrote an EPUB.
   *
   * What makes one parse safe is that `record` below takes a COPY of every
   * field it reports — the page, the order, the part, the category and the
   * text are values, and the box is an object none of the passes ever writes
   * into (`mergeAdjacentHeadings` replaces a heading's box with a new one
   * rather than growing it). Every record is made before the detection is
   * asked, so the answers this command prints are the answers the model gave,
   * whatever `reflowBook` does to the blocks afterwards.
   */
  const parsedPages: DotsParsedPage[] = [];
  for (const page of pages) {
    const reading = readings.get(page)!;
    const banked = readings.geometry(page);
    const render = banked?.render ?? rendered.get(page);
    if (render === undefined) {
      unreadable.push({ page, reason: 'no render size for it, from the bank or from the PDF' });
      continue;
    }
    const maxPixels = banked?.maxPixels ?? fallbackBudget;
    if (maxPixels === undefined) {
      throw new VlmBlocksError(
        `page ${page} banks no pixel budget and ${model.id} declares none in src/vlm/models.ts, so `
        + 'there is no frame its boxes can be scaled out of.',
      );
    }
    try {
      const parsed = parseDotsPage(reading.text, { page, render, maxPixels });
      const blocks = [...parsed.blocks, ...parsed.furniture]
        .sort((a, b) => a.order - b.order || a.part - b.part)
        .map(record);
      out.push({
        page,
        render: { width: render.width, height: render.height },
        maxPixels,
        geometry: banked !== null ? 'bank' : 'render',
        blocks,
      });
      parsedPages.push(parsed);
    } catch (err) {
      if (!(err instanceof DotsPageError)) throw err;
      unreadable.push({ page, reason: err.message.replace(/^page \d+: /, '') });
    }
  }

  const chapters = detectChapters(parsedPages);
  opts.log(
    `blocks: ${out.reduce((sum, p) => sum + p.blocks.length, 0)} block(s) over ${out.length} page(s) `
    + `of ${readingsPath}, ${chapters.length} chapter(s) this engine would divide the book at`
    + (unreadable.length === 0 ? '' : `, ${unreadable.length} page(s) UNREADABLE`),
  );
  return {
    version: 1,
    kind: 'blocks',
    readings: readingsPath,
    model: model.id,
    pages: out,
    chapters,
    unreadable,
  };
}

function record(block: DotsBlock): BlockRecord {
  return {
    page: block.page,
    order: block.order,
    part: block.part,
    category: block.category,
    box: block.box,
    text: block.text,
  };
}

/**
 * The pages measured again, off the PDF, through the same helper `convert.ts`
 * renders with.
 *
 * Not computed from the page's size in points, which would be the obvious cheap
 * answer and would be wrong by a pixel or two: the render is PyMuPDF's, its
 * rounding is PyMuPDF's, and a frame that differs from the one the model was
 * shown puts every box slightly off. The renders themselves are thrown away as
 * they are made — no directory is passed, so the helper deletes each image after
 * measuring it, which is the behaviour the endpoint route already relies on.
 */
async function renderSizes(
  missing: readonly number[],
  opts: BlocksDumpOptions,
  readingsPath: string,
  fallbackBudget: number | undefined,
): Promise<Map<number, Size>> {
  if (opts.pdfPath === undefined) {
    throw new VlmBlocksError(
      `${readingsPath} records no render size for page(s) ${missing.slice(0, 12).join(', ')}`
      + `${missing.length > 12 ? ` (and ${missing.length - 12} more)` : ''}, which means it was `
      + 'written before a bank recorded the geometry of the pages it banked. The boxes in those '
      + 'answers cannot be placed without knowing how big the page they were measured on was, so '
      + 'pass --pdf and they are measured again.',
    );
  }
  const pdfPath = path.resolve(opts.pdfPath);
  if (!fs.existsSync(pdfPath)) throw new VlmBlocksError(`no such PDF: ${pdfPath}`);
  const model = requireVlmModel(opts.modelId);
  const run = await readPagesWithVlm({
    // A dump measures a DOCUMENT's pages, so this route rasterises and always
    // did; the pages-as-pictures source belongs to the capture flow.
    source: { kind: 'pdf', path: pdfPath },
    model,
    dpi: VLM_DPI,
    renderOnly: true,
    ...(opts.python !== undefined ? { python: opts.python } : {}),
    ...(fallbackBudget !== undefined ? { maxPixels: fallbackBudget } : {}),
  });
  return new Map(run.pages.map((page) => [page.number, { width: page.width, height: page.height }]));
}
