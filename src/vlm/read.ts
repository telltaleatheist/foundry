/**
 * vlm/read — the expensive half: pages in, ANSWERS in the bank.
 *
 * This is the phase that costs GPU-minutes a page and hours a book, and it used
 * to exist only inside `vlm-convert`, as the first third of one long function
 * that ended in an EPUB. It is a file of its own now because it became a STEP of
 * its own: `foundry vlm-read` reads a book into a bank and produces no document
 * at all, and `foundry vlm-convert --reuse-readings` turns that bank into an
 * EPUB, a text file or a facsimile PDF afterwards, as many times and as many
 * ways as somebody wants, for no GPU.
 *
 * THAT SPLIT IS THE POINT AND IT IS NOT A REFACTOR. Reading and rendering are
 * two different kinds of work with two different prices, and binding them
 * together meant the format had to be chosen before the pages were read — so a
 * person who wanted the same book as text as well as an EPUB either paid for the
 * reading twice or knew to say `--reuse-readings`. What a reading IS, is the
 * bank; what an output is, is a rendering of it.
 *
 * ONE IMPLEMENTATION, TWO ENTRIES. `readPagesIntoBank` below is what both
 * commands run, so there is exactly one place that decides how a page is
 * rendered, which pages are already answered, what is banked beside an answer
 * and what a run says while it works. The only thing the two entries disagree
 * about is the word at the front of every progress line — `vlm-convert:` or
 * `vlm-read:` — because something is watching those lines and it needs to know
 * which step it is watching (`app/electron/engine.ts`, `parseProgressLine`).
 *
 * A REPLAY ASKS FOR NOTHING. When the bank is being replayed by request, this
 * file puts the helper in RENDER mode and never opens a socket: no model is
 * loaded, no weights are paged in, no server is contacted, and the pages are
 * rasterised only because the renderings downstream measure them and cut figures
 * out of them. That is what makes generating a second format free, and it is
 * asserted rather than assumed — see `ReadPhaseOptions.bridge`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MLX_MAX_PIXELS,
  readPagesWithVlm,
  type VlmPage,
  type VlmRunResult,
  type VlmUnreadablePage,
} from './bridge.js';
import { DEFAULT_VLM_CONCURRENCY, readPagesFromEndpoint } from './endpoint.js';
import { requireVlmModel, type VlmModelDef } from './models.js';
import {
  openReadingsBank,
  writeCompletionMarker,
  type ReadingsBankAction,
  type VlmCompletion,
  type VlmReadings,
} from './readings.js';

/**
 * The resolution every page is rendered at, and not a setting.
 *
 * The models are measured on 200 dpi pages — 1300×2112 for a 468×760 pt page —
 * and a model's behaviour moves with its input resolution. The same pin, for
 * the same reason, as the rest of foundry (ARCHITECTURE §5).
 */
export const VLM_DPI = 200;

/**
 * The pixel budget, and the one number the two routes disagree about.
 *
 * A geometric dialect answers in the frame its processor resized the page to, so
 * whatever budget the reader used has to reach the parser. On MLX this program
 * chooses it — `MLX_MAX_PIXELS`, a measurement, halving the per-page cost.
 * Against an endpoint it does not: the server was started with a processor
 * config, so the model's own cap is what the boxes are in, and at 200 dpi that
 * means no resize at all. A dialect with no geometry gets no budget from here —
 * its behaviour was measured at the processor's default and changing that would
 * change the model.
 */
export function pixelBudget(model: VlmModelDef, viaEndpoint: boolean): number | undefined {
  if (model.dialect !== 'dots-json') return undefined;
  if (!viaEndpoint) return MLX_MAX_PIXELS;
  if (model.maxPixels === undefined) {
    throw new Error(
      `${model.id} answers with geometry but its registry entry declares no maxPixels, so its`
      + ' boxes cannot be scaled back into the render. Add it in src/vlm/models.ts.',
    );
  }
  return model.maxPixels;
}

export function renderPath(dir: string, page: number): string {
  return path.join(dir, `page-${String(page).padStart(4, '0')}.png`);
}

/** The two ways a page reaches this program, injectable so a replay can be watched. */
export interface VlmBridge {
  readPages: typeof readPagesWithVlm;
  fromEndpoint: typeof readPagesFromEndpoint;
}

export interface ReadPhaseOptions {
  /**
   * The word every progress line starts with, and it is a CONTRACT.
   *
   * The app reads pages-done off stderr by matching a command prefix and a
   * fraction (`parseProgressLine`), so the same phase running under two command
   * names has to say which one it is running under. Nothing else about the lines
   * differs, deliberately: the shapes are identical so that teaching a reader
   * about the second name is one more prefix and not a second parser.
   */
  label: 'vlm-convert' | 'vlm-read';
  pdfPath: string;
  model: VlmModelDef;
  /** Where the page images go. Owned by the caller, which also removes it. */
  rendersDir: string;
  /** Keep the images there after the run — the caller was given `--renders`. */
  keepRenders: boolean;
  /** The budget for this run, from `pixelBudget`. Banked beside every answer. */
  maxPixels: number | undefined;
  python?: string;
  endpoint?: string;
  endpointModel?: string;
  concurrency?: number;
  readingsPath?: string;
  freshReadings?: boolean;
  reuseReadings?: boolean;
  /** Pages that are not part of the book. Sorted, deduplicated. */
  skipPages: readonly number[];
  log: (message: string) => void;
  /**
   * The subprocess and the socket, swappable.
   *
   * Here for one reason: THE PROMISE THIS FILE MAKES ABOUT A REPLAY IS A PROMISE
   * ABOUT WHAT IT ASKS FOR — that a run over a complete bank loads no model and
   * contacts no server — and there is no way to observe an absence of work from
   * outside without a GPU and a server to not use. A test hands in a bridge that
   * records the request and answers it, which is the same seam `buildDotsBook`
   * already takes its page images through.
   */
  bridge?: VlmBridge;
}

export interface ReadPhase {
  run: VlmRunResult;
  /** Every page's answer, from the model or from the bank. Keyed by page. */
  answers: Map<number, string>;
  /** Pages with no usable answer, each with a reason. Never silent. */
  unreadable: Map<number, VlmUnreadablePage>;
  /** Every page as the rasteriser measured it, by number. */
  sizes: Map<number, VlmPage>;
  /** The bank this run answered out of, or null where there is none. */
  readings: VlmReadings | null;
  /** What was decided about the bank — `resume`, `reuse` or `read-fresh`. */
  bankAction: ReadingsBankAction | null;
  inferenceSeconds: number;
  /** How many pages this run actually paid a model for. */
  inferredPages: number;
}

/**
 * Render the pages, get an answer for every one of them, and bank each answer as
 * it lands.
 *
 * The order is the order of what things cost. The bank is opened and its verdict
 * PRINTED before a page is rendered, so the log of a forty-minute run opens by
 * saying whether that run is going to read the book or replay it. Then one
 * subprocess renders the whole book — one model load, not one per page — and
 * either reads it on this machine or leaves the PNGs for the endpoint pass to
 * post. Every answer is appended and fsynced the moment it exists, so a kill
 * costs the page that was in flight and nothing else.
 */
export async function readPagesIntoBank(opts: ReadPhaseOptions): Promise<ReadPhase> {
  const { label, model, maxPixels, rendersDir } = opts;
  const bridge = opts.bridge ?? { readPages: readPagesWithVlm, fromEndpoint: readPagesFromEndpoint };
  const viaEndpoint = opts.endpoint !== undefined;
  const geometric = model.dialect === 'dots-json';
  const notInBook = new Set(opts.skipPages);

  if (opts.skipPages.length > 0) {
    opts.log(
      `${label}: ${opts.skipPages.length} page(s) skipped, not read and not in the book — `
      + opts.skipPages.join(', '),
    );
  }

  /*
   * What this run does about the readings it found, decided once and STATED.
   *
   * `readings.ts` owns the rule; what happens here is that the sentence it
   * returns is printed before a single page is rendered. A run with no
   * `--readings` at all has no bank, no decision and nothing to say.
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

  /*
   * A REPLAY LOADS NO MODEL AND OPENS NO SOCKET, and that is decided here rather
   * than discovered in the helper.
   *
   * `reuse` is `readings.ts` stating that this run answers entirely out of a
   * completed bank — "no page is read from the model" is the sentence it prints.
   * The pages are still RASTERISED, because a rendering measures them: the
   * page-turn join is decided in the ink of the render, a Picture is cut out of
   * it, and the cover is the whole of one. What must not happen is a model load,
   * which on this route costs minutes and produces nothing, or a request to a
   * server for a page whose answer is already on disk.
   *
   * This is what makes a second format free. Generating a text file out of a
   * bank that already produced an EPUB is arithmetic over answers on disk, and
   * anything that made it phone a GPU would have made the whole split pointless.
   */
  const replaying = bank?.action === 'reuse';

  const run = await bridge.readPages({
    pdfPath: opts.pdfPath,
    model,
    dpi: VLM_DPI,
    ...(opts.python ? { python: opts.python } : {}),
    ...(geometric || viaEndpoint || opts.keepRenders ? { rendersDir } : {}),
    ...(maxPixels !== undefined ? { maxPixels } : {}),
    ...(viaEndpoint || replaying ? { renderOnly: true } : {}),
    ...(geometric ? { grayscale: true, unreadablePages: 'record' as const } : {}),
    ...(readings !== null ? { skipPages: banked } : {}),
    ...(opts.skipPages.length > 0 ? { excludePages: [...opts.skipPages] } : {}),
    onLoaded: (seconds) => opts.log(`${label}: model resident in ${seconds.toFixed(1)}s`),
    onPage: (page, total) => {
      if (page.skipped) return;
      /*
       * Banked with the geometry the model was actually shown, not with what a
       * later run would work out. The render size is this page's own — a book's
       * pages are not all one size, and the JSTOR cover page in front of the
       * Kershaw article is 1653 px wide in front of sixteen 1300 px ones — and
       * the budget is the one THIS run scaled by. Together they are what makes
       * the answer re-parsable out of the bank without the PDF.
       *
       * No `response` on this route: the helper's page event holds nothing that
       * is not already a field here (`VlmReading.response`).
       */
      readings?.append({
        page: page.number,
        text: page.text,
        tokens: page.tokens,
        finishReason: page.finishReason,
        seconds: page.seconds,
        render: { width: page.width, height: page.height },
        ...(maxPixels !== undefined ? { maxPixels } : {}),
        model: model.id,
      });
      opts.log(
        `${label}: page ${page.number}/${total} — ${page.width}x${page.height}, `
        + `${page.chars} chars, ${page.tokens} tokens, `
        + `${page.renderSeconds.toFixed(2)}s render, ${page.seconds.toFixed(1)}s inference`,
      );
    },
  });

  // Keyed by page: the bridge names a truncated page, and so does the readings
  // file it was banked in. One page, one line in the report.
  const unreadable = new Map<number, VlmUnreadablePage>(
    run.unreadable.map((page) => [page.number, page]),
  );
  const refuse = (number: number, reason: string): void => {
    if (!unreadable.has(number)) unreadable.set(number, { number, reason });
  };
  let inferenceSeconds = run.inferenceSeconds;
  let inferredPages = run.pages.filter((page) => !page.skipped).length + run.unreadable.length;

  // ── the answers, from wherever they came ──────────────────────────────────
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

  const sizes = new Map(run.pages.map((page) => [page.number, page]));

  if (viaEndpoint) {
    const wanted = run.pages.filter((p) => !answers.has(p.number));
    const concurrency = opts.concurrency ?? DEFAULT_VLM_CONCURRENCY;
    if (wanted.length === 0) {
      /*
       * NOT ONE REQUEST, and the difference between this and posting an empty
       * queue is the difference between a run that works on an aeroplane and one
       * that does not. A book whose pages are all banked needs the server for
       * nothing, so the server is not named, not resolved and not reached.
       */
      opts.log(
        `${label}: every page is answered out of the bank, so nothing is sent to `
        + `${opts.endpoint} and no model reads anything`,
      );
    } else {
      opts.log(`${label}: ${wanted.length} page(s) to ${opts.endpoint}, ${concurrency} at a time`);
      const endpointStarted = Date.now();
      let done = 0;
      await bridge.fromEndpoint({
        endpoint: opts.endpoint!,
        model: opts.endpointModel ?? model.endpointModel ?? model.repo,
        prompt: model.prompt,
        maxTokens: model.maxTokens,
        concurrency,
        pages: wanted.map((p) => ({ number: p.number, imagePath: renderPath(rendersDir, p.number) })),
        onPage: (page) => {
          done += 1;
          // The whole of the server's answer, and the geometry it was an answer
          // ABOUT. `sizes` is the render pass's own measurement of this page —
          // the same numbers the parser is handed downstream, so the bank and
          // the book cannot disagree about the frame a box was measured in.
          const render = sizes.get(page.number);
          readings?.append({
            page: page.number,
            text: page.text,
            tokens: page.tokens,
            finishReason: page.finishReason,
            seconds: page.seconds,
            response: page.response,
            ...(render !== undefined ? { render: { width: render.width, height: render.height } } : {}),
            ...(maxPixels !== undefined ? { maxPixels } : {}),
            model: model.id,
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
            `${label}: page ${page.number} (${done}/${wanted.length}) — ${page.text.length} chars, `
            + `${page.tokens} tokens, ${page.seconds.toFixed(1)}s`,
          );
        },
      });
      inferenceSeconds = (Date.now() - endpointStarted) / 1000;
      inferredPages = wanted.length;
    }
  }

  return {
    run,
    answers,
    unreadable,
    sizes,
    readings,
    bankAction: bank?.action ?? null,
    inferenceSeconds,
    inferredPages,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// foundry vlm-read
// ═════════════════════════════════════════════════════════════════════════════

export interface VlmReadOptions {
  pdfPath: string;
  /** WHERE THE READING GOES. Required: it is the whole product of this command. */
  readingsPath: string;
  modelId: string;
  python?: string;
  endpoint?: string;
  endpointModel?: string;
  concurrency?: number;
  /** Keep the page renders here — they are deleted after the run otherwise. */
  rendersDir?: string;
  freshReadings?: boolean;
  reuseReadings?: boolean;
  skipPages?: readonly number[];
  /**
   * The book's language, recorded and NOT used.
   *
   * A language is `dc:language` on a document and this command writes no
   * document, so nothing here reads it — but the person who ordered the reading
   * knew it, and the step that renders the book later is a separate invocation
   * that would otherwise have to be told again. It goes into the completion
   * marker beside the bank, where whatever generates from that bank can find it.
   * Absent means the marker simply does not claim one.
   */
  language?: string;
  log: (message: string) => void;
  /** The subprocess and the socket, swappable — see `ReadPhaseOptions.bridge`. */
  bridge?: VlmBridge;
}

export interface VlmReadReport {
  model: VlmModelDef;
  /** The bank, absolute. THE PRODUCT — there is no document. */
  readingsPath: string;
  /** What the marker beside it now says. */
  completion: VlmCompletion;
  title: string;
  author: string;
  /** Pages the run was about, in order. */
  pages: VlmPage[];
  /** How many answers the bank holds for this book, after the run. */
  banked: number;
  /** How many pages this run actually paid a model for. */
  inferredPages: number;
  /** Pages that could not be read, each with the reason. Never silent. */
  unreadable: VlmUnreadablePage[];
  skippedPages: number[];
  timings: {
    loadSeconds: number;
    renderSeconds: number;
    inferenceSeconds: number;
    totalSeconds: number;
  };
  peakRssBytes: number | null;
}

/**
 * Read a book into a bank, and stop.
 *
 * Everything expensive about a conversion and nothing else: no chapters are
 * proposed, no blocks are parsed, no XHTML is written and no file is produced
 * but the bank and the marker beside it. What comes out is a READING — the
 * model's answer for every page, with the geometry it was shown and the whole of
 * what the server said — and a rendering of it is `vlm-convert --reuse-readings`
 * afterwards, as many times and in as many formats as somebody wants.
 *
 * THE MARKER IS WRITTEN HERE AND IT IS WHAT MAKES THE NEXT STEP CHEAP. It says
 * this bank is finished work rather than an interrupted run, which is the
 * distinction `readings.ts` exists to keep — and it means the generation step
 * must ask for the answers with `--reuse-readings`. Without that flag a
 * completed bank is archived and the book is read again, because ordering a
 * conversion means ordering the work; that rule is not weakened here, and the
 * help for both commands says so.
 */
export async function vlmRead(opts: VlmReadOptions): Promise<VlmReadReport> {
  const started = Date.now();
  const model = requireVlmModel(opts.modelId);
  const pdfPath = path.resolve(opts.pdfPath);
  const readingsPath = path.resolve(opts.readingsPath);
  const viaEndpoint = opts.endpoint !== undefined;
  const maxPixels = pixelBudget(model, viaEndpoint);

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`no such PDF: ${pdfPath}. A reading is of a book, and this one is not there.`);
  }

  const skipPages = [...new Set(opts.skipPages ?? [])].sort((a, b) => a - b);

  opts.log(
    `vlm-read: ${model.id} (${viaEndpoint ? opts.endpoint : model.repo}), pages rendered at `
    + `${VLM_DPI} dpi${maxPixels !== undefined ? `, ${maxPixels.toLocaleString('en-US')} pixel budget` : ''}`,
  );
  opts.log(
    `vlm-read: the product of this run is the reading in ${readingsPath}. No book is written here — `
    + 'the formats are rendered out of the bank afterwards, with vlm-convert --reuse-readings.',
  );

  const keepRenders = opts.rendersDir !== undefined;
  const rendersDir = opts.rendersDir !== undefined
    ? path.resolve(opts.rendersDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-vlm-'));

  try {
    const phase = await readPagesIntoBank({
      label: 'vlm-read',
      pdfPath,
      model,
      rendersDir,
      keepRenders,
      maxPixels,
      skipPages,
      readingsPath,
      ...(opts.python !== undefined ? { python: opts.python } : {}),
      ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
      ...(opts.endpointModel !== undefined ? { endpointModel: opts.endpointModel } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.freshReadings === true ? { freshReadings: true } : {}),
      ...(opts.reuseReadings === true ? { reuseReadings: true } : {}),
      ...(opts.bridge !== undefined ? { bridge: opts.bridge } : {}),
      log: opts.log,
    });

    const unreadable = [...phase.unreadable.values()].sort((a, b) => a.number - b.number);
    for (const page of unreadable) {
      opts.log(`vlm-read: page ${page.number} SKIPPED — ${page.reason}`);
    }

    /*
     * THE PAGES THAT ARE IN THE BANK AND HAVE NO ANSWER, named before the marker
     * is written.
     *
     * A reading with holes in it is still a reading — the book can be rendered,
     * and every other page cost real GPU — so this does not refuse. What it must
     * not do is let the holes be discovered later, in a rendering, by somebody
     * who has forgotten which pages the model could not read.
     */
    const missing = phase.run.pages
      .map((page) => page.number)
      .filter((number) => !phase.answers.has(number));
    if (missing.length > 0) {
      opts.log(
        `vlm-read: ${missing.length} PAGE(S) HAVE NO ANSWER IN THE BANK — ${missing.join(', ')}. `
        + 'Every rendering made from it will be missing them, and will say so.',
      );
    }

    /*
     * The reading is finished, so the bank stops being a debt and becomes a
     * record — the same marker `vlm-convert` writes when its EPUB lands, and for
     * the same reason. `outPath` is NULL and says the honest thing: this run
     * produced no document, and the bank beside the marker is the whole of what
     * it made.
     */
    const completion = writeCompletionMarker(readingsPath, {
      completedAt: new Date().toISOString(),
      outPath: null,
      pages: phase.run.pages.length,
      ...(opts.language !== undefined ? { language: opts.language } : {}),
    });
    opts.log(
      `vlm-read: this reading is recorded as completed at ${completion.completedAt}. Rendering it `
      + 'into a book is `vlm-convert --reuse-readings`, which reads no page and costs no GPU; '
      + 'running vlm-read here again archives this bank and reads the book from the beginning.',
    );

    const totalSeconds = (Date.now() - started) / 1000;
    return {
      model,
      readingsPath,
      completion,
      title: phase.run.document.title,
      author: phase.run.document.author,
      pages: phase.run.pages,
      banked: phase.readings?.size ?? 0,
      inferredPages: phase.inferredPages,
      unreadable,
      skippedPages: skipPages,
      timings: {
        loadSeconds: phase.run.loadSeconds,
        renderSeconds: phase.run.renderSeconds,
        inferenceSeconds: phase.inferenceSeconds,
        totalSeconds,
      },
      peakRssBytes: phase.run.peakRssBytes,
    };
  } finally {
    if (!keepRenders) fs.rmSync(rendersDir, { recursive: true, force: true });
  }
}
