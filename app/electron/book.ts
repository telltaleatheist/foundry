/**
 * book — the book file, made if it is not there, read, and handed to the pane.
 *
 * ── Why this is a module and not four lines in main.ts ──────────────────────
 *
 * Because it is three separate pieces of knowledge that each belong to somebody
 * else, and the only thing this file adds is the ORDER they go in. Where the file
 * lives is `projects.ts`'s (every path in a project is composed there, once, so a
 * branch read cannot end up answering for the other reading's bank). How to run
 * the engine is `engine.ts`'s (this app never imports foundry; it spawns it). What
 * the file's grammar is belongs to `shared/book.ts`, which mirrors the engine's own
 * writer. main.ts registers the door and knows none of it — which is the shape
 * `overlays.ts` and `workspace.ts` already have.
 *
 * ── ENSURING THE FILE IS ALSO THE MIGRATION, AND THAT IS DELIBERATE ─────────
 *
 * Every project in the library predates this format: they hold a bank and no book
 * file at all. Nothing has to be migrated for them, because the book file is
 * DERIVED — the bank is the reset point and the reflow is seconds of arithmetic
 * over it — so "open a read position" and "produce the book file for the first
 * time" are one code path and there is no second one to keep true
 * (docs/RENDERER.md §9, R2).
 *
 * IT IS MADE ONLY WHEN IT IS ABSENT. A book file that exists is the one the ops
 * are keyed to, and re-running the reflow over it because a pane was opened would
 * be this process rewriting the document somebody is editing every time they look
 * at it. Regenerating on purpose is a different gesture and it is not this one.
 *
 * ── THE BANK'S IDENTITY IS CHECKED ON EVERY OPEN ────────────────────────────
 *
 * The book file is a pure function of the receipt, and its header carries the
 * receipt's identity (`source.bankSha`, docs/BOOK-FILE.md §2). A loader that
 * finds the bank has changed under the book is holding ids that may name
 * nothing, and the contract's answer is the one given here: REFUSE BY NAME, as
 * a sentence, and let the one door that may rebuild do it as an announced
 * action. That door is the read-landing orchestration's, not this open.
 *
 * ── Every failure is a sentence, and it carries no path ─────────────────────
 *
 * What comes back from here goes onto the paper (RENDERER-DESIGN.md §5: errors
 * render as main's own sentence on the sheet, never a toast), and the house rule
 * is that a filename never appears in copy a person reads. So the sentence names
 * the BOOK's problem and the terminal gets the path — which is where somebody
 * debugging their own library goes looking, and the one place it is any use.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { writeBookFile } from './engine';
import { writeAtomically } from './epub-writer';
import {
  bookAtPosition,
  imagesDirFor,
  ledgerOf,
  opsDir,
  opsPayloadFor,
  recordBookEdit,
  type LedgerView,
} from './projects';
import { BookFileError, parseBookFile, type BookOutcome } from '../shared/book';
import { editsInEffect } from '../shared/ledger';
import { BookOpsError, formatOpsFile, parseOpsFile, type BookOp } from '../shared/ops';

/** Does this path exist? Nothing else about it is asked. */
async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/*
 * ── The figures door ─────────────────────────────────────────────────────────
 *
 * A Picture row names its crop by NAME, and the renderer is a page under a CSP
 * that loads images off the `foundry-file:` scheme and nowhere else on disk —
 * the same posture the EPUB viewer's chapters have always had. So a successful
 * load REGISTERS the book's image directory under an opaque token, hands the
 * pane `foundry-file://book/<token>/` as a prefix, and the protocol handler
 * (main.ts) asks this table before it serves a byte. An ALLOW-LIST, not a path
 * scheme: a URL the renderer invents for a directory nothing registered is a
 * 403, which is `resolveEpubMember`'s exact decision one surface over.
 *
 * The token is minted per DIRECTORY and reused across reloads, so the map stays
 * the size of the library rather than growing with every glance at a pane.
 */
const figureTokens = new Map<string, string>();
const figureDirs = new Map<string, string>();

function figuresPrefixFor(imagesDir: string): string {
  const known = figureTokens.get(imagesDir);
  if (known !== undefined) return `foundry-file://book/${known}/`;
  const token = randomUUID();
  figureTokens.set(imagesDir, token);
  figureDirs.set(token, imagesDir);
  return `foundry-file://book/${token}/`;
}

/**
 * The file behind `foundry-file://book/<token>/<name>`, or null for anything
 * this process never agreed to serve.
 *
 * THE NAME MUST BE A PLAIN BASENAME. The engine writes the crops flat into one
 * directory (`p<page>-<order>.png`), so a separator in the name is not a figure
 * this app cut — it is a traversal, and it meets the same null as an unknown
 * token rather than a resolve() that might climb.
 */
export function bookFigureFile(token: string, name: string): string | null {
  const dir = figureDirs.get(token);
  if (dir === undefined) return null;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return path.join(dir, name);
}

/**
 * The book at this project's position — reflowed first if nothing has reflowed it.
 *
 * NEVER ANSWERS EMPTY. A pane with no rows in it and no sentence is
 * indistinguishable from a book with nothing in it, and the two want opposite
 * things from the person looking at them — so every way this can fail comes back
 * as `{ok: false}` carrying words to put on the paper (`BookOutcome`).
 *
 * IT STILL REJECTS FOR A DIRECTORY THAT IS NOT A PROJECT. That is the security
 * gate refusing, not the book being unavailable, and it must not be renderable as
 * a polite sentence in a pane.
 */
export async function loadBook(projectDir: string): Promise<BookOutcome> {
  const at = await bookAtPosition(projectDir);

  if (!await exists(at.book)) {
    /*
     * THE BANK IS PROVEN BEFORE THE ENGINE IS SPAWNED, so that "this project has
     * never been read" is answered in words rather than as whatever the command
     * says about a file it could not open. It is the ordinary state of a project
     * somebody imported five minutes ago and it is not a failure of anything.
     */
    if (!await exists(at.bank)) {
      return {
        ok: false,
        reason: 'This book has not been read yet, so there is nothing to open. Read its pages '
          + 'first and the book is made from them.',
      };
    }
    const made = await writeBookFile(at.bank, at.book, { pdfPath: at.pdf, language: at.language });
    if (!made.ok) {
      // The engine's own words to the terminal, with the paths that make them
      // actionable; the sentence the person reads says what happened to the book.
      console.error(`[book] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}`);
      return {
        ok: false,
        reason: 'The pages this book was read from could not be turned into a book. The engine '
          + 'refused, and its own words are in the terminal.',
      };
    }
  }

  let text: string;
  try {
    text = await fsp.readFile(at.book, 'utf8');
  } catch (err) {
    console.error(`[book] ${at.book} could not be read: ${(err as Error).message}`);
    return { ok: false, reason: 'This book was made and then could not be read back.' };
  }

  try {
    const parsed = parseBookFile(text);
    /*
     * THE RECEIPT'S IDENTITY, CHECKED AGAINST THE RECEIPT — see the module
     * header. Hashed here, on this side of the wall, because the claim is the
     * book file's and the evidence is the bank's, and only the process holding
     * both can put them side by side. The same sixteen hex the engine writes
     * (`bankSha`, src/vlm/book-run.ts), by the grow-together rule.
     */
    const sha = createHash('sha256')
      .update(await fsp.readFile(at.bank))
      .digest('hex')
      .slice(0, 16);
    if (parsed.header.source.bankSha !== sha) {
      console.error(
        `[book] ${at.book} was made from a bank whose sha-256 began ${parsed.header.source.bankSha}, `
        + `and ${at.bank} now begins ${sha}.`,
      );
      return {
        ok: false,
        reason: 'The pages underneath this book have changed since the book was made from them, so '
          + 'its blocks may no longer name what is really there. It is not opened over a moved '
          + 'foundation; reading the project again remakes it.',
      };
    }
    /*
     * The figures prefix is minted only when a row will ask for one. `null` is
     * the pane's ordinary answer for a book with no cut images — no --pdf at
     * reflow, or no pictures in the book — and the plate placeholder is what
     * draws in that silence.
     */
    const figures = parsed.rows.some((row) => row.image !== undefined)
      ? figuresPrefixFor(imagesDirFor(at.bank))
      : null;
    /*
     * THE CHAIN, AND IT IS A REFUSAL RATHER THAN A BEST EFFORT.
     *
     * Every edit step on the path from this reading to the position retained a
     * file of ops, and what the person is looking at is that book with all of them
     * replayed over it, in order (docs/RENDERER.md §3). A step whose file will not
     * open or will not parse leaves this process holding two thirds of somebody's
     * history — and drawing the book from the two thirds is the worst outcome
     * available, because the sheet would look perfectly ordinary while the strikes
     * from one Apply were silently absent and the next Apply recorded a delta
     * against a state that never existed. So the whole load refuses, by the step's
     * own name, and the sentence keeps the path out of it.
     */
    const chain: BookOp[] = [];
    for (const step of editsInEffect(ledgerOf(at.manifest))) {
      const file = path.join(at.dir, ...step.payload.split('/'));
      let said: string;
      try {
        said = await fsp.readFile(file, 'utf8');
      } catch (err) {
        console.error(`[book] ${file} is the payload of step ${step.id} and could not be read: ${(err as Error).message}`);
        return {
          ok: false,
          reason: `The changes recorded as “${step.label}” could not be read, so this book cannot be `
            + 'drawn honestly — everything applied after them depends on them. Its own history is '
            + 'intact; the file behind that row is not.',
        };
      }
      try {
        chain.push(...parseOpsFile(said));
      } catch (err) {
        if (!(err instanceof BookOpsError)) throw err;
        console.error(`[book] ${file} is the payload of step ${step.id} and is not a list of changes: ${err.message}`);
        return {
          ok: false,
          reason: `The changes recorded as “${step.label}” are not changes this build can read: ${err.message}`,
        };
      }
    }
    return {
      ok: true,
      // THE TITLE IS THE PROJECT'S. A book file is a list of blocks and has no
      // idea what the book is called; the catalogue is where that has lived for
      // every other surface in this app (`ProjectsService.nameFor`).
      title: at.manifest.title,
      language: parsed.header.language,
      rows: parsed.rows,
      chapters: parsed.header.chapters,
      typography: parsed.header.typography,
      seams: parsed.header.seams,
      loose: parsed.header.loose,
      figures,
      ops: chain,
    };
  } catch (err) {
    if (err instanceof BookFileError) {
      console.error(`[book] ${at.book} is not a book this app can read: ${err.message}`);
      // The parser's sentences are written to be read by a person and name blocks
      // rather than files, so this passes them through instead of paraphrasing.
      return { ok: false, reason: `This book could not be opened: ${err.message}` };
    }
    throw err;
  }
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
 * electron/epub-writer.ts): a rename is atomic on one volume, so an interrupted
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
