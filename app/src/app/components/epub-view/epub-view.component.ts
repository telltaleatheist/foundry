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
 * The book — a chapter list and the chapter.
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
 * "Edit HTML" USED TO SPLIT THIS COMPONENT down the middle: a textarea on the
 * left, the rendered chapter on the right, one tab holding both. It opens a TAB
 * now (app-html-editor), which the pane rules place beside the book — so the
 * source can be widened without narrowing the page it is there to fix, and the
 * book can be read with the editor closed without the tab remembering a mode.
 * The button below is a toggle over that tab: press it again and the editor
 * closes. All the writing, debouncing and flushing moved with it; what stays
 * here is the book.
 *
 * The chapter comes out of the main process through `foundry-file://epub/…`
 * (electron/main.ts) into an iframe with `sandbox="allow-scripts"` — and ONLY
 * that token, never allow-same-origin: the frame keeps an opaque origin, no
 * storage, no reach into this page. The one script that can actually execute in
 * there is main's own click reporter (electron/click-reporter.ts documents the
 * serve-time sanitization that keeps a book's own scripts dead), and its whole
 * output is a postMessage naming the block that was clicked. This component checks the
 * SOURCE of every message — only its own iframe's window is listened to — and
 * hands it to the service, which is where the editor (a pane away now) picks it
 * up and jumps to the block, Calibre-style. Foundry wrote these books, but the
 * user is free to open one it did not, and a book is ultimately somebody else's
 * markup.
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
            <!-- WHAT THIS COLUMN IS SHOWING, and it is here because nothing else
                 says it any more: the Chrome-style strip that used to sit above
                 this row is gone, and with five columns open a person needs to
                 read the title off the pane rather than count along the list. -->
            <span class="doc-title" [title]="tab().title">{{ tab().title }}</span>
            <!-- A toggle over the editor TAB: on while one is open for this
                 book anywhere in the workspace, and pressing it again closes
                 that tab. It opens in a pane of its own, beside this one. -->
            <button class="ghost" [class.on]="editing()" (click)="toggleEditor()">
              {{ editing() ? 'Done editing' : 'Edit HTML' }}
            </button>
            <span class="state">
              @if (writing()) { Writing… }
              @else if (tab().modified) { Edits are in the workspace copy }
              @else if (tab().savedPath) { Saved }
            </span>
            <button class="primary" (click)="tabs.save(tab().id)">
              {{ tab().savedPath === null ? 'Save…' : 'Save' }}
            </button>
          </header>

          <div class="panes">
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
    .book-title {
      font-family: var(--font-display); font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .book-author { font-size: 11px; color: var(--text-tertiary); }

    .chapters ul { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; }

    .entry { display: flex; align-items: center; }
    .pencil {
      flex-shrink: 0;
      visibility: hidden;
      margin-right: 6px;
      padding: 2px 5px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 11px; cursor: pointer;
    }
    .entry:hover .pencil { visibility: visible; }
    .pencil:hover { color: var(--text-primary); background: var(--bg-hover); }
    .rename {
      flex: 1;
      min-width: 0;
      margin: 2px 8px 2px 0;
      padding: 4px 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--accent);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .rename:focus { outline: none; box-shadow: var(--focus-ring); }

    .chapter {
      display: block;
      flex: 1;
      min-width: 0;
      margin: 0 6px;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .chapter:hover { background: var(--bg-hover); color: var(--text-primary); }
    .chapter.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 500;
    }

    .reading { flex: 1; min-width: 0; display: flex; flex-direction: column; }

    .toolbar {
      display: flex; align-items: center; gap: 8px;
      height: 44px;
      padding: 0 12px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    /* Capped at a share of the row rather than allowed to flex: the buttons
       beside it are the reason the row exists, and a long title must not push
       Save off the end of a narrow column. */
    .doc-title {
      flex: 0 1 auto;
      max-width: 40%;
      font-size: 12px; font-weight: 500; color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .state { flex: 1; min-width: 0; font-size: 11px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .panes { flex: 1; min-height: 0; display: flex; }

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

    .ghost, .primary {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 10px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost.on { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover { background: var(--accent-hover); }
    .primary:active { transform: scale(0.98); }
  `],
})
export class EpubViewComponent implements OnDestroy {
  readonly tab = input.required<Tab>();

  protected readonly tabs = inject(TabsService);
  private readonly sanitizer = inject(DomSanitizer);

  /** True while an HTML editor tab is open on this book, in whatever pane. */
  protected readonly editing = computed(() => this.tabs.editorFor(this.tab().id) !== null);
  /** The editor's flush, said in the book's toolbar because it is the book being written. */
  protected readonly writing = computed(() => this.tabs.writingTo() === this.tab().id);

  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly renameBox = viewChild<ElementRef<HTMLInputElement>>('renameBox');

  /** Which sidebar row is being renamed, and the text in its box. */
  protected readonly renamingHref = signal<string | null>(null);
  protected readonly renameText = signal('');

  /**
   * The click reporter's messages. Bound once so add/removeEventListener see
   * the same function, and gated hard: only THIS component's iframe is
   * listened to (event.source), only the expected shape is read, and only
   * while an editor is open on this book — reading stays reading.
   *
   * A WINDOW LISTENER AND NOT A DOCUMENT ONE, and it stays safe with five panes
   * on screen: `event.source` is the posting window, so each instance answers
   * only its own iframe. Five books rendered at once are five listeners that
   * each ignore the other four.
   */
  private readonly onFrameMessage = (event: MessageEvent): void => {
    const frame = this.frame()?.nativeElement;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; bf?: unknown; tag?: unknown; index?: unknown } | null;
    if (!data || data.type !== 'foundry:block-click') return;
    if (typeof data.tag !== 'string' || !/^[a-z][a-z0-9]*$/.test(data.tag)) return;
    if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0) return;
    // The service decides whether anything is listening — the editor is a tab
    // in another pane now, and this component has no business knowing where.
    this.tabs.reportSourceClick(this.tab().id, data.bf === true, data.tag, data.index);
  };

  constructor() {
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
  }

  protected toggleEditor(): void {
    void this.tabs.toggleEditor(this.tab().id);
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
}
