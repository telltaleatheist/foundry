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
  /** The OCR dialog — read the pages, and nothing else. */
  readonly ocrOpen = signal(false);
  /**
   * The Export dialog — turn a reading into a document you can take away.
   *
   * The other half of what OCR used to be. They are separate because they cost
   * different things: reading is hours of GPU and is held for a Start button,
   * exporting is arithmetic over a bank that is already paid for and runs the
   * moment it is asked for.
   *
   * IT WAS CALLED GENERATE, and the rename is a ruling rather than a coat of
   * paint (docs/WORKBENCH.md §6). A generate produced a file into the working
   * directories and left the user to work out what it was FOR; an export is
   * terminal — it is the finished thing, it lands in the project's `final/`, and
   * it is never anybody's parent. Renaming the button without moving the landing
   * would have been the same confusion with better spelling.
   */
  readonly exportOpen = signal(false);
  /** The Translate dialog. */
  readonly translateOpen = signal(false);
  /** The Metadata dialog — the book's own record, not the app's idea of it. */
  readonly metadataOpen = signal(false);
  /**
   * The one confirmation, asked before anything is erased (ConfirmService).
   *
   * In the list below with the rest, which is what stops a delete question from
   * opening under an OCR card nobody can see past — and what lets the service
   * turn "somebody closed it" into "they said no".
   */
  readonly confirmOpen = signal(false);
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
   * What the queue shelf should say out loud, and a nudge to take focus.
   *
   * TWO SIGNALS RATHER THAN A METHOD CALL ON THE COMPONENT, because the shelf is
   * mounted by the shell and the OCR dialog has no handle on it — and should
   * not: a dialog reaching into another component to move its focus is exactly
   * the wiring that stops working the first time either of them moves.
   *
   * `shelfSaid` is a live region's text: it is read by whatever is listening
   * when it changes, and it exists because the confirmation line the OCR dialog
   * used to leave on screen went away with the dialog. A change that is only
   * visible is a change a screen reader user was simply not told about.
   *
   * `focusShelfAt` is a counter and not a boolean. Two conversions queued in a
   * row have to move focus twice, and a flag that was already true the second
   * time would move it once — the classic shape of "it works, except when you
   * do it twice".
   */
  readonly shelfSaid = signal('');
  readonly focusShelfAt = signal(0);

  announce(said: string): void {
    this.shelfSaid.set(said);
  }

  focusShelf(): void {
    this.shelfExpanded.set(true);
    this.focusShelfAt.update((count) => count + 1);
  }

  /**
   * ONE AT A TIME. Every dialog is a full-screen scrim at the same z-index, so
   * two open at once is two overlapping cards where the click-outside of the
   * upper one dismisses nothing visible. Opening any of them closes the rest
   * rather than stacking — a modal is a question, and there is only ever one
   * being asked.
   *
   * The rule is kept by ONE list rather than by each opener naming its
   * siblings. With two dialogs the hand-wired form was three lines; with a
   * third it is the shape of a bug, because the failure is silent — a new
   * dialog somebody forgot to clear in one of the other openers looks fine
   * until two happen to be opened in that order.
   */
  private readonly dialogs = [
    this.ocrOpen,
    this.exportOpen,
    this.translateOpen,
    this.metadataOpen,
    this.confirmOpen,
  ] as const;

  private only(which: typeof this.dialogs[number]): void {
    for (const dialog of this.dialogs) dialog.set(dialog === which);
  }

  openOcr(): void {
    this.only(this.ocrOpen);
  }

  closeOcr(): void {
    this.ocrOpen.set(false);
  }

  openExport(): void {
    this.only(this.exportOpen);
  }

  closeExport(): void {
    this.exportOpen.set(false);
  }

  openTranslate(): void {
    this.only(this.translateOpen);
  }

  closeTranslate(): void {
    this.translateOpen.set(false);
  }

  openMetadata(): void {
    this.only(this.metadataOpen);
  }

  closeMetadata(): void {
    this.metadataOpen.set(false);
  }

  openConfirm(): void {
    this.only(this.confirmOpen);
  }

  closeConfirm(): void {
    this.confirmOpen.set(false);
  }
}
