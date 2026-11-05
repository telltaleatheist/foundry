/**
 * workspace-analysis — which file an analysis is, and making it.
 */
import * as path from 'node:path';
import { materializeBook } from './book';
import { ProjectError, importDocument, ledgerOf, readManifest, reportForAnalysis } from './projects';
import { positionOf } from '../shared/ledger';
import type { AnalysisPlan, LedgerStep } from '../shared/types';

/**
 * WHERE THIS BOOK'S ANALYSIS GOES — the report the run writes and the step it
 * will be filed as.
 *
 * ── The same three moves the translation plan makes, and one it does not ────
 *
 * It resolves the project from a document the person has open, it materialises
 * THE POSITION'S OWN BOOK for the engine to read, and it asks the ledger which
 * step this run belongs to before a single question is put to a model. All three
 * are `planTranslation`'s, for `planTranslation`'s reasons.
 *
 * WHAT IT DOES NOT DO IS REFUSE ANYTHING ABOUT LANGUAGE. An analysis is not a
 * transformation of the book — it measures whatever words are at this position,
 * in whatever language they are in — so there is no same-language trap to guard
 * and no chain to work out. The ranker's lines are English and the untuned ones say
 * so in the report; that is a fact about the method, argued in docs/ANALYSIS.md
 * §5, and not a decision this plan gets to make.
 *
 * ── THE BOOK IS MATERIALISED, AND IT IS THE WHOLE OF WHY THE PANEL CAN BE
 *    HONEST ────────────────────────────────────────────────────────────────
 *
 * A report's rows are `[start, end)` offsets into a block's text (docs/ANALYSIS.md
 * §6), so the file the run reads decides what those offsets are offsets INTO.
 * Handed the reading's own book file, every finding inside a block somebody had
 * edited would be drawn in the wrong place — silently, because an offset that
 * lands somewhere is indistinguishable from an offset that lands correctly.
 * Handed the position's materialised book, the offsets agree with the paper at
 * the instant the button was pressed, and the only drift left is an edit made
 * afterwards, which the panel reports as an unplaced hit.
 *
 * AT PLAN TIME, on `planExport`'s and `planTranslation`'s rule: which state of the
 * book this is is the state the person chose when they pressed the button, and
 * materialising at spawn would let a pointer move made while the job waited
 * measure a different book than the dialog said it would.
 *
 * NO UNAPPLIED GUARD, and that is a ruling rather than an omission
 * (docs/ANALYSIS.md §7). The guard protects acts that consume a RENDERING; this
 * run reads the book and writes a report beside it, consuming no rendering and
 * moving no pointer — the sweep's rule, decided explicitly.
 */
export async function identifyAnalysis(
  inputPath: string,
  /** The categories that were ticked, in plan order. See `AnalysisAsk`. */
  categories: readonly string[],
): Promise<AnalysisPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  /*
   * WHICH REPORT AND WHICH STEP, asked of the ledger before anything is spawned.
   * A re-analysis of the same step against the same checklist aims at that step's
   * own file — which is what makes it nearly free, since every rank score and
   * every verdict in there is filed under the question that produced it — and a
   * different checklist mints a step and a file of its own (`analysisTarget`).
   */
  const planned = await reportForAnalysis(dir, categories);
  /*
   * ── AND THE BOOK IS MADE AT THE SPAWN (PK6) ───────────────────────────────
   *
   * `materializeAnalysis` below. The row is pinned here, so the offsets in the
   * report are still offsets into the book the person pressed on — see
   * `TranslateRequest.at` for why the PATH may not cross and the ROW must.
   */
  const ledger = ledgerOf(await readManifest(dir));
  return {
    key,
    sourcePath: inputPath,
    outputPath: planned.outputPath,
    stepId: planned.stepId,
    at: positionOf(ledger)?.id ?? null,
  };
}

/**
 * THE BOOK AN ANALYSIS READS, MADE AT THE SPAWN.
 *
 * A report's rows are `[start, end)` offsets into a block's text
 * (docs/ANALYSIS.md §6), so the file the run reads decides what those offsets are
 * offsets INTO. Handed the reading's own book file, every finding inside a block
 * somebody had edited would be drawn in the wrong place — silently, because an
 * offset that lands somewhere is indistinguishable from one that lands correctly.
 * Handed the row's materialised book, the offsets agree with the paper at the
 * instant the button was pressed, and the only drift left is an edit made
 * afterwards, which the panel reports as an unplaced hit.
 *
 * A REFUSAL HERE IS THE PERSON'S OWN SENTENCE, `materializeTranslation`'s rule:
 * what this will not do is spend an hour of GPU on a book it could not assemble,
 * because findings keyed to blocks nobody can put back are findings about nothing.
 */
export async function materializeAnalysis(
  projectDir: string,
  at: LedgerStep | null,
): Promise<{ bookPath: string }> {
  const derived = await materializeBook(projectDir, at);
  if (!derived.ok) throw new ProjectError(derived.reason);
  return { bookPath: derived.path };
}
