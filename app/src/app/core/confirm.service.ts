import { Injectable, effect, inject, signal } from '@angular/core';

import type { DeletionPrompt } from '@shared/types';

import { UiService } from './ui.service';

/**
 * The app's one confirmation, asked in the app.
 *
 * IT REPLACED A NATIVE MESSAGE BOX, and the reason is worth writing down because
 * the native one had a real advantage this has to earn back. `dialog.showMessageBox`
 * is modal to the WINDOW: the next gesture cannot race it, and it cannot scroll
 * out from under itself. What it could not do is look like this app — it is the
 * OS's rectangle, in the OS's fonts, with the OS's button order, and a program
 * whose every other question is a card in its own idiom asking this one through
 * a system alert reads as a program interrupted by something else. The user
 * called it "the js alert" and wanted it gone.
 *
 * So the card is ours and the FACTS ARE STILL MAIN'S. Nothing in this file
 * composes a sentence: `DeletionPrompt` arrives whole from the process that
 * knows the size on disk and the readings bank's page count (electron/main.ts).
 * The one thing the renderer must never do to this dialog is start writing its
 * own copy, which is how a warning worth reading becomes "Are you sure?".
 *
 * A PROMISE, so a caller reads as the sentence it is:
 *
 *     if (!await this.confirm.ask(prompt)) return;
 *
 * ONE AT A TIME, through `UiService.dialogs` like every other modal — and that
 * registration is what makes the promise safe. Any other dialog opening closes
 * this one, and the effect below turns that into a `false`: a question whose
 * card is gone has been declined, and a promise nobody will ever settle is a
 * caller stuck forever holding a lock on a delete.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly ui = inject(UiService);

  /** What the card is currently asking. Null when nothing is. */
  readonly prompt = signal<DeletionPrompt | null>(null);

  private settle: ((answer: boolean) => void) | null = null;

  constructor() {
    effect(() => {
      // Closed by anything at all — Escape, the scrim, another dialog opening —
      // is a No. The card is the question; without it there is nothing to answer.
      if (!this.ui.confirmOpen()) this.finish(false);
    });
  }

  /**
   * Ask, and resolve with what they pressed.
   *
   * A second ask while one is up declines the first rather than queueing behind
   * it. Two confirmations in flight would be two cards at one z-index, and the
   * caller of the older one is holding a path it is about to act on — settling
   * it `false` is the only answer that cannot destroy anything.
   */
  ask(prompt: DeletionPrompt): Promise<boolean> {
    this.finish(false);
    this.prompt.set(prompt);
    this.ui.openConfirm();
    return new Promise<boolean>((resolve) => {
      this.settle = resolve;
    });
  }

  /** The card's own two buttons. */
  answer(yes: boolean): void {
    this.finish(yes);
    this.ui.closeConfirm();
    this.prompt.set(null);
  }

  private finish(answer: boolean): void {
    const settle = this.settle;
    this.settle = null;
    settle?.(answer);
  }
}
