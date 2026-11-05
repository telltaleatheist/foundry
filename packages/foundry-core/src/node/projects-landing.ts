/**
 * projects-landing — landing a generated book, a final file and a reading.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ProjectDocumentKind, ProjectGeneratedRole, ProjectManifest } from '../shared/types';
import { WHY_MODEL_PASS } from '../shared/types';
import { readJson } from '../shared/json';
import { STEP_LABELS } from '../shared/steps';
import { askedOf, generationForLanding, documentOriginOf, type ReadAsk } from '../shared/ledger';
import { countLines } from './projects-delete';
import { announceProjects, exists, readManifest, withManifest, writeManifest } from './projects-manifest';
import { FINAL, GENERATED, MANIFEST, ProjectError, WORKING, projectDirOf } from './projects-paths';
import { recordStep, stampedArchive } from './projects-rotation';
import { destroyPayload, landStep, ledgerOf } from './projects-steps';

/**
 * Put a finished origin in the catalogue, and refresh the live copy it feeds.
 *
 * Called when the JOB SUCCEEDS rather than when it is planned, because a plan is
 * an intention: a run that fails at page 200 would otherwise leave a row in the
 * catalogue for a file that does not exist, and Home would offer it.
 *
 * A PDF-PRODUCING CONVERSION REPLACES THE LIVE PDF. There is ONE PDF per
 * project — "the PDF", the working document — and applying a change to it
 * produces a new version of it rather than a second document beside it.
 *
 * ── This was got wrong once, and the reasoning is worth keeping ─────────────
 *
 * When the reprint stopped being the scan-with-a-layer and became type on blank
 * paper, this promotion was removed and the reprint was given a row of its own.
 * The fear was real: promoting it would file the user's SCAN into
 * `working/archived-<stamp>/` and hand them a text-only document under the name
 * of the photograph they imported. Nobody asked for their scan to be replaced.
 *
 * That was the right worry solved in the wrong place. The scan is protected by
 * `archive/` BEING IMMUTABLE — it is copied in once at import and no path in
 * this app is ever composed into it — not by making the user keep track of two
 * PDFs with the same filename. Solving it here cost exactly what a wrong
 * abstraction costs: two identical rows in the document list, two identical
 * options in the OCR picker, and a refusal that told somebody to go and convert
 * "the original instead" — an instruction about this app's filing, given to the
 * person the filing is supposed to be invisible to.
 *
 * So the promotion is back and the user sees one PDF. The one they see is the
 * working copy, it carries whatever has been applied to it, the previous version
 * is rotated aside rather than lost, and the original they imported is still on
 * disk untouched — reachable by exporting it or reverting to it, which are
 * deliberate gestures rather than a row in a list.
 *
 * A failure here is LOGGED and not thrown. This runs at the end of a run that
 * may have taken three hours, and losing a row in a catalogue is not a reason to
 * report the conversion itself as failed — but it is named, in full, so the line
 * says which file went unrecorded and why.
 */
export async function recordGenerated(
  outputPath: string,
  role: ProjectGeneratedRole,
  /**
   * THE RUN THAT PRODUCED IT, carried for one reason: promoting a searchable
   * conversion rotates the live PDF aside, and an archive folder is named after
   * the run that made it (`stampedArchive`). The landing is the only place that
   * knows which job this was.
   */
  by: string,
): Promise<string | null> {
  const resolved = path.resolve(outputPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} finished outside any project, so nothing catalogued it.`);
    return null;
  }
  const inside = path.relative(dir, resolved).split(path.sep);
  const file = inside.length === 2 && inside[0] === GENERATED ? inside[1] : undefined;
  if (file === undefined) {
    console.error(`[projects] ${resolved} is not directly in a project's ${GENERATED}/, so nothing catalogued it.`);
    return null;
  }
  const kind = kindOf(file);
  if (kind === null) {
    console.error(`[projects] ${resolved} has an extension no project catalogue describes.`);
    return null;
  }
  try {
    return await withManifest(dir, async (manifest) => {
      /*
       * A STEP ON THAT TYPE'S CHAIN, and the cost is recorded with it.
       *
       * Every role that reaches here is the product of a model pass — a cast, a
       * reprint, a text emission all run the engine over the book — so the file is
       * frozen the moment it exists and later work happens on a copy of it. The
       * reason travels with the step so that the sweep, the rotation and the
       * delete warning can all ask one question of one place.
       */
      recordStep(manifest, kind, {
        file: `${GENERATED}/${file}`,
        label: STEP_LABELS[role],
        appliedAt: Date.now(),
        kind: role === 'translation' ? 'translate' : role === 'cast' ? 'origin' : 'convert',
        retention: 'expensive',
          why: WHY_MODEL_PASS,
      });
      /*
       * ── AND NO LEDGER STEP, WHICH IS THE WHOLE OF WHAT MOVED OUT OF HERE ─────
       *
       * This function used to land a `translate` step for one of its roles, and the
       * rule it stated was the settled one: translations become steps, renderings do
       * not. That rule is unchanged — what changed is that a translation is no longer
       * a rendering this function ever sees. `translate --records` writes per-block
       * answers into `readings/` and no document at all, so the step lands where the
       * answers land (`recordTextPass`, above), and what eventually arrives HERE
       * from a translated position is the BOOK CAST FROM those records: free, remade
       * on demand, and carrying `forStep`, which makes the queue file it nowhere at
       * all (`GenerateRequest.forStep`).
       *
       * So every role that reaches this function is a rendering now, and the four of
       * them are four ways of writing out one bank of answers. Minting a step for
       * any of them would put a filename where an action belongs and offer the user
       * a delete button for something that costs nothing to have back.
       */
      // WRITTEN BEFORE the live copy is refreshed, and that ordering is the
      // whole reason these are two writes. Refreshing can refuse — an archive
      // folder named for this run is already there — and a refusal that took
      // the origin's own catalogue row down with it would leave the engine's
      // output on disk, uncatalogued, invisible to Home.
      await writeManifest(dir, manifest);
      if (role !== 'searchable') return null;
      const live = await refreshLivePdf(dir, manifest, file, by);
      await writeManifest(dir, manifest);
      return live;
    }).finally(announceProjects);
  } catch (err) {
    console.error(`[projects] ${path.join(dir, MANIFEST)} could not record ${file}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Install a `generated/` PDF as the project's live one.
 *
 * `recordGenerated` above is the one caller: a searchable conversion's output
 * becomes the copy the tabs open. The flat-layout adoption that also needed
 * this is gone — the ruling of 2026-08-16 was that nothing is kept for legacy's
 * sake, and the machines that held a flat workspace have been regrouped or
 * wiped by their owners.
 *
 * The old live copy is rotated into `working/archived-<stamp>/` rather than
 * overwritten, because it is the only thing that can answer "what did this look
 * like before?" — and because a metadata edit made against it (once those exist)
 * would otherwise vanish without a trace.
 */
export async function refreshLivePdf(
  dir: string,
  manifest: ProjectManifest,
  generatedFile: string,
  /** The run this promotion is part of — `rotateGenerated`'s `by`, for its reason. */
  by: string,
): Promise<string> {
  const liveFile = `${manifest.stem}.pdf`;
  const live = path.join(dir, WORKING, liveFile);
  await fsp.mkdir(path.join(dir, WORKING), { recursive: true });
  if (await exists(live)) {
    const archive = stampedArchive(path.join(dir, WORKING), by);
    if (await exists(archive)) {
      throw new ProjectError(
        `${archive} already exists, so the previous ${liveFile} cannot be moved aside. Move it away.`,
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    await fsp.rename(live, path.join(archive, liveFile));
  }
  await fsp.copyFile(path.join(dir, GENERATED, generatedFile), live);
  manifest.working.files = [
    ...manifest.working.files.filter((row) => row.file !== liveFile),
    { file: liveFile, kind: 'pdf', from: `${GENERATED}/${generatedFile}`, madeAt: Date.now() },
  ];
  return live;
}

/**
 * Note that a finished document is sitting in the project's own `final/`.
 *
 * Only when it landed THERE. Save As to a USB stick or to somebody's Desktop is
 * the user's business and is already in recents; the catalogue records the
 * project's own filing tray so Home can say a book has been filed at all.
 * Silent about anything else, and never fatal — a save that happened must not
 * report a failure because a catalogue line did not.
 *
 * ── AND IT IS NOW THE WHOLE LANDING OF AN EXPORT ────────────────────────────
 *
 * This used to have one caller: a person pressing Save As and choosing the folder
 * the dialog opened in. The queue is the second, and it is the reason the tray has
 * a name in the model at all — an export is a run of the engine that lands here
 * INSTEAD of going through `recordGenerated` (docs/WORKBENCH.md §3). Nothing about
 * this function had to change to take it, which is the point rather than luck: a
 * row in `manifest.final` says "this file exists, it is finished, and it is yours",
 * and that sentence is equally true whichever gesture put the bytes there.
 *
 * WHAT IT DELIBERATELY STILL DOES NOT DO is everything a generated origin gets. No
 * step on a type's chain, because an export is not a version of the project's EPUB
 * — it is a copy somebody asked for. No ledger step, because nothing is ever made
 * from it: "it wont go into the working files as a step because it isnt the base
 * for new steps. its a terminal step." No live-PDF refresh, because a facsimile
 * exported to the tray is not the document this app works on. One row, and stop.
 *
 * ONE ROW PER NAME, replaced rather than appended: exporting the same format twice
 * writes the same path twice (the predecessor having been rotated aside first —
 * `rotateFinal`), and two rows for one file is a left nav that offers a document it
 * cannot tell apart from itself.
 */
export async function recordFinal(
  destination: string,
  /**
   * THE LEDGER STEP THIS EXPORT REPLAYED TO, when the caller is the queue and
   * therefore knows — see `ProjectFinal.stepId`.
   *
   * OPTIONAL BECAUSE THE OTHER CALLER CANNOT KNOW IT. Save As is a person
   * choosing a folder in a dialog, and the file they are filing has no step
   * behind it at all; passing a position from there would be recording where
   * somebody happened to be standing as though it were where the bytes came
   * from. Absent is the honest answer and it is the pre-existing behaviour.
   */
  stepId: string | null = null,
): Promise<void> {
  const resolved = path.resolve(destination);
  const dir = projectDirOf(resolved);
  if (dir === null) return;
  const inside = path.relative(dir, resolved).split(path.sep);
  const file = inside.length === 2 && inside[0] === FINAL ? inside[1] : undefined;
  if (file === undefined) return;
  const kind = kindOf(file);
  if (kind === null) return;
  try {
    await withManifest(dir, async (manifest) => {
      manifest.final = [
        ...manifest.final.filter((entry) => entry.file !== file),
        {
          file,
          kind,
          madeAt: Date.now(),
          ...(stepId !== null && stepId.length > 0 ? { stepId } : {}),
        },
      ];
      await writeManifest(dir, manifest);
    });
    announceProjects();
  } catch (err) {
    console.error(`[projects] ${path.join(dir, MANIFEST)} could not record ${file}: ${(err as Error).message}`);
  }
}

/** Where Save opens for a book in this project. Created so the dialog lands in it. */
export async function finalDir(dir: string): Promise<string> {
  const target = path.join(dir, FINAL);
  await fsp.mkdir(target, { recursive: true });
  return target;
}

export function kindOf(file: string): ProjectDocumentKind | null {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.epub') return 'epub';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.txt') return 'txt';
  return null;
}

/**
 * A reading FINISHED — the one moment anything can honestly say a bank is done.
 *
 * WHERE THE GENERATION IS MINTED, and it is the natural place: a landing is a
 * bank that is on disk and was not before, so it is the event a generation is
 * about. `generationForLanding` states the rule and its one exception — a first
 * read adopts a generation somebody's first touch minted while it was still
 * running, so corrections made against the pages already read survive the run
 * finishing. Everything else mints: a re-read swapped in over the old bank, a
 * branch beside it, and a first read nobody watched.
 *
 * IT IS THE ONLY PLACE THAT MINTS ONE NOW. `readingGeneration` — the block
 * editor's first-touch minting, which asked where the user was STANDING rather
 * than what had just landed — is deleted with the overlay system that was the
 * only thing bound to it (docs/RENDERER.md §7). What the id is still for is the
 * records: a translate run is handed `--generation` and stamps it into every row
 * it writes, so a set of answers can say which reading of the pages it is about.
 *
 * A failure is a console line and never a throw. This runs after a job that may
 * have taken three hours, and a catalogue row that could not be written is not a
 * reason to report those hours as a failure — the bank is on disk either way, and
 * the completion marker beside it is what a listing falls back to.
 */
export async function recordReading(
  readingsPath: string,
  /**
   * WHAT THE RUN WAS ASKED FOR — the two fields of `ReadRequest` the person
   * filled in — handed over rather than inferred from what came back.
   *
   * It is what decides whether the next reading of this book REPLACES this step
   * or branches beside it (`MINTED_BY_THE_RUN`), and nothing on disk can answer
   * it afterwards: a bank does not record which pages it was told to leave out,
   * and working that out from the gaps in a file would be the same species of
   * guess as reading a language out of a filename. The job knows what it asked;
   * it says so, exactly as the translation hands over its `--to`.
   *
   * Defaulted so that a caller with nothing to say — a reading recorded by a
   * build that predates this, or one adopted from outside the queue — records a
   * reading of the whole book with no language declared, which is the plain
   * question and the one a migrated project asks too.
   */
  asked: ReadAsk = {},
  /**
   * THE STEP THIS BANK WAS NAMED AFTER, when the plan minted one.
   *
   * A branching re-read writes `readings/<key>.<id8>.jsonl`, and the `id8` in that
   * filename is the front of the step's uuid — decided at the plan, hours before
   * this runs (`bankForReading`). Landing under a freshly minted id would leave the
   * file named after a row that does not exist, so the id travels with the job
   * (`ReadRequest.stepId`) and is spent here.
   *
   * Absent for a job from a build that predates the field, and unused whenever
   * this landing turns out to be a replace: `LandedRun.id` is spent only on an
   * append, and a replace swaps a payload into the step that is already there.
   */
  stepId?: string,
): Promise<void> {
  const resolved = path.resolve(readingsPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} is outside any project, so no reading was recorded.`);
    return;
  }
  try {
    const pages = await countLines(resolved);
    /*
     * THE MARKER FOR THE BANK THIS RUN WROTE, and not for the position's. They
     * are usually one file and are not always: a branch lands beside the reading
     * somebody is standing on. The step records the completion of its OWN bank,
     * which is the only thing a later "has this been read again behind our back?"
     * can honestly compare against.
     */
    const completedAt = await markerStamp(resolved);
    await withManifest(dir, async (manifest) => {
      const generation = generationForLanding(
        ledgerOf(manifest),
        manifest.reading,
        completedAt,
        randomUUID(),
      );
      manifest.reading = {
        generation,
        readAt: Date.now(),
        pages,
        ...(completedAt !== null ? { completedAt } : {}),
      };
      /*
       * ── AND THE READ STEP, WHICH IS THE SAME FACT IN THE OTHER RECORD ────────
       *
       * `manifest.reading` above says which reading the block editor's live
       * corrections are bound to — one per project, replaced in place, a fact
       * about NOW. The ledger says what has been done to this book and what each
       * of those left behind, and it keeps every one of them. Both are written
       * from the same values in the same instant precisely so they cannot come to
       * disagree about a book. (`readingGeneration` reads the STEP first, and the
       * project record only for a project that has no read step at all — but a
       * step can be deleted, and the record left behind should still be about the
       * reading that happened rather than about one before it.)
       *
       * ITS PARENT IS THE IMPORT AND NOT THE POSITION, which is the one action
       * where those differ — see `originOf`. A reading reads the PIXELS, and the
       * pixels are in `archive/` however far through their own history the person
       * pressing OCR happens to be standing. Parented at the position it would
       * append a reading made FROM a reading the moment anybody re-read a book
       * while looking at it, and every one of those steps would name the single
       * bank file the engine writes.
       *
       * WHAT WAS ASKED FOR IS RECORDED SEPARATELY FROM WHAT CAME BACK, and the
       * two piles decide different things. `generation`, `pages` and `completedAt`
       * are the run's own answer — one minted by the pass, one counted off the
       * finished bank, one read off the marker the engine left beside it — and all
       * three are excluded from the re-run comparison (`MINTED_BY_THE_RUN`): a
       * re-read mints a new generation by design, so comparing it would make every
       * re-read look like a new question and leave the project holding two banks
       * where the user asked for one. The page skips and the language are the
       * QUESTION, so they are what decides append-or-replace, and a re-read of the
       * same request replaces while one asking for a different range branches.
       *
       * A REPLACE STALES EVERYTHING DOWNSTREAM, which `recordLanding` does: the
       * saves made against the previous bank name blocks by numbers that mean
       * different blocks now, and the translations of those saves were of blocks
       * that have moved. They stay in the list, dimmed and clickable, because each
       * still has its own payload and that payload is still a true record of
       * something.
       */
      const landing = await landStep(manifest, {
        action: 'read',
        // The DOCUMENT origin — the mint, on a captured project. A read
        // parented at the photographs was the tree's recorded lie
        // (`healReadParents` carries the ruling and repairs the old ones).
        parent: documentOriginOf(ledgerOf(manifest))?.id ?? null,
        /*
         * WHERE THE ENGINE ACTUALLY WROTE, and not a path composed from the key.
         *
         * It used to be `readings/<key>.jsonl` spelled out here, which was true
         * while a project had one bank and became a lie the moment a re-read could
         * branch into a bank of its own. The run was handed a path
         * (`bankForReading`) and filled that file; the step is the record of what
         * that run produced, so it names the file the run produced. A composed path
         * would be this function's second opinion about a decision made hours ago.
         *
         * Spelled with forward slashes and relative to the project, which is what
         * `LedgerStep.payload` is and what `destroyPayload` splits again to reach
         * the file — so nothing here ever matches by basename.
         */
        payload: path.relative(dir, resolved).split(path.sep).join('/'),
        // `askedOf` trims and drops, so that "asked for nothing" has ONE spelling
        // here and at the plan that named the bank. Two spellings would be two
        // questions to `reRunTarget` — the same book read twice, branching because
        // one of them recorded the empty string somebody's cursor left behind.
        params: {
          generation,
          pages,
          // Absent rather than 0 for a run whose marker could not be read: see
          // `readReading` for why those two are different statements, and
          // `generationInEffect` for what an absent one means to the next reader.
          ...(completedAt !== null ? { completedAt } : {}),
          ...askedOf(asked),
        },
        createdAt: Date.now(),
        ...(stepId !== undefined ? { id: stepId } : {}),
      });
      await writeManifest(dir, manifest);
      /*
       * The swap has landed, so the file the old step named may go — and only now.
       *
       * NULL IS STILL THE ORDINARY ANSWER and now for the right reason. It used to
       * be null because every reading composed one path, so a re-read wrote where
       * the previous one had and there was nothing left to unlink; it is null today
       * because a replace was AIMED at the target step's own payload before the job
       * was enqueued (`bankForReading`), so the path genuinely did not move.
       *
       * WHAT MAKES IT DO REAL WORK is the one case where a path can drift between
       * the plan and the landing: a run planned as a branch — its bank minted as
       * `readings/<key>.<id8>.jsonl` — landing as a replace, because the step it
       * would have branched beside was deleted while it ran, or because another
       * reading of the same question landed first. The step keeps its place and
       * takes the new path, and the bank it used to name is now a file no row in
       * this project points at. `namesPayload` is what proves that, by the whole
       * project-relative path, before a byte is destroyed.
       */
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
    });
    // The one that puts the waiting light out. Home and the dock are drawn from
    // the listing, and until this is heard they both go on asking for a step
    // that has just been taken.
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${path.basename(dir)} could not record its reading (${(err as Error).message}). `
      + 'The bank is on disk and the engine\'s completion marker is beside it, which is what the '
      + 'library screen falls back to.',
    );
  }
}

/**
 * The engine's completion marker for one bank: `<bank>.completed.json`, beside it
 * and named for it.
 *
 * SPELLED HERE RATHER THAN IMPORTED, and that is the rule rather than an
 * oversight — this app never imports the engine, it spawns it. The engine's own
 * `completionMarkerPath` (src/vlm/readings.ts) composes exactly this, and the
 * paragraph above it says why the name has to come off the BANK rather than off
 * its directory: one `readings/` folder held two books' banks once, one marker
 * sat in it, and the run asked about the other book archived a finished bank and
 * paid for a hundred pages again.
 */
export function completionMarkerFor(bankPath: string): string {
  return `${path.resolve(bankPath).replace(/\.jsonl$/i, '')}.completed.json`;
}

/**
 * When the run that filled this bank said it finished — epoch milliseconds — or
 * null when nothing beside the bank says.
 *
 * ── What this is for, and why a number ──────────────────────────────────────
 *
 * It is the only fact on disk that moves when a bank is READ AGAIN and stays put
 * when one is merely re-rendered, now that no bank is ever archived. A run swaps
 * its finished pending bank into place and writes a fresh marker; a Generate
 * touches neither. So the stamp recorded beside a generation and the stamp on
 * disk disagreeing is exactly "these are different answers about the same pages",
 * which is what the generation exists to notice (`generationInEffect`).
 *
 * `completedAt` IS AN ISO STRING IN THE FILE and a number here. The engine writes
 * an instant, and an instant compared as text is a comparison that a change of
 * timezone spelling or of trailing zeros could break — `Date.parse` gives the
 * milliseconds back exactly, and epoch milliseconds is what every other time in
 * this catalogue already is.
 *
 * NULL FOR EVERY KIND OF SILENCE: no marker, unreadable, not JSON, no
 * `completedAt`, or one that is not a date. All of them mean the same thing to
 * the caller — there is no evidence here — and the caller's answer to no evidence
 * is to leave the generation exactly as it stands. A marker this app cannot read
 * must never be allowed to invent a re-read that did not happen.
 */
export async function markerStamp(bankPath: string): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = readJson(await fsp.readFile(completionMarkerFor(bankPath), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const said = (parsed as Record<string, unknown>)['completedAt'];
  if (typeof said !== 'string') return null;
  const at = Date.parse(said);
  return Number.isNaN(at) ? null : at;
}

/**
 * The name of the file in `archive/`, or null when this project has none.
 *
 * The one accessor for the source of record. `workspace.ts` turns it into a path
 * to hand the engine; nothing else needs it, and nothing at all writes there.
 */
export async function archiveFileOf(dir: string): Promise<string | null> {
  try {
    return (await readManifest(dir)).archive?.file ?? null;
  } catch {
    // A catalogue that will not parse cannot name its archive. The caller falls
    // back to the document it was given, which is what that project has.
    return null;
  }
}
