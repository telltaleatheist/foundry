/**
 * book-pending — the pending stack of edits not yet saved, and amending ops.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { writeAtomically } from './atomic';
import { bookAtPosition, ledgerOf, opsDir, recordBookEditAmend, type LedgerView } from './projects';
import { positionOf } from '../shared/ledger';
import { BookOpsError, formatOpsFile, formatPendingStack, parseOpsFile, parsePendingStack, type BookOp, type PendingOutcome, type PendingStack, type PendingStackFile, type PendingStackHeader } from '../shared/ops';

export async function amendBookOps(projectDir: string, ops: readonly BookOp[]): Promise<LedgerView> {
  const at = await bookAtPosition(projectDir);
  if (ops.length === 0) {
    throw new BookOpsError(
      'Applying this would leave the step recording nothing — every change it held has been '
      + 'undone. Deleting the step is the tree\'s gesture, with its own question.',
    );
  }
  const bytes = formatOpsFile(ops);
  parseOpsFile(bytes);
  return await recordBookEditAmend(at.dir, bytes, ops.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// The pending stack on disk — the sidecar Apply is not
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `<project>/ops/pending.jsonl` — the working stack, continuously written.
 *
 * ── Why it lives in `ops/` beside the step payloads ─────────────────────────
 *
 * Because it is the same substance at an earlier moment. `opsDir`'s own comment
 * is the argument: what is in that folder is a RETAINED PAYLOAD, read again every
 * time a book is opened, and nothing in this app may treat what it finds there as
 * disposable — which is exactly the promise this file needs and exactly the
 * promise `working/` and `overlays/` do not make. A sweep cannot touch it either,
 * and not by luck: `planStepSweep` walks the payloads its doomed STEPS name, and
 * no step will ever name this one.
 *
 * A FIXED NAME AND NOT A UUID, which is the one way it differs from its
 * neighbours. Every other file in there is `<id8>.jsonl`, named after the step
 * that owns it, because there is one per step; there is exactly one working stack
 * per project — the app opens one book tab per project directory and one viewer
 * at a time — so a minted name would be a second thing to look up before the file
 * could be found, and an orphan the day the lookup went missing. Eight hex is
 * eight hex and `pending` is not, so it collides with nothing by construction.
 */
export function pendingStackFile(dir: string): string {
  return path.join(opsDir(dir), 'pending.jsonl');
}

/**
 * WHERE THE STACK WAS MADE, AS MAIN SEES IT — the two facts the header carries.
 *
 * Hashed and resolved HERE, on this side of the wall, for `loadBook`'s reason
 * word for word: the claim is the renderer's and the evidence is the project's,
 * and only the process holding both can put them side by side. A sidecar that
 * carried a renderer's own idea of which reading it was made from would prove
 * nothing at all — it would agree with itself.
 */
export async function pendingIdentity(projectDir: string): Promise<PendingStackHeader & { dir: string }> {
  const at = await bookAtPosition(projectDir);
  const ledger = ledgerOf(at.manifest);
  return { dir: at.dir, step: positionOf(ledger)?.id ?? null, receipt: await receiptSha(at.receipt) };
}

/**
 * The receipt's sha, REMEMBERED while the file has not moved — and only for the
 * sidecar.
 *
 * ── Why a memo exists here and must not exist in `loadBook` ─────────────────
 *
 * A bank is the whole of a book's reading: a few megabytes for a pamphlet and
 * tens of them for anything with pages. `loadBook` hashes it ONCE, when a book is
 * opened, and that cost is invisible beside the read it is part of. The sidecar
 * is written every four hundred milliseconds of somebody striking paragraphs, and
 * re-hashing tens of megabytes on that cadence would put a measurable stall in
 * main between every gesture and the next — for a value that cannot have changed,
 * because the bank a person is editing over is not being rewritten while they
 * edit over it.
 *
 * KEYED BY MTIME AND SIZE, which is the standard trade and it is worth naming
 * what it costs: a rewrite that produced a file of exactly the same length with
 * exactly the same modification time would be missed, and the sidecar would carry
 * the old sha. That is not the app's integrity check and never was —
 * `loadBook`'s is, it is uncached, and it refuses the whole book before a pane
 * ever gets far enough to ask for a recovery. This one is the second gate behind
 * it, and a second gate is allowed to be cheap.
 */
export const receiptShas = new Map<string, { mtimeMs: number; size: number; sha: string }>();

export async function receiptSha(receipt: string): Promise<string> {
  const stat = await fsp.stat(receipt);
  const held = receiptShas.get(receipt);
  if (held !== undefined && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held.sha;
  const sha = createHash('sha256')
    .update(await fsp.readFile(receipt))
    .digest('hex')
    .slice(0, 16);
  receiptShas.set(receipt, { mtimeMs: stat.mtimeMs, size: stat.size, sha });
  return sha;
}

/**
 * WRITE THE WORKING STACK DOWN — the door the pane's debounce ends at.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 *
 * It is not an Apply and it does not touch the ledger. Nothing about this file is
 * history: no step names it, no replay reads it, and standing anywhere in the
 * tree draws the same book whether it exists or not. What it is is the answer to
 * "where is the only copy of the work somebody has not applied yet", which used
 * to be "the renderer's heap, until the window closes".
 *
 * ATOMICALLY, by `applyBookOps`' argument at its own scale: this is written every
 * four hundred milliseconds of somebody's afternoon, so an interrupted write must
 * leave the last whole stack rather than half of the current one. Half a file of
 * ops is a recovery that puts back the first two thirds of an edit.
 *
 * AN EMPTY STACK CLEARS RATHER THAN WRITES. The pane calls this whenever its
 * stack changes and "changed back to nothing waiting" is one of those changes; a
 * file saying "no changes" left lying in `ops/` is a recovery prompt for work
 * that does not exist.
 */
export async function savePendingStack(projectDir: string, stack: PendingStack): Promise<void> {
  const identity = await pendingIdentity(projectDir);
  if (stack.kept === 0 && stack.tail.length === 0 && stack.undone.length === 0) {
    await fsp.rm(pendingStackFile(identity.dir), { force: true });
    return;
  }
  const bytes = formatPendingStack({ ...identity, ...stack });
  // The round trip is the proof, exactly as it is for a step's payload: a shape
  // this build cannot replay is refused before it is on anybody's disk rather
  // than by every recovery from now on.
  parsePendingStack(bytes);
  await fsp.mkdir(opsDir(identity.dir), { recursive: true });
  await writeAtomically(pendingStackFile(identity.dir), Buffer.from(bytes, 'utf8'));
}

/**
 * READ THE WORKING STACK BACK, and refuse it out loud when it is not this book's.
 *
 * ── Never a silent adoption, and never a silent scrap ───────────────────────
 *
 * Both halves are rulings. Adopting a stack made at another position would
 * replay somebody's strikes onto a document they made no decision about — the
 * same failure the parked stack's revision test exists to prevent, one process
 * over. Dropping it without a word is the failure this whole file was written
 * for. So a stack that does not apply comes back as a REFUSAL WITH A COUNT, and
 * the pane says how much was let go.
 *
 * THE PATH IS IN THE SENTENCE, and only in this one. This app keeps filenames out
 * of user-facing copy; a failure notice is the standing exception, because the
 * one useful thing about a file that will not read is where it is.
 */
export async function readPendingStack(projectDir: string): Promise<PendingOutcome> {
  const identity = await pendingIdentity(projectDir);
  const file = pendingStackFile(identity.dir);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    // Nothing held is not a failure and is the ordinary answer: most books have
    // never had an unapplied change on them.
    return { ok: true, stack: null };
  }
  let held: PendingStackFile;
  try {
    held = parsePendingStack(text);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    return {
      ok: false,
      reason: `${err.message} The file is ${file}.`,
      /*
       * ZERO, AND THE SENTENCE CARRIES THE WEIGHT INSTEAD. A file that would not
       * parse has no trustworthy count in it, and inventing one so the notice
       * could say "4 changes" would be this app naming a loss it cannot measure.
       */
      held: 0,
    };
  }
  const lost = held.kept + held.tail.length;
  if (held.receipt !== identity.receipt) {
    return {
      ok: false,
      reason: 'Changes were being held for this book, and what the book is made from has changed '
        + 'since they were made — so the blocks they name may no longer be there and they are not '
        + `put back. They are still in ${file}.`,
      held: lost,
    };
  }
  if (held.step !== identity.step) {
    return {
      ok: false,
      reason: 'Changes were being held for this book at another step. Changes are a difference '
        + 'against the step they were made on, so they are not put back here — stand on the step '
        + `you made them at to pick them up. They are held in ${file}.`,
      held: lost,
    };
  }
  return { ok: true, stack: { kept: held.kept, tail: held.tail, undone: held.undone } };
}

/**
 * THROW THE HELD STACK AWAY — the one sanctioned scrap.
 *
 * TWO CALLERS AND BOTH ARE A PERSON SPEAKING: an Apply, which has just written
 * every one of these decisions down as a step, and the closing card's Discard,
 * which is somebody reading a sentence about what they are about to lose and
 * pressing the red button anyway. Nothing else in this app may reach it — the
 * whole point of the file is that no window closing, no crash and no glance at
 * another tab can.
 *
 * `force`, because "there was nothing to throw away" is a successful throw away.
 */
export async function clearPendingStack(projectDir: string): Promise<void> {
  const at = await bookAtPosition(projectDir);
  await fsp.rm(pendingStackFile(at.dir), { force: true });
}
