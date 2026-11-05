/**
 * projects-planning — finding what a run should read from: the newest of a chain, the bank, the records of a text pass.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { LedgerStep, ProjectFacsimile, ProjectLedger, ProjectManifest, RewriteMode } from '../shared/types';
import { A_BOOK_OF_ITS_OWN, askedOf, facsimileFile, id8, documentOriginOf, pendingRecordsFileFor, positionOf, reRunTarget, translationTarget, type ReadAsk } from '../shared/ledger';
import { readingBank } from './projects-files';
import { completionMarkerFor } from './projects-landing';
import { reconcileLivePdf } from './projects-list';
import { exists, readManifest } from './projects-manifest';
import { GENERATED, READINGS, WORKING } from './projects-paths';
import { stepsOf } from './projects-rotation';
import { ledgerOf } from './projects-steps';

/**
 * The last step this ledger holds that answers a question, or null for none.
 *
 * THE ARRAY'S ORDER IS THE CHRONOLOGY, which is the ledger's own rule rather than
 * a convenience taken here: `parseLedger` refuses a file whose rows run backwards
 * and `chronological` draws the list in this order, so "the last one matching" and
 * "the newest one matching" are the same sentence. Re-sorting by `createdAt`
 * instead would let two rows stamped in one millisecond swap places between
 * repaints, and the pointer would land on a different row for the same click.
 */
export function newestWhere(
  ledger: ProjectLedger,
  wanted: (step: LedgerStep) => boolean,
): LedgerStep | null {
  let newest: LedgerStep | null = null;
  for (const step of ledger.steps) if (wanted(step)) newest = step;
  return newest;
}

/**
 * The newest step of the chain that shows one book: this step, and the descendants
 * that are still about the same document.
 *
 * WALKED DOWNWARD THROUGH A CHILDREN MAP, on `subtree`'s reasoning and not merely
 * in imitation of it: a single forward pass over the array assumes every parent is
 * listed before its child, which is an invariant `appendStep` happens to produce
 * and the file format does not promise, and a grandchild missed here is a pointer
 * that lands one row short of where the user is looking.
 *
 * THE WALK STOPS AT A STEP THAT RETAINED A DOCUMENT. A translation hangs off the
 * reading it was made from and is a different book at a different path; including
 * it would make "the newest step of the reading's chain" answer with a row whose
 * own document is not the one that was handed in.
 */
export function newestOfChain(ledger: ProjectLedger, from: LedgerStep): LedgerStep {
  const children = new Map<string, LedgerStep[]>();
  for (const step of ledger.steps) {
    if (step.parent === null) continue;
    children.set(step.parent, [...(children.get(step.parent) ?? []), step]);
  }
  const kept = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const step = pending.pop()!;
    if (kept.has(step.id)) continue;
    kept.add(step.id);
    for (const child of children.get(step.id) ?? []) {
      if (A_BOOK_OF_ITS_OWN[child.action]) continue;
      pending.push(child);
    }
  }
  return newestWhere(ledger, (step) => kept.has(step.id)) ?? from;
}

/**
 * The flowing book this project holds — `generated/<stem>.epub`, project-relative
 * — or null for a project that has none.
 *
 * ── What "the cast" is, among four things that share a chain ────────────────
 *
 * The EPUB's chain can hold four kinds of row and only one of them is the book the
 * reading made. A `translate` step is the book in another language. An `origin`
 * marked `irreplaceable` is a book the USER imported, which no reading produced
 * and which a read row must never claim. And a rotated predecessor is still in the
 * chain, at the path it was moved to (`rotateGenerated`) — it is a previous cast,
 * it is on disk, and it is not what a person standing on the reading means.
 *
 * So the test is all three of those said out loud: an `origin` row, not
 * irreplaceable, and sitting DIRECTLY in `generated/` rather than in an archive
 * folder under it. The last clause is the house rule doing real work — a rotated
 * cast's payload is `generated/archived-<stamp>/<name>.epub`, which starts with
 * `generated/` and is emphatically not the live one, so the segment count is
 * checked rather than the prefix alone.
 *
 * NEWEST WINS where a chain somehow holds two, by `appliedAt` and not by array
 * order: `recordStep` appends, which makes the array chronological in every
 * ordinary life of a project, and `summarise` sorts the same way for the same
 * reason — a chain read out of a catalogue somebody edited or a migration composed
 * is not guaranteed to be.
 */
/**
 * The page-for-page reprint ONE READ STEP made of its own pages,
 * project-relative — a name, never a promise that the file is there.
 *
 * THE ONE ACTION LEFT THAT PRODUCES A DOCUMENT NOBODY ASKED FOR — the per-step
 * casts a save and a translation used to leave are deleted (docs/RENDERER.md §7)
 * and both rows are answered by the proof sheet. It is a RENDERING: `vlm-convert --format pdf` over
 * a bank that is already complete, free, offline, made again at any time, and
 * emphatically NOT a row in `manifest.documents`. Cataloguing it would do the
 * same active harm cataloguing a save's book would, one type over — the PDF
 * chain is where the SCAN lives, and a facsimile filed onto it would put the
 * reprint where Home means "the book you imported" and would offer it as the
 * document this app edits.
 *
 * WHICH LEAVES THE SAME OBLIGATION, discharged in the same place: a file nothing
 * catalogues is a file nothing would ever remove, so `castsAmong` composes this
 * name when a read step is deleted and the sweep takes it — along with any
 * predecessor a re-read rotated aside, which `planSweep` finds beside it.
 */
export function facsimileForReadStep(manifest: ProjectManifest, step: LedgerStep): string {
  return `${GENERATED}/${facsimileFile(manifest.stem, step.id)}`;
}

/**
 * Every facsimile this project's readings actually have on disk —
 * `ProjectSummary.facsimiles`.
 *
 * THE ONE PLACE THAT STATS. It draws a ROW, and a row for a file that is not
 * there is a nav offering something to click that opens nothing. Every project read before facsimiles existed is in exactly that
 * state, and it is the ordinary state rather than an error — the reading is
 * complete, the bank is on disk, and a facsimile of it is one export away.
 */
export async function facsimilesOf(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectFacsimile[]> {
  const made: ProjectFacsimile[] = [];
  for (const step of ledgerOf(manifest).steps) {
    if (step.action !== 'read') continue;
    const file = facsimileForReadStep(manifest, step);
    if (!await exists(path.join(dir, ...file.split('/')))) continue;
    // The READING's own moment. See `ProjectSummary.facsimiles`: the file is the
    // reading's product and is remade whenever the reading is, so its date is
    // that reading's, and an mtime here would be a second opinion about when
    // something in this book's history happened.
    made.push({ file, madeAt: step.createdAt });
  }
  return made;
}

/**
 * The project's own working copy of an archived file, project-relative, or null
 * when the archive is all there is.
 *
 * COMPARED BY THE WHOLE PROJECT-RELATIVE PATH and never by basename, which is this
 * codebase's oldest house rule and is load-bearing here of all places: a project
 * holds `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf` at once,
 * and matching on the last segment would call the reprint a copy of the scan.
 *
 * The two kinds keep their copies in different layers because they are different
 * arrangements, not because anything is inconsistent: a PDF's live copy is
 * `working/<stem>.pdf`, catalogued in `working.files` with the layer it came from
 * — the one thing under `working/` that outlived the unpacked trees, because it is
 * the copy the metadata dialog writes into; an EPUB's is the STAMPED copy in
 * `generated/`, recorded as that type's own origin step (`importDocument`).
 */
export async function liveCopyOf(
  dir: string,
  manifest: ProjectManifest,
  archived: string,
): Promise<string | null> {
  if (manifest.archive?.kind === 'epub') {
    const origin = stepsOf(manifest, 'epub')[0];
    return origin !== undefined
      && origin.retention === 'irreplaceable'
      && origin.file.startsWith(`${GENERATED}/`)
      ? origin.file
      : null;
  }
  const live = await reconcileLivePdf(dir, manifest);
  return live !== null && live.from === archived ? `${WORKING}/${live.file}` : null;
}

/** A project-relative payload as an absolute path, or null when it is not there. */
export async function onDisk(dir: string, relative: string): Promise<string | null> {
  const resolved = path.join(dir, ...relative.split('/'));
  return await exists(resolved) ? resolved : null;
}

/**
 * Whether the bank AT THE POSITION carries the engine's completion marker — the
 * one fact that makes a rendering free.
 *
 * ── What a caller is actually asking ────────────────────────────────────────
 *
 * `replaysCompletedBank` (src/vlm/read.ts) is true for `--reuse-readings` over a
 * marked bank and false for everything else, and it is what the engine's own argv
 * layer asks before it refuses a run for having no reading backend. So a marker
 * beside the bank is exactly "this run will read no pages and needs no server",
 * and its absence is "this run intends to read whatever is missing" — a resume,
 * which needs a vLLM the pipeline has no business standing up in the middle of a
 * two-stage Generate.
 *
 * EXISTENCE AND NOT THE STAMP, which `markerStamp` below answers for a different
 * question. That one parses `completedAt` because the generation ruling compares
 * instants; this one must agree with the ENGINE's test, and the engine's test is
 * whether the marker is there. A marker this app could not parse would otherwise
 * refuse a Generate the engine would have run perfectly well.
 *
 * `completionMarkerFor` rather than the name composed a second time here: two
 * spellings of one file is two answers the day either of them changes.
 */
export async function readingIsComplete(
  dir: string,
  manifest: ProjectManifest,
  /**
   * THE STEP TO ASK ABOUT, when the question is about one rather than about the
   * position — see `readingBank`, whose argument this is passed straight through
   * to, and `planFacsimile`, which is why either of them takes one.
   *
   * A test that asked the POSITION while its caller named the STEP'S bank would be
   * the two disagreeing in the one window where a project holds two readings: the
   * plan cleared by a marker beside bank B and then replaying bank A. One argument,
   * one bank, one answer.
   */
  at: LedgerStep | null = null,
): Promise<boolean> {
  return exists(completionMarkerFor(readingBank(dir, manifest, at)));
}

/** A bank an OCR run will fill, and the step it belongs to. See `planReading`. */
export interface PlannedBank {
  /** Absolute. What the engine is handed as `--readings`. */
  readingsPath: string;
  /** `LandedRun.id` for this run: an existing step on a replace, minted on a branch. */
  stepId: string;
}

/**
 * WHERE THIS READING'S ANSWERS GO, decided before the job is enqueued.
 *
 * ── Why the path cannot wait for the landing ────────────────────────────────
 *
 * The engine is handed one path and writes into it for three hours. By the time
 * anything lands there is nothing left to decide — so the question "is this
 * reading the one that already exists, or a new one beside it?" has to be
 * answered here, at the plan, and answered the SAME WAY the landing will answer
 * it or the file and the row will describe different readings.
 *
 * It is the same question, asked of the same function, with the same three
 * arguments the landing uses:
 *
 *   THE ACTION is `read`, obviously.
 *
 *   THE PARENT IS THE ORIGIN, never the position. A reading reads the PIXELS,
 *   which live in `archive/` however far through their own history the person
 *   pressing OCR happens to be standing — the reading-parents-at-origin rule, and
 *   `recordReading` obeys it too (see `originOf` in shared/ledger.ts for what
 *   parenting it at the position would cost).
 *
 *   THE PARAMS ARE WHAT THE DIALOG ASKED, normalised by `askedOf` rather than
 *   trimmed here, precisely so the two askings cannot come to disagree about
 *   whether a blank box is a page range.
 *
 * ── The three answers ───────────────────────────────────────────────────────
 *
 * A REPLACE aims at the target step's existing payload. Same step, same path, new
 * contents — which is what `recordLanding` already says about the row, now true
 * of the file as well. The engine writes a pending bank beside it and swaps on
 * success (docs/BANK-LIFECYCLE.md §2), so the old answers survive a failed run.
 *
 * A FIRST READING keeps `readings/<key>.jsonl`. That is what every project on
 * every disk already has, and the whole reason this scheme needs no migration.
 *
 * A BRANCH mints `readings/<key>.<id8>.jsonl`, `id8` being the front of the
 * step's own uuid. Deterministic, collision-free, and never shown to a person —
 * filenames are out of the UI, the row's name comes from `labelFor`. An ordinal
 * would read better in Explorer and would be a second counter to keep consistent
 * with the ledger; the uuid is already minted and already unique.
 *
 * THE ID IS MINTED HERE AND ONLY HERE, and travels on the request to the landing
 * (`ReadRequest.stepId`). Minting it at the landing instead would mean composing
 * a filename from an id the filename could not know; minting it twice would mean
 * a bank named after a step nobody created.
 */
export async function bankForReading(dir: string, asked: ReadAsk): Promise<PlannedBank> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const target = reRunTarget(ledger, {
    action: 'read',
    // The DOCUMENT origin, which for a captured project is the mint and not
    // the photographs — see `documentOriginOf` for the ruling this obeys.
    parent: documentOriginOf(ledger)?.id ?? null,
    params: askedOf(asked),
  });
  if (target !== null) {
    return { readingsPath: path.join(dir, ...target.payload.split('/')), stepId: target.id };
  }
  const minted = randomUUID();
  // A project with no reading yet takes the plain name — including one whose only
  // read step was deleted, which destroyed that bank and left the name free.
  const first = !ledger.steps.some((step) => step.action === 'read');
  const file = first ? `${manifest.key}.jsonl` : `${manifest.key}.${id8(minted)}.jsonl`;
  return { readingsPath: path.join(dir, READINGS, file), stepId: minted };
}

/** A translation's file, and the step it belongs to. See `recordsForTextPass`. */
export interface PlannedTranslation {
  /** Absolute. What the engine is handed as `--records`, and the run's whole product. */
  recordsPath: string;
  /** The same file, project-relative — `LedgerStep.payload` when this lands. */
  records: string;
  /** `LandedRun.id` for this run: an existing step on a replace, minted on a branch. */
  stepId: string;
}

/**
 * WHERE THIS TRANSLATION'S ANSWERS GO, decided before the job is enqueued.
 *
 * `bankForReading` above, in the same folder and for the identical reason: the
 * engine is handed a path and writes into it for hours, so "is this the translation
 * that already exists, or a new one beside it?" has to be answered at the plan and
 * answered the SAME WAY the landing will answer it. `translationTarget` is that one
 * answer, and it is pure so that both askings are the same code rather than the
 * same intention.
 *
 * ONE PATH WHERE THERE USED TO BE TWO, and the name says which. This was
 * `bankForTranslation` and it composed an EPUB and a bank beside it, because a
 * translation wrote a book and banked its answers separately. It writes records and
 * nothing else now, that file is the step's payload, and the book is cast from it
 * afterwards under a name composed from the step (`translationCastFile`).
 *
 * ── The parent is the POSITION, which is where a translation differs from a read ─
 *
 * A reading reads the pixels and is parented at the origin however far through
 * their history the person pressing OCR is standing (`originOf`). A translation
 * reads a BOOK — the rendering of wherever the user is standing — so its parent is
 * the position, and that is the whole of why translating the reading and
 * translating a curation of it are two rows rather than one overwritten twice.
 *
 * ── The window between this and the enqueue, stated rather than discovered ──
 *
 * `Job.parentStep` is captured at the press, a moment after this runs, and a
 * pointer move in between would let the plan and the landing disagree about the
 * parent — a branch planned and a replace landed, or the reverse. Both fall safely
 * and neither invents a rule: a replace that lands on minted paths keeps its row
 * and takes them, and `Landing.displaced` destroys what it left behind only after
 * proving no surviving row names it; a branch that lands on an existing row's paths
 * is the two-steps-one-payload state `orphanedPayloads` has always guarded. The
 * alternative — trusting the renderer to hand back the parent this plan used — is a
 * fact about a person's history taken from outside main.
 */
export async function recordsForTextPass(
  dir: string,
  /**
   * WHICH OF THE THREE THIS IS. It decides two things and both of them are the
   * file's identity: which namer composes the path (`cleanRecordsFileFor` for a
   * cleanup, `translationRecordsFileFor` for the other two) and which action
   * `reRunTarget` compares — so a cleanup of a book that has been translated
   * appends beside the translation rather than colliding with it.
   */
  action: 'translate' | 'simplify' | 'clean',
  /** `--to`, as the dialog named it. Empty for a cleanup, which goes nowhere. */
  language: string,
  /**
   * The rewrite, when the button pressed was Simplify — absent for the other two.
   *
   * A PARAMETER RATHER THAN A SECOND FUNCTION BESIDE THIS ONE, because everything
   * this decides is decided the same way for all three: the parent is still the
   * position, the answer is still `translationTarget`'s, and the act and the mode
   * are simply part of the ask it is given. A `recordsForSimplification` would be
   * this function with one field spread in, and the day the parent rule changed it
   * would change in one of the two.
   */
  rewrite?: RewriteMode,
  /**
   * THE ROW THIS PASS IS MADE FROM, when the ask did not come from the pointer.
   *
   * ── Why the position stopped being the only answer ─────────────────────────
   *
   * Owen, 2026-09-07: *"i click the grayed out row and hit the export epub tile."*
   * A pending node is a place a person can stand and act from, and it is not the
   * position — main refuses `ledger:go` to a step that does not exist, correctly,
   * so the pointer stays wherever it was while the tiles answer for the promise.
   * A plan that asked the position there would file the new pass under the row the
   * person happened to be standing on and produce a second, unwanted branch.
   *
   * IT IS ALLOWED TO NAME A STEP THIS LEDGER DOES NOT HOLD, which is the whole
   * point and is safe for a reason worth stating: `translationTarget` compares this
   * against the parents of existing steps to decide replace-or-branch, and an id
   * nothing matches is a branch — which is exactly right for a pass made from a row
   * that has not landed. Nothing here resolves the id, so nothing here has to refuse
   * it; the refusal belongs at the door that admitted the ask (`planTranslation`
   * and its two siblings, electron/workspace.ts).
   *
   * ABSENT AND `undefined` BOTH MEAN THE POSITION, which is every ask this function
   * had before this wave. `null` means the position too and is what the walk
   * answers for a project with no history — kept distinguishable from `undefined`
   * only so a caller passing a resolved-or-null id does not have to convert it.
   */
  parent?: string | null,
  /**
   * THE STEP ID TO SPEND ON A BRANCH, when one has already been minted and
   * promised to somebody.
   *
   * ── Owen's chain-anything ruling, in one parameter ─────────────────────────
   *
   * A deferred pass is planned TWICE — once at the press, where the id is minted
   * and the tree draws a card with it, and once at spawn, where the real name is
   * composed off the landed ledger (`materializeAtSpawn`, electron/job-queue.ts).
   * Left to itself the second asking would mint a SECOND uuid, and a branch named
   * `<key>.<tag>.<id8>` would take its `id8` from an id nothing on screen ever
   * carried. So the spawn hands back the id the press promised, and the file and
   * the step agree again.
   *
   * IT IS SPENT ONLY ON A BRANCH, which is `translationTarget`'s own rule and is
   * why this changes nothing about a replace: a re-run aims at the step that
   * already exists and takes that step's paths and that step's id.
   *
   * ABSENT MINTS ONE, which is every ordinary press.
   */
  minted?: string,
  /** A readings-only cleanup's name (`CleanRequest.readingsOnly`): part of which step it is. */
  readings?: string,
): Promise<PlannedTranslation> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  /*
   * THE PARENT IS THE POSITION, FULL STOP — and it used to be an argument.
   *
   * A Generate standing ON a translation needed the other answer: the user was
   * asking for that row again, so the run had to be filed against the row's own
   * parent or it would append a translation whose parent was a translation.
   * Nothing renders a translation that way any more (the book is cast from the
   * records this run writes, and a cast lands no step at all), so the only door
   * left is the Translate dialog — which asks for a translation OF what is on
   * screen. That is the position, and standing on a translation and asking for a
   * DIFFERENT language is exactly the chain the user asked for, filed under the
   * row it was made from.
   */
  const target = translationTarget(
    ledger,
    {
      action,
      // THE ARGUMENT WINS WHERE THERE IS ONE — see `parent` above. `undefined`
      // rather than a null test, because null is a legal answer meaning "no
      // history to point at" and must not fall back to a walk that answers the
      // same thing more expensively.
      parent: parent !== undefined ? parent : positionOf(ledger)?.id ?? null,
      // NOT SAID AT ALL FOR A CLEANUP, rather than said as an empty string: the ask
      // is what `translatedInto` composes the params from, and `{language: ''}`
      // would be a step claiming to have gone into a language spelled with no
      // characters. `translationTarget` never asks a cleanup for one.
      ...(action === 'clean' ? {} : { language }),
      key: manifest.key,
      ...(rewrite !== undefined ? { rewrite } : {}),
      ...(readings !== undefined ? { readings } : {}),
    },
    minted ?? randomUUID(),
  );
  return {
    recordsPath: path.join(dir, ...target.records.split('/')),
    records: target.records,
    stepId: target.stepId,
  };
}

/**
 * THE PLACEHOLDER A DEFERRED PASS WEARS UNTIL THE CHAIN CAN NAME IT — the step id
 * minted now, the file named later.
 *
 * ── Why this is not `recordsForTextPass` with a flag ────────────────────────
 *
 * Because it asks the ledger NOTHING, and that is the entire point. Every line of
 * that function is about a question the ledger can answer — is this ask a re-run of
 * a step that exists, is the plain name taken, which namer does this act use — and
 * a pass whose LANGUAGE the chain cannot yet state has no business asking any of
 * them: the answers would be composed from a fact that is not in yet. A `pending`
 * flag threaded through it would be a branch bypassing the whole body, which is a
 * second function wearing the first one's name.
 *
 * SO IT MINTS AN ID AND COMPOSES A NAME, and that is all it is. The id is what the
 * tree draws, what `Job.mints` carries and what a child ordered from the grayed
 * card names as its parent; the name is a unique string that no step will ever
 * hold, thrown away at spawn when `recordsForTextPass` is asked properly with this
 * same id (`pendingRecordsFileFor`, shared/ledger.ts, argues the spelling).
 *
 * NOTHING IS WRITTEN. The caller makes `readings/` and the engine writes the
 * records at spawn, by which time the row carries the real path — so no placeholder
 * ever exists on a disk to be swept, orphaned or mistaken for somebody's answers.
 */
export async function pendingRecordsForTextPass(
  dir: string,
  action: 'translate' | 'simplify' | 'clean',
  rewrite?: RewriteMode,
): Promise<PlannedTranslation> {
  const manifest = await readManifest(dir);
  const stepId = randomUUID();
  const records = `${READINGS}/${pendingRecordsFileFor(manifest.key, action, stepId, rewrite)}`;
  return {
    recordsPath: path.join(dir, ...records.split('/')),
    records,
    stepId,
  };
}
