import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { PDF_BLOCK_CATEGORIES, pdfCategoryColour, pdfCategoryLabel } from '@shared/categories';
import type { BookLoad, BookRow } from '@shared/book';
import { replayOps, struckNotes, type BookOp, type ReplayedRow } from '@shared/ops';

import { api } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { TabsService, type BookStack, type Tab } from '../../core/tabs.service';

/**
 * THE BOOK — a proof sheet on a dark workbench, and the one surface this app
 * will edit.
 *
 * ── What this is, and what it replaces ──────────────────────────────────────
 *
 * *"we arent supposed to be rendering the book as an epub. it's supposed to be
 * rendered as an html page… the user isnt reading a book on foundry, they're
 * editing the contents of a book."* (docs/RENDERER.md §0.) The cast EPUB in an
 * iframe was the flowing document while nothing else flowed; what flows now is
 * the BOOK FILE — one row per block, ids minted, hyphens fused, page turns
 * joined — read over IPC and drawn as Angular DOM. No iframe, no sandbox, no
 * postMessage, no injected script, and no book unzipped anywhere.
 *
 * ── WHAT IS ON SCREEN IS A PURE FUNCTION, AND THAT IS THE WHOLE DESIGN ──────
 *
 * `view()` is `replayOps(rows, [...chain, ...pending])` and nothing else. There
 * is no incremental mutation anywhere in this file: a strike does not reach into
 * a row and set a flag, it PUSHES AN OP and the whole book is folded again. That
 * is affordable because the fold is one pass over an array this component is
 * already holding, and it is worth having at any price, because the alternative —
 * a stack of ops beside a set of rows somebody edited to match — is two accounts
 * of one book, which is the four-places-per-strike failure this wave exists to
 * end (docs/RENDERER.md §1).
 *
 * The CHAIN is what main read off the edit steps on the path from the position
 * (`BookLoad.ops`); PENDING is the LIFO stack of what has been done since. Undo
 * pops, redo re-pushes, Apply writes the stack down as a step and clears it — at
 * which point the pointer moves, the pane reloads, and the very same ops come
 * back on the chain. Closing without Apply scraps the stack, which is the ruling
 * (docs/RENDERER.md §3) and is what the closing question is about.
 *
 * ── FOUR OPS THIS WAVE, and the gestures for exactly those ──────────────────
 *
 * Strike and restore (Delete over a selection), text (double-click a block), and
 * category (the margin chip's menu). Merge, split, move, join, chapter, link and
 * restore-furniture are R4's: their shapes are declared in `shared/ops.ts` so the
 * grammar is whole, and the replay refuses one by name rather than performing two
 * thirds of somebody's history. The seam ghost still does nothing when pressed
 * for exactly that reason — it is the join op's gesture and the join op is not
 * built.
 *
 * ── The undo chord is ROUTED here, never listened for ───────────────────────
 *
 * Ctrl+Z is a menu accelerator main swallows, and the renderer decides which of
 * its three undos a chord meant (`MenuAction`, shared/api.ts). `TabsService.replay`
 * is where that decision lives; this component registers a `BookStack` with it and
 * adds no key listener of its own, because two answers to one keypress is how a
 * text field and a book both take something back.
 *
 * ── The selection is this component's and nothing else's ────────────────────
 *
 * It is not a fact about the book, it is in no undo stack, nothing on disk
 * records it and a reload starts with nothing selected — the same ruling the
 * frame selection has always had (`FrameSelection`, core/tabs.service.ts). It
 * lives here rather than in the service because nothing outside this pane can
 * act on it yet; the day the inspector can, it moves up, and moving it before
 * then would be a wire with nothing on either end.
 *
 * ── Virtualization, and why there is no library in it ───────────────────────
 *
 * A four-hundred-page book is thousands of blocks. `content-visibility: auto`
 * with `contain-intrinsic-size` is the browser skipping the layout and paint of
 * everything off screen, natively, with the real DOM still there for scrolling
 * to, jumping to and hit-testing against — which is the whole of what a virtual
 * scroller buys and none of what it costs (a fixed item height, a scrolling
 * viewport of its own, and a dependency). This is Chromium and the feature is not
 * in question here.
 *
 * IT IS ON A WRAPPER INSIDE EACH BLOCK AND NOT ON THE BLOCK, which looks like a
 * detail and is not: `content-visibility` brings PAINT CONTAINMENT with it, and
 * paint containment clips a box's descendants to its own bounds. Every mark this
 * design puts in a gutter is outside the text column by construction, so a
 * contained block host would clip away every rail, chip, ghost and flag on the
 * page. The host carries the chrome, the wrapper carries the words and the
 * containment, and neither interferes with the other.
 *
 * ── Every mark on the page is RENDERER-DESIGN.md's ──────────────────────────
 *
 * That file is law for the appearance and nothing below invents anything visual:
 * the tokens are copied from its §1, the paper from §2, the block chrome from §3,
 * the structure marks from §4, the two quiet states from §5 and the motion rules
 * from §6. The category inks come from `shared/categories.ts` — the ONE table —
 * and are used only as rails, tints and chips at the alphas that file's own
 * header insists on, so the page never turns into confetti.
 *
 * ── The text is TEXT ────────────────────────────────────────────────────────
 *
 * Every word a block carries reaches the DOM through interpolation. Nothing here
 * touches `innerHTML`, not on the model's output and not on anybody else's: a
 * book is ultimately somebody else's words arriving through a model's answer, and
 * the one thing this app will not do is hand them to a parser that can execute.
 * The reference numbers are the only structure drawn INTO a block's text, and
 * they are drawn from OFFSETS the engine resolved (`BookRef`), never by matching
 * digits — the same digits appear five times on a page of a book with fifty notes
 * in it.
 */

/** A reference number inside a block's text — bound to its note, or to nothing. */
interface Marker {
  at: number;
  len: number;
  /** The note row this number belongs to, or null when NOTHING carries it. */
  note: string | null;
  /**
   * True when the note this number belongs to is struck.
   *
   * DERIVED, AND NEVER AN OP OF ITS OWN. *"if i delete footnotes, it removes
   * their corresponding reference numbers."* (docs/RENDERER.md §0, ruling 9.) The
   * number belongs to the note, so striking the note strikes its numbers and
   * restoring it brings them back — computed from the replayed rows (§2), which
   * is one set lookup per marker because the replay already answers which notes
   * are struck (`struckNotes`).
   */
  struck: boolean;
}

/** One run of a block's text: words, or a reference number drawn as an element. */
interface Piece {
  text: string;
  marker: Marker | null;
}

/** One block, with everything the sheet has to know to draw it. */
interface Line {
  row: ReplayedRow;
  /** The words, cut at the reference numbers the engine resolved. */
  pieces: Piece[];
  /** The category ink, from the one table. Rails, tints and chips only. */
  colour: string;
  /** What the margin chip says when this block is selected. */
  label: string;
  /** The category's size as a ratio of the body's — measured, or the base sheet's. */
  size: number;
  /** Which note of its page this is, counted from one, or null for anything else. */
  ordinal: number | null;
  /**
   * The block this one jumps to when it is clicked — for a note, the first place
   * its number was printed. Null for everything else, which is most of the book.
   */
  jump: string | null;
  /** The page ghost for the right gutter, where a new source page begins here. */
  ghost: number | null;
  /** The chapter this block starts, drawn as a rule above it. */
  chapter: string | null;
  /**
   * True when an unjoined page turn falls immediately above this block — the
   * `before` half of one of the header's seams. Drawn as the `··· join ···`
   * ghost; the click that performs the join is the op grammar's (R3), so for
   * now the ghost is the report made visible where it belongs, between the two
   * paragraphs it is about, and it does nothing when pressed.
   */
  seam: boolean;
  /** Indented like a printed paragraph — not the first of the book, not after a heading. */
  indent: boolean;
  /** The hairline above the first note of a page's group of them. */
  opensNotes: boolean;
  /** What is unlinked about this block, for the amber flag in the right gutter. */
  flag: string | null;
}

/**
 * The base sheet's own ratios, for a category this book gave the engine too
 * little to measure.
 *
 * THIS IS A DOCUMENTED RULE AND NOT A FALLBACK, and the difference is worth being
 * exact about. `typography.ts` derives a size for five categories and writes
 * NOTHING for one with fewer than four samples under it, because a median of two
 * boxes is a coin toss between two boxes. What stands in that silence is the
 * static stylesheet every cast book in this app has always been set in
 * (`STYLESHEET_BASE`, src/vlm/dots-book.ts) — so these five numbers are a
 * transcription of the engine's own sheet rather than a guess made here, and a
 * book with nothing measured about it is set exactly as the engine would set it.
 */
const BASE_RATIO: Readonly<Record<string, number>> = {
  Footnote: 0.85,
  Caption: 0.9,
  Quote: 0.95,
  Title: 1.5,
  'Section-header': 1.15,
};

/** How far the pointer travels before a press on a block becomes a marquee. */
const DRAG_SLOP = 4;

/** The tint pulse on a block a marker jumped to — RENDERER-DESIGN.md §4. */
const PULSE_MS = 600;

@Component({
  selector: 'app-book-view',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      THE WORDS OF ONE BLOCK, in one template used by every category, because the
      only thing that differs between a paragraph and a caption is the element
      around them. Each run is an ELEMENT — including the plain ones — so that the
      whitespace between them in this file is whitespace-only and is dropped:
      text nodes interleaved with spans would each pick up the indentation of the
      line they are written on, and the book would come out with a space in front
      of every note number.
    -->
    <ng-template #words let-line>
      @for (piece of line.pieces; track $index) {
        @if (piece.marker; as marker) {
          <span
            class="marker"
            [attr.data-note]="marker.note"
            [class.unlinked]="marker.note === null"
            [class.struck]="marker.struck"
            [class.lit]="marker.note !== null && lit() === marker.note"
            (pointerenter)="light(marker.note)"
            (pointerleave)="light(null)"
          >{{ piece.text }}</span>
        } @else {
          <span class="run">{{ piece.text }}</span>
        }
      }
    </ng-template>

    <div class="bench">
      @if (problem(); as reason) {
        <div class="sheet"><p class="failure">{{ reason }}</p></div>
      } @else if (loading()) {
        <div class="sheet"><p class="waiting">Opening the book…</p></div>
      } @else {
        <!--
          \`tabindex="-1"\` so the sheet can HOLD focus without being a tab stop.
          The Delete key has to reach a selection that a marquee made over empty
          paper, and a marquee focuses nothing; a press on the paper puts focus
          here instead, and a press on a block focuses the block, whose keydown
          bubbles to this handler anyway. One listener, both routes, and no
          second tab stop in front of the book.
        -->
        <div
          class="sheet"
          tabindex="-1"
          (pointerdown)="press($event)"
          (pointermove)="drag($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
          (dblclick)="edit($event)"
          (keydown.delete)="cancel($event)"
          (keydown.backspace)="cancel($event)"
        >
          <!--
            THE OPS THAT LANDED ON NOTHING — reported, never guessed at
            (docs/RENDERER.md §3), on the paper's top edge where the reader meets
            it before the book. MUTED AND NOT AMBER: the flags in the gutters are
            amber because each of them is a decision somebody has to make, and
            this is not one. It is a fact about the history of this book — a
            change recorded against a paragraph that a later reading of the pages
            no longer has — and there is nothing here to do.
          -->
          @if (stranded(); as many) {
            <p class="stranded">
              {{ many }} recorded {{ many === 1 ? 'change names a block' : 'changes name blocks' }}
              this book no longer has, so {{ many === 1 ? 'it was' : 'they were' }} left out.
            </p>
          }
          @for (line of lines(); track line.row.id) {
            <!--
              The seam sits FIRST in a line's group of marks so that in the DOM
              it is the next sibling of the block ABOVE it — which is what lets
              a hover on either neighbour reveal it with two CSS selectors and
              no state. A chapter rule and a seam on one block cannot honestly
              co-occur (the reflow never leaves a seam onto a chapter opening),
              so the ordering costs nothing.
            -->
            @if (line.seam) {
              <div class="seam"><span class="seam-word">··· join ···</span></div>
            }
            @if (line.chapter; as title) {
              <div class="chapter"><span class="chapter-chip">{{ title }}</span></div>
            }
            @if (line.opensNotes) { <div class="notes-rule"></div> }
            <div
              class="block"
              tabindex="0"
              [attr.data-id]="line.row.id"
              [attr.data-jump]="line.jump"
              [style.color]="line.colour"
              [class.selected]="chosen().has(line.row.id)"
              [class.struck]="line.row.struck === true"
              [class.editing]="editingId() === line.row.id"
              [class.lit]="lit() === line.row.id"
              [class.pulse]="pulse() === line.row.id"
              [class.spanned]="spans(line)"
              (pointerenter)="lightRow(line)"
              (pointerleave)="light(null)"
            >
              <span class="gutter rail"></span>
              @if (chosen().has(line.row.id)) {
                <!--
                  THE CHIP IS THE CATEGORY'S DOOR. It already names the category
                  of the block it sits beside, so it is the one place in the
                  margin where "and this is what it could be instead" belongs.
                  IT OPENS A LIST rather than cycling: a chip that cycled would
                  be undiscoverable — nothing about it says there are eleven
                  answers behind it — and every misclick would mutate the
                  document. A button because it is one, which is also what makes
                  it reachable from a keyboard.
                -->
                <button
                  type="button"
                  class="gutter chip"
                  [attr.aria-label]="'Category of this block: ' + line.label"
                  (pointerdown)="$event.stopPropagation()"
                  (click)="openCategories($event, line.row.id)"
                >{{ line.label }}</button>
              }
              @if (line.ordinal !== null) {
                <span class="gutter ordinal">{{ line.ordinal }}</span>
              }
              @if (line.ghost !== null) {
                <span
                  class="gutter ghost"
                  (pointerenter)="haunt(line.ghost)"
                  (pointerleave)="haunt(null)"
                >≈ {{ line.ghost }}</span>
              }
              @if (line.flag; as said) {
                <span class="gutter flag"><span class="pill">{{ said }}</span></span>
              }

              <div class="body">
                <!--
                  THE BLOCK ITSELF IS THE EDITOR (RENDERER-DESIGN.md §3): a caret
                  in the words, a spruce rail and tint, no box and no textarea.
                  \`plaintext-only\` because what is being edited is the model's
                  SOURCE STRING — \`*italics*\` and superscript digits included
                  (docs/RENDERER.md §2) — and a rich contenteditable would let a
                  paste bring markup into a field whose whole content is meant to
                  be characters. The marker cuts are gone for the duration and
                  come back when the edit commits, which is the honest picture:
                  while you are editing there are no resolved offsets, because
                  the offsets are what the edit invalidates.
                -->
                @if (editingId() === line.row.id) {
                  <p
                    class="para editor"
                    contenteditable="plaintext-only"
                    [class.indent]="line.indent"
                    [style.font-size.em]="line.size"
                    (blur)="commit(line.row.id, $event)"
                    (keydown.escape)="revert(line.row.text, $event)"
                  >{{ line.row.text }}</p>
                } @else {
                @switch (line.row.category) {
                  @case ('Title') {
                    <h1 [style.font-size.em]="line.size">
                      <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                    </h1>
                  }
                  @case ('Section-header') {
                    <h2 [style.font-size.em]="line.size">
                      <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                    </h2>
                  }
                  @case ('Quote') {
                    <blockquote>
                      <p [style.font-size.em]="line.size">
                        <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                      </p>
                    </blockquote>
                  }
                  @case ('Caption') {
                    <p class="caption" [style.font-size.em]="line.size">
                      <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                    </p>
                  }
                  @case ('Footnote') {
                    <p class="note" [style.font-size.em]="line.size">
                      <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                    </p>
                  }
                  @case ('Picture') {
                    <!--
                      THE PLATE IS THE ENGINE'S OWN CROP, cut once beside the
                      bank when the book was made (docs/BOOK-FILE.md §6) and
                      served through the allow-listed book host — the row names
                      it, main resolves it, and this pane composes a URL and
                      nothing else. The empty frame remains the honest state of
                      a book none were cut for (no PDF at reflow): it reserves
                      the space a plate takes and names the page it came from,
                      so a book with plates reads as a book with plates rather
                      than as a paragraph gone missing. The alt is empty
                      because the caption below IS the description, and a
                      reader hearing it twice was told nothing the second time.
                    -->
                    <figure>
                      @if (plate(line.row); as src) {
                        <img class="plate-img" [src]="src" alt="" draggable="false">
                      } @else {
                        <div class="plate"><span class="plate-page">≈ {{ line.row.page }}</span></div>
                      }
                      @if (line.row.text.trim().length > 0) {
                        <figcaption [style.font-size.em]="line.size">
                          <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                        </figcaption>
                      }
                    </figure>
                  }
                  @default {
                    <!--
                      Text, and — with a class and nothing else — a table, a
                      formula and a list item. Their own shapes are later waves
                      (a table grid editor was deferred out loud); rendering what
                      the model read, plainly, is not a placeholder for that, it
                      is what the words are.
                    -->
                    <p
                      class="para"
                      [class.indent]="line.indent"
                      [class.set-off]="line.row.category !== 'Text'"
                      [style.font-size.em]="line.size"
                    >
                      <ng-container *ngTemplateOutlet="words; context: { $implicit: line }"></ng-container>
                    </p>
                  }
                }
                }
              </div>
            </div>
          }
          @if (marquee(); as box) {
            <div
              class="marquee"
              [style.left.px]="box.left"
              [style.top.px]="box.top"
              [style.width.px]="box.width"
              [style.height.px]="box.height"
            ></div>
          }
        </div>
        <!--
          APPLY — the stack, written down. ON THE BENCH AND NOT ON THE PAPER,
          which is the design law working rather than a placement preference:
          chrome lives in the paper's gutters and backgrounds, and a button is
          neither. It is the app's own \`.act\` in the app's own dark tokens, in
          the corner of the workbench, because that is where this app puts a verb.

          THE COUNT IS IN THE LABEL rather than beside it, on \`labelFor\`'s rule
          for a step row: "Apply" alone does not say whether it is about to record
          one strike or forty. DISABLED AT ZERO rather than hidden, so the
          affordance is somewhere a person can learn it is there before they have
          anything to press it with.
        -->
        <div class="tray">
          @if (pending().length > 0) {
            <button type="button" class="act ghost" (click)="undo()">Undo</button>
          }
          <button
            type="button"
            class="act"
            [disabled]="pending().length === 0 || applying()"
            (click)="apply()"
          >{{ applying() ? 'Applying…' : applyLabel() }}</button>
        </div>
      }
      <!--
        The category list — the app's own small menu, scrim and all
        (open-documents' \`.menu\`, which is where this vocabulary is settled). It
        is the SHELL's dark style and not the paper's, deliberately:
        RENDERER-DESIGN.md §5 keeps the paper vocabulary on the paper, and an
        overlay floating above the sheet is not part of it.
      -->
      @if (menu(); as open) {
        <div class="menu-scrim" (click)="menu.set(null)" (contextmenu)="menu.set(null)"></div>
        <div
          class="menu"
          role="menu"
          aria-label="What kind of block this is"
          [style.left.px]="open.x"
          [style.top.px]="open.y"
          (keydown.escape)="menu.set(null)"
        >
          @for (candidate of categories; track candidate.id) {
            <button
              role="menuitem"
              [class.current]="candidate.id === open.category"
              (click)="relabel(open.id, candidate.id)"
            >
              <span class="swatch" [style.background]="candidate.colour"></span>{{ candidate.label }}
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    /* ── §1 Tokens. Copied from RENDERER-DESIGN.md, and nothing else in this
       file is a colour. The app shell keeps its own dark variables; these are
       the paper's, declared once on the surface's host. ─────────────────── */
    :host {
      --bench:        var(--bg-base, #191817);

      --paper:        #f6f1e7;
      --paper-high:   #fbf8f1;
      --ink:          #211d16;
      --ink-muted:    #6f6659;
      --ink-faint:    #a99f8f;

      --ink-select:   #3b6ea5;
      --ink-strike:   #a23b2a;
      --ink-chapter:  #2f7d4f;
      --ink-note:     #8a5a2b;
      --ink-flag:     #b98a1c;
      --ink-edit:     #2f7d4f;

      --gutter:       3.25rem;
      --rail-w:       3px;
      --radius:       3px;
      --shadow-paper: 0 1px 2px rgb(0 0 0 / .4), 0 12px 48px rgb(0 0 0 / .28);

      --ease:         cubic-bezier(.2, .7, .3, 1);
      --t-fast:       120ms;
      --t-med:        180ms;

      display: block;
      width: 100%;
      height: 100%;
    }

    /* ── §2 The paper ─────────────────────────────────────────────────────── */

    /* The bench shows above and below the sheet so the paper reads as an object
       and not as a fill. Clipped horizontally rather than scrollable: a margin
       chip longer than its gutter is chrome, and chrome must never be able to
       give the page a second scrollbar. */
    .bench {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden auto;
      padding-block: 3rem;
      background: var(--bench);
      scrollbar-width: thin;
      scrollbar-color: #3a3733 transparent;
    }
    .bench::-webkit-scrollbar { width: 8px; }
    .bench::-webkit-scrollbar-track { background: transparent; }
    .bench::-webkit-scrollbar-thumb { background: #3a3733; border-radius: 4px; }

    .sheet {
      position: relative;
      width: min(46rem, 92%);
      margin: 0 auto;
      padding: 4.5rem var(--gutter) 6rem;
      border-radius: 2px;
      background: var(--paper);
      box-shadow: var(--shadow-paper);

      font-family: 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif;
      font-size: 1.05rem;
      line-height: 1.62;
      color: var(--ink);
      text-rendering: optimizeLegibility;
      /* A drag over the sheet is the marquee (§3). A native text selection left
         behind by one would be a second highlight nothing on screen explains, so
         the browser's own is off — copying a block's words is a gesture this
         surface does not offer yet. */
      user-select: none;
    }

    .sheet:focus { outline: none; }

    .waiting, .failure { margin: 0; text-indent: 0; color: var(--ink-muted); }
    .waiting { text-align: center; }

    /* A fact about the chain, not a decision to make — so it is \`--ink-muted\`
       and not the amber the gutter flags wear. It sits above the first block,
       inside the paper's own top padding, and it takes its own height because
       it is only ever there when it has something to say. */
    .stranded {
      margin: -2rem 0 2rem;
      text-indent: 0;
      color: var(--ink-muted);
      font-size: 0.8rem;
      font-style: italic;
    }

    /* ── §3 Block chrome. The text column NEVER reflows from any of it: rails
       and chips are absolute in the gutters, tints are backgrounds that bleed
       past the text and back. ─────────────────────────────────────────────── */

    /* The chrome host. It is exactly as wide as the text column, so every
       gutter offset below is measured from the words rather than from a box
       that has already been pushed about. */
    .block { position: relative; outline: none; }

    /* The words, the tint, and the containment — see the class docblock for why
       the last of those cannot live on the host. */
    .body {
      margin-inline: -0.9rem;
      padding-inline: 0.9rem;
      border-radius: var(--radius);
      content-visibility: auto;
      contain-intrinsic-size: auto 4rem;
      transition: background var(--t-fast) var(--ease);
    }

    /* The category ink rides on the block's own \`color\` so that every mark below
       can be a \`currentColor\` mix and no second palette is stated anywhere. It
       reaches .body too, which is what makes the tints category-coloured — and
       the WORDS are put straight back to the book's ink one level in, because a
       book with recoloured text is unreadable, which is the rule categories.ts
       closes with. */
    .body > * { color: var(--ink); }

    .block:hover .body { background: color-mix(in srgb, currentColor 5%, transparent); }
    .block.selected .body { background: color-mix(in srgb, currentColor 9%, transparent); }
    .block.lit .body, .block.pulse .body {
      background: color-mix(in srgb, var(--ink-note) 9%, transparent);
    }

    .gutter { position: absolute; pointer-events: none; }

    .rail {
      top: 0.15em;
      bottom: 0.15em;
      left: calc(var(--gutter) * -1 + 0.9rem);
      width: var(--rail-w);
      border-radius: var(--rail-w);
      background: currentColor;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .block:hover .rail { opacity: 0.6; }
    .block.selected .rail { opacity: 1; }
    /* The one place page provenance is visible, and deliberately a whisper. */
    .block.spanned .rail { opacity: 1; background: var(--ink-faint); }

    /* ── §3 Struck: the proofreader's cancel ──────────────────────────────── */

    /*
     * COPIED FROM RENDERER-DESIGN.md §3 AND NOT REINTERPRETED. Line-through in
     * the iron red at 55%, the whole block at .45, and the X drawn as two thin
     * diagonal linear-gradients in the same ink at 50% with \`mix-blend-mode:
     * multiply\` — which is what makes the mark sit ON the paper like ink rather
     * than float over it as a graphic. It is on \`.body\`, whose background box
     * already bleeds into the gutters, so the X crosses the block edge to edge
     * with no element added and no layout moved.
     *
     * THE MARK SHOWS ALWAYS. Struck is a state of the document and not of a mode
     * (landed rule), so there is no toggle anywhere that hides it — what leaves
     * the mark out is the EDITION, which is a projection and not a view of this
     * one.
     */
    .block.struck .body {
      opacity: 0.45;
      text-decoration: line-through;
      text-decoration-color: color-mix(in srgb, var(--ink-strike) 55%, transparent);
      background-image:
        linear-gradient(to bottom right,
          transparent calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% + 1px),
          transparent calc(50% + 1px)),
        linear-gradient(to top right,
          transparent calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% + 1px),
          transparent calc(50% + 1px));
      background-repeat: no-repeat;
      mix-blend-mode: multiply;
      /* On strike the X fades and scales in; on restore it lifts. Scaling the
         BACKGROUND rather than the box is what keeps the promise that no chrome
         ever moves the text: the words stay exactly where they are while the
         mark grows across them. */
      background-size: 100% 100%;
      transition:
        opacity var(--t-med) var(--ease),
        background-size var(--t-med) var(--ease);
    }
    .block:not(.struck) .body { background-size: 0% 0%; }

    /* ── §3 Editing: the block IS the editor ─────────────────────────────── */

    /* Spruce, at 7%, with the rail in the same ink — growth, not warning. No
       box, no visible textarea, and no border anywhere: the only sign that this
       paragraph is live is that it is tinted and there is a caret in it. */
    .block.editing .body,
    .block.editing:hover .body { background: color-mix(in srgb, var(--ink-edit) 7%, transparent); }
    .block.editing .rail { opacity: 1; background: var(--ink-edit); }
    /* The one place the sheet's own \`user-select: none\` is lifted, because a
       caret with no selection is an editor nobody can correct a word in. */
    .editor {
      white-space: pre-wrap;
      user-select: text;
      outline: none;
      caret-color: var(--ink-edit);
    }

    .chip {
      top: 0;
      left: 0;
      transform: translateX(calc(-100% - 0.5rem));
      padding: 0.1rem 0.45rem;
      border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      font-size: 10px;
      font-weight: 600;
      font-variant: small-caps;
      letter-spacing: 0.06em;
      white-space: nowrap;
      /* It is a button now, so it undoes the four things a button brings with it
         and takes back the pointer \`.gutter\` turns off. Everything else about it
         — the ink, the hairline, the ground, the small caps — is §3's chip
         unchanged, because it IS §3's chip: what it gained is a click. */
      font-family: inherit;
      color: inherit;
      line-height: inherit;
      cursor: pointer;
      pointer-events: auto;
    }
    .chip:hover { background: var(--paper); border-color: color-mix(in srgb, currentColor 70%, transparent); }
    .chip:focus-visible { outline: 2px solid var(--ink-select); outline-offset: 2px; }

    /* §4 — the sienna ordinal beside a note, in the left gutter. */
    .ordinal {
      top: 0.15em;
      left: calc(var(--gutter) * -1 + 0.9rem);
      width: calc(var(--gutter) - 1.8rem);
      text-align: right;
      color: var(--ink-note);
      font-size: 10px;
      line-height: 1.8;
    }

    /* §4 — page ghosts, right gutter. The ≈ is the design: pages are estimates
       and the type says so. */
    .ghost {
      top: 0.15em;
      left: calc(100% + 0.6rem);
      color: color-mix(in srgb, var(--ink-muted) 65%, transparent);
      font-size: 10px;
      font-style: italic;
      line-height: 1.8;
      white-space: nowrap;
      pointer-events: auto;
    }

    /* §4 — the amber flag: a dot until it is asked, a pill naming the problem
       once the pointer arrives. */
    .flag {
      top: 0.45em;
      left: calc(100% + 0.7rem);
      pointer-events: auto;
    }
    .flag::before {
      content: '';
      display: block;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--ink-flag);
    }
    .flag .pill {
      position: absolute;
      top: -0.4em;
      left: 1rem;
      display: block;
      width: max-content;
      max-width: 11rem;
      padding: 0.15rem 0.5rem;
      border: 1px solid color-mix(in srgb, var(--ink-flag) 45%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      color: var(--ink-flag);
      font-size: 10px;
      line-height: 1.5;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .flag:hover .pill { opacity: 1; }

    /* The one permitted outline, keyboard only. */
    .block:focus-visible { outline: 2px solid var(--ink-select); outline-offset: 2px; }

    .marquee {
      position: absolute;
      z-index: 2;
      border: 1px solid color-mix(in srgb, var(--ink-select) 55%, transparent);
      background: color-mix(in srgb, var(--ink-select) 12%, transparent);
      pointer-events: none;
    }

    /* ── §2/§4 The type itself ────────────────────────────────────────────── */

    h1, h2 { margin: 1.4em 0 0.8em; line-height: 1.2; font-weight: 600; }
    p { margin: 0; text-indent: 0; }
    .para.indent { text-indent: 1.4em; }
    .para.set-off { text-indent: 0; }
    .caption { margin: 0.4em 0 1em; font-style: italic; text-align: center; }
    blockquote { margin: 0.8em 2.2em; }
    .note { margin-bottom: 0.35em; }

    figure { margin: 1em 0; text-align: center; }
    figcaption { margin-top: 0.4em; font-style: italic; }
    .plate {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 8rem;
      border: 1px dashed var(--ink-faint);
      border-radius: var(--radius);
    }
    .plate-page { color: var(--ink-muted); font-size: 10px; font-style: italic; }
    .plate-img { display: block; max-width: 100%; margin: 0 auto; border-radius: var(--radius); }

    /* §4 — an unjoined page turn, drawn where it falls: between the two
       paragraphs, centered, hairline rules either side, and INVISIBLE until
       either neighbour is hovered — the seam is an offer, not a decoration,
       and a page of prose with four permanent captions in it would read as
       damaged. The two selectors below are the two neighbours: the block
       above is the seam's previous sibling, the block below its next. */
    .seam {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin: 0.35rem 0;
      color: var(--ink-muted);
      font-size: 10px;
      font-variant: small-caps;
      letter-spacing: 0.08em;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .seam::before, .seam::after { content: ''; flex: 1; border-top: 1px solid var(--ink-faint); }
    .seam-word { white-space: nowrap; }
    .block:hover + .seam, .seam:has(+ .block:hover) { opacity: 0.85; }

    /* §4 — a short hairline above the first note of a page's group of them. */
    .notes-rule { width: 4rem; margin: 1.2em 0 0.5em; border-top: 1px solid var(--ink-faint); }

    /* §4 — the chapter rule, carrying its chip. */
    .chapter {
      position: relative;
      margin: 2rem 0 1.25rem;
      border-top: 2px dashed color-mix(in srgb, var(--ink-chapter) 65%, transparent);
    }
    .chapter-chip {
      position: absolute;
      top: -0.8em;
      left: calc(var(--gutter) * -1 + 0.9rem);
      padding: 0.1rem 0.45rem;
      border: 1px solid color-mix(in srgb, var(--ink-chapter) 45%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      color: var(--ink-chapter);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }

    /* §4 — a reference number is a real element, not a superscript in a string. */
    .marker {
      padding: 0 .18em;
      border-radius: .45em;
      color: var(--ink-note);
      font-size: 0.75em;
      line-height: 0;
      vertical-align: super;
      cursor: default;
      transition: background var(--t-fast) var(--ease);
    }
    .marker:hover { box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--ink-note) 55%, transparent); }
    .marker.lit { background: color-mix(in srgb, var(--ink-note) 18%, transparent); }
    .marker.unlinked {
      color: var(--ink-flag);
      text-decoration: underline dotted var(--ink-flag);
      text-underline-offset: 0.2em;
    }
    /*
     * §4 — "Deleting a note strikes its markers with it — derived, animated
     * together." The number goes with the note because it BELONGS to the note,
     * and it is cancelled in the same iron red the block wears rather than
     * removed, for the same reason the block is: struck is a state, and the
     * reader has to be able to see what they took out.
     */
    .marker.struck {
      opacity: 0.45;
      text-decoration: line-through;
      text-decoration-color: color-mix(in srgb, var(--ink-strike) 55%, transparent);
      transition: opacity var(--t-med) var(--ease);
    }

    /* ── The one verb on this surface, on the bench beside the paper ──────── */

    .tray {
      position: sticky;
      z-index: 3;
      bottom: 0;
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      width: min(46rem, 92%);
      margin: 0 auto;
      padding: 0.75rem 0;
      pointer-events: none;
    }
    /* The app's own act, in the app's own dark tokens — the shell's language,
       because a button is the shell's furniture and not the paper's. */
    .act {
      padding: 5px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 11px;
      white-space: nowrap;
      cursor: pointer;
      pointer-events: auto;
    }
    .act:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .act:disabled { opacity: 0.4; cursor: default; }
    .act.ghost { background: transparent; color: var(--text-secondary); }

    /* The app's small menu, copied from open-documents — one vocabulary for
       one kind of thing, and the scrim is what makes the next click dismiss it
       exactly once. */
    .menu-scrim { position: fixed; inset: 0; z-index: 1000; }
    .menu {
      position: fixed;
      z-index: 1001;
      min-width: 180px;
      max-height: 60vh;
      overflow: hidden auto;
      padding: 4px;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.35);
    }
    .menu button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
    .menu button.current { color: var(--text-primary); }
    /* The swatch is what settles the two close pairs — see shared/categories.ts,
       which is the ONE table these colours come from. */
    .swatch { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 2px; }

    /* ── §6 Motion. The states must read perfectly as stills. ─────────────── */
    @media (prefers-reduced-motion: reduce) {
      .body, .rail, .marker, .flag .pill, .seam,
      .block.struck .body, .marker.struck { transition-duration: 0ms; }
    }
  `],
})
export class BookViewComponent {
  readonly tab = input.required<Tab>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tabs = inject(TabsService);
  private readonly ledger = inject(LedgerService);
  /** For `afterNextRender` from an event handler — see `edit`. */
  private readonly injector = inject(Injector);

  private readonly book = signal<BookLoad | null>(null);
  protected readonly loading = signal(true);
  protected readonly problem = signal<string | null>(null);

  /** The blocks the user has picked. Purely visual, and purely this pane's. */
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  /** The note whose apparatus is under the pointer — it and its markers light together. */
  protected readonly lit = signal<string | null>(null);
  /** The block a jump landed on, tinted for `PULSE_MS`. */
  protected readonly pulse = signal<string | null>(null);
  /** The source page a hovered ghost names, hairlining every block it spans. */
  protected readonly ghosted = signal<number | null>(null);
  /** The rectangle being dragged, in the sheet's own coordinates. */
  protected readonly marquee =
    signal<{ left: number; top: number; width: number; height: number } | null>(null);

  /**
   * THE STACK — everything decided since the last Apply, oldest first.
   *
   * A LIFO in memory and nowhere else (docs/RENDERER.md §0, ruling 5). Undo pops
   * the last one onto `undone`; redo puts it back; Apply writes the whole list as
   * a step and empties both. Closing scraps it, which is what the closing question
   * is about (`BookStack`, core/tabs.service.ts).
   *
   * IT IS A SIGNAL BECAUSE THE VIEW IS A FUNCTION OF IT. Every gesture on this
   * surface ends as a push here, and the sheet is `replayOps` over the chain and
   * this list — so a push repaints the book and there is no second place where a
   * change is also applied by hand.
   */
  protected readonly pending = signal<readonly BookOp[]>([]);
  /** What undo has taken off the stack, newest last. Cleared by any new gesture. */
  private readonly undone = signal<readonly BookOp[]>([]);
  /** True while `book:apply` is in flight, so the button cannot be pressed twice. */
  protected readonly applying = signal(false);

  /** The block being retyped, or null. Exactly one at a time, by construction. */
  protected readonly editingId = signal<string | null>(null);

  /** The category list, open over a block's chip. */
  protected readonly menu = signal<{ id: string; category: string; x: number; y: number } | null>(null);

  /** The categories the chip's list offers — the ONE table, in the engine's order. */
  protected readonly categories = PDF_BLOCK_CATEGORIES;

  /**
   * Which load is the current one.
   *
   * A pane can be pointed at another project before the first answer arrives —
   * and a book file that has to be MADE first takes seconds. Without the ticket
   * the slower of two answers would land last and put one project's blocks under
   * another project's name.
   */
  private asked = 0;

  /**
   * The pointer gesture in flight: where it started, and on what.
   *
   * WHAT WAS UNDER THE PRESS IS RECORDED HERE AND ACTED ON AT `release`, and
   * there is not a `(click)` binding anywhere on this sheet. The marquee takes
   * POINTER CAPTURE so that a drag survives leaving the paper, and a captured
   * pointer retargets the compatibility mouse events with it — so a `click` on a
   * note marker would arrive at the sheet with no idea which marker it had been.
   * One gesture, decided in one place, from what the press actually landed on.
   */
  private pressed: {
    x: number;
    y: number;
    /** The block the press landed in, or null for the paper between them. */
    id: string | null;
    /** True when it landed on a reference number rather than on words. */
    onMarker: boolean;
    /** The note that number belongs to, or null when nothing carries it. */
    note: string | null;
    /** Where this block jumps to when it is clicked — a note's first marker. */
    jump: string | null;
    extend: boolean;
    base: ReadonlySet<string>;
    dragging: boolean;
  } | null = null;

  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * True between a successful Apply and the reload it causes — the one thing
   * that tells the two reasons for a reload apart.
   *
   * ── Why the stack is NOT cleared the instant main answers ──────────────────
   *
   * Because the answer is not the reload. Main lands the step and moves the
   * pointer; the history is adopted, the position effect notices, the tab's
   * revision moves and `load` runs — three turns later, in Angular's own time.
   * Clearing the ops on the answer would leave the sheet drawing the OLD chain
   * with an empty stack over it for those three turns, which is the book without
   * the changes somebody just applied: a flash of the unedited document, at the
   * exact moment they are looking for confirmation that it worked. So the stack
   * stands until the chain that replaces it has arrived.
   *
   * Which leaves `load` unable to tell "these were just written down" from "you
   * stepped away and let them go", and both clear the same list. This is the
   * difference, held for one round trip and spent by the first load that sees it.
   * A boolean rather than the ids, because the question is which of two things
   * happened and not which ops were involved.
   */
  private landed = false;

  constructor() {
    effect(() => {
      const dir = this.tab().path;
      /*
       * AND THE REVISION, which is what makes a pointer move reach this pane. The
       * tab's path is the PROJECT directory and never changes; what changes when
       * somebody clicks a row in Steps is which book `book:load` would answer with
       * — a different reading, or the same reading with a different chain of
       * applied changes over it. `TabsService.showBook` bumps this on a genuine
       * position move and on nothing else, which is what keeps clicking the row you
       * are already standing on free.
       */
      this.tab().revision;
      // Untracked, because the load writes the signals this component draws from,
      // and an effect that reads its own writes is a loop waiting for a disk.
      untracked(() => void this.load(dir));
    });

    /*
     * THE STACK, ANNOUNCED — see `BookStack` (core/tabs.service.ts) for why the
     * wire exists at all when the selection deliberately has none. Two things
     * outside this pane need it: the undo chord, which main swallows as a menu
     * accelerator and the window routes, and the closing question, which is asked
     * once per tab about everything closing costs.
     */
    const tabs = this.tabs;
    const stack: BookStack = {
      pending: () => this.pending().length,
      canUndo: () => this.pending().length > 0,
      canRedo: () => this.undone().length > 0,
      undo: () => this.undo(),
      redo: () => this.redo(),
      apply: () => this.apply(),
    };
    /*
     * IN AN EFFECT AND NOT ON THIS LINE, because a required input has no value
     * until the first change detection and the constructor runs before it. The
     * effect also happens to make the registration correct rather than merely
     * legal: a pane pointed at another tab lets go of the first id before it
     * claims the second, so no stack is ever answered for by a pane that has
     * stopped being about it.
     */
    let registered: string | null = null;
    effect(() => {
      const id = this.tab().id;
      untracked(() => {
        if (registered === id) return;
        if (registered !== null) tabs.releaseBookStack(registered);
        tabs.registerBookStack(id, stack);
        registered = id;
      });
    });
    inject(DestroyRef).onDestroy(() => {
      if (registered !== null) tabs.releaseBookStack(registered);
    });
  }

  /**
   * Ask main for the book at this project's position.
   *
   * MAIN MAY HAVE TO MAKE IT FIRST, which is why this can take seconds on a
   * project nothing has reflowed yet, and why the sheet says `Opening the book…`
   * rather than showing a spinner (RENDERER-DESIGN.md §5: no spinners on paper).
   *
   * A REFUSAL IS RENDERED VERBATIM. Main composes the sentence — it is the side
   * that knows whether this book has never been read, whether the engine refused
   * the reflow, or whether the file is in a format this build does not know — and
   * paraphrasing it here would be this pane guessing at a fact it does not have.
   * The `catch` is for the door refusing outright (a directory that is not a
   * project), which is a thing to see rather than a thing to swallow.
   */
  private async load(projectDir: string): Promise<void> {
    if (api === null) return;
    this.asked += 1;
    const ticket = this.asked;
    this.loading.set(true);
    this.problem.set(null);
    this.book.set(null);
    this.chosen.set(new Set());
    this.editingId.set(null);
    this.menu.set(null);
    /*
     * THE STACK GOES WITH THE LOAD, and it is said out loud when it held anything.
     *
     * A reload happens for two reasons and the stack must not survive either. One
     * is an Apply, where it has just been written down and the same ops are about
     * to arrive on the chain — clearing is the whole point. The other is a pointer
     * move: somebody clicked another row in Steps, and ops made against the book
     * at the row they left are a delta against a state they are no longer in. The
     * ruling is that unapplied changes are scrapped rather than carried
     * (docs/RENDERER.md §3), and carrying them here would apply somebody's strikes
     * to a document they made no decision about.
     *
     * SILENCE WOULD BE THE FAILURE. A stack that vanished with no sentence is
     * indistinguishable from a stack that was applied, so the notice strip says
     * what happened — the same strip every other "that did not do what you may
     * have expected" in this window uses.
     */
    const scrapped = this.landed ? 0 : this.pending().length;
    this.landed = false;
    this.pending.set([]);
    this.undone.set([]);
    if (scrapped > 0) {
      this.tabs.notice.set(
        scrapped === 1
          ? 'The change waiting on the book was not applied, so moving to another step let it go.'
          : `The ${scrapped} changes waiting on the book were not applied, so moving to another step `
            + 'let them go.',
      );
    }
    try {
      const loaded = await api.book.load(projectDir);
      if (ticket !== this.asked) return;
      if (loaded.ok) this.book.set(loaded);
      else this.problem.set(loaded.reason);
    } catch (err) {
      if (ticket !== this.asked) return;
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (ticket === this.asked) this.loading.set(false);
    }
  }

  /**
   * Every reference number in the book, gathered by the block it was PRINTED in.
   *
   * The file records them the other way round — a note carries the places its
   * number appears — because the note is what owns the link, and deleting one is
   * what removes its numbers (docs/RENDERER.md §2). Drawing wants the inverse,
   * taken once, rather than a search of every note in the book per block.
   */
  /**
   * THE BOOK AS IT NOW READS — the file, with the chain and the stack replayed.
   *
   * ONE REPLAY, NO INCREMENTAL MUTATION. Every gesture on this surface pushes an
   * op and this recomputes; nothing anywhere else edits a row to match. The two
   * lists are concatenated in the only order they can be — what is already
   * recorded, then what is waiting — because the stack is a delta against the
   * state the chain produces, and the fold is order-dependent by design (last op
   * wins, `replayOps`).
   *
   * IT CANNOT THROW IN PRACTICE and is not wrapped as though it could. The only
   * refusal `replayOps` makes is an op kind this build cannot perform, and both
   * sources are already proven: main refuses the whole load rather than hand over
   * a chain it could not read (electron/book.ts), and the stack is minted by the
   * four gestures below.
   */
  private readonly view = computed(() => {
    const book = this.book();
    if (book === null) return null;
    return replayOps(book.rows, [...book.ops, ...this.pending()], book.loose);
  });

  /** How many recorded changes named blocks this book no longer has. */
  protected readonly stranded = computed(() => this.view()?.missing.length ?? 0);

  /** The notes whose numbers are cancelled with them — derived, never an op (§2). */
  private readonly struckNotes = computed<ReadonlySet<string>>(() => {
    const replayed = this.view();
    return replayed === null ? new Set<string>() : struckNotes(replayed.rows);
  });

  private readonly printed = computed<ReadonlyMap<string, Marker[]>>(() => {
    const replayed = this.view();
    const out = new Map<string, Marker[]>();
    if (replayed === null) return out;
    const cancelled = this.struckNotes();
    const add = (block: string, marker: Marker): void => {
      const already = out.get(block);
      if (already === undefined) out.set(block, [marker]);
      else already.push(marker);
    };
    for (const row of replayed.rows) {
      for (const ref of row.refs ?? []) {
        add(ref.block, { at: ref.at, len: ref.len, note: row.id, struck: cancelled.has(row.id) });
      }
    }
    for (const loose of replayed.loose.markers) {
      add(loose.block, { at: loose.at, len: loose.len, note: null, struck: false });
    }
    for (const markers of out.values()) markers.sort((one, other) => one.at - other.at);
    return out;
  });

  /**
   * The book as the sheet draws it — one Line per row, in reading order.
   *
   * EVERYTHING THAT DEPENDS ON THE ROW BEFORE IS DECIDED HERE, in one pass, and
   * not in the template: whether a paragraph is indented (the first of the book
   * and the first after a heading are not — print convention, §2), where a page
   * ghost belongs (only where the source page CHANGES), and which note opens a
   * page's group of them and so carries the hairline. A template asking those
   * questions per block would ask them again on every repaint.
   */
  protected readonly lines = computed<Line[]>(() => {
    const book = this.book();
    const replayed = this.view();
    if (book === null || replayed === null) return [];
    const chapters = new Map(book.chapters.map((chapter) => [chapter.id, chapter.title] as const));
    // The REPLAYED record of what is unlinked, not the file's: a text edit is the
    // one gesture that can point a note at nothing or a number at no note, and
    // `replayOps` is what re-derives both for the blocks it touched.
    const orphans = new Set(replayed.loose.notes);
    /*
     * A seam is drawn above its `before` block. The `after` id is not needed to
     * draw it — the two are adjacent among the flowing prose by the format's own
     * guarantee — but it will be the day the ghost becomes the join op, and the
     * header carries it for that day.
     */
    const seams = new Set(book.seams.map((seam) => seam.before));
    const printed = this.printed();

    const out: Line[] = [];
    let previous: BookRow | null = null;
    let onPage = -1;
    for (const row of replayed.rows) {
      /*
       * THE SHELF IS IN THE FILE AND NOT ON THE PAPER — §5 of the contract: a
       * shelved row is a block the model answered and the book does not contain
       * (page furniture, a suppressed running head), kept at its reading-order
       * position so that restoring one is an op with an obvious answer for
       * where. The Furniture Review panel is its surface (R4); the flow is not.
       */
      if (row.shelf !== undefined) continue;
      const page = row.pages[0] ?? row.page;
      const ghost = page === onPage ? null : page;
      onPage = page;
      const chapter = chapters.get(row.id) ?? null;
      const heading = previous !== null
        && (previous.category === 'Title' || previous.category === 'Section-header');
      const markers = printed.get(row.id) ?? [];
      out.push({
        row,
        pieces: cut(row.text, markers),
        colour: pdfCategoryColour(row.category),
        label: pdfCategoryLabel(row.category),
        size: sizeOf(book, row.category),
        ordinal: row.note === undefined ? null : row.note + 1,
        jump: row.refs?.[0]?.block ?? null,
        ghost,
        chapter,
        seam: seams.has(row.id),
        indent: row.category === 'Text' && previous !== null && !heading && chapter === null,
        opensNotes: row.category === 'Footnote'
          && (previous === null || previous.category !== 'Footnote' || previous.page !== row.page),
        // Both directions of the one structural flag this app still keeps
        // (docs/RENDERER.md §0, ruling 7). A note nothing points at first: it is
        // the whole row's problem, where a stray number is one word's.
        flag: orphans.has(row.id)
          ? 'nothing in the book carries this note'
          : markers.some((marker) => marker.note === null)
            ? 'no note carries this number'
            : null,
      });
      previous = row;
    }
    return out;
  });

  /**
   * The URL a Picture row's crop is served at, or null — for a row that names
   * no image (no PDF was given to the reflow) or a book main minted no door
   * for. Composed and never fetched: the allow-list behind the prefix is
   * main's (`bookFigureFile`), and a URL this pane got wrong is a 403 there.
   */
  protected plate(row: BookRow): string | null {
    const figures = this.book()?.figures ?? null;
    return figures !== null && row.image !== undefined
      ? figures + encodeURIComponent(row.image)
      : null;
  }

  /** True while a hovered page ghost names a page this block sits on. */
  protected spans(line: Line): boolean {
    const page = this.ghosted();
    return page !== null && line.row.pages.includes(page);
  }

  /** Light a note and its markers together, or put them all out. */
  protected light(noteId: string | null): void {
    this.lit.set(noteId);
  }

  /** A note row under the pointer lights its own markers. Anything else lights nothing. */
  protected lightRow(line: Line): void {
    this.lit.set(line.ordinal === null ? null : line.row.id);
  }

  protected haunt(page: number | null): void {
    this.ghosted.set(page);
  }

  /**
   * Put a block in the middle of the sheet and tint it for `PULSE_MS`.
   *
   * The pulse is the whole point of the gesture: a jump that merely scrolled
   * would leave the reader looking at a page of prose with no sign of which line
   * of it they had been sent to.
   */
  private scrollTo(id: string): void {
    const element = this.host.nativeElement.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (element === null) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (this.pulseTimer !== null) clearTimeout(this.pulseTimer);
    this.pulse.set(id);
    this.pulseTimer = setTimeout(() => this.pulse.set(null), PULSE_MS);
  }

  /**
   * A press on the sheet — the start of a click OR of a marquee, and which of
   * them it was is decided by whether the pointer moves.
   *
   * ONE GESTURE FOR BOTH, because from the hand's side they are one: press,
   * maybe move, let go. Deciding at pointerdown would mean guessing, and the
   * guess would be wrong exactly where the blocks are — which is everywhere on
   * this sheet, since a paragraph fills the column and there is almost no empty
   * paper to start a rectangle in.
   */
  protected press(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    const block = target === null ? null : target.closest('.block');
    /*
     * A PRESS INSIDE THE BLOCK BEING EDITED IS THE CARET'S, and nothing else's.
     * Selection and the marquee both take pointer capture, and a captured pointer
     * cannot place a caret or drag over a word — so while a block is live this
     * function stands aside for it entirely. Everywhere else on the sheet the
     * ordinary gestures still work, which is what makes a press on another
     * paragraph commit the edit (through the editor's own blur) and select that
     * paragraph in one movement.
     */
    const editing = this.editingId();
    if (editing !== null && block !== null && block.getAttribute('data-id') === editing) return;
    const marker = target === null ? null : target.closest('.marker');
    const sheet = event.currentTarget as HTMLElement;
    // The Delete key has to reach a marquee's selection, and a marquee focuses
    // nothing — see the sheet's own `tabindex` in the template.
    if (block === null) sheet.focus({ preventScroll: true });
    sheet.setPointerCapture(event.pointerId);
    this.pressed = {
      x: event.clientX,
      y: event.clientY,
      id: block === null ? null : block.getAttribute('data-id'),
      onMarker: marker !== null,
      note: marker === null ? null : marker.getAttribute('data-note'),
      jump: block === null ? null : block.getAttribute('data-jump'),
      extend: event.ctrlKey || event.metaKey || event.shiftKey,
      base: this.chosen(),
      dragging: false,
    };
  }

  protected drag(event: PointerEvent): void {
    const from = this.pressed;
    if (from === null) return;
    if (!from.dragging) {
      if (Math.abs(event.clientX - from.x) < DRAG_SLOP
        && Math.abs(event.clientY - from.y) < DRAG_SLOP) {
        return;
      }
      from.dragging = true;
    }
    const sheet = event.currentTarget as HTMLElement;
    const box = sheet.getBoundingClientRect();
    const left = Math.min(from.x, event.clientX);
    const top = Math.min(from.y, event.clientY);
    const right = Math.max(from.x, event.clientX);
    const bottom = Math.max(from.y, event.clientY);
    this.marquee.set({
      left: left - box.left,
      top: top - box.top,
      width: right - left,
      height: bottom - top,
    });
    const taken = new Set(from.extend ? from.base : []);
    for (const element of sheet.querySelectorAll('.block')) {
      const id = element.getAttribute('data-id');
      if (id === null) continue;
      const at = element.getBoundingClientRect();
      if (at.bottom >= top && at.top <= bottom && at.right >= left && at.left <= right) taken.add(id);
    }
    this.chosen.set(taken);
  }

  /** The end of it: a marquee keeps what it swept, a press takes one block. */
  protected release(event: PointerEvent): void {
    const from = this.pressed;
    this.pressed = null;
    this.marquee.set(null);
    const sheet = event.currentTarget as HTMLElement;
    if (sheet.hasPointerCapture(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
    if (from === null || from.dragging) return;
    /*
     * A PRESS ON A REFERENCE NUMBER IS A JUMP AND NOTHING ELSE — not a selection
     * of the paragraph it happens to sit in. The two halves of an apparatus are
     * a pair the reader is moving between, and taking a selection with them
     * would leave whatever they were about to act on behind. A number nothing
     * carries goes nowhere; the amber pill in the margin has already said why.
     */
    if (from.onMarker) {
      if (from.note !== null) this.scrollTo(from.note);
      return;
    }
    if (from.id === null) {
      // A press on the paper itself, off every block: the ordinary "let go of
      // what I had", which is how a selection is dropped everywhere in this app.
      if (!from.extend) this.chosen.set(new Set());
      return;
    }
    const id = from.id;
    if (from.extend) {
      const taken = new Set(from.base);
      if (!taken.delete(id)) taken.add(id);
      this.chosen.set(taken);
    } else {
      this.chosen.set(new Set([id]));
    }
    // A note goes the other way: to the first place its own number was printed.
    if (from.jump !== null) this.scrollTo(from.jump);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The stack: push, pop, and write it down
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One decision, onto the stack.
   *
   * THE REDO PILE IS DROPPED BY ANY NEW GESTURE, which is what every undo stack
   * in every program does and is the only coherent rule: the pile is a list of
   * things that were true of a document that has just changed under them, and
   * offering to re-apply a strike over a paragraph somebody has since retyped
   * would put an op back into a book it was never about.
   */
  private push(...ops: readonly BookOp[]): void {
    if (ops.length === 0) return;
    this.pending.update((held) => [...held, ...ops]);
    this.undone.set([]);
  }

  /** Ctrl+Z, routed from `TabsService.replay`. Pops one op; never touches a disk. */
  protected undo(): void {
    const held = this.pending();
    const last = held[held.length - 1];
    if (last === undefined) return;
    this.pending.set(held.slice(0, -1));
    this.undone.update((taken) => [...taken, last]);
  }

  /** Ctrl+Shift+Z / Ctrl+Y. Puts the last-undone op back where it was. */
  protected redo(): void {
    const taken = this.undone();
    const last = taken[taken.length - 1];
    if (last === undefined) return;
    this.undone.set(taken.slice(0, -1));
    this.pending.update((held) => [...held, last]);
  }

  /** What the button says. The count is IN the label, on `labelFor`'s rule. */
  protected applyLabel(): string {
    const many = this.pending().length;
    return many === 1 ? 'Apply 1 change' : `Apply ${many} changes`;
  }

  /**
   * APPLY — the stack, landed as a step.
   *
   * ── What happens afterwards, and why nothing here does it ───────────────────
   *
   * Main writes the ops file, lands an `edit` step as a child of the position and
   * moves the pointer onto it (`applyBookOps`, electron/book.ts). Adopting the
   * answer is all this does: `LedgerService.adopt` paints the history main handed
   * back, the position effect in `TabsService` notices a picture it has not shown
   * (`positionPicture` carries the edit chain for exactly this), and that bumps
   * this tab's revision — which reloads the book with the ops on its CHAIN and
   * clears the stack on the way. Clearing it here as well would be this component
   * doing by hand the thing the round trip proves, and would put the unedited book
   * on screen for the turns in between (see `landed`, which is what carries the
   * one fact across that gap).
   *
   * A REFUSAL LEAVES THE STACK EXACTLY WHERE IT IS, with main's sentence on the
   * notice strip. The changes are still on the paper in front of the person, which
   * is the only honest state for a write that did not happen — and the closing
   * question, which can call this, needs the false answer to keep the tab open.
   */
  protected async apply(): Promise<boolean> {
    const ops = this.pending();
    if (api === null || ops.length === 0 || this.applying()) return false;
    // A block still live when Apply is pressed has words in it nobody has
    // recorded yet. Committing first is what makes "apply what is on screen"
    // true rather than "apply what was on screen before you started typing".
    this.commitEditing();
    const waiting = this.pending();
    this.applying.set(true);
    try {
      const history = await api.book.apply(this.tab().path, waiting);
      this.landed = true;
      this.ledger.adopt(this.tab().path, history);
      return true;
    } catch (err) {
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.applying.set(false);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The four gestures
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * DELETE STRIKES — and Delete again, over the same blocks, brings them back.
   *
   * *"if i click them and hit delete again, it should un-delete them."* One key,
   * both directions, decided by what is under it: a selection with anything
   * unstruck in it is a person saying "remove these", so the unstruck ones are
   * struck and the ones already cancelled are left alone (striking them twice
   * would be two ops for one state, and the second would be the op undo takes
   * back first). A selection where EVERY block is already struck is the only
   * reading of the gesture left, and it restores them.
   *
   * BACKSPACE TOO, because on a surface with no text field in focus the two keys
   * mean one thing to a hand, and a gesture that worked on one keyboard's Delete
   * and not on a laptop's is a gesture half the users do not have.
   *
   * NOT WHILE A BLOCK IS LIVE. Delete inside a caret is a character, and it
   * belongs to the editor.
   */
  protected cancel(event: Event): void {
    if (this.editingId() !== null) return;
    const chosen = this.chosen();
    if (chosen.size === 0) return;
    event.preventDefault();
    const replayed = this.view();
    if (replayed === null) return;
    const struck = new Set(replayed.rows.filter((row) => row.struck === true).map((row) => row.id));
    const picked = replayed.rows.filter((row) => chosen.has(row.id));
    const unstruck = picked.filter((row) => !struck.has(row.id));
    this.push(...(unstruck.length > 0
      ? unstruck.map((row): BookOp => ({ op: 'strike', id: row.id }))
      : picked.map((row): BookOp => ({ op: 'restore', id: row.id }))));
  }

  /**
   * Double-click puts the caret in the block.
   *
   * THE BLOCK ITSELF BECOMES THE EDITOR and the marker cuts go away for the
   * duration, because what is being edited is the SOURCE STRING — the superscript
   * digits and the `*markers*` are characters in it (docs/RENDERER.md §2), and an
   * editor that hid them would be an editor somebody could not put a reference
   * number back into. The cut pieces come back the moment it commits, re-derived
   * against the new words.
   *
   * A SHELVED ROW IS NOT EDITABLE HERE because it is not drawn here; a struck one
   * is, deliberately — striking is a state and not a removal, and correcting a
   * paragraph you have cancelled is an ordinary thing to do on the way to
   * restoring it.
   */
  protected edit(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const block = target === null ? null : target.closest('.block');
    const id = block === null ? null : block.getAttribute('data-id');
    if (id === null || id === this.editingId()) return;
    this.commitEditing();
    this.editingId.set(id);
    this.chosen.set(new Set([id]));
    /*
     * FOCUSED AFTER THE FRAME THAT DRAWS IT. The editor element does not exist
     * until the template has re-run for the new `editingId`, and this app is
     * ZONELESS — so "after change detection" is a thing only Angular can promise,
     * and a `setTimeout` or a microtask here would be a guess about the
     * scheduler's own ordering. `afterNextRender` is that promise, and it needs
     * the injector because this runs from an event handler rather than from a
     * construction context.
     *
     * THE CARET GOES TO THE END rather than selecting the paragraph. A
     * double-click that highlighted every word would make the next keystroke
     * delete the block, which is a gesture nobody asked for arriving through one
     * they did.
     */
    afterNextRender(() => {
      const editor = this.host.nativeElement.querySelector('.editor') as HTMLElement | null;
      if (editor === null) return;
      editor.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, { injector: this.injector });
  }

  /**
   * Blur commits — the pair the app's other in-place editor already uses.
   *
   * The chapter-title editor in the rendered frame *"commits on Enter or blur and
   * cancels on Escape, which are the three endings the in-place block editor
   * already taught this document"* (electron/click-reporter.ts). Two of those
   * three are kept verbatim. ENTER IS NOT, and its absence is a reservation
   * rather than an omission: a block is prose and a line break inside one is
   * content the page had, and Enter-at-caret is the SPLIT gesture this surface
   * owes (docs/RENDERER.md §5) — which is R4's. Binding it to commit now would be
   * teaching a gesture the next wave has to take away.
   *
   * ONE OP, AND ONLY IF THE STRING MOVED. A double-click that put a caret
   * somewhere and then went away has decided nothing, and a step recording it
   * would be a row in somebody's history about a paragraph they looked at.
   */
  protected commit(id: string, event: Event): void {
    if (this.editingId() !== id) return;
    const editor = event.target as HTMLElement;
    // `textContent` and not `innerText`: the second one is a rendering — it folds
    // whitespace and inserts breaks the layout implies — and what is being read
    // back is a source string that must survive a round trip unchanged.
    const said = editor.textContent ?? '';
    this.editingId.set(null);
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.text === said) return;
    this.push({ op: 'text', id, text: said });
  }

  /**
   * Escape reverts: the words go back and the blur that follows finds nothing
   * changed.
   *
   * NO FLAG AND NO SECOND PATH. Putting the source string back into the element
   * BEFORE letting go of focus means the commit above compares the text to
   * itself, decides nothing happened and pushes nothing — one ending, reached two
   * ways, rather than two endings that have to be kept agreeing with each other.
   */
  protected revert(text: string, event: Event): void {
    const editor = event.target as HTMLElement;
    editor.textContent = text;
    editor.blur();
  }

  /** The live block, put to bed — for Apply, and for opening another editor. */
  private commitEditing(): void {
    const id = this.editingId();
    if (id === null) return;
    const editor = this.host.nativeElement.querySelector('.editor') as HTMLElement | null;
    if (editor === null) {
      this.editingId.set(null);
      return;
    }
    // Through the same ending a person's own blur takes, so there is one place
    // that decides whether a text op is owed.
    editor.blur();
  }

  /**
   * The margin chip's list of categories.
   *
   * FIXED-POSITIONED FROM THE CHIP'S OWN RECTANGLE, which is why the event is
   * needed rather than only the id: the menu is `position: fixed` (the app's own
   * `.menu`, so the scrim can be a full-window one) and the chip is inside a
   * scrolling bench, so the only honest anchor is where the chip is at the moment
   * it is pressed.
   */
  protected openCategories(event: MouseEvent, id: string): void {
    event.stopPropagation();
    const chip = event.currentTarget as HTMLElement;
    const box = chip.getBoundingClientRect();
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    this.menu.set({ id, category: row?.category ?? '', x: box.left, y: box.bottom + 4 });
  }

  /** One choice, one op — and nothing at all for choosing what it already is. */
  protected relabel(id: string, category: string): void {
    this.menu.set(null);
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.category === category) return;
    this.push({ op: 'category', id, category });
  }
}

/** The measured size for this category, or the engine's own base sheet's. */
function sizeOf(book: BookLoad, category: string): number {
  const measured = book.typography?.categories[category];
  if (measured !== undefined) return measured.ratio;
  return BASE_RATIO[category] ?? 1;
}

/**
 * One block's text, cut at the reference numbers printed in it.
 *
 * BY OFFSET AND NEVER BY SEARCHING FOR THE DIGITS — the engine resolved these
 * with the page in front of it, and a marker found by matching text lands on
 * whichever occurrence of "1" came first. The markers arrive sorted, inside the
 * text and non-overlapping, all three PROVEN by the parser (`parseBookFile`,
 * shared/book.ts) rather than assumed here, which is what lets this be one
 * forward walk with nothing to decide.
 */
function cut(text: string, markers: readonly Marker[]): Piece[] {
  if (markers.length === 0) return [{ text, marker: null }];
  const pieces: Piece[] = [];
  let at = 0;
  for (const marker of markers) {
    if (marker.at > at) pieces.push({ text: text.slice(at, marker.at), marker: null });
    pieces.push({ text: text.slice(marker.at, marker.at + marker.len), marker });
    at = marker.at + marker.len;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), marker: null });
  return pieces;
}
