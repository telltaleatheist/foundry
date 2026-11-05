/**
 * projects-steps — the step ledger on disk: the folders a step owns, landing a step, and moving between steps.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { LedgerStep, ProjectLedger, ProjectManifest, StepLedgerView } from '../shared/types';
import { analysisTarget, chronological, emptyLedger, id8, originStep, positionOf, recordLanding, stepOf, type LandedRun, type Landing } from '../shared/ledger';
import { deletableProjectDir } from './projects-delete';
import { announceProjects, exists, readManifest, withManifest, writeManifest } from './projects-manifest';
import { ANALYSIS, CURATIONS, MANIFEST, METADATA, OPS } from './projects-paths';

// ─────────────────────────────────────────────────────────────────────────────
// The step ledger, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A manifest's ledger, never undefined.
 *
 * `readManifest` sets the field on every project it returns — migrated when the
 * file has none — so the optional in `ProjectManifest` describes the FILE FORMAT
 * rather than anything a caller in this process can be handed. This is the one
 * place that says so, instead of `?? emptyLedger()` at every call site, where the
 * fallback would eventually be read as "a ledger is sometimes absent" and
 * somebody would write a branch for it.
 */
export function ledgerOf(manifest: ProjectManifest): ProjectLedger {
  return manifest.ledger ?? emptyLedger();
}

/**
 * The origin, with a uuid: this module has the clock and the randomness
 * `shared/ledger.ts` deliberately does without.
 *
 * NO POINTER, which means the newest step — and with one step in the ledger that
 * is this one. Writing it out would be recording a fact the array already
 * implies, in a folder people sync.
 */
export function originLedger(payload: string, label: string, createdAt: number): ProjectLedger {
  return { steps: [originStep(randomUUID(), payload, Math.max(0, Math.trunc(createdAt)), label)] };
}

/**
 * `<project>/curations/` — the frozen snapshots of the block editor's overlay.
 *
 * A SEVENTH SIBLING, on `overlays/`'s precedent and NOT inside it, which is the
 * decision worth writing down. `overlays/` held the live pair and its archive
 * folders, and everything that walked it treated what it found there as one
 * book's current curation and its discarded predecessors — the
 * archive-on-generation-mismatch machinery went with the overlay system
 * (docs/RENDERER.md §7), and `countAmendments` still walks the legacy folder so
 * the delete card counts a v1 project's work. A snapshot is neither of those
 * things: it is a RETAINED PAYLOAD, named by a step, deleted only when that step
 * is, and never archived aside because it was never bound to the live file's
 * fate. Filing it under `overlays/` would have put it in the path of a sweep
 * whose entire premise was that what it finds there is disposable.
 *
 * `<uuid>.json` rather than a name anybody reads: the step's LABEL is what a
 * person sees ("Applied changes (23)"), and a filename that tried to say the
 * same thing would be a second place for it to be said differently.
 */
export function curationsDir(dir: string): string {
  return path.join(dir, CURATIONS);
}

/**
 * `<project>/metadata/` — the patches a metadata step retained, one per Apply.
 *
 * AN EIGHTH SIBLING, on `curations/`'s precedent and for the identical argument.
 * A patch is a RETAINED PAYLOAD: named by a step, deleted only when that step is,
 * never archived aside, and — the part that decides the folder — READ AGAIN LONG
 * AFTER IT WAS WRITTEN, because every export replays the chain of them
 * (`metadataInEffect`). Nothing in this app may treat what it finds here as
 * disposable, which is exactly what a sweep of `working/` or `overlays/` assumes
 * about its contents.
 *
 * `<uuid>.json` rather than a name anybody reads, for `curationsDir`'s reason:
 * the step's LABEL is what a person sees ("Metadata (title, author)"), and a
 * filename that tried to say the same thing would be a second place for it to be
 * said differently.
 */
export function metadataDir(dir: string): string {
  return path.join(dir, METADATA);
}

/**
 * `<project>/ops/` — the changes each Apply on the book wrote, one file per step.
 *
 * A NINTH SIBLING, on `curations/`' and `metadata/`'s precedent and for the
 * identical argument, with one clause of it sharper than either. An ops file is a
 * RETAINED PAYLOAD: named by a step, deleted only when that step is, never
 * archived aside — and READ AGAIN EVERY TIME THE BOOK IS OPENED, because standing
 * anywhere means replaying the ops of every edit step on the path
 * (docs/RENDERER.md §3). Nothing in this app may treat what it finds here as
 * disposable, which is exactly what a sweep of `working/` or `overlays/` assumes
 * about its contents.
 *
 * `<id8>.jsonl` — the front of the step's own uuid, which is the scheme a branch
 * read and a branch translation already name their files with (`id8`,
 * shared/ledger.ts). Not a name anybody reads, for `curationsDir`'s reason: the
 * step's LABEL is what a person sees ("Applied changes (5)"), and a filename
 * trying to say the same thing would be a second place for it to be said
 * differently. Not the whole uuid either, because these sit beside each other in
 * one folder and eight hex is already how this project distinguishes a branch's
 * files from the trunk's.
 */
export function opsDir(dir: string): string {
  return path.join(dir, OPS);
}

/**
 * The PROJECT-RELATIVE payload an edit step names, composed in the ONE place that
 * knows the spelling.
 *
 * Forward slashes, as every payload is (`LedgerStep.payload`): the ledger's
 * spelling of a path is not this platform's, and a row carrying a backslash is a
 * row no other machine could resolve. The step id is minted before the file is
 * written — the reading's arrangement (`ReadRequest.stepId`), for its reason: the
 * file is named after a row that does not exist yet, and minting a second id at
 * the landing would leave it named after a step nobody created.
 */
export function opsPayloadFor(stepId: string): string {
  return `${OPS}/${id8(stepId)}.jsonl`;
}

/**
 * `<project>/analysis/` — one report per analysis step. See the `ANALYSIS`
 * constant for what lives here and why nothing sweeps it.
 */
export function analysisDir(dir: string): string {
  return path.join(dir, ANALYSIS);
}

/**
 * WHICH REPORT AN ANALYSIS ORDERED FROM HERE WOULD WRITE, and which step it
 * belongs to — the plan's half of the question the landing will ask again.
 *
 * `recordsForTextPass`'s shape and its whole argument: the engine is handed a
 * path and writes into it for an hour, so "is this the report that already
 * exists, or a new one beside it?" has to be settled before the job is enqueued
 * or the file and the row would describe different analyses. `analysisTarget`
 * (shared/ledger.ts) is the one place that question is answered, asked here with
 * the position as the parent because the dialog asks for an analysis OF what is
 * on screen.
 *
 * THE DIRECTORY IS MADE HERE and the file is not. A report is written by the
 * engine, and a plan that touched the file would leave one named by no step if
 * the held job were removed — `planTranslation`'s rule about seeding at spawn
 * rather than at plan, applied to an empty file instead of a copied one.
 */
export async function reportForAnalysis(
  dir: string,
  categories: readonly string[],
): Promise<{ outputPath: string; payload: string; stepId: string }> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const target = analysisTarget(
    ledger,
    { parent: positionOf(ledger)?.id ?? null, categories },
    randomUUID(),
  );
  await fsp.mkdir(analysisDir(dir), { recursive: true });
  return {
    outputPath: path.join(dir, ...target.report.split('/')),
    payload: target.report,
    stepId: target.stepId,
  };
}

/**
 * A finished action, recorded against an OPEN manifest. The caller writes.
 *
 * ── The parent, and the two ways it can be wrong ────────────────────────────
 *
 * `parent` is the position captured when the job was ENQUEUED (`Job.parentStep`),
 * which is the whole reason it is an argument rather than something read here: a
 * pointer move while a job sits held must not silently retarget it. Null means
 * nobody captured one — a curation commit, which happens now and therefore has no
 * gap to be wrong across, or a job from a build that predates the field — and
 * then the position at this instant is the honest answer.
 *
 * A CAPTURED PARENT THAT IS NO LONGER THERE FALLS BACK TO THE POSITION rather
 * than refusing. The step it named was deleted while the run was going, and the
 * alternative to falling back is throwing away the payload of a job that has
 * already finished in order to protect the shape of a list. The list is
 * recoverable; three hours of GPU are not — the same call `appendStep` makes when
 * a clock steps backwards, for the same reason.
 *
 * RETURNS NULL FOR A LEDGER WITH NO STEPS, which is not an error either. A
 * project adopted out of the old flat workspace can have outputs and no import,
 * so there is no origin for anything to hang from, and inventing a parentless
 * `read` would give that project a history whose first act was reading a book
 * nobody can see was imported.
 */
export async function landStep(
  manifest: ProjectManifest,
  run: Omit<LandedRun, 'id' | 'parent'> & {
    parent: string | null;
    /**
     * THE ID, WHEN THE CALLER ALREADY SPENT IT ON SOMETHING. A reading's bank is
     * named after the step it belongs to (`bankForReading`), so that id was minted
     * hours ago at the plan and has been written into a filename since — minting a
     * second one here would leave the file named after a step nobody created. Every
     * other landing has nothing riding on the id and lets this mint one.
     *
     * It is spent only on an append either way, which is `LandedRun.id`'s own rule.
     */
    id?: string;
  },
): Promise<Landing | null> {
  const ledger = ledgerOf(manifest);
  const standing = positionOf(ledger);
  if (standing === null) return null;
  const captured = run.parent !== null && ledger.steps.some((step) => step.id === run.parent)
    ? run.parent
    : standing.id;
  const landing = recordLanding(ledger, { ...run, parent: captured, id: run.id ?? randomUUID() });
  manifest.ledger = landing.ledger;
  return landing;
}

/**
 * Destroy a payload the ledger no longer names. After the write, never before.
 *
 * `force` so a payload that is already gone — a bank the user deleted by hand, a
 * rendering that never landed — finishes the delete rather than refusing it: what
 * is being removed is the app's claim to own the file, and being generous about a
 * file that has already left is not being generous about which file this is. The
 * path is composed from the project directory and the step's own PROJECT-RELATIVE
 * payload, split on the forward slashes the format stores, so nothing here ever
 * matches a file by its basename.
 */
export async function destroyPayload(dir: string, payload: string): Promise<void> {
  const target = path.join(dir, ...payload.split('/'));
  /*
   * `recursive` IS DECIDED BY WHAT IS THERE, and it is deliberately not just
   * `true`. A payload has always been one file, and `recursive: false` was the
   * guard that said so: a payload that turned out to name a directory was a
   * bookkeeping fault worth failing on rather than a licence to empty a folder.
   *
   * A MINT'S PAYLOAD WAS A DIRECTORY between `ecbf238` and Wave 41, so that
   * guard became the thing that stranded one. Left as it was, discarding a mint
   * logged "could not be removed from the disk" and left several hundred
   * megabytes of page images that nothing in Foundry named — the exact orphan the
   * guard existed to make visible, produced by the guard.
   *
   * A MINT'S PAYLOAD IS A PDF AGAIN and the question below is answered `false`
   * for it. The disk-asking survives because an unhealed project's mint step
   * still names a folder until its heal lands, and because it is a better rule
   * than the one it replaced: a payload's NAME says nothing about what it is.
   *
   * So the question is asked of the disk instead: a folder is removed as a
   * folder, and anything else keeps the old refusal. `stat` rather than a test
   * on the name, because a payload's name says nothing about what it is.
   */
  const folder = await fsp.stat(target).then((it) => it.isDirectory()).catch(() => false);
  await fsp.rm(target, { force: true, recursive: folder });
}

/**
 * The steps and the flat list the accordion draws, in one answer.
 *
 * EVERY CALL THAT CHANGES A LEDGER ANSWERS WITH THIS, and that is a correction
 * rather than a convenience. Three of them used to hand back a bare
 * `ProjectLedger` — the pointer move, the delete and the commit — and the rows
 * are MAIN'S TO COMPOSE (`chronological`, and the "from …" annotation is the one
 * concession this design makes to the tree), so the renderer had to ask again
 * after every one of them. A second round trip is a second answer, composed a
 * moment later, about a catalogue that may have moved: the window either drew a
 * list from before its own gesture or painted twice. What a caller gets back now
 * is the whole answer to what it just did.
 */
export type LedgerView = StepLedgerView;

/**
 * One project's history, as the library needs it.
 *
 * The path is PROVEN to be a project before a byte is read — `deletableProjectDir`
 * — because every call in this family takes a directory named by the renderer and
 * one of them unlinks files. The gate is the same one on every member so that none
 * of them is the lenient way in.
 *
 * NULL FOR A PROJECT THAT IS GONE, and only for gone. The window re-reads every
 * ledger it holds on `projects:changed`, and a delete IS a `projects:changed` —
 * so the one guaranteed reader of a just-deleted project is this function, asked
 * in good faith by a mirror that has not yet heard. That read used to throw
 * ENOENT into the console on every announce for the rest of the session. "It no
 * longer exists" is a state, not an exception; the caller drops its holding and
 * stops asking. A manifest that EXISTS but will not parse still throws — that is
 * a book somebody needs to fix a file for, and silence would bury it.
 */
/**
 * WHICH STEP THE BOOK ON THE SHELF CAME FROM — one resolution, two surfaces.
 *
 * ── What "the book on the shelf" turned out to mean, measured ───────────────
 *
 * Three candidates were proposed and two were wrong, each in a way no typecheck
 * could see:
 *
 *   the newest mint step   wrong after a delete of a NEWER mint: it is right
 *                          here by luck, and it is a second derivation of a
 *                          question the catalogue already answers
 *   `manifest.archive`     wrong TWICE. A delete that destroys the file it names
 *                          nulls it while an older mint and its file survive and
 *                          Home goes on listing them (documents 1, missing
 *                          false, the file really there) — so the sentence would
 *                          go silent over a real difference. And after a
 *                          searchable conversion the archive still names the
 *                          MINT while the shelf shows the converted book
 *   the pdf CHAIN          right, and it is what the catalogue means by this
 *                          book's history: `documents[kind=pdf].steps`, oldest
 *                          first
 *
 * Home opens `working/<stem>.pdf` — the LIVE copy — in every state where one
 * exists, and falls back to the origin when it does not. The live copy is made
 * from the chain's tip (measured: a searchable conversion moves the working
 * row's `from` onto `generated/<stem>.pdf`), so the tip is the handle on the
 * book a person is actually looking at.
 *
 * ── Why it WALKS DOWN rather than reading the tip alone ─────────────────────
 *
 * A conversion appends to this same chain and lands above the mint — measured,
 * not read: `recordGenerated` puts `generated/<stem>.pdf` at the tip with kind
 * `convert`, and no ledger step names it. Reading the tip alone would therefore
 * answer "nothing" for a project that has been carried FURTHEST, and the
 * sentence would work for a book somebody stopped after minting and stop
 * working for one they finished.
 *
 * So the tip decides WHICH BOOK, and the nearest step at or below it carrying an
 * arrangement decides WHAT IT WAS MADE FROM. A searchable PDF made from mint B
 * really was minted from B's arrangement, and saying so stays true.
 *
 * NO KIND-SNIFFING ANYWHERE IN HERE (ruled): it does not ask whether a step is a
 * mint, a conversion or an import — it asks which chain entry a ledger step
 * names, and steps that carry an arrangement are mints because only a mint
 * records one. A test on `action` or on a label would be a second spelling of
 * "is this a mint", free to drift from `mintedStep` the day another action
 * starts recording one.
 *
 * Null when the chain holds nothing a ledger step names, which is a genuinely
 * empty shelf and an imported book alike — silence, as ruled, because nothing
 * can be honestly claimed either way.
 */
export function currentBookStep(manifest: ProjectManifest, ledger: ProjectLedger): LedgerStep | null {
  const chain = manifest.documents.find((row) => row.kind === 'pdf')?.steps ?? [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const named = chain[index]!.file;
    const step = ledger.steps.find((row) => row.payload === named);
    if (step !== undefined) return step;
  }
  /*
   * ── A BOOK WITH NO CHAIN TO WALK, WHICH IS EVERY MINTED-TO-PAGES PROJECT ───
   *
   * The walk above asks the PDF's chain which files exist and then asks the
   * ledger which step made each one. A mint that writes pages files no document
   * at all (`documentArchive`), so the chain is empty and the walk answers
   * null — and it answers null for a project that HAS been minted, twice, which
   * is the loudest thing this function can get wrong while looking correct.
   *
   * WHAT IT COSTS IF IT IS WRONG, because it is not obvious from here: this is
   * `LedgerView.current`, and `currentArrangement` is built on it. Null means
   * the renderer's `mintedFrom` is null, which means THE DIVERGENCE SENTENCE
   * NEVER APPEARS AGAIN and the mint button never says "Generate book again" — a
   * feature quietly un-shipping itself with nothing on screen to say so.
   *
   * SO THE LEDGER IS ASKED DIRECTLY, and the test is the one this function
   * already trusts one paragraph up: a step carrying an ARRANGEMENT is a mint,
   * because only a mint records one. No kind-sniffing, no test on an action or a
   * label — the same rule, applied where there is no chain to apply it through.
   * The newest such step is the book on the shelf, exactly as the chain's tip is.
   */
  for (let index = ledger.steps.length - 1; index >= 0; index -= 1) {
    const step = ledger.steps[index]!;
    if (typeof step.params?.['arrangement'] === 'string') return step;
  }
  return null;
}

/**
 * The view, composed where the manifest is still in hand.
 *
 * Every `LedgerView` in this file goes through here, because `current` cannot be
 * derived from the ledger alone — it needs the catalogue's chain — and a second
 * composition site would be a view that forgot to answer the question.
 */
export function viewOf(manifest: ProjectManifest, ledger: ProjectLedger = ledgerOf(manifest)): LedgerView {
  return {
    ledger,
    rows: chronological(ledger),
    current: currentBookStep(manifest, ledger)?.id ?? null,
  };
}

/**
 * WHAT THE BOOK ON THE SHELF WAS MINTED FROM, for the light table's footer.
 *
 * The other half of `currentBookStep`, exported as its own door so that the
 * sentence and the row marker are one resolution rather than two — the light
 * table has no ledger view to read `current` off, and a second walk composed in
 * `capture.ts` would be the two-things-one-name defect arriving in the feature
 * built to stop it.
 *
 * NULL IS SILENCE, and it means three different true things: no book on the
 * shelf, a book that predates the field, or a book this app did not mint. None
 * of them can honestly claim the recipe has or has not moved on, and the footer
 * says nothing for all three.
 */
export async function currentArrangement(dir: string): Promise<string | null> {
  const resolved = deletableProjectDir(dir);
  if (!await exists(path.join(resolved, MANIFEST))) return null;
  const manifest = await readManifest(resolved);
  return currentBookStep(manifest, ledgerOf(manifest))?.params?.arrangement ?? null;
}

export async function readStepLedger(dir: string): Promise<LedgerView | null> {
  const proven = deletableProjectDir(dir);
  if (!await exists(path.join(proven, MANIFEST))) return null;
  const manifest = await readManifest(proven);
  return viewOf(manifest);
}

/**
 * Stand on a different step.
 *
 * FREE, AND THE FREENESS IS THE FEATURE. Clicking a row in a history panel is a
 * gesture every user of every history panel believes costs nothing, and here it
 * genuinely does: one manifest write, no job, no rendering, no file touched. What
 * it changes is what the viewers show and what the next action is made from.
 *
 * `stepOf` refuses an id this ledger does not hold, by name. A pointer that has
 * come loose is not something to fall back from quietly — the caller named a row
 * the app drew, so an id that is not there means the two are looking at different
 * ledgers, and the honest answer is to say so.
 */
export async function goToStep(dir: string, stepId: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  // Composed INSIDE, where the manifest is still in hand: `current` reads the
  // catalogue's chain and the ledger alone cannot answer it.
  const view = await withManifest(resolved, async (manifest) => {
    const standing = stepOf(ledgerOf(manifest), stepId);
    const next: ProjectLedger = { ...ledgerOf(manifest), position: standing.id };
    manifest.ledger = next;
    await writeManifest(resolved, manifest);
    return viewOf(manifest, next);
  });
  // The tabs of this project repaint from the position, and Home's rows are
  // derived from what the ledger calls current. Both hear about it the one way
  // anything in this app hears that a project moved.
  announceProjects();
  // The rows are the same rows — a pointer move changes no step and no order —
  // and they are composed again anyway, because a caller that had to know which
  // of these answers is worth redrawing would be a caller deriving the list.
  return view;
}
