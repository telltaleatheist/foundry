import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

import { TabsService, type Tab } from '../../core/tabs.service';

/**
 * The book — the chapter, and the toolbar over it.
 *
 * THE CHAPTER LIST USED TO BE THE LEFT COLUMN OF THIS COMPONENT and is now one
 * accordion of the inspector in the shell (app-inspector). It was 260 pixels
 * inside every pane, so five open books spent 1300 of them on five lists of the
 * same shape; there is one now, showing the focused document's contents, and it
 * sits beside the Category rows a curator works with in the same pass.
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
        <!-- THE CHAPTER LIST IS NOT HERE ANY MORE. It was a 260px column inside
             every one of these, so five panes spent 1300 pixels on five copies
             of the same kind of list. It is one accordion in the inspector on
             the right of the shell now (app-inspector), which shows the FOCUSED
             document's — same rows, same rename gesture, same fragment
             sub-entries, one of it. -->
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
            <!--
              SELECT MODE SAYS SO IN WORDS, because it is a mode: the outlines
              in the page are the only other sign it is on, and a person who
              pressed the rail button by accident has to be able to read what
              happened. The keys are named here rather than in a tooltip
              nobody hovers — Delete and Enter are the whole interface.
            -->
            <span class="state">
              @if (tab().selectMode) {
                <span class="mode">Select</span>
                @if (selectedId(); as block) {
                  {{ block }} — Delete cuts it, Enter edits its words
                } @else { Click a block to select it }
              }
              @else if (writing()) { Writing… }
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
    .mode {
      display: inline-block;
      margin-right: 6px;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
    }

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

  /**
   * The block the frame says is selected, for the toolbar line.
   *
   * NOT A FACT ABOUT THE BOOK — a selection lives in the frame's DOM and dies
   * with the frame; everything that IS a fact about the book (the cut, the
   * words, the category) is an attribute in the working copy and nothing else.
   * It is kept on the SERVICE rather than in this component now, because the
   * inspector is in the shell and cannot see five viewers' private signals. The
   * service keys it by tab, so five panes cannot blank each other's.
   */
  protected readonly selectedId = computed(() =>
    this.tabs.selectionFor(this.tab().id)?.blockId ?? null);

  /**
   * The click reporter's messages. Bound once so add/removeEventListener see
   * the same function, and gated hard: only THIS component's iframe is listened
   * to (event.source), and every field of every message is checked before it is
   * believed. A click-to-source jump goes to whichever editor claims it (or
   * nowhere); select mode's messages are refused outright unless they carry the
   * shapes below.
   *
   * A WINDOW LISTENER AND NOT A DOCUMENT ONE, and it stays safe with five panes
   * on screen: `event.source` is the posting window, so each instance answers
   * only its own iframe. Five books rendered at once are five listeners that
   * each ignore the other four.
   */
  private readonly onFrameMessage = (event: MessageEvent): void => {
    const frame = this.frame()?.nativeElement;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as FrameMessage | null;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'foundry:block-click') {
      if (typeof data.tag !== 'string' || !/^[a-z][a-z0-9]*$/.test(data.tag)) return;
      if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0) return;
      // The service decides whether anything is listening — the editor is a tab
      // in another pane now, and this component has no business knowing where.
      this.tabs.reportSourceClick(this.tab().id, data.bf === true, data.tag, data.index);
      return;
    }

    /*
     * SELECT MODE, and every field is checked exactly as `tag` and `index` are
     * above. The frame renders somebody else's book: foundry wrote most of
     * them, but the user is free to open one it did not, and what arrives on
     * this channel is data from a document rather than a call from a component.
     * An id goes into an IPC call that names an element to change; a length cap
     * and a character class are what stop it being anything else.
     */
    if (data.type === 'foundry:reporter-ready') {
      // A frame that has just (re)loaded is a frame with the mode off. Telling
      // it what the tab thinks is what survives the reloads nobody asked for —
      // an editor flush, a chapter change, the stamping pass.
      //
      // It is also a frame that has FORGOTTEN WHAT WAS SELECTED, because a
      // selection lives in a DOM that no longer exists. Saying so keeps the
      // inspector from offering to relabel a block that is not on screen — and
      // after a chapter change, is not even in this file.
      this.tabs.reportSelection(this.tab().id, null, null);
      this.pushSelectMode();
      return;
    }
    if (data.type === 'foundry:block-selected') {
      if (data.id !== null && !isBlockId(data.id)) return;
      const category = isCategoryName(data.cat) ? data.cat : null;
      this.tabs.reportSelection(
        this.tab().id,
        typeof data.id === 'string' ? data.id : null,
        category,
      );
      return;
    }
    if (data.type === 'foundry:block-cut') {
      if (!isBlockId(data.id) || typeof data.cut !== 'boolean') return;
      void this.tabs.setBlockCut(this.tab().id, data.id, data.cut);
      return;
    }
    if (data.type === 'foundry:block-edited') {
      if (!isBlockId(data.id)) return;
      // The cap is not about main, which validates the markup itself; it is
      // about not putting a megabyte of a book through IPC because a
      // contenteditable was pointed at the wrong element.
      if (typeof data.html !== 'string' || data.html.length > MAX_BLOCK_HTML) return;
      // `was` is the block as it stood before the edit, and it is the ONLY copy
      // of it left anywhere once main has written the new words — it is what the
      // third answer to the unlinked-footnote question ("put the number back")
      // is restored from. Capped like the other side, and an edit that arrives
      // without it is still applied: the question then simply has two answers.
      const was = typeof data.was === 'string' && data.was.length <= MAX_BLOCK_HTML ? data.was : '';
      void this.tabs.setBlockHtml(this.tab().id, data.id, data.html, was);
      return;
    }
    if (data.type === 'foundry:block-relabelled') {
      if (!isBlockId(data.id) || !isCategoryName(data.cat)) return;
      void this.tabs.setBlockCategory(this.tab().id, data.id, data.cat);
      return;
    }
    if (data.type === 'foundry:category-cut') {
      if (!isCategoryName(data.cat) || typeof data.cut !== 'boolean') return;
      // Every id checked, and the batch dropped whole if any of them is not a
      // name this app writes — a partial list would strike some other blocks.
      // The cap is the number of stamped elements a chapter can plausibly hold;
      // past it, something is wrong with the message rather than with the book.
      if (!Array.isArray(data.ids) || data.ids.length === 0 || data.ids.length > MAX_BATCH) return;
      if (!data.ids.every((one): one is string => isBlockId(one))) return;
      void this.tabs.cutBlocksByCategory(this.tab().id, data.cat, data.ids, data.cut);
      return;
    }
    if (data.type === 'foundry:category-counts') {
      const counts = tally(data.counts);
      const struck = tally(data.struck);
      if (counts === null || struck === null) return;
      this.tabs.reportCategoryCounts(this.tab().id, { counts, struck });
      return;
    }
    if (data.type === 'foundry:select-refused') {
      if (typeof data.reason !== 'string') return;
      // Clamped and stripped of control characters before it is shown: it is
      // our own script's sentence, but it arrives over the same channel as
      // everything else and is treated the same way.
      this.tabs.reportSelectRefusal(data.reason.replace(CONTROL_CHARACTERS, " ").slice(0, 400));
    }
  };

  /**
   * PARENT → FRAME, which did not exist until select mode: the reporter has
   * always been one-way. `targetOrigin` is '*' for the same reason the frame's
   * own posts use it — a sandboxed frame's origin is opaque, so there is no
   * origin string that names it, and the frame checks that the SOURCE is its
   * own parent.
   */
  private pushSelectMode(): void {
    const frame = this.frame()?.nativeElement;
    frame?.contentWindow?.postMessage(
      { type: 'foundry:select-mode', on: this.tab().selectMode },
      '*',
    );
  }

  constructor() {
    window.addEventListener('message', this.onFrameMessage);

    // The mode, whenever the tab's flag moves. The handshake covers a frame
    // that reloaded; this covers the button being pressed with one already up.
    // `pushSelectMode` reads `tab().selectMode` itself, which is what this
    // effect tracks — there is nothing else to read here.
    effect(() => { this.pushSelectMode(); });

    /**
     * The inspector's commands, on their way into the frame.
     *
     * THE PANEL IS IN THE SHELL AND THE FRAME IS BEHIND A SANDBOXED ORIGIN, so
     * the two cannot be introduced: only this <iframe> element can post into
     * that window. The service holds the command with the tab it is for, and
     * every viewer ignores the four that are not its own — which is the same
     * arrangement `sourceJump` uses for a click travelling the other way.
     */
    effect(() => {
      const command = this.tabs.frameCommand();
      if (!command || command.tabId !== this.tab().id) return;
      const frame = this.frame()?.nativeElement;
      frame?.contentWindow?.postMessage(command.message, '*');
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

}

/**
 * Everything the frame can say, as fields that are all UNKNOWN until checked.
 *
 * Typed this way on purpose rather than as a discriminated union of trusted
 * shapes: nothing about a message from a sandboxed frame is guaranteed, so the
 * declaration should not pretend that reading `data.id` gives a string.
 */
interface FrameMessage {
  type?: unknown;
  bf?: unknown;
  tag?: unknown;
  index?: unknown;
  id?: unknown;
  ids?: unknown;
  cut?: unknown;
  cat?: unknown;
  html?: unknown;
  was?: unknown;
  counts?: unknown;
  struck?: unknown;
  reason?: unknown;
}

/**
 * The shape of a `data-bf-id`, checked before it is handed to an IPC call that
 * uses it to name an element to change.
 *
 * `p<page>-<n>` is what foundry writes; the class is wider than that so a book
 * stamped under some later scheme still works, and narrow enough that nothing
 * arriving here can be quoting, a path, or pattern syntax. Main checks it again
 * — this is the near gate, not the only one.
 */
function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value);
}

/**
 * As much markup as one block's words can be before this stops believing the
 * message. A long paragraph of a scanned book is a couple of kilobytes; the cap
 * is generous by two orders of magnitude and still refuses to put a chapter
 * through IPC because a contenteditable ended up on the wrong element.
 */
const MAX_BLOCK_HTML = 200_000;

/**
 * As many blocks as one select-all-by-category gesture may name.
 *
 * A chapter of a scanned book runs to a few hundred stamped elements; this is an
 * order of magnitude past the largest real one, and it exists so a message
 * claiming to strike fifty thousand blocks is refused before it becomes fifty
 * thousand ids in an IPC call.
 */
const MAX_BATCH = 5_000;

/**
 * A `data-bf-cat` value, checked before it is handed to a call that writes it
 * into somebody's book.
 *
 * NOT checked against the eleven this app knows: the emitter is allowed to grow
 * a category before the app does, and a book carrying one must still be
 * relabellable AWAY from it. What this refuses is anything that is not the shape
 * of a category at all — quoting, pattern syntax, a path. Main checks the value
 * itself against its own list and refuses an unknown one by name, which is where
 * that judgement belongs.
 */
function isCategoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
}

/**
 * A `{category: count}` object out of the frame, or null if it is not one.
 *
 * Every key and every value is checked, because this arrives from a document
 * rather than from a component — and it ends up drawn as a number beside a
 * category's name, where a NaN or a key a hundred characters long would be a
 * legend nobody can read.
 */
function tally(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (!isCategoryName(key)) continue;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
    out[key] = count;
  }
  return out;
}

/** Stripped out of a refusal before it is shown, so a sentence stays a sentence. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
