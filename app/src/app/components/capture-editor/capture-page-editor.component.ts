import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';

import {
  type Dimensions,
  type FractionPoint,
  type FractionQuad,
  alongQuad,
  cornerNear,
  distanceToEdge,
  joined,
  rotate,
  splitAt,
  toPixels,
  withCorner,
} from './geometry';
import { outputSizeFor } from '@shared/capture';

import type { ApplyToAll } from '../../core/capture.service';
import { Rectifier } from './rectify';

/**
 * ONE PHOTOGRAPH, WITH ITS CORNERS IN THE USER'S HANDS.
 *
 * ── What this component is responsible for, and what it deliberately is not ──
 *
 * It draws a working copy, puts handles on the quads over it, and says what the
 * person did to them. It knows nothing about the recipe, the project, or IPC:
 * quads arrive as an input and leave as an output, in the recipe's own unit
 * (fractions of the working copy), and `capture.service.ts` is what turns that
 * into a `capture:recipe-save`.
 *
 * That line is drawn where it is because this is the surface the corners are
 * chosen on, and a surface that also owned the saving would have to be opened to
 * be tested by hand, and would drag the whole contract in behind it. As written
 * it can be pointed at any image with any quads.
 *
 * ── THE PREVIEW IS THE SAME SHADER AS THE MINT, WHICH IS THE POINT ──────────
 *
 * The panel on the right is `Rectifier` — the identical transform the mint will
 * run at full resolution, drawn small. docs/CAPTURE.md rules that the mint and
 * the preview are "one shader, not two implementations", so what a person sees
 * while dragging a corner is the page they are going to get rather than a
 * promise about it. It also means the doc's own out-of-bounds hazard is visible
 * here: `withinSource` comes back false and the panel says so.
 *
 * ── CORNERS CLAMP TO THE PHOTOGRAPH, WHICH THEY DID NOT AT FIRST ────────────
 *
 * An earlier revision let a corner be dragged off the frame and merely SAID so
 * in the preview panel, on the reasoning that a crop is somebody's choice. Two
 * things killed it. There is nothing out there — sampling past the edge clamps
 * to the last row of pixels, so an off-frame crop is a smear rather than a
 * choice — and `validQuad` in electron/capture.ts refuses any coordinate
 * outside [0,1] when the recipe is saved. Together those made one drag past the
 * edge stop the recipe SAVING, for the rest of the session, while the light
 * table went on looking alive. Pointer capture means the pointer is routinely
 * outside the picture box, so it was not a corner case.
 *
 * So the drag clamps, the way the split line always did, and `withinSource`
 * stops being a routine notice and becomes what it should have been: a
 * should-never-happen that says the shader was handed something impossible.
 *
 * ── Geometry lives next door, not here ──────────────────────────────────────
 *
 * Every rule about what a corner MEANS — a quarter turn is a permutation, a
 * split cuts across the quad's own edges rather than the photograph's, a quad
 * may only be copied onto a photo of the same shape — is in `geometry.ts` and
 * shared with the grid and the mint driver. What is left here is pointer
 * arithmetic and drawing, which is the only part that could not be shared.
 *
 * ── The wrapper is the picture, so there is no letterbox arithmetic ─────────
 *
 * The image sits in a box given the working copy's own aspect ratio, sized to
 * fit whatever room it has. So the box's client rectangle IS the picture, and
 * turning a pointer position into a fraction is one subtraction and one divide
 * — no `object-fit` maths that has to agree with the browser's, and nothing
 * that goes subtly wrong when the pane is resized mid-drag.
 */
@Component({
  selector: 'app-capture-page-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="editor">
      <div class="picture-column">
        <!--
          THE FRAME OWNS THE LEFTOVER HEIGHT. See the styles: without it the
          picture sized itself against the whole column and overflowed it.
        -->
        <div class="frame">
        <div
          class="picture"
          #picture
          [style.aspect-ratio]="aspectRatio()"
          (pointerdown)="grab($event)"
          (pointermove)="drag($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
        >
          <img #photo [src]="source()" [alt]="'The photograph being edited'" draggable="false" />

          <!--
            The handles are an SVG in the picture's own fraction space
            (viewBox 0 0 1 1), so nothing here has to know the pixel size of
            the box it is drawn in, and a resize needs no recomputation.
            \`vector-effect\` keeps the strokes one pixel wide at any scale.
          -->
          <svg class="handles" viewBox="0 0 1 1" preserveAspectRatio="none">
            @for (quad of quads(); track $index) {
              <polygon
                class="outline"
                vector-effect="non-scaling-stroke"
                [attr.points]="outlineOf(quad)"
              />
            }
            @if (splitLine(); as line) {
              <line
                class="split"
                vector-effect="non-scaling-stroke"
                [attr.x1]="line.from[0]" [attr.y1]="line.from[1]"
                [attr.x2]="line.to[0]" [attr.y2]="line.to[1]"
              />
            }
          </svg>

          <!--
            Corner handles are DOM rather than SVG circles: they want a hit area
            bigger than the dot a person aims at, and a CSS box gives that for
            free at any zoom. Positioned in percentages, which is the same
            fraction space the quads are already in.
          -->
          @for (handle of handles(); track handle.key) {
            <span
              class="handle"
              [class.held]="held()?.quad === handle.quad && held()?.corner === handle.corner"
              [style.left.%]="handle.at[0] * 100"
              [style.top.%]="handle.at[1] * 100"
            ></span>
          }
        </div>
        </div>

        <div class="gestures">
          <button type="button" (click)="turn(-1)" title="Turn this page anticlockwise">⟲</button>
          <button type="button" (click)="turn(1)" title="Turn this page clockwise">⟳</button>
          <button type="button" (click)="applyTurnToAll()" [disabled]="turnsApplied() === 0">
            Apply turn to all
          </button>
          @if (quads().length === 1) {
            <button type="button" (click)="split()">Split</button>
          }
          <button type="button" (click)="applySplitToAll()" [disabled]="quads().length < 2">
            Apply split to all
          </button>
          <button type="button" (click)="applyToAll.emit({ kind: 'quad' })">Apply crop to all</button>
        </div>
      </div>

      <div class="previews">
        @for (preview of previews(); track preview.index) {
          <figure>
            <canvas #previewCanvas [width]="preview.width" [height]="preview.height"></canvas>
            <figcaption>
              Page {{ preview.index + 1 }}
              @if (!preview.withinSource) {
                <span class="outside">— corners fall outside this photograph</span>
              }
            </figcaption>
          </figure>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; height: 100%; min-height: 0; }
    .editor { display: flex; flex: 1; min-width: 0; gap: 16px; padding: 12px; }

    .picture-column { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1 1 0; gap: 8px; }

    /*
     * THE FRAME, AND WHY THE TOP TWO CORNERS COULD NOT BE GRABBED.
     *
     * The picture used to be a direct child of the column, sized with a
     * max-height of 100% and centred with an auto margin. That 100% resolves
     * against THE WHOLE COLUMN, which also holds the gestures row and a gap --
     * so the picture was allowed to be as tall as everything, the column
     * overflowed, and the auto margin split the overflow evenly above and below.
     *
     * CONTENT PUSHED ABOVE A CONTAINERS START EDGE CANNOT BE SCROLLED TO. So the
     * top of the photograph, and the two corner handles on it, were off screen
     * and unclickable while the bottom two were reachable. Owen found it as
     * "cant grab the top two", which is exactly what that looks like from the
     * outside: a hit test that works at one end of the picture and not the
     * other. The hit test was never wrong.
     *
     * The frame takes the leftover height as a flex item, so the max-height on
     * the picture now resolves against the space that is actually free, and the
     * centring is done by the container rather than by an auto margin that can
     * push its own item out of reach.
     */
    .frame {
      flex: 1 1 0;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    /*
      The box IS the picture — see the class docblock. \`max-height: 100%\` with
      \`aspect-ratio\` set from the working copy lets it letterbox itself inside
      whatever room the pane has, without anything measuring it.
    */
    .picture {
      position: relative;
      max-width: 100%;
      max-height: 100%;
      touch-action: none;
      user-select: none;
      background: var(--bg-sunken);
    }
    .picture img { display: block; width: 100%; height: 100%; }

    .handles { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .outline { fill: none; stroke: var(--accent, #4c9aff); stroke-width: 2; }
    .split { stroke: var(--warn, #d08770); stroke-width: 2; stroke-dasharray: 6 4; }

    .handle {
      position: absolute;
      width: 18px; height: 18px;
      margin: -9px 0 0 -9px;
      border: 2px solid var(--accent, #4c9aff);
      border-radius: 50%;
      background: var(--bg-raised, #fff);
      pointer-events: none;
    }
    .handle.held { background: var(--accent, #4c9aff); }

    .gestures { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
    .gestures button {
      padding: 4px 10px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .gestures button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .gestures button:disabled { opacity: 0.4; cursor: default; }

    .previews { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; flex: 0 0 220px; }
    .previews figure { margin: 0; }
    .previews canvas { width: 100%; height: auto; background: var(--bg-sunken); }
    figcaption { font-size: 11px; color: var(--text-tertiary); }
    .outside { color: var(--warn); }
  `],
})
export class CapturePageEditorComponent {
  /** The working copy's URL — a `foundry-file://capture/<token>/<name>` served by main. */
  readonly source = input.required<string>();
  /** Its pixel size AS THE DECODER REPORTED IT, never as EXIF describes it. */
  readonly dimensions = input.required<Dimensions>();
  /** One quad per page of this photograph: one before a split, two after. */
  readonly quads = input.required<readonly FractionQuad[]>();
  /** Where the split handle sits, as a fraction of width, or null for unsplit. */
  readonly splitFraction = input<number | null>(null);

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<number>();
  /**
   * "Apply to all", which this component can ASK for and cannot DO: it is a
   * copy onto other photographs, and only the service holds those — including
   * the shape test that decides which of them are skipped.
   */
  readonly applyToAll = output<ApplyToAll>();

  private readonly picture = viewChild.required<ElementRef<HTMLElement>>('picture');
  private readonly photo = viewChild.required<ElementRef<HTMLImageElement>>('photo');
  /*
   * The preview canvases, in template order — which is `previews()` order,
   * because they are that list's `@for`. Asked for as a view query rather than
   * found with `querySelector` on a data attribute: the query is checked at
   * compile time and cannot go stale against a selector somebody renamed.
   */
  private readonly previewCanvases = viewChildren<ElementRef<HTMLCanvasElement>>('previewCanvas');

  /** Which corner is under the pointer right now, or null between drags. */
  protected readonly held = signal<{ quad: number; corner: 0 | 1 | 2 | 3 } | null>(null);
  /** Quarter turns applied to this photograph since it was opened. */
  protected readonly turnsApplied = signal(0);
  private draggingSplit = false;

  protected readonly aspectRatio = computed(() => {
    const { width, height } = this.dimensions();
    return `${width} / ${height}`;
  });

  /** Every corner of every quad, flattened for the template. */
  protected readonly handles = computed(() =>
    this.quads().flatMap((quad, quadIndex) =>
      ([0, 1, 2, 3] as const).map((corner) => ({
        key: `${quadIndex}:${corner}`,
        quad: quadIndex,
        corner,
        at: quad[corner],
      })),
    ),
  );

  /**
   * The split handle, drawn across THE WHOLE PAGE — `joined`, not the first
   * quad.
   *
   * An earlier revision split `quads()[0]` and a docblock here claimed that
   * kept the line on the gutter. It did the opposite: after a split that quad
   * is the LEFT HALF, so the line was drawn at `at` of the half rather than of
   * the page — it jumped to a quarter the instant the split landed, and halved
   * again with every drag. The comment asserting the behaviour is what made it
   * survive a reading; it was found by looking at a minted page.
   */
  protected readonly splitLine = computed(() => {
    const at = this.splitFraction();
    if (at === null) return null;
    const [left] = splitAt(joined(this.quads()), at);
    return { from: left[1], to: left[2] };
  });

  /** The size each page will mint at, and whether its corners are on the photo. */
  protected readonly previews = computed(() =>
    this.quads().map((quad, index) => {
      const size = outputSizeFor(toPixels(quad, this.dimensions()));
      const longest = Math.max(size.width, size.height);
      const scale = longest > 200 ? 200 / longest : 1;
      return {
        index,
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        withinSource: quad.every(([x, y]) => x >= 0 && y >= 0 && x <= 1 && y <= 1),
      };
    }),
  );

  private rectifier: Rectifier | null = null;

  constructor() {
    /*
     * ONE RECTIFIER FOR THE LIFE OF THE EDITOR, and it is disposed with the
     * component. Browsers cap live WebGL contexts and drop the oldest without
     * saying so, and this app can have an editor open beside a grid of cards
     * that also want to draw — a context per redraw would blank them in an
     * order nobody could predict. `rectify.ts` argues the same point at length.
     */
    inject(DestroyRef).onDestroy(() => {
      this.rectifier?.dispose();
      this.rectifier = null;
    });

    /*
     * Redraw whenever the quads move. It reads `previews()` and `source()`, so
     * the effect re-runs on a drag, a turn, a split, or a change of photograph
     * — and does nothing at all while the pointer is still.
     */
    effect(() => {
      const previews = this.previews();
      const quads = this.quads();
      const dimensions = this.dimensions();
      void this.source();
      queueMicrotask(() => this.draw(previews, quads, dimensions));
    });
  }

  protected outlineOf(quad: FractionQuad): string {
    return quad.map(([x, y]) => `${x},${y}`).join(' ');
  }

  protected grab(event: PointerEvent): void {
    const at = this.fractionOf(event);
    const { width } = this.picture().nativeElement.getBoundingClientRect();
    // The hit radius is in PIXELS on screen and converted, so the handle is the
    // same size to the hand whatever the picture has been scaled to.
    const radius = width === 0 ? 0 : 14 / width;

    const quads = this.quads();
    for (let index = 0; index < quads.length; index += 1) {
      const corner = cornerNear(toPixels(quads[index]!, UNIT), [at[0], at[1]], radius);
      if (corner !== null) {
        this.held.set({ quad: index, corner });
        this.picture().nativeElement.setPointerCapture(event.pointerId);
        return;
      }
    }

    /*
     * HIT THE LINE THAT IS DRAWN, not the photograph's x. `|at[0] - split|`
     * asked how far the pointer was from a vertical line at that fraction of
     * the frame — true only while the quad is upright, and every photograph on
     * the acceptance shoot is turned a quarter before anything else happens.
     */
    const line = this.splitLine();
    if (line !== null && distanceToEdge(at, line.from, line.to) <= radius) {
      this.draggingSplit = true;
      this.picture().nativeElement.setPointerCapture(event.pointerId);
    }
  }

  protected drag(event: PointerEvent): void {
    const holding = this.held();
    if (holding === null && !this.draggingSplit) return;
    const at = this.fractionOf(event);

    if (this.draggingSplit) {
      // Along the QUAD's own axis, and kept off both ends: a split at 0 is a
      // page of no width, which outputSizeFor rescues into one pixel. A page a
      // person can see is wrong beats a page they cannot, but a gutter they
      // cannot drag off the edge in the first place beats both.
      this.splitChange.emit(offEnds(alongQuad(joined(this.quads()), at)));
      return;
    }

    // Clamped HERE and nowhere else, because this is the only place a corner is
    // invented: `rotate` permutes the tuple and `splitAt` lerps between corners
    // that are already inside, so neither can carry a quad back out of range.
    const inside: FractionPoint = [clamp(at[0]), clamp(at[1])];
    const quads = this.quads();
    const moved = quads.map((quad, index) =>
      index === holding!.quad ? withCorner(quad, holding!.corner, inside) : quad,
    );
    this.quadsChange.emit(moved);
  }

  protected release(event: PointerEvent): void {
    if (this.held() === null && !this.draggingSplit) return;
    this.held.set(null);
    this.draggingSplit = false;
    if (this.picture().nativeElement.hasPointerCapture(event.pointerId)) {
      this.picture().nativeElement.releasePointerCapture(event.pointerId);
    }
  }

  /**
   * A quarter turn of every page on THIS photograph.
   *
   * The count is REMEMBERED because "apply to all" stamps THE TURN on every
   * photograph rather than this photograph's corners: a turn is a permutation,
   * and every other photo has corners of its own to permute. Without the count
   * the service would have to infer a rotation by comparing two quads, which is
   * arithmetic on floats standing in for a fact we already knew.
   */
  protected turn(turns: number): void {
    this.turnsApplied.update((sofar) => sofar + turns);
    this.quadsChange.emit(this.quads().map((quad) => rotate(quad, turns)));
  }

  /** Stamp the accumulated turn onto every photograph of the same shape. */
  protected applyTurnToAll(): void {
    this.applyToAll.emit({ kind: 'rotate', turns: this.turnsApplied() });
  }

  /**
   * Stamp this split onto every UNSPLIT photograph — the service enforces that
   * half of the rule, since only it can see the others.
   */
  protected applySplitToAll(): void {
    this.applyToAll.emit({ kind: 'split', at: this.splitFraction() ?? 0.5 });
  }

  /**
   * Cut this photograph into two pages at the split handle.
   *
   * The line defaults to the middle when nobody has dragged one, because a
   * spread photographed straight on is split down the middle and asking the
   * person to place a line before they may press the button would be ceremony.
   */
  protected split(): void {
    const first = this.quads()[0];
    if (first === undefined) return;
    const at = this.splitFraction() ?? 0.5;
    const [left, right] = splitAt(first, at);
    this.splitChange.emit(at);
    this.quadsChange.emit([left, right, ...this.quads().slice(1)]);
  }

  /** A pointer event's position as a fraction of the picture. */
  private fractionOf(event: PointerEvent): FractionPoint {
    const box = this.picture().nativeElement.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return [0, 0];
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height];
  }

  /**
   * Draw the previews.
   *
   * The image element is reused as the texture source rather than decoding the
   * working copy a second time: it is already in the page, already decoded, and
   * `Rectifier` takes an `HTMLImageElement` for exactly this reason. A picture
   * that has not finished loading has no dimensions yet and is skipped — the
   * effect will run again when the quads next move, and the load itself is what
   * puts the photograph on screen.
   */
  private draw(
    previews: readonly { index: number; width: number; height: number }[],
    quads: readonly FractionQuad[],
    dimensions: Dimensions,
  ): void {
    const image = this.photo().nativeElement;
    if (image.naturalWidth === 0) return;

    this.rectifier ??= new Rectifier();
    const canvases = this.previewCanvases();

    for (const preview of previews) {
      const quad = quads[preview.index];
      if (quad === undefined) continue;
      const target = canvases[preview.index]?.nativeElement;
      if (target === undefined) continue;

      const drawn = this.rectifier.rectify(
        image,
        toPixels(quad, dimensions),
        preview.width,
        preview.height,
      );
      const context = target.getContext('2d');
      // The rectifier owns ONE canvas and the next page overwrites it, so each
      // preview is copied out before the next is drawn.
      context?.drawImage(drawn.canvas, 0, 0);
    }
  }
}

/** The unit box, for turning fractions into "pixels" of a 1x1 picture. */
const UNIT: Dimensions = { width: 1, height: 1 };

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A gutter has to leave a page on each side of it. */
const SPLIT_MARGIN = 0.02;

function offEnds(value: number): number {
  return Math.min(1 - SPLIT_MARGIN, Math.max(SPLIT_MARGIN, value));
}
