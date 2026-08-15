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
 * All the writing, debouncing and flushing moved with it; what stays here is the
 * book. NOTHING IN THIS TOOLBAR OPENS IT any more, and the comment in the
 * template says why; the editor tab itself is unchanged and phase E is what
 * finally takes it away.
 *
 * ── Where the reader is ─────────────────────────────────────────────────────
 *
 * A chapter is re-served on every path that writes to it, and a re-served
 * <iframe> starts at the top. This component remembers the frame's last reported
 * scroll position and hands it back after a reload of the SAME chapter, which is
 * the whole of the fix for "i delete a footnote and the next thing i know, im
 * looking at the chapter header". Both ends of the channel are documented in
 * electron/click-reporter.ts; this side is `onFrameMessage` and `restoreScroll`
 * below.
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
            <!-- THIS ROW DOES NOT NAME THE BOOK. It did, for as long as nothing
                 above it would — but the Chrome-style strip is back (the
                 workspace draws a tab per document, with its title on it), so a
                 title here is the same word twice, one row apart, taking 40% of
                 the row the mode line needs. -->
            <!--
              ── Edit HTML IS NOT OFFERED HERE, and the machinery is untouched ──

              The toggle sat in this row and on the dock, and what it opened was
              a textarea over somebody's chapter — a freeform byte editor for a
              document that is DERIVED from the readings bank. Every keystroke in
              it was a change with nothing to write itself down as: the bank did
              not hear it, the ledger did not hear it, and the next cast of the
              book was entitled to erase it. Offering the gesture and then losing
              it is worse than not offering it, which is the same reason the
              inspector's Block section is drawn nowhere.

              The editor tab, the toggle behind it and click-to-source all still
              work; phase E retires them properly, with the flowing surface in
              place to take the job (docs/DERIVED-BOOK.md §6). This withdraws the
              offer, not the code.
            -->
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
                @if (selectedIds().length === 1) {
                  {{ selectedIds()[0] }} — Delete cuts it, Enter edits its words
                } @else if (selectedIds().length > 1) {
                  {{ selectedIds().length }} blocks — Delete cuts them all
                } @else { Click a block, or drag a rectangle over several }
              }
              @else if (writing()) { Writing… }
              @else if (tab().modified) { Edits are in the workspace copy }
              @else if (tab().savedPath) { Saved }
            </span>
            <!--
              ── SAVING IS NOT A BUTTON ON THIS ROW ANY MORE ──

              It put a copy of the working tree somewhere the user chose, which
              made every pane a second door out of the app — one that files a
              book at whatever state its working copy happens to be in, with no
              record anywhere that it happened. Getting a finished document out
              is Export, on the dock: it renders the position you are standing on
              through the whole ledger and files the result under the project,
              where it can be found again tomorrow. A save button beside it would
              be a quieter way to get a worse copy of the same thing.

              The save and save-as calls on the service stay: closing a book with
              unsaved corrections still asks, and still needs somewhere to put
              them.
            -->
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

    /* The button shapes that were here went with the buttons. All this row says
       now is what mode the book is in and whether its edits are filed anywhere;
       the strip above it names the document, and every control that used to sit
       here is on the dock, where the app keeps its tools. */
  `],
})
export class EpubViewComponent implements OnDestroy {
  readonly tab = input.required<Tab>();

  protected readonly tabs = inject(TabsService);
  private readonly sanitizer = inject(DomSanitizer);

  /** The editor's flush, said in the book's toolbar because it is the book being written. */
  protected readonly writing = computed(() => this.tabs.writingTo() === this.tab().id);

  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  /**
   * The blocks the frame says are selected, for the toolbar line.
   *
   * NOT A FACT ABOUT THE BOOK — a selection lives in the frame's DOM and dies
   * with the frame; everything that IS a fact about the book (the cut, the
   * words, the category) is an attribute in the working copy and nothing else.
   * It is kept on the SERVICE rather than in this component now, because the
   * inspector is in the shell and cannot see five viewers' private signals. The
   * service keys it by tab, so five panes cannot blank each other's.
   */
  protected readonly selectedIds = computed<readonly string[]>(() =>
    this.tabs.selectionFor(this.tab().id)?.blockIds ?? []);

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
      this.tabs.reportSelection(this.tab().id, [], null);
      this.tabs.reportEditing(this.tab().id, false);
      this.pushSelectMode();
      this.restoreScroll();
      return;
    }
    /*
     * WHERE THE READER IS, kept against the chapter that reported it.
     *
     * Held on the component and not on the service, unlike the selection: five
     * panes each own one frame, and where somebody is in a chapter is not a fact
     * any other surface has a use for. It dies with the component, which is
     * correct — a pane that was closed is not owed its scrollbar back.
     */
    if (data.type === 'foundry:scroll-report') {
      const at = scrollAt(data.x, data.y);
      if (at !== null) this.frameScroll = at;
      return;
    }
    if (data.type === 'foundry:block-selected') {
      const ids = blockIds(data.ids);
      if (ids === null) return;
      const category = isCategoryName(data.cat) ? data.cat : null;
      this.tabs.reportSelection(this.tab().id, ids, category);
      return;
    }
    if (data.type === 'foundry:block-editing') {
      // Not a fact about the book and never written anywhere: it exists so that
      // Ctrl+Z can tell "undo my typing" from "undo what I did to the book".
      if (typeof data.on !== 'boolean') return;
      this.tabs.reportEditing(this.tab().id, data.on);
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
    if (data.type === 'foundry:blocks-relabelled') {
      if (!isCategoryName(data.cat)) return;
      const ids = blockIds(data.ids);
      if (ids === null || ids.length === 0) return;
      void this.tabs.setBlockCategories(this.tab().id, ids, data.cat);
      return;
    }
    if (data.type === 'foundry:blocks-cut') {
      if (typeof data.cut !== 'boolean') return;
      const ids = blockIds(data.ids);
      if (ids === null || ids.length === 0) return;
      // The category is carried only so the notice can name it, and only
      // select-all-by-category sends one — a marquee's worth of blocks is
      // whatever kinds the user dragged over and has no single name.
      const category = isCategoryName(data.cat) ? data.cat : null;
      void this.tabs.cutBlocks(this.tab().id, ids, data.cut, category);
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

  /**
   * Which chapter, in which tab, the frame is currently holding — and where the
   * reader had got to in it.
   *
   * ONE POSITION AND NOT A MAP, and that is the ruling rather than a shortcut: a
   * chapter opened fresh legitimately starts at the top, so a position kept for
   * a chapter the reader has since left is a position nothing is ever allowed to
   * use. Keeping one is what makes the test below a comparison rather than a
   * cache-invalidation problem.
   */
  private frameChapter: string | null = null;
  private frameScroll: { x: number; y: number } | null = null;

  /**
   * The tab AND the chapter: one pane can be handed a different tab's document.
   *
   * Joined on a NUL rather than on a separator either half could contain — an
   * href is a path and a path is allowed to hold anything a filesystem is. Same
   * escape, same reason, as the source key in pdf-view.
   */
  private chapterKey(): string {
    return `${this.tab().id}\u0000${this.tab().chapterHref ?? ''}`;
  }

  /**
   * Put the reader back after a RELOAD, and never after a navigation.
   *
   * ── The complaint this answers ──────────────────────────────────────────────
   *
   * "i delete a footnote and the next thing i know, im looking at the chapter
   * header." Striking a block paints in the frame and posts the write behind it;
   * a refusal reloads the frame to put the truth back, the stamping pass reloads
   * it, and an editor flush bumps the revision and reloads it. Every one of those
   * is a fresh document at offset zero, and a curation pass over a long chapter
   * becomes a scroll back to the place after every gesture.
   *
   * ── Why it is fixed HERE, at the handshake ─────────────────────────────────
   *
   * Because `foundry:reporter-ready` is the ONE event every reload path passes
   * through — the frame posts it at the end of its own execution whatever caused
   * it to run. Fixing the strike path, the refusal path and the flush path each
   * where they sit would be three fixes and a fourth reload nobody thought of;
   * this is one, and it covers the paths that do not exist yet.
   *
   * A DIFFERENT CHAPTER IS NOT A RELOAD. Clicking through to the next chapter is
   * a request to read it from its beginning, and handing that document somebody
   * else's offset would be the same defect wearing the opposite sign. So the key
   * carries the chapter, and a key that moved drops the position instead of
   * spending it.
   */
  private restoreScroll(): void {
    const chapter = this.chapterKey();
    const reloaded = this.frameChapter === chapter;
    this.frameChapter = chapter;
    const at = this.frameScroll;
    if (!reloaded || at === null) {
      this.frameScroll = null;
      return;
    }
    // The frame decides WHEN — it is the only side that can see whether its own
    // images have finished arriving, and a scroll issued into a document that is
    // still growing is clamped short of where the reader was.
    this.frame()?.nativeElement.contentWindow?.postMessage(
      { type: 'foundry:scroll-restore', x: at.x, y: at.y },
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
  on?: unknown;
  counts?: unknown;
  struck?: unknown;
  reason?: unknown;
  x?: unknown;
  y?: unknown;
}

/**
 * A scroll offset out of the frame, or null if it is not one.
 *
 * CHECKED LIKE EVERY OTHER FIELD ON THIS CHANNEL, and for a reason that is not
 * only hygiene: this number is handed straight back to the same document as a
 * scrollTo, so a NaN is a book that answers a delete by jumping to the top —
 * which is precisely the failure the whole channel exists to remove. The cap is
 * far past the height of any chapter a reader will ever meet and refuses a
 * message that is arithmetic rather than a position.
 */
function scrollAt(x: unknown, y: unknown): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > MAX_SCROLL || y > MAX_SCROLL) return null;
  return { x, y };
}

/** As far down a chapter as a position may claim to be, in CSS pixels. */
const MAX_SCROLL = 10_000_000;

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
 * A LIST of block ids out of the frame, or null if it is not one.
 *
 * THE BATCH IS DROPPED WHOLE if any member of it is not a name this app writes.
 * A partial list would strike, relabel or select some other blocks, and there
 * is no reading of a malformed message that makes half of it trustworthy. The
 * cap is the number of stamped elements a chapter can plausibly hold; past it,
 * something is wrong with the message rather than with the book.
 */
function blockIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_BATCH) return null;
  if (!value.every((one): one is string => isBlockId(one))) return null;
  return value;
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
