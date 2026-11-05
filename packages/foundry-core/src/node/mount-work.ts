/**
 * mount-work — the work behind the mount seam's functions, with no window in it.
 *
 * Moved out of electron/mount.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2).
 * mount.ts keeps the scheme registration, the protocol handler, `setPlatform` and
 * the window, and re-exports these by the same names, so a host calling them off
 * mount.js calls exactly what it called before. Library code — nothing here
 * reaches Electron.
 */
import * as path from 'node:path';

import * as queue from './job-queue';
import { ledgerOf, listProjects, projectDirOf, readManifest } from './projects';
import { identifyCleanup, identifyExport } from './workspace';
import { stepOf } from '../shared/ledger';
import { deferralFor } from '../shared/pending';
import { carriedFromPlan, DEFAULT_CLEAN_TEXT_MODEL, DEFAULT_OLLAMA_ENDPOINT } from '../shared/pipeline';
import { fold, originalOf } from '../shared/original';
import type { CleanRequest, ExportLanding, Job, JobRequest } from '../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// The EPUB a host's act needs, made without anybody pressing anything
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE EXPORT THIS PROCESS IS WAITING ON — a path, and what to do when it lands.
 *
 * The path is the identity because it is the queue's own: `enqueue` refuses to
 * hold two live jobs writing one file and hands back the pending one instead
 * (`pendingFor`), so at any moment at most one run in this app is going to
 * produce this name. Matching on it therefore matches OUR job even when the
 * queue answered our enqueue with somebody else's — which is the ordinary case
 * when a person pressed Export on the same row a second earlier.
 */
interface AwaitedExport {
  path: string;
  landed(landing: ExportLanding): void;
}

const awaitingExports = new Set<AwaitedExport>();

/**
 * HAND ONE LANDING TO EVERY CALL WAITING ON ITS PATH — the second half of the
 * fan-out in `mountFoundry`'s one `onExportLanded` listener, which tells the host
 * first and then calls this.
 */
export function settleAwaitedExports(landing: ExportLanding): void {
  for (const waiting of [...awaitingExports]) {
    if (fold(waiting.path) === fold(landing.path)) waiting.landed(landing);
  }
}

/**
 * MAKE THE EPUB OF ONE STEP, unattended, and answer with the landing.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, on finding narrate offered only where a file already existed: *"i dont
 * think its intuitive to know you have to create an epub before you can narrate.
 * i think we should make any of the steps possible to narrate. if they arent
 * doing it from an epub then we export the epub automatically and then run the
 * task they assigned."*
 *
 * A host's act consumes a FINISHED FILE, and a person standing on a translation
 * three rows into their history has words rather than a file. The old answer was
 * to offer the act only on `final/` rows and let them go and make one; this is
 * the other answer, and it is the one that matches what somebody means when they
 * press Narrate on a step. THE HOST DECIDES WHEN TO ASK: it declares its act on
 * both currencies (`HostOperationOffer.appliesTo`), and when an invoke arrives
 * naming a step it has no export for, it calls this.
 *
 * ── What it is, and what it deliberately is not ─────────────────────────────
 *
 * IT IS THE EXPORT DIALOG'S OWN PATH WITH NOBODY IN FRONT OF IT. The same
 * `planExport`, the same `JobRequest` the dialog composes, the same queue, the
 * same landing — because an export made for a host must be indistinguishable
 * from an export somebody pressed for: same name in `final/`, same rotation of
 * the predecessor, same row in the tray, same announcement to whoever is
 * listening. A second, quieter route to a filed document would be a second truth
 * about what an export is.
 *
 * IT ASKS NOTHING, and it can afford not to. The dialog has exactly one question
 * — the format — and this one is an EPUB by definition: it exists because a host
 * act wants the book as a file, and `epub` is what that means. Every other
 * decision an export makes is main's already (the pixels, the bank, the
 * translation's words, the derived book with the changes replayed into it).
 *
 * ── THE ONE CARD IT CANNOT RAISE, NAMED HERE SO IT IS NOT DISCOVERED TWICE ──
 *
 * Every make-act pressed in the Foundry window is now gated on unapplied work:
 * Export, Translate, Simplify and a host act all ask first when the book pane is
 * holding changes nobody applied, because a make-act is arithmetic over the
 * RECORDED STEPS and would otherwise quietly produce the book without them
 * (`UnappliedService`, src/app/core/unapplied.service.ts — the defect it was
 * written for). THIS CALL IS NOT GATED AND CANNOT BE. It runs in main, ordered by
 * the host over the mount seam, with no window to draw a card in and nobody in
 * front of it — and it may arrive for a project no window in this process has
 * open.
 *
 * It is a known limit rather than a hole, on the same reasoning that lets it ask
 * nothing about the format: the host reaches this because somebody pressed the
 * host's act, that press went through `hostOps.invoke` in a window, and the gate
 * asked its question THERE. What is unreachable is the host calling this on its
 * own initiative — a scheduled run, a retry, an act ordered from the host's own
 * chrome — and closing that would mean either a question main asks of a window
 * that may not exist, or a refusal that stops somebody else's queue over a stack
 * they can no longer see. Neither is worth having; the person's own copy of the
 * work is safe on the sidecar either way.
 *
 * IT IS NOT HELD. A rendering never is (electron/job-queue.ts): it is arithmetic
 * over a bank already on the disk, seconds, no model — so nothing waits for
 * anybody to find the shelf and press Start, which would be the one way an
 * unattended call could hang forever.
 *
 * ── The answer, and the two ways it ends ────────────────────────────────────
 *
 * The promise settles when the JOB does, never on a timer. It resolves with the
 * landing — the same `ExportLanding` the host's `onExport` was handed a moment
 * earlier, path included, so the caller can run its act against the file without
 * composing a path of its own. It rejects when the run ends without filing
 * anything: the engine's own stderr for a failure, a sentence for a cancel or for
 * a row somebody removed from the shelf while it waited.
 *
 * A REFUSAL AT PLAN TIME IS THROWN BEFORE ANY OF THAT, in main's own words —
 * the book nobody has read, the reading that was interrupted, the changes that
 * would not replay. Those sentences are written to be shown to a person, and the
 * host is expected to put them in front of one rather than paraphrase them.
 */
export async function exportEpubFromStep(
  projectDir: string,
  stepId: string,
  /**
   * ── `to`: THE HOST'S OWN PATH, AND NOTHING OF THIS APP'S KEEPS IT ──────────
   *
   * Owen, 2026-09-08: *"any time the user narrates it should imply an epub
   * export … maybe it shouldnt even show the epub unless they intentionally
   * generate one … i dont want 16 outdated epubs hanging around."* So an
   * IMPLIED export — made because Narrate was pressed, not because Export was —
   * is written where the host says (its narrator session's own folder), not in
   * `final/`: it is not filed in the tray, not rotated, not drawn in the tree,
   * and not announced through `onExport`; the landing this promise resolves
   * with says `unfiled` and is the only word anybody hears. EVERYTHING ELSE IS
   * UNCHANGED — the deferred plan for a promised step and its `after`, the
   * narration receipt, the metadata edits, the mint block's inheritance — because
   * the request carries the project as `home` and the queue asks that before it
   * asks the path.
   *
   * ABSOLUTE, `.epub`, AND OUTSIDE EVERY PROJECT, refused by name otherwise: a
   * host that wants the file in `final/` leaves `to` off and gets the filed
   * export it always got; a relative path is the stray-in-the-cwd defect the
   * queue already refuses at enqueue.
   */
  opts?: { to?: string },
): Promise<ExportLanding> {
  /*
   * THE PROJECT AND ITS BOOK, resolved the way the deep link resolves them one
   * function up: `listProjects` and `originalOf`, so a host naming a project gets
   * the same document a click on that book's row would open. The plan only needs
   * the path to find the project — it resolves the pixels out of `archive/` for
   * itself — but it must be a path this app actually holds, which is precisely
   * what a project summary is the record of.
   */
  const project = (await listProjects()).find((row) => fold(row.dir) === fold(projectDir));
  if (project === undefined) {
    throw new Error(`${projectDir} is not a project in this app's library.`);
  }
  const to = opts?.to;
  if (to !== undefined) {
    if (!path.isAbsolute(to)) {
      throw new Error(`"${to}" is not an absolute path, so there is nowhere certain to write the EPUB.`);
    }
    if (!/\.epub$/i.test(to)) {
      throw new Error(`"${to}" does not end in .epub, and the file this makes is one.`);
    }
    if (projectDirOf(to) !== null) {
      throw new Error(
        `"${to}" is inside a project in this app's library. Leave \`to\` off to file the export in `
        + 'the final/ tray of that project the ordinary way; name a path outside the library for one this app does not keep.',
      );
    }
  }
  const original = originalOf(project.documents);
  if (original === null) {
    throw new Error(`${projectDir} holds no document to export from.`);
  }
  /*
   * AND THE ROW, PROVED AGAINST THE LEDGER. `stepOf` refuses by name for an id
   * this project's history does not have, which is the honest answer to a host
   * that has held a step id since before somebody deleted the step — and it is
   * the same refusal every other door in this app gives for the same mistake.
   */
  const manifest = await readManifest(project.dir);
  /*
   * ── AND THE ROW MAY BE A PROMISE, AS OF 2026-09-07 ────────────────────────
   *
   * Owen's ruling puts host acts on rows that have not landed — *"i can click the
   * grayed out exported epub and click narrate"* — and a narration ordered from a
   * promised STEP arrives here rather than at an export row, because the tree hands
   * the host the step's own id and the host brings it straight back to this door for
   * the file its work consumes.
   *
   * SO THE LEDGER IS ASKED FIRST AND THE QUEUE SECOND, and `stepOf`'s refusal is
   * kept for the case it was written about: an id that is in neither. A host holding
   * a step id from before somebody deleted the step still gets that sentence, by
   * name, exactly as it always did.
   *
   * WHAT COMES BACK FOR A PROMISE IS A DEFERRED PLAN — the four deterministic names
   * and nothing that needed a chain — and the request carries the admission through
   * `carriedFromPlan`. `enqueueHere` composes `after` off it (`chainedBehind`), so
   * this export waits for the cleanup rather than racing it, and the promise this
   * function returns settles when the export finally lands or when the chain is
   * cancelled by name. A host awaiting it is waiting for the right thing.
   */
  const ledger = ledgerOf(manifest);
  const landed = ledger.steps.find((row) => row.id === stepId) ?? null;
  const deferral = landed === null
    ? deferralFor(ledger, queue.shelfJobsFor(project.dir), stepId)
    : null;
  // The refusal, unchanged and in the ledger's own words, for an id that is neither
  // a step nor a promise.
  const step = landed ?? (deferral === null ? stepOf(ledger, stepId) : null);
  const plan = await identifyExport(
    original.path,
    'epub',
    deferral !== null ? deferral.landed : step,
    deferral ?? undefined,
  );
  const request: JobRequest = {
    kind: 'epub',
    /*
     * NO `mintMeta` HERE, ON PURPOSE. Nobody is standing at a form, so the
     * settle inherits it (`inheritedMintMetaFor`, electron/job-queue.ts): the
     * project's stored block with the host's own record (`mintMetaFor`)
     * underneath, field by field — the modal's precedence exactly. This door
     * used to spread the stored block alone, and a hosted project minted from
     * a bare document has none until somebody confirms a mint, so the EPUB
     * BookForge narrated went out with the file stem for a title and no
     * author (2026-09-07). The language rule holds without help either way:
     * the settle takes the chain's language over any block's.
     */
    // The pixels, as always: the plan resolved the archived original rather than
    // trusting whatever document anybody was looking at.
    inputPath: plan.sourcePath,
    // The host's own path when it named one, and the project it was made from
    // beside it (`ConversionRequest.home`) — see `to` above.
    outputPath: to ?? plan.outputPath,
    ...(to !== undefined ? { home: project.dir } : {}),
    readingsPath: plan.readingsPath,
    // TERMINAL. Without it the landing files the result as a rendering of the
    // project — a documents row, a live file something later could be built on —
    // which is precisely what an export is not.
    export: true,
    /*
     * THE WORDS, THE LANGUAGE, THE BOOK AND THE NARRATION RECEIPT — carried from
     * the plan, never composed, through the ONE function every builder spreads
     * (`carriedFromPlan`, shared/pipeline.ts). This door used to spell the four
     * spreads by hand and was the only one of three that carried the stamp; the
     * two dialogs stopped a line short and exported unstamped books from cleaned
     * positions (Owen, 2026-09-05). The argument for the stamp mattering MOST on
     * this route still stands — this is the EPUB BookForge narrates — and it is
     * exactly why the carry is no longer a thing a builder can get wrong.
     */
    ...carriedFromPlan(plan),
  };
  const outputPath = request.outputPath;

  return new Promise<ExportLanding>((resolve, reject) => {
    let over = false;
    const waiting: AwaitedExport = {
      path: outputPath,
      landed: (landing) => {
        if (over) return;
        over = true;
        awaitingExports.delete(waiting);
        stopWatching();
        resolve(landing);
      },
    };
    /*
     * BOTH HALVES ARE ARMED BEFORE THE ENQUEUE, and the order is load-bearing
     * rather than tidy. `enqueue` is synchronous and pumps the queue on the way
     * out — a job that loses its request settles inside that call, before this
     * function has resumed — so a listener registered afterwards would miss the
     * one ending it exists to catch.
     */
    awaitingExports.add(waiting);
    const stopWatching = queue.onJobSettled((row) => {
      if (over || fold(row.outputPath) !== fold(outputPath)) return;
      over = true;
      awaitingExports.delete(waiting);
      stopWatching();
      reject(unfiled(row));
    });
    /*
     * THE STEP IS THE PARENT, which is what makes the tray row and the landing
     * both say where this export came from (`ProjectFinal.stepId`,
     * `ExportLanding.stepId`). The IPC door resolves that from the project's
     * POSITION because a person pressing Export is standing on what they mean;
     * here the ask names its own row, and passing the position instead would file
     * a host's export against wherever the window happened to be pointing.
     */
    /*
     * ── `enqueueHere`, AND THIS IS THE LEAST OBVIOUS LINE IN THE WAVE ─────────
     *
     * Wave 16 gave a host the option of owning the queue: `queue.enqueue` hands
     * the request to `hostQueue.enqueue` when one is registered, and the host's
     * pump calls `runJob` when it decides. That is right for everything a PERSON
     * presses in this window — a reading, a generate, an export from the dialog —
     * because those are the jobs that compete for the GPU the host is scheduling.
     *
     * IT IS EXACTLY WRONG HERE, AND THE FAILURE IS A DEADLOCK RATHER THAN AN
     * INEFFICIENCY. This function exists because the host asked for it: an act
     * declared on `'book'` was pressed on a step with no export, so the host
     * called `exportEpubFromStep` and is AWAITING the promise this returns. By
     * making that call the host has already made the scheduling decision — it
     * knows what it is running and it is running it now. Routing this enqueue
     * would push the export back into the host's own queue from inside a call
     * that queue is blocked on: their scheduler would be waiting for a landing
     * that cannot happen until their scheduler runs the row it has just been
     * handed. Two correct-looking rules, one hang, and it would look like a
     * Foundry export that never finishes.
     *
     * SO THE RULE IS ABOUT THE DOOR SOMEBODY CAME THROUGH, not about the kind of
     * job: work ordered through the mount seam is Foundry's own, runs on
     * Foundry's own queue, and is invisible to the host's scheduler by design.
     * The same reasoning makes environment installs unroutable
     * (`enqueueEnvInstall`) — an install is a precondition of the engine running
     * at all, and filing one behind a queue is filing it behind the job that
     * needs it.
     *
     * EVERYTHING ELSE ABOUT THIS EXPORT IS UNCHANGED, which is the whole promise
     * one function up: same plan, same request, same rotation, same `final/` name,
     * same tray row, same landing, same announcement. A host cannot tell this
     * export from one somebody pressed for, and neither can the tray.
     */
    /*
     * THE PARENT IS THE ROW THE ASK NAMED, promise or not. `stepId` rather than
     * `step.id` because a promised export has no `step` to read an id off — and
     * because the two were always the same string: the ask names its own row, and
     * `stepOf` proved it above.
     */
    queue.enqueueHere(request, stepId);
  });
}

/**
 * WHY THIS JOB FILED NOTHING — the sentence a waiter is rejected with.
 *
 * The engine's own stderr where there is one, never paraphrased: it names the
 * missing Python, the block it choked on, the page it could not read, and a
 * summary written here would be this app editing the only account of what
 * happened. The other three arms are states the queue can end in with nothing on
 * disk to point at, and each says which one it was — including `done`, which
 * would mean the run succeeded and the landing never came, and which is worth an
 * astonished sentence rather than a silent wait.
 */
function unfiled(row: Job): Error {
  const file = path.basename(row.outputPath);
  if (row.state === 'failed') {
    return new Error(row.error === undefined
      ? `Making ${file} failed, and the run said nothing about why.`
      : row.error);
  }
  if (row.state === 'cancelled') {
    /*
     * THE ROW'S OWN REASON WHERE IT HAS ONE, which as of the pending-node wave it
     * often does: a cancel that came from the cascade says which promise left the
     * queue (`cascadeFrom`, electron/job-queue.ts), and that is a sentence a host
     * can put in front of its own user. The plain wording stays for the ordinary
     * cancel — somebody pressed the ✕ — where there is nothing more to say.
     */
    return new Error(row.error ?? `Making ${file} was cancelled before it finished.`);
  }
  if (row.state === 'done') {
    return new Error(
      `${file} was made, but nothing filed it into the project's tray — so there is no export to `
      + 'hand back.',
    );
  }
  return new Error(`Making ${file} was taken out of the queue before it ran.`);
}

/**
 * A READINGS-ONLY PASS FROM ONE STEP, composed for the HOST to queue
 * (`CleanRequest.readingsOnly`, 2026-11-01).
 *
 * The host decided the readings and owns the act: it files this request in its
 * own queue and hands the readings file as `RunOptions.fixedReadings` when the
 * row runs, exactly as it hands a cleanup's. What only this app can say is where
 * the answers go and which step they will be — the records file, the stamp, the
 * step id — and those are planned here by the cleanup's own planner, with the
 * pass's `label` as part of its identity, so a second press under the same name
 * replaces the first and a real cleanup from the same step is a different row.
 *
 * NOTHING RUNS HERE AND NOTHING IS QUEUED IN THIS APP. A step that has not landed
 * yet is planned as a promise (`deferred`), as an export ordered from one is.
 */
export async function planReadingsPass(projectDir: string, stepId: string, label: string): Promise<CleanRequest> {
  const name = label.trim();
  if (name.length === 0) throw new Error('A readings pass needs a name for the step it lands as.');
  const project = (await listProjects()).find((row) => fold(row.dir) === fold(projectDir));
  if (project === undefined) throw new Error(`${projectDir} is not a project in this app's library.`);
  const original = originalOf(project.documents);
  if (original === null) throw new Error(`${projectDir} holds no document to write readings into.`);
  const ledger = ledgerOf(await readManifest(project.dir));
  const landed = ledger.steps.find((row) => row.id === stepId) ?? null;
  const deferral = landed === null ? deferralFor(ledger, queue.shelfJobsFor(project.dir), stepId) : null;
  const step = landed ?? (deferral === null ? stepOf(ledger, stepId) : null);
  const plan = await identifyCleanup(original.path, step, deferral ?? undefined, undefined, name);
  if (plan.stampPath === undefined) throw new Error('The cleanup planner named no stamp for this readings pass.');
  return {
    kind: 'clean',
    inputPath: plan.sourcePath,
    recordsPath: plan.recordsPath,
    stampPath: plan.stampPath,
    ...(plan.deferred !== undefined ? { deferred: plan.deferred } : {}),
    // Declared constants, never asked: the pass opens no model (`argsFor`).
    model: DEFAULT_CLEAN_TEXT_MODEL,
    ollama: DEFAULT_OLLAMA_ENDPOINT,
    at: plan.at ?? null,
    stepId: plan.stepId,
    readingsOnly: { label: name },
  };
}

/** `foundryBusy().jobsPending` — held, queued and running rows (the probe's docblock is in mount.ts). */
export function jobsPending(): number {
  return queue.listJobs()
    .filter((job) => job.state === 'held' || job.state === 'queued' || job.state === 'running')
    .length;
}

/**
 * Everything with a lifetime, stopped — for the HOST's quit, and for Foundry's
 * own.
 *
 * A conversion that outlived the app would hold a GPU with nothing left to
 * report to, and so would the reading server, which is ~20 GB of VRAM held by a
 * process nothing is left to talk to. Neither of those is tied to the WINDOW:
 * closing the Foundry window inside BookForge leaves the queue running, exactly
 * as closing a tab does, and it is the host going away that ends them.
 *
 * ── Why it answers with a promise when the sketch said void ─────────────────
 *
 * Because stopping the reading server is a SIGTERM followed by waiting for the
 * process to let go of the GPU, and an Electron that exited underneath it leaves
 * a llama-server orphaned holding the card. That hazard is the host's now as
 * much as it was ever Foundry's, so the host is given the one thing it needs to
 * avoid it: something to wait on before it lets its own quit finish. A caller
 * with nothing to defer can ignore it.
 *
 * IDEMPOTENT, because a quit is a sequence of events rather than one: whoever
 * asks second gets the same promise the first ask made, and the SIGTERM is sent
 * once.
 */
let stopping: Promise<void> | null = null;

export function stopFoundry(): Promise<void> {
  if (stopping !== null) return stopping;
  /*
   * TWO HALVES, AND THE SECOND ONE IS WHY THIS RETURNS A PROMISE AT ALL.
   *
   * `shutdown()` is the gesture: every live child kill-treed, on this app's own
   * board and on a host's detached runs alike. It is synchronous and it does not
   * wait for anything.
   *
   * `drained()` is the WAITING: every run's settle, and every Crucible LEASE those
   * settles are giving back. Until 2026-09-20 this function answered
   * `Promise.resolve()` and the host's 45-second budget therefore bounded nothing
   * — the app exited while the DELETE that releases the card was still a
   * continuation nobody held, leaving a lease that no other client could load
   * past until its TTL ran out (BookForge's P9).
   *
   * The reading server this used to stop was the local page reader's, and there
   * is no local page reader (2026-09-17).
   */
  queue.shutdown();
  stopping = queue.drained();
  return stopping;
}
