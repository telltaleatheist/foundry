/**
 * book-materialize — a book made into a file, its ops applied, and viewing an exported book.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeEpubBook } from './engine';
import { writeAtomically } from './atomic';
import { bookAtPosition, exportInTray, opsDir, opsPayloadFor, readManifest, recordBookEdit, type LedgerView, derivedDirFor } from './projects';
import { BookFileError, formatBookFile, parseBookFile, type BookFile, type BookOutcome } from '../shared/book';
import { materialize } from '../shared/materialize';
import { BookOpsError, formatOpsFile, parseOpsFile, type BookOp } from '../shared/ops';
import type { LedgerStep } from '../shared/types';
import { sweepStaleDerived } from './book-correct';
import { exists, figuresPrefixFor } from './book-figures';
import { openBookAtPosition } from './book-open';

export async function materializeBook(
  projectDir: string,
  /**
   * THE STEP TO BUILD FOR, when it is not the position — `openBookAtPosition`'s
   * own parameter, exposed because a caller can want a book for a row the pointer
   * is not standing on.
   *
   * The export that arrives from outside the window is the case that asked for
   * it: a host ordering an act from a step in the tree needs the EPUB of THAT
   * step, and the person may be standing three rows away (`exportEpubFromStep`,
   * electron/mount.ts). Null and absent both mean the position, which is every
   * export somebody pressed the button for.
   */
  from: LedgerStep | null = null,
): Promise<
  | {
    ok: true;
    path: string;
    /**
     * Positions of the derived book whose words the replay COMPOSED rather than
     * carried — `Materialized.restructured`, handed on because the caller is the
     * only one that can act on it.
     *
     * A merge joins two blocks' text into the survivor's position, so a per-block
     * claim about the parent's words — a cleanup's stamp — is no longer true there
     * although not one character was un-cleaned. `planRendering` narrows the stamp
     * over exactly these positions (`narrowedStamp`, electron/workspace.ts); every
     * other caller ignores the field, which costs them nothing.
     */
    restructured: string[];
  }
  | { ok: false; reason: string }
> {
  const read = await openBookAtPosition(projectDir, from);
  if (!read.ok) return read;
  const { at, parsed, ops, tip } = read.opened;

  let made: ReturnType<typeof materialize>;
  try {
    /*
     * THE TIP'S OPS ARE PART OF THE BOOK. `openBookAtPosition` withholds the
     * amendable tip step's ops from `ops` and hands them back as `tip`,
     * because the PANE needs them separately — they hydrate its undo stack.
     * Every other consumer wants the concatenation, and this call site was
     * the one of three that forgot it: standing on a freshly applied edit
     * step, every op the person just made is in the tip and `ops` is empty,
     * so the book that went to the compiler was the unedited one — an EPUB
     * with every struck block still in it, exported from a workbench whose
     * Final version showed them gone.
     */
    made = materialize(parsed, [...ops, ...(tip ?? [])]);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    console.error(`[book] ${read.opened.path} could not be materialised: ${err.message}`);
    return {
      ok: false,
      reason: `The changes recorded for this book could not be replayed onto it: ${err.message}`,
    };
  }
  /*
   * AN OP THE REPLAY COULD NOT PERFORM IS SAID OUT LOUD AND IS NOT FATAL, which
   * is `Replayed.missing`'s own ruling: a chain can name a block a later reading
   * no longer has, and refusing to export a whole book over one stale strike is
   * the worst of the three answers available. The terminal gets the count and the
   * ids; the book that comes out carries everything that still landed.
   */
  if (made.missing.length > 0) {
    console.error(
      `[book] ${read.opened.path}: ${made.missing.length} recorded change(s) could not be replayed `
      + `for this export — ${made.missing.map((one) => `${one.op.op} ${one.id}`).join(', ')}`,
    );
  }

  /*
   * ── UNDER THE PROJECT, NOT UNDER /tmp ──────────────────────────────────
   *
   * The destination is derived from the project rather than named by the
   * caller, because every caller named the same thing and one of them being
   * different is the bug this shape prevents. See `derivedDirFor`.
   *
   * THE UUID STAYS. It is not decoration: `workspace.ts` materialises AT PLAN
   * TIME so a pointer moved while the job waits cannot change which book was
   * meant, and two plans for one step must not write the same file — the second
   * would rewrite the book the first job is mid-compile against.
   */
  const into = derivedDirFor(projectDir);
  await sweepStaleDerived(into);
  const file = path.join(into, `${randomUUID()}.book.jsonl`);
  try {
    await writeAtomically(file, Buffer.from(formatBookFile(made.book), 'utf8'));
  } catch (err) {
    console.error(`[book] the derived book for ${at.dir} could not be written: ${(err as Error).message}`);
    return {
      ok: false,
      reason: 'The book with your changes in it could not be written out for the engine to compile.',
    };
  }
  return { ok: true, path: file, restructured: made.restructured };
}

/**
 * APPLY — the pane's stack, written down as a step.
 *
 * ── The order, which is the whole of the correctness here ───────────────────
 *
 * The ops are PROVEN, then the file is written ATOMICALLY, then the step lands.
 * Every other order has a failure that leaves the project describing something
 * that is not there: a step written first and a disk that then refuses leaves a
 * row in somebody's history naming a payload that does not exist, and
 * `loadBook` above rightly refuses the whole book for it — one full stop, forever,
 * over a transient write error. A file written first and a step that never lands
 * leaves eight kilobytes in `ops/` that nothing will ever mention again, which is
 * the smaller failure by a wide margin and is the one this order chooses.
 *
 * ATOMICALLY means a temp file beside the target and a rename (`writeAtomically`,
 * electron/atomic.ts): a rename is atomic on one volume, so an interrupted
 * Apply leaves no file rather than half of one — and half a file of ops is a book
 * that opens missing the second half of somebody's afternoon.
 *
 * ── Why the ops are re-read after being written out ─────────────────────────
 *
 * Because they arrived over IPC and a renderer is not a trusted author of a
 * payload format. This app's rule for anything crossing that seam is that the
 * receiving side proves it (`parseLedger`, `parseBookFile`, `parseTargetKey`), and
 * the proof available here is exactly the one every later reader will apply: put
 * it in the format and read it back with the format's own parser. A shape this
 * build cannot replay is refused BY NAME here, before it is on anybody's disk,
 * rather than by every open of the book from now on.
 *
 * ── It rejects, and that is deliberate ──────────────────────────────────────
 *
 * `loadBook` answers a sentence because there is nothing else to put on an empty
 * sheet. This is the other case: the person's changes are still on the stack in
 * front of them, so a refusal is something they can act on — and a resolve that
 * quietly did nothing would clear a stack that had not been recorded.
 */
export async function applyBookOps(projectDir: string, ops: readonly BookOp[]): Promise<LedgerView> {
  // The same gate every call in this family goes through, before anything is
  // read or written: `bookAtPosition` resolves it through `deletableProjectDir`.
  const at = await bookAtPosition(projectDir);
  if (ops.length === 0) {
    throw new BookOpsError(
      'There are no changes waiting to be applied, and a step recording nothing would be a row in '
      + 'this book\'s history that nobody can tell from the one above it.',
    );
  }
  const bytes = formatOpsFile(ops);
  // The round trip is the proof — see the header. It throws `BookOpsError` with a
  // sentence naming the line and the field, which is what the caller shows.
  parseOpsFile(bytes);

  /*
   * MINTED HERE, BEFORE THE FILE, because the file is named after it — the
   * reading's arrangement (`ReadRequest.stepId`) for the reading's reason. It is
   * spent on an append, which is every time: an edit is irreplaceable, so
   * `reRunTarget` can never resolve one and every Apply is a row of its own.
   */
  const stepId = randomUUID();
  const payload = opsPayloadFor(stepId);
  await fsp.mkdir(opsDir(at.dir), { recursive: true });
  await writeAtomically(path.join(at.dir, ...payload.split('/')), Buffer.from(bytes, 'utf8'));

  try {
    return await recordBookEdit(at.dir, payload, { ops: ops.length }, stepId);
  } catch (err) {
    /*
     * THE FILE GOES WITH THE ROW THAT NEVER HAPPENED. It is named after a step id
     * nothing else will ever mint, so leaving it would be bytes no screen in this
     * app could ever mention again — the exact state `planStepSweep` exists to
     * prevent at the other end of a step's life. `force` because the interesting
     * failure is the one being rethrown.
     */
    await fsp.rm(path.join(at.dir, ...payload.split('/')), { force: true });
    throw err;
  }
}

/**
 * AMEND — the tip edit step rewritten to what the pane now holds.
 *
 * ── Why this exists beside `applyBookOps` ───────────────────────────────────
 *
 * A second Apply while standing on an edit step with nothing under it used to
 * mint a sibling row, so five rounds of strike-and-apply read as five steps of
 * history about one sitting (user ruling, 2026-08-16). While the step is the
 * TIP — nothing landed under it, nothing made from it — its ops are still the
 * person's to change, so Apply rewrites the step's own file to the list the
 * pane holds now. That list can be SHORTER than what was recorded: the pane's
 * undo reaches back through applied ops precisely because this door can record
 * the removal. The moment anything lands under the step it freezes, this door
 * refuses by sentence, and the next Apply is a new row (`applyBookOps`).
 *
 * AN EMPTY LIST IS REFUSED. Undoing everything a step recorded and applying
 * that is deleting the step, and deletion has its own door in the tree with
 * its own question; a step whose file says nothing would be a row nobody can
 * tell from the one above it.
 *
 * WHO THE TIP IS IS MAIN'S ANSWER, NOT THE RENDERER'S. The pane asks to amend
 * "the position"; main re-derives that the position is an amendable tip at the
 * moment of the write (`recordBookEditAmend`, inside the manifest lock), so a
 * child that landed between the pane's load and its Apply meets a refusal
 * rather than a rewrite of a file that stopped being safe to rewrite.
 */
/**
 * VIEW A FINISHED EXPORT — the file exploded into a book file and handed to the
 * pane read-only, in the same shape `book:load` answers.
 *
 * ── The same derivation an imported EPUB gets, aimed at a temp cache ────────
 *
 * The iframe reader is deleted and stays deleted; what shows an EPUB now is the
 * proof sheet over `f(epub)`, which is honest in a way a rendering engine over
 * foreign markup never was — the pane draws exactly what the container holds,
 * through the one explode. The cache is keyed by the FILE'S OWN BYTES (sixteen
 * hex of sha-256), so a re-export at the same name views fresh and an unchanged
 * file explodes once; it lives in the OS temp directory because it is a viewing
 * artifact of a copy, not a fact about the project — the project's own book
 * files describe positions, and this file may be three Applies stale by design.
 *
 * GATED ON THE FINAL TRAY, exactly as `export:save-copy` is and for its reason:
 * this door exists so a person can look at the thing this app just filed, and
 * membership in a project's tray is the whole of that claim.
 */
export async function viewExportedBook(target: string): Promise<BookOutcome> {
  const resolved = path.resolve(target);
  const dir = exportInTray(resolved);
  if (dir === null || !resolved.toLowerCase().endsWith('.epub')) {
    return { ok: false, reason: 'This tab can only show one of this library’s exported books.' };
  }
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(resolved);
  } catch (err) {
    console.error(`[book] ${resolved} could not be read for viewing: ${(err as Error).message}`);
    return { ok: false, reason: 'This export could not be read back from the tray.' };
  }
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const cave = path.join(os.tmpdir(), 'foundry-view');
  await fsp.mkdir(cave, { recursive: true });
  const book = path.join(cave, `${sha}.book.jsonl`);
  if (!await exists(book)) {
    const made = await writeEpubBook(resolved, book);
    if (!made.ok) {
      console.error(`[book] ${resolved} would not explode for viewing: ${made.reason ?? ''}`);
      /*
       * THE ENGINE'S OWN SENTENCE REACHES THE PERSON. This used to say the
       * words were "in the terminal" — true at a dev prompt and false in every
       * packaged app, where console.error goes nowhere and the sentence that
       * names the defect (file, page, offset) is exactly the thing a person
       * has to relay to whoever can fix it. Measured cost of the omission: the
       * triple-emphasis export defect (2026-08-26) took a cross-repo session
       * to diagnose because the refusal that named c0016.xhtml and its offset
       * was printed to a terminal nobody had.
       */
      return {
        ok: false,
        reason: 'This export could not be opened as a book. The engine refused: '
          + (made.reason ?? 'no reason was given.'),
      };
    }
  }
  let parsed: BookFile;
  try {
    parsed = parseBookFile(await fsp.readFile(book, 'utf8'));
  } catch (err) {
    if (!(err instanceof BookFileError)) throw err;
    // A stale or half-written cache entry is swept and the next open remakes
    // it; the cache is nobody's record of anything.
    await fsp.rm(book, { force: true });
    console.error(`[book] the view cache for ${resolved} would not parse: ${err.message}`);
    return { ok: false, reason: 'This export could not be opened as a book. Try it again.' };
  }
  const manifest = await readManifest(dir);
  const figures = parsed.rows.some((row) => row.image !== undefined)
    ? figuresPrefixFor(path.join(cave, `${sha}.images`))
    : null;
  return {
    ok: true,
    title: manifest.title,
    language: parsed.header.language,
    rows: parsed.rows,
    chapters: parsed.header.chapters,
    typography: parsed.header.typography,
    seams: parsed.header.seams,
    loose: parsed.header.loose,
    figures,
    /*
     * NULL BY CONSTRUCTION, NOT BY OMISSION. This door explodes a finished EPUB
     * out of `final/` for reading, and an EPUB has never had pages — every row
     * it produces carries `page: 0`, the no-page frame. There is no scan behind
     * this book to peek at, and `BookLoad.originalPath` documents that silence
     * as one of its two ordinary meanings.
     */
    originalPath: null,
    ops: [],
    tip: null,
    translation: null,
  };
}
