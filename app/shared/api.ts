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
  PdfMetadataFields,
  ProjectSummary,
  RecentDocument,
  RelabelledBlock,
  ServerStatus,
  SettingsView,
  SetupLogEvent,
  SetupRequest,
  SetupResult,
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
     * Erase one project's whole directory — archive, generated, working, final,
     * readings, history — from the disk. It really deletes; nothing is rotated
     * aside and there is no copy anywhere else.
     *
     * MAIN ASKS FIRST, in its own native dialog, naming the book and saying what
     * is in the folder. The renderer never gets to skip that question: it names
     * a directory and main decides, the same way it does for everything else it
     * is handed a path for.
     *
     * Resolves to the sentence for the notice strip once the folder is gone, or
     * NULL when the user answered Keep it. A refusal — a path that is not a
     * project, a book from it open in a tab — REJECTS with the reason, so the
     * caller's ordinary catch says it and a cancel is never mistaken for one.
     */
    delete(dir: string): Promise<string | null>;
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
  onNavigate(listener: (route: string) => void): () => void;
  /** File→Save As / Close Tab, which are accelerators on the menu. */
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}
