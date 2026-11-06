/**
 * book-open — opening the book at a position, and making sure the book file it opens exists: a reading's, a text pass's, a translation's. These call one another, so they live together.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { writeBookFile, writeEpubBook } from './engine';
import { writeAtomically } from './atomic';
import { CurateBridgeError, rekeyCuration } from '../shared/curate-bridge';
import { bookAtPosition, ledgerOf, translationBookFileFor, type LedgerView } from './projects';
import { BookFileError, formatBookFile, parseBookFile, type BookFile } from '../shared/book';
import { editsSinceTransform, positionOf, textPassInEffect, translationRecordsOf } from '../shared/ledger';
import { materialize, translated } from '../shared/materialize';
import { BookOpsError, parseOpsFile, type BookOp } from '../shared/ops';
import { parseRecordsFile, RecordsFileError, translationWords, type TranslationRow } from '../shared/records';
import type { LedgerStep } from '../shared/types';
import { exists, figuresHealed, figuresMissing } from './book-figures';

/**
 * The book file at the position, parsed, with the chain of ops that stands on it.
 *
 * ── ONE WALK, THREE READERS, AND THE OTHERS ARE WHY THIS EXISTS ─────────────
 *
 * `loadBook` below draws this for a person; `materializeBook` writes the same
 * answer out as a file for the engine to compile or to translate
 * (docs/RENDERER.md §6); `writeTranslationBook` builds the parent half of a
 * derived translation out of it (§4). All three need the identical sequence —
 * find the book file this position is about, ensure it, read it, prove the bank
 * has not moved under its ids, then walk the edit steps still to be replayed and
 * read every payload — and every one of those steps has a refusal attached to it
 * that is written to be read. Spelling it three times would be three answers to
 * "what is this book and what has been done to it", which is exactly the failure
 * the single replay exists to make impossible.
 *
 * NEVER ANSWERS EMPTY, and never throws for anything a person can be told about:
 * every way this can fail comes back carrying words to put on the paper.
 *
 * IT STILL REJECTS FOR A DIRECTORY THAT IS NOT A PROJECT. That is the security
 * gate refusing, not the book being unavailable, and it must not be renderable as
 * a polite sentence in a pane.
 */
export interface OpenedBook {
  at: Awaited<ReturnType<typeof bookAtPosition>>;
  /**
   * The file this book was read out of — the reading's reflow, or a translation's
   * derived book. Carried so that a log line names the file that was actually
   * opened rather than the one at the foot of the chain.
   */
  path: string;
  parsed: BookFile;
  /**
   * Every change still to be replayed — the edits made since the file above was
   * written, which is since the reading for an ordinary position and since the
   * TRANSLATION for one standing under a transform. See `editsSinceTransform`.
   */
  ops: BookOp[];
  /**
   * The AMENDABLE TIP's own ops, or null where the position has none — see the
   * comment where it is decided. Not in `ops`: the pane replays these under the
   * chain itself, because they are still its stack.
   */
  tip: BookOp[] | null;
  /**
   * The translate step this position stands under, or null.
   *
   * CARRIED RATHER THAN ASKED AGAIN. It is what decided which file was opened
   * three fields up, and every caller that needs to know "are these words a
   * translation's" needs the SAME answer that decision was made with — the
   * aligned view's source column, and the correction door that will not let a
   * text op fork a translated block. Walking the ledger a second time would be a
   * second opinion about a question this function has already answered.
   */
  transform: LedgerStep | null;
  /**
   * What a `curate` step on this path decided and this book has nowhere to put —
   * absent when there is nothing to say, which is every chain made of `edit`
   * rows. See `BookLoad.unplaced`, which is where these sentences are going.
   */
  unplaced?: string[];
}

export async function openBookAtPosition(
  projectDir: string,
  /**
   * THE STEP TO ANSWER FOR, when it is not the position — `nearestUpward`'s own
   * parameter, arriving here for the reason it exists. A translation's derived
   * book is materialised by a LANDING, and a landing runs while the pointer is
   * wherever the person happens to be standing; a book built for that step out of
   * whatever position they had clicked onto would be another branch's book under
   * this step's name. Null and absent both mean the position.
   */
  from: LedgerStep | null = null,
): Promise<{ ok: true; opened: OpenedBook } | { ok: false; reason: string }> {
  const at = await bookAtPosition(projectDir, from);
  const ledger = ledgerOf(at.manifest);

  /*
   * ── WHICH BOOK FILE THIS POSITION IS ABOUT ─────────────────────────────────
   *
   * *"Downstream positions read the NEAREST ancestor book file, so replay is
   * always one short hop."* (docs/RENDERER.md §4.) Standing anywhere under a
   * translation, the book is that translation's DERIVED file — same ids, struck
   * rows already absent, the words in the language that was asked for — and the
   * ops replayed on top are only the ones made since it, because everything above
   * it was baked in when it was written (`editsSinceTransform`, shared/ledger.ts).
   * With no translation on the path the nearest ancestor is the reading's own
   * reflow, which is what this has always opened.
   */
  /*
   * THE NEAREST TEXT PASS AND NOT THE NEAREST TRANSLATION. This asked
   * `translationInEffect`, which is now the LANGUAGE question and walks past a
   * cleanup by design — so left as it was, standing under a narration cleanup
   * would have opened the derived book of the translation ABOVE it and drawn the
   * uncleaned words under a row that says they were cleaned. `textPassInEffect`
   * asks the question this line has always meant: which file of answers are the
   * words in the blocks here out of (shared/ledger.ts argues both).
   */
  const transform = textPassInEffect(ledger, from);
  const source = transform === null
    ? await ensureReadingBook(at)
    : await ensureTextPassBook(at, ledger, transform);
  if (!source.ok) return source;

  let text: string;
  try {
    text = await fsp.readFile(source.path, 'utf8');
  } catch (err) {
    console.error(`[book] ${source.path} could not be read: ${(err as Error).message}`);
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
     *
     * IT IS THE SAME CHECK ON A DERIVED FILE, AND IT IS STILL THE RIGHT ONE. A
     * derived book carries the source's `source` block verbatim, sha and all
     * (`materialize`, and `translated` beside it), because the bank underneath did
     * not move when somebody replayed a strike or translated a paragraph — the ids
     * in a translated file still name blocks of that reading's answers. So a bank
     * that HAS moved invalidates the translation's ids exactly as it invalidates
     * the reading's, and it is caught here, once, for both.
     *
     * AND THE RECEIPT IS NOT ALWAYS A BANK. A project that arrived as an EPUB has
     * none: its book is exploded out of the container, so the CONTAINER is what
     * `source.bankSha` is a hash of (docs/RENDERER.md §6 — the EPUB is the
     * receipt, archived immutable, `book = f(epub)`). `bookAtPosition` names
     * whichever it is, so this check reads one field and stays one check —
     * splitting it in two would be two answers to "has the foundation moved".
     */
    const sha = createHash('sha256')
      .update(await fsp.readFile(at.receipt))
      .digest('hex')
      .slice(0, 16);
    if (parsed.header.source.bankSha !== sha) {
      console.error(
        `[book] ${source.path} was made from a receipt whose sha-256 began `
        + `${parsed.header.source.bankSha}, and ${at.receipt} now begins ${sha}.`,
      );
      return {
        ok: false,
        reason: 'What this book was made from has changed since it was made, so its blocks may no '
          + 'longer name what is really there. It is not opened over a moved foundation; making the '
          + 'book again from the original remakes it.',
      };
    }
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
    /**
     * WHAT AN OLD SAVE COULD NOT SAY ABOUT THIS BOOK, gathered as the chain is
     * built and handed up with it. Empty for every project made under the op
     * grammar, which is why it is a list rather than a flag: the sheet says one
     * sentence per decision it could not place, and says nothing at all when
     * there is nothing to say (`rekeyCuration`, shared/curate-bridge.ts).
     */
    const unplaced: string[] = [];
    const steps = editsSinceTransform(ledger, from);
    /*
     * ── THE TIP — the one step whose ops are still the person's to change ─────
     *
     * An edit step the position stands ON with nothing landed under it is not
     * history yet: nothing depends on it, so a further Apply AMENDS it rather
     * than stacking a sibling row (user ruling, 2026-08-16), and the undo stack
     * reaches back through what it recorded. Its ops are therefore handed up
     * SEPARATELY — the pane hydrates its stack from them and replays them under
     * the chain itself — and they are not in `ops`, or they would replay twice.
     * The moment anything lands under the step (a translate, a child edit), it
     * freezes into the chain like every row above it, because rewriting a file
     * another step was made from would be editing history someone stood on.
     */
    const standing = positionOf(ledger);
    const last = steps[steps.length - 1];
    const amendable = last !== undefined
      && last.action === 'edit'
      && standing !== null && standing.id === last.id
      && !ledger.steps.some((step) => step.parent === last.id);
    let tip: BookOp[] | null = null;
    for (const step of steps) {
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
      /*
       * ── A SAVE MADE BEFORE THE OP GRAMMAR IS READ THROUGH THE BRIDGE ────────
       *
       * A `curate` step's payload is `curations/<uuid>.json`: a frozen curation,
       * keyed by the model's own `(page, order)` coordinates, written by a system
       * that no longer exists. Its decisions are the same decisions — struck
       * blocks, retyped lines, a chapter spine — so they are re-keyed onto this
       * book through the `src` column the format carries for exactly this and
       * replayed as ops (docs/RENDERER.md §8; `rekeyCuration`).
       *
       * NOTHING IS REWRITTEN ON DISK BY THIS. The snapshot is that row's payload
       * and it is irreplaceable (`RETENTION_OF`); re-keying at the moment the
       * book is opened means the ledger keeps saying exactly what it always said
       * and the person sees the book that row is about. The alternative — walking
       * everybody's library converting payloads in place — would be this app
       * editing history to make its own reading easier.
       */
      if (step.action === 'curate') {
        let snapshot: unknown;
        try {
          snapshot = JSON.parse(said);
        } catch (err) {
          console.error(`[book] ${file} is the payload of step ${step.id} and is not JSON: ${(err as Error).message}`);
          return {
            ok: false,
            reason: `The decisions recorded as “${step.label}” could not be read, so this book cannot `
              + 'be drawn honestly — everything applied after them depends on them.',
          };
        }
        try {
          const rekeyed = rekeyCuration(snapshot, parsed);
          chain.push(...rekeyed.ops);
          for (const one of rekeyed.unplaced) {
            unplaced.push(`“${step.label}” holds ${one}.`);
          }
        } catch (err) {
          if (!(err instanceof CurateBridgeError)) throw err;
          console.error(`[book] ${file} is the payload of step ${step.id}: ${err.message}`);
          return {
            ok: false,
            reason: `“${step.label}” is a row this build cannot read: ${err.message}.`,
          };
        }
        continue;
      }
      try {
        const read = parseOpsFile(said);
        if (amendable && step.id === last.id) tip = read;
        else chain.push(...read);
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
      opened: {
        at, path: source.path, parsed, ops: chain, tip, transform,
        ...(unplaced.length > 0 ? { unplaced } : {}),
      },
    };
  } catch (err) {
    if (err instanceof BookFileError) {
      console.error(`[book] ${source.path} is not a book this app can read: ${err.message}`);
      // The parser's sentences are written to be read by a person and name blocks
      // rather than files, so this passes them through instead of paraphrasing.
      return { ok: false, reason: `This book could not be opened: ${err.message}` };
    }
    throw err;
  }
}

/**
 * The reading's own reflow, made if nothing has made it — the module header's
 * "ENSURING THE FILE IS ALSO THE MIGRATION", unchanged and now named.
 */
export async function ensureReadingBook(
  at: Awaited<ReturnType<typeof bookAtPosition>>,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (await exists(at.book)) {
    /*
     * ── THE BOOK IS THERE AND ITS FIGURES ARE NOT ──────────────────────────────
     *
     * ONE CONDITION, and it is the ensure step doing its job with information it
     * did not have before: this project HAS a scan now, and the book beside it
     * was made by a run that was given none. Every other book takes the same
     * `return` it always took, on the same line, having done nothing.
     *
     * THE SOURCE IS `at.pdf` AND NOTHING ELSE SINCE WAVE 41. It used to be
     * `at.pdf ?? at.pages`, because a captured project's archive was a folder;
     * `bookAtPosition` heals one into a PDF before it composes this, and the two
     * fields are one field again. The engine keeps its `--pages` face — this side
     * simply has no caller for it.
     *
     * IT COSTS SECONDS AND IT CHANGES NO ID. A book file is a pure function of
     * the bank and re-running the reflow over the same bank mints the same names
     * for the same blocks (docs/BOOK-FILE.md §2), so the ops keyed to them still
     * name what they named. What changes is that the Picture rows come back with
     * their crops on the disk, which is the whole difference between a book that
     * exports and one that refuses.
     *
     * A REFUSAL IS LOGGED AND THE OLD BOOK IS OPENED, which is the posture the
     * branch below argues for at length: the engine writes atomically, so a
     * failed remake leaves the book that was already there intact, and refusing
     * to draw it would take a working position down over a picture.
     */
    const source = at.pdf;
    const key = path.resolve(at.book).toLowerCase();
    if (source !== null && !figuresHealed.has(key) && await figuresMissing(at.book)) {
      figuresHealed.add(key);
      console.warn(
        `[book] ${at.book} was made without the pages its figures are cut from, and ${source} is `
        + 'there now, so the book is being made again. Same bank, same block ids; the pictures come '
        + 'back with it.',
      );
      const healed = await writeBookFile(at.bank, at.book, {
        pdfPath: at.pdf,
        language: at.language,
      });
      if (!healed.ok) {
        console.error(
          `[book] ${at.book} could not be made again with its figures: ${healed.reason ?? ''}\n`
          + 'The book already on the disk is what is being shown; its pictures are still uncut.',
        );
      }
    }
    return { ok: true, path: at.book };
  }
  /*
   * ── A PROJECT THAT ARRIVED AS A BOOK IS EXPLODED, NOT READ ─────────────────
   *
   * There is no bank under an imported EPUB and there never will be: a bank
   * models pages and an EPUB has none, so re-reading its real text through a
   * vision model would trade exact data for a guess at it (docs/RENDERER.md §6,
   * the refinement paragraph). The container is the receipt, `book = f(epub)`,
   * and the engine writes the same book file out of it — same format, same ids,
   * same everything downstream. It lands at the same path for the same reason:
   * `bookAtPosition` names it after the bank that would have been there, so
   * nothing else in this process has to know which kind of book it is holding.
   */
  if (at.epub !== null) {
    if (!await exists(at.epub)) {
      return {
        ok: false,
        reason: 'The book this project was made from is not in its archive, so there is nothing to '
          + 'open. It is the one file here that cannot be made again.',
      };
    }
    console.warn(`[book] ${at.book} is not there and ${at.epub} is, so the book is being exploded now.`);
    const made = await writeEpubBook(at.epub, at.book);
    if (!made.ok) {
      console.error(`[book] ${at.epub} could not be exploded into ${at.book}: ${made.reason ?? ''}`);
      return {
        ok: false,
        reason: 'The book this project was made from could not be taken apart into blocks. The engine '
          + 'refused, and its own words are in the terminal.',
      };
    }
    return { ok: true, path: at.book };
  }
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
  /*
   * THE PAGES, AND THERE IS ONE SHAPE OF THEM AGAIN. This passed `pdfPath` and
   * `pagesPath` between `ecbf238` and Wave 41, because a manifest could name a
   * FOLDER of photographs as its archive and `bookAtPosition` split that into two
   * fields. It names a PDF either way now — a mint writes one and an older
   * project is healed into one — so a scanned book and a photographed book reach
   * the reflow through the same argument.
   */
  const made = await writeBookFile(at.bank, at.book, {
    pdfPath: at.pdf,
    language: at.language,
  });
  if (!made.ok) {
    // The engine's own words to the terminal, with the paths that make them
    // actionable; the sentence the person reads says what happened to the book.
    console.error(`[book] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}`);
    /*
     * ── A REFUSAL WITH A BOOK ON THE DISK IS A DIFFERENT FACT, AND THE OLD
     *    SENTENCE TOLD SOMEBODY THE OPPOSITE OF IT ────────────────────────────
     *
     * There are two ways to arrive here with a file at `at.book` even though the
     * check at the top of this function found none. The reflow is written
     * atomically — a temp file beside the target, then a rename (src/vlm/book-run
     * writes it that way on purpose) — so a run that fails leaves WHATEVER WAS
     * THERE BEFORE completely intact. And the window between that `exists` and
     * this call is real: `remakeBookFile` may land its own rename inside it, in
     * which case the file this run then failed to overwrite is the good one that
     * landing just wrote.
     *
     * The sentence that used to be here — "the pages this book was read from
     * could not be turned into a book" — is a statement about the READING, and it
     * is false in this branch. A person who reads it about a project whose book is
     * sitting right there concludes that hours of GPU produced nothing and goes
     * and runs them again. That is the most expensive wrong answer this app is
     * capable of giving.
     *
     * SO THE BOOK ON THE DISK IS OPENED, and the refusal goes to the terminal
     * beside the engine's own words — which is exactly `remakeBookFile`'s posture
     * (electron/job-queue.ts) for the same event on the other side of the wall,
     * and it is safe for a reason that is not "probably fine": the loader hashes
     * the receipt and refuses any book whose `bankSha` no longer matches it, by
     * name, a few lines further down. If this file is the reflow of a bank that
     * has since moved, the person gets that refusal and its accurate sentence
     * rather than a stale book drawn as a current one. If it matches, it IS the
     * current book, and refusing to draw it because a redundant second attempt to
     * make it again failed would be this app arguing with a file it had already
     * finished making.
     */
    if (await exists(at.book)) {
      console.error(
        `[book] ${at.book} could not be made again, so the one already on the disk is what is being `
        + 'shown. Nothing about the reading is lost; if that book was made from an older bank the '
        + 'load refuses it by name a moment from now.',
      );
      return { ok: true, path: at.book };
    }
    return {
      ok: false,
      reason: 'The pages this book was read from could not be turned into a book. The engine '
        + 'refused, and its own words are in the terminal.',
    };
  }
  return { ok: true, path: at.book };
}

/**
 * A TRANSLATION'S OWN BOOK FILE, made if nothing has made it.
 *
 * ── The ensure posture, and why a translation gets it too ───────────────────
 *
 * A derived book file is written by the LANDING — the moment the records file
 * exists, main materialises the book beside it (`materializeTextPass`, and the
 * translate arm of electron/job-queue.ts) — so in the ordinary course this finds
 * the file and returns. What it is here for is every translation recorded BEFORE
 * that was true: the records are on disk, the book that would have been made from
 * them is not, and the alternative to making it now is a pane that cannot draw a
 * step somebody paid hours of GPU for. It is exactly `ensureReadingBook`'s
 * argument one transform along, and it is announced in the log for the same
 * reason: a file appearing in `readings/` is something the person's own terminal
 * should be able to account for.
 *
 * A TRANSLATION WITH NO RECORDS CANNOT BE SHOWN, and that is a sentence rather
 * than a repair. `translationRecordsOf` answers null for a row made by the old
 * EPUB→EPUB translator, whose words exist only inside the book that run wrote —
 * there is no per-block anything to materialise from, and inventing one would
 * mean re-parsing an EPUB into blocks that were never named. The step still has
 * its own book and the EPUB pane still opens it; what this surface cannot do is
 * draw it.
 */
export async function ensureTextPassBook(
  at: Awaited<ReturnType<typeof bookAtPosition>>,
  ledger: LedgerView['ledger'],
  transform: LedgerStep,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const records = translationRecordsOf(transform);
  if (records === null) {
    return {
      ok: false,
      reason: `“${transform.label}” was made before Foundry kept a translation as words it can put `
        + 'back block by block, so there is no book of it to draw. Its own document is still here, '
        + 'and translating again from the step it was made from puts it on the proof sheet.',
    };
  }
  const recordsFile = path.join(at.dir, ...records.split('/'));
  const book = translationBookFileFor(recordsFile);
  if (await exists(book)) {
    /*
     * ── THE SAME ONE CONDITION, ONE TRANSFORM ALONG ────────────────────────────
     *
     * A derived book's Picture rows name the READING's crops (nothing about a
     * translation moves a pixel), so a translation materialised over a book whose
     * figures were never cut carries the same hole — and exporting from a
     * translated position meets the same refusal. Remaking it costs no engine and
     * no model at all: it is the parent book plus the ops plus the records,
     * replayed, and `writeTranslationBook` opens that parent through
     * `openBookAtPosition`, which runs `ensureReadingBook` — so the reading's own
     * figures are cut on the way past and this file is written over pictures that
     * now exist.
     *
     * ONE ATTEMPT PER FILE PER PROCESS, from the same set and for the same reason:
     * the marker the remake carries down from the parent is what makes a
     * SUCCESSFUL heal permanent, and the set is what stops a failing one repeating
     * on every open.
     */
    const source = at.pdf;
    const key = path.resolve(book).toLowerCase();
    if (source !== null && !figuresHealed.has(key) && await figuresMissing(book)) {
      figuresHealed.add(key);
      console.warn(
        `[book] ${book} was derived from a book whose figures were never cut, and ${source} is there `
        + 'now, so the translated book is being made again over the pictures.',
      );
      const remade = await writeTranslationBook(at.dir, ledger, transform);
      if (remade.ok) return remade;
      console.error(
        `[book] ${book} could not be made again with its figures: ${remade.reason}\n`
        + 'The translated book already on the disk is what is being shown.',
      );
    }
    return { ok: true, path: book };
  }
  console.warn(
    `[book] ${book} is not there and ${recordsFile} is, so the translated book is being made now — `
    + 'this translation landed before Foundry materialised one beside its answers.',
  );
  return writeTranslationBook(at.dir, ledger, transform);
}

/**
 * MATERIALISE A TRANSLATION — parent book file + chain ops + records, written out
 * as a book file of its own.
 *
 * ── The three terms, and why main is the one that holds them ────────────────
 *
 * *"When a translate lands, main materializes parent book file + chain ops +
 * records → readings/<key>.<lang>.book.jsonl."* (docs/RENDERER.md §4.) The engine
 * has never heard of the op grammar and never will — the replay lives once, in
 * this process, because the renderer draws from it too (§9, R1) — and it has no
 * ledger to walk for the parent. So the assembly is here, and it is three
 * functions that each already exist: `openBookAtPosition` for the parent's own
 * book and the ops on the way to it, `materialize` for the replay, `translated`
 * for the words and the header (shared/materialize.ts).
 *
 * IT IS KEYED TO THE STEP AND NEVER TO THE POSITION. The parent is the row this
 * translation was made FROM, read off the ledger, and the recursion is what makes
 * a chain work: translating an English translation into Hungarian materialises
 * over the ENGLISH derived file, because that is what `openBookAtPosition`
 * answers standing on the English row. One short hop, at every link.
 *
 * WRITTEN ATOMICALLY, beside the records file it is named after
 * (`translationBookFileFor`), because half a book file is a compile that refuses
 * on a row that was cut in two.
 */
export async function writeTranslationBook(
  projectDir: string,
  ledger: LedgerView['ledger'],
  transform: LedgerStep,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const records = translationRecordsOf(transform);
  if (records === null) {
    return {
      ok: false,
      reason: `“${transform.label}” keeps no words this app can put back block by block, so there is `
        + 'no book to make from it.',
    };
  }
  const recordsFile = path.join(projectDir, ...records.split('/'));

  /*
   * THE ROW THIS TRANSLATION WAS MADE FROM. A step whose parent is not in the
   * ledger is a history this process cannot walk, and the honest answer is to say
   * so rather than fall back to the position — which is the exact substitution
   * that would build this book out of whichever branch somebody had clicked onto
   * while the run was going.
   */
  const parent = ledger.steps.find((step) => step.id === transform.parent) ?? null;
  if (parent === null) {
    console.error(`[book] step ${transform.id} names parent ${String(transform.parent)}, which this project's history does not hold.`);
    return {
      ok: false,
      reason: `The step “${transform.label}” was made from is not in this project's history, so `
        + 'there is no book for its words to be put into.',
    };
  }

  const read = await openBookAtPosition(projectDir, parent);
  if (!read.ok) return read;

  let made: ReturnType<typeof materialize>;
  try {
    made = materialize(read.opened.parsed, [...read.opened.ops, ...(read.opened.tip ?? [])]);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    console.error(`[book] the book under ${transform.id} could not be materialised: ${err.message}`);
    return {
      ok: false,
      reason: `The changes recorded under “${transform.label}” could not be replayed onto the book `
        + `it was translated from: ${err.message}`,
    };
  }
  if (made.missing.length > 0) {
    // Said out loud and not fatal — `Materialized.missing`'s ruling, and the same
    // sentence `materializeBook` prints for an export.
    console.error(
      `[book] ${made.missing.length} recorded change(s) could not be replayed under `
      + `${transform.id} — ${made.missing.map((one) => `${one.op.op} ${one.id}`).join(', ')}`,
    );
  }

  let rows: TranslationRow[];
  try {
    rows = parseRecordsFile(await fsp.readFile(recordsFile, 'utf8'));
  } catch (err) {
    if (!(err instanceof RecordsFileError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    console.error(`[book] ${recordsFile} could not be read as records: ${(err as Error).message}`);
    return {
      ok: false,
      reason: `The words recorded as “${transform.label}” could not be read, so the translated book `
        + 'cannot be made. Its own history is intact; the file behind that row is not.',
    };
  }

  const words = translationWords(made.book, rows);
  /*
   * A RECORD ABOUT A BLOCK THIS BOOK DOES NOT HOLD IS NAMED. It is the ordinary
   * consequence of translating and then striking — the record is still in the
   * file, which is what an append-only payload is for — and it is also what a
   * records file from another reading would look like, so the count and the keys
   * go where somebody debugging their own library will find them.
   */
  if (words.stale.length > 0) {
    console.warn(
      `[book] ${words.stale.length} record(s) in ${recordsFile} answer for positions this book does `
      + `not hold — ${words.stale.slice(0, 12).join(', ')}`
      + (words.stale.length > 12 ? ', …' : ''),
    );
  }

  /*
   * ── WHICH LANGUAGE TO DECLARE THE DERIVED BOOK AS ──────────────────────────
   *
   * THE STEP'S, FOR A PASS THAT WENT INTO ONE, and a step that ought to say and
   * does not is a book that cannot be declared. `params.language` is recorded by
   * the landing from what the person asked for; nothing reads a language out of a
   * file of sentences (`translatedWords`, electron/workspace.ts, refuses the same
   * thing in the same words for the same reason).
   *
   * THE PARENT'S, FOR A CLEANUP, and this is a case rather than a fallback. A
   * cleanup does not move the book between languages — it says the same sentences
   * with punctuation a narrator can read — so `PARAMS_OF.clean` records no
   * language at all, on purpose, and the honest answer is the one the book already
   * carried. `made.book.header.language` IS that answer: the parent's header,
   * materialised, which for a cleanup made under a translation is the language
   * that translation declared and for one made over the reading is the language
   * the reading was read in.
   *
   * WITHOUT THE CASE, EVERY CLEANUP WOULD REFUSE. The step correctly says nothing,
   * the test above reads that as "made before Foundry kept a language", and the
   * pane tells somebody to translate again from the step it was made from — about
   * a run that has just written a perfectly good file of answers.
   */
  const language = transform.action === 'clean'
    ? made.book.header.language
    : transform.params?.language?.trim() ?? '';
  if (language.length === 0) {
    return {
      ok: false,
      reason: transform.action === 'clean'
        ? `The book under “${transform.label}” has never said what language it is in, so there is `
          + 'nothing to declare the cleaned book as. Read the pages again with the language '
          + 'declared, and the cleanup already on disk is put back for nothing.'
        : `“${transform.label}” does not say which language it was made into, so there is `
          + 'nothing to declare its book as. It was recorded before Foundry kept that, and the way '
          + 'to get one is to translate again from the step it was made from.',
    };
  }

  /*
   * THE SPINE'S OWN ANSWERS TRAVEL WITH THE BLOCKS' — `words.titles`, out of the
   * same file and by the same "newest row wins" rule. Owen's ruling, 2026-08-22:
   * *"everything should be translated."* Most divisions are not in that map and
   * never will be: their titles are copies of headings this translation already
   * answers for, and `translated` derives those for nothing.
   */
  const derived = translated(made.book, words.text, words.titles, language);
  /*
   * THE PARTIAL IS HONEST AND IT IS NAMED. A row with no record keeps its source
   * text — the established rule (`Translated.untranslated`) — and the ids are
   * said here, which is the half the cast route never had: a book that comes out
   * with forty paragraphs still in the source language says which forty.
   */
  if (derived.untranslated.length > 0) {
    console.warn(
      `[book] ${derived.untranslated.length} of ${made.book.rows.length} block(s) have no `
      + `translation in ${recordsFile} and keep their source words — `
      + `${derived.untranslated.slice(0, 12).join(', ')}`
      + (derived.untranslated.length > 12 ? ', …' : ''),
    );
  }
  if (derived.untitled.length > 0) {
    console.warn(
      `[book] ${derived.untitled.length} chapter title(s) stay in the source language — nothing in `
      + 'these answers names them and no heading of theirs came back translated, which is a '
      + 'translation made before Foundry asked about the spine: '
      + derived.untitled.join(', '),
    );
  }
  if (words.titles.size > 0) {
    console.log(
      `[book] ${words.titles.size} chapter title(s) came out of ${recordsFile} — the divisions no `
      + 'heading of this book answers for.',
    );
  }
  /*
   * THE APPARATUS ACROSS THE LANGUAGE LINE, said in one line — Owen's
   * both-sides ruling (2026-08-24). Kept is what the digits proved into the
   * translated prose; dropped is what they could not, and every dropped one's
   * number leaves the compiled document entirely rather than standing bare.
   */
  if (derived.refsKept > 0 || derived.refsDropped > 0) {
    console.log(
      `[book] ${derived.refsKept} reference link(s) carried into the translation`
      + (derived.refsDropped === 0
        ? ''
        : `; ${derived.refsDropped} could not be placed and their numbers leave the edition`),
    );
  }

  const file = translationBookFileFor(recordsFile);
  try {
    await writeAtomically(file, Buffer.from(formatBookFile(derived.book), 'utf8'));
  } catch (err) {
    console.error(`[book] ${file} could not be written: ${(err as Error).message}`);
    return {
      ok: false,
      reason: 'The translated book could not be written beside the words it was made from.',
    };
  }
  console.log(
    `[book] ${file} — ${derived.book.rows.length} block(s), `
    + `${words.text.size} translated, language ${language}.`,
  );
  return { ok: true, path: file };
}
