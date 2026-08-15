/**
 * The contextBridge surface, declared where BOTH sides can see it.
 *
 * The renderer cannot import the preload (it imports `electron`), and the
 * preload must not invent a shape the renderer then re-declares by hand — two
 * hand-written copies of one interface is one refactor away from a silent
 * mismatch. So the interface lives here: preload.ts implements it, and the
 * renderer's `window.foundry` is typed as it.
 */
import type {
  BackendSettingsPatch,
  CloseWarning,
  ConversionKind,
  DeletionPrompt,
  DocumentDeletion,
  DoctorResult,
  EchoAnswer,
  EchoStanding,
  EngineInfo,
  EnvCatalogItem,
  EnvInstallProgress,
  EnvInstallRequest,
  EnvTooling,
  EpubBook,
  EpubMetadataFields,
  HeadingEcho,
  HeadingRenameOutcome,
  Job,
  JobRequest,
  LedgerLoad,
  LedgerStacks,
  MetadataOutcome,
  NavEcho,
  OverlayFileWire,
  OverlayLoad,
  PdfBlocksOutcome,
  PdfMetadataFields,
  ProjectLedger,
  ProjectSummary,
  ReadingPlan,
  RecentDocument,
  RelabelledBlock,
  ServerStatus,
  SettingsView,
  SetupLogEvent,
  SetupRequest,
  SetupResult,
  StepDeletion,
  StepRow,
  TranslateRequest,
  UnlinkedNote,
  UnlinkedNoteAnswer,
  UnlinkedNoteStanding,
  WorkspacePlan,
  WslFacts,
} from './types';

/**
 * What the File menu asked for, since main cannot press a button in a tab.
 *
 * The accelerators live on the MENU rather than on a renderer keydown handler:
 * a menu item with `CmdOrCtrl+S` on it and a `keydown` listener for the same
 * chord both fire, and the menu is the half a user can discover.
 *
 * `undo` and `redo` are the reason the Edit menu stopped being the platform's
 * role menu: its Undo is the focused text field's and cannot reach a document
 * history that lives in a service. The renderer decides which of the three
 * undos a chord meant — a text box's, the rendered frame's, or the book's.
 */
export type MenuAction =
  | 'save'
  | 'save-as'
  | 'close-tab'
  | 'split-right'
  | 'toggle-documents'
  | 'undo'
  | 'redo';

export interface FoundryApi {
  /** process.platform, for the one or two places the UI says "on Windows". */
  platform: string;

  /** The menu's File→Open, callable from the UI too. Resolves to the path, or null. */
  openDocumentDialog(): Promise<string | null>;
  /**
   * A dropped file's path, admitted by main or refused. The renderer cannot read
   * the file either way — this only tells the viewer what it may ask for.
   */
  openPath(candidate: string): Promise<string | null>;
  /**
   * The real path behind a dropped `File`. Electron removed `File.path` in
   * favour of `webUtils.getPathForFile`, and it is the reason a drop needs a
   * preload at all.
   */
  pathForFile(file: File): string;
  /**
   * The whole file, for the app's own pdf.js viewer.
   *
   * The renderer still cannot read a path it names: main answers only for files
   * already in the open allow-list, and rejects by name for anything else — the
   * same `admitted` check everything that serves a document asks.
   */
  documentBytes(absolutePath: string): Promise<Uint8Array>;
  /**
   * Copy an open document to a destination the user picks in main's own save
   * dialog. Returns where it went, or null for a cancel. The source must be in
   * the open allow-list — the dialog authorizes the destination, never the read.
   */
  documentSaveCopy(absolutePath: string, suggestedName: string): Promise<string | null>;
  reveal(target: string): Promise<void>;
  /**
   * The native box asked before a tab with something to lose closes. True means
   * close it. Native rather than an in-app modal because the question is modal
   * to the WINDOW, and because main already owns every other dialog in this app.
   *
   * Main picks the wording from the two flags — "no copy anywhere you chose" and
   * "the copy you chose is older than this" are different warnings.
   */
  confirmClose(warning: CloseWarning): Promise<boolean>;
  /**
   * The native box asked when an in-place edit deleted a footnote's LAST
   * reference. Three answers, and the caller writes something different for each
   * — see `UnlinkedNoteAnswer`.
   *
   * Main answers straight away, without a dialog, when the user has told it to
   * stop asking: the standing answer lives in `app-settings.json` and is stored
   * per ANSWER, so "always strike it" and "always leave it" are two different
   * instructions rather than one silenced question.
   *
   * ASKED AFTER THE EDIT HAS LANDED, always. An edit that appears the instant it
   * is typed is the whole feel of select mode; cancel undoes, it does not
   * pre-empt.
   */
  confirmUnlinkedNote(note: UnlinkedNote): Promise<UnlinkedNoteAnswer>;

  /**
   * "You renamed the contents entry — should the page's heading change too?"
   *
   * THE PAGE AND THE CONTENTS ARE TWO STATEMENTS and are allowed to differ, so
   * neither is derived from the other and renaming one only OFFERS to update
   * the other. Asked only when the other side still reads exactly what this one
   * used to; where they already differ the difference is somebody's decision
   * and there is no question.
   *
   * Main answers without a dialog when a standing answer is stored, per ANSWER,
   * in `app-settings.json` — and this direction's preference is separate from
   * the one below, because tidying a table of contents and correcting a word on
   * a page are different gestures with different intents.
   */
  confirmHeadingEcho(echo: HeadingEcho): Promise<EchoAnswer>;
  /**
   * "You edited this heading — should the contents entry change too?"
   *
   * The mirror of the above, and the direction that did not exist at all: an
   * in-place heading edit wrote the page and stopped, so a typo fixed on the
   * page stayed in the contents forever with nothing on screen to say so.
   */
  confirmNavEcho(echo: NavEcho): Promise<EchoAnswer>;

  /**
   * A document's own record — the OPF's Dublin Core fields, or the PDF's Info
   * dictionary — read and written through `foundry epub-meta` / `pdf-meta`.
   *
   * NEITHER OF THESE MOVES A FILE. `project.json` holds `title` and `stem` as
   * two fields precisely so that a book's NAME and its FILENAMES are decoupled:
   * correcting a title changes the metadata, and the paths stay exactly where
   * they are, because they are in recents, in whatever else the user has
   * pointed at them, and in a sync client's index.
   *
   * Reading and writing are one pair rather than four calls because the dialog
   * does both against the same document, and because a patch with no fields in
   * it is a read.
   */
  meta: {
    /** The open book, by its id. Main resolves the working tree; the renderer names no path. */
    readEpub(bookId: string): Promise<MetadataOutcome>;
    /** Only the fields that changed. A field left out is a field the engine never touches. */
    writeEpub(bookId: string, patch: Partial<EpubMetadataFields>): Promise<MetadataOutcome>;
    /** The working PDF, by the path this app already has open. Refused for any other. */
    readPdf(filePath: string): Promise<MetadataOutcome>;
    writePdf(filePath: string, patch: Partial<PdfMetadataFields>): Promise<MetadataOutcome>;
  };

  /**
   * The managed workspace: where a conversion writes.
   *
   * A conversion never asks the user where to put anything — `plan` hands the
   * dialog the two paths a job needs, and both land inside the PROJECT for the
   * document being converted (`<libraryDir>/projects/<key>/`). Getting a book
   * out of there is `epub.save` below, which repacks the working tree rather
   * than copying a file, because by then the book may have been edited.
   */
  workspace: {
    /**
     * Where an OCR job's answers go. No output file: the BANK is the product.
     *
     * Separate from `plan` below because a reading has no format and therefore
     * no output name to compose, and because `plan` rotates the `generated/`
     * file its rendering is about to replace — which a reading has no business
     * doing, since it writes nothing there.
     */
    planReading(inputPath: string): Promise<ReadingPlan>;
    /** The kind decides the output's EXTENSION, not just its `--format`. */
    plan(inputPath: string, kind: ConversionKind): Promise<WorkspacePlan>;
    /**
     * Where a translation of this book goes: `<the book's name> (<lang>).epub`,
     * in the same project as the book it was made from.
     *
     * Separate from `plan` because it answers a smaller question — there is no
     * readings bank to name, and the language rather than a format decides the
     * name.
     *
     * It also answers back with the input the job must READ. Main exports the
     * book's working copy first, because an edit no longer repacks and the
     * engine is a separate process handed a path — so the file to translate is
     * the export, not the file the tab happens to be pointed at. Use
     * `inputPath` verbatim; a request that named the tab's own path would be
     * translating the book as it was before the curation.
     */
    planTranslation(
      inputPath: string,
      targetLanguage: string,
    ): Promise<{ key: string; outputPath: string; inputPath: string; bankPath: string }>;
  };

  /**
   * A book: unpacked once into its project's `working/` tree, served to a
   * sandboxed <iframe>, edited as text, and packed back up only on a Save.
   *
   * `close` deletes NOTHING now — the tree is the book's durable working copy —
   * but it is still not optional: it is what stops main serving that book's
   * members, and a tab that closed without calling it leaves a live protocol
   * route to a document nobody is looking at.
   */
  epub: {
    open(filePath: string): Promise<EpubBook>;
    close(id: string): Promise<void>;
    /** One chapter's XHTML source, off the working tree. */
    readMember(id: string, href: string): Promise<string>;
    /**
     * Replace one chapter's source, in the working tree, and REPACK NOTHING —
     * the write itself is the durable commit. Resolves with the bytes written.
     */
    writeMember(id: string, href: string, text: string): Promise<number>;
    /**
     * Rename a TOC entry: `href` is a sidebar row's — a chapter document, or
     * `document#fragment` for a section header inside one. Main rewrites the
     * nav label and, when its text matched, the heading itself; rejects when
     * nothing in the book carries the entry. Into the working tree, like an edit.
     */
    renameHeading(id: string, href: string, label: string): Promise<HeadingRenameOutcome>;
    /**
     * The "yes, change the page too" answer to `confirmHeadingEcho`.
     *
     * A door of its own because the question is asked after the nav has already
     * been written, and because `was` is CHECKED against the file rather than
     * trusted: between the question and the answer the frame may have written
     * that very heading, and a dialog's older idea of it must not overwrite
     * somebody's newer words.
     */
    renamePageHeading(id: string, href: string, label: string, was: string): Promise<void>;
    /**
     * The mirror question's subject: the contents entry that still reads what
     * this heading used to say, or null when there is nothing to offer — the
     * block is not a heading, the book has no contents, or the two already
     * differ. A QUERY; nothing is written.
     */
    navEchoForBlock(id: string, href: string, blockId: string, was: string): Promise<NavEcho | null>;
    /**
     * Select mode's cut mark: `data-bf-cut="1"` on every element named in
     * `blockIds`, in the chapter member `href`, in the working tree — in ONE
     * read and ONE write.
     *
     * THE CUT LIVES HERE AND NOWHERE ELSE — not in a Set in a service, not in a
     * sidecar, not in the manifest. One store means the mark survives the
     * iframe reloads that destroy anything held in memory, the viewer and
     * `foundry epub-final` read the same fact, and there is no identity problem
     * because the mark is ON the element.
     *
     * THE ONLY CUT DOOR THERE IS, and one block goes through it as a list of
     * one. Every id is located before a byte moves, so a batch lands whole or
     * refuses whole: a hundred separate calls could fail in the middle and
     * leave a chapter half struck with a count on screen describing neither
     * half. Rejects by name when nothing in that member carries an id, or when
     * more than one element does. Bumps no revision: the frame painted it
     * already.
     *
     * RESOLVES WITH THE IDS THAT ACTUALLY MOVED, which is not always the ids
     * that were named — a block already carrying the mark is not a change. The
     * count is what the app says out loud; the list is what its undo ledger
     * records, because main is the only side that read the file and so the only
     * side that can say which blocks were standing beforehand.
     */
    setCuts(id: string, href: string, blockIds: string[], cut: boolean): Promise<string[]>;
    /**
     * The same cut mark on a FOOTNOTE, addressed by its own id (`fn25`) rather
     * than by `data-bf-id` — that is the name its reference used, and the only
     * one available once the reference has been deleted.
     *
     * A cut and not a deletion: the `<aside>` is drawn struck through, Delete on
     * it brings it back, and it leaves the book only when `epub-final` builds
     * the edition. A footnote is evidence.
     *
     * False means the note already said this, so nothing was written and the
     * undo ledger records no row — an entry promising to bring back a footnote
     * that was struck before this ran would undo somebody else's decision.
     */
    setNoteCut(id: string, href: string, noteId: string, cut: boolean): Promise<boolean>;
    /**
     * Relabel the whole selection: a different `data-bf-cat`, the same shape,
     * in ONE read and ONE write.
     *
     * A paragraph relabelled `footnote` STAYS A `<p>` in the prose — it does not
     * become an `<aside>` and it does not move into the footnotes section. That
     * re-shaping belongs to `foundry epub-final` and is not in this app. What
     * the label does is tell the engine and the translator what the block is.
     *
     * Rejects by name for a category the emitter never writes, for an id that is
     * absent or duplicated, and for a block carrying no `data-bf-cat` at all —
     * and rejects before anything is written, so a selection of thirty is
     * relabelled whole or not at all.
     *
     * Resolves with the blocks that moved AND THE LABEL EACH ONE CARRIED, which
     * is what the undo ledger needs: thirty blocks relabelled in one gesture
     * were not all the same thing beforehand, and each has to go back to its
     * own.
     */
    setCategories(
      id: string,
      href: string,
      blockIds: string[],
      category: string,
    ): Promise<RelabelledBlock[]>;
    /**
     * The words of one block, edited in place. `html` is the block's new inner
     * markup as the frame serialized it.
     *
     * Main refuses anything that is not a WORD change: every tag must be inline
     * markup, and the multiset of start tags with their attributes must be
     * unchanged — so an `<em>` and a pagebreak span cannot be altered, dropped
     * or invented, while the words around them are free. The one exception is a
     * footnote reference: a `noteref` anchor and a `<sup>` may DISAPPEAR,
     * because a reference number is a mark on the page an editor may want gone.
     *
     * Resolves with the notes that edit left unreachable — a question rather
     * than a failure, since the write has already landed. `confirmUnlinkedNote`
     * is what asks it.
     */
    setBlockHtml(id: string, href: string, blockId: string, html: string): Promise<UnlinkedNote[]>;
    /**
     * Put a block's inner markup back exactly as it was — the "cancel" answer.
     *
     * A DOOR OF ITS OWN because `setBlockHtml` forbids markup being gained, and
     * restoring a deleted reference number is a `<sup>` and an anchor
     * reappearing. Main makes the mirror check instead: what is on disk now must
     * be a legal word-edit OF the text being restored, or the restore is refused
     * rather than overwriting somebody else's change.
     */
    restoreBlockHtml(id: string, href: string, blockId: string, html: string): Promise<void>;
    /**
     * Give this book the categories and ids select mode addresses, by spawning
     * `foundry epub-stamp` on its working tree. `members` is the spine in
     * reading order, and main uses it only to decide whether a spawn is worth
     * making: a book whose every stamped element is already named needs none.
     *
     * `minted` is how many ids the engine wrote. Zero means the book was
     * already stamped, which is the ordinary case — an imported book is stamped
     * as it is imported.
     */
    stamp(id: string, members: string[]): Promise<{ minted: number; documents: number }>;
    /**
     * The save picker, opening on the library folder. Null when dismissed.
     * Takes the book's id because the answer is also a GRANT: main records it,
     * and `save` refuses any destination that was never granted — either by
     * this dialog or by being the file the book was opened from.
     */
    chooseSavePath(id: string, suggestedName: string): Promise<string | null>;
    /** Repack the working copy to a granted path. Rejects for any other. */
    save(id: string, destination: string): Promise<void>;
  };

  /**
   * A document's undo ledger, kept in its project so it survives the process.
   *
   * IT USED TO END WITH THE TAB. Owen asked for the other thing: open a project,
   * edit a file, have Foundry die randomly, and still have the stack. So the
   * ledger is flushed to `<project>/history/<working tree>.json` after every
   * mutation of either stack — whole file, atomically — and read back the next
   * time the book opens.
   *
   * THE RENDERER NAMES A BOOK AND NOTHING ELSE. Where the file is, and which
   * GENERATION of the working copy it belongs to, are main's own records: a row
   * names `data-bf-id="p47-3"`, that name means one thing in one working copy,
   * and a history from before a re-cast or a start-over would put a paragraph in
   * the wrong block. Main compares the file's generation with the catalogue's
   * and archives a history that does not match rather than replaying it — see
   * electron/history.ts for the three outcomes.
   */
  history: {
    /**
     * The stacks this document was left with, and one sentence about how that
     * went. Empty stacks with a notice means a history was found and could not
     * be used; empty stacks with no notice means there has never been one.
     */
    load(bookId: string): Promise<LedgerLoad>;
    /**
     * Flush both stacks. Rejects by name when the file on disk is one this
     * session could not read or move aside — "could not preserve your history"
     * and "have therefore overwritten it" must not be the same event.
     */
    save(bookId: string, stacks: LedgerStacks): Promise<void>;
  };

  /**
   * The block editor: what the model read off a scan's pages, and what a person
   * has decided about it.
   *
   * THE RENDERER NAMES THE PDF IT ALREADY HAS OPEN and nothing else. Which
   * project that is, where the readings bank sits, where the corrections are
   * filed and which READING they are bound to are all main's own records — the
   * same division as `history`, and for the sharper version of its reason. An
   * overlay names blocks as `(page, order)` in one pass of the model over the
   * pages; a bank that has been read again renumbers every one of them; and a
   * renderer that could assert which reading a file belongs to could assert the
   * wrong one and silently strike somebody else's paragraphs. Every call here is
   * gated by the same `admitted` allow-list the viewer's own bytes go through.
   */
  overlay: {
    /**
     * Every block of every page, with the render frame its boxes are measured
     * in, plus the chapter starts the engine would detect for itself.
     *
     * A RESULT AND NOT A REJECTION: a scan nobody has converted has no bank, and
     * that is a sentence in the pane rather than a broken tab.
     */
    blocks(pdfPath: string): Promise<PdfBlocksOutcome>;
    /**
     * The corrections as they stand, and one sentence about how that went. A
     * clean overlay with a notice means a file was found and could not be used —
     * it has been archived aside, and the sentence names where it went.
     */
    load(pdfPath: string): Promise<OverlayLoad>;
    /**
     * Write the whole file. Called after every gesture, atomically, because the
     * alternative is a curation that survives a crash in halves.
     *
     * Main stamps its own generation over whatever arrives and refuses to write
     * at all over a file it could not read or move aside.
     */
    save(pdfPath: string, file: OverlayFileWire): Promise<void>;
    /**
     * The block editor's own undo ledger — the same two calls `history` has, for
     * a document that has no book id because it is a scan.
     */
    loadLedger(pdfPath: string): Promise<LedgerLoad>;
    saveLedger(pdfPath: string, stacks: LedgerStacks): Promise<void>;
    /**
     * Freeze the corrections as they stand — a curation step in the history.
     *
     * ── This is not the Save people are used to, and the difference matters ────
     *
     * `save` above already wrote the file, atomically, the instant the gesture
     * happened. There is no unsaved work here for a Save button to rescue. What
     * this makes is a COPY THAT WILL NEVER CHANGE AGAIN: a snapshot with a step of
     * its own, which the user can click back to, render from, and delete
     * deliberately. It is the difference between a document that autosaves and one
     * you can name a version of.
     *
     * THE LIVE OVERLAY IS UNTOUCHED. It is not cleared, not moved and not
     * archived — the editor is in exactly the state it was in a moment before,
     * and the snapshot is the thing that is retained. A commit that emptied the
     * editor would repaint somebody's book as uncorrected as the reward for
     * saving it.
     *
     * REJECTS with a sentence when there is nothing to freeze. An empty snapshot
     * would put a row reading "Saved corrections" between the reading and the
     * translation for a book nobody has curated.
     *
     * Resolves with the whole updated ledger, so the caller repaints the history
     * from the answer rather than asking for it again and drawing a list from
     * before its own commit.
     */
    commit(pdfPath: string): Promise<ProjectLedger>;
  };

  /**
   * The step ledger — everything that has been done to one book, and where the
   * user is standing in it.
   *
   * ── What this surface is, in one paragraph ────────────────────────────────
   *
   * Every project carries a list of STEPS: the import, each reading, each frozen
   * curation, each translation. Each one is the retained payload of one action and
   * records which step it was made FROM, so the structure is a tree — but the UI
   * is a flat chronological list, like Photoshop's History panel, with one quiet
   * "from Read" annotation on the rows where the chain jumps. DO NOT BUILD A TREE
   * UI. A position pointer marks where the user is standing; clicking a row moves
   * it, and acting from an earlier row APPENDS rather than truncating, which is
   * the one thing Photoshop does that this must never do.
   *
   * ── Why every one of these is a main-process call ─────────────────────────
   *
   * The renderer names a project directory and nothing else, exactly as it names a
   * PDF for the overlay calls. Where the payloads are, what a delete would
   * destroy, what a step costs to lose and whether a path is a project at all are
   * main's own records — and `delete` UNLINKS FILES, so a renderer's word about a
   * directory cannot be an authorization (the `admitted` precedent). Main proves
   * the directory is one of Home's projects on all four calls, not only the
   * destructive one: a gate that guards only the delete is a gate somebody routes
   * around by reading first.
   *
   * ── And why the ordering never crosses the boundary ───────────────────────
   *
   * `read` answers with the rows already composed. The chronological order and the
   * "from …" annotation are the whole of this design's concession to the tree, and
   * a renderer deriving them would be a second implementation of the one rule that
   * decides whether the flat list is misleading about what was made from what.
   */
  ledger: {
    /**
     * One project's steps, plus the flat list the accordion draws.
     *
     * REJECTS for a catalogue that will not parse, including one whose stored
     * ledger is malformed — a project in that state is already listed on Home
     * with the reason on its row, and this is the same refusal reaching the same
     * strip.
     */
    read(projectDir: string): Promise<{ ledger: ProjectLedger; rows: StepRow[] }>;
    /**
     * Stand on a different step. Answers with the ledger as it now stands.
     *
     * FREE, INSTANT AND UNCONFIRMED — one line of the manifest, no job, no
     * rendering, no file written. That is the promise every history panel makes
     * by looking like one, and it is kept here: what changes is which state the
     * viewers show and which step the next action is made from.
     *
     * Rejects by name for a step id this project does not hold. The caller is
     * clicking a row main drew, so an unknown id means the two are looking at
     * different ledgers, and standing somewhere plausible instead would show
     * somebody a book they did not ask for.
     */
    go(projectDir: string, stepId: string): Promise<ProjectLedger>;
    /**
     * What deleting this step would take — the facts for the confirm card.
     *
     * EVERY CASUALTY, NAMED, WITH ITS OWN COST SENTENCE. A delete cascades: a
     * reading's translations were made from that reading and have nowhere to
     * hang, so they go with it. That was the ruling, and what makes it safe is
     * that the user reads the list first — which is what this is for.
     *
     * The sentences are composed in main, from the retention rule, in the words
     * every other warning in this app uses for the same loss. An "Are you sure?"
     * over a list of four teaches people to click through the one that was about
     * their curation.
     *
     * IT ALSO PROVES THE DELETE IS ALLOWED, so a card is never put on screen for
     * something the delete would refuse a click later. The origin rejects here:
     * deleting the import is deleting the project, and `projects.delete` does
     * that with its own ceremony.
     */
    describeDelete(projectDir: string, stepId: string): Promise<StepDeletion>;
    /**
     * Do it: the step and its whole subtree off the ledger, their payloads off
     * the disk. Answers with the ledger that is left.
     *
     * ASKING IS THE CALLER'S JOB; PROVING IS STILL MAIN'S. This runs the same
     * refusals `describeDelete` ran, because a renderer that skipped the question
     * must meet the same answer — including the origin's, which rejects by name.
     *
     * It really deletes. Nothing is rotated aside and there is no copy anywhere
     * else; a payload that survives is one another step still names.
     */
    delete(projectDir: string, stepId: string): Promise<ProjectLedger>;
  };

  /**
   * The app's own preferences — not the engine's settings.json, which belongs to
   * the engine and is read by every `vlm-convert` on the machine.
   *
   * There is one so far and it earns the surface: a dialog with a
   * don't-ask-again checkbox that cannot be un-checked anywhere is a trap. The
   * standing answer is stored per ANSWER (`cut` / `keep`), and `ask` puts the
   * question back.
   */
  prefs: {
    unlinkedNoteAnswer(): Promise<UnlinkedNoteStanding>;
    /** Returns the value as stored, so a nonsense one comes back as `ask`. */
    setUnlinkedNoteAnswer(answer: UnlinkedNoteStanding): Promise<UnlinkedNoteStanding>;
    /** "Renaming a contents entry also changes the page's heading." */
    contentsRenameEcho(): Promise<EchoStanding>;
    setContentsRenameEcho(answer: EchoStanding): Promise<EchoStanding>;
    /** "Editing a heading on the page also changes the contents entry." */
    headingEditEcho(): Promise<EchoStanding>;
    setHeadingEditEcho(answer: EchoStanding): Promise<EchoStanding>;
  };

  /**
   * The library folder — where conversions land and where the pickers open.
   *
   * Changing it affects NEW work only: nothing is migrated, and recents keep
   * the absolute paths they were recorded with.
   */
  library: {
    dir(): Promise<string>;
    /** The directory picker. Chooses without saving; `set` is the commit. */
    choose(current: string): Promise<string | null>;
    set(dir: string): Promise<string>;
  };

  /**
   * Home's primary listing: one row per BOOK, expanding to the documents in it.
   *
   * Read off the library's `projects/` directory every time rather than mirrored
   * — a project gains an output when a three-hour conversion lands, and a cached
   * list would be a list from before the thing the user is waiting for.
   */
  projects: {
    list(): Promise<ProjectSummary[]>;
    /**
     * The library changed — a project made, a reading landed, an output
     * recorded. Returns its own unsubscribe.
     *
     * NO PAYLOAD, deliberately. Composing the listing is a directory walk and
     * main does not do one on the chance that somebody is looking; this says
     * only that something moved, and the mirror asks for the list.
     *
     * IT EXISTS BECAUSE A DROPPED FILE HAD NO OTHER WAY TO ANNOUNCE ITSELF. The
     * import that turns somebody's scan into a project runs in the background,
     * behind the tab that already opened, and the renderer's project list used
     * to re-read only on three occasions that a background import is not one of.
     * So the app went on saying a book was not in the library while its folder
     * sat on the disk — and every question asked of "the project this document
     * is in" was answered from that.
     */
    onChanged(listener: () => void): () => void;
    /**
     * What deleting this project would destroy, in sentences worth reading.
     *
     * THE QUESTION MOVED TO THE RENDERER AND THE FACTS DID NOT. Main used to ask
     * in a native message box; the app asks in its own modal now, and this is
     * what it asks WITH — the size on disk, the readings bank's page count, the
     * filed copy, the flat statement that nothing comes back. Main is the only
     * side that can know any of it.
     *
     * It also PROVES the delete is currently allowed, so the app never puts a
     * warning on screen for something it would refuse a click later. A refusal —
     * a book from the project open in a tab, a job queued to write into it —
     * rejects with the reason.
     */
    describe(dir: string): Promise<DeletionPrompt>;
    /**
     * Erase one project's whole directory — archive, generated, working, final,
     * readings, history — from the disk. It really deletes; nothing is rotated
     * aside and there is no copy anywhere else.
     *
     * ASKING IS THE CALLER'S JOB NOW; PROVING IS STILL MAIN'S. This runs the
     * same refusals `describe` ran, because a renderer that skipped the question
     * must meet the same answer — the checks live in the call that erases rather
     * than in the one that asks. It names a directory and main decides, the same
     * way it does for everything else it is handed a path for.
     *
     * Resolves to the sentence for the notice strip once the folder is gone. A
     * refusal REJECTS with the reason.
     */
    delete(dir: string): Promise<string>;
  };

  /**
   * One document inside a project — the file, and its row in the catalogue.
   *
   * A NARROWER DOOR THAN `projects`, deliberately. Main refuses any path that is
   * not strictly inside `<library>/projects/<project>/`, so a renderer cannot
   * name an arbitrary file and have it unlinked; and it refuses the project's
   * ORIGINAL outright, because deleting that is deleting the project and there
   * is a separate call for that with a separate warning.
   */
  documents: {
    /**
     * What deleting this document would do — and whether it is the original.
     *
     * `original: true` means the prompt describes the PROJECT: every other
     * document in the folder was made from this file, so there is no version of
     * removing it that leaves a project behind. The caller is expected to run
     * `projects.delete` on `projectDir` instead.
     */
    describe(filePath: string): Promise<DocumentDeletion>;
    /**
     * Remove the file and its catalogue row. Resolves to the notice sentence.
     *
     * A file that is already MISSING is still removable: its row is the only
     * thing left of it, and refusing on the grounds that the bytes are gone
     * would leave a listing nobody can clean.
     */
    delete(filePath: string): Promise<string>;
  };

  /**
   * The individual documents that have been opened, newest first.
   *
   * Still the app's own userData, never the engine's settings. Home lists
   * PROJECTS now and reads this only through main, which uses it to answer "when
   * was anything in this project last opened" — a fact a folder on disk does not
   * carry.
   */
  recents: {
    list(): Promise<RecentDocument[]>;
    forget(filePath: string): Promise<RecentDocument[]>;
    clear(): Promise<RecentDocument[]>;
  };

  queue: {
    list(): Promise<Job[]>;
    enqueue(request: JobRequest): Promise<Job>;
    /** The same serial queue, a different command. See `TranslateRequest`. */
    enqueueTranslate(request: TranslateRequest): Promise<Job>;
    /**
     * Release everything currently HELD, in order. Answers with how many.
     *
     * Both engine enqueues above return a job that is held and idle, so this is
     * the call that makes anything happen. A job added after this returns is
     * held again and waits for the next press (electron/job-queue.ts).
     */
    start(): Promise<number>;
    /**
     * Take a held or queued row out of the list entirely.
     *
     * Not `cancel`: a job that never started has nothing to stop and leaves no
     * record worth keeping, and a `cancelled` row for it is residue in a shelf
     * somebody is using to assemble a batch. Refused on a running job, which is
     * what `cancel` is for.
     */
    remove(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
    clearFinished(): Promise<void>;
    /** Every change, whole list. Returns its own unsubscribe. */
    onChanged(listener: (jobs: Job[]) => void): () => void;
  };

  engineInfo(): Promise<EngineInfo>;
  doctor(endpointUrl?: string): Promise<DoctorResult>;
  settings: {
    read(): Promise<SettingsView>;
    write(patch: BackendSettingsPatch): Promise<SettingsView>;
  };

  /**
   * WSL, and the environment vLLM is served from.
   *
   * Facts are re-measured on demand rather than cached in the renderer: a user
   * who installs a distro while the settings screen is open should be able to
   * press the button again and see it.
   */
  wsl: {
    /** Which distros exist, or why there are none. */
    facts(): Promise<WslFacts>;
    /** What one distro can build an environment with. */
    tooling(distro: string): Promise<EnvTooling>;
  };

  /**
   * The prebuilt environments — the ones the conversions were MEASURED with.
   *
   * The app installs what this machine is missing by itself at startup, as rows
   * in the queue shelf; this surface is the manual path for the cases automation
   * cannot decide: a different location, a particular WSL distro, a reinstall.
   */
  env: {
    /** Platform-relevant entries, with installed state measured now. */
    catalog(): Promise<EnvCatalogItem[]>;
    /**
     * Queue an install and return its job id. Resolves as soon as it is
     * QUEUED — the shelf and `onInstallProgress` carry the rest, and a promise
     * held open across a five-gigabyte download is a promise a reload loses.
     */
    install(request: EnvInstallRequest): Promise<string>;
    cancel(): Promise<void>;
    /** A directory for an install, or null. Meaningless for a WSL target. */
    chooseDest(defaultPath: string): Promise<string | null>;
    /** Every phase change, as it happens. Returns its own unsubscribe. */
    onInstallProgress(listener: (progress: EnvInstallProgress) => void): () => void;
  };

  backendSetup: {
    /**
     * Build the environment. Resolves with the outcome; a failure is a result,
     * not a rejection, because every one of them is a sentence to read.
     */
    run(request: SetupRequest): Promise<SetupResult>;
    cancel(): Promise<void>;
    /** Every line, as it happens. Returns its own unsubscribe. */
    onLog(listener: (event: SetupLogEvent) => void): () => void;
  };

  vllmServer: {
    status(): Promise<ServerStatus>;
    /** Rejects with the guest's log tail when it will not start. */
    start(): Promise<ServerStatus>;
    stop(): Promise<ServerStatus>;
    onStatus(listener: (status: ServerStatus) => void): () => void;
    /**
     * Minutes an app-started server outlives a drained queue. 0 — the default
     * — stops it the moment the queue empties; the ceiling is main's
     * (app-settings.ts), so whatever is asked for, an idle server always has a
     * scheduled end. `setKeepWarm` returns the value as clamped and stored.
     */
    keepWarm(): Promise<number>;
    setKeepWarm(minutes: number): Promise<number>;
  };

  onDocumentOpened(listener: (absolutePath: string) => void): () => void;
  /**
   * A document this app opened has MOVED to the copy it actually works on.
   *
   * ── The working-copy model, finally true of the tab as well ────────────────
   *
   * A file from outside the library is imported: copied into `archive/` as the
   * untouched original and again into the live layer, which is what "the PDF"
   * means everywhere else in this app. The tab, though, kept the path the open
   * came in on — because the import is deliberately not awaited (a 400 MB sha256
   * must not sit between a person and their document), so at the moment the tab
   * is made there is nothing else to name.
   *
   * THAT COST A USER THEIR WHOLE PIPELINE. Their scan opened off `E:\\…`, the
   * project was built, the reading ran and landed — and Generate said "this book
   * has not been read yet", because `projectFor(E:\\…)` is null and every
   * question this app asks about the document in front of you is asked of the
   * tab's path. Restarting did not help: it was identity, not staleness.
   *
   * So main says where the document went as soon as it knows, and the tab MOVES
   * — the same tab, not a second one. A document that was already inside a
   * project never fires this, because there is nowhere for it to go.
   */
  onDocumentRelocated(listener: (move: { from: string; to: string }) => void): () => void;
  onNavigate(listener: (route: string) => void): () => void;
  /** File→Save As / Close Tab, which are accelerators on the menu. */
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}
