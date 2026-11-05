/**
 * projects-step-delete — deleting a step and what it owns.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { LedgerStep, ProjectArchive, ProjectManifest, StepCasualty, StepDeletion } from '../shared/types';
import { chainsWithout, deleteCost, deleteSubtree, destroyedBy, orphanedBanks, pendingBeside, stepOf, subtree } from '../shared/ledger';
import { deletableProjectDir, emptySweep, planSweep } from './projects-delete';
import type { Sweep } from './projects-delete';
import { announceProjects, exists, readManifest, withManifest, writeManifest } from './projects-manifest';
import { pagesKey } from './projects-mint';
import { ARCHIVE, WORKING, contentKey } from './projects-paths';
import { facsimileForReadStep, onDisk } from './projects-planning';
import { destroyPayload, ledgerOf, viewOf } from './projects-steps';
import type { LedgerView } from './projects-steps';

/**
 * What deleting this step would take, and whether it is allowed at all.
 *
 * DESCRIBE AND DELETE ARE TWO CALLS, exactly as they are for a document, and this
 * one owes the refusals as well as the facts: a card must never be put on screen
 * for something the delete would refuse a click later. `deleteSubtree` refuses the
 * origin by name — deleting the import is deleting the project, and the project ✕
 * does that with its own ceremony and its own accounting of what it costs.
 *
 * EVERY CASUALTY IS NAMED WITH ITS OWN COST, in the retention rule's own terms,
 * because the three retentions are three genuinely different losses. A confirm
 * that said "Are you sure?" over a list of four would train somebody to click
 * through the one that was about their curation.
 */
export async function describeStepDelete(dir: string, stepId: string): Promise<StepDeletion> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  const named = stepOf(ledger, stepId);
  // Run for its REFUSAL as much as for its list: this is the one place that can
  // say no before the user has agreed to anything.
  const deletion = deleteSubtree(ledger, stepId);
  const banks = new Set(orphanedBanks(deletion, manifest.key));
  const destroyed = destroyedBy(deletion, manifest.key);
  const sweeps = await planStepSweep(resolved, destroyed, banks, manifest, deletion.removed);
  return {
    belongings: sweptBelongings(sweeps),
    stepId: named.id,
    label: named.label,
    casualties: subtree(ledger, stepId).map((step): StepCasualty => ({
      id: step.id,
      label: step.label,
      cost: deleteCost(step),
      stale: step.stale === true,
    })),
    /*
     * THE PAYLOADS, AND THE FACSIMILES THE DOOMED READINGS MADE FOR THEMSELVES.
     *
     * This list is what the window LETS GO OF before main unlinks anything, and a
     * read step's facsimile is a document a person can have open in a tab — it is
     * the terminal row drawn under the import. Leaving it out would meet main's own
     * refusal one line after the user said yes, which is a dialog that asks a
     * question and then declines to act on the answer. `castsAmong` is the same
     * function the sweep above composed its paths with, so the card and the delete
     * cannot come to two lists.
     */
    files: [
      ...destroyed.map((payload) => path.join(resolved, ...payload.split('/'))),
      ...await castsAmong(resolved, manifest, deletion.removed),
    ],
  };
}

/**
 * Refuse while this window is still reading one of the doomed payloads.
 *
 * ── WHICH MODEL WON, and it is the document delete's ────────────────────────
 *
 * There were two in the app and they did not agree. The PROJECT delete refuses in
 * main by asking `openBookIn` — it looks at what is open and says no. The DOCUMENT
 * delete refuses in main too, by a narrower test (`workingTreeHeld`, the count the
 * epub reader holds from open to close), AND the renderer closes the file's own
 * tab between the confirm and the call. The step delete had neither, so deleting a
 * translate step whose EPUB was open left a tab serving a working copy that had
 * just been erased: every image a 404, every save a failure, and nothing on screen
 * saying why.
 *
 * THE DOCUMENT DELETE'S MODEL IS THE ONE ADOPTED HERE, whole: main refuses, and
 * the renderer closes first so the refusal is almost never reached. The narrower
 * test is the right one for the same reason it is right there — a step delete
 * takes ONE payload out of a project, and refusing it because some other book in
 * the same folder happens to be open would make the ✕ useless exactly when it is
 * wanted (throw away the English translation while reading the scan). The project
 * delete keeps `openBookIn` because it erases the folder, which is a different
 * act and says so in its own sentence.
 */
/**
 * Everything on disk that goes with the payloads a step delete destroys.
 *
 * ── The state this was leaving behind ───────────────────────────────────────
 *
 * A step delete used to unlink the payload and nothing else, and a payload is not
 * the only file that belongs to it. Deleting a translation whose EPUB had been
 * unpacked left `working/<tree>/` — a whole book's markup — in the folder, a
 * `working.trees` row whose `from` named a file that no longer existed, and
 * `history/<tree>.json`, an undo ledger for a book that is gone. None of it is
 * reachable from anything in the app afterwards: the row it hung off is off the
 * ledger, so it is bytes nothing will ever mention again, which is precisely the
 * outcome `deleteDocument` was written to avoid.
 *
 * `planSweep` IS THAT ANSWER AND IT IS REUSED RATHER THAN RESTATED. It is the one
 * place that knows what belongs to a file alone — the tree, the ledgers live and
 * archived, the rotated predecessors — and its docstring is the argument for each.
 * Two functions deciding that would be two answers to "what is this file's", and
 * the delete card and the delete would eventually describe different things.
 *
 * ONE SWEEP PER PAYLOAD, over `orphanedPayloads` rather than the removed steps:
 * a file another step still names is still on disk and still has a working tree
 * serving it. See that function for the re-read that leaves two steps naming one
 * bank.
 */
export async function planStepSweep(
  dir: string,
  payloads: readonly string[],
  /**
   * Which of those files are BANKS, so the engine's in-flight debris beside them
   * goes too. See `pendingBeside` for what that debris is and why no step will
   * ever name it.
   *
   * Both kinds are in here (`orphanedBanks`): a reading's bank, which is also its
   * step's payload, and a translation's, which is a file beside its step's payload
   * and reaches this list only because `destroyedBy` put it there. The translate
   * engine writes `<bank>.pending` and no request sidecar, and an absent sidecar
   * simply fails the existence test below — one rule, two callers, no `if`.
   */
  banks: ReadonlySet<string>,
  manifest: ProjectManifest,
  /**
   * THE ROWS THIS DELETE TAKES OFF THE LEDGER, for the files that belong to a step
   * and are nobody's payload: the books a save and a translation cast for
   * themselves.
   *
   * It is a rendering — free, regenerable, never catalogued
   * (`facsimileForReadStep` says why not) — which is exactly what makes it
   * unreachable from every other mechanism in here. `orphanedPayloads` reasons
   * over payloads and this is not one; `manifest.documents` has no row for it; the
   * name is composed from the step's own uuid, so once the row is gone nothing on
   * this disk could ever work out what the file was. Left behind it would be a
   * whole PDF in `generated/` that no screen in this app will ever mention again,
   * which is the same failure a translation's abandoned bank was.
   *
   * THE STEPS AND NOT A LIST OF PATHS, because composing the name needs the
   * project's stem and the step's id together, and a caller that composed it would
   * be the second place that decides what a reading's reprint is called.
   */
  removed: readonly LedgerStep[] = [],
): Promise<Sweep[]> {
  const sweeps: Sweep[] = [];
  for (const cast of await castsAmong(dir, manifest, removed)) {
    /*
     * THROUGH `planSweep`, which is what makes this more than an unlink: a re-read
     * that replaced this same step rotated its earlier reprints aside, and those
     * belong to this file and to nothing else.
     */
    const sweep = await planSweep(dir, cast, manifest);
    sweep.files.push(cast);
    sweeps.push(sweep);
  }
  for (const payload of payloads) {
    const resolved = path.join(dir, ...payload.split('/'));
    const sweep = await planSweep(dir, resolved, manifest);
    /*
     * ADDED HERE RATHER THAN INSIDE `planSweep`, deliberately: that function is
     * shared with the DOCUMENT delete, which is about EPUBs and PDFs and has no
     * business knowing what a readings bank is. This is the step delete's own
     * rule, so it is applied where the step delete composes its sweeps.
     *
     * The existence test is `planSweep`'s own idiom, and it earns its stat: the
     * card counts and lists what a sweep holds, and a path in there for a file
     * that was never on disk would be this app naming debris it invented.
     */
    if (banks.has(payload)) {
      for (const debris of pendingBeside(resolved)) {
        if (await exists(debris)) sweep.files.push(debris);
      }
    }
    sweeps.push(sweep);
  }
  return sweeps;
}

/**
 * The facsimiles the doomed readings made for themselves, absolute, and only the
 * ones that are actually there.
 *
 * ONE COMPOSITION FOR TWO CALLERS — the sweep that removes them and the card that
 * names them — because a card may not destroy something it did not name, and two
 * places composing `<stem>.<id8>.pdf` is exactly how it ends up doing that.
 *
 * ONE KIND OF LANDING PRODUCES A DOCUMENT NOBODY ASKED FOR, and since R6b it is
 * the reading's facsimile alone: the per-step cast EPUBs a save and a translation
 * used to leave behind are deleted, and both rows are answered by the proof sheet
 * (docs/RENDERER.md §7). Deleting a read step
 * already destroys the bank it was made of — this is the reprint of that bank,
 * uncatalogued for `facsimileForReadStep`'s reasons, and left behind it would be
 * a whole PDF in `generated/` describing pages nothing in this project reads any
 * more. `planSweep` takes its rotated predecessors with it, which is where a
 * re-read that replaced this same step left its earlier reprints.
 *
 * THE EXISTENCE TEST EARNS ITS STAT. A reading from before the facsimile landed
 * automatically, one whose facsimile failed, one whose facsimile was rotated
 * aside: all of them are rows with no reprint at this name, and a path in either
 * list for a file that was never made would be this app naming debris it invented.
 */
export async function castsAmong(
  dir: string,
  manifest: ProjectManifest,
  removed: readonly LedgerStep[],
): Promise<string[]> {
  const casts: string[] = [];
  for (const step of removed) {
    const named = step.action === 'read' ? facsimileForReadStep(manifest, step) : null;
    if (named === null) continue;
    const cast = path.join(dir, ...named.split('/'));
    if (await exists(cast)) casts.push(cast);
  }
  return casts;
}

/*
 * `banksAmong` MOVED TO shared/ledger.ts AS `orphanedBanks`, beside
 * `orphanedPayloads`, whose question it is a second half of: what does this delete
 * actually take off the disk? It is a pure map from a decided deletion to a list
 * of paths — no directory, no filesystem — and it decides whether hours of GPU are
 * destroyed, which is exactly the code this app keeps where a test can reach it
 * (see that module's header). `destroyedBy` went with it for the same reason.
 */

/**
 * What the sweep will take besides the payloads, as one sentence — or null.
 *
 * A CONFIRM MAY NOT DESTROY SOMETHING IT DID NOT NAME. What is left in here after
 * the working trees went (docs/RENDERER.md §7) is the versions earlier runs
 * rotated aside — they belong to a payload above and to nothing else (`planSweep`
 * is the argument), so leaving them would leave bytes nothing in the app can
 * reach, and taking them silently would be the app erasing an earlier reprint
 * while asking about a row in a list.
 *
 * NULL FOR THE ORDINARY CASE, which is most of them: a curation snapshot is one
 * file, and a reading nobody re-read has nothing beside it. A sentence that
 * appeared every time and usually said "and nothing else" is a line people learn
 * to skip.
 */
export function sweptBelongings(sweeps: readonly Sweep[]): string | null {
  let versions = 0;
  for (const sweep of sweeps) versions += sweep.archivedVersions;
  if (versions === 0) return null;
  const said = versions === 1
    ? 'one earlier version an earlier run rotated aside'
    : `${versions} earlier versions earlier runs rotated aside`;
  return `It also takes ${said}. Those belong to the files above and nothing else in this project `
    + 'names them.';
}

/** The two names a refusal about one step has to be able to say out loud. */
export interface StepSubject {
  /** The directory, resolved and PROVEN to be one this app may delete inside. */
  dir: string;
  /** The project as its owner knows it — the book's title, never the key. */
  title: string;
  /** The step as the row on screen says it: "Read (317 pages)". Never a file. */
  label: string;
}

/**
 * Who a step delete is about — for a caller with a refusal of its own to compose.
 *
 * ── Why this is not `inspectProject` ────────────────────────────────────────
 *
 * The delete card's inventory measures every byte under the project and streams
 * every bank in it to count pages, which is right for a dialog somebody opened on
 * purpose and absurd for composing one sentence about a job in the shelf. This is
 * the cheap half: one catalogue read, which is a few kilobytes.
 *
 * ── And why the two names travel together ───────────────────────────────────
 *
 * A refusal has to be actionable, and "a job is running, so this cannot be
 * deleted" is not — the person is looking at a list of steps and a shelf of jobs
 * and has to be told which of each. Both facts come out of the one manifest read
 * that proves the directory, so there is no arrangement where a caller has one
 * and has to go back for the other.
 *
 * ── THE PERMANENT REFUSAL IS RUN FIRST, AND THAT IS THE POINT OF THE NAME ───
 *
 * `deleteSubtree` is called for its refusal and its answer thrown away, exactly as
 * `describeStepDelete` calls it. The order matters to the person reading the
 * sentence: the origin can NEVER be deleted, and telling somebody to cancel a job
 * and come back — about a step that will refuse them just as firmly in an hour —
 * is a sentence that wastes their afternoon. A transient refusal must never be
 * said in front of a permanent one.
 *
 * `stepOf` refuses an id this project does not hold, by name, which is the right
 * answer for a renderer naming a row nobody drew.
 */
export async function deletableStep(dir: string, stepId: string): Promise<StepSubject> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  deleteSubtree(ledger, stepId);
  return { dir: resolved, title: manifest.title, label: stepOf(ledger, stepId).label };
}

/**
 * Take a step and everything made from it, off the ledger and off the disk.
 *
 * ── The order, which is the only interesting decision here ──────────────────
 *
 * THE MANIFEST GOES FIRST. Between the two writes there is a window, and it can
 * only fall one of two ways: files on disk that nothing names, or rows naming
 * files that are gone. The second is the survivable one — `summarise` already
 * draws a document whose file is missing, marked missing, so a person can see
 * what happened and act — while the first is a folder quietly holding hours of
 * GPU that no screen in this app will ever mention again. So the record of the
 * decision lands first, and the unlinking follows it.
 *
 * A FILE THAT WILL NOT DELETE IS A NAMED CONSOLE LINE AND NOT A THROW, for the
 * same reason: by the time it is reached the delete has happened as far as this
 * app's own bookkeeping is concerned, and rejecting the call would tell the user
 * their delete failed while leaving it done. What is left behind is one stray
 * file, named, in a folder they can open.
 *
 * WHAT IS DESTROYED IS `orphanedPayloads` AND NOT "the removed steps' payloads".
 * Two steps are allowed to name one file and in this app routinely do — see that
 * function for the re-read that leaves two `read` steps pointing at one bank.
 *
 * ── AND THE PER-TYPE ROW GOES IN THE SAME BREATH ────────────────────────────
 *
 * `manifest.documents` is the other record of the same files — the chains Home's
 * document rows are drawn from — and a delete that struck the ledger and left
 * those alone gave the user a row for a file it had just erased, drawn as
 * `missing`: the app's way of saying "something happened to a file you still
 * have" about the one thing they had deliberately thrown away. So `chainsWithout`
 * strikes them, from `orphanedPayloads` for the same reason the unlinking is —
 * what a surviving step still names is still on disk and is still a true row.
 *
 * IN THIS TRANSACTION, not a second one. Both edits are made against the open
 * manifest and land in ONE `writeManifest`, so there is no window where a crash
 * could leave the two records disagreeing about what this project has. The window
 * that does remain is the one below — rows written, files not yet unlinked — and
 * it falls the survivable way on purpose.
 *
 * ── AND THE PAYLOAD'S OWN BELONGINGS GO WITH IT ─────────────────────────────
 *
 * `planStepSweep` is the rest of the delete, and its comment is the argument: a
 * translation's EPUB has a working tree unpacked from it and an undo ledger named
 * after that tree, and a delete that took the row and the file and left those
 * behind left a directory of somebody's markup that nothing in the app can reach.
 * The tree's manifest row goes in the same transaction as the ledger surgery, for
 * the reason the chains do — a row naming a directory that is not there is the
 * exact state `rotateGenerated` is careful never to leave.
 *
 * ── AND A BANK'S HALF-FINISHED REPLACEMENT GOES WITH THE BANK ───────────────
 *
 * A re-read writes into `<bank>.pending` and swaps it over the real file only on
 * success, so a run that died leaves that pending file and its request sidecar
 * beside the bank as resumable debris (docs/BANK-LIFECYCLE.md §2). NO STEP NAMES
 * THEM — steps are minted on success and success is when the pending file stops
 * existing — so `orphanedPayloads` cannot find them and they would sit in
 * `readings/` forever after the bank they were replacing was deleted. Debris whose
 * bank is gone is debris about nothing. `orphanedBanks` decides which files are
 * banks, from the step's own action, and `planStepSweep` adds the pair.
 *
 * ── AND A TRANSLATION'S BANK IS THE SAME ARGUMENT ABOUT A DIFFERENT FILE ────
 *
 * A translate step's payload is the EPUB; the answers it was assembled from are in
 * the bank beside it, named by `params.bank` and by no step's payload anywhere. So
 * `orphanedPayloads` cannot find that either, and deleting the English translation
 * used to leave its whole per-block record in `readings/` — the same hours of GPU,
 * kept for a row that no longer exists. It is destroyed with the step, guarded by
 * the same whole-path check against what every surviving step MEANS by its bank
 * (recorded, or composed from its language for a translation that predates the
 * record), and its own pending file goes with it.
 *
 * A QUEUED JOB ABOUT TO RESUME ONE CANNOT LOSE IT TO THIS, and there is no new
 * mechanism for that: `refuseBusyStepDelete` (electron/ipc.ts) already refuses a
 * step delete while ANY held, queued or running job writes into this project —
 * deliberately coarse, on `refuseBusyJob`'s own argument that a narrower test
 * would have to predict where a run that has not started will write. Both IPC
 * doors ask it, the describe and the delete, so the card is never drawn for
 * something the click would refuse.
 */
/**
 * The archive record a project should hold once the file it named is destroyed.
 *
 * THE CATALOGUE DECIDES, not the ledger and not a guess: the newest entry on
 * this kind's chain that still lives under `archive/` and is still on disk. That
 * is the same chain `currentBookStep` walks, so the archive and the shelf cannot
 * disagree about which book this project has.
 *
 * `contentKey` IS RE-TAKEN FROM THE BYTES rather than carried over, because it
 * is the one field that describes the FILE rather than the project — carrying
 * the dead mint's key onto a surviving one would be a record that reads as
 * healthy and identifies the wrong document. `originPath` is carried, because it
 * says where this project's content came from and that has not changed: every
 * mint of a capture project names the same recipe.
 */
export async function archiveAfterLoss(
  resolved: string,
  manifest: ProjectManifest,
  dying: ProjectArchive,
): Promise<ProjectArchive | null> {
  /*
   * ── A PAGES ARCHIVE HAS NO CHAIN, SO THE LEDGER IS ASKED ──────────────────
   *
   * The walk below re-points the archive at the newest SURVIVING file on the
   * dying kind's chain, and it is the fix for a measured bug: after two mints,
   * discarding the newer one left the older mint's step and file both alive
   * while the archive went null, so the catalogue held an openable book that
   * nothing named. A minted-to-pages project filed no chain at all
   * (`documentArchive`), which would put it straight back into that state —
   * with the older mint's directory, hundreds of megabytes of it, still there.
   *
   * The ledger answers the same question for it, by the same rule
   * `currentBookStep` uses: a step carrying an ARRANGEMENT is a mint, and the
   * newest surviving one is the book on the shelf. It runs AFTER
   * `manifest.ledger` has been replaced by the surviving ledger, so the steps
   * being walked are the ones that are left.
   *
   * TRANSITIONAL SINCE WAVE 41, and kept rather than retired on purpose. A mint
   * files its PDF onto the `pdf` chain now, so a discard of one takes the
   * ordinary walk below and this arm is unreachable for anything minted today.
   * It stays because a project can be discarded from between its launch and its
   * heal — and because the bug it fixes costs hundreds of megabytes and a
   * catalogue that lies, which is a bad thing to re-earn for a saved branch.
   */
  if (dying.kind === 'pages') {
    const steps = ledgerOf(manifest).steps;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (typeof step.params?.['arrangement'] !== 'string') continue;
      const parts = step.payload.split('/');
      if (parts.length !== 2 || parts[0] !== ARCHIVE) continue;
      const file = parts[1]!;
      const onDisk = path.join(resolved, ARCHIVE, file);
      if (!await exists(onDisk)) continue;
      return {
        file,
        kind: 'pages',
        contentKey: await pagesKey(onDisk, step.params['arrangement']),
        originPath: dying.originPath,
      };
    }
    return null;
  }
  const chain = manifest.documents.find((row) => row.kind === dying.kind)?.steps ?? [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const parts = chain[index]!.file.split('/');
    if (parts.length !== 2 || parts[0] !== ARCHIVE) continue;
    const file = parts[1]!;
    const onDisk = path.join(resolved, ARCHIVE, file);
    if (!await exists(onDisk)) continue;
    return {
      file,
      kind: dying.kind,
      contentKey: createHash('sha256').update(await fsp.readFile(onDisk)).digest('hex').slice(0, 8),
      originPath: dying.originPath,
    };
  }
  return null;
}

export async function deleteStep(dir: string, stepId: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const { view, orphans, sweeps } = await withManifest(resolved, async (manifest) => {
    const deletion = deleteSubtree(ledgerOf(manifest), stepId);
    const banks = new Set(orphanedBanks(deletion, manifest.key));
    const destroyed = destroyedBy(deletion, manifest.key);
    const planned = await planStepSweep(resolved, destroyed, banks, manifest, deletion.removed);
    manifest.ledger = deletion.ledger;
    manifest.documents = chainsWithout(manifest.documents, destroyed);
    /*
     * ── THE ARCHIVE GOES WITH ITS FILE, AND THE LIVE COPY GOES WITH BOTH ───
     *
     * `recordMint` sets `manifest.archive` and the minted step inside one
     * `withManifest` precisely so "a project can never hold one without the
     * other" — and until now the delete broke that promise from the far side,
     * taking the step and the file and leaving the archive naming both.
     *
     * WHAT THAT COST IS NOT A STALE FIELD. `listProjects` falls back to the
     * archive when a project lists no documents — a rescue for a project whose
     * file is real but unlisted — so emptying `documents` is exactly what
     * switches the fallback on. It rebuilt an origin row out of the dead
     * archive, Home went on showing a PDF, and a capture project could never
     * get its light table back however much was discarded.
     *
     * REACHABLE ONLY SINCE WAVE 20, which is why it sat here unfound: in an
     * imported project the origin step IS the root, and `deleteSubtree` refuses
     * the root by name, so nothing could ever destroy the archived file. A
     * capture project is the first whose root is something else — the
     * photographs — which made the archive deletable for the first time.
     *
     * The live copy in `working/` goes too. It was made FROM the payload that
     * has just been destroyed, so leaving it is leaving a book in the folder
     * that no step names and nothing can explain — `planSweep` takes rotated
     * predecessors and unpacked trees, not this, because until now no delete
     * could reach a file a working row was made from.
     */
    const razed = new Set(destroyed);
    if (manifest.archive !== null && razed.has(`${ARCHIVE}/${manifest.archive.file}`)) {
      /*
       * ── RE-POINTED RATHER THAN NULLED, WHICH IS THE OTHER HALF OF THE FIX ──
       *
       * Nulling it repaired the one-mint case and broke the two-mint one. After
       * mint, Mint again, delete-the-newest, the OLDER mint's step and file both
       * survive and the catalogue goes on listing it: Home shows a book, marks
       * it present, and opens it. Measured. So a null archive left this manifest
       * holding a listed, openable PDF with nothing naming it — `recordMint`'s
       * promise ("a project can never hold one without the other") broken again,
       * by the line written to restore it.
       *
       * The visible cost was on the row: `reading.needed` keys off
       * `archive?.kind === 'pdf'`, so the project stopped advertising that a
       * real unread book needed reading. Right when the file is gone, wrong when
       * a survivor is still there — one line, and which case it met decided
       * whether it was a fix.
       *
       * So the archive follows the catalogue: the newest surviving `archive/`
       * entry on the same chain, freshly keyed off the bytes that are actually
       * there, and null only when nothing is left — which is a genuinely empty
       * shelf and is what the one-mint discard still gets.
       */
      manifest.archive = await archiveAfterLoss(resolved, manifest, manifest.archive);
    }
    const orphanedCopies = manifest.working.files.filter((row) => razed.has(row.from));
    manifest.working.files = manifest.working.files.filter((row) => !razed.has(row.from));
    await writeManifest(resolved, manifest);
    return {
      // Composed here for `viewOf`'s reason, and this is the call that most
      // needs it: a delete is the one gesture that can MOVE the current book,
      // by destroying the file the catalogue's chain tip named.
      view: viewOf(manifest, deletion.ledger),
      orphans: destroyed,
      sweeps: [...planned, ...orphanedCopies.map((row) => ({
        ...emptySweep(),
        files: [path.join(resolved, WORKING, row.file)],
      }))],
    };
  });
  for (const payload of orphans) {
    try {
      await destroyPayload(resolved, payload);
    } catch (err) {
      console.error(
        `[projects] ${path.basename(resolved)}: ${payload} was deleted from this project's history `
        + `and could not be removed from the disk (${(err as Error).message}). Nothing in Foundry `
        + 'names that file any more; it is still in the project folder.',
      );
    }
  }
  // `force: true` throughout and no throw, for `deleteDocument`'s reason and this
  // function's own: by the time this runs the delete has happened as far as the
  // catalogue is concerned, and failing the call would tell the user their delete
  // did not work while leaving it done.
  for (const sweep of sweeps) {
    for (const target of sweep.files) await fsp.rm(target, { force: true });
    // An `archived-<stamp>/` folder that held nothing but this payload's past goes
    // with it. Emptiness is the test rather than "we emptied it", because a folder
    // made before `stampedArchive` began naming them after the run can hold a
    // sibling's work stamped in the same second — somebody else's record.
    for (const archive of sweep.archives) {
      try {
        const left = await fsp.readdir(archive);
        if (left.length === 0) await fsp.rmdir(archive);
      } catch { /* already gone, or not ours to force */ }
    }
  }
  announceProjects();
  return view;
}
