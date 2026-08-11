import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { JobRequest } from '@shared/types';

import { DocumentService } from '../../core/document.service';
import { QueueService } from '../../core/queue.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * OCR / Convert — configure one conversion and put it in the queue.
 *
 * It ENQUEUES and nothing else. The run is main's (electron/job-queue.ts), so
 * closing this panel, opening another document, or navigating to Settings does
 * not touch a job that is already moving.
 */
@Component({
  selector: 'app-ocr-panel',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="panel">
      <header class="panel-head">
        <span class="panel-title">OCR / Convert</span>
        <button class="x" (click)="ui.closeTool()" title="Close">✕</button>
      </header>

      @if (doc.openPath(); as input) {
        <div class="panel-body">
          <label class="field">
            <span class="label">Source</span>
            <input type="text" [value]="input" readonly [title]="input">
          </label>

          <label class="field">
            <span class="label">Output</span>
            <span class="row">
              <input type="text" [ngModel]="outputPath()" (ngModelChange)="outputPath.set($event)" name="output">
              <button class="ghost" (click)="chooseOutput()">…</button>
            </span>
          </label>

          <label class="field">
            <span class="label">Format</span>
            <select [ngModel]="kind()" (ngModelChange)="kind.set($event)" name="kind">
              <option value="epub">EPUB</option>
              <!-- TODO: searchable PDF, once the engine casts one. -->
            </select>
          </label>

          <label class="field">
            <span class="label">Skip pages <em>optional</em></span>
            <input type="text" placeholder="3,17,19-24" [ngModel]="skipPages()" (ngModelChange)="skipPages.set($event)" name="skip">
          </label>

          <label class="field">
            <span class="label">Endpoint <em>overrides Settings</em></span>
            <input type="text" placeholder="http://localhost:8000/v1"
                   [ngModel]="endpointUrl()" (ngModelChange)="endpointUrl.set($event)" name="endpoint">
          </label>

          <label class="check">
            <input type="checkbox" [ngModel]="bankReadings()" (ngModelChange)="bankReadings.set($event)" name="bank">
            <span>
              Bank page answers
              <em>an interrupted run resumes instead of re-reading the book</em>
            </span>
          </label>

          <label class="check">
            <input type="checkbox" [ngModel]="writeChapters()" (ngModelChange)="writeChapters.set($event)" name="chapters">
            <span>Write chapter proposals beside the book</span>
          </label>

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="panel-foot">
          <button class="primary" [disabled]="!canQueue()" (click)="add()">Add to queue</button>
        </footer>
      } @else {
        <div class="panel-body empty">
          <p>Open a PDF first — a conversion is a thing you do to the document on screen.</p>
          <button class="ghost" (click)="doc.openViaDialog()">Open PDF…</button>
        </div>
      }
    </aside>
  `,
  styles: [`
    .panel {
      width: 320px;
      min-width: 320px;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-subtle);
    }

    .panel-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .panel-title { flex: 1; font-weight: 600; font-size: 13px; }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 13px;
    }
    .x:hover { color: var(--text-primary); }

    .panel-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    .panel-body.empty { color: var(--text-tertiary); font-size: 13px; align-items: flex-start; }

    .field { display: flex; flex-direction: column; gap: 4px; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; opacity: 0.7; }
    .row { display: flex; gap: 6px; }
    .row input { flex: 1; min-width: 0; }

    .check { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: var(--text-secondary); }
    .check input { width: auto; margin-top: 2px; }
    .check em { display: block; font-style: normal; font-size: 11px; color: var(--text-tertiary); }

    .problem { margin: 0; font-size: 12px; color: var(--warn); }

    .panel-foot { padding: 10px 12px; border-top: 1px solid var(--border-subtle); }
    .primary {
      width: 100%;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--accent);
      background: var(--accent-soft);
      color: var(--text-primary);
      cursor: pointer;
    }
    .primary:hover:not(:disabled) { background: var(--accent); color: #16181c; }
    .primary:disabled { opacity: 0.4; cursor: default; }

    .ghost {
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .ghost:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
  `],
})
export class OcrPanelComponent {
  protected readonly doc = inject(DocumentService);
  protected readonly ui = inject(UiService);
  private readonly queue = inject(QueueService);

  protected readonly outputPath = signal('');
  protected readonly kind = signal<'epub'>('epub');
  protected readonly skipPages = signal('');
  protected readonly endpointUrl = signal('');
  protected readonly bankReadings = signal(true);
  protected readonly writeChapters = signal(false);
  protected readonly problem = signal<string | null>(null);

  constructor() {
    // The output follows the source until somebody types over it. Re-derived on
    // every open, because a panel left showing the last book's output path is
    // one click away from writing this book over that one.
    effect(() => {
      const input = this.doc.openPath();
      this.outputPath.set(input === null ? '' : swapExtension(input, '.epub'));
      this.problem.set(null);
    });
  }

  protected readonly canQueue = computed(() =>
    this.doc.openPath() !== null && this.outputPath().trim().length > 0);

  protected async chooseOutput(): Promise<void> {
    const chosen = await api?.chooseOutputPath(this.outputPath());
    if (chosen) this.outputPath.set(chosen);
  }

  protected async add(): Promise<void> {
    const input = this.doc.openPath();
    const output = this.outputPath().trim();
    if (input === null || output.length === 0) return;
    if (samePath(input, output)) {
      this.problem.set('The book cannot be written over the PDF it is read from.');
      return;
    }

    const request: JobRequest = { inputPath: input, outputPath: output, kind: this.kind() };
    const skip = this.skipPages().trim();
    if (skip.length > 0) request.skipPages = skip;
    const endpoint = this.endpointUrl().trim();
    if (endpoint.length > 0) request.endpointUrl = endpoint;
    // Banked beside the book, keyed by nothing but its name — foundry keys the
    // ANSWERS to the PDF itself, so a bank that belongs to another book cannot
    // be read into this one whatever it is called.
    if (this.bankReadings()) request.readingsPath = `${swapExtension(output, '')}.readings.jsonl`;
    if (this.writeChapters()) request.chaptersPath = `${swapExtension(output, '')}.chapters.json`;

    this.problem.set(null);
    await this.queue.enqueue(request);
    this.ui.shelfExpanded.set(true);
  }
}

/** `book.pdf` -> `book.epub`. String work only — the renderer has no path module. */
function swapExtension(filePath: string, extension: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dot = filePath.lastIndexOf('.');
  return dot > cut ? filePath.slice(0, dot) + extension : filePath + extension;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}
