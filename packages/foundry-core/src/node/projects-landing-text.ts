/**
 * projects-landing-text — landing an analysis report and a text pass.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { AnalysisFindingRow, AnalysisReading, LedgerStep, ProjectLedger, RewriteMode } from '../shared/types';
import { pendingBeside, positionOf, translatedInto, translationBankOf } from '../shared/ledger';
import { deletableProjectDir } from './projects-delete';
import { announceProjects, readManifest, withManifest, writeManifest } from './projects-manifest';
import { projectDirOf } from './projects-paths';
import { bookAtPosition } from './projects-positions';
import { destroyPayload, landStep, ledgerOf } from './projects-steps';

/**
 * ONE ANALYSIS STEP'S REPORT, READ AND HANDED TO THE PANEL.
 *
 * ── What crosses, and what deliberately does not ────────────────────────────
 *
 * A finished report is mostly CACHE: one `rank` row per sentence in the book and
 * one `verdict` row per verified passage, every one of them a hash and a number
 * that no surface draws (docs/ANALYSIS.md §6). Those are what make a re-run cheap
 * and they are megabytes; shipping them to a window that would throw them away is
 * a cost paid for nothing. So this keeps the header and the `finding` rows and
 * drops the rest at the parse.
 *
 * ── The staleness question is answered HERE, and that is a deviation ────────
 *
 * docs/ANALYSIS.md §8 asks the RENDERER to refuse a stale report by comparing the
 * header's `bankSha` against the book's. It cannot: `BookLoad` does not carry the
 * book file's `source` block, and widening it for one panel would put a
 * provenance field on every viewer in the app for one reader. Main holds both
 * facts at this instant — it has the report open and it can name the book file
 * the step was run against — so the comparison is made where they are both in
 * hand and what crosses the boundary is the SENTENCE. `AnalysisReading.stale`
 * carries it.
 *
 * A STALE REPORT IS STILL DRAWN. Every finding in it is a true measurement of the
 * bank that minted it; what it may no longer be is a true measurement of the
 * bank this project stands on now. The honest answer is the list with the caveat,
 * which is `BookLoad.unplaced`'s own precedent — refusing to open would take a
 * person's hour away in order to protect them from a sentence.
 *
 * A REFUSAL IS A SENTENCE AND NOT A THROW, for `loadBookAt`'s reason: a report
 * whose step was deleted, or whose file somebody removed by hand, is an ordinary
 * state a person should meet as a line on a panel rather than as a broken column.
 */
export async function readAnalysisReport(
  dir: string,
  stepId: string,
): Promise<{ ok: true; reading: AnalysisReading } | { ok: false; reason: string }> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  const step = ledger.steps.find((one) => one.id === stepId) ?? null;
  if (step === null || step.action !== 'analysis') {
    return {
      ok: false,
      reason: 'That analysis is not in this book\'s history any more, so there is no report to read. '
        + 'It was probably deleted while this panel was open.',
    };
  }
  const file = path.join(resolved, ...step.payload.split('/'));
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return {
      ok: false,
      reason: 'The report this step recorded is not on the disk any more. Analysing again from the '
        + 'step it was run against will write it back — every answer is keyed to the question that '
        + 'produced it, so nothing that survived is asked twice.',
    };
  }

  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (first === undefined) {
    return { ok: false, reason: 'That report is empty — the run that wrote it never finished.' };
  }
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(first) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'That report does not begin with a header this app can read.' };
  }
  if (typeof header['analysis'] !== 'number') {
    return { ok: false, reason: 'That file is not an analysis report — it declares no format.' };
  }
  /*
   * FORMAT 1 IS THE ENTAILMENT RANKER'S, and it is refused rather than drawn.
   * Its findings carry no reason for the panel to show, and half of them are the
   * rejections the display tiers used to ghost — a report of a different kind
   * from every one written since 2026-09-25 (src/analyze/report.ts,
   * `ANALYSIS_FILE_VERSION`). The engine refuses to extend one for the same reason.
   */
  if (header['analysis'] !== 2) {
    return {
      ok: false,
      reason: 'This report was made by the analysis Foundry used to run, and it has no reasons in it '
        + 'to show. Analyse again from the step it was run against to read this book the current way.',
    };
  }

  const findings: AnalysisFindingRow[] = [];
  for (const line of lines.slice(1)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      /*
       * A MALFORMED LINE IS SKIPPED AND THE REST IS KEPT, which is the engine's
       * own rule for the same file (`AnalysisReport.read`): an interrupted append
       * leaves a half-written last line, and a reader that refused the whole
       * report over it would throw away every verdict that landed before the kill.
       */
      continue;
    }
    if (row['kind'] !== 'finding') continue;
    const id = row['id'];
    const start = row['start'];
    const end = row['end'];
    const hit = row['hit'];
    const category = row['category'];
    const score = row['score'];
    const reason = row['reason'];
    if (typeof id !== 'string' || typeof start !== 'number' || typeof end !== 'number'
      || typeof hit !== 'number' || typeof category !== 'string' || typeof score !== 'number'
      || typeof reason !== 'string') {
      continue;
    }
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
    findings.push({
      hit,
      id,
      start,
      end,
      category,
      reason,
      also: strings(row['also']),
      alsoReasons: strings(row['alsoReasons']),
      score,
      sentences: typeof row['sentences'] === 'number' ? row['sentences'] : 1,
    });
  }

  const reportBank = typeof header['bankSha'] === 'string' ? header['bankSha'] : '';
  const bookBank = await bankShaOfBookAt(resolved, ledger, step);
  const stale = reportBank.length > 0 && bookBank !== null && bookBank !== reportBank
    ? 'This report was measured against an earlier reading of this book. The passages below are '
      + 'what that run found; where the pages have been read again since, the blocks it names may '
      + 'be different blocks now. Analyse again from the step it was run against to measure what is '
      + 'here.'
    : null;

  return {
    ok: true,
    reading: {
      engine: typeof header['engine'] === 'string' ? header['engine'] : '',
      decide: typeof header['decide'] === 'string' ? header['decide'] : '',
      options: typeof header['options'] === 'string' ? header['options'] : '',
      verify: typeof header['verify'] === 'string' ? header['verify'] : '',
      categories: Array.isArray(header['categories'])
        ? header['categories'].filter((one): one is string => typeof one === 'string')
        : [],
      untuned: Array.isArray(header['untuned'])
        ? header['untuned'].filter((one): one is string => typeof one === 'string')
        : [],
      stale,
      findings,
    },
  };
}

/**
 * THE BANK THE BOOK AT THIS STEP'S PARENT CAME FROM — the other half of the
 * staleness comparison, or null when there is nothing to compare against.
 *
 * ── One line of one file, and why that is not a shortcut ────────────────────
 *
 * A book file's first line IS its header (docs/BOOK-FILE.md), and the only field
 * wanted here is `source.bankSha`. `parseBookFile` would read and validate every
 * block of a three-hundred-page book to answer one string, on a call the panel
 * makes every time it opens. So this reads the first line and takes the field,
 * and asks nothing else of the file — which is also why a file that will not
 * parse answers null rather than throwing: this is a caveat, and a caveat that
 * could break the panel would be worse than no caveat at all.
 *
 * THE PARENT AND NOT THE ANALYSIS ROW, because an analysis step's own payload is
 * the report. What the run read was the book at the row it was filed under, which
 * is where `bookAtPosition` is pointed.
 */
export async function bankShaOfBookAt(
  dir: string,
  ledger: ProjectLedger,
  step: LedgerStep,
): Promise<string | null> {
  const under = ledger.steps.find((one) => one.id === step.parent) ?? null;
  try {
    const at = await bookAtPosition(dir, under);
    const handle = await fsp.readFile(at.book, 'utf8');
    const first = handle.split('\n', 1)[0] ?? '';
    if (first.trim().length === 0) return null;
    const header = JSON.parse(first) as Record<string, unknown>;
    const source = header['source'];
    if (typeof source !== 'object' || source === null) return null;
    const said = (source as Record<string, unknown>)['bankSha'];
    return typeof said === 'string' && said.length > 0 ? said : null;
  } catch {
    return null;
  }
}

/**
 * AN ANALYSIS LANDED — the step that keeps the report, filed under the row it was
 * run against.
 *
 * Owen's ruling, verbatim: *"the analysis can probably live as another step under
 * the step it was run against, just like the regular workflow."* So it is
 * `recordTextPass`'s shape below, with everything a translation owes a book
 * taken out of it: no bank to displace, no derived book to materialise, no
 * language to record, and no chain to work out. A report is measured, filed and
 * finished.
 *
 * THE POINTER DOES NOT FOLLOW, which `RETAINED_BESIDE_YOU` says once in the
 * ledger and `appendStep` obeys. An analysis runs for an hour; where the person
 * is standing when it lands is nobody's decision, and moving them off the step
 * they were editing would be the punishment that table exists to stop.
 *
 * A FAILURE HERE IS LOGGED AND NEVER THROWN, `recordTextPass`'s rule and its
 * reason: the report is on the disk, complete and question-keyed, and losing a
 * row in a catalogue is not a reason to report an hour of verified passages as a
 * failed job. The line names what went unrecorded and why.
 */
export async function recordAnalysis(
  reportPath: string,
  landed: {
    /** The position when the job was ENQUEUED. See `Job.parentStep`. */
    parentStep?: string | null;
    /**
     * The categories the run actually looked for, in plan order — the QUESTION
     * this step asked (`PARAMS_OF.analysis`).
     *
     * IT COMES FROM THE JOB because nothing on disk can answer it afterwards.
     * The report's header lists them, and reading a param back out of a payload
     * is what this codebase's oldest house rule forbids — so the run that asked
     * says what it asked for, exactly as a translation says which language.
     */
    categories: readonly string[];
    /** The verify model, the answer pile's one member. See `MINTED_BY_THE_RUN`. */
    model?: string;
    /**
     * `AnalyzeRequest.stepId` — the step the report file was named after, minted
     * at the plan (`reportForAnalysis`). Landing under a freshly minted id would
     * leave the file named after a row nobody created. Spent only on an append,
     * which is `LandedRun.id`'s own rule.
     */
    stepId?: string;
  },
): Promise<void> {
  const resolved = path.resolve(reportPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} is outside any project, so no analysis was recorded.`);
    return;
  }
  try {
    await withManifest(dir, async (manifest) => {
      const landing = await landStep(manifest, {
        action: 'analysis',
        parent: landed.parentStep ?? null,
        /*
         * WHERE THE ENGINE ACTUALLY WROTE, spelled project-relative with forward
         * slashes — what `LedgerStep.payload` is and what `destroyPayload` splits
         * again to reach the file, so nothing here ever matches by basename.
         */
        payload: path.relative(dir, resolved).split(path.sep).join('/'),
        params: {
          categories: [...landed.categories],
          ...(landed.model !== undefined && landed.model.length > 0 ? { model: landed.model } : {}),
        },
        createdAt: Date.now(),
        // Minted at the plan and written into a filename since; spent here, and
        // only if this appends.
        ...(landed.stepId !== undefined ? { id: landed.stepId } : {}),
      });
      await writeManifest(dir, manifest);
      /*
       * After the write, never before. Null on every ordinary re-analysis: a
       * replace was AIMED at the target step's own report before the job was
       * enqueued (`reportForAnalysis`), so the path genuinely did not move. It
       * does real work in the one case where a path can drift between the plan
       * and the landing — a run planned as a branch landing as a replace, because
       * the step it would have branched beside was deleted while it ran.
       */
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
    });
    // The tree draws from the ledger and the panels repaint from the position,
    // and both hear about it the one way anything in this app hears that a
    // project moved.
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${path.basename(dir)} could not record its analysis (${(err as Error).message}). `
      + 'The report is on disk, and every answer in it is keyed to the question that produced it, so '
      + 'analysing again pays only for what is missing.',
    );
  }
}

/**
 * A TRANSLATION LANDED — the step that keeps what it cost, and the one landing in
 * this app whose product is not a document.
 *
 * ── Why this is not `recordGenerated` with another role ─────────────────────
 *
 * Because nothing was generated. `recordGenerated` files a finished ORIGIN: it
 * puts a row on that type's chain in `manifest.documents`, it can promote the
 * result to the project's live PDF, and it refuses anything that is not directly
 * in `generated/` — every line of it is about a document somebody will open. A
 * records translation writes `readings/<key>.<tag>[.<id8>].records.jsonl` and no
 * document at all; the book comes later, cast from this file, as a rendering that
 * is nobody's payload (`castForTranslateStep`).
 *
 * So this is `recordReading`'s shape rather than `recordGenerated`'s, which is the
 * right family for a much better reason than convenience: both actions run a model
 * over a whole book, both leave a `.jsonl` of per-position answers in `readings/`,
 * and for both of them the payload IS that file. A read step's bank has been its
 * payload since docs/BANK-LIFECYCLE.md §4.1; this is the same sentence about the
 * other model pass, and it means `orphanedPayloads` protects and destroys a
 * translation's answers by a rule nobody had to teach it.
 *
 * ── The two facts the job hands over, and why neither is read off the disk ──
 *
 * THE LANGUAGE, because the alternative is reading a fact out of a filename. It
 * decides whether the next translation from this step replaces this row or
 * branches beside it (`MINTED_BY_THE_RUN` keeps every other param out of that
 * comparison), it is what a cast is declared as, and it is what the row says.
 *
 * THE SOURCE LANGUAGE, WHEN THIS RUN WAS A CHAIN. `params.from` is written by
 * nothing else, and it exists so a row in a two-hop chain can say both ends —
 * "Translated (en → hu)" — where the target alone would leave two rows looking
 * alike and the interesting fact legible only by walking parents.
 *
 * ── And the bank a replaced row used to name ────────────────────────────────
 *
 * Re-translating a row that predates records swaps its payload from an EPUB in
 * `generated/` to a records file in `readings/`. `Landing.displaced` destroys the
 * book — it is a payload, no surviving row names it — and the BANK beside it is
 * not a payload at all, so nothing else in this app would ever mention it again.
 * It goes here, guarded the way the ledger guards a payload: by the whole
 * project-relative path, against what every surviving step MEANS by its bank.
 *
 * A failure is a console line and never a throw, exactly as `recordReading`'s is.
 * This runs after a run that may have taken hours; a catalogue row that could not
 * be written is not a reason to report those hours as a failure, and the records
 * are on disk either way.
 */
export async function recordTextPass(
  recordsPath: string,
  landed: {
    /**
     * WHICH OF THE THREE PASSES THIS WAS — the action the step lands as.
     *
     * IT IS THE JOB'S OWN KIND, HANDED OVER, and it is the whole of what the
     * 2026-09-05 split changed at this landing. A rewrite used to land as
     * `translate` carrying `params.rewrite`, and the row therefore called itself a
     * translation of a book nobody translated; Owen: *"it isnt a translate job.
     * naming it translate is deceptive."*
     *
     * IT CANNOT BE DERIVED HERE. The presence of a `rewrite` would tell a simplify
     * from a translation and would tell neither of them from a cleanup, which
     * carries no distinguishing param at all — `PARAMS_OF.clean` is empty on
     * purpose. So the run that was ordered says which act it was, exactly as it
     * says which language it asked for.
     *
     * OPTIONAL, DEFAULTING TO `translate`, because every caller before this wave
     * meant a translation and this parameter bag is the shape a landing hands over
     * — the same courtesy every other field here gets.
     */
    action?: 'translate' | 'simplify' | 'clean';
    /** The position when the job was ENQUEUED. See `Job.parentStep`. */
    parentStep?: string | null;
    /**
     * `TranslateRequest.to`, as the dialog named it — and ABSENT FOR A CLEANUP,
     * which goes into no language (`PARAMS_OF.clean`, shared/ledger.ts).
     */
    language?: string;
    /**
     * `TranslateRequest.stepId` — the step the records file was named after,
     * minted at the plan (`recordsForTextPass`).
     *
     * A branching translation writes `readings/<key>.<tag>.<id8>.records.jsonl`,
     * and the `id8` is the front of this uuid. Landing under a freshly minted id
     * would leave the file named after a row nobody created. Spent only on an
     * append, which is `LandedRun.id`'s own rule.
     */
    stepId?: string;
    /**
     * `TranslateRequest.rewrite` — which rewrite this was, for a run that said the
     * book again in its own language.
     *
     * IT COMES FROM THE JOB FOR THE LANGUAGE'S OWN REASON, and it is the second
     * fact nothing on disk can answer afterwards. The mode is in the records file's
     * NAME, and reading it back out of one is what this codebase's oldest house
     * rule forbids — so the run that asked says which, exactly as it says which
     * language it asked for. Absent for every translation, which is what keeps
     * `translatedInto` composing the params it has always composed.
     */
    rewrite?: RewriteMode;
    /** A readings-only cleanup's name (`CleanRequest.readingsOnly`, `LedgerParams.readings`). */
    readings?: string;
  } = {},
): Promise<void> {
  const resolved = path.resolve(recordsPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} is outside any project, so no translation was recorded.`);
    return;
  }
  try {
    await withManifest(dir, async (manifest) => {
      const before = ledgerOf(manifest);
      /*
       * ── WHETHER THIS IS A CHAIN IS A FACT ABOUT THE TREE, ASKED HERE ─────────
       *
       * A run is a chain exactly when the row it hangs off is itself a
       * translation — *"german to english to hungarian"* — and that is knowable
       * from the ledger without anybody asserting it over the wire. The job DOES
       * carry a `--from`, and it is deliberately not read for this: that field is
       * a command line, and it also holds the language a person typed into an
       * optional box for a book nobody has translated yet. Recording that as the
       * step's `from` would put "(de → en)" on the ordinary single-hop row of
       * everybody who fills the field in, which is the wording the ruling says
       * those rows keep.
       *
       * THE PARENT IS RESOLVED THE WAY `landStep` RESOLVES IT — the captured row
       * if this ledger still holds it, the position if it was deleted while the
       * run went — because the answer has to be about the row this step is
       * actually going to hang from. That rule is stated in one place and asked
       * in two, which is worth one line here rather than a landing that describes
       * a parent it did not use.
       */
      const under = before.steps.find((step) => step.id === landed.parentStep)
        ?? positionOf(before);
      /*
       * A CHAIN IS A PASS UNDER A ROW THAT DECLARES A LANGUAGE, which is a
       * translation or a rewrite and never a cleanup: a cleaned book is in
       * whatever language it was already in, and `params.language` on a `clean`
       * row does not exist to be read. So the test is the two-member family
       * (`translationInEffect`'s own list) rather than `translate` alone — without
       * the widening, translating a book somebody had SIMPLIFIED would record no
       * `from` and the row would drop the arrow it earned.
       */
      const from = under !== null && (under.action === 'translate' || under.action === 'simplify')
        ? under.params?.language?.trim() ?? ''
        : '';
      const action = landed.action ?? 'translate';
      const landing = await landStep(manifest, {
        action,
        parent: landed.parentStep ?? null,
        /*
         * WHERE THE ENGINE ACTUALLY WROTE, spelled project-relative with forward
         * slashes — which is what `LedgerStep.payload` is and what `destroyPayload`
         * splits again to reach the file, so nothing here ever matches by basename.
         */
        payload: path.relative(dir, resolved).split(path.sep).join('/'),
        /*
         * A CLEANUP CARRIES NO PARAMS AT ALL, and the empty bag is not written
         * (`landStep`/`mint` drop one). `translatedInto` would compose `{}` for it
         * anyway — no language, no mode — but the `from` beside it would not: a
         * cleanup made under a translation would have recorded the parent's
         * language as `params.from`, which `readParams` refuses by name because
         * `PARAMS_OF.clean` declares nothing. The refusal would arrive on the next
         * open of the project, about a step this app had just written itself.
         */
        // A readings-only pass carries its name, which is its identity (`PARAMS_OF.clean`).
        params: action === 'clean' ? translatedInto(undefined, undefined, landed.readings) : {
          ...translatedInto(landed.language, landed.rewrite),
          ...(from.length > 0 ? { from } : {}),
        },
        createdAt: Date.now(),
        // Minted at the plan and written into a filename since; spent here, and
        // only if this appends.
        ...(landed.stepId !== undefined ? { id: landed.stepId } : {}),
      });
      /** The bank the step named BEFORE this landing, for the displacement below. */
      const bankWas = landing?.replaced === true
        ? translationBankOf(
          before.steps.find((step) => step.id === landing.step.id) ?? landing.step,
          manifest.key,
        )
        : null;
      await writeManifest(dir, manifest);
      // After the write, never before: the replacement is on disk and recorded, so
      // whatever the swap displaced is now a file nothing in this project names.
      // Null on every ordinary re-translation, because a replace was AIMED at the
      // target step's own records before the job was enqueued.
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
      if (
        bankWas !== null
        && !ledgerOf(manifest).steps.some((step) => translationBankOf(step, manifest.key) === bankWas)
      ) {
        await destroyPayload(dir, bankWas);
        for (const debris of pendingBeside(bankWas)) await destroyPayload(dir, debris);
      }
    });
    // The tree draws from the ledger and the panes repaint from the position, and
    // both hear about it the one way anything in this app hears that a project
    // moved.
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${path.basename(dir)} could not record its text pass (${(err as Error).message}). `
      + 'The records are on disk, so casting the book from them is free whenever it is asked for.',
    );
  }
}
