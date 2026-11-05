/**
 * workspace-rendering — where a rendering is written, and the narration stamp it carries.
 */
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ProjectError, generatedFileFor, importDocument, ledgerOf, readManifest, narrationStampFileFor, readingBank, readingIsComplete } from './projects';
import { facsimileFile, languageTagFor, positionOf, readingInEffect, textPassInEffect, translationRecordsOf } from '../shared/ledger';
import { renderPipeline } from '../shared/pipeline';
import type { ConversionKind, LedgerStep, ProjectLedger, WorkspacePlan } from '../shared/types';
import { archiveOriginal } from './workspace-records';
import { refuseOverEdits, renderingCompiles } from './workspace-rendering-guards';
import { translatedWords } from './workspace-translation';

/**
 * The two layers a rendering can be aimed at, spelled once.
 *
 * `electron/projects.ts` owns these names for the catalogue's purposes and keeps
 * its own constants; these are the two this module composes INTO, and they are
 * here rather than imported because a plan naming a third layer would be a plan
 * writing somewhere no landing knows how to record.
 */
export const GENERATED = 'generated';

export const FINAL = 'final';

/** The layer a rendering writes into. See `planFacsimile` and `planExport`. */
export type RenderingLayer = typeof GENERATED | typeof FINAL;

/**
 * The plan, and the two facts about it that are this module's business and
 * nobody else's.
 *
 * `WorkspacePlan` is what crosses the bridge to the window that asked, and it is
 * a list of paths and nothing else. `dir` is where the project lives, which the
 * renderer must never be handed (composing a project path over there is how a
 * branch read ends up answering for the other reading's bank); `compiles` is the
 * answer to "can this rendering carry the changes on the way to it", which is
 * decided once, below, and read once, by `planExport`.
 */
export interface PlannedRendering {
  plan: WorkspacePlan;
  dir: string;
  compiles: boolean;
  /**
   * THE ROW THIS RENDERING IS ABOUT, as an id — the caller's `forStep` when it
   * named one, and the POSITION AT THE PRESS when it did not.
   *
   * Resolved here because this is where the ledger is already open, and pinned
   * because the spawn makes the book out of it: `null` would mean "wherever the
   * pointer is when the row finally runs", which is the pointer-move hazard every
   * plan in this file is written against.
   */
  at: string | null;
}

export async function planRendering(
  inputPath: string,
  kind: ConversionKind,
  layer: RenderingLayer,
  /**
   * THE ROW THIS RENDERING IS MADE FROM, when it is not the position. See
   * `planFacsimile` and `planExport`, the two callers that pass it, and the
   * header that argues for it.
   *
   * It changes which corrections are applied, which reading's bank is replayed
   * and whose words go in the blocks — and deliberately nothing else: the pixels,
   * the completion refusal and the rotation rule are the same facts about the
   * same project however this plan was reached.
   */
  forStep: LedgerStep | null = null,
  /**
   * THE ROW THE FILE IS NAMED AFTER — a facsimile's read step, and nothing else.
   *
   * ── Why this is a second parameter and not the one above ───────────────────
   *
   * It was the one above, and the conflation was invisible while a facsimile was
   * the only rendering that named a step at all: "a step was passed" and "this
   * product is keyed to that step" were the same fact, so one parameter carried
   * both. They came apart the moment an EXPORT could be asked for from a row the
   * pointer is not on (`planExport`). That export is still the BOOK's — it lands
   * in the tray under the book's own name, beside the copy somebody exported by
   * hand, and rotates the predecessor aside like any other — and a plan that read
   * "a step was passed" as "name it for the step" would have filed it as
   * `<stem>.<id8>.epub`: a payload's name on a document nothing owns, in a
   * folder a person opens.
   *
   * SO THE TWO QUESTIONS ARE ASKED SEPARATELY. `forStep` says where the words
   * come from; this says what the product is called. A facsimile passes the same
   * step to both because for a facsimile they genuinely are one answer.
   */
  keyedTo: LedgerStep | null = null,
): Promise<PlannedRendering> {
  const { dir } = await importDocument(inputPath, 'pdf');
  /*
   * ── ONE READING OF THE CATALOGUE, AND EVERY ANSWER BELOW COMES OUT OF IT ───
   *
   * This used to ask `bankForPosition` and `overlayForPosition`, each of which
   * reads the manifest for itself — which was two answers about one project and
   * fine while they were two independent facts. They are not independent any
   * more: which bank, which curation and whose words go in the blocks are THREE
   * ANSWERS ABOUT ONE POSITION, and a save committed between two reads would give
   * a plan whose curation came from one ledger and whose records came from
   * another. So the manifest is read once and the same in-memory ledger answers
   * all of it.
   */
  const manifest = await readManifest(dir);
  const { stem } = manifest;
  const ledger = ledgerOf(manifest);
  /*
   * THE PIPELINE, WHICH IS THE ANCESTRY READ AS A PLAN — and asked of the STEP
   * when this plan is about one, because a landing casts a book while the pointer
   * is somewhere else entirely (`planFacsimile`).
   *
   * IT NO LONGER REFUSES ANYTHING. It used to throw for a translation of a
   * translation, one hop being what the two-stage pipeline could run; a chain is
   * resolved when its records are WRITTEN now, so materialisation reads one file
   * of answers however many languages the book passed through (shared/pipeline.ts).
   */
  const pipeline = renderPipeline(ledger, forStep);
  /*
   * ── WHICH ROUTE THIS RENDERING TAKES, AND IT IS THREE FACTS ────────────────
   *
   * An EXPORT to EPUB or to plain text, FROM A POSITION THAT CARRIES APPLIED
   * CHANGES, is compiled from a materialised book file — the one route that can
   * carry what a person did on the proof sheet (docs/RENDERER.md §6). Everything
   * else is the bank route, and everything else therefore still refuses over an
   * edit chain; `refuseOverEdits` below carries the argument for each case it
   * still fires on.
   *
   * A TRANSLATION USED TO BE THE FOURTH FACT AND IS NOT ANY MORE. The clause was
   * `pipeline.translate === null`, because a translation's words lived in a
   * records file keyed to the bank's own positions and there was no way to put
   * them into a book file the ops had restructured. There is now: a translate
   * landing materialises its own derived book — same ids, struck rows absent, the
   * words in the language that was asked for (§4) — and `materializeBook` opens
   * THAT at any position under it. So an export from under a translation with
   * edits on the way to it compiles the translated book with the edits in it,
   * which is a document neither route could produce before this wave.
   *
   * A BOOK NOBODY HAS EDITED USED TO KEEP THE LEGACY PATH, and R6 is the wave
   * that collapsed it. The clause was `editsInEffect(...).length > 0`: an
   * unedited book went out through `vlm-convert --overlay --final` on the
   * grounds that the two routes produce the same edition out of the same
   * answers when there is nothing to replay, so nothing was bought by moving it
   * and one thing was risked — every export in the library changing command at
   * once. That risk was worth taking exactly once, deliberately, and this is it.
   * What paid for it: the second route was reachable only through a curation
   * file, and there are no curation files any more (docs/RENDERER.md §7), so
   * keeping the clause would have meant keeping the overlay system alive to
   * serve the case where it makes no difference. EVERY epub and txt export
   * materialises and compiles now, edited or not, in either language.
   */
  const compiles = renderingCompiles(kind);
  /*
   * WHICH LEAVES THE FACSIMILE, and it is the only rendering that still comes
   * here. `--format pdf` reprints the scan's own photographed lines from the raw
   * bank (§6) and there is nothing about an edit for it to carry, so a request
   * for one from a position with applied changes is refused in words rather than
   * answered with a document that quietly has none of them in it.
   *
   * The layer is not asked any more and that is not a loosening. The two callers
   * that reach this line are `planFacsimile`, which is `pdf` into `generated/`
   * and keyed to its read step (whose ancestry cannot hold an edit made after
   * it), and `planExport`, which is any of the three formats into `final/`. So
   * `kind` alone separates them, and a `layer === FINAL` beside it would be a
   * condition that has never once changed an answer.
   */
  if (!compiles) refuseOverEdits(ledger, forStep);
  /*
   * ── THE READING HAS TO BE FINISHED, AND THIS IS EVERY RENDERING ────────────
   *
   * A rendering REPLAYS a bank somebody already paid for and writes a document out
   * of it, and the flag that makes that true is `--reuse-readings`, which `argsFor`
   * puts on every conversion with no switch anywhere that could turn it off. That
   * flag only means "read nothing" over a bank the engine marked complete. Over one
   * it did not — a reading killed at page 9 of 17, a bank adopted from an older
   * layout, a branch read that never finished — the engine has nothing to replay,
   * and until this refusal existed it resumed instead: the pages missing from the
   * bank went to a vision model, because somebody pressed a button labelled with a
   * file format.
   *
   * ASKED OF THE BANK THIS PLAN WILL ACTUALLY NAME, which is why it takes the step
   * this plan is about. `readingIsComplete` resolves `readingBank(dir, manifest,
   * at)` — that row's own read step and its own payload,
   * `readings/<key>.<id8>.jsonl` for a branch — rather than composing a path from
   * the project key. Composing it is how a branch read that never finished passed a
   * test about the ORIGINAL reading's marker and rendered somebody else's pages
   * (`readingBank`'s own header), and asking the POSITION here while naming the
   * step's bank below would be the same lie in a shorter window: a cast keyed to a
   * step under one reading, cleared by a test about the other one.
   *
   * NAMED BY THE ROW, never by the file: `pipeline.reading` is the step this
   * position renders from, and its label is what the user sees in the tree. A
   * project with no reading at all is a different sentence, because "your reading
   * did not finish" is a false thing to say to somebody who has not read the book
   * yet.
   */
  /*
   * ── A BOOK THAT ARRIVED AS A BOOK HAS NO READING TO FINISH ─────────────────
   *
   * The refusal below is about a BANK, and it dead-bolted every project imported
   * from an EPUB: there is no bank under one, there is no completion marker beside
   * the bank that is not there, and so a finished book with its chapters and its
   * figures already on the disk was told it had not been read yet and sent to buy
   * a vision model. Nothing about that sentence was true.
   *
   * THE SAME PAIR `bookAtPosition` TESTS, out of the same helpers, because they
   * are answering one question — which of the two roads this project's blocks come
   * down — and two spellings of it is the day one route explodes a container the
   * other is rendering a bank of. An EPUB archive with NO READING IN EFFECT at this
   * position is `book = f(epub)` (docs/RENDERER.md §6); the same archive with a
   * reading on the path is that reading's bank and goes through the refusal like
   * everything else, which is why the kind alone is not the test.
   *
   * AND THE CONTAINER IS COMPLETE BY CONSTRUCTION. What the marker attests is that
   * every page somebody paid for came back — a statement that only exists because a
   * reading can stop halfway. An archived EPUB cannot: it was copied whole at
   * import, it is never written again, and it is the receipt this project's book
   * file is a hash of. There is no half of it to be missing, so there is nothing
   * here to prove and nothing to resume.
   */
  const arrivedAsBook = manifest.archive?.kind === 'epub'
    && readingInEffect(ledger, forStep) === null;
  if (arrivedAsBook) {
    /*
     * EXCEPT A FACSIMILE, AND THIS IS THE BACKSTOP RATHER THAN THE DOOR. The card
     * is already dead in the export dialog with this sentence beside it; what
     * reaches here is the menu route, and a refusal is the only honest answer
     * available. A facsimile reprints a READING'S photographed pages set back as
     * type — it is a record of what the model saw on paper — and this book has no
     * paper behind it, so there is no version of the product to make rather than a
     * position it cannot be made from. `refuseOverEdits` above has already had its
     * say about the other reason a facsimile can be refused.
     */
    if (kind === 'pdf') {
      throw new ProjectError(
        'There is no facsimile of this one. A facsimile reprints the pages a reading photographed, '
        + 'set back as real text, and this book arrived as a book — it has never had pages, only '
        + 'words. The EPUB and the plain text are both made from those, from wherever you are '
        + 'standing.',
      );
    }
  } else if (!await readingIsComplete(dir, manifest, forStep)) {
    throw new ProjectError(
      pipeline.reading === null
        ? 'This book has not been read yet, so there is nothing to make it from — a rendering '
          + 'replays the pages a reading already banked rather than reading them. Run OCR on it '
          + 'first, and every format after that is free.'
        : `“${pipeline.reading.label}” carries no completion marker, so that reading was interrupted `
          + 'and rendering would mean reading the pages that are missing from it. Run OCR again — it '
          + 'picks up where it stopped, and pays only for what is missing — and this is made from '
          + 'the finished reading afterwards, for nothing.',
    );
  }
  /*
   * WHOSE WORDS GO IN THE BLOCKS, when the position stands under a translation.
   * Null for a rendering of the book in its own language, which is most of them.
   *
   * THE STEP TRAVELS WITH THE ANSWER because the NAME below needs it: a translated
   * book made in `generated/` is that translation's own cast, and a cast is named
   * for the row it belongs to.
   */
  const translated = pipeline.translate === null
    ? null
    : { step: pipeline.translate, ...translatedWords(dir, pipeline.translate, kind) };
  /*
   * AND WHETHER THESE WORDS WERE CLEANED FOR A NARRATOR — a separate question from
   * the one above it, asked of a separate walk, and the separation is the point.
   * `pipeline.translate` answers WHICH LANGUAGE (a cleanup declares none, so the
   * walk goes past it); this answers WHAT WAS DONE TO THE WORDS LAST. A book
   * translated into Hungarian and then cleaned is both — declared `hu`, and
   * stamped. See `narrationStampFor` below.
   */
  const narrationStamp = narrationStampFor(ledger, dir, forStep);
  /*
   * THE NAME IS THE BOOK'S EITHER WAY, and what this plan is FOR is the whole of
   * what changes about it.
   *
   * A FACSIMILE IS NAMED FOR ITS READ STEP — `<stem>.<id8>.pdf` — the scheme
   * readings already use, composed by the ledger (`facsimileFile`) so that the
   * plan, the resolution that draws the row and the sweep that removes it when
   * the reading goes cannot come to three answers. `planFacsimile` is the only
   * caller that keys a product to a step, which is why the test below is `keyedTo`
   * and not "was a step passed at all": an export made from a named row is made
   * from a step and is not keyed to one.
   *
   * AN EXPORT KEEPS THE HUMAN NAME, because `final/` is a tray a person opens and
   * nothing in it is anybody's payload: `<book> (hu).epub`, beside `<book>.epub`.
   * Two translations into one language exported twice land on one name and the
   * second rotates the first aside, which is exactly what `rotateFinal` exists for
   * wherever a name is composed rather than chosen.
   *
   * AND THE LANGUAGE IN THAT NAME IS THE ROW'S, not the pointer's. `translated`
   * comes out of the pipeline resolved for `forStep`, so an export ordered from a
   * step standing under a Hungarian translation is `<book> (hu).epub` however far
   * away the person happens to be standing — which is the same file the pointer
   * would have composed had they walked there first, and that agreement is the
   * whole point of resolving both from one step.
   *
   * THE THIRD ARM IS GONE WITH THE THING IT NAMED. A per-step CAST — a save's or
   * a translation's own EPUB in `generated/` — was a document made so a pane had
   * files to unpack; the proof sheet replays the step instead, so there is no file
   * to name (docs/RENDERER.md §7).
   */
  const file = keyedTo !== null
    ? facsimileFile(stem, keyedTo.id)
    : translated === null
      ? generatedFileFor(stem, kind)
      : generatedFileFor(`${stem} (${languageTagFor(translated.language)})`, kind);
  const outputPath = path.join(dir, layer, file);
  /*
   * THE SOURCE IS THE APP'S TO CHOOSE, and that is the whole correction here.
   *
   * `inputPath` is whatever document the user was looking at when they asked.
   * It is not necessarily the thing with the pages in it: after a real-text
   * conversion the PDF this app shows them is type on blank paper, and reading
   * THAT would be converting a reprint of a reading. So the pixels are fetched
   * from where they are kept — `archive/`, which is written once at import and
   * never again — and the user is never asked which copy is which.
   *
   * There used to be a `refuseSelfOverwrite` on the next line, and its removal
   * is the point rather than a side effect. It fired when somebody asked to
   * convert the reprint, and it told them to go and pick a different file: a
   * refusal caused entirely by where this app had filed something, handed to
   * the person who is not supposed to know that the filing exists. The state it
   * guarded against is now unreachable — the input is always under `archive/`
   * and no output path is ever composed there — so there is nothing to guard.
   */
  const sourcePath = await archiveOriginal(dir) ?? inputPath;
  /*
   * THE ROTATION IS NOT HERE, and moving it was the whole of a fix.
   *
   * This function used to move the previous output aside before the job was even
   * enqueued. The new file was recorded only if the run SUCCEEDED — so a
   * rendering that failed, or was cancelled, or sat in the queue and was removed,
   * left the previous output in `generated/archived-<stamp>/` with the
   * catalogue's chain pointing at it and nothing in `generated/` at all. The
   * document went on listing and opening; what it opened was silently the run
   * BEFORE last, forever.
   *
   * A rotation is now made at the moment the engine is about to write
   * (electron/job-queue.ts) and put back if it does not (`restoreRotation`), so
   * a run that produces nothing leaves the catalogue exactly as it was.
   *
   * AND THE REFUSAL THAT USED TO STAND HERE IS GONE WITH THE THING IT GUARDED.
   * `rotationRefusal` asked whether the book a rerun would move aside had been
   * UNPACKED and was being read in a tab, because the rename took the chapters out
   * from under that reader. Nothing unpacks any more (docs/RENDERER.md §7): there
   * is no tree, no reader of one, and therefore nothing to refuse.
   */
  await fsp.mkdir(path.join(dir, layer), { recursive: true });
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    dir,
    compiles,
    at: (forStep ?? positionOf(ledger))?.id ?? null,
    plan: {
    key: manifest.key,
    sourcePath,
    outputPath,
    /*
     * ── WHICH BANK, WHICH THE POSITION ANSWERS AND THE KEY CANNOT ────────────
     *
     * The bank is keyed by the BOOK and never by the format: both outputs are
     * assembled from the same per-page answers, so converting a book to text after
     * converting it to EPUB must not read three hundred pages again, and a readings
     * path with the format in it would guarantee that it did.
     *
     * WHAT CHANGED IS THAT THE BOOK CAN HAVE MORE THAN ONE. A re-read asking for a
     * different page range branches by design, and while this line composed
     * `readings/<key>.jsonl` from the key, both read steps named one file — so
     * standing on the older row and rendering rendered the NEWER reading. The row
     * named a bank that had been written over from under it and nothing on screen
     * admitted the swap.
     *
     * So the plan asks the row: `readingBank` walks up from the position — or from
     * the step this plan is about — to the reading this branch of the story is
     * about, and answers with that step's own payload. A project with one reading —
     * which is every project that existed before this — gets exactly the path it
     * always got, because that is what its read step already says. Nothing moves on
     * disk.
     *
     * RESOLVED AT PLAN TIME: it is
     * which state of the book the user chose when they asked, and re-resolving it at
     * spawn would let a pointer move made while the job waited silently render a
     * different reading than the dialog said it would.
     *
     * IT IS THE SAME BANK FOR A TRANSLATED BOOK, and that is the point of records:
     * a translation is not a second reading of anything, it is different words in
     * the same blocks of the same pass over the pages.
     */
    readingsPath: readingBank(dir, manifest, forStep),
    ...(translated === null
      ? {}
      : { records: translated.records, language: translated.language }),
    ...(narrationStamp === null ? {} : { narrationStamp }),
    },
  };
}

/**
 * THE NARRATION STAMP THIS RENDERING SHOULD CARRY, or null when it should carry
 * none.
 *
 * ── The one question, asked once, for every EPUB this app writes ────────────
 *
 * `cleanupInEffect` at the step the rendering is about — the position for a press,
 * the named row for a host's export — so the flag is on the command line exactly
 * when the nearest text pass above those words is a cleanup, and absent when a
 * translation or a rewrite has been made since. Every EPUB in this app comes out
 * of `planRendering` (the export dialog, the mint-metadata dialog and
 * `exportEpubFromStep` all build their request from a plan it composed), so
 * deciding it here is deciding it for all of them.
 *
 * ── ASKED OF THE STEP AND NEVER OF THE POINTER ──────────────────────────────
 *
 * `forStep`, on the rule the whole of `planRendering` obeys: an export ordered by
 * a host names its own row, and a person may be standing three branches away. A
 * stamp resolved from the position would put "this text was cleaned" into a book
 * made from a row where it was not.
 *
 * ── AND A MISSING FILE IS AN ABSENT FLAG, NOT A REFUSAL ─────────────────────
 *
 * A cleanup that landed before the engine wrote stamps has none, and a person who
 * tidied `readings/` by hand has one fewer. Both are answered by leaving the flag
 * off: what comes out is a book whose OPF says nothing about narration, which is
 * the honest thing for it to say — where a flag pointing at a file that is not
 * there would fail an export outright over a receipt, after the words themselves
 * are already correct in the file. This is the only existence test in this plan
 * and it is here rather than in `argsFor` because this is the side that knows the
 * flag was ever going to be composed.
 */
export function narrationStampFor(
  ledger: ProjectLedger,
  dir: string,
  forStep: LedgerStep | null,
): string | null {
  const cleaned = textPassInEffect(ledger, forStep);
  if (cleaned === null || cleaned.action !== 'clean') return null;
  const records = translationRecordsOf(cleaned);
  if (records === null) return null;
  const stamp = narrationStampFileFor(path.join(dir, ...records.split('/')));
  return existsSync(stamp) ? stamp : null;
}
