import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { HomeComponent } from '../../components/home/home.component';
import { NoticeBarComponent } from '../../components/notice-bar/notice-bar.component';
import { DOCUMENT_MIME } from '../../components/open-documents/open-documents.component';
import { ViewerComponent } from '../../components/viewer/viewer.component';
import { TabsService, type Pane } from '../../core/tabs.service';

/**
 * The documents: one to five columns, one document in each.
 *
 * ONE PANE IS THE OLD APP, EXACTLY. No divider is drawn, the viewer spans the
 * window, and nothing on screen mentions that a second column is possible — the
 * split is a thing you go and do, not a thing the app keeps offering. Everything
 * below that is only reached once there are two.
 *
 * THE STRIPS ARE GONE. Each column used to carry a Chrome-style strip of its own
 * and the pane held a stack; the documents are a list in the shell's left panel
 * now (app-open-documents), and a column holds one of them. What a column is
 * showing is said by the title at the left of its own toolbar, because with no
 * strip nothing else says it.
 *
 * A pane with no document — which includes having no panes at all — is HOME.
 * Home is not a route and not a document: it is what a column is when there is
 * nothing in it to show, which means closing the last document lands somewhere
 * useful instead of on a grey rectangle, and Ctrl+\ can make an empty column to
 * drop something into.
 *
 * FOCUS IS A POINTERDOWN ON THE PANE, which is the whole model. Pointerdown and
 * not click, for two reasons: it lands before the `click` of the same gesture,
 * so a Save button that acts on "the focused pane" already has this one by the
 * time it runs; and a drag that begins in a pane also means that pane, where a
 * click that never completes would have said nothing.
 *
 * ── Taking a dropped row ─────────────────────────────────────────────────────
 *
 * A row dragged out of the list lands here, and where in a pane it lands decides
 * what happens: the MIDDLE shows it in that column, an EDGE BAND opens a new
 * column on that side. The preview says which before the mouse comes up, because
 * a drag with no preview is a guess.
 *
 * THE SHIELD IS NOT OPTIONAL. A rendered chapter is an <iframe> with its own
 * browsing context, and a drag over one delivers dragover/drop to the frame — so
 * without a transparent layer over each pane, a book could not be dropped onto
 * the page it is meant to replace, which is the middle of the target. The shield
 * exists only while a row is actually being dragged (TabsService.draggingDocument)
 * so nothing else in the app ever has a sheet of glass over it, and the preview
 * rectangle inside it is `pointer-events: none` — a preview that took the pointer
 * would take the dragover events the preview is computed from.
 */
@Component({
  selector: 'app-workspace',
  imports: [HomeComponent, NoticeBarComponent, ViewerComponent],
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
              @if (documentIn(pane); as tab) {
                <app-viewer [tab]="tab" />
              } @else {
                <app-home [pane]="pane.id" />
              }

              @if (tabs.draggingDocument()) {
                <div
                  class="shield"
                  (dragover)="onOver($event, pane)"
                  (dragleave)="onLeave()"
                  (drop)="onDrop($event, pane, index)"
                >
                  @if (preview(); as landing) {
                    @if (landing.paneId === pane.id) {
                      <div class="landing" [class.left]="landing.zone === 'left'" [class.right]="landing.zone === 'right'"></div>
                    }
                  }
                </div>
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

      \`position: relative\` is what the shield and its preview are measured and
      painted against.
    */
    .pane {
      position: relative;
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

    /*
      Over everything in the pane, iframes included, and only while a row is in
      the air. 30 puts it above the viewer's own content and below the dock
      (40), the shelf (900) and the dialogs (1200) — the drag comes FROM the
      documents panel, so the shield must never be over it.

      THE LADDER SURVIVED THE DOCK MOVING TO THE BOTTOM and the inspector
      arriving on the right, because none of the four is in a stacking context
      of its own: the shell, its row, .main and .pane set no z-index, no
      transform and no filter, so 30 and 40 are still compared against each
      other rather than against their parents. What the move DID change is
      overlap — the dock and the shelf's pill are both along the bottom edge
      now, and the shelf lifts itself by the dock's height token rather than
      relying on 900 to win an argument it should not be having.
    */
    .shield { position: absolute; inset: 0; z-index: 30; }

    /*
      The preview. \`pointer-events: none\` is load-bearing: an element that took
      the pointer would take the shield's dragover events with it, and the
      preview would flicker itself out of existence the moment it appeared.
    */
    .landing {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: var(--accent-faint);
      border: 2px solid var(--accent);
    }
    /* An edge drop makes a column, so it is drawn as the half of the pane the
       new column would occupy — not as a line, which says "insert here" without
       saying how much of the room it takes. */
    .landing.left { right: 50%; }
    .landing.right { left: 50%; }
  `],
})
export class WorkspaceComponent {
  protected readonly tabs = inject(TabsService);

  /** Which pane the pointer is over, and what a drop there would do. */
  protected readonly preview = signal<Landing | null>(null);

  /** The pane being resized, with the pixel widths the drag started from. */
  private drag: {
    left: string;
    right: string;
    leftPx: number;
    span: number;
    flex: number;
    x: number;
  } | null = null;

  protected documentIn(pane: Pane) {
    return this.tabs.byId(pane.tabId);
  }

  // ── Taking a dropped row ─────────────────────────────────────────────────

  protected onOver(event: DragEvent, pane: Pane): void {
    if (!carriesDocument(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.preview.set({ paneId: pane.id, zone: this.zoneAt(event, box) });
  }

  protected onLeave(): void {
    this.preview.set(null);
  }

  protected onDrop(event: DragEvent, pane: Pane, index: number): void {
    const id = event.dataTransfer?.getData(DOCUMENT_MIME);
    // Recomputed from this event rather than read off the preview signal, so
    // what happens is what the geometry under the pointer says — a preview left
    // over from the pane next door could otherwise decide the drop.
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = this.zoneAt(event, box);
    this.preview.set(null);
    this.tabs.draggingDocument.set(false);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (zone === 'middle') this.tabs.show(id, pane.id);
    else this.tabs.openInNewPane(id, zone === 'left' ? index : index + 1);
  }

  /**
   * Which third of the pane the pointer is in.
   *
   * The band is a QUARTER of the pane, floored at 60px so a narrow column still
   * has a target a hand can hit and capped at 160 so a wide one does not turn
   * half the page into a splitter. Everything between them is the middle, which
   * is the drop a person means by default.
   *
   * AT THE CAP THE BANDS DO NOT EXIST: `canSplit` is false, the whole pane is a
   * middle drop, and nothing lights up along the edges. A target that highlights
   * and then refuses is worse than one that visibly will not take it — and the
   * refusal is still there by name, in `openInNewPane`, for a drop that arrives
   * some other way.
   */
  private zoneAt(event: DragEvent, box: DOMRect): Zone {
    if (!this.tabs.canSplit()) return 'middle';
    const band = Math.max(60, Math.min(160, box.width * 0.25));
    if (event.clientX < box.left + band) return 'left';
    if (event.clientX > box.right - band) return 'right';
    return 'middle';
  }

  // ── The dividers ─────────────────────────────────────────────────────────

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

type Zone = 'left' | 'middle' | 'right';
interface Landing { paneId: string; zone: Zone }

/** Whether this drag is a document out of the list, rather than files from the OS. */
function carriesDocument(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(DOCUMENT_MIME) === true;
}

/**
 * How narrow a column may be dragged.
 *
 * It used to be measured against the chapter list a book carried inside every
 * pane — 260 pixels of furniture before a word of the page. That list is in the
 * shell's inspector now, so what a column has to fit is the reading toolbar: a
 * title, Edit HTML, the mode line and Save, which run out of room well before
 * this. The number is unchanged because the floor it sets is still the right
 * one; only the reason for it moved.
 */
const MIN_PANE_PX = 280;
