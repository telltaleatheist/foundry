import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { BLOCK_CATEGORIES, PDF_BLOCK_CATEGORIES, UNKNOWN_CATEGORY_COLOUR } from '@shared/categories';
import { targetKey, type OverlayChapter } from '@shared/overlay';
import type { EpubChapter, UncommittedCuration } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { TabsService, type BlockElement } from '../../core/tabs.service';

/**
 * The inspector — what the focused book IS, down the right-hand side.
 *
 * Final Cut Pro's inspector is the reference and the shape is deliberate: a
 * column of accordion sections, all open by default, each scrolling INSIDE
 * ITSELF. One long scroll for the whole panel would mean a book with sixty
 * chapters pushes the category rows off the bottom of the screen, and the
 * category rows are the half a curator uses every few seconds.
 *
 * IT IS IN THE SHELL AND NOT IN THE PANE, which is the change that pays for
 * itself. The chapter list used to be a 260px column inside app-epub-view, so
 * five open books were five copies of the same furniture eating 1300 pixels of
 * a window whose whole job is showing pages. There is one of it now and it
 * follows the FOCUSED document — the same thing the rail, Ctrl+S and the menu
 * mean by "what I am working on" (`TabsService.activeDocument`).
 *
 * ── What the frame can and cannot tell it ────────────────────────────────────
 *
 * The rendered chapter is a sandboxed <iframe> with an opaque origin: this
 * component cannot read one rectangle out of it, cannot hit-test a paragraph and
 * cannot post into it. Everything it knows about the page — which block is
 * selected, what that block's category is, how many blocks of each kind the
 * chapter holds — arrives as messages the injected reporter posts, through
 * TabsService, which keys them by tab so five panes cannot blank each other's.
 * Everything it DOES to the page goes back the same way: a command signal that
 * the viewer rendering that tab picks up and posts into its own frame.
 *
 * ── Relabelling changes the LABEL, not the SHAPE ─────────────────────────────
 *
 * Clicking a category row on a selected block rewrites its `data-bf-cat` and
 * nothing else. A paragraph relabelled `footnote` stays a `<p>` in the prose,
 * where the page printed it — it does not become an `<aside>` and it does not
 * move into the footnotes section. That re-shaping belongs to `foundry
 * epub-final`, in the engine, and is not in this app at all.
 */
@Component({
  selector: 'app-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (subject() !== null || projectDir() !== null) {
      <div class="panel">
        <!--
          STANDING ON A FROZEN SAVE, said once, at the top, before anything else
          in this panel is reached for. Every control below it is dead in this
          state — see \`curationLock\` — and a panel full of greyed buttons with no
          account of itself is an app that looks broken to the person it is
          protecting. It is here rather than repeated in each section because a
          person who read it over the chapters and again over the categories would
          be reading two answers to one question.
        -->
        @if (lock(); as held) {
          <p class="frozen">{{ held.why }}</p>
        }

        <!-- ── Standing on ──────────────────────────────────────────────── -->
        <!--
          THE RUNNING ORDER IS FIXED AND THIS IS THE TOP OF IT: the standing
          strip, then the book's divisions (Contents for a cast book, Chapters
          for a scan — one question asked of two kinds of document, so they share
          the one slot and the slot does not move), then Category, then anything
          about a single block. Sections that have nothing to say are still
          absent; what is fixed is that a section never overtakes another one.

          THE PANEL IS FURNITURE AND FURNITURE DOES NOT WALK. Almost everything
          here is conditional, and when the order was "whatever the guards happen
          to admit" the same section sat in a different place depending on what
          was focused and whether a block was picked — so every glance began by
          re-finding it. Keep new sections BELOW these.

          ── STEPS USED TO BE THIS SLOT, AND IT HAS LEFT THE PANEL ─────────────

          It was an accordion of every step in the project, first in the running
          order for the reasons above: the most nearly always-present thing here,
          and the only one belonging to the BOOK rather than to whatever pane was
          in front. That is exactly why it had to go. Two selectors were
          pretending to be one — the left panel picked a file, this section
          picked a position — and the user found the seam: *"i could have a
          document open, the epub, but have the pdf import step selected, and id
          never know that i just ran translate against the original pdf rather
          than the generated epub."* The steps are the LIBRARY now, drawn as the
          tree they always were, one selector on the left
          (docs/WORKBENCH.md §6c; open-documents.component.ts holds the whole of
          the reasoning and the rows).

          WHAT STAYED IS WHAT WAS NEVER A SELECTOR: the one line saying where
          this book is standing, and the Apply changes button that turns the
          decisions on the page into a step. This side is the inspector in the
          Final Cut sense — details and actions for the selected thing, never a
          competing selection.

          A STRIP AND NOT AN ACCORDION, because there is one line in it. An
          accordion header over a single row would be furniture wrapped around
          furniture, and it must not take a share of the panel's height the way
          \`.accordion\` does — the sections below it need every pixel.
        -->
        @if (projectDir() !== null) {
          <section class="standing">
            <div class="strip">
              <span class="label">Standing on</span>
              <span class="name" [title]="standingTitle()">{{ standingName() }}</span>
            </div>

            <!-- Main's own sentence about a ledger it would not read. It used to
                 be drawn where the step rows were; with the rows gone this is
                 where it lands, because "nowhere" with no account of why would
                 be the panel refusing to say what it knows. -->
            @if (stepsProblem(); as reason) {
              <p class="applying">{{ reason }}</p>
            }

            <!--
              APPLY IS OFFERED BESIDE THE POSITION IT APPLIES TO, which is most
              of what teaches what it does: press it and the step appears in the
              library, under the row named directly above. It appears only when
              there is something to apply (see unkept) rather than standing there
              dead — the whole reason it exists is that edits on the page were
              going nowhere, and a button that is always there says nothing about
              whether they have.
            -->
            @if (unkept(); as pending) {
              <div class="acts">
                <button
                  class="act"
                  title="Add these changes to the history as a step nothing later can change"
                  (click)="applyChanges()"
                >Apply changes</button>
              </div>
              <p class="applying">{{ applyLine(pending) }}</p>
            }
          </section>
        }

        <!--
          EVERYTHING THIS PANEL SAYS ABOUT THE DOCUMENT, which needs one. The
          sections below are about a book that is open and readable or a scan
          being corrected; the standing strip, above, is about the BOOK, and a
          scan that has never been in block view has one of those and none of
          these. Which is the whole reason the strip sits outside this block
          rather than inside it — it must hold the top of the panel in states
          where nothing down here draws at all. The block closes at the brace
          marked "end of the document's sections", which is the last thing in the
          panel.
        -->
        @if (subject(); as panel) {
        <!-- ── Contents ─────────────────────────────────────────────────── -->
        @if (book(); as current) {
        <section class="accordion" [class.shut]="!contentsOpen()">
          <button class="head" (click)="contentsOpen.set(!contentsOpen())">
            <span class="twist">{{ contentsOpen() ? '▾' : '▸' }}</span>
            <span class="label">Contents</span>
            <span class="count">{{ current.book.chapters.length }}</span>
          </button>
          @if (contentsOpen()) {
            <div class="body">
              <div class="about">
                <span class="book-title" [title]="current.book.title">{{ current.book.title }}</span>
                @if (current.book.author) {
                  <span class="book-author">{{ current.book.author }}</span>
                }
              </div>
              <ul>
                @for (chapter of current.book.chapters; track chapter.href) {
                  <li class="entry">
                    @if (renamingHref() === chapter.href) {
                      <input
                        #renameBox
                        class="rename"
                        [style.margin-left.px]="4 + chapter.depth * 14"
                        [value]="renameText()"
                        (input)="renameText.set(renameBox.value)"
                        (keydown.enter)="commitRename(chapter)"
                        (keydown.escape)="cancelRename()"
                        (blur)="cancelRename()"
                        [attr.aria-label]="'Rename ' + chapter.label"
                      >
                    } @else {
                      <button
                        class="chapter"
                        [class.active]="current.chapterHref === chapter.href"
                        [style.padding-left.px]="10 + chapter.depth * 14"
                        [title]="chapter.label"
                        (click)="show(chapter)"
                        (dblclick)="startRename(chapter)"
                      >{{ chapter.label }}</button>
                      <button class="pencil" title="Rename" (click)="startRename(chapter)">✎</button>
                    }
                  </li>
                }
              </ul>
            </div>
          }
        </section>
        }

        <!-- ── The chapters, for a scan ─────────────────────────────────── -->
        @if (panel.kind === 'pdf') {
          <section class="accordion" [class.shut]="!chaptersOpen()">
            <button class="head" (click)="chaptersOpen.set(!chaptersOpen())">
              <span class="twist">{{ chaptersOpen() ? '▾' : '▸' }}</span>
              <span class="label">Chapters</span>
              <span class="count">{{ spine().chapters.length }}</span>
            </button>
            @if (chaptersOpen()) {
              <div class="body">
                <!--
                  WHOSE LIST THIS IS, said before anything is clicked. Until
                  somebody edits it these rows are Foundry's own answer, and the
                  first edit takes the whole list over — after which detection is
                  superseded rather than consulted. A person who does not know
                  which of those two states they are in cannot tell whether a
                  chapter appearing was their doing or the app's.
                -->
                <p class="hint">
                  @if (spine().confirmed) {
                    These are your chapters. The book divides here and nowhere else.
                  } @else {
                    These are the chapters Foundry found. Change any of them and the list
                    becomes yours — from then on the book divides exactly where it says.
                  }
                </p>

                <ul>
                  @for (row of chapterRows(); track row.target) {
                    <li class="entry" [class.missing]="!row.present">
                      @if (renamingHref() === row.target) {
                        <input
                          #renameBox
                          class="rename"
                          [value]="renameText()"
                          (input)="renameText.set(renameBox.value)"
                          (keydown.enter)="commitChapterRename(row.target)"
                          (keydown.escape)="cancelRename()"
                          (blur)="cancelRename()"
                          [attr.aria-label]="'Rename ' + row.title"
                        >
                      } @else {
                        <button
                          class="chapter"
                          [title]="row.present ? row.title : row.title + ' — not on these pages'"
                          (click)="showBlock(row.target)"
                          (dblclick)="startChapterRename(row)"
                        >
                          <span class="ch-title">{{ row.title }}</span>
                          <span class="ch-at">{{ row.where }}</span>
                        </button>
                        <button class="pencil" title="Rename" [disabled]="frozen()" (click)="startChapterRename(row)">✎</button>
                        <button class="pencil" title="Not a chapter" [disabled]="frozen()" (click)="dropChapter(row.target)">✕</button>
                      }
                    </li>
                  }
                  @if (chapterRows().length === 0) {
                    <li class="none">This book does not divide: it renders as one section.</li>
                  }
                </ul>

                <div class="acts">
                  <button
                    class="act"
                    [disabled]="onlyBlock() === null || onlyBlockIsChapter() || frozen()"
                    [title]="chapterAddTitle()"
                    (click)="makeChapter()"
                  >Chapter starts here</button>
                  <!--
                    The way back. The first chapter edit turns "Foundry decides"
                    into forty-one blocks stated exactly, and without this that
                    door only opens one way — a person who curated a spine and
                    then wanted the app's answer again would have no gesture for
                    it. One ledger row like any other, so Ctrl+Z brings their
                    list back.
                  -->
                  <button
                    class="act"
                    [disabled]="!spine().confirmed || frozen()"
                    title="Throw this list away and let Foundry work the chapters out again"
                    (click)="resetChapters()"
                  >Use Foundry's</button>
                </div>
              </div>
            }
          </section>
        }

        <!-- ── Category ─────────────────────────────────────────────────── -->
        <section class="accordion" [class.shut]="!categoryOpen()">
          <button class="head" (click)="categoryOpen.set(!categoryOpen())">
            <span class="twist">{{ categoryOpen() ? '▾' : '▸' }}</span>
            <span class="label">Category</span>
            <span class="count">{{ rows().length }}</span>
          </button>
          @if (categoryOpen()) {
            <div class="body">
              <!--
                WHAT A CLICK WILL DO, said before it is clicked. The rows are two
                things at once — a legend for the colours in the page, and the
                control that relabels a block — and which of them you are looking
                at depends on whether anything is selected. Saying so is cheaper
                than letting a person discover it by relabelling something.
              -->
              <p class="hint">
                @if (!panel.live) {
                  @if (panel.kind === 'epub') {
                    Turn on Select to colour the blocks and relabel them.
                  } @else {
                    Press Blocks to outline what the model read and relabel it.
                  }
                } @else if (selected(); as picked) {
                  @if (picked.blockIds.length === 1) {
                    {{ picked.blockIds[0] }} is selected — click a row to relabel it.
                  } @else {
                    {{ picked.blockIds.length }} blocks are selected — click a row to relabel all of them.
                  }
                } @else {
                  Click a block in the page, or drag a rectangle over several, to relabel them.
                  These are the colours they draw in.
                }
              </p>

              <ul>
                @for (row of rows(); track row.id) {
                  <li class="cat" [class.current]="row.id === selected()?.category">
                    <button
                      class="pick"
                      [title]="row.note"
                      [disabled]="!panel.live || frozen()"
                      (click)="relabel(row.id)"
                    >
                      <span class="swatch" [style.background]="row.colour"></span>
                      <span class="name">{{ row.label }}</span>
                      @if (row.total !== null) {
                        <span class="tally" [title]="tallyTitle(row)">
                          {{ row.total }}@if (row.struck > 0) {<span class="struck"> · {{ row.struck }} cut</span>}
                        </span>
                      }
                    </button>
                    <!--
                      Select-all-by-category, and it TOGGLES: with anything of
                      this kind still standing it strikes them, and with all of
                      them already struck it brings them back. That is what makes
                      a two-hundred-block gesture feel undoable with the tool that
                      did it — and how many it actually moved is said in the
                      notice strip, because a batch that reports what it asked
                      for rather than what it did is a batch nobody can trust.
                    -->
                    <button
                      class="strike"
                      [disabled]="!panel.live || frozen() || row.total === null || row.total === 0"
                      [title]="strikeTitle(row)"
                      (click)="strike(row.id)"
                    >{{ row.total !== null && row.total > 0 && row.struck === row.total ? '↺' : '⌦' }}</button>
                  </li>
                }
                @if (unknown().length > 0) {
                  <!--
                    A category this app has never heard of, which the emitter is
                    allowed to grow before this table does. Drawn in the same
                    grey the page outlines it in and NAMED, rather than dropped:
                    a book with blocks the inspector does not list is a book with
                    blocks nobody can find.
                  -->
                  @for (row of unknown(); track row.id) {
                    <li class="cat">
                      <button class="pick" disabled title="Not a category this version of Foundry knows">
                        <span class="swatch" [style.background]="fallback"></span>
                        <span class="name">{{ row.id }}</span>
                        <span class="tally">{{ row.total }}</span>
                      </button>
                      <button class="strike" disabled>⌦</button>
                    </li>
                  }
                }
              </ul>
            </div>
          }
        </section>

        <!--
          ── The Block section is NOT DRAWN, and the reason is two reasons ──

          IT APPEARED AND DISAPPEARED UNDER THE POINTER. It was the only section
          conditioned on a SELECTION rather than on which document is focused, so
          clicking a block on the page added a fourth section to a column of
          three — and because the sections share the height between them, every
          other section resized and slid the moment somebody selected something.
          The panel reorganising itself in response to a click on the page is the
          same complaint that pinned this running order in the first place: you
          cannot aim at a section that moves when you touch the book.

          AND ITS ONE JOB IS GONE FOR NOW. The box corrected what the model read
          off the page, and text editing is retired until the flowing surface
          carries it as an op (docs/DERIVED-BOOK.md §3, phase B). A control that
          is still on screen after the thing it does has been withdrawn is worse
          than no control: it invites the gesture and then refuses it.

          THE LOGIC STAYS, deliberately and untouched — onlyBlock, draft,
          reading, corrected, applyWords, revertWords. It is the word-level
          correction path the text-edit op is going to be built on, and
          onlyBlock is still read by the Chapters section above. This is a
          surface being withdrawn, not a feature being deleted; deleting it would
          mean writing it again in three phases' time.
        -->
        } <!-- end of the document's sections -->

        <!--
          THERE IS NO CONTEXT MENU IN THIS PANEL ANY MORE. It held one item —
          "Open in split" on a step row — which was the second half of the user's
          rule about opening steps: *"they can right-click a different step and
          click open, and itll split the screens between the one they just opened
          and the one they already had open."* Step rows live in the library now,
          and so does the menu, beside "Delete this step…" which used to be a ✕ on
          the row (docs/WORKBENCH.md §6c). One context-menu idiom in this app, and
          it is drawn where the rows it is about are.
        -->
      </div>
    }
  `,
  styles: [`
    :host { display: block; width: 260px; min-width: 260px; height: 100%; }

    /* The documents panel's surface, mirrored: the two side panels are siblings
       and the window should read as one frame around the pages, not as three
       materials meeting. */
    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-elevated);
      border-left: 1px solid var(--border-default);
    }

    /*
      THE SECTIONS SHARE THE HEIGHT AND EACH SCROLLS ITSELF. \`flex: 1 1 0\` with
      \`min-height: 0\` is what makes that true — without the minimum a flex item
      refuses to shrink below its content and the last section's rows fall off
      the bottom of the panel with no scrollbar anywhere. A shut section takes
      only its header row.
    */
    .accordion {
      flex: 1 1 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid var(--border-subtle);
    }
    .accordion.shut { flex: 0 0 auto; }

    .head {
      display: flex; align-items: baseline; gap: 8px;
      width: 100%;
      padding: 10px 12px 8px;
      background: transparent; border: none;
      text-align: left; cursor: pointer;
    }
    .head:hover { background: var(--bg-hover); }
    .twist { color: var(--text-tertiary); font-size: 9px; }
    .label {
      flex: 1;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 6px; }

    .about { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 8px; }
    .book-title {
      font-family: var(--font-display); font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .book-author { font-size: 11px; color: var(--text-tertiary); }

    ul { list-style: none; margin: 0; padding: 0; }

    .entry { display: flex; align-items: center; }
    .pencil {
      flex-shrink: 0;
      visibility: hidden;
      margin-right: 6px;
      padding: 2px 5px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 11px; cursor: pointer;
    }
    .entry:hover .pencil { visibility: visible; }
    .pencil:hover { color: var(--text-primary); background: var(--bg-hover); }
    .rename {
      flex: 1;
      min-width: 0;
      margin: 2px 8px 2px 0;
      padding: 4px 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--accent);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .rename:focus { outline: none; box-shadow: var(--focus-ring); }

    .chapter {
      display: block;
      flex: 1;
      min-width: 0;
      margin: 0 6px;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .chapter:hover { background: var(--bg-hover); color: var(--text-primary); }
    .chapter.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 500;
    }

    /*
      THE SPACE IS RESERVED, so the rows under a hint never move.

      Every one of these paragraphs says a DIFFERENT SENTENCE depending on the
      state it is about — "4:2 is selected" against the three-line legend of the
      colours, "these are your chapters" against the longer sentence about
      chapters Foundry only proposed. The sentences are different lengths, so
      left to size themselves they grew and shrank as the user clicked and the
      whole list slid up and down underneath: the panel rearranging itself in
      answer to a click on the book, which is the one thing this column must
      never do.

      FOUR LINES, sized to the LONGEST sentence in the panel — the unconfirmed
      chapters one — rather than to each section's own, because one height for
      every hint is a rule that holds when somebody adds a section, and a
      per-section height is a measurement that rots the first time a sentence is
      reworded. The cost is some quiet space under the short ones, which is what
      buying a still panel costs. A sentence longer than this will start the
      movement again: measure before you write one.
    */
    .hint {
      margin: 0 0 6px;
      padding: 0 12px;
      min-height: calc(4 * 1.4em);
      box-sizing: content-box;
      font-size: 11px; line-height: 1.4;
      color: var(--text-tertiary);
    }

    .cat { display: flex; align-items: center; }
    .cat.current { background: var(--accent-faint); }

    .pick {
      display: flex; align-items: center; gap: 8px;
      flex: 1; min-width: 0;
      margin: 0 2px 0 6px;
      padding: 5px 8px;
      background: transparent; border: none; border-radius: var(--radius-md);
      color: var(--text-secondary); font-size: 12px;
      text-align: left; cursor: pointer;
    }
    .pick:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .pick:disabled { cursor: default; opacity: 0.6; }

    /*
      THE SWATCH IS THE WHOLE POINT OF THIS ROW. The page outlines a block in
      this colour and nothing else on screen decodes it; a category list without
      it is a legend with the key torn off.
    */
    .swatch {
      flex: 0 0 auto;
      width: 11px; height: 11px;
      border-radius: 3px;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
    }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tally {
      flex: 0 0 auto;
      color: var(--text-tertiary); font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .struck { color: var(--error); }

    .strike {
      flex: 0 0 auto;
      margin-right: 6px;
      padding: 3px 6px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 12px; line-height: 1;
      cursor: pointer;
    }
    .strike:hover:not(:disabled) { background: var(--bg-hover); color: var(--error); }
    .strike:disabled { opacity: 0.25; cursor: default; }

    /* ── The scan's two extra sections ─────────────────────────────────── */

    /* A chapter row is two lines of unequal weight: the name somebody will read
       in the contents, and the page it opens on, which is only ever a check. */
    .chapter { display: flex; align-items: baseline; gap: 6px; }
    .ch-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ch-at {
      flex: 0 0 auto;
      color: var(--text-tertiary); font-size: 10px;
      font-variant-numeric: tabular-nums;
    }

    /*
      A CHAPTER WHOSE BLOCK IS NOT IN THIS RENDERING. The engine skips it rather
      than refusing the run — a page taken out with --skip-pages, or a block
      struck since — so the app must not refuse it either. It is DRAWN AND
      DIMMED: a row that vanished would take somebody's chapter name with it, and
      a row that looked ordinary would promise a division the book will not have.
    */
    .entry.missing .ch-title { text-decoration: line-through; }
    .entry.missing { opacity: 0.5; }

    .none {
      padding: 4px 12px 8px;
      color: var(--text-tertiary); font-size: 11px; font-style: italic;
    }

    .acts { display: flex; gap: 6px; padding: 8px 12px 4px; }
    /*
      The sentence under Apply changes. NOT a hint and deliberately not given
      that class's four-line reserve: a hint is a section's standing description
      and holds its height whatever happens, while this line and the button above
      it are one thing that appears together and goes away together. Reserving
      space for it would leave a hole under the button in the ordinary state,
      which is the state where nothing is waiting to be applied.
    */
    .applying {
      margin: 0 0 6px;
      padding: 0 12px;
      font-size: 11px; line-height: 1.4;
      color: var(--text-tertiary);
    }
    .act {
      flex: 1;
      padding: 5px 8px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text-primary); font-size: 11px;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .act:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .act:disabled { opacity: 0.4; cursor: default; }

    .words {
      display: block;
      width: calc(100% - 24px);
      margin: 0 12px;
      padding: 6px 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono, monospace);
      font-size: 11px; line-height: 1.45;
      resize: vertical;
    }
    .words:focus { outline: none; box-shadow: var(--focus-ring); border-color: var(--accent); }
    .words:disabled { opacity: 0.6; }

    /* ── The two things at the top that are not sections ───────────────── */

    /*
      A STATE THE WHOLE COLUMN IS IN — every control under it is dead — so it
      sits above them all, in the warning colour the notice strip uses, and it
      does not scroll away with any one section's rows.
    */
    .frozen {
      flex: 0 0 auto;
      margin: 0;
      padding: 8px 12px;
      background: var(--warn-soft);
      border-bottom: 1px solid var(--border-subtle);
      color: var(--warn);
      font-size: 11px; line-height: 1.45;
    }

    /*
      THE STANDING STRIP — the new fixed top of the panel, where the Steps
      accordion used to be.

      \`flex: 0 0 auto\` is the whole difference from a section: it takes the
      height of its own contents and never a share of the column, because it is
      one line and a button that comes and goes, and giving it \`flex: 1 1 0\`
      would hand a third of the panel to a sentence.
    */
    .standing {
      flex: 0 0 auto;
      border-bottom: 1px solid var(--border-subtle);
    }
    /*
      THE LABEL AND THE NAME ON ONE LINE, in the accordion headers' own
      typography, so the top of the panel reads as furniture of the same make —
      without the twist, because there is nothing to open.
    */
    .strip {
      display: flex; align-items: baseline; gap: 8px;
      padding: 10px 12px 8px;
    }
    .strip .label {
      flex: 0 0 auto;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    /*
      THE STANDING STEP, IN THE ACCENT — the same word for "this is the one you
      are on" that the library's current row uses, so the two panels are visibly
      saying one thing about one position rather than two things about two.
    */
    .strip .name {
      flex: 1; min-width: 0;
      color: var(--accent); font-size: 12px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `],
})
export class InspectorComponent {
  protected readonly tabs = inject(TabsService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  protected readonly fallback = UNKNOWN_CATEGORY_COLOUR;

  /**
   * Both sections start OPEN, which is what Owen asked for and what an inspector
   * is for: a panel whose sections you have to open before it says anything is a
   * panel that says nothing. They are still collapsible, because sixty chapters
   * and eleven categories do not both fit on a laptop.
   */
  protected readonly contentsOpen = signal(true);
  protected readonly categoryOpen = signal(true);
  protected readonly chaptersOpen = signal(true);
  protected readonly blockOpen = signal(true);

  /** Which chapter row is being renamed, and the text in its box. */
  protected readonly renamingHref = signal<string | null>(null);
  protected readonly renameText = signal('');

  private readonly renameBox = viewChild<ElementRef<HTMLInputElement>>('renameBox');

  /**
   * The book this panel is about: the focused pane's document, unpacked.
   *
   * `activeDocument` and not `active`, for the reason the rail reads the same
   * thing: with the HTML editor pane focused the tab in front of the user IS the
   * editor, and an inspector that emptied itself the moment somebody clicked
   * into a book's source would be an inspector you cannot use while editing.
   *
   * Narrowed to a tab whose `book` is non-null so the template can reach through
   * it without a second guard on every line.
   */
  protected readonly book = computed(() => {
    const tab = this.tabs.activeDocument();
    if (tab === null || tab.kind !== 'epub' || tab.book === null) return null;
    return { ...tab, book: tab.book };
  });

  /**
   * WHAT THIS PANEL IS ABOUT, which is now one of two things.
   *
   * A BOOK, as it always was — an unpacked EPUB with chapters and stamped
   * blocks. Or a SCAN in block view, which has neither: its "blocks" are the
   * model's answers about the pages and its "contents" is a list somebody is
   * building. The two share the Category section entirely, because a footnote is
   * a footnote in both and the colours come from one table; everything else is
   * one kind's or the other's.
   *
   * `live` is the mode being ON — Select for a book, Blocks for a scan. The
   * category rows are a LEGEND as well as a control, so they are drawn either
   * way and only the clicking is gated, which is the rule this panel has always
   * followed.
   */
  protected readonly subject = computed<{ kind: 'epub' | 'pdf'; id: string; live: boolean } | null>(() => {
    const tab = this.tabs.activeDocument();
    if (tab === null) return null;
    if (tab.kind === 'epub' && tab.book !== null) {
      return { kind: 'epub', id: tab.id, live: tab.selectMode };
    }
    if (tab.kind === 'pdf' && tab.blockView) {
      // Live once the curation has been read, not merely once the mode is on:
      // the rows are clickable the instant they appear otherwise, and the first
      // click would land on an overlay this window has not seen yet.
      const view = this.tabs.blocksFor(tab.id);
      return { kind: 'pdf', id: tab.id, live: view !== null && view.overlay !== null };
    }
    return null;
  });

  protected readonly selected = computed(() =>
    this.tabs.selectionFor(this.subject()?.id ?? null));

  /**
   * How many blocks of each kind, from whichever side can count them.
   *
   * A book's come from the FRAME, because nothing outside a sandboxed iframe can
   * see into it. A scan's are derived by the service from data this window
   * already holds. Same shape, same rows, same swatches.
   */
  private readonly tally = computed(() => {
    const panel = this.subject();
    if (panel === null) return null;
    return panel.kind === 'epub'
      ? this.tabs.countsFor(panel.id)
      : this.tabs.blockCountsFor(panel.id);
  });

  /**
   * The rows, with this document's numbers when anything has counted them.
   *
   * `total` is NULL rather than 0 while nothing has, and the difference is worth
   * the extra state: a zero would be the panel asserting "this chapter has no
   * footnotes" when what it means is "nobody has counted". A category with a real
   * zero is drawn as a zero and its strike button is dead, which is honest.
   *
   * TWO VOCABULARIES, ONE SET OF COLOURS. A cast book's blocks are
   * `data-bf-cat="footnote"` and a scan's are the model's `Footnote`; the tables
   * are separate because they are the vocabularies of two different files, and
   * they share every colour because a person moving between the two panes is
   * reading one legend (shared/categories.ts).
   */
  protected readonly rows = computed<CategoryRow[]>(() => {
    const counted = this.tally();
    const table = this.subject()?.kind === 'pdf' ? PDF_BLOCK_CATEGORIES : BLOCK_CATEGORIES;
    return table.map((one) => ({
      id: one.id,
      label: one.label,
      colour: one.colour,
      note: one.note,
      total: counted === null ? null : counted.counts[one.id] ?? 0,
      struck: counted?.struck[one.id] ?? 0,
    }));
  });

  /**
   * Categories the chapter carries that this version has never heard of.
   *
   * Listed rather than dropped, and greyed rather than offered: the emitter may
   * grow a category before shared/categories.ts does, and a book with blocks the
   * inspector does not mention is a book with blocks nobody can account for.
   */
  protected readonly unknown = computed<{ id: string; total: number }[]>(() => {
    const counted = this.tally();
    if (counted === null) return [];
    const table = this.subject()?.kind === 'pdf' ? PDF_BLOCK_CATEGORIES : BLOCK_CATEGORIES;
    return Object.entries(counted.counts)
      .filter(([id, total]) => total > 0 && !table.some((one) => one.id === id))
      .map(([id, total]) => ({ id, total }));
  });

  constructor() {
    // The rename input exists only while a row is being renamed; the moment it
    // renders, the whole current label is selected so typing replaces it.
    effect(() => {
      const box = this.renameBox()?.nativeElement;
      if (box) {
        box.focus();
        box.select();
      }
    });

    /*
     * THE DRAFT FOLLOWS THE SELECTION, and this is the one effect in the panel
     * that would be a bug if it were missing. The textarea holds a correction
     * somebody is typing; clicking a different block while it has text in it
     * would leave those words in the box with a different block's name over
     * them, and pressing Apply would write one paragraph's correction onto
     * another paragraph — silently, and only in the books where somebody had
     * done the most work.
     */
    effect(() => {
      const words = this.reading();
      untracked(() => this.draft.set(words));
    });

    /*
     * THE HISTORY IS ASKED FOR WHEN THE PANEL LANDS ON A BOOK, and never again for
     * the same one: `ensure` is a no-op for a project already held or already in
     * flight, and everything after the first read arrives through
     * `projects:changed`, which is how anything in this window hears that a
     * project moved. Without this the section would be empty for a book opened
     * from Home until something else happened to it.
     */
    effect(() => { this.ledger.ensure(this.projectDir()); });
  }

  protected tallyTitle(row: CategoryRow): string {
    if (row.total === null) return '';
    const blocks = `${row.total} block${row.total === 1 ? '' : 's'} in this chapter`;
    return row.struck > 0 ? `${blocks}, ${row.struck} of them marked to be cut` : blocks;
  }

  protected strikeTitle(row: CategoryRow): string {
    if (row.total === null || row.total === 0) return 'Nothing of this kind in this chapter';
    return row.struck === row.total
      ? `Bring back all ${row.total} of them`
      : `Strike all ${row.total} of them in this chapter`;
  }

  /**
   * The two gestures, routed by what the panel is about.
   *
   * ONE PAIR OF BUTTONS OVER TWO KINDS OF DOCUMENT. A book's relabel is a message
   * into a sandboxed frame that rewrites an attribute; a scan's is a line of the
   * overlay. Neither of those belongs in a panel — the service owns both — and
   * the row does not need to know which it just fired.
   */
  protected relabel(category: string): void {
    if (this.subject()?.kind === 'pdf') this.tabs.relabelSelectedBlocks(category);
    else this.tabs.relabelSelected(category);
  }

  protected strike(category: string): void {
    if (this.subject()?.kind === 'pdf') this.tabs.strikeBlockCategory(category);
    else this.tabs.strikeCategory(category);
  }

  // ── The scan's chapters ──────────────────────────────────────────────────

  /** The spine as it stands, and whose it is. */
  protected readonly spine = computed(() => {
    const panel = this.subject();
    return panel === null || panel.kind !== 'pdf'
      ? { chapters: [] as readonly OverlayChapter[], confirmed: false }
      : this.tabs.chaptersFor(panel.id);
  });

  /**
   * The rows, each knowing whether the block it names is still on these pages.
   *
   * A CHAPTER WHOSE BLOCK IS GONE IS DRAWN, DIMMED, AND KEPT. The engine skips
   * such a location rather than refusing the run — a page taken out with
   * `--skip-pages`, a block struck since the chapter was made — so the app must
   * not refuse it either. Hiding the row would take somebody's chapter name off
   * the screen while leaving it in the file; drawing it as though it were fine
   * would promise a division the book is not going to have.
   */
  protected readonly chapterRows = computed<ChapterRow[]>(() => {
    const panel = this.subject();
    if (panel === null || panel.kind !== 'pdf') return [];
    return this.spine().chapters.map((one) => {
      const target = targetKey(one.at);
      return {
        target,
        title: one.title,
        where: `p${one.at.page}`,
        present: this.tabs.elementAt(panel.id, target) !== null,
      };
    });
  });

  /** The one block selected, or null for none and for several. */
  protected readonly onlyBlock = computed<BlockElement | null>(() => {
    const panel = this.subject();
    const picked = this.selected();
    if (panel === null || panel.kind !== 'pdf' || picked === null) return null;
    if (picked.blockIds.length !== 1) return null;
    return this.tabs.elementAt(panel.id, picked.blockIds[0]!);
  });

  protected onlyBlockIsChapter(): boolean {
    const block = this.onlyBlock();
    return block !== null && this.chapterRows().some((row) => row.target === block.key);
  }

  protected chapterAddTitle(): string {
    if (this.onlyBlock() === null) return 'Select one block on the page first';
    return this.onlyBlockIsChapter()
      ? 'A chapter already starts at that block'
      : 'The book divides at this block, and the contents lists it';
  }

  protected showBlock(target: string): void {
    const panel = this.subject();
    if (panel !== null && panel.kind === 'pdf') this.tabs.revealBlock(panel.id, target);
  }

  protected makeChapter(): void {
    const panel = this.subject();
    const block = this.onlyBlock();
    if (panel === null || panel.kind !== 'pdf' || block === null) return;
    /*
     * SEEDED WITH THE BLOCK'S OWN WORDS, which is right far more often than any
     * other guess and is exactly what the detection would have called it. It is
     * a starting point rather than a rule: the contents entry and the printed
     * heading are two statements — "IV" on the page and "Chapter 4 — The
     * Windmill" in the contents is correct and ordinary — so the row is
     * immediately renameable and the first line of the block is only what saves
     * somebody typing it.
     */
    const words = block.text.split('\n')[0]?.trim() ?? '';
    void this.tabs.addChapter(panel.id, block.key, words.slice(0, 120));
  }

  protected dropChapter(target: string): void {
    const panel = this.subject();
    if (panel !== null && panel.kind === 'pdf') void this.tabs.removeChapter(panel.id, target);
  }

  protected resetChapters(): void {
    const panel = this.subject();
    if (panel !== null && panel.kind === 'pdf') void this.tabs.resetChapters(panel.id);
  }

  protected startChapterRename(row: ChapterRow): void {
    // The double-click reaches this even with the pencil disabled, and a box that
    // opens, takes a new name and then refuses to keep it is a worse refusal than
    // one that never opened. The banner above already says why.
    if (this.frozen()) return;
    this.renameText.set(row.title);
    this.renamingHref.set(row.target);
  }

  protected commitChapterRename(target: string): void {
    const panel = this.subject();
    const label = this.renameText().trim();
    this.renamingHref.set(null);
    if (panel === null || panel.kind !== 'pdf' || label.length === 0) return;
    void this.tabs.renameChapter(panel.id, target, label);
  }

  // ── The one selected block's words ───────────────────────────────────────

  /**
   * The textarea's contents.
   *
   * A DRAFT RATHER THAN A LIVE BINDING, because a text override is a sentence
   * somebody is typing and every keystroke must not become a ledger action. It
   * is re-seeded by the effect below whenever the selection moves, so switching
   * blocks never leaves the previous one's words in the box — the one way this
   * design could write a correction onto the wrong block.
   */
  protected readonly draft = signal('');

  /** What the block says right now: the correction if there is one, else the model's. */
  protected readonly reading = computed(() => {
    const panel = this.subject();
    const block = this.onlyBlock();
    if (panel === null || panel.kind !== 'pdf' || block === null) return '';
    return this.tabs.decisionFor(panel.id, block).text ?? block.text;
  });

  protected corrected(): boolean {
    const panel = this.subject();
    const block = this.onlyBlock();
    if (panel === null || panel.kind !== 'pdf' || block === null) return false;
    return this.tabs.decisionFor(panel.id, block).text !== undefined;
  }

  protected applyWords(): void {
    const panel = this.subject();
    const block = this.onlyBlock();
    if (panel === null || panel.kind !== 'pdf' || block === null) return;
    const words = this.draft().trim();
    // Typing the model's own reading back is not a correction. It is written as
    // REMOVING the override rather than as an override that agrees, which is the
    // overlay's canonical rule reaching the button.
    void this.tabs.setBlockText(panel.id, block.key, words === block.text ? '' : words);
  }

  protected revertWords(): void {
    const panel = this.subject();
    const block = this.onlyBlock();
    if (panel === null || panel.kind !== 'pdf' || block === null) return;
    void this.tabs.setBlockText(panel.id, block.key, '');
  }

  // ── Contents ─────────────────────────────────────────────────────────────

  protected show(chapter: EpubChapter): void {
    const tab = this.book();
    if (tab) this.tabs.showChapter(tab.id, chapter.href);
  }

  protected startRename(chapter: EpubChapter): void {
    this.renameText.set(chapter.label);
    this.renamingHref.set(chapter.href);
  }

  protected cancelRename(): void {
    this.renamingHref.set(null);
  }

  /**
   * Enter. An empty or unchanged label is a cancel, not an error — and the box
   * closes BEFORE the IPC round trip so a slow disk never shows a stale input.
   * A refusal (main found nothing carrying the entry) lands in the notice strip
   * via TabsService.
   */
  protected async commitRename(chapter: EpubChapter): Promise<void> {
    const tab = this.book();
    const label = this.renameText().trim();
    this.renamingHref.set(null);
    if (!tab || label.length === 0 || label === chapter.label) return;
    await this.tabs.renameHeading(tab.id, chapter.href, label);
  }

  // ── Standing on ──────────────────────────────────────────────────────────

  /**
   * The project the focused document belongs to, or null for a file opened from
   * somewhere this app has never imported.
   *
   * THE STRIP IS ABOUT THE BOOK AND NOT ABOUT THE TAB, which is why this is a
   * separate question from `subject()`. A book's position is the same position
   * whether you are looking at the scan, at the flowing book cast from it or at
   * one of its translations — they are all one project — and a strip that came
   * and went with the mode a pane happens to be in would be a position that
   * belongs to a viewer rather than to a book.
   */
  protected readonly projectDir = computed<string | null>(() => {
    const tab = this.tabs.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    // A catalogue that will not parse has no history to draw and its refusal is
    // already on its row on Home. `ProjectsService` treats it as no project at
    // all for exactly this reason, and so does this.
    return project === null || project.problem !== null ? null : project.dir;
  });

  /** Main's sentence for a ledger it would not read, drawn under the strip. */
  protected readonly stepsProblem = computed<string | null>(() =>
    this.ledger.problemFor(this.projectDir()));

  /**
   * WHERE THIS BOOK IS STANDING, in one line.
   *
   * ── Why it says two things about a reading and one about everything else ────
   *
   * The library calls a read step "the Book", because in a tree of provenance
   * that is what the node IS — the flowing document you read, curate and
   * translate — and *"we shouldnt call the working files 'epub' until we
   * export"*. The step's own label says something else and something useful:
   * "Read (317 pages)", which is what was actually done and how much of it. A
   * strip that said only "Book" would leave somebody standing on one of two
   * readings with no way to tell which; one that said only "Read (317 pages)"
   * would name a row the panel beside it calls something different. So it says
   * both, in that order — the thing, then what was done to make it.
   *
   * THREE STATES THAT LOOK ALIKE AND ARE NOT: a ledger that refused to parse
   * (the sentence below the strip says which), a history still in flight, and a
   * book with a position. Saying "nowhere" while the answer is on its way would
   * be the panel asserting something it has not been told.
   */
  protected readonly standingName = computed<string>(() => {
    const dir = this.projectDir();
    if (dir === null) return '';
    if (this.ledger.problemFor(dir) !== null) return 'Nowhere';
    const step = this.ledger.standingIn(dir);
    if (step === null) return this.stepsRead() ? 'Nowhere' : 'Reading this book’s history…';
    return step.action === 'read' ? `Book · ${step.label}` : step.label;
  });

  /**
   * The strip on hover — the full timestamp, and where the rest of the story is.
   *
   * IT POINTS AT THE LIBRARY, because that is the panel that moves this. The
   * strip is a readout and deliberately not a control: one selector
   * (docs/WORKBENCH.md §6c), and it is on the left.
   */
  protected standingTitle(): string {
    const dir = this.projectDir();
    const step = dir === null ? null : this.ledger.standingIn(dir);
    if (step === null) return 'Where this book stands. Click a step in the library to move it.';
    return `${step.label} — ${new Date(step.createdAt).toLocaleString()}. This is what the panes `
      + 'show and what the next thing you do is made from. Click a step in the library to move it.';
  }

  /**
   * Why the block editor's controls are dead, or null — and IT IS ABOUT THE BLOCK
   * EDITOR AND NOTHING ELSE.
   *
   * A curation snapshot freezes the SCAN's overlay: strikes, categories, text
   * overrides and the chapters list, all of them lines in one file beside the
   * readings bank. An unpacked book's select mode writes somewhere else entirely —
   * `data-bf-cat` attributes inside somebody's chapter markup — and has no more to
   * do with a frozen curation than a translation does. So the banner is not drawn
   * and nothing is disabled beside a book, even when that book's project is
   * standing on a save: greying out the Category rows of an EPUB because a scan in
   * the same folder has a snapshot would be this panel refusing a gesture for a
   * reason that is not about it.
   */
  protected readonly lock = computed(() =>
    (this.subject()?.kind === 'pdf' ? this.ledger.lockIn(this.projectDir()) : null));

  /** True when a gesture in this panel would be refused for standing on a save. */
  protected readonly frozen = computed(() => this.lock() !== null);

  /** False only in the moment between the panel landing on a book and main answering. */
  protected readonly stepsRead = computed(() =>
    this.ledger.historyFor(this.projectDir()) !== null);

  /**
   * WHAT THIS PROJECT HOLDS THAT NO STEP OF IT DOES — the whole gate on Apply
   * changes, and null when there is nothing waiting.
   *
   * ── What it used to ask, and why that was the wrong question ────────────────
   *
   * The button here was offered over A SCAN BEING CORRECTED and nowhere else: it
   * needed the PDF in block view, because that was the only surface in the app
   * whose edits reached a curation. Everything a person did to the flowing book —
   * the document they actually read, and the one the OCR step now shows — wrote
   * their chapter and stopped, so the button they wanted was on the pane they
   * were not looking at, and would have had nothing of theirs to freeze if they
   * had found it.
   *
   * Those edits are decisions now (`mirrorToCuration`, tabs.service.ts), so the
   * question is no longer "which document is in front" but "is there anything
   * unapplied here", which is one answer for the whole project and true whichever
   * of its documents is on screen. Main measures it — the live curation against
   * the step the pointer stands at or behind — and it is why an empty answer can
   * hide the button honestly, where the old gate could not.
   *
   * NOT WHILE STANDING ON A SAVE. Correcting is refused at that position, on both
   * surfaces now, so a button that froze a copy of corrections nobody is allowed
   * to make would be offering to keep work the app has just declined to let
   * anybody do. The way back is the same as it has always been: click a row that
   * edits.
   */
  protected readonly unkept = computed<UncommittedCuration | null>(() => {
    const dir = this.projectDir();
    if (dir === null || this.ledger.lockIn(dir) !== null) return null;
    return this.tabs.uncommittedIn(dir);
  });

  /**
   * The one sentence under the button: what is waiting, and against what.
   *
   * NO FILENAMES AND NO NUMBERS THE USER CANNOT ACCOUNT FOR. `blocks` is main's
   * difference — blocks that stand differently now than in the last save — so it
   * is spoken as a count of changes rather than of anything on a disk, and the
   * save it is measured against is named by its own label when there is one.
   */
  protected applyLine(pending: UncommittedCuration): string {
    // Never both zero: main answers null when there is nothing at all, which is
    // the state this whole block is hidden in.
    const what = pending.blocks === 0
      ? 'Where the book divides'
      : `${pending.blocks === 1 ? '1 change' : `${pending.blocks} changes`}${
        pending.chapters ? ', and where the book divides,' : ''}`;
    return pending.since === null
      ? `${what} — not in this book’s history yet. Applying adds a step you can come back to.`
      : `${what} — changed since “${pending.since}”. Applying adds a step of its own.`;
  }

  /**
   * Apply: add what has been decided here to the history as a step. The refusal
   * for an empty one is main's.
   *
   * IT NAMES THE DOCUMENT IN FRONT, whichever kind that is, and not the panel's
   * `subject` — which is null for a book still opening and for a scan nobody has
   * pressed Blocks on, both of which are perfectly ordinary states to have
   * something to apply in. Main resolves either path to the one curation, so the
   * step is the same step whichever pane it was pressed from.
   */
  protected applyChanges(): void {
    const tab = this.tabs.activeDocument();
    if (tab !== null) void this.tabs.saveCorrections(tab.id);
  }
}

/** One drawn row of the Chapters section. */
interface ChapterRow {
  /** The overlay target — `page:order`. */
  target: string;
  title: string;
  /** `p12`, so a person can check the row against the page. */
  where: string;
  /** False when this reading has no such block. Drawn, dimmed, and kept. */
  present: boolean;
}

/** One drawn row of the Category section. */
interface CategoryRow {
  id: string;
  label: string;
  colour: string;
  note: string;
  /** How many of them this chapter holds, or null while nobody has counted. */
  total: number | null;
  /** How many of those are already marked to be cut. */
  struck: number;
}
