import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

import { halvesOf, joinedQuad, splitFromFraction } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { CapturePageEditorComponent } from './capture-page-editor.component';
import { type Dimensions, type FractionQuad, rotate } from './geometry';
import type { ApplyToAll } from '../../core/capture.service';

/**
 * THE EDITOR AS A ROOM YOU STEP INTO, AND THE TWO STAGES OF THE WORK.
 *
 * ── Why a modal and not a pane ──────────────────────────────────────────────
 *
 * Wave 21 point 1, from Owen's own reading of PDFElement: the grid is where you
 * choose, and the editor is where you work. Until tonight the editor REPLACED
 * the grid inside the same tab, so leaving it meant a button called "All
 * photographs" and coming back meant finding your card again. A modal keeps the
 * table underneath, which is the difference between going somewhere and opening
 * something.
 *
 * ── THE STAGES ARE THE BUTTONS, AND THERE IS NO STAGE LABEL ─────────────────
 *
 * docs/CAPTURE.md Wave 21: stage 1 sets ONE crop for the whole shoot, and
 * pressing Apply IS the transition; stage 2 is per-page, and flipping edits the
 * page in front of you. This component never writes "Stage 1 of 2" anywhere,
 * because a number is a thing you have to learn and the footer already shows the
 * difference: one wide button that changes everything, or a row of buttons that
 * change one page and one that changes the rest.
 *
 * The stage is DERIVED and never stored (the plan-back at channel seq 128,
 * ruled at 129). See `stage` on the service side: a project where nobody has
 * touched anything is stage 1, and every other project is stage 2. That is what
 * stops the dangerous reading of the design -- closing the modal after an
 * evening of per-page work and reopening it onto the one button that stamps
 * over all of it.
 *
 * ── What it does NOT own ────────────────────────────────────────────────────
 *
 * The corners, the split line and the previews are still
 * `CapturePageEditorComponent`, unchanged and still pointable at any image. What
 * moved up here is the GESTURE ROW -- turn, split, and the applies -- because
 * those are acts on the whole shoot and the picture below is one photograph.
 * The editor went back to being the surface the corners are chosen on.
 */
@Component({
  selector: 'app-capture-editor-modal',
  imports: [CapturePageEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>

    <div class="card" role="dialog" aria-modal="true">
      <header class="head">
        <button
          class="walk"
          type="button"
          [disabled]="!hasPrevious()"
          title="Previous photograph (left arrow)"
          (click)="step.emit(-1)"
        >‹</button>
        <span class="which">{{ label() }}</span>
        <button
          class="walk"
          type="button"
          [disabled]="!hasNext()"
          title="Next photograph (right arrow)"
          (click)="step.emit(1)"
        >›</button>
        <span class="grow"></span>
        <button class="shut" type="button" title="Back to the table (Escape)" (click)="close.emit()">✕</button>
      </header>

      <div class="body">
        <app-capture-page-editor
          [source]="source()"
          [dimensions]="dimensions()"
          [quads]="quads()"
          [split]="split()"
          (quadsChange)="quadsChange.emit($event)"
          (splitChange)="splitChange.emit($event)"
        />
      </div>

      <footer class="foot">
        <!--
          THE GESTURES ARE ON THE LEFT AND THE ACTS ARE ON THE RIGHT, which is
          the arrangement every dialog in this app already uses: what you are
          doing, then what you are finishing with.
        -->
        <div class="gestures">
          <button type="button" title="Turn this page anticlockwise" (click)="turn(-1)">⟲</button>
          <button type="button" title="Turn this page clockwise" (click)="turn(1)">⟳</button>
          @if (quads().length === 1) {
            <button type="button" (click)="splitInTwo()">Split</button>
          }
          @if (stage() === 2) {
            <!--
              KEPT IN STAGE 2 ONLY, ruled at channel seq 129: it is the single
              act that changes every page WITHOUT overwriting hand-set crops,
              because a turn permutes each page's own corners rather than
              replacing them. In stage 1 the stamp carries the turn for free --
              the corner order IS the orientation -- so a second button there
              would be two ways to say the same thing.
            -->
            <button
              type="button"
              [class.applied]="justApplied() === 'rotate'"
              [disabled]="turnsApplied() === 0"
              (click)="applyToAll.emit({ kind: 'rotate', turns: turnsApplied() })"
            >{{ justApplied() === 'rotate' ? 'Turned ✓' : 'Turn all by the same amount' }}</button>
          }
        </div>

        <span class="grow"></span>

        @if (stage() === 1) {
          <!--
            ONE BUTTON, AND IT IS THE WHOLE OF STAGE 1. The sentence beside it
            says what it will do, because this is the press that changes every
            photograph in the project and the person has only ever seen one.
          -->
          <span class="says">Sets this crop on every photograph of the same shape.</span>
          <button
            class="act"
            type="button"
            [class.applied]="justApplied() === 'stamp'"
            (click)="applyToAll.emit({ kind: 'stamp', includeHandSet: false })"
          >{{ justApplied() === 'stamp' ? 'Applied ✓' : 'Apply to every page' }}</button>
        } @else {
          @if (handSet() > 0) {
            <!--
              THE OVERRIDE, AND IT ONLY APPEARS WHEN IT COULD MATTER.

              A stamp leaves hand-set pages alone and names them, which is what
              somebody wants nine times in ten. The tenth is when the global
              they are correcting is the one that was wrong to begin with, and
              then the skip is the thing in the way.

              Drawn only while there ARE hand-set pages, and carrying the count,
              because a permanently-present tick box about a condition that
              usually does not hold is a control people learn to stop reading.
            -->
            <label class="override" [title]="'Apply to the pages you set by hand as well'">
              <input type="checkbox" [checked]="includeHandSet()" (change)="toggleOverride($event)" />
              <span>including the {{ handSet() }} set by hand</span>
            </label>
          }
          <button
            class="ghost"
            type="button"
            [class.applied]="justApplied() === 'stamp'"
            (click)="applyToAll.emit({ kind: 'stamp', includeHandSet: includeHandSet() })"
          >{{ justApplied() === 'stamp' ? 'Applied ✓' : 'Apply to all' }}</button>
          <!--
            PER-PAGE APPLY, WHICH MOVES NO CORNER.

            The corners were saved as they were dragged -- that is what stops a
            person losing an adjustment by flipping to the next photograph -- so
            what is left for this button is the part that was never expressible
            before: this setting was chosen FOR THIS PAGE, and the next global
            must not quietly take it away.

            It toggles, and the label says which state it is in rather than
            congratulating itself. Pressing it again hands the page back to the
            globals, which is the only way to undo a mark somebody set by
            mistake and would otherwise be permanent.
          -->
          <button
            class="act"
            type="button"
            [title]="handSetHere()
              ? 'Let apply-to-all change this photograph again'
              : 'Leave this photograph alone when you apply to all'"
            (click)="keep.emit()"
          >{{ handSetHere() ? 'Set by hand ✓' : 'Apply' }}</button>
        }
      </footer>
    </div>
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT -- confirm-dialog's rule,
     * for its reason: a full-window fixed host is a sheet of glass over the
     * application, and an invisible sheet still swallows every click. This one
     * is only mounted while it is open, so it is less dangerous than that
     * component's case; it follows the same rule anyway, because a component
     * that is safe only because of where it is mounted is safe by accident.
     */
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    /*
     * NEARLY THE WHOLE WINDOW, unlike every other dialog in this app, and that
     * is the point rather than an oversight: the others ask a question and this
     * one is a workbench. The photograph wants every pixel it can have, because
     * a corner placed on a small picture is a corner placed badly.
     *
     * The margin is what keeps it a modal at all -- the table stays visible
     * around the edge, so this reads as something opened OVER the work rather
     * than as a screen that replaced it.
     */
    .card {
      position: relative;
      pointer-events: auto;
      width: calc(100vw - 56px);
      height: calc(100vh - 56px);
      margin: 28px auto;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .which { font-size: 12px; color: var(--text-secondary); }
    .grow { flex: 1; }

    /* The body is the only thing that may grow, so the picture takes the room
       and the two bars stay where the hands expect them. */
    .body { flex: 1; min-height: 0; display: flex; }
    .body app-capture-page-editor { flex: 1; min-width: 0; }

    .foot {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 10px 12px;
      border-top: 1px solid var(--border-subtle);
    }
    .gestures { display: flex; gap: 6px; }
    /* Said quietly and next to the button it describes: it is a caption on one
       control, not an announcement about the room. */
    .says { font-size: 11px; color: var(--text-tertiary); }

    /* Beside the button it changes, in the tick-box voice confirm-dialog
       already uses for a statement about an act rather than an act of its own. */
    .override {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--text-secondary);
      cursor: pointer;
    }
    .override input { accent-color: var(--accent-strong); cursor: pointer; }

    .walk, .shut, .gestures button, .ghost {
      padding: 3px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
    }
    .walk:hover:not(:disabled), .shut:hover, .gestures button:hover:not(:disabled), .ghost:hover {
      background: var(--bg-hover); color: var(--text-primary);
    }
    .walk:disabled, .gestures button:disabled { opacity: 0.4; cursor: default; }
    .shut { border-color: transparent; }

    .act {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border: none;
      border-radius: var(--radius-md);
      background: var(--accent-strong); color: var(--text-inverse);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .act:hover { background: var(--accent); }
    .act:active { transform: scale(0.98); }

    /*
     * THE ACKNOWLEDGEMENT, carried over from the light table's gesture row
     * (Wave 21 point 5) and deliberately not animated. The house has no
     * precedent for a transient confirmed state, and an effect invented for one
     * button is the kind of motion that reads as decoration rather than as
     * information.
     */
    .applied {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
      color: var(--text-inverse);
    }
  `],
})
export class CaptureEditorModalComponent {
  /** "Photograph 5 of 27 · pages 9-10 of 54" — composed by the light table. */
  readonly label = input.required<string>();
  readonly source = input.required<string>();
  readonly dimensions = input.required<Dimensions>();
  readonly quads = input.required<readonly FractionQuad[]>();
  /** The gutter as two endpoints, or null while this photograph is one page. */
  readonly split = input<CaptureSplit | null>(null);

  /**
   * 1 while nobody has set anything on this project, 2 afterwards.
   *
   * DERIVED BY THE SERVICE AND HANDED DOWN, never decided here and never
   * remembered across an open. A stage this component kept for itself would
   * reset every time the modal was closed, which is exactly the failure the
   * derivation exists to prevent.
   */
  readonly stage = input.required<1 | 2>();

  readonly hasPrevious = input.required<boolean>();
  readonly hasNext = input.required<boolean>();
  /** How many photographs in this project somebody has set by hand. */
  readonly handSet = input<number>(0);
  /** Whether THIS photograph is one of them. */
  readonly handSetHere = input<boolean>(false);
  /** Which act just landed, for the button that was pressed. Owned by the parent. */
  readonly justApplied = input<ApplyToAll['kind'] | null>(null);

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<CaptureSplit>();
  readonly applyToAll = output<ApplyToAll>();
  /** Stage 2's per-page Apply — this page is set by hand and stays that way. */
  readonly keep = output<void>();
  readonly step = output<number>();
  readonly close = output<void>();

  /**
   * Quarter turns applied to this photograph since the modal opened.
   *
   * Lifted here from the editor with the button that reads it. It is REMEMBERED
   * rather than inferred because "turn all BY the same amount" needs the amount,
   * and recovering it by comparing two quads would be arithmetic on floats
   * standing in for a fact we already had.
   */
  protected readonly turnsApplied = signal(0);

  /**
   * Whether the next stamp takes the hand-set pages too.
   *
   * NOT REMEMBERED ACROSS A CLOSE, and deliberately not: it is a decision about
   * one press, and a tick that survived the modal would be an override
   * somebody switched on for a reason they had an hour ago.
   */
  protected readonly includeHandSet = signal(false);

  protected toggleOverride(event: Event): void {
    const box = event.target;
    if (box instanceof HTMLInputElement) this.includeHandSet.set(box.checked);
  }

  constructor() {
    /*
     * A TURN BELONGS TO THE PHOTOGRAPH IT WAS MADE ON, so the count goes back to
     * zero when the picture under it changes.
     *
     * An effect and not a computed: this is a write, and a computed that wrote
     * would be a rule that only fired when somebody happened to read it -- which
     * on this screen is when the turn-all button asks whether to be disabled.
     * The bug that buys is a turn-all on photograph 12 quietly carrying the
     * three quarters somebody turned photograph 11 by.
     */
    effect(() => {
      void this.source();
      this.turnsApplied.set(0);
    });
  }

  protected turn(turns: number): void {
    this.turnsApplied.update((sofar) => sofar + turns);
    this.quadsChange.emit(this.quads().map((quad) => rotate(quad, turns)));
  }

  /**
   * Cut this photograph into two pages at the split handle.
   *
   * From `joined`, never from `quads()[0]`: after a split that first quad is the
   * left half, and re-splitting it would halve the page again on every press.
   * The middle is the default because a spread photographed straight on is split
   * down the middle, and asking somebody to place a line before they may press
   * the button would be ceremony.
   */
  protected splitInTwo(): void {
    const sheet = joinedQuad(this.quads() as readonly CaptureQuad[], this.split());
    /*
     * THE MIDDLE, THROUGH THE ONE BODY THAT KNOWS WHAT THAT MEANS. A spread
     * photographed straight on is split down the middle, and asking somebody to
     * place a line before they may press the button would be ceremony.
     *
     * `splitFromFraction` is the same function main's migration reads an old
     * {x} with, which is the point of it being in shared: "the vertical segment
     * a fraction always meant" has one answer rather than one here and one
     * there.
     */
    const split = splitFromFraction(sheet, 0.5);
    const halves = halvesOf(sheet, split);
    // Unreachable for a segment built from a fraction -- both ends are put on
    // opposite edges by construction -- and doing nothing is the only answer
    // that cannot make a page out of a corner.
    if (halves === null) return;
    this.splitChange.emit(split);
    this.quadsChange.emit([halves[0], halves[1]]);
  }

  /**
   * Escape closes, and the arrows walk.
   *
   * On the window rather than the card because the pointer is routinely over the
   * picture and the card does not hold the focus while somebody is dragging a
   * corner. Ignored while a field has it, for the reason every shortcut in this
   * app is: a key that eats a character somebody was typing is worse than no
   * shortcut at all.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    event.preventDefault();
    if (event.key === 'Escape') this.close.emit();
    else this.step.emit(event.key === 'ArrowLeft' ? -1 : 1);
  }
}
