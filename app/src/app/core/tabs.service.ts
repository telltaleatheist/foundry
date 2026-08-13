import { Injectable, computed, effect, inject, signal } from '@angular/core';

import type { EpubBook, JobKind } from '@shared/types';

import { QueueService } from './queue.service';
import { api } from './foundry';

/**
 * The open documents — Chrome-style tabs, and the one place that knows which is
 * which.
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
 * The workspace is one to five PANES side by side, each with its own strip and
 * its own active tab — VS Code's editor groups. It exists for one comparison in
 * particular: a book beside its translation, the German page and the English
 * page under two hands at once. Everything else about panes follows from that,
 * including the auto-open rule (a finished job lands in a pane of its OWN, so a
 * translation appears beside its source rather than on top of it).
 *
 * THE TABS STAY IN ONE FLAT LIST and the panes hold ids into it. A pane owning
 * whole Tab objects would put `patch()` — the one function every edit, save and
 * flag in this file goes through — behind a search of a list of lists, and the
 * first thing to rot would be an edit landing in one pane's copy of a tab while
 * another pane showed the other. One list, one identity per tab; the panes
 * decide only where each is shown.
 *
 * ONE PANE IS FOCUSED, and it is what the rail, the menu and the keyboard mean
 * by "the document": `active()` is the focused pane's active tab and nothing
 * else. With a single pane open, that is exactly the app that existed before
 * panes did — the feature is meant to be invisible until it is used.
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
 * A column of the workspace: its own strip, its own active tab.
 *
 * `activeTabId` of null means this pane is showing HOME — which is what a pane
 * with no tab active has always shown, back when there was only ever one.
 */
export interface Pane {
  id: string;
  /** The strip's order, left to right. Ids into the flat tab list. */
  tabIds: readonly string[];
  activeTabId: string | null;
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
 * a finished job joins the rightmost pane instead of narrowing everything.
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

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly queue = inject(QueueService);

  private readonly all = signal<Tab[]>([]);
  private readonly columns = signal<Pane[]>([]);
  private readonly focused = signal<string | null>(null);

  /** Every open tab, in no particular order — the panes carry the order. */
  readonly tabs = this.all.asReadonly();
  readonly panes = this.columns.asReadonly();
  readonly focusedPaneId = this.focused.asReadonly();

  readonly focusedPane = computed<Pane | null>(() =>
    this.columns().find((pane) => pane.id === this.focused()) ?? null);

  /** Null means Home — which is also what "no panes open at all" looks like. */
  readonly activeId = computed<string | null>(() => this.focusedPane()?.activeTabId ?? null);
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
    } catch (err) {
      this.patch(id, { problem: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Panes ────────────────────────────────────────────────────────────────

  /** Every tab in a pane, in the pane's own order. Missing ids cannot happen; they are dropped anyway. */
  tabsIn(paneId: string): Tab[] {
    const pane = this.columns().find((candidate) => candidate.id === paneId);
    if (!pane) return [];
    const tabs = this.all();
    return pane.tabIds
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is Tab => tab !== undefined);
  }

  byId(id: string | null): Tab | null {
    if (id === null) return null;
    return this.all().find((tab) => tab.id === id) ?? null;
  }

  paneOf(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.tabIds.includes(tabId)) ?? null;
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
   * Put a tab in a pane and give it the focus.
   *
   * The first document makes the first pane. After that: a finished job asks
   * for one of its own (up to the cap, past which it joins the rightmost), and
   * everything else — a drop, Home's list, the shelf's Open — joins the pane
   * the user is working in, because they aimed at it.
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
      ? panes[panes.length - 1]!
      : (this.focusedPane() ?? panes[panes.length - 1]!);
    this.columns.set(panes.map((pane) => (pane.id === target.id
      ? { ...pane, tabIds: [...pane.tabIds, tabId], activeTabId: tabId }
      : pane)));
    this.focused.set(target.id);
  }

  private makePane(tabId: string): Pane {
    this.paneSequence += 1;
    return { id: `pane-${this.paneSequence}`, tabIds: [tabId], activeTabId: tabId, flex: 1 };
  }

  /** Show a tab: focus its pane, make it that pane's active one. */
  reveal(tabId: string): void {
    const pane = this.paneOf(tabId);
    if (!pane) return;
    this.columns.update((panes) => panes.map((candidate) =>
      (candidate.id === pane.id ? { ...candidate, activeTabId: tabId } : candidate)));
    this.focused.set(pane.id);
  }

  /**
   * Move a tab into a pane — the drag between two strips, and a reorder within
   * one, which are the same operation with the same two ends.
   *
   * `beforeTabId` names the tab it lands in front of; null means the end. A
   * source pane left empty goes with it, on the same rule as closing the last
   * tab in one.
   */
  moveTab(tabId: string, targetPaneId: string, beforeTabId: string | null = null): void {
    if (tabId === beforeTabId) return;
    const panes = this.columns();
    const owner = panes.find((pane) => pane.tabIds.includes(tabId));
    if (!owner || !panes.some((pane) => pane.id === targetPaneId)) return;

    const at = owner.tabIds.indexOf(tabId);
    const lifted = panes.map((pane) => {
      if (pane.id !== owner.id) return pane;
      const tabIds = pane.tabIds.filter((id) => id !== tabId);
      // The pane it LEFT keeps showing something: the tab that took its place.
      // (Unless it is also the destination, in which case the move below sets it.)
      const activeTabId = pane.id === targetPaneId || pane.activeTabId !== tabId
        ? pane.activeTabId
        : tabIds[Math.min(at, tabIds.length - 1)] ?? null;
      return { ...pane, tabIds, activeTabId };
    });

    const dropped = lifted.map((pane) => {
      if (pane.id !== targetPaneId) return pane;
      const before = beforeTabId === null ? -1 : pane.tabIds.indexOf(beforeTabId);
      const index = before < 0 ? pane.tabIds.length : before;
      return {
        ...pane,
        tabIds: [...pane.tabIds.slice(0, index), tabId, ...pane.tabIds.slice(index)],
        activeTabId: tabId,
      };
    });

    this.columns.set(dropped.filter((pane) => pane.tabIds.length > 0));
    this.focused.set(targetPaneId);
  }

  /**
   * Open this tab in a new pane to its right — the split.
   *
   * It MOVES rather than copies: two panes onto one tab would be two viewers
   * over one document, which is the thing `adopt` refuses to make by hand. A
   * pane holding only this tab splits into nothing.
   *
   * BOTH REFUSALS ARE SAID. This is reachable from a menu item and a keyboard
   * chord, neither of which can grey itself out per-pane, so the two ways it
   * cannot happen have to arrive as sentences — a Ctrl+\ that silently does
   * nothing is indistinguishable from a Ctrl+\ that is broken.
   */
  splitRight(tabId: string): void {
    const panes = this.columns();
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const owner = panes.find((pane) => pane.tabIds.includes(tabId));
    if (!owner) return;
    if (owner.tabIds.length < 2) {
      this.notice.set('Splitting moves a tab into a column of its own — this one has nothing else in it.');
      return;
    }

    const at = owner.tabIds.indexOf(tabId);
    const tabIds = owner.tabIds.filter((id) => id !== tabId);
    const stripped: Pane = {
      ...owner,
      tabIds,
      activeTabId: owner.activeTabId === tabId
        ? tabIds[Math.min(at, tabIds.length - 1)] ?? null
        : owner.activeTabId,
    };
    const fresh = this.makePane(tabId);

    const next: Pane[] = [];
    for (const pane of panes) {
      if (pane.id !== owner.id) { next.push(pane); continue; }
      next.push(stripped, fresh);
    }
    this.columns.set(equalise(next));
    this.focused.set(fresh.id);
  }

  splitActive(): void {
    const id = this.activeId();
    if (id === null) {
      this.notice.set('There is no document here to put in a column of its own.');
      return;
    }
    this.splitRight(id);
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

  /** Clicking a tab in a strip. Focuses that pane too — a click is an aim. */
  activate(tabId: string): void {
    this.reveal(tabId);
  }

  /** The rail's Home. Home is "no tab is active in this pane", not a tab of its own. */
  goHome(): void {
    const pane = this.focusedPane();
    if (!pane) return;
    this.columns.update((panes) => panes.map((candidate) =>
      (candidate.id === pane.id ? { ...candidate, activeTabId: null } : candidate)));
  }

  showChapter(id: string, href: string): void {
    this.patch(id, { chapterHref: href });
  }

  /** Ctrl/Cmd+Tab. Cycles the FOCUSED pane's strip, wraps, no-ops on an empty app. */
  nextTab(): void {
    const pane = this.focusedPane();
    if (!pane || pane.tabIds.length === 0) return;
    const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
    const next = pane.tabIds[(at + 1) % pane.tabIds.length];
    if (next !== undefined) this.reveal(next);
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
    for (const gone of going) this.pendingFlush.delete(gone);
    this.dropFromPanes(going);
  }

  /**
   * Take closed tabs out of their panes, and take out any pane they emptied.
   *
   * The replacement active tab is the neighbour, the way a browser does it: the
   * tab that took its place, or the new last one. A pane with nothing left goes
   * entirely, and the focus lands on the pane that took ITS place — the same
   * rule one level up.
   */
  private dropFromPanes(going: ReadonlySet<string>): void {
    const panes = this.columns();
    const kept: Pane[] = [];
    let focusAt = -1;
    for (const pane of panes) {
      const tabIds = pane.tabIds.filter((tabId) => !going.has(tabId));
      if (tabIds.length === 0) {
        if (pane.id === this.focused()) focusAt = kept.length;
        continue;
      }
      const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
      const activeTabId = pane.activeTabId !== null && going.has(pane.activeTabId)
        ? tabIds[Math.min(at, tabIds.length - 1)] ?? null
        : pane.activeTabId;
      kept.push({ ...pane, tabIds, activeTabId });
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
   * editor is stacked on top of the book in the same column.
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
    // The editor is no use if it is behind another tab in its own pane.
    this.reveal(editor.id);
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
   */
  async writeChapter(id: string, href: string, text: string): Promise<void> {
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!api || !tab || tab.book === null) return;
    this.writingTo.set(id);
    try {
      await api.epub.writeMember(tab.book.id, memberOf(href), text);
      this.patch(id, { modified: true, revision: tab.revision + 1 });
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
