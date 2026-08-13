import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { ConversionKind, JobRequest } from '@shared/types';

import { QueueService } from '../../core/queue.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * OCR / Convert — configure ONE conversion and put it in the queue.
 *
 * This is the old slide-out panel's body in a modal, trimmed to the choices that
 * are genuinely per-job. Three things it used to ask are gone:
 *
 *   **The endpoint URL.** Settings owns which backend reads the pages, the
 *   engine reads that same settings.json for itself, and a second field here was
 *   a second opinion about a decision with one owner.
 *
 *   **The output path.** A conversion writes into the managed workspace and
 *   OPENS IN THE APP when it is done (electron/workspace.ts); the file gets a
 *   home when the user presses Save a copy, by which time they have read some of
 *   it and know what to call it. Asking up front asked them to name a thing they
 *   had not seen.
 *
 *   **"Bank page answers".** Always on. There is no version of "read three
 *   hundred pages again because the window closed" that anyone wants, and the
 *   engine decides for itself whether a bank is a resume or a re-read.
 *
 * It ENQUEUES and nothing else. The run is main's (electron/job-queue.ts), so
 * dismissing this dialog does not touch a job that is already moving.
 */
@Component({
  selector: 'app-ocr-dialog',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeOcr()"></div>

    <!--
      The click guard is on the CARD rather than a stopPropagation on the scrim's
      handler, because the scrim is also the thing a click outside is supposed to
      land on and the two must not be the same listener.
    -->
    <div class="card" role="dialog" aria-modal="true" aria-label="OCR and convert">
      <header class="head">
        <span class="title">OCR / Convert</span>
        <button class="x" (click)="ui.closeOcr()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
          <label class="field">
            <span class="label">Source</span>
            <input type="text" [value]="input" readonly [title]="input">
          </label>

          <label class="field">
            <span class="label">Output</span>
            <select [ngModel]="kind()" (ngModelChange)="kind.set($event)" name="kind">
              <option value="epub">EPUB</option>
              <option value="txt">Plain text</option>
              <option value="pdf">Searchable PDF</option>
            </select>
          </label>

          <!--
            Said here rather than discovered afterwards: plain text is the same
            conversion and the same reading of the pages, but it is not a book
            this app can open, and finding that out from a completed job with no
            Open button on it would read as something having gone wrong.
          -->
          @if (kind() === 'txt') {
            <p class="note">
              Plain text is the same book with the markup taken off — headings, paragraphs,
              and footnotes as [1] at the end of each chapter. Pictures do not survive it,
              and Foundry cannot open a text file in a tab: the queue will show you where
              it was written.
            </p>
          }

          <!--
            Said here because a searchable PDF is not a book and looks like one
            that failed. It comes out looking EXACTLY like what went in — that is
            the point — so somebody who expected a converted book needs to know
            before they order it that the change is invisible and lives in the
            search box.
          -->
          @if (kind() === 'pdf') {
            <p class="note">
              A searchable PDF is your scan, unchanged — same pages, same images — with the
              recognised text laid over it invisibly, so search, select and copy start working.
              Nothing is rebuilt into chapters, and the running heads and page numbers are kept,
              because they are on the page. Run it again and the layer is replaced, never doubled;
              a PDF that already has text of its own is refused rather than written over.
            </p>
          }

          <label class="field">
            <span class="label">Language <em>declared, not detected</em></span>
            <input type="text" placeholder="en" [ngModel]="language()" (ngModelChange)="language.set($event)" name="language">
          </label>

          <label class="field">
            <span class="label">Skip pages <em>optional</em></span>
            <input type="text" placeholder="3,17,19-24" [ngModel]="skipPages()" (ngModelChange)="skipPages.set($event)" name="skip">
          </label>

          <!-- No strip-footnote-markers option, deliberately. The engine flag
               exists for BookForge's narration builds, where a reference number
               becomes a narrator saying "fourteen". Foundry converts books to
               be READ: markers are kept and linked to their notes, which is
               part of what converting to EPUB means here. -->
          @if (kind() === 'epub') {
            <p class="note">
              The book is written into Foundry's workspace and opens here when it is done.
              Save a copy from the tab once you have looked at it.
            </p>
          } @else if (kind() === 'pdf') {
            <!--
              Opens automatically like a finished book does — the viewer's text
              layer pane is the only way to SEE that an invisible layer worked,
              so looking at it is the next thing anybody does here too.
            -->
            <p class="note">
              The PDF is written into Foundry's workspace and opens here when it is done —
              use the Text layer button to see what was embedded, and Save a copy to put
              the file somewhere of your own.
            </p>
          } @else {
            <p class="note">
              The file is written into Foundry's workspace. Use ↗ on the finished job to
              show it in the file manager.
            </p>
          }

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeOcr()">Cancel</button>
          <button class="primary" [disabled]="busy()" (click)="add()">
            {{ busy() ? 'Working…' : 'Add to queue' }}
          </button>
        </footer>
      } @else {
        <div class="body empty">
          <p>Open a PDF first — a conversion is a thing you do to a document you have in front of you.</p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeOcr()">Close</button>
          <button class="primary" (click)="openDocument()">Open PDF…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }

    .scrim { position: absolute; inset: 0; background: rgba(9, 10, 13, 0.62); }

    .card {
      position: relative;
      margin: 8vh auto 0;
      width: 460px;
      max-width: calc(100vw - 32px);
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .title { flex: 1; font-weight: 600; font-size: 13.5px; }
    .x { background: transparent; border: none; cursor: pointer; color: var(--text-tertiary); font-size: 13px; }
    .x:hover { color: var(--text-primary); }

    .body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 13px; }
    .body.empty { color: var(--text-tertiary); font-size: 13px; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 4px; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; opacity: 0.7; }

    .check { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: var(--text-secondary); }
    .check input { width: auto; margin-top: 2px; }
    .check em { display: block; font-style: normal; font-size: 11px; color: var(--text-tertiary); }

    .note { margin: 0; font-size: 11.5px; color: var(--text-tertiary); line-height: 1.5; }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid var(--border-subtle);
    }
    .primary {
      padding: 8px 16px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--accent); background: var(--accent-soft); color: var(--text-primary);
    }
    .primary:hover:not(:disabled) { background: var(--accent); color: #16181c; }
    .primary:disabled { opacity: 0.4; cursor: default; }
    .ghost {
      padding: 8px 16px; border-radius: 8px; cursor: pointer;
      background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    }
    .ghost:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
  `],
})
export class OcrDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly tabs = inject(TabsService);
  private readonly queue = inject(QueueService);

  /**
   * The PDF this conversion is OF: the active tab, when it holds one.
   *
   * An EPUB tab is not a source — it is already the output — so the dialog says
   * "open a PDF first" over a book rather than offering to convert it.
   */
  protected readonly source = computed(() => {
    const tab = this.tabs.active();
    return tab !== null && tab.kind === 'pdf' ? tab.path : null;
  });

  /** EPUB unless asked otherwise — it is the format this app can also read. */
  protected readonly kind = signal<ConversionKind>('epub');
  protected readonly skipPages = signal('');
  protected readonly language = signal('en');
  protected readonly problem = signal<string | null>(null);
  /** The workspace plan is a hash of the whole PDF; a 400 MB scan is not instant. */
  protected readonly busy = signal(false);

  constructor() {
    // A stale complaint about the last document, cleared when the source
    // changes. Nothing else resets: skip-pages and the language are the user's
    // last answers and are usually the right ones again.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
  }

  protected openDocument(): void {
    void this.tabs.openViaDialog();
  }

  protected async add(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      // Main names both files. The renderer no longer has an opinion about where
      // a conversion goes, which is the whole point of the workspace — but the
      // KIND has to travel with the request, because it decides the extension
      // and the engine refuses an output whose name disagrees with its format.
      const kind = this.kind();
      const plan = await api.workspace.plan(input, kind);
      const request: JobRequest = {
        inputPath: input,
        outputPath: plan.outputPath,
        kind,
        readingsPath: plan.readingsPath,
      };
      const skip = this.skipPages().trim();
      if (skip.length > 0) request.skipPages = skip;
      const language = this.language().trim();
      if (language.length > 0) request.language = language;

      await this.queue.enqueue(request);
      this.ui.shelfExpanded.set(true);
      this.ui.closeOcr();
    } catch (err) {
      // Never swallowed and never a console line: the two things that can fail
      // here are reading the PDF to key it and the queue refusing the job, and
      // both are sentences.
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
