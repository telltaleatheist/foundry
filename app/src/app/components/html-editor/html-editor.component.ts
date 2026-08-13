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
  untracked,
  viewChild,
} from '@angular/core';

import { TabsService, type Tab } from '../../core/tabs.service';

/**
 * A chapter's XHTML, in a pane of its own.
 *
 * IT USED TO SPLIT THE BOOK'S TAB down the middle — source on the left, the
 * rendered chapter on the right, both inside app-epub-view. It is a TAB now,
 * bound to the book's tab through `sourceTabId`, and the pane rules put it
 * beside the book like any other document. The reason is the reason the panes
 * exist: a split that only ever divided one tab could not be dragged elsewhere,
 * could not be widened without narrowing the page it was there to help you fix,
 * and could not be left open beside a DIFFERENT book. One mechanism now does
 * what two did.
 *
 * A TEXTAREA AND NOT AN EDITOR COMPONENT — no syntax highlighting, no folding,
 * no block model. The whole point is to fix a stray `<em>` the model left open,
 * and the day that needs a language server is the day this becomes somebody
 * else's application.
 *
 * FLUSH IS DEBOUNCED, 700 ms after typing stops, and the book's pane reloads
 * when the flush lands. Chosen over an explicit Apply button because seeing the
 * effect of the edit IS the reason for the split, and an Apply button makes that
 * a second gesture for the thing you are already doing. The cost is that a
 * reload resets the rendered pane's scroll position — which is why the flush
 * only happens when the text actually changed, so a click into the editor and
 * back never moves the page.
 *
 * Every flush goes through main, which writes the member and REPACKS the
 * workspace copy in one call (electron/epub-reader.ts). So an edit is in a real
 * EPUB on disk within a second of being typed, and closing the tab cannot lose
 * it: the service holds this component's flush (`registerFlush`) and runs it
 * before it asks the close question, so even the last 700 ms are on disk before
 * anybody is asked anything.
 *
 * WHICH CHAPTER is the source tab's business, not this one's. The editor follows
 * the book — click a chapter over there and the source appears here, with
 * whatever was being typed flushed on the way out.
 */
@Component({
  selector: 'app-html-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (source(); as book) {
      <div class="editor">
        <header class="toolbar">
          <span class="where" [title]="book.title">
            {{ label() }}
          </span>
          <span class="state">
            @if (writing()) { Writing… }
            @else if (book.modified) { Edits are in the workspace copy }
            @else if (book.savedPath) { Saved }
          </span>
          <button class="ghost" title="Close the editor" (click)="closeEditor()">Done editing</button>
        </header>

        <textarea
          #box
          spellcheck="false"
          [value]="draft()"
          (input)="onType($event)"
          [attr.aria-label]="'HTML source of ' + (book.chapterHref ?? 'this chapter')"
        ></textarea>
      </div>
    } @else {
      <!--
        Only reachable for a frame: closing a book closes its editor in the same
        update. It says something rather than showing an empty box, because a
        blank pane with no reason on it is the failure ARCHITECTURE §8 forbids.
      -->
      <div class="problem"><p>The book this editor belonged to is closed.</p></div>
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }
    .editor { display: flex; flex-direction: column; height: 100%; }

    /* The same 44px row as the book's and the PDF's, so a pane of source does
       not read as a different application from the pane beside it. */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      height: 44px;
      padding: 0 12px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .where {
      font-size: 12px; font-weight: 500; color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 50%;
    }
    .state {
      flex: 1; min-width: 0;
      font-size: 11px; color: var(--text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    textarea {
      flex: 1;
      width: 100%;
      min-height: 0;
      resize: none;
      border: none;
      border-radius: 0;
      padding: 12px;
      background: var(--bg-sunken);
      color: var(--text-primary);
      font: 12px/1.55 var(--font-mono);
      tab-size: 2;
      white-space: pre;
      overflow: auto;
    }
    textarea:focus { outline: none; }

    .problem {
      height: 100%;
      display: flex; align-items: center; justify-content: center;
      padding: 32px;
      color: var(--text-tertiary); font-size: 13px; text-align: center;
    }

    .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 10px;
      border-radius: var(--radius-sm);
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  `],
})
export class HtmlEditorComponent implements OnDestroy {
  readonly tab = input.required<Tab>();

  private readonly tabs = inject(TabsService);

  /** The BOOK this editor is a face of. Null only while it is being closed. */
  protected readonly source = computed<Tab | null>(() => this.tabs.byId(this.tab().sourceTabId));

  /** The text in the box. Loaded from the working copy whenever the chapter changes. */
  protected readonly draft = signal('');
  protected readonly writing = computed(() => this.tabs.writingTo() === this.tab().sourceTabId);

  /** The chapter's own name, when the book's sidebar has one for it. */
  protected readonly label = computed(() => {
    const book = this.source();
    const href = book?.chapterHref ?? null;
    if (!book || href === null) return book?.title ?? '';
    return book.book?.chapters.find((chapter) => chapter.href === href)?.label ?? href;
  });

  /** The last text known to be on disk, so an unchanged flush is skipped. */
  private onDisk = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Which chapter the draft belongs to — a flush must never land on another. */
  private draftHref: string | null = null;

  private readonly area = viewChild<ElementRef<HTMLTextAreaElement>>('box');

  constructor() {
    /**
     * Load the source whenever the chapter changes under us.
     *
     * A PENDING EDIT IS FLUSHED FIRST. Clicking to the next chapter in the book's
     * pane within the debounce window would otherwise drop the last three hundred
     * milliseconds of typing on the floor, which is the one bug this whole file
     * exists to not have.
     */
    effect(() => {
      const book = this.source();
      const href = book?.chapterHref ?? null;
      if (!book || href === null || book.book === null) return;
      if (href === this.draftHref) return;
      const pending = this.draftHref;
      this.draftHref = href;
      // `untracked`, because both of these READ the draft — and an effect that
      // depends on the draft is an effect that re-runs on every keystroke. The
      // chapter is the only thing this is allowed to watch.
      untracked(() => {
        if (pending !== null) void this.flushNow(pending);
        void this.load(book, href);
      });
    });

    /**
     * A click in the rendered chapter, arriving from the book's pane.
     *
     * The jump is claimed only if it names THIS editor's book: two editors on
     * two books are two panes watching the same signal, and a click in one book
     * must not move the caret in the other's source.
     */
    effect(() => {
      const jump = this.tabs.sourceJump();
      if (jump === null || jump.tabId !== this.tab().sourceTabId) return;
      // Untracked for the same reason as above: the jump READS the draft to
      // count elements in it, and a caret that moved every time a character
      // was typed would be unusable.
      untracked(() => { this.jumpToBlock(jump.bf, jump.tag, jump.index); });
    });

    // The service runs this before it asks any question about closing — see
    // TabsService.close. Registered by effect rather than in the constructor
    // because the tab's id is an input and inputs are not readable this early.
    effect(() => {
      this.tabs.registerFlush(this.tab().id, () => this.flushPending());
    });
  }

  ngOnDestroy(): void {
    this.tabs.unregisterFlush(this.tab().id);
    // The tab is closing or the pane is being replaced. Whatever is in the box
    // goes to disk now — an unmounted component cannot fire its own timer.
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.draftHref !== null) void this.flushNow(this.draftHref);
  }

  protected closeEditor(): void {
    void this.tabs.close(this.tab().id);
  }

  /**
   * Put the caret on the block the rendered page reported, Calibre-style.
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
    const area = this.area()?.nativeElement;
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

  protected onType(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    this.draft.set(target.value);
    if (this.timer !== null) clearTimeout(this.timer);
    const href = this.draftHref;
    if (href === null) return;
    this.timer = setTimeout(() => { void this.flushNow(href); }, FLUSH_DELAY_MS);
  }

  private async load(book: Tab, href: string): Promise<void> {
    const text = await this.tabs.chapterSource(book, href);
    this.onDisk = text;
    this.draft.set(text);
  }

  /** What the service calls before it closes anything: the box, on disk, now. */
  private async flushPending(): Promise<void> {
    if (this.draftHref === null) return;
    await this.flushNow(this.draftHref);
  }

  /**
   * Write the draft, unless it is already what is on disk.
   *
   * The equality check is not an optimisation. A flush bumps the book tab's
   * revision, which reloads the rendered pane and sends it back to the top;
   * skipping the no-op keeps a click into the editor from scrolling the reader.
   */
  private async flushNow(href: string): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const text = this.draft();
    if (text === this.onDisk) return;
    const bookId = this.tab().sourceTabId;
    if (bookId === null) return;
    this.onDisk = text;
    await this.tabs.writeChapter(bookId, href, text);
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
