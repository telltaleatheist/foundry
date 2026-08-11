import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import type { Job } from '@shared/types';

import { QueueService } from '../../core/queue.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * The queue shelf — docked bottom-right, collapsed to a pill, unrolling upward.
 *
 * Modelled on BookForge's setup-download-dock: the same anatomy (a head that is
 * also the toggle, an aggregate bar, a scrolling item list, a footer with the
 * one destructive action) without its drag-to-move or its downloader wiring.
 *
 * It shows what MAIN says. Nothing here is optimistic: a cancel is a request,
 * and the row changes when the process actually stopped.
 */
@Component({
  selector: 'app-queue-shelf',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (queue.jobs().length > 0) {
      <div class="shelf" [class.expanded]="ui.shelfExpanded()">
        <button class="shelf-head" (click)="ui.shelfExpanded.set(!ui.shelfExpanded())">
          @if (queue.running()) {
            <span class="spinner"></span>
          } @else if (queue.failed().length > 0) {
            <span class="mark bad">!</span>
          } @else {
            <span class="mark ok">✓</span>
          }
          <span class="head-text">{{ headline() }}</span>
          <span class="chev">{{ ui.shelfExpanded() ? '▾' : '▴' }}</span>
        </button>

        @if (queue.running(); as active) {
          <div class="aggregate">
            <div class="bar"><div class="fill" [style.width.%]="percent(active)"></div></div>
          </div>
        }

        @if (ui.shelfExpanded()) {
          <div class="shelf-body">
            @for (job of queue.jobs(); track job.id) {
              <div class="row" [attr.data-state]="job.state">
                <div class="row-top">
                  <span class="name" [title]="job.inputPath">{{ baseName(job.inputPath) }}</span>
                  @if (job.state === 'queued' || job.state === 'running') {
                    <button class="x" (click)="queue.cancel(job.id)" title="Cancel">✕</button>
                  } @else if (job.state === 'done') {
                    <button class="x" (click)="reveal(job)" title="Show the book">↗</button>
                  }
                </div>

                @switch (job.state) {
                  @case ('running') {
                    <div class="bar"><div class="fill" [style.width.%]="percent(job)"></div></div>
                    <span class="sub">{{ progressText(job) }}</span>
                  }
                  @case ('queued') { <span class="sub">Queued</span> }
                  @case ('done') { <span class="sub ok">Done · {{ baseName(job.outputPath) }}</span> }
                  @case ('cancelled') { <span class="sub">Cancelled</span> }
                  @case ('failed') { <span class="sub bad" [title]="job.error ?? ''">{{ firstLine(job.error) }}</span> }
                }
              </div>
            }

            <div class="shelf-foot">
              <button class="ghost" [disabled]="queue.finished().length === 0"
                      (click)="queue.clearFinished()">Clear finished</button>
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .shelf {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 900;
      width: 320px;
      max-width: calc(100vw - 32px);
      display: flex;
      flex-direction: column-reverse;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      font-size: 13px;
    }

    .shelf-head {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }
    .shelf-head:hover { background: var(--bg-hover); }
    .head-text { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chev { color: var(--text-tertiary); }

    .spinner {
      width: 13px; height: 13px; flex-shrink: 0;
      border: 2px solid var(--accent-soft);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .mark { flex-shrink: 0; font-weight: 700; }
    .mark.ok { color: var(--ok); }
    .mark.bad { color: var(--error); }

    .aggregate { padding: 0 12px 8px; }
    .bar { height: 4px; background: var(--bg-sunken); border-radius: 2px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }

    .shelf-body {
      border-bottom: 1px solid var(--border-subtle);
      max-height: 300px;
      overflow-y: auto;
    }

    .row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .row:last-of-type { border-bottom: none; }
    .row-top { display: flex; align-items: center; gap: 8px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .sub { font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub.ok { color: var(--ok); }
    .sub.bad { color: var(--error); white-space: normal; }

    .x { background: transparent; border: none; cursor: pointer; color: var(--text-tertiary); font-size: 12px; }
    .x:hover { color: var(--text-primary); }

    .shelf-foot { display: flex; justify-content: flex-end; padding: 8px 12px; }
    .ghost {
      font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
      background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    }
    .ghost:disabled { opacity: 0.4; cursor: default; }
    .ghost:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-tertiary); }
  `],
})
export class QueueShelfComponent {
  protected readonly queue = inject(QueueService);
  protected readonly ui = inject(UiService);

  /**
   * The pill's one line: what is running, and how many are waiting behind it.
   * Jobs run one at a time, so "3 queued" is a wait, not a parallelism.
   */
  protected readonly headline = computed(() => {
    const active = this.queue.running();
    const waiting = this.queue.queued().length;
    if (active) {
      const name = baseName(active.inputPath);
      return waiting > 0 ? `${name} · ${waiting} queued` : name;
    }
    const failed = this.queue.failed().length;
    if (failed > 0) return `${failed} failed`;
    return `${this.queue.finished().length} finished`;
  });

  protected percent(job: Job): number {
    const p = job.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.page / p.total) * 100));
  }

  protected progressText(job: Job): string {
    const p = job.progress;
    if (!p) return job.message ?? 'Starting…';
    const verb = p.phase === 'render' ? 'Rendering' : 'Reading';
    return `${verb} ${p.page} / ${p.total} pages`;
  }

  protected baseName(filePath: string): string {
    return baseName(filePath);
  }

  protected firstLine(error: string | undefined): string {
    return (error ?? 'Failed').split('\n')[0] ?? 'Failed';
  }

  protected reveal(job: Job): void {
    void api?.reveal(job.outputPath);
  }
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}
