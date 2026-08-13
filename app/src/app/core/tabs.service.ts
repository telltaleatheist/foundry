import { Injectable, computed, effect, inject, signal } from '@angular/core';

import type { EpubBook } from '@shared/types';

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
 */

export type TabKind = 'pdf' | 'epub';

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
  /** True while the split HTML editor is open beside the rendered chapter. EPUB only. */
  editing: boolean;
  /**
   * True while the PDF viewer is showing the text layer beside the page.
   *
   * On the TAB rather than in the component, for the same reason `editing` is:
   * only the active tab's viewer is in the DOM, so a component that held this
   * would forget it the moment the user looked at something else. A view mode
   * that resets itself when you glance away is a view mode you stop using.
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
   * protocol handler ignores.
   */
  revision: number;
  /** Why this tab has nothing in it, when that happens. Never swallowed. */
  problem: string | null;
}

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly queue = inject(QueueService);

  private readonly all = signal<Tab[]>([]);
  private readonly current = signal<string | null>(null);

  readonly tabs = this.all.asReadonly();
  /** Null means Home — which is also what "no tabs open" looks like. */
  readonly activeId = this.current.asReadonly();
  readonly active = computed(() => this.all().find((tab) => tab.id === this.current()) ?? null);

  /**
   * The last thing that went wrong out here rather than inside a tab: a drop
   * this app will not open, a save that failed. Shown as a strip under the tabs
   * and dismissed by hand — a refusal that vanished on a timer is a refusal the
   * user gets to wonder about.
   */
  readonly notice = signal<string | null>(null);

  /**
   * Paths that will arrive as UNSAVED tabs: a conversion's output, or a
   * workspace book re-opened from Home.
   *
   * A set consulted on the way in, rather than a flag on the open call, because
   * the open call and the tab's creation are on opposite sides of an IPC round
   * trip through main.
   */
  private readonly expectUnsaved = new Set<string>();

  /** Conversions already turned into a tab, so a queue push cannot open a second. */
  private readonly openedJobs = new Set<string>();

  private sequence = 0;

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
     * Jobs already finished when this window loaded are marked as seen without
     * opening: a reload should not reopen five books somebody closed.
     */
    let first = true;
    effect(() => {
      const jobs = this.queue.jobs();
      for (const job of jobs) {
        if ((job.kind !== 'epub' && job.kind !== 'pdf') || job.state !== 'done') continue;
        if (this.openedJobs.has(job.id)) continue;
        this.openedJobs.add(job.id);
        if (first) continue;
        this.openManaged(job.outputPath);
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
    if (managed) this.expectUnsaved.add(normalise(filePath));
    const admitted = await api.openPath(filePath);
    if (admitted === null) {
      this.expectUnsaved.delete(normalise(filePath));
      this.notice.set(`${filePath} is no longer there.`);
    }
  }

  /** A book that is still only in the workspace — it opens with the dot on. */
  private openManaged(filePath: string): void {
    void this.openFile(filePath, true);
  }

  /**
   * The single tab factory. Focuses an existing tab for the same file rather
   * than opening a second — two tabs onto one book are two scroll positions
   * fighting over one document.
   */
  private adopt(absolutePath: string): void {
    const key = normalise(absolutePath);
    const existing = this.all().find((tab) => normalise(tab.path) === key);
    if (existing) {
      this.current.set(existing.id);
      return;
    }

    this.sequence += 1;
    const id = `tab-${this.sequence}`;
    const kind: TabKind = key.endsWith('.epub') ? 'epub' : 'pdf';
    const unsaved = this.expectUnsaved.delete(key);
    const tab: Tab = {
      id,
      kind,
      path: absolutePath,
      title: baseName(absolutePath),
      unsaved,
      modified: false,
      savedPath: null,
      book: null,
      chapterHref: null,
      editing: false,
      layerView: false,
      thumbnails: true,
      revision: 0,
      problem: null,
    };
    this.all.update((tabs) => [...tabs, tab]);
    this.current.set(id);
    if (kind === 'epub') void this.unpack(id, absolutePath);
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

  // ── Living with them ─────────────────────────────────────────────────────

  activate(id: string | null): void {
    this.current.set(id);
  }

  /** The rail's Home. Home is "no tab is active", not a tab of its own. */
  goHome(): void {
    this.current.set(null);
  }

  showChapter(id: string, href: string): void {
    this.patch(id, { chapterHref: href });
  }

  /** Ctrl/Cmd+Tab. Wraps, and does nothing sensible with none open — so it does nothing. */
  nextTab(): void {
    const tabs = this.all();
    if (tabs.length === 0) return;
    const at = tabs.findIndex((tab) => tab.id === this.current());
    const next = tabs[(at + 1) % tabs.length];
    if (next) this.current.set(next.id);
  }

  /**
   * Close a tab, warning first when it is the only copy anywhere the user chose.
   *
   * The warning is main's native box (it is modal to the window, and every other
   * dialog in this app is main's). The book is NOT deleted either way — see
   * electron/workspace.ts — so the question is only whether they meant to stop
   * tracking it.
   */
  async close(id: string): Promise<void> {
    const doomed = this.all().find((candidate) => candidate.id === id);
    if (!doomed) return;
    if ((doomed.unsaved || doomed.modified) && api) {
      const go = await api.confirmClose({
        title: doomed.title,
        unsaved: doomed.unsaved,
        modified: doomed.modified,
        savedPath: doomed.savedPath,
      });
      if (!go) return;
    }
    // The list is re-read AFTER the dialog: that box is modal to the window but
    // not to the app, and a conversion can finish and open a tab while it is up.
    const tabs = this.all();
    const at = tabs.findIndex((candidate) => candidate.id === id);
    if (at < 0) return;

    // The temp directory the chapters were served from goes with the tab. Not
    // awaited: the tab must close now, and a %TEMP% removal that loses a race
    // with the iframe's last read is retried on quit.
    if (doomed.book && api) void api.epub.close(doomed.book.id);

    const remaining = tabs.filter((candidate) => candidate.id !== id);
    this.all.set(remaining);
    if (this.current() !== id) return;
    // The neighbour, the way a browser does it: the tab that took its place, or
    // the new last one, or Home.
    this.current.set(remaining[Math.min(at, remaining.length - 1)]?.id ?? null);
  }

  async closeActive(): Promise<void> {
    const tab = this.active();
    if (tab) await this.close(tab.id);
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  toggleEditing(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, editing: !tab.editing } : tab)));
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
   * reloading it before the bytes landed would show the previous version.
   */
  async writeChapter(id: string, href: string, text: string): Promise<void> {
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!api || !tab || tab.book === null) return;
    try {
      await api.epub.writeMember(tab.book.id, memberOf(href), text);
      this.patch(id, { modified: true, revision: tab.revision + 1 });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
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
  async saveActive(): Promise<void> {
    const tab = this.active();
    if (!tab) return;
    if (tab.kind === 'pdf' || tab.savedPath === null) {
      await this.saveActiveAs();
      return;
    }
    await this.writeBook(tab, tab.savedPath);
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
  async saveActiveAs(): Promise<void> {
    const tab = this.active();
    if (!api || !tab) return;
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
    const chosen = await api.epub.chooseSavePath(tab.book.id, suggestName(tab.title, '.epub'));
    if (chosen === null) return;
    await this.writeBook(tab, chosen);
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
