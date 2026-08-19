import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import type { CaptureQuad } from '@shared/types';

import { CaptureMintService } from '../../core/capture-mint.service';
import { type ApplyToAll, CaptureService } from '../../core/capture.service';
import type { Tab } from '../../core/documents.service';
import { CapturePageEditorComponent } from '../capture-editor/capture-page-editor.component';
import type { FractionQuad } from '../capture-editor/geometry';
import { CaptureGridComponent } from '../capture-grid/capture-grid.component';

/**
 * THE LIGHT TABLE — a capture project's whole surface, and the viewer's third
 * branch.
 *
 * ── What this component is FOR, which is almost nothing ─────────────────────
 *
 * It owns one piece of state: WHICH PHOTOGRAPH IS OPEN. Everything else it
 * holds is somebody else's — the recipe is `CaptureService`'s, the cards are its
 * `cards` computed, the gestures are `CapturePageEditorComponent`'s, and the
 * rules about what a gesture MEANS are in `geometry.ts` and the service. This
 * file routes between two children and a service and does not decide anything
 * either of them could decide better.
 *
 * That is deliberate rather than modest. The editor is testable by pointing it
 * at any image with any quads precisely because it has never heard of a project,
 * and the grid can be handed a list of cards from anywhere. Putting the recipe
 * into either of them would have bought one less file and lost that.
 *
 * ── The tab is a DIRECTORY, and that is why the open lives in an effect ─────
 *
 * `Tab.path` here is the project directory (`pathIsProject`, documents.service),
 * so there is no file to load and nothing arrives through `document:opened`.
 * The recipe comes from `capture:recipe-load`, asked for whenever the tab
 * changes — an effect rather than a constructor call, because a tab input can
 * be re-pointed at another project without this component being rebuilt.
 *
 * ── ONE SERVICE FOR THE WHOLE APP, AND THAT IS A LIMIT WORTH KNOWING ────────
 *
 * `CaptureService` is `providedIn: 'root'` and holds ONE recipe, so two capture
 * projects open at once would share it and the second would evict the first.
 * Today that cannot happen: `captureTabIn` never makes a second tab for the same
 * project, and the workspace shows one document at a time. It WOULD happen the
 * day capture panes can be compared side by side, and the fix then is a service
 * instance per tab rather than a flag here. Written down because the failure —
 * two tables showing one recipe — would look like a redraw bug rather than a
 * scoping one.
 */
@Component({
  selector: 'app-capture-view',
  imports: [CaptureGridComponent, CapturePageEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="table">
      @if (open() === null) {
        <app-capture-grid
          [cards]="captures.cards()"
          [descending]="captures.descending()"
          [arranged]="captures.arranged()"
          (reorder)="captures.reorder($event)"
          (open)="openPage($event)"
          (strike)="captures.toggleStrike($event)"
          (reverse)="captures.reverse()"
          (dropped)="captures.intake(tab().path, $event)"
        />
      } @else if (opened(); as photo) {
        <header class="bar">
          <button class="quiet" type="button" (click)="open.set(null)">← All photographs</button>
          <span class="which">{{ photo.label }}</span>
          <span class="grow"></span>
        </header>
        <app-capture-page-editor
          [source]="captures.url(photo.workingCopy)"
          [dimensions]="photo.dimensions"
          [quads]="photo.quads"
          [splitFraction]="photo.split"
          (quadsChange)="setQuads(photo.id, $event)"
          (splitChange)="captures.setSplit(photo.id, $event)"
          (applyToAll)="applyToAll(photo.id, $event)"
        />
      } @else {
        <!--
          The open photograph left the recipe under us — only reachable through
          a hand-edited file today. Said rather than drawn as an empty editor.
        -->
        <p class="gone">That photograph is no longer in this project.</p>
        <button class="quiet" type="button" (click)="open.set(null)">Back to the table</button>
      }
    </div>

    <footer class="mint">
      @if (mint.progress(); as running) {
        <span class="progress">Minting page {{ running.done }} of {{ running.total }}…</span>
        <button class="quiet" type="button" (click)="mint.cancel()">Stop</button>
      } @else {
        <span class="count">{{ mintable() }} pages</span>
        <button class="act" type="button" [disabled]="mintable() === 0" (click)="startMint()">
          Mint the pages
        </button>
      }
    </footer>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .table {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }

    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--edge, #2a2a2a);
    }

    .grow { flex: 1; }

    .which { font-size: 12px; opacity: 0.8; }

    .gone { padding: 16px; opacity: 0.8; }

    .mint {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-top: 1px solid var(--edge, #2a2a2a);
    }

    .count, .progress { font-size: 12px; opacity: 0.8; }

    /*
     * THESE BUTTONS HAD NO RULES AT ALL and rendered native white.
     *
     * Angular component styles are SCOPED, so a button here inherits nothing
     * from the grid, the editor or any dialog -- and unlike those three, this
     * file had never declared any. Owen found the same defect in the new-project
     * modal, which carried confirm-dialog's CLASS NAMES and none of its rules;
     * this file did not even have the class names. Four buttons, and one of them
     * is MINT THE PAGES, which is the act the whole feature exists to perform.
     *
     * The quiet ones match the grid header and the editor gestures, which are
     * the controls a person meets on either side of this bar. The act matches
     * the dialogs' primary, because it is the same kind of thing: the button
     * worth pressing.
     */
    .quiet {
      padding: 3px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
    }
    .quiet:hover { background: var(--bg-hover); color: var(--text-primary); }

    .act {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border: none;
      border-radius: var(--radius-md);
      background: var(--accent-strong); color: var(--text-inverse);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .act:hover:not(:disabled) { background: var(--accent); }
    .act:active:not(:disabled) { transform: scale(0.98); }
    /* Nothing to mint yet is the normal state of a new project, so the button
       has to look patient rather than broken. */
    .act:disabled { opacity: 0.45; cursor: default; }
  `,
})
export class CaptureViewComponent {
  protected readonly captures = inject(CaptureService);
  protected readonly mint = inject(CaptureMintService);

  readonly tab = input.required<Tab>();

  /** The photograph on the editor, by photo id, or null for the whole table. */
  protected readonly open = signal<string | null>(null);

  constructor() {
    effect(() => {
      const directory = this.tab().path;
      // Back to the table whenever the project changes: an id from one recipe
      // means nothing in another, and the "no longer in this project" branch is
      // for a photograph that genuinely went, not for a tab that moved.
      this.open.set(null);
      void this.captures.open(directory);
    });
  }

  /**
   * Everything the editor needs about the open photograph, or null if it went.
   *
   * The quads are handed over as the recipe holds them — fractions — because
   * that is the unit the editor works in end to end (`geometry.ts`); the pixels
   * only exist inside the shader and inside the mint's page list.
   */
  protected readonly opened = computed(() => {
    const id = this.open();
    const recipe = this.captures.recipe();
    if (id === null || recipe === null) return null;
    const photo = recipe.photos.find((one) => one.id === id);
    if (photo === undefined) return null;
    const at = recipe.photos.indexOf(photo);
    return {
      id: photo.id,
      label: `Photograph ${at + 1} of ${recipe.photos.length}`,
      workingCopy: photo.workingCopy,
      dimensions: { width: photo.width, height: photo.height },
      quads: photo.pages.map((page) => page.quad) as readonly FractionQuad[],
      split: photo.split?.x ?? null,
    };
  });

  /** How many pages a mint would write — strikes left out, as the mint does. */
  protected readonly mintable = computed(() => {
    const recipe = this.captures.recipe();
    if (recipe === null) return 0;
    let count = 0;
    for (const id of recipe.order) {
      const photo = recipe.photos.find((one) => one.pages.some((page) => page.id === id));
      const page = photo?.pages.find((one) => one.id === id);
      if (page !== undefined && !page.struck) count += 1;
    }
    return count;
  });

  /** A card was clicked: the editor opens on the PHOTOGRAPH that page is on. */
  protected openPage(pageId: string): void {
    const recipe = this.captures.recipe();
    if (recipe === null) return;
    /*
     * A card is a PAGE and the editor edits a PHOTOGRAPH, which is not a
     * mismatch: both halves of a split are corners on one picture, and an editor
     * showing one half of a spread could not draw the split line that made it.
     */
    const photo = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
    if (photo !== undefined) this.open.set(photo.id);
  }

  protected setQuads(photoId: string, quads: readonly FractionQuad[]): void {
    this.captures.setQuads(photoId, quads as readonly CaptureQuad[]);
  }

  protected applyToAll(photoId: string, gesture: ApplyToAll): void {
    this.captures.applyToAll(photoId, gesture);
  }

  protected startMint(): void {
    void this.mint.mint(this.tab().path);
  }
}
