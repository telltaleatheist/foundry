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
