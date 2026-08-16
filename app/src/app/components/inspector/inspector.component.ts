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

import {
  BLOCK_CATEGORIES,
  PDF_BLOCK_CATEGORIES,
  UNKNOWN_CATEGORY_COLOUR,
  pdfCategoryLabel,
} from '@shared/categories';
import type { Replayed } from '@shared/ops';
import { targetKey, type OverlayChapter } from '@shared/overlay';
import type { EpubChapter, UncommittedCuration } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import {
  TabsService,
  type BlockElement,
  type BookStack,
  type ChapterMark,
} from '../../core/tabs.service';

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
    @if (subject() !== null || projectDir() !== null || sheet() !== null) {
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
          ── THE PROOF SHEET'S THREE PANELS ──────────────────────────────────

          Chapters, Notes and Furniture review, drawn for a book pane and for
          nothing else (RENDERER-DESIGN.md §5: the panels live in the app shell
          and keep its dark style — the paper vocabulary stays on the paper). They
          are sections of THIS panel rather than chrome of their own, in the
          accordion the two below them established, because a book pane's
          inspector and a scan's must read as one instrument with different things
          to say.

          THE RUNNING ORDER IS THE PANEL'S: divisions first, exactly where the
          Chapters section sits for every other kind of document, then the two
          that are new. A book tab and a scan tab never draw both sets — \`sheet\`
          is a book pane and \`subject\` is never one — so nothing here overtakes
          anything there.

          EVERY ROW IS READ OUT OF THE PANE'S OWN REPLAY and every button pushes
          onto the pane's own stack (\`BookStack\`, core/tabs.service.ts). This
          component holds no copy of the book, no list of ops and no idea where
          any of it is kept: undo, redo and Apply take a decision made here back
          exactly as they take one made on the paper, because there is one stack.
        -->
        @if (sheet(); as pane) {
          <section class="accordion" [class.shut]="!chaptersOpen()">
            <button class="head" (click)="chaptersOpen.set(!chaptersOpen())">
              <span class="twist">{{ chaptersOpen() ? '▾' : '▸' }}</span>
              <span class="label">Chapters</span>
              <span class="count">{{ sheetChapters().length }}</span>
            </button>
            @if (chaptersOpen()) {
              <div class="body">
                <!--
                  WHOSE LIST THIS IS, said before anything is clicked — the same
                  sentence the scan's section says, because it is the same rule:
                  the first chapter op takes the list over and "Use Foundry's" is
                  the op that hands it back. It is a fact about the chain,
                  recomputed every replay, so it cannot drift.
                -->
                <p class="hint">
                  @if (pane.chaptersOwned()) {
                    These are your chapters. The book divides here and nowhere else.
                  } @else {
                    These are the chapters Foundry found. Change any of them and the list
                    becomes yours — from then on the book divides exactly where it says.
                  }
                </p>
                <ul>
                  @for (row of sheetChapters(); track row.id) {
                    <li class="entry">
                      @if (renamingHref() === row.id) {
                        <input
                          #renameBox
                          class="rename"
                          [value]="renameText()"
                          (input)="renameText.set(renameBox.value)"
                          (keydown.enter)="commitSheetRename(row.id)"
                          (keydown.escape)="cancelRename()"
                          (blur)="cancelRename()"
                          [attr.aria-label]="'Rename ' + row.title"
                        >
                      } @else {
                        <button
                          class="chapter"
                          [title]="row.title"
                          (click)="pane.reveal(row.id)"
                          (dblclick)="startSheetRename(row)"
                        >
                          <span class="ch-title">{{ row.title }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </button>
                        <button class="pencil" title="Rename" (click)="startSheetRename(row)">✎</button>
                        <button
                          class="pencil"
                          title="Take the division away — the block stays, the rule goes"
                          (click)="dropSheetChapter(row.id)"
                        >✕</button>
                      }
                    </li>
                  }
                  @if (sheetChapters().length === 0) {
                    <li class="none">This book does not divide: it reads as one run of prose.</li>
                  }
                </ul>
                <div class="acts">
                  <!--
                    "HERE" IS THE BLOCK PICKED ON THE PAPER, which is the one thing
                    the panel cannot say for itself and the one thing it reads off
                    the pane. Setting a division is the panel's gesture for that
                    reason: the chip on the sheet renames what is already there,
                    and creating one needs a block somebody has pointed at.
                  -->
                  <button
                    class="act"
                    [disabled]="!canDivide()"
                    [title]="divideTitle()"
                    (click)="makeSheetChapter()"
                  >Chapter starts here</button>
                  <button
                    class="act"
                    [disabled]="!pane.chaptersOwned()"
                    title="Throw this list away and let Foundry work the chapters out again"
                    (click)="resetSheetChapters()"
                  >Use Foundry's</button>
                </div>
              </div>
            }
          </section>

          <!--
            ── Notes — every note, and both directions of the one flag ─────────

            The apparatus, listed in reading order, with the two LINKING flags the
            app still keeps (docs/RENDERER.md §0, ruling 7): a number in the body
            that no note carries, and a note nothing in the body points at. The
            first of those is the only list in this panel that is not a list of
            rows — a loose marker is characters inside a block — and it sits at the
            top because it is the half a person has to act on.

            LINKING IS TWO CLICKS AND NO DRAG. Click the number, then click the
            note it belongs to; the second click is the op. A drag between two
            lists in a 260px column is a gesture that needs autoscroll to reach
            most of its targets, and this needs none.
          -->
          <section class="accordion" [class.shut]="!notesOpen()">
            <button class="head" (click)="notesOpen.set(!notesOpen())">
              <span class="twist">{{ notesOpen() ? '▾' : '▸' }}</span>
              <span class="label">Notes</span>
              <span class="count">{{ notes().length }}</span>
              <!--
                THE FLAG COUNT IS ITS OWN BADGE and it is only there when it is
                nonzero — §5's *"Flag counts in --ink-flag when nonzero"*, read as
                a count OF flags rather than as the notes count wearing a colour.
                Both directions are in it, because they are one flag seen from
                either end and a person opening the section finds them separated.
              -->
              @if (unlinked(); as flagged) {
                <span
                  class="count flagged"
                  title="Reference numbers with no note, and notes nothing points at"
                >{{ flagged }} unlinked</span>
              }
            </button>
            @if (notesOpen()) {
              <div class="body">
                <p class="hint">
                  @if (linkingRow() !== null) {
                    Now click the note this number belongs to. Click the number again to
                    leave it unbound.
                  } @else if (looseMarkers().length > 0) {
                    The numbers above carry nothing yet. Click one, then click its note.
                  } @else {
                    Every note in the book, in reading order. Click one to go to it.
                  }
                </p>
                @if (looseMarkers().length > 0) {
                  <ul>
                    @for (row of looseMarkers(); track row.key) {
                      <li class="entry flagged">
                        <button
                          class="chapter"
                          [class.active]="linking() === row.key"
                          [title]="'No note carries this number, printed in ' + row.words"
                          (click)="startLink(row)"
                        >
                          <span class="ord flag">{{ row.printed }}</span>
                          <span class="ch-title">{{ row.words }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </button>
                      </li>
                    }
                  </ul>
                }
                <ul>
                  @for (row of notes(); track row.id) {
                    <li class="entry" [class.flagged]="row.orphan">
                      <button
                        class="chapter"
                        [title]="row.orphan
                          ? 'Nothing in the book carries this note'
                          : row.words"
                        (click)="tapNote(row)"
                      >
                        <span class="ord" [class.flag]="row.orphan">{{ row.ordinal }}</span>
                        <span class="ch-title">{{ row.words }}</span>
                        <span class="ch-at">≈ {{ row.page }}</span>
                      </button>
                    </li>
                  }
                  @if (notes().length === 0) {
                    <li class="none">Nothing at the foot of a page in this book.</li>
                  }
                </ul>
              </div>
            }
          </section>

          <!--
            ── Furniture review — the shelf, made visible ──────────────────────

            *"nothing the model answered is silently gone"* (docs/BOOK-FILE.md §5).
            The reflow takes running heads, folios and page furniture out of the
            flow and keeps them as rows at their reading-order positions wearing a
            sentence of evidence; until now that sentence was a log line nobody
            could act on. Each of them is a row here with its own why under it and
            one verb beside it, and restoring one puts it back exactly where it was
            printed — the position is not a guess, which is why the op has none to
            make.
          -->
          <section class="accordion" [class.shut]="!furnitureOpen()">
            <button class="head" (click)="furnitureOpen.set(!furnitureOpen())">
              <span class="twist">{{ furnitureOpen() ? '▾' : '▸' }}</span>
              <span class="label">Furniture</span>
              <span class="count">{{ furniture().length }}</span>
            </button>
            @if (furnitureOpen()) {
              <div class="body">
                <p class="hint">
                  What the reflow took out of the book — running heads and the page's own
                  furniture. Nothing is lost: restore one and it goes back where it was
                  printed.
                </p>
                <ul>
                  @for (row of furniture(); track row.id) {
                    <li class="entry shelved">
                      <div class="shelf">
                        <div class="shelf-line">
                          <span class="ord">{{ row.label }}</span>
                          <span class="ch-title">{{ row.words }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </div>
                        <p class="shelf-why">{{ row.why }}</p>
                      </div>
                      <button
                        class="pencil"
                        title="Put this row back in the book"
                        (click)="restoreShelved(row.id)"
                      >↺</button>
                    </li>
                  }
                  @if (furniture().length === 0) {
                    <li class="none">The reflow took nothing out of this book.</li>
                  }
                </ul>
              </div>
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
        <!--
          ── The chapters — ONE SECTION, because it was one question ────────────

          THERE USED TO BE A "CONTENTS" ABOVE THIS ONE and it was the same list
          twice. It drew the cast EPUB's nav — a table of contents minted out of
          these very chapters at the moment the book was rendered — while this
          section drew the chapters themselves. Two rows per division, in two
          places, one of them read out of a file this app throws away and remakes:
          *"whats the difference between 'chapters' and 'contents'? should those
          be one unit?"* — *"correct. should be the same unit: chapters."*

          The user's earlier ruling is what settles which survives: *"that dotted
          line is the definitive chapter info for the book."* A cast's nav is
          downstream of the lines, so a panel offering both was offering the
          record and its own photocopy, and letting a person rename the photocopy.

          WHAT THE ROWS ARE READ OFF IS A PROPERTY OF THE BOOK, asked directly —
          see \`divisions\`. A book this app has read has a spine of markers, which
          is the record. A book somebody imported whole has no bank, nothing to
          key a marker to, and its own table of contents is the only statement of
          its divisions that exists. That is a choice between two kinds of
          document, made on which kind it is; it is emphatically not a list
          reached for because another one came back empty.
        -->
        <section class="accordion" [class.shut]="!chaptersOpen()">
            <button class="head" (click)="chaptersOpen.set(!chaptersOpen())">
              <span class="twist">{{ chaptersOpen() ? '▾' : '▸' }}</span>
              <span class="label">Chapters</span>
              <span class="count">{{ chapterCount() }}</span>
            </button>
            @if (chaptersOpen()) {
              <div class="body">
                <!--
                  The book's own name, which came up here with the Contents
                  section and stays: it is the one line in the panel that says
                  WHICH book all of this is about, and the panel is otherwise a
                  set of controls with no subject written on them.
                -->
                @if (book(); as current) {
                  <div class="about">
                    <span class="book-title" [title]="current.book.title">{{ current.book.title }}</span>
                    @if (current.book.author) {
                      <span class="book-author">{{ current.book.author }}</span>
                    }
                  </div>
                }

                @if (divisions() === 'book') {
                  @if (book(); as current) {
                    <!--
                      WHOSE LIST THIS IS, in the state where it is not Foundry's.
                      Saying so matters more here than anywhere: none of the
                      controls below appear, and a section that silently dropped
                      its buttons would read as broken rather than as inapplicable.
                    -->
                    <p class="hint">
                      These are the book's own chapters, as it lists them. Nothing here has read
                      this book, so Foundry has no chapters of its own to offer — read it and the
                      list becomes one you can move, rename and cut.
                    </p>
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
                            ><span class="ch-title">{{ chapter.label }}</span></button>
                            <button class="pencil" title="Rename" (click)="startRename(chapter)">✎</button>
                          }
                        </li>
                      }
                      @if (current.book.chapters.length === 0) {
                        <li class="none">This book lists no chapters of its own.</li>
                      }
                    </ul>
                  }
                } @else {
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
                          [title]="row.present ? row.title : row.title + ' — the block it starts at is not in this rendering'"
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
                  <!--
                    ADDING ONE IS A BUTTON ON BOTH SURFACES NOW, and they mean
                    two different things by "here".

                    Over a scan, "here" is the one block a person has selected on
                    the pages, and the press adds it there and then.

                    Over the flowing book, "here" is a seam the reader is about
                    to point at, so the press does not add anything — it turns
                    ADD CHAPTER ON, the next click in the book places the line,
                    and the mode is over. That is the user's own sequence
                    (2026-08-15): \`press the button, pick where it goes, and it
                    exits chapter mode\`. It replaces a gutter that lit up under
                    any passing pointer, which is a tool grabbing at somebody who
                    was only reading.
                  -->
                  @if (panel.kind === 'pdf') {
                    <button
                      class="act"
                      [disabled]="onlyBlock() === null || onlyBlockIsChapter() || frozen()"
                      [title]="chapterAddTitle()"
                      (click)="makeChapter()"
                    >Chapter starts here</button>
                  } @else {
                    <button
                      class="act"
                      [class.armed]="addingChapter()"
                      [disabled]="frozen()"
                      [title]="addingChapter()
                        ? 'Click in the book to place it, or press Escape to stop'
                        : 'Then click in the book where the chapter starts'"
                      (click)="toggleAddChapter()"
                    >{{ addingChapter() ? 'Click where it starts…' : 'Add chapter' }}</button>
                  }
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
                @if (panel.kind === 'epub') {
                  <p class="hint">
                    On the book, a chapter is the green dotted line. Drag one to move it,
                    double-click it to rename it, or drop it on the ✕ to remove it.
                  </p>
                }
                }
              </div>
            }
          </section>

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
    /*
      THE ONE PAPER TOKEN THE SHELL BORROWS. RENDERER-DESIGN.md §5 keeps the
      panels in the app's dark style and asks for exactly one thing from the
      sheet's palette: *"Flag counts in --ink-flag when nonzero."* It is copied
      from §1 verbatim rather than approximated with the app's warning colour,
      because the amber a person learns in the book's right-hand gutter and the
      amber on the Notes count are one statement — something here needs a
      decision — and two ambers would be two statements.
    */
    :host {
      --ink-flag: #b98a1c;

      display: block;
      width: 260px;
      min-width: 260px;
      height: 100%;
    }

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

    /* ── The proof sheet's three sections ──────────────────────────────────── */

    /*
      THE COUNT GOES AMBER WHEN SOMETHING IN THE SECTION NEEDS A DECISION, and it
      is still the same quiet badge — §5 asks for a colour, not for a second kind
      of badge, and this app does not put numbers in red circles.
    */
    .count.flagged { color: var(--ink-flag); }

    /*
      THE ORDINAL, or the kind of thing a shelved row is. It is the leading mark
      of a row the way the sienna ordinal is the leading mark of a note in the
      book's gutter, and it holds a fixed width so that twenty rows read as a
      column rather than as twenty different indents.
    */
    .ord {
      flex: 0 0 auto;
      min-width: 1.6em;
      color: var(--text-tertiary);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .ord.flag { color: var(--ink-flag); }

    /*
      A ROW WITH A FLAG ON IT — dotted, in the amber, exactly as the marker and
      the note wear it on the paper. Underline rather than a background, because
      a list where the interesting rows are tinted becomes a list nobody can read
      the ordinary rows in.
    */
    .entry.flagged .ch-title {
      text-decoration: underline dotted var(--ink-flag);
      text-underline-offset: 0.2em;
    }

    /* The armed loose marker wears \`.chapter.active\`, which is already the panel's
       word for "this is the row you are on" — one vocabulary, stated once above. */

    /* A shelved row is two lines — what it is and where, then the evidence. */
    .entry.shelved { align-items: flex-start; }
    .shelf { flex: 1; min-width: 0; margin: 0 6px; padding: 6px 10px; }
    .shelf-line { display: flex; align-items: baseline; gap: 6px; }
    .shelf-line .ch-title { color: var(--text-secondary); font-size: 12px; }
    .shelf-why {
      margin: 2px 0 0;
      color: var(--text-tertiary);
      font-size: 10px; line-height: 1.4;
    }
    .entry.shelved .pencil { margin-top: 6px; }

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
    /*
     * ARMED — the button holding a mode open. It wears the chapter line's own
     * green, because it is the same statement in two places: the dotted line is
     * green, the button that places one is green while it is waiting, and the
     * cursor over the book is a crosshair. Three signs of one mode, which is
     * what a mode with no window of its own needs to not be invisible.
     */
    .act.armed, .act.armed:hover:not(:disabled) {
      background: #2f7d4f; border-color: #2f7d4f; color: #fff;
    }

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
  protected readonly categoryOpen = signal(true);
  protected readonly chaptersOpen = signal(true);
  protected readonly blockOpen = signal(true);
  /** The proof sheet's two new sections. Open by default, for the reason above. */
  protected readonly notesOpen = signal(true);
  protected readonly furnitureOpen = signal(true);

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

  // ── The chapters — one spine, two projections ────────────────────────────
  //
  // ── The list beside the lines ───────────────────────────────────────────────
  //
  // This section used to be the SCAN's and only the scan's, because the overlay's
  // chapters spine could only be edited over the pages the block editor drew. The
  // flowing book draws the same spine as green dotted lines you can drag, rename
  // and delete (app-epub-view, electron/click-reporter.ts), and the user's ruling
  // is that the line IS the record: *"that dotted line is the definitive chapter
  // info for the book."*
  //
  // So the section survives as THE LIST VIEW OF THE SAME THING. Sixty chapters
  // read as a list in a way they never read as sixty lines a scroll apart, and
  // renaming the eleventh from here beats scrolling to it. One signal source —
  // whichever surface is in front, the rows and the lines are read off one file
  // and written through one door — so the two cannot disagree.
  //
  // WHAT DIFFERS BETWEEN THE TWO IS ONLY HOW A ROW IS ADDRESSED. A scan's spine
  // entry names a block the service itself is drawing, so the panel can reach it
  // directly. A book's names a banked answer, which the service has already
  // resolved to a document and an element for the lines' sake — so the panel
  // reads that resolution rather than doing its own.

  /**
   * WHOSE ACCOUNT OF THE DIVISIONS THIS SECTION IS DRAWING — asked of the
   * document, not of a list's length.
   *
   *   `scan`    — a PDF in block view. The rows are the curation's chapters and
   *               the block a person has selected is where a new one goes.
   *   `foundry` — a book this app read. The rows are the marker spine, which the
   *               user ruled is the definitive record, and every control applies.
   *   `book`    — a book somebody imported whole. There is no bank, so there is
   *               nothing to key a marker to and no marker list to draw; what the
   *               book says about itself is the only account there is.
   *
   * `null` COVERS TWO STATES AND MUST: no document, and a book whose overlay has
   * not come back yet. Drawing the book's own contents in the second would flash
   * the wrong list over every Foundry book on open, which is exactly the bug
   * `BookSpine.banked` exists to make impossible.
   */
  protected readonly divisions = computed<'scan' | 'foundry' | 'book' | null>(() => {
    const panel = this.subject();
    if (panel === null) return null;
    if (panel.kind === 'pdf') return 'scan';
    const spine = this.tabs.bookSpineFor(panel.id);
    if (spine === null) return null;
    return spine.banked ? 'foundry' : 'book';
  });

  /** The number beside the section head, off whichever list is being drawn. */
  protected readonly chapterCount = computed<number>(() =>
    (this.divisions() === 'book'
      ? this.book()?.book.chapters.length ?? 0
      : this.spine().chapters.length));

  /** The spine as it stands, and whose it is. */
  protected readonly spine = computed(() => {
    const panel = this.subject();
    if (panel === null) return { chapters: [] as readonly OverlayChapter[], confirmed: false };
    if (panel.kind === 'pdf') return this.tabs.chaptersFor(panel.id);
    const book = this.tabs.bookSpineFor(panel.id);
    return book === null
      ? { chapters: [] as readonly OverlayChapter[], confirmed: false }
      : { chapters: book.chapters, confirmed: book.confirmed };
  });

  /** The book's spine with each entry already resolved to a document and an element. */
  private readonly bookMarks = computed<readonly ChapterMark[]>(() => {
    const panel = this.subject();
    if (panel === null || panel.kind !== 'epub') return [];
    return this.tabs.bookSpineFor(panel.id)?.marks ?? [];
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
   *
   * The same rule reads the same way on the book, where "gone" means this cast
   * of it does not render the banked answer the chapter is keyed to — a struck
   * block, a page dropped — and the row is dimmed rather than dropped for the
   * identical reason: the name is still in the file.
   */
  protected readonly chapterRows = computed<ChapterRow[]>(() => {
    const panel = this.subject();
    if (panel === null) return [];
    if (panel.kind === 'epub') {
      return this.bookMarks().map((one) => ({
        target: one.target,
        title: one.title,
        where: `p${one.target.split(':')[0] ?? ''}`,
        present: one.blockId !== null,
      }));
    }
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

  /**
   * Put a chapter in front of the reader.
   *
   * ONE SIGNAL, TWO SURFACES: `revealBlock` names a document and a banked answer
   * and lets whichever pane is drawing that document do the moving. Over a scan
   * that is a jump to the page the block is on; over the flowing book it is a
   * SCROLL — §11's "the accordion's jump to chapter becomes a scroll-to" — and
   * the viewer resolves the answer to an element through the spine it already
   * holds. Neither is this panel's business beyond saying which chapter.
   */
  protected showBlock(target: string): void {
    const panel = this.subject();
    if (panel !== null) this.tabs.revealBlock(panel.id, target);
  }

  /**
   * Which document and element a book's chapter row addresses, or null.
   *
   * The book's ops are keyed by `data-bf-id` — the only name a sandboxed frame
   * can speak, and therefore the name the service's marker door takes. A row
   * whose block this cast does not render has none, and every gesture on it is
   * refused here rather than sent and dropped: renaming a chapter the book
   * cannot show is a real thing to want, but it is not a thing this door can do,
   * and the row already says so by being dimmed.
   */
  private markAt(target: string): ChapterMark | null {
    const found = this.bookMarks().find((one) => one.target === target);
    return found !== undefined && found.blockId !== null && found.member !== null ? found : null;
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
    if (panel === null) return;
    if (panel.kind === 'pdf') {
      void this.tabs.removeChapter(panel.id, target);
      return;
    }
    const mark = this.markAt(target);
    if (mark !== null) void this.tabs.removeChapterMark(panel.id, mark.blockId!, mark.member!);
  }

  protected resetChapters(): void {
    const panel = this.subject();
    if (panel === null) return;
    if (panel.kind === 'pdf') void this.tabs.resetChapters(panel.id);
    else void this.tabs.resetBookSpine(panel.id);
  }

  /** True while this book is waiting for a click to say where a chapter starts. */
  protected readonly addingChapter = computed(() => {
    const panel = this.subject();
    return panel !== null && panel.kind === 'epub' && this.tabs.chapterModeOn(panel.id);
  });

  /**
   * Add chapter — on, or off again.
   *
   * A TOGGLE AND NOT A ONE-WAY SWITCH, because a mode a person can enter and
   * cannot leave is the worse version of the hover this replaces: that at least
   * ended when the pointer moved away. Pressing it again is a cancel, and so is
   * Escape in the book, and so is placing the line.
   */
  protected toggleAddChapter(): void {
    const panel = this.subject();
    if (panel === null || panel.kind !== 'epub') return;
    this.tabs.toggleChapterMode(panel.id);
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
    if (panel === null || label.length === 0) return;
    if (panel.kind === 'pdf') {
      void this.tabs.renameChapter(panel.id, target, label);
      return;
    }
    const mark = this.markAt(target);
    if (mark !== null) void this.tabs.renameChapterMark(panel.id, mark.blockId!, mark.member!, label);
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

  // ── A book's own chapters — the `divisions() === 'book'` rows ─────────────
  //
  // These three used to serve a Contents section of their own. That section is
  // gone (see the template's Chapters block) and they are not: for a book this
  // app never read, the book's table of contents IS its chapter list, and these
  // are how a row of it is jumped to and renamed. Both gestures address a nav
  // entry by href, which is the only name such a book has for a division —
  // there is no banked answer under it to key a marker to.

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

  // ── The proof sheet's panels: Chapters, Notes, Furniture review ──────────
  //
  // Three sections about one book, and none of them holds any of it. The book
  // pane registers itself with the service as a `BookStack`; what this half of
  // the component does is read that pane's own replay and push ops onto that
  // pane's own stack. Nothing here is persisted, nothing here goes over IPC, and
  // there is no second account of the document anywhere in it — which is the
  // whole of why the panels can live in the shell (RENDERER-DESIGN.md §5) while
  // the ops go on living in the pane that draws them.

  /** The book pane in front, or null for every other kind of document. */
  protected readonly sheet = computed<BookStack | null>(() => {
    const tab = this.tabs.activeDocument();
    return tab === null || tab.kind !== 'book' ? null : this.tabs.bookStackFor(tab.id);
  });

  /**
   * The book as that pane is drawing it — the file with the chain and the
   * unapplied stack replayed over it, and null while it is still opening.
   *
   * THE PENDING VIEW AND NOT THE FILE. A panel drawing what is on disk would
   * disagree with the paper the moment somebody struck a note, and the person
   * would be looking at two answers to one question with no way to tell which
   * was stale.
   */
  private readonly sheetView = computed<Replayed | null>(() => this.sheet()?.view() ?? null);

  /**
   * Where the book divides, in reading order — the replay's answer.
   *
   * ALREADY FILTERED TO WHAT IS DRAWABLE (`Replayed.chapters`), so a division
   * above a block a merge consumed is not in this list and there is no dimmed
   * row here of the kind the scan's section keeps. The two are different facts:
   * a scan's chapter names a banked answer this RENDERING may not show, and is
   * kept because the name is still in the file; this list is the file, so a
   * division that is not in it is a division that is not.
   */
  protected readonly sheetChapters = computed<SheetChapterRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const where = new Map(replayed.rows.map((row) => [row.id, row.pages[0] ?? row.page] as const));
    return replayed.chapters.map((one) => ({
      id: one.id,
      title: one.title,
      page: where.get(one.id) ?? 0,
    }));
  });

  /** Every note in the book, in reading order, each knowing whether anything points at it. */
  protected readonly notes = computed<NoteRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const orphans = new Set(replayed.loose.notes);
    const out: NoteRow[] = [];
    for (const row of replayed.rows) {
      // The shelf is not the book, and a note is never on it.
      if (row.shelf !== undefined || row.category !== 'Footnote') continue;
      out.push({
        id: row.id,
        // The engine counts a note's place on its page from zero and the page
        // prints it from one, which is the pane's own arithmetic for the sienna
        // ordinal in the gutter.
        ordinal: (row.note ?? 0) + 1,
        words: opening(row.text),
        page: row.pages[0] ?? row.page,
        orphan: orphans.has(row.id),
      });
    }
    return out;
  });

  /**
   * The reference numbers in the body that no note carries.
   *
   * NOT ROWS. A loose marker is a run of characters inside a block — a block,
   * an offset and a length — so it is listed by the words it is printed in and
   * by the number the page shows, and its identity is the three coordinates
   * together. That key is what the linking state is held by, so a marker the
   * replay re-derives away while somebody is choosing simply stops being armed.
   */
  protected readonly looseMarkers = computed<LooseRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const held = new Map(replayed.rows.map((row) => [row.id, row] as const));
    const order = new Map(replayed.rows.map((row, at) => [row.id, at] as const));
    return [...replayed.loose.markers]
      .sort((one, other) =>
        (order.get(one.block) ?? 0) - (order.get(other.block) ?? 0) || one.at - other.at)
      .map((marker) => {
        const row = held.get(marker.block);
        return {
          key: `${marker.block}|${marker.at}|${marker.len}`,
          block: marker.block,
          at: marker.at,
          len: marker.len,
          printed: marker.printed,
          words: opening(row?.text ?? ''),
          page: row === undefined ? 0 : row.pages[0] ?? row.page,
        };
      });
  });

  /** Both directions of the one flag, counted for the badge. */
  protected readonly unlinked = computed<number>(() => {
    const replayed = this.sheetView();
    return replayed === null ? 0 : replayed.loose.markers.length + replayed.loose.notes.length;
  });

  /** Every row the reflow took out of the book, at its reading-order position. */
  protected readonly furniture = computed<ShelvedRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const out: ShelvedRow[] = [];
    for (const row of replayed.rows) {
      if (row.shelf === undefined) continue;
      out.push({
        id: row.id,
        label: pdfCategoryLabel(row.category),
        // Every shelved row carries one, by the file format's own rule; the
        // empty string is what a book written by something older would leave,
        // and an empty line is better than a sentence this panel invented.
        why: row.why ?? '',
        words: opening(row.text),
        page: row.pages[0] ?? row.page,
      });
    }
    return out;
  });

  /**
   * The loose marker whose note the next click chooses, by key.
   *
   * A KEY AND NOT THE ROW. The rows are recomputed on every push, and a held
   * object would go on naming a marker the replay has since bound or re-derived
   * away — which is a link op minted against coordinates that have moved.
   */
  protected readonly linking = signal<string | null>(null);

  /** That marker, if it is still loose. Null the moment it stops being. */
  protected readonly linkingRow = computed<LooseRow | null>(() => {
    const key = this.linking();
    return key === null ? null : this.looseMarkers().find((row) => row.key === key) ?? null;
  });

  /** Arm a number for linking, or put it down again. */
  protected startLink(row: LooseRow): void {
    this.linking.set(this.linking() === row.key ? null : row.key);
  }

  /**
   * A note row, clicked — which means one of two things and says which in the
   * hint before it is clicked.
   *
   * With a number armed it is the LINK: the number in the body stops being a
   * number nothing carries and the note stops being a note nothing points at,
   * both from one decision, which is what `link` is for. With nothing armed it
   * is the jump — the pane's own scroll-and-pulse, so that clicking a note in a
   * list of eighty puts it in front of the reader on the paper.
   */
  protected tapNote(row: NoteRow): void {
    const pane = this.sheet();
    if (pane === null) return;
    const picked = this.linkingRow();
    if (picked === null) {
      pane.reveal(row.id);
      return;
    }
    this.linking.set(null);
    pane.push([{ op: 'link', block: picked.block, at: picked.at, len: picked.len, note: row.id }]);
  }

  /** Put a shelved row back in the book, where it was printed. */
  protected restoreShelved(id: string): void {
    this.sheet()?.push([{ op: 'restore-furniture', id }]);
  }

  /**
   * The one block picked on the paper, when exactly one is and it is in the flow.
   *
   * A DIVISION SITS ABOVE A BLOCK, so a shelved row cannot carry one — the
   * replay would refuse it into `missing`, where nothing can clear it, and a
   * button that mints such an op is a button that files a complaint against the
   * person who pressed it.
   */
  private readonly divideAt = computed(() => {
    const pane = this.sheet();
    const replayed = this.sheetView();
    if (pane === null || replayed === null) return null;
    const picked = [...pane.selected()];
    if (picked.length !== 1) return null;
    const row = replayed.rows.find((one) => one.id === picked[0]);
    return row === undefined || row.shelf !== undefined ? null : row;
  });

  protected canDivide(): boolean {
    const row = this.divideAt();
    return row !== null && !this.sheetChapters().some((one) => one.id === row.id);
  }

  protected divideTitle(): string {
    const row = this.divideAt();
    if (row === null) return 'Pick one block on the page first';
    return this.sheetChapters().some((one) => one.id === row.id)
      ? 'A chapter already starts at that block'
      : 'The book divides at this block, and the contents lists it';
  }

  /**
   * "Chapter starts here", over the block picked on the paper.
   *
   * SEEDED WITH THE BLOCK'S OWN FIRST LINE, which is what the scan's version of
   * this button does and for its reason: it is right far more often than any
   * other guess, it is exactly what the detection would have called it, and it is
   * a starting point rather than a rule — the row is renameable the moment it
   * appears, because the contents entry and the printed heading are two
   * statements and a book is allowed to disagree with itself about them.
   */
  protected makeSheetChapter(): void {
    const pane = this.sheet();
    const row = this.divideAt();
    if (pane === null || row === null || !this.canDivide()) return;
    const words = row.text.split('\n')[0]?.trim() ?? '';
    pane.push([{ op: 'chapter', set: row.id, title: words.slice(0, 120) }]);
  }

  protected startSheetRename(row: SheetChapterRow): void {
    this.renameText.set(row.title);
    this.renamingHref.set(row.id);
  }

  /**
   * Enter in the rename box. An empty or unchanged name is a cancel, which is
   * the box's own rule everywhere else in this panel — and here it also keeps
   * the paper's promise that a chapter chip always has something on it to
   * double-click.
   */
  protected commitSheetRename(id: string): void {
    const pane = this.sheet();
    const label = this.renameText().trim();
    const row = this.sheetChapters().find((one) => one.id === id);
    this.renamingHref.set(null);
    if (pane === null || label.length === 0 || label === row?.title) return;
    pane.push([{ op: 'chapter', rename: id, title: label }]);
  }

  /** The block stays; the rule goes. */
  protected dropSheetChapter(id: string): void {
    this.sheet()?.push([{ op: 'chapter', remove: id }]);
  }

  /**
   * The way back — one op, so Ctrl+Z brings the person's own list back.
   *
   * Only offered while the ops own the list, because a reset over a seed already
   * in force is a change that changes nothing and would still be a row in
   * somebody's history.
   */
  protected resetSheetChapters(): void {
    const pane = this.sheet();
    if (pane === null || !pane.chaptersOwned()) return;
    pane.push([{ op: 'chapter', reset: true }]);
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

/** One drawn row of the proof sheet's Chapters section. */
interface SheetChapterRow {
  /** The block the division sits above — the id every chapter op is keyed to. */
  id: string;
  title: string;
  /** The source page it opens on, drawn with the ≈ the book's own ghosts wear. */
  page: number;
}

/** One drawn row of the Notes section — a note at the foot of a page. */
interface NoteRow {
  id: string;
  /** Which note of its page this is, counted from one. */
  ordinal: number;
  words: string;
  page: number;
  /** True when nothing in the body points at it — one of the two linking flags. */
  orphan: boolean;
}

/** One drawn row of the numbers in the body that no note carries. */
interface LooseRow {
  /** Block, offset and length together — the only identity a marker has. */
  key: string;
  block: string;
  at: number;
  len: number;
  /** The number the page printed, which is what a person matches a note by. */
  printed: number;
  /** The opening of the block it is printed in, so the row can be found. */
  words: string;
  page: number;
}

/** One drawn row of the Furniture review — a row the reflow took out of the book. */
interface ShelvedRow {
  id: string;
  /** What kind of block the model said it was. */
  label: string;
  /** The reflow's own sentence of evidence for taking it out. */
  why: string;
  words: string;
  page: number;
}

/**
 * The opening of a block's words, for a row in a 260px column.
 *
 * WHITESPACE COLLAPSED AND CUT ON A CHARACTER COUNT, not on a word boundary: a
 * row is one line with an ellipsis at the end of it either way, and hunting for
 * the last space before the limit would make the cut depend on how long the
 * words happen to be. The source string's own markup rides along, because the
 * panel is a list of what the book SAYS and the book says it in the model's
 * spelling.
 */
function opening(text: string, many = 64): string {
  const said = text.replace(/\s+/g, ' ').trim();
  return said.length <= many ? said : `${said.slice(0, many).trimEnd()}…`;
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
