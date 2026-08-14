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
  EngineInfo,
  EnvCatalogItem,
  EnvInstallProgress,
  EnvInstallRequest,
  EnvTooling,
  EpubBook,
  Job,
  JobRequest,
  ProjectSummary,
  RecentDocument,
  ServerStatus,
  SettingsView,
  SetupLogEvent,
  SetupRequest,
  SetupResult,
  TranslateRequest,
  WorkspacePlan,
  WslFacts,
} from './types';

/**
 * What the File menu asked for, since main cannot press a button in a tab.
 *
 * The accelerators live on the MENU rather than on a renderer keydown handler:
 * a menu item with `CmdOrCtrl+S` on it and a `keydown` listener for the same
 * chord both fire, and the menu is the half a user can discover.
 */
export type MenuAction = 'save' | 'save-as' | 'close-tab' | 'split-right' | 'toggle-documents';

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
    ): Promise<{ key: string; outputPath: string; inputPath: string }>;
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
    renameHeading(id: string, href: string, label: string): Promise<void>;
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
