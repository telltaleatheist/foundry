import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import type { ProjectDocument, ProjectSummary } from '@shared/types';

import { api } from '../../core/foundry';
import { ProjectsService } from '../../core/projects.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * Home — what the app is when nothing is open.
 *
 * Three things, in the order a person needs them: the books they have worked on,
 * a target big enough to drop a book on without aiming, and the two actions
 * worth a button. The drop target is decorative in the strict sense — the WHOLE
 * WINDOW accepts a drop (see App) — but a rectangle that says "drop here" is how
 * anybody knows that.
 *
 * ── The list is PROJECTS, not files ──────────────────────────────────────────
 *
 * A row is a BOOK — one folder holding the scan, the cast EPUB, a translation, a
 * searchable PDF — and the tags on it are the answer to "what has been made from
 * this?", which a flat list of filenames could not give. Expanding a row is how
 * any one of those is opened, because the interesting question ("open the
 * English one") is a question about the book first and the file second.
 *
 * A row is never REMOVED from here. There is no Clear and no ✕, deliberately:
 * the old list was a cache of names and forgetting one cost nothing, but this
 * one is the library itself, and a button that made a book disappear from the
 * only screen that lists it would be a delete button wearing a nicer word.
 * Reveal is the escape hatch — the folder is right there, and it is the user's.
 *
 * IT IS ALSO WHAT AN EMPTY COLUMN SHOWS. Ctrl+\ makes a column with nothing in
 * it, and the useful thing to put in a column with nothing in it is the library
 * — so opening a book from this list lands in the column you are looking at.
 * When it is drawn as a column rather than as the whole window it carries a ✕,
 * because a column you asked for and changed your mind about has to be a column
 * you can put away; the ✕ closes the COLUMN and never a document.
 */
@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (closable()) {
      <button class="close-column" title="Close this column" (click)="closeColumn()">✕</button>
    }

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
          <h2>Your books</h2>
        </header>

        @if (projects.items().length === 0) {
          <p class="none">Nothing yet. A book you open or convert becomes a project here.</p>
        } @else {
          <ul>
            @for (project of projects.items(); track project.key) {
              <li>
                <button
                  class="row"
                  [title]="project.dir"
                  [attr.aria-expanded]="projects.expanded().has(project.key)"
                  (click)="projects.toggle(project.key)"
                >
                  <span class="kind">{{ projects.expanded().has(project.key) ? '▾' : '▸' }}</span>
                  <span class="name">{{ project.title }}</span>
                  @if (project.problem !== null) {
                    <span class="tag gone" [title]="project.problem">catalogue unreadable</span>
                  } @else {
                    @for (made of tags(project); track made) {
                      <span class="tag">{{ made }}</span>
                    }
                    @if (project.filed) {
                      <span class="tag" title="A copy has been filed in this project's own folder">filed</span>
                    }
                  }
                  <span class="when">{{ project.openedAt > 0 ? when(project.openedAt) : '' }}</span>
                </button>
                <button class="x" (click)="reveal(project)" title="Show this project's folder">⌕</button>
              </li>

              @if (projects.expanded().has(project.key)) {
                @if (project.problem !== null) {
                  <li class="detail">
                    <p class="none">{{ project.problem }}</p>
                  </li>
                } @else {
                  @for (document of project.documents; track document.path) {
                    <li class="detail" [class.missing]="document.missing">
                      <button
                        class="row"
                        [title]="document.label"
                        [disabled]="document.missing || document.kind === 'txt'"
                        (click)="open(document)"
                      >
                        <span class="kind">{{ document.kind === 'epub' ? '▤' : document.kind === 'pdf' ? '▦' : '≡' }}</span>
                        <span class="name">{{ document.label }}</span>
                        @if (document.missing) {
                          <span class="tag gone">not there any more</span>
                        }
                        <span class="when">{{ document.at > 0 ? when(document.at) : '' }}</span>
                      </button>
                    </li>
                  }
                  @if (project.documents.length === 0) {
                    <li class="detail">
                      <p class="none">Nothing has been made from this book yet.</p>
                    </li>
                  }
                }
              }
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { position: relative; display: block; height: 100%; overflow-y: auto; background: var(--bg-base); }

    /* Sticky rather than absolute: this host scrolls, and a corner button that
       scrolled away with the hero would be missing exactly when a long recents
       list made the column feel permanent. */
    .close-column {
      position: sticky;
      top: 8px;
      float: right;
      margin-right: 8px;
      z-index: 1;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
      padding: 4px 6px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .close-column:hover { background: var(--bg-hover); color: var(--text-primary); }

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

    /* A document inside a project: indented, hairlined off, and quieter than
       the book it belongs to — the row above is the thing being chosen between,
       and these are what that choice contains. */
    li.detail { border-bottom: none; padding-left: 22px; }
    li.detail .row { padding-top: 6px; padding-bottom: 6px; font-size: 12px; }
    li.detail .none { padding: 6px 8px; font-size: 12px; }

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
  /**
   * The column this is filling, when it is filling one.
   *
   * Null — the default — is Home as the WHOLE WINDOW, which is what the app is
   * with nothing open. The input exists only so the ✕ knows what it would be
   * closing; everything else on this screen is the same either way.
   */
  readonly pane = input<string | null>(null);

  protected readonly projects = inject(ProjectsService);
  protected readonly tabs = inject(TabsService);
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  /**
   * Only with a neighbour to go back to. Closing the only column would leave
   * zero columns, which draws this same screen across the same window — a
   * button whose whole effect is invisible is a button that teaches people the
   * app does not respond.
   */
  protected readonly closable = computed(() =>
    this.pane() !== null && this.tabs.panes().length > 1);

  protected closeColumn(): void {
    const id = this.pane();
    if (id !== null) this.tabs.closePane(id);
  }

  constructor() {
    // Re-read every time Home is constructed, which is every time it comes back
    // on screen. There is no push channel for the project list and there should
    // not be: the things that change it are conversions, which the queue already
    // broadcasts, and this is the only screen that reads it.
    void this.projects.refresh();
  }

  /**
   * What has been made from this book, as short tags on its row.
   *
   * WHAT IT IS, never where it lives: `cast`, `searchable`, `translation`. The
   * folders those documents actually sit in are this app's bookkeeping and the
   * user never has to learn them. Deduplicated, because a book with three
   * translations says "translation" once and expands to name them — the row
   * answers "has this been cast yet?" at a glance, and three language tags in a
   * row answers something else.
   *
   * An imported document contributes no tag: "you gave me this book" is not an
   * answer to what has been made from it.
   */
  protected tags(project: ProjectSummary): string[] {
    const seen = new Set<string>();
    for (const document of project.documents) {
      if (document.role === 'archive' || document.role === 'imported') continue;
      seen.add(document.role === 'text' ? 'plain text' : document.role);
    }
    return [...seen];
  }

  /**
   * Open one document out of a project.
   *
   * `managed` decides whether the tab wears the unsaved dot, and the answer
   * differs inside one project: a cast book exists only because Foundry made it,
   * so nothing the user chose holds a copy — but an IMPORTED document is their
   * own, sitting in a folder of their own, and a dot on it would be a warning
   * about a loss that cannot happen.
   *
   * A `.txt` is listed and never opened: there is no text tab in this app, and a
   * row that opened an empty viewer would be worse than a row that is plainly
   * inert. Reveal is on the project.
   */
  protected open(document: ProjectDocument): void {
    if (document.missing || document.kind === 'txt') return;
    void this.tabs.openFile(document.path, document.managed);
  }

  /** The folder itself, in Explorer/Finder. The one way out of this app. */
  protected reveal(project: ProjectSummary): void {
    void api?.reveal(project.dir);
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
