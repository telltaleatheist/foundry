/**
 * vlm/convert — the whole of `foundry vlm-convert`, in order.
 *
 * PDF in, EPUB out, four phases: the pages are rendered and read (`read.ts`,
 * over `bridge.ts` on this machine's GPU or `endpoint.ts` on somebody else's),
 * each page's answer is parsed in its own dialect (`dialect.ts`, or `dots.ts`
 * for the one dialect that answers with geometry), the blocks are assembled into
 * a book (`epub.ts`, or `dots-book.ts`), and the bytes are written. Nothing here
 * touches a run directory, and no stage of the pipeline in PIPELINE.md is
 * reachable from this file — that separation is the point of the mode, not an
 * omission (see `models.ts`).
 *
 * THE FIRST PHASE IS A COMMAND OF ITS OWN NOW. `read.ts` holds it, `foundry
 * vlm-read` is nothing but that phase plus the completion marker, and this file
 * calls the identical function — so a book can be read once and rendered as an
 * EPUB, a text file and a facsimile PDF afterwards, each for no GPU, with
 * `--reuse-readings`. Everything below the read in this file is arithmetic over
 * answers that already exist.
 *
 * TWO ROUTES THROUGH THIS FILE, and the fork is `model.dialect`. A dialect that
 * answers with prose gets the emitter that builds a book out of prose. A
 * dialect that answers with BOXES gets the one that can use them, and takes
 * three things with it that the prose route has no way to obtain: the page
 * renders are kept (a Picture is cut out of them), the pixel
 * budget is pinned and travels to the parser (the boxes are in the model's
 * frame, not the render's), and a page the model could not answer for is
 * RECORDED BY NAME rather than stopping the book.
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
import { TranslationRecords } from '../translate/records.js';
import { cropPageRenders, readPdfTextLayer, type VlmPage, type VlmUnreadablePage } from './bridge.js';
import { parsePage } from './dialect.js';
import { DotsPageError, parseDotsPage, renderScale, smartResize, type DotsParsedPage } from './dots.js';
import {
  buildDotsBook,
  openPageImages,
  type DotsChapterProposal,
  type DotsCrop,
  type DotsCropped,
  type DotsFold,
  type DotsHeadingMerge,
  type FurnitureEvidence,
} from './dots-book.js';
import {
  buildVlmEpub,
  type VlmChapter,
  type VlmEpubMetadata,
  type VlmPageBlocks,
  type VlmSidecar,
} from './epub.js';
import { requireVlmModel, type VlmModelDef } from './models.js';
import { applyOverlay, emptyOverlay, loadOverlay, overlayTally, type Overlay } from './overlay.js';
import { buildTextPdf } from './pdf-text.js';
import { pixelBudget, readPagesIntoBank, VLM_DPI, type VlmBridge } from './read.js';
import { readCompletionMarker, swapPendingIntoPlace } from './readings.js';
import { formatConflict, type VlmOutputFormat } from './text-out.js';

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
   * Read every page again, and start the replacement over — `--fresh-readings`.
   *
   * The EXPLICIT form of the rule `readings.ts` applies on its own when a
   * completion marker is present, for a caller whose own records know the
   * conversion finished. A bank written before markers existed carries no
   * marker, and the caller that scheduled the job is the only thing that knows.
   *
   * IT DOES NOT ARCHIVE ANY MORE, and it never destroys the bank: the new
   * reading goes into a pending file that replaces the bank when it finishes.
   * What the flag adds beyond an ordinary re-read is the one thing nothing else
   * can say — throw away a half-finished replacement rather than continue it.
   */
  freshReadings?: boolean;
  /**
   * Answer out of the bank even though a run completed here — `--reuse-readings`.
   *
   * The deliberate free reconvert: iterate on the parser or the assembler over
   * answers that cost hours. Without it, a completed run's bank is read again
   * into a pending bank beside it, because that is what ordering the conversion
   * means.
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
  /**
   * A file of amendments a person made about the blocks — `--overlay`, and
   * `overlay.ts` has the schema and the reasoning.
   *
   * The bank says what the model read and this says what somebody decided about
   * it: blocks struck out of the book, blocks reclassified, words corrected, and
   * the chapters the book divides into. Absent is an empty overlay and a run
   * that behaves exactly as it did before overlays existed. Geometric dialects
   * only — an amendment names a block by its place in the model's answer, and a
   * dialect that answers with prose has no blocks to name.
   */
  overlayPath?: string;
  /** Where the chapter proposals are written. Geometric dialects only. */
  chaptersPath?: string;
  /** Remove footnote reference numbers — for a narration build. */
  stripNoteMarkers?: boolean;
  /**
   * Write the EDITION instead of the working book — `--final`, and
   * `DotsBookOptions.final` in `dots-book.ts` is where the whole distinction is
   * argued.
   *
   * It is a flag of the ASSEMBLY and not of the file: it changes what the
   * documents say, which is why it cannot be a pass over the finished EPUB — the
   * plain-text route never becomes one.
   */
  final?: boolean;
  /**
   * A transform's answers, substituted for the blocks' own words — `--records`,
   * and `DotsBookOptions.records` in `dots-book.ts` argues the whole design.
   *
   * The file is `translate --records`' product: one JSONL row per flowing
   * block, keyed by the block's position in the bank. This route reads it,
   * resolves it to the newest row per position, and hands the emitter a map.
   *
   * GEOMETRIC DIALECTS ONLY, and refused rather than ignored anywhere else, for
   * `--overlay`'s reason: a record names a block by its place in the model's
   * answer, and a dialect that answers with prose has no blocks to name.
   *
   * THE FACSIMILE PDF ROUTE IS REFUSED TOO, and this is where it differs from
   * `--final`. That flag is accepted there and documented as doing nothing,
   * because the difference it makes — notes and editing stamps — does not exist
   * on a route that reprints the page. A records file is not like that. It
   * carries the whole book in another language, and a route that took it and
   * printed German would hand somebody a facsimile they believe is the
   * translation they ordered. Refused, by name, before a page renders.
   */
  recordsPath?: string;
  log: (message: string) => void;
  /** The subprocess and the socket, swappable — see `ReadPhaseOptions.bridge`. */
  bridge?: VlmBridge;
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
   * Page turns this run did NOT join, because the words did not say the
   * paragraph carried on and nothing here reads the page's ink to guess.
   *
   * The one thing about a converted book that changed when the ink test was
   * taken out (`dots-book.ts`, `DotsPageImages`), so it is counted and said out
   * loud. On a book set in a script that has no case it will be large, and that
   * is a known cost with a known fix rather than a defect — see `commands.ts`,
   * which is where the sentence is.
   */
  unjoinedTurns: number[];
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
   * REPRINTING A PAGE NEEDS BOXES, and only one dialect has them.
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
      `--format pdf sets the recognised text back onto the page at the position it was printed, `
      + `and ${model.id} answers in the ${model.dialect} dialect, which is prose: it reports what a `
      + 'page says and never where on the page it says it. There is nothing to place. Use a dialect '
      + 'that answers with geometry — dots-ocr does, and it is the default — or pick another '
      + '--format.',
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
   * THE CURATION, READ BEFORE A PAGE RENDERS.
   *
   * A malformed overlay is refused here rather than forty minutes later, which
   * matters more than it does for most inputs: the file exists because somebody
   * spent an evening striking blocks in an app, and the run they then ordered
   * either applies that evening or it does not. It is never half applied and
   * never silently skipped.
   *
   * A dialect with no geometry is refused outright rather than handed an overlay
   * it cannot use. An amendment names a block by where it stood in the model's
   * answer, and a prose dialect answers with a stream of text: there is nothing
   * for `(page, order, part)` to point at, so obeying the flag is impossible and
   * ignoring it would be this program dropping an instruction on the floor
   * (ARCHITECTURE §8).
   */
  if (opts.overlayPath !== undefined && !geometric) {
    throw new Error(
      `--overlay names the blocks a person struck, reclassified or corrected and the chapters they `
      + `laid out, and `
      + `${model.id} answers in the ${model.dialect} dialect, which is prose: it reports what a page `
      + 'says and never which element of its answer said it, so there is no block for an amendment '
      + 'to be about. Use a dialect that answers with geometry — dots-ocr does, and it is the '
      + 'default.',
    );
  }
  const overlay: Overlay = opts.overlayPath !== undefined
    ? loadOverlay(opts.overlayPath)
    : emptyOverlay();
  if (opts.overlayPath !== undefined) {
    /*
     * WHETHER THE SPINE IS THIS BOOK'S OR THIS PROGRAM'S, said before anything
     * else happens. It is the loudest thing an overlay can do — a laid-out list
     * supersedes every chapter rule in the assembler — and a run whose contents
     * came out of a file rather than out of the book has to say so, or the next
     * person to wonder why a heading did not open a chapter has nothing to read.
     */
    const spine = overlay.chapters === undefined
      ? 'no chapter list, so the chapters are worked out as usual'
      : `${overlay.chapters.length} chapter(s) laid out, and the book divides there and nowhere else`;
    opts.log(
      `vlm-convert: overlay ${path.resolve(opts.overlayPath)} — ${overlay.amendments.length} `
      + `amendment(s), applied to the blocks as each page is parsed; ${spine}. The readings bank is `
      + 'not touched: what the model said and what a person decided about it are two files.',
    );
  }

  /*
   * A TRANSFORM'S ANSWERS, READ BEFORE A PAGE RENDERS, for the overlay's reason
   * doubled: this file is hours of somebody's GPU in another language, and a run
   * that discovers it is malformed after the reading has finished has spent the
   * whole conversion to say so. Both refusals below are about the ROUTE rather
   * than about the file, so they come first.
   */
  if (opts.recordsPath !== undefined && !geometric) {
    throw new Error(
      `--records holds a translation keyed to the blocks it is a translation of, and ${model.id} `
      + `answers in the ${model.dialect} dialect, which is prose: it reports what a page says and `
      + 'never which element of its answer said it, so there is no block for a record to be about. '
      + 'Use a dialect that answers with geometry — dots-ocr does, and it is the default.',
    );
  }
  if (opts.recordsPath !== undefined && format === 'pdf') {
    throw new Error(
      '--records with --format pdf: the facsimile route reprints the PAGE, block by block, where '
      + 'the model found it — none of the passes that make a book run on it, and it has no place to '
      + 'put a translated paragraph that no longer fits the box the source words came out of. '
      + 'Refused rather than ignored: a facsimile printed in the source language, from a job that '
      + 'named a translation, is a file somebody would keep believing it was the translation.',
    );
  }
  /*
   * A RECORDS FILE THAT IS NOT THERE IS NOT AN EMPTY ONE.
   *
   * `TranslationRecords.open` answers "nothing recorded" for a path with no
   * file at it, which is exactly right where `translate` is about to CREATE
   * one and exactly wrong here: every position would fall back to its source
   * text, the run would succeed, and what came out would be the German book
   * wearing whatever `--language` said. That is the silent, plausible-looking
   * output this program refuses everywhere else, and it is worse here than
   * elsewhere because the file it names is somebody's hours of GPU.
   */
  if (opts.recordsPath !== undefined && !fs.existsSync(opts.recordsPath)) {
    throw new Error(
      `--records ${path.resolve(opts.recordsPath)} does not exist. A missing records file is not an `
      + 'empty one: every block would keep its source text and this run would write the untranslated '
      + `book with "${opts.language}" stamped on it, which is a file nobody can tell from the `
      + 'translation they asked for.',
    );
  }
  const records = opts.recordsPath === undefined
    ? null
    : TranslationRecords.open(opts.recordsPath).positionMap();
  if (records !== null && records.size === 0) {
    throw new Error(
      `--records ${path.resolve(opts.recordsPath!)} answers for no position at all. The same refusal `
      + 'as a missing file and for the same reason — a run that substituted nothing would write the '
      + 'untranslated book and call it a translation.',
    );
  }
  if (records !== null) {
    opts.log(
      `vlm-convert: records ${path.resolve(opts.recordsPath!)} — ${records.size} position(s) whose `
      + 'words are substituted for the book\'s own as the documents are written. The reflow, the '
      + 'chapters and the curation all run on the SOURCE text first, and dc:language comes from '
      + `--language (${opts.language}), because a file of sentences does not declare a language.`,
    );
  }

  // The budget the boxes were measured in — `read.ts` owns the rule, because it
  // is the phase that shows the model the page.
  const maxPixels = pixelBudget(model, viaEndpoint);

  // The pages this run is not about. Sorted, so the log line, the report and
  // the chapters file all name them in the same order.
  const skipPages = [...new Set(opts.skipPages ?? [])].sort((a, b) => a - b);

  opts.log(
    `vlm-convert: ${model.id} (${viaEndpoint ? opts.endpoint : model.repo}), pages rendered at `
    + `${VLM_DPI} dpi${maxPixels === undefined ? '' : `, ${maxPixels.toLocaleString('en-US')} pixel `
      + 'budget for any page this run reads'}`,
  );

  // The renders survive the run when the dialect measures them — the ink of a
  // page turn and the crop of a Picture are both read after every page has been
  // parsed. A directory this program made is a directory it removes.
  const keepRenders = opts.rendersDir !== undefined;
  const rendersDir = opts.rendersDir !== undefined
    ? path.resolve(opts.rendersDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-vlm-'));

  try {
    /*
     * THE EXPENSIVE HALF, and it is not in this file any more.
     *
     * `read.ts` renders the pages, gets an answer for every one of them and
     * banks each answer as it lands — the identical phase `foundry vlm-read`
     * runs on its own, because it IS that command. Everything below this line is
     * the other half: turning answers that already exist into a document, which
     * costs no GPU and can therefore be done again, in another format, whenever
     * somebody asks.
     */
    const phase = await readPagesIntoBank({
      label: 'vlm-convert',
      pdfPath,
      model,
      rendersDir,
      keepRenders,
      maxPixels,
      skipPages,
      ...(opts.python !== undefined ? { python: opts.python } : {}),
      ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
      ...(opts.endpointModel !== undefined ? { endpointModel: opts.endpointModel } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.readingsPath !== undefined ? { readingsPath: opts.readingsPath } : {}),
      ...(opts.freshReadings === true ? { freshReadings: true } : {}),
      ...(opts.reuseReadings === true ? { reuseReadings: true } : {}),
      // Half of what a pending reading is identified by, and nothing this phase
      // reads. See `ReadPhaseOptions.language`.
      language: opts.language,
      ...(opts.bridge !== undefined ? { bridge: opts.bridge } : {}),
      log: opts.log,
    });
    const { run, answers, unreadable, sizes } = phase;
    const refuse = (number: number, reason: string): void => {
      if (!unreadable.has(number)) unreadable.set(number, { number, reason });
    };

    /*
     * THE BUDGET AN ANSWER WAS PRODUCED UNDER BEATS THE BUDGET THIS RUN WOULD
     * HAVE USED, page by page.
     *
     * A geometric answer's boxes only mean anything inside the frame the
     * processor resized the page to, and that frame is `smartResize(render,
     * budget)`. The budget is not a property of this invocation — it is a
     * property of the READING, and the two now come apart routinely: a book read
     * through a vLLM server was measured under the model's own cap, and the run
     * that renders it into a second format tomorrow may name no server at all
     * and would otherwise scale every box by the MLX cap instead. That is the
     * failure `dots.ts` calls invisible: the text is perfect, every picture is
     * cropped wrong and every indent test is flipped.
     *
     * So the bank's own record wins wherever it has one (`VlmReading.maxPixels`,
     * written beside every answer), and this run's budget is the fallback for a
     * page read before that field existed. A run whose pages disagree with it
     * SAYS SO — it is the one line that explains a book whose figures came out
     * right on a machine where nobody expected them to.
     */
    const budgetFor = (page: number): number =>
      phase.readings?.get(page)?.maxPixels ?? maxPixels!;
    if (geometric) {
      const banked = run.pages
        .map((page) => phase.readings?.get(page.number)?.maxPixels)
        .filter((budget): budget is number => budget !== undefined && budget !== maxPixels);
      if (banked.length > 0) {
        const distinct = [...new Set(banked)].map((n) => n.toLocaleString('en-US')).join(', ');
        opts.log(
          `vlm-convert: ${banked.length} page(s) were read under a pixel budget this run would not `
          + `have chosen (${distinct}, against ${maxPixels?.toLocaleString('en-US') ?? 'none'}), and `
          + 'their boxes are scaled by the budget the bank records rather than by this run\'s. A '
          + 'reading is interpretable only in the frame it was made in.',
        );
      }
    }

    // ── parse ──────────────────────────────────────────────────────────────
    const parseStarted = Date.now();
    const geometryPages: DotsParsedPage[] = [];
    const prosePages: VlmPageBlocks[] = [];
    let droppedFurniture = 0;
    const amended = { struck: 0, reclassified: 0, corrected: 0, joined: 0 };

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
          maxPixels: budgetFor(page.number),
        });
        /*
         * THE ONE PLACE THE CURATION IS APPLIED, and it is one line after the
         * one place the blocks are made.
         *
         * Every route out of this function — the EPUB, the text file, the
         * facsimile PDF — is downstream of here, so a block somebody struck is
         * gone from all three by construction rather than by three renderers
         * each remembering to check. That is what keeps the promise cheap: the
         * Picture crop in `pdf-text.ts` never sees a struck figure and so cannot
         * cut one out of the scan, and nothing in `dots-book.ts` counts, joins
         * or measures a block that is not in the book.
         *
         * The furniture is amended too, and separately, because it is a second
         * list of the same page's blocks. What an amendment does NOT do is move
         * a block between the two: the partition was made from the model's own
         * answer and `suppressRunningHeads` reads the furniture list as the
         * book's evidence about its own running heads. Reclassifying a block to
         * Page-header states how it should be RENDERED, and the routes that drop
         * furniture read the category, so it is dropped — the block simply stays
         * in the list it was parsed into while that happens.
         */
        const curated: DotsParsedPage = {
          ...parsed,
          blocks: applyOverlay(parsed.blocks, overlay),
          furniture: applyOverlay(parsed.furniture, overlay),
        };
        for (const list of [parsed.blocks, parsed.furniture]) {
          const tally = overlayTally(list, overlay);
          amended.struck += tally.struck;
          amended.reclassified += tally.reclassified;
          amended.corrected += tally.corrected;
          amended.joined += tally.joined;
        }
        // Not dropped on the PDF route, so not counted as dropped. That route
        // reprints the folio and the running head — they are what the page
        // printed, and its claim is about the page (`pdf-text.ts`).
        if (format !== 'pdf') droppedFurniture += curated.furniture.length;
        geometryPages.push(curated);
      } catch (err) {
        if (!(err instanceof DotsPageError)) throw err;
        refuse(page.number, err.message.replace(/^page \d+: /, ''));
      }
    }

    const skipped = [...unreadable.values()].sort((a, b) => a.number - b.number);
    for (const page of skipped) {
      opts.log(`vlm-convert: page ${page.number} SKIPPED — ${page.reason}`);
    }

    /*
     * What the curation DID, counted and said — the same promise the suppressed
     * running heads and the folded sections make one file over. These blocks
     * were removed on somebody's instruction rather than on a rule, which makes
     * the number more trustworthy and not less interesting: a run that struck
     * four hundred blocks off a three-hundred-page book is an overlay pointed at
     * the wrong bank, and nothing else in the output would say so.
     */
    if (opts.overlayPath !== undefined) {
      opts.log(
        `vlm-convert: the overlay struck ${amended.struck} block(s) out of the book, rendered `
        + `${amended.reclassified} as a category the model did not give them, replaced the words `
        + `of ${amended.corrected}, and joined ${amended.joined} across a seam the rules left split; `
        + 'the readings they came from are unchanged, so a run without --overlay puts every one of '
        + 'them back',
      );
    }

    if (geometric) checkPixelBudget(geometryPages, run.pages, budgetFor, opts.log);

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
    /*
     * The files that go BESIDE the one `--out` names — an unzipped book's
     * stylesheet and its pictures (`packageVlmHtml`), and nothing on any other
     * route. Declared here with `bytes` because they are written in the same
     * breath as it, below: one product, however many files it happens to be.
     */
    let sidecars: readonly VlmSidecar[] = [];
    let chapters: VlmChapter[];
    let blocks: number;
    let xhtmlSeconds: number;
    let zipSeconds: number;
    let proposals: DotsChapterProposal[] = [];
    let categories: Record<string, number> = {};
    let footnotes = 0;
    let pictures = 0;
    let joinedPages: number[] = [];
    let unjoinedTurns: number[] = [];
    let suppressedHeads: { page: number; text: string; why: FurnitureEvidence }[] = [];
    let foldedSections: DotsFold[] = [];
    let mergedHeadings: DotsHeadingMerge[] = [];
    /** Set on the PDF route only, and what its phase line is made of. */
    let typeset: { pages: number; lines: number } | null = null;

    if (format === 'pdf') {
      /*
       * THE FORK, and it is a fork out of the book rather than inside it.
       *
       * `buildDotsBook` is where chapters get proposed, page turns get joined,
       * words get dehyphenated against the book's own lexicon, note markers get
       * linked and running heads get suppressed — every rule that turns pages
       * into a BOOK. None of them runs here, because none of them is about the
       * page, and this format's whole claim is that it reprints what the page
       * printed. The blocks go down where the model put them, in the order it
       * answered in, furniture and all.
       *
       * `--final` IS ACCEPTED HERE AND DOES NOTHING, and the asymmetry is
       * recorded rather than repaired. An edition differs from a cast in what
       * happens to NOTES and to the stamps the picker addresses elements by, and
       * this route has neither: it forks before notes exist — a footnote is text
       * at the bottom of a printed page here, not an `<aside>` anybody could
       * strike — and it writes no `data-bf-*` at all, because a PDF page has no
       * attributes to write them on. Block strikes DO reach it, because they
       * were applied at the parse (`applyOverlay`, above) and never got as far as
       * either branch. A NOTE strike does not, and page-faithful is what a
       * facsimile is for: docs/WORKBENCH.md §8 rules it a known asymmetry.
       * Refusing the flag instead would make an export of a facsimile fail over
       * a difference that does not exist on this route.
       */
      blocks = geometryPages.reduce((sum, p) => sum + p.blocks.length + p.furniture.length, 0);
      const furniture = geometryPages.reduce((sum, p) => sum + p.furniture.length, 0);
      categories = countCategories(geometryPages);
      opts.log(
        `vlm-convert: ${blocks} blocks over ${geometryPages.length} pages in `
        + `${parseSeconds.toFixed(2)}s, ${furniture} header/footer block(s) KEPT — this route `
        + 'reprints the page, and the folio was printed on the page',
      );
      const built = await buildTextPdf({
        pdfBytes: fs.readFileSync(pdfPath),
        dpi: VLM_DPI,
        crop: (requests) => cropRenders(requests, pdfPath, rendersDir, opts.python),
        /*
         * The source's own text layer, read before anything is typeset. A
         * born-digital PDF and a publisher-OCR'd scan both state the size of
         * every span of type they carry, and `pdf-text.ts` sets its type at
         * those sizes wherever they exist — the one statement about the
         * book's type that is a record rather than an inference. A pure scan
         * answers with an empty map and costs one short subprocess.
         */
        layer: await readPdfTextLayer({ pdfPath, python: opts.python }),
        pages: geometryPages.map((page) => {
          const render = sizes.get(page.page)!;
          return {
            page: page.page,
            render: { width: render.width, height: render.height },
            // Stable by `order`, which is the model's own reading order, so the
            // two lists `parseDotsPage` splits its answer into go back together
            // as the one list it answered with (`dots.ts`).
            blocks: [...page.blocks, ...page.furniture]
              .sort((a, b) => a.order - b.order)
              .map((block) => ({ box: block.box, category: block.category, text: block.text })),
          };
        }),
      });
      bytes = built.bytes;
      chapters = [];
      // Genuinely zero: there is no XHTML phase on this route, and a number
      // printed for a phase that did not happen is worse than no number.
      xhtmlSeconds = 0;
      zipSeconds = built.zipSeconds;
      typeset = { pages: built.textPages, lines: built.lines };
      pictures = built.pictures;
      /*
       * The pages that came out as a photograph instead of as type, BY NUMBER.
       *
       * A page nobody could read has no text to set, and this route will not
       * emit a blank leaf in its place — that is a silent claim that the page
       * was empty, and it is indistinguishable in the file from a leaf that
       * really is. So the scan of it survives into the output, and the numbers
       * are printed because the numbers are the useful part: "page 4 is still a
       * picture" is something a person can act on, and "1 page" is not.
       */
      if (built.facsimilePages.length > 0) {
        opts.log(
          `vlm-convert: ${built.facsimilePages.length} page(s) had no reading and kept the scan `
          + `instead of being set as text — page(s) ${built.facsimilePages.join(', ')}. Those pages `
          + 'are images in the output: still there, still printable, and not searchable',
        );
      }
      /*
       * THE SIZE THE BOOK IS SET AT, said once and by class.
       *
       * The single number that explains how every page looks. Body type measured
       * at 6 pt on a book whose scan is plainly 10 pt means the boxes are wrong,
       * and that is a conclusion nobody can reach from looking at one page of
       * output — it needs the number the whole document was set from.
       */
      const named = Object.entries(built.classSizes);
      if (named.length > 0) {
        opts.log(
          `vlm-convert: set at ${named.map(([cls, pt]) => `${cls} ${pt.toFixed(1)} pt`).join(', ')}`
          + ' — one size per class, measured off the book\'s own leading and column rather than off'
          + ' what the font can fit, so the type comes out the size the page was printed at',
        );
      }
      /*
       * How much of the sizing is the publisher's own statement. The single
       * best predictor of whether the facsimile's type matches the scan next
       * to it: a block sized from the layer is set at the size the page
       * records, and a book with none is set entirely from what the boxes
       * imply.
       */
      if (built.layerSized.blocks > 0) {
        opts.log(
          `vlm-convert: ${built.layerSized.blocks} of ${built.layerSized.of} block(s) sized `
          + 'straight from the source\'s own text layer — the size the publisher recorded for '
          + 'that very type, which beats anything measured off a box',
        );
      }
      /*
       * A dismissed witness is said out loud. Whoever compares this output
       * against the source's own text layer will find them disagreeing, and
       * without this line the disagreement reads as this program's error
       * rather than as the layer's.
       */
      if (built.layerRejected !== null) {
        opts.log(
          `vlm-convert: the source carries a text layer and it was NOT believed — it puts the `
          + `${built.layerRejected.cls} class at ${built.layerRejected.layerPt.toFixed(1)} pt where `
          + `the page's own line spacing measures ${built.layerRejected.leadPt.toFixed(1)}, which is `
          + 'the kind of size a crude OCR pass invents. The book is set from its own measurements '
          + 'instead, as a layerless scan would be',
        );
      }
      /*
       * HOW MUCH OF THE BOOK IS THE PRINTER'S OWN SETTING, said because it is
       * the single most useful number about a facsimile. Where the model kept
       * the page's line breaks they are reproduced exactly — hyphens and all —
       * and where it reflowed a paragraph the lines are this program's. A run
       * that reports a hundred line-for-line blocks is a much closer copy of the
       * page than one that reports none, and nothing else in the output says so.
       */
      opts.log(
        `vlm-convert: ${built.lineForLine.blocks} block(s) set line for line off the page's own `
        + `breaks (${built.lineForLine.lines} lines), ${built.lineForLine.wrapped} block(s) the `
        + 'model had reflowed and this rewrapped',
      );
      if (built.emphasis > 0 || built.superscripts > 0) {
        opts.log(
          `vlm-convert: ${built.emphasis} emphasis span(s) set in a real italic or bold face, `
          + `${built.superscripts} footnote reference mark(s) raised — a mark is only raised where `
          + 'a body block on the same page cites it, so a year or a page number cannot be caught',
        );
      }
      /*
       * The blocks that would not take their class's size, SAID. A block's box
       * is the model's, and a box drawn too small for the words the model put
       * inside it makes this file choose between clipping the words, shrinking
       * that block alone, or resizing the whole book around the worst box on the
       * page. It shrinks the block — nothing is ever lost — and says so, because
       * a paragraph a point smaller than its neighbours is invisible until
       * somebody is told which page to look at.
       */
      if (built.cramped !== null) {
        opts.log(
          `vlm-convert: ${built.cramped.count} block(s) could not be squeezed into their measure and `
          + `gave up their line count or their size — ${built.cramped.illegible} of them ended below `
          + `4 pt, the smallest at ${built.cramped.smallest.toFixed(2)} pt, on page(s) `
          + `${built.cramped.pages.join(', ')}. Every word is still there; the box the model drew `
          + 'round them was too small for the text it put inside, which is usually a box round the '
          + 'wrong part of the page',
        );
      }
      /*
       * Every character the font could not write, SAID. Each one is a word that
       * will not match a search, and usually a model hallucination worth a look
       * at the page (the first one found in the wild was 帮 for "hel" in
       * "helpers": the model wrote the Chinese word for help).
       */
      if (built.substituted !== null) {
        const named = built.substituted.characters
          .map((entry) => `${JSON.stringify(entry.char)} (U+${entry.code.toString(16).toUpperCase()
            .padStart(4, '0')}) ×${entry.count} on page(s) ${entry.pages.join(', ')}`)
          .join('; ');
        opts.log(
          `vlm-convert: ${built.substituted.count} character(s) the book's font cannot write `
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
        // The strikes and the categories are already in these pages; what the
        // assembler still needs the overlay for is `chapter`, which is a
        // decision about the spine rather than about a block (`proposeSections`).
        overlay,
        stripNoteMarkers: opts.stripNoteMarkers === true,
        // Spread rather than passed as `false`, so a cast hands the assembler the
        // same options object it has always been handed. See
        // `DotsBookOptions.final` for what the edition is and why it is decided
        // here rather than over the finished file.
        ...(opts.final === true ? { final: true } : {}),
        // And the same again for a transform's words: a run with no records
        // hands the assembler exactly the object it has always been handed.
        ...(records !== null ? { records } : {}),
        images: openPageImages((requests) => cropRenders(requests, pdfPath, rendersDir, opts.python)),
      });
      bytes = built.bytes;
      sidecars = built.sidecars;
      chapters = built.chapters;
      xhtmlSeconds = built.xhtmlSeconds;
      zipSeconds = built.zipSeconds;
      proposals = built.proposals;
      categories = built.categories;
      footnotes = built.footnotes;
      pictures = built.pictures;
      joinedPages = built.joinedPages;
      unjoinedTurns = built.unjoinedTurns;
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
       * What the book's own type measures.
       *
       * The stylesheet this run wrote is not the stylesheet the last one wrote:
       * every ratio in it came off this book's boxes (`typography.ts`). A
       * program that silently sizes a book differently from the book beside it
       * is a program whose output nobody can compare, so the body median and
       * every category that had enough blocks to be measured are said out loud.
       *
       * There is no longer a third clause counting the blocks that kept a size
       * of their own, because no block does: one size per category, over the
       * whole book. `TypographyReport` carries the ruling.
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
            : `derived — ${derived.join(', ')}`),
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
      /*
       * The prose dialects, where `--final` is again accepted and again does
       * nothing — for the facsimile's reason rather than as a second decision.
       * A dialect that answers with markdown names no blocks, so it takes no
       * `--overlay` in the first place (refused above by name), and there is no
       * strike anywhere to remove; `buildVlmEpub` writes `data-bf-page` and
       * nothing else, so there is no editing attribute to withhold either. The
       * edition and the cast are the same file here, and saying so is cheaper
       * than a flag threaded into a builder that would ignore it.
       */
      blocks = prosePages.reduce((sum, p) => sum + p.blocks.length, 0);
      opts.log(
        `vlm-convert: ${blocks} blocks parsed in ${parseSeconds.toFixed(2)}s, `
        + `${droppedFurniture} page-furniture tag(s) dropped`,
      );
      const built = buildVlmEpub(metadata, prosePages, format);
      bytes = built.bytes;
      sidecars = built.sidecars;
      chapters = built.chapters;
      xhtmlSeconds = built.xhtmlSeconds;
      zipSeconds = built.zipSeconds;
    }

    const writeStarted = Date.now();
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, bytes);
    /*
     * AND WHATEVER ELSE THE PRODUCT IS MADE OF, beside it.
     *
     * An unzipped book is a page, a stylesheet and its pictures; a zipped one is
     * one file. The difference is confined to this loop because the packagers
     * hand back the extra files rather than writing them (`DotsBookResult.sidecars`),
     * so nothing above this line knows or cares which format it built.
     *
     * RESOLVED AGAINST `--out`'s OWN DIRECTORY and never against the process's,
     * which is the same rule every other path in this command follows: the user
     * named a place for their book and every piece of it goes there.
     */
    for (const sidecar of sidecars) {
      const beside = path.join(path.dirname(outPath), ...sidecar.path.split('/'));
      ensureDir(path.dirname(beside));
      fs.writeFileSync(beside, sidecar.data);
    }
    if (opts.chaptersPath !== undefined) {
      writeProposals(path.resolve(opts.chaptersPath), proposals, chapters, skipped, skipPages);
      opts.log(`vlm-convert: ${proposals.length} chapter proposal(s) written to ${opts.chaptersPath}`);
    }
    /*
     * The book exists, so this conversion is FINISHED, the reading this run made
     * takes its place beside it, and the bank stops being a debt and becomes a
     * record.
     *
     * BOTH HALVES HAPPEN AFTER THE EPUB AND NOWHERE ELSE. The marker's only job
     * is to let the next invocation tell a killed run from a finished one, and a
     * marker written before the bytes landed would answer that question wrong;
     * the swap is the same promise about a bigger thing — a run that replaced a
     * finished reading has not replaced anything until the document it was
     * ordered for is on disk. Up to this line the old reading is untouched, so a
     * conversion that died anywhere above cost the project nothing.
     *
     * From here on, running this conversion again reads the book again unless
     * somebody asks for the answers back with --reuse-readings.
     */
    if (opts.readingsPath !== undefined) {
      /*
       * A FACT THE BANK ALREADY RECORDED IS NOT ERASED BY A RENDERING. The
       * marker is rewritten here to name the document this run produced, and the
       * language `vlm-read` wrote into it belongs to the BOOK rather than to any
       * one rendering of it — a reading ordered in German is still a reading in
       * German after somebody exports a text file. Nothing here reads the value;
       * it is carried so that the second rendering finds what the first one did.
       *
       * READ BEFORE THE SWAP, because the swap deletes the marker it is read out
       * of. A replacement reading is of the same book as the one it replaces, so
       * the language carries across it too.
       */
      const previous = readCompletionMarker(opts.readingsPath);
      const marker = swapPendingIntoPlace(opts.readingsPath, phase.pendingPath, {
        completedAt: new Date().toISOString(),
        outPath,
        pages: run.pages.length,
        ...(previous?.language !== undefined ? { language: previous.language } : {}),
      });
      if (phase.pendingPath !== null) {
        opts.log(
          `vlm-convert: the reading in ${phase.pendingPath} is complete and this book was made from `
          + `it, so it has taken the place of ${path.resolve(opts.readingsPath)} — one rename, after `
          + 'the book landed. The reading that was there was not touched by anything before this line.',
        );
      }
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
     * renders text and one typesets a new document, and a run that reported the
     * typesetting under the word "zip" would be a phase breakdown nobody could
     * use to work out where the seconds went. The PDF line counts pages and
     * lines rather than chapters, because it has no chapters — it never looked
     * for any.
     */
    opts.log(
      typeset !== null
        ? `vlm-convert: ${typeset.pages} page(s) set as text, ${typeset.lines} line(s), `
          + `${pictures} picture(s) kept, ${bytes.length} bytes — `
          + `${zipSeconds.toFixed(2)}s typesetting, ${writeSeconds.toFixed(2)}s write`
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
      inferredPages: phase.inferredPages,
      proposals,
      categories,
      footnotes,
      pictures,
      joinedPages,
      unjoinedTurns,
      suppressedHeads,
      foldedSections,
      mergedHeadings,
      timings: {
        loadSeconds: run.loadSeconds,
        renderSeconds: run.renderSeconds,
        inferenceSeconds: phase.inferenceSeconds,
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
  budgetFor: (page: number) => number,
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
    ratios.push(page.rawExtent.x / smartResize(size.height, size.width, budgetFor(page.page)).width);
  }
  if (ratios.length === 0) return;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];

  const first = rendered[0];
  const budget = budgetFor(first.number);
  const frame = smartResize(first.height, first.width, budget);
  log(
    `vlm-convert: page 1's boxes measured in a ${frame.width}x${frame.height} frame, scaled by `
    + `${renderScale({ width: first.width, height: first.height }, budget).toFixed(4)} into its `
    + `${first.width}x${first.height} render; boxes fill ${(median * 100).toFixed(0)}% of the frame `
    + 'on a median page',
  );
  if (median > 1.02) {
    throw new Error(
      `the model's boxes overflow the frame a ${budget}-pixel budget puts the pages in, by `
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
