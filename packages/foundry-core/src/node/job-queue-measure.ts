/**
 * job-queue-measure — the context a run needs, measured from its own book before
 * it is placed.
 *
 * Owen, 2026-11-11: *"maybe we can request the context we'll need from crucible
 * before it loads the model"*, and asked whether a fixed figure per kind of work
 * would do, *measure each book first*. A Simplify had failed because Crucible
 * started the 27B at 11,317 tokens with too little KV cache for it; the book's
 * largest request needed about 5,200.
 *
 * So a measured kind (`MEASURED_KINDS`) is planned once by the engine with
 * `--measure-context`, which reads the book, plans every request exactly as the
 * run will, prints the largest one's need and exits without asking a server
 * anything. The figure goes to Crucible as the session's `contextTokens`: the
 * least context the model may start at.
 *
 * THE BOOK IS MADE FOR THE MEASURE AND SWEPT AFTER IT, because the run's own
 * materialise comes after the placement on purpose (job-queue-carry.ts): a row
 * that waits must leave the temp directory as it found it. Making it twice costs
 * a second of replay; the need is kept per row, so a parked row that is picked
 * again is not measured again.
 *
 * A MEASURE THAT FAILS FAILS THE ROW, by name. It is the engine reading a book
 * it is about to read anyway, with no server and no network, so a failure here
 * is a defect or a broken book — something a person has to look at — and not
 * weather to wait out.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Job } from '../shared/types';
import { readContextNeed } from './context-need';
import { runEngine } from './engine';
import { analysisChecklistJson, MEASURED_KINDS, measureArgsFor } from './job-queue-args';
import { sweepDerivedBook } from './job-queue-gestures';
import { materializeAtSpawn } from './job-queue-products';
import { changed } from './job-queue-state';
import type { EngineRequest } from './job-queue-state';

/**
 * Each measured row's need, by row id: a number, or null for a run that would ask
 * no model anything. Kept while the row is parked so a re-pick does not measure
 * again; dropped by `forgetMeasure` once the row is placed or settles.
 */
const measured = new Map<string, number | null>();

export function forgetMeasure(jobId: string): void {
  measured.delete(jobId);
}

/** The engine's last few stderr lines, for the row's error. */
function tailOf(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.slice(-3).join(' / ');
}

/**
 * The least context this row's model may start at, or undefined for a kind that
 * measures nothing and for a run that would ask no model anything. Throws with
 * the sentence the row fails with when the measure itself fails.
 */
export async function measureRun(next: Job, request: EngineRequest): Promise<number | undefined> {
  if (!MEASURED_KINDS.has(request.kind)) return undefined;
  const known = measured.get(next.id);
  if (known !== undefined) return known ?? undefined;

  next.message = 'Measuring the context this run needs…';
  next.note = null;
  changed();
  const made = await materializeAtSpawn(request, next);
  /*
   * NO BOOK WAS MADE: a file outside every project, which `materializeAtSpawn`
   * hands back as it stands. The run's own command line refuses it by name
   * (`bookOf`), after the placement, as it always has; there is nothing here to
   * measure and no second refusal to compose.
   */
  if ((made as { bookPath?: string }).bookPath === undefined) return undefined;
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-measure-'));
  try {
    let checklist: string | null = null;
    if (made.kind === 'analysis' && made.categories.length > 0) {
      checklist = path.join(scratch, 'categories.json');
      await fsp.writeFile(checklist, analysisChecklistJson(made), 'utf8');
    }
    const args = measureArgsFor(made, checklist);
    if (args === null) return undefined;
    console.log(`[job] ${next.kind} measure: ${args.join(' ')}`);
    const result = await runEngine(args).done;
    const read = result.code === 0 ? readContextNeed(result.stdout) : null;
    if (read === null) {
      throw new Error(
        'Measuring the context this run needs failed before anything was sent to a server'
        + (result.code === 0 ? ', and the measure printed no figure' : ` (exit ${result.code})`)
        + `: ${tailOf(result.stderr) || 'the engine said nothing'}`,
      );
    }
    measured.set(next.id, read.contextTokens);
    return read.contextTokens ?? undefined;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
    await sweepDerivedBook(made);
  }
}
