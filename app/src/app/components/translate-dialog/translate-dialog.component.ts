import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { TranslateRequest } from '@shared/types';

import { QueueService } from '../../core/queue.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/** The engine's default, repeated here so the field opens on it. */
const DEFAULT_MODEL = 'qwen3:32b';
/** Ollama's own default port, and where it is unless somebody moved it. */
const DEFAULT_OLLAMA = 'http://localhost:11434';

/**
 * Translate — configure ONE translation and put it in the queue.
 *
 * The same shape as the OCR dialog and for the same reasons: it enqueues and
 * nothing else, the run belongs to main, and dismissing this does not touch a
 * job that is already moving. What it asks for is different, though, and the
 * differences are the interesting part.
 *
 *   **The source is an EPUB, not a PDF.** A translation replaces the text
 *   inside the categories foundry stamped when it built the book, so the input
 *   is a book this app already made. Pointed at a PDF, the engine would have
 *   nothing to work on — so the dialog says to open a book rather than offering
 *   to translate a scan.
 *
 *   **The Ollama endpoint IS a field here**, unlike the reading backend in the
 *   OCR dialog. That one is owned by the settings screen and a second control
 *   would be a second opinion. Ollama has no settings screen: it is a server
 *   the user already runs, that this app never starts, stops or configures, so
 *   there is nothing here to contradict.
 *
 *   **Translator instructions are free text and they matter.** Terminology is
 *   per-book — which words stay in the source language, whether loaded
 *   vocabulary in a historical document is rendered literally — and no default
 *   can be right about it. The text is appended to the engine's system prompt
 *   verbatim.
 */
@Component({
  selector: 'app-translate-dialog',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeTranslate()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Translate this book">
      <header class="head">
        <span class="title">Translate</span>
        <button class="x" (click)="ui.closeTranslate()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
          <label class="field">
            <span class="label">Book</span>
            <input type="text" [value]="input" readonly [title]="input">
          </label>

          <div class="pair">
            <label class="field">
              <span class="label">Into</span>
              <input type="text" placeholder="en" [ngModel]="to()" (ngModelChange)="to.set($event)" name="to">
            </label>
            <label class="field">
              <span class="label">From <em>optional</em></span>
              <input type="text" placeholder="detect" [ngModel]="from()" (ngModelChange)="from.set($event)" name="from">
            </label>
          </div>
          <p class="note">
            Language tags, not names: <code>en</code>, <code>de</code>, <code>pt-BR</code>.
            Left blank, the source language is the model's to work out from the text.
          </p>

          <label class="field">
            <span class="label">Model</span>
            <input type="text" [ngModel]="model()" (ngModelChange)="model.set($event)" name="model">
          </label>
          <!--
            The measured differences, said before the choice rather than after
            six hours of it. This is the one field where the default is worth
            departing from on purpose, and the trade is real: 14b is about twice
            as fast and omits more.
          -->
          <p class="note">
            <strong>qwen3:32b</strong> is the most faithful of the models measured and is slow —
            hours for a full book. <strong>qwen2.5:14b</strong> is roughly twice as fast and good
            for a draft, but drops the occasional clause. Whatever you pick, every paragraph is
            checked before it goes into the book.
          </p>

          <label class="field">
            <span class="label">Ollama <em>used, never started</em></span>
            <input type="text" [ngModel]="ollama()" (ngModelChange)="ollama.set($event)" name="ollama">
          </label>

          <label class="field">
            <span class="label">Translator instructions <em>optional</em></span>
            <textarea
              rows="4"
              placeholder="Leave 'völkisch' untranslated. Render racial terminology literally; do not soften it."
              [ngModel]="instructions()"
              (ngModelChange)="instructions.set($event)"
              name="instructions"></textarea>
          </label>
          <p class="note">
            Appended to the model's instructions word for word. Use it to pin the terms this
            particular book turns on.
          </p>

          <p class="note">
            The translation is written as a NEW book in Foundry's workspace, next to the original,
            and opens here when it is done. The book you are translating is never written to.
            A paragraph the model cannot translate to standard is refused by name and the whole
            job fails — nothing half-translated is ever written.
          </p>

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeTranslate()">Cancel</button>
          <button class="primary" [disabled]="busy() || to().trim().length === 0" (click)="add()">
            {{ busy() ? 'Working…' : 'Add to queue' }}
          </button>
        </footer>
      } @else {
        <div class="body empty">
          <p>
            Open an EPUB first. Translation replaces the text inside the categories Foundry
            stamps when it converts a book, so it works on a book Foundry made — not on a scan.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeTranslate()">Close</button>
          <button class="primary" (click)="openDocument()">Open EPUB…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }

    .scrim {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

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
      border-radius: var(--radius-lg);
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .title { flex: 1; font-family: var(--font-display); font-weight: 600; font-size: 16px; }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 13px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .body.empty { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    /* Two tags on one row: they are one decision and each needs four characters. */
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; font-weight: 400; opacity: 0.75; }

    textarea { resize: vertical; min-height: 64px; font-family: inherit; }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .note code { font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); }
    .note strong { color: var(--text-secondary); font-weight: 600; }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active { background: var(--bg-active); transform: scale(0.98); }
  `],
})
export class TranslateDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly tabs = inject(TabsService);
  private readonly queue = inject(QueueService);

  /**
   * The book this translation is OF: the focused pane's document, when it is a
   * book. (Its HTML editor counts as the book — one document, two faces.)
   *
   * The path is the file on disk the tab was opened from — which for a
   * conversion is already the managed workspace copy, and for a book the user
   * opened themselves is their own file. Either is safe to name here: the
   * engine never writes to its input, and the OUTPUT is placed by main.
   */
  protected readonly source = computed(() => {
    const tab = this.tabs.activeDocument();
    return tab !== null && tab.kind === 'epub' ? tab.path : null;
  });

  protected readonly to = signal('en');
  protected readonly from = signal('');
  protected readonly model = signal(DEFAULT_MODEL);
  protected readonly ollama = signal(DEFAULT_OLLAMA);
  protected readonly instructions = signal('');
  protected readonly problem = signal<string | null>(null);
  /** The workspace plan hashes the whole book to key it. Not instant. */
  protected readonly busy = signal(false);

  constructor() {
    // Same rule as the OCR dialog: a complaint about the last book is cleared
    // when the book changes, and nothing else resets. The instructions in
    // particular are the user's careful answer and survive switching tabs.
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
      const to = this.to().trim();
      // Main names the output — the language is part of the name, so it has to
      // travel with the plan rather than only with the command line — and it
      // names the INPUT too. A book edited since it was cast lives in its
      // working tree, which is not a file any engine can read, so main exports
      // it and the job reads the export. Using `input` here instead would
      // translate the version from before every cut the user just made.
      const plan = await api.workspace.planTranslation(input, to);
      const request: TranslateRequest = {
        kind: 'translate',
        inputPath: plan.inputPath,
        outputPath: plan.outputPath,
        to,
        model: this.model().trim() || DEFAULT_MODEL,
        ollama: this.ollama().trim() || DEFAULT_OLLAMA,
        // Where each accepted block lands the moment it is accepted, so a run
        // that is interrupted asks only for what it still owes. Never a choice
        // in this dialog: see the note on `argsFor`.
        bankPath: plan.bankPath,
      };
      const from = this.from().trim();
      if (from.length > 0) request.from = from;
      const instructions = this.instructions().trim();
      if (instructions.length > 0) request.instructions = instructions;

      await this.queue.enqueueTranslate(request);
      this.ui.shelfExpanded.set(true);
      this.ui.closeTranslate();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
