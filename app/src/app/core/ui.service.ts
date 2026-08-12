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
  /** The OCR / Convert dialog. One at a time; there is only the one. */
  readonly ocrOpen = signal(false);
  readonly shelfExpanded = signal(false);

  openOcr(): void {
    this.ocrOpen.set(true);
  }

  closeOcr(): void {
    this.ocrOpen.set(false);
  }
}
