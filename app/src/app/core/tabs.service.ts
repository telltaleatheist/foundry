import { Injectable, computed, effect, inject, signal } from '@angular/core';

import type { FoundryApi } from '@shared/api';
import { categoryLabel } from '@shared/categories';
import type { EpubBook, JobKind, UnlinkedNote } from '@shared/types';

import { QueueService } from './queue.service';
import { api } from './foundry';

/**
 * The open documents — the list down the left, and the one place that knows
 * which is which.
 *
 * TABS ARE RENDERER STATE, on purpose. Main owns everything with a lifetime — a
 * conversion, an unpacked book's temp directory, the allow-list — but which of
 * them is on screen and in what order is a window's own business, and pushing
 * that through IPC would make a reload of the renderer able to disturb it.
 *
 * The one door in is `document:opened`. The menu, the dialog, a drop, a path on
 * argv and a conversion that just finished all reach main first (which decides
 * whether the file is openable at all) and arrive back here as that event. So
 * this service never has to decide whether a path is real, and there is exactly
 * one code path that creates a tab.
 *
 * ── Panes ────────────────────────────────────────────────────────────────────
 *
 * The workspace is one to five PANES side by side, and A PANE SHOWS EXACTLY ONE
 * DOCUMENT. They exist for one comparison in particular: a book beside its
 * translation, the German page and the English page under two hands at once.
 * Everything else about panes follows from that, including the auto-open rule (a
 * finished job lands in a pane of its OWN, so a translation appears beside its
 * source rather than on top of it).
 *
 * EACH PANE USED TO CARRY A CHROME-STYLE STRIP of its own — VS Code's editor
 * groups, a stack of tabs per column. Five columns on a 1920-wide window give
 * each strip 370 pixels, and three tabs in one of them are unreadable stubs, so
 * the strips are gone and the documents are a VERTICAL LIST in a panel of their
 * own (app-open-documents). A list does not degrade with the number of columns,
 * every pane got its 44px strip back as page, and the list is the only place a
 * document's order exists.
 *
 * THE TABS STAY IN ONE FLAT LIST and the panes hold ids into it. A pane owning
 * whole Tab objects would put `patch()` — the one function every edit, save and
 * flag in this file goes through — behind a search of a list of lists, and the
 * first thing to rot would be an edit landing in one pane's copy of a tab while
 * another pane showed the other. One list, one identity per tab; the panes
 * decide only where each is shown.
 *
 * A DOCUMENT IS IN AT MOST ONE PANE. Clicking a row for something already on
 * screen REVEALS it rather than putting a second viewer over one unpack — the
 * rule `adopt()` has always enforced for files — and dragging a row MOVES it.
 * Two panes on one tab would also share its `chapterHref`, so the two columns
 * would look scroll-locked to each other for reasons nothing on screen explains.
 *
 * ONE PANE IS FOCUSED, and it is what the rail, the menu and the keyboard mean
 * by "the document": `active()` is the focused pane's document and nothing else.
 * With a single pane open, that is exactly the app that existed before panes did
 * — the feature is meant to be invisible until it is used.
 *
 * ── The HTML editor is a tab, not a mode ─────────────────────────────────────
 *
 * "Edit HTML" used to split the book's own tab down the middle. It opens a tab
 * now — kind `editor`, pointed at the book's tab through `sourceTabId` — which
 * the pane rules then place beside the book like anything else. One document
 * with two faces rather than two documents: the editor has no book of its own,
 * reads the source tab's chapter, and writes through the same `writeChapter`
 * that bumps the source's revision and reloads whatever pane is rendering it.
 */

export type TabKind = 'pdf' | 'epub' | 'editor';

export interface Tab {
  id: string;
  kind: TabKind;
  /**
   * The file this tab is showing. For a conversion that has not been saved
   * anywhere, that is the copy in the managed workspace — and it stays that even
   * after Save As, because the saved file is a byte-for-byte copy and re-opening
   * it would throw away an unpack for nothing.
   */
  path: string;
  title: string;
  /**
   * The Chrome dot. True while no copy of this book exists anywhere the user
   * chose — it lives in the library workspace and nowhere else.
   *
   * DISTINCT FROM `modified`, and the distinction is the whole point. This one
   * is about a book nobody has filed; that one is about a filed copy that has
   * fallen behind. A tab can be either, both, or neither, and the close warning
   * says something different for each.
   */
  unsaved: boolean;
  /**
   * Edited since the copy at `savedPath` was written.
   *
   * The app DOES edit documents now (the chapter editor), so "nothing in this
   * app modifies a document" is no longer true and this flag is what replaced
   * it. It never means the edits are at risk: every keystroke that lands is
   * written through to the workspace copy before this is set.
   */
  modified: boolean;
  /**
   * Where Save/Save As put it, once it has been anywhere. Seeded with the file
   * itself for a book opened from the user's own disk — that file is already a
   * copy they chose, and Save should update it rather than ask.
   */
  savedPath: string | null;
  /** The unpacked book. Null for a PDF, and for an EPUB that is still opening. */
  book: EpubBook | null;
  /** Which chapter the viewer is showing. */
  chapterHref: string | null;
  /**
   * For an `editor` tab: the EPUB tab whose chapter it is editing.
   *
   * The link runs THIS WAY ONLY. A book pointing at its editor as well would be
   * two facts to keep agreeing, and the one that fell behind would be the one
   * the close cascade reads — so the book's editor is FOUND (`editorFor`) and
   * never stored.
   */
  sourceTabId: string | null;
  /**
   * True while the PDF viewer is showing the text layer beside the page.
   *
   * On the TAB rather than in the component, for the same reason `thumbnails`
   * is: only the active tab's viewer is in the DOM, so a component that held
   * this would forget it the moment the user looked at something else. A view
   * mode that resets itself when you glance away is a view mode you stop using.
   */
  layerView: boolean;
  /** True while the PDF viewer's thumbnail strip is up. ON by default — it sits
   *  along the bottom where it costs little, and Owen wants the pages in reach. */
  thumbnails: boolean;
  /**
   * True while this book is in SELECT MODE — blocks outlined, click to select,
   * Delete to cut, Enter to fix a word.
   *
   * ON THE TAB AND NOT ON UiService, and that is not a stylistic preference:
   * five panes can each show a different book, and a global flag would turn the
   * mode on in all of them at once. It is the same reason `layerView` lives
   * here. It is also not persisted anywhere — the mode is a thing you are doing
   * right now, and a book that reopened outlined would be a book that looked
   * broken until you found the button that was already on.
   */
  selectMode: boolean;
  /**
   * Bumped on every flush that reached disk.
   *
   * It is what makes the rendered pane refresh: the chapter's URL does not
   * change when its bytes do, and an <iframe> pointed at a URL it is already
   * showing does nothing at all. This rides along as a query parameter the
   * protocol handler ignores. Cross-pane for free, now that the editor is its
   * own tab: the bytes land, the source tab's revision moves, and every pane
   * rendering that book reloads.
   */
  revision: number;
  /** Why this tab has nothing in it, when that happens. Never swallowed. */
  problem: string | null;
}

/**
 * A column of the workspace: one document, or none.
 *
 * `tabId` of null means this pane is showing HOME — which is what a column with
 * nothing in it has always shown, back when there was only ever one. It is also
 * what Ctrl+\ makes: an empty column to drop a document into.
 */
export interface Pane {
  id: string;
  /** The document on screen here. An id into the flat tab list, or Home. */
  tabId: string | null;
  /**
   * The pane's share of the row, as a flex-grow number.
   *
   * In memory only, and deliberately: a layout is a thing you arrange for the
   * comparison you are doing right now, and restoring last week's column widths
   * over this week's two books would be furniture arriving in the wrong room.
   */
  flex: number;
}

/**
 * Five, and the number is a judgement rather than a limit of the code.
 *
 * A sixth column on a 1920-wide window is 300 pixels of book, which is a column
 * of hyphens. The cap is also what makes the auto-open rule terminate: past it,
 * a finished job takes the RIGHTMOST column's slot instead of narrowing
 * everything — and the book that was there is still open in the list, one click
 * from coming back.
 */
export const MAX_PANES = 5;

/**
 * The job kinds that become a tab when they finish.
 *
 * A set rather than a chain of comparisons because the list has grown twice
 * now, and each time the test lived inline it was one `||` away from a kind
 * that finishes and is never seen. What is NOT here is deliberate: `txt` has no
 * tab to open into, and `env-install` made no document at all.
 */
const OPENS_ITSELF: ReadonlySet<JobKind> = new Set<JobKind>(['epub', 'pdf', 'translate']);

/** What a rendered chapter reported being clicked, for the editor to jump to. */
export interface SourceJump {
  /** The EPUB tab the click came from. Its editor, if any, is the one that moves. */
  tabId: string;
  bf: boolean;
  tag: string;
  index: number;
  /**
   * Bumped per click, and it is what makes a SECOND click on the same block do
   * anything at all: the payload would otherwise be identical, the signal would
   * not change, and the editor's effect would never run.
   */
  seq: number;
}

/**
 * The block one frame says is selected.
 *
 * IT IS NOT A FACT ABOUT THE BOOK. A selection lives in the frame's DOM and dies
 * with the frame; nothing on disk records it, and a reload starts with nothing
 * selected. It is held here only because the inspector — which is in the shell,
 * not in the pane — has no other way to learn what the user clicked.
 */
export interface SelectedBlock {
  blockId: string;
  /** Its `data-bf-cat`, so the inspector can show which row it already is. */
  category: string | null;
}

/** How many blocks of each category the rendered chapter holds, and how many are struck. */
export interface CategoryCounts {
  counts: Readonly<Record<string, number>>;
  struck: Readonly<Record<string, number>>;
}

/** Something the shell wants said to one tab's frame. See `frameCommand`. */
export interface FrameCommand {
  tabId: string;
  /** Bumped per command, so the same one twice in a row still fires. */
  seq: number;
  message: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly queue = inject(QueueService);

  private readonly all = signal<Tab[]>([]);
  private readonly columns = signal<Pane[]>([]);
  private readonly focused = signal<string | null>(null);

  /**
   * Every open document, in the order the list shows them.
   *
   * THE ORDER IS THIS LIST'S, now that the strips are gone: there is nowhere
   * else a document sits in a sequence, so `reorder` writes here and the panel
   * renders it straight.
   */
  readonly tabs = this.all.asReadonly();
  readonly panes = this.columns.asReadonly();
  readonly focusedPaneId = this.focused.asReadonly();

  readonly focusedPane = computed<Pane | null>(() =>
    this.columns().find((pane) => pane.id === this.focused()) ?? null);

  /** Null means Home — which is also what "no panes open at all" looks like. */
  readonly activeId = computed<string | null>(() => this.focusedPane()?.tabId ?? null);
  readonly active = computed<Tab | null>(() => this.byId(this.activeId()));

  /**
   * The DOCUMENT the user is working on, which is not always the active tab.
   *
   * An editor tab is a face of its book, so with the editor pane focused the
   * rail's Translate, the OCR dialog's source and Ctrl+S must all still mean
   * the book. Everything that acts on "what I am looking at" reads this;
   * `active()` stays literal, for the things that mean the tab itself.
   */
  readonly activeDocument = computed<Tab | null>(() => {
    const tab = this.active();
    if (tab === null) return null;
    return tab.kind === 'editor' ? this.byId(tab.sourceTabId) : tab;
  });

  readonly canSplit = computed(() => this.columns().length < MAX_PANES);

  /**
   * The last thing that went wrong out here rather than inside a tab: a drop
   * this app will not open, a save that failed. Shown as a strip under the tabs
   * and dismissed by hand — a refusal that vanished on a timer is a refusal the
   * user gets to wonder about.
   */
  readonly notice = signal<string | null>(null);

  /** The tab whose chapter is being written right now, for the "Writing…" line. */
  readonly writingTo = signal<string | null>(null);

  /**
   * True from the moment a row leaves the document list until the drag ends.
   *
   * IT EXISTS BECAUSE OF THE <iframe>. A rendered chapter is a frame with its
   * own browsing context, and a drag over it delivers dragover/drop to THAT
   * document — the pane underneath would never see the pointer, so a book could
   * not be dropped onto the one thing a person aims at. The workspace lays a
   * transparent shield over every pane while this is on, and takes it away the
   * instant the drag is over so nothing normal is intercepted.
   *
   * Whether a drag is happening, and NOT what it carries: the id is unreadable
   * until the drop (that is the platform's rule, not ours), so the drop preview
   * is still driven by the pointer's position alone.
   */
  readonly draggingDocument = signal(false);

  /** The most recent click-to-source, for whichever editor is watching that book. */
  readonly sourceJump = signal<SourceJump | null>(null);
  private jumpSeq = 0;

  /**
   * Paths that will arrive as UNSAVED tabs: a conversion's output, or a
   * workspace book re-opened from Home.
   *
   * A set consulted on the way in, rather than a flag on the open call, because
   * the open call and the tab's creation are on opposite sides of an IPC round
   * trip through main.
   */
  private readonly expectUnsaved = new Set<string>();

  /** Paths that will arrive wanting a pane of their own. Same round trip, same trick. */
  private readonly expectOwnPane = new Set<string>();

  /** Conversions already turned into a tab, so a queue push cannot open a second. */
  private readonly openedJobs = new Set<string>();

  /**
   * An open editor's "write what is in the box, now".
   *
   * Registered by the editor component, because the draft lives in its textarea
   * and nothing out here can see it. `close()` awaits it before it asks the user
   * anything: the debounce is 700 ms, and closing a tab inside that window used
   * to throw away the last sentence typed AND ask a question about a `modified`
   * flag that had not been set yet.
   */
  private readonly pendingFlush = new Map<string, () => Promise<void>>();

  private sequence = 0;
  private paneSequence = 0;

  constructor() {
    api?.onDocumentOpened((absolutePath) => { this.adopt(absolutePath); });

    /**
     * A finished conversion opens itself.
     *
     * Watching the queue MIRROR rather than being told by whatever enqueued the
     * job: the job outlives the dialog that started it, outlives a trip to
     * Settings, and (because main owns the queue) outlives a reload of this
     * window. The only fact that matters is that a row reached `done`.
     *
     * EPUB and PDF both, because both have a tab to open into and looking at
     * the result is the next thing anybody does — for a searchable PDF it is
     * the ONLY way to see that anything happened at all. txt stays shelf-only:
     * there is no text tab, and the OS opens it from reveal.
     *
     * A TRANSLATION IS THE THIRD, and it is the one this matters most for: it
     * runs for hours, so the person who ordered it is not watching, and the
     * book appearing in a tab is how they find out it finished at all.
     *
     * IN A PANE OF ITS OWN, which is what the panes are for: the translation
     * arrives beside the book it was made from, and the two are readable
     * against each other without a single gesture from the user.
     *
     * Jobs already finished when this window loaded are marked as seen without
     * opening: a reload should not reopen five books somebody closed.
     */
    let first = true;
    effect(() => {
      const jobs = this.queue.jobs();
      for (const job of jobs) {
        if (!OPENS_ITSELF.has(job.kind) || job.state !== 'done') continue;
        if (this.openedJobs.has(job.id)) continue;
        this.openedJobs.add(job.id);
        if (first) continue;
        this.openFinished(job.outputPath);
      }
      if (jobs.length > 0) first = false;
    });
  }

  // ── Opening ──────────────────────────────────────────────────────────────

  /** The rail's and Home's Open button. The tab arrives on `document:opened`. */
  async openViaDialog(): Promise<void> {
    await api?.openDocumentDialog();
  }

  /**
   * A drop. Main decides whether the path is openable; a refusal is SAID rather
   * than ignored, because a file that lands in the window and does nothing is
   * indistinguishable from a broken app.
   */
  async openDropped(file: File): Promise<void> {
    if (!api) return;
    const candidate = api.pathForFile(file);
    if (!candidate) return;
    const admitted = await api.openPath(candidate);
    if (admitted === null) {
      this.notice.set(`${file.name} is not something Foundry opens — it reads PDFs and the EPUBs it casts.`);
    }
  }

  /** Open a path this window already knows about: Home's list, the shelf's Open. */
  async openFile(filePath: string, managed = false): Promise<void> {
    if (!api) return;
    const key = normalise(filePath);
    if (managed) this.expectUnsaved.add(key);
    const admitted = await api.openPath(filePath);
    if (admitted === null) {
      this.expectUnsaved.delete(key);
      this.expectOwnPane.delete(key);
      this.notice.set(`${filePath} is no longer there.`);
    }
  }

  /** A conversion's output: unsaved, and in a pane of its own if there is room. */
  private openFinished(filePath: string): void {
    this.expectOwnPane.add(normalise(filePath));
    void this.openFile(filePath, true);
  }

  /**
   * The single tab factory. Focuses an existing tab for the same file rather
   * than opening a second — two tabs onto one book are two scroll positions
   * fighting over one document, and with panes it would be two of them fighting
   * over one unpack.
   */
  private adopt(absolutePath: string): void {
    const key = normalise(absolutePath);
    const ownPane = this.expectOwnPane.delete(key);
    const existing = this.all().find((tab) => normalise(tab.path) === key && tab.kind !== 'editor');
    if (existing) {
      this.reveal(existing.id);
      return;
    }

    const kind: TabKind = key.endsWith('.epub') ? 'epub' : 'pdf';
    const unsaved = this.expectUnsaved.delete(key);
    const tab = this.blankTab(kind, absolutePath, baseName(absolutePath));
    tab.unsaved = unsaved;
    this.all.update((tabs) => [...tabs, tab]);
    this.place(tab.id, ownPane);
    if (kind === 'epub') void this.unpack(tab.id, absolutePath);
  }

  private blankTab(kind: TabKind, path: string, title: string): Tab {
    this.sequence += 1;
    return {
      id: `tab-${this.sequence}`,
      kind,
      path,
      title,
      unsaved: false,
      modified: false,
      savedPath: null,
      book: null,
      chapterHref: null,
      sourceTabId: null,
      layerView: false,
      thumbnails: true,
      selectMode: false,
      revision: 0,
      problem: null,
    };
  }

  /**
   * Ask main to unpack the book, and put the failure IN THE TAB when it will not.
   *
   * A book that cannot be read is a fact about that book: it belongs on its own
   * tab with the reason on it, not in a toast that outlives the tab or a console
   * line nobody sees.
   */
  private async unpack(id: string, filePath: string): Promise<void> {
    if (!api) return;
    try {
      const book = await api.epub.open(filePath);
      this.patch(id, {
        book,
        title: book.title,
        chapterHref: book.chapters[0]?.href ?? null,
        // A book from the user's own disk already IS a copy somewhere they
        // chose, so Save has a destination from the start: the file itself.
        // Main measured `managed` and granted that path; edits never touch it
        // until Save is pressed (electron/epub-reader.ts writes through to a
        // workspace copy instead).
        ...(book.managed ? {} : { savedPath: filePath }),
        problem: book.chapters.length > 0 ? null : 'This book has no chapters in its spine.',
      });
      // Not a `problem` — the book is open and readable. It is something the app
      // could not do BESIDE opening it (today: stamp an imported EPUB), and the
      // strip is where a shut door says so on the way in rather than by doing
      // nothing when somebody presses Select.
      if (book.notice !== null) this.notice.set(book.notice);
    } catch (err) {
      this.patch(id, { problem: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Panes ────────────────────────────────────────────────────────────────

  byId(id: string | null): Tab | null {
    if (id === null) return null;
    return this.all().find((tab) => tab.id === id) ?? null;
  }

  /** The column showing this document, if any is. At most one, by construction. */
  paneOf(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.tabId === tabId) ?? null;
  }

  /**
   * Clicking anywhere in a pane focuses it — that is the whole focus model, and
   * it is why nothing else in the app has to ask which pane it is in.
   */
  focusPane(paneId: string): void {
    if (this.focused() === paneId) return;
    if (this.columns().some((pane) => pane.id === paneId)) this.focused.set(paneId);
  }

  /** Ctrl+1…5. Out of range is a no-op rather than a clamp — 4 means the fourth. */
  focusPaneAt(index: number): void {
    const pane = this.columns()[index];
    if (pane) this.focused.set(pane.id);
  }

  /**
   * Put a newly opened tab in a pane and give it the focus.
   *
   * The first document makes the first pane. After that: a finished job asks
   * for one of its own (up to the cap, past which it takes the rightmost pane's
   * slot), and everything else — a drop, Home's list, the shelf's Open — lands
   * in the pane the user is working in, because they aimed at it.
   *
   * LANDING IN THE FOCUSED PANE NOW REPLACES what that pane was showing, since
   * a pane holds one document. Nothing is lost: the displaced document stays
   * open in the list with its unpack, its edits and its dot, one click from
   * being back on screen. What it is NOT allowed to do is displace a book with
   * a translation of it — that is why a finished job still asks for a column of
   * its own, and why the two rules read differently.
   *
   * `beside` names a pane the new one must open DIRECTLY to the right of, which
   * is what an HTML editor asks for: it is a face of one particular book, and a
   * column of source three panes away from the page it belongs to helps nobody.
   * A conversion's output passes nothing and lands on the end.
   */
  private place(tabId: string, ownPane: boolean, beside: string | null = null): void {
    const panes = this.columns();
    if (panes.length === 0) {
      const pane = this.makePane(tabId);
      this.columns.set([pane]);
      this.focused.set(pane.id);
      return;
    }
    if (ownPane && panes.length < MAX_PANES) {
      const pane = this.makePane(tabId);
      const at = beside === null ? -1 : panes.findIndex((candidate) => candidate.id === beside);
      const next = at < 0
        ? [...panes, pane]
        : [...panes.slice(0, at + 1), pane, ...panes.slice(at + 1)];
      this.columns.set(equalise(next));
      this.focused.set(pane.id);
      return;
    }
    const target = ownPane
      ? crowdedTarget(panes, beside)
      : (this.focusedPane() ?? panes[panes.length - 1]!);
    this.columns.set(panes.map((pane) => (pane.id === target.id ? { ...pane, tabId } : pane)));
    this.focused.set(target.id);
  }

  private makePane(tabId: string | null): Pane {
    this.paneSequence += 1;
    return { id: `pane-${this.paneSequence}`, tabId, flex: 1 };
  }

  /**
   * Put a document in front of the user — a click on its row in the list.
   *
   * ON SCREEN ALREADY: only the focus moves. A second viewer over one unpack is
   * two scroll positions fighting over one document — the thing `adopt` refuses
   * to make for two files — and (because `chapterHref` lives on the tab) two
   * columns that appear scroll-locked with nothing on screen saying why.
   *
   * NOT ON SCREEN: it lands in the focused pane, replacing what was there. The
   * displaced document stays in the list — nothing about it is thrown away.
   */
  reveal(tabId: string): void {
    if (this.byId(tabId) === null) return;
    const pane = this.paneOf(tabId);
    if (pane) {
      this.focused.set(pane.id);
      return;
    }
    this.place(tabId, false);
  }

  /**
   * Show a document in a named column — a row dropped on a pane's middle.
   *
   * THE COLUMN IT CAME FROM GOES WITH IT, when it had one: a document is in at
   * most one pane, so the source is left empty by the move, and an empty column
   * nobody asked for is furniture in the way of the two the user is comparing.
   * (An empty column somebody DID ask for — Ctrl+\ — is a different thing and
   * stays until it is filled or closed.)
   */
  show(tabId: string, paneId: string): void {
    const panes = this.columns();
    if (this.byId(tabId) === null || !panes.some((pane) => pane.id === paneId)) return;
    const from = panes.find((pane) => pane.tabId === tabId) ?? null;
    if (from !== null && from.id === paneId) {
      this.focused.set(paneId);
      return;
    }
    this.columns.set(panes
      .map((pane) => (pane.id === paneId ? { ...pane, tabId } : pane))
      .filter((pane) => from === null || pane.id !== from.id));
    this.focused.set(paneId);
  }

  /**
   * Insert a column at `atIndex` showing this document — a row dropped on the
   * left or right edge band of a pane.
   *
   * THE CAP IS SAID BY NAME. The drop preview does not light up an edge band
   * once there are five columns (a target that lights and then does nothing is
   * worse than one that visibly will not take it), so this is only reachable by
   * a drop the preview never promised — and a gesture that lands on nothing has
   * to say why. Refused even when the document is already in a column and the
   * move would be net-zero: the preview cannot offer that without knowing what
   * the drag carries, and an operation that works only when you cannot see that
   * it will is not an operation.
   */
  openInNewPane(tabId: string, atIndex: number): void {
    const panes = this.columns();
    if (this.byId(tabId) === null) return;
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const from = panes.find((pane) => pane.tabId === tabId) ?? null;
    const fresh = this.makePane(tabId);
    const at = Math.max(0, Math.min(atIndex, panes.length));
    this.columns.set(equalise([...panes.slice(0, at), fresh, ...panes.slice(at)]
      .filter((pane) => from === null || pane.id !== from.id)));
    this.focused.set(fresh.id);
  }

  /**
   * Ctrl+\ and View → Split right: an EMPTY column beside the focused one.
   *
   * It used to move the active tab out of a stack, which is an operation that
   * no longer exists — a pane holds one document, so there is nothing to move
   * out of it. What the chord means now is "make me somewhere to put something",
   * and the user fills it by clicking a row in the list, dragging one onto it,
   * or opening a book from the Home page it shows until they do.
   *
   * ALL THREE REFUSALS ARE SAID. This is reachable from a menu item and a
   * keyboard chord, neither of which can grey itself out against renderer
   * state, so the ways it cannot happen have to arrive as sentences — a Ctrl+\
   * that silently does nothing is indistinguishable from a Ctrl+\ that is broken.
   */
  newEmptyPane(): void {
    const panes = this.columns();
    if (panes.length === 0) {
      this.notice.set('There is nothing open to put a column beside — open a document first.');
      return;
    }
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const at = panes.findIndex((pane) => pane.id === this.focused());
    if (at >= 0 && panes[at]!.tabId === null) {
      this.notice.set('This column is already empty — put a document in it before making another.');
      return;
    }
    const fresh = this.makePane(null);
    const index = at < 0 ? panes.length : at + 1;
    this.columns.set(equalise([...panes.slice(0, index), fresh, ...panes.slice(index)]));
    this.focused.set(fresh.id);
  }

  /**
   * Take a column away without closing what is in it.
   *
   * The ✕ on an empty column's Home page, which is the only way an empty one
   * can go: a column with a document in it is closed by closing the document
   * (see `dropFromPanes`), and there is deliberately no gesture that puts a book
   * away and leaves a hole where it was.
   */
  closePane(paneId: string): void {
    const panes = this.columns();
    const at = panes.findIndex((pane) => pane.id === paneId);
    if (at < 0) return;
    const kept = panes.filter((pane) => pane.id !== paneId);
    // Not equalised, for the reason `dropFromPanes` gives: the survivors keep
    // the shares the user dragged and flex reflows them across the width.
    this.columns.set(kept);
    if (this.focused() === paneId) {
      this.focused.set(kept[Math.min(at, kept.length - 1)]?.id ?? null);
    }
  }

  /**
   * Move a document in the list — a row dragged onto another row.
   *
   * `beforeTabId` names the document it lands in front of; null means the end.
   * This is the ONLY place a document's order is decided now that the strips
   * are gone, which is why it writes the flat list rather than any pane.
   */
  reorder(tabId: string, beforeTabId: string | null): void {
    if (tabId === beforeTabId) return;
    const tabs = this.all();
    const moving = tabs.find((tab) => tab.id === tabId);
    if (!moving) return;
    const without = tabs.filter((tab) => tab.id !== tabId);
    const at = beforeTabId === null ? -1 : without.findIndex((tab) => tab.id === beforeTabId);
    const index = at < 0 ? without.length : at;
    this.all.set([...without.slice(0, index), moving, ...without.slice(index)]);
  }

  /**
   * A divider drag. Two neighbours, one number moved between them.
   *
   * Only the pair either side of the divider changes, so the rest of the row
   * does not twitch while a divider is dragged — the caller does the pixel
   * arithmetic against the real widths and hands back the two shares.
   */
  resize(leftPaneId: string, leftFlex: number, rightPaneId: string, rightFlex: number): void {
    this.columns.update((panes) => panes.map((pane) => {
      if (pane.id === leftPaneId) return { ...pane, flex: Math.max(0.05, leftFlex) };
      if (pane.id === rightPaneId) return { ...pane, flex: Math.max(0.05, rightFlex) };
      return pane;
    }));
  }

  // ── Living with them ─────────────────────────────────────────────────────

  /** The rail's Home. Home is "this column has nothing in it", not a document. */
  goHome(): void {
    const pane = this.focusedPane();
    if (!pane) return;
    this.columns.update((panes) => panes.map((candidate) =>
      (candidate.id === pane.id ? { ...candidate, tabId: null } : candidate)));
  }

  showChapter(id: string, href: string): void {
    this.patch(id, { chapterHref: href });
  }

  /**
   * Ctrl/Cmd+Tab. Walks the FOCUSED column through the list, wrapping.
   *
   * DOCUMENTS ALREADY IN ANOTHER COLUMN ARE SKIPPED, because putting one there
   * would take it off the screen it is currently on — the cycle would swap two
   * columns' contents rather than advance one. The walk always terminates: at
   * worst every other document is taken and it arrives back at this column's
   * own, which is a no-op nobody notices.
   */
  nextTab(): void {
    const pane = this.focusedPane();
    const tabs = this.all();
    if (!pane || tabs.length === 0) return;
    const taken = new Set(this.columns()
      .filter((candidate) => candidate.id !== pane.id)
      .map((candidate) => candidate.tabId)
      .filter((id): id is string => id !== null));
    const at = pane.tabId === null ? -1 : tabs.findIndex((tab) => tab.id === pane.tabId);
    for (let step = 1; step <= tabs.length; step += 1) {
      const candidate = tabs[(at + step) % tabs.length];
      if (candidate === undefined || taken.has(candidate.id)) continue;
      this.show(candidate.id, pane.id);
      return;
    }
  }

  /**
   * Close a tab, warning first when it is the only copy anywhere the user chose.
   *
   * The warning is main's native box (it is modal to the window, and every other
   * dialog in this app is main's). The book is NOT deleted either way — see
   * electron/workspace.ts — so the question is only whether they meant to stop
   * tracking it.
   *
   * A PENDING EDIT IS FLUSHED FIRST, before the question is asked. The editor
   * writes 700 ms after the last keystroke, and a close inside that window used
   * to lose the sentence being typed and then ask about a `modified` flag that
   * had not been set yet — the dialog would say the book was untouched while
   * the last edit evaporated.
   *
   * CLOSING A BOOK CLOSES ITS EDITOR. They are one document with two faces, and
   * an editor pane left holding a book that is no longer open is a pane with
   * nothing it can do.
   */
  async close(id: string): Promise<void> {
    const doomed = this.all().find((candidate) => candidate.id === id);
    if (!doomed) return;

    const editor = doomed.kind === 'epub' ? this.editorFor(doomed.id) : null;
    await this.flushPending(doomed.kind === 'editor' ? doomed.id : editor?.id ?? null);

    // Re-read: the flush may have set `modified`, which is the whole reason the
    // question is asked after it rather than before.
    const current = this.all().find((candidate) => candidate.id === id);
    if (!current) return;
    if ((current.unsaved || current.modified) && api) {
      const go = await api.confirmClose({
        title: current.title,
        unsaved: current.unsaved,
        modified: current.modified,
        savedPath: current.savedPath,
      });
      if (!go) return;
    }

    // The list is re-read AFTER the dialog: that box is modal to the window but
    // not to the app, and a conversion can finish and open a tab while it is up.
    const going = new Set<string>([id]);
    if (editor) going.add(editor.id);
    const tabs = this.all();
    if (!tabs.some((candidate) => candidate.id === id)) return;

    // The temp directory the chapters were served from goes with the tab. Not
    // awaited: the tab must close now, and a %TEMP% removal that loses a race
    // with the iframe's last read is retried on quit.
    if (current.book && api) void api.epub.close(current.book.id);

    this.all.set(tabs.filter((candidate) => !going.has(candidate.id)));
    for (const gone of going) {
      this.pendingFlush.delete(gone);
      // The selection and the category tally are the frame's, and the frame is
      // going with the tab. Left behind they would be the inspector's answer for
      // whatever tab id gets reused next.
      this.forgetFrameState(gone);
    }
    this.dropFromPanes(going);
  }

  /**
   * CLOSING A DOCUMENT CLOSES THE COLUMN IT WAS IN, and the survivors reflow.
   *
   * A pane holds one document, so there is nothing for the column to fall back
   * to — and leaving an empty one behind would mean closing four books left four
   * Home pages side by side, which is a workspace nobody arranged. Closing the
   * last document takes the last column with it and the window is Home again,
   * exactly as it was before any of this.
   *
   * The focus lands on the column that took the closed one's place, which is
   * the browser's rule for tabs one level up.
   */
  private dropFromPanes(going: ReadonlySet<string>): void {
    const panes = this.columns();
    const kept: Pane[] = [];
    let focusAt = -1;
    for (const pane of panes) {
      if (pane.tabId !== null && going.has(pane.tabId)) {
        if (pane.id === this.focused()) focusAt = kept.length;
        continue;
      }
      kept.push(pane);
    }
    // Not equalised: the panes that remain keep their shares and flex reflows
    // them across the width, which is what the user arranged. Only ADDING a
    // pane resets to equal, because a new column has no share to keep.
    this.columns.set(kept);
    if (focusAt >= 0) {
      this.focused.set(kept[Math.min(focusAt, kept.length - 1)]?.id ?? null);
    }
  }

  async closeActive(): Promise<void> {
    const tab = this.active();
    if (tab) await this.close(tab.id);
  }

  // ── The HTML editor ──────────────────────────────────────────────────────

  /** The editor tab pointed at this book, if one is open. */
  editorFor(bookTabId: string): Tab | null {
    return this.all().find((tab) => tab.kind === 'editor' && tab.sourceTabId === bookTabId) ?? null;
  }

  /**
   * "Edit HTML" — opens the editor beside the book, or closes it.
   *
   * ONE EDITOR PER BOOK, and it goes in a pane of its own by the same rule a
   * finished conversion does: the point of editing a chapter is watching the
   * rendered page change as you fix it, which is a thing you cannot do if the
   * editor is in the column the book was in. At the cap it takes the slot of the
   * column NEXT TO the book (see `crowdedTarget`) — whatever was there stays
   * open in the list, and the two faces of the one document the user just asked
   * to edit are on screen beside each other, which is the whole promise.
   */
  async toggleEditor(bookTabId: string): Promise<void> {
    const book = this.byId(bookTabId);
    if (!book || book.kind !== 'epub' || book.book === null) return;
    const open = this.editorFor(bookTabId);
    if (open) {
      await this.close(open.id);
      return;
    }
    const tab = this.blankTab('editor', book.path, `${book.title} — HTML`);
    tab.sourceTabId = bookTabId;
    this.all.update((tabs) => [...tabs, tab]);
    this.place(tab.id, true, this.paneOf(bookTabId)?.id ?? null);
  }

  /**
   * A click in the rendered chapter, on its way to the editor's textarea.
   *
   * Through the service because the two are in different panes now — the same
   * Calibre gesture, one component further apart. The editor decides whether the
   * jump is for it (it names its own source tab) and does the counting.
   */
  reportSourceClick(tabId: string, bf: boolean, tag: string, index: number): void {
    const editor = this.editorFor(tabId);
    if (!editor) return;
    this.jumpSeq += 1;
    this.sourceJump.set({ tabId, bf, tag, index, seq: this.jumpSeq });
    /**
     * The jump is no use in a column nobody can see.
     *
     * ON SCREEN IS ENOUGH — the caret has already moved and the focus stays
     * with the book, because the hand that clicked a paragraph is reading the
     * page, not the source. `reveal` is deliberately NOT used: it would put the
     * editor in the FOCUSED pane, which is the book's, and swap the page the
     * user just clicked in for its own markup.
     *
     * Off screen, it comes back beside the book. At the cap that is refused by
     * name inside `openInNewPane` rather than silently doing nothing, which is
     * the one thing a click-to-source must never do.
     */
    if (this.paneOf(editor.id) !== null) return;
    const at = this.columns().findIndex((pane) => pane.tabId === tabId);
    this.openInNewPane(editor.id, at + 1);
  }

  /**
   * The editor lends the service its "write the box now".
   *
   * Registered while the component is alive and dropped on destroy, so `close()`
   * can make the draft real before it asks a question about it.
   */
  registerFlush(editorTabId: string, flush: () => Promise<void>): void {
    this.pendingFlush.set(editorTabId, flush);
  }

  unregisterFlush(editorTabId: string): void {
    this.pendingFlush.delete(editorTabId);
  }

  private async flushPending(editorTabId: string | null): Promise<void> {
    if (editorTabId === null) return;
    const flush = this.pendingFlush.get(editorTabId);
    if (flush) await flush();
  }

  // ── The PDF viewer's two view modes ──────────────────────────────────────

  toggleLayerView(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, layerView: !tab.layerView } : tab)));
  }

  toggleThumbnails(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, thumbnails: !tab.thumbnails } : tab)));
  }

  // ── Select mode ──────────────────────────────────────────────────────────

  /**
   * ONE WRITE IN FLIGHT PER MEMBER, and every write of a chapter goes through
   * it: an editor flush, a cut, an un-cut, an edited paragraph.
   *
   * Each of them is a read-modify-write of one file in the working tree. Two
   * that overlap both read the SAME text and the second one's write erases the
   * first one's change — and select mode is a gesture stream, so two cuts a
   * quarter of a second apart is the normal case rather than a race somebody
   * has to contrive. Serialised per member rather than globally, because two
   * chapters are two files and there is nothing for them to fight over.
   *
   * A failed write does not poison the chain: the next one runs regardless, and
   * its caller hears about its own failure.
   */
  private readonly memberWrites = new Map<string, Promise<unknown>>();

  private queueMemberWrite<T>(bookId: string, member: string, work: () => Promise<T>): Promise<T> {
    const key = `${bookId} :: ${member}`;
    const previous = this.memberWrites.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The tail is dropped once nothing is behind it, so a long session does not
    // accumulate one settled promise per chapter it ever touched.
    const settled = next.then(() => { /* kept */ }, () => { /* kept */ }).then(() => {
      if (this.memberWrites.get(key) === settled) this.memberWrites.delete(key);
    });
    this.memberWrites.set(key, settled);
    return next;
  }

  /**
   * The rail's Select toggle.
   *
   * TURNING IT ON STAMPS A BOOK THAT HAS NOT BEEN. Select mode outlines
   * `data-bf-cat` and records a cut against `data-bf-id`, and a book carrying
   * neither — one cast before ids existed, or a publisher's EPUB imported by a
   * build that could not stamp it — has nothing this mode can address. Main
   * decides whether a stamping run is worth making and then spawns
   * `foundry epub-stamp` on the working tree, which is the ONE implementation
   * of the scheme; this side only says so in the log and reloads the rendered
   * pane — the single revision bump select mode makes, because the frame is
   * showing markup that has just gained attributes on every block and no
   * gesture in the mode would work against it.
   *
   * The mode is turned on AFTER the stamping lands, so the first click already
   * has a name to report.
   */
  async toggleSelectMode(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!tab || tab.kind !== 'epub' || tab.book === null) return;
    if (tab.selectMode) {
      this.patch(id, { selectMode: false });
      // The frame drops its selection and stops counting when the mode closes,
      // so the inspector must stop showing last minute's numbers as this
      // minute's truth.
      this.forgetFrameState(id);
      return;
    }
    if (api) {
      // The spine, in reading order, without the #fragment rows: those name a
      // heading inside a document that is already in the list.
      const members = [...new Set(tab.book.chapters.map((chapter) => memberOf(chapter.href)))];
      try {
        const stamped = await api.epub.stamp(tab.book.id, members);
        if (stamped.minted > 0) {
          console.log(
            `[select] ${tab.title} carried no block ids: the engine stamped `
            + `${stamped.minted} elements across ${stamped.documents} documents.`,
          );
          const current = this.byId(id);
          this.patch(id, { modified: true, revision: (current?.revision ?? tab.revision) + 1 });
        }
      } catch (err) {
        this.notice.set(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.patch(id, { selectMode: true });
  }

  /**
   * Mark or unmark a block, by the name the frame reported.
   *
   * NO REVISION BUMP on success, and that is the point of the whole shape: the
   * frame painted the mark before this was called, and reloading the iframe
   * would throw the reader back to the top of the chapter to show them
   * something already on screen.
   *
   * ON A REFUSAL IT BUMPS. The frame is then showing a mark the file does not
   * carry, and the only honest fix is to reload it and let the book repaint
   * itself — which works because the cut lives in the document rather than in
   * anything the frame remembers.
   */
  async setBlockCut(id: string, blockId: string, cut: boolean): Promise<void> {
    await this.blockEdit(id, (bridge, book, member) =>
      bridge.epub.setCut(book, member, blockId, cut));
  }

  /**
   * An edited block: optimistic and repainted on a refusal, like the cut — and
   * then the ONE question this mode has to ask out loud.
   *
   * `was` is the block's markup as it stood before the edit, handed over by the
   * frame. It is carried this far for exactly one purpose: the third answer to
   * the footnote question is "put the number back", and nothing else in the app
   * is holding the text that had it. Main wrote the new words over the old ones
   * and the old ones are gone from disk.
   *
   * THE WRITE HAPPENS FIRST AND THE QUESTION SECOND, which is deliberate and is
   * the whole feel of select mode: what you typed lands the instant you stop
   * typing. A dialog that interrupted the edit to ask permission would put a
   * modal between a person and their own sentence. Cancel undoes.
   */
  async setBlockHtml(id: string, blockId: string, html: string, was: string): Promise<void> {
    const unlinked = await this.blockEdit(id, (bridge, book, member) =>
      bridge.epub.setBlockHtml(book, member, blockId, html));
    if (!unlinked || unlinked.length === 0) return;
    await this.askAboutUnlinkedNotes(id, blockId, was, unlinked);
  }

  /**
   * "You deleted this footnote's last reference — should the footnote go too?"
   *
   * MAIN ASKS IT (a native box, modal to the window, like every other dialog in
   * this app) and main also answers it without asking when the user has said
   * "don't ask again": the standing answer is stored per ANSWER in
   * app-settings.json, so "always strike it" and "always leave it" stay two
   * different instructions.
   *
   * One edit can orphan more than one note — a paragraph carrying two reference
   * numbers, both deleted in one pass — so this walks them. A CANCEL STOPS THE
   * WALK: it restores the block to the markup that had every one of those
   * numbers in it, so there is nothing left to ask about, and asking anyway
   * would be asking about a note that is reachable again.
   */
  private async askAboutUnlinkedNotes(
    id: string,
    blockId: string,
    was: string,
    notes: readonly UnlinkedNote[],
  ): Promise<void> {
    const bridge = api;
    if (!bridge) return;
    for (const note of notes) {
      const answer = await bridge.confirmUnlinkedNote(note);
      if (answer === 'cancel') {
        await this.restoreBlockHtml(id, blockId, was);
        return;
      }
      if (answer === 'keep') continue;
      const done = await this.blockEdit(id, (b, book, member) =>
        b.epub.setNoteCut(book, member, note.noteId, true));
      // PAINTED AFTER THE WRITE, and only when the write landed — the opposite
      // of every other mark in this mode. A cut the user pressed Delete for is
      // painted first because the hand is already moving; this one was decided
      // in a dialog that has just closed, there is no gesture to keep up with,
      // and painting a strike over a footnote main then refused to mark would
      // be a lie with nothing on screen to correct it.
      if (done !== null) this.commandFrame(id, { type: 'foundry:mark-note', noteId: note.noteId, cut: true });
    }
  }

  /**
   * The "put the number back" answer: the block's previous markup, written back.
   *
   * A SEPARATE MAIN CALL, because the ordinary edit door forbids markup being
   * gained and a restored reference number is a `<sup>` and an anchor
   * reappearing — see `restoreBlockHtml` in electron/epub-reader.ts for the
   * mirror check it makes instead.
   *
   * IT BUMPS THE REVISION, which no other select-mode write does. The frame is
   * showing the sentence WITHOUT the number, because that is what the user
   * typed; there is no attribute to flip that would put it back, so the honest
   * repaint is to reload the chapter from the file that now has it. The cost is
   * the reader landing at the top of the chapter, which is the price of an undo.
   */
  private async restoreBlockHtml(id: string, blockId: string, html: string): Promise<void> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return;
    /*
     * NOTHING TO PUT BACK IS SAID, NEVER GUESSED AT. The previous markup comes
     * from the frame and is dropped by the message check if it is missing or
     * absurdly long — and an empty string here would be a request to blank the
     * paragraph, which for a block whose words carried no other tags main would
     * accept as a legal word edit. This is the one place that can tell the
     * difference between "restore to nothing" and "we never had it".
     */
    if (html.length === 0) {
      this.notice.set(
        `The reference number cannot be put back into ${blockId}: this app is no longer holding `
        + 'the words that had it. The footnote was left in the book — press Delete on it to strike '
        + 'it, or type the number back into the sentence.',
      );
      return;
    }
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      await this.queueMemberWrite(bookId, member, () =>
        bridge.epub.restoreBlockHtml(bookId, member, blockId, html));
      this.memberChanged(id, member);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
    const current = this.byId(id);
    if (current) this.patch(id, { modified: true, revision: current.revision + 1 });
  }

  /**
   * Relabel one block — the inspector's Category rows, applied to the selection.
   *
   * IT CHANGES THE LABEL AND NOT THE SHAPE: a paragraph relabelled `footnote`
   * stays a `<p>` in the prose and does not move into the footnotes section.
   * That re-shaping is `foundry epub-final`'s and is not in this app.
   *
   * Same optimism as the cut — the frame set the attribute and repainted its own
   * colour off it before this ran — so no revision bump on success, and a bump
   * on a refusal to let the file repaint over the guess.
   */
  async setBlockCategory(id: string, blockId: string, category: string): Promise<void> {
    await this.blockEdit(id, (bridge, book, member) =>
      bridge.epub.setCategory(book, member, blockId, category));
  }

  /**
   * Select-all-by-category: every block of one kind in this chapter, struck or
   * brought back in ONE write, and SAID OUT LOUD.
   *
   * The number comes back from main rather than from the count the frame sent,
   * because they can differ — a block already carrying the mark is not a change
   * — and a gesture that reports what it asked for rather than what it did is a
   * gesture nobody can trust with two hundred paragraphs.
   */
  async cutBlocksByCategory(
    id: string,
    category: string,
    blockIds: readonly string[],
    cut: boolean,
  ): Promise<void> {
    const changed = await this.blockEdit(id, (bridge, book, member) =>
      bridge.epub.setCuts(book, member, [...blockIds], cut));
    if (changed === null) return;
    const kind = categoryLabel(category).toLowerCase();
    const many = changed === 1 ? '' : 's';
    this.notice.set(changed === 0
      ? `Every ${kind} block in this chapter already ${cut ? 'was struck' : 'stood'} — nothing changed.`
      : cut
        ? `Struck ${changed} ${kind} block${many} in this chapter. Press Delete on one to bring it back.`
        : `Brought back ${changed} ${kind} block${many} in this chapter.`);
  }

  /**
   * Every select-mode write, and the one place their optimism is spelled out.
   *
   * Resolves with whatever main answered, or NULL when the write was refused or
   * there was nothing to write to — which is what lets a caller tell "main did
   * this" from "main would not", without a second try/catch at every call site.
   */
  private async blockEdit<T>(
    id: string,
    write: (bridge: FoundryApi, bookId: string, member: string) => Promise<T>,
  ): Promise<T | null> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return null;
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      const answer = await this.queueMemberWrite(bookId, member, () => write(bridge, bookId, member));
      this.patch(id, { modified: true });
      this.memberChanged(id, member);
      return answer;
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      const current = this.byId(id);
      if (current) this.patch(id, { revision: current.revision + 1 });
      return null;
    }
  }

  /** Something the frame itself refused, said where the user can read it. */
  reportSelectRefusal(reason: string): void {
    this.notice.set(reason);
  }

  // ── The inspector, and the frame it cannot reach ─────────────────────────

  /**
   * What the frame in one pane says is selected, and what it says the chapter
   * holds — kept PER TAB.
   *
   * A single pair of signals would have five panes writing over each other: two
   * books can be in select mode at once, and the second one's frame announcing
   * "nothing is selected" as it loads would blank the inspector for the first.
   * The map is small (one entry per book in select mode) and it is dropped with
   * the tab, because both facts die with the frame that reported them.
   */
  private readonly selections = signal<ReadonlyMap<string, SelectedBlock>>(new Map());
  private readonly counts = signal<ReadonlyMap<string, CategoryCounts>>(new Map());

  selectionFor(tabId: string | null): SelectedBlock | null {
    return tabId === null ? null : this.selections().get(tabId) ?? null;
  }

  countsFor(tabId: string | null): CategoryCounts | null {
    return tabId === null ? null : this.counts().get(tabId) ?? null;
  }

  reportSelection(tabId: string, blockId: string | null, category: string | null): void {
    this.selections.update((map) => {
      const next = new Map(map);
      if (blockId === null) next.delete(tabId);
      else next.set(tabId, { blockId, category });
      return next;
    });
  }

  reportCategoryCounts(tabId: string, counts: CategoryCounts): void {
    this.counts.update((map) => new Map(map).set(tabId, counts));
  }

  private forgetFrameState(tabId: string): void {
    this.selections.update((map) => {
      const next = new Map(map);
      next.delete(tabId);
      return next;
    });
    this.counts.update((map) => {
      const next = new Map(map);
      next.delete(tabId);
      return next;
    });
  }

  /**
   * PARENT → FRAME, for the panel that cannot see it.
   *
   * The inspector lives in the shell, one component tree away from the five
   * viewers, and the frame is behind a sandboxed origin that only its own
   * <iframe> element can post into. So a command is a SIGNAL naming the tab it
   * is for, and whichever viewer is rendering that tab picks it up and posts it
   * — the same shape `sourceJump` uses for a click going the other way, down to
   * the sequence number, which is what makes the same command twice in a row do
   * anything at all.
   */
  readonly frameCommand = signal<FrameCommand | null>(null);
  private commandSeq = 0;

  private commandFrame(tabId: string, message: Record<string, unknown>): void {
    this.commandSeq += 1;
    this.frameCommand.set({ tabId, seq: this.commandSeq, message });
  }

  /**
   * The inspector's two gestures, refused BY NAME when the mode is off.
   *
   * The rows are a legend as well as a control — with nothing selected they say
   * how many blocks of each kind this chapter holds — so they are clickable in
   * states where they cannot act, and a click that quietly did nothing would be
   * indistinguishable from a broken panel.
   */
  relabelSelected(category: string): void {
    const tab = this.activeDocument();
    if (!tab || tab.kind !== 'epub' || tab.book === null) return;
    if (!tab.selectMode) {
      this.notice.set('Relabelling a block needs select mode on — press Select, then click the block.');
      return;
    }
    if (this.selectionFor(tab.id) === null) {
      this.notice.set('Click a block in the page first; the category is applied to what is selected.');
      return;
    }
    this.commandFrame(tab.id, { type: 'foundry:relabel', cat: category });
  }

  strikeCategory(category: string): void {
    const tab = this.activeDocument();
    if (!tab || tab.kind !== 'epub' || tab.book === null) return;
    if (!tab.selectMode) {
      this.notice.set('Striking a whole category needs select mode on — press Select first.');
      return;
    }
    this.commandFrame(tab.id, { type: 'foundry:cut-category', cat: category });
  }

  /**
   * A chapter that changed on disk without the HTML editor doing it.
   *
   * THE HAZARD THIS EXISTS FOR IS SILENT AND COSTS WORK. The editor holds a
   * WHOLE chapter in its textarea, loaded when that chapter opened. Cut three
   * blocks in select mode with the editor open on the same chapter, then type
   * one character in the editor: its next flush writes the entire textarea
   * back, which is the text from before the cuts. The marks are gone, nothing
   * says so, and the only evidence is that `epub-final` later finds nothing to
   * remove.
   *
   * A REVISION BUMP CANNOT SAY THIS. That signal reloads the rendered iframe,
   * which is exactly what a cut must not do — the frame already painted the
   * mark. So this is its own counter: the editor watches it, the viewer does
   * not, and a cut stays as cheap as it was.
   *
   * Carries the member, because an editor showing a DIFFERENT chapter of the
   * same book has nothing to reload and must not be disturbed.
   */
  readonly memberWritten = signal<{ tabId: string; member: string; seq: number } | null>(null);
  private memberSeq = 0;

  private memberChanged(tabId: string, member: string): void {
    this.memberSeq += 1;
    this.memberWritten.set({ tabId, member, seq: this.memberSeq });
  }

  /** One chapter's XHTML source, for the editor pane. */
  async chapterSource(tab: Tab, href: string): Promise<string> {
    if (!api || tab.book === null) return '';
    // A section-header row's href carries a #fragment; the FILE is the member.
    return api.epub.readMember(tab.book.id, memberOf(href));
  }

  /**
   * Write an edited chapter back.
   *
   * Main writes the member AND repacks the workspace copy in the same call
   * (electron/epub-reader.ts), so by the time this resolves the edit is in a
   * real EPUB on disk. That is what lets `modified` mean "the copy you filed is
   * older" rather than "your work is in a temp directory".
   *
   * `revision` is bumped last, because it is what reloads the rendered pane and
   * reloading it before the bytes landed would show the previous version. The
   * pane doing the reloading may now be a different one from the pane the
   * keystroke happened in, which costs this code nothing: the revision is on the
   * tab, and every viewer of that tab is watching it.
   *
   * THROUGH THE SAME PER-MEMBER QUEUE select mode's writes use. The editor and
   * the mode can be open on one chapter at once, and a flush of the whole
   * chapter overlapping a cut of one block in it is two read-modify-writes of
   * one file where the loser's change simply vanishes.
   */
  async writeChapter(id: string, href: string, text: string): Promise<void> {
    const bridge = api;
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!bridge || !tab || tab.book === null) return;
    const bookId = tab.book.id;
    const member = memberOf(href);
    this.writingTo.set(id);
    try {
      await this.queueMemberWrite(
        bookId,
        member,
        () => bridge.epub.writeMember(bookId, member, text),
      );
      // Re-read rather than +1 on the tab captured before the queue: a refused
      // cut repaints by bumping the revision too, so the number this write
      // lands on may not be the one it started from.
      this.patch(id, { modified: true, revision: (this.byId(id)?.revision ?? tab.revision) + 1 });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.writingTo() === id) this.writingTo.set(null);
    }
  }

  /**
   * Rename a TOC entry — a chapter, or a section header inside one.
   *
   * Main does the writing (nav label + the heading when it matched, through
   * the same workspace write-through as an edit); this side only mirrors the
   * new label into the sidebar and marks the tab edited. The tab's TITLE does
   * not change — that is the book's dc:title, not a chapter's name. Returns
   * whether the rename happened, so the sidebar can keep its input open on a
   * refusal.
   */
  async renameHeading(id: string, href: string, newLabel: string): Promise<boolean> {
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!api || !tab || tab.book === null) return false;
    const label = newLabel.trim();
    if (label.length === 0) return false;
    try {
      await api.epub.renameHeading(tab.book.id, href, label);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    }
    const chapters = tab.book.chapters.map((chapter) =>
      (chapter.href === href ? { ...chapter, label } : chapter));
    // The revision bump reloads the rendered pane: when the heading itself was
    // rewritten, the page must show it.
    this.patch(id, {
      book: { ...tab.book, chapters },
      modified: true,
      revision: tab.revision + 1,
    });
    return true;
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  /**
   * Ctrl/Cmd+S. Writes to the file the user already chose, or asks once.
   *
   * The fallback to Save As is the behaviour of every editor, and it is what
   * makes the editor's Save button worth having: after the first time it stops
   * asking a question the user has already answered.
   *
   * A PDF always goes through the picker instead. Nothing in this app edits a
   * PDF, so a silent re-save to the same destination would copy identical bytes
   * over identical bytes — the one thing Ctrl+S could do for it is ask where.
   */
  async save(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!tab) return;
    // A save typed into the editor is a save of the book it edits.
    if (tab.kind === 'editor') {
      await this.flushPending(tab.id);
      if (tab.sourceTabId !== null) await this.save(tab.sourceTabId);
      return;
    }
    if (tab.kind === 'pdf' || tab.savedPath === null) {
      await this.saveAs(tab.id);
      return;
    }
    await this.flushPending(this.editorFor(tab.id)?.id ?? null);
    // Re-read: the flush wrote through the workspace copy this repack reads.
    await this.writeBook(this.byId(tab.id) ?? tab, tab.savedPath);
  }

  /**
   * Ctrl/Cmd+Shift+S. Always the picker.
   *
   * A PDF saves as a COPY of the finished file: a conversion's output lives in
   * the workspace until this puts it somewhere the user chose, and that is the
   * whole difference between "foundry made me a searchable PDF" and "there is a
   * searchable PDF in a folder I know about". An EPUB repacks from its working
   * copy instead (electron/epub-reader.ts), because its edits live there.
   */
  async saveAs(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!api || !tab) return;
    if (tab.kind === 'editor') {
      await this.flushPending(tab.id);
      if (tab.sourceTabId !== null) await this.saveAs(tab.sourceTabId);
      return;
    }
    if (tab.kind === 'pdf') {
      try {
        const destination = await api.documentSaveCopy(tab.path, suggestName(tab.title, '.pdf'));
        if (destination === null) return;
        this.patch(tab.id, { unsaved: false, savedPath: destination });
      } catch (err) {
        this.notice.set(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (tab.book === null) {
      this.notice.set('This book is still opening — try again in a moment.');
      return;
    }
    await this.flushPending(this.editorFor(tab.id)?.id ?? null);
    const chosen = await api.epub.chooseSavePath(tab.book.id, suggestName(tab.title, '.epub'));
    if (chosen === null) return;
    await this.writeBook(this.byId(tab.id) ?? tab, chosen);
  }

  /** The menu's Save / Save As. The focused pane's document, editor or book. */
  async saveActive(): Promise<void> {
    const tab = this.active();
    if (tab) await this.save(tab.id);
  }

  async saveActiveAs(): Promise<void> {
    const tab = this.active();
    if (tab) await this.saveAs(tab.id);
  }

  /**
   * Repack the working copy to `destination` and settle both flags.
   *
   * A failure leaves BOTH flags where they were: a save that did not happen must
   * not clear a dot, or the tab would claim a file exists that does not.
   */
  private async writeBook(tab: Tab, destination: string): Promise<void> {
    if (!api || tab.book === null) return;
    try {
      await api.epub.save(tab.book.id, destination);
      this.patch(tab.id, { unsaved: false, modified: false, savedPath: destination });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  private patch(id: string, changes: Partial<Tab>): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }
}

/**
 * Every pane an equal share.
 *
 * Applied when a pane is ADDED and not when one is removed: a new column has no
 * share of its own to keep, and taking the row back to equal is the only
 * arrangement that does not favour whichever neighbour happened to be widest.
 * Removing a pane leaves the others alone — flex already reflows them in
 * proportion, which is the arrangement the user made.
 */
function equalise(panes: readonly Pane[]): Pane[] {
  return panes.map((pane) => ({ ...pane, flex: 1 }));
}

/**
 * Which column a document that wanted one of its OWN has to settle for, once
 * there are five and there are no more to make.
 *
 * The rightmost, normally — a conversion's output has no opinion about where it
 * lands, and the far end displaces the least of what the user was looking at.
 *
 * BUT NOT WHEN IT ASKED TO BE BESIDE SOMETHING. An HTML editor is a face of one
 * particular book, and at the cap "the rightmost column" can BE that book's
 * column: pressing Edit HTML would then replace the page with its own source,
 * which is the one arrangement the feature exists to avoid. So it takes the
 * column just right of the book instead, or just left when the book is already
 * the last one. Something is displaced either way — that is what a full window
 * means — but never the document the gesture was about.
 */
function crowdedTarget(panes: readonly Pane[], beside: string | null): Pane {
  const last = panes[panes.length - 1]!;
  if (beside === null) return last;
  const at = panes.findIndex((pane) => pane.id === beside);
  if (at < 0) return last;
  return panes[at + 1] ?? panes[at - 1] ?? last;
}

/** Windows paths differ by case and separator and are the same file. */
function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

/** A sidebar href without its #fragment — the member file it lives in. */
function memberOf(href: string): string {
  return href.split('#')[0] ?? href;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * A filename out of a book's title.
 *
 * The characters removed are the ones Windows refuses outright; a title with a
 * colon in it is common (`Working Towards The Fuhrer: …`) and a save dialog that
 * opened pre-filled with an illegal name would fail on OK with a message from
 * the OS rather than from us.
 */
function suggestName(title: string, extension: '.epub' | '.pdf'): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = cleaned.length > 0 ? cleaned : 'book';
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
}
