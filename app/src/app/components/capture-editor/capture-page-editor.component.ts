import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
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
  cornerNear,
  distanceToEdge,
  toPixels,
  withCorner,
} from './geometry';
import {
  cutOf, joinedQuad, outputSizeFor, seatSplit, slideSplit, turnsOf, WHOLE_FRAME,
} from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

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
 * ── THE GESTURE ROW MOVED UP, AND THAT IS THIS FILE GETTING ITS JOB BACK ────
 *
 * Turn, Split and the applies used to sit under the picture here. Wave 21 put
 * them in the modal footer, which is where they belonged all along: an apply-to-
 * all is an act on THE WHOLE SHOOT, and this component has never heard of a
 * second photograph. What is left is exactly what the docblock above always
 * claimed -- a picture, handles on it, and what the person did to them.
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
        <!--
          THE LISTENERS ARE ON THE FRAME, NOT ON THE PICTURE, and that is the
          whole of Owen's "cant grab the top two".

          A handle is 18px wide and centred ON its corner with a -9px margin, so
          a quad hugging an edge -- which the whole-frame default is, on every
          photograph of this shoot -- puts HALF of each edge handle outside the
          picture. A press aimed at the visible dot then lands on whatever is
          behind it, and grab() never runs. The bottom corners happened to sit
          far enough inside the visible area on his screen for their circles to
          be fully over the listener, which is the entire asymmetry: the top two
          were not special, they were just the ones at an edge he pressed above.

          The frame owns the leftover space and is padded (see the styles), so
          every handle now has listening surface all the way around it. The
          fraction conversion still measures the PICTURE, so a press that starts
          in the padding is simply a fraction slightly outside [0,1] -- which the
          drag already clamps, and which cornerNear already measures honestly.
        -->
        <div
          class="frame"
          #frame
          (pointerdown)="grab($event)"
          (pointermove)="drag($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
        >
        <div
          class="picture"
          #picture
          [style.aspect-ratio]="turned().box"
          [style.width]="turned().slotWidth"
          [style.height]="turned().slotHeight"
        >
        <!--
          THE PHOTOGRAPH IS SHOWN THE WAY ROUND IT WILL PRINT.

          Owen, three separate reports, the last of them: "no matter how i
          rotated it, the thumbnails are properly rotated, but the main image
          inside the modal is not rotated". It was not, and that was the
          design -- a turn permutes the corner assignment without moving a
          corner, so the picture is identical before and after and only the
          first-corner mark moves.

          It is a bad argument, and the evidence is that the person it was
          written for could not read it three times running. The table draws the
          printed orientation, so the editor was the one surface disagreeing
          with every other: turn twenty-five spreads upright, see them upright
          on the table, open one, find it on its side.

          Picture and handles turn as ONE element, as the card does and for the
          same reason -- the handles are drawn in the photograph's own fraction
          space, so turning one without the other would put a sideways crop over
          an upright photograph, which reads as a bug in the crop rather than as
          an absence.
        -->
        <div
          class="spun"
          #spun
          [style.width]="turned().spunWidth"
          [style.height]="turned().spunHeight"
          [style.transform]="turned().spin"
        >
          <!--
            (load) IS THE OTHER HALF OF THE REDRAW, and see repaint() for why an
            effect alone could not be.
          -->
          <img
            #photo
            [src]="source()"
            [alt]="'The photograph being edited'"
            (load)="repaint()"
            draggable="false"
          />

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
            @if (cut(); as line) {
              <line
                class="split"
                [class.proposed]="proposing()"
                vector-effect="non-scaling-stroke"
                [attr.x1]="line.a.point[0]" [attr.y1]="line.a.point[1]"
                [attr.x2]="line.b.point[0]" [attr.y2]="line.b.point[1]"
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
              [class.first]="handle.corner === 0"
              [class.held]="held()?.quad === handle.quad && held()?.corner === handle.corner"
              [style.left.%]="handle.at[0] * 100"
              [style.top.%]="handle.at[1] * 100"
            ></span>
          }

          <!--
            THE GUTTER'S TWO ENDS, EACH RIDING AN EDGE OF THE PAGE.

            Drawn where the geometry resolves the end to, not at the stored endpoint:
            the segment is gesture state and goes stale against a crop dragged
            after it, so what is on screen is where the geometry says the end
            actually sits. They are a different colour from the corners because
            they do a different thing -- a corner moves the page, these move the
            cut through it.
          -->
          @if (cut(); as line) {
            <span
              class="gutter"
              [class.held]="holdingSplit() === 'a'"
              [style.left.%]="line.a.point[0] * 100"
              [style.top.%]="line.a.point[1] * 100"
            ></span>
            <span
              class="gutter"
              [class.held]="holdingSplit() === 'b'"
              [style.left.%]="line.b.point[0] * 100"
              [style.top.%]="line.b.point[1] * 100"
            ></span>
          }
        </div>
        </div>
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
      /*
       * ROOM FOR THE HANDLES TO HANG OVER THE EDGE. Half a handle is 9px, so 12
       * leaves a margin for the hand as well as for the dot. Without it a
       * picture that exactly fills the frame would put its edge handles hard
       * against the clip again, and moving the listeners here would have bought
       * nothing at the one place it was needed.
       */
      padding: 12px;
      touch-action: none;
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
      user-select: none;
      background: var(--bg-sunken);
    }
    /*
     * Laid out at the PHOTOGRAPH's aspect and rotated onto the slot, exactly as
     * the card's .spun is -- see the template. Centred, because a rotation
     * about a corner would swing the picture out of the box.
     */
    .spun { position: absolute; top: 50%; left: 50%; transform-origin: center; }
    .picture img { display: block; width: 100%; height: 100%; }

    .handles { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .outline { fill: none; stroke: var(--accent, #4c9aff); stroke-width: 2; }
    .split { stroke: var(--warn, #d08770); stroke-width: 2; stroke-dasharray: 6 4; }
    /* A PROPOSAL WEARS THE HANDLES' COLOUR, because that is what it is: a thing
       you are placing, not a cut this book has made. Same weight, so it is
       exactly as visible -- being unmissable the moment the tool opens is the
       whole reason it exists. */
    .split.proposed { stroke: var(--accent, #4c9aff); }

    .handle {
      position: absolute;
      width: 18px; height: 18px;
      margin: -9px 0 0 -9px;
      border: 2px solid var(--accent, #4c9aff);
      border-radius: 50%;
      background: var(--bg-raised, #fff);
      pointer-events: none;
    }
    /*
     * THE CORNER MARK, CARRIED IN FROM THE CARD (Wave 21 point 5).
     *
     * A quarter turn permutes the corner assignment WITHOUT MOVING ANY OF THEM,
     * so the outline is identical before and after and four identical handles
     * say nothing about which way the page comes out. The card already solved
     * this with a filled dot on the corner that becomes the minted page's
     * top-left; this is the same device in the same colour, so the mark means
     * one thing in both places rather than two things that resemble each other.
     *
     * It matters most on exactly this shoot: every spread of the 1876 volume
     * lies sideways and wants THREE quarter turns, and without the mark the
     * only way to see that a turn happened is to look away at the preview.
     */
    .handle.first { background: var(--accent, #4c9aff); }

    /*
     * HELD IS A RING AND A LIFT, not a fill, now that a fill means something
     * else. Filling on grab would have made every held corner look like the
     * first one -- two things sharing a name, in a colour.
     */
    .handle.held {
      transform: scale(1.15);
      box-shadow: 0 0 0 3px var(--accent-faint);
    }

    /* The gutter's ends take the split line's own colour, so the line and the
       thing that moves it read as one object rather than two controls. */
    .gutter {
      position: absolute;
      width: 16px; height: 16px;
      margin: -8px 0 0 -8px;
      border: 2px solid var(--warn, #d08770);
      border-radius: 50%;
      background: var(--bg-raised, #fff);
      pointer-events: none;
    }
    .gutter.held { background: var(--warn, #d08770); }

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
  /**
   * The gutter, as the two endpoints the person dragged, or null for unsplit.
   *
   * A SEGMENT AND NOT A FRACTION SINCE WAVE 21. One number can only cut
   * parallel to the sides, and a book under a phone is never quite square to
   * it, so a straight cut through a leaning gutter takes a sliver of the facing
   * page onto both leaves.
   */
  readonly split = input<CaptureSplit | null>(null);

  /**
   * A CUT THAT HAS NOT HAPPENED YET -- the line the Split tool shows you before
   * you have split anything.
   *
   * Owen: "i clicked split spreads and it looked no different from place crop.
   * it was supposed to be a single line with two knobs that i drag to the right
   * position." It was not: the gutter draws from `split`, a photograph nobody
   * has split has none, and so the tool changed which buttons were on screen
   * and left the picture identical to Crop.
   *
   * So the line comes first. It is a PROPOSAL and not a cut -- Owen's ruling --
   * which is why it is a second input rather than a split written into the
   * recipe the moment somebody clicks a tool to have a look: choosing a tool
   * must not change the page count of the book, and there is no un-cut.
   */
  readonly proposal = input<CaptureSplit | null>(null);

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<CaptureSplit>();
  /** The proposed line moved. Nothing is cut and nothing is saved. */
  readonly proposalChange = output<CaptureSplit>();

  /**
   * The listening surface. Capture is set here rather than on the picture
   * because a pointer is captured by the element that HEARD the press, and a
   * press on a handle overhanging the edge is heard by this one.
   */
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private readonly picture = viewChild.required<ElementRef<HTMLElement>>('picture');
  /** The element that carries the turn -- see turned() and fractionOf(). */
  private readonly spun = viewChild.required<ElementRef<HTMLElement>>('spun');
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
  /**
   * Which end of the gutter is under the pointer, 'line' while the whole cut is
   * being slid, or null.
   *
   * A signal rather than a field because the two handles draw their held state
   * from it, and a plain boolean could not say WHICH end is being moved.
   */
  protected readonly holdingSplit = signal<'a' | 'b' | 'line' | null>(null);
  /** Where the pointer was, and where the ends were, when a line drag started. */
  private slidFrom: { at: FractionPoint; split: CaptureSplit } | null = null;

  /**
   * HOW TO LAY THIS PHOTOGRAPH OUT SO IT SITS THE WAY THE PAGE WILL PRINT.
   *
   * The same arithmetic the card does, through the same turnsOf, so the table
   * and the editor cannot disagree about which way round a page is. The SLOT
   * takes the printed aspect and the element inside is laid out at the
   * photograph's own, so that rotating it lands exactly on the slot.
   *
   * -- WHY THE SLOT'S SIZE IS CHOSEN HERE AND NOT LEFT TO CSS ----------------
   *
   * The card writes width:100% and stops, because the grid hands it a definite
   * width. This has to FIT inside a frame that constrains both axes, and
   * aspect-ratio with max-width and max-height DOES NOT PRESERVE THE RATIO WHEN
   * IT CLAMPS. Measured in Chromium: a turned page in a narrow frame came out
   * 496x372 inside a slot of 496x396, and the handle layer stopped matching the
   * picture. A crop outline sitting beside the photograph instead of on it is a
   * worse defect than a picture facing the wrong way, which is why the first
   * attempt at this was reverted rather than shipped.
   *
   * So the BINDING AXIS is made definite and the ratio derives the other. Which
   * axis binds is a fact about the FRAME, not about the photograph, which is
   * why the frame is measured. Five CSS-only spellings were tried and none held
   * the ratio across turned-and-upright times narrow-and-wide; this rule holds
   * all four.
   */
  protected readonly turned = computed(() => {
    const { width, height } = this.dimensions();
    const turns = turnsOf(this.quads()[0] ?? WHOLE_FRAME);
    const sideways = turns % 2 === 1;
    const box = sideways ? height / width : width / height;
    const room = this.frameBox();
    // Until the frame has been measured the height binds, which is what this
    // editor did before it turned anything -- so the first paint is never worse
    // than it used to be.
    const heightBinds = room.height === 0 || room.width / room.height > box;
    return {
      turns,
      box: String(box),
      slotWidth: heightBinds ? 'auto' : '100%',
      slotHeight: heightBinds ? '100%' : 'auto',
      spunWidth: sideways ? (100 / box) + '%' : '100%',
      spunHeight: sideways ? (100 * box) + '%' : '100%',
      spin: 'translate(-50%, -50%) rotate(' + (turns * 90) + 'deg)',
    };
  });

  /**
   * The frame's CONTENT box, watched.
   *
   * contentRect and not getBoundingClientRect, because the frame carries 12px
   * of padding to keep the handles off the clip, and the question here is how
   * much room the picture actually has.
   */
  private readonly frameBox = signal<{ width: number; height: number }>({ width: 0, height: 0 });

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
   * THE ONE PAGE THE GUTTER CUTS, whether or not it has been cut yet.
   *
   * After a split there is no single quad that is the sheet -- it is the two
   * halves seen as the page they came from -- and asking one HALF where the
   * gutter goes is the mistake that put the handle at a quarter of the page and
   * halved it again on every drag. `joinedQuad` reads the segment for its
   * DIRECTION only, which is what lets it reassemble a stacked pair correctly:
   * the vertical-only reconstruction returns a convex quad of exactly half the
   * sheet's area at every cut position, so nothing downstream could have
   * noticed.
   */
  protected readonly sheet = computed(() =>
    joinedQuad(this.quads() as readonly CaptureQuad[], this.split()));

  /**
   * The gutter resolved against that sheet: both ends put back on the edges
   * they ride, and which pair of edges those are.
   *
   * RE-SEATED RATHER THAN TRUSTED. The stored segment is the gesture's own
   * state and the quads are authoritative, so dragging a corner after a split
   * leaves the endpoints floating off the crop they were drawn on. Null is a
   * segment that does not resolve to opposite edges at all, which `seatSplit`
   * cannot produce -- so it means a hand-edited file rather than anything a
   * person did here.
   */
  /**
   * THE LINE ON SCREEN, whether it has been cut yet or not.
   *
   * A real split wins over a proposal, always: once a photograph has been cut
   * the gutter is a fact about it, and a stale proposal underneath must not be
   * able to draw over the thing it became.
   */
  protected readonly cut = computed(() => {
    const split = this.split() ?? this.proposal();
    return split === null ? null : cutOf(this.sheet(), split);
  });

  /** Whether what is drawn is a proposal rather than a cut this book has made. */
  protected readonly proposing = computed(() => this.split() === null && this.proposal() !== null);

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
     * WATCH THE FRAME, because which axis binds the picture is a fact about the
     * room and not about the photograph -- see turned(). A ResizeObserver and
     * not a window resize listener: the frame changes when the rail opens, when
     * the previews change height and when the window resizes, and only one of
     * those is a window event.
     */
    const watcher = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) this.frameBox.set({ width: box.width, height: box.height });
    });
    inject(DestroyRef).onDestroy(() => watcher.disconnect());
    // afterNextRender and not an effect: the frame is one element for the life
    // of this component, so there is nothing to re-observe -- and a required
    // view query read from an effect is a race with the view that creates it.
    afterNextRender(() => watcher.observe(this.frame().nativeElement));

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

  /**
   * The photograph finished decoding — draw the previews that are ITS previews.
   *
   * Called from (load), which fires on the first picture and on every change of
   * `source()` after it. Cheap to call spuriously: `draw` is a handful of
   * canvas blits and only runs at all once the element holds the picture the
   * previews are supposed to be of.
   */
  protected repaint(): void {
    this.draw(this.previews(), this.quads(), this.dimensions());
  }

  protected outlineOf(quad: FractionQuad): string {
    return quad.map(([x, y]) => `${x},${y}`).join(' ');
  }

  protected grab(event: PointerEvent): void {
    const at = this.fractionOf(event);
    // THE SPUN ELEMENT, NOT THE SLOT: the radius is in the photograph's own
    // fraction space, and a rotation preserves lengths -- so the photograph's
    // on-screen x extent is the width it was LAID OUT at, whichever way round
    // it now sits. Measuring the slot would make the hit radius wrong by the
    // aspect ratio on every turned photograph.
    const width = this.spun().nativeElement.offsetWidth;
    // The hit radius is in PIXELS on screen and converted, so the handle is the
    // same size to the hand whatever the picture has been scaled to.
    const radius = width === 0 ? 0 : 14 / width;

    const quads = this.quads();
    for (let index = 0; index < quads.length; index += 1) {
      const corner = cornerNear(toPixels(quads[index]!, UNIT), [at[0], at[1]], radius);
      if (corner !== null) {
        this.held.set({ quad: index, corner });
        this.frame().nativeElement.setPointerCapture(event.pointerId);
        return;
      }
    }

    /*
     * THE ENDS FIRST, THEN THE LINE BETWEEN THEM.
     *
     * An end wins over the line it is on, because an end is ALWAYS on the line
     * and the reverse is not true -- testing the line first would make the
     * handles ungrabbable, which is the same class of defect as the corner
     * handles that hung over the listening element.
     */
    /*
     * THE LINE THAT IS DRAWN IS THE LINE THAT CAN BE GRABBED, and asking
     * `cut()` rather than `split()` is the whole of that sentence.
     *
     * Owen: *"i couldnt grab the knobs to move the split - it didnt do
     * anything when i click/dragged the knob"*. The knobs were there. The
     * template draws them from `cut()`, which is `split() ?? proposal()`, so a
     * SEEDED PROPOSAL puts two handles and a gutter on the picture -- and this
     * method used to refuse the press unless `split()` was non-null, which on a
     * proposal it is not, by definition. So the gesture died at its first line
     * and the person got a picture of a control.
     *
     * `drag` below already knew better: it resolves `split() ?? proposal()` and
     * picks its destination from which one answered. THE TWO HALVES OF ONE
     * GESTURE DISAGREED -- the half that MOVES the cut understood proposals and
     * the half that STARTS the move did not -- and a gesture is only as wired as
     * its first half.
     *
     * The tell was in the code and not in the behaviour: the `split` this
     * replaces was read once, used for nothing, and existed only to refuse. A
     * local whose sole effect is a guard is a guard nobody meant to write.
     */
    const line = this.cut();
    if (line === null) return;

    for (const which of ['a', 'b'] as const) {
      const point = line[which].point;
      if (Math.hypot(at[0] - point[0], at[1] - point[1]) <= radius) {
        this.holdingSplit.set(which);
        this.frame().nativeElement.setPointerCapture(event.pointerId);
        return;
      }
    }

    /*
     * SLIDING THE WHOLE CUT, which is the common gesture and would otherwise
     * have been lost: a straight gutter on a square-on spread wants to move
     * sideways, and making somebody drag two handles to do it once per
     * photograph is fifty-four extra gestures on this shoot.
     *
     * Hit against THE LINE THAT IS DRAWN. The old test measured the pointer's
     * distance from a vertical line at a fraction of the frame, which was true
     * only while the quad was upright -- and every photograph of the 1876
     * volume is turned a quarter before anything else happens to it.
     */
    if (distanceToEdge(at, line.a.point, line.b.point) <= radius) {
      this.holdingSplit.set('line');
      /*
       * THE ORIGIN IS THE SEATED SEGMENT, NOT THE STORED ONE.
       *
       * The stored endpoints are gesture state and go stale against a crop
       * dragged after the split -- that is the whole reason the line is drawn
       * from cutOf rather than from the file. Sliding FROM the stale points
       * would measure the offset from somewhere the gutter is not, so the cut
       * would jump the instant the pointer moved and then track correctly from
       * the wrong place. The seated points are where the line actually is,
       * which is where a slide has to start.
       */
      this.slidFrom = { at, split: { a: line.a.point, b: line.b.point } };
      this.frame().nativeElement.setPointerCapture(event.pointerId);
    }
  }

  protected drag(event: PointerEvent): void {
    const holding = this.held();
    const gutter = this.holdingSplit();
    if (holding === null && gutter === null) return;
    const at = this.fractionOf(event);

    if (gutter !== null) {
      const split = this.split() ?? this.proposal();
      if (split === null) return;
      const sheet = this.sheet();
      // A proposal is moved, not saved: the same geometry, a different
      // destination, decided once here rather than at each emit below.
      const moved = this.split() === null ? this.proposalChange : this.splitChange;

      if (gutter === 'line') {
        /*
         * THE WHOLE CUT MOVES AS ONE ACT, THROUGH ONE FUNCTION.
         *
         * This used to carry each end by the offset and hand each to
         * `seatSplit` in turn. Both calls were individually correct and the
         * composition was not: each clamps the end it moves against THE
         * PARTNER AS IT STANDS, and in the second call the partner is the end
         * the first already moved -- so each believed a partner that was no
         * longer where its floor had been computed for, and the pair walked
         * past a limit neither call thought it was crossing.
         *
         * Measured through the shipped chord: the smaller half reached 0.28%
         * of the sheet on a skewed quad, a seventh of the floor, and past a
         * point both ends landed on corners of one edge and halvesOf refused
         * the segment outright. So the gesture could produce a state the
         * validator rejects -- the draws-fine-refuses-to-save class, which is
         * exactly what putting the seating in shared/ was supposed to make
         * impossible.
         *
         * `slideSplit` fixes the edges before anything moves and applies the
         * floor and the edge-riding rule as ONE predicate to the pair, so the
         * slide stops where the first of them binds. The lesson is the one
         * this feature keeps paying for: an invariant enforced once is a rule,
         * and an invariant enforced twice is two rules that agree until they
         * do not.
         */
        const from = this.slidFrom;
        if (from === null) return;
        moved.emit(
          slideSplit(sheet, from.split, [at[0] - from.at[0], at[1] - from.at[1]]),
        );
        return;
      }

      moved.emit(seatSplit(sheet, split, gutter, [at[0], at[1]]));
      return;
    }

    // Clamped HERE and nowhere else, because this is the only place a corner is
    // invented: `rotate` permutes the tuple and `halvesOf` cuts between corners
    // that are already inside, so neither can carry a quad back out of range.
    const inside: FractionPoint = [clamp(at[0]), clamp(at[1])];
    const quads = this.quads();
    const moved = quads.map((quad, index) =>
      index === holding!.quad ? withCorner(quad, holding!.corner, inside) : quad,
    );
    this.quadsChange.emit(moved);
  }

  protected release(event: PointerEvent): void {
    if (this.held() === null && this.holdingSplit() === null) return;
    this.held.set(null);
    this.holdingSplit.set(null);
    this.slidFrom = null;
    // Asked of the FRAME, which is what took the capture. Asking the picture
    // would be asking an element that never holds one, so the release below
    // would never run and the next press would arrive already captured.
    if (this.frame().nativeElement.hasPointerCapture(event.pointerId)) {
      this.frame().nativeElement.releasePointerCapture(event.pointerId);
    }
  }

  /** A pointer event's position as a fraction of the picture. */
  private fractionOf(event: PointerEvent): FractionPoint {
    const box = this.picture().nativeElement.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return [0, 0];
    const u = (event.clientX - box.left) / box.width;
    const v = (event.clientY - box.top) / box.height;
    /*
     * TURNED BACK, because the slot is the axis-aligned box on screen and the
     * quads live in the photograph's own space -- the same space only at turn
     * 0. A quarter turn clockwise puts the photograph's top-left at the slot's
     * top-right, so the inverse reads the slot's y for the photograph's x.
     *
     * Without it every handle would be where it LOOKS and nowhere it is
     * grabbed, on turned photographs only: invisible until somebody turns a
     * spread, and unusable from then on.
     */
    switch (this.turned().turns) {
      case 1: return [v, 1 - u];
      case 2: return [1 - u, 1 - v];
      case 3: return [1 - v, u];
      default: return [u, v];
    }
  }

  /**
   * Draw the previews.
   *
   * The image element is reused as the texture source rather than decoding the
   * working copy a second time: it is already in the page, already decoded, and
   * `Rectifier` takes an `HTMLImageElement` for exactly this reason.
   *
   * ── THE SENTENCE THAT USED TO BE HERE WAS FALSE, AND IT COST A DEFECT ─────
   *
   * It read: "A picture that has not finished loading has no dimensions yet and
   * is skipped — the effect will run again when the quads next move, and the
   * load itself is what puts the photograph on screen." Owen: *"turning the
   * book worked on the first one but didnt work on the next one. the thumbnail
   * turned but the main image didnt"*.
   *
   * Both clauses were wrong, and measuring the element rather than reasoning
   * about it is what showed it. Across a change of `src`, one <img> reports
   * THREE states, not two:
   *
   *   synchronously after src is set   naturalWidth 480   complete FALSE
   *                                    — still the PREVIOUS photograph's number
   *   by the next task                 naturalWidth 0     complete false
   *   after the load event             naturalWidth 480   complete true
   *
   * The effect draws in a MICROTASK, which lands in the first row. So this
   * method was never skipped at all: it rectified the photograph that was still
   * in the element into the previews of the page that had just replaced it, and
   * the person saw the picture they had just stepped away from.
   *
   * `naturalWidth` is not a question about the src that was just assigned. It
   * is a question about the picture currently in the element, and for one whole
   * microtask checkpoint those are two different pictures.
   *
   * ── SO THE REDRAW HAS TWO HALVES AND BOTH ARE REQUIRED ─────────────────
   *
   * `complete` is the half that REFUSES the stale draw — it goes false the
   * instant the src is assigned, which is the only signal in the first row that
   * tells the truth. `(load)` on the element is the half that SUPPLIES the
   * missing one, because a load is an EVENT and an effect cannot depend on it;
   * modelling it as state is the mistake the per-visit turn counter already
   * made once in this cluster.
   */
  private draw(
    previews: readonly { index: number; width: number; height: number }[],
    quads: readonly FractionQuad[],
    dimensions: Dimensions,
  ): void {
    const image = this.photo().nativeElement;
    // BOTH, and the order is not the interesting part -- see the docblock. The
    // complete check is the one that refuses a STALE picture; the naturalWidth
    // check is the one that refuses a BROKEN one.
    if (!image.complete || image.naturalWidth === 0) return;

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

/*
 * THE OFF-THE-ENDS CLAMP WENT WITH THE FRACTION, and the hazard it guarded is
 * now somebody else's to name.
 *
 * It kept a gutter 2% from either end, so a split could never make a page of no
 * width. `seatSplit` deliberately does not do that -- P1's words, and they are
 * right: an end reaching a corner is a legal cut and a bad one, and a floor on
 * it is a question about the gesture rather than about the geometry. Rewriting
 * it here would have meant a clamp on one end at a time, which cannot express
 * "leave a page on each side" for a cut that leans.
 *
 * So a sliver is currently draggable. Said out loud rather than left as a
 * silent regression: the page it makes is visibly wrong in the preview beside
 * the picture, which is the surface that would tell somebody, and the two
 * halves both still mint.
 */
