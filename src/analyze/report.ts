/**
 * analyze/report — the run's product, and its own cost cache.
 *
 * ── ONE FILE, TWO KINDS OF LINE ─────────────────────────────────────────────
 *
 * JSONL, header first, `records.ts` discipline throughout. Two kinds of row
 * live in it and every one declares its `kind`:
 *
 *   `finding`  what the analysis FOUND — one row per flagged window per block
 *              it touches, carrying the block's id, the exact characters, the
 *              category and the verifier's reason. Flags only: a window the
 *              verifier rejected is not a finding (Owen, 2026-09-25,
 *              confirmed only).
 *   `verdict`  one (passage, category)'s answer — flag OR skip, with its
 *              reason — keyed by the question. The cost cache for the verify
 *              stage, which is the expensive one.
 *
 * The ranker's answers are not in here. They are the rank file `analyze-rank`
 * writes (snap.ts), made on another model in another process, and `analyze`
 * reads it whole; what this file caches is what `analyze` itself pays for.
 *
 * ── WHY THE CACHE LIVES IN THE PRODUCT ──────────────────────────────────────
 *
 * Verifying a book is one model call per (window, category) and can be an
 * hour. A run killed at 400 of 456 must keep 399, and a re-run against a book
 * somebody edited one paragraph of must pay for one paragraph. Both fall out of
 * `bank.ts`'s arrangement: every answer is filed under a hash of the QUESTION,
 * so an unchanged passage has an unchanged key and is never asked again — and a
 * changed one cannot accidentally match, because its key is different.
 *
 * The key is the contract's (docs/ANALYSIS.md §6): the passage, the category,
 * the verify model and the prompt — and the prompt carries the proposition and
 * `VERIFY_PROMPT_VERSION`'s wording, so a reworded prompt re-asks everything.
 *
 * ── APPENDED AS IT LANDS, REPLACED ONLY BY SOMETHING THAT EXISTS ────────────
 *
 * Cache rows are appended and fsynced the moment an answer is accepted — never
 * at the end of the stage, never at the end of the run. What a kill costs is
 * the one call in flight.
 *
 * The FINDINGS cannot work that way, because a re-run produces a new set and an
 * appended file would accumulate both. So at the end the whole file is composed
 * — header, this run's findings, every cache row old and new — written beside
 * the target, fsynced, and RENAMED over it. Nothing anybody paid for is
 * destroyed until its replacement is on the disk (`readings.ts`, `bank.ts`,
 * `records.ts`, and the same rule as all three).
 *
 * WHAT A KILLED RUN LEAVES, said plainly: the file keeps the LAST COMPLETED
 * run's findings and has grown the cache rows this run paid for. That is the
 * honest state — the findings on disk are the last analysis that actually
 * finished, and the next run pays only for what is left.
 *
 * ── NO TIMESTAMP ANYWHERE IN THE BODY PATH ──────────────────────────────────
 *
 * The header and every finding are a pure function of the inputs: same book,
 * same plan, same models, same bytes, in reading order. `engine` is the one
 * field that moves without an input moving, and it moves with a release rather
 * than with a run — `book-file.ts`'s rule, kept.
 *
 * The CACHE rows are in the order their answers landed, which a resumed run
 * reaches by a different road than a run from scratch. That is a fact about
 * what was paid for and when, not about the book, and it is why the claim above
 * is made about the header and the findings rather than about the whole file.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { ensureDir } from '../fsdirs.js';
import { VERSION } from '../version.js';
import type { Verification } from './verify.js';

/** Something is wrong with the report file itself. */
export class AnalysisReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisReportError';
  }
}

/**
 * The format written into the header, so a reader can refuse a shape it cannot
 * use rather than half-understanding it.
 *
 * 2 (2026-09-25): the snap ranker replaced the entailment one. The header
 * names the ranker's model and questions where it named the NLI model and its
 * hypotheses, findings are flags only and carry the verifier's reason, and the
 * rank rows are gone to the rank file. A version-1 report is refused whole —
 * nothing in it answers a question this version asks.
 */
export const ANALYSIS_FILE_VERSION = 2;

/** The field separator inside a key — see `bank.ts`, whose reason this is. */
const NUL = String.fromCharCode(0);

/** The header's fields, in the order they are written. */
export interface AnalysisHeader {
  /** The foundry that wrote it. Provenance, and the only field a release moves. */
  engine: string;
  /**
   * The bank the book was read from — `BookFile.source.bankSha`, carried
   * verbatim. A report keyed to `b12-3` is only meaningful against the bank
   * that minted that name, so a loader whose book has a different one refuses
   * by name rather than lighting the wrong paragraphs.
   */
  bankSha: string;
  /** The app's binding of the reading to its step, carried and never read. */
  generation?: string;
  /** Which ranker chose the passages. One value today; named so the next one is legible. */
  ranker: 'snap-v1';
  /** The model that answered the ranker's questions, as the decide door named it. */
  decide: string;
  /** `optionSetVersion` — which questions the ranker asked. */
  options: string;
  /** `spanParamsVersion` — the numbers its answers were read with (spans.ts). */
  spans: string;
  /** Which model produced every verdict. */
  verify: string;
  /** `VERIFY_PROMPT_VERSION` — which question the verifier was asked. */
  prompt: string;
  /** Every category in the plan, in plan order. */
  categories: string[];
  /**
   * The categories nothing has calibrated. Named rather than counted, because a
   * reader deciding whether to trust a count needs to know WHICH ones are
   * first drafts (docs/ANALYSIS.md §5).
   */
  untuned: string[];
  /**
   * Each category's display hue (0–359), keyed by category — the report owning
   * its own colours, so a reader on any device (BookForge's phone player asked)
   * draws a category exactly the colour the desktop drew it without carrying a
   * copy of the table. `categoryHue` in plan.ts is the authority and the app's
   * shared table is its mirror.
   */
  hues: Record<string, number>;
  /**
   * Each category's display name, keyed by category — the mirrored built-in
   * name, or the label the asker gave a custom one. Here for `hues`' reason: a
   * reader on a device with no category table shows the same words the desktop
   * shows, not a re-humanised id.
   */
  names: Record<string, string>;
}
/*
 * THIS HEADER IS A CROSS-REPO CONTRACT ONCE 1.0.0 IS IN THE WORLD. BookForge
 * reads it directly, REFUSES a report missing a required field rather than
 * substituting (their side's no-fallbacks rule, 2026-08-26), and asked for the
 * word on any header change shipped after release so they can gate by version
 * instead of meeting it as a refusal. Same standing agreement as vtt-book's
 * decode recipe: announce before shipping, land in the release they follow.
 * Format 2 (2026-09-25) is such a change: `nli`, `nliRevision`, `hypotheses`
 * and `capture` are gone, `ranker`, `decide`, `options`, `spans` and `prompt`
 * are new, and a finding carries `reason` and `alsoReasons` and no `verdict`.
 */

/**
 * One row of the report — one block's share of one flagged window.
 *
 * `hit` IS WHAT MAKES A WINDOW ONE FINDING. A passage that crosses a paragraph
 * break touches two blocks and therefore writes two rows; they share the
 * ordinal so the app lights them as one thing and lists them once.
 */
export interface AnalysisFinding {
  kind: 'finding';
  /** 1-based, in reading order. Shared by every row of one window. */
  hit: number;
  /** `BookRow.id`. Identity is `id` and only `id`. */
  id: string;
  /** `[start, end)` character offsets into that row's text, as the book carries it. */
  start: number;
  end: number;
  /** The primary category — see `WindowFinding.category`. */
  category: string;
  /** Why the verifier flagged it, in its own one or two sentences. */
  reason: string;
  /** The other categories the verifier flagged on this window, strongest first... */
  also: string[];
  /** ...and its reason for each, in the same order. */
  alsoReasons: string[];
  /** The primary category's evidence in the window, the ranker's s_c. Recorded, not sliced on. */
  score: number;
  /** How many sentences of the finding fall in THIS row. */
  sentences: number;
}

interface VerdictRow {
  kind: 'verdict';
  key: string;
  verdict: 'flag' | 'skip';
  reason: string;
}

/** The question a `verdict` row answers. *//** The question a `verdict` row answers. */
export function verdictKey(
  passage: string,
  category: string,
  verifyModel: string,
  prompt: string,
): string {
  // -2: a verdict row carries the verifier's reason now, and every -1 row was
  // asked a prompt that never requested one.
  return createHash('sha256')
    .update(['foundry-analysis-verdict-2', verifyModel, category, passage, prompt].join(NUL), 'utf8')
    .digest('hex');
}

/**
 * A report on disk: what it already answers, and what this run adds to it.
 */
export class AnalysisReport {
  private readonly verdicts = new Map<string, Verification>();
  private prior: Partial<AnalysisHeader> | null = null;
  private rows = 0;

  private constructor(
    /** Where the finished report goes. */
    readonly outPath: string,
    /** Where this run APPENDS as it goes — the same file, or a pending one. */
    readonly appendPath: string,
  ) {}

  /** The header that was already there, for the sentence the caller prints. */
  get priorHeader(): Partial<AnalysisHeader> | null {
    return this.prior;
  }

  /**
   * Read whatever is in a report file.
   *
   * A malformed LAST line is an interrupted append and is dropped; a malformed
   * line anywhere else is a file this program did not write, and it fails
   * naming the line. Exactly `TranslationRecords.open`'s rule, for its reason:
   * the first is the normal consequence of a kill, the second is a wrong path
   * about to supply somebody else's answers to a book they are not about.
   *
   * FINDINGS ARE READ AND DISCARDED. They are this run's to produce; the ones
   * on disk belong to whatever ran last and are replaced wholesale at the swap.
   */
  private read(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const lines = stripBom(fs.readFileSync(filePath, 'utf8')).split('\n');
    let header: Partial<AnalysisHeader> | null = null;
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const last = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (last) break;
        throw new AnalysisReportError(
          `${filePath}, line ${index + 1} is not JSON (${(err as Error).message}). `
          + 'This file is not an analysis report.',
        );
      }
      const row = parsed as Record<string, unknown>;
      if (header === null && row['analysis'] !== undefined) {
        if (row['analysis'] !== ANALYSIS_FILE_VERSION) {
          throw new AnalysisReportError(
            `${filePath} declares analysis format ${String(row['analysis'])} and this program writes `
            + `${ANALYSIS_FILE_VERSION}. Delete it and analyse again — nothing in it can be trusted to `
            + 'mean what this version would mean by it.',
          );
        }
        header = row as unknown as Partial<AnalysisHeader>;
        continue;
      }
      switch (row['kind']) {
        case 'verdict': {
          const key = row['key'];
          const verdict = row['verdict'];
          const reason = row['reason'];
          if (typeof key !== 'string' || (verdict !== 'flag' && verdict !== 'skip') || typeof reason !== 'string') break;
          this.verdicts.set(key, { verdict, reason });
          this.rows += 1;
          break;
        }
        case 'finding':
          break;
        default:
          throw new AnalysisReportError(
            `${filePath}, line ${index + 1} is a row of a kind this program does not write `
            + `(${String(row['kind'])}). This file is not an analysis report.`,
          );
      }
    }
    this.prior ??= header;
  }

  /** How many cached answers were carried in. */
  get size(): number {
    return this.rows;
  }

  /** How many verdicts are already paid for. */
  get verdictCount(): number {
    return this.verdicts.size;
  }

  /** The stored verdict and reason for this question, or undefined. */
  verdict(key: string): Verification | undefined {
    return this.verdicts.get(key);
  }

  /**
   * Append and fsync, the moment an answer is accepted. Synchronous from open
   * to close, so nothing can interleave a line into the middle of another.
   */
  private append(row: VerdictRow): void {
    ensureDir(path.dirname(this.appendPath));
    const handle = fs.openSync(this.appendPath, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    this.rows += 1;
  }

  addVerdict(key: string, answer: Verification): void {
    this.verdicts.set(key, answer);
    this.append({ kind: 'verdict', key, verdict: answer.verdict, reason: answer.reason });
  }

  /**
   * Compose the finished report and put it where the caller asked for it.
   *
   * Written to a sibling `.part`, fsynced, and RENAMED — the rename is the one
   * moment the old report stops being the report, and by then the new one is
   * whole and on the disk. The pending file this run may have been appending to
   * is removed only after that, because until the rename it is the only copy of
   * everything this run paid for.
   */
  finish(header: AnalysisHeader, findings: readonly AnalysisFinding[]): void {
    const lines: string[] = [JSON.stringify({ analysis: ANALYSIS_FILE_VERSION, ...header })];
    for (const finding of findings) lines.push(JSON.stringify(finding));
    for (const [key, answer] of this.verdicts) {
      lines.push(JSON.stringify({ kind: 'verdict', key, verdict: answer.verdict, reason: answer.reason }));
    }

    ensureDir(path.dirname(this.outPath));
    const part = `${this.outPath}.${process.pid}.part`;
    const handle = fs.openSync(part, 'w');
    try {
      fs.writeSync(handle, `${lines.join('\n')}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(part, this.outPath);
    if (this.appendPath !== this.outPath && fs.existsSync(this.appendPath)) {
      fs.unlinkSync(this.appendPath);
    }
  }

  /** Open a report for a run, reading whatever it may reuse. */
  static openFor(outPath: string, appendPath: string, sources: readonly string[]): AnalysisReport {
    const report = new AnalysisReport(outPath, appendPath);
    for (const source of sources) report.read(source);
    return report;
  }
}

/** `<report>.pending` — the whole path plus a suffix, never a rename of it. */
export function pendingReportPath(outPath: string): string {
  return `${path.resolve(outPath)}.pending`;
}

export interface ReportOutcome {
  report: AnalysisReport;
  /** The pending file, or null where the run appends to the real one. */
  pendingPath: string | null;
  /** ONE sentence, printed by the run. Never empty — every decision is stated. */
  sentence: string;
}

/**
 * Decide what to do with the report file this run was pointed at, do it, and
 * say so out loud.
 *
 * `openTranslationRecords`' two outcomes, its reasoning and its sentence, over
 * this file instead. A question-keyed file cannot hold a wrong answer to the
 * question being asked, so an ordinary run resumes in place; only a run that
 * asked for the whole thing again gambles into a pending file — and a FRESH run
 * that was itself killed resumes from that pending file, because the second
 * opinion costs the same hour the first one did.
 *
 * The sentence says what is reused and what will be paid for, because that is
 * the number the person watching actually wants and the only alternative is
 * finding out at the end.
 */
export function openAnalysisReport(request: {
  outPath: string;
  /** `--fresh`: ask everything again, into a file that replaces this one. */
  freshRequested: boolean;
  /** The bank this run's book was made from, for the sentence. */
  bankSha: string;
}): ReportOutcome {
  const outPath = path.resolve(request.outPath);
  const pending = pendingReportPath(outPath);

  if (request.freshRequested) {
    ensureDir(path.dirname(pending));
    // A fresh run reads ONLY its own pending file: the point of --fresh is that
    // the report already there is not to be believed, and reading its cache
    // would be believing it.
    const report = AnalysisReport.openFor(outPath, pending, [pending]);
    fs.closeSync(fs.openSync(pending, 'a'));
    return {
      report,
      pendingPath: pending,
      sentence: report.size === 0
        ? `analyze: a fresh analysis was asked for, so every passage is asked `
          + `again — whatever is in ${outPath} is left exactly as it is, and the new answers go to `
          + `${pending}, which replaces it only when this run finishes.`
        : `analyze: a fresh analysis was asked for and one was already begun — ${report.size} `
          + `answer(s) are in ${pending}, nothing whose `
          + `exact question is in there is asked again, and it replaces ${outPath} only when this run `
          + 'finishes.',
    };
  }

  const report = AnalysisReport.openFor(outPath, outPath, [outPath]);
  const priorBank = report.priorHeader?.bankSha;
  const banked = priorBank !== undefined && priorBank !== request.bankSha
    ? ` The report there was made against bank ${priorBank} and this book comes from `
      + `${request.bankSha}; its stored answers are still good, because they are keyed to the words `
      + 'rather than to the book, and its findings are replaced by this run\'s.'
    : '';
  return {
    report,
    pendingPath: null,
    sentence: report.size === 0
      ? `analyze: nothing is answered in ${outPath}, so every passage is verified, and each `
        + 'answer is recorded there as it lands.'
      : `analyze: ${report.size} verdict(s) are already in ${outPath} — nothing whose exact question `
        + `is in there is asked again, and every new answer is added to it.${banked}`,
  };
}

/**
 * The header for this run.
 *
 * `engine` comes from the version rather than from the caller so that no route
 * can write a report claiming to have been made by something else.
 */
export function analysisHeader(fields: Omit<AnalysisHeader, 'engine'>): AnalysisHeader {
  return { engine: VERSION, ...fields };
}
