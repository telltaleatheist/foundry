/**
 * projects-positions — the book and the document at a position in the tree.
 */
import * as path from 'node:path';
import type { LedgerStep, ProjectManifest } from '../shared/types';
import { A_BOOK_OF_ITS_OWN, documentOriginOf, isTextPass, positionOf, positionView, readingInEffect, translationRecordsOf } from '../shared/ledger';
import { fold } from '../shared/original';
import { deletableProjectDir } from './projects-delete';
import { bookFileFor, readingBank } from './projects-files';
import { readManifest } from './projects-manifest';
import { healMintedArchive } from './projects-mint';
import { ARCHIVE, FINAL } from './projects-paths';
import { liveCopyOf, newestOfChain, newestWhere, onDisk } from './projects-planning';
import { goToStep, ledgerOf, viewOf } from './projects-steps';
import type { LedgerView } from './projects-steps';

/**
 * The bank at the position and the book file made from it, with the directory
 * PROVEN to be one of Home's projects first.
 *
 * THE GATE IS `deletableProjectDir`'s, on the step-ledger family's rule: every
 * call that takes a directory named by the renderer asks the same question, so
 * that none of them is the lenient way in. This one only reads — but what it
 * reads is handed to a SPAWN of the engine with `--out` pointed at the answer
 * (electron/book.ts), and a path this process never agreed to is not a path
 * anything gets to write into.
 *
 * The manifest rides back with it because every caller needs it anyway — the
 * project's title is the only thing the book file itself cannot say.
 *
 * THE PDF AND THE LANGUAGE RIDE BACK TOO, because the reflow takes both
 * (`vlm-book --pdf --language`) and both are this module's facts: the archived
 * original is `archive/<manifest.archive.file>` — named only where the archive
 * IS a PDF, because the figure crops are cut out of pages and an archived EPUB
 * has none — and the language is what the reading in effect at the position
 * declared when it ran. Null for either is an ordinary answer the engine has a
 * documented behaviour for (no figures cut and says so; language defaults),
 * not a hole this side papers over.
 *
 * AND SO DOES THE READING ITSELF, which is one line here and stops a second
 * opinion elsewhere. Everything above is derived from that one step — the bank
 * is its payload and the language is its param — so a caller that needs the ROW
 * as well (the read landing, which names that reading's facsimile after it) must
 * not go and ask the ledger a second time for the step these answers came out
 * of. Two reads of one catalogue is two answers the moment anything lands in
 * between. Null is the honest answer for a project with no reading on the path,
 * and it is what makes `bank` above a composed fallback rather than a payload —
 * a caller that must be sure it is holding a real reading tests for it.
 *
 * `at` IS `readingBank`'s OWN PARAMETER, PASSED THROUGH, and it exists here for
 * its reason: a landing works on ONE STEP while the pointer is wherever the
 * person happens to be standing. A translation's derived book file is
 * materialised at the moment the run lands (docs/RENDERER.md §4), by which time
 * somebody may have clicked onto a branch under a different reading — and a book
 * built for that step out of this position's bank would be the other reading's
 * pages under that step's name. Null and absent both mean the position, which is
 * what every viewer asks.
 */
export async function bookAtPosition(dir: string, at: LedgerStep | null = null): Promise<{
  dir: string;
  manifest: ProjectManifest;
  reading: LedgerStep | null;
  bank: string;
  book: string;
  /*
   * ── GRAVESTONE: `pages`, THE SECOND PIXEL FIELD (Wave 41) ─────────────────
   *
   * A `pages` field stood beside `pdf` from `ecbf238` to here, naming the FOLDER
   * a mint wrote, because `pdf` had to keep meaning "a document that can be
   * rasterised" and a captured book had none. Two facts, kept apart at the
   * source, so that "there is a scan" and "the scan is a PDF" stayed separable.
   *
   * They are one fact again. A mint writes a PDF (`recordMint`) and a project
   * that pre-dates that gets one at the top of this very function, so `pdf` is
   * the honest answer for a photographed book exactly as it is for an imported
   * one — which is Owen's *"just like it normally would"* arriving at the field
   * that had to split to survive without it. The figure cutter, the glance card
   * and the book loader all read `pdf` now, and there is no second field for
   * them to disagree about.
   */
  pdf: string | null;
  language: string | null;
  epub: string | null;
  receipt: string;
}> {
  const resolved = deletableProjectDir(dir);
  /*
   * THE CONTAINER FIRST, AND THAT ORDERING IS LOAD-BEARING. A project minted
   * before Wave 41 has its pages in a folder and no PDF at all; this composes
   * `pdf` out of the manifest one line down, and `ensureReadingBook` then reads
   * `pdf` to decide whether a figure-less book can be remade with its pictures.
   * Healing here means the container exists before either question is asked.
   * It is a no-op — one manifest read — for every project already in order, and
   * once per project per process for one that is not.
   */
  await healMintedArchive(resolved);
  const manifest = await readManifest(resolved);
  const bank = readingBank(resolved, manifest, at);
  const reading = readingInEffect(ledgerOf(manifest), at);
  const language = reading?.params?.language ?? null;
  const pdf = manifest.archive !== null && manifest.archive.kind === 'pdf'
    ? path.join(resolved, ARCHIVE, manifest.archive.file)
    : null;
  /*
   * THE ARCHIVED EPUB, WHEN THERE IS ONE AND NOTHING HAS BEEN READ — the other
   * thing a book can be made of (docs/RENDERER.md §6, the refinement paragraph:
   * an EPUB is never OCR'd into a bank, `book = f(epub)`).
   *
   * `reading === null` IS PART OF THE TEST AND IS NOT DEFENSIVE. A project's
   * origin never changes, so `archive.kind === 'epub'` alone would answer "explode
   * the container" for every position in the project, including one standing under
   * a reading somebody had made of it — and that reading's bank is the receipt of
   * ITS book. The two routes are decided by which record the position is about,
   * which is exactly what `readingInEffect` answers.
   */
  const epub = reading === null && manifest.archive !== null && manifest.archive.kind === 'epub'
    ? path.join(resolved, ARCHIVE, manifest.archive.file)
    : null;
  return {
    dir: resolved,
    manifest,
    reading,
    bank,
    /*
     * THE BOOK FILE IS `readings/<key>.book.jsonl` EITHER WAY, and that is not a
     * coincidence to be tidied up. `readingBank` composes `readings/<key>.jsonl`
     * for a project with no reading on the path — a file that never exists for an
     * EPUB project — and `bookFileFor` turns it into the name the book wears. So
     * an exploded book lands in `readings/` beside where a reflowed one would,
     * `imagesDirFor` finds its figures at `readings/<key>.images/` by the same
     * derivation, and the engine reaches the same directory from `--out`
     * (`epubImagesDir`, src/vlm/epub-explode.ts). One spelling, three readers.
     */
    book: bookFileFor(bank),
    pdf,
    language: typeof language === 'string' && language.length > 0 ? language : null,
    epub,
    /*
     * WHAT THE BOOK FILE'S `source.bankSha` IS A HASH OF — the receipt, named, so
     * that the one integrity check in the app has one thing to open. For a read
     * project that is the bank; for an imported EPUB it is the container itself,
     * which is the receipt in exactly the bank's sense: immutable, archived, and
     * the thing the book is a pure function of (docs/BOOK-FILE.md §2).
     */
    receipt: epub ?? bank,
  };
}

/**
 * WHICH DOCUMENT THE PANES SHOW AT THE POSITION — the last third of the pointer's
 * promise, and the one that was never built.
 *
 * ── What clicking a row did, and what the user said about it ────────────────
 *
 * `positionView` already decided the block editor's MODE and which corrections
 * are drawn, and `b61bfab` wired both of those to a pointer move. What it never
 * touched was WHICH FILE was under them: `Tab.path` is fixed when a document is
 * opened from the documents panel and nothing else ever moved it. So a project
 * holding both `archive/<scan>.pdf` and the reprint made from its reading showed
 * exactly one of them however many rows the user clicked — *"switching between
 * steps doesnt switch between the original pdf and the rendered facsimile like i
 * expected"* — and when the app had nothing it could change it said so, which is
 * the other half of the same complaint: *"instead of showing the document, it gave
 * me an error saying it couldnt show the document… it should be showing me
 * document"*.
 *
 * ── Why the resolution is HERE and not in the renderer ──────────────────────
 *
 * Because composing a project path in the renderer is how a branch read ends up
 * answering for the original reading's file. It is the same rule that put
 * `readingBank` and `renderingOverlay` in this file rather than at their call
 * sites: the pointer decides which of several files a surface is handed, and a
 * second opinion composed from the project key is a lie the moment a project holds
 * two of anything. Main also has to ADMIT the path to the viewer's allow-list
 * (electron/documents.ts, `admit`), which the renderer cannot do for itself and must
 * not be
 * able to.
 *
 * ── The four rows ───────────────────────────────────────────────────────────
 *
 * A ROW THAT RETAINED A DOCUMENT SHOWS IT (`PositionView.own`): the import shows
 * the untouched original, a translation shows the book in the other language.
 * Nothing is walked and nothing is composed — the step's own payload, resolved
 * against the project directory.
 *
 * A READ OR A SAVE SHOWS THE BOOK CAST FROM THAT READING — the flowing document,
 * which is `generated/<stem>.epub`. That is a rendering rather than a payload
 * (renderings are deliberately not steps — STEP-LEDGER.md "Decided" #4), so it is
 * answered by asking the project what it holds.
 *
 * ── This is the seam moving, exactly where it was said it would ─────────────
 *
 * It used to answer the live PDF — `working/<stem>.pdf` — and that was the honest
 * answer while the PDF was the only surface anything could edit. It stopped being
 * honest the moment a reading landed with a book beside it: the user clicked the
 * OCR row expecting the thing the reading MADE and got the photograph it was made
 * from. Their own words for the whole shape of it: "from that bank, we create an
 * html page of the document - a proto epub. that's the step that appears
 * automatically the moment i OCR something. i can now either click back to step 1,
 * which shows the original pdf, or i can click the ocr step, which shows the PDF
 * in html/epub form."
 *
 * The proto-epub is not a new artefact this had to wait for. It is
 * `vlm-convert --format epub` over the bank — deterministic, every block stamped,
 * already the thing select mode strikes and relabels — and the queue now casts one
 * the instant a reading lands (electron/job-queue.ts). This function is where that
 * cast becomes what a row SHOWS. The PDF keeps the import row and nothing else:
 * facsimile and stop (docs/DERIVED-BOOK.md §1).
 *
 * ── `generated/` and not a working copy, which is the opposite of the old rule ─
 *
 * A PDF has a live copy in `working/` and an EPUB does not: a book's working copy
 * is the TREE unpacked from its origin, made on open by the epub reader, and the
 * file a pane is pointed at is the origin the tree comes from
 * (`liveCopyOf` already says this for the import row). So aiming at `generated/`
 * here is aiming at the same layer every EPUB in this app is opened from, not at a
 * layer nothing edits — and there is no second document with the same basename to
 * collide with, because the book and the scan differ by extension.
 *
 * ── Two limitations, named rather than engineered around ────────────────────
 *
 * NOTHING RECORDS WHICH READING A CAST WAS MADE FROM. Renderings are not steps and
 * are not going to become steps, so a project with two `read` rows (a re-read
 * asking for a different page range branches — `MINTED_BY_THE_RUN`) has one cast
 * book and two rows that would both claim it. Both get it — the newest cast, which
 * is the one the newest reading left. That is wrong for at most one of them, and
 * the alternative is provenance bookkeeping for a file phase B replaces
 * (docs/DERIVED-BOOK.md §6).
 *
 * AND A CURATE ROW SHOWS ITS OWN CAST, WHICH IS THE DEFERRAL ABOVE, BUILT. It
 * used to show the project's ONE cast — so every save in a book's history showed
 * the same document, the live tree wearing today's marks, and clicking an old save
 * showed you the present. A curate landing now casts its own book
 * (`curateCastFile`, shared/ledger.ts; the job is fired at the commit in main.ts)
 * and this is where that book becomes what the row shows.
 *
 * THE FALLBACK TO `castBook` IS NOT A LEGACY BRANCH. Every project curated before
 * this unit has saves with no cast of their own, and they go on showing the
 * project's cast exactly as they did — which is the honest answer for them, since
 * nothing else about that save was ever recorded. So does a save whose cast has
 * not landed yet: the job takes seconds, and a pane that showed nothing while it
 * ran would be worse than one showing the book it is about to replace.
 *
 * ── The fallback is the old answer, and it is not a legacy branch ───────────
 *
 * The cast is a queued job: it is planned the moment the reading lands and it
 * takes seconds, but there is a window where the row exists and the book does not,
 * and there are projects on disk read before anything cast automatically. Both get
 * the live PDF, which is what this function has always answered — the pages are
 * the same pages, and a pane showing the scan is the app doing its job while the
 * book is on its way.
 *
 * ── Null is an ordinary answer ──────────────────────────────────────────────
 *
 * A project with no reading yet, a row whose payload has been swept off the disk,
 * an EPUB-only project standing where a scan would be: all of them mean "this
 * position names no document of its own", and the panes correctly keep the one
 * they have rather than being sent somewhere. Proved to exist before it is
 * returned, because a path handed to a viewer for a file that is not there is a
 * blank pane with nothing on screen saying why.
 */
export async function documentAtPosition(dir: string): Promise<string | null> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const view = positionView(ledgerOf(manifest));
  if (view.step === null) return null;
  return await documentOfStep(resolved, manifest, view.step);
}

/**
 * THE SAME QUESTION ASKED OF A NAMED STEP — Compare's half of the resolve.
 *
 * ── Why a second door and not a second implementation ───────────────────────
 *
 * Compare (docs/PLAN.md §4, unit 8d) puts a READ-ONLY column beside the live one,
 * locked to a step the person picked out of the ledger's own rows. For a row whose
 * picture is the proof sheet that column asks `book:load-at`; for a row that has a
 * DOCUMENT — the import, a rendering — it needs the path, which is exactly what
 * `documentAtPosition` answers for the position. So the two share `documentOfStep`
 * below and differ only in how they name the row: one reads the pointer, one is
 * handed an id. A second copy of that table would be two answers to "what does
 * this row show", and the way that goes wrong is that Compare draws a different
 * document from the one clicking the row would have opened.
 *
 * A STEP THIS PROJECT DOES NOT HOLD IS NULL rather than a throw, and the
 * difference from `deletableStep` is deliberate. That gate is for a call that
 * DESTROYS something and refuses the origin by name; this one is a read, and an id
 * that has gone stale is the ordinary consequence of a delete landing between the
 * picker being drawn and the answer being asked for. Null is what the renderer
 * already treats as "this row names no document of its own", so a vanished step
 * and a sheet-shaped one take the same path and neither is a failure to report.
 *
 * THE ORIGIN IS ANSWERABLE HERE, which `deletableStep` would have refused: the
 * import row is the single most useful thing to compare a later step against —
 * *"is this what the scan actually said?"* — and it is a read, so nothing about
 * the retention rule is in question.
 */
export async function documentAtStep(dir: string, stepId: string): Promise<string | null> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const step = ledgerOf(manifest).steps.find((row) => row.id === stepId) ?? null;
  if (step === null) return null;
  return await documentOfStep(resolved, manifest, step);
}

/**
 * WHAT THIS ROW SHOWS, when it shows a file at all.
 *
 * The body `documentAtPosition` grew, lifted out whole when Compare needed to ask
 * it about a row nobody is standing on. Every branch below was written for the
 * position and every word of its reasoning survives the move unchanged, because
 * none of it was ever about the POINTER: it is about what a row of this action,
 * with this payload, in this project, is a picture of.
 *
 * `A_BOOK_OF_ITS_OWN` IS THE TEST, read here rather than taken off `positionView`.
 * That is the same table `view.own` is composed from (shared/ledger.ts), asked
 * directly because this function is handed a step and has no position to compose a
 * view around — and asking the table is what keeps the two doors from drifting
 * apart the day an action changes sides.
 */
export async function documentOfStep(
  resolved: string,
  manifest: ProjectManifest,
  step: LedgerStep,
): Promise<string | null> {
  const view = { step, own: A_BOOK_OF_ITS_OWN[step.action] };

  if (view.own) {
    /*
     * ── A TRANSLATION'S BOOK IS CAST, BECAUSE THE RUN DID NOT WRITE ONE ───────
     *
     * A translate step retains its RECORDS — per-block answers in `readings/`,
     * the same shape and the same layer as a reading's bank — and nobody reads a
     * `.jsonl`. What the row shows is the book cast from those records
     * (`translationCastFile`, cast by the queue the moment the run lands), which
     * is a rendering: free, made again at any time, nobody's payload.
     *
     * ITS OWN PAYLOAD IS THE FALLBACK, AND ONLY FOR A ROW THAT PREDATES RECORDS —
     * which is what the `translationRecordsOf` test is doing and why it is not
     * merely an `onDisk` away. Those steps retain the EPUB the old EPUB→EPUB
     * translator wrote, so the payload is exactly the answer this function has
     * always given them and nothing about those projects changes. A RECORDS ROW'S
     * PAYLOAD IS ON DISK TOO, and it is a `.jsonl`: falling back to it would hand
     * a pane a file of sentences to open as a book, and `onDisk`'s existence test
     * would cheerfully agree that it is there.
     *
     * AND THE ANSWER IS NEVER THE PROJECT'S OWN FLOWING BOOK. Falling back to
     * `castBook` here would show the German book to somebody standing on the row
     * labelled *Translated (hu)* — which is the exact failure this table's own
     * history is about (`A_BOOK_OF_ITS_OWN`). Null is the honest answer and it is
     * now the ONLY answer this arm can give: a translate row is drawn on the proof
     * sheet out of the derived book its landing wrote, so there is no document at
     * this position for a viewer to be pointed at (docs/RENDERER.md §7).
     */
    /*
     * ── EVERY TEXT PASS, AND WIDENING IT WAS NOT OPTIONAL ─────────────────────
     *
     * This asked `action === 'translate'` while a rewrite was one. The 2026-09-05
     * split made `simplify` and `clean` their own actions, and `A_BOOK_OF_ITS_OWN`
     * answers true for all three — so left as it was, a rewrite row would have
     * fallen past this test into the import arm below and been resolved as a
     * DOCUMENT: `onDisk` would have found the `.jsonl` sitting there, agreed it
     * exists, and handed a pane a file of sentences to open as a book.
     *
     * The answer for all three is null, for the reason the paragraph above gives:
     * their rows are drawn on the proof sheet out of the derived book their
     * landing wrote, so there is no document at this position for a viewer to be
     * pointed at. The payload fallback survives for the one row that can still
     * take it — a translation made by the old EPUB→EPUB translator, which
     * `translationRecordsOf` answers null for and which no simplify or cleanup can
     * ever be (neither has existed outside records mode).
     */
    if (isTextPass(view.step.action)) {
      return translationRecordsOf(view.step) === null
        ? await onDisk(resolved, view.step.payload)
        : null;
    }
    /*
     * THE ORIGIN IS THE ONE ROW WHOSE ANSWER CAN BE A COPY OF ITSELF, and saying
     * so here is what stops a pointless swap. A project nobody has generated
     * anything from has `working/<stem>.pdf` copied from `archive/<file>.pdf`
     * byte for byte, and an EPUB project works from the stamped copy in
     * `generated/` precisely because `archive/` is never addressed. Sending the
     * pane to the archive in either case would reload the viewer to show the same
     * pages, and for the EPUB it would show a book without the stamps every later
     * pass needs. Where the live copy is NOT the original's own copy — a reprint
     * has replaced it — the archive is the only place the untouched scan still is,
     * and that is what the revert row is for.
     */
    /*
     * ── A MINT NAMES ITS PDF, LIKE EVERY OTHER IMPORT ─────────────────────────
     *
     * A refusal stood here from Wave 34 to Wave 41: `if (mintedFromPhotographs)
     * return null`, because a minted step's payload was `archive/<stem> pages`, a
     * DIRECTORY, and every line below is about a FILE. `exists` says yes to a
     * folder, so the row resolved to the directory, the renderer handed that to
     * `openFile`, and the app announced that the pages were gone while they sat
     * on the disk. Null was the honest answer to a question that should never
     * have been asked, and `positionView.pages` routed the row to a page-scroller
     * built for the occasion.
     *
     * The payload is a PDF now — for a mint because `recordMint` writes one, for
     * an older project because `healMintedArchive` re-points the step at the one
     * it assembled. So a minted row goes through the ordinary import arm below:
     * the live copy in `working/` if this mint is the one that made it, the
     * archived original otherwise, and pdf.js draws it. That is Owen's Wave 34
     * expectation verbatim — *"i expected it to take me to a pdf-like layout"* —
     * arriving as a PDF rather than as an imitation of one.
     */
    const live = view.step.action === 'import' ? await liveCopyOf(resolved, manifest, view.step.payload) : null;
    return await onDisk(resolved, live ?? view.step.payload);
  }

  /*
   * ── AND EVERY OTHER ROW NAMES NO DOCUMENT, WHICH IS THE WAVE LANDING ───────
   *
   * A read, a save, an edit: all three are drawn on the PROOF SHEET, out of the
   * book file and the ops chain that reaches this position (docs/RENDERER.md §3).
   * There is no file for a viewer to be pointed at, and there has not been one
   * since the per-step casts were deleted — this used to answer the save's own
   * cast, then the project's flowing book, then the live PDF, and all three of
   * those were the same claim: that the book is a document sitting in a folder.
   * It is not. `positionView.sheet` is what routes these rows, and null here is
   * how this side says so.
   */
  return null;
}

/**
 * STAND WHERE THIS DOCUMENT BELONGS — `documentAtPosition` run backwards, and the
 * two have to agree about every path either of them can name.
 *
 * ── The two selectors pretending to be one ──────────────────────────────────
 *
 * The library picked a FILE and the steps list picked a STEP, and the user found
 * the hole between them: *"i could have a document open, the epub, but have the
 * pdf import step selected, and id never know that i just ran translate against
 * the original pdf rather than the generated epub because i had the wrong step
 * selected, since the right document was open."* Every action in this app is made
 * from the POSITION — a reading's parent, a translation's source, what Export is
 * offered — so a pane showing one thing while the pointer stands on another is an
 * app that will quietly act on the file the person is not looking at. There is one
 * selection now, and focusing a document is one of the gestures that moves it.
 *
 * ── Why the mapping is HERE, beside the forward direction ───────────────────
 *
 * Because these are one fact read in two directions, and the day they disagree is
 * the day clicking a tab moves the pointer somewhere that then shows a different
 * file — a selection that fights the user. `documentAtPosition` is directly above;
 * everything this consults (`castBook`, `liveCopyOf`, the origin's payload) is
 * what that function consults, so a change to what a row SHOWS lands in the same
 * screen as what a document STANDS FOR.
 *
 * ── The four answers ────────────────────────────────────────────────────────
 *
 * AN EXPORT MOVES NOTHING. `final/` is where Save and Export write, and an export
 * is terminal by ruling — nothing is ever made from one (docs/WORKBENCH.md §1,
 * "it wont go into the working files as a step because it isnt the base for new
 * steps"). It has no step, so there is nowhere to stand, and yanking the pointer
 * to some plausible row because somebody glanced at a facsimile would be the app
 * inventing a selection out of a look.
 *
 * THE ORIGINAL STANDS ON THE IMPORT — its archived payload and the working copy
 * made from it, which are the two paths `documentAtPosition` answers for that row
 * and therefore the two that must come back to it. The live copy is asked for by
 * `liveCopyOf` rather than composed from `working/` and the stem: a working PDF
 * that came from somewhere else is a reprint that replaced the scan, and calling
 * that the import would stand the pointer on the untouched original for a document
 * the original is not.
 *
 * THE BOOK STANDS ON THE NEWEST STEP OF ITS CHAIN, and the newest is the point.
 * The cast in `generated/` is shown by the reading AND by every curate save under
 * it — one file, many rows — so the reverse direction has to choose, and the only
 * honest choice is the one you can act from: standing on an old save and then
 * translating would translate the book as of that save, which is not the book on
 * screen. (`castBook` records which cast is live; nothing records which READING
 * cast it, and `documentAtPosition` names that limitation rather than engineering
 * around it. The newest reading is the one that left it, so that is the chain
 * walked here — the same answer, from the same missing fact.)
 *
 * A TRANSLATION IS A BOOK OF ITS OWN and walks its own chain, from the translate
 * step that retained it down through its saves. That is why the walk stops at any
 * descendant that is a book of its own (`A_BOOK_OF_ITS_OWN`): a translation made
 * from a reading is emphatically not the newest step "of" that reading for the
 * purpose of deciding where the reading's own book stands.
 *
 * AND ANYTHING ELSE MOVES NOTHING. A loose file, a bank, a curation snapshot, a
 * rotated predecessor still on disk, a document from another project: none of them
 * is a row in this ledger, and the caller's tab is none the worse for the pointer
 * staying where the user put it. A READING'S FACSIMILE IS IN THAT LIST BY
 * DESIGN, and it is the one member of it that has a row in the left nav: it is
 * terminal, exactly as an export is (docs/RENDERER.md §0 A3), so looking at the
 * page-for-page record must not move the pointer onto the reading and make the
 * next thing somebody does be made from a glance.
 *
 * ── Standing still is not a write ───────────────────────────────────────────
 *
 * This runs on every focus gesture — a tab click, a Ctrl+Tab, a pane pointerdown —
 * where the answer is nearly always the row the pointer is already on. A manifest
 * rewritten on each of those would be a folder people sync churning for a fact
 * that did not change, so the write is skipped when nothing moves, and the answer
 * is composed from the catalogue as it already stands. `positionOf` and not
 * `ledger.position` for the comparison: an absent pointer MEANS the newest step
 * (shared/types.ts, `ProjectLedger.position`), so a project that has never written
 * one and is standing on its newest row must recognise itself and stay quiet.
 *
 * Where it does move it is `goToStep` and nothing else — the same write, the same
 * announcement, the same rows — because two ways to move the pointer is two
 * accounts of what moving it costs.
 */
export async function standForDocument(dir: string, absolutePath: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  const wanted = await stepStandingFor(resolved, manifest, absolutePath);
  if (wanted === null || wanted === positionOf(ledger)?.id) {
    return viewOf(manifest, ledger);
  }
  return goToStep(resolved, wanted);
}

/**
 * The step a document in this project belongs to, or null for one that belongs to
 * none.
 *
 * COMPARED PROJECT-RELATIVE AND FOLDED, whole path against whole path, with
 * `fold` — the same spelling-flattener both sides of the app already compare
 * paths with (shared/original.ts). Never by basename: a project holds
 * `archive/Book.pdf`, `working/Book.pdf` and `generated/archived-…/Book.pdf` at
 * once, and the layer is the entire difference between the untouched scan, the
 * copy being edited and a rotated predecessor nobody is standing on.
 *
 * THE PATH IS RESOLVED BEFORE IT IS FOLDED, because the caller's path came in
 * over the wire and `..` in the middle of it is a spelling of somewhere else.
 * A path outside this project's directory answers null: it is a document of some
 * other book, and moving THIS project's pointer for it would be a selection made
 * about a folder nobody clicked in.
 */
export async function stepStandingFor(
  dir: string,
  manifest: ProjectManifest,
  absolutePath: string,
): Promise<string | null> {
  const ledger = ledgerOf(manifest);
  // The DOCUMENT origin: the step whose payload is the archive. On a captured
  // project that is the mint — the capture root's payload is the recipe, and
  // a person focusing the book's PDF is standing on the step that minted it.
  const origin = documentOriginOf(ledger);
  if (origin === null) return null;

  const root = fold(path.resolve(dir));
  const target = fold(path.resolve(absolutePath));
  if (!target.startsWith(`${root}/`)) return null;
  const relative = target.slice(root.length + 1);

  // Terminal, and terminal means it is not a place to be standing.
  if (relative.startsWith(`${FINAL}/`)) return null;

  if (relative === fold(origin.payload)) return origin.id;
  const live = await liveCopyOf(dir, manifest, origin.payload);
  if (live !== null && relative === fold(live)) return origin.id;

  /*
   * A TRANSLATION IS FOUND BY ITS PAYLOAD, and only for a row that predates
   * records. Those steps retain the EPUB the old EPUB-to-EPUB translator wrote, so
   * the payload is a real document somebody can focus. A records translation has
   * no document at all — its row is drawn on the sheet — so there is nothing here
   * to find it by, which is `documentAtPosition` read backwards and is why the two
   * cannot disagree.
   */
  const translated = newestWhere(
    ledger,
    (step) => step.action === 'translate' && fold(step.payload) === relative,
  );
  if (translated !== null) return newestOfChain(ledger, translated).id;

  return null;
}
