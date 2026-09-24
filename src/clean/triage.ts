/**
 * clean/triage — WHICH BLOCKS NEED CLEANING AT ALL, asked before the cleaner is.
 *
 * Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with
 * snap and then we bring snap down and load the full normal cleaning logic …
 * flagging a block and adding it to a list, then sending the blocks that need to
 * be cleaned to the cleaner."* And: *"we can mark those that dont need to be
 * cleaned as 'clean' so everything is uniform and it's verified that it was at
 * least examined."*
 *
 * This is the first half. It reads the book exactly as `clean-text` would
 * (src/clean/blocks.ts — the same plan, the same stage-1 punctuation), asks a
 * Crucible's decide door one yes/no per position — does this need cleaning? —
 * and writes every verdict to a file. `clean-text --triage <file>` is the second
 * half: it asks the cleaning model only about the positions flagged here, and
 * records every other one as examined and clean (run.ts).
 *
 * ── IT REPLACES A RULING, ON PURPOSE ────────────────────────────────────────
 *
 * Owen, 2026-09-04: *"send every single block through to be sure"* — because an
 * abbreviation or an acronym is invisible to a digit test. A triage by a MODEL
 * is not a digit test: it is shown every class the cleaner handles (the guide
 * below is those classes, from src/clean/prompts/tts-narration-text.txt) and
 * reads the block. What stands of the old ruling is its direction: every doubt
 * resolves toward cleaning (`needsCleaning`).
 *
 * ── THE DOOR ────────────────────────────────────────────────────────────────
 *
 * `POST <crucible>/v1/decide` (crucible docs/PHASE22-DECIDE.md §2.2): one STATE
 * and many questions over it, the door priming the shared prefix itself and
 * batching the questions on the engine. So a group of positions is one state
 * and one request, one question per position. The model must already be
 * resident — the app places the run on the `decide` class, loaded and leased,
 * and releases it when this exits; this never loads a model.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDir } from '../fsdirs.js';
import { stripBom } from '../bom.js';
import { readBookFile } from '../translate/bookrows.js';
import { deadlineForConcurrency, fetchTransport, type Transport } from '../translate/transport.js';

import {
  cleanBlocks, DEFAULT_CLEAN_UNIT, punctuateAll, triageUnits, type CleanUnit, type StageOneUnit,
} from './blocks.js';
import { blockDigest } from './digest.js';
import { CleanTextError } from './punctuate.js';
import { NORMALIZER_VERSION } from './tts-number-normalizer.js';
import { PUNCTUATION_SPEC_VERSION } from './tts-punctuation.js';

/** What a triage file is, spelled into it — a reader refuses any other. */
export const TRIAGE_FORMAT = 'foundry-clean-triage/v1';

/**
 * THE POLICY, AND IT LEANS TOWARD CLEANING.
 *
 * A position is sent to the cleaner unless the model is CONFIDENTLY sure it
 * needs nothing: its "yes" below `TRIAGE_FLAG_P`, with at least
 * `TRIAGE_MIN_LABEL_MASS` of its belief on the two letters at all. The door's
 * probabilities are not calibrated (PHASE22 §2.2: 0.99 means "by far most
 * likely", not 99 %), so these are a stated starting point to be measured
 * against a book, not a derived number: a false "clean" costs a block the
 * narrator mispronounces, a false "needs cleaning" costs one model request.
 */
export const TRIAGE_FLAG_P = 0.2;
export const TRIAGE_MIN_LABEL_MASS = 0.9;

/**
 * HOW BIG ONE REQUEST IS. A group is asked as one state; its positions are
 * shown IN FULL (a triage must not judge a paragraph by its first half — the
 * digit may be in the second), so a group is bounded by characters as well as
 * by count. A couple of neighbours either side are shown cut short, only so a
 * list item or a heading reads as one.
 *
 * MEASURED, 2026-09-24 (snap session, Mac 1.0.26, three real groups replayed):
 * reading a state (the prime) is LINEAR in its size — ~2,900 chars/s on
 * qwen3.5-9b, ~700 on the 27B — while a question on a primed state costs
 * ~0.5 s (9B) / ~0.9 s (27B) and barely moves out to 41k chars. So a group's
 * size does not change how much text is read (every block is read once); it
 * changes how often the fixed part — the guide, the context blocks, the
 * template — is read again. At 6,000 chars Pursuit of Power's long paragraphs
 * made 387 groups of ~3.5 questions each; at 20,000 it is ~105 of ~13, an
 * estimated 20–25 % off the whole run. The ceiling is decide's working context,
 * 8,192 tokens (Crucible `capability.DECIDE_STATE_TOKENS`, ~30k chars of
 * English): 20,000 chars of asked text is ~5.5k tokens with the guide and
 * context, clear of it. The count cap only binds on short blocks (headings,
 * list items), where the fixed part is most of the state, so it is generous.
 */
const GROUP_MAX_UNITS = 32;
/**
 * A SENTENCE group may hold more questions: a sentence is a ~130-character
 * line, so the count cap binds long before the character cap does, and a
 * question on a primed state is the cheap part (above). 64 keeps a group's
 * asked text near the block groups' while halving how often the guide is read.
 */
const GROUP_MAX_SENTENCES = 64;
const GROUP_MAX_CHARS = 20_000;
const CONTEXT_UNITS = 2;
const CONTEXT_CHARS = 200;

/** Default requests in flight. The door batches each request's questions itself. */
export const DEFAULT_TRIAGE_CONCURRENCY = 2;

/** How often a transport failure is retried before the run is refused by name. */
const TRANSPORT_RETRIES = 5;

/**
 * What the model is shown before every group — the cleaner's own classes, in
 * the order src/clean/prompts/tts-narration-text.txt numbers them.
 */
export const TRIAGE_GUIDE = [
  'You are checking the blocks of a book before a text-to-speech voice reads it aloud.',
  'A block NEEDS CLEANING if anything in it is printed one way and spoken another, or is printed but not meant to be spoken:',
  '- any digit or number: a year, a quantity, a date, a range, a decimal, a heading or list number, a verse reference;',
  '- an abbreviation a narrator says in full: Dr., St., Mt., e.g., i.e., etc., vs., no. before a number, an ampersand (Mr., Mrs. and Ms. alone do NOT count);',
  '- a scripture reference or an abbreviated book of scripture: Rom. 5:17, 1 Cor. 13:4;',
  '- a run of capital letters: an acronym such as FBI or NATO, or a word in capitals for emphasis;',
  '- a bracketed insertion or apparatus: [sic], [12], [he said], (see page twelve), (Kershaw 1993);',
  '- a hyphen with a space on each side, used as a dash;',
  '- a roman numeral: Part IV, Chapter IX, Henry VIII.',
  'Superscript note numbers, daggers and asterisks used as reference marks do NOT count — they are removed elsewhere.',
  'Ordinary prose with none of these does not need cleaning. If you are unsure, it needs cleaning.',
  'Lines marked (context) are shown only so the others read correctly; you are asked only about the other lines.',
].join('\n');

/** One position's verdict, bound to the exact text it judged. */
export interface TriageVerdict {
  /** True = send to the cleaner. The ONE field `clean-text` acts on. */
  needsCleaning: boolean;
  /** The door's P("needs cleaning"). */
  p: number;
  /** How much of the model's belief was on the two letters at all. */
  labelMass: number;
  /** `blockDigest` of the stage-1 text judged — a verdict about other words is not about this block. */
  digest: string;
}

export interface TriageFile {
  format: typeof TRIAGE_FORMAT;
  at: string;
  /** The book file judged. */
  source: string;
  /** The model that answered, as the door named it. */
  model: { id: string; revision: string | null; fingerprint: string | null };
  engine: string;
  /** The stage-1 rules the judged text was produced by. */
  punctuationSpec: string;
  normalizerVersion: string;
  flagP: number;
  minLabelMass: number;
  /**
   * What a position IS — a sentence (`<parts>#s<i>`) or a whole block. Absent in
   * a file written before 2026-09-24, which judged blocks.
   */
  unit?: CleanUnit;
  /** Position → verdict, for every position of the plan. */
  blocks: Record<string, TriageVerdict>;
}

export interface CleanTriageOptions {
  bookPath: string;
  outPath: string;
  /** The Crucible's base URL (`http://host:7100`). `/v1/decide` is added here. */
  endpoint: string;
  /** The resident decide model's id. Required: the door never picks one. */
  model: string;
  concurrency?: number;
  /** Sentences (the default) or whole blocks — `--unit`. clean-text must be run at the same one. */
  unit?: CleanUnit;
  /** Injected so the tests drive the whole triage with no server. */
  transport?: Transport;
  /** Injected so the tests do not wait out a Retry-After. */
  sleep?: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export interface CleanTriageOutcome {
  positions: number;
  flagged: number;
  clean: number;
  file: TriageFile;
}

/** The door's URL from a Crucible base, whether or not `/v1` was typed. */
export function decideUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/decide`;
}

/** A group: the positions asked, and the wider stretch shown. */
interface Group {
  from: number;
  to: number;
  askFrom: number;
  askTo: number;
}

/** Cut the units into groups bounded by count and by the characters asked. */
export function triageGroups(units: readonly StageOneUnit[], unit: CleanUnit = 'block'): Group[] {
  const maxUnits = unit === 'sentence' ? GROUP_MAX_SENTENCES : GROUP_MAX_UNITS;
  const groups: Group[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let chars = 0;
    while (end < units.length && end - start < maxUnits) {
      const next = units[end]!.text.length;
      if (end > start && chars + next > GROUP_MAX_CHARS) break;
      chars += next;
      end += 1;
    }
    groups.push({
      askFrom: start,
      askTo: end,
      from: Math.max(0, start - CONTEXT_UNITS),
      to: Math.min(units.length, end + CONTEXT_UNITS),
    });
    start = end;
  }
  return groups;
}

/** One line of a group's state. Asked positions in full; context cut short. */
function unitLine(unit: StageOneUnit, asked: boolean): string {
  const oneLine = unit.text.replace(/\s+/g, ' ').trim();
  if (asked) return `[${unit.parts}] (${unit.category ?? 'text'}) ${oneLine}`;
  const cut = oneLine.length > CONTEXT_CHARS ? `${oneLine.slice(0, CONTEXT_CHARS)}…` : oneLine;
  return `[${unit.parts}] (context) ${cut}`;
}

/**
 * The guide for a SENTENCE run: the same classes, said of a line. Derived from
 * `TRIAGE_GUIDE` so the two can never list different things, and a block run's
 * state stays byte-identical to what it was.
 */
/**
 * The state every sentence question shares: one line of framing, then WORKED
 * EXAMPLES — the criteria shown, not only stated.
 *
 * Measured 2026-09-24 on Working Towards the Führer (qwen3.5-2b, the question
 * alone): AUC 0.69, and of the 41 sentences printing something to read it
 * flagged 14; nearly every miss was a sentence whose only target was a year or a
 * decade ("After 1933, as head of government …", "the mid-1980s"), which the
 * criteria name in so many words. No cut-off rescues it — 95 % recall flags 196
 * of 212. Owen: *"we're using the probablistic solution with determinstic
 * examples provided"*. So the model is shown each criterion as a sentence and
 * its answer. The examples are written for this and are NOT that book's
 * sentences, so a measurement on it still measures the model.
 *
 * In the state because the state is the shared prefix the door primes once per
 * group: the examples cost one read, not one per question.
 */
const SENTENCE_TRIAGE_STATE = [
  'You are checking the sentences of a book, one at a time, before a text-to-speech voice reads them aloud.',
  'A sentence needs to be cleaned when something in it is printed one way and spoken another. Examples, with the right answer:',
  '',
  '"After 1871, the new empire was governed from Berlin." -> A (Yes): a year.',
  '"By the mid-1890s the movement had lost its way." -> A (Yes): a decade.',
  '"On 3 May 1905 the strike began." -> A (Yes): a date.',
  '"The war cost the treasury 4.5 million pounds." -> A (Yes): a decimal number.',
  '"The crowd numbered some 300 people." -> A (Yes): a number.',
  '"It is reprinted in The Letters, ed. John Smith, with notes." -> A (Yes): an abbreviation said in full.',
  '"The KPD refused to join the coalition." -> A (Yes): a run of capitals.',
  '"He wrote to Weber [the finance minister] that night." -> A (Yes): a bracketed insertion.',
  '"The plan failed - as everyone expected - within a week." -> A (Yes): a hyphen with spaces used as a dash.',
  '"Frederick III reigned for only ninety-nine days." -> A (Yes): a roman numeral after a ruler\'s name.',
  '"What had seemed impossible now looked merely difficult." -> B (No): ordinary prose.',
  '"The ministers never met again as a body.²⁷" -> B (No): a superscript note number does not count.',
  '"In this sense the *idea* mattered more than the man." -> B (No): asterisks marking emphasis do not count.',
  '"She left the city in the spring and did not return." -> B (No): ordinary prose, even with no punctuation to speak of.',
].join('\n');

/**
 * The criteria, as they are listed in `TRIAGE_GUIDE` — its bullet lines and the
 * two lines that follow them — so a sentence and a block are judged by one list.
 */
const TRIAGE_CRITERIA = TRIAGE_GUIDE.split('\n')
  .filter((line) => line.startsWith('- ') || line.startsWith('Superscript') || line.startsWith('Ordinary prose'))
  .join('\n');

/**
 * The state one request is asked over.
 *
 * ── AT --unit sentence THE STATE IS THE GUIDE AND NOTHING ELSE ─────────────
 *
 * Measured 2026-09-24 on Working Towards the Führer (qwen3.5-2b): with the
 * sentences listed in the state and each question naming one by id ("Line
 * [b7-6#s0] needs cleaning."), the yes-probability did not separate the 41
 * sentences that print something to read from the 171 that print nothing —
 * AUC 0.55, a coin — and "After 1933, as head of government …" scored LOWEST.
 * The model had to find a line by its label among 64 before it could judge it.
 * So each question now ASKS about its sentence, in the words Owen gave
 * (`triageQuestion`): *"does this sentence need to be cleaned? [sentence] here
 * are the criteria a sentence should meet if it needs to be cleaned:
 * [criteria]"*. The state is one line of framing every question shares.
 */
export function groupState(units: readonly StageOneUnit[], group: Group, unit: CleanUnit = 'block'): string {
  if (unit === 'sentence') return SENTENCE_TRIAGE_STATE;
  const lines: string[] = [];
  for (let i = group.from; i < group.to; i += 1) {
    lines.push(unitLine(units[i]!, i >= group.askFrom && i < group.askTo));
  }
  return `${TRIAGE_GUIDE}\n\nBLOCKS\n${lines.join('\n')}`;
}

/**
 * The two answers a sentence question offers, which the door renders as
 * "Options: A. Yes  B. No  Answer with the letter only." (Owen: *"pick A or B.
 * A: yes. B: no."*). `yes` is the one the policy reads.
 */
const SENTENCE_OPTIONS = { yes: 'Yes', no: 'No' } as const;

export type TriageQuestion =
  | { type: 'yesno'; instructions: string }
  | { type: 'choice'; instructions: string; options: typeof SENTENCE_OPTIONS };

/**
 * The question asked of one position.
 *
 * At `--unit block` it names the block, which the state lists. At `--unit
 * sentence` it ASKS, with the sentence and then the criteria in the question
 * itself — a \`choice\` of Yes/No, because the door's \`yesno\` renders its text as a
 * statement to be judged true or false, and this is a question.
 */
export function triageQuestion(parts: string, unit: CleanUnit = 'block', text?: string): TriageQuestion {
  if (unit === 'sentence') {
    if (text === undefined) throw new Error(`triageQuestion: a sentence question needs its sentence (${parts}).`);
    return {
      type: 'choice',
      instructions: 'Does this sentence need to be cleaned?\n\n'
        + `${text.replace(/\s+/g, ' ').trim()}\n\n`
        + 'Here are the criteria a sentence meets if it needs to be cleaned:\n'
        + TRIAGE_CRITERIA,
      options: SENTENCE_OPTIONS,
    };
  }
  return { type: 'yesno', instructions: `Block [${parts}] needs cleaning.` };
}

/** The ONE place a verdict's probabilities become a decision. */
export function needsCleaning(p: number, labelMass: number): boolean {
  return p >= TRIAGE_FLAG_P || labelMass < TRIAGE_MIN_LABEL_MASS;
}

interface DecideAnswer { type?: unknown; p?: unknown; probabilities?: Record<string, unknown>; label_mass?: unknown }

/** P("needs cleaning") from either answer shape: a yes/no's `p`, or a Yes/No choice's `yes`. */
function yesProbability(answer: DecideAnswer): number | undefined {
  if (typeof answer.p === 'number') return answer.p;
  const yes = answer.probabilities?.['yes'];
  return typeof yes === 'number' ? yes : undefined;
}
interface DecideReply {
  model?: { id?: unknown; revision?: unknown; fingerprint?: unknown };
  engine?: unknown;
  answers?: Record<string, DecideAnswer>;
  error?: { code?: unknown; message?: unknown; details?: { retry_after?: unknown; problems?: unknown } };
}

/**
 * ONE REQUEST, with the weather handled and misconfiguration refused.
 *
 * `503 chat_queue_full` is the door saying "not yet" (PHASE22 §2.2 — *"treat it
 * as weather"*): it is waited out, for as long as it lasts, with a sentence each
 * time. A transport failure is retried `TRANSPORT_RETRIES` times and then
 * refused naming the URL. Anything else the door refuses — a model not resident,
 * a malformed request — is a mistake somebody can fix, and is said once.
 */
async function askGroup(
  transport: Transport,
  url: string,
  body: string,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<DecideReply> {
  let transportFailures = 0;
  for (;;) {
    let response;
    try {
      response = await transport.post(url, body);
    } catch (err) {
      transportFailures += 1;
      if (transportFailures > TRANSPORT_RETRIES) {
        throw new CleanTextError(
          `clean-triage could not reach ${url} after ${TRANSPORT_RETRIES} retries: ${(err as Error).message}`,
        );
      }
      log(`clean-triage: ${url} did not answer (${(err as Error).message}) — retrying (${transportFailures} of ${TRANSPORT_RETRIES})`);
      await sleep(2_000 * transportFailures);
      continue;
    }
    let reply: DecideReply;
    try {
      reply = JSON.parse(response.body) as DecideReply;
    } catch {
      throw new CleanTextError(`clean-triage: ${url} answered ${response.status} with a body that is not JSON: ${response.body.slice(0, 200)}`);
    }
    if (response.status === 200) return reply;
    const code = typeof reply.error?.code === 'string' ? reply.error.code : `http_${response.status}`;
    const message = typeof reply.error?.message === 'string' ? reply.error.message : response.body.slice(0, 200);
    if (response.status === 503 && code === 'chat_queue_full') {
      const header = Number(response.headers?.['retry-after']);
      const detail = Number(reply.error?.details?.retry_after);
      const seconds = Number.isFinite(header) && header > 0 ? header
        : Number.isFinite(detail) && detail > 0 ? detail : 2;
      log(`clean-triage: the server is busy (${message}) — waiting ${seconds} s and asking again`);
      await sleep(seconds * 1_000);
      continue;
    }
    // A 400 names WHICH field was wrong (`details.problems`, Crucible's
    // validation handler); that list is the whole diagnosis, so it is printed.
    // Without it, a malformed request read as "not a valid job request" and
    // nothing else — which is how a duplicated content-type hid (2026-09-24).
    const problems = Array.isArray(reply.error?.details?.problems)
      ? (reply.error!.details!.problems as Array<{ location?: unknown; message?: unknown }>)
        .slice(0, 5)
        .map((p) => `${Array.isArray(p.location) ? p.location.join('.') : '?'}: ${String(p.message)}`)
        .join('; ')
      : '';
    throw new CleanTextError(
      `clean-triage: ${url} refused the request (${response.status} ${code}): ${message}`
      + (problems ? ` — ${problems}` : ''));
  }
}

/** Run a pool of `concurrency` over `count` jobs, in any order. */
async function pool(count: number, concurrency: number, job: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      await job(index);
    }
  });
  await Promise.all(lanes);
}

/**
 * Judge every position of the book, and write the verdicts to `outPath`.
 */
export async function runCleanTriage(opts: CleanTriageOptions): Promise<CleanTriageOutcome> {
  const started = Date.now();
  const at = new Date().toISOString();
  const concurrency = opts.concurrency ?? DEFAULT_TRIAGE_CONCURRENCY;
  const transport = opts.transport ?? fetchTransport(deadlineForConcurrency(concurrency));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = decideUrl(opts.endpoint);

  const where = path.resolve(opts.bookPath);
  let bookText: string;
  try {
    bookText = stripBom(fs.readFileSync(where, 'utf8'));
  } catch (err) {
    throw new CleanTextError(`--book ${where} cannot be read (${(err as Error).message}).`);
  }
  const book = readBookFile(bookText, where);
  const { blocks } = cleanBlocks(book, where);
  if (blocks.length === 0) {
    throw new CleanTextError(`--book ${where} has no block with words in it, so there is nothing to triage.`);
  }
  const punctuated = punctuateAll(blocks);
  const unit = opts.unit ?? DEFAULT_CLEAN_UNIT;
  const units = triageUnits(blocks, punctuated.text, unit);
  const groups = triageGroups(units, unit);
  opts.log(
    `clean-triage: ${units.length} ${unit === 'sentence' ? 'sentence' : 'block'} position(s) of `
    + `${blocks.length} block(s), in ${groups.length} group(s), asked of ${opts.model} at ${url}`);

  const verdicts: Record<string, TriageVerdict> = {};
  let served: TriageFile['model'] | null = null;
  let engine = '';
  let done = 0;
  await pool(groups.length, concurrency, async (index) => {
    const group = groups[index]!;
    const asked = units.slice(group.askFrom, group.askTo);
    const body = JSON.stringify({
      model: opts.model,
      state: groupState(units, group, unit),
      questions: Object.fromEntries(asked.map((one) => [one.parts, triageQuestion(one.parts, unit, one.text)])),
    });
    const reply = await askGroup(transport, url, body, sleep, opts.log);
    for (const unit of asked) {
      const answer = reply.answers?.[unit.parts];
      const p = answer === undefined ? undefined : yesProbability(answer);
      if (answer === undefined || p === undefined || typeof answer.label_mass !== 'number') {
        throw new CleanTextError(`clean-triage: the door answered a group without a yes/no for ${unit.parts}.`);
      }
      verdicts[unit.parts] = {
        needsCleaning: needsCleaning(p, answer.label_mass),
        p,
        labelMass: answer.label_mass,
        digest: blockDigest(unit.text),
      };
    }
    if (served === null && typeof reply.model?.id === 'string') {
      served = {
        id: reply.model.id,
        revision: typeof reply.model.revision === 'string' ? reply.model.revision : null,
        fingerprint: typeof reply.model.fingerprint === 'string' ? reply.model.fingerprint : null,
      };
      engine = typeof reply.engine === 'string' ? reply.engine : '';
    }
    done += asked.length;
    opts.log(`clean-triage: ${done}/${units.length}`);
  });

  if (served === null) {
    throw new CleanTextError(`clean-triage: ${url} never said which model answered.`);
  }
  const file: TriageFile = {
    format: TRIAGE_FORMAT,
    at,
    source: where,
    model: served,
    engine,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    flagP: TRIAGE_FLAG_P,
    minLabelMass: TRIAGE_MIN_LABEL_MASS,
    unit,
    // In the book's order, so the file reads alongside it.
    blocks: Object.fromEntries(units.map((unit) => [unit.parts, verdicts[unit.parts]!])),
  };
  const out = path.resolve(opts.outPath);
  ensureDir(path.dirname(out));
  const partial = `${out}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  fs.renameSync(partial, out);

  const flagged = Object.values(file.blocks).filter((v) => v.needsCleaning).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  opts.log(
    `clean-triage: ${flagged} of ${units.length} position(s) need cleaning; ${units.length - flagged} `
    + `examined and clean, in ${seconds}s. Verdicts: ${out}`,
  );
  return { positions: units.length, flagged, clean: units.length - flagged, file };
}

/**
 * Read a triage file, or refuse it by name. A file of another format, or one
 * whose verdicts are malformed, is not a list anybody should clean by.
 */
export function readTriageFile(triagePath: string): TriageFile {
  const where = path.resolve(triagePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(where, 'utf8')));
  } catch (err) {
    throw new CleanTextError(`--triage ${where} cannot be read as JSON (${(err as Error).message}).`);
  }
  const file = parsed as Partial<TriageFile>;
  if (file.format !== TRIAGE_FORMAT) {
    throw new CleanTextError(`--triage ${where} is not a clean-triage file (format ${String(file.format)}, expected ${TRIAGE_FORMAT}).`);
  }
  if (typeof file.model?.id !== 'string' || file.blocks === undefined || typeof file.blocks !== 'object') {
    throw new CleanTextError(`--triage ${where} has no model or no verdicts.`);
  }
  for (const [parts, verdict] of Object.entries(file.blocks)) {
    if (typeof verdict?.needsCleaning !== 'boolean' || typeof verdict.digest !== 'string'
      || typeof verdict.p !== 'number' || typeof verdict.labelMass !== 'number') {
      throw new CleanTextError(`--triage ${where}: the verdict for ${parts} is malformed.`);
    }
  }
  return file as TriageFile;
}
