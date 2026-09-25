/**
 * analyze/snap — `foundry analyze-rank`: every sentence of the book, asked of a
 * Crucible's decide door, kept as a rating map.
 *
 * ── PORTED, NOT INVENTED ────────────────────────────────────────────────────
 *
 * briefcase's snap flag ranker (`backend/src/scorer/flags/` and
 * `scorer/crucible-decide.ts`, main d80cc71), which replaced the entailment
 * ranker there and replaces it here (Owen, 2026-09-25: *"full replacement …
 * we're replacing the logic — the way it works. not the ui"*):
 *
 *   units     the sentences, a short one folded into the next and a run-on cut
 *             into pieces — the thing the scorer is asked about;
 *   groups    three consecutive units, each group sharing one unit with the
 *             next, QUOTED in one `choice` over the categories + "none";
 *   state     the chunk's units one per line, then the category legend once —
 *             the door primes it once and every question extends it;
 *   map       each unit's vector is the mean of its groups' vectors: a
 *             per-category probability for every sentence of the book.
 *
 * What the map ADDS UP TO — spans, sections, windows — is spans.ts, pure, and
 * it runs in `analyze` beside the verifier, so a retune of it never pays the
 * card again. This file is the half that needs the card, and it writes one
 * file: the rank file, which `analyze --ranks` refuses unless it was made from
 * the same book and the same questions.
 *
 * ── WHAT CHANGED IN THE PORT, ALL OF IT ─────────────────────────────────────
 *
 *   1. Words, not seconds: the run-on cap is briefcase's word cap alone (its
 *      30-second cap is 98 words at the declared rate, so the 60-word cap
 *      always bound first), and a unit carries word positions (spans.ts).
 *   2. The chunk plan is sized to the context the model is LOADED at, read off
 *      the server, rather than a fixed 16k: briefcase loads its scorer at 32k
 *      itself; Foundry places its decide work on whatever the server has
 *      resident (the clean row's 9B — Owen, 2026-09-25: *"9b for triage"*).
 *      At a 32k load the plan is briefcase's exactly — see `chunkBudget`.
 *   3. The wire is spoken raw, as clean/triage.ts speaks it, through the shared
 *      backend/decide-door.ts; briefcase goes through the SDK. The mapping —
 *      report mode, the floor for a missing letter, the label-mass gate — is
 *      briefcase's, field for field.
 *   4. The question says "the author" and "the text above" (`groupQuestion`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { ensureDir } from '../fsdirs.js';
import { askDecide, decideUrl } from '../backend/decide-door.js';
import { deadlineForConcurrency, fetchTransport, type Transport } from '../translate/transport.js';
import { servedModels } from '../translate/vllm.js';
import { VERSION } from '../version.js';
import {
  buildPlan,
  optionSetVersion,
  parseCategoriesJson,
  untunedNames,
  NONE_KEY,
  type CategoryRequest,
  type RankPlan,
} from './plan.js';
import { AnalyzeError, readProse } from './prose.js';
import type { BookSentence } from './rank.js';
import type { BookUnit, RatingMap } from './spans.js';
import { wordCount } from './sentences.js';

// --------------------------------------------------------------------------- units

/** briefcase's `DEFAULT_UNIT_OPTIONS`, less the seconds cap (see this file's header). */
const UNIT_MIN_WORDS = 4;
const UNIT_MAX_WORDS = 60;
const UNIT_PIECE_WORDS = 30;

interface Located {
  text: string;
  sFrom: number;
  sTo: number;
}

/**
 * Sentences -> units: briefcase's `unitsFromSentences`. A sentence under four
 * words is folded into the one that follows (a fold still short keeps folding;
 * a short tail stays its own unit) — ContentStudio's submap.py rule, and the
 * reason a heading like "Chapter 3" is read with the sentence it heads. Then a
 * unit over sixty words is cut into near-equal pieces of about thirty, each
 * keeping the sentence(s) its words lie in.
 */
export function buildUnits(sentences: readonly BookSentence[]): BookUnit[] {
  const prefix = new Array<number>(sentences.length + 1).fill(0);
  for (let i = 0; i < sentences.length; i += 1) prefix[i + 1] = prefix[i]! + sentences[i]!.words;

  const folded: Located[] = [];
  let pending: Located | null = null;
  for (const [i, sentence] of sentences.entries()) {
    let unit: Located = { text: sentence.text.trim(), sFrom: i, sTo: i };
    if (pending) {
      unit = { text: `${pending.text} ${unit.text}`, sFrom: pending.sFrom, sTo: i };
      pending = null;
    }
    if (wordCount(unit.text) < UNIT_MIN_WORDS) {
      pending = unit;
      continue;
    }
    folded.push(unit);
  }
  if (pending) folded.push(pending);

  const out: BookUnit[] = [];
  const push = (text: string, sFrom: number, sTo: number): void => {
    out.push({
      index: out.length, text, sentenceFrom: sFrom, sentenceTo: sTo, start: prefix[sFrom]!, end: prefix[sTo + 1]!,
    });
  };
  for (const unit of folded) {
    if (wordCount(unit.text) <= UNIT_MAX_WORDS) {
      push(unit.text, unit.sFrom, unit.sTo);
      continue;
    }
    const words: Array<{ w: string; s: number }> = [];
    for (let s = unit.sFrom; s <= unit.sTo; s += 1) {
      for (const w of sentences[s]!.text.split(/\s+/).filter(Boolean)) words.push({ w, s });
    }
    const n = Math.ceil(words.length / UNIT_PIECE_WORDS);
    const size = Math.ceil(words.length / n);
    for (let k = 0; k < words.length; k += size) {
      const slice = words.slice(k, k + size);
      push(slice.map((x) => x.w).join(' '), slice[0]!.s, slice[slice.length - 1]!.s);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- chunks

/** A chunk: the units it OWNS (asked here and nowhere else), and the wider stretch its state shows. */
export interface Chunk {
  coreFrom: number;
  coreTo: number;
  contextFrom: number;
  contextTo: number;
}

/**
 * What one chunk may hold, from the context the model was loaded at.
 *
 * briefcase's plan is one chunk up to 16,000 tokens, else equal cores of
 * 12,000 with 2,000 of overlap each side — on a scorer IT loads at 32,768, so a
 * 16k state leaves the other half for the legend, the frame and a question's
 * tail. Foundry does not load the model; the server has it resident at whatever
 * it was loaded at (a 9B without a stated context comes up at 16,384 — Crucible
 * manifest `context_default`, confirmed by briefcase-mac-1 2026-09-25). So the
 * plan keeps briefcase's proportions (16 : 12 : 2) and scales them to the room
 * that is actually there: the context less `CHUNK_RESERVE_TOKENS`, never more
 * than briefcase's 16,000. At a 32k load it is briefcase's plan to the token.
 *
 * The reserve is the legend (a dozen one-line categories, ~350 tokens), the
 * door's frame and one question's tail (≤900 quoted characters plus a dozen
 * short options), with the slack chars/3.6 needs to be wrong in: it estimates,
 * and a state it underestimated is refused by the engine by name.
 */
const CHUNK_RESERVE_TOKENS = 4096;
const BRIEFCASE_SINGLE_CHUNK_TOKENS = 16_000;

export interface ChunkBudget {
  singleChunkMaxTokens: number;
  coreMaxTokens: number;
  overlapTokens: number;
}

export function chunkBudget(loadedContext: number): ChunkBudget {
  const single = Math.min(BRIEFCASE_SINGLE_CHUNK_TOKENS, loadedContext - CHUNK_RESERVE_TOKENS);
  if (single < 2048) {
    throw new AnalyzeError(
      `the ranking model is loaded with a ${loadedContext}-token context, which leaves ${single} for the `
      + `book once the ${CHUNK_RESERVE_TOKENS} the questions need are set aside. Load it with more context.`,
    );
  }
  return {
    singleChunkMaxTokens: single,
    coreMaxTokens: Math.floor((single * 12) / 16),
    overlapTokens: Math.floor((single * 2) / 16),
  };
}

/** briefcase's `estimateTokens`: chars/3.6, one for the joining newline. */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length + 1) / 3.6);
}

/**
 * briefcase's `planFlagChunks`: one chunk up to the single-chunk ceiling;
 * beyond it, equal cores of at most `coreMaxTokens` with `overlapTokens` of
 * context on each side. Every unit is owned by exactly one core.
 */
export function planChunks(units: readonly BookUnit[], budget: ChunkBudget): Chunk[] {
  const n = units.length;
  if (n === 0) return [];
  const tok = units.map((u) => estimateTokens(u.text));
  const total = tok.reduce((a, b) => a + b, 0);
  if (total <= budget.singleChunkMaxTokens) return [{ coreFrom: 0, coreTo: n, contextFrom: 0, contextTo: n }];

  const cores = Math.ceil(total / budget.coreMaxTokens);
  const target = total / cores;
  const bounds: Array<[number, number]> = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += tok[i]!;
    const remainingCores = cores - bounds.length - 1;
    if (acc >= target && remainingCores > 0 && n - (i + 1) >= remainingCores) {
      bounds.push([from, i + 1]);
      from = i + 1;
      acc = 0;
    }
  }
  bounds.push([from, n]);

  return bounds.map(([a, b]) => {
    let lo = a;
    let t = 0;
    while (lo > 0 && t + tok[lo - 1]! <= budget.overlapTokens) t += tok[--lo]!;
    let hi = b;
    t = 0;
    while (hi < n && t + tok[hi]! <= budget.overlapTokens) t += tok[hi++]!;
    return { coreFrom: a, coreTo: b, contextFrom: lo, contextTo: hi };
  });
}

// --------------------------------------------------------------------------- questions

/** Units per group, and the step between groups: consecutive groups share one unit. */
export const GROUP_SIZE = 3;
export const GROUP_STRIDE = 2;
/** Questions per decide request — each request primes its state once. */
const BATCH_SIZE = 64;
/** How long one quoted unit may be inside a group question. */
const GROUP_UNIT_CHARS = 300;
/** Pass-1 option text for "none". Topic-phrased, not stance-phrased (briefcase plan §5.1). */
const NONE_OPTION_TEXT = 'None of these: ordinary talk about something else';

/**
 * The groups of one chunk's owned units [from, to): GROUP_SIZE units each,
 * starting every GROUP_STRIDE units, the last one ending exactly at `to` (never
 * past the chunk: its state is that chunk's text). Inclusive unit ranges.
 */
export function groupsOf(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let a = from; a < to; a += GROUP_STRIDE) {
    const b = Math.min(a + GROUP_SIZE, to);
    out.push([a, b - 1]);
    if (b === to) break;
  }
  return out;
}

/** Truncate to `max` characters, marking the cut with an ellipsis. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "political-demonization" -> "Political demonization": the per-question option label. */
export function categoryTitle(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : name;
}

/**
 * The state of one chunk: its units one per line, a blank line, and the legend
 * — briefcase's 'prefix' layout, its default. The option lines are written
 * ONCE here, where the door primes them with the text, and each question
 * carries only the short labels. No header: the door adds its own frame.
 */
export function chunkState(unitTexts: readonly string[], plan: readonly RankPlan[]): string {
  const legend = [
    'Categories (the options in the questions below):',
    ...plan.map((p) => `- ${p.category}: ${p.option}`),
    `- ${NONE_KEY}: ${NONE_OPTION_TEXT}`,
  ].join('\n');
  return `${unitTexts.join('\n')}\n\n${legend}`;
}

/**
 * One group's question. It QUOTES the passage it judges — never an index into
 * the text above: a model asked about "sentence 212" judges whichever one it
 * lands on — and the whole chunk is in the primed state around it, so the
 * passage is read in context.
 *
 * briefcase's words, with the one systematic rewrite this port has always
 * made: the AUTHOR rather than the speaker, and "the text above" rather than
 * "the transcript above" — telling a model that a page of a book is a
 * transcript is a false premise in the question itself (verify.ts's prompt
 * made the same change for the same reason).
 */
export function groupQuestion(texts: readonly string[], plan: readonly RankPlan[]): {
  type: 'choice';
  instructions: string;
  options: Record<string, string>;
} {
  const passage = texts.map((t) => clip(t, GROUP_UNIT_CHARS)).join(' ');
  const options: Record<string, string> = {};
  for (const p of plan) options[p.category] = categoryTitle(p.category);
  options[NONE_KEY] = 'None of these';
  return {
    type: 'choice',
    instructions: `Passage from the text above: "${passage}"\n`
      + 'Which of the categories listed above does the author do in this passage?',
    options,
  };
}

// --------------------------------------------------------------------------- answers

/**
 * Below this much raw mass on the returned letters, an answer says nothing
 * about the options — the model wanted to write something that is not a letter
 * (PHASE22 §2.2: "a caller gates on label_mass before it believes p"). A gated
 * answer is flattened to uniform — no evidence either way — so the smoothing,
 * not noise, decides that unit. briefcase's `LABEL_MASS_GATE`, and its reason:
 * ~50x under anything the 9B was seen to answer on a real question.
 */
export const LABEL_MASS_GATE = 0.01;
/** ln(1e-12), the lowest a floored label may go. */
const LOG_FLOOR = Math.log(1e-12);
/** The server's top-K margin (PHASE22 §2.4: K is the labels plus 4). */
const TOP_K_MARGIN = 4;

interface WireAnswer {
  type?: unknown;
  probabilities?: Record<string, unknown>;
  label_mass?: unknown;
  missing_labels?: unknown;
}

export interface GroupAnswer {
  /** Renormalised over every label, floored ones included, in label order. */
  probs: number[];
  labelMass: number;
  missing: number;
  gated: boolean;
}

function logSumExp(xs: readonly number[]): number {
  const m = Math.max(...xs);
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/**
 * One report-mode answer, as briefcase's `floorAnswer` reads it.
 *
 * A label outside the engine's top-K comes back null and named in
 * `missing_labels`. Its probability is bounded above by two things the answer
 * itself proves — the smallest returned label's, and the mass NOT on the
 * returned letters shared over at least (missing + 4) top-K entries — and it
 * takes the tighter, never under ln(1e-12). Then the row is renormalised. The
 * SDK's rule is kept too: a null must be a label the answer names as missing,
 * and in report mode `missing_labels` must be there.
 */
export function readAnswer(answer: WireAnswer | undefined, labels: readonly string[], question: string): GroupAnswer {
  if (answer === undefined || answer.type !== 'choice' || typeof answer.probabilities !== 'object'
    || answer.probabilities === null || typeof answer.label_mass !== 'number'
    || !Array.isArray(answer.missing_labels)) {
    throw new AnalyzeError(
      `the decide door answered ${question} without a report-mode choice (probabilities, label_mass and `
      + 'missing_labels) — it is not the door this program speaks to.',
    );
  }
  const mass = answer.label_mass;
  const missing = new Set(answer.missing_labels.map(String));
  const raw: Array<number | null> = labels.map((label) => {
    const p = answer.probabilities![label];
    if (p === null || p === undefined) {
      if (!missing.has(label)) {
        throw new AnalyzeError(`the decide door gave ${question} no probability for "${label}" and did not say it was missing.`);
      }
      return null;
    }
    if (typeof p !== 'number') throw new AnalyzeError(`the decide door gave ${question} a probability that is not a number for "${label}".`);
    return p > 0 && mass > 0 ? Math.log(p) + Math.log(mass) : -Infinity;
  });
  const returned = raw.filter((x): x is number => x !== null && Number.isFinite(x));
  if (returned.length === 0) {
    throw new AnalyzeError(`the decide door returned no option with any probability for ${question}.`);
  }
  const absent = raw.filter((x) => x === null).length;
  let floor = -Infinity;
  if (absent > 0) {
    const rest = 1 - mass;
    const shared = rest > 0 ? Math.log(rest / (absent + TOP_K_MARGIN)) : -Infinity;
    floor = Math.max(LOG_FLOOR, Math.min(Math.min(...returned), shared));
  }
  const logs = raw.map((x) => (x === null ? floor : x));
  if (mass < LABEL_MASS_GATE) {
    return { probs: labels.map(() => 1 / labels.length), labelMass: mass, missing: absent, gated: true };
  }
  const z = logSumExp(logs);
  return { probs: logs.map((lp) => Math.exp(lp - z)), labelMass: mass, missing: absent, gated: false };
}

// --------------------------------------------------------------------------- the rank file

/** What a rank file is, spelled into it — `analyze` refuses any other. */
export const RANK_FORMAT = 'foundry-analysis-rank/v1';

export interface RankFile extends RatingMap {
  format: typeof RANK_FORMAT;
  engine: string;
  /** The bank the book was read from — the book this file is about. */
  bankSha: string;
  /** `optionSetVersion` of the plan the questions were built from. */
  options: string;
  /** The model that answered, as the door named it. */
  model: { id: string; revision: string | null; fingerprint: string | null };
  /** The context it was loaded at, and the chunk plan that followed from it. */
  loadedContext: number;
  chunks: Chunk[];
  untuned: string[];
  /** Per unit: the mean label mass of its groups. */
  labelMass: number[];
  /** Answers read as no evidence (`LABEL_MASS_GATE`). */
  gated: number;
}

/** A rank file's path for a report — `<report>.rank.json`, beside it. */
export function rankFileFor(reportPath: string): string {
  return `${path.resolve(reportPath)}.rank.json`;
}

/**
 * Read a rank file, or refuse it by name. A file of another format, or one
 * whose shape is not a rating map, is not something to verify a book from.
 */
export function readRankFile(rankPath: string): RankFile {
  const where = path.resolve(rankPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(where, 'utf8')));
  } catch (err) {
    throw new AnalyzeError(`--ranks ${where} cannot be read as JSON (${(err as Error).message}).`);
  }
  const file = parsed as Partial<RankFile>;
  if (file.format !== RANK_FORMAT) {
    throw new AnalyzeError(`--ranks ${where} is not a rank file (format ${String(file.format)}, expected ${RANK_FORMAT}).`);
  }
  if (!Array.isArray(file.units) || !Array.isArray(file.p1) || !Array.isArray(file.categories)
    || file.p1.length !== file.units.length || typeof file.bankSha !== 'string'
    || typeof file.options !== 'string' || typeof file.model?.id !== 'string') {
    throw new AnalyzeError(`--ranks ${where} is missing its units, its scores, its book or its model.`);
  }
  const width = file.categories.length + 1;
  for (const [i, row] of file.p1.entries()) {
    if (!Array.isArray(row) || row.length !== width || row.some((v) => typeof v !== 'number')) {
      throw new AnalyzeError(`--ranks ${where}: the scores for unit ${i} are not ${width} numbers.`);
    }
  }
  return file as RankFile;
}

// --------------------------------------------------------------------------- the run

export interface AnalyzeRankOptions {
  bookPath: string;
  outPath: string;
  /** A `--categories` file, or null for every built-in category. */
  categoriesPath?: string | null;
  /** The Crucible's base URL. `/v1/decide` is added here. */
  endpoint: string;
  /** The resident decide model's id. Required: the door never picks one. */
  model: string;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface AnalyzeRankOutcome {
  units: number;
  groups: number;
  gated: number;
  file: RankFile;
}

/** The categories this run plans, from a file or from the built-in set. */
export function readPlan(categoriesPath: string | null | undefined, log: (line: string) => void): RankPlan[] {
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

/** The context the served model is loaded at, from `/v1/models`. Refused by name when unstated. */
async function loadedContextOf(transport: Transport, endpoint: string, model: string): Promise<number> {
  const served = await servedModels(transport, endpoint);
  const row = served.find((one) => one.id === model);
  if (row === undefined) {
    throw new AnalyzeError(
      `${endpoint} is not serving "${model}" (it lists ${served.map((one) => one.id).join(', ') || 'nothing'}). `
      + 'The ranking model must be resident before this runs — the app places and leases it.',
    );
  }
  if (row.maxModelLen === null) {
    throw new AnalyzeError(
      `${endpoint} serves "${model}" but does not say what context it was loaded at, and the book is `
      + 'cut into chunks that fit it. A chunk sized by guess is a state the engine refuses an hour in.',
    );
  }
  return row.maxModelLen;
}

/**
 * Score every unit of the book and write the rank file.
 *
 * The chunks are asked IN ORDER, one request at a time, as briefcase asks them:
 * a chunk's state is primed on the first request and every later request of the
 * same chunk is a cache hit on it, which a pool interleaving chunks would evict.
 * The file is written whole at the end, beside the target and renamed over it.
 */
export async function runAnalyzeRank(opts: AnalyzeRankOptions): Promise<AnalyzeRankOutcome> {
  const started = Date.now();
  const { log } = opts;
  const transport = opts.transport ?? fetchTransport(deadlineForConcurrency(1));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = decideUrl(opts.endpoint);

  const { sentences, bankSha } = readProse(opts.bookPath, 'analyze', log);
  const plan = readPlan(opts.categoriesPath ?? null, log);
  const units = buildUnits(sentences);
  const loadedContext = await loadedContextOf(transport, opts.endpoint, opts.model);
  const chunks = planChunks(units, chunkBudget(loadedContext));
  const perChunk = chunks.map((chunk) => groupsOf(chunk.coreFrom, chunk.coreTo));
  const total = perChunk.reduce((n, g) => n + g.length, 0);
  log(
    `analyze: ${sentences.length} sentence(s) -> ${units.length} unit(s) in ${chunks.length} chunk(s) at a `
    + `${loadedContext}-token context: ${total} group question(s) (${GROUP_SIZE} units, stride ${GROUP_STRIDE}) `
    + `asked of ${opts.model} at ${url}`,
  );

  const labels = [...plan.map((p) => p.category), NONE_KEY];
  const width = labels.length;
  const sum = units.map(() => new Array<number>(width).fill(0));
  const massSum = units.map(() => 0);
  const seen = units.map(() => 0);
  let gated = 0;
  let asked = 0;
  let unitsDone = 0;
  let served: RankFile['model'] | null = null;

  for (const [c, chunk] of chunks.entries()) {
    const state = chunkState(units.slice(chunk.contextFrom, chunk.contextTo).map((u) => u.text), plan);
    const groups = perChunk[c]!;
    for (let k = 0; k < groups.length; k += BATCH_SIZE) {
      const batch = groups.slice(k, k + BATCH_SIZE);
      const names = batch.map((_group, n) => `g:${asked + n}`);
      const body = JSON.stringify({
        model: opts.model,
        state,
        questions: Object.fromEntries(batch.map(([a, b], n) => [
          names[n]!, groupQuestion(units.slice(a, b + 1).map((u) => u.text), plan),
        ])),
        missing: 'report',
      });
      const reply = await askDecide(transport, url, body, {
        who: 'analyze', fail: (message) => new AnalyzeError(message), sleep, log,
      });
      batch.forEach(([a, b], n) => {
        const answer = readAnswer(reply.answers?.[names[n]!] as WireAnswer | undefined, labels, names[n]!);
        if (answer.gated) gated += 1;
        for (let i = a; i <= b; i += 1) {
          for (let j = 0; j < width; j += 1) sum[i]![j]! += answer.probs[j]!;
          massSum[i]! += answer.labelMass;
          seen[i]! += 1;
        }
        unitsDone = Math.max(unitsDone, b + 1);
      });
      if (served === null && typeof reply.model?.id === 'string') {
        served = {
          id: reply.model.id,
          revision: typeof reply.model.revision === 'string' ? reply.model.revision : null,
          fingerprint: typeof reply.model.fingerprint === 'string' ? reply.model.fingerprint : null,
        };
      }
      asked += batch.length;
      log(`analyze: rank ${unitsDone}/${units.length}`);
    }
  }
  if (served === null) throw new AnalyzeError(`${url} never said which model answered.`);

  const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  const file: RankFile = {
    format: RANK_FORMAT,
    engine: VERSION,
    bankSha,
    options: optionSetVersion(plan),
    model: served,
    loadedContext,
    chunks,
    untuned: untunedNames(plan),
    categories: plan.map((p) => p.category),
    units,
    // Every unit is in at least one group: `groupsOf` covers each core whole.
    p1: sum.map((row, i) => row.map((v) => round6(v / Math.max(1, seen[i]!)))),
    labelMass: massSum.map((m, i) => round6(m / Math.max(1, seen[i]!))),
    gated,
  };
  const out = path.resolve(opts.outPath);
  ensureDir(path.dirname(out));
  const partial = `${out}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(file)}\n`, 'utf8');
  fs.renameSync(partial, out);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `analyze: ranked ${units.length} unit(s) with ${asked} question(s) in ${seconds}s`
    + (gated > 0 ? `; ${gated} answer(s) put under ${LABEL_MASS_GATE} of their belief on a letter and were read as no evidence` : '')
    + `. Rank file: ${out}`,
  );
  return { units: units.length, groups: asked, gated, file };
}
