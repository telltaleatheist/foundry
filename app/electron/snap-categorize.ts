/**
 * THE CATEGORIZE TILE'S RUN — bring snap up, ask every block, bring snap down,
 * and land the answers as an edit step.
 *
 * Owen, 2026-09-22: *"the foundry tile should bring the model up, categorize
 * everything, and bring the model back down."* This is that, in that order, with
 * the bring-down in a `finally` so a failure or a cancel still gives the card
 * back. What the model is shown and what its answers become is the pure half,
 * `shared/snap-categorize.ts`; this file owns the processes, the HTTP and the
 * landing.
 *
 * ── Two engines: a Crucible's vLLM, or this machine's llama.cpp ────────────
 *
 * It began outside Crucible on Owen's word — *"not through crucible yet — good
 * call"* — on the belief that Crucible could not return the letter probabilities
 * snap reads. It can: the chat door forwards the body, `logprobs` included, to
 * vLLM. So `crucible` places the run like any `analysis` act (the server's
 * selected model, loaded and leased) and snap's openai-chat engine asks through
 * that door; `local` is the original llama-server stack, kept while the two are
 * compared. Owen, 2026-09-22: *"go ahead and integrate vllm."* snap itself still
 * runs here — it is the thin question-asker, not a model — and becomes a
 * Crucible job type if the tile earns its place.
 *
 * ── The stack: snap's own scripts, not a second spelling of them ────────────
 *
 * snap ships `scripts/serve.ps1` (llama-server, flags checked against the
 * binary's own --help, PID file, log under runs/) and `scripts/stop.ps1` (which
 * refuses to kill a reused PID). They are driven as they are; `snap serve` is the
 * decision server in front of them. A stack that is ALREADY answering is used and
 * left running — it is not this press's to stop.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  blockQuestion, bookHeader, buildGroups, decide, DEFAULT_SNAP_POLICY, groupState,
  isAsked, lineMarks, sectionsOf, titleConfirmQuestion, type SnapCategorizeResult, type SnapCategorizeSettings,
  type SnapChoiceAnswer, type SnapPolicy, type SnapProgress, type SnapReportRow,
} from '../shared/snap-categorize';
import type { BookOp } from '../shared/ops';
import { applyBookOps, loadBook } from './book';
import { CRUCIBLE_CHAT_CONCURRENCY, placeJob, type Lease, type Placement } from './crucible-dispatch';
import { broadcast } from './window';

/** Where snap listens, and where its engine does — snap's README defaults. */
const SNAP_PORT = 8480;
const ENGINE_PORT = 8481;
const SNAP_URL = `http://127.0.0.1:${SNAP_PORT}`;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

/** How long the engine may take to load, and how long one request may run. */
const ENGINE_READY_MS = 5 * 60_000;
const SNAP_READY_MS = 60_000;
const REQUEST_MS = 20 * 60_000;

/** Room kept free in the engine's window for the question, the options and the answer. */
const QUESTION_RESERVE_TOKENS = 1_024;

export class SnapCategorizeError extends Error {}

/** The one run in flight, so a second press is refused and Cancel has something to abort. */
let running: { projectDir: string; abort: AbortController } | null = null;

/**
 * WHAT THIS PROCESS BROUGHT UP AND HAS NOT YET BROUGHT DOWN — held here, not in
 * the run, because the run's `finally` is not the only way out.
 *
 * Measured 2026-09-22 on the first real run: the app closed mid-run (a rebuild
 * under the running window), the `finally` never ran, and the model stayed on the
 * card holding 15+ GB until it was stopped by hand. `stopSnapOnQuit` is the quit
 * path's copy of the bring-down, reached from `stopFoundry` — which BookForge
 * awaits on its own shutdown and standalone Foundry calls from `before-quit`.
 */
let broughtUp: { stack: Stack; home: string } | null = null;

export function cancelSnapCategorize(): boolean {
  if (running === null) return false;
  running.abort.abort();
  return true;
}

/** The app is quitting: abort any run and bring down whatever this process started. */
export async function stopSnapOnQuit(): Promise<void> {
  running?.abort.abort();
  const held = broughtUp;
  if (held === null) return;
  await bringDown(held.stack, held.home);
}

function say(progress: SnapProgress): void {
  broadcast('snap:progress', progress);
}

/** GET a URL, answering whether it said 200 — never throws. */
async function answers200(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, ms: number, what: string, signal: AbortSignal): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (signal.aborted) throw new SnapCategorizeError('Cancelled while waiting for the model to start.');
    if (await answers200(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new SnapCategorizeError(`${what} did not answer ${url} within ${Math.round(ms / 1000)} s.`);
}

/** Run a snap PowerShell script to completion, answering its output or throwing its words. */
function runScript(snapHome: string, script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(snapHome, 'scripts', script), ...args,
    ], { cwd: snapHome, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', (err) => reject(new SnapCategorizeError(`${script} could not be run: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new SnapCategorizeError(`${script} failed (exit ${code}): ${out.trim().slice(-800)}`));
    });
  });
}

/** What this press brought up, so the `finally` brings down exactly that. */
interface Stack {
  startedEngine: boolean;
  snapChild: ChildProcess | null;
  /** The engine's actual context, read from it — never the one asked for. */
  contextTokens: number;
  /**
   * THE CRUCIBLE PATH'S HOLD on the model, or null for a local run. Releasing it
   * IS the bring-down: the server clears the card the moment its last holder lets
   * go (crucible/settle.py — *"models should always be unloaded when we're done
   * with them"*), so this press never unloads a model somebody else still holds.
   */
  lease: Lease | null;
  /** Which model answered, and where — for the tally and the report. */
  answeredBy: string;
}

function checkSnapHome(home: string, needed: readonly string[]): void {
  for (const file of needed) {
    if (!existsSync(path.join(home, ...file.split('/')))) {
      throw new SnapCategorizeError(`${path.join(home, ...file.split('/'))} is missing — is "${home}" the snap folder, set up per its README?`);
    }
  }
}

/** `snap serve` in front of whichever engine, answering once its health does. */
async function startSnap(
  stack: Stack,
  home: string,
  engineArgs: readonly string[],
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  if (await answers200(`${SNAP_URL}/v1/health`)) {
    /*
     * A snap already listening sits in front of an engine this press did not
     * choose — the other path's, or one started by hand — and its answers would
     * be that engine's. Refused by name rather than silently used.
     */
    throw new SnapCategorizeError(
      `Something is already answering on port ${SNAP_PORT} (a snap server this press did not start). Stop it and press again.`,
    );
  }
  stack.snapChild = spawn(path.join(home, '.venv', 'Scripts', 'snap.exe'), [
    'serve', '--port', String(SNAP_PORT), ...engineArgs,
  ], { cwd: home, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  await waitFor(`${SNAP_URL}/v1/health`, SNAP_READY_MS, 'snap', signal);
}

async function bringUp(settings: SnapCategorizeSettings, signal: AbortSignal, projectDir: string): Promise<Stack> {
  const home = settings.snapHome;
  const stack: Stack = { startedEngine: false, snapChild: null, contextTokens: 0, lease: null, answeredBy: '' };
  // Registered BEFORE anything starts, so a quit during the model's load still
  // finds it — `startedEngine` and `lease` are set the moment each exists.
  broughtUp = { stack, home };
  try {
    if (settings.engine === 'crucible') await bringUpOnCrucible(stack, home, signal, projectDir);
    else await bringUpLocal(stack, settings, signal, projectDir);
    return stack;
  } catch (err) {
    await bringDown(stack, home);
    throw err;
  }
}

async function bringUpLocal(stack: Stack, settings: SnapCategorizeSettings, signal: AbortSignal, projectDir: string): Promise<void> {
  const home = settings.snapHome;
  checkSnapHome(home, ['scripts/serve.ps1', 'scripts/stop.ps1', '.venv/Scripts/snap.exe']);
  if (!await answers200(`${ENGINE_URL}/health`)) {
    say({ projectDir, phase: 'starting', message: `Starting the model (Qwen3.5 9B, ${settings.contextTokens.toLocaleString()}-token window)…` });
    await runScript(home, 'serve.ps1', [
      '-Background', '-Ctx', String(settings.contextTokens), '-Checkpoints', '32',
    ]);
    stack.startedEngine = true;
    await waitFor(`${ENGINE_URL}/health`, ENGINE_READY_MS, 'The model server', signal);
  } else {
    say({ projectDir, phase: 'starting', message: 'A model server is already running on this machine — using it, and leaving it running afterwards.' });
  }
  stack.contextTokens = await engineContext();
  stack.answeredBy = 'Qwen3.5 9B on this machine (llama.cpp)';
  await startSnap(stack, home, ['--engine', ENGINE_URL], {}, signal);
}

/** How long between placement attempts while a server says "not yet". */
const PLACEMENT_RETRY_MS = 15_000;

/**
 * THE CRUCIBLE PATH — placed exactly like an `analysis` act from the queue.
 *
 * `placeJob` owns the walk: which registered server, its SELECTED model for
 * analysis (the app stores no model — the server's capability record says), the
 * `load-model` with the lease riding on it, and the header map. Its lane claim
 * here says yes to everything, the precedent `runNow` set for a dialog's own
 * run: the deciding already happened, at the button, and this run is not on the
 * queue's board.
 *
 * A TRANSIENT wait (the card busy, a load cancelled) is weather: its sentence is
 * shown and the placement asked again until it goes or Cancel is pressed. A
 * STANDING wait or a refusal is something only a person can change, and ends
 * the run with the server's own words.
 */
async function bringUpOnCrucible(stack: Stack, home: string, signal: AbortSignal, projectDir: string): Promise<void> {
  checkSnapHome(home, ['.venv/Scripts/snap.exe']);
  const line = (message: string): void => say({ projectDir, phase: 'starting', message });
  let placement: Placement;
  for (;;) {
    const outcome = await placeJob('analysis', undefined, line, () => true, signal);
    if (outcome.verdict === 'go') { placement = outcome.placement; break; }
    if (outcome.verdict === 'refuse' || outcome.standing) throw new SnapCategorizeError(outcome.reason);
    line(`Waiting: ${outcome.reason}. Asking again in ${PLACEMENT_RETRY_MS / 1000} s…`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PLACEMENT_RETRY_MS);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal.aborted) throw new SnapCategorizeError('Cancelled while waiting for a server.');
  }
  stack.lease = placement.lease;
  const where = placement.slot?.name ?? 'a Crucible';
  if (placement.via !== null || placement.lease === null || placement.endpoint === null || placement.model === null) {
    /*
     * AN UPSTREAM ROUTE has no card and no logits this tile can read whole —
     * snap reads the letter probabilities of a model it can see. For this tile
     * that is misconfiguration, said by name.
     */
    throw new SnapCategorizeError(
      `"${where}" sends analysis to ${placement.via ?? 'an upstream service'} rather than a model on its own card. `
      + "Categorizing reads a model's letter probabilities; choose a server that runs analysis itself.",
    );
  }
  const headersJson = placement.env['FOUNDRY_ENDPOINT_HEADERS'];
  if (headersJson === undefined) throw new SnapCategorizeError(`The placement on "${where}" carried no header map.`);
  const headers = JSON.parse(headersJson) as Record<string, string>;
  // The engine's own rule (`normaliseVllmEndpoint`, src/translate/vllm.ts): an
  // OpenAI-shaped server mounts `models` and `chat/completions` under `/v1`.
  const base = `${placement.endpoint.replace(/\/+$/, '')}/v1`;
  stack.contextTokens = await servedContext(base, placement.model, headers, where);
  stack.answeredBy = `${placement.model} on ${where} (Crucible)`;
  line(`Starting snap against ${placement.model} on ${where}…`);
  // The token rides in the ENVIRONMENT, never on the command line — the
  // `FOUNDRY_ENDPOINT_HEADERS` rule (crucible-dispatch.ts, Placement.env).
  await startSnap(stack, home, [
    '--engine-kind', 'openai-chat',
    '--engine', `${base}/chat/completions`,
    '--engine-model', placement.model,
    '--concurrency', String(placement.concurrency ?? CRUCIBLE_CHAT_CONCURRENCY),
  ], { SNAP_ENGINE_HEADERS: headersJson }, signal);
}

/** The context the resident model was started with — its listing row's `max_model_len`. */
async function servedContext(base: string, model: string, headers: Record<string, string>, where: string): Promise<number> {
  const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SnapCategorizeError(`"${where}" answered ${res.status} for its model listing.`);
  const body = await res.json() as { data?: { id?: unknown; max_model_len?: unknown }[] };
  const row = body.data?.find((entry) => entry.id === model);
  if (row === undefined) throw new SnapCategorizeError(`"${where}" does not list ${model} as resident after loading it.`);
  if (typeof row.max_model_len !== 'number' || row.max_model_len <= 0) {
    throw new SnapCategorizeError(`"${where}" did not say how large ${model}'s context is (no max_model_len).`);
  }
  return row.max_model_len;
}

/** The context the running engine was started with (llama-server `/props`). */
async function engineContext(): Promise<number> {
  const res = await fetch(`${ENGINE_URL}/props`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SnapCategorizeError(`The model server's /props answered ${res.status}.`);
  const props = await res.json() as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
  const n = props.default_generation_settings?.n_ctx ?? props.n_ctx;
  if (typeof n !== 'number' || n <= 0) {
    throw new SnapCategorizeError('The model server did not say how large its context is (/props has no n_ctx).');
  }
  return n;
}

async function bringDown(stack: Stack, home: string): Promise<void> {
  if (broughtUp?.stack === stack) broughtUp = null;
  if (stack.snapChild !== null && stack.snapChild.exitCode === null) stack.snapChild.kill();
  if (stack.lease !== null) {
    // Idempotent and never throws (`Lease.release`); the server settles the card.
    await stack.lease.release();
    stack.lease = null;
  }
  if (stack.startedEngine) {
    try {
      await runScript(home, 'stop.ps1', []);
    } catch (err) {
      // Said, not swallowed: a model left on the card is the one outcome of this
      // tile somebody has to act on.
      broadcast('snap:progress', {
        projectDir: '', phase: 'failed',
        message: `The model could not be stopped: ${(err as Error).message} — stop it with snap's scripts\\stop.ps1.`,
      } satisfies SnapProgress);
    }
  }
}

/** One `/v1/decide` call: a state and a batch of block questions. */
async function ask<A>(
  state: string,
  questions: Record<string, object>,
  signal: AbortSignal,
): Promise<Record<string, A>> {
  const res = await fetch(`${SNAP_URL}/v1/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
  });
  const body = await res.json() as { answers?: Record<string, A>; error?: { code: string; message: string } };
  if (!res.ok || body.answers === undefined) {
    throw new SnapCategorizeError(
      `snap refused the request (${res.status}): ${body.error ? `${body.error.code} — ${body.error.message}` : 'no answers in its reply'}`,
    );
  }
  return body.answers;
}

/**
 * CATEGORIZE THE BOOK AT THIS PROJECT'S POSITION.
 *
 * The book is read at the position with every recorded edit replayed
 * (`loadBook`), every block snap is asked about gets one `choice` question, and
 * the confident changes land through `applyBookOps` — the Apply button's own door
 * — as one edit step. The report of every answer is written beside the project
 * whatever happens to the step, because "how did it perform" is the question
 * this tile exists to answer.
 */
export async function snapCategorize(
  projectDir: string,
  settings: SnapCategorizeSettings,
): Promise<SnapCategorizeResult> {
  if (running !== null) {
    throw new SnapCategorizeError('A categorization is already running. Wait for it, or cancel it first.');
  }
  if (settings.engine !== 'local' && settings.engine !== 'crucible') {
    throw new SnapCategorizeError(`Unknown engine "${String(settings.engine)}" — expected local or crucible.`);
  }
  const abort = new AbortController();
  running = { projectDir, abort };
  let stack: Stack | null = null;
  try {
    const loaded = await loadBook(projectDir);
    if (!loaded.ok) throw new SnapCategorizeError(loaded.reason);
    const rows = loaded.rows;
    const policy: SnapPolicy = {
      minConfidence: settings.minConfidence ?? DEFAULT_SNAP_POLICY.minConfidence,
      minLabelMass: settings.minLabelMass ?? DEFAULT_SNAP_POLICY.minLabelMass,
      minTitleConfirm: DEFAULT_SNAP_POLICY.minTitleConfirm,
    };

    stack = await bringUp(settings, abort.signal, projectDir);

    const header = bookHeader(loaded.title, loaded.chapters);
    const sections = sectionsOf(rows, loaded.chapters);
    const marks = lineMarks(rows, loaded.chapters);
    const groups = buildGroups(rows.length);
    const total = rows.filter(isAsked).length;
    const answers = new Map<string, SnapChoiceAnswer>();
    const titleConfirms = new Map<string, number>();
    for (let g = 0; g < groups.length; g += 1) {
      if (abort.signal.aborted) throw new SnapCategorizeError('Cancelled.');
      const group = groups[g]!;
      const asked = rows.slice(group.askFrom, group.askTo).filter(isAsked);
      if (asked.length === 0) continue;
      const state = groupState(header, rows, sections, group, marks);
      // Refused BY NAME rather than sent to fail inside the engine: a group's
      // state is a few thousand tokens, and a window too small to hold one is a
      // setting to change, not something to retry.
      const needed = Math.ceil(state.length / 3.2) + QUESTION_RESERVE_TOKENS;
      if (needed > stack.contextTokens) {
        throw new SnapCategorizeError(
          `One group of blocks needs about ${needed.toLocaleString()} tokens and the model's window is `
          + `${stack.contextTokens.toLocaleString()}. Choose a larger window.`,
        );
      }
      say({
        projectDir, phase: 'asking',
        message: `Categorizing blocks (${answers.size.toLocaleString()} of ${total.toLocaleString()})…`,
        done: answers.size, total,
      });
      const questions = Object.fromEntries(asked.map((row) => [row.id, blockQuestion(row)]));
      const got = await ask<SnapChoiceAnswer>(state, questions, abort.signal);
      for (const row of asked) {
        const answer = got[row.id];
        if (answer === undefined) {
          throw new SnapCategorizeError(`snap answered the group without an answer for block ${row.id}.`);
        }
        answers.set(row.id, answer);
      }
      // THE TITLE CONFIRMATION, against the same cached group: only the blocks
      // answered Title that were not one already (`titleConfirmQuestion`).
      const toConfirm = asked.filter((row) => got[row.id]!.choice === 'Title' && row.category !== 'Title');
      if (toConfirm.length > 0) {
        const confirmed = await ask<{ p: number }>(
          state,
          Object.fromEntries(toConfirm.map((row) => [row.id, titleConfirmQuestion(row)])),
          abort.signal,
        );
        for (const row of toConfirm) {
          const said = confirmed[row.id];
          if (said === undefined || typeof said.p !== 'number') {
            throw new SnapCategorizeError(`snap answered the Title confirmation without a p for block ${row.id}.`);
          }
          titleConfirms.set(row.id, said.p);
        }
      }
    }

    const startedModel = stack.startedEngine || stack.lease !== null;
    const answeredBy = stack.answeredBy;
    say({ projectDir, phase: 'stopping', message: startedModel ? 'Letting the model go…' : 'Done asking.' });
    await bringDown(stack, settings.snapHome);
    stack = null;

    const decision = decide(rows, answers, loaded.chapters, policy, titleConfirms);
    const reportPath = await writeReport(projectDir, decision.report, { groups: groups.length, policy, answeredBy });
    const ops: BookOp[] = [...decision.categoryOps, ...decision.chapterOps];
    if (ops.length > 0) {
      say({ projectDir, phase: 'applying', message: `Applying ${decision.categoryOps.length} category change(s) and ${decision.chapterOps.length} chapter marker(s)…` });
      await applyBookOps(projectDir, ops);
    }
    const result: SnapCategorizeResult = {
      asked: answers.size,
      changed: decision.categoryOps.length,
      chapters: decision.chapterOps.length,
      lowConfidence: decision.report.filter((row) => row.outcome === 'low-confidence' || row.outcome === 'low-label-mass').length,
      windows: groups.length,
      reportPath,
      startedModel,
      answeredBy,
      applied: ops.length > 0,
    };
    say({
      projectDir, phase: 'done',
      message: ops.length > 0
        ? `Done: ${result.changed} block(s) recategorized, ${result.chapters} chapter marker(s) added.`
        : 'Done: every block already had the category snap chose — nothing to change.',
    });
    return result;
  } catch (err) {
    say({
      projectDir,
      phase: abort.signal.aborted ? 'cancelled' : 'failed',
      message: (err as Error).message,
    });
    throw err;
  } finally {
    if (stack !== null) await bringDown(stack, settings.snapHome);
    running = null;
  }
}

/** Every answer, one JSON line per block, under `<project>/snap/`. */
async function writeReport(
  projectDir: string,
  report: readonly SnapReportRow[],
  meta: { groups: number; policy: SnapPolicy; answeredBy: string },
): Promise<string> {
  const dir = path.join(projectDir, 'snap');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `categorize-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const lines = [JSON.stringify({ kind: 'snap-categorize', at: new Date().toISOString(), ...meta })];
  for (const row of report) lines.push(JSON.stringify(row));
  await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
