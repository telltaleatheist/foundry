import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';

import { ConfirmService } from '../../core/confirm.service';
import { UiService } from '../../core/ui.service';

/**
 * The one confirmation card — the app's own, in the app's own idiom.
 *
 * Scrim and card, like every other dialog here (ocr-dialog, translate-dialog,
 * metadata-dialog), because a question about a book should look like it came
 * from the program the book is in. What it replaced was a native message box:
 * the OS's rectangle, the OS's fonts, the OS's button order — correct, modal,
 * and visibly not this app.
 *
 * IT DRAWS SENTENCES IT DID NOT WRITE. Every word comes from main
 * (`DeletionPrompt`), which is the only side that knows the size on disk and how
 * many pages the readings bank holds. This file owns the card and the buttons
 * and has no opinion about the words in it.
 *
 * ── The safe button is the one that is focused ───────────────────────────────
 *
 * Carried across from the native dialog's `defaultId: 1`, whose comment said it
 * best: this is the one dialog in the app where a reflexive Enter would destroy
 * something. So focus lands on Keep it, Escape is Keep it, clicking the scrim is
 * Keep it, and the destructive button wears the error colour and has to be aimed
 * at. It is also LAST in the DOM after the safe one, so a Tab from the focused
 * button reaches it deliberately rather than a Shift+Tab reaching it by accident.
 *
 * The card takes focus itself the moment it opens, which is what makes Escape
 * work without a window-level key listener and what stops a keystroke aimed at
 * whatever was behind it landing there instead.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.confirmOpen() && confirm.prompt(); as prompt) {
      <div class="scrim" (click)="confirm.answer(false)"></div>

      <div
        #card
        class="card"
        role="alertdialog"
        aria-modal="true"
        [attr.aria-label]="prompt.message"
        tabindex="-1"
        (keydown.escape)="confirm.answer(false)"
      >
        <header class="head">
          <span class="title">{{ prompt.message }}</span>
        </header>

        <div class="body">
          @for (line of prompt.detail; track line) {
            <p class="line">{{ line }}</p>
          }
        </div>

        <!--
          Keep it FIRST and focused; the destructive one last and aimed at. The
          order is the safety, not the styling.
        -->
        <footer class="foot">
          <button #safe class="ghost" (click)="confirm.answer(false)">Keep it</button>
          <button class="danger" (click)="confirm.answer(true)">{{ prompt.confirm }}</button>
        </footer>
      </div>
    }
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT.
     *
     * This component is mounted for the whole life of the window — unlike the
     * three dialogs beside it, which app.ts only creates while they are open —
     * because the service that settles its promise has to be able to close it
     * from anywhere. That is the right call and it has a price this file has to
     * pay: a \`position: fixed; inset: 0\` host is a full-window sheet of glass
     * over the application AT ALL TIMES, and while the \`@if\` above leaves it
     * empty and invisible, an empty sheet of glass still swallows every click
     * that lands on it. It did: with nothing being confirmed, Home's rows, the
     * rail, the tabs — the entire app — took the pointer and did nothing with
     * it, which reads exactly like an app that has died.
     *
     * \`pointer-events: none\` here and \`auto\` on the two things that are drawn
     * fixes it in the state-independent way: the host never takes a click, open
     * or closed, and the scrim and the card take their own because they are
     * what a person can actually see to click on.
     */
    :host { position: fixed; inset: 0; z-index: 1300; display: block; pointer-events: none; }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    .card {
      position: relative;
      pointer-events: auto;
      width: min(520px, calc(100vw - 48px));
      max-height: calc(100vh - 96px);
      margin: 64px auto 0;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      outline: none;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .head { padding: 16px 20px 8px; }
    .title { font-family: var(--font-display); font-size: 15px; font-weight: 600; }

    .body { padding: 0 20px 4px; overflow-y: auto; }
    .line { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 20px 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .ghost, .danger {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    /* The error colour, filled rather than hinted: this button ends something.
       The same red the "not there any more" tag and Home's delete hover use. */
    .danger {
      border: none;
      background: var(--error); color: var(--text-inverse);
    }
    .danger:hover { filter: brightness(1.08); }
    .danger:active { transform: scale(0.98); }
  `],
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);
  protected readonly ui = inject(UiService);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly safe = viewChild<ElementRef<HTMLButtonElement>>('safe');

  constructor() {
    /*
     * FOCUS LANDS ON THE SAFE ANSWER, and it has to be done here rather than
     * with an `autofocus` attribute: the card is created by a control-flow
     * block, so there is no page load for the attribute to be honoured at, and
     * a card that opened without focus would send Escape and Enter to whatever
     * was behind the scrim.
     */
    effect(() => {
      if (!this.ui.confirmOpen()) return;
      const button = this.safe()?.nativeElement;
      const card = this.card()?.nativeElement;
      queueMicrotask(() => (button ?? card)?.focus());
    });
  }
}
