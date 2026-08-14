import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, viewChild,
} from '@angular/core';

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
 *
 * ── It is also where a batch is committed ───────────────────────────────────
 *
 * Engine jobs arrive HELD (electron/job-queue.ts): configured, ordered, visible
 * and idle. So this shelf is no longer only a report — it is the one place the
 * user says "run these", and three things follow from that.
 *
 * A HELD ROW MUST NOT LOOK LIKE A QUEUED ONE. They are both "not running yet"
 * and the difference between them is who is being waited on: the machine, or
 * the person looking at the shelf. A held row is accented, ruled down its left
 * edge so a run of them reads as one batch, and says "Waiting for Start" in
 * words — colour alone would be a state that only some people can see.
 *
 * THE ✕ MEANS TWO DIFFERENT THINGS AND SAYS SO. On a running job it cancels; on
 * a held or queued one it REMOVES, leaving nothing behind, because a job that
 * never ran has nothing to record and a "Cancelled" row for it is clutter in
 * exactly the list somebody is using to see what they have assembled.
 *
 * START CARRIES THE COUNT. The number is what is being committed to, and a
 * disabled-but-present button keeps the footer from changing shape as rows come
 * and go.
 */
@Component({
  selector: 'app-queue-shelf',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      WHAT JUST HAPPENED, said out loud. The OCR dialog closes on Add now and
      moves focus here, so the confirmation it used to leave on screen has to
      arrive some other way for anybody not watching the shelf. Polite rather
      than assertive: a job being queued is news, not an interruption.
    -->
    <p class="sr-only" role="status" aria-live="polite">{{ ui.shelfSaid() }}</p>

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
                  <!--
                    TWO GESTURES THAT LOOK THE SAME AND ARE NOT. A running job is
                    CANCELLED — a child is holding a GPU, stopping it is a real
                    event, and the row that records it afterwards is worth having.
                    A held or queued job is REMOVED: it never ran, so there is
                    nothing to stop, and a "Cancelled" row for a batch item
                    somebody simply changed their mind about is residue in the
                    one list they are using to see what they have assembled.
                    Same ✕, different verb, and the titles say which.
                  -->
                  @if (job.state === 'held' || job.state === 'queued') {
                    <button class="x" (click)="queue.remove(job.id)"
                            title="Remove from the queue"
                            [attr.aria-label]="'Remove ' + label(job) + ' from the queue'">✕</button>
                  } @else if (job.state === 'running') {
                    <button class="x" (click)="queue.cancel(job.id)"
                            title="Cancel"
                            [attr.aria-label]="'Cancel ' + label(job)">✕</button>
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

                      A REAL-TEXT PDF OPENS, and needs nothing new to do it: the
                      tab kinds are epub and pdf, and what this job made is a PDF.
                      Opening it is also how anybody judges it — the pages keep
                      the scan's layout and lose the scan's grey, and whether the
                      model read them right is a thing you look at.

                      A TRANSLATION OPENS for the same reason as a conversion:
                      what it made is an EPUB, and the tab that reads one already
                      exists.
                    -->
                    @if (job.kind === 'epub' || job.kind === 'pdf' || job.kind === 'translate') {
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
                  <!--
                    "Waiting for Start" and not "Queued", because the two are
                    different facts and the user is the difference. A queued job
                    is behind a machine that is busy and will reach it; a held
                    one is behind a button nobody has pressed, and a shelf that
                    called both "Queued" would leave somebody watching a still
                    list wondering whether the app had hung.
                  -->
                  @case ('held') { <span class="sub hold">Waiting for Start</span> }
                  @case ('queued') { <span class="sub">{{ job.message ?? 'Queued' }}</span> }
                  @case ('done') {
                    <span class="sub ok" [title]="job.message ?? ''">
                      @if (job.kind === 'env-install') { Installed } @else { Done · {{ baseName(job.outputPath) }} }
                    </span>
                  }
                  @case ('cancelled') { <span class="sub">Cancelled</span> }
                  @case ('failed') { <span class="sub bad" [title]="job.error ?? ''">{{ failureLine(job.error) }}</span> }
                }
              </div>
            }

            <!--
              START IS THE PRIMARY ACTION AND SITS WHERE A PRIMARY ACTION SITS —
              last in the footer, on the right, the way every dialog in this app
              puts its commit button. It carries the COUNT because the number is
              the thing being committed to: "Start 4" is a person confirming the
              batch they just assembled, where a bare "Start" would be a button
              they press to find out what happens.

              Disabled with nothing held rather than hidden, so the shelf does
              not change shape as rows are added and released — a control that
              appears and disappears under the cursor is one people learn to
              distrust. The aria-label spells the count out, because "Start 4"
              read aloud is not obviously four jobs.
            -->
            <div class="shelf-foot">
              <button class="ghost" [disabled]="queue.finished().length === 0"
                      (click)="queue.clearFinished()">Clear finished</button>
              <button #start class="primary" [disabled]="queue.held().length === 0"
                      [attr.aria-label]="startLabel()"
                      [title]="startLabel()"
                      (click)="queue.start()">
                Start@if (queue.held().length > 0) { <span>&nbsp;{{ queue.held().length }}</span> }
              </button>
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    /* Read, never seen. Clipped rather than display:none or visibility:hidden,
       because both of those take the element out of the accessibility tree and
       a live region nothing can reach announces nothing. */
    .sr-only {
      position: absolute;
      width: 1px; height: 1px;
      margin: -1px; padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }

    .shelf {
      position: fixed;
      right: 16px;
      /*
        CLEAR OF THE DOCK. The tool rail runs along the bottom of the window now,
        and this pill is fixed at z-index 900 — above the rail's 40 — so 16px
        would put it squarely over the Settings button at the dock's right-hand
        end. The ladder is unchanged and still holds (viewer < shield 30 <
        rail 40 < shelf 900 < dialogs 1200); what changed is that the shelf has
        to be told where the bottom of the DOCUMENT area is, which is the token.
      */
      bottom: calc(var(--rail-h) + 16px);
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
    /*
      A held row reads as WAITING FOR SOMEBODY rather than as inert. The accent
      is the same one the Start button carries, so the row and the control that
      releases it are visibly the same subject; the left rule is what makes a
      run of them legible as a BATCH at a glance, which is the thing being
      assembled. Colour is not the only carrier — the row also says "Waiting for
      Start" in words, because a state told only in hue is a state somebody who
      cannot see the hue does not have.
    */
    .row[data-state='held'] {
      background: var(--accent-soft);
      box-shadow: inset 2px 0 0 var(--accent);
    }
    .sub.hold { color: var(--accent); }

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

    .shelf-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; }
    .ghost { height: 26px; padding: 0 10px; font-size: 12px; }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }

    /* The dialogs' primary button, at the shelf's smaller scale — same tokens,
       same states, so Start reads as the same kind of commit as "Add to queue". */
    .primary {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 600; line-height: 1;
      cursor: pointer;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class QueueShelfComponent {
  protected readonly queue = inject(QueueService);
  protected readonly ui = inject(UiService);
  private readonly tabs = inject(TabsService);

  private readonly start = viewChild<ElementRef<HTMLButtonElement>>('start');

  constructor() {
    /*
     * FOCUS ARRIVES FROM THE OCR DIALOG, one press at a time.
     *
     * The counter is read and the button is focused in a microtask, because the
     * shelf may have been collapsed a moment ago: `focusShelf` unrolls it in the
     * same tick, and the button does not exist in the DOM until that render has
     * happened. Focusing a button that is not there yet silently does nothing,
     * which is the failure this ordering exists to avoid.
     */
    effect(() => {
      if (this.ui.focusShelfAt() === 0) return;
      queueMicrotask(() => this.start()?.nativeElement.focus());
    });
  }

  /**
   * The pill's one line: what is running, and how many are waiting behind it.
   * Jobs run one at a time, so "3 queued" is a wait, not a parallelism.
   */
  protected readonly headline = computed(() => {
    const active = this.queue.running();
    const waiting = this.queue.queued().length;
    const held = this.queue.held().length;
    if (active) {
      const name = label(active);
      const behind = [
        waiting > 0 ? `${waiting} queued` : null,
        held > 0 ? `${held} held` : null,
      ].filter((part) => part !== null);
      return behind.length > 0 ? `${name} · ${behind.join(', ')}` : name;
    }
    /*
     * A HELD BATCH IS THE HEADLINE WHEN NOTHING IS RUNNING, and it outranks the
     * finished count deliberately: the pill is collapsed most of the time, and a
     * shelf reading "3 finished" over three jobs that are sitting there waiting
     * to be started is the one state where the summary would actively mislead —
     * it says the work is done when none of it has begun.
     */
    if (held > 0) return `${held} waiting for Start`;
    const failed = this.queue.failed().length;
    if (failed > 0) return `${failed} failed`;
    return `${this.queue.finished().length} finished`;
  });

  /** What the Start button says to a screen reader, and on hover. */
  protected readonly startLabel = computed(() => {
    const held = this.queue.held().length;
    if (held === 0) return 'Nothing is waiting to start';
    return held === 1 ? 'Start the 1 job waiting' : `Start the ${held} jobs waiting`;
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
    /*
     * A translation counts PARAGRAPHS, and the noun has to change with the
     * number. "Translating 412 / 2,081 pages" for a 300-page book is a
     * measurement of the wrong thing, and the counts are grouped because the
     * right-hand side of this fraction reaches four digits on a real book —
     * which is also the honest signal that this job runs for hours.
     */
    if (p.phase === 'translate') {
      return note(`Translating ${p.page.toLocaleString()} / ${p.total.toLocaleString()} blocks`, job);
    }
    const verb = p.phase === 'render' ? 'Rendering' : 'Reading';
    return note(`${verb} ${p.page} / ${p.total} pages`, job);
  }

  /** An env install names itself; a conversion is named by its document. */
  protected label(job: Job): string {
    return label(job);
  }

  protected baseName(filePath: string): string {
    return baseName(filePath);
  }

  /**
   * What actually went wrong, out of the engine's whole stderr.
   *
   * THE FIRST LINE IS NEVER THE ANSWER, and showing it was a bug that hid every
   * failure this app can have. `job.error` is the engine's ENTIRE stderr, and
   * foundry's first line is always a configuration echo — which endpoint it is
   * using and which file said so. Every failed conversion therefore reported
   * the same harmless sentence, whatever had actually happened, and the real
   * message sat at the far end of a string nobody could see.
   *
   * The engine's contract makes the right line findable: `src/cli.ts` prints a
   * fatal as `foundry: <message>` and exits, so the LAST line beginning that
   * way is the failure. A run that died without one — killed, or a crash in a
   * child — has no such line, and then the last thing it managed to say is the
   * most informative thing there is.
   *
   * The whole stderr stays in the row's `title`, because the sentence is the
   * headline and the progress above it is often the context that explains it.
   */
  protected failureLine(error: string | undefined): string {
    const lines = (error ?? '').split('\n').map((line) => line.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return 'Failed';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (line.startsWith('foundry:')) return line.slice('foundry:'.length).trim() || line;
    }
    return lines[lines.length - 1]!;
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

/**
 * The count, and what the engine has said since it last moved.
 *
 * A COUNT ALONE CANNOT TELL WORKING FROM WEDGED, and that is not a theoretical
 * complaint: a block that draws a sixteen-thousand-character answer takes two
 * minutes, is rejected, and is asked twice more — six minutes on one fraction
 * while the engine talks the whole time. This shelf showed the fraction and
 * nothing else, which is precisely what a hung job looks like, and a person
 * watching a job they believe is hung kills it.
 *
 * `note` is null on a run that is simply progressing (see Job.note), so the
 * ordinary case is the line it always was. The engine's own words are used
 * verbatim and merely shortened — paraphrasing a diagnostic is how the shelf
 * would end up saying something the log does not.
 */
function note(count: string, job: Job): string {
  const said = job.note?.trim();
  if (said === undefined || said.length === 0) return count;
  // The prefix is the command's, on every line, and it is redundant here: the
  // row already says which job this is.
  const bare = said.replace(/^(translate|vlm-convert):\s*/, '');
  const short = bare.length > NOTE_CHARS ? `${bare.slice(0, NOTE_CHARS - 1)}…` : bare;
  return `${count} · ${short}`;
}

/**
 * How much of a note fits. The shelf row is one line and the count has to stay
 * readable at the left of it — a note that pushed the fraction off the row
 * would trade one missing fact for another.
 */
const NOTE_CHARS = 80;
