import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { HomeComponent } from '../../components/home/home.component';
import { NoticeBarComponent } from '../../components/notice-bar/notice-bar.component';
import { TabStripComponent } from '../../components/tab-strip/tab-strip.component';
import { ViewerComponent } from '../../components/viewer/viewer.component';
import { TabsService, type Pane } from '../../core/tabs.service';

/**
 * The documents: one to five columns, each a strip of tabs with whichever one is
 * active under it.
 *
 * ONE PANE IS THE OLD APP, EXACTLY. No divider is drawn, the strip spans the
 * window, and nothing on screen mentions that a second column is possible — the
 * split is a thing you go and do, not a thing the app keeps offering. Everything
 * below that is only reached once there are two.
 *
 * No tab active in a pane — which includes having no panes at all — is HOME.
 * Home is not a route and not a tab: it is what a column is when there is
 * nothing in it to show, which means closing the last tab lands somewhere useful
 * instead of on a grey rectangle.
 *
 * The strip is above the viewer and outside it, so the PDF plugin's own toolbar
 * and the app's chrome never fight for the same row.
 *
 * FOCUS IS A POINTERDOWN IN THE CAPTURE PHASE, which is the whole model. Capture
 * rather than bubble because the thing clicked — a tab, a chapter, a Save button
 * — usually acts on "the focused pane", and it has to be this one by the time it
 * runs. Pointerdown rather than click because a drag that begins in a pane also
 * means that pane, and a click that never completes still moved the user's
 * attention.
 */
@Component({
  selector: 'app-workspace',
  imports: [HomeComponent, NoticeBarComponent, TabStripComponent, ViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      Above the columns, and outside the @if: the things it says are about the
      window rather than about any one pane, and the state where it matters most
      (a bad file dropped on an app with nothing open) is the state with no
      panes to hang it under.
    -->
    <app-notice-bar />

    @if (tabs.panes(); as panes) {
      @if (panes.length === 0) {
        <app-home />
      } @else {
        <div class="row">
          @for (pane of panes; track pane.id; let index = $index, first = $first) {
            @if (!first) {
              <!--
                The divider is its own element between two panes rather than a
                border on one of them: a 1px line is unhittable, so this is 7px
                of transparent grab area with the app's own hairline painted
                down the middle of it.
              -->
              <div
                class="divider"
                role="separator"
                aria-orientation="vertical"
                (pointerdown)="startResize($event, index)"
                (pointermove)="onResize($event)"
                (pointerup)="endResize($event)"
                (pointercancel)="endResize($event)"
              ></div>
            }
            <section
              class="pane"
              [style.flex]="pane.flex + ' 1 0'"
              (pointerdown)="tabs.focusPane(pane.id)"
            >
              <app-tab-strip [pane]="pane" />
              @if (activeIn(pane); as tab) {
                <app-viewer [tab]="tab" />
              } @else {
                <app-home />
              }
            </section>
          }
        </div>
      }
    }
  `,
  styles: [`
    /* A column, so the notice line can take the height it needs off the top and
       the panes take the rest. */
    :host { display: flex; flex-direction: column; height: 100%; }
    .row { display: flex; flex: 1; min-height: 0; }

    /*
      \`min-width: 0\` and NOT the 280px the dividers clamp to. A hard minimum
      here would make five panes overflow a narrow window — the row would scroll
      sideways and a whole column would be off screen, which is worse than a
      cramped one. The floor is enforced where it can be enforced honestly:
      while a divider is being dragged.
    */
    .pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      height: 100%;
      overflow: hidden;
    }
    app-viewer, app-home { flex: 1; min-height: 0; }

    .divider {
      flex: 0 0 7px;
      position: relative;
      cursor: col-resize;
      background: transparent;
      /* Touch-action off, or a pointer drag on a touchscreen scrolls the row
         instead of moving the divider. */
      touch-action: none;
    }
    .divider::after {
      content: '';
      position: absolute;
      inset: 0 3px;
      background: var(--border-default);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .divider:hover::after { background: var(--accent); }
  `],
})
export class WorkspaceComponent {
  protected readonly tabs = inject(TabsService);

  /** The pane being resized, with the pixel widths the drag started from. */
  private drag: {
    left: string;
    right: string;
    leftPx: number;
    span: number;
    flex: number;
    x: number;
  } | null = null;

  protected activeIn(pane: Pane) {
    return this.tabs.byId(pane.activeTabId);
  }

  /**
   * Take the two panes' REAL widths and the two panes' flex, and hold the sum
   * of both constant while the drag moves one into the other.
   *
   * Measuring instead of computing from the flex numbers is what makes this
   * work on the first drag after a pane is added: the flexes are all 1 and the
   * pixel widths are whatever the window is, and the ratio between them is the
   * only thing that maps a mouse movement onto a share.
   */
  protected startResize(event: PointerEvent, index: number): void {
    const divider = event.currentTarget as HTMLElement;
    const left = divider.previousElementSibling as HTMLElement | null;
    const right = divider.nextElementSibling as HTMLElement | null;
    const panes = this.tabs.panes();
    const a = panes[index - 1];
    const b = panes[index];
    if (!left || !right || !a || !b) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    this.drag = {
      left: a.id,
      right: b.id,
      leftPx: left.offsetWidth,
      span: left.offsetWidth + right.offsetWidth,
      flex: a.flex + b.flex,
      x: event.clientX,
    };
  }

  protected onResize(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null) return;
    // Two panes narrower than two minimums between them cannot honour the
    // minimum, so the pair is simply halved rather than snapping to a width
    // that does not exist.
    const floor = drag.span < MIN_PANE_PX * 2 ? drag.span / 2 : MIN_PANE_PX;
    const wanted = drag.leftPx + (event.clientX - drag.x);
    const leftPx = Math.max(floor, Math.min(drag.span - floor, wanted));
    const share = drag.flex / drag.span;
    this.tabs.resize(drag.left, leftPx * share, drag.right, (drag.span - leftPx) * share);
  }

  protected endResize(event: PointerEvent): void {
    const divider = event.currentTarget as HTMLElement;
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    this.drag = null;
  }
}

/**
 * How narrow a column may be dragged.
 *
 * A book's chapter list is 260 wide on its own, so anything under this is a
 * pane that can show its furniture and nothing else.
 */
const MIN_PANE_PX = 280;
