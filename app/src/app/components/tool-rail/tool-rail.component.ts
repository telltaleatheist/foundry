import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { ProjectsService } from '../../core/projects.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * The dock — Home, the tools, and the gear, along the BOTTOM of the window.
 *
 * IT USED TO BE A COLUMN DOWN THE LEFT, 88 pixels wide for the whole session,
 * beside a 220-pixel document list: 308 pixels of chrome before a page of a book
 * began. Horizontal, it costs about 60 pixels of height and gives all of that
 * width back to the pages, which is the thing this window exists to show. The
 * model is an iPhone control bar or the Mac dock — the tools live along the
 * bottom edge, in reach, out of the way of the document.
 *
 * ICON OVER LABEL SURVIVED THE MOVE, deliberately. Icons alone are a rail you
 * have to hover to read, and this app's tools are not the four everybody already
 * knows: "Select" is a curation mode nobody has met before, and a glyph would
 * teach nobody anything.
 *
 * HOME IS THE FIRST ITEM and it is not a route: it is "no tab is active", so
 * pressing it puts the documents down without closing them and pressing a tab
 * picks one back up. A Home that closed your tabs would be a Home nobody presses.
 */
@Component({
  selector: 'app-tool-rail',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="rail">
      <div class="rail-brand" title="Foundry">⬙</div>

      <div class="rail-tools">
        <button
          class="rail-item"
          [class.active]="tabs.activeId() === null"
          title="Home"
          (click)="home()"
        >
          <span class="rail-icon">⌂</span>
          <span class="rail-label">Home</span>
        </button>

        <!-- The document list. Disabled with nothing open rather than hidden,
             on this rail's usual principle — and because with nothing open the
             panel is not on screen anyway, so a button that toggled a hidden
             thing would be a button with no visible effect. -->
        <button
          class="rail-item"
          [class.active]="documentsUp()"
          [disabled]="tabs.tabs().length === 0"
          title="Show or hide the open documents (Ctrl+B)"
          (click)="ui.toggleDocuments()"
        >
          <span class="rail-icon">☰</span>
          <span class="rail-label">Documents</span>
        </button>

        <!--
          THE TWO HALVES OF WHAT USED TO BE ONE BUTTON, side by side and in the
          order they happen. OCR reads the pages and costs hours; Generate turns
          what was read into a document and costs nothing. They were one item
          called "OCR / Convert" while they were one job, and separating them on
          the dock is most of what teaches the difference.

          OCR LIGHTS UP when the book in front of you has never been read — the
          same accent this rail uses for "this is active", used here for "this is
          the step you are waiting on". It is the one place in the dock that
          points at what to do next rather than at what is currently on.
        -->
        <button
          class="rail-item"
          [class.active]="ui.ocrOpen()"
          [class.waiting]="ocrWaiting()"
          [title]="ocrWaiting()
            ? 'These pages have not been read yet — this is the step everything else needs'
            : 'Read this book\\'s pages with the vision model'"
          (click)="convert()"
        >
          <span class="rail-icon">⌦</span>
          <span class="rail-label">OCR</span>
        </button>

        <button
          class="rail-item"
          [class.active]="ui.generateOpen()"
          [disabled]="!canGenerate()"
          title="Build an EPUB, plain text or a real-text PDF from what was read"
          (click)="generate()"
        >
          <span class="rail-icon">⎘</span>
          <span class="rail-label">Generate</span>
        </button>

        <!-- Translate. Disabled rather than hidden away from a book, on the
             same principle as Edit HTML below: a translation is a thing you do
             to a book Foundry converted, and somebody looking at a scan should
             be able to see that the tool exists and is not applicable yet. -->
        <button
          class="rail-item"
          [class.active]="ui.translateOpen()"
          [disabled]="!canTranslate()"
          title="Translate this book into another language"
          (click)="translate()"
        >
          <span class="rail-icon">⇄</span>
          <span class="rail-label">Translate</span>
        </button>

        <!-- Metadata. Enabled for a scan as well as a book, unlike everything
             else here that needs a converted EPUB: a PDF has an Info dictionary
             and correcting it is exactly as useful as correcting a package. It
             does NOT rename any file — see the dialog for why that is a
             decision rather than an omission. -->
        <button
          class="rail-item"
          [class.active]="ui.metadataOpen()"
          [disabled]="!canEditMetadata()"
          title="The title, author and language this document claims for itself"
          (click)="metadata()"
        >
          <span class="rail-icon">ⓘ</span>
          <span class="rail-label">Metadata</span>
        </button>

        <!-- Select mode. Disabled rather than hidden away from a book, like
             Translate and Edit HTML: the curation pass is the point of the
             whole app, and somebody looking at a scan should be able to see
             that the tool exists and is waiting for a cast book. -->
        <button
          class="rail-item"
          [class.active]="selecting()"
          [disabled]="!canSelect()"
          title="Outline the blocks: click to select, Delete to cut, Enter to fix a word"
          (click)="toggleSelect()"
        >
          <span class="rail-icon">⧉</span>
          <span class="rail-label">Select</span>
        </button>

        <!-- Block view: select mode for a SCAN. A separate item rather than a
             second meaning for Select, because they act on different documents
             and a person should be able to see which of the two the thing in
             front of them has. Disabled over a book, exactly as Select is
             disabled over a scan — the pair reads as one idea in two places. -->
        <button
          class="rail-item"
          [class.active]="blocking()"
          [disabled]="!canBlock()"
          [title]="canBlock()
            ? 'Outline what the model read off this scan: strike, relabel, mark the chapters'
            : 'There is nothing to correct until the pages have been read — press OCR first'"
          (click)="toggleBlocks()"
        >
          <span class="rail-icon">▦</span>
          <span class="rail-label">Blocks</span>
        </button>

        <!-- The split editor's discoverable half: the same toggle as the
             button in the book's own toolbar, surfaced where a person who has
             never opened it will look. Disabled rather than hidden when the
             active tab is not a book — a tool that vanishes teaches nobody
             it exists. -->
        <button
          class="rail-item"
          [class.active]="editingActive()"
          [disabled]="!canEdit()"
          title="Edit the book's HTML in a split view"
          (click)="toggleEdit()"
        >
          <span class="rail-icon">&lt;/&gt;</span>
          <span class="rail-label">Edit HTML</span>
        </button>
        <!-- The PDF conversion is an output format inside the OCR dialog rather
             than a rail button of its own: the rail names TOOLS, and picking
             between an EPUB, plain text and a real-text PDF is one decision
             about one run, made where the rest of that run is described. -->
      </div>

      <div class="rail-foot">
        <a
          class="rail-item"
          routerLink="/settings"
          routerLinkActive="active"
          title="Settings"
        >
          <span class="rail-icon">⚙</span>
          <span class="rail-label">Settings</span>
        </a>
      </div>
    </nav>
  `,
  styles: [`
    /*
      A ROW ALONG THE BOTTOM. The height is a token (--rail-h, styles.scss)
      rather than a number written here, because the queue shelf floats over the
      window at z-index 900 and has to sit ABOVE this dock rather than on top of
      its right-hand end — the shelf reads the same token to lift itself, and two
      hand-kept numbers would drift into a pill covering the Settings button.
    */
    /*
      THE TOOLS ARE CENTRED ON THE WINDOW, not on the space left over beside
      Settings — and that distinction is the whole reason this is a grid and no
      longer a flex row with the tools packed left.

      Centring inside the remaining space would put the group off-centre by half
      the Settings slot's width, which is invisible on a narrow window and
      obvious on a wide one against a centred page. A 1fr / tools / 1fr grid
      gives the brand and the Settings foot columns that SHARE the leftover
      equally, so whatever those two weigh the middle column's centre is the
      window's centre.

      The middle track is minmax(0, auto) rather than a bare auto: auto alone
      cannot shrink below its content, so a window too narrow for the tools
      would push the grid wider than the dock instead of letting the tools
      scroll. With a floor of 0 the track shrinks, .rail-tools scrolls inside
      it, and the group is start-aligned exactly when it no longer fits —
      centring an overflowing row would scroll its FIRST item off the left edge,
      which is worse than a row that begins at the left.

      The side tracks keep grid's automatic minimum (their own content), so the
      Settings item is never clipped by the balancing.
    */
    .rail {
      flex: 0 0 auto;
      width: 100%;
      height: var(--rail-h);
      display: grid;
      grid-template-columns: 1fr minmax(0, auto) 1fr;
      align-items: center;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      padding: 0 10px;
      z-index: 40;
    }

    .rail-brand {
      justify-self: start;
      font-size: 20px;
      color: var(--accent);
      padding: 0 12px 0 4px;
    }

    /* The tools scroll sideways rather than shrinking: a narrow window must not
       squeeze seven labels into unreadable stubs, and the dock is the one place
       every mode in this app is named. */
    .rail-tools {
      display: flex; flex-direction: row; align-items: center;
      gap: 4px; min-width: 0;
      overflow-x: auto; overflow-y: hidden;
    }
    /* Settings stays parked at the right-hand end, divider and all. It is not
       a tool — it is where you go when the tools are not the answer. */
    .rail-foot {
      display: flex; flex-direction: row; align-items: center;
      justify-self: end;
      border-left: 1px solid var(--border-subtle);
      padding-left: 8px; margin-left: 8px;
    }

    .rail-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      flex: 0 0 auto;
      width: 76px;
      padding: 6px 4px;
      background: transparent;
      border: none;
      border-radius: var(--radius);
      color: var(--text-secondary);
      cursor: pointer;
      text-decoration: none;
      transition: background-color 150ms ease, color 150ms ease;
    }
    .rail-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rail-item:disabled { opacity: 0.35; cursor: default; }
    .rail-item:disabled:hover { background: transparent; color: var(--text-secondary); }
    .rail-item.active {
      background: var(--accent-soft);
      color: var(--accent);
    }

    /*
      WAITING, which is not the same as ACTIVE and must not look identical.
      Active means "this panel is open right now"; waiting means "this is the
      step your book needs next". The SAME accent — this app has one word for
      attention, and inventing a second colour for a second kind of it is how a
      palette stops meaning anything — but drawn as an outline rather than a
      fill, so a dock showing both still says which is which. It pulses once as
      it arrives and then holds: a permanently animating dock is a dock people
      learn to look away from.
    */
    .rail-item.waiting:not(.active) {
      color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
      animation: notice 900ms cubic-bezier(0, 0, 0.2, 1) 1;
    }
    @keyframes notice {
      0% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 0 var(--accent-soft); }
      60% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 7px transparent; }
      100% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 0 transparent; }
    }
    .rail-item.active .rail-icon { transform: scale(1.1); }

    .rail-icon { font-size: 19px; line-height: 1; transition: transform 150ms ease; }
    .rail-label {
      font-size: 10px; font-weight: 500; line-height: 1.2;
      text-transform: uppercase; letter-spacing: 0.02em;
      text-align: center; opacity: 0.85;
    }
  `],
})
export class ToolRailComponent {
  protected readonly ui = inject(UiService);
  protected readonly tabs = inject(TabsService);
  private readonly projects = inject(ProjectsService);
  private readonly router = inject(Router);

  /** Lit when the panel is actually on screen, which needs both halves of it. */
  protected readonly documentsUp = computed(() =>
    this.ui.documentsShown() && this.tabs.tabs().length > 0);

  /**
   * Editable means an unpacked book is in front of the user right now.
   *
   * `activeDocument` and not `active`: with the editor pane focused, the tab in
   * front of the user IS the editor, and a rail that greyed out its own toggle
   * the moment you clicked into the thing it opened would be a rail you could
   * not press twice.
   */
  protected canEdit(): boolean {
    const tab = this.tabs.activeDocument();
    return tab !== null && tab.kind === 'epub' && tab.book !== null;
  }

  /**
   * Selectable is the same test as editable, and for the same reason it reads
   * `activeDocument()` rather than `active()`: with the HTML editor pane focused
   * the tab in front of the user is the editor, and a rail that greyed out the
   * book's own mode the moment you clicked into its source would be a rail you
   * could not press twice.
   */
  protected canSelect(): boolean {
    const tab = this.tabs.activeDocument();
    return tab !== null && tab.kind === 'epub' && tab.book !== null;
  }

  protected selecting(): boolean {
    return this.tabs.activeDocument()?.selectMode === true;
  }

  protected toggleSelect(): void {
    const tab = this.tabs.activeDocument();
    if (tab && tab.kind === 'epub' && tab.book !== null) void this.tabs.toggleSelectMode(tab.id);
  }

  /**
   * Blocks needs a SCAN THAT HAS BEEN READ, which is the mirror of Select
   * needing an unpacked book.
   *
   * IT USED TO BE `kind === 'pdf'` AND NOTHING ELSE, on the reasoning that
   * whether the model had read a document was a question only main could answer
   * and asking it per repaint would be an IPC call per frame. That reasoning
   * expired: the project listing is a live mirror now — main pushes
   * `projects:changed` whenever a reading lands — so the answer is already in
   * this window, in the same signal the OCR light reads.
   *
   * The button is still ENABLED for a scan whose project is unknown, which is
   * the pre-import window and the case where the mode's own sentence is the
   * useful one ("this file is not in the library yet"). A dead button says
   * nothing at all, and this rail's rule is that a shut door explains itself.
   */
  protected canBlock(): boolean {
    const tab = this.tabs.activeDocument();
    if (tab === null || tab.kind !== 'pdf') return false;
    const project = this.projects.projectFor(tab.path);
    return project === null || project.reading.done;
  }

  protected blocking(): boolean {
    return this.tabs.activeDocument()?.blockView === true;
  }

  protected toggleBlocks(): void {
    const tab = this.tabs.activeDocument();
    if (tab && tab.kind === 'pdf') void this.tabs.toggleBlockView(tab.id);
  }

  protected editingActive(): boolean {
    const tab = this.tabs.activeDocument();
    return tab !== null && tab.kind === 'epub' && this.tabs.editorFor(tab.id) !== null;
  }

  protected toggleEdit(): void {
    const tab = this.tabs.activeDocument();
    if (tab && tab.kind === 'epub' && tab.book !== null) void this.tabs.toggleEditor(tab.id);
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
    this.tabs.goHome();
  }

  /**
   * Reading the pages is a thing you do to the document in front of you, so
   * opening the dialog from Settings takes you back to the documents first.
   */
  protected convert(): void {
    void this.router.navigateByUrl('/');
    this.ui.openOcr();
  }

  /**
   * THE STEP THIS BOOK IS WAITING ON, lit on the dock.
   *
   * True only for a PDF whose project has no completed reading. Everything else
   * in this app is built on that bank — the block editor, every rendering, the
   * chapter detection — so a scan that has not been read is a scan where exactly
   * one thing is worth pressing, and the dock says which.
   *
   * From the project RECORD (`ProjectSummary.reading`, derived once by main when
   * the library was listed), never from probing the disk here: this method runs
   * on every repaint of the dock.
   */
  protected ocrWaiting(): boolean {
    const tab = this.tabs.activeDocument();
    if (tab === null || tab.kind !== 'pdf') return false;
    return this.projects.projectFor(tab.path)?.reading.needed === true;
  }

  /**
   * Generate needs a PDF in front of you and nothing else.
   *
   * NOT gated on the reading existing, deliberately. The dialog is the thing
   * that knows how to say "these pages have not been read" and offer to read
   * them — a dead button on the dock would leave somebody with nowhere to find
   * out why, which is the shape of every disabled control in this rail's
   * comments.
   */
  protected canGenerate(): boolean {
    return this.tabs.activeDocument()?.kind === 'pdf';
  }

  protected generate(): void {
    void this.router.navigateByUrl('/');
    this.ui.openGenerate();
  }

  /**
   * Enabled over a book, on the same test the dialog itself applies.
   *
   * A PDF has no blocks to translate — the categories a translation replaces
   * are stamped when foundry BUILDS the EPUB — so the button is dead over a
   * scan rather than opening a dialog whose only message is "not this file".
   */
  protected canTranslate(): boolean {
    return this.tabs.activeDocument()?.kind === 'epub';
  }

  protected translate(): void {
    void this.router.navigateByUrl('/');
    this.ui.openTranslate();
  }

  /**
   * A document — either kind. Metadata is the one tool here that a SCAN has as
   * much use for as a book: a PDF's Info dictionary is the same six facts under
   * a different spelling, and a scan whose Title is the filename it was
   * downloaded under is the ordinary case.
   */
  protected canEditMetadata(): boolean {
    const tab = this.tabs.activeDocument();
    return tab !== null && (tab.kind === 'pdf' || tab.kind === 'epub');
  }

  protected metadata(): void {
    void this.router.navigateByUrl('/');
    this.ui.openMetadata();
  }
}
