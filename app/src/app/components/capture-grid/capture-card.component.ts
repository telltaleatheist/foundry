import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { CaptureQuad } from '@shared/types';

/**
 * ONE PAGE ON THE LIGHT TABLE.
 *
 * A thumbnail, what it is called, and whether it has been struck. It holds no
 * state and reaches nothing: the grid owns the order and the service owns the
 * recipe, so a card is a picture with two things it can say — "open me" and
 * "strike me".
 *
 * ── IT DRAWS THE CROP, BECAUSE OTHERWISE NOTHING SHOWS ─────────────────────
 *
 * The card used to be the raw thumbnail and nothing else, so a photograph that
 * had been turned and cropped looked identical to one nobody had touched. Owen
 * ran apply-to-all across twenty-five photographs, it worked, and he reported
 * it as "didnt work... there was no indicator" -- which is the correct reading
 * of a grid that shows the same picture before and after.
 *
 * So the quad is drawn over the thumbnail: the outline of the page that will be
 * minted, and a mark on the corner that becomes its TOP-LEFT. The mark is what
 * makes a turn visible at all -- a quarter turn permutes the corner assignment
 * without moving any of them, so the outline alone is identical before and
 * after and only the mark moves.
 *
 * It is an overlay in the thumbnail's own fraction space (viewBox 0 0 1 1),
 * exactly as the editor's handles are, so nothing here measures pixels and the
 * card can be any size.
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
    <button
      type="button"
      class="page"
      [class.struck]="struck()"
      [class.chosen]="chosen()"
      (click)="open.emit()"
    >
      <!--
        \`loading="lazy"\` because a shoot is dozens of these and the grid scrolls:
        the thumbnails below the fold are fetched when they are approached rather
        than all at once on open. They are 640 px JPEGs served through the
        capture door, so each is a small read (docs/CAPTURE.md, thumbnails).
      -->
      <span class="shot">
        <img [src]="thumb()" [alt]="label()" loading="lazy" draggable="false" />
        <svg class="crop" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <polygon [attr.points]="outline()" />
          <!--
            The corner that becomes the minted page's top-left. Without it a
            quarter turn is invisible: the four corners are the same four
            points, and only which one is FIRST has changed.
          -->
          <circle [attr.cx]="corner()[0]" [attr.cy]="corner()[1]" r="0.04" />
        </svg>
      </span>
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
    /*
     * CHOSEN IS A BORDER AND A WASH, not a tint over the picture. The
     * photographs are the only bright thing on this table and a selection that
     * dimmed or coloured them would be selecting by damaging what somebody is
     * trying to look at.
     */
    .page.chosen {
      border-color: var(--accent);
      background: var(--accent-faint);
    }
    .page.chosen:hover { background: var(--accent-soft); }

    /* The picture and its overlay share one box, so the SVG's fraction space
       is the thumbnail's own. */
    .shot { position: relative; display: block; }
    .crop {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .crop polygon {
      fill: none;
      stroke: var(--accent, #4c9aff);
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .crop circle { fill: var(--accent, #4c9aff); }
    /* A struck page's crop goes quiet with the rest of the card rather than
       staying bright over a dimmed picture. */
    .page.struck .crop { opacity: 0.35; }

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
  /**
   * Whether this card is in the marquee's selection.
   *
   * DRAWN, NOT INFERRED FROM FOCUS. A selection of nine cards has one focused
   * element and nine chosen ones, and the person needs to see all nine before
   * they press Delete on the lot.
   */
  readonly chosen = input<boolean>(false);

  /** The page this card will mint, in the thumbnail's own fraction space. */
  readonly quad = input.required<CaptureQuad>();

  protected readonly outline = computed(() =>
    this.quad().map(([x, y]) => `${x},${y}`).join(' '),
  );
  /** The quad's FIRST corner — the minted page's top-left. See the docblock. */
  protected readonly corner = computed(() => this.quad()[0]);

  readonly open = output<void>();
  readonly strike = output<void>();
}
