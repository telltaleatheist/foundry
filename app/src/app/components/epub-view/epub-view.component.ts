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
  viewChildren,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

import { TabsService, membersOf, type Tab } from '../../core/tabs.service';

/**
 * The book — the whole of it, in one scroll, with the chapter lines on it.
 *
 * ── WHAT THIS COMPONENT IS NOW, AND WHAT IT USED TO BE ──────────────────────
 *
 * It used to render ONE CHAPTER: the tab held a `chapterHref`, this drew the
 * <iframe> for it, and the contents list in the inspector was how you got to the
 * next one. That is gone, and it went on a ruling of the user's:
 *
 *   "Instead of splitting chapters the way we currently do, let's have the whole
 *    book flow from start to finish, and chapters can be dotted lines with
 *    titles that show where they separate. The user can grab the chapter line
 *    and drag it up or down, or they can double click it and change what it
 *    says. That dotted line is the definitive chapter info for the book. The
 *    user can also click to add a chapter break anywhere they want."
 *
 * So the spine's documents are STACKED — one frame each, in reading order, each
 * sized to the height it reports — inside one column that scrolls. A reader gets
 * a book rather than a filing cabinet, and where it divides is drawn ON the
 * text, as a green dotted line wearing the chapter's name, which is a thing a
 * hand can take hold of.
 *
 * ── The route, and why it is this one ───────────────────────────────────────
 *
 * The obvious alternative was to make the ENGINE emit one document — a workbench
 * cast with marker elements in it. It was rejected, and the spec rejected it in
 * advance for the right reason: it forks the cast format, and every consumer of
 * a cast (translate, export, the records substitution, epub-final) would have to
 * learn the fork. This route changes nothing outside the viewer. The cast is
 * still an ordinary multi-document EPUB, the EDITION still splits into real
 * chapter documents at materialization, and a continuous scroll is how the
 * WORKBENCH shows a book rather than how a reader receives one.
 *
 * ── What stacking costs, honestly ───────────────────────────────────────────
 *
 * A selection, a marquee and a key press all live inside ONE document, because
 * an opaque origin is a wall in both directions. So the shell has to referee:
 * when one frame says something is selected, every other frame is told to let go
 * (`foundry:clear-selection`, answered silently so the inspector is not blanked
 * by the frame that just let go). A marquee still cannot cross a document
 * boundary, and neither can a chapter line's drag — the pointer stops being
 * deliverable the moment it leaves the frame it was pressed in. That is a real
 * edge and it is named rather than papered over: a break that needs to move into
 * the NEXT document is removed and re-added by clicking that document's gutter.
 *
 * ── Where the reader is ─────────────────────────────────────────────────────
 *
 * The complaint this used to answer — "i delete a footnote and the next thing i
 * know, im looking at the chapter header" — is answered STRUCTURALLY now rather
 * than by a channel. The scroll offset used to live inside the frame, so every
 * re-serve of a chapter dropped the reader at the top and the position had to be
 * captured and handed back. The offset lives on the COLUMN now, which is app DOM
 * and is not reloaded by anything; a frame that re-serves keeps the height this
 * component already assigned it, so the document under the reader does not even
 * move. And a write to one chapter reloads ONE frame — see `pageUrls` — where it
 * used to reload the only frame there was.
 *
 * ── Editing ─────────────────────────────────────────────────────────────────
 *
 * "Edit HTML" is still not offered here and the machinery is still untouched;
 * phase E retires it. Select mode, striking, relabelling and in-place block
 * editing all work exactly as they did — every one of them is a message from the
 * frame that owns the block, and the only thing this component adds is telling
 * the service WHICH document that frame is, so the write lands in the right
 * member (see `claim`).
 *
 * The chapter comes out of the main process through `foundry-file://epub/…`
 * (electron/main.ts) into an iframe with `sandbox="allow-scripts"` — and ONLY
 * that token, never allow-same-origin: the frame keeps an opaque origin, no
 * storage, no reach into this page. The one script that can execute in there is
 * main's own click reporter (electron/click-reporter.ts documents the serve-time
 * sanitization that keeps a book's own scripts dead). This component checks the
 * SOURCE of every message — only its own iframes' windows are listened to — and
 * every field of every message is checked before it is believed. Foundry wrote
 * these books, but the user is free to open one it did not, and a book is
 * ultimately somebody else's markup.
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
             the right of the shell now (app-inspector) — and with the book in
             one scroll, clicking a row there scrolls this column to it rather
             than swapping the document out. -->
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

              WITH THE MODE OFF the line says what the chapter lines are for,
              because the gestures on them are invisible until somebody tries
              one: a dotted line is obviously a mark and not obviously a handle.
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
              @else if (spineLocked()) { Chapter lines show where this saved book divides }
              @else if (marked() > 0) {
                Drag a chapter line to move it, double-click it to rename it, or click between
                two blocks to add one
              }
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
            @if (pages().length > 0) {
              <!--
                ONE COLUMN, ONE SCROLLBAR, and the frames inside it are as tall
                as they say they are. The column is the scroller, so the reader's
                place is app state that no re-serve of a chapter can throw away.
              -->
              <div class="column" #column (scroll)="onColumnScroll()">
                @for (page of pages(); track page.member) {
                  <!--
                    sandbox="allow-scripts" and nothing else: opaque origin, no
                    same-origin power. The only script that can execute is main's
                    click reporter (serve-time sanitization kills a book's own),
                    and its postMessages are what make click-to-source, select
                    mode and the chapter lines work.

                    scrolling="no" is not decoration: a frame that keeps its own
                    scrollbar is a document the reader can lose their place
                    inside of, which is the whole thing one column is for.
                  -->
                  <iframe
                    #frame
                    class="page"
                    [src]="page.url"
                    sandbox="allow-scripts"
                    scrolling="no"
                    [style.height.px]="page.height"
                    [title]="page.label"
                  ></iframe>
                }
              </div>
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

    /* White, because a book is white. The chrome around it is the dark part.
       position:relative because the frames' offsetTop is measured against this
       box when the inspector asks the column to scroll to a chapter. */
    .column {
      position: relative;
      flex: 1; min-width: 0;
      overflow-y: auto; overflow-x: hidden;
      background: #fff;
    }

    /* NO BORDER BETWEEN DOCUMENTS. The seam between two spine files is an
       accident of how the book was packed, and drawing it would put a line
       across the page in a place the book itself does not divide — which is
       exactly the confusion the chapter lines exist to end. */
    .page { display: block; width: 100%; border: none; background: #fff; }

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

  /** How many chapter lines this book is drawing, for the toolbar's one sentence. */
  protected readonly marked = computed(() => this.tabs.bookSpineFor(this.tab().id)?.marks.length ?? 0);

  /** True while a frozen save is on screen: the lines draw, and nothing on them moves. */
  protected readonly spineLocked = computed(() => {
    const spine = this.tabs.bookSpineFor(this.tab().id);
    return spine !== null && !spine.editable;
  });

  private readonly frames = viewChildren<ElementRef<HTMLIFrameElement>>('frame');
  private readonly column = viewChild<ElementRef<HTMLElement>>('column');

  /**
   * The blocks the frame says are selected, for the toolbar line.
   *
   * NOT A FACT ABOUT THE BOOK — a selection lives in a frame's DOM and dies
   * with the frame; everything that IS a fact about the book (the cut, the
   * words, the category) is an attribute in the working copy and nothing else.
   * It is kept on the SERVICE rather than in this component, because the
   * inspector is in the shell and cannot see five viewers' private signals. The
   * service keys it by tab, so five panes cannot blank each other's — and this
   * component keys the ONE selection a stacked book may hold to the frame that
   * announced it, so thirty documents cannot blank each other's either.
   */
  protected readonly selectedIds = computed<readonly string[]>(() =>
    this.tabs.selectionFor(this.tab().id)?.blockIds ?? []);

  // ── The documents, stacked ───────────────────────────────────────────────

  /**
   * The book's documents in reading order, once each.
   *
   * `EpubBook.chapters` is the SPINE with the navigation's labels laid over it,
   * plus one row per section header the engine anchored — those carry a
   * `#fragment` and name a document that is already in the list. `membersOf`
   * folds them, so this is exactly the reading order and nothing is drawn twice.
   */
  private readonly documents = computed<readonly { member: string; label: string; base: string }[]>(() => {
    const book = this.tab().book;
    if (book === null) return [];
    const rows = new Map<string, { label: string; base: string }>();
    for (const chapter of book.chapters) {
      const member = chapter.href.split('#')[0] ?? chapter.href;
      if (rows.has(member)) continue;
      rows.set(member, { label: chapter.label, base: chapter.url.split('#')[0] ?? chapter.url });
    }
    return membersOf(book).flatMap((member) => {
      const row = rows.get(member);
      return row === undefined ? [] : [{ member, label: row.label, base: row.base }];
    });
  });

  /** What each frame is showing, at the height it last said it was. */
  protected readonly pages = computed<readonly FlowPage[]>(() => {
    const heights = this.heights();
    const members = this.memberRevisions();
    const shared = this.globalRevision();
    return this.documents().map((doc) => {
      // `?v=` is what makes an edit visible: the bytes changed and the URL did
      // not, and an <iframe> already showing a URL does nothing when told to
      // show it again. The protocol handler reads the path and ignores the
      // query.
      const bump = shared + (members.get(doc.member) ?? 0);
      const url = bump === 0 ? doc.base : `${doc.base}?v=${bump}`;
      return {
        member: doc.member,
        label: doc.label,
        url: this.trusted(url),
        height: heights.get(doc.member) ?? PAGE_HEIGHT_BEFORE_MEASURING,
      };
    });
  });

  /**
   * One SafeResourceUrl per URL string, for as long as that string is current.
   *
   * `bypassSecurityTrustResourceUrl` mints a NEW object every call, and the
   * `[src]` binding compares by identity — so without this, every repaint of the
   * component (and there is one on every strike, every keystroke, every tab
   * patch) would hand thirty frames thirty "different" URLs and reload the whole
   * book. It is a cache with the same key as the thing it caches, cleared
   * whenever the set of live URLs changes, so it cannot grow with a session.
   */
  private readonly trustedUrls = new Map<string, SafeResourceUrl>();

  private trusted(url: string): SafeResourceUrl {
    const held = this.trustedUrls.get(url);
    if (held !== undefined) return held;
    const made = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    if (this.trustedUrls.size > MAX_TRUSTED_URLS) this.trustedUrls.clear();
    this.trustedUrls.set(url, made);
    return made;
  }

  /** As tall as each frame last said it is, keyed by the document it is showing. */
  private readonly heights = signal<ReadonlyMap<string, number>>(new Map());

  private setHeight(member: string, height: number): void {
    if (this.heights().get(member) === height) return;
    this.heights.update((map) => new Map(map).set(member, height));
  }

  /**
   * Which documents have been written since this book opened, counted one at a
   * time — and the count that reloads all of them.
   *
   * ── Why a whole-book reload had to stop being the only answer ──────────────
   *
   * `Tab.revision` is the app's "re-serve what this tab is showing" signal, and
   * with one chapter on screen that was one frame. With the book in one scroll
   * it is thirty, and a word edit in chapter nine would re-serve — and re-lay-out
   * and re-measure — every document in the book to show one corrected sentence.
   *
   * The service already says more than the tab does: `memberWritten` names the
   * chapter a write landed in, and it exists because a bump could not say it
   * (see its comment). So the two are read TOGETHER, and the pairing is the
   * whole rule:
   *
   *   - a bump that ARRIVED WITH a member write is that member's, and reloads
   *     one frame;
   *   - a bump with no member write is the "put the truth back over the guess"
   *     path — a refusal, a stalled undo — and reloads everything, which is what
   *     it is for;
   *   - a member write with NO bump is a strike or a relabel, which the frame
   *     has already painted, and reloads nothing at all. That is the rule the
   *     old viewer followed by not watching `memberWritten`, and it is why a
   *     held-down Delete key does not cost a reader their place.
   */
  private readonly memberRevisions = signal<ReadonlyMap<string, number>>(new Map());
  private readonly globalRevision = signal(0);
  private seenRevision = -1;
  private seenMemberSeq = 0;

  private reloadMember(member: string): void {
    this.memberRevisions.update((map) =>
      new Map(map).set(member, (map.get(member) ?? 0) + 1));
  }

  // ── The frames, and which is which ───────────────────────────────────────

  /**
   * WHICH DOCUMENT A MESSAGE CAME FROM, resolved by the posting window.
   *
   * `event.source` is the only identity a sandboxed frame has, and it is already
   * how this component refuses the other four panes' books. With thirty frames
   * in one pane it does a second job: it says which of this book's documents the
   * gesture was made in, which is what every write behind it needs to name.
   */
  private memberOfSource(source: MessageEventSource | null): string | null {
    if (source === null) return null;
    const frames = this.frames();
    const pages = this.pages();
    for (let at = 0; at < frames.length; at += 1) {
      if (frames[at]?.nativeElement.contentWindow === source) return pages[at]?.member ?? null;
    }
    return null;
  }

  private frameFor(member: string): HTMLIFrameElement | null {
    const pages = this.pages();
    const frames = this.frames();
    for (let at = 0; at < pages.length; at += 1) {
      if (pages[at]?.member === member) return frames[at]?.nativeElement ?? null;
    }
    return null;
  }

  /**
   * A gesture arrived from one document, so that is the document this tab is
   * standing in.
   *
   * ── The one thing stacking would otherwise have broken silently ────────────
   *
   * Every write behind a book gesture resolves its member from `tab.chapterHref`
   * — `blockEdit`, `mirrorBlockEdit`, `mirrorChapterEdit`, the footnote dialog.
   * That was exact while a tab showed one chapter and would be a quiet disaster
   * now: a strike made in chapter nine would be written into whichever chapter
   * the field happened to hold, against ids that document does not contain.
   *
   * So the field keeps meaning what it always meant — the document this tab is
   * working in — and it is set from the frame that spoke, immediately before the
   * service is asked to do anything. It is a plain patch and it lands
   * synchronously, so the call below it reads the value this line just wrote.
   */
  private claim(member: string): void {
    if (this.tab().chapterHref === member) return;
    this.fromFrame = member;
    this.tabs.showChapter(this.tab().id, member);
  }

  /** The last member THIS component put on the tab, so its own write is not read as a jump. */
  private fromFrame: string | null = null;

  /**
   * The click reporter's messages. Bound once so add/removeEventListener see
   * the same function, and gated hard: only THIS component's iframes are
   * listened to (event.source), and every field of every message is checked
   * before it is believed. A click-to-source jump goes to whichever editor
   * claims it (or nowhere); select mode's messages are refused outright unless
   * they carry the shapes below.
   *
   * A WINDOW LISTENER AND NOT A DOCUMENT ONE, and it stays safe with five panes
   * on screen: `event.source` is the posting window, so each instance answers
   * only its own iframes. Five books rendered at once are five listeners that
   * each ignore the other four's.
   */
  private readonly onFrameMessage = (event: MessageEvent): void => {
    const member = this.memberOfSource(event.source);
    if (member === null) return;
    const data = event.data as FrameMessage | null;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'foundry:block-click') {
      if (typeof data.tag !== 'string' || !/^[a-z][a-z0-9]*$/.test(data.tag)) return;
      if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0) return;
      this.claim(member);
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
      /*
       * A frame that has just (re)loaded is a frame with the mode off, with no
       * chapter lines on it and with no idea how tall it is. Telling it all
       * three is what survives the reloads nobody asked for — an editor flush, a
       * write to this member, the stamping pass.
       *
       * IT IS ALSO A FRAME THAT HAS FORGOTTEN WHAT WAS SELECTED, because a
       * selection lives in a DOM that no longer exists — but only its OWN
       * selection. Saying "nothing is selected" on behalf of the whole tab would
       * blank the inspector for a curator working in another document of the
       * same book, so it is said only by the frame that was holding it.
       */
      if (this.activeMember === member) {
        this.activeMember = null;
        this.tabs.reportSelection(this.tab().id, [], null);
      }
      if (this.editingMember === member) {
        this.editingMember = null;
        this.tabs.reportEditing(this.tab().id, false);
      }
      this.frameCounts.delete(member);
      this.pushSelectMode(member);
      this.pushFlow(member);
      return;
    }
    /*
     * HOW TALL THAT DOCUMENT IS, which is the one measurement a stacked book
     * cannot take for itself. The frame is behind an opaque origin, so this side
     * can no more read its scrollHeight than it can hit-test a paragraph.
     */
    if (data.type === 'foundry:page-height') {
      const height = pageHeight(data.height);
      if (height === null) return;
      this.setHeight(member, height);
      return;
    }
    if (data.type === 'foundry:scroll-report') {
      /*
       * IGNORED, DELIBERATELY, and this is where the scroll-restore channel went.
       *
       * A frame in the stack never scrolls — it is exactly as tall as its
       * content and the column outside it is the scroller — so what this reports
       * is always the top of a document, and handing it back would be telling a
       * page to stay where it already is. The property the channel existed for
       * (a re-served chapter must not throw the reader to its top) is now true
       * by construction: the offset is on the column, which nothing reloads, and
       * a re-serving frame keeps the height this component already gave it.
       *
       * The messages are left flowing rather than removed from the reporter,
       * because a document that somehow does scroll — a book that defeats the
       * height guard — is better off still saying so than silently not.
       */
      return;
    }
    if (data.type === 'foundry:located') {
      if (typeof data.token !== 'number') return;
      const waiting = this.locating.get(data.token);
      if (waiting === undefined) return;
      this.locating.delete(data.token);
      const y = typeof data.y === 'number' && Number.isFinite(data.y) && data.y >= 0 ? data.y : null;
      if (y !== null) this.scrollColumnTo(waiting, y);
      return;
    }
    if (data.type === 'foundry:block-selected') {
      const ids = blockIds(data.ids);
      if (ids === null) return;
      /*
       * ONE SELECTION PER BOOK, refereed here because no frame can see another.
       *
       * A frame that announces a selection takes it: every other frame is told
       * to let go, silently. A frame announcing an EMPTY selection is only
       * believed when it is the one that was holding it — otherwise a document
       * being clicked would be blanked a moment later by a document reporting
       * that it, too, has nothing selected.
       */
      if (ids.length === 0) {
        if (this.activeMember !== member) return;
        this.activeMember = null;
      } else if (this.activeMember !== member) {
        const was = this.activeMember;
        this.activeMember = member;
        if (was !== null) this.postTo(was, { type: 'foundry:clear-selection' });
      }
      const category = isCategoryName(data.cat) ? data.cat : null;
      this.claim(member);
      this.tabs.reportSelection(this.tab().id, ids, category);
      return;
    }
    if (data.type === 'foundry:block-editing') {
      // Not a fact about the book and never written anywhere: it exists so that
      // Ctrl+Z can tell "undo my typing" from "undo what I did to the book".
      if (typeof data.on !== 'boolean') return;
      if (data.on) this.editingMember = member;
      else if (this.editingMember === member) this.editingMember = null;
      else return;
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
      this.claim(member);
      void this.tabs.setBlockHtml(this.tab().id, data.id, data.html, was);
      return;
    }
    if (data.type === 'foundry:blocks-relabelled') {
      if (!isCategoryName(data.cat)) return;
      const ids = blockIds(data.ids);
      if (ids === null || ids.length === 0) return;
      this.claim(member);
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
      this.claim(member);
      void this.tabs.cutBlocks(this.tab().id, ids, data.cut, category);
      return;
    }
    if (data.type === 'foundry:category-counts') {
      const counts = tally(data.counts);
      const struck = tally(data.struck);
      if (counts === null || struck === null) return;
      /*
       * THE WHOLE BOOK'S TALLY, ADDED UP HERE. Each frame counts what it can
       * see, which is one document; the legend in the inspector is about the
       * book in front of the reader, and the book in front of the reader is all
       * of them. Kept per document and summed, so a document that re-serves
       * replaces its own contribution instead of being added twice.
       */
      this.frameCounts.set(member, { counts, struck });
      this.tabs.reportCategoryCounts(this.tab().id, this.wholeBookCounts());
      return;
    }

    // ── The chapter lines ──────────────────────────────────────────────────
    //
    // All four arrive naming a `data-bf-id` and nothing else, and the service
    // resolves each to the banked answer the spine is keyed to — the same
    // resolution the relabel-to-chapter-opening gesture already makes, through
    // the same provenance read. NO TITLE IS CARRIED except the one somebody
    // typed: an added marker is named with the block's own words, read off the
    // chapter file, because that is the §6b rule and because an undo has no
    // message to get a name back from.
    if (data.type === 'foundry:chapter-add') {
      if (!isBlockId(data.id)) return;
      void this.tabs.addChapterMark(this.tab().id, data.id, member);
      return;
    }
    if (data.type === 'foundry:chapter-move') {
      if (!isBlockId(data.from) || !isBlockId(data.to)) return;
      void this.tabs.moveChapterMark(this.tab().id, data.from, data.to, member);
      return;
    }
    if (data.type === 'foundry:chapter-rename') {
      if (!isBlockId(data.id) || typeof data.title !== 'string') return;
      if (data.title.length > MAX_CHAPTER_TITLE) return;
      void this.tabs.renameChapterMark(this.tab().id, data.id, member, data.title);
      return;
    }
    if (data.type === 'foundry:chapter-remove') {
      if (!isBlockId(data.id)) return;
      void this.tabs.removeChapterMark(this.tab().id, data.id, member);
      return;
    }

    if (data.type === 'foundry:select-refused') {
      if (typeof data.reason !== 'string') return;
      // Clamped and stripped of control characters before it is shown: it is
      // our own script's sentence, but it arrives over the same channel as
      // everything else and is treated the same way.
      this.tabs.reportSelectRefusal(data.reason.replace(CONTROL_CHARACTERS, ' ').slice(0, 400));
    }
  };

  /** Which document is holding the selection, and which one has a caret in it. */
  private activeMember: string | null = null;
  private editingMember: string | null = null;

  /** What each document says it holds, added up for the inspector's legend. */
  private readonly frameCounts = new Map<string, { counts: Record<string, number>; struck: Record<string, number> }>();

  private wholeBookCounts(): { counts: Record<string, number>; struck: Record<string, number> } {
    const counts: Record<string, number> = {};
    const struck: Record<string, number> = {};
    for (const one of this.frameCounts.values()) {
      for (const [name, n] of Object.entries(one.counts)) counts[name] = (counts[name] ?? 0) + n;
      for (const [name, n] of Object.entries(one.struck)) struck[name] = (struck[name] ?? 0) + n;
    }
    return { counts, struck };
  }

  // ── Parent → frame ───────────────────────────────────────────────────────

  /**
   * PARENT → FRAME, which did not exist until select mode: the reporter has
   * always been one-way. `targetOrigin` is '*' for the same reason the frame's
   * own posts use it — a sandboxed frame's origin is opaque, so there is no
   * origin string that names it, and the frame checks that the SOURCE is its
   * own parent.
   */
  private postTo(member: string, message: Record<string, unknown>): void {
    this.frameFor(member)?.contentWindow?.postMessage(message, '*');
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const frame of this.frames()) frame.nativeElement.contentWindow?.postMessage(message, '*');
  }

  private pushSelectMode(member?: string): void {
    const message = { type: 'foundry:select-mode', on: this.tab().selectMode };
    if (member === undefined) this.broadcast(message);
    else this.postTo(member, message);
  }

  /**
   * Tell a document it is one panel of a stacked book, and what the spine says
   * about it.
   *
   * TWO MESSAGES AND NOT ONE, because they answer to different things: flow mode
   * is a fact about the surface and never changes while a book is open, and the
   * lines change every time somebody touches them. Both are re-sent on every
   * handshake, because a frame comes back from a re-serve knowing neither.
   */
  private pushFlow(member?: string): void {
    const flow = { type: 'foundry:flow', on: true };
    if (member === undefined) this.broadcast(flow);
    else this.postTo(member, flow);
    this.pushChapters(member);
  }

  private pushChapters(member?: string): void {
    const spine = this.tabs.bookSpineFor(this.tab().id);
    const editable = spine?.editable === true;
    for (const page of this.pages()) {
      if (member !== undefined && page.member !== member) continue;
      // EACH DOCUMENT GETS ITS OWN, so a marker cannot be drawn twice by two
      // frames that both happen to hold an element of that name.
      const marks = (spine?.marks ?? [])
        .filter((one) => one.member === page.member && one.blockId !== null)
        .map((one) => ({ id: one.blockId, title: one.title }));
      this.postTo(page.member, { type: 'foundry:chapters', marks, editable });
    }
  }

  // ── Scrolling to a place ─────────────────────────────────────────────────

  /**
   * Put a place in the book in front of the reader — the inspector's contents
   * row, and its chapter row.
   *
   * IT TAKES TWO HOPS AND HAS TO. The column knows where each frame BEGINS
   * (`offsetTop`, app DOM, measurable); only the frame knows where a heading or
   * a block sits inside its own document. So the frame is asked, answers with a
   * y in its own coordinates, and this adds the two. A name no document carries
   * gets a null and the column does not move, which is the honest answer for a
   * chapter whose block this cast of the book does not contain.
   */
  private locateSeq = 0;
  private readonly locating = new Map<number, string>();

  private askToLocate(member: string, what: { id?: string; frag?: string }): void {
    if (this.frameFor(member) === null) return;
    this.locateSeq += 1;
    // Bounded: a book that never answers must not accumulate a request per
    // click for the life of the pane.
    if (this.locating.size > MAX_PENDING_LOCATES) this.locating.clear();
    this.locating.set(this.locateSeq, member);
    this.postTo(member, { type: 'foundry:locate', token: this.locateSeq, ...what });
  }

  private scrollColumnTo(member: string, y: number): void {
    const column = this.column()?.nativeElement;
    const frame = this.frameFor(member);
    if (!column || !frame) return;
    // A little air above the thing being shown, so a heading does not land
    // flush against the toolbar and read as cut off.
    column.scrollTop = Math.max(0, frame.offsetTop + y - SCROLL_TO_MARGIN);
  }

  /**
   * Which document the reader is actually looking at, kept on the tab.
   *
   * The contents list marks a row as current, and with one scroll there is no
   * other way for it to know which. It is also the field every write resolves
   * its member from, which is why `claim` sets it explicitly before a gesture
   * rather than trusting this: a curator can perfectly well strike a paragraph
   * in a document that is not the one at the top of the viewport.
   *
   * Throttled, and it only writes when the answer MOVED: a patch replaces the
   * tab object, and a patch per scroll event would be sixty recomputations a
   * second of every binding in this pane.
   */
  protected onColumnScroll(): void {
    if (this.scrollTimer !== null) return;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      const column = this.column()?.nativeElement;
      if (!column) return;
      const at = column.scrollTop + SCROLL_TO_MARGIN;
      let showing: string | null = null;
      const pages = this.pages();
      const frames = this.frames();
      for (let n = 0; n < pages.length; n += 1) {
        const frame = frames[n]?.nativeElement;
        const page = pages[n];
        if (!frame || page === undefined) continue;
        if (frame.offsetTop <= at) showing = page.member;
      }
      if (showing !== null) this.claim(showing);
    }, SCROLL_SETTLE_MS);
  }

  private scrollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    window.addEventListener('message', this.onFrameMessage);

    // The mode, whenever the tab's flag moves. The handshake covers a frame
    // that reloaded; this covers the button being pressed with one already up.
    // `pushSelectMode` reads `tab().selectMode` itself, which is what this
    // effect tracks — there is nothing else to read here.
    effect(() => { this.pushSelectMode(); });

    /*
     * THE SPINE, ASKED FOR AND THEN DRAWN.
     *
     * The service holds no chapters for a book until something asks — the read
     * is an overlay off disk plus one pass over every document of the book, and
     * a pane that is only showing a scan should pay for neither. So the surface
     * that draws the lines is the surface that asks for them.
     *
     * IT RE-ASKS ON TWO THINGS AND THE SERVICE THROWS AWAY THE REST. A curation
     * write by this window (`curationRevision`) moves the spine; the position
     * moving onto or off a frozen save (`lockOn`) changes WHICH spine is shown
     * and whether it may be dragged. `ensureBookSpine` keys on both and returns
     * without a read when neither has moved, which is what makes it safe to call
     * from an effect that also re-runs on every ordinary tab patch.
     */
    effect(() => {
      const tab = this.tab();
      this.tabs.curationRevision();
      this.tabs.lockOn(tab.id);
      if (tab.kind !== 'epub' || tab.book === null) return;
      void this.tabs.ensureBookSpine(tab.id);
    });

    // And drawn, whenever the answer moves. Every frame is told its own share.
    effect(() => {
      this.tabs.bookSpineFor(this.tab().id);
      this.pushChapters();
    });

    /**
     * The inspector's commands, on their way into the frames.
     *
     * THE PANEL IS IN THE SHELL AND THE FRAMES ARE BEHIND SANDBOXED ORIGINS, so
     * the two cannot be introduced: only these <iframe> elements can post into
     * those windows. The service holds the command with the tab it is for, and
     * every viewer ignores the four that are not its own — which is the same
     * arrangement `sourceJump` uses for a click travelling the other way.
     *
     * BROADCAST, and that is a change stacking makes rather than a shortcut.
     * `relabel` and `cut-category` act on what a frame holds, and exactly one
     * frame holds a selection; `mark-blocks` and `mark-labels` are an undo
     * repainting itself and name blocks that may be in any document — those used
     * to be silently dropped when the row named a chapter that was not on
     * screen, and now they land wherever the block actually is.
     */
    effect(() => {
      const command = this.tabs.frameCommand();
      if (!command || command.tabId !== this.tab().id) return;
      this.broadcast(command.message);
    });

    /*
     * ── The two reload rules, read as one ────────────────────────────────────
     *
     * See `memberRevisions` for the argument. The pairing is decided here, in
     * one effect, because it depends on whether the two signals moved TOGETHER —
     * and an effect reads both at their settled values, so a bump and the member
     * write that caused it are seen in the same run.
     */
    effect(() => {
      const tab = this.tab();
      const written = this.tabs.memberWritten();
      const mine = written !== null && written.tabId === tab.id ? written : null;
      const wroteAMember = mine !== null && mine.seq > this.seenMemberSeq;
      if (mine !== null) this.seenMemberSeq = Math.max(this.seenMemberSeq, mine.seq);
      if (this.seenRevision === tab.revision) return;
      const first = this.seenRevision < 0;
      this.seenRevision = tab.revision;
      if (first) return;
      if (wroteAMember && mine !== null) {
        this.reloadMember(mine.member);
        return;
      }
      this.globalRevision.update((n) => n + 1);
    });

    /*
     * A ROW IN THE CONTENTS, clicked. It used to swap the document out; there is
     * one document now, so it scrolls to the place instead — which is what §11
     * asks for in one line ("the accordion's jump to chapter becomes a
     * scroll-to").
     *
     * A HREF THIS COMPONENT ITSELF WROTE IS NOT A JUMP. `claim` puts the acting
     * document on the tab before every gesture and the scroll handler puts the
     * visible one there as the reader moves, so without this the column would
     * yank itself back to the top of a chapter every time somebody struck a
     * paragraph in it.
     */
    effect(() => {
      const href = this.tab().chapterHref;
      // THE FIELD IS RECORDED WHETHER OR NOT IT IS ACTED ON, and that is not
      // bookkeeping: this effect re-runs on every tab patch, so a value skipped
      // without being recorded would be acted on by the next unrelated patch —
      // and the column would jump to the top of a chapter because somebody
      // struck a paragraph two chapters later.
      if (href === null || this.seenHref === href) return;
      const first = this.seenHref === null;
      this.seenHref = href;
      const mine = this.fromFrame;
      this.fromFrame = null;
      const member = href.split('#')[0] ?? href;
      // The href a book opens with is "the first document", not a request to go
      // anywhere: the column already starts there.
      if (first || mine === member) return;
      const fragment = href.slice(member.length + 1);
      if (fragment.length > 0) this.askToLocate(member, { frag: decodeURIComponent(fragment) });
      else this.scrollColumnTo(member, 0);
    });

    /*
     * A CHAPTER ROW, clicked — the other projection of the same spine asking the
     * book to show it. The reveal names the banked answer (`page:order`), which
     * is what the file holds; the spine this component already has resolves it
     * to a document and an element.
     */
    effect(() => {
      const reveal = this.tabs.blockReveal();
      if (!reveal || reveal.tabId !== this.tab().id || reveal.seq === this.seenReveal) return;
      this.seenReveal = reveal.seq;
      const mark = this.tabs.bookSpineFor(this.tab().id)?.marks
        .find((one) => one.target === reveal.target);
      if (!mark || mark.member === null || mark.blockId === null) return;
      this.askToLocate(mark.member, { id: mark.blockId });
    });
  }

  private seenHref: string | null = null;
  private seenReveal = 0;

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onFrameMessage);
    if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
  }
}

/** One document of the book, as the column draws it. */
interface FlowPage {
  member: string;
  label: string;
  url: SafeResourceUrl;
  height: number;
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
  height?: unknown;
  token?: unknown;
  from?: unknown;
  to?: unknown;
  title?: unknown;
}

/**
 * As tall as one document may claim to be, in CSS pixels.
 *
 * Checked like every other field on this channel, and for a reason that is not
 * only hygiene: the number becomes the height of an element in this page, so a
 * NaN is a frame that disappears and a number with an exponent in it is a column
 * a scrollbar cannot address. The cap is far past the longest chapter anybody
 * will meet and refuses a message that is arithmetic rather than a measurement.
 */
function pageHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_PAGE_HEIGHT) return null;
  return Math.ceil(value);
}

/** As far down a document as a height may claim to reach, in CSS pixels. */
const MAX_PAGE_HEIGHT = 2_000_000;

/**
 * What a frame is given before it has said how tall it is.
 *
 * Not zero, and not something enormous: zero would collapse the whole book into
 * a scrollbar-less strip for the instant before the first measurement arrives,
 * and a huge placeholder would make the column jump backwards as thirty
 * documents each shrank to their real size. A screenful is the closest guess
 * available with no information at all.
 */
const PAGE_HEIGHT_BEFORE_MEASURING = 700;

/** How much of the column is left above something being scrolled to. */
const SCROLL_TO_MARGIN = 24;

/** How long the scrollbar has to be still before "which chapter is this" is re-asked. */
const SCROLL_SETTLE_MS = 200;

/** How many unanswered "where is this?" questions may be outstanding at once. */
const MAX_PENDING_LOCATES = 64;

/** As long as a chapter's name may be on the wire. The spine clamps it again. */
const MAX_CHAPTER_TITLE = 2_000;

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

/** How many URL strings are kept trusted before the cache is thrown away whole. */
const MAX_TRUSTED_URLS = 4_000;

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
