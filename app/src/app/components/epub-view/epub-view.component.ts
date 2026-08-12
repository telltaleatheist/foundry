import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

import type { EpubChapter } from '@shared/types';

import { TabsService, type Tab } from '../../core/tabs.service';

/**
 * The book — a chapter list, the chapter, and the chapter's HTML beside it.
 *
 * SCROLLING TEXT, NO PAGINATION, and that is a decision rather than an omission.
 * Pagination in a reflowable book means measuring the rendered text and cutting
 * it into columns, which means reaching into the iframe's document — and the
 * iframe is sandboxed precisely so that nothing reaches into it. A book you can
 * scroll and search with Ctrl+F is a book you can read; the page-turn can come
 * when there is a reason for it beyond resembling other readers.
 *
 * ── Editing ──────────────────────────────────────────────────────────────────
 *
 * "Edit HTML" splits the pane: the chapter's source on the left in a textarea,
 * the rendered chapter on the right. A textarea and not an editor component —
 * no syntax highlighting, no folding, no block model. The whole point is to fix
 * a stray `<em>` the model left open, and the day that needs a language server
 * is the day this becomes somebody else's application.
 *
 * FLUSH IS DEBOUNCED, 700 ms after typing stops, and the rendered pane reloads
 * when the flush lands. Chosen over an explicit Apply button because seeing the
 * effect of the edit IS the reason for the split view, and an Apply button makes
 * that a second gesture for the thing you are already doing. The cost is that a
 * reload resets the rendered pane's scroll position — which is why the flush
 * only happens when the text actually changed, so a click into the editor and
 * back never moves the page.
 *
 * Every flush goes through main, which writes the member and REPACKS the
 * workspace copy in one call (electron/epub-reader.ts). So an edit is in a real
 * EPUB on disk within a second of being typed, and closing the tab cannot lose
 * it — the close warning says exactly that.
 *
 * The chapter comes out of the main process through `foundry-file://epub/…`
 * (electron/main.ts) into an iframe with `sandbox="allow-scripts"` — and ONLY
 * that token, never allow-same-origin: the frame keeps an opaque origin, no
 * storage, no reach into this page. The one script that can actually execute in
 * there is main's own click reporter (electron/click-reporter.ts documents the
 * serve-time sanitization that keeps a book's own scripts dead), and its whole
 * output is a postMessage naming the block that was clicked. This component checks the
 * SOURCE of every message — only its own iframe's window is listened to — and
 * uses it for one thing: jumping the editor to that block, Calibre-style.
 * Foundry wrote these books, but the user is free to open one it did not, and a
 * book is ultimately somebody else's markup.
 *
 * The URL is bypassed through the sanitizer because Angular strips any resource
 * URL on a scheme it does not know, and `foundry-file:` is ours by construction:
 * every one of these was built by main out of a book main itself unpacked.
 */
@Component({
  selector: 'app-epub-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tab().problem; as reason) {
      <div class="problem">
        <h1>This book would not open</h1>
        <p>{{ reason }}</p>
      </div>
    } @else if (tab().book; as book) {
      <div class="book">
        <nav class="chapters">
          <header>
            <span class="book-title" [title]="book.title">{{ book.title }}</span>
            @if (book.author) { <span class="book-author">{{ book.author }}</span> }
          </header>
          <ul>
            @for (chapter of book.chapters; track chapter.href) {
              <li class="entry">
                @if (renamingHref() === chapter.href) {
                  <input
                    #renameBox
                    class="rename"
                    [style.margin-left.px]="12 + chapter.depth * 14"
                    [value]="renameText()"
                    (input)="renameText.set(renameBox.value)"
                    (keydown.enter)="commitRename(chapter)"
                    (keydown.escape)="cancelRename()"
                    (blur)="cancelRename()"
                    [attr.aria-label]="'Rename ' + chapter.label"
                  >
                } @else {
                  <button
                    class="chapter"
                    [class.active]="tab().chapterHref === chapter.href"
                    [style.padding-left.px]="12 + chapter.depth * 14"
                    [title]="chapter.label"
                    (click)="show(chapter)"
                    (dblclick)="startRename(chapter)"
                  >{{ chapter.label }}</button>
                  <button class="pencil" title="Rename" (click)="startRename(chapter)">✎</button>
                }
              </li>
            }
          </ul>
        </nav>

        <div class="reading">
          <header class="toolbar">
            <button class="ghost" [class.on]="tab().editing" (click)="tabs.toggleEditing(tab().id)">
              {{ tab().editing ? 'Done editing' : 'Edit HTML' }}
            </button>
            <span class="state">
              @if (flushing()) { Writing… }
              @else if (tab().modified) { Edits are in the workspace copy }
              @else if (tab().savedPath) { Saved }
            </span>
            <button class="primary" (click)="tabs.saveActive()">
              {{ tab().savedPath === null ? 'Save…' : 'Save' }}
            </button>
          </header>

          <div class="panes" [class.split]="tab().editing">
            @if (tab().editing) {
              <div class="editor">
                <textarea
                  #source
                  spellcheck="false"
                  [value]="draft()"
                  (input)="onType($event)"
                  [attr.aria-label]="'HTML source of ' + (tab().chapterHref ?? 'this chapter')"
                ></textarea>
              </div>
            }

            @if (chapterUrl(); as url) {
              <!--
                sandbox="allow-scripts" and nothing else: opaque origin, no
                same-origin power. The only script that can execute is main's
                click reporter (serve-time sanitization kills a book's own),
                and its postMessage is what makes click-to-source work.
              -->
              <iframe
                #frame
                class="page"
                [src]="url"
                sandbox="allow-scripts"
                [title]="tab().chapterHref ?? book.title"
              ></iframe>
            } @else {
              <div class="problem"><p>This book has no chapters in its spine.</p></div>
            }
          </div>
        </div>
      </div>
    } @else {
      <div class="problem"><p>Unpacking…</p></div>
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }

    .book { display: flex; height: 100%; }

    .chapters {
      width: 260px;
      min-width: 260px;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-subtle);
    }
    .chapters header {
      display: flex; flex-direction: column; gap: 2px;
      padding: 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .book-title { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .book-author { font-size: 11px; color: var(--text-tertiary); }

    .chapters ul { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; }

    .entry { display: flex; align-items: center; }
    .pencil {
      flex-shrink: 0;
      visibility: hidden;
      margin-right: 6px;
      padding: 2px 5px;
      background: transparent; border: none; border-radius: 4px;
      color: var(--text-tertiary); font-size: 11px; cursor: pointer;
    }
    .entry:hover .pencil { visibility: visible; }
    .pencil:hover { color: var(--text-primary); background: var(--bg-hover); }
    .rename {
      flex: 1;
      min-width: 0;
      margin: 2px 8px 2px 0;
      padding: 4px 6px;
      background: var(--bg-base);
      color: var(--text-primary);
      border: 1px solid var(--accent);
      border-radius: 4px;
      font-size: 12.5px;
    }
    .rename:focus { outline: none; }

    .chapter {
      display: block;
      flex: 1;
      min-width: 0;
      padding: 7px 12px;
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text-secondary);
      font-size: 12.5px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .chapter:hover { background: var(--bg-hover); color: var(--text-primary); }
    .chapter.active {
      background: var(--accent-soft);
      border-left-color: var(--accent);
      color: var(--text-primary);
    }

    .reading { flex: 1; min-width: 0; display: flex; flex-direction: column; }

    .toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 12px;
      background: var(--bg-base);
      border-bottom: 1px solid var(--border-subtle);
    }
    .state { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .panes { flex: 1; min-height: 0; display: flex; }
    .panes.split .editor { flex: 1 1 50%; min-width: 0; }
    .panes.split .page { flex: 1 1 50%; }

    .editor { display: flex; border-right: 1px solid var(--border-default); }
    .editor textarea {
      flex: 1;
      width: 100%;
      height: 100%;
      resize: none;
      border: none;
      border-radius: 0;
      padding: 12px;
      background: var(--bg-sunken);
      color: var(--text-primary);
      font: 12.5px/1.55 ui-monospace, 'Cascadia Mono', Consolas, monospace;
      tab-size: 2;
      white-space: pre;
      overflow: auto;
    }
    .editor textarea:focus { outline: none; }

    /* White, because a book is white. The chrome around it is the dark part. */
    .page { flex: 1; min-width: 0; height: 100%; border: none; display: block; background: #fff; }

    .problem {
      flex: 1;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; padding: 32px;
      color: var(--text-tertiary); text-align: center;
    }
    .problem h1 { margin: 0; font-size: 16px; font-weight: 600; color: var(--error); }
    .problem p { margin: 0; font-size: 13px; max-width: 60ch; white-space: pre-wrap; }

    .ghost {
      padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
      background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    }
    .ghost:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
    .ghost.on { background: var(--accent-soft); border-color: var(--accent); color: var(--text-primary); }
    .primary {
      padding: 5px 14px; border-radius: 6px; cursor: pointer; font-size: 12px;
      border: 1px solid var(--accent); background: var(--accent-soft); color: var(--text-primary);
    }
    .primary:hover { background: var(--accent); color: #16181c; }
  `],
})
export class EpubViewComponent implements OnDestroy {
  readonly tab = input.required<Tab>();

  protected readonly tabs = inject(TabsService);
  private readonly sanitizer = inject(DomSanitizer);

  /** The text in the box. Loaded from the working copy whenever the chapter changes. */
  protected readonly draft = signal('');
  protected readonly flushing = signal(false);

  /** The last text known to be on disk, so an unchanged flush is skipped. */
  private onDisk = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Which chapter the draft belongs to — a flush must never land on another. */
  private draftHref: string | null = null;

  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly sourceArea = viewChild<ElementRef<HTMLTextAreaElement>>('source');
  private readonly renameBox = viewChild<ElementRef<HTMLInputElement>>('renameBox');

  /** Which sidebar row is being renamed, and the text in its box. */
  protected readonly renamingHref = signal<string | null>(null);
  protected readonly renameText = signal('');

  /**
   * The click reporter's messages. Bound once so add/removeEventListener see
   * the same function, and gated hard: only THIS component's iframe is
   * listened to (event.source), only the expected shape is read, and only
   * while the editor is open — reading stays reading.
   */
  private readonly onFrameMessage = (event: MessageEvent): void => {
    const frame = this.frame()?.nativeElement;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; bf?: unknown; tag?: unknown; index?: unknown } | null;
    if (!data || data.type !== 'foundry:block-click') return;
    if (typeof data.tag !== 'string' || !/^[a-z][a-z0-9]*$/.test(data.tag)) return;
    if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0) return;
    if (!this.tab().editing) return;
    this.jumpToBlock(data.bf === true, data.tag, data.index);
  };

  constructor() {
    /**
     * Load the source whenever the editor opens or the chapter changes.
     *
     * A PENDING EDIT IS FLUSHED FIRST. Clicking to the next chapter within the
     * debounce window would otherwise drop the last three hundred milliseconds
     * of typing on the floor, which is the one bug this whole file exists to
     * not have.
     */
    effect(() => {
      const current = this.tab();
      const href = current.chapterHref;
      if (!current.editing) {
        // Closing the editor flushes and FORGETS which chapter the draft was
        // for, so reopening it on the same chapter loads the file again rather
        // than believing a draft that is now however old.
        const pending = this.draftHref;
        this.draftHref = null;
        if (pending !== null) void this.flushNow(pending);
        return;
      }
      if (href === null || current.book === null) return;
      if (href === this.draftHref) return;
      const pending = this.draftHref;
      this.draftHref = href;
      if (pending !== null) void this.flushNow(pending);
      void this.load(current, href);
    });

    window.addEventListener('message', this.onFrameMessage);

    // The rename input exists only while a row is being renamed; the moment it
    // renders, the whole current label is selected so typing replaces it.
    effect(() => {
      const box = this.renameBox()?.nativeElement;
      if (box) {
        box.focus();
        box.select();
      }
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onFrameMessage);
    // The tab is closing or the view is being replaced. Whatever is in the box
    // goes to disk now — an unmounted component cannot fire its own timer.
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.draftHref !== null) void this.flushNow(this.draftHref);
  }

  /**
   * Put the editor's caret on the block the reporter named, Calibre-style.
   *
   * The mapping is COUNTING, not parsing: the reporter sends the block's index
   * in document order — among `data-bf-page` blocks when it was one, among
   * same-tag elements otherwise — and this counts the same class of match in
   * the source text, which is in the same order because the DOM was parsed
   * from it. If the source has fewer matches than the index asks for (an edit
   * mid-flight, markup the regex reads differently), NOTHING happens: a jump
   * to the wrong block teaches the user the feature lies, and no jump just
   * teaches them to click again.
   */
  private jumpToBlock(bf: boolean, tag: string, index: number): void {
    const area = this.sourceArea()?.nativeElement;
    if (!area) return;
    const text = this.draft();
    const pattern = bf
      ? /<[^>]*\bdata-bf-page\b/g
      : new RegExp(`<${tag}(?=[\\s>/])`, 'gi');
    let match: RegExpExecArray | null = null;
    for (let n = 0; n <= index; n += 1) {
      match = pattern.exec(text);
      if (match === null) return;
    }
    if (match === null) return;

    const start = match.index;
    const closing = text.indexOf('>', start);
    area.focus();
    area.setSelectionRange(start, closing >= 0 ? closing + 1 : start);

    // A textarea does not scroll to its own selection: the line is computed by
    // counting newlines and the pane is scrolled so the block sits a third of
    // the way down — visible, with its context above and below.
    let line = 0;
    for (let at = text.indexOf('\n'); at >= 0 && at < start; at = text.indexOf('\n', at + 1)) {
      line += 1;
    }
    const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 19;
    area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 3);
  }

  protected readonly chapterUrl = computed<SafeResourceUrl | null>(() => {
    const current = this.tab();
    const chapter = current.book?.chapters.find((entry) => entry.href === current.chapterHref);
    if (chapter === undefined) return null;
    // `?v=` is what makes an edit visible: the bytes changed and the URL did
    // not, and an <iframe> already showing a URL does nothing when told to show
    // it again. The protocol handler reads the path and ignores the query. A
    // section-header row's url carries a #fragment, and the query has to go
    // BEFORE it — `file#frag?v=2` is a fragment named "frag?v=2".
    const [base, fragment] = chapter.url.split('#');
    const url = current.revision === 0
      ? chapter.url
      : `${base}?v=${current.revision}${fragment !== undefined ? `#${fragment}` : ''}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  protected show(chapter: EpubChapter): void {
    this.tabs.showChapter(this.tab().id, chapter.href);
  }

  // ── Renaming a TOC entry ─────────────────────────────────────────────────

  protected startRename(chapter: EpubChapter): void {
    this.renameText.set(chapter.label);
    this.renamingHref.set(chapter.href);
  }

  protected cancelRename(): void {
    this.renamingHref.set(null);
  }

  /**
   * Enter. An empty or unchanged label is a cancel, not an error — and the box
   * closes BEFORE the IPC round trip so a slow disk never shows a stale input.
   * A refusal (main found nothing carrying the entry) lands in the notice
   * strip via TabsService.
   */
  protected async commitRename(chapter: EpubChapter): Promise<void> {
    const label = this.renameText().trim();
    this.renamingHref.set(null);
    if (label.length === 0 || label === chapter.label) return;
    await this.tabs.renameHeading(this.tab().id, chapter.href, label);
  }

  protected onType(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    this.draft.set(target.value);
    if (this.timer !== null) clearTimeout(this.timer);
    const href = this.draftHref;
    if (href === null) return;
    this.timer = setTimeout(() => { void this.flushNow(href); }, FLUSH_DELAY_MS);
  }

  private async load(tab: Tab, href: string): Promise<void> {
    const text = await this.tabs.chapterSource(tab, href);
    this.onDisk = text;
    this.draft.set(text);
  }

  /**
   * Write the draft, unless it is already what is on disk.
   *
   * The equality check is not an optimisation. A flush bumps the tab's revision,
   * which reloads the rendered pane and sends it back to the top; skipping the
   * no-op keeps a click into the editor from scrolling the reader.
   */
  private async flushNow(href: string): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const text = this.draft();
    if (text === this.onDisk) return;
    this.onDisk = text;
    this.flushing.set(true);
    try {
      await this.tabs.writeChapter(this.tab().id, href, text);
    } finally {
      this.flushing.set(false);
    }
  }
}

/**
 * How long after the last keystroke the chapter is written.
 *
 * Long enough that a sentence is one write rather than forty, short enough that
 * the rendered pane feels like it is following along. Each write repacks the
 * whole book, which for a few hundred kilobytes of XHTML is milliseconds — the
 * delay is about the reader's eye, not about the disk.
 */
const FLUSH_DELAY_MS = 700;
