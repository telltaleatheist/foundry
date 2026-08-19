import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * ONE PAGE ON THE LIGHT TABLE.
 *
 * A thumbnail, what it is called, and whether it has been struck. It holds no
 * state and reaches nothing: the grid owns the order and the service owns the
 * recipe, so a card is a picture with two things it can say — "open me" and
 * "strike me".
 *
 * ── A STRUCK CARD STAYS ON THE TABLE ────────────────────────────────────────
 *
 * docs/CAPTURE.md: a struck page "stays visible on the grid the way struck rows
 * stay visible on the workbench, and is excluded from the mint". So striking is
 * drawn rather than subtracted — the card dims and says so, and the person can
 * see the retake they rejected sitting next to the one they kept. A card that
 * vanished would leave a hole in the spread order that nothing explains, and
 * unstriking would be a thing you could only do by remembering it was there.
 */
@Component({
  selector: 'app-capture-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="page" [class.struck]="struck()" (click)="open.emit()">
      <!--
        \`loading="lazy"\` because a shoot is dozens of these and the grid scrolls:
        the thumbnails below the fold are fetched when they are approached rather
        than all at once on open. They are 640 px JPEGs served through the
        capture door, so each is a small read (docs/CAPTURE.md, thumbnails).
      -->
      <img [src]="thumb()" [alt]="label()" loading="lazy" draggable="false" />
      <span class="label">{{ label() }}</span>
    </button>

    <button
      type="button"
      class="strike"
      [title]="struck() ? 'Put this page back in the book' : 'Leave this page out of the book'"
      (click)="strike.emit()"
    >{{ struck() ? '↺' : '⌦' }}</button>
  `,
  styles: [`
    :host { position: relative; display: block; }

    .page {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: 100%;
      padding: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md, 6px);
      background: var(--bg-raised);
      cursor: pointer;
      text-align: left;
    }
    .page:hover { border-color: var(--border-default); background: var(--bg-hover); }

    .page img {
      display: block;
      width: 100%;
      height: auto;
      background: var(--bg-sunken);
    }

    /*
      Struck is DIMMED AND CROSSED, not hidden — see the class docblock. Opacity
      alone would read as "still loading", so the label carries a line through it
      as well: two signals, because this one is a decision the person made and
      has to be able to see they made.
    */
    .page.struck { opacity: 0.45; }
    .page.struck .label { text-decoration: line-through; }

    .label {
      font-size: 11px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .strike {
      position: absolute;
      top: 10px;
      right: 10px;
      padding: 2px 5px;
      border: none;
      border-radius: var(--radius-sm, 4px);
      background: var(--bg-raised);
      color: var(--text-tertiary);
      cursor: pointer;
      opacity: 0;
      transition: opacity 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    /*
      The strike appears on hover OR focus. Focus matters as much as hover here:
      without it the control is unreachable from the keyboard, which would make
      striking a page a mouse-only act.
    */
    :host:hover .strike, .strike:focus-visible { opacity: 1; }
    .strike:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
})
export class CaptureCardComponent {
  /** The 640 px thumbnail's URL, through the capture door. */
  readonly thumb = input.required<string>();
  /** What this page is called on the table — its number, and the photo behind it. */
  readonly label = input.required<string>();
  /** Struck pages stay on the table and stay out of the mint. */
  readonly struck = input.required<boolean>();

  readonly open = output<void>();
  readonly strike = output<void>();
}
