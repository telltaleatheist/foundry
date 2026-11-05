/**
 * job-queue-products — what a request will make and where, deferred plans, and materializing a request when it spawns.
 */
import * as path from 'node:path';
import { ledgerOf, projectDirOf, readManifest } from './projects';
import { identifyExport, materializeAnalysis, materializeCleanTriage, materializeCleanup, materializeExport, materializeSimplification, materializeTranslation } from './workspace';
import { exportNodeId } from '../shared/host-ops';
import { rowMinting } from '../shared/pending';
import type { DeferredPlan, Job, JobKind, JobRequest, TextPassRequest } from '../shared/types';
import { waitForOfNewJob } from './crucible-registry';
import { capabilityClassOf, CRUCIBLE_READS } from './crucible-dispatch';
import { ANY_SLOT } from '../shared/slots';
import { pendingFor } from './job-queue-enqueue';
import { shelfJobs } from './job-queue-shelf';
import { changed, hostQueue, samePath } from './job-queue-state';
import type { EngineRequest } from './job-queue-state';

/**
 * IS THIS ONE OF THE THREE TEXT PASSES — the queue's own half of
 * `TEXT_PASS_ACTIONS` (shared/ledger.ts).
 *
 * A predicate rather than three comparisons at each of the eight places that ask,
 * and it narrows: every one of those places wants `recordsPath`, `bookPath` or
 * `seedRecords`, which none of the other request shapes has. It was one comparison
 * — `kind === 'translate'` — when a simplify wore the translation's name, and the
 * split would otherwise have turned each of those eight into a two- or three-arm
 * condition that a fourth pass would have to find again.
 */
export function isTextPassRequest(request: EngineRequest): request is TextPassRequest {
  return request.kind === 'translate' || request.kind === 'simplify' || request.kind === 'clean';
}

/**
 * WHAT THIS REQUEST PRODUCES — the one answer, in one place.
 *
 * A row's `outputPath` is three things at once: the file Reveal shows, the
 * identity `pendingFor` dedupes on, and the thing a person asking "where did
 * that go?" is pointed at. For most jobs it is the document the run writes. For
 * the two whose real product is not a document it is that product instead:
 *
 * - **A READING PRODUCES ITS BANK.** `vlm-read` writes no document at all —
 *   `readings/<key>.jsonl` is the expensive, irreplaceable thing the hours of
 *   GPU bought, and everything a person eventually reads is generated from it
 *   afterwards for nothing.
 * - **A TRANSLATION PRODUCES ITS RECORDS.** Since D2 a translate run writes
 *   per-block answers rather than a book; the book is materialised from them by
 *   a cast that costs seconds. So the records file is what collides, what is
 *   worth showing, and what the row is.
 * - **AN ANALYSIS PRODUCES ITS REPORT**, which is `outputPath` already and
 *   therefore needs no line of its own below. It is named here anyway, because
 *   this list is what somebody reads to find out whether their job's product is
 *   the ordinary case, and "it happens to fall through" is not an answer.
 * - **A CLEANUP'S TRIAGE PRODUCES ITS VERDICTS**, which are `outputPath` too and
 *   fall through on the analysis's terms: one file, no document, and the file is
 *   what two presses of one triaged cleanup collide on.
 * - **EVERYTHING ELSE PRODUCES ITS OUTPUT**, which is the ordinary case and
 *   needs no argument.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THREE CORRECT COPIES ─────────────────────
 *
 * It was three, and all three were right: `enqueueHere`, `enqueueTextPass` and
 * `runJob` each spelled as much of the rule as its own argument type could
 * reach. Three correct copies of one rule is a defect with a delay on it — the
 * day the rule gains a fourth kind, or one copy is edited under time pressure,
 * the copies stop agreeing and NOTHING FAILS LOUDLY. The failure is a dedupe
 * that quietly matches the wrong row.
 *
 * That is not a hypothetical. BookForge — Foundry's host, over the same queue
 * shape — shipped exactly this defect: `readingsPath ?? outputPath`, which made
 * every rendering dedupe against the READ that fills the same bank, so a person
 * pressing Generate got handed the hours-long reading row instead of a
 * conversion. Their own diagnosis, kept here in their words because it is the
 * whole reason this function exists: *"I had written the correct rule once and
 * the wrong rule twice, three functions apart."*
 *
 * So the rule lives here, the three callers ask, and there is no second place
 * for it to be true in a slightly different way. It takes the WIDE request type
 * on purpose — `enqueueHere` can only ever hand it a `JobRequest` and
 * `enqueueTextPass` only ever a `TextPassRequest`, and narrowing the parameter
 * to fit either one would put the fork back where it came from.
 */
export function productOf(request: EngineRequest): string {
  if (request.kind === 'read') return request.readingsPath;
  // EVERY TEXT PASS PRODUCES ITS RECORDS, and the test is the family's rather than
  // the translation's: a simplify and a cleanup each write one file of per-block
  // answers and no document, exactly as a translation does, so the records file is
  // what collides, what is worth showing and what the row is.
  if (isTextPassRequest(request)) return request.recordsPath;
  return request.outputPath;
}

/**
 * THE PROJECT A REQUEST NAMES OUTRIGHT, or null — `ConversionRequest.home`,
 * for a product a host asked to have written outside every project. Every
 * caller below asks this FIRST and the path second: `homeOf(request) ??
 * projectDirOf(outputPath)`. For every request this app composes it is null and
 * the path answers, exactly as it always did.
 */
export function homeOf(request: JobRequest | EngineRequest): string | null {
  return 'home' in request && typeof request.home === 'string' ? request.home : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The promised chain — what a row will land, and what it has to wait for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The layer an export lands in, spelled here so `mintsOf` can compose the exact
 * name the catalogue will file (`filedDocuments`, electron/projects.ts, prefixes
 * `final/`). `electron/workspace.ts` and `electron/projects.ts` each keep their own
 * constant for their own purposes; a third one here is this file naming the fact it
 * actually uses rather than importing a name for a string.
 */
export const FINAL_LAYER = 'final';

/**
 * WHAT THIS ROW WILL PUT IN THE TREE — `Job.mints`, decided in the one place that
 * can see the request.
 *
 * ── Why main answers this and not the window ────────────────────────────────
 *
 * Because the answer turns on `export: true`, which is a field of the REQUEST and
 * never reaches a `Job`. The tree can tell an EPUB export from a per-step cast by
 * nothing at all — `kind` says `epub` for both, and the other difference is a
 * filename, which is the one thing this codebase never reads facts out of. So main
 * says it once, on the row, and the tree draws whatever it is told.
 *
 * A TEXT PASS MINTS A STEP, and the id is the one the plan already minted and put
 * on the request (`TranslateRequest.stepId`). That id existed so the records file
 * could be named after a step that will not exist for hours; this is the second
 * thing it buys, and it costs nothing.
 *
 * AN EXPORT MINTS A FILE, and its id is the same `export:<file>` an export ROW
 * already hands the host (`exportNodeId`, shared/host-ops.ts). Composing it here
 * from the layer and the basename rather than waiting for `recordFinal` is what
 * makes the promise and the landed row the SAME node: a narration chained onto the
 * promise comes back parented on an id that is still correct after the file lands,
 * so nothing has to be re-parented and the tree needs no second join.
 *
 * EVERYTHING ELSE ANSWERS `undefined`, which is the filter Owen's ruling implies
 * rather than states: a reading, an analysis, a mint and an environment install all
 * have surfaces of their own, and a Generate's cast is deliberately uncatalogued
 * (`GenerateRequest.forStep`). None of them puts a card in the tree, so none of them
 * has a promise to draw.
 */
export function mintsOf(request: EngineRequest): string | undefined {
  if (isTextPassRequest(request)) return request.stepId;
  // AN ANALYSIS MINTS ITS STEP (2026-10-30), as a text pass does: the card waits
  // in the tree where the report will land, terminal (`LANDS_AS`, shared/pending.ts).
  if (request.kind === 'analysis') return request.stepId;
  // A TRIAGE MINTS NOTHING: the cleanup behind it is the step, and a grayed card
  // for the question in front of the answer would be two cards for one act. Nor
  // does a ranking, for the same reason: the analysis behind it is the step.
  if (request.kind === 'read' || request.kind === 'clean-triage'
    || request.kind === 'analysis-rank') {
    return undefined;
  }
  if (request.export !== true) return undefined;
  return exportNodeId(`${FINAL_LAYER}/${path.basename(request.outputPath)}`);
}

/**
 * THE DEFERRAL A REQUEST CARRIES, or undefined — asked in one place so the two
 * shapes that cannot carry one (a reading, an analysis) are narrowed away once
 * rather than at every reader.
 */
export function deferralOf(request: EngineRequest): DeferredPlan | undefined {
  if (request.kind === 'read' || request.kind === 'analysis' || request.kind === 'analysis-rank') return undefined;
  return request.deferred;
}

/**
 * THE ROW THIS ONE MUST WAIT BEHIND — `Job.after`, composed at the enqueue.
 *
 * ── Why main composes it and the plan does not ──────────────────────────────
 *
 * The plan names a STEP (`deferred.from`), because a plan is about a book. The
 * scheduler needs a ROW, because a queue is about work, and which row is going to
 * land a given step is a fact about a list that only exists at the moment of the
 * press. Hosted it is not even Foundry's list: `shelfJobs()` is the host's rows
 * mirrored, so the id this answers is one the host minted and one the host's own
 * pump understands — which is exactly what makes `after` forwardable across the
 * seam at all.
 *
 * ASKED OF `shelfJobs()` AND NOT `jobs`, and that is the load-bearing line. The
 * promise the person clicked was drawn from the shelf, so the row behind it is in
 * the shelf's list; looking in Foundry's own `jobs` would answer `undefined`
 * hosted for every chain there is, and an undefined `after` means "start whenever
 * the board has room" — the export would run against the position and file the
 * wrong book.
 *
 * UNDEFINED WHEN THE ROW HAS ALREADY GONE, which is a real state and not an error:
 * the parent may have landed and been cleared between the plan and the enqueue.
 * `reconcileChains` is what tells that apart from a row that was lost, because it
 * is the only place that can — by asking the ledger.
 *
 * ── A LINK THE DOOR ALREADY NAMED WINS, AND THAT IS THE WHOLE RULE ─────────
 *
 * `request.after` set before this is asked means main composed the link itself,
 * at the press, from a row it had just minted — the cleanup behind its own triage
 * (`enqueueTriagedCleanup`), the one pair this app orders as a pair. That link is
 * a stronger fact than the deferral's: a deferred cleanup is still made from the
 * promised step, but it waits behind the TRIAGE, which itself waits behind the
 * promise, because a row has one parent. Reading the deferral first would chain
 * the cleanup past its own triage and run the two side by side.
 *
 * SO `Job.after` HAS ONE SOURCE, which is this answer: every door mints its row's
 * link from here (`promisedBy`), and every door that forwards to a host puts the
 * same answer on the request it hands over. There is no second path by which an
 * explicit link reaches a standalone row, and the pump's gate (`chainVerdict`) is
 * the same gate for both — it reads a row id and never asks how the id got there.
 *
 * A REQUEST IN THE STORE CARRIES THE LINK IT WAS FILED WITH, so a Retry that
 * re-sends it re-asks this and gets the same row back. If that row has left the
 * list by then, the link reads `unknown` and `reconcileChains` settles it against
 * the ledger, which is the path a parent that landed and was cleared already takes.
 */
export function chainedBehind(request: EngineRequest): string | undefined {
  if ('after' in request && request.after !== undefined) return request.after;
  const deferred = deferralOf(request);
  if (deferred === undefined) return undefined;
  return rowMinting(shelfJobs(), deferred.from)?.id;
}

/**
 * The promised-chain fields, spread onto a row by all three doors.
 *
 * ONE SPREAD BECAUSE THREE DOORS MINT A ROW — `enqueueHere`, `enqueueTextPass` and
 * `runJob` — and `runJob`'s own docblock already names the hazard: *"a second way
 * of building one would be a second answer to what a job is."* The fields would be
 * copied correctly into all three today and into two of them the day a fourth
 * request shape arrives.
 *
 * ── AND TWO OF THEM ARE FOR THE CARD RATHER THAN THE SCHEDULER ──────────────
 *
 * `into` and `mode` say WHICH translation and WHICH rewrite this row is, so the
 * grayed card the tree draws from it can read "Translated into German" instead of
 * "Translated". They belong here rather than beside `titleForTextPass` because
 * that function composes the SHELF's sentence and this one composes the promise —
 * and `Job.into` exists precisely so that the tree never has to read a fact back
 * out of a sentence. Both come off the request verbatim; a host copies them across
 * the seam like the other two (docs/BOOKFORGE-HANDOFF.md §8b).
 */
export function promisedBy(request: EngineRequest): Pick<Job, 'mints' | 'after' | 'into' | 'mode'> {
  const mints = mintsOf(request);
  const after = chainedBehind(request);
  const into = request.kind === 'translate' ? request.to : undefined;
  const mode = request.kind === 'simplify' ? request.rewrite : undefined;
  return {
    ...(mints !== undefined ? { mints } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(into !== undefined ? { into } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

/**
 * WHICH SLOT THIS ROW WILL WAIT FOR — decided at the PRESS, not at the spawn.
 *
 * ── Why the press, which is `Job.parentStep`'s argument again ──────────────
 *
 * A row can sit in the queue for an afternoon. Reading the standing preference
 * at the spawn would mean a batch queued before somebody added a second server
 * ran somewhere nobody chose, and reading "whichever is ranked first" at the
 * spawn would mean a drag in the settings screen moved four queued books onto
 * another machine — which docs/SLOTS.md §3 rules against in as many words:
 * *"queued rows do NOT move when servers are re-ranked."* So the ANSWER is
 * written onto the row here, and the only thing that changes it afterwards is a
 * person changing it (`setWaitFor`).
 *
 * ── Absent for everything that does not meet a model ───────────────────────
 *
 * An export, a mint, an environment install: no capability class, no placement,
 * no picker. A READING USED TO BE ABSENT TOO and no longer is: `CRUCIBLE_READS`
 * is true (crucible-dispatch.ts) and a reading is dispatched like any other act,
 * so it gets the picker every placed row gets. The guard below stays, because it
 * is the constant that decides it and not a fact about the kind — the day
 * anything turns it back off, the picker goes with it rather than becoming a
 * control that does nothing.
 *
 * ALSO ABSENT WHEN THERE IS NOTHING TO CHOOSE — no slots, or one — which is the
 * friend with a GPU and no Crucible, and every hosted window whose host offers
 * no slot list. `waitForOfNewJob` decides that, once, so the picker's "is there
 * anything to pick" and the row's "what did I pick" cannot disagree.
 */
export function placedBy(kind: JobKind, chosen?: string): Pick<Job, 'waitFor'> {
  /*
   * ── A SCHEDULER'S CHOICE WINS, AND ITS LOSS IS NEVER SILENT ───────────────
   *
   * Hosted, the person picked a machine on the HOST's row, and this app's
   * default is not an answer to that question — it is an answer to a question
   * nobody asked. So `chosen` is taken as given when a placement is possible
   * at all. What it cannot override is whether there IS a placement: an export
   * or a mint puts nothing in front of a model, and a reading stays on this
   * machine while `CRUCIBLE_READS` is false. Both of those drop the name, and
   * both say so, because a control that quietly does nothing is the defect
   * this seam exists to remove.
   */
  if (capabilityClassOf(kind) === null) {
    if (chosen !== undefined) {
      console.error(
        `[slots] a scheduler asked for "${chosen}" on a ${kind} job, which puts nothing in `
        + 'front of a model. The name was dropped.',
      );
    }
    return {};
  }
  if (kind === 'read' && !CRUCIBLE_READS) {
    if (chosen !== undefined) {
      console.error(
        `[slots] a scheduler asked for "${chosen}" on a page reading, which runs on this `
        + 'machine while remote reads are switched off. The name was dropped.',
      );
    }
    return {};
  }
  if (chosen !== undefined) return { waitFor: chosen };
  /*
   * ── HOSTED, A SILENCE IS `any` AND NEVER THIS APP'S SETTING ───────────────
   *
   * Owen, 2026-09-19: *"the server is chosen when it's in the queue. if it isnt
   * chosen or cant be for some reason, it should be 'any'."*
   *
   * THE DEFECT HE HIT. A hosted read arrived with no machine named, fell through
   * to `waitForOfNewJob`, and was answered by `newJobsWaitFor` — which clamps to
   * `top`, so the row was stamped with the NAME of the top-ranked slot. BookForge
   * drew it in the Mac Studio's lane, an engine he had switched off, while the
   * card's own progress line read `crucible@example-pc-wsl` and the PC slot said
   * "Free · Nothing queued wants this slot". Both screens were telling the truth:
   * the row was filed on one machine and the work ran on another.
   *
   * THIS IS THE OTHER HALF OF THE SENTENCE FOUR LINES UP. A host that registers
   * `hostQueue` does the DECIDING (electron/mount.ts; docs/PLAN.md Wave 16: *"we
   * need to centralize the queue in bookforge"*), and that argument does not stop
   * applying because the host happened to say nothing — a setting on a screen
   * nobody opened is no more an answer to the host's question when the host is
   * silent than when it is not. `any` is the reserved word that means *"decide
   * later"*, which is the truth: nobody has chosen, the walk will, and `ranOn`
   * will say where it went. A NAME here is the only answer that can be WRONG.
   *
   * AND UN-HOSTED IS UNTOUCHED, because there the setting is not a stray default
   * — it is the person's own answer, given on the Servers card, to exactly this
   * question. `waitForOfNewJob` carries the rest of that argument, including why
   * `top` becomes a name at the press rather than travelling as the word.
   */
  if (hostQueue() !== null) return { waitFor: ANY_SLOT };
  const waitFor = waitForOfNewJob();
  return waitFor === undefined ? {} : { waitFor };
}

/**
 * The request without its deferral — a copy, so the stored request is untouched
 * until the caller decides to replace it.
 *
 * `delete` RATHER THAN `deferred: undefined`, because the two are different claims
 * and this codebase reads absence as the answer everywhere: `identityOf`'s own rule
 * (*"a bag written `{rewrite: undefined}` said nothing"*), and here it decides
 * whether `argsFor` is about to be handed a request that still thinks it is waiting
 * for something.
 */
export function withoutDeferral<T extends { deferred?: DeferredPlan }>(request: T): T {
  const copy = { ...request };
  delete copy.deferred;
  return copy;
}

/**
 * THE ROW FOLLOWS ITS PRODUCT WHEN THE RE-PLAN MOVES IT — or the row is refused,
 * because something else is already writing the file it just resolved onto.
 *
 * ── Why a row can be renamed at all, when nothing else in this queue is ─────
 *
 * `Job.outputPath` is settled at the enqueue for every job this app has ever run,
 * and it should be: it is the identity `pendingFor` dedupes on and the thing a
 * person is pointed at. A DEFERRED text pass is the one exception, and it is not a
 * loophole — it is the consequence of Owen's ruling that a chain picks its settings
 * up *"from the last step after it finishes"*. Some of what a records file is named
 * after is not knowable until then: the language a rewrite happens in, and whether
 * this ask turns out to be a re-run of a step that only exists once the parent
 * lands. See `materializeAtSpawn`.
 *
 * ── THE DEDUPE IS ASKED AGAIN, AND IT IS THE WHOLE POINT OF THE FUNCTION ────
 *
 * The press dedupes on a name that was provisional, so two rewrites ordered from
 * one promise are two rows that resolve to ONE file — and the queue's own rule is
 * that a file has one live writer. Two engines appending answers to one records
 * file is not a collision that shows up as a crash; it is six hours of a model and
 * a file with two runs' answers interleaved in it. So the second row FAILS BY NAME,
 * which is the shape every unmakeable plan in this app takes, and the sentence
 * names the row that has the file.
 *
 * A ROW IN ANY OTHER STATE IS NOT A CLASH (`pendingFor` matches held, queued and
 * running only): a run that finished an hour ago is history, and refusing a re-run
 * because of it would make the shelf's own record the reason the work is impossible.
 *
 * ── AND IT ANNOUNCES, because the shelf is drawing the old path ─────────────
 *
 * The row's tooltip, its Reveal and the tree's project filter all read this field
 * (`queue-view.service.ts`, `ledger.service.ts`), and a rename nobody was told
 * about is a shelf pointing at a file that will never exist.
 */
export function renameProduct(job: Job, resolved: EngineRequest): void {
  const product = productOf(resolved);
  if (samePath(product, job.outputPath)) return;
  const clash = pendingFor(product);
  if (clash !== undefined && clash.id !== job.id) {
    throw new Error(
      'This work was ordered from a step that had not finished yet, and now that it has, the answers '
      + 'it would write belong in a file another job in the queue is already writing — so running it '
      + 'would put two runs into one file. Nothing was written. Wait for that job to finish, then '
      + 'order this again from the step it lands.',
    );
  }
  job.outputPath = product;
  changed();
}

/**
 * THE MATERIALISE AT SPAWN — the request as the engine will be handed it, or a
 * refusal naming the step it was to be made from.
 *
 * ── What this replaced, and why (PK6) ──────────────────────────────────────
 *
 * It was `materializeDeferred`, and it ran for exactly one kind of row: a pass
 * ordered from a step that had not landed. Every other row's book, seed and
 * generation were composed AT THE PRESS and persisted on the request.
 *
 * That split had the lifetimes backwards. A derived book is unlinked by
 * `sweepDerivedBook` at EVERY ending and by `sweepStaleDerived` after a day; a
 * request outlives its row's first run — Retry re-sends it byte for byte, a
 * resumable Stop leaves it on the step, and hosted it is persisted in somebody
 * else's queue file across restarts. So the path was always the shorter-lived
 * half, and `--book … (ENOENT)` was the reliable consequence (BookForge's
 * 2026-09-20 hunt, F1; F5 is the same defect met through Start). The seed had the
 * same shape with a quieter failure: a file the press named and a Start-over
 * removed was copied by nobody and the run silently paid full price (F8).
 *
 * SO EVERY ROW MATERIALISES HERE, AND A DEFERRAL IS NO LONGER A SPECIAL CASE: it
 * is simply an `at` that did not exist when the button was pressed. One function,
 * one seeding rule, one same-language refusal, one place that can fail by name.
 *
 * ── AND IT IS STILL NOT "THE POSITION" ─────────────────────────────────────
 *
 * The family's standing rule is untouched: *a pointer move made while the job
 * waited must not silently produce a different book*. The row is pinned at the
 * press (`request.at`, or `deferred.from` for a promise) and this resolves THAT
 * id. What is re-asked at spawn is only what had to be read off a chain.
 *
 * ── THE REFUSAL IS THE CASCADE'S LAST LINE ─────────────────────────────────
 *
 * *"if i then remove the cleanup step from the queue, or it otherwise gets lost
 * along the way, everything under that grayed out chain also gets removed."* The
 * queue's own cascade catches the removals and failures it can see
 * (`cascadeFrom`); this catches everything else — a row that succeeded without
 * landing, a step deleted between the landing and this spawn, a host that ran a
 * chained row out of order. Running against the position instead would be the
 * silent wrong answer: an export of the book WITHOUT the cleanup, filed under the
 * name the cleaned one was going to have.
 *
 * ── AND THE DEFERRED HALF IT KEPT ──────────────────────────────────────────
 *
 * `stepId` is KEPT, always, and is the one field this never takes from the
 * re-plan: the tree drew a card with that id and a person chained work behind it,
 * so landing under a freshly minted id would orphan every child at the moment its
 * parent succeeded. It is handed BACK IN (`recordsForTextPass`'s `minted`), which
 * is what makes the two askings agree about one step rather than merely one path.
 * The RECORDS PATH is taken from the re-plan for a deferred row only — a
 * placeholder resolving, or a re-run that could not match at the press because
 * nothing is parented to a promise — and `renameProduct` moves the row with it.
 */
export async function materializeAtSpawn(
  request: EngineRequest,
  /**
   * THE ROW THIS REQUEST BELONGS TO, because a name is not only a fact about a
   * request. `Job.outputPath` is what the shelf reveals, what the dedupe compares
   * and what the landing files as a payload, so a re-plan that moves the file has
   * to move the row with it and say so (`changed()`).
   */
  job: Job,
): Promise<EngineRequest> {
  /*
   * A READING MAKES NO BOOK, and it is the one kind that never did: it puts pages
   * in front of a model and fills a bank. Nothing here has anything to say about
   * it, and asking the ledger about a project mid-import would be work for an
   * answer nobody reads.
   */
  if (request.kind === 'read') return request;
  const deferred = deferralOf(request);
  const dir = homeOf(request) ?? projectDirOf(productOf(request));
  /*
   * WHICH ROW, AND THE TWO WAYS A REQUEST NAMES ONE. `deferred.from` is the
   * promise's parent — the row that had to land first — and `at` is the row the
   * press was standing on or clicked. Both are ids; neither is "the position now".
   *
   * NULL IS AN ANSWER AND NOT AN ABSENCE: a project that held no steps when the
   * button was pressed has the reading's own book file, which is exactly what
   * `materializeBook` answers for a null row.
   */
  const named = deferred !== undefined ? deferred.from : request.at ?? null;
  if (dir === null) {
    /*
     * ── A FILE OUTSIDE EVERY PROJECT, AND THE TWO THINGS THAT CAN MEAN ───────
     *
     * NOTHING WAS NAMED. There is no chain to replay and nothing that was ever
     * going to be replayed: a rendering aimed at a path this library does not
     * hold, which the landing already says so about (`landReadProducts`) and
     * which the CLI's own doors reach. The request stands as it is, and a run
     * that needed a book meets `bookOf`'s refusal at its command line.
     *
     * A ROW WAS NAMED AND CANNOT BE FOUND. That is a claim about a project, made
     * by a request that outlived it, and it is refused here rather than run
     * against whatever is nearest.
     */
    if (named === null) return request;
    throw new Error(
      'This work was to be made from a step in a project this library no longer holds — so the '
      + 'book it was to read cannot be made, and there is nothing to run it against.',
    );
  }
  const ledger = ledgerOf(await readManifest(dir));
  const step = named === null ? null : ledger.steps.find((row) => row.id === named) ?? null;
  if (named !== null && step === null) {
    throw new Error(
      'The step this was to be made from never landed, so there is nothing to make it out of. '
      + 'Whatever was going to produce it left the queue — order this again from a step that exists.',
    );
  }
  if (isTextPassRequest(request)) {
    /*
     * THE SAME THREE MAKERS THE PRESS'S THREE IDENTIFIERS ARE PAIRED WITH.
     * `materializeSimplification` can still refuse here (a book that never declared
     * a language) and `materializeTranslation` carries the same-language refusal
     * that a deferred pass could not be given at the press. Either way the throw
     * becomes a failed row wearing main's own sentence.
     */
    const plan = request.kind === 'translate'
      ? await materializeTranslation(request.inputPath, request.to, step, request.stepId)
      : request.kind === 'simplify'
        ? await materializeSimplification(request.inputPath, request.rewrite, step, request.stepId)
        : await materializeCleanup(request.inputPath, step, request.stepId, request.readingsOnly?.label);
    const next = withoutDeferral(request);
    next.bookPath = plan.bookPath;
    /*
     * THE SEED IS TAKEN WHOLE, PRESENT OR ABSENT. A stale one left on the request
     * would be a path the copy skips in silence, which is the defect (F8) this
     * whole move exists to end — so an absent answer DELETES rather than leaving
     * what the press believed.
     */
    if (plan.seedRecords !== undefined) next.seedRecords = plan.seedRecords;
    else delete next.seedRecords;
    if (plan.generation !== undefined) next.generation = plan.generation;
    if (deferred !== undefined) {
      /*
       * ── THE NAME THE CHAIN CAN FINALLY SAY ──────────────────────────────────
       *
       * Only for a promise, because only a promise's name was provisional. See the
       * header: a placeholder resolving, or a re-run that can match now that the
       * parent exists. The STAMP travels with it — a cleanup's stamp is NAMED FROM
       * the records file and nothing else, so leaving it behind would hand the
       * compile a receipt for a file nobody wrote.
       */
      next.recordsPath = plan.recordsPath;
      if (next.kind === 'clean' && plan.stampPath !== undefined) next.stampPath = plan.stampPath;
      /*
       * AND THE LANGUAGE, WHICH FOR A REWRITE IS BOTH ENDS. `--from` is the chain's
       * source language and a cleanup has none to carry. A rewrite also takes its
       * `to` from here, which is the half Owen's chain-anything ruling added: both
       * ends of a rewrite are one fact and a deferred one had no way to state it.
       * A translation's `to` was typed by a person and is never touched.
       */
      if (next.kind !== 'clean' && plan.from !== undefined) next.from = plan.from;
      if (next.kind === 'simplify' && plan.from !== undefined) next.to = plan.from;
      renameProduct(job, next);
    }
    return next;
  }
  if (request.kind === 'analysis' || request.kind === 'analysis-rank') {
    // AN ANALYSIS IS NEVER DEFERRED — `analysis` has no `deferred` field at all
    // (`AnalyzeRequest`), because no tile in this app chains one behind a promise.
    // So the copy is a plain one and the row's name never moves. ITS RANKING
    // MAKES THE SAME BOOK FROM THE SAME ROW (`at` is copied at the press), so the
    // rank file and the report are about one content — the engine checks it, unit
    // by unit, before it verifies anything (src/analyze/run.ts).
    const next = { ...request };
    next.bookPath = (await materializeAnalysis(dir, step)).bookPath;
    return next;
  }
  if (request.kind === 'clean-triage') {
    /*
     * ── A TRIAGE MAKES THE CLEANUP'S BOOK, AND NOTHING ELSE ───────────────────
     *
     * Its own branch, and it has to be: falling through would reach the rendering
     * arm below, which narrows a narration stamp and composes a rendering's inputs
     * for a run that writes neither. What it needs is the book at the row the press
     * pinned — the same row its cleanup carries — so the two read one content
     * (`materializeCleanTriage`, electron/workspace.ts).
     *
     * IT CAN BE DEFERRED, where an analysis cannot: a cleanup pressed on a greyed
     * card orders its triage deferred on the same promise, and `named` above has
     * already resolved that promise to the step it landed. The deferral is dropped
     * from the copy because it is spent; the NAME never moves — the verdicts file
     * was fixed at the press, and the cleanup behind this row is already carrying
     * it (`CleanRequest.triagePath`).
     */
    const next = withoutDeferral(request);
    next.bookPath = (await materializeCleanTriage(dir, step)).bookPath;
    return next;
  }
  /*
   * A RENDERING, AND THE ONE EXTRA ASKING A PROMISED ONE NEEDS. The chain facts an
   * export reads — which records, which language, whose stamp — could not be
   * composed at the press of a promise, so they are composed now at the landed row
   * before the book is made from it. An ordinary export composed them at the press
   * and keeps them; only the BOOK and the narrowing were ever spawn work.
   */
  const next = withoutDeferral(request);
  let claimed = request.narrationStamp;
  if (deferred !== undefined) {
    const plan = await identifyExport(request.inputPath, request.kind, step);
    if (plan.narrationStamp !== undefined) next.narrationStamp = plan.narrationStamp;
    if (plan.records !== undefined) next.records = plan.records;
    if (plan.language !== undefined) next.language = plan.language;
    claimed = plan.narrationStamp;
  }
  const made = await materializeExport(dir, request.kind, step, claimed);
  if (made.bookPath !== undefined) next.bookPath = made.bookPath;
  /*
   * AND THE CLAIM IS NARROWED OR WITHDRAWN. An empty narrowing drops the field
   * rather than carrying a path of no characters, exactly as the plan did when it
   * owned this: no reader of a `GenerateRequest` has to know that the empty string
   * means anything.
   */
  if (claimed !== undefined) {
    if (made.narrationStamp !== undefined) next.narrationStamp = made.narrationStamp;
    else delete next.narrationStamp;
  }
  return next;
}
