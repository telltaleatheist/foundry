import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

import { halvesOf, isWholeFrameTurned, joinedQuad, splitFromFraction } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { CapturePageEditorComponent } from './capture-page-editor.component';
import { type Dimensions, type FractionQuad } from './geometry';
import type { PrepareVerb } from '../capture-rail/capture-rail.component';
import type { ApplyToAll } from '../../core/capture.service';

/**
 * THE EDITOR AS A ROOM YOU STEP INTO, AND THE TWO STAGES OF THE WORK.
 *
 * ── Why a modal and not a pane ──────────────────────────────────────────────
 *
 * Wave 21 point 1, from Owen's own reading of PDFElement: the grid is where you
 * choose, and the editor is where you work. Until tonight the editor REPLACED
 * the grid inside the same tab, so leaving it meant a button called "All
 * photographs" and coming back meant finding your card again. A modal keeps the
 * table underneath, which is the difference between going somewhere and opening
 * something.
 *
 * ── THE STAGES ARE THE BUTTONS, AND THERE IS NO STAGE LABEL ─────────────────
 *
 * docs/CAPTURE.md Wave 21: stage 1 sets ONE crop for the whole shoot, and
 * pressing Apply IS the transition; stage 2 is per-page, and flipping edits the
 * page in front of you. This component never writes "Stage 1 of 2" anywhere,
 * because a number is a thing you have to learn and the footer already shows the
 * difference: one wide button that changes everything, or a row of buttons that
 * change one page and one that changes the rest.
 *
 * The stage is DERIVED and never stored (the plan-back at channel seq 128,
 * ruled at 129). See `stage` on the service side: a project where nobody has
 * touched anything is stage 1, and every other project is stage 2. That is what
 * stops the dangerous reading of the design -- closing the modal after an
 * evening of per-page work and reopening it onto the one button that stamps
 * over all of it.
 *
 * ── What it does NOT own ────────────────────────────────────────────────────
 *
 * The corners, the split line and the previews are still
 * `CapturePageEditorComponent`, unchanged and still pointable at any image. What
 * moved up here is the GESTURE ROW -- turn, split, and the applies -- because
 * those are acts on the whole shoot and the picture below is one photograph.
 * The editor went back to being the surface the corners are chosen on.
 */
@Component({
  selector: 'app-capture-editor-modal',
  imports: [CapturePageEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>

    <div class="card" role="dialog" aria-modal="true">
      <button class="shut" type="button" title="Back to the table (Escape)" (click)="close.emit()">✕</button>

      <div class="stage">
        <app-capture-page-editor
          [source]="source()"
          [dimensions]="dimensions()"
          [quads]="quads()"
          [split]="split()"
          [proposal]="proposal()"
          (quadsChange)="quadsChange.emit($event)"
          (splitChange)="splitChange.emit($event)"
          (proposalChange)="proposal.set($event)"
        />
      </div>

      <!--
        ONE COLUMN, IN THE ORDER THE WORK HAPPENS, and it replaces a perimeter.

        Owen: "the buttons are all on the other side of the app from each other."
        They were: walking in the header, the tools in the header, the gestures
        in the footer's left corner and the acts in its right. Four groups on
        three edges of a window whose middle is a photograph.

        Now: who you are looking at and how to move, then what you are doing,
        then what that tool does to THIS photograph, then what it does to the
        BOOK. Nothing is left on any edge.
      -->
      <aside class="cluster">
        <div class="who">
          @if (name(); as called) {
            <div class="name">{{ called }}</div>
          }
          <div class="pos">{{ label() }}</div>
          <div class="walk">
            <button
              type="button"
              [disabled]="!hasPrevious()"
              title="Previous photograph (left arrow)"
              (click)="step.emit(-1)"
            >← Back</button>
            <button
              type="button"
              [disabled]="!hasNext()"
              title="Next photograph (right arrow)"
              (click)="step.emit(1)"
            >Next →</button>
          </div>
        </div>

        <div class="toolrow">
          <div class="cap">What you are doing</div>
          <!--
            ONE VOCABULARY WITH THE RAIL, not a second one that has to be
            mapped: these are the keys of CapturePrepared. A tool called Crop
            and a verb called cropped with a translation between them would be
            two names for one thing.
          -->
          <div class="tools" role="tablist">
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="using() === 'turned'"
              [class.on]="using() === 'turned'"
              (click)="using.set('turned')"
            >Turn</button>
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="using() === 'cropped'"
              [class.on]="using() === 'cropped'"
              (click)="using.set('cropped')"
            >Crop</button>
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="using() === 'split'"
              [class.on]="using() === 'split'"
              (click)="using.set('split')"
            >Split</button>
          </div>
        </div>

        <!-- WHAT THIS TOOL DOES TO THE PHOTOGRAPH IN FRONT OF YOU. The corners
             and the gutter stay draggable in every tool -- direct manipulation
             is how this editor is used, and a tool that hid the handles would
             turn the photograph into a picture. -->
        <div class="does">
          @if (using() === 'turned') {
            <div class="turnpair">
              <button type="button" title="Turn this photograph anticlockwise" (click)="turn(-1)">⟲</button>
              <button type="button" title="Turn this photograph clockwise" (click)="turn(1)">⟳</button>
            </div>
            <p class="says">Turns this photograph only.</p>
          } @else if (using() === 'cropped') {
            <p class="says">Drag the four corners onto the page.</p>
            <!--
              REMOVING A CROP IS REMOVING THE MARK, so it is offered only when
              there is one. A control that is always there and does nothing four
              times out of five teaches people to stop reading it.
            -->
            @if (!wholeFrame()) {
              <button class="btn quiet" type="button" (click)="clearCrop.emit()">
                Use the whole photograph
              </button>
            }
          } @else {
            <p class="says">
              @if (quads().length === 1) {
                Drag either end of the line onto the gutter.
              } @else {
                Drag either end to move the cut.
              }
            </p>
            @if (quads().length > 1) {
              <button class="btn quiet" type="button" (click)="clearSplit.emit()">
                Put this back together as one page
              </button>
            }
          }
        </div>

        <div class="acts">
          <div class="cap">When this one looks right</div>

          <!--
            EACH TOOL OWNS ITS OWN ACT, and the act is always about the whole
            book. Turn's act turns, Crop's act crops, Split's act cuts.

            This is the design pass's structural change and it answers the
            second finding directly: two buttons a person could not tell apart
            are never on screen together any more, because only one of them
            belongs to the tool in hand.
          -->
          @if (using() === 'turned') {
            <button
              class="btn primary"
              type="button"
              [class.applied]="justApplied() === 'turn'"
              [disabled]="outOfTurn() === 0"
              [title]="outOfTurn() === 0
                ? 'Every other photograph already sits this way round'
                : 'Turn the rest of the book to match the one you are looking at'"
              (click)="applyToAll.emit({ kind: 'turn' })"
            >{{ turnAllSays() }}</button>
          } @else if (using() === 'split' && quads().length === 1) {
            <!--
              THE CUT OF THIS PAGE IS THE PRIMARY ACT UNTIL THIS PAGE IS CUT.

              Owen: *"there doesnt seem to be an apply button for page
              splitting. i set it, i hit ok, and nothing happened"*. He was
              right and the button he pressed was this one. Dragging the line
              makes a PROPOSAL; the cut of this photograph was a a quiet
              secondary up in the tool's description, while the button in the
              act position -- the big one, under "When this one looks right" --
              was the stamp, which copies THIS page's quads onto the book. With
              nothing cut here yet, that stamped one uncut quad onto twenty-seven
              photographs: a real act, correctly performed, that changes nothing
              anybody can see.

              Its own label was the evidence and nobody read it: "Cut all 27
              here — 27 pages". Twenty-seven photographs cut into twenty-seven
              pages is not a cut. Cut, it says 54.

              So the act position holds the act the person is reaching for. The
              global cut cannot be pressed before there is a cut to copy, which
              is not a disabled button but an ABSENT one -- it is not a thing
              you may do yet, rather than a thing you may not.
            -->
            <button
              class="btn primary"
              type="button"
              title="Cut this photograph into two pages along the line"
              (click)="splitInTwo()"
            >Cut this one into two pages</button>
          } @else {
            <button
              class="btn primary"
              type="button"
              [class.applied]="justApplied() === 'stamp'"
              [title]="using() === 'split'
                ? 'Cut every photograph of this shape where this one is cut'
                : 'Give every photograph of this shape the crop you have placed here'"
              (click)="stampEverything()"
            >{{ stampSays() }}</button>
          }

          @if (showing() === 1) {
            <p class="says">
              They were all shot the same way, so setting one sets them all. You can fix
              the odd ones afterwards.
            </p>
          } @else {
            <!--
              IT SAYS WHAT IS TRUE, AND ONLY WHEN IT IS TRUE.

              Owen: *"the 'leave this one alone' button is confusing. i dont
              know what purpose it serves"*. He was reading it correctly. It
              was a toggle that ASKED HIM TO DECLARE something the app had
              already watched him do -- setQuads writes byHand on the drag
              itself, and has since the mark stopped waiting for a button. So
              on the common visit the control was offering to set a mark that
              was already set, under a label describing the state it was
              leaving.

              What is actually left is the RELEASE, and a release is only
              meaningful once there is something to release. So the mark is now
              a sentence rather than a control, and the only button is the one
              that undoes it -- named for what it does when pressed rather than
              for the state it produces. A page nobody has touched shows
              neither, because there is nothing to say about it.
            -->
            @if (handSetHere()) {
              <p class="says">You set this one by hand, so apply-to-all leaves it alone.</p>
              <button
                class="btn quiet"
                type="button"
                title="Let apply-to-all change this photograph again"
                (click)="keep.emit()"
              >Let apply-to-all change it again</button>
            }

          }
        </div>
      </aside>
    </div>
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT -- confirm-dialog's rule,
     * for its reason: a full-window fixed host is a sheet of glass over the
     * application, and an invisible sheet still swallows every click. This one
     * is only mounted while it is open, so it is less dangerous than that
     * component's case; it follows the same rule anyway, because a component
     * that is safe only because of where it is mounted is safe by accident.
     */
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    /*
     * NEARLY THE WHOLE WINDOW, unlike every other dialog in this app, and that
     * is the point rather than an oversight: the others ask a question and this
     * one is a workbench. The photograph wants every pixel it can have, because
     * a corner placed on a small picture is a corner placed badly.
     *
     * The margin is what keeps it a modal at all -- the table stays visible
     * around the edge, so this reads as something opened OVER the work rather
     * than as a screen that replaced it.
     */
    .card {
      position: relative;
      pointer-events: auto;
      width: calc(100vw - 56px);
      height: calc(100vh - 56px);
      margin: 28px auto;
      display: flex; flex-direction: row;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .which { font-size: 12px; color: var(--text-secondary); }
    .grow { flex: 1; }

/* THE CARD IS A ROW NOW: the photograph, then the column of controls. It was
       a column of three bands -- header, picture, footer -- which is what put the
       controls on three different edges. */
    .stage { flex: 1; min-width: 0; display: flex; }
    .stage app-capture-page-editor { flex: 1; min-width: 0; }

    .cluster {
      width: 268px; flex: none;
      border-left: 1px solid var(--border-subtle);
      background: var(--bg-base);
      display: flex; flex-direction: column;
      overflow: auto;
    }

    .who { padding: 14px 16px 12px; border-bottom: 1px solid var(--border-subtle); }
    .who .name { font-family: var(--font-mono); font-size: 12px; }
    .who .pos { color: var(--text-tertiary); font-size: 11.5px; margin-top: 2px; }
    .walk { display: flex; gap: 6px; margin-top: 10px; }

    .toolrow { padding: 12px 16px 0; }
    .cap {
      color: var(--text-tertiary); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 6px;
    }

    .does { padding: 14px 16px 0; display: flex; flex-direction: column; gap: 8px; }
    .turnpair { display: flex; gap: 8px; }
    .turnpair button {
      flex: 1; padding: 9px 0;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      color: var(--text-primary);
      font-size: 16px; line-height: 1;
      cursor: pointer;
    }
    .turnpair button:hover { background: var(--bg-hover); }

    /* THE ACTS SIT AT THE FOOT OF THE COLUMN, which is where the rail puts Mint
       for the same reason: the thing you finish with is the thing at the bottom. */
    .acts {
      margin-top: auto;
      padding: 14px 16px 16px;
      border-top: 1px solid var(--border-subtle);
      display: flex; flex-direction: column; gap: 8px;
    }

    .btn {
      width: 100%;
      padding: 9px 12px;
      border-radius: var(--radius-md, 6px);
      font: inherit; font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .btn.quiet {
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default);
    }
    .btn.quiet:hover { background: var(--bg-hover); }
    .btn.primary {
      background: var(--accent); color: var(--text-inverse);
      border: 1px solid var(--accent); font-weight: 600;
    }
    .btn.primary:disabled { opacity: 0.45; cursor: default; }
    .btn.kept {
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default);
    }
    .btn.kept.on {
      background: var(--ok-soft); color: var(--ok); border-color: var(--ok);
    }
    /* Said quietly and next to the button it describes: it is a caption on one
       control, not an announcement about the room. */
    .says { font-size: 11px; color: var(--text-tertiary); }

    /* A segmented control, which is what three exclusive tools are. It sits
       above what it changes, because the column reads top to bottom in the order
       the work happens. */
    .tools {
      display: flex; gap: 4px;
      padding: 3px;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle, #2a2824);
      border-radius: var(--radius-md, 6px);
    }
    .tools button {
      flex: 1;
      border: none; background: none;
      color: var(--text-secondary);
      font: inherit; font-size: 12px;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .tools button:hover { color: var(--text-primary); }
    .tools button.on { background: var(--accent-soft); color: var(--accent); }

    /* Beside the button it changes, in the tick-box voice confirm-dialog
       already uses for a statement about an act rather than an act of its own. */

    .walk button, .shut {
      padding: 5px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      font: inherit; font-size: 12px;
      cursor: pointer;
    }
    .walk button { flex: 1; }
    .walk button:hover:not(:disabled), .shut:hover {
      background: var(--bg-hover); color: var(--text-primary);
    }
    .walk button:disabled { opacity: 0.4; cursor: default; }

    /* The one control still floating over the picture, because it belongs to
       the window rather than to the work. */
    .shut {
      position: absolute; top: 10px; right: 14px; z-index: 2;
      border-color: transparent; padding: 2px 8px;
    }

    .act {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border: none;
      border-radius: var(--radius-md);
      background: var(--accent-strong); color: var(--text-inverse);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .act:hover { background: var(--accent); }
    .act:active { transform: scale(0.98); }

    /*
     * THE ACKNOWLEDGEMENT, carried over from the light table's gesture row
     * (Wave 21 point 5) and deliberately not animated. The house has no
     * precedent for a transient confirmed state, and an effect invented for one
     * button is the kind of motion that reads as decoration rather than as
     * information.
     */
    .applied {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
      color: var(--text-inverse);
    }
  `],
})
export class CaptureEditorModalComponent {
  /** "Photograph 5 of 27 · pages 9-10 of 54" — composed by the light table. */
  readonly label = input.required<string>();
  readonly source = input.required<string>();
  readonly dimensions = input.required<Dimensions>();
  readonly quads = input.required<readonly FractionQuad[]>();
  /** The gutter as two endpoints, or null while this photograph is one page. */
  readonly split = input<CaptureSplit | null>(null);

  /**
   * WHICH STAGE THIS PROJECT OPENS IN — derived by the service from the recipe,
   * never stored, never decided here.
   *
   * A stage this component owned outright would reset every time the modal was
   * closed, which is the failure the derivation exists to prevent: an evening of
   * per-page work, reopened onto the button that stamps over all of it.
   */
  readonly stage = input.required<1 | 2>();

  /**
   * WHICH TOOL THIS OPENED ON — the rail's verb, arriving as an input.
   *
   * The rail's three rows each open this same room, and the row is the only
   * thing that knows which one was pressed. It is an input rather than a
   * parameter because the modal outlives the press: walking to the next
   * photograph keeps the tool, which is what somebody splitting twenty-five
   * spreads wants and what re-deriving it per photograph would take away.
   */
  readonly tool = input<PrepareVerb>('cropped');

  /**
   * HOW MANY OTHER PHOTOGRAPHS WOULD ACTUALLY TURN -- the service's count, not
   * this component's.
   *
   * It is on the button because the number is the difference between this
   * control and the crop stamp beside it. "Turn all by the same amount" and
   * "Apply to all" were two labels a person could not tell apart; "Turn the
   * other 24 to match this one" and "Use this crop on all 25 photographs"
   * differ by their verb AND by their count, and the count is the half that was
   * on neither button.
   */
  readonly outOfTurn = input<number>(0);

  /**
   * What the person called this photograph, or NULL when nothing does.
   *
   * `CapturePhoto.name` is optional by design: a project intaken before the
   * field existed has photographs with no name and always will, and the type's
   * own docblock rules that "the position in the grid is the honest stand-in,
   * never the sha".
   *
   * Here that stand-in is ALREADY ON SCREEN -- the line below this one says
   * "Photograph 12 of 25". So a nameless photograph drops the name line rather
   * than repeating the position twice, which is what filling it with the
   * fallback would do.
   */
  readonly name = input<string | null>(null);

  /**
   * How many photographs the crop and split acts would reach, counting this
   * one. Same rule as the turn count beside it: the number on a button is what
   * the button does, not what the book contains, so a photograph of another
   * shape is left out because the stamp refuses and names it.
   */
  readonly reach = input<number>(0);

  /** What the crop and split acts say -- the same act, named for the tool. */
  protected readonly stampSays = computed<string>(() => {
    if (this.justApplied() === 'stamp') return 'Applied ✓';
    const reach = this.reach();
    if (this.using() === 'split') {
      return `Cut all ${reach} here — ${reach * this.quads().length} pages`;
    }
    return reach === 1
      ? 'Use this crop on this photograph'
      : `Use this crop on all ${reach} photographs`;
  });

  /** What the bulk-turn button says, which is always what it would do. */
  protected readonly turnAllSays = computed<string>(() => {
    if (this.justApplied() === 'turn') return 'Turned ✓';
    const others = this.outOfTurn();
    if (others === 0) return 'The others already match';
    return others === 1
      ? 'Turn the other one to match this'
      : `Turn the other ${others} to match this one`;
  });

  /**
   * The tool actually in front of you, which starts as the one the rail asked
   * for and then belongs to the person.
   *
   * AN EFFECT AND NOT A COMPUTED, for the reason the stage flag next door
   * carries: a computed cannot be written to, and this must be, or pressing
   * Crop inside the editor would be undone on the next change detection by the
   * input that opened it. The effect re-seats it when the RAIL asks again --
   * opening "Split spreads" after working in Crop lands on Split.
   */
  protected readonly using = signal<PrepareVerb>('cropped');

  /**
   * THE CUT THE SPLIT TOOL IS OFFERING, before anybody has taken it.
   *
   * Held here rather than in the recipe because Owen ruled the tool PROPOSES:
   * choosing Split must not change the page count of the book, and there is no
   * un-cut to undo it with. It lives in the modal rather than the page editor
   * because the modal owns the tool that summons it and the button that takes
   * it -- the editor draws it and moves it, which is all the editor does with
   * anything.
   */
  protected readonly proposal = signal<CaptureSplit | null>(null);

  readonly hasPrevious = input.required<boolean>();
  readonly hasNext = input.required<boolean>();
  /** How many photographs in this project somebody has set by hand. */
  readonly handSet = input<number>(0);
  /** Whether THIS photograph is one of them. */
  readonly handSetHere = input<boolean>(false);
  /** Which act just landed, for the button that was pressed. Owned by the parent. */
  readonly justApplied = input<ApplyToAll['kind'] | null>(null);

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<CaptureSplit>();
  readonly applyToAll = output<ApplyToAll>();
  /** A quarter turn of this photograph, for the service to perform. */
  readonly turnBy = output<number>();
  /** Take the crop off this photograph — the whole frame, which is no crop. */
  readonly clearCrop = output<void>();
  /** Put a cut spread back together as one page. */
  readonly clearSplit = output<void>();

  /**
   * Whether this photograph has NO crop on it — the whole frame, however many
   * times it has been turned.
   *
   * Through the shared body rather than a comparison written here: "is there a
   * crop" is a question the service already answers for the rail's count, and
   * two spellings of it would eventually disagree about a turned photograph.
   */
  protected readonly wholeFrame = computed(() =>
    isWholeFrameTurned(joinedQuad(this.quads() as readonly CaptureQuad[], this.split())));
  /** Stage 2's per-page Apply — this page is set by hand and stays that way. */
  readonly keep = output<void>();
  readonly step = output<number>();
  readonly close = output<void>();

  /*
   * A PER-VISIT TURN COUNTER USED TO LIVE HERE and is gone with the button that
   * read it. "Turn all BY the same amount" needed an amount, so the amount was
   * remembered from the moment the modal opened -- and that made the control
   * dead on arrival at every photograph, because the count reset whenever the
   * picture changed. Stepping to the next page and back forgot turns that the
   * page itself had kept.
   *
   * The replacement asks the BOOK instead: how many photographs sit at a
   * different turn from this one (CaptureService.outOfTurnWith). A question
   * about state answers the same way ten seconds later; a question about a
   * visit does not.
   */

  /*
   * A "take the hand-set ones too" CHECKBOX STOOD HERE and is gone. Owen: "that
   * should be assumed." It asked, on every stamp, about a situation that
   * usually does not exist -- which is how a control teaches people to stop
   * reading it -- and it asked BEFORE the act rather than at the moment of
   * conflict. The question moved to a confirmation that appears only when there
   * is something of theirs to overwrite, and names it. See
   * CaptureViewComponent.applyToAll.
   */

  /**
   * WHETHER APPLY HAS BEEN PRESSED SINCE THIS MODAL OPENED.
   *
   * ── The derivation cannot see a press that changed nothing ─────────────────
   *
   * docs/CAPTURE.md point 2: Apply stamps every same-shaped page "even if
   * nothing was changed first; pressing Apply IS what advances the stage". On a
   * virgin project that press copies whole-frame quads onto whole-frame quads
   * and clears a byHand nobody had set -- so the recipe afterwards is byte for
   * byte the recipe before, the derivation still reads "nobody has set
   * anything", and the person stays in stage 1 having pressed the one button
   * that was supposed to take them out of it.
   *
   * Measured before it was fixed: three untouched photographs, stamp from the
   * first, stage 1 before and stage 1 after.
   *
   * ── Which is why the two are not the same question ─────────────────────────
   *
   * The input answers WHERE THIS PROJECT OPENS, from what is on disk. This
   * answers WHAT HAS HAPPENED SINCE, and it is deliberately as short-lived as
   * the modal: closing without having changed anything and reopening in stage 1
   * is correct, because nothing has been set and stage 1 is where nothing-set
   * belongs. The dangerous case -- reopening after real work -- is answered by
   * the derivation, which by then has something to see.
   */
  private readonly advanced = signal(false);

  /** The stage actually on screen: where the project opened, or past it. */
  protected readonly showing = computed<1 | 2>(() => (this.advanced() ? 2 : this.stage()));

  /**
   * Stage 1's Apply. It advances whatever the stamp did or did not touch --
   * point 2 is unconditional, and a button that sometimes moved the person on
   * would be a button they had to press twice to find out about.
   */
  /**
   * The crop and split act, and the thing that moves stage 1 on.
   *
   * IT ADVANCES WHATEVER THE STAMP DID OR DID NOT TOUCH, which is Wave 21 point
   * 2 and still true: a button that sometimes moved the person on would be one
   * they had to press twice to find out about. On a virgin project the stamp is
   * a no-op, the recipe comes back byte-identical, and the derived stage
   * correctly reads "nothing set" -- so without this flag the one press that
   * reaches stage 2 would leave you in stage 1 with no other way out.
   *
   * IT CARRIES NO OVERRIDE FLAG ANY MORE. Whether the hand-set pages come too
   * is asked at the moment of conflict, by the surface that owns dialogs, and
   * the modal's job is to say WHICH ACT rather than to answer a question about
   * it in advance.
   */
  protected stampEverything(): void {
    this.advanced.set(true);
    this.applyToAll.emit({ kind: 'stamp' });
  }

  constructor() {
    /*
     * THE RAIL ASKING AGAIN RE-SEATS THE TOOL, and pressing a tool in here does
     * not. Both halves matter: opening "Split spreads" has to land on Split even
     * if the last thing somebody did in this modal was crop, and switching to
     * Crop inside the modal has to survive walking to the next photograph.
     *
     * Reading only `tool` is what keeps those apart -- the effect re-runs when
     * the RAIL's answer changes, not when `using` does.
     */
    effect(() => {
      this.using.set(this.tool());
    });

    /*
     * THE LINE IS THERE BEFORE THE FIRST GESTURE, which is the whole of finding
     * 5. Down the middle, upright, with a knob at each end, the moment the
     * Split tool opens on a photograph nobody has cut.
     *
     * `splitFromFraction` is the same body main's migration reads an old {x}
     * with, so "the line down the middle" has one answer in this app rather
     * than one here and one there.
     *
     * IT IS PUT AWAY AGAIN whenever it cannot mean anything -- another tool,
     * another photograph, or a photograph that has actually been cut. A stale
     * proposal surviving a step to the next page would offer a cut somebody
     * placed on a different picture.
     */
    effect(() => {
      const quads = this.quads();
      if (this.using() !== 'split' || this.split() !== null || quads.length !== 1) {
        this.proposal.set(null);
        return;
      }
      const sheet = quads[0];
      if (sheet === undefined) return;
      this.proposal.set(splitFromFraction(sheet as CaptureQuad, 0.5));
    });
  }

  /**
   * Turn this photograph a quarter — THROUGH THE SERVICE, not by rotating the
   * quads on the way out.
   *
   * It used to emit `quads.map(rotate)`, which is right for a page and wrong
   * for a spread: turning two halves independently keeps their old reading
   * order, and a half turn swaps which one reads first. That is measured (see
   * `turned` in capture.service.ts) and it was invisible here, because the
   * editor draws both halves and both look correct.
   *
   * A spread's turn has to rebuild the sheet and re-derive the halves, and the
   * component that draws two quads has no business knowing that. So the turn
   * travels as a TURN and the one body that understands cuts performs it —
   * the same body the table's turn goes through, which is what keeps the two
   * surfaces from disagreeing about which way round a page is.
   */
  protected turn(turns: number): void {
    this.turnBy.emit(turns);
  }

  /**
   * Cut this photograph into two pages at the split handle.
   *
   * From `joined`, never from `quads()[0]`: after a split that first quad is the
   * left half, and re-splitting it would halve the page again on every press.
   * The middle is the default because a spread photographed straight on is split
   * down the middle, and asking somebody to place a line before they may press
   * the button would be ceremony.
   */
  protected splitInTwo(): void {
    const sheet = joinedQuad(this.quads() as readonly CaptureQuad[], this.split());
    /*
     * THE MIDDLE, THROUGH THE ONE BODY THAT KNOWS WHAT THAT MEANS. A spread
     * photographed straight on is split down the middle, and asking somebody to
     * place a line before they may press the button would be ceremony.
     *
     * `splitFromFraction` is the same function main's migration reads an old
     * {x} with, which is the point of it being in shared: "the vertical segment
     * a fraction always meant" has one answer rather than one here and one
     * there.
     */
    /*
     * WHERE THE LINE ACTUALLY IS, not down the middle again. The tool put it
     * there and the person may have dragged it onto the gutter since; cutting
     * at 0.5 regardless would throw away the placing this button exists to
     * confirm. The fallback is the middle for the case where there is somehow
     * no proposal to read.
     */
    const split = this.proposal() ?? splitFromFraction(sheet, 0.5);
    const halves = halvesOf(sheet, split);
    // Unreachable for a segment built from a fraction -- both ends are put on
    // opposite edges by construction -- and doing nothing is the only answer
    // that cannot make a page out of a corner.
    if (halves === null) return;
    this.splitChange.emit(split);
    this.quadsChange.emit([halves[0], halves[1]]);
  }

  /**
   * Escape closes, and the arrows walk.
   *
   * On the window rather than the card because the pointer is routinely over the
   * picture and the card does not hold the focus while somebody is dragging a
   * corner. Ignored while a field has it, for the reason every shortcut in this
   * app is: a key that eats a character somebody was typing is worse than no
   * shortcut at all.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    event.preventDefault();
    if (event.key === 'Escape') this.close.emit();
    else this.step.emit(event.key === 'ArrowLeft' ? -1 : 1);
  }
}
