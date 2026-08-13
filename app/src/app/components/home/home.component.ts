import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import type { RecentDocument } from '@shared/types';

import { RecentsService } from '../../core/recents.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * Home — what the app is when nothing is open.
 *
 * Three things, in the order a person needs them: the documents they had before,
 * a target big enough to drop a book on without aiming, and the two actions
 * worth a button. The drop target is decorative in the strict sense — the WHOLE
 * WINDOW accepts a drop (see App) — but a rectangle that says "drop here" is how
 * anybody knows that.
 *
 * A row for a book still in the workspace says so. "Open" means something
 * different for the two: one is a file you can hand to a reader, and one exists
 * only because this app has not been asked to throw it away.
 */
@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="home">
      <div class="hero">
        <div class="mark">⬙</div>
        <h1>Foundry</h1>
        <p>Recast a poorly scanned PDF into a clean EPUB.</p>

        <div class="target">
          <span>Drop a PDF anywhere in this window</span>
        </div>

        <div class="actions">
          <button class="primary" (click)="tabs.openViaDialog()">Open a document…</button>
          <button class="ghost" (click)="ui.openOcr()">OCR / Convert…</button>
          <button class="ghost" (click)="settings()">Settings</button>
        </div>
      </div>

      <section class="recents">
        <header>
          <h2>Recent</h2>
          @if (recents.items().length > 0) {
            <button class="link" (click)="recents.clear()">Clear</button>
          }
        </header>

        @if (recents.items().length === 0) {
          <p class="none">Nothing yet. What you open shows up here.</p>
        } @else {
          <ul>
            @for (item of recents.items(); track item.path) {
              <li [class.missing]="item.missing === true">
                <button class="row" [title]="item.path" [disabled]="item.missing === true" (click)="open(item)">
                  <span class="kind">{{ item.kind === 'epub' ? '▤' : '▦' }}</span>
                  <span class="name">{{ item.title }}</span>
                  @if (item.managed) {
                    <span class="tag" title="Cast by Foundry and not yet saved anywhere you chose">workspace</span>
                  }
                  @if (item.missing) {
                    <span class="tag gone">not there any more</span>
                  }
                  <span class="when">{{ when(item.openedAt) }}</span>
                </button>
                <button class="x" (click)="recents.forget(item.path)" title="Forget this one">✕</button>
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow-y: auto; background: var(--bg-base); }

    .home {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 64px;
      display: flex;
      flex-direction: column;
      gap: 40px;
    }

    .hero { text-align: center; }
    .mark { font-size: 40px; color: var(--accent); line-height: 1; }
    .hero h1 { margin: 10px 0 4px; font-size: 24px; font-weight: 700; }
    .hero p { margin: 0 0 24px; font-size: 13px; color: var(--text-tertiary); }

    .target {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 160px;
      border: 2px dashed var(--border-default);
      border-radius: var(--radius);
      color: var(--text-tertiary);
      font-size: 13px;
      background: var(--bg-sunken);
      transition: border-color 150ms ease, color 150ms ease;
    }
    .target:hover { border-color: var(--accent); color: var(--text-secondary); }

    .actions { display: flex; gap: 8px; justify-content: center; margin-top: 20px; }

    .recents header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
    .recents h2 {
      flex: 1;
      margin: 0;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary); font-weight: 600;
    }
    .none { margin: 0; font-size: 13px; color: var(--text-tertiary); }

    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: center; border-bottom: 1px solid var(--border-subtle); }
    li:last-child { border-bottom: none; }

    .row {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 10px;
      padding: 10px 8px;
      background: transparent; border: none; border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 13px; text-align: left; cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .row:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
    .row:disabled { cursor: default; opacity: 0.55; }

    .kind { flex: 0 0 auto; opacity: 0.6; font-size: 12px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .when { flex: 0 0 auto; font-size: 11px; color: var(--text-tertiary); }

    .tag {
      flex: 0 0 auto;
      font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
      padding: 2px 8px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
    }
    .tag.gone { background: var(--error-soft); color: var(--error); }

    /* Primary / secondary / ghost, one shape apart: 32px tall, 6px radius, the
       label at 13px/500. */
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover { background: var(--accent-hover); }
    .primary:active { background: var(--accent-active); transform: scale(0.98); }
    .ghost {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active { background: var(--bg-active); transform: scale(0.98); }

    .link {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
    }
    .link:hover { color: var(--accent); }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
      padding: 6px; border-radius: var(--radius-sm);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
})
export class HomeComponent {
  protected readonly recents = inject(RecentsService);
  protected readonly tabs = inject(TabsService);
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  constructor() {
    // Re-read every time Home is constructed, which is every time it comes back
    // on screen. There is no push channel for recents and there should not be:
    // this is the only screen that reads the list.
    void this.recents.refresh();
  }

  protected open(item: RecentDocument): void {
    if (item.missing === true) return;
    void this.tabs.openFile(item.path, item.managed);
  }

  protected settings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /** Coarse on purpose — the exact minute a book was opened is nobody's question. */
  protected when(at: number): string {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(at).toLocaleDateString();
  }
}
