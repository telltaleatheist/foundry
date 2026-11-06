/**
 * job-queue-carry — one run from spawn to landing. One function, long because it is one linear sequence over shared locals: a run's rotation, its engine child, its outcome and each kind's landing.
 */
import { copyFileSync, existsSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializeTextPass } from './book';
import { parseProgressLine, parseUsageLine, runEngine, stampMintMetadata } from './engine';
import { generatedRoleFor, projectDirOf, recordAnalysis, recordFinal, recordGenerated, recordReading, recordTextPass, rotateFinal, rotateGenerated, type FinalRotation, type Rotation } from './projects';
import type { ConversionKind, ExportMintMetadata, Job } from '../shared/types';
import { ENGINE_PARKED_EXIT } from '../shared/types';
import { type PlacementWait } from './crucible-dispatch';
import { argsFor, categoriesFileFor, metaFlagsFor, recordFor } from './job-queue-args';
import { pump } from './job-queue-board';
import type { RunWires } from './job-queue-board';
import { cancel, discardCancelledReading, release, sweepDerivedBook } from './job-queue-gestures';
import { landReadProducts } from './job-queue-landings';
import { placeRun, sayOutward } from './job-queue-placing';
import { homeOf, isTextPassRequest, materializeAtSpawn } from './job-queue-products';
import { putBack } from './job-queue-run';
import { chainLanguageOf, inheritedMintMetaFor } from './job-queue-settling';
import { PARK_AFTER_WEATHER_MS, changed, engineSentence, exportLanded, jobs, landings, lastEngineStderr, parkedRuns, parkedUntil, requests, resumableStops, slots } from './job-queue-state';
import type { EngineRequest } from './job-queue-state';

/**
 * WHAT A JOB DOES, from the placement to the landing — `executeJob`'s body, and
 * the only reason it is a second function is that a boundary cannot catch what
 * it is inside of.
 *
 * `settle` IS THE CALLER'S, and every ending below goes through it rather than
 * through `settled` directly: see `executeJob`, which owns the counting.
 */
export async function carry(
  next: Job,
  /**
   * THE REQUEST AS IT WAS STORED — identity only. The book, the seed and the
   * generation are made from it INSIDE this function (`materializeAtSpawn`), which
   * is why this is a `let` in all but name: what the engine is handed is the
   * resolved copy, and `requests` is updated to it so the settle sweeps the file
   * this run actually made.
   */
  request: EngineRequest,
  wires: RunWires,
  settle: () => void,
): Promise<PlacementWait | null> {
  if (next.state === 'cancelled') return null;
  /*
   * ── THE JOB THAT LANDS IN THE TRAY INSTEAD OF THE WORKSHOP ────────────────
   *
   * Everything below this line — the server wait, the spawn, the cancel, the
   * progress — is the same for an export as for any other rendering, because an
   * export IS a rendering (`planExport`). What it changes is the two ends: which
   * file the rotation moves aside, and what the settle records.
   *
   * DECIDED ONCE, HERE, because the narrowing that reaches `request.export` is
   * only available on a `GenerateRequest`, and three separate places re-deriving
   * it is three places for one of them to go on treating an export as a generate —
   * which would rotate the project's cast book aside to make room for a file that
   * is not going anywhere near it.
   */
  const rendering: ConversionKind | null = request.kind !== 'read'
    // NO TEXT PASS IS EVER AN EXPORT — the family, where this named the
    // translation alone: none of the three writes a document, so there is
    // nothing to file in the tray and nothing to rotate aside for.
    && !isTextPassRequest(request)
    // AN ANALYSIS IS NEVER AN EXPORT, and the line is here rather than left to
    // the `export` field's absence because the narrowing this const performs is
    // what every reader below depends on. A report is not a rendering: nothing
    // is filed in the tray, no metadata is stamped onto it and no document is
    // rotated aside for it.
    && request.kind !== 'analysis'
    // NOR A CLEANUP'S TRIAGE, on the analysis's argument exactly: its verdicts
    // file is not a document, and nothing about it belongs in the tray. Nor an
    // analysis's ranking, for the same reason.
    && request.kind !== 'clean-triage'
    && request.kind !== 'analysis-rank'
    && request.export === true
    ? request.kind
    : null;
  /*
   * ── ONE EXPRESSION, TWO FACTS: IS THIS AN EXPORT, AND IN WHAT FORMAT ──────
   *
   * It was a boolean, and the narrowing it performed was what every reader below
   * depended on. The materialise further down replaces `request` with the resolved
   * copy, and an assignment ends the compiler's narrowing — so the FORMAT is taken
   * here, while the shape is still narrow, and the boolean is derived from it.
   * Null is every kind that has no format at all: a reading, the three text passes,
   * an analysis, and a rendering nobody asked to export.
   */
  const exporting = rendering !== null;

  next.state = 'running';
  next.startedAt = Date.now();
  next.message = `Starting ${path.basename(next.inputPath)}…`;
  changed();

  /*
   * Whatever idle countdown was armed, a conversion is starting — and not only
   * an endpoint-mode one: under `auto` the ENGINE probes port 8000 for itself
   * and will happily read through a still-warm server this app owns, so a
   * timer allowed to keep ticking here could pull the backend out from under a
   * running book.
   *
   * BUSY STAYS FOUNDRY'S EVEN WHEN THE DECIDING IS NOT. It is said from in here
   * rather than from the scheduler above, so a job the host chose says it as
   * surely as one the pump chose — which is the half of the drain rule that does
   * not move when a host takes the queue over (`hostQueueDrained`).
   */

  /*
   * The reading server, before the engine that will post pages to it. A remote
   * endpoint is used exactly as given — only the local one is ours to start.
   *
   * ONLY A READING WAITS FOR IT, and that is the whole rule. `vlm-read` is the
   * one job in this app that puts a page in front of a model; every other job
   * either uses a model this app does not own or uses none at all.
   *
   * A RENDERING READS NOTHING. `argsFor` passes `--reuse-readings` on every
   * conversion, without a switch anywhere that could turn it off, so the engine
   * replays the completed bank: it loads no model, opens no socket, and leaves
   * the bank byte for byte as it found it (`readings.ts`, `openReadingsBank`).
   * That is as true of a TRANSLATED rendering as of any other — the translation's
   * words come out of a file on disk, not out of a model. A translation's own
   * model is Ollama's, which this app does not start.
   *
   * This used to be worded as a list of exceptions — translate, and the piped
   * two-stage job — which meant a plain Generate still stood up the whole
   * reading backend and waited for a server it would never address. Pressing a
   * button labelled with a file format lit up the GPU, and the shelf said
   * "Starting the reading server…" over a job that is arithmetic; the user
   * reasonably read that as the model being run again. The exceptions were the
   * majority, so the rule is stated the other way round: the job that reads
   * waits, and nothing else does.
   *
   * WHAT COMES BACK IS TWO FLAGS FOR THE COMMAND LINE, and they are collected
   * here because this is the only moment anything in this app knows them. The
   * served model id is whatever `/v1/models` actually answered — our own
   * llama-server says `dots.ocr` because `--alias` told it to, an adopted vLLM
   * says `rednote-hilab/dots.ocr` — and handing the engine the wrong one would
   * refuse a working server by name in `confirmServedModel`. The concurrency is
   * ours only when the server is: see `PAGE_READER_CONCURRENCY`.
   *
   * ── AND IT HAPPENS AFTER THE PLACEMENT NOW (Wave 62, Package K) ───────────
   *
   * It used to be the first thing a reading did, before `placeRun` had been
   * called at all — which was correct while `CRUCIBLE_READS` was false and every
   * reading ran on this desk. It is not correct now that a reading is dispatched
   * like any other act (crucible-dispatch.ts, whose note carries Owen's ruling):
   * starting first would pull three gigabytes onto this card for a reading that
   * was about to be sent to another machine, and then leave them there.
   *
   * SO THE TEST IS THE PLACEMENT'S, not the settings file's. `placement.endpoint`
   * is null exactly when the run goes through the request's own endpoint — the
   * local slot, and every job this app never placed — and non-null when a
   * Crucible answered. Only the first of those may start a server here.
   */

  /*
   * ── WHERE THIS RUN'S COMPUTE GOES, DECIDED HERE AND ONCE ──────────────────
   *
   * docs/SLOTS.md §3: *"jobs never start on one slot and finish on another. its
   * atomic."* This is that sentence as code — one resolution, and nothing
   * downstream may ask again. A placement that could be re-derived at the
   * metadata stage or after a retry would be a book whose first half was
   * translated by one model and whose second half was translated by another,
   * with one records file claiming both.
   *
   * BEFORE THE SEED COPY AND THE CHECKLIST, deliberately, and on the rule those
   * two state about themselves: a job that has not committed must leave the
   * project exactly as it found it. A row that turns out to be waiting for a
   * server somebody is narrating on goes back to the queue, and it must not have
   * left a seeded records file behind on the way. It is before the READING SERVER
   * for the same rule one turn further out: a parked row must not have loaded a
   * model onto this card on its way to waiting.
   *
   * NULL MEANS THE ROW IS NO LONGER THIS CALL'S — parked back in the queue, or
   * failed with the reason on it. `placeRun` has already said so and published.
   */
  const placed = await placeRun(next, request, wires, settle);
  if (!placed.go) return placed.wait;
  const { placement } = placed;
  /*
   * ── AND WHERE IT WENT IS ANNOUNCED, ONCE, BEFORE ANYTHING SPAWNS ─────────
   *
   * See `RunWires.placed`: the host writes this into its in-flight ledger so a
   * hard kill has something to release the LEASE with. Before the spawn, because
   * a record written after the child exists can be missed by the kill it is for;
   * and its throw is not this run's problem, on `settled`'s rule.
   */
  if (wires.placed !== undefined) {
    try {
      wires.placed({
        server: placement.slot?.name ?? '',
        model: placement.model ?? '',
        sessionId: placement.session?.id ?? null,
        concurrency: placement.concurrency ?? 0,
      });
    } catch (err) {
      console.error(
        `[queue] a placement listener threw for ${next.outputPath}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /*
   * ── A READING WITH NOWHERE TO READ REFUSES, AND SAYS SO ─────────────────
   *
   * What stood here started a model on this computer. If a read had no
   * placement endpoint it fell back to `backend.endpointUrl`, and when that
   * named Foundry's own llama.cpp copy of dots.ocr it printed "Starting the
   * reading server…" and brought one up.
   *
   * Owen, 2026-09-17: *"foundry shouldnt assume there even is a local system.
   * there sohuldnt be a local system. foundry does all ai work through
   * crucible."* So the fallback is gone, and what replaces it is a REFUSAL BY
   * NAME rather than nothing: `placeRun` answering with no endpoint for a
   * reading is now a contradiction — the placement came from a server that
   * said it serves `pages` — and a contradiction that fails quietly is one
   * nobody ever finds. The tile is dark without such a server
   * (electron/act-gates.ts), so reaching this is a defect upstream, and the
   * sentence says which.
   */
  if (next.kind === 'read' && placement.endpoint === null) {
    next.state = 'failed';
    next.error = 'This reading was placed on a server that did not give an address to read '
      + 'through, so there is nowhere to send the pages. Every act that meets a model runs on a '
      + 'Crucible server; Foundry has no reader of its own. Check that the server in Settings › '
      + 'Crucible Servers still serves page reading.';
    next.finishedAt = Date.now();
    changed();
    settle();
    return null;
  }

  /*
   * ── THE BOOK, THE SEED AND THE GENERATION, MADE NOW ──────────────────────
   *
   * HERE — after the placement and before the rotation — and the position is the
   * whole argument. `materializeAtSpawn` writes a derived book into the OS temp
   * directory and resolves a seed off the ledger, and both are work on this row's
   * behalf: a row that turns out to be waiting for a busy card must leave the
   * project, and the temp directory, exactly as it found it. It is also before the
   * rotation, because a deferred pass may RENAME its product here and the rotation
   * moves the file that name points at.
   *
   * THE STORED REQUEST IS REPLACED, because `sweepDerivedBook` at the settle reads
   * `requests` to find the file to unlink, and a sweep that looked at the press's
   * copy would leave the book this run actually made lying in the temp directory
   * for a day.
   *
   * A THROW IS `executeJob`'s BOUNDARY, which is the ending every unmakeable plan
   * in this app already has: the row lands `failed` wearing main's own sentence —
   * "the step this was to be made from never landed" — and nothing is spawned.
   */
  request = await materializeAtSpawn(request, next);
  requests.set(next.id, request);

  /*
   * ── THE TWO INTERMEDIATES THAT USED TO BE HERE, AND WHY THEY ARE GONE ──────
   *
   * A Generate standing under a translation wrote a whole EPUB nobody asked for
   * into the OS temp directory, so that the second stage had something to read;
   * a translate-descended EXPORT wrote a second one, because the tidy that makes
   * an edition refuses an `--out` equal to its `--epub`. Both existed because a
   * translation was a FILE and the only way to get a translated book carrying
   * this position's decisions was to make the book and give it away.
   *
   * A translated book is CAST now — one `vlm-convert`, the records substituted
   * into the blocks as it writes, the edition rules applied by the same run — so
   * there is no half-book to name, no directory this app does not own to put it
   * in, and no stage between the engine and the product. What is left is the
   * ONE intermediate that has nothing to do with translation: the file a run
   * writes when a metadata record is going on afterwards, because both metadata
   * commands refuse to write over their own input.
   */
  /*
   * ── AN EXPORT CARRIES THE RECORD THE PERSON TYPED ─────────────────────────
   *
   * A metadata edit is a step, and the reason it had to become one is exactly
   * this: an export is cast fresh from the bank, the corrections went into the
   * OPF of a working tree, and the working tree is not one of a cast's inputs —
   * so a title corrected in the dialog was silently ABSENT from the book that
   * landed in `final/`. The chain of patches on this position's ancestry is
   * merged (`metadataForProduct`, electron/projects.ts) and applied to the
   * product as the last thing that happens to it.
   *
   * ── Why a stage after, and not a flag on the run that makes the book ──────
   *
   * `vlm-convert` builds the package from the bank and has no notion of a record
   * somebody typed a fortnight later; teaching it one would put the ledger inside
   * the engine. `epub-meta` and `pdf-meta` already do exactly this to a finished
   * file, are already how the dialog writes, and are the same two commands whose
   * refusals the user has already seen.
   *
   * ── Which makes AN intermediate, and it is not avoidable ──────────────────
   *
   * Both commands refuse to write over their input, and both are right to:
   * `pdf-meta` re-emits the whole document through pdf-lib, so an `--out` equal to
   * `--pdf` would destroy the file being read while it was being read. So the
   * engine aims here and the metadata stage lands the destination — which also
   * means a run that gets this far and then cannot stamp the record leaves NO file
   * in the tray, rather than one the user would reasonably believe carries their
   * corrections.
   *
   * NULL FOR EVERY GENERATE, and for an export whose ancestry recorded nothing.
   * `generated/` is the workbench and its casts are re-made constantly; stamping
   * one would be bookkeeping applied to a file nobody keeps.
   *
   * PLAIN TEXT CARRIES NO RECORD AT ALL and is skipped by name: a `.txt` has
   * nowhere to put a title, and there is no third command that would pretend
   * otherwise.
   */
  /*
   * THE PATCH ITSELF, READ ONCE. It used to be read straight into flags for the
   * stamping stage, which is still where it goes for an EPUB or a PDF — but the
   * COMPILE route puts the title and the author into the package as it writes it
   * (`argsFor`), because a book file has no PDF behind it to take a title from,
   * and a plain-text export has no stamping stage at all and therefore had no way
   * to carry a corrected title before this. One read of the ledger, two consumers,
   * and neither of them re-derives the other's answer.
   */
  const merged = rendering !== null
    ? await recordFor(next.outputPath, rendering, next.parentStep ?? null, homeOf(request))
    : {};
  const record = rendering !== null && rendering !== 'txt'
    ? {
      // The command follows the PRODUCT and not the position: a facsimile export
      // takes the Info dictionary's four fields whatever kind of document the
      // project started from. Carried as the kind rather than read back off the
      // extension later, so the composition below names one fact once.
      kind: request.kind === 'pdf' ? 'pdf' as const : 'epub' as const,
      flags: metaFlagsFor(merged),
    }
    : null;
  /*
   * The file the engine writes when a record is going on afterwards — named for
   * the job under a `foundry` subdirectory of the OS temp directory, because a
   * temp folder is shared and files loose in it belong to nobody, and with the
   * product's own extension because both metadata commands read the format they
   * are given.
   */
  const unstamped = record === null || record.flags.length === 0
    ? null
    : path.join(os.tmpdir(), 'foundry', `${next.id}.unstamped${path.extname(next.outputPath)}`);
  if (unstamped !== null) {
    try {
      await fsp.mkdir(path.dirname(unstamped), { recursive: true });
    } catch (err) {
      next.state = 'failed';
      next.error = `The temporary folder for this job could not be made: ${(err as Error).message}`;
      next.finishedAt = Date.now();
      changed();
      settle();
      return null;
    }
  }

  /*
   * ── THE PREVIOUS OUTPUT MOVES ASIDE **NOW**, and not a moment earlier ──────
   *
   * `generated/` is never overwritten: a second rendering of a book moves the
   * first into `generated/archived-<stamp>/` rather than replacing it. That
   * rotation used to happen when the job was PLANNED — before it was enqueued,
   * let alone run — and the new file was recorded only if the run succeeded. So
   * a rendering that failed, or was cancelled, or was removed from the queue
   * without ever starting, left the previous output in an archive folder with
   * the catalogue's chain pointing at it and nothing live at all. The row went
   * on listing and opening, and what it opened was silently the run before last,
   * forever.
   *
   * Here, the engine is the next thing that happens. The window between this
   * rename and the first byte written is one spawn — and that window is covered
   * by the `finally` this rotation sits inside, which puts the rotation back
   * unless a product was filed, so the invariant is flat: A RUN THAT PRODUCES
   * NOTHING LEAVES THE CATALOGUE EXACTLY AS IT WAS.
   *
   * IT IS ENFORCED BY STRUCTURE NOW, AND IT USED TO BE ENFORCED BY REMEMBERING.
   * The put-back was written by hand on two arms — the cancel and the engine's
   * non-zero exit — and every other way out of this function left the book in
   * `generated/archived-<stamp>/` with nothing live at all: the refusals that
   * settle and return, and above all a THROW, which `engineCommand()` raises by
   * design when the app folder has no engine bundle, one statement below this
   * one. That throw reaches `executeJob`'s boundary, which fails the row
   * correctly and cannot see these three locals at all. So the restore is one
   * `finally` at the bottom of this function rather than a call an arm can be
   * added without.
   *
   * NEITHER OF THE TWO JOBS THAT WRITE INTO `readings/` ROTATES, and that is now
   * one rule rather than a reading's exception. A reading fills its BANK and a
   * translation fills its RECORDS; both live beside each other in a directory this
   * block has no business in, both are named per step so nothing is ever
   * overwritten, and both have the engine's own replace-on-success rule underneath
   * them (docs/BANK-LIFECYCLE.md §2). Rotating on their basename would move a file
   * out of `readings/` on the strength of a name that means something else there.
   *
   * THE TRANSLATION USED TO ROTATE, and losing that is losing nothing: what it
   * rotated was the EPUB it was about to overwrite, and it does not write an EPUB
   * any more. The self-overwrite case went with it — a re-translation into the
   * language a document already was named one path twice, so the run read the copy
   * the rotation had moved aside — because a records file is never also the book
   * being read.
   *
   * A refusal here fails the job with its own sentence. Both plans ask the same
   * question while the dialog is still on screen, so this is reached only when a
   * tab was opened on the previous output in between — which is the case only the
   * second answer can authorize.
   *
   * AN EXPORT ROTATES ITS OWN FOLDER, and getting this wrong would be the worst
   * outcome in the file. `rotateGenerated` takes a BASENAME and looks for it in
   * `generated/` — and an export of the book is called `<stem>.epub`, which is
   * exactly the name the project's cast book already has one folder over. Handed
   * to the wrong rotation, asking for a copy of your book would file the book
   * itself into an archive folder and unpack nothing in its place. So the layer
   * decides the rotation, off the one flag that was resolved above, and `final/`
   * gets its own pair (`rotateFinal` / `restoreFinalRotation`) rather than a
   * parameter on this one — the two put back different things.
   */
  let rotation: Rotation | null = null;
  let filedRotation: FinalRotation | null = null;
  let rotatedIn: string | null = null;
  /**
   * DID THIS RUN PUT A PRODUCT WHERE THE ROTATION MADE ROOM — the one question
   * the restore below turns on, and the reason it is not simply unconditional.
   *
   * Said at the engine's zero exit, which is the moment the file exists at
   * `outputPath` and therefore the moment the rotation was FOR something. Every
   * landing arm is under it and none of them may put back: the old copy dragged
   * home over a new one is the destruction `restoreRotation` refuses to perform
   * (it checks the live slot itself), and asking it to is how a guard somebody
   * relaxes later becomes a lost book.
   *
   * IT IS NOT THE ROW'S STATE. A landing that throws afterwards — a catalogue
   * write that fails, a listener with a bug in it — ends `failed`, and its
   * product is on disk all the same; a run that produced something is not a run
   * that produced nothing, whatever the shelf ends up saying about it.
   */
  let landed = false;
  try {
    /*
     * A TRIAGE ROTATES NOTHING, and it is named here rather than left to the
     * basename's absence from `generated/`. Its verdicts live in `readings/` beside
     * the cleanup's records, on the reading's and the text passes' terms above, and
     * a rotation keyed on a basename would be `rotateGenerated` — or, for anything
     * that reached `exporting`, `rotateFinal` — asked to move a file that means
     * something else in a folder this run never writes.
     */
    if (request.kind !== 'read' && !isTextPassRequest(request) && request.kind !== 'clean-triage'
      && request.kind !== 'analysis-rank') {
      const projectDir = projectDirOf(request.outputPath);
      if (projectDir !== null) {
        rotatedIn = projectDir;
        try {
          if (exporting) {
            filedRotation = await rotateFinal(projectDir, path.basename(request.outputPath), next.id);
          } else {
            rotation = await rotateGenerated(projectDir, path.basename(request.outputPath), next.id);
          }
        } catch (err) {
          next.state = 'failed';
          next.error = err instanceof Error ? err.message : String(err);
          next.finishedAt = Date.now();
          changed();
          settle();
          return null;
        }
      }
    }

    /*
     * ── A BRANCH'S RECORDS START AS A COPY OF ITS PARENT'S ────────────────────
     *
     * Here, and not at plan time, because this is the first moment the job is a
     * commitment rather than a row somebody can still remove: a held translation
     * that is deleted from the shelf must leave `readings/` exactly as it found it,
     * and a file seeded at the plan would sit there named by no step, invisible to
     * the sweep, forever.
     *
     * WHY A BRANCH WANTS ITS PARENT'S ANSWERS AT ALL: translating from a save made
     * under a translation branches, and a branch owns its own file — but an EMPTY
     * one would make that first run a full re-translation of a book that is already
     * translated. The rows are keyed by the blocks' own text, so the parent's
     * answers are exactly as true in the branch as they were at home: the stricken
     * blocks are never looked up, and only text somebody edited since is re-asked.
     *
     * AN EXISTING FILE IS NEVER OVERWRITTEN. A retried job has its own answers in
     * there by now and they are newer than the seed; a replace of a row that already
     * has records carries no seed at all.
     *
     * IT COVERS EVERY TRANSLATION, WHICH IS THE FIX. This copy used to sit inside
     * the stage loop of a two-stage Generate, so it ran for a branch ordered by
     * standing on a save and pressing Generate and NEVER for one ordered from the
     * Translate dialog — which set no seed in the first place. A dialog-ordered
     * branch therefore started empty and paid full model price for a book whose
     * translation was one row up. One rule, one spawn, both doors.
     */
    if (isTextPassRequest(request)
      && request.seedRecords !== undefined
      && !existsSync(request.recordsPath)
      && existsSync(request.seedRecords)) {
      try {
        await fsp.mkdir(path.dirname(request.recordsPath), { recursive: true });
        copyFileSync(request.seedRecords, request.recordsPath);
      } catch (err) {
        console.error(`[job] could not seed ${request.recordsPath} from ${request.seedRecords}:`, err);
      }
    }

    /*
     * ── THE ANALYSIS CHECKLIST, WRITTEN AT THE SPAWN ──────────────────────────
     *
     * `--categories` takes a PATH to a JSON list, so the checklist cannot ride the
     * command line as a value; it has to be a file, and this is the moment to make
     * one. The seed copy above is here for the same reason and it is the same rule:
     * a plan is not a commitment, and a held job somebody removes must leave the
     * project exactly as it found it. A checklist written at plan time would sit in
     * the analysis folder named by no step, invisible to every sweep, forever.
     *
     * BESIDE THE REPORT AND NAMED FROM IT (`categoriesFileFor`), so a person
     * looking at a run in a terminal can see what it was asked for — and so the
     * settle can remove it without composing a second opinion about where it went.
     *
     * THE WHOLE SET IS WRITTEN, unticked entries and all, which is the spelling
     * `buildPlan` documents itself as accepting from this app: a list composed by
     * DROPPING names is indistinguishable from a list of the only categories this
     * build has heard of, and the day the engine grows an eleventh the two readings
     * diverge in silence.
     *
     * A FAILURE HERE IS NOT SWALLOWED AND IS NOT A THROW. Without the file the
     * engine refuses the run by name, which is the honest outcome and lands in the
     * row's error where somebody will read it; a console line says which write
     * failed so the cause is not a mystery.
     *
     * THE ENTRY IS REBUILT FIELD BY FIELD rather than spread, and that is the one
     * detail this write cannot get wrong. `parseCategoriesJson` (src/analyze/plan.ts)
     * REFUSES an entry carrying a field it does not read — deliberately, because a
     * typo accepted in silence is a hand-written line that never reached the
     * model and an hour spent looking fine — so anything this app grows on its own
     * request shape would end the run the day it was added. Three fields are
     * spelled here because three are the ones over there: `name`, `enabled`, and
     * `description` where the category has one (a user's own; a built-in never
     * does, and an empty one is omitted rather than written as "").
     */
    if ((request.kind === 'analysis' || request.kind === 'analysis-rank') && request.categories.length > 0) {
      const where = categoriesFileFor(request);
      const asked = request.categories.map((one) => {
        const description = (one.description ?? '').trim();
        const label = (one.label ?? '').trim();
        return {
          name: one.name,
          enabled: one.enabled,
          ...(description.length > 0 ? { description } : {}),
          // The words the person reads for this category, carried so the report's
          // `names` header shows every device the label the desktop shows —
          // including a custom category exactly as its author typed it.
          ...(label.length > 0 ? { label } : {}),
        };
      });
      try {
        await fsp.mkdir(path.dirname(where), { recursive: true });
        await fsp.writeFile(where, `${JSON.stringify(asked, null, 2)}\n`, 'utf8');
      } catch (err) {
        console.error(`[job] the analysis checklist could not be written to ${where}:`, err);
      }
    }

    /*
     * ── THE ONE RUN THIS JOB IS ───────────────────────────────────────────────
     *
     * It was one for everything this app queued except a Generate standing under a
     * translation, which was two: `vlm-convert` into a temp EPUB, then `translate`
     * out of it. A translated book is cast by the first of those alone now, so the
     * stage list, the loop that walked it and the `handle` reassigned between its
     * spawns are gone with it.
     *
     * AIMED AT THE INTERMEDIATE WHEN A RECORD IS GOING ON AFTER IT. `unstamped` is
     * non-null only for an export whose ancestry recorded metadata (see it, above,
     * for the whole argument), and both metadata commands refuse to write over their
     * own input. Everything else about this spawn is the request as it was stored —
     * the stored one is what the row, the rotation and the landing are about, and
     * only the child process sees this substitution.
     *
     * The `read` and `translate` arms are unreachable — neither is ever an export
     * and neither has a record to carry — and they are written out because the
     * alternative is a cast asserting that to the compiler, which is a promise
     * rather than a fact.
     */
    const spawned: EngineRequest = unstamped === null
      || request.kind === 'read'
      || isTextPassRequest(request)
      ? request
      : { ...request, outputPath: unstamped };

    /*
     * ── THE LAST RUN: THE RECORD THE PERSON TYPED, PUT ON WHAT WAS MADE ───────
     *
     * `foundry epub-meta` or `foundry pdf-meta` over the finished product, into the
     * file the row is about. It is the same command the metadata dialog writes
     * with — the same refusals, in the same words, about the same fields — applied
     * to a book that has just been assembled out of a bank that never knew the
     * title had been corrected.
     *
     * SPELLED HERE RATHER THAN MADE A REQUEST SHAPE: the three shapes are what this
     * app QUEUES, each with a row, a landing and a settle, and this is a step inside
     * one job rather than a job. A fourth would have to be threaded through the
     * plans, the shelf and every settle path to be used in one place. The flags are
     * `metaFlagsFor`'s, which is one line and refuses to put an empty value on a
     * command line.
     *
     * NULL FOR EVERY JOB THAT IS NOT AN EXPORT WITH SOMETHING TO SAY, which is
     * nearly all of them.
     */
    const stamping: string[] | null = unstamped === null || record === null
      ? null
      : record.kind === 'pdf'
        ? ['pdf-meta', '--pdf', unstamped, '--out', next.outputPath, ...record.flags]
        : ['epub-meta', '--epub', unstamped, '--out', next.outputPath, ...record.flags];

    const watch = (line: string): void => {
      next.message = line;
      /*
       * WHAT THE RUN SPENT, off the same stderr the counts come off.
       *
       * The engine prints one usage line at the very end of a text act
       * (`usageLine`, src/translate/transport.ts) and only when the server it
       * talked to counted — so this fires once per run at most, and never on a
       * local Ollama, which reports nothing. Read BEFORE the progress parse and
       * kept out of it, because it is not progress: see `parseUsageLine`.
       *
       * IT DOES NOT CLEAR THE NOTE AND IS NOT SWALLOWED. The line stays the
       * message and becomes the note like any other non-count line, because it is
       * a real thing the engine said and a person reading the row's last line
       * should see it. What this adds is the STRUCTURED copy, which is what the
       * finished row and the bench card draw from.
       */
      const spent = parseUsageLine(line);
      if (spent !== null) next.usage = spent;
      const progress = parseProgressLine(line);
      /*
       * A count clears the note; anything else becomes it. So `note` reads as
       * "what the engine has said SINCE the last count", which is empty on a run
       * that is simply progressing and full of exactly the right sentence on one
       * that is retrying, falling back, or naming a block it could not do.
       */
      next.note = progress ? null : line;
      if (progress) {
        // The rasterising pass finishes the instant reading starts: foundry draws
        // the whole book before it posts the first page, but a book with pages
        // skipped never reaches its own page count, so the render bar would stop
        // short of work it had actually finished.
        if (progress.phase === 'read' && next.progress?.phase === 'render') {
          next.progress = { ...next.progress, page: next.progress.total };
        }
        next.progress = progress;
      }
      changed();
      /*
       * AND OUT TO WHOEVER ASKED TO HEAR IT, after the row has been updated and
       * published. A caller watching from outside (`runJob`'s `onProgress`) is
       * reading the same lines the shelf is drawing, so it must not see one the
       * mirror has not been told about — and its throw is not this run's problem,
       * on `settled`'s rule: one listener's bug is not another's engine.
       */
      sayOutward(line, next.outputPath, wires);
    };

    /*
     * The command, once, before it runs.
     *
     * A failure that names a flag is only useful beside the flags it was given —
     * "--out and --format contradict each other" means nothing without the pair,
     * and the paths this app composes are exactly the ones nobody typed and
     * therefore nobody can check. One line, at the start, in the terminal that is
     * already open — and one PER RUN, because a job that is a spawn followed by a
     * metadata stamp is exactly the case where a single line would leave somebody
     * reading the wrong command.
     */
    /*
     * A COMMAND THAT CANNOT BE SPELLED IS A FAILED ROW WITH THE REASON ON IT, and
     * not a rejected promise nobody catches. `argsFor` refuses exactly one thing —
     * a text pass whose book was never materialised, which is a promise that reached
     * the spawn without its parent (`bookOf`) — and this is the arm that turns that
     * into the ending every other unmakeable job in this file gets: the row settles,
     * the shelf shows main's sentence, and anybody awaiting it hears.
     */
    let args: string[];
    try {
      args = argsFor(spawned, merged, placement);
    } catch (err) {
      next.state = 'failed';
      next.error = err instanceof Error ? err.message : String(err);
      next.finishedAt = Date.now();
      changed();
      settle();
      return null;
    }
    /*
     * THE LINE IS SAFE TO PRINT AND THAT IS A PROPERTY OF THE DESIGN, not luck. A
     * Crucible's token is in `placement.env` and never in argv, so the command
     * this prints is the whole command and carries no credential — which is what
     * makes it something a person can paste into a terminal and into a bug report.
     * Anything that ever puts a secret on this line has broken the contract
     * `Placement.env` states.
     *
     * ── THE TWO FLAGS THE LOCAL PAGE READER ADDS, AND WHY NOT IN `argsFor` ─────
     *
     * `argsFor` is a pure function of the REQUEST: the same request spells the
     * same command line whenever it is asked, which is what lets the shelf, the
     * log line and a re-run all agree. Neither of these is a property of the
     * request. Both are properties of the server that answered a moment ago —
     * which model it says it holds, and whether it is one this app started — and
     * a pure function cannot know either without probing a socket.
     *
     * A zero concurrency means "say nothing", which is how an ADOPTED server keeps
     * the engine's own measured default of twelve.
     */
    // File preparation above also awaits. Cancelling before the child exists
    // must never turn into a late spawn after the cancellation was acknowledged.
    if (jobs.find((job) => job.id === next.id)?.state === 'cancelled') return null;
    console.log(`[job] ${next.kind} ${args.join(' ')}`);
    let handle = runEngine(args, watch, placement.env);
    /*
     * THE CANCEL FOLLOWS THE LIVE CHILD. `handle` is reassigned before the metadata
     * stamp and the closure reads it, so the ✕ kills whichever engine is actually
     * running rather than a child that has already exited — and whoever is holding
     * this run holds it across the gap between them, so no second `pump()` can slip
     * a job in beside this one and put two engines on one GPU.
     *
     * HANDED OUT RATHER THAN STORED, because the two schedulers hold it in two
     * places: the pump's serial slot, or `detachedRuns` for a run the host's queue
     * chose. See `RunWires`.
     */
    wires.claim(() => handle.cancel());

    let result = await handle.done;
    /*
     * ── AND THE RECORD, WHICH IS NOW THE LAST THING THAT HAPPENS ──────────────
     *
     * Only for an export whose ancestry recorded metadata, only when the run before
     * it succeeded, and it is what actually writes the file the row is about — the
     * engine wrote into the temp directory. `handle` is reassigned, so the ✕ still
     * kills the child that is running.
     *
     * A FAILURE HERE FAILS THE JOB, in the engine's own words, and that is the
     * conservative answer rather than the harsh one. The alternative is filing a
     * book in the tray and reporting success while the corrections the person made
     * are missing from it — which is the exact silence this whole unit exists to
     * end, reintroduced one stage later.
     */
    if (stamping !== null && result.code === 0) {
      next.message = 'Writing the record onto it…';
      next.note = null;
      changed();
      console.log(`[job] ${next.kind} ${stamping.join(' ')}`);
      handle = runEngine(stamping, watch);
      result = await handle.done;
    }
    // No child of this job's is alive from here on: the slot, or the detached
    // registry, gives it up. See `RunWires`.
    wires.release();
    /*
     * AND THE ENDING BECOMES THIS RUN'S, in the same breath and for the same
     * fact: the child is gone. The two lines are together because the gap
     * between them is the defect — a ✕ arriving in it finds a `running` row with
     * nothing to kill and settles it itself, while the landing below goes on to
     * settle it again. `landings` holds the argument in full.
     */
    landings.add(next.id);
    next.finishedAt = Date.now();

    /*
     * THE INTERMEDIATE GOES NOW, whichever way this ended. A run that failed while
     * writing leaves a whole book in the temp directory, and the next one writes a
     * fresh one under its own job id — so keeping it would be hoarding half-books
     * nobody can name against a directory this app does not own.
     *
     * THERE USED TO BE THREE OF THEM: the untranslated cast a two-stage Generate
     * made for its translator, the untidied translation an export made for its
     * edition, and this one. Both of the others were the cost of a translation being
     * a FILE; a translated book is cast by the run that assembles it now, so the
     * only scratch file left is the one the metadata stamp reads, and it exists
     * because both metadata commands refuse to write over their own input.
     *
     * BEST EFFORT, AND NEVER A THROW. A leftover temp file is a console line; the
     * job it belonged to succeeded or failed on its own merits, and reporting three
     * hours of GPU as a failure because a scratch file would not unlink would be
     * the bookkeeping deciding what happened to the book. `force` so an
     * already-absent file — the ordinary case when the run never got that far — is
     * silence rather than an error.
     */
    if (unstamped !== null) {
      try {
        await fsp.rm(unstamped, { force: true });
      } catch (err) {
        console.error(`[job] the intermediate ${unstamped} could not be removed: ${(err as Error).message}`);
      }
    }

    // And the book main materialised for this export or this translation,
    // whichever way it ended — `sweepDerivedBook` carries the whole argument. It
    // is swept BEFORE the landings below and that is safe by construction: what
    // the run read is not what the landing writes, and the translation's own
    // derived book is built from the ledger and the records rather than from this
    // scratch copy of them.
    await sweepDerivedBook(request);

    if (result.code === 0) {
      next.state = 'done';
      // THE PRODUCT IS AT `outputPath` FROM HERE ON, so the rotation this run
      // made was made for something and the restore below must not undo it.
      // See `landed`, which every arm under this line depends on and none of
      // them has to remember.
      landed = true;
      /*
       * A READING LANDED, which is the moment the whole front door turns on.
       *
       * `recordReading` stamps the catalogue: when it finished, how many pages the
       * bank holds, and — through `generationForLanding`, the landing half of the
       * rule in shared/ledger.ts — the reading GENERATION every overlay and its
       * undo ledger are bound to.
       * That is why the mint belongs here rather than at the first correction: this
       * is the only moment anything in this app can honestly say a bank is a
       * different bank from the one that was there before.
       *
       * It also puts the light out on Home. A project with a scan and no reading
       * shows OCR as its waiting next step; from this line on, that project has
       * been read.
       */
      if (request.kind === 'read') {
        /*
         * NO CAPTURED PARENT GOES WITH IT, AND THAT IS NOT AN OVERSIGHT.
         *
         * `next.parentStep` is where the user was standing when they pressed Add,
         * and it is what a translation is filed against. A READING IS THE ONE
         * ACTION THAT IS NOT MADE FROM A STEP: it reads the pixels in `archive/`,
         * which `planReading` resolves for itself precisely because the document
         * the person was looking at may be a real-text reprint with none of the ink
         * in it. So its parent is the project's import, settled by what it read
         * rather than by where anybody was standing — see `originOf` in
         * shared/ledger.ts for what parenting it at the position would cost.
         */
        /*
         * WHAT IT ASKED FOR GOES WITH IT, THOUGH — which is the other half of the
         * same rule and the opposite conclusion.
         *
         * The parent is settled by what a reading READS; the identity is settled by
         * what it was ASKED. `--skip-pages` and `--language` are the whole of what
         * the OCR dialog lets somebody choose (`ReadRequest`), and they decide
         * whether the next reading of this book replaces this step or branches
         * beside it. Nothing on disk can answer that afterwards: a bank does not
         * record which pages it was told to leave out. So the job hands them over,
         * exactly as a translation hands over its `--to` rather than leaving the
         * language legible only in a filename.
         */
        /*
         * AND THE STEP THE BANK IS NAMED AFTER, which is the third thing that has
         * to survive the wait.
         *
         * A branching re-read writes `readings/<key>.<id8>.jsonl`, and that `id8` is
         * the front of the step's uuid — minted at the plan, before the row even
         * appeared in the shelf, because the engine is handed one path and fills it
         * for three hours. Minting a fresh id here would leave the bank named after a
         * step nobody created. It is spent only if this lands as an append; a replace
         * swaps into the step that is already there and throws it away.
         */
        await recordReading(
          next.outputPath,
          {
            ...(request.skipPages !== undefined ? { skipPages: request.skipPages } : {}),
            ...(request.language !== undefined ? { language: request.language } : {}),
          },
          request.stepId,
        );
        next.message = `Read ${path.basename(next.inputPath)} — the answers are banked.`;
        changed();
        /*
         * ── AND THE ONE DOCUMENT THE BANK IS FOR, WHICH IS NOT A STEP ────────────
         *
         * The book file, recorded as this reading's product (docs/RENDERER.md §6).
         *
         * IT IS AWAITED AND IT CANNOT FAIL THE READING. Every way it can go wrong
         * is a console line inside it: the bank is on disk, it is complete, and the
         * reflow is made from it for nothing whenever it is asked for.
         *
         * TWO OTHER LINES USED TO BE HERE AND BOTH ARE GONE. `ensureCast` cast the
         * project's flowing book — an EPUB in `generated/` that the app unpacked so
         * a pane had files to show — and the pane reads the book file directly now
         * (docs/RENDERER.md §7). The facsimile was the other, and it left for a
         * different reason: it was protecting a reading against a re-read that could
         * take its answers away, and banks are kept now, so the protection is the
         * bank and the reprint is something a person asks for.
         */
        await landReadProducts(next.outputPath, next.inputPath);
        /*
         * ── AND THE READING IS OVER, WHICH THIS BRANCH NEVER SAID ───────────────
         *
         * Every other landing in this function ends on the settle and this one
         * ended on `return`. It was not noticed for as long as a reading's ending
         * cost nothing: the branch used to call `void pump()` itself, which kept the
         * queue moving, and when `runInSlot`'s `finally` took the pump over that line
         * was removed with nothing put in its place (338027b → d1dd5b6). A reading
         * finished, the row went `done`, and the one function that says a job is
         * over was never called for it.
         *
         * WHAT THAT COST, measured 2026-09-18: a reading of a book ended at 02:22:10
         * and `dots-ocr` — twelve gigabytes — was still on the card at 02:29, because
         * `settled` is the ONE place a Crucible lease is given back. The lease is not
         * best-effort tidying; while it is open the server refuses to clear the card
         * (crucible/settle.py, fact 2 of four), so a lease nothing releases is a
         * resident model nothing can unload. Worse than a leak: the heartbeat timer
         * lives in the same object, so it beat every forty seconds for the life of
         * this process and, answered `unknown_lease`, went on trying to TAKE THE
         * CARD BACK on behalf of a run that ended minutes ago (`takeLease`,
         * electron/crucible-dispatch.ts).
         *
         * The lease is only the loudest of the three. `forgetPark` never ran for a
         * reading either, and nothing waiting on `onJobSettled` ever heard a
         * successful one end — the promise that function's own docstring makes.
         *
         * LAST, AFTER THE PRODUCTS, which is that promise and not an accident of
         * where the line sits: a waiter has to see the bank and the book file before
         * it hears the job is over, or it reads a reading that worked as an ending
         * with nothing in it.
         */
        settle();
        return null;
      }
      /*
       * ── A TRANSLATION LANDED, AND WHAT IT LEFT IS ANSWERS ────────────────────
       *
       * The same shape as the reading above it, which is the shape it should always
       * have had: this run produced no document at all. It wrote
       * `readings/<key>.<tag>[.<id8>].records.jsonl` — one row per flowing block —
       * and the step that keeps what those hours cost names THAT file as its payload
       * (`recordTextPass`, electron/projects.ts), exactly as a read step names its
       * bank.
       *
       * IT USED TO GO THROUGH `recordGenerated`, because the product was an EPUB in
       * `generated/` and that function is where a finished document is catalogued.
       * Nothing about a records translation fits there: there is no document to put
       * on a type's chain, nothing to promote to the project's live PDF, and the file
       * is not in `generated/` at all — the landing would have refused it by name.
       *
       * THE ONE FACT THE JOB HANDS OVER is the one nothing on disk can answer
       * afterwards: which language was asked for. Reading it back out of a filename
       * is what this codebase's oldest house rule forbids, so the job that asked says
       * which. WHETHER THIS WAS A CHAIN IS NOT HANDED OVER, deliberately: it is a
       * fact about the row this step hangs from, the landing is holding the ledger,
       * and this request's `--from` is also where a person's typed guess about an
       * untranslated book's language goes (`recordTextPass` argues it in full).
       *
       * AND THEN THE BOOK, WITHOUT BEING ASKED. A records file is not a thing a
       * person reads, so the row would have nothing to show until somebody ordered a
       * rendering by file format — which is the exact gap the automatic cast after a
       * reading was built to close, one action later. It is the same cast: free,
       * offline, seconds, and fired and forgotten so that a translation that landed
       * is never reported as a failure because the book after it could not be planned.
       */
      /*
       * ── AN ANALYSIS LANDED, AND WHAT IT LEFT IS A REPORT ─────────────────────
       *
       * The same shape as the two above it and the shortest of the three, because
       * an analysis owes the book nothing. There is no document to catalogue, no
       * bank to displace, no derived book to materialise afterwards and no chain to
       * resolve: the run measured a book and wrote down what it found, and the step
       * that keeps the report names that file as its payload (`recordAnalysis`,
       * electron/projects.ts).
       *
       * THE ONE FACT THE JOB HANDS OVER is the one nothing on disk can answer
       * afterwards: which categories were actually asked for. The report's header
       * lists them, and reading a step's params back out of its payload is what this
       * codebase's oldest house rule forbids — so the run that asked says what it
       * asked for, exactly as a translation says which language. The model rides
       * with it, in the answer pile (`MINTED_BY_THE_RUN`).
       *
       * AND NOTHING FOLLOWS IT. A translation lands and materialises a book,
       * because a records file is not a thing a person reads; a report is drawn by
       * a panel straight out of the file, so there is nothing to make and nothing
       * to open. The pointer stays where it was (`RETAINED_BESIDE_YOU`), which is
       * the whole of what an analysis does to a project's position.
       */
      /*
       * ── A TRIAGE LANDED, AND WHAT IT LEFT IS A LIST ─────────────────────────
       *
       * The shortest landing in the file, because a triage owes the project
       * nothing: no step, no document, no book to make afterwards. The verdicts are
       * on disk where the press named them, and the cleanup chained behind this row
       * reads them when the pump lets it start — which is this settle, since
       * `chainVerdict` answers `go` for a parent that is `done`.
       *
       * NO LEDGER WRITE, and that is the difference from the analysis below: a
       * report is something a person opens, so it is a step; a verdicts file is
       * something the next run reads, so it is not.
       */
      if (request.kind === 'clean-triage') {
        next.message = `Checked which blocks of ${path.basename(next.inputPath)} need cleaning.`;
        changed();
        settle();
        return null;
      }
      /*
       * A RANKING LANDS NOTHING, on the triage's clause above: its rank file is
       * on disk where the press named it, and the analysis behind it reads it when
       * the pump lets it start.
       */
      if (request.kind === 'analysis-rank') {
        next.message = `Ranked ${path.basename(next.inputPath)} for analysis — the check follows.`;
        changed();
        settle();
        return null;
      }
      if (request.kind === 'analysis') {
        // The rank file was the pair's scratch; the report is the payload
        // (`analysisRankFileFor`). Kept on every other ending, so a Retry of this
        // row does not pay the card for the ranking again.
        if (request.ranksPath !== undefined) {
          await fsp.rm(request.ranksPath, { force: true }).catch((err: unknown) => {
            console.error(`[job] the analysis ranking could not be removed: ${String(err)}`);
          });
        }
        await recordAnalysis(next.outputPath, {
          parentStep: next.parentStep ?? null,
          categories: request.categories.filter((one) => one.enabled).map((one) => one.name),
          model: request.model,
          ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
        });
        next.message = `Analysed ${path.basename(next.inputPath)} — the report is on its step.`;
        changed();
        settle();
        return null;
      }
      if (isTextPassRequest(request)) {
        /*
         * ── ONE LANDING FOR THREE PASSES, AND THE ACTION IS THE THING IT CARRIES ──
         *
         * `recordTextPass` appends a step whose action is this job's kind, which is
         * the whole of what the split changed here: a rewrite used to land as
         * `translate` wearing `params.rewrite`, and a cleanup would have had to do
         * the same. Owen ended it — *"it isnt a translate job"* — so the row says
         * what the button said.
         *
         * WHAT THE JOB HANDS OVER IS WHAT NOTHING ON DISK CAN ANSWER AFTERWARDS: the
         * language a translation went into and the mode a rewrite was asked in. Both
         * are legible only in the records file's NAME, and reading a fact back out of
         * a filename is what this codebase's oldest house rule forbids. A CLEANUP
         * HANDS OVER NEITHER, because it has neither — `PARAMS_OF.clean` is empty,
         * and the run's own facts are on the stamp beside its answers.
         */
        await recordTextPass(next.outputPath, {
          action: request.kind,
          parentStep: next.parentStep ?? null,
          /*
           * A CLEANUP GOES INTO NO LANGUAGE, and a rewrite's is resolved at spawn
           * (`SimplifyRequest.to`) — so this asks whether there is one rather than
           * asserting there is. An absent one here is unreachable and not guarded
           * against: `languageOf` refuses the command line without it, so a run that
           * reached this landing was spawned with a language and carries it still.
           */
          ...(request.kind === 'clean' || request.to === undefined ? {} : { language: request.to }),
          ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
          ...(request.kind === 'simplify' ? { rewrite: request.rewrite } : {}),
          ...(request.kind === 'clean' && request.readingsOnly !== undefined ? { readings: request.readingsOnly.label } : {}),
        });
        /*
         * "the book follows" IS TRUE OF ALL THREE and is the sentence the shelf has
         * always ended a text pass with: the records are on disk and the book is
         * materialised from them in the next few lines, for nothing.
         */
        const said = request.kind === 'translate'
          ? 'Translated'
          : request.kind === 'simplify' ? 'Simplified' : 'Cleaned';
        next.message = `${said} ${path.basename(next.inputPath)} — the book follows.`;
        changed();
        /*
         * AND THE BOOK OF IT, WHICH IS THE PART THAT IS NOT A RENDERING. *"When a
         * translate lands, main materializes parent book file + chain ops + records
         * → readings/<key>.<lang>.book.jsonl."* (docs/RENDERER.md §4.) It is made
         * HERE, at the landing, rather than at the first open, for the reason every
         * derived file in this app is made where its inputs are known to be
         * settled: the records have just been written, the step naming them exists,
         * and the row the translation was made FROM is what the book is materialised
         * over — a fact about the ledger that is answered once, now, rather than
         * re-derived by every pane that ever draws this step.
         *
         * AND IT IS THE ONLY ONE NOW. There was a cast after this — an EPUB made
         * from the records so the old viewer had a file to open — and standing on a
         * translate row shows the derived book on the proof sheet instead, which is
         * the document this line writes. It is not fatal to a landing that has
         * already put hours of GPU safely on disk, and it says so in the terminal
         * in its own words.
         */
        await materializeTextPass(next.outputPath);
        settle();
        return null;
      }
      /*
       * ── AN EXPORT IS FILED AND NOTHING ELSE HAPPENS TO IT ─────────────────────
       *
       * `recordGenerated` below does three things to a finished rendering: it puts a
       * step on that type's chain, it can promote the result to the project's live
       * PDF, and it announces the library. Every one of those is about a document
       * OTHER WORK WILL BE MADE FROM, and an export is the one rendering in this app
       * that nothing is ever made from — the user's ruling, verbatim: "it wont go
       * into the working files as a step because it isnt the base for new steps. its
       * a terminal step. so its an export."
       *
       * So the landing is one row in the tray. `recordFinal` never throws and
       * announces the library itself, which is what puts the export under its project
       * in the left nav; the tab opens itself from the shelf exactly as a Generate's
       * does (`OPENS_ITSELF`), because somebody who asked for a book wants to look at
       * it. No documents row, no ledger step, no live-PDF refresh, and no rotation to
       * undo beyond the one `rotateFinal` already made.
       */
      if (exporting) {
        /*
         * THE STEP THE JOB CAPTURED GOES INTO THE TRAY ROW, so that a host reading
         * `project.json` afterwards learns what a host listening at this instant
         * learns from the announcement below. `next.parentStep` is where the person
         * was standing when they pressed Export — held all along so a pointer move
         * during the wait cannot change which corrections the book carries — and it
         * is the same value both halves record, out of one variable, because two
         * derivations of one provenance is how the event and the catalogue come to
         * disagree.
         */
        const madeFrom = next.parentStep ?? null;
        await recordFinal(next.outputPath, madeFrom);
        const filed = path.basename(next.outputPath);
        /*
         * ── THE MINT'S DECLARATION, STAMPED AND THEN ANNOUNCED ──────────────────
         *
         * `request.mintMeta` is what the modal confirmed at the press
         * (JobRequest.mintMeta carries the why). The LANGUAGE follows the step's
         * own chain over the form: the request's language where the plan set one
         * (a translated position), the reading's language otherwise, and only
         * where the chain is silent does the form's answer stand — an
         * auto-export of a German step must say de whatever the person last
         * typed. Stamped into the file first, announced second, both out of ONE
         * composed block, which is `madeFrom`'s own one-variable rule two
         * comments up. A stamp that fails is a console line and never a failed
         * job: the book is made and filed, and a metadata splice can be pressed
         * again from the tile in seconds.
         *
         * ── AND A MINT NOBODY CONFIRMED INHERITS, the way the modal would have ──
         *
         * A host-ordered export (`exportEpubFromStep`, electron/mount.ts) has no
         * modal in front of it, and used to carry the project's stored block or
         * nothing. A hosted project minted from a bare document has no stored
         * block until somebody confirms a mint, so BookForge's narrate-on-a-step
         * produced an EPUB whose `dc:title` was the tray file's stem and whose
         * `dc:creator` was absent — while BookForge's own shelf knew the author
         * (bookforge-pc-1, 2026-09-07). The modal asked the host for exactly that
         * record (`mintMetaFor`) and merged it under the stored block; the
         * unattended route never did. Now it asks the same question through the
         * same function (`mintSeedFor`, doors-meta.ts): the request's confirmed
         * block first, then the card's whole stack — the stored block, the
         * host's record, the scan's Info, the project's name (Owen, 2026-11-06:
         * *"yes, they should fill metadata from the pdf if its available"*) —
         * and nothing at all only when no source has a record.
         *
         * A BLOCK WITH NO TITLE IS NOT STAMPED. The splice writes `Untitled` for
         * an empty one, and a title the compile already took from the scan is
         * strictly better than that word over it.
         */
        /*
         * WHERE IT LANDED, AND WHOSE IT IS — two questions since a host may ask
         * for the file OUTSIDE every project (`ConversionRequest.home`). The
         * project answers for the mint block and the announcement; the path
         * answers for whether anything of this app's filed it, and a file filed
         * nowhere is announced as `unfiled` so the mount answers its awaiting
         * caller without telling the host's shelf about a version that is not one.
         */
        const filedIn = projectDirOf(next.outputPath);
        const projectDir = homeOf(request) ?? filedIn;
        let minted: ExportMintMetadata | undefined;
        const inherited = request.kind === 'epub' && request.mintMeta === undefined && projectDir !== null
          ? await inheritedMintMetaFor(projectDir)
          : null;
        const confirmed = request.kind === 'epub'
          ? request.mintMeta ?? (inherited !== null && inherited.title.trim().length > 0 ? inherited : undefined)
          : undefined;
        if (request.kind === 'epub' && confirmed !== undefined) {
          const meta = confirmed;
          const declared = request.language
            ?? await chainLanguageOf(next.outputPath, madeFrom, homeOf(request))
            ?? meta.language;
          minted = {
            title: meta.title,
            contributors: meta.contributors,
            filename: filed,
            ...(meta.subtitle !== undefined ? { subtitle: meta.subtitle } : {}),
            ...(meta.year !== undefined ? { year: meta.year } : {}),
            ...(declared !== undefined ? { language: declared } : {}),
          };
          const stamped = await stampMintMetadata(next.outputPath, meta, declared);
          if (!stamped.ok) {
            console.error(
              `[queue] the mint metadata could not be stamped onto ${next.outputPath}: ${stamped.reason}`,
            );
          }
        }
        next.message = `Wrote ${filed}`;
        changed();
        /*
         * ── AND WHOEVER IS HOSTING US IS TOLD, LAST ───────────────────────────
         *
         * After the file is in `final/` and after the tray has recorded it, so a
         * host that files this into a versions list is describing something that
         * exists on disk and is already in the catalogue this app would answer
         * with. Announcing it any earlier would be inviting the host to race the
         * manifest.
         *
         * THE NAME IS THE ONE THE SHELF JUST SAID. A version row and a job row are
         * two views of one landing, and a second derivation of "what to call it"
         * is how the two come to disagree about what was made.
         *
         * A THROW HERE MUST NOT REACH THE SETTLE. The work is done — hours of it,
         * sometimes — and a host whose handler has a bug in it does not get to
         * turn a landed export into a failed job. `mountFoundry` catches it too,
         * and this is the second catch rather than the same one written twice: a
         * listener registered by anything else — a test, a future caller — reaches
         * this line and not that one.
         */
        if (projectDir !== null) {
          try {
            exportLanded({
              projectDir,
              path: next.outputPath,
              kind: request.kind,
              title: filed,
              // See `ExportLanding.stepId`: absent for a job with no position
              // behind it, which a host must read as "unknown" and not as "none".
              ...(madeFrom !== null ? { stepId: madeFrom } : {}),
              // And the mint's declaration, the same block the stamp just wrote —
              // absent means "minted before the modal existed", never "no
              // metadata" (`ExportLanding.metadata`).
              ...(minted !== undefined ? { metadata: minted } : {}),
              ...(filedIn === null ? { unfiled: true as const } : {}),
            });
          } catch (err) {
            console.error(
              `[queue] the export-landed listener threw for ${next.outputPath}: `
              + `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        /*
         * AND ANYBODY WAITING ON THIS JOB IS TOLD AFTER THE HOST IS, which is the
         * ordering `onJobSettled` promises rather than an accident of where the
         * line sits. A waiter watching for the landing of this file has to have
         * SEEN that landing before it hears the job is over, or it would read a
         * successful export as an ending with nothing in it.
         */
        settle();
        return null;
      }
      /*
       * ── A STEP'S OWN DOCUMENT IS FILED NOWHERE, AND THAT IS THE POINT ────────
       *
       * It is a RENDERING of a payload that is already a step — the snapshot in
       * `curations/` for a save, the records in `readings/` for a translation, the
       * BANK for a reading's facsimile — so it is free to make again and there is
       * nothing here for a catalogue to own. Cataloguing it would do active harm
       * rather than merely being redundant: Home's document rows would grow one
       * entry per landing, and the
       * facsimile would land on the PDF's chain beside the scan and be offered as the
       * document this app edits.
       *
       * Which leaves the file's disposal, and it is not left to chance: the step
       * delete composes the same name and sweeps it, along with any working tree
       * unpacked from it (`planStepSweep`).
       *
       * NO LEDGER STEP EITHER, for the reason above it: the step this is the document
       * of already exists, and minting a second one for the rendering would put a
       * filename where an action belongs.
       *
       * THE SENTENCE FOLLOWS THE PRODUCT, because these two are not the same thing to
       * the person reading the shelf: one is the book at a row in the history, the
       * other is the pages of a reading reprinted. Decided off the format, which is
       * the whole of the difference — a per-step cast is an EPUB and a facsimile is
       * the only PDF this app ever makes with a step on it.
       */
      if (request.forStep !== undefined) {
        next.message = request.kind === 'pdf'
          ? 'The facsimile of those pages is ready.'
          : 'The book at that step is ready.';
        changed();
        settle();
        return null;
      }
      /*
       * The catalogue learns about the origin HERE, when it exists.
       *
       * Not at plan time, which is only an intention: a run that dies at page 200
       * would leave `project.json` listing a book Home would then offer and
       * nothing could open. `recordGenerated` never throws — a row it could not
       * write is a named console line, because losing a catalogue entry is not a
       * reason to report three hours of GPU as a failure.
       *
       * ONE ARGUMENT LIGHTER THAN IT WAS, and the whole of the difference is that a
       * translation does not come through here any more. This call used to carry the
       * language, the bank and the step id, because the run that produced a
       * translation ended in `generated/` and its landing was a ledger step; a
       * records translation lands where its answers land (`recordTextPass`), and
       * what reaches this function from a translated position is the BOOK cast from
       * those records — which carries `forStep` and returns above, uncatalogued.
       *
       * The REQUEST's kind, not the job row's: `JobKind` also admits `mint`,
       * which never reaches this branch but which the compiler cannot know that
       * about, and a cast here would be a promise made to the type system rather
       * than a fact. The request is the narrower shape — narrowed by the two arms
       * above, which return — and it is the same decision.
       *
       * ── A BOOK MADE OF A TRANSLATION'S WORDS IS FILED AS A TRANSLATION ────────
       *
       * `records` is the whole test, and it has to be here rather than implied. The
       * roles are not four names for one thing: a `cast` sitting directly in
       * `generated/` used to be THE PROJECT'S FLOWING BOOK, which every read row and
       * save row resolved to. So a
       * Hungarian book filed as a cast would quietly become what the German rows
       * show — the exact confusion the per-step cast was built to end, arrived at
       * from the other side.
       *
       * The old two-stage pipeline said this same sentence about its own second
       * stage (`piped !== null ? 'translation'`). There is no second stage now; what
       * makes a rendering a translation is that the words in its blocks came out of
       * a records file, and that is one field on the request.
       */
      const live = await recordGenerated(
        next.outputPath,
        request.records !== undefined ? 'translation' : generatedRoleFor(request.kind),
        // The row's id, which is what names the archive folder if this promotion
        // rotates a live PDF aside — the same id the rotation above used.
        next.id,
      );
      /*
       * WHERE THE FINISHED ROW POINTS, when the catalogue made a live copy of what
       * the engine wrote. Everything downstream reads `outputPath`: the tab that
       * opens itself when the run lands, and the shelf's Reveal — and both of them
       * want the file the user is meant to have, not the bookkeeping original.
       *
       * Nothing promotes a conversion to the live PDF today (`recordGenerated`),
       * so this is inert and kept rather than deleted: the branch costs a
       * comparison, and the alternative is a queue that silently points at the
       * wrong file the first time something is promoted again.
       */
      if (live !== null) next.outputPath = live;
      // Said after the row settles on its final path, so the line names the file
      // the Reveal button will actually show.
      next.message = `Wrote ${path.basename(next.outputPath)}`;
    } else if (result.code === -1) {
      next.state = 'cancelled';
      next.message = 'Cancelled.';
      /*
       * AND A CANCELLED READING KEEPS NOTHING — Owen's ruling, and the one ending
       * in this file that destroys. `discardCancelledReading` carries the whole
       * argument, including the two guards that keep a finished reading out of it.
       * Awaited so the row does not settle while its pages are still on disk: a
       * re-read enqueued the instant the ✕ lands must not find them.
       *
       * UNLESS THE HOST SAID THIS WAS A STOP. BookForge's "Stop this step" and its
       * "Cancel this book" arrive here as the same -1 (`engine.ts` resolves -1 for
       * any cancel), and the first of the two promises in its own tooltip to keep
       * what it has already read. Destroying the bank under that button would be a
       * lie the person only discovers by pressing Start and watching page one go
       * past. `RESUMABLE_STOP` (shared/types.ts) is how a host says which gesture
       * it was; absent means cancel, so nothing about the ✕ changes.
       */
      if (resumableStops.has(next.id)) {
        console.log(
          `[queue] the reading was STOPPED rather than cancelled, so its pages stay banked and `
          + 'Start resumes from where it left off.',
        );
      } else {
        await discardCancelledReading(request);
      }
      // Nothing was written, so nothing moved: `landed` is still false and the
      // `finally` below brings the previous output home and points the chain
      // back at it. See `restoreRotation` for what "nothing" has to include —
      // the file, the working tree, and both of their catalogue rows. The tray
      // obeys the same invariant through its own receipt: a cancelled export
      // leaves the document somebody filed earlier exactly where it was.
    } else if (result.code === ENGINE_PARKED_EXIT) {
      /*
       * THE ENGINE PARKED, AND A PARK IS NOT A FAILURE (2026-09-21).
       *
       * Exit 75 is the page reader saying the model server's weather -- a
       * 502 over a stale proxy socket, a busy card, a connect timeout --
       * outlasted its stated retry budget. Nothing is lost: every page that
       * landed is in the readings bank, and the same request run again
       * resumes from them. Filing this as `failed` is exactly what turned one
       * stale socket into a released lease, an unloaded engine and eleven
       * thrown-away pages (Bookforge-Mac-1's finding, Everyday Denazification
       * page 32).
       *
       * THE ROW GOES BACK TO QUEUED, wearing the engine's own sentence -- the
       * last stderr line, which names the endpoint and the page and says the
       * resume is free. Who runs it again depends on who ordered it: a
       * pump-driven row sits out `PARK_AFTER_WEATHER_MS` on `parkedUntil` and
       * the pump takes it back (wired after the settle below, because
       * `settled` forgets every park); a detached run is answered through
       * `parkedRuns` and the host, or the dialog, decides.
       *
       * THE READINGS ARE KEPT, as after a resumable stop and unlike a cancel:
       * the bank is the whole reason a park costs nothing.
       */
      const line = result.stderr.trim().split(/\r?\n/).reverse().find((one) => /^foundry: parked:/.test(one));
      const sentence = (line ?? '').replace(/^foundry: /, '')
        || engineSentence(result.stderr)
        || `The engine parked (exit ${result.code}) with nothing to say.`;
      next.state = 'queued';
      next.message = sentence;
      next.note = null;
      delete next.startedAt;
      parkedRuns.set(next.id, sentence);
      lastEngineStderr.set(next.id, result.stderr);
      console.log(`\n[job] ${next.kind} PARKED — ${path.basename(next.inputPath)}\n${sentence}\n`);
    } else {
      next.state = 'failed';
      // foundry's own sentence is the message a user needs — it names the missing
      // Python, the model it could not load, the page it choked on. Never
      // paraphrased, and never replaced with an exit code. The SENTENCE, not the
      // whole stderr: a reading's stderr carries a `page N/M: rendered` line per
      // page, and a 968-page book put all 968 on the row. See `engineSentence`.
      next.error = engineSentence(result.stderr)
        || `The engine exited ${result.code} with nothing to say.`;
      /*
       * AND A COPY THE ROW CANNOT LOSE. `next.error` is erased by a resumable stop
       * on the host's side (BookForge P6), and a host's log is the only place a
       * night of failures survives the window being reloaded. Consumed by
       * `runDetached`; a row nobody detached simply leaves it and the next line
       * clears it.
       */
      lastEngineStderr.set(next.id, result.stderr);
      /*
       * AND IT GOES TO THE CONSOLE, WHOLE.
       *
       * Until now a failure existed in exactly one place a person could reach: a
       * tooltip on one row of the shelf. So a job that failed while the window
       * was reloading, or whose row was cleared, took its only account of itself
       * with it — which is precisely what happened twice tonight, and the second
       * time there was nothing left to read at all.
       *
       * The terminal running the app is where somebody is already looking when
       * something goes wrong, it survives every reload of the window, and it can
       * be scrolled back and copied. The full stderr rather than a summary: the
       * lines above the failure are usually the context that explains it, and
       * this is a diagnostic rather than a notification.
       */
      console.error(
        `\n[job] ${next.kind} FAILED — exit ${result.code} — ${path.basename(next.inputPath)}\n`
        + `${result.stderr.trim() || next.error}\n`,
      );
    }
  } finally {
    /*
     * ── AND WHATEVER WAS MOVED ASIDE COMES HOME, ON EVERY WAY OUT ────────────
     *
     * The invariant the rotation block states about itself, kept by the one
     * construct that cannot be reached past: a return, a refusal that settles,
     * a cancel, an engine's non-zero exit and a THROW all arrive here. Two
     * hand-placed calls used to stand for this and covered the last two of
     * those five; `engineCommand()`'s refusal — an app folder with no engine
     * bundle — went straight past them to `executeJob`'s
     * boundary, which settles the row correctly and cannot reach these locals.
     *
     * BEFORE THE `settle()` BELOW, which is why the tail of this function sits
     * outside the `try` rather than inside it: `onJobSettled` promises that
     * nothing else is coming from this job, and a listener told a run is over
     * while its book is still in an archive folder would be reading the
     * catalogue mid-rotation. The arms that settle and return say their own
     * ending first and are the exception — they filed nothing either way, and a
     * rotation put back a moment late is still a rotation put back.
     *
     * `putBack` IS A NO-OP BEFORE THE ROTATION HAPPENS — `rotatedIn` is null
     * until the block above sets it — so the `try` may start wherever the
     * locals are in scope.
     */
    if (!landed) {
      try {
        await putBack(rotatedIn, rotation, filedRotation);
      } catch (err) {
        /*
         * NOT EXPECTED, AND CAUGHT ANYWAY, for one reason: a throw out of a
         * `finally` REPLACES the error that is already in flight, so an
         * unguarded restore would swap the engine's own refusal for a rename
         * error and the run would be reported as something it was not. Both
         * restores name their own failures and return (`restoreRotation`,
         * `restoreFinalRotation`), so what reaches here is a defect in the
         * restore itself — which gets a line naming the document and where the
         * rotation put it, because a book in an archive folder that nothing
         * says is there is exactly the silence this whole block exists to end.
         */
        console.error(
          `[job] ${path.basename(next.outputPath)} was moved aside in ${rotatedIn} for a run `
          + `that produced nothing, and putting it back threw: `
          + `${err instanceof Error ? err.message : String(err)}. The generated rotation was `
          + `${rotation === null ? 'none' : rotation.movedTo} and the filed rotation was `
          + `${filedRotation === null ? 'none' : filedRotation.movedTo}; nothing was deleted.`,
        );
      }
    }
  }
  changed();
  // The three arms above return before this line, each saying it for itself
  // after whatever that landing produced; what reaches here is a cancel, a
  // failure, a park, and the rendering whose landing is a catalogue row.
  settle();
  /*
   * A PUMP-DRIVEN ROW THE ENGINE PARKED GOES BACK ON THE BOARD, after the
   * settle and not before: `settled` gives the lease back and FORGETS every
   * park on the row, so a `parkedUntil` set in the arm above would be gone by
   * here. `slots` still names the row -- the pump's own `finally` clears it
   * only once this returns -- which is how a pump-driven run is told from a
   * detached one, whose sentence stays in `parkedRuns` for `runDetached`.
   */
  const parkedSentence = parkedRuns.get(next.id);
  if (parkedSentence !== undefined && slots.has(next.id)) {
    parkedRuns.delete(next.id);
    lastEngineStderr.delete(next.id);
    parkedUntil.set(next.id, Date.now() + PARK_AFTER_WEATHER_MS);
    const timer = setTimeout(() => { void pump(); }, PARK_AFTER_WEATHER_MS);
    timer.unref?.();
    changed();
  }
  // NOTHING WAS WAITED FOR: this run ran. See `Placed`, and `runDetached`, which
  // is the only caller that can do anything with the other answer.
  return null;
}
