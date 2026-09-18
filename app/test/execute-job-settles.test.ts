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
 *
 * ── AND SETTLING IS NOT THE WHOLE OF AN ENDING ──────────────────────────────
 *
 * The two tests below the first two are the same throw measured one layer out.
 * `carry` moves the previous output aside the instant before it spawns, on the
 * invariant the rotation block states about itself — A RUN THAT PRODUCES NOTHING
 * LEAVES THE CATALOGUE EXACTLY AS IT WAS — and the put-back used to be written by
 * hand on the cancel arm and the engine-failed arm and nowhere else. So the throw
 * above, which settles the row correctly, left the book in
 * `generated/archived-<stamp>/` with nothing in `generated/` at all: the exact
 * state `restoreRotation`'s own essay was written to end, reached from the one
 * direction nobody had enumerated.
 *
 * These two are on real disk rather than on a spy, because "the catalogue is as
 * it was" is a claim about files and only files can answer it. The library is a
 * temp directory, the project is two files, and the engine is mocked as above.
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
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
const appSettings = await import('../electron/app-settings');
const projects = await import('../electron/projects');
const queue = await import('../electron/job-queue');

/** The temp libraries the rotation tests below built, swept when each ends. */
const libraries: string[] = [];

afterEach(async () => {
  mock.restore();
  while (libraries.length > 0) {
    const library = libraries.pop();
    if (library !== undefined) await fsp.rm(library, { recursive: true, force: true });
  }
});

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

/**
 * A PROJECT WITH ONE RENDERING ALREADY IN IT — the state a rotation is about.
 *
 * The library is a fresh temp directory per test and `readAppSettings` is bent to
 * point at it, because `projectDirOf` resolves against `<libraryDir>/projects`
 * and a job whose output lands outside every project never rotates at all — which
 * would make both tests below pass for the wrong reason.
 */
async function projectHoldingAPreviousBook(): Promise<{
  output: string;
  generated: string;
}> {
  const library = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-rotation-putback-'));
  // Swept after the test, because a mkdtemp per run would otherwise leave one
  // library per test per suite run in the OS temp directory for ever.
  libraries.push(library);
  const dir = path.join(library, 'projects', 'rotation-keeper-0badc0de');
  const generated = path.join(dir, 'generated');
  await fsp.mkdir(generated, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      key: 'rotation-keeper-0badc0de',
      title: 'The Keeper',
      stem: 'keeper',
      createdAt: 0,
      archive: null,
      documents: [],
      working: { files: [] },
      final: [],
      reading: null,
    }),
    'utf8',
  );
  const output = path.join(generated, 'keeper.epub');
  await fsp.writeFile(output, 'the rendering that was already there', 'utf8');
  const real = appSettings.readAppSettings();
  spyOn(appSettings, 'readAppSettings').mockReturnValue({ ...real, libraryDir: library });
  return { output, generated };
}

/** The `archived-<stamp>` folders a rotation leaves behind, if any. */
async function archivesIn(generated: string): Promise<string[]> {
  return (await fsp.readdir(generated)).filter((name) => name.startsWith('archived-'));
}

test('a run that throws after rotating the previous output puts the rotation back', async () => {
  const { output, generated } = await projectHoldingAPreviousBook();
  placedWithALease(async () => {});
  // The same refusal as the first test: a hosted Foundry with no FOUNDRY_BIN,
  // which throws out of `runEngine` — one statement after the rotation.
  spyOn(engine, 'runEngine').mockImplementation(() => {
    throw new Error('the foundry engine binary was not found and no FOUNDRY_BIN says where it is');
  });
  const { endings, stop } = listening();
  try {
    const row = await queue.runJob({
      kind: 'epub', inputPath: SCAN, outputPath: output, readingsPath: BANK,
    });
    expect(row.state).toBe('failed');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'failed']]);
    // THE WHOLE POINT: the book is where it was, and no archive folder was left
    // standing for a run that wrote nothing.
    expect(await fsp.readFile(output, 'utf8')).toBe('the rendering that was already there');
    expect(await archivesIn(generated)).toEqual([]);
  } finally {
    stop();
  }
});

test('a landing does not put its rotation back, because the product is filed', async () => {
  const { output, generated } = await projectHoldingAPreviousBook();
  placedWithALease(async () => {});
  // The engine writes where it was aimed, which is what makes this a landing
  // rather than the case above wearing a zero exit code.
  spyOn(engine, 'runEngine').mockImplementation(() => ({
    done: fsp.writeFile(output, 'the rendering this run made', 'utf8')
      .then(() => ({ code: 0, stdout: '', stderr: '' })),
    cancel: () => {},
  }));
  // The catalogue write is somebody else's unit, exactly as above.
  spyOn(projects, 'recordGenerated').mockResolvedValue(null);
  const restore = spyOn(projects, 'restoreRotation');
  const { endings, stop } = listening();
  try {
    const row = await queue.runJob({
      kind: 'epub', inputPath: SCAN, outputPath: output, readingsPath: BANK,
    });
    expect(row.state).toBe('done');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'done']]);
    expect(restore).toHaveBeenCalledTimes(0);
    // The new book stands and the old one is still in its archive folder.
    expect(await fsp.readFile(output, 'utf8')).toBe('the rendering this run made');
    expect(await archivesIn(generated)).toHaveLength(1);
  } finally {
    stop();
  }
});
