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
  /**
   * Pages that are not part of the book — `--skip-pages`, and `pages.ts` has
   * the reasoning. Never rendered, never read, never in the EPUB; every other
   * page keeps its true PDF page number.
   *
   * PER RUN, and deliberately not persisted anywhere. The readings file is
   * keyed by page and belongs to the PDF, so a page banked before it was
   * skipped simply stops being asked for, and a run that skips a different set
   * tomorrow resumes off the same answers.
   */
  skipPages?: readonly number[];
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
  /** Pages the caller struck out with `--skip-pages`. Ascending; usually empty. */
  skippedPages: number[];
  /** How many pages this run actually paid a model for. The rest were cached. */
  inferredPages: number;
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

  // The pages this run is not about. Sorted, so the log line, the report and
  // the chapters file all name them in the same order; also held as a set,
  // because what the readings cache asks is membership.
  const skipPages = [...new Set(opts.skipPages ?? [])].sort((a, b) => a - b);
  const notInBook = new Set(skipPages);

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

  if (skipPages.length > 0) {
    opts.log(
      `vlm-convert: ${skipPages.length} page(s) skipped, not read and not in the book — `
      + skipPages.join(', '),
    );
  }

  const readings = opts.readingsPath !== undefined ? VlmReadings.open(opts.readingsPath) : null;
  if (readings !== null && readings.size > 0) {
    opts.log(`vlm-convert: ${readings.size} page(s) already in ${opts.readingsPath} — not re-read`);
  }
  // A banked answer for a page this run skips stays in the file, untouched and
  // unread. The cache is keyed by page and belongs to the PDF; the skip list
  // belongs to the run, and tomorrow's run may keep the page.
  const banked = readings !== null ? readings.pages().filter((p) => !notInBook.has(p)) : [];

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
      ...(readings !== null ? { skipPages: banked } : {}),
      ...(skipPages.length > 0 ? { excludePages: skipPages } : {}),
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

    // Keyed by page: the bridge names a truncated page, and so does the
    // readings file it was banked in. One page, one line in the report.
    const unreadable = new Map<number, VlmUnreadablePage>(
      run.unreadable.map((page) => [page.number, page]),
    );
    const refuse = (number: number, reason: string): void => {
      if (!unreadable.has(number)) unreadable.set(number, { number, reason });
    };
    let inferenceSeconds = run.inferenceSeconds;
    let inferredPages = run.pages.filter((page) => !page.skipped).length + run.unreadable.length;

    // ── the answers, from wherever they came ────────────────────────────────
    const answers = new Map<number, string>();
    for (const page of run.pages) {
      if (!page.skipped) answers.set(page.number, page.text);
    }
    if (readings !== null) {
      for (const page of banked) {
        const reading = readings.get(page)!;
        if (reading.finishReason === 'length') {
          refuse(page, `it hit the ${model.maxTokens}-token cap when it was read, so its answer is truncated`);
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
            refuse(page.number, `it hit the ${model.maxTokens}-token cap, so the model was still`
              + ' writing when it was cut off');
          } else if (page.text.trim().length === 0) {
            refuse(page.number, `it came back empty from ${model.id}`);
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
      inferredPages = wanted.length;
    }

    // ── parse ──────────────────────────────────────────────────────────────
    const parseStarted = Date.now();
    const geometryPages: DotsParsedPage[] = [];
    const prosePages: VlmPageBlocks[] = [];
    let droppedFurniture = 0;

    for (const page of run.pages) {
      const answer = answers.get(page.number);
      if (answer === undefined) {
        refuse(page.number, 'no answer was ever produced for it');
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
        refuse(page.number, err.message.replace(/^page \d+: /, ''));
      }
    }

    const skipped = [...unreadable.values()].sort((a, b) => a.number - b.number);
    for (const page of skipped) {
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
      // What the pages said they were. Printed even when the answer is nothing,
      // because "no page carried a signature" and "nobody looked" are different
      // facts and only one of them is a reason to go and read the book.
      const named = chapters
        .filter((chapter) => chapter.kind !== undefined && chapter.kind !== 'chapter')
        .map((chapter) => `${chapter.kind} p${chapter.firstPage}`);
      opts.log(
        named.length === 0
          ? 'vlm-convert: no page carried a title-page, copyright, contents or part signature'
          : `vlm-convert: pages named — ${named.join(', ')}`,
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
      writeProposals(path.resolve(opts.chaptersPath), proposals, chapters, skipped, skipPages);
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
      unreadable: skipped,
      skippedPages: skipPages,
      inferredPages,
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
  // PER PAGE, because a book's pages are not all one size — the Kershaw article
  // opens with a JSTOR cover page 1653 px wide in front of sixteen 1300 px ones,
  // and a frame taken from the first page would be the wrong frame for the book.
  const sizes = new Map(rendered.map((page) => [page.number, page]));
  const ratios: number[] = [];
  for (const page of pages) {
    const size = sizes.get(page.page);
    if (!size || page.rawExtent.x <= 0) continue;
    ratios.push(page.rawExtent.x / smartResize(size.height, size.width, maxPixels).width);
  }
  if (ratios.length === 0) return;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];

  const first = rendered[0];
  const frame = smartResize(first.height, first.width, maxPixels);
  log(
    `vlm-convert: page 1's boxes measured in a ${frame.width}x${frame.height} frame, scaled by `
    + `${renderScale({ width: first.width, height: first.height }, maxPixels).toFixed(4)} into its `
    + `${first.width}x${first.height} render; boxes fill ${(median * 100).toFixed(0)}% of the frame `
    + 'on a median page',
  );
  if (median > 1.02) {
    throw new Error(
      `the model's boxes overflow the frame a ${maxPixels}-pixel budget puts the pages in, by `
      + `${((median - 1) * 100).toFixed(0)}% on a median page. The budget this run scaled with is `
      + 'not the one the processor used, so every box in the book is wrong by that ratio.',
    );
  }
}

/**
 * What the rules PROPOSED, what was EMITTED, and the pages that are not in the
 * book at all.
 *
 * Written as data because the decision is not this program's: the proposal list
 * over-includes on purpose (`dots-book.ts`), and a person confirms it in the
 * picker. Both lists carry `kind` — what a page said it was, when it said so
 * loudly — and that is what lets the picker offer "delete the title page"
 * rather than making somebody open four documents to find out which is which.
 *
 * The two lists are not the same list. A proposal is a place the rules would
 * open a section; a section is a document that exists, with an `href` to act
 * on. A book that does not open on a proposal has a leading section with no
 * proposal behind it, and the picker needs the href either way.
 *
 * The pages that are not in the book travel in the same file because they are
 * the other half of "what is this book missing", and a report that answers one
 * and not the other is a report that gets half read. There are TWO such lists
 * and they are never merged: `unreadable` is a page the model failed on, which
 * is a defect, and `skippedPages` is a page somebody struck out, which is a
 * decision. A reader who cannot tell them apart cannot tell whether the book is
 * broken.
 */
function writeProposals(
  filePath: string,
  proposals: readonly DotsChapterProposal[],
  sections: readonly VlmChapter[],
  unreadable: readonly VlmUnreadablePage[],
  skippedPages: readonly number[],
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ proposals, sections, unreadable, skippedPages }, null, 1)}\n`,
  );
}
