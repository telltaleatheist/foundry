/**
 * tag/run — one document, read against one person's tag vocabulary.
 *
 * The question is not analyze's. `analyze` reads a BOOK against calibrated
 * categories and reports WHERE each finding is, because a reader is going to be
 * travelled to the passage. This command reads ONE DOCUMENT and answers a set:
 * which of her tags apply, and what else it would be called. There is no map, no
 * severity, no score and no explanation in the answer — the tag set IS the
 * answer, and everything else would be this program inventing evidence
 * (docs/TAGGING.md, docs/ANALYSIS.md §1).
 *
 * Three stages, and the first two are analyze's own bodies rather than copies of
 * them:
 *
 *   1. RANK — every sentence and every sliding three-sentence window scored
 *      against every tag by the same resident NLI worker, at the same widest
 *      net. Exhaustive and cheap: nothing is missed because a model stopped
 *      early, which is how "read this and list its topics" always fails.
 *   2. VERIFY — one schema-constrained Ollama call per tag that survived,
 *      carrying that tag's best passages: does this document genuinely concern
 *      it? An entailment score says the words are close; it cannot say the
 *      document is ABOUT the thing.
 *   3. SUGGEST — one call over the document's highest-signal passages and her
 *      whole vocabulary: what else would you call this?
 *
 * ── NO REPORT FILE, AND THAT IS A SIZE DECISION ─────────────────────────────
 *
 * `analyze`'s report is a cost cache because a book is hours: it appends and
 * fsyncs each verdict so a killed run keeps what it paid for. A tag run is one
 * document — minutes — so it holds its answers in memory and writes once at the
 * end. A resumable file for a run this short would be machinery to maintain in
 * exchange for nothing.
 *
 * ── AND NO FALLBACKS, THE SAME ONES ANALYZE DOES NOT HAVE ───────────────────
 *
 * A missing interpreter, a missing package, a missing model: the run ends with a
 * sentence naming what was looked for and where (ARCHITECTURE.md §8). There is
 * no LLM-only route when the worker is absent and no NLI-only route when Ollama
 * is, because either one answers a different question from the one the JSON
 * claims to answer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import { NliWorker, type NliWorkerOptions } from '../analyze/nli-bridge.js';
import type { RankPlan } from '../analyze/plan.js';
import {
  collapseRow,
  flattenHypotheses,
  scoreSentenceLevel,
  scoreWindowLevel,
  SLIDING_WINDOW_SENTENCES,
  type BookSentence,
  type FlagCandidate,
} from '../analyze/rank.js';
import { stageNumCtx } from '../analyze/verify.js';
import {
  fetchTransport,
  normaliseEndpoint,
  requireModel,
  unloadModel,
  type Transport,
} from '../translate/ollama.js';
import { askAboutness, askSuggestions, buildAboutnessPrompt, buildSuggestPrompt, cleanSuggestions } from './ask.js';
import { evidenceByTag, stridedSample, topPassages } from './evidence.js';
import { readDocument, TagError, type TagDocument } from './input.js';
import { decideNliOnly } from './nli-decide.js';

/**
 * How many texts go to the worker in one request.
 *
 * analyze's 500, and the bound is about PROGRESS rather than memory (the worker
 * chunks internally): one request for a whole document would be one line at the
 * start, one at the end, and silence between them, which a person watching a job
 * cannot tell from a hang.
 */
const SCORE_BATCH = 500;

export interface TagOptions {
  /** The plain-text document. Read, never written. */
  docPath: string;
  /**
   * Her vocabulary, verbatim and already deduplicated (`readVocabulary`).
   *
   * Passed in rather than read here because the CALLER decides, before any work
   * begins, whether this run needs a Python at all: an empty vocabulary ranks
   * nothing and must not be refused for want of an interpreter it will never
   * start (`commands.ts`, and analyze's own lazy-worker ruling).
   */
  tags: readonly string[];
  /** Where the JSON goes, or null to put it on stdout. */
  outPath?: string | null;
  /** The Ollama model that answers both questions. */
  model: string;
  /** The Ollama server. Never started, never stopped by this program. */
  endpoint: string;
  /** `--nli-python`, `--nli-home`, `--fetch-nli-model`. */
  nli: Omit<NliWorkerOptions, 'log'>;
  /**
   * `--nli-only`: judge from entailment scores alone. No Ollama is contacted,
   * `suggested` is always empty, and the caller has refused an empty
   * vocabulary before this runs (there would be nothing left to answer).
   */
  nliOnly?: boolean;
  /** Progress and diagnostics. stderr, per the house rule. */
  log: (line: string) => void;
  /** Injected so the model stages can be driven without a live server. */
  transport?: Transport;
}

/**
 * The answer, and the whole of it. This object IS the output JSON.
 *
 * IT IS A CROSS-REPO CONTRACT: the software that shells this command reads the
 * two keys directly, and both are always present even when empty. Fields may be
 * ADDED and are never renamed or removed, and a change is announced before it
 * ships rather than met as a parse failure on the far side — the same standing
 * posture as `analyze`'s report header and `vtt-book`'s decode recipe
 * (docs/TAGGING.md §3).
 */
export interface TagAnswer {
  /** Her tags that hold for this document, in her file's order, her spelling. */
  applies: string[];
  /** New tags the document supports, in the order the model offered them. */
  suggested: string[];
  /**
   * Which engine produced this answer — ADDED 2026-08-29 and announced on the
   * cross-repo channel, per the contract's fields-are-added-never-renamed rule.
   * `full` is the NLI-rank + LLM-verify pipeline; `nli-only` judged from
   * entailment scores alone and can never suggest, so its `suggested` is empty
   * by declared inability rather than by claim.
   */
  engine: 'full' | 'nli-only';
}

export interface TagResult {
  answer: TagAnswer;
  /** Where the JSON was written, or null where it went to the caller. */
  outPath: string | null;
  /** Sentences the document was cut into. */
  sentences: number;
  /** Tags the ranker found any passage for — the ones that cost a call. */
  candidates: number;
  /** Model calls this run made. */
  asked: number;
  /** Calls that produced no usable answer. */
  degraded: number;
}

/**
 * Her tags, as a rank plan.
 *
 * ── THE HYPOTHESIS IS ABOUTNESS, AND THE TEMPLATE IS NOT TOUCHED ────────────
 *
 * A category in `analyze` carries STANCE hypotheses — propositions a sentence
 * can entail, phrased as the thing an author would be asserting. A tag is not a
 * claim anybody asserts; it is a subject, and the question a zero-shot model is
 * being asked here is topical: is this text about this thing.
 *
 * The worker wraps every hypothesis in the transformers pipeline's DEFAULT
 * template, `"This example is {}."`, and that wrapper is the calibration —
 * `nli_worker.py` carries the incident where changing it silently moved the
 * threshold, and it is not changed for this command either. So the hypothesis is
 * written to COMPLETE it: `about <tag>` becomes "This example is about free
 * speech.", which is the textbook zero-shot topic form. The stance/aboutness
 * difference lives in these two words and nowhere else.
 *
 * `proposition` is required by the shared type and is unused here: it exists so
 * analyze's verifier can state a claim, and this command's verifier asks about
 * the tag itself. `tuned` is false because nothing has been calibrated against a
 * lawyer's vocabulary — the thresholds are analyze's, carried over whole.
 */
export function tagPlan(tags: readonly string[]): RankPlan[] {
  return tags.map((tag) => ({
    category: tag,
    label: tag,
    hypotheses: [`about ${tag}`],
    proposition: tag,
    tuned: false,
  }));
}

/** The output JSON, in the one place both stdout and `--out` take it from. */
export function formatTagJson(answer: TagAnswer): string {
  return `${JSON.stringify(answer, null, 2)}\n`;
}

/**
 * Rank the document against the plan: every sentence, every sliding window.
 *
 * The two passes are `analyze/rank.ts`'s own, called rather than copied, so the
 * capture floor, the rescue rule and the window dedupe are one body of code for
 * both commands. Their log lines are theirs too, and `shared` is the wrapper
 * that only moves them under this command's prefix (see `tagDocument`).
 */
async function rankCandidates(
  sentences: readonly BookSentence[],
  plan: readonly RankPlan[],
  opts: TagOptions,
  shared: (line: string) => void,
  worker: () => Promise<NliWorker>,
): Promise<FlagCandidate[]> {
  const flat = flattenHypotheses(plan);
  const slidingWindows = sentences.length < SLIDING_WINDOW_SENTENCES
    ? 0
    : sentences.length - SLIDING_WINDOW_SENTENCES + 1;
  const total = sentences.length + slidingWindows;
  let finished = 0;

  const scoreTexts = async (texts: readonly string[]): Promise<number[][]> => {
    const rows: number[][] = [];
    for (let at = 0; at < texts.length; at += SCORE_BATCH) {
      const batch = texts.slice(at, at + SCORE_BATCH);
      const raw = await (await worker()).score(
        batch,
        flat.texts,
        // The worker reports each chunk it finishes, so the count moves every
        // few seconds; `finished` itself only advances when a batch is banked,
        // which keeps it honest if the request dies partway.
        (done) => opts.log(`tag: rank ${Math.min(total, finished + done)}/${total}`),
      );
      if (raw.length !== batch.length) {
        throw new TagError(
          `the analysis worker was asked to score ${batch.length} text(s) and answered for `
          + `${raw.length}. A matrix that does not line up with the texts it is about would file `
          + 'every score under the wrong tag.',
        );
      }
      for (const row of raw) rows.push(collapseRow(row, flat.owner, plan.length));
      finished = Math.min(total, finished + batch.length);
      opts.log(`tag: rank ${finished}/${total}`);
    }
    return rows;
  };

  const sentenceLevel = await scoreSentenceLevel(sentences, plan, scoreTexts, shared);
  const windowLevel = await scoreWindowLevel(sentences, plan, sentenceLevel, scoreTexts, shared);
  return [...sentenceLevel, ...windowLevel];
}

/**
 * The whole run.
 *
 * THE OLLAMA PREFLIGHT IS FIRST, and the worker is started LAZILY at the first
 * text nobody has scored — analyze's cheap-check-first rule, for its reason: one
 * HTTP GET names a missing model in a sentence somebody can act on, and it must
 * not come after ninety seconds of loading a gigabyte of weights for a run that
 * was always going to fail at its first question. A run with no tags never
 * starts an interpreter at all.
 */
export async function tagDocument(opts: TagOptions): Promise<TagResult> {
  const { log } = opts;
  const document = readDocument(opts.docPath, log);
  const plan = tagPlan(opts.tags);

  if (opts.nliOnly) return tagNliOnly(opts, document, plan);

  const transport = opts.transport ?? fetchTransport();
  const endpoint = normaliseEndpoint(opts.endpoint);
  await requireModel(transport, endpoint, opts.model);

  /*
   * The stages this command SHARES with analyze say `analyze:` at the front of
   * their own lines — the worker's load, the two ranking passes. A line naming a
   * command nobody ran is a small lie in a log somebody will read while trying
   * to work out what happened, so the prefix is moved and the sentence is left
   * exactly as its own file wrote it.
   */
  const shared = (line: string): void => log(
    line.startsWith('analyze: ') ? `tag: ${line.slice('analyze: '.length)}` : line,
  );

  let worker: NliWorker | null = null;
  const ensureWorker = async (): Promise<NliWorker> => {
    worker ??= await NliWorker.start({ ...opts.nli, log: shared });
    return worker;
  };
  // Read through a function so the `finally` sees the CURRENT value: the
  // compiler cannot see an assignment made inside `ensureWorker` and narrows the
  // variable to the null it was declared with.
  const startedWorker = (): NliWorker | null => worker;

  let result: TagResult;
  try {
    const candidates = plan.length === 0
      ? []
      : await rankCandidates(document.sentences, plan, opts, shared, ensureWorker);
    result = await answerStage({ document, candidates, opts, transport, endpoint });
  } finally {
    startedWorker()?.stop();
    /*
     * The card back, best-effort, exactly as analyze and translate end. It runs
     * in the `finally` so a FAILED run gives the memory back too, and it can
     * never fail a run that produced its answer — a server that has already gone
     * away has, by definition, released what this was asking it to release.
     */
    const freed = await unloadModel(transport, endpoint, opts.model);
    log(freed
      ? `tag: asked ollama to unload "${opts.model}" — the card is free for the next job.`
      : `tag: ollama did not acknowledge unloading "${opts.model}". If it is still resident it will `
        + 'fall out on its own idle timer.');
  }
  return result;
}

/**
 * The NLI-only run: rank exactly as the full engine ranks, then decide from
 * the scores alone (`nli-decide.ts` carries the rule and its provisionality).
 *
 * NO OLLAMA PREFLIGHT AND NO UNLOAD, because no Ollama: this path exists for a
 * machine that has none, and an engine that probed a server it will never ask
 * anything of would fail runs over a dependency it does not have. `suggested`
 * is empty by declared inability — the aboutness question survives without an
 * LLM, the what-else-would-you-call-it question does not — and the `engine`
 * field is how a consumer tells that emptiness from the full engine's claim.
 */
async function tagNliOnly(
  opts: TagOptions,
  document: TagDocument,
  plan: readonly RankPlan[],
): Promise<TagResult> {
  const { log } = opts;
  const shared = (line: string): void => log(
    line.startsWith('analyze: ') ? `tag: ${line.slice('analyze: '.length)}` : line,
  );

  let worker: NliWorker | null = null;
  const ensureWorker = async (): Promise<NliWorker> => {
    worker ??= await NliWorker.start({ ...opts.nli, log: shared });
    return worker;
  };
  const startedWorker = (): NliWorker | null => worker;

  try {
    const candidates = await rankCandidates(document.sentences, plan, opts, shared, ensureWorker);
    const decision = decideNliOnly(opts.tags, candidates);
    // The stats stay on stderr: the JSON carries no scores by standing ruling,
    // and a calibration pass needs to see the middle of the distribution.
    for (const one of decision.stats) {
      log(
        `tag: nli-only "${one.tag}" — max ${one.max.toFixed(3)}, `
        + `strong ${one.strongSentences}, mid ${one.midSentences}, `
        + `candidates ${one.candidates} → ${one.applies ? 'APPLIES' : 'no'}`,
      );
    }
    const answer: TagAnswer = {
      applies: decision.applies,
      suggested: [],
      engine: 'nli-only',
    };
    return {
      answer,
      outPath: writeAnswer(answer, opts.outPath ?? null),
      sentences: document.sentences.length,
      candidates: decision.stats.filter((one) => one.candidates > 0).length,
      asked: 0,
      degraded: 0,
    };
  } finally {
    startedWorker()?.stop();
  }
}

/**
 * The model stages, and the writing.
 *
 * ONE num_ctx FOR EVERY CALL IN THE RUN, sized from the longest prompt — Ollama
 * fully reloads the model on any num_ctx change, and these prompts differ only
 * in the length of their passages, so per-call sizing would buy reloads and
 * nothing else. The suggestion prompt is in that sizing even though it is asked
 * last, because it is usually the longest one.
 */
async function answerStage(args: {
  document: TagDocument;
  candidates: readonly FlagCandidate[];
  opts: TagOptions;
  transport: Transport;
  endpoint: string;
}): Promise<TagResult> {
  const { opts, transport, endpoint } = args;
  const { log } = opts;
  const model = opts.model;

  const evidence = evidenceByTag(args.candidates);
  const jobs = evidence.map((one) => ({
    tag: one.tag,
    prompt: buildAboutnessPrompt(one.tag, one.passages),
  }));

  /*
   * WITH NOTHING RANKED THE SAMPLE IS A STRIDE ACROSS THE DOCUMENT. That is the
   * empty-vocabulary run (there was no question to rank against) and the
   * matched-nothing run (there was, and the answer was no) — in both, the
   * suggestion is the only product, and it still gets a representative read of
   * the document rather than its first page. See `stridedSample`.
   */
  const sample = args.candidates.length > 0
    ? topPassages(args.candidates)
    : stridedSample(args.document.sentences);
  const suggestPrompt = buildSuggestPrompt(opts.tags, sample);

  const numCtx = stageNumCtx([...jobs.map((job) => job.prompt), suggestPrompt], model);
  log(
    `tag: ${jobs.length} of ${opts.tags.length} tag(s) reached the capture floor and cost a call; `
    + `${jobs.length + 1} call(s) at num_ctx ${numCtx} on ${model}`,
  );

  const applies: string[] = [];
  let asked = 0;
  let degraded = 0;
  for (const [index, job] of jobs.entries()) {
    asked += 1;
    const outcome = await askAboutness(transport, endpoint, model, job.prompt, numCtx);
    if (outcome.applies === null) {
      /*
       * A DEGRADATION IS A "NO", NEVER A "YES". The call failed, or the answer
       * was cut off, or it carried no yes and no no — all three mean nothing
       * judged this tag, and an unreadable answer must not be able to label a
       * document.
       */
      degraded += 1;
      log(`tag: no answer for "${job.tag}" — ${outcome.degraded}; the tag is not applied`);
    } else if (outcome.applies) {
      applies.push(job.tag);
    }
    log(`tag: verify ${index + 1}/${jobs.length} (${job.tag})`);
  }

  /*
   * EVERY CALL UNUSABLE IS A BROKEN RUN, NOT A QUIET RESULT — analyze's ruling,
   * and it bites harder here: "no tags applied" is exactly what a document about
   * none of them looks like, and nothing in the JSON would distinguish the two.
   */
  if (jobs.length > 0 && degraded === jobs.length) {
    throw new TagError(
      `not one of the ${jobs.length} aboutness call(s) produced a usable answer. An answer of "no `
      + 'tags applied" would be indistinguishable from a document about none of them, so this run '
      + 'refuses rather than writing one.',
    );
  }

  asked += 1;
  const suggested = await askSuggestions(transport, endpoint, model, suggestPrompt, numCtx);
  if (suggested.tags === null) {
    /*
     * AND SO IS A MISSING SUGGESTION. The output has two fields and both are
     * answers; an empty `suggested` means "the document supports no new tags",
     * which is a claim this run would not have made. It refuses instead of
     * writing a half-answer that reads like a whole one (ARCHITECTURE.md §8).
     */
    degraded += 1;
    throw new TagError(
      `the suggestion call produced no usable answer: ${suggested.degraded}. An empty "suggested" `
      + 'list would say the document supports no new tags, which is not what happened here.',
    );
  }
  const answer: TagAnswer = {
    // HER ORDER, NOT THE RANKER'S. The list she reads back is the list she
    // wrote, with the tags that did not hold removed.
    applies: opts.tags.filter((tag) => applies.includes(tag)),
    suggested: cleanSuggestions(suggested.tags, opts.tags),
    engine: 'full',
  };
  log(
    `tag: ${answer.applies.length} of ${opts.tags.length} tag(s) apply; `
    + `${answer.suggested.length} suggested (${suggested.tags.length} offered)`
    + (degraded > 0 ? `; ${degraded} call(s) produced no usable answer` : ''),
  );

  return {
    answer,
    outPath: writeAnswer(answer, opts.outPath ?? null),
    sentences: args.document.sentences.length,
    candidates: jobs.length,
    asked,
    degraded,
  };
}

/**
 * Write the JSON, or leave it to the caller.
 *
 * Beside-then-rename, the house idiom: a reader that opens the path the moment
 * it exists must never find half an object, and a failed write must not destroy
 * the answer a previous run left there.
 */
function writeAnswer(answer: TagAnswer, outPath: string | null): string | null {
  if (outPath === null) return null;
  const resolved = path.resolve(outPath);
  ensureDir(path.dirname(resolved));
  const pending = `${resolved}.tmp`;
  fs.writeFileSync(pending, formatTagJson(answer), 'utf8');
  fs.renameSync(pending, resolved);
  return resolved;
}
