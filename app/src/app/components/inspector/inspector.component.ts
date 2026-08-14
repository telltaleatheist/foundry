import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { BLOCK_CATEGORIES, UNKNOWN_CATEGORY_COLOUR } from '@shared/categories';
import type { EpubChapter } from '@shared/types';

import { TabsService } from '../../core/tabs.service';

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
    @if (book(); as current) {
      <div class="panel">
        <!-- ── Contents ─────────────────────────────────────────────────── -->
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
                @if (!current.selectMode) {
                  Turn on Select to colour the blocks and relabel them.
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
                      [disabled]="!current.selectMode"
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
                      [disabled]="!current.selectMode || row.total === null || row.total === 0"
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
  `],
})
export class InspectorComponent {
  protected readonly tabs = inject(TabsService);

  protected readonly fallback = UNKNOWN_CATEGORY_COLOUR;

  /**
   * Both sections start OPEN, which is what Owen asked for and what an inspector
   * is for: a panel whose sections you have to open before it says anything is a
   * panel that says nothing. They are still collapsible, because sixty chapters
   * and eleven categories do not both fit on a laptop.
   */
  protected readonly contentsOpen = signal(true);
  protected readonly categoryOpen = signal(true);

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

  protected readonly selected = computed(() =>
    this.tabs.selectionFor(this.book()?.id ?? null));

  private readonly tally = computed(() => this.tabs.countsFor(this.book()?.id ?? null));

  /**
   * The eleven rows, with this chapter's numbers when the frame has sent any.
   *
   * `total` is NULL rather than 0 while the mode is off, and the difference is
   * worth the extra state: the frame only counts while select mode is on, so a
   * zero would be the panel asserting "this chapter has no footnotes" when what
   * it means is "nobody has counted". A category with a real zero is drawn as a
   * zero and its strike button is dead, which is honest.
   */
  protected readonly rows = computed<CategoryRow[]>(() => {
    const counted = this.tally();
    return BLOCK_CATEGORIES.map((one) => ({
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
    return Object.entries(counted.counts)
      .filter(([id, total]) => total > 0 && !BLOCK_CATEGORIES.some((one) => one.id === id))
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

  protected relabel(category: string): void {
    this.tabs.relabelSelected(category);
  }

  protected strike(category: string): void {
    this.tabs.strikeCategory(category);
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
