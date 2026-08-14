import { Injectable, signal } from '@angular/core';

/**
 * The chrome's own state: which dialog is up, and whether the shelf is unrolled.
 *
 * The OCR tool used to be a slide-out panel beside the viewer and a toggle in
 * the rail. It is a MODAL now: configuring a conversion is a decision you make
 * once and dismiss, not a thing you keep open beside the document, and the panel
 * was spending 320 pixels of a book's width on four fields.
 */
@Injectable({ providedIn: 'root' })
export class UiService {
  /** The OCR / Convert dialog. */
  readonly ocrOpen = signal(false);
  /** The Translate dialog. */
  readonly translateOpen = signal(false);
  readonly shelfExpanded = signal(false);

  /**
   * Whether the open-documents panel is up.
   *
   * ON by default, and it still shows nothing until there is a document — the
   * panel is hidden outright while the app is empty (see App), so Home keeps the
   * whole window it has always had rather than opening beside 220 pixels of an
   * empty list.
   *
   * OFF, IT IS A 30-PIXEL STUB rather than nothing, and the stub holds the
   * button that brings it back — in the top-left corner of the window, which is
   * where the button that put it away was. Three things press this: that button,
   * Ctrl+B on the View menu, and the dock's Documents item. A panel with only a
   * keyboard chord to bring it back is a panel people lose.
   *
   * IN MEMORY ONLY, like the panes' widths: which panels are open is an
   * arrangement for the work in front of you, and restoring last week's is
   * furniture arriving in the wrong room.
   */
  readonly documentsShown = signal(true);

  toggleDocuments(): void {
    this.documentsShown.update((shown) => !shown);
  }

  /**
   * ONE AT A TIME. Both dialogs are full-screen scrims at the same z-index, so
   * two open at once is two overlapping cards where the click-outside of the
   * upper one dismisses nothing visible. Opening either closes the other rather
   * than stacking — a modal is a question, and there is only ever one being
   * asked.
   */
  openOcr(): void {
    this.translateOpen.set(false);
    this.ocrOpen.set(true);
  }

  closeOcr(): void {
    this.ocrOpen.set(false);
  }

  openTranslate(): void {
    this.ocrOpen.set(false);
    this.translateOpen.set(true);
  }

  closeTranslate(): void {
    this.translateOpen.set(false);
  }
}
