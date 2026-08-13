import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * The left rail — Home, the tools, and the gear.
 *
 * Modelled on BookForge's nav-rail (icon over label, active state, a pinned
 * footer), minus its console-capture and service-toggle machinery, which belong
 * to that app's problems and not to this one.
 *
 * HOME IS THE TOP ITEM and it is not a route: it is "no tab is active", so
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
    .rail {
      width: 88px;
      min-width: 88px;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
      padding: 8px 0;
      z-index: 40;
    }

    .rail-brand {
      text-align: center;
      font-size: 20px;
      color: var(--accent);
      padding: 6px 0 12px;
    }

    .rail-tools {
      display: flex; flex-direction: column; align-items: center;
      gap: 4px; flex: 1;
    }
    .rail-foot {
      display: flex; flex-direction: column; align-items: center;
      border-top: 1px solid var(--border-subtle); padding-top: 8px;
    }

    .rail-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: 76px;
      padding: 8px 4px;
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
