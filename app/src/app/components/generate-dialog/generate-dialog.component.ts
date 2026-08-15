import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { qualify } from '@shared/documents';
import type { ConversionKind, JobRequest } from '@shared/types';

import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * Generate — turn a reading into something you can read.
 *
 * ── Why this is a dialog of its own and not a field on the OCR one ──────────
 *
 * Because it is a different act with a different cost. Reading a book is hours
 * of GPU against pages nobody has seen: it is held, batched, and committed to
 * with a Start button. Generating is arithmetic over answers that are already on
 * the disk — offline, no model, no server, seconds — and it is repeatable. The
 * two used to be one dialog and one job, which made the FORMAT a decision
 * somebody had to make before a single page was read, and made "could I have
 * that as text as well?" cost another three hours unless they happened to know
 * that `--reuse-readings` existed.
 *
 * So the reading is paid for once and this is free, as many times as you like,
 * in as many formats as you like.
 *
 * ── It runs immediately, and it opens what it made ──────────────────────────
 *
 * NO START GATE. The queue's hold exists so that hours of GPU are never spent by
 * the act of configuring them; there are no hours here to spend, and a person who
 * pressed Generate and then had to find a shelf and press Start would be pressing
 * a second button to confirm a decision they made with the first. It still goes
 * through the queue — one engine at a time is a rule about the machine, not about
 * the person — so it waits behind a reading that is running, and the shelf shows
 * it moving.
 *
 * AND THE RESULT OPENS ITSELF, which is the point: somebody generates an EPUB
 * precisely because they want to look at it. That is `OPENS_ITSELF` in
 * TabsService and it needed nothing new — a finished conversion has always opened
 * in a tab, and what this changed is how often one is worth asking for.
 *
 * ── No reading yet ──────────────────────────────────────────────────────────
 *
 * TWO OPTIONS AND NOT THREE. There is no route in this engine from a PDF to a
 * book that does not go through the model — the whole pipeline is built on the
 * bank of what it read — so "generate without OCR" is not a thing this dialog can
 * offer to do. It says the pages have not been read and offers to read them.
 */
@Component({
  selector: 'app-generate-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeGenerate()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Generate a document">
      <header class="head">
        <span class="title">Generate</span>
        <button class="x" (click)="ui.closeGenerate()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
          <label class="field">
            <span class="label">From</span>
            <input type="text" [value]="optionFor(input)" readonly [title]="input">
          </label>

          @if (readingDone()) {
            <!--
              THE THREE FORMATS AS CARDS rather than a select, because this is the
              whole question the dialog asks and a drop-down would hide two thirds
              of the answer behind a click. Each one says what it IS — the notes
              were in the OCR dialog when the format was chosen there, and they
              followed the decision here rather than being rewritten.
            -->
            <div class="kinds" role="radiogroup" aria-label="What to generate">
              @for (choice of choices; track choice.kind) {
                <button
                  class="kind"
                  role="radio"
                  [attr.aria-checked]="kind() === choice.kind"
                  [class.on]="kind() === choice.kind"
                  (click)="kind.set(choice.kind)"
                >
                  <span class="kind-name">{{ choice.label }}</span>
                  <span class="kind-note">{{ choice.blurb }}</span>
                </button>
              }
            </div>

            @if (kind() === 'txt') {
              <p class="note">
                Plain text is the book with the markup taken off — headings, paragraphs, and
                footnotes as [1] at the end of each chapter. Pictures do not survive it, and
                Foundry cannot open a text file in a tab: the queue will show you where it
                was written.
              </p>
            } @else if (kind() === 'pdf') {
              <p class="note">
                Your book reprinted as real text, page for page: same page size, same layout,
                every line set where it was printed — but as type rather than as a photograph.
                It stays crisp at any zoom, copies as words, and is a fraction of the size.
                Pictures are cut out of the scan and kept. A page the model could not read
                keeps its photograph so nothing is lost. Your original scan is never touched.
              </p>
            } @else {
              <p class="note">
                The book, rebuilt into chapters with its footnotes linked. It opens here the
                moment it is done — Save a copy from the tab once you have looked at it.
              </p>
            }

            <!--
              WHAT THIS IS MADE FROM, said plainly, because it is the reassurance
              that makes generating a second time feel free rather than reckless.
            -->
            <p class="note quiet">
              Made from the {{ pages() > 0 ? pages().toLocaleString() + ' pages' : 'pages' }} the
              model has already read{{ curated() ? ', with your block corrections applied' : '' }}.
              Nothing is read again and no GPU is used.
            </p>

            @if (problem(); as reason) {
              <p class="problem">{{ reason }}</p>
            }
          } @else {
            <!--
              The whole of the no-reading state. Two options, because there is no
              third: nothing in this engine turns a scanned PDF into a book
              without the model reading it first.
            -->
            <p class="unread">This book has not been read yet.</p>
            <p class="note">
              Generating builds a document out of what the vision model read off the pages, and
              nobody has read these pages. That is the one step that costs anything — after it,
              you can generate any of the three formats from the same reading, as often as you
              like, for nothing.
            </p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeGenerate()">Cancel</button>
          @if (readingDone()) {
            <button class="primary" [disabled]="busy()" (click)="generate()">
              {{ busy() ? 'Starting…' : 'Generate' }}
            </button>
          } @else {
            <button class="primary" (click)="ui.openOcr()">Read the pages…</button>
          }
        </footer>
      } @else {
        <div class="body empty">
          <p>Open a PDF first — generating is a thing you do to a book you have in front of you.</p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeGenerate()">Close</button>
          <button class="primary" (click)="openDocument()">Open PDF…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /* The OCR dialog's card, to the pixel. Two modals in one app that differ by
       a few pixels of padding read as two apps. */
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
    .body.empty { color: var(--text-secondary); font-size: 13px; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    .kinds { display: flex; flex-direction: column; gap: 6px; }
    .kind {
      display: flex; flex-direction: column; gap: 2px;
      padding: 9px 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      text-align: left; cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .kind:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    /* The chosen one wears the accent, which is this app's one word for "this is
       the thing" — the same soft fill the rail's active item and the inspector's
       current category row use. */
    .kind.on { background: var(--accent-soft); border-color: var(--accent); }
    .kind-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .kind.on .kind-name { color: var(--accent); }
    .kind-note { font-size: 11px; color: var(--text-tertiary); }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .note.quiet { opacity: 0.8; }
    .unread { margin: 0; font-size: 13px; font-weight: 500; color: var(--text-primary); }
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
export class GenerateDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly tabs = inject(TabsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);

  /**
   * The book this is a rendering OF: the focused pane's document.
   *
   * NO SOURCE PICKER, unlike the OCR dialog, and the difference is what the two
   * are for. That one exists to assemble a BATCH — four books queued in one
   * sitting, run overnight — so it lets you point at any open PDF. This is one
   * free rendering of the thing you are looking at, made because you want to look
   * at the result; a picker would be a list to read before a button that could
   * have been pressed already.
   */
  protected readonly source = computed(() => {
    const tab = this.tabs.activeDocument();
    return tab !== null && tab.kind === 'pdf' ? tab.path : null;
  });

  private readonly project = computed(() => {
    const input = this.source();
    return input === null ? null : this.projects.projectFor(input);
  });

  /**
   * Whether this book's pages have been read — the one thing that decides which
   * of the two dialogs this is.
   *
   * FROM THE PROJECT RECORD, which main derived once when it listed the library
   * (`readingState` in electron/projects.ts). Not a probe of the disk from here:
   * the renderer cannot read a path it names, and a dialog that had to ask main
   * about a file every time it opened would be a dialog with a spinner in it.
   */
  protected readonly readingDone = computed(() => this.project()?.reading.done === true);
  protected readonly pages = computed(() => this.project()?.reading.pages ?? 0);

  /**
   * Whether a curation exists to apply — said out loud, because it is the
   * difference between two renderings of one book.
   *
   * Inferred from the block editor being open on this document with amendments in
   * it, which is the only overlay state this window can see without asking main.
   * A curation made in an earlier session and not reopened is not claimed here:
   * the flag under-promises rather than over-promises, and main applies whatever
   * is on disk regardless (`argsFor`).
   */
  protected readonly curated = computed(() => {
    const tab = this.tabs.activeDocument();
    if (tab === null || tab.kind !== 'pdf') return false;
    // THE CURATION THIS POSITION RENDERS WITH, not the live one — which is the
    // same file main will hand the engine as `--overlay` (`renderingOverlay`).
    // Standing on a save, the live overlay is not what this Generate applies, and
    // a sentence composed from it would be describing a different book than the
    // one about to be made.
    const shown = this.tabs.curationShown(tab.id);
    return (shown?.amendments.length ?? 0) > 0 || shown?.chapters !== undefined;
  });

  protected readonly choices: readonly { kind: ConversionKind; label: string; blurb: string }[] = [
    { kind: 'epub', label: 'EPUB', blurb: 'The book, in chapters. Opens here.' },
    { kind: 'pdf', label: 'PDF, as real text', blurb: 'The same pages, reprinted as type.' },
    { kind: 'txt', label: 'Plain text', blurb: 'The words, with the markup taken off.' },
  ];

  /** EPUB unless asked otherwise — it is the format this app can also read. */
  protected readonly kind = signal<ConversionKind>('epub');
  protected readonly problem = signal<string | null>(null);
  /** The plan hashes the whole PDF to key its project; a 400 MB scan is not instant. */
  protected readonly busy = signal(false);

  constructor() {
    // A stale complaint about the last document, cleared when the source moves.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
  }

  /**
   * The BOOK this rendering would be made from, and what it is.
   *
   * The same wording as the OCR dialog's picker, out of the same helper, because
   * they name the same set of documents and a person moves between the two in one
   * sitting. It was a basename — the name of a copy in a directory this app never
   * shows anybody — and the path is still one hover away on the field itself,
   * which is where somebody asking about a file rather than about a book looks.
   */
  protected optionFor(filePath: string): string {
    return qualify(this.nameFor(filePath), 'pdf', '');
  }

  /** One rule for what a document is called, and it is not this file's. */
  private nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  protected openDocument(): void {
    void this.tabs.openViaDialog();
  }

  /**
   * Ask for the rendering, and get out of the way.
   *
   * THE DIALOG CLOSES AND NOTHING ELSE HAPPENS ON SCREEN until the job lands —
   * at which point the document opens itself in a tab, which is the result the
   * user asked for. The shelf is unrolled on the way out so that a rendering
   * which takes a moment is visibly moving rather than apparently ignored.
   *
   * A refusal keeps the card, in the form this app's dialogs already use: the
   * same rendering already running is not a success and moving on would be
   * performing a result nothing produced.
   */
  protected async generate(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      const kind = this.kind();
      const plan = await api.workspace.plan(input, kind);
      const request: JobRequest = {
        kind,
        // The pixels, as always: main resolves the archived original rather than
        // trusting the document the user happens to be looking at.
        inputPath: plan.sourcePath,
        outputPath: plan.outputPath,
        readingsPath: plan.readingsPath,
        /*
         * AND THE BLOCK EDITOR'S CORRECTIONS. The path is carried, not the
         * decision: main tests for the file as it spawns the engine, so a
         * rendering ordered a moment after a strike applies that strike.
         */
        overlayPath: plan.overlayPath,
      };

      const outcome = await this.queue.enqueue(request);
      if (outcome === 'already') {
        this.problem.set(`${this.nameFor(input)} is already being generated as ${kind}.`);
        return;
      }
      this.ui.shelfExpanded.set(true);
      this.ui.announce(`Generating ${this.nameFor(input)} as ${kind}. It will open when it is done.`);
      this.ui.closeGenerate();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
