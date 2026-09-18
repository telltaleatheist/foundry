/**
 * EVERY ENDING SETTLES — the regression test for the two ways a run could end
 * with the queue never saying it had, both measured on 2026-09-18.
 *
 * `settled()` is the ONE place in electron/job-queue.ts that releases a Crucible
 * lease, clears the wait ledger and tells `onJobSettled`. So a run that ends
 * without reaching it is not a missing notification: it is a card claimed by a
 * process that has finished with it, held by a heartbeat that goes on renewing a
 * two-minute lease for the life of this process, and an `exportEpubFromStep`
 * that never resolves.
 *
 * TWO ENDINGS WERE MISSING, one on each side of the success test:
 *
 *   A THROW. `executeJob`'s docstring says *"Nothing is thrown from here"* and
 *   nothing enforced it, while five unguarded awaits sit after the lease is
 *   recorded — the landings, and `runEngine` itself, whose `engineCommand()`
 *   throws by design when Foundry is hosted with no `FOUNDRY_BIN`. Both callers
 *   wrap it in `try/finally` with NO catch, so the row stayed `running` for ever
 *   and the pump's `void runInSlot(…)` turned it into an unhandled rejection too.
 *
 *   A READING THAT WORKED. The `read` landing ended on `return` where every
 *   other landing ends on `settled(next)` — see the comment at that line for the
 *   history of how the call went missing.
 *
 * The engine is mocked both ways and no child is ever spawned: what is under
 * test is which of this file's own endings reach `settled`, not what an engine
 * does.
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Job } from '../shared/types';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-execute-job-settles-test', name),
    getName: () => 'Foundry',
    getVersion: () => 'test',
    getAppPath: () => path.dirname(import.meta.dir),
    isPackaged: false,
    on: () => {},
    whenReady: async () => {},
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {},
  net: {},
  protocol: {},
  session: {},
  shell: {},
}));

const dispatch = await import('../electron/crucible-dispatch');
const engine = await import('../electron/engine');
const projects = await import('../electron/projects');
const queue = await import('../electron/job-queue');

afterEach(() => mock.restore());

/**
 * A reading placed on a Crucible, holding a lease — the shape the defect needs.
 * The bank is outside every project, so the landing's own `landReadProducts`
 * says so in the terminal and touches no disk (`projectDirOf` answers null).
 */
const BANK = path.join(os.tmpdir(), 'foundry-execute-job-settles-test', 'outside-any-project.jsonl');
const SCAN = path.join(os.tmpdir(), 'foundry-execute-job-settles-test', 'outside-any-project.pdf');

function placedWithALease(release: () => Promise<void>): void {
  spyOn(dispatch, 'placeJob').mockResolvedValue({
    verdict: 'go',
    placement: {
      ...dispatch.UNPLACED,
      endpoint: 'http://127.0.0.1:9/openai',
      model: 'dots-ocr',
      lease: { id: 'held-for-this-run', release },
    },
  });
}

/** Every ending this test heard, in the order it heard them. */
function listening(): { endings: Job[]; stop: () => void } {
  const endings: Job[] = [];
  const stop = queue.onJobSettled((row) => { endings.push(row); });
  return { endings, stop };
}

test('a run that throws after its placement fails the row, settles it once, and gives the lease back', async () => {
  const release = mock(async () => {});
  placedWithALease(release);
  // `engineCommand()`'s own refusal, which is what a hosted Foundry with no
  // FOUNDRY_BIN actually raises out of `runEngine` — a throw, not a failed exit.
  spyOn(engine, 'runEngine').mockImplementation(() => {
    throw new Error('the foundry engine binary was not found and no FOUNDRY_BIN says where it is');
  });
  const { endings, stop } = listening();
  try {
    const row = await queue.runJob({
      kind: 'read', inputPath: SCAN, readingsPath: BANK, stepId: 'throws-after-placement',
    });
    expect(row.state).toBe('failed');
    expect(row.error).toBe('the foundry engine binary was not found and no FOUNDRY_BIN says where it is');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'failed']]);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

test('a reading whose landing succeeds settles, so its lease and its waiter are not held for ever', async () => {
  const release = mock(async () => {});
  placedWithALease(release);
  spyOn(engine, 'runEngine').mockReturnValue({
    done: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    cancel: () => {},
  });
  // The catalogue write is somebody else's unit; what this test is about is the
  // line after it.
  spyOn(projects, 'recordReading').mockResolvedValue(undefined);
  const { endings, stop } = listening();
  try {
    const row = await queue.runJob({
      kind: 'read', inputPath: SCAN, readingsPath: BANK, stepId: 'landing-that-worked',
    });
    expect(row.state).toBe('done');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'done']]);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});
