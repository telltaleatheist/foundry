/**
 * analyze/run — the book, read against the categories.
 *
 * Three stages, each doing the half the engine it uses is actually good at
 * (docs/ANALYSIS.md §1):
 *
 *   1. RANK — every sentence, and every sliding three-sentence window, scored
 *      against every category's stance hypotheses by a zero-shot entailment
 *      model in a resident Python worker. Exhaustive and cheap: nothing is
 *      missed because a model stopped early, which is exactly how open-ended
 *      "read this chapter and find the quotes" always fails.
 *   2. WINDOW — surviving sentences expand to their neighbours and merge,
 *      category-blind, into paragraph-sized passages. Scoring stays per
 *      sentence; judging moves to the passage.
 *   3. VERIFY — one schema-constrained Ollama call per (window, category),
 *      answering one question: is the author asserting this, or reporting,
 *      quoting, questioning or arguing against it?
 *
 * NOTHING HERE MATCHES A QUOTATION TO ANYTHING, EVER. Foundry has block
 * identity, so every finding is a block id and a pair of character offsets
 * measured from the book file's own text. The deprecated BookForge analysis
 * asked a model for quotes and then fuzzy-matched the (often reworded) quotes
 * back into the book, which is why a whole recovery module exists over there.
 *
 * ── WHAT THIS FILE OWNS ─────────────────────────────────────────────────────
 *
 * The order of operations and the two things only a caller can decide: which
 * rows of the book are prose, and where an answer comes from — the report's
 * cache or a model. Every rule about HOW a stage works lives in the stage's own
 * file, and this one does not repeat any of them.
 */
import * as fs from 'node:fs';

import { stripBom } from '../bom.js';
import {
  fetchTransport,
  normaliseEndpoint,
  requireModel,
  unloadModel,
  type Transport,
} from '../translate/ollama.js';
import { parseBookFile } from '../vlm/book-file.js';
import { NliWorker, NLI_MODEL_ID, type NliWorkerOptions } from './nli-bridge.js';
import {
  buildPlan,
  hypothesisSetVersion,
  parseCategoriesJson,
  planHues,
  untunedNames,
  type CategoryRequest,
  type RankPlan,
} from './plan.js';
import {
  bookSentence,
  collapseRow,
  flattenHypotheses,
  rankWindows,
  CAPTURE_THRESHOLD,
  RESCUE_FLOOR,
  SLIDING_WINDOW_SENTENCES,
  type BookSentence,
  type FlagWindow,
  type WindowCategory,
} from './rank.js';
import { splitSentences } from './sentences.js';
import {
  analysisHeader,
  openAnalysisReport,
  rankKey,
  verdictKey,
  type AnalysisFinding,
  type AnalysisReport,
} from './report.js';
import {
  askVerdict,
  buildVerificationPrompt,
  stageNumCtx,
  windowFinding,
  type WindowFinding,
} from './verify.js';

/** The run cannot continue, and the message says why. */
export class AnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeError';
  }
}

/**
 * The rows whose words are read.
 *
 * The translate set minus the furniture: a running head is not prose and a page
 * number is not an assertion, and both recur on every page — scoring them would
 * spend the NLI pass proving that the book's title is not hate speech, several
 * hundred times. `Formula`, `Picture` and `Table` are out for their own reason:
 * a formula and a picture have no sentences, and a table's cells are not one.
 *
 * SHELVED ROWS ARE OUT TOO, by `shelf === undefined` rather than by category —
 * a block the reflow judged to be a running head is out of the flow, and
 * analysing something the reader is not shown would flag a passage nobody can
 * be travelled to.
 */
const PROSE: ReadonlySet<string> = new Set([
  'Caption', 'Footnote', 'List-item', 'Quote', 'Section-header', 'Text', 'Title',
]);

/**
 * How many texts go to the worker in one request.
 *
 * The worker chunks internally to bound its own memory; this bound is about
 * PROGRESS. One request for a whole book would be one progress line at the
 * start and one at the end, with twenty minutes of silence between them, and a
 * user watching a job with no output cannot tell it from a hung one. Five
 * hundred is a few seconds of work on a GPU and under a minute on a CPU.
 */
const SCORE_BATCH = 500;

export interface AnalyzeOptions {
  /** The book file. Read, never written. */
  bookPath: string;
  /** Where the report goes. Required — foundry never invents a name. */
  outPath: string;
  /** A `--categories` file, or null for every built-in category. */
  categoriesPath?: string | null;
  /** The Ollama model that answers the verdicts. */
  model: string;
  /** The Ollama server. Never started, never stopped by this program. */
  endpoint: string;
  /** `--nli-python`, `--nli-home`, `--fetch-nli-model`. */
  nli: Omit<NliWorkerOptions, 'log'>;
  /** `--fresh`: ask everything again rather than reusing what is stored. */
  fresh: boolean;
  /** Progress and diagnostics. stderr, per the house rule. */
  log: (line: string) => void;
  /** Injected so the verify stage can be driven without a live server. */
  transport?: Transport;
}

export interface AnalyzeResult {
  outPath: string;
  /** Sentences the book was cut into. */
  sentences: number;
  /** Candidate passages the ranker kept. */
  passages: number;
  /** Verify calls this run made — cached answers are not among them. */
  asked: number;
  /** Verify calls that produced no usable answer. Each was recorded as a skip. */
  degraded: number;
  /** Findings the verifier flagged. */
  flagged: number;
  /** Findings it rejected — stored, not discarded. */
  skipped: number;
}

/** Read the book, take its prose, and cut it into one flat list of sentences. */
function readSentences(bookPath: string, log: (line: string) => void): {
  sentences: BookSentence[];
  bankSha: string;
  generation: string | undefined;
} {
  if (!fs.existsSync(bookPath)) throw new AnalyzeError(`no such book file: ${bookPath}`);
  const book = parseBookFile(stripBom(fs.readFileSync(bookPath, 'utf8')));

  const sentences: BookSentence[] = [];
  let rows = 0;
  for (const row of book.rows) {
    if (row.shelf !== undefined) continue;
    if (!PROSE.has(row.category)) continue;
    rows += 1;
    for (const sentence of splitSentences(row.text)) {
      sentences.push(bookSentence(row.id, sentence.start, sentence.end, sentence.text));
    }
  }
  log(
    `analyze: ${book.rows.length} row(s) in the book, ${rows} of them prose in the flow, cut into `
    + `${sentences.length} sentence(s)`,
  );
  if (sentences.length === 0) {
    throw new AnalyzeError(
      `${bookPath} has no prose to analyse. Its rows are all shelved, or all figures, formulae and `
      + 'tables — there is nothing here for an entailment model to read.',
    );
  }
  return { sentences, bankSha: book.source.bankSha, generation: book.source.generation };
}

/** The categories this run plans, from a file or from the built-in set. */
function readPlan(categoriesPath: string | null | undefined, log: (line: string) => void): RankPlan[] {
  let requested: CategoryRequest[] | null = null;
  if (categoriesPath) {
    if (!fs.existsSync(categoriesPath)) {
      throw new AnalyzeError(`no such categories file: ${categoriesPath}`);
    }
    requested = parseCategoriesJson(stripBom(fs.readFileSync(categoriesPath, 'utf8')), categoriesPath);
  }
  const plan = buildPlan(requested, log);
  const untuned = untunedNames(plan);
  log(
    `analyze: ${plan.length} categor(ies) — ${plan.map((one) => one.category).join(', ')}`
    + (untuned.length > 0
      ? `. Nothing has calibrated ${untuned.join(', ')}, so their counts may be high or low and the `
        + 'report says so in its header.'
      : ''),
  );
  return plan;
}

/**
 * The whole run.
 *
 * ── THE ORDER OF THE FIRST ACTS IS THE CHEAP-CHECK-FIRST RULE ───────────────
 *
 * The Ollama preflight is one HTTP GET and names a missing model in a sentence
 * somebody can act on, so it happens BEFORE a Python interpreter spends ninety
 * seconds loading a gigabyte of weights for a run that was always going to fail
 * at its first verdict.
 *
 * AND THE NLI WORKER IS STARTED LAZILY, at the first sentence nobody has scored
 * yet. A re-run against an unedited book has every score in the report already,
 * and starting an interpreter to load a model that will not be asked a single
 * question is a minute of somebody's afternoon spent proving the cache works.
 * A run that needs it still pays exactly what it always paid.
 */
export async function analyzeBook(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const { log } = opts;
  const { sentences, bankSha, generation } = readSentences(opts.bookPath, log);
  const plan = readPlan(opts.categoriesPath ?? null, log);
  const hypotheses = hypothesisSetVersion(plan);

  const opened = openAnalysisReport({ outPath: opts.outPath, freshRequested: opts.fresh, bankSha });
  log(opened.sentence);
  const report = opened.report;

  const transport = opts.transport ?? fetchTransport();
  const endpoint = normaliseEndpoint(opts.endpoint);
  await requireModel(transport, endpoint, opts.model);

  let worker: NliWorker | null = null;
  const ensureWorker = async (): Promise<NliWorker> => {
    worker ??= await NliWorker.start({ ...opts.nli, log });
    return worker;
  };
  // Read through a function so the `finally` sees the CURRENT value: the
  // compiler cannot see an assignment that happens inside `ensureWorker`, and
  // narrows the variable to the null it was declared with.
  const startedWorker = (): NliWorker | null => worker;

  let result: AnalyzeResult;
  try {
    /*
     * THE CACHED SCORER, and it is the whole of what makes a re-run cheap.
     *
     * Every text is a question — its words, the entailment model, the
     * hypothesis set and the capture floor — and a question already answered in
     * the report is not asked again. What reaches the worker is the misses,
     * deduplicated, because a book repeats sentences ("See note 4.") and paying
     * twice for one question inside a single run would be as wrong as paying
     * twice across two.
     */
    const flat = flattenHypotheses(plan);
    const slidingWindows = sentences.length < SLIDING_WINDOW_SENTENCES
      ? 0
      : sentences.length - SLIDING_WINDOW_SENTENCES + 1;
    const total = sentences.length + slidingWindows;
    let finished = 0;
    log(
      `analyze: ${sentences.length} sentence(s) and ${slidingWindows} sliding window(s) are scored `
      + `against ${flat.texts.length} hypothes(es) — the rank progress line counts all ${total} of `
      + 'them, because each is one text the model has to read',
    );

    const scoreTexts = async (texts: readonly string[]): Promise<number[][]> => {
      const keys = texts.map((text) => rankKey(text, NLI_MODEL_ID, hypotheses, CAPTURE_THRESHOLD));
      const wanted = new Map<string, string>();
      for (const [index, key] of keys.entries()) {
        if (report.rank(key) === undefined && !wanted.has(key)) wanted.set(key, texts[index]!);
      }
      const misses = [...wanted.entries()];
      for (let at = 0; at < misses.length; at += SCORE_BATCH) {
        const batch = misses.slice(at, at + SCORE_BATCH);
        // The worker reports each chunk it finishes, so the bar moves every few
        // seconds rather than once per batch — `finished` itself only advances
        // when the batch's scores are banked, which keeps the count honest if
        // the request dies partway.
        const raw = await (await ensureWorker()).score(
          batch.map(([, text]) => text),
          flat.texts,
          (done) => log(`analyze: rank ${Math.min(total, finished + done)}/${total} sentences`),
        );
        if (raw.length !== batch.length) {
          throw new AnalyzeError(
            `the analysis worker was asked to score ${batch.length} text(s) and answered for `
            + `${raw.length}. A matrix that does not line up with the texts it is about would file `
            + 'every score under the wrong sentence.',
          );
        }
        for (const [offset, [key]] of batch.entries()) {
          report.addRank(key, collapseRow(raw[offset]!, flat.owner, plan.length));
        }
        finished = Math.min(total, finished + batch.length);
        log(`analyze: rank ${finished}/${total} sentences`);
      }
      // Cached texts finished the moment they were looked up; the counter says
      // so rather than jumping at the end of the pass.
      const free = texts.length - misses.length;
      if (free > 0) {
        finished = Math.min(total, finished + free);
        log(`analyze: rank ${finished}/${total} sentences`);
      }
      return keys.map((key) => report.rank(key) ?? new Array<number>(plan.length).fill(0));
    };

    const windows = await rankWindows(sentences, plan, scoreTexts, log);
    result = await verifyStage({
      windows, sentences, plan, report, transport, endpoint,
      model: opts.model, hypotheses, bankSha, generation, log,
    });
  } finally {
    startedWorker()?.stop();
    /*
     * The card back, best-effort, exactly as translate ends. It runs in the
     * `finally` so a FAILED run gives the memory back too, and it can never
     * fail a run that produced its report — a server that has already gone away
     * has, by definition, released what this was asking it to release.
     */
    const freed = await unloadModel(transport, endpoint, opts.model);
    log(freed
      ? `analyze: asked ollama to unload "${opts.model}" — the card is free for the next job.`
      : `analyze: ollama did not acknowledge unloading "${opts.model}". If it is still resident it `
        + 'will fall out on its own idle timer.');
  }
  return result;
}

/**
 * The verify stage: one question per (window, category), sequential, in
 * DESCENDING window score.
 *
 * SEQUENTIAL is not timidity. Ollama serialises requests per model anyway, so
 * concurrency here buys queueing rather than throughput, and it would make the
 * progress line a lie about which passage is being judged.
 *
 * DESCENDING is Owen's ruling and it is the answer to the cost of capturing
 * everything: the strongest passages are verified first, so a run interrupted
 * an hour in has already finished the findings most worth trusting, and the
 * append-as-landed report makes them readable before the loose tail is done.
 */
async function verifyStage(args: {
  windows: readonly FlagWindow[];
  sentences: readonly BookSentence[];
  plan: readonly RankPlan[];
  report: AnalysisReport;
  transport: Transport;
  endpoint: string;
  model: string;
  hypotheses: string;
  bankSha: string;
  generation: string | undefined;
  log: (line: string) => void;
}): Promise<AnalyzeResult> {
  const { windows, sentences, report, log } = args;

  interface Job {
    window: FlagWindow;
    category: WindowCategory;
    passage: string;
    prompt: string;
    key: string;
  }
  const jobs: Job[] = [];
  for (const window of windows) {
    const passage = sentences.slice(window.contextFrom, window.contextTo + 1).map((s) => s.text);
    const joined = passage.join('\n');
    for (const category of window.categories) {
      const prompt = buildVerificationPrompt(passage, category.category, category.proposition);
      jobs.push({
        window,
        category,
        passage: joined,
        prompt,
        key: verdictKey(joined, category.category, args.model, prompt),
      });
    }
  }

  /*
   * ONE num_ctx FOR EVERY CALL IN THE STAGE, sized from the largest prompt.
   * Ollama fully reloads the model on ANY num_ctx change, and these prompts
   * differ only by the length of their passage — per-call sizing would buy
   * reloads and nothing else.
   */
  const numCtx = stageNumCtx(jobs.map((job) => job.prompt), args.model);
  const cached = jobs.filter((job) => report.verdict(job.key) !== undefined).length;
  log(
    `analyze: ${windows.length} passage(s) and ${jobs.length} verify call(s) at num_ctx ${numCtx} `
    + `on ${args.model}; ${cached} of them are already answered and cost nothing.`,
  );

  const flaggedByWindow = new Map<FlagWindow, WindowCategory[]>();
  let asked = 0;
  let degraded = 0;
  for (const [index, job] of jobs.entries()) {
    let verdict = report.verdict(job.key);
    if (verdict === undefined) {
      asked += 1;
      const outcome = await askVerdict(args.transport, args.endpoint, args.model, job.prompt, numCtx);
      if (outcome.verdict === null) {
        /*
         * A DEGRADATION IS A SKIP AND A WARNING, NEVER A FLAG. There are three
         * ways to get here — the call failed, the answer hit the token ceiling,
         * or the answer carried no verdict — and all three mean the same thing:
         * nothing judged this passage. An unreadable answer must not be able to
         * accuse anybody.
         *
         * It is NOT stored. A stored skip is the verifier's answer, and a
         * re-run must be free to ask again rather than inheriting a network
         * failure as though it were a judgment.
         */
        degraded += 1;
        log(
          `analyze: no verdict for ${job.category.category} at ${sentences[job.window.firedFrom]!.row}`
          + ` — ${outcome.degraded}; this passage is recorded as a skip`,
        );
        verdict = 'skip';
      } else {
        verdict = outcome.verdict;
        report.addVerdict(job.key, verdict);
      }
    }
    if (verdict === 'flag') {
      const list = flaggedByWindow.get(job.window);
      if (list) list.push(job.category);
      else flaggedByWindow.set(job.window, [job.category]);
    }
    log(`analyze: verify ${index + 1}/${jobs.length} (${job.category.category})`);
  }

  /*
   * EVERY CALL UNUSABLE IS A BROKEN STAGE, NOT A QUIET RESULT. The report would
   * say every passage was rejected, which reads exactly like a clean book, and
   * nothing on the disk would distinguish the two. So the run refuses — and it
   * refuses BEFORE the swap, so the report that is there stays as it was and
   * every score this run paid for is already appended for the next one.
   */
  if (jobs.length > 0 && degraded === jobs.length) {
    throw new AnalyzeError(
      `not one of the ${jobs.length} verification call(s) produced a usable verdict. The ranking is `
      + 'recorded and costs nothing to redo; the verdicts are what this run could not get, and a '
      + 'report saying every passage was rejected would be indistinguishable from a clean book.',
    );
  }

  const findings: { finding: WindowFinding; window: FlagWindow }[] = windows
    .map((window) => ({ finding: windowFinding(window, flaggedByWindow.get(window) ?? []), window }))
    .sort((a, b) => a.finding.from - b.finding.from || a.finding.to - b.finding.to);

  const rows: AnalysisFinding[] = [];
  for (const [index, entry] of findings.entries()) {
    rows.push(...findingRows(entry.finding, sentences, index + 1));
  }

  report.finish(
    analysisHeader({
      bankSha: args.bankSha,
      ...(args.generation !== undefined ? { generation: args.generation } : {}),
      nli: NLI_MODEL_ID,
      hypotheses: args.hypotheses,
      verify: args.model,
      capture: { threshold: CAPTURE_THRESHOLD, rescue: RESCUE_FLOOR },
      categories: args.plan.map((one) => one.category),
      untuned: untunedNames(args.plan),
      hues: planHues(args.plan),
    }),
    rows,
  );

  const flagged = findings.filter((one) => one.finding.verdict === 'flag').length;
  log(
    `analyze: ${flagged} passage(s) flagged and ${findings.length - flagged} rejected, written as `
    + `${rows.length} row(s) across the blocks they touch`
    + (degraded > 0 ? `; ${degraded} call(s) produced no usable answer and were recorded as skips` : ''),
  );

  return {
    outPath: report.outPath,
    sentences: sentences.length,
    passages: windows.length,
    asked,
    degraded,
    flagged,
    skipped: findings.length - flagged,
  };
}

/**
 * One finding as report rows — one per block the passage touches.
 *
 * The sentences of a span are contiguous in the global list, and a block's
 * sentences are contiguous within that, so the split is a walk: each run of
 * sentences sharing a row becomes one row of the report, carrying the first
 * sentence's `start` and the last one's `end`. Every row of the finding repeats
 * the category, the score and the verdict, because the app draws a row on its
 * own and a row that had to be joined to a sibling to be understood would be a
 * second lookup at every draw.
 *
 * `sentences` IS THIS ROW'S COUNT, not the finding's. Every other number on the
 * row describes this block's slice, and mixing scopes inside one object is how
 * a consumer ends up highlighting one paragraph and captioning it with
 * another's arithmetic. The finding's total is the sum over its `hit`.
 */
export function findingRows(
  finding: WindowFinding,
  sentences: readonly BookSentence[],
  hit: number,
): AnalysisFinding[] {
  const rows: AnalysisFinding[] = [];
  let at = finding.from;
  while (at <= finding.to) {
    const row = sentences[at]!.row;
    const start = sentences[at]!.start;
    let end = sentences[at]!.end;
    let count = 0;
    while (at <= finding.to && sentences[at]!.row === row) {
      end = sentences[at]!.end;
      count += 1;
      at += 1;
    }
    rows.push({
      kind: 'finding',
      hit,
      id: row,
      start,
      end,
      category: finding.category,
      also: finding.also,
      score: Math.round(finding.score * 10_000) / 10_000,
      verdict: finding.verdict,
      sentences: count,
    });
  }
  return rows;
}
