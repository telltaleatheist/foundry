import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { pdfCategoryColour, pdfCategoryLabel } from '@shared/categories';
import type { BookLoad, BookRow } from '@shared/book';

import { api } from '../../core/foundry';
import type { Tab } from '../../core/tabs.service';

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
 * ── READ-ONLY, DELIBERATELY, AND ONLY FOR THIS WAVE ─────────────────────────
 *
 * Nothing here writes. There is no strike, no split, no merge, no drag, no
 * category change and no chapter move, because the op grammar and the replay
 * they all land in are the next unit's (docs/RENDERER.md §9, R3) — and a gesture
 * that changed what is on screen with nothing to write itself down as is the
 * exact failure the HTML editor was withdrawn for. What IS here is everything
 * the ops will be performed ON: the paper, the blocks, the chrome, the structure
 * marks, and a selection to hang them off.
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
}

/** One run of a block's text: words, or a reference number drawn as an element. */
interface Piece {
  text: string;
  marker: Marker | null;
}

/** One block, with everything the sheet has to know to draw it. */
interface Line {
  row: BookRow;
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
        <div
          class="sheet"
          (pointerdown)="press($event)"
          (pointermove)="drag($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
        >
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
              [class.lit]="lit() === line.row.id"
              [class.pulse]="pulse() === line.row.id"
              [class.spanned]="spans(line)"
              (pointerenter)="lightRow(line)"
              (pointerleave)="light(null)"
            >
              <span class="gutter rail"></span>
              @if (chosen().has(line.row.id)) {
                <span class="gutter chip">{{ line.label }}</span>
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

    .waiting, .failure { margin: 0; text-indent: 0; color: var(--ink-muted); }
    .waiting { text-align: center; }

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
    }

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

    /* ── §6 Motion. The states must read perfectly as stills. ─────────────── */
    @media (prefers-reduced-motion: reduce) {
      .body, .rail, .marker, .flag .pill, .seam { transition-duration: 0ms; }
    }
  `],
})
export class BookViewComponent {
  readonly tab = input.required<Tab>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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

  constructor() {
    effect(() => {
      const dir = this.tab().path;
      // Untracked, because the load writes the signals this component draws from,
      // and an effect that reads its own writes is a loop waiting for a disk.
      untracked(() => void this.load(dir));
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
  private readonly printed = computed<ReadonlyMap<string, Marker[]>>(() => {
    const book = this.book();
    const out = new Map<string, Marker[]>();
    if (book === null) return out;
    const add = (block: string, marker: Marker): void => {
      const already = out.get(block);
      if (already === undefined) out.set(block, [marker]);
      else already.push(marker);
    };
    for (const row of book.rows) {
      for (const ref of row.refs ?? []) add(ref.block, { at: ref.at, len: ref.len, note: row.id });
    }
    for (const loose of book.loose.markers) {
      add(loose.block, { at: loose.at, len: loose.len, note: null });
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
    if (book === null) return [];
    const chapters = new Map(book.chapters.map((chapter) => [chapter.id, chapter.title] as const));
    const orphans = new Set(book.loose.notes);
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
    for (const row of book.rows) {
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
    const marker = target === null ? null : target.closest('.marker');
    const sheet = event.currentTarget as HTMLElement;
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
