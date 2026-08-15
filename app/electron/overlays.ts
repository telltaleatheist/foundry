/**
 * overlays — the block editor's two files, on disk, beside the book they describe.
 *
 *   <project>/overlays/<key>.json          what a person decided about the blocks
 *   <project>/overlays/<key>.ledger.json   the undo history of those decisions
 *
 * This module is `history.ts` for a SCAN, and it is written to that file's
 * discipline deliberately: whole-file atomic writes after every change, a
 * generation the file is bound to, a mismatch archived aside rather than
 * replayed, a refusal to write over anything it could not preserve, and every one
 * of those outcomes reported as a sentence naming the file. Where it differs from
 * `history.ts` it differs for a reason, and the reasons are here.
 *
 * ── What it is keyed by, and why that is not a working tree ─────────────────
 *
 * A book's undo history is keyed by its WORKING TREE, because a row names
 * `data-bf-id="p47-3"` in an unpacked EPUB and that name means one thing in one
 * tree. A scan has no tree. What it has is a READINGS BANK — the model's answers,
 * `readings/<key>.jsonl` — and a row here names `7:14`, the fourteenth element of
 * the model's answer for page 7. So both files are keyed by the bank's key, which
 * is the project's key, which is derived from the content of the imported file
 * and is therefore the same string in every session on every machine.
 *
 * ── And bound to a READING rather than to a tree ────────────────────────────
 *
 * The hazard is the same one and it is worth restating because it is the whole
 * reason this module has more code than a JSON reader. `(page, order, part)`
 * survives a re-RENDER of a bank — the answers are replayed verbatim, the split
 * is deterministic — and does not survive a re-READ, which asks the model the
 * same pages again and takes whatever comes back. After a re-read, `{"page": 7,
 * "order": 14}` is whatever the new pass answered fourteenth. An overlay from the
 * previous life would strike a paragraph nobody struck and divide the book in a
 * place nobody chose, WITH NOTHING ON SCREEN SAYING SO. That is the only failure
 * mode worse than losing the curation, so `projects.readingGeneration` answers
 * with an id that changes exactly when the bank at this project's POSITION
 * becomes a different pass over the pages — the read step's own
 * `params.generation`, minted by every landing but the one that resumes into the
 * bank somebody was already correcting. Both files carry the id, and a file that
 * names a different one is not read.
 *
 * ── The pair moves together ─────────────────────────────────────────────────
 *
 * The curation and its undo history are invalidated by one event, in one instant,
 * for one reason. So they live in one directory and are archived into ONE
 * `overlays/archived-<stamp>/` together. A ledger left behind beside a fresh
 * overlay would be a Ctrl+Z offering to take back amendments that are no longer
 * in the file.
 *
 * ── And nothing is ever deleted ─────────────────────────────────────────────
 *
 * A curation is a person looking at four hundred pages and saying what is on
 * them. By the retention rule (`ProjectStep.retention`) it is `irreplaceable` —
 * not merely expensive like the bank, which a machine can read again — and it is
 * the training data this project will one day want most. A file that cannot be
 * used is MOVED ASIDE and named out loud; if the move itself fails, this module
 * refuses to write that file for the rest of the session rather than letting the
 * next save clobber what it could not preserve.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { randomUUID } from 'node:crypto';

import { writeAtomically } from './epub-writer';
import {
  curationsDir,
  ledgerOf,
  overlayArchiveDir,
  overlaysDir,
  projectDirOf,
  readManifest,
  readingBank,
  readingGeneration,
  recordCuration,
  renderingOverlay,
  type LedgerView,
} from './projects';
import { restorePointOf, uncommittedCuration, type SavedCuration } from '../shared/uncommitted';
import {
  OverlayError,
  emptyOverlay,
  frozenCuration,
  overlayFate,
  overlayText,
  parseOverlay,
  type FrozenCuration,
  type OverlayFile,
} from '../shared/overlay';
import { readJson } from '../shared/json';
import type {
  LedgerAction,
  LedgerLoad,
  LedgerRow,
  LedgerStacks,
  OverlayLoad,
  UncommittedCuration,
} from '../shared/types';

/** The ledger schema this module writes and the only one it reads. */
const LEDGER_VERSION = 1;

/**
 * The four routes a block-editor row can name.
 *
 * `history.ts` keeps its own set of six for the same reason and it is worth
 * saying once more: a file naming a field no setter answers to is a file from a
 * future, and handing it to a replay that would fall through every branch is an
 * undo that reports success and does nothing.
 */
const FIELDS: ReadonlySet<string> = new Set([
  'strike', 'block-category', 'block-text', 'chapters',
]);

/** Where one scan's two files sit, and which reading they belong to. */
export interface OverlayLocation {
  file: string;
  ledger: string;
  /**
   * The overlay a RENDERING at the project's position is made with — the frozen
   * curation snapshot when the user is standing on one, and `file` otherwise.
   *
   * ── Why this is a second field and not `file` resolved differently ──────────
   *
   * `file` is the LIVE curation and has to stay the live curation, because it is
   * what `saveOverlayFile` writes to. A snapshot is a retained payload: it is
   * frozen at the instant it was committed and it never changes again, which is
   * the entire reason it is worth keeping and the entire reason a step can point
   * at it. Resolving `file` to the snapshot would mean the next strike anybody
   * made while standing on a save silently rewrote that save — destroying the
   * frozen state to record an edit, which is the one thing a snapshot may never
   * do.
   *
   * So the two questions are kept apart, because they are two questions: WHERE
   * DOES A CORRECTION GO (always the live pair) and WHAT DOES A RENDERING READ
   * (the position's answer). Showing a snapshot read-only in the block editor
   * when the position is a save is the renderer's job and a later pass; what this
   * field settles is the one that reaches the engine's command line.
   */
  rendering: string;
  /**
   * The readings bank these amendments are about.
   *
   * Composed here rather than by `workspace.planConversion`, which is the other
   * place that names it: that function IMPORTS the document as a side effect —
   * it is how a project comes to exist — and asking "which blocks are on these
   * pages" must not create a folder. Same two components, same answer, and the
   * key comes from the same catalogue.
   */
  readings: string;
  /** The archived original the bank was read from, or null for a legacy project. */
  source: string | null;
  generation: string;
  projectDir: string;
  key: string;
}

/**
 * The paths for a PDF the app has open.
 *
 * THE RENDERER NAMES A DOCUMENT AND NOTHING ELSE, exactly as it does for a
 * book's history: where the files are and which reading they belong to are main's
 * own records. A renderer that could assert a generation could assert the wrong
 * one, and the check would mean nothing.
 *
 * Refuses by name for a path outside every project. That is not a hostile caller
 * — it is somebody who opened a scan from their own Downloads folder, which this
 * app is happy to show and has no bank for, so there is nothing to curate and the
 * sentence says which.
 */
export async function locateOverlay(pdfPath: string): Promise<OverlayLocation> {
  /*
   * TWO REFUSALS, BECAUSE THEY ARE TWO SITUATIONS AND ONE SENTENCE WAS WRONG FOR
   * BOTH OF THEM.
   *
   * This said "Convert it first" for every path outside `projects/`, which is
   * the answer to a question nobody had asked. A document outside the library is
   * one the app has not imported — usually because the import is still running
   * behind the tab that opened, occasionally because it failed — and telling
   * that person to convert their book sends them to a dialog that will convert
   * something they already have. What they need to know is that this file is not
   * in the library yet.
   *
   * The other case is the real "not read yet", and it has its own door: the
   * project exists, the bank does not, and the fix is one press of OCR.
   */
  const projectDir = projectDirOf(pdfPath);
  if (projectDir === null) {
    throw new OverlayError(
      `${pdfPath} is not in Foundry's library, so there is nothing behind it to correct yet. `
      + 'Foundry imports a document it opens from elsewhere and then works on its own copy — if '
      + 'that has not happened, opening the file again from Home will land on the copy.',
    );
  }
  const manifest = await readManifest(projectDir);
  const key = manifest.key;
  const archived = manifest.archive?.kind === 'pdf' ? manifest.archive.file : null;
  /*
   * THE BANK THE POSITION IS ABOUT, asked of the step rather than composed.
   *
   * This said `readings/<key>.jsonl`, one bank per project, which stopped being
   * true when a re-read asking a different page range began branching: the project
   * holds two `read` steps, each naming its own file, and this line would hand the
   * block editor whichever one the key happened to spell. Standing on the older
   * reading and opening the blocks drew the NEWER bank's pages — the same failure
   * `planConversion` had, in the one screen where a person is looking at the
   * blocks themselves and would correct them.
   *
   * `readingBank` walks up from the position to the reading this branch of the
   * story is about, and it is handed the manifest already open here for
   * `renderingOverlay`'s reason: the bank and the curation must be answers about
   * one moment of one catalogue. A project with a single reading — which is every
   * project that predates per-step paths — gets the path it always got, because
   * that is what its read step says.
   *
   * The refusal below is more honest for it too: "not read yet" now means this
   * position has no bank, rather than the project having none under one name.
   */
  const readings = readingBank(projectDir, manifest);
  // The pages have not been read. Said as itself rather than as "convert it
  // first": there is a project, there is a scan in it, and the one step between
  // this person and a page full of outlined blocks is the one the dock is
  // already lighting.
  if (!await exists(readings)) {
    throw new OverlayError(
      `${path.basename(pdfPath)} has not been read yet, so there are no blocks to correct. `
      + 'Press OCR to read its pages — everything else in Foundry is built on what that produces.',
    );
  }
  const folder = overlaysDir(projectDir);
  return {
    file: path.join(folder, `${key}.json`),
    ledger: path.join(folder, `${key}.ledger.json`),
    // Composed from the manifest that was already read, rather than by a second
    // read: the position is a fact about the same catalogue this function has
    // open, and asking for it again would let the two answers be about two
    // different moments.
    rendering: renderingOverlay(projectDir, manifest),
    readings,
    /**
     * THE PDF THE BANK WAS READ FROM, which is not the one the tab is showing.
     *
     * `vlm-blocks` only needs a PDF for a bank written before runs recorded the
     * size they rendered each page at — and then it measures every page again to
     * put the boxes in a frame. Handed the WORKING PDF it would measure whatever
     * that is now, and after a real-text rendering that document is type on
     * blank paper: same page count, same sizes, none of the ink. The boxes would
     * come back plausible and silently wrong, and the first thing anybody would
     * do with them is strike a paragraph.
     *
     * `archive/` is written once at import and never again, so it is the one
     * copy that is certainly the pages the model was shown. Null for a legacy
     * project that has no archive, and then the caller passes what it has.
     */
    source: archived === null ? null : path.join(projectDir, 'archive', archived),
    generation: await readingGeneration(projectDir),
    projectDir,
    key,
  };
}

/**
 * Files this session must not write, and why. See `history.ts` — same map, same
 * rule, and it clears itself on the next launch, which is the right moment to try
 * again.
 */
const unwritable = new Map<string, string>();

function key(file: string): string {
  return path.resolve(file).toLowerCase();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move both files aside into one `archived-<stamp>/` and say where they went.
 *
 * BOTH, in one folder, in one call: they are one curation and one account of how
 * it was made. A destination that already exists is refused rather than written
 * over — the stamp is per second, and two archives in one second would otherwise
 * merge two readings' work under one name.
 */
async function archiveAside(where: OverlayLocation): Promise<string> {
  const folder = overlayArchiveDir(where.projectDir);
  await fsp.mkdir(folder, { recursive: true });
  for (const source of [where.file, where.ledger]) {
    if (!await exists(source)) continue;
    const destination = path.join(folder, path.basename(source));
    if (await exists(destination)) {
      throw new OverlayError(
        `${destination} already exists, so ${source} cannot be moved aside without writing over a `
        + 'curation that is already there.',
      );
    }
    await fsp.rename(source, destination);
  }
  return folder;
}

/**
 * Archive the pair and turn the whole business into one sentence.
 *
 * A FAILED ARCHIVE IS ALSO A SENTENCE, and it locks both files: the one thing
 * that must not happen is a person's corrections quietly ceasing to exist because
 * neither the move nor the refusal was reported.
 */
async function setAside(where: OverlayLocation, why: string): Promise<string> {
  try {
    const went = await archiveAside(where);
    return `${where.file} holds corrections Foundry cannot use — ${why}. They have been moved to `
      + `${went} (nothing was deleted) and this book starts with a clean overlay.`;
  } catch (err) {
    unwritable.set(key(where.file), (err as Error).message);
    unwritable.set(key(where.ledger), (err as Error).message);
    return `${where.file} holds corrections Foundry cannot use — ${why} — and they could not be `
      + `moved aside either (${(err as Error).message}). Nothing has been deleted and nothing will `
      + 'be written over them: this book has no curation this session.';
  }
}

/**
 * The curation this scan was left with, or a clean one and the reason why.
 *
 * The three outcomes are `loadLedger`'s, and every one of them is normal: the
 * generation matches and the work comes back; it does not, and the file is
 * archived aside; it will not parse, and the same. A file that is simply not
 * there is the fourth case and is not an outcome at all — it is what every scan
 * looks like before its first correction.
 */
export async function loadOverlayFile(pdfPath: string): Promise<OverlayLoad> {
  const where = await locateOverlay(pdfPath);
  const live = await readOverlay(where);
  const shown = await readCuration(where);
  return {
    file: live.file,
    frozen: shown.frozen,
    // THE LIVE FILE'S NOTICE WINS. Both sentences are about this book's
    // corrections and only one strip draws them, and the live one is the file the
    // user is about to edit — a snapshot that could not be shown is a row they can
    // click away from, while an archived live overlay is their working state gone.
    notice: live.notice ?? shown.notice,
  };
}

/**
 * The frozen curation the position renders with, or null and a reason.
 *
 * ── Why the snapshot is READ AGAIN rather than trusted for being retained ────
 *
 * A committed snapshot is bound to a reading generation exactly as the live
 * overlay is (`commitOverlay` stamps main's own), and for the same reason: its
 * amendments name blocks as `(page, order)`, and a book read again renumbers
 * every one of them. A stale save drawn over a fresh bank would outline a
 * paragraph nobody struck and mark a chapter nobody chose, WITH NOTHING ON SCREEN
 * SAYING SO — the failure this whole module was built around, arriving through the
 * one file that was supposed to be safe because it never changes. It never
 * changes; the pages under it did.
 *
 * SO IT IS SHOWN OR IT IS EXPLAINED, and never quietly. The step stays where it
 * is, the row stays clickable, and the sentence says the reading moved — which is
 * the same thing the dimmed row says on hover, reaching the same person in the
 * place they are actually looking.
 *
 * AND IT IS NEVER ARCHIVED ASIDE, which is the one thing this does differently
 * from every other unusable curation in this file. `setAside` exists for the LIVE
 * pair, whose whole purpose is to be current; a snapshot is a retained payload
 * named by a step, and moving it would leave that step pointing at nothing. It is
 * deleted when its step is deleted and at no other moment.
 */
async function readCuration(where: OverlayLocation): Promise<{
  frozen: FrozenCuration | null;
  notice: string | null;
}> {
  // The live file IS the rendering for almost every project and every position:
  // nobody has pressed Save, or the pointer is not standing where a save is in
  // effect. Compared by the whole path, never by a basename.
  if (key(where.rendering) === key(where.file)) return { frozen: null, notice: null };

  let text: string;
  try {
    text = await fsp.readFile(where.rendering, 'utf8');
  } catch (err) {
    return {
      frozen: null,
      notice: `You are standing on a saved copy of this book's corrections and Foundry could not `
        + `read it (${(err as Error).message}). The pages are showing the blocks as the model read `
        + 'them, with no corrections marked on them. Nothing has been changed or deleted.',
    };
  }

  let file: OverlayFile;
  try {
    file = parseOverlay(text, where.rendering);
  } catch (err) {
    return {
      frozen: null,
      notice: `You are standing on a saved copy of this book's corrections that Foundry cannot use `
        + `— ${(err as Error).message}. It has been left exactly where it is; the pages are showing `
        + 'the blocks with no corrections marked on them.',
    };
  }

  const fate = overlayFate(file.generation, where.generation);
  if (!fate.use) {
    return {
      frozen: null,
      notice: `You are standing on a saved copy of this book's corrections that Foundry will not `
        + `draw — ${fate.why}. It is kept exactly as it was; showing it over these pages would mark `
        + 'up paragraphs nobody chose.',
    };
  }
  return { frozen: frozenCuration(file), notice: null };
}

/**
 * The same three outcomes, for a caller that has already located the files —
 * and typed as the overlay this module actually holds.
 *
 * SPLIT OUT FOR TWO REASONS, and the second one is the one that matters.
 * `commitOverlay` has a location in its hand and calling the public door would
 * read the catalogue a second time, so the two halves of one commit could be
 * about two different moments. And `OverlayLoad.file` is the WIRE shape
 * (`OverlayFileWire`), which is structurally the same object with its literal
 * types widened for the boundary — perfectly correct to send to a renderer, and
 * not something to build a file out of. A commit that took the wire shape back
 * would need a cast to write it, and a cast is how a category the engine never
 * emits gets written into a snapshot that four hundred blocks depend on.
 */
async function readOverlay(where: OverlayLocation): Promise<{
  file: OverlayFile;
  notice: string | null;
}> {
  let text: string;
  try {
    text = await fsp.readFile(where.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: emptyOverlay(where.generation), notice: null };
    }
    // Present and unreadable is not "no curation": something is there, this app
    // cannot see it, and it must not be written over on that basis.
    unwritable.set(key(where.file), (err as Error).message);
    return {
      file: emptyOverlay(where.generation),
      notice: `${where.file} holds this book's block corrections and could not be read `
        + `(${(err as Error).message}). Foundry is starting a clean overlay for this session and `
        + 'will not write over that file.',
    };
  }

  let file: OverlayFile;
  try {
    file = parseOverlay(text, where.file);
  } catch (err) {
    return {
      file: emptyOverlay(where.generation),
      notice: await setAside(where, (err as Error).message),
    };
  }

  const fate = overlayFate(file.generation, where.generation);
  if (!fate.use) {
    return {
      file: emptyOverlay(where.generation),
      notice: await setAside(where, fate.why),
    };
  }
  return { file, notice: null };
}

/**
 * One document's writes, in order, one at a time — `history.ts`'s promise chain,
 * and for its reasons.
 *
 * Each save carries the WHOLE file, so the only thing that matters is which lands
 * last, and without a chain that is not settled by the order they were asked for.
 * Two strikes a few milliseconds apart could interleave their temp file and their
 * rename and leave the older curation on disk under the newer one's name.
 */
const writes = new Map<string, Promise<unknown>>();

function serialise<T>(file: string, work: () => Promise<T>): Promise<T> {
  const mapKey = key(file);
  const previous = writes.get(mapKey) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed write must not poison the ones queued behind it */ })
    .then(work);
  writes.set(mapKey, next);
  return next;
}

function refuseIfLocked(file: string, what: string): void {
  const blocked = unwritable.get(key(file));
  if (blocked === undefined) return;
  throw new OverlayError(
    `${file} already holds ${what} this app could not read or move aside (${blocked}), so it will `
    + 'not be written over. This session\'s work is in memory only.',
  );
}

/**
 * Write the curation. Called after every gesture that changes one.
 *
 * THE GENERATION IS MAIN'S, always, and is stamped over whatever the renderer
 * sent. The renderer has never computed one and could not check one; the file's
 * binding to a reading is main's assertion about main's own catalogue, and a
 * renderer that could name a generation could name a stale one and resurrect the
 * exact failure this whole module exists to prevent.
 */
export async function saveOverlayFile(pdfPath: string, file: OverlayFile): Promise<void> {
  const where = await locateOverlay(pdfPath);
  refuseIfLocked(where.file, 'block corrections');
  // Round-tripped through the reader before a byte is written. The renderer is
  // the only writer and it writes through `shared/overlay.ts`, so this can only
  // fail if this app has a bug — which is exactly when writing the file would be
  // worst, because the engine refuses a malformed overlay and the run that
  // discovers it is three hours long.
  const bytes = Buffer.from(overlayText({ ...file, generation: where.generation }), 'utf8');
  parseOverlay(bytes.toString('utf8'), where.file);
  await fsp.mkdir(overlaysDir(where.projectDir), { recursive: true });
  await serialise(where.file, () => writeAtomically(where.file, bytes));
}

// ─────────────────────────────────────────────────────────────────────────────
// Freezing one: a curation step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Freeze the live curation as a snapshot, and record the step that names it.
 *
 * ── What Save means here, which is not what Save means anywhere else ────────
 *
 * The live overlay is already saved. It is written whole and atomically after
 * every gesture — that is what `saveOverlayFile` is — so there is no unsaved work
 * for a Save button to rescue, and a button that claimed to be doing that would
 * be lying about the file it was writing.
 *
 * What this does instead is take a COPY that will never change again. The live
 * file goes on being the working state, edited continuously, still the thing
 * `Ctrl+Z` walks back; the snapshot is a retained payload with a step of its own,
 * clickable in the history, renderable, and restorable. It is the difference
 * between a document that autosaves and a document that keeps restore points.
 *
 * A STEP IS NOT NAMED BY THE PERSON WHO MAKES IT, which is why this takes a path
 * and nothing else. `labelFor` composes "Saved corrections (23)" from the count,
 * in the app's own voice, exactly as every other row in the history is named by
 * its action — a typed-in name would be the one row of somebody's history in a
 * different register, and it would be the row they left blank.
 *
 * ── The live overlay is NOT cleared, moved or touched ───────────────────────
 *
 * The obvious alternative — commit takes the live file and starts a fresh one —
 * is wrong in the way that costs somebody their afternoon. Committing would then
 * be a gesture that EMPTIES the block editor, so the book on screen would repaint
 * as uncorrected the instant the user pressed Save, and the only way back to
 * their own work would be to understand the step model well enough to click the
 * right row. Nothing is taken away: the copy is what is retained, and the
 * original is where it was.
 *
 * ── A commit with nothing in it is refused rather than minted ───────────────
 *
 * An empty snapshot is a step whose payload says nothing, sitting in the history
 * beside steps that cost hours, offering the user a delete confirmation about a
 * file with no decisions in it. Worse, it makes the history lie about the shape
 * of the work: a row that reads "Saved corrections" between the reading and the
 * translation says somebody curated this book, and nobody did.
 *
 * THE CHAPTERS COUNT AS DECISIONS, which is why the test is not simply the
 * amendment count. A definitive chapters list is a person saying where this book
 * divides — the same labour as a strike and retained for the same reason — and a
 * curation that is nothing but a spine is a real thing to want to keep. An
 * ABSENT `chapters` means nobody has touched them; an empty ARRAY means somebody
 * said this book has no divisions, which is a decision and is preserved as one
 * (see `OverlayFile.chapters`).
 *
 * ── AND IT DOES NOT MOVE THE POINTER ────────────────────────────────────────
 *
 * `RETAINED_BESIDE_YOU` in shared/ledger.ts is where that is settled and why. The
 * short of it: a save does not make a new state of the book, it retains the one
 * you are already in — and moving the pointer onto the snapshot made the editor
 * read-only the instant somebody pressed Save, for nothing, since the live
 * overlay is byte for byte the file just frozen and is the editable one.
 */
export async function commitOverlay(pdfPath: string): Promise<LedgerView> {
  const where = await locateOverlay(pdfPath);
  const { file } = await readOverlay(where);

  if (file.amendments.length === 0 && file.chapters === undefined) {
    throw new OverlayError(
      `There is nothing to save for ${path.basename(pdfPath)} yet — no blocks have been struck, `
      + 'relabelled or rewritten, and no chapters have been set. Correct something first and this '
      + 'will keep a copy of it that nothing later can change.',
    );
  }

  /*
   * A UUID, AND THE PROJECT-RELATIVE PATH IS WHAT THE STEP CARRIES.
   *
   * Never the book's name and never a timestamp: a snapshot is addressed by the
   * step that names it, the step's LABEL is what a person reads, and a filename
   * that tried to say the same thing would be a second place for it to be said
   * differently. The uuid also makes the write collision-free by construction —
   * two commits a second apart cannot land on one name, which is exactly the
   * failure `archiveAside` has to refuse for its per-second stamps.
   */
  const name = `${randomUUID()}.json`;
  const snapshot = path.join(curationsDir(where.projectDir), name);
  // The generation is MAIN'S, stamped over whatever was loaded — `saveOverlayFile`'s
  // rule and its reason: the file's binding to a reading is main's assertion about
  // main's own catalogue. Round-tripped through the reader before a byte lands,
  // for that function's reason too.
  const bytes = Buffer.from(overlayText({ ...file, generation: where.generation }), 'utf8');
  parseOverlay(bytes.toString('utf8'), snapshot);
  await fsp.mkdir(curationsDir(where.projectDir), { recursive: true });
  await serialise(snapshot, () => writeAtomically(snapshot, bytes));

  /*
   * THE FILE FIRST, THE STEP SECOND, and never the other way round. A step is a
   * pointer at a retained payload; a step recorded before its payload exists is a
   * row the user can click, render from and be shown a refusal by. If the write
   * above fails this throws and no step is minted, which leaves an orphan file
   * only in the case where the write half-succeeded — and `writeAtomically` is
   * what makes that case not exist.
   */
  return recordCuration(where.projectDir, `curations/${name}`, {
    // WHICH PASS OVER THE PAGES THESE BLOCK NUMBERS ARE ABOUT. Carried for the
    // reason the live overlay carries it: `(page, order)` means different blocks
    // after a re-read, so a snapshot that did not say which reading it was made
    // under would be a set of amendments nobody could ever safely apply again.
    generation: where.generation,
    // The count is what the ROW says ("Saved corrections (23)"), so it is the
    // amendments and not the chapters: a spine is one decision about the book
    // rather than a number of decisions about blocks, and adding it in would make
    // the label quote a total nobody could account for.
    amendments: file.amendments.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// What no save of this book holds — the closing question's one fact
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The corrections this book has that no save of it does, or null when there is
 * nothing to ask a person about on their way out.
 *
 * ── It reads and it does not touch anything, and that is a rule ─────────────
 *
 * `readOverlay` is the function that would obviously be reused here and it must
 * not be: it ARCHIVES THE PAIR ASIDE when the file will not parse or names an
 * earlier reading (`setAside`), which is right when a person is opening a book to
 * work on it and indefensible as the side effect of a question. Somebody who
 * closed a tab would have found their curation moved into an `archived-<stamp>/`
 * folder because the app wondered whether to warn them. So this reads the file
 * plainly, and every way of failing to read it comes back null.
 *
 * ── Null for every shape where the question is meaningless ──────────────────
 *
 * A document outside the library, a scan nobody has read, a book with no overlay
 * file yet, an overlay bound to a reading that has since been replaced. That last
 * one is worth naming: those amendments are about block numbers that mean
 * different blocks now, the next open will archive them aside and say so, and
 * offering to freeze them as a restore point would be offering to retain a
 * curation of a book that no longer exists.
 *
 * ── A snapshot that will not read counts as no restore point ────────────────
 *
 * Deliberately, and it errs towards asking rather than away from it. A save whose
 * file is unreadable is a row the user cannot actually come back to, so the
 * corrections in front of them are as unretained as they would be with no save at
 * all — and being asked about work that turns out to be safe is a smaller failure
 * than being closed on silently because a file main could not open was assumed to
 * be holding everything.
 */
export async function uncommittedIn(pdfPath: string): Promise<UncommittedCuration | null> {
  const where = await locateOverlay(pdfPath);
  const live = await readCurationAt(where.file);
  if (live === null || live.generation !== where.generation) return null;

  const manifest = await readManifest(where.projectDir);
  const step = restorePointOf(ledgerOf(manifest));
  let saved: SavedCuration | null = null;
  if (step !== null) {
    // Project-relative with forward slashes, as every payload is — rebuilt into a
    // path here rather than joined blind, because the ledger's spelling of a
    // payload is not this platform's.
    const content = await readCurationAt(path.join(where.projectDir, ...step.payload.split('/')));
    if (content !== null) saved = { label: step.label, content };
  }
  return uncommittedCuration(live, saved);
}

/** A curation off disk, or null for every way that can fail. Writes nothing. */
async function readCurationAt(file: string): Promise<OverlayFile | null> {
  try {
    return parseOverlay(await fsp.readFile(file, 'utf8'), file);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The undo ledger for those corrections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stacks this scan's block editor was left with.
 *
 * The overlay's own load has already decided whether this reading's files are
 * usable and archived them if not, so by the time anything asks for the ledger
 * the pair is either both current or both gone. This still checks the generation
 * for itself rather than trusting that ordering: a ledger is read once per open
 * and a check that depends on a call site's sequence is a check that stops being
 * true the first time somebody reorders two lines.
 */
export async function loadOverlayLedger(pdfPath: string): Promise<LedgerLoad> {
  const where = await locateOverlay(pdfPath);

  let text: string;
  try {
    text = await fsp.readFile(where.ledger, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { actions: empty(), notice: null };
    unwritable.set(key(where.ledger), (err as Error).message);
    return {
      actions: empty(),
      notice: `${where.ledger} holds the undo history of this book's block corrections and could `
        + `not be read (${(err as Error).message}). Foundry is starting a fresh one and will not `
        + 'write over that file.',
    };
  }

  let history: { generation: string; done: LedgerAction[]; undone: LedgerAction[] };
  try {
    history = parseLedger(text);
  } catch (err) {
    return { actions: empty(), notice: await setAside(where, (err as Error).message) };
  }

  const fate = overlayFate(history.generation, where.generation);
  if (!fate.use) {
    return { actions: empty(), notice: await setAside(where, fate.why) };
  }

  const actions = history.done.length + history.undone.length;
  return {
    actions: { done: history.done, undone: history.undone },
    notice: actions === 0 ? null
      : `Block corrections history restored: ${describe(history.done.length, 'action')} to undo and `
        + `${describe(history.undone.length, 'action')} to redo, from ${where.ledger}.`,
  };
}

export async function saveOverlayLedger(pdfPath: string, stacks: LedgerStacks): Promise<void> {
  const where = await locateOverlay(pdfPath);
  refuseIfLocked(where.ledger, 'an undo history');
  const document = {
    version: LEDGER_VERSION,
    generation: where.generation,
    overlay: path.basename(where.file),
    savedAt: Date.now(),
    done: stacks.done,
    undone: stacks.undone,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await fsp.mkdir(overlaysDir(where.projectDir), { recursive: true });
  await serialise(where.ledger, () => writeAtomically(where.ledger, bytes));
}

function empty(): LedgerStacks {
  return { done: [], undone: [] };
}

/** "1 action" / "3 actions" — the count is the whole point of the sentence. */
function describe(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Read the ledger, or say exactly what about it is not one.
 *
 * EVERY FIELD IS CHECKED and a row that is short of one takes the whole file down
 * rather than being skipped, for `history.ts`'s reason: the rows of an action are
 * one gesture — sixteen blocks struck together go back together — and an action
 * silently missing its fourteenth row is an undo that leaves a curation in a
 * state nobody ever made.
 */
function parseLedger(text: string): { generation: string; done: LedgerAction[]; undone: LedgerAction[] } {
  let parsed: unknown;
  try {
    parsed = readJson(text);
  } catch (err) {
    throw new OverlayError(`it is not JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OverlayError('it is not an object, so it is not an undo history');
  }
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== LEDGER_VERSION) {
    throw new OverlayError(
      `it is version ${String(row['version'])} and this app writes version ${LEDGER_VERSION}`,
    );
  }
  if (typeof row['generation'] !== 'string' || row['generation'].length === 0) {
    throw new OverlayError('it names no reading generation, so nothing says which blocks its rows are about');
  }
  return {
    generation: row['generation'],
    done: readActions(row['done'], 'done'),
    undone: readActions(row['undone'], 'undone'),
  };
}

function readActions(value: unknown, stack: string): LedgerAction[] {
  if (!Array.isArray(value)) throw new OverlayError(`its "${stack}" stack is not a list`);
  return value.map((entry, at) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new OverlayError(`${stack}[${at}] is not an action`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['seq'] !== 'number' || !Number.isFinite(row['seq'])) {
      throw new OverlayError(`${stack}[${at}] carries no action number`);
    }
    if (typeof row['label'] !== 'string' || row['label'].length === 0) {
      throw new OverlayError(`${stack}[${at}] says nothing about what it did`);
    }
    if (!Array.isArray(row['rows']) || row['rows'].length === 0) {
      throw new OverlayError(`${stack}[${at}] moved nothing, so it is not an action`);
    }
    return {
      seq: row['seq'],
      label: row['label'],
      rows: row['rows'].map((candidate, index) => readRow(candidate, `${stack}[${at}].rows[${index}]`)),
    };
  });
}

function readRow(value: unknown, where: string): LedgerRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OverlayError(`${where} is not a row`);
  }
  const row = value as Record<string, unknown>;
  const field = row['field'];
  if (typeof field !== 'string' || !FIELDS.has(field)) {
    throw new OverlayError(`${where} names the field "${String(field)}", which no setter in this app answers to`);
  }
  for (const name of ['member', 'target', 'before', 'after'] as const) {
    if (typeof row[name] !== 'string') throw new OverlayError(`${where} carries no ${name}`);
  }
  return {
    member: row['member'] as string,
    target: row['target'] as string,
    field: field as LedgerRow['field'],
    before: row['before'] as string,
    after: row['after'] as string,
  };
}
