import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import { CaptureCardComponent } from './capture-card.component';

/** One page on the table, as the grid needs to draw it. */
export interface CaptureCard {
  /** The page id — `<photoId>:<n>`, the recipe's own. */
  readonly id: string;
  /** The 640 px thumbnail's URL, through the capture door. */
  readonly thumb: string;
  /** What to call it on the table. */
  readonly label: string;
  /** Struck pages stay on the table and out of the mint. */
  readonly struck: boolean;
}

/**
 * The drag payload's type. A private MIME rather than `text/plain` so a page
 * dragged inside the grid is distinguishable, BEFORE the drop, from a file
 * dragged in from Explorer — `dataTransfer.types` is the only part of a payload
 * readable during a drag, and the two mean opposite things here. The dock does
 * the same for its document rows, and for the same reason.
 */
const PAGE_MIME = 'application/x-foundry-capture-page';

/**
 * THE LIGHT TABLE — the main viewer for a capture project with no minted PDF.
 *
 * ── What this owns, and what it refuses to ──────────────────────────────────
 *
 * The arrangement: which card sits where, which way the sort runs, where a
 * dragged page lands, and where files may be dropped. It owns none of the
 * meaning — a card is a row of pixels and a label handed to it, the recipe is
 * the service's, and every gesture leaves here as an event rather than as a
 * mutation.
 *
 * That is what lets the grid be drawn against anything: it never learns what a
 * quad is, and the rules about spreads and splits live where they can be shared
 * (`capture-editor/geometry.ts`, and the service above it).
 *
 * ── THE ORDER STOPS BEING A SORT THE MOMENT SOMEBODY DRAGS ──────────────────
 *
 * docs/CAPTURE.md: cards arrive "sorted by capture time … Cards drag to
 * reorder; once the user has dragged, the sort is history and their order is the
 * order." So this component emits a REORDER — the full list of ids in their new
 * arrangement — and never a "move card 3 to slot 7" that a re-sort could
 * silently undo. The service decides that the recipe's `order` is now the
 * person's and stops sorting.
 *
 * ── REVERSE IS ASKED FOR, NOT DONE ──────────────────────────────────────────
 *
 * The doc's sharpest trap: "Reverse operates on capture order, not on split
 * halves. A book shot back-to-front reverses into reading order by spread;
 * within each split the left page still precedes the right. Reversing raw page
 * cards would silently swap every pair." A grid holding a flat list of cards
 * CANNOT honour that — it cannot see which two cards were one photograph. So it
 * emits `reverse` and the service, which holds the photos, does it properly.
 * Reversing the array here would be exactly the bug the doc names.
 *
 * ── The drop zone stops the drop, deliberately ──────────────────────────────
 *
 * The window has its own file-drop handler (app.ts) which opens EVERY dropped
 * file as a document. A drop of twenty-seven photographs onto this grid would
 * otherwise become twenty-seven attempts to open a HEIC as a book, and
 * twenty-seven refusals in the notice bar. So the zone calls
 * `stopPropagation`: the window listener is on the bubble path and never sees
 * an event this grid has already answered.
 */
@Component({
  selector: 'app-capture-grid',
  imports: [CaptureCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="column">
    <header>
      <span class="count">{{ cards().length }} pages</span>
      <button type="button" (click)="reverse.emit()" [disabled]="ordered()">
        {{ descending() ? 'Oldest first' : 'Newest first' }}
      </button>
      @if (ordered()) {
        <!--
          Said out loud rather than just disabling the button: the sort is gone
          because the person arranged the pages themselves, and a control that
          greys with no reason reads as a bug.
        -->
        <span class="note">Your order — the capture-time sort no longer applies</span>
      }
    </header>

    <div class="table">
      @for (card of cards(); track card.id; let index = $index) {
        <div
          class="slot"
          [class.landing]="landing() === index"
          draggable="true"
          (dragstart)="pickUp($event, card.id)"
          (dragover)="over($event, index)"
          (dragend)="putDown()"
          (drop)="land($event, index)"
        >
          <app-capture-card
            [thumb]="card.thumb"
            [label]="card.label"
            [struck]="card.struck"
            (open)="open.emit(card.id)"
            (strike)="strike.emit(card.id)"
          />
        </div>
      } @empty {
        <p class="empty">No photographs yet. Drop them on the strip to the right.</p>
      }
    </div>
    </div>

    <!--
      PERSISTENT, for the life of the project (docs/CAPTURE.md: "Files can keep
      landing there for the life of the project") — not a state the grid enters
      when something is dragged over it. A zone that only appears mid-drag is a
      zone you have to already know about.
    -->
    <aside
      class="dropzone"
      [class.hot]="hot()"
      (dragenter)="warm($event)"
      (dragover)="warm($event)"
      (dragleave)="cool()"
      (drop)="take($event)"
    >
      <span>Drop photographs here</span>
    </aside>
  `,
  styles: [`
    /* The table and the strip side by side; the header above the table only. */
    :host { display: flex; flex-direction: row; height: 100%; min-height: 0; }
    .column { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }

    header {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--text-tertiary);
    }
    header button {
      padding: 3px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }
    header button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    header button:disabled { opacity: 0.4; cursor: default; }
    .note { font-style: italic; }

    .table {
      flex: 1;
      min-width: 0;
      align-content: start;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 10px;
      padding: 10px;
      overflow-y: auto;
    }

    .slot { position: relative; }
    /*
      The landing is a line down the leading edge rather than a gap that opens
      up: an insertion that reflows the whole grid moves every other card out
      from under the pointer while the person is still aiming at one.
    */
    .slot.landing::before {
      content: '';
      position: absolute;
      inset: -5px auto -5px -6px;
      width: 2px;
      background: var(--accent, #4c9aff);
    }

    .empty { color: var(--text-tertiary); font-size: 12px; padding: 20px; }

    .dropzone {
      flex: 0 0 130px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 10px;
      padding: 10px;
      border: 1px dashed var(--border-default);
      border-radius: var(--radius-md, 6px);
      color: var(--text-tertiary);
      font-size: 12px;
      text-align: center;
    }
    .dropzone.hot { border-color: var(--accent, #4c9aff); color: var(--text-primary); background: var(--bg-hover); }
  `],
})
export class CaptureGridComponent {
  /** The pages, in the order they should be drawn. */
  readonly cards = input.required<readonly CaptureCard[]>();
  /** Which way the capture-time sort runs, while there still is one. */
  readonly descending = input.required<boolean>();
  /** True once the person has dragged, after which the sort no longer applies. */
  readonly ordered = input.required<boolean>();

  /** The whole list of ids, rearranged — never a single move. */
  readonly reorder = output<readonly string[]>();
  readonly open = output<string>();
  readonly strike = output<string>();
  /** Asked for, not done: only the service can reverse by spread. */
  readonly reverse = output<void>();
  /**
   * Files dropped on the strip. `File` rather than a path, because turning one
   * into the other is `api.pathForFile` and this component holds no bridge —
   * the service does that, and hands the paths to `capture:intake`.
   */
  readonly dropped = output<readonly File[]>();

  /** The slot a dragged card would land in front of, or null when nothing is up. */
  protected readonly landing = signal<number | null>(null);
  protected readonly hot = signal(false);
  private carrying: string | null = null;

  protected pickUp(event: DragEvent, id: string): void {
    this.carrying = id;
    event.dataTransfer?.setData(PAGE_MIME, id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected over(event: DragEvent, index: number): void {
    if (this.carrying === null) return;
    // Without preventDefault the browser refuses the drop and the whole gesture
    // ends in the "return to origin" animation with nothing having happened.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.landing.set(index);
  }

  protected land(event: DragEvent, index: number): void {
    const carried = this.carrying;
    this.putDown();
    if (carried === null) return;
    event.preventDefault();
    // Inside the grid only — a file dropped on a card is not a reorder, and
    // letting it fall through to the window would open it as a document.
    event.stopPropagation();

    const ids = this.cards().map((card) => card.id);
    const from = ids.indexOf(carried);
    if (from === -1 || from === index) return;

    const rest = ids.filter((id) => id !== carried);
    // The landing is a slot in the ORIGINAL list; once the carried card is
    // removed, every slot after it shifts down by one.
    const at = from < index ? index - 1 : index;
    this.reorder.emit([...rest.slice(0, at), carried, ...rest.slice(at)]);
  }

  protected putDown(): void {
    this.carrying = null;
    this.landing.set(null);
  }

  protected warm(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.hot.set(true);
  }

  protected cool(): void {
    this.hot.set(false);
  }

  protected take(event: DragEvent): void {
    this.cool();
    if (!carriesFiles(event)) return;
    event.preventDefault();
    // See the class docblock: the window's own handler would otherwise open
    // every one of these as a document.
    event.stopPropagation();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) this.dropped.emit(files);
  }
}

/** Whether a drag carries files from outside the app rather than a page card. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}
