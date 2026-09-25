/**
 * analyze/run — `foundry analyze`: the rank file's passages, put to a model.
 *
 * An analysis is two acts on two models, run by the app as two rows of its
 * queue (the same shape as a cleanup's triage and its cleanup):
 *
 *   1. RANK — `foundry analyze-rank` (snap.ts): every sentence of the book,
 *      in groups of three, asked of a small decide model as one choice over
 *      the categories and "none". Its answers are a rating map, written to the
 *      rank file. Exhaustive and cheap: nothing is missed because a model
 *      stopped early, which is exactly how open-ended "read this chapter and
 *      find the quotes" always fails.
 *   2. VERIFY — this file. The rating map becomes spans, sections and
 *      paragraph-sized passages (spans.ts, pure), and one schema-constrained
 *      model call per (passage, category) answers one question: is the author
 *      asserting this, or reporting, quoting, questioning or arguing against
 *      it? — with the verifier's reason. Every verdict is stored; only the
 *      flags are findings.
 *
 * NOTHING HERE MATCHES A QUOTATION TO ANYTHING, EVER. Foundry has block
 * identity, so every finding is a block id and a pair of character offsets
 * measured from the book file's own text. The deprecated BookForge analysis
 * asked a model for quotes and then fuzzy-matched the (often reworded) quotes
 * back into the book, which is why a whole recovery module exists over there.
 *
 * ── WHAT THIS FILE OWNS ─────────────────────────────────────────────────────
 *
 * The order of operations, the check that the rank file is about THIS book and
 * THESE questions, and where an answer comes from — the report's cache or a
 * model. Every rule about HOW a stage works lives in the stage's own file, and
 * this one does not repeat any of them.
 */
import {
  DEFAULT_TEXT_CONCURRENCY, openModelServer, releaseModel, resolveConcurrency,
  type ModelServer, type ServerKind,
} from '../translate/model-server.js';
import {
  deadlineForConcurrency, fetchTransport, usageLine, type Transport,
} from '../translate/transport.js';
import { optionSetVersion, planHues, planNames, untunedNames, type RankPlan } from './plan.js';
import { AnalyzeError, readProse } from './prose.js';
import type { BookSentence, FlagWindow } from './rank.js';
import {
  analysisHeader,
  openAnalysisReport,
  verdictKey,
  type AnalysisFinding,
  type AnalysisReport,
} from './report.js';
import { buildUnits, readPlan, readRankFile, type RankFile } from './snap.js';
import { rankFromRatingMap, spanParamsVersion } from './spans.js';
import {
  askVerdict,
  buildVerificationPrompt,
  stageNumCtx,
  windowFinding,
  VERIFY_PROMPT_VERSION,
  type FlaggedCategory,
  type Verification,
  type WindowFinding,
} from './verify.js';

export { AnalyzeError };

/**
 * How many verify calls are in flight at once on the OpenAI door when nobody
 * said a number.
 *
 * That server batches the requests in flight TOGETHER (docs/VLLM.md), and this
 * stage is hundreds of tiny closed questions over one loaded model — the shape
 * that gains most from it. `DEFAULT_TEXT_CONCURRENCY` says why twelve. On Ollama
 * `concurrencyFor` answers four, and even that is generous: Ollama serialises
 * per model unless the server was configured otherwise, so a pool there buys
 * queueing rather than throughput and the verdicts do not move either way.
 */
const DEFAULT_ANALYZE_CONCURRENCY = DEFAULT_TEXT_CONCURRENCY;

export interface AnalyzeOptions {
  /** The book file. Read, never written. */
  bookPath: string;
  /** The rank file `analyze-rank` wrote for this book. Read, never written. */
  ranksPath: string;
  /** Where the report goes. Required — foundry never invents a name. */
  outPath: string;
  /** A `--categories` file, or null for every built-in category — the SAME one the rank used. */
  categoriesPath?: string | null;
  /**
   * The model that answers the verdicts.
   *
   * Under `--server openai` this may be absent, and absent MEANS something
   * there: the server holds one resident model, so the run asks the server what
   * it is, uses it, and writes that name into the verdict cache key and the
   * report header (src/translate/vllm.ts). Under `--server ollama` it is
   * required and an absent one is refused by name, because an Ollama holds a
   * library. A name that is given is proved before any work starts, either way.
   */
  model?: string;
  /** The server. Never started, never stopped, never loaded by this program. */
  endpoint: string;
  /** Which dialect answers — `--server`. Default `openai`. */
  server?: ServerKind;
  /**
   * Verify calls in flight at once. Default `DEFAULT_ANALYZE_CONCURRENCY` on the
   * OpenAI door, `DEFAULT_OLLAMA_CONCURRENCY` on Ollama (`concurrencyFor`).
   *
   * It changes the SPEED and never a verdict: every call is an independent
   * closed question at temperature 0, the answers are put back into the jobs'
   * own order before a single finding is composed, and the cache is keyed by
   * the question rather than by when it was asked.
   */
  concurrency?: number;
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
  /** Passages the ranker put to the verifier. */
  passages: number;
  /** Verify calls this run made — cached answers are not among them. */
  asked: number;
  /** Verify calls that produced no usable answer. None of them is a finding. */
  degraded: number;
  /** Passages the verifier flagged — the findings. */
  flagged: number;
  /** Passages it rejected entirely — stored in the cache, not reported. */
  skipped: number;
}

/**
 * THE RANK FILE MUST BE ABOUT THIS BOOK AND THESE QUESTIONS, and each way it
 * can fail to be is refused by name. The rank and the verify are two processes
 * the queue runs one after the other; a rank file from another book, or from
 * another set of categories, would light passages that were never scored for
 * what the report will say they are.
 */
function checkRankFile(
  file: RankFile,
  ranksPath: string,
  sentences: readonly BookSentence[],
  bankSha: string,
  plan: readonly RankPlan[],
): void {
  if (file.bankSha !== bankSha) {
    throw new AnalyzeError(
      `${ranksPath} ranked the book from bank ${file.bankSha}, and this book comes from ${bankSha}. `
      + 'Rank this book, then verify it.',
    );
  }
  const options = optionSetVersion(plan);
  if (file.options !== options) {
    throw new AnalyzeError(
      `${ranksPath} was ranked against a different set of categories (${file.options}; these are `
      + `${options}). The rank and the verify must be given the same --categories.`,
    );
  }
  const units = buildUnits(sentences);
  const same = units.length === file.units.length
    && units.every((unit, i) => unit.text === file.units[i]!.text
      && unit.sentenceFrom === file.units[i]!.sentenceFrom && unit.sentenceTo === file.units[i]!.sentenceTo);
  if (!same) {
    throw new AnalyzeError(
      `${ranksPath} was ranked from ${file.units.length} unit(s) and this book cuts into ${units.length} `
      + 'that do not match them — the book was read differently by the build that ranked it. Rank it again.',
    );
  }
}

/**
 * The whole run.
 *
 * THE CHEAP CHECKS COME FIRST: the rank file is read and matched against the
 * book before the server is asked anything, and the server preflight is one
 * HTTP GET that names a missing model in a sentence somebody can act on.
 */
export async function analyzeBook(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const { log } = opts;
  const { sentences, bankSha, generation } = readProse(opts.bookPath, 'analyze', log);
  const plan = readPlan(opts.categoriesPath ?? null, log);
  const ranks = readRankFile(opts.ranksPath);
  checkRankFile(ranks, opts.ranksPath, sentences, bankSha, plan);

  const ranked = rankFromRatingMap(ranks, sentences, plan);
  const calls = ranked.windows.reduce((n, w) => n + w.categories.length, 0);
  log(
    `analyze: the ranking by ${ranks.model.id} made ${ranked.spans.length} span(s), ${ranked.passages.length} `
    + `section(s) and ${ranked.windows.length} passage(s) to verify — ${calls} question(s)`
    + (ranks.gated > 0 ? `; ${ranks.gated} of its answers were read as no evidence` : ''),
  );

  const opened = openAnalysisReport({ outPath: opts.outPath, freshRequested: opts.fresh, bankSha });
  log(opened.sentence);
  const report = opened.report;

  const kind: ServerKind = opts.server ?? 'openai';
  // Decided before the transport, because the deadline is a function of it: a
  // pool of `n` against a server that queues gives the last request `n`
  // requests' worth of waiting before its own clock starts. `src/clean/run.ts`
  // carries the whole argument; `deadlineForConcurrency` is transport.ts's.
  const concurrency = await resolveConcurrency({
    asked: opts.concurrency,
    kind,
    openaiDefault: DEFAULT_ANALYZE_CONCURRENCY,
    endpoint: opts.endpoint,
    transport: opts.transport,
    log,
  });
  const transport = opts.transport ?? fetchTransport(deadlineForConcurrency(concurrency));
  /*
   * PROVED FIRST, and it also RESOLVES: on the OpenAI door an absent model means
   * the served one, and the answer has to be in hand before the verdict keys are
   * composed (`verdictKey` hashes the model's name), or this run would file its
   * answers under a name that did not answer them. On Ollama the same call is
   * what refuses an absent name.
   */
  const server = await openModelServer({
    kind,
    transport,
    endpoint: opts.endpoint,
    log,
    ...(opts.model === undefined ? {} : { model: opts.model }),
  });

  try {
    return await verifyStage({
      windows: ranked.windows, sentences, plan, report, transport, server, concurrency,
      ranks, bankSha, generation, log,
    });
  } finally {
    /*
     * The card back, best-effort, exactly as translate ends. It runs in the
     * `finally` so a FAILED run gives the memory back too, and it can never fail
     * a run that produced its report — a server that has already gone away has,
     * by definition, released what this was asking it to release. On the OpenAI
     * door nothing was loaded by this pass and nothing is taken off; the line
     * says so once, because silence would look like a release that happened.
     */
    const outcome = await releaseModel(transport, kind, server.endpoint, server.model);
    log(outcome === 'not-ours'
      ? 'analyze: nothing to unload — this run never loaded a model, and nothing on the other end '
        + 'is this job\'s to take down (translate/model-server.ts).'
      : outcome === 'released'
        ? `analyze: asked ollama to unload "${server.model}" — the card is free for the next job.`
        : `analyze: ollama did not acknowledge unloading "${server.model}". If it is still resident `
          + 'it will fall out on its own idle timer.');
    /*
     * WHAT THE RUN SPENT, once, last, in this act's prefix — and in the
     * `finally` for the release's own reason: a stage that was interrupted an
     * hour in still spent what it spent. Null and therefore silent where no
     * server reported usage; see `usageLine`.
     */
    const spent = usageLine('analyze');
    if (spent !== null) log(spent);
  }
}

/**
 * The verify stage: one question per (window, category), strongest window
 * first, `concurrency` of them in flight at once.
 *
 * STRONGEST FIRST is Owen's ruling and it is the answer to the cost of
 * verifying everything: the strongest passages are verified first, so a run
 * interrupted an hour in has already finished the findings most worth trusting,
 * and the append-as-landed cache means the next run picks up from there. A POOL
 * DOES NOT WEAKEN THAT — the jobs are DISPATCHED in the same order and only
 * land out of it, so what is finished first is still what was worth finishing
 * first.
 *
 * ── WHAT THE POOL IS NOT ALLOWED TO MOVE ───────────────────────────────────
 *
 * The findings. Answers are collected into a map and the flagged categories
 * are composed AFTERWARDS by walking `jobs` in their own order, so a window's
 * `also` list is in descending score whatever order the answers came back in.
 * `askAboutEach`'s rule in the cleanup, for its reason: a pool may change how
 * long a run takes and must never change what it wrote.
 */
async function verifyStage(args: {
  windows: readonly FlagWindow[];
  sentences: readonly BookSentence[];
  plan: readonly RankPlan[];
  report: AnalysisReport;
  transport: Transport;
  server: ModelServer;
  concurrency: number;
  ranks: RankFile;
  bankSha: string;
  generation: string | undefined;
  log: (line: string) => void;
}): Promise<AnalyzeResult> {
  const { windows, sentences, report, log } = args;

  interface Job {
    window: FlagWindow;
    category: FlaggedCategory['category'];
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
        prompt,
        key: verdictKey(joined, category.category, args.server.model, prompt),
      });
    }
  }

  /*
   * ONE num_ctx FOR EVERY CALL IN THE STAGE, sized from the largest prompt.
   * Ollama fully reloads the model on ANY num_ctx change, and these prompts
   * differ only by the length of their passage — per-call sizing would buy
   * reloads and nothing else. It is computed on both doors and SENT on one:
   * `askConstrained` drops it for an OpenAI-compatible server, whose window was
   * fixed when the model was made resident.
   */
  const numCtx = stageNumCtx(jobs.map((job) => job.prompt), args.server.model);
  const cached = jobs.filter((job) => report.verdict(job.key) !== undefined).length;
  log(
    `analyze: ${windows.length} passage(s) and ${jobs.length} verify call(s) `
    + (args.server.kind === 'ollama' ? `at num_ctx ${numCtx} ` : '')
    + `on ${args.server.model}`
    + (args.concurrency > 1 ? `, up to ${args.concurrency} in flight` : '')
    + `; ${cached} of them are already answered and cost nothing.`,
  );

  let asked = 0;
  let degraded = 0;
  let finished = 0;
  let next = 0;
  const answers = new Map<Job, Verification>();

  const judge = async (job: Job): Promise<void> => {
    let answer = report.verdict(job.key);
    if (answer === undefined) {
      asked += 1;
      const outcome = await askVerdict(args.transport, args.server, job.prompt, numCtx);
      if (outcome.verification === null) {
        /*
         * A DEGRADATION IS NEVER A FLAG. There are three ways to get here — the
         * call failed, the answer hit the token ceiling, or the answer carried
         * no verdict — and all three mean the same thing: nothing judged this
         * passage. An unreadable answer must not be able to accuse anybody.
         *
         * It is NOT stored. A stored skip is the verifier's answer, and a re-run
         * must be free to ask again rather than inheriting a network failure as
         * though it were a judgment.
         */
        degraded += 1;
        log(
          `analyze: no verdict for ${job.category.category} at ${sentences[job.window.firedFrom]!.row}`
          + ` — ${outcome.degraded}; it is not a finding, and the next run asks again`,
        );
      } else {
        answer = outcome.verification;
        report.addVerdict(job.key, answer);
      }
    }
    if (answer !== undefined) answers.set(job, answer);
    finished += 1;
    log(`analyze: verify ${finished}/${jobs.length} (${job.category.category})`);
  };

  /*
   * THE POOL: workers pull from one index, so the jobs go OUT in the array's
   * own order and a worker that finishes early takes the next strongest rather
   * than a slice it was handed at the start.
   */
  const workers = Math.max(1, Math.min(args.concurrency, jobs.length));
  const pull = async (): Promise<void> => {
    for (let at = next; at < jobs.length; at = next) {
      next = at + 1;
      await judge(jobs[at]!);
    }
  };
  await Promise.all(Array.from({ length: workers }, pull));

  /*
   * EVERY CALL UNUSABLE IS A BROKEN STAGE, NOT A QUIET RESULT. The report would
   * say nothing was found, which reads exactly like a clean book, and nothing
   * on the disk would distinguish the two. So the run refuses — and it refuses
   * BEFORE the swap, so the report that is there stays as it was.
   */
  if (jobs.length > 0 && degraded === jobs.length) {
    throw new AnalyzeError(
      `not one of the ${jobs.length} verification call(s) produced a usable verdict. The ranking is `
      + 'in the rank file and costs nothing to redo; the verdicts are what this run could not get, and a '
      + 'report with nothing in it would be indistinguishable from a clean book.',
    );
  }

  /*
   * AND THE FINDINGS ARE COMPOSED FROM THE JOBS' OWN ORDER, never from the
   * order the answers landed in.
   */
  const flaggedByWindow = new Map<FlagWindow, FlaggedCategory[]>();
  for (const job of jobs) {
    const answer = answers.get(job);
    if (answer?.verdict !== 'flag') continue;
    const list = flaggedByWindow.get(job.window) ?? [];
    list.push({ category: job.category, reason: answer.reason });
    flaggedByWindow.set(job.window, list);
  }

  const findings: WindowFinding[] = windows
    .map((window) => windowFinding(flaggedByWindow.get(window) ?? []))
    .filter((finding): finding is WindowFinding => finding !== null)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const rows: AnalysisFinding[] = [];
  for (const [index, finding] of findings.entries()) {
    rows.push(...findingRows(finding, sentences, index + 1));
  }

  report.finish(
    analysisHeader({
      bankSha: args.bankSha,
      ...(args.generation !== undefined ? { generation: args.generation } : {}),
      ranker: 'snap-v1',
      decide: args.ranks.model.id,
      options: optionSetVersion(args.plan),
      spans: spanParamsVersion(),
      verify: args.server.model,
      prompt: VERIFY_PROMPT_VERSION,
      categories: args.plan.map((one) => one.category),
      untuned: untunedNames(args.plan),
      hues: planHues(args.plan),
      names: planNames(args.plan),
    }),
    rows,
  );

  const answered = windows.filter((window) => jobs.some((job) => job.window === window && answers.has(job)));
  log(
    `analyze: ${findings.length} passage(s) flagged and ${answered.length - findings.length} rejected, `
    + `written as ${rows.length} row(s) across the blocks they touch`
    + (degraded > 0 ? `; ${degraded} call(s) produced no usable answer and are not findings` : ''),
  );

  return {
    outPath: report.outPath,
    sentences: sentences.length,
    passages: windows.length,
    asked,
    degraded,
    flagged: findings.length,
    skipped: answered.length - findings.length,
  };
}

/**
 * One finding as report rows — one per block the passage touches.
 *
 * The sentences of a span are contiguous in the global list, and a block's
 * sentences are contiguous within that, so the split is a walk: each run of
 * sentences sharing a row becomes one row of the report, carrying the first
 * sentence's `start` and the last one's `end`. Every row of the finding repeats
 * the category, the reason and the score, because the app draws a row on its
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
      reason: finding.reason,
      also: finding.also,
      alsoReasons: finding.alsoReasons,
      score: Math.round(finding.score * 10_000) / 10_000,
      sentences: count,
    });
  }
  return rows;
}
