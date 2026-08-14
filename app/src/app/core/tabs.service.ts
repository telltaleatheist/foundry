import { Injectable, computed, effect, inject, signal } from '@angular/core';

import type { FoundryApi } from '@shared/api';
import { categoryLabel } from '@shared/categories';
import type { EpubBook, HeadingEcho, JobKind, UnlinkedNote } from '@shared/types';

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
 * The blocks one frame says are selected.
 *
 * A SET, since the marquee: a drag over empty space takes everything it
 * touches, shift and ctrl/cmd extend a click, and every gesture in the mode —
 * Delete, the inspector's relabel — acts on all of them as one batch.
 *
 * IT IS NOT A FACT ABOUT THE BOOK, and it is NOT IN THE UNDO STACK. A selection
 * lives in the frame's DOM and dies with the frame; nothing on disk records it,
 * and a reload starts with nothing selected. It is held here only because the
 * inspector — which is in the shell, not in the pane — has no other way to
 * learn what the user clicked. (BookForge puts its selection in the history and
 * pays for it with a special case in three separate places.)
 */
export interface FrameSelection {
  blockIds: readonly string[];
  /**
   * The `data-bf-cat` they all share, so the inspector can mark the row the
   * selection already is — and null the moment two of them disagree, because a
   * marked row over a mixed selection is the panel asserting something untrue
   * about most of what is highlighted.
   */
  category: string | null;
}

/** How many blocks of each category the rendered chapter holds, and how many are struck. */
export interface CategoryCounts {
  counts: Readonly<Record<string, number>>;
  struck: Readonly<Record<string, number>>;
}

/**
 * Which setter puts one ledger row back.
 *
 * THE FIELD IS THE ROUTE, and there are five because there are five things this
 * app can do to a document. Each names a call that already exists in main, with
 * its own validator, keyed by the same id the original edit used.
 */
export type LedgerField = 'cut' | 'category' | 'html' | 'note-cut' | 'nav-label' | 'page-heading';

/**
 * One element, one field, and what it said on each side of an action.
 *
 * `target` is a `data-bf-id` for the three block fields, a footnote's own id
 * (`fn25`) for `note-cut`, and a contents entry's href for the two rename
 * fields — in every case, the name the ORIGINAL setter was called with, so the
 * replay is that call again with the other value.
 */
export interface LedgerRow {
  /** The member the setter writes. Not always the chapter on screen. */
  member: string;
  target: string;
  field: LedgerField;
  before: string;
  after: string;
}

/**
 * One action — Owen's action number — and every row it moved.
 *
 * A batch is ONE action with many rows: a marquee's worth of cuts, an
 * all-of-this-category strike, sixteen blocks relabelled at once. That is the
 * whole of what "ctrl+z will reverse all action number 12 items" needs, and it
 * falls out of the design rather than being arranged: the gesture is one call
 * to main, main answers with everything it moved, and that answer IS the rows.
 */
export interface LedgerAction {
  seq: number;
  /** Past tense: "struck 14 blocks" → "Undid: struck 14 blocks." */
  label: string;
  rows: readonly LedgerRow[];
}

/** One document's ledger. Made on its first edit, dropped when it closes. */
interface Ledger {
  done: LedgerAction[];
  undone: LedgerAction[];
}

/** The list under one key, made on first use. Grouping rows for one repaint call. */
function bucket<K>(map: Map<K, string[]>, key: K): string[] {
  const found = map.get(key);
  if (found) return found;
  const made: string[] = [];
  map.set(key, made);
  return made;
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
      /*
       * AND THE LEDGER GOES WITH THE DOCUMENT, which is the whole difference
       * from the singleton this replaces: there is no shared stack to clear
       * field by field, and no way for one book's undo to reach into another's.
       * It is in memory only — closing the book ends what Ctrl+Z can reach, and
       * the working copy on disk is what survives.
       */
      this.ledgers.delete(gone);
      this.editing.delete(gone);
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
    const unlinked = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setBlockHtml(book, member, blockId, html),
      (_notes, member) => ({
        label: `edited the words of ${blockId}`,
        /*
         * NO `was`, NO ROW. The frame hands over the block's previous markup
         * and it is the only copy of it anywhere — main wrote the new words
         * over the old ones. A row with an empty `before` would be a Ctrl+Z
         * that blanks the paragraph, so an edit that arrives without it is
         * applied and simply is not undoable. It cannot happen for an edit this
         * app's own frame made; it is the shape of the message that allows it.
         */
        rows: was.length === 0 ? [] : [{
          member,
          target: blockId,
          field: 'html' as const,
          before: was,
          after: html,
        }],
      }),
    );
    // Null is a refusal, and a refusal wrote nothing — there is no new text for
    // either question below to be about.
    if (unlinked === null) return;
    if (unlinked.length > 0 && await this.askAboutUnlinkedNotes(id, blockId, was, unlinked)) {
      // Cancelled: the block is back to the markup it had, so the heading (if
      // this was one) reads what it always read and there is nothing to offer
      // the contents.
      return;
    }
    await this.askAboutNavEcho(id, blockId, was);
  }

  /**
   * "You edited this heading — should the contents entry change too?"
   *
   * THE DIRECTION THAT DID NOT EXIST. An in-place heading edit wrote the page
   * and stopped there, so a typo fixed on the page stayed in the table of
   * contents forever with nothing on screen to say so. That was a bug: the
   * divergence this design protects is a DELIBERATE one — the caster composes
   * labels the page never carried, and "Part II — The Road to War" over a page
   * reading "II" is correct — and a misspelling nobody chose is not that.
   *
   * Main answers the four questions that decide whether there is anything to
   * ask at all (`navEchoForBlock`), and it is null far more often than not: the
   * block is a paragraph, the book has no contents, no entry points here, or
   * the entry already says something else on purpose. Only the last case is
   * interesting, and it is exactly the case where asking would be wrong.
   *
   * ASKED AFTER THE WRITE, like every other question in this mode. The page is
   * already showing what was typed; the contents is what has not moved.
   */
  private async askAboutNavEcho(id: string, blockId: string, was: string): Promise<void> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return;
    if (was.length === 0) return;
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      const echo = await bridge.epub.navEchoForBlock(bookId, member, blockId, was);
      if (echo === null) return;
      const answer = await bridge.confirmNavEcho(echo);
      if (answer !== 'update') return;

      /*
       * The nav half, through the ordinary rename door. It cannot ask about
       * the page in return — that door offers the heading only when the
       * heading still reads the OLD label, and this heading is the thing that
       * just changed — so the two directions cannot bounce a question between
       * them.
       *
       * ITS OWN LEDGER ACTION, and not part of the edit that prompted it. They
       * are two answers a person gave separately — the words, then "yes, change
       * the contents as well" — and one Ctrl+Z that took back both would undo a
       * question the user answered on purpose.
       */
      await bridge.epub.renameHeading(bookId, echo.href, echo.now);
      const navMember = tab.book.navMember;
      this.record(id, `carried the heading through to the contents as "${echo.now}"`,
        navMember === null ? [] : [{
          member: navMember,
          target: echo.href,
          field: 'nav-label',
          before: echo.was,
          after: echo.now,
        }]);
      const current = this.byId(id);
      if (!current || current.book === null) return;
      const chapters = current.book.chapters.map((chapter) =>
        (chapter.href === echo.href ? { ...chapter, label: echo.now } : chapter));
      // NO REVISION BUMP: the rendered pane is showing the chapter, and the
      // chapter did not move. Reloading it would cost the reader their place
      // to repaint a sidebar row this line has already repainted.
      this.patch(id, { book: { ...current.book, chapters }, modified: true });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
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
  ): Promise<boolean> {
    const bridge = api;
    if (!bridge) return false;
    for (const note of notes) {
      const answer = await bridge.confirmUnlinkedNote(note);
      if (answer === 'cancel') {
        await this.restoreBlockHtml(id, blockId, was);
        // Said out loud rather than left for the caller to infer from the
        // absence of anything: the edit has been UNDONE, and every later
        // question about "the new text" would be a question about text that is
        // no longer there.
        return true;
      }
      if (answer === 'keep') continue;
      const done = await this.blockEdit(
        id,
        (b, book, member) => b.epub.setNoteCut(book, member, note.noteId, true),
        (moved, member) => ({
          label: `struck the footnote ${note.noteId}`,
          // False means the note already carried the mark, so this gesture
          // changed nothing and must not leave a row promising to bring back a
          // footnote somebody else struck.
          rows: moved === true ? [{
            member,
            target: note.noteId,
            field: 'note-cut' as const,
            before: '',
            after: '1',
          }] : [],
        }),
      );
      // PAINTED AFTER THE WRITE, and only when the write landed — the opposite
      // of every other mark in this mode. A cut the user pressed Delete for is
      // painted first because the hand is already moving; this one was decided
      // in a dialog that has just closed, there is no gesture to keep up with,
      // and painting a strike over a footnote main then refused to mark would
      // be a lie with nothing on screen to correct it.
      if (done !== null) this.commandFrame(id, { type: 'foundry:mark-note', noteId: note.noteId, cut: true });
    }
    return false;
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
      /*
       * THE CANCELLED EDIT LEAVES THE LEDGER RATHER THAN GAINING A SECOND ROW.
       *
       * This IS an undo, performed by a dialog: the block now says exactly what
       * it said before the user typed. Recording the restore as an action of
       * its own would leave two entries whose net effect is nothing, and the
       * next Ctrl+Z would REDO the edit the user just cancelled — pressing undo
       * to bring back a footnote reference they had chosen to keep. Dropping
       * the edit's own action instead leaves the ledger describing the book as
       * it actually stands.
       */
      this.dropLastAction(id, blockId);
      this.memberChanged(id, member);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
    const current = this.byId(id);
    if (current) this.patch(id, { modified: true, revision: current.revision + 1 });
  }

  /**
   * Relabel THE WHOLE SELECTION — the inspector's Category rows, applied to
   * every block the frame says is highlighted, in one read and one write.
   *
   * IT CHANGES THE LABEL AND NOT THE SHAPE: a paragraph relabelled `footnote`
   * stays a `<p>` in the prose and does not move into the footnotes section.
   * That re-shaping is `foundry epub-final`'s and is not in this app.
   *
   * Same optimism as the cut — the frame set the attributes and repainted its
   * own colours off them before this ran — so no revision bump on success, and a
   * bump on a refusal to let the file repaint over the guess. And SAID OUT LOUD
   * once it is more than one block: relabelling thirty paragraphs from a panel
   * on the far side of the window is a gesture whose effect is off screen.
   */
  async setBlockCategories(
    id: string,
    blockIds: readonly string[],
    category: string,
  ): Promise<void> {
    const kind = categoryLabel(category).toLowerCase();
    const changed = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setCategories(book, member, [...blockIds], category),
      (moved, member) => ({
        label: `relabelled ${moved.length} block${moved.length === 1 ? '' : 's'} as ${kind}`,
        // ONE ROW PER BLOCK, each carrying the label THAT block used to have.
        // A marquee over a page catches paragraphs and captions together, so an
        // undo that put them all back to one category would be inventing a past
        // the book never had — which is why main answers with `was` rather than
        // with a count.
        rows: moved.map((one) => ({
          member,
          target: one.id,
          field: 'category' as const,
          before: one.was,
          after: category,
        })),
      }),
    );
    if (changed === null || blockIds.length < 2) return;
    this.notice.set(changed.length === 0
      ? `All ${blockIds.length} of those blocks were already ${kind} — nothing changed.`
      : `Relabelled ${changed.length} block${changed.length === 1 ? '' : 's'} as ${kind}.`);
  }

  /**
   * Strike — or bring back — a list of blocks in ONE write, and SAY IT.
   *
   * THE ONE CUT PATH. Delete on a single block, Delete on a marquee's worth of
   * them, and the inspector's select-all-by-category all arrive here; `category`
   * is the only thing that differs, and it only changes the sentence. One path
   * means one undo entry shape and one place the count is read.
   *
   * The number comes back from main rather than from the count the frame sent,
   * because they can differ — a block already carrying the mark is not a change
   * — and a gesture that reports what it asked for rather than what it did is a
   * gesture nobody can trust with two hundred paragraphs.
   */
  async cutBlocks(
    id: string,
    blockIds: readonly string[],
    cut: boolean,
    category: string | null,
  ): Promise<void> {
    const kind = category === null ? '' : `${categoryLabel(category).toLowerCase()} `;
    const changed = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setCuts(book, member, [...blockIds], cut),
      (moved, member) => ({
        label: `${cut ? 'struck' : 'brought back'} ${moved.length} ${kind}`
          + `block${moved.length === 1 ? '' : 's'}`,
        // ONE ACTION, MANY ROWS — Owen's action number. Sixteen blocks struck by
        // one marquee are sixteen rows here, and one Ctrl+Z reverses all
        // sixteen. Only the ids MAIN says moved get a row: a block that was
        // already struck was not changed by this gesture and must not be
        // brought back by undoing it.
        rows: moved.map((target) => ({
          member,
          target,
          field: 'cut' as const,
          before: cut ? '' : '1',
          after: cut ? '1' : '',
        })),
      }),
    );
    if (changed === null) return;
    /*
     * ONE BLOCK SAYS NOTHING, and that is deliberate. Pressing Delete on a
     * paragraph paints a line through it under the pointer; a notice strip
     * repeating what the user is already looking at would train them to stop
     * reading the strip, which is where every refusal in this mode lands.
     */
    if (changed.length === 1 && blockIds.length === 1) return;
    const many = changed.length === 1 ? '' : 's';
    this.notice.set(changed.length === 0
      ? `Every one of those ${kind}blocks already ${cut ? 'was struck' : 'stood'} — nothing changed.`
      : cut
        ? `Struck ${changed.length} ${kind}block${many}. Press Delete on them to bring them back.`
        : `Brought back ${changed.length} ${kind}block${many}.`);
  }

  /**
   * Every select-mode write, and the one place their optimism is spelled out.
   *
   * Resolves with whatever main answered, or NULL when the write was refused or
   * there was nothing to write to — which is what lets a caller tell "main did
   * this" from "main would not", without a second try/catch at every call site.
   *
   * IT IS ALSO WHERE THE ACTION IS WRITTEN INTO THE LEDGER. `entry` is asked
   * for the label and the rows AFTER main has answered, because both need what
   * main said MOVED rather than what the frame asked for — "struck 14 blocks"
   * when fourteen tags actually changed, whatever the marquee caught, and a row
   * for each of those fourteen and no others.
   */
  private async blockEdit<T>(
    id: string,
    // THE WRITE COMES FIRST so TypeScript can infer `T` from it before it has
    // to type the callback below — with the two the other way round, `answer`
    // infers as `{}` and every call site has to restate main's return type by
    // hand, which is two declarations of one thing waiting to disagree.
    write: (bridge: FoundryApi, bookId: string, member: string) => Promise<T>,
    entry: (answer: T, member: string) => { label: string; rows: readonly LedgerRow[] },
  ): Promise<T | null> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return null;
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      const answer = await this.queueMemberWrite(bookId, member, () => write(bridge, bookId, member));
      const { label, rows } = entry(answer, member);
      this.record(id, label, rows);
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

  // ── Undo / redo: the ledger ──────────────────────────────────────────────
  //
  // A LEDGER OF ACTIONS, not a stack of chapter snapshots. Owen's shape, and it
  // is right for a reason particular to this app: every document action ALREADY
  // has a targeted, validated setter in main, keyed by `data-bf-id` —
  // `setCuts`, `setCategories`, `setBlockHtml`, `setNoteCut`, `renameHeading`.
  // So an undo is not a new way of writing a book. IT IS THE SAME CALL WITH THE
  // OLD VALUE, through the same validators, which means undo cannot corrupt a
  // book in any way an ordinary edit could not. A snapshot undo would have been
  // a second route into somebody's chapters that no validator ever saw — the
  // one thing this codebase spends its refusals avoiding.
  //
  // It is also the difference between a few dozen bytes per action and fifty
  // kilobytes of it, and — the part that matters more — A SNAPSHOT CANNOT SAY
  // WHAT IT IS. From a row the notice strip can say "Undid: relabelled 16
  // blocks as footnote". From a pair of chapter texts it can only say "Undid".
  //
  // AN ACTION HAS A NUMBER AND MANY ROWS. Sixteen blocks struck by one marquee
  // are sixteen rows of one action, and Ctrl+Z reverses all sixteen — which is
  // exactly what Owen asked for, and it falls out rather than being arranged:
  // the gesture is ONE call to main, main answers with everything it moved, and
  // that answer IS the rows.
  //
  // THE FIVE ACTIONS ARE THE WHOLE OF IT: cut/un-cut, relabel, edit words,
  // strike a footnote, rename a heading. Nothing else in this app writes a
  // document, and a sixth would have to add a `LedgerField` to exist.
  //
  // PER DOCUMENT, created on its first edit and dropped with the tab (`close`),
  // never a singleton cleared field by field. Keyed by tab id in a plain Map
  // rather than stored on the `Tab` itself, because `Tab` is replaced wholesale
  // by `patch()` on every edit and a growing array riding along in it would be
  // copied on each one. IN MEMORY ONLY: closing the book ends what Ctrl+Z can
  // reach, and that is stated rather than implied by the absence of a file.
  //
  // AND THE SELECTION IS NOT IN IT. It is not a fact about the book, it dies
  // with the frame anyway, and BookForge — which does put it in the stack —
  // special-cases it in three separate places for the privilege.

  private readonly ledgers = new Map<string, Ledger>();
  private actionSeq = 0;

  /**
   * How many actions one document's ledger holds.
   *
   * A COUNT IS SAFE HERE and would not have been for a snapshot stack. The plan
   * warns against action-count caps because BookForge's entries embed whole
   * blocks and one of them reached 15.57 MB, so 200 actions is either a few
   * megabytes or several gigabytes depending on the book. A row here is a
   * member path, an id, a field name and two short values — the one unbounded
   * field is a word edit's markup, which is one block of prose. Five hundred of
   * them is a few megabytes at the outside, and it is more curation than
   * anybody does to one chapter in a sitting.
   */
  private static readonly LEDGER_ACTIONS = 500;

  /**
   * File one action away, however many rows it moved.
   *
   * `label` is a sentence fragment in the past tense — "struck 14 blocks" — so
   * that undoing it reads as "Undid: struck 14 blocks." It is written by the
   * caller AFTER main has answered, because the number in it has to be what
   * moved rather than what was asked for.
   */
  private record(tabId: string, label: string, rows: readonly LedgerRow[]): void {
    // An action that moved nothing is not an action. Relabelling thirty blocks
    // that were already that category writes no bytes, and a Ctrl+Z that
    // appears to do nothing is worse than no entry at all.
    if (rows.length === 0) return;
    this.actionSeq += 1;
    const ledger = this.ledgers.get(tabId) ?? { done: [], undone: [] };
    ledger.done.push({ seq: this.actionSeq, label, rows });
    /*
     * A NEW ACTION ENDS THE FUTURE. Undo three cuts, then cut something else,
     * and the three are gone — the standard rule, and the only one that does
     * not require deciding what a branching history looks like on screen.
     */
    ledger.undone = [];
    // Oldest first. The user is at the new end, so what is dropped is the work
    // furthest from what they are doing.
    while (ledger.done.length > TabsService.LEDGER_ACTIONS) ledger.done.shift();
    this.ledgers.set(tabId, ledger);
  }

  /**
   * Take the newest action back off the ledger without replaying anything.
   *
   * FOR ONE CALLER ONLY: the footnote dialog's "put the number back", which
   * writes the block's previous markup itself and so has already reversed the
   * action it is cancelling. See `restoreBlockHtml`. It is deliberately not a
   * general facility — anything else that wanted to erase history would be
   * hiding a write from the person who made it.
   *
   * IT NAMES THE ACTION IT EXPECTS TO FIND, and drops nothing otherwise. An
   * edit that arrived without the frame's `was` records NO rows and so no
   * action at all, and a blind pop would then throw away whatever the user did
   * before it — a cut of some other paragraph, silently ungettable back.
   */
  private dropLastAction(tabId: string, blockId: string): void {
    const done = this.ledgers.get(tabId)?.done;
    const last = done?.[done.length - 1];
    if (!done || !last) return;
    if (last.rows.length !== 1) return;
    const row = last.rows[0]!;
    if (row.field !== 'html' || row.target !== blockId) return;
    done.pop();
  }

  /** Ctrl/Cmd+Z, from the Edit menu. The focused document's, never a global one. */
  async undo(): Promise<void> {
    await this.replay('undo');
  }

  /** Ctrl/Cmd+Shift+Z. */
  async redo(): Promise<void> {
    await this.replay('redo');
  }

  /**
   * Put one action back, row by row, through the setters that made it.
   *
   * A CARET IN THE PAGE MEANS THE TYPING FIRST. While a block is being edited in
   * place, Ctrl+Z is about the sentence being typed and not about the book — so
   * it is handed back to the frame, which is the only thing that can reach a
   * contenteditable's own history. Main swallowed the keypress on its way past
   * (it is a menu accelerator), which is why the frame has to be told rather
   * than left to see it.
   *
   * ROWS ARE REPLAYED IN REVERSE ORDER, which matters for the one action that
   * writes two files: a rename put the contents entry first and the page
   * heading second, so undoing takes the heading back before the entry, and
   * `renamePageHeading`'s check that the heading still reads what the dialog
   * saw is made against a book nothing else has moved in between.
   *
   * EVERY REFUSAL IS A SENTENCE, including "there is nothing to undo": the menu
   * item cannot grey itself out against renderer state, so a chord that quietly
   * did nothing would be indistinguishable from a chord that is broken.
   */
  private async replay(direction: 'undo' | 'redo'): Promise<void> {
    const tab = this.activeDocument();
    if (!api || !tab) {
      this.notice.set('There is no document in front of you to undo anything in.');
      return;
    }
    if (this.editing.has(tab.id)) {
      this.commandFrame(tab.id, { type: 'foundry:undo-typing', redo: direction === 'redo' });
      return;
    }
    if (tab.book === null) {
      this.notice.set(`${tab.title} is still opening.`);
      return;
    }
    const ledger = this.ledgers.get(tab.id);
    const from = direction === 'undo' ? ledger?.done : ledger?.undone;
    const action = from === undefined ? undefined : from[from.length - 1];
    if (ledger === undefined || from === undefined || action === undefined) {
      this.notice.set(direction === 'undo'
        ? `There is nothing to undo in ${tab.title}. A document's history is kept while it is open `
          + 'and ends when it closes.'
        : `There is nothing to redo in ${tab.title}.`);
      return;
    }

    const bookId = tab.book.id;
    /*
     * REPAINTED WITHOUT A RELOAD WHERE THE ROW IS AN ATTRIBUTE, and with one
     * where it is words. Because the replay goes through the same setters, a
     * cut or a relabel put back is one attribute on one start tag — exactly
     * what the original gesture wrote — so the frame can flip it in place the
     * way it does for a Delete, and the reader keeps their place in the
     * chapter. A word edit and a renamed heading change text the frame is
     * showing, and there is no attribute that would put a sentence back, so
     * those bump `Tab.revision` and the chapter repaints from the file. That is
     * the same rule the rest of select mode follows, applied per row rather
     * than as a blanket reload — a needless bump costs the reader their place
     * in the chapter, which is the cost `cutBlocks` exists to avoid paying on
     * every keystroke.
     */
    const cutIds = new Map<boolean, string[]>();
    const labelled = new Map<string, string[]>();
    // A contents entry put back is a row in the sidebar, which is drawn from
    // `book.chapters` and not from the file — so undoing the write without this
    // would leave the panel showing a label the navigation document no longer
    // carries. It is the same line the rename itself runs.
    const renamed = new Map<string, string>();
    let reload = false;

    for (let at = action.rows.length - 1; at >= 0; at -= 1) {
      const row = action.rows[at]!;
      const value = direction === 'undo' ? row.before : row.after;
      try {
        await this.replayRow(bookId, row, value, direction);
      } catch (err) {
        /*
         * THE ACTION STAYS WHERE IT IS. The write is what the undo IS, so a
         * refused write means the undo did not happen — and an action quietly
         * popped off the ledger would be a Ctrl+Z that reported nothing and
         * threw away the only record of how to reverse the edit. Pressing it
         * again after fixing whatever main named will try the same rows.
         *
         * AND THE FRAME IS RELOADED, which is the replay rule's second half:
         * some rows of this action may have landed and the page is now showing
         * a state the book does not back. Repainting from the file is the only
         * honest fix.
         */
        this.notice.set(
          `${direction === 'undo' ? 'Undo' : 'Redo'} stopped at ${row.target}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        const stalled = this.byId(tab.id);
        if (stalled) this.patch(tab.id, { modified: true, revision: stalled.revision + 1 });
        return;
      }
      this.memberChanged(tab.id, row.member);
      if (row.field === 'cut' || row.field === 'note-cut') bucket(cutIds, value === '1').push(row.target);
      else if (row.field === 'category') bucket(labelled, value).push(row.target);
      else if (row.field === 'nav-label') renamed.set(row.target, value);
      // `html` and `page-heading` are the two that change WORDS the frame is
      // showing. There is no attribute to flip that would put a sentence back,
      // so these — and only these — reload the chapter.
      else reload = true;
    }

    for (const [cut, ids] of cutIds) {
      this.commandFrame(tab.id, { type: 'foundry:mark-blocks', ids, cut });
    }
    for (const [category, ids] of labelled) {
      this.commandFrame(tab.id, { type: 'foundry:mark-labels', ids, cat: category });
    }

    from.pop();
    (direction === 'undo' ? ledger.undone : ledger.done).push(action);

    const current = this.byId(tab.id);
    const revision = current?.revision ?? tab.revision;
    this.patch(tab.id, {
      modified: true,
      revision: reload ? revision + 1 : revision,
      ...(renamed.size > 0 && current?.book
        ? {
          book: {
            ...current.book,
            chapters: current.book.chapters.map((chapter) => {
              const label = renamed.get(chapter.href);
              return label === undefined ? chapter : { ...chapter, label };
            }),
          },
        }
        : {}),
    });
    // BY NAME, always. "Undid" on its own leaves a person checking three panes
    // to find out what moved; the label was written when the action was
    // recorded precisely so this sentence could exist.
    this.notice.set(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${action.label}.`);
  }

  /**
   * One row, through the setter its field names.
   *
   * THE VALIDATORS ARE THE POINT. Each of these is the call the original
   * gesture made, with the other value — so an undo is refused by exactly the
   * checks an edit is refused by, and a ledger row cannot put a book into a
   * shape a person could not have typed.
   */
  private async replayRow(
    bookId: string,
    row: LedgerRow,
    value: string,
    direction: 'undo' | 'redo',
  ): Promise<void> {
    const bridge = api;
    if (!bridge) return;
    if (row.field === 'cut') {
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.setCuts(bookId, row.member, [row.target], value === '1'));
      return;
    }
    if (row.field === 'note-cut') {
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.setNoteCut(bookId, row.member, row.target, value === '1'));
      return;
    }
    if (row.field === 'category') {
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.setCategories(bookId, row.member, [row.target], value));
      return;
    }
    if (row.field === 'html') {
      /*
       * UNDOING WORDS GOES THROUGH `restoreBlockHtml`, NEVER `setBlockHtml`,
       * and getting this backwards is the one way this design could lose a
       * footnote. An edit is allowed to DELETE a reference number — a `<sup>`
       * and its anchor may disappear — and `setBlockHtml` forbids markup being
       * GAINED, so undoing that edit through it would be refused every single
       * time. `restoreBlockHtml` exists for exactly this shape (it was built
       * for the footnote dialog's "put the number back") and makes the mirror
       * check instead: what is on disk NOW must be a legal word-edit OF the
       * text being restored, so it still refuses to overwrite a change made
       * underneath it.
       *
       * REDO GOES THE OTHER WAY, through `setBlockHtml`, because redoing is
       * replaying the original edit and the original edit was legal by
       * definition — while the mirror check would refuse it, a reference number
       * being removed not being a legal word-edit in reverse. The notes it
       * answers with are DROPPED here: the question "should the footnote go
       * too?" was asked and answered when the edit was first made, and asking
       * it again on a Ctrl+Shift+Z would be re-litigating a decision the user
       * has already recorded as its own ledger action.
       */
      if (direction === 'undo') {
        await this.queueMemberWrite(bookId, row.member, () =>
          bridge.epub.restoreBlockHtml(bookId, row.member, row.target, value));
      } else {
        await this.queueMemberWrite(bookId, row.member, () =>
          bridge.epub.setBlockHtml(bookId, row.member, row.target, value));
      }
      return;
    }
    if (row.field === 'nav-label') {
      // The echo it answers with is dropped: "should the page's heading change
      // too?" is a question about a rename somebody is making, not about one
      // being taken back.
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.renameHeading(bookId, row.target, value));
      return;
    }
    // `page-heading`. `was` is the OTHER side of the row, which is what the
    // page reads right now — main checks it against the file and refuses if
    // the heading moved underneath, exactly as it does for the dialog.
    const was = direction === 'undo' ? row.after : row.before;
    await this.queueMemberWrite(bookId, row.member, () =>
      bridge.epub.renamePageHeading(bookId, row.target, value, was));
  }

  /**
   * Which tabs have a caret sitting in a block right now.
   *
   * Reported by the frame, because nothing out here can see into it: the parent
   * holds an <iframe> element whose document is behind an opaque origin, and
   * `document.activeElement` in the shell says only "the iframe". It exists for
   * exactly one decision — what Ctrl+Z means — and a plain Set is enough,
   * because nothing on screen is drawn from it.
   */
  private readonly editing = new Set<string>();

  reportEditing(tabId: string, on: boolean): void {
    if (on) this.editing.add(tabId);
    else this.editing.delete(tabId);
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
  private readonly selections = signal<ReadonlyMap<string, FrameSelection>>(new Map());
  private readonly counts = signal<ReadonlyMap<string, CategoryCounts>>(new Map());

  selectionFor(tabId: string | null): FrameSelection | null {
    return tabId === null ? null : this.selections().get(tabId) ?? null;
  }

  countsFor(tabId: string | null): CategoryCounts | null {
    return tabId === null ? null : this.counts().get(tabId) ?? null;
  }

  /** An empty list is "nothing is selected", and drops the entry rather than storing one. */
  reportSelection(tabId: string, blockIds: readonly string[], category: string | null): void {
    this.selections.update((map) => {
      const next = new Map(map);
      if (blockIds.length === 0) next.delete(tabId);
      else next.set(tabId, { blockIds, category });
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
      this.notice.set('Click a block in the page first, or drag a rectangle over several; the '
        + 'category is applied to everything that is selected.');
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
      /*
       * NOT IN THE LEDGER, and that is a decision rather than an omission. The
       * ledger's five actions each name an ELEMENT and a FIELD, and replaying
       * one goes back through the validator that accepted it. A whole chapter
       * flushed out of a textarea names nothing and has no validator — it is
       * the one write in this app that is allowed to be anything at all — so
       * the only way to record it would be the chapter's whole text, which is
       * the snapshot design this one deliberately is not. The editor is a text
       * editor: its Ctrl+Z is the textarea's own, which is what the Edit menu
       * hands it (see `app.ts`), and that is the undo that belongs to typing.
       */
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
   * MAIN RENAMES THE CONTENTS AND STOPS. The nav is the table of contents'
   * truth and renaming the row is exactly what was asked, so that half always
   * happens; the page's heading is a SECOND statement and is only offered. It
   * used to follow automatically and silently whenever its text matched, which
   * quietly made one of the two a copy of the other — and they are allowed to
   * differ, because the text should say what the book says and the contents
   * should say what the book's apparatus says.
   *
   * The question is asked only when the heading still reads what this entry
   * used to read. Where the two already differ that is a decision somebody has
   * made about this book, and re-asking it on every rename would train a person
   * to dismiss the dialog unread.
   *
   * The tab's TITLE does not change either — that is the book's dc:title, not a
   * chapter's name, and it is the Metadata dialog's business. Returns whether
   * the rename happened, so the sidebar can keep its input open on a refusal.
   */
  async renameHeading(id: string, href: string, newLabel: string): Promise<boolean> {
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!api || !tab || tab.book === null) return false;
    const label = newLabel.trim();
    if (label.length === 0) return false;

    /*
     * THE ONE ACTION THAT WRITES TWO FILES, and the reason a ledger action is a
     * LIST of rows rather than a single one. The contents entry lives in the
     * navigation document and the heading lives in the chapter; a rename that
     * changed both has to be taken back as one gesture, or an undo would put
     * the page's heading back and leave the table of contents saying something
     * else — which is worse than either state on its own.
     *
     * `navMember` is on the book because the renderer can name every other
     * member it edits from a chapter href it is already holding, and this is
     * the exception. A book with no navigation document has none, and the
     * rename's nav half writes nothing anyway.
     */
    const bookId = tab.book.id;
    const rows: LedgerRow[] = [];
    const navMember = tab.book.navMember;
    // What the row is being renamed FROM. Read off the sidebar rather than out
    // of the file, because it is what this app has been showing the user and so
    // what an undo owes them.
    const wasLabel = tab.book.chapters.find((chapter) => chapter.href === href)?.label ?? '';

    let echo: HeadingEcho | null;
    let navChanged: boolean;
    try {
      ({ echo, navChanged } = await api.epub.renameHeading(bookId, href, label));
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    }
    if (navChanged && navMember !== null && wasLabel.length > 0) {
      rows.push({ member: navMember, target: href, field: 'nav-label', before: wasLabel, after: label });
    }

    let pageChanged = false;
    if (echo !== null) {
      const answer = await api.confirmHeadingEcho(echo);
      if (answer === 'update') {
        try {
          await api.epub.renamePageHeading(bookId, href, label, echo.was);
          pageChanged = true;
          rows.push({
            member: echo.member,
            target: href,
            field: 'page-heading',
            before: echo.was,
            after: label,
          });
        } catch (err) {
          // The contents HAS been renamed and the page has not. Said rather
          // than swallowed, because the user answered "yes" and something
          // else happened — main refuses this write when the heading moved
          // underneath the question, which is a fact about their book.
          this.notice.set(err instanceof Error ? err.message : String(err));
        }
      }
    }

    // BOTH HALVES, ONE ACTION. Whichever of the two files actually moved has a
    // row; undoing replays each rename in reverse, so a change that touched the
    // contents and the page is taken back as the one thing it was.
    this.record(id, `renamed a contents entry to "${label}"`, rows);

    const current = this.byId(id);
    if (!current || current.book === null) return true;
    const chapters = current.book.chapters.map((chapter) =>
      (chapter.href === href ? { ...chapter, label } : chapter));
    /*
     * THE REVISION IS BUMPED ONLY WHEN THE PAGE CHANGED. A bump reloads the
     * rendered pane, which is showing the chapter and not the contents — so a
     * rename that touched only the nav would cost the reader their scroll
     * position to repaint a sidebar row this line has already repainted.
     */
    this.patch(id, {
      book: { ...current.book, chapters },
      // A book with no nav at all, whose one offer was declined, has had NOTHING
      // written to it — and a tab marked edited by a question somebody answered
      // "no" to is a Save prompt with nothing behind it.
      modified: current.modified || navChanged || pageChanged,
      revision: pageChanged ? current.revision + 1 : current.revision,
    });
    return true;
  }

  /**
   * Something outside this service edited the document on disk.
   *
   * Today that is the Metadata dialog, which writes the package (or the working
   * PDF) through the engine rather than through any of the member writes above.
   * The flag it sets is the one that matters: the working copy has moved ahead
   * of whatever was last filed, so Save has work to do.
   *
   * NO REVISION BUMP, deliberately. Nothing in any chapter's markup moved, and
   * reloading the rendered pane would cost the reader their place in order to
   * repaint a page that looks identical.
   */
  noteDocumentEdited(id: string): void {
    this.patch(id, { modified: true });
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
