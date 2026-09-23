import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { canCleanFrom } from '@shared/stages';
import type { SnapCategorizeResult, SnapEngine, SnapProgress } from '@shared/snap-categorize';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/** Where the snap folder and the chosen window are remembered, per machine. */
const HOME_KEY = 'foundry.snap.home';
const CONTEXT_KEY = 'foundry.snap.window';
const ENGINE_KEY = 'foundry.snap.engine';

/**
 * The model windows offered. A group of blocks with its guide and contents is a
 * few thousand tokens (shared/snap-categorize.ts, buildGroups), so a small
 * window is enough — and a model started with one loads faster and leaves the
 * card freer. The run refuses by name if one group will not fit.
 */
const CONTEXTS: readonly number[] = [8_192, 16_384, 32_768];

function remembered(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* a convenience, never a requirement */ }
}

/**
 * CATEGORIZE — snap asked what every block of the book is.
 *
 * Owen, 2026-09-22: *"the tile will bring up the 9b, load the entire book in, ask
 * questions about every block, and recategorize them accordingly. then itll show
 * the updated categories when it's done."* The run is main's
 * (electron/snap-categorize.ts); this card starts it, shows each stage as it
 * happens, and says what it came to. The updated categories are then simply the
 * book: the run lands an ordinary edit step, and the pane draws it.
 *
 * AN EXPERIMENT outside Crucible — the card says so, and says that it takes the
 * graphics card for the length of the run.
 */
@Component({
  selector: 'app-snap-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="scrim" (click)="closeIfIdle()"></div>
    <div class="card" role="dialog" aria-modal="true" aria-label="Categorize blocks">
      <header class="head">
        <span class="title">Categorize blocks</span>
        <span class="tag">experiment · snap</span>
      </header>

      <div class="body">
        @if (projectDir() === null) {
          <p class="lead">Open a book first. Categorizing needs a book at the position you are standing on.</p>
        } @else {
          <p class="lead">
            Brings up a model, asks it what every block of the book is — chapter heading, section heading,
            body text, list or contents entry, quotation, caption or note — and lets it go. Confident changes
            land as one edit step; a book with no table of contents gets chapter markers too.
          </p>

          <label class="field">
            <span>snap folder</span>
            <input type="text" [(ngModel)]="snapHome" [disabled]="busy()" placeholder="C:\\...\\snap" />
          </label>

          <label class="field">
            <span>Where the model runs</span>
            <select [(ngModel)]="engine" [disabled]="busy()">
              <option ngValue="crucible">A Crucible server (vLLM) — the server's analysis model, leased for the run</option>
              <option ngValue="local">This machine (llama.cpp) — Qwen3.5 9B from the snap folder</option>
            </select>
          </label>

          @if (engine === 'local') {
            <label class="field">
              <span>Model window (tokens)</span>
              <select [(ngModel)]="contextTokens" [disabled]="busy()">
                @for (size of contexts; track size) {
                  <option [ngValue]="size">{{ size.toLocaleString() }}</option>
                }
              </select>
            </label>
          }

          <label class="field">
            <span>Change a block only when at least this sure</span>
            <input type="number" min="0.3" max="0.99" step="0.05" [(ngModel)]="minConfidence" [disabled]="busy()" />
          </label>

          <p class="note">
            Blocks are judged a couple of dozen at a time, each seen with the blocks around it, the section it
            sits in, the publisher's markup (as a weak hint) and the book's table of contents.
            This takes the graphics card for the length of the run.
          </p>
        }

        @if (progress(); as p) {
          <p class="status" [class.bad]="p.phase === 'failed'">{{ p.message }}</p>
          @if (p.total) {
            <div class="bar"><div class="fill" [style.width.%]="(p.done ?? 0) * 100 / p.total"></div></div>
          }
        }

        @if (result(); as r) {
          <ul class="tally">
            <li>{{ r.asked.toLocaleString() }} blocks asked{{ ', in ' + r.windows + ' groups' }}</li>
            <li>{{ r.changed.toLocaleString() }} recategorized, {{ r.chapters }} chapter marker(s) added</li>
            <li>{{ r.lowConfidence.toLocaleString() }} left as they were because the model was unsure</li>
            <li>Answered by {{ r.answeredBy }}.</li>
            <li>{{ r.startedModel ? 'The model was let go when the run finished.' : 'An already-running model was used and left running.' }}</li>
            <li class="path">Every answer: {{ r.reportPath }}</li>
          </ul>
        }
      </div>

      <footer class="foot">
        @if (busy()) {
          <button class="ghost" (click)="cancel()">Cancel</button>
        } @else {
          <button class="ghost" (click)="ui.closeSnap()">Close</button>
          <button class="primary" [disabled]="!canStart()" (click)="start()">Categorize</button>
        }
      </footer>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }
    .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(4px); }
    .card {
      position: relative;
      width: min(560px, calc(100vw - 48px));
      max-height: calc(100vh - 96px);
      margin: 64px auto 0;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
    }
    .head { padding: 16px 20px 8px; display: flex; align-items: baseline; gap: 10px; }
    .title { font-family: var(--font-display); font-size: 15px; font-weight: 600; }
    .tag { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
    .body { padding: 0 20px 8px; overflow-y: auto; }
    .lead { margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: var(--text-primary); }
    .note { margin: 4px 0 12px; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
    .field { display: flex; flex-direction: column; gap: 4px; margin: 0 0 10px; font-size: 12px; color: var(--text-secondary); }
    .field input, .field select {
      height: 30px; padding: 0 8px;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default); border-radius: var(--radius-md);
      font-size: 13px;
    }
    .status { margin: 8px 0 6px; font-size: 13px; color: var(--text-primary); }
    .status.bad { color: var(--error); }
    .bar { height: 4px; border-radius: 2px; background: var(--bg-input); overflow: hidden; margin-bottom: 10px; }
    .fill { height: 100%; background: var(--accent-strong); transition: width 200ms linear; }
    .tally { margin: 6px 0 8px; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--text-primary); }
    .tally .path { color: var(--text-secondary); font-size: 12px; word-break: break-all; }
    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 20px 16px; border-top: 1px solid var(--border-subtle);
    }
    .ghost, .primary {
      height: 32px; padding: 0 16px; border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; cursor: pointer;
    }
    .ghost { background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary); }
    .primary { border: none; background: var(--accent-strong); color: var(--text-inverse); }
    .primary:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class SnapDialogComponent implements OnDestroy {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  protected readonly contexts = CONTEXTS;
  protected snapHome = remembered(HOME_KEY) ?? '';
  protected contextTokens = Number(remembered(CONTEXT_KEY) ?? 16_384);
  protected engine: SnapEngine = remembered(ENGINE_KEY) === 'local' ? 'local' : 'crucible';
  protected minConfidence = 0.6;

  protected readonly busy = signal(false);
  protected readonly progress = signal<SnapProgress | null>(null);
  protected readonly result = signal<SnapCategorizeResult | null>(null);

  /** The project whose book is at a position that has one — the Clean tile's own test. */
  protected readonly projectDir = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return null;
    if (!canCleanFrom(project, this.ledger.standingIn(project.dir))) return null;
    return project.dir;
  });

  private readonly unsubscribe = api?.snap.onProgress((p) => {
    if (p.projectDir === '' || p.projectDir === this.projectDir()) this.progress.set(p);
  }) ?? null;

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  protected canStart(): boolean {
    return this.projectDir() !== null && this.snapHome.trim().length > 0 && !this.busy();
  }

  protected async start(): Promise<void> {
    const dir = this.projectDir();
    if (dir === null || !api) return;
    remember(HOME_KEY, this.snapHome.trim());
    remember(CONTEXT_KEY, String(this.contextTokens));
    remember(ENGINE_KEY, this.engine);
    this.busy.set(true);
    this.result.set(null);
    this.progress.set({ projectDir: dir, phase: 'starting', message: 'Starting…' });
    try {
      const done = await api.snap.categorize(dir, {
        engine: this.engine,
        snapHome: this.snapHome.trim(),
        contextTokens: this.contextTokens,
        minConfidence: this.minConfidence,
      });
      this.result.set(done);
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
      this.progress.set({ projectDir: dir, phase: 'failed', message });
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(): void {
    void api?.snap.cancel();
  }

  protected closeIfIdle(): void {
    if (!this.busy()) this.ui.closeSnap();
  }
}
