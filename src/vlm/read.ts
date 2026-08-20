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
  pagesInDirectory,
  type VlmPage,
  type VlmRunResult,
  type VlmSource,
  type VlmUnreadablePage,
} from './bridge.js';
import { capFor, worthRetrying } from './band.js';
import { DEFAULT_VLM_CONCURRENCY, readPagesFromEndpoint } from './endpoint.js';
import { requireVlmModel, type VlmModelDef } from './models.js';
import {
  openReadingsBank,
  readCompletionMarker,
  swapPendingIntoPlace,
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

/**
 * Will this run answer entirely out of a completed bank — that is, is it a
 * RENDERING of work already done rather than an order to do the work?
 *
 * Asked before anything happens and WITHOUT DOING ANYTHING: it reads the
 * completion marker and nothing else. `openReadingsBank` answers the same
 * question later and ACTS on the answer — it opens a pending bank, writes a
 * sidecar, throws away a replacement that answers a different question — so
 * asking IT twice would do all of that twice. This is the question without the
 * consequences, and it exists for one caller: the argv layer, which has to
 * decide whether a run needs a reading backend at all before it can refuse over
 * the absence of one (`runVlmConvert` in `commands.ts`).
 *
 * TRUE ONLY FOR `--reuse-readings` OVER A MARKED BANK, which is exactly the case
 * `readings.ts` calls `reuse` and describes as "no page is read from the model".
 * A resume is false even when its bank happens to be complete: nothing knows how
 * many pages the book has until the PDF is opened, so a resume is a run that
 * intends to read whatever is missing, and it needs a backend for it. Being
 * wrong in that direction costs a refusal somebody can act on; being wrong in
 * the other costs a run that dies inside Python with the wrong sentence.
 *
 * A bank with no answers in it is still true here, and deliberately:
 * `openReadingsBank` refuses `--reuse-readings` over an empty bank in its own
 * words, and "there is nothing to reuse" is a truer sentence about that run than
 * anything about backends.
 *
 * FALSE FOR `--reuse-readings` OVER AN UNMARKED BANK, and that is now a
 * statement about a run that is going to be REFUSED rather than one that is going
 * to read: `openReadingsBank` throws over a bank no run completed in, instead of
 * quietly resuming it. This function is unchanged by that — it answers what the
 * marker says, which is what its one caller asks — and `runVlmConvert` carries
 * the paragraph about which of the two refusals a person meets first.
 */
export function replaysCompletedBank(opts: {
  readingsPath?: string;
  reuseReadings?: boolean;
}): boolean {
  if (opts.reuseReadings !== true || opts.readingsPath === undefined) return false;
  return readCompletionMarker(opts.readingsPath) !== null;
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
  /** A document to rasterise, or the pages themselves. See `VlmSource`. */
  source: VlmSource;
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
  /**
   * Send every page at the model's own cap, as this program did before the
   * adaptive one existed.
   *
   * IT IS WHAT MAKES A LOSS RECOVERABLE, and without it the claim would be
   * false. A page refused by the adaptive cap cannot be rescued by reading the
   * book again: the second run walks the same pages in the same order, builds
   * the same band, and refuses the same page for the same reason. Re-reading is
   * only a remedy when something can differ, and this is the something.
   */
  fixedCap?: boolean;
  readingsPath?: string;
  freshReadings?: boolean;
  reuseReadings?: boolean;
  /** Pages that are not part of the book. Sorted, deduplicated. */
  skipPages: readonly number[];
  /**
   * The book's language as this run was told it, carried here for ONE reason:
   * it is half of what a pending bank is identified by.
   *
   * Nothing in this phase reads it. `skipPages` and `language` are what the
   * person asked for, and a pending replacement is continued or thrown away on
   * those two and nothing else (`sameAsk`, `readings.ts`) — so the phase that
   * opens the bank has to be told both, even though only one of them changes
   * which pages it renders.
   */
  language?: string;
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
  /**
   * The pending file this run wrote its answers into, or null where it wrote the
   * real bank.
   *
   * Carried out of the phase because the SWAP is not the phase's to make: the
   * pending becomes the bank when the run has finished, and only the caller knows
   * when that is — an EPUB on disk for `vlm-convert`, the last page banked for
   * `vlm-read`. Handing the path back rather than recomputing it at the swap is
   * what makes it impossible to rename somebody else's abandoned attempt over a
   * good bank (`swapPendingIntoPlace`).
   */
  pendingPath: string | null;
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
      ask: {
        skipPages: opts.skipPages,
        ...(opts.language !== undefined ? { language: opts.language } : {}),
        model: model.id,
      },
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
   * The pages are still RASTERISED, because the book takes pixels out of them:
   * a Picture is cut out of a render and the cover is the whole of one. What
   * the render is no longer asked is whether a paragraph carried on over a page
   * turn — that is the bank's answer now and nothing else's
   * (`dots-book.ts`). What must not happen is a model load,
   * which on this route costs minutes and produces nothing, or a request to a
   * server for a page whose answer is already on disk.
   *
   * This is what makes a second format free. Generating a text file out of a
   * bank that already produced an EPUB is arithmetic over answers on disk, and
   * anything that made it phone a GPU would have made the whole split pointless.
   *
   * THE TEST IS EXHAUSTIVE NOW, AND IT WAS NOT. `--reuse-readings` used to come
   * back as `resume` when the bank carried no completion marker, and this line
   * read that as "not a replay" — correctly, because a resume reads — so the one
   * flag the app passes on every rendering quietly loaded a model on the MLX
   * route and posted every unbanked page on the endpoint route. `readings.ts`
   * refuses that request outright now, so a reuse request that gets this far is
   * `reuse` and nothing else, and the only thing this line still decides is what
   * an ordinary read does.
   */
  const replaying = bank?.action === 'reuse';

  const run = await bridge.readPages({
    source: opts.source,
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
        refuse(page, `it hit the ${reading.tokens}-token cap when it was read, so its answer is truncated`);
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

      /*
       * THE BAND, AND THE ONE RULE THE ARITHMETIC CANNOT ENFORCE.
       *
       * capFor is a pure function of the longest page this book has ACCEPTED so
       * far. That word is the whole invariant and it lives here rather than in
       * band.ts, because a function that takes a number cannot know where the
       * number came from.
       *
       * A REFUSED PAGE MUST NEVER RAISE THIS. It is the page the cap exists to
       * stop, it ran to whatever cap it was given, and letting it in would push
       * the band toward the model's own -- so the band would LOOSEN exactly
       * where it should tighten, and every later runaway in the book would cost
       * more than the one before. The failure is silent and self-inflating,
       * which is why it has its own assertion rather than a comment.
       */
      let longestAccepted = 0;

      /*
       * WHAT EACH PAGE WAS ACTUALLY SENT WITH, which the retry needs and nothing
       * else records. The band moves while pages are in flight, so by the time a
       * refusal lands its own cap is history -- and the question the retry asks
       * is about that history, not about where the band ended up.
       */
      const sentCap = new Map<number, number>();

      const capForPage = (page: { number: number }): number => {
        const cap = capToSend(opts.fixedCap === true, longestAccepted, model.maxTokens);
        sentCap.set(page.number, cap);
        return cap;
      };

      await bridge.fromEndpoint({
        endpoint: opts.endpoint!,
        model: opts.endpointModel ?? model.endpointModel ?? model.repo,
        prompt: model.prompt,
        maxTokens: capForPage,
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
            refuse(page.number, cutOff(sentCap.get(page.number) ?? model.maxTokens, longestAccepted));
          } else if (page.text.trim().length === 0) {
            refuse(page.number, `it came back empty from ${model.id}`);
          } else {
            answers.set(page.number, page.text);
            longestAccepted = bandAfter(longestAccepted, page);
          }
          opts.log(
            `${label}: page ${page.number} (${done}/${wanted.length}) — `
            + `${howItWent(page, sentCap.get(page.number) ?? model.maxTokens)}, `
            + `${page.seconds.toFixed(1)}s`,
          );
        },
      });
      /*
       * THE ONE MORE PASS, FOR THE PAGES THE BAND WAS NOT READY FOR.
       *
       * A page sent under a cap the run has since left far behind was judged by
       * a number that is no longer this book's opinion, and its refusal carries
       * no information. A page sent AT the band the run ended with was judged
       * fairly and is a runaway; it is never re-read, which is what stops this
       * costing more time than the cap saves.
       *
       * THE FACTOR IS WHY IT IS NOT EVERY REFUSAL. A band CREEPS upward through
       * any book as prose varies, so "below the final band" catches almost every
       * early refusal -- measured, that rule spends 122,880 tokens to save
       * 66,344 and comes out twenty minutes SLOWER than doing nothing. Only a
       * STEP means the refusal was misjudged, and worthRetrying (band.ts) is
       * what tells a step from a creep -- it sits beside the margin and the
       * floor because the three move together.
       *
       * At this factor it fires twice in a library of 18,202 pages. It is
       * insurance against a book none of the forty-three measured is -- a
       * contiguous run of a different KIND of page, where the whole cohort is
       * sent before the first answer can raise the band -- and its price on
       * everything that has actually been read is nothing.
       */
      const misjudged = pagesToReread(
        unreadable.keys(), sentCap, capFor(longestAccepted, model.maxTokens),
      );

      if (opts.fixedCap !== true && misjudged.length > 0) {
        opts.log(
          `${label}: ${misjudged.length} page(s) were cut by a cap this book has since left `
          + `behind — reading them again at ${model.maxTokens} tokens`,
        );
        await bridge.fromEndpoint({
          endpoint: opts.endpoint!,
          model: opts.endpointModel ?? model.endpointModel ?? model.repo,
          prompt: model.prompt,
          maxTokens: model.maxTokens,
          concurrency,
          pages: misjudged.map((number) => ({ number, imagePath: renderPath(rendersDir, number) })),
          onPage: (page) => {
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
            if (page.finishReason !== 'length' && page.text.trim().length > 0) {
              // It was a real page all along. It stops being unreadable, and it
              // raises the band like any other accepted page -- which is what
              // spares the rest of its cohort.
              unreadable.delete(page.number);
              answers.set(page.number, page.text);
              longestAccepted = bandAfter(longestAccepted, page);
              opts.log(`${label}: page ${page.number} was not a runaway — kept at ${page.tokens} tokens`);
            }
          },
        });
      }

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
    pendingPath: bank?.pendingPath ?? null,
    bankAction: bank?.action ?? null,
    inferenceSeconds,
    inferredPages,
  };
}

/**
 * What to send with this page: the book's own number, or the model's.
 *
 * The flag is the whole of the escape hatch. A page refused by the narrowed cap
 * cannot be rescued by reading the book again -- the second run walks the same
 * pages, builds the same band, and refuses it identically -- so without a way to
 * turn the narrowing off, "you can read it again" would be a false sentence.
 */
export function capToSend(fixedCap: boolean, longestAccepted: number, modelCap: number): number {
  return fixedCap ? modelCap : capFor(longestAccepted, modelCap);
}

/**
 * WHICH REFUSED PAGES ARE WORTH READING AGAIN, and in what order.
 *
 * ── The question, and why it is asked after the pass rather than during it ──
 *
 * A page is sent under the band as it stood at that moment, and with twelve
 * pages in flight that band can be a dozen answers out of date. So a refusal
 * carries information only if the cap that produced it is still something this
 * book would say -- and the cheapest moment to know that is when the run has
 * finished and the band has stopped moving.
 *
 * WHAT IT MUST NOT DO IS RETRY A FAIR REFUSAL. A true runaway is refused AT the
 * band the run ended with, so `worthRetrying` says no and it is never re-read.
 * That is what keeps this from costing more time than the cap saves: measured,
 * retrying every refusal below the final band spends 122,880 tokens to save
 * 66,344.
 *
 * A page with no recorded cap is not retried. That means it was never sent by
 * this pass -- it came out of the bank, or from a run before this feature -- and
 * a page this pass did not judge is not a page this pass may overturn.
 *
 * Sorted, because the second pass reads them in book order like the first, and
 * a log that jumps about is a log somebody stops reading.
 */
export function pagesToReread(
  refused: Iterable<number>,
  sentCap: ReadonlyMap<number, number>,
  finalBand: number,
): number[] {
  const worth: number[] = [];
  for (const number of refused) {
    const sent = sentCap.get(number);
    if (sent !== undefined && worthRetrying(sent, finalBand)) worth.push(number);
  }
  return worth.sort((a, b) => a - b);
}

/**
 * What this page did, said on the page's own line as it happens.
 *
 * ── This line is the only check that catches an INERT adaptive cap ──────────
 *
 * Everything else about this feature is comparative: whether the refusal list
 * grew, whether a retry fired, whether the clock moved. AN ADAPTIVE CAP THAT
 * NEVER REACHED THE SERVER PASSES ALL OF THEM — identical lists, zero retries,
 * and the only thing missing is the saving nobody was watching for.
 *
 * The two numbers that settle it are both here: WHERE THE MODEL STOPPED, which
 * is what the server did, and WHAT IT WAS ASKED TO STOP AT, which is what we
 * sent. Equal means the cap was honoured. Different means it was ignored, and
 * the line says both numbers in one clause so the disagreement needs no
 * arithmetic and nothing correlated against a summary printed twenty minutes
 * later.
 *
 * ── And a refusal used to log exactly like a page ───────────────────────────
 *
 * Twelve runaways in one book were twelve ordinary-looking lines that happened
 * to say 8,192, so the pages that bought nothing were indistinguishable on
 * screen from the pages that ARE the book. They say CUT OFF now.
 */
export function howItWent(
  page: { tokens: number; finishReason: string | null; text: string },
  cap: number,
): string {
  if (page.finishReason !== 'length') {
    return `${page.text.length} chars, ${page.tokens} tokens`;
  }
  const against = page.tokens === cap
    ? `${page.tokens} tokens, the cap this book set`
    : `${page.tokens} tokens against a ${cap} cap`;
  return `CUT OFF at ${against}, ${page.text.length} chars`;
}

/**
 * The longest ACCEPTED page after this answer — the only thing that may raise
 * the band.
 *
 * ── This is policy, not arithmetic, which is why it is here ────────────────
 *
 * `capFor` takes a number and cannot know where it came from, so nothing in
 * band.ts can stop a refused page from feeding it. WHICH ANSWERS COUNT is a
 * property of this loop, and it is the rule with no compiler behind it.
 *
 * A REFUSED PAGE MUST NEVER RAISE THE BAND. It is the page the cap exists to
 * stop; it ran to whatever cap it was given, so its length is a fact about the
 * cap and not about the book. Letting it in would push the band toward the
 * model's own — the band would LOOSEN exactly where it should tighten, and
 * every later runaway in that book would cost more than the one before it.
 * Silent, and self-inflating, which is why it has an assertion of its own.
 */
export function bandAfter(
  longestAccepted: number,
  page: { tokens: number; finishReason: string | null; text: string },
): number {
  if (page.finishReason === 'length') return longestAccepted;
  if (page.text.trim().length === 0) return longestAccepted;
  return page.tokens > longestAccepted ? page.tokens : longestAccepted;
}

/**
 * Why a page was cut off, NAMING THE CAP THAT ACTUALLY FIRED.
 *
 * It used to name the model's number, and once the cap is a property of the run
 * that sentence is false on every page the band narrowed: a reader diagnosing a
 * refusal would be told 8,192 when 5,092 stopped it, and would go looking for a
 * page four thousand tokens longer than the one they have.
 *
 * The second clause is what makes the first actionable -- the number alone is
 * arbitrary, and "four times the longest page this book has read" is the reason
 * it is that number.
 */
function cutOff(cap: number, longestAccepted: number): string {
  const why = longestAccepted > 0
    ? `, which is this book's longest page so far (${longestAccepted} tokens) with room to spare`
    : '';
  return `it was still writing at ${cap} tokens${why}, so it was cut off`;
}

// ═════════════════════════════════════════════════════════════════════════════
// foundry vlm-read
// ═════════════════════════════════════════════════════════════════════════════

export interface VlmReadOptions {
  /** The document to read. Exactly one of this and `pagesDir`. */
  pdfPath?: string;
  /**
   * A directory of page images to read INSTEAD of a document — the photographs
   * a capture project made, which are already the pages.
   *
   * `vlm-read` is the command this belongs to and it is the only one that has
   * it, because a bank is the whole product here: this command touches the PDF
   * for one purpose, to hand it to the read. `vlm-convert` writes FORMATS, and
   * for that it also cuts figures, reads a text layer and hashes the file for
   * an identifier — six dependencies that are about a document and not about a
   * page. Formats over a captured book are rendered from the bank afterwards.
   */
  pagesDir?: string;
  /** WHERE THE READING GOES. Required: it is the whole product of this command. */
  readingsPath: string;
  modelId: string;
  python?: string;
  endpoint?: string;
  endpointModel?: string;
  concurrency?: number;
  /**
   * Send every page at the model's own cap, as this program did before the
   * adaptive one existed.
   *
   * IT IS WHAT MAKES A LOSS RECOVERABLE, and without it the claim would be
   * false. A page refused by the adaptive cap cannot be rescued by reading the
   * book again: the second run walks the same pages in the same order, builds
   * the same band, and refuses the same page for the same reason. Re-reading is
   * only a remedy when something can differ, and this is the something.
   */
  fixedCap?: boolean;
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
 * completed bank is READ AGAIN, into a pending bank beside it that replaces it
 * only when the new reading is finished, because ordering a conversion means
 * ordering the work; that rule is not weakened here, and the help for both
 * commands says so.
 */
/**
 * The one source this run reads, or a refusal naming what was wrong with the ask.
 *
 * BOTH IS AS WRONG AS NEITHER, and both are refused here rather than resolved by
 * a precedence rule. A precedence rule would let a script that passes both quietly
 * read the one the author did not mean, and there is no reading of "--pdf and
 * --pages" that is obviously right.
 */
function sourceFor(opts: VlmReadOptions): VlmSource {
  if ((opts.pdfPath === undefined) === (opts.pagesDir === undefined)) {
    throw new Error(
      'a reading is of exactly one thing: pass --pdf for a document, or --pages for a '
      + 'directory of page images.',
    );
  }
  if (opts.pdfPath !== undefined) {
    const pdfPath = path.resolve(opts.pdfPath);
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`no such PDF: ${pdfPath}. A reading is of a book, and this one is not there.`);
    }
    return { kind: 'pdf', path: pdfPath };
  }
  const dir = path.resolve(opts.pagesDir!);
  if (!fs.existsSync(dir)) {
    throw new Error(`no such directory: ${dir}. A reading is of a book, and its pages are not there.`);
  }
  const paths = pagesInDirectory(dir);
  if (paths.length === 0) {
    throw new Error(`${dir} holds no page images, so there is nothing to read.`);
  }
  return { kind: 'pages', paths };
}

export async function vlmRead(opts: VlmReadOptions): Promise<VlmReadReport> {
  const started = Date.now();
  const model = requireVlmModel(opts.modelId);
  const source = sourceFor(opts);
  const readingsPath = path.resolve(opts.readingsPath);
  const viaEndpoint = opts.endpoint !== undefined;
  const maxPixels = pixelBudget(model, viaEndpoint);



  const skipPages = [...new Set(opts.skipPages ?? [])].sort((a, b) => a - b);

  /*
   * SAY WHICH KIND OF PAGE THIS RUN IS READING, because "rendered at 200 dpi"
   * is a false sentence about a photograph. A dpi is how finely to draw
   * something with no pixels of its own; a page image arrives with its pixels
   * already chosen and the only thing that still bounds it is the budget.
   */
  opts.log(
    `vlm-read: ${model.id} (${viaEndpoint ? opts.endpoint : model.repo}), `
    + (source.kind === 'pdf'
      ? `pages rendered at ${VLM_DPI} dpi`
      : `${source.paths.length} page image(s) read as they are, no rasteriser`)
    + `${maxPixels !== undefined ? `, ${maxPixels.toLocaleString('en-US')} pixel budget` : ''}`,
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
      source,
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
      ...(opts.language !== undefined ? { language: opts.language } : {}),
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
     * THE READING IS FINISHED, SO IT TAKES ITS PLACE.
     *
     * This is the moment the whole pending arrangement is built around and it is
     * one call: where this run was replacing a finished reading, the pending file
     * is renamed over it here and nowhere else — after every page has landed,
     * with the old bank untouched until this instant. Where it was not, this is
     * exactly what it always was, a marker written beside the bank.
     *
     * The bank stops being a debt and becomes a record — the same marker
     * `vlm-convert` writes when its EPUB lands, and for the same reason.
     * `outPath` is NULL and says the honest thing: this run produced no document,
     * and the bank beside the marker is the whole of what it made.
     */
    const completion = swapPendingIntoPlace(readingsPath, phase.pendingPath, {
      completedAt: new Date().toISOString(),
      outPath: null,
      pages: phase.run.pages.length,
      ...(opts.language !== undefined ? { language: opts.language } : {}),
    });
    if (phase.pendingPath !== null) {
      opts.log(
        `vlm-read: the reading in ${phase.pendingPath} is complete, so it has taken the place of `
        + `${readingsPath} — one rename, after every page landed. The reading that was there is `
        + 'gone now and was not touched by anything before this line.',
      );
    }
    opts.log(
      `vlm-read: this reading is recorded as completed at ${completion.completedAt}. Rendering it `
      + 'into a book is `vlm-convert --reuse-readings`, which reads no page and costs no GPU; '
      + 'running vlm-read here again reads the book from the beginning into a pending bank beside '
      + 'this one, and replaces it only if that run finishes.',
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
