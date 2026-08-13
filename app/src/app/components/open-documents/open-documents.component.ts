import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { TabsService, type Tab } from '../../core/tabs.service';

/**
 * The open documents, down the left — VS Code's explorer, and its gestures.
 *
 * IT REPLACES A CHROME-STYLE STRIP PER PANE. Five columns on a 1920-wide window
 * gave each strip about 370 pixels, and three tabs in one of them were stubs
 * with two letters of a title on each: the one thing a document list has to do
 * is let you tell one book from another, and that strip stopped doing it exactly
 * when a fifth column made it matter. A vertical list does not degrade that way
 * — a row is as wide as the panel however many columns are open — and every pane
 * got its 44px strip back as page.
 *
 * A ROW IS A DOCUMENT, NOT A COLUMN. Clicking one puts it in front of you: in
 * its own column if it is already on screen (only the focus moves), otherwise in
 * the focused column, replacing what was there. Nothing is closed by any of
 * that; the displaced document keeps its unpack, its edits and its place in this
 * list, one click from coming back.
 *
 * ── The indent ───────────────────────────────────────────────────────────────
 *
 * An `editor` row sits UNDER the book it is a face of, which the horizontal
 * strip could never show — there, a book and its HTML were two peers with
 * similar names, in whichever two panes they had landed in. The service's list
 * stays flat (one identity per tab, see TabsService); the nesting is worked out
 * here, where it is a matter of drawing.
 *
 * ── Dragging ─────────────────────────────────────────────────────────────────
 *
 * A row dragged WITHIN this list reorders it — the only place a document's order
 * exists now. A row dragged onto the workspace lands in a column: the middle of
 * a pane shows it there, an edge band opens a new column beside it (the
 * workspace owns that half of the gesture and the arithmetic behind it).
 *
 * Native HTML5 drag and drop, with the same custom MIME the strips used, and the
 * window's own file-drop veil still tells the two apart by looking for `Files`
 * in the payload (see App). `dataTransfer.types` is the only part of a drag
 * readable before the drop, which is what that test is for and why the id itself
 * can only be read when the drop happens.
 */
@Component({
  selector: 'app-open-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
      <header class="head">
        <span class="label">Open</span>
        <span class="count">{{ tabs.tabs().length }}</span>
      </header>

      <!--
        The list itself is the drop target for "put it at the end", the way the
        empty end of a strip was. Its rows handle the insertion points.
      -->
      <div
        class="list"
        [class.landing]="landing()"
        (dragover)="onListOver($event)"
        (dragleave)="onLeave()"
        (drop)="onDrop($event, null)"
      >
        @for (row of rows(); track row.tab.id) {
          <div
            class="row"
            [class.child]="row.indent"
            [class.on]="row.column !== null"
            [class.focused]="row.focused"
            [class.before]="before() === row.tab.id"
            [title]="tooltip(row.tab)"
            draggable="true"
            (click)="pick(row.tab)"
            (auxclick)="onAux($event, row.tab)"
            (dragstart)="onDragStart($event, row.tab)"
            (dragend)="onDragEnd()"
            (dragover)="onRowOver($event, row.tab)"
            (drop)="onDrop($event, row.tab)"
          >
            <span class="kind">{{ glyph(row.tab) }}</span>
            <span class="name">{{ row.tab.title }}</span>
            <!--
              TWO marks, because they are two different things to fix. The dot is
              "this book is not in a folder of yours"; the pencil is "the copy
              that is in one is older than this". A row can wear both.
            -->
            @if (row.tab.unsaved) {
              <span class="dot" title="Not saved anywhere you chose">●</span>
            }
            @if (row.tab.modified) {
              <span class="pencil" title="Edited since it was last saved">✎</span>
            }
            <!--
              WHICH column it is in, and only once there are two. With one column
              open the number is the only number it could be, and a badge that
              always says 1 is a badge that teaches people to stop reading it.
            -->
            @if (row.column !== null && multi()) {
              <span class="column" [title]="'Showing in column ' + row.column">{{ row.column }}</span>
            }
            <button class="x" (click)="close($event, row.tab)" title="Close this document">✕</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 220px;
      min-width: 220px;
      height: 100%;
    }

    /* The rail's own surface and border, so the two read as one left edge with a
       divider in it rather than as two panels of different materials. */
    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
    }

    .head {
      display: flex; align-items: baseline; gap: 8px;
      padding: 12px 12px 8px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .label {
      flex: 1;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
    /* Where a dragged row would land, when it is past the last one. */
    .list.landing { background: var(--accent-faint); }

    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px 6px 10px;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: default;
      user-select: none;
      /* The accent bar lives here, so a row that is not on screen still holds
         the 2px and nothing shifts sideways when it arrives in a column. */
      box-shadow: inset 2px 0 0 0 transparent;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1),
                  box-shadow 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .row:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* An editor is a face of the book above it, not a document beside it. */
    .row.child { padding-left: 26px; }
    .row.child .name { font-style: italic; }

    /*
      ON SCREEN SOMEWHERE, and in the FOCUSED column, are two different facts
      and get two different strengths: the rail, the menu and Ctrl+S all act on
      the focused one, so which it is has to be visible without being loud.
    */
    .row.on { color: var(--text-primary); box-shadow: inset 2px 0 0 0 var(--border-strong); }
    .row.on.focused {
      background: var(--accent-faint);
      box-shadow: inset 2px 0 0 0 var(--accent);
    }

    /*
      The insertion point: a line along the edge the dragged row would land on.
      Spelled out against the on-screen selectors as well, because they set the
      same property at a higher specificity — without this the line would be
      invisible on exactly the rows a person is most likely to be dragging.
    */
    .row.before,
    .row.on.before,
    .row.on.focused.before { box-shadow: inset 0 2px 0 0 var(--accent); }

    .kind { flex: 0 0 auto; opacity: 0.6; font-size: 11px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dot { flex: 0 0 auto; color: var(--accent); font-size: 9px; line-height: 1; }
    .pencil { flex: 0 0 auto; color: var(--warn); font-size: 11px; line-height: 1; }
    .column {
      flex: 0 0 auto;
      min-width: 12px;
      color: var(--text-tertiary);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    /*
      Hidden until the row is under the pointer or the button is keyboard-focused.
      Visibility rather than display, so the row's width does not change when it
      appears and the title does not re-truncate under the mouse.
    */
    .x {
      flex: 0 0 auto;
      visibility: hidden;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 2px 3px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .row:hover .x, .x:focus-visible { visibility: visible; }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
})
export class OpenDocumentsComponent {
  protected readonly tabs = inject(TabsService);
  private readonly router = inject(Router);

  /** The row a drop would land in front of, and whether the end of the list is the target. */
  protected readonly before = signal<string | null>(null);
  protected readonly landing = signal(false);

  protected readonly multi = computed(() => this.tabs.panes().length > 1);

  /**
   * The list as it is drawn: every document, with its editor tucked under it.
   *
   * The column number is the pane's INDEX, which is what Ctrl+1…5 counts and
   * what a person reads off the screen left to right — not the pane's id, which
   * is an implementation detail that survives a reorder.
   */
  protected readonly rows = computed<Row[]>(() => {
    const tabs = this.tabs.tabs();
    const panes = this.tabs.panes();
    const focusedPaneId = this.tabs.focusedPaneId();
    const out: Row[] = [];
    const emit = (tab: Tab, indent: boolean): void => {
      const at = panes.findIndex((pane) => pane.tabId === tab.id);
      out.push({
        tab,
        indent,
        column: at < 0 ? null : at + 1,
        focused: at >= 0 && panes[at]!.id === focusedPaneId,
      });
    };
    for (const tab of tabs) {
      // An editor is emitted under its book below. One whose book has somehow
      // gone is emitted at the top level rather than dropped — a row that
      // exists and is not drawn is a document nobody can close.
      if (tab.kind === 'editor' && tabs.some((other) => other.id === tab.sourceTabId)) continue;
      emit(tab, false);
      for (const other of tabs) {
        if (other.kind === 'editor' && other.sourceTabId === tab.id) emit(other, true);
      }
    }
    return out;
  });

  protected glyph(tab: Tab): string {
    if (tab.kind === 'editor') return '</>';
    return tab.kind === 'epub' ? '▤' : '▦';
  }

  /**
   * A document is not a route. The router still owns Settings, so clicking a row
   * from the settings screen navigates back to the workspace first — the
   * document is what a row means, and it cannot be shown on a page that is not
   * showing documents.
   */
  protected pick(tab: Tab): void {
    void this.router.navigateByUrl('/');
    this.tabs.reveal(tab.id);
  }

  protected close(event: MouseEvent, tab: Tab): void {
    // Without this the click also lands on the row and reveals what is about to
    // be closed, which flashes the document on screen for one frame.
    event.stopPropagation();
    void this.tabs.close(tab.id);
  }

  /** Middle-click. `auxclick` and not `mousedown`, so a middle-drag scroll is not a close. */
  protected onAux(event: MouseEvent, tab: Tab): void {
    if (event.button !== 1) return;
    event.preventDefault();
    void this.tabs.close(tab.id);
  }

  // ── Dragging a row ───────────────────────────────────────────────────────

  protected onDragStart(event: DragEvent, tab: Tab): void {
    // The id travels in a type of our own. Nothing else in the app reads it,
    // and the window-wide file drop looks for `Files` — so the two kinds of
    // drag over this window can never be confused for one another.
    event.dataTransfer?.setData(DOCUMENT_MIME, tab.id);
    // `text/plain` as well, because a drag with no standard type is refused
    // outright by some platforms before a drop can happen at all.
    event.dataTransfer?.setData('text/plain', tab.title);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    // The workspace shields its panes while this is on: a rendered chapter is an
    // <iframe>, and a drag over one is delivered to the frame rather than to the
    // pane the user is aiming at. See TabsService.draggingDocument.
    this.tabs.draggingDocument.set(true);
  }

  protected onDragEnd(): void {
    this.before.set(null);
    this.landing.set(false);
    this.tabs.draggingDocument.set(false);
  }

  /**
   * Over a row: the drop lands before it or after it, by which half the pointer
   * is in — the rule every list of this shape uses, and the only one that lets a
   * row be put at the very end of a list that fills the panel.
   */
  protected onRowOver(event: DragEvent, tab: Tab): void {
    if (!this.carriesDocument(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const target = this.landingFor(event, tab);
    this.before.set(target);
    this.landing.set(target === null);
  }

  protected onListOver(event: DragEvent): void {
    if (!this.carriesDocument(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.before.set(null);
    this.landing.set(true);
  }

  protected onLeave(): void {
    this.before.set(null);
    this.landing.set(false);
  }

  /**
   * A drop inside the list is a reorder.
   *
   * AN EDITOR CANNOT BE REORDERED, and the refusal is said rather than swallowed:
   * its row is drawn under the book it belongs to whatever the flat list says, so
   * moving it would change a number nobody can see and leave the row exactly
   * where it was — a gesture that appears to work and does not.
   */
  protected onDrop(event: DragEvent, row: Tab | null): void {
    const id = event.dataTransfer?.getData(DOCUMENT_MIME);
    // Where it lands was worked out on the way in, and is READ BEFORE the drag
    // state is cleared — clearing first would drop every row at the end of the
    // list and quietly undo the insertion point the user was just shown.
    const target = this.before() ?? (row === null ? null : this.landingFor(event, row));
    this.onDragEnd();
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const moving = this.tabs.byId(id);
    if (moving === null) return;
    if (moving.kind === 'editor') {
      this.tabs.notice.set('An HTML editor sits with the book it belongs to — drag the book instead.');
      return;
    }
    // No navigation: a reorder is bookkeeping about the list, not a request to
    // look at something, so it leaves a person on Settings where they were.
    this.tabs.reorder(id, this.anchor(target));
  }

  /**
   * The tab a drop before `target` really lands in front of.
   *
   * An editor row is drawn under its book, so "before this editor" means before
   * the GROUP — the book itself. Without this, dropping a document onto the top
   * half of an editor row would put it between a book and its own HTML in the
   * flat list, where the grouping would immediately draw it somewhere else.
   */
  private anchor(target: string | null): string | null {
    const tab = target === null ? null : this.tabs.byId(target);
    if (tab === null) return null;
    return tab.kind === 'editor' ? tab.sourceTabId : tab.id;
  }

  private landingFor(event: DragEvent, tab: Tab): string | null {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (event.clientY <= box.top + box.height / 2) return tab.id;
    const list = this.rows();
    const at = list.findIndex((row) => row.tab.id === tab.id);
    return list[at + 1]?.tab.id ?? null;
  }

  /**
   * Whether this drag is one of ours.
   *
   * `types` is readable during a drag; the DATA is not, by design, which is why
   * the id can only be read on drop. A file drag has `Files` here and is left
   * alone for the window's own handler to open.
   */
  private carriesDocument(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes(DOCUMENT_MIME) === true;
  }

  /**
   * What the row says when you rest on it — the whole of what a document's
   * flags mean, in the one place there is room to spell it out.
   */
  protected tooltip(tab: Tab): string {
    if (tab.kind === 'editor') {
      return `The HTML of the chapter open in ${tab.title.replace(/ — HTML$/, '')}`;
    }
    const lines = [tab.path];
    if (tab.savedPath !== null) lines.push(`Saved to ${tab.savedPath}`);
    if (tab.unsaved) lines.push("In Foundry's library workspace only — Ctrl+S files it somewhere.");
    if (tab.modified) lines.push('Edited since that copy was written — Ctrl+S brings it up to date.');
    return lines.join('\n');
  }
}

/** One drawn line of the list: the document, its indent, and where it is showing. */
interface Row {
  tab: Tab;
  /** True for an editor drawn under its book. */
  indent: boolean;
  /** 1…5 while it is on screen, counted left to right. Null when it is not. */
  column: number | null;
  /** True when that column is the focused one. */
  focused: boolean;
}

/**
 * Ours, so a document drag and a file drag can never be mistaken for each other.
 *
 * The same type the tab strips used, kept deliberately: the workspace reads it
 * on the other end of the same gesture, and App's file-drop veil is written
 * against the fact that our drags do not carry `Files`.
 */
export const DOCUMENT_MIME = 'application/x-foundry-tab';
