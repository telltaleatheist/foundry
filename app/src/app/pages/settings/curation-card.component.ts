import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { UnlinkedNoteStanding } from '@shared/types';

import { api } from '../../core/foundry';

/**
 * Curation — the one question select mode is allowed to stop asking.
 *
 * IT EXISTS BECAUSE OF THE CHECKBOX. Deleting a footnote's last reference number
 * puts up a dialog with "don't ask again" on it, and a preference that can be
 * set in half a second and unset nowhere is a trap: the next person to press
 * Enter on that box has silently changed what happens to every footnote in every
 * book they ever open, with nothing on screen that says so. This is where it
 * says so, and where it goes back.
 *
 * A card of its own rather than a field in the settings.json form, for the same
 * reason the library folder is: that file's schema belongs to the ENGINE and is
 * read by every `vlm-convert` on this machine. What a dialog in this app
 * remembers is nobody's business but this app's (electron/app-settings.ts).
 */
@Component({
  selector: 'app-curation-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card form">
      <div class="card-head"><span class="card-title">Curation</span></div>

      <label class="field">
        <span class="label">When an edit leaves a footnote with nothing pointing at it</span>
        <select [value]="answer()" (change)="choose($event)">
          <option value="ask">Ask me each time</option>
          <option value="cut">Always strike the footnote too</option>
          <option value="keep">Always leave the footnote standing</option>
        </select>
      </label>

      <p class="hint">
        Deleting a reference number by hand in select mode can leave its footnote unreachable.
        Striking it marks it the way Delete marks any block — it stays in the working copy until
        the final edition is built, so it can be brought back. This is the same choice the
        “don't ask again” box on that dialog makes.
      </p>

      @if (problem(); as reason) { <p class="warn">{{ reason }}</p> }
    </div>
  `,
  styles: [`
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }

    .field { display: flex; flex-direction: column; gap: 4px; }
    .label { font-size: 12px; color: var(--text-secondary); }

    .hint { margin: 0; font-size: 12px; color: var(--text-tertiary); line-height: 1.5; }
    .warn { margin: 0; font-size: 12px; color: var(--warn); }
  `],
})
export class CurationCardComponent {
  protected readonly answer = signal<UnlinkedNoteStanding>('ask');
  protected readonly problem = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) return;
    try {
      this.answer.set(await api.prefs.unlinkedNoteAnswer());
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The stored value is read back out of the write rather than assumed, so a
   * value main clamped is what the box goes on showing. It is the same rule the
   * keep-warm field follows.
   */
  protected async choose(event: Event): Promise<void> {
    if (!api) return;
    const wanted = (event.target as HTMLSelectElement).value as UnlinkedNoteStanding;
    this.problem.set(null);
    try {
      this.answer.set(await api.prefs.setUnlinkedNoteAnswer(wanted));
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
      void this.load();
    }
  }
}
