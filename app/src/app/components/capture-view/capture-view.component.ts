import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import { mintedPageIds } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { CaptureMintService } from '../../core/capture-mint.service';
import { ConfirmService } from '../../core/confirm.service';
import { type ApplyToAll, CaptureService } from '../../core/capture.service';
import type { Tab } from '../../core/documents.service';
import { CaptureEditorModalComponent } from '../capture-editor/capture-editor-modal.component';
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
/** How long the button says so. Long enough to read, short enough not to nag. */
const ACKNOWLEDGED_FOR_MS = 1600;

@Component({
  selector: 'app-capture-view',
  imports: [CaptureGridComponent, CaptureEditorModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="table">
      <!--
        THE TABLE IS ALWAYS DRAWN NOW. The editor used to REPLACE it, so leaving
        meant a button called "All photographs" and coming back meant finding
        your card again. It is a modal since Wave 21, and a modal is something
        you open rather than somewhere you go.
      -->
      <app-capture-grid
          [cards]="captures.cards()"
          [descending]="captures.descending()"
          [arranged]="captures.arranged()"
          (reorder)="captures.reorder($event)"
          (open)="openPage($event)"
          (strike)="captures.toggleStrike($event)"
          (reverse)="captures.reverse()"
          (dropped)="captures.intake(tab().path, $event)"
        (remove)="void confirmRemoval($event)"
      />
    </div>

    @if (open() !== null) {
      @if (opened(); as photo) {
        <app-capture-editor-modal
          [label]="photo.label"
          [source]="captures.url(photo.workingCopy)"
          [dimensions]="photo.dimensions"
          [quads]="photo.quads"
          [split]="photo.split"
          [stage]="captures.stage()"
          [hasPrevious]="walkIndex() > 0"
          [hasNext]="walkIndex() < walk().length - 1"
          [handSet]="handSet()"
          [handSetHere]="photo.handSet"
          [justApplied]="justApplied()"
          (quadsChange)="setQuads(photo.id, $event)"
          (splitChange)="captures.setSplit(photo.id, $event)"
          (applyToAll)="applyToAll(photo.id, $event)"
          (keep)="captures.keep(photo.id)"
          (step)="step($event)"
          (close)="open.set(null)"
        />
      } @else {
        <!--
          The open photograph left the recipe under us — only reachable through
          a hand-edited file today. The modal closes rather than drawing an
          empty room around a picture that is not there.
        -->
        <p class="gone">That photograph is no longer in this project.</p>
      }
    }

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
  private readonly confirm = inject(ConfirmService);

  readonly tab = input.required<Tab>();

  /** The photograph on the editor, by photo id, or null for the whole table. */
  protected readonly open = signal<string | null>(null);

  /** Which apply-to-all just landed, for the button that was pressed. */
  protected readonly justApplied = signal<ApplyToAll['kind'] | null>(null);
  private applauseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * THE PHOTOGRAPHS IN THE ARRANGEMENT'S OWN SEQUENCE, for prev/next.
   *
   * ── It walks PHOTOGRAPHS and the readout says PAGES ─────────────────────────
   *
   * Owen asked to "go from one page to the next", and the honest mapping is not
   * one to one: the editor edits a PHOTOGRAPH, and after a split one photograph
   * carries two pages. Walking the order page by page would show the same
   * picture twice in a row and call it two different numbers, which is worse
   * than either count on its own.
   *
   * So the step is a photograph and the label carries both facts -- "Photograph
   * 5 of 27, pages 9-10 of 54". The page numbers are what he will count in the
   * finished book; the photograph number is what is on the screen in front of
   * him. Neither number has to be inferred from the other.
   *
   * ── In the ORDER, not in `photos` ──────────────────────────────────────────
   *
   * The order is the arrangement, and the arrangement is what the grid draws and
   * the mint walks. Stepping through `recipe.photos` would be intake sequence,
   * which after any drag is a different book. First appearance decides a
   * photograph's place, so a split whose halves have been dragged apart still
   * has one position rather than two.
   *
   * ── STRUCK PAGES ARE INCLUDED, DELIBERATELY ────────────────────────────────
   *
   * A photograph whose pages are all struck stays in the walk. Skipping it would
   * make it unreachable from the editor -- which is exactly where somebody would
   * go to check whether they struck the right one, or to look at it before
   * putting it back. It is the grid that shows a strike; the editor should not
   * be the surface that hides it.
   */
  protected readonly walk = computed(() => {
    const recipe = this.captures.recipe();
    if (recipe === null) return [];
    const seen: string[] = [];
    for (const pageId of recipe.order) {
      const photo = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
      if (photo !== undefined && !seen.includes(photo.id)) seen.push(photo.id);
    }
    return seen;
  });

  protected readonly walkIndex = computed(() => {
    const id = this.open();
    return id === null ? -1 : this.walk().indexOf(id);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.applauseTimer !== null) clearTimeout(this.applauseTimer);
    });
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
    const at = this.walk().indexOf(photo.id);
    // Where this photograph's pages fall in the finished book, asked of the
    // ONE function that decides what the book is. This used to walk the order
    // and skip the struck here -- one of THREE bodies of that rule, the other
    // two being the footer thirty lines below and mintBegin across the bridge.
    // All three agreed, because all three were written from the same sentence,
    // which is exactly what outputSizeFor and sameShape did before they were
    // lifted. Caught by P1 before any of them drifted, which is the first time
    // in this feature that shape has been found early rather than late.
    const kept = mintedPageIds(recipe);
    const mine = photo.pages.filter((page) => !page.struck).map((page) => kept.indexOf(page.id) + 1);
    const pages = mine.length === 0
      ? 'struck'
      : mine.length === 1
        ? `page ${mine[0]} of ${kept.length}`
        : `pages ${mine[0]}-${mine[mine.length - 1]} of ${kept.length}`;
    return {
      id: photo.id,
      label: `Photograph ${at + 1} of ${this.walk().length} · ${pages}`,
      workingCopy: photo.workingCopy,
      dimensions: { width: photo.width, height: photo.height },
      quads: photo.pages.map((page) => page.quad) as readonly FractionQuad[],
      // The segment itself. The interim seam that measured it back into a
      // fraction for the old editor is gone with the editor that needed one.
      split: photo.split,
      handSet: photo.pages.some((page) => page.byHand === true),
    };
  });

  /**
   * How many pages a mint would write.
   *
   * NOT "as the mint does" any more -- it is the mint's own function. The
   * footer promises this number, the readout above promises a position within
   * it, and mintBegin decides what actually gets printed; a person who crops for
   * an hour, reads "of 54" and then counts the PDF is owed all three being the
   * same arithmetic rather than the same intention.
   */
  /**
   * How many PHOTOGRAPHS somebody has set by hand — what the override offers to
   * override, and the reason it is only drawn when there is one.
   *
   * Photographs and not pages, like every other count this surface shows a
   * person: a split spread whose crop was adjusted is one thing they did.
   */
  protected readonly handSet = computed(() => {
    const recipe = this.captures.recipe();
    if (recipe === null) return 0;
    return recipe.photos.filter((photo) => photo.pages.some((page) => page.byHand === true)).length;
  });

  protected readonly mintable = computed(() => {
    const recipe = this.captures.recipe();
    return recipe === null ? 0 : mintedPageIds(recipe).length;
  });

  /**
   * One photograph along the arrangement, clamped at both ends.
   *
   * Clamped rather than wrapping: fifty-four crops is a long sitting, and an
   * arrow that silently returns to the first photograph after the last would
   * make somebody redo work they had already done without noticing they had
   * gone round.
   */
  protected step(by: number): void {
    const order = this.walk();
    const at = this.walkIndex();
    if (at < 0) return;
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))];
    if (next !== undefined) this.open.set(next);
  }

  /**
   * ARROW KEYS, because he is about to do this fifty-four times.
   *
   * Ignored while a field or a dialog has the focus: the left arrow inside the
   * new-project name box has to move the caret, and a shortcut that eats a
   * keystroke somebody was typing is worse than no shortcut.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (this.open() === null) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    event.preventDefault();
    this.step(event.key === 'ArrowLeft' ? -1 : 1);
  }

  /**
   * Ask before removing, then remove.
   *
   * ── The question names what CANNOT be undone, and what is not lost ──────────
   *
   * Removal deletes the bank copy as well as the derived files, which sounds
   * worse than it is and has to be SAID rather than softened: the originals in
   * a capture project are copies, and the files the person dragged in are still
   * wherever they dragged them from. A confirm that hid that would be asking
   * somebody to be frightened of the wrong thing; one that omitted the deletion
   * would be hiding the real cost.
   *
   * ── IT TAKES PHOTOGRAPHS, ALREADY FOLDED ────────────────────────────────────
   *
   * This used to fold page ids to photographs itself, which was correct and was
   * the SECOND place doing it -- the grid's context menu counted raw pages and
   * called them photographs, so on a split shoot the menu offered to delete 52
   * and this asked about 27. The fold moved into the grid, where the menu can
   * see it, and this takes what that offered. One fold, one number, one act.
   */
  protected async confirmRemoval(photoIds: readonly string[]): Promise<void> {
    if (photoIds.length === 0) return;
    const many = photoIds.length !== 1;
    const agreed = await this.confirm.ask({
      message: many
        ? `Remove ${photoIds.length} photographs from this project?`
        : 'Remove this photograph from this project?',
      detail: [
        many
          ? 'Their pages leave the book, and the copies this project made of them are deleted.'
          : 'Its pages leave the book, and the copies this project made of it are deleted.',
        'The files you dragged in are untouched, wherever you dragged them from.',
      ],
      confirm: many ? `Remove ${photoIds.length}` : 'Remove',
    });
    if (agreed) await this.captures.remove(photoIds);
  }

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

  /** Kept so the template has one name for it whatever the segment type is. */
  protected setSplit(photoId: string, split: CaptureSplit): void {
    this.captures.setSplit(photoId, split);
  }

  /**
   * Run an apply-to-all and let the button say so for a moment.
   *
   * ── Tied to the ACT, not to the click ───────────────────────────────────────
   *
   * Owen: "If it did run then there should be an indication. Maybe have the
   * button change colors and say applied or something." His eyes are on the
   * button he pressed, three hundred pixels from the notice bar.
   *
   * It acknowledges only when something was actually applied. An apply where
   * every candidate was skipped -- a crop from the odd landscape frame, say --
   * lights nothing, because a button flashing "Applied" over a bar explaining
   * that nothing was is a surface arguing with itself. The sentence still
   * carries the count and the reasons; the button carries only the fact.
   */
  protected applyToAll(photoId: string, gesture: ApplyToAll): void {
    const outcome = this.captures.applyToAll(photoId, gesture);
    if (outcome.applied === 0) return;
    if (this.applauseTimer !== null) clearTimeout(this.applauseTimer);
    this.justApplied.set(gesture.kind);
    this.applauseTimer = setTimeout(() => {
      this.justApplied.set(null);
      this.applauseTimer = null;
    }, ACKNOWLEDGED_FOR_MS);
  }

  protected startMint(): void {
    void this.mint.mint(this.tab().path);
  }
}
