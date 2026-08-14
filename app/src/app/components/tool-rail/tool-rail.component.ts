import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

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

        <button
          class="rail-item"
          [class.active]="ui.ocrOpen()"
          title="OCR / Convert"
          (click)="convert()"
        >
          <span class="rail-icon">⌦</span>
          <span class="rail-label">OCR / Convert</span>
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
        <!-- TODO: "Searchable PDF" lands here as a second tool once the engine
             casts one; today it is a disabled option inside the dialog. -->
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
    .rail {
      flex: 0 0 auto;
      width: 100%;
      height: var(--rail-h);
      display: flex;
      align-items: center;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      padding: 0 10px;
      z-index: 40;
    }

    .rail-brand {
      flex: 0 0 auto;
      font-size: 20px;
      color: var(--accent);
      padding: 0 12px 0 4px;
    }

    /* The tools scroll sideways rather than shrinking: a narrow window must not
       squeeze six labels into unreadable stubs, and the dock is the one place
       every mode in this app is named. */
    .rail-tools {
      display: flex; flex-direction: row; align-items: center;
      gap: 4px; flex: 1; min-width: 0;
      overflow-x: auto; overflow-y: hidden;
    }
    .rail-foot {
      display: flex; flex-direction: row; align-items: center;
      flex: 0 0 auto;
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
   * A conversion is a thing you do to the document in front of you, so opening
   * the dialog from Settings takes you back to the documents first.
   */
  protected convert(): void {
    void this.router.navigateByUrl('/');
    this.ui.openOcr();
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
}
