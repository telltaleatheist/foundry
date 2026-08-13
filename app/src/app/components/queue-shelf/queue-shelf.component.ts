import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import type { Job } from '@shared/types';

import { QueueService } from '../../core/queue.service';
import { TabsService } from '../../core/tabs.service';
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
                  <span class="name" [title]="job.inputPath">{{ label(job) }}</span>
                  @if (job.state === 'queued' || job.state === 'running') {
                    <button class="x" (click)="queue.cancel(job.id)" title="Cancel">✕</button>
                  } @else if (job.state === 'done' && job.kind !== 'env-install') {
                    <!--
                      Open comes FIRST because it is what a finished conversion is
                      for. Reveal stays beside it: the book is in the app's
                      workspace until it is saved a copy of, and "where is it
                      actually" is a fair question to be able to answer.

                      A text conversion gets REVEAL AND NO OPEN, and that is the
                      whole of this app's answer to a .txt. There is no generic
                      viewer here — a tab is a PDF in an iframe or an unpacked
                      book with a chapter list and an editor — so a text tab would
                      be a third kind that could use neither, threaded through the
                      tab strip, the recents and the file allow-list to show a
                      file every OS already opens. Reveal is one button and points
                      at the thing that was actually made.

                      A SEARCHABLE PDF OPENS, and needs nothing new to do it: the
                      tab kinds are epub and pdf, and what this job made is a PDF.
                      That is also the only way to see that it worked — the file
                      looks exactly like the scan until somebody searches it.
                    -->
                    @if (job.kind === 'epub' || job.kind === 'pdf') {
                      <button class="open" (click)="open(job)"
                              [title]="job.kind === 'pdf' ? 'Open this PDF in a tab' : 'Open this book in a tab'">Open</button>
                    }
                    <button class="x" (click)="reveal(job)" title="Show it in the file manager">↗</button>
                  }
                </div>

                @switch (job.state) {
                  @case ('running') {
                    <!--
                      Indeterminate whenever there is no honest fraction: an env
                      install only counts bytes during its download phase, and a
                      bar that kept moving through a sha256 of five gigabytes
                      would be an animation, not a measurement.
                    -->
                    <div class="bar" [class.indeterminate]="!determinate(job)">
                      <div class="fill" [style.width.%]="percent(job)"></div>
                    </div>
                    <span class="sub">{{ progressText(job) }}</span>
                  }
                  @case ('queued') { <span class="sub">{{ job.message ?? 'Queued' }}</span> }
                  @case ('done') {
                    <span class="sub ok" [title]="job.message ?? ''">
                      @if (job.kind === 'env-install') { Installed } @else { Done · {{ baseName(job.outputPath) }} }
                    </span>
                  }
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
      border-radius: var(--radius-lg);
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
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
    .head-text {
      flex: 1; min-width: 0;
      font-family: var(--font-display); font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
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
    .bar.indeterminate .fill { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(320%); }
    }

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

    .sub { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub.ok { color: var(--ok); }
    .sub.bad { color: var(--error); white-space: normal; }

    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 12px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .open, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 auto;
      height: 22px; padding: 0 8px;
      border-radius: var(--radius-sm);
      font-size: 11px; font-weight: 500; line-height: 1;
      cursor: pointer;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .open:hover, .ghost:hover:not(:disabled) {
      background: var(--bg-hover); border-color: var(--border-strong);
    }

    .shelf-foot { display: flex; justify-content: flex-end; padding: 8px 12px; }
    .ghost { height: 26px; padding: 0 10px; font-size: 12px; }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class QueueShelfComponent {
  protected readonly queue = inject(QueueService);
  protected readonly ui = inject(UiService);
  private readonly tabs = inject(TabsService);

  /**
   * The pill's one line: what is running, and how many are waiting behind it.
   * Jobs run one at a time, so "3 queued" is a wait, not a parallelism.
   */
  protected readonly headline = computed(() => {
    const active = this.queue.running();
    const waiting = this.queue.queued().length;
    if (active) {
      const name = label(active);
      return waiting > 0 ? `${name} · ${waiting} queued` : name;
    }
    const failed = this.queue.failed().length;
    if (failed > 0) return `${failed} failed`;
    return `${this.queue.finished().length} finished`;
  });

  /** True when the bar has a real fraction behind it. See the template's note. */
  protected determinate(job: Job): boolean {
    if (job.kind === 'env-install') return job.envProgress?.phase === 'download';
    return (job.progress?.total ?? 0) > 0;
  }

  protected percent(job: Job): number {
    if (job.kind === 'env-install') return job.envProgress?.percent ?? 0;
    const p = job.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.page / p.total) * 100));
  }

  protected progressText(job: Job): string {
    if (job.kind === 'env-install') {
      const phase = job.envProgress?.phase;
      const verb = phase === 'download' ? 'Downloading'
        : phase === 'verify' ? 'Verifying'
          : phase === 'unpack' ? 'Unpacking'
            : phase === 'configure' ? 'Configuring'
              : 'Starting';
      return `${verb} · ${job.message ?? ''}`;
    }
    const p = job.progress;
    if (!p) return job.message ?? 'Starting…';
    const verb = p.phase === 'render' ? 'Rendering' : 'Reading';
    return `${verb} ${p.page} / ${p.total} pages`;
  }

  /** An env install names itself; a conversion is named by its document. */
  protected label(job: Job): string {
    return label(job);
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

  /**
   * Open a finished conversion in a tab.
   *
   * `managed: true` — the book is still only in the workspace, so the tab gets
   * the unsaved dot. Re-opening one that is already open just focuses its tab
   * (TabsService), so this button is safe to press twice.
   */
  protected open(job: Job): void {
    void this.tabs.openFile(job.outputPath, true);
  }
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function label(job: Job): string {
  return job.title ?? baseName(job.inputPath);
}
