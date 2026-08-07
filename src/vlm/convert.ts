/**
 * vlm/convert — the whole of `foundry vlm-convert`, in order.
 *
 * PDF in, EPUB out, four phases: the pages are rendered and read (`bridge.ts`
 * on this machine's GPU, `endpoint.ts` on somebody else's), each page's answer
 * is parsed in its own dialect (`dialect.ts`, or `dots.ts` for the one dialect
 * that answers with geometry), the blocks are assembled into a book (`epub.ts`,
 * or `dots-book.ts`), and the bytes are written. Nothing here touches a run
 * directory, and no stage of the pipeline in PIPELINE.md is reachable from this
 * file — that separation is the point of the mode, not an omission
 * (see `models.ts`).
 *
 * TWO ROUTES THROUGH THIS FILE, and the fork is `model.dialect`. A dialect that
 * answers with prose gets the emitter that builds a book out of prose. A
 * dialect that answers with BOXES gets the one that can use them, and takes
 * three things with it that the prose route has no way to obtain: the page
 * renders are kept (a grayscale copy of each is what the page-turn join is
 * measured in), the pixel budget is pinned and travels to the parser (the
 * boxes are in the model's frame, not the render's), and a page the model could
 * not answer for is RECORDED BY NAME rather than stopping the book.
 *
 * EVERY PHASE IS TIMED AND EVERY TIME IS REPORTED. This mode's cost is minutes
 * of GPU per book, and the only honest way to decide whether it is usable on a
 * 300-page book is to know where the minutes went: a model load is paid once, a
 * render is milliseconds, and inference is everything else. The numbers go to
 * stderr as the run proceeds, which is foundry's convention and also the only
 * way a person watching a forty-minute run can tell it is still working.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cropPageRenders, MLX_MAX_PIXELS, readPagesWithVlm, type VlmPage, type VlmUnreadablePage } from './bridge.js';
import { parsePage } from './dialect.js';
import { DotsPageError, parseDotsPage, renderScale, smartResize, type DotsParsedPage } from './dots.js';
import {
  buildDotsBook,
  openPageImages,
  type DotsChapterProposal,
  type DotsCrop,
  type DotsCropped,
} from './dots-book.js';
import { DEFAULT_VLM_CONCURRENCY, readPagesFromEndpoint } from './endpoint.js';
import { buildVlmEpub, type VlmChapter, type VlmEpubMetadata, type VlmPageBlocks } from './epub.js';
import { requireVlmModel, type VlmModelDef } from './models.js';
import { VlmReadings } from './readings.js';

/**
 * The resolution every page is rendered at, and not a setting.
 *
 * The models are measured on 200 dpi pages — 1300×2112 for a 468×760 pt page —
 * and a model's behaviour moves with its input resolution. The same pin, for
 * the same reason, as the rest of foundry (ARCHITECTURE §5).
 */
export const VLM_DPI = 200;

export interface VlmConvertOptions {
  pdfPath: string;
  outPath: string;
  modelId: string;
  /** Explicit interpreter. See `bridge.ts` for what is tried without one. */
  python?: string;
  /** Keep the page renders here — they are deleted after the run otherwise. */
  rendersDir?: string;
  /**
   * `dc:language`, which EPUB requires and no model reports.
   *
   * DECLARED, NOT DETECTED. The scan pipeline derives it from the tessdata a
   * book was recognized with, which is a decision somebody made about that
   * book; nothing equivalent exists here, so it is an option with a default and
   * the help says so.
   */
  language: string;
  /** An OpenAI-compatible server that reads the pages instead of MLX. */
  endpoint?: string;
  /** The name that server was started with. Defaults to the registry entry's. */
  endpointModel?: string;
  /** Pages in flight against the endpoint at once. */
  concurrency?: number;
  /** JSONL of per-page answers, appended as they land. Makes a run resumable. */
  readingsPath?: string;
  /** Where the chapter proposals are written. Geometric dialects only. */
  chaptersPath?: string;
  /** Remove footnote reference numbers — for a narration build. */
  stripNoteMarkers?: boolean;
  log: (message: string) => void;
}

export interface VlmConvertReport {
  model: VlmModelDef;
  outPath: string;
  bytes: number;
  title: string;
  author: string;
  chapters: VlmChapter[];
  pages: VlmPage[];
  /** Furniture the dialect removed: folios, running feet, watermarks. */
  droppedFurniture: number;
  blocks: number;
  /** Pages that could not be read, each with the reason. Never silent. */
  unreadable: VlmUnreadablePage[];
  /** Geometric dialects only — otherwise empty or zero. */
  proposals: DotsChapterProposal[];
  categories: Record<string, number>;
  footnotes: number;
  pictures: number;
  joinedPages: number[];
  timings: {
    loadSeconds: number;
    renderSeconds: number;
    inferenceSeconds: number;
    parseSeconds: number;
    xhtmlSeconds: number;
    zipSeconds: number;
    writeSeconds: number;
    totalSeconds: number;
  };
  peakRssBytes: number;
}

export async function vlmConvert(opts: VlmConvertOptions): Promise<VlmConvertReport> {
  const started = Date.now();
  const model = requireVlmModel(opts.modelId);
  const pdfPath = path.resolve(opts.pdfPath);
  const outPath = path.resolve(opts.outPath);
  const geometric = model.dialect === 'dots-json';
  const viaEndpoint = opts.endpoint !== undefined;

  /*
   * The pixel budget, and the one number the two routes disagree about.
   *
   * A geometric dialect answers in the frame its processor resized the page to,
   * so whatever budget the reader used has to reach the parser. On MLX this
   * program chooses it — `MLX_MAX_PIXELS`, a measurement, halving the per-page
   * cost. Against an endpoint it does not: the server was started with a
   * processor config, so the model's own cap is what the boxes are in, and at
   * 200 dpi that means no resize at all. A dialect with no geometry gets no
   * budget from here — its behaviour was measured at the processor's default
   * and changing that would change the model.
   */
  const maxPixels = !geometric ? undefined : viaEndpoint ? requireMaxPixels(model) : MLX_MAX_PIXELS;

  opts.log(
    `vlm-convert: ${model.id} (${viaEndpoint ? opts.endpoint : model.repo}), pages rendered at `
    + `${VLM_DPI} dpi${maxPixels !== undefined ? `, ${maxPixels.toLocaleString('en-US')} pixel budget` : ''}`,
  );

  // The renders survive the run when the dialect measures them — the ink of a
  // page turn and the crop of a Picture are both read after every page has been
  // parsed. A directory this program made is a directory it removes.
  const keepRenders = opts.rendersDir !== undefined;
  const rendersDir = opts.rendersDir !== undefined
    ? path.resolve(opts.rendersDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-vlm-'));
  const needRenders = geometric || viaEndpoint;

  const readings = opts.readingsPath !== undefined ? VlmReadings.open(opts.readingsPath) : null;
  if (readings !== null && readings.size > 0) {
    opts.log(`vlm-convert: ${readings.size} page(s) already in ${opts.readingsPath} — not re-read`);
  }

  try {
    const run = await readPagesWithVlm({
      pdfPath,
      model,
      dpi: VLM_DPI,
      ...(opts.python ? { python: opts.python } : {}),
      ...(needRenders || keepRenders ? { rendersDir } : {}),
      ...(maxPixels !== undefined ? { maxPixels } : {}),
      ...(viaEndpoint ? { renderOnly: true } : {}),
      ...(geometric ? { grayscale: true, unreadablePages: 'record' as const } : {}),
      ...(readings !== null ? { skipPages: readings.pages() } : {}),
      onLoaded: (seconds) => opts.log(`vlm-convert: model resident in ${seconds.toFixed(1)}s`),
      onPage: (page, total) => {
        if (page.skipped) return;
        readings?.append({
          page: page.number,
          text: page.text,
          tokens: page.tokens,
          finishReason: page.finishReason,
          seconds: page.seconds,
        });
        opts.log(
          `vlm-convert: page ${page.number}/${total} — ${page.width}x${page.height}, `
          + `${page.chars} chars, ${page.tokens} tokens, `
          + `${page.renderSeconds.toFixed(2)}s render, ${page.seconds.toFixed(1)}s inference`,
        );
      },
    });

    const unreadable: VlmUnreadablePage[] = [...run.unreadable];
    let inferenceSeconds = run.inferenceSeconds;

    // ── the answers, from wherever they came ────────────────────────────────
    const answers = new Map<number, string>();
    for (const page of run.pages) {
      if (!page.skipped) answers.set(page.number, page.text);
    }
    if (readings !== null) {
      for (const page of readings.pages()) {
        const reading = readings.get(page)!;
        if (reading.finishReason === 'length') {
          unreadable.push({
            number: page,
            reason: `it hit the ${model.maxTokens}-token cap when it was read, so its answer is truncated`,
          });
          continue;
        }
        answers.set(page, reading.text);
      }
    }

    if (viaEndpoint) {
      const wanted = run.pages.filter((p) => !answers.has(p.number));
      const concurrency = opts.concurrency ?? DEFAULT_VLM_CONCURRENCY;
      opts.log(
        `vlm-convert: ${wanted.length} page(s) to ${opts.endpoint}, ${concurrency} at a time`,
      );
      const endpointStarted = Date.now();
      let done = 0;
      await readPagesFromEndpoint({
        endpoint: opts.endpoint!,
        model: opts.endpointModel ?? model.endpointModel ?? model.repo,
        prompt: model.prompt,
        maxTokens: model.maxTokens,
        concurrency,
        pages: wanted.map((p) => ({ number: p.number, imagePath: renderPath(rendersDir, p.number) })),
        onPage: (page) => {
          done += 1;
          readings?.append({
            page: page.number,
            text: page.text,
            tokens: page.tokens,
            finishReason: page.finishReason,
            seconds: page.seconds,
          });
          if (page.finishReason === 'length') {
            unreadable.push({
              number: page.number,
              reason: `it hit the ${model.maxTokens}-token cap, so the model was still writing when`
                + ' it was cut off',
            });
          } else if (page.text.trim().length === 0) {
            unreadable.push({ number: page.number, reason: `it came back empty from ${model.id}` });
          } else {
            answers.set(page.number, page.text);
          }
          opts.log(
            `vlm-convert: page ${page.number} (${done}/${wanted.length}) — ${page.text.length} chars, `
            + `${page.tokens} tokens, ${page.seconds.toFixed(1)}s`,
          );
        },
      });
      inferenceSeconds = (Date.now() - endpointStarted) / 1000;
    }

    // ── parse ──────────────────────────────────────────────────────────────
    const parseStarted = Date.now();
    const geometryPages: DotsParsedPage[] = [];
    const prosePages: VlmPageBlocks[] = [];
    let droppedFurniture = 0;

    for (const page of run.pages) {
      const answer = answers.get(page.number);
      if (answer === undefined) {
        // Already recorded above, by name, with its reason.
        if (!unreadable.some((u) => u.number === page.number)) {
          unreadable.push({ number: page.number, reason: 'no answer was ever produced for it' });
        }
        continue;
      }
      if (!geometric) {
        const parsed = parsePage(answer, model.dialect, page.number);
        droppedFurniture += parsed.dropped;
        prosePages.push({ number: page.number, blocks: parsed.blocks });
        continue;
      }
      try {
        const parsed = parseDotsPage(answer, {
          page: page.number,
          render: { width: page.width, height: page.height },
          maxPixels: maxPixels!,
        });
        droppedFurniture += parsed.dropped;
        geometryPages.push(parsed);
      } catch (err) {
        if (!(err instanceof DotsPageError)) throw err;
        unreadable.push({ number: page.number, reason: err.message.replace(/^page \d+: /, '') });
      }
    }

    for (const page of unreadable.sort((a, b) => a.number - b.number)) {
      opts.log(`vlm-convert: page ${page.number} SKIPPED — ${page.reason}`);
    }

    if (geometric) checkPixelBudget(geometryPages, run.pages, maxPixels!, opts.log);

    const parseSeconds = (Date.now() - parseStarted) / 1000;

    // ── the book ───────────────────────────────────────────────────────────
    const stem = path.basename(pdfPath).replace(/\.[^.]+$/, '').trim();
    /*
     * The title, in the order of who actually knows it.
     *
     * The PDF's own metadata first — a born-digital book usually carries the
     * publisher's title — then the filename stem, which is a FACT about the
     * file rather than a guess about the book. The model is never asked: it can
     * read the words on a title page but it cannot know which of them is the
     * title, and a heading promoted to `dc:title` would be a guess wearing a
     * metadata field's clothes.
     */
    const title = run.document.title.length > 0 ? run.document.title : stem;
    const identifier = `urn:sha256:${crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex')}`;
    const metadata: VlmEpubMetadata = {
      title,
      ...(run.document.author.length > 0 ? { author: run.document.author } : {}),
      language: opts.language,
      identifier,
    };

    let bytes: Uint8Array;
    let chapters: VlmChapter[];
    let blocks: number;
    let xhtmlSeconds: number;
    let zipSeconds: number;
    let proposals: DotsChapterProposal[] = [];
    let categories: Record<string, number> = {};
    let footnotes = 0;
    let pictures = 0;
    let joinedPages: number[] = [];

    if (geometric) {
      blocks = geometryPages.reduce((sum, p) => sum + p.blocks.length, 0);
      opts.log(
        `vlm-convert: ${blocks} blocks over ${geometryPages.length} pages in `
        + `${parseSeconds.toFixed(2)}s, ${droppedFurniture} header/footer block(s) dropped`,
      );
      const built = await buildDotsBook({
        metadata,
        pages: geometryPages,
        stripNoteMarkers: opts.stripNoteMarkers === true,
        images: openPageImages(
          (page) => path.join(rendersDir, `page-${String(page).padStart(4, '0')}.pgm`),
          (requests) => cropRenders(requests, pdfPath, rendersDir, opts.python),
        ),
      });
      bytes = built.bytes;
      chapters = built.chapters;
      xhtmlSeconds = built.xhtmlSeconds;
      zipSeconds = built.zipSeconds;
      proposals = built.proposals;
      categories = built.categories;
      footnotes = built.footnotes;
      pictures = built.pictures;
      joinedPages = built.joinedPages;
      opts.log(
        `vlm-convert: ${built.lexiconWords} words in the book's own lexicon, `
        + `${joinedPages.length} paragraph(s) joined across a page turn, `
        + `${footnotes} footnote(s), ${pictures} picture(s)`,
      );
    } else {
      blocks = prosePages.reduce((sum, p) => sum + p.blocks.length, 0);
      opts.log(
        `vlm-convert: ${blocks} blocks parsed in ${parseSeconds.toFixed(2)}s, `
        + `${droppedFurniture} page-furniture tag(s) dropped`,
      );
      const built = buildVlmEpub(metadata, prosePages);
      bytes = built.bytes;
      chapters = built.chapters;
      xhtmlSeconds = built.xhtmlSeconds;
      zipSeconds = built.zipSeconds;
    }

    const writeStarted = Date.now();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, bytes);
    if (opts.chaptersPath !== undefined) {
      writeProposals(path.resolve(opts.chaptersPath), proposals, unreadable);
      opts.log(`vlm-convert: ${proposals.length} chapter proposal(s) written to ${opts.chaptersPath}`);
    }
    const writeSeconds = (Date.now() - writeStarted) / 1000;

    opts.log(
      `vlm-convert: ${chapters.length} chapters, ${bytes.length} bytes — `
      + `${xhtmlSeconds.toFixed(2)}s XHTML, ${zipSeconds.toFixed(2)}s zip, `
      + `${writeSeconds.toFixed(2)}s write`,
    );
    opts.log(`vlm-convert: wrote ${outPath}`);

    return {
      model,
      outPath,
      bytes: bytes.length,
      title,
      author: run.document.author,
      chapters,
      pages: run.pages,
      droppedFurniture,
      blocks,
      unreadable,
      proposals,
      categories,
      footnotes,
      pictures,
      joinedPages,
      timings: {
        loadSeconds: run.loadSeconds,
        renderSeconds: run.renderSeconds,
        inferenceSeconds,
        parseSeconds,
        xhtmlSeconds,
        zipSeconds,
        writeSeconds,
        totalSeconds: (Date.now() - started) / 1000,
      },
      peakRssBytes: run.peakRssBytes,
    };
  } finally {
    if (!keepRenders) fs.rmSync(rendersDir, { recursive: true, force: true });
  }
}

function requireMaxPixels(model: VlmModelDef): number {
  if (model.maxPixels === undefined) {
    throw new Error(
      `${model.id} answers with geometry but its registry entry declares no maxPixels, so its`
      + ' boxes cannot be scaled back into the render. Add it in src/vlm/models.ts.',
    );
  }
  return model.maxPixels;
}

function renderPath(dir: string, page: number): string {
  return path.join(dir, `page-${String(page).padStart(4, '0')}.png`);
}

async function cropRenders(
  requests: readonly DotsCrop[],
  pdfPath: string,
  rendersDir: string,
  python?: string,
): Promise<readonly DotsCropped[]> {
  const cropped = await cropPageRenders({
    pdfPath,
    dpi: VLM_DPI,
    cropsDir: path.join(rendersDir, 'crops'),
    requests: requests.map((r) => ({ page: r.page, box: r.box, name: r.name })),
    ...(python ? { python } : {}),
  });
  return cropped;
}

/**
 * Did the model answer in the frame we think it did?
 *
 * The boxes live inside the resized page, so the furthest right any of them
 * reaches should sit just under the resized width. Taken as a MEDIAN over the
 * pages, because one stray box on one page is a model artefact and a wrong
 * budget is wrong on every page at once. This is the only observable that
 * catches a processor whose config moved under us, and the failure it catches
 * is invisible in the text: every picture cropped slightly wrong, every indent
 * test flipped, and a book that reads fine.
 */
function checkPixelBudget(
  pages: readonly DotsParsedPage[],
  rendered: readonly VlmPage[],
  maxPixels: number,
  log: (message: string) => void,
): void {
  const measured = pages.filter((p) => p.rawExtent.x > 0);
  if (measured.length === 0 || rendered.length === 0) return;
  const render = { width: rendered[0].width, height: rendered[0].height };
  const resized = smartResize(render.height, render.width, maxPixels);
  const extents = measured.map((p) => p.rawExtent.x).sort((a, b) => a - b);
  const median = extents[Math.floor(extents.length / 2)];

  log(
    `vlm-convert: boxes measured in a ${resized.width}x${resized.height} frame, scaled by `
    + `${renderScale(render, maxPixels).toFixed(4)} into the ${render.width}x${render.height} render`
    + ` (median box extent ${Math.round(median)})`,
  );
  if (median > resized.width * 1.02) {
    throw new Error(
      `the model's boxes reach ${Math.round(median)} on a median page, and a ${maxPixels}-pixel`
      + ` budget puts the page in a ${resized.width}-wide frame. The budget this run scaled with is`
      + ' not the one the processor used, so every box in the book is wrong by that ratio.',
    );
  }
}

/**
 * The chapter proposals, and the pages that are not in the book.
 *
 * Written as data because the decision is not this program's: the list
 * over-includes on purpose (`dots-book.ts`), and a person confirms it in the
 * picker. The skipped pages travel in the same file because they are the other
 * half of "what is this book missing", and a report that answers one and not
 * the other is a report that gets half read.
 */
function writeProposals(
  filePath: string,
  proposals: readonly DotsChapterProposal[],
  unreadable: readonly VlmUnreadablePage[],
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ proposals, unreadable }, null, 1)}\n`);
}
