import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { TabsService, type Tab } from '../../core/tabs.service';

/**
 * The tab strip — Chrome's anatomy, and Chrome's gestures.
 *
 * Title, an unsaved dot, a close ✕; middle-click closes; overflow SCROLLS rather
 * than shrinking tabs to nothing, because a strip of twelve unreadable stubs is
 * worse at finding a document than a strip you can drag.
 *
 * A tab is not a route. The router still owns Settings, so clicking a tab from
 * the settings screen navigates back to the workspace first — the document is
 * what a tab means, and it cannot be shown on a page that is not showing
 * documents.
 */
@Component({
  selector: 'app-tab-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="strip">
      @for (tab of tabs.tabs(); track tab.id) {
        <div
          class="tab"
          [class.active]="tabs.activeId() === tab.id"
          [title]="tooltip(tab)"
          (click)="pick(tab)"
          (auxclick)="onAux($event, tab)"
        >
          <span class="kind">{{ tab.kind === 'epub' ? '▤' : '▦' }}</span>
          <span class="name">{{ tab.title }}</span>
          <!--
            TWO marks, because they are two different things to fix. The dot is
            "this book is not in a folder of yours"; the pencil is "the copy that
            is in one is older than this". A tab can wear both.
          -->
          @if (tab.unsaved) {
            <span class="dot" title="Not saved anywhere you chose">●</span>
          }
          @if (tab.modified) {
            <span class="pencil" title="Edited since it was last saved">✎</span>
          }
          <button class="x" (click)="close($event, tab)" title="Close tab">✕</button>
        </div>
      }
    </div>

    @if (tabs.notice(); as message) {
      <div class="notice">
        <span>{{ message }}</span>
        <button class="x" (click)="tabs.notice.set(null)" title="Dismiss">✕</button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    .strip {
      display: flex;
      align-items: stretch;
      gap: 2px;
      padding: 4px 6px 0;
      background: var(--bg-sunken);
      border-bottom: 1px solid var(--border-subtle);
      overflow-x: auto;
      overflow-y: hidden;
      /* A scrollbar under the tabs would eat a third of their height. */
      scrollbar-width: none;
    }
    .strip::-webkit-scrollbar { height: 0; }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      max-width: 240px;
      padding: 7px 8px 7px 10px;
      border: 1px solid transparent;
      border-bottom: none;
      border-radius: 8px 8px 0 0;
      color: var(--text-tertiary);
      font-size: 12.5px;
      cursor: default;
      user-select: none;
    }
    .tab:hover { background: var(--bg-hover); color: var(--text-secondary); }
    .tab.active {
      background: var(--bg-base);
      border-color: var(--border-subtle);
      color: var(--text-primary);
    }

    .kind { flex: 0 0 auto; opacity: 0.6; font-size: 11px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dot { flex: 0 0 auto; color: var(--accent); font-size: 9px; line-height: 1; }
    .pencil { flex: 0 0 auto; color: var(--warn); font-size: 11px; line-height: 1; }

    .x {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 2px 3px; border-radius: 4px;
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .notice {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px;
      background: rgba(224, 176, 32, 0.12);
      border-bottom: 1px solid var(--border-subtle);
      color: var(--warn);
      font-size: 12px;
    }
    .notice span { flex: 1; min-width: 0; }
  `],
})
export class TabStripComponent {
  protected readonly tabs = inject(TabsService);
  private readonly router = inject(Router);

  protected pick(tab: Tab): void {
    void this.router.navigateByUrl('/');
    this.tabs.activate(tab.id);
  }

  protected close(event: MouseEvent, tab: Tab): void {
    // Without this the click also lands on the tab and focuses what is about to
    // be closed, which flashes the document on screen for one frame.
    event.stopPropagation();
    void this.tabs.close(tab.id);
  }

  /** Middle-click. `auxclick` and not `mousedown`, so a middle-drag scroll is not a close. */
  protected onAux(event: MouseEvent, tab: Tab): void {
    if (event.button !== 1) return;
    event.preventDefault();
    void this.tabs.close(tab.id);
  }

  protected tooltip(tab: Tab): string {
    const lines = [tab.path];
    if (tab.savedPath !== null) lines.push(`Saved to ${tab.savedPath}`);
    if (tab.unsaved) lines.push("In Foundry's library workspace only — Ctrl+S files it somewhere.");
    if (tab.modified) lines.push('Edited since that copy was written — Ctrl+S brings it up to date.');
    return lines.join('\n');
  }
}
