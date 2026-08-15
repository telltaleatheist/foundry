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
import type { EpubChapter, LedgerStep, StepRow } from '@shared/types';

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

        <!-- ── Steps ────────────────────────────────────────────────────── -->
        <!--
          THE RUNNING ORDER IS FIXED AND THIS IS THE TOP OF IT: Steps, then the
          book's divisions (Contents for a cast book, Chapters for a scan — one
          question asked of two kinds of document, so they share the one slot and
          the slot does not move), then Category, then anything about a single
          block. Sections that have nothing to say are still absent; what is fixed
          is that a section never overtakes another one.

          THE PANEL IS FURNITURE AND FURNITURE DOES NOT WALK. Almost everything
          here is conditional, and when the order was "whatever the guards happen
          to admit" the same section sat in a different place depending on what
          was focused and whether a block was picked — so every glance began by
          re-finding it. Steps is first because it is the section somebody reaches
          for most while moving through their history, and because it is the one
          that belongs to the PROJECT rather than to whatever pane is in front:
          it is the most nearly always-present thing in the panel, which is what
          makes it the only honest anchor. Keep new sections BELOW these three.
        -->
        <!--
          A LIST AND NOT A TREE, deliberately, and the whole design turns on it.
          The steps form a parent chain — every one records which step it was made
          FROM — but nobody wants to reason about a graph of their book; they want
          to see what they have done and click back to any of it. So the rows are
          in the order main sends them, which is creation order, and the ONE
          concession to the tree is the quiet "from Read" that main puts on a row
          whose parent is not the row above it. No rails, no indentation, no depth.

          NOTHING HERE IS RE-DERIVED. The order and the annotation both arrive
          composed (\`chronological\`, shared/ledger.ts) precisely so this template
          cannot become a second implementation of the one rule that decides
          whether a flat list is misleading about what was made from what.
        -->
        @if (projectDir(); as dir) {
          <section class="accordion" [class.shut]="!stepsOpen()">
            <button class="head" (click)="stepsOpen.set(!stepsOpen())">
              <span class="twist">{{ stepsOpen() ? '▾' : '▸' }}</span>
              <span class="label">Steps</span>
              <span class="count">{{ stepRows().length }}</span>
            </button>
            @if (stepsOpen()) {
              <div class="body">
                @if (stepsProblem(); as reason) {
                  <!-- Main's own sentence about a catalogue it would not read,
                       drawn where the rows would have been. A section that went
                       silently empty would be indistinguishable from a book
                       nothing has happened to. -->
                  <p class="hint">{{ reason }}</p>
                } @else {
                  <p class="hint">
                    Everything that has been done to this book. Click any step to stand there —
                    it costs nothing, and nothing after it is thrown away.
                  </p>
                }

                <ul>
                  @for (row of stepRows(); track row.step.id) {
                    <li
                      class="step"
                      [class.current]="row.step.id === standingId()"
                      [class.stale]="row.step.stale === true"
                    >
                      <button class="pick step-pick" [title]="rowTitle(row)" (click)="stand(row)">
                        <span class="dot"></span>
                        <span class="what">
                          <span class="name">{{ row.step.label }}</span>
                          @if (row.from) {
                            <!-- The entire concession to the tree. Only on the rows
                                 where the flat list would otherwise be misleading. -->
                            <span class="from">from {{ row.from }}</span>
                          }
                        </span>
                        <span class="tally">{{ when(row.step) }}</span>
                      </button>
                      <!--
                        NO ✕ ON THE ORIGIN. Deleting the import is deleting the
                        project — everything else in the folder was made from it —
                        and the project's own ✕ does that with its own ceremony and
                        its own accounting of what it costs. Main refuses it by
                        name as well; this is so nobody is offered the button.
                      -->
                      @if (row.step.parent !== null) {
                        <button
                          class="strike"
                          title="Delete this step, and everything made from it"
                          (click)="discard(dir, row)"
                        >✕</button>
                      }
                    </li>
                  }
                  @if (stepRows().length === 0 && stepsProblem() === null) {
                    <!-- Two states that look alike and are not: a book whose
                         history has not arrived yet, and one that genuinely has
                         none. Saying "nothing has happened to this book" while
                         the answer is still in flight would be the panel
                         asserting something it has not been told. -->
                    <li class="none">
                      {{ stepsRead() ? 'Nothing has been recorded for this book yet.' : 'Reading this book’s history…' }}
                    </li>
                  }
                </ul>

                <!--
                  SAVE IS OFFERED WHERE THE STEP WILL APPEAR, which is most of what
                  teaches what it does: press it and the row shows up two lines
                  below. It is NOT disabled when there is nothing to freeze — main
                  refuses that with a sentence saying what to correct first, and a
                  dead button teaches nobody why it is dead.
                -->
                @if (canSave()) {
                  <div class="acts">
                    <button
                      class="act"
                      title="Keep a copy of these corrections that nothing later can change"
                      (click)="saveCorrections()"
                    >Save corrections</button>
                  </div>
                }
              </div>
            }
          </section>
        }

        <!--
          EVERYTHING THIS PANEL SAYS ABOUT THE DOCUMENT, which needs one. The
          sections below are about a book that is open and readable or a scan
          being corrected; Steps, above, is about the PROJECT, and a scan that has
          never been in block view has one of those and none of these. Which is
          the whole reason Steps sits outside this block rather than inside it —
          it must hold the top of the panel in states where nothing down here
          draws at all. The block closes at the brace marked "end of the
          document's sections", which is the last thing in the panel.
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

        <!-- ── The one selected block, for a scan ───────────────────────── -->
        @if (panel.kind === 'pdf' && onlyBlock() !== null) {
          <section class="accordion" [class.shut]="!blockOpen()">
            <button class="head" (click)="blockOpen.set(!blockOpen())">
              <span class="twist">{{ blockOpen() ? '▾' : '▸' }}</span>
              <span class="label">Block</span>
              <span class="count">{{ onlyBlock()?.key }}</span>
            </button>
            @if (blockOpen()) {
              <div class="body">
                @if (onlyBlock(); as block) {
                  <!--
                    WHAT THE MODEL READ, in a box that can be corrected.
                    An outline says a block is there and its colour says what the
                    model called it; whether it READ the words right is invisible
                    on a photograph of a page until something shows what it
                    thinks they are. That question is the whole reason this
                    section exists.
                  -->
                  <p class="hint">
                    @if (block.parts.length > 1) {
                      The model answered for this region once and Foundry cut the answer into
                      {{ block.parts.length }} pieces, so its words cannot be corrected as one.
                      Everything else here still applies to all of them.
                    } @else {
                      What the model read off the page. Correct it and the correction is what
                      every rendering of this book uses.
                    }
                  </p>
                  <textarea
                    #words
                    class="words"
                    rows="5"
                    spellcheck="false"
                    [disabled]="block.parts.length > 1 || frozen()"
                    [value]="draft()"
                    (input)="draft.set(words.value)"
                    [attr.aria-label]="'What ' + block.key + ' says'"
                  ></textarea>
                  <div class="acts">
                    <button
                      class="act"
                      [disabled]="block.parts.length > 1 || frozen() || draft().trim() === reading()"
                      (click)="applyWords()"
                    >Apply</button>
                    <button
                      class="act"
                      [disabled]="!corrected() || frozen()"
                      title="Put the model's own reading back"
                      (click)="revertWords()"
                    >Model's reading</button>
                  </div>
                }
              </div>
            }
          </section>
        }
        } <!-- end of the document's sections -->
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

    .hint {
      margin: 0 0 6px;
      padding: 0 12px;
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

    /* ── Steps ─────────────────────────────────────────────────────────── */

    /*
      THE ONE THING IN THIS PANEL THAT IS NOT A SECTION. It is a state the whole
      column is in — every control under it is dead — so it sits above them all,
      in the warning colour the notice strip uses, and it does not scroll away
      with any one section's rows.
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

    .step { display: flex; align-items: center; }
    /*
      THE POSITION ROW IS VISIBLY CURRENT, in the same accent and the same faint
      wash the Category section marks its current row with. One word for "this is
      the one you are on" across the whole panel; inventing a second is how a
      palette stops meaning anything.
    */
    .step.current { background: var(--accent-faint); }

    .step-pick { align-items: flex-start; gap: 7px; padding: 6px 8px; }
    .dot {
      flex: 0 0 auto;
      width: 7px; height: 7px; margin-top: 4px;
      border-radius: 50%;
      box-shadow: inset 0 0 0 1px var(--border-strong);
    }
    .step.current .dot { background: var(--accent); box-shadow: none; }

    .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .step.current .name { color: var(--accent); font-weight: 500; }
    /*
      The quiet "from Read", and quiet is the specification. It is the only
      admission this list makes that the steps are a tree, and it appears on the
      one row in a hundred where somebody stepped back and acted from an earlier
      state — a project worked straight through carries none at all.
    */
    .from { font-size: 10px; font-style: italic; color: var(--text-tertiary); }

    /*
      A STALE STEP IS DIMMED AND STILL CLICKABLE, which was the ruling. Its
      payload is a true record of what was made — a translation of a bank that has
      since been re-read still holds the blocks it translated — so it opens, it
      renders, and only its currency is in question. The reason is on hover, where
      an explanation nobody needs stays out of the way of a list.
    */
    .step.stale .name { opacity: 0.55; }
    .step.stale .tally { opacity: 0.55; }
    .step.stale .dot { opacity: 0.4; }
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
  protected readonly stepsOpen = signal(true);

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

  // ── Steps ────────────────────────────────────────────────────────────────

  /**
   * The project the focused document belongs to, or null for a file opened from
   * somewhere this app has never imported.
   *
   * THE SECTION IS ABOUT THE PROJECT AND NOT ABOUT THE TAB, which is why this is a
   * separate question from `subject()`. A book's history is the same history
   * whether you are looking at the scan, at the EPUB that was cast from it or at
   * one of its translations — they are all one project — and a Steps section that
   * came and went with the mode a pane happens to be in would be a history that
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

  /**
   * The rows, exactly as main composed them.
   *
   * NEVER SORTED AND NEVER ANNOTATED HERE. The order is creation order and the
   * "from …" is set only where a row's parent is not the row above it; both
   * decisions are made once, in `chronological`, and a template that made them
   * again would be a second opinion about the shape of somebody's history.
   */
  protected readonly stepRows = computed<readonly StepRow[]>(() =>
    this.ledger.historyFor(this.projectDir())?.rows ?? []);

  /** Main's sentence for a ledger it would not read, drawn instead of rows. */
  protected readonly stepsProblem = computed<string | null>(() =>
    this.ledger.problemFor(this.projectDir()));

  /** The step the pointer stands on — the row drawn as current. */
  protected readonly standingId = computed<string | null>(() =>
    this.ledger.standingIn(this.projectDir())?.id ?? null);

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
   * Save is offered over a SCAN BEING CORRECTED and nowhere else.
   *
   * What it freezes is the block editor's curation, so a pane that is not in that
   * mode has nothing to freeze — and it is not offered while standing on a save
   * either, because correcting is off there and a Save that kept a copy of
   * corrections nobody was allowed to make would be a button with nothing behind
   * it. The way back is named in the banner above it.
   */
  protected canSave(): boolean {
    const panel = this.subject();
    return panel !== null && panel.kind === 'pdf' && panel.live && !this.frozen();
  }

  /**
   * WHEN, in as few characters as a row can spare.
   *
   * The year is dropped for anything from this one, which is nearly every row
   * anybody looks at, and kept for the rest — a project imported two years ago and
   * read last week is a real thing, and two rows both reading "14 Aug" would be
   * this panel quietly claiming they happened together.
   */
  protected when(step: LedgerStep): string {
    const at = new Date(step.createdAt);
    const sameYear = at.getFullYear() === new Date().getFullYear();
    return at.toLocaleDateString(undefined, sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /**
   * What a row says on hover — including the STALE REASON, which is the whole of
   * why a dimmed row is dimmed.
   *
   * A step goes stale when something it was made from was replaced under it: the
   * blocks a curation named by `(page, order)` mean different blocks after a
   * re-read, and a translation of those blocks was a translation of paragraphs
   * that have moved. It is a display state and not a deletion — the payload is
   * still a true record of what was made, so the row still opens and still
   * renders. Saying that on hover is what keeps a dimmed row from reading as a
   * broken one.
   */
  protected rowTitle(row: StepRow): string {
    const full = new Date(row.step.createdAt).toLocaleString();
    if (row.step.stale === true) {
      return `${row.step.label} — ${full}. What this was made from has been replaced since, so it `
        + 'describes an earlier pass over the pages. It still opens, exactly as it was recorded.';
    }
    if (row.step.id === this.standingId()) {
      return `${row.step.label} — ${full}. You are standing here: this is what the panes show and `
        + 'what the next thing you do is made from.';
    }
    return `${row.step.label} — ${full}. Click to stand here. Nothing after it is thrown away.`;
  }

  /**
   * Clicking a row. FREE, INSTANT AND UNCONFIRMED — one line of the manifest, no
   * job, no rendering, no question asked. That is the promise every history panel
   * makes by looking like one.
   *
   * The row already being current is not a no-op worth guarding: main answers with
   * the same ledger and the panel repaints to the same thing, and a click that did
   * nothing is cheaper than a branch that has to be kept true.
   */
  protected async stand(row: StepRow): Promise<void> {
    const dir = this.projectDir();
    if (dir === null) return;
    try {
      await this.ledger.go(dir, row.step.id);
    } catch (err) {
      // Main's words. It refuses an id this project does not hold, which means the
      // two sides are looking at different ledgers — not something to smooth over.
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The ✕. Main says what it costs, the app's own card asks, main does it.
   *
   * Never offered on the origin (the template does not draw the button) and
   * refused by name there anyway. A cancel is silence; a refusal is main's
   * sentence, as written.
   */
  protected async discard(dir: string, row: StepRow): Promise<void> {
    try {
      /*
       * THE BOOKS THIS IS ABOUT TO ERASE ARE CLOSED FIRST, between the confirm and
       * the delete — the document delete's shape and its reason. Main refuses to
       * unlink a working tree this window is still reading (it cannot be done on
       * Windows and would leave half an unpacked book behind), so without this,
       * deleting a translation whose EPUB is open would meet a refusal one line
       * after the user said yes. Main cannot do it: tabs are the renderer's.
       *
       * WITHOUT ASKING, and returned rather than voided so the delete waits for
       * this window to let go: the delete's own card is the question and it has
       * already been answered yes.
       */
      await this.ledger.remove(dir, row.step.id, (files) => this.tabs.closeShowing(files));
    } catch (err) {
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Freeze the corrections as a step. The refusal for an empty one is main's. */
  protected saveCorrections(): void {
    const panel = this.subject();
    if (panel !== null && panel.kind === 'pdf') void this.tabs.saveCorrections(panel.id);
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
