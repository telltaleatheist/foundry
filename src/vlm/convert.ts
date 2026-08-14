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

import { ensureDir } from '../fsdirs.js';
import { cropPageRenders, MLX_MAX_PIXELS, readPagesWithVlm, type VlmPage, type VlmUnreadablePage } from './bridge.js';
import { parsePage } from './dialect.js';
import { DotsPageError, parseDotsPage, renderScale, smartResize, type DotsParsedPage } from './dots.js';
import {
  buildDotsBook,
  openPageImages,
  type DotsChapterProposal,
  type DotsCover,
  type DotsCrop,
  type DotsCropped,
  type DotsFold,
  type DotsHeadingMerge,
  type FurnitureEvidence,
} from './dots-book.js';
import { DEFAULT_VLM_CONCURRENCY, readPagesFromEndpoint } from './endpoint.js';
import { buildVlmEpub, type VlmChapter, type VlmEpubMetadata, type VlmPageBlocks } from './epub.js';
import { requireVlmModel, type VlmModelDef } from './models.js';
import { buildSearchablePdf } from './pdf-layer.js';
import { openReadingsBank, writeCompletionMarker } from './readings.js';
import { formatConflict, type VlmOutputFormat } from './text-out.js';

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
  /**
   * What `--out` is written as. EPUB unless somebody says otherwise.
   *
   * The book is assembled identically either way and only the last stage
   * differs (`text-out.ts`), which is why a conversion whose answers are
   * already banked can be re-emitted as text for free with `--reuse-readings`.
   */
  format?: VlmOutputFormat;
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
   * Archive whatever is banked and read every page — `--fresh-readings`.
   *
   * The EXPLICIT form of the rule `readings.ts` applies on its own when a
   * completion marker is present, for a caller whose own records know the
   * conversion finished. A bank written before markers existed carries no
   * marker, and the caller that scheduled the job is the only thing that knows.
   */
  freshReadings?: boolean;
  /**
   * Answer out of the bank even though a run completed here — `--reuse-readings`.
   *
   * The deliberate free reconvert: iterate on the parser or the assembler over
   * answers that cost hours. Without it, a completed run's bank is archived and
   * the book is read again, because that is what ordering the conversion means.
   */
  reuseReadings?: boolean;
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
  /** What was written there. The bytes below are of that, not of an EPUB. */
  format: VlmOutputFormat;
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
  /**
   * Running heads the model tagged as headings, found by the book's own
   * repetition and taken out. Blocks DELETED, so they are named — and each one
   * carries the evidence that condemned it, because there are now two arguments
   * that can and they are not equally strong.
   */
  suppressedHeads: { page: number; text: string; why: FurnitureEvidence }[];
  /**
   * Section openings the book printed twice, folded back into the section above
   * them. Documents that stopped existing, so they are named too.
   */
  foldedSections: DotsFold[];
  /**
   * Headings the page printed on two lines and the cast joined into one. Copy
   * this run WROTE, so they are named the loudest of the three.
   */
  mergedHeadings: DotsHeadingMerge[];
  /**
   * Which page of the scan became the cover, or why nothing did.
   *
   * NULL WHERE THE FORMAT HAS NO COVER TO HAVE — a text file has nowhere to put
   * an image, and a searchable PDF already IS the pages, so there is no absence
   * to explain on either route. A non-null value always answers the question one
   * way or the other (`DotsCover`).
   */
  cover: DotsCover | null;
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
  /** Null where the platform has no `resource` module to ask — Windows. */
  peakRssBytes: number | null;
}

export async function vlmConvert(opts: VlmConvertOptions): Promise<VlmConvertReport> {
  const started = Date.now();
  const model = requireVlmModel(opts.modelId);
  const pdfPath = path.resolve(opts.pdfPath);
  const outPath = path.resolve(opts.outPath);
  const geometric = model.dialect === 'dots-json';
  const viaEndpoint = opts.endpoint !== undefined;
  const format = opts.format ?? 'epub';

  // The output's name and the output's format, checked before a page renders.
  // `commands.ts` refuses the same pairing as a usage error; a caller that
  // reaches this function with it gets a run that failed instead, and both read
  // the identical sentence.
  const conflict = formatConflict(outPath, format);
  if (conflict !== null) throw new Error(conflict);

  /*
   * `--out` IS NEVER `--pdf`. One path is read and one is written and no
   * command takes one path for both (`PDF_IN` in commands.ts) — but `--format
   * pdf` is the first format whose output has the input's extension, so the
   * two can now be typed the same by accident, and the accident destroys the
   * scan. Checked here rather than beside the other pair because it is a
   * question about the filesystem — case, links, a relative path and an
   * absolute one naming one file — and the argv layer's checks are pure.
   */
  if (sameFile(pdfPath, outPath)) {
    throw new Error(
      `--out and --pdf name the same file (${outPath}). foundry reads the PDF and writes the book, `
      + 'and it will not write one over the other: a scan that has been overwritten by its own '
      + 'conversion is the one input that cannot be recovered by running this again.',
    );
  }

  /*
   * A searchable PDF NEEDS BOXES, and only one dialect has them.
   *
   * Every other format is built out of what the model said; this one is built
   * out of where it said it, and a dialect that answers with prose has no
   * "where" to give. Refused before a page renders rather than at the end of a
   * forty-minute run, and refused rather than quietly emitted as an EPUB: a
   * flag this program drops on the floor is the failure the format plumbing
   * exists to close (ARCHITECTURE §8).
   */
  if (format === 'pdf' && !geometric) {
    throw new Error(
      `--format pdf places the recognised text at the position it was printed, and ${model.id} `
      + `answers in the ${model.dialect} dialect, which is prose: it reports what a page says and `
      + 'never where on the page it says it. There is nothing to place. Use a dialect that answers '
      + 'with geometry — dots-ocr does, and it is the default — or pick another --format.',
    );
  }

  // Both readings flags are instructions ABOUT A BANK, and without --readings
  // there is no bank. Refused rather than ignored: an instruction this program
  // drops on the floor is the failure this whole file was changed to close.
  if (opts.readingsPath === undefined && (opts.freshReadings === true || opts.reuseReadings === true)) {
    throw new Error(
      `${opts.freshReadings === true ? 'freshReadings' : 'reuseReadings'} was set without a readings`
      + ' file, so there is no bank for it to act on.',
    );
  }

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

  /*
   * What this run does about the readings it found, decided once and STATED.
   *
   * `readings.ts` owns the rule; what happens here is that the sentence it
   * returns is printed before a single page is rendered, so the log of a
   * forty-minute run opens by saying whether that run is going to read the book
   * or replay it. A run with no `--readings` at all has no bank, no decision and
   * nothing to say.
   */
  const bank = opts.readingsPath !== undefined
    ? openReadingsBank({
      readingsPath: opts.readingsPath,
      freshRequested: opts.freshReadings === true,
      reuseRequested: opts.reuseReadings === true,
    })
    : null;
  if (bank !== null) opts.log(bank.sentence);
  const readings = bank === null ? null : bank.readings;
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
        // Not dropped on the PDF route, so not counted as dropped. The layer
        // keeps the folio and the running head — they are what the page
        // printed, and this format's claim is about the page (`pdf-layer.ts`).
        if (format !== 'pdf') droppedFurniture += parsed.furniture.length;
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
    let suppressedHeads: { page: number; text: string; why: FurnitureEvidence }[] = [];
    let foldedSections: DotsFold[] = [];
    let mergedHeadings: DotsHeadingMerge[] = [];
    let cover: DotsCover | null = null;
    /** Set on the PDF route only, and what its phase line is made of. */
    let layer: { pages: number; lines: number } | null = null;

    if (format === 'pdf') {
      /*
       * THE FORK, and it is a fork out of the book rather than inside it.
       *
       * `buildDotsBook` is where chapters get proposed, page turns get joined,
       * words get dehyphenated against the book's own lexicon, note markers get
       * linked and running heads get suppressed — every rule that turns pages
       * into a BOOK. None of them runs here, because none of them is about the
       * page, and this format's whole claim is that the layer says what the
       * page printed. The blocks go down where the model put them, in the order
       * it answered in, furniture and all.
       */
      const renders = new Map(run.pages.map((page) => [page.number, page]));
      blocks = geometryPages.reduce((sum, p) => sum + p.blocks.length + p.furniture.length, 0);
      const furniture = geometryPages.reduce((sum, p) => sum + p.furniture.length, 0);
      categories = countCategories(geometryPages);
      opts.log(
        `vlm-convert: ${blocks} blocks over ${geometryPages.length} pages in `
        + `${parseSeconds.toFixed(2)}s, ${furniture} header/footer block(s) KEPT — a searchable PDF `
        + 'is a record of the page, and the folio is on the page',
      );
      const built = await buildSearchablePdf({
        pdfBytes: fs.readFileSync(pdfPath),
        dpi: VLM_DPI,
        pages: geometryPages.map((page) => {
          const render = renders.get(page.page)!;
          return {
            page: page.page,
            render: { width: render.width, height: render.height },
            // Stable by `order`, which is the model's own reading order, so the
            // two lists `parseDotsPage` splits its answer into go back together
            // as the one list it answered with (`dots.ts`).
            blocks: [...page.blocks, ...page.furniture]
              .sort((a, b) => a.order - b.order)
              .map((block) => ({ box: block.box, text: block.text })),
          };
        }),
      });
      bytes = built.bytes;
      chapters = [];
      // Genuinely zero: there is no XHTML phase on this route, and a number
      // printed for a phase that did not happen is worse than no number.
      xhtmlSeconds = 0;
      zipSeconds = built.zipSeconds;
      layer = { pages: built.overlaidPages, lines: built.lines };
      /*
       * A layer that was already there and has been taken back out, SAID.
       *
       * This is the one thing in the run that deletes something, and the reason
       * it is allowed to is that foundry wrote it: a second layer over the
       * first would double every search hit in the book while looking identical
       * in a viewer. A deletion nobody can read is a deletion nobody can check,
       * so it is a line in the log with the version and the date the old layer
       * recorded about itself.
       */
      if (built.replaced !== null) {
        const { pages, by, at } = built.replaced;
        opts.log(
          `vlm-convert: replaced the existing foundry text layer on ${pages} page(s)`
          + `${by !== null ? `, written by foundry ${by}` : ''}${at !== null ? ` on ${at}` : ''}`
          + ' — a layer is replaced and never stacked, because two of them double every search hit',
        );
      }
      /*
       * Every character the font could not write, SAID. The substitution is
       * invisible twice over — an invisible layer, and a � where a glyph was —
       * so this line is the only place it exists. Each one is a word that will
       * not match a search, and usually a model hallucination worth a look at
       * the page (the first one found in the wild was 帮 for "hel" in
       * "helpers": the model wrote the Chinese word for help).
       */
      if (built.substituted !== null) {
        const named = built.substituted.characters
          .map((entry) => `${JSON.stringify(entry.char)} (U+${entry.code.toString(16).toUpperCase()
            .padStart(4, '0')}) ×${entry.count} on page(s) ${entry.pages.join(', ')}`)
          .join('; ');
        opts.log(
          `vlm-convert: ${built.substituted.count} character(s) the layer's font cannot write `
          + `became U+FFFD (�): ${named} — the words they sit in will not match a search, and a `
          + 'character this far outside the book\'s script is usually the model misreading the page',
        );
      }
    } else if (geometric) {
      blocks = geometryPages.reduce((sum, p) => sum + p.blocks.length, 0);
      opts.log(
        `vlm-convert: ${blocks} blocks over ${geometryPages.length} pages in `
        + `${parseSeconds.toFixed(2)}s, ${droppedFurniture} header/footer block(s) dropped`,
      );
      const built = await buildDotsBook({
        metadata,
        pages: geometryPages,
        format,
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
      /*
       * WHICH PAGE THE READER SEES FIRST, or why they will see a grey
       * rectangle.
       *
       * Printed on every run that could have one, including the ordinary
       * success, because the page is not predictable from the command line: it
       * is the first page the book CONTAINS, which under `--skip-pages 1-6` is
       * page 7 and under a first leaf the model read nothing on is page 8. A
       * cover somebody cannot check is a cover nobody can correct.
       */
      cover = built.cover;
      if (cover !== null) {
        opts.log(
          cover.why === null
            ? `vlm-convert: cover — page ${cover.page} of the PDF, rendered whole; the first page `
              + 'this run kept'
            : `vlm-convert: NO COVER — ${cover.why}. The book is written anyway: a grey thumbnail `
              + 'is worse than nothing on a shelf, and a book that was not produced is worse than both',
        );
      }
      opts.log(
        `vlm-convert: ${built.lexiconWords} words in the book's own lexicon, `
        + `${joinedPages.length} paragraph(s) joined across a page turn, `
        + `${built.reflowedBlocks} paragraph(s) reflowed out of print lines, `
        + `${built.mergedHeadings.length} heading(s) merged out of two boxes, `
        + `${footnotes} footnote(s), ${pictures} picture(s)`,
      );
      /*
       * The running heads the model mistagged, and what they said.
       *
       * Printed like `dropped` and never silently: this pass DELETES blocks
       * that the model called a Title, and a deletion nobody can read is a
       * deletion nobody can check. The distinct texts are listed rather than
       * every page, because seventeen lines reading INDEX is not a report.
       *
       * Each text now carries the evidence path that condemned it. `tagged` is
       * the model's own answer somewhere else in the book; `body-sized` is the
       * book's own printing, for a head the model never labelled once — the
       * weaker of the two arguments, and the one somebody reading this line
       * would want to go and look at the page for.
       */
      suppressedHeads = built.suppressedHeads;
      if (suppressedHeads.length > 0) {
        const paths = new Map<string, FurnitureEvidence>();
        for (const head of suppressedHeads) if (!paths.has(head.text)) paths.set(head.text, head.why);
        opts.log(
          `vlm-convert: ${suppressedHeads.length} mistagged running head(s) suppressed — `
          + [...paths].map(([text, why]) => `${JSON.stringify(text)} (${why})`).join(', '),
        );
      }
      /*
       * The sections the book opened twice, folded into one.
       *
       * The same promise as the line above, for the same reason: this one
       * removes DOCUMENTS — a nav entry a person would otherwise have gone
       * looking for — and it removes them on a rule about repetition and the
       * absence of prose. Every fold is named with the page it was on and the
       * words that opened it, so the one time the rule is wrong is the one time
       * somebody can see that it was.
       */
      foldedSections = built.foldedSections;
      if (foldedSections.length > 0) {
        opts.log(
          `vlm-convert: ${foldedSections.length} duplicated section opening(s) folded into the `
          + 'section above — '
          + foldedSections.map((f) => `${JSON.stringify(f.text)} p${f.page}`).join(', '),
        );
      }
      /*
       * The headings the page printed on two lines, joined into one.
       *
       * The loudest of the three lines, because it is the only one that ADDS
       * copy: the two others delete a block or drop a document, and this one
       * writes a heading the printer never set on a single line — and puts a
       * separator into the contents entry that is in no book anywhere. Each
       * merge is printed with both of its halves and its page, so the one that
       * is wrong is the one somebody can see is wrong and undo in select mode.
       */
      mergedHeadings = built.mergedHeadings;
      if (mergedHeadings.length > 0) {
        opts.log(
          `vlm-convert: ${mergedHeadings.length} heading(s) printed on two lines merged into one — `
          + mergedHeadings
            .map((m) => `${m.lines.map((line) => JSON.stringify(line)).join(' + ')} p${m.page}`)
            .join(', '),
        );
      }
      /*
       * What the book's own type measures, and what was done about it.
       *
       * The stylesheet this run wrote is not the stylesheet the last one wrote:
       * every ratio in it came off this book's boxes (`typography.ts`). A
       * program that silently sizes a book differently from the book beside it
       * is a program whose output nobody can compare, so the medians, the
       * categories that had enough blocks to be measured at all, and the blocks
       * that kept a size of their own are all said out loud.
       */
      const typography = built.typography;
      if (typography === null) {
        opts.log(
          'vlm-convert: no body prose to measure, so the stylesheet is the static one and no type '
          + 'size in this book came from the book',
        );
      } else {
        const derived = Object.entries(typography.categories)
          .map(([category, m]) => `${category} ${m.ratio.toFixed(2)}em (${m.samples} blocks)`);
        opts.log(
          `vlm-convert: body type measures ${typography.bodyPx.toFixed(1)}px per line; `
          + (derived.length === 0
            ? 'no category had enough blocks to calibrate, so the stylesheet\'s own sizes stand'
            : `derived — ${derived.join(', ')}`)
          + `; ${typography.outliers.length} block(s) kept a size of their own`,
        );
      }
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
      const built = buildVlmEpub(metadata, prosePages, format);
      bytes = built.bytes;
      chapters = built.chapters;
      xhtmlSeconds = built.xhtmlSeconds;
      zipSeconds = built.zipSeconds;
      /*
       * The prose route has no cover and cannot have one, SAID rather than left
       * to be discovered on a shelf. A cover is a crop out of a page render by a
       * box, and this route has neither: the emitter here is handed blocks with
       * no geometry at all (`epub.ts`), so there is nothing to cut and nothing
       * that knows how big the page was. It is the same absence `--format pdf`
       * is refused for, one file earlier.
       */
      if (format === 'epub') {
        cover = {
          page: null,
          why: `${model.id} answers in the ${model.dialect} dialect, which is prose: it reports what `
            + 'a page says and never where on the page it says it, so no page can be cut into a cover',
        };
        opts.log(`vlm-convert: NO COVER — ${cover.why}`);
      }
    }

    const writeStarted = Date.now();
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, bytes);
    if (opts.chaptersPath !== undefined) {
      writeProposals(path.resolve(opts.chaptersPath), proposals, chapters, skipped, skipPages);
      opts.log(`vlm-convert: ${proposals.length} chapter proposal(s) written to ${opts.chaptersPath}`);
    }
    /*
     * The book exists, so this conversion is FINISHED, and the bank beside it
     * stops being a debt and becomes a record.
     *
     * Written after the EPUB and nowhere else: the marker's only job is to let
     * the next invocation tell a killed run from a finished one, and a marker
     * written before the bytes landed would answer that question wrong. From
     * here on, running this conversion again reads the book again unless
     * somebody asks for the answers back with --reuse-readings.
     */
    if (opts.readingsPath !== undefined) {
      const marker = writeCompletionMarker(opts.readingsPath, {
        completedAt: new Date().toISOString(),
        outPath,
        pages: run.pages.length,
      });
      opts.log(
        `vlm-convert: this conversion is recorded as completed at ${marker.completedAt}, so the next `
        + 'run over these readings reads the book again rather than replaying them.',
      );
    }

    const writeSeconds = (Date.now() - writeStarted) / 1000;

    /*
     * The middle phase is named for what it actually did.
     *
     * All three formats turn what was read into bytes; one of them zips, one
     * renders text and one draws a layer over a document it did not make, and a
     * run that wrote a PDF overlay under the word "zip" would be a phase
     * breakdown nobody could use to work out where the seconds went. The PDF
     * line counts pages and lines rather than chapters, because it has no
     * chapters — it never looked for any.
     */
    opts.log(
      layer !== null
        ? `vlm-convert: ${layer.pages} page(s) overlaid, ${layer.lines} line(s) of invisible text, `
          + `${bytes.length} bytes — ${zipSeconds.toFixed(2)}s overlay, `
          + `${writeSeconds.toFixed(2)}s write`
        : `vlm-convert: ${chapters.length} chapters, ${bytes.length} bytes — `
          + `${xhtmlSeconds.toFixed(2)}s XHTML, ${zipSeconds.toFixed(2)}s `
          + `${format === 'txt' ? 'text' : 'zip'}, ${writeSeconds.toFixed(2)}s write`,
    );
    opts.log(`vlm-convert: wrote ${outPath}`);

    return {
      model,
      outPath,
      format,
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
      suppressedHeads,
      foldedSections,
      mergedHeadings,
      cover,
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

/**
 * Do two paths name one file?
 *
 * `realpathSync` where the file exists, so that a link, a short name and a
 * different spelling of the same directory all collapse; the resolved path
 * where it does not, which is the ordinary case for an output. Compared
 * case-insensitively on Windows, where `Book.pdf` and `book.pdf` ARE one file
 * and a case-sensitive test would happily let a run destroy its own input.
 */
function sameFile(a: string, b: string): boolean {
  const real = (filePath: string): string => {
    try {
      return fs.realpathSync.native(filePath);
    } catch {
      return filePath;
    }
  };
  const [left, right] = [real(a), real(b)];
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * What the model called the blocks, counted.
 *
 * The book routes get this out of the assembler, which is the thing that sees
 * every block on its way into a document. The PDF route has no assembler, so it
 * counts them here — off the same pages, furniture included, because on that
 * route the furniture is in the output.
 */
function countCategories(pages: readonly DotsParsedPage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const page of pages) {
    for (const block of [...page.blocks, ...page.furniture]) {
      counts[block.category] = (counts[block.category] ?? 0) + 1;
    }
  }
  return counts;
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
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ proposals, sections, unreadable, skippedPages }, null, 1)}\n`,
  );
}
