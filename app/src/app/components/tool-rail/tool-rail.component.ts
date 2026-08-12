import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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

        <button
          class="rail-item"
          [class.active]="ui.ocrOpen()"
          title="OCR / Convert"
          (click)="convert()"
        >
          <span class="rail-icon">⌦</span>
          <span class="rail-label">OCR / Convert</span>
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
      border-right: 1px solid var(--border-subtle);
      padding: 8px 0;
      z-index: 40;
    }

    .rail-brand {
      text-align: center;
      font-size: 20px;
      color: var(--accent);
      padding: 6px 0 12px;
    }

    .rail-tools { display: flex; flex-direction: column; gap: 4px; flex: 1; }
    .rail-foot { border-top: 1px solid var(--border-subtle); padding-top: 8px; }

    .rail-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
      padding: 10px 4px;
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text-secondary);
      cursor: pointer;
      text-decoration: none;
    }
    .rail-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rail-item:disabled { opacity: 0.35; cursor: default; }
    .rail-item:disabled:hover { background: transparent; color: var(--text-secondary); }
    .rail-item.active {
      background: var(--accent-soft);
      border-left-color: var(--accent);
      color: var(--text-primary);
    }

    .rail-icon { font-size: 19px; line-height: 1; }
    .rail-label { font-size: 10.5px; letter-spacing: 0.02em; text-align: center; }
  `],
})
export class ToolRailComponent {
  protected readonly ui = inject(UiService);
  protected readonly tabs = inject(TabsService);
  private readonly router = inject(Router);

  /** Editable means an unpacked book is in front of the user right now. */
  protected canEdit(): boolean {
    const tab = this.tabs.active();
    return tab !== null && tab.kind === 'epub' && tab.book !== null;
  }

  protected editingActive(): boolean {
    return this.tabs.active()?.editing === true;
  }

  protected toggleEdit(): void {
    const tab = this.tabs.active();
    if (tab && tab.kind === 'epub' && tab.book !== null) this.tabs.toggleEditing(tab.id);
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
}
